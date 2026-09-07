// ============================================================
// ilink/proto.rs — iLink 协议基础：serde 模型、请求头、HTTP 原语
//
// 对照：腾讯官方 @tencent-weixin/openclaw-weixin 2.4.6 公开源码
// (research/owx_* 快照) + 社区实测 (wechat-ilink-report.md)。
// 事实分级：官方 = 源码/文档；社区 = 实测逆向；条款 = 腾讯用户协议。
// 本文件只做协议编解码，不做状态机（状态机在 mod.rs/login.rs/poll.rs）。
// ============================================================

use base64::Engine;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, AUTHORIZATION, CONTENT_TYPE};
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;
use std::time::Duration;

// ---- 常量（官方/社区一致）----

/// 默认 iLink 服务端地址（登录响应可能给不同 baseurl，需缓存使用）。
pub const DEFAULT_BASE_URL: &str = "https://ilinkai.weixin.qq.com";
/// 渠道协议版本（channel_version / ClientVersion 编码基准）——官方 2.4.6。
pub const CHANNEL_VERSION: &str = "2.4.6";
/// 自报应用名（仅观测，不参与鉴权）——官方 base_info.bot_agent 语义。
pub const BOT_AGENT: &str = "Codem-WeChat/1.0.0";
/// iLink-App-Id —— 官方 package.json 顶层字段，固定 "bot"。
pub const APP_ID: &str = "bot";
/// 本端判活 TTL：官方按 23h 提前判过期（SESSION_TTL_MS=23h，留 1h 缓冲）【EAC 桥注释】。
pub const SESSION_TTL_MS: i64 = 23 * 3600 * 1000;
/// getupdates 单次客户端超时：服务端 hold ≤35s，客户端给 38s 余量。
pub const POLL_TIMEOUT: Duration = Duration::from_millis(38_000);
/// get_qrcode_status 长轮询客户端超时（服务端 hold 35s）。
pub const QR_TIMEOUT: Duration = Duration::from_millis(35_000);
/// QR 过期/配对码封禁后最多自动刷新次数【官方 login-qr.ts】。
pub const MAX_QR_REFRESH: u32 = 3;
/// 单条文本上限安全线【EAC 桥 2000 / 官方 4000】。
pub const TEXT_CHUNK_LEN: usize = 2000;

/// 24h 主动消息配额窗口与上限（社区实测；腾讯条款未承诺，本端软记账）【§7.2】。
pub const QUOTA_WINDOW_MS: i64 = 24 * 3600 * 1000;
pub const QUOTA_MAX: u32 = 10;

/// 单例 HTTP client（gzip 开启，与现有 http_get/http_download 一致）。
fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .gzip(true)
            .build()
            .expect("ilink reqwest client build")
    })
}

// ---- 客户端版本 / UIN 工具 ----

/// 0x00MMNNPP → 十进制字符串：2.4.6 → 132102【官方 api.ts】。
pub fn client_version_str() -> String {
    let parts: Vec<u32> = CHANNEL_VERSION
        .split('.')
        .filter_map(|p| p.parse::<u32>().ok())
        .collect();
    let major = parts.first().copied().unwrap_or(0) & 0xff;
    let minor = parts.get(1).copied().unwrap_or(0) & 0xff;
    let patch = parts.get(2).copied().unwrap_or(0) & 0xff;
    ((major << 16) | (minor << 8) | patch).to_string()
}

/// X-WECHAT-UIN：base64(十进制字符串(random uint32))，每请求随机【官方】。
pub fn random_uin_b64() -> String {
    let n: u32 = rand::random();
    base64::engine::general_purpose::STANDARD.encode(n.to_string().as_bytes())
}

// ---- 请求头 ----

/// 统一请求头（官方 buildHeaders 形态 + Authorization 可选）。
/// GET/POST 均带全头（EAC 桥做法，两态都有真实链路通过）【§2.1】。
pub fn headers(auth: Option<&str>) -> HeaderMap {
    let mut h = HeaderMap::new();
    h.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    h.insert(
        HeaderName::from_static("authorizationtype"),
        HeaderValue::from_static("ilink_bot_token"),
    );
    h.insert(
        HeaderName::from_static("x-wechat-uin"),
        HeaderValue::from_str(&random_uin_b64()).unwrap_or(HeaderValue::from_static("")),
    );
    h.insert(
        HeaderName::from_static("ilink-app-id"),
        HeaderValue::from_static(APP_ID),
    );
    h.insert(
        HeaderName::from_static("ilink-app-clientversion"),
        HeaderValue::from_str(&client_version_str()).unwrap_or(HeaderValue::from_static("0")),
    );
    if let Some(token) = auth {
        if let Ok(v) = HeaderValue::from_str(&format!("Bearer {}", token)) {
            h.insert(AUTHORIZATION, v);
        }
    }
    h
}

// ---- serde 模型（字段全部 Option，宽容解析未知/缺失字段）----

/// 登录会话（持久化到 app-data/ilink/session.json）。
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct WechatSession {
    /// bot_token（Bearer 凭据；24h 级有效，绝不打日志全量）。
    pub token: String,
    /// ilink_bot_id，形如 `hex@im.bot`（每次重扫会变）【社区】。
    pub bot_id: String,
    /// ilink_user_id（绑定者，形如 `xxx@im.wechat`；同微信号稳定）【社区推测】。
    pub user_id: String,
    /// 登录返回的 baseurl（默认 ilinkai.weixin.qq.com），必须缓存使用。
    pub base_url: String,
    /// savedAt 毫秒；超 23h 判过期。
    pub saved_at_ms: i64,
    /// get_updates_buf 游标（每轮持久化，重启续拉）。
    pub cursor: String,
}

impl WechatSession {
    pub fn is_fresh(&self, now_ms: i64) -> bool {
        now_ms - self.saved_at_ms < SESSION_TTL_MS
    }
    pub fn effective_base(&self) -> String {
        if self.base_url.trim().is_empty() {
            DEFAULT_BASE_URL.to_string()
        } else {
            self.base_url.clone()
        }
    }
}

/// getupdates 响应。
#[derive(Deserialize, Debug, Default)]
pub struct UpdatesResponse {
    #[serde(default)]
    pub ret: Option<i64>,
    #[serde(default)]
    pub errcode: Option<i64>,
    #[serde(default)]
    pub errmsg: Option<String>,
    #[serde(default)]
    pub msgs: Option<Vec<WeixinMessage>>,
    #[serde(default)]
    pub get_updates_buf: Option<String>,
}

/// 入站消息（message_type==1 用户消息才处理；2 是自身回声忽略）。
#[derive(Deserialize, Debug, Clone, Default)]
pub struct WeixinMessage {
    #[serde(default)]
    pub message_id: Option<String>,
    #[serde(default)]
    pub from_user_id: Option<String>,
    #[serde(default)]
    pub group_id: Option<String>,
    #[serde(default)]
    pub message_type: Option<i64>,
    #[serde(default)]
    pub create_time_ms: Option<i64>,
    #[serde(default)]
    pub context_token: Option<String>,
    #[serde(default)]
    pub item_list: Option<Vec<Item>>,
}

#[derive(Deserialize, Debug, Clone, Default)]
pub struct Item {
    #[serde(rename = "type", default)]
    pub item_type: Option<i64>,
    #[serde(default)]
    pub text_item: Option<TextItem>,
}

#[derive(Deserialize, Debug, Clone, Default)]
pub struct TextItem {
    #[serde(default)]
    pub text: Option<String>,
    #[serde(rename = "ref_msg", default)]
    pub ref_msg: Option<RefMsg>,
}

#[derive(Deserialize, Debug, Clone, Default)]
pub struct RefMsg {
    #[serde(default)]
    pub title: Option<String>,
}

// ---- HTTP 原语 ----

#[derive(Debug)]
pub enum ApiError {
    /// 服务端 hold 结束/本地超时——长轮询的正常控制流。
    Timeout,
    /// HTTP 非 2xx（401/403 = 会话失效，必须显式处理，不能静默吞掉）【§7.3】。
    HttpStatus(u16, String),
    /// 网络层错误（连接失败等）——调用方退避重试。
    Network(String),
    /// 非 JSON / 结构不可解析。
    Invalid(String),
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ApiError::Timeout => write!(f, "request timeout"),
            ApiError::HttpStatus(c, body) => write!(f, "HTTP {}: {}", c, truncate(body, 120)),
            ApiError::Network(e) => write!(f, "network: {}", truncate(e, 160)),
            ApiError::Invalid(e) => write!(f, "invalid payload: {}", truncate(e, 160)),
        }
    }
}

fn truncate(s: &str, n: usize) -> String {
    let t: String = s.chars().take(n).collect();
    if s.chars().count() > n { format!("{}…", t) } else { t }
}

fn err_from_status(status: reqwest::StatusCode, text: &str) -> ApiError {
    if status == reqwest::StatusCode::REQUEST_TIMEOUT {
        ApiError::Timeout
    } else {
        ApiError::HttpStatus(status.as_u16(), text.to_string())
    }
}

fn map_reqwest_err(e: reqwest::Error) -> ApiError {
    if e.is_timeout() {
        ApiError::Timeout
    } else if let Some(status) = e.status() {
        ApiError::HttpStatus(status.as_u16(), e.to_string())
    } else {
        ApiError::Network(e.to_string())
    }
}

fn parse_json(text: &str) -> Result<serde_json::Value, ApiError> {
    serde_json::from_str(text).map_err(|_| {
        // 非 JSON（例如 401 时服务端回 HTML 错误体）——判定为会话/请求异常。
        let head: String = text.chars().take(160).collect();
        ApiError::Invalid(head)
    })
}

/// POST JSON（带超时）。非 2xx 抛错，不吞 401。
pub async fn post_json(
    base_url: &str,
    path: &str,
    params: &[(&str, &str)],
    body: serde_json::Value,
    auth: Option<&str>,
    timeout: Duration,
) -> Result<serde_json::Value, ApiError> {
    let url = build_url(base_url, path, params);
    let resp = client()
        .post(&url)
        .headers(headers(auth))
        .json(&body)
        .timeout(timeout)
        .send()
        .await
        .map_err(map_reqwest_err)?;
    let status = resp.status();
    let text = resp.text().await.map_err(map_reqwest_err)?;
    if !status.is_success() {
        return Err(err_from_status(status, &text));
    }
    parse_json(&text)
}

/// GET（长轮询类用；超时返回 Timeout 由调用方按"继续轮询"处理）。
pub async fn get_json(
    base_url: &str,
    path: &str,
    params: &[(&str, &str)],
    auth: Option<&str>,
    timeout: Duration,
) -> Result<serde_json::Value, ApiError> {
    let url = build_url(base_url, path, params);
    let resp = client()
        .get(&url)
        .headers(headers(auth))
        .timeout(timeout)
        .send()
        .await
        .map_err(map_reqwest_err)?;
    let status = resp.status();
    let text = resp.text().await.map_err(map_reqwest_err)?;
    if !status.is_success() {
        return Err(err_from_status(status, &text));
    }
    parse_json(&text)
}

fn build_url(base: &str, path: &str, params: &[(&str, &str)]) -> String {
    let mut url = format!("{}{}", base.trim_end_matches('/'), path);
    if !params.is_empty() {
        let qs: Vec<String> = params
            .iter()
            .map(|(k, v)| format!("{}={}", urlencode(k), urlencode(v)))
            .collect();
        url.push('?');
        url.push_str(&qs.join("&"));
    }
    url
}

/// 极简 percent-encoding（只处理查询参数里的 key/value）。
fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
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

/// 从入站消息提取文本：拼接 item_list 中 type==1 的 text（ref_msg.title 作引用前缀）。
/// 仅处理纯文本——媒体（图片/文件/语音）MVP 忽略【§6.1】。
pub fn extract_text(msg: &WeixinMessage) -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Some(items) = &msg.item_list {
        for item in items {
            if item.item_type != Some(1) {
                continue;
            }
            if let Some(ti) = &item.text_item {
                let mut seg = String::new();
                if let Some(r) = &ti.ref_msg {
                    if let Some(title) = &r.title {
                        if !title.is_empty() {
                            seg.push_str(&format!("[引用: {}]\n", title));
                        }
                    }
                }
                if let Some(t) = &ti.text {
                    seg.push_str(t);
                }
                if !seg.trim().is_empty() {
                    parts.push(seg);
                }
            }
        }
    }
    parts.join("\n")
}

/// 文本切块：按安全线 max 字节切（超出被切为多条，每条都计配额）【§4.2】。
/// UTF-8 安全：回退到字符边界，避免切断多字节字符。
pub fn chunk_text(text: &str, max: usize) -> Vec<String> {
    if text.len() <= max {
        return vec![text.to_string()];
    }
    let mut out = Vec::new();
    let mut start = 0;
    while start < text.len() {
        let mut end = (start + max).min(text.len());
        while end > start && !text.is_char_boundary(end) {
            end -= 1;
        }
        if end == start {
            // 单字符就超长（罕见）——按字符边界至少推进一个字符，避免死循环。
            end = text[start..].chars().next().map(|c| start + c.len_utf8()).unwrap_or(start);
        }
        out.push(text[start..end].to_string());
        start = end;
    }
    out
}

// ---- 单元测试（纯逻辑，无需网络）----

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn client_version_246() {
        assert_eq!(client_version_str(), "132102");
    }

    #[test]
    fn uin_is_base64_of_decimal() {
        // 两次调用应不同（随机），且都能 base64 解码为十进制数字串。
        let a = random_uin_b64();
        let b = random_uin_b64();
        assert_ne!(a, b);
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(a)
            .expect("decode");
        let s = String::from_utf8(decoded).expect("utf8");
        assert!(s.parse::<u32>().is_ok());
    }

    #[test]
    fn headers_shape() {
        let h = headers(Some("tok"));
        assert_eq!(
            h.get("authorization").unwrap().to_str().unwrap(),
            "Bearer tok"
        );
        assert_eq!(h.get("authorizationtype").unwrap(), "ilink_bot_token");
        assert_eq!(h.get("ilink-app-clientversion").unwrap(), "132102");
        assert!(h.contains_key("x-wechat-uin"));
        // 无 token 时不带 Authorization
        let h2 = headers(None);
        assert!(!h2.contains_key("authorization"));
    }

    #[test]
    fn extract_text_concat_and_ref() {
        let mut m = WeixinMessage::default();
        m.message_type = Some(1);
        m.item_list = Some(vec![
            Item {
                item_type: Some(1),
                text_item: Some(TextItem {
                    text: Some("你好".into()),
                    ..Default::default()
                }),
            },
            Item {
                item_type: Some(2), // 图片：忽略
                text_item: None,
            },
            Item {
                item_type: Some(1),
                text_item: Some(TextItem {
                    text: Some("世界".into()),
                    ref_msg: Some(RefMsg {
                        title: Some("上一条".into()),
                    }),
                }),
            },
        ]);
        let t = extract_text(&m);
        assert!(t.contains("你好"));
        assert!(t.contains("世界"));
        assert!(t.contains("上一条"));
    }

    #[test]
    fn chunk_utf8_safe() {
        let text = "你好".repeat(2000); // 4000 字节（UTF-8 中文 3 字节）
        let chunks = chunk_text(&text, TEXT_CHUNK_LEN);
        assert!(chunks.len() >= 2);
        let joined: String = chunks.iter().flat_map(|s| s.chars()).collect();
        assert_eq!(joined, text);
        for c in &chunks {
            assert!(c.len() <= TEXT_CHUNK_LEN);
        }
    }

    #[test]
    fn session_freshness() {
        let now = 1_000_000_000_000i64;
        let fresh = WechatSession {
            saved_at_ms: now - SESSION_TTL_MS + 1000,
            ..Default::default()
        };
        assert!(fresh.is_fresh(now));
        let stale = WechatSession {
            saved_at_ms: now - SESSION_TTL_MS - 1000,
            ..Default::default()
        };
        assert!(!stale.is_fresh(now));
    }
}
