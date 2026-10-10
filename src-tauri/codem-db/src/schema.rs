//! schema 与迁移（真源仍是渲染侧 TS，这里由 `tools/audit/gen-schema-sql.mjs` 生成）
//!
//! - `sql/schema.sql`：39 张表的建表语句（`execute_batch` 一次执行，与 sql.js 的 `db.run(SCHEMA)` 等价）
//! - `sql/migrations.json`：29 条 `ALTER TABLE`（逐条执行并**容忍"列已存在"**，与渲染侧行为一致）
//! - `sql/fts.json`：会话全文检索表的列定义（`session_fts`）
//!
//! FTS 模块选择：老库里 `session_fts` 是 **FTS4**（sql.js 不支持 FTS5）。Rust bundled SQLite 两者都有，
//! 因此这里**不重建**已有表（`IF NOT EXISTS`），只在库里没有该表时按 FTS5 创建；
//! `MATCH` 语法两边通用，迁移期不会打断搜索。表结构差异由 `fts_module()` 暴露给诊断。

use crate::error::{DbError, DbResult};
use rusqlite::Connection;

pub const SCHEMA_SQL: &str = include_str!("../sql/schema.sql");
pub const MIGRATIONS_JSON: &str = include_str!("../sql/migrations.json");
const FTS_JSON: &str = include_str!("../sql/fts.json");

#[derive(Debug, Clone, serde::Serialize)]
pub struct SchemaReport {
    /// 本次新建的库（不是已有库）
    pub fresh: bool,
    /// 已经存在（执行前已能查到表）
    pub pre_existing_tables: usize,
    /// 执行后拥有的表数
    pub tables: usize,
    /// 迁移语句条数
    pub migrations: usize,
    /// 迁移中被忽略的条数（"列已存在"属正常）
    pub migrations_ignored: usize,
    /// 会话全文检索表使用的模块（fts4 / fts5 / none）
    pub fts_module: String,
    /// 本次打开**回填**了 `last_message_at` 的会话行数（GAP-LIST `O-57`，见 `backfill_last_message_at`）
    pub sessions_backfilled: usize,
}

/// 库里的表/视图数量（不含 SQLite 内部表与 FTS 影子表之外的内建项）。
///
/// **公开**是刻意的：`Engine::open` 里 `audit::install` 会在 `schema::apply`
/// 之后再加一张 `storage_audit` 表，报表必须在全部步骤结束后重新取一次数，
/// 否则"全新库第一次打开"与"第二次打开"报出的表数会差 1（诊断数字漂移）。
pub fn table_count(conn: &Connection) -> DbResult<usize> {
    let n: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%'",
            [],
            |r| r.get(0),
        )
        .map_err(DbError::from)?;
    Ok(n as usize)
}

/// 当前 `session_fts` 使用的模块（诊断 + 迁移期只读判断）
pub fn fts_module(conn: &Connection) -> DbResult<String> {
    let sql: Option<String> = conn
        .query_row(
            "SELECT sql FROM sqlite_master WHERE name = 'session_fts'",
            [],
            |r| r.get(0),
        )
        .ok();
    Ok(match sql {
        None => "none".to_string(),
        Some(s) => {
            let low = s.to_lowercase();
            if low.contains("fts5") {
                "fts5".to_string()
            } else if low.contains("fts4") {
                "fts4".to_string()
            } else {
                "unknown".to_string()
            }
        }
    })
}

/// 应用 schema + 迁移（幂等；与渲染侧 `initDatabase()` 的 schema 部分等价）
pub fn apply(conn: &Connection) -> DbResult<SchemaReport> {
    let pre_existing_tables = table_count(conn)?;
    let fresh = pre_existing_tables == 0;

    conn.execute_batch(SCHEMA_SQL).map_err(DbError::from)?;

    // FTS：只在缺失时创建（迁移期不动老库的 FTS4 表）
    let fts_before = fts_module(conn)?;
    if fts_before == "none" {
        let cols: serde_json::Value =
            serde_json::from_str(FTS_JSON).map_err(|e| DbError::other(format!("fts.json 解析失败：{e}")))?;
        let columns = cols
            .get("columns")
            .and_then(|v| v.as_str())
            .ok_or_else(|| DbError::other("fts.json 缺少 columns"))?;
        // FTS5 的 UNINDEXED 与 FTS4 语法兼容；tokenize 也要用 fts5 的写法
        let ddl = format!(
            "CREATE VIRTUAL TABLE IF NOT EXISTS session_fts USING fts5({});",
            columns.replace("tokenize=unicode61", "tokenize='unicode61'")
        );
        conn.execute_batch(&ddl).map_err(DbError::from)?;
    }

    // 迁移：逐条执行，容忍"列已存在"（与渲染侧的 try/catch 等价）
    let migrations: Vec<String> = serde_json::from_str(MIGRATIONS_JSON)
        .map_err(|e| DbError::other(format!("migrations.json 解析失败：{e}")))?;
    let mut ignored = 0usize;
    for sql in &migrations {
        if let Err(e) = conn.execute_batch(sql) {
            let msg = e.to_string().to_lowercase();
            if msg.contains("duplicate column name") || msg.contains("already exists") {
                ignored += 1;
            } else {
                return Err(DbError::from(e));
            }
        }
    }

    // 与渲染侧一致：种下全局项目行（project_id="" 供全局会话满足外键）
    conn.execute(
        "INSERT OR IGNORE INTO projects (id, name, path, description, pinned, created_at, last_accessed_at) \
         VALUES (?1, ?2, ?3, ?4, 0, ?5, ?5)",
        rusqlite::params![
            "",
            "全局对话",
            "",
            "Global chat (no project context)",
            now_ms()
        ],
    )
    .map_err(DbError::from)?;

    // 存量库的会话活动时间回填（GAP-LIST `O-57`）—— 必须在**任何读者**拿到这个库之前做完
    let sessions_backfilled = backfill_last_message_at(conn)?;
    if sessions_backfilled > 0 {
        /*
         * 打一行 stderr：这条回填是"用户看得见的排序被修正"的**唯一现场记录**
         * （真机排障时 `codem-runtime-*.log` 只收 Rust 侧输出）。
         * 数字必须打出来 —— "回填跑了但什么都没做"与"回填根本没跑"要分得开。
         */
        eprintln!(
            "[schema] 会话活动时间回填：{sessions_backfilled} 个会话的 last_message_at 陈旧（已按 MAX(messages.timestamp) 修正）"
        );
    }

    Ok(SchemaReport {
        fresh,
        pre_existing_tables,
        tables: table_count(conn)?,
        migrations: migrations.len(),
        migrations_ignored: ignored,
        fts_module: fts_module(conn)?,
        sessions_backfilled,
    })
}

/// **存量库一次性回填** `sessions.last_message_at = MAX(messages.timestamp)`（GAP-LIST `O-57`）。
///
/// ## 为什么需要它（而不是"引擎以后会写对"）
///
/// 2026-10-10 的真机副本库对账：**561 个会话里 516 个**的 `last_message_at` 停在
/// "第一次发送那一刻"（`lma == MAX(messages.timestamp)` 只有 12 个成立）——
/// 侧栏按这一列倒序，于是"昨天建的会话今天又聊了"永远排在「更早」组里。
/// 引擎侧的写入（`repo.rs::touch_session_on_message_write`）只修**以后**的消息；
/// 已经躺在库里的那些陈旧值不会自己变新，所以这里补一次。
///
/// ## 为什么放在 `schema::apply`（而不是渲染侧的启动维护）
///
/// 侧栏在启动后**立刻**就会读这一列（`session.list` → `listSessions`），
/// 而渲染侧的维护要过"空闲闸"（不许与第一个回合抢线程），可能几秒到几十秒之后才跑 ——
/// 那意味着"重启之后侧栏顺序仍然错"。放在引擎打开时（任何读者之前）才是确定的。
///
/// ## 为什么"只改确实陈旧的"（`WHERE` 里的存在性判断）
///
/// `last_message_at` 的语义是**只增不减**（见 `touch_session_on_message_write`）。
/// 无条件 `SET last_message_at = MAX(...)` 会把"比最后一条消息更新"的行
/// 往回**拉**（例如用户刚改过名、或某条消息被删掉之后），那是**回退**，
/// 与那一列的单调语义矛盾。所以只抬不降：只处理 `MAX(ts) > 当前值` 的行。
///
/// 代价：这一趟是"每个会话一次带索引的最大值查找"（`idx_messages_session_ts`），
/// 561 个会话量级是毫秒级；而它**幂等**（第二趟开始 `WHERE` 一行都不命中），
/// 所以不需要额外的"做过没有"标记 —— 标记反而会引入"标记写了但没做"的第二种真相。
pub fn backfill_last_message_at(conn: &Connection) -> DbResult<usize> {
    let changed = conn
        .execute(
            "UPDATE sessions \
                SET last_message_at = (\
                      SELECT MAX(m.timestamp) FROM messages m WHERE m.session_id = sessions.id\
                    ) \
              WHERE EXISTS (\
                      SELECT 1 FROM messages m \
                       WHERE m.session_id = sessions.id \
                         AND m.timestamp > COALESCE(sessions.last_message_at, 0)\
                    )",
            [],
        )
        .map_err(DbError::from)?;
    Ok(changed)
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
