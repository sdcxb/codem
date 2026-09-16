//! 迁移原语（P4）：**批量导入**与**对账**。
//!
//! ## 为什么需要"批量导入"这种形态
//!
//! 迁移要把旧库（WASM/sql.js 写的 `codem-db.bin`）里的全部数据搬进新库（Rust）。
//! 用逐条仓储命令搬会：① 慢（每行一次 IPC/事务）；② 语义受限（逐条命令是**业务语义**，
//! 搬数据要的是**结构语义** —— 旧库里有 `usage_count`、`pinned`、`sort_order` 这些
//! 业务命令不暴露的列，逐条搬必然丢字段）。
//!
//! 所以这里提供一条**受控的结构化通道**，并且把它限制在安全边界内：
//! - 表名必须出现在**本文件的白名单**里（而且要与库中真实存在的表核对）；
//! - 列名必须**逐字出现在该表的真实列定义里**（用 `PRAGMA table_info` 核对）；
//! - 值是参数化绑定的（不做字符串拼接）；
//! - 不接受任何 SQL 片段。
//!
//! 这样一来 `import.table` 与"裸 SQL 通道"的区别是**结构性的**：
//! 调用方只能说"把这些值放进这张表的这些列"，而不能说"执行这条语句"。
//! 因此它既能被渲染侧安全使用（迁移期一次），也不破坏 D 类门禁的初衷。
//!
//! ## 为什么导入要包在一个事务里
//!
//! 6500 行分表导入若各自提交，中途失败会留下**半个库**。这里用
//! `import.begin` / `import.end` 把整批包成一个事务：要么全成、要么全不成。
//! CLI 侧能跨进程持有事务，是因为 `codem-db-cli` 的每次调用都会新开一个连接 ——
//! 所以 `Engine` 上单独记了一个"显式导入事务"状态，见 `Engine::import_tx`。

use std::collections::HashSet;

use rusqlite::types::Value as SqlValue;
use rusqlite::{params, params_from_iter, Connection};
use serde_json::{json, Value};

use crate::engine::Engine;
use crate::error::{DbError, DbResult, ErrorCode};
use crate::repo::{limit_of, opt_text, req_text};

/// 允许导入的表 = **从 TS schema 生成**的业务表清单（`sql/tables.json`）。
///
/// ⚠️ 这份清单早先是手写的，结果**漏了三张真实存在且有数据的表**
/// （`agent_messages` / `message_feedback` / `needs_you_pending`）——
/// 迁移会静默少搬它们，用户只会发现"某些数据不见了"。现在改为由
/// `tools/audit/gen-schema-sql.mjs` 从 `database.ts` 的 SCHEMA DDL 生成，
/// 并由 `schema_parity` 门禁守住（TS 加表 → Rust 清单自动跟上）。
pub const TABLE_LIST_JSON: &str = include_str!("../sql/tables.json");

fn generated_tables() -> Vec<String> {
    let v: serde_json::Value =
        serde_json::from_str(TABLE_LIST_JSON).expect("tables.json 解析失败（生成脚本坏了？）");
    v.get("tables")
        .and_then(|t| t.as_array())
        .expect("tables.json 缺少 tables 数组")
        .iter()
        .filter_map(|x| x.as_str().map(|s| s.to_string()))
        .collect()
}

/// 从 `tables.json` 排除 FTS 影子表后的可导入清单。
///
/// FTS4 的影子表（`session_fts_content` / `_segdir` / `_segments` / `_stat` / `_docsize`）
/// **刻意排除**：它们是索引内部结构，跨引擎搬运毫无意义（新库可能用 FTS5，结构完全不同）。
/// 全文索引在导入后由 `rebuild_fts` 从 `messages` 重建 ——
/// 这也正是"索引可重建、权威副本是会话 JSONL"的一贯设计。
pub fn importable_tables() -> Vec<String> {
    generated_tables()
        .into_iter()
        .filter(|t| !t.starts_with("session_fts"))
        .collect()
}

/// 外键依赖顺序：投影 → 会话 → 消息 → 叶子。
///
/// 迁移工具必须按这个顺序提交，否则外键会拒绝插入（`PRAGMA foreign_keys=ON` 一直开着）。
/// 这里**必须覆盖 `tables.json` 的全部表**，由 `import_order_covers_all_tables` 测试守住 ——
/// 新加表时必须同时决定它的位置，避免"新表没被搬"。
pub const IMPORT_ORDER: &[&str] = &[
    // 投影
    "projects",
    // 会话层
    "sessions",
    "v2_sessions",
    // 消息层（依赖 sessions）
    "messages",
    "attachments",
    "tool_calls",
    "message_feedback",
    "agent_messages",
    "needs_you_pending",
    "turn_file_changes",
    // 配置 / 无外键依赖
    "settings",
    "accounts",
    "mcp_servers",
    "memory",
    "recovery_data",
    "agent_profiles",
    "cost_records",
    "quick_phrases",
    "prompt_drafts",
    // 笔记 / 文档
    "notebooks",
    "notebook_groups",
    "notebook_sources",
    "notebook_chunks",
    "notes",
    "note_links",
    "note_versions",
    "flashcards",
    // 任务 / 团队
    "squads",
    "squad_members",
    "goals",
    "todo_lists",
    "inbox",
    "issues",
    "issue_comments",
    "delegation_tasks",
    // 图谱 / 事件
    "graph_nodes",
    "graph_edges",
    "session_events",
    "telemetry_events",
];

fn assert_allowed_table(table: &str) -> DbResult<()> {
    if table.starts_with("session_fts") {
        return Err(DbError::unsupported(format!(
            "FTS 影子表 {table} 不允许直接导入（跨引擎结构不同）；导入后用 rebuild_fts 从 messages 重建"
        )));
    }
    if importable_tables().iter().any(|t| t == table) {
        Ok(())
    } else {
        Err(DbError::unsupported(format!(
            "表 {table} 不在允许导入的清单里（清单由 sql/tables.json 生成）"
        )))
    }
}

/// 该表真实存在的列（`PRAGMA table_info`；表名已过白名单，拼接安全）
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

fn to_sql_value(v: &Value) -> SqlValue {
    match v {
        Value::Null => SqlValue::Null,
        Value::Bool(b) => SqlValue::Integer(i64::from(*b)),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                SqlValue::Integer(i)
            } else {
                SqlValue::Real(n.as_f64().unwrap_or(0.0))
            }
        }
        Value::String(s) => SqlValue::Text(s.clone()),
        other => SqlValue::Text(other.to_string()),
    }
}

/// 批量导入一张表的一批行。
///
/// 参数：`{ table, columns: [...], rows: [[...], ...], mode: "insert"|"replace" }`
pub fn import_table(engine: &Engine, p: &Value) -> DbResult<Value> {
    let table = p
        .get("table")
        .and_then(|x| x.as_str())
        .ok_or_else(|| DbError::missing("table"))?
        .to_string();
    assert_allowed_table(&table)?;

    let columns: Vec<String> = p
        .get("columns")
        .and_then(|x| x.as_array())
        .ok_or_else(|| DbError::missing("columns（字符串数组）"))?
        .iter()
        .map(|c| {
            c.as_str()
                .map(|s| s.to_string())
                .ok_or_else(|| DbError::invalid("columns", "元素必须是字符串"))
        })
        .collect::<DbResult<Vec<_>>>()?;
    if columns.is_empty() {
        return Err(DbError::invalid("columns", "不能为空"));
    }
    // 列名必须逐字出现在真实列定义里（防注入 + 防拼错列名导致"静默丢字段"）
    for c in &columns {
        if !c.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '_') {
            return Err(DbError::invalid("columns", format!("列名含非法字符：{c}")));
        }
    }

    let rows = p
        .get("rows")
        .and_then(|x| x.as_array())
        .ok_or_else(|| DbError::missing("rows（二维数组）"))?;
    let mode = p.get("mode").and_then(|x| x.as_str()).unwrap_or("insert");
    if mode != "insert" && mode != "replace" {
        return Err(DbError::invalid("mode", "只允许 insert 或 replace"));
    }

    // 事务外先把参数全部解析校验（参数错误不该留下半个事务）
    let mut parsed: Vec<Vec<SqlValue>> = Vec::with_capacity(rows.len());
    for (i, row) in rows.iter().enumerate() {
        let arr = row
            .as_array()
            .ok_or_else(|| DbError::invalid("rows", format!("第 {i} 行不是数组")))?;
        if arr.len() != columns.len() {
            return Err(DbError::invalid(
                "rows",
                format!(
                    "第 {i} 行的值个数 {} 与 columns 个数 {} 不一致",
                    arr.len(),
                    columns.len()
                ),
            ));
        }
        parsed.push(arr.iter().map(to_sql_value).collect());
    }

    let verb = if mode == "replace" { "INSERT OR REPLACE" } else { "INSERT" };
    let placeholders: Vec<String> = (1..=columns.len()).map(|i| format!("?{i}")).collect();
    let sql = format!(
        "{verb} INTO \"{table}\" ({}) VALUES ({})",
        columns
            .iter()
            .map(|c| format!("\"{c}\""))
            .collect::<Vec<_>>()
            .join(", "),
        placeholders.join(", ")
    );

    let real = engine.with_conn(|conn| real_columns(conn, &table))?;
    for c in &columns {
        if !real.contains(c) {
            return Err(DbError::invalid(
                "columns",
                format!("表 {table} 没有列 {c}（可用列：{real:?}）"),
            ));
        }
    }

    let count = parsed.len();
    let written = engine.import_write(|tx| {
        let mut stmt = tx.prepare_cached(&sql).map_err(DbError::from)?;
        let mut n = 0usize;
        for vals in &parsed {
            stmt.execute(params_from_iter(vals.iter())).map_err(DbError::from)?;
            n += 1;
        }
        Ok(n)
    })?;

    Ok(json!({ "written": written, "table": table, "mode": mode, "count": count }))
}

/// 一次性导入多张表（**单进程、单事务、全成或全不成**）。
///
/// 输入：`[{ "table": "messages", "columns": [...], "rows": [[...], ...], "mode": "insert" }, ...]`
/// 或 `{ "tables": [ ...同上... ] }`。
///
/// 为什么必须"单进程"：`--db` 每次调用新开连接，而事务属于连接 ——
/// 分多次调用时上一次的 `BEGIN` 会随进程退出被回滚（见 CLI 的 `import` 子命令注释）。
///
/// 语义：任一张表失败 → 整个事务回滚 → 新库**保持导入前的状态**（不是"半个库"）。
pub fn import_all(engine: &Engine, payload: &Value) -> DbResult<Value> {
    let items = payload
        .get("tables")
        .and_then(|x| x.as_array())
        .or_else(|| payload.as_array())
        .ok_or_else(|| DbError::invalid("payload", "期望数组或 {tables:[...]}"))?;

    // 先做**整体校验**：表名/列名/行形状全对才开事务（参数错误不该留下半个事务）
    let mut jobs: Vec<(String, Vec<String>, Vec<Vec<SqlValue>>, String)> = Vec::with_capacity(items.len());
    for (i, it) in items.iter().enumerate() {
        let table = it
            .get("table")
            .and_then(|x| x.as_str())
            .ok_or_else(|| DbError::invalid("table", format!("第 {i} 项缺少 table")))?
            .to_string();
        assert_allowed_table(&table)?;
        let columns: Vec<String> = it
            .get("columns")
            .and_then(|x| x.as_array())
            .ok_or_else(|| DbError::invalid("columns", format!("表 {table} 缺少 columns")))?
            .iter()
            .map(|c| {
                c.as_str()
                    .map(|s| s.to_string())
                    .ok_or_else(|| DbError::invalid("columns", "元素必须是字符串"))
            })
            .collect::<DbResult<Vec<_>>>()?;
        if columns.is_empty() {
            return Err(DbError::invalid("columns", format!("表 {table} 的 columns 为空")));
        }
        let mode = it.get("mode").and_then(|x| x.as_str()).unwrap_or("insert").to_string();
        if mode != "insert" && mode != "replace" {
            return Err(DbError::invalid("mode", "只允许 insert 或 replace"));
        }
        let rows = it
            .get("rows")
            .and_then(|x| x.as_array())
            .ok_or_else(|| DbError::invalid("rows", format!("表 {table} 缺少 rows")))?;
        let mut parsed = Vec::with_capacity(rows.len());
        for (j, row) in rows.iter().enumerate() {
            let arr = row
                .as_array()
                .ok_or_else(|| DbError::invalid("rows", format!("{table} 第 {j} 行不是数组")))?;
            if arr.len() != columns.len() {
                return Err(DbError::invalid(
                    "rows",
                    format!(
                        "{table} 第 {j} 行的值个数 {} 与 columns 个数 {} 不一致",
                        arr.len(),
                        columns.len()
                    ),
                ));
            }
            parsed.push(arr.iter().map(to_sql_value).collect());
        }
        jobs.push((table, columns, parsed, mode));
    }

    engine.import_begin()?;

    // `replace: true` = 先把目标表清空再导入（同一个事务内）。
    //
    // 为什么需要它：新库由引擎创建时 schema 阶段会**种下一行全局项目**（`projects.id=''`），
    // 而旧库里也有这一行 —— 直接 INSERT 会撞 `UNIQUE constraint failed: projects.id`
    // （实测踩到）。清空（而不是改成 OR REPLACE）更符合"迁移"的语义：
    // 目标端的旧数据不该和源端混在一起。
    //
    // 删除顺序 = **依赖顺序的逆序**（先删子表再删父表），否则外键会拦住删除。
    if payload.get("replace").and_then(|x| x.as_bool()).unwrap_or(false) {
        let allowed = importable_tables();
        for table in IMPORT_ORDER.iter().rev() {
            if !allowed.iter().any(|t| t == table) {
                continue;
            }
            engine.import_write(|conn| {
                conn.execute(&format!("DELETE FROM \"{table}\""), [])
                    .map(|_| ())
                    .map_err(DbError::from)
            })?;
        }
    }

    let mut report = serde_json::Map::new();
    let mut total = 0usize;
    for (table, columns, rows, mode) in &jobs {
        let verb = if mode == "replace" { "INSERT OR REPLACE" } else { "INSERT" };
        let placeholders: Vec<String> = (1..=columns.len()).map(|i| format!("?{i}")).collect();
        let sql = format!(
            "{verb} INTO \"{table}\" ({}) VALUES ({})",
            columns
                .iter()
                .map(|c| format!("\"{c}\""))
                .collect::<Vec<_>>()
                .join(", "),
            placeholders.join(", ")
        );
        let res: DbResult<usize> = (|| {
            let real = engine.with_conn(|conn| real_columns(conn, table))?;
            for c in columns {
                if !real.contains(c) {
                    return Err(DbError::invalid(
                        "columns",
                        format!("表 {table} 没有列 {c}"),
                    ));
                }
            }
            engine.import_write(|conn| {
                let mut stmt = conn.prepare_cached(&sql).map_err(DbError::from)?;
                let mut n = 0usize;
                for vals in rows {
                    stmt.execute(params_from_iter(vals.iter())).map_err(DbError::from)?;
                    n += 1;
                }
                Ok(n)
            })
        })();
        match res {
            Ok(n) => {
                total += n;
                // **累加**而不是覆盖：同一张表可能分多批提交，
                // 早先用 insert 覆盖，调用方看到的是"最后一批的行数"
                // （实测：821 行的 messages 只报 321），会被误判成"少搬了"。
                let prev = report.get(table).and_then(|v| v.as_u64()).unwrap_or(0);
                report.insert(table.clone(), json!(prev + n as u64));
            }
            Err(e) => {
                // 回滚整个事务：新库回到导入前的状态
                let _ = engine.import_rollback();
                return Err(DbError::new(
                    e.code,
                    format!("导入表 {table} 失败，已回滚整个事务：{}", e.message),
                ));
            }
        }
    }
    engine.import_commit()?;
    Ok(json!({ "ok": true, "tables": report, "total_rows": total }))
}

/// 开始一个**跨调用**的导入事务（CLI 分表导入时使用；一次 CLI 进程内也会用它）
pub fn import_begin(engine: &Engine, p: &Value) -> DbResult<Value> {
    let _ = p;
    engine.import_begin()?;
    Ok(json!({ "ok": true, "note": "导入事务已开启（import.end 提交，import.rollback 回滚）" }))
}

/// 提交导入事务
pub fn import_end(engine: &Engine, p: &Value) -> DbResult<Value> {
    let _ = p;
    let written = engine.import_commit()?;
    Ok(json!({ "ok": true, "written": written }))
}

/// 回滚导入事务（导入中任何一步失败时的收尾）
pub fn import_rollback(engine: &Engine, p: &Value) -> DbResult<Value> {
    let _ = p;
    engine.import_rollback()?;
    Ok(json!({ "ok": true }))
}

/// 对账：逐表行数 + 内容摘要（**迁移成败的判断依据**）
///
/// 摘要算法刻意选择"稳定且便宜"：对每行的所有列按固定顺序拼接（NULL 用 `\0` 占位、
/// 数字用十进制、文本原样）后取 64 位 FNV-1a。它在 SQLite 侧和 JS 侧都好实现（见
/// `tools/migrate/lib/digest.mjs`），因此**两个引擎能算出同一个值**并直接比对。
///
/// 注意：只比"数据行"，不比 FTS 影子表（迁移不搬它们）。
pub fn table_digest(engine: &Engine, p: &Value) -> DbResult<Value> {
    let tables: Vec<String> = match p.get("tables") {
        Some(Value::Array(a)) => a
            .iter()
            .map(|x| {
                x.as_str()
                    .map(|s| s.to_string())
                    .ok_or_else(|| DbError::invalid("tables", "元素必须是字符串"))
            })
            .collect::<DbResult<Vec<_>>>()?,
        _ => importable_tables(),
    };

    engine.with_conn(|conn| {
        let mut out = serde_json::Map::new();
        let allowed = importable_tables();
        for t in &tables {
            if !allowed.iter().any(|x| x == t) {
                return Err(DbError::invalid("tables", format!("{t} 不是可对账的表")));
            }
            let mut stmt = conn
                .prepare(&format!("SELECT * FROM \"{t}\""))
                .map_err(DbError::from)?;
            let col_count = stmt.column_count();
            let mut rows = stmt.query([]).map_err(DbError::from)?;
            let mut hash: i64 = -0x7a5b_2a3d_1c4f_9e11i64; // FNV-1a 64 位偏移基准
            let mut n: i64 = 0;
            while let Some(row) = rows.next().map_err(DbError::from)? {
                n += 1;
                for i in 0..col_count {
                    let v: SqlValue = row.get(i).map_err(DbError::from)?;
                    for byte in value_bytes(&v) {
                        hash ^= i64::from(byte);
                        hash = hash.wrapping_mul(0x100_0000_01b3);
                    }
                    // 列分隔符（否则 ("ab","c") 与 ("a","bc") 会撞）
                    hash ^= 0x1f;
                    hash = hash.wrapping_mul(0x100_0000_01b3);
                }
                // 行分隔符
                hash ^= 0x1e;
                hash = hash.wrapping_mul(0x100_0000_01b3);
            }
            out.insert(
                t.clone(),
                json!({ "rows": n, "digest": format!("{:016x}", hash as u64) }),
            );
        }
        Ok(Value::Object(out))
    })
}

/// 按与 JS 侧一致的规则把值变成字节（类型标签 + 内容），避免 1 与 "1" 摘要相同。
///
/// ⚠️ **整数值的 REAL 必须按 'I' 编码**（第 92 波实测踩到）：
/// `messages.cost` / `graph_nodes.weight` 这类 REAL 列里存的是 `0`、`1` 这样的整数值。
/// Rust 侧能从 sqlite 类型看出它是 Real，但 JS 侧（sql.js）拿到的是 `number`，
/// `Number.isInteger(0)` 为真 —— 于是同一条数据两边编出不同的字节序列，
/// 摘要必然对不上（表现为"行数一致、内容逐行一致，但摘要不同"，极易误判成数据搬错）。
/// 统一规则：**整数值一律 'I'，只有真正带小数的才 'R'**。
fn value_bytes(v: &SqlValue) -> Vec<u8> {
    match v {
        SqlValue::Null => vec![b'N'],
        SqlValue::Integer(i) => {
            let mut b = vec![b'I'];
            b.extend_from_slice(i.to_string().as_bytes());
            b
        }
        SqlValue::Real(f) => {
            if f.fract() == 0.0 && f.abs() < 1e15 {
                // 整数值的 REAL：与 JS 的 Number.isInteger 分支对齐
                let mut b = vec![b'I'];
                b.extend_from_slice((*f as i64).to_string().as_bytes());
                b
            } else {
                let mut b = vec![b'R'];
                b.extend_from_slice(f.to_string().as_bytes());
                b
            }
        }
        SqlValue::Text(s) => {
            let mut b = vec![b'T'];
            b.extend_from_slice(s.as_bytes());
            b
        }
        SqlValue::Blob(blob) => {
            let mut b = vec![b'B'];
            for byte in blob {
                b.extend_from_slice(format!("{byte:02x}").as_bytes());
            }
            b
        }
    }
}

/// 对**直接给出的一组行**算摘要（不读表）。
///
/// 用途：跨语言一致性测试。TS 侧 `digestRows` 与这里必须对同一组行算出同一个值，
/// 否则对账工具会把"搬对了"误报成"搬错了"（实测踩到过：整数值的 REAL 编码不一致）。
pub fn digest_rows(p: &Value) -> DbResult<Value> {
    let rows = p
        .get("rows")
        .and_then(|x| x.as_array())
        .ok_or_else(|| DbError::missing("rows（二维数组）"))?;
    let mut hash: i64 = -0x7a5b_2a3d_1c4f_9e11i64;
    let mut n: i64 = 0;
    for (i, row) in rows.iter().enumerate() {
        let arr = row
            .as_array()
            .ok_or_else(|| DbError::invalid("rows", format!("第 {i} 行不是数组")))?;
        n += 1;
        for v in arr {
            for byte in value_bytes(&to_sql_value(v)) {
                hash ^= i64::from(byte);
                hash = hash.wrapping_mul(0x100_0000_01b3);
            }
            hash ^= 0x1f;
            hash = hash.wrapping_mul(0x100_0000_01b3);
        }
        hash ^= 0x1e;
        hash = hash.wrapping_mul(0x100_0000_01b3);
    }
    Ok(json!({ "rows": n, "digest": format!("{:016x}", hash as u64) }))
}

/// 会话全文索引的重建/对齐（`fts.rebuild`）。
///
/// ## 与渲染侧 `rebuildSessionFts` 的对应关系
///
/// 渲染侧的逻辑是"先删孤儿、再从日志补缺"：
/// - 孤儿 = `session_fts` 里有、但 `messages`（索引）与会话日志里都没有的 message_id；
/// - 补缺 = 日志里有、FTS 里没有的。
///
/// Rust 侧只认 `messages` 表（日志在渲染进程侧），所以：
/// - `keep_ids`（可选）：渲染侧把"日志里存在但索引里没有"的 id 传进来，
///   这些 id **不能被当作孤儿删除** —— 否则日志里还有的消息会丢掉全文索引；
/// - 删孤儿 → 补缺（从 messages 里取未索引的行），单事务完成。
///
/// 注意 `session_fts` **没有外键级联**（虚拟表），所以消息删除后 FTS 行不会自动消失 ——
/// 这正是渲染侧要写那套对齐逻辑的原因。
pub fn fts_rebuild(engine: &Engine, p: &Value) -> DbResult<Value> {
    let session_id = req_text(p, "session_id")?;
    // 渲染侧日志里存在、必须保留的 id
    let keep: Vec<String> = match p.get("keep_ids") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(a)) => a
            .iter()
            .map(|x| {
                x.as_str()
                    .map(|s| s.to_string())
                    .ok_or_else(|| DbError::invalid("keep_ids", "元素必须是字符串"))
            })
            .collect::<DbResult<Vec<_>>>()?,
        Some(_) => return Err(DbError::invalid("keep_ids", "期望字符串数组")),
    };

    engine.write_tx(|tx| {
        // 1) 删孤儿：FTS 里有、但既不在 messages 也不在 keep 集合里的
        let mut stmt = tx
            .prepare(
                "SELECT message_id FROM session_fts WHERE session_id = ?1",
            )
            .map_err(DbError::from)?;
        let rows = stmt
            .query_map(params![session_id], |r| r.get::<_, Option<String>>(0))
            .map_err(DbError::from)?;
        let mut fts_ids: Vec<String> = Vec::new();
        for r in rows {
            if let Some(id) = r.map_err(DbError::from)? {
                fts_ids.push(id);
            }
        }
        drop(stmt);

        let keep_set: std::collections::HashSet<&String> = keep.iter().collect();
        let mut removed = 0usize;
        for id in &fts_ids {
            if keep_set.contains(id) {
                continue;
            }
            let exists: i64 = tx
                .query_row(
                    "SELECT COUNT(*) FROM messages WHERE id = ?1",
                    params![id],
                    |r| r.get(0),
                )
                .map_err(DbError::from)?;
            if exists == 0 {
                tx.execute(
                    "DELETE FROM session_fts WHERE session_id = ?1 AND message_id = ?2",
                    params![session_id, id],
                )
                .map_err(DbError::from)?;
                removed += 1;
            }
        }

        // 2) 对齐**内容**：messages 里可见的行逐条与 FTS 比对。
        //
        // ⚠️ 这里不能"已索引就跳过" —— 实测生产库 837 行 FTS 里 **84.3% 的 content 是空的**
        // （长度 ≤2 的占 93.9%，平均 5.2 字），也就是说**全文检索从来没有真正生效过**：
        // 行都在、正文没进去。这不是"缺行"，而是"行在、内容错"。
        // 只补缺的写法会看到"已索引"就跳过，永远修不好（实测 added:0 就是这个问题）。
        // 所以改成**内容长度不符就重写**（先删该 message_id 的行再插）。
        let indexed_len: std::collections::HashMap<String, i64> = {
            let mut stmt2 = tx
                .prepare("SELECT message_id, length(content) FROM session_fts WHERE session_id = ?1")
                .map_err(DbError::from)?;
            let rows2 = stmt2
                .query_map(params![session_id], |r| {
                    Ok((r.get::<_, Option<String>>(0)?, r.get::<_, Option<i64>>(1)?))
                })
                .map_err(DbError::from)?;
            let mut m = std::collections::HashMap::new();
            for r in rows2 {
                let (id, len) = r.map_err(DbError::from)?;
                if let Some(id) = id {
                    m.insert(id, len.unwrap_or(0));
                }
            }
            m
        };
        let mut stmt = tx
            .prepare(
                "SELECT id, content, role, timestamp FROM messages \
                 WHERE session_id = ?1 AND hidden = 0 ORDER BY timestamp ASC",
            )
            .map_err(DbError::from)?;
        let rows = stmt
            .query_map(params![session_id], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, Option<String>>(2)?,
                    r.get::<_, Option<i64>>(3)?,
                ))
            })
            .map_err(DbError::from)?;
        let mut added = 0usize;
        let mut refreshed = 0usize;
        for r in rows {
            let (id, content, role, timestamp) = r.map_err(DbError::from)?;
            if keep_set.contains(&&id) {
                continue;
            }
            // ⚠️ 长度判定必须用**切分后**的文本：索引里存的就是切分形式，
            // 用原文长度会导致"每次 rebuild 都认为不一致"（白写一遍）
            let tokenized = crate::fts::tokenize(content.as_deref().unwrap_or(""));
            let want_len = tokenized.chars().count() as i64;
            match indexed_len.get(&id) {
                // 已在索引且长度一致 → 认为已对齐
                Some(len) if *len == want_len => continue,
                // 已在索引但内容不符（含"正文为空"的坏行）→ 重写
                Some(_) => {
                    tx.execute(
                        "DELETE FROM session_fts WHERE session_id = ?1 AND message_id = ?2",
                        params![session_id, id],
                    )
                    .map_err(DbError::from)?;
                    tx.execute(
                        "INSERT INTO session_fts (session_id, message_id, content, role, timestamp) \
                         VALUES (?1, ?2, ?3, ?4, ?5)",
                        params![
                            session_id,
                            id,
                            crate::fts::tokenize(&content.clone().unwrap_or_default()),
                            role.clone().unwrap_or_default(),
                            timestamp.unwrap_or(0)
                        ],
                    )
                    .map_err(DbError::from)?;
                    refreshed += 1;
                }
                // 不在索引 → 新增
                None => {
                    tx.execute(
                        "INSERT INTO session_fts (session_id, message_id, content, role, timestamp) \
                         VALUES (?1, ?2, ?3, ?4, ?5)",
                        params![
                            session_id,
                            id,
                            tokenized.clone(),
                            role.unwrap_or_default(),
                            timestamp.unwrap_or(0)
                        ],
                    )
                    .map_err(DbError::from)?;
                    added += 1;
                }
            }
        }

        Ok(json!({ "removed": removed, "added": added, "refreshed": refreshed, "session_id": session_id }))
    })
}

/// 删除会话的全部全文索引行（消息删除/会话删除时调用；虚拟表没有级联）
pub fn fts_delete_session(engine: &Engine, p: &Value) -> DbResult<Value> {
    let session_id = req_text(p, "session_id")?;
    engine.write_tx(|tx| {
        let n = tx
            .execute("DELETE FROM session_fts WHERE session_id = ?1", params![session_id])
            .map_err(DbError::from)?;
        Ok(json!({ "written": n }))
    })
}

/// 全文检索（返回命中消息的 id / 角色 / 时间 / **正文**，供搜索界面用）
///
/// ## 三个必须说明的点
///
/// 1. **查询要按同一套规则切分**：索引里存的是 CJK bigram 形式，
///    所以 `存储迁移` 必须转成 `"存储" "迁移"` 之类的表达式才能命中
///    （见 `crate::fts::query_expr`）。不切分的话中文永远搜不到 —— 那正是修复前的状态。
/// 2. **不返回 `snippet()`**：索引里存的是切分后的文本，snippet 出来是
///    `存 存储 储 …` 这种形式，没法展示。改成返回真实正文（取自 `messages`），
///    由渲染侧在正文上做高亮 —— 这也符合"索引是索引、正文在正文表里"的分工。
///    `limit` 有上限（默认 10、最大 50），所以正文读取量是有界的。
/// 3. **`session_id` 可选**：不传就是**跨会话搜索**（原来的渲染侧实现里
///    "全局搜索"其实从没生效过 —— 见 `session-search.ts` 的 matchExpr 死代码）。
pub fn fts_search(engine: &Engine, p: &Value) -> DbResult<Value> {
    let session_id = opt_text(p, "session_id")?;
    let raw_query = req_text(p, "query")?;
    // 空查询 / 全是不可索引字符：明确报参数错误，**不要**退化成"匹配全表"
    let expr = crate::fts::query_expr(&raw_query)
        .ok_or_else(|| DbError::invalid("query", "查询词为空或全是不可索引字符"))?;
    let limit = limit_of(p)?;
    let desc = p.get("order").and_then(|x| x.as_str()) != Some("asc");
    engine.with_conn(|conn| {
        let dir = if desc { "DESC" } else { "ASC" };
        let sql = match &session_id {
            Some(_) => format!(
                "SELECT f.message_id, f.role, f.timestamp, f.session_id, m.content, s.title \
                 FROM session_fts f \
                 LEFT JOIN messages m ON m.id = f.message_id \
                 LEFT JOIN sessions s ON s.id = f.session_id \
                 WHERE f.session_fts MATCH ?1 AND f.session_id = ?2 \
                 ORDER BY f.timestamp {dir} LIMIT ?3"
            ),
            None => format!(
                "SELECT f.message_id, f.role, f.timestamp, f.session_id, m.content, s.title \
                 FROM session_fts f \
                 LEFT JOIN messages m ON m.id = f.message_id \
                 LEFT JOIN sessions s ON s.id = f.session_id \
                 WHERE f.session_fts MATCH ?1 \
                 ORDER BY f.timestamp {dir} LIMIT ?2"
            ),
        };
        let mut stmt = conn.prepare_cached(&sql).map_err(DbError::from)?;
        let map_row = |r: &rusqlite::Row<'_>| -> rusqlite::Result<Value> {
            Ok(json!({
                "message_id": r.get::<_, Option<String>>(0)?,
                "role": r.get::<_, Option<String>>(1)?,
                "timestamp": r.get::<_, Option<i64>>(2)?,
                "session_id": r.get::<_, Option<String>>(3)?,
                "content": r.get::<_, Option<String>>(4)?.unwrap_or_default(),
                "session_title": r.get::<_, Option<String>>(5)?,
            }))
        };
        let mut items = Vec::new();
        match &session_id {
            Some(sid) => {
                let rows = stmt
                    .query_map(params![expr, sid, limit as i64], map_row)
                    .map_err(DbError::from)?;
                for r in rows {
                    items.push(r.map_err(DbError::from)?);
                }
            }
            None => {
                let rows = stmt
                    .query_map(params![expr, limit as i64], map_row)
                    .map_err(DbError::from)?;
                for r in rows {
                    items.push(r.map_err(DbError::from)?);
                }
            }
        }
        Ok(json!({
            "items": items,
            "has_more": false,
            "next_cursor": Value::Null,
            "scope": session_id.unwrap_or_else(|| "<all>".to_string()),
        }))
    })
}

/// 从 `messages` 重建全文索引（迁移不搬 FTS 影子表，导入后调这个）
pub fn rebuild_fts(engine: &Engine, p: &Value) -> DbResult<Value> {
    let _ = p;
    engine.with_conn(|conn| {
        // FTS4 与 FTS5 都支持 DELETE FROM + INSERT INTO ... SELECT
        conn.execute("DELETE FROM session_fts", []).map_err(DbError::from)?;
        let n = conn
            .execute(
                "INSERT INTO session_fts (message_id, session_id, content) \
                 SELECT id, session_id, content FROM messages WHERE hidden = 0",
                [],
            )
            .map_err(DbError::from)?;
        Ok(json!({ "indexed": n }))
    })
}

/// 库内实际存在、且允许导入的表（供迁移工具决定搬哪些）
pub fn importable_existing(engine: &Engine, p: &Value) -> DbResult<Value> {
    let _ = p;
    let allowed = importable_tables();
    engine.with_conn(|conn| {
        let mut stmt = conn
            .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
            .map_err(DbError::from)?;
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(DbError::from)?;
        let mut present = Vec::new();
        for r in rows {
            let name = r.map_err(DbError::from)?;
            if allowed.iter().any(|t| t == &name) {
                present.push(name);
            }
        }
        Ok(json!({ "tables": present, "order": IMPORT_ORDER, "known": allowed }))
    })
}

/// 迁移状态（是否已导入过、导了多少行）—— 供"只迁一次"的判断与诊断
pub fn migration_status(engine: &Engine, p: &Value) -> DbResult<Value> {
    let _ = p;
    let counts = engine.table_counts(
        &["projects", "sessions", "messages", "settings"]
            .iter()
            .map(|s| s.to_string())
            .collect::<Vec<_>>(),
    )?;
    let marker = engine.with_conn(|conn| {
        let v: Option<String> = conn
            .query_row("SELECT value FROM settings WHERE key = 'codem-storage-migrated-at'", [], |r| r.get(0))
            .ok();
        Ok(v)
    })?;
    Ok(json!({
        "migrated_at": marker,
        "counts": counts.into_iter().collect::<std::collections::BTreeMap<_, _>>(),
        "importable_tables": importable_tables().len(),
    }))
}

/// 记录迁移完成标记（值 = 毫秒时间戳）
pub fn mark_migrated(engine: &Engine, p: &Value) -> DbResult<Value> {
    let at = p
        .get("at")
        .and_then(|x| x.as_i64())
        .unwrap_or_else(crate::schema::now_ms);
    engine.write_tx(|tx| {
        tx.execute(
            "INSERT INTO settings (key, value, updated_at) VALUES ('codem-storage-migrated-at', ?1, ?2) \
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            rusqlite::params![at.to_string(), crate::schema::now_ms()],
        )
        .map_err(DbError::from)?;
        Ok(json!({ "written": 1, "at": at }))
    })
}

#[cfg(test)]
mod event_tests {
    use crate::{dispatch, engine::Engine};
    use serde_json::json;

    fn eng(name: &str) -> (tempfile::TempDir, Engine) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(format!("{name}.bin"));
        (dir, Engine::open(&path).unwrap())
    }
    fn call(e: &Engine, cmd: &str, p: serde_json::Value) -> serde_json::Value {
        dispatch(e, cmd, &p).unwrap_or_else(|err| panic!("{cmd} 失败：{err}"))
    }
    fn seed_session(e: &Engine, id: &str) {
        call(e, "projects.upsert", json!({ "id": "p1", "name": "P" }));
        call(e, "sessions.upsert", json!({ "id": id, "project_id": "p1" }));
    }

    /// seq 是**全局** AUTOINCREMENT，不是每会话从 1 开始。
    ///
    /// 这条断言是渲染侧设计的前提：正因为 seq 全局，才不能本地预分配
    /// （不知道全局水位会撞主键），必须由引擎分配并回传真实值。
    #[test]
    fn seq_is_global_autoincrement_not_per_session() {
        let (_d, e) = eng("evglobal");
        seed_session(&e, "s1");
        seed_session(&e, "s2");
        let a1 = call(&e, "events.append", json!({ "session_id": "s1", "event_type": "t" }));
        let b1 = call(&e, "events.append", json!({ "session_id": "s2", "event_type": "t" }));
        let a2 = call(&e, "events.append", json!({ "session_id": "s1", "event_type": "t" }));
        let (sa1, sb1, sa2) = (a1["seq"].as_i64().unwrap(), b1["seq"].as_i64().unwrap(), a2["seq"].as_i64().unwrap());
        assert!(sb1 > sa1, "第二个会话的 seq 必须大于第一个（全局单调），实际 {sb1} vs {sa1}");
        assert!(sa2 > sb1, "回到 s1 继续追加时 seq 继续增大，实际 {sa2}");
        // s1 自己只有两条事件，但 seq 不连续（中间夹了 s2 的）——这正是"全局"的含义
        assert_ne!(sa2, sa1 + 1, "seq 不应在会话内连续递增");
    }

    #[test]
    fn batch_allocates_consecutive_seqs() {
        let (_d, e) = eng("evbatch");
        seed_session(&e, "s1");
        let r = call(
            &e,
            "events.append_batch",
            json!({ "session_id": "s1", "events": [
                { "type": "a" }, { "type": "b" }, { "type": "c" }
            ] }),
        );
        let seqs: Vec<i64> = r["seqs"].as_array().unwrap().iter().map(|x| x.as_i64().unwrap()).collect();
        assert_eq!(seqs.len(), 3);
        assert_eq!(
            seqs[2] - seqs[0],
            2,
            "同一批次内的 seq 必须连续（渲染侧靠连续性判断缺口）：{seqs:?}"
        );
        assert_eq!(r["written"], json!(3));
    }

    #[test]
    fn batch_rejects_empty_and_bad_items_atomically() {
        let (_d, e) = eng("evbatchbad");
        seed_session(&e, "s1");
        assert!(dispatch(&e, "events.append_batch", &json!({ "session_id": "s1", "events": [] })).is_err());
        // 第二条缺 type → 整批不落
        let err = dispatch(
            &e,
            "events.append_batch",
            &json!({ "session_id": "s1", "events": [{ "type": "a" }, { "payload": {} }] }),
        )
        .unwrap_err();
        assert!(format!("{err}").contains("type"), "应指出缺哪个字段：{err}");
        let n = call(&e, "events.count", json!({ "session_id": "s1" }));
        assert_eq!(n["count"], json!(0), "批次失败不得留下部分写入");
    }

    #[test]
    fn list_pages_and_from_seq_filters() {
        let (_d, e) = eng("evlist");
        seed_session(&e, "s1");
        for i in 0..10 {
            call(&e, "events.append", json!({ "session_id": "s1", "event_type": format!("e{i}") }));
        }
        let all = call(&e, "events.list", json!({ "session_id": "s1", "limit": 100 }));
        assert_eq!(all["items"].as_array().unwrap().len(), 10);
        assert_eq!(all["items"][0]["type"], json!("e0"), "默认按 seq 升序");
        assert_eq!(all["has_more"], json!(false));

        // 分页：多取一行判断 has_more
        let p1 = call(&e, "events.list", json!({ "session_id": "s1", "limit": 4 }));
        assert_eq!(p1["items"].as_array().unwrap().len(), 4);
        assert_eq!(p1["has_more"], json!(true));

        // from_seq：只读水位之后的事件（增量同步靠它）
        let third = all["items"][3]["seq"].as_i64().unwrap();
        let from = call(&e, "events.list", json!({ "session_id": "s1", "from_seq": third, "limit": 100 }));
        assert_eq!(from["items"].as_array().unwrap().len(), 7, "seq >= 第 4 条 → 剩 7 条");
        assert_eq!(from["items"][0]["seq"], json!(third));

        // desc
        let desc = call(&e, "events.list", json!({ "session_id": "s1", "limit": 3, "order": "desc" }));
        assert_eq!(desc["items"][0]["type"], json!("e9"));
    }

    #[test]
    fn watermark_reports_global_and_per_session() {
        let (_d, e) = eng("evwm");
        seed_session(&e, "s1");
        seed_session(&e, "s2");
        call(&e, "events.append", json!({ "session_id": "s1", "event_type": "a" }));
        call(&e, "events.append", json!({ "session_id": "s2", "event_type": "b" }));
        let g = call(&e, "events.watermark", json!({}));
        assert_eq!(g["count"], json!(2));
        assert_eq!(g["scope"], json!("<all>"));
        let s1 = call(&e, "events.watermark", json!({ "session_id": "s1" }));
        assert_eq!(s1["count"], json!(1));
        let s2 = call(&e, "events.watermark", json!({ "session_id": "s2" }));
        assert!(s2["max_seq"].as_i64().unwrap() > s1["max_seq"].as_i64().unwrap());
    }

    #[test]
    fn compact_requires_real_anchor_and_removes_old_events() {
        let (_d, e) = eng("evcompact");
        seed_session(&e, "s1");
        call(&e, "events.append", json!({ "session_id": "s1", "event_type": "session_meta", "payload": { "k": 1 } }));
        for i in 0..5 {
            call(&e, "events.append", json!({ "session_id": "s1", "event_type": format!("e{i}") }));
        }
        let all = call(&e, "events.list", json!({ "session_id": "s1", "limit": 100 }));
        let items = all["items"].as_array().unwrap();
        let anchor_seq = items[3]["seq"].as_i64().unwrap(); // 第 4 条（seq 索引 3）

        let r = call(
            &e,
            "events.compact",
            json!({ "session_id": "s1", "snapshot_seq": anchor_seq, "cutoff_seq": anchor_seq, "payload": { "messages": [] } }),
        );
        assert_eq!(r["snapshot_seq"], json!(anchor_seq), "快照必须占用锚点自己的 seq");
        let after = call(&e, "events.list", json!({ "session_id": "s1", "limit": 100 }));
        let seqs: Vec<i64> = after["items"].as_array().unwrap().iter().map(|x| x["seq"].as_i64().unwrap()).collect();
        assert!(seqs.contains(&anchor_seq), "锚点 seq 上应是快照");
        let snap = after["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|x| x["seq"].as_i64() == Some(anchor_seq))
            .unwrap();
        assert_eq!(snap["type"], json!("session_snapshot"));
        // session_meta 必须保留（承载会话身份）
        assert!(
            after["items"].as_array().unwrap().iter().any(|x| x["type"] == json!("session_meta")),
            "session_meta 不该被压缩删掉"
        );

        // 不存在的锚点必须报错（不能凭空造孤立快照）
        let err = dispatch(
            &e,
            "events.compact",
            &json!({ "session_id": "s1", "snapshot_seq": 999_999, "cutoff_seq": 999_999, "payload": {} }),
        )
        .unwrap_err();
        assert_eq!(err.code, crate::ErrorCode::NotFound);
    }

    #[test]
    fn fork_copies_events_to_another_session() {
        let (_d, e) = eng("evfork");
        seed_session(&e, "s1");
        seed_session(&e, "s2");
        for i in 0..3 {
            call(&e, "events.append", json!({ "session_id": "s1", "event_type": format!("e{i}"), "payload": { "i": i } }));
        }
        let r = call(&e, "events.fork", json!({ "source_session_id": "s1", "target_session_id": "s2" }));
        assert_eq!(r["written"], json!(3));
        let s2 = call(&e, "events.list", json!({ "session_id": "s2", "limit": 100 }));
        assert_eq!(s2["items"].as_array().unwrap().len(), 3);
        // 内容按源会话 seq 升序复制
        assert_eq!(s2["items"][0]["payload"], json!("{\"i\":0}"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn import_order_covers_all_generated_tables() {
        // 这是**最关键的一致性断言**：清单由 TS schema 生成，顺序表必须覆盖它的每一项。
        // 少一项 = 那张表不会被搬 = 用户数据静默丢失（实测发生过）。
        let allowed: HashSet<String> = importable_tables().into_iter().collect();
        let ordered: HashSet<String> = IMPORT_ORDER.iter().map(|s| s.to_string()).collect();

        let missing: Vec<&String> = allowed.difference(&ordered).collect();
        let extra: Vec<&String> = ordered.difference(&allowed).collect();
        assert!(
            missing.is_empty(),
            "以下表在 TS schema 里存在、但不在 IMPORT_ORDER 里（迁移会漏搬）：{missing:?}"
        );
        assert!(
            extra.is_empty(),
            "IMPORT_ORDER 里有 schema 中不存在的表（拼错或已删）：{extra:?}"
        );
        assert_eq!(
            IMPORT_ORDER.len(),
            ordered.len(),
            "IMPORT_ORDER 里有重复项（重复会让同一张表搬两次，主键冲突）"
        );
    }

    #[test]
    fn fts_shadow_tables_are_excluded() {
        for t in importable_tables() {
            assert!(!t.starts_with("session_fts"), "{t} 是 FTS 影子表，不该出现在导入清单里");
        }
    }

    #[test]
    fn fts_filter_actually_filters() {
        // 直接验证过滤逻辑本身（而不是依赖"生成清单里恰好有 session_fts"）：
        // FTS 建表语句在 database.ts 里是独立的一条 db.run，不在 SCHEMA DDL 块内，
        // 所以 generated_tables() 里本来就没有它 —— 早先我按错误假设写了断言，被测试当场纠正。
        let raw = ["session_fts", "session_fts_content", "messages", "session_fts_segdir"];
        let kept: Vec<&str> = raw.iter().copied().filter(|t| !t.starts_with("session_fts")).collect();
        assert_eq!(kept, vec!["messages"], "FTS 前缀过滤必须生效");
    }

    #[test]
    fn generated_table_list_is_not_empty_and_has_core_tables() {
        let t = importable_tables();
        assert!(t.len() >= 35, "业务表数量异常少（生成脚本坏了？）：{}", t.len());
        for core in ["projects", "sessions", "messages", "settings", "tool_calls"] {
            assert!(t.iter().any(|x| x == core), "清单缺少核心表 {core}");
        }
        // 这三张表是"手写清单漏掉过"的那批，专门钉住
        for was_missing in ["agent_messages", "message_feedback", "needs_you_pending"] {
            assert!(
                t.iter().any(|x| x == was_missing),
                "清单又漏了 {was_missing}（这正是当初手写清单的问题）"
            );
        }
    }
}

// ========== 自动迁移（P5 第 6 段）：Rust 侧直接打开旧库 ==========
//
// ## 为什么必须由 Rust 侧做
//
// P5 第 4 段之后，引擎为 rust 时渲染进程**不再加载 WASM 数据库** —— 那正是
// "内存不再放大"的前提。所以"首次自动迁移"不能靠渲染侧读旧库：那会立刻把整库
// 读回内存，把省下来的全花回去。
//
// ## 安全边界：为什么这不是"绕过 authorizer"
//
// authorizer 禁止的是 SQL 里的 `ATTACH`（把另一个库挂进当前连接）。
// 这里用的是 SQLite 自己的**多连接**能力：`Connection::open_with_flags(旧库, READ_ONLY)`
// 开一个普通只读连接去读它 —— 两个库各自独立，没有任何 SQL 级别的挂载。
// 安全性不靠 SQL 开关，而靠"只对旧库执行固定的 SELECT"。
//
// ## 铁律
//
// 1. **只读旧库**（OPEN_READONLY），绝不写它 —— 回滚开关还要能回退到它；
// 2. **先对账再宣告成功**：逐表比对行数与内容摘要，不一致就不写标记、如实报错；
// 3. **失败不留半截**：导入走一个事务（全成或全不成）；
// 4. **孤儿行**：旧库缺少级联清理，子行可能指向不存在的父行。直接导入会触发外键失败并
//    整个事务回滚，所以按 IMPORT_ORDER 逐表导入时**跳过孤儿**并如实计数上报。

/// 子表 → 它依赖的父表（用于孤儿过滤）。只列出真正有外键的关系。
const FK_PARENTS: &[(&str, &str)] = &[
    ("sessions", "projects"),
    ("messages", "sessions"),
    ("tool_calls", "messages"),
    ("attachments", "sessions"),
    ("session_events", "sessions"),
    ("telemetry_events", "sessions"),
    ("message_feedback", "messages"),
    ("cost_records", "sessions"),
    ("prompt_drafts", "sessions"),
    ("todo_lists", "sessions"),
    ("agent_messages", "sessions"),
    ("needs_you_pending", "sessions"),
    ("notes", "notebooks"),
    ("note_links", "notes"),
    ("note_versions", "notes"),
    ("notebook_sources", "notebooks"),
    ("notebook_chunks", "notebook_sources"),
    ("flashcards", "notebooks"),
    ("graph_nodes", "notebooks"),
    ("graph_edges", "notebooks"),
    ("notebook_groups", "notebooks"),
    ("squad_members", "squads"),
    ("issue_comments", "issues"),
];

fn fk_parent_of(table: &str) -> Option<&'static str> {
    FK_PARENTS.iter().find(|(c, _)| *c == table).map(|(_, p)| *p)
}

/// 读旧库某张表的全部行；表不存在时返回空（旧库可能没有新表）
fn read_legacy_table(conn: &Connection, table: &str) -> DbResult<(Vec<Value>, usize)> {
    let exists: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
            [table],
            |r| r.get(0),
        )
        .map_err(DbError::from)?;
    if exists == 0 {
        return Ok((Vec::new(), 0));
    }
    let mut stmt = conn
        .prepare(&format!("SELECT * FROM \"{table}\""))
        .map_err(DbError::from)?;
    let col_count = stmt.column_count();
    let mut rows = stmt.query([]).map_err(DbError::from)?;
    let mut out: Vec<Value> = Vec::new();
    let mut blob_columns_seen: usize = 0;
    while let Some(row) = rows.next().map_err(DbError::from)? {
        let mut arr: Vec<Value> = Vec::with_capacity(col_count);
        for i in 0..col_count {
            let v: SqlValue = row.get(i).map_err(DbError::from)?;
            arr.push(match v {
                SqlValue::Null => Value::Null,
                SqlValue::Integer(n) => json!(n),
                SqlValue::Real(f) => json!(f),
                SqlValue::Text(s) => Value::String(s),
                SqlValue::Blob(b) => {
                    // BLOB 用**十六进制**搬运（不引入 base64 依赖；十六进制只比 base64 大 33%，
                    // 而旧库里真正的二进制列很少）。调用方拿到的是 `blobhex:<hex>` 前缀的文本，
                    // 一眼能看出它原本是 BLOB。
                    let mut hex = String::with_capacity(7 + b.len() * 2);
                    hex.push_str("blobhex:");
                    for byte in &b {
                        hex.push_str(&format!("{byte:02x}"));
                    }
                    blob_columns_seen += 1;
                    Value::String(hex)
                }
            });
        }
        out.push(Value::Array(arr));
    }
    Ok((out, blob_columns_seen))
}

/// `SELECT *` 的列名（顺序与行数组一致）
fn read_legacy_columns(conn: &Connection, table: &str) -> DbResult<Vec<String>> {
    let mut stmt = conn
        .prepare(&format!("SELECT * FROM \"{table}\" LIMIT 0"))
        .map_err(DbError::from)?;
    Ok(stmt
        .column_names()
        .iter()
        .map(|s| s.to_string())
        .collect::<Vec<_>>())
}

/// 对一组「二维数组行」按与 `table_digest` **完全相同**的规则算摘要。
///
/// 为什么要在内存里算：源端（旧库）的行已经被读成 JSON 了，
/// 只有用同一套 `value_bytes` 规则才能保证"搬得对不对"可比。
fn digest_json_rows(rows: &[Value]) -> (i64, String) {
    let mut hash: i64 = -0x7a5b_2a3d_1c4f_9e11i64;
    for row in rows {
        if let Some(arr) = row.as_array() {
            for v in arr {
                let sv: SqlValue = match v {
                    Value::Null => SqlValue::Null,
                    Value::Bool(b) => SqlValue::Integer(i64::from(*b)),
                    Value::Number(n) => {
                        if let Some(i) = n.as_i64() {
                            SqlValue::Integer(i)
                        } else {
                            SqlValue::Real(n.as_f64().unwrap_or(0.0))
                        }
                    }
                    Value::String(s) => SqlValue::Text(s.clone()),
                    other => SqlValue::Text(other.to_string()),
                };
                for byte in value_bytes(&sv) {
                    hash ^= i64::from(byte);
                    hash = hash.wrapping_mul(0x100_0000_01b3);
                }
                hash ^= 0x1f;
                hash = hash.wrapping_mul(0x100_0000_01b3);
            }
        }
        hash ^= 0x1e;
        hash = hash.wrapping_mul(0x100_0000_01b3);
    }
    (rows.len() as i64, format!("{:016x}", hash as u64))
}

/// **自动迁移**：把旧库（sql.js 落盘的 `codem-db.bin`）搬进当前 Rust 库。
///
/// 参数：`{ "legacy_path": "…", "dry_run": false }`
pub fn auto_migrate(engine: &Engine, p: &Value) -> DbResult<Value> {
    let legacy_path = p
        .get("legacy_path")
        .and_then(|x| x.as_str())
        .ok_or_else(|| DbError::missing("legacy_path"))?
        .to_string();
    let dry_run = p.get("dry_run").and_then(|x| x.as_bool()).unwrap_or(false);

    if !std::path::Path::new(&legacy_path).exists() {
        return Err(DbError::not_found(format!("旧库不存在：{legacy_path}")));
    }

    // 只读打开：绝不写旧库（回滚开关还要用它）
    let legacy = Connection::open_with_flags(
        &legacy_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_URI,
    )
    .map_err(DbError::from)?;

    // 先确认旧库"能读"：坏的源不该被搬进新库。
    //
    // ⚠️ 这里**不能**用 `PRAGMA quick_check`（实测踩到）：旧库里有 **FTS4** 的
    // `session_fts`，而 FTS4 的完整性检查会试图重建倒排索引 —— 在只读连接上直接失败：
    // `unable to validate the inverted index for FTS4 table main.session_fts:
    //  attempt to write a readonly database`。
    // 旧库是只读打开的（回滚开关还要用它，绝不能写），所以改用**只读探针**：
    // 能列举表 + 稍后逐表读行就算"可读"。真正的硬证据是导入之后的逐表对账。
    let tables_readable: i64 = legacy
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table'",
            [],
            |r| r.get(0),
        )
        .map_err(|e| DbError::new(ErrorCode::Corrupt, format!("旧库不可读（无法列举表）：{e}")))?;
    if tables_readable == 0 {
        return Err(DbError::new(
            ErrorCode::Corrupt,
            "旧库里没有任何表（不是 Codem 的库？）",
        ));
    }

    let allowed = importable_tables();
    let mut jobs: Vec<Value> = Vec::new();
    let mut source_rows: Vec<(String, i64, String)> = Vec::new();
    let mut skipped: Vec<(String, i64)> = Vec::new();
    let mut blob_columns_total: usize = 0;
    // 每张表"有效主键"的集合（父表的），用于过滤子表的孤儿行
    let mut id_sets: std::collections::HashMap<String, std::collections::HashSet<String>> =
        std::collections::HashMap::new();

    for table in IMPORT_ORDER {
        if !allowed.iter().any(|t| t == table) {
            continue;
        }
        let columns = match read_legacy_columns(&legacy, table) {
            Ok(c) if !c.is_empty() => c,
            _ => {
                skipped.push((table.to_string(), 0));
                continue;
            }
        };
        let (mut rows, blob_cols) = read_legacy_table(&legacy, table)?;
        blob_columns_total += blob_cols;

        // 孤儿过滤：有父表时，丢弃"父行不存在"的子行
        if let Some(parent) = fk_parent_of(table) {
            if let Some(valid) = id_sets.get(parent) {
                let fk_col = columns
                    .iter()
                    .position(|c| c == &format!("{}_id", parent.trim_end_matches('s')))
                    .or_else(|| columns.iter().position(|c| c == "parent_id"))
                    .or_else(|| columns.iter().position(|c| c == "note_id"))
                    .or_else(|| columns.iter().position(|c| c == "issue_id"));
                if let Some(idx) = fk_col {
                    let before = rows.len();
                    rows.retain(|r| {
                        r.as_array()
                            .and_then(|a| a.get(idx))
                            .and_then(|v| v.as_str())
                            .map(|s| valid.contains(s))
                            .unwrap_or(false)
                    });
                    let dropped = before - rows.len();
                    if dropped > 0 {
                        skipped.push((format!("{table}(孤儿)"), dropped as i64));
                    }
                }
            }
        }

        // 记录本表主键，供后面的子表过滤
        if let Some(id_idx) = columns.iter().position(|c| c == "id") {
            let set: std::collections::HashSet<String> = rows
                .iter()
                .filter_map(|r| {
                    r.as_array()
                        .and_then(|a| a.get(id_idx))
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string())
                })
                .collect();
            id_sets.insert(table.to_string(), set);
        }

        let (n, digest) = digest_json_rows(&rows);
        source_rows.push((table.to_string(), n, digest));
        if !rows.is_empty() {
            jobs.push(json!({
                "table": table,
                "columns": columns,
                "rows": rows,
                "mode": "insert",
            }));
        }
    }

    if dry_run {
        return Ok(json!({
            "dry_run": true,
            "legacy_path": legacy_path,
            "tables": jobs.len(),
            "rows": source_rows.iter().map(|(_, n, _)| *n).sum::<i64>(),
            "per_table": source_rows
                .iter()
                .map(|(t, n, d)| json!({ "table": t, "rows": n, "digest": d }))
                .collect::<Vec<_>>(),
        }));
    }

    // 单事务导入（`replace: true` 会先清空目标表：目标端的旧数据不该和源端混在一起）
    let payload = json!({ "tables": jobs, "replace": true });
    let imported = import_all(engine, &payload)?;
    let _ = imported;

    // **对账**：逐表比对行数与内容摘要（两端各自算）
    let mut mismatches: Vec<Value> = Vec::new();
    let mut reconciled: Vec<Value> = Vec::new();
    for (table, src_rows, src_digest) in &source_rows {
        let after = engine.with_conn(|conn| {
            let exists: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                    [table.as_str()],
                    |r| r.get(0),
                )
                .map_err(DbError::from)?;
            if exists == 0 {
                return Ok((0i64, String::new()));
            }
            let mut stmt = conn
                .prepare(&format!("SELECT * FROM \"{table}\""))
                .map_err(DbError::from)?;
            let col_count = stmt.column_count();
            let mut rows = stmt.query([]).map_err(DbError::from)?;
            let mut hash: i64 = -0x7a5b_2a3d_1c4f_9e11i64;
            let mut n: i64 = 0;
            while let Some(row) = rows.next().map_err(DbError::from)? {
                n += 1;
                for i in 0..col_count {
                    let v: SqlValue = row.get(i).map_err(DbError::from)?;
                    for byte in value_bytes(&v) {
                        hash ^= i64::from(byte);
                        hash = hash.wrapping_mul(0x100_0000_01b3);
                    }
                    hash ^= 0x1f;
                    hash = hash.wrapping_mul(0x100_0000_01b3);
                }
                hash ^= 0x1e;
                hash = hash.wrapping_mul(0x100_0000_01b3);
            }
            Ok((n, format!("{:016x}", hash as u64)))
        })?;
        if after.0 != *src_rows || (after.1 != *src_digest && *src_rows > 0) {
            mismatches.push(json!({
                "table": table,
                "source_rows": src_rows, "source_digest": src_digest,
                "target_rows": after.0, "target_digest": after.1,
            }));
        } else {
            reconciled.push(json!({ "table": table, "rows": src_rows, "digest": src_digest }));
        }
    }

    if !mismatches.is_empty() {
        // 对账不通过 → **不写标记**（下次启动会再试），并如实报错
        return Err(DbError::new(
            ErrorCode::Other,
            format!("自动迁移对账未通过（{} 张表）：{}", mismatches.len(), serde_json::to_string(&mismatches).unwrap_or_default()),
        ));
    }

    // 对账通过 → 记录标记（"只搬一次"的依据）
    let at = crate::schema::now_ms();
    mark_migrated(engine, &json!({ "at": at }))?;

    Ok(json!({
        "migrated": true,
        "legacy_path": legacy_path,
        "tables": reconciled.len(),
        "rows": reconciled.iter().filter_map(|t| t.get("rows").and_then(|v| v.as_i64())).sum::<i64>(),
        "per_table": reconciled,
        "skipped": skipped.iter().map(|(t, n)| json!({ "what": t, "rows": n })).collect::<Vec<_>>(),
        // BLOB 列被转成 `blobhex:` 文本搬运 —— 数量如实上报（静默改形是最坏的一种）
        "blob_columns_converted": blob_columns_total,
    }))
}
