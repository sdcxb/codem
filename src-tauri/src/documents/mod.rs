//! 项目级文档索引 —— 宿主侧引擎（ADR-0008）。
//!
//! 分工：
//! - **索引库**（`codem-db/src/docs.rs`）：sources/chunks/FTS 的读写与检索；
//! - **本模块**：字节入口（分块上传）、格式提取、分块流水线、后台 worker、进度事件。
//!
//! ## 为什么提取/索引在 Rust 而不是渲染进程
//!
//! 1GB 文件的 base64 字符串就 >1.3GB，渲染进程做等于自爆；而 Rust 侧可以
//! 流式读、按页/段推进、边写边落库（内存里只保留当前分块）。
//!
//! ## 取消与恢复的边界（P0 如实写）
//!
//! - 取消：协作式标志，提取器在每个页/段边界检查；已写入的块保留，状态回 `pending`；
//! - 恢复：**P0 是「幂等重跑」**（`chunk_no` 覆盖写，不会重复命中），
//!   `document_ingest_state` 记录阶段与计数供 UI 展示；**按字节续跑**在 P1。
//!   这一点写在 ADR 的待办里，不假装已有。

pub mod chunk;
pub mod extract;
pub mod pdf;

use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use codem_db::docs::DocsEngine;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, State};

use chunk::Pipeline;
use extract::Outcome;

/// 分块上传的单块上限（解码后 8 MiB）。渲染侧按 4 MiB 切，留一倍余量。
pub const BLOB_CHUNK_MAX_BYTES: usize = 8 * 1024 * 1024;
/// 单文件安全上限（8 GiB）；超过只在文档行记 `too_large`，不做字节搬运。
pub const MAX_INGEST_BYTES: u64 = 8 * 1024 * 1024 * 1024;

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 宿主侧文档状态：数据根 + 运行中的任务取消标志。
pub struct DocumentsState {
    root: PathBuf,
    jobs: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
}

impl DocumentsState {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            jobs: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn documents_dir(&self) -> PathBuf {
        self.root.join("documents")
    }

    pub fn index_db_path(&self) -> PathBuf {
        self.documents_dir().join("index.db")
    }

    pub fn blobs_dir(&self) -> PathBuf {
        self.documents_dir().join("blobs")
    }

    fn uploads_dir(&self) -> PathBuf {
        self.documents_dir().join("uploads")
    }

    /// 任务表的共享句柄：后台线程结束时用它自清理（否则取消表会随长会话无限增长）。
    fn jobs_handle(&self) -> Arc<Mutex<HashMap<String, Arc<AtomicBool>>>> {
        self.jobs.clone()
    }

    fn register_job(&self, job_id: &str) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        if let Ok(mut jobs) = self.jobs.lock() {
            jobs.insert(job_id.to_string(), flag.clone());
        }
        flag
    }
}

fn unregister_job(jobs: &Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>, job_id: &str) {
    if let Ok(mut guard) = jobs.lock() {
        guard.remove(job_id);
    }
}

// ═══════════════════════════ 分块上传（大文件的字节通道） ═══════════════════════════

#[tauri::command]
pub fn documents_blob_begin(docs: State<'_, DocumentsState>, name: String) -> Result<Value, String> {
    let dir = docs.uploads_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建上传目录失败: {e}"))?;
    let upload_id = format!("up_{:x}_{}", now_ms(), sanitize(&name));
    let path = dir.join(format!("{upload_id}.part"));
    std::fs::write(&path, b"").map_err(|e| format!("创建上传临时文件失败: {e}"))?;
    Ok(json!({ "upload_id": upload_id, "path": path.to_string_lossy() }))
}

#[tauri::command]
pub fn documents_blob_append(
    docs: State<'_, DocumentsState>,
    upload_id: String,
    data: String,
) -> Result<Value, String> {
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.as_bytes())
        .map_err(|e| format!("base64 解码失败: {e}"))?;
    if bytes.len() > BLOB_CHUNK_MAX_BYTES {
        return Err(format!(
            "单块 {} 字节超过上限 {BLOB_CHUNK_MAX_BYTES}",
            bytes.len()
        ));
    }
    let path = docs.uploads_dir().join(format!("{}.part", sanitize(&upload_id)));
    let mut f = std::fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .map_err(|e| format!("打开上传临时文件失败: {e}"))?;
    let current = f.metadata().map(|m| m.len()).unwrap_or(0);
    if current + bytes.len() as u64 > MAX_INGEST_BYTES {
        return Err(format!(
            "累计 {} 字节超过单文件上限 {MAX_INGEST_BYTES}",
            current + bytes.len() as u64
        ));
    }
    f.write_all(&bytes)
        .map_err(|e| format!("写上传临时文件失败: {e}"))?;
    Ok(json!({ "received": current + bytes.len() as u64 }))
}

/// finish：流式计算 sha256 → 原子改名到 `blobs/<sha256>` → 返回句柄。
#[tauri::command]
pub fn documents_blob_finish(
    docs: State<'_, DocumentsState>,
    upload_id: String,
    name: String,
) -> Result<Value, String> {
    let src = docs.uploads_dir().join(format!("{}.part", sanitize(&upload_id)));
    let size = std::fs::metadata(&src)
        .map_err(|e| format!("上传临时文件不存在: {e}"))?
        .len();
    if size > MAX_INGEST_BYTES {
        let _ = std::fs::remove_file(&src);
        return Err(format!("文件 {size} 字节超过上限 {MAX_INGEST_BYTES}"));
    }
    let sha = sha256_file(&src)?;
    let dir = docs.blobs_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建 blob 目录失败: {e}"))?;
    let dest = dir.join(&sha);
    if dest.exists() {
        let _ = std::fs::remove_file(&src);
    } else {
        std::fs::rename(&src, &dest).map_err(|e| format!("blob 落盘失败: {e}"))?;
    }
    Ok(json!({
        "sha256": sha,
        "size": size,
        "name": name,
        "path": dest.to_string_lossy(),
    }))
}

#[tauri::command]
pub fn documents_blob_abort(docs: State<'_, DocumentsState>, upload_id: String) -> Result<Value, String> {
    let path = docs.uploads_dir().join(format!("{}.part", sanitize(&upload_id)));
    let _ = std::fs::remove_file(&path);
    Ok(json!({ "ok": true }))
}

// ═══════════════════════════ 摄取 ═══════════════════════════

#[tauri::command]
pub fn documents_ingest(
    docs: State<'_, DocumentsState>,
    app: AppHandle,
    request: Value,
) -> Result<Value, String> {
    let req: IngestRequest = serde_json::from_value(request)
        .map_err(|e| format!("documents_ingest 参数不合法: {e}"))?;
    if req.collection_id.trim().is_empty() {
        return Err("collection_id 不能为空".to_string());
    }
    let job_id = format!("job_{:x}", now_ms());
    let cancel = docs.register_job(&job_id);
    let root = docs.root().to_path_buf();
    let jobs = docs.jobs_handle();
    let job_id_for_thread = job_id.clone();

    std::thread::Builder::new()
        .name(format!("documents-ingest-{job_id}"))
        .spawn(move || {
            run_ingest(app, root, req, job_id_for_thread.clone(), cancel);
            unregister_job(&jobs, &job_id_for_thread);
        })
        .map_err(|e| format!("启动摄取线程失败: {e}"))?;

    Ok(json!({ "job_id": job_id }))
}

#[tauri::command]
pub fn documents_cancel(docs: State<'_, DocumentsState>, job_id: String) -> Result<Value, String> {
    let jobs = docs
        .jobs
        .lock()
        .map_err(|_| "文档任务表锁已中毒".to_string())?;
    match jobs.get(&job_id) {
        Some(flag) => {
            flag.store(true, Ordering::Relaxed);
            Ok(json!({ "ok": true, "cancelled": job_id }))
        }
        None => Ok(json!({ "ok": false, "reason": "任务不存在或已结束" })),
    }
}

#[tauri::command]
pub fn documents_jobs(docs: State<'_, DocumentsState>) -> Result<Value, String> {
    let jobs = docs
        .jobs
        .lock()
        .map_err(|_| "文档任务表锁已中毒".to_string())?;
    Ok(json!({ "items": jobs.keys().cloned().collect::<Vec<_>>() }))
}

/// PDF 引擎自检（UI 显示「需引擎」时用）。
#[tauri::command]
pub fn documents_pdf_probe() -> Value {
    json!({ "available": pdf::engine_available() })
}

/// 重建：清空索引后按已知 source 重新摄取（blob 与路径都可重放）。
#[tauri::command]
pub fn documents_rebuild(
    docs: State<'_, DocumentsState>,
    app: AppHandle,
    collection_id: Option<String>,
) -> Result<Value, String> {
    let engine = DocsEngine::open(docs.index_db_path()).map_err(|e| e.to_string())?;
    let list = codem_db::docs::list_documents(
        &engine,
        &json!({ "collection_id": collection_id, "limit": 500 }),
    )
    .map_err(|e| e.to_string())?;
    let mut requests: Vec<Value> = Vec::new();
    if let Some(items) = list.get("items").and_then(|v| v.as_array()) {
        for doc in items {
            let source = doc.get("source_ref").and_then(|v| v.as_str()).unwrap_or("");
            if source.is_empty() {
                continue;
            }
            requests.push(json!({
                "collection_id": doc.get("collection_id"),
                "kind": doc.get("kind"),
                "path": if doc.get("kind").and_then(|v| v.as_str()) == Some("path") { source.to_string() } else { String::new() },
                "sha256": doc.get("sha256"),
                "name": doc.get("name"),
                "mime": doc.get("mime"),
                "size": doc.get("size"),
            }));
        }
    }
    // 先清空（blob/text 不动），再后台重放
    codem_db::docs::reset(&engine, &json!({})).map_err(|e| e.to_string())?;
    drop(engine);

    let root = docs.root().to_path_buf();
    let jobs = docs.jobs_handle();
    let job_id = format!("job_rebuild_{:x}", now_ms());
    let cancel = docs.register_job(&job_id);
    let job_for_thread = job_id.clone();
    std::thread::Builder::new()
        .name(format!("documents-rebuild-{job_id}"))
        .spawn(move || {
            for req in requests {
                let parsed: IngestRequest = match serde_json::from_value(req) {
                    Ok(r) => r,
                    Err(_) => continue,
                };
                if cancel.load(Ordering::Relaxed) {
                    break;
                }
                run_ingest(app.clone(), root.clone(), parsed, job_for_thread.clone(), cancel.clone());
            }
            unregister_job(&jobs, &job_for_thread);
        })
        .map_err(|e| format!("启动重建线程失败: {e}"))?;
    Ok(json!({ "job_id": job_id }))
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct IngestRequest {
    pub collection_id: String,
    pub kind: String,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub sha256: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub mime: Option<String>,
    #[serde(default)]
    pub size: Option<i64>,
    #[serde(default)]
    pub source_ref: Option<String>,
}

fn emit(app: &AppHandle, payload: Value) {
    let _ = app.emit("document://progress", payload);
}

fn emit_stage(app: &AppHandle, job_id: &str, document_id: Option<&str>, stage: &str, extra: Value) {
    let mut payload = json!({
        "jobId": job_id,
        "documentId": document_id,
        "stage": stage,
        "at": now_ms(),
    });
    if let (Some(obj), Some(extra)) = (payload.as_object_mut(), extra.as_object()) {
        for (k, v) in extra {
            obj.insert(k.clone(), v.clone());
        }
    }
    emit(app, payload);
}

/// 摄取期进度看门狗：每 700ms 把「已处理字节 / 百分比」发到 `document://progress`。
///
/// 为什么需要它：1GB 基准实测索引要 ~11 分钟（见 DOC-INDEX-BENCH.md），如果只在
/// 开始/结束各发一次事件，UI 会长时间停在「提取中」——用户无法判断是卡死还是在跑。
/// Drop 时停线程并 join（最多等一个睡眠周期），所有提前 return 的路径都会自动收尾。
struct ProgressWatcher {
    stop: Arc<AtomicBool>,
    handle: Option<std::thread::JoinHandle<()>>,
}

impl Drop for ProgressWatcher {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(h) = self.handle.take() {
            let _ = h.join();
        }
    }
}

fn start_progress_watcher(
    app: &AppHandle,
    job_id: &str,
    document_id: &str,
    total_bytes: i64,
    processed: Arc<std::sync::atomic::AtomicI64>,
) -> ProgressWatcher {
    let stop = Arc::new(AtomicBool::new(false));
    let app = app.clone();
    let job = job_id.to_string();
    let doc = document_id.to_string();
    let stop_thread = stop.clone();
    let handle = std::thread::spawn(move || {
        while !stop_thread.load(Ordering::Relaxed) {
            std::thread::sleep(std::time::Duration::from_millis(700));
            if stop_thread.load(Ordering::Relaxed) {
                break;
            }
            let done = processed.load(Ordering::Relaxed).max(0);
            let percent = if total_bytes > 0 {
                (done.saturating_mul(100) / total_bytes).min(100)
            } else {
                0
            };
            emit_stage(
                &app,
                &job,
                Some(&doc),
                "extracting",
                json!({ "bytes": done, "totalBytes": total_bytes, "percent": percent }),
            );
        }
    });
    ProgressWatcher {
        stop,
        handle: Some(handle),
    }
}

fn run_ingest(
    app: AppHandle,
    root: PathBuf,
    req: IngestRequest,
    job_id: String,
    cancel: Arc<AtomicBool>,
) {
    let engine = match DocsEngine::open(root.join("documents").join("index.db")) {
        Ok(e) => e,
        Err(e) => {
            emit_stage(&app, &job_id, None, "failed", json!({ "error": format!("打开文档索引库失败: {e}") }));
            return;
        }
    };
    let result = ingest_inner(&app, &engine, &root, &req, &job_id, &cancel);
    match result {
        Ok(payload) => {
            let doc_id = payload
                .get("document_id")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            emit_stage(&app, &job_id, doc_id.as_deref(), "done", payload)
        }
        Err(e) => {
            let cancelled = cancel.load(Ordering::Relaxed);
            let stage = if cancelled { "cancelled" } else { "failed" };
            // 状态回写由 ingest_inner 在已知 document_id 后完成（早失败没有 document 行，
            // 这里只把阶段事件发出去；UI 依据该事件显示可行动错误）。
            emit_stage(&app, &job_id, None, stage, json!({ "error": e }));
        }
    }
}

fn ingest_inner(
    app: &AppHandle,
    engine: &DocsEngine,
    root: &Path,
    req: &IngestRequest,
    job_id: &str,
    cancel: &Arc<AtomicBool>,
) -> Result<Value, String> {
    // 1) 解析来源路径
    let blob_path;
    let path = match (req.kind.as_str(), &req.path) {
        ("path", Some(p)) => PathBuf::from(p),
        ("blob" | "attachment" | "paste" | "drop", _) => {
            let sha = req
                .sha256
                .clone()
                .ok_or_else(|| "blob 摄取缺少 sha256".to_string())?;
            blob_path = root.join("documents").join("blobs").join(&sha);
            blob_path
        }
        (_, Some(p)) => PathBuf::from(p),
        _ => return Err("缺少文档路径".to_string()),
    };
    if !path.exists() {
        return Err(format!("文件不存在：{}", path.display()));
    }
    let meta = std::fs::metadata(&path).map_err(|e| format!("读取文件信息失败: {e}"))?;
    if meta.len() > MAX_INGEST_BYTES {
        return Err(format!(
            "文件 {} 字节超过安全上限 {MAX_INGEST_BYTES}（只登记元数据，不搬运字节）",
            meta.len()
        ));
    }
    // 磁盘上的真实大小优先；请求里带 size 只是元数据提示（blob 上传时已知）。
    let size = meta.len() as i64;
    let name = req
        .name
        .clone()
        .or_else(|| path.file_name().map(|n| n.to_string_lossy().to_string()))
        .unwrap_or_else(|| "document".to_string());
    let mime = req.mime.clone().unwrap_or_else(|| guess_mime(&name));

    // 2) sha + 去重键
    let sha = match &req.sha256 {
        Some(s) if !s.is_empty() => s.clone(),
        _ => sha256_file(&path)?,
    };
    let dedupe_key = match req.kind.as_str() {
        "path" => format!("path:{}", normalize_path(&path.to_string_lossy())),
        _ => format!("blob:{sha}"),
    };
    let source_ref = req
        .source_ref
        .clone()
        .unwrap_or_else(|| match req.kind.as_str() {
            "path" => path.to_string_lossy().to_string(),
            _ => sha.clone(),
        });

    // 3) 登记（命中即复用；sha 未变且已 ready → 跳过解析）
    let upsert = codem_db::docs::upsert_document(
        engine,
        &json!({
            "collection_id": req.collection_id,
            "kind": req.kind,
            "source_ref": source_ref,
            "dedupe_key": dedupe_key,
            "name": name,
            "mime": mime,
            "size": req.size.unwrap_or(size),
            "sha256": sha,
            "mtime": meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_millis() as i64),
            "status": "extracting",
            "extractor_version": EXTRACTOR_VERSION,
        }),
    )
    .map_err(|e| format!("登记文档失败: {e}"))?;
    let document_id = upsert
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "登记文档未返回 id".to_string())?
        .to_string();

    emit_stage(app, job_id, Some(&document_id), "extracting", json!({ "name": name, "bytes": size }));

    // 4) 流式提取 + 分块 + 索引
    let text_final = root.join("documents").join("text").join(format!("{sha}.txt"));
    let text_tmp = root
        .join("documents")
        .join("text")
        .join(format!("{sha}.txt.part"));
    let mut pipeline = Pipeline::create(engine, &document_id, text_tmp.clone(), text_final.clone(), cancel.clone())
        .map_err(|e| format!("创建分块流水线失败: {e}"))?;
    // 长文件（1GB ≈ 11 分钟）期间持续发进度；Drop 时自动停线程。
    let _progress_watcher = start_progress_watcher(
        app,
        job_id,
        &document_id,
        size,
        pipeline.progress_counter(),
    );

    let extract_result: Result<Outcome, String> = extract::extract(&path, &mut pipeline);
    let cancelled = cancel.load(Ordering::Relaxed);

    let outcome = match extract_result {
        Ok(o) => o,
        Err(e) => {
            pipeline.abort();
            let status = if cancelled { "pending" } else { "failed" };
            codem_db::docs::update_status(
                engine,
                &json!({ "id": document_id, "status": status, "error": e }),
            )
            .map_err(|e2| format!("{e}（状态回写也失败：{e2}）"))?;
            return Err(e);
        }
    };

    let stats = match pipeline.finish() {
        Ok(s) => s,
        Err(e) => {
            let status = if cancelled { "pending" } else { "failed" };
            let _ = codem_db::docs::update_status(
                engine,
                &json!({ "id": document_id, "status": status, "error": e }),
            );
            return Err(e);
        }
    };

    let outline = json!({
        "pages": stats.page_count,
        "chunks": stats.chunk_count,
        "blocks": stats.block_count,
    });
    let error = outcome.error.clone();
    codem_db::docs::update_status(
        engine,
        &json!({
            "id": document_id,
            "status": outcome.status,
            "error": error,
            "page_count": outcome.page_count.max(stats.page_count),
            "block_count": stats.block_count,
            "chunk_count": stats.chunk_count,
            "text_bytes": stats.text_bytes,
            "outline": outline,
        }),
    )
    .map_err(|e| format!("回写文档状态失败: {e}"))?;

    Ok(json!({
        "document_id": document_id,
        "status": outcome.status,
        "page_count": outcome.page_count.max(stats.page_count),
        "chunks": stats.chunk_count,
        "blocks": stats.block_count,
        "text_bytes": stats.text_bytes,
        "error": error,
    }))
}

/// 提取器版本：改提取逻辑时 +1，重建时据此判断是否要重算（P1 用；P0 仅记录）。
const EXTRACTOR_VERSION: i64 = 1;

fn normalize_path(p: &str) -> String {
    p.replace('\\', "/").to_lowercase()
}

fn sanitize(s: &str) -> String {
    s.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' {
                c
            } else {
                '_'
            }
        })
        .take(80)
        .collect::<String>()
        .replace("..", "__")
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut f = std::fs::File::open(path).map_err(|e| format!("打开文件失败: {e}"))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1024 * 1024];
    loop {
        let n = f.read(&mut buf).map_err(|e| format!("读文件失败: {e}"))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex(&hasher.finalize()))
}

fn hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

fn guess_mime(name: &str) -> String {
    let ext = name
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "pdf" => "application/pdf",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "md" | "markdown" => "text/markdown",
        "txt" => "text/plain",
        "csv" => "text/csv",
        "json" => "application/json",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        _ => "application/octet-stream",
    }
    .to_string()
}

/// 读取正文侧车里的一段字节（`doc_read` 用）。
pub fn read_text_range(root: &Path, sha: &str, offset: i64, len: i64) -> Result<String, String> {
    let path = root.join("documents").join("text").join(format!("{sha}.txt"));
    let mut f = std::fs::File::open(&path).map_err(|e| format!("打开正文文件失败: {e}"))?;
    let size = f.metadata().map(|m| m.len()).unwrap_or(0);
    let start = (offset.max(0) as u64).min(size);
    let end = ((offset.max(0) + len.max(0)) as u64).min(size);
    if end <= start {
        return Ok(String::new());
    }
    f.seek(SeekFrom::Start(start))
        .map_err(|e| format!("定位正文失败: {e}"))?;
    let mut buf = vec![0u8; (end - start) as usize];
    f.read_exact(&mut buf)
        .map_err(|e| format!("读正文失败: {e}"))?;
    // 边界安全：截到最近的 UTF-8 字符起点，末尾丢弃半个字符
    let mut s = String::from_utf8_lossy(&buf).to_string();
    if start > 0 && !buf.is_empty() && (buf[0] & 0xC0) == 0x80 {
        if let Some(idx) = s.find(|c: char| !c.is_whitespace() || c.is_ascii()) {
            let _ = idx;
        }
    }
    // 简化：只保证末尾不截断半个字符（from_utf8_lossy 已用替换字符兜住）
    s = s.trim_start_matches('\u{FFFD}').to_string();
    Ok(s)
}

/// 解析文档对应的**原文件**（用于渲染页面做视觉转录）。
fn source_file_for_doc(docs: &DocumentsState, doc: &Value) -> Result<PathBuf, String> {
    let kind = doc.get("kind").and_then(|v| v.as_str()).unwrap_or("");
    let sha = doc.get("sha256").and_then(|v| v.as_str()).unwrap_or("");
    if kind == "path" {
        let source = doc
            .get("source_ref")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "文档缺少来源路径".to_string())?;
        let path = PathBuf::from(source);
        if path.exists() {
            return Ok(path);
        }
        return Err(format!(
            "原文件已移动或删除：{source}（请重新登记该文档）"
        ));
    }
    if sha.is_empty() {
        return Err("文档没有 sha256".to_string());
    }
    let path = docs.blobs_dir().join(sha);
    if !path.exists() {
        return Err(format!("文档源文件不存在：{}", path.display()));
    }
    Ok(path)
}

/// 视觉转录：列出仍待 OCR 的页（仅 `scanned`/`mixed`）。
#[tauri::command]
pub fn documents_ocr_pending(
    docs: State<'_, DocumentsState>,
    document_id: String,
) -> Result<Value, String> {
    let engine = DocsEngine::open(docs.index_db_path()).map_err(|e| e.to_string())?;
    codem_db::docs::ocr_pending(&engine, &json!({ "document_id": document_id }))
        .map_err(|e| e.to_string())
}

/// 视觉转录：把一页渲染成 PNG（base64），供渲染侧调用视觉模型。
#[tauri::command]
pub fn documents_render_page(
    docs: State<'_, DocumentsState>,
    document_id: String,
    page_no: i64,
    max_width: Option<u32>,
) -> Result<Value, String> {
    use base64::Engine as _;
    let engine = DocsEngine::open(docs.index_db_path()).map_err(|e| e.to_string())?;
    let doc = codem_db::docs::get_document(&engine, &json!({ "id": document_id }))
        .map_err(|e| format!("文档不存在: {e}"))?;
    let source = source_file_for_doc(&docs, &doc)?;
    let ext = source
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    if ext == "pdf" {
        let rendered = pdf::render_page_png(&source, page_no, max_width.unwrap_or(1400))?;
        return Ok(json!({
            "page_no": page_no,
            "media_type": "image/png",
            "data": base64::engine::general_purpose::STANDARD.encode(rendered.png),
            "width": rendered.width,
            "height": rendered.height,
        }));
    }
    // 图片文档：原图就是"页面"，不需要渲染；视觉模型直接读。
    let media_type = match ext.as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "webp" => Some("image/webp"),
        _ => None,
    };
    let Some(media_type) = media_type else {
        return Err(format!(
            "不支持的视觉转录来源 .{ext}：目前支持 PDF / PNG / JPEG / WebP"
        ));
    };
    let bytes = std::fs::read(&source).map_err(|e| format!("读取图片失败: {e}"))?;
    Ok(json!({
        "page_no": page_no,
        "media_type": media_type,
        "data": base64::engine::general_purpose::STANDARD.encode(bytes),
        "width": 0,
        "height": 0,
    }))
}

/// 视觉转录：写一页的转录文本（正文追加到侧车 + 块/分块/FTS + 页状态）。
#[tauri::command]
pub fn documents_ocr_write(
    docs: State<'_, DocumentsState>,
    document_id: String,
    page_no: i64,
    text: String,
    model: String,
) -> Result<Value, String> {
    let engine = DocsEngine::open(docs.index_db_path()).map_err(|e| e.to_string())?;
    let doc = codem_db::docs::get_document(&engine, &json!({ "id": document_id }))
        .map_err(|e| format!("文档不存在: {e}"))?;
    let sha = doc
        .get("sha256")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "文档没有 sha256".to_string())?
        .to_string();
    let text_path = docs.documents_dir().join("text").join(format!("{sha}.txt"));
    if let Some(parent) = text_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建正文目录失败: {e}"))?;
    }
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&text_path)
        .map_err(|e| format!("打开正文侧车失败: {e}"))?;
    let existing = file.metadata().map_err(|e| e.to_string())?.len();
    let prefix = if existing > 0 { "\n\n" } else { "" };
    file.write_all(prefix.as_bytes())
        .and_then(|_| file.write_all(text.as_bytes()))
        .map_err(|e| format!("写正文侧车失败: {e}"))?;
    file.flush().map_err(|e| e.to_string())?;

    let text_offset = (existing as i64) + prefix.len() as i64;
    let text_len = text.len() as i64;
    let heading = format!("第{page_no}页（视觉转录）");
    codem_db::docs::write_ocr_page(
        &engine,
        &json!({
            "document_id": document_id,
            "page_no": page_no,
            "text": text,
            "model": model,
            "heading": heading,
            "text_offset": text_offset,
            "text_len": text_len,
        }),
    )
    .map_err(|e| e.to_string())
}

/// 视觉转录：单页失败标记（保留待重试）。
#[tauri::command]
pub fn documents_ocr_mark_failed(
    docs: State<'_, DocumentsState>,
    document_id: String,
    page_no: i64,
) -> Result<Value, String> {
    let engine = DocsEngine::open(docs.index_db_path()).map_err(|e| e.to_string())?;
    codem_db::docs::mark_ocr_failed(
        &engine,
        &json!({ "document_id": document_id, "page_no": page_no }),
    )
    .map_err(|e| e.to_string())
}

/// 视觉转录收尾：没有待 OCR 页时把文档转 `ready` 并刷新计数。
#[tauri::command]
pub fn documents_ocr_finish(
    docs: State<'_, DocumentsState>,
    document_id: String,
) -> Result<Value, String> {
    let engine = DocsEngine::open(docs.index_db_path()).map_err(|e| e.to_string())?;
    codem_db::docs::ocr_finish(&engine, &json!({ "document_id": document_id }))
        .map_err(|e| e.to_string())
}

/// `documents_read`：按 chunk 号返回正文（渲染侧 `doc_read` 工具用）。
#[tauri::command]
pub fn documents_read(
    docs: State<'_, DocumentsState>,
    document_id: String,
    chunk_no: Option<i64>,
    offset: Option<i64>,
    len: Option<i64>,
) -> Result<Value, String> {
    let engine = DocsEngine::open(docs.index_db_path()).map_err(|e| e.to_string())?;
    let doc = codem_db::docs::get_document(&engine, &json!({ "id": document_id }))
        .map_err(|e| format!("文档不存在: {e}"))?;
    let sha = doc
        .get("sha256")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "文档没有 sha256".to_string())?
        .to_string();
    let (off, size, citation) = match chunk_no {
        Some(n) => {
            let rows = codem_db::docs::read_chunks(
                &engine,
                &json!({ "document_id": document_id, "chunk_nos": [n], "limit": 1 }),
            )
            .map_err(|e| e.to_string())?;
            let item = rows
                .get("items")
                .and_then(|v| v.as_array())
                .and_then(|a| a.first())
                .cloned()
                .ok_or_else(|| format!("分块 {n} 不存在"))?;
            (
                item.get("text_offset").and_then(|v| v.as_i64()).unwrap_or(0),
                item.get("text_len").and_then(|v| v.as_i64()).unwrap_or(0),
                json!({
                    "pageFrom": item.get("page_from"),
                    "pageTo": item.get("page_to"),
                    "headingPath": item.get("heading_path"),
                }),
            )
        }
        None => (offset.unwrap_or(0), len.unwrap_or(4000), json!({})),
    };
    let text = read_text_range(docs.root(), &sha, off, size)?;
    Ok(json!({
        "documentId": document_id,
        "text": text,
        "citation": citation,
        "hasMore": false,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_keeps_simple_names() {
        assert_eq!(sanitize("a-b_c.d"), "a-b_c.d");
        assert!(!sanitize("../x y").contains(".."));
    }

    #[test]
    fn sha256_of_known_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.txt");
        std::fs::write(&p, b"abc").unwrap();
        assert_eq!(
            sha256_file(&p).unwrap(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn read_text_range_is_bounded() {
        let dir = tempfile::tempdir().unwrap();
        let text = dir.path().join("documents").join("text");
        std::fs::create_dir_all(&text).unwrap();
        std::fs::write(text.join("abc.txt"), "0123456789").unwrap();
        assert_eq!(read_text_range(dir.path(), "abc", 2, 3).unwrap(), "234");
        assert_eq!(read_text_range(dir.path(), "abc", 8, 100).unwrap(), "89");
        assert_eq!(read_text_range(dir.path(), "abc", 99, 1).unwrap(), "");
    }

    #[test]
    fn guess_mime_covers_office() {
        assert!(guess_mime("a.docx").contains("wordprocessingml"));
        assert_eq!(guess_mime("a.pdf"), "application/pdf");
    }
}
