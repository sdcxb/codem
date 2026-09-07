// ============================================================
// phone/mod.rs — @codem/phone-link 传输层（①手机连接，dsh-phone 对标）
//
// Codem 桌面 bundle 无 HTTP server 宿主（host-webserver 等被禁用），
// 引擎又活在 WebView TS——本模块补齐"手机可访问的 http UI + API"地基：
//
//   手机浏览器 ──HTTP(LAN)──▶ [Rust phone 服务] ──event──▶ [WebView TS phone-link]
//     /pair?token=配对       配对门卫+静态页+代理       会话/消息/chat(引擎)
//     /api/* (cookie 鉴权)   phone-request {reqId,...}  phone_respond {reqId,json}
//
// 配对模型对标 EAC phone-bridge.ts：
//   - 桌面 start → 0.0.0.0:0(OS 随机端口) 监听 + 生成配对 URL（token 随机，5min TTL）
//   - 手机开 /pair?token → 等待页轮询 /api/pair-state
//   - 桌面 decide(approve) → 生成会话 secret → pair-state 返回 Set-Cookie
//     codem_phone=<secret>; HttpOnly; SameSite=Strict; Max-Age=31536000
//   - 之后 /api/* 全部带 cookie，secret 以 sha256 落盘 devices.json（重启保配对）
//
// 诚实标注：本模块不编造数据——所有会话/消息/回复来自 WebView 引擎侧；
// 引擎不在时 /api/* 返回 502。明文 HTTP + LAN cookie 属 MVP 安全水位
// （DSH 同款 http origin），详见设置卡合规提示。
// ============================================================

pub mod http;
pub mod lan;

use crate::phone::http::{
    parse_cookies, split_request, Request as HttpRequest, Response as HttpResponse,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{oneshot, Mutex as TokioMutex};
use tokio::time::{timeout, Duration};

// ---- 常量 ----

const PAIR_TTL_MS: i64 = 5 * 60 * 1000;
const MAX_DEVICES: usize = 8;
const COOKIE_NAME: &str = "codem_phone";
const PHONE_DIR: &str = "phone";
const MAX_REQUEST_BYTES: usize = 4 * 1024 * 1024;
const PROXY_TIMEOUT: Duration = Duration::from_secs(15);

const APP_HTML: &str = include_str!("ui/app.html");
const PAIR_HTML: &str = include_str!("ui/pair.html");

// ---- 状态 ----

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Device {
    pub id: String,
    /// sha256(secret) hex（不落明文 secret）。
    pub secret_hash: String,
    #[serde(default)]
    pub ip: String,
    pub paired_at_ms: i64,
    #[serde(default)]
    pub last_seen_ms: i64,
}

#[derive(Clone, Debug)]
pub struct Pairing {
    pub token: String,
    pub expires_at_ms: i64,
    pub decided: Option<bool>,
    pub device_created: bool,
    pub remote_ip: String,
    pub waiting_at_ms: Option<i64>,
}

pub struct PhoneInner {
    pub running: bool,
    pub port: u16,
    pub lan_ip: String,
    pub pairing: Option<Pairing>,
    pub devices: Vec<Device>,
    pub devices_loaded: bool,
    /// 代理到 TS 的在途请求（reqId → 应答通道）。
    pub pending: HashMap<String, oneshot::Sender<HttpResponse>>,
    pub server_handle: Option<tauri::async_runtime::JoinHandle<()>>,
}

impl Default for PhoneInner {
    fn default() -> Self {
        PhoneInner {
            running: false,
            port: 0,
            lan_ip: String::new(),
            pairing: None,
            devices: Vec::new(),
            devices_loaded: false,
            pending: HashMap::new(),
            server_handle: None,
        }
    }
}

pub struct PhoneState {
    pub inner: TokioMutex<PhoneInner>,
}

impl PhoneState {
    pub fn new() -> Arc<Self> {
        Arc::new(PhoneState {
            inner: TokioMutex::new(PhoneInner::default()),
        })
    }
}

// ---- 纯工具（可单测）----

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn random_hex(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    for b in buf.iter_mut() {
        *b = rand::random();
    }
    hex_encode(&buf)
}

pub fn hex_encode(data: &[u8]) -> String {
    let mut s = String::with_capacity(data.len() * 2);
    for b in data {
        s.push_str(&format!("{:02x}", b));
    }
    s
}

pub fn sha256_hex(s: &str) -> String {
    let mut h = Sha256::new();
    h.update(s.as_bytes());
    hex_encode(&h.finalize())
}

/// 常数时间字符串比较（长度不同直接 false；随后逐字节 XOR 累计）。
pub fn timing_safe_eq(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff: u8 = 0;
    for (x, y) in a.as_bytes().iter().zip(b.as_bytes()) {
        diff |= x ^ y;
    }
    diff == 0
}

fn rotate_pairing(now: i64) -> Pairing {
    Pairing {
        token: random_hex(16),
        expires_at_ms: now + PAIR_TTL_MS,
        decided: None,
        device_created: false,
        remote_ip: String::new(),
        waiting_at_ms: None,
    }
}

/// 配对 token 校验（纯逻辑，测试友好）。
pub fn pair_token_status(pairing: &Option<Pairing>, token: &str, now: i64) -> PairTokenStatus {
    match pairing {
        None => PairTokenStatus::Invalid,
        Some(p) => {
            if !timing_safe_eq(&p.token, token) {
                PairTokenStatus::Invalid
            } else if now > p.expires_at_ms {
                PairTokenStatus::Expired
            } else if p.decided == Some(true) {
                PairTokenStatus::Approved
            } else if p.decided == Some(false) {
                PairTokenStatus::Rejected
            } else {
                PairTokenStatus::Waiting
            }
        }
    }
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum PairTokenStatus {
    Invalid,
    Expired,
    Waiting,
    Approved,
    Rejected,
}

/// 鉴权（纯逻辑，测试友好）：cookie secret 命中设备返回 device。
pub fn auth_device<'a>(devices: &'a [Device], secret: Option<&str>) -> Option<&'a Device> {
    let secret = secret?;
    let hash = sha256_hex(secret);
    devices.iter().find(|d| d.secret_hash == hash)
}

// ---- 持久化 ----

async fn data_dir(app: &AppHandle) -> std::path::PathBuf {
    app.path()
        .app_data_dir()
        .map(|d| d.join(PHONE_DIR))
        .unwrap_or_else(|_| std::env::temp_dir().join(PHONE_DIR))
}

async fn save_devices(app: &AppHandle, st: &Arc<PhoneState>) {
    let dir = data_dir(app).await;
    let devices = st.inner.lock().await.devices.clone();
    if let Err(_) = std::fs::create_dir_all(&dir) {
        return;
    }
    if let Ok(json) = serde_json::to_string(&devices) {
        let _ = std::fs::write(dir.join("devices.json"), json);
    }
}

async fn ensure_devices(app: &AppHandle, st: &Arc<PhoneState>) {
    let mut g = st.inner.lock().await;
    if g.devices_loaded {
        return;
    }
    g.devices_loaded = true;
    let dir = data_dir(app).await;
    if let Ok(raw) = std::fs::read_to_string(dir.join("devices.json")) {
        if let Ok(list) = serde_json::from_str::<Vec<Device>>(&raw) {
            g.devices = list;
        }
    }
}

// ---- 事件 ----

async fn emit_state(app: &AppHandle, st: &Arc<PhoneState>) {
    let payload = status_snapshot(app, st).await;
    let _ = app.emit("phone-state", payload);
}

async fn status_snapshot(app: &AppHandle, st: &Arc<PhoneState>) -> serde_json::Value {
    ensure_devices(app, st).await;
    let g = st.inner.lock().await;
    let pair_url = g.pairing.as_ref().map(|p| {
        format!(
            "http://{}:{}/pair?token={}",
            g.lan_ip, g.port, p.token
        )
    });
    serde_json::json!({
        "running": g.running,
        "port": g.port,
        "lan_ip": g.lan_ip,
        "url": if g.running {
            Some(format!("http://{}:{}/", g.lan_ip, g.port))
        } else { None },
        "pair_url": pair_url,
        "pairing": g.pairing.as_ref().map(|p| serde_json::json!({
            "active": now_ms() <= p.expires_at_ms,
            "expires_at_ms": p.expires_at_ms,
            "decided": p.decided,
            "waiting": p.waiting_at_ms.is_some(),
        })),
        "devices": g.devices.iter().map(|d| serde_json::json!({
            "id": d.id, "ip": d.ip, "paired_at_ms": d.paired_at_ms, "last_seen_ms": d.last_seen_ms,
        })).collect::<Vec<_>>(),
    })
}

// ---- HTTP 服务 ----

/// 启动监听（幂等）：未运行则 bind 0.0.0.0:0；已运行按需轮换配对。
async fn start_server(app: AppHandle, st: Arc<PhoneState>) -> Result<serde_json::Value, String> {
    {
        let mut g = st.inner.lock().await;
        if g.running {
            // 运行中：仅当无有效未决配对时轮换（对标 EAC 幂等重入语义）。
            let need_rotate = match &g.pairing {
                Some(p) => now_ms() > p.expires_at_ms || p.decided.is_some(),
                None => true,
            };
            if need_rotate {
                g.pairing = Some(rotate_pairing(now_ms()));
            }
            let url = format!("http://{}:{}/", g.lan_ip, g.port);
            return Ok(serde_json::json!({
                "url": url, "port": g.port, "lan_ip": g.lan_ip,
                "pair_url": format!("{}pair?token={}", url,
                    g.pairing.as_ref().map(|p| p.token.clone()).unwrap_or_default()),
            }));
        }
        g.lan_ip = lan::lan_ip();
    }

    let listener = TcpListener::bind("0.0.0.0:0")
        .await
        .map_err(|e| format!("绑定失败: {}", e))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("取端口失败: {}", e))?
        .port();

    {
        let mut g = st.inner.lock().await;
        g.port = port;
        g.pairing = Some(rotate_pairing(now_ms()));
        g.running = true;
    }

    let handle = {
        let st2 = st.clone();
        let app2 = app.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                match listener.accept().await {
                    Ok((stream, _peer)) => {
                        let st3 = st2.clone();
                        let app3 = app2.clone();
                        tauri::async_runtime::spawn(async move {
                            let _ = handle_conn(app3, st3, stream).await;
                        });
                    }
                    Err(_) => break,
                }
            }
        })
    };
    {
        let mut g = st.inner.lock().await;
        g.server_handle = Some(handle);
    }

    let url = format!("http://{}:{}/", lan::lan_ip(), port);
    let pair_url = {
        let g = st.inner.lock().await;
        format!(
            "{}pair?token={}",
            url,
            g.pairing
                .as_ref()
                .map(|p| p.token.clone())
                .unwrap_or_default()
        )
    };
    emit_state(&app, &st).await;
    Ok(serde_json::json!({
        "url": url,
        "port": port,
        "lan_ip": lan::lan_ip(),
        "pair_url": pair_url,
    }))
}

async fn handle_conn(app: AppHandle, st: Arc<PhoneState>, mut stream: TcpStream) -> Result<(), ()> {
    let result = timeout(Duration::from_secs(25), async {
        // ---- 读请求（头 + body）----
        let mut buf: Vec<u8> = Vec::new();
        let mut chunk = [0u8; 8192];
        loop {
            let n = stream.read(&mut chunk).await.map_err(|_| ())?;
            if n == 0 {
                return Err(());
            }
            buf.extend_from_slice(&chunk[..n]);
            if buf.len() > MAX_REQUEST_BYTES {
                return Err(());
            }
            if let Some((head, header_end, cl)) = split_request(&buf) {
                while buf.len() < header_end + cl {
                    let n = stream.read(&mut chunk).await.map_err(|_| ())?;
                    if n == 0 {
                        return Err(());
                    }
                    buf.extend_from_slice(&chunk[..n]);
                    if buf.len() > MAX_REQUEST_BYTES {
                        return Err(());
                    }
                }
                let body = buf[header_end..header_end + cl].to_vec();
                let req = http::parse(&head, body).map_err(|_| ())?;
                let peer_ip = stream
                    .peer_addr()
                    .map(|a| a.ip().to_string())
                    .unwrap_or_default();
                let resp = route(&app, &st, req, peer_ip).await;
                let bytes = resp.to_bytes();
                stream.write_all(&bytes).await.map_err(|_| ())?;
                return Ok(());
            }
        }
    })
    .await;
    let _ = result;
    Ok(())
}

/// 路由分派（主逻辑）。peer_ip = 手机侧 IP（配对等待/记录用）。
async fn route(
    app: &AppHandle,
    st: &Arc<PhoneState>,
    req: HttpRequest,
    peer_ip: String,
) -> HttpResponse {
    let now = now_ms();
    match (req.method.as_str(), req.path.as_str()) {
        ("GET", "/") => HttpResponse::html(200, APP_HTML),
        ("GET", "/pair") => {
            let token = req.query.get("token").cloned().unwrap_or_default();
            let status = {
                let g = st.inner.lock().await;
                pair_token_status(&g.pairing, &token, now)
            };
            match status {
                PairTokenStatus::Waiting => {
                    {
                        let mut g = st.inner.lock().await;
                        if let Some(p) = &mut g.pairing {
                            p.remote_ip = peer_ip.clone();
                            if p.waiting_at_ms.is_none() {
                                p.waiting_at_ms = Some(now);
                            }
                        }
                    }
                    emit_state(app, st).await;
                    HttpResponse::html(200, PAIR_HTML)
                }
                PairTokenStatus::Approved | PairTokenStatus::Rejected => {
                    // 已决：手机应已拿到 cookie；直接回应用户友好提示。
                    HttpResponse::html(200, PAIR_HTML)
                }
                PairTokenStatus::Expired => HttpResponse::html(410, PAIR_HTML),
                PairTokenStatus::Invalid => HttpResponse::html(403, PAIR_HTML),
            }
        }
        ("GET", "/api/pair-state") => {
            let token = req.query.get("token").cloned().unwrap_or_default();
            ensure_devices(app, st).await; // 先加载设备（避免锁内二次加锁）
            let (status, cookie, new_device_id) = {
                let mut g = st.inner.lock().await;
                let s = pair_token_status(&g.pairing, &token, now);
                let mut cookie = None;
                let mut new_device_id = None;
                if s == PairTokenStatus::Approved {
                    if let Some(p) = &mut g.pairing {
                        if !p.device_created {
                            p.device_created = true;
                            if p.remote_ip.is_empty() {
                                p.remote_ip = peer_ip.clone();
                            }
                            let secret = random_hex(16);
                            let dev = Device {
                                id: format!("dev-{}", random_hex(6)),
                                secret_hash: sha256_hex(&secret),
                                ip: p.remote_ip.clone(),
                                paired_at_ms: now,
                                last_seen_ms: now,
                            };
                            g.devices.retain(|d| d.id != dev.id);
                            if g.devices.len() >= MAX_DEVICES {
                                g.devices.remove(0);
                            }
                            new_device_id = Some(dev.id.clone());
                            cookie = Some(secret.clone());
                            g.devices.push(dev);
                            let _ = secret;
                        }
                    }
                }
                (s, cookie, new_device_id)
            };
            if let Some(did) = new_device_id {
                let _ = app.emit("phone-paired", serde_json::json!({ "device_id": did }));
            }
            match status {
                PairTokenStatus::Waiting => {
                    emit_state(app, st).await;
                    HttpResponse::json(200, serde_json::json!({ "state": "waiting" }))
                }
                PairTokenStatus::Approved => {
                    save_devices(app, st).await;
                    emit_state(app, st).await;
                    let mut resp = HttpResponse::json(200, serde_json::json!({ "state": "approved" }));
                    if let Some(secret) = cookie {
                        resp.headers.push((
                            "Set-Cookie".into(),
                            format!(
                                "{}={}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000",
                                COOKIE_NAME, secret
                            ),
                        ));
                    }
                    resp
                }
                PairTokenStatus::Rejected => {
                    HttpResponse::json(200, serde_json::json!({ "state": "rejected" }))
                }
                PairTokenStatus::Expired => {
                    HttpResponse::json(410, serde_json::json!({ "state": "expired" }))
                }
                PairTokenStatus::Invalid => {
                    HttpResponse::json(403, serde_json::json!({ "state": "invalid" }))
                }
            }
        }
        _ if req.path.starts_with("/api/") => {
            // cookie 鉴权门卫
            ensure_devices(app, st).await;
            let device = {
                let g = st.inner.lock().await;
                let cookie = req.headers.get("cookie").map(|c| c.as_str());
                let cookies = parse_cookies(cookie);
                let secret = cookies.get(COOKIE_NAME).cloned();
                auth_device(&g.devices, secret.as_deref()).cloned()
            };
            let Some(device) = device else {
                return HttpResponse::json(401, serde_json::json!({ "error": "unauthorized" }));
            };
            // 更新 last_seen
            {
                let mut g = st.inner.lock().await;
                if let Some(d) = g.devices.iter_mut().find(|d| d.id == device.id) {
                    d.last_seen_ms = now;
                }
            }
            proxy_to_ts(app, st, req).await
        }
        _ => HttpResponse::json(404, serde_json::json!({ "error": "not_found" })),
    }
}

/// 代理到 WebView TS：事件 phone-request → 等 phone_respond。
async fn proxy_to_ts(
    app: &AppHandle,
    st: &Arc<PhoneState>,
    req: HttpRequest,
) -> HttpResponse {
    if !st.inner.lock().await.running {
        return HttpResponse::json(502, serde_json::json!({ "error": "server stopped" }));
    }
    let req_id = format!("pr-{}", uuid::Uuid::new_v4());
    let (tx, rx) = oneshot::channel::<HttpResponse>();
    {
        let mut g = st.inner.lock().await;
        g.pending.insert(req_id.clone(), tx);
    }
    let query: serde_json::Map<String, serde_json::Value> = req
        .query
        .iter()
        .map(|(k, v)| (k.clone(), serde_json::Value::String(v.clone())))
        .collect();
    let body = String::from_utf8_lossy(&req.body).into_owned();
    let payload = serde_json::json!({
        "reqId": req_id,
        "method": req.method,
        "path": req.path,
        "query": query,
        "body": body,
    });
    let _ = app.emit("phone-request", payload);

    match timeout(PROXY_TIMEOUT, rx).await {
        Ok(Ok(resp)) => resp,
        Ok(Err(_)) => {
            st.inner.lock().await.pending.remove(&req_id);
            HttpResponse::json(504, serde_json::json!({ "error": "engine unavailable" }))
        }
        Err(_) => {
            st.inner.lock().await.pending.remove(&req_id);
            HttpResponse::json(504, serde_json::json!({ "error": "timeout" }))
        }
    }
}

// ============================================================
// tauri commands
// ============================================================

#[tauri::command]
pub async fn phone_start(
    app: AppHandle,
    state: State<'_, Arc<PhoneState>>,
) -> Result<serde_json::Value, String> {
    start_server(app, state.inner().clone()).await
}

#[tauri::command]
pub async fn phone_stop(
    app: AppHandle,
    state: State<'_, Arc<PhoneState>>,
) -> Result<(), String> {
    let st: Arc<PhoneState> = state.inner().clone();
    {
        let mut g = st.inner.lock().await;
        g.running = false;
        g.pairing = None;
        if let Some(h) = g.server_handle.take() {
            h.abort();
        }
        let senders: Vec<_> = g.pending.drain().map(|(_, tx)| tx).collect();
        drop(g);
        for tx in senders {
            let _ = tx.send(HttpResponse::json(
                503,
                serde_json::json!({ "error": "server stopped" }),
            ));
        }
    }
    emit_state(&app, &st).await;
    Ok(())
}

#[tauri::command]
pub async fn phone_status(
    app: AppHandle,
    state: State<'_, Arc<PhoneState>>,
) -> Result<serde_json::Value, String> {
    let st: Arc<PhoneState> = state.inner().clone();
    Ok(status_snapshot(&app, &st).await)
}

#[tauri::command]
pub async fn phone_decide(
    app: AppHandle,
    approved: bool,
    state: State<'_, Arc<PhoneState>>,
) -> Result<(), String> {
    let st: Arc<PhoneState> = state.inner().clone();
    {
        let mut g = st.inner.lock().await;
        let valid = match &g.pairing {
            Some(p) => now_ms() <= p.expires_at_ms && p.decided.is_none(),
            None => false,
        };
        if !valid {
            return Err("没有待确认的配对请求（可能已过期）".into());
        }
        if let Some(p) = &mut g.pairing {
            p.decided = Some(approved);
        }
    }
    emit_state(&app, &st).await;
    Ok(())
}

#[tauri::command]
pub async fn phone_unpair(
    app: AppHandle,
    device_id: String,
    state: State<'_, Arc<PhoneState>>,
) -> Result<(), String> {
    let st: Arc<PhoneState> = state.inner().clone();
    {
        let mut g = st.inner.lock().await;
        g.devices.retain(|d| d.id != device_id);
    }
    save_devices(&app, &st).await;
    emit_state(&app, &st).await;
    Ok(())
}

/// TS 侧应答代理请求（reqId 对应 phone-request 事件）。
#[tauri::command]
pub async fn phone_respond(
    req_id: String,
    status: u16,
    body: String,
    state: State<'_, Arc<PhoneState>>,
) -> Result<(), String> {
    let st: Arc<PhoneState> = state.inner().clone();
    let tx = st.inner.lock().await.pending.remove(&req_id);
    if let Some(tx) = tx {
        let resp = HttpResponse::text(status, "application/json; charset=utf-8", &body);
        let _ = tx.send(resp);
    }
    Ok(())
}

// ---- 单测（纯逻辑）----

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timing_safe_eq_works() {
        assert!(timing_safe_eq("abc", "abc"));
        assert!(!timing_safe_eq("abc", "abd"));
        assert!(!timing_safe_eq("abc", "abcd"));
    }

    #[test]
    fn sha256_and_hex() {
        let h = sha256_hex("hello");
        assert_eq!(h.len(), 64);
        assert_eq!(h, sha256_hex("hello"));
        assert_ne!(h, sha256_hex("hello!"));
        assert_eq!(hex_encode(&[0xAB, 0x0F]), "ab0f");
    }

    #[test]
    fn pair_token_lifecycle() {
        let now = 1_000_000_000_000i64;
        let none: Option<Pairing> = None;
        assert_eq!(pair_token_status(&none, "x", now), PairTokenStatus::Invalid);

        let mut p = rotate_pairing(now);
        // 错 token → Invalid
        assert_eq!(pair_token_status(&Some(p.clone()), "wrong", now), PairTokenStatus::Invalid);
        // 对 token → Waiting
        assert_eq!(pair_token_status(&Some(p.clone()), &p.token, now), PairTokenStatus::Waiting);
        // 过期 → Expired
        p.expires_at_ms = now - 1;
        assert_eq!(pair_token_status(&Some(p.clone()), &p.token, now), PairTokenStatus::Expired);
        // 批准/拒绝
        p.expires_at_ms = now + 1000;
        p.decided = Some(true);
        assert_eq!(pair_token_status(&Some(p.clone()), &p.token, now), PairTokenStatus::Approved);
        p.decided = Some(false);
        assert_eq!(pair_token_status(&Some(p.clone()), &p.token, now), PairTokenStatus::Rejected);
    }

    #[test]
    fn auth_device_matches_secret_hash() {
        let devs = vec![Device {
            id: "d1".into(),
            secret_hash: sha256_hex("secret-a"),
            ip: String::new(),
            paired_at_ms: 1,
            last_seen_ms: 1,
        }];
        assert!(auth_device(&devs, Some("secret-a")).is_some());
        assert!(auth_device(&devs, Some("secret-b")).is_none());
        assert!(auth_device(&devs, None).is_none());
    }

    #[test]
    fn rotate_generates_unique() {
        let a = rotate_pairing(1);
        let b = rotate_pairing(1);
        assert_ne!(a.token, b.token);
        assert_eq!(a.expires_at_ms, 1 + PAIR_TTL_MS);
        assert_eq!(a.decided, None);
    }
}
