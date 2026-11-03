// ============================================================
// phone/guard.rs — 回环 bridge 的准入判定
//
// 旧 LAN 边缘（Host 白名单 / 拒跨站 / 0.0.0.0 TLS）已删除。现在只有一条
// 只绑 127.0.0.1 的 bridge：AA connector 用本次运行随机生成的 token
// 请求引擎，别的本机进程即使知道端口也拿不到 token。
//
// 这里只放**纯函数**，便于单测直接钉住。
// ============================================================

use super::timing_safe_eq;

/// bridge 注入的标记头名（小写，与 http.rs 的头表一致）。
pub const BRIDGE_HEADER: &str = "x-codem-bridge";

/// 只有带**本次运行** bridge token 的请求才放行。
pub fn bridge_allowed(provided: Option<&str>, expected: &str) -> bool {
    if expected.is_empty() {
        return false;
    }
    match provided {
        Some(v) => timing_safe_eq(v.trim(), expected),
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bridge_requires_exact_run_token() {
        assert!(bridge_allowed(Some("tok123"), "tok123"));
        assert!(!bridge_allowed(Some("tok124"), "tok123"));
        assert!(!bridge_allowed(Some(""), "tok123"));
        assert!(!bridge_allowed(None, "tok123"));
        // 没有 token 的运行绝不放行（不能把"未启用"当成"不检查"）
        assert!(!bridge_allowed(Some("anything"), ""));
    }
}
