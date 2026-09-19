//! 凭据封存（第 62 轮；方案见 `docs/CREDENTIALS-PLAN.md` 阶段 1）。
//!
//! ## 为什么用**裸 FFI** 调 DPAPI，而不是加一个加密依赖
//!
//! 方案里写的是"需要新增依赖（`windows`/`keyring`）"。真动手时改主意了，理由如下：
//!
//! 1. 我们只需要**两个** Win32 调用（`CryptProtectData` / `CryptUnprotectData`）与一个
//!    `LocalFree` —— 引入一个体量不小的依赖（`windows` 全家桶或 `keyring`）只为这三件事，
//!    会让构建产物、CI 与"最小可信面"都变差；
//! 2. 裸 FFI 的**信任面明确**：这三个函数是操作系统 API，签名来自 Win32 文档，没有中间层；
//! 3. 依赖越少，"换个平台/换台机器"时的失败模式越好解释（见下面的 `UNAVAILABLE` 语义）。
//!
//! ## 语义（与方案第 2 节逐条对应）
//!
//! - **不可用时不静默降级**：拿不到加密后端（非 Windows、或 API 调用失败）→ 返回**明确错误**
//!   `UNAVAILABLE`，调用方必须据此**保持明文并提示用户**，绝不"假装封存成功"；
//! - **密文与机器/账户绑定**：DPAPI 默认用**当前用户**的凭据保护 ⇒ 换机器/换账户**解不开**，
//!   这是**安全特性**（U 盘丢了也解不开），需要在便携文档里明说；
//! - **绝不因为解不开就丢数据**：`unseal` 失败只报错，调用方**保留密文**（方案第 4 节）。
//!
//! ## 格式
//!
//! 密文以 **hex** 传输（不引 base64 依赖）：`secret_seal` 返回 hex 字符串，`secret_unseal` 收 hex。
//! 前缀 `dsh1:` 标明算法与版本，便于将来换算法时区分（不认识的版本一律 `UNAVAILABLE`，不猜）。

use serde::Serialize;

/// 封存失败/不可用的统一前缀：调用方据此区分"环境不支持"与"数据坏了"
pub const UNAVAILABLE: &str = "UNAVAILABLE";
const FORMAT_PREFIX: &str = "dsh1:";

#[derive(Serialize)]
pub struct SealReply {
    pub sealed: String,
}

#[derive(Serialize)]
pub struct UnsealReply {
    pub plaintext: String,
}

#[cfg(windows)]
mod dpapi {
    

    /// Win32 `DATA_BLOB`（`crypt32` 的输入输出都是它）
    #[repr(C)]
    pub struct DataBlob {
        pub cb_data: u32,
        pub pb_data: *mut u8,
    }

    #[link(name = "crypt32")]
    extern "system" {
        pub fn CryptProtectData(
            p_data_in: *const DataBlob,
            sz_data_descr: *const u16,
            p_optional_entropy: *const DataBlob,
            pv_reserved: *mut core::ffi::c_void,
            p_prompt_struct: *mut core::ffi::c_void,
            dw_flags: u32,
            p_data_out: *mut DataBlob,
        ) -> i32;
        pub fn CryptUnprotectData(
            p_data_in: *const DataBlob,
            ppsz_data_descr: *mut *mut u16,
            p_optional_entropy: *const DataBlob,
            pv_reserved: *mut core::ffi::c_void,
            p_prompt_struct: *mut core::ffi::c_void,
            dw_flags: u32,
            p_data_out: *mut DataBlob,
        ) -> i32;
    }

    #[link(name = "kernel32")]
    extern "system" {
        pub fn LocalFree(h_mem: *mut core::ffi::c_void) -> *mut core::ffi::c_void;
    }
}

/// 这台机器/这个账户**能不能**封存（供界面提前提示，而不是等失败才发现）
pub fn backend_available() -> bool {
    #[cfg(windows)]
    {
        // 用一个 1 字节的探针真跑一次：`isEncryptionAvailable()` 式的"只问不做"在这里没有意义，
        // DPAPI 没有单独的探测 API，只能实打实地封一次再解一次。
        match seal_bytes(b"probe") {
            Ok(blob) => unseal_bytes(&blob).map(|v| v == b"probe").unwrap_or(false),
            Err(_) => false,
        }
    }
    #[cfg(not(windows))]
    {
        false
    }
}

#[cfg(windows)]
fn seal_bytes(plain: &[u8]) -> Result<Vec<u8>, String> {
    use dpapi::*;
    use std::ptr;
    unsafe {
        let mut input = DataBlob {
            cb_data: plain.len() as u32,
            pb_data: plain.as_ptr() as *mut u8,
        };
        let mut out = DataBlob {
            cb_data: 0,
            pb_data: ptr::null_mut(),
        };
        // 0 旗标 = 用**当前用户**的凭据保护（不弹 UI、不绑定机器）
        let ok = CryptProtectData(
            &mut input,
            ptr::null(),
            ptr::null(),
            ptr::null_mut(),
            ptr::null_mut(),
            0,
            &mut out,
        );
        if ok == 0 {
            return Err(format!("{UNAVAILABLE}: CryptProtectData 失败"));
        }
        let slice = std::slice::from_raw_parts(out.pb_data, out.cb_data as usize);
        let owned = slice.to_vec();
        LocalFree(out.pb_data as *mut core::ffi::c_void);
        Ok(owned)
    }
}

#[cfg(not(windows))]
fn seal_bytes(_plain: &[u8]) -> Result<Vec<u8>, String> {
    Err(format!(
        "{UNAVAILABLE}: 当前平台没有实现凭据封存（仅 Windows 走 DPAPI）"
    ))
}

#[cfg(windows)]
fn unseal_bytes(blob: &[u8]) -> Result<Vec<u8>, String> {
    use dpapi::*;
    use std::ptr;
    unsafe {
        let mut input = DataBlob {
            cb_data: blob.len() as u32,
            pb_data: blob.as_ptr() as *mut u8,
        };
        let mut out = DataBlob {
            cb_data: 0,
            pb_data: ptr::null_mut(),
        };
        let ok = CryptUnprotectData(
            &mut input,
            ptr::null_mut(),
            ptr::null(),
            ptr::null_mut(),
            ptr::null_mut(),
            0,
            &mut out,
        );
        if ok == 0 {
            // 注意文案：**不猜**是哪台机器/哪个账户的问题，只如实说"解不开"
            return Err(format!(
                "{UNAVAILABLE}: 解封失败（密文由另一台机器或另一个用户账户封存，或已损坏）"
            ));
        }
        let slice = std::slice::from_raw_parts(out.pb_data, out.cb_data as usize);
        let owned = slice.to_vec();
        LocalFree(out.pb_data as *mut core::ffi::c_void);
        Ok(owned)
    }
}

#[cfg(not(windows))]
fn unseal_bytes(_blob: &[u8]) -> Result<Vec<u8>, String> {
    Err(format!("{UNAVAILABLE}: 当前平台没有实现凭据解封"))
}

fn to_hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

fn from_hex(text: &str) -> Result<Vec<u8>, String> {
    if text.len() % 2 != 0 {
        return Err(format!("{UNAVAILABLE}: 密文长度非法"));
    }
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(text.len() / 2);
    for pair in bytes.chunks(2) {
        let hi = (pair[0] as char)
            .to_digit(16)
            .ok_or_else(|| format!("{UNAVAILABLE}: 密文含非 hex 字符"))?;
        let lo = (pair[1] as char)
            .to_digit(16)
            .ok_or_else(|| format!("{UNAVAILABLE}: 密文含非 hex 字符"))?;
        out.push(((hi << 4) | lo) as u8);
    }
    Ok(out)
}

/// 封存一个明文串，返回 `dsh1:<hex>`（**失败即明确不可用，不要降级**）
pub fn seal(plaintext: &str) -> Result<String, String> {
    if plaintext.is_empty() {
        return Err("参数非法：空串不需要封存".to_string());
    }
    let blob = seal_bytes(plaintext.as_bytes())?;
    Ok(format!("{FORMAT_PREFIX}{}", to_hex(&blob)))
}

/// 解封 `dsh1:<hex>`（**失败不吞**：调用方必须保留密文并如实上报）
pub fn unseal(sealed: &str) -> Result<String, String> {
    let hex = sealed
        .strip_prefix(FORMAT_PREFIX)
        .ok_or_else(|| format!("{UNAVAILABLE}: 不认识的密文格式（缺少 {FORMAT_PREFIX} 前缀）"))?;
    let blob = from_hex(hex)?;
    let plain = unseal_bytes(&blob)?;
    String::from_utf8(plain).map_err(|_| format!("{UNAVAILABLE}: 解封结果不是合法 UTF-8"))
}

// ========== Tauri 命令（与 storage_* 同层，只做"参数解码 → 调库 → 结果编码"）==========

#[tauri::command]
pub fn secret_backend_available() -> bool {
    backend_available()
}

#[tauri::command]
pub fn secret_seal(plaintext: String) -> Result<SealReply, String> {
    seal(&plaintext).map(|sealed| SealReply { sealed })
}

#[tauri::command]
pub fn secret_unseal(sealed: String) -> Result<UnsealReply, String> {
    unseal(&sealed).map(|plaintext| UnsealReply { plaintext })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_round_trip_is_exact() {
        for case in [vec![], vec![0u8], vec![0, 255, 16], vec![1, 2, 3, 4, 5]] {
            let hex = to_hex(&case);
            assert_eq!(from_hex(&hex).unwrap(), case, "hex 往返必须逐字节相等");
        }
    }

    #[test]
    fn bad_hex_is_reported_not_guessed() {
        assert!(from_hex("abc").is_err(), "奇数长度必须报错");
        assert!(from_hex("zz").is_err(), "非 hex 字符必须报错");
    }

    #[test]
    fn unknown_format_is_unavailable_not_silent() {
        let err = unseal("plaintext-here").unwrap_err();
        assert!(err.starts_with(UNAVAILABLE), "不认识的格式必须报 UNAVAILABLE：{err}");
    }

    #[test]
    fn empty_plaintext_is_rejected() {
        assert!(seal("").is_err(), "空串不该被封存（会把'没填'写成'已封存'）");
    }

    /// 真封存↔真解封（Windows 上跑；非 Windows 断言"明确不可用"而不是"假成功"）
    #[cfg(windows)]
    #[test]
    fn seal_unseal_round_trip_on_this_machine() {
        let secret = "sk-round-trip-test-0123456789";
        let sealed = seal(secret).expect("Windows 上 DPAPI 应当可用");
        assert!(sealed.starts_with(FORMAT_PREFIX));
        assert!(!sealed.contains(secret), "密文里不许出现明文");
        assert_eq!(unseal(&sealed).unwrap(), secret, "解封必须还原原串");
        // 两次封存同一明文应产生**不同**密文（DPAPI 带随机 salt）—— 这条能防止"把明文当密文存"
        let again = seal(secret).unwrap();
        assert_ne!(sealed, again, "两次封存结果相同 = 值得怀疑它根本没加密");
    }

    #[cfg(not(windows))]
    #[test]
    fn seal_reports_unavailable_on_other_platforms() {
        let err = seal("x").unwrap_err();
        assert!(err.starts_with(UNAVAILABLE), "非 Windows 必须明确不可用：{err}");
        assert!(!backend_available());
    }
}
