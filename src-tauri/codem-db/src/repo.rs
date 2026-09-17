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

use crate::engine::{Engine, MAX_BYTES_PER_QUERY, MAX_ROWS_PER_QUERY};
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

/// 必填的整数参数（缺了就是参数错误，不静默取默认值 —— 删除类命令靠它拿到水位线）
pub fn req_i64(v: &Value, key: &str) -> DbResult<i64> {
    opt_i64(v, key)?.ok_or_else(|| DbError::missing(key))
}

pub fn limit_of(v: &Value) -> DbResult<usize> {
    let raw = opt_i64(v, "limit")?.unwrap_or(100);
    if raw < 1 {
        return Err(DbError::invalid("limit", "必须 ≥ 1"));
    }
    // 超上限不是错误：夹住即可（渲染侧分页可能按"要 10000 条"来试，实际给 5000 条 + has_more）
    Ok(raw.min(MAX_ROWS_PER_QUERY as i64) as usize)
}

pub fn offset_of(v: &Value) -> DbResult<usize> {
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
///
/// ## 字节预算（第 44 轮：把 `MAX_BYTES_PER_QUERY` 真正实施起来）
///
/// `engine.rs` 里 `MAX_BYTES_PER_QUERY = 16 MiB` 从第 20 轮起就存在，
/// 但它**只被导出、只被 `capabilities()` 当卖点广告出去**，全 crate 没有任何执行点
/// —— 唯一真正生效的上限是行数（`MAX_ROWS_PER_QUERY`）。
/// 而行数上限挡不住大 payload：审计用真机实测**单行返回 204,963 B**，
/// 于是应用内 `messages.list limit=5000` 已经返回过 **7,801,077 B**，
/// 推算 5000 条 × 200 KB 的会话一次读可达 **约 1 GB** ——
/// 这个数字要穿过 IPC 序列化、穿过 WebView 桥、再在渲染进程里驻留。
/// 也就是说：**被公开承诺的上限是假的**，而在"库是索引、正文可以很大"的设计下，
/// 这个假承诺迟早会以"打开大会话就卡死/爆内存"的形态暴露。
///
/// 所以按**累计字节**截断，并把 `has_more = true` 交给调用方继续翻页
/// （与行数上限共用同一套分页语义，调用方不需要区分是被哪种上限截断的）。
/// 至少保留一行：否则"单行就超预算"会让每一页都为空 → 调用方永远翻不到它，成为死循环。
fn paged(mut items: Vec<Value>, limit: usize, offset: usize) -> PageOut {
    let mut has_more = items.len() > limit;
    if has_more {
        items.truncate(limit);
    }
    if cap_by_bytes(&mut items) {
        has_more = true;
    }
    let kept = items.len();
    PageOut {
        items,
        has_more,
        next_cursor: if has_more {
            // 注意：`next_cursor` 是**偏移量**语义，按行数推进。
            // 字节截断时"这一页少给了几行"，但偏移必须按**实际给出的行数**推进，
            // 否则会跳过数据（按 `offset + limit` 推进会漏掉被字节截断的那部分）。
            Some((offset + kept).to_string())
        } else {
            None
        },
    }
}

/// 按 `MAX_BYTES_PER_QUERY` 截断，返回"是否发生了截断"。
///
/// **唯一的字节预算实现**：`paged`（所有分页读）与 `fts.search` 都走它 ——
/// 两处各写一份的话，迟早会出现"某条读路径忘了实施"，
/// 而 `MAX_BYTES_PER_QUERY` 之所以值得单独抽出来讲，正是因为它**曾经只被广告、从未实施**。
///
/// 至少保留一行：否则"单行就超预算"会让每一页都为空 → 调用方永远翻不到它，成为死循环。
pub fn cap_by_bytes(items: &mut Vec<Value>) -> bool {
    let mut used = 0usize;
    let mut kept = 0usize;
    for it in items.iter() {
        // 序列化长度 ≈ 实际过线的字节量（key 与分隔符的差异在 16 MiB 量级下可忽略）
        let n = serde_json::to_string(it).map(|s| s.len()).unwrap_or(0);
        if kept > 0 && used + n > MAX_BYTES_PER_QUERY {
            items.truncate(kept);
            return true;
        }
        used += n;
        kept += 1;
    }
    false
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

/// 消息读路径的列清单（`messages.get` / `messages.list` 共用**一份**）。
///
/// 抽成常量是为了堵住"两条读路径漂移"：这个仓库已经因为"写路径加了列、读路径漏了"
/// 复发过三次（`hidden` / `generated_files` / `retrieved_sources`），而每次的形态都一样 ——
/// 单元测试用手写行对象，看不见真 SELECT 少了列。
/// 只要列清单只有一份，新增列就只需要改这里 + `message_row` 的索引。
const MESSAGE_SELECT: &str = "SELECT id, session_id, role, content, reasoning, timestamp, model, status, \
     hidden, generated_files, prompt_tokens, completion_tokens, cost, retrieved_sources, \
     parent_message_id, metadata, trimmed FROM messages";

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
        // ⚠️ `hidden` 必须返回：渲染侧的 `listMessagesMerged` 明确把"索引里的 hidden 状态"
        // 当作权威（软删除行只在索引里）。少返回这一列，读侧的镜像就会以为"没有隐藏行"，
        // 已压缩的消息会被**复活**（上下文永不缩小）。
        // 这个缺陷是**真机验证**抓到的：单元测试里我在假数据里带了 hidden 字段，
        // 而真实引擎的 SELECT 漏了这一列 —— 页面刷新后隐藏消息又出现了。
        //
        // ⚠️ 第 45 轮：**读成 `Option<i64>` 再 `unwrap_or(0)`**（与 `trimmed` 一致）。
        // 原来这里是 `r.get::<_, i64>(8)?`，而列定义是 `INTEGER DEFAULT 0`（**没有 NOT NULL**）
        // —— 于是一旦库里有一条 `hidden IS NULL` 的行（历史数据 / 手工 SQL / 迁移前的老库），
        // 这条读路径就整体失败：
        //   `messages.get` → Invalid column type Null at index: 8, name: hidden
        //   `messages.list { include_hidden: true }` → 同样报错，**整个会话读不出来**
        // 而 `crud.list` 会照样返回 `"hidden": null` —— 同一个库两条读路径给出两种答案。
        // 写侧的 `reject_null_semantic_columns` 挡的是**新**污染；这里挡的是**已有**的污染，
        // 两件事都要做（只做一边都会留下一个打不开的库）。
        // 语义上 `NULL` 与 `0` 等价：0 是"可见"，而 NULL 从来不是一种刻意表达的隐藏状态。
        "hidden": r.get::<_, Option<i64>>(8)?.unwrap_or(0),
        /*
         * `generated_files` 也必须返回（第 14 轮修正）。
         *
         * 与 `hidden` 同一类教训：列在库里、写路径也传了，但**读路径的 SELECT 漏了它** ——
         * 于是镜像行里没有这一列，`getMessage` / `listMessages` 在 rust 模式下永远拿不到
         * "生成了哪些文件"。用户可见形态：**重启后消息上的生成文件标记消失**，
         * fork / 复制时也一起丢。证据来自端口化测试（CHAT-025 / CHAIN-009）。
         */
        "generated_files": r.get::<_, Option<String>>(9)?,
        /*
         * 第 44 轮：把**库里已有、读路径却一直没返回**的列补齐。
         *
         * 这是同一个教训的第三次复发（前两次是 `hidden` 与 `generated_files`）：
         * 列在 schema 里、写路径也传了，但 SELECT 漏了它 —— 于是端口模式下
         * 这一列**永远读不出来**，而单元测试用的是手写行对象，看不见这个缺口。
         * 这次是审计用**真 CLI** 逐个命令读返回列时发现的：
         * `messages.get` 只回 10 列，而 messages 表有 16 列。
         *
         * 各列的后果：
         * - `retrieved_sources`：检索来源/引文。只写不读 → 引文只能靠会话日志镜像
         *   侥幸兜住，未 hydrate 时整批消失且无法重建（`prompt.ts` 会把它渲染成 `[1] name`）。
         * - `prompt_tokens` / `completion_tokens` / `cost`：token 与成本统计。
         * - `parent_message_id`：消息级谱系（编辑重发/fork 的追溯）。
         * - `metadata`：写入时保留的扩展面（回读不到就等于没存）。
         */
        "prompt_tokens": r.get::<_, Option<i64>>(10)?,
        "completion_tokens": r.get::<_, Option<i64>>(11)?,
        "cost": r.get::<_, Option<f64>>(12)?,
        "retrieved_sources": r.get::<_, Option<String>>(13)?,
        "parent_message_id": r.get::<_, Option<String>>(14)?,
        "metadata": r.get::<_, Option<String>>(15)?,
        /*
         * `trimmed`：**索引裁剪**专用的隐藏标记（第 44 轮新增的列）。
         *
         * ## 为什么需要它（`hidden` 一列被两条语义相反的路径共用）
         *
         * | 路径 | `hidden = 1` 的含义 | 读路径应当 |
         * | --- | --- | --- |
         * | 上下文压缩 | 这条消息**从上下文里移除** | 排除（否则"压缩 840 条、token 一点没降"死循环） |
         * | 索引裁剪（启动维护，为限制索引体积） | 行**留在库里**（满足 `message_feedback` 外键） | **保留**（"被裁的历史仍读得到"是裁剪的前提） |
         *
         * 两者在库里长得一模一样，而渲染侧的读路径必须给出**不同**的答案：
         * 靠"这次隐藏是谁做的"在进程内记账能骗过同一进程，**重启后就分不清了**
         * —— 于是要么历史消失（用户看不到自己的消息），要么压缩失效（token 不降）。
         * 加一列把它变成**库里的持久事实**，比在内存里记一笔靠谱。
         */
        "trimmed": r.get::<_, Option<i64>>(16)?.unwrap_or(0),
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
        // 缺省 0（可见）。索引重建会显式传日志里的真实值。
        hidden: opt_i64(p, "hidden")?.unwrap_or(0),
        parent_message_id: opt_text(p, "parent_message_id")?,
        metadata: match p.get("metadata") {
            None | Some(Value::Null) => None,
            Some(other) => Some(other.to_string()),
        },
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
    /// 可选：索引重建要还原压缩状态；普通写入不传时按 0（可见）落库。
    hidden: i64,
    /// 可选：消息链（fork）用；索引重建要还原
    parent_message_id: Option<String>,
    /// 可选：消息元数据（JSON 文本）；索引重建要还原
    metadata: Option<String>,
}

/// 语义上 NOT NULL 的列：**拒绝写入 SQL NULL**（第 45 轮）。
///
/// ## 为什么必须在写入边界就把 NULL 挡掉（真缺陷，审计实测）
///
/// `messages.update { "id": "m1", "hidden": null }` 原来"成功"了 —— 它把
/// **SQL NULL** 写进 `hidden`（列定义是 `INTEGER DEFAULT 0`，没有 NOT NULL 约束），
/// 于是：
/// - `messages.get` → `Invalid column type Null at index: 8, name: hidden`（读路径崩）；
/// - `messages.list { include_hidden: true }` → 同样报错 —— **整个会话都读不出来了**；
/// - 而 `crud.list` 照样返回 `"hidden": null` —— **两条读路径给出两种答案**。
///
/// 更糟的是它不可自愈：那条行会一直毒住读路径，除非再显式写回一个整数。
/// 所以这里做两件事（缺一不可）：
/// ① 写侧拒绝：语义上非 0 即 1 的列收到 `null` 直接 `invalid`，文案说清是哪一列；
/// ② 读侧防御：`message_row` 把 `hidden` 读成 `Option<i64>` 再 `unwrap_or(0)`，
///    这样**库里已经有 NULL**（历史数据 / 手工 SQL）也不会打崩读路径。
/// 只做①挡不住历史数据，只做②挡不住新的污染 —— 两条都要。
const SEMANTIC_NOT_NULL_COLUMNS: &[(&str, &str)] = &[
    ("hidden", "0=可见 / 1=隐藏（压缩或裁剪）"),
    ("trimmed", "0=普通隐藏 / 1=索引裁剪"),
    ("message_count", "会话消息数（引擎是唯一写入者）"),
    ("pinned", "0/1 置顶标记"),
    ("sort_order", "排序位（0 表示未指定）"),
];

/// 对一次写入涉及的列逐个检查"语义上非空"的列有没有被显式写成 `null`。
///
/// 只检查**调用方显式给出的**列（`p.get(col)` 命中且值为 `Value::Null`）：
/// 缺省（没给这一列）是正常形态，由各自的 `unwrap_or(0)` / `DEFAULT 0` 兜底。
pub fn reject_null_semantic_columns(p: &Value) -> DbResult<()> {
    for (col, why) in SEMANTIC_NOT_NULL_COLUMNS {
        if let Some(Value::Null) = p.get(*col) {
            return Err(DbError::invalid(
                *col,
                format!("列 {col} 语义上不可为空（{why}）：拒绝写入 NULL。要表示\"无\"请显式写 0"),
            ));
        }
    }
    Ok(())
}

/// **裁剪标记的不变量**（第 45 轮）：`hidden = 0 ⇒ trimmed = 0`。
///
/// ## 为什么这一条必须写进 SQL，而不能靠调用方自觉
///
/// `trimmed = 1` 的含义是"**这一行是被索引裁剪掉的**"（行还在库里，只是不进上下文）。
/// 它与 `hidden = 1` 是同一个事实的两半：裁剪必然隐藏。
/// 于是 `hidden = 0, trimmed = 1` 是**矛盾态** —— 行是可见的，却被标着"被裁过"。
///
/// 审计实测：光照下三条路径都能造出这个矛盾态（`messages.create` 覆盖写、
/// `messages.upsert_index` 的显式 `hidden: 0`、`messages.rebuild_index` 的日志重放），
/// 因为**每条路径都在改 `hidden`，而没有人负责清 `trimmed`**。
/// 与其在 N 个调用点各清一次（下次加第 N+1 条写路径就会再漏一次），
/// 不如把不变量放进唯一那份 upsert SQL：**只要 `hidden` 被写成 0，`trimmed` 一定归 0**。
const MESSAGE_UPSERT: &str = "INSERT INTO messages \
     (id, session_id, role, content, reasoning, timestamp, model, status, hidden) \
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9) \
     ON CONFLICT(id) DO UPDATE SET content = excluded.content, reasoning = excluded.reasoning, \
       model = excluded.model, status = excluded.status, timestamp = excluded.timestamp, \
       hidden = excluded.hidden, \
       trimmed = CASE WHEN excluded.hidden = 0 THEN 0 ELSE trimmed END";

/// 单行 `hidden` 写入时的配套 `trimmed` 维护（SQL 片段，供 `messages.upsert_index` /
/// `messages.update` 这类**自己拼 UPDATE** 的路径复用，保证与 `MESSAGE_UPSERT` 同一条不变量）。
///
/// 形态刻意与 `MESSAGE_UPSERT` 里那句 `CASE WHEN …` 完全一致：
/// 两处规则不同 = 两条写路径给出两种状态，正是这类缺陷的成因。
const HIDDEN_WRITE_SQL: &str = "hidden = ?{hidden}, trimmed = CASE WHEN ?{hidden} = 0 THEN 0 ELSE trimmed END";

/// 把 `HIDDEN_WRITE_SQL` 展开成带编号占位符的片段。
fn hidden_write_clause(idx: usize) -> String {
    HIDDEN_WRITE_SQL.replace("{hidden}", &idx.to_string())
}

/// 维护 `sessions.message_count`（第 44 轮）。
///
/// ## 为什么必须由引擎自己维护
///
/// 真机实测同一个会话有三个互相矛盾的数：**权威 JSONL 612 条 / 索引 544 行 /
/// `sessions.message_count` 写的是 27**。第三个数是"谁都不想维护它"的结果 ——
/// 渲染侧只在极少数地方显式 `updateSession({ messageCount })`，
/// 于是这个列一直停在上一次有人记得写它的时刻，而侧边栏就把它显示给用户。
/// **一个由多个写入者"有空才更新"的计数列，必然会漂移**；要么让它只有一个写入者，
/// 要么不要有这一列。这里选前者：**引擎是唯一的写入者**，因为只有引擎知道
/// 每一行消息的生死（`messages.create` / `create_many` / `upsert_index` / `delete` 全都经过它）。
///
/// ## 为什么是增量而不是每次 COUNT(*)
///
/// 流式响应里 `messages.upsert_index` 是**逐 token** 调的（见 `session/executor.ts`），
/// 每次都 `COUNT(*)` 一个 5000 条消息的会话是每次写都要扫 5000 行 —— 而计数要的是 O(1)。
/// 所以：调用方已经知道"这次是新增还是覆盖/删除了几行"，把增量传进来即可。
///
/// 负增量用 `MAX(0, …)` 夹住：删除路径的计数可能因为历史漂移而偏小，
/// **不能让它变成负数**（负的"消息数"比偏小更难解释）。
/// `COALESCE` 同理：老库这一列可能是 NULL。
///
/// ## ⚠️ 第 45 轮：夹断必须**被上报**，不能静默（Z-10）
///
/// 审计实测：把 `message_count` 人为写成 1（库里其实 5 条）→ 硬删 3 条 →
/// 计数走 `MAX(0, 1-3)` 变成 **0**，而库里还剩 2 条 —— 于是库里出现
/// "0 条消息的会话里躺着 2 条"，**没有任何告警**，用户与后续维护都看不到这件事。
/// 夹断本身是对的（负的计数更糟），错的是"夹了却不说"：
/// 夹断**恰好**意味着这个计数已经漂移过，那正是需要被看见的信息。
///
/// 所以返回值里带 `clamped`：调用方把它转发到结果里（见 `messages.delete` 的 `count_clamped`），
/// 维护对账（`maintenance.ts` 的 `reconcileMessageCounts`）也正是靠这个信号
/// 知道"这个会话的计数不可信，该按索引真值重算一次"。
fn bump_session_message_count(
    tx: &rusqlite::Transaction<'_>,
    session_id: &str,
    delta: i64,
) -> DbResult<bool> {
    if delta == 0 {
        return Ok(false);
    }
    // 先取现值：`MAX(0, x + d)` 到底夹断了没有，只有拿 x 比一次才知道
    let before: Option<i64> = tx
        .query_row(
            "SELECT message_count FROM sessions WHERE id = ?1",
            params![session_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(DbError::from)?
        .flatten();
    let clamped = matches!(before, Some(b) if b + delta < 0);
    tx.execute(
        "UPDATE sessions SET message_count = MAX(0, COALESCE(message_count, 0) + ?2) WHERE id = ?1",
        params![session_id, delta],
    )
    .map_err(DbError::from)?;
    Ok(clamped)
}

/// 这一行消息**是否已存在**（用于判断 upsert 是"新增"还是"覆盖"，从而决定计数加减）
fn message_exists(tx: &rusqlite::Transaction<'_>, id: &str) -> DbResult<bool> {
    let n: i64 = tx
        .query_row("SELECT COUNT(*) FROM messages WHERE id = ?1", params![id], |r| {
            r.get(0)
        })
        .map_err(DbError::from)?;
    Ok(n > 0)
}

pub fn messages_create(engine: &Engine, p: &Value) -> DbResult<Value> {
    reject_null_semantic_columns(p)?;
    let f = message_fields(p)?;
    engine.write_tx(|tx| {
        let is_new = !message_exists(tx, &f.id)?;
        let n = tx
            .execute(
                MESSAGE_UPSERT,
                params![f.id, f.session_id, f.role, f.content, f.reasoning, f.timestamp, f.model, f.status, f.hidden],
            )
            .map_err(DbError::from)?;
        bump_session_message_count(tx, &f.session_id, if is_new { 1 } else { 0 })?;
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
    // 同上：语义上不可为空的列不许被写成 NULL（`create_many` 与 `create` 共用 MESSAGE_UPSERT）
    for it in items {
        reject_null_semantic_columns(it)?;
    }
    engine.write_tx(|tx| {
        let mut exists_stmt = tx
            .prepare_cached("SELECT COUNT(*) FROM messages WHERE id = ?1")
            .map_err(DbError::from)?;
        let mut stmt = tx.prepare_cached(MESSAGE_UPSERT).map_err(DbError::from)?;
        let mut n = 0usize;
        // 每个会话的**新增**行数（覆盖写不该让计数变大）
        let mut new_per_session: std::collections::HashMap<String, i64> = std::collections::HashMap::new();
        for f in &parsed {
            let already: i64 = exists_stmt
                .query_row(params![f.id], |r| r.get(0))
                .map_err(DbError::from)?;
            stmt.execute(params![
                f.id,
                f.session_id,
                f.role,
                f.content,
                f.reasoning,
                f.timestamp,
                f.model,
                f.status,
                f.hidden
            ])
            .map_err(DbError::from)?;
            if already == 0 {
                *new_per_session.entry(f.session_id.clone()).or_insert(0) += 1;
            }
            n += 1;
        }
        drop(stmt);
        drop(exists_stmt);
        for (sid, delta) in &new_per_session {
            bump_session_message_count(tx, sid, *delta)?;
        }
        Ok(json!({ "written": n, "count": parsed.len() }))
    })
}

pub fn messages_update(engine: &Engine, p: &Value) -> DbResult<Value> {
    let id = req_text(p, "id")?;
    // 语义上非空的列不许被写成 SQL NULL（见 `reject_null_semantic_columns` 的说明：
    // `hidden: null` 曾经让 `messages.get` / `messages.list` 把**整个会话**读崩）
    reject_null_semantic_columns(p)?;
    // 列白名单：只有这些列可以通过 `messages.update` 改（其它列必须走各自的语义化命令）
    //
    // 第 44 轮补上 `prompt_tokens` / `completion_tokens` / `cost`：这三列在 schema 里
    // （`messages` 建表语句就有），读路径现在也会返回它们，但**没有任何一条命令能写**
    // （既不在 `MessageFields` 里、也不在这个白名单里）—— 也就是说它们恒为 0，
    // 是"看着有、其实没有"的第三种形态：**列在、永远填不上**。
    // 渲染侧目前把 token/成本记在 `cost_records` 与 settings 里，所以这三列仍可能是 0；
    // 但至少"想写就能写"，而不是留一个谁都改不了的列。
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
        "prompt_tokens",
        "completion_tokens",
        "cost",
        // 索引裁剪标记：可写是为了让"清掉陈旧的裁剪标记"成为可能
        // （例如这条消息后来又被写回成可见的，`trimmed` 不该再挂着）。
        "trimmed",
    ];
    let mut sets: Vec<String> = Vec::new();
    let mut vals: Vec<SqlValue> = Vec::new();
    for col in UPDATABLE {
        if let Some(v) = p.get(*col) {
            /*
             * `hidden` 这一列**不能**只写它自己（第 45 轮）。
             *
             * `hidden = 0` 意味着"这一行是可见的"，而 `trimmed = 1` 意味着"这一行被索引裁剪过"
             * —— 两者同时成立是矛盾态（审计实测：三条写路径都能造出来）。
             * 于是这里把 `trimmed` 的维护**绑在 `hidden` 的写入上**：
             * 写 0 就必然清标记，写 1 则不动它（裁剪/压缩各自的语义由调用方决定）。
             * 判据与 `MESSAGE_UPSERT` 里那句 `CASE WHEN excluded.hidden = 0` 完全一致
             * （两处规则必须一样，否则"同一件事走两条路给出两种状态"）。
             */
            if *col == "hidden" {
                vals.push(to_sql_value(v));
                sets.push(hidden_write_clause(vals.len()));
                continue;
            }
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

// ========== 消息索引的复合写（P3 第 6 段） ==========
//
// 渲染侧的 `writeMessageIndex` / `writeMessageUpdateIndex` 不是"一次简单 upsert"：
// 它要同时处理 messages 主行 + `generated_files` / `retrieved_sources` 两个 JSON 列
// + **整批替换 tool_calls**（先 DELETE 再 INSERT）。拆成多条命令的话，
// 中途失败会留下"消息更新了但工具调用只写了一半"这种不一致状态。
// 所以这里做成**单事务的复合命令**，与渲染侧原语义一一对应。

/// upsert 一条消息的索引行（含 JSON 列与 tool_calls 的整体替换）
///
/// 参数与 `messages.create` 兼容，另加：
/// - `generated_files` / `retrieved_sources`：数组或 null（内部按 JSON 文本存）
/// - `tool_calls`：数组（**给了就整体替换**：先删该消息的旧记录再插入）
/// - `prompt_tokens` / `completion_tokens` / `cost`：可选，缺省不动（更新时）或 0（新建时）
pub fn messages_upsert_index(engine: &Engine, p: &Value) -> DbResult<Value> {
    /*
     * 语义上非空的列拒绝 NULL（第 45 轮 Z-3）。
     *
     * ⚠️ 这一条对 `trimmed` 尤其重要：它**不在** `MessageFields` 里，
     * 所以下面 `hidden_arg` 那段 `match` 管不到它 —— 而 `messages.upsert_index`
     * 又是流式响应的热路径。审计实测 `messages.upsert_index { …, "hidden": 0 }`
     * 能把一行裁剪过的行（`hidden=1, trimmed=1`）改成矛盾态 `hidden=0, trimmed=1`。
     * `trimmed` 本身在这里没有"写 0/写 1"的语义（那是 `messages.delete { trim: true }`
     * 与 `messages.update` 的事），所以对它最正确的处理是：**一律不许在这里写 NULL**。
     */
    reject_null_semantic_columns(p)?;
    let f = message_fields(p)?;
    // JSON 列：数组 → JSON 文本；null/缺省 → NULL
    let generated_files = json_col(p, "generated_files")?;
    let retrieved_sources = json_col(p, "retrieved_sources")?;
    let prompt_tokens = opt_i64(p, "prompt_tokens")?;
    let completion_tokens = opt_i64(p, "completion_tokens")?;
    let cost = p.get("cost").and_then(|x| x.as_f64());
    // `hidden` 是**可选**参数，语义与其它可选列不同（不能用 COALESCE 一把梭）：
    //
    // - 普通写路径（渲染侧 writeIndexViaRust）**不传**它 —— 更新时必须保留库里已有的
    //   hidden，否则一次普通的内容更新就会把"已压缩隐藏"的消息复活（历史上修过的一类 bug）。
    // - 索引重建路径（session-log-bridge 的 rebuildSessionLogs）**要传**它 ——
    //   它的目标就是把日志里的 hidden 还原进索引。而 `hidden = 0` 是合法值，
    //   用 `COALESCE(?n, hidden)` 会把它误判成"没给"，所以这里显式区分"给了/没给"。
    let hidden_arg: Option<i64> = match p.get("hidden") {
        None | Some(Value::Null) => None,
        Some(Value::Number(n)) => n.as_i64(),
        Some(other) => {
            return Err(DbError::invalid("hidden", format!("期望整数，收到 {other}")))
        }
    };

    // tool_calls 在事务外先解析校验（参数错误不该留下半个事务）
    let tool_calls: Option<Vec<ToolCallRow>> = match p.get("tool_calls") {
        None | Some(Value::Null) => None,
        Some(Value::Array(arr)) => {
            let mut out = Vec::with_capacity(arr.len());
            for (i, tc) in arr.iter().enumerate() {
                let id = req_text(tc, "id")?;
                let tool = req_text(tc, "tool")?;
                let args = tc.get("args").cloned().unwrap_or_else(|| json!({})).to_string();
                let result = opt_text(tc, "result")?;
                let status = opt_text(tc, "status")?.unwrap_or_else(|| "running".to_string());
                let metadata = match tc.get("metadata") {
                    None | Some(Value::Null) => None,
                    Some(other) => Some(other.to_string()),
                };
                let _ = i;
                out.push(ToolCallRow { id, tool, args, result, status, metadata });
            }
            Some(out)
        }
        Some(other) => {
            return Err(DbError::invalid("tool_calls", format!("期望数组，收到 {other}")))
        }
    };

    engine.write_tx(|tx| {
        // 1) messages 主行：存在则更新（只更动给出的列），不存在则插入
        //    顺带把当前 hidden 取出来：没显式传 hidden 时要原样保留它。
        let (exists, current_hidden): (i64, i64) = tx
            .query_row(
                "SELECT COUNT(*), COALESCE(MAX(hidden), 0) FROM messages WHERE id = ?1",
                params![f.id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(DbError::from)?;
        let hidden_next = hidden_arg.unwrap_or(current_hidden);

        let written = if exists > 0 {
            /*
             * `hidden = ?6` 这一处**必须走 `hidden_write_clause`**（第 45 轮）。
             *
             * 这条路径是"日志重建"的主路径（`session-log-bridge` 的 `rebuildSessionLogs`），
             * 它显式带着日志里的 `hidden` —— 审计实测：一条被裁剪过的行
             * （`hidden=1, trimmed=1`）经这里重放后变成 `hidden=0, trimmed=1`，
             * 即"裁剪被静默撤销"，而 `trimmed = 1` 这个矛盾标记还挂着。
             * 现在的规则是 `hidden` 写 0 ⇒ `trimmed` 一起清 0；写 1 ⇒ 不动 `trimmed`
             * （裁剪路径自己在 `messages.delete { trim: true }` 里设它）。
             */
            tx.execute(
                &format!(
                    "UPDATE messages SET content = ?1, reasoning = ?2, model = ?3, status = ?4, \
                       timestamp = ?5, {}, \
                       generated_files = COALESCE(?7, generated_files), \
                       retrieved_sources = COALESCE(?8, retrieved_sources), \
                       prompt_tokens = COALESCE(?9, prompt_tokens), \
                       completion_tokens = COALESCE(?10, completion_tokens), \
                       cost = COALESCE(?11, cost) \
                     WHERE id = ?12",
                    hidden_write_clause(6)
                ),
                params![
                    f.content,
                    f.reasoning,
                    f.model,
                    f.status,
                    f.timestamp,
                    hidden_next,
                    generated_files,
                    retrieved_sources,
                    prompt_tokens,
                    completion_tokens,
                    cost,
                    f.id
                ],
            )
            .map_err(DbError::from)?
        } else {
            tx.execute(
                "INSERT INTO messages (id, session_id, role, content, reasoning, timestamp, model, status, \
                   generated_files, retrieved_sources, prompt_tokens, completion_tokens, cost, hidden) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
                params![
                    f.id,
                    f.session_id,
                    f.role,
                    f.content,
                    f.reasoning,
                    f.timestamp,
                    f.model,
                    f.status,
                    generated_files,
                    retrieved_sources,
                    prompt_tokens.unwrap_or(0),
                    completion_tokens.unwrap_or(0),
                    cost.unwrap_or(0.0),
                    hidden_next
                ],
            )
            .map_err(DbError::from)?
        };

        // 2) tool_calls：给了就**整体替换**（与渲染侧 `DELETE` + 逐条 `INSERT` 等价）
        if let Some(calls) = &tool_calls {
            tx.execute("DELETE FROM tool_calls WHERE message_id = ?1", params![f.id])
                .map_err(DbError::from)?;
            let mut stmt = tx
                .prepare_cached(
                    "INSERT INTO tool_calls (id, message_id, tool, args, result, status, metadata) \
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                )
                .map_err(DbError::from)?;
            for tc in calls {
                stmt.execute(params![tc.id, f.id, tc.tool, tc.args, tc.result, tc.status, tc.metadata])
                    .map_err(DbError::from)?;
            }
        }

        // 3) 会话计数（第 44 轮）：**只有真正新增行时**才 +1（覆盖写不该让计数变大）
        if exists == 0 {
            bump_session_message_count(tx, &f.session_id, 1)?;
        }

        Ok(json!({
            "written": written,
            "id": f.id,
            "inserted": exists == 0,
            "tool_calls": tool_calls.as_ref().map(|c| c.len()).unwrap_or(0),
        }))
    })
}

struct ToolCallRow {
    id: String,
    tool: String,
    args: String,
    result: Option<String>,
    status: String,
    metadata: Option<String>,
}

/// JSON 列取值：数组/对象 → JSON 文本；null/缺省 → None（表示"不动"）
fn json_col(p: &Value, key: &str) -> DbResult<Option<String>> {
    match p.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Ok(Some(s.clone())),
        Some(other) => Ok(Some(other.to_string())),
    }
}

/// 只替换某条消息的 tool_calls（渲染侧"更新工具调用结果"的高频路径）
pub fn tool_calls_replace(engine: &Engine, p: &Value) -> DbResult<Value> {
    let message_id = req_text(p, "message_id")?;
    let arr = p
        .get("tool_calls")
        .and_then(|x| x.as_array())
        .ok_or_else(|| DbError::missing("tool_calls（数组）"))?;
    let mut rows = Vec::with_capacity(arr.len());
    for tc in arr {
        rows.push(ToolCallRow {
            id: req_text(tc, "id")?,
            tool: req_text(tc, "tool")?,
            args: tc.get("args").cloned().unwrap_or_else(|| json!({})).to_string(),
            result: opt_text(tc, "result")?,
            status: opt_text(tc, "status")?.unwrap_or_else(|| "running".to_string()),
            metadata: match tc.get("metadata") {
                None | Some(Value::Null) => None,
                Some(other) => Some(other.to_string()),
            },
        });
    }
    engine.write_tx(|tx| {
        // 目标消息必须存在：否则会写出"孤儿工具调用"（外键会拦，但错误信息不直观）
        let exists: i64 = tx
            .query_row(
                "SELECT COUNT(*) FROM messages WHERE id = ?1",
                params![message_id],
                |r| r.get(0),
            )
            .map_err(DbError::from)?;
        if exists == 0 {
            return Err(DbError::not_found(format!(
                "messages 里没有 id={message_id}（不能写入孤儿工具调用）"
            )));
        }
        tx.execute("DELETE FROM tool_calls WHERE message_id = ?1", params![message_id])
            .map_err(DbError::from)?;
        let mut stmt = tx
            .prepare_cached(
                "INSERT INTO tool_calls (id, message_id, tool, args, result, status, metadata) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            )
            .map_err(DbError::from)?;
        for tc in &rows {
            stmt.execute(params![tc.id, message_id, tc.tool, tc.args, tc.result, tc.status, tc.metadata])
                .map_err(DbError::from)?;
        }
        Ok(json!({ "written": rows.len(), "message_id": message_id }))
    })
}

/// 读某条消息的 tool_calls（索引读；按 id 稳定排序）
pub fn tool_calls_list(engine: &Engine, p: &Value) -> DbResult<Value> {
    let message_id = req_text(p, "message_id")?;
    engine.with_conn(|conn| {
        let mut stmt = conn
            .prepare_cached(
                "SELECT id, tool, args, result, status, metadata FROM tool_calls \
                 WHERE message_id = ?1 ORDER BY id ASC",
            )
            .map_err(DbError::from)?;
        let rows = stmt
            .query_map(params![message_id], |r| {
                Ok(json!({
                    "id": r.get::<_, String>(0)?,
                    "tool": r.get::<_, String>(1)?,
                    "args": r.get::<_, Option<String>>(2)?,
                    "result": r.get::<_, Option<String>>(3)?,
                    "status": r.get::<_, Option<String>>(4)?,
                    "metadata": r.get::<_, Option<String>>(5)?,
                }))
            })
            .map_err(DbError::from)?;
        let mut items = Vec::new();
        for r in rows {
            items.push(r.map_err(DbError::from)?);
        }
        Ok(json!({ "items": items, "has_more": false, "next_cursor": Value::Null }))
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
        // 语义上非空的列不许被写成 SQL NULL（与 `messages.update` 同一条防线）
        reject_null_semantic_columns(it)?;
        let mut sets: Vec<String> = Vec::new();
        let mut vals: Vec<SqlValue> = Vec::new();
        for col in ["content", "reasoning", "model", "status", "hidden", "metadata"] {
            if let Some(v) = it.get(col) {
                // `hidden` 同 `messages.update`：写 0 必须顺带清掉裁剪标记（不变量只有一份）
                if col == "hidden" {
                    vals.push(to_sql_value(v));
                    sets.push(hidden_write_clause(vals.len()));
                    continue;
                }
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
            .prepare_cached(&format!("{MESSAGE_SELECT} WHERE id = ?1"))
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
            "{MESSAGE_SELECT} WHERE session_id = ?1{hidden_clause} \
             ORDER BY timestamp ASC, id ASC LIMIT ?2 OFFSET ?3"
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
    // `soft: true` = **隐藏**（`hidden = 1`），不删行。
    //
    // ## 为什么必须支持（真机缺陷修正）
    //
    // 渲染侧上下文压缩走的就是 `messages.delete { ids, soft: true }`
    // （`message.ts` 的 `deleteMessagesByIds`），而这里**原来完全忽略 `soft`** ——
    // 于是"隐藏"被实现成了**硬删除**。两者看着结果一样（都读不到），实际差别很大：
    //
    // - `hidden` 是会带外键级联的**行状态**：`messages.count` 的 hidden 计数、
    //   `list` 的 `include_hidden` 都依赖它；硬删除把这些信息直接抹掉；
    // - 硬删除会让"索引可由日志重建"这条不变量更难验证（重建时无法区分
    //   "本来就没有"与"曾经有、被压缩隐藏了"）；
    // - 测试双（`fake-storage-port`）按 `soft` 语义实现，而真实端口不实现 ——
    //   **测试绿、真机行为不同**，这正是最危险的一类偏差（假端口注释里写着
    //   "Rust 侧支持 soft: true"，而实际上一直不支持）。
    //
    // 现在两态齐备：`soft` 为真 → `UPDATE ... SET hidden = 1`；
    // 缺省/为假 → 原来的硬删除（`DELETE FROM messages`，tool_calls / 反馈按外键级联）。
    let soft = p.get("soft").and_then(|x| x.as_bool()).unwrap_or(false);
    // `trim: true` = 索引裁剪的隐藏（`hidden = 1` **且** `trimmed = 1`）。
    // 它蕴含软删除语义（行不删），所以调用方不必同时传 `soft`。
    let trim = p.get("trim").and_then(|x| x.as_bool()).unwrap_or(false);
    let soft = soft || trim;
    let confirmed = p.get("confirm_bulk").and_then(|x| x.as_bool()).unwrap_or(false);
    engine.write_tx(|tx| {
        // 会话计数是否被 `MAX(0, …)` 夹断过（见 `bump_session_message_count` 的说明）
        let mut count_clamped = false;
        /*
         * 硬删除的两件事（第 44 轮）：
         *
         * ① **批量删除闸门**。`BULK_DELETE_LIMIT` 的闸门原来只装在 `crud.delete` 与
         *    `sessions.delete` 上，而**真正做大范围删除的路径恰好不受保护**：
         *    启动维护的索引裁剪、`deleteMessagesBefore`（按时间清理）走的都是这里。
         *    判据与 `crud.delete` 共用同一份实现（`measure_delete_impact` +
         *    `guard_cascade_scope`）：先删、量净影响（含级联、已剔除审计行）、超限回滚。
         *    调用方**明确枚举了 id**时应当传 `confirm_bulk: true` —— 闸门要拦的是
         *    "规模不体现在参数里"的那类删除，不是"声明清楚的大删除"。
         *    隐藏（`soft`）不是破坏性操作，**不受**该闸门约束。
         *
         * ② **目标不存在时的假成功**。原来无论删掉 0 行还是 N 行都回 `ok`，
         *    于是"删一条不存在的消息"与"删成功"在调用方看来完全一样
         *    （`written: 0` 只体现在数字里，而渲染侧的 `.catch` 根本不会触发）。
         *    单目标删除（`ids` 只有一个元素）时，删不到就是**没删掉**，必须报 `not_found`；
         *    批量删除则如实回报 `written` / `missing` —— 批量里"有些已经没了"是正常形态，
         *    报错会让幂等重试变成永远失败。
         */
        let (n, impact, per_session) = if soft {
            /*
             * 软删除有两种语义，必须分得开（第 44 轮）。
             *
             * - `soft: true`（缺省语义）→ `hidden = 1`：**从上下文里移除**（压缩）。
             *   读路径必须把这条消息排除，否则就是"压缩了 840 条、token 一点没降"。
             * - `trim: true` → `hidden = 1, trimmed = 1`：**索引裁剪**。
             *   裁剪的目的是限制索引体积，而"被裁掉的历史仍能从权威日志读到"是它的前提 ——
             *   所以读路径把这一条**保留**在历史里，只是不再从索引里出。
             *
             * 两者原来在库里完全一样（都是 `hidden = 1`），渲染侧只能靠进程内记账区分，
             * 重启后必然分不清。`trimmed` 这一列把区别变成**库里的持久事实**。
             */
            let sql = if trim {
                "UPDATE messages SET hidden = 1, trimmed = 1 WHERE id = ?1"
            } else {
                "UPDATE messages SET hidden = 1 WHERE id = ?1"
            };
            let mut stmt = tx
                .prepare_cached(sql)
                .map_err(DbError::from)?;
            let mut n = 0usize;
            for id in &parsed {
                n += stmt.execute(params![id]).map_err(DbError::from)?;
            }
            // 隐藏不删行 → 计数不变
            (n, n as i64, std::collections::HashMap::new())
        } else {
            /*
             * 硬删除：**先记下每个 id 属于哪个会话，再删**。
             *
             * 顺序不能反：`session_id` 就在被删的那一行上，删完就查不到了 ——
             * 而"会话消息数"要按会话逐个减（第 44 轮消掉的正是这类"计数漂移"）。
             */
            let mut per_session: std::collections::HashMap<String, i64> = std::collections::HashMap::new();
            let (n, impact) = crate::crud::measure_delete_impact(tx, || {
                let mut lookup = tx
                    .prepare_cached("SELECT session_id FROM messages WHERE id = ?1")
                    .map_err(DbError::from)?;
                let mut stmt = tx
                    .prepare_cached("DELETE FROM messages WHERE id = ?1")
                    .map_err(DbError::from)?;
                let mut n = 0usize;
                for id in &parsed {
                    if let Some((sid,)) = lookup
                        .query_row(params![id], |r| Ok((r.get::<_, String>(0)?,)))
                        .optional()
                        .map_err(DbError::from)?
                    {
                        *per_session.entry(sid).or_insert(0) += 1;
                    }
                    n += stmt.execute(params![id]).map_err(DbError::from)?;
                }
                Ok(n)
            })?;
            (n, impact, per_session)
        };
        if n == 0 {
            if parsed.len() == 1 {
                return Err(DbError::not_found(format!(
                    "messages 里没有 id={}（{}）",
                    parsed[0],
                    if soft { "无法隐藏不存在的消息" } else { "无法删除不存在的消息" }
                )));
            }
            // 批量：不报错，但让"一条都没命中"这件事在返回值里可见
            return Ok(json!({
                "written": 0,
                "requested": parsed.len(),
                "missing": parsed.len(),
                "soft": soft,
                "affected_rows": impact,
                // 这一支里 n == 0 → 一条都没删 → 计数不可能被夹断，字段仍然给出（形状恒定）
                "count_clamped": false,
                "note": "所有 id 都不存在（没有任何行被改动）",
            }));
        }
        if !soft {
            crate::crud::guard_cascade_scope(
                &format!("硬删除 {} 条消息", n),
                impact,
                confirmed,
            )?;
            // 会话计数按会话逐个减（`per_session` 是在删除**之前**采集的）
            for (sid, delta) in &per_session {
                if bump_session_message_count(tx, sid, -*delta)? {
                    count_clamped = true;
                }
            }
        }
        Ok(json!({
            "written": n,
            "requested": parsed.len(),
            "missing": parsed.len() - n.min(parsed.len()),
            "soft": soft,
            "trim": trim,
            "affected_rows": impact,
            /*
             * `count_clamped`（第 45 轮 Z-10）：会话消息计数被 `MAX(0, …)` 夹断过。
             *
             * 夹断**只可能**发生在"计数已经漂移过"的会话上（删除数 > 计数现值），
             * 所以它不是噪音，而是"这个会话的 `message_count` 不可信"的**唯一在线信号**。
             * 静默夹断的实测形态：计数 1、库里 5 条 → 硬删 3 条 → 计数 0、库里还剩 2 条
             * ——"0 条消息的会话里躺着 2 条"，没有任何地方能看到。
             */
            "count_clamped": count_clamped,
        }))
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
    // `message_count` / `pinned` 语义上不可空（Z-3：`crud.list` 与 `messages.get` 对 NULL 的
    // 处理不一致，两条读路径给出两种答案）；写侧先把 NULL 挡住
    reject_null_semantic_columns(p)?;
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

/// **索引自愈的核心命令**（P5 第 2 段）：把「权威会话日志」的内容整批写回查询索引。
///
/// ## 为什么必须是**一条**命令、一个事务
///
/// 渲染侧的 `rebuildSessionLogs()` 原来是对旧库执行
/// `BEGIN; INSERT sessions…; INSERT messages…; DELETE tool_calls…; INSERT tool_calls…; COMMIT`
/// 一整套裸 SQL。搬到端口后如果拆成多条 IPC，中途失败就会留下
/// "会话行在、消息只写了一半、工具调用还是旧的"这种半截索引 —— 比不重建更糟。
///
/// ## 参数形状
///
/// ```json
/// { "sessions": [ { "id": "...", "messages": [ { ...message..., "tool_calls": [...] } ] } ] }
/// ```
///
/// - `hidden` 会**显式还原**（日志里记着压缩状态，重建后必须一致，否则被压缩的消息会复活）；
/// - 每条消息的 `tool_calls` 是**整体替换**（先删后插），与渲染侧语义一致；
/// - 幂等：同 id 覆盖写，重复调用不会产生重复行。
pub fn messages_rebuild_index(engine: &Engine, p: &Value) -> DbResult<Value> {
    let sessions = p
        .get("sessions")
        .and_then(|x| x.as_array())
        .ok_or_else(|| DbError::missing("sessions（数组）"))?;

    // 先在事务外把参数解析校验完：参数错误不该留下半个事务
    struct Parsed {
        id: String,
        /// 归属项目。日志里通常没记 → 落到全局项目 `""`（schema 阶段已种下该行，满足外键）。
        ///
        /// ⚠️ 第 44 轮：这里原来是**硬编码 `''`**，于是"索引重建复活的会话"会全部掉进
        /// "全局对话"项目下（真机复现：删掉的会话自愈后回到全局项目、标题看起来像一句用户话）。
        /// 现在支持从参数里带 `project_id`；**已存在的会话行不会被改**（`ON CONFLICT` 不碰这一列），
        /// 所以这个参数只影响"新建的行" —— 正是需要它影响的那部分。
        project_id: String,
        title: String,
        first_ts: i64,
        last_ts: i64,
        messages: Vec<(MessageFields, Option<Vec<ToolCallRow>>)>,
    }
    let mut parsed: Vec<Parsed> = Vec::with_capacity(sessions.len());
    for s in sessions {
        let sid = req_text(s, "id")?;
        let items = s
            .get("messages")
            .and_then(|x| x.as_array())
            .ok_or_else(|| DbError::missing("sessions[].messages（数组）"))?;
        let mut msgs = Vec::with_capacity(items.len());
        for m in items {
            let f = message_fields(m)?;
            let calls = parse_tool_calls(m)?;
            msgs.push((f, calls));
        }
        // 项目归属：优先用参数里的 `project_id`；缺省仍是全局项目（保持既有语义）
        let project_id = opt_text(s, "project_id")?.unwrap_or_default();
        let first_user = items.iter().find(|m| {
            m.get("role").and_then(|r| r.as_str()) == Some("user")
        });
        let title_src = first_user
            .and_then(|m| m.get("content").and_then(|c| c.as_str()))
            .unwrap_or("");
        let title = title_src
            .lines()
            .next()
            .unwrap_or("")
            .chars()
            .take(60)
            .collect::<String>();
        let title = if title.trim().is_empty() { format!("会话 {sid}") } else { title };
        let first_ts = msgs.first().map(|(f, _)| f.timestamp).unwrap_or_else(now_ms);
        let last_ts = msgs.last().map(|(f, _)| f.timestamp).unwrap_or(first_ts);
        parsed.push(Parsed {
            id: sid,
            project_id,
            title,
            first_ts,
            last_ts,
            messages: msgs,
        });
    }

    engine.write_tx(|tx| {
        let mut sess_stmt = tx
            .prepare_cached(
                /*
                 * ⚠️ `message_count` **不能**写日志条数（第 45 轮，Z-9）。
                 *
                 * 原来这里写的是 `excluded.message_count`，也就是"这次请求里带了几条消息"。
                 * 审计实测：索引里 60 行、日志只给 5 条 → 重建后 `sessions.message_count = 5`，
                 * 而 `messages.count` 是 60 —— **两个真值当场分叉**，而且是无条件覆盖：
                 * 维护对账（`maintenance.ts` 的 `reconcileMessageCounts`）会按**索引真值**改回来，
                 * 下一次重建又按日志条数改回去，两个写入者来回打架，用户看到侧边栏数字跳。
                 *
                 * 现在写的是**索引真值**：`SELECT COUNT(*) FROM messages WHERE session_id = ?1`，
                 * 也就是这个会话在库里**真实存在多少行**（下面在事务内先算出 `index_counts`）。理由：
                 * ① 这一列的定义就是"这个会话有几条消息"，而 `messages` 表才是它的唯一载体；
                 * ② 维护对账用的正是同一个数 —— 于是"重建"与"对账"指向同一个不动点，
                 *    不再有两个写入者互相覆盖；
                 * ③ 日志条数少不等于"消息变少了"：日志可能是**部分**的
                 *    （`rebuildSessionLogs` 只喂它读到的那些会话/条数），
                 *    拿局部真相去覆盖全量真值必然错。
                 *
                 * 注意：**这次重放了多少条**仍然在返回值 `messages` 里如实汇报
                 * （另加 `index_message_count` 给出引擎看到的索引总行数），
                 * 调用方想知道"日志给了多少"看返回值，不要看这一列。
                 */
                "INSERT INTO sessions (id, project_id, title, created_at, last_message_at, message_count, pinned) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0) \
                 ON CONFLICT(id) DO UPDATE SET last_message_at = excluded.last_message_at, \
                   message_count = excluded.message_count",
            )
            .map_err(DbError::from)?;
        /*
         * 消息 upsert 用的**不是**全局那份 `MESSAGE_UPSERT`（第 45 轮）。
         *
         * 差别只有一处，但是关键的一处：`trimmed` 在冲突时**保持库里的值**。
         * 全局那份走 `trimmed = CASE WHEN excluded.hidden = 0 THEN 0 ELSE trimmed END` ——
         * 规则本身没错（那正是"写可见就必须清裁剪标记"的不变量），但**不能**用在日志重放上：
         * 日志里**根本没有 `trimmed` 这一维**（`MessageFields` 没有它，`distillMessageForLog`
         * 也不写它）。于是重建时日志说 `hidden = 0` 就等价于"这条消息是可见的"——
         * 而它可能只是**日志比索引旧**，库里那条明明是裁剪隐藏的。
         * 结果就是把"被裁过"这个事实静默抹掉（审计实测：`hidden=0, trimmed=1` 的矛盾态，
         * 且 `messages.count` 的 visible 计数跟着变）。
         *
         * 所以重建路径的规则是：**`trimmed` 永不由重建改写**。
         * - 冲突（库里已有）：`trimmed` 保持原值；
         * - 新插入：`trimmed` 取默认 0 —— 新行不可能"曾经被裁过"。
         * "裁剪"这件事只有 `messages.delete { trim: true }` 能设，
         * 只有 `messages.update { hidden: 0 }` / `upsert_index { hidden: 0 }` 能清。
         */
        let mut msg_stmt = tx
            .prepare_cached(
                "INSERT INTO messages \
                   (id, session_id, role, content, reasoning, timestamp, model, status, hidden, trimmed) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10) \
                 ON CONFLICT(id) DO UPDATE SET content = excluded.content, reasoning = excluded.reasoning, \
                   model = excluded.model, status = excluded.status, timestamp = excluded.timestamp, \
                   hidden = excluded.hidden, trimmed = excluded.trimmed",
            )
            .map_err(DbError::from)?;
        let mut del_tc = tx
            .prepare_cached("DELETE FROM tool_calls WHERE message_id = ?1")
            .map_err(DbError::from)?;
        let mut ins_tc = tx
            .prepare_cached(
                "INSERT INTO tool_calls (id, message_id, tool, args, result, status, metadata) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            )
            .map_err(DbError::from)?;
        // 补回可能缺失的 `messages.parent_message_id` / `metadata`（日志里有就带上）
        let mut meta_stmt = tx
            .prepare_cached(
                "UPDATE messages SET parent_message_id = COALESCE(?2, parent_message_id), \
                   metadata = COALESCE(?3, metadata) WHERE id = ?1",
            )
            .map_err(DbError::from)?;

        let mut msgs_written = 0i64;
        let mut tools_written = 0i64;
        /*
         * 库里**已有的** `trimmed` 值（第 45 轮）：重建不产生、也不清除"被裁剪过"这个事实。
         *
         * 为什么在事务里先查一遍而不是用 SQL 表达式：
         * 需要在"值本身"上判断（NULL 要与 0 同义，且 `hidden` 有 0/1 两种值时 CASE 会变复杂），
         * 用 `HashMap` 表达最直白，也最容易被下一个人读懂。
         * 表不大（一次重建的会话数有限），一次全表扫描的代价可接受。
         */
        let trimmed_keep: std::collections::HashMap<String, i64> = {
            let mut stmt = tx
                .prepare("SELECT id, COALESCE(trimmed, 0) FROM messages")
                .map_err(DbError::from)?;
            let rows = stmt
                .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
                .map_err(DbError::from)?;
            let mut m = std::collections::HashMap::new();
            for r in rows {
                let (id, t) = r.map_err(DbError::from)?;
                m.insert(id, t);
            }
            m
        };
        /*
         * 每个会话的**索引真值**（库里真实行数，按 `session_id` 聚合，一次扫描算完）。
         *
         * 在**本事务内、写之前**算：这样 `messages.create` 之后紧接着的重建也能拿到正确的数
         * （写入是本次事务里发生的，事务外的连接看不到自己的写 —— 那种"自己看不见自己"的坑
         * 会让计数少一批，比原来按日志条数写更糟）。
         */
        let index_counts: std::collections::HashMap<String, i64> = {
            let mut stmt = tx
                .prepare("SELECT session_id, COUNT(*) FROM messages GROUP BY session_id")
                .map_err(DbError::from)?;
            let rows = stmt
                .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
                .map_err(DbError::from)?;
            let mut m = std::collections::HashMap::new();
            for r in rows {
                let (sid, n) = r.map_err(DbError::from)?;
                m.insert(sid, n);
            }
            m
        };
        for s in &parsed {
            sess_stmt
                .execute(params![
                    s.id,
                    s.project_id,
                    s.title,
                    s.first_ts,
                    s.last_ts,
                    // 索引真值；该会话在 messages 里一行都没有时才落 0
                    index_counts.get(&s.id).copied().unwrap_or(0)
                ])
                .map_err(DbError::from)?;
            for (f, calls) in &s.messages {
                msg_stmt
                    .execute(params![
                        f.id,
                        f.session_id,
                        f.role,
                        f.content,
                        f.reasoning,
                        f.timestamp,
                        f.model,
                        f.status,
                        f.hidden,
                        trimmed_keep.get(&f.id).copied().unwrap_or(0)
                    ])
                    .map_err(DbError::from)?;
                msgs_written += 1;
                meta_stmt
                    .execute(params![
                        f.id,
                        f.parent_message_id,
                        f.metadata
                    ])
                    .map_err(DbError::from)?;
                if let Some(list) = calls {
                    del_tc.execute(params![f.id]).map_err(DbError::from)?;
                    for tc in list {
                        ins_tc
                            .execute(params![tc.id, f.id, tc.tool, tc.args, tc.result, tc.status, tc.metadata])
                            .map_err(DbError::from)?;
                        tools_written += 1;
                    }
                }
            }
        }
        drop(msg_stmt);
        drop(meta_stmt);
        /*
         * 返回值里如实报出**引擎当前看到的**消息总数（第 45 轮）。
         *
         * `messages` 字段是"这次重放写入的条数"（原来唯一的一个数），
         * 而它**不是** `sessions.message_count` 的来源 —— 恰恰因为两者不是一回事，
         * 原来看这一个数去写那一个列才会分叉。多给一个 `index_message_count`
         * 让调用方能一眼看出"日志 5 条 / 索引 60 行"这种局部真相，
         * 而不是从两个命令的返回值里自己去猜。
         */
        let index_total: i64 = tx
            .query_row("SELECT COUNT(*) FROM messages", [], |r| r.get(0))
            .map_err(DbError::from)?;
        Ok(json!({
            "sessions": parsed.len(),
            "messages": msgs_written,
            "index_message_count": index_total,
            "tool_calls": tools_written,
        }))
    })
}

/// 解析消息的 `tool_calls`（与 `messages.upsert_index` 同一套校验）
fn parse_tool_calls(p: &Value) -> DbResult<Option<Vec<ToolCallRow>>> {
    match p.get("tool_calls") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Array(arr)) => {
            let mut out = Vec::with_capacity(arr.len());
            for tc in arr {
                out.push(ToolCallRow {
                    id: req_text(tc, "id")?,
                    tool: req_text(tc, "tool")?,
                    args: tc.get("args").cloned().unwrap_or_else(|| json!({})).to_string(),
                    result: opt_text(tc, "result")?,
                    status: opt_text(tc, "status")?.unwrap_or_else(|| "running".to_string()),
                    metadata: match tc.get("metadata") {
                        None | Some(Value::Null) => None,
                        Some(other) => Some(other.to_string()),
                    },
                });
            }
            Ok(Some(out))
        }
        Some(other) => Err(DbError::invalid("tool_calls", format!("期望数组，收到 {other}"))),
    }
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

/// 删除会话（级联删除其消息/工具调用/事件 —— 外键 ON DELETE CASCADE）
///
/// 故意**不允许删全局项目**（`projects.id = ''`）：它是全局会话的外键目标，
/// 删掉会让所有全局会话失去归属。所以 `projects.delete` 对空 id 直接报错。
pub fn sessions_delete(engine: &Engine, p: &Value) -> DbResult<Value> {
    let id = req_text(p, "id")?;
    let confirmed = p.get("confirm_bulk").and_then(|x| x.as_bool()).unwrap_or(false);
    engine.write_tx(|tx| {
        /*
         * 级联规模闸门（第 32 轮事故）。
         *
         * 这一步删的是 **1 行**，但外键级联会带走该会话的全部消息 / 工具调用 / 事件。
         * 实测事故：删 2 个会话 → 821 条消息 + 883 个工具调用 + 2131 条事件消失，
         * 而调用参数里完全看不出这个规模。
         *
         * 第 44 轮修正：原来这里只**预检 messages 的行数**，于是
         * ① 事件与工具调用的规模看不见（三个数只算了一个）；
         * ② 更要命的是**判据只装在这一条命令上**，而渲染侧删会话走的是 `crud.delete`
         *    → 防护在生产路径上等于不存在（真机复现 300 条消息静默消失）。
         * 现在两处都用 `crud::measure_delete_impact`：真删一次、量净影响、超限回滚。
         */
        let (n, impact) = crate::crud::measure_delete_impact(tx, || {
            let n = tx
                .execute("DELETE FROM sessions WHERE id = ?1", params![id])
                .map_err(DbError::from)?;
            if n == 0 {
                return Err(DbError::not_found(format!("sessions 里没有 id={id}")));
            }
            Ok(n)
        })?;
        crate::crud::guard_cascade_scope(&format!("删除会话 {id}"), impact, confirmed)?;
        Ok(json!({ "written": n, "affected_rows": impact }))
    })
}

pub fn projects_delete(engine: &Engine, p: &Value) -> DbResult<Value> {
    let id = req_text(p, "id")?;
    if id.is_empty() {
        return Err(DbError::invalid(
            "id",
            "不允许删除全局项目（projects.id='' 是全局会话的外键目标）",
        ));
    }
    let confirmed = p.get("confirm_bulk").and_then(|x| x.as_bool()).unwrap_or(false);
    engine.write_tx(|tx| {
        /*
         * 删项目会级联删掉它的**全部会话 → 全部消息/工具调用/事件**，
         * 而 `written` 只显示 1。这是本系统里单条命令能造成的最大规模删除。
         * 判据与 `crud.delete` 完全共用（见 `crud::measure_delete_impact` 的说明）：
         * 先删、再量、超限回滚 —— 事务保证被拒绝时库里一行未动。
         */
        let (n, impact) = crate::crud::measure_delete_impact(tx, || {
            let n = tx
                .execute("DELETE FROM projects WHERE id = ?1", params![id])
                .map_err(DbError::from)?;
            if n == 0 {
                return Err(DbError::not_found(format!("projects 里没有 id={id}")));
            }
            Ok(n)
        })?;
        crate::crud::guard_cascade_scope(
            &format!("删除项目 {id}（连带其全部会话与消息）"),
            impact,
            confirmed,
        )?;
        Ok(json!({ "written": n, "affected_rows": impact }))
    })
}

pub fn projects_list(engine: &Engine, p: &Value) -> DbResult<Value> {    let limit = limit_of(p)?;
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
