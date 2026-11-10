// ============================================================
// phone/mod.rs — 桌面引擎桥（AA 用）+ AA connector 命令
//
// ## 旧 LAN 配对已删除
//
// 旧的 LAN 扫码配对/二维码/批准/设备列表/自签 CA/中继（`phone_link`）已经整块
// 删除；这里**不再有任何** `pairing` / `cookie` / `devices.json` / `0.0.0.0`
// 监听。手机远程按数据归属分成两类，互不重叠：
//   - **PC 桌面数据**：桌面网关的 6 位一次性配对码（`gateway` 子模块，
//     ADR-0005 M4 后是 PC 远程唯一入口）；
//   - **手机本机数据**：Android 自己的 `packages/host`（由设备侧前台服务拉起，
//     不在这台电脑的设置里配置）。
// 旧的桌面 `host_cmd` sidecar 已随 M4 退役。
// AA bridge 本身没有配对：它只认本次运行的内部 token。
//
// ## 保留的回环桥
//
//   AA 服务端 ──WS──▶ [AA connector] ──HTTP──▶ [127.0.0.1 bridge] ──event──▶ [WebView TS]
//                                                   ▲
//                                     每次运行随机 token（只在本进程内存）
//
// bridge 只绑 127.0.0.1；AA connector 从 `PhoneState` 拿到端口与 token，别的本机
// 进程即使知道端口也拿不到 token。没有 cookie、没有设备身份、没有静态手机页。
//
// ## 另有 PC 远程网关（子模块 `gateway`，ADR-0005）
//
// 手机远程访问**桌面数据**走 `gateway`：独立回环监听 + 独立端口，但**复用**这里
// 的 `forward_to_renderer`（`remote-request` → `remote_respond`）—— 事件名、
// 应答命令、在途表只有一份，不建第二条桥。
//
// 诚实标注：本模块不编造数据——所有会话/消息/回复来自 WebView 引擎侧；
// 引擎不在时 /api/* 返回 504。
// ============================================================

pub mod aa_account;
pub mod aa_connector;
pub mod aa_protocol;
pub mod gateway;
pub mod gateway_client;
pub mod guard;
pub mod http;

#[cfg(test)]
mod aa_live_test;
#[cfg(test)]
mod aa_mock_test;

use crate::phone::http::{
    split_request, Request as HttpRequest, Response as HttpResponse,
};
use std::collections::HashMap;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{oneshot, Mutex as TokioMutex};
use tokio::time::{timeout, Duration};

// ---- 常量 ----

const PHONE_DIR: &str = "phone";
const MAX_REQUEST_BYTES: usize = 4 * 1024 * 1024;
const PROXY_TIMEOUT: Duration = Duration::from_secs(15);
/// 单条连接的总时限（读请求 + 等渲染层 + 写响应）。网关监听复用同一个值。
pub(crate) const CONN_TIMEOUT: Duration = Duration::from_secs(25);

// ---- 状态 ----

pub struct PhoneInner {
    pub running: bool,
    /// 回环 bridge 端口（只绑 127.0.0.1）。
    pub bridge_port: u16,
    /// 每次 start 重新随机的内部 token（只存在于进程内存）。
    pub bridge_token: String,
    /// 代理到 TS 的在途请求（reqId → 应答通道）。
    pub pending: HashMap<String, oneshot::Sender<HttpResponse>>,
    pub server_handle: Option<tauri::async_runtime::JoinHandle<()>>,
}

impl Default for PhoneInner {
    fn default() -> Self {
        PhoneInner {
            running: false,
            bridge_port: 0,
            bridge_token: String::new(),
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
    buf.iter().map(|b| format!("{:02x}", b)).collect()
}

/// 常数时间字符串比较（bridge token 用）。
pub fn timing_safe_eq(a: &str, b: &str) -> bool {
    let (ab, bb) = (a.as_bytes(), b.as_bytes());
    let mut diff: u8 = 0;
    let n = ab.len().max(bb.len());
    for i in 0..n {
        let x = *ab.get(i).unwrap_or(&0);
        let y = *bb.get(i).unwrap_or(&0);
        diff |= x ^ y;
    }
    let len_eq = (ab.len() == bb.len()) as u8;
    (diff | (len_eq ^ 1)) == 0
}

// ---- 持久化（只给 AA 账号态复用）----

/// AA 账号/安装标识的持久化目录。目录名沿用 `phone/` 以避免破坏已登录用户的
/// `aa-account.json`；这里**不再**写 devices.json / TLS 证书。
pub fn phone_dir(app: &AppHandle) -> std::path::PathBuf {
    crate::app_data_dir_path(app)
        .map(|d| d.join(PHONE_DIR))
        .unwrap_or_else(|_| std::env::temp_dir().join(PHONE_DIR))
}

// ---- HTTP bridge ----

/// 从任意异步流里读一个完整 HTTP 请求（头 + Content-Length 指定的 body）。
pub(crate) async fn read_http_request<S>(stream: &mut S) -> Result<(String, Vec<u8>), ()>
where
    S: tokio::io::AsyncRead + Unpin,
{
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
            return Ok((head, buf[header_end..header_end + cl].to_vec()));
        }
    }
}

/// 在流上写一个 4xx/5xx 的纯文本响应（bridge 自己产生的错误）。
async fn write_simple<S>(stream: &mut S, status: u16, reason: &str, msg: &str) -> Result<(), ()>
where
    S: tokio::io::AsyncWrite + Unpin,
{
    let body = msg.as_bytes();
    let resp = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        status,
        reason,
        body.len()
    );
    stream.write_all(resp.as_bytes()).await.map_err(|_| ())?;
    stream.write_all(body).await.map_err(|_| ())?;
    stream.flush().await.map_err(|_| ())?;
    Ok(())
}

async fn handle_conn(app: AppHandle, st: Arc<PhoneState>, mut stream: TcpStream) -> Result<(), ()> {
    let result = timeout(CONN_TIMEOUT, async {
        let (head, body) = read_http_request(&mut stream).await?;

        // 只接受带本次运行 token 的请求。bridge 只绑回环，这一跳保证
        // 本机其它进程即使知道端口也不能直接调用引擎。
        let bridge_token = {
            let g = st.inner.lock().await;
            g.bridge_token.clone()
        };
        if !guard::bridge_allowed(
            http::header_value(&head, guard::BRIDGE_HEADER).as_deref(),
            &bridge_token,
        ) {
            let _ = write_simple(
                &mut stream,
                403,
                "Forbidden",
                "必须带本次运行的桌面引擎 bridge token。",
            )
            .await;
            return Ok::<(), ()>(());
        }

        let req = http::parse(&head, body).map_err(|_| ())?;
        let resp = route(&app, &st, req).await;
        let bytes = resp.to_bytes();
        stream.write_all(&bytes).await.map_err(|_| ())?;
        Ok(())
    })
    .await;
    let _ = result;
    Ok(())
}

/// 只代理 `/api/*`；没有 `/`、`/pair`、`/ca.crt`、`/api/pair-state`。
async fn route(app: &AppHandle, st: &Arc<PhoneState>, req: HttpRequest) -> HttpResponse {
    if req.path.starts_with("/api/") {
        proxy_to_ts(app, st, req).await
    } else {
        HttpResponse::json(404, serde_json::json!({ "error": "not_found" }))
    }
}

/// 代理到 WebView TS：事件 remote-request → 等 remote_respond。
///
/// 这是**唯一**的事件桥：AA bridge（`proxy_to_ts`）与 PC 网关
/// （`phone::gateway`）都从这里发事件。不要为第二条监听另发事件名 ——
/// 那样渲染层就会有两条应答路径，谁答的、答给谁都说不清。
pub(crate) async fn forward_to_renderer(
    app: &AppHandle,
    st: &Arc<PhoneState>,
    req: HttpRequest,
) -> HttpResponse {
    let req_id = format!("rr-{}", uuid::Uuid::new_v4());
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
    let _ = app.emit("remote-request", payload);

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

/// AA 的 `/api/*` 代理：bridge 没在跑就快速失败（网关不走这里，它有自己的生命周期）。
async fn proxy_to_ts(app: &AppHandle, st: &Arc<PhoneState>, req: HttpRequest) -> HttpResponse {
    if !st.inner.lock().await.running {
        return HttpResponse::json(502, serde_json::json!({ "error": "bridge stopped" }));
    }
    forward_to_renderer(app, st, req).await
}

/// 启动回环 bridge（幂等）。应用 setup 时调用；不对局域网开放。
pub async fn start_bridge(app: AppHandle, st: Arc<PhoneState>) -> Result<u16, String> {
    let mut g = st.inner.lock().await;
    if g.running {
        return Ok(g.bridge_port);
    }
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("绑定回环 bridge 失败: {}", e))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("取 bridge 端口失败: {}", e))?
        .port();
    let bridge_token = random_hex(32);
    g.running = true;
    g.bridge_port = port;
    g.bridge_token = bridge_token;
    drop(g);

    let st2 = st.clone();
    let app2 = app.clone();
    let handle = tauri::async_runtime::spawn(async move {
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
    });
    st.inner.lock().await.server_handle = Some(handle);
    Ok(port)
}
// ============================================================
// 阶段 R6（接线）：把 AA connector 做成可用的命令
//
// 这一层**不需要服务端**就能做完并验证：它只负责"把凭据交进去、把状态读出来"。
// 做完之后，用户手上什么时候有一台 AA 服务端（或账号），填进去就能用
// —— 不需要再改代码。
// ============================================================

/// 启动 AA connector（完全复刻它那条出站路径）。
///
/// 参数：服务端地址 + 设备凭据（`connectorId` / `connectorToken`，字段名与它
/// `connector.json` 一致）。**凭据失效时它会自己停**（不再无限重连），
/// 状态里 `credentialsRevoked` 会告诉你"要重新授权"。
#[tauri::command]
pub async fn aa_connector_start(
    state: State<'_, Arc<PhoneState>>,
    cs: State<'_, Arc<aa_connector::AaConnectorState>>,
    server_url: String,
    connector_id: String,
    connector_token: String,
) -> Result<serde_json::Value, String> {
    let st: Arc<PhoneState> = state.inner().clone();
    let c: Arc<aa_connector::AaConnectorState> = cs.inner().clone();
    // 空凭据**在进门就拒**：发出去只会拿到 401，然后被判定"凭据失效"，
    // 而用户看到的是"要我重新授权"—— 那是误导（他根本还没填）。
    if server_url.trim().is_empty() || connector_id.trim().is_empty() || connector_token.trim().is_empty() {
        return Err("服务端地址、connectorId、connectorToken 都不能为空".into());
    }
    // 地址必须能解析（否则错误会拖到连接阶段才暴露，且信息更含糊）
    aa_connector::ws_url(server_url.trim(), aa_connector::CONNECTOR_WS_PATH)?;
    let cfg = aa_connector::AaConfig::new(server_url.trim(), connector_id.trim(), connector_token.trim());
    aa_connector::start(st, c.clone(), cfg).await?;
    Ok(aa_connector::snapshot(c).await)
}

/// 停止 AA connector。
#[tauri::command]
pub async fn aa_connector_stop(
    cs: State<'_, Arc<aa_connector::AaConnectorState>>,
) -> Result<serde_json::Value, String> {
    let c: Arc<aa_connector::AaConnectorState> = cs.inner().clone();
    aa_connector::stop(c.clone()).await;
    Ok(aa_connector::snapshot(c).await)
}

/// 读 AA connector 状态（连接阶段、计数、最近错误）。
#[tauri::command]
pub async fn aa_connector_status(
    cs: State<'_, Arc<aa_connector::AaConnectorState>>,
) -> Result<serde_json::Value, String> {
    let c: Arc<aa_connector::AaConnectorState> = cs.inner().clone();
    Ok(aa_connector::snapshot(c).await)
}

// ============================================================
// N1–N3 命令层：登录 → 注册本机 → 连上
//
// 用户口径：**简单**。所以这条链只有三个动作，界面上一屏能看完：
//
//   1. 选服务器（默认云端，或填自建地址）
//   2. 填邮箱 + 密码 → 登录（没账号时用同一个按钮注册）
//   3. 点「连接」→ 自动注册本机 → 启动 connector
//
// **不用** OAuth/PKCE：服务端本身支持邮箱+密码（真服务端上验过），
// 而 OAuth 那条要用它插件的 client id（它的身份，不是我们的）。
// `aa_account.rs` 里那套 PKCE/回环保留为备选，默认不走。
// ============================================================

/// 读账号态（**只回不含令牌的视图**）。
/// 请求验证码邮件（服务端启用了邮件验证时才需要）。
#[tauri::command]
pub async fn aa_account_send_code(
    server_url: Option<String>,
    email: String,
    purpose: Option<String>,
) -> Result<serde_json::Value, String> {
    let email = email.trim().to_string();
    if email.is_empty() {
        return Err("请先填邮箱".into());
    }
    let base = match server_url.filter(|s| !s.trim().is_empty()) {
        Some(u) => aa_account::normalize_api_base(&u)?,
        None => aa_account::AA_CLOUD_BASE_URL.to_string(),
    };
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("构造 HTTP 客户端失败: {}", e))?;
    let p = purpose.filter(|s| !s.trim().is_empty()).unwrap_or_else(|| "register".into());
    aa_account::send_email_code(&client, &base, &email, &p).await?;
    Ok(serde_json::json!({ "ok": true }))
}

#[tauri::command]
pub async fn aa_account_status(
    store: State<'_, Arc<aa_account::AaAccountStore>>,
) -> Result<serde_json::Value, String> {
    let s: Arc<aa_account::AaAccountStore> = store.inner().clone();
    Ok(match s.get().await {
        Some(st) => st.redacted(now_ms() as u64),
        None => serde_json::json!({ "signedIn": false, "serverUrl": aa_account::AA_CLOUD_BASE_URL }),
    })
}

/// 登录（`register=true` 时先注册）。
///
/// 返回**脱敏**的账号视图；令牌只留在 Rust 侧与账号态文件里。
#[tauri::command]
pub async fn aa_account_login(
    store: State<'_, Arc<aa_account::AaAccountStore>>,
    server_url: Option<String>,
    email: String,
    password: String,
    register: Option<bool>,
    display_name: Option<String>,
    setup_token: Option<String>,
    // 邮箱验证码（服务端启用邮件验证时必填）—— **必须一路传到服务端**。
    // 漏掉它的表现是"验证码不对"，而其实是**我们没发出去**。
    code: Option<String>,
) -> Result<serde_json::Value, String> {
    let email = email.trim().to_string();
    if email.is_empty() || password.is_empty() {
        return Err("邮箱和密码都要填".into());
    }
    // 注册时 displayName 是**服务端必填**（1-64 字符，不能空白）。
    // 这条我先前漏了 —— 用户点"注册并登录"撞到 422 才发现界面上根本没这个输入框。
    // 在**进门就拒**，这样错误信息由我们说清，而不是等服务端回一句英文校验错误。
    let register_mode = register.unwrap_or(false);
    let display_name = display_name.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    if register_mode && display_name.is_none() {
        return Err("注册需要一个昵称（1-64 个字符）".into());
    }
    if let Some(n) = display_name.as_deref() {
        if n.chars().count() > 64 {
            return Err("昵称最长 64 个字符".into());
        }
        if n.chars().any(|c| (c as u32) < 32) {
            return Err("昵称不能包含控制字符".into());
        }
    }
    // 空/未给 ⇒ 用它自己的云（DSH 的默认值）
    let base = match server_url.filter(|s| !s.trim().is_empty()) {
        Some(u) => aa_account::normalize_api_base(&u)?,
        None => aa_account::AA_CLOUD_BASE_URL.to_string(),
    };
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("构造 HTTP 客户端失败: {}", e))?;

    let token = if register.unwrap_or(false) {
        aa_account::register_with_password(
            &client,
            &base,
            &email,
            &password,
            display_name.as_deref(),
            setup_token.as_deref(),
            code.as_deref(),
        )
        .await?
    } else {
        aa_account::login_with_password(&client, &base, &email, &password).await?
    };
    let profile = aa_account::fetch_me(&client, &base, &token).await?;

    let s: Arc<aa_account::AaAccountStore> = store.inner().clone();
    // 换了服务器 ⇒ 旧设备凭据**必须作废**（那是另一台服务器上的设备，
    // 带着它去连新服务器只会拿到 401，而用户看到的是莫名其妙的"凭据失效"）
    let prev = s.get().await;
    let keep_device = prev
        .as_ref()
        .filter(|p| p.server_url == base)
        .and_then(|p| p.device.clone());

    let st = aa_account::AaAccountState {
        server_url: base.clone(),
        client_id: None,
        access_token: Some(token),
        // 服务端没给过期时间；这里留空，靠"用的时候失败就重新登录"
        expires_at_ms: None,
        profile: Some(profile),
        device: keep_device,
    };
    s.set(st.clone()).await?;
    Ok(st.redacted(now_ms() as u64))
}

/// 退出登录：清掉账号态与设备凭据，并停掉 connector。
#[tauri::command]
pub async fn aa_account_logout(
    store: State<'_, Arc<aa_account::AaAccountStore>>,
    cs: State<'_, Arc<aa_connector::AaConnectorState>>,
) -> Result<serde_json::Value, String> {
    let s: Arc<aa_account::AaAccountStore> = store.inner().clone();
    let c: Arc<aa_connector::AaConnectorState> = cs.inner().clone();
    aa_connector::stop(c).await;
    s.clear().await?;
    Ok(serde_json::json!({ "signedIn": false }))
}

/// 连上：确保本机已注册为连接器，然后启动 connector。
///
/// 这一步是"登录一下就能用"里的**最后一下** —— 也是我先前漏掉的那段
/// （`connectorToken` 是这里换来的，不是让用户手工准备）。
#[tauri::command]
pub async fn aa_connect(
    store: State<'_, Arc<aa_account::AaAccountStore>>,
    cs: State<'_, Arc<aa_connector::AaConnectorState>>,
    state: State<'_, Arc<PhoneState>>,
    device_name: Option<String>,
) -> Result<serde_json::Value, String> {
    let s: Arc<aa_account::AaAccountStore> = store.inner().clone();
    let c: Arc<aa_connector::AaConnectorState> = cs.inner().clone();
    let st: Arc<PhoneState> = state.inner().clone();

    let acct = s.get().await.ok_or_else(|| "请先登录".to_string())?;
    let token = acct
        .access_token
        .clone()
        .filter(|t| !t.is_empty())
        .ok_or_else(|| "登录已失效，请重新登录".to_string())?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("构造 HTTP 客户端失败: {}", e))?;

    // 1) 没有设备凭据 ⇒ 注册本机（有就直接用）
    let cred = match acct.device.clone() {
        Some(d) if !d.connector_id.is_empty() && !d.connector_token.is_empty() => d,
        _ => {
            let name = device_name
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| hostname_or_default());
            let cred = aa_account::register_connector(
                &client,
                &acct.server_url,
                &token,
                &name,
                &installation_id(&s).await,
            )
            .await?;
            s.set_device(cred.clone()).await?;
            cred
        }
    };

    // 2) 启动 connector
    let cfg = aa_connector::AaConfig::new(&acct.server_url, &cred.connector_id, &cred.connector_token);
    aa_connector::start(st, c.clone(), cfg).await?;
    Ok(aa_connector::snapshot(c).await)
}

/// 安装标识：同一次安装应当**稳定**（它那边用来避免重复注册同一台机器）。
///
/// 放在账号态文件旁边，首次生成后一直复用。
async fn installation_id(store: &Arc<aa_account::AaAccountStore>) -> String {
    // 借用设备凭据的持久化目录：与账号态同目录
    let path = store.installation_id_path();
    if let Ok(s) = std::fs::read_to_string(&path) {
        let t = s.trim().to_string();
        if !t.is_empty() {
            return t;
        }
    }
    let fresh = uuid::Uuid::new_v4().to_string();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(&path, &fresh);
    fresh
}

fn hostname_or_default() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .ok()
        .filter(|s| !s.trim().is_empty())
        .map(|h| format!("Codem @ {}", h))
        .unwrap_or_else(|| "Codem".to_string())
}

/// TS 侧应答 bridge 请求（reqId 对应 remote-request 事件）。
#[tauri::command]
pub async fn remote_respond(
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
    fn random_hex_has_expected_shape() {
        let a = random_hex(32);
        let b = random_hex(32);
        assert_eq!(a.len(), 64);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
    }
}
