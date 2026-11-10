// ============================================================
// phone/gateway_client.rs — 多设备同步的**客户端出站**通道（25 号文 P2）
//
// ## 为什么这条请求必须由 Rust 发（而不是渲染层 fetch）
//
// 网关的 `/rpc` **只服务自己的页面**（`gateway/mod.rs::origin_allowed` 要求
// `Origin` 与 `Host` 同源），而客户端是**另一台** Codem 桌面：它 WebView 的 origin 是
// `tauri://localhost`，POST JSON 又会先触发 CORS 预检。渲染层直接 fetch 的结果是
// 预检被 405、真请求被 403 —— 也就是说"客户端 + cookie + fetch"这条路在真实机器上
// **根本不通**（这是实现时才发现的，设计稿里写的是 fetch）。
//
// Rust 侧发请求**不带 Origin**（与 curl/本机客户端同类），网关对这类请求只要求
// 设备 cookie 鉴权（见 `origin_allowed` 的第一行注释）—— 于是客户端走的还是网关
// **现有**的安全模型，不需要为跨源放宽任何一条（放宽会削弱 CSRF 防护）。
//
// ## 边界（它不做什么）
//
// - 只发一条 JSON-RPC：不解析业务、不重试、不跟随跨主机重定向（凭据只发给指定 Host）；
// - **不存凭据**：设备 token 由渲染层保管（封存后存 settings），这里只在本次请求上
//   附 `Cookie` 头，并把应答里新种下的 token 原样带回；
// - 只允许 http(s) 且必须有主机名；应答体积有上限（4 MB）。
// ============================================================

use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::phone::gateway::pairing::DEVICE_COOKIE_NAME;

/// 单次应答体积上限：同步应答本身有 1 MB 的协议上限，这里留 4 倍余量。
const MAX_BODY_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Deserialize)]
pub struct GatewayClientRpcArgs {
    /// 目标 Host 的 `/rpc` 地址（http/https）
    pub url: String,
    /// 已经序列化好的 JSON-RPC 请求体
    pub body: String,
    /// 已配对设备的 token（首次配对时为空；从应答的 `Set-Cookie` 里取）
    pub token: Option<String>,
    /// 超时（毫秒；默认 12s，夹在 1s–60s）
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Serialize)]
pub struct GatewayClientRpcReply {
    /// HTTP 状态码（401 = 未配对/凭据失效，由渲染层给出人话）
    pub status: u16,
    /// 原始 JSON-RPC 应答体
    pub body: String,
    /// 应答里新种下的设备 token（只有 `pair.claim` 成功时出现）
    pub device_token: Option<String>,
}

fn validate_url(raw: &str) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(raw).map_err(|e| format!("Host 地址不合法：{e}"))?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err("Host 地址必须是 http(s)".to_string());
    }
    // `http:///rpc` 这类"特殊 scheme + 空 host"会被 Url 接受但 host 是空串 ⇒ 必须一起拒
    match url.host_str() {
        None | Some("") => return Err("Host 地址缺少主机名".to_string()),
        _ => {}
    }
    Ok(url)
}

/// 从 `Set-Cookie` 里取设备 token（**唯一的**出站凭据来源）。
fn device_token_from(headers: &reqwest::header::HeaderMap) -> Option<String> {
    let prefix = format!("{DEVICE_COOKIE_NAME}=");
    for value in headers.get_all(reqwest::header::SET_COOKIE).iter() {
        let Ok(text) = value.to_str() else { continue };
        let Some(rest) = text.trim().strip_prefix(prefix.as_str()) else {
            continue;
        };
        let token = rest.split(';').next().unwrap_or("").trim();
        if !token.is_empty() {
            return Some(token.to_string());
        }
    }
    None
}

/// 发一条 JSON-RPC（**不带 Origin**，带可选设备 cookie），把应答原样带回。
#[tauri::command]
pub async fn gateway_client_rpc(
    args: GatewayClientRpcArgs,
) -> Result<GatewayClientRpcReply, String> {
    let url = validate_url(&args.url)?;
    let timeout = Duration::from_millis(args.timeout_ms.unwrap_or(12_000).clamp(1_000, 60_000));
    let client = reqwest::Client::builder()
        .timeout(timeout)
        // 不跟重定向：设备凭据只发给调用方指定的那个 Host
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| format!("构造 HTTP 客户端失败：{e}"))?;

    let mut request = client
        .post(url)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(args.body);
    if let Some(token) = args.token.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
        request = request.header(
            reqwest::header::COOKIE,
            format!("{DEVICE_COOKIE_NAME}={token}"),
        );
    }

    let response = request.send().await.map_err(|e| format!("连接 Host 失败：{e}"))?;
    let status = response.status().as_u16();
    let device_token = device_token_from(response.headers());
    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("读 Host 应答失败：{e}"))?;
    if bytes.len() > MAX_BODY_BYTES {
        return Err(format!("Host 应答过大（>{MAX_BODY_BYTES} 字节）"));
    }
    let body = String::from_utf8_lossy(&bytes).into_owned();
    Ok(GatewayClientRpcReply {
        status,
        body,
        device_token,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_validation_rejects_non_http_and_hostless() {
        assert!(validate_url("http://127.0.0.1:54321/rpc").is_ok());
        assert!(validate_url("https://x.ts.net/rpc").is_ok());
        assert!(validate_url("file:///etc/passwd").is_err());
        assert!(validate_url("not a url").is_err());
        assert!(validate_url("http://").is_err());
        assert!(validate_url("http://:8080/rpc").is_err());
    }

    #[test]
    fn device_token_is_read_from_set_cookie_only() {
        let mut headers = reqwest::header::HeaderMap::new();
        headers.append(
            reqwest::header::SET_COOKIE,
            "codem_gateway_device=abc123; Path=/; HttpOnly; SameSite=Strict; Max-Age=60"
                .parse()
                .expect("cookie header"),
        );
        assert_eq!(device_token_from(&headers).as_deref(), Some("abc123"));
        assert_eq!(device_token_from(&reqwest::header::HeaderMap::new()), None);
    }
}
