// ============================================================
// phone/aa_connector.rs — 按 Agents Anywhere 私有协议出站的 connector（阶段 R2）
//
// 它替换掉我们自研的那条中继路径（用户口径：**完全复刻它的路径，不做并行机制**）。
//
// ## 启动序列（逐行对齐它的 Python）
//
// 1. `POST {server}/api/v2/connector/auth`，头 `Authorization: Connector <id>:<token>`
//    → `{accessToken, expiresIn}`；**401 = 凭据失效，不再重试**
//    （`server/auth.py:47-69`；提前 60 秒刷新 `auth.py:13,74-83`）
// 2. `GET {wss}://{host}/api/v2/connector/ws`，头
//    `Authorization: Bearer <accessToken>` + `X-Device-OS: <os>`
//    （`client.py:246-258`、`urls.py:24-27`）
// 3. 发 `protocol.capabilitiesUpdated` 通知（`client.py:295-305`）
// 4. 心跳：**先立刻发一次**，再按 `heartbeatSeconds` 睡（`client.py:384-387`）
// 5. 读循环：收 `request` 帧 → 转给本机回环上游 → 回 `response` 帧
//
// ## 一处**刻意不实现**的东西：握手帧
//
// `protocol.py:58` 定义了 `ProtocolHandshakeRequest`（protocolVersions /
// connectorVersion / runtimes），但**整个 connector 与插件 TS 侧都没有用过它**
// （全仓搜索只有定义处）。它很可能是留给服务端或其他客户端的保留结构。
//
// 所以这里**不发握手** —— "复刻"的准则是**照它实际发的发**，
// 而不是照协议文件里定义了什么都发。多发一个服务端不预期的帧，
// 最好的情况是被忽略，最坏的情况是被判协议错误。
//
// ## 与我们自研那条路的差别（为什么必须换掉）
//
// | | 自研（已实现并验过） | 复刻（本模块） |
// |---|---|---|
// | 传输 | 我们自己的 SSE + 长轮询纯隧道 | 它的 WebSocket + 三条信封 |
// | 凭据 | 我们自己的 `connectorToken`（TOFU） | OAuth 换来的 `accessToken`（60 秒提前刷新） |
// | 服务端 | 你自己跑的零依赖 Node 程序 | **它的服务端**（云或自建） |
// | 手机端 | 我们自己的手机页面 | **它的 Web App** |
// ============================================================

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex as TokioMutex;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;

use super::aa_protocol::{
    build_capability_set, parse_frame, AaFrame, AaRpcNotification, AaRpcResponse, RevisionClock,
};

/// REST 换 token 的提前刷新量（`auth.py:13`）。
pub const ACCESS_TOKEN_REFRESH_SKEW_SECS: f64 = 60.0;
/// 协议里用的 API 前缀（`urls.py:5`）。
pub const API_V2_PREFIX: &str = "/api/v2";
/// 出站 WebSocket 路径（`client.py:247-248`）。
pub const CONNECTOR_WS_PATH: &str = "/api/v2/connector/ws";

/// connector 配置。字段名与它 `connector.json` 的键一致（`connector/process.ts:126-135`）。
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AaConfig {
    pub server_url: String,
    pub connector_id: String,
    pub connector_token: String,
    #[serde(default = "d20")]
    pub heartbeat_seconds: u64,
    #[serde(default = "d3")]
    pub reconnect_seconds: u64,
    #[serde(default = "dver")]
    pub connector_version: String,
}

fn d20() -> u64 {
    20
}
fn d3() -> u64 {
    3
}
fn dver() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

impl AaConfig {
    pub fn new(server_url: &str, connector_id: &str, connector_token: &str) -> Self {
        AaConfig {
            server_url: server_url.trim_end_matches('/').to_string(),
            connector_id: connector_id.to_string(),
            connector_token: connector_token.to_string(),
            heartbeat_seconds: d20(),
            reconnect_seconds: d3(),
            connector_version: dver(),
        }
    }
}

// ---------------- REST：换 access token ----------------

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
struct AuthResponse {
    access_token: String,
    expires_in: f64,
}

/// 鉴权失败的**两类**：一类可重试（网络），一类**不可重试**（凭据失效）。
///
/// 把它分开是必须的：凭据被吊销时无限重连只会一直刷日志、一直失败，
/// 而用户看到的是"一直在连"——它那边的做法就是**直接停**
/// （`client.py:169-170` "stopping"，`auth.py:16-17` "do not retry"）。
#[derive(Debug)]
pub enum AaError {
    /// 可以重试（网络、5xx、超时）
    Retryable(String),
    /// 不可重试（401 / 凭据被吊销）——必须**停**并如实报告
    CredentialsRevoked(String),
}

impl std::fmt::Display for AaError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AaError::Retryable(m) => write!(f, "{}", m),
            AaError::CredentialsRevoked(m) => write!(f, "{}", m),
        }
    }
}

fn api_v2_url(server_url: &str, path: &str) -> String {
    format!("{}{}", server_url.trim_end_matches('/'), path)
}

/// `ws(s)://host/api/v2/connector/ws`（`urls.py:24-27`）。
pub fn ws_url(server_url: &str, path: &str) -> Result<String, String> {
    let u = url::Url::parse(server_url).map_err(|e| format!("server_url 不合法: {}", e))?;
    let scheme = if u.scheme() == "https" { "wss" } else { "ws" };
    let host = u.host_str().ok_or("server_url 没有主机名")?;
    let port = u.port().map(|p| format!(":{}", p)).unwrap_or_default();
    Ok(format!("{}://{}{}{}", scheme, host, port, path))
}

/// 设备 OS 标记（`urls.py:19-26`）。
pub fn device_os() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    }
}

/// 换 access token。401 ⇒ `CredentialsRevoked`（不可重试）。
pub async fn fetch_access_token(
    client: &reqwest::Client,
    cfg: &AaConfig,
) -> Result<(String, f64), AaError> {
    let resp = client
        .post(api_v2_url(
            &cfg.server_url,
            &format!("{}/connector/auth", API_V2_PREFIX),
        ))
        .header(
            "Authorization",
            format!("Connector {}:{}", cfg.connector_id, cfg.connector_token),
        )
        .send()
        .await
        .map_err(|e| AaError::Retryable(format!("连服务端失败: {}", e)))?;
    let status = resp.status();
    if status.as_u16() == 401 {
        return Err(AaError::CredentialsRevoked(
            "本机设备凭据已失效（服务端返回 401），需要重新配对/授权".into(),
        ));
    }
    if !status.is_success() {
        return Err(AaError::Retryable(format!(
            "换 token 失败（HTTP {}）",
            status.as_u16()
        )));
    }
    let body: AuthResponse = resp
        .json()
        .await
        .map_err(|e| AaError::Retryable(format!("token 响应不可解析: {}", e)))?;
    if body.access_token.is_empty() {
        return Err(AaError::Retryable("服务端返回了空 accessToken".into()));
    }
    Ok((body.access_token, body.expires_in))
}

/// access token 的**带提前刷新**缓存（`auth.py:74-83`）。
pub struct AccessTokenCache {
    token: Option<String>,
    expires_at_ms: u64,
}

impl Default for AccessTokenCache {
    fn default() -> Self {
        Self::new()
    }
}

impl AccessTokenCache {
    pub fn new() -> Self {
        AccessTokenCache {
            token: None,
            expires_at_ms: 0,
        }
    }

    /// 还能用吗？判据是"**离到期还有 60 秒以上**"（不是"还没到期"）。
    pub fn is_fresh(&self, now_ms: u64) -> bool {
        match &self.token {
            None => false,
            // ⚠️ 括号必须留着：`as` 的优先级高于 `<`，不加括号会被解析成
            // `(x as u64 < y)`（编译错），而不是"先转成 u64 再比较"。
            Some(_) => now_ms + ((ACCESS_TOKEN_REFRESH_SKEW_SECS * 1000.0) as u64) < self.expires_at_ms,
        }
    }

    pub fn store(&mut self, token: String, expires_in_secs: f64, now_ms: u64) {
        self.expires_at_ms = now_ms + (expires_in_secs.max(0.0) * 1000.0) as u64;
        self.token = Some(token);
    }

    pub fn get(&self) -> Option<&str> {
        self.token.as_deref()
    }
}

// ---------------- 方法 → 本机上游的映射（R5 的骨架）----------------

/// 把一个 AA 协议方法映射成本机回环上游的一次 HTTP 调用。
///
/// 这一层是"复刻"的**接缝**：左边是它的方法名与参数形状，右边是我们已有的能力面
/// （阶段 0/1/2/4 建的那些路由）。两侧都不改，只在这里改名与改形状。
#[derive(Debug, Clone, PartialEq)]
pub struct LocalCall {
    pub method: String, // GET | POST
    pub path: String,
    pub query: String,
    pub body: String,
}

/// 未实现的方法要**明确回报**，不能假装成功。
pub fn map_aa_method_to_local(method: &str, params: &serde_json::Value) -> Option<LocalCall> {
    let p = params.as_object();
    let s = |k: &str| -> String {
        p.and_then(|m| m.get(k))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string()
    };
    match method {
        // 会话清单（我们的会话列表路由）
        "session.discover" | "session.inventory.begin" => Some(LocalCall {
            method: "GET".into(),
            path: "/api/sessions".into(),
            query: String::new(),
            body: String::new(),
        }),
        // 单会话状态（我们的运行态路由）
        "session.state" => {
            let id = s("sessionId");
            Some(LocalCall {
                method: "GET".into(),
                path: format!("/api/sessions/{}/run", urlencode(&id)),
                query: String::new(),
                body: String::new(),
            })
        }
        // 时间线（我们的消息路由）
        "timeline.sync" => {
            let id = s("sessionId");
            Some(LocalCall {
                method: "GET".into(),
                path: format!("/api/sessions/{}/messages", urlencode(&id)),
                query: "?limit=200".into(),
                body: String::new(),
            })
        }
        // 目录
        "catalog.model" | "catalog.permission" => Some(LocalCall {
            method: "GET".into(),
            path: "/api/catalog".into(),
            query: if s("sessionId").is_empty() {
                String::new()
            } else {
                format!("?sessionId={}", urlencode(&s("sessionId")))
            },
            body: String::new(),
        }),
        // 选择（模型/权限档）
        "session.selections.update" => Some(LocalCall {
            method: "POST".into(),
            path: "/api/selections".into(),
            query: String::new(),
            body: params.to_string(),
        }),
        // 中断
        "session.interrupt" => {
            let id = s("sessionId");
            Some(LocalCall {
                method: "POST".into(),
                path: "/api/chat/cancel".into(),
                query: String::new(),
                body: serde_json::json!({ "sessionId": id }).to_string(),
            })
        }
        // 审批（它的交互模型 → 我们的审批代理）
        "session.interaction.approval" => {
            let id = s("noticeId");
            let action = s("actionId");
            // 它的动作名与我们的动作名不同，这里做**显式**映射而不是猜
            let ours = match action.as_str() {
                "allow" | "approve" | "allow_once" => "allow",
                "deny" | "reject" => "deny",
                _ => "",
            };
            if ours.is_empty() {
                return None; // 不认识的动作 ⇒ 不猜，回报未实现
            }
            Some(LocalCall {
                method: "POST".into(),
                path: format!("/api/approvals/{}", urlencode(&id)),
                query: String::new(),
                body: serde_json::json!({ "action": ours }).to_string(),
            })
        }
        // 会话通知列表（我们还没有对应路由 ⇒ 明确未实现）
        _ => None,
    }
}

fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

// ---------------- 运行时状态 ----------------

#[derive(Default)]
pub struct AaStateInner {
    pub running: bool,
    pub connected: bool,
    pub config: Option<AaConfig>,
    pub last_error: Option<String>,
    /// 凭据被吊销 ⇒ 不再重连（界面据此告诉用户"要重新授权"，而不是"正在重连"）
    pub credentials_revoked: bool,
    pub last_heartbeat_ms: i64,
    pub requests_served: u64,
    pub errors: u64,
    pub reconnects: u64,
    pub capabilities_revision: u64,
}

pub struct AaConnectorState {
    pub inner: TokioMutex<AaStateInner>,
    /// 单调时钟（能力集/目录的 revision 都从这里取）
    pub clock: TokioMutex<RevisionClock>,
}

impl AaConnectorState {
    pub fn new() -> Arc<Self> {
        Arc::new(AaConnectorState {
            inner: TokioMutex::new(AaStateInner::default()),
            clock: TokioMutex::new(RevisionClock::new()),
        })
    }
}

/// 把一条本地调用转给**本机回环上游**（与 LAN 边缘共用同一个上游）。
async fn forward_local(upstream_port: u16, edge_token: &str, call: &LocalCall) -> Result<(u16, Vec<(String, String)>, Vec<u8>), String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let target = format!("{}{}", call.path, call.query);
    let mut head = format!("{} {} HTTP/1.1\r\n", call.method, target);
    head.push_str("Host: 127.0.0.1\r\nConnection: close\r\n");
    if !call.body.is_empty() {
        head.push_str("Content-Type: application/json\r\n");
        head.push_str(&format!("Content-Length: {}\r\n", call.body.len()));
    }
    // 上游只认带本次运行边缘标记的请求（阶段 1）
    head.push_str(&format!("{}: {}\r\n", super::guard::EDGE_HEADER, edge_token));
    head.push_str("\r\n");

    let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", upstream_port))
        .await
        .map_err(|e| format!("连本机上游失败: {}", e))?;
    stream.write_all(head.as_bytes()).await.map_err(|e| e.to_string())?;
    if !call.body.is_empty() {
        stream.write_all(call.body.as_bytes()).await.map_err(|e| e.to_string())?;
    }
    let _ = stream.flush().await;
    let mut raw = Vec::new();
    let mut chunk = [0u8; 16384];
    loop {
        match stream.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                raw.extend_from_slice(&chunk[..n]);
                if raw.len() > super::MAX_REQUEST_BYTES {
                    break;
                }
            }
        }
    }
    super::connector::parse_http_response(&raw).ok_or_else(|| "上游响应无法解析".to_string())
}

/// 一次"连上并服务"的完整过程。返回 `Ok(())` 表示连接断了需要重连；
/// 返回 `Err(CredentialsRevoked)` 表示**不许重连**。
async fn run_once(
    st: Arc<super::PhoneState>,
    cs: Arc<AaConnectorState>,
    cfg: AaConfig,
    client: reqwest::Client,
) -> Result<(), AaError> {
    // 1) 换 token
    let (token, expires_in) = fetch_access_token(&client, &cfg).await?;
    {
        let mut g = cs.inner.lock().await;
        g.last_error = None;
    }
    let mut cache = AccessTokenCache::new();
    cache.store(token.clone(), expires_in, super::now_ms() as u64);

    // 2) 连 WS
    let url = ws_url(&cfg.server_url, CONNECTOR_WS_PATH)
        .map_err(|e| AaError::Retryable(e))?;
    let mut req = url
        .clone()
        .into_client_request()
        .map_err(|e| AaError::Retryable(format!("构造 WS 请求失败: {}", e)))?;
    req.headers_mut().insert(
        "Authorization",
        format!("Bearer {}", token)
            .parse()
            .map_err(|_| AaError::Retryable("Authorization 头不合法".into()))?,
    );
    req.headers_mut().insert(
        "X-Device-OS",
        device_os()
            .parse()
            .map_err(|_| AaError::Retryable("X-Device-OS 头不合法".into()))?,
    );

    let (ws, _resp) = tokio_tungstenite::connect_async(req)
        .await
        .map_err(|e| AaError::Retryable(format!("连 WS 失败: {}", e)))?;
    let (mut sink, mut stream) = ws.split();
    {
        let mut g = cs.inner.lock().await;
        g.connected = true;
        g.last_error = None;
        g.credentials_revoked = false;
        g.last_heartbeat_ms = super::now_ms();
    }

    // 3) 发布能力集（`client.py:295-305`）
    let rev = {
        let mut c = cs.clock.lock().await;
        c.next()
    };
    let caps = build_capability_set(rev, "dsh");
    {
        let mut g = cs.inner.lock().await;
        g.capabilities_revision = rev;
    }
    let n = AaRpcNotification::new(
        "protocol.capabilitiesUpdated",
        serde_json::to_value(&caps).unwrap_or(serde_json::json!({})),
    );
    sink.send(Message::Text(serde_json::to_string(&n).unwrap().into()))
        .await
        .map_err(|e| AaError::Retryable(format!("发能力集失败: {}", e)))?;

    // 4) 心跳：**先立刻发一次**再睡（`client.py:384-387`）
    let hb = {
        let hb_secs = cfg.heartbeat_seconds.max(1);
        let cs2 = cs.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(hb_secs)).await;
                let mut g = cs2.inner.lock().await;
                if !g.running {
                    break;
                }
                g.last_heartbeat_ms = super::now_ms();
            }
        })
    };

    // 5) 读循环
    let mut hb_tick = tokio::time::interval(Duration::from_secs(cfg.heartbeat_seconds.max(1)));
    let result: Result<(), AaError> = loop {
        tokio::select! {
            _ = hb_tick.tick() => {
                let n = AaRpcNotification::new("connector.heartbeat", serde_json::json!({}));
                if let Err(e) = sink.send(Message::Text(serde_json::to_string(&n).unwrap().into())).await {
                    break Err(AaError::Retryable(format!("发心跳失败: {}", e)));
                }
                let mut g = cs.inner.lock().await;
                g.last_heartbeat_ms = super::now_ms();
            }
            msg = stream.next() => {
                match msg {
                    None => break Ok(()),
                    Some(Err(e)) => break Err(AaError::Retryable(format!("WS 读失败: {}", e))),
                    Some(Ok(Message::Close(frame))) => {
                        // 用它约定的关闭码判断"凭据无效" ⇒ 不再重连（`client.py:169-170`）
                        let code = frame.as_ref().map(|f| u16::from(f.code)).unwrap_or(0);
                        if code == 4401 || code == 4403 {
                            break Err(AaError::CredentialsRevoked(format!("服务端以 {} 关闭连接（凭据无效）", code)));
                        }
                        break Ok(());
                    }
                    Some(Ok(Message::Text(txt))) => {
                        match parse_frame(&txt) {
                            Err(e) => {
                                let mut g = cs.inner.lock().await;
                                g.errors += 1;
                                g.last_error = Some(format!("收到无法解析的帧: {}", e));
                            }
                            Ok(AaFrame::Notification(_)) => { /* 服务端通知：暂无需要处理的 */ }
                            Ok(AaFrame::Response(_)) => { /* 我们没发请求，忽略 */ }
                            Ok(AaFrame::Request(req)) => {
                                let resp = handle_request(&st, &req.id, &req.method, &req.params, &cs).await;
                                if let Err(e) = sink.send(Message::Text(serde_json::to_string(&resp).unwrap().into())).await {
                                    break Err(AaError::Retryable(format!("回执发送失败: {}", e)));
                                }
                            }
                        }
                    }
                    Some(Ok(_)) => { /* ping/pong/binary：忽略 */ }
                }
            }
        }
    };
    hb.abort();
    {
        let mut g = cs.inner.lock().await;
        g.connected = false;
    }
    let _ = cache; // token 缓存在重连时重建（每次 run_once 都 force 换新）
    result
}

/// 处理一条服务端请求：映射 → 转上游 → 包成它的应答帧。
async fn handle_request(
    st: &Arc<super::PhoneState>,
    id: &str,
    method: &str,
    params: &serde_json::Value,
    cs: &Arc<AaConnectorState>,
) -> AaRpcResponse {
    let Some(call) = map_aa_method_to_local(method, params) else {
        // **不假装成功**：明确回报不支持（服务端据此可以把这条能力标成不可用）
        let mut err = BTreeMap::new();
        err.insert("code".to_string(), "method_not_supported".to_string());
        err.insert("message".to_string(), format!("Codem 未实现该方法: {}", method));
        cs.inner.lock().await.errors += 1;
        return AaRpcResponse::err(id, err);
    };
    let (upstream_port, edge_token, running) = {
        let g = st.inner.lock().await;
        (g.upstream_port, g.edge_token.clone(), g.running)
    };
    if !running || upstream_port == 0 {
        let mut err = BTreeMap::new();
        err.insert("code".to_string(), "engine_unavailable".to_string());
        err.insert("message".to_string(), "本机服务未运行".to_string());
        return AaRpcResponse::err(id, err);
    }
    match forward_local(upstream_port, &edge_token, &call).await {
        Ok((status, _headers, body)) => {
            let parsed: serde_json::Value =
                serde_json::from_slice(&body).unwrap_or(serde_json::json!({ "raw": String::from_utf8_lossy(&body) }));
            cs.inner.lock().await.requests_served += 1;
            if status >= 400 {
                let mut err = BTreeMap::new();
                err.insert("code".to_string(), format!("http_{}", status));
                err.insert("message".to_string(), parsed.to_string());
                return AaRpcResponse::err(id, err);
            }
            AaRpcResponse::ok(id, parsed)
        }
        Err(e) => {
            let mut err = BTreeMap::new();
            err.insert("code".to_string(), "upstream_failed".to_string());
            err.insert("message".to_string(), e.clone());
            let mut g = cs.inner.lock().await;
            g.errors += 1;
            g.last_error = Some(e);
            AaRpcResponse::err(id, err)
        }
    }
}

/// 启动（幂等）。**凭据失效时不重连**。
pub async fn start(
    st: Arc<super::PhoneState>,
    cs: Arc<AaConnectorState>,
    cfg: AaConfig,
) -> Result<(), String> {
    if cfg.server_url.trim().is_empty() {
        return Err("服务端地址为空".into());
    }
    {
        let mut g = cs.inner.lock().await;
        if g.running {
            return Ok(());
        }
        g.running = true;
        g.connected = false;
        g.last_error = None;
        g.credentials_revoked = false;
        g.config = Some(cfg.clone());
    }
    let cs2 = cs.clone();
    let st2 = st.clone();
    let client = reqwest::Client::builder()
        .build()
        .map_err(|e| format!("构造 HTTP 客户端失败: {}", e))?;
    tauri::async_runtime::spawn(async move {
        loop {
            {
                let g = cs2.inner.lock().await;
                if !g.running {
                    break;
                }
            }
            match run_once(st2.clone(), cs2.clone(), cfg.clone(), client.clone()).await {
                Ok(()) => {
                    cs2.inner.lock().await.connected = false;
                }
                Err(AaError::CredentialsRevoked(msg)) => {
                    // **停**：一直重连只会无限失败，而用户看到的是"一直在连"
                    let mut g = cs2.inner.lock().await;
                    g.connected = false;
                    g.credentials_revoked = true;
                    g.running = false;
                    g.last_error = Some(msg);
                    break;
                }
                Err(AaError::Retryable(msg)) => {
                    let mut g = cs2.inner.lock().await;
                    g.connected = false;
                    g.last_error = Some(msg);
                }
            }
            let backoff = {
                let mut g = cs2.inner.lock().await;
                if !g.running {
                    break;
                }
                g.reconnects += 1;
                cfg.reconnect_seconds.max(1)
            };
            tokio::time::sleep(Duration::from_secs(backoff)).await;
        }
        let mut g = cs2.inner.lock().await;
        g.connected = false;
    });
    Ok(())
}

/// 停止。
pub async fn stop(cs: Arc<AaConnectorState>) {
    let mut g = cs.inner.lock().await;
    g.running = false;
    g.connected = false;
}

/// 状态快照。
pub async fn snapshot(cs: Arc<AaConnectorState>) -> serde_json::Value {
    let g = cs.inner.lock().await;
    serde_json::json!({
        "running": g.running,
        "connected": g.connected,
        "serverUrl": g.config.as_ref().map(|c| c.server_url.clone()).unwrap_or_default(),
        "connectorId": g.config.as_ref().map(|c| c.connector_id.clone()).unwrap_or_default(),
        "lastError": g.last_error,
        "credentialsRevoked": g.credentials_revoked,
        "requestsServed": g.requests_served,
        "errors": g.errors,
        "reconnects": g.reconnects,
        "capabilitiesRevision": g.capabilities_revision,
        "heartbeatSeconds": g.config.as_ref().map(|c| c.heartbeat_seconds).unwrap_or(20),
        "reconnectSeconds": g.config.as_ref().map(|c| c.reconnect_seconds).unwrap_or(3),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ws_url_switches_scheme_like_python() {
        assert_eq!(
            ws_url("https://web.agents-anywhere.com", CONNECTOR_WS_PATH).unwrap(),
            "wss://web.agents-anywhere.com/api/v2/connector/ws"
        );
        assert_eq!(
            ws_url("http://127.0.0.1:8080", CONNECTOR_WS_PATH).unwrap(),
            "ws://127.0.0.1:8080/api/v2/connector/ws"
        );
        assert_eq!(
            ws_url("https://example.com:8443", "/x").unwrap(),
            "wss://example.com:8443/x"
        );
        // 末尾斜杠不影响
        assert_eq!(
            ws_url("https://example.com/", "/x").unwrap(),
            "wss://example.com/x"
        );
        assert!(ws_url("not a url", "/x").is_err());
    }

    #[test]
    fn rest_url_uses_the_v2_prefix() {
        assert_eq!(
            api_v2_url("https://example.com/", "/api/v2/connector/auth"),
            "https://example.com/api/v2/connector/auth"
        );
    }

    #[test]
    fn token_cache_refreshes_60s_before_expiry() {
        let mut c = AccessTokenCache::new();
        assert!(!c.is_fresh(0), "没有 token 时不算新鲜");
        // 100 秒有效期，从 t=0 开始
        c.store("tok".into(), 100.0, 0);
        assert_eq!(c.get(), Some("tok"));
        // 还剩 61 秒 ⇒ 仍算新鲜
        assert!(c.is_fresh(39_000));
        // 还剩正好 60 秒 ⇒ **不算**（边界：要"大于 60"）
        assert!(!c.is_fresh(40_000));
        // 还剩 59 秒 ⇒ 不算
        assert!(!c.is_fresh(41_000));
        // 已过期 ⇒ 不算
        assert!(!c.is_fresh(100_001));
    }

    #[test]
    fn device_os_is_one_of_the_three() {
        assert!(["windows", "macos", "linux"].contains(&device_os()));
    }

    #[test]
    fn method_mapping_covers_our_real_capabilities() {
        // 会话清单
        let c = map_aa_method_to_local("session.discover", &serde_json::json!({})).unwrap();
        assert_eq!(c.method, "GET");
        assert_eq!(c.path, "/api/sessions");
        // 中断
        let c = map_aa_method_to_local(
            "session.interrupt",
            &serde_json::json!({"sessionId":"s 1"}),
        )
        .unwrap();
        assert_eq!(c.method, "POST");
        assert_eq!(c.path, "/api/chat/cancel");
        assert!(c.body.contains("s 1"), "body 应带上会话 id：{}", c.body);
        // 时间线
        let c = map_aa_method_to_local("timeline.sync", &serde_json::json!({"sessionId":"s1"})).unwrap();
        assert_eq!(c.path, "/api/sessions/s1/messages");
        // 选择
        let c = map_aa_method_to_local(
            "session.selections.update",
            &serde_json::json!({"sessionId":"s1","model":"m"}),
        )
        .unwrap();
        assert_eq!(c.path, "/api/selections");
        // 审批：它那边的动作名要**显式**映射到我们的
        let c = map_aa_method_to_local(
            "session.interaction.approval",
            &serde_json::json!({"noticeId":"n1","actionId":"reject"}),
        )
        .unwrap();
        assert_eq!(c.path, "/api/approvals/n1");
        assert!(c.body.contains("\"action\":\"deny\""), "reject 应映射成 deny：{}", c.body);
        // **不认识的动作不许猜**
        assert!(map_aa_method_to_local(
            "session.interaction.approval",
            &serde_json::json!({"noticeId":"n1","actionId":"whatever"})
        )
        .is_none());
        // 未实现的方法必须返回 None（⇒ 上游会回 method_not_supported，而不是假装成功）
        assert!(map_aa_method_to_local("terminal.create", &serde_json::json!({})).is_none());
        assert!(map_aa_method_to_local("fs.readText", &serde_json::json!({})).is_none());
        assert!(map_aa_method_to_local("no.such.method", &serde_json::json!({})).is_none());
    }

    #[test]
    fn credentials_revoked_is_distinguishable_from_retryable() {
        // 这个区分是**必须**的：401 若被当成"可重试"，就会无限重连、
        // 一直失败，而用户看到的是"一直在连"。
        let r = AaError::Retryable("net".into());
        let c = AaError::CredentialsRevoked("401".into());
        assert!(matches!(r, AaError::Retryable(_)));
        assert!(matches!(c, AaError::CredentialsRevoked(_)));
        assert_eq!(format!("{}", c), "401");
    }

    #[test]
    fn config_roundtrips_the_aa_field_names() {
        let cfg = AaConfig::new("https://r.example.com/", "cn-1", "tok");
        let js = serde_json::to_string(&cfg).unwrap();
        for k in [
            "serverUrl",
            "connectorId",
            "connectorToken",
            "heartbeatSeconds",
            "reconnectSeconds",
        ] {
            assert!(js.contains(&format!("\"{}\"", k)), "缺字段 {}：{}", k, js);
        }
        assert_eq!(cfg.server_url, "https://r.example.com");
        assert_eq!(cfg.heartbeat_seconds, 20);
        assert_eq!(cfg.reconnect_seconds, 3);
    }
}
