//! 项目级文档索引库（独立 SQLite，**可重建**）—— 见 `docs/architecture/ADR-0008-PROJECT-DOCUMENT-INDEX.md`
//!
//! ## 为什么是「另一个库」而不是主库里的几张表
//!
//! 1GB 文档的索引可达 GB 级。塞进会话主库会拖慢 `VACUUM` / `wal_checkpoint` /
//! 损坏恢复 / 备份 —— 而这些是**用户数据**的路径；文档索引则是**缓存**：
//! 权威是 `<dataRoot>/documents/blobs/<sha256>` 与 `text/<sha256>.txt`，
//! 索引库删掉可以后台重建。两者生命周期不同，不该共用一份 SQLite 文件。
//!
//! ## 与主库共享什么
//!
//! - 同一套 `DbError`/`DbResult`；
//! - 同一套中文切分（[`crate::fts::tokenize`] / [`crate::fts::query_expr`]）——
//!   会话搜索与文档搜索对「存储迁移」这类查询必须表现一致；
//! - 同一条 IPC 通道（`storage_invoke` 的命令白名单），所以 `check-command-parity` 继续有效。
//!
//! ## 正文不存这里
//!
//! `document_chunks` 只存 `text_offset/text_len/preview`。全文在侧车文件里，
//! 由 `documents.read` 按 offset seek —— 1GB 文本存两遍（正文 + FTS token）等于自找磁盘灾难。

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

use crate::error::{DbError, DbResult};

/// 索引库 schema 版本（`PRAGMA user_version`）。改 schema 必须 +1 并提供迁移。
pub const DOCS_SCHEMA_VERSION: i64 = 4;

/// 索引库建表语句（`documents.sql`）。
pub const DOCS_SCHEMA_SQL: &str = include_str!("../sql/documents.sql");

/// FTS5 虚拟表：只存**切分后的 token**，不复制原文。
///
/// `document_id` / `chunk_no` 作为 UNINDEXED 列，避免另外建映射表。
const DOCS_FTS_SQL: &str = "CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(\
     tokenized_text, document_id UNINDEXED, chunk_no UNINDEXED, tokenize='unicode61')";

/// 一次 `documents.search` 最多返回多少条（工具层还有 token 预算，这里是协议上限）。
pub const DOCS_SEARCH_MAX: i64 = 64;

/// 单次批量写入最多多少块（防止一次 IPC 传几十兆）。
pub const DOCS_WRITE_BATCH_MAX: usize = 4096;

/// FTS 行号：`document_id + chunk_no` 的稳定 64 位哈希（FNV-1a）。
///
/// 为什么不用自动 rowid：`documents_fts` 的 `document_id` 是 **UNINDEXED**，
/// 按它删除会退化成整表扫描；逐块这么删就是 O(n²)（DOCI-B1 基准实测：
/// 16MB 文本要 111 秒，1GB 根本跑不完）。用稳定 rowid 后覆盖写变成一次 rowid 查找。
///
/// 冲突概率：本地单机文档集合下 64 位（清空符号位）FNV 碰撞可以忽略；
/// 真撞上会覆盖另一块的 FTS 行 ⇒ 该块搜不到（正文与 `document_chunks` 仍完好，可 `documents_rebuild` 修复）。
fn fts_rowid(document_id: &str, chunk_no: i64) -> i64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in document_id.as_bytes() {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    for b in chunk_no.to_le_bytes() {
        h ^= u64::from(b);
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    (h & 0x7fff_ffff_ffff_ffff) as i64
}

fn now_ms() -> i64 {    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn req_text(p: &Value, key: &str) -> DbResult<String> {
    p.get(key)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| DbError::missing(key))
}

fn opt_text(p: &Value, key: &str) -> DbResult<Option<String>> {
    match p.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Ok(Some(s.clone())),
        Some(_) => Err(DbError::invalid(key, "必须是字符串")),
    }
}

fn opt_i64(p: &Value, key: &str) -> DbResult<Option<i64>> {
    match p.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(n)) => n
            .as_i64()
            .map(Some)
            .ok_or_else(|| DbError::invalid(key, "必须是整数")),
        Some(_) => Err(DbError::invalid(key, "必须是整数")),
    }
}

fn limit_of(p: &Value, default: i64, max: i64) -> DbResult<i64> {
    let n = opt_i64(p, "limit")?.unwrap_or(default);
    Ok(n.clamp(1, max))
}

fn offset_of(p: &Value) -> DbResult<i64> {
    Ok(opt_i64(p, "offset")?.unwrap_or(0).max(0))
}

/// 文档主键：同一 `(collection_id, dedupe_key)` 复用已存在的 id（见 `upsert_document`）。
///
/// 刻意**不引入 uuid 依赖**：id 只是本地主键，由 `collection + dedupe_key + 创建毫秒`
/// 做一次稳定哈希，跨进程一致；真正的唯一性由 `UNIQUE(collection_id, dedupe_key)` 保证。
///
/// ⚠️ `collection_id` **必须参与哈希**：同一份 blob 可以属于多个项目集合（各一行），
/// 只用 `dedupe_key + 毫秒` 会让两个集合在同一毫秒内拿到同一个 id ⇒ `UNIQUE(documents.id)` 冲突
/// （判据 `upsert_is_idempotent_per_collection_and_key` 抓到过）。
fn new_document_id(collection_id: &str, dedupe_key: &str, created_ms: i64) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut h = DefaultHasher::new();
    collection_id.hash(&mut h);
    dedupe_key.hash(&mut h);
    created_ms.hash(&mut h);
    format!("doc_{:016x}", h.finish())
}

/// 单文件索引库的句柄（单写者：内部一把互斥锁包住连接）。
pub struct DocsEngine {
    conn: Mutex<Connection>,
    path: PathBuf,
}

impl DocsEngine {
    /// 打开（不存在则创建）索引库，并应用 schema。
    pub fn open(path: impl AsRef<Path>) -> DbResult<Self> {
        let path = path.as_ref().to_path_buf();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                DbError::other(format!("创建文档索引目录失败 {}: {e}", parent.display()))
            })?;
        }
        let conn = Connection::open(&path).map_err(DbError::from)?;
        Self::configure(&conn)?;
        Self::apply(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
            path,
        })
    }

    /// 只读/内存形态（判据用）。
    pub fn open_in_memory() -> DbResult<Self> {
        let conn = Connection::open_in_memory().map_err(DbError::from)?;
        Self::configure(&conn)?;
        Self::apply(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
            path: PathBuf::from(":memory:"),
        })
    }

    fn configure(conn: &Connection) -> DbResult<()> {
        // 与主库同一组 PRAGMA 取值（WAL + NORMAL + busy_timeout），
        // 差异只在 `auto_vacuum`：索引可重建，不做增量回收。
        let pragmas = [
            "PRAGMA journal_mode=WAL",
            "PRAGMA synchronous=NORMAL",
            "PRAGMA busy_timeout=5000",
            "PRAGMA foreign_keys=ON",
            "PRAGMA temp_store=MEMORY",
        ];
        for p in pragmas {
            conn.execute_batch(p).map_err(DbError::from)?;
        }
        Ok(())
    }

    fn apply(conn: &Connection) -> DbResult<()> {
        conn.execute_batch(DOCS_SCHEMA_SQL).map_err(DbError::from)?;
        conn.execute_batch(DOCS_FTS_SQL).map_err(DbError::from)?;
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .map_err(DbError::from)?;
        // v3：IVF-Flat 的 cluster_id。新库由 schema 直接带该列；老库补一次 ALTER。
        if version < 3 {
            let has_cluster: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM pragma_table_info('document_vectors') WHERE name='cluster_id'",
                    [],
                    |r| r.get(0),
                )
                .unwrap_or(0);
            if has_cluster == 0 {
                conn.execute_batch("ALTER TABLE document_vectors ADD COLUMN cluster_id INTEGER")
                    .map_err(DbError::from)?;
            }
        }
        // v4：int8 标量量化（qvector + qscale）。
        // v4：int8 标量量化（qvector + qscale）。老库补列；训练/upsert 会回填。
        if version < 4 {
            for col in ["qvector BLOB", "qscale REAL"] {
                let name = col.split(' ').next().unwrap();
                let has: i64 = conn
                    .query_row(
                        &format!("SELECT COUNT(*) FROM pragma_table_info('document_vectors') WHERE name='{name}'"),
                        [],
                        |r| r.get(0),
                    )
                    .unwrap_or(0);
                if has == 0 {
                    conn.execute_batch(&format!("ALTER TABLE document_vectors ADD COLUMN {col}"))
                        .map_err(DbError::from)?;
                }
            }
        }
        // 索引必须等 ALTER 之后建：v2 老库在 CREATE INDEX 时还没有 cluster_id。
        conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_document_vectors_cluster ON document_vectors(cluster_id)",
        )
        .map_err(DbError::from)?;
        if version < DOCS_SCHEMA_VERSION {
            conn.execute_batch(&format!("PRAGMA user_version={DOCS_SCHEMA_VERSION}"))
                .map_err(DbError::from)?;
        }
        Ok(())
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn with_conn<T>(&self, f: impl FnOnce(&Connection) -> DbResult<T>) -> DbResult<T> {
        let guard = self
            .conn
            .lock()
            .map_err(|_| DbError::other("文档索引库互斥锁已中毒"))?;
        f(&guard)
    }

    pub fn write_tx<T>(&self, f: impl FnOnce(&rusqlite::Transaction<'_>) -> DbResult<T>) -> DbResult<T> {
        let mut guard = self
            .conn
            .lock()
            .map_err(|_| DbError::other("文档索引库互斥锁已中毒"))?;
        let tx = guard.transaction().map_err(DbError::from)?;
        let out = f(&tx)?;
        tx.commit().map_err(DbError::from)?;
        Ok(out)
    }
}

/// 命令分发：与主库 `lib::dispatch` 同形（`storage_invoke` 传入命令名 + params）。
pub fn invoke(engine: &DocsEngine, command: &str, params: &Value) -> DbResult<Value> {
    match command {
        "documents.upsert_document" => upsert_document(engine, params),
        "documents.get" => get_document(engine, params),
        "documents.list" => list_documents(engine, params),
        "documents.update_status" => update_status(engine, params),
        "documents.write_batch" => write_batch(engine, params),
        "documents.search" => search(engine, params),
        "documents.outline" => outline(engine, params),
        "documents.chunks" => read_chunks(engine, params),
        "documents.pages" => read_pages(engine, params),
        "documents.delete" => delete_document(engine, params),
        "documents.stats" => stats(engine, params),
        "documents.reset" => reset(engine, params),
        "documents.vector_upsert" => vector_upsert(engine, params),
        "documents.vector_train" => vector_train(engine, params),
        "documents.vector_search" => vector_search(engine, params),
        "documents.vector_status" => vector_status(engine, params),
        "documents.health" => health(engine),
        other => Err(DbError::unsupported(format!("未知的文档索引命令：{other}"))),
    }
}

/// 登记或复用一条文档记录。
///
/// 返回 `{id, created}`：`created=false` 表示命中 `(collection_id, dedupe_key)`，**没有**重复解析。
pub fn upsert_document(engine: &DocsEngine, p: &Value) -> DbResult<Value> {
    let collection_id = req_text(p, "collection_id")?;
    let kind = req_text(p, "kind")?;
    let dedupe_key = req_text(p, "dedupe_key")?;
    let source_ref = opt_text(p, "source_ref")?;
    let name = opt_text(p, "name")?;
    let mime = opt_text(p, "mime")?;
    let size = opt_i64(p, "size")?.unwrap_or(0);
    let sha256 = opt_text(p, "sha256")?;
    let mtime = opt_i64(p, "mtime")?;
    let status = opt_text(p, "status")?.unwrap_or_else(|| "pending".to_string());
    let extractor_version = opt_i64(p, "extractor_version")?.unwrap_or(0);
    let metadata_json = p
        .get("metadata")
        .filter(|v| !v.is_null())
        .map(|v| v.to_string());
    let ts = now_ms();

    engine.write_tx(|tx| {
        let existing: Option<String> = tx
            .query_row(
                "SELECT id FROM documents WHERE collection_id=?1 AND dedupe_key=?2",
                params![collection_id, dedupe_key],
                |r| r.get(0),
            )
            .ok();
        if let Some(id) = existing {
            /*
             * 同一路径/去重键下 **sha 变了** = 换了内容：
             * 旧的块/页/FTS/检查点必须整体清掉，否则续跑会拿旧检查点套新文件，
             * 或留下「新文件里已经不存在的旧块」。同 sha 重跑则保留（检查点续跑）。
             */
            let old_sha: Option<String> = tx
                .query_row(
                    "SELECT sha256 FROM documents WHERE id=?1",
                    params![id],
                    |r| r.get(0),
                )
                .optional()
                .map_err(DbError::from)?
                .flatten();
            let sha_changed = match (&old_sha, &sha256) {
                (Some(a), Some(b)) => a != b,
                _ => false,
            };
            if sha_changed {
                for sql in [
                    "DELETE FROM documents_fts WHERE document_id=?1",
                    "DELETE FROM document_chunks WHERE document_id=?1",
                    "DELETE FROM document_blocks WHERE document_id=?1",
                    "DELETE FROM document_pages WHERE document_id=?1",
                    "DELETE FROM document_vectors WHERE document_id=?1",
                    "DELETE FROM document_ingest_state WHERE document_id=?1",
                ] {
                    tx.execute(sql, params![id]).map_err(DbError::from)?;
                }
                tx.execute(
                    "UPDATE documents SET page_count=0, block_count=0, chunk_count=0, \
                     text_bytes=0, outline_json=NULL, error=NULL WHERE id=?1",
                    params![id],
                )
                .map_err(DbError::from)?;
            }
            tx.execute(
                "UPDATE documents SET name=COALESCE(?2,name), mime=COALESCE(?3,mime), \
                 size=CASE WHEN ?4 > 0 THEN ?4 ELSE size END, sha256=COALESCE(?5,sha256), \
                 mtime=COALESCE(?6,mtime), source_ref=COALESCE(?7,source_ref), \
                 status=?8, extractor_version=CASE WHEN ?9 > 0 THEN ?9 ELSE extractor_version END, \
                 metadata_json=COALESCE(?10,metadata_json), updated_at=?11 WHERE id=?1",
                params![
                    id,
                    name,
                    mime,
                    size,
                    sha256,
                    mtime,
                    source_ref,
                    status,
                    extractor_version,
                    metadata_json,
                    ts
                ],
            )
            .map_err(DbError::from)?;
            return Ok(json!({ "id": id, "created": false }));
        }
        let id = new_document_id(&collection_id, &dedupe_key, ts);
        tx.execute(
            "INSERT INTO documents(id, collection_id, kind, source_ref, dedupe_key, name, mime, \
             size, sha256, mtime, status, extractor_version, metadata_json, created_at, updated_at) \
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?14)",
            params![
                id,
                collection_id,
                kind,
                source_ref,
                dedupe_key,
                name,
                mime,
                size,
                sha256,
                mtime,
                status,
                extractor_version,
                metadata_json,
                ts
            ],
        )
        .map_err(DbError::from)?;
        Ok(json!({ "id": id, "created": true }))
    })
}

pub fn get_document(engine: &DocsEngine, p: &Value) -> DbResult<Value> {
    let id = req_text(p, "id")?;
    engine.with_conn(|conn| {
        let row = conn
            .query_row(
                "SELECT id, collection_id, kind, source_ref, dedupe_key, name, mime, size, sha256, \
                 mtime, page_count, block_count, chunk_count, text_bytes, status, error, \
                 outline_json, extractor_version, metadata_json, created_at, updated_at \
                 FROM documents WHERE id=?1",
                params![id],
                document_row,
            )
            .map_err(DbError::from)?;
        Ok(row)
    })
}

fn document_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    Ok(json!({
        "id": r.get::<_, String>(0)?,
        "collection_id": r.get::<_, String>(1)?,
        "kind": r.get::<_, String>(2)?,
        "source_ref": r.get::<_, Option<String>>(3)?,
        "dedupe_key": r.get::<_, String>(4)?,
        "name": r.get::<_, Option<String>>(5)?,
        "mime": r.get::<_, Option<String>>(6)?,
        "size": r.get::<_, i64>(7)?,
        "sha256": r.get::<_, Option<String>>(8)?,
        "mtime": r.get::<_, Option<i64>>(9)?,
        "page_count": r.get::<_, i64>(10)?,
        "block_count": r.get::<_, i64>(11)?,
        "chunk_count": r.get::<_, i64>(12)?,
        "text_bytes": r.get::<_, i64>(13)?,
        "status": r.get::<_, String>(14)?,
        "error": r.get::<_, Option<String>>(15)?,
        "outline_json": r.get::<_, Option<String>>(16)?,
        "extractor_version": r.get::<_, i64>(17)?,
        "metadata_json": r.get::<_, Option<String>>(18)?,
        "created_at": r.get::<_, i64>(19)?,
        "updated_at": r.get::<_, i64>(20)?,
    }))
}

pub fn list_documents(engine: &DocsEngine, p: &Value) -> DbResult<Value> {
    let collection_id = opt_text(p, "collection_id")?;
    let status = opt_text(p, "status")?;
    let limit = limit_of(p, 50, 500)?;
    let offset = offset_of(p)?;
    engine.with_conn(|conn| {
        let mut sql = String::from(
            "SELECT id, collection_id, kind, source_ref, dedupe_key, name, mime, size, sha256, \
             mtime, page_count, block_count, chunk_count, text_bytes, status, error, \
             outline_json, extractor_version, metadata_json, created_at, updated_at \
             FROM documents WHERE 1=1",
        );
        let mut vals: Vec<rusqlite::types::Value> = Vec::new();
        if let Some(c) = &collection_id {
            vals.push(rusqlite::types::Value::Text(c.clone()));
            sql.push_str(&format!(" AND collection_id=?{}", vals.len()));
        }
        if let Some(s) = &status {
            vals.push(rusqlite::types::Value::Text(s.clone()));
            sql.push_str(&format!(" AND status=?{}", vals.len()));
        }
        sql.push_str(" ORDER BY updated_at DESC");
        vals.push(rusqlite::types::Value::Integer(limit + 1));
        sql.push_str(&format!(" LIMIT ?{}", vals.len()));
        vals.push(rusqlite::types::Value::Integer(offset));
        sql.push_str(&format!(" OFFSET ?{}", vals.len()));

        let mut stmt = conn.prepare(&sql).map_err(DbError::from)?;
        let rows = stmt
            .query_map(rusqlite::params_from_iter(vals.iter()), document_row)
            .map_err(DbError::from)?;
        let mut items = Vec::new();
        for r in rows {
            items.push(r.map_err(DbError::from)?);
        }
        let has_more = items.len() as i64 > limit;
        if has_more {
            items.truncate(limit as usize);
        }
        Ok(json!({ "items": items, "has_more": has_more }))
    })
}

pub fn update_status(engine: &DocsEngine, p: &Value) -> DbResult<Value> {
    let id = req_text(p, "id")?;
    let status = req_text(p, "status")?;
    let error = opt_text(p, "error")?;
    let outline_json = p
        .get("outline")
        .filter(|v| !v.is_null())
        .map(|v| v.to_string());
    let counts = (
        opt_i64(p, "page_count")?,
        opt_i64(p, "block_count")?,
        opt_i64(p, "chunk_count")?,
        opt_i64(p, "text_bytes")?,
    );
    let ts = now_ms();
    engine.write_tx(|tx| {
        tx.execute(
            "UPDATE documents SET status=?2, error=?3, \
             outline_json=COALESCE(?4, outline_json), \
             page_count=CASE WHEN ?5 >= 0 THEN ?5 ELSE page_count END, \
             block_count=CASE WHEN ?6 >= 0 THEN ?6 ELSE block_count END, \
             chunk_count=CASE WHEN ?7 >= 0 THEN ?7 ELSE chunk_count END, \
             text_bytes=CASE WHEN ?8 >= 0 THEN ?8 ELSE text_bytes END, \
             updated_at=?9 WHERE id=?1",
            params![
                id,
                status,
                error,
                outline_json,
                counts.0.unwrap_or(-1),
                counts.1.unwrap_or(-1),
                counts.2.unwrap_or(-1),
                counts.3.unwrap_or(-1),
                ts
            ],
        )
        .map_err(DbError::from)?;
        Ok(json!({ "ok": true }))
    })
}

/// 批量写入页 / 块 / 分块（一个事务）。
///
/// 分块会同时写入 FTS5（token 化后的文本），并**先删同号旧行**保证幂等
/// （重复摄取 / 断点续跑不会产生重复命中）。
pub fn write_batch(engine: &DocsEngine, p: &Value) -> DbResult<Value> {
    let document_id = req_text(p, "document_id")?;
    let pages = p
        .get("pages")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let blocks = p
        .get("blocks")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let chunks = p
        .get("chunks")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    if chunks.len() > DOCS_WRITE_BATCH_MAX {
        return Err(DbError::invalid(
            "chunks",
            format!("单次最多 {DOCS_WRITE_BATCH_MAX} 个分块"),
        ));
    }
    let state = p.get("state").filter(|v| !v.is_null()).cloned();
    let ts = now_ms();

    engine.write_tx(|tx| {
        for page in &pages {
            let page_no = opt_i64(page, "page_no")?.ok_or_else(|| DbError::missing("page_no"))?;
            tx.execute(
                "INSERT INTO document_pages(document_id, page_no, kind, text_source, text_bytes, \
                 ocr_state, ocr_model, image_path, updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9) \
                 ON CONFLICT(document_id, page_no) DO UPDATE SET kind=excluded.kind, \
                 text_source=excluded.text_source, text_bytes=excluded.text_bytes, \
                 ocr_state=excluded.ocr_state, ocr_model=excluded.ocr_model, \
                 image_path=excluded.image_path, updated_at=excluded.updated_at",
                params![
                    document_id,
                    page_no,
                    opt_text(page, "kind")?,
                    opt_text(page, "text_source")?,
                    opt_i64(page, "text_bytes")?.unwrap_or(0),
                    opt_text(page, "ocr_state")?,
                    opt_text(page, "ocr_model")?,
                    opt_text(page, "image_path")?,
                    ts
                ],
            )
            .map_err(DbError::from)?;
        }

        for block in &blocks {
            let block_no =
                opt_i64(block, "block_no")?.ok_or_else(|| DbError::missing("block_no"))?;
            tx.execute(
                "INSERT INTO document_blocks(document_id, block_no, page_no, kind, heading_path, \
                 text_offset, text_len) VALUES (?1,?2,?3,?4,?5,?6,?7) \
                 ON CONFLICT(document_id, block_no) DO UPDATE SET page_no=excluded.page_no, \
                 kind=excluded.kind, heading_path=excluded.heading_path, \
                 text_offset=excluded.text_offset, text_len=excluded.text_len",
                params![
                    document_id,
                    block_no,
                    opt_i64(block, "page_no")?.unwrap_or(0),
                    opt_text(block, "kind")?.unwrap_or_else(|| "paragraph".to_string()),
                    opt_text(block, "heading_path")?,
                    opt_i64(block, "text_offset")?.unwrap_or(0),
                    opt_i64(block, "text_len")?.unwrap_or(0)
                ],
            )
            .map_err(DbError::from)?;
        }

        let mut fts_written = 0usize;
        /*
         * 重新摄取同一文档时，旧 FTS 行可能来自「按 rowid 之前的实现」或是上一次运行的残留。
         * 只在看到 `chunk_no == 0`（每份文档的第一块）时做一次整文档清理 —— 这是 O(n) 的扫描，
         * 但每份文档只发生一次；**不能再逐块**按 `document_id` 删（UNINDEXED 列 ⇒ 每块整表扫描
         * ⇒ 大文件 O(n²)，DOCI-B1 基准实测 16MB 就要 111 秒）。
         */
        if chunks
            .iter()
            .any(|c| opt_i64(c, "chunk_no").ok().flatten() == Some(0))
        {
            tx.execute(
                "DELETE FROM documents_fts WHERE document_id=?1",
                params![document_id],
            )
            .map_err(DbError::from)?;
        }
        for chunk in &chunks {
            let chunk_no =
                opt_i64(chunk, "chunk_no")?.ok_or_else(|| DbError::missing("chunk_no"))?;
            tx.execute(
                "INSERT INTO document_chunks(document_id, chunk_no, page_from, page_to, heading_path, \
                 text_offset, text_len, token_count, preview) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9) \
                 ON CONFLICT(document_id, chunk_no) DO UPDATE SET page_from=excluded.page_from, \
                 page_to=excluded.page_to, heading_path=excluded.heading_path, \
                 text_offset=excluded.text_offset, text_len=excluded.text_len, \
                 token_count=excluded.token_count, preview=excluded.preview",
                params![
                    document_id,
                    chunk_no,
                    opt_i64(chunk, "page_from")?.unwrap_or(0),
                    opt_i64(chunk, "page_to")?.unwrap_or(0),
                    opt_text(chunk, "heading_path")?,
                    opt_i64(chunk, "text_offset")?.unwrap_or(0),
                    opt_i64(chunk, "text_len")?.unwrap_or(0),
                    opt_i64(chunk, "token_count")?.unwrap_or(0),
                    opt_text(chunk, "preview")?
                ],
            )
            .map_err(DbError::from)?;

            // FTS：按**稳定 rowid** 删除同号旧行（幂等），再写 token 化文本。
            let rowid = fts_rowid(&document_id, chunk_no);
            tx.execute(
                "DELETE FROM documents_fts WHERE rowid=?1",
                params![rowid],
            )
            .map_err(DbError::from)?;
            let text = opt_text(chunk, "text")?.unwrap_or_default();
            if !text.trim().is_empty() {
                let tokenized = crate::fts::tokenize(&text);
                if !tokenized.trim().is_empty() {
                    tx.execute(
                        "INSERT INTO documents_fts(rowid, tokenized_text, document_id, chunk_no) \
                         VALUES (?1,?2,?3,?4)",
                        params![rowid, tokenized, document_id, chunk_no],
                    )
                    .map_err(DbError::from)?;
                    fts_written += 1;
                }
            }
        }

        if let Some(state) = &state {
            let phase = opt_text(state, "phase")?.unwrap_or_else(|| "extract".to_string());
            tx.execute(
                "INSERT INTO document_ingest_state(document_id, phase, bytes_done, pages_done, \
                 chunks_done, updated_at) VALUES (?1,?2,?3,?4,?5,?6) \
                 ON CONFLICT(document_id) DO UPDATE SET phase=excluded.phase, \
                 bytes_done=excluded.bytes_done, pages_done=excluded.pages_done, \
                 chunks_done=excluded.chunks_done, updated_at=excluded.updated_at",
                params![
                    document_id,
                    phase,
                    opt_i64(state, "bytes_done")?.unwrap_or(0),
                    opt_i64(state, "pages_done")?.unwrap_or(0),
                    opt_i64(state, "chunks_done")?.unwrap_or(0),
                    ts
                ],
            )
            .map_err(DbError::from)?;
        }

        Ok(json!({
            "pages": pages.len(),
            "blocks": blocks.len(),
            "chunks": chunks.len(),
            "fts": fts_written,
        }))
    })
}

/// BM25 检索。返回 `score` 已取反而**越大越相关**（SQLite 的 `bm25()` 是越小越好）。
pub fn search(engine: &DocsEngine, p: &Value) -> DbResult<Value> {
    let raw = req_text(p, "query")?;
    let expr = crate::fts::query_expr(&raw)
        .ok_or_else(|| DbError::invalid("query", "查询词为空或全是不可索引字符"))?;
    let collection_id = opt_text(p, "collection_id")?;
    let document_id = opt_text(p, "document_id")?;
    let limit = limit_of(p, 8, DOCS_SEARCH_MAX)?;

    engine.with_conn(|conn| {
        let mut sql = String::from(
            "SELECT documents_fts.document_id, documents_fts.chunk_no, d.name, d.status, \
             c.page_from, c.page_to, c.heading_path, c.text_offset, c.text_len, c.preview, \
             bm25(documents_fts) AS rank \
             FROM documents_fts \
             JOIN document_chunks c ON c.document_id = documents_fts.document_id \
                AND c.chunk_no = documents_fts.chunk_no \
             JOIN documents d ON d.id = documents_fts.document_id \
             WHERE documents_fts MATCH ?1",
        );
        let mut vals: Vec<rusqlite::types::Value> = Vec::new();
        vals.push(rusqlite::types::Value::Text(expr));
        if let Some(c) = &collection_id {
            vals.push(rusqlite::types::Value::Text(c.clone()));
            sql.push_str(&format!(" AND d.collection_id=?{}", vals.len()));
        }
        if let Some(d) = &document_id {
            vals.push(rusqlite::types::Value::Text(d.clone()));
            sql.push_str(&format!(" AND documents_fts.document_id=?{}", vals.len()));
        }
        sql.push_str(" ORDER BY rank ASC");
        vals.push(rusqlite::types::Value::Integer(limit + 1));
        sql.push_str(&format!(" LIMIT ?{}", vals.len()));

        let mut stmt = conn.prepare(&sql).map_err(DbError::from)?;
        let rows = stmt
            .query_map(rusqlite::params_from_iter(vals.iter()), |r| {
                let rank: f64 = r.get::<_, f64>(10)?;
                Ok(json!({
                    "document_id": r.get::<_, String>(0)?,
                    "chunk_no": r.get::<_, i64>(1)?,
                    "name": r.get::<_, Option<String>>(2)?,
                    "status": r.get::<_, String>(3)?,
                    "page_from": r.get::<_, i64>(4)?,
                    "page_to": r.get::<_, i64>(5)?,
                    "heading_path": r.get::<_, Option<String>>(6)?,
                    "text_offset": r.get::<_, i64>(7)?,
                    "text_len": r.get::<_, i64>(8)?,
                    "preview": r.get::<_, Option<String>>(9)?,
                    "score": -rank,
                }))
            })
            .map_err(DbError::from)?;
        let mut items = Vec::new();
        for r in rows {
            items.push(r.map_err(DbError::from)?);
        }
        let has_more = items.len() as i64 > limit;
        if has_more {
            items.truncate(limit as usize);
        }
        Ok(json!({ "items": items, "has_more": has_more }))
    })
}

/// 文档大纲：只回标题路径（按首次出现的块号排序），不返回正文。
pub fn outline(engine: &DocsEngine, p: &Value) -> DbResult<Value> {
    let document_id = req_text(p, "document_id")?;
    let limit = limit_of(p, 80, 200)?;
    engine.with_conn(|conn| {
        let mut stmt = conn
            .prepare(
                "SELECT heading_path, MIN(block_no) AS first_block FROM document_blocks \
                 WHERE document_id=?1 AND kind='heading' AND heading_path IS NOT NULL \
                 GROUP BY heading_path ORDER BY first_block ASC LIMIT ?2",
            )
            .map_err(DbError::from)?;
        let rows = stmt
            .query_map(params![document_id, limit], |r| {
                Ok(json!({
                    "heading": r.get::<_, String>(0)?,
                    "block_no": r.get::<_, i64>(1)?,
                }))
            })
            .map_err(DbError::from)?;
        let mut items = Vec::new();
        for r in rows {
            items.push(r.map_err(DbError::from)?);
        }
        Ok(json!({ "headings": items }))
    })
}

pub fn read_chunks(engine: &DocsEngine, p: &Value) -> DbResult<Value> {
    let document_id = req_text(p, "document_id")?;
    let chunk_nos: Vec<i64> = p
        .get("chunk_nos")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_i64()).collect())
        .unwrap_or_default();
    let page = opt_i64(p, "page")?;
    let limit = limit_of(p, 20, 200)?;

    engine.with_conn(|conn| {
        let mut sql = String::from(
            "SELECT chunk_no, page_from, page_to, heading_path, text_offset, text_len, \
             token_count, preview FROM document_chunks WHERE document_id=?1",
        );
        let mut vals: Vec<rusqlite::types::Value> =
            vec![rusqlite::types::Value::Text(document_id.clone())];
        if !chunk_nos.is_empty() {
            let mut ph = Vec::new();
            for n in &chunk_nos {
                vals.push(rusqlite::types::Value::Integer(*n));
                ph.push(format!("?{}", vals.len()));
            }
            sql.push_str(&format!(" AND chunk_no IN ({})", ph.join(",")));
        } else if let Some(page) = page {
            vals.push(rusqlite::types::Value::Integer(page));
            sql.push_str(&format!(" AND page_from<=?{} AND page_to>=?{}", vals.len(), vals.len()));
        }
        sql.push_str(" ORDER BY chunk_no ASC");
        vals.push(rusqlite::types::Value::Integer(limit + 1));
        sql.push_str(&format!(" LIMIT ?{}", vals.len()));

        let mut stmt = conn.prepare(&sql).map_err(DbError::from)?;
        let rows = stmt
            .query_map(rusqlite::params_from_iter(vals.iter()), |r| {
                Ok(json!({
                    "chunk_no": r.get::<_, i64>(0)?,
                    "page_from": r.get::<_, i64>(1)?,
                    "page_to": r.get::<_, i64>(2)?,
                    "heading_path": r.get::<_, Option<String>>(3)?,
                    "text_offset": r.get::<_, i64>(4)?,
                    "text_len": r.get::<_, i64>(5)?,
                    "token_count": r.get::<_, i64>(6)?,
                    "preview": r.get::<_, Option<String>>(7)?,
                }))
            })
            .map_err(DbError::from)?;
        let mut items = Vec::new();
        for r in rows {
            items.push(r.map_err(DbError::from)?);
        }
        let has_more = items.len() as i64 > limit;
        if has_more {
            items.truncate(limit as usize);
        }
        Ok(json!({ "items": items, "has_more": has_more }))
    })
}

pub fn read_pages(engine: &DocsEngine, p: &Value) -> DbResult<Value> {
    let document_id = req_text(p, "document_id")?;
    engine.with_conn(|conn| {
        let mut stmt = conn
            .prepare(
                "SELECT page_no, kind, text_source, text_bytes, ocr_state, ocr_model, image_path \
                 FROM document_pages WHERE document_id=?1 ORDER BY page_no ASC",
            )
            .map_err(DbError::from)?;
        let rows = stmt
            .query_map(params![document_id], |r| {
                Ok(json!({
                    "page_no": r.get::<_, i64>(0)?,
                    "kind": r.get::<_, Option<String>>(1)?,
                    "text_source": r.get::<_, Option<String>>(2)?,
                    "text_bytes": r.get::<_, i64>(3)?,
                    "ocr_state": r.get::<_, Option<String>>(4)?,
                    "ocr_model": r.get::<_, Option<String>>(5)?,
                    "image_path": r.get::<_, Option<String>>(6)?,
                }))
            })
            .map_err(DbError::from)?;
        let mut items = Vec::new();
        for r in rows {
            items.push(r.map_err(DbError::from)?);
        }
        Ok(json!({ "items": items }))
    })
}

pub fn delete_document(engine: &DocsEngine, p: &Value) -> DbResult<Value> {
    let id = req_text(p, "id")?;
    engine.write_tx(|tx| {
        tx.execute(
            "DELETE FROM documents_fts WHERE document_id=?1",
            params![id],
        )
        .map_err(DbError::from)?;
        tx.execute("DELETE FROM document_vectors WHERE document_id=?1", params![id])
            .map_err(DbError::from)?;
        let n = tx
            .execute("DELETE FROM documents WHERE id=?1", params![id])
            .map_err(DbError::from)?;
        Ok(json!({ "deleted": n }))
    })
}

pub fn stats(engine: &DocsEngine, p: &Value) -> DbResult<Value> {
    let collection_id = opt_text(p, "collection_id")?;
    engine.with_conn(|conn| {
        let mut out = serde_json::Map::new();
        let mut sql = String::from("SELECT status, COUNT(*) FROM documents WHERE 1=1");
        let mut vals: Vec<rusqlite::types::Value> = Vec::new();
        if let Some(c) = &collection_id {
            vals.push(rusqlite::types::Value::Text(c.clone()));
            sql.push_str(&format!(" AND collection_id=?{}", vals.len()));
        }
        sql.push_str(" GROUP BY status");
        let mut stmt = conn.prepare(&sql).map_err(DbError::from)?;
        let rows = stmt
            .query_map(rusqlite::params_from_iter(vals.iter()), |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
            })
            .map_err(DbError::from)?;
        for r in rows {
            let (status, n) = r.map_err(DbError::from)?;
            out.insert(status, json!(n));
        }
        let chunk_filter = match &collection_id {
            Some(c) => {
                let n: i64 = conn
                    .query_row(
                        "SELECT COALESCE(SUM(chunk_count),0) FROM documents WHERE collection_id=?1",
                        params![c],
                        |r| r.get(0),
                    )
                    .map_err(DbError::from)?;
                n
            }
            None => conn
                .query_row("SELECT COALESCE(SUM(chunk_count),0) FROM documents", [], |r| r.get(0))
                .map_err(DbError::from)?,
        };
        Ok(json!({ "by_status": out, "total_chunks": chunk_filter }))
    })
}

/// 清空整个索引库（重建流程的第一步；blob/text 不受影响）。
pub fn reset(engine: &DocsEngine, _p: &Value) -> DbResult<Value> {
    engine.write_tx(|tx| {
        tx.execute_batch(
            "DELETE FROM documents_fts; DELETE FROM document_vectors; DELETE FROM documents; DELETE FROM document_ingest_state;",
        )
        .map_err(DbError::from)?;
        Ok(json!({ "ok": true }))
    })
}

/// 视觉转录：列出仍需 OCR 的页（`scanned`/`mixed` 且未 done）。
pub fn ocr_pending(engine: &DocsEngine, p: &Value) -> DbResult<Value> {
    let document_id = req_text(p, "document_id")?;
    engine.with_conn(|conn| {
        let mut stmt = conn
            .prepare(
                "SELECT page_no, kind FROM document_pages \
                 WHERE document_id=?1 AND kind IN ('scanned','mixed') \
                   AND (ocr_state IS NULL OR ocr_state IN ('pending','failed')) \
                 ORDER BY page_no",
            )
            .map_err(DbError::from)?;
        let rows = stmt
            .query_map(params![document_id], |r| {
                Ok(json!({
                    "page_no": r.get::<_, i64>(0)?,
                    "kind": r.get::<_, Option<String>>(1)?,
                }))
            })
            .map_err(DbError::from)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(DbError::from)?;
        Ok(json!({ "pages": rows }))
    })
}

/// 视觉转录：写一页的转录文本（块 + 分块 + FTS），并把该页标成 done。
///
/// `text_offset/text_len` 由宿主计算（它负责把文本追加到正文侧车），本函数只做库内一致性。
pub fn write_ocr_page(engine: &DocsEngine, p: &Value) -> DbResult<Value> {
    let document_id = req_text(p, "document_id")?;
    let page_no = opt_i64(p, "page_no")?.ok_or_else(|| DbError::missing("page_no"))?;
    let text = req_text(p, "text")?;
    let model = p.get("model").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let heading = p
        .get("heading")
        .and_then(|v| v.as_str())
        .unwrap_or("视觉转录")
        .to_string();
    let text_offset = opt_i64(p, "text_offset")?.unwrap_or(0);
    let text_len = opt_i64(p, "text_len")?.unwrap_or(text.len() as i64);
    let ts = now_ms();

    engine.write_tx(|tx| {
        let block_no: i64 = tx
            .query_row(
                "SELECT COALESCE(MAX(block_no)+1, 0) FROM document_blocks WHERE document_id=?1",
                params![document_id],
                |r| r.get(0),
            )
            .map_err(DbError::from)?;
        let chunk_no: i64 = tx
            .query_row(
                "SELECT COALESCE(MAX(chunk_no)+1, 0) FROM document_chunks WHERE document_id=?1",
                params![document_id],
                |r| r.get(0),
            )
            .map_err(DbError::from)?;

        tx.execute(
            "UPDATE document_pages SET ocr_state='done', ocr_model=?3, text_source='vision', \
             text_bytes=?4, updated_at=?5 WHERE document_id=?1 AND page_no=?2",
            params![document_id, page_no, model, text.len() as i64, ts],
        )
        .map_err(DbError::from)?;

        tx.execute(
            "INSERT INTO document_blocks(document_id, block_no, page_no, kind, heading_path, \
             text_offset, text_len) VALUES (?1,?2,?3,'paragraph',?4,?5,?6)",
            params![document_id, block_no, page_no, heading, text_offset, text_len],
        )
        .map_err(DbError::from)?;

        let tokens = text.chars().count() as i64; // 粗估：视觉转录单块 ≤ 模型 max_tokens，不追求精确
        let preview: String = text.chars().take(200).collect();
        tx.execute(
            "INSERT INTO document_chunks(document_id, chunk_no, page_from, page_to, heading_path, \
             text_offset, text_len, token_count, preview) VALUES (?1,?2,?3,?3,?4,?5,?6,?7,?8)",
            params![
                document_id,
                chunk_no,
                page_no,
                heading,
                text_offset,
                text_len,
                tokens,
                preview
            ],
        )
        .map_err(DbError::from)?;

        let tokenized = crate::fts::tokenize(&text);
        if !tokenized.trim().is_empty() {
            let rowid = fts_rowid(&document_id, chunk_no);
            tx.execute(
                "DELETE FROM documents_fts WHERE rowid=?1",
                params![rowid],
            )
            .map_err(DbError::from)?;
            tx.execute(
                "INSERT INTO documents_fts(rowid, tokenized_text, document_id, chunk_no) \
                 VALUES (?1,?2,?3,?4)",
                params![rowid, tokenized, document_id, chunk_no],
            )
            .map_err(DbError::from)?;
        }

        Ok(json!({
            "page_no": page_no,
            "block_no": block_no,
            "chunk_no": chunk_no,
            "ocr_model": model,
        }))
    })
}

/// 视觉转录收尾：没有待 OCR 的页 ⇒ 文档转 `ready` 并刷新计数；否则保持原状态。
pub fn ocr_finish(engine: &DocsEngine, p: &Value) -> DbResult<Value> {
    let document_id = req_text(p, "document_id")?;
    let ts = now_ms();
    engine.write_tx(|tx| {
        let remaining: i64 = tx
            .query_row(
                "SELECT COUNT(*) FROM document_pages WHERE document_id=?1 \
                 AND kind IN ('scanned','mixed') \
                 AND (ocr_state IS NULL OR ocr_state IN ('pending','failed'))",
                params![document_id],
                |r| r.get(0),
            )
            .map_err(DbError::from)?;
        let pages: i64 = tx
            .query_row(
                "SELECT COUNT(*) FROM document_pages WHERE document_id=?1",
                params![document_id],
                |r| r.get(0),
            )
            .map_err(DbError::from)?;
        let blocks: i64 = tx
            .query_row(
                "SELECT COUNT(*) FROM document_blocks WHERE document_id=?1",
                params![document_id],
                |r| r.get(0),
            )
            .map_err(DbError::from)?;
        let chunks: i64 = tx
            .query_row(
                "SELECT COUNT(*) FROM document_chunks WHERE document_id=?1",
                params![document_id],
                |r| r.get(0),
            )
            .map_err(DbError::from)?;
        if remaining == 0 {
            tx.execute(
                "UPDATE documents SET status='ready', error=NULL, page_count=?2, block_count=?3, \
                 chunk_count=?4, updated_at=?5 WHERE id=?1",
                params![document_id, pages, blocks, chunks, ts],
            )
            .map_err(DbError::from)?;
        }
        Ok(json!({
            "remaining": remaining,
            "status": if remaining == 0 { "ready" } else { "needs_ocr" },
            "page_count": pages,
            "block_count": blocks,
            "chunk_count": chunks,
        }))
    })
}

/// 视觉转录：把一页标成 failed（单页失败不拖垮整份文档；重跑时会再次列出该页）。
pub fn mark_ocr_failed(engine: &DocsEngine, p: &Value) -> DbResult<Value> {
    let document_id = req_text(p, "document_id")?;
    let page_no = opt_i64(p, "page_no")?.ok_or_else(|| DbError::missing("page_no"))?;
    engine.with_conn(|conn| {
        conn.execute(
            "UPDATE document_pages SET ocr_state='failed', updated_at=?3 \
             WHERE document_id=?1 AND page_no=?2",
            params![document_id, page_no, now_ms()],
        )
        .map_err(DbError::from)?;
        Ok(json!({ "page_no": page_no, "ocr_state": "failed" }))
    })
}

/// 续跑检查点：`document_ingest_state` + 库内下一块号/块号。
/// 没有检查点时返回 `null`（调用方走全新摄取）。
pub fn resume_checkpoint(engine: &DocsEngine, p: &Value) -> DbResult<Value> {
    let document_id = req_text(p, "document_id")?;
    engine.with_conn(|conn| {
        let row = conn
            .query_row(
                "SELECT s.phase, s.bytes_done, s.pages_done, s.chunks_done, \
                        (SELECT COALESCE(MAX(block_no)+1, 0) FROM document_blocks b \
                          WHERE b.document_id = s.document_id), \
                        (SELECT COALESCE(MAX(chunk_no)+1, 0) FROM document_chunks c \
                          WHERE c.document_id = s.document_id) \
                 FROM document_ingest_state s WHERE s.document_id=?1",
                params![document_id],
                |r| {
                    Ok(json!({
                        "phase": r.get::<_, Option<String>>(0)?,
                        "bytes_done": r.get::<_, i64>(1).unwrap_or(0),
                        "pages_done": r.get::<_, i64>(2).unwrap_or(0),
                        "chunks_done": r.get::<_, i64>(3).unwrap_or(0),
                        "next_block_no": r.get::<_, i64>(4).unwrap_or(0),
                        "next_chunk_no": r.get::<_, i64>(5).unwrap_or(0),
                    }))
                },
            )
            .optional()
            .map_err(DbError::from)?;
        Ok(row.unwrap_or(Value::Null))
    })
}

/// 页文本统计（续跑完成后重算文档状态用：剩余页可能全是扫描页）。
pub fn page_text_stats(engine: &DocsEngine, p: &Value) -> DbResult<Value> {
    let document_id = req_text(p, "document_id")?;
    engine.with_conn(|conn| {
        let total: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM document_pages WHERE document_id=?1",
                params![document_id],
                |r| r.get(0),
            )
            .map_err(DbError::from)?;
        let scanned: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM document_pages WHERE document_id=?1 AND kind='scanned'",
                params![document_id],
                |r| r.get(0),
            )
            .map_err(DbError::from)?;
        Ok(json!({ "total": total, "scanned": scanned }))
    })
}

/// 归一化 f32 向量；空/非有限/零向量返回 None（不写坏数据）。
fn normalize_vector(values: &[f32]) -> Option<Vec<f32>> {
    if values.is_empty() || values.iter().any(|v| !v.is_finite()) {
        return None;
    }
    let norm = values.iter().map(|v| v * v).sum::<f32>().sqrt();
    if !norm.is_finite() || norm <= 1e-12 {
        return None;
    }
    Some(values.iter().map(|v| v / norm).collect())
}

fn quantize_vector(values: &[f32]) -> (Vec<u8>, f32) {
    let scale = values.iter().fold(0.0f32, |m, x| m.max(x.abs()));
    if scale <= 1e-12 {
        return (vec![0u8; values.len()], 0.0);
    }
    let q = values
        .iter()
        .map(|x| ((x / scale) * 127.0).round().clamp(-127.0, 127.0) as i8 as u8)
        .collect();
    (q, scale)
}

fn dequantize_value(byte: u8, scale: f32) -> f32 {
    (byte as i8) as f32 / 127.0 * scale
}

fn vector_to_blob(values: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(values.len() * 4);
    for v in values {
        out.extend_from_slice(&v.to_le_bytes());
    }
    out
}

fn blob_to_vector(blob: &[u8]) -> Vec<f32> {
    blob.chunks_exact(4)
        .filter_map(|b| b.try_into().ok().map(f32::from_le_bytes))
        .collect()
}

/// 触发 IVF 训练的最小样本量。低于它没有统计意义，直接走全量扫描（Brute-force）。
const VECTOR_MIN_TRAIN: usize = 1024;
/// 训练时最多采样的向量数（全量赋值仍然覆盖所有向量）。
const VECTOR_TRAIN_SAMPLE: usize = 20_000;
/// 低于该规模不启用 ANN（结果少、全扫更快）。
const VECTOR_MIN_ANN: usize = 512;

fn cosine_dot(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b.iter()).map(|(x, y)| x * y).sum()
}

/// 确定性 LCG：训练可复现，不引入 rand 依赖。
struct Lcg(u64);
impl Lcg {
    fn new(seed: u64) -> Self {
        Self(seed | 1)
    }
    fn next(&mut self) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        self.0
    }
    fn unit(&mut self) -> f64 {
        (self.next() >> 11) as f64 / ((1u64 << 53) as f64)
    }
}

fn nearest_centroid(v: &[f32], centroids: &[Vec<f32>]) -> (usize, f32) {
    let mut best = (0usize, -2.0f32);
    for (i, c) in centroids.iter().enumerate() {
        let s = cosine_dot(v, c);
        if s > best.1 {
            best = (i, s);
        }
    }
    best
}

/// 集合内 ready 文档的向量条数与维度（不载入向量本体）。
fn collection_vector_stats(engine: &DocsEngine, collection_id: &str) -> DbResult<(usize, Option<usize>)> {
    engine.with_conn(|conn| {
        let (count, dim): (i64, Option<i64>) = conn
            .query_row(
                "SELECT COUNT(*), MAX(v.dim) FROM document_vectors v JOIN documents d ON d.id=v.document_id WHERE d.collection_id=?1 AND d.status='ready'",
                params![collection_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(DbError::from)?;
        Ok((count as usize, dim.map(|d| d as usize)))
    })
}

/// 单遍扫表、按固定步长采样；内存只保留 sample_n 条，不把全量向量装进 RAM。
fn sample_collection_vectors(
    engine: &DocsEngine,
    collection_id: &str,
    sample_n: usize,
    total: usize,
) -> DbResult<Vec<Vec<f32>>> {
    let stride = (total / sample_n.max(1)).max(1);
    engine.with_conn(|conn| {
        let mut stmt = conn
            .prepare(
                "SELECT v.vector FROM document_vectors v JOIN documents d ON d.id=v.document_id WHERE d.collection_id=?1 AND d.status='ready' ORDER BY v.document_id, v.chunk_no",
            )
            .map_err(DbError::from)?;
        let rows = stmt
            .query_map(params![collection_id], |r| r.get::<_, Vec<u8>>(0))
            .map_err(DbError::from)?;
        let mut out = Vec::with_capacity(sample_n);
        for (i, row) in rows.enumerate() {
            if i % stride != 0 {
                continue;
            }
            let blob = row.map_err(DbError::from)?;
            let v = blob_to_vector(&blob);
            if !v.is_empty() {
                out.push(v);
                if out.len() >= sample_n {
                    break;
                }
            }
        }
        Ok(out)
    })
}
/// 训练 IVF-Flat：k-means（确定性采样 + k-means++ 初始化 + 8 轮），
/// 然后把**所有**向量分配到最近中心。
///
/// 复杂度：O(sample × k × dim × iters + n × k × dim)。默认 sample=2万、k≈sqrt(n)≤128，
/// 10 万向量 64 维约几秒；赋值是 O(nk)，比每次查询全扫 O(nd) 更适合大规模。
pub fn vector_train(engine: &DocsEngine, p: &Value) -> DbResult<Value> {
    let collection_id = req_text(p, "collection_id")?;
    let iterations = opt_i64(p, "iterations")?.unwrap_or(8).clamp(1, 30) as usize;
    let (n, dim_opt) = collection_vector_stats(engine, &collection_id)?;
    if n < VECTOR_MIN_TRAIN {
        return Ok(json!({
            "trained": false,
            "reason": format!("样本不足：{n} < {VECTOR_MIN_TRAIN}（继续用全量扫描）"),
            "count": n
        }));
    }
    let dim = dim_opt.unwrap_or(0);
    if dim == 0 {
        return Ok(json!({ "trained": false, "reason": "没有维度", "count": n }));
    }

    // 均匀采样（确定性）；样本只用于求中心，不用于最终赋值。
    let sample_n = n.min(VECTOR_TRAIN_SAMPLE);
    let sample = sample_collection_vectors(engine, &collection_id, sample_n, n)?;
    if sample.is_empty() {
        return Ok(json!({ "trained": false, "reason": "采样为空", "count": n }));
    }
    let mut k = (n as f64).sqrt().round() as usize;
    k = k.clamp(8, 128).min(sample.len());

    let mut rng = Lcg::new((n as u64) ^ (dim as u64).rotate_left(17));
    let mut centroids: Vec<Vec<f32>> = vec![sample[0].clone()];
    while centroids.len() < k {
        // k-means++：按到最近中心的距离平方加权抽样。
        let mut weights = Vec::with_capacity(sample.len());
        let mut total = 0.0f64;
        for v in &sample {
            let (_, best) = nearest_centroid(v, &centroids);
            let d = (2.0 - 2.0 * best.max(-1.0)).max(0.0) as f64;
            weights.push(d);
            total += d;
        }
        let picked = if total <= 1e-12 {
            centroids.len() % sample.len()
        } else {
            let mut r = rng.unit() * total;
            let mut idx = sample.len() - 1;
            for (i, w) in weights.iter().enumerate() {
                r -= *w;
                if r <= 0.0 {
                    idx = i;
                    break;
                }
            }
            idx
        };
        centroids.push(sample[picked].clone());
    }

    for _ in 0..iterations {
        let mut sums = vec![vec![0.0f32; dim]; k];
        let mut counts = vec![0usize; k];
        for v in &sample {
            let (ci, _) = nearest_centroid(v, &centroids);
            counts[ci] += 1;
            for d in 0..dim {
                sums[ci][d] += v[d];
            }
        }
        for ci in 0..k {
            if counts[ci] == 0 {
                continue;
            }
            let norm = sums[ci].iter().map(|x| x * x).sum::<f32>().sqrt();
            if norm > 1e-12 {
                for d in 0..dim {
                    centroids[ci][d] = sums[ci][d] / norm;
                }
            }
        }
    }

    // 全量赋值 + 落盘（一个事务：中心、簇号、元数据要么全成、要么全不成）。
    let ts = now_ms();
    let assigned = engine.write_tx(|tx| {
        tx.execute(
            "DELETE FROM document_vector_centroids WHERE collection_id=?1",
            params![collection_id],
        )
        .map_err(DbError::from)?;
        {
            let mut ins = tx
                .prepare(
                    "INSERT INTO document_vector_centroids(collection_id, cluster_id, dim, vector, updated_at) \
                     VALUES (?1,?2,?3,?4,?5)",
                )
                .map_err(DbError::from)?;
            for (ci, c) in centroids.iter().enumerate() {
                ins.execute(params![
                    collection_id,
                    ci as i64,
                    dim as i64,
                    vector_to_blob(c),
                    ts
                ])
                .map_err(DbError::from)?;
            }
        }
        let mut upd = tx
            .prepare(
                "UPDATE document_vectors SET cluster_id=?1, qvector=?2, qscale=?3 \
                 WHERE document_id=?4 AND chunk_no=?5",
            )
            .map_err(DbError::from)?;
        // 流式赋簇：每批 1000 行，内存不随集合规模增长（外存/低内存）。
        let mut sel = tx
            .prepare(
                "SELECT v.document_id, v.chunk_no, v.vector \
                 FROM document_vectors v JOIN documents d ON d.id=v.document_id \
                 WHERE d.collection_id=?1 AND d.status='ready' \
                   AND (v.document_id>?2 OR (v.document_id=?2 AND v.chunk_no>?3)) \
                 ORDER BY v.document_id, v.chunk_no LIMIT 1000",
            )
            .map_err(DbError::from)?;
        let mut assigned = 0usize;
        let mut last_doc = String::new();
        let mut last_chunk = -1i64;
        loop {
            let rows: Vec<(String, i64, Vec<u8>)> = {
                let mapped = sel
                    .query_map(params![collection_id, last_doc, last_chunk], |r| {
                        Ok((
                            r.get::<_, String>(0)?,
                            r.get::<_, i64>(1)?,
                            r.get::<_, Vec<u8>>(2)?,
                        ))
                    })
                    .map_err(DbError::from)?;
                mapped
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(DbError::from)?
            };
            if rows.is_empty() {
                break;
            }
            for (doc, chunk, blob) in &rows {
                let v = blob_to_vector(blob);
                if v.len() != dim {
                    continue;
                }
                let (ci, _) = nearest_centroid(&v, &centroids);
                let (q, scale) = quantize_vector(&v);
                upd.execute(params![ci as i64, q, scale, doc, chunk])
                    .map_err(DbError::from)?;
                assigned += 1;
            }
            let last = rows.last().unwrap();
            last_doc = last.0.clone();
            last_chunk = last.1;
        }
        drop(sel);
        tx.execute(
            "INSERT INTO document_vector_meta(collection_id, dim, count, k, trained_at, updated_at) \
             VALUES (?1,?2,?3,?4,?5,?5) \
             ON CONFLICT(collection_id) DO UPDATE SET dim=excluded.dim, count=excluded.count, \
             k=excluded.k, trained_at=excluded.trained_at, updated_at=excluded.updated_at",
            params![collection_id, dim as i64, n as i64, k as i64, ts],
        )
        .map_err(DbError::from)?;
        Ok(assigned)
    })?;

    Ok(json!({
        "trained": true,
        "collection_id": collection_id,
        "count": n,
        "dim": dim,
        "k": k,
        "iterations": iterations,
        "assigned": assigned
    }))
}

/// 向量索引写入（幂等：同一 (document_id, chunk_no) 覆盖）。
///
/// `replace_all=true` 先清该文档的旧向量（整份重新嵌入时用）。向量在写入时归一化，
/// 检索只需点积 = cosine，避免每次查询重复算模长。
pub fn vector_upsert(engine: &DocsEngine, p: &Value) -> DbResult<Value> {
    let document_id = req_text(p, "document_id")?;
    let model = p
        .get("model")
        .and_then(|v| v.as_str())
        .unwrap_or("default")
        .to_string();
    let replace_all = p
        .get("replace_all")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let vectors = p
        .get("vectors")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    if vectors.is_empty() && !replace_all {
        return Err(DbError::new(
            crate::error::ErrorCode::Constraint,
            "vectors 不能为空",
        ));
    }
    let ts = now_ms();
    engine.write_tx(|tx| {
        if replace_all {
            tx.execute(
                "DELETE FROM document_vectors WHERE document_id=?1",
                params![document_id],
            )
            .map_err(DbError::from)?;
        }
        let mut upserted = 0usize;
        let mut dim = 0usize;
        for item in &vectors {
            let chunk_no = item
                .get("chunk_no")
                .and_then(|v| v.as_i64())
                .ok_or_else(|| DbError::missing("chunk_no"))?;
            let raw: Vec<f32> = item
                .get("vector")
                .and_then(|v| v.as_array())
                .map(|a| a.iter().filter_map(|x| x.as_f64()).map(|x| x as f32).collect())
                .unwrap_or_default();
            let normalized = normalize_vector(&raw).ok_or_else(|| {
                DbError::new(
                    crate::error::ErrorCode::Constraint,
                    "向量为空/含非有限值/零向量",
                )
            })?;
            if dim == 0 {
                dim = normalized.len();
            } else if dim != normalized.len() {
                return Err(DbError::new(
                    crate::error::ErrorCode::Constraint,
                    "同一批次向量维度不一致",
                ));
            }
            let (qvector, qscale) = quantize_vector(&normalized);
            tx.execute(
                "INSERT INTO document_vectors(document_id, chunk_no, model, dim, vector, qvector, qscale, updated_at) \
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8) \
                 ON CONFLICT(document_id, chunk_no) DO UPDATE SET model=excluded.model, \
                 dim=excluded.dim, vector=excluded.vector, qvector=excluded.qvector, \
                 qscale=excluded.qscale, updated_at=excluded.updated_at",
                params![
                    document_id,
                    chunk_no,
                    model,
                    normalized.len() as i64,
                    vector_to_blob(&normalized),
                    qvector,
                    qscale,
                    ts
                ],
            )
            .map_err(DbError::from)?;
            upserted += 1;
        }
        Ok(json!({ "upserted": upserted, "dim": dim, "model": model }))
    })
}

/// 量化 ANN：先读 int8 近似打分，再对 top-K 回读原向量精确重排。
///
/// 外存语义：候选只来自 SQLite 里被选中的簇（`qvector` BLOB），不把全量索引装进内存；
/// top-K 才回读 float 原向量。这样 1M×768 维不必常驻 2.9GB 向量本体。
fn quantized_ann_search(
    engine: &DocsEngine,
    collection_id: &str,
    query: &[f32],
    selected: &[i64],
    limit: i64,
    model: &Option<String>,
    document_filter: &[String],
) -> DbResult<Value> {
    let (q_query_bytes, q_query_scale) = quantize_vector(query);
    let q_query: Vec<f32> = q_query_bytes.iter().map(|b| *b as i8 as f32).collect();
    let rerank_k = ((limit as usize) * 8).max(64);

    engine.with_conn(|conn| {
        let base = "SELECT v.document_id, v.chunk_no, v.qvector, v.qscale, v.dim, \
                    c.page_from, c.page_to, c.heading_path, d.name, v.model \
                    FROM document_vectors v \
                    JOIN document_chunks c ON c.document_id=v.document_id AND c.chunk_no=v.chunk_no \
                    JOIN documents d ON d.id=v.document_id \
                    WHERE d.collection_id=?1 AND d.status='ready'";
        let placeholders = selected
            .iter()
            .map(|_| "?")
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!("{base} AND (v.cluster_id IN ({placeholders}) OR v.cluster_id IS NULL)");
        let mut values: Vec<rusqlite::types::Value> =
            vec![rusqlite::types::Value::Text(collection_id.to_string())];
        for id in selected {
            values.push(rusqlite::types::Value::Integer(*id));
        }

        struct Cand {
            doc: String,
            chunk: i64,
            page_from: Option<i64>,
            page_to: Option<i64>,
            heading: Option<String>,
            name: Option<String>,
            stored_model: String,
            score: f32,
        }
        let mut cands: Vec<Cand> = Vec::new();
        let mut candidates = 0usize;
        {
            let mut stmt = conn.prepare(&sql).map_err(DbError::from)?;
            let mapped = stmt
                .query_map(rusqlite::params_from_iter(values.iter()), |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, i64>(1)?,
                        r.get::<_, Option<Vec<u8>>>(2)?,
                        r.get::<_, Option<f64>>(3)?,
                        r.get::<_, i64>(4)?,
                        r.get::<_, Option<i64>>(5)?,
                        r.get::<_, Option<i64>>(6)?,
                        r.get::<_, Option<String>>(7)?,
                        r.get::<_, Option<String>>(8)?,
                        r.get::<_, String>(9)?,
                    ))
                })
                .map_err(DbError::from)?;
            for row in mapped {
                let (doc, chunk, qb, qs, dim, page_from, page_to, heading, name, stored_model) =
                    row.map_err(DbError::from)?;
                candidates += 1;
                if dim as usize != query.len() {
                    continue;
                }
                if let Some(m) = model {
                    if &stored_model != m {
                        continue;
                    }
                }
                if !document_filter.is_empty() && !document_filter.contains(&doc) {
                    continue;
                }
                let score = match (qb, qs) {
                    (Some(bytes), Some(scale)) if bytes.len() == query.len() => {
                        let dot: f32 = bytes
                            .iter()
                            .zip(q_query.iter())
                            .map(|(b, q)| (*b as i8 as f32) * q)
                            .sum();
                        dot / (127.0 * 127.0) * q_query_scale * scale as f32
                    }
                    _ => f32::NEG_INFINITY, // 老行没有 qvector：下面回读原向量补精确分
                };
                cands.push(Cand {
                    doc,
                    chunk,
                    page_from,
                    page_to,
                    heading,
                    name,
                    stored_model,
                    score,
                });
            }
        }

        // 缺 qvector 的老行：按主键回读原向量（数量很少；训练后会被回填）。
        let mut exact = conn
            .prepare("SELECT vector FROM document_vectors WHERE document_id=?1 AND chunk_no=?2")
            .map_err(DbError::from)?;
        for c in cands.iter_mut() {
            if c.score.is_finite() {
                continue;
            }
            let blob: Vec<u8> = exact
                .query_row(params![c.doc, c.chunk], |r| r.get(0))
                .map_err(DbError::from)?;
            let v = blob_to_vector(&blob);
            if v.len() == query.len() {
                c.score = cosine_dot(&v, query);
            }
        }
        drop(exact);

        cands.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
        cands.truncate(rerank_k);
        let rerank = cands.len();

        // 精确重排：只回读 top-K 的 float 向量。
        let mut fetch = conn
            .prepare("SELECT vector FROM document_vectors WHERE document_id=?1 AND chunk_no=?2")
            .map_err(DbError::from)?;
        for c in cands.iter_mut() {
            let blob: Vec<u8> = fetch
                .query_row(params![c.doc, c.chunk], |r| r.get(0))
                .map_err(DbError::from)?;
            let v = blob_to_vector(&blob);
            if v.len() == query.len() {
                c.score = cosine_dot(&v, query);
            }
        }
        drop(fetch);

        cands.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
        cands.truncate(limit as usize);
        let items: Vec<Value> = cands
            .into_iter()
            .map(|c| {
                json!({
                    "document_id": c.doc,
                    "chunk_no": c.chunk,
                    "score": c.score,
                    "page_from": c.page_from,
                    "page_to": c.page_to,
                    "heading_path": c.heading,
                    "name": c.name,
                    "model": c.stored_model,
                })
            })
            .collect();
        Ok(json!({
            "items": items,
            "dim": query.len(),
            "ann": true,
            "quantized": true,
            "probed": selected.len(),
            "candidates": candidates,
            "rerank": rerank
        }))
    })
}

/// 向量检索：collection 内按 cosine 排序（只检索 ready 文档）。
pub fn vector_search(engine: &DocsEngine, p: &Value) -> DbResult<Value> {
    let collection_id = req_text(p, "collection_id")?;
    let raw: Vec<f32> = p
        .get("query_vector")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_f64()).map(|x| x as f32).collect())
        .unwrap_or_default();
    let query = normalize_vector(&raw)
        .ok_or_else(|| DbError::new(crate::error::ErrorCode::Constraint, "query_vector 无效"))?;
    let limit = opt_i64(p, "limit")?.unwrap_or(20).clamp(1, 64);
    let model = p.get("model").and_then(|v| v.as_str()).map(|s| s.to_string());
    let document_filter: Vec<String> = p
        .get("document_ids")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();
    let force_brute = p.get("force_brute").and_then(|v| v.as_bool()).unwrap_or(false);
    let force_float = p.get("force_float").and_then(|v| v.as_bool()).unwrap_or(false);
    let nprobe = opt_i64(p, "nprobe")?.unwrap_or(16).clamp(1, 128) as usize;

    /*
     * IVF-Flat：有训练好的中心就只扫 top-nprobe 簇 + 尚未分配的新向量。
     * 没有中心 / 样本太小 / 维度不符 ⇒ 走全量扫描（Brute-force）。
     * `force_brute` 是给判据与排障用的“同一份数据做对照”开关。
     */
    let ann = if force_brute {
        None
    } else {
        engine.with_conn(|conn| {
            let meta: Option<(i64, i64, i64)> = conn
                .query_row(
                    "SELECT dim, count, k FROM document_vector_meta WHERE collection_id=?1",
                    params![collection_id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .ok();
            let Some((dim, count, _k)) = meta else {
                return Ok(None);
            };
            if count < VECTOR_MIN_ANN as i64 || dim as usize != query.len() {
                return Ok(None);
            }
            let mut stmt = conn
                .prepare(
                    "SELECT vector FROM document_vector_centroids \
                     WHERE collection_id=?1 AND dim=?2 ORDER BY cluster_id",
                )
                .map_err(DbError::from)?;
            let mapped = stmt
                .query_map(params![collection_id, dim], |r| r.get::<_, Vec<u8>>(0))
                .map_err(DbError::from)?;
            let mut cents = Vec::new();
            for row in mapped {
                let blob = row.map_err(DbError::from)?;
                let v = blob_to_vector(&blob);
                if v.len() == query.len() {
                    cents.push(v);
                }
            }
            Ok(if cents.is_empty() { None } else { Some(cents) })
        })?
    };

    let mut ann_used = false;
    let mut selected: Vec<i64> = Vec::new();
    if let Some(cents) = &ann {
        let mut ranked: Vec<(usize, f32)> = cents
            .iter()
            .enumerate()
            .map(|(i, c)| (i, cosine_dot(&query, c)))
            .collect();
        ranked.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        selected = ranked
            .into_iter()
            .take(nprobe)
            .map(|(i, _)| i as i64)
            .collect();
        ann_used = true;
    }

    // 默认走“int8 近似 + top-K 精确重排”（外存、低 IO）；force_float 保留 float 簇扫描做对照。
    if ann_used && !force_float {
        return quantized_ann_search(
            engine,
            &collection_id,
            &query,
            &selected,
            limit,
            &model,
            &document_filter,
        );
    }

    engine.with_conn(|conn| {
        let base = "SELECT v.document_id, v.chunk_no, v.vector, v.dim, c.page_from, c.page_to, \
                    c.heading_path, d.name, v.model \
                    FROM document_vectors v \
                    JOIN document_chunks c ON c.document_id=v.document_id AND c.chunk_no=v.chunk_no \
                    JOIN documents d ON d.id=v.document_id \
                    WHERE d.collection_id=?1 AND d.status='ready'";
        let sql = if ann_used {
            let placeholders = selected
                .iter()
                .map(|_| "?")
                .collect::<Vec<_>>()
                .join(",");
            format!("{base} AND (v.cluster_id IN ({placeholders}) OR v.cluster_id IS NULL)")
        } else {
            base.to_string()
        };
        let mut values: Vec<rusqlite::types::Value> =
            vec![rusqlite::types::Value::Text(collection_id.to_string())];
        for id in &selected {
            values.push(rusqlite::types::Value::Integer(*id));
        }
        let mut stmt = conn.prepare(&sql).map_err(DbError::from)?;
        let mapped = stmt
            .query_map(rusqlite::params_from_iter(values.iter()), |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, Vec<u8>>(2)?,
                    r.get::<_, i64>(3)?,
                    r.get::<_, Option<i64>>(4)?,
                    r.get::<_, Option<i64>>(5)?,
                    r.get::<_, Option<String>>(6)?,
                    r.get::<_, Option<String>>(7)?,
                    r.get::<_, String>(8)?,
                ))
            })
            .map_err(DbError::from)?;
        let mut scored: Vec<Value> = Vec::new();
        let mut candidates = 0usize;
        for row in mapped {
            let (doc_id, chunk_no, blob, dim, page_from, page_to, heading, name, stored_model) =
                row.map_err(DbError::from)?;
            candidates += 1;
            if dim as usize != query.len() {
                continue;
            }
            if let Some(m) = &model {
                if &stored_model != m {
                    continue;
                }
            }
            if !document_filter.is_empty() && !document_filter.contains(&doc_id) {
                continue;
            }
            let values = blob_to_vector(&blob);
            if values.len() != query.len() {
                continue;
            }
            let score: f32 = values.iter().zip(query.iter()).map(|(a, b)| a * b).sum();
            scored.push(json!({
                "document_id": doc_id,
                "chunk_no": chunk_no,
                "score": score,
                "page_from": page_from,
                "page_to": page_to,
                "heading_path": heading,
                "name": name,
            }));
        }
        scored.sort_by(|a, b| {
            b.get("score")
                .and_then(|v| v.as_f64())
                .partial_cmp(&a.get("score").and_then(|v| v.as_f64()))
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        scored.truncate(limit as usize);
        Ok(json!({
            "items": scored,
            "dim": query.len(),
            "ann": ann_used,
            "quantized": false,
            "rerank": 0,
            "probed": if ann_used { selected.len() } else { 0 },
            "candidates": candidates
        }))
    })
}

/// 向量索引状态（按文档/模型计数；给 UI 与判据看“索引到哪了”）。
pub fn vector_status(engine: &DocsEngine, p: &Value) -> DbResult<Value> {
    fn row_to_json(r: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
        Ok(json!({
            "document_id": r.get::<_, String>(0)?,
            "model": r.get::<_, String>(1)?,
            "chunks": r.get::<_, i64>(2)?,
            "dim": r.get::<_, Option<i64>>(3)?,
        }))
    }
    let document_id = p.get("document_id").and_then(|v| v.as_str());
    engine.with_conn(|conn| {
        let rows = match document_id {
            Some(id) => {
                let mut stmt = conn
                    .prepare(
                        "SELECT document_id, model, COUNT(*), MAX(dim) FROM document_vectors \
                         WHERE document_id=?1 GROUP BY document_id, model",
                    )
                    .map_err(DbError::from)?;
                let mapped = stmt.query_map(params![id], row_to_json).map_err(DbError::from)?;
                let collected = mapped.collect::<Result<Vec<_>, _>>().map_err(DbError::from)?;
                drop(stmt);
                collected
            }
            None => {
                let mut stmt = conn
                    .prepare(
                        "SELECT document_id, model, COUNT(*), MAX(dim) FROM document_vectors \
                         GROUP BY document_id, model",
                    )
                    .map_err(DbError::from)?;
                let mapped = stmt.query_map([], row_to_json).map_err(DbError::from)?;
                let collected = mapped.collect::<Result<Vec<_>, _>>().map_err(DbError::from)?;
                drop(stmt);
                collected
            }
        };
        let mut count = 0i64;
        let mut assigned = 0i64;
        let mut quantized = 0i64;
        let mut meta = Value::Null;
        if let Some(cid) = p.get("collection_id").and_then(|v| v.as_str()) {
            count = conn
                .query_row(
                    "SELECT COUNT(*) FROM document_vectors v JOIN documents d ON d.id=v.document_id \
                     WHERE d.collection_id=?1 AND d.status='ready'",
                    params![cid],
                    |r| r.get(0),
                )
                .unwrap_or(0);
            assigned = conn
                .query_row(
                    "SELECT COUNT(*) FROM document_vectors v JOIN documents d ON d.id=v.document_id \
                     WHERE d.collection_id=?1 AND d.status='ready' AND v.cluster_id IS NOT NULL",
                    params![cid],
                    |r| r.get(0),
                )
                .unwrap_or(0);
            quantized = conn
                .query_row(
                    "SELECT COUNT(*) FROM document_vectors v JOIN documents d ON d.id=v.document_id WHERE d.collection_id=?1 AND d.status='ready' AND v.qvector IS NOT NULL",
                    params![cid],
                    |r| r.get(0),
                )
                .unwrap_or(0);
            meta = conn
                .query_row(
                    "SELECT dim, count, k, trained_at FROM document_vector_meta WHERE collection_id=?1",
                    params![cid],
                    |r| {
                        Ok(json!({
                            "dim": r.get::<_, i64>(0)?,
                            "count": r.get::<_, i64>(1)?,
                            "k": r.get::<_, i64>(2)?,
                            "trained_at": r.get::<_, i64>(3)?,
                        }))
                    },
                )
                .unwrap_or(Value::Null);
        }
        Ok(json!({
            "items": rows,
            "count": count,
            "assigned": assigned,
            "quantized": quantized,
            "meta": meta
        }))
    })
}

pub fn health(engine: &DocsEngine) -> DbResult<Value> {
    engine.with_conn(|conn| {
        let documents: i64 = conn
            .query_row("SELECT COUNT(*) FROM documents", [], |r| r.get(0))
            .map_err(DbError::from)?;
        let chunks: i64 = conn
            .query_row("SELECT COUNT(*) FROM document_chunks", [], |r| r.get(0))
            .map_err(DbError::from)?;
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .map_err(DbError::from)?;
        // FTS 行数单独暴露：它可能与 documents/chunks 不一致（清库只删一半、旧库残留），
        // UI 与判据需要看到这份"幽灵行"（DOCI-11 的变异就靠它变红）。
        let fts_rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM documents_fts", [], |r| r.get(0))
            .map_err(DbError::from)?;
        Ok(json!({
            "path": engine.path().to_string_lossy(),
            "schema_version": version,
            "documents": documents,
            "chunks": chunks,
            "fts_rows": fts_rows,
        }))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn engine() -> DocsEngine {
        DocsEngine::open_in_memory().expect("open")
    }

    fn upsert(e: &DocsEngine, collection: &str, key: &str) -> String {
        let out = upsert_document(
            e,
            &json!({
                "collection_id": collection,
                "kind": "attachment",
                "dedupe_key": key,
                "name": "报告.docx",
                "size": 1234,
                "sha256": "abc",
                "status": "pending"
            }),
        )
        .expect("upsert");
        out["id"].as_str().unwrap().to_string()
    }

    #[test]
    fn schema_v2_gets_cluster_column_on_open() {
        let path = std::env::temp_dir().join(format!(
            "codem-docs-migrate-{}-{}.db",
            std::process::id(),
            now_ms()
        ));
        {
            let conn = rusqlite::Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE document_vectors (
                    document_id TEXT NOT NULL,
                    chunk_no INTEGER NOT NULL,
                    model TEXT NOT NULL,
                    dim INTEGER NOT NULL,
                    vector BLOB NOT NULL,
                    updated_at INTEGER NOT NULL,
                    PRIMARY KEY(document_id, chunk_no)
                 );
                 PRAGMA user_version=2;",
            )
            .unwrap();
        }
        let e = DocsEngine::open(&path).unwrap();
        let has: i64 = e
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT COUNT(*) FROM pragma_table_info('document_vectors') WHERE name='cluster_id'",
                    [],
                    |r| r.get(0),
                )
                .map_err(DbError::from)
            })
            .unwrap();
        assert_eq!(has, 1, "v2 老库必须补上 cluster_id");
        for col in ["qvector", "qscale"] {
            let n: i64 = e
                .with_conn(|conn| {
                    conn.query_row(
                        &format!("SELECT COUNT(*) FROM pragma_table_info('document_vectors') WHERE name='{col}'"),
                        [],
                        |r| r.get(0),
                    )
                    .map_err(DbError::from)
                })
                .unwrap();
            assert_eq!(n, 1, "v2 老库必须补上 {col}");
        }
        assert_eq!(health(&e).unwrap()["schema_version"], 4);
        drop(e);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn schema_created_and_versioned() {
        let e = engine();
        let h = health(&e).unwrap();
        assert_eq!(h["schema_version"], DOCS_SCHEMA_VERSION);
        assert_eq!(h["documents"], 0);
    }

    #[test]
    fn upsert_is_idempotent_per_collection_and_key() {
        let e = engine();
        let first = upsert(&e, "p1", "blob:aaa");
        let again = upsert_document(
            &e,
            &json!({
                "collection_id": "p1",
                "kind": "attachment",
                "dedupe_key": "blob:aaa",
                "name": "报告.docx",
                "status": "ready"
            }),
        )
        .unwrap();
        assert_eq!(again["created"], false);
        assert_eq!(again["id"].as_str().unwrap(), first);
        // 不同 collection 同 key → 新行（同一物理文件可属于多个项目集合）
        let other = upsert_document(
            &e,
            &json!({
                "collection_id": "p2",
                "kind": "attachment",
                "dedupe_key": "blob:aaa",
                "name": "报告.docx"
            }),
        )
        .unwrap();
        assert_eq!(other["created"], true);
        assert_ne!(other["id"].as_str().unwrap(), first);
    }

    #[test]
    fn chunks_are_searchable_in_chinese_and_idempotent() {
        let e = engine();
        let id = upsert(&e, "p1", "blob:aaa");
        let write = |text: &str, chunk_no: i64| {
            write_batch(
                &e,
                &json!({
                    "document_id": id,
                    "chunks": [{
                        "chunk_no": chunk_no,
                        "page_from": 3,
                        "page_to": 4,
                        "heading_path": "3.2 迁移",
                        "text_offset": 0,
                        "text_len": text.chars().count() as i64,
                        "token_count": 10,
                        "preview": text.chars().take(40).collect::<String>(),
                        "text": text
                    }]
                }),
            )
            .unwrap()
        };
        write("数据迁移的目标与步骤", 0);
        write("完全无关的段落", 1);

        let hit = search(&e, &json!({ "collection_id": "p1", "query": "迁移" })).unwrap();
        let items = hit["items"].as_array().unwrap();
        assert_eq!(items.len(), 1, "中文查询应命中且只命中一条：{hit}");
        assert_eq!(items[0]["chunk_no"], 0);
        assert_eq!(items[0]["page_from"], 3);
        assert!(items[0]["score"].as_f64().unwrap() > 0.0);

        // 幂等：同一 chunk_no 重写后仍只有一条 FTS 行
        write("数据迁移的目标与步骤（修订）", 0);
        let again = search(&e, &json!({ "query": "迁移" })).unwrap();
        assert_eq!(again["items"].as_array().unwrap().len(), 1);
        assert_eq!(again["items"][0]["chunk_no"], 0);
    }

    #[test]
    fn search_filters_by_collection_and_document() {
        let e = engine();
        let a = upsert(&e, "p1", "blob:aaa");
        let b = upsert(&e, "p2", "blob:bbb");
        for (id, text) in [(a.clone(), "迁移方案 A"), (b.clone(), "迁移方案 B")] {
            write_batch(
                &e,
                &json!({
                    "document_id": id,
                    "chunks": [{"chunk_no":0,"text":text,"text_offset":0,"text_len":4}]
                }),
            )
            .unwrap();
        }
        let p1 = search(&e, &json!({"collection_id":"p1","query":"迁移"})).unwrap();
        assert_eq!(p1["items"].as_array().unwrap().len(), 1);
        let by_doc = search(&e, &json!({"document_id": b, "query":"迁移"})).unwrap();
        assert_eq!(by_doc["items"][0]["document_id"], b);
    }

    #[test]
    fn empty_query_is_an_error_not_full_scan() {
        let e = engine();
        let err = search(&e, &json!({"query": "  "})).unwrap_err();
        assert_eq!(err.code, crate::error::ErrorCode::Other);
        assert!(err.message.contains("不合法"));
    }

    #[test]
    fn delete_cascades_chunks_pages_blocks_and_fts() {
        let e = engine();
        let id = upsert(&e, "p1", "blob:aaa");
        write_batch(
            &e,
            &json!({
                "document_id": id,
                "pages": [{"page_no":1,"kind":"text","text_source":"layout","text_bytes":10}],
                "blocks": [{"block_no":0,"page_no":1,"kind":"heading","text_offset":0,"text_len":4}],
                "chunks": [{"chunk_no":0,"text":"迁移方案","text_offset":0,"text_len":4}],
                "state": {"phase":"index","pages_done":1,"chunks_done":1}
            }),
        )
        .unwrap();
        assert_eq!(read_pages(&e, &json!({"document_id": id})).unwrap()["items"].as_array().unwrap().len(), 1);
        delete_document(&e, &json!({"id": id})).unwrap();
        assert!(search(&e, &json!({"query":"迁移"})).unwrap()["items"]
            .as_array()
            .unwrap()
            .is_empty());
        let h = health(&e).unwrap();
        assert_eq!(h["documents"], 0);
        assert_eq!(h["chunks"], 0);
    }

    #[test]
    fn status_and_stats_are_visible() {
        let e = engine();
        let id = upsert(&e, "p1", "blob:aaa");
        update_status(
            &e,
            &json!({"id": id, "status": "ready", "page_count": 3, "chunk_count": 7,
                    "outline": [{"level":1,"title":"第一章"}]}),
        )
        .unwrap();
        let doc = get_document(&e, &json!({"id": id})).unwrap();
        assert_eq!(doc["status"], "ready");
        assert_eq!(doc["page_count"], 3);
        assert_eq!(doc["chunk_count"], 7);
        assert!(doc["outline_json"].as_str().unwrap().contains("第一章"));
        let s = stats(&e, &json!({"collection_id":"p1"})).unwrap();
        assert_eq!(s["by_status"]["ready"], 1);
    }

    #[test]
    fn write_batch_rejects_oversized_payload() {
        let e = engine();
        let id = upsert(&e, "p1", "blob:aaa");
        let chunks: Vec<Value> = (0..(DOCS_WRITE_BATCH_MAX + 1))
            .map(|i| json!({"chunk_no": i as i64, "text": "x", "text_offset": 0, "text_len": 1}))
            .collect();
        let err = write_batch(&e, &json!({"document_id": id, "chunks": chunks})).unwrap_err();
        assert_eq!(err.code, crate::error::ErrorCode::Other);
        assert!(err.message.contains("不合法"));
    }

    #[test]
    fn resume_checkpoint_survives_same_sha_and_resets_on_new_sha() {
        let e = engine();
        let dedupe = "path:/tmp/report.pdf";
        let id = upsert_document(
            &e,
            &json!({
                "collection_id": "p1", "kind": "path", "dedupe_key": dedupe,
                "name": "report.pdf", "sha256": "old-sha", "status": "extracting"
            }),
        )
        .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_string();
        write_batch(
            &e,
            &json!({
                "document_id": id,
                "pages": [{"page_no": 1, "kind": "text", "text_source": "layout", "text_bytes": 10}],
                "chunks": [{"chunk_no": 0, "text": "第一页内容", "page_from": 1, "page_to": 1}],
                "state": {"phase": "index", "bytes_done": 15, "pages_done": 1, "chunks_done": 1}
            }),
        )
        .unwrap();

        let cp = resume_checkpoint(&e, &json!({"document_id": id})).unwrap();
        assert_eq!(cp["bytes_done"], 15);
        assert_eq!(cp["pages_done"], 1);
        assert_eq!(cp["next_chunk_no"], 1);
        assert_eq!(cp["next_block_no"], 0, "本用例未写块");

        // 同 sha 重新登记：检查点/块保留（下次可续跑）
        upsert_document(
            &e,
            &json!({
                "collection_id": "p1", "kind": "path", "dedupe_key": dedupe,
                "sha256": "old-sha", "status": "extracting"
            }),
        )
        .unwrap();
        assert!(
            resume_checkpoint(&e, &json!({"document_id": id})).unwrap()["bytes_done"]
                .as_i64()
                .unwrap()
                > 0
        );
        let rows = read_chunks(&e, &json!({"document_id": id, "limit": 10})).unwrap();
        assert_eq!(rows["items"].as_array().unwrap().len(), 1);

        // sha 变了 = 内容换了：旧块/检查点必须清空（否则续跑会拿旧检查点套新文件）
        upsert_document(
            &e,
            &json!({
                "collection_id": "p1", "kind": "path", "dedupe_key": dedupe,
                "sha256": "new-sha", "status": "extracting"
            }),
        )
        .unwrap();
        let rows = read_chunks(&e, &json!({"document_id": id, "limit": 10})).unwrap();
        assert_eq!(rows["items"].as_array().unwrap().len(), 0);
        assert!(resume_checkpoint(&e, &json!({"document_id": id}))
            .unwrap()
            .is_null());
        let pages = read_pages(&e, &json!({"document_id": id})).unwrap();
        assert_eq!(pages["items"].as_array().unwrap().len(), 0);
    }

    /// 生成 n 个按 8 个中心聚集的确定性向量，写入 chunks/vectors；返回原始向量。
    fn seed_clustered_vectors(
        e: &DocsEngine,
        collection: &str,
        n: usize,
        dim: usize,
    ) -> Vec<Vec<f32>> {
        let id = upsert(e, collection, &format!("blob:{collection}"));
        let chunks: Vec<Value> = (0..n)
            .map(|i| json!({"chunk_no": i as i64, "text": format!("块{i}"), "page_from": 1, "page_to": 1}))
            .collect();
        for (batch_idx, batch) in chunks.chunks(4000).enumerate() {
            write_batch(
                e,
                &json!({"document_id": id, "chunks": batch}),
            )
            .unwrap();
        }
        update_status(e, &json!({"id": id, "status": "ready"})).unwrap();

        let mut bases: Vec<Vec<f32>> = Vec::new();
        for c in 0..8 {
            let mut b = vec![0.0f32; dim];
            for d in 0..dim {
                b[d] = if (c + d) % 2 == 0 { 1.0 } else { 0.25 } + (c as f32) * 0.01;
            }
            let norm = b.iter().map(|x| x * x).sum::<f32>().sqrt();
            bases.push(b.iter().map(|x| x / norm).collect());
        }
        let mut vectors = Vec::with_capacity(n);
        let mut rng = Lcg::new(42);
        for i in 0..n {
            let base = &bases[i % 8];
            let v: Vec<f32> = (0..dim)
                .map(|d| base[d] + (rng.unit() as f32 - 0.5) * 0.08)
                .collect();
            vectors.push(v);
        }
        for batch in vectors.chunks(250) {
            let items: Vec<Value> = batch
                .iter()
                .enumerate()
                .map(|(j, v)| {
                    let chunk_no = (items_offset(&vectors, batch) + j) as i64;
                    json!({"chunk_no": chunk_no, "vector": v})
                })
                .collect();
            vector_upsert(
                e,
                &json!({"document_id": id, "model": "m", "vectors": items}),
            )
            .unwrap();
        }
        vectors
    }

    fn items_offset(all: &[Vec<f32>], batch: &[Vec<f32>]) -> usize {
        let base = all.as_ptr() as usize;
        let cur = batch.as_ptr() as usize;
        cur.saturating_sub(base) / std::mem::size_of::<Vec<f32>>()
    }

    #[test]
    fn ivf_train_then_ann_search_keeps_recall() {
        let e = engine();
        let n = 1200usize;
        let dim = 16usize;
        let vectors = seed_clustered_vectors(&e, "ann", n, dim);

        // 训练前：全量扫描，ann=false
        let brute_before = vector_search(
            &e,
            &json!({"collection_id": "ann", "query_vector": vectors[7], "limit": 10, "force_brute": true}),
        )
        .unwrap();
        assert_eq!(brute_before["ann"], false);

        let trained = vector_train(&e, &json!({"collection_id": "ann"})).unwrap();
        assert_eq!(trained["trained"], true, "{trained}");
        assert_eq!(trained["count"], n);
        assert!(trained["k"].as_i64().unwrap() >= 8);

        let status = vector_status(&e, &json!({"collection_id": "ann"})).unwrap();
        assert_eq!(status["assigned"], n);
        assert_eq!(status["quantized"], n, "训练后必须回填 int8 向量");
        assert!(status["meta"].is_object());

        // 同一查询：ANN 与全量扫描的 top10 重合度（recall）必须足够高
        let query = &vectors[7];
        let brute = vector_search(
            &e,
            &json!({"collection_id": "ann", "query_vector": query, "limit": 10, "force_brute": true}),
        )
        .unwrap();
        let ann = vector_search(
            &e,
            &json!({"collection_id": "ann", "query_vector": query, "limit": 10, "nprobe": 8}),
        )
        .unwrap();
        assert_eq!(ann["ann"], true, "{ann}");
        assert_eq!(ann["quantized"], true);
        assert!(ann["rerank"].as_i64().unwrap() >= 10);
        // 重排必须回到原向量分数：只做近似而不重排 → 分数对不上（变异会红）
        let score_of = |v: &Value| v["items"][0]["score"].as_f64().unwrap();
        assert!(
            (score_of(&ann) - score_of(&brute)).abs() < 1e-5,
            "量化近似后必须精确重排"
        );
        assert!(ann["candidates"].as_i64().unwrap() < n as i64);
        let keys = |v: &Value| -> std::collections::HashSet<(String, i64)> {
            v["items"]
                .as_array()
                .unwrap()
                .iter()
                .map(|x| {
                    (
                        x["document_id"].as_str().unwrap().to_string(),
                        x["chunk_no"].as_i64().unwrap(),
                    )
                })
                .collect()
        };
        let b = keys(&brute);
        let a = keys(&ann);
        let hit = a.intersection(&b).count();
        assert!(
            hit >= 8,
            "ANN recall 太低：{hit}/10（brute={b:?} ann={a:?}）"
        );
    }

    #[test]
    fn quantized_search_falls_back_for_rows_without_qvector() {
        let e = engine();
        let vectors = seed_clustered_vectors(&e, "legacy-q", 1200, 8);
        vector_train(&e, &json!({"collection_id": "legacy-q"})).unwrap();
        // 模拟升级前写入的老行：qvector/qscale 为空
        e.write_tx(|tx| {
            tx.execute(
                "UPDATE document_vectors SET qvector=NULL, qscale=NULL \
                 WHERE document_id=(SELECT id FROM documents WHERE collection_id='legacy-q') \
                 AND chunk_no=0",
                [],
            )
            .map_err(DbError::from)?;
            Ok(())
        })
        .unwrap();
        let hit = vector_search(
            &e,
            &json!({"collection_id": "legacy-q", "query_vector": vectors[0], "limit": 5}),
        )
        .unwrap();
        assert_eq!(hit["quantized"], true);
        assert_eq!(hit["items"][0]["chunk_no"], 0, "缺 qvector 的老行仍要能精确命中");
    }

    #[test]
    fn ivf_train_refuses_small_collections_and_keeps_bruteforce() {
        let e = engine();
        let _ = seed_clustered_vectors(&e, "small", 20, 8);
        let r = vector_train(&e, &json!({"collection_id": "small"})).unwrap();
        assert_eq!(r["trained"], false);
        let hit = vector_search(
            &e,
            &json!({"collection_id": "small", "query_vector": [1, 0, 0, 0, 0, 0, 0, 0], "limit": 3}),
        )
        .unwrap();
        assert_eq!(hit["ann"], false);
        assert_eq!(hit["items"].as_array().unwrap().len(), 3);
    }

    #[test]
    #[ignore = "大规模基准：DOC_VEC_BENCH_N 可调，默认 10 万 × 32 维"]
    fn bench_ivf_large_scale() {
        let n: usize = std::env::var("DOC_VEC_BENCH_N")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(100_000);
        let dim = 32usize;
        let e = engine();
        let vectors = seed_clustered_vectors(&e, "bench", n, dim);
        let t0 = std::time::Instant::now();
        let trained = vector_train(&e, &json!({"collection_id": "bench"})).unwrap();
        let train_ms = t0.elapsed().as_millis();
        assert_eq!(trained["trained"], true);
        let k = trained["k"].as_i64().unwrap();

        let mut brute_ms = Vec::new();
        let mut float_ms = Vec::new();
        let mut q_ms = Vec::new();
        let mut float_hits = 0usize;
        let mut q_hits = 0usize;
        for i in 0..20 {
            let q = &vectors[(i * 7919) % n];
            let t = std::time::Instant::now();
            let brute = vector_search(
                &e,
                &json!({"collection_id": "bench", "query_vector": q, "limit": 10, "force_brute": true}),
            )
            .unwrap();
            brute_ms.push(t.elapsed().as_millis() as i64);
            let t = std::time::Instant::now();
            let float_ann = vector_search(
                &e,
                &json!({"collection_id": "bench", "query_vector": q, "limit": 10, "nprobe": 16, "force_float": true}),
            )
            .unwrap();
            float_ms.push(t.elapsed().as_millis() as i64);
            let t = std::time::Instant::now();
            let qann = vector_search(
                &e,
                &json!({"collection_id": "bench", "query_vector": q, "limit": 10, "nprobe": 16}),
            )
            .unwrap();
            q_ms.push(t.elapsed().as_millis() as i64);
            let keys = |v: &Value| -> std::collections::HashSet<_> {
                v["items"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|x| (x["document_id"].as_str().unwrap().to_string(), x["chunk_no"].as_i64().unwrap()))
                    .collect()
            };
            let b = keys(&brute);
            float_hits += keys(&float_ann).intersection(&b).count();
            q_hits += keys(&qann).intersection(&b).count();
        }
        let median = |v: &mut Vec<i64>| {
            v.sort_unstable();
            v[v.len() / 2]
        };
        println!(
            "VEC-BENCH n={n} dim={dim} k={k} train={train_ms}ms brute_med={}ms float_ann_med={}ms q_ann_med={}ms float_recall@10={:.3} q_recall@10={:.3}",
            median(&mut brute_ms),
            median(&mut float_ms),
            median(&mut q_ms),
            float_hits as f64 / 200.0,
            q_hits as f64 / 200.0
        );
    }

    #[test]
    fn vector_search_ranks_by_cosine_and_isolates_collections() {
        let e = engine();
        let id1 = upsert(&e, "p1", "blob:v1");
        let id2 = upsert(&e, "p2", "blob:v2");
        for id in [id1.clone(), id2.clone()] {
            write_batch(
                &e,
                &json!({
                    "document_id": id,
                    "chunks": [
                        {"chunk_no": 0, "text": "迁移目标", "page_from": 1, "page_to": 1},
                        {"chunk_no": 1, "text": "第二块", "page_from": 2, "page_to": 2}
                    ]
                }),
            )
            .unwrap();
            update_status(&e, &json!({ "id": id, "status": "ready" })).unwrap();
        }

        vector_upsert(
            &e,
            &json!({
                "document_id": id1,
                "model": "m1",
                "vectors": [
                    {"chunk_no": 0, "vector": [1.0, 0.0]},
                    {"chunk_no": 1, "vector": [0.0, 1.0]}
                ]
            }),
        )
        .unwrap();
        vector_upsert(
            &e,
            &json!({
                "document_id": id2,
                "model": "m1",
                "vectors": [{"chunk_no": 0, "vector": [1.0, 0.0]}]
            }),
        )
        .unwrap();

        // 归一化：查询 [3,4] 与 [1,0] 的 cosine = 0.6；排序按相似度而非模长
        let hit = vector_search(
            &e,
            &json!({"collection_id": "p1", "query_vector": [3.0, 4.0], "limit": 10}),
        )
        .unwrap();
        let items = hit["items"].as_array().unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0]["chunk_no"], 1, "查询 [3,4] 与 [0,1] 更接近");
        assert!((items[0]["score"].as_f64().unwrap() - 0.8).abs() < 1e-5);
        assert_eq!(items[1]["chunk_no"], 0);
        assert!((items[1]["score"].as_f64().unwrap() - 0.6).abs() < 1e-5);

        // 集合隔离：p1 检索不到 p2，即使向量相同
        let leaked = vector_search(
            &e,
            &json!({"collection_id": "p1", "query_vector": [1.0, 0.0], "document_ids": [id2]}),
        )
        .unwrap();
        assert_eq!(leaked["items"].as_array().unwrap().len(), 0);

        // 状态可见
        let status = vector_status(&e, &json!({"document_id": id1})).unwrap();
        assert_eq!(status["items"][0]["chunks"], 2);
        assert_eq!(status["items"][0]["dim"], 2);

        // 零向量/坏维度必须显式失败
        assert!(vector_upsert(
            &e,
            &json!({"document_id": id1, "vectors": [{"chunk_no": 0, "vector": [0.0, 0.0]}]})
        )
        .is_err());
        assert!(vector_upsert(
            &e,
            &json!({"document_id": id1, "vectors": [
                {"chunk_no": 0, "vector": [1.0, 0.0]},
                {"chunk_no": 1, "vector": [1.0]}
            ]})
        )
        .is_err());
    }

    #[test]
    fn reset_clears_everything_but_keeps_schema() {
        let e = engine();
        let id = upsert(&e, "p1", "blob:aaa");
        write_batch(
            &e,
            &json!({"document_id": id, "chunks": [{"chunk_no":0,"text":"迁移"}]}),
        )
        .unwrap();

        // 先证明「重置前能搜到」——否则「重置后搜不到」可能只是因为根本没写进 FTS。
        let before = search(&e, &json!({"collection_id": "p1", "query": "迁移", "limit": 5})).unwrap();
        assert_eq!(
            before["items"].as_array().unwrap().len(),
            1,
            "前置：重置前 FTS 应能检索到该块"
        );

        reset(&e, &json!({})).unwrap();
        let h = health(&e).unwrap();
        assert_eq!(h["documents"], 0);
        assert_eq!(h["chunks"], 0);
        assert_eq!(h["schema_version"], DOCS_SCHEMA_VERSION);
        assert_eq!(h["fts_rows"], 0, "重置后 FTS 行数必须为 0（不能留幽灵行）");

        // DOCI-11：重置必须连 FTS 一起清（只删 documents/chunks 会留下"搜得到、读不到"的幽灵行）
        let after = search(&e, &json!({"collection_id": "p1", "query": "迁移", "limit": 5})).unwrap();
        assert_eq!(
            after["items"].as_array().unwrap().len(),
            0,
            "重置后 FTS 必须清空"
        );
    }

    #[test]
    fn ocr_pages_are_written_and_document_becomes_ready() {
        let e = engine();
        let id = upsert(&e, "p1", "blob:ocr");
        write_batch(
            &e,
            &json!({
                "document_id": id,
                "pages": [
                    {"page_no": 1, "kind": "scanned", "text_source": "layout", "text_bytes": 0},
                    {"page_no": 2, "kind": "scanned", "text_source": "layout", "text_bytes": 0}
                ],
                "chunks": []
            }),
        )
        .unwrap();

        let pending = ocr_pending(&e, &json!({"document_id": id})).unwrap();
        assert_eq!(pending["pages"].as_array().unwrap().len(), 2, "两页都应待 OCR");

        let first = "第一页视觉转录：迁移的目标与步骤。";
        write_ocr_page(
            &e,
            &json!({
                "document_id": id, "page_no": 1, "text": first,
                "model": "deepseek-flash", "heading": "第1页（视觉转录）",
                "text_offset": 0, "text_len": first.len() as i64
            }),
        )
        .unwrap();
        let pending = ocr_pending(&e, &json!({"document_id": id})).unwrap();
        assert_eq!(pending["pages"].as_array().unwrap().len(), 1, "第 1 页完成后只剩第 2 页");

        let second = "第二页视觉转录：验收与回滚。";
        write_ocr_page(
            &e,
            &json!({
                "document_id": id, "page_no": 2, "text": second,
                "model": "deepseek-flash", "heading": "第2页（视觉转录）",
                "text_offset": (first.len() + 2) as i64, "text_len": second.len() as i64
            }),
        )
        .unwrap();

        let fin = ocr_finish(&e, &json!({"document_id": id})).unwrap();
        assert_eq!(fin["remaining"], 0);
        assert_eq!(fin["status"], "ready");
        assert_eq!(fin["chunk_count"], 2);

        // 转录文本必须可检索、可按页读回
        let hits = search(&e, &json!({"collection_id": "p1", "query": "迁移", "limit": 5})).unwrap();
        let items = hits["items"].as_array().unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["page_from"], 1);
        assert!(items[0]["heading_path"].as_str().unwrap().contains("视觉转录"));

        let chunks = read_chunks(&e, &json!({"document_id": id, "limit": 10})).unwrap();
        let rows = chunks["items"].as_array().unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[1]["page_from"], 2);

        let page_rows = read_pages(&e, &json!({"document_id": id})).unwrap();
        let pages_arr = page_rows["items"].as_array().unwrap();
        assert_eq!(pages_arr[0]["ocr_state"], "done");
        assert_eq!(pages_arr[0]["ocr_model"], "deepseek-flash");

        // 页级失败：标 failed 后必须重新出现在待转录列表（可重试），且文档不再算 ready
        mark_ocr_failed(&e, &json!({"document_id": id, "page_no": 1})).unwrap();
        let retry = ocr_pending(&e, &json!({"document_id": id})).unwrap();
        assert_eq!(retry["pages"].as_array().unwrap()[0]["page_no"], 1);
        let after_fail = ocr_finish(&e, &json!({"document_id": id})).unwrap();
        assert_eq!(after_fail["status"], "needs_ocr");
    }
}