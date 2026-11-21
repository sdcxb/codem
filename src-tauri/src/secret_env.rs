//! 子进程环境变量剥离（Part C）。
//!
//! ## 为什么需要
//!
//! 宿主进程（Codem）自身带着用户机器的**完整**环境：`OPENAI_API_KEY`、`GITHUB_TOKEN`、
//! `DATABASE_URL`、公司代理的 `http://user:pass@proxy`……改动之前，`execute_command` /
//! `spawn_pty` / `mcp_stdio_connect` / OFM 插件进程都是**原样继承**这份环境
//! （`std::process::Command` / `portable_pty::CommandBuilder` 的默认行为就是继承），
//! 于是一条被模型写出来的命令、一个用户从市场里装的 MCP 服务器、一个第三方插件脚本，
//! 都能随手把宿主的凭据读走 —— 而它们**从来不需要**这些凭据（要跑的工具只需要 PATH、
//! TEMP、APPDATA、工具链目录这些）。
//!
//! ## 策略（两条，顺序不能反）
//!
//! 1. **allowlist 为主**：只把 `keepExact` / `keepProxyWithoutUserinfo` / `keepPrefix`
//!    命中的变量交给子进程 —— **默认剥离**，不是默认继承。
//! 2. **denylist 补充**：`dropExact` / `dropSuffixes` 一票否决。它现在的实际作用是
//!    **守住将来**：有人为了图方便把 `CODEM_` 之类前缀加进 `keepPrefix` 时，
//!    `CODEM_..._TOKEN` 仍然会被剥（单测 `deny_list_vetoes_a_future_keep_prefix` 钉死）。
//!
//! 规则**只有一份**：`src/core/security/secret-env-patterns.json`（本文件 `include_str!`
//! 读它，TS 侧之后读同一份）。这里不许再复制一张表。
//!
//! ## 明确不在本模块职责内的事
//!
//! - **不**改 `execute_command` 的超时 / 杀树 / 日志逻辑（只动 env 一段）。
//! - **不**替调用方决定 MCP 用户显式配置的 env：那部分由 `mcp_stdio_connect` 在
//!   `child_env_plan` 之后**最后覆盖**（用户自己填的凭据要能工作）。
//! - `inherit = true`（用户在设置里显式打开）时**不剥离**，完整继承 —— 这是逃生门，
//!   默认值 `DEFAULT_INHERIT = false`（Rust 侧兜底，不依赖前端先调过 setter）。
//!
//! ## 为什么 `env_clear()` 是唯一正确的做法
//!
//! 按"注册表里的种子列表逐个 `env_remove`"删是不可行的：种子列表只能删它认识的名字，
//! 而**真正危险的恰恰是它不认识的名字**（用户自己起的 `MY_COMPANY_API_KEY`）。
//! 先清空、再按 allowlist 回填是**按构造**闭合的：新出现的名字默认进不来。
//! `portable_pty::CommandBuilder::env_clear()` 在 0.8.1 就存在（crate 源码已核对：
//! `envs` 是 `BTreeMap`，`env_clear` 清空整张表，Windows 侧 `environment_block()`
//! 直接由这张表生成 CREATE_UNICODE_ENVIRONMENT 的块 ⇒ 子进程拿不到任何未回填的变量）。

use std::collections::HashMap;
use std::ffi::{OsStr, OsString};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

use serde::Deserialize;

/// 策略唯一来源（与 TS 共用同一个文件；路径相对本文件 ⇒ 仓库根下的 `src/core/security/`）。
pub const RULES_JSON: &str = include_str!("../../src/core/security/secret-env-patterns.json");

/// 默认策略：**剥离**（`false` = 不继承）。
///
/// 这是 Rust 侧的兜底：前端没调用过 `set_secret_env_policy` 时也必须先是剥离态
/// （否则"忘了初始化"就等于悄悄放行整份环境）。
pub const DEFAULT_INHERIT: bool = false;

/// 静态兜底表：JSON 万一解析不了时用（只保留**跑得起来**所需的最小集合，仍然不含凭据）。
const FALLBACK_KEEP: &[&str] = &[
    "PATH",
    "HOME",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "SystemRoot",
    "windir",
    "SystemDrive",
    "ComSpec",
    "PATHEXT",
    "TEMP",
    "TMP",
    "APPDATA",
    "LOCALAPPDATA",
    "PROGRAMDATA",
    "PROGRAMFILES",
    "NUMBER_OF_PROCESSORS",
    "PROCESSOR_ARCHITECTURE",
    "OS",
    "USERNAME",
    "SHELL",
    "LANG",
    "TERM",
];

// ========== 策略开关（进程级，Rust 侧兜底）==========

/// `true` = 完整继承（逃生门）；`false` = 只传 allowlist（默认）。
static INHERIT_POLICY: OnceLock<AtomicBool> = OnceLock::new();

fn inherit_flag() -> &'static AtomicBool {
    INHERIT_POLICY.get_or_init(|| AtomicBool::new(DEFAULT_INHERIT))
}

/// 当前全局策略。未初始化时返回 [`DEFAULT_INHERIT`]（剥离）。
pub fn policy_inherit() -> bool {
    inherit_flag().load(Ordering::Relaxed)
}

/// 写入全局策略（Tauri command `set_secret_env_policy` 的唯一入口）。
pub fn set_policy_inherit(inherit: bool) {
    inherit_flag().store(inherit, Ordering::Relaxed);
}

/// 单次调用的有效策略：`Some(v)` 覆盖全局，`None` 用全局。
///
/// 旧前端调用不传 `allowSecretEnv` ⇒ `None` ⇒ 走全局（默认剥离）⇒ 行为只会更严，不会更松。
pub fn resolve_inherit(allow: Option<bool>) -> bool {
    allow.unwrap_or_else(policy_inherit)
}

// ========== 规则表 ==========

/// 名字级判定结果。
///
/// ⚠️ 它**只是** denylist 的结论（"这个名字本身像不像凭据"），不是最终策略 ——
/// 最终"要不要交给子进程"由 [`keep_in_strip_env`] 结合 allowlist 决定。
/// 分开是因为两条判据要能各自变红：denylist 认错名字不许把 `MONKEY` 剥掉，
/// allowlist 漏一个系统变量也不许靠 denylist 兜（那是兜不住的）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EnvVerdict {
    /// 名字不像凭据（**不代表**会传给子进程）。
    Keep,
    /// 名字命中 denylist（`dropExact` 或 `dropSuffixes`）⇒ 一定不传。
    Drop,
}

/// 解析后的规则表（所有名字统一大写，比较一律大小写不敏感）。
#[derive(Debug, Clone, Default)]
pub struct EnvRules {
    keep_exact: Vec<String>,
    keep_proxy: Vec<String>,
    keep_prefix: Vec<String>,
    drop_exact: Vec<String>,
    drop_suffixes: Vec<String>,
}

#[derive(Deserialize)]
struct RawRules {
    #[serde(rename = "keepExact", default)]
    keep_exact: Vec<String>,
    #[serde(rename = "keepProxyWithoutUserinfo", default)]
    keep_proxy: Vec<String>,
    #[serde(rename = "keepPrefix", default)]
    keep_prefix: Vec<String>,
    #[serde(rename = "dropExact", default)]
    drop_exact: Vec<String>,
    #[serde(rename = "dropSuffixes", default)]
    drop_suffixes: Vec<String>,
}

fn norm(names: &[String]) -> Vec<String> {
    let mut out: Vec<String> = names
        .iter()
        .map(|s| s.trim().to_ascii_uppercase())
        .filter(|s| !s.is_empty())
        .collect();
    out.sort();
    out.dedup();
    out
}

impl EnvRules {
    /// 从 JSON 文本解析（TS / Rust 同一份）。空表或字段缺失都算合法，只有 JSON 本身坏才算错。
    pub fn from_json(text: &str) -> Result<EnvRules, String> {
        let raw: RawRules =
            serde_json::from_str(text).map_err(|e| format!("secret-env-patterns.json 解析失败：{e}"))?;
        let rules = EnvRules {
            keep_exact: norm(&raw.keep_exact),
            keep_proxy: norm(&raw.keep_proxy),
            keep_prefix: norm(&raw.keep_prefix),
            drop_exact: norm(&raw.drop_exact),
            drop_suffixes: norm(&raw.drop_suffixes),
        };
        if rules.keep_exact.is_empty() {
            return Err(
                "secret-env-patterns.json 的 keepExact 为空 ⇒ 连 PATH 都不会回填，拒绝启动该策略"
                    .to_string(),
            );
        }
        Ok(rules)
    }

    /// JSON 坏掉时的最小兜底：仍然按 allowlist 白名单，只是表更短（绝不放行整份环境）。
    fn fallback() -> EnvRules {
        EnvRules {
            keep_exact: norm(&FALLBACK_KEEP.iter().map(|s| s.to_string()).collect::<Vec<_>>()),
            keep_proxy: norm(&["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"]
                .iter()
                .map(|s| s.to_string())
                .collect::<Vec<_>>()),
            keep_prefix: Vec::new(),
            drop_exact: Vec::new(),
            drop_suffixes: norm(&["_KEY", "_TOKEN", "_SECRET", "_PASSWORD", "_PASSWD", "_CREDENTIALS"]
                .iter()
                .map(|s| s.to_string())
                .collect::<Vec<_>>()),
        }
    }
}

static RULES: OnceLock<EnvRules> = OnceLock::new();

fn rules() -> &'static EnvRules {
    RULES.get_or_init(|| match EnvRules::from_json(RULES_JSON) {
        Ok(r) => r,
        Err(e) => {
            // 只记一次；策略本身仍然闭着（fallback 也是 allowlist，不是 inherited）。
            crate::runtime_log::append_line(
                "WARN",
                &format!("secret-env-patterns.json 不可用，退回最小 allowlist：{e}"),
            );
            EnvRules::fallback()
        }
    })
}

// ========== 判定 ==========

/// denylist 命中原因（日志/测试用；`None` = 名字本身不敏感）。
fn deny_reason_with(rules: &EnvRules, name: &str) -> Option<&'static str> {
    let up = name.trim().to_ascii_uppercase();
    if rules.drop_exact.iter().any(|n| n == &up) {
        return Some("dropExact");
    }
    // ★ 后缀必须带前导下划线：`MONKEY` / `KEYBOARD_LAYOUT` 不许被 `_KEY` 误伤
    //   （判据 `secret_env::classify_keeps_benign_key_substring_names` 钉死）。
    if rules.drop_suffixes.iter().any(|s| up.ends_with(s.as_str())) {
        return Some("dropSuffix");
    }
    None
}

/// 名字级判定：denylist 命中 ⇒ [`EnvVerdict::Drop`]，否则 [`EnvVerdict::Keep`]。
///
/// 大小写不敏感。**注意**：`Keep` 只表示"名字不像凭据"，最终是否传给子进程仍由
/// [`keep_in_strip_env`] 的 allowlist 决定（默认剥离）。
///
/// 生产路径经 [`keep_in_strip_env`] / [`child_env_plan`] 使用同一套规则；这个单名入口
/// 主要给**诊断与单测**直接驱动（也方便 TS 侧对齐语义）。
#[allow(dead_code)] // 无独立生产调用点：策略判定统一走 keep_in_strip_env
pub fn classify_env_name(name: &str) -> EnvVerdict {
    classify_with(rules(), name)
}

fn classify_with(rules: &EnvRules, name: &str) -> EnvVerdict {
    match deny_reason_with(rules, name) {
        Some(_) => EnvVerdict::Drop,
        None => EnvVerdict::Keep,
    }
}

/// 剥离模式下这个名字（及其值）要不要交给子进程。
///
/// 顺序即策略：**denylist 一票否决 → allowlist 命中 → 否则剥离**。
pub fn keep_in_strip_env(name: &str, value: Option<&OsStr>) -> bool {
    keep_in_strip_env_with(rules(), name, value)
}

fn keep_in_strip_env_with(rules: &EnvRules, name: &str, value: Option<&OsStr>) -> bool {
    if classify_with(rules, name) == EnvVerdict::Drop {
        return false; // ① 敏感名一票否决（即使将来被 keepPrefix 覆盖）
    }
    let up = name.trim().to_ascii_uppercase();
    if rules.keep_exact.iter().any(|n| n == &up) {
        return true; // ② allowlist 精确命中
    }
    if rules.keep_prefix.iter().any(|p| up.starts_with(p.as_str())) {
        return true; // ③ 刻意放行的家族（默认空）
    }
    if rules.keep_proxy.iter().any(|n| n == &up) {
        /*
         * 代理是"既要又要"的一条：没有代理子进程连不上网（构建/装包会全红），
         * 但 `http://user:pass@corp-proxy:8080` 这个形态的 userinfo **就是凭据**。
         * 判据只看值里有没有 `@` —— 有就整个丢掉（宁可不走代理，也不泄漏密码）。
         */
        return value
            .map(|v| !v.to_string_lossy().contains('@'))
            .unwrap_or(false);
    }
    false // ④ 默认剥离
}

// ========== 环境计划 ==========

/// 一次子进程启动要写进环境的**全部**变量（有序：保留下来的继承变量在前，调用方显式 env 在最后）。
#[derive(Debug, Clone)]
pub struct EnvPlan {
    /// `true` ⇒ 先 `env_clear()` 再逐条写；`false` ⇒ 不清理（inherit 逃生门），只叠加显式 env。
    clear: bool,
    entries: Vec<(OsString, OsString)>,
}

impl EnvPlan {
    /// 是否先清空继承环境（测试与日志用）。
    #[cfg(test)]
    pub fn clears(&self) -> bool {
        self.clear
    }

    /// 有序条目（测试用：顺序判据 —— 调用方 env 必须在最后）。
    #[cfg(test)]
    pub fn entries(&self) -> &[(OsString, OsString)] {
        &self.entries
    }

    /// 按名字取值（大小写不敏感，后写覆盖先写）。
    #[cfg(test)]
    pub fn get(&self, name: &str) -> Option<&OsStr> {
        self.entries
            .iter()
            .rev()
            .find(|(k, _)| k.to_string_lossy().eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_os_str())
    }

    /// 应用到同步 [`std::process::Command`]。
    pub fn apply_std(&self, cmd: &mut std::process::Command) {
        if self.clear {
            cmd.env_clear();
        }
        for (k, v) in &self.entries {
            cmd.env(k, v);
        }
    }

    /// 应用到 [`tokio::process::Command`]（MCP / OFM 走这条）。
    pub fn apply_tokio(&self, cmd: &mut tokio::process::Command) {
        if self.clear {
            cmd.env_clear();
        }
        for (k, v) in &self.entries {
            cmd.env(k, v);
        }
    }

    /// 应用到 [`portable_pty::CommandBuilder`]（终端走这条）。
    pub fn apply_pty(&self, cmd: &mut portable_pty::CommandBuilder) {
        if self.clear {
            cmd.env_clear();
        }
        for (k, v) in &self.entries {
            cmd.env(k, v);
        }
    }
}

/// 计算子进程环境。
///
/// - `inherit == true`：**不**清理（完整继承），只在末尾叠加 `caller`（MCP 用户显式 env）。
/// - `inherit == false`：只保留 allowlist 命中的继承变量，再叠加 `caller`（后者必胜 —— 那是
///   用户自己填的 MCP 凭据，剥掉就等于把功能弄坏）。
pub fn child_env_plan(inherit: bool, caller: Option<&HashMap<String, String>>) -> EnvPlan {
    if inherit {
        return EnvPlan {
            clear: false,
            entries: caller_entries(None, caller),
        };
    }

    let mut entries: Vec<(OsString, OsString)> = std::env::vars_os()
        .filter(|(k, v)| keep_in_strip_env(&k.to_string_lossy(), Some(v.as_os_str())))
        .collect();
    sort_by_name(&mut entries);
    ensure_essentials(&mut entries);
    sort_by_name(&mut entries);

    let entries = caller_entries(Some(&entries), caller);
    EnvPlan {
        clear: true,
        entries,
    }
}

fn sort_by_name(entries: &mut [(OsString, OsString)]) {
    entries.sort_by(|a, b| a.0.to_string_lossy().cmp(&b.0.to_string_lossy()));
}

/// 把调用方显式 env 追加到尾部（同名则覆盖，保留调用方的键名拼写）。
fn caller_entries(
    base: Option<&[(OsString, OsString)]>,
    caller: Option<&HashMap<String, String>>,
) -> Vec<(OsString, OsString)> {
    let mut out: Vec<(OsString, OsString)> = base.map(|b| b.to_vec()).unwrap_or_default();
    let Some(caller) = caller else { return out };
    let mut keys: Vec<&String> = caller.keys().collect();
    keys.sort(); // 稳定顺序（日志/测试可复现）
    for k in keys {
        let v = &caller[k];
        out.retain(|(name, _)| !name.to_string_lossy().eq_ignore_ascii_case(k));
        out.push((OsString::from(k), OsString::from(v)));
    }
    out
}

// ========== Windows「跑得起来」的最低保障 ==========
//
// allowlist 只是"允许保留"，能不能真跑起来还取决于这几个变量在宿主里是否存在。
// 缺了就补**能验证的**值（磁盘上确实存在的路径 / 有确定语义的常量），不猜路径。

#[cfg(windows)]
fn env_has(entries: &[(OsString, OsString)], name: &str) -> bool {
    entries
        .iter()
        .any(|(k, _)| k.to_string_lossy().eq_ignore_ascii_case(name))
}

#[cfg(windows)]
fn env_get(entries: &[(OsString, OsString)], name: &str) -> Option<String> {
    entries
        .iter()
        .find(|(k, _)| k.to_string_lossy().eq_ignore_ascii_case(name))
        .map(|(_, v)| v.to_string_lossy().to_string())
}

#[cfg(windows)]
fn env_push(entries: &mut Vec<(OsString, OsString)>, name: &str, value: impl Into<OsString>) {
    if !env_has(entries, name) {
        entries.push((OsString::from(name), value.into()));
    }
}

#[cfg(windows)]
fn ensure_essentials(entries: &mut Vec<(OsString, OsString)>) {
    // Windows 目录：优先宿主给的 SystemRoot/windir，退到确实存在的 C:\Windows。
    let sysroot = env_get(entries, "SystemRoot")
        .or_else(|| env_get(entries, "windir"))
        .or_else(|| {
            let p = std::path::PathBuf::from(r"C:\Windows");
            p.is_dir().then(|| p.to_string_lossy().to_string())
        });
    if let Some(root) = sysroot {
        env_push(entries, "SystemRoot", root.as_str());
        env_push(entries, "windir", root.as_str());
        if let Some(drive) = root.get(..2).filter(|d| d.as_bytes().get(1) == Some(&b':')) {
            env_push(entries, "SystemDrive", drive);
        }
        let sys32 = std::path::Path::new(&root).join("System32");
        let cmd = sys32.join("cmd.exe");
        if cmd.is_file() {
            env_push(entries, "ComSpec", cmd.to_string_lossy().to_string());
        }
        if !env_has(entries, "PATH") && sys32.is_dir() {
            // 没有 PATH 的 cmd.exe 连内置命令都找不到 ⇒ 退化成这个最小集合也比空着强。
            env_push(entries, "PATH", format!("{};{}", sys32.display(), root));
        }
    }
    env_push(entries, "PATHEXT", ".COM;.EXE;.BAT;.CMD");
    if !env_has(entries, "USERPROFILE") {
        if let (Some(drive), Some(home)) =
            (env_get(entries, "HOMEDRIVE"), env_get(entries, "HOMEPATH"))
        {
            env_push(entries, "USERPROFILE", format!("{drive}{home}"));
        }
    }
}

#[cfg(not(windows))]
fn ensure_essentials(_entries: &mut Vec<(OsString, OsString)>) {}

// ========== 单测（策略本身；行为/端到端在 lib.rs / 本文件 apply_* 那几条）==========

#[cfg(test)]
mod tests {
    use super::*;

    const FAKE: &str = "CODEM_TEST_FAKE_TOKEN";

    /// denylist：四类真凭据名字必须 Drop。
    #[test]
    fn classify_drops_secret_looking_names() {
        for name in [
            "OPENAI_API_KEY",
            "NPM_TOKEN",
            "DATABASE_URL",
            "AWS_SECRET_ACCESS_KEY",
            "GITHUB_TOKEN",
            "STRIPE_SECRET",
            "PGPASSWORD",
            "GOOGLE_APPLICATION_CREDENTIALS",
            "SMTP_PASSWORD",
            "OLD_PASSWD",
        ] {
            assert_eq!(
                classify_env_name(name),
                EnvVerdict::Drop,
                "{name} 必须被判为敏感（否则它会跟着子进程走）"
            );
        }
    }

    /// 大小写不敏感（Windows 环境变量本就不区分大小写；Unix 侧刻意同样处理）。
    #[test]
    fn classify_is_case_insensitive() {
        for name in ["openai_api_key", "Npm_Token", "database_url", "aws_secret_access_key"] {
            assert_eq!(classify_env_name(name), EnvVerdict::Drop, "{name} 大小写变体必须同样 Drop");
        }
        assert_eq!(classify_env_name("path"), EnvVerdict::Keep);
        assert_eq!(classify_env_name("UserProfile"), EnvVerdict::Keep);
    }

    /// ★ 这条守的是"后缀必须带前导下划线"：`MONKEY` / `KEYBOARD_LAYOUT` 不许被 `KEY` 误伤。
    /// 把 `_KEY` 改成 `KEY` ⇒ 立刻红。
    #[test]
    fn classify_keeps_benign_key_substring_names() {
        for name in ["KEYBOARD_LAYOUT", "MONKEY", "PATH", "USERPROFILE", "TEMP"] {
            assert_eq!(
                classify_env_name(name),
                EnvVerdict::Keep,
                "{name} 只是**名字里含 KEY**，不是凭据；把它剥掉属于误伤"
            );
        }
    }

    /// allowlist 为主：系统/工具链变量保留，其余（含"名字不敏感"的）默认剥离。
    #[test]
    fn allowlist_keeps_system_and_toolchain_vars() {
        for name in ["PATH", "USERPROFILE", "SystemRoot", "windir", "ComSpec", "PATHEXT", "TEMP", "APPDATA", "JAVA_HOME", "PNPM_HOME", "NODE_PATH"] {
            assert!(
                keep_in_strip_env(name, Some(OsStr::new("x"))),
                "{name} 必须在 allowlist 里（否则子进程跑不起来）"
            );
        }
        // 名字不敏感 ≠ 会传：默认剥离是 allowlist 决定的。
        for name in ["KEYBOARD_LAYOUT", "MONKEY", "MY_COMPANY_THING"] {
            assert!(
                !keep_in_strip_env(name, Some(OsStr::new("x"))),
                "{name} 不在 allowlist 里 ⇒ 默认剥离（默认继承才是缺陷）"
            );
        }
    }

    /// 代理：值里没有 userinfo 才留；有 `@` 就是凭据，整个丢掉。
    #[test]
    fn proxy_kept_only_without_userinfo() {
        assert!(keep_in_strip_env("HTTP_PROXY", Some(OsStr::new("http://proxy.corp:8080"))));
        assert!(keep_in_strip_env("NO_PROXY", Some(OsStr::new("localhost,127.0.0.1"))));
        assert!(
            !keep_in_strip_env("HTTP_PROXY", Some(OsStr::new("http://user:pass@proxy.corp:8080"))),
            "含 userinfo 的代理本身就是凭据，必须剥掉"
        );
        assert!(!keep_in_strip_env("HTTPS_PROXY", None), "取不到值时不许默认放行");
    }

    /// ★ denylist 的**实际作用**：守住将来有人往 `keepPrefix` 里加 `CODEM_` 这种宽松前缀。
    /// （用同一份 JSON 语义的合成规则驱动，跑的是生产同一个判定函数。）
    #[test]
    fn deny_list_vetoes_a_future_keep_prefix() {
        let rules = EnvRules::from_json(
            r#"{
              "keepExact": ["PATH"],
              "keepProxyWithoutUserinfo": [],
              "keepPrefix": ["CODEM_"],
              "dropExact": ["DATABASE_URL"],
              "dropSuffixes": ["_KEY", "_TOKEN", "_SECRET", "_PASSWORD", "_PASSWD", "_CREDENTIALS"]
            }"#,
        )
        .expect("合成规则必须可解析");

        assert!(
            keep_in_strip_env_with(&rules, "CODEM_DATA_HOME", Some(OsStr::new("d"))),
            "前缀命中 ⇒ 放行（否则这条判据测不到 veto）"
        );
        assert!(
            !keep_in_strip_env_with(&rules, FAKE, Some(OsStr::new("leak-me"))),
            "前缀放行之后，_TOKEN 后缀仍必须一票否决：{FAKE} 不许进子进程"
        );
        assert!(!keep_in_strip_env_with(&rules, "CODEM_OPENAI_KEY", Some(OsStr::new("k"))));
    }

    /// 计划：剥离时只带 allowlist；调用方显式 env **最后**追加并被保留（MCP 凭据那条路）。
    #[test]
    fn plan_strips_inherited_env_and_appends_caller_env_last() {
        std::env::set_var(FAKE, "leak-me");
        let mut caller = HashMap::new();
        caller.insert("FAKE".to_string(), "1".to_string());
        caller.insert("MCP_AUTH".to_string(), "user-token".to_string());

        let plan = child_env_plan(false, Some(&caller));

        assert!(plan.clears(), "剥离模式必须先 env_clear()");
        assert_eq!(
            plan.get(FAKE),
            None,
            "宿主继承来的 {FAKE} 必须被剥（它不含 allowlist 命中）"
        );
        assert!(plan.get("PATH").is_some(), "PATH 必须在（否则连命令都找不到）");
        assert_eq!(
            plan.get("FAKE").map(|v| v.to_string_lossy().to_string()),
            Some("1".to_string()),
            "调用方显式 env 在剥离模式下必须保留（用户自己填的才算数）"
        );
        assert_eq!(
            plan.get("MCP_AUTH").map(|v| v.to_string_lossy().to_string()),
            Some("user-token".into()),
            "用户显式配置的 MCP 凭据必须保留（剥掉等于把功能弄坏）"
        );

        // 顺序判据：调用方 env 必须排在最后（后写覆盖先写才成立）
        let last_two: Vec<String> = plan
            .entries()
            .iter()
            .rev()
            .take(2)
            .map(|(k, _)| k.to_string_lossy().to_string())
            .collect();
        assert_eq!(last_two, vec!["MCP_AUTH".to_string(), "FAKE".to_string()], "调用方 env 必须在尾部且保持稳定顺序");
    }

    /// inherit 逃生门：不清理，只叠加显式 env。
    #[test]
    fn plan_inherit_does_not_clear() {
        let mut caller = HashMap::new();
        caller.insert("FAKE".to_string(), "1".to_string());
        let plan = child_env_plan(true, Some(&caller));
        assert!(!plan.clears(), "inherit 模式不许 env_clear（那是用户显式打开的行为）");
        assert_eq!(plan.entries().len(), 1);
    }

    /// Rust 侧兜底默认值必须是**剥离**（前端没初始化也不能放行整份环境）。
    #[test]
    fn default_policy_is_strip() {
        assert!(!DEFAULT_INHERIT, "默认策略被改成继承了 ⇒ 所有旧调用都会泄漏整份环境");
        assert_eq!(resolve_inherit(Some(true)), true);
        assert_eq!(resolve_inherit(Some(false)), false);
        assert_eq!(resolve_inherit(None), policy_inherit(), "None 必须落到全局策略");
        set_policy_inherit(true);
        assert!(policy_inherit());
        set_policy_inherit(false); // 还原，避免影响同进程的其它用例
        assert!(!policy_inherit());
    }

    /// 规则表来自 JSON（唯一来源）：改 JSON 就能改行为，不存在第二张表。
    #[test]
    fn rules_come_from_the_shared_json() {
        let parsed = EnvRules::from_json(RULES_JSON).expect("仓库里的策略 JSON 必须可解析");
        assert!(parsed.keep_exact.iter().any(|n| n == "PATH"));
        assert!(
            parsed.keep_prefix.is_empty(),
            "keepPrefix 必须为空：加 CODEM_ 之类前缀会把测试令牌放过去"
        );
        assert!(parsed.drop_suffixes.iter().any(|n| n == "_TOKEN"));
        // 坏 JSON 必须报错（不许静默当成空表 = 全放行）
        assert!(EnvRules::from_json("{ not json").is_err());
    }

    /// 端到端（真子进程）：`apply_tokio` 之后子进程拿不到宿主令牌，而 PATH 还在。
    /// 同一条用例里带**对照组**（不清理就看得见）⇒ 判据能变红，不是自证。
    #[tokio::test]
    async fn apply_tokio_really_clears_child_environment() {
        std::env::set_var(FAKE, "leak-me");
        let probe = "Write-Output \"[$env:CODEM_TEST_FAKE_TOKEN]\"";

        // ① 对照组：不清理 ⇒ 必须看见 token（证明这条判据本身有分辨力）
        let control = powershell_command(probe).output().await;
        let control = match control {
            Ok(o) => o,
            Err(e) => {
                eprintln!("跳过：起不来 powershell（{e}）");
                return;
            }
        };
        let control_out = String::from_utf8_lossy(&control.stdout).to_string();
        assert!(
            control_out.contains("leak-me"),
            "对照组应当看得见 token（否则这条判据证明不了任何事）：{control_out}"
        );

        // ② 实验组：apply_tokio 之后必须看不见
        let plan = child_env_plan(false, None);
        let mut cmd = powershell_command(probe);
        plan.apply_tokio(&mut cmd);
        let stripped = cmd.output().await.expect("stripped 子进程必须能起来（PATH 还在）");
        let stripped_out = String::from_utf8_lossy(&stripped.stdout).to_string();
        assert!(
            !stripped_out.contains("leak-me"),
            "剥离之后 token 仍然泄漏：{stripped_out}"
        );

        // ③ PATH 仍然可用（不是把所有东西都清空导致"根本没跑起来"）
        let path_plan = child_env_plan(false, None);
        let mut path_cmd = powershell_command("$env:PATH");
        path_plan.apply_tokio(&mut path_cmd);
        let path_out = path_cmd.output().await.expect("查 PATH 的子进程必须能起来");
        let path_text = String::from_utf8_lossy(&path_out.stdout).trim().to_string();
        assert!(!path_text.is_empty(), "子进程里 PATH 不能是空的");
    }

    /// 测试用的 PowerShell 子进程。
    ///
    /// ⚠️ 不要在这里散着起子进程：源码级棘轮 `NO-CONSOLE-1`
    /// （`src/test/no-console-window.test.ts`）要求 `src-tauri` 里**每个** spawn 点之后
    /// 80 行内出现 `creation_flags`，否则判红（GUI 里会闪黑框）。收在一个工厂里最省事。
    fn powershell_command(probe: &str) -> tokio::process::Command {
        let mut c = tokio::process::Command::new("powershell");
        c.args(["-NoProfile", "-NonInteractive", "-Command", probe]);
        #[cfg(target_os = "windows")]
        {
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            c.creation_flags(CREATE_NO_WINDOW);
        }
        c
    }
}
