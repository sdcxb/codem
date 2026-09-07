// ============================================================
// ilink/mod.rs — 微信 ClawBot（iLink 协议）传输层门面
//
// 对标 DSH-Desktop-EAC 微信桥（EAC 桥 lib/wechat.js 状态机行为基准），
// 协议实现基于腾讯官方 @tencent-weixin/openclaw-weixin 2.4.6 公开源码
// 与社区实测（见 .eac-analysis/wechat-ilink-report.md）。
//
// 分层：本模块只做"传输层"（登录/轮询/收发/存储/配额），不碰 Codem
// 引擎（引擎在 TS 侧）。对外暴露 tauri commands + events：
//   commands: ilink_status / ilink_start_login / ilink_login_submit_verify
//             / ilink_logout / ilink_send_text
//   events:   ilink-state / ilink-qr / ilink-need-verify
//             / ilink-inbound / ilink-expired
//
// 合规红线（产品化须标注）：10 条/24h 配额与 24h 有效期为社区实测，
// 非腾讯官方承诺——本端软记账、不编造配额；媒体/群聊 MVP 不支持。
// ============================================================

pub mod login;
pub mod poll;
pub mod proto;
pub mod store;

use crate::ilink::proto::{
    BOT_AGENT, CHANNEL_VERSION, QUOTA_MAX, QUOTA_WINDOW_MS, SESSION_TTL_MS, TEXT_CHUNK_LEN,
    WechatSession,
};
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::{Mutex as TokioMutex, Notify};
use tokio::time::Duration;

pub const ILINK_DIR: &str = "ilink";
/// 单次登录总等待上限（官方 CLI 480s）【§7.4】。
pub const LOGIN_TOTAL_TIMEOUT_MS: i64 = 480_000;
/// 入站缓冲上限（TS 侧挂载前到达的消息不丢）。
pub const INBOUND_LOG_CAP: usize = 200;

// ---- 传输层状态机（TS 侧 LinkState 与之一一对应）----

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LinkState {
    Disconnected,
    WaitingQr,
    WaitingScan,
    NeedVerifyCode,
    Connected,
    Expired,
}

impl LinkState {
    pub fn as_str(&self) -> &'static str {
        match self {
            LinkState::Disconnected => "disconnected",
            LinkState::WaitingQr => "waiting_qr",
            LinkState::WaitingScan => "waiting_scan",
            LinkState::NeedVerifyCode => "need_verify_code",
            LinkState::Connected => "connected",
            LinkState::Expired => "expired",
        }
    }
}

// ---- 每 peer 配额记账（纯逻辑，可单测）----

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PeerQuota {
    /// 该 peer 最近一条入站消息时间（窗口起点）。
    pub window_start_ms: i64,
    /// 窗口内已成功发出的条数。
    pub sent_count: u32,
    /// 该 peer 累计入站条数（展示用）。
    pub inbound_count: u64,
}

/// 收到该 peer 新消息 → 重置窗口（预算回到 QUOTA_MAX）【§7.2】。
pub fn quota_reset(q: &mut PeerQuota, now_ms: i64) {
    q.window_start_ms = now_ms;
    q.sent_count = 0;
    q.inbound_count += 1;
}

/// 是否可以再发 1 条。Err 说明原因（不编造：窗口过期/预算耗尽都明确报出）。
pub fn quota_can_send(q: &PeerQuota, now_ms: i64) -> Result<(), String> {
    if q.window_start_ms == 0 {
        return Err("该联系人尚无会话窗口（未收到过消息）".into());
    }
    if now_ms - q.window_start_ms > QUOTA_WINDOW_MS {
        return Err("24 小时会话预算窗口已过期，请对方先发消息再回复".into());
    }
    if q.sent_count >= QUOTA_MAX {
        return Err(format!(
            "24 小时主动消息配额（{} 条/24h）已用完，请对方再次发消息以重置",
            QUOTA_MAX
        ));
    }
    Ok(())
}

pub fn quota_mark_sent(q: &mut PeerQuota) {
    q.sent_count += 1;
}

// ---- 事件 / 状态 ----

/// 上抛给 TS 的入站消息（纯文本）。
#[derive(Serialize, Clone, Debug)]
pub struct InboundEvent {
    pub peer: String,
    pub text: String,
    pub message_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub create_time_ms: Option<i64>,
}

/// 管理态（tauri .manage 一个 Arc<IlinkState>）。
pub struct IlinkState {
    pub inner: TokioMutex<IlinkInner>,
    /// 唤醒在途长轮询（配对码提交 / epoch 换代即时生效）。
    pub poke: Notify,
}

pub struct IlinkInner {
    pub state: LinkState,
    pub qrcode: Option<String>,
    pub qrcode_url: Option<String>,
    /// 用户提交的配对码（login_loop 每轮 take）。
    pub pending_verify: Option<String>,
    /// 代际守卫：start_login/logout/confirmed/expired 递增，作废旧循环。
    pub epoch: u64,
    pub session: Option<WechatSession>,
    pub last_error: Option<String>,
    pub last_inbound_at: Option<i64>,
    pub last_outbound_at: Option<i64>,
    pub inbound_count: u64,
    pub outbound_count: u64,
    /// peer → 最新 context_token（回复原样回传）【§4.2】。
    pub contexts: HashMap<String, String>,
    /// peer → 配额。
    pub quota: HashMap<String, PeerQuota>,
    /// 入站缓冲（ilink_status 读取并清空；事件与缓冲双轨，TS 按 message_id 去重）。
    pub inbound_log: VecDeque<InboundEvent>,
}

impl Default for IlinkInner {
    fn default() -> Self {
        IlinkInner {
            state: LinkState::Disconnected,
            qrcode: None,
            qrcode_url: None,
            pending_verify: None,
            epoch: 0,
            session: None,
            last_error: None,
            last_inbound_at: None,
            last_outbound_at: None,
            inbound_count: 0,
            outbound_count: 0,
            contexts: HashMap::new(),
            quota: HashMap::new(),
            inbound_log: VecDeque::new(),
        }
    }
}

impl Default for IlinkState {
    fn default() -> Self {
        IlinkState {
            inner: TokioMutex::new(IlinkInner::default()),
            poke: Notify::new(),
        }
    }
}

impl IlinkState {
    pub fn new() -> Arc<Self> {
        Arc::new(IlinkState::default())
    }
}

// ---- 基础工具 ----

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// app-data/ilink 目录。
pub async fn data_dir(app: &AppHandle) -> std::path::PathBuf {
    app.path()
        .app_data_dir()
        .map(|d| d.join(ILINK_DIR))
        .unwrap_or_else(|_| std::env::temp_dir().join(ILINK_DIR))
}

pub async fn current_epoch(st: &Arc<IlinkState>) -> u64 {
    st.inner.lock().await.epoch
}

/// epoch 换代并唤醒在途循环。返回新 epoch。
pub async fn bump_epoch(st: &Arc<IlinkState>) -> u64 {
    let mut g = st.inner.lock().await;
    g.epoch += 1;
    let e = g.epoch;
    drop(g);
    st.poke.notify_waiters();
    e
}

// ---- 事件发射 ----

/// 构造状态快照并 emit "ilink-state"。
pub async fn emit_state(app: &AppHandle, st: &Arc<IlinkState>) -> Result<(), String> {
    let g = st.inner.lock().await;
    let payload = serde_json::json!({
        "state": g.state.as_str(),
        "qrcode_url": g.qrcode_url,
        "bot_id": g.session.as_ref().map(|s| s.bot_id.clone()).unwrap_or_default(),
        "user_id": g.session.as_ref().map(|s| s.user_id.clone()).unwrap_or_default(),
        "expires_at_ms": g.session.as_ref().map(|s| s.saved_at_ms + SESSION_TTL_MS),
        "last_error": g.last_error,
        "last_inbound_at": g.last_inbound_at,
        "last_outbound_at": g.last_outbound_at,
        "inbound_count": g.inbound_count,
        "outbound_count": g.outbound_count,
        "peer_count": g.contexts.len(),
    });
    app.emit("ilink-state", payload)
        .map_err(|e| format!("ilink-state emit failed: {}", e))
}

/// 登录失败放弃（超时/刷新用尽）：回 Disconnected 并保留错误信息。
pub async fn give_up(app: &AppHandle, st: &Arc<IlinkState>, msg: &str) {
    {
        let mut g = st.inner.lock().await;
        g.state = LinkState::Disconnected;
        g.qrcode = None;
        g.qrcode_url = None;
        g.pending_verify = None;
        g.last_error = Some(msg.to_string());
    }
    let _ = emit_state(app, st).await;
}

/// 会话失效（本地 23h / 服务端 401/403/-14）：停循环、清会话、进 Expired。
pub async fn expire_session(app: &AppHandle, st: &Arc<IlinkState>, reason: &str) {
    let dir = data_dir(app).await;
    let token_for_stop = {
        let mut g = st.inner.lock().await;
        g.epoch += 1;
        g.state = LinkState::Expired;
        g.last_error = Some(reason.to_string());
        let t = g.session.as_ref().map(|s| (s.token.clone(), s.effective_base()));
        g.session = None;
        g.qrcode = None;
        g.qrcode_url = None;
        g.pending_verify = None;
        t
    };
    st.poke.notify_waiters();
    store::clear_session(&dir);
    if let Some((token, base)) = token_for_stop {
        best_effort_notify_stop(&base, &token);
    }
    let _ = emit_state(app, st).await;
    let _ = app.emit("ilink-expired", serde_json::json!({ "reason": reason }));
}

// ---- 尽力通知（best-effort，失败忽略）【官方 notifystop】----

fn best_effort_notify_stop(base: &str, token: &str) {
    let base = base.to_string();
    let token = token.to_string();
    tauri::async_runtime::spawn(async move {
        let _ = proto::post_json(
            &base,
            "/ilink/bot/msg/notifystop",
            &[],
            serde_json::json!({}),
            Some(&token),
            Duration::from_secs(5),
        )
        .await;
    });
}

// ============================================================
// tauri commands
// ============================================================

/// 当前状态 + 挂载前入站缓冲（读取即清空，事件双轨由 TS 按 message_id 去重）。
#[tauri::command]
pub async fn ilink_status(
    app: AppHandle,
    state: State<'_, Arc<IlinkState>>,
) -> Result<serde_json::Value, String> {
    let st: Arc<IlinkState> = state.inner().clone();
    let mut g = st.inner.lock().await;
    let pending: Vec<InboundEvent> = g.inbound_log.drain(..).collect();
    let payload = serde_json::json!({
        "state": g.state.as_str(),
        "qrcode_url": g.qrcode_url,
        "bot_id": g.session.as_ref().map(|s| s.bot_id.clone()).unwrap_or_default(),
        "user_id": g.session.as_ref().map(|s| s.user_id.clone()).unwrap_or_default(),
        "expires_at_ms": g.session.as_ref().map(|s| s.saved_at_ms + SESSION_TTL_MS),
        "last_error": g.last_error,
        "last_inbound_at": g.last_inbound_at,
        "last_outbound_at": g.last_outbound_at,
        "inbound_count": g.inbound_count,
        "outbound_count": g.outbound_count,
        "peer_count": g.contexts.len(),
        "quota": g.quota.iter().map(|(k, q)| {
            serde_json::json!({ "peer": k, "sent": q.sent_count, "window_start_ms": q.window_start_ms })
        }).collect::<Vec<_>>(),
        "pending": pending,
    });
    let _ = app;
    Ok(payload)
}

/// 重新登录：清会话/停旧循环 → 起新的 QR 登录循环。
#[tauri::command]
pub async fn ilink_start_login(
    app: AppHandle,
    state: State<'_, Arc<IlinkState>>,
) -> Result<(), String> {
    let st: Arc<IlinkState> = state.inner().clone();
    let dir = data_dir(&app).await;
    let epoch = {
        let mut g = st.inner.lock().await;
        g.epoch += 1;
        g.state = LinkState::Disconnected;
        g.session = None;
        g.qrcode = None;
        g.qrcode_url = None;
        g.pending_verify = None;
        g.last_error = None;
        let e = g.epoch;
        e
    };
    st.poke.notify_waiters();
    store::clear_session(&dir);
    let _ = emit_state(&app, &st).await;
    tauri::async_runtime::spawn(login::login_loop(app.clone(), st.clone(), epoch));
    Ok(())
}

/// 提交手机上显示的配对码（登录进行中才有效）。
#[tauri::command]
pub async fn ilink_login_submit_verify(
    code: String,
    state: State<'_, Arc<IlinkState>>,
) -> Result<(), String> {
    let code = code.trim().to_string();
    if code.is_empty() {
        return Err("配对码为空".into());
    }
    let st: Arc<IlinkState> = state.inner().clone();
    {
        let mut g = st.inner.lock().await;
        match g.state {
            LinkState::Connected => return Err("已在连接状态，无需配对码".into()),
            LinkState::Disconnected => {
                return Err("没有进行中的登录，请先点击「扫码登录」".into())
            }
            _ => {}
        }
        g.pending_verify = Some(code);
    }
    // 唤醒在途轮询，让配对码立即生效。
    st.poke.notify_one();
    Ok(())
}

/// 退出登录：清会话、停循环、best-effort notifystop。
#[tauri::command]
pub async fn ilink_logout(
    app: AppHandle,
    state: State<'_, Arc<IlinkState>>,
) -> Result<(), String> {
    let st: Arc<IlinkState> = state.inner().clone();
    let dir = data_dir(&app).await;
    let token_for_stop = {
        let mut g = st.inner.lock().await;
        g.epoch += 1;
        g.state = LinkState::Disconnected;
        let t = g
            .session
            .as_ref()
            .map(|s| (s.token.clone(), s.effective_base()));
        g.session = None;
        g.qrcode = None;
        g.qrcode_url = None;
        g.pending_verify = None;
        g.contexts.clear();
        g.quota.clear();
        g.inbound_log.clear();
        g.last_error = None;
        t
    };
    st.poke.notify_waiters();
    store::clear_session(&dir);
    if let Some((token, base)) = token_for_stop {
        best_effort_notify_stop(&base, &token);
    }
    let _ = emit_state(&app, &st).await;
    Ok(())
}

/// 发送文本回复（按 ≤TEXT_CHUNK_LEN 切块；每 peer 配额记账）。
/// Ok: {sent_chunks, total_chunks}；配额/网络问题 Err。
#[tauri::command]
pub async fn ilink_send_text(
    peer: String,
    text: String,
    state: State<'_, Arc<IlinkState>>,
) -> Result<serde_json::Value, String> {
    let st: Arc<IlinkState> = state.inner().clone();
    if peer.trim().is_empty() {
        return Err("peer 为空".into());
    }
    let chunks = proto::chunk_text(&text, TEXT_CHUNK_LEN);
    if chunks.is_empty() {
        return Ok(serde_json::json!({ "sent_chunks": 0, "total_chunks": 0 }));
    }

    // 会话快照（不持锁跨 await）。
    let (token, base, context_token) = {
        let g = st.inner.lock().await;
        let s = g
            .session
            .as_ref()
            .ok_or_else(|| "微信尚未连接，无法发送".to_string())?;
        (s.token.clone(), s.effective_base(), g.contexts.get(&peer).cloned())
    };

    let mut sent: usize = 0;
    for chunk in &chunks {
        // 每条发送前配额检查（不编造：真实记账）【§7.2】。
        {
            let mut g = st.inner.lock().await;
            let q = g.quota.entry(peer.clone()).or_default();
            if let Err(e) = quota_can_send(q, now_ms()) {
                if sent > 0 {
                    return Ok(serde_json::json!({
                        "sent_chunks": sent, "total_chunks": chunks.len(),
                        "partial": true, "reason": e,
                    }));
                }
                return Err(e);
            }
        }

        let body = serde_json::json!({
            "msg": {
                "from_user_id": "",
                "to_user_id": peer,
                "client_id": format!("c-{}", uuid::Uuid::new_v4()),
                "message_type": 2,
                "message_state": 2,
                "context_token": context_token.clone().unwrap_or_default(),
                "item_list": [ { "type": 1, "text_item": { "text": chunk } } ],
                "run_id": format!("r-{}", uuid::Uuid::new_v4()),
            },
            "base_info": {
                "channel_version": CHANNEL_VERSION,
                "bot_agent": BOT_AGENT,
            }
        });
        let resp = proto::post_json(
            &base,
            "/ilink/bot/sendmessage",
            &[],
            body,
            Some(&token),
            Duration::from_secs(20),
        )
        .await
        .map_err(|e| {
            if sent > 0 {
                format!("已发送 {} 条后出错: {}", sent, e)
            } else {
                format!("发送失败: {}", e)
            }
        })?;

        let ret = resp.get("ret").and_then(|r| r.as_i64());
        if ret.is_some() && ret != Some(0) {
            let msg = resp
                .get("errmsg")
                .and_then(|m| m.as_str())
                .unwrap_or("unknown")
                .to_string();
            if sent > 0 {
                return Ok(serde_json::json!({
                    "sent_chunks": sent, "total_chunks": chunks.len(),
                    "partial": true, "reason": format!("sendmessage ret={:?} errmsg={}", ret, msg),
                }));
            }
            return Err(format!("sendmessage 失败 ret={:?} errmsg={}", ret, msg));
        }

        sent += 1;
        {
            let mut g = st.inner.lock().await;
            let q = g.quota.entry(peer.clone()).or_default();
            quota_mark_sent(q);
            g.outbound_count += 1;
            g.last_outbound_at = Some(now_ms());
        }
    }

    Ok(serde_json::json!({ "sent_chunks": sent, "total_chunks": chunks.len() }))
}

// ---- 启动恢复（setup 里调用）：有未过期会话 → 自动续连 ----

pub async fn restore_on_startup(app: AppHandle, st: Arc<IlinkState>) {
    let dir = data_dir(&app).await;
    let session = store::load_session(&dir);
    let Some(session) = session else {
        let _ = emit_state(&app, &st).await;
        return;
    };
    if !session.is_fresh(now_ms()) {
        store::clear_session(&dir);
        {
            let mut g = st.inner.lock().await;
            g.state = LinkState::Expired;
            g.last_error = Some("会话已过期（>23h），请重新扫码".into());
        }
        let _ = emit_state(&app, &st).await;
        let _ = app.emit("ilink-expired", serde_json::json!({ "reason": "session_expired" }));
        return;
    }
    let epoch = {
        let mut g = st.inner.lock().await;
        g.state = LinkState::Connected;
        g.session = Some(session);
        g.epoch += 1;
        g.epoch
    };
    let _ = emit_state(&app, &st).await;
    poll::spawn_poll(app.clone(), st.clone(), epoch);
}

// ============================================================
// 单元测试（纯逻辑，无网络/无 tauri）
// ============================================================

#[cfg(test)]
mod tests {
    use super::*;

    fn quota() -> PeerQuota {
        PeerQuota::default()
    }

    #[test]
    fn quota_window_reset_on_inbound() {
        let now = 1_000_000_000_000i64;
        let mut q = quota();
        // 无窗口 → 不能发
        assert!(quota_can_send(&q, now).is_err());
        // 入站 → 窗口重置
        quota_reset(&mut q, now);
        assert!(quota_can_send(&q, now).is_ok());
        assert_eq!(q.inbound_count, 1);
    }

    #[test]
    fn quota_exhausts_at_max() {
        let now = 1_000_000_000_000i64;
        let mut q = quota();
        quota_reset(&mut q, now);
        for _ in 0..QUOTA_MAX {
            assert!(quota_can_send(&q, now).is_ok());
            quota_mark_sent(&mut q);
        }
        let err = quota_can_send(&q, now).unwrap_err();
        assert!(err.contains("配额"));
    }

    #[test]
    fn quota_window_expires_after_24h() {
        let now = 1_000_000_000_000i64;
        let mut q = quota();
        quota_reset(&mut q, now);
        let later = now + QUOTA_WINDOW_MS + 1;
        let err = quota_can_send(&q, later).unwrap_err();
        assert!(err.contains("过期"));
    }

    #[test]
    fn link_state_names() {
        assert_eq!(LinkState::Connected.as_str(), "connected");
        assert_eq!(LinkState::NeedVerifyCode.as_str(), "need_verify_code");
        assert_eq!(LinkState::Expired.as_str(), "expired");
    }
}
