// ============================================================
// phone/gateway/pairing.rs — 桌面网关的 6 位一次性配对 + 设备 cookie
//
// ## 为什么在 Rust 侧，而不是转发给渲染层
//
// 配对码是**自举凭据**：它必须在任何渲染层代码参与之前就被校验，否则
// 「未鉴权请求 → 事件桥 → TS」这条路上又多了一个能被本地进程触发的入口。
// 这里只做三件事：
//   1. 生成 6 位数字码（TTL 5 分钟、单活动码、单次使用、错误次数/窗口限速）；
//   2. 兑换成功后生成 32 字节随机设备 token，只把 **sha256** 留在内存；
//   3. 之后的请求用 HttpOnly cookie 回来，按 token hash 常数时间比较。
//
// ## 明确的最小化（M1）
//
// 设备表**只在内存**：桌面进程重启 = 所有设备 cookie 失效，需要重新配对。
// 这是刻意的最小安全版：不落 devices 文件、不碰桌面数据库，也就不存在
// "把桌面库当第二套凭据库"或"崩溃后旧 token 复活"的问题。旧 Host 的
// `packages/host/src/pairing.ts` 是持久化版；M1 先不做那条路径。
//
// 停止网关会清空配对状态（包括设备），所以「停止」也是撤销全部设备的入口。
// ============================================================

use sha2::{Digest, Sha256};

use crate::phone::random_hex;
#[cfg(test)]
use crate::phone::timing_safe_eq;

/// 配对码有效期：5 分钟（与旧 Host 的手机端倒计时一致）。
pub const PAIR_CODE_TTL_MS: i64 = 5 * 60 * 1000;
/// 单个码允许的错误次数。
pub const MAX_ATTEMPTS_PER_CODE: u32 = 10;
/// 限速窗口与窗口内允许的错误次数（跨码，防"猜完一个再换一个"）。
pub const RATE_WINDOW_MS: i64 = 60 * 1000;
pub const MAX_FAILURES_PER_WINDOW: usize = 5;
/// 设备上限（与旧 Host 的 8 台一致）。
pub const MAX_DEVICES: usize = 8;

/// cookie 名。cookie 不按端口隔离，所以同一台机器上的网关共用一行；
/// 停止/重启后服务端内存里没有对应的 hash，旧值只会得到 401。
pub const DEVICE_COOKIE_NAME: &str = "codem_gateway_device";
/// 设备 cookie 有效期：30 天。超过这个时间的设备需要重新配对（M1 没有续期接口）。
pub const DEVICE_COOKIE_MAX_AGE_SEC: u64 = 30 * 24 * 60 * 60;

const MAX_DEVICE_NAME: usize = 64;
const DEFAULT_DEVICE_NAME: &str = "我的手机";

#[derive(Debug, Clone)]
struct PendingCode {
    hash: [u8; 32],
    expires_at: i64,
    attempts: u32,
}

#[derive(Debug, Clone)]
struct DeviceRecord {
    id: String,
    name: String,
    platform: String,
    token_hash: [u8; 32],
    created_at: i64,
    last_seen_at: i64,
}

/// 可以安全回给客户端的设备视图（不含任何 token/hash）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceView {
    pub id: String,
    pub name: String,
    pub platform: String,
    pub created_at: i64,
    pub last_seen_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PairCode {
    pub code: String,
    pub expires_at: i64,
    pub ttl_ms: i64,
}

#[derive(Debug, Clone)]
pub struct PairClaim {
    /// 明文 token 只在兑换成功时出现一次；生产路径只允许写进 `Set-Cookie`。
    pub token: String,
    pub device: DeviceView,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PairError {
    Invalid,
    Expired,
    Locked,
    RateLimited { retry_after_ms: i64 },
    DeviceLimit,
}

impl PairError {
    pub fn reason(&self) -> &'static str {
        match self {
            PairError::Invalid => "invalid",
            PairError::Expired => "expired",
            PairError::Locked => "locked",
            PairError::RateLimited { .. } => "rate_limited",
            PairError::DeviceLimit => "device_limit",
        }
    }
}

/// 纯内存配对状态。用 `now_ms` 参数注入时间，判据可以直接跨过 TTL/限速窗口。
#[derive(Default)]
pub struct PairingState {
    code: Option<PendingCode>,
    devices: Vec<DeviceRecord>,
    failures: Vec<i64>,
}

impl PairingState {
    pub fn new() -> Self {
        Self::default()
    }

    /// 生成新码：旧码立即失效；重置错误计数与限速窗口。
    ///
    /// 返回的明文码只用于桌面设置页显示；状态里只存 hash。
    pub fn new_code(&mut self, now_ms: i64) -> PairCode {
        let code = format!("{:06}", rand::random::<u32>() % 1_000_000);
        let expires_at = now_ms + PAIR_CODE_TTL_MS;
        self.code = Some(PendingCode {
            hash: sha256(code.as_bytes()),
            expires_at,
            attempts: 0,
        });
        self.failures.clear();
        PairCode {
            code,
            expires_at,
            ttl_ms: PAIR_CODE_TTL_MS,
        }
    }

    /// 兑换配对码。顺序是安全相关的：
    /// 限速 → 码存在/格式 → 过期/锁定 → 码匹配 → 设备上限 → 生成 token。
    pub fn claim(
        &mut self,
        raw_code: &str,
        device_name: Option<&str>,
        platform: Option<&str>,
        now_ms: i64,
    ) -> Result<PairClaim, PairError> {
        self.prune_failures(now_ms);
        if self.failures.len() >= MAX_FAILURES_PER_WINDOW {
            return Err(self.rate_limited(now_ms));
        }

        let normalized = normalize_code(raw_code).ok_or(PairError::Invalid)?;
        let pending = self.code.as_mut().ok_or(PairError::Invalid)?;

        if now_ms >= pending.expires_at {
            self.code = None;
            self.record_failure(now_ms);
            return Err(PairError::Expired);
        }
        if pending.attempts >= MAX_ATTEMPTS_PER_CODE {
            self.record_failure(now_ms);
            return Err(PairError::Locked);
        }
        if !constant_time_eq(&sha256(normalized.as_bytes()), &pending.hash) {
            pending.attempts += 1;
            let locked = pending.attempts >= MAX_ATTEMPTS_PER_CODE;
            self.record_failure(now_ms);
            return Err(if locked {
                PairError::Locked
            } else {
                PairError::Invalid
            });
        }

        if self.devices.len() >= MAX_DEVICES {
            return Err(PairError::DeviceLimit);
        }

        let token = random_hex(32);
        let device = DeviceRecord {
            id: format!("dev-{}", random_hex(4)),
            name: sanitize_device_name(device_name),
            platform: sanitize_platform(platform),
            token_hash: sha256(token.as_bytes()),
            created_at: now_ms,
            last_seen_at: now_ms,
        };
        let view = view_of(&device);
        self.devices.push(device);
        // 单次使用：兑换成功后码立即作废。
        self.code = None;
        self.failures.clear();
        Ok(PairClaim { token, device: view })
    }

    /// 校验设备 token；命中会更新 lastSeenAt。
    ///
    /// 遍历全部设备、不提前退出：比较次数不随"命中了第几条"变化。
    pub fn authenticate(&mut self, token: &str, now_ms: i64) -> Option<DeviceView> {
        if token.is_empty() || token.len() > 256 {
            return None;
        }
        let presented = sha256(token.as_bytes());
        let mut matched: Option<usize> = None;
        for (i, device) in self.devices.iter().enumerate() {
            if constant_time_eq(&presented, &device.token_hash) {
                matched = Some(i);
            }
        }
        let index = matched?;
        self.devices[index].last_seen_at = now_ms;
        Some(view_of(&self.devices[index]))
    }

    pub fn device_count(&self) -> usize {
        self.devices.len()
    }

    /// 停止网关：清空码与所有设备（旧 cookie 全部失效）。
    pub fn reset(&mut self) {
        self.code = None;
        self.devices.clear();
        self.failures.clear();
    }

    fn prune_failures(&mut self, now_ms: i64) {
        self.failures.retain(|at| now_ms - *at < RATE_WINDOW_MS);
    }

    fn record_failure(&mut self, now_ms: i64) {
        self.failures.push(now_ms);
        self.prune_failures(now_ms);
    }

    fn rate_limited(&self, now_ms: i64) -> PairError {
        let oldest = self.failures.first().copied().unwrap_or(now_ms);
        PairError::RateLimited {
            retry_after_ms: (oldest + RATE_WINDOW_MS - now_ms).max(0),
        }
    }
}

/// 归一化配对码：去掉空格/连字符，只接受 6 位 ASCII 数字。
pub fn normalize_code(raw: &str) -> Option<String> {
    let compact: String = raw
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '-')
        .collect();
    if compact.len() == 6 && compact.bytes().all(|b| b.is_ascii_digit()) {
        Some(compact)
    } else {
        None
    }
}

pub fn sanitize_device_name(raw: Option<&str>) -> String {
    let cleaned = raw
        .unwrap_or("")
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let clipped: String = cleaned.chars().take(MAX_DEVICE_NAME).collect();
    if clipped.is_empty() {
        DEFAULT_DEVICE_NAME.to_string()
    } else {
        clipped
    }
}

fn sanitize_platform(raw: Option<&str>) -> String {
    match raw.unwrap_or("") {
        "android" | "ios" | "web" | "desktop" => raw.unwrap_or("unknown").to_string(),
        _ => "unknown".to_string(),
    }
}

fn view_of(device: &DeviceRecord) -> DeviceView {
    DeviceView {
        id: device.id.clone(),
        name: device.name.clone(),
        platform: device.platform.clone(),
        created_at: device.created_at,
        last_seen_at: device.last_seen_at,
    }
}

fn sha256(bytes: &[u8]) -> [u8; 32] {
    let digest = Sha256::digest(bytes);
    let mut out = [0u8; 32];
    out.copy_from_slice(&digest);
    out
}

fn constant_time_eq(a: &[u8; 32], b: &[u8; 32]) -> bool {
    // 复用现有 bridge 的常数时间字符串比较；这里先把字节转成 hex 会多一次分配，
    // 但 32 字节的比较本身不敏感，直接用 xor 更直观。
    let mut diff = 0u8;
    for i in 0..32 {
        diff |= a[i] ^ b[i];
    }
    diff == 0
}

/// 设备 token 的常数时间比较辅助（给判据用；生产鉴权走 `authenticate`）。
#[cfg(test)]
pub fn token_equals(a: &str, b: &str) -> bool {
    timing_safe_eq(a, b)
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_700_000_000_000;

    #[test]
    fn code_is_six_digits_and_only_one_is_live() {
        let mut st = PairingState::new();
        let first = st.new_code(NOW);
        assert!(first.code.len() == 6 && first.code.bytes().all(|b| b.is_ascii_digit()));
        assert_eq!(first.expires_at, NOW + PAIR_CODE_TTL_MS);

        let second = st.new_code(NOW + 1);
        assert_ne!(first.code, second.code);
        assert!(
            st.claim(&first.code, None, None, NOW + 2).is_err(),
            "生成新码后旧码必须失效"
        );
        assert!(st.claim(&second.code, None, None, NOW + 2).is_ok());
    }

    #[test]
    fn claim_is_single_use_and_returns_only_a_token_hash_on_subsequent_auth() {
        let mut st = PairingState::new();
        let code = st.new_code(NOW);
        let claimed = st.claim(&code.code, Some("Pixel"), Some("android"), NOW).unwrap();
        assert_eq!(claimed.device.name, "Pixel");
        assert_eq!(claimed.device.platform, "android");
        assert_eq!(claimed.token.len(), 64, "32 字节随机数的 hex");
        assert_eq!(st.device_count(), 1);

        // token 只以 hash 形式留在状态里；设备视图不含 token
        assert!(st.authenticate(&claimed.token, NOW + 1).is_some());
        assert!(st.authenticate("deadbeef", NOW + 1).is_none());
        // 码已经消费
        assert!(matches!(
            st.claim(&code.code, None, None, NOW + 1),
            Err(PairError::Invalid)
        ));
    }

    #[test]
    fn expiry_attempts_and_rate_limit_fail_closed() {
        let mut st = PairingState::new();
        let code = st.new_code(NOW);
        assert_eq!(
            st.claim(&code.code, None, None, NOW + PAIR_CODE_TTL_MS).unwrap_err(),
            PairError::Expired
        );

        // 新码的错误尝试不能越过窗口限速（5 次/分钟）
        let code = st.new_code(NOW + PAIR_CODE_TTL_MS + 1);
        for _ in 0..MAX_FAILURES_PER_WINDOW {
            let _ = st.claim("000000", None, None, NOW + PAIR_CODE_TTL_MS + 2);
        }
        assert!(matches!(
            st.claim(&code.code, None, None, NOW + PAIR_CODE_TTL_MS + 3),
            Err(PairError::RateLimited { .. })
        ));
        // 窗口过去后正确码可用
        let later = NOW + PAIR_CODE_TTL_MS + 1 + RATE_WINDOW_MS + 1;
        assert!(st.claim(&code.code, None, None, later).is_ok());
    }

    #[test]
    fn device_limit_and_cookie_name_are_explicit() {
        let mut st = PairingState::new();
        for i in 0..MAX_DEVICES {
            let code = st.new_code(NOW + i as i64);
            st.claim(&code.code, Some("phone"), None, NOW + i as i64).unwrap();
        }
        let code = st.new_code(NOW + 100);
        assert!(matches!(
            st.claim(&code.code, None, None, NOW + 101),
            Err(PairError::DeviceLimit)
        ));
        st.reset();
        assert_eq!(st.device_count(), 0);
        assert_eq!(DEVICE_COOKIE_NAME, "codem_gateway_device");
        assert!(DEVICE_COOKIE_MAX_AGE_SEC > 0);
    }

    #[test]
    fn normalization_and_name_sanitization() {
        assert_eq!(normalize_code(" 123 456 ").as_deref(), Some("123456"));
        assert_eq!(normalize_code("123-456").as_deref(), Some("123456"));
        assert_eq!(normalize_code("12345"), None);
        assert_eq!(normalize_code("12345a"), None);
        assert_eq!(sanitize_device_name(Some(" \u{0000} Pixel\n9 ")), "Pixel 9");
        assert_eq!(sanitize_device_name(Some("   ")), DEFAULT_DEVICE_NAME);
        assert!(token_equals("abc", "abc"));
        assert!(!token_equals("abc", "abd"));
    }
}
