//! 安全边界：authorizer 白/黑名单（第 92 波 P1）
//!
//! ## 为什么必须有这一层
//!
//! 迁移后渲染进程只能通过**类型化仓储命令**访问数据库 —— 但如果哪一天有人把命令实现成
//! "执行传入的 SQL 片段"，`ATTACH DATABASE '/任意路径'` 就立刻变成**任意文件读取原语**
//! （配合 `CREATE TABLE ... AS SELECT` 还能把内容读出来），`load_extension` 更是直接执行代码。
//! 这类口子不能靠"大家记得别这么写"，必须在引擎层**关死**。
//!
//! 因此：连接打开后装上 authorizer ——
//! - **拒绝** `ATTACH` / `DETACH`（跨库访问 = 文件读取原语）
//! - **拒绝** `load_extension` 与其它扩展加载
//! - **拒绝**危险 `PRAGMA`（`writable_schema`、`writable_schema`、`data_version` 写、`mmap_size` 写等）
//! - 其余放行（正常读写、事务、FTS、临时表）
//!
//! 注意：`journal_mode` / `synchronous` 等**在装 authorizer 之前**由引擎自己设置，
//! 所以这里把它们一律设为"只能读、不能写"。

use rusqlite::hooks::{AuthAction, AuthContext, Authorization};
use rusqlite::Connection;

/// 引擎级 PRAGMA：**读**放行（健康检查直接用），**写**拒绝（渲染侧不得改变引擎的落盘语义）。
/// 写这些会让"单写者 + WAL + NORMAL"的前提失效：例如 `synchronous=OFF` 直接牺牲崩溃安全，
/// `journal_mode=MEMORY` 会关掉 WAL，`foreign_keys=OFF` 会让级联删除与对账失真。
const ENGINE_PRAGMAS: &[&str] = &[
    "journal_mode",
    "synchronous",
    "busy_timeout",
    "foreign_keys",
    "temp_store",
    "page_size",
    "mmap_size",
    "cache_size",
    "locking_mode",
    "auto_vacuum",
    "secure_delete",
    "encoding",
];

/// 完全拒绝的 PRAGMA：**读写都拒**。
///
/// 只有 `writable_schema` —— 它可以被用来伪造/篡改库结构（把一行塞进 `sqlite_master` 改 schema），
/// 属于"数据库完整性"级别的口子，读写都关。
///
/// ⚠️ 教训（第 92 波实测）：**不能把内部探针 pragma 也拒掉**。
/// `data_version` 是 SQLite 自己在 `sqlite3_prepare` 期间会读的（用于判断 schema 是否变化），
/// 拒掉它的后果不是"少一个诊断读数"，而是**所有语句准备失败**：新建库时报
/// `vtable constructor failed: session_fts`（虚拟表构造期间的 prepare 被拒），
/// 错误信息还完全指不到真正的原因。所以内部探针类 pragma 一律放行读：
/// `data_version`、`integrity_check`、`quick_check`、`freelist_count`、`page_count`…
const FULLY_DENIED_PRAGMAS: &[&str] = &["writable_schema"];

/// 判断某个 PRAGMA 是否被拒（`value_is_none` = 只读形态：`PRAGMA name` 而不是 `PRAGMA name = value`）
pub fn pragma_denied(name: &str, is_read: bool) -> bool {
    let n = name.to_ascii_lowercase();
    if FULLY_DENIED_PRAGMAS.iter().any(|d| *d == n) {
        return true;
    }
    !is_read && ENGINE_PRAGMAS.iter().any(|d| *d == n)
}

/// 装上安全边界（幂等：重复调用会覆盖为同一策略）
pub fn install(conn: &Connection) {
    let _ = conn.authorizer(Some(|ctx: AuthContext<'_>| -> Authorization {
        let verdict = decide(&ctx);
        if std::env::var_os("CODEM_DB_AUTH_TRACE").is_some() {
            eprintln!("[auth] {:?} => {:?}", ctx.action, verdict);
        }
        verdict
    }));
}

/// 摘掉安全边界。**只给"引擎自己的内部维护操作"用** ——
/// 目前只有一处：`lib.rs::storage_compact` 里的 `VACUUM`。
///
/// 为什么非要摘：`VACUUM` 内部会写 `PRAGMA auto_vacuum`（重建库时保留/转换自动回收模式），
/// 而本模块把 `auto_vacuum` 的**写**一律拒绝（那是给"渲染侧不得改变引擎落盘语义"设的边界）。
/// 于是不摘的话，VACUUM 会以 `authorization denied（该能力尚未实现（迁移期））` 失败 ——
/// 一个完全指不到原因的错误（第 92 波 `data_version` 那次是同一类教训：
/// 引擎自己的内部操作被自己的边界挡住，报出来的却是"能力未实现"）。
///
/// 调用方必须**立刻装回去**，并且只在握着连接锁、执行固定 SQL 字面量的场合使用。
pub fn uninstall(conn: &Connection) {
    let _ = conn.authorizer(None::<fn(AuthContext<'_>) -> Authorization>);
}

fn decide(ctx: &AuthContext<'_>) -> Authorization {
    match ctx.action {
            // 跨库访问 = 任意文件读取原语（`ATTACH DATABASE 'C:/…' + CREATE TABLE AS SELECT`）
            AuthAction::Attach { .. } | AuthAction::Detach { .. } => Authorization::Deny,
            AuthAction::Function { function_name } => {
                // 扩展加载会直接执行本机代码（SQLite 把 load_extension 归到 Function 授权）
                if function_name.eq_ignore_ascii_case("load_extension") {
                    Authorization::Deny
                } else {
                    Authorization::Allow
                }
            }
            AuthAction::Pragma {
                pragma_name,
                pragma_value,
            } => {
                // 注意：`PRAGMA journal_mode;`（读）的 pragma_value 是 None，
                // 而 `PRAGMA journal_mode=WAL;`（写）是 Some("WAL") —— 判据就在这里。
                if pragma_denied(pragma_name, pragma_value.is_none()) {
                    Authorization::Deny
                } else {
                    Authorization::Allow
                }
            }
            _ => Authorization::Allow,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn engine_pragma_is_readable_but_not_writable() {
        assert!(!pragma_denied("journal_mode", true), "健康检查需要读 journal_mode");
        assert!(pragma_denied("journal_mode", false), "不得允许改成非 WAL");
        assert!(pragma_denied("synchronous", false), "不得允许关掉同步（崩溃安全的前提）");
        assert!(pragma_denied("foreign_keys", false), "不得允许关掉外键");
        assert!(!pragma_denied("page_count", true), "page_count 只是诊断读数");
    }

    #[test]
    fn dangerous_pragma_is_denied_in_both_forms() {
        for p in FULLY_DENIED_PRAGMAS {
            assert!(pragma_denied(p, true), "{p} 读也应拒绝");
            assert!(pragma_denied(p, false), "{p} 写也应拒绝");
        }
    }

    #[test]
    fn internal_probe_pragmas_stay_readable() {
        // 这些是 SQLite 内部/诊断探针：拒绝会破坏语句准备（见 FULLY_DENIED_PRAGMAS 的教训注释）
        for p in ["data_version", "integrity_check", "quick_check", "page_count", "freelist_count"] {
            assert!(!pragma_denied(p, true), "{p} 的读形态必须放行");
        }
        assert!(pragma_denied("writable_schema", true), "writable_schema 读也应拒绝");
    }

    #[test]
    fn unknown_pragma_is_allowed() {
        assert!(!pragma_denied("table_info", true));
        assert!(!pragma_denied("table_info", false));
    }
}
