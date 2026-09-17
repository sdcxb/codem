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

use rusqlite::params;

use rusqlite::types::Value as SqlValue;
use rusqlite::{params_from_iter, Connection};
use serde_json::{json, Value};

use crate::engine::Engine;
use crate::error::{DbError, DbResult};
use crate::migrate::TABLE_LIST_JSON;
use crate::repo::{limit_of, offset_of, to_sql_value};

/// 受保护的"用户内容"表：一次删除如果波及它们太多行，必须显式确认。
///
/// ## 为什么需要这道闸（第 32 轮真机事故的直接产物）
///
/// 事故形态：一条看起来**范围很小**的删除（删 2 个会话）通过外键级联
/// 一次带走了 **821 条消息 + 883 个工具调用 + 2131 条事件**，而调用方
/// 从未表达"我要清空语料"的意图。渲染侧的所有审计都显示"没有大范围删除"，
/// 因为从**调用方视角**它确实只是删了 2 行。
///
/// 结论：危险的不是"删除"这个动作，而是**级联的规模不体现在调用参数里**。
/// 所以闸门必须装在**真正执行 SQL 的地方**，并且按**实际影响行数**判定 ——
/// 而不是按调用方声明的范围。
pub const PROTECTED_TABLES: &[&str] = &["messages", "sessions", "session_events", "tool_calls"];

/// 单次删除在受保护表上的行数上限：超过就必须显式 `confirm_bulk: true`。
///
/// 取 50 的理由：正常交互路径（删一条消息、删一个会话、清一批工具调用）
/// 都在这个量级以下；而"级联清空语料"（数百上千）会立刻被拦下。
pub const BULK_DELETE_LIMIT: i64 = 50;

/// **级联规模闸门**只在从这些表删除时生效（第 44 轮定的范围）。
///
/// ## 为什么必须有这个范围（而不是"所有表一律拦"）
///
/// 闸门要防的是**一类特定事故**：会话语料在调用方**完全没有表达该意图**的情况下消失
/// （真机：删 2 个会话 → 821 条消息 + 883 个工具调用 + 2131 条事件；调用参数里只写"删 1 行"）。
/// 这一类的共同点是：**删除的规模不体现在参数里，而后果是不可逆的用户语料损失**。
///
/// 同样的规则套到别的域上会变成**新的缺陷**。例：`notebooks` 删除必然级联带走它的
/// `notebook_chunks`（"删掉笔记本但保留它的块"没有语义），而知识库的真实调用点里
/// 有**内部路径**（`indexer.ts` 重建索引时删旧 source）与**工具路径**
/// （`note-operations.ts` 让模型删笔记）—— 给这些路径强加"必须显式确认"只会让
/// 正常功能开始报错，而它们并不是事故来源。也就是说：
/// **闸门的作用域必须等于它要防的事故的作用域**，扩大作用域本身就是在造缺陷。
///
/// 因此这里只列"会话语料"这张图上的根：
/// `messages` / `sessions` / `session_events` / `tool_calls` / `projects`
/// （`projects` 是根中之根：删一个项目会带走它下面全部会话与消息）。
/// 其它表的删除**仍然如实回报 `affected_rows`**（规模可见），但不会因为规模大而被拒绝。
pub const CASCADE_GUARD_ROOTS: &[&str] = &[
    "messages",
    "sessions",
    "session_events",
    "tool_calls",
    "projects",
];

/// **级联影响**闸门（供 `sessions_delete` 这类"只删一行、却级联几百行"的命令使用）。
///
/// 单独抽出来是因为事故的形态正是这个：调用方删 1 个会话（`where {id}` 只命中 1 行），
/// 而外键级联带走了 821 条消息。只看 `where` 命中数**看不见**这个规模，
/// 必须按"会被级联带走多少行"判定。
pub fn guard_cascade_scope(
    what: &str,
    affected: i64,
    confirmed: bool,
) -> DbResult<()> {
    if confirmed || affected <= BULK_DELETE_LIMIT {
        return Ok(());
    }
    Err(DbError::invalid(
        "confirm_bulk",
        format!(
            "拒绝级联删除：{what} 会连带删除 {affected} 行（上限 {BULK_DELETE_LIMIT}）。\
             这类删除的规模不体现在调用参数里（参数只说删 1 行），所以必须显式传 \
             confirm_bulk: true —— 要求调用方明确表达自己在做批量删除。"
        ),
    ))
}

/// 把一次删除的**真实影响规模**量出来：执行它、读出净影响行数，并把"要不要拦"的判断
/// 交给调用方；调用方判定超限时返回 `Err`，整个写事务回滚 —— **库里什么都没变**。
///
/// ## 为什么必须"先删再量"（而不是按 where 命中数预检）
///
/// `guard_bulk_delete` 只能看见 `where` 命中的行数，而事故的形态恰恰是
/// **`where` 命中 1 行、外键级联带走 821 行**。想按子表 FK 图**预先**算准级联规模，
/// 要么漏（`notebooks → chunks` 这类不在 `PROTECTED_TABLES` 名单里），
/// 要么被自引用/环状 FK 绕死（`goals.parent_id → goals.id` 就是自级联）。
/// 而 SQLite 本身没有"这条 DELETE 会影响多少行"的接口 ——
/// 唯一准确的量法是**真的删一次**。所以：在事务里删、量、判；超限就回滚。
/// 代价是"被拒绝的那次"多做了一次删除，收益是**闸门不可能算错**。
///
/// ## 为什么必须减掉审计行
///
/// `audit::install` 给每张受审计表挂了 `AFTER DELETE` 触发器，**每删一行就插一行审计**。
/// 于是 `Connection::total_changes()` 的增量 = 真实删除行 + 审计行（本来就有 2~3 倍放大）。
/// 不减掉它，删 20 条消息会被当成 60 行而**误拦正常操作**。
/// `storage_audit.id` 是 `INTEGER PRIMARY KEY`，所以"本次新增多少审计行"可以按
/// id 水位线精确查到；而且这些审计行会随事务回滚一起消失，绝不污染库。
///
/// 返回 `(调用方产物, 净影响行数)`。净影响行数**含** `where` 直接命中的行。
///
/// `pub` 是给 `repo.rs` 里那些"删 1 行、级联几百行"的专用命令复用
/// （`sessions.delete` / `projects.delete`）—— 判据必须只有一份，
/// 否则某个命令漏改就会出现"同一个操作走两条路、防护不一样"，
/// 而这正是这次事故的形态（闸门装了，但装的不是生产路径）。
pub fn measure_delete_impact<T>(
    tx: &rusqlite::Transaction<'_>,
    run: impl FnOnce() -> DbResult<T>,
) -> DbResult<(T, i64)> {
    let audit_table = crate::audit::AUDIT_TABLE;
    // 表不存在（老库/裁剪过的库）时退化为 0：此时也没有触发器，不影响结论
    let watermark: i64 = tx
        .query_row(
            &format!("SELECT COALESCE(MAX(id), 0) FROM {audit_table}"),
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    let before: i64 = tx
        .query_row("SELECT total_changes()", [], |r| r.get(0))
        .unwrap_or(0);
    let out = run()?;
    let total: i64 = tx
        .query_row("SELECT total_changes()", [], |r| r.get(0))
        .unwrap_or(before)
        - before;
    let audit_rows: i64 = tx
        .query_row(
            &format!("SELECT COUNT(*) FROM {audit_table} WHERE id > ?1"),
            params![watermark],
            |r| r.get(0),
        )
        .unwrap_or(0);
    Ok((out, total - audit_rows))
}

/// 统计某条 where 会命中多少行（删除前预检用）
fn count_matching(conn: &Connection, table: &str, where_pairs: &[(String, Option<Value>)]) -> DbResult<i64> {
    let mut clauses = Vec::new();
    let mut vals: Vec<SqlValue> = Vec::new();
    for (col, v) in where_pairs {
        match v {
            None => clauses.push(format!("\"{col}\" IS NULL")),
            Some(val) => {
                vals.push(to_sql_value(val));
                clauses.push(format!("\"{col}\" = ?{}", vals.len()));
            }
        }
    }
    let where_sql = if clauses.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", clauses.join(" AND "))
    };
    let sql = format!("SELECT COUNT(*) FROM \"{table}\"{where_sql}");
    let n: i64 = conn
        .query_row(&sql, params_from_iter(vals.iter()), |r| r.get(0))
        .map_err(DbError::from)?;
    Ok(n)
}

/// 受保护表的删除闸门：命中行数超限且未显式确认 → 拒绝，并**如实说明规模**。
///
/// 错误信息刻意带上"这张表总共多少行、这次会删多少行"：
/// 排查时最需要的就是这个比例，而不是一句"操作被拒绝"。
fn guard_bulk_delete(
    conn: &Connection,
    table: &str,
    where_pairs: &[(String, Option<Value>)],
    confirmed: bool,
) -> DbResult<()> {
    if confirmed || !PROTECTED_TABLES.contains(&table) {
        return Ok(());
    }
    let matched = count_matching(conn, table, where_pairs)?;
    if matched <= BULK_DELETE_LIMIT {
        return Ok(());
    }
    let total: i64 = conn
        .query_row(&format!("SELECT COUNT(*) FROM \"{table}\""), [], |r| r.get(0))
        .unwrap_or(0);
    Err(DbError::invalid(
        "confirm_bulk",
        format!(
            "拒绝批量删除：这次会从 {table} 删掉 {matched} 行（该表共 {total} 行，\
             上限 {BULK_DELETE_LIMIT}）。级联删除的规模不会体现在 where 里，\
             所以必须显式传 confirm_bulk: true 才能执行 —— 这不是限制能力，\
             而是要求调用方**明确表达**自己在做批量删除。"
        ),
    ))
}

/// 允许通用操作的**业务表**清单（来自 TS schema，排除 FTS 影子表）。
///
/// 这是**编译期常量**（`tables.json` 由 `gen-schema-sql.mjs` 生成），
/// 因此调用方不可能通过表名参数访问清单之外的对象。
fn allowed_tables() -> HashSet<String> {    let v: Value = serde_json::from_str(TABLE_LIST_JSON).expect("tables.json 解析失败");
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
///
/// ## ⚠️ `mode: "replace"` **不再是 `INSERT OR REPLACE`**（第 13 轮，真机数据事故的根因）
///
/// SQLite 的 `INSERT OR REPLACE` 语义是"**冲突时先 DELETE 再 INSERT**"。
/// 对**父表**（`projects` → `sessions` → `messages` / `tool_calls` / `session_events` /
/// `message_feedback` 都是 `ON DELETE CASCADE`）来说，这句"覆盖一行"会**级联删掉它的全部子行**：
///
/// - `updateSession()`（渲染侧改标题/最后消息时间/置顶都走它）用 `mode: "replace"` →
///   `INSERT OR REPLACE INTO sessions` → **该会话的消息、工具调用、事件被级联删光**，
///   而会话行本身还在 —— 用户看到的就是"**点开会话，内容全空**"（真机长期悬案）；
/// - `storage_audit` 的证据：2026-09-17T01:13:34Z / 02:12:14Z 两次"删 2~3 个 sessions +
///   821 条 messages + 883 tool_calls + 2131 events"，全部在同一秒、形态就是级联。
///
/// 现在的 `replace` 走**真正的 upsert**：`INSERT ... ON CONFLICT(<主键>) DO UPDATE SET …`，
/// 只更新**本次提供的列**、绝不删行，因此：
/// - 子行不会被级联删除；
/// - 本次没提供的列（如 `project_id`）保持原值（`INSERT OR REPLACE` 会把它们清成 NULL）。
///
/// 没有主键的表退回普通 `INSERT`（没有冲突可处理，"replace" 无意义）。
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

    let placeholders: Vec<String> = (1..=cols.len()).map(|i| format!("?{i}")).collect();

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

        /*
         * `replace` → **两段式"先更新、没有再插入"**（绝不删除行，见函数头说明）。
         *
         * 为什么不用 `INSERT ... ON CONFLICT DO UPDATE`：那要求 INSERT 的那一半也能成立 ——
         * 对"只提供部分列"的调用（例如只改 `title`）会被 `NOT NULL constraint failed` 挡下
         * （实测踩到：`sessions.project_id` NOT NULL）。而 `UPDATE ... WHERE pk` 天然只碰提供的列。
         *
         * 代价是每行先执行一次 UPDATE（0 行才 INSERT）—— 行数都在几十到上百的量级，可接受；
         * 换来的是**父表覆盖不会级联删子表**，以及**未提供的列保持原值**。
         */
        let pk_cols = primary_key_columns(tx, &table)?;
        let set_cols: Vec<&String> = cols.iter().filter(|c| !pk_cols.contains(c)).collect();
        let pk_idx: Vec<usize> = pk_cols
            .iter()
            .map(|pk| cols.iter().position(|c| c == pk))
            .collect::<Option<Vec<usize>>>()
            .unwrap_or_default();
        let use_update_first = mode == "replace"
            && !pk_cols.is_empty()
            && pk_idx.len() == pk_cols.len()
            && !set_cols.is_empty();

        let insert_sql = format!(
            "INSERT INTO \"{table}\" ({}) VALUES ({})",
            cols.iter().map(|c| format!("\"{c}\"")).collect::<Vec<_>>().join(", "),
            placeholders.join(", ")
        );
        let update_sql = if use_update_first {
            let sets = set_cols
                .iter()
                .enumerate()
                .map(|(i, c)| format!("\"{c}\" = ?{}", i + 1))
                .collect::<Vec<_>>()
                .join(", ");
            let wheres = pk_cols
                .iter()
                .enumerate()
                .map(|(i, c)| format!("\"{c}\" = ?{}", set_cols.len() + i + 1))
                .collect::<Vec<_>>()
                .join(" AND ");
            Some(format!("UPDATE \"{table}\" SET {sets} WHERE {wheres}"))
        } else {
            None
        };

        let mut insert_stmt = tx.prepare_cached(&insert_sql).map_err(DbError::from)?;
        let mut update_stmt = match &update_sql {
            Some(sql) => Some(tx.prepare_cached(sql).map_err(DbError::from)?),
            None => None,
        };
        let mut n = 0usize;
        for vals in &parsed {
            if let Some(stmt) = update_stmt.as_mut() {
                let mut args: Vec<SqlValue> = set_cols
                    .iter()
                    .map(|c| {
                        let i = cols.iter().position(|x| x == *c).unwrap_or(0);
                        vals[i].clone()
                    })
                    .collect();
                for i in &pk_idx {
                    args.push(vals[*i].clone());
                }
                let changed = stmt.execute(params_from_iter(args.iter())).map_err(DbError::from)?;
                if changed > 0 {
                    n += 1;
                    continue;
                }
            }
            insert_stmt.execute(params_from_iter(vals.iter())).map_err(DbError::from)?;
            n += 1;
        }
        Ok(json!({ "written": n, "table": table, "mode": mode, "columns": cols }))
    })
}

/// 该表的主键列（按 `PRAGMA table_info` 的 pk 序号排序；无主键则空）
///
/// 与 `migrate.rs` 里同名助手用途一致：**覆盖已存在行时必须按主键定位，
/// 而且不能用 `INSERT OR REPLACE`**（它会先删行，父表会级联带走子表数据）。
fn primary_key_columns(conn: &rusqlite::Connection, table: &str) -> DbResult<Vec<String>> {
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info(\"{table}\")"))
        .map_err(DbError::from)?;
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, i64>(5)?, r.get::<_, String>(1)?)))
        .map_err(DbError::from)?;
    let mut pk: Vec<(i64, String)> = Vec::new();
    for r in rows {
        let (idx, name) = r.map_err(DbError::from)?;
        if idx > 0 {
            pk.push((idx, name));
        }
    }
    pk.sort_by_key(|(i, _)| *i);
    Ok(pk.into_iter().map(|(_, n)| n).collect())
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
    // 受保护表的批量删除闸门（见 guard_bulk_delete 的说明）
    let confirmed = p.get("confirm_bulk").and_then(|x| x.as_bool()).unwrap_or(false);
    engine.write_tx(|tx| {
        check_columns(tx, &table, &where_pairs.iter().map(|(c, _)| c.clone()).collect::<Vec<_>>())?;
        guard_bulk_delete(tx, &table, &where_pairs, confirmed)?;
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
        /*
         * 级联规模闸门（第 44 轮，真机缺陷修正）。
         *
         * 上面那道 `guard_bulk_delete` 只看 `where` 命中数 —— 而**渲染侧删会话走的就是
         * 这条路**：`domainDelete("sessions", {id})` → `crud.delete`，`where {id}` 命中 1 行，
         * 于是一路放行，外键级联静默带走该会话的全部消息/工具调用/事件。
         * 真机复现：`crud.delete {table:sessions, where:{id:s1}}` → `{"written":1}`，
         * 300 条消息全没了。也就是说：为这起事故加的防护**在生产路径上从未生效**
         * —— 它只装在**没被接线**的 `sessions.delete` 里。
         *
         * 所以闸门必须装在**真正执行 SQL 的地方**（这里），并且按**实际影响行数**判定，
         * 而不是按调用方声明的范围。判定的方式是"先删、再量、超限就回滚"：
         * 事务保证被拒绝时库里一行未动。
         */
        let (n, impact) = measure_delete_impact(tx, || {
            tx.execute(&sql, params_from_iter(vals.iter()))
                .map_err(DbError::from)
        })?;
        // 闸门只装在"会话语料"的根表上（作用域的理由见 `CASCADE_GUARD_ROOTS`）：
        // 别处仍然如实报出含级联的真实规模，但不会因为规模大而被拒绝。
        if CASCADE_GUARD_ROOTS.contains(&table.as_str()) {
            guard_cascade_scope(
                &format!("从 {table} 删除（where 命中 {n} 行）"),
                impact,
                confirmed,
            )?;
        }
        Ok(json!({
            "written": n,
            "table": table,
            // 如实报出**含级联**的真实规模：调用方看到的 `written` 只是它声明的范围，
            // 两者差多少正是"级联带走了多少" —— 这是排查这类事故最需要的一个数
            "affected_rows": impact,
        }))
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

    // ===== 批量删除闸门（第 32 轮事故的直接产物）=====

    /// 建一个带数据的真实引擎（用临时目录里的库文件，走完整 schema + 触发器路径）
    fn engine_with_sessions(messages_per_session: usize) -> (Engine, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let engine = Engine::open(dir.path().join("t.bin")).unwrap();
        engine
            .write_tx(|tx| {
                tx.execute(
                    "INSERT OR REPLACE INTO projects (id,name,path,created_at,last_accessed_at) \
                     VALUES ('p','P','',1,1)",
                    [],
                )
                .unwrap();
                tx.execute(
                    "INSERT INTO sessions (id,project_id,title,created_at,last_message_at,message_count) \
                     VALUES ('s1','p','t',1,1,0)",
                    [],
                )
                .unwrap();
                for i in 0..messages_per_session {
                    tx.execute(
                        "INSERT INTO messages (id,session_id,role,content,timestamp) \
                         VALUES (?1,'s1','user','x',1)",
                        rusqlite::params![format!("m{i}")],
                    )
                    .unwrap();
                }
                Ok(())
            })
            .unwrap();
        (engine, dir)
    }

    /// **`mode: "replace"` 不得级联删除子行**（第 13 轮：真机"点开会话内容全空"的根因）
    ///
    /// SQLite 的 `INSERT OR REPLACE` 是"冲突时先 DELETE 再 INSERT"。`sessions` 是父表
    /// （messages / tool_calls / session_events / message_feedback 都是 `ON DELETE CASCADE`），
    /// 而渲染侧 `updateSession()`（改标题/最后消息时间/置顶都走它）用的就是 `mode: "replace"` ——
    /// 于是"更新会话"变成了"清空该会话的全部消息"，而会话行本身还在。
    ///
    /// 证据（`storage_audit`）：2026-09-17T01:13:34Z / 02:12:14Z 两次"删 2~3 个 sessions +
    /// 821 条 messages + 883 tool_calls + 2131 events"，全部落在同一秒 —— 级联的典型形态。
    #[test]
    fn crud_upsert_replace_does_not_cascade_delete_children() {
        let (engine, _d) = engine_with_sessions(3);
        let before: i64 = engine
            .with_conn(|c| {
                c.query_row("SELECT COUNT(*) FROM messages", [], |r| r.get(0))
                    .map_err(DbError::from)
            })
            .unwrap();
        assert_eq!(before, 3);

        // 只提供 title —— 与 `updateSession({title})` 同形
        crud_upsert(
            &engine,
            &json!({
                "table": "sessions",
                "mode": "replace",
                "rows": [{ "id": "s1", "title": "改过的标题", "created_at": 1, "last_message_at": 2, "message_count": 3 }],
            }),
        )
        .unwrap();

        let after: i64 = engine
            .with_conn(|c| {
                c.query_row("SELECT COUNT(*) FROM messages", [], |r| r.get(0))
                    .map_err(DbError::from)
            })
            .unwrap();
        assert_eq!(
            after, 3,
            "覆盖会话行**不得**级联删掉它的消息（这正是真机'点开会话内容全空'的形态）"
        );

        // 本次没提供的列必须保持原值（INSERT OR REPLACE 会把它们清成 NULL）
        let project_id: String = engine
            .with_conn(|c| {
                c.query_row("SELECT project_id FROM sessions WHERE id = 's1'", [], |r| r.get(0))
                    .map_err(DbError::from)
            })
            .unwrap();
        assert_eq!(project_id, "p", "未提供的列要保持原值，不能被清成空");
    }

    #[test]
    fn crud_upsert_insert_mode_still_inserts() {
        let (engine, _d) = engine_with_sessions(0);
        crud_upsert(
            &engine,
            &json!({
                "table": "sessions",
                "rows": [{ "id": "s2", "project_id": "p", "title": "新会话", "created_at": 1, "last_message_at": 1, "message_count": 0 }],
            }),
        )
        .unwrap();
        let n: i64 = engine
            .with_conn(|c| {
                c.query_row("SELECT COUNT(*) FROM sessions", [], |r| r.get(0))
                    .map_err(DbError::from)
            })
            .unwrap();
        assert_eq!(n, 2, "insert 语义不受影响");
    }

    #[test]
    fn bulk_delete_on_protected_table_is_refused_without_confirmation() {
        let (engine, _d) = engine_with_sessions(120);
        let err = crud_delete(&engine, &json!({ "table": "messages", "where": { "session_id": "s1" } }))
            .unwrap_err();
        assert_eq!(err.code, crate::error::ErrorCode::Other, "拒绝批量删除是调用方参数问题（Other）");
        assert!(
            err.message.contains("confirm_bulk") && err.message.contains("120"),
            "错误里必须说明规模与所需的确认参数：{}",
            err.message
        );
        // 数据一行没少 —— 闸门的作用是"拒绝"，不是"删一半"
        let after = crud_count(&engine, &json!({ "table": "messages" })).unwrap();
        assert_eq!(after["count"], 120);
    }

    #[test]
    fn bulk_delete_proceeds_with_explicit_confirmation() {
        let (engine, _d) = engine_with_sessions(120);
        let r = crud_delete(
            &engine,
            &json!({ "table": "messages", "where": { "session_id": "s1" }, "confirm_bulk": true }),
        )
        .unwrap();
        assert_eq!(r["written"], 120);
    }

    #[test]
    fn small_delete_is_not_gated() {
        // 正常交互路径不该被这道闸打扰
        let (engine, _d) = engine_with_sessions(5);
        let r = crud_delete(&engine, &json!({ "table": "messages", "where": { "id": "m1" } })).unwrap();
        assert_eq!(r["written"], 1);
    }

    #[test]
    fn cascade_scope_guard_blocks_large_cascade_but_allows_small() {
        assert!(guard_cascade_scope("删会话 s1", BULK_DELETE_LIMIT, false).is_ok());
        let err = guard_cascade_scope("删会话 s1", BULK_DELETE_LIMIT + 1, false).unwrap_err();
        assert!(
            err.message.contains("级联") && err.message.contains("confirm_bulk"),
            "必须说明这是级联规模问题：{}",
            err.message
        );
        assert!(guard_cascade_scope("删会话 s1", 10_000, true).is_ok(), "显式确认后放行");
    }
}
