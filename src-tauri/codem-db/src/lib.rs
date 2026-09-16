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

pub mod audit;
pub mod authorizer;
pub mod config;
pub mod crud;
pub mod engine;
pub mod fts;
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
    "events.append_batch",
    "events.list",
    "events.count",
    "events.watermark",
    "events.delete_session",
    "events.compact",
    "events.fork",
    "telemetry.append",
    "telemetry.prune",
    "messages.create",
    "messages.create_many",
    "messages.upsert_index",
    "messages.rebuild_index",
    "messages.update",
    "messages.update_many",
    "tool_calls.replace",
    "tool_calls.list",
    "messages.get",
    "messages.list",
    "messages.delete",
    "messages.count",
    "sessions.upsert",
    "sessions.list",
    "sessions.delete",
    "projects.upsert",
    "projects.list",
    "projects.delete",
    "counts",
    "audit.recent",
    "audit.summary",
    "audit.clear",
    "health",
    "integrity_check",
    "checkpoint",
    // ===== 配置面（P3 第 3 段）：小表 → 同步读内存镜像 + 写穿 =====
    "quick_phrases.save",
    "quick_phrases.list",
    "quick_phrases.delete",
    "quick_phrases.touch",
    "mcp_servers.list",
    "mcp_servers.save",
    "mcp_servers.remove",
    "memory.get",
    "memory.set",
    "config_warmup",
    // ===== 通用仓储命令（P3 第 10 段：表定义驱动，覆盖剩余域）=====
    "crud.list",
    "crud.upsert",
    "crud.delete",
    "crud.count",
    // ===== 数据面补充（P3 第 8 段）=====
    "feedback.set",
    "feedback.get",
    "feedback.delete",
    "attachments.list",
    "attachments.update",
    // ===== P4 迁移原语（受控的结构化通道，非裸 SQL）=====
    "import.begin",
    "import.table",
    "import.end",
    "import.rollback",
    "import.tables",
    "migration.status",
    "migration.mark",
    "migration.auto",
    "digest.tables",
    "digest.rows",
    "rebuild_fts",
    "fts.rebuild",
    "fts.rebuild_all",
    "fts.delete_session",
    "fts.search",
];

/// 统一入口：命令名 + 结构化参数 → JSON 结果。
///
/// **不接受 SQL 字符串**（安全边界：仓储命令白名单之外一律 `UNSUPPORTED`）。
pub fn dispatch(engine: &Engine, command: &str, params: &Value) -> DbResult<Value> {
    /*
     * 破坏性命令的**执行点**留痕（第 36 轮，长期保留）。
     *
     * 为什么装在这里：真机排查已经把渲染侧 JS **全部插过桩**并逐一排除
     * （端口三层 / domain-store 五个写穿点 / write-audit / RustDataPort /
     * tauriTransport 最终出口 —— 全部 0 命中，且仪器有效性经过验证）。
     * 剩下的唯一未插桩执行点就是这里：`dispatch` 是**所有仓储命令的落地处**，
     * 无论调用来自 Tauri 命令、CLI、还是任何直接持有 Engine 的代码，
     * 都会经过这一行 —— 所以它能区分"JS 发的"与"进程内别处发的"。
     *
     * 打印到 stderr（CLI 与 Tauri 都会随进程输出可见），
     * 带上调用线程与命令名/参数摘要（不打印正文）。
     */
    if command.contains("delete") || command.contains("replace") || command.contains("compact") {
        eprintln!(
            "[RustTrace] dispatch {command} params={}",
            serde_json::to_string(params).unwrap_or_default()
        );
        let bt = std::backtrace::Backtrace::force_capture();
        eprintln!("[RustTrace] backtrace:\n{bt}");
    }
    match command {
        "settings.get_all" => repo::settings_get_all(engine),
        "settings.set" => repo::settings_set(engine, params),
        "settings.remove" => repo::settings_remove(engine, params),
        "events.append" => repo::events_append(engine, params),
        "events.append_batch" => repo::events_append_batch(engine, params),
        "events.list" => repo::events_list(engine, params),
        "events.count" => repo::events_count(engine, params),
        "events.watermark" => repo::events_watermark(engine, params),
        "events.delete_session" => repo::events_delete_session(engine, params),
        "events.compact" => repo::events_compact(engine, params),
        "events.fork" => repo::events_fork(engine, params),
        "telemetry.append" => repo::telemetry_append(engine, params),
        "telemetry.prune" => repo::telemetry_prune(engine, params),
        "messages.create" => repo::messages_create(engine, params),
        "messages.create_many" => repo::messages_create_many(engine, params),
        "messages.upsert_index" => repo::messages_upsert_index(engine, params),
    "messages.rebuild_index" => repo::messages_rebuild_index(engine, params),
        "tool_calls.replace" => repo::tool_calls_replace(engine, params),
        "tool_calls.list" => repo::tool_calls_list(engine, params),
        "messages.update" => repo::messages_update(engine, params),
        "messages.update_many" => repo::messages_update_many(engine, params),
        "messages.get" => repo::messages_get(engine, params),
        "messages.list" => repo::messages_list(engine, params),
        "messages.delete" => repo::messages_delete(engine, params),
        "messages.count" => repo::messages_count(engine, params),
        "sessions.upsert" => repo::sessions_upsert(engine, params),
        "sessions.list" => repo::sessions_list(engine, params),
        "sessions.delete" => repo::sessions_delete(engine, params),
        "projects.upsert" => repo::projects_upsert(engine, params),
        "audit.recent" => audit_recent(engine, params),
        "audit.summary" => audit_summary(engine, params),
        "audit.clear" => audit_clear(engine, params),
        "projects.list" => repo::projects_list(engine, params),
        "projects.delete" => repo::projects_delete(engine, params),
        "counts" => repo::counts_of(engine, params),
        // ===== 配置面（P3 第 3 段）=====
        "quick_phrases.save" => config::quick_phrases_save(engine, params),
        "quick_phrases.list" => config::quick_phrases_list(engine, params),
        "quick_phrases.delete" => config::quick_phrases_delete(engine, params),
        "quick_phrases.touch" => config::quick_phrases_touch(engine, params),
        "mcp_servers.list" => config::mcp_servers_list(engine, params),
        "mcp_servers.save" => config::mcp_servers_save(engine, params),
        "mcp_servers.remove" => config::mcp_servers_remove(engine, params),
        "memory.get" => config::memory_get(engine, params),
        "memory.set" => config::memory_set(engine, params),
        "config_warmup" => config::config_warmup(engine, params),
        // ===== 通用仓储命令（P3 第 10 段）=====
        "crud.list" => crud::crud_list(engine, params),
        "crud.upsert" => crud::crud_upsert(engine, params),
        "crud.delete" => crud::crud_delete(engine, params),
        "crud.count" => crud::crud_count(engine, params),
        // ===== 数据面补充（P3 第 8 段）=====
        "feedback.set" => config::feedback_set(engine, params),
        "feedback.get" => config::feedback_get(engine, params),
        "feedback.delete" => config::feedback_delete(engine, params),
        "attachments.list" => config::attachments_list(engine, params),
        "attachments.update" => config::attachments_update(engine, params),
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
    "migration.auto" => migrate::auto_migrate(engine, params),
        "digest.tables" => migrate::table_digest(engine, params),
        "digest.rows" => migrate::digest_rows(params),
        "rebuild_fts" => migrate::rebuild_fts(engine, params),
        "fts.rebuild" => migrate::fts_rebuild(engine, params),
    "fts.rebuild_all" => migrate::fts_rebuild_all(engine, params),
        "fts.delete_session" => migrate::fts_delete_session(engine, params),
        "fts.search" => migrate::fts_search(engine, params),
        other => Err(DbError::unsupported(format!(
            "未实现的仓储命令：{other}（迁移按 docs/ARCH-SQLITE-TO-RUST.md 的 P3 顺序补齐）"
        ))),
    }
}

// ===== 删除审计（第 31 轮事故排查：让数据库自己记账，见 audit.rs）=====

/// 最近若干条删除/隐藏记录（默认 100）
fn audit_recent(engine: &Engine, p: &Value) -> DbResult<Value> {
    let limit = p.get("limit").and_then(|x| x.as_u64()).unwrap_or(100) as usize;
    engine.with_conn(|conn| {
        let rows = audit::recent(conn, limit)?;
        Ok(json!({ "items": rows, "limit": limit }))
    })
}

/// 按 (表, 操作) 聚合的审计摘要 —— "哪张表被删得最多"
fn audit_summary(engine: &Engine, _p: &Value) -> DbResult<Value> {
    engine.with_conn(|conn| {
        let rows = audit::summary(conn)?;
        let items: Vec<Value> = rows
            .into_iter()
            .map(|(t, op, n)| json!({ "table": t, "op": op, "records": n }))
            .collect();
        Ok(json!({ "items": items }))
    })
}

/// 清空审计（排查完成后收尾；清审计本身不写审计）
fn audit_clear(engine: &Engine, _p: &Value) -> DbResult<Value> {
    engine.with_conn(|conn| {
        let removed = audit::clear(conn)?;
        Ok(json!({ "removed": removed }))
    })
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
