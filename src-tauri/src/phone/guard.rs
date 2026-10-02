// ============================================================
// phone/guard.rs — LAN 边缘的**准入策略**（阶段 1：安全对齐）
//
// 这个文件只放**纯函数**：不碰网络、不碰状态，输入是"请求长什么样"，
// 输出是"放行还是拒绝"。好处是每条策略都能被单测直接钉住，
// 而不是只能靠"真机试一下"。
//
// 四条策略的来源（对标 DSH Desktop 的 `lan-https-ingress.ts` 与
// `desktop-browser-access.ts`）：
//
// 1. **Host 白名单**：`Host` 头必须是我们自己宣告过的「IP:端口」之一。
//    DSH 的原话是「HTTPS/WSS ingress… externalHost(headers) … allowedAddresses.has(host)」
//    （`lan-https-runtime-*.js:34-52`）。没有这一条，一个指向我们 IP 的
//    **DNS 记录**就能让浏览器把任意域名的请求打到我们端口上。
// 2. **拒跨站**：`Sec-Fetch-Site: cross-site` 一律拒（现代浏览器会带这个头）。
//    DSH 用 `!isCrossSite(headers)` 做同一件事（同上 `:52`）。
// 3. **边缘标记**：只有经过 TLS 边缘的请求才允许打到回环上游 ——
//    边缘注入一个**每次运行随机**的标记头，上游没有它就拒。
//    这样"上游只绑回环"才有意义：本机别的进程**不能绕过边缘的 Host 校验**。
//    （DSH 对应的是 `x-dsh-desktop-renderer` 那个 32 字节 token，见
//    `desktop-browser-access-*.js:5-7,47-51`。）
// 4. **恒定时间比对**：cookie secret 的比对不能因"第几位不同"而提前返回，
//    否则响应时间会泄露"前缀猜对了多少"。
//
// 诚实标注：本文件**不**做鉴权（那是 cookie 的职责），它只回答
// "这个请求配不配到达鉴权那一步"。
// ============================================================

use std::collections::HashSet;

use super::timing_safe_eq;

/// 边缘注入的标记头名（小写，与 http.rs 的头表一致）。
pub const EDGE_HEADER: &str = "x-codem-edge";

/// 允许的 Host 值集合（小写，含端口）。
///
/// 覆盖：本机回环、我们宣告的 LAN IP、以及 `localhost`。
/// **不含通配**：任何其它域名（例如攻击者用 DNS 指向我们 IP 的那个域名）一律不在集合里。
pub fn allowed_hosts(lan_ip: &str, port: u16) -> HashSet<String> {
    let mut s = HashSet::new();
    for ip in ["127.0.0.1", "localhost", lan_ip] {
        if ip.is_empty() {
            continue;
        }
        let ip = ip.to_ascii_lowercase();
        s.insert(format!("{}:{}", ip, port));
        // 也接受不带端口的形态（默认端口/反代场景）
        s.insert(ip);
    }
    s
}

/// 请求是否**来自跨站**上下文。
///
/// 两道判据（有其一即视为跨站）：
/// - `Sec-Fetch-Site: cross-site`
/// - `Origin` 存在且其 host 不在允许集合里
///
/// 为什么两者都看：`Sec-Fetch-*` 只有现代浏览器发；`Origin` 在跨站
/// 非简单请求（含预检）里必然出现。两条互补，缺一条就有一类客户端绕过。
pub fn is_cross_site(
    sec_fetch_site: Option<&str>,
    origin: Option<&str>,
    allowed: &HashSet<String>,
) -> bool {
    if let Some(v) = sec_fetch_site {
        let v = v.trim().to_ascii_lowercase();
        if v == "cross-site" {
            return true;
        }
    }
    if let Some(o) = origin {
        let o = o.trim();
        // "null" 是不透明来源（沙箱 iframe / file://），一律拒
        if o.eq_ignore_ascii_case("null") {
            return true;
        }
        if let Some(rest) = o.split_once("://").map(|(_, r)| r) {
            let host = rest.trim_end_matches('/').to_ascii_lowercase();
            // 去掉路径
            let host = host.split('/').next().unwrap_or("").to_string();
            if !allowed.contains(&host) {
                return true;
            }
        } else {
            // 解析不出协议的 Origin：拒（宁可误拒，不放行来路不明的东西）
            return true;
        }
    }
    false
}

/// 边缘准入的判定结果（拒绝时带原因，便于**如实**回给客户端与日志）。
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum EdgeVerdict {
    Allow,
    /// Host 头缺失或不在白名单（含 DNS rebinding 的典型形态）
    BadHost,
    /// 跨站请求
    CrossSite,
}

/// 边缘准入：Host 白名单 + 拒跨站。
pub fn edge_verdict(
    host_header: Option<&str>,
    sec_fetch_site: Option<&str>,
    origin: Option<&str>,
    allowed: &HashSet<String>,
) -> EdgeVerdict {
    let host = host_header.map(|h| h.trim().to_ascii_lowercase()).unwrap_or_default();
    if host.is_empty() || !allowed.contains(&host) {
        return EdgeVerdict::BadHost;
    }
    if is_cross_site(sec_fetch_site, origin, allowed) {
        return EdgeVerdict::CrossSite;
    }
    EdgeVerdict::Allow
}

/// 上游准入：只有带**本次运行的**边缘标记的请求才放行。
///
/// 这是"上游只绑回环"这句话的实际内容：本机别的进程即使知道了端口，
/// 也拿不到标记（它是每次启动随机生成、只存在于进程内存里），
/// 于是**不能绕过边缘的 Host 校验**直连上游。
pub fn upstream_allowed(edge_header: Option<&str>, expected: &str) -> bool {
    match edge_header {
        Some(v) => timing_safe_eq(v.trim(), expected),
        None => false,
    }
}

/// 在转发给上游之前，把请求头里的边缘标记**替换成我们自己的**。
///
/// ## 这是一个真实的绕过点，必须处理
///
/// 如果只是"追加"一个标记头，那么 LAN 上的客户端可以自己带一个
/// `x-codem-edge: <随便猜>` —— 上游看到**两个**同名头时取哪个由解析实现决定，
/// 而 http.rs 的 `HashMap` 是**后写覆盖**。于是：
/// 客户端伪造的头若排在后面就赢了。
///
/// 所以这里**先无条件删掉**所有同名头，再追加我们自己的。
/// 顺序固定为"删干净 + 追加一个"，与客户端发了什么无关。
///
/// 输入是 head 原文（含请求行，**不含**末尾空行），输出同样不含末尾空行。
pub fn inject_edge_header(head: &str, token: &str) -> String {
    let mut out = String::with_capacity(head.len() + EDGE_HEADER.len() + token.len() + 4);
    for (i, line) in head.split("\r\n").enumerate() {
        // 第 0 行是请求行，必须原样保留
        if i == 0 {
            out.push_str(line);
            continue;
        }
        if line.is_empty() {
            continue; // 末尾空行稍后统一补
        }
        match line.split_once(':') {
            Some((name, _)) if name.trim().to_ascii_lowercase() == EDGE_HEADER => continue,
            _ => {}
        }
        out.push_str("\r\n");
        out.push_str(line);
    }
    out.push_str("\r\n");
    out.push_str(EDGE_HEADER);
    out.push_str(": ");
    out.push_str(token);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hosts() -> HashSet<String> {
        allowed_hosts("192.168.1.20", 8080)
    }

    #[test]
    fn edge_rejects_foreign_host() {
        let h = hosts();
        assert_eq!(edge_verdict(Some("192.168.1.20:8080"), None, None, &h), EdgeVerdict::Allow);
        assert_eq!(edge_verdict(Some("localhost:8080"), None, None, &h), EdgeVerdict::Allow);
        // DNS rebinding 的典型形态：域名指向我们的 IP，但 Host 是那个域名
        assert_eq!(edge_verdict(Some("evil.example.com"), None, None, &h), EdgeVerdict::BadHost);
        assert_eq!(edge_verdict(None, None, None, &h), EdgeVerdict::BadHost);
    }

    #[test]
    fn edge_rejects_cross_site() {
        let h = hosts();
        assert_eq!(
            edge_verdict(Some("192.168.1.20:8080"), Some("cross-site"), None, &h),
            EdgeVerdict::CrossSite
        );
        assert_eq!(
            edge_verdict(Some("192.168.1.20:8080"), None, Some("http://evil.example.com"), &h),
            EdgeVerdict::CrossSite
        );
        assert_eq!(
            edge_verdict(Some("192.168.1.20:8080"), None, Some("null"), &h),
            EdgeVerdict::CrossSite
        );
        // 同源放行
        assert_eq!(
            edge_verdict(Some("192.168.1.20:8080"), None, Some("http://192.168.1.20:8080"), &h),
            EdgeVerdict::Allow
        );
    }

    #[test]
    fn upstream_needs_edge_marker() {
        assert!(upstream_allowed(Some("tok123"), "tok123"));
        assert!(!upstream_allowed(Some("tok124"), "tok123"));
        assert!(!upstream_allowed(Some(""), "tok123"));
        assert!(!upstream_allowed(None, "tok123"));
    }

    #[test]
    fn inject_replaces_client_supplied_marker() {
        // 这条判据守的是一个**真实绕过点**：
        // 只追加不删除的话，客户端自带的伪标记会与我们的并存，
        // 而 http.rs 的头表是后写覆盖 ⇒ 伪造的可能赢。
        let head = "GET /api/status HTTP/1.1\r\nHost: 192.168.1.20:8443\r\nx-codem-edge: FORGED\r\nCookie: a=b";
        let out = inject_edge_header(head, "REAL");
        // 伪造的那个必须消失
        assert!(!out.contains("FORGED"), "客户端的伪标记必须被删掉：{}", out);
        // 我们的必须在，且只有一条
        assert_eq!(out.matches("x-codem-edge").count(), 1);
        assert!(out.contains("x-codem-edge: REAL"));
        // 请求行与其它头原样保留
        assert!(out.starts_with("GET /api/status HTTP/1.1\r\n"));
        assert!(out.contains("Host: 192.168.1.20:8443"));
        assert!(out.contains("Cookie: a=b"));

        // 大小写变体也删（HTTP 头名不区分大小写）
        let out2 = inject_edge_header("GET / HTTP/1.1\r\nX-Codem-Edge: FORGED2", "REAL");
        assert!(!out2.contains("FORGED2"));
        assert_eq!(out2.matches("x-codem-edge").count(), 1);

        // 客户端没发时就是纯追加
        let out3 = inject_edge_header("GET / HTTP/1.1\r\nHost: h", "REAL");
        assert_eq!(out3.matches("x-codem-edge").count(), 1);
        assert!(out3.ends_with("x-codem-edge: REAL"));

        // 追加后的头能被我们自己解析回来（闭环）
        let parsed = crate::phone::http::header_value(&format!("{}\r\n\r\n", out), EDGE_HEADER);
        assert_eq!(parsed.as_deref(), Some("REAL"));
    }
}
