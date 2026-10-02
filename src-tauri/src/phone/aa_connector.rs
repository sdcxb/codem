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

/// 它的 `auth.py:13` 有一个 **60 秒提前刷新量**，配一个 access token 缓存。
///
/// ⚠️ 我们**没有**实现那个缓存，因此**不留一个没人用的常量**。
///
/// 原因具体：它那个缓存服务于"**同一个连接内**还要发 REST 请求"的场景
/// （`client.py:113` 把 `ensure_access_token` 交给下载/上传用）。
/// 而我们连接建立起之后**不再发 REST 请求** —— 每次 `run_once` 都是
/// `force=True` 强刷一次（与它 `client.py:246` 一致）。
/// 没有"连接内复用"，那个 60 秒就没有落点。
///
/// （这段是记档：先前我实现过 `AccessTokenCache` 并写了判据，
/// 但它在生产路径上**一次都不会被调用** —— 那种判据给的是**假安慰**，
/// 所以连缓存带那条判据一起删了。）

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

/// 一个方法的处置结果。
///
/// 为什么不用 `Option<LocalCall>`（第一版就是）：那样"本机就能回答"与
/// "我们不做这个方法"**都是 `None`**，调用方分不清。而这两件事对服务端
/// 是**相反的**信号 —— 前者是"我们支持"，后者是"我们没有这个能力"。
#[derive(Debug, Clone, PartialEq)]
pub enum AaDispatch {
    /// 转给本机回环上游
    Local(LocalCall),
    /// 本机直接回答（不需要上游）
    Inline(serde_json::Value),
    /// 我们不做这个方法 —— 要**如实回报**，不能假装成功
    Unsupported,
}

impl AaDispatch {
    /// 取本地调用（**判据用**：生产路径走的是 `match`，不需要这两个便捷方法）。
    #[cfg(test)]
    pub fn local(self) -> Option<LocalCall> {
        match self {
            AaDispatch::Local(c) => Some(c),
            _ => None,
        }
    }
    /// 是不是"我们不做这个方法"（**判据用**）。
    #[cfg(test)]
    pub fn is_unsupported(&self) -> bool {
        matches!(self, AaDispatch::Unsupported)
    }
}

/// 它的入站方法全集（`server/runtime_rpc.py:54-77` 的 `METHODS`）。
///
/// 记在这里是为了能**逐条核对**：任何一条既不在映射里、也不在"明确不做"清单里的
/// 方法，都是漏网之鱼。判据会把两个集合的并集与这张表比对。
pub const AA_INBOUND_METHODS: &[&str] = &[
    "runtime.discover",
    "runtime.configSchema",
    "runtime.config",
    "runtime.validateConfig",
    "runtime.start",
    "runtime.stop",
    "runtime.capabilities",
    "runtime.commands",
    "runtime.modelCatalog",
    "runtime.permissionCatalog",
    "session.discover",
    "session.create",
    "session.sync",
    "session.state",
    "session.capabilities",
    "session.notices",
    "session.selections.update",
    "session.commands",
    "session.command.execute",
    "interaction.respond",
    "session.send_message",
    "session.steer",
    "session.interrupt",
];

/// 我们**明确不做**的入站方法，以及理由。
///
/// 每一个都要有理由 —— "不做"必须是个决定，不是遗漏。
pub const AA_UNSUPPORTED: &[(&str, &str)] = &[    ("runtime.configSchema", "Codem 的运行时是进程内的，没有可下发配置的 schema"),
    ("runtime.config", "同上：没有运行时可配置项"),
    ("runtime.validateConfig", "同上"),
    ("runtime.start", "运行时由应用自身启动，远端不能拉起一个运行时"),
    ("runtime.stop", "同上：远端不能停掉本机运行时"),
    ("runtime.commands", "我们没有运行时可发现的命令集"),
    ("session.steer", "Codem 暂时没有转向（steer）语义"),
    ("session.commands", "同上：没有斜杠命令集"),
    ("session.command.execute", "同上"),
    ("session.capabilities", "会话级能力我们尚未逐会话上报（目前只报运行时级）"),
    ("runtime.capabilities", "能力集通过 protocol.capabilitiesUpdated 通知推送，不走这条请求"),
    ("runtime.modelCatalog", "目录走 catalog.model（能力表里登记的也是它）"),
    ("runtime.permissionCatalog", "目录走 catalog.permission"),
];

/// 把一个 AA 协议方法映射成本机动作。
///
/// 这一层是"复刻"的**接缝**：左边是它的方法名与参数形状，右边是我们已有的能力面
/// （阶段 0/1/2/4 建的那些路由）。两侧都不改，只在这里改名与改形状。
pub fn map_aa_method_to_local(method: &str, params: &serde_json::Value) -> AaDispatch {
    let p = params.as_object();
    let s = |k: &str| -> String {
        p.and_then(|m| m.get(k))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string()
    };
    match method {
        // ---- 运行时发现：本机合成（我们只有一个 dsh 运行时）----
        "runtime.discover" => AaDispatch::Inline(serde_json::json!({
            "runtimes": [{
                "runtime": "dsh",
                "runtimeVersion": env!("CARGO_PKG_VERSION"),
                "displayName": "Codem / DSH",
            }],
        })),

        // ---- 会话清单 ----
        "session.discover" => AaDispatch::Local(LocalCall {
            method: "GET".into(),
            path: "/api/sessions".into(),
            query: String::new(),
            body: String::new(),
        }),

        // ---- 新建会话 ----
        //
        // 它的参数是 `{sessionId, content, title?, cwd?, ...}`（`SessionCreateParams`）。
        // ⚠️ 它**指定** sessionId，而我们原来的 `/api/chat/new` 是**自己生成** id 的。
        // 那是真实的协议不一致（调用方按它给的 id 去查，会查不到），
        // 所以 `chat_new` 已经改成"给了就用给的"。
        "session.create" => {
            let mut body = serde_json::Map::new();
            body.insert("sessionId".into(), serde_json::json!(s("sessionId")));
            body.insert("text".into(), serde_json::json!(s("content")));
            // 标题是可选参数；没给就**不传**（让本机用自己的缺省标题，
            // 而不是传一个空串把标题覆盖成空）
            if !s("title").is_empty() {
                body.insert("title".into(), serde_json::json!(s("title")));
            }
            AaDispatch::Local(LocalCall {
                method: "POST".into(),
                path: "/api/chat/new".into(),
                query: String::new(),
                body: serde_json::Value::Object(body).to_string(),
            })
        }

        // ---- 单会话状态 ----
        "session.state" => {
            let id = s("sessionId");
            AaDispatch::Local(LocalCall {
                method: "GET".into(),
                path: format!("/api/sessions/{}/run", urlencode(&id)),
                query: String::new(),
                body: String::new(),
            })
        }

        // ---- 时间线（它的 `session.sync` 与通知 `timeline.sync` 都读这一份）----
        "session.sync" | "timeline.sync" => {
            let id = s("sessionId");
            AaDispatch::Local(LocalCall {
                method: "GET".into(),
                path: format!("/api/sessions/{}/messages", urlencode(&id)),
                query: "?limit=200".into(),
                body: String::new(),
            })
        }

        // ---- 会话通知（阶段 R4 那条按它形状产出的通知）----
        "session.notices" => {
            let id = s("sessionId");
            AaDispatch::Local(LocalCall {
                method: "GET".into(),
                path: "/api/notices".into(),
                query: if id.is_empty() {
                    String::new()
                } else {
                    format!("?sessionId={}", urlencode(&id))
                },
                body: String::new(),
            })
        }

        // ---- 目录 ----
        "catalog.model" | "catalog.permission" => AaDispatch::Local(LocalCall {
            method: "GET".into(),
            path: "/api/catalog".into(),
            query: if s("sessionId").is_empty() {
                String::new()
            } else {
                format!("?sessionId={}", urlencode(&s("sessionId")))
            },
            body: String::new(),
        }),

        // ---- 选择（模型/权限档）----
        //
        // 它的参数是 `{sessionId, externalSessionId?, selections: {model?, permission?}}`
        // （`SessionSelectionUpdateParams`）。我们的路由吃 `{sessionId, model?, securityMode?}`，
        // 所以这里要做**形状翻译** —— 而且翻译是安全的：我们的路由在 R3'
        // 已经能解析 `dsh:model:` / `dsh:permission:` 两种写法。
        "session.selections.update" => {
            let sel = p
                .and_then(|m| m.get("selections"))
                .and_then(|v| v.as_object())
                .cloned()
                .unwrap_or_default();
            let mut body = serde_json::Map::new();
            body.insert("sessionId".into(), serde_json::json!(s("sessionId")));
            if let Some(m) = sel.get("model") {
                if let Some(v) = m.as_str() {
                    body.insert("model".into(), serde_json::json!(v));
                }
            }
            if let Some(m) = sel.get("permission") {
                if let Some(v) = m.as_str() {
                    body.insert("securityMode".into(), serde_json::json!(v));
                }
            }
            AaDispatch::Local(LocalCall {
                method: "POST".into(),
                path: "/api/selections".into(),
                query: String::new(),
                body: serde_json::Value::Object(body).to_string(),
            })
        }

        // ---- 发消息（它的 `TurnStartParams`）----
        "session.send_message" => AaDispatch::Local(LocalCall {
            method: "POST".into(),
            path: "/api/chat".into(),
            query: String::new(),
            body: serde_json::json!({
                "sessionId": s("sessionId"),
                "text": s("content"),
            })
            .to_string(),
        }),

        // ---- 中断 ----
        "session.interrupt" => {
            let id = s("sessionId");
            AaDispatch::Local(LocalCall {
                method: "POST".into(),
                path: "/api/chat/cancel".into(),
                query: String::new(),
                body: serde_json::json!({ "sessionId": id }).to_string(),
            })
        }

        // ---- 交互回答（**审批的真正入站方法**）----
        //
        // ⚠️ 这里是本轮最要紧的一处修正。
        //
        // 我前两轮一直把 `session.interaction.approval` 当成"回答审批"的方法 ——
        // **那是错的**。读了它 `runtime_rpc.py:54-77` 的 `METHODS` 才知道：
        //   * 入站请求方法叫 **`interaction.respond`**（`InteractionRespondParams`：
        //     `{sessionId, noticeId, actionId, inputData?}`）
        //   * `session.interaction.approval` 是**能力表里的标签/通知方法**，不是入站请求
        // 也就是说：如果照我原来的写法，服务端发来的回答**根本不会被处理** ——
        // 手机点了"允许"会石沉大海，而日志上看不出任何异常。
        "interaction.respond" => {
            let id = s("noticeId");
            let action = s("actionId");
            // 它那两个动作 id 必须**逐字**如此：`allow-once` / `reject`
            // （`host/dsh-runtime/approvals.ts:71-72`）。我第一版凭印象写成
            // `allow|approve|allow_once` —— 那是猜的，猜错的后果是远端点"允许"
            // 却收到一句"未知的批准操作"。
            let ours = match action.as_str() {
                "allow-once" => "allow",
                "reject" => "deny",
                _ => "",
            };
            if ours.is_empty() {
                return AaDispatch::Unsupported; // 不认识的动作 ⇒ 不猜
            }
            AaDispatch::Local(LocalCall {
                method: "POST".into(),
                path: format!("/api/approvals/{}", urlencode(&id)),
                query: String::new(),
                body: serde_json::json!({ "action": ours }).to_string(),
            })
        }

        // ---- 明确不做 ----
        other => {
            if AA_UNSUPPORTED.iter().any(|(m, _)| *m == other) {
                AaDispatch::Unsupported
            } else if AA_INBOUND_METHODS.contains(&other) || other.starts_with("catalog.") {
                // 在它的方法表里、但既没映射也没登记 ⇒ 归类为"不做"（判据会拦住这种遗漏）
                AaDispatch::Unsupported
            } else {
                AaDispatch::Unsupported
            }
        }
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
    let _ = expires_in; // 我们不强刷缓存，见 AA_NO_TOKEN_CACHE 的说明

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
    let call = match map_aa_method_to_local(method, params) {
        AaDispatch::Local(c) => c,
        // 本机直接回答（不需要上游）。
        //
        // 这类方法**不能**走 `Unsupported`：服务端据此判断"这个连接器有没有运行时"，
        // 报不支持会让它把我们当成空连接器。
        AaDispatch::Inline(v) => {
            cs.inner.lock().await.requests_served += 1;
            return AaRpcResponse::ok(id, v);
        }
        // **不假装成功**：明确回报不支持（服务端据此可以把这条能力标成不可用）
        AaDispatch::Unsupported => {
            let mut err = BTreeMap::new();
            err.insert("code".to_string(), "method_not_supported".to_string());
            err.insert("message".to_string(), format!("Codem 未实现该方法: {}", method));
            cs.inner.lock().await.errors += 1;
            return AaRpcResponse::err(id, err);
        }
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
    fn device_os_is_one_of_the_three() {
        assert!(["windows", "macos", "linux"].contains(&device_os()));
    }

    #[test]
    fn method_mapping_covers_the_full_inbound_set() {
        // ---- 运行时发现：本机合成，**不能**报不支持 ----
        match map_aa_method_to_local("runtime.discover", &serde_json::json!({})) {
            AaDispatch::Inline(v) => {
                let list = v.get("runtimes").and_then(|r| r.as_array()).expect("要有 runtimes");
                assert_eq!(list.len(), 1, "我们只有一个运行时");
                assert_eq!(list[0].get("runtime").and_then(|r| r.as_str()), Some("dsh"));
            }
            other => panic!("runtime.discover 应当本机回答，实际 {:?}", other),
        }

        // ---- 会话清单 ----
        let c = map_aa_method_to_local("session.discover", &serde_json::json!({})).local().unwrap();
        assert_eq!(c.method, "GET");
        assert_eq!(c.path, "/api/sessions");

        // ---- 新建会话：它**指定** sessionId，必须带上（否则调用方按那个 id 查不到） ----
        let c = map_aa_method_to_local(
            "session.create",
            &serde_json::json!({"sessionId":"srv-1","content":"你好","title":"标题"}),
        )
        .local()
        .unwrap();
        assert_eq!(c.path, "/api/chat/new");
        assert!(c.body.contains("srv-1"), "要带上它指定的 sessionId：{}", c.body);
        assert!(c.body.contains("你好"), "content 要变成 text：{}", c.body);
        assert!(c.body.contains("标题"), "给了 title 要带上：{}", c.body);
        // 没给 title ⇒ **不传**这个键（而不是传空串把标题覆盖成空）
        let c = map_aa_method_to_local(
            "session.create",
            &serde_json::json!({"sessionId":"s2","content":"x"}),
        )
        .local()
        .unwrap();
        assert!(!c.body.contains("title"), "没给 title 就不该出现这个键：{}", c.body);

        // ---- 单会话状态 ----
        let c = map_aa_method_to_local("session.state", &serde_json::json!({"sessionId":"s1"}))
            .local()
            .unwrap();
        assert_eq!(c.path, "/api/sessions/s1/run");

        // ---- 时间线：session.sync 与通知 timeline.sync 走同一条 ----
        for m in ["session.sync", "timeline.sync"] {
            let c = map_aa_method_to_local(m, &serde_json::json!({"sessionId":"s1"})).local().unwrap();
            assert_eq!(c.path, "/api/sessions/s1/messages", "{} 应读消息路由", m);
        }

        // ---- 会话通知 ----
        let c = map_aa_method_to_local("session.notices", &serde_json::json!({"sessionId":"s1"}))
            .local()
            .unwrap();
        assert_eq!(c.path, "/api/notices");
        assert!(c.query.contains("sessionId=s1"));

        // ---- 目录 ----
        for m in ["catalog.model", "catalog.permission"] {
            let c = map_aa_method_to_local(m, &serde_json::json!({"sessionId":"s1"})).local().unwrap();
            assert_eq!(c.path, "/api/catalog", "{} 应读目录路由", m);
        }

        // ---- 选择：它的形状 {selections:{model,permission}} 要**翻译**成我们的形状 ----
        let c = map_aa_method_to_local(
            "session.selections.update",
            &serde_json::json!({"sessionId":"s1","selections":{"model":"dsh:model:AAA","permission":"dsh:permission:YXNr"}}),
        )
        .local()
        .unwrap();
        assert_eq!(c.path, "/api/selections");
        assert!(c.body.contains("dsh:model:AAA"), "model 要原样带过去（我们的路由会解码）：{}", c.body);
        assert!(c.body.contains("securityMode"), "permission 要翻成 securityMode：{}", c.body);
        assert!(c.body.contains("dsh:permission:YXNr"));
        // 只给 model 时**不该**出现 securityMode（不许顺手改权限档）
        let c = map_aa_method_to_local(
            "session.selections.update",
            &serde_json::json!({"sessionId":"s1","selections":{"model":"dsh:model:AAA"}}),
        )
        .local()
        .unwrap();
        assert!(!c.body.contains("securityMode"), "没给 permission 就不该动权限档：{}", c.body);

        // ---- 发消息 ----
        let c = map_aa_method_to_local(
            "session.send_message",
            &serde_json::json!({"sessionId":"s1","content":"hi"}),
        )
        .local()
        .unwrap();
        assert_eq!(c.path, "/api/chat");
        assert!(c.body.contains("hi"));

        // ---- 中断 ----
        let c = map_aa_method_to_local("session.interrupt", &serde_json::json!({"sessionId":"s 1"}))
            .local()
            .unwrap();
        assert_eq!(c.method, "POST");
        assert_eq!(c.path, "/api/chat/cancel");
        assert!(c.body.contains("s 1"), "body 应带上会话 id：{}", c.body);

        // ---- 交互回答：入站方法名是 interaction.respond ----
        //
        // 这条判据钉的是一个**我先前搞错的事实**：我前两轮把
        // session.interaction.approval 当成回答方法，而它其实是能力标签/通知方法。
        // 真正的入站方法是 interaction.respond（runtime_rpc.py 的 METHODS）。
        // 照我原来的写法，服务端发来的回答**根本不会被处理** ——
        // 手机点了"允许"会石沉大海，而日志上看不出任何异常。
        let c = map_aa_method_to_local(
            "interaction.respond",
            &serde_json::json!({"sessionId":"s1","noticeId":"n1","actionId":"reject"}),
        )
        .local()
        .unwrap();
        assert_eq!(c.path, "/api/approvals/n1");
        assert!(c.body.contains("\"action\":\"deny\""), "reject 应映射成 deny：{}", c.body);
        let c = map_aa_method_to_local(
            "interaction.respond",
            &serde_json::json!({"sessionId":"s1","noticeId":"n2","actionId":"allow-once"}),
        )
        .local()
        .unwrap();
        assert!(c.body.contains("\"action\":\"allow\""), "allow-once 应映射成 allow：{}", c.body);

        // 我原先那个错的方法名**不该**被当成回答来处理
        assert!(
            map_aa_method_to_local(
                "session.interaction.approval",
                &serde_json::json!({"sessionId":"s1","noticeId":"n1","actionId":"reject"})
            )
            .is_unsupported(),
            "session.interaction.approval 不是入站回答方法，不该被当成回答"
        );

        // **我们自己的内部词汇不是合法的远端动作** —— 不许当兼容别名
        for wrong in ["allow", "deny", "approve", "allow_once", "allow-always"] {
            assert!(
                map_aa_method_to_local(
                    "interaction.respond",
                    &serde_json::json!({"sessionId":"s1","noticeId":"n1","actionId":wrong})
                )
                .is_unsupported(),
                "{} 不是它的动作 id，不该被接受",
                wrong
            );
        }

        // ---- 明确不做的：必须是"不支持"，不是"假装成功" ----
        for m in ["session.steer", "session.commands", "session.command.execute", "runtime.start", "runtime.stop"] {
            assert!(map_aa_method_to_local(m, &serde_json::json!({})).is_unsupported(), "{} 应明确不支持", m);
        }
        // 完全不属于它的方法
        assert!(map_aa_method_to_local("terminal.create", &serde_json::json!({})).is_unsupported());
        assert!(map_aa_method_to_local("fs.readText", &serde_json::json!({})).is_unsupported());
        assert!(map_aa_method_to_local("no.such.method", &serde_json::json!({})).is_unsupported());
    }

    #[test]
    fn every_inbound_method_is_accounted_for() {
        // 它的入站方法表（runtime_rpc.py:54-77）里的每一条，都必须
        // **要么被映射**、**要么被登记为"明确不做"** —— 不许有漏网之鱼。
        // 漏掉一条的后果是：服务端发过来，我们回"不支持"，
        // 而看上去像"它没发过" —— 极难归因。
        let probe = serde_json::json!({"sessionId":"s1","noticeId":"n1","actionId":"allow-once"});
        for m in AA_INBOUND_METHODS {
            let d = map_aa_method_to_local(m, &probe);
            let known = !d.is_unsupported() || AA_UNSUPPORTED.iter().any(|(u, _)| u == m);
            assert!(known, "{} 既没映射也没登记为「明确不做」", m);
            // 登记过的都必须有**非空理由**
            if let Some((_, why)) = AA_UNSUPPORTED.iter().find(|(u, _)| u == m) {
                assert!(!why.trim().is_empty(), "{} 的「不做」理由不能为空", m);
            }
        }
        // 反向：登记表里的每一条都必须是它的真实方法（别登记一个不存在的）
        for (m, _) in AA_UNSUPPORTED {
            assert!(AA_INBOUND_METHODS.contains(m), "{} 不在它的入站方法表里", m);
        }
        // 方法表本身不许有重复
        let mut sorted = AA_INBOUND_METHODS.to_vec();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted.len(), AA_INBOUND_METHODS.len(), "入站方法表里有重复");
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
