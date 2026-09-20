use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri::WindowEvent as WinEvent;
use tauri::tray::{TrayIconBuilder, TrayIconEvent, MouseButton, MouseButtonState};
use tauri::menu::{ContextMenu, MenuBuilder, MenuItemBuilder, PredefinedMenuItem, CheckMenuItemBuilder, SubmenuBuilder};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{oneshot, Mutex as TokioMutex};

// ========== Runtime Log ==========
// 运行时事件文件日志（对标 dsh log-files.ts）：按日 + 轮转 + 上限 + 脱敏。
// 打包版无控制台，常规事件落盘供用户/开发者诊断。
mod runtime_log;
// ========== 微信 ClawBot 桥（iLink）==========
// 传输层（登录/长轮询/收发/配额），引擎集成在 TS 侧。
mod ilink;

// ========== 手机连接（phone-link，对标 dsh-phone）==========
// LAN HTTP 地基：配对门卫 + 静态页 + 请求代理到 WebView TS 引擎。
mod phone;

// ========== 存储引擎（Rust 原生 SQLite）==========
// 迁移期定位：渲染侧通过 `storage_invoke` 走类型化仓储命令（不接受 SQL），
// 引擎本体在 src-tauri/codem-db（独立 crate，可被 CLI 与 vitest 契约测试直接驱动）。
mod secret;
use crate::secret::{secret_backend_available, secret_seal, secret_unseal};
mod storage;

// ========== PTY Manager ==========
// Interactive terminal support using portable-pty.
// Manages multiple PTY sessions with real-time I/O streaming via Tauri events.

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::io::{Read, Write};
use std::thread;

struct PtySession {
    writer: Box<dyn Write + Send>,
    _master: Box<dyn portable_pty::MasterPty + Send>,
    _child: Box<dyn portable_pty::Child + Send>,
    _id: String,
}

type PtyMap = Arc<Mutex<HashMap<String, PtySession>>>;

#[derive(Clone, serde::Serialize)]
struct PtyOutputEvent {
    id: String,
    data: String,
}

#[tauri::command]
fn spawn_pty(cwd: String, app: AppHandle, state: State<'_, PtyMap>) -> Result<String, String> {
    let id = format!("pty-{}", uuid::Uuid::new_v4());
    let pty_system = native_pty_system();

    // Use shell appropriate for platform
    #[cfg(windows)]
    let mut cmd = CommandBuilder::new("cmd.exe");
    #[cfg(not(windows))]
    let mut cmd = CommandBuilder::new(
        std::env::var("SHELL").unwrap_or_else(|_| {
            if std::path::Path::new("/bin/zsh").exists() { "/bin/zsh".to_string() }
            else if std::path::Path::new("/bin/bash").exists() { "/bin/bash".to_string() }
            else { "/bin/sh".to_string() }
        })
    );
    cmd.cwd(cwd.clone());

    let pair = pty_system
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Failed to open PTY: {}", e))?;

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("Failed to spawn shell: {}", e))?;

    // Drop slave to allow child to use it
    drop(pair.slave);

    let master = pair.master;

    // Take writer from master — MasterPty doesn't impl Write directly
    let writer = master.take_writer().map_err(|e| format!("Failed to take writer: {}", e))?;

    // Clone the reader and spawn output thread
    let reader = master
        .try_clone_reader()
        .map_err(|e| format!("Failed to clone reader: {}", e))?;

    let event_app = app.clone();
    let event_id = id.clone();
    thread::spawn(move || {
        let mut buf = [0u8; 4096];
        let mut reader = reader;
        let exit_reason = loop {
            match reader.read(&mut buf) {
                Ok(0) => break "EOF",
                Ok(n) => {
                    let data = String::from_utf8_lossy(&buf[..n]).to_string();
                    let _ = event_app.emit(
                        "pty-output",
                        PtyOutputEvent {
                            id: event_id.clone(),
                            data,
                        },
                    );
                }
                Err(_) => break "read-error",
            }
        };
        // 会话结束（shell exit / 管道关闭 / 读错误）— 通知前端清理。
        // FIX: 之前线程静默退出，前端不知会话已结束，僵尸会话挂到 TTL 才回收，
        // 用户也看不到"进程已退出"。
        let _ = event_app.emit(
            "pty-exit",
            PtyOutputEvent {
                id: event_id.clone(),
                data: exit_reason.to_string(),
            },
        );
    });

    let session = PtySession {
        writer,
        _master: master,
        _child: child,
        _id: id.clone(),
    };
    state
        .lock()
        .map_err(|e| format!("Lock error: {}", e))?
        .insert(id.clone(), session);

    runtime_log::append_line("INFO", &format!("pty spawned id={} cwd={:?}", id, cwd));
    Ok(id)
}

#[tauri::command]
fn write_pty(id: String, data: String, state: State<'_, PtyMap>) -> Result<(), String> {
    let mut map = state.lock().map_err(|e| format!("Lock error: {}", e))?;
    let session = map
        .get_mut(&id)
        .ok_or_else(|| format!("PTY session not found: {}", id))?;
    session
        .writer
        .write_all(data.as_bytes())
        .map_err(|e| format!("Write failed: {}", e))
}

#[tauri::command]
fn resize_pty(id: String, cols: u16, rows: u16, state: State<'_, PtyMap>) -> Result<(), String> {
    let mut map = state.lock().map_err(|e| format!("Lock error: {}", e))?;
    let session = map
        .get_mut(&id)
        .ok_or_else(|| format!("PTY session not found: {}", id))?;
    session
        ._master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Resize failed: {}", e))
}

#[tauri::command]
fn close_pty(id: String, state: State<'_, PtyMap>) -> Result<(), String> {
    let mut map = state.lock().map_err(|e| format!("Lock error: {}", e))?;
    if let Some(mut session) = map.remove(&id) {
        // 杀整个进程树（对标 dsh 进程树纪律）：cmd.exe 的孙进程（正在跑的
        // 长命令如 node/npm/test）此前不会被单 kill 带走，终端关闭后仍在
        // 后台运行 —— 用户以为已停止，实际资源/端口被占用。
        if let Some(pid) = session._child.process_id() {
            let _ = kill_process_tree(Some(pid));
        }
        let _ = session._child.kill();
        runtime_log::append_line("INFO", &format!("pty closed id={}", id));
        // Master and writer are dropped when session goes out of scope
        drop(session);
    }
    Ok(())
}

// ========== Browser Panel ==========
// Opens a URL in an embedded WebView window for frontend preview.

#[tauri::command]
async fn create_browser_window(app: AppHandle, url: String, title: Option<String>) -> Result<(), String> {
    let window_title = title.unwrap_or_else(|| "Browser".to_string());

    // If browser window already exists, navigate it
    if let Some(existing) = app.get_webview_window("browser") {
        existing.set_title(&window_title).map_err(|e| e.to_string())?;
        // Reuse existing window — just focus it
        existing.show().map_err(|e| e.to_string())?;
        existing.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }

    let parsed_url = url::Url::parse(&url).map_err(|e| e.to_string())?;
    let _window = tauri::WebviewWindowBuilder::new(
        &app,
        "browser",
        tauri::WebviewUrl::External(parsed_url),
    )
    .title(&window_title)
    .inner_size(1024.0, 768.0)
    .min_inner_size(400.0, 300.0)
    .resizable(true)
    .build()
    .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
async fn close_browser_window(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("browser") {
        window.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ========== Types ==========

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderConfig {
    pub id: String,
    pub name: String,
    pub api_key: String,
    pub base_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatRequest {
    pub message: String,
    pub session_id: Option<String>,
    pub cwd: Option<String>,
    pub agent_id: Option<String>,
    pub model: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionInfo {
    pub id: String,
    pub title: String,
    pub created_at: u64,
    pub message_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageInfo {
    pub id: String,
    pub role: String,
    pub content: String,
    pub timestamp: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolInfo {
    pub name: String,
    pub description: String,
    pub parameters: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentInfo {
    pub id: String,
    pub name: String,
    pub description: String,
    pub mode: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CostStats {
    pub total_cost: f64,
    pub today_cost: f64,
    pub total_sessions: u32,
    pub total_tokens: u64,
}

// ========== MCP Stdio Process Management ==========

struct McpProcessHandle {
    stdin: tokio::process::ChildStdin,
    pending: Arc<TokioMutex<HashMap<i64, oneshot::Sender<serde_json::Value>>>>,
    _child: tokio::process::Child,
}

// ========== App State ==========

struct AppState {
    providers: Mutex<Vec<ProviderConfig>>,
    default_model: Mutex<String>,
    default_agent: Mutex<String>,
    mcp_processes: TokioMutex<HashMap<String, McpProcessHandle>>,
}

// ========== Commands ==========

#[tauri::command]
async fn send_message(
    app: AppHandle,
    state: State<'_, AppState>,
    request: ChatRequest,
) -> Result<(), String> {
    let _model = request.model.clone().unwrap_or_else(|| state.default_model.lock().unwrap().clone());
    let _cwd = request.cwd.clone().unwrap_or_else(|| std::env::current_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default());

    // Emit event that frontend will handle
    app.emit("chat-message", &request)
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
async fn get_providers(state: State<'_, AppState>) -> Result<Vec<ProviderConfig>, String> {
    let providers = state.providers.lock().unwrap().clone();
    Ok(providers)
}

#[tauri::command]
async fn add_provider(
    state: State<'_, AppState>,
    provider: ProviderConfig,
) -> Result<(), String> {
    let mut providers = state.providers.lock().unwrap();
    providers.push(provider);
    Ok(())
}

#[tauri::command]
async fn remove_provider(
    state: State<'_, AppState>,
    provider_id: String,
) -> Result<(), String> {
    let mut providers = state.providers.lock().unwrap();
    providers.retain(|p| p.id != provider_id);
    Ok(())
}

#[tauri::command]
async fn get_default_model(state: State<'_, AppState>) -> Result<String, String> {
    Ok(state.default_model.lock().unwrap().clone())
}

#[tauri::command]
async fn set_default_model(
    state: State<'_, AppState>,
    model: String,
) -> Result<(), String> {
    *state.default_model.lock().unwrap() = model;
    Ok(())
}

#[tauri::command]
async fn get_default_agent(state: State<'_, AppState>) -> Result<String, String> {
    Ok(state.default_agent.lock().unwrap().clone())
}

#[tauri::command]
async fn set_default_agent(
    state: State<'_, AppState>,
    agent: String,
) -> Result<(), String> {
    *state.default_agent.lock().unwrap() = agent;
    Ok(())
}

/// Maximum bytes that `read_file` (full-file mode) will return in one shot.
/// Files larger than this cause `read_file` to return an error directing the
/// caller to use `read_file_lines` with offset/limit instead. This is NOT a
/// hard limit on what files the user can work with — it only prevents
/// accidentally pulling a 200 MB string through IPC into the JS heap when
/// the caller didn't specify pagination. `read_file_lines` has no such limit.
///
/// 50 MB — generous enough for any source file the LLM might read whole,
/// while keeping IPC + JS string handling under ~500 ms.
const READ_FILE_FULL_MAX_BYTES: u64 = 50 * 1024 * 1024;

/// Result of a paginated file read. The total_lines field lets the frontend
/// show "line X of Y" without a second round-trip.
#[derive(serde::Serialize)]
struct ReadFileLinesResult {
    /// The numbered text (lines with "N: " prefix, joined by \n).
    text: String,
    /// Total number of lines in the file.
    total_lines: usize,
    /// Whether there are more lines after the returned range.
    has_more: bool,
}

/// Read a file with line-level pagination. Only the requested [offset, offset+limit)
/// lines are read into memory and returned — the full file is never loaded into
/// the JS heap. This is the backend for the `read` tool when offset/limit are
/// specified, and the recommended path for any large file.
///
/// Design rationale (对标 DSH TextRetainer): DSH's OutputCollector and
/// TextRetainer only materialise the bytes they need — head, tail, or a
/// window — rather than reading the entire stream. This command applies the
/// same principle to file I/O: BufReader iterates lines lazily, skipping
/// `offset` lines and collecting only `limit` more. Memory is O(limit), not
/// O(file_size).
#[tauri::command]
async fn read_file_base64(path: String) -> Result<String, String> {
    let path_for_blocking = path.clone();
    tokio::task::spawn_blocking(move || -> Result<String, String> {
        use base64::Engine;
        let bytes = std::fs::read(&path_for_blocking).map_err(|e| format!("read {}: {e}", path_for_blocking))?;
        Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 系统临时目录（webview 无 process.env，供临时脚本/截图落盘用）。
#[tauri::command]
fn get_system_temp_dir() -> Result<String, String> {
    let dir = std::env::temp_dir().to_string_lossy().to_string();
    Ok(dir.trim_end_matches('\\').to_string())
}

#[tauri::command]
async fn read_file_lines(
    path: String,
    offset: Option<usize>,
    limit: Option<usize>,
    max_chars: Option<usize>,
) -> Result<ReadFileLinesResult, String> {
    let offset = offset.unwrap_or(1).max(1);
    let limit = limit.unwrap_or(2000);
    let max_chars = max_chars.unwrap_or(100_000);

    let path_cloned = path.clone();
    let result = tokio::task::spawn_blocking(move || -> Result<(String, usize, bool), String> {
        use std::io::{BufRead, BufReader};
        use std::fs::File;

        let file = File::open(&path_cloned).map_err(|e| e.to_string())?;
        let reader = BufReader::new(file);

        let mut parts: Vec<String> = Vec::new();
        let mut total_lines = 0usize;
        let mut total_chars = 0usize;
        let mut has_more = false;
        let mut collected = 0usize;

        for (idx, line_result) in reader.lines().enumerate() {
            let line_idx = idx + 1; // 1-indexed
            total_lines = line_idx;

            if line_idx < offset {
                continue; // skip lines before the requested offset
            }

            if collected >= limit {
                has_more = true;
                // Continue counting lines for total_lines — but stop early
                // if we've already confirmed has_more and don't need exact total.
                // For correctness we keep counting (the file is being read anyway).
                continue;
            }

            let line = line_result.map_err(|e| e.to_string())?;
            let numbered = format!("{}: {}", line_idx, line);

            if total_chars + numbered.len() > max_chars {
                has_more = true;
                break;
            }

            total_chars += numbered.len() + 1; // +1 for \n
            parts.push(numbered);
            collected += 1;
        }

        let text = parts.join("\n");
        Ok((text, total_lines, has_more))
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;

    let (text, total_lines, has_more) = result;

    Ok(ReadFileLinesResult {
        text,
        total_lines,
        has_more,
    })
}

#[tauri::command]
async fn read_file(path: String, encoding: Option<String>) -> Result<String, String> {
    match encoding.as_deref() {
        Some("base64") => {
            // Read binary file and encode as base64
            use base64::Engine;
            let bytes = tokio::task::spawn_blocking(move || std::fs::read(&path))
                .await
                .map_err(|e| e.to_string())?
                .map_err(|e| e.to_string())?;
            Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
        }
        _ => {
            // Read as UTF-8 text, strip BOM if present
            let p = std::path::Path::new(&path);

            // Size guard for full-file reads. Large files should use
            // read_file_lines (paginated) instead. This is not a user-facing
            // restriction — the frontend `read` tool automatically routes
            // to read_file_lines when offset/limit are specified.
            let metadata = tokio::fs::metadata(&p).await.map_err(|e| e.to_string())?;
            if metadata.len() > READ_FILE_FULL_MAX_BYTES {
                return Err(format!(
                    "File is large ({} bytes). Use read tool with offset/limit parameters for paginated reading, or use grep_search to find specific content.",
                    metadata.len()
                ));
            }

            // Use spawn_blocking so the synchronous read_to_string does not
            // stall the Tauri async runtime's worker thread.
            let path_for_blocking = path.clone();
            let content = tokio::task::spawn_blocking(move || {
                std::fs::read_to_string(&path_for_blocking)
            })
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| e.to_string())?;

            // Strip UTF-8 BOM (EF BB BF) — some Windows tools (Notepad, VS Code) add it
            let content = if content.starts_with('\u{FEFF}') {
                content.trim_start_matches('\u{FEFF}').to_string()
            } else {
                content
            };
            Ok(content)
        }
    }
}

#[tauri::command]
async fn write_file(path: String, content: String, encoding: Option<String>, workspace: Option<String>) -> Result<(), String> {
    // S5: Sandbox path whitelist — if workspace is provided, restrict writes to workspace
    if let Some(ref ws) = workspace {
        let ws_canonical = canonicalize_path(ws);
        let target_canonical = canonicalize_path(&path);
        if !target_canonical.starts_with(&ws_canonical) {
            return Err(format!(
                "Sandbox: Write to '{}' is outside the workspace '{}'. Set the workspace directory or disable sandbox mode in settings.",
                path, ws
            ));
        }
    }

    if let Some(parent) = std::path::Path::new(&path).parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    
    // Decode content to bytes first (base64 binary or UTF-8 text)
    let bytes: Vec<u8> = match encoding.as_deref() {
        Some("base64") => {
            use base64::Engine;
            base64::engine::general_purpose::STANDARD
                .decode(&content)
                .map_err(|e| format!("Base64 decode error: {}", e))?
        }
        _ => content.into_bytes(),
    };

    // Atomic write: write to a temp file in the same directory, fsync, then rename over the target.
    // A plain std::fs::write truncates + overwrites the target directly, so a crash or concurrent
    // write mid-save leaves a truncated/corrupt file (e.g. sql.js DB persistence). The temp-file +
    // rename dance keeps the target either fully old or fully new.
    let target = std::path::Path::new(&path);
    let file_name = target.file_name().unwrap_or_default().to_string_lossy();
    let tmp_path = target.with_file_name(format!(".{}.codem-tmp", file_name));

    {
        use std::io::Write;
        let mut file = std::fs::File::create(&tmp_path).map_err(|e| e.to_string())?;
        file.write_all(&bytes).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
    }

    std::fs::rename(&tmp_path, target).map_err(|e| {
        let _ = std::fs::remove_file(&tmp_path);
        format!("Atomic rename failed: {}", e)
    })?;
    Ok(())
}

/// S5: Canonicalize a path for comparison (resolve . and .. without requiring the path to exist)
fn canonicalize_path(path: &str) -> String {
    let normalized = path.replace('/', "\\");
    let mut parts: Vec<&str> = Vec::new();
    for part in normalized.split('\\') {
        if part == "" || part == "." {
            continue;
        }
        if part == ".." {
            parts.pop();
            continue;
        }
        parts.push(part);
    }
    let result = parts.join("\\");
    // Preserve drive letter prefix
    if normalized.len() >= 2 && normalized.as_bytes()[1] == b':' {
        result
    } else if normalized.starts_with("\\\\") {
        format!("\\{}", result)
    } else {
        result
    }
}

#[tauri::command]
async fn append_file(path: String, content: String) -> Result<(), String> {
    use std::io::Write;
    if let Some(parent) = std::path::Path::new(&path).parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    writeln!(file, "{}", content).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn list_directory(path: String, show_hidden: Option<bool>) -> Result<Vec<serde_json::Value>, String> {
    let show_hidden = show_hidden.unwrap_or(false);
    let entries = std::fs::read_dir(&path).map_err(|e| e.to_string())?;
    let mut result = Vec::new();

    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let metadata = entry.metadata().map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().to_string();

        if (!show_hidden && name.starts_with('.')) || name == "node_modules" {
            continue;
        }

        result.push(serde_json::json!({
            "name": name,
            "path": entry.path().to_string_lossy(),
            "isDirectory": metadata.is_dir(),
        }));
    }

    result.sort_by(|a, b| {
        let a_dir = a["isDirectory"].as_bool().unwrap_or(false);
        let b_dir = b["isDirectory"].as_bool().unwrap_or(false);
        match (a_dir, b_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a["name"].as_str().unwrap_or("").cmp(b["name"].as_str().unwrap_or("")),
        }
    });

    Ok(result)
}

/// Move a directory to the recycle bin (user content: project folders).
///
/// Windows goes through `SHFileOperationW` with every dialog suppressed. The
/// previous implementation shelled out to PowerShell and called
/// `Microsoft.VisualBasic.FileIO.FileSystem::DeleteDirectory(..., 'OnlyErrorDialogs', ...)`,
/// which can open a hidden error/progress dialog and then wait for a click
/// nobody can give — the invoking frontend promise never settles, so the UI
/// action (for example "删除技能") hung forever.
#[tauri::command]
async fn delete_directory(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        move_directory_to_recycle_bin(&path)
    }
    #[cfg(not(target_os = "windows"))]
    {
        // On non-Windows, permanent delete as fallback
        std::fs::remove_dir_all(&path).map_err(|e| e.to_string())
    }
}

/// Recursively delete a directory, permanently, without any shell or dialog.
///
/// Use this for directories the app itself owns (installed skills, pets,
/// downloaded runtimes): recycling them is not a safety net, and every dialog
/// -capable deletion path risks blocking with no visible window to answer.
#[tauri::command]
async fn delete_directory_permanent(path: String) -> Result<(), String> {
    remove_directory_permanent(&path)
}

/// Plain (non-command) implementation so it can be unit-tested directly.
fn remove_directory_permanent(path: &str) -> Result<(), String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("拒绝删除空路径".to_string());
    }
    let target = std::path::Path::new(trimmed);
    // A drive root (or any path without a parent) is never a skill/pet/runtime dir.
    if target.parent().is_none() {
        return Err(format!("拒绝删除根目录: {}", trimmed));
    }
    if !target.exists() {
        return Ok(());
    }
    match std::fs::remove_dir_all(target) {
        Ok(()) => Ok(()),
        Err(first_error) => {
            // Windows refuses to delete read-only files; clearing the flag on the
            // tree and retrying once is enough for every install layout we ship.
            clear_readonly_recursive(target);
            std::fs::remove_dir_all(target).map_err(|retry_error| {
                format!(
                    "删除目录失败 {}: {} (首次尝试: {})",
                    trimmed, retry_error, first_error
                )
            })
        }
    }
}

/// Clear the read-only flag across a tree so a retry can delete it (Windows).
fn clear_readonly_recursive(path: &std::path::Path) {
    let Ok(metadata) = std::fs::symlink_metadata(path) else {
        return;
    };
    if metadata.is_dir() {
        if let Ok(entries) = std::fs::read_dir(path) {
            for entry in entries.flatten() {
                clear_readonly_recursive(&entry.path());
            }
        }
    }
    #[cfg(target_os = "windows")]
    {
        let mut permissions = metadata.permissions();
        if permissions.readonly() {
            permissions.set_readonly(false);
            let _ = std::fs::set_permissions(path, permissions);
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = &metadata;
    }
}

/// Recycle a directory through the shell, with confirmation, progress and error
/// UI all suppressed so the call can only return — never wait for input.
#[cfg(target_os = "windows")]
fn move_directory_to_recycle_bin(path: &str) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;

    #[repr(C)]
    struct ShFileOpStructW {
        hwnd: *mut core::ffi::c_void,
        w_func: u32,
        p_from: *const u16,
        p_to: *const u16,
        f_flags: u16,
        f_any_operations_aborted: i32,
        h_name_mappings: *mut core::ffi::c_void,
        lpsz_progress_title: *const u16,
    }

    #[link(name = "shell32")]
    extern "system" {
        fn SHFileOperationW(operation: *mut ShFileOpStructW) -> i32;
    }

    const FO_DELETE: u32 = 0x0003;
    const FOF_SILENT: u16 = 0x0004;
    const FOF_NOCONFIRMATION: u16 = 0x0010;
    const FOF_ALLOWUNDO: u16 = 0x0040;
    const FOF_NOERRORUI: u16 = 0x0400;

    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("拒绝删除空路径".to_string());
    }
    let target = std::path::Path::new(trimmed);
    if target.parent().is_none() {
        return Err(format!("拒绝删除根目录: {}", trimmed));
    }
    if !target.exists() {
        return Ok(());
    }

    // SHFileOperationW wants the source list double-NUL terminated.
    let mut from: Vec<u16> = std::ffi::OsStr::new(trimmed).encode_wide().collect();
    from.push(0);
    from.push(0);

    let mut operation = ShFileOpStructW {
        hwnd: std::ptr::null_mut(),
        w_func: FO_DELETE,
        p_from: from.as_ptr(),
        p_to: std::ptr::null(),
        f_flags: FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT | FOF_NOERRORUI,
        f_any_operations_aborted: 0,
        h_name_mappings: std::ptr::null_mut(),
        lpsz_progress_title: std::ptr::null(),
    };

    let code = unsafe { SHFileOperationW(&mut operation) };
    if code != 0 {
        return Err(format!(
            "移入回收站失败（错误码 {}）：{}（请手动删除该目录）",
            code, trimmed
        ));
    }
    if operation.f_any_operations_aborted != 0 {
        return Err(format!("移入回收站被中止：{}", trimmed));
    }
    Ok(())
}

#[tauri::command]
async fn get_app_data_dir(app: tauri::AppHandle) -> Result<String, String> {
    let path = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    let mut dir_str = path.to_string_lossy().to_string();
    if !dir_str.ends_with(std::path::MAIN_SEPARATOR) {
        dir_str.push(std::path::MAIN_SEPARATOR);
    }
    Ok(dir_str)
}

#[tauri::command]
async fn get_default_cwd(app: tauri::AppHandle) -> Result<String, String> {
    // Return app data dir + "workspace" as the default working directory.
    // This is the global chat workspace — it contains AGENTS.md and other
    // project instruction files, so the LLM has context even without a project.
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let workspace = data_dir.join("workspace");
    std::fs::create_dir_all(&workspace).map_err(|e| e.to_string())?;

    // Ensure AGENTS.md exists with default content if not present
    let agents_md = workspace.join("AGENTS.md");
    if !agents_md.exists() {
        let default_content = r#"# Codem 工作目录

这是 Codem 的全局工作目录。所有全局对话的文件操作都基于此目录。

## 注意事项

- 你可以在当前工作目录下创建和编辑文件
- 使用 `ls` 查看目录内容
- 使用 `read_file` 读取文件
- 使用 `write_file` 创建新文件
"#;
        std::fs::write(&agents_md, default_content).map_err(|e| e.to_string())?;
    }

    let mut dir_str = workspace.to_string_lossy().to_string();
    if !dir_str.ends_with(std::path::MAIN_SEPARATOR) {
        dir_str.push(std::path::MAIN_SEPARATOR);
    }
    Ok(dir_str)
}

#[tauri::command]
async fn get_installer_default_lang() -> Result<String, String> {
    // Detect installer type via Windows registry:
    // - NSIS installer (Chinese .exe) → default "zh"
    // - MSI installer (English .msi) → default "en"
    // - Dev mode (no installer) → default "zh"
    #[cfg(target_os = "windows")]
    {
        // NSIS creates: HKCU\Software\Codem with UninstallString value
        let nsis_check = std::process::Command::new("reg")
            .args(["query", "HKCU\\Software\\Codem"])
            .output();
        
        if let Ok(output) = nsis_check {
            if output.status.success() {
                let stdout = String::from_utf8_lossy(&output.stdout);
                if stdout.to_lowercase().contains("codem") {
                    return Ok("zh".to_string());
                }
            }
        }

        // MSI creates: HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\{...}
        // Check for MSI uninstall entries containing "Codem" or "com.codem.app"
        for hive in &["HKLM", "HKCU"] {
            let path = format!("{}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall", hive);
            if let Ok(output) = std::process::Command::new("reg")
                .args(["query", &path, "/s", "/f", "Codem"])
                .output()
            {
                let stdout = String::from_utf8_lossy(&output.stdout);
                if stdout.to_lowercase().contains("codem") {
                    // Found Codem in uninstall registry — check if it's MSI
                    if stdout.contains("MsiExec") || stdout.contains(".msi") {
                        return Ok("en".to_string());
                    }
                }
            }
            // Also check WOW6432Node for 32-bit MSI entries
            let path_wow64 = format!("{}\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall", hive);
            if let Ok(output) = std::process::Command::new("reg")
                .args(["query", &path_wow64, "/s", "/f", "Codem"])
                .output()
            {
                let stdout = String::from_utf8_lossy(&output.stdout);
                if stdout.to_lowercase().contains("codem") {
                    if stdout.contains("MsiExec") || stdout.contains(".msi") {
                        return Ok("en".to_string());
                    }
                }
            }
        }

        // Default: Chinese (covers dev mode and NSIS)
        Ok("zh".to_string())
    }

    #[cfg(not(target_os = "windows"))]
    {
        Ok("en".to_string())
    }
}

#[tauri::command]
async fn glob_search(pattern: String, path: String) -> Result<Vec<String>, String> {
    let search_path = std::path::Path::new(&path);
    eprintln!("[glob_search] pattern: {}, path: {}, exists: {}", pattern, path, search_path.exists());
    if !search_path.exists() {
        return Err(format!("Path does not exist: {}", path));
    }
    
    let mut results = Vec::new();
    glob_search_recursive(search_path, &pattern, &mut results)?;
    eprintln!("[glob_search] found {} files", results.len());
    Ok(results)
}

fn glob_search_recursive(dir: &std::path::Path, pattern: &str, results: &mut Vec<String>) -> Result<(), String> {
    let entries = std::fs::read_dir(dir).map_err(|e| e.to_string())?;
    
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        
        // Skip hidden files and directories
        if name.starts_with('.') {
            continue;
        }
        
        let is_dir = path.is_dir();
        
        // Check if file matches pattern
        if !is_dir {
            let matches = pattern == "*" || name_matches_glob(&name, pattern);
            if matches {
                eprintln!("[glob_search] MATCH: {} against pattern: {}", name, pattern);
                results.push(path.to_string_lossy().to_string());
            }
        }
        
        // Recurse into directories
        if is_dir {
            glob_search_recursive(&path, pattern, results)?;
        }
    }
    
    Ok(())
}

fn name_matches_glob(name: &str, pattern: &str) -> bool {
    if pattern == "*" {
        return true;
    }
    // Handle {a,b,c} patterns - check each alternative
    if let Some(start) = pattern.find('{') {
        if let Some(end) = pattern[start..].find('}') {
            let prefix = &pattern[..start];
            let suffix = &pattern[start + end + 1..];
            let alternatives = &pattern[start + 1..start + end];
            eprintln!("[name_matches_glob] expanding braces: prefix={}, suffix={}, alternatives={}", prefix, suffix, alternatives);
            for alt in alternatives.split(',') {
                let expanded = format!("{}{}{}", prefix, alt.trim(), suffix);
                eprintln!("[name_matches_glob] trying expanded: {}", expanded);
                if name_matches_glob(name, &expanded) {
                    return true;
                }
            }
            return false;
        }
    }
    // Handle **/filename patterns - extract the filename part
    let effective_pattern = if let Some(idx) = pattern.rfind("**") {
        let after = &pattern[idx+2..];
        if after.starts_with('/') || after.starts_with('\\') {
            &after[1..]
        } else {
            pattern
        }
    } else if let Some(idx) = pattern.rfind('/') {
        &pattern[idx+1..]
    } else if let Some(idx) = pattern.rfind('\\') {
        &pattern[idx+1..]
    } else {
        pattern
    };
    
    if effective_pattern == "*" {
        return true;
    }
    // Simple glob matching with multiple wildcards
    let result = glob_match(effective_pattern, name);
    eprintln!("[name_matches_glob] matching '{}' against '{}': {}", name, effective_pattern, result);
    result
}

fn glob_match(pattern: &str, name: &str) -> bool {
    let pat_chars: Vec<char> = pattern.chars().collect();
    let name_chars: Vec<char> = name.chars().collect();
    let pat_len = pat_chars.len();
    let name_len = name_chars.len();
    
    // Dynamic programming approach for wildcard matching
    let mut dp = vec![vec![false; name_len + 1]; pat_len + 1];
    dp[0][0] = true;
    
    // Handle leading wildcards
    for i in 0..pat_len {
        if pat_chars[i] == '*' {
            dp[i + 1][0] = dp[i][0];
        }
    }
    
    for i in 0..pat_len {
        for j in 0..name_len {
            if pat_chars[i] == '*' {
                dp[i + 1][j + 1] = dp[i][j + 1] || dp[i + 1][j];
            } else if pat_chars[i] == '?' || pat_chars[i] == name_chars[j] {
                dp[i + 1][j + 1] = dp[i][j];
            }
        }
    }
    
    dp[pat_len][name_len]
}

/// Kill a process tree by pid.
/// Windows: `taskkill /PID <pid> /T /F` (tree + force).
/// Unix: kill the negative PGID (process group) — children spawned by the
/// shell inherit the group; SIGKILL ensures descendants die even if they
/// ignore SIGTERM. Mirrors dsh subprocess-local tree-level kill semantics.
fn kill_process_tree(pid: Option<u32>) -> Result<(), String> {
    let Some(pid) = pid else {
        return Ok(());
    };
    #[cfg(target_os = "windows")]
    {
        let status = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map_err(|e| format!("taskkill failed: {}", e))?;
        // Exit code 128 = process not found (already dead) — treat as success.
        if !status.success() && status.code() != Some(128) {
            return Err(format!("taskkill exit code {:?}", status.code()));
        }
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        // Negative pid = whole process group (children inherit the shell's group).
        // Use the `kill` binary — no extra crate dependency.
        let _ = std::process::Command::new("kill")
            .args(["-KILL", &format!("-{}", pid)])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
        Ok(())
    }
}

#[tauri::command]
async fn execute_command(command: String, cwd: Option<String>, timeout_ms: Option<u64>) -> Result<serde_json::Value, String> {
    let work_dir = cwd.unwrap_or_else(|| std::env::current_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default());

    // 运行时日志：记录命令执行（脱敏 + 截断，对标 dsh log-files 的掩码落盘）。
    let log_cmd = runtime_log::mask_secrets(&command);
    let log_cmd = runtime_log::truncate_utf8(&log_cmd, 400);
    runtime_log::append_line("INFO", &format!("exec start cwd={:?} cmd={}", work_dir, log_cmd));
    let exec_started = std::time::Instant::now();

    // Always use PowerShell for consistent UTF-8 handling
    let mut cmd = std::process::Command::new("powershell");
    // Strip powershell prefix if present
    let ps_body = if command.starts_with("powershell ") {
        command.strip_prefix("powershell ").unwrap_or(&command)
    } else {
        &command
    };
    // Strip -Command prefix if present
    let ps_body = ps_body.strip_prefix("-Command ").unwrap_or(ps_body);
    // Defensive: if the remaining body is wrapped in a pair of double quotes
    // (e.g. `powershell -Command "Get-ChildItem ... | ForEach-Object { $_.Path ... }"`),
    // strip the quotes. Otherwise PowerShell treats the body as a string literal and
    // expands $_ to $null (no pipeline context), silently producing empty output.
    let ps_body = {
        let trimmed = ps_body.trim();
        if trimmed.len() >= 2 && trimmed.starts_with('"') && trimmed.ends_with('"') {
            &trimmed[1..trimmed.len() - 1]
        } else {
            trimmed
        }
    };
    // Prepend comprehensive UTF-8 encoding setup
    // chcp 65001: Set console code page to UTF-8 (affects native commands like ipconfig, dir, etc.)
    // [Console]::OutputEncoding: .NET stdout encoding for PowerShell
    // [Console]::InputEncoding: .NET stdin encoding (for commands that read from stdin)
    // $OutputEncoding: PowerShell pipeline encoding between cmdlets
    // $PSDefaultParameterValues: Default encoding for Out-File, redirections
    let utf8_prefix = "chcp 65001 | Out-Null; [Console]::OutputEncoding = [Text.Encoding]::UTF8; [Console]::InputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [System.Text.Encoding]::UTF8; $PSDefaultParameterValues['Out-File:Encoding'] = 'utf8'; ";
    let full_command = format!("{}{}", utf8_prefix, ps_body);
    cmd.arg("-Command").arg(&full_command).current_dir(&work_dir);
    // Python encoding: PYTHONIOENCODING for stdin/stdout, PYTHONUTF8 for UTF-8 mode (3.7+)
    cmd.env("PYTHONIOENCODING", "utf-8");
    cmd.env("PYTHONUTF8", "1");
    cmd.env("PYTHONLEGACYWINDOWSSTDIO", "0");

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    // ===== 超时 + 进程树清理（对标 dsh subprocess-local 树级 kill）=====
    // 之前用 cmd.output() 同步阻塞：前端 Promise.race 超时只是丢弃 Promise，
    // 底层 PowerShell / 子进程仍在后台运行 —— 长时间命令反复超时堆积僵尸进程。
    // 现在 spawn 后按 timeout_ms 等待；超时则杀掉整个进程树
    // （Windows taskkill /T /F；Unix 杀负 PGID 进程组），再返回超时错误。
    // 默认 600s（与前端 bash 工具上限一致）；显式传参时按调用方要求。
    let effective_timeout = timeout_ms.unwrap_or(600_000).clamp(1_000, 3_600_000); // 1s ~ 1h

    let mut child = cmd
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn command: {}", e))?;

    // Take child pid before moving child into a thread
    let child_pid = child.id();

    let (stdout, stderr, status) = {
        let child = &mut child;
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();

        // Read output on a worker thread so we can race against the timeout.
        let reader = std::thread::spawn(move || -> (Vec<u8>, Vec<u8>) {
            let mut out: Vec<u8> = Vec::new();
            let mut err: Vec<u8> = Vec::new();
            if let Some(mut so) = stdout {
                let _ = std::io::Read::read_to_end(&mut so, &mut out);
            }
            if let Some(mut se) = stderr {
                let _ = std::io::Read::read_to_end(&mut se, &mut err);
            }
            (out, err)
        });

        // Wait with timeout
        let start = std::time::Instant::now();
        let status = loop {
            if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
                break status;
            }
            if start.elapsed().as_millis() >= effective_timeout as u128 {
                // Timeout — kill the process tree
                let _ = kill_process_tree(Some(child_pid));
                // Give it a moment to die, then reap
                let _ = child.wait();
                runtime_log::append_line(
                    "WARN",
                    &format!(
                        "exec timeout pid={} after {}ms cmd={}",
                        child_pid,
                        effective_timeout,
                        runtime_log::truncate_utf8(&runtime_log::mask_secrets(&command), 200)
                    ),
                );
                return Err(format!(
                    "Command timed out after {}ms. If this is a long-running command (build, test, install), try again with a higher timeout_ms value.",
                    effective_timeout
                ));
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        };

        let (out, err) = reader.join().unwrap_or((Vec::new(), Vec::new()));
        (out, err, status)
    };

    let stdout = String::from_utf8_lossy(&stdout);
    let stderr = String::from_utf8_lossy(&stderr);

    // Truncate very long output to prevent context overflow
    let stdout = if stdout.len() > 50000 {
        let truncate_at = stdout.char_indices()
            .filter(|(i, _)| *i <= 50000)
            .last()
            .map(|(i, c)| i + c.len_utf8())
            .unwrap_or(0);
        format!("{}...(truncated, {} bytes total)", &stdout[..truncate_at], stdout.len())
    } else {
        stdout.to_string()
    };
    let stderr = if stderr.len() > 10000 {
        let truncate_at = stderr.char_indices()
            .filter(|(i, _)| *i <= 10000)
            .last()
            .map(|(i, c)| i + c.len_utf8())
            .unwrap_or(0);
        format!("{}...(truncated)", &stderr[..truncate_at])
    } else {
        stderr.to_string()
    };

    runtime_log::append_line(
        "INFO",
        &format!(
            "exec end exit={:?} elapsed_ms={} cmd={}",
            status.code(),
            exec_started.elapsed().as_millis(),
            runtime_log::truncate_utf8(&runtime_log::mask_secrets(&command), 200)
        ),
    );

    Ok(serde_json::json!({
        "stdout": stdout,
        "stderr": stderr,
        "exitCode": status.code(),
    }))
}

#[tauri::command]
async fn open_folder_dialog() -> Result<String, String> {
    // Use rfd (Rusty File Dialog) for native folder picker
    let handle = rfd::AsyncFileDialog::new()
        .set_title("选择项目路径")
        .pick_folder()
        .await;

    match handle {
        Some(path) => Ok(path.path().to_string_lossy().to_string()),
        None => Err("No folder selected".to_string()),
    }
}

#[tauri::command]
async fn open_file_external(path: String) -> Result<(), String> {
    open::that(&path).map_err(|e| e.to_string())
}

#[tauri::command]
async fn reveal_item_in_dir(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if !p.exists() {
        return Err(format!("File not found: {}", path));
    }
    let abs = p.canonicalize().map_err(|e| e.to_string())?;
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer.exe")
            .args(["/select,", &abs.to_string_lossy()])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .args(["-R", &abs.to_string_lossy()])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let parent = abs.parent().unwrap_or(std::path::Path::new("/"));
        std::process::Command::new("xdg-open")
            .arg(parent)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn get_system_info() -> Result<serde_json::Value, String> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_default();
    Ok(serde_json::json!({
        "platform": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "hostname": hostname::get().map(|h| h.to_string_lossy().to_string()).unwrap_or_default(),
        "home": home,
    }))
}

/// 读取 MiMo 账号凭据 `~/.local/share/mimocode/auth.json`。
///
/// ## 返回形状（调用方按 `exists` 判态，不要按"有没有抛错"判）
///
/// - `{ "exists": false }` —— **没登录过 MiMo 账号**：该文件只有 `mimo_login`（原生 OAuth
///   回调成功后）才会创建，所以"文件不存在"是**正常态**，不是故障。前端据此走"未登录 ⇒
///   用设置里的 API Key"这条路，**不报错**。这里**只**把 `ErrorKind::NotFound`
///   （真不存在）当正常态；权限不足（`PermissionDenied`）等一律走下面的 `Err`。
/// - `{ "exists": true, ...auth.json 原文 }` —— 读到了，内容由调用方解析。
/// - `Err(String)` —— **真失败**：目录/文件读不动（权限、路径异常）或 JSON 坏了。
///   这两种都不是"没登录"，必须保持 error 级。
#[tauri::command]
async fn mimo_read_auth() -> Result<serde_json::Value, String> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map_err(|_| "Cannot determine home directory")?;
    let auth_path = std::path::Path::new(&home).join(".local").join("share").join("mimocode").join("auth.json");
    let content = match std::fs::read_to_string(&auth_path) {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            // 正常态：没登录过 MiMo 账号（auth.json 由登录流程写入，从未登录就不存在）
            return Ok(serde_json::json!({ "exists": false }));
        }
        Err(e) => return Err(format!("Cannot read {}: {}", auth_path.display(), e)),
    };
    let parsed: serde_json::Value = serde_json::from_str(&content)
        .map_err(|e| format!("Invalid JSON in auth.json: {}", e))?;
    // 把"读到了"这件事显式标出来，前端不必靠"结构里有没有字段"猜
    match parsed {
        serde_json::Value::Object(mut map) => {
            map.insert("exists".to_string(), serde_json::Value::Bool(true));
            Ok(serde_json::Value::Object(map))
        }
        // 合法 JSON 但不是对象（例如 `null` / 数组）：老实现会原样返回，调用方取不到
        // `xiaomi.key` 一样当作"未登录"。这里保持同样的可观测形状，只补 `exists`。
        other => Ok(serde_json::json!({ "exists": true, "value": other })),
    }
}

#[tauri::command]
async fn mimo_delete_auth() -> Result<(), String> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map_err(|_| "Cannot determine home directory")?;
    let auth_path = std::path::Path::new(&home).join(".local").join("share").join("mimocode").join("auth.json");
    if auth_path.exists() {
        std::fs::remove_file(&auth_path).map_err(|e| format!("Failed to delete auth.json: {}", e))?;
    }
    Ok(())
}

#[tauri::command]
async fn delete_file(path: String) -> Result<(), String> {
    std::fs::remove_file(&path).map_err(|e| format!("Failed to delete {}: {}", path, e))
}

#[tauri::command]
async fn rename_file(old_path: String, new_path: String) -> Result<(), String> {
    std::fs::rename(&old_path, &new_path).map_err(|e| format!("Failed to rename: {}", e))
}

#[tauri::command]
async fn make_directory(path: String) -> Result<(), String> {
    std::fs::create_dir_all(&path).map_err(|e| format!("Failed to create directory: {}", e))
}

#[tauri::command]
async fn path_exists(path: String) -> Result<bool, String> {
    Ok(std::path::Path::new(&path).exists())
}

// ========== MCP Stdio Commands ==========

// ========== P1-5: Sandbox Commands ==========
/// Check if a path is within the allowed workspace directory.
/// This is the Rust-side enforcement that complements the JS-side check.
#[tauri::command]
async fn check_path_in_workspace(path: String, workspace: String) -> Result<bool, String> {
    let abs_path = std::path::Path::new(&path)
        .canonicalize()
        .map_err(|e| format!("Cannot canonicalize path {}: {}", path, e))?;
    let abs_workspace = std::path::Path::new(&workspace)
        .canonicalize()
        .map_err(|e| format!("Cannot canonicalize workspace {}: {}", workspace, e))?;
    Ok(abs_path.starts_with(&abs_workspace))
}

/// Get the current process's security context (for debugging sandbox issues).
#[cfg(target_os = "windows")]
#[tauri::command]
async fn get_process_token_info() -> Result<String, String> {
    // On Windows, we can check if the process is running elevated
    // This is a simple check — full ACL manipulation requires the windows-sys crate
    match std::process::Command::new("whoami")
        .arg("/groups")
        .output()
    {
        Ok(output) => {
            if output.status.success() {
                let stdout = String::from_utf8_lossy(&output.stdout).to_string();
                Ok(stdout)
            } else {
                Err("Failed to get process token info".to_string())
            }
        }
        Err(e) => Err(format!("Failed to run whoami: {}", e)),
    }
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
async fn get_process_token_info() -> Result<String, String> {
    Ok("Process token info not available on this platform".to_string())
}

/// List files in a directory with sandbox enforcement.
/// If sandbox is enabled, only files within the workspace are returned.
#[tauri::command]
async fn list_directory_sandboxed(path: String, workspace: String, sandbox_enabled: bool) -> Result<Vec<FileInfo>, String> {
    if sandbox_enabled {
        let abs_path = std::path::Path::new(&path)
            .canonicalize()
            .map_err(|e| format!("Cannot canonicalize path: {}", e))?;
        let abs_workspace = std::path::Path::new(&workspace)
            .canonicalize()
            .map_err(|e| format!("Cannot canonicalize workspace: {}", e))?;
        if !abs_path.starts_with(&abs_workspace) {
            return Err(format!("Sandbox: Path {} is outside workspace {}", path, workspace));
        }
    }

    let mut files = Vec::new();
    let entries = std::fs::read_dir(&path).map_err(|e| format!("Failed to read directory {}: {}", path, e))?;

    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read entry: {}", e))?;
        let file_type = entry.file_type().map_err(|e| format!("Failed to get file type: {}", e))?;
        files.push(FileInfo {
            name: entry.file_name().to_string_lossy().to_string(),
            is_dir: file_type.is_dir(),
            is_file: file_type.is_file(),
            size: entry.metadata().map(|m| m.len()).unwrap_or(0),
        });
    }

    files.sort_by(|a, b| {
        if a.is_dir && !b.is_dir { std::cmp::Ordering::Less }
        else if !a.is_dir && b.is_dir { std::cmp::Ordering::Greater }
        else { a.name.cmp(&b.name) }
    });

    Ok(files)
}

#[derive(Clone, serde::Serialize)]
struct FileInfo {
    name: String,
    is_dir: bool,
    is_file: bool,
    size: u64,
}


/// codegraph_install — 应用内一键安装 CodeGraph CLI（方案 B：不要求用户敲命令/PATH）。
///
/// 1) GitHub API 解析最新 release tag；
/// 2) 下载 codegraph-win32-x64.zip（~52MB，自包含 vendored Node）；
/// 3) 解压到 %LOCALAPPDATA%\codegraph\current（路径安全：拒绝目录穿越）；
/// 4) 返回安装目录与启动器（<dir>/bin/codegraph.cmd）绝对路径——前端存入设置，
///    MCP 连接直接以该路径 spawn（.cmd 由 mcp_stdio_connect 用 cmd.exe /c 包装）。
#[derive(Serialize)]
struct CodegraphInstallResult {
    dir: String,
    launcher: String,
}

#[tauri::command]
async fn codegraph_install() -> Result<CodegraphInstallResult, String> {
    use std::io::Cursor;
    use std::path::{Component, Path, PathBuf};

    let client = reqwest::Client::builder()
        .user_agent("codem-desktop")
        .build()
        .map_err(|e| format!("http client: {e}"))?;

    // 1. 解析最新版本
    let release: serde_json::Value = client
        .get("https://api.github.com/repos/colbymchenry/codegraph/releases/latest")
        .send()
        .await
        .map_err(|e| format!("resolve latest release: {e}"))?
        .json()
        .await
        .map_err(|e| format!("parse release: {e}"))?;
    let tag = release
        .get("tag_name")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "release has no tag_name".to_string())?
        .to_string();

    // 2. 下载 zip（整包进内存一次 ~52MB，可接受）
    let url = format!(
        "https://github.com/colbymchenry/codegraph/releases/download/{tag}/codegraph-win32-x64.zip"
    );
    let bytes = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("download {tag}: {e}"))?
        .bytes()
        .await
        .map_err(|e| format!("read body: {e}"))?;

    // 3. 安装目录 %LOCALAPPDATA%\codegraph\current（覆盖式升级）
    let local = std::env::var("LOCALAPPDATA").unwrap_or_else(|_| ".".to_string());
    let root = PathBuf::from(local).join("codegraph").join("current");
    if root.exists() {
        std::fs::remove_dir_all(&root).map_err(|e| format!("clear old install: {e}"))?;
    }
    std::fs::create_dir_all(&root).map_err(|e| format!("mkdir install dir: {e}"))?;

    // 4. 解压（zip crate；拒绝目录穿越）
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes))
        .map_err(|e| format!("open archive: {e}"))?;
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("read entry {i}: {e}"))?;
        let raw = entry.name().to_string();
        // 路径安全：拒绝 ParentDir / RootDir / Prefix 组件
        let rel = Path::new(&raw);
        let safe = rel.components().all(|c| matches!(c, Component::Normal(_)));
        if !safe {
            return Err(format!("unsafe path in archive: {raw}"));
        }
        let out = root.join(rel);
        if entry.is_dir() {
            let _ = std::fs::create_dir_all(&out);
            continue;
        }
        if let Some(parent) = out.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let mut file = std::fs::File::create(&out)
            .map_err(|e| format!("create {raw}: {e}"))?;
        std::io::copy(&mut entry, &mut file)
            .map_err(|e| format!("write {raw}: {e}"))?;
        drop(file);
    }

    // 5. 定位启动器（官方布局 <root>/bin/codegraph.cmd；递归兜底）
    let launcher = find_codegraph_launcher(&root)
        .ok_or_else(|| "installed bundle has no codegraph.cmd launcher".to_string())?;

    Ok(CodegraphInstallResult {
        dir: root.display().to_string(),
        launcher,
    })
}

/// 递归查找 codegraph 启动器（bin/codegraph.cmd 优先）。
fn find_codegraph_launcher(root: &std::path::Path) -> Option<String> {
    use std::path::Path;
    let preferred = root.join("bin").join("codegraph.cmd");
    if preferred.exists() {
        return Some(preferred.display().to_string());
    }
    fn walk(dir: &Path) -> Option<String> {
        let entries = std::fs::read_dir(dir).ok()?;
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                if let Some(f) = walk(&p) {
                    return Some(f);
                }
            } else if p.file_name().and_then(|n| n.to_str()) == Some("codegraph.cmd") {
                return Some(p.display().to_string());
            }
        }
        None
    }
    walk(root)
}

/// Spawn an MCP stdio child process and start reading its stdout.
#[tauri::command]
async fn mcp_stdio_connect(
    state: State<'_, AppState>,
    name: String,
    command: String,
    args: Option<Vec<String>>,
    env: Option<HashMap<String, String>>,
) -> Result<(), String> {
    let mut cmd = if cfg!(target_os = "windows")
        && (command.to_ascii_lowercase().ends_with(".cmd")
            || command.to_ascii_lowercase().ends_with(".bat"))
    {
        // Windows CreateProcess 不能直接执行 .cmd/.bat —— 用 cmd.exe /c 包装。
        // （codegraph 官方发布是 bin/codegraph.cmd，MCP 连接指向其绝对路径。）
        let full = if let Some(a) = &args {
            format!("{} {}", command, a.join(" "))
        } else {
            command.clone()
        };
        let mut c = tokio::process::Command::new("cmd.exe");
        c.arg("/c").arg(&full);
        c
    } else {
        tokio::process::Command::new(&command)
    };
    if !(cfg!(target_os = "windows")
        && (command.to_ascii_lowercase().ends_with(".cmd")
            || command.to_ascii_lowercase().ends_with(".bat")))
    {
        if let Some(args) = &args {
            cmd.args(args);
        }
    }
    if let Some(env) = &env {
        for (k, v) in env {
            cmd.env(k, v);
        }
    }
    cmd.stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    let mut child = cmd.spawn().map_err(|e| format!("Failed to spawn MCP process: {}", e))?;
    let stdin = child.stdin.take().ok_or("Failed to capture stdin")?;
    let stdout = child.stdout.take().ok_or("Failed to capture stdout")?;

    let pending: Arc<TokioMutex<HashMap<i64, oneshot::Sender<serde_json::Value>>>> =
        Arc::new(TokioMutex::new(HashMap::new()));
    let pending_clone = pending.clone();

    // Background task: read stdout line by line, dispatch to pending requesters
    tokio::spawn(async move {
        let mut reader = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            if line.trim().is_empty() {
                continue;
            }
            // Try to parse as JSON
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&line) {
                // Check if this is a response (has "id")
                if let Some(id) = json.get("id").and_then(|v| v.as_i64()) {
                    let mut map = pending_clone.lock().await;
                    if let Some(sender) = map.remove(&id) {
                        let _ = sender.send(json);
                    }
                }
                // Notifications (no "id") are silently ignored for now
            }
        }
    });

    let mut processes = state.mcp_processes.lock().await;
    processes.insert(name, McpProcessHandle {
        stdin,
        pending,
        _child: child,
    });

    Ok(())
}

/// Send a JSON-RPC message to an MCP stdio process and wait for the response.
#[tauri::command]
async fn mcp_stdio_request(
    state: State<'_, AppState>,
    name: String,
    message: String,
) -> Result<String, String> {
    // Parse the message to extract the request id
    let parsed: serde_json::Value = serde_json::from_str(&message)
        .map_err(|e| format!("Invalid JSON message: {}", e))?;
    let id = parsed.get("id").and_then(|v| v.as_i64())
        .ok_or("Message missing 'id' field")?;

    let mut processes = state.mcp_processes.lock().await;
    let handle = processes.get_mut(&name)
        .ok_or(format!("MCP process '{}' not found", name))?;

    // Register a pending response channel
    let (tx, rx) = oneshot::channel();
    {
        let mut map = handle.pending.lock().await;
        map.insert(id, tx);
    }

    // Write message + newline to stdin
    let msg = format!("{}\n", message);
    handle.stdin.write_all(msg.as_bytes()).await
        .map_err(|e| format!("Failed to write to stdin: {}", e))?;
    handle.stdin.flush().await
        .map_err(|e| format!("Failed to flush stdin: {}", e))?;

    // Wait for response with timeout (30 seconds)
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        rx,
    ).await;

    match result {
        Ok(Ok(json)) => Ok(serde_json::to_string(&json).unwrap_or_default()),
        Ok(Err(_)) => Err("MCP response channel closed".to_string()),
        Err(_) => {
            // Timeout — clean up pending request
            let mut map = handle.pending.lock().await;
            map.remove(&id);
            Err("MCP request timeout (30s)".to_string())
        }
    }
}

/// Disconnect and kill an MCP stdio process.
#[tauri::command]
async fn mcp_stdio_disconnect(
    state: State<'_, AppState>,
    name: String,
) -> Result<(), String> {
    let mut processes = state.mcp_processes.lock().await;
    if let Some(mut handle) = processes.remove(&name) {
        // Kill the child process
        let _ = handle._child.kill().await;
        let _ = handle._child.wait().await;
    }
    Ok(())
}

#[tauri::command]
async fn mimo_login() -> Result<serde_json::Value, String> {
    eprintln!("[mimo_login] Starting native OAuth (no external mimo.exe needed)...");

    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_default();
    let auth_path = std::path::Path::new(&home).join(".local").join("share").join("mimocode").join("auth.json");

    // If auth.json already exists with a key, just return it
    if auth_path.exists() {
        if let Ok(content) = std::fs::read_to_string(&auth_path) {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
                if json["xiaomi"]["key"].as_str().is_some() {
                    eprintln!("[mimo_login] auth.json already exists, returning");
                    return Ok(serde_json::json!({ "success": true, "auth": json }));
                }
            }
        }
    }

    // --- Native OAuth: X25519 ECDH + AES-256-GCM ---
    use x25519_dalek::{EphemeralSecret, PublicKey};
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use base64::Engine;
    use sha2::{Sha256, Digest};
    use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
    use aes_gcm::aead::Aead;
    use rand::rngs::OsRng;

    let platform_url = std::env::var("MIMO_PLATFORM_URL")
        .unwrap_or_else(|_| "https://platform.xiaomimimo.com".to_string());

    // 1. Generate X25519 keypair
    let mut rng = OsRng;
    let secret = EphemeralSecret::random_from_rng(&mut rng);
    let public_key = PublicKey::from(&secret);
    let pk_base64 = URL_SAFE_NO_PAD.encode(public_key.to_bytes());

    // 2. Start local TCP listener on a random port
    let listener = std::net::TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("Failed to start local server: {}", e))?;
    let port = listener.local_addr()
        .map_err(|e| format!("Failed to get local address: {}", e))?
        .port();
    eprintln!("[mimo_login] Local callback server on port {}", port);

    let redirect_uri = format!("http://localhost:{}/", port);
    let key_name = hostname::get()
        .ok()
        .and_then(|h| h.into_string().ok())
        .unwrap_or_else(|| "codem".to_string());

    // 3. Build authorize URL
    let auth_url = format!(
        "{}/authorize?pk={}&redirect_uri={}&kn=mimocode&key_name={}",
        platform_url,
        URL_SAFE_NO_PAD.encode(pk_base64.as_bytes()),
        URL_SAFE_NO_PAD.encode(redirect_uri.as_bytes()),
        URL_SAFE_NO_PAD.encode(key_name.as_bytes()),
    );
    eprintln!("[mimo_login] Authorize URL: {}", auth_url);

    // 4. Open browser
    open::that(&auth_url)
        .map_err(|e| format!("Failed to open browser: {}", e))?;

    // 5. Wait for callback (timeout 5 minutes)
    listener.set_nonblocking(false)
        .map_err(|e| format!("Failed to set blocking mode: {}", e))?;

    let start = std::time::Instant::now();
    let (mut stream, _addr) = loop {
        if start.elapsed().as_secs() > 300 {
            return Err("Login timeout after 5 minutes".to_string());
        }
        match listener.accept() {
            Ok(conn) => break conn,
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            Err(e) => return Err(format!("Accept failed: {}", e)),
        }
    };

    // 6. Read HTTP request
    use std::io::Read;
    let mut buf = [0u8; 8192];
    let n = stream.read(&mut buf)
        .map_err(|e| format!("Read failed: {}", e))?;
    let request = String::from_utf8_lossy(&buf[..n]);
    eprintln!("[mimo_login] Callback request: {} bytes", n);

    // Parse the request line: GET /?u=xxx HTTP/1.1
    let request_line = request.lines().next().unwrap_or("");
    let path = request_line.split_whitespace().nth(1).unwrap_or("");

    // Send redirect response
    let response = format!(
        "HTTP/1.1 302 Found\r\nLocation: {}/authorize/callback?status=success\r\nConnection: close\r\n\r\n",
        platform_url
    );
    use std::io::Write;
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();

    // 7. Extract and decrypt the `u` parameter
    let query = path.split('?').nth(1).unwrap_or("");
    let u_param: Option<&str> = query.split('&')
        .find_map(|p| {
            let mut parts = p.splitn(2, '=');
            if parts.next()? == "u" { parts.next() } else { None }
        });

    let encrypted_b64 = u_param.ok_or("Missing 'u' parameter in callback")?;
    let encrypted_data = URL_SAFE_NO_PAD.decode(encrypted_b64)
        .or_else(|_| base64::engine::general_purpose::STANDARD_NO_PAD.decode(encrypted_b64))
        .map_err(|e| format!("Failed to decode encrypted data: {}", e))?;

    if encrypted_data.len() < 60 {
        return Err("Encrypted data too short".to_string());
    }

    // Layout: [32 bytes ephemeral pubkey] [12 bytes nonce] [ciphertext] [16 bytes auth tag]
    let ephemeral_pub_bytes: [u8; 32] = encrypted_data[..32]
        .try_into()
        .map_err(|_| "Invalid ephemeral public key".to_string())?;
    let ephemeral_pub = PublicKey::from(ephemeral_pub_bytes);
    let nonce_bytes = &encrypted_data[32..44];
    let ciphertext_with_tag = &encrypted_data[44..];

    // ECDH shared secret
    let shared_secret = secret.diffie_hellman(&ephemeral_pub);
    let aes_key = Sha256::digest(shared_secret.as_bytes());

    // AES-256-GCM decrypt
    let cipher = Aes256Gcm::new_from_slice(&aes_key)
        .map_err(|e| format!("AES key init failed: {}", e))?;
    let nonce = Nonce::from_slice(nonce_bytes);
    let plaintext = cipher.decrypt(nonce, ciphertext_with_tag)
        .map_err(|e| format!("Decryption failed: {}", e))?;

    let json_str = String::from_utf8(plaintext)
        .map_err(|e| format!("Decrypted data is not valid UTF-8: {}", e))?;
    eprintln!("[mimo_login] Decrypted credential data");

    let cred: serde_json::Value = serde_json::from_str(&json_str)
        .map_err(|e| format!("Failed to parse credential JSON: {}", e))?;

    let sk = cred["sk"].as_str()
        .ok_or("Missing 'sk' in credential data")?;
    let uid = cred["uid"].as_str().or(cred["uid"].as_i64().map(|_| "")).unwrap_or("");
    let url = cred["url"].as_str().unwrap_or("https://api.xiaomimimo.com/v1");

    // 8. Write auth.json
    let auth_json = serde_json::json!({
        "xiaomi": {
            "type": "api",
            "key": sk,
            "metadata": {
                "uid": uid,
                "base_url": url
            }
        }
    });

    if let Some(parent) = auth_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create auth dir: {}", e))?;
    }
    std::fs::write(&auth_path, serde_json::to_string_pretty(&auth_json).unwrap_or_default())
        .map_err(|e| format!("Failed to write auth.json: {}", e))?;

    eprintln!("[mimo_login] auth.json written successfully");
    Ok(serde_json::json!({ "success": true, "auth": auth_json }))
}

// ========== System Tray & Window Close ==========

// ========== Pet Window ==========

/// Creates a transparent, always-on-top, frameless window for the desktop pet.
/// The window floats on the desktop independently of the main window.
#[tauri::command]
async fn create_pet_window(app: AppHandle) -> Result<(), String> {
    // If the pet window already exists, just show it
    if let Some(existing) = app.get_webview_window("pet") {
        existing.show().map_err(|e| e.to_string())?;
        return Ok(());
    }

    let window = tauri::WebviewWindowBuilder::new(
        &app,
        "pet",
        tauri::WebviewUrl::App("pet.html".into()),
    )
    .title("Pet")
    .inner_size(200.0, 250.0)
    .transparent(true)
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(true) // Must be true for setSize to work programmatically
    .shadow(false) // Disable DWM shadow — eliminates the black border on transparent borderless windows
    .visible(true) // Show immediately; frontend will resize after content loads
    .build()
    .map_err(|e| format!("Failed to create pet window: {}", e))?;

    // Position at bottom-right of the primary monitor
    if let Some(monitor) = window.primary_monitor().ok().flatten() {
        let monitor_size = monitor.size();
        let scale_factor = monitor.scale_factor();
        let win_size = window.outer_size().unwrap_or(tauri::PhysicalSize::new(200, 250));
        let x = (monitor_size.width as f64 / scale_factor) - (win_size.width as f64 / scale_factor) - 24.0;
        let y = (monitor_size.height as f64 / scale_factor) - (win_size.height as f64 / scale_factor) - 8.0;
        let _ = window.set_position(tauri::Position::Logical(tauri::LogicalPosition::new(x, y)));
    }

    Ok(())
}

/// Shows a native popup context menu for the pet at the cursor position.
/// Native menus are not clipped by window boundaries.
#[tauri::command]
async fn show_pet_menu(
    app: AppHandle,
    x: f64,
    y: f64,
    pet_name: Option<String>,
    pets: Option<Vec<serde_json::Value>>,
    active_slug: Option<String>,
) -> Result<(), String> {
    // Header: pet name (disabled)
    let name_label = pet_name.unwrap_or_else(|| "宠物".to_string());
    let header_item = MenuItemBuilder::with_id("pet-header", format!("\u{1F43E} {}", name_label))
        .enabled(false)
        .build(&app)
        .map_err(|e| e.to_string())?;

    // Separator
    let sep1 = PredefinedMenuItem::separator(&app)
        .map_err(|e| e.to_string())?;

    // Always-on-top toggle (check item)
    let is_on_top = app.get_webview_window("pet")
        .map(|w| w.is_always_on_top().unwrap_or(true))
        .unwrap_or(true);
    let top_item = CheckMenuItemBuilder::with_id("pet-toggle-top", "窗口置顶")
        .checked(is_on_top)
        .build(&app)
        .map_err(|e| e.to_string())?;

    // Reset position
    let reset_item = MenuItemBuilder::with_id("pet-reset-pos", "重置位置")
        .build(&app)
        .map_err(|e| e.to_string())?;

    // Check remaining tokens
    let token_item = MenuItemBuilder::with_id("pet-check-tokens", "查看剩余 Token")
        .build(&app)
        .map_err(|e| e.to_string())?;

    // Separator before pet switch
    let sep2 = PredefinedMenuItem::separator(&app)
        .map_err(|e| e.to_string())?;

    // ─── 切换宠物样式子菜单 ───
    let switch_submenu = {
        let mut submenu = SubmenuBuilder::new(&app, "切换宠物样式");
        if let Some(ref pets_arr) = pets {
            for pet in pets_arr {
                let slug = match pet.get("slug").and_then(|s| s.as_str()) {
                    Some(s) => s.to_string(),
                    None => continue,
                };
                let name = match pet.get("name").and_then(|s| s.as_str()) {
                    Some(s) => s.to_string(),
                    None => continue,
                };
                let is_active = active_slug.as_ref().map(|s| s == &slug).unwrap_or(false);
                let label = if is_active { format!("● {}", name) } else { format!("○ {}", name) };
                submenu = submenu.item(&MenuItemBuilder::with_id(format!("pet-switch:{}", slug), label)
                    .build(&app)
                    .map_err(|e| e.to_string())?);
            }
        }
        submenu.build().map_err(|e| e.to_string())?
    };

    // Separator
    let sep3 = PredefinedMenuItem::separator(&app)
        .map_err(|e| e.to_string())?;

    // Close pet
    let close_item = MenuItemBuilder::with_id("close-pet", "关闭宠物")
        .build(&app)
        .map_err(|e| e.to_string())?;

    let menu = MenuBuilder::new(&app)
        .item(&header_item)
        .item(&sep1)
        .item(&top_item)
        .item(&reset_item)
        .item(&token_item)
        .item(&sep2)
        .item(&switch_submenu)
        .item(&sep3)
        .item(&close_item)
        .build()
        .map_err(|e| e.to_string())?;

    if let Some(window) = app.get_webview_window("pet") {
        let pos = tauri::Position::Physical(tauri::PhysicalPosition::new(x as i32, y as i32));
        menu.popup_at(window.as_ref().window(), pos)
            .map_err(|e| e.to_string())?;
    }

    Ok(())
}

/// Closes the pet window.
#[tauri::command]
async fn close_pet_window(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("pet") {
        window.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Resizes the pet window (used when scale changes).
#[tauri::command]
async fn resize_pet_window(app: AppHandle, width: f64, height: f64) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("pet") {
        window
            .set_size(tauri::LogicalSize::new(width, height))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Atomically sets the pet window's position and size in a single IPC call.
/// Eliminates the visual flicker caused by separate set_position + set_size calls.
#[tauri::command]
async fn set_pet_window_geometry(app: AppHandle, x: f64, y: f64, width: f64, height: f64) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("pet") {
        // set_position first (move window), then set_size (grow from new top-left).
        // Both are synchronous Win32 SetWindowPos calls — no async gap between them.
        window.set_position(tauri::LogicalPosition::new(x, y)).map_err(|e| e.to_string())?;
        window.set_size(tauri::LogicalSize::new(width, height)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Resizes the pet window while keeping the sprite's screen position fixed.
///
/// Anchor = horizontal center of the current window + bottom of the current window
/// (the sprite sits at the bottom-center of the window).
///
/// Uses a single Win32 `SetWindowPos` call to set position AND size simultaneously,
/// eliminating any visual drift that occurs when `set_position` + `set_size` are
/// called as two separate Win32 calls.
#[tauri::command]
async fn resize_pet_window_anchored(app: AppHandle, width: f64, height: f64) -> Result<(), String> {
    let window = app.get_webview_window("pet").ok_or("Pet window not found")?;

    // Read current physical position and size (synchronous Win32 GetWindowRect)
    let pos = window.outer_position().map_err(|e| e.to_string())?;
    let size = window.outer_size().map_err(|e| e.to_string())?;

    // Anchor: sprite horizontal center + sprite bottom (in physical pixels)
    let anchor_x = pos.x + (size.width as i32) / 2;
    let anchor_y = pos.y + size.height as i32;

    // Convert desired logical size to physical pixels
    let scale = window.scale_factor().unwrap_or(1.0);
    let phys_width = (width * scale).round() as i32;
    let phys_height = (height * scale).round() as i32;

    // New top-left so that the anchor stays fixed
    let new_x = anchor_x - phys_width / 2;
    let new_y = anchor_y - phys_height;

    // Single SetWindowPos call: sets both position and size atomically.
    // SWP_NOZORDER  — don't change z-order
    // SWP_NOACTIVATE — don't activate the window
    // SWP_NOCOPYBITS — don't copy old window content (prevents visual artifacts)
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::UI::WindowsAndMessaging::*;
        use windows::Win32::Foundation::HWND;

        let hwnd_raw = window.hwnd().map_err(|e| e.to_string())?;
        let hwnd = HWND(hwnd_raw.0 as *mut _);

        let flags = SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOCOPYBITS;
        unsafe {
            SetWindowPos(hwnd, None, new_x, new_y, phys_width, phys_height, flags)
                .map_err(|e| format!("SetWindowPos failed: {}", e))?;
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        window
            .set_position(tauri::PhysicalPosition::new(new_x, new_y))
            .map_err(|e| e.to_string())?;
        window
            .set_size(tauri::PhysicalSize::new(phys_width, phys_height))
            .map_err(|e| e.to_string())?;
    }

    Ok(())
}

#[tauri::command]
async fn hide_to_tray(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        window.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn show_from_tray(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn quit_app(app: AppHandle, pty_map: State<'_, PtyMap>) -> Result<(), String> {
    runtime_log::append_line("INFO", "quit_app invoked — cleaning up");
    // 清理所有 PTY 会话：kill 子进程，避免退出后 cmd.exe 等残留（对标 dsh
    // 进程树纪律 — Windows 上进程退出不会自动杀孙进程）。
    if let Ok(mut map) = pty_map.lock() {
        for (id, mut session) in map.drain() {
            runtime_log::append_line("INFO", &format!("pty cleanup killing id={}", id));
            // 杀整树：退出时若终端里正跑长命令（npm test 等），单 kill 会留下孤儿进程。
            if let Some(pid) = session._child.process_id() {
                let _ = kill_process_tree(Some(pid));
            }
            let _ = session._child.kill();
            drop(session);
        }
    }
    // 正常退出：先清崩溃标记（避免下次启动误报崩溃）。app.exit 可能不经过
    // RunEvent::ExitRequested（Tauri v2 直接退出），所以在这里显式清理。
    clear_active_run_marker(&app);
    app.exit(0);
    Ok(())
}

// ========== 崩溃检测标记（对标 dsh crash-evidence active-run.json）==========
// 启动时写 active-run.json；正常退出（RunEvent::ExitRequested）时删除。
// 若下次启动发现标记仍存在 → 上次进程异常退出（崩溃/强杀/断电），
// 前端可据此提示用户（例如会话可能未保存，检查恢复）。
// 仅用于诊断提示；标记写入/删除失败都不影响启动（降级为日志）。

const ACTIVE_RUN_MARKER: &str = "active-run.json";

fn crash_marker_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(dir.join(ACTIVE_RUN_MARKER))
}

/// 检测上次是否异常退出（marker 存在）。
/// 返回 true = 上次未干净退出。正常退出路径（RunEvent::ExitRequested）
/// 会删除 marker；因此启动瞬间 marker 仍存在即说明上次进程异常终止
/// （崩溃/强杀/断电）—— 会话可能未完整保存，前端可提示检查恢复。
fn detect_unclean_exit(app: &AppHandle) -> bool {
    let path = match crash_marker_path(app) {
        Ok(p) => p,
        Err(_) => return false,
    };
    std::fs::metadata(&path).is_ok()
}

/// 写入当前运行标记（含 pid + 启动时间）。
fn write_active_run_marker(app: &AppHandle) {
    let path = match crash_marker_path(app) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("[crash-marker] cannot resolve path: {}", e);
            return;
        }
    };
    let marker = serde_json::json!({
        "pid": std::process::id(),
        "startedAt": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64) // u128 → u64（serde_json 数值支持 u64）
            .unwrap_or(0),
    });
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    match std::fs::write(&path, serde_json::to_string_pretty(&marker).unwrap_or_default()) {
        Ok(_) => {}
        Err(e) => eprintln!("[crash-marker] write failed: {}", e),
    }
}

/// 正常退出时清理标记。
fn clear_active_run_marker(app: &AppHandle) {
    if let Ok(path) = crash_marker_path(app) {
        let _ = std::fs::remove_file(&path);
    }
}

fn build_tray_menu(app: &AppHandle, lang: &str) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    let (show_label, quit_label) = if lang == "en" {
        ("Show Codem", "Quit")
    } else {
        ("显示 Codem", "退出")
    };
    let show_item = MenuItemBuilder::with_id("show", show_label).build(app)?;
    let quit_item = MenuItemBuilder::with_id("quit", quit_label).build(app)?;
    MenuBuilder::new(app)
        .item(&show_item)
        .separator()
        .item(&quit_item)
        .build()
}

#[tauri::command]
async fn update_tray_language(app: AppHandle, lang: String) -> Result<(), String> {
    let menu = build_tray_menu(&app, &lang).map_err(|e| e.to_string())?;
    if let Some(tray) = app.tray_by_id("main-tray") {
        tray.set_menu(Some(menu)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ========== HTTP Proxy Commands (Skill Market) ==========

/// Response structure for http_get command
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HttpResponse {
    pub status: u16,
    pub body: String,
    pub headers: std::collections::HashMap<String, String>,
}

/// 技能市场一次刷新里同时**在飞**的 `http_get` 上限。
///
/// ## 为什么是 12
///
/// 这不是"顺手挑的整数"，而是从真机读数倒推出来的：
///
/// 1. **UI 侧的并发上限（`SOURCE_FETCH_CONCURRENCY = 8`）只管单个源的内部扇出**，
///    源与源之间仍然是 `Promise.all` 全并行 —— 真机 7 个源同开，峰值可达 7×8=56 路在飞；
///    如果同时还有在线搜索在跑，还要再翻一倍。12 = 8 + 4，刚好"一个源打满自己的
///    8 路，外加 4 路给别的源/搜索做交叉周转"，不至于让某个源独占整池把别人饿死。
/// 2. **同一个主机（`api.github.com`）的目标并发本来就不该高于 8~12**：
///    匿名配额是 60 次/小时，请求发得再快也只是更快地把配额打光（真机 1 秒打光 133 个请求）。
///    并发闸门的目的是**削峰与限流**，不是提高吞吐。
/// 3. 12 路在实测里足够快（8 路并发 30 个仓库 ≈ 1.4s，见 `.preview-shot/out-http-throughput.txt`），
///    而 `SOURCE_TIMEOUT_MS = 12s` 是源级上限 —— 12 路下 133 个请求也不会靠排队把自己排超时。
///
/// ## 为什么超限是**立即返回 `BUSY`** 而不是排队等待
///
/// 排队等待会把"前端 12s 源超时"变成唯一出路：133 个请求排在 12 路后面，
/// 队尾必然超过 12s，于是前端照旧报"源超时"——**根因没修，只是把 403 换成了排队**。
/// 立即回一个**明确的可重试错误**（`code: "BUSY"`）让前端在毫秒级就知道"这次太挤了"，
/// 而不是白等 12 秒。前端按 `code` 就能分流（错误体形状见 `busy_error`）。
const HTTP_GET_MAX_IN_FLIGHT: usize = 12;

/// 共享客户端与并发闸门的 static（建库理由见下）。
///
/// ## 为什么是共享客户端（这一轮的根因）
///
/// 改动前 `http_get` **每次调用都 `reqwest::Client::builder()...build()`**。
/// `reqwest::Client` 内部持有连接池，**新建一个 Client 就等于新建一个空池**，
/// 于是每次请求都重新做一遍 DNS + TCP + TLS 握手，且上一个请求刚建立的连接
/// 因为随 Client 一起被丢掉而**从未被复用**（连接池的意义归零）。
/// 真机读数：一次"检查更新"发出 133 个 `http_get`（api.github.com 54 / raw.githubusercontent.com 69），
/// 全部打在同一个主机上却各自握手 —— 这既是耗时来源，也是"1 秒打光 60 次/小时配额"的放大器。
///
/// ## 为什么用 `std::sync::OnceLock` 而不是 `once_cell` / `lazy_static`
///
/// `src-tauri/Cargo.toml` 里**没有** `once_cell` / `lazy_static`（已核对），
/// 而 `std::sync::OnceLock` 自 Rust 1.70 起就有，正是为此设计的。
/// 本仓库既有惯用法也是它（`storage.rs:485` 的 `static CACHE: OnceLock<...>`），
/// 而且本轮的要求是"不新增依赖"—— 那就用标准库，不为一个 static 拖进一个 crate。
///
/// ## 为什么闸门用 `tokio::sync::Semaphore`
///
/// `Semaphore::try_acquire` 是**同步**判定、不需要 await 就能知道"满没满"，
/// 于是"超限"可以在建立请求之前立刻返回，不会先占住一次等待。
/// `tokio` 已经以 `features = ["full"]` 在依赖里，同样是零新增依赖。
///
/// ## 前端**现在**怎么处置这个 `BUSY`（本注释已随前端实现同步过一次）
///
/// ⚠️ **这是本节第二次修订**：上一版写的是"前端没有为 BUSY 新增退避通道"，
/// 那在当时是事实，但**按 BUSY 退避重试随后已经实现在前端**
/// （`src/core/skill/skill-market-client.ts`），旧文案已不成立，留在这里会误导后来者。
///
/// 现在前端有**三层**（顺序即优先级）：
/// 1. **前端准入闸门**（真正的修复）：`HTTP_GET_FRONTEND_MAX_IN_FLIGHT = 8`，
///    全模块同时在飞的 `http_get` 不超过 8 路。容量**故意小于本闸门的 12** ——
///    留 4 条给 web 抓取 / figma / 宠物市场等其它调用方，避免市场把别人挤成 BUSY。
///    有了它，市场自身的超量提交（真机形态 7 源 × 8 并发 ≈ 56 路）不再发生，
///    本闸门因此**基本不会被触发**；
/// 2. **BUSY 退避重试**：`BUSY_MAX_ATTEMPTS = 3`（首次 + 2 次重试），
///    退避 250~600ms **含抖动**（抖动是因为被拒的是同一毫秒的一批，固定延时会惊群）；
///    退避总时长 ≤ 1.2s，远小于前端源级上限 12s，不会把"重试成功"拖成"源超时"；
/// 3. **如实分类**：重试耗尽仍被拒 → 抛 `HttpBusyError`，按源记进"降级账本"，
///    文案是"并发受限…部分请求未被发出…已保留上一次的结果，稍后重试即可"，
///    **绝不**说"源可达、返回为空"（请求没发出去时那句是假话）。
///
/// 也就是说：**超限不再是"静默失败"，也不再被伪装成"源是空的"**，
/// 而是"明确拒绝 + 退避重试 + 如实告知"。本闸门只需把住最后一道 12 路硬上限。
///
/// 进程内**唯一**的 `http_get` 客户端（`Ok` 是建好的客户端、`Err` 是构建失败的原因），
/// 以及进程内**唯一**的并发闸门。
///
/// ## 为什么这里**不用** `.expect()` 直接炸掉（这一点是刻意选的）
///
/// `reqwest::ClientBuilder::build()` 在本配置下确实不可能失败（参数全是常量），
/// 但"不可能失败"和"必须 panic"是两件事：改动前这里是
/// `.map_err(|e| e.to_string())?` —— 失败会变成一条**正常返回给前端的错误**。
/// 保留那条路径，等于把改动前的错误行为也一并保留；而 `.expect()` 会把一次
/// 构建失败升级成**整个进程 panic**（在 Tauri 命令里就是一次硬崩）。
/// 为了少写两行就让"构建失败"从"可报错"变成"崩应用"，不划算。
///
/// 类型是 `Result<Client, String>` 而不是 `Client`，正是为了让失败**可表示**：
/// `OnceLock` 只负责"只建一次"，成不成功由里面的 `Result` 说。
static HTTP_GET_CLIENT: std::sync::OnceLock<Result<reqwest::Client, String>> = std::sync::OnceLock::new();
static HTTP_GET_GATE: std::sync::OnceLock<tokio::sync::Semaphore> = std::sync::OnceLock::new();

/// 建一次共享客户端（只会被执行一次）。参数与理由见 `http_get` 的调用点注释。
fn build_shared_http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent("Codem/1.0 (Skill Market)")
        // 见下文：保留改动前的 15s 作为**默认**，逐次行为与旧实现完全一致。
        .timeout(std::time::Duration::from_secs(15))
        // ── 连接池参数：每一个值的来历 ──────────────────────────────────────
        //
        // `pool_max_idle_per_host` = HTTP_GET_MAX_IN_FLIGHT(12)。
        //   与并发闸门**取同一个数**是刻意的：闸门最多允许 12 路在飞，池子就该能留住
        //   这 12 条连接。取小了会在下一轮刷新时被迫重新握手；取大了只是多占空闲 socket。
        //   为什么这个数比默认值重要：reqwest 默认"每主机不限空闲连接数"，
        //   在一次 133 请求的刷新之后会留下一堆没人再用的 socket 白占资源；
        //   12 与闸门同源，天然对齐，不猜。
        .pool_max_idle_per_host(HTTP_GET_MAX_IN_FLIGHT)
        // `pool_idle_timeout` = 90s。两次"检查更新"的间隔通常远大于几秒，
        //   90s 让同一轮刷新内以及相邻两轮之间的连接**都能被复用**；
        //   而 GitHub 的负载均衡会主动掐掉长时间空闲的连接，留太久也留不住。
        .pool_idle_timeout(std::time::Duration::from_secs(90))
        // `tcp_keepalive` = 30s。连接被复用之后，最大的新风险是**另一半已经悄悄断了**
        //   （NAT/代理/负载均衡超时回收），此时复用会撞上一个半开连接。30s 让操作系统
        //   探测这个连接；不设的话要等系统默认（Windows 约 2 小时）—— 那等于每次复用
        //   都可能白等一次 15s 超时。
        .tcp_keepalive(std::time::Duration::from_secs(30))
        // `http2_keep_alive_interval` = 20s：GitHub 走 HTTP/2，在**没有流的时候**
        //   60s 就会断开空闲连接；20s 的 ping 让连接活过刷新之间的间隙。
        .http2_keep_alive_interval(std::time::Duration::from_secs(20))
        // `tcp_nodelay`：JSON 都很小，Nagle 会把小包攒起来等 ACK，
        //   在"30 个仓库并发取 Trees"这种小请求密集的场景里等于白送延迟。
        .tcp_nodelay(true)
        .build()
        .map_err(|e| e.to_string())
}

/// 取（并在首次调用时建好）进程内唯一的 `http_get` 客户端。
///
/// ## 超时放在哪一层：**client 默认 15s + 每请求可覆盖**（这是本轮的选型）
///
/// 选的是"**client 侧保留 15s 默认、请求侧用 `RequestBuilder::timeout()` 覆盖**"这一种，
/// 而不是把 15s 写死在每个调用点。理由：
/// - **契约兼容**：改动前 client 的 `.timeout(15s)` 对 `http_get` 的每一次调用都生效，
///   所以把 15s 留作 client 默认，就是**把旧行为逐字保留**（不传 timeout 的调用点行为不变）；
/// - **单一 client 需要单一默认值**：共享 client 只能有一份默认超时，而 `http_get`
///   与 `http_post`(30s) / `http_download`(60s) 的上限本来就不同 —— 那几个命令仍各有自己的
///   client，所以这里只谈 `http_get` 这一个共享 client 的默认值；
/// - **可覆盖**：以后有"web 抓取要 30s"这类需求，调用点写
///   `client.get(url).timeout(Duration::from_secs(30))` 即可（reqwest 的请求级 timeout
///   优先于 client 级），不必再动这个 static。这也正是"超时属于**请求**这一层"的正确归属：
///   同一个连接池里不同的请求本来就可以有不同的时间预算。
fn shared_http_client() -> Result<&'static reqwest::Client, String> {
    HTTP_GET_CLIENT
        .get_or_init(build_shared_http_client)
        .as_ref()
        .map_err(|e| e.clone())
}

/// 并发闸门的**纯函数落点**：拿不到许可就返回 `Err`，**不等待**。
///
/// 单独抽出来是为了能被单元测试直接钉住 —— 真机路径要占满 12 路在飞才能触发，
/// 而"测试里造不出这种竞争"是不写测试的常见借口，这里把它变成一个可测的纯逻辑。
fn acquire_http_permit(
    gate: &tokio::sync::Semaphore,
) -> Result<tokio::sync::SemaphorePermit<'_>, String> {
    gate.try_acquire().map_err(|_| busy_error())
}

/// 超并发上限时的**明确错误**（不是静默失败、也不是伪装成网络错误）。
///
/// 为什么错误体是一个 JSON 字符串而不是裸文本：本仓库的错误契约就是
/// `{code, message, retryable, hint}`（见 `storage.rs` 顶部："只给一个字符串，
/// 渲染侧只能靠正则猜，等于把'错误是值'又退回'错误是文本'"）。
/// `http_get` 的 `Err` 通道类型仍然是 `String`（**签名与返回形状逐字未变**），
/// 只是这个 String 里装的是同一个自描述结构 —— 于是前端能按 `code` 复用既有退避通道，
/// 而既有调用点（web 抓取、figma 抓取、pet 市场）拿到它只会当成一条普通错误消息，
/// 行为不外溢。
fn busy_error() -> String {
    serde_json::json!({
        "code": "BUSY",
        "message": format!(
            "并发请求已达上限（{HTTP_GET_MAX_IN_FLIGHT} 路在飞），本次请求未被发出",
        ),
        "retryable": true,
        "hint": "稍后重试；前端应退避，而不是立刻重发",
    })
    .to_string()
}

/// Performs an HTTP GET request through the Rust side (bypasses CSP restrictions).
/// Used by the skill market to fetch repository listings and skill metadata.
#[tauri::command]
async fn http_get(
    url: String,
    headers: Option<std::collections::HashMap<String, String>>,
) -> Result<HttpResponse, String> {
    // 先取客户端：**在占用并发许可之前**就把"客户端建不起来"这种错误报出去 ——
    // 否则一次构建失败会先白占一个许可（虽然只是短暂占用，但没有理由这么做）。
    let client = shared_http_client()?;

    // 有界并发：`_permit` 在函数返回（含提前 return / ? 传播）时随作用域一起归还，
    // 所以"在飞"的计数与"活着"的请求严格一一对应，不会泄漏许可。
    let _permit = acquire_http_permit(
        HTTP_GET_GATE.get_or_init(|| tokio::sync::Semaphore::new(HTTP_GET_MAX_IN_FLIGHT)),
    )?;

    let mut req = client.get(&url);
    if let Some(h) = headers {
        for (k, v) in h {
            req = req.header(k, v);
        }
    }

    let resp = req.send().await.map_err(|e| e.to_string())?;
    let status = resp.status().as_u16();

    let mut resp_headers = std::collections::HashMap::new();
    for (k, v) in resp.headers() {
        if let Ok(val) = v.to_str() {
            resp_headers.insert(k.as_str().to_string(), val.to_string());
        }
    }

    let body = resp.bytes().await
        .map(|b| String::from_utf8_lossy(&b).to_string())
        .map_err(|e| e.to_string())?;

    Ok(HttpResponse { status, body, headers: resp_headers })
}

/// Performs an HTTP POST request through the Rust side (bypasses CSP restrictions).
/// Used for GitHub API calls (e.g. creating repositories).
#[tauri::command]
async fn http_post(
    url: String,
    body: String,
    headers: Option<std::collections::HashMap<String, String>>,
) -> Result<HttpResponse, String> {
    let client = reqwest::Client::builder()
        .user_agent("Codem/1.0")
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;

    let mut req = client.post(&url).body(body);
    if let Some(h) = headers {
        for (k, v) in h {
            req = req.header(k, v);
        }
    }

    let resp = req.send().await.map_err(|e| e.to_string())?;
    let status = resp.status().as_u16();

    let mut resp_headers = std::collections::HashMap::new();
    for (k, v) in resp.headers() {
        if let Ok(val) = v.to_str() {
            resp_headers.insert(k.as_str().to_string(), val.to_string());
        }
    }

    let body = resp.bytes().await
        .map(|b| String::from_utf8_lossy(&b).to_string())
        .map_err(|e| e.to_string())?;

    Ok(HttpResponse { status, body, headers: resp_headers })
}

/// Downloads a file from a URL and saves it to the specified local path.
/// Used by the skill market to download skill ZIP packages.
#[tauri::command]
async fn http_download(
    url: String,
    dest_path: String,
    headers: Option<std::collections::HashMap<String, String>>,
) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .user_agent("Codem/1.0 (Skill Market)")
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())?;

    let mut req = client.get(&url);
    if let Some(h) = headers {
        for (k, v) in h {
            req = req.header(k, v);
        }
    }

    let resp = req.send().await.map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        return Err(format!("HTTP {}: {}", resp.status(), url));
    }

    // Ensure parent directory exists
    let dest = std::path::Path::new(&dest_path);
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    std::fs::write(&dest, &bytes).map_err(|e| e.to_string())?;

    Ok(dest_path)
}

/// Downloads a potentially large file (runtime/模型包等) with an optional
/// explicit timeout. timeout_secs = 0 / None disables the request timeout,
/// which is required for multi-hundred-MB artifact downloads.
#[tauri::command]
async fn http_download_ext(
    url: String,
    dest_path: String,
    timeout_secs: Option<u64>,
    headers: Option<std::collections::HashMap<String, String>>,
) -> Result<String, String> {
    // 下载类请求显式禁用系统/环境代理（no_proxy）：VPN 客户端常设 HTTP(S)_PROXY，
    // reqwest 默认经该代理转发，会导致对 nodejs.org / npmmirror 等下载源被代理
    // 上游异常返回 404（实测直连 200、走代理 404）。镜像本为国内直连，官方源直连
    // 由 VPN 隧道承载——大文件下载一律直连更稳。
    let mut builder = reqwest::Client::builder()
        .user_agent("Codem/1.0 (zvec-grep runtime)")
        .no_proxy();
    if let Some(secs) = timeout_secs.filter(|s| *s > 0) {
        builder = builder.timeout(std::time::Duration::from_secs(secs));
    }
    let client = builder.build().map_err(|e| e.to_string())?;

    let mut req = client.get(&url);
    if let Some(h) = headers {
        for (k, v) in h {
            req = req.header(k, v);
        }
    }

    let resp = req.send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}: {}", resp.status(), url));
    }

    let dest = std::path::Path::new(&dest_path);
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    std::fs::write(&dest, &bytes).map_err(|e| e.to_string())?;
    Ok(dest_path)
}

/// Extracts a ZIP archive into a destination directory (zip-slip safe).
/// Used to unpack the bundled node / zvec-grep runtime and model artifacts.
/// Returns the number of files written.
#[tauri::command]
async fn extract_zip(zip_path: String, dest_dir: String) -> Result<u32, String> {
    let file = std::fs::File::open(&zip_path).map_err(|e| format!("open zip: {}", e))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("parse zip: {}", e))?;
    let dest = std::path::Path::new(&dest_dir);
    let mut written = 0u32;

    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| format!("entry {}: {}", i, e))?;
        // enclosed_name 拒绝绝对路径与 ..（zip-slip 防护）
        let rel = match entry.enclosed_name() {
            Some(p) => p.to_path_buf(),
            None => continue,
        };
        let out_path = dest.join(rel);

        if entry.is_dir() {
            std::fs::create_dir_all(&out_path).map_err(|e| e.to_string())?;
            continue;
        }
        if let Some(parent) = out_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut out = std::fs::File::create(&out_path).map_err(|e| e.to_string())?;
        std::io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
        written += 1;
    }

    Ok(written)
}

// ========== Main Entry ==========

#[cfg_attr(mobile, tauri::mobile_entry_point)]
/// 崩溃原因落盘（对标 dsh crash-evidence）：panic 时写入 crash log，
/// 供用户/开发者诊断。打包版 stderr 不可见，panic 信息否则完全丢失。
fn install_panic_hook() {
    std::panic::set_hook(Box::new(|info| {
        let msg = format!(
            "Codem crash at {}\n{}\n",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0),
            info
        );
        eprintln!("[panic] {}", msg.trim());
        // 写日志到用户目录（app_data_dir 在 hook 阶段不可用，用 APPDATA/HOME）
        #[cfg(target_os = "windows")]
        let base = std::env::var("APPDATA").unwrap_or_else(|_| ".".to_string());
        #[cfg(not(target_os = "windows"))]
        let base = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
        let dir = std::path::Path::new(&base).join("com.codem.app");
        let _ = std::fs::create_dir_all(&dir);
        // 同时写入运行时日志（同目录，按日轮转 + 脱敏）。
        runtime_log::append_line_to(&dir, "FATAL", &runtime_log::mask_secrets(msg.trim()));
        let path = dir.join("codem-crash.log");
        // 追加写入（用 OpenOptions append）
        use std::io::Write;
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
            let _ = f.write_all(msg.as_bytes());
        }
    }));
}

pub fn run() {
install_panic_hook();
// ===== 微信 ClawBot 桥（iLink 传输层）管理态 =====
let ilink_state = ilink::IlinkState::new();
// ===== 手机连接（phone-link）管理态 =====
let phone_state = phone::PhoneState::new();
// ===== 存储引擎（Rust 原生 SQLite）管理态 =====
// 路径按 `%APPDATA%\<identifier>` 自行解析（不依赖 AppHandle，见 storage.rs 注释）；
// 引擎本体在首次调用时惰性打开。
let storage_state = storage::init_state();
let app = tauri::Builder::default()
.plugin(tauri_plugin_shell::init())
.plugin(tauri_plugin_fs::init())
.plugin(tauri_plugin_notification::init())
.plugin(tauri_plugin_updater::Builder::new().build())
.plugin(tauri_plugin_process::init())
.plugin(tauri_plugin_dialog::init())
        .manage(ilink_state.clone())
        .manage(phone_state.clone())
        .manage(storage_state)
        .manage(Arc::new(Mutex::new(HashMap::<String, PtySession>::new())) as PtyMap)
        .manage(AppState {
            providers: Mutex::new(vec![
                ProviderConfig {
                    id: "openai".to_string(),
                    name: "OpenAI".to_string(),
                    api_key: String::new(),
                    base_url: Some("https://api.openai.com/v1".to_string()),
                },
                ProviderConfig {
                    id: "anthropic".to_string(),
                    name: "Anthropic".to_string(),
                    api_key: String::new(),
                    base_url: Some("https://api.anthropic.com/v1".to_string()),
                },
            ]),
            default_model: Mutex::new("gpt-4o".to_string()),
            default_agent: Mutex::new("build".to_string()),
            mcp_processes: TokioMutex::new(HashMap::new()),
        })
        .invoke_handler(tauri::generate_handler![
            secret_backend_available,
    secret_seal,
    secret_unseal,
    send_message,
            get_providers,
            add_provider,
            remove_provider,
            get_default_model,
            set_default_model,
            get_default_agent,
            set_default_agent,
            read_file,
            read_file_lines,
            read_file_base64,
            get_system_temp_dir,
            write_file,
            append_file,
            list_directory,
            delete_directory,
            delete_directory_permanent,
            execute_command,
codegraph_install,
            open_folder_dialog,
            open_file_external,
            reveal_item_in_dir,
            get_system_info,
            mimo_read_auth,
            mimo_delete_auth,
            mimo_login,
            delete_file,
            rename_file,
            make_directory,
path_exists,
            mcp_stdio_connect,
            mcp_stdio_request,
            mcp_stdio_disconnect,
            glob_search,
            get_app_data_dir,
            get_default_cwd,
            get_installer_default_lang,
            hide_to_tray,
            show_from_tray,
            quit_app,
            update_tray_language,
            http_get,
            http_post,
            http_download,
            http_download_ext,
            extract_zip,
            create_pet_window,
            close_pet_window,
            resize_pet_window,
            set_pet_window_geometry,
            resize_pet_window_anchored,
            show_pet_menu,
            spawn_pty,
            write_pty,
            resize_pty,
            close_pty,
            create_browser_window,
            close_browser_window,
            // P1-5: Sandbox commands
            check_path_in_workspace,
            get_process_token_info,
            list_directory_sandboxed,
            // 微信 ClawBot 桥（iLink 传输层）
            ilink::ilink_status,
            ilink::ilink_start_login,
            ilink::ilink_login_submit_verify,
            ilink::ilink_logout,
            ilink::ilink_send_text,
            // 手机连接（phone-link）
            phone::phone_start,
            phone::phone_stop,
            phone::phone_status,
            phone::phone_decide,
            phone::phone_unpair,
            phone::phone_respond,
            // 存储引擎（Rust 原生 SQLite）：类型化仓储命令，不接受 SQL
            storage::storage_invoke,
            storage::storage_batch,
            storage::storage_health,
            storage::storage_integrity_check,
            storage::storage_checkpoint,
            storage::storage_capabilities,
            storage::storage_info,
        ])
        .setup({
            // 捕获 ilink_state（Arc owned）以满足 setup 闭包的 'static 约束。
            let ilink_state = ilink_state.clone();
            move |app| {
            // ===== 运行时日志：清理过期文件 + 启动记录（对标 dsh log-files）=====
            runtime_log::purge_old_logs();
            // ===== 崩溃检测标记（对标 dsh crash-evidence）=====
            // 先检测上次是否异常退出，再写本次运行标记。
            let unclean = detect_unclean_exit(app.handle());
            runtime_log::append_line(
                "INFO",
                &format!(
                    "app started pid={} unclean_exit={}",
                    std::process::id(),
                    unclean
                ),
            );
            if unclean {
                eprintln!("[crash-marker] previous run did not exit cleanly — session may not be saved");
                runtime_log::append_line("WARN", "previous run did not exit cleanly — session may not be saved");
                let _ = app.emit("previous-run-unclean", ());
            }
            write_active_run_marker(app.handle());

            // Apply window vibrancy (frosted glass effect)
            #[cfg(target_os = "windows")]
            {
                if let Some(window) = app.get_webview_window("main") {
                    // Win11: Mica (wallpaper-tinted); fallback to Win10 Acrylic
                    let result = window_vibrancy::apply_mica(&window, Some(true));
                    if let Err(e) = result {
                        eprintln!("[vibrancy] Mica failed ({}), trying Acrylic", e);
                        let _ = window_vibrancy::apply_acrylic(&window, Some((18, 18, 18, 100)));
                    }
                }
            }

            #[cfg(target_os = "macos")]
            {
                if let Some(window) = app.get_webview_window("main") {
                    use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};
                    let _ = apply_vibrancy(&window, NSVisualEffectMaterial::HudWindow, Some(NSVisualEffectState::Active), None);
                }
            }

            // Build system tray — FIX: 失败降级而非 panic。
            // 之前 .expect() 在托盘/图标初始化失败时直接崩溃整个应用
            // （对标 dsh：启动资源失败应降级继续，不阻塞主流程）。
            let app_handle = app.handle().clone();
            let tray_result = (|| -> tauri::Result<()> {
                let menu = build_tray_menu(&app_handle, "zh")?;
                let icon = match app.default_window_icon() {
                    Some(i) => i.clone(),
                    None => {
                        eprintln!("[tray] no default window icon — skipping system tray");
                        return Ok(());
                    }
                };
                let _tray = TrayIconBuilder::with_id("main-tray")
                .icon(icon)
                .tooltip("Codem")
                .menu(&menu)
                .on_menu_event(move |app, event| {
                    match event.id.as_ref() {
                        "show" => {
                            if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                        }
                        "quit" => {
                            // 正常退出：清崩溃标记，避免下次启动误报。
                            // FIX: 直接 app.exit 会跳过前端的 DB flush（saveDatabase
                            // 500ms 防抖可能未落盘，退出即丢最近写入）。改为先通知
                            // 前端 flush（前端 flush 后调 quit_app 真正退出），
                            // 2.5s 兜底强制退出（防前端卡死导致无法退出）——
                            // 兜底前检查主窗口是否仍在（quit_app 已退出则窗口已销毁）。
                            runtime_log::append_line("INFO", "tray quit menu — requesting frontend flush");
                            clear_active_run_marker(app);
                            let _ = app.emit("quit-requested", ());
                            let app2 = app.clone();
                            std::thread::spawn(move || {
                                std::thread::sleep(std::time::Duration::from_millis(2500));
                                if app2.get_webview_window("main").is_some() {
                                    let _ = app2.exit(0);
                                }
                            });
                        }
                        "close-pet" => {
                            // Pet context menu → notify frontend to disable pet
                            let _ = app.emit("pet-disable-request", ());
                        }
                        "pet-toggle-top" => {
                            if let Some(window) = app.get_webview_window("pet") {
                                let current = window.is_always_on_top().unwrap_or(true);
                                let _ = window.set_always_on_top(!current);
                            }
                        }
                        "pet-reset-pos" => {
                            if let Some(window) = app.get_webview_window("pet") {
                                if let Some(monitor) = window.primary_monitor().ok().flatten() {
                                    let monitor_size = monitor.size();
                                    let scale_factor = monitor.scale_factor();
                                    let win_size = window.outer_size().unwrap_or(tauri::PhysicalSize::new(200, 250));
                                    let px = (monitor_size.width as f64 / scale_factor) - (win_size.width as f64 / scale_factor) - 24.0;
                                    let py = (monitor_size.height as f64 / scale_factor) - (win_size.height as f64 / scale_factor) - 8.0;
                                    let _ = window.set_position(tauri::Position::Logical(tauri::LogicalPosition::new(px, py)));
                                }
                            }
                        }
                        "pet-check-tokens" => {
                            // Notify main window to fetch token info and forward to pet
                            let _ = app.emit("pet-check-tokens-request", ());
                        }
                        id if id.starts_with("pet-switch:") => {
                            // Pet switch request — extract slug and notify main window
                            let slug = &id["pet-switch:".len()..];
                            let _ = app.emit("pet-switch-request", slug.to_string());
                        }
                        _ => {}
                    }
                })
                .on_tray_icon_event(move |tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            if window.is_visible().unwrap_or(false) {
                                let _ = window.hide();
                            } else {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                    }
                })
                .build(app)?;
                Ok(())
            })();
            if let Err(e) = tray_result {
                // 降级：托盘失败不阻塞启动（窗口/主流程照常），仅记录日志。
                eprintln!("[tray] failed to build system tray (non-fatal): {}", e);
                runtime_log::append_line("WARN", &format!("system tray build failed (non-fatal): {}", e));
            }

            // ===== 微信 ClawBot 桥：启动恢复（有未过期会话 → 自动续连）=====
            {
                let ilink_app = app.handle().clone();
                let ilink_st = ilink_state.clone();
                tauri::async_runtime::spawn(async move {
                    ilink::restore_on_startup(ilink_app, ilink_st).await;
                });
            }

            Ok(())
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        match event {
            tauri::RunEvent::WindowEvent {
                label,
                event: WinEvent::CloseRequested { api, .. },
                ..
            } => {
                // Pet window: allow close immediately (no tray logic)
                if label == "pet" {
                    // Let the default close proceed — do NOT call prevent_close()
                    return;
                }
                // Main window: prevent default close and let frontend decide
                // (tray minimize vs. quit app)
                api.prevent_close();
                if let Some(window) = app_handle.get_webview_window(&label) {
                    let _ = window.emit("close-requested", ());
                }
            }
            tauri::RunEvent::ExitRequested { .. } => {
                // 真正退出（用户 quit / tray quit / quit_app）—— 清理崩溃标记，
                // 使下次启动能区分"干净退出"与"崩溃"。
                runtime_log::append_line("INFO", "process exiting (ExitRequested)");
                clear_active_run_marker(app_handle);
            }
            _ => {}
        }
    });
}

/// `http_get` 根因改造的回归（第 63 轮续：共享客户端 + 并发闸门）。
///
/// ## 为什么这些用例不"发真请求"
///
/// 要真触发"12 路占满"得让 13 个请求同时卡在网络里，那既依赖外网也依赖时序，
/// 是典型的 flaky 测试源。所以这里把**可判定的部分**钉死：
///  - 闸门的容量与"满了必拒"这个**纯逻辑**（`acquire_http_permit` 直接喂一个 Semaphore）；
///  - 拒绝时的错误体形状（前端按 `code` 分流的依据，必须逐字稳定）；
///  - 共享客户端是**同一实例**（根因：连接池复用），用 `ptr::eq` 断言；
///  - 契约形状未变（`HttpResponse` 的字段名与 JSON 键逐个核对）。
#[cfg(test)]
mod http_gate_tests {
    use super::*;

    #[test]
    fn gate_admits_exactly_capacity_then_refuses() {
        let gate = tokio::sync::Semaphore::new(HTTP_GET_MAX_IN_FLIGHT);

        let mut held = Vec::new();
        for i in 0..HTTP_GET_MAX_IN_FLIGHT {
            held.push(
                acquire_http_permit(&gate)
                    .unwrap_or_else(|e| panic!("第 {i} 个许可应当拿到，实际被拒：{e}")),
            );
        }

        let refused = acquire_http_permit(&gate)
            .expect_err("占满之后第 N+1 个请求必须被明确拒绝，而不是排队或静默失败");
        assert!(
            refused.contains("\"code\":\"BUSY\""),
            "拒绝必须是带错误码的明确错误，实际：{refused}"
        );

        // 归还一个许可 → 立刻又能拿到（闸门不是"一次拒绝就永久坏掉"）。
        // 这里必须**绑定**而不是 `let _ =`：真实路径里许可会被一直持有到请求结束
        // （`_permit` 在 `http_get` 的函数作用域里），绑定才是同一语义。
        held.pop();
        let reacquired = acquire_http_permit(&gate).expect("归还许可之后应当能再次拿到");
        assert!(
            reacquired.num_permits() == 1,
            "重新拿到的应当是 1 个许可，实际 {}",
            reacquired.num_permits()
        );
    }

    /// 前端靠 `code`/`retryable` 分流，所以错误体必须**自描述且可解析**。
    #[test]
    fn busy_error_is_self_describing_and_retryable() {
        let payload: serde_json::Value =
            serde_json::from_str(&busy_error()).expect("BUSY 错误体必须是合法 JSON");

        assert_eq!(payload["code"], "BUSY");
        assert_eq!(payload["retryable"], true, "BUSY 必须可重试，否则前端只能白等超时");
        assert!(
            payload["hint"].as_str().is_some_and(|h| !h.is_empty()),
            "兜底档必须带处置建议（见 storage.rs 的 StorageErrorPayload 口径）"
        );
        assert!(
            payload["message"]
                .as_str()
                .is_some_and(|m| m.contains(&HTTP_GET_MAX_IN_FLIGHT.to_string())),
            "消息里要说清上限是多少，日志才可复核"
        );
    }

    /// 根因回归：**共享客户端必须是同一个实例**，否则连接池复用无从谈起。
    ///
    /// 这条守的是"不要把 `Client::builder()` 写回函数体里"——改动前它就在那里。
    #[test]
    fn shared_client_is_one_instance_across_calls() {
        let a = shared_http_client().expect("共享客户端应当能建起来") as *const reqwest::Client;
        let b = shared_http_client().expect("第二次取也应当成功") as *const reqwest::Client;
        assert!(
            std::ptr::eq(a, b),
            "http_get 必须复用同一个 reqwest::Client（连接池在它内部），否则每次调用都要重新握手"
        );
    }

    /// 客户端的构建失败必须是**可返回的错误**，而不是 panic。
    ///
    /// `build_shared_http_client()` 在现配置下不会失败，所以这里只能守"签名允许失败"
    /// 这件事本身（返回 `Result`）—— 那条错误路径正是改动前 `.map_err(...)?` 的形态。
    #[test]
    fn client_build_is_a_result_not_a_panic() {
        let built: Result<reqwest::Client, String> = build_shared_http_client();
        assert!(built.is_ok(), "本配置下应当构建成功；失败时也必须以 Err 返回而不是 panic");
    }

    /// 契约形状：`http_get` 的返回 JSON 键名**逐字未变**（web 抓取 / figma 抓取共用）。
    #[test]
    fn http_response_json_shape_is_unchanged() {
        let resp = HttpResponse {
            status: 200,
            body: "{}".to_string(),
            headers: std::collections::HashMap::new(),
        };
        let v = serde_json::to_value(&resp).expect("序列化 HttpResponse");
        let obj = v.as_object().expect("HttpResponse 必须是 JSON 对象");
        let mut keys: Vec<&str> = obj.keys().map(|k| k.as_str()).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            vec!["body", "headers", "status"],
            "http_get 的返回形状是对外契约，不许变"
        );
        assert_eq!(obj["status"], 200);
    }
}

#[cfg(test)]
mod delete_tests {
    use super::*;

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("codem-delete-test-{}-{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    #[test]
    fn removes_a_nested_tree_including_readonly_files() {
        let root = temp_dir("nested");
        let nested = root.join("sub-skills").join("openai-serving");
        std::fs::create_dir_all(&nested).expect("create nested dir");
        std::fs::write(root.join("SKILL.md"), "# skill").expect("write skill");
        std::fs::write(nested.join("SKILL.md"), "# sub skill").expect("write sub skill");
        let readonly = root.join("locked.md");
        std::fs::write(&readonly, "locked").expect("write readonly file");
        let mut permissions = std::fs::metadata(&readonly).expect("metadata").permissions();
        permissions.set_readonly(true);
        std::fs::set_permissions(&readonly, permissions).expect("set readonly");

        remove_directory_permanent(&root.to_string_lossy()).expect("delete tree");

        assert!(!root.exists(), "整棵目录树应被删除");
    }

    #[test]
    fn is_idempotent_for_missing_paths() {
        let root = temp_dir("missing");
        std::fs::remove_dir_all(&root).expect("cleanup");
        remove_directory_permanent(&root.to_string_lossy()).expect("missing path is not an error");
    }

    #[test]
    fn refuses_empty_paths_and_drive_roots() {
        assert!(remove_directory_permanent("").is_err());
        assert!(remove_directory_permanent("   ").is_err());
        #[cfg(target_os = "windows")]
        assert!(remove_directory_permanent("C:\\").is_err());
    }

    /// The recycle-bin path must always return. The old PowerShell +
    /// `OnlyErrorDialogs` implementation could wait on an invisible dialog
    /// forever, which is what froze "删除技能" in the UI.
    #[cfg(target_os = "windows")]
    #[test]
    fn recycle_bin_path_returns_without_waiting_on_a_dialog() {
        let root = temp_dir("recycle");
        std::fs::write(root.join("note.md"), "hello").expect("write file");

        let started = std::time::Instant::now();
        let result = move_directory_to_recycle_bin(&root.to_string_lossy());
        let elapsed = started.elapsed();
        eprintln!("[delete_tests] recycle outcome={:?} elapsed={:?}", result, elapsed);

        assert!(elapsed.as_secs() < 20, "移入回收站必须返回，实际耗时 {:?}", elapsed);
        match result {
            Ok(()) => assert!(!root.exists(), "返回成功后目录应已不在原位"),
            Err(message) => {
                assert!(root.exists(), "失败时目录应保持原样: {}", message);
                assert!(message.contains("回收站"), "失败信息应说明回收站路径: {}", message);
            }
        }
    }
}
