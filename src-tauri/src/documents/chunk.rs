//! 分块流水线：**流式**写正文侧车 + 结构块 + 分块 + FTS。
//!
//! ## 为什么是流式（1GB 的硬约束）
//!
//! 1GB 文本整读进内存就是 1–3GB 的常驻占用；提取器因此只负责「按块吐文本」，
//! 这里边写文件边攒块：内存里只保留**当前分块**（≤~1,500 token）与少量批次。
//!
//! ## 分块规则（ADR-0008 §7.1）
//!
//! - 目标 800 token/块（中文 1 字 ≈ 1 token，英文 4 字符 ≈ 1 token）；
//! - 块间重叠 12%（用上一块尾部字符作为下一块前缀，offset 相应回退）；
//! - **标题边界不跨越**：`end_block` 时若当前块已达标就切；
//! - 分块 `chunk_no` 严格递增，重复摄取按 `chunk_no` 覆盖（幂等，靠 `docs::write_batch` 的 upsert）。
//!
//! ## 偏移语义
//!
//! `text_offset` / `text_len` 都是**字节**（UTF-8），指向 `text/<sha>.txt`；
//! `preview` 按字符截断（给 UI/模型看）。读取侧按字节 seek + 边界安全解码。

use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

use codem_db::docs::DocsEngine;
use serde_json::json;

/// 目标分块大小（token）。
pub const CHUNK_TARGET_TOKENS: usize = 800;
/// 块间重叠占块长的比例（12%）。
pub const CHUNK_OVERLAP_RATIO: f64 = 0.12;
/// 单块字节硬上限（防止一条超长段落把内存顶爆）。
pub const CHUNK_MAX_BYTES: usize = 64 * 1024;
/// 每批写入的分块数（`docs::write_batch` 允许 4096；这里保守取 64，进度更细）。
const FLUSH_CHUNKS: usize = 64;
/// 批间隔（秒）：长文档也要让 UI 看到进度。
const FLUSH_INTERVAL_SECS: f64 = 1.0;

/// 提取器向流水线吐内容的接口（不关心 DB/文件，便于单测）。
pub trait Sink {
    /// 开始一个结构块（标题 / 段落 / 表格行 / 幻灯片段落…）。
    fn begin_block(&mut self, page: i64, kind: &str, heading: Option<String>);
    /// 追加块内文本。
    fn push_text(&mut self, text: &str);
    /// 结束当前块（记录 offset/length，必要时切分块）。
    fn end_block(&mut self);
    /// 记录一页的类别与文本来源。
    fn page(&mut self, page: i64, kind: &str, text_source: &str, text_bytes: i64);
    /// 进度（字节数 / 已完成页数）。
    fn progress(&mut self, bytes: u64, pages: i64);
    /// 取消标志（提取器在页/段边界检查）。
    fn is_cancelled(&self) -> bool;
}

/// 估算 token：CJK 每字约 1 token，其他字符约 4 字符/token（与渲染侧同口径）。
pub fn estimate_tokens(text: &str) -> usize {
    let mut cjk = 0usize;
    let mut other = 0usize;
    for ch in text.chars() {
        let c = ch as u32;
        let is_cjk = (0x3400..=0x9fff).contains(&c)
            || (0xf900..=0xfaff).contains(&c)
            || (0x3040..=0x30ff).contains(&c)
            || (0xac00..=0xd7af).contains(&c);
        if is_cjk {
            cjk += 1;
        } else {
            other += 1;
        }
    }
    cjk + (other + 3) / 4
}

/// 取 `text` 的**最长前缀字节长度**，使 `estimate_tokens(prefix) <= max_tokens`
/// （至少 1 个字符，避免预算为 0 时死循环；UTF-8 安全）。
fn token_prefix_len(text: &str, max_tokens: usize) -> usize {
    let mut cjk = 0usize;
    let mut other = 0usize;
    let mut bytes = 0usize;
    for ch in text.chars() {
        let c = ch as u32;
        let is_cjk = (0x3400..=0x9fff).contains(&c)
            || (0xf900..=0xfaff).contains(&c)
            || (0x3040..=0x30ff).contains(&c)
            || (0xac00..=0xd7af).contains(&c);
        let next_cjk = cjk + usize::from(is_cjk);
        let next_other = other + usize::from(!is_cjk);
        if next_cjk + (next_other + 3) / 4 > max_tokens {
            break;
        }
        cjk = next_cjk;
        other = next_other;
        bytes += ch.len_utf8();
    }
    if bytes == 0 {
        // 预算极小（或首字符就超）时仍前进一个字符，保证调用方循环能收敛
        text.chars().next().map(|c| c.len_utf8()).unwrap_or(0)
    } else {
        bytes
    }
}

/// 按字符取前缀（UTF-8 安全），用于 preview。
pub fn preview_of(text: &str, max_chars: usize) -> String {
    text.chars().take(max_chars).collect()
}

/// 续跑检查点（来自 `document_ingest_state` 与库内最大块号）。
///
/// 为什么按 **字节** 而不是「重跑整份」：1GiB 实测索引要 ~10 分钟，
/// 取消/崩溃后从头再来会让用户等两遍；检查点保证已完成的部分不重算。
#[derive(Debug, Clone, Copy)]
pub struct ResumePoint {
    /// 已写入正文侧车的字节数（也是下一块的起始 offset）
    pub bytes: i64,
    /// 下一个分块号（= 已落库块数）
    pub chunk_no: i64,
    /// 下一个块号
    pub block_no: i64,
    /// 已完成页数（PDF 从这一页之后继续）
    pub pages: i64,
}

/// 流式分块写入器。
pub struct Pipeline<'a> {
    engine: &'a DocsEngine,
    document_id: String,
    tmp_path: PathBuf,
    final_path: PathBuf,
    file: BufWriter<File>,

    offset: i64,
    block_start: i64,
    block_page: i64,
    block_kind: String,
    heading: Option<String>,

    chunk_buf: String,
    /// 已处理字节（供摄取期进度事件读取；原子量，避免把整个 Pipeline 共享出去）
    progress_bytes: Arc<std::sync::atomic::AtomicI64>,
    /// 当前缓冲的累计 token（**增量维护**：不能每次 push 都全量重扫，否则 1GB 文件是 O(n²)）
    chunk_tokens: usize,
    chunk_page_from: i64,
    chunk_page_to: i64,
    chunk_heading: Option<String>,
    overlap_tail: String,

    chunk_no: i64,
    block_no: i64,
    page_count: i64,
    bytes_written: u64,

    pending_chunks: Vec<serde_json::Value>,
    pending_blocks: Vec<serde_json::Value>,
    pending_pages: Vec<serde_json::Value>,
    last_flush: Instant,

    cancelled: Arc<AtomicBool>,
    flushed_chunks: i64,
}

impl<'a> Pipeline<'a> {
    pub fn create(
        engine: &'a DocsEngine,
        document_id: impl Into<String>,
        tmp_path: PathBuf,
        final_path: PathBuf,
        cancelled: Arc<AtomicBool>,
    ) -> Result<Self, String> {
        Self::create_with_resume(engine, document_id, tmp_path, final_path, cancelled, None)
    }

    /// 创建（或从检查点续跑）分块流水线。
    ///
    /// 续跑时把 `.part` **截断到检查点字节数**：上次 flush 之后写入但没进索引的尾巴
    /// 必须丢弃，否则下次从同一页重提会重复，且 offset 与库内块对不上。
    pub fn create_with_resume(
        engine: &'a DocsEngine,
        document_id: impl Into<String>,
        tmp_path: PathBuf,
        final_path: PathBuf,
        cancelled: Arc<AtomicBool>,
        resume: Option<ResumePoint>,
    ) -> Result<Self, String> {
        if let Some(parent) = tmp_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("创建正文目录失败 {}: {e}", parent.display()))?;
        }
        let (file, offset, chunk_no, block_no, pages, bytes_written) = match resume {
            Some(rp) => {
                if !tmp_path.exists() {
                    return Err("检查点存在但正文 .part 已丢失，拒绝续跑".to_string());
                }
                let fh = std::fs::OpenOptions::new()
                    .read(true)
                    .write(true)
                    .open(&tmp_path)
                    .map_err(|e| format!("打开正文 .part 失败: {e}"))?;
                let len = fh.metadata().map_err(|e| e.to_string())?.len() as i64;
                if len < rp.bytes {
                    return Err(format!(
                        "正文 .part 比检查点短（{len} < {}），拒绝续跑",
                        rp.bytes
                    ));
                }
                fh.set_len(rp.bytes as u64)
                    .map_err(|e| format!("截断正文 .part 失败: {e}"))?;
                drop(fh);
                let f = std::fs::OpenOptions::new()
                    .append(true)
                    .open(&tmp_path)
                    .map_err(|e| format!("以追加方式打开正文 .part 失败: {e}"))?;
                (
                    f,
                    rp.bytes,
                    rp.chunk_no.max(0),
                    rp.block_no.max(0),
                    rp.pages.max(0),
                    rp.bytes.max(0) as u64,
                )
            }
            None => (
                File::create(&tmp_path).map_err(|e| format!("创建正文文件失败: {e}"))?,
                0,
                0,
                0,
                0,
                0,
            ),
        };
        Ok(Self {
            engine,
            document_id: document_id.into(),
            tmp_path,
            final_path,
            file: BufWriter::with_capacity(256 * 1024, file),
            offset,
            block_start: offset,
            block_page: 0,
            block_kind: "paragraph".to_string(),
            heading: None,
            chunk_buf: String::new(),
            progress_bytes: Arc::new(std::sync::atomic::AtomicI64::new(bytes_written as i64)),
            chunk_tokens: 0,
            chunk_page_from: 0,
            chunk_page_to: 0,
            chunk_heading: None,
            overlap_tail: String::new(),
            chunk_no,
            block_no,
            page_count: pages,
            bytes_written,
            pending_chunks: Vec::new(),
            pending_blocks: Vec::new(),
            pending_pages: Vec::new(),
            last_flush: Instant::now(),
            cancelled,
            flushed_chunks: chunk_no,
        })
    }

    pub fn cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Relaxed)
    }

    fn write_raw(&mut self, text: &str) -> Result<(), String> {
        self.file
            .write_all(text.as_bytes())
            .map_err(|e| format!("写正文失败: {e}"))?;
        let n = text.len() as i64;
        self.offset += n;
        self.bytes_written += n as u64;
        self.progress_bytes
            .store(self.bytes_written as i64, Ordering::Relaxed);
        Ok(())
    }

    /// 进度计数（已处理字节）：摄取线程可以拿它发 `document://progress`，不必共享 `&mut Pipeline`。
    pub fn progress_counter(&self) -> Arc<std::sync::atomic::AtomicI64> {
        self.progress_bytes.clone()
    }

    /// 把当前缓存切成一个分块（含前一块的尾部重叠）。
    fn emit_chunk(&mut self) -> Result<(), String> {
        if self.chunk_buf.trim().is_empty() {
            self.chunk_buf.clear();
            self.chunk_tokens = 0;
            return Ok(());
        }
        let mut text = String::with_capacity(self.overlap_tail.len() + self.chunk_buf.len());
        text.push_str(&self.overlap_tail);
        text.push_str(&self.chunk_buf);
        let len = text.len() as i64;
        let offset = (self.offset - len).max(0);
        let tokens = estimate_tokens(&text);
        let preview = preview_of(&text, 200);
        self.pending_chunks.push(json!({
            "chunk_no": self.chunk_no,
            "page_from": self.chunk_page_from,
            "page_to": self.chunk_page_to,
            "heading_path": self.chunk_heading.clone(),
            "text_offset": offset,
            "text_len": len,
            "token_count": tokens as i64,
            "preview": preview,
            "text": text,
        }));
        self.flushed_chunks += 1;
        self.chunk_no += 1;

        // 下一块的重叠前缀：保留尾部 12%（按字符切，避免切坏 UTF-8）
        let overlap_chars = ((text.chars().count() as f64) * CHUNK_OVERLAP_RATIO).round() as usize;
        self.overlap_tail = if overlap_chars == 0 {
            String::new()
        } else {
            let skip = text.chars().count().saturating_sub(overlap_chars);
            text.chars().skip(skip).collect()
        };
        self.chunk_buf.clear();
        self.chunk_tokens = 0;
        self.chunk_page_from = self.block_page;
        self.chunk_page_to = self.block_page;
        self.chunk_heading = self.heading.clone();

        if self.pending_chunks.len() >= FLUSH_CHUNKS {
            self.flush()?;
        }
        Ok(())
    }

    /// 把挂起的页/块/分块写进索引库（一个事务），并更新检查点。
    pub fn flush(&mut self) -> Result<(), String> {
        if self.pending_chunks.is_empty()
            && self.pending_blocks.is_empty()
            && self.pending_pages.is_empty()
        {
            return Ok(());
        }
        let params = json!({
            "document_id": self.document_id.clone(),
            "pages": std::mem::take(&mut self.pending_pages),
            "blocks": std::mem::take(&mut self.pending_blocks),
            "chunks": std::mem::take(&mut self.pending_chunks),
            "state": {
                "phase": "index",
                "bytes_done": self.bytes_written as i64,
                "pages_done": self.page_count,
                "chunks_done": self.chunk_no,
            }
        });
        codem_db::docs::write_batch(self.engine, &params)
            .map_err(|e| format!("写文档索引失败: {e}"))?;
        self.last_flush = Instant::now();
        Ok(())
    }

    fn maybe_flush_by_time(&mut self) -> Result<(), String> {
        if self.last_flush.elapsed().as_secs_f64() >= FLUSH_INTERVAL_SECS {
            self.flush()?;
        }
        Ok(())
    }

    /// 收尾：写完最后一块、落盘、原子改名、最后一次 flush。
    pub fn finish(mut self) -> Result<PipelineStats, String> {
        self.emit_chunk()?;
        self.flush()?;
        self.file
            .flush()
            .map_err(|e| format!("刷正文文件失败: {e}"))?;
        drop(self.file);

        if let Some(parent) = self.final_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("创建正文目录失败: {e}"))?;
        }
        std::fs::rename(&self.tmp_path, &self.final_path)
            .map_err(|e| format!("正文文件改名失败: {e}"))?;

        Ok(PipelineStats {
            chunk_count: self.chunk_no,
            block_count: self.block_no,
            page_count: self.page_count,
            text_bytes: self.bytes_written as i64,
        })
    }

    /// 取消：保留已写入内容，删除半成品正文文件（下次重跑会重建）。
    pub fn abort(mut self) {
        // 先把已解析的部分落库，形成一致的检查点；失败也只影响这次 flush。
        if let Err(e) = self.flush() {
            eprintln!("[documents] abort flush 失败（检查点可能落后，但不会损坏已落库内容）: {e}");
        }
        let _ = self.file.flush();
        drop(self.file);
        // **不删除** .part：同一 sha 的下一次 ingest 会从检查点续跑；成功后 rename 覆盖。
    }
}

impl<'a> Sink for Pipeline<'a> {
    fn begin_block(&mut self, page: i64, kind: &str, heading: Option<String>) {
        self.block_start = self.offset;
        self.block_page = page;
        self.block_kind = kind.to_string();
        self.heading = heading;
        if self.chunk_buf.is_empty() {
            self.chunk_page_from = page;
            self.chunk_heading.clone_from(&self.heading);
        }
        self.chunk_page_to = page;
    }

    fn push_text(&mut self, text: &str) {
        if text.is_empty() {
            return;
        }
        if let Err(e) = self.write_raw(text) {
            // 写失败没有可恢复路径：把错误记到取消标志上，由调用方在结束时读取。
            eprintln!("[documents] {e}");
            self.cancelled.store(true, Ordering::Relaxed);
            return;
        }
        /*
         * 按 token 预算**切分**后入缓冲，而不是整段塞进去。
         *
         * 调用方按段 `push_text`（普通文本一段最多约 5,000 字符），整段入缓冲会让
         * 一块变成 5,000 token —— 远超 800 token 的目标，检索命中粒度变粗、
         * `doc_read` 一次读太多。切分后不管上游给多大一段，单块都受目标约束。
         */
        let mut rest = text;
        while !rest.is_empty() {
            let remaining = CHUNK_TARGET_TOKENS.saturating_sub(self.chunk_tokens).max(1);
            let take = token_prefix_len(rest, remaining);
            let piece = &rest[..take];
            self.chunk_buf.push_str(piece);
            self.chunk_tokens += estimate_tokens(piece);
            rest = &rest[take..];

            if self.chunk_tokens >= CHUNK_TARGET_TOKENS
                || self.chunk_buf.len() >= CHUNK_MAX_BYTES
            {
                if let Err(e) = self.emit_chunk().and_then(|_| self.maybe_flush_by_time()) {
                    eprintln!("[documents] {e}");
                    self.cancelled.store(true, Ordering::Relaxed);
                    return;
                }
            }
        }
    }

    fn end_block(&mut self) {
        let len = (self.offset - self.block_start).max(0);
        if len > 0 {
            self.pending_blocks.push(json!({
                "block_no": self.block_no,
                "page_no": self.block_page,
                "kind": self.block_kind,
                "heading_path": self.heading.clone(),
                "text_offset": self.block_start,
                "text_len": len,
            }));
            self.block_no += 1;
        }
        if self.chunk_tokens >= CHUNK_TARGET_TOKENS {
            if let Err(e) = self.emit_chunk() {
                eprintln!("[documents] {e}");
                self.cancelled.store(true, Ordering::Relaxed);
            }
        }
    }

    fn page(&mut self, page: i64, kind: &str, text_source: &str, text_bytes: i64) {
        self.page_count += 1;
        self.pending_pages.push(json!({
            "page_no": page,
            "kind": kind,
            "text_source": text_source,
            "text_bytes": text_bytes,
            "ocr_state": if kind == "scanned" { "pending" } else { "none" },
        }));
        if self.pending_pages.len() >= 256 {
            if let Err(e) = self.flush() {
                eprintln!("[documents] {e}");
                self.cancelled.store(true, Ordering::Relaxed);
            }
        }
    }

    fn progress(&mut self, _bytes: u64, _pages: i64) {
        if let Err(e) = self.maybe_flush_by_time() {
            eprintln!("[documents] {e}");
            self.cancelled.store(true, Ordering::Relaxed);
        }
    }

    fn is_cancelled(&self) -> bool {
        self.cancelled()
    }
}

#[derive(Debug, Clone, Copy)]
pub struct PipelineStats {
    pub chunk_count: i64,
    pub block_count: i64,
    pub page_count: i64,
    pub text_bytes: i64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use codem_db::docs::{self, DocsEngine};
    use serde_json::json;
    use std::sync::atomic::AtomicBool;

    #[test]
    fn token_estimate_is_cjk_aware() {
        assert_eq!(estimate_tokens("存储迁移"), 4);
        assert_eq!(estimate_tokens("abcd"), 1);
        assert!(estimate_tokens("存储 migration") > 2);
    }

    #[test]
    fn preview_is_utf8_safe() {
        assert_eq!(preview_of("数据迁移方案", 2), "数据");
        assert_eq!(preview_of("abc", 10), "abc");
    }

    /// DOCI-5：结构感知分块 —— 块大小受控、偏移可回读、重复摄取幂等。
    #[test]
    fn pipeline_chunks_structure_and_is_idempotent() {
        let engine = DocsEngine::open_in_memory().expect("engine");
        let id = docs::upsert_document(
            &engine,
            &json!({
                "collection_id": "p1",
                "kind": "attachment",
                "dedupe_key": "blob:aaa",
                "name": "报告.docx",
                "status": "extracting"
            }),
        )
        .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_string();

        let dir = tempfile::tempdir().unwrap();
        let tmp = dir.path().join("a.txt.part");
        let final_path = dir.path().join("a.txt");
        let cancel = Arc::new(AtomicBool::new(false));

        let run = |engine: &DocsEngine| {
            let mut pipeline = Pipeline::create(
                engine,
                id.clone(),
                tmp.clone(),
                final_path.clone(),
                cancel.clone(),
            )
            .unwrap();
            // 两个标题 + 每段 300 个汉字（约 300 token）⇒ 目标 800 token 会跨段合并
            for i in 0..8 {
                let (page, kind, heading) = if i == 0 {
                    (1, "heading", Some("第一章 总则".to_string()))
                } else if i == 4 {
                    (2, "heading", Some("第二章 迁移".to_string()))
                } else {
                    (1 + i / 4, "paragraph", Some("第一章 总则".to_string()))
                };
                pipeline.begin_block(page, kind, heading);
                pipeline.push_text(&"数据迁移的目标与步骤".repeat(30));
                pipeline.push_text("\n\n");
                pipeline.end_block();
            }
            pipeline.finish().unwrap()
        };

        let stats = run(&engine);
        assert!(stats.chunk_count >= 2, "应切成多块：{}", stats.chunk_count);
        assert!(stats.text_bytes > 0);

        let rows = docs::read_chunks(&engine, &json!({"document_id": id, "limit": 100})).unwrap();
        let items = rows["items"].as_array().unwrap();
        assert_eq!(items.len() as i64, stats.chunk_count, "块数应与统计一致");
        for item in items {
            let tokens = item["token_count"].as_i64().unwrap();
            // 目标 800 + 12% 重叠；上限留出「一段超过目标才切」的余量
            assert!(tokens <= 1400, "单块 token 过大：{tokens}");
            let offset = item["text_offset"].as_i64().unwrap();
            let len = item["text_len"].as_i64().unwrap();
            assert!(offset >= 0 && len > 0);
        }
        // 偏移可回读：按 offset/len 从侧车切片，内容应包含正文关键字
        let text = std::fs::read_to_string(&final_path).unwrap();
        let first_item = &items[0];
        let off = first_item["text_offset"].as_i64().unwrap() as usize;
        let len = first_item["text_len"].as_i64().unwrap() as usize;
        let slice = &text[off..off + len];
        assert!(slice.contains("第一章") || slice.contains("数据迁移"));

        // 幂等：同一 id 重跑，块数不变（`write_batch` 按 chunk_no 覆盖）
        let stats2 = run(&engine);
        let rows2 = docs::read_chunks(&engine, &json!({"document_id": id, "limit": 100})).unwrap();
        assert_eq!(rows2["items"].as_array().unwrap().len(), items.len());
        assert_eq!(stats2.chunk_count, stats.chunk_count);
    }

    /// 按字节续跑：abort 保留 `.part` + 检查点；下次从 offset/chunk_no 续写，
    /// 已落库的块不重复、偏移仍能从最终侧车正确回读。
    #[test]
    fn pipeline_resumes_from_checkpoint_without_duplicating_chunks() {
        let engine = DocsEngine::open_in_memory().unwrap();
        let id = docs::upsert_document(
            &engine,
            &json!({"collection_id":"p1","kind":"attachment","dedupe_key":"blob:resume","name":"r.pdf"}),
        )
        .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_string();
        let dir = tempfile::tempdir().unwrap();
        let tmp = dir.path().join("text.part");
        let done = dir.path().join("text.txt");
        let cancel = Arc::new(AtomicBool::new(false));

        {
            let mut p = Pipeline::create(&engine, &id, tmp.clone(), done.clone(), cancel.clone())
                .unwrap();
            p.begin_block(1, "paragraph", None);
            p.push_text("第一段：迁移目标与范围。");
            p.end_block();
            p.page(1, "text", "layout", 0);
            p.emit_chunk().unwrap();
            p.flush().unwrap();
            let cp = docs::resume_checkpoint(&engine, &json!({"document_id": id})).unwrap();
            assert!(cp["bytes_done"].as_i64().unwrap() > 0, "检查点必须记录字节数");
            assert!(cp["pages_done"].as_i64().unwrap() >= 1);
            p.abort();
        }
        assert!(tmp.exists(), "abort 必须保留 .part 供续跑");

        let cp = docs::resume_checkpoint(&engine, &json!({"document_id": id})).unwrap();
        let resume = ResumePoint {
            bytes: cp["bytes_done"].as_i64().unwrap(),
            chunk_no: cp["next_chunk_no"].as_i64().unwrap(),
            block_no: cp["next_block_no"].as_i64().unwrap(),
            pages: cp["pages_done"].as_i64().unwrap(),
        };
        assert!(resume.bytes > 0 && resume.chunk_no >= 1);

        let stats = {
            let mut p = Pipeline::create_with_resume(
                &engine,
                &id,
                tmp.clone(),
                done.clone(),
                cancel,
                Some(resume),
            )
            .unwrap();
            p.begin_block(2, "paragraph", Some("第二页".to_string()));
            p.push_text("第二段：验收与回滚。");
            p.end_block();
            p.finish().unwrap()
        };

        let text = std::fs::read_to_string(&done).unwrap();
        assert!(text.contains("第一段") && text.contains("第二段"), "续跑后正文应完整：{text}");
        assert!(!tmp.exists(), "完成后 .part 应被 rename 掉");

        let rows = docs::read_chunks(&engine, &json!({"document_id": id, "limit": 50})).unwrap();
        let items = rows["items"].as_array().unwrap();
        assert_eq!(items.len() as i64, stats.chunk_count, "块数不能因续跑翻倍");
        let mut nos: Vec<i64> = items.iter().map(|i| i["chunk_no"].as_i64().unwrap()).collect();
        nos.sort_unstable();
        nos.dedup();
        assert_eq!(nos.len(), items.len(), "chunk_no 必须唯一");

        for item in items {
            let off = item["text_offset"].as_i64().unwrap() as usize;
            let len = item["text_len"].as_i64().unwrap() as usize;
            assert!(off + len <= text.len(), "偏移越界：{off}+{len}>{})", text.len());
            assert!(!text[off..off + len].trim().is_empty());
        }
        for q in ["迁移", "验收"] {
            let hits = docs::search(&engine, &json!({"collection_id":"p1","query":q,"limit":5}))
                .unwrap();
            assert!(
                !hits["items"].as_array().unwrap().is_empty(),
                "续跑后应能检索到 {q}"
            );
        }
    }

    #[test]
    fn pipeline_honours_cancel_flag() {        let engine = DocsEngine::open_in_memory().unwrap();
        let id = docs::upsert_document(
            &engine,
            &json!({"collection_id":"p1","kind":"attachment","dedupe_key":"blob:bbb","name":"x"}),
        )
        .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_string();
        let dir = tempfile::tempdir().unwrap();
        let cancel = Arc::new(AtomicBool::new(false));
        let mut pipeline = Pipeline::create(
            &engine,
            id,
            dir.path().join("t.part"),
            dir.path().join("t.txt"),
            cancel.clone(),
        )
        .unwrap();
        assert!(!pipeline.is_cancelled());
        cancel.store(true, Ordering::Relaxed);
        assert!(pipeline.is_cancelled());
        pipeline.abort();
    }

    /// 峰值工作集（MiB）。Windows 用 `GetProcessMemoryInfo` 的 PeakWorkingSetSize；
    /// 其它平台返回 None（不猜）。只服务 DOCI-B1 的「内存不随文件线性增长」观测。
    fn peak_rss_mib() -> Option<f64> {
        #[cfg(windows)]
        {
            use windows::Win32::System::ProcessStatus::{
                GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS,
            };
            use windows::Win32::System::Threading::GetCurrentProcess;
            let mut counters = PROCESS_MEMORY_COUNTERS::default();
            let ok = unsafe {
                GetProcessMemoryInfo(
                    GetCurrentProcess(),
                    &mut counters,
                    std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32,
                )
                .is_ok()
            };
            if ok {
                Some(counters.PeakWorkingSetSize as f64 / 1_048_576.0)
            } else {
                None
            }
        }
        #[cfg(not(windows))]
        {
            None
        }
    }

    /// DOCI-B1：**大文件吞吐基准**（默认 64MiB；`DOC_BENCH_MB=1024` 跑 1GiB）。
    ///
    /// 量的是端到端：生成文本 → `extract_text` 流式读 → 分块 → SQLite/FTS 写入 → 收尾。
    /// 只允许显式跑（`--ignored --nocapture`）：它要写 1GB 级临时文件，不能进日常 CI。
    ///
    /// 说明：峰值 RSS 没有在这里量（标准库不提供可移植的读法），所以本基准只对
    /// 「吞吐 / 块数 / 索引体积」作数，**不对内存下结论**（ADR §14 的 RSS 目标另测）。
    #[test]
    #[ignore = "DOCI-B1 基准：DOC_BENCH_MB=1024 cargo test --lib bench_large_document -- --ignored --nocapture"]
    fn bench_large_document_indexing() {
        use std::io::Write as _;
        use std::time::Instant;

        let mb: usize = std::env::var("DOC_BENCH_MB")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(64);
        let target_bytes = mb.max(1) * 1024 * 1024;
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("bench.txt");

        // 生成：每 40 行一个二级标题；正文行约 60 个汉字（≈60 token）。
        {
            let file = std::fs::File::create(&src).unwrap();
            let mut out = std::io::BufWriter::with_capacity(1 << 20, file);
            let line = "数据迁移的目标与步骤说明，包含校验、回滚与验收口径，以及每一步的负责人。\n";
            let mut written = 0usize;
            let mut i = 0usize;
            while written < target_bytes {
                if i % 40 == 0 {
                    let h = format!("## 第{}章 迁移阶段\n", i / 40 + 1);
                    out.write_all(h.as_bytes()).unwrap();
                    written += h.len();
                }
                out.write_all(line.as_bytes()).unwrap();
                written += line.len();
                i += 1;
            }
            out.flush().unwrap();
        }

        let input_bytes = std::fs::metadata(&src).unwrap().len();
        let input_mib = input_bytes as f64 / 1_048_576.0;
        let db_path = dir.path().join("index.db");
        let engine = DocsEngine::open(&db_path).unwrap();
        let id = docs::upsert_document(
            &engine,
            &json!({
                "collection_id": "bench",
                "kind": "attachment",
                "dedupe_key": "blob:bench",
                "name": "bench.txt",
            }),
        )
        .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_string();

        let cancel = Arc::new(AtomicBool::new(false));
        let mut pipeline = Pipeline::create(
            &engine,
            id.clone(),
            dir.path().join("text.part"),
            dir.path().join("text.txt"),
            cancel,
        )
        .unwrap();

        let started = Instant::now();
        let outcome = crate::documents::extract::extract(&src, &mut pipeline).expect("extract");
        let stats = pipeline.finish().expect("finish");
        let elapsed = started.elapsed().as_secs_f64();
        let index_mib = std::fs::metadata(&db_path).unwrap().len() as f64 / 1_048_576.0;
        let text_mib =
            std::fs::metadata(dir.path().join("text.txt")).unwrap().len() as f64 / 1_048_576.0;

        println!(
            "[DOC-BENCH] input={input_mib:.1}MiB status={} pages={} blocks={} chunks={} \
             secs={elapsed:.2} throughput={:.1}MiB/s index={index_mib:.1}MiB text_out={text_mib:.1}MiB \
             peak_rss={}",
            outcome.status,
            outcome.page_count,
            stats.block_count,
            stats.chunk_count,
            input_mib / elapsed,
            peak_rss_mib()
                .map(|m| format!("{m:.1}MiB"))
                .unwrap_or_else(|| "unknown".to_string()),
        );

        assert_eq!(outcome.status, "ready");
        assert!(stats.chunk_count > 0, "必须有块");
        assert!(input_mib / elapsed > 0.0);

        // 抽样：第 0 块能按 offset/len 回读，且落在正文文件内
        let rows = docs::read_chunks(&engine, &json!({"document_id": id, "limit": 1})).unwrap();
        let first = &rows["items"][0];
        let off = first["text_offset"].as_i64().unwrap() as u64;
        let len = first["text_len"].as_i64().unwrap() as u64;
        let text_len = std::fs::metadata(dir.path().join("text.txt")).unwrap().len();
        assert!(off + len <= text_len, "块坐标越界：{off}+{len} > {text_len}");
        assert!(len > 0);
    }
}
