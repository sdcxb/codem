//! Runtime log file — 对标 dsh-desktop `log-files.ts` LogFileSink。
//!
//! Codem 打包版没有控制台；此前除 panic 时的 codem-crash.log 外，常规运行
//! 事件（启动/崩溃检测结果/命令执行/超时杀树/PTY/退出）完全无文件记录，
//! 用户与开发者遇到问题无从诊断。此模块提供与 dsh 同构的持久化日志：
//!
//!   - 按日文件：`codem-runtime-YYYY-MM-DD.log`（UTC 日）
//!   - 大小轮转：单文件超限后升段 `codem-runtime-YYYY-MM-DD.N.log`
//!   - 目录上限：总大小超限时按修改时间删除最旧文件
//!   - 保留天数：启动时清理超过 14 天的日志
//!   - 脱敏：写入前经 `mask_secrets`（对标 dsh mask-secrets），命令/错误
//!     中的 API key、token、密码不落盘
//!   - 行截断：单行不超过 8KB，避免异常日志写爆磁盘
//!
//! 所有写日志路径都是 best-effort：失败静默忽略，绝不影响主流程。

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const LOG_PREFIX: &str = "codem-runtime";
/// 单文件上限（字节）。
const MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;
/// 段数上限：0..=MAX_SEGMENTS（超出后覆盖最旧段）。
const MAX_SEGMENTS: u32 = 3;
/// 目录内本应用日志总上限（字节），超出删最旧。
const MAX_DIR_BYTES: u64 = 24 * 1024 * 1024;
/// 保留天数。
const RETENTION_DAYS: u64 = 14;
/// 单行上限。
const MAX_LINE_BYTES: usize = 8 * 1024;

/// 日志所在目录（与 active-run.json / codem-crash.log 同目录）。
/// app_data_dir 在 panic hook 阶段不可用，统一从环境变量解析
/// （Windows %APPDATA%\com.codem.app；非 Windows $HOME/com.codem.app）。
pub fn default_base_dir() -> PathBuf {
    #[cfg(target_os = "windows")]
    let base = std::env::var("APPDATA").unwrap_or_else(|_| ".".to_string());
    #[cfg(not(target_os = "windows"))]
    let base = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    Path::new(&base).join("com.codem.app")
}

/// 追加一行运行时日志（脱敏 + 截断 + 轮转 + 目录上限）。
pub fn append_line(level: &str, message: &str) {
    append_line_to(&default_base_dir(), level, message);
}

/// 追加到指定目录（测试可注入临时目录）。写入前统一脱敏。
pub fn append_line_to(base_dir: &Path, level: &str, message: &str) {
    if base_dir.as_os_str().is_empty() {
        return;
    }
    if let Err(_) = fs::create_dir_all(base_dir) {
        return;
    }
    let masked = mask_secrets(message);
    let (y, mo, d, h, mi, s, ms) = utc_now();
    let mut line = format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z [{}] {}\n",
        y, mo, d, h, mi, s, ms, level, masked
    );
    // 单行截断（含时间戳与换行后的总长受控）。
    line = truncate_utf8(&line, MAX_LINE_BYTES);

    let mut segment: u32 = 0;
    let mut path = segment_path(base_dir, segment);
    loop {
        let size = fs::metadata(&path).map(|m| m.len()).ok();
        match size {
            None => break, // 文件不存在：直接创建写入
            Some(size) if size + line.len() as u64 <= MAX_FILE_BYTES => break,
            Some(_) if segment < MAX_SEGMENTS => {
                segment += 1;
                path = segment_path(base_dir, segment);
            }
            Some(_) => {
                // 最末段也满了：删除重建（等价丢弃最旧段）。
                let _ = fs::remove_file(&path);
                break;
            }
        }
    }

    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&path) {
        let _ = f.write_all(line.as_bytes());
    }
    enforce_dir_cap(base_dir);
}

/// 清理超过保留天数的日志（启动时调用一次）。
pub fn purge_old_logs() {
    purge_old_logs_in(&default_base_dir());
}

/// 清理指定目录中超过保留天数的日志。
pub fn purge_old_logs_in(base_dir: &Path) {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    for entry in owned_logs(base_dir) {
        if let Ok(meta) = fs::metadata(&entry) {
            if let Ok(modified) = meta.modified() {
                if let Ok(age) = modified.duration_since(UNIX_EPOCH) {
                    if is_stale(age.as_secs(), now, RETENTION_DAYS) {
                        let _ = fs::remove_file(&entry);
                    }
                }
            }
        }
    }
}

/// 判断文件 mtime（epoch 秒）是否已超过保留天数（纯函数，便于测试）。
pub fn is_stale(modified_epoch_secs: u64, now_epoch_secs: u64, retention_days: u64) -> bool {
    now_epoch_secs.saturating_sub(modified_epoch_secs) > retention_days.saturating_mul(86_400)
}

/// 目录总大小超出上限时按修改时间删除最旧文件（保留至少一个）。
fn enforce_dir_cap(base_dir: &Path) {
    let mut entries: Vec<(PathBuf, u64, u64)> = Vec::new(); // (path, bytes, mtime_ms)
    for path in owned_logs(base_dir) {
        if let Ok(meta) = fs::metadata(&path) {
            let mtime = meta
                .modified()
                .ok()
                .and_then(|m| m.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            entries.push((path, meta.len(), mtime));
        }
    }
    let mut total: u64 = entries.iter().map(|e| e.1).sum();
    entries.sort_by_key(|e| (e.2, e.0.clone()));
    while total > MAX_DIR_BYTES && entries.len() > 1 {
        let oldest = entries.remove(0);
        if fs::remove_file(&oldest.0).is_ok() {
            total = total.saturating_sub(oldest.1);
        }
    }
}

/// 枚举本应用拥有的日志文件。
fn owned_logs(base_dir: &Path) -> Vec<PathBuf> {
    let Ok(rd) = fs::read_dir(base_dir) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in rd.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if is_owned_log_name(&name) {
            out.push(entry.path());
        }
    }
    out
}

/// 判断文件名是否属于 `codem-runtime-YYYY-MM-DD(.N)?.log`。
fn is_owned_log_name(name: &str) -> bool {
    let Some(core) = name
        .strip_prefix(LOG_PREFIX)
        .and_then(|r| r.strip_prefix('-'))
        .and_then(|r| r.strip_suffix(".log"))
    else {
        return false;
    };
    let (date, segment) = match core.find('.') {
        None => (core, None),
        Some(idx) => (core[..idx].into(), Some(&core[idx + 1..])),
    };
    if !is_date_suffix(date) {
        return false;
    }
    match segment {
        None => true,
        Some(seg) => !seg.is_empty() && seg.chars().all(|c| c.is_ascii_digit()),
    }
}

/// 校验 `YYYY-MM-DD`（10 字符、'-' 位置正确、其余数字）。
fn is_date_suffix(date: &str) -> bool {
    let chars: Vec<char> = date.chars().collect();
    if chars.len() != 10 {
        return false;
    }
    chars[4] == '-' && chars[7] == '-' && chars.iter().enumerate().all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit())
}

/// 今天指定段号的文件路径（segment 0 = 无后缀）。
fn segment_path(base_dir: &Path, segment: u32) -> PathBuf {
    let (y, mo, d, _, _, _, _) = utc_now();
    let date = format!("{:04}-{:02}-{:02}", y, mo, d);
    if segment == 0 {
        base_dir.join(format!("{}-{}.log", LOG_PREFIX, date))
    } else {
        base_dir.join(format!("{}-{}.{}.log", LOG_PREFIX, date, segment))
    }
}

/// UTC 当前时间各分量。
fn utc_now() -> (i64, u32, u32, u32, u32, u32, u32) {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_millis())
        .unwrap_or(0);
    let days = (secs / 86400) as i64;
    let sod = secs % 86400;
    let (y, mo, d) = civil_from_days(days);
    (
        y,
        mo,
        d,
        (sod / 3600) as u32,
        ((sod % 3600) / 60) as u32,
        (sod % 60) as u32,
        millis,
    )
}

/// Howard Hinnant 的 days→civil 算法（无 chrono 依赖）。
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if month <= 2 { y + 1 } else { y }, month, day)
}

/// 按 UTF-8 边界截断到不超过 max_bytes 字节。
pub fn truncate_utf8(text: &str, max_bytes: usize) -> String {
    if text.len() <= max_bytes {
        return text.to_string();
    }
    let mut end = 0;
    let mut bytes = 0;
    for ch in text.chars() {
        let len = ch.len_utf8();
        if bytes + len > max_bytes {
            break;
        }
        bytes += len;
        end += len;
    }
    text[..end].to_string()
}

/// 脱敏（对标 dsh mask-secrets / 前端 redact.ts）：将常见密钥形态替换为
/// `[REDACTED]`。赋值型/头型标记（password=、token=、Bearer、ghp_…）吞掉
/// 任意长度的紧随 token；前缀型标记（sk-/pk-）要求其后 token ≥ 10 字符
/// 才替换，避免误伤普通文本（如 "task-error"）。
pub fn mask_secrets(text: &str) -> String {
    if text.is_empty() {
        return String::new();
    }
    // (marker, 是否赋值/头型 —— 不要求最小 token 长度)
    const MARKERS: &[(&str, bool)] = &[
        ("ghp_", true),
        ("gho_", true),
        ("ghs_", true),
        ("ghu_", true),
        ("AKIA", true),
        ("Bearer ", true),
        ("bearer ", true),
        ("Authorization:", true),
        ("authorization:", true),
        ("password=", true),
        ("passwd=", true),
        ("pwd=", true),
        ("secret=", true),
        ("token=", true),
        ("access_key=", true),
        ("apikey=", true),
        ("api_key=", true),
        ("api-key=", true),
        ("sk-", false),
        ("pk-", false),
    ];

    let bytes = text.as_bytes();
    let mut ranges: Vec<(usize, usize)> = Vec::new();
    for (marker, greedy) in MARKERS {
        let mut search_from = 0;
        while let Some(rel) = text[search_from..].find(marker) {
            let start = search_from + rel;
            let after = start + marker.len();
            // 跳过紧随的 token 字符（alnum / _ / - / .）；前缀型要求 ≥10。
            let mut end = after;
            while end < bytes.len()
                && (bytes[end].is_ascii_alphanumeric()
                    || bytes[end] == b'_'
                    || bytes[end] == b'-'
                    || bytes[end] == b'.')
            {
                end += 1;
            }
            let token_len = (end - after) as usize;
            // 赋值型/头型：必须吞到至少一个 token 字符才替换（避免误伤
            // "password= " 空值或 "Authorization: " 后面无凭据的普通文本）；
            // 前缀型（sk-/pk-）：token ≥ 10 字符才替换（防 "task-error" 误伤）。
            if (*greedy && token_len >= 1) || (!*greedy && token_len >= 10) {
                ranges.push((start, end));
            }
            search_from = if end > search_from { end } else { start + marker.len() };
        }
    }

    if ranges.is_empty() {
        return text.to_string();
    }
    ranges.sort_unstable();
    // 合并重叠区间（如 "Authorization: Bearer sk-abc…"）。
    let mut merged: Vec<(usize, usize)> = Vec::new();
    for (s, e) in ranges {
        if let Some(last) = merged.last_mut() {
            if s <= last.1 {
                if e > last.1 {
                    last.1 = e;
                }
                continue;
            }
        }
        merged.push((s, e));
    }
    let mut out = String::with_capacity(text.len());
    let mut cursor = 0;
    for (s, e) in merged {
        if s > cursor {
            out.push_str(&text[cursor..s]);
        }
        out.push_str("[REDACTED]");
        cursor = e;
    }
    if cursor < text.len() {
        out.push_str(&text[cursor..]);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "codem-runtime-log-test-{}-{}",
            tag,
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn mask_sk_key_with_long_token() {
        assert_eq!(
            mask_secrets("api rejected key=sk-abcdefghijklmnopqrstuvwxyz123456"),
            "api rejected key=[REDACTED]"
        );
    }

    #[test]
    fn mask_short_sk_requires_ten_chars() {
        // "task-error" 中的 sk- 后只有 5 个字符 → 不脱敏（避免误伤）。
        assert_eq!(mask_secrets("task-error happened"), "task-error happened");
        // 短真实 key 形态仍应保留原文？前缀型 <10 不替换（有意为之）。
        assert_eq!(mask_secrets("sk-abc"), "sk-abc");
    }

    #[test]
    fn mask_bearer_and_authorization() {
        let input = "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789\n";
        let masked = mask_secrets(input);
        assert!(!masked.contains("Bearer"));
        assert!(masked.contains("[REDACTED]"));
        // 覆盖到行尾非 token 字符（换行）为止。
        assert!(masked.ends_with("\n"));
    }

    #[test]
    fn mask_password_assignment_any_length() {
        // 与前端 redact.ts 语义一致：赋值连键名整段替换。
        assert_eq!(mask_secrets("password=hunter2 x=1"), "[REDACTED] x=1");
        assert_eq!(mask_secrets("--token=abc123"), "--[REDACTED]");
    }

    #[test]
    fn mask_github_and_aws() {
        assert_eq!(
            mask_secrets("use ghp_abcdefghijklmnopqrstuvwxyzABCDEFGHIJ for auth"),
            "use [REDACTED] for auth"
        );
        assert!(mask_secrets("AKIAIOSFODNN7EXAMPLE").contains("[REDACTED]"));
    }

    #[test]
    fn mask_overlapping_ranges_merged() {
        let input = "Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz123456 end";
        let masked = mask_secrets(input);
        assert!(!masked.contains("Bearer"));
        assert!(!masked.contains("sk-"));
        assert_eq!(masked.matches("[REDACTED]").count(), 1);
        assert!(masked.ends_with(" end"));
    }

    #[test]
    fn mask_plain_text_unchanged() {
        let input = "hello world, nothing sensitive here 1234567890";
        assert_eq!(mask_secrets(input), input);
    }

    #[test]
    fn truncate_keeps_utf8_boundary() {
        let s = "中文内容中文内容中文内容中文内容";
        let t = truncate_utf8(s, 10);
        assert!(t.len() <= 10);
        assert!(t.is_char_boundary(t.len()));
        assert_eq!(t, "中文内");
    }

    #[test]
    fn owned_log_name_matches() {
        assert!(is_owned_log_name("codem-runtime-2026-09-02.log"));
        assert!(is_owned_log_name("codem-runtime-2026-09-02.2.log"));
        assert!(!is_owned_log_name("codem-crash.log"));
        assert!(!is_owned_log_name("codem-runtime-2026-9-2.log"));
        assert!(!is_owned_log_name("codem-runtime-2026-09-02.txt"));
        assert!(!is_owned_log_name("active-run.json"));
    }

    #[test]
    fn append_writes_masked_line_to_file() {
        let dir = tmp_dir("append");
        append_line_to(&dir, "INFO", "started with key sk-abcdefghijklmnopqrstuvwxyz123456");
        append_line_to(&dir, "ERROR", "boom");
        let files = owned_logs(&dir);
        assert_eq!(files.len(), 1);
        let content = fs::read_to_string(&files[0]).unwrap();
        assert!(content.contains("[INFO] started with key [REDACTED]"));
        assert!(content.contains("[ERROR] boom"));
        assert!(!content.contains("sk-abcdef"));
        assert_eq!(content.lines().count(), 2);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn segment_rotation_when_file_full() {
        let dir = tmp_dir("rotate");
        // 单行上限 ~8KB；4MB 单文件约容纳 512 行。写 600 行 → 0 段满后升 1 段。
        let big = "x".repeat(8_000);
        for _ in 0..600 {
            append_line_to(&dir, "INFO", &big);
        }
        let files = owned_logs(&dir);
        assert!(files.len() >= 2, "expected rotation, got {files:?}");
        // 0 段不应超过上限太多。
        let sizes: Vec<u64> = files.iter().map(|f| fs::metadata(f).unwrap().len()).collect();
        assert!(sizes.iter().all(|s| *s <= MAX_FILE_BYTES + 8192));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn stale_judgement() {
        let now = 1_800_000_000u64;
        assert!(is_stale(now - 20 * 86_400, now, 14)); // 20 天前 → 过期
        assert!(!is_stale(now - 1 * 86_400, now, 14)); // 1 天前 → 保留
        assert!(!is_stale(now, now, 14)); // 现在 → 保留
        // 边界：恰好 14 天不删（严格大于）。
        assert!(!is_stale(now - 14 * 86_400, now, 14));
        assert!(is_stale(now - 14 * 86_400 - 1, now, 14));
    }

    #[test]
    fn purge_keeps_fresh_files() {
        let dir = tmp_dir("purge");
        append_line_to(&dir, "INFO", "fresh one");
        append_line_to(&dir, "WARN", "fresh two");
        purge_old_logs_in(&dir);
        let files = owned_logs(&dir);
        assert_eq!(files.len(), 1, "fresh logs must survive purge");
        let content = fs::read_to_string(&files[0]).unwrap();
        assert!(content.contains("fresh one"));
        assert!(content.contains("fresh two"));
        let _ = fs::remove_dir_all(&dir);
    }
}
