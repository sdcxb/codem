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
    "audit.prune",
    "audit.stats",
    "storage.compact",
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
    // 第 72 轮审计：`feedback.set` / `feedback.get` / `feedback.delete` 已删除
    // （渲染侧零调用者 + 5 列窄写在域写之外形成第二条写路径），
    // `message_feedback` 现在只走上面的通用仓储命令 `crud.*`。
    "attachments.list",
    "attachments.update",
    "attachments.content",
    "attachments.externalized",
    // ===== P4 迁移原语（受控的结构化通道，非裸 SQL）=====
    "import.begin",
    "import.table",
    "import.end",
    "import.rollback",
    "import.tables",
    "legacy.read_table",
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
    "fts.upsert",
    "fts.remove",
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
     *
     * ⚠️ **第 44 轮：加开关，默认关闭**。这段留痕原本是**无条件**执行的，
     * 于是每一次 `*delete*` / `*replace*` / `*compact*` 都要：
     * ① 抓一次 `Backtrace::force_capture()`（要解析符号表）；② 往 stderr 写约 2.7 KB。
     * 真机基准实测：`tool_calls.replace` 中位 **56.7 ms** vs 对照 `messages.get` **27.0 ms**
     * —— **净增 29.7 ms**，而 `tool_calls.replace` 是流式响应的热路径（每次工具调用走一遍）。
     * 而且这些字节会进入打包版由安装器收集的日志，长期看是纯粹的噪音。
     *
     * 保留能力、去掉默认代价：需要时设 `CODEM_RUST_TRACE=1` 打开。
     * 排查"是谁在删数据"时它仍然是唯一能区分"JS 发的"与"进程内别处发的"的仪器，
     * 所以**不删**，只改成按需。
     */
    if std::env::var_os("CODEM_RUST_TRACE").is_some()
        && (command.contains("delete") || command.contains("replace") || command.contains("compact"))
    {
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
        "audit.prune" => audit_prune(engine, params),
        "audit.stats" => audit_stats(engine, params),
        "storage.compact" => storage_compact(engine, params),
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
        "attachments.list" => config::attachments_list(engine, params),
        "attachments.update" => config::attachments_update(engine, params),
        "attachments.content" => config::attachments_content(engine, params),
        "attachments.externalized" => config::attachments_externalized(engine, params),
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
        "legacy.read_table" => migrate::legacy_read_table(engine, params),
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
        "fts.upsert" => migrate::fts_upsert(engine, params),
        "fts.remove" => migrate::fts_remove(engine, params),
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

/// **按水位线裁剪审计**（`{ before: <毫秒时间戳> }`，必填）。
///
/// 与 `audit.clear` 的区别是**语义**而不是程度：`clear` 是"我看完了，全清"，
/// `prune` 是"保留窗口内、丢掉窗口外"。启动维护走后者 —— 于是这张表不再无界增长
/// （真机实测它一度是库内最大的表：11.8 小时 61,416 行）。
/// 缺 `before` 直接报错：删除必须有明确水位线（与 `telemetry.prune` 同一条原则）。
fn audit_prune(engine: &Engine, p: &Value) -> DbResult<Value> {
    let before = repo::req_i64(p, "before")?;
    engine.write_tx(|tx| {
        let removed = audit::prune(tx, before)?;
        let (remaining, min_at, max_at) = audit::stats(tx)?;
        Ok(json!({
            "removed": removed,
            "before": before,
            "remaining": remaining,
            "oldest": min_at,
            "newest": max_at,
        }))
    })
}

/// 审计表现状（行数 / 时间跨度）—— 维护汇总行据此如实报数
fn audit_stats(engine: &Engine, _p: &Value) -> DbResult<Value> {
    engine.with_conn(|conn| {
        let (count, min_at, max_at) = audit::stats(conn)?;
        Ok(json!({
            "count": count,
            "oldest": min_at,
            "newest": max_at,
        }))
    })
}

/// 库文件的**空间回收**（第 44 轮：真机实测 115,191,808 B 的库里活数据只有 16,392,192 B，
/// `freelist_count` = 98,799,616 B —— **85.8% 是永不回收的空闲页**，而全 crate `VACUUM` 零命中）。
///
/// ## 为什么需要一条命令而不是"打开时顺手 VACUUM"
///
/// `VACUUM` 会把整库重写一遍：需要与库等量的临时空间、在此期间占住单写者锁。
/// 对 115 MB 的库这是**秒级到十秒级**的操作，放在 `open` 里就等于"启动随机变慢"。
/// 所以做成显式命令，由渲染侧的维护流程按阈值触发（库大到值得做才做），
/// 并且**如实回报做了没有、回收了多少** —— "维护跑了但什么都没做"与"维护根本没跑"
/// 必须能区分（这是本模块维护汇总行的一贯要求）。
///
/// ## 阈值
///
/// `min_free_bytes`（默认 8 MiB）与 `min_free_ratio`（默认 0.25）**两个都要满足**才动手：
/// 小库不做（费劲又不省多少），碎片少也不做。返回里带 `performed` 与前后数字，
/// 调用方不需要猜。
///
/// `auto_vacuum=INCREMENTAL` 会在 `open` 时设置（对**新建**库立即生效；
/// 对老库，第一次 `VACUUM` 会顺便把它转成 auto_vacuum，之后 `incremental_vacuum`
/// 就能按页归还，不必再整库重写）。
fn storage_compact(engine: &Engine, p: &Value) -> DbResult<Value> {
    let min_free_bytes = p
        .get("min_free_bytes")
        .and_then(|x| x.as_i64())
        .unwrap_or(8 * 1024 * 1024);
    let min_free_ratio = p
        .get("min_free_ratio")
        .and_then(|x| x.as_f64())
        .unwrap_or(0.25);
    let force = p.get("force").and_then(|x| x.as_bool()).unwrap_or(false);

    let (page_size, page_count, freelist, auto_vacuum) = engine.with_conn(|conn| {
        let page_size: i64 = conn
            .query_row("PRAGMA page_size", [], |r| r.get(0))
            .unwrap_or(0);
        let page_count: i64 = conn
            .query_row("PRAGMA page_count", [], |r| r.get(0))
            .unwrap_or(0);
        let freelist: i64 = conn
            .query_row("PRAGMA freelist_count", [], |r| r.get(0))
            .unwrap_or(0);
        let av: i64 = conn
            .query_row("PRAGMA auto_vacuum", [], |r| r.get(0))
            .unwrap_or(0);
        Ok((page_size, page_count, freelist, av))
    })?;

    let free_bytes = freelist.saturating_mul(page_size);
    let ratio = if page_count > 0 {
        freelist as f64 / page_count as f64
    } else {
        0.0
    };
    let worth_it = force || (free_bytes >= min_free_bytes && ratio >= min_free_ratio);

    if !worth_it {
        return Ok(json!({
            "performed": false,
            "reason": "空闲页规模未达阈值（不做整库重写）",
            "page_size": page_size,
            "page_count": page_count,
            "freelist_count": freelist,
            "free_bytes": free_bytes,
            "free_ratio": ratio,
            "auto_vacuum": auto_vacuum,
            "min_free_bytes": min_free_bytes,
            "min_free_ratio": min_free_ratio,
        }));
    }

    let before_bytes = page_count.saturating_mul(page_size);
    let started = std::time::Instant::now();
    /*
     * `VACUUM` 不能在事务里执行（SQLite 明确禁止），所以走 `with_conn` 而不是 `write_tx`。
     * 单写者锁（`Mutex<Connection>`）保证 VACUUM 期间没有别的写插进来。
     *
     * ⚠️ 必须在 VACUUM 期间**临时摘掉 authorizer**：
     * `VACUUM` 内部会写 `PRAGMA auto_vacuum`（重建库时要保留/转换自动回收模式），
     * 而 `authorizer.rs` 的 `ENGINE_PRAGMAS` 把 `auto_vacuum` 的**写**一律拒绝
     * （那是给"渲染侧不得改变引擎落盘语义"设的边界）。
     * 于是不摘 authorizer 的话，VACUUM 会以
     * `[UNSUPPORTED] authorization denied（该能力尚未实现（迁移期））` 失败 ——
     * 一个完全指不到原因的错误（第 92 波 `data_version` 那次是同一类教训：
     * 引擎自己的内部操作被自己的边界挡住，报出来的却是"能力未实现"）。
     *
     * 摘掉是安全的：这里是**引擎自己的命令**、执行的是**固定 SQL 字面量**
     * （不来自参数），而且我们此刻握着连接锁、别的语句进不来。
     * 做完立刻装回来 —— 边界在这条命令之外仍然全程有效。
     */
    engine.with_conn(|conn| -> DbResult<()> {
        crate::authorizer::uninstall(conn);
        /*
         * 顺手把库转成 `auto_vacuum=INCREMENTAL`（第 44 轮）。
         *
         * 这个 pragma **只对空库立即生效**；老库上必须先设它、再 `VACUUM`，
         * 模式才会真正落进文件结构里。而这里正好就要做一次整库重写 ——
         * 于是"回收空闲页"和"开启之后按页归还的能力"一次付费同时拿到。
         * 之后 `incremental_vacuum` 就能小步归还，不必再整库重写。
         */
        let _ = conn.execute_batch("PRAGMA auto_vacuum=INCREMENTAL;");
        let out = conn.execute_batch("VACUUM").map_err(DbError::from);
        crate::authorizer::install(conn);
        out
    })?;
    let elapsed_ms = started.elapsed().as_millis() as i64;

    let (page_count_after, freelist_after, auto_vacuum_after) = engine.with_conn(|conn| {
        let pc: i64 = conn
            .query_row("PRAGMA page_count", [], |r| r.get(0))
            .unwrap_or(0);
        let fl: i64 = conn
            .query_row("PRAGMA freelist_count", [], |r| r.get(0))
            .unwrap_or(0);
        let av: i64 = conn
            .query_row("PRAGMA auto_vacuum", [], |r| r.get(0))
            .unwrap_or(0);
        Ok((pc, fl, av))
    })?;
    let after_bytes = page_count_after.saturating_mul(page_size);
    Ok(json!({
        "performed": true,
        "before_bytes": before_bytes,
        "after_bytes": after_bytes,
        "reclaimed_bytes": before_bytes.saturating_sub(after_bytes),
        "freelist_before": freelist,
        "freelist_after": freelist_after,
        "auto_vacuum_before": auto_vacuum,
        "auto_vacuum_after": auto_vacuum_after,
        "elapsed_ms": elapsed_ms,
    }))
}

/// 批量写的**错误文案**（第 45 轮 Z-7：抽成一处，两侧共用）。
///
/// ## 为什么必须共用（而不是各写一份）
///
/// 有**两条** batch 实现，各自有一条"部分成功"的错误文案：
/// - `codem-db-cli` 的 `batch` 子命令（契约测试、迁移工具走它）；
/// - `src-tauri` 的 `storage_batch`（Tauri 命令，渲染侧走它）。
///
/// 两边的注释都写着"与另一侧对齐"，但**形状已经分歧**：`storage.rs` 那份第 44 轮改成了
/// "只留命令名清单"，而 CLI 那份仍是 `format!("… 已完成 {} 步：{}", …, serde_json::to_string(&results))`
/// —— 于是一条 `messages.list` 的失败会把**几 MB 的完整结果 JSON** 塞进错误消息
/// （实测形态：界面上弹出一坨 JSON；同时进日志、进错误对象）。
/// 审计实测的 CLI 形态：
/// `{"error":{…,"message":"batch 在第 2 步失败（command=messages.create）：FOREIGN KEY constraint failed；已完成 1 步：[{\"command\":\"sessions.upsert\",\"ok\":true,\"result\":{\"id\":\"s1\",\"written\":1}}]"}}`
///
/// 这正是"同一件事写两份实现"的必然结果：改了一处，另一处看不出来。
/// 所以：**文案在这里，两侧都调它**。谁也不许再自己拼一份。
/// 返回的字符串长度与数据量无关（只含命令名），可以安全地进日志与告警。
///
/// 参数 `completed` 是**已成功步骤的命令名**（按执行顺序）；空切片表示第一步就失败。
pub fn batch_failure_message(step: usize, command: &str, cause: &str, completed: &[String]) -> String {
    let names = if completed.is_empty() {
        String::new()
    } else {
        format!("（依次为：{}）", completed.join(" → "))
    };
    format!(
        "batch 在第 {step} 步失败（command={command}）：{cause}；已完成 {} 步{names}",
        completed.len()
    )
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

#[cfg(test)]
mod batch_message_tests {
    use super::batch_failure_message;

    /// Z-7：文案**必须**只含命令名 —— 已完成的**结果体**不许再进来（那是几 MB 的噪音）。
    #[test]
    fn batch_failure_message_lists_command_names_only() {
        let done = vec!["sessions.upsert".to_string(), "messages.create".to_string()];
        let msg = batch_failure_message(
            3,
            "tool_calls.replace",
            "FOREIGN KEY constraint failed",
            &done,
        );
        assert!(msg.contains("第 3 步"), "{msg}");
        assert!(msg.contains("command=tool_calls.replace"), "{msg}");
        assert!(msg.contains("已完成 2 步"), "{msg}");
        assert!(msg.contains("sessions.upsert → messages.create"), "{msg}");
        // 结果体不在这里（没有 `{` 这类形状）—— 这正是 CLI 那份原来违反的
        assert!(!msg.contains('{'), "错误文案不得内嵌结果 JSON：{msg}");
        assert!(!msg.contains("\"result\""), "{msg}");

        // 第一步就失败：不出现"依次为"
        let first = batch_failure_message(1, "sessions.upsert", "boom", &[]);
        assert!(first.contains("已完成 0 步"), "{first}");
        assert!(!first.contains("依次为"), "{first}");
    }
}
