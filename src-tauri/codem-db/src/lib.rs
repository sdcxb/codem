//! `codem-db` —— Codem 存储引擎（Rust 原生 SQLite）
//!
//! 目的（见 `docs/ARCH-SQLITE-TO-RUST.md`）：把 SQLite 从渲染进程的 WASM 堆里搬出来，
//! 让持久化变成 **WAL 页级增量**、让错误变成 **可处理的值**、让渲染进程**不再持有整个语料**。
//!
//! 三层职责：
//! - `engine`：连接/PRAGMA/单写者事务/健康检查/checkpoint（没有整库导出）
//! - `schema`：schema 与迁移（真源仍是渲染侧 TS，由脚本生成，`check-schema-parity` 守住）
//! - `repo`：渲染侧唯一的访问面（类型化仓储命令；不接受 SQL 片段）
//!
//! Tauri 命令层（`src-tauri`）只是薄封装：解码参数 → 调 `dispatch` → 编码结果。

pub mod authorizer;
pub mod engine;
pub mod error;
pub mod migrate;
pub mod repo;
pub mod schema;

pub use engine::{Engine, Health, Integrity, MAX_BYTES_PER_QUERY, MAX_ROWS_PER_QUERY};
pub use error::{DbError, DbResult, ErrorCode};

use serde_json::{json, Value};

/// 命令清单（用于 `commands` 子命令自省与契约测试覆盖检查）
pub const COMMANDS: &[&str] = &[
    "settings.get_all",
    "settings.set",
    "settings.remove",
    "events.append",
    "telemetry.append",
    "telemetry.prune",
    "messages.create",
    "messages.create_many",
    "messages.update",
    "messages.update_many",
    "messages.get",
    "messages.list",
    "messages.delete",
    "messages.count",
    "sessions.upsert",
    "sessions.list",
    "projects.upsert",
    "projects.list",
    "counts",
    "health",
    "integrity_check",
    "checkpoint",
    // ===== P4 迁移原语（受控的结构化通道，非裸 SQL）=====
    "import.begin",
    "import.table",
    "import.end",
    "import.rollback",
    "import.tables",
    "migration.status",
    "migration.mark",
    "digest.tables",
    "digest.rows",
    "rebuild_fts",
];

/// 统一入口：命令名 + 结构化参数 → JSON 结果。
///
/// **不接受 SQL 字符串**（安全边界：仓储命令白名单之外一律 `UNSUPPORTED`）。
pub fn dispatch(engine: &Engine, command: &str, params: &Value) -> DbResult<Value> {
    match command {
        "settings.get_all" => repo::settings_get_all(engine),
        "settings.set" => repo::settings_set(engine, params),
        "settings.remove" => repo::settings_remove(engine, params),
        "events.append" => repo::events_append(engine, params),
        "telemetry.append" => repo::telemetry_append(engine, params),
        "telemetry.prune" => repo::telemetry_prune(engine, params),
        "messages.create" => repo::messages_create(engine, params),
        "messages.create_many" => repo::messages_create_many(engine, params),
        "messages.update" => repo::messages_update(engine, params),
        "messages.update_many" => repo::messages_update_many(engine, params),
        "messages.get" => repo::messages_get(engine, params),
        "messages.list" => repo::messages_list(engine, params),
        "messages.delete" => repo::messages_delete(engine, params),
        "messages.count" => repo::messages_count(engine, params),
        "sessions.upsert" => repo::sessions_upsert(engine, params),
        "sessions.list" => repo::sessions_list(engine, params),
        "projects.upsert" => repo::projects_upsert(engine, params),
        "projects.list" => repo::projects_list(engine, params),
        "counts" => repo::counts_of(engine, params),
        "health" => serde_json::to_value(engine.health()?).map_err(|e| DbError::other(e.to_string())),
        "integrity_check" => {
            serde_json::to_value(engine.integrity_check()?).map_err(|e| DbError::other(e.to_string()))
        }
        "checkpoint" => {
            engine.checkpoint()?;
            Ok(json!({ "ok": true }))
        }
        // ===== P4 迁移原语 =====
        "import.begin" => migrate::import_begin(engine, params),
        "import.table" => migrate::import_table(engine, params),
        "import.end" => migrate::import_end(engine, params),
        "import.rollback" => migrate::import_rollback(engine, params),
        "import.tables" => migrate::importable_existing(engine, params),
        "migration.status" => migrate::migration_status(engine, params),
        "migration.mark" => migrate::mark_migrated(engine, params),
        "digest.tables" => migrate::table_digest(engine, params),
        "digest.rows" => migrate::digest_rows(params),
        "rebuild_fts" => migrate::rebuild_fts(engine, params),
        other => Err(DbError::unsupported(format!(
            "未实现的仓储命令：{other}（迁移按 docs/ARCH-SQLITE-TO-RUST.md 的 P3 顺序补齐）"
        ))),
    }
}

/// 命令清单 + 当前实现（自省）
pub fn capabilities() -> Value {
    json!({
        "engine": "rust",
        "commands": COMMANDS,
        "max_rows_per_query": MAX_ROWS_PER_QUERY,
        "max_bytes_per_query": MAX_BYTES_PER_QUERY,
        "no_whole_file_export": true,
        "migration_primitives": {
            "note": "import.table 是受控的结构化通道：表名走白名单、列名与真实列定义逐字核对、值参数化绑定，不接受任何 SQL 片段",
            "tables": migrate::importable_tables().len(),
            "fts_shadow_excluded": true,
        },
    })
}
