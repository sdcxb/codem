//! 删除审计（第 31 轮事故排查用，**长期保留**）
//!
//! ## 为什么需要它
//!
//! 真机事故：迁移对账通过、标记已写之后，新库的 `messages / sessions / session_events /
//! tool_calls` 变回 0，而**渲染进程的存储端口三层（`data.execute` / `data.write` /
//! `data.command`）审计缓冲里没有任何删除**。也就是说：存在一条**绕过渲染侧端口**
//! 的删除路径，而当时没有任何办法事后知道是谁删的。
//!
//! 排查这类问题的正确姿势不是"再猜一遍代码"，而是**让数据库自己记账**：
//! 在目标表上装 `AFTER DELETE` / `AFTER UPDATE` 触发器，把每一次行的消失/隐藏
//! 记进一张只增的审计表。
//!
//! ## 为什么触发器是对的工具
//!
//! - **层级无关**：触发器在 SQLite 内部执行，无论删除来自端口命令、CLI、
//!   还是将来某个直接开连接的代码路径，都会留下记录 —— 这正是"绕过端口"那类问题需要的视角；
//! - **不可被上层遗忘**：不需要每个删除点自觉调用记录函数（那种做法必然有人漏）；
//! - **写库的人绕不过**：除非显式 `DROP TRIGGER`，而本模块每次打开库都会重新安装（幂等）。
//!
//! ## 记什么
//!
//! 只记"行没了"这件事本身与其身份，**不记正文**（审计表不该成为第二份用户语料）：
//! 时间、表名、操作、主键、会话 id。这样即使一次删掉 821 行，也只是 821 条小记录 ——
//! 排查完清掉即可。

use crate::error::{DbError, DbResult};
use rusqlite::Connection;
use serde::Serialize;

/// 被审计的表（这些表的整表清空是本轮事故的形态）
///
/// 每项 `(表名, 主键表达式, 会话列表达式)` —— 会话列用于把删除归因到某个会话。
///
/// ⚠️ **第 12 轮新增 `projects`**：真机审计显示"`sessions` 被删 + messages/tool_calls/
/// session_events 跟着消失"，而这三张表都是 `sessions` 的子表 —— `sessions` 又通过
/// `project_id` 挂在 `projects` 上（schema 里是 `ON DELETE CASCADE`）。
/// 也就是说：**删一个项目行会让该项目的全部会话与消息级联消失**，而审计只看得见
/// 子表的删除、看不见"是谁触发的"。加上这张表的触发器，"级联的源头"才会留下痕迹。
const AUDITED: &[(&str, &str, &str)] = &[
    ("messages", "OLD.id", "OLD.session_id"),
    ("sessions", "OLD.id", "OLD.id"),
    ("session_events", "OLD.seq", "OLD.session_id"),
    ("tool_calls", "OLD.id", "OLD.message_id"),
    ("projects", "OLD.id", "OLD.id"),
    ("notebooks", "OLD.id", "OLD.id"),
];

/// 审计表名
pub const AUDIT_TABLE: &str = "storage_audit";

#[derive(Debug, Clone, Serialize)]
pub struct AuditRow {
    pub at: i64,
    pub table_name: String,
    pub op: String,
    pub row_count: i64,
    pub key_sample: String,
}

/// 建审计表（幂等）
pub fn ensure_table(conn: &Connection) -> DbResult<()> {
    conn.execute_batch(&format!(
        "CREATE TABLE IF NOT EXISTS {AUDIT_TABLE} (
             id INTEGER PRIMARY KEY AUTOINCREMENT,
             at INTEGER NOT NULL,
             table_name TEXT NOT NULL,
             op TEXT NOT NULL,
             row_count INTEGER NOT NULL,
             key_sample TEXT,
             session_id TEXT
         );
         CREATE INDEX IF NOT EXISTS idx_{AUDIT_TABLE}_at ON {AUDIT_TABLE}(at);"
    ))
    .map_err(DbError::from)
}

/// 安装触发器（幂等：每次打开库都重建，防止有人 DROP 后忘记装回来）
///
/// ## 为什么按"语句"聚合而不是每行一条
///
/// `DELETE FROM messages WHERE session_id = ?` 会逐行触发 `AFTER DELETE`。每行一条记录
/// 在"整表清空"时会写下几十万行，反而把库撑大、还可能撞上磁盘配额。
/// 这里用 `row_count` 累加：**按 (表, 操作, 会话) 归组**，一次删除只留一条记录，
/// 记录里带 `row_count`。排查要的信息（哪张表、多少次、哪个会话、什么时候）全都在。
pub fn install(conn: &Connection) -> DbResult<()> {
    ensure_table(conn)?;
    for (table, key_expr, session_expr) in AUDITED {
        // 表不存在就跳过（老库/裁剪过的库可能没有某张表）
        let exists: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                [table],
                |r| r.get(0),
            )
            .map_err(DbError::from)?;
        if exists == 0 {
            continue;
        }

        for (suffix, op, trigger_body) in [
            ("del", "DELETE", "AFTER DELETE"),
            // 隐藏（`hidden = 1`）是"软删除"，压缩/裁剪走这条路；同样要能看见
            ("hide", "HIDE", "AFTER UPDATE"),
        ] {
            let name = format!("trg_{table}_{suffix}");
            let extra = if op == "HIDE" {
                // 只在"从可见变隐藏"时记录，避免每次无关 UPDATE 都写审计
                " AND OLD.hidden = 0 AND NEW.hidden = 1"
            } else {
                ""
            };
            let has_hidden = if op == "HIDE" {
                column_exists(conn, table, "hidden")?
            } else {
                false
            };
            if op == "HIDE" && !has_hidden {
                continue;
            }

            let when = if extra.is_empty() {
                String::new()
            } else {
                // `extra` 是" AND …"形态的补充条件，WHEN 子句里要去掉前导 AND
                format!("WHEN {}", extra.trim_start_matches(" AND "))
            };
            /*
             * 时间戳用 `strftime('%s','now')*1000`（秒 → 毫秒）。
             *
             * 刻意不用 `substr(strftime('%f','now'),4,3)` 拼毫秒：那在触发器里依赖
             * 字符串函数的细节，而审计只要"能排序、能对上大致时刻"，秒级足够且更稳。
             */
            let sql = format!(
                "CREATE TRIGGER IF NOT EXISTS {name} {trigger_body} ON {table} {when}
                 BEGIN
                     INSERT INTO {AUDIT_TABLE} (at, table_name, op, row_count, key_sample, session_id)
                     VALUES (
                         CAST(strftime('%s','now') AS INTEGER) * 1000,
                         '{table}', '{op}', 1, CAST({key_expr} AS TEXT), CAST({session_expr} AS TEXT)
                     );
                 END;"
            );
            conn.execute_batch(&sql).map_err(DbError::from)?;
        }
    }
    Ok(())
}

fn column_exists(conn: &Connection, table: &str, column: &str) -> DbResult<bool> {
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info(\"{table}\")"))
        .map_err(DbError::from)?;
    let mut rows = stmt.query([]).map_err(DbError::from)?;
    while let Some(r) = rows.next().map_err(DbError::from)? {
        let name: String = r.get(1).map_err(DbError::from)?;
        if name == column {
            return Ok(true);
        }
    }
    Ok(false)
}

/// 读最近若干条审计（按时间倒序）
pub fn recent(conn: &Connection, limit: usize) -> DbResult<Vec<AuditRow>> {
    ensure_table(conn)?;
    let mut stmt = conn
        .prepare(&format!(
            "SELECT at, table_name, op, row_count, key_sample, session_id
             FROM {AUDIT_TABLE} ORDER BY id DESC LIMIT ?1"
        ))
        .map_err(DbError::from)?;
    let mut rows = stmt.query([limit as i64]).map_err(DbError::from)?;
    let mut out = Vec::new();
    while let Some(r) = rows.next().map_err(DbError::from)? {
        let session: Option<String> = r.get(5).map_err(DbError::from)?;
        out.push(AuditRow {
            at: r.get(0).map_err(DbError::from)?,
            table_name: r.get(1).map_err(DbError::from)?,
            op: r.get(2).map_err(DbError::from)?,
            row_count: r.get(3).map_err(DbError::from)?,
            key_sample: format!(
                "{}{}",
                r.get::<_, Option<String>>(4).map_err(DbError::from)?.unwrap_or_default(),
                session.map(|s| format!(" session={s}")).unwrap_or_default()
            ),
        });
    }
    Ok(out)
}

/// 按表聚合的审计摘要（"哪张表被删得最多"）
pub fn summary(conn: &Connection) -> DbResult<Vec<(String, String, i64)>> {
    ensure_table(conn)?;
    let mut stmt = conn
        .prepare(&format!(
            "SELECT table_name, op, COUNT(*) FROM {AUDIT_TABLE} GROUP BY table_name, op ORDER BY 3 DESC"
        ))
        .map_err(DbError::from)?;
    let mut rows = stmt.query([]).map_err(DbError::from)?;
    let mut out = Vec::new();
    while let Some(r) = rows.next().map_err(DbError::from)? {
        out.push((
            r.get(0).map_err(DbError::from)?,
            r.get(1).map_err(DbError::from)?,
            r.get(2).map_err(DbError::from)?,
        ));
    }
    Ok(out)
}

/// 清空审计（排查完成后收尾）
pub fn clear(conn: &Connection) -> DbResult<usize> {
    ensure_table(conn)?;
    conn.execute(&format!("DELETE FROM {AUDIT_TABLE}"), [])
        .map_err(DbError::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 建一个"和真实库一样"的内存库：schema + 迁移（`hidden` 列来自迁移，不在 base schema 里）
    fn fresh() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(crate::schema::SCHEMA_SQL).unwrap();
        let migrations: Vec<String> =
            serde_json::from_str(crate::schema::MIGRATIONS_JSON).unwrap();
        for sql in &migrations {
            let _ = conn.execute_batch(sql);
        }
        conn
    }

    #[test]
    fn delete_is_recorded_with_table_and_count() {
        let conn = fresh();
        install(&conn).unwrap();
        conn.execute(
            "INSERT INTO projects (id,name,path,created_at,last_accessed_at) VALUES ('p','P','',1,1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sessions (id, project_id, title, created_at, last_message_at, message_count) \
             VALUES ('s1','p','t',1,1,0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO messages (id, session_id, role, content, timestamp) VALUES ('m1','s1','user','hi',1)",
            [],
        )
        .unwrap();
        assert_eq!(recent(&conn, 10).unwrap().len(), 0, "插入不该产生审计");

        conn.execute("DELETE FROM messages WHERE id = 'm1'", []).unwrap();
        let rows = recent(&conn, 10).unwrap();
        assert_eq!(rows.len(), 1, "删除必须被记账");
        assert_eq!(rows[0].table_name, "messages");
        assert_eq!(rows[0].op, "DELETE");
        assert_eq!(rows[0].row_count, 1);
        assert!(rows[0].key_sample.contains("m1"), "要能看出删的是哪一行");
    }

    #[test]
    fn mass_delete_is_recorded_per_row_but_aggregatable() {
        let conn = fresh();
        install(&conn).unwrap();
        conn.execute(
            "INSERT INTO projects (id,name,path,created_at,last_accessed_at) VALUES ('p','P','',1,1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sessions (id, project_id, title, created_at, last_message_at, message_count) \
             VALUES ('s1','p','t',1,1,0)",
            [],
        )
        .unwrap();
        for i in 0..50 {
            conn.execute(
                "INSERT INTO messages (id, session_id, role, content, timestamp) VALUES (?1,'s1','user','x',1)",
                [format!("m{i}")],
            )
            .unwrap();
        }
        conn.execute("DELETE FROM messages WHERE session_id = 's1'", []).unwrap();
        let sum = summary(&conn).unwrap();
        assert_eq!(sum.len(), 1);
        assert_eq!(sum[0].0, "messages");
        assert_eq!(sum[0].2, 50, "整表清空必须留下 50 条可聚合的记录");
    }

    #[test]
    fn install_is_idempotent() {
        let conn = fresh();
        install(&conn).unwrap();
        install(&conn).unwrap();
        install(&conn).unwrap();
        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND name LIKE 'trg_%'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(n > 0);
        // 幂等：重复安装不会让一次删除记多条
        conn.execute(
            "INSERT INTO projects (id,name,path,created_at,last_accessed_at) VALUES ('p','P','',1,1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sessions (id, project_id, title, created_at, last_message_at, message_count) \
             VALUES ('s1','p','t',1,1,0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO messages (id, session_id, role, content, timestamp) VALUES ('m1','s1','user','hi',1)",
            [],
        )
        .unwrap();
        conn.execute("DELETE FROM messages WHERE id='m1'", []).unwrap();
        assert_eq!(recent(&conn, 10).unwrap().len(), 1);
    }

    #[test]
    fn soft_delete_is_recorded() {
        let conn = fresh();
        install(&conn).unwrap();
        conn.execute(
            "INSERT INTO projects (id,name,path,created_at,last_accessed_at) VALUES ('p','P','',1,1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO sessions (id, project_id, title, created_at, last_message_at, message_count) \
             VALUES ('s1','p','t',1,1,0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO messages (id, session_id, role, content, timestamp, hidden) VALUES ('m1','s1','user','hi',1,0)",
            [],
        )
        .unwrap();
        conn.execute("UPDATE messages SET hidden = 1 WHERE id='m1'", []).unwrap();
        let rows = recent(&conn, 10).unwrap();
        assert_eq!(rows.len(), 1, "软删除（隐藏）也要记账");
        assert_eq!(rows[0].op, "HIDE");
    }
}
