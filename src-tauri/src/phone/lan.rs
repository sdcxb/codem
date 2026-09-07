// ============================================================
// phone/lan.rs — LAN IP 探测（零依赖）
//
// 对标 EAC phone-bridge lanAddress()：优先 RFC1918 私网 IP。
// 简化实现：UDP connect 到 8.8.8.8（不发包，仅取默认路由出接口 IP），
// 失败回退 127.0.0.1。不枚举网卡，避免选中虚拟网卡/APIPA（与 EAC 同目标）。
// ============================================================

/// 默认路由出接口的 IPv4。
pub fn lan_ip() -> String {
    let socket = std::net::UdpSocket::bind("0.0.0.0:0");
    if let Ok(s) = socket {
        if s.connect("8.8.8.8:80").is_ok() {
            if let Ok(addr) = s.local_addr() {
                let ip = addr.ip();
                if !ip.is_loopback() && !ip.is_unspecified() {
                    return ip.to_string();
                }
            }
        }
    }
    "127.0.0.1".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lan_ip_returns_something() {
        let ip = lan_ip();
        assert!(!ip.is_empty());
        // 返回格式是 IPv4 或 v6 文本；不崩溃即可。
        assert!(ip.parse::<std::net::IpAddr>().is_ok());
    }
}
