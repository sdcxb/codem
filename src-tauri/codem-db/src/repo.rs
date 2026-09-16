//! 仓储命令（P1 第一切片：配置面 + 只追加面 + 消息/会话核心）
//!
//! 渲染侧**只**能通过这些语义化命令访问数据（`src/core/storage/port.ts` 的 `StorageDataPort`）。
//! 命令清单与 `tools/audit/storage-inventory.mjs` 的归类一一对应，后续按 P3 顺序补齐到 82 个。
//!
//! 约定：
//! - 参数是结构化 JSON（不接受 SQL 片段）；
//! - 列表读一律分页（`limit` 被 `MAX_ROWS_PER_QUERY` 夹住），返回 `{ items, has_more, next_cursor }`；
//! - 写一律走 `Engine::write_tx`（单事务、全成或全败）。

use rusqlite::types::Value as SqlValue;
use rusqlite::{params, params_from_iter, OptionalExtension, Row};
use serde::Serialize;
use serde_json::{json, Value};

use crate::engine::{Engine, MAX_ROWS_PER_QUERY};
use crate::error::{DbError, DbResult, ErrorCode};
use crate::schema::now_ms;

// ========== 小工具 ==========
//
// 参数取值一律**严格**：类型不对就报错，不做静默强转。
// （迁移前渲染侧大量使用 `String(x ?? "")`，那种静默兜底正是 A 类"静默空写"的温床；
//   存储边界上宁可返回 UNSUPPORTED/OTHER 让调用方看见，也不要写进一行看起来成功的垃圾数据。）

/// 取可选字符串：非字符串一律报错（`null` 视为"未提供"）
pub fn opt_text(v: &Value, key: &str) -> DbResult<Option<String>> {
    match v.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Ok(Some(s.clone())),
        Some(other) => Err(DbError::invalid(key, format!("期望字符串，收到 {other}"))),
    }
}

/// 取必填字符串
pub fn req_text(v: &Value, key: &str) -> DbResult<String> {
    opt_text(v, key)?.ok_or_else(|| DbError::missing(key))
}

pub fn opt_i64(v: &Value, key: &str) -> DbResult<Option<i64>> {
    match v.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(n)) => Ok(Some(
            n.as_i64()
                .ok_or_else(|| DbError::invalid(key, format!("期望整数，收到 {n}")))?,
        )),
        Some(other) => Err(DbError::invalid(key, format!("期望整数，收到 {other}"))),
    }
}

fn req_i64(v: &Value, key: &str) -> DbResult<i64> {
    opt_i64(v, key)?.ok_or_else(|| DbError::missing(key))
}

fn limit_of(v: &Value) -> DbResult<usize> {
    let raw = opt_i64(v, "limit")?.unwrap_or(100);
    if raw < 1 {
        return Err(DbError::invalid("limit", "必须 ≥ 1"));
    }
    // 超上限不是错误：夹住即可（渲染侧分页可能按"要 10000 条"来试，实际给 5000 条 + has_more）
    Ok(raw.min(MAX_ROWS_PER_QUERY as i64) as usize)
}

fn offset_of(v: &Value) -> DbResult<usize> {
    let raw = opt_i64(v, "offset")?.unwrap_or(0);
    if raw < 0 {
        return Err(DbError::invalid("offset", "必须 ≥ 0"));
    }
    Ok(raw as usize)
}

/// JSON → SQLite 绑定值（**拥有所有权**，不用 `Box::leak`，也不依赖借用生命周期）
pub fn to_sql_value(v: &Value) -> SqlValue {
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
        // 对象/数组按 JSON 文本存（与渲染侧 `JSON.stringify` 落库的既有约定一致）
        other => SqlValue::Text(other.to_string()),
    }
}

#[derive(Serialize)]
struct PageOut {
    items: Vec<Value>,
    has_more: bool,
    next_cursor: Option<String>,
}

/// 分页收尾：查询时多取一行用来判断 `has_more`，这里丢掉多的那行。
fn paged(mut items: Vec<Value>, limit: usize, offset: usize) -> PageOut {
    let has_more = items.len() > limit;
    if has_more {
        items.truncate(limit);
    }
    PageOut {
        items,
        has_more,
        next_cursor: if has_more {
            Some((offset + limit).to_string())
        } else {
            None
        },
    }
}

// ========== 配置面 ==========

pub fn settings_get_all(engine: &Engine) -> DbResult<Value> {
    engine.with_conn(|conn| {
        let mut stmt = conn
            .prepare("SELECT key, value FROM settings")
            .map_err(DbError::from)?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?)))
            .map_err(DbError::from)?;
        let mut map = serde_json::Map::new();
        for row in rows {
            let (k, v) = row.map_err(DbError::from)?;
            map.insert(k, json!(v));
        }
        Ok(Value::Object(map))
    })
}

pub fn settings_set(engine: &Engine, p: &Value) -> DbResult<Value> {
    let key = req_text(p, "key")?;
    // `value` 列是 NOT NULL：`null` 的语义是"保留原值、只刷新 updated_at"（与渲染侧 `INSERT OR REPLACE` 一致）
    let text = match p.get("value") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => Some(s.clone()),
        Some(other) => Some(other.to_string()),
    };
    let now = now_ms();
    engine.write_tx(|tx| {
        let n = match text {
            Some(v) => tx.execute(
                "INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3) \
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
                params![key, v, now],
            ),
            None => tx.execute(
                "INSERT INTO settings (key, value, updated_at) VALUES (?1, '', ?2) \
                 ON CONFLICT(key) DO UPDATE SET updated_at = excluded.updated_at",
                params![key, now],
            ),
        }
        .map_err(DbError::from)?;
        Ok(json!({ "written": n, "key": key }))
    })
}

pub fn settings_remove(engine: &Engine, p: &Value) -> DbResult<Value> {
    let key = req_text(p, "key")?;
    engine.write_tx(|tx| {
        let n = tx
            .execute("DELETE FROM settings WHERE key = ?1", params![key])
            .map_err(DbError::from)?;
        if n == 0 {
            return Err(DbError::new(
                ErrorCode::NotFound,
                format!("settings.remove 未命中任何行：key={key}"),
            ));
        }
        Ok(json!({ "written": n, "key": key }))
    })
}

// ========== 只追加面 ==========
//
// ## seq 由谁分配（第 92 波的重要发现）
//
// `session_events.seq` 是 SQLite 的 `INTEGER PRIMARY KEY AUTOINCREMENT` —— 一个**全局**单调计数，
// 不是每会话从 1 开始（实测生产库：两个会话的事件 seq 交替递增，最大 2197）。因此：
// - 渲染侧**不能**本地预分配 seq（不知道全局水位，会撞主键）；
// - 必须由这边在事务里让表自己分配，并把**真实 seq 返回**给调用方。
//
// 返回真实 seq 的额外好处：渲染侧的内存镜像（事件回放用）能精确对齐数据库，
// 于是"本地刚追加的事件"和"从库读回的事件"顺序完全一致。

pub fn events_append(engine: &Engine, p: &Value) -> DbResult<Value> {
    let session_id = req_text(p, "session_id")?;
    let event_type = req_text(p, "event_type")?;
    let payload = p.get("payload").cloned().unwrap_or_else(|| json!({}));
    let payload_str = payload.to_string();
    let ts = opt_i64(p, "timestamp")?.unwrap_or_else(now_ms);
    engine.write_tx(|tx| {
        tx.execute(
            "INSERT INTO session_events (session_id, event_type, payload, timestamp) VALUES (?1, ?2, ?3, ?4)",
            params![session_id, event_type, payload_str, ts],
        )
        .map_err(DbError::from)?;
        let seq = tx.last_insert_rowid();
        Ok(json!({ "written": 1, "seq": seq }))
    })
}

/// 批量追加事件（单事务，seq 连续分配）。
///
/// 与逐条 `events.append` 的区别不只是性能：批量在一个事务里分配 seq，
/// 因此这批事件的 seq 一定**连续** —— 渲染侧的回放逻辑靠连续性判断"有没有缺口"。
pub fn events_append_batch(engine: &Engine, p: &Value) -> DbResult<Value> {
    let session_id = req_text(p, "session_id")?;
    let events = p
        .get("events")
        .and_then(|x| x.as_array())
        .ok_or_else(|| DbError::missing("events（数组）"))?;
    if events.is_empty() {
        return Err(DbError::invalid("events", "不能为空数组"));
    }
    // 事务外先解析校验（参数错误不该留下半个事务）
    let mut parsed: Vec<(String, String, i64)> = Vec::with_capacity(events.len());
    for (i, e) in events.iter().enumerate() {
        let ty = req_text(e, "type")?;
        let payload = e.get("payload").cloned().unwrap_or_else(|| json!({}));
        let ts = opt_i64(e, "timestamp")?.unwrap_or_else(|| now_ms() + i as i64);
        parsed.push((ty, payload.to_string(), ts));
    }
    engine.write_tx(|tx| {
        let mut stmt = tx
            .prepare_cached(
                "INSERT INTO session_events (session_id, event_type, payload, timestamp) VALUES (?1, ?2, ?3, ?4)",
            )
            .map_err(DbError::from)?;
        let mut seqs: Vec<i64> = Vec::with_capacity(parsed.len());
        for (ty, payload, ts) in &parsed {
            stmt.execute(params![session_id, ty, payload, ts])
                .map_err(DbError::from)?;
            seqs.push(tx.last_insert_rowid());
        }
        Ok(json!({ "written": seqs.len(), "seqs": seqs }))
    })
}

/// 读事件（分页；`from_seq` 用于"从某个水位之后读"，回放与增量同步都靠它）
pub fn events_list(engine: &Engine, p: &Value) -> DbResult<Value> {
    let session_id = req_text(p, "session_id")?;
    let limit = limit_of(p)?;
    let from_seq = opt_i64(p, "from_seq")?;
    let to_seq = opt_i64(p, "to_seq")?;
    let order_desc = p.get("order").and_then(|x| x.as_str()) == Some("desc");
    engine.with_conn(|conn| {
        let mut sql = String::from(
            "SELECT seq, session_id, event_type, payload, timestamp FROM session_events WHERE session_id = ?1",
        );
        let mut idx = 2;
        if from_seq.is_some() {
            sql.push_str(&format!(" AND seq >= ?{idx}"));
            idx += 1;
        }
        if to_seq.is_some() {
            sql.push_str(&format!(" AND seq <= ?{idx}"));
            idx += 1;
        }
        sql.push_str(if order_desc {
            " ORDER BY seq DESC"
        } else {
            " ORDER BY seq ASC"
        });
        sql.push_str(&format!(" LIMIT ?{idx}"));

        // 绑定：按占位符顺序拼参数
        let mut vals: Vec<rusqlite::types::Value> = vec![rusqlite::types::Value::Text(session_id.clone())];
        if let Some(f) = from_seq {
            vals.push(rusqlite::types::Value::Integer(f));
        }
        if let Some(t) = to_seq {
            vals.push(rusqlite::types::Value::Integer(t));
        }
        // 多取一行判断 has_more
        vals.push(rusqlite::types::Value::Integer((limit + 1) as i64));

        let mut stmt = conn.prepare_cached(&sql).map_err(DbError::from)?;
        let rows = stmt
            .query_map(rusqlite::params_from_iter(vals.iter()), |r| {
                Ok(json!({
                    "seq": r.get::<_, i64>(0)?,
                    "session_id": r.get::<_, String>(1)?,
                    "type": r.get::<_, String>(2)?,
                    "payload": r.get::<_, String>(3)?,
                    "timestamp": r.get::<_, i64>(4)?,
                }))
            })
            .map_err(DbError::from)?;
        let mut items = Vec::new();
        for r in rows {
            items.push(r.map_err(DbError::from)?);
        }
        let has_more = items.len() > limit;
        if has_more {
            items.truncate(limit);
        }
        Ok(json!({ "items": items, "has_more": has_more, "next_cursor": Value::Null }))
    })
}

/// 事件计数（诊断与"权威副本是否齐全"的判断）
pub fn events_count(engine: &Engine, p: &Value) -> DbResult<Value> {
    let session_id = req_text(p, "session_id")?;
    engine.with_conn(|conn| {
        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM session_events WHERE session_id = ?1",
                params![session_id],
                |r| r.get(0),
            )
            .map_err(DbError::from)?;
        Ok(json!({ "count": n }))
    })
}

/// 全局 seq 水位（渲染侧的内存镜像启动时用它对齐；注意它是**全局**水位，不是每会话）
pub fn events_watermark(engine: &Engine, p: &Value) -> DbResult<Value> {
    let session_id = opt_text(p, "session_id")?;
    engine.with_conn(|conn| {
        let (max_seq, count): (Option<i64>, i64) = match &session_id {
            Some(s) => conn
                .query_row(
                    "SELECT MAX(seq), COUNT(*) FROM session_events WHERE session_id = ?1",
                    params![s],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .map_err(DbError::from)?,
            None => conn
                .query_row("SELECT MAX(seq), COUNT(*) FROM session_events", [], |r| {
                    Ok((r.get(0)?, r.get(1)?))
                })
                .map_err(DbError::from)?,
        };
        Ok(json!({
            "max_seq": max_seq.unwrap_or(0),
            "count": count,
            "scope": session_id.unwrap_or_else(|| "<all>".to_string()),
        }))
    })
}

/// 删除会话的全部事件（级联清理时用）
pub fn events_delete_session(engine: &Engine, p: &Value) -> DbResult<Value> {
    let session_id = req_text(p, "session_id")?;
    engine.write_tx(|tx| {
        let n = tx
            .execute("DELETE FROM session_events WHERE session_id = ?1", params![session_id])
            .map_err(DbError::from)?;
        Ok(json!({ "written": n }))
    })
}

/// 压缩：把一段事件替换为一条快照，**占用锚点事件自己的 seq**。
///
/// 为什么必须保留锚点 seq（而不是用新的最大 seq）：回放逻辑靠 seq 单调来保证
/// "快照排在被它覆盖的事件之后"。用新 seq 会让快照跑到未来，删掉旧事件后投影就缺段了
/// —— 渲染侧早先正是踩了这个坑（所以裁剪默认关掉过）。
pub fn events_compact(
    engine: &Engine,
    p: &Value,
) -> DbResult<Value> {
    let session_id = req_text(p, "session_id")?;
    let snapshot_seq = req_i64(p, "snapshot_seq")?;
    let payload = p.get("payload").cloned().unwrap_or_else(|| json!({}));
    let cutoff_seq = req_i64(p, "cutoff_seq")?;
    let ts = opt_i64(p, "timestamp")?.unwrap_or_else(now_ms);
    engine.write_tx(|tx| {
        // 锚点必须真实存在，否则"压缩"会凭空造出一条孤立快照
        let exists: i64 = tx
            .query_row(
                "SELECT COUNT(*) FROM session_events WHERE session_id = ?1 AND seq = ?2",
                params![session_id, snapshot_seq],
                |r| r.get(0),
            )
            .map_err(DbError::from)?;
        if exists == 0 {
            return Err(DbError::not_found(format!(
                "锚点事件不存在：session={session_id} seq={snapshot_seq}"
            )));
        }
        tx.execute(
            "INSERT OR REPLACE INTO session_events (seq, session_id, event_type, payload, timestamp) \
             VALUES (?1, ?2, 'session_snapshot', ?3, ?4)",
            params![snapshot_seq, session_id, payload.to_string(), ts],
        )
        .map_err(DbError::from)?;
        // 删掉锚点之前的非 meta 事件（meta 必须保留：它承载会话身份）
        let removed = tx
            .execute(
                "DELETE FROM session_events WHERE session_id = ?1 AND seq < ?2 AND event_type <> 'session_meta'",
                params![session_id, cutoff_seq],
            )
            .map_err(DbError::from)?;
        Ok(json!({ "removed_events": removed, "snapshot_seq": snapshot_seq }))
    })
}

/// 会话内事件整体复制（fork）
pub fn events_fork(engine: &Engine, p: &Value) -> DbResult<Value> {
    let source = req_text(p, "source_session_id")?;
    let target = req_text(p, "target_session_id")?;
    let ts = opt_i64(p, "timestamp")?.unwrap_or_else(now_ms);
    engine.write_tx(|tx| {
        let n = tx
            .execute(
                "INSERT INTO session_events (session_id, event_type, payload, timestamp) \
                 SELECT ?1, event_type, payload, ?2 FROM session_events WHERE session_id = ?3 ORDER BY seq ASC",
                params![target, ts, source],
            )
            .map_err(DbError::from)?;
        Ok(json!({ "written": n }))
    })
}

pub fn telemetry_append(engine: &Engine, p: &Value) -> DbResult<Value> {
    let items = p
        .get("items")
        .and_then(|x| x.as_array())
        .ok_or_else(|| DbError::missing("items（数组）"))?;
    engine.write_tx(|tx| {
        let mut n = 0usize;
        for it in items {
            let id = req_text(it, "id")?;
            let session_id = opt_text(it, "session_id")?.unwrap_or_default();
            let name = req_text(it, "name")?;
            let data = it.get("data").cloned().unwrap_or_else(|| json!({})).to_string();
            let ts = opt_i64(it, "timestamp")?.unwrap_or_else(now_ms);
            tx.execute(
                "INSERT OR REPLACE INTO telemetry_events (id, session_id, event_name, event_data, timestamp) \
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![id, session_id, name, data, ts],
            )
            .map_err(DbError::from)?;
            n += 1;
        }
        Ok(json!({ "written": n }))
    })
}

pub fn telemetry_prune(engine: &Engine, p: &Value) -> DbResult<Value> {
    // 删除**必须**有明确水位线：没有 `before` 就报错，避免"以为传了条件其实全表清空"
    let before = req_i64(p, "before")?;
    engine.write_tx(|tx| {
        let n = tx
            .execute("DELETE FROM telemetry_events WHERE timestamp < ?1", params![before])
            .map_err(DbError::from)?;
        Ok(json!({ "written": n, "before": before }))
    })
}

// ========== 消息（数据面第一切片） ==========

fn message_row(r: &Row<'_>) -> rusqlite::Result<Value> {
    Ok(json!({
        "id": r.get::<_, String>(0)?,
        "session_id": r.get::<_, String>(1)?,
        "role": r.get::<_, String>(2)?,
        "content": r.get::<_, String>(3)?,
        "reasoning": r.get::<_, Option<String>>(4)?,
        "timestamp": r.get::<_, i64>(5)?,
        "model": r.get::<_, Option<String>>(6)?,
        "status": r.get::<_, Option<String>>(7)?,
    }))
}

/// 单条消息的列 → 值映射（**一处定义**：`create`/`create_many` 共用，避免两条写入路径漂移）
fn message_fields(p: &Value) -> DbResult<MessageFields> {
    let id = req_text(p, "id")?;
    let session_id = req_text(p, "session_id")?;
    let role = req_text(p, "role")?;
    // `content` 可空列但 NOT NULL：缺省给空串（与既有渲染侧行为一致），类型不对则报错
    let content = opt_text(p, "content")?.unwrap_or_default();
    Ok(MessageFields {
        id,
        session_id,
        role,
        content,
        reasoning: opt_text(p, "reasoning")?,
        model: opt_text(p, "model")?,
        status: opt_text(p, "status")?.unwrap_or_else(|| "done".to_string()),
        timestamp: opt_i64(p, "timestamp")?.unwrap_or_else(now_ms),
    })
}

struct MessageFields {
    id: String,
    session_id: String,
    role: String,
    content: String,
    reasoning: Option<String>,
    model: Option<String>,
    status: String,
    timestamp: i64,
}

const MESSAGE_UPSERT: &str = "INSERT INTO messages \
     (id, session_id, role, content, reasoning, timestamp, model, status) \
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) \
     ON CONFLICT(id) DO UPDATE SET content = excluded.content, reasoning = excluded.reasoning, \
       model = excluded.model, status = excluded.status, timestamp = excluded.timestamp";

pub fn messages_create(engine: &Engine, p: &Value) -> DbResult<Value> {
    let f = message_fields(p)?;
    engine.write_tx(|tx| {
        let n = tx
            .execute(
                MESSAGE_UPSERT,
                params![f.id, f.session_id, f.role, f.content, f.reasoning, f.timestamp, f.model, f.status],
            )
            .map_err(DbError::from)?;
        Ok(json!({ "written": n, "id": f.id }))
    })
}

/// 批量 upsert（**大文档与批量导入的主路径**）：单事务、单事务提交 = 一次 WAL 顺序写。
/// 逐条 `messages.create` 会让 N 条消息产生 N 次事务与 N 次 IPC 往返，这是 10 万条级别不可接受的。
pub fn messages_create_many(engine: &Engine, p: &Value) -> DbResult<Value> {
    let items = p
        .get("items")
        .and_then(|x| x.as_array())
        .ok_or_else(|| DbError::missing("items（数组）"))?;
    // 先在事务外把参数全部解析校验完：参数错误不应产生半个事务
    let parsed: Vec<MessageFields> = items.iter().map(message_fields).collect::<DbResult<Vec<_>>>()?;
    engine.write_tx(|tx| {
        let mut stmt = tx.prepare_cached(MESSAGE_UPSERT).map_err(DbError::from)?;
        let mut n = 0usize;
        for f in &parsed {
            stmt.execute(params![
                f.id,
                f.session_id,
                f.role,
                f.content,
                f.reasoning,
                f.timestamp,
                f.model,
                f.status
            ])
            .map_err(DbError::from)?;
            n += 1;
        }
        Ok(json!({ "written": n, "count": parsed.len() }))
    })
}

pub fn messages_update(engine: &Engine, p: &Value) -> DbResult<Value> {
    let id = req_text(p, "id")?;
    // 列白名单：只有这些列可以通过 `messages.update` 改（其它列必须走各自的语义化命令）
    const UPDATABLE: &[&str] = &[
        "content",
        "reasoning",
        "model",
        "status",
        "hidden",
        "metadata",
        "generated_files",
        "retrieved_sources",
        "parent_message_id",
    ];
    let mut sets: Vec<String> = Vec::new();
    let mut vals: Vec<SqlValue> = Vec::new();
    for col in UPDATABLE {
        if let Some(v) = p.get(*col) {
            sets.push(format!("{col} = ?{}", vals.len() + 1));
            vals.push(to_sql_value(v));
        }
    }
    if sets.is_empty() {
        return Err(DbError::invalid(
            "fields",
            "没有任何可更新字段（content/reasoning/model/status/hidden/metadata/…）",
        ));
    }
    vals.push(SqlValue::Text(id.clone()));
    let sql = format!(
        "UPDATE messages SET {} WHERE id = ?{}",
        sets.join(", "),
        vals.len()
    );
    engine.write_tx(|tx| {
        let n = tx
            .execute(&sql, params_from_iter(vals.iter()))
            .map_err(DbError::from)?;
        // A 类防线：`UPDATE` 影响 0 行意味着目标不存在，调用方必须知道（而不是收到"成功"）
        if n == 0 {
            return Err(DbError::new(
                ErrorCode::NotFound,
                format!("messages.update 未命中任何行：id={id}"),
            ));
        }
        Ok(json!({ "written": n, "id": id }))
    })
}

/// 批量按 id 更新（`create_many` 的对称操作：上下文压缩/批量改写走这里）
pub fn messages_update_many(engine: &Engine, p: &Value) -> DbResult<Value> {
    let items = p
        .get("items")
        .and_then(|x| x.as_array())
        .ok_or_else(|| DbError::missing("items（数组）"))?;
    let mut prepared: Vec<(String, String)> = Vec::new(); // (id, sql)
    let mut all_vals: Vec<Vec<SqlValue>> = Vec::new();
    for it in items {
        let id = req_text(it, "id")?;
        let mut sets: Vec<String> = Vec::new();
        let mut vals: Vec<SqlValue> = Vec::new();
        for col in ["content", "reasoning", "model", "status", "hidden", "metadata"] {
            if let Some(v) = it.get(col) {
                sets.push(format!("{col} = ?{}", vals.len() + 1));
                vals.push(to_sql_value(v));
            }
        }
        if sets.is_empty() {
            return Err(DbError::invalid("items[].fields", format!("{id} 没有任何可更新字段")));
        }
        vals.push(SqlValue::Text(id.clone()));
        let sql = format!("UPDATE messages SET {} WHERE id = ?{}", sets.join(", "), vals.len());
        prepared.push((id, sql));
        all_vals.push(vals);
    }
    engine.write_tx(|tx| {
        let mut n = 0usize;
        for (i, (id, sql)) in prepared.iter().enumerate() {
            let hit = tx
                .execute(sql, params_from_iter(all_vals[i].iter()))
                .map_err(DbError::from)?;
            if hit == 0 {
                return Err(DbError::new(
                    ErrorCode::NotFound,
                    format!("messages.update_many 未命中任何行：id={id}"),
                ));
            }
            n += hit;
        }
        Ok(json!({ "written": n, "count": prepared.len() }))
    })
}

pub fn messages_get(engine: &Engine, p: &Value) -> DbResult<Value> {
    let id = req_text(p, "id")?;
    engine.with_conn(|conn| {
        let mut stmt = conn
            .prepare_cached(
                "SELECT id, session_id, role, content, reasoning, timestamp, model, status \
                 FROM messages WHERE id = ?1",
            )
            .map_err(DbError::from)?;
        let out = stmt
            .query_row(params![id], message_row)
            .optional()
            .map_err(DbError::from)?;
        Ok(json!({ "item": out }))
    })
}

/// 会话内消息分页读（**默认包含 hidden**：索引层不该替调用方隐藏数据，
/// 是否隐藏由 `include_hidden=false` 显式表达 —— 渲染侧的上下文裁剪是业务决策）
pub fn messages_list(engine: &Engine, p: &Value) -> DbResult<Value> {
    let session_id = req_text(p, "session_id")?;
    let limit = limit_of(p)?;
    let offset = offset_of(p)?;
    let include_hidden = p
        .get("include_hidden")
        .and_then(|x| x.as_bool())
        .ok_or_else(|| DbError::missing("include_hidden（布尔，显式声明是否需要 hidden 消息）"))?;
    engine.with_conn(|conn| {
        let hidden_clause = if include_hidden { "" } else { " AND hidden = 0" };
        let sql = format!(
            "SELECT id, session_id, role, content, reasoning, timestamp, model, status \
             FROM messages WHERE session_id = ?1{hidden_clause} ORDER BY timestamp ASC, id ASC LIMIT ?2 OFFSET ?3"
        );
        let mut stmt = conn.prepare_cached(&sql).map_err(DbError::from)?;
        // 多取一行判断 has_more（避免额外 COUNT(*) 全表扫描）
        let rows = stmt
            .query_map(params![session_id, (limit + 1) as i64, offset as i64], message_row)
            .map_err(DbError::from)?;
        let mut items = Vec::new();
        for r in rows {
            items.push(r.map_err(DbError::from)?);
        }
        serde_json::to_value(paged(items, limit, offset)).map_err(|e| DbError::other(e.to_string()))
    })
}

pub fn messages_delete(engine: &Engine, p: &Value) -> DbResult<Value> {
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
        return Err(DbError::invalid("ids", "不能为空数组（删除是危险操作，必须显式给出目标）"));
    }
    engine.write_tx(|tx| {
        let mut stmt = tx
            .prepare_cached("DELETE FROM messages WHERE id = ?1")
            .map_err(DbError::from)?;
        let mut n = 0usize;
        for id in &parsed {
            n += stmt.execute(params![id]).map_err(DbError::from)?;
        }
        Ok(json!({ "written": n, "requested": parsed.len() }))
    })
}

pub fn messages_count(engine: &Engine, p: &Value) -> DbResult<Value> {
    let session_id = req_text(p, "session_id")?;
    engine.with_conn(|conn| {
        let total: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM messages WHERE session_id = ?1",
                params![session_id],
                |r| r.get(0),
            )
            .map_err(DbError::from)?;
        let visible: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM messages WHERE session_id = ?1 AND hidden = 0",
                params![session_id],
                |r| r.get(0),
            )
            .map_err(DbError::from)?;
        Ok(json!({ "count": total, "total": total, "visible": visible, "hidden": total - visible }))
    })
}

// ========== 会话 / 项目（切换顺序里紧邻的一层） ==========

pub fn sessions_upsert(engine: &Engine, p: &Value) -> DbResult<Value> {
    let id = req_text(p, "id")?;
    // `project_id` 缺省 = `""`（全局项目行由 schema 阶段种下，满足外键）
    let project_id = opt_text(p, "project_id")?.unwrap_or_default();
    let title = opt_text(p, "title")?.unwrap_or_else(|| format!("会话 {id}"));
    let created_at = opt_i64(p, "created_at")?.unwrap_or_else(now_ms);
    let last_message_at = opt_i64(p, "last_message_at")?.unwrap_or(created_at);
    let message_count = opt_i64(p, "message_count")?.unwrap_or(0);
    let pinned = opt_i64(p, "pinned")?.unwrap_or(0);
    engine.write_tx(|tx| {
        let n = tx
            .execute(
                "INSERT INTO sessions (id, project_id, title, created_at, last_message_at, message_count, pinned) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) \
                 ON CONFLICT(id) DO UPDATE SET title = excluded.title, last_message_at = excluded.last_message_at, \
                   message_count = excluded.message_count, pinned = excluded.pinned",
                params![id, project_id, title, created_at, last_message_at, message_count, pinned],
            )
            .map_err(DbError::from)?;
        Ok(json!({ "written": n, "id": id }))
    })
}

fn session_row(r: &Row<'_>) -> rusqlite::Result<Value> {
    Ok(json!({
        "id": r.get::<_, String>(0)?,
        "project_id": r.get::<_, String>(1)?,
        "title": r.get::<_, String>(2)?,
        "created_at": r.get::<_, i64>(3)?,
        "last_message_at": r.get::<_, i64>(4)?,
        "message_count": r.get::<_, i64>(5)?,
        "pinned": r.get::<_, i64>(6)?,
    }))
}

const SESSION_COLS: &str =
    "SELECT id, project_id, title, created_at, last_message_at, message_count, pinned FROM sessions";

pub fn sessions_list(engine: &Engine, p: &Value) -> DbResult<Value> {
    let project_id = opt_text(p, "project_id")?;
    let limit = limit_of(p)?;
    let offset = offset_of(p)?;
    engine.with_conn(|conn| {
        let mut items = Vec::new();
        if let Some(pid) = project_id {
            let sql = format!(
                "{SESSION_COLS} WHERE project_id = ?1 ORDER BY last_message_at DESC, id ASC LIMIT ?2 OFFSET ?3"
            );
            let mut stmt = conn.prepare_cached(&sql).map_err(DbError::from)?;
            let rows = stmt
                .query_map(params![pid, (limit + 1) as i64, offset as i64], session_row)
                .map_err(DbError::from)?;
            for r in rows {
                items.push(r.map_err(DbError::from)?);
            }
        } else {
            let sql = format!(
                "{SESSION_COLS} ORDER BY last_message_at DESC, id ASC LIMIT ?1 OFFSET ?2"
            );
            let mut stmt = conn.prepare_cached(&sql).map_err(DbError::from)?;
            let rows = stmt
                .query_map(params![(limit + 1) as i64, offset as i64], session_row)
                .map_err(DbError::from)?;
            for r in rows {
                items.push(r.map_err(DbError::from)?);
            }
        }
        serde_json::to_value(paged(items, limit, offset)).map_err(|e| DbError::other(e.to_string()))
    })
}

pub fn projects_upsert(engine: &Engine, p: &Value) -> DbResult<Value> {
    let id = req_text(p, "id")?;
    let name = opt_text(p, "name")?.unwrap_or_else(|| id.clone());
    let path = opt_text(p, "path")?.unwrap_or_default();
    let description = opt_text(p, "description")?;
    let now = now_ms();
    engine.write_tx(|tx| {
        let n = tx
            .execute(
                "INSERT INTO projects (id, name, path, description, pinned, created_at, last_accessed_at) \
                 VALUES (?1, ?2, ?3, ?4, 0, ?5, ?5) \
                 ON CONFLICT(id) DO UPDATE SET name = excluded.name, path = excluded.path, \
                   description = excluded.description, last_accessed_at = excluded.last_accessed_at",
                params![id, name, path, description, now],
            )
            .map_err(DbError::from)?;
        Ok(json!({ "written": n, "id": id }))
    })
}

pub fn projects_list(engine: &Engine, p: &Value) -> DbResult<Value> {
    let limit = limit_of(p)?;
    let offset = offset_of(p)?;
    engine.with_conn(|conn| {
        let mut stmt = conn
            .prepare_cached(
                "SELECT id, name, path, description, pinned, created_at, last_accessed_at \
                 FROM projects ORDER BY last_accessed_at DESC, id ASC LIMIT ?1 OFFSET ?2",
            )
            .map_err(DbError::from)?;
        let rows = stmt
            .query_map(params![(limit + 1) as i64, offset as i64], |r| {
                Ok(json!({
                    "id": r.get::<_, String>(0)?,
                    "name": r.get::<_, String>(1)?,
                    "path": r.get::<_, String>(2)?,
                    "description": r.get::<_, Option<String>>(3)?,
                    "pinned": r.get::<_, i64>(4)?,
                    "created_at": r.get::<_, i64>(5)?,
                    "last_accessed_at": r.get::<_, i64>(6)?,
                }))
            })
            .map_err(DbError::from)?;
        let mut items = Vec::new();
        for r in rows {
            items.push(r.map_err(DbError::from)?);
        }
        serde_json::to_value(paged(items, limit, offset)).map_err(|e| DbError::other(e.to_string()))
    })
}

/// 一次性统计（迁移对账 / 诊断）
pub fn counts(engine: &Engine, tables: &[String]) -> DbResult<Value> {
    let rows = engine.table_counts(tables)?;
    let mut map = serde_json::Map::new();
    for (t, n) in rows {
        map.insert(t, json!(n));
    }
    Ok(Value::Object(map))
}

/// 从 `params` 里取表名列表并统计（供 `lib::dispatch("counts")` 与 CLI 共用）
pub fn counts_of(engine: &Engine, p: &Value) -> DbResult<Value> {
    let tables: Vec<String> = match p.get("tables") {
        None | Some(Value::Null) => DEFAULT_COUNT_TABLES.iter().map(|s| s.to_string()).collect(),
        Some(Value::Array(a)) => a
            .iter()
            .map(|x| {
                x.as_str()
                    .map(|s| s.to_string())
                    .ok_or_else(|| DbError::invalid("tables", "元素必须是字符串"))
            })
            .collect::<DbResult<Vec<_>>>()?,
        Some(_) => return Err(DbError::invalid("tables", "期望字符串数组")),
    };
    counts(engine, &tables)
}

/// 默认统计的表（诊断/对账用；顺序固定便于 diff）
pub const DEFAULT_COUNT_TABLES: &[&str] = &[
    "projects",
    "sessions",
    "messages",
    "tool_calls",
    "attachments",
    "settings",
    "session_events",
    "telemetry_events",
    "notebooks",
    "notebook_sources",
];
