// ============================================================
// ilink/login.rs — QR 扫码登录状态机（官方 8 态 + 配对码）
//
// 流程：get_bot_qrcode(POST, bot_type=3, local_token_list)
//     → get_qrcode_status(GET 长轮询 ≤35s)
//     → confirmed → 组装 WechatSession 落盘 → 转 getupdates 循环
//
// 工程要点（对照 wechat-ilink-report.md §2.5/§8.3）：
//  - 同一登录尝试只有一个轮询循环；poke Notify 让配对码即时生效，
//    不重启循环（避免并发 QR 轮询踩踏）。
//  - QR 过期/配对码封禁自动刷新 ≤MAX_QR_REFRESH 次；总超时 480s。
// ============================================================

use crate::ilink::poll;
use crate::ilink::proto::{self, WechatSession, DEFAULT_BASE_URL, MAX_QR_REFRESH, QR_TIMEOUT};
use crate::ilink::store;
use crate::ilink::{data_dir, now_ms, LinkState, LOGIN_TOTAL_TIMEOUT_MS};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::time::{sleep, timeout as tokio_timeout};

use super::IlinkState;

/// 拉取新二维码（首次或过期/封禁后刷新）。返回 Ok(()) 表示拿到了 qrcode。
/// epoch 校验：网络期间换代（logout/start_login）后不得再写状态/emit。
async fn fetch_qr(
    app: &AppHandle,
    st: &Arc<IlinkState>,
    epoch: u64,
    qrcode: &mut Option<String>,
    base: &mut String,
    tokens: &[String],
) -> Result<(), ()> {
    {
        let mut g = st.inner.lock().await;
        g.state = LinkState::WaitingQr;
        g.qrcode = None;
        g.qrcode_url = None;
        g.pending_verify = None;
        g.last_error = None;
    }
    let _ = super::emit_state(app, st).await;

    let body = serde_json::json!({ "local_token_list": tokens });
    let result = tokio_timeout(
        std::time::Duration::from_secs(25),
        proto::post_json(
            base,
            "/ilink/bot/get_bot_qrcode",
            &[("bot_type", "3")],
            body,
            None,
            QR_TIMEOUT,
        ),
    )
    .await;

    // 网络请求结束：若 epoch 已换代，直接放弃（不写状态/不 emit）。
    if super::current_epoch(st).await != epoch {
        return Err(());
    }

    match result {
        Ok(Ok(v)) => {
            let code = v
                .get("qrcode")
                .and_then(|c| c.as_str())
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string());
            let url = v
                .get("qrcode_img_content")
                .and_then(|c| c.as_str())
                .unwrap_or("")
                .to_string();
            match code {
                Some(c) => {
                    *qrcode = Some(c.clone());
                    {
                        let mut g = st.inner.lock().await;
                        g.qrcode = Some(c);
                        g.qrcode_url = Some(url.clone());
                        g.state = LinkState::WaitingScan;
                        g.last_error = None;
                    }
                    let _ = app.emit("ilink-qr", serde_json::json!({ "qrcode_url": url }));
                    let _ = super::emit_state(app, st).await;
                    Ok(())
                }
                None => {
                    let mut g = st.inner.lock().await;
                    g.last_error = Some("get_bot_qrcode 响应缺 qrcode 字段".into());
                    Err(())
                }
            }
        }
        _ => {
            let mut g = st.inner.lock().await;
            g.last_error = Some("get_bot_qrcode 请求失败，将重试".into());
            Err(())
        }
    }
}

/// 登录主循环。epoch 变化即应退出（start_login/logout/confirmed 换代）。
pub async fn login_loop(app: AppHandle, st: Arc<IlinkState>, epoch: u64) {
    let dir = data_dir(&app).await;
    let mut base: String = DEFAULT_BASE_URL.to_string();
    let mut qrcode: Option<String> = None;
    let mut fetch_count: u32 = 0;
    let mut need_verify_emitted = false;
    let started_at = now_ms();

    loop {
        if super::current_epoch(&st).await != epoch {
            return;
        }
        if now_ms() - started_at > LOGIN_TOTAL_TIMEOUT_MS {
            super::give_up(&app, &st, "登录等待超时（8 分钟），请重新扫码").await;
            return;
        }

        // ---- 确保有二维码 ----
        if qrcode.is_none() {
            if fetch_count >= MAX_QR_REFRESH + 1 {
                super::give_up(&app, &st, "二维码刷新次数用尽，请重试").await;
                return;
            }
            fetch_count += 1;
            let tokens = store::load_tokens(&dir);
            if fetch_qr(&app, &st, epoch, &mut qrcode, &mut base, &tokens)
                .await
                .is_err()
            {
                if super::current_epoch(&st).await != epoch {
                    return; // 换代后不再重试
                }
                sleep(std::time::Duration::from_millis(1500)).await;
                continue; // 网络失败重试（仍计 fetch_count，防无限重试）
            }
            need_verify_emitted = false;
            if super::current_epoch(&st).await != epoch {
                return;
            }
        }
        let code = qrcode.clone().expect("qrcode just ensured");

        // ---- 取配对码（用户在手机看到数字码后经 submit_verify 提交）----
        let verify: Option<String> = {
            let mut g = st.inner.lock().await;
            g.pending_verify.take()
        };

        // ---- 长轮询扫码状态（poke 唤醒 = 有新配对码 / epoch 换代）----
        let params: Vec<(&str, &str)> = match &verify {
            Some(v) => vec![("qrcode", &code), ("verify_code", v)],
            None => vec![("qrcode", &code)],
        };
        let outcome = tokio::select! {
            r = proto::get_json(&base, "/ilink/bot/get_qrcode_status", &params, None, QR_TIMEOUT) => r,
            _ = st.poke.notified() => {
                if super::current_epoch(&st).await != epoch { return; }
                continue; // 配对码已提交，下一轮携带
            }
        };

        let value = match outcome {
            Ok(v) => v,
            Err(proto::ApiError::Timeout) => continue,
            Err(e) => {
                let mut g = st.inner.lock().await;
                g.last_error = Some(format!("扫码轮询错误: {}", e));
                sleep(std::time::Duration::from_secs(2)).await;
                continue;
            }
        };

        let status = value.get("status").and_then(|s| s.as_str()).map(String::from);
        let had_code = verify.is_some();
        let get = |k: &str| value.get(k).and_then(|v| v.as_str()).map(String::from);

        match status.as_deref() {
            Some("wait") | Some("scaned") => {
                {
                    let mut g = st.inner.lock().await;
                    g.state = LinkState::WaitingScan;
                    g.last_error = if status.as_deref() == Some("scaned") {
                        Some("已扫码，请在手机端确认绑定".into())
                    } else {
                        None
                    };
                }
                let _ = super::emit_state(&app, &st).await;
                sleep(std::time::Duration::from_millis(800)).await;
            }
            Some("need_verifycode") => {
                {
                    let mut g = st.inner.lock().await;
                    g.state = LinkState::NeedVerifyCode;
                    // 带过码仍 need_verifycode → 上次码错（或需新码）
                    g.pending_verify = None;
                    g.last_error = if had_code {
                        Some("配对码不正确，请重新输入手机上显示的数字".into())
                    } else {
                        None
                    };
                }
                if !need_verify_emitted {
                    let _ = app.emit("ilink-need-verify", serde_json::json!({ "retry": had_code }));
                    need_verify_emitted = true;
                }
                let _ = super::emit_state(&app, &st).await;
                sleep(std::time::Duration::from_millis(800)).await;
            }
            Some("confirmed") => {
                let token = get("bot_token").unwrap_or_default();
                if token.is_empty() {
                    let mut g = st.inner.lock().await;
                    g.last_error = Some("confirmed 响应缺少 bot_token".into());
                    continue;
                }
                let session = WechatSession {
                    token,
                    bot_id: get("ilink_bot_id").unwrap_or_default(),
                    user_id: get("ilink_user_id").unwrap_or_default(),
                    base_url: get("baseurl")
                        .filter(|b| !b.is_empty())
                        .unwrap_or_else(|| DEFAULT_BASE_URL.to_string()),
                    saved_at_ms: now_ms(),
                    cursor: String::new(),
                };
                let _ = store::record_token(&dir, &session.token);
                if let Err(e) = store::save_session(&dir, &session) {
                    let mut g = st.inner.lock().await;
                    g.last_error = Some(format!("会话保存失败: {}", e));
                }
                // 换代：作废旧循环（含本循环），进入收消息循环。
                let new_epoch = super::bump_epoch(&st).await;
                {
                    let mut g = st.inner.lock().await;
                    g.state = LinkState::Connected;
                    g.session = Some(session);
                    g.last_error = None;
                    g.qrcode = None;
                    g.qrcode_url = None;
                }
                let _ = super::emit_state(&app, &st).await;
                poll::spawn_poll(app.clone(), st.clone(), new_epoch);
                return;
            }
            Some("expired") => {
                // 二维码过期 → 上层刷新。
                {
                    let mut g = st.inner.lock().await;
                    g.state = LinkState::WaitingQr;
                    g.last_error = Some("二维码已过期，正在刷新…".into());
                }
                qrcode = None;
                let _ = super::emit_state(&app, &st).await;
            }
            Some("verify_code_blocked") => {
                {
                    let mut g = st.inner.lock().await;
                    g.pending_verify = None;
                    g.last_error = Some("配对码多次错误已被暂时限制，已刷新二维码".into());
                    g.state = LinkState::WaitingQr;
                }
                qrcode = None;
                let _ = super::emit_state(&app, &st).await;
            }
            Some("scaned_but_redirect") => {
                if let Some(h) = get("redirect_host").filter(|h| !h.is_empty()) {
                    base = if h.starts_with("http") { h } else { format!("https://{}", h) };
                }
                // 继续轮询（新 base 生效）。
            }
            Some("binded_redirect") => {
                // 本地 token 命中已绑定 → 恢复旧会话（若有且未过期）。
                let sess = { st.inner.lock().await.session.clone() };
                if let Some(s) = sess {
                    if s.is_fresh(now_ms()) {
                        let new_epoch = super::bump_epoch(&st).await;
                        {
                            let mut g = st.inner.lock().await;
                            g.state = LinkState::Connected;
                            g.session = Some(s);
                            g.last_error = None;
                        }
                        let _ = super::emit_state(&app, &st).await;
                        poll::spawn_poll(app.clone(), st.clone(), new_epoch);
                        return;
                    }
                }
                sleep(std::time::Duration::from_secs(1)).await;
            }
            _ => {
                let mut g = st.inner.lock().await;
                g.last_error = Some(format!(
                    "未知扫码状态: {}",
                    status.as_deref().unwrap_or("(empty)")
                ));
                sleep(std::time::Duration::from_secs(2)).await;
            }
        }
    }
}
