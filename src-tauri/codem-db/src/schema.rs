//! schema 与迁移（真源仍是渲染侧 TS，这里由 `tools/audit/gen-schema-sql.mjs` 生成）
//!
//! - `sql/schema.sql`：39 张表的建表语句（`execute_batch` 一次执行，与 sql.js 的 `db.run(SCHEMA)` 等价）
//! - `sql/migrations.json`：23 条 `ALTER TABLE`（逐条执行并**容忍"列已存在"**，与渲染侧行为一致）
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
}

fn table_count(conn: &Connection) -> DbResult<usize> {
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

    Ok(SchemaReport {
        fresh,
        pre_existing_tables,
        tables: table_count(conn)?,
        migrations: migrations.len(),
        migrations_ignored: ignored,
        fts_module: fts_module(conn)?,
    })
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
