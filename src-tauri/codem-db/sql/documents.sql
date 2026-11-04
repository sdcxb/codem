-- ═══════════════════════════════════════════════════════════════════════════
-- 项目级文档索引库（独立 SQLite，**可重建**）
--
-- 位置：<dataRoot>/documents/index.db
-- 权威：<dataRoot>/documents/blobs/<sha256>（原文件）+ text/<sha256>.txt（规范化正文）
-- 本库是**索引与元数据**：损坏/删除后可由 `documents.rebuild` 从 blob 重建。
--
-- 为什么独立于会话主库（codem-db/sql/schema.sql）：
--   1GB 文档的索引可达 GB 级，塞进会话主库会拖慢 VACUUM/checkpoint/损坏恢复/备份；
--   主库是「用户数据、不可重建」，文档索引是「缓存、可重建」，两者生命周期不同。
--
-- FTS5 虚拟表 `documents_fts` **不在这里**：它在 docs.rs 里按 `CREATE VIRTUAL TABLE`
-- 创建（与主库 `session_fts` 同一惯例；schema.sql 的建表语句解析器只认普通表）。
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  collection_id TEXT NOT NULL,
  kind TEXT NOT NULL,              -- attachment | paste | path | drop
  source_ref TEXT,                 -- 附件 id / 规范化路径 / blob sha
  dedupe_key TEXT NOT NULL,        -- blob:<sha256> | path:<归一化路径>
  name TEXT,
  mime TEXT,
  size INTEGER DEFAULT 0,
  sha256 TEXT,
  mtime INTEGER,
  page_count INTEGER DEFAULT 0,
  block_count INTEGER DEFAULT 0,
  chunk_count INTEGER DEFAULT 0,
  text_bytes INTEGER DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT,
  outline_json TEXT,
  extractor_version INTEGER DEFAULT 0,
  metadata_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(collection_id, dedupe_key)
);

CREATE INDEX IF NOT EXISTS idx_documents_collection ON documents(collection_id, status);
CREATE INDEX IF NOT EXISTS idx_documents_sha ON documents(sha256);

-- 每页的类别与文本来源（Q6：文本页 / 图片页 / 混合页）
CREATE TABLE IF NOT EXISTS document_pages (
  document_id TEXT NOT NULL,
  page_no INTEGER NOT NULL,
  kind TEXT,                       -- text | scanned | mixed | blank
  text_source TEXT,                -- layout | vision | none
  text_bytes INTEGER DEFAULT 0,
  ocr_state TEXT,                  -- none | pending | done | failed | skipped
  ocr_model TEXT,
  image_path TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (document_id, page_no),
  FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
);

-- 结构块：标题 / 段落 / 表格 / 图注；offset 指向 text/<sha>.txt
CREATE TABLE IF NOT EXISTS document_blocks (
  document_id TEXT NOT NULL,
  block_no INTEGER NOT NULL,
  page_no INTEGER NOT NULL DEFAULT 0,
  kind TEXT NOT NULL DEFAULT 'paragraph',
  heading_path TEXT,
  text_offset INTEGER NOT NULL,
  text_len INTEGER NOT NULL,
  PRIMARY KEY (document_id, block_no),
  FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
);

-- 分块：**不存正文**，只存 offset/len/preview（正文在侧车文件里按需 seek）
CREATE TABLE IF NOT EXISTS document_chunks (
  document_id TEXT NOT NULL,
  chunk_no INTEGER NOT NULL,
  page_from INTEGER DEFAULT 0,
  page_to INTEGER DEFAULT 0,
  heading_path TEXT,
  text_offset INTEGER NOT NULL,
  text_len INTEGER NOT NULL,
  token_count INTEGER DEFAULT 0,
  preview TEXT,
  PRIMARY KEY (document_id, chunk_no),
  FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_document_chunks_doc ON document_chunks(document_id, chunk_no);

-- 摄取检查点：崩溃/取消后可续跑（按阶段 + 已完成计数）
CREATE TABLE IF NOT EXISTS document_ingest_state (
  document_id TEXT PRIMARY KEY,
  phase TEXT,
  bytes_done INTEGER DEFAULT 0,
  pages_done INTEGER DEFAULT 0,
  chunks_done INTEGER DEFAULT 0,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
);

-- 向量索引（可选能力）：每块一个归一化 f32 向量（little-endian BLOB）。
-- 与 FTS 并存：没有 embedding 配置时本表为空，检索行为完全不变（纯 FTS）。
CREATE TABLE IF NOT EXISTS document_vectors (
  document_id TEXT NOT NULL,
  chunk_no INTEGER NOT NULL,
  model TEXT NOT NULL,
  dim INTEGER NOT NULL,
  vector BLOB NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (document_id, chunk_no),
  FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_document_vectors_model ON document_vectors(model);
