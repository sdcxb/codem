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

/// 设备表持久化文件格式版本（不认识就整体忽略，要求重新配对）。
pub const PERSIST_VERSION: u32 = 1;

/// 持久化的单台设备：**只有 token 的 sha256**，没有明文凭据。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PersistedDevice {
    pub id: String,
    pub name: String,
    pub platform: String,
    /// 64 位小写十六进制（sha256）
    pub token_hash_hex: String,
    pub created_at: i64,
    pub last_seen_at: i64,
    /// Tailscale Serve 身份（邮箱）。缺省 = 旧文件/非零配对码设备。
    #[serde(default)]
    pub tailscale_login: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PersistedPairing {
    pub version: u32,
    pub devices: Vec<PersistedDevice>,
    /// 已被用户撤销的 Tailscale 登录；撤销后不再自动发设备 cookie。
    #[serde(default)]
    pub revoked_tailscale_logins: Vec<String>,
}

impl Default for PersistedPairing {
    fn default() -> Self {
        Self {
            version: PERSIST_VERSION,
            devices: Vec::new(),
            revoked_tailscale_logins: Vec::new(),
        }
    }
}

fn hex_lower(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}

fn parse_hex_32(raw: &str) -> Option<[u8; 32]> {
    let bytes = raw.as_bytes();
    if bytes.len() != 64 {
        return None;
    }
    let mut out = [0u8; 32];
    for i in 0..32 {
        let hi = (bytes[i * 2] as char).to_digit(16)?;
        let lo = (bytes[i * 2 + 1] as char).to_digit(16)?;
        out[i] = ((hi << 4) | lo) as u8;
    }
    Some(out)
}

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
    tailscale_login: Option<String>,
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
    RateLimited {
        retry_after_ms: i64,
    },
    DeviceLimit,
    /// 该 Tailscale 登录已被用户撤销；必须重新用配对码认领。
    Revoked,
}

impl PairError {
    pub fn reason(&self) -> &'static str {
        match self {
            PairError::Invalid => "invalid",
            PairError::Expired => "expired",
            PairError::Locked => "locked",
            PairError::RateLimited { .. } => "rate_limited",
            PairError::DeviceLimit => "device_limit",
            PairError::Revoked => "tailscale_revoked",
        }
    }
}

/// 纯内存配对状态。用 `now_ms` 参数注入时间，判据可以直接跨过 TTL/限速窗口。
#[derive(Default)]
pub struct PairingState {
    code: Option<PendingCode>,
    devices: Vec<DeviceRecord>,
    failures: Vec<i64>,
    /// 被撤销的 Tailscale 登录：不再自动签发 cookie；用户可重新用配对码认领。
    revoked_tailscale_logins: Vec<String>,
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
            tailscale_login: None,
        };
        let view = view_of(&device);
        self.devices.push(device);
        // 单次使用：兑换成功后码立即作废。
        self.code = None;
        self.failures.clear();
        Ok(PairClaim {
            token,
            device: view,
        })
    }

    /// Tailscale Serve 的零配对码路径：按登录身份签发/轮换设备 token。
    ///
    /// 安全边界由调用方保证：请求必须来自 loopback、Host 是 `*.ts.net`、且不是
    /// Funnel（Funnel 不注入身份头，`Tailscale-Funnel-Request` 会被设置）。
    /// 这里只负责“登录 → 设备”；不对 HTTP 头做信任判断。
    ///
    /// 同一登录 + 同一设备名只保留一台设备（同名重装会轮换 token，旧 cookie 立即失效）；
    /// 不同设备名（手机/浏览器）可以并存，互不踢下线。
    /// 用户撤销后进入 deny-list，必须重新用配对码认领。
    pub fn claim_tailscale(
        &mut self,
        raw_login: &str,
        device_name: Option<&str>,
        platform: Option<&str>,
        now_ms: i64,
    ) -> Result<PairClaim, PairError> {
        let login = normalize_tailscale_login(raw_login).ok_or(PairError::Invalid)?;
        if self.revoked_tailscale_logins.iter().any(|v| v == &login) {
            return Err(PairError::Revoked);
        }
        let platform = sanitize_platform(platform);
        let name = match device_name.map(str::trim).filter(|s| !s.is_empty()) {
            Some(value) => sanitize_device_name(Some(value)),
            None => sanitize_device_name(Some(&format!("Tailscale · {login}"))),
        };

        let token = random_hex(32);
        if let Some(index) = self
            .devices
            .iter()
            .position(|d| d.tailscale_login.as_deref() == Some(login.as_str()) && d.name == name)
        {
            let device = &mut self.devices[index];
            device.token_hash = sha256(token.as_bytes());
            device.platform = platform;
            device.last_seen_at = now_ms;
            return Ok(PairClaim {
                token,
                device: view_of(device),
            });
        }

        if self.devices.len() >= MAX_DEVICES {
            return Err(PairError::DeviceLimit);
        }
        let device = DeviceRecord {
            id: format!("ts-{}", random_hex(4)),
            name,
            platform,
            token_hash: sha256(token.as_bytes()),
            created_at: now_ms,
            last_seen_at: now_ms,
            tailscale_login: Some(login),
        };
        let view = view_of(&device);
        self.devices.push(device);
        Ok(PairClaim {
            token,
            device: view,
        })
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

    /// 设备列表（**不含 token/hash**）。桌面设置页用它显示"已配对设备"。
    pub fn devices(&self) -> Vec<DeviceView> {
        self.devices.iter().map(view_of).collect()
    }

    /// 撤销单台设备。未知 id 返回 `false`（幂等，不泄露"有没有这个 id"之外的任何东西）。
    ///
    /// Tailscale 设备同时把登录写入 deny-list：否则下一次自动登录会立刻重新建一台，
    /// 撤销按钮就变成了摆设。
    pub fn revoke(&mut self, device_id: &str) -> bool {
        let revoked_login = self
            .devices
            .iter()
            .find(|d| d.id == device_id)
            .and_then(|d| d.tailscale_login.clone());
        let before = self.devices.len();
        self.devices.retain(|d| d.id != device_id);
        let removed = self.devices.len() != before;
        if removed {
            if let Some(login) = revoked_login {
                if !self.revoked_tailscale_logins.iter().any(|v| v == &login) {
                    self.revoked_tailscale_logins.push(login);
                }
            }
        }
        removed
    }

    /// 导出可持久化的设备表（**只含 sha256 十六进制**，不落明文 token）。
    pub fn export(&self) -> PersistedPairing {
        PersistedPairing {
            version: PERSIST_VERSION,
            devices: self
                .devices
                .iter()
                .map(|d| PersistedDevice {
                    id: d.id.clone(),
                    name: d.name.clone(),
                    platform: d.platform.clone(),
                    token_hash_hex: hex_lower(&d.token_hash),
                    created_at: d.created_at,
                    last_seen_at: d.last_seen_at,
                    tailscale_login: d.tailscale_login.clone(),
                })
                .collect(),
            revoked_tailscale_logins: self.revoked_tailscale_logins.clone(),
        }
    }

    /// 从持久化设备表恢复（用于"重启桌面后手机直接进入"）。
    ///
    /// 失败策略是**逐条跳过**而不是整体失败：一个坏条目不该让 8 台设备全部掉线；
    /// 版本不认识则整体忽略（宁可要求重新配对，也不猜格式）。
    /// 返回恢复的条数。
    pub fn import(&mut self, persisted: PersistedPairing) -> usize {
        if persisted.version != PERSIST_VERSION {
            return 0;
        }
        self.devices.clear();
        self.revoked_tailscale_logins = persisted
            .revoked_tailscale_logins
            .into_iter()
            .filter_map(|login| normalize_tailscale_login(&login))
            .collect();
        for item in persisted.devices {
            if self.devices.len() >= MAX_DEVICES {
                break;
            }
            let Some(hash) = parse_hex_32(&item.token_hash_hex) else {
                continue;
            };
            if item.id.is_empty() || self.devices.iter().any(|d| d.id == item.id) {
                continue;
            }
            self.devices.push(DeviceRecord {
                id: item.id,
                name: sanitize_device_name(Some(&item.name)),
                platform: sanitize_platform(Some(&item.platform)),
                token_hash: hash,
                created_at: item.created_at,
                last_seen_at: item.last_seen_at,
                tailscale_login: item
                    .tailscale_login
                    .as_deref()
                    .and_then(normalize_tailscale_login),
            });
        }
        self.device_count()
    }

    /// 停止网关：清空码与所有设备（旧 cookie 全部失效）。
    /// `revoked` 也清空：停止是"关闭远程"，重新启动应重新允许零配对码；
    /// 单台撤销（不停网关）仍会留在 deny-list 里。
    pub fn reset(&mut self) {
        self.code = None;
        self.devices.clear();
        self.failures.clear();
        self.revoked_tailscale_logins.clear();
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

/// 归一化 Tailscale 登录：去空白、转小写；只接受 ASCII 邮箱形态。
///
/// Tailscale 对非 ASCII 值会做 RFC 2047 编码；这种值在这里直接拒绝（走配对码），
/// 不去猜编码，避免把畸形字符串当成身份。
pub fn normalize_tailscale_login(raw: &str) -> Option<String> {
    let login = raw.trim().to_ascii_lowercase();
    if login.is_empty() || login.len() > 254 {
        return None;
    }
    if login.starts_with("=?") {
        return None;
    }
    if !login.is_ascii() || login.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return None;
    }
    let (local, domain) = login.split_once('@')?;
    if local.is_empty() || domain.is_empty() || domain.contains('@') {
        return None;
    }
    Some(login)
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
        let claimed = st
            .claim(&code.code, Some("Pixel"), Some("android"), NOW)
            .unwrap();
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
            st.claim(&code.code, None, None, NOW + PAIR_CODE_TTL_MS)
                .unwrap_err(),
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
            st.claim(&code.code, Some("phone"), None, NOW + i as i64)
                .unwrap();
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

    /// B2：设备表可持久化，且**明文 token 不落盘**。
    #[test]
    fn devices_export_import_round_trip_without_plaintext() {
        let mut st = PairingState::new();
        let code = st.new_code(NOW);
        let claimed = st
            .claim(&code.code, Some("Pixel 9"), Some("android"), NOW + 1)
            .unwrap();
        let token = claimed.token.clone();
        assert_eq!(claimed.device.name, "Pixel 9");

        let persisted = st.export();
        let json = serde_json::to_string(&persisted).expect("serialize");
        assert!(!json.contains(&token), "明文 token 不得出现在持久化内容里");
        assert!(json.contains("token_hash_hex"));
        assert_eq!(persisted.devices.len(), 1);
        assert_eq!(persisted.devices[0].platform, "android");

        // 重启：新状态从磁盘内容恢复 → 旧 cookie 仍然有效（不用重新配对）
        let mut restarted = PairingState::new();
        assert_eq!(restarted.import(serde_json::from_str(&json).unwrap()), 1);
        assert_eq!(restarted.device_count(), 1);
        let seen = restarted
            .authenticate(&token, NOW + 10)
            .expect("重启后 token 仍有效");
        assert_eq!(seen.id, claimed.device.id);
        assert_eq!(seen.last_seen_at, NOW + 10);

        // 单设备撤销：只掉这一台
        assert!(restarted.revoke(&claimed.device.id));
        assert!(
            !restarted.revoke(&claimed.device.id),
            "未知 id 幂等返回 false"
        );
        assert!(restarted.authenticate(&token, NOW + 20).is_none());
        assert_eq!(restarted.device_count(), 0);
    }

    #[test]
    fn tailscale_claim_reuses_one_device_and_rotates_token() {
        let mut st = PairingState::new();
        let first = st
            .claim_tailscale("User@Example.com", Some("Pixel"), Some("android"), NOW)
            .expect("zero-code claim");
        assert!(first.device.id.starts_with("ts-"));
        assert_eq!(st.device_count(), 1);
        assert!(st.authenticate(&first.token, NOW + 1).is_some());

        let second = st
            .claim_tailscale("user@example.com", Some("Pixel"), Some("android"), NOW + 2)
            .expect("same login + device name must reuse");
        assert_eq!(st.device_count(), 1, "同一登录 + 同一设备名只保留一台设备");
        assert!(
            st.authenticate(&first.token, NOW + 3).is_none(),
            "轮换 token 后旧 cookie 必须失效"
        );
        assert!(st.authenticate(&second.token, NOW + 3).is_some());
    }

    #[test]
    fn tailscale_devices_with_different_names_coexist() {
        let mut st = PairingState::new();
        let phone = st
            .claim_tailscale(
                "user@example.com",
                Some("Codem Android"),
                Some("android"),
                NOW,
            )
            .unwrap();
        let browser = st
            .claim_tailscale("user@example.com", Some("Codem Web"), Some("web"), NOW + 1)
            .unwrap();
        assert_eq!(st.device_count(), 2, "手机与浏览器应各自保留设备");
        assert!(st.authenticate(&phone.token, NOW + 2).is_some());
        assert!(st.authenticate(&browser.token, NOW + 2).is_some());
    }

    #[test]
    fn revoked_tailscale_login_cannot_silently_reconnect() {
        let mut st = PairingState::new();
        let claimed = st
            .claim_tailscale("user@example.com", None, Some("web"), NOW)
            .unwrap();
        assert!(st.revoke(&claimed.device.id));
        assert_eq!(st.device_count(), 0);
        assert_eq!(
            st.claim_tailscale("user@example.com", None, Some("web"), NOW + 1)
                .unwrap_err(),
            PairError::Revoked
        );

        // deny-list 必须跟着设备表一起持久化：重启桌面后不能又把撤销的身份放回来。
        let persisted = st.export();
        assert_eq!(persisted.revoked_tailscale_logins, vec!["user@example.com"]);
        let mut restarted = PairingState::new();
        restarted.import(persisted);
        assert_eq!(
            restarted
                .claim_tailscale("user@example.com", None, Some("web"), NOW + 2)
                .unwrap_err(),
            PairError::Revoked
        );
    }

    #[test]
    fn tailscale_login_normalization_rejects_encoded_or_malformed_values() {
        assert_eq!(
            normalize_tailscale_login(" User@Example.com ").as_deref(),
            Some("user@example.com")
        );
        assert!(normalize_tailscale_login("no-at-sign").is_none());
        assert!(normalize_tailscale_login("=?utf-8?q?user?=").is_none());
        assert!(normalize_tailscale_login("user name@example.com").is_none());
        assert!(normalize_tailscale_login("user@example.com\n").is_some());
    }

    /// 坏条目逐条跳过；不认识的版本整体忽略（不猜格式）。
    #[test]
    fn import_skips_malformed_and_unknown_versions() {
        let mut good = PersistedPairing::default();
        good.devices.push(PersistedDevice {
            id: "dev-bad".into(),
            name: "x".into(),
            platform: "web".into(),
            token_hash_hex: "zz".into(), // 长度/字符都不合法
            created_at: 1,
            last_seen_at: 1,
            tailscale_login: None,
        });
        good.devices.push(PersistedDevice {
            id: "dev-ok".into(),
            name: "Pixel".into(),
            platform: "android".into(),
            token_hash_hex: hex_lower(&sha256(b"token-ok")),
            created_at: 1,
            last_seen_at: 2,
            tailscale_login: None,
        });
        let mut st = PairingState::new();
        assert_eq!(st.import(good), 1);
        assert_eq!(st.devices().len(), 1);
        assert_eq!(st.devices()[0].id, "dev-ok");

        let mut unknown = PersistedPairing::default();
        unknown.version = 99;
        unknown.devices.push(PersistedDevice {
            id: "dev-x".into(),
            name: "x".into(),
            platform: "web".into(),
            token_hash_hex: hex_lower(&sha256(b"t")),
            created_at: 1,
            last_seen_at: 1,
            tailscale_login: None,
        });
        let mut st2 = PairingState::new();
        assert_eq!(st2.import(unknown), 0, "未知版本必须整体忽略");
    }
}
