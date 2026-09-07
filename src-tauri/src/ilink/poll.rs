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
        let outcome = tokio::select! {
            r = proto::post_json(
                &base,
                "/ilink/bot/getupdates",
                &[],
                body,
                Some(&session.token),
                POLL_TIMEOUT,
            ) => r,
            _ = st.poke.notified() => continue, // epoch 换代 → 顶部检查退出
        };

        match outcome {
            Ok(v) => {
                let updates: UpdatesResponse =
                    serde_json::from_value(v).unwrap_or_default();

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
                // 长轮询超时 = 正常控制流，立即续下一轮。
            }
            Err(ApiError::HttpStatus(401, _)) | Err(ApiError::HttpStatus(403, _)) => {
                // 会话失效 → 必须停循环进重扫，绝不静默当成功【§7.3】。
                expire_session(&app, &st, "auth_failed").await;
                return;
            }
            Err(_) => {
                // 其它网络错误：2s → 30s 退避。
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
