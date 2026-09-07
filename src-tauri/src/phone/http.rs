// ============================================================
// phone/http.rs — 极简 HTTP/1.1 解析与响应（tokio 手写，零新依赖）
//
// 只支持本项目自用客户端的子集：
//   GET/POST；请求行 + 头 + Content-Length body；Connection: close 每次一请求一响应。
// 不实现 keep-alive/chunked/升级——手机端页面全部 fetch 短连接，足够。
// ============================================================

use std::collections::HashMap;

/// 已解析的请求（仅关心我们需要的字段）。
#[derive(Debug, Clone)]
pub struct Request {
    pub method: String,
    /// 不含 query 的路径（已解码）。
    pub path: String,
    /// query 参数（已解码）。
    pub query: HashMap<String, String>,
    /// 小写头名 → 值（trim）。
    pub headers: HashMap<String, String>,
    /// POST body（原始字节；上限 2MB）。
    pub body: Vec<u8>,
}

#[derive(Debug, PartialEq)]
pub enum ParseError {
    Malformed(&'static str),
}

/// 百分号解码（极简 UTF-8 安全：按字节解码）。
pub fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            let h = hex_val(b[i + 1]);
            let l = hex_val(b[i + 2]);
            if let (Some(h), Some(l)) = (h, l) {
                out.push((h << 4) | l);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex_val(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}

fn parse_query(qs: &str) -> HashMap<String, String> {
    let mut m = HashMap::new();
    for pair in qs.split('&') {
        if pair.is_empty() {
            continue;
        }
        let (k, v) = match pair.split_once('=') {
            Some((k, v)) => (k, v),
            None => (pair, ""),
        };
        m.insert(percent_decode(k), percent_decode(v));
    }
    m
}

/// 从"头部原始文本 + body 字节"构建 Request。
pub fn parse(head: &str, body: Vec<u8>) -> Result<Request, ParseError> {
    let mut lines = head.split("\r\n");
    let request_line = lines.next().unwrap_or("").trim_end();
    let mut parts = request_line.split_whitespace();
    let method = parts.next().ok_or(ParseError::Malformed("no method"))?.to_string();
    let target = parts.next().ok_or(ParseError::Malformed("no target"))?.to_string();
    // 忽略 HTTP 版本（第三段）。

    let (raw_path, query) = match target.split_once('?') {
        Some((p, q)) => (p.to_string(), q.to_string()),
        None => (target.clone(), String::new()),
    };
    let path = percent_decode(&raw_path);

    let mut headers = HashMap::new();
    for line in lines {
        let line = line.trim_end();
        if line.is_empty() {
            continue;
        }
        if let Some((name, value)) = line.split_once(':') {
            headers.insert(name.trim().to_lowercase(), value.trim().to_string());
        }
    }

    Ok(Request {
        method,
        path,
        query: parse_query(&query),
        headers,
        body,
    })
}

/// 从累积字节缓冲中切出请求：返回 (head_text, 剩余部分/或需继续读的 body 长度)。
/// 调用方负责：累积 → 找 \r\n\r\n → 读满 content-length → parse。
pub fn split_request(buf: &[u8]) -> Option<(String, usize, usize)> {
    // 返回 (head_text, header_end, content_length)
    let idx = find_sub(buf, b"\r\n\r\n")?;
    let head = String::from_utf8_lossy(&buf[..idx]).into_owned();
    let cl = header_value(&head, "content-length")
        .and_then(|v| v.trim().parse::<usize>().ok())
        .unwrap_or(0);
    Some((head, idx + 4, cl))
}

fn find_sub(buf: &[u8], pat: &[u8]) -> Option<usize> {
    if pat.is_empty() || buf.len() < pat.len() {
        return None;
    }
    buf.windows(pat.len()).position(|w| w == pat)
}

/// 头字段取值（小写名匹配）。
pub fn header_value(head: &str, name: &str) -> Option<String> {
    for line in head.split("\r\n") {
        if let Some((n, v)) = line.split_once(':') {
            if n.trim().to_lowercase() == name {
                return Some(v.trim().to_string());
            }
        }
    }
    None
}

/// 解析 Cookie 头 → key→value。
pub fn parse_cookies(cookie_header: Option<&str>) -> HashMap<String, String> {
    let mut m = HashMap::new();
    if let Some(c) = cookie_header {
        for kv in c.split(';') {
            let kv = kv.trim();
            if kv.is_empty() {
                continue;
            }
            if let Some((k, v)) = kv.split_once('=') {
                m.insert(k.trim().to_string(), percent_decode(v.trim()));
            }
        }
    }
    m
}

/// 简易响应组装。
pub struct Response {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Response {
    pub fn json(status: u16, json: serde_json::Value) -> Response {
        let body = serde_json::to_vec(&json).unwrap_or_default();
        Response {
            status,
            headers: vec![
                ("Content-Type".into(), "application/json; charset=utf-8".into()),
                ("Cache-Control".into(), "no-store".into()),
            ],
            body,
        }
    }
    pub fn text(status: u16, content_type: &str, text: &str) -> Response {
        Response {
            status,
            headers: vec![("Content-Type".into(), content_type.into())],
            body: text.as_bytes().to_vec(),
        }
    }
    pub fn html(status: u16, html: &str) -> Response {
        Response::text(status, "text/html; charset=utf-8", html)
    }
    /// 写为 HTTP 原始字节。
    pub fn to_bytes(&self) -> Vec<u8> {
        let reason = match self.status {
            200 => "OK",
            201 => "Created",
            202 => "Accepted",
            400 => "Bad Request",
            401 => "Unauthorized",
            403 => "Forbidden",
            404 => "Not Found",
            405 => "Method Not Allowed",
            409 => "Conflict",
            410 => "Gone",
            413 => "Payload Too Large",
            500 => "Internal Server Error",
            502 => "Bad Gateway",
            504 => "Gateway Timeout",
            _ => "OK",
        };
        let mut out = format!("HTTP/1.1 {} {}\r\n", self.status, reason).into_bytes();
        for (k, v) in &self.headers {
            out.extend_from_slice(format!("{}: {}\r\n", k, v).as_bytes());
        }
        out.extend_from_slice(format!("Content-Length: {}\r\n", self.body.len()).as_bytes());
        out.extend_from_slice(b"Connection: close\r\n\r\n");
        out.extend_from_slice(&self.body);
        out
    }
}

// ---- 单测 ----

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_get_with_query() {
        let head = "GET /api/sessions/abc%40def/messages?limit=20 HTTP/1.1\r\nHost: x\r\nCookie: a=1; codem_phone=secret%2Bvalue\r\n\r\n";
        let req = parse(head, vec![]).unwrap();
        assert_eq!(req.method, "GET");
        assert_eq!(req.path, "/api/sessions/abc@def/messages");
        assert_eq!(req.query.get("limit").map(|s| s.as_str()), Some("20"));
        let cookies = parse_cookies(req.headers.get("cookie").map(|s| s.as_str()));
        assert_eq!(cookies.get("codem_phone").map(|s| s.as_str()), Some("secret+value"));
    }

    #[test]
    fn parse_post_body_and_cl() {
        let head = "POST /api/chat HTTP/1.1\r\nContent-Type: application/json\r\nContent-Length: 5\r\n\r\n";
        let req = parse(head, b"hello".to_vec()).unwrap();
        assert_eq!(req.method, "POST");
        assert_eq!(req.body, b"hello");
    }

    #[test]
    fn percent_decode_basic() {
        assert_eq!(percent_decode("a%20b%2Fc"), "a b/c");
        assert_eq!(percent_decode("wxid_ab%40im.wechat"), "wxid_ab@im.wechat");
        assert_eq!(percent_decode("你好"), "你好");
    }

    #[test]
    fn split_and_headers() {
        let buf = b"GET / HTTP/1.1\r\nHost: a\r\nContent-Length: 3\r\n\r\nabc";
        let (head, end, cl) = split_request(buf).unwrap();
        assert_eq!(end, 46); // 头含结尾 \r\n\r\n
        assert_eq!(cl, 3);
        assert_eq!(header_value(&head, "content-length").as_deref(), Some("3"));
        assert_eq!(parse(&head, buf[end..end + cl].to_vec()).unwrap().body, b"abc");
    }

    #[test]
    fn response_bytes_shape() {
        let r = Response::json(200, serde_json::json!({"ok": true}));
        let bytes = r.to_bytes();
        let s = String::from_utf8(bytes).unwrap();
        assert!(s.starts_with("HTTP/1.1 200 OK\r\n"));
        assert!(s.contains("Content-Type: application/json; charset=utf-8"));
        assert!(s.ends_with("{\"ok\":true}"));
    }

    #[test]
    fn cookie_parse_multiple() {
        let m = parse_cookies(Some("a=1; codem_phone=xyz; path=/"));
        assert_eq!(m.get("codem_phone").map(|s| s.as_str()), Some("xyz"));
        assert_eq!(m.len(), 3);
    }
}
