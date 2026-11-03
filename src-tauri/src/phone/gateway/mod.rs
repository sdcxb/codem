// ============================================================
// phone/gateway/mod.rs — PC 桌面远程网关（loopback；M3 事件 + 审批 + 只读文件面 + 变更记录）
//
// ## 是什么
//
// ADR-0005：**PC 桌面拥有数据**；手机远程经桌面进程内的 loopback 网关访问。
//
//   手机浏览器 ──HTTP──▶ [127.0.0.1:随机端口] ──remote-request──▶ [WebView TS]
//                    ◀──SSE `/events`──      ◀──remote_respond──
//
// 闭环由五块组成：
//   1. `GET /` + `/ui.js` + `/ui.css`：共享 UI（packages/host/web 构建物）；
//   2. `pair.claim`：6 位一次性码 → HttpOnly 设备 cookie（Rust 内存配对）；
//      2b. Tailscale Serve 身份头（loopback + `*.ts.net` + 非 Funnel）→ 零配对码自动登记；
//   3. `POST /rpc`：只放行下面的**精确白名单**（只读 + 写 + 审批 + 只读文件面 +
//      变更记录，共 13 条）；其余（引导/新建/附件）在网关层就拒绝 —— 不依赖渲染层
//      自觉，也不给手机画一个点不通的入口；
//   4. `GET /events`：SSE 事件流（`events.rs`）。渲染层把桌面循环事件用
//      `gateway_publish_event` 发进来，网关按会话广播给已配对设备，支持
//      `Last-Event-ID` 续传；断线太久则发 `gateway.reset` 让界面重新对齐；
//   5. 所有方法与事件都由渲染层用**桌面现有存储/引擎**回答/产生（同一套
//      ProjectStorage/SessionStorage/MessageStorage/SessionExecutor），
//      网关不读库、不建第二份库、不跑第二条循环。
//
// ## M2/M3 的边界（刻意不做的那部分）
//
// 没有 `run.guidance`（引导=写进当前循环的第二个入口，需要先有清晰的多端语义）、
// 没有 `attachment.put` / `session.create`。
// M3 加了 `workspace.list` / `workspace.read` / `workspace.diff` 三条**只读**方法
// （边界在 `workspace.rs`），以及两条**只读**变更记录方法
// （`session.changes` / `session.change.diff`，数据由渲染层从桌面库与 git 对象回答）。
// 加白名单行之前，先确认渲染层真的有这条路径 —— 否则就是"看起来支持、点了没用"。
// 事件流只有**网关发起的运行**会产生实时事件：桌面前台回合走 `App.tsx` 自己的
// 循环，不经过这里（手机刷新 `session.get` 仍能看到它的结果与历史）。
//
// ## 为什么数据面仍然经过渲染层
//
// 网关不拥有数据。会话/消息来自 WebView 里已经初始化的桌面存储；Rust 只做
// HTTP、鉴权与静态资源。这样既不跑第二套 Agent 循环，也不把 SQLite 的打开
// 语义复制到第二个进程。
//
// ## 与 AA bridge 的关系：共用同一套桥，不建第二套
//
// AA bridge（`phone::start_bridge`）与本网关都通过 `phone::forward_to_renderer`
// 发 `remote-request`，再由 TS 用 `remote_respond` 回答 —— 事件名、应答命令、
// 在途请求表**只有一份**。
//
// ## 生命周期
//
// 只有 `gateway_start` / `gateway_stop` / `gateway_status` / `gateway_pair_start` /
// `gateway_devices` / `gateway_device_revoke` 六个命令。渲染层按设置（默认开）自动启动；
// 启动优先绑 `127.0.0.1:41873`（手机保存的 origin 在重启后仍然有效），端口被占才回退随机端口。
// 停止会等监听任务真正结束（端口已关闭）并清空配对状态（所有设备 cookie 随之下线，磁盘也清空；
// 进程退出不调用 stop，所以桌面重启后已配对设备仍然有效）。
//
// ## 明确不做（旧 phone-link 的这些东西已整块删除，不要恢复）
//
// LAN 绑定 / 自签 CA / TLS / 二维码 / 旧手机单页 / 旧配对 URL / 自建中继；
// 也不在这里读桌面库、不跑第二套 Agent 循环 —— 数据只能从渲染层来。
// ============================================================

pub mod assets;
pub mod bridge;
pub mod events;
pub mod pairing;
pub mod workspace;

use std::sync::Arc;

use tauri::{AppHandle, Manager, State};
use tokio::io::AsyncWriteExt;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{oneshot, watch, Mutex as TokioMutex};
use tokio::time::timeout;

use crate::phone::http::{
    header_value, parse as parse_http, Request as HttpRequest, Response as HttpResponse,
};
use crate::phone::{read_http_request, PhoneState, CONN_TIMEOUT};

use assets::{Asset, GatewayWeb};
use bridge::{RendererBridge, TauriBridge};
use events::EventHub;
use pairing::{
    normalize_tailscale_login, PairClaim, PairError, PairingState, PersistedPairing,
    DEVICE_COOKIE_MAX_AGE_SEC, DEVICE_COOKIE_NAME,
};

/// 只绑回环 + 优先固定端口：不和别的程序抢固定端口，也不对局域网暴露。
/// 固定端口让**手机保存的地址在桌面重启后仍然有效**（cookie 按 origin 隔离）；
/// 端口被占时回退到随机端口，并在状态里如实报告实际端口。
const BIND_ADDR: &str = "127.0.0.1:0";
const PREFERRED_PORT: u16 = 41873;

/// 配对设备持久化文件名（app_data_dir 下）。只存 token 的 sha256。
const PAIRING_FILE: &str = "phone-pairing.json";

/// 健康检查（与 TS `gateway-engine.ts` 的 `GATEWAY_HEALTH_PATH` 对齐）。
const HEALTH_PATH: &str = "/health";
/// JSON-RPC 端点（与共享 UI 的 `HostClient` 对齐）。
const RPC_PATH: &str = "/rpc";
/// SSE 事件流（见 `events.rs`；与 `host-client.ts` 的 `/events` 对齐）。
const EVENTS_PATH: &str = "/events";
/// 配对兑换：未鉴权请求里**唯一**允许的方法。
const PAIR_CLAIM_METHOD: &str = "pair.claim";
/// `/rpc` 的**精确**白名单。不在表里的一律在网关层拒绝，不依赖渲染层自觉。
///
/// M1 = 前四个只读方法；M2 = `prompt.send` / `run.cancel` + 审批两条；
/// M3 = `workspace.list` / `workspace.read` / `workspace.diff`（只读文件面）+
/// `session.changes` / `session.change.diff`（只读变更记录）；
/// B1 = `project.list` / `project.create` / `session.create`（远程新建，写的是桌面**同一份**库）。
/// 引导（`run.guidance`）、附件（`attachment.put`）**都还不在**这里 —— 它们各自需要
/// 渲染层与共享 UI 的真实实现，先加白名单 = 手机上出现"点了必失败"的按钮。
const RPC_ALLOWED_METHODS: &[&str] = &[
    "host.hello",
    "host.diagnostics",
    "session.list",
    "session.get",
    "session.create",
    "project.list",
    "project.create",
    "prompt.send",
    "run.cancel",
    "approval.list",
    "approval.respond",
    "workspace.list",
    "workspace.read",
    "workspace.diff",
    "session.changes",
    "session.change.diff",
];
/// 网关自报身份（不随进程变化；判据/信息面板用）。
const GATEWAY_HOST_ID: &str = "codem-desktop";

// ---- 状态 ----

pub struct GatewayInner {
    running: bool,
    port: u16,
    /// 停止信号：发送即让监听循环退出（监听器随之析构 ⇒ 端口关闭）。
    shutdown: Option<oneshot::Sender<()>>,
    /// 监听任务：`stop` 等它结束，避免"返回了但端口还开着"。
    handle: Option<tauri::async_runtime::JoinHandle<()>>,
    /// 事件流（SSE 长连接）的停止信号：`stop` 必须主动断开它们，
    /// 否则"网关已停止"之后手机仍挂在一条再也不会产生事件的连接上。
    clients_shutdown: Option<watch::Sender<bool>>,
}

impl Default for GatewayInner {
    fn default() -> Self {
        GatewayInner {
            running: false,
            port: 0,
            shutdown: None,
            handle: None,
            clients_shutdown: None,
        }
    }
}

pub struct GatewayState {
    inner: TokioMutex<GatewayInner>,
    /// 配对码与设备 token hash。与生命周期分开，`stop` 会整体清空。
    pairing: TokioMutex<PairingState>,
    /// 设备表持久化路径（`None` = 拿不到 app 数据目录，退化为纯内存，如实可解释）。
    pairing_file: std::sync::Mutex<Option<std::path::PathBuf>>,
    /// 启动时加载的共享 UI 静态资源；停止后清掉。
    web: TokioMutex<Option<Arc<GatewayWeb>>>,
    /// 事件枢纽。**跨 stop/start 保留**：同一进程里停止期间仍在跑的回合，
    /// 其终态事件不能因为"手机暂时没连"而消失（见 `events.rs` 文件头）。
    events: Arc<EventHub>,
}

impl GatewayState {
    pub fn new() -> Arc<Self> {
        Arc::new(GatewayState {
            inner: TokioMutex::new(GatewayInner::default()),
            pairing: TokioMutex::new(PairingState::new()),
            pairing_file: std::sync::Mutex::new(None),
            web: TokioMutex::new(None),
            events: EventHub::new(),
        })
    }
}

fn status_json(running: bool, port: u16, paired_devices: usize) -> serde_json::Value {
    serde_json::json!({
        "running": running,
        "port": port,
        "url": if running {
            Some(format!("http://127.0.0.1:{}", port))
        } else {
            None
        },
        "pairedDevices": paired_devices,
    })
}

async fn current_status(st: &Arc<GatewayState>) -> serde_json::Value {
    // 注意锁顺序：先读 inner 再读 pairing，且两次都在拿到值后立刻释放。
    let (running, port) = {
        let g = st.inner.lock().await;
        (g.running, g.port)
    };
    let paired = st.pairing.lock().await.device_count();
    status_json(running, port, paired)
}

// ---- 路由（纯函数，可单测）----

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Route {
    /// 交给渲染层回答。
    Health,
    /// 网关自己处理（配对/鉴权/白名单）。
    Rpc,
    /// SSE 事件流（长连接，在 `handle_conn` 里单独走流式路径）。
    Events,
    /// 固定白名单的共享 UI 资源。
    Asset(Asset),
    MethodNotAllowed,
    NotFound,
}

/// 只有白名单里的路径会被响应；其余在这里就答，不惊动渲染层。
pub(crate) fn classify(method: &str, path: &str) -> Route {
    if let Some(asset) = static_asset(path) {
        return if method == "GET" {
            Route::Asset(asset)
        } else {
            Route::MethodNotAllowed
        };
    }
    match path {
        HEALTH_PATH if method == "GET" => Route::Health,
        HEALTH_PATH => Route::MethodNotAllowed,
        RPC_PATH if method == "POST" => Route::Rpc,
        RPC_PATH => Route::MethodNotAllowed,
        EVENTS_PATH if method == "GET" => Route::Events,
        EVENTS_PATH => Route::MethodNotAllowed,
        _ => Route::NotFound,
    }
}

fn static_asset(path: &str) -> Option<Asset> {
    match path {
        "/" | "/index.html" => Some(Asset::Index),
        "/ui.js" => Some(Asset::UiJs),
        "/ui.css" => Some(Asset::UiCss),
        _ => None,
    }
}

fn json_error(status: u16, code: &str, message: &str) -> HttpResponse {
    HttpResponse::json(
        status,
        serde_json::json!({ "error": code, "message": message }),
    )
}

fn jsonrpc_result(id: serde_json::Value, result: serde_json::Value) -> serde_json::Value {
    serde_json::json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn jsonrpc_error(
    id: serde_json::Value,
    code: i64,
    message: &str,
    kind: &str,
    details: Option<serde_json::Value>,
) -> serde_json::Value {
    let mut data = serde_json::json!({ "kind": kind, "retryable": false });
    if let Some(details) = details {
        data["details"] = details;
    }
    serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message, "data": data },
    })
}

fn rpc_response(status: u16, value: serde_json::Value, cookie: Option<String>) -> HttpResponse {
    let mut resp = HttpResponse::json(status, value);
    if let Some(cookie) = cookie {
        resp.headers.push(("Set-Cookie".to_string(), cookie));
    }
    resp
}

// ---- 请求头辅助 ----

struct RequestHeaders {
    cookie: Option<String>,
    host: Option<String>,
    origin: Option<String>,
    content_type: Option<String>,
    /// 隧道/反代终结 TLS 时由代理带上来（cloudflared / Tailscale / nginx）。
    forwarded_proto: Option<String>,
    /// SSE 断线重连时浏览器自动带的续传水位（`id:` 帧的最后一个值）。
    last_event_id: Option<String>,
    /// Tailscale Serve 注入的身份头（只有 Serve 会注入；Funnel 不注入）。
    tailscale_login: Option<String>,
    tailscale_user_name: Option<String>,
    /// Funnel 请求标记；存在即拒绝零配对码。
    tailscale_funnel_request: Option<String>,
}

/// 可信的 Tailscale Serve 身份。
#[derive(Debug, Clone, PartialEq, Eq)]
struct TailscaleIdentity {
    login: String,
    name: Option<String>,
}

impl RequestHeaders {
    fn from_head(head: &str) -> Self {
        Self {
            cookie: header_value(head, "cookie"),
            host: header_value(head, "host"),
            origin: header_value(head, "origin"),
            content_type: header_value(head, "content-type"),
            forwarded_proto: header_value(head, "x-forwarded-proto"),
            last_event_id: header_value(head, "last-event-id"),
            tailscale_login: header_value(head, "tailscale-user-login"),
            tailscale_user_name: header_value(head, "tailscale-user-name"),
            tailscale_funnel_request: header_value(head, "tailscale-funnel-request"),
        }
    }

    fn device_token(&self) -> Option<String> {
        cookie_value(self.cookie.as_deref(), DEVICE_COOKIE_NAME)
    }

    /// 零配对码的身份判定：**四项同时满足**才可信。
    ///
    /// 1. TCP 对端是 loopback（tailscaled 的 Serve 代理从本机连入）；
    /// 2. Host 是 `*.ts.net`（Tailscale Serve 的 MagicDNS 域名）；
    /// 3. 不是 Funnel（Funnel 不注入身份，且会带 `Tailscale-Funnel-Request`）；
    /// 4. `Tailscale-User-Login` 是 ASCII 邮箱形态。
    ///
    /// 这是 Tailscale 官方文档描述的信任模型：后端只监听 localhost，身份头由
    /// tailscaled 注入并清掉客户端伪造值；本机进程被视为可信边界。
    fn tailscale_identity(&self, peer_is_loopback: bool) -> Option<TailscaleIdentity> {
        if !peer_is_loopback || self.tailscale_funnel_request.is_some() {
            return None;
        }
        let host = self.host.as_deref()?.trim();
        let hostname = host
            .rsplit_once(':')
            .map(|(name, _)| name)
            .unwrap_or(host)
            .trim_start_matches('[')
            .trim_end_matches(']')
            .to_ascii_lowercase();
        if !hostname.ends_with(".ts.net") {
            return None;
        }
        let login = normalize_tailscale_login(self.tailscale_login.as_deref()?)?;
        let name = self
            .tailscale_user_name
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| value.chars().take(64).collect::<String>());
        Some(TailscaleIdentity { login, name })
    }

    /// 这次请求对外是不是 HTTPS（隧道终结 TLS）。`Secure` cookie 必须按它决定，
    /// 否则走隧道时浏览器会把凭据当成"可被明文发送的 cookie"。
    fn is_https(&self) -> bool {
        if let Some(proto) = self.forwarded_proto.as_deref() {
            if proto.eq_ignore_ascii_case("https") {
                return true;
            }
        }
        self.origin
            .as_deref()
            .map(|origin| origin.trim().to_ascii_lowercase().starts_with("https://"))
            .unwrap_or(false)
    }

    fn is_json(&self) -> bool {
        self.content_type
            .as_deref()
            .map(|v| {
                v.trim()
                    .to_ascii_lowercase()
                    .starts_with("application/json")
            })
            .unwrap_or(false)
    }
}

/**
 * Host 白名单：回环、已知隧道域名（cloudflared quick tunnel / Tailscale），
 * 或用 `CODEM_GATEWAY_ALLOWED_HOSTS=a.example.com,b.example.com` 显式放行的自有域名。
 *
 * 为什么需要：`Origin == Host` 只能挡"别的站点借浏览器打本机"；DNS rebinding 可以让
 * 攻击者的域名解析到 127.0.0.1，此时 Origin 与 Host 都是攻击者域名，前一条判据不成立。
 * 隧道域名是**用户自己的入口**（URL 只在他手机上），自有域名必须显式声明——不默认放开。
 */
fn host_allowed(host: Option<&str>) -> bool {
    let Some(host) = host else {
        // HTTP/1.0 / 本机 curl 可以不带 Host；后面仍要过 cookie 鉴权
        return true;
    };
    let host = host.trim();
    let hostname = match host.rsplit_once(':') {
        Some((name, _port)) => name,
        None => host,
    }
    .trim_start_matches('[')
    .trim_end_matches(']')
    .to_ascii_lowercase();
    if matches!(hostname.as_str(), "127.0.0.1" | "localhost" | "::1") {
        return true;
    }
    if hostname.ends_with(".trycloudflare.com") || hostname.ends_with(".ts.net") {
        return true;
    }
    std::env::var("CODEM_GATEWAY_ALLOWED_HOSTS")
        .map(|extra| {
            extra
                .split(',')
                .any(|allowed| allowed.trim().eq_ignore_ascii_case(&hostname))
        })
        .unwrap_or(false)
}

/// 同源校验：带 `Origin` 的浏览器请求必须与 `Host` 一致。
///
/// 无 `Origin` 的本机客户端（curl/测试）仍要过 cookie 鉴权；`Origin: null`
/// 直接拒绝。这样别的网页不能借用户浏览器打本机网关（CSRF）。
fn origin_allowed(origin: Option<&str>, host: Option<&str>) -> bool {
    let Some(origin) = origin else {
        return true;
    };
    let Some(host) = host else {
        return false;
    };
    let origin = origin.trim_end_matches('/');
    let authority = origin
        .strip_prefix("http://")
        .or_else(|| origin.strip_prefix("https://"));
    matches!(authority, Some(authority) if authority.eq_ignore_ascii_case(host))
}

fn cookie_value(header: Option<&str>, name: &str) -> Option<String> {
    for part in header?.split(';') {
        let Some((key, value)) = part.split_once('=') else {
            continue;
        };
        if key.trim() == name {
            let value = value.trim();
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
    }
    None
}

fn device_cookie(token: &str, secure: bool) -> String {
    format!(
        "{}={}; Path=/; HttpOnly; SameSite=Strict;{} Max-Age={}",
        DEVICE_COOKIE_NAME,
        token,
        if secure { " Secure;" } else { "" },
        DEVICE_COOKIE_MAX_AGE_SEC
    )
}

// ---- 监听 ----

/// 接受连接直到收到停止信号。
///
/// 拆成独立函数（而不是写在 `start` 里）是为了让 `cargo test` 能在**没有 Tauri
/// AppHandle** 的情况下把整条 HTTP 链路跑起来：测试传自己的监听器与假 bridge。
pub(crate) async fn serve(
    listener: TcpListener,
    renderer: Arc<dyn RendererBridge>,
    st: Arc<GatewayState>,
    mut shutdown: oneshot::Receiver<()>,
) {
    loop {
        tokio::select! {
            // 发送端被 drop 也会到这里（Err）—— 那正是"没人再需要这个监听了"。
            _ = &mut shutdown => break,
            accepted = listener.accept() => {
                match accepted {
                    Ok((stream, _peer)) => {
                        let renderer = renderer.clone();
                        let st = st.clone();
                        tauri::async_runtime::spawn(async move {
                            let _ = handle_conn(st, renderer, stream).await;
                        });
                    }
                    Err(_) => break,
                }
            }
        }
    }
}

async fn handle_conn(
    st: Arc<GatewayState>,
    renderer: Arc<dyn RendererBridge>,
    mut stream: TcpStream,
) -> Result<(), ()> {
    /*
     * 读请求与写响应用 25s 的整连接时限；**事件流不套这个时限** ——
     * SSE 是长连接，套上就会在 25s 后把手机的事件流砍掉（症状是"每隔半分钟断一次"）。
     * 所以这里先读完请求，再按路由分叉：事件流走自己的循环，其余走一次性响应。
     */
    let read = timeout(CONN_TIMEOUT, read_http_request(&mut stream)).await;
    let (head, body) = match read {
        Ok(Ok(parts)) => parts,
        _ => return Ok(()),
    };
    let req = match parse_http(&head, body) {
        Ok(req) => req,
        Err(_) => return Ok(()),
    };
    let headers = RequestHeaders::from_head(&head);
    let peer_is_loopback = stream
        .peer_addr()
        .map(|addr| addr.ip().is_loopback())
        .unwrap_or(false);

    if classify(&req.method, &req.path) == Route::Events {
        return handle_events(st, stream, req, headers, peer_is_loopback).await;
    }

    let resp = match timeout(
        CONN_TIMEOUT,
        route(&st, &renderer, req, &headers, peer_is_loopback),
    )
    .await
    {
        Ok(resp) => resp,
        Err(_) => json_error(504, "timeout", "桌面渲染层应答超时"),
    };
    stream.write_all(&resp.to_bytes()).await.map_err(|_| ())?;
    Ok(())
}

/// `GET /events`：鉴权 → 解析 `Last-Event-ID`/`sinceSeq` → 交给事件枢纽流式发送。
///
/// 鉴权在**写响应头之前**完成：未配对/跨源的请求只能拿到一条 JSON 错误，
/// 不会建立事件流（EventSource 对非 200 不重试，用户会看到明确的失败而不是无限重连）。
async fn handle_events(
    st: Arc<GatewayState>,
    mut stream: TcpStream,
    req: HttpRequest,
    headers: RequestHeaders,
    peer_is_loopback: bool,
) -> Result<(), ()> {
    if !origin_allowed(headers.origin.as_deref(), headers.host.as_deref())
        || !host_allowed(headers.host.as_deref())
    {
        let _ = stream
            .write_all(&json_error(403, "forbidden", "跨源请求被拒绝").to_bytes())
            .await;
        return Ok(());
    }
    let device = match authenticate_device(&st, headers.device_token()).await {
        Some(device) => device,
        None => {
            let Some(identity) = headers.tailscale_identity(peer_is_loopback) else {
                let _ = stream
                    .write_all(&json_error(401, "unauthorized", "缺少或错误的设备凭据").to_bytes())
                    .await;
                return Ok(());
            };
            match claim_tailscale_device(&st, &identity, None, "web").await {
                Ok(claimed) => {
                    persist_pairing(&st).await;
                    claimed.device
                }
                Err(_) => {
                    let _ = stream
                        .write_all(
                            &json_error(401, "unauthorized", "Tailscale 身份未获授权").to_bytes(),
                        )
                        .await;
                    return Ok(());
                }
            }
        }
    };
    let Some(session_id) = req
        .query
        .get("sessionId")
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
    else {
        let _ = stream
            .write_all(&json_error(400, "invalid_params", "sessionId 必填").to_bytes())
            .await;
        return Ok(());
    };
    let since = match parse_since(&headers.last_event_id, req.query.get("sinceSeq")) {
        Ok(value) => value,
        Err(message) => {
            let _ = stream
                .write_all(&json_error(400, "invalid_params", message).to_bytes())
                .await;
            return Ok(());
        }
    };
    let shutdown = {
        let g = st.inner.lock().await;
        g.clients_shutdown.as_ref().map(|tx| tx.subscribe())
    };
    let Some(shutdown) = shutdown else {
        // 没有停止信号 = 网关不在运行（监听器已经不该存在；防御性收口）。
        let _ = stream
            .write_all(&json_error(503, "gateway_stopped", "网关未运行").to_bytes())
            .await;
        return Ok(());
    };
    let _ = events::serve_stream(
        stream,
        st.events.clone(),
        session_id,
        since,
        device.id,
        shutdown,
    )
    .await;
    Ok(())
}

/// `Last-Event-ID`（浏览器自动带）优先，其次 `?sinceSeq=`；都没有 = 新连接（只要直播）。
fn parse_since(
    last_event_id: &Option<String>,
    since_seq: Option<&String>,
) -> Result<u64, &'static str> {
    let raw = last_event_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .or_else(|| since_seq.map(|s| s.trim()).filter(|s| !s.is_empty()));
    match raw {
        None => Ok(0),
        Some(text) => text
            .parse::<u64>()
            .map_err(|_| "Last-Event-ID / sinceSeq 必须是非负整数"),
    }
}

/// 设备 cookie 鉴权（`/rpc` 与 `/events` 共用同一份配对状态）。
async fn authenticate_device(
    st: &Arc<GatewayState>,
    token: Option<String>,
) -> Option<pairing::DeviceView> {
    let token = token?;
    let mut pairing = st.pairing.lock().await;
    pairing.authenticate(&token, crate::phone::now_ms())
}

async fn route(
    st: &Arc<GatewayState>,
    renderer: &Arc<dyn RendererBridge>,
    req: HttpRequest,
    headers: &RequestHeaders,
    peer_is_loopback: bool,
) -> HttpResponse {
    match classify(&req.method, &req.path) {
        Route::Health => renderer.forward(req).await,
        Route::Rpc => handle_rpc(st, renderer, req, headers, peer_is_loopback).await,
        Route::Asset(asset) => static_response(st, asset).await,
        // 事件流在 `handle_conn` 里就走掉了（长连接不能套 25s 整连接时限）；
        // 真走到这里说明调用方绕过了分叉，如实报错而不是假装写了一条 JSON 事件流。
        Route::Events => json_error(400, "invalid_request", "/events 只接受流式连接"),
        Route::MethodNotAllowed => json_error(405, "method_not_allowed", "方法不允许"),
        Route::NotFound => json_error(404, "not_found", "网关没有这个路径"),
    }
}

async fn static_response(st: &Arc<GatewayState>, asset: Asset) -> HttpResponse {
    let web = st.web.lock().await.clone();
    let Some(web) = web else {
        return json_error(503, "ui_unavailable", "共享 UI 尚未加载");
    };
    let body = web.get(asset).to_vec();
    HttpResponse {
        status: 200,
        headers: vec![
            ("Content-Type".to_string(), asset.content_type().to_string()),
            ("Cache-Control".to_string(), "no-store".to_string()),
            ("X-Content-Type-Options".to_string(), "nosniff".to_string()),
            ("Referrer-Policy".to_string(), "no-referrer".to_string()),
        ],
        body,
    }
}

// ---- /rpc ----

async fn handle_rpc(
    st: &Arc<GatewayState>,
    renderer: &Arc<dyn RendererBridge>,
    req: HttpRequest,
    headers: &RequestHeaders,
    peer_is_loopback: bool,
) -> HttpResponse {
    if !origin_allowed(headers.origin.as_deref(), headers.host.as_deref())
        || !host_allowed(headers.host.as_deref())
    {
        return rpc_response(
            403,
            jsonrpc_error(
                serde_json::Value::Null,
                -32001,
                "跨源请求被拒绝（网关只服务自己的页面）",
                "UNAUTHORIZED",
                None,
            ),
            None,
        );
    }
    if !headers.is_json() {
        return rpc_response(
            400,
            jsonrpc_error(
                serde_json::Value::Null,
                -32600,
                "请求必须是 application/json",
                "INVALID_REQUEST",
                None,
            ),
            None,
        );
    }

    let payload: serde_json::Value = match serde_json::from_slice(&req.body) {
        Ok(value) => value,
        Err(_) => {
            return rpc_response(
                200,
                jsonrpc_error(
                    serde_json::Value::Null,
                    -32700,
                    "JSON 解析失败",
                    "PARSE_ERROR",
                    None,
                ),
                None,
            )
        }
    };
    if !payload.is_object() {
        return rpc_response(
            200,
            jsonrpc_error(
                serde_json::Value::Null,
                -32600,
                "只接受单个 JSON-RPC 对象",
                "INVALID_REQUEST",
                None,
            ),
            None,
        );
    }
    let id = payload
        .get("id")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    let Some(method) = payload.get("method").and_then(|v| v.as_str()) else {
        return rpc_response(
            200,
            jsonrpc_error(id, -32600, "缺少 method", "INVALID_REQUEST", None),
            None,
        );
    };

    if method == PAIR_CLAIM_METHOD {
        return handle_pair_claim(st, payload, id, headers).await;
    }

    let requested_device_name = payload
        .get("params")
        .and_then(|params| params.get("deviceName"))
        .and_then(|value| value.as_str())
        .map(str::to_string);
    let mut bootstrap_cookie: Option<String> = None;
    let authenticated = if authenticate_device(st, headers.device_token())
        .await
        .is_some()
    {
        true
    } else if let Some(identity) = headers.tailscale_identity(peer_is_loopback) {
        match claim_tailscale_device(st, &identity, requested_device_name.as_deref(), "web").await {
            Ok(claimed) => {
                bootstrap_cookie = Some(claimed.token);
                persist_pairing(st).await;
                true
            }
            Err(_) => false,
        }
    } else {
        false
    };
    if !authenticated {
        return rpc_response(
            401,
            jsonrpc_error(
                id,
                -32001,
                "缺少或错误的设备凭据",
                "UNAUTHORIZED",
                Some(serde_json::json!({ "reason": "unauthorized" })),
            ),
            None,
        );
    }

    if !RPC_ALLOWED_METHODS.contains(&method) {
        return rpc_response(
            200,
            jsonrpc_error(
                id,
                -32006,
                "网关未开放该方法（M3 开放只读会话 + prompt.send/run.cancel + approval.* + workspace 只读文件面）",
                "UNSUPPORTED",
                Some(serde_json::json!({ "method": method })),
            ),
            None,
        );
    }

    // 已鉴权且在白名单里：交给渲染层，由桌面现有存储/引擎回答。
    let mut response = renderer.forward(req).await;
    if let Some(token) = bootstrap_cookie {
        response.headers.push((
            "Set-Cookie".to_string(),
            device_cookie(&token, headers.is_https()),
        ));
    }
    response
}

async fn claim_tailscale_device(
    st: &Arc<GatewayState>,
    identity: &TailscaleIdentity,
    device_name: Option<&str>,
    platform: &str,
) -> Result<PairClaim, PairError> {
    let mut pairing = st.pairing.lock().await;
    pairing.claim_tailscale(
        &identity.login,
        device_name.or(identity.name.as_deref()),
        Some(platform),
        crate::phone::now_ms(),
    )
}

async fn handle_pair_claim(
    st: &Arc<GatewayState>,
    payload: serde_json::Value,
    id: serde_json::Value,
    headers: &RequestHeaders,
) -> HttpResponse {
    let params = payload
        .get("params")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    let Some(code) = params.get("code").and_then(|v| v.as_str()) else {
        return rpc_response(
            200,
            jsonrpc_error(
                id,
                -32602,
                "缺少配对码",
                "INVALID_PARAMS",
                Some(serde_json::json!({ "reason": "invalid" })),
            ),
            None,
        );
    };
    let device_name = params.get("deviceName").and_then(|v| v.as_str());
    let platform = params.get("platform").and_then(|v| v.as_str());

    let result = {
        let mut pairing = st.pairing.lock().await;
        pairing.claim(code, device_name, platform, crate::phone::now_ms())
    };
    match result {
        Ok(claimed) => {
            let device = claimed.device;
            let body = jsonrpc_result(
                id,
                serde_json::json!({
                    "hostId": GATEWAY_HOST_ID,
                    "deviceId": device.id.clone(),
                    "device": {
                        "id": device.id,
                        "name": device.name,
                        "platform": device.platform,
                        "createdAt": device.created_at,
                        "lastSeenAt": device.last_seen_at,
                    },
                }),
            );
            // B2：配对成功立刻落盘（只存 token 的 sha256）—— 重启桌面后这台设备仍然有效
            persist_pairing(&st).await;
            rpc_response(
                200,
                body,
                Some(device_cookie(&claimed.token, headers.is_https())),
            )
        }
        Err(err) => {
            let (code, message) = match &err {
                PairError::Invalid => (-32001, "配对码无效"),
                PairError::Expired => (-32001, "配对码已过期"),
                PairError::Locked => (-32001, "配对码错误次数过多，已锁定"),
                PairError::RateLimited { .. } => (-32001, "尝试过于频繁"),
                PairError::DeviceLimit => (-32001, "已配对设备达到上限"),
                PairError::Revoked => (-32001, "该 Tailscale 身份已撤销，请用配对码重新认领"),
            };
            let mut details = serde_json::json!({ "reason": err.reason() });
            if let PairError::RateLimited { retry_after_ms } = err {
                details["retryAfterMs"] = serde_json::json!(retry_after_ms);
            }
            let body = jsonrpc_error(id, code, message, "UNAUTHORIZED", Some(details));
            // 与旧 Host 保持一致：配对失败也走 JSON-RPC 错误（HTTP 200），
            // 手机 UI 才能按 details.reason 给出可行动文案。
            rpc_response(200, body, None)
        }
    }
}

// ---- 启停（命令层复用它，测试也可直接调）----

/// 配对设备文件位置（拿不到 app 数据目录 ⇒ `None`，网关退化为纯内存）。
fn pairing_file_of(app: &AppHandle) -> Option<std::path::PathBuf> {
    crate::app_data_dir_path(app)
        .ok()
        .map(|dir| dir.join(PAIRING_FILE))
}

/// 读设备表。坏文件**不阻断启动**（记一行日志，按"没有设备"处理 ⇒ 手机重新配对）。
fn read_pairing_file(path: &std::path::Path) -> Option<PersistedPairing> {
    let text = std::fs::read_to_string(path).ok()?;
    match serde_json::from_str::<PersistedPairing>(&text) {
        Ok(persisted) => Some(persisted),
        Err(e) => {
            eprintln!(
                "[gateway] 配对设备文件损坏，按空设备处理（需要重新配对）：{}",
                e
            );
            None
        }
    }
}

/// 原子写：先写 `.tmp` 再 rename，避免断电留下半份文件（半份文件 = 所有设备掉线）。
fn write_pairing_file(path: &std::path::Path, persisted: &PersistedPairing) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let text = serde_json::to_string_pretty(persisted).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())?;
    Ok(())
}

/// 把当前设备表写盘（配对/撤销后调用）。失败只记日志：内存态仍然正确，重启会退化为重新配对。
async fn persist_pairing(st: &Arc<GatewayState>) {
    let path = st
        .pairing_file
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone();
    let Some(path) = path else { return };
    let persisted = st.pairing.lock().await.export();
    if let Err(e) = write_pairing_file(&path, &persisted) {
        eprintln!("[gateway] 配对设备写盘失败（重启后需要重新配对）：{}", e);
    }
}

fn device_json(view: &pairing::DeviceView) -> serde_json::Value {
    serde_json::json!({
        "id": view.id,
        "name": view.name,
        "platform": view.platform,
        "createdAt": view.created_at,
        "lastSeenAt": view.last_seen_at,
    })
}

/// 启动网关（幂等：已在跑就回当前状态，新绑的端口不会被采用）。
pub async fn start(
    app: AppHandle,
    st: Arc<GatewayState>,
    phone: Arc<PhoneState>,
) -> Result<serde_json::Value, String> {
    if st.inner.lock().await.running {
        return Ok(current_status(&st).await);
    }
    // 先加载静态资源：缺 UI 时启动失败，而不是让手机打开一个空白页。
    let web = GatewayWeb::load(&app)?;
    /**
     * B2：先把上次的设备表读回来（重启桌面后手机直接进入，不用重新配对）。
     *
     * 只读文件、不建网关；文件损坏按空设备处理并记日志（见 `read_pairing_file`）。
     */
    let file = pairing_file_of(&app);
    if let Some(path) = &file {
        if let Some(persisted) = read_pairing_file(path) {
            let restored = st.pairing.lock().await.import(persisted);
            if restored > 0 {
                eprintln!("[gateway] 已恢复 {} 台已配对设备", restored);
            }
        }
    }
    *st.pairing_file
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = file;
    /**
     * 优先固定端口（手机保存的 origin 不变 ⇒ HttpOnly cookie 继续有效）；
     * 被占用时回退随机端口，并在 `status.url` 里报告实际端口（不假装还是 41873）。
     */
    let listener = match TcpListener::bind(("127.0.0.1", PREFERRED_PORT)).await {
        Ok(listener) => listener,
        Err(e) => {
            eprintln!(
                "[gateway] 首选端口 {} 不可用（{}），回退随机端口；手机需要重新保存地址",
                PREFERRED_PORT, e
            );
            TcpListener::bind(BIND_ADDR)
                .await
                .map_err(|e| format!("网关绑定回环端口失败: {}", e))?
        }
    };
    let renderer: Arc<dyn RendererBridge> = Arc::new(TauriBridge::new(app, phone));
    start_with(listener, st, renderer, web).await
}

/// 用给定监听器启动。测试从这里绕开 Tauri `AppHandle`，生产走 `start`。
async fn start_with(
    listener: TcpListener,
    st: Arc<GatewayState>,
    renderer: Arc<dyn RendererBridge>,
    web: GatewayWeb,
) -> Result<serde_json::Value, String> {
    let paired_before = st.pairing.lock().await.device_count();
    let mut g = st.inner.lock().await;
    if g.running {
        return Ok(status_json(true, g.port, paired_before));
    }
    let port = listener
        .local_addr()
        .map_err(|e| format!("读取网关端口失败: {}", e))?
        .port();
    *st.web.lock().await = Some(Arc::new(web));
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    // 事件流的停止信号：与监听任务分开（长连接是独立任务，必须主动断开）。
    let (clients_tx, _clients_rx) = watch::channel(false);
    let handle = tauri::async_runtime::spawn(serve(listener, renderer, st.clone(), shutdown_rx));
    g.running = true;
    g.port = port;
    g.shutdown = Some(shutdown_tx);
    g.handle = Some(handle);
    g.clients_shutdown = Some(clients_tx);
    Ok(status_json(true, port, paired_before))
}

/// 停止网关：先发停止信号，**等监听任务结束**（端口确实关掉）再回状态；
/// 同时断开所有事件流、清空配对状态（码与所有设备 token hash），旧 cookie 全部失效。
pub async fn stop(st: Arc<GatewayState>) -> serde_json::Value {
    let (shutdown, handle, clients_shutdown) = {
        let mut g = st.inner.lock().await;
        (
            g.shutdown.take(),
            g.handle.take(),
            g.clients_shutdown.take(),
        )
    };
    if let Some(tx) = shutdown {
        let _ = tx.send(());
    }
    // 事件流是独立任务：不主动断的话，手机那边会一直挂着一条再也不会产生事件的连接。
    if let Some(tx) = clients_shutdown {
        let _ = tx.send(true);
    }
    // 等监听任务真正结束：监听器在 `serve` 返回时析构，端口随之关闭。
    // 不等它的话，`stop` 返回后端口仍可能在收连接。
    if let Some(h) = handle {
        let _ = h.await;
    }
    st.pairing.lock().await.reset();
    /**
     * 停止 = 撤销全部设备（保持旧语义）：内存清空后**磁盘也清空**，
     * 否则下次启动会把"用户明确停掉时撤销的设备"又恢复回来。
     *
     * 与"重启桌面"区分：进程退出不走这里（不调用 stop），所以崩溃/重启后设备仍在。
     */
    persist_pairing(&st).await;
    *st.web.lock().await = None;
    let mut g = st.inner.lock().await;
    g.running = false;
    g.port = 0;
    status_json(false, 0, 0)
}

pub async fn status(st: Arc<GatewayState>) -> serde_json::Value {
    current_status(&st).await
}

// ---- Tauri 命令 ----

/// 启动 PC 远程网关（loopback、随机端口）。幂等。
#[tauri::command]
pub async fn gateway_start(
    app: AppHandle,
    state: State<'_, Arc<GatewayState>>,
    phone: State<'_, Arc<PhoneState>>,
) -> Result<serde_json::Value, String> {
    start(app, state.inner().clone(), phone.inner().clone()).await
}

/// 停止网关（端口随之关闭；配对状态清空）。
#[tauri::command]
pub async fn gateway_stop(
    state: State<'_, Arc<GatewayState>>,
) -> Result<serde_json::Value, String> {
    Ok(stop(state.inner().clone()).await)
}

/// 读网关状态：`{running, port, url, pairedDevices}`。
#[tauri::command]
pub async fn gateway_status(
    state: State<'_, Arc<GatewayState>>,
) -> Result<serde_json::Value, String> {
    Ok(status(state.inner().clone()).await)
}

/// 已配对设备列表（桌面设置页；**不含 token/hash**）。
#[tauri::command]
pub async fn gateway_devices(
    state: State<'_, Arc<GatewayState>>,
) -> Result<serde_json::Value, String> {
    let views = state.pairing.lock().await.devices();
    Ok(serde_json::json!({
        "devices": views.iter().map(device_json).collect::<Vec<_>>(),
    }))
}

/// 撤销单台设备（旧 cookie 立即失效；其它设备不受影响）。未知 id 幂等返回 `revoked=false`。
#[tauri::command]
pub async fn gateway_device_revoke(
    state: State<'_, Arc<GatewayState>>,
    device_id: String,
) -> Result<serde_json::Value, String> {
    let st = state.inner().clone();
    let revoked = st.pairing.lock().await.revoke(&device_id);
    // 撤销后立刻落盘：否则重启后磁盘上的旧记录会把"已撤销"的设备又带回来
    persist_pairing(&st).await;
    Ok(serde_json::json!({ "revoked": revoked }))
}

/// 生成一次性 6 位配对码。只在网关运行时可用；码只存在内存，5 分钟/单次有效。
#[tauri::command]
pub async fn gateway_pair_start(
    state: State<'_, Arc<GatewayState>>,
) -> Result<serde_json::Value, String> {
    let running = state.inner.lock().await.running;
    if !running {
        return Err("网关尚未启动".to_string());
    }
    let code = state.pairing.lock().await.new_code(crate::phone::now_ms());
    Ok(serde_json::json!({
        "code": code.code,
        "expiresAt": code.expires_at,
        "ttlMs": code.ttl_ms,
    }))
}

/// 渲染层发布一条桌面循环事件：网关分配序号并广播给已配对设备。
///
/// 这是 `/events` 的**唯一**入口，只由渲染层调用（不是 HTTP 路由）。载荷与事件名
/// 都在 `events.rs` 校验；发布成功返回本次分配的 `seq`（诊断/回执用）。
#[tauri::command]
pub async fn gateway_publish_event(
    state: State<'_, Arc<GatewayState>>,
    session_id: String,
    event_type: String,
    payload: serde_json::Value,
    run_id: Option<String>,
) -> Result<serde_json::Value, String> {
    let event = state
        .events
        .publish(&session_id, &event_type, payload, run_id)?;
    Ok(serde_json::json!({ "seq": event.seq, "type": event.kind }))
}

// ---- 单测 ----

#[cfg(test)]
mod tests {
    use super::*;
    use crate::phone::http::Request as HttpRequest;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex as StdMutex;
    use tokio::io::AsyncReadExt;
    use tokio::time::Duration;

    /// 假渲染层：记录被调用的 method/path，返回可选 JSON-RPC 结果。
    #[derive(Default)]
    struct FakeRenderer {
        calls: AtomicUsize,
        seen: StdMutex<Vec<(String, String)>>,
    }

    impl FakeRenderer {
        fn calls(&self) -> usize {
            self.calls.load(Ordering::SeqCst)
        }

        fn seen(&self) -> Vec<(String, String)> {
            self.seen.lock().expect("seen").clone()
        }
    }

    impl RendererBridge for FakeRenderer {
        fn forward<'a>(&'a self, req: HttpRequest) -> bridge::BoxFuture<'a, HttpResponse> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.seen
                .lock()
                .expect("seen")
                .push((req.method.clone(), req.path.clone()));
            Box::pin(async {
                HttpResponse::json(
                    200,
                    serde_json::json!({
                        "jsonrpc": "2.0",
                        "id": 1,
                        "result": { "ok": true, "source": "fake-renderer" }
                    }),
                )
            })
        }
    }

    fn test_web() -> GatewayWeb {
        GatewayWeb::from_parts(
            "<!doctype html><html><head><title>Codem Remote</title></head><body><div id=\"app\"></div><script src=\"ui.js\"></script></body></html>",
            b"window.__test = true;".to_vec(),
            b"body{}".to_vec(),
        )
        .expect("test web")
    }

    async fn start_test_server(fake: Arc<FakeRenderer>) -> (Arc<GatewayState>, u16) {
        let st = GatewayState::new();
        let listener = TcpListener::bind(BIND_ADDR).await.expect("bind");
        let port = listener.local_addr().expect("addr").port();
        assert_ne!(port, 0);
        let started = start_with(listener, st.clone(), fake, test_web())
            .await
            .expect("start");
        assert_eq!(started["running"], true);
        assert_eq!(started["port"], port);
        (st, port)
    }

    async fn raw(port: u16, text: &str) -> String {
        let mut s = TcpStream::connect(("127.0.0.1", port))
            .await
            .expect("connect");
        s.write_all(text.as_bytes()).await.expect("write");
        let mut buf = Vec::new();
        let _ = timeout(Duration::from_secs(5), s.read_to_end(&mut buf)).await;
        String::from_utf8_lossy(&buf).into_owned()
    }

    fn rpc_body(method: &str, params: serde_json::Value) -> String {
        serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": method,
            "params": params
        })
        .to_string()
    }

    async fn post_rpc(port: u16, body: &str, cookie: Option<&str>) -> String {
        let cookie_header = cookie
            .map(|c| format!("Cookie: {}\r\n", c))
            .unwrap_or_default();
        let req = format!(
            "POST /rpc HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n{}\r\n{}",
            port,
            body.as_bytes().len(),
            cookie_header,
            body
        );
        raw(port, &req).await
    }

    async fn post_rpc_with_headers(
        port: u16,
        host: &str,
        extra_headers: &str,
        body: &str,
    ) -> String {
        let req = format!(
            "POST /rpc HTTP/1.1\r\nHost: {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n{}\r\n{}",
            host,
            body.as_bytes().len(),
            extra_headers,
            body
        );
        raw(port, &req).await
    }

    fn cookie_from(resp: &str) -> String {
        for line in resp.split("\r\n") {
            if let Some(value) = line.strip_prefix("Set-Cookie: ") {
                return value.split(';').next().unwrap_or("").to_string();
            }
            if let Some(value) = line.strip_prefix("set-cookie: ") {
                return value.split(';').next().unwrap_or("").to_string();
            }
        }
        panic!("响应里没有 Set-Cookie: {}", resp);
    }

    /// 真 TCP 配对一次，返回可用的设备 cookie（事件流/RPC 共用同一份鉴权）。
    async fn pair_device(st: &Arc<GatewayState>, port: u16) -> String {
        let code = st
            .pairing
            .lock()
            .await
            .new_code(crate::phone::now_ms())
            .code;
        let body = rpc_body("pair.claim", serde_json::json!({ "code": code }));
        let claimed = post_rpc(port, &body, None).await;
        assert!(claimed.starts_with("HTTP/1.1 200 OK"), "{}", claimed);
        cookie_from(&claimed)
    }

    /// 打开一条 `/events` 连接并写请求（不读到 EOF：SSE 是长连接）。
    async fn open_stream(
        port: u16,
        query: &str,
        cookie: &str,
        last_event_id: Option<u64>,
    ) -> TcpStream {
        let mut stream = TcpStream::connect(("127.0.0.1", port))
            .await
            .expect("connect");
        let last = last_event_id
            .map(|id| format!("Last-Event-ID: {}\r\n", id))
            .unwrap_or_default();
        let req = format!(
            "GET /events?{} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nCookie: {}\r\n{}\r\n",
            query, port, cookie, last
        );
        stream.write_all(req.as_bytes()).await.expect("write");
        stream
    }

    /// 读到出现 `needle` 为止（超时/提前关闭都判失败）。返回累计字节。
    ///
    /// 只用于判据：一次只断言一个特征，不假设后面还有别的帧。
    async fn read_until(stream: &mut TcpStream, needle: &str, timeout_ms: u64) -> String {
        let mut buf: Vec<u8> = Vec::new();
        let deadline = tokio::time::Instant::now() + Duration::from_millis(timeout_ms);
        loop {
            let text = String::from_utf8_lossy(&buf).into_owned();
            if text.contains(needle) {
                return text;
            }
            let remain = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remain.is_zero() {
                panic!("等待 {:?} 超时；已收到：{}", needle, text);
            }
            let mut chunk = [0u8; 4096];
            match timeout(remain, stream.read(&mut chunk)).await {
                Ok(Ok(0)) => panic!("连接提前关闭；已收到：{}", text),
                Ok(Ok(n)) => buf.extend_from_slice(&chunk[..n]),
                Ok(Err(e)) => panic!("读取事件流失败：{}；已收到：{}", e, text),
                Err(_) => panic!("等待 {:?} 超时；已收到：{}", needle, text),
            }
        }
    }

    fn json_type(name: &str) -> String {
        format!("\"type\":\"{}\"", name)
    }

    /// 安静窗口：收 `quiet_ms` 内到达的所有字节（没有数据就返回空串）。
    ///
    /// 用于证明"**没有**补发"这类否定断言 —— `read_until` 只等到第一个特征就返回，
    /// 看不见紧跟其后的多余帧（变异自证时真的漏过：把 since=0 的"只直播"改坏，
    /// 历史帧在 ready 之后才到，`read_until(ready)` 依然绿）。
    async fn read_quiet(stream: &mut TcpStream, quiet_ms: u64) -> String {
        let mut buf: Vec<u8> = Vec::new();
        loop {
            let mut chunk = [0u8; 4096];
            match timeout(Duration::from_millis(quiet_ms), stream.read(&mut chunk)).await {
                Ok(Ok(0)) => break,
                Ok(Ok(n)) => buf.extend_from_slice(&chunk[..n]),
                _ => break,
            }
        }
        String::from_utf8_lossy(&buf).into_owned()
    }

    #[test]
    fn only_known_routes_are_answered() {
        assert_eq!(classify("GET", "/health"), Route::Health);
        assert_eq!(classify("POST", "/health"), Route::MethodNotAllowed);
        assert_eq!(classify("POST", "/rpc"), Route::Rpc);
        assert_eq!(classify("GET", "/rpc"), Route::MethodNotAllowed);
        assert_eq!(classify("GET", "/events"), Route::Events);
        assert_eq!(classify("POST", "/events"), Route::MethodNotAllowed);
        assert_eq!(classify("GET", "/"), Route::Asset(Asset::Index));
        assert_eq!(classify("GET", "/ui.js"), Route::Asset(Asset::UiJs));
        assert_eq!(classify("GET", "/ui.css"), Route::Asset(Asset::UiCss));
        // 旧 LAN 的路由与写接口都不能被网关认领
        for path in ["/api/sessions", "/pair", "/ca.crt", "/rpc/extra"] {
            assert_eq!(classify("GET", path), Route::NotFound, "{}", path);
        }
    }

    #[test]
    fn origin_check_is_exact() {
        assert!(origin_allowed(None, Some("127.0.0.1:1234")));
        assert!(origin_allowed(
            Some("http://127.0.0.1:1234"),
            Some("127.0.0.1:1234")
        ));
        assert!(!origin_allowed(
            Some("http://evil.test"),
            Some("127.0.0.1:1234")
        ));
        assert!(!origin_allowed(Some("null"), Some("127.0.0.1:1234")));
        assert!(!origin_allowed(Some("http://127.0.0.1:1234"), None));
    }

    /// B4：隧道/自有域名下的 Host 白名单，以及 HTTPS 时才下发 `Secure` cookie。
    #[test]
    fn host_allowlist_and_secure_cookie() {
        assert!(host_allowed(Some("127.0.0.1:41873")));
        assert!(host_allowed(Some("localhost:41873")));
        assert!(host_allowed(Some("[::1]:41873")));
        assert!(host_allowed(Some("random-words-123.trycloudflare.com")));
        assert!(host_allowed(Some("desktop.tailnet-abc.ts.net")));
        assert!(!host_allowed(Some("evil.example.com")));
        assert!(!host_allowed(Some("127.0.0.1.evil.com")));

        assert!(!device_cookie("tok", false).contains("Secure"));
        assert!(device_cookie("tok", true).contains("Secure"));
        assert!(device_cookie("tok", true).contains("HttpOnly"));
        assert!(device_cookie("tok", true).contains("SameSite=Strict"));

        let tunnel = RequestHeaders::from_head(
            "POST /rpc HTTP/1.1\r\nHost: x.trycloudflare.com\r\nX-Forwarded-Proto: https\r\n\r\n",
        );
        assert!(tunnel.is_https());
        let loopback = RequestHeaders::from_head("POST /rpc HTTP/1.1\r\nHost: 127.0.0.1:1\r\n\r\n");
        assert!(!loopback.is_https());
    }

    #[tokio::test]
    async fn static_ui_is_served_unmodified() {
        let fake = Arc::new(FakeRenderer::default());
        let (st, port) = start_test_server(fake.clone()).await;

        let index = raw(port, "GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").await;
        assert!(index.starts_with("HTTP/1.1 200 OK"), "{}", index);
        assert!(index.contains("text/html"));
        // M2：页面不再被网关注入只读标记；写模式由 host.hello.capabilities 决定。
        assert!(
            !index.contains("__CODEM_GATEWAY_READ_ONLY__"),
            "只读标记已删除，网关不得再改写共享 UI：{}",
            index
        );

        let js = raw(port, "GET /ui.js HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").await;
        assert!(js.starts_with("HTTP/1.1 200 OK"), "{}", js);
        assert!(js.contains("window.__test"));
        assert_eq!(fake.calls(), 0, "静态资源不该经过渲染层");

        let traversal = raw(port, "GET /..%2Fsecret HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").await;
        assert!(
            traversal.starts_with("HTTP/1.1 404 Not Found"),
            "{}",
            traversal
        );
        assert_eq!(fake.calls(), 0);

        stop(st).await;
    }

    #[tokio::test]
    async fn health_is_forwarded_but_unknown_is_local() {
        let fake = Arc::new(FakeRenderer::default());
        let (st, port) = start_test_server(fake.clone()).await;

        let ok = raw(port, "GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").await;
        assert!(ok.starts_with("HTTP/1.1 200 OK"), "{}", ok);
        assert!(ok.contains("fake-renderer"), "{}", ok);
        assert_eq!(fake.calls(), 1);
        assert_eq!(fake.seen(), vec![("GET".into(), "/health".into())]);

        let missing = raw(port, "GET /nope HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").await;
        assert!(missing.starts_with("HTTP/1.1 404 Not Found"), "{}", missing);
        assert_eq!(fake.calls(), 1, "404 是网关自己答的，不该惊动渲染层");

        stop(st).await;
    }

    #[test]
    fn write_step_whitelist_is_exact() {
        // 白名单是"网关到底开放了什么"的**唯一**事实来源：多一行 = 手机可能出现
        // 一个点不通的入口；少一行 = 渲染层实现了也永远到不了。
        assert_eq!(
            RPC_ALLOWED_METHODS.to_vec(),
            vec![
                "host.hello",
                "host.diagnostics",
                "session.list",
                "session.get",
                "session.create",
                "project.list",
                "project.create",
                "prompt.send",
                "run.cancel",
                "approval.list",
                "approval.respond",
                "workspace.list",
                "workspace.read",
                "workspace.diff",
                "session.changes",
                "session.change.diff",
            ]
        );
        // 还没做的那些：引导 / 附件
        for banned in ["run.guidance", "attachment.put", "events"] {
            assert!(
                !RPC_ALLOWED_METHODS.contains(&banned),
                "{} 还不在 M3 白名单里，不能进网关白名单",
                banned
            );
        }
    }

    #[tokio::test]
    async fn rpc_requires_pairing_and_forwards_only_the_whitelist() {
        let fake = Arc::new(FakeRenderer::default());
        let (st, port) = start_test_server(fake.clone()).await;

        // 未配对：host.hello 必须被 401；渲染层一次都不该被叫。
        let unauth = post_rpc(port, &rpc_body("host.hello", serde_json::json!({})), None).await;
        assert!(
            unauth.starts_with("HTTP/1.1 401 Unauthorized"),
            "{}",
            unauth
        );
        assert_eq!(fake.calls(), 0);

        // 未配对：写方法同样在鉴权这一层就被挡（不靠白名单顺序）。
        let unauth_send = post_rpc(
            port,
            &rpc_body(
                "prompt.send",
                serde_json::json!({ "sessionId": "s", "text": "hi" }),
            ),
            None,
        )
        .await;
        assert!(
            unauth_send.starts_with("HTTP/1.1 401 Unauthorized"),
            "{}",
            unauth_send
        );
        assert_eq!(fake.calls(), 0);

        // 生成码 → 兑换 → 拿 cookie。
        let code = st
            .pairing
            .lock()
            .await
            .new_code(crate::phone::now_ms())
            .code;
        let claim_body = rpc_body(
            "pair.claim",
            serde_json::json!({ "code": code, "deviceName": "Test Phone", "platform": "web" }),
        );
        let claimed = post_rpc(port, &claim_body, None).await;
        assert!(claimed.starts_with("HTTP/1.1 200 OK"), "{}", claimed);
        assert!(
            claimed.contains("\"hostId\":\"codem-desktop\""),
            "{}",
            claimed
        );
        let cookie = cookie_from(&claimed);
        assert!(cookie.starts_with("codem_gateway_device="), "{}", cookie);
        assert!(claimed.contains("HttpOnly"), "{}", claimed);
        assert!(claimed.contains("SameSite=Strict"), "{}", claimed);
        assert!(claimed.contains("Max-Age="), "{}", claimed);
        let token = cookie.trim_start_matches("codem_gateway_device=");
        let response_body = claimed.split("\r\n\r\n").nth(1).unwrap_or("");
        assert!(
            !response_body.contains(token),
            "设备 token 不得出现在响应体里（只允许 Set-Cookie）"
        );

        // 已配对：只读方法转发给渲染层。
        let hello = post_rpc(
            port,
            &rpc_body("host.hello", serde_json::json!({ "protocolVersion": 1 })),
            Some(&cookie),
        )
        .await;
        assert!(hello.starts_with("HTTP/1.1 200 OK"), "{}", hello);
        assert_eq!(fake.calls(), 1);
        assert_eq!(fake.seen(), vec![("POST".into(), "/rpc".into())]);

        // M2 写路径第一批：prompt.send 必须**到达**渲染层（受理/拒绝由渲染层判断，
        // 网关不替它编造结果）。
        let send = post_rpc(
            port,
            &rpc_body(
                "prompt.send",
                serde_json::json!({
                    "sessionId": "s",
                    "text": "hi",
                    "requestId": "chat-1-1",
                    "clientId": "client-test",
                }),
            ),
            Some(&cookie),
        )
        .await;
        assert!(send.starts_with("HTTP/1.1 200 OK"), "{}", send);
        assert_eq!(fake.calls(), 2, "prompt.send 必须交给渲染层");
        assert!(
            send.contains("fake-renderer"),
            "应答必须来自渲染层：{}",
            send
        );

        // run.cancel 同上。
        let cancel = post_rpc(
            port,
            &rpc_body("run.cancel", serde_json::json!({ "runId": "run-1" })),
            Some(&cookie),
        )
        .await;
        assert!(cancel.starts_with("HTTP/1.1 200 OK"), "{}", cancel);
        assert_eq!(fake.calls(), 3, "run.cancel 必须交给渲染层");

        // M2：审批两条也必须到达渲染层（读/答都走桌面既有审批代理，网关不编结果）。
        for method in ["approval.list", "approval.respond"] {
            let reply = post_rpc(
                port,
                &rpc_body(method, serde_json::json!({})),
                Some(&cookie),
            )
            .await;
            assert!(reply.starts_with("HTTP/1.1 200 OK"), "{} {}", method, reply);
            assert!(
                reply.contains("fake-renderer"),
                "{} 必须交给渲染层：{}",
                method,
                reply
            );
        }
        assert_eq!(fake.calls(), 5, "approval.* 必须交给渲染层");

        // M3：工作区三条只读方法也必须**到达**渲染层（边界/敏感判定由渲染层注入的数据层做，
        // 网关只做鉴权与白名单，不替它编造文件内容）。
        for method in ["workspace.list", "workspace.read", "workspace.diff"] {
            let reply = post_rpc(
                port,
                &rpc_body(method, serde_json::json!({})),
                Some(&cookie),
            )
            .await;
            assert!(reply.starts_with("HTTP/1.1 200 OK"), "{} {}", method, reply);
            assert!(
                reply.contains("fake-renderer"),
                "{} 必须交给渲染层：{}",
                method,
                reply
            );
        }
        assert_eq!(fake.calls(), 8, "workspace.* 必须交给渲染层");

        // M3：变更记录两条只读方法也必须**到达**渲染层（数据来自桌面库与 git 对象，
        // 网关只做鉴权与白名单，不替它编造记录）。
        for method in ["session.changes", "session.change.diff"] {
            let reply = post_rpc(
                port,
                &rpc_body(method, serde_json::json!({})),
                Some(&cookie),
            )
            .await;
            assert!(reply.starts_with("HTTP/1.1 200 OK"), "{} {}", method, reply);
            assert!(
                reply.contains("fake-renderer"),
                "{} 必须交给渲染层：{}",
                method,
                reply
            );
        }
        assert_eq!(fake.calls(), 10, "session.changes* 必须交给渲染层");

        // B1：项目面三条也必须到达渲染层（真正的校验/写入在 `gateway-engine` 与桌面存储）
        for method in ["session.create", "project.list", "project.create"] {
            let reply = post_rpc(
                port,
                &rpc_body(method, serde_json::json!({})),
                Some(&cookie),
            )
            .await;
            assert!(reply.starts_with("HTTP/1.1 200 OK"), "{} {}", method, reply);
            assert!(
                reply.contains("fake-renderer"),
                "{} 必须交给渲染层：{}",
                method,
                reply
            );
        }
        assert_eq!(fake.calls(), 13, "项目面三条必须交给渲染层");

        // 还没实现的方法：网关层拒绝，渲染层调用数不变。
        for method in ["run.guidance", "attachment.put"] {
            let write = post_rpc(
                port,
                &rpc_body(method, serde_json::json!({})),
                Some(&cookie),
            )
            .await;
            assert!(write.starts_with("HTTP/1.1 200 OK"), "{} {}", method, write);
            assert!(write.contains("UNSUPPORTED"), "{}: {}", method, write);
        }
        assert_eq!(fake.calls(), 13, "未实现的方法不得到达渲染层");

        // /events 未配对必须是 401（JSON 错误，不能是事件流），且**不经过渲染层**。
        let events = raw(
            port,
            "GET /events?sessionId=s HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n",
        )
        .await;
        assert!(
            events.starts_with("HTTP/1.1 401 Unauthorized"),
            "{}",
            events
        );
        assert!(!events.contains("text/event-stream"), "{}", events);
        assert_eq!(fake.calls(), 13, "事件流不该转发给渲染层");

        stop(st).await;
    }

    #[test]
    fn tailscale_identity_requires_loopback_and_serve_host() {
        let head = "Host: win-test.tailnet.ts.net\r\nTailscale-User-Login: user@example.com\r\n";
        let headers = RequestHeaders::from_head(head);
        assert!(
            headers.tailscale_identity(true).is_some(),
            "Serve 的 loopback 请求应被信任"
        );
        assert!(
            headers.tailscale_identity(false).is_none(),
            "非 loopback 请求即使带头也不能信"
        );

        let funnel = RequestHeaders::from_head(
            "Host: win-test.tailnet.ts.net\r\nTailscale-User-Login: user@example.com\r\nTailscale-Funnel-Request: ?1\r\n",
        );
        assert!(funnel.tailscale_identity(true).is_none(), "Funnel 必须拒绝");
    }

    #[tokio::test]
    async fn tailscale_serve_identity_bootstraps_a_device_without_a_code() {
        let fake = Arc::new(FakeRenderer::default());
        let (st, port) = start_test_server(fake.clone()).await;
        let body = rpc_body("host.hello", serde_json::json!({ "protocolVersion": 1 }));
        let resp = post_rpc_with_headers(
            port,
            "win-test.tailnet.ts.net",
            "Tailscale-User-Login: user@example.com\r\nTailscale-User-Name: User\r\n",
            &body,
        )
        .await;
        assert!(resp.starts_with("HTTP/1.1 200 OK"), "{}", resp);
        assert!(
            resp.contains("Set-Cookie: codem_gateway_device="),
            "{}",
            resp
        );
        assert_eq!(fake.calls(), 1, "身份可信时必须放行到渲染层");

        let devices = st.pairing.lock().await.devices();
        assert_eq!(devices.len(), 1);
        assert!(devices[0].name.contains("User"));
        stop(st).await;
    }

    #[tokio::test]
    async fn tailscale_identity_is_not_trusted_for_funnel_or_non_tailnet_hosts() {
        let fake = Arc::new(FakeRenderer::default());
        let (st, port) = start_test_server(fake.clone()).await;
        let body = rpc_body("host.hello", serde_json::json!({ "protocolVersion": 1 }));

        // Funnel：显式标记，必须拒绝。
        let funnel = post_rpc_with_headers(
            port,
            "win-test.tailnet.ts.net",
            "Tailscale-User-Login: user@example.com\r\nTailscale-Funnel-Request: ?1\r\n",
            &body,
        )
        .await;
        assert!(
            funnel.starts_with("HTTP/1.1 401 Unauthorized"),
            "{}",
            funnel
        );
        assert!(!funnel.contains("Set-Cookie"), "{}", funnel);

        // 非 ts.net：即使有头也不信。
        let other_host = post_rpc_with_headers(
            port,
            "127.0.0.1",
            "Tailscale-User-Login: user@example.com\r\n",
            &body,
        )
        .await;
        assert!(
            other_host.starts_with("HTTP/1.1 401 Unauthorized"),
            "{}",
            other_host
        );

        // 畸形登录：拒绝。
        let malformed = post_rpc_with_headers(
            port,
            "win-test.tailnet.ts.net",
            "Tailscale-User-Login: not-an-email\r\n",
            &body,
        )
        .await;
        assert!(
            malformed.starts_with("HTTP/1.1 401 Unauthorized"),
            "{}",
            malformed
        );
        assert_eq!(fake.calls(), 0);
        stop(st).await;
    }

    #[tokio::test]
    async fn pairing_rejects_wrong_code_without_cookie() {
        let fake = Arc::new(FakeRenderer::default());
        let (st, port) = start_test_server(fake).await;
        let body = rpc_body("pair.claim", serde_json::json!({ "code": "000000" }));
        let resp = post_rpc(port, &body, None).await;
        assert!(resp.starts_with("HTTP/1.1 200 OK"), "{}", resp);
        assert!(resp.contains("UNAUTHORIZED"), "{}", resp);
        assert!(!resp.contains("Set-Cookie"), "{}", resp);
        stop(st).await;
    }

    #[tokio::test]
    async fn start_is_idempotent_and_stop_closes_the_port_and_pairing() {
        let fake = Arc::new(FakeRenderer::default());
        let st = GatewayState::new();
        let listener = TcpListener::bind(BIND_ADDR).await.expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let started = start_with(listener, st.clone(), fake.clone(), test_web())
            .await
            .expect("start");
        assert_eq!(started["running"], true);
        assert_eq!(started["port"], port);
        assert_eq!(started["url"], format!("http://127.0.0.1:{}", port));

        // 幂等：再给一个新监听器也不该换端口（新监听器随返回值一起丢弃）
        let again = start_with(
            TcpListener::bind(BIND_ADDR).await.expect("bind2"),
            st.clone(),
            fake,
            test_web(),
        )
        .await
        .expect("start again");
        assert_eq!(again["port"], port);

        let ok = raw(port, "GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").await;
        assert!(ok.starts_with("HTTP/1.1 200 OK"), "{}", ok);

        // 停止后：端口关闭 + 配对状态清空。
        let stopped = stop(st.clone()).await;
        assert_eq!(stopped["running"], false);
        assert_eq!(stopped["port"], 0);
        assert_eq!(stopped["pairedDevices"], 0);
        assert!(stopped["url"].is_null());
        assert!(
            TcpStream::connect(("127.0.0.1", port)).await.is_err(),
            "stop 返回后端口必须已关闭（stop 必须等监听任务结束，不能只改状态）"
        );
        assert_eq!(st.pairing.lock().await.device_count(), 0);
    }

    #[tokio::test]
    async fn events_require_pairing_and_a_valid_session_param() {
        let fake = Arc::new(FakeRenderer::default());
        let (st, port) = start_test_server(fake.clone()).await;

        // 未配对：401 + JSON（不是事件流；EventSource 对非 200 不重试）。
        let unauth = raw(
            port,
            "GET /events?sessionId=s1 HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n",
        )
        .await;
        assert!(
            unauth.starts_with("HTTP/1.1 401 Unauthorized"),
            "{}",
            unauth
        );
        assert!(!unauth.contains("text/event-stream"), "{}", unauth);

        let cookie = pair_device(&st, port).await;

        // 缺 sessionId：400（事件流必须按会话过滤，不允许"全量"）。
        let missing = raw(
            port,
            &format!(
                "GET /events HTTP/1.1\r\nHost: 127.0.0.1\r\nCookie: {}\r\n\r\n",
                cookie
            ),
        )
        .await;
        assert!(
            missing.starts_with("HTTP/1.1 400 Bad Request"),
            "{}",
            missing
        );
        assert!(missing.contains("sessionId"), "{}", missing);

        // sinceSeq 非数字：400，不猜成 0（猜会导致"以为续传了其实重放了一遍"）。
        let bad_since = raw(
            port,
            &format!(
                "GET /events?sessionId=s1&sinceSeq=abc HTTP/1.1\r\nHost: 127.0.0.1\r\nCookie: {}\r\n\r\n",
                cookie
            ),
        )
        .await;
        assert!(
            bad_since.starts_with("HTTP/1.1 400 Bad Request"),
            "{}",
            bad_since
        );

        // POST /events：405（事件流是 GET 长连接）。
        let post = raw(
            port,
            &format!(
                "POST /events?sessionId=s1 HTTP/1.1\r\nHost: 127.0.0.1\r\nCookie: {}\r\nContent-Length: 0\r\n\r\n",
                cookie
            ),
        )
        .await;
        assert!(
            post.starts_with("HTTP/1.1 405 Method Not Allowed"),
            "{}",
            post
        );

        assert_eq!(fake.calls(), 0, "事件流鉴权/参数错误都不该惊动渲染层");
        stop(st).await;
    }

    #[tokio::test]
    async fn events_stream_live_then_resume_without_duplicates() {
        let fake = Arc::new(FakeRenderer::default());
        let (st, port) = start_test_server(fake.clone()).await;
        let cookie = pair_device(&st, port).await;

        // 连接前就有一条"历史"：新连接（没有 Last-Event-ID）**不该**收到它。
        let old = st
            .events
            .publish(
                "s1",
                "assistant.text",
                serde_json::json!({ "text": "旧文本" }),
                None,
            )
            .expect("old");
        assert_eq!(old.seq, 1);

        let mut first = open_stream(port, "sessionId=s1", &cookie, None).await;
        let head = read_until(&mut first, &json_type("gateway.ready"), 3000).await;
        assert!(head.starts_with("HTTP/1.1 200 OK"), "{}", head);
        assert!(head.contains("text/event-stream"), "{}", head);
        assert!(head.contains("retry: 2000"), "{}", head);
        assert!(!head.contains("旧文本"), "新连接不该重放历史正文：{}", head);
        // ready 之后紧跟的安静窗口里也不许冒出历史帧（否定断言必须看得见"后面"）。
        let after_ready = read_quiet(&mut first, 150).await;
        assert!(
            !after_ready.contains("旧文本"),
            "新连接只直播、不补发历史；却收到了：{}",
            after_ready
        );

        // 直播事件：seq=2，帧里带 id。
        st.events
            .publish(
                "s1",
                "tool.start",
                serde_json::json!({ "id": "c1", "name": "read", "args": { "path": "a.ts" } }),
                Some("run-1".into()),
            )
            .expect("live");
        let live = read_until(&mut first, &json_type("tool.start"), 3000).await;
        assert!(live.contains("id: 2"), "{}", live);
        assert!(live.contains("\"runId\":\"run-1\""), "{}", live);
        drop(first);

        // 断开期间又发生了一条：重连带 Last-Event-ID: 2 ⇒ 只补 seq=3。
        st.events
            .publish(
                "s1",
                "run.finished",
                serde_json::json!({ "state": "succeeded" }),
                Some("run-1".into()),
            )
            .expect("terminal");
        let mut resumed = open_stream(port, "sessionId=s1", &cookie, Some(2)).await;
        let replay = read_until(&mut resumed, &json_type("run.finished"), 3000).await;
        assert!(replay.contains("id: 3"), "终态必须补发：{}", replay);
        assert!(
            !replay.contains(&json_type("tool.start")),
            "已收到的不许重复补发：{}",
            replay
        );

        // 其它会话的事件不得串台（即使在同一序号空间里）。
        st.events
            .publish(
                "s2",
                "assistant.text",
                serde_json::json!({ "text": "别的会话" }),
                None,
            )
            .expect("other session");
        let mut crossed = open_stream(port, "sessionId=s1", &cookie, Some(3)).await;
        let after = read_until(&mut crossed, &json_type("gateway.ready"), 3000).await;
        assert!(after.contains("\"latest\":4"), "{}", after);
        assert!(!after.contains("别的会话"), "{}", after);

        assert_eq!(fake.calls(), 0, "事件流整条链路都不经过渲染层");
        stop(st).await;
    }

    #[tokio::test]
    async fn stop_closes_live_event_streams() {
        let fake = Arc::new(FakeRenderer::default());
        let (st, port) = start_test_server(fake).await;
        let cookie = pair_device(&st, port).await;
        let mut stream = open_stream(port, "sessionId=s1", &cookie, None).await;
        read_until(&mut stream, "gateway.ready", 3000).await;

        stop(st.clone()).await;
        let mut chunk = [0u8; 64];
        let n = timeout(Duration::from_secs(3), stream.read(&mut chunk))
            .await
            .expect("stop 后事件流必须断开（否则手机挂在一条永远没有事件的连接上）")
            .expect("read");
        assert_eq!(n, 0, "stop 后事件流应收到 EOF");
    }
}
