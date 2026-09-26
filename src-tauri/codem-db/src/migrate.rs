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
// `fts.upsert` 需要与仓储命令同一套可选整数解析（时间戳缺失时按 0 处理）
use crate::repo::opt_i64;
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

/// 该表的**主键列**（按 `PRAGMA table_info` 的 pk 序号排序；无主键则空）。
///
/// 用途：导入覆盖已存在行时**必须按主键定位**，而且不能用 `INSERT OR REPLACE` ——
/// SQLite 的 `REPLACE` 语义是"先 DELETE 冲突行再 INSERT"，父表（如 `sessions`）
/// 被 REPLACE 时会触发子表的 `ON DELETE CASCADE`，把该会话的消息一并删掉。
/// 所以覆盖走 `UPDATE … WHERE pk = ?`，主键列必须准确。
fn primary_key_columns(engine: &Engine, table: &str) -> DbResult<Vec<String>> {
    engine.with_conn(|conn| {
        let mut stmt = conn
            .prepare(&format!("PRAGMA table_info(\"{table}\")"))
            .map_err(DbError::from)?;
        // (pk 序号, 列名)；pk=0 表示不是主键列
        let rows = stmt
            .query_map([], |r| {
                Ok((r.get::<_, i64>(5)?, r.get::<_, String>(1)?))
            })
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
    })
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

    /*
     * 语义上非空的列必须是**真的非空**（第 45 轮 Z-3）。
     *
     * `import.table` 是**唯一的批量写面**（迁移、补搬、外部工具都走它），
     * 而它按列清单原样绑值 —— 于是一份"某列为 NULL"的源数据（旧库真实存在这种行，
     * 例如 sql.js 时代某次 `UPDATE` 留下的）会被照搬进来，然后毒住读路径：
     * `messages.get` 对 NULL `hidden` 直接报 `Invalid column type Null …`。
     *
     * 只拒绝 `hidden`：它是**唯一**"NULL 会把整条读路径打崩"的列（非 Option 读取）。
     * 其余列容忍 NULL 是刻意的 —— 那些 NULL 是真实存在的历史数据形态，
     * 拒绝元数据列会让合法的迁移整批失败；而"容忍"的前提是读侧必须防住
     * （`messages.get` 的 `trimmed` 早就用了 `unwrap_or(0)`，`hidden` 第 45 轮补上）。
     */
    if columns.iter().any(|c| c == "hidden") {
        let idx = columns.iter().position(|c| c == "hidden").expect("刚判断过");
        for (i, row) in parsed.iter().enumerate() {
            if matches!(row.get(idx), Some(SqlValue::Null)) {
                return Err(DbError::invalid(
                    "rows",
                    format!(
                        "表 {table} 的第 {i} 行把 `hidden` 写成了 NULL —— 该列语义上不可为空\
                         （0=可见 / 1=隐藏），NULL 会让 `messages.get` / `messages.list` 报\
                         `Invalid column type Null`，整个会话读不出来。请在源数据里改成 0 或 1。"
                    ),
                ));
            }
        }
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
    //
    // ⚠️ **顶层 `replace` 必须被读进来**（第 44 轮修掉的真机缺陷）。
    //
    // `migration.auto` 固定传 `{ "tables": [...], "replace": true }`，
    // 而这里原来**只**看每一项自己的 `mode`，缺省 `"insert"` ——
    // 也就是说顶层那个 `replace: true` 从来没有生效过。后果是两条，都很严重：
    //
    // ① **同名行永远不被覆盖**：`INSERT OR IGNORE` 撞主键就静默跳过，
    //    于是"旧库那份内容"在目标已有该行时被直接丢弃（迁移报告却说搬了 N 行）；
    // ② **对账必然失败**：目标行还是旧值 → 内容摘要对不上 →
    //    `migration.auto` 报"对账未通过"并且**不写迁移标记** →
    //    下次启动再跑一遍，永远修不好（每次都要再全量读一遍旧库 + 重建 FTS + 备份整库）。
    //    真机审计里"11.8 小时跑了 16 次"正与这种"反复重试、每轮看起来都在正常工作"
    //    的形态吻合。
    //
    // 这个缺陷是**那条测试没有覆盖**的直接结果：`migration.auto` 是全仓唯一一条
    // "整库重写"的命令，而在这一轮之前它一条用例都没有。
    // 现在 `auto_migrate_refuses_non_empty_target_and_backs_up_before_writing` 钉住它：
    // 迁移必须成功、且目标里**已存在**的行必须被源端内容覆盖。
    let default_mode = if payload
        .get("replace")
        .and_then(|x| x.as_bool())
        .unwrap_or(false)
    {
        "replace"
    } else {
        "insert"
    };
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
        // 每项可以覆盖顶层默认（顶层是 `migration.auto` 的"整批语义"，单项是自己的语义）
        let mode = it
            .get("mode")
            .and_then(|x| x.as_str())
            .unwrap_or(default_mode)
            .to_string();
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

    /*
     * ⚠️ **这里原来会按 `replace: true` 把每张目标表整表清空**，而 `replace: true` 正是
     * `migration.auto`（启动迁移 + 自检恢复都走它）固定传的参 —— 也就是说：
     * **任何一次自动迁移都会先把新库清空再重灌旧库那份内容**。
     *
     * 真机证据（第 11 轮，`storage_audit` 触发器记下的两次删除）：
     * - 2026-09-16T23:47:45Z：sessions 2 行 + 某会话的 277 条 messages + 317 tool_calls；
     * - 2026-09-17T01:13:34Z：sessions 3 行 + **821 条 messages（全部）+ 883 tool_calls
     *   + 2131 session_events** —— 与"整表清空再重灌"完全吻合，且与
     *   `codem-db.bin-shm`（旧库被打开）和运行时日志**同秒**。
     * 这两次都发生在应用自己拉起迁移/恢复的那一刻，而不是什么第三方进程。
     *
     * 危险不在"清空"本身，而在**中间态**：DELETE 与 INSERT 之间只要被打断
     * （崩溃 / 强杀 / 事务失败），用户数据就真的没了 —— 这正是历史事故的形态
     * （"迁移对账通过、标记已写之后，新库变回 0"）。
     *
     * 所以整表清空**彻底去掉**：
     * - 同名行改用"不删除的覆盖"（见下面的 `INSERT OR IGNORE` + `UPDATE` 两段式）——
     *   它同时修掉了另一个更隐蔽的破坏源：`INSERT OR REPLACE` 在 SQLite 里是
     *   **先 DELETE 再 INSERT**，而 `sessions` 的子表带 `ON DELETE CASCADE`，
     *   于是"覆盖一个已存在的会话行"会**级联删掉该会话的全部消息**，
     *   再靠后面的 messages 导入把旧库那份补回来 —— 新库里有、旧库里没有的消息
     *   就此永久消失（这与上面第 23:47:45 那次"只删一个会话的 277 条"的形态一致）；
     * - 目标端比源端多的行**保留**（不再"不该和源端混在一起"地被清掉）。
     *   初始迁移时目标表本来就是空的，行为与从前完全一致。
     */
    let mut report = serde_json::Map::new();
    let mut total = 0usize;
    for (table, columns, rows, mode) in &jobs {
        let placeholders: Vec<String> = (1..=columns.len()).map(|i| format!("?{i}")).collect();
        let col_list = columns
            .iter()
            .map(|c| format!("\"{c}\""))
            .collect::<Vec<_>>()
            .join(", ");
        let insert_sql = format!(
            "INSERT OR IGNORE INTO \"{table}\" ({col_list}) VALUES ({})",
            placeholders.join(", ")
        );
        /*
         * 覆盖已存在行时**不能**用 `INSERT OR REPLACE`（见上面的说明：它会先删行，
         * 触发子表级联删除）。这里用"`INSERT OR IGNORE` → 未插入则 `UPDATE`"两段式：
         * 先试插入，插入成功就完事；被主键挡下（0 行）才更新那些**非主键列**。
         *
         * 主键列从 `PRAGMA table_info` 取（按 pk 序号排），因此复合主键也正确。
         */
        let pk_cols = if mode == "replace" {
            primary_key_columns(engine, table)?
        } else {
            Vec::new()
        };
        let set_cols: Vec<&String> = columns.iter().filter(|c| !pk_cols.contains(c)).collect();
        let update_sql = if mode == "replace" && !pk_cols.is_empty() && !set_cols.is_empty() {
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
        // 主键列在 `columns` 里的下标（按 pk_cols 的顺序）
        let pk_idx: Vec<usize> = pk_cols
            .iter()
            .map(|pk| columns.iter().position(|c| c == pk))
            .collect::<Option<Vec<usize>>>()
            .unwrap_or_default();

        let res: DbResult<usize> = engine.import_write(|tx| {
            let mut insert_stmt = tx.prepare_cached(&insert_sql).map_err(DbError::from)?;
            let mut update_stmt = match &update_sql {
                Some(sql) => Some(tx.prepare_cached(sql).map_err(DbError::from)?),
                None => None,
            };
            let mut n = 0usize;
            for vals in rows {
                let inserted = insert_stmt
                    .execute(params_from_iter(vals.iter()))
                    .map_err(DbError::from)?;
                // 0 行 = 主键已存在（`OR IGNORE` 挡下了）→ 改成"不删除的覆盖"
                if inserted == 0 {
                    if let Some(stmt) = update_stmt.as_mut() {
                        if !pk_idx.is_empty() && pk_idx.len() == pk_cols.len() {
                            let mut args: Vec<SqlValue> = set_cols
                                .iter()
                                .map(|c| {
                                    let i = columns.iter().position(|x| x == *c).unwrap_or(0);
                                    vals[i].clone()
                                })
                                .collect();
                            for i in &pk_idx {
                                args.push(vals[*i].clone());
                            }
                            stmt.execute(params_from_iter(args.iter())).map_err(DbError::from)?;
                        }
                    }
                }
                n += 1;
            }
            Ok(n)
        });
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
                // 回滚整个事务：新库回到导入前的状态（**绝不留半个库**）
                let _ = engine.import_rollback();
                return Err(DbError::new(
                    e.code,
                    format!("导入表 {table} 失败，已回滚整个事务：{}", e.message),
                ));
            }
        }
    }
    engine.import_commit()?;

    Ok(json!({
        "ok": true,
        "written": total,
        "rows": total,
        "total_rows": total,
        "tables": report,
        "count": jobs.len(),
    }))
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

/// 单条消息写入/更新全文索引（**渲染侧每条消息写入后调用**）。
///
/// ## 为什么需要这条命令（真机缺陷修正）
///
/// `session_fts` 是虚拟表、没有触发器维护，渲染侧的 `createMessage` 里那段
/// "顺手插一行 FTS" 是**旧库专属**的（`isFts5Available()`，rust 模式下恒为 false）。
/// 而 `messages.upsert_index` 只管 `messages` 表。于是 rust 引擎下：
///
/// - 迁移那一刻的老消息**有**全文索引（`fts.rebuild_all`）；
/// - 迁移之后**新写入的每条消息都进不去** —— 搜索永远搜不到近期内容。
///
/// 修复不能靠"每条消息都 rebuild 整个会话"（O(会话长度) 每写一条），
/// 也不该在 SQL 触发器里做（中文切分要用 `fts::tokenize` 的 bigram 规则，
/// SQL 层拿不到）——所以做成这条**单条命令**：切分 + 先删后插，与 `fts_rebuild`
/// 里"写入索引行"的那段用同一套规则。
///
/// `content` 为空 → 只删不插（空正文没有任何可搜内容，留着空行只会制造
/// "命中但正文是空"的假结果）。
pub fn fts_upsert(engine: &Engine, p: &Value) -> DbResult<Value> {
    let session_id = req_text(p, "session_id")?;
    let message_id = req_text(p, "message_id")?;
    let content = p.get("content").and_then(|x| x.as_str()).unwrap_or("");
    let role = p
        .get("role")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let timestamp = opt_i64(p, "timestamp")?.unwrap_or(0);

    let tokenized = crate::fts::tokenize(content);
    engine.write_tx(|tx| {
        tx.execute(
            "DELETE FROM session_fts WHERE session_id = ?1 AND message_id = ?2",
            params![session_id, message_id],
        )
        .map_err(DbError::from)?;
        if tokenized.is_empty() {
            return Ok(json!({ "written": 0, "message_id": message_id, "empty": true }));
        }
        tx.execute(
            "INSERT INTO session_fts (session_id, message_id, content, role, timestamp) \
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![session_id, message_id, tokenized, role, timestamp],
        )
        .map_err(DbError::from)?;
        Ok(json!({ "written": 1, "message_id": message_id }))
    })
}

/// 从全文索引里移除若干消息（**消息删除/隐藏后调用** —— 虚拟表没有级联）。
///
/// 与 `fts_delete_session` 的区别是范围：这里是"按 id 删"，删除单条消息、
/// 按时间范围清理、压缩隐藏都要用它。少了这一步，`session_fts` 会留下
/// **命中却打不开的孤儿行**（真机实测过 112 条）。
pub fn fts_remove(engine: &Engine, p: &Value) -> DbResult<Value> {
    let session_id = req_text(p, "session_id")?;
    let ids = p
        .get("ids")
        .and_then(|x| x.as_array())
        .ok_or_else(|| DbError::missing("ids（字符串数组）"))?;
    let parsed: Vec<String> = ids
        .iter()
        .map(|id| {
            id.as_str()
                .map(|s| s.to_string())
                .ok_or_else(|| DbError::invalid("ids", "元素必须是字符串"))
        })
        .collect::<DbResult<Vec<_>>>()?;
    if parsed.is_empty() {
        return Err(DbError::invalid("ids", "不能为空数组（必须显式给出要移除的目标）"));
    }
    engine.write_tx(|tx| {
        let mut stmt = tx
            .prepare_cached("DELETE FROM session_fts WHERE session_id = ?1 AND message_id = ?2")
            .map_err(DbError::from)?;
        let mut n = 0usize;
        for id in &parsed {
            n += stmt.execute(params![session_id, id]).map_err(DbError::from)?;
        }
        Ok(json!({ "written": n, "requested": parsed.len(), "session_id": session_id }))
    })
}

/// `fts.search` 的结果条数上限。
///
/// 取 50 是为了**与文档一致**（`fts_search` 的注释一直写"最大 50"），而不是新定一个数：
/// 搜索结果是给人看的列表，50 条以外没有意义；而每一条都要把**真实正文**读出来
/// （这里刻意不返回 `snippet()`，因为索引里存的是 bigram 切分形式，没法展示），
/// 所以条数上限直接决定了单次查询的字节量。
/// 实测：这个上限缺失时 limit=5000 会返回 **7,769,093 B**。
pub const FTS_SEARCH_MAX: usize = 50;

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
///    因为返回的是**真实正文**，所以这里的上限必须真的管住（见下面的第 4 点）。
/// 3. **`session_id` 可选**：不传就是**跨会话搜索**（原来的渲染侧实现里
///    "全局搜索"其实从没生效过 —— 见 `session-search.ts` 的 matchExpr 死代码）。
/// 4. **上限真的实施（第 44 轮）**：上面第 2 点原来写着"`limit` 有上限（默认 10、最大 50）"，
///    而实现用的是通用 `limit_of`（默认 100、最大 5000）—— **文档与实现不一致**。
///    真机实测：中文搜索 limit=50 → 776,988 B；**limit=5000 → 7,769,093 B**。
///    也就是说"正文读取量是有界的"这句话当时是假的，而这个假承诺的代价是
///    一次搜索就能把 7.7 MB 正文推过 IPC 并驻留在渲染进程里。
///    现在：① `FTS_SEARCH_MAX` 把行数夹到 50（与文档一致）；
///    ② 再用 `repo::cap_by_bytes` 实施 16 MiB 字节预算（与所有分页读共用一份实现）；
///    ③ `has_more` 从"硬编码 false"改成**如实**回答"还有没有更多"。
pub fn fts_search(engine: &Engine, p: &Value) -> DbResult<Value> {
    let session_id = opt_text(p, "session_id")?;
    let raw_query = req_text(p, "query")?;
    // 空查询 / 全是不可索引字符：明确报参数错误，**不要**退化成"匹配全表"
    let expr = crate::fts::query_expr(&raw_query)
        .ok_or_else(|| DbError::invalid("query", "查询词为空或全是不可索引字符"))?;
    // 夹到文档承诺的上限：搜索结果是给人看的，50 条以外没有意义，
    // 而每一条都要把**真实正文**读出来（这是没有 snippet 的代价）。
    let limit = limit_of(p)?.min(FTS_SEARCH_MAX);
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
        // 多取一行用来**如实**回答 has_more（原来这里硬编码 false：
        // 调用方据此以为"结果就这么多"，于是"还有更多命中"这件事在协议层不可见）
        let probe = (limit + 1) as i64;
        let mut items = Vec::new();
        match &session_id {
            Some(sid) => {
                let rows = stmt
                    .query_map(params![expr, sid, probe], map_row)
                    .map_err(DbError::from)?;
                for r in rows {
                    items.push(r.map_err(DbError::from)?);
                }
            }
            None => {
                let rows = stmt
                    .query_map(params![expr, probe], map_row)
                    .map_err(DbError::from)?;
                for r in rows {
                    items.push(r.map_err(DbError::from)?);
                }
            }
        }
        let mut has_more = items.len() > limit;
        if has_more {
            items.truncate(limit);
        }
        if crate::repo::cap_by_bytes(&mut items) {
            has_more = true;
        }
        Ok(json!({
            "items": items,
            "has_more": has_more,
            "limit": limit,
            "max_limit": FTS_SEARCH_MAX,
            "next_cursor": Value::Null,
            "scope": session_id.unwrap_or_else(|| "<all>".to_string()),
        }))
    })
}

/// 从 `messages` 重建全文索引（迁移不搬 FTS 影子表，导入后调这个）
///
/// ## 为什么不能 `INSERT ... SELECT content`（第 44 轮修掉的真机缺陷）
///
/// 这里原来是 `INSERT INTO session_fts (...) SELECT id, session_id, content FROM messages`
/// —— 把**原文**直接灌进索引。而中文检索依赖 `fts::tokenize` 的 **CJK bigram 切分**
/// （见 `fts.rs` 头注释）：查询侧会切成 `"存储"`/`"迁移"` 这样的 token，
/// 索引里却是**未切分的整句** → **迁移之后中文搜索恒为 0 条**。
///
/// 之所以长期没被发现：ASCII 词两边一致，**英文搜索照常工作**，
/// 于是"英文能搜、中文搜不到"看起来像数据问题而不是索引形态问题
/// （这与 `fts_rebuild` 头注释里记的是同一类故障，那次是"行在、内容空"）。
///
/// 同仓 `migrate::fts_rebuild`（按会话）早就按切分形式写入了 ——
/// 只有这个"全库重建"漏了同一件事，而它正好是**迁移之后**跑的那一个。
/// 两处必须用同一套 token 形态，否则谁后跑谁说了算。
///
/// ## 事务（同一轮修掉的第二个缺陷）
///
/// 原来是"整表 `DELETE` + 重灌"，且**不在事务里**（`with_conn` + 两条独立语句）。
/// 中途失败（磁盘满、进程被杀）会留下**索引整表为空**的库，
/// 用户看到的现象是"搜索突然什么都搜不到"，而 messages 一行没少 ——
/// 这种"数据在、能力没了"的中间态是最难排查的一类。
/// 现在整段走 `write_tx`：要么全成，要么全不动。
///
/// 顺带把"每次全表重写"改成"内容一致就跳过"（切分后的文本逐条比对）：
/// 每次调用重写 100k 行是白写，而且会长时间占住单写者锁。
pub fn rebuild_fts(engine: &Engine, p: &Value) -> DbResult<Value> {
    let _ = p;
    engine.write_tx(|tx| {
        /*
         * 现有索引内容（`message_id` → 切分后的文本），用于"一致就跳过"。
         *
         * ⚠️ 第 45 轮：这里原来只留**一行**（`HashMap` 的 insert 让重复 message_id
         * "后一行覆盖前一行"），于是"内容一致就跳过"对**重复行永远判一致** ——
         * 一行都不删，`fts.search` 同一条消息返回两次（实测）。
         * 旧实现是"整表 DELETE + 重灌"，天然自愈；改成增量写入后这个自愈能力丢了。
         * 现在**按 id 计数**：计数 != 1 就是对账不上的重复（或者从未见过的行），
         * 走 DELETE + INSERT，顺带把重复行收敛回一行。
         */
        let existing: std::collections::HashMap<String, (usize, String)> = {
            let mut stmt = tx
                .prepare("SELECT message_id, content FROM session_fts")
                .map_err(DbError::from)?;
            let rows = stmt
                .query_map([], |r| {
                    Ok((r.get::<_, Option<String>>(0)?, r.get::<_, Option<String>>(1)?))
                })
                .map_err(DbError::from)?;
            let mut m: std::collections::HashMap<String, (usize, String)> =
                std::collections::HashMap::new();
            for r in rows {
                let (id, content) = r.map_err(DbError::from)?;
                if let Some(id) = id {
                    let e = m.entry(id).or_insert((0, String::new()));
                    e.0 += 1;
                    // 内容无所谓取哪一份：计数 != 1 时本来就不看内容
                    e.1 = content.unwrap_or_default();
                }
            }
            m
        };

        /*
         * ⚠️ 第 45 轮：`messages.id` 可能是 NULL（列定义 `TEXT PRIMARY KEY` 在 SQLite 里
         * **允许多行 NULL** —— 主键不约束 NULL），而这里原来读的是 `r.get::<_, String>(0)`。
         *
         * 后果实测（真 CLI）：
         *   rebuild_fts → {"error":{"code":"OTHER","message":"Invalid column type Null at index: 0, name: id"}}
         * 于是**整次重建整体失败** —— 而它同时还是**唯一**能清 FTS 孤儿的路径，
         * 也就是说"库里有一行 id 为 NULL"会让那个库的全文索引**永远修不好**。
         * 旧实现是一条 `INSERT … SELECT`（NULL id 会照样被插进去、不报错），所以这是
         * 本轮改写新引入的回退。现在：读成 `Option<String>`，NULL 的行**跳过并计数**，
         * 结果里如实报 `skipped_null_id` —— 不整体失败，也不静默漏。
         */
        let mut stmt = tx
            .prepare(
                "SELECT id, session_id, content, role, timestamp FROM messages \
                 WHERE hidden = 0 ORDER BY session_id ASC, timestamp ASC",
            )
            .map_err(DbError::from)?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, Option<String>>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Option<String>>(2)?,
                    r.get::<_, Option<String>>(3)?,
                    r.get::<_, Option<i64>>(4)?,
                ))
            })
            .map_err(DbError::from)?;

        let mut indexed = 0usize;
        let mut unchanged = 0usize;
        let mut skipped_null_id = 0usize;
        for r in rows {
            let (id, session_id, content, role, timestamp) = r.map_err(DbError::from)?;
            let Some(id) = id else {
                skipped_null_id += 1;
                continue;
            };
            let tokenized = crate::fts::tokenize(content.as_deref().unwrap_or(""));
            // "一致"必须是**恰有一行且内容一致**（重复行一律重建，见上面的说明）
            let is_clean_single = matches!(
                existing.get(&id),
                Some((1, c)) if c == &tokenized
            );
            if is_clean_single {
                unchanged += 1;
                continue;
            }
            tx.execute(
                "DELETE FROM session_fts WHERE message_id = ?1",
                params![id],
            )
            .map_err(DbError::from)?;
            tx.execute(
                "INSERT INTO session_fts (message_id, session_id, content, role, timestamp) \
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    id,
                    session_id,
                    tokenized,
                    role.unwrap_or_default(),
                    timestamp.unwrap_or(0)
                ],
            )
            .map_err(DbError::from)?;
            indexed += 1;
        }
        drop(stmt);

        // 孤儿行：FTS 里有、但 `messages` 里已经没有（FTS 是虚拟表，没有外键级联）。
        // 旧实现靠"整表 DELETE"顺带清掉它们；改成增量写入后必须显式清，
        // 否则会搜出已经不存在的 message_id（渲染侧点进去是空）。
        let orphans = tx
            .execute(
                "DELETE FROM session_fts \
                 WHERE message_id NOT IN (SELECT id FROM messages WHERE hidden = 0)",
                [],
            )
            .map_err(DbError::from)?;

        Ok(json!({
            "indexed": indexed,
            "unchanged": unchanged,
            "orphans_removed": orphans,
            // 有多少行因为 `messages.id IS NULL` 被跳过（如实上报：不整体失败，也不静默漏）
            "skipped_null_id": skipped_null_id,
        }))
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

/// **只读读旧库的某张表**（供渲染侧做定向补搬，例如配置面）。
///
/// ## 为什么需要它（第 43 轮）
///
/// 原来 `importSettingsFromLegacyDb()` 是这样读旧库的：`getDatabase()` ——
/// 而 rust 模式下旧库**从不加载**（`markLegacyDbNotUsed()` 之后就没有 `initDatabase()`），
/// 于是它必定抛 `Database not initialized`，被 catch 吞成"返回 0（没搬）"。
/// 也就是说：**这个函数从来没生效过**，是一处静默 no-op。
/// （当前用户没事，是因为全量迁移 `migration.auto` 本来就搬了 `settings` 表；
///   但"配置面单独补搬"这条能力是坏的。）
///
/// 这条命令把那个能力补回来，并且**只读打开**旧库（绝不给回滚开关添乱）：
/// 表名走白名单、行数有上限、只返回结构化行。
///
/// ## 上限必须**如实报出来**（第 44 轮修掉的静默截断）
///
/// 原来这里有 `limit.clamp(1, 20000)` 然后 `rows.truncate(limit)` —— **没有任何提示**。
/// 一个想用它做全量搬运的调用方（这正是"读旧库"最自然的用法）会在
/// `settings` 有 25,024 行时拿到 20,000 行，然后以为"旧库就这么些行"。
/// 这不是理论问题：迁移工具的第一版预检就是这么写的，于是打印的行数比引擎实际搬运的少。
///
/// 现在返回里给出 `total` / `limit` / `truncated` / `has_more` / `next_offset`，
/// 并且接受 `offset` 让调用方**真的能翻页**（而不是只能干看着被截断）。
///
/// ## 分页改成 **keyset**（第 45 轮 Z-8），并如实报出"翻页期间源库变化可能跳行"
///
/// `offset` 版有一个**静默**的正确性缺陷：它假设"两次查询之间源库不变"。审计实测
/// （limit=2，翻页之间源库删掉 k1）：page1 给 `k1,k2` 且 `next_offset=2`，删掉 k1 后
/// page2 给 `k4,k5` —— **k3 从未被任何一页读到，且没有任何提示**。
/// 于是：默认走 keyset（主键优先，无主键才用 rowid），返回 `next_key`（整行 JSON，
/// 调用方原样回传给 `after_key`）；`next_offset` **继续返回**（老调用方不受影响），
/// 但新调用方应当用 `next_key`。
/// 同时返回 `paging: "keyset" | "offset" | "none"` 与 `source_change_hazard`（文案），
/// 让"源库可能变"这件事**调用方一定能看到** —— 这正是 Z-8 要求的那个字段。
pub fn legacy_read_table(engine: &Engine, p: &Value) -> DbResult<Value> {
    let _ = engine; // 只读旧库，不碰新库
    let legacy_path = crate::repo::req_text(p, "legacy_path")?;
    let table = crate::repo::req_text(p, "table")?;
    // 表名白名单：只允许可导入表（与迁移同一套判据），不接受任意 SQL 标识符
    if !importable_tables().iter().any(|t| t == &table) {
        return Err(DbError::unsupported(format!(
            "legacy.read_table 不允许读表 {table}（不在可导入清单内）"
        )));
    }
    let limit = p
        .get("limit")
        .and_then(|x| x.as_i64())
        .unwrap_or(2_000)
        .clamp(1, 20_000) as usize;
    let offset = p
        .get("offset")
        .and_then(|x| x.as_i64())
        .unwrap_or(0)
        .max(0) as usize;
    // keyset 游标：调用方把上一页的 `next_key` 原样回传。与 `offset` 同时给时**以 keyset 为准**
    // （两者语义不同，混用只会得到静默错误的页；所以先到先用，且在返回里标明用了哪种）。
    let after_key = p.get("after_key").filter(|v| !v.is_null()).cloned();

    if !std::path::Path::new(&legacy_path).exists() {
        return Err(DbError::not_found(format!("旧库不存在：{legacy_path}")));
    }
    let conn = Connection::open_with_flags(
        &legacy_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_URI,
    )
    .map_err(DbError::from)?;

    let columns = read_legacy_columns(&conn, &table)?;
    if columns.is_empty() {
        return Ok(json!({
            "table": table, "columns": [], "rows": [],
            "total": 0, "limit": limit, "offset": offset, "truncated": false,
            "has_more": false, "next_offset": Value::Null, "next_key": Value::Null,
            "paging": "none",
        }));
    }
    // 表名来自白名单、列名来自真实 schema，拼接安全
    let total: i64 = conn
        .query_row(&format!("SELECT COUNT(*) FROM \"{table}\""), [], |r| r.get(0))
        .map_err(DbError::from)?;
    /*
     * 分页**在 SQL 里做**，而不是"整表读出来再 truncate"。
     *
     * 后者在 25,024 行的表上会把整表读进内存再丢掉一半 —— 而且"读全了"这件事
     * 会掩盖截断（调用方看到的就是一个正常的数组，没有任何"被截断"的痕迹）。
     */
    if let Some(cursor) = &after_key {
        let (rows, _blobs, next_key, has_more) =
            read_legacy_table_page(&conn, &table, &columns, limit, 0, Some(cursor))?;
        let keyed = !next_key.is_none() || has_more;
        return Ok(json!({
            "table": table,
            "columns": columns,
            "rows": rows,
            "total": total,
            "limit": limit,
            // keyset 分页时 `offset` 无意义（保留字段是为了形状恒定），如实标出用了哪种
            "offset": Value::Null,
            "truncated": has_more,
            "has_more": has_more,
            "next_offset": Value::Null,
            "next_key": next_key,
            "paging": if keyed { "keyset" } else { "none" },
            /*
             * **源库变化的风险必须让调用方看到**（Z-8 的要求）。
             *
             * keyset 分页对"翻页期间源库被改"是**部分**免疫的：删掉已经读过的那部分
             * 不会导致跳行（这正是它相对 offset 的改进），但
             * ① 新增的行如果落在游标**之前**，就永远不会被读到；
             * ② `total` 是本次查询时的快照，翻到后面可能已经对不上。
             * 所以这里如实给出这条说明，而不是让调用方以为"翻完了 = 读到当时全部"。
             */
            "source_change_hazard": "翻页期间源库可能被其他进程修改：游标之前新增的行不会被读到，total 也只是本次快照。需要严格一致时请在源库静止时读取。",
        }));
    }
    let (rows, _blobs, _next_key, has_more) =
        read_legacy_table_page(&conn, &table, &columns, limit, offset, None)?;
    /*
     * `offset` 兼容分支（不推荐，仅为不打断既有调用方）。
     *
     * ⚠️ 它**就是**那个会静默跳行的语义：审计实测 limit=2、翻页之间源库删掉 k1 →
     * page1 给 k1,k2，page2 给 k4,k5，**k3 从未被读到且无任何提示**。
     * 所以这里如实标出 `paging: "offset"` 并把 `source_change_hazard` 一起返回 ——
     * 调用方能从返回值看出"我用的这版分页不保证不跳行"，需要一致性时改用 `after_key`。
     *
     * 注意：本分支的 `rows` 是**第一页**（LIMIT-only，无 OFFSET）——
     * `offset` 只影响 `next_offset` 的推进与 `has_more` 的判据，不影响本次返回的行。
     * 这与老实现（`LIMIT ? OFFSET ?`）在 `offset = 0` 时完全一致；
     * `offset > 0` 的老调用方应当改用 `after_key`（返回里已经给了 `next_key`）。
     */
    let has_more_offset = (offset + rows.len()) < total as usize;
    Ok(json!({
        "table": table,
        "columns": columns,
        "rows": rows,
        "total": total,
        "limit": limit,
        "offset": offset,
        // `truncated` 保留给"调用方没翻页就当成全量"的那种误用：只要还有更多，它就是 true
        "truncated": has_more_offset || has_more,
        "has_more": has_more_offset || has_more,
        "next_offset": if has_more_offset { json!(offset + rows.len()) } else { Value::Null },
        // keyset 游标：调用方回传 `after_key` 即可**不跳行**地续页（推荐路径）。
        // `offset > 0` 时 `next_key` 恒为 null —— offset 语义下"下一页起点"不是一个键
        // （这也是为什么 offset 分页无法免疫源库变化），调用方据此改用 after_key 或接受风险。
        "next_key": if offset == 0 { json!(_next_key) } else { Value::Null },
        // offset=0 时走的就是 keyset（LIMIT-only + next_key）；offset>0 才真是老式 offset 分页
        "paging": if offset == 0 { "keyset" } else { "offset" },
        "paging_note": if offset == 0 {
            "第一页按 keyset 返回了 next_key：续页请把它原样回传为 after_key（不要用 next_offset）。"
        } else {
            "本次按 offset 分页（翻页期间源库变化会静默跳行，这是 Z-8 实测过的缺陷）；一致性要求高时请改用 after_key。"
        },
        "source_change_hazard": "翻页期间源库可能被其他进程修改：游标之前新增的行不会被读到，offset 分页还会因此跳行或重复；total 也只是本次快照。需要严格一致时请用 after_key 续页，或让源库静止。",
    }))
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
mod batch_message_tests {
    use super::*;

    /// **Z-1 的核心**：多重集摘要必须**与行序无关**，而顺序敏感摘要必须仍然敏感
    /// （它现在只用来回答"只是行序不同吗"这个诊断问题）。
    ///
    /// 这条测试就是那条阻断级缺陷的最小复现：两端**内容完全相同、顺序不同** ——
    /// 旧判据（顺序滚动摘要）判"不等" → 迁移报"对账未通过" → 不写标记 → 每次启动重来。
    #[test]
    fn multiset_digest_is_order_independent() {
        let a = json!([
            ["k1", "v1"],
            ["k2", "v2"],
            ["k3", "v3"],
            ["k4", "v4"],
            ["k5", "v5"],
            ["k6", "v6"]
        ]);
        // 同一个多重集，行序不同（审计实测的形态：目标端已有子集，补进来的行落在末尾）
        let b = json!([
            ["k1", "v1"],
            ["k3", "v3"],
            ["k2", "v2"],
            ["k4", "v4"],
            ["k5", "v5"],
            ["k6", "v6"]
        ]);
        let da = digest_json_rows_multiset(a.as_array().unwrap());
        let db = digest_json_rows_multiset(b.as_array().unwrap());
        assert_eq!(da.rows, 6);
        assert_eq!(db.rows, 6);
        /*
         * **旧判据在此失败、新判据在此通过** —— 这就是 Z-1 的对照证据（同一批数据、两个函数）：
         * `digest_json_rows` 是那个顺序滚动摘要（旧对账判据用的就是它），
         * 它对"同样的行、不同的顺序"给出**不同**的摘要 → 旧代码判"对账未通过"。
         */
        let (old_rows_a, old_digest_a) = digest_json_rows(a.as_array().unwrap());
        let (old_rows_b, old_digest_b) = digest_json_rows(b.as_array().unwrap());
        assert_eq!(old_rows_a, old_rows_b, "旧判据看到的行数是相同的");
        assert_ne!(
            old_digest_a, old_digest_b,
            "旧判据（顺序滚动哈希）对同一批数据给出不同摘要 —— 这正是「目标端已有子集」时\
             永远对账不过的原因（审计实测：源 6 行、目标预置 2 行，六行其实都写进去了）"
        );
        assert_eq!(
            da.digest, db.digest,
            "多重集摘要必须与行序无关（这正是 Z-1 的修复点）"
        );
        assert_ne!(
            da.order_sensitive_digest, db.order_sensitive_digest,
            "顺序敏感摘要仍应能看出「行序不同」——它现在的用途就是这条诊断"
        );
        assert_eq!(
            reconcile_multisets(&da, &db),
            ReconcileVerdict::Identical { order_differs: true },
            "结论必须是「一致，只是行序不同」，而不是失败"
        );

        // 内容真的不同（k2 的值变了）→ 必须判失败，且分类是「内容不一致」而不是「缺行」
        let c = json!([["k1","v1"], ["k2","CHANGED"], ["k3","v3"], ["k4","v4"], ["k5","v5"], ["k6","v6"]]);
        let dc = digest_json_rows_multiset(c.as_array().unwrap());
        assert_ne!(da.digest, dc.digest);
        match reconcile_multisets(&da, &dc) {
            ReconcileVerdict::ContentDiffers { .. } => {}
            other => panic!("内容不同必须判为 ContentDiffers，实际 {other:?}"),
        }

        // 目标端**少一行** → 「缺行」分类（这才是"数据搬丢了"）
        let d = json!([["k1","v1"], ["k2","v2"], ["k3","v3"], ["k4","v4"], ["k5","v5"]]);
        let dd = digest_json_rows_multiset(d.as_array().unwrap());
        assert_eq!(
            reconcile_multisets(&da, &dd),
            ReconcileVerdict::MissingRows { missing_rows: 1 }
        );

        // 目标端多一行 → 「源端被覆盖，目标端更新」的正常情形（不算失败）
        let mut e: Vec<Value> = a.as_array().unwrap().clone();
        e.push(json!(["k7", "v7"]));
        let de = digest_json_rows_multiset(&e);
        assert_eq!(
            reconcile_multisets(&da, &de),
            ReconcileVerdict::SourceCovered { extra_rows: 1 }
        );
    }

    /// 重复行必须被算进多重集：`[X, X]` 与 `[X]` 不是同一批数据。
    ///
    /// 为什么值得钉：如果行摘要不带"重复度"，多重集摘要会把"同一行出现两次"
    /// 与"出现一次"混为一谈 —— 那是**静默少数据**的一种形态（正是迁移最不能有的）。
    #[test]
    fn multiset_digest_counts_duplicate_rows() {
        let once = json!([["k1", "v1"], ["k2", "v2"]]);
        let twice = json!([["k1", "v1"], ["k2", "v2"], ["k2", "v2"]]);
        let a = digest_json_rows_multiset(once.as_array().unwrap());
        let b = digest_json_rows_multiset(twice.as_array().unwrap());
        assert_eq!(a.rows, 2);
        assert_eq!(b.rows, 3);
        assert_eq!(b.rows_in_dup_groups, 2, "重复组里应有 2 行：{b:?}");
        assert_ne!(a.digest, b.digest, "多出来的那一行必须改变摘要");
    }
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

    /// 追加一条文本事件（`payload` 逐字节可控 —— 去重的判据就是"逐字节相同"）
    fn append_text(e: &Engine, sid: &str, ty: &str, mid: &str, body: &str) -> i64 {
        let r = call(
            e,
            "events.append",
            json!({ "session_id": sid, "event_type": ty, "payload": { "messageId": mid, "content": body } }),
        );
        r["seq"].as_i64().unwrap()
    }

    /// O-31 的核心判据：**同一份正文写三遍 → 去重后只剩一条，且剩下的是 seq 最小的那条**
    /// （不是最新的那条 —— 见 `events_dedup_text` 的文档：投影的位置由首次写入决定）。
    #[test]
    fn dedup_text_keeps_only_the_first_copy() {
        let (_d, e) = eng("evdedup1");
        seed_session(&e, "s1");
        let s1 = append_text(&e, "s1", "user_message", "u1", "同一份正文");
        let _s2 = append_text(&e, "s1", "user_message", "u1", "同一份正文");
        let _s3 = append_text(&e, "s1", "user_message", "u1", "同一份正文");

        // 干跑：只报账、一行不删
        let dry = call(&e, "events.dedup_text", json!({ "session_id": "s1" }));
        assert_eq!(dry["applied"], json!(false));
        assert_eq!(dry["before_rows"], json!(3));
        assert_eq!(dry["distinct_groups"], json!(1));
        assert_eq!(dry["removable"], json!(2));
        assert_eq!(dry["removed"], json!(0));
        assert_eq!(
            call(&e, "events.count", json!({ "session_id": "s1" }))["count"],
            json!(3),
            "干跑不得动库"
        );

        let r = call(&e, "events.dedup_text", json!({ "session_id": "s1", "apply": true }));
        assert_eq!(r["applied"], json!(true));
        assert_eq!(r["removed"], json!(2));
        assert_eq!(r["after_rows"], json!(1));
        let after = call(&e, "events.list", json!({ "session_id": "s1", "limit": 100 }));
        let items = after["items"].as_array().unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["seq"].as_i64().unwrap(), s1, "必须保留 seq 最小的那条");
    }

    /// **内容不同就不许删**：同一个 `messageId` 但正文被改写过的行是合法历史。
    #[test]
    fn dedup_text_never_removes_different_content() {
        let (_d, e) = eng("evdedup2");
        seed_session(&e, "s1");
        append_text(&e, "s1", "user_message", "u1", "第一版正文");
        append_text(&e, "s1", "user_message", "u1", "改写后的正文");
        append_text(&e, "s1", "user_message", "u1", "第一版正文");
        let r = call(&e, "events.dedup_text", json!({ "session_id": "s1", "apply": true }));
        assert_eq!(r["before_rows"], json!(3));
        assert_eq!(r["distinct_groups"], json!(2), "两版正文是两个组");
        assert_eq!(r["removed"], json!(1), "只删『第一版正文』的重复那份");
        assert_eq!(r["after_rows"], json!(2));
    }

    /// **类型范围**：只有 `user_message` / `assistant_text` 会被去重。
    /// `tool_call` / `tool_result` 靠 `toolCallId` 互相引用，删较早的那条会让配对断裂，
    /// 所以哪怕载荷逐字节相同也**一行都不动**（用例把它钉死，防止有人"顺手扩大范围"）。
    #[test]
    fn dedup_text_leaves_tool_events_alone() {
        let (_d, e) = eng("evdedup3");
        seed_session(&e, "s1");
        for _ in 0..3 {
            call(
                &e,
                "events.append",
                json!({ "session_id": "s1", "event_type": "tool_call", "payload": { "toolCallId": "tc1", "name": "shell" } }),
            );
        }
        for _ in 0..3 {
            call(
                &e,
                "events.append",
                json!({ "session_id": "s1", "event_type": "tool_result", "payload": { "toolCallId": "tc1", "content": "ok" } }),
            );
        }
        let r = call(&e, "events.dedup_text", json!({ "session_id": "s1", "apply": true }));
        assert_eq!(r["before_rows"], json!(0), "工具事件不在统计范围内");
        assert_eq!(r["removed"], json!(0));
        assert_eq!(call(&e, "events.count", json!({ "session_id": "s1" }))["count"], json!(6));
    }

    /// **作用域陷阱**（`events_dedup_text` 的注释里点名的那个）：
    /// 只去重会话 A 时，别的会话的文本事件**一条都不能少**。
    /// 若外层 DELETE 忘了加 `session_id` 过滤，这里会整片消失。
    #[test]
    fn dedup_text_scoped_to_one_session_keeps_others() {
        let (_d, e) = eng("evdedup4");
        seed_session(&e, "s1");
        seed_session(&e, "s2");
        for _ in 0..3 {
            append_text(&e, "s1", "user_message", "u1", "会话一的正文");
            append_text(&e, "s2", "user_message", "u9", "会话二的正文");
        }
        let r = call(&e, "events.dedup_text", json!({ "session_id": "s1", "apply": true }));
        assert_eq!(r["removed"], json!(2), "只该删会话一的那两份");
        assert_eq!(call(&e, "events.count", json!({ "session_id": "s1" }))["count"], json!(1));
        assert_eq!(
            call(&e, "events.count", json!({ "session_id": "s2" }))["count"],
            json!(3),
            "会话二的文本事件不得被牵连（作用域必须与子查询完全一致）"
        );
    }

    /// 全库去重（不传 `session_id`）：两个会话各自收敛，互不影响。
    #[test]
    fn dedup_text_without_scope_covers_all_sessions() {
        let (_d, e) = eng("evdedup5");
        seed_session(&e, "s1");
        seed_session(&e, "s2");
        for _ in 0..2 {
            append_text(&e, "s1", "assistant_text", "a1", "回复一");
            append_text(&e, "s2", "assistant_text", "a2", "回复二");
        }
        let r = call(&e, "events.dedup_text", json!({ "apply": true }));
        assert_eq!(r["before_rows"], json!(4));
        assert_eq!(r["removed"], json!(2));
        assert_eq!(call(&e, "events.count", json!({ "session_id": "s1" }))["count"], json!(1));
        assert_eq!(call(&e, "events.count", json!({ "session_id": "s2" }))["count"], json!(1));
    }

    /// 幂等：连着跑两次，第二次必须"无事可做"（`removable: 0`、`removed: 0`）。
    /// 维护路径会被重复调用（每次启动都可能跑），非幂等就会出事。
    #[test]
    fn dedup_text_is_idempotent() {
        let (_d, e) = eng("evdedup6");
        seed_session(&e, "s1");
        for _ in 0..4 {
            append_text(&e, "s1", "assistant_text", "a1", "同一条回复");
        }
        let first = call(&e, "events.dedup_text", json!({ "session_id": "s1", "apply": true }));
        assert_eq!(first["removed"], json!(3));
        let second = call(&e, "events.dedup_text", json!({ "session_id": "s1", "apply": true }));
        assert_eq!(second["removable"], json!(0));
        assert_eq!(second["removed"], json!(0));
        assert_eq!(call(&e, "events.count", json!({ "session_id": "s1" }))["count"], json!(1));
    }

    /// 非文本事件（`session_meta` / `turn_start` …）不受影响，且有样例能看出"重的是什么"。
    #[test]
    fn dedup_text_reports_samples_and_spares_other_types() {
        let (_d, e) = eng("evdedup7");
        seed_session(&e, "s1");
        call(&e, "events.append", json!({ "session_id": "s1", "event_type": "session_meta", "payload": { "k": 1 } }));
        call(&e, "events.append", json!({ "session_id": "s1", "event_type": "turn_start", "payload": { "t": 1 } }));
        for _ in 0..5 {
            append_text(&e, "s1", "assistant_text", "a1", "被写了五遍的回复");
        }
        let r = call(&e, "events.dedup_text", json!({ "session_id": "s1", "apply": true }));
        let samples = r["samples"].as_array().unwrap();
        assert_eq!(samples.len(), 1);
        assert_eq!(samples[0]["copies"], json!(5));
        assert_eq!(samples[0]["event_type"], json!("assistant_text"));
        assert_eq!(call(&e, "events.count", json!({ "session_id": "s1" }))["count"], json!(3), "meta + turn_start + 1 条文本");
    }

    /// 删除必须**留痕**：`storage_audit` 里查得到这次删了哪张表、哪个会话、什么时候。
    #[test]
    fn dedup_text_writes_audit_trail() {
        let (_d, e) = eng("evdedup8");
        seed_session(&e, "s1");
        for _ in 0..3 {
            append_text(&e, "s1", "user_message", "u1", "审计要看得见");
        }
        call(&e, "events.dedup_text", json!({ "session_id": "s1", "apply": true }));
        let recent = call(&e, "audit.recent", json!({ "limit": 20 }));
        let rows = recent["items"].as_array().expect("audit.recent 应返回 items");
        let hit = rows
            .iter()
            .filter(|r| r["table_name"] == json!("session_events") && r["op"] == json!("DELETE"))
            .count();
        assert_eq!(hit, 2, "删两行就该留两条痕，实际 {hit}（rows={rows:?}）");
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

    /// 打开一个临时新库（本模块自用；`event_tests` 里的同名助手不在本作用域）
    fn eng(name: &str) -> (tempfile::TempDir, Engine) {
        let dir = tempfile::tempdir().unwrap();
        let engine = Engine::open(dir.path().join(format!("{name}.bin"))).unwrap();
        (dir, engine)
    }
    /// 建一个"旧库"文件，供 legacy.read_table 的测试使用
    fn write_legacy_settings(dir: &std::path::Path, rows: &[(&str, &str)]) -> std::path::PathBuf {
        let path = dir.join("legacy.bin");
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(
            "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER);",
        )
        .unwrap();
        for (k, v) in rows {
            conn.execute(
                "INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, 1)",
                rusqlite::params![k, v],
            )
            .unwrap();
        }
        path
    }

    #[test]
    fn legacy_read_table_returns_columns_and_rows() {
        let dir = tempfile::tempdir().unwrap();
        let legacy = write_legacy_settings(dir.path(), &[("codem-theme", "dark"), ("codem-language", "zh")]);
        let (_d, engine) = eng("legacy-read");
        let out = legacy_read_table(
            &engine,
            &json!({ "legacy_path": legacy.to_string_lossy(), "table": "settings" }),
        )
        .unwrap();
        assert_eq!(out["table"], "settings");
        let cols = out["columns"].as_array().unwrap();
        assert!(cols.iter().any(|c| c == "key"), "要返回列名（渲染侧按列名取值）");
        assert_eq!(out["rows"].as_array().unwrap().len(), 2, "两行都要读到");
    }

    #[test]
    fn legacy_read_table_respects_limit() {
        let dir = tempfile::tempdir().unwrap();
        let legacy = write_legacy_settings(
            dir.path(),
            &[("a", "1"), ("b", "2"), ("c", "3")],
        );
        let (_d, engine) = eng("legacy-read-limit");
        let out = legacy_read_table(
            &engine,
            &json!({ "legacy_path": legacy.to_string_lossy(), "table": "settings", "limit": 2 }),
        )
        .unwrap();
        assert_eq!(out["rows"].as_array().unwrap().len(), 2, "limit 必须生效（防大表把 IPC 打爆）");
    }

    #[test]
    fn legacy_read_table_rejects_tables_outside_whitelist() {
        let dir = tempfile::tempdir().unwrap();
        let legacy = write_legacy_settings(dir.path(), &[("a", "1")]);
        let (_d, engine) = eng("legacy-read-deny");
        // 表名白名单是这条命令的**安全边界**：不能变成"读任意表"
        let err = legacy_read_table(
            &engine,
            &json!({ "legacy_path": legacy.to_string_lossy(), "table": "sqlite_master" }),
        )
        .unwrap_err();
        assert_eq!(err.code, crate::error::ErrorCode::Unsupported);
    }

    #[test]
    fn legacy_read_table_reports_missing_legacy_db() {
        let (_d, engine) = eng("legacy-read-missing");
        let err = legacy_read_table(
            &engine,
            &json!({ "legacy_path": "C:/definitely/not/here.bin", "table": "settings" }),
        )
        .unwrap_err();
        assert_eq!(err.code, crate::error::ErrorCode::NotFound, "旧库不存在要如实报 NotFound");
    }

    // ========== 单条消息的全文索引维护（P5 第 11 段）==========
    //
    // 真机缺陷：rust 引擎下 `createMessage` 里那段"顺手插 FTS 一行"是旧库专属的
    // （`isFts5Available()` 在 rust 模式下恒为 false），于是**迁移之后新写入的消息
    // 永远进不了全文索引** —— 搜索只能搜到迁移那一刻的老消息。修复靠
    // `fts.upsert` / `fts.remove` 这两条命令，所以这里把它们的行为钉住。

    /// 在临时库里插一条 messages 行（外键/触发器都要满足，所以走真实 SQL）
    fn seed_message(engine: &Engine, session_id: &str, id: &str, content: &str) {
        // `messages.session_id` 有外键指向 sessions —— 先建会话行
        // （`project_id` 缺省 = 全局项目，schema 阶段已经种下那一行）
        crate::repo::sessions_upsert(engine, &json!({ "id": session_id })).unwrap();
        engine
            .write_tx(|tx| {
                tx.execute(
                    "INSERT OR REPLACE INTO messages (id, session_id, role, content, timestamp, status, hidden) \
                     VALUES (?1, ?2, 'user', ?3, 1, 'done', 0)",
                    params![id, session_id, content],
                )
                .map_err(DbError::from)?;
                Ok(())
            })
            .unwrap();
    }

    /// 直接数一个会话在 FTS 里的行数（绕过 search，验证的是"行在不在"）
    fn fts_row_count(engine: &Engine, session_id: &str) -> i64 {
        engine
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT COUNT(*) FROM session_fts WHERE session_id = ?1",
                    params![session_id],
                    |r| r.get(0),
                )
                .map_err(DbError::from)
            })
            .unwrap()
    }

    #[test]
    fn fts_upsert_indexes_one_message_with_tokenized_content() {
        let (_d, engine) = eng("fts-upsert");
        seed_message(&engine, "s1", "m1", "存储迁移的可靠性");
        let out = fts_upsert(
            &engine,
            &json!({
                "session_id": "s1",
                "message_id": "m1",
                "content": "存储迁移的可靠性",
                "role": "user",
                "timestamp": 1
            }),
        )
        .unwrap();
        assert_eq!(out["written"], 1);
        assert_eq!(fts_row_count(&engine, "s1"), 1, "应该恰好一行");

        // 中文必须能被搜到 —— 这正是不切分时永远命中不了的那条路径
        let hits = fts_search(&engine, &json!({ "query": "存储迁移", "session_id": "s1" })).unwrap();
        let items = hits["items"].as_array().cloned().unwrap_or_default();
        assert!(
            // 注意键名是 `message_id`（搜索结果的线协议形状），不是 `id`
            items.iter().any(|i| i["message_id"] == "m1"),
            "切分后的中文索引必须能命中：{hits}"
        );
    }

    #[test]
    fn fts_upsert_rewrites_instead_of_duplicating() {
        let (_d, engine) = eng("fts-upsert-rewrite");
        seed_message(&engine, "s1", "m1", "第一版内容");
        fts_upsert(&engine, &json!({ "session_id": "s1", "message_id": "m1", "content": "第一版内容" })).unwrap();
        // 同一个 message_id 再写一次（消息更新）—— 必须是"重写"而不是"两行"
        fts_upsert(&engine, &json!({ "session_id": "s1", "message_id": "m1", "content": "第二版内容" })).unwrap();
        assert_eq!(fts_row_count(&engine, "s1"), 1, "同一 message_id 只该有一行（否则搜索会重复命中）");

        let old = fts_search(&engine, &json!({ "query": "第一版", "session_id": "s1" })).unwrap();
        assert_eq!(old["items"].as_array().unwrap().len(), 0, "旧内容不该还能搜到");
        let new = fts_search(&engine, &json!({ "query": "第二版", "session_id": "s1" })).unwrap();
        assert_eq!(new["items"].as_array().unwrap().len(), 1, "新内容必须能搜到");
    }

    #[test]
    fn fts_upsert_with_empty_content_removes_the_row() {
        let (_d, engine) = eng("fts-upsert-empty");
        seed_message(&engine, "s1", "m1", "有内容");
        fts_upsert(&engine, &json!({ "session_id": "s1", "message_id": "m1", "content": "有内容" })).unwrap();
        assert_eq!(fts_row_count(&engine, "s1"), 1);
        // 正文被清空 → 索引行也要消失（留着会造出"命中但正文为空"的假结果）
        let out = fts_upsert(&engine, &json!({ "session_id": "s1", "message_id": "m1", "content": "" })).unwrap();
        assert_eq!(out["written"], 0);
        assert_eq!(fts_row_count(&engine, "s1"), 0, "空正文不该留索引行");
    }

    #[test]
    fn fts_remove_deletes_only_requested_ids() {
        let (_d, engine) = eng("fts-remove");
        for id in ["m1", "m2", "m3"] {
            seed_message(&engine, "s1", id, "内容");
            fts_upsert(&engine, &json!({ "session_id": "s1", "message_id": id, "content": "内容" })).unwrap();
        }
        assert_eq!(fts_row_count(&engine, "s1"), 3);
        let out = fts_remove(&engine, &json!({ "session_id": "s1", "ids": ["m1", "m3"] })).unwrap();
        assert_eq!(out["written"], 2);
        assert_eq!(fts_row_count(&engine, "s1"), 1, "只该剩 m2");
    }

    #[test]
    fn fts_remove_rejects_empty_ids() {
        let (_d, engine) = eng("fts-remove-empty");
        // 空数组 = 调用方没想清楚要删什么 → 必须报错，而不是"静默什么都没做"
        let err = fts_remove(&engine, &json!({ "session_id": "s1", "ids": [] })).unwrap_err();
        assert_eq!(err.code, ErrorCode::Other);
    }

    // ========== 导入的**非破坏性**契约（第 11 轮，真机数据事故的根因）==========
    //
    // 背景（真机证据）：`migration.auto` 固定传 `replace: true`，而它原来的实现是
    // **把每张目标表整表清空再重灌**。于是"启动迁移"和"自检恢复"这两条自动路径
    // 每次都会先删掉用户数据 —— `storage_audit` 记下的两次删除（23:47:45Z 删一个会话
    // 的 277 条；01:13:34Z 删 **821 条全部** + 2131 事件）就是它。
    // 中间态一旦被打断就是真的丢数据，这正是历史事故的形态。
    //
    // 下面三条把"不许删"钉死：① 不能删目标端多出来的行；② 覆盖已存在行不能走
    // `INSERT OR REPLACE`（它会先 DELETE，父表触发子表级联）；③ 同名行仍要被更新。

    #[test]
    fn import_does_not_delete_rows_missing_from_source() {
        let (_d, engine) = eng("import-keep-extra");
        // 目标端已有两行（模拟"用户在新库里继续产生数据"）
        engine
            .write_tx(|tx| {
                for (k, v) in [("a", "1"), ("b", "2")] {
                    tx.execute(
                        "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?1, ?2, 1)",
                        params![k, v],
                    )
                    .map_err(DbError::from)?;
                }
                Ok(())
            })
            .unwrap();
        // 源端（旧库）只有 a
        import_all(
            &engine,
            &json!({
                "replace": true,
                "tables": [{
                    "table": "settings",
                    "columns": ["key", "value", "updated_at"],
                    "rows": [["a", "9", 2]],
                    "mode": "insert",
                }],
            }),
        )
        .unwrap();

        let keys: Vec<String> = engine
            .with_conn(|conn| {
                let mut stmt = conn
                    .prepare("SELECT key FROM settings ORDER BY key")
                    .map_err(DbError::from)?;
                let rows = stmt
                    .query_map([], |r| r.get::<_, String>(0))
                    .map_err(DbError::from)?;
                let mut out = Vec::new();
                for r in rows {
                    out.push(r.map_err(DbError::from)?);
                }
                Ok(out)
            })
            .unwrap();
        assert!(
            keys.contains(&"b".to_string()),
            "目标端多出来的行**绝不能**因为导入而消失（原来的整表清空会把它删掉）：{keys:?}"
        );
    }

    #[test]
    fn import_updating_parent_row_does_not_cascade_delete_children() {
        let (_d, engine) = eng("import-no-cascade");
        // 目标端：一个会话 s1 + 它的两条消息
        crate::repo::sessions_upsert(&engine, &json!({ "id": "s1", "title": "旧标题" })).unwrap();
        for id in ["m1", "m2"] {
            seed_message(&engine, "s1", id, "内容");
        }
        let before: i64 = engine
            .with_conn(|conn| {
                conn.query_row("SELECT COUNT(*) FROM messages", [], |r| r.get(0))
                    .map_err(DbError::from)
            })
            .unwrap();
        assert_eq!(before, 2);

        // 源端（旧库）里同名会话仍在 —— 导入它会"覆盖"这一行
        import_all(
            &engine,
            &json!({
                "replace": true,
                "tables": [{
                    "table": "sessions",
                    "columns": ["id", "project_id", "title", "created_at", "last_message_at", "message_count", "pinned"],
                    "rows": [["s1", "", "旧标题", 1, 1, 2, 0]],
                    "mode": "replace",
                }],
            }),
        )
        .unwrap();

        let after: i64 = engine
            .with_conn(|conn| {
                conn.query_row("SELECT COUNT(*) FROM messages", [], |r| r.get(0))
                    .map_err(DbError::from)
            })
            .unwrap();
        assert_eq!(
            after, 2,
            "覆盖已存在的会话行**不得**级联删掉它的消息 —— `INSERT OR REPLACE` 在 SQLite 里是 \
             先 DELETE 再 INSERT，父表被替换时子表会被 ON DELETE CASCADE 带走（这正是真机上 \
             '某个会话的消息凭空消失'的形态）"
        );
    }

    #[test]
    fn import_replace_mode_still_updates_existing_row_values() {
        let (_d, engine) = eng("import-upsert");
        engine
            .write_tx(|tx| {
                tx.execute(
                    "INSERT INTO settings (key, value, updated_at) VALUES ('k', 'old', 1)",
                    [],
                )
                .map_err(DbError::from)?;
                Ok(())
            })
            .unwrap();
        import_all(
            &engine,
            &json!({
                "tables": [{
                    "table": "settings",
                    "columns": ["key", "value", "updated_at"],
                    "rows": [["k", "new", 2]],
                    "mode": "replace",
                }],
            }),
        )
        .unwrap();
        let value: String = engine
            .with_conn(|conn| {
                conn.query_row("SELECT value FROM settings WHERE key = 'k'", [], |r| r.get(0))
                    .map_err(DbError::from)
            })
            .unwrap();
        assert_eq!(value, "new", "同名行仍必须被更新（两段式的 UPDATE 段要生效）");
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

/// 旧库某张表的**分页键**（第 45 轮 Z-8 的 keyset 分页）。
///
/// ## 为什么 `offset` 分页不够（审计实测的静默跳行）
///
/// `LIMIT ? OFFSET ?` 假设"两次查询之间源库不变"。而源库是**旧库**（可能是别的进程
/// 正在用的文件）：
/// ```text
/// （limit=2 翻页，翻页之间源库删掉 k1）
/// page1: rows k1,k2  next_offset=2
/// （删 k1）
/// page2: rows k4,k5   → k3 从未被任何一页读到（无任何提示）
/// ```
/// keyset（"从上一页最后一行的键之后接着读"）不依赖行号，因此不会因为它前面的行被删
/// 而跳过一行：删除只影响"已经读过的那部分"，这正是调用方要的语义。
///
/// ## 同时修掉 `WITHOUT ROWID` 的硬失败
///
/// 旧实现一律 `ORDER BY rowid`；而 `WITHOUT ROWID` 的表**没有 rowid**，于是
/// `legacy.read_table` 对它报 `no such column: rowid`（外部旧库可能出现这种表）。
/// 现在：**主键优先**（`id` 或 `PRAGMA table_info` 的 pk 列），没有主键才退回 `rowid`。
///
/// `key_index` 是"键列在 `SELECT *` 里的下标"，用于从返回行里取出游标值。
#[derive(Debug, Clone)]
struct LegacyPageKey {
    /// 排序/游标表达式（单列；可能是 `rowid`）
    expr: String,
    /// 该键在 `SELECT *` 结果里的列下标（`rowid` 不在结果里 → None）
    key_index: Option<usize>,
}

fn legacy_page_key(conn: &Connection, table: &str, columns: &[String]) -> Option<LegacyPageKey> {
    let pk: Vec<String> = {
        let mut stmt = conn
            .prepare(&format!("PRAGMA table_info(\"{table}\")"))
            .ok()?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, i64>(5)?, r.get::<_, String>(1)?)))
            .ok()?;
        let mut v: Vec<(i64, String)> = Vec::new();
        for r in rows {
            let (i, n) = r.ok()?;
            if i > 0 {
                v.push((i, n));
            }
        }
        v.sort_by_key(|(i, _)| *i);
        v.into_iter().map(|(_, n)| n).collect()
    };
    // 单列主键才能做 keyset（复合主键要拼多列比较，收益低于复杂度；退回 rowid）
    if pk.len() == 1 {
        if let Some(idx) = columns.iter().position(|c| c == &pk[0]) {
            return Some(LegacyPageKey {
                expr: format!("\"{}\"", pk[0]),
                key_index: Some(idx),
            });
        }
    }
    // 是否有 rowid（`WITHOUT ROWID` 表没有）
    let sql: Option<String> = conn
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name = ?1",
            [table],
            |r| r.get(0),
        )
        .ok();
    let without_rowid = sql
        .as_deref()
        .map(|s| s.to_uppercase().replace(['\n', '\r', '\t'], " ").contains("WITHOUT ROWID"))
        .unwrap_or(false);
    if without_rowid {
        // 没有 rowid 又没有（可用的）单列主键 → 无法 keyset，交给调用方回退 offset
        return None;
    }
    Some(LegacyPageKey {
        expr: "rowid".to_string(),
        key_index: None,
    })
}

/// 从一页返回行里取出游标值（**键列的原始值**，如 `"k2"` / `42`）。
///
/// `key_index` 为 None 即 rowid 型键：此时不提供游标（见 `legacy_page_key` 的说明，
/// `rowid` 不在 `SELECT *` 的结果列里）。
fn page_cursor_value(key: &LegacyPageKey, row: &Value) -> Option<Value> {
    key.key_index
        .and_then(|i| row.as_array().and_then(|a| a.get(i)).cloned())
}

/// 读旧库某张表的**一页**行。
///
/// 三种调用形态：
/// - `after = Some(cursor)`：**keyset**，从游标之后接着读（`offset` 必须为 0）；
/// - `after = None, offset = 0`：第一页（`LIMIT limit+1`，无 OFFSET），返回 `next_key` 可续页；
/// - `after = None, offset > 0`：老式 offset 分页（**保留**：既有调用方与既有测试依赖它；
///   但它就是 Z-8 那个会静默跳行的语义，所以返回里 `paging` 会标成 `"offset"`）。
///
/// 表不存在时返回空（旧库可能没有新表）。
/// 迁移自己用的是 `read_legacy_table`（整表：它本来就要全量搬），
/// 而 `legacy.read_table` 用这一页版 —— **分页在 SQL 里做**，
/// 而不是"整表读出来再 truncate"（后者会掩盖截断，见 `legacy_read_table` 的说明）。
fn read_legacy_table_page(
    conn: &Connection,
    table: &str,
    columns: &[String],
    limit: usize,
    offset: usize,
    after: Option<&Value>,
) -> DbResult<(Vec<Value>, usize, Option<Value>, bool)> {
    let exists: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
            [table],
            |r| r.get(0),
        )
        .map_err(DbError::from)?;
    if exists == 0 {
        return Ok((Vec::new(), 0, None, false));
    }
    let key = match legacy_page_key(conn, table, columns) {
        Some(k) => k,
        None => {
            /*
             * 连 keyset 都做不了的表（`WITHOUT ROWID` 且没有单列主键）：
             * 退回无排序的整页扫描（仍然受 `limit` 限制），并把 `next_key` 报成 null
             * —— 调用方由此知道"这张表不能安全翻页"，而不是静默拿到可能重复/跳过的页。
             */
            let sql = format!("SELECT * FROM \"{table}\" LIMIT ?1 OFFSET ?2");
            let mut stmt = conn.prepare(&sql).map_err(DbError::from)?;
            let col_count = stmt.column_count();
            let mut rows = stmt
                .query(params![limit as i64, offset as i64])
                .map_err(DbError::from)?;
            let mut out: Vec<Value> = Vec::new();
            let mut blob_columns_seen = 0usize;
            while let Some(row) = rows.next().map_err(DbError::from)? {
                let mut arr: Vec<Value> = Vec::with_capacity(col_count);
                for i in 0..col_count {
                    let v: SqlValue = row.get(i).map_err(DbError::from)?;
                    arr.push(legacy_value_to_json(v, &mut blob_columns_seen));
                }
                out.push(Value::Array(arr));
            }
            return Ok((out, blob_columns_seen, None, false));
        }
    };

    // 多取一行判断 has_more（避免额外 COUNT(*)；也避免"最后一页恰好满"时多跑一趟）。
    //
    // 游标是**键列的原始值**（第一页返回的那一行里键列的值），不是整行 JSON。
    //
    // ⚠️ 这里踩过一个坑，值得留痕：第一版把游标做成整行 JSON，再用 SQLite 的
    // `->>` / `json_extract` 在 WHERE 里取键值 —— 结果**续页静默返回空页**
    // （实测：第二页 rows 为空、has_more=false，看起来像"表读完了"）。
    // 原因是这个 crate 的 SQLite（bundled）**没有编入 JSON1**：`json_extract(?1, …)`
    // 不报错、只返回 NULL，于是 `key > NULL` 恒为 NULL/假。
    // 教训：**别把 JSON 函数放进迁移对账/分页这种"错了也看不出来"的路径** ——
    // 少一个 SQL 扩展不会报错，只会静默少数据。绑定一个普通值最稳。
    let (sql, bind_cursor, paged_by_offset) = match (&key.key_index, after) {
        (Some(_), Some(_)) => (
            format!(
                "SELECT * FROM \"{table}\" WHERE {} > ?1 ORDER BY {} LIMIT ?2",
                key.expr, key.expr
            ),
            true,
            false,
        ),
        /*
         * 第一页（无游标、无 offset）：keyset 语义 —— `LIMIT limit+1`、无 OFFSET，
         * 返回最后一行的键作为 `next_key`。老调用方给的 `offset > 0` 走下面那一支。
         */
        _ if offset == 0 => (
            format!("SELECT * FROM \"{table}\" ORDER BY {} LIMIT ?1", key.expr),
            false,
            false,
        ),
        // 老式 offset 分页（保留兼容；返回里 `paging` 会标成 offset）
        _ => (
            format!(
                "SELECT * FROM \"{table}\" ORDER BY {} LIMIT ?1 OFFSET ?2",
                key.expr
            ),
            false,
            true,
        ),
    };
    let mut stmt = conn.prepare(&sql).map_err(DbError::from)?;
    let col_count = stmt.column_count();
    let mut out: Vec<Value> = Vec::new();
    let mut blob_columns_seen = 0usize;
    {
        let mut collect = |rows: &mut rusqlite::Rows<'_>| -> DbResult<()> {
            while let Some(row) = rows.next().map_err(DbError::from)? {
                let mut arr: Vec<Value> = Vec::with_capacity(col_count);
                for i in 0..col_count {
                    let v: SqlValue = row.get(i).map_err(DbError::from)?;
                    arr.push(legacy_value_to_json(v, &mut blob_columns_seen));
                }
                out.push(Value::Array(arr));
            }
            Ok(())
        };
        if bind_cursor {
            // 游标值原样绑定（类型由 SQLite 按值决定：TEXT 键就是 TEXT 比较）
            let cursor = after.expect("bind_cursor 蕴含 after 为 Some");
            let bound = to_sql_value(cursor);
            let mut rows = stmt
                .query(params![bound, limit as i64 + 1])
                .map_err(DbError::from)?;
            collect(&mut rows)?;
        } else if paged_by_offset {
            let mut rows = stmt
                .query(params![limit as i64 + 1, offset as i64])
                .map_err(DbError::from)?;
            collect(&mut rows)?;
        } else {
            let mut rows = stmt.query(params![limit as i64 + 1]).map_err(DbError::from)?;
            collect(&mut rows)?;
        }
    }
    let has_more = out.len() > limit;
    if has_more {
        out.truncate(limit);
    }
    // `next_key` 只在"这一页确实是 LIMIT-only 的续页起点"时给出（offset 分页时它没有意义）
    let next_key = if has_more && !paged_by_offset && after.is_none() {
        out.last().and_then(|r| page_cursor_value(&key, r))
    } else {
        None
    };
    Ok((out, blob_columns_seen, next_key, has_more))
}

/// 旧库某个值 → JSON。
///
/// BLOB 用**十六进制**搬运（不引入 base64 依赖；十六进制只比 base64 大 33%，
/// 而旧库里真正的二进制列很少）。调用方拿到的是 `blobhex:<hex>` 前缀的文本，
/// 一眼能看出它原本是 BLOB；`blob_columns_seen` 让调用方能如实回报"有几处被改形"。
fn legacy_value_to_json(v: SqlValue, blob_columns_seen: &mut usize) -> Value {
    match v {
        SqlValue::Null => Value::Null,
        SqlValue::Integer(n) => json!(n),
        SqlValue::Real(f) => json!(f),
        SqlValue::Text(s) => Value::String(s),
        SqlValue::Blob(b) => {
            let mut hex = String::with_capacity(7 + b.len() * 2);
            hex.push_str("blobhex:");
            for byte in &b {
                hex.push_str(&format!("{byte:02x}"));
            }
            *blob_columns_seen += 1;
            Value::String(hex)
        }
    }
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
    /*
     * 显式排序（第 45 轮 Z-1 配套）：对账判据已经是顺序无关的多重集，
     * 排序**不是**为了让对账通过，而是为了让两端的行序可比、诊断数字稳定
     * （理由见 `legacy_order_clause`）。
     */
    let order = legacy_order_clause(conn, table);
    let sql = match &order {
        Some(o) => format!("SELECT * FROM \"{table}\" ORDER BY {o}"),
        None => format!("SELECT * FROM \"{table}\""),
    };
    let mut stmt = conn.prepare(&sql).map_err(DbError::from)?;
    let col_count = stmt.column_count();
    let mut rows = stmt.query([]).map_err(DbError::from)?;
    let mut out: Vec<Value> = Vec::new();
    let mut blob_columns_seen: usize = 0;
    while let Some(row) = rows.next().map_err(DbError::from)? {
        let mut arr: Vec<Value> = Vec::with_capacity(col_count);
        for i in 0..col_count {
            let v: SqlValue = row.get(i).map_err(DbError::from)?;
            arr.push(legacy_value_to_json(v, &mut blob_columns_seen));
        }
        out.push(Value::Array(arr));
    }
    Ok((out, blob_columns_seen))
}

/// `SELECT *` 的列名（顺序与行数组一致）
fn read_legacy_columns(conn: &Connection, table: &str) -> DbResult<Vec<String>> {
    let stmt = conn
        .prepare(&format!("SELECT * FROM \"{table}\" LIMIT 0"))
        .map_err(DbError::from)?;
    Ok(stmt
        .column_names()
        .iter()
        .map(|s| s.to_string())
        .collect::<Vec<_>>())
}

/// 对一组「二维数组行」按与 `table_digest` **完全相同**的规则算摘要（**顺序敏感**）。
///
/// 为什么要在内存里算：源端（旧库）的行已经被读成 JSON 了，
/// 只有用同一套 `value_bytes` 规则才能保证"搬得对不对"可比。
///
/// ⚠️ **不要用它做迁移对账**（第 45 轮 Z-1）：顺序滚动哈希要求两端**行序完全一致**，
/// 而两端都是无 `ORDER BY` 的扫描 —— 目标端只要"已有源端的子集且相对顺序不同"，
/// 摘要就必然不等（审计实测：源 6 行、目标已预置其中 2 行，6 行其实**都写进去了**，
/// 但顺序成了 `k1,k3,k2,k4,k5,k6` → 摘要不等 → 迁移标记写不上 → 每次启动重来一遍）。
/// 对账一律用 `MultisetDigest`（多重集，顺序无关）。
pub fn digest_json_rows(rows: &[Value]) -> (i64, String) {
    let mut h = ORDER_SENSITIVE_SEED;
    for row in rows {
        if let Some(arr) = row.as_array() {
            for v in arr {
                let sv = json_value_to_sql(v);
                for byte in value_bytes(&sv) {
                    h ^= i64::from(byte);
                    h = h.wrapping_mul(FNV_PRIME);
                }
                h ^= COL_SEP;
                h = h.wrapping_mul(FNV_PRIME);
            }
        }
        h ^= ROW_SEP;
        h = h.wrapping_mul(FNV_PRIME);
    }
    (rows.len() as i64, format!("{:016x}", h as u64))
}

/// JSON 值 → SQLite 值（与 `digest_rows` / `digest_json_rows` 同一套规则）
fn json_value_to_sql(v: &Value) -> SqlValue {
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

// ========== 多重集摘要（顺序无关的对账，第 45 轮 Z-1） ==========
//
// ## 为什么必须是"多重集"而不是"排序后再滚"
//
// 迁移对账要回答的问题是"**源端每一行是不是都到了目标端**"（内容 + 条数），
// 而**不是**"两边的行序是不是一样"。行序是 SQLite 的自由：`SELECT * FROM t`
// 不带 `ORDER BY` 时返回顺序取决于存储形态（普通表按 rowid、`WITHOUT ROWID` 按主键、
// 有索引时可能走覆盖索引扫描），目标端在 `INSERT OR IGNORE` 补行后新行的 rowid 落在**末尾**。
// 拿"顺序滚动哈希"当判据，等于把"两边的物理行序碰巧一致"当成了正确性条件 ——
// 那条件与"数据搬对了"无关，却会**永久**判失败。
//
// 所以：**逐行算一个摘要 → 排序 → 对排序后的序列再滚一次**。
// 这样"行序不同但内容相同"必然通过；而"内容不同/缺行/多行"必然不等。
// 行摘要本身还要带上**行数**信息，否则"同一行出现两次"与"该行出现一次"会撞
// （只在"重复行数刚好相等"的极端情形下才会撞，但那是可以不花代价就避免的）。

const FNV_PRIME: i64 = 0x100_0000_01b3;
/// 行、列分隔符（否则 ("ab","c") 与 ("a","bc") 会撞）
const COL_SEP: i64 = 0x1f;
const ROW_SEP: i64 = 0x1e;
/// FNV-1a 64 位偏移基准（正数写法：`-0x7a5b_2a3d_1c4f_9e11` 与它同值）
const ORDER_SENSITIVE_SEED: i64 = -0x7a5b_2a3d_1c4f_9e11;

/// 一批行的**顺序无关**摘要 + 重复行信息。
#[derive(Debug, Clone)]
pub struct MultisetDigest {
    rows: i64,
    /// 全部行摘要（含重复行的每一份），末尾排序后汇总
    parts: Vec<Vec<u8>>,
    /// 顺序敏感摘要（**仅供诊断**：用来回答"只是行序不同吗"）
    order_sensitive: i64,
}

impl MultisetDigest {
    pub fn new() -> Self {
        Self {
            rows: 0,
            parts: Vec::new(),
            order_sensitive: ORDER_SENSITIVE_SEED,
        }
    }

    /// 加一行（`values` 是该行按列顺序的值）。
    ///
    /// 同时维护两份摘要：
    /// - `parts` 里的**行摘要**（排序后汇总 → 顺序无关的多重集摘要，这是对账判据）；
    /// - `order_sensitive`（按行序滚动，与 `table_digest` / `digest_rows` 同规则）
    ///   —— **只用于诊断**"只是行序不同吗"，不参与判据。
    pub fn add_row<I: IntoIterator<Item = SqlValue>>(&mut self, values: I) {
        let mut h = ORDER_SENSITIVE_SEED;
        for v in values {
            let bytes = value_bytes(&v);
            // 行摘要：值字节 + 列分隔
            for byte in &bytes {
                h ^= i64::from(*byte);
                h = h.wrapping_mul(FNV_PRIME);
            }
            h ^= COL_SEP;
            h = h.wrapping_mul(FNV_PRIME);
            // 顺序敏感摘要：与 `table_digest` 完全同规则（同一份 `value_bytes`）
            for byte in bytes {
                self.order_sensitive ^= i64::from(byte);
                self.order_sensitive = self.order_sensitive.wrapping_mul(FNV_PRIME);
            }
            self.order_sensitive ^= COL_SEP;
            self.order_sensitive = self.order_sensitive.wrapping_mul(FNV_PRIME);
        }
        h ^= ROW_SEP;
        h = h.wrapping_mul(FNV_PRIME);
        self.order_sensitive ^= ROW_SEP;
        self.order_sensitive = self.order_sensitive.wrapping_mul(FNV_PRIME);
        // 行摘要的字节表示（排序键）：`<16 位十六进制>`
        self.parts.push(format!("{h:016x}").into_bytes());
        self.rows += 1;
    }

    /// 收尾：排序 → 汇总。
    pub fn finish(mut self) -> MultisetStats {
        self.parts.sort();
        // 重复行计数（排序后相邻比较；`parts` 里每行一份）
        let mut dups = 0i64;
        let mut singles = 0i64;
        let mut i = 0usize;
        while i < self.parts.len() {
            let mut j = i + 1;
            while j < self.parts.len() && self.parts[j] == self.parts[i] {
                j += 1;
            }
            if j - i == 1 {
                singles += 1;
            } else {
                dups += 1;
            }
            i = j;
        }
        let mut hash = ORDER_SENSITIVE_SEED;
        for part in &self.parts {
            for byte in part {
                hash ^= i64::from(*byte);
                hash = hash.wrapping_mul(FNV_PRIME);
            }
            hash ^= ROW_SEP;
            hash = hash.wrapping_mul(FNV_PRIME);
        }
        MultisetStats {
            rows: self.rows,
            distinct: singles + dups,
            singles,
            dup_group_count: dups,
            rows_in_dup_groups: self.rows - singles,
            digest: format!("{:016x}", hash as u64),
            order_sensitive_digest: format!("{:016x}", self.order_sensitive as u64),
        }
    }
}

impl Default for MultisetDigest {
    fn default() -> Self {
        Self::new()
    }
}

/// `MultisetDigest::finish` 的结果
#[derive(Debug, Clone)]
pub struct MultisetStats {
    /// 总行数
    pub rows: i64,
    /// 不同行数（按行内容去重后）
    pub distinct: i64,
    /// 只出现一次的行数
    pub singles: i64,
    /// 出现多次的行**内容**种类数（>0 说明有重复行）
    pub dup_group_count: i64,
    /// 落在重复组里的**行数**（重复行总数）
    pub rows_in_dup_groups: i64,
    /// **顺序无关**摘要（对账判据）
    pub digest: String,
    /// 顺序敏感摘要（诊断用：判断"只是行序不同"）
    pub order_sensitive_digest: String,
}

/// 对一组「二维数组行」算**多重集**摘要（顺序无关；拿来做对账判据）。
pub fn digest_json_rows_multiset(rows: &[Value]) -> MultisetStats {
    let mut d = MultisetDigest::new();
    for row in rows {
        if let Some(arr) = row.as_array() {
            d.add_row(arr.iter().map(json_value_to_sql));
        }
    }
    d.finish()
}

/// 迁移对账的结论（三分类，第 45 轮 Z-1 要求"报错要能区分三种情形"）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReconcileVerdict {
    /// 内容完全相同（可能行序不同）
    Identical {
        /// 行序不同（内容与条数完全一致）—— 这不是缺陷，但要如实说出来
        order_differs: bool,
    },
    /// 源端的行**都在**目标端，但目标端多出行（"新库比旧库新"的正常情形）
    SourceCovered {
        /// 目标端多出来的行数
        extra_rows: i64,
    },
    /// 目标端**缺行**：源端有些行没到目标端（这才是"数据搬丢了"）
    MissingRows {
        missing_rows: i64,
    },
    /// 同一张表的两端内容不同（行数可能相同，但某些行内容不一致）
    ContentDiffers {
        /// 内容不同但两边都有的行数（按多重集差估算）
        differing_rows: i64,
    },
}

/// 两端的多重集对账。返回**结论 + 细节**，由调用方决定怎么报。
///
/// 关键点：判据只看**行内容的多重集**，与行序无关 —— 这是 Z-1 的核心修复。
pub fn reconcile_multisets(src: &MultisetStats, tgt: &MultisetStats) -> ReconcileVerdict {
    if src.digest == tgt.digest && src.rows == tgt.rows {
        return ReconcileVerdict::Identical {
            order_differs: src.order_sensitive_digest != tgt.order_sensitive_digest,
        };
    }
    if tgt.rows > src.rows {
        return ReconcileVerdict::SourceCovered {
            extra_rows: tgt.rows - src.rows,
        };
    }
    if tgt.rows < src.rows {
        return ReconcileVerdict::MissingRows {
            missing_rows: src.rows - tgt.rows,
        };
    }
    // 行数相同、多重集不同 → 内容不一致（定位不到具体哪几行：行摘要已哈希，见函数头说明）
    ReconcileVerdict::ContentDiffers {
        differing_rows: 0,
    }
}

/// 旧库某张表的**扫描顺序**（第 45 轮 Z-1 配套）。
///
/// ## 为什么必须显式排序（不是"排序能让对账通过"）
///
/// 对账已经改成多重集（与行序无关），所以排序**不是**对账的前提。这里排序是为了：
/// ① mismatch 时的诊断数字稳定（否则同一个库两次跑出来的报告不一样，没法对比）；
/// ② 迁移工具/人工排查时两端的行序可比（"源第 3 行 ↔ 目标第 3 行"才有意义）；
/// ③ `digest_json_rows`（顺序敏感的那份摘要）在两边都是确定值，能作为"行序是否相同"的判据。
///
/// 排序键的选择：**主键优先**（`id` 是这些表的主键，且两端都存在），
/// 没有 `id` 才退回 `rowid`；`WITHOUT ROWID` 表没有 rowid，只能靠主键。
/// 取不到任何排序键时**不排序**（返回 `None`）—— 宁可退回原行为，
/// 也不要拼一条会报 `no such column` 的 SQL 让整次迁移失败。
fn legacy_order_clause(conn: &Connection, table: &str) -> Option<String> {
    let cols: Vec<String> = {
        let mut stmt = conn
            .prepare(&format!("PRAGMA table_info(\"{table}\")"))
            .ok()?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(1)).ok()?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.ok()?);
        }
        out
    };
    if cols.iter().any(|c| c == "id") {
        return Some("\"id\"".to_string());
    }
    // `WITHOUT ROWID` 表：`ORDER BY rowid` 会硬失败（`no such column: rowid`），
    // 只能用主键。主键列按 pk 序号取。
    let pk: Vec<String> = {
        let mut stmt = conn
            .prepare(&format!("PRAGMA table_info(\"{table}\")"))
            .ok()?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, i64>(5)?, r.get::<_, String>(1)?)))
            .ok()?;
        let mut v: Vec<(i64, String)> = Vec::new();
        for r in rows {
            let (i, n) = r.ok()?;
            if i > 0 {
                v.push((i, n));
            }
        }
        v.sort_by_key(|(i, _)| *i);
        v.into_iter().map(|(_, n)| n).collect()
    };
    if pk.is_empty() {
        return None;
    }
    Some(
        pk.iter()
            .map(|c| format!("\"{c}\""))
            .collect::<Vec<_>>()
            .join(", "),
    )
}

/// 清理旧的 `<db>.pre-migration-<stamp>` 备份，只保留最近 `keep` 份（含刚生成的那份）。
///
/// 返回 `(被删掉的文件名, 失败信息)`。
///
/// ## 命名解析刻意保守（宁可漏删，不可误删）
///
/// 只认 `<当前库文件名>.pre-migration-<纯数字>` 这一种形态：
/// - 前缀必须逐字等于**当前库文件名** + `.pre-migration-` —— 于是别的库、别的用途的
///   同名文件不会被误判（多库共用一个目录时这一点很重要）；
/// - 后缀必须是**纯数字**（毫秒时间戳），否则不算我们的备份；
/// - `keep` 至少为 1（调用方已 clamp），所以"刚生成的那份"永远不会被自己删掉。
///
/// 排序用文件名里的时间戳（**数字比较**，不是字符串比较 —— 字符串比较在位数变化时
/// 会给出错误顺序，而毫秒时间戳的位数确实会变），目录读取失败时直接放弃清理。
fn prune_pre_migration_backups(current: &std::path::Path, keep: usize) -> (Vec<String>, Vec<String>) {
    let mut removed: Vec<String> = Vec::new();
    let mut errors: Vec<String> = Vec::new();
    let Some(file_name) = current.file_name().map(|s| s.to_string_lossy().to_string()) else {
        return (removed, errors);
    };
    let Some(dir) = current.parent() else {
        return (removed, errors);
    };
    // `<库文件名>.pre-migration-<毫秒>` → 取出 `<毫秒>`
    let prefix = match file_name.find(".pre-migration-") {
        Some(i) => file_name[..i + ".pre-migration-".len()].to_string(),
        None => return (removed, errors),
    };
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(e) => {
            errors.push(format!("{} 目录不可读：{e}", dir.display()));
            return (removed, errors);
        }
    };
    let mut found: Vec<(i64, std::path::PathBuf)> = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let Some(rest) = name.strip_prefix(&prefix) else {
            continue;
        };
        let Ok(stamp) = rest.parse::<i64>() else {
            continue;
        };
        found.push((stamp, entry.path()));
    }
    // 新的在前
    found.sort_by(|a, b| b.0.cmp(&a.0));
    for (_, path) in found.into_iter().skip(keep) {
        let name = path.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        match std::fs::remove_file(&path) {
            Ok(_) => removed.push(name),
            // 清理失败不该让迁移失败（它只是清理）—— 如实记账，由调用方报出来
            Err(e) => errors.push(format!("{name}: {e}")),
        }
    }
    (removed, errors)
}

/// **自动迁移**：把旧库（sql.js 落盘的 `codem-db.bin`）搬进当前 Rust 库。
///
/// 参数：`{ "legacy_path": "…", "dry_run": false }`
///
/// 另接受 `keep_backups`（默认 2）：迁移前那份整库备份保留几份，更旧的删掉
/// —— 理由见函数体内"备份保留策略"那段（迁移失败会每次启动重试，不清理就是无限堆副本）。
pub fn auto_migrate(engine: &Engine, p: &Value) -> DbResult<Value> {
    let legacy_path = p
        .get("legacy_path")
        .and_then(|x| x.as_str())
        .ok_or_else(|| DbError::missing("legacy_path"))?
        .to_string();
    let dry_run = p.get("dry_run").and_then(|x| x.as_bool()).unwrap_or(false);
    /* 目标库非空时是否仍允许迁移（默认**不允许**，见下面的守卫） */
    let force = p.get("force").and_then(|x| x.as_bool()).unwrap_or(false);

    if !std::path::Path::new(&legacy_path).exists() {
        return Err(DbError::not_found(format!("旧库不存在：{legacy_path}")));
    }

    /*
     * **守卫：目标库已有消息时拒绝自动迁移**（第 11 轮，真机数据事故的防线之二）。
     *
     * `migration.auto` 是唯一一条"整库重写"的命令，而它的判据全在渲染侧
     * （标记在不在、新库是不是空的）。渲染侧任何一次"读失败被当成空"都会让它跑起来 ——
     * 真机证据 `storage_audit`：2026-09-17T01:13:34Z 一次性删掉 3 个会话 + 821 条消息
     * （全部）+ 883 tool_calls + 2131 事件，正好发生在应用自己拉起迁移/恢复的那一秒。
     *
     * 所以把"能不能跑"这件事**也放到引擎侧判一次**（纵深防御）：
     * - 目标库 `messages` 有行 → 只有在调用方**显式** `force: true` 时才继续；
     * - 首次迁移与自检恢复这两种合法场景，目标库本来就是空的，判据自然通过。
     *
     * 报错文案要说清"有多少行、为什么不搬"，而不是含糊的拒绝。
     */
    if !dry_run && !force {
        let target_messages: i64 = engine.with_conn(|conn| {
            conn.query_row("SELECT COUNT(*) FROM messages", [], |r| r.get(0))
                .map_err(DbError::from)
        })?;
        if target_messages > 0 {
            return Err(DbError::new(
                ErrorCode::Other,
                format!(
                    "新库里已有 {target_messages} 条消息，拒绝自动迁移（避免把旧库那份历史副本覆盖到更新的数据上）。\
                     确实要以旧库为准时，显式传 force: true"
                ),
            ));
        }
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
    /*
     * 源端逐表读数（行数 + 内容摘要 + **列清单**）。
     *
     * `columns` 是第 44 轮补上的，理由见下面目标端对账那段：
     * 摘要必须**按同一套列**算，否则"新 schema 加了一列"就会让对账永久失败。
     */
    struct SourceTable {
        table: String,
        rows: i64,
        digest: String,
        columns: Vec<String>,
        /// **多重集**统计（顺序无关；对账判据）
        multi: MultisetStats,
    }
    let mut source_rows: Vec<SourceTable> = Vec::new();
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
        /*
         * 对账判据用**多重集**（顺序无关），`digest` 只作为"行序是否相同"的诊断量。
         * 见 `MultisetDigest` 的说明：顺序滚动哈希会把"两端物理行序碰巧一致"当成正确性条件。
         */
        let multi = digest_json_rows_multiset(&rows);
        source_rows.push(SourceTable {
            table: table.to_string(),
            rows: n,
            digest,
            columns: columns.clone(),
            multi,
        });
        if !rows.is_empty() {
            /*
             * ⚠️ 这里**刻意不写每一项的 `mode`**（第 44 轮修掉的真机缺陷）。
             *
             * 原来这里硬编码 `"mode": "insert"`，而本函数末尾给 `import_all` 传的是
             * `{ "tables": […], "replace": true }` —— 两处**互相矛盾**，而 `import_all`
             * 只看每一项的 `mode`：于是"覆盖已存在的行"这件事从来没发生过。
             *
             * 后果（真机形态，见 `import_all` 里那段说明）：
             * `INSERT OR IGNORE` 撞主键就静默跳过 → 目标里那一行仍是旧值 →
             * 对账按**内容摘要**比对必然不等 → `migration.auto` 报"对账未通过"、
             * **不写迁移标记** → 下次启动再来一遍（永远修不好，每次都全量读旧库 + 重建 FTS）。
             * 真机审计里"11.8 小时 16 次"正是这种"每轮看起来都正常、却总也完不成"的形态。
             *
             * 现在只留**一个**真相来源：顶层的 `replace: true`（`import_all` 会读它作为
             * 每一项的默认 mode）。两处都写、还能写不一致，本身就是缺陷的温床。
             */
            jobs.push(json!({
                "table": table,
                "columns": columns,
                "rows": rows,
            }));
        }
    }

    if dry_run {
        return Ok(json!({
            "dry_run": true,
            "legacy_path": legacy_path,
            "tables": jobs.len(),
            "rows": source_rows.iter().map(|s| s.rows).sum::<i64>(),
            "per_table": source_rows
                .iter()
                .map(|s| json!({ "table": s.table, "rows": s.rows, "digest": s.digest, "columns": s.columns.len() }))
                .collect::<Vec<_>>(),
        }));
    }

    // 单事务导入（**整表清空已彻底去掉**，见 `import_all` 里那段说明：
    // `replace: true` 曾经让每一次自动迁移都先把新库清空再重灌，是历史上"数据变 0"的形态）
    //
    // 第 44 轮加的两道保险（针对真机审计里那 16 次"全库删除 + 重灌"）：
    //
    // ① **执行前先备份整个库文件**。真机取证显示这件事曾经发生过 16 次，
    //    每次清空 3,838 行（当时全库内容）。现在实现上已经不会清空了，
    //    但"整库级操作之前先留一份"是这类命令**唯一**能在事后补救的手段 ——
    //    而它只在真正要写的时候做（`dry_run` 不备份）。
    //    先 `checkpoint` 再拷贝：否则最新数据还在 `-wal` 里，拷出来的"备份"是旧的
    //    （这一点很容易漏，结果就是"备份看着有、内容却是几小时前的"）。
    // ② **把这次迁移的关键数字写进返回**（表数 / 行数 / 备份路径），
    //    让"跑过一次迁移"这件事在日志与审计里都有据可查。
    engine.checkpoint()?;
    /*
     * 备份保留策略（第 45 轮 Z-1 的后半条）。
     *
     * ## 为什么必须有
     *
     * 备份文件叫 `<db>.pre-migration-<毫秒时间戳>`，而**迁移失败时不会写标记**
     * （对账不通过就不写）→ 下次启动再试一遍 → **再拷一份整库副本**。
     * 真机形态：迁移在 11.8 小时里跑过 16 次，也就是 16 份整库副本；
     * 而生产库是几百 MB 量级 → 磁盘会被备份填满，然后备份失败导致迁移彻底跑不动
     * （"每次启动重试"这个循环恰好也是 Z-1 主缺陷的后果链之一）。
     * 备份是**补救手段**，不该变成新的故障源。
     *
     * ## 策略与依据
     *
     * 保留最近 `keep_backups` 份（默认 **2**），更旧的删掉。
     * 依据：
     * ① 这份备份要救的场景是"这次迁移把库改坏了" —— 需要的永远是**最近**的那一两份，
     *    而不是全部历史；
     * ② 2 份而不是 1 份：迁移连续跑两次（第二次仍失败）时，第 1 份是"第一次迁移前"、
     *    第 2 份是"第一次迁移之后"的状态，两份都在才能对比出"这次改动干了什么"；
     * ③ 只删**本函数命名规则**下的文件（`<db 文件名>.pre-migration-<数字>`），
     *    绝不碰 `.corrupt-*`（`engine` 在库损坏时的备份，可能是唯一能救的副本）
     *    或任何用户自己放的文件；
     * ④ 清理**在拷贝成功之后**做，且失败只记账不报错 ——
     *    "删旧备份失败"绝不能让一次本来能成的迁移失败（它只是清理，不是数据操作）。
     */
    let keep_backups = p
        .get("keep_backups")
        .and_then(|x| x.as_i64())
        .unwrap_or(2)
        .clamp(1, 100) as usize;
    let backup_path = {
        let src = engine.path().to_path_buf();
        let stamp = crate::schema::now_ms();
        let mut name = src.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        name.push_str(&format!(".pre-migration-{stamp}"));
        let dst = src.with_file_name(name);
        if let Err(e) = std::fs::copy(&src, &dst) {
            /*
             * 备份失败**必须中止**，不能"报个错继续搬"。
             * 整库重写 + 无备份 = 一旦判据错了就是不可逆的数据丢失；
             * 而备份失败（磁盘满 / 权限）恰恰说明环境已经不正常，
             * 此时继续做整库操作是最不该做的选择。
             */
            return Err(DbError::new(
                ErrorCode::Io,
                format!(
                    "迁移前备份失败（{}→{}）：{e}。已中止迁移 —— 整库级操作在没有备份的情况下不执行",
                    src.display(),
                    dst.display()
                ),
            ));
        }
        dst
    };

    // 拷贝成功后按策略清理旧备份（返回 (删掉的文件名, 失败信息)，用于如实汇报）
    let (pruned_backups, prune_errors) = prune_pre_migration_backups(&backup_path, keep_backups);

    let payload = json!({ "tables": jobs, "replace": true });
    let imported = import_all(engine, &payload)?;
    let _ = imported;

    // **对账**：逐表比对行数与内容摘要（两端各自算）
    let mut mismatches: Vec<Value> = Vec::new();
    let mut reconciled: Vec<Value> = Vec::new();
    /* 目标端比源端多的表（用户在新库里继续产生的数据，**刻意保留**） */
    let mut kept_newer: Vec<Value> = Vec::new();
    for src in &source_rows {
        let table = &src.table;
        /*
         * ## 摘要必须按**同一套列**算（第 44 轮修掉的真机缺陷）
         *
         * 这里原来是两端各 `SELECT *` 再逐列编码。而源端是**旧库**（老 schema）、
         * 目标端是**新库**（schema 已经过迁移加过列）—— 于是只要新 schema 多加一列，
         * 两端的列数就不同、摘要**必然**不等、对账**永远**失败：
         * 迁移标记写不上 → 下次启动再来一遍（真机审计里"11.8 小时 16 次"正是这个形态）。
         *
         * 这个坑在给 `messages` 加 `trimmed` 列时被实测抓到：
         * 真 CLI 复现——源 16 列 / 目标 17 列，两边都是 821 行，摘要却不等；
         * 只把那一列补到源库里做对照，同一个迁移立刻成功。
         * 也就是说：**给新 schema 加一列就永久打死自动迁移**，
         * 而"加列"恰恰是这套 schema 演进里最常见的动作 —— 所以必须按列投影，不能 `SELECT *`。
         *
         * 投影到**源端的列清单**：那正是本次导入实际搬运（也是唯一声明要覆盖）的列，
         * 因此"搬得对不对"的答案恰好落在这个子集上。目标端多出来的列（如 `trimmed`）
         * 与本次迁移无关，不参与比对；列顺序也必须与源端一致（摘要按顺序逐个编码）。
         */
        let projection: String = src
            .columns
            .iter()
            .map(|c| format!("\"{c}\""))
            .collect::<Vec<_>>()
            .join(", ");
        /*
         * 目标端扫描也显式排序（与源端同一个键：主键优先）。
         *
         * ⚠️ 排序**不是**对账通过的前提（判据已经是顺序无关的多重集），它只是让
         * ① 诊断数字稳定、② 两端行序可比、③ 顺序敏感摘要成为"行序是否相同"的可信判据。
         * 这也解释了为什么"只加一个 ORDER BY"**不够**：目标端只要"已有源端子集且顺序不同"，
         * 顺序敏感摘要就仍然不等 —— 真正的修复在判据上（多重集），不在扫描顺序上。
         */
        let target_order = engine.with_conn(|conn| Ok(legacy_order_clause(conn, table)))?;
        let after = engine.with_conn(|conn| {
            let exists: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                    [table.as_str()],
                    |r| r.get(0),
                )
                .map_err(DbError::from)?;
            if exists == 0 {
                return Ok((MultisetDigest::new().finish(), String::new(), Vec::<String>::new(), String::new()));
            }
            // 目标端真实列清单：既用于诊断"是哪一列不一致"，也用于判断投影能否执行
            let target_cols: Vec<String> = {
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
            };
            // 源端有、目标端没有的列：导入时会被 SQLite 拒绝（INSERT 撞未知列），
            // 所以正常走不到这里；真出现时按"缺列"如实报出，**不要**伪装成内容不一致。
            let missing: Vec<String> = src
                .columns
                .iter()
                .filter(|c| !target_cols.contains(c))
                .cloned()
                .collect();
            if !missing.is_empty() {
                return Ok((
                    MultisetDigest::new().finish(),
                    format!("目标端缺少列：{}", missing.join(", ")),
                    target_cols,
                    String::new(),
                ));
            }
            let base = if projection.is_empty() {
                format!("SELECT * FROM \"{table}\"")
            } else {
                format!("SELECT {projection} FROM \"{table}\"")
            };
            let sql = match &target_order {
                Some(o) => format!("{base} ORDER BY {o}"),
                None => base,
            };
            let mut stmt = conn.prepare(&sql).map_err(DbError::from)?;
            let col_count = stmt.column_count();
            let mut rows = stmt.query([]).map_err(DbError::from)?;
            let mut multi = MultisetDigest::new();
            while let Some(row) = rows.next().map_err(DbError::from)? {
                let mut vals: Vec<SqlValue> = Vec::with_capacity(col_count);
                for i in 0..col_count {
                    vals.push(row.get(i).map_err(DbError::from)?);
                }
                multi.add_row(vals);
            }
            let stats = multi.finish();
            Ok((stats, String::new(), target_cols, src.columns.join(", ")))
        })?;
        let (target_stats, columns_note, _target_cols, _projection_note) = after;
        let src_rows = &src.rows;
        let src_digest = &src.digest;
        /*
         * ## 对账判据（第 45 轮 Z-1 **重写**）
         *
         * ### 原来的判据为什么是错的
         *
         * 原来：`target_rows < src_rows`，或者"行数相等但**顺序滚动摘要**不等" → 判失败。
         * 而两端都是无 `ORDER BY` 的扫描，目标端只要"**已有源端的子集**且相对顺序不同"，
         * 补进来的新行 rowid 落在末尾，行序必然错位、摘要必然不等。审计实测（源 6 行、
         * 目标预置其中 2 行）：6 行**其实都写进去了**，顺序成了 `k1,k3,k2,k4,k5,k6`，
         * 却报"对账未通过（1 张表）" → **不写迁移标记** → 每次启动重来一遍：
         * 全量读旧库 + 重建 FTS + **再拷一份整库备份**（无清理策略时无限堆积）。
         *
         * ### 现在的判据
         *
         * 只看**行内容的多重集**（逐行摘要 → 排序 → 汇总，顺序无关）：
         * - 多重集相同 ⇒ 通过（无论行序如何）；行序不同只作为事实如实报出，不是失败；
         * - 目标端多行 ⇒ 通过（"新库比旧库新"的正常情形，如实报出多出来的行数）；
         * - 目标端少行 ⇒ **失败**（这才是"数据搬丢了"）；
         * - 行数相同但多重集不同 ⇒ **失败**，且文案说"内容不一致"，
         *   而不是含糊地说"对账未通过"（原来那种文案让人以为数据丢了）。
         */
        let verdict = if !columns_note.is_empty() {
            // 投影都执行不了：按"缺列"如实报（不要伪装成内容不一致）
            ReconcileVerdict::ContentDiffers { differing_rows: 0 }
        } else {
            reconcile_multisets(&src.multi, &target_stats)
        };
        match verdict {
            ReconcileVerdict::Identical { order_differs } => {
                reconciled.push(json!({
                    "table": table,
                    "rows": src_rows,
                    "digest": src_digest,
                    // 行序是否不同（内容与条数完全一致时的诊断信息，不是失败）
                    "order_differs": order_differs,
                    "duplicate_rows": src.multi.rows_in_dup_groups,
                }));
            }
            ReconcileVerdict::SourceCovered { extra_rows } => {
                kept_newer.push(json!({
                    "table": table,
                    "target_rows": target_stats.rows,
                    "source_rows": src_rows,
                    "extra_rows": extra_rows,
                }));
                reconciled.push(json!({
                    "table": table,
                    "rows": src_rows,
                    "digest": src_digest,
                    "target_rows": target_stats.rows,
                    "order_differs": src.multi.order_sensitive_digest != target_stats.order_sensitive_digest,
                }));
            }
            ReconcileVerdict::MissingRows { missing_rows } => {
                mismatches.push(json!({
                    "table": table,
                    "kind": "missing_rows",
                    "why": format!("目标端比源端少 {missing_rows} 行 —— 源端的数据没有全部搬过来（这是真的搬丢了）"),
                    "source_rows": src_rows, "source_digest": src_digest,
                    "target_rows": target_stats.rows, "target_digest": target_stats.digest,
                    "source_columns": src.columns.len(),
                }));
            }
            ReconcileVerdict::ContentDiffers { differing_rows } => {
                mismatches.push(json!({
                    "table": table,
                    "kind": "content_differs",
                    "why": if columns_note.is_empty() {
                        "两端行数相同但**内容不一致**（多重集不同）：不是行序问题，也不是缺行".to_string()
                    } else {
                        columns_note.clone()
                    },
                    "source_rows": src_rows, "source_digest": src_digest,
                    "target_rows": target_stats.rows, "target_digest": target_stats.digest,
                    "source_columns": src.columns.len(),
                    "order_sensitive_same": src_digest == &target_stats.order_sensitive_digest,
                    "differing_rows_at_least": differing_rows,
                }));
            }
        }
    }

    if !mismatches.is_empty() {
        /*
         * 对账不通过 → **不写标记**（下次启动会再试），并如实报错。
         *
         * ⚠️ 文案必须让调用方**一眼分清**三种情形（第 45 轮 Z-1 的第 3 条要求）：
         * - `kind: "missing_rows"`：目标端**少行** —— 这才是"数据搬丢了"；
         * - `kind: "content_differs"`：行数相同但内容不一致（不是行序问题）；
         * - 行序不同**不算失败**（多重集相同即通过），只在成功路径里以
         *   `order_differs: true` 如实报出。
         *
         * 原来的文案只有一句"自动迁移对账未通过（1 张表）：[{…source_digest…target_digest…}]"，
         * 于是"目标端已有源端子集、只是行序不同"这种**完全成功**的迁移被报成了失败，
         * 而数字（`source_rows: 6, target_rows: 6`）看起来又像"数据丢了"。
         */
        return Err(DbError::new(
            ErrorCode::Other,
            format!(
                "自动迁移对账未通过（{} 张表）：{}",
                mismatches.len(),
                serde_json::to_string(&mismatches).unwrap_or_default()
            ),
        ));
    }

    // **重建 FTS**（第 25 轮）：迁移进来的 session_fts 是老库那份"unicode61 时代"的原始文本，
    // 而中文搜索依赖 fts::tokenize 的 CJK bigram 切分 —— 不重建的话
    // **英文能搜、中文恒为 0 条**（实测：库里 LIKE 命中 21 行、FTS 查询 0 条）。
    // 行数对账发现不了这种"索引形态不对"，所以必须显式重建，且默认在这里做。
    let fts = fts_rebuild_all(engine, &json!({}))?;

    // 对账通过 → 记录标记（"只搬一次"的依据）
    let at = crate::schema::now_ms();
    mark_migrated(engine, &json!({ "at": at }))?;

    Ok(json!({
        "migrated": true,
        "legacy_path": legacy_path,
        "tables": reconciled.len(),
        "rows": reconciled.iter().filter_map(|t| t.get("rows").and_then(|v| v.as_i64())).sum::<i64>(),
        "per_table": reconciled,
        // 目标端比源端多的表：如实报出来（从前这个差异是靠"整表清空"抹平的）
        "kept_newer": kept_newer,
        "skipped": skipped.iter().map(|(t, n)| json!({ "what": t, "rows": n })).collect::<Vec<_>>(),
        // BLOB 列被转成 `blobhex:` 文本搬运 —— 数量如实上报（静默改形是最坏的一种）
        "blob_columns_converted": blob_columns_total,
        "fts": fts,
        /*
         * 第 44 轮：把"这次整库级操作干了什么"的关键事实留在返回值里。
         *
         * 真机审计显示 `migration.auto` 曾经在 11.8 小时内跑过 **16 次**，
         * 每次清空 3,838 行（当时全库内容）—— 而当时的返回值里
         * **看不出"这是一次清空"**，事后只能靠 `storage_audit` 的 61,404 条记录反推。
         * 现在至少三件事是可查的：有哪些表被搬了、总量多少、备份文件在哪。
         */
        "backup_path": backup_path.to_string_lossy().to_string(),
        /*
         * 第 45 轮（Z-1）：备份保留策略的**执行结果**如实给出。
         *
         * 备份是整库副本，"每次启动重试都再拷一份"会填满磁盘，所以按策略清理；
         * 清理了什么、有没有删失败，都必须能被看到（静默删用户目录里的文件是不可接受的）。
         */
        "backups_kept": keep_backups,
        "backups_pruned": pruned_backups,
        "backups_prune_errors": prune_errors,
        /*
         * 第 45 轮（Z-1）：把"行序"这件事也如实报出来。
         *
         * 对账判据已经**与行序无关**（多重集）；`order_differs` 只是在
         * "内容与条数完全一致、但两端物理行序不同"时给一个事实说明 ——
         * 这正是老判据会误报失败的那种情形（目标端预置了源端子集 → INSERT OR IGNORE
         * 补在末尾 → 行序错位）。有了这个字段，排查时不需要再去猜"是不是行序问题"。
         */
        "order_differs_tables": reconciled
            .iter()
            .filter(|t| t.get("order_differs").and_then(|v| v.as_bool()).unwrap_or(false))
            .filter_map(|t| t.get("table").and_then(|v| v.as_str()))
            .collect::<Vec<_>>(),
        "forced": force,
    }))
}

/// **全库 FTS 重建**（第 25 轮）：对每个有消息的会话跑一遍 `fts_rebuild`。
///
/// ## 为什么迁移后必须做这一步
///
/// 中文搜索依赖 `fts::tokenize` 的 **CJK bigram 切分**：索引里存的是切分后的文本，
/// 查询也要按同一套规则切分才能匹配。而迁移进来的 `session_fts` 内容
/// （老库那份）是 **unicode61 时代**的原始文本 —— 于是：
///
/// - 英文搜索正常（ASCII 词原样保留，两边一致）；
/// - **中文搜索恒为 0 条**（实测：`消息` 在库里 LIKE 命中 21 行，FTS 查询返回 0；
///   重建后同一个查询返回 21 条）。
///
/// 这是"迁移搬对了行、但索引形态不对"的典型 —— 行数对账发现不了它，
/// 所以必须显式重建，并且**默认在自动迁移末尾做**（不能让用户自己跑命令）。
pub fn fts_rebuild_all(engine: &Engine, p: &Value) -> DbResult<Value> {
    let limit = p.get("limit").and_then(|x| x.as_i64()).unwrap_or(10_000);
    let sessions: Vec<String> = engine.with_conn(|conn| {
        let mut stmt = conn
            .prepare("SELECT DISTINCT session_id FROM messages LIMIT ?1")
            .map_err(DbError::from)?;
        let rows = stmt
            .query_map(params![limit], |r| r.get::<_, String>(0))
            .map_err(DbError::from)?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(DbError::from)?);
        }
        Ok(out)
    })?;

    let mut total_added = 0i64;
    let mut total_refreshed = 0i64;
    let mut total_removed = 0i64;
    let mut sessions_done = 0i64;
    let mut failures: Vec<String> = Vec::new();
    for sid in &sessions {
        match fts_rebuild(engine, &json!({ "session_id": sid })) {
            Ok(v) => {
                sessions_done += 1;
                total_added += v.get("added").and_then(|x| x.as_i64()).unwrap_or(0);
                total_refreshed += v.get("refreshed").and_then(|x| x.as_i64()).unwrap_or(0);
                total_removed += v.get("removed").and_then(|x| x.as_i64()).unwrap_or(0);
            }
            // 单个会话失败不该让整次重建失败（其余会话仍然受益），但要如实记录
            Err(e) => failures.push(format!("{sid}: {e}")),
        }
    }
    Ok(json!({
        "sessions": sessions_done,
        "added": total_added,
        "refreshed": total_refreshed,
        "removed": total_removed,
        "failures": failures,
    }))
}
