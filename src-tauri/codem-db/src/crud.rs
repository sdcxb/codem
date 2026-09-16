//! 通用仓储命令（P3 第 10 段）：用**表定义驱动**覆盖剩余域的表。
//!
//! ## 为什么不再逐表手写
//!
//! 盘点显示还剩 87 个"表 × 操作"要覆盖，分布在 30 张表上。逐表手写的问题是：
//! - 体量大且重复（真正有语义差异的只有少数几张表）；
//! - **容易漂移**：`database.ts` 加一列，某个手写命令的列清单不会自动跟上，
//!   于是"静默丢字段"（本项目已经因为手写清单漏表吃过一次亏）。
//!
//! 所以这里做成**表定义驱动**：列清单从 `sql/tables.json`（由 TS schema 生成）
//! 与运行时 `PRAGMA table_info` 得到，命令本身只描述"做什么"。
//!
//! ## 安全性一点没有放松（与裸 SQL 的区别是结构性的）
//!
//! - **表名**：必须出现在 `tables.json` 生成的清单里（编译期常量）；
//! - **列名**：必须**逐字**出现在该表运行时的真实列定义里（`PRAGMA table_info` 核对）；
//! - **值**：一律参数化绑定，不做字符串拼接；
//! - **不接受任何 SQL 片段**：调用方只能说"在这张表里按这些条件取/写这些列",
//!   不能说"执行这条语句"；`order_by` 也只在真实列之间选择并只允许 asc/desc。
//!
//! 这套约束让通用命令与裸 SQL 有**结构性**差别，因此不违背 D 类门禁的初衷
//! （门禁禁的是"渲染侧写 SQL"，不是"少写几行 Rust"）。

use std::collections::HashSet;

use rusqlite::types::Value as SqlValue;
use rusqlite::{params_from_iter, Connection};
use serde_json::{json, Value};

use crate::engine::Engine;
use crate::error::{DbError, DbResult};
use crate::migrate::TABLE_LIST_JSON;
use crate::repo::{limit_of, offset_of, to_sql_value};

/// 允许通用操作的**业务表**清单（来自 TS schema，排除 FTS 影子表）。
///
/// 这是**编译期常量**（`tables.json` 由 `gen-schema-sql.mjs` 生成），
/// 因此调用方不可能通过表名参数访问清单之外的对象。
fn allowed_tables() -> HashSet<String> {
    let v: Value = serde_json::from_str(TABLE_LIST_JSON).expect("tables.json 解析失败");
    v.get("tables")
        .and_then(|t| t.as_array())
        .expect("tables.json 缺少 tables 数组")
        .iter()
        .filter_map(|x| x.as_str().map(|s| s.to_string()))
        .filter(|t| !t.starts_with("session_fts"))
        .collect()
}

fn assert_table(table: &str) -> DbResult<()> {
    if allowed_tables().contains(table) {
        Ok(())
    } else {
        Err(DbError::unsupported(format!(
            "表 {table} 不允许通用访问（清单来自 sql/tables.json 的业务表，FTS 影子表除外）"
        )))
    }
}

/// 该表的真实列（`PRAGMA table_info`；表名已过白名单，拼接安全）
fn real_columns(conn: &Connection, table: &str) -> DbResult<HashSet<String>> {
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info(\"{table}\")"))
        .map_err(DbError::from)?;
    let rows = stmt
        .query_map([], |r| r.get::<_, String>(1))
        .map_err(DbError::from)?;
    let mut out = HashSet::new();
    for r in rows {
        out.insert(r.map_err(DbError::from)?);
    }
    Ok(out)
}

fn check_columns(conn: &Connection, table: &str, cols: &[String]) -> DbResult<()> {
    let real = real_columns(conn, table)?;
    for c in cols {
        if !c.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '_') {
            return Err(DbError::invalid("columns", format!("列名含非法字符：{c}")));
        }
        if !real.contains(c) {
            return Err(DbError::invalid(
                "columns",
                format!("表 {table} 没有列 {c}（可用列：{real:?}）"),
            ));
        }
    }
    Ok(())
}

/// 解析 `where` 参数：`{ "column": value | null }`（null 匹配 IS NULL）
fn parse_where(p: &Value) -> DbResult<Vec<(String, Option<Value>)>> {
    match p.get("where") {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(Value::Object(map)) => Ok(map
            .iter()
            .map(|(k, v)| (k.clone(), if v.is_null() { None } else { Some(v.clone()) }))
            .collect()),
        Some(_) => Err(DbError::invalid("where", "期望对象 {列: 值}")),
    }
}

/// 取一行 → JSON 对象（列名来自查询本身的 `SELECT` 列表）
fn row_to_object(columns: &[String], r: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    let mut map = serde_json::Map::new();
    for (i, name) in columns.iter().enumerate() {
        let v: SqlValue = r.get(i)?;
        map.insert(
            name.clone(),
            match v {
                SqlValue::Null => Value::Null,
                SqlValue::Integer(n) => json!(n),
                SqlValue::Real(f) => json!(f),
                SqlValue::Text(s) => json!(s),
                SqlValue::Blob(_) => json!("<blob>"),
            },
        );
    }
    Ok(Value::Object(map))
}

/// 通用查询：`{ table, columns?, where?, order_by?, desc?, limit?, offset? }`
///
/// - `columns` 缺省 = 该表全部列（顺序按真实表定义）；
/// - 一律分页（`limit` 被 `MAX_ROWS_PER_QUERY` 夹住），返回 `{items,has_more,next_cursor}`。
pub fn crud_list(engine: &Engine, p: &Value) -> DbResult<Value> {
    let table = p
        .get("table")
        .and_then(|x| x.as_str())
        .ok_or_else(|| DbError::missing("table"))?
        .to_string();
    assert_table(&table)?;
    let limit = limit_of(p)?;
    let offset = offset_of(p)?;
    let where_pairs = parse_where(p)?;
    let order_by = p.get("order_by").and_then(|x| x.as_str()).map(|s| s.to_string());
    let desc = p.get("desc").and_then(|x| x.as_bool()).unwrap_or(false);

    engine.with_conn(|conn| {
        // 列清单：缺省取真实列（顺序稳定，便于摘要/对账）
        let columns: Vec<String> = match p.get("columns") {
            Some(Value::Array(a)) => a
                .iter()
                .map(|x| {
                    x.as_str()
                        .map(|s| s.to_string())
                        .ok_or_else(|| DbError::invalid("columns", "元素必须是字符串"))
                })
                .collect::<DbResult<Vec<_>>>()?,
            _ => {
                let mut stmt = conn
                    .prepare(&format!("PRAGMA table_info(\"{table}\")"))
                    .map_err(DbError::from)?;
                let rows = stmt
                    .query_map([], |r| r.get::<_, String>(1))
                    .map_err(DbError::from)?;
                let mut out = Vec::new();
                for r in rows {
                    out.push(r.map_err(DbError::from)?);
                }
                out
            }
        };
        check_columns(conn, &table, &columns)?;

        // WHERE（列名同样逐字核对）
        let where_cols: Vec<String> = where_pairs.iter().map(|(c, _)| c.clone()).collect();
        check_columns(conn, &table, &where_cols)?;
        let mut sql = format!(
            "SELECT {} FROM \"{table}\"",
            columns
                .iter()
                .map(|c| format!("\"{c}\""))
                .collect::<Vec<_>>()
                .join(", ")
        );
        let mut vals: Vec<SqlValue> = Vec::new();
        if !where_pairs.is_empty() {
            let mut clauses = Vec::new();
            for (col, v) in &where_pairs {
                match v {
                    None => clauses.push(format!("\"{col}\" IS NULL")),
                    Some(val) => {
                        vals.push(to_sql_value(val));
                        clauses.push(format!("\"{col}\" = ?{}", vals.len()));
                    }
                }
            }
            sql.push_str(&format!(" WHERE {}", clauses.join(" AND ")));
        }
        // ORDER BY：只允许真实列 + asc/desc（不给任何表达式入口）
        if let Some(ob) = &order_by {
            check_columns(conn, &table, std::slice::from_ref(ob))?;
            // ⚠️ 这里必须留空格：早先漏了空格，拼成 `... FROM "graph_nodes""id"` →
            // SQLite 报 `no such table: graph_nodes"id`（测试当场抓到）
            sql.push_str(&format!(" ORDER BY \"{ob}\" {}", if desc { "DESC" } else { "ASC" }));
        }
        vals.push(SqlValue::Integer((limit + 1) as i64));
        sql.push_str(&format!(" LIMIT ?{}", vals.len()));
        vals.push(SqlValue::Integer(offset as i64));
        sql.push_str(&format!(" OFFSET ?{}", vals.len()));

        let mut stmt = conn.prepare(&sql).map_err(DbError::from)?;
        let rows = stmt
            .query_map(params_from_iter(vals.iter()), |r| row_to_object(&columns, r))
            .map_err(DbError::from)?;
        let mut items = Vec::new();
        for r in rows {
            items.push(r.map_err(DbError::from)?);
        }
        let has_more = items.len() > limit;
        if has_more {
            items.truncate(limit);
        }
        Ok(json!({
            "items": items,
            "has_more": has_more,
            "next_cursor": if has_more { Some((offset + limit).to_string()) } else { None },
        }))
    })
}

/// 通用 upsert：`{ table, rows: [{列: 值}], mode?: "insert"|"replace" }`
///
/// 每行的列可以不同（按并集收集列名）；整批在**一个事务**里完成。
pub fn crud_upsert(engine: &Engine, p: &Value) -> DbResult<Value> {
    let table = p
        .get("table")
        .and_then(|x| x.as_str())
        .ok_or_else(|| DbError::missing("table"))?
        .to_string();
    assert_table(&table)?;
    let rows = p
        .get("rows")
        .and_then(|x| x.as_array())
        .ok_or_else(|| DbError::missing("rows（对象数组）"))?;
    if rows.is_empty() {
        return Err(DbError::invalid("rows", "不能为空数组"));
    }
    let mode = p.get("mode").and_then(|x| x.as_str()).unwrap_or("insert");
    if mode != "insert" && mode != "replace" {
        return Err(DbError::invalid("mode", "只允许 insert 或 replace"));
    }

    // 收集列并集，并逐行校验形状（事务外完成，参数错误不留半个事务）
    let mut cols: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for (i, row) in rows.iter().enumerate() {
        let obj = row
            .as_object()
            .ok_or_else(|| DbError::invalid("rows", format!("第 {i} 行不是对象")))?;
        if obj.is_empty() {
            return Err(DbError::invalid("rows", format!("第 {i} 行为空对象")));
        }
        for k in obj.keys() {
            if seen.insert(k.clone()) {
                cols.push(k.clone());
            }
        }
    }

    let parsed: Vec<Vec<SqlValue>> = rows
        .iter()
        .map(|row| {
            let obj = row.as_object().expect("已校验");
            cols.iter()
                .map(|c| obj.get(c).map(to_sql_value).unwrap_or(SqlValue::Null))
                .collect()
        })
        .collect();

    let verb = if mode == "replace" { "INSERT OR REPLACE" } else { "INSERT" };
    let placeholders: Vec<String> = (1..=cols.len()).map(|i| format!("?{i}")).collect();
    let sql = format!(
        "{verb} INTO \"{table}\" ({}) VALUES ({})",
        cols.iter().map(|c| format!("\"{c}\"")).collect::<Vec<_>>().join(", "),
        placeholders.join(", ")
    );

    engine.write_tx(|tx| {
        // 列名核对放在事务内（需要 conn），但**任何写入之前**
        let real = real_columns(tx, &table)?;
        for c in &cols {
            if !c.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '_') {
                return Err(DbError::invalid("columns", format!("列名含非法字符：{c}")));
            }
            if !real.contains(c) {
                return Err(DbError::invalid(
                    "columns",
                    format!("表 {table} 没有列 {c}（可用列：{real:?}）"),
                ));
            }
        }
        let mut stmt = tx.prepare_cached(&sql).map_err(DbError::from)?;
        let mut n = 0usize;
        for vals in &parsed {
            stmt.execute(params_from_iter(vals.iter())).map_err(DbError::from)?;
            n += 1;
        }
        Ok(json!({ "written": n, "table": table, "mode": mode, "columns": cols }))
    })
}

/// 通用删除：`{ table, where: {列: 值} }`
///
/// **必须**给 where：空 where 会删全表，属于危险操作，明确拒绝
/// （与 `telemetry.prune` 要求水位线同一条原则）。
pub fn crud_delete(engine: &Engine, p: &Value) -> DbResult<Value> {
    let table = p
        .get("table")
        .and_then(|x| x.as_str())
        .ok_or_else(|| DbError::missing("table"))?
        .to_string();
    assert_table(&table)?;
    let where_pairs = parse_where(p)?;
    if where_pairs.is_empty() {
        return Err(DbError::invalid(
            "where",
            "删除必须给出 where 条件（空条件会清空整表，属于危险操作）",
        ));
    }
    engine.write_tx(|tx| {
        check_columns(tx, &table, &where_pairs.iter().map(|(c, _)| c.clone()).collect::<Vec<_>>())?;
        let mut clauses = Vec::new();
        let mut vals: Vec<SqlValue> = Vec::new();
        for (col, v) in &where_pairs {
            match v {
                None => clauses.push(format!("\"{col}\" IS NULL")),
                Some(val) => {
                    vals.push(to_sql_value(val));
                    clauses.push(format!("\"{col}\" = ?{}", vals.len()));
                }
            }
        }
        let sql = format!("DELETE FROM \"{table}\" WHERE {}", clauses.join(" AND "));
        let n = tx
            .execute(&sql, params_from_iter(vals.iter()))
            .map_err(DbError::from)?;
        Ok(json!({ "written": n, "table": table }))
    })
}

/// 通用计数：`{ table, where? }`
pub fn crud_count(engine: &Engine, p: &Value) -> DbResult<Value> {
    let table = p
        .get("table")
        .and_then(|x| x.as_str())
        .ok_or_else(|| DbError::missing("table"))?
        .to_string();
    assert_table(&table)?;
    let where_pairs = parse_where(p)?;
    engine.with_conn(|conn| {
        check_columns(conn, &table, &where_pairs.iter().map(|(c, _)| c.clone()).collect::<Vec<_>>())?;
        let mut sql = format!("SELECT COUNT(*) FROM \"{table}\"");
        let mut vals: Vec<SqlValue> = Vec::new();
        if !where_pairs.is_empty() {
            let mut clauses = Vec::new();
            for (col, v) in &where_pairs {
                match v {
                    None => clauses.push(format!("\"{col}\" IS NULL")),
                    Some(val) => {
                        vals.push(to_sql_value(val));
                        clauses.push(format!("\"{col}\" = ?{}", vals.len()));
                    }
                }
            }
            sql.push_str(&format!(" WHERE {}", clauses.join(" AND ")));
        }
        let n: i64 = conn
            .query_row(&sql, params_from_iter(vals.iter()), |r| r.get(0))
            .map_err(DbError::from)?;
        Ok(json!({ "count": n, "table": table }))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allowed_tables_excludes_fts_shadows() {
        let t = allowed_tables();
        assert!(t.len() > 30, "业务表数量异常：{}", t.len());
        assert!(t.contains("accounts"));
        assert!(t.contains("graph_nodes"));
        assert!(!t.iter().any(|x| x.starts_with("session_fts")));
    }

    #[test]
    fn unknown_table_is_unsupported() {
        let err = assert_table("sqlite_master").unwrap_err();
        assert_eq!(err.code, crate::error::ErrorCode::Unsupported);
        let err2 = assert_table("session_fts_content").unwrap_err();
        assert_eq!(err2.code, crate::error::ErrorCode::Unsupported);
    }
}
