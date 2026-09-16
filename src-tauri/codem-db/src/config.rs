//! 配置面仓储命令（P3 第 3 段）：`quick_phrases` / `mcp_servers` / `memory`。
//!
//! ## 为什么这三张表归"配置面"
//!
//! 判据不是"名字像配置"，而是**量级**：配置面的定义是"小到可以整表放进内存"。
//! 实测生产库：`settings` 24 行、`quick_phrases` 0 行、`mcp_servers` 0 行、`memory` 1 行。
//! 而 `cost_records`（可能上万行）、`recovery_data`（每会话一份快照）**不属于配置面** ——
//! 它们不进行内存镜像，走数据面的分页读。
//!
//! 正因为小，这三张表可以享受与 `settings` 相同的形态：**同步读（内存镜像）+ 写穿**。
//! 于是 `loadQuickPhrases()` / `loadMcpServers()` / `loadMemory()` 这些同步函数
//! **不需要改签名**就能切到 Rust —— 878 个调用点的迁移经验在这里直接复用。
//!
//! ## 依赖
//!
//! 依赖 `repo.rs` 的 JSON 取值工具（严格类型校验，不做静默强转）。

use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};

use crate::engine::Engine;
use crate::error::{DbError, DbResult};
use crate::repo::{limit_of, offset_of, opt_i64, opt_text, req_text};
use crate::schema::now_ms;

// ========== quick_phrases ==========

/// 写一条快捷短语（与渲染侧语义一致：冲突时 usage_count **自增**）
///
/// 渲染侧原实现是 `usage_count = excluded.usage_count + 1`，即"存一次就涨一次"。
/// 这里必须保持同样语义 —— 迁移动机之一就是别再让两边语义悄悄分叉。
pub fn quick_phrases_save(engine: &Engine, p: &Value) -> DbResult<Value> {
    let id = req_text(p, "id")?;
    let title = opt_text(p, "title")?.unwrap_or_default();
    let content = opt_text(p, "content")?.unwrap_or_default();
    let category = opt_text(p, "category")?.unwrap_or_else(|| "other".to_string());
    let usage_count = opt_i64(p, "usage_count")?.unwrap_or(0);
    let created_at = opt_i64(p, "created_at")?.unwrap_or_else(now_ms);
    let updated_at = opt_i64(p, "updated_at")?.unwrap_or_else(now_ms);
    engine.write_tx(|tx| {
        let n = tx
            .execute(
                "INSERT INTO quick_phrases (id, title, content, category, usage_count, created_at, updated_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) \
                 ON CONFLICT(id) DO UPDATE SET title = excluded.title, content = excluded.content, \
                   category = excluded.category, usage_count = quick_phrases.usage_count + 1, \
                   updated_at = excluded.updated_at",
                params![id, title, content, category, usage_count + 1, created_at, updated_at],
            )
            .map_err(DbError::from)?;
        Ok(json!({ "written": n, "id": id }))
    })
}

pub fn quick_phrases_list(engine: &Engine, _p: &Value) -> DbResult<Value> {
    engine.with_conn(|conn| {
        let mut stmt = conn
            .prepare_cached(
                "SELECT id, title, content, category, usage_count, created_at, updated_at \
                 FROM quick_phrases ORDER BY usage_count DESC, updated_at DESC",
            )
            .map_err(DbError::from)?;
        let rows = stmt
            .query_map([], |r| {
                Ok(json!({
                    "id": r.get::<_, String>(0)?,
                    "title": r.get::<_, String>(1)?,
                    "content": r.get::<_, String>(2)?,
                    "category": r.get::<_, String>(3)?,
                    "usage_count": r.get::<_, i64>(4)?,
                    "created_at": r.get::<_, i64>(5)?,
                    "updated_at": r.get::<_, i64>(6)?,
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

pub fn quick_phrases_delete(engine: &Engine, p: &Value) -> DbResult<Value> {
    let id = req_text(p, "id")?;
    engine.write_tx(|tx| {
        let n = tx
            .execute("DELETE FROM quick_phrases WHERE id = ?1", params![id])
            .map_err(DbError::from)?;
        if n == 0 {
            return Err(DbError::not_found(format!("quick_phrases 里没有 id={id}")));
        }
        Ok(json!({ "written": n }))
    })
}

/// 使用次数 +1（渲染侧 `incrementQuickPhraseUsage`）
pub fn quick_phrases_touch(engine: &Engine, p: &Value) -> DbResult<Value> {
    let id = req_text(p, "id")?;
    let at = opt_i64(p, "updated_at")?.unwrap_or_else(now_ms);
    engine.write_tx(|tx| {
        let n = tx
            .execute(
                "UPDATE quick_phrases SET usage_count = usage_count + 1, updated_at = ?1 WHERE id = ?2",
                params![at, id],
            )
            .map_err(DbError::from)?;
        // A 类防线：影响 0 行必须让调用方知道
        if n == 0 {
            return Err(DbError::not_found(format!("quick_phrases 里没有 id={id}")));
        }
        Ok(json!({ "written": n }))
    })
}

// ========== mcp_servers ==========

pub fn mcp_servers_list(engine: &Engine, _p: &Value) -> DbResult<Value> {
    engine.with_conn(|conn| {
        let mut stmt = conn
            .prepare_cached("SELECT id, name, config, enabled FROM mcp_servers ORDER BY name")
            .map_err(DbError::from)?;
        let rows = stmt
            .query_map([], |r| {
                Ok(json!({
                    "id": r.get::<_, String>(0)?,
                    "name": r.get::<_, String>(1)?,
                    "config": r.get::<_, String>(2)?,
                    "enabled": r.get::<_, i64>(3)? == 1,
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

pub fn mcp_servers_save(engine: &Engine, p: &Value) -> DbResult<Value> {
    let id = req_text(p, "id")?;
    let name = opt_text(p, "name")?.unwrap_or_else(|| id.clone());
    let config = opt_text(p, "config")?.unwrap_or_default();
    // enabled 接受布尔或 0/1（渲染侧历史上有两种写法）
    let enabled = match p.get("enabled") {
        Some(Value::Bool(b)) => i64::from(*b),
        Some(Value::Number(n)) => n.as_i64().unwrap_or(0),
        None | Some(Value::Null) => 0,
        Some(other) => {
            return Err(DbError::invalid("enabled", format!("期望布尔，收到 {other}")))
        }
    };
    let now = now_ms();
    engine.write_tx(|tx| {
        let n = tx
            .execute(
                "INSERT INTO mcp_servers (id, name, config, enabled, created_at, updated_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?5) \
                 ON CONFLICT(id) DO UPDATE SET name = excluded.name, config = excluded.config, \
                   enabled = excluded.enabled, updated_at = excluded.updated_at",
                params![id, name, config, enabled, now],
            )
            .map_err(DbError::from)?;
        Ok(json!({ "written": n, "id": id }))
    })
}

pub fn mcp_servers_remove(engine: &Engine, p: &Value) -> DbResult<Value> {
    let id = req_text(p, "id")?;
    engine.write_tx(|tx| {
        let n = tx
            .execute("DELETE FROM mcp_servers WHERE id = ?1", params![id])
            .map_err(DbError::from)?;
        if n == 0 {
            return Err(DbError::not_found(format!("mcp_servers 里没有 id={id}")));
        }
        Ok(json!({ "written": n }))
    })
}

// ========== memory（单行：id='default'） ==========

pub fn memory_get(engine: &Engine, _p: &Value) -> DbResult<Value> {
    engine.with_conn(|conn| {
        let content: Option<String> = conn
            .query_row("SELECT content FROM memory WHERE id = 'default'", [], |r| r.get(0))
            .optional()
            .map_err(DbError::from)?;
        let present = content.is_some();
        // 没有记录时返回空串（与渲染侧 `loadMemory()` 的语义一致：它返回 ""）
        Ok(json!({ "content": content.unwrap_or_default(), "present": present }))
    })
}

pub fn memory_set(engine: &Engine, p: &Value) -> DbResult<Value> {
    let content = opt_text(p, "content")?.unwrap_or_default();
    let now = now_ms();
    engine.write_tx(|tx| {
        let n = tx
            .execute(
                "INSERT INTO memory (id, content, updated_at) VALUES ('default', ?1, ?2) \
                 ON CONFLICT(id) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at",
                params![content, now],
            )
            .map_err(DbError::from)?;
        Ok(json!({ "written": n }))
    })
}

/// 一次性读取整个配置面（启动预热用；避免三次 IPC 往返）
pub fn config_warmup(engine: &Engine, _p: &Value) -> DbResult<Value> {
    let phrases = quick_phrases_list(engine, &json!({}))?;
    let servers = mcp_servers_list(engine, &json!({}))?;
    let mem = memory_get(engine, &json!({}))?;
    Ok(json!({
        "quick_phrases": phrases["items"],
        "mcp_servers": servers["items"],
        "memory": mem["content"],
        "warmed_at_ms": now_ms(),
    }))
}

// ========== 消息反馈（message_feedback） ==========
//
// 渲染侧语义：一条消息最多一个反馈（like/dislike）。`saveFeedback(id, sid, null)` 是**取消**，
// 所以这里用"先删后插"而不是 upsert —— 与渲染侧 `DELETE` + `INSERT` 完全一致。
// 表上有 `CHECK (feedback IN ('like','dislike'))`，非法值由数据库拒绝（比静默写入好）。

pub fn feedback_set(engine: &Engine, p: &Value) -> DbResult<Value> {
    let message_id = req_text(p, "message_id")?;
    let session_id = req_text(p, "session_id")?;
    let feedback = opt_text(p, "feedback")?;
    let ts = opt_i64(p, "timestamp")?.unwrap_or_else(now_ms);
    engine.write_tx(|tx| {
        // 先删（取消 + 覆盖两种情形都覆盖）
        tx.execute(
            "DELETE FROM message_feedback WHERE message_id = ?1",
            params![message_id],
        )
        .map_err(DbError::from)?;
        match feedback.as_deref() {
            None | Some("") => Ok(json!({ "written": 0, "cleared": true })),
            Some(kind) => {
                if kind != "like" && kind != "dislike" {
                    return Err(DbError::invalid(
                        "feedback",
                        format!("只允许 like / dislike（或 null 取消），收到 {kind}"),
                    ));
                }
                let id = format!("fb-{message_id}");
                tx.execute(
                    "INSERT INTO message_feedback (id, message_id, session_id, feedback, timestamp) \
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![id, message_id, session_id, kind, ts],
                )
                .map_err(DbError::from)?;
                Ok(json!({ "written": 1, "feedback": kind }))
            }
        }
    })
}

pub fn feedback_get(engine: &Engine, p: &Value) -> DbResult<Value> {
    let message_id = req_text(p, "message_id")?;
    engine.with_conn(|conn| {
        let kind: Option<String> = conn
            .query_row(
                "SELECT feedback FROM message_feedback WHERE message_id = ?1",
                params![message_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(DbError::from)?;
        Ok(json!({ "item": kind.map(|k| json!({ "feedback": k })) }))
    })
}

pub fn feedback_delete(engine: &Engine, p: &Value) -> DbResult<Value> {
    let message_id = req_text(p, "message_id")?;
    engine.write_tx(|tx| {
        let n = tx
            .execute(
                "DELETE FROM message_feedback WHERE message_id = ?1",
                params![message_id],
            )
            .map_err(DbError::from)?;
        Ok(json!({ "written": n }))
    })
}

// ========== 附件（attachments） ==========
//
// 渲染侧对附件只做两件事：更新正文/预览（大附件外置化时用）、列全部附件。
// `attachments.content` 可能非常大（大文档），所以：
// - **不提供把整表读进内存的命令**（list 不返回 content，只给元数据）；
// - 需要正文时按 id 单独取（`attachments.content`）。

/// 更新附件正文与预览（`preview` 用 COALESCE 语义：只给正文时不动原预览）
pub fn attachments_update(engine: &Engine, p: &Value) -> DbResult<Value> {
    let id = req_text(p, "id")?;
    let content = opt_text(p, "content")?;
    let preview = opt_text(p, "preview")?;
    engine.write_tx(|tx| {
        let n = tx
            .execute(
                "UPDATE attachments SET content = COALESCE(?1, content), \
                   preview = COALESCE(?2, preview) WHERE id = ?3",
                params![content, preview, id],
            )
            .map_err(DbError::from)?;
        if n == 0 {
            return Err(DbError::not_found(format!("attachments 里没有 id={id}")));
        }
        Ok(json!({ "written": n, "id": id }))
    })
}

/// 分页列附件元数据（**不含 content** —— 大附件正文必须按需单独取）
pub fn attachments_list(engine: &Engine, p: &Value) -> DbResult<Value> {
    let session_id = opt_text(p, "session_id")?;
    let limit = limit_of(p)?;
    let offset = offset_of(p)?;
    engine.with_conn(|conn| {
        let mut items: Vec<Value> = Vec::new();
        match session_id {
            Some(sid) => {
                let mut stmt = conn
                    .prepare_cached(
                        "SELECT id, session_id, message_id, name, type, path, mime_type, size, preview, sandbox_path \
                         FROM attachments WHERE session_id = ?1 ORDER BY id ASC LIMIT ?2 OFFSET ?3",
                    )
                    .map_err(DbError::from)?;
                let rows = stmt
                    .query_map(params![sid, (limit + 1) as i64, offset as i64], attachment_row)
                    .map_err(DbError::from)?;
                for r in rows {
                    items.push(r.map_err(DbError::from)?);
                }
            }
            None => {
                let mut stmt = conn
                    .prepare_cached(
                        "SELECT id, session_id, message_id, name, type, path, mime_type, size, preview, sandbox_path \
                         FROM attachments ORDER BY id ASC LIMIT ?1 OFFSET ?2",
                    )
                    .map_err(DbError::from)?;
                let rows = stmt
                    .query_map(params![(limit + 1) as i64, offset as i64], attachment_row)
                    .map_err(DbError::from)?;
                for r in rows {
                    items.push(r.map_err(DbError::from)?);
                }
            }
        }
        let has_more = items.len() > limit;
        if has_more {
            items.truncate(limit);
        }
        Ok(json!({ "items": items, "has_more": has_more, "next_cursor": Value::Null }))
    })
}

fn attachment_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    Ok(json!({
        "id": r.get::<_, String>(0)?,
        "session_id": r.get::<_, Option<String>>(1)?,
        "message_id": r.get::<_, Option<String>>(2)?,
        "name": r.get::<_, Option<String>>(3)?,
        "type": r.get::<_, Option<String>>(4)?,
        "path": r.get::<_, Option<String>>(5)?,
        "mime_type": r.get::<_, Option<String>>(6)?,
        "size": r.get::<_, Option<i64>>(7)?,
        "preview": r.get::<_, Option<String>>(8)?,
        "sandbox_path": r.get::<_, Option<String>>(9)?,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::Engine;

    fn eng(name: &str) -> (tempfile::TempDir, Engine) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(format!("{name}.bin"));
        (dir, Engine::open(&path).unwrap())
    }

    fn call(e: &Engine, cmd: &str, p: Value) -> DbResult<Value> {
        crate::dispatch(e, cmd, &p)
    }

    #[test]
    fn quick_phrase_save_increments_usage_like_renderer() {
        let (_d, e) = eng("qp");
        call(&e, "quick_phrases.save", json!({ "id": "q1", "title": "T", "content": "C" })).unwrap();
        let after1 = call(&e, "quick_phrases.list", json!({})).unwrap();
        assert_eq!(after1["items"][0]["usage_count"], json!(1), "首次保存应为 1（渲染侧语义）");
        // 再存一次：usage_count 自增（不是覆盖）
        call(&e, "quick_phrases.save", json!({ "id": "q1", "title": "T2", "content": "C2" })).unwrap();
        let after2 = call(&e, "quick_phrases.list", json!({})).unwrap();
        assert_eq!(after2["items"][0]["usage_count"], json!(2), "重复保存必须自增");
        assert_eq!(after2["items"][0]["title"], json!("T2"), "标题应被覆盖");
        // 只有一行（upsert 不是 insert）
        assert_eq!(after2["items"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn quick_phrase_touch_and_delete_report_not_found() {
        let (_d, e) = eng("qp2");
        assert_eq!(
            call(&e, "quick_phrases.touch", json!({ "id": "nope" })).unwrap_err().code,
            crate::ErrorCode::NotFound
        );
        assert_eq!(
            call(&e, "quick_phrases.delete", json!({ "id": "nope" })).unwrap_err().code,
            crate::ErrorCode::NotFound
        );
        call(&e, "quick_phrases.save", json!({ "id": "q1" })).unwrap();
        call(&e, "quick_phrases.touch", json!({ "id": "q1" })).unwrap();
        let list = call(&e, "quick_phrases.list", json!({})).unwrap();
        assert_eq!(list["items"][0]["usage_count"], json!(2), "save(1) + touch(1)");
    }

    #[test]
    fn mcp_servers_roundtrip_and_bool_enabled() {
        let (_d, e) = eng("mcp");
        call(&e, "mcp_servers.save", json!({ "id": "s1", "name": "伺服", "config": "{}", "enabled": true })).unwrap();
        let list = call(&e, "mcp_servers.list", json!({})).unwrap();
        assert_eq!(list["items"][0]["enabled"], json!(true), "enabled 必须是布尔（渲染侧依赖）");
        // enabled 也接受 0/1
        call(&e, "mcp_servers.save", json!({ "id": "s1", "enabled": 0 })).unwrap();
        let list2 = call(&e, "mcp_servers.list", json!({})).unwrap();
        assert_eq!(list2["items"][0]["enabled"], json!(false));
        // 非法类型要报错，不静默当 false
        assert!(call(&e, "mcp_servers.save", json!({ "id": "s1", "enabled": "yes" })).is_err());
        call(&e, "mcp_servers.remove", json!({ "id": "s1" })).unwrap();
        assert_eq!(call(&e, "mcp_servers.list", json!({})).unwrap()["items"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn memory_default_empty_then_roundtrip() {
        let (_d, e) = eng("mem");
        let empty = call(&e, "memory.get", json!({})).unwrap();
        assert_eq!(empty["content"], json!(""), "没有记录时返回空串（渲染侧语义）");
        assert_eq!(empty["present"], json!(false), "present 用来区分「没有记录」与「记录为空」");
        call(&e, "memory.set", json!({ "content": "记忆内容" })).unwrap();
        let got = call(&e, "memory.get", json!({})).unwrap();
        assert_eq!(got["content"], json!("记忆内容"));
        assert_eq!(got["present"], json!(true));
        // 单行：重复写入只更新
        call(&e, "memory.set", json!({ "content": "更新后" })).unwrap();
        assert_eq!(call(&e, "memory.get", json!({})).unwrap()["content"], json!("更新后"));
    }

    #[test]
    fn config_warmup_returns_all_three() {
        let (_d, e) = eng("warm");
        call(&e, "quick_phrases.save", json!({ "id": "q", "title": "t" })).unwrap();
        call(&e, "memory.set", json!({ "content": "m" })).unwrap();
        let w = call(&e, "config_warmup", json!({})).unwrap();
        assert_eq!(w["quick_phrases"].as_array().unwrap().len(), 1);
        assert_eq!(w["memory"], json!("m"));
        assert!(w["mcp_servers"].is_array());
        assert!(w["warmed_at_ms"].is_number());
    }
}
