// ============================================================
// phone/mod.rs — @codem/phone-link 传输层（①手机连接，dsh-phone 对标）
//
// Codem 桌面 bundle 无 HTTP server 宿主（host-webserver 等被禁用），
// 引擎又活在 WebView TS——本模块补齐"手机可访问的 UI + API"地基。
//
// ## 第 122 轮阶段 1 之后的拓扑（安全对齐）
//
//   手机浏览器 ──HTTPS(LAN, 自签 CA)──▶ [TLS 边缘 0.0.0.0]
//                                          │ Host 白名单 + 拒跨站 + 注入边缘标记
//                                          ▼
//                                    [上游 HTTP 127.0.0.1]  ← 只认带标记的请求
//                                          │ event
//                                          ▼
//                                    [WebView TS phone-link]（会话/消息/chat）
//
// **局域网上没有明文监听**：上游只绑回环，唯一入口是 TLS 边缘。
// 这一条是这一阶段的全部意义 —— 不是"HTTP 也开着、HTTPS 也开着"。
//
// 配对模型对标 EAC phone-bridge.ts：
//   - 桌面 start → 边缘绑 0.0.0.0:0（OS 随机端口）+ 准备自签 CA/叶子证书
//     ⇒ 生成 HTTPS 配对 URL（token 随机，5min TTL）
//   - 手机首次访问会看到自签证书警告；**用户必须核对桌面显示的 CA 指纹**
//     （自签方案里唯一能挡中间人的一步），见 PhoneLinkSettings
//   - 手机开 /pair?token → 等待页轮询 /api/pair-state
//   - 桌面 decide(approve) → 生成会话 secret → pair-state 返回 Set-Cookie
//     codem_phone=<secret>; HttpOnly; Secure; SameSite=Strict; Max-Age=30天
//   - 之后 /api/* 全部带 cookie，secret 以 sha256 落盘 devices.json（重启保配对）
//
// 诚实标注：本模块不编造数据——所有会话/消息/回复来自 WebView 引擎侧；
// 引擎不在时 /api/* 返回 502。
//
// **仍然没做的**（阶段 3 范围内）：跨网络可达（现在只覆盖同一局域网）。
// 证书是自签的 ⇒ 手机上一次"信任"是必须的，且**没有**公共 CA 兜底；
// 因此"核对指纹"不是可选项。
// ============================================================

pub mod guard;
pub mod http;
pub mod lan;
pub mod tls;

#[cfg(test)]
mod edge_test;

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
/// 会话 cookie 寿命（秒）。第 122 轮阶段 1：**从 31536000（1 年）收到 30 天**。
///
/// 为什么收：这是一条"能读你全部会话、还能让 agent 干活"的凭据，
/// 而手机丢在抽屉里、借给别人看、卖掉都是常态。1 年不失效等于
/// "配过一次就永久有效"。30 天足够日常使用，且让"设备丢了"这件事
/// 有一个自然的失效上限（用户也可以随时在桌面取消配对）。
const COOKIE_MAX_AGE_SECS: i64 = 30 * 24 * 3600;
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
    /// 批准后生成的会话 secret（明文仅驻留配对 TTL 内，用于 pair-state
    /// 重复轮询重放 Set-Cookie——弱网下首条响应丢失时手机不致永久 401）。
    pub approved_secret: Option<String>,
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
    // ---- 第 122 轮阶段 1：TLS 边缘 ----
    /// 上游（明文 HTTP）端口，**只绑 127.0.0.1**。
    pub upstream_port: u16,
    /// 边缘（HTTPS）端口，绑 0.0.0.0 —— 手机连的是这个。
    pub tls_port: u16,
    /// 边缘注入的标记（每次 start 重新随机；只存在于进程内存）。
    pub edge_token: String,
    /// CA 指纹（大写 hex，冒号分隔）——给桌面显示，供用户**带外**核对，
    /// 这是自签方案里唯一能抗中间人的一步。
    pub ca_fingerprint: String,
    /// CA 证书 PEM（供手机安装；它是公开信息，不是密钥）。
    pub ca_pem: String,
    /// TLS 边缘的监听句柄。
    pub tls_handle: Option<tauri::async_runtime::JoinHandle<()>>,
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
            upstream_port: 0,
            tls_port: 0,
            edge_token: String::new(),
            ca_fingerprint: String::new(),
            ca_pem: String::new(),
            tls_handle: None,
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

/// 常数时间字符串比较。
///
/// 第 122 轮阶段 1 修正：原来在长度不等时**提前返回 false** ——
/// 那会通过响应时间泄露"长度对不对"。对固定的随机 hex（32 字符）这条在实践中
/// 触发不了，但提前返回本身是没必要的，去掉它让这个原语**在任何输入下**都成立。
///
/// 现在的形状：以较长者为迭代长度（短的一侧越界读 0），全程累积 XOR，
/// 最后把"长度是否相等"一并折进结果。
pub fn timing_safe_eq(a: &str, b: &str) -> bool {
    let (ab, bb) = (a.as_bytes(), b.as_bytes());
    let mut diff: u8 = 0;
    let n = ab.len().max(bb.len());
    for i in 0..n {
        let x = *ab.get(i).unwrap_or(&0);
        let y = *bb.get(i).unwrap_or(&0);
        diff |= x ^ y;
    }
    // ⚠️ 括号必须留着：Rust 里 `==` 的优先级**高于** `|`。
    let len_eq = (ab.len() == bb.len()) as u8;
    (diff | (len_eq ^ 1)) == 0
}

fn rotate_pairing(now: i64) -> Pairing {
    Pairing {
        token: random_hex(16),
        expires_at_ms: now + PAIR_TTL_MS,
        decided: None,
        device_created: false,
        approved_secret: None,
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
///
/// 第 122 轮阶段 1 修正（这条正是对标审计里点出的 `mod.rs:205` 普通 `==`）：
///
/// - 原来用 `devices.iter().find(|d| d.secret_hash == hash)` ——
///   ① `String` 的 `==` 不是常数时间；② `find` 在**第一个命中处就返回**，
///   于是"第几个设备命中的"也变成了时间信息。
/// - 现在对**所有**设备都做一次常数时间比较，全程不提前退出，取第一个命中。
///
/// 诚实标注风险等级：比对的双方都是 **SHA-256 摘要**（64 个 hex 字符），
/// 攻击者能控制的是"原像"（cookie 明文）而不是摘要本身，所以即使有时间泄露，
/// 也无法据此逐位收敛出正确 cookie（那需要摘要的部分原像）。
/// 也就是说：**这条的实际可利用性很低**，改它是为了姿态正确、以及消除
/// "鉴权路径上写着普通 `==`"这个会被反复误读的信号。
pub fn auth_device<'a>(devices: &'a [Device], secret: Option<&str>) -> Option<&'a Device> {
    let secret = secret?;
    let hash = sha256_hex(secret);
    let mut found: Option<&Device> = None;
    for d in devices {
        let hit = timing_safe_eq(&d.secret_hash, &hash);
        // 不用 `break`：保持"遍历全部"的常数形状
        if hit && found.is_none() {
            found = Some(d);
        }
    }
    found
}

// ---- 持久化 ----

async fn data_dir(app: &AppHandle) -> std::path::PathBuf {
    app.path()
        .app_data_dir()
        .map(|d| d.join(PHONE_DIR))
        .unwrap_or_else(|_| std::env::temp_dir().join(PHONE_DIR))
}

/// 应用数据根目录（**不带** `phone/` 前缀）。
///
/// 单独一个函数是因为 `tls::ensure` 自己会拼 `phone/tls` ——
/// 复用 `data_dir` 会得到 `phone/phone/tls`（我第一次就是这么写的）。
fn app_data_root(app: &AppHandle) -> std::path::PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
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
    // 阶段 1：局域网侧只有 HTTPS。`port` 一律是**边缘端口**，
    // 上游端口（回环）不外传 —— 它不该出现在任何给用户看的字段里。
    let base = format!("https://{}:{}/", g.lan_ip, g.tls_port);
    let pair_url = g
        .pairing
        .as_ref()
        .map(|p| format!("{}pair?token={}", base, p.token));
    serde_json::json!({
        "running": g.running,
        "port": g.tls_port,
        "lan_ip": g.lan_ip,
        "url": if g.running { Some(base.clone()) } else { None },
        "pair_url": pair_url,
        // 阶段 1：让界面能显示"手机连的是 HTTPS"以及**要核对的指纹**
        "https": true,
        "ca_fingerprint": g.ca_fingerprint,
        "ca_url": if g.running { Some(format!("{}ca.crt", base)) } else { None },
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

    // ---- 上游：**只绑回环**（第 122 轮阶段 1）----
    //
    // 原来是 `0.0.0.0:0` —— 手机连的就是它，明文、且对局域网任意主机可达。
    // 现在它只服务 127.0.0.1，**唯一入口是下面的 TLS 边缘**。
    // 这一条是"LAN HTTPS"能成立的前提：不是"HTTP 也开着、HTTPS 也开着"，
    // 而是**局域网上根本没有明文监听**。
    let upstream_listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("绑定上游失败: {}", e))?;
    let upstream_port = upstream_listener
        .local_addr()
        .map_err(|e| format!("取上游端口失败: {}", e))?
        .port();

    let lan_ip = lan::lan_ip();

    // ---- 证书：CA 尽量复用（手机只需信任一次），叶子按需轮换 ----
    let material = match tls::ensure(
        &app_data_root(&app),
        &[lan_ip.clone(), "127.0.0.1".to_string()],
    ) {
        Ok(m) => m,
        Err(e) => {
            // **fail-closed**：证书搞不出来就不启动 LAN 服务。
            // 绝不能"退化成明文" —— 那正是这一阶段要消除的东西。
            return Err(format!(
                "无法准备 TLS 证书（已拒绝启动局域网服务，绝不退化为明文）: {}",
                e
            ));
        }
    };
    let tls_config = match tls::server_config(&material) {
        Ok(c) => c,
        Err(e) => {
            return Err(format!("无法构造 TLS 配置（已拒绝启动局域网服务）: {}", e));
        }
    };

    // ---- 边缘：绑 0.0.0.0 的 HTTPS ----
    //
    // 端口**先绑再记**：绑失败就不启动（同样 fail-closed）。
    let edge_listener = match TcpListener::bind("0.0.0.0:0").await {
        Ok(l) => l,
        Err(e) => return Err(format!("绑定 HTTPS 边缘失败: {}", e)),
    };
    let tls_port = edge_listener
        .local_addr()
        .map_err(|e| format!("取边缘端口失败: {}", e))?
        .port();

    // 每次 start 重新随机的边缘标记（不落盘、不出进程）
    let edge_token = random_hex(32);

    {
        let mut g = st.inner.lock().await;
        if g.running {
            // 并发竞态：两次 start 交错，另一个已生效 → 丢弃本次监听并返回现有状态。
            drop(upstream_listener);
            drop(edge_listener);
            let url = format!("https://{}:{}/", g.lan_ip, g.tls_port);
            let pair_url = g
                .pairing
                .as_ref()
                .map(|p| format!("{}pair?token={}", url, p.token))
                .unwrap_or_default();
            return Ok(serde_json::json!({
                "url": url, "port": g.tls_port, "lan_ip": g.lan_ip, "pair_url": pair_url,
                "https": true,
                "ca_fingerprint": g.ca_fingerprint,
            }));
        }
        g.port = tls_port;
        g.tls_port = tls_port;
        g.upstream_port = upstream_port;
        g.edge_token = edge_token.clone();
        g.ca_fingerprint = material.ca_fingerprint.clone();
        g.ca_pem = material.ca_pem.clone();
        g.lan_ip = lan_ip.clone();
        g.pairing = Some(rotate_pairing(now_ms()));
        g.running = true;
    }

    let upstream_handle = {
        let st2 = st.clone();
        let app2 = app.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                match upstream_listener.accept().await {
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

    let edge_handle = {
        let acceptor = tokio_rustls::TlsAcceptor::from(tls_config);
        let allowed = Arc::new(guard::allowed_hosts(&lan_ip, tls_port));
        let token = Arc::new(edge_token);
        tauri::async_runtime::spawn(async move {
            loop {
                match edge_listener.accept().await {
                    Ok((stream, _peer)) => {
                        let acc = acceptor.clone();
                        let al = allowed.clone();
                        let tk = token.clone();
                        tauri::async_runtime::spawn(async move {
                            handle_edge_conn(acc, stream, upstream_port, al, tk).await;
                        });
                    }
                    Err(_) => break,
                }
            }
        })
    };
    {
        let mut g = st.inner.lock().await;
        g.server_handle = Some(upstream_handle);
        g.tls_handle = Some(edge_handle);
    }

    let url = format!("https://{}:{}/", lan_ip, tls_port);
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
        "port": tls_port,
        "lan_ip": lan_ip,
        "pair_url": pair_url,
        // 阶段 1：手机连的是 HTTPS，桌面要能把 CA 指纹显示出来让用户**带外**核对。
        "https": true,
        "ca_fingerprint": material.ca_fingerprint,
    }))
}

/// 从任意异步流里读一个完整 HTTP 请求（头 + Content-Length 指定的 body）。
///
/// 抽出来是因为它现在有**两个**调用方：TLS 边缘（读手机发来的请求）与
/// 上游（读边缘转来的请求）。两处各写一遍迟早分叉 —— 而"两处解析不一致"
/// 正是请求走私类问题的经典成因。
async fn read_http_request<S>(stream: &mut S) -> Result<(String, Vec<u8>), ()>
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

/// 在流上写一个 4xx/5xx 的纯文本响应（边缘自己产生的错误，不经过上游）。
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

/// TLS 边缘：终止 TLS → **准入判定** → 转给只绑回环的上游。
///
/// 准入在**边缘**做（而不是上游），因为这里是不可信流量进来的地方：
/// 【Host 白名单】挡 DNS rebinding，【拒跨站】挡恶意网页的 CSRF，
/// 之后注入只有边缘知道的标记，上游凭标记确认"你是从边缘进来的"。
async fn handle_edge_conn(
    acceptor: tokio_rustls::TlsAcceptor,
    stream: TcpStream,
    upstream_port: u16,
    allowed: Arc<std::collections::HashSet<String>>,
    edge_token: Arc<String>,
) {
    let _ = timeout(Duration::from_secs(30), async move {
        let mut tls = match acceptor.accept(stream).await {
            Ok(s) => s,
            // 握手失败是**常态**（公网扫描、协议探测、证书不匹配的旧手机），
            // 静默丢弃即可 —— 不要往日志里灌噪音。
            Err(_) => return,
        };
        let (head, body) = match read_http_request(&mut tls).await {
            Ok(v) => v,
            Err(_) => return,
        };

        // ---- 准入：Host 白名单 + 拒跨站 ----
        let host = http::header_value(&head, "host");
        let sfs = http::header_value(&head, "sec-fetch-site");
        let origin = http::header_value(&head, "origin");
        match guard::edge_verdict(host.as_deref(), sfs.as_deref(), origin.as_deref(), &allowed) {
            guard::EdgeVerdict::Allow => {}
            guard::EdgeVerdict::BadHost => {
                // 如实说清拒绝原因：这条最常见的成因就是"域名指向了我们的 IP"，
                // 用户/我们自己排查时看到这句话能立刻明白。
                let _ = write_simple(
                    &mut tls,
                    421,
                    "Misdirected Request",
                    "这个地址不是本机宣告的访问地址。请用桌面端显示的地址访问。",
                )
                .await;
                return;
            }
            guard::EdgeVerdict::CrossSite => {
                let _ = write_simple(
                    &mut tls,
                    403,
                    "Forbidden",
                    "拒绝跨站请求。",
                )
                .await;
                return;
            }
        }

        // ---- 转发到上游（回环）：注入标记，客户端自带的同名头被删掉 ----
        let forwarded = guard::inject_edge_header(&head, &edge_token);
        let up = match TcpStream::connect(("127.0.0.1", upstream_port)).await {
            Ok(s) => s,
            Err(_) => {
                let _ = write_simple(&mut tls, 502, "Bad Gateway", "本机服务不可用。").await;
                return;
            }
        };
        let (mut rd, mut wr) = up.into_split();
        if wr.write_all(forwarded.as_bytes()).await.is_err() {
            return;
        }
        if wr.write_all(b"\r\n\r\n").await.is_err() {
            return;
        }
        if !body.is_empty() && wr.write_all(&body).await.is_err() {
            return;
        }
        let _ = wr.flush().await;
        // 上游是"一请求一响应、Connection: close"，读到 EOF 即为响应结束
        let mut resp = Vec::new();
        let mut chunk = [0u8; 8192];
        loop {
            match rd.read(&mut chunk).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    resp.extend_from_slice(&chunk[..n]);
                    if resp.len() > MAX_REQUEST_BYTES {
                        break;
                    }
                }
            }
        }
        let _ = tls.write_all(&resp).await;
        let _ = tls.flush().await;
        let _ = tls.shutdown().await;
    })
    .await;
}

async fn handle_conn(app: AppHandle, st: Arc<PhoneState>, mut stream: TcpStream) -> Result<(), ()> {
    let result = timeout(Duration::from_secs(25), async {
        let (head, body) = read_http_request(&mut stream).await?;

        // ---- 上游准入：必须带本次运行的边缘标记 ----
        // 上游只绑 127.0.0.1，所以能到这里的就是本机进程；这一跳保证
        // **本机别的进程也不能绕过边缘的 Host 校验**直连上来。
        let edge_token = {
            let g = st.inner.lock().await;
            g.edge_token.clone()
        };
        if !upstream_admit(&head, &edge_token) {
            let _ = write_simple(
                &mut stream,
                403,
                "Forbidden",
                "必须经本机 TLS 边缘访问。",
            )
            .await;
            // 显式标注返回类型：这个 async 块里其它路径靠 `?` 推断错误类型，
            // 只有这里需要写清楚（否则 E0282/E0283）。
            return Ok::<(), ()>(());
        }

        let req = http::parse(&head, body).map_err(|_| ())?;
        let peer_ip = stream
            .peer_addr()
            .map(|a| a.ip().to_string())
            .unwrap_or_default();
        let resp = route(&app, &st, req, peer_ip).await;
        let bytes = resp.to_bytes();
        stream.write_all(&bytes).await.map_err(|_| ())?;
        Ok(())
    })
    .await;
    let _ = result;
    Ok(())
}

/// 上游准入判定（**纯函数**，便于直接钉住）。
///
/// `expected` 为空表示"边缘标记机制未启用"（例如只在测试里直接跑上游）——
/// 那时不做这一跳检查。生产路径上 `phone_start` 一定会填它。
pub fn upstream_admit(head: &str, expected: &str) -> bool {
    if expected.is_empty() {
        return true;
    }
    guard::upstream_allowed(http::header_value(head, guard::EDGE_HEADER).as_deref(), expected)
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
        // 阶段 1：CA 证书下载（**故意不鉴权**）。
        //
        // 为什么必须不鉴权：手机要在**配对之前**才能装上证书，否则连不上 HTTPS
        // 就没法配对 —— 这是先有鸡还是先有蛋。
        //
        // 为什么公开它不构成漏洞：证书是**公开信息**（不是私钥）。
        // 真正的防线是"用户拿桌面上显示的**指纹**带外核对" ——
        // 中间人可以把这张 CA 换成自己的，但换不掉桌面上那串指纹。
        // 所以这一步的意义是：**用户必须核对指纹**，而不是"证书能下载就安全"。
        ("GET", "/ca.crt") => {
            let pem = {
                let g = st.inner.lock().await;
                g.ca_pem.clone()
            };
            if pem.is_empty() {
                HttpResponse::text(404, "text/plain; charset=utf-8", "CA 尚未就绪")
            } else {
                let mut r =
                    HttpResponse::text(200, "application/x-x509-ca-cert", &pem);
                r.headers.push((
                    "Content-Disposition".into(),
                    "attachment; filename=codem-ca.crt".into(),
                ));
                r
            }
        }
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
                let mut to_push: Option<Device> = None;
                if s == PairTokenStatus::Approved {
                    // 注意：经 MutexGuard 的 Deref 借用无法字段拆分——先只动 pairing，
                    // devices 写入放到借用结束之后。
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
                            new_device_id = Some(dev.id.clone());
                            // 明文 secret 仅驻留配对 TTL 内，供重复轮询重放 Set-Cookie
                            //（弱网下首条 approved 响应丢失时手机不致永久 401）。
                            p.approved_secret = Some(secret.clone());
                            cookie = Some(secret);
                            to_push = Some(dev);
                        } else {
                            // 已建设备：重放同一 secret（幂等）
                            cookie = p.approved_secret.clone();
                        }
                    }
                }
                if let Some(dev) = to_push {
                    g.devices.retain(|d| d.id != dev.id);
                    if g.devices.len() >= MAX_DEVICES {
                        g.devices.remove(0);
                    }
                    g.devices.push(dev);
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
                                // 阶段 1：加 `Secure`（现在是 HTTPS，明文路径已不存在），
                                // 寿命从 1 年收到 30 天。
                                "{}={}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age={}",
                                COOKIE_NAME, secret, COOKIE_MAX_AGE_SECS
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
        // 阶段 1：边缘也必须一起停 —— 只停上游会留下一个"能握手但没人应答"的
        // HTTPS 端口，比彻底关掉更难排查。
        if let Some(h) = g.tls_handle.take() {
            h.abort();
        }
        // 边缘标记一并作废（下次 start 会重新随机）
        g.edge_token.clear();
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

/// 取 CA 证书 PEM（阶段 1：供桌面端"保存/安装证书"用）。
///
/// 为什么不复用 `/ca.crt` HTTP 路由：那条路要手机连着才走得到，
/// 而"我还没连上、想先把证书装到手机里"正是最常见的顺序。
/// 桌面直接把它存成文件最顺手。
#[tauri::command]
pub async fn phone_ca_pem(state: State<'_, Arc<PhoneState>>) -> Result<String, String> {
    let st: Arc<PhoneState> = state.inner().clone();
    let g = st.inner.lock().await;
    Ok(g.ca_pem.clone())
}

/// 取 CA 指纹（大写 hex，冒号分隔）。
#[tauri::command]
pub async fn phone_ca_fingerprint(state: State<'_, Arc<PhoneState>>) -> Result<String, String> {
    let st: Arc<PhoneState> = state.inner().clone();
    let g = st.inner.lock().await;
    Ok(g.ca_fingerprint.clone())
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
