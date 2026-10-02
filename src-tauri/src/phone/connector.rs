// ============================================================
// phone/connector.rs — 出站 connector（对标 AA 的第 2 条通道）
//
// ## 它在链路里的位置
//
//     手机 ──HTTPS──▶ [中继] ◀──**本模块出站长连**── [桌面]
//                       │
//                       └─ 推来的请求 → 本机 127.0.0.1 回环上游（= AA 的第 3 条通道）
//
// **桌面只为这条路径出站**，不为它开任何 LAN 端口 —— 这是与 DSH / Agents Anywhere
// 完全一致的策略（见 `docs/DSH-REMOTE-CONTROL-BENCHMARK.md` §11）。
//
// ## 配置契约：字段名**逐字照抄** AA
//
// AA 在 `host/connector/process.ts:126-135` 落盘 `connector.json`，字段是
// `serverUrl` / `connectorId` / `connectorToken` / `statePath` /
// `heartbeatSeconds(20)` / `reconnectSeconds(3)` / `syncIntervalSeconds(30)` /
// `syncExistingOnConnect(true)`。我们用 `#[serde(rename_all = "camelCase")]` 对齐，
// 于是同一份配置文件在两边**可以互相读**。
//
// ## 与 AA 的两处**有意的**不同（都是部署/依赖差别，不是策略差别）
//
// 1. AA 的 connector 是一个 **Python 子进程**（`uv run anywhere-cli rpc`，首次要拉
//    约 235 MiB 轮子，`process.ts:16-23` 甚至为此给了 1 小时的首次超时）。
//    我们**不引 Python 运行时**，用 Rust 在应用内跑一个 tokio 任务 ——
//    连的还是同一个中继、发的还是同一套帧。省掉一个运行时是纯收益。
// 2. AA 的插件↔connector 之间还有一条 **stdio JSON-RPC**
//    （`connector.getState/start/stop`，`process.ts:250-261`）。
//    那是"父进程管子进程"用的；我们同进程，不需要它 ——
//    所以本模块直接用函数与状态暴露同样的三件事（start/stop/status）。
//
// ## 心跳与重连
//
// - 中继每 15s 发一个 SSE 注释帧（`: hb <ts>`），我们读到就更新 `last_beat_ms`
//   —— 这是"链路还活着"的证据，也是界面显示连接状态的依据。
// - 出站断开后按 `reconnectSeconds`（默认 3s）重连，与 AA 同值。
// ============================================================

use std::sync::Arc;
use std::time::Duration;

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex as TokioMutex;

use super::{guard, random_hex, PhoneState};

/// 与 AA 的 `connector.json` 逐字对齐的配置。
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorConfig {
    /// 中继地址，例如 `https://relay.example.com`
    pub server_url: String,
    pub connector_id: String,
    pub connector_token: String,
    /// 本地状态文件（AA 用 sqlite；我们只记最少的东西）
    #[serde(default)]
    pub state_path: String,
    #[serde(default = "default_heartbeat")]
    pub heartbeat_seconds: u64,
    #[serde(default = "default_reconnect")]
    pub reconnect_seconds: u64,
    #[serde(default = "default_sync")]
    pub sync_interval_seconds: u64,
    #[serde(default = "default_true")]
    pub sync_existing_on_connect: bool,
}

fn default_heartbeat() -> u64 {
    20
}
fn default_reconnect() -> u64 {
    3
}
fn default_sync() -> u64 {
    30
}
fn default_true() -> bool {
    true
}

impl ConnectorConfig {
    /// 从用户填的"中继地址 + 配对码"造一份配置。
    ///
    /// `connectorId`/`connectorToken` 由桌面**自己生成一次并持久化** ——
    /// AA 是从云上注册拿到的（`account/binding.ts:142`），我们不要账号体系，
    /// 所以就地生成、由中继 TOFU 记住（中继侧对应 `RelayState::hello`）。
    pub fn new_for_server(server_url: &str, connector_id: &str, connector_token: &str, state_path: &str) -> Self {
        ConnectorConfig {
            server_url: server_url.trim_end_matches('/').to_string(),
            connector_id: connector_id.to_string(),
            connector_token: connector_token.to_string(),
            state_path: state_path.to_string(),
            heartbeat_seconds: default_heartbeat(),
            reconnect_seconds: default_reconnect(),
            sync_interval_seconds: default_sync(),
            sync_existing_on_connect: true,
        }
    }
}

/// 出站 connector 的运行时状态（界面据此显示连接情况）。
pub struct ConnectorInner {
    pub running: bool,
    pub connected: bool,
    pub config: Option<ConnectorConfig>,
    pub last_error: Option<String>,
    /// 最近一次收到中继心跳的时刻（ms）——"链路还活着"的证据
    pub last_beat_ms: i64,
    pub requests_served: u64,
    pub errors: u64,
    pub reconnects: u64,
    pub handle: Option<tauri::async_runtime::JoinHandle<()>>,
}

impl Default for ConnectorInner {
    fn default() -> Self {
        ConnectorInner {
            running: false,
            connected: false,
            config: None,
            last_error: None,
            last_beat_ms: 0,
            requests_served: 0,
            errors: 0,
            reconnects: 0,
            handle: None,
        }
    }
}

pub struct ConnectorState {
    pub inner: TokioMutex<ConnectorInner>,
}

impl ConnectorState {
    pub fn new() -> Arc<Self> {
        Arc::new(ConnectorState {
            inner: TokioMutex::new(ConnectorInner::default()),
        })
    }
}

/// 中继推来的一帧（与中继 `tunnel()` 里写出去的形状对应）。
#[derive(Deserialize, Debug)]
struct TunnelFrame {
    #[serde(default)]
    id: String,
    #[serde(default)]
    method: String,
    #[serde(default)]
    params: TunnelParams,
}

#[derive(Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
struct TunnelParams {
    #[serde(default)]
    method: String,
    #[serde(default)]
    path: String,
    #[serde(default)]
    query: String,
    #[serde(default)]
    headers: TunnelHeaders,
    #[serde(default, rename = "bodyB64")]
    body_b64: String,
}

#[derive(Deserialize, Debug, Default)]
struct TunnelHeaders {
    #[serde(default)]
    cookie: String,
    #[serde(default, rename = "content-type")]
    content_type: String,
}

/// 从环形缓冲里切出"完整的一行"。
fn take_line(buf: &mut String) -> Option<String> {
    let idx = buf.find('\n')?;
    let line: String = buf.drain(..=idx).collect();
    Some(line.trim_end_matches(['\r', '\n']).to_string())
}

/// 极简 HTTP 响应解析（上游固定 `Connection: close`，读到 EOF 即完整）。
///
/// 返回 `(status, headers, body)`。解析不出来就返回 None —— 调用方会如实报错，
/// **不会**编一个 200 出来。
///
/// `pub` 是因为 AA 复刻那条路（`aa_connector.rs`）也要转给**同一个**上游，
/// 两处各写一份解析器是"同一件事两处实现"的老问题。
pub fn parse_http_response(raw: &[u8]) -> Option<(u16, Vec<(String, String)>, Vec<u8>)> {
    let sep = raw.windows(4).position(|w| w == b"\r\n\r\n")?;
    let head = String::from_utf8_lossy(&raw[..sep]).to_string();
    let body = raw[sep + 4..].to_vec();
    let mut lines = head.split("\r\n");
    let status_line = lines.next()?;
    let status: u16 = status_line.split_whitespace().nth(1)?.parse().ok()?;
    let mut headers = Vec::new();
    for l in lines {
        if let Some((k, v)) = l.split_once(':') {
            headers.push((k.trim().to_lowercase(), v.trim().to_string()));
        }
    }
    Some((status, headers, body))
}

/// 把中继推来的一个请求转给**本机回环上游**，并把响应原样取回。
///
/// 这一跳等价于 AA 的第 3 条通道（connector → 本机 127.0.0.1 JSON-RPC）。
/// 我们复用的是**已有的**手机 HTTP 上游 —— 所以阶段 0/1 的路由、cookie 鉴权、
/// 审批卡片、配对页**一行都不用改**就能从中继这条路上被访问到。
async fn forward_to_upstream(
    upstream_port: u16,
    edge_token: &str,
    frame: &TunnelFrame,
    relay_secure: bool,
) -> Result<(u16, Vec<(String, String)>, Vec<u8>), String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let p = &frame.params;
    let body = if p.body_b64.is_empty() {
        Vec::new()
    } else {
        base64_decode(&p.body_b64).ok_or("帧里的 bodyB64 不是合法 base64")?
    };
    let path = if p.path.is_empty() { "/" } else { p.path.as_str() };
    let target = format!("{}{}", path, p.query);
    let method = if p.method.is_empty() { "GET" } else { p.method.as_str() };

    let mut head = format!("{} {} HTTP/1.1\r\n", method, target);
    // 上游要 `Host`（阶段 1 的准入会看它），这里填回环形态 ——
    // 中继这条路**不经过** LAN 边缘，所以 Host 白名单在这里不适用，
    // 但上游仍然要求边缘标记，见下面那一行。
    head.push_str("Host: 127.0.0.1\r\n");
    head.push_str("Connection: close\r\n");
    if !p.headers.cookie.is_empty() {
        head.push_str(&format!("Cookie: {}\r\n", p.headers.cookie));
    }
    if !p.headers.content_type.is_empty() {
        head.push_str(&format!("Content-Type: {}\r\n", p.headers.content_type));
    }
    // ⚠️ 关键：上游只认带**本次运行**边缘标记的请求。connector 与 LAN 边缘
    // 是同一个上游的两个入口，所以这里必须带上同一个标记 ——
    // 于是"上游只绑回环"这条约束对两条入口都成立。
    head.push_str(&format!("{}: {}\r\n", guard::EDGE_HEADER, edge_token));
    // 告诉上游"客户端那一侧到底是什么协议"。
    //
    // 为什么需要：手机那条链路是 手机 ──(中继的协议)──▶ connector ──明文──▶ 上游。
    // 上游只看得到本机回环这一跳，**看不到手机到中继那一跳有没有 TLS**。
    // 而会话 cookie 一旦标了 `Secure`，浏览器在**明文**中继上就会直接丢弃它 ⇒
    // 手机永远登不进桌面 API，而现象只是"一直 401"，极难定位。
    //
    // 所以按实际协议告诉上游（与反向代理的 `X-Forwarded-Proto` 同一惯例）：
    // - 中继是 https ⇒ 上游给 `Secure`（正确）
    // - 中继是 http  ⇒ 上游**不**给 `Secure`（否则 cookie 必然被丢）
    // 这条链路的安全性由"中继是不是 HTTPS"决定，所以提示必须是**如实**的。
    head.push_str(&format!(
        "X-Forwarded-Proto: {}\r\n",
        if relay_secure { "https" } else { "http" }
    ));
    if !body.is_empty() {
        head.push_str(&format!("Content-Length: {}\r\n", body.len()));
    }
    head.push_str("\r\n");

    let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", upstream_port))
        .await
        .map_err(|e| format!("连本机上游失败: {}", e))?;
    stream
        .write_all(head.as_bytes())
        .await
        .map_err(|e| format!("写上游失败: {}", e))?;
    if !body.is_empty() {
        stream
            .write_all(&body)
            .await
            .map_err(|e| format!("写上游 body 失败: {}", e))?;
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
    parse_http_response(&raw).ok_or_else(|| "上游响应无法解析".to_string())
}

/// 极简 base64 解码（与 tls.rs 里那份同源；放在这里避免跨模块依赖一个私有函数）。
fn base64_decode(s: &str) -> Option<Vec<u8>> {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut lut = [255u8; 256];
    for (i, c) in TABLE.iter().enumerate() {
        lut[*c as usize] = i as u8;
    }
    let mut out = Vec::with_capacity(s.len() / 4 * 3);
    let mut acc: u32 = 0;
    let mut bits = 0u32;
    for b in s.bytes() {
        if b == b'=' {
            break;
        }
        let v = lut[b as usize];
        if v == 255 {
            continue;
        }
        acc = (acc << 6) | v as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    Some(out)
}

/// 一次"连上并服务"的完整过程；返回即表示连接已断（外层按 reconnectSeconds 重试）。
async fn run_once(
    st: Arc<PhoneState>,
    cs: Arc<ConnectorState>,
    cfg: ConnectorConfig,
) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .build()
        .map_err(|e| format!("构造 HTTP 客户端失败: {}", e))?;
    let base = cfg.server_url.trim_end_matches('/').to_string();

    // ---- 1. hello：登记身份 + 把当前配对码报给中继（手机要用它换会话）----
    let (upstream_port, edge_token, pairing_code, lan_ip) = {
        let g = st.inner.lock().await;
        (
            g.upstream_port,
            g.edge_token.clone(),
            g.pairing.as_ref().map(|p| p.token.clone()).unwrap_or_default(),
            g.lan_ip.clone(),
        )
    };
    let hello_body = serde_json::json!({
        "connectorId": cfg.connector_id,
        "connectorToken": cfg.connector_token,
        "pairingCode": pairing_code,
        "deviceName": format!("Codem@{}", if lan_ip.is_empty() { "desktop" } else { &lan_ip }),
    });
    let hello: serde_json::Value = client
        .post(format!("{}/connector/hello", base))
        .json(&hello_body)
        .send()
        .await
        .map_err(|e| format!("连中继失败: {}", e))?
        .json()
        .await
        .map_err(|e| format!("中继 hello 响应不可解析: {}", e))?;
    if hello.get("ok").and_then(|v| v.as_bool()) != Some(true) {
        let code = hello.get("code").and_then(|v| v.as_str()).unwrap_or("unknown");
        return Err(format!("中继拒绝了本次连接（{}）", code));
    }
    let stream_token = hello
        .get("streamToken")
        .and_then(|v| v.as_str())
        .ok_or("中继没有返回 streamToken")?
        .to_string();

    // ---- 2. 出站长连（SSE）----
    let stream_url = format!(
        "{}/connector/stream?connectorId={}&streamToken={}",
        base,
        urlencode(&cfg.connector_id),
        urlencode(&stream_token)
    );
    let resp = client
        .get(&stream_url)
        .send()
        .await
        .map_err(|e| format!("开流出站失败: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("中继开流被拒（HTTP {}）", resp.status().as_u16()));
    }
    {
        let mut g = cs.inner.lock().await;
        g.connected = true;
        g.last_error = None;
        g.last_beat_ms = super::now_ms();
    }

    let mut bytes = resp.bytes_stream();
    let mut buf = String::new();
    let mut event_name = String::new();
    let mut data_line = String::new();
    // 每 2 秒看一眼配对码有没有轮换：轮换了就**断开重连**，用新码重新 hello。
    // 这样配对二维码刷新后，手机立刻能用新码配对，不需要等 30 秒的同步周期。
    let mut tick = tokio::time::interval(Duration::from_secs(2));

    loop {
        tokio::select! {
            chunk = bytes.next() => {
                let Some(chunk) = chunk else { return Ok(()) }; // 中继关了流
                let chunk = chunk.map_err(|e| format!("读流失败: {}", e))?;
                buf.push_str(&String::from_utf8_lossy(&chunk));
                if buf.len() > 4 * 1024 * 1024 {
                    // 单帧上限保护：防止对端灌爆内存
                    return Err("中继推来的数据超过上限".into());
                }
                while let Some(line) = take_line(&mut buf) {
                    if line.is_empty() {
                        // 事件块结束 ⇒ 若 method 是 http.request 就处理
                        if event_name == "request" && !data_line.is_empty() {
                            let frame: TunnelFrame = match serde_json::from_str(&data_line) {
                                Ok(f) => f,
                                Err(e) => {
                                    let mut g = cs.inner.lock().await;
                                    g.errors += 1;
                                    g.last_error = Some(format!("帧不可解析: {}", e));
                                    continue;
                                }
                            };
                            // 校验 frame.method —— 中继只该推 `http.request`。
                            //
                            // 不校验的话，将来中继加一个新方法（或有人对着我们的
                            // connector 发别的帧）会被**当成 HTTP 请求**处理，
                            // 静默地做错事。这里明确跳过并记进去。
                            if frame.method != "http.request" {
                                let mut g = cs.inner.lock().await;
                                g.errors += 1;
                                g.last_error = Some(format!("收到未知的帧方法：{}", frame.method));
                                continue;
                            }
                            let result = forward_to_upstream(
                                upstream_port,
                                &edge_token,
                                &frame,
                                cfg.server_url.starts_with("https://"),
                            )
                            .await;
                            let (status, headers, body, err) = match result {
                                Ok((s, h, b)) => (s, h, b, None),
                                Err(e) => (502, Vec::new(), Vec::new(), Some(e)),
                            };
                            let mut hmap = serde_json::Map::new();
                            for (k, v) in headers {
                                // 不透传 hop-by-hop，避免污染中继侧连接
                                if matches!(k.as_str(), "connection" | "keep-alive" | "transfer-encoding" | "content-length") {
                                    continue;
                                }
                                hmap.insert(k, serde_json::Value::String(v));
                            }
                            let mut payload = serde_json::json!({
                                "connectorId": cfg.connector_id,
                                "streamToken": stream_token,
                                "id": frame.id,
                            });
                            if let Some(e) = err {
                                let mut g = cs.inner.lock().await;
                                g.errors += 1;
                                g.last_error = Some(e.clone());
                                payload["error"] = serde_json::json!({ "code": -32000, "message": e });
                            } else {
                                payload["result"] = serde_json::json!({
                                    "status": status,
                                    "headers": hmap,
                                    "bodyB64": encode_b64(&body),
                                });
                                let mut g = cs.inner.lock().await;
                                g.requests_served += 1;
                            }
                            // 回填失败**不能静默**：中继那边会超时，用户看到的是转圈。
                            // 如实记进 last_error，界面上能看到。
                            if let Err(e) = client
                                .post(format!("{}/connector/response", base))
                                .json(&payload)
                                .send()
                                .await
                            {
                                let mut g = cs.inner.lock().await;
                                g.errors += 1;
                                g.last_error = Some(format!("回填响应失败: {}", e));
                            }
                        }
                        event_name.clear();
                        data_line.clear();
                        continue;
                    }
                    if let Some(rest) = line.strip_prefix(": ") {
                        // 心跳注释帧 —— 但只有"服务尚未登记为在线"时才刷新 last_beat：
                        // 它证明链路活着，与业务无关。
                        let _ = rest;
                        let mut g = cs.inner.lock().await;
                        g.last_beat_ms = super::now_ms();
                        continue;
                    }
                    if let Some(v) = line.strip_prefix("event: ") {
                        event_name = v.trim().to_string();
                    } else if let Some(v) = line.strip_prefix("data: ") {
                        data_line = v.to_string();
                    }
                }
            }
            _ = tick.tick() => {
                let now_code = {
                    let g = st.inner.lock().await;
                    g.pairing.as_ref().map(|p| p.token.clone()).unwrap_or_default()
                };
                if now_code != pairing_code {
                    // 配对码轮换 ⇒ 用新码重新登记
                    return Ok(());
                }
            }
        }
    }
}

fn encode_b64(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for c in data.chunks(3) {
        let b = [c[0], *c.get(1).unwrap_or(&0), *c.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if c.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if c.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    out
}

/// 最小 urlencode（只编码非 unreserved 字符）。
fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

/// 启动出站 connector（幂等）。
pub async fn start(
    st: Arc<PhoneState>,
    cs: Arc<ConnectorState>,
    cfg: ConnectorConfig,
) -> Result<(), String> {
    {
        let mut g = cs.inner.lock().await;
        if g.running {
            return Ok(());
        }
        if cfg.server_url.trim().is_empty() {
            return Err("中继地址为空".into());
        }
        g.running = true;
        g.connected = false;
        g.last_error = None;
        g.config = Some(cfg.clone());
    }
    let cs2 = cs.clone();
    let st2 = st.clone();
    let handle = tauri::async_runtime::spawn(async move {
        loop {
            // 还在跑吗？（stop 会把 running 置 false）
            {
                let g = cs2.inner.lock().await;
                if !g.running {
                    break;
                }
            }
            match run_once(st2.clone(), cs2.clone(), cfg.clone()).await {
                Ok(()) => {
                    let mut g = cs2.inner.lock().await;
                    g.connected = false;
                }
                Err(e) => {
                    let mut g = cs2.inner.lock().await;
                    g.connected = false;
                    g.last_error = Some(e);
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
        g.handle = None;
    });
    let mut g = cs.inner.lock().await;
    g.handle = Some(handle);
    Ok(())
}

/// 停止出站 connector。
pub async fn stop(cs: Arc<ConnectorState>) {
    let handle = {
        let mut g = cs.inner.lock().await;
        g.running = false;
        g.connected = false;
        g.handle.take()
    };
    if let Some(h) = handle {
        h.abort();
    }
}

/// 状态快照（给界面用）。
pub async fn snapshot(cs: Arc<ConnectorState>) -> serde_json::Value {
    let g = cs.inner.lock().await;
    serde_json::json!({
        "running": g.running,
        "connected": g.connected,
        "serverUrl": g.config.as_ref().map(|c| c.server_url.clone()).unwrap_or_default(),
        "connectorId": g.config.as_ref().map(|c| c.connector_id.clone()).unwrap_or_default(),
        "lastError": g.last_error,
        "lastBeatMs": g.last_beat_ms,
        "requestsServed": g.requests_served,
        "errors": g.errors,
        "reconnects": g.reconnects,
        // 把 reconnectSeconds 也报出去，界面才能解释"它多久试一次"
        "reconnectSeconds": g.config.as_ref().map(|c| c.reconnect_seconds).unwrap_or(3),
    })
}

/// 生成一对新的 connector 身份（`connectorId` + `connectorToken`）。
///
/// 每次"换一台中继"都重新生成：中继侧是 TOFU 登记，换 id 等于换一个全新身份，
/// 不会与旧中继上的记录冲突。
pub fn new_identity() -> (String, String) {
    (format!("cn-{}", random_hex(8)), random_hex(32))
}

/// 配置文件落盘位置：`<app_data>/phone/connector.json`。
///
/// 文件名与 AA 相同（`connector/process.ts:123` 也用 `connector.json`）。
fn config_path(app: &tauri::AppHandle) -> std::path::PathBuf {
    use tauri::Manager;
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("phone")
        .join("connector.json")
}

/// 读已有配置；若不存在、或换了中继地址，就生成一份新的并落盘。
///
/// **为什么必须持久化身份**：中继侧是 TOFU（首见即登记，之后 token 必须一致）。
/// 身份每次都变的话，中继上会积累一堆永不回收的登记，而且手机每次配对都会
/// 绑到一个新 connector 上，旧会话全丢。
pub fn load_or_create_config(
    app: &tauri::AppHandle,
    server_url: &str,
) -> Result<ConnectorConfig, String> {
    let url = server_url.trim().trim_end_matches('/').to_string();
    if url.is_empty() {
        return Err("中继地址不能为空".into());
    }
    let path = config_path(app);
    let existing = std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str::<ConnectorConfig>(&s).ok());
    if let Some(mut cfg) = existing {
        if cfg.server_url == url && !cfg.connector_id.is_empty() && !cfg.connector_token.is_empty() {
            // 同一台中继：**沿用身份**（否则中继上会多出一个新设备）
            cfg.state_path = path.with_extension("state.json").to_string_lossy().to_string();
            return Ok(cfg);
        }
    }
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("建目录失败: {}", e))?;
    }
    let (id, token) = new_identity();
    let cfg = ConnectorConfig::new_for_server(
        &url,
        &id,
        &token,
        &path.with_extension("state.json").to_string_lossy(),
    );
    let js = serde_json::to_string_pretty(&cfg).map_err(|e| format!("序列化配置失败: {}", e))?;
    std::fs::write(&path, js).map_err(|e| format!("写配置失败: {}", e))?;
    Ok(cfg)
}

// ---------------- Tauri 命令 ----------------

/// 启动出站 connector：连到用户填的中继地址。
#[tauri::command]
pub async fn phone_relay_start(
    app: tauri::AppHandle,
    server_url: String,
    phone: tauri::State<'_, Arc<PhoneState>>,
    state: tauri::State<'_, Arc<ConnectorState>>,
) -> Result<serde_json::Value, String> {
    let st: Arc<PhoneState> = phone.inner().clone();
    let cs: Arc<ConnectorState> = state.inner().clone();
    let cfg = load_or_create_config(&app, &server_url)?;
    start(st, cs.clone(), cfg).await?;
    Ok(snapshot(cs).await)
}

/// 停止出站 connector。
#[tauri::command]
pub async fn phone_relay_stop(
    state: tauri::State<'_, Arc<ConnectorState>>,
) -> Result<serde_json::Value, String> {
    let cs: Arc<ConnectorState> = state.inner().clone();
    stop(cs.clone()).await;
    Ok(snapshot(cs).await)
}

/// 读 connector 状态（界面据此显示"已连上 / 正在重连 / 上次错误"）。
#[tauri::command]
pub async fn phone_relay_status(
    state: tauri::State<'_, Arc<ConnectorState>>,
) -> Result<serde_json::Value, String> {
    let cs: Arc<ConnectorState> = state.inner().clone();
    Ok(snapshot(cs).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_field_names_match_aa() {
        // 逐字对齐 AA 的 connector.json（process.ts:126-135）
        let cfg = ConnectorConfig::new_for_server("https://relay.example.com/", "cn-1", "tok", "/tmp/s.json");
        let js = serde_json::to_string(&cfg).unwrap();
        for k in [
            "serverUrl",
            "connectorId",
            "connectorToken",
            "statePath",
            "heartbeatSeconds",
            "reconnectSeconds",
            "syncIntervalSeconds",
            "syncExistingOnConnect",
        ] {
            assert!(js.contains(&format!("\"{}\"", k)), "缺字段 {}：{}", k, js);
        }
        // 默认值与 AA 同值：20 / 3 / 30 / true
        assert_eq!(cfg.heartbeat_seconds, 20);
        assert_eq!(cfg.reconnect_seconds, 3);
        assert_eq!(cfg.sync_interval_seconds, 30);
        assert!(cfg.sync_existing_on_connect);
        // 末尾斜杠要去掉（否则会拼出 //connector/hello）
        assert_eq!(cfg.server_url, "https://relay.example.com");
    }

    #[test]
    fn config_reads_aa_shaped_json() {
        // 关键：**AA 写的那份 json 我们能直接读**（这就是"逐字对齐"的用处）
        let js = r#"{
          "serverUrl": "https://r.example.com",
          "connectorId": "cn-x",
          "connectorToken": "t",
          "statePath": "/x.sqlite3",
          "heartbeatSeconds": 20,
          "reconnectSeconds": 3,
          "syncIntervalSeconds": 30,
          "syncExistingOnConnect": true
        }"#;
        let cfg: ConnectorConfig = serde_json::from_str(js).expect("应能解析 AA 形状的配置");
        assert_eq!(cfg.connector_id, "cn-x");
        assert_eq!(cfg.heartbeat_seconds, 20);
    }

    #[test]
    fn parses_http_response() {
        let raw = b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nX-A: b\r\n\r\nhello";
        let (status, headers, body) = parse_http_response(raw).expect("应能解析");
        assert_eq!(status, 200);
        assert_eq!(body, b"hello");
        assert!(headers.iter().any(|(k, v)| k == "content-type" && v == "text/plain"));
        // 头名统一小写（否则下游按小写找会找不到）
        assert!(headers.iter().all(|(k, _)| k == &k.to_lowercase()));
        // 解析不出来就是 None，不许编一个 200
        assert!(parse_http_response(b"garbage").is_none());
        assert!(parse_http_response(b"HTTP/1.1 200 OK\r\n\r\n").is_some());
    }

    #[test]
    fn base64_roundtrip_with_binary() {
        let data: Vec<u8> = vec![0, 1, 2, 250, 251, 252, 253, 254, 255, 65, 0];
        let enc = encode_b64(&data);
        assert_eq!(base64_decode(&enc).unwrap(), data);
        assert_eq!(encode_b64(b"a"), "YQ==");
        assert_eq!(encode_b64(b"ab"), "YWI=");
        assert_eq!(encode_b64(b"abc"), "YWJj");
        assert_eq!(base64_decode("").unwrap(), Vec::<u8>::new());
    }

    #[test]
    fn take_line_splits_and_leaves_remainder() {
        let mut buf = String::from("event: request\ndata: {}\n\nrest");
        assert_eq!(take_line(&mut buf).as_deref(), Some("event: request"));
        assert_eq!(take_line(&mut buf).as_deref(), Some("data: {}"));
        assert_eq!(take_line(&mut buf).as_deref(), Some(""));
        assert_eq!(take_line(&mut buf), None);
        assert_eq!(buf, "rest");
    }

    #[test]
    fn identity_is_fresh_and_url_safe() {
        let (id1, t1) = new_identity();
        let (id2, _) = new_identity();
        assert!(id1.starts_with("cn-"));
        assert_ne!(id1, id2, "每次都要是新的");
        assert_eq!(t1.len(), 64, "32 字节 hex");
        // id 要能直接放进 query（否则中继那边 URL 会坏）
        assert_eq!(urlencode(&id1), id1);
    }

    #[test]
    fn urlencode_escapes_reserved() {
        assert_eq!(urlencode("a b/c?d=e&f"), "a%20b%2Fc%3Fd%3De%26f");
        assert_eq!(urlencode("cn-A_1.2~3"), "cn-A_1.2~3");
    }
}
