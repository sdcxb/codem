//! 记忆独立表 + FTS 镜像（24 §P2，P2-C 的最小可用子集）。
//!
//! ## 为什么需要它（先读这段再改）
//!
//! 记忆的**权威**仍然是 settings 里的 `memory` 字段（`MemoryService` 整份读写）。
//! 这张表**不是**第二个真相源，它只是那份 JSON 的**可检索结构镜像**：
//!
//! - `memories`：每条记忆一行（id / 作用域 / 归属 / key / 正文 / 来源 / 状态 / 归档 / 使用计数）；
//! - `memories_fts`：`key` 与 `content` 的全文索引（CJK 按 `fts::tokenize` 做单字 + 双字切分）。
//!
//! 存在的唯一理由：跨会话 / 跨项目的**显式 opt-in** 检索必须在**有界**的候选集上做过滤，
//! 而不是把整份 payload 读进渲染进程再逐条比（规模一大就没有「有界检索」这回事）。
//! 因此镜像**允许滞后**：渲染侧检索到镜像命中后，还要回到 settings 的条目上复核
//! 作用域 / 状态 / 归档（见 `memory.ts::searchAcrossScopes`）—— 镜像只负责"可能命中的 id"。
//!
//! ## 两条命令的分工
//!
//! - `memories.replace_all`：**全量替换**（单事务：清空内容表 + 全文表，再逐行写入）。
//!   渲染侧在记忆保存成功路径后台调用它；失败**不阻断**保存（镜像丢了可以重建，
//!   记忆丢了不行 —— 这与「索引可重建、权威是 JSONL」是同一条纪律）。
//! - `memories.search`：**只读**、跨作用域、**必须给过滤条件**（`projectId` 或 `sessionId`），
//!   否则直接拒绝 —— 这是「跨会话检索必须显式 opt-in」在引擎侧的 fail-closed。
//! - `memories.upsert_embeddings`（24 号文 P2-C）：按 id 写向量 BLOB / 维度（**单事务**）。
//!   渲染侧在后台为变更条目调用它；失败不阻断记忆保存（向量不是权威数据）。
//! - `memories.vector_search`（24 号文 P2-C）：**只读**、余弦检索，过滤口径与 `memories.search`
//!   **逐条相同**（scope/status/archived + 必须给 projectId/sessionId）。维度不符的行跳过，
//!   不参与排序（两个向量空间的余弦是噪声，不是"不相关"）。
//!
//! 线协议命名说明（24 号文写作 `memories_upsert_embeddings` / `memories_vector_search`）：
//! 本仓的命令名统一用「点号命名空间」(`<域>.<动作>`)，与 `memories.replace_all` / `memories.search`
//! 保持一致；对应实现是下面两个 `pub fn`。
//!
//! ## 可见性口径（与 `MemoryService.visibleIn` 逐条对齐）
//!
//! 一次检索返回的是「**platform**（处处可见）+ **指定的** project（`project_id` 相等）+
//! **指定的** conversation（`session_id` 相等）+ **指定的** team（25:668：`team_id` 相等，
//! 且条目自己的 `project_id` 为空或与指定项目相等）」四者的并集：
//!
//! - `scope='project'` 但没有 `project_id` 的孤儿条目**不返回**（它不进任何上下文）；
//! - `scope='conversation'` 但没有 `session_id` 的孤儿条目同样不返回；
//! - `scope='team'` 但没有 `team_id` 的孤儿条目同样不返回；
//! - `archived=1` 的条目**不返回**（已归档 = 不进上下文）；
//! - `status='pending'` 的条目**不返回**（未批准不许被"读出来"绕开审批）。
//!
//! 这五条里任何一条被去掉，引擎侧就多出一条泄漏/越权的读面，所以它们都写在这里而不是交给调用方。

use rusqlite::params;
use serde_json::{json, Value};

use crate::engine::Engine;
use crate::error::{DbError, DbResult};
use crate::repo::{cap_by_bytes, limit_of, opt_text, req_text};
use crate::schema::now_ms;

/// 单次跨作用域检索的结果条数上限（再大对"模型读回结果"没有意义，且每条都带正文）。
///
/// 与会话全文检索的 `FTS_SEARCH_MAX`（50）刻意分开：记忆条目允许 1 万字符，
/// 50 条正文可达 500 KB，**跨项目**检索一次推这么多过 IPC 不划算。25 条 ≈ 250 KB 上限。
pub const MEMORIES_SEARCH_MAX: usize = 25;

/// 单条向量的**维度上限**（24 号文 P2-C）。
///
/// 取 8192：常见 embedding 模型在 384～3072 维之间，8192 留了余量；
/// 上限的作用是**拒绝坏数据**（一个百万项的数组会让 BLOB 与解析成本失控），
/// 而不是表达"只支持这些模型"。超限 ⇒ 整批拒绝（不做部分写入）。
pub const MEMORY_EMBEDDING_DIM_MAX: usize = 8192;

/// 把 f32 向量编成 BLOB（小端、连续；`embedding_dim` 单独存列）。
pub fn vector_to_blob(vector: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(vector.len() * 4);
    for v in vector {
        out.extend_from_slice(&v.to_le_bytes());
    }
    out
}

/// BLOB 解码（长度必须是 4 的倍数且非空；否则 `None` —— 坏数据跳过，不参与排序）。
pub fn blob_to_vector(blob: &[u8]) -> Option<Vec<f32>> {
    if blob.is_empty() || blob.len() % 4 != 0 {
        return None;
    }
    Some(
        blob.chunks_exact(4)
            .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
            .collect(),
    )
}

/// 余弦相似度（`-1..1`；维度不符/含非有限值/零向量 ⇒ `None`）。
///
/// 用 f64 累加：384 维 f32 的累加误差足以把名次排反（真机实测过模型给出的近似并列），
/// 而这一点点精度成本相对一次检索可以忽略。
pub fn cosine_similarity(a: &[f32], b: &[f32]) -> Option<f64> {
    if a.is_empty() || a.len() != b.len() {
        return None;
    }
    let mut dot = 0f64;
    let mut na = 0f64;
    let mut nb = 0f64;
    for i in 0..a.len() {
        let x = a[i] as f64;
        let y = b[i] as f64;
        if !x.is_finite() || !y.is_finite() {
            return None;
        }
        dot += x * y;
        na += x * x;
        nb += y * y;
    }
    if na == 0.0 || nb == 0.0 {
        return None;
    }
    Some(dot / (na.sqrt() * nb.sqrt()))
}

/// 解析查询向量（渲染侧发来的 JSON 数字数组）；非法 ⇒ 参数错误（fail-closed）。
fn parse_query_vector(value: Option<&Value>) -> DbResult<Vec<f32>> {
    let arr = value
        .and_then(|v| v.as_array())
        .ok_or_else(|| DbError::invalid("query_embedding", "必须是数字数组"))?;
    if arr.is_empty() {
        return Err(DbError::invalid("query_embedding", "不能为空数组"));
    }
    if arr.len() > MEMORY_EMBEDDING_DIM_MAX {
        return Err(DbError::invalid(
            "query_embedding",
            format!("维度 {} 超过上限 {MEMORY_EMBEDDING_DIM_MAX}", arr.len()),
        ));
    }
    let mut out = Vec::with_capacity(arr.len());
    for (i, item) in arr.iter().enumerate() {
        let n = item
            .as_f64()
            .ok_or_else(|| DbError::invalid("query_embedding", format!("第 {i} 项不是数字")))?;
        if !n.is_finite() {
            return Err(DbError::invalid("query_embedding", format!("第 {i} 项不是有限数")));
        }
        let f = n as f32;
        if !f.is_finite() {
            return Err(DbError::invalid("query_embedding", format!("第 {i} 项超出 f32 范围")));
        }
        out.push(f);
    }
    Ok(out)
}


/// 一条待写入的镜像行（解析后的形状；字段名与列名一一对应）。
struct MirrorRow {
    id: String,
    scope: String,
    project_id: Option<String>,
    session_id: Option<String>,
    /// 25:668：团队归属键（AgentTeam id；`scope='team'` 时必填，其余行为 NULL）
    team_id: Option<String>,
    key: String,
    content: String,
    source: Option<String>,
    status: Option<String>,
    archived: i64,
    usage_count: i64,
    last_used_at: Option<i64>,
    updated_at: i64,
}

/// `memories.replace_all`：**全量替换**镜像（内容表 + 全文表，单事务）。
///
/// 参数：`{ memories: [ { id, scope, project_id?, session_id?, team_id?, key, content, source?,
///            status?, archived?, usage_count?, last_used_at?, updated_at? }, ... ] }`
///
/// 语义：
/// - 先 `DELETE` 两张表，再逐行写入 —— 于是「删掉一条记忆」也会在镜像里消失，
///   不需要额外的 delete 命令（这也是选全量替换而不是逐条 upsert 的理由：状态机只有一处）；
/// - **幂等**：同一批行重复写两次，结果逐行相同（`DELETE` 后重建，不累积、不重复）；
/// - 空数组 = 清空镜像（合法，不是错误）；
/// - 单行形状不认识 ⇒ **整批拒绝**（事务回滚，镜像保持替换前的那一份）。
///   宁可保留旧镜像（可以重建），也不要写进半批数据（"看起来有、实际缺"的检索结果）。
pub fn replace_all(engine: &Engine, p: &Value) -> DbResult<Value> {
    let list = p
        .get("memories")
        .and_then(|v| v.as_array())
        .ok_or_else(|| DbError::missing("memories（镜像行数组）"))?;

    // 事务外先把所有行解析完：参数错误不该留下半个事务，也不该触发一次全表重建。
    let mut rows: Vec<MirrorRow> = Vec::with_capacity(list.len());
    for (i, item) in list.iter().enumerate() {
        let obj = item
            .as_object()
            .ok_or_else(|| DbError::invalid("memories", format!("第 {i} 项不是对象")))?;
        let id = obj
            .get("id")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .ok_or_else(|| DbError::invalid("memories", format!("第 {i} 项缺少非空字符串 id")))?;
        // key/content 缺省按空串处理：镜像不是权威，形状退化不该让整批镜像写不进去
        // （权威侧 `MemoryService` 已经保证 key/content 是字符串；这里只是镜像）。
        let key = obj.get("key").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let content = obj.get("content").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let scope = obj.get("scope").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let archived = match obj.get("archived") {
            Some(Value::Bool(b)) => i64::from(*b),
            Some(Value::Number(n)) => n.as_i64().unwrap_or(0),
            _ => 0,
        };
        rows.push(MirrorRow {
            id: id.to_string(),
            scope,
            project_id: obj.get("project_id").and_then(|v| v.as_str()).map(str::to_string),
            session_id: obj.get("session_id").and_then(|v| v.as_str()).map(str::to_string),
            team_id: obj.get("team_id").and_then(|v| v.as_str()).map(str::to_string),
            key,
            content,
            source: obj.get("source").and_then(|v| v.as_str()).map(str::to_string),
            status: obj.get("status").and_then(|v| v.as_str()).map(str::to_string),
            archived,
            usage_count: obj
                .get("usage_count")
                .and_then(|v| v.as_i64())
                .unwrap_or(0)
                .max(0),
            last_used_at: obj.get("last_used_at").and_then(|v| v.as_i64()),
            updated_at: obj
                .get("updated_at")
                .and_then(|v| v.as_i64())
                .unwrap_or_else(now_ms),
        });
    }

    let count = rows.len();
    let fts_rows = engine.write_tx(|tx| {
        /*
         * 24 号文 P2-C：**先把旧向量读出来**，再清表。
         *
         * 镜像的全量替换（每次记忆保存都会发生）不该抹掉已经算好的向量 ——
         * 但也不能无条件带回来：正文改过之后旧向量描述的是另一段文本，带回来就是"用旧向量
         * 给新内容打分"。判据只有一条：**key 与 content 都没变**才带回（同一段文本 ⇒ 同一向量）。
         */
        let mut previous: std::collections::HashMap<String, (String, String, Option<Vec<u8>>, Option<i64>)> =
            std::collections::HashMap::new();
        {
            let mut stmt = tx
                .prepare("SELECT id, key, content, embedding, embedding_dim FROM memories")
                .map_err(DbError::from)?;
            let old = stmt
                .query_map([], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, Option<Vec<u8>>>(3)?,
                        r.get::<_, Option<i64>>(4)?,
                    ))
                })
                .map_err(DbError::from)?;
            for row in old {
                let (id, key, content, embedding, dim) = row.map_err(DbError::from)?;
                previous.insert(id, (key, content, embedding, dim));
            }
        }
        tx.execute("DELETE FROM memories", []).map_err(DbError::from)?;
        tx.execute("DELETE FROM memories_fts", [])
            .map_err(DbError::from)?;
        let mut fts_rows = 0usize;
        for r in &rows {
            let carried = previous.get(&r.id).and_then(|(key, content, embedding, dim)| {
                if key == &r.key && content == &r.content {
                    Some((embedding.clone(), *dim))
                } else {
                    None
                }
            });
            let (embedding, embedding_dim) = carried.unwrap_or((None, None));
            tx.execute(
                "INSERT INTO memories \
                   (id, scope, project_id, session_id, team_id, key, content, source, status, archived, \
                    usage_count, last_used_at, updated_at, embedding, embedding_dim) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
                params![
                    r.id,
                    r.scope,
                    r.project_id,
                    r.session_id,
                    r.team_id,
                    r.key,
                    r.content,
                    r.source,
                    r.status,
                    r.archived,
                    r.usage_count,
                    r.last_used_at,
                    r.updated_at,
                    embedding,
                    embedding_dim,
                ],
            )
            .map_err(DbError::from)?;
            // 索引里存的是**切分后**的文本（与会话全文检索同一套规则）：
            // 查询侧只做 `query_expr`，两边由同一份实现保证对得上。
            let mem_key = crate::fts::tokenize(&r.key);
            let mem_content = crate::fts::tokenize(&r.content);
            if mem_key.is_empty() && mem_content.is_empty() {
                // 没有任何可索引内容 ⇒ 不留空行（否则会制造「命中但正文为空」的假结果）
                continue;
            }
            tx.execute(
                "INSERT INTO memories_fts (id, mem_key, mem_content) VALUES (?1, ?2, ?3)",
                params![r.id, mem_key, mem_content],
            )
            .map_err(DbError::from)?;
            fts_rows += 1;
        }
        Ok(fts_rows)
    })?;

    Ok(json!({ "written": count, "fts_rows": fts_rows, "table": "memories" }))
}

/// `memories.search`：跨作用域检索（**只读**）。
///
/// 参数：`{ query, limit?, projectId?, sessionId?, teamId? }`
///
/// - `projectId` / `sessionId` / `teamId` **至少给一个**；一个都不给 ⇒ 参数错误（fail-closed，
///   不返回任何条目）。这是「跨会话检索必须显式 opt-in」的引擎侧落点；
/// - 返回的是「platform + 指定 project + 指定 conversation + 指定 team」的并集
///   （见模块头的可见性口径）；
/// - `team` 还带一条**项目收窄**（与 `MemoryService.visibleIn` 逐条对齐）：
///   条目自己的 `project_id` 与给定的 `projectId` 必须**都为空或相等**。
///   少了这一条，团队 A 在项目 P1 写的事实会出现在项目 P2 的检索里；
/// - `limit` 被 `MEMORIES_SEARCH_MAX` 夹住，再用 `cap_by_bytes` 实施 16 MiB 字节预算
///   （与会话全文检索共用同一份实现，理由见 `repo::cap_by_bytes` 的注释）；
/// - 返回的 `score` 是 `bm25` 取负（**越大越相关**），只用于展示排序，不参与任何判定。
pub fn search(engine: &Engine, p: &Value) -> DbResult<Value> {
    let project_id = opt_text(p, "projectId")?.filter(|s| !s.is_empty());
    let session_id = opt_text(p, "sessionId")?.filter(|s| !s.is_empty());
    let team_id = opt_text(p, "teamId")?.filter(|s| !s.is_empty());
    if project_id.is_none() && session_id.is_none() && team_id.is_none() {
        return Err(DbError::invalid(
            "projectId/sessionId/teamId",
            "跨会话检索必须显式给出 projectId、sessionId 或 teamId（一个都不给 ⇒ 拒绝，避免泄漏其它项目）",
        ));
    }
    let raw_query = req_text(p, "query")?;
    // 空查询 / 全是不可索引字符：明确报参数错误，**不要**退化成"匹配全表"
    let expr = crate::fts::query_expr(&raw_query)
        .ok_or_else(|| DbError::invalid("query", "查询词为空或全是不可索引字符"))?;
    let limit = limit_of(p)?.min(MEMORIES_SEARCH_MAX);

    engine.with_conn(|conn| {
        /*
         * 过滤条件**写在 SQL 里**（而不是取回来再过滤）：
         *
         * - 这是唯一一条"可能跨项目"的读路径，过滤一旦落到调用方，就有第二个地方
         *   需要记得"别泄漏"；写在这里，`memories.search` 自己就是不可越权的；
         * - `?2 IS NOT NULL` 是给"只给会话过滤"那一半用的：没有项目过滤时，
         *   project 分支恒为假（NULL = NULL 不成立），于是只可能命中 platform / 指定会话；
         * - team 分支同理（`?4 IS NOT NULL`），并附加项目收窄：`project_id IS NULL`（团队级）
         *   或与 `?2` 相等。
         */
        let mut stmt = conn
            .prepare_cached(
                "SELECT m.id, m.scope, m.project_id, m.session_id, m.team_id, m.key, m.content, m.source, \
                        m.status, m.archived, m.usage_count, m.last_used_at, m.updated_at, \
                        bm25(memories_fts) AS bm25_score \
                   FROM memories_fts \
                   JOIN memories m ON m.id = memories_fts.id \
                  WHERE memories_fts MATCH ?1 \
                    AND m.archived = 0 \
                    AND COALESCE(m.status, '') <> 'pending' \
                    AND (m.scope = 'platform' \
                         OR (m.scope = 'project' AND ?2 IS NOT NULL AND m.project_id = ?2) \
                         OR (m.scope = 'team' AND ?4 IS NOT NULL AND m.team_id = ?4 \
                             AND COALESCE(m.project_id, '') = COALESCE(?2, '')) \
                         OR (m.scope = 'conversation' AND ?3 IS NOT NULL AND m.session_id = ?3)) \
                  ORDER BY bm25_score ASC, m.updated_at DESC \
                  LIMIT ?5",
            )
            .map_err(DbError::from)?;
        // 多取一行判 `has_more`（与 repo 的分页语义一致）
        let rows = stmt
            .query_map(
                params![expr, project_id, session_id, team_id, (limit + 1) as i64],
                |r| {
                    Ok(json!({
                        "id": r.get::<_, String>(0)?,
                        "scope": r.get::<_, String>(1)?,
                        "project_id": r.get::<_, Option<String>>(2)?,
                        "session_id": r.get::<_, Option<String>>(3)?,
                        "team_id": r.get::<_, Option<String>>(4)?,
                        "key": r.get::<_, String>(5)?,
                        "content": r.get::<_, String>(6)?,
                        "source": r.get::<_, Option<String>>(7)?,
                        "status": r.get::<_, Option<String>>(8)?,
                        "archived": r.get::<_, i64>(9)?,
                        "usage_count": r.get::<_, i64>(10)?,
                        "last_used_at": r.get::<_, Option<i64>>(11)?,
                        "updated_at": r.get::<_, i64>(12)?,
                        // bm25 越小越相关（FTS5 的约定）⇒ 取负后越大越相关，便于展示
                        "score": -r.get::<_, f64>(13)?,
                    }))
                },
            )
            .map_err(DbError::from)?;
        let mut items: Vec<Value> = Vec::new();
        for row in rows {
            items.push(row.map_err(DbError::from)?);
        }
        let mut has_more = items.len() > limit;
        if has_more {
            items.truncate(limit);
        }
        if cap_by_bytes(&mut items) {
            has_more = true;
        }
        Ok(json!({ "items": items, "has_more": has_more, "next_cursor": Value::Null }))
    })
}

// ========== 向量持久化 / 检索（24 号文 P2-C）==========

/// `memories.upsert_embeddings`：按 id 写向量（**单事务**）。
///
/// 参数：`{ embeddings: [ { id, vector: [number, ...] }, ... ] }`
///
/// 语义（每一条都必须能单独解释）：
/// - **先整批校验、再单事务写入**：任何一行形状不对（空 id / 空向量 / 维度超上限 /
///   非有限数 / 超出 f32 范围）⇒ **整批拒绝、一行都不写**。半批向量比没有更糟：
///   检索会按"谁碰巧写进去了"排序，而调用方以为全写成功了；
/// - **id 不存在 ⇒ 跳过并计数**（`skipped`），不整批失败：镜像允许滞后
///   （渲染侧的向量写入是后台任务，记忆条目可能还没镜像过去），下一次保存会自然重试；
/// - 空数组是合法的（`written=0`），不写任何行；
/// - `embedding_dim` 单独存列：检索侧按维度过滤，避免两个向量空间的余弦混算。
pub fn upsert_embeddings(engine: &Engine, p: &Value) -> DbResult<Value> {
    let list = p
        .get("embeddings")
        .and_then(|v| v.as_array())
        .ok_or_else(|| DbError::missing("embeddings（向量数组）"))?;

    let mut pending: Vec<(String, Vec<f32>)> = Vec::with_capacity(list.len());
    for (i, item) in list.iter().enumerate() {
        let obj = item
            .as_object()
            .ok_or_else(|| DbError::invalid("embeddings", format!("第 {i} 项不是对象")))?;
        let id = obj
            .get("id")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .ok_or_else(|| DbError::invalid("embeddings", format!("第 {i} 项缺少非空字符串 id")))?;
        let raw = obj
            .get("vector")
            .and_then(|v| v.as_array())
            .ok_or_else(|| DbError::invalid("embeddings", format!("第 {i} 项缺少 vector 数组")))?;
        if raw.is_empty() {
            return Err(DbError::invalid("embeddings", format!("第 {i} 项的 vector 为空")));
        }
        if raw.len() > MEMORY_EMBEDDING_DIM_MAX {
            return Err(DbError::invalid(
                "embeddings",
                format!("第 {i} 项维度 {} 超过上限 {MEMORY_EMBEDDING_DIM_MAX}", raw.len()),
            ));
        }
        let mut vector = Vec::with_capacity(raw.len());
        for (j, n) in raw.iter().enumerate() {
            let value = n
                .as_f64()
                .ok_or_else(|| DbError::invalid("embeddings", format!("第 {i} 项第 {j} 维不是数字")))?;
            if !value.is_finite() {
                return Err(DbError::invalid("embeddings", format!("第 {i} 项第 {j} 维不是有限数")));
            }
            let narrowed = value as f32;
            if !narrowed.is_finite() {
                return Err(DbError::invalid("embeddings", format!("第 {i} 项第 {j} 维超出 f32 范围")));
            }
            vector.push(narrowed);
        }
        pending.push((id.to_string(), vector));
    }

    if pending.is_empty() {
        return Ok(json!({ "written": 0, "skipped": 0, "table": "memories" }));
    }

    let (written, skipped) = engine.write_tx(|tx| {
        let mut written = 0i64;
        let mut skipped = 0i64;
        for (id, vector) in &pending {
            let blob = vector_to_blob(vector);
            let dim = vector.len() as i64;
            let n = tx
                .execute(
                    "UPDATE memories SET embedding = ?1, embedding_dim = ?2 WHERE id = ?3",
                    params![blob, dim, id],
                )
                .map_err(DbError::from)?;
            if n == 0 {
                skipped += 1;
            } else {
                written += n as i64;
            }
        }
        Ok((written, skipped))
    })?;

    Ok(json!({ "written": written, "skipped": skipped, "table": "memories" }))
}

/// `memories.vector_search`：余弦检索（**只读**）。
///
/// 参数：`{ query_embedding: [number, ...], limit?, projectId?, sessionId?, teamId? }`
///
/// - `projectId` / `sessionId` / `teamId` **至少给一个**（与 `memories.search` 同一条 fail-closed：
///   少一个过滤条件就多一条跨项目的读面）；
/// - 过滤**写在 SQL 里**：`archived=0`、`status<>'pending'`、scope 并集、`embedding_dim` 必须
///   等于查询维度、`embedding IS NOT NULL`；team 与 `memories.search` 同一条项目收窄。
///   过滤一旦落到调用方，就会多出第二处需要记得"别泄漏"的地方（这是本模块唯一一条可能跨项目的读路径）；
/// - 余弦用 f64 累加；维度不符/零向量/非有限值 ⇒ 该行**跳过**（不当成 0 分参与排序）；
/// - `limit` 被 `MEMORIES_SEARCH_MAX` 夹住，再用 `cap_by_bytes` 实施字节预算；
/// - `score` = 余弦（**越大越相关**），与 `memories.search` 的"越大越相关"方向一致。
pub fn vector_search(engine: &Engine, p: &Value) -> DbResult<Value> {
    let project_id = opt_text(p, "projectId")?.filter(|s| !s.is_empty());
    let session_id = opt_text(p, "sessionId")?.filter(|s| !s.is_empty());
    let team_id = opt_text(p, "teamId")?.filter(|s| !s.is_empty());
    if project_id.is_none() && session_id.is_none() && team_id.is_none() {
        return Err(DbError::invalid(
            "projectId/sessionId/teamId",
            "跨会话检索必须显式给出 projectId、sessionId 或 teamId（一个都不给 ⇒ 拒绝，避免泄漏其它项目）",
        ));
    }
    let query = parse_query_vector(p.get("query_embedding"))?;
    let limit = limit_of(p)?.min(MEMORIES_SEARCH_MAX);
    let dim = query.len() as i64;

    engine.with_conn(|conn| {
        let mut stmt = conn
            .prepare_cached(
                "SELECT id, scope, project_id, session_id, team_id, key, content, source, status, \
                        archived, usage_count, last_used_at, updated_at, embedding \
                   FROM memories \
                  WHERE archived = 0 \
                    AND COALESCE(status, '') <> 'pending' \
                    AND embedding IS NOT NULL \
                    AND embedding_dim = ?3 \
                    AND (scope = 'platform' \
                         OR (scope = 'project' AND ?1 IS NOT NULL AND project_id = ?1) \
                         OR (scope = 'team' AND ?4 IS NOT NULL AND team_id = ?4 \
                             AND COALESCE(project_id, '') = COALESCE(?1, '')) \
                         OR (scope = 'conversation' AND ?2 IS NOT NULL AND session_id = ?2))",
            )
            .map_err(DbError::from)?;
        let rows = stmt
            .query_map(params![project_id, session_id, dim, team_id], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Option<String>>(2)?,
                    r.get::<_, Option<String>>(3)?,
                    r.get::<_, Option<String>>(4)?,
                    r.get::<_, String>(5)?,
                    r.get::<_, String>(6)?,
                    r.get::<_, Option<String>>(7)?,
                    r.get::<_, Option<String>>(8)?,
                    r.get::<_, i64>(9)?,
                    r.get::<_, i64>(10)?,
                    r.get::<_, Option<i64>>(11)?,
                    r.get::<_, i64>(12)?,
                    r.get::<_, Vec<u8>>(13)?,
                ))
            })
            .map_err(DbError::from)?;
        let mut scored: Vec<(f64, Value)> = Vec::new();
        for row in rows {
            let (id, scope, project_id, session_id, team_id, key, content, source, status, archived, usage_count, last_used_at, updated_at, blob) =
                row.map_err(DbError::from)?;
            let Some(candidate) = blob_to_vector(&blob) else {
                // 坏 BLOB（长度不是 4 的倍数）：跳过 —— 它在库里的形态已经不是我们能解释的
                continue;
            };
            let Some(score) = cosine_similarity(&query, &candidate) else {
                continue;
            };
            scored.push((
                score,
                json!({
                    "id": id,
                    "scope": scope,
                    "project_id": project_id,
                    "session_id": session_id,
                    "team_id": team_id,
                    "key": key,
                    "content": content,
                    "source": source,
                    "status": status,
                    "archived": archived,
                    "usage_count": usage_count,
                    "last_used_at": last_used_at,
                    "updated_at": updated_at,
                    "score": score,
                }),
            ));
        }
        // 稳定排序：分数降序，同分按 id 升序（同一份库在任何一次调用里顺序一致）
        scored.sort_by(|a, b| {
            b.0.partial_cmp(&a.0)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| {
                    let ai = a.1.get("id").and_then(|v| v.as_str()).unwrap_or("");
                    let bi = b.1.get("id").and_then(|v| v.as_str()).unwrap_or("");
                    ai.cmp(bi)
                })
        });
        let mut items: Vec<Value> = scored.into_iter().map(|(_, item)| item).collect();
        let mut has_more = items.len() > limit;
        if has_more {
            items.truncate(limit);
        }
        if cap_by_bytes(&mut items) {
            has_more = true;
        }
        Ok(json!({ "items": items, "has_more": has_more, "next_cursor": Value::Null }))
    })
}
