// ============================================================
// ilink/poll.rs — getupdates 长轮询循环 + 入站消息分发
//
// 铁律（wechat-ilink-report.md §7.3）：
//  1. 同一 token 同刻只有一个在途 getupdates（本循环天然串行）。
//  2. get_updates_buf 游标每轮持久化、原样回传。
//  3. 服务端 hold ≤35s；客户端 38s 超时是正常控制流（继续轮询）。
//  4. epoch 换代（logout/重登/过期）立即作废在途循环。
//  5. 401/403/-14 → 停循环进"重新扫码"状态（不静默吞错）。
// ============================================================

use crate::ilink::proto::{
    self, ApiError, UpdatesResponse, WechatSession, BOT_AGENT, CHANNEL_VERSION, POLL_TIMEOUT,
};
use crate::ilink::store;
use crate::ilink::{
    data_dir, expire_session, now_ms, quota_reset, InboundEvent, IlinkState, INBOUND_LOG_CAP,
};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::time::{sleep, Duration};

/// 启动一个 getupdates 长轮询循环（epoch 由调用方换代后传入）。
pub fn spawn_poll(app: AppHandle, st: Arc<IlinkState>, epoch: u64) {
    tauri::async_runtime::spawn(poll_loop(app, st, epoch));
}

async fn poll_loop(app: AppHandle, st: Arc<IlinkState>, epoch: u64) {
    let dir = data_dir(&app).await;
    let mut backoff_ms: u64 = 0;

    loop {
        if crate::ilink::current_epoch(&st).await != epoch {
            return;
        }

        // 第 151 轮（O-27）：每轮都记账，让"到底有没有在轮询"变成可读数字
        {
            let mut g = st.inner.lock().await;
            g.polls += 1;
            g.last_poll_at = Some(now_ms() as u64);
        }

        // ---- 会话快照（不持锁跨 await）----
        let session: WechatSession = {
            let g = st.inner.lock().await;
            match &g.session {
                Some(s) => s.clone(),
                None => return, // 无会话：循环无意义
            }
        };

        // 本地 23h 判活（服务端 24h 到期前留缓冲）【§7.1】
        if !session.is_fresh(now_ms()) {
            expire_session(&app, &st, "session_expired").await;
            return;
        }

        let body = serde_json::json!({
            "get_updates_buf": session.cursor,
            "base_info": {
                "channel_version": CHANNEL_VERSION,
                "bot_agent": BOT_AGENT,
            }
        });
        let base = session.effective_base();
        {
            let p = { st.inner.lock().await.polls };
            if p <= 5 {
                crate::runtime_log::append_line(
                    "INFO",
                    &format!(
                        "[ilink] poll#{} 发起 getupdates（base={} cursor 前 16 位={}）",
                        p,
                        base,
                        session.cursor.chars().take(16).collect::<String>()
                    ),
                );
            }
        }
        /*
         * 第 152 轮（O-27）：**去掉 poke 分支**。
         * 原来这里是 tokio::select!{ 请求 , poke → continue }：poke 一到就 continue，
         * **请求会被整轮跳过**；而 1.5 次/秒的空转速率正好等于循环末尾的 sleep(500ms)。
         * 换代（logout/重登）由循环顶部检查 epoch 处理，长轮询自身有 38 秒超时，不会卡死。
         */
        let outcome = proto::post_json(
            &base,
            "/ilink/bot/getupdates",
            &[],
            body,
            Some(&session.token),
            POLL_TIMEOUT,
        )
        .await;

        match outcome {
            Ok(v) => {
                {
                    let p = { st.inner.lock().await.polls };
                    if p <= 5 {
                        let raw = serde_json::to_string(&v).unwrap_or_default();
                        crate::runtime_log::append_line(
                            "INFO",
                            &format!("[ilink] poll#{} 原始响应: {}", p, raw.chars().take(300).collect::<String>()),
                        );
                    }
                }
                let updates: UpdatesResponse =
                    match serde_json::from_value(v.clone()) {
                    Ok(u) => u,
                    Err(e) => {
                        {
                            let mut g = st.inner.lock().await;
                            g.last_poll_error = Some(format!("响应解析失败: {}", e));
                        }
                        crate::runtime_log::append_line("WARN", &format!("[ilink] 响应解析失败（消息会被静默丢掉）: {}", e));
                        UpdatesResponse::default()
                    }
                };

                // ret 非 0 或 errcode -14 → 会话异常
                let ret = updates.ret;
                let errcode = updates.errcode;
                if errcode == Some(-14) {
                    expire_session(&app, &st, "session_timeout(-14)").await;
                    return;
                }
                if ret.is_some() && ret != Some(0) {
                    // ret != 0：退避重试，不轻易丢会话（仅 -14/401/403 视为失效）。
                    if let Some(errmsg) = &updates.errmsg {
                        if !errmsg.is_empty() {
                            let mut g = st.inner.lock().await;
                            g.last_error = Some(format!("getupdates ret={:?}: {}", ret, errmsg));
                        }
                    }
                    backoff_ms = next_backoff(&mut backoff_ms);
                    sleep(Duration::from_millis(backoff_ms)).await;
                    continue;
                }

                // ---- 游标持久化（有变化才写盘）----
                if let Some(buf) = &updates.get_updates_buf {
                    let changed = {
                        let mut g = st.inner.lock().await;
                        let changed = g.session.as_ref().map(|s| s.cursor != *buf).unwrap_or(false);
                        if changed {
                            if let Some(s) = &mut g.session {
                                s.cursor = buf.clone();
                            }
                        }
                        changed
                    };
                    if changed {
                        let snapshot = st.inner.lock().await.session.clone();
                        if let Some(s) = snapshot {
                            let _ = store::save_session(&dir, &s);
                        }
                    }
                }

                // ---- 逐条分发 ----
                let n_msgs = updates.msgs.as_ref().map(|m| m.len()).unwrap_or(0);
                {
                    let p = { st.inner.lock().await.polls };
                    if n_msgs == 0 && p <= 20 {
                        crate::runtime_log::append_line("INFO", &format!("[ilink] poll#{} 响应里 0 条消息", p));
                    }
                }
                {
                    let mut g = st.inner.lock().await;
                    g.last_poll_error = None;
                    g.last_poll_msgs = n_msgs as u64;
                }
                if n_msgs > 0 {
                    crate::runtime_log::append_line(
                        "INFO",
                        &format!("[ilink] 取到 {} 条入站消息（polls={}）", n_msgs, { st.inner.lock().await.polls }),
                    );
                }
                if let Some(msgs) = &updates.msgs {
                    for m in msgs {
                        dispatch_inbound(&app, &st, m).await;
                    }
                }

                backoff_ms = 0;
                // 每轮之间兜底 sleep 500ms 防忙转【社区】。
                sleep(Duration::from_millis(500)).await;
            }
            Err(ApiError::Timeout) => {
                // 长轮询超时 = 正常控制流，立即续下一轮（但也要留痕，否则"没在轮询"看不出来）
                let mut g = st.inner.lock().await;
                g.last_poll_error = Some("timeout(38s 长轮询超时，属正常)".into());
            }
            Err(ApiError::HttpStatus(401, _)) | Err(ApiError::HttpStatus(403, _)) => {
                // 会话失效 → 必须停循环进重扫，绝不静默当成功【§7.3】。
                expire_session(&app, &st, "auth_failed").await;
                return;
            }
            Err(e) => {
                // 其它网络错误：2s → 30s 退避。第 151 轮：必须留痕（此前完全静默）
                {
                    let mut g = st.inner.lock().await;
                    g.last_poll_error = Some(format!("轮询失败: {}", e));
                }
                crate::runtime_log::append_line("WARN", &format!("[ilink] 轮询失败（退避重试）: {}", e));
                backoff_ms = next_backoff(&mut backoff_ms);
                sleep(Duration::from_millis(backoff_ms)).await;
            }
        }
    }
}

fn next_backoff(current: &mut u64) -> u64 {
    if *current == 0 {
        *current = 2000;
    } else {
        *current = (*current * 2).min(30_000);
    }
    *current
}

/// 入站分发：只处理私聊文本（message_type==1、无 group_id、from 是 @im.wechat）。
/// 维护每 peer context_token + 配额重置 + 事件上抛。
async fn dispatch_inbound(app: &AppHandle, st: &Arc<IlinkState>, msg: &proto::WeixinMessage) {
    // 自身回声（message_type==2）忽略，防自回复死循环【§6.1】。
    if msg.message_type == Some(2) {
        return;
    }
    // 群聊：官方未声明支持；MVP 记录后忽略【诚实标注 §6.3】。
    if let Some(gid) = &msg.group_id {
        if !gid.is_empty() {
            return;
        }
    }
    let peer = match &msg.from_user_id {
        Some(p) if p.contains("@") => p.clone(),
        _ => return,
    };
    let text = proto::extract_text(msg);
    let now = now_ms();
    let context_token = msg.context_token.clone();
    let message_id = msg.message_id.clone().unwrap_or_default();
    let create_time_ms = msg.create_time_ms;

    {
        let mut g = st.inner.lock().await;
        if let Some(t) = &context_token {
            g.contexts.insert(peer.clone(), t.clone());
        }
        // 收到该 peer 新消息 → 配额窗口重置（24h 内 10 条预算）【§7.2】。
        quota_reset(g.quota.entry(peer.clone()).or_default(), now);
        g.inbound_count += 1;
        g.last_inbound_at = Some(now);
        if !text.trim().is_empty() {
            g.inbound_log.push_back(InboundEvent {
                peer: peer.clone(),
                text: text.clone(),
                message_id: message_id.clone(),
                create_time_ms,
            });
            if g.inbound_log.len() > INBOUND_LOG_CAP {
                g.inbound_log.pop_front();
            }
        }
    }

    // 纯文本才上抛（媒体消息只更新 token/配额，MVP 不回应用户）。
    if text.trim().is_empty() {
        return;
    }
    let _ = app.emit(
        "ilink-inbound",
        InboundEvent {
            peer: peer.clone(),
            text: text.clone(),
            message_id,
            create_time_ms,
        },
    );
}
