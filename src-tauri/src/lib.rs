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
mod js_sandbox;
mod js_sandbox_session;
mod runtime_log;
// 渲染进程崩溃取证（第 71 轮）：WebView2 `ProcessFailed` → 运行时日志 +
// 前端心跳（含进程树内存）+ 退出原因区分。见 crash_evidence.rs 顶部的事故注释。
mod crash_evidence;
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
    /// ★ 第 185 波：stdin 单独包一层锁（`Arc<TokioMutex<…>>`）。
    ///
    /// 改前它是**裸** `ChildStdin`，只有 `mcp_processes` 整表锁能保护它 ⇒ 发一个请求
    /// 就必须**从头到尾**持有整表锁（包括等应答的 30 s）⇒ 期间"断开"、别的服务器的请求、
    /// 退出时的回收全部排队/抢不到。现在：整表锁只用来取这两个 Arc，取完立刻放掉，
    /// 写 stdin 由这把小锁串行化，等应答**不持任何锁**。
    stdin: Arc<TokioMutex<tokio::process::ChildStdin>>,
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

/// 分窗读取的**上限**（单次 IPC 返回的字节数）。8 MB 是"IPC 与 JS 字符串都舒服"的量级：
/// 600 MB 的会话日志 = 75 次 IPC，每次的字符串都是可回收的临时对象。
const TEXT_WINDOW_MAX_BYTES: u64 = 8 * 1024 * 1024;
/// 分窗读取的**下限**（调用方给得太小会退化成逐行 IPC）。
const TEXT_WINDOW_MIN_BYTES: u64 = 64 * 1024;
/// 单行允许的最大长度。JSONL 的一行是一条消息（正文 + 思考 + 工具调用），
/// 正常几十 KB、极端几百 KB；这里给 128 MB 的硬上限只是为了**不把内存吃光**，
/// 真撞上就应该明确报错，而不是悄悄截断（截断 = 造出一条坏行）。
const TEXT_WINDOW_MAX_LINE_BYTES: u64 = 128 * 1024 * 1024;

/// 分窗读取的返回体。`next_offset` **总是指向下一个行首**（或文件末尾），
/// 所以调用方循环时永远从"一行的开头"继续，不会切出半行。
///
/// ## 第 95 波：`rename_all = "camelCase"` —— 这里的**线上字段名**曾经和消费方对不上
///
/// 前端（`src/core/file-api.ts` 的 `TextWindow`）读的是 `nextOffset`，而 Rust 默认序列化出的是
/// `next_offset` ⇒ **真机上那个字段恒为 `undefined`**，于是 `forEachLogLine` 的
/// `offset = w.nextOffset` 每轮都退回 0：窗口不前进。文件小于一个窗口（8 MB）时，
/// 第一窗就 `eof`，所以看不出问题；**超过一个窗口的日志会原地打转**。
/// 前端类型、mock 与共享桩（`src/test/helpers/tauri-fs-stub.ts`）全都写的是 camelCase，
/// 所以这里改线上名字（让现实与所有消费方的声明一致），而不是去改一圈消费方。
/// 判据：`wire_naming_tests` 直接对 `serde_json::to_value` 的结果断言键名。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct TextWindow {
    /// 本次返回的文本。**只含完整行**（除文件末尾未换行的最后一行）。
    text: String,
    /// 下一次调用应当传的 offset（= 本次消费到的字节位置）
    next_offset: u64,
    /// 是否已到文件末尾
    eof: bool,
    /// 文件总字节数（让调用方不必再问一次）
    size: u64,
}

/// `read_text_window` 的实现体（与命令分开：纯函数才能被单测直接喂临时文件）。
///
/// ## 为什么必须"行对齐"
///
/// 直接在任意字节处切开会切出**半行 JSON**；更糟的是切在多字节 UTF-8 字符中间会让整个
/// 窗口解码失败。所以每次读完 `max_bytes` 之后继续读到**下一个换行符**为止，
/// 并且把 `next_offset` 落在换行之后 —— 不变量：**任何一次调用的 offset 都是行首**。
fn read_text_window_impl(
    path: &str,
    offset: u64,
    max_bytes: u64,
) -> Result<TextWindow, String> {
    use std::io::{Read, Seek, SeekFrom};

    let want = max_bytes.clamp(TEXT_WINDOW_MIN_BYTES, TEXT_WINDOW_MAX_BYTES);
    let mut file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let size = file.metadata().map_err(|e| e.to_string())?.len();

    if offset >= size {
        return Ok(TextWindow {
            text: String::new(),
            next_offset: size,
            eof: true,
            size,
        });
    }

    file.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
    let mut buf: Vec<u8> = Vec::with_capacity(want as usize);
    {
        let mut limited = (&mut file).take(want);
        limited.read_to_end(&mut buf).map_err(|e| e.to_string())?;
    }

    // 补到行尾：读够一个窗口后继续逐字节读到 '\n'（或文件结尾）。
    // 单行超过硬上限 → 明确报错（绝不截断：截断会造出一条永远读不出来的坏行）。
    let mut extended: u64 = 0;
    let mut byte = [0u8; 1];
    while buf.last() != Some(&b'\n') {
        match file.read(&mut byte) {
            Ok(0) => break, // 文件末尾未换行的最后一行
            Ok(_) => {
                buf.push(byte[0]);
                extended += 1;
                if extended > TEXT_WINDOW_MAX_LINE_BYTES {
                    return Err(format!(
                        "E_LINE_TOO_LONG: single line exceeds {TEXT_WINDOW_MAX_LINE_BYTES} bytes at offset {offset} — refusing to truncate a log line"
                    ));
                }
            }
            Err(e) => return Err(e.to_string()),
        }
    }

    let next_offset = offset + buf.len() as u64;
    // offset == 0 时按 `read_file` 的同一约定剥掉 UTF-8 BOM
    if offset == 0 && buf.starts_with(&[0xEF, 0xBB, 0xBF]) {
        buf.drain(0..3);
    }

    let text = String::from_utf8(buf).map_err(|e| {
        format!(
            "E_NOT_UTF8: window at offset {offset} is not valid UTF-8 ({}); the file may be corrupted",
            e.utf8_error()
        )
    })?;

    Ok(TextWindow {
        text,
        next_offset,
        eof: next_offset >= size,
        size,
    })
}

/// 分窗读取文本文件（**行对齐**）。
///
/// ## 为什么需要它（真机取证）
///
/// 会话的**权威副本**是 `sessions/<id>.jsonl` 追加日志，它会随对话增长（真机见过
/// **600 MB** 的单个会话日志）。而 `read_file` 有 50 MB 上限（那个上限是给"LLM 整读源文件"
/// 用的护栏），于是日志一旦超过 50 MB：hydrate 读不到（回退索引）、回填跳过、
/// **唯一能给它瘦身的压缩步骤静默失效** —— 维护每次都打印"日志压缩 0 个会话"，
/// 看起来像"没有需要压缩的"，实际是"根本读不出来"。
///
/// 这不是给 `read_file` 松绑：600 MB 一次性进 JS 堆本来就不该做。
/// 正确做法是**分窗 + 行对齐**，让调用方按窗口循环消费。
#[tauri::command]
async fn read_text_window(
    path: String,
    offset: Option<u64>,
    max_bytes: Option<u64>,
) -> Result<TextWindow, String> {
    let offset = offset.unwrap_or(0);
    let max_bytes = max_bytes.unwrap_or(TEXT_WINDOW_MAX_BYTES);
    tokio::task::spawn_blocking(move || read_text_window_impl(&path, offset, max_bytes))
        .await
        .map_err(|e| e.to_string())?
}

/// Result of a paginated file read. The total_lines field lets the frontend
/// show "line X of Y" without a second round-trip.
///
/// 第 95 波：`rename_all = "camelCase"` —— 同 `TextWindow`。前端读 `totalLines` / `hasMore`，
/// Rust 默认给的是 `total_lines` / `has_more` ⇒ `read` 工具那条
/// "还有更多行，用 offset 继续读" 的提示**从来没出现过**（静默截断，模型不知道文件没读完）。
#[derive(serde::Serialize, Debug)]
#[serde(rename_all = "camelCase")]
struct ReadFileLinesResult {
    /// The numbered text (lines with "N: " prefix, joined by \n).
    text: String,
    /// Total number of lines in the file.
    total_lines: usize,
    /// Whether there are more lines after the returned range.
    has_more: bool,
    /**
     * 第 181 波（T-3，对标 Pi `cdf79797b` 的 `droppedLines` / `droppedBytes`）：
     * **没被返回的行数与字符数**。
     *
     * 为什么需要它：此前只有一句"还有更多行，用 offset 继续读"，模型**无法判断还差多少**
     * （差 3 行还是 3 万行，决定它该继续翻页还是改用 grep/bash）。Pi 的做法是把丢弃量
     * **精确计数**并交给模型，我们这里对齐同一口径。
     *
     * 计数与 `text` **在同一次扫描里产生**（不额外读文件、不额外遍历），所以两者一定自洽。
     */
    dropped_lines: usize,
    /// 未返回部分的字符数（按 `output` 里实际会占用的字符口径：不含 "N: " 行号前缀）
    dropped_chars: usize,
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

    // 第 181 波（T-3）：主体抽成同步 `_impl`，这样判据能直接驱动它
    // （与 `read_text_window_impl` / `file_version_impl` 同一惯例；
    //  否则只能靠"起一个 tokio 运行时 + 造临时文件"的间接测法）。
    tokio::task::spawn_blocking(move || read_file_lines_impl(&path, offset, limit, max_chars))
        .await
        .map_err(|e| e.to_string())?
}

/// `read_file_lines` 的同步主体（可在 `cargo test` 里直接调用）。
///
/// ## 第 183 波：从"逐行解码"改成**字节扫描**（对齐 Pi 的 `BinaryReader.scanLines`）
///
/// 改前的实现走 `BufRead::lines()` —— 它对**每一行**都分配一个 `String` 并做一次 UTF-8
/// 解码，只为拿到 `total_lines` / `dropped_chars` 这两个数。于是读一个 GB 级日志、
/// 哪怕只要 100 行，也要付出**整文件解码 + 数百万次分配**的代价（真机上就是"读大日志卡住"）。
///
/// 改后只做**一遍字节扫描**（64 KiB 缓冲），不解码、不分配：
///  · 行边界 = LF；
///  · 字符数 = "非 UTF-8 续字节"的字节数（UTF-8 的每个字符恰好有 1 个非续字节）
///    —— 不解码也能得到**精确**字符数，非 ASCII 同样正确；
///  · 行尾 CR 归一：连续 CR 中只有**紧接 LF 的那一个**被丢掉，其余算内容
///    （与 `lines()` 剥一个尾部 CR 的行为一致）；
///  · 只有**落在返回窗口内**的行才被解码成 `String`（那才是模型真正要看的内容）。
///
/// 语义与改前**逐条对齐**（差分判据 `bounded_read_matches_the_full_file_reference` 守着）：
///  · 以 LF 分行，行尾 CR 归一；
///  · 结尾换行**不**多算一行；空文件 0 行；
///  · `dropped_lines` / `dropped_chars` 覆盖"offset 跳过"与"limit/max_chars 截断"两部分；
///  · 返回文本带 `N: ` 行号前缀（1-indexed）。
///
/// **一处有意的语义放宽**（记录在案）：改前只要文件里**任何**一行是非 UTF-8 就整次报错；
/// 改后只对**返回窗口内**的行做 UTF-8 校验（窗口外按字节数计字符）。理由：窗口外的内容
/// 模型根本看不到，为一个看不到的字节让整次读取失败，是"用稳定性换一个没人受益的严格"。
fn read_file_lines_impl(
    path: &str,
    offset: usize,
    limit: usize,
    max_chars: usize,
) -> Result<ReadFileLinesResult, String> {
    use std::fs::File;
    use std::io::{BufReader, Read};

    let file = File::open(path).map_err(|e| e.to_string())?;
    let mut reader = BufReader::with_capacity(64 * 1024, file);

    /// UTF-8 续字节（10xxxxxx）不计入字符数 —— 每个字符恰好一个非续字节
    #[inline]
    fn is_continuation(b: u8) -> bool {
        b & 0xC0 == 0x80
    }

    let mut parts: Vec<String> = Vec::new();
    let mut total_lines = 0usize;
    let mut has_more = false;
    let mut collected = 0usize;
    let mut total_chars = 0usize;
    let mut dropped_lines = 0usize;
    let mut dropped_chars = 0usize;

    // 当前行状态
    let mut line_buf: Vec<u8> = Vec::new();
    let mut line_chars = 0usize;
    let mut line_has_any = false;
    let mut pending_crs = 0usize; // 已见到、但还没决定算不算内容的 CR 个数
    let mut budget_exhausted = false;

    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = reader.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            if line_has_any {
                // 文件以 CR 结尾（没有 LF）⇒ 这些 CR 是内容
                line_chars += pending_crs;
                pending_crs = 0;
                total_lines += 1;
                settle_line(
                    &line_buf,
                    line_chars,
                    total_lines,
                    offset,
                    limit,
                    max_chars,
                    &mut budget_exhausted,
                    &mut parts,
                    &mut collected,
                    &mut total_chars,
                    &mut dropped_lines,
                    &mut dropped_chars,
                    &mut has_more,
                )?;
            }
            break;
        }
        for &b in &buf[..n] {
            if b == b'\n' {
                // 行尾 CR 归一：紧接 LF 的那个 CR 丢掉，之前的是内容
                if pending_crs > 0 {
                    line_chars += pending_crs - 1;
                    pending_crs = 0;
                }
                total_lines += 1;
                settle_line(
                    &line_buf,
                    line_chars,
                    total_lines,
                    offset,
                    limit,
                    max_chars,
                    &mut budget_exhausted,
                    &mut parts,
                    &mut collected,
                    &mut total_chars,
                    &mut dropped_lines,
                    &mut dropped_chars,
                    &mut has_more,
                )?;
                line_buf.clear();
                line_chars = 0;
                line_has_any = false;
                pending_crs = 0;
            } else if b == b'\r' {
                pending_crs += 1;
                line_has_any = true;
                if in_window(total_lines + 1, offset, collected, limit, budget_exhausted) {
                    line_buf.push(b);
                }
            } else {
                if pending_crs > 0 {
                    line_chars += pending_crs; // 这些 CR 后面不是 LF ⇒ 是内容
                    pending_crs = 0;
                }
                if !is_continuation(b) {
                    line_chars += 1;
                }
                line_has_any = true;
                if in_window(total_lines + 1, offset, collected, limit, budget_exhausted) {
                    line_buf.push(b);
                }
            }
        }
    }

    let text = parts.join("\n");
    Ok(ReadFileLinesResult {
        text,
        total_lines,
        has_more,
        dropped_lines,
        dropped_chars,
    })
}

/// 这一行会不会进返回窗口（只用来决定"要不要把字节存进 line_buf"）。
#[inline]
fn in_window(line_no: usize, offset: usize, collected: usize, limit: usize, exhausted: bool) -> bool {
    line_no >= offset && collected < limit && !exhausted
}

/// 结算一行：进返回窗口，或计入丢弃。
///
/// 判断顺序与改前**逐条一致**：先看 offset，再看 limit，最后看 max_chars 预算。
#[allow(clippy::too_many_arguments)]
fn settle_line(
    line_buf: &[u8],
    line_chars: usize,
    line_idx: usize,
    offset: usize,
    limit: usize,
    max_chars: usize,
    budget_exhausted: &mut bool,
    parts: &mut Vec<String>,
    collected: &mut usize,
    total_chars: &mut usize,
    dropped_lines: &mut usize,
    dropped_chars: &mut usize,
    has_more: &mut bool,
) -> Result<(), String> {
    if line_idx < offset {
        *dropped_lines += 1;
        *dropped_chars += line_chars;
        return Ok(());
    }
    if *collected >= limit || *budget_exhausted {
        *has_more = true;
        *dropped_lines += 1;
        *dropped_chars += line_chars;
        return Ok(());
    }
    // 行尾 CR 已在计数侧归一，但 line_buf 里还留着它 ⇒ 解码前剥掉（与 lines() 一致）
    let bytes = if line_buf.last() == Some(&b'\r') {
        &line_buf[..line_buf.len() - 1]
    } else {
        line_buf
    };
    let line = String::from_utf8(bytes.to_vec())
        .map_err(|e| format!("文件包含非 UTF-8 内容（第 {} 行）：{}", line_idx, e))?;
    let numbered = format!("{}: {}", line_idx, line);
    if *total_chars + numbered.len() > max_chars {
        *has_more = true;
        *dropped_lines += 1;
        *dropped_chars += line_chars;
        *budget_exhausted = true;
        return Ok(());
    }
    *total_chars += numbered.len() + 1;
    parts.push(numbered);
    *collected += 1;
    Ok(())
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
            //
            // ⚠️ 第 68 轮：错误文本里带上**稳定的机器可读前缀 `E_FILE_TOO_LARGE:`**。
            // 起因是真机取证：会话的权威 JSONL 日志涨到 600 MB 后，所有整读日志的路径
            // 都撞在这个上限上，而前端只能靠"错误文本里有没有 File is large"来判断
            // 该不该切到分窗读取 —— 文本判据太脆（改一个词就失效）。
            // 另外旧文本写的是"Use read tool with offset/limit parameters"，
            // 那是**给模型看的**措辞，出现在用户控制台里只会让人困惑（GUI 里没有"read tool"）。
            let metadata = tokio::fs::metadata(&p).await.map_err(|e| e.to_string())?;
            if metadata.len() > READ_FILE_FULL_MAX_BYTES {
                return Err(format!(
                    "E_FILE_TOO_LARGE: file is {} bytes (whole-file read limit {} bytes). \
Use the paginated reader (`read_file_lines`) or the windowed reader (`read_text_window`) instead.",
                    metadata.len(),
                    READ_FILE_FULL_MAX_BYTES
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

/// 写侧沙箱的**唯一判定**（`write_file` 的守卫，返回"拒绝原因"或 `None`=放行）。
///
/// ## ★ 误拒修复：为什么不许"给了 workspace 就拦"
///
/// 改前 `write_file` 是「`workspace` 给了就判、越界就抛」—— **不看设置**。而前端
/// （`src/core/file-api.ts:236`）**无条件**把 `workspace` 传下来（`sdk.write` / `write` 工具
/// 都传 `ctx.cwd`）⇒ **沙箱关闭（全访问）时，工作区外的写照样被 Rust 拒绝**。
/// 与 TS 侧 `assertWithinWorkspace` 改前那份"不看开关"的判定叠加，正是用户点名的
/// 「关了沙箱后沙箱还是生效，导致项目读写出问题」。
///
/// 现在：**「沙箱是否启用」由前端唯一一处判定**（`sandbox-acl.isSandboxAclEnabled()`）
/// 之后随调用传进来；Rust 只负责"给定工作区，目标在不在里面"
/// （`resolve_sandbox_path` + `path_within_workspace`，**一条规则一处实现**），不猜开关。
///
/// ## 缺省值的方向：`None` ⇒ 按"开着"处理（fail-closed）
///
/// 只有调用方**显式**说了 `sandbox_enabled: false` 才放行。理由：
/// · 前端与本命令**同仓库同版本**，`file-api.ts` 每次都显式传，实际不会有 `None`；
/// · 其它直接 `invoke("write_file", …)` 的调用点（`App.tsx` / `FileEditor.tsx` /
///   `file-change-tracker` / `maintenance` / `ProjectManager` …）都**不传 `workspace`**，
///   本来就不做判定（与 `assertWithinWorkspace` 的既有前置条件语义一致）；
/// · 于是 `None` 只会出现在"传了 workspace 却没说开关"的将来形态 —— 那种情况宁可保守拦下，
///   也不许把用户开着的沙箱静默关掉。
///
/// 判据：`src/test/sandbox-mode-consistency.test.ts`（TS 侧）+
/// `harden_185_tests::r8_write_guard_follows_the_sandbox_switch`（本文件）。
fn write_sandbox_violation(
    path: &str,
    workspace: Option<&str>,
    sandbox_enabled: Option<bool>,
) -> Result<Option<String>, String> {
    if !sandbox_enabled.unwrap_or(true) {
        return Ok(None);
    }
    let Some(ws) = workspace else {
        return Ok(None);
    };
    let ws_resolved = resolve_sandbox_path(std::path::Path::new(ws))
        .map_err(|e| format!("Sandbox: cannot resolve workspace '{}': {}", ws, e))?;
    let target_resolved = resolve_sandbox_path(std::path::Path::new(path))
        .map_err(|e| format!("Sandbox: cannot resolve target '{}': {}", path, e))?;
    if path_within_workspace(&target_resolved, &ws_resolved) {
        return Ok(None);
    }
    Ok(Some(format!(
        "Sandbox: Write to '{}' is outside the workspace '{}'. Set the workspace directory or disable sandbox mode in settings.",
        path, ws
    )))
}

#[tauri::command]
async fn write_file(
    path: String,
    content: String,
    encoding: Option<String>,
    workspace: Option<String>,
    // ★ 误拒修复：由前端那**唯一一处**开关判定（`sandbox-acl.isSandboxAclEnabled()`）传下来。
    // 缺省 ⇒ 按"开着"处理（见 `write_sandbox_violation` 的说明）。
    sandbox_enabled: Option<bool>,
) -> Result<(), String> {
    // S5: Sandbox path whitelist — 只在该**用户真的开着沙箱**时才限制写入范围。
    if let Some(err) = write_sandbox_violation(&path, workspace.as_deref(), sandbox_enabled)? {
        return Err(err);
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

/// 剥掉 Windows 的 **verbatim / 长路径前缀**：`\\?\C:\a` → `C:\a`，
/// `\\?\UNC\srv\share` → `\\srv\share`。
///
/// 为什么必须剥：`std::fs::canonicalize` 在 Windows 上**总是**返回带 `\\?\` 的形式，
/// 而调用方给的工作区路径是普通形式 ⇒ 不剥就会出现"同一个目录却被判成越界"的假失败
/// （这正是改前 `write_file` 里那类误报的来源之一）。
fn strip_verbatim_prefix(p: &std::path::Path) -> std::path::PathBuf {
    let s = p.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        return std::path::PathBuf::from(format!(r"\\{}", rest));
    }
    if let Some(rest) = s.strip_prefix(r"\\?\") {
        return std::path::PathBuf::from(rest);
    }
    p.to_path_buf()
}

/// 纯词法规范化：去掉 `.`、折叠 `..`（**不碰磁盘**，用于"路径还不存在"的兜底）。
fn lexical_normalize(p: &std::path::Path) -> std::path::PathBuf {
    use std::path::Component;
    let mut out = std::path::PathBuf::new();
    for c in p.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                // 已经退到根（或只有前缀）时 pop 会失败 ⇒ 保留 `..`，
                // 于是它**不可能**再匹配到工作区前缀（判定为越界，安全方向）。
                if !out.pop() {
                    out.push("..");
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// 把路径解析成**可用于包含判定**的规范绝对形式。
///
/// ## 为什么不是改前那个纯字符串 `canonicalize_path`
///
/// 改前只做"去点 + 拼反斜杠 + 大小写敏感前缀比较"，三个缺口都是实测出来的：
/// 1. **不解析链接/接合点** ⇒ 工作区里一个指向外部的 junction 就能让写穿出去；
/// 2. **不补分隔符边界** ⇒ `C:\mimo-gui-backup` 的字符串前缀恰好是 `C:\mimo-gui`（见
///    `path_within_workspace`）；
/// 3. **大小写敏感** ⇒ `c:\ws` 与 `C:\WS` 是同一个目录，却被判"越界"（假失败）。
///
/// ## 目标不存在是常态（`write_file` 写的常常是**新文件**）
///
/// 所以：存在 ⇒ 真 `canonicalize`；不存在 ⇒ 规范化**最近的已存在祖先**，
/// 再把剩余分量（含 `..` 的词法折叠）拼回去。两条路得到的形式都剥掉 `\\?\`，
/// 保证与调用方给的普通路径可以直接比较。
fn resolve_sandbox_path(path: &std::path::Path) -> Result<std::path::PathBuf, String> {
    if let Ok(canonical) = std::fs::canonicalize(path) {
        return Ok(strip_verbatim_prefix(&canonical));
    }
    // 逐级向上找"最近的已存在祖先"
    let mut missing: Vec<std::ffi::OsString> = Vec::new();
    let mut cur = path.to_path_buf();
    loop {
        let Some(parent) = cur.parent() else { break };
        if let Some(name) = cur.file_name() {
            missing.push(name.to_os_string());
        }
        if let Ok(canonical) = std::fs::canonicalize(parent) {
            let mut base = strip_verbatim_prefix(&canonical);
            for seg in missing.iter().rev() {
                base.push(seg);
            }
            return Ok(lexical_normalize(&base));
        }
        // 走到根了（parent 没有更上一级）⇒ 无法再解析
        if parent.parent().is_none() {
            break;
        }
        cur = parent.to_path_buf();
    }
    // 整条路径都不存在（含相对路径）：退化为词法规范化（结果仍是相对路径 ⇒ 与
    // 绝对工作区比较时**必然**判越界，这是安全方向，不是静默放行）。
    Ok(lexical_normalize(path))
}

/// 单个路径分量的比较键：**Windows 语义 = 大小写不敏感**（`C:\WS` 与 `c:\ws` 同目录）；
/// 其它平台保持大小写敏感（在 Linux 上把 `/tmp/WS` 判成 `/tmp/ws` 之内是**放行**错误）。
fn component_fold(s: &str) -> String {
    if cfg!(target_os = "windows") {
        s.to_lowercase()
    } else {
        s.to_string()
    }
}

/// 包含判定：`target` 是否在 `workspace` **之内**。
///
/// ## 本仓库最忌讳的"同一规则两份实现"就在这里被合并
///
/// 改前有三份实现：`write_file`（字符串前缀）、`check_path_in_workspace`（真 canonicalize，
/// 但大小写敏感 + 不处理不存在）、`list_directory_sandboxed`（又一份 canonicalize）。
/// 现在三处都走 `resolve_sandbox_path` + 本函数。
///
/// ## 为什么"按组件"而不是"按字符串前缀"
///
/// `C:\mimo-gui-backup\x.txt` 的字符串前缀**就是** `C:\mimo-gui` ⇒ 字符串比较会放行
/// 一次**越界写**。逐组件比较（`C:\mimo-gui-backup` ≠ `C:\mimo-gui`）才能挡住它。
fn path_within_workspace(target: &std::path::Path, workspace: &std::path::Path) -> bool {
    let t: Vec<String> = target
        .components()
        .map(|c| component_fold(&c.as_os_str().to_string_lossy()))
        .collect();
    let w: Vec<String> = workspace
        .components()
        .map(|c| component_fold(&c.as_os_str().to_string_lossy()))
        .collect();
    if w.is_empty() || t.len() < w.len() {
        return false;
    }
    t[..w.len()] == w[..]
}

/// `append_file` 的实现体（与命令分开：纯函数才能被单测直接喂临时文件）。
///
/// ## 第 94 波治本：追加前必须保证文件**以换行结尾**（否则会永久删掉一条合法记录）
///
/// 原来直接 `OpenOptions::append(true)` + `writeln!`，**从不检查文件是不是以换行结尾**。
/// 崩溃/断电留下的**半截尾行**于是会把**下一条记录**粘在同一行上：
///
/// ```text
/// {"id":"m1",...}          ← 完整行
/// {"id":"m2","conte        ← 崩在写入中途留下的半截行（没有换行）
/// {"id":"m3",...}          ← 下一条记录被粘上来 ⇒ 整行 JSON.parse 失败
/// ```
///
/// 而读侧（`session-jsonl.ts` 的 `readSessionMessages`）与压缩（`compactSessionLog`）
/// 把**解析不了的行直接丢掉**；压缩那道"安全闸门"只比行数（`linesAfter < linesBefore`）
/// ⇒ **看不见「一行坏行里裹着一条合法记录」** ⇒ 那条合法记录被**永久删除**（真实数据丢失）。
///
/// 所以追加前先看最后一个字节：不是 `\n` 就先补一个。这不是"把半截行修好"
/// （残尾本来就该当坏行丢掉），而是**不让它把下一条记录也拖下水**。
///
/// 顺带补上 `sync_all()`：同文件的 `write_file`（`:732`）一直有，`append_file` 没有 ——
/// 于是"已经返回成功"的那条记录可能还留在页缓存里，崩溃后根本没落盘。
fn append_file_impl(path: &std::path::Path, content: &str) -> Result<(), String> {
    use std::io::{Read, Seek, SeekFrom, Write};
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
    }
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        // 需要读一个字节来判断尾字节，所以 read 也要开（Windows 下 Rust 会据此申请 GENERIC_READ）
        .read(true)
        .append(true)
        .open(path)
        .map_err(|e| e.to_string())?;
    let len = file.metadata().map_err(|e| e.to_string())?.len();
    if len > 0 {
        file.seek(SeekFrom::End(-1)).map_err(|e| e.to_string())?;
        let mut last = [0u8; 1];
        file.read_exact(&mut last).map_err(|e| e.to_string())?;
        // 追加模式下的写**永远落在文件末尾**，所以补的这个换行正好接在残尾后面
        if last[0] != b'\n' {
            file.write_all(b"\n").map_err(|e| e.to_string())?;
        }
    }
    writeln!(file, "{}", content).map_err(|e| e.to_string())?;
    // 写成功不等于落盘：没有这一步，"已返回成功"的记录可能在崩溃后消失
    file.sync_all().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn append_file(path: String, content: String) -> Result<(), String> {
    append_file_impl(std::path::Path::new(&path), &content)
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

/// `glob_search` 的遍历上限（**深度与条数两个上限都必须有**，理由见下）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct GlobLimits {
    max_depth: usize,
    max_results: usize,
    /// 跳过**前 N 条**匹配（`0` = 从第一条开始）。
    ///
    /// 为什么翻页要落在遍历里而不是"先取全部再切片"：先取全部就等于**取消了条数上限**
    /// （超大目录正是这个工具的用例），翻页的意义也就没了。
    offset: usize,
}

impl Default for GlobLimits {
    fn default() -> Self {
        Self {
            max_depth: GLOB_MAX_DEPTH,
            max_results: GLOB_MAX_RESULTS,
            offset: 0,
        }
    }
}

/// 递归深度上限。
///
/// ## 为什么是 32
///
/// 1. **栈安全的最后一道防线**：递归是"每层一个栈帧"的，没有上限时一个环就能把
///    8 MB 主线程栈啃穿 ⇒ 栈溢出 = 整个应用被 abort（用户看到"应用突然没了"）。
///    32 层 × 每帧几百字节 ≈ 十几 KB，怎么都不可能溢出；
/// 2. **真实项目不会更深**：Windows 的 `MAX_PATH` 是 260 字符，平均每层 8 个字符
///    也就 32 层；再深的目录几乎都是构建产物/包缓存（`node_modules`、`.git` 内部），
///    这个工具是"找文件"不是"全盘遍历"。
const GLOB_MAX_DEPTH: usize = 32;

/// 默认结果条数上限（调用方不给 `limit` 时用它）。
///
/// ## 这一条是"窗口"，不是"拦人的墙"（第 186 波改正的设计错误）
///
/// 改前超限就 `Err`（`glob_truncated_message`）：**那只是换个方式卡住** —— 调用方既拿不到
/// 数据，也拿不到"怎么拿到剩下的"，而"匹配到两万条以上"在批处理超大目录时**很常见**
/// （用户原话：*"如果真的超过 2 万条，怎么处理呢？仅仅返回错误，并没有解决问题。"*）。
/// 更糟的是"匹配数超限"与"参数写错"被压成同一种输出（都是 `Err(String)`）。
///
/// 现在：**截断是「数据」，不是「异常」**。撞到窗口 ⇒ 回一个有界列表 +
/// `truncated: true`（**至少还有更多**）+ `hint`（下一步怎么取），见 `GlobSearchResult`。
const GLOB_MAX_RESULTS: usize = 20_000;

/// `limit` 的允许区间。
///
/// 越界**不报错、也不静默**：夹进区间，并在 `hint` 里如实写明"请求了多少、实际按多少跑"
/// —— 静默夹与静默截断是同一类失真（调用方会以为自己真拿到了 `limit` 条）。
///
/// 为什么上限是 20 万而不是无穷：一次调用要把结果**序列化过 IPC**（一条路径平均几十字符
/// ⇒ 20 万条就是十几 MB 的字符串），再往上只是把"卡住"从遍历挪到传输。要更多就翻页
/// （`offset`）—— 翻页是**有界的增量**，"一次要一亿条"不是。
const GLOB_LIMIT_MIN: usize = 1;
const GLOB_LIMIT_MAX: usize = 200_000;

/// 一次遍历的结果 + **它是否完整**这两个事实（必须一起返回，不许只回列表）。
struct GlobWalkOutcome {
    files: Vec<String>,
    /// 本次遍历**见过**的匹配总数（含被 `offset` 跳过的那一段）—— 下一页的偏移量就是它。
    matched: usize,
    /// 撞到结果窗口 ⇒ 列表**不完整**。
    ///
    /// ⚠️ `true` 的含义是"**至少还有更多**"，**不是**"恰好还差 N 条"：
    /// 为了报一个精确总数把整棵树走完，正是这个契约要避免的代价（本仓纪律：
    /// 宁可说得少，也不许编数字）。
    truncated: bool,
    /// 撞到深度上限 ⇒ 更深的目录**没被看过**（列表可能不完整）。
    depth_limited: bool,
}

/// 调用方**请求**的 `limit` 与**真正执行**的 `limit`，外加"夹过没有"这个事实。
struct GlobLimitRequest {
    effective: usize,
    /// `Some((请求值, 实际值))` —— 只有真的夹过才有值（静默夹是不许的）。
    clamped_from: Option<(usize, usize)>,
}

impl GlobLimitRequest {
    fn resolve(requested: Option<usize>) -> Self {
        let requested = requested.unwrap_or(GLOB_MAX_RESULTS);
        let effective = requested.clamp(GLOB_LIMIT_MIN, GLOB_LIMIT_MAX);
        Self {
            effective,
            clamped_from: (requested != effective).then_some((requested, effective)),
        }
    }
}

/// `glob_search` 的**结构化返回**（第 186 波）。
///
/// 为什么不是 `Vec<String>`：截断/深度受限这两个事实**必须能和列表一起回来**。
/// 塞进数组当哨兵元素（`["...", "<truncated>"]`）或者用错误通道（改前的做法）
/// 都试过了 —— 前者污染数据，后者把"结果很大"说成"调用出错"。
#[derive(Debug, Clone, serde::Serialize)]
struct GlobSearchResult {
    /// 本页的路径（`offset` 之后、最多 `limit` 条）
    files: Vec<String>,
    /// **至少还有更多**（见 `GlobWalkOutcome::truncated`）
    truncated: bool,
    /// 有目录深于 `GLOB_MAX_DEPTH` 层 ⇒ 那部分**没被遍历**
    depth_limited: bool,
    /// `files.len()`（冗余但显式：调用方不必再取长度，也让形状自解释）
    returned: usize,
    /// 给调用方的**可执行**下一步（夹过 limit / 还有更多 / 有目录没走）。
    /// 没有任何要说的**事实**时是 `None` —— 不写空洞的警告。
    hint: Option<String>,
}

/// 组装 `hint`：只写**真的发生了**的事实，且每条都带"下一步怎么做"。
fn glob_hint(
    clamped_from: Option<(usize, usize)>,
    truncated: bool,
    depth_limited: bool,
    offset: usize,
    returned: usize,
) -> Option<String> {
    let mut parts: Vec<String> = Vec::new();
    if let Some((requested, effective)) = clamped_from {
        parts.push(format!(
            "requested limit {requested} is outside [{GLOB_LIMIT_MIN}, {GLOB_LIMIT_MAX}] so it was clamped to {effective} (said out loud on purpose: a silent clamp would look like you got {requested})"
        ));
    }
    if truncated {
        parts.push(format!(
            "at least one more match exists beyond this page of {returned} (offset={offset}): call again with offset={} to keep enumerating, or narrow path/pattern, or raise limit (max {GLOB_LIMIT_MAX})",
            offset.saturating_add(returned)
        ));
    }
    if depth_limited {
        parts.push(format!(
            "directories deeper than {GLOB_MAX_DEPTH} levels were NOT walked: search a shallower path for those"
        ));
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("; "))
    }
}

/// 把一次遍历的结果拼成**对外契约**（`limit` 请求事实 + `offset` 一起进来，才能说出真相）。
fn glob_result_from(
    outcome: GlobWalkOutcome,
    limit_req: &GlobLimitRequest,
    offset: usize,
) -> GlobSearchResult {
    let returned = outcome.files.len();
    GlobSearchResult {
        files: outcome.files,
        truncated: outcome.truncated,
        depth_limited: outcome.depth_limited,
        returned,
        hint: glob_hint(
            limit_req.clamped_from,
            outcome.truncated,
            outcome.depth_limited,
            offset,
            returned,
        ),
    }
}

fn glob_search_walk(
    root: &std::path::Path,
    pattern: &str,
    limits: GlobLimits,
) -> Result<GlobWalkOutcome, String> {
    let mut outcome = GlobWalkOutcome {
        files: Vec::new(),
        matched: 0,
        truncated: false,
        depth_limited: false,
    };
    glob_search_recursive(root, pattern, limits, 0, &mut outcome)?;
    Ok(outcome)
}

/// `glob_search` 的**可测核心**（同步）。
///
/// 命令层只负责把这一坨挪进 blocking 线程，所以判据（`GLOB-LIMIT-1..4`）能直接驱动
/// **真正的入口语义**（含 `limit` 夹取、`offset` 翻页、`hint`），而不必起一个 tauri 运行时。
fn run_glob_search(
    pattern: &str,
    raw_path: &str,
    search_path: &std::path::Path,
    limit: Option<usize>,
    offset: Option<usize>,
) -> Result<GlobSearchResult, String> {
    if !search_path.exists() {
        return Err(format!("Path does not exist: {raw_path}"));
    }
    let limit_req = GlobLimitRequest::resolve(limit);
    let offset = offset.unwrap_or(0);
    let outcome = glob_search_walk(
        search_path,
        pattern,
        GlobLimits {
            max_depth: GLOB_MAX_DEPTH,
            max_results: limit_req.effective,
            offset,
        },
    )?;

    if outcome.truncated {
        // 截断**不是错误**，但"结果不全"这件事必须留痕（改前这里是"返回 Err"）。
        runtime_log::append_line(
            "WARN",
            &format!(
                "glob_search truncated pattern={} path={} limit={} offset={} (回有界窗口 + truncated=true；调用方能继续翻页，不是报错)",
                pattern, raw_path, limit_req.effective, offset
            ),
        );
    }
    if outcome.depth_limited {
        // 深度上限不是错误（大多数搜索根本到不了），但"可能漏了更深的目录"这件事要留痕。
        runtime_log::append_line(
            "WARN",
            &format!(
                "glob_search hit max depth={} pattern={} path={} (更深的目录未遍历)",
                GLOB_MAX_DEPTH, pattern, raw_path
            ),
        );
    }
    eprintln!(
        "[glob_search] returned {} files (truncated={}, depth_limited={})",
        outcome.files.len(),
        outcome.truncated,
        outcome.depth_limited
    );
    Ok(glob_result_from(outcome, &limit_req, offset))
}

#[tauri::command]
async fn glob_search(
    pattern: String,
    path: String,
    limit: Option<usize>,
    offset: Option<usize>,
) -> Result<GlobSearchResult, String> {
    let search_path = std::path::PathBuf::from(&path);
    eprintln!(
        "[glob_search] pattern: {}, path: {}, exists: {}, limit: {:?}, offset: {:?}",
        pattern,
        path,
        search_path.exists(),
        limit,
        offset
    );

    /*
     * ★ 第 185 波：**走盘放进 `spawn_blocking`** ✓（保留，与条数设计无关）。
     *
     * 改前这个 `async fn` 里直接同步 `read_dir` 递归：tokio 的 worker 线程被占死，
     * 期间该 worker 上的其它命令（心跳、日志、读写文件…）全都排队；而前端 30 s 的
     * `Promise.race` 只是**丢掉 Promise**、Rust 侧还在跑 ✓ ⇒ 用户看到"超时了"，
     * 进程继续吃 CPU，直到栈溢出把应用 abort ✗。
     * 磁盘遍历是**阻塞 I/O**，本来就属于 blocking pool（与 `js_sandbox_*` 同一写法）。
     */
    let pattern_for_task = pattern.clone();
    let path_for_task = path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        run_glob_search(
            &pattern_for_task,
            &path_for_task,
            &search_path,
            limit,
            offset,
        )
    })
    .await
    .map_err(|e| format!("glob_search 遍历线程失败：{e}"))?
}

/// 递归遍历。
///
/// ## 为什么不会无限递归（两道**互相独立**的闸门）
///
/// 1. **跳过重解析点**：`entry.file_type()` 拿的是目录项自带的信息（**不跟随**链接），
///    `is_symlink()` 在 Windows 上同时覆盖符号链接与**接合点（junction / mount point）**。
///    本机取证：`%LOCALAPPDATA%\Application Data` 是个指向 `%LOCALAPPDATA%` 自己的
///    自指接合点，名字不以 `.` 开头（原来的过滤挡不住）、`path.is_dir()` 会跟随它
///    ⇒ 无限递归。跳过重解析点之后，剩下的就是一棵**普通目录树（天生无环）**，
///    所以这里**不需要** visited 集合（同 inode 反复到达只可能来自链接）。
/// 2. **深度上限**：万一将来有别的成环途径（新平台语义、奇怪的卷），深度上限把
///    栈用量钉死在几十 KB 量级 —— 栈溢出会 abort 整个应用，这个代价不能赌。
fn glob_search_recursive(
    dir: &std::path::Path,
    pattern: &str,
    limits: GlobLimits,
    depth: usize,
    outcome: &mut GlobWalkOutcome,
) -> Result<(), String> {
    if depth >= limits.max_depth {
        outcome.depth_limited = true;
        return Ok(());
    }
    let entries = std::fs::read_dir(dir).map_err(|e| e.to_string())?;

    for entry in entries {
        if outcome.truncated {
            // 窗口满了就停：继续走完整棵树只是白烧 I/O（调用方拿到 `truncated: true` +
            // `hint`，用 `offset` 翻页就能取到剩下的）。
            return Ok(());
        }
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();

        // Skip hidden files and directories
        if name.starts_with('.') {
            continue;
        }

        // `entry.file_type()` **不跟随**重解析点（`path.is_dir()` 会跟随 ⇒ 自指接合点无限递归）
        let file_type = entry.file_type().map_err(|e| e.to_string())?;
        if file_type.is_symlink() {
            continue;
        }
        let is_dir = file_type.is_dir();

        // Check if file matches pattern
        if !is_dir {
            let matches = pattern == "*" || name_matches_glob(&name, pattern);
            if matches {
                /**
                 * 结果窗口 = `[offset, offset + max_results)`（第 186 波）。
                 *
                 * 注意这里**不是** `outcome.files.len() >= max_results`：翻页时前 `offset` 条
                 * 是"见过但不回"，所以窗口的右端要按**见过的总数**算。
                 * `saturating_add`：`offset` 由调用方给，溢出不该 panic。
                 */
                let window_end = limits.offset.saturating_add(limits.max_results);
                if outcome.matched >= window_end {
                    // 已经取满窗口、又真的撞见下一条 ⇒ **至少还有更多**（不是估的，是看见的）
                    outcome.truncated = true;
                    return Ok(());
                }
                outcome.matched += 1;
                if outcome.matched > limits.offset {
                    eprintln!("[glob_search] MATCH: {} against pattern: {}", name, pattern);
                    outcome.files.push(path.to_string_lossy().to_string());
                }
            }
        }

        // Recurse into directories
        if is_dir {
            glob_search_recursive(&path, pattern, limits, depth + 1, outcome)?;
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

/// 退出时收掉**所有** MCP stdio 子进程（第 181 波，对标 Pi `8c911797c`）。
///
/// ## 为什么必须是「进程树」而不是 `Child::kill`
///
/// 用户的 MCP 服务器绝大多数是一个**启动器**（`npx` / `cmd.exe /c codegraph.cmd`），
/// 真正干活的是它的子进程。`Child::kill` 只杀直接子进程 ⇒ 启动器死了、服务本体还在，
/// 表现正是"退出 Codem 之后还有个 node 进程赖着"。这里复用 `kill_process_tree`
/// （Windows `taskkill /T /F`，Unix 杀进程组），把整棵树收掉。
///
/// ## 为什么必须**显式**做
///
/// `mcp_stdio_connect` 里已经设了 `kill_on_drop(true)`，但那只覆盖"AppState 被丢弃"
/// 这一条路径；退出事件是唯一能确定自己还活着、还能拿到 pid 的时刻，所以在这里收最可靠。
/// 退出时收 MCP 进程表的**结果**。
///
/// ## 为什么要有这个枚举（第 185 波）
///
/// 改前是 `Err(_) => return` —— 抢不到锁就**一行日志都不留**地放弃，调用方（退出事件）
/// 也无从知道"整棵 MCP 进程树没被回收"：用户看到的就是"退出后任务管理器里还有 node"，
/// 而日志里什么都没有（这正是"静默降级"里最坏的一种：**谎报收干净**）。
/// 现在把三种结局分开：收掉了 / 本来就没有 / **一个都没收到**。
#[derive(Debug, Clone, PartialEq, Eq)]
enum McpShutdownOutcome {
    /// 进程表本来就是空的（没什么可收的）
    NothingToDo,
    /// 收到了 n 棵进程树
    Reaped(usize),
    /// **抢不到锁 ⇒ 一棵都没收到**（调用方必须如实记 WARN，不许说"收干净了"）
    LockBusy,
}

/// 退出路径抢 `mcp_processes` 锁的重试预算：最多 8 次 × 50 ms ≈ 400 ms。
///
/// 为什么可以这么短：R2 的另一个修复让**请求路径不再跨 await 持锁**，
/// 所以锁的占用时间只剩"插表/取表"这种微秒级操作 ⇒ 竞争窗口极小，
/// 重试几乎总是第一次就成功。剩下的 400 ms 是"真的有人在持锁"时的兜底，
/// 此时如实记 WARN 比无限等待（用户点了退出却没反应）更诚实。
const MCP_SHUTDOWN_LOCK_ATTEMPTS: u32 = 8;
const MCP_SHUTDOWN_LOCK_GAP: std::time::Duration = std::time::Duration::from_millis(50);

/// 抢锁取句柄：抢不到就重试（最多 `attempts` 次、每次间隔 `gap`），
/// 仍然抢不到 ⇒ 返回 `None` —— 调用方**必须**把这件事说出来（见 `mcp_shutdown_log_line`）。
fn drain_mcp_handles_with<F>(
    attempts: u32,
    gap: std::time::Duration,
    mut try_take: F,
) -> Option<Vec<(String, Option<u32>)>>
where
    F: FnMut() -> Option<Vec<(String, Option<u32>)>>,
{
    for attempt in 0..attempts {
        if let Some(handles) = try_take() {
            return Some(handles);
        }
        if attempt + 1 < attempts {
            std::thread::sleep(gap);
        }
    }
    None
}

/// "抢不到锁"的日志文案：**如实说没收到**，并且明确否掉"已收干净"的读法。
fn mcp_shutdown_lock_busy_warn() -> String {
    format!(
        "mcp shutdown: mcp_processes 锁被占用（{} 次重试后仍抢不到）⇒ **没能回收任何 MCP 进程**；\
         这些进程树（npx / cmd.exe 派生的 node 服务）可能残留在系统里。\
         这是「没收到」，不是「已收干净」。",
        MCP_SHUTDOWN_LOCK_ATTEMPTS
    )
}

/// 把收 MCP 进程的结局变成**一条必须落盘的日志**（`None` = 确实没什么可记）。
///
/// 抽成纯函数是为了能被判据直接钉住："抢不到锁"这条路径**必须**有 WARN，
/// 而不是像改前那样静默 `return`。
fn mcp_shutdown_log_line(outcome: &McpShutdownOutcome) -> Option<(&'static str, String)> {
    match outcome {
        McpShutdownOutcome::NothingToDo => None,
        McpShutdownOutcome::LockBusy => Some(("WARN", mcp_shutdown_lock_busy_warn())),
        McpShutdownOutcome::Reaped(n) => Some((
            "INFO",
            format!("mcp shutdown: 已回收 {n} 棵 MCP 进程树（全部）"),
        )),
    }
}

fn kill_all_mcp_processes(state: &AppState) -> McpShutdownOutcome {
    let handles = drain_mcp_handles_with(MCP_SHUTDOWN_LOCK_ATTEMPTS, MCP_SHUTDOWN_LOCK_GAP, || {
        match state.mcp_processes.try_lock() {
            Ok(mut map) => Some(
                map.drain()
                    .map(|(name, handle)| (name, handle._child.id()))
                    .collect(),
            ),
            Err(_) => None,
        }
    });

    let Some(handles) = handles else {
        let outcome = McpShutdownOutcome::LockBusy;
        // ★ 不许静默放弃：日志如实说明"没收到所有进程"。
        if let Some((level, line)) = mcp_shutdown_log_line(&outcome) {
            runtime_log::append_line(level, &line);
        }
        return outcome;
    };

    if handles.is_empty() {
        return McpShutdownOutcome::NothingToDo;
    }
    let reaped = handles.len();
    for (name, pid) in handles {
        match kill_process_tree(pid) {
            Ok(()) => runtime_log::append_line(
                "INFO",
                &format!("mcp shutdown: killed process tree name={name} pid={pid:?}"),
            ),
            Err(e) => runtime_log::append_line(
                "WARN",
                &format!("mcp shutdown: kill failed name={name} pid={pid:?} err={e}"),
            ),
        }
    }
    McpShutdownOutcome::Reaped(reaped)
}

/// `execute_command` 的**读取期**上限（字节）。
///
/// 这两个数与"调用方看到的截断阈值"是**同一个数**（改前它们在 join 之后才生效）：
/// 收满就不再多留一个字节 ⇒ 内存峰值被钉死在 60 KB 量级（改前是"命令输出的全量"）。
const EXEC_STDOUT_CAP: usize = 50_000;
const EXEC_STDERR_CAP: usize = 10_000;

/// 有界读取：最多把 `cap` 字节收进返回的 `Vec`，**其余读掉但不留**。
///
/// 为什么"读掉但不留"而不是"直接不读"：不读的话子进程会把管道写满并**阻塞在 write**
/// 上，那条命令就永远不结束了（看起来像挂死）。丢弃才是既不涨内存又不堵子进程的做法。
///
/// 返回 `(留下的字节, 真实读到的总字节数)` —— 总字节数是给调用方**如实标注"截断了"**用的
/// （只说"截断了"而不给总量，用户无法判断丢了多少）。
///
/// `abandon`：由等待方（超时路径）置位 ⇒ 读线程立刻停手并**丢掉管道句柄**，
/// 不再"继续读进没人看的 Vec"。
fn read_stream_bounded<R: std::io::Read>(
    reader: &mut R,
    cap: usize,
    abandon: &std::sync::atomic::AtomicBool,
) -> (Vec<u8>, u64) {
    let mut kept: Vec<u8> = Vec::with_capacity(cap.min(8192));
    let mut total: u64 = 0;
    let mut buf = [0u8; 8192];
    loop {
        if abandon.load(std::sync::atomic::Ordering::Relaxed) {
            break;
        }
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                total += n as u64;
                let room = cap.saturating_sub(kept.len());
                if room > 0 {
                    kept.extend_from_slice(&buf[..n.min(room)]);
                }
                // 超过 cap 的部分：读到了、数过了、丢掉（内存有界）
            }
            Err(_) => break,
        }
    }
    (kept, total)
}

/// 把（有界读到的）字节渲染成给调用方的字符串；**被截断时如实标注丢了什么**。
///
/// `total > bytes.len()` 就是"截断"的定义 —— 不靠猜、不靠阈值重算。
fn render_stream_bounded(bytes: &[u8], total: u64, label: &str) -> String {
    let text = String::from_utf8_lossy(bytes).to_string();
    if total <= bytes.len() as u64 {
        text
    } else {
        format!(
            "{}...({} truncated: kept {} of {} bytes total)",
            text,
            label,
            bytes.len(),
            total
        )
    }
}

/// 有界 `join`：最多等 `limit`，到点仍没结束就返回 `None`（**交给调用方如实记账**，
/// 不许假装它已经结束）。
fn join_thread_within<T>(
    handle: std::thread::JoinHandle<T>,
    limit: std::time::Duration,
) -> Option<T> {
    let deadline = std::time::Instant::now() + limit;
    loop {
        if handle.is_finished() {
            return handle.join().ok();
        }
        if std::time::Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
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
    /**
     * ★ 第 46 波：**`-NoProfile -NonInteractive`** ✓（判据 `SH-1..3` ✓）。
     *
     * 原来这一行只有 `-Command` ✗ ⇒ 每个工具命令都会**加载用户 profile** ✓，两条真风险：
     * 1. ★ **污染工具输出**：profile 里只要有一句 `Write-Host`（欢迎语 / 代理 / conda 初始化… ✓），
     *    每个工具结果都会多出那段文字 ✗ ⇒ 模型读到的是"命令输出 + 噪声"✗；
     * 2. ★ **可能挂住**：profile 或命令本身有交互提示时，没有 `-NonInteractive` 会卡到超时 ✗。
     *
     * ⚠️ 速度只是**顺带**的 ✓：本机实测 271 ms/次 ⇒ 224 ms/次（差 **48 ms/次** ✓，
     * ≈12 s/批 ⇒ **不是**主要收益 ✓，别把它当性能修复 ✗）。
     */
    cmd.arg("-NoProfile").arg("-NonInteractive").arg("-Command").arg(&full_command).current_dir(&work_dir);
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

    // ===== 输出读取（★ 第 185 波：**读取阶段就有上限**）=====
    //
    // 改前 reader 线程 `read_to_end` 把 stdout/stderr **全量**读进 `Vec<u8>`，
    // 50 KB / 10 KB 的截断发生在 `join()` **之后** ⇒ 内存峰值 = 该命令输出的全量
    // （`type` 一个 GB 级日志就是 GB 级占用），而模型看到的仍然只有 50 KB。
    // 现在：收满 `EXEC_STDOUT_CAP` / `EXEC_STDERR_CAP` 就**只读不留**（读掉是为了不让
    // 子进程把管道写满卡死），同时把**真实总字节数**带出来 ⇒ 截断能如实标注。
    let (stdout, stderr, stdout_total, stderr_total, status) = {
        let child = &mut child;
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let abandon = Arc::new(std::sync::atomic::AtomicBool::new(false));

        // 两个流各一个线程：改前是**同一个线程**先读完 stdout 再读 stderr ——
        // 子进程把 stderr 管道写满就会阻塞在写，而这边还在等 stdout 的 EOF ⇒ 双向死等。
        let ab = abandon.clone();
        let reader_out = std::thread::spawn(move || {
            let mut so = stdout;
            match so.as_mut() {
                Some(so) => read_stream_bounded(so, EXEC_STDOUT_CAP, &ab),
                None => (Vec::new(), 0),
            }
        });
        let ab = abandon.clone();
        let reader_err = std::thread::spawn(move || {
            let mut se = stderr;
            match se.as_mut() {
                Some(se) => read_stream_bounded(se, EXEC_STDERR_CAP, &ab),
                None => (Vec::new(), 0),
            }
        });

        // Wait with timeout
        let start = std::time::Instant::now();
        let mut timed_out = false;
        let status = loop {
            if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
                break Some(status);
            }
            if start.elapsed().as_millis() >= effective_timeout as u128 {
                timed_out = true;
                break None;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        };

        if timed_out {
            // Timeout — kill the process tree
            let _ = kill_process_tree(Some(child_pid));
            // Give it a moment to die, then reap
            let _ = child.wait();
            /*
             * ★ **超时路径不许留下"继续读进无人消费的 Vec"的线程** ✓。
             *
             * 两步：① 置 `abandon` ⇒ 读线程下一轮循环就退出并**丢掉管道句柄**
             * （子进程再写会拿到 broken pipe，不再有人替它清管道）；
             * ② 有界 `join`（最多 2 s）—— 汇合不上时**如实记 WARN**：
             * 那个线程最多持有 cap 字节（内存有界），但我们不会假装它已经结束 ✗。
             */
            abandon.store(true, std::sync::atomic::Ordering::Relaxed);
            let out_done = join_thread_within(reader_out, std::time::Duration::from_secs(2));
            let err_done = join_thread_within(reader_err, std::time::Duration::from_secs(2));
            if out_done.is_none() || err_done.is_none() {
                runtime_log::append_line(
                    "WARN",
                    &format!(
                        "exec timeout pid={} 后读线程未在 2s 内退出 stdout_done={} stderr_done={}（缓冲有上限，最多 {} + {} 字节）",
                        child_pid,
                        out_done.is_some(),
                        err_done.is_some(),
                        EXEC_STDOUT_CAP,
                        EXEC_STDERR_CAP
                    ),
                );
            }
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

        let status = status.expect("非超时分支必有退出状态");
        let (out, out_total) = reader_out.join().unwrap_or((Vec::new(), 0));
        let (err, err_total) = reader_err.join().unwrap_or((Vec::new(), 0));
        (out, err, out_total, err_total, status)
    };

    let stdout = render_stream_bounded(&stdout, stdout_total, "stdout");
    let stderr = render_stream_bounded(&stderr, stderr_total, "stderr");

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

/// 文件**版本令牌**（第 95 波，`fs-observation-policy` 的 CAS 依据）。
///
/// 返回 `"<size>:<mtime_nanos>"`；文件不存在返回 `None`（**"不存在"也是一种观察结果**，
/// 与"没观察过"必须分开 —— 写入策略 `createIfAbsent` 正是靠这个区分）。
///
/// ## 为什么是元数据而不是内容哈希
///
/// `read` 工具走的是**分窗流式读取**（大文件整份不进内存），它手里从来没有"整份内容"，
/// 所以拿不到一个完整内容哈希去当版本。而 `size + mtime` 只要一次 `stat`：
///
/// - 任何**改写**都会改 mtime（同长度改写也算）⇒ 能挡住"你读完之后文件被改过"这一类；
/// - 与 `read` 的窗口大小、是否分页**无关**，所以"只读了一段"也能建立版本。
///
/// ⚠️ **已知边界（写清，别当成等于内容 CAS）**：刻意把内容改成另一份、再把 mtime 改回去
/// （`touch -d`）的组合骗得过它。要连这个也挡住，得在 `write_file` 里做**内容哈希 CAS**
/// 并把校验放进"临时文件 → rename"那一步（那样连 TOCTOU 窗口一起关掉）—— 见交接单 §3.5 的后续项。
fn file_version_impl(path: &std::path::Path) -> Result<Option<String>, String> {
    match std::fs::metadata(path) {
        Ok(meta) => {
            let mtime = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            Ok(Some(format!("{}:{}", meta.len(), mtime)))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
async fn file_version(path: String) -> Result<Option<String>, String> {
    file_version_impl(std::path::Path::new(&path))
}

// ========== MCP Stdio Commands ==========

// ========== P1-5: Sandbox Commands ==========
/// Check if a path is within the allowed workspace directory.
/// This is the Rust-side enforcement that complements the JS-side check.
#[tauri::command]
async fn check_path_in_workspace(path: String, workspace: String) -> Result<bool, String> {
    // ★ 第 185 波：与 `write_file` 的守卫**共用同一份实现**（改前这里是第二份实现：
    // 自己 `canonicalize`、自己 `starts_with`，于是"同一规则两份行为" —— 正是本仓库
    // 最忌讳的东西：一处修了另一处不修）。
    let abs_path = resolve_sandbox_path(std::path::Path::new(&path))
        .map_err(|e| format!("Cannot resolve path {}: {}", path, e))?;
    let abs_workspace = resolve_sandbox_path(std::path::Path::new(&workspace))
        .map_err(|e| format!("Cannot resolve workspace {}: {}", workspace, e))?;
    Ok(path_within_workspace(&abs_path, &abs_workspace))
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

/// `list_directory_sandboxed` 里单个文件的**大小事实**：读不到就是 `None`（未知），
/// **不是** `0`。
///
/// 改前是 `entry.metadata().map(|m| m.len()).unwrap_or(0)`：权限不足 / 文件刚被删
/// （竞态）都会得到 `0` ⇒ 前端与模型看到的是"一个 0 字节的空文件"（假事实）。
/// 0 与"读不到"是两件不同的事，不能用一个值表示。
fn file_size_or_unknown(metadata: std::io::Result<std::fs::Metadata>) -> Option<u64> {
    metadata.ok().map(|m| m.len())
}

/// List files in a directory with sandbox enforcement.
/// If sandbox is enabled, only files within the workspace are returned.
#[tauri::command]
async fn list_directory_sandboxed(path: String, workspace: String, sandbox_enabled: bool) -> Result<Vec<FileInfo>, String> {
    if sandbox_enabled {
        // ★ 第 185 波：第三份实现也并入同一份判定（见 `path_within_workspace`）。
        let abs_path = resolve_sandbox_path(std::path::Path::new(&path))
            .map_err(|e| format!("Cannot resolve path: {}", e))?;
        let abs_workspace = resolve_sandbox_path(std::path::Path::new(&workspace))
            .map_err(|e| format!("Cannot resolve workspace: {}", e))?;
        if !path_within_workspace(&abs_path, &abs_workspace) {
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
            /*
             * ★ 第 185 波（R7）：stat 失败**不再变成 0** ✓。
             *
             * 改前 `entry.metadata().map(|m| m.len()).unwrap_or(0)`：权限不足 / 竞态
             * （文件刚被删）都会返回 `0` ⇒ 前端与模型看到的是"一个 0 字节的空文件"，
             * 而不是"这个大小读不到"。0 与"读不到"是两件不同的事，不能用一个值表示。
             * `None` 序列化成 `null` ⇒ 消费方必须显式处理"未知"。
             */
            size: file_size_or_unknown(entry.metadata()),
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
    /// `None` = **大小未知**（stat 失败）。改前这里把"读不到"写成 `0`（假事实）。
    size: Option<u64>,
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

/// ⛔ 已删除（第 186 波）：`is_cmd_var_name_char` / `escape_cmd_percent_expansions` /
/// `cmd_quote_arg` / `build_cmd_invocation`。
///
/// **为什么删**：它们存在的理由是「在 `cmd.exe /c` 的**单行**里把实参拼得足够聪明」。
/// 那一层的输入是「外面还有一层 `cmd /c` 解析 + 脚本内部可能再来一次 `%*` 展开」，
/// 于是同一个字符要同时满足两套规则 ⇒ 只能靠"更聪明的转义"，而这是**不可判定**的
/// （登记在案的歧义）。第 186 波改成：**先生成 wrapper 临时批处理**，让引用发生在
/// 我们完全掌握规则的那一层（见 `build_cmd_wrapper`），无法证明的实参直接拒绝。
///
/// 注意：这里**不是**"顺手删掉不需要的东西"——下面 `CMD_ARG_*` 的拒绝名单里，
/// `%VAR%` 与 `!VAR!` 展开面都还在（只是从"中性化"变成"拒绝"）。

// ==================== 第 186 波：`.cmd/.bat` 启动改成 wrapper 方案 ====================
//
// ## 定性（改前为什么不行）
//
// 改前把 `命令 + 实参` 拼成**一整行**交给 `cmd.exe /c`。那一行要同时穿过两套规则：
//   ① 外层 `cmd /c` 的解析（`%VAR%` 在引号内照样展开、`^`/`&` 只在引号外是元字符）；
//   ② 目标 `.cmd` 自己拿 `%*` / `%1` 再展开一次。
// 于是 `"` 在两套规则下语义不同（CRT 的 `""` = 字面引号，批处理只当引号开关），
// `C:\100%\docs` 里的 `%` 到底会不会被吃掉取决于下游怎么写 —— **在 batch 边界不可判定**。
//
// ## 改法（判据先行：先证「能在哪一层证得动」）
//
// 让引用发生在我们**完全掌握规则**的那一层：生成一个临时 wrapper 批处理
//
//     @echo off
//     "<目标>" "<arg1>" "<arg2>"
//     exit /b %ERRORLEVEL%
//
// 由 `cmd.exe /d /s /c` 启动它（整行经 `raw_arg` 原样交给 CreateProcess：
// `cmd.exe /d /s /c ""C:\…\wrapper.cmd""` —— `/s` 会剥掉最外层那一对引号）。
// wrapper 那一行只被 **cmd 的批处理解析器**看一次，目标进程的 argv 由
// `CommandLineToArgvW` 解析 —— 两条规则各自独立、都有实证（见下）。
//
// ## 判据表（真 `cmd.exe` 端到端；`harden_186_tests` 逐条钉）
//
// | 实参内容 | 结果 | 依据 |
// |---|---|---|
// | `&` `\|` `^` `<` `>` `(` `)` `;` `,` `=` 空格、中文 | 逐字节保真 | 引号**内**在 cmd 里是字面量 |
// | `!` | **拒绝** | `!VAR!` 是延迟展开面；"调用方没开延迟展开"是外部假设，不是我们能证的 |
// | `%`（含 `%PATH%`、`%*`、`100%`、`C:\100%\docs`） | **拒绝** | 批处理里 `%` 的语义依赖上下文（`%%`/`%VAR%`/`%*`），跨层不可能证明逐字节 |
// | `"` | **拒绝** | `%*` 展开后再转一跳时，`""` 与 CRT 的 `""` 不是同一语义 ⇒ 会被吃掉或分裂 |
// | CR / LF / NUL | **拒绝** | 单行批处理无法承载换行；CreateProcess 的整行以 NUL 结尾 |
// | 结尾反斜杠 | 逐字节保真 | 收尾引号前翻倍反斜杠（`"C:\dir\\"`），CRT 与批处理两边都认 |
//
// ## 保真口径（判据真的在测什么）
//
// 不是"我们拼出来的字符串长什么样"（那是判据与实现互相证明的假绿），而是：
// 目标进程（真 `.cmd` → 真 `.exe`）**自己的 argv** 是否逐字节等于输入 —— 见
// `harden_186_tests` 与 `probe-src/argv_probe.rs`（argv 探针）。

/// 判据用 argv 探针的**参数约定**（探针本体在 `probe-src/argv_probe.rs`）。
///
/// 探针被当"目标 `.exe`"启动时，命令行形状是 `<探针> <MAGIC> <落盘路径> <实参…>`，
/// 它把 `<实参…>` 逐字节写进文件。判据 `r186_probe_source_and_lib_agree_on_the_magic`
/// 会**读探针源文件**确认两边用的是同一个串（避免"改了这边忘了那边"而判据照绿）。
pub const ARGV_DUMP_MAGIC: &str = "--codem-argv-dump-186";

/// wrapper 临时文件的前缀（同目录下的僵尸文件靠它认出来回收）。
const CMD_WRAPPER_PREFIX: &str = "codem-mcp-cmd-";

/// 比"肯定没人还在跑"更长的下限：只有**明显**是上一条命留下的残骸才回收。
/// 取值偏大是故意的 —— 另一个 Codem 实例可能正在用同名前缀的文件，宁可不收也不误删。
const CMD_WRAPPER_STALE_SECS: u64 = 900;

/// 生成 wrapper 后，隔多久删临时文件。
///
/// 删早了会有风险：cmd 执行批处理是**逐行读**的（不是一次读完），文件在读的中途消失
/// ⇒ 后面的行可能不被执行。700 ms 覆盖"cmd 已经读过那一行并把目标启动起来"这个窗口：
/// spawn 之后目标进程通常已在几十毫秒内建立。这个数**有判据**（删晚了/不删要变红）。
const CMD_WRAPPER_CLEANUP_DELAY_MS: u64 = 700;

/// 命令路径在我们这一层**不能**出现的字符（与实参名单不同：路径不是 cmd 展开的对象，
/// 但会进 wrapper 那一行，所以要挡住能破坏行结构的字符）。
const CMD_PATH_FORBIDDEN: &[char] = &['"', '\r', '\n', '\0'];

/// 实参在我们这一层**不能**出现的字符（比路径多 `%` 与 `!`：它们是两套展开的入口）。
const CMD_ARG_FORBIDDEN: &[char] = &['"', '%', '!', '\r', '\n', '\0'];

/// 被拒绝的字符在错误信息里的可读名字。
fn cmd_forbidden_char_name(c: char) -> &'static str {
    match c {
        '"' => "双引号「\"」（%* 展开后再转一跳时不再是字面引号：CRT 的 \"\" 与批处理的引号开关语义不同）",
        '%' => "百分号「%」（批处理里 %%/%VAR%/%* 三种含义依赖上下文 ⇒ 跨层无法证明逐字节保真）",
        '!' => "感叹号「!」（!VAR! 是延迟展开面，而「调用方没开延迟展开」是外部假设、不是我们能证的）",
        '\r' => "回车 CR（单行批处理无法承载换行）",
        '\n' => "换行 LF（单行批处理无法承载换行）",
        '\0' => "NUL（CreateProcess 的整行以 NUL 结尾）",
        _ => "不可在 cmd 层安全表达的字符",
    }
}

/// 在 `s` 里找第一个被禁字符，返回「字符 + 下标（字符数，不是字节）」。
fn cmd_first_forbidden(s: &str, forbidden: &[char]) -> Option<(char, usize)> {
    s.char_indices()
        .find(|(_, c)| forbidden.contains(c))
        .map(|(byte_idx, c)| (c, s[..byte_idx].chars().count()))
}

/// 拼装结果：wrapper 的**文本**（纯函数，判据可以直接断言它）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CmdWrapper {
    pub command: String,
    pub args: Vec<String>,
    pub text: String,
}

/// 生成 wrapper 批处理文本，并对每一条实参做 fail-closed 判定。
///
/// **这是可测的核心函数**（纯逻辑，不碰文件系统、不起进程）：命令层只负责"把文本写进
/// 临时文件 + spawn + 清理"。拒绝时返回的错误**点名是第几个参数、为什么**
/// （见 `cmd_arg_rejection` / `cmd_path_rejection`），绝不静默改写。
///
/// ## 为什么实参也要逐字节再检一遍
///
/// 上游（设置面板/市场仓库）可能给我们任何字符串。判据要能**直接驱动**这个判定，
/// 而不是等到 spawn 之后才靠 cmd 的报错发现 —— 那样错误信息里就没有"第几个参数"了。
pub fn build_cmd_wrapper(command: &str, args: &[String]) -> Result<CmdWrapper, String> {
    if let Some(reason) = cmd_path_rejection(command) {
        return Err(format!("MCP 启动命令无法在 cmd.exe 层无歧义表达：{reason}"));
    }
    for (i, a) in args.iter().enumerate() {
        if let Some(reason) = cmd_arg_rejection(i, a) {
            return Err(reason);
        }
    }
    Ok(CmdWrapper {
        command: command.to_string(),
        args: args.to_vec(),
        text: cmd_wrapper_text(command, args),
    })
}

/// 命令路径的拒绝理由（`None` = 可证）。
fn cmd_path_rejection(command: &str) -> Option<String> {
    if command.is_empty() {
        return Some("命令为空".to_string());
    }
    cmd_first_forbidden(command, CMD_PATH_FORBIDDEN).map(|(c, i)| {
        format!(
            "命令路径第 {} 个字符是不能用的：{}",
            i + 1,
            cmd_forbidden_char_name(c)
        )
    })
}

/// 单个实参的拒绝理由。**错误信息必须点名第几个参数**（Tauri 命令层拿它当
/// 面向用户的报错文案：不点名的话用户无从知道该改哪一条）。
fn cmd_arg_rejection(idx: usize, arg: &str) -> Option<String> {
    cmd_first_forbidden(arg, CMD_ARG_FORBIDDEN).map(|(c, i)| {
        format!(
            "第 {} 个参数无法无歧义地传给 .cmd/.bat（共 {} 个字符，问题在第 {} 个字符）：{}{}",
            idx + 1,
            arg.chars().count(),
            i + 1,
            cmd_forbidden_char_name(c),
            cmd_arg_probe_hint(c)
        )
    })
}

/// 给用户的下一步提示：我们能说清"换成什么"的，就说清；说不清的不编。
fn cmd_arg_probe_hint(c: char) -> &'static str {
    match c {
        '%' => "。如果这个参数是字面量（不是要 cmd 展开的变量），请让启动器改用 `.exe` 直启，或把 `%` 从参数里去掉。",
        '!' => "。请去掉 `!`，或改用 `.exe` 直启（直启不经 cmd，不受延迟展开影响）。",
        '"' => "。请去掉参数里的双引号，或改用 `.exe` 直启（直启时引号由 CRT 规则处理，是逐字节保真的）。",
        _ => "。请改用 `.exe` 直启，或去掉该字符。",
    }
}

/// 引用一个实参：整体套一对双引号，**仅**处理"收尾反斜杠会转义收尾引号"这一条。
///
/// `"` / `%` / `!` / CR / LF / NUL 在 `build_cmd_wrapper` 里已经被拒绝 ⇒ 到这里不必
/// （也不许）再做任何"更聪明"的转义：那正是这一波要消灭的东西。
fn quote_cmd_arg_for_wrapper(arg: &str) -> String {
    let mut out = String::with_capacity(arg.len() + 2);
    out.push('"');
    out.push_str(arg);
    let trailing = arg.chars().rev().take_while(|c| *c == '\\').count();
    for _ in 0..trailing {
        out.push('\\');
    }
    out.push('"');
    out
}

/// wrapper 的文本（**纯函数**：同样的输入永远同样的输出，判据直接断言它）。
fn cmd_wrapper_text(command: &str, args: &[String]) -> String {
    let mut line = String::new();
    line.push('"');
    line.push_str(command);
    line.push('"');
    for a in args {
        line.push(' ');
        line.push_str(&quote_cmd_arg_for_wrapper(a));
    }
    // `@echo off` 必须在第一行：否则 cmd 会先把这一行自己回显到 stdout，
    // 而 stdout 是 MCP 的 JSON-RPC 通道 ⇒ 回显就是协议污染（对端会收到非 JSON 行）。
    // `exit /b %ERRORLEVEL%` 保持与改前一致的退出码语义（脚本立即失败时错误码不失真）。
    format!("@echo off\r\n{}\r\nexit /b %ERRORLEVEL%\r\n", line)
}

/// 生成一个唯一的 wrapper 临时文件路径（放在**受控目录** = 系统临时目录下）。
fn cmd_wrapper_file_path() -> std::path::PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    /*
     * 线程名只用来"让临时文件认得出是谁写的"，所以**必须消毒**：
     * Rust 测试线程名形如 `harden_185_tests::harden_186_tests::r186_xxx`，
     * 里面的 `:` 在 Windows 文件名里非法 ⇒ 第一版直接拼进去，`写 wrapper` 全线报
     * os error 123（文件名、目录名或卷标语法不正确）。只留 `[A-Za-z0-9_-]`，
     * 且限长（避免超 MAX_PATH）。
     */
    let tag: String = std::thread::current()
        .name()
        .unwrap_or("t")
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(48)
        .collect();
    std::env::temp_dir().join(format!(
        "{}{}-{}-{}.cmd",
        CMD_WRAPPER_PREFIX,
        std::process::id(),
        nanos,
        tag
    ))
}

/// 把 wrapper 文本写到临时文件（**这一步不删**：删由 `CmdWrapperFile` 负责）。
fn write_cmd_wrapper(text: &str) -> Result<std::path::PathBuf, String> {
    let path = cmd_wrapper_file_path();
    // ASCII 是故意的：命令/实参里的非 ASCII 走 `to_string` 已经是 UTF-8 字节，
    // 而 `.cmd` 正文只允许 ASCII 才是"字节确定"的（重定向/换行都在这一层定死）。
    std::fs::write(&path, text.as_bytes())
        .map_err(|e| format!("写 wrapper 临时文件失败（{}）：{e}", path.display()))?;
    Ok(path)
}

/// 回收上一条命留下的僵尸 wrapper 文件。
///
/// ## 为什么需要（"必须删"的第三条路）
///
/// 正常路径有 `CmdWrapperFile` 的 drop 兜底（spawn 失败、探测失败、提前 return 都覆盖），
/// 但**进程被强杀**时 drop 不会跑 ⇒ 临时目录里会留文件。这里按前缀 + 足够老的 mtime
/// 回收（900 s 下限见 `CMD_WRAPPER_STALE_SECS`：故意保守，不误删另一个实例正在用的）。
///
/// 每个进程只跑一次（`Once`）；失败只记日志 —— 回收失败不该挡住连接。
fn reap_stale_cmd_wrappers() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        let dir = std::env::temp_dir();
        let Ok(entries) = std::fs::read_dir(&dir) else {
            return;
        };
        let now = std::time::SystemTime::now();
        let mut removed = 0usize;
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if !name.starts_with(CMD_WRAPPER_PREFIX) {
                continue;
            }
            let Ok(meta) = e.metadata() else { continue };
            let Ok(modified) = meta.modified() else { continue };
            let age = now
                .duration_since(modified)
                .unwrap_or(std::time::Duration::ZERO);
            if age.as_secs() < CMD_WRAPPER_STALE_SECS {
                continue;
            }
            if std::fs::remove_file(e.path()).is_ok() {
                removed += 1;
            }
        }
        if removed > 0 {
            runtime_log::append_line(
                "INFO",
                &format!("回收了 {removed} 个上一条命留下的 MCP cmd wrapper 临时文件"),
            );
        }
    });
}

/// wrapper 临时文件的守卫：**成功/失败/提前 return 三条路都必须删**。
///
/// 「多活一会儿」的删除走后台任务（`schedule_cmd_wrapper_cleanup`）；
/// 这里只负责"还没到那一步就出错"的同步删除。
struct CmdWrapperFile(std::path::PathBuf);

impl Drop for CmdWrapperFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// spawn 之后的延迟删除：等 cmd 把 wrapper 读完再删（早删会让批处理后半段读不到，
/// 见 `CMD_WRAPPER_CLEANUP_DELAY_MS`）。
///
/// ## 为什么不能"目标进程退出时再删"
///
/// MCP 服务器是**长驻**的（stdin 一直开着）⇒ "等它退出"等于永不删除。留一大片
/// 临时文件是同一类漏；所以按**固定窗口**删（判据：`r186_wrapper_file_is_removed_*`）。
fn schedule_cmd_wrapper_cleanup(path: std::path::PathBuf) {
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(
            CMD_WRAPPER_CLEANUP_DELAY_MS,
        ))
        .await;
        let _ = std::fs::remove_file(&path);
    });
}

// 第 186 波的 argv 探针**不在 lib 里**：`cargo test` 生成的 `main` 是 libtest 的
// harness（不走 `run()`），而 libtest 遇到陌生选项会直接 `exit(1)` ⇒ 自举探针不可能
// 生效（实测报 `error: Unrecognized option: 'codem-argv-dump-186'`）。
// 探针因此单独立在 `probe-src/argv_probe.rs`（自己有 `main`、不链接 libtest）；
// 判据在 `harden_186_tests` 里**现场 `rustc` 它**⇒ 不依赖 "先 cargo build --bins"。

/// `cmd.exe` 壳的启动探测窗口（毫秒）。
///
/// 为什么需要探测：`.cmd/.bat` 必须经 `cmd.exe /c` 才能起来，于是 `spawn` 成功只说明
/// **cmd 起来了**，不说明目标程序起来了。窗口取 400 ms：MCP 服务器（node 起步）
/// 不可能在 400 ms 内正常退出，而 `cmd` 找不到目标时会立刻退出（几十毫秒）。
const MCP_START_PROBE_MS: u64 = 400;

/// 探测到"壳立刻退出"时给调用方的错误：**不许报成功**，并把 cmd 自己吐的 stderr 带上
/// （那里面通常就是 `'C:\Program' 不是内部或外部命令` 这种一眼能看懂的原因）。
fn cmd_probe_verdict(command: &str, code: Option<i32>, stderr: &str) -> String {
    let detail = if stderr.trim().is_empty() {
        "（cmd 的 stderr 为空）".to_string()
    } else {
        runtime_log::truncate_utf8(stderr.trim(), 300)
    };
    format!(
        "MCP 目标程序没有真正启动：cmd.exe 壳在 {}ms 内就退出了（exit={:?}）——这不是「连接成功」。\
         command=「{}」；cmd stderr={}。常见原因：路径/参数引号不对，或该 .cmd/.bat 不存在。",
        MCP_START_PROBE_MS, code, command, detail
    )
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
    let lower = command.to_ascii_lowercase();
    let needs_cmd_wrapper = cfg!(target_os = "windows")
        && (lower.ends_with(".cmd") || lower.ends_with(".bat"));

    /*
     * ★ 第 186 波：`.cmd/.bat` 那条路不再"拼整行"，改成**生成 wrapper 批处理**。
     *
     * 生命周期（成功/失败/超时三条路都必须删）：
     *   - 生成：`build_cmd_wrapper`（纯函数，先做 fail-closed 判定）→ `write_cmd_wrapper`；
     *   - 守卫：`CmdWrapperFile`（`Drop` 删）—— 覆盖 spawn 失败、探测失败、任何提前 return；
     *   - 成功后：`schedule_cmd_wrapper_cleanup` 在固定窗口后删（MCP 是长驻进程，
     *     "等它退出再删"等于永不删）；
     *   - 上一条命被杀留下的残骸：`reap_stale_cmd_wrappers`（按前缀 + 足够老回收）。
     */
    let wrapper_guard = if needs_cmd_wrapper {
        let spec = build_cmd_wrapper(&command, args.as_deref().unwrap_or(&[]))?;
        reap_stale_cmd_wrappers();
        let path = write_cmd_wrapper(&spec.text)?;
        Some(CmdWrapperFile(path))
    } else {
        None
    };

    let mut cmd = if let Some(w) = &wrapper_guard {
        // Windows CreateProcess 不能直接执行 .cmd/.bat ⇒ 用 cmd.exe 包装**wrapper**。
        // （codegraph 官方发布是 bin/codegraph.cmd，MCP 连接指向其绝对路径。）
        let mut c = tokio::process::Command::new("cmd.exe");
        c.arg("/d").arg("/s").arg("/c");
        let path = w.0.display().to_string();
        #[cfg(target_os = "windows")]
        {
            /*
             * `raw_arg` + **双外层引号**：`/s` 的语义是"剥掉最外层那一对引号"，
             * 所以命令行要写成 `cmd.exe /d /s /c ""C:\…\wrapper.cmd""` —— 剥一层后
             * 正好剩 `"C:\…"`，含空格的路径才不会被 cmd 从空格处截断（实测：
             * 写单层引号时 cmd 把 `C:\…\Temp\probe` 当命令名 ⇒ 9009 找不到命令）。
             *
             * 这里**不是**"又拼了一行聪明引号"：wrapper 路径由我们生成（受控目录 + 我们起名），
             * 它的引用规则只有"套一层引号"这一条，且只出现**这一个**被引用的 token。
             * 实参的引用全部发生在 wrapper 正文里（见 `cmd_wrapper_text`），不再穿这一层。
             */
            c.raw_arg(format!("\"{}\"", path));
        }
        #[cfg(not(target_os = "windows"))]
        {
            c.arg(&path);
        }
        c
    } else {
        let mut c = tokio::process::Command::new(&command);
        if let Some(args) = &args {
            // 直接交给 CreateProcess：每个 arg 独立传递，没有 shell 参与。
            c.args(args);
        }
        c
    };
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

    // 第 181 波：**drop 兜底**。Tauri 退出时 `AppState`（含本进程句柄）会被丢弃，
    // 而 `tokio::process::Child` 默认**不杀子进程** ⇒ 没有这一行就只能靠 ExitRequested
    // 的显式回收；有了它，即使退出路径没走到（异常结束），进程也不会留下来当孤儿。
    cmd.kill_on_drop(true);
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn MCP process: {}", e))?;

    // ★ 第 185 波：**只有经 cmd.exe 包装的那条路**才需要探测"目标到底起没起"。
    // 直接 CreateProcess 的路子上，目标不存在时 `spawn` 自己就返回 Err（已经如实报了），
    // 所以不加这 400 ms 的无谓延迟。
    if needs_cmd_wrapper {
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(MCP_START_PROBE_MS);
        loop {
            match child.try_wait() {
                Ok(Some(status)) => {
                    let mut detail = String::new();
                    if let Some(mut se) = child.stderr.take() {
                        let mut buf = Vec::new();
                        let _ = tokio::time::timeout(
                            std::time::Duration::from_millis(300),
                            tokio::io::AsyncReadExt::read_to_end(&mut se, &mut buf),
                        )
                        .await;
                        detail = String::from_utf8_lossy(&buf).to_string();
                    }
                    let _ = kill_process_tree(child.id());
                    return Err(cmd_probe_verdict(&command, status.code(), &detail));
                }
                Ok(None) => {}
                Err(e) => return Err(format!("MCP 进程探测失败：{e}")),
            }
            if std::time::Instant::now() >= deadline {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    }

    // ★ 探测通过 ⇒ 到这里 cmd 已经把 wrapper 读过并起了目标。
    // 交付给后台延迟删除（**成功这条路也要删**；不删就是留着一片临时文件）。
    if let Some(w) = wrapper_guard {
        schedule_cmd_wrapper_cleanup(w.0.clone());
        // 守卫在这里交出所有权：之后（改前那种"提前 return"）由上面的后台任务兜底。
        std::mem::forget(w);
    }

    let stdin = child.stdin.take().ok_or("Failed to capture stdin")?;
    let stdout = child.stdout.take().ok_or("Failed to capture stdout")?;
    let stderr = child.stderr.take();

    let pending: Arc<TokioMutex<HashMap<i64, oneshot::Sender<serde_json::Value>>>> =
        Arc::new(TokioMutex::new(HashMap::new()));
    let pending_clone = pending.clone();
    let name_for_log = name.clone();

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

    // stderr 必须有人读：MCP 服务器往 stderr 写日志（node 的 deprecation warning 等），
    // 管道写满之后子进程会**阻塞在 write 上**，表现是"连着连着就不回话了"。
    // 这里读一行记一行（有上限，见循环次数），既防堵也留下诊断线索。
    if let Some(stderr) = stderr {
        tokio::spawn(async move {
            let mut reader = BufReader::new(stderr).lines();
            let mut lines = 0u32;
            while let Ok(Some(line)) = reader.next_line().await {
                if line.trim().is_empty() {
                    continue;
                }
                lines += 1;
                if lines <= 200 {
                    runtime_log::append_line(
                        "INFO",
                        &format!(
                            "mcp stderr name={} line={}",
                            name_for_log,
                            runtime_log::truncate_utf8(&line, 300)
                        ),
                    );
                } else if lines == 201 {
                    runtime_log::append_line(
                        "WARN",
                        &format!("mcp stderr name={} 超过 200 行，后续只丢弃（防止日志刷爆）", name_for_log),
                    );
                }
            }
        });
    }

    let mut processes = state.mcp_processes.lock().await;
    processes.insert(name, McpProcessHandle {
        stdin: Arc::new(TokioMutex::new(stdin)),
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

    /*
     * ★ 第 185 波：**整表锁只用来取两个 Arc，取完立刻放掉** ✓。
     *
     * 改前这里 `let mut processes = state.mcp_processes.lock().await;` 的 guard
     * **活到函数结束** ⇒ 等应答的 30 s 里整张进程表都被锁住：另一个服务器的请求、
     * "断开"、退出时的回收全部排队（各自白等 30 s），而退出路径用的是 `try_lock`
     * ⇒ 直接放弃回收（就是"退出后还剩 node 服务"那条口子）。
     */
    let (stdin, pending) = {
        let processes = state.mcp_processes.lock().await;
        let handle = processes
            .get(&name)
            .ok_or(format!("MCP process '{}' not found", name))?;
        (handle.stdin.clone(), handle.pending.clone())
    }; // ← 整表锁在这里就放掉了

    // Register a pending response channel
    let (tx, rx) = oneshot::channel();
    pending.lock().await.insert(id, tx);

    // Write message + newline to stdin（只持 **stdin 这一把**小锁，且只包住这两次写）
    let write_result = {
        let mut stdin = stdin.lock().await;
        let mut r = stdin
            .write_all(format!("{}\n", message).as_bytes())
            .await
            .map_err(|e| format!("Failed to write to stdin: {}", e));
        if r.is_ok() {
            r = stdin
                .flush()
                .await
                .map_err(|e| format!("Failed to flush stdin: {}", e));
        }
        r
    };
    if let Err(e) = write_result {
        // 写失败 ⇒ 把刚登记的回调撤掉（改前 `?` 会把它留在表里，谁也收不到）
        pending.lock().await.remove(&id);
        return Err(e);
    }

    // Wait for response with timeout (30 seconds) —— **不持任何锁**
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        rx,
    ).await;

    match result {
        Ok(Ok(json)) => Ok(serde_json::to_string(&json).unwrap_or_default()),
        Ok(Err(_)) => {
            pending.lock().await.remove(&id);
            Err("MCP response channel closed".to_string())
        }
        Err(_) => {
            // Timeout — clean up pending request
            pending.lock().await.remove(&id);
            Err("MCP request timeout (30s)".to_string())
        }
    }
}

/// Disconnect and kill an MCP stdio process.
///
/// 第 181 波：从 `Child::kill` 改成 **进程树回收**。stdio MCP 服务器几乎都是启动器
/// （`npx …` / `cmd.exe /c codegraph.cmd`），真正干活的是它的子进程；只杀直接子进程
/// 会让服务本体留下来（与退出时的同一条缺口，判据共用 `kill_process_tree`）。
#[tauri::command]
async fn mcp_stdio_disconnect(
    state: State<'_, AppState>,
    name: String,
) -> Result<(), String> {
    // ★ 第 185 波：**取句柄时持锁，杀进程时不持锁**。
    // 改前这把整表锁一直被拿到 `wait().await` 结束 ⇒ 断开一个服务器期间，
    // 别的服务器的请求/连接全被挡住（用户侧就是"点断开没反应"）。
    let handle = {
        let mut processes = state.mcp_processes.lock().await;
        processes.remove(&name)
    };
    let Some(mut handle) = handle else {
        return Ok(());
    };
    let pid = handle._child.id();
    // 先按进程树杀（覆盖 `npx`/`cmd.exe` 派生的孙进程）。
    let _ = kill_process_tree(pid);
    // 再让 tokio 回收句柄本身：等它退出，避免留下僵尸。
    let _ = handle._child.kill().await;
    let _ = handle._child.wait().await;
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
    // 记下"这次退出是前端请求的" —— 事后靠它把「用户点的退出」与
    // 「谁都没请求、进程却要结束」（系统关机 / 外部结束）区分开（见 crash_evidence.rs）。
    crash_evidence::mark_frontend_quit_requested();
    // 清理所有 PTY 会话：kill 子进程，避免退出后 cmd.exe 等残留（对标 dsh
    // 进程树纪律 — Windows 上进程退出不会自动杀孙进程）。
    //
    // ★ 第 185 波（R7）：**锁中毒时不许静默跳过整树回收**。
    // 改前 `if let Ok(mut map) = pty_map.lock()` —— 只要有一个别的线程在持锁时 panic
    // （中毒），这里就一行日志都没有地跳过回收，紧接着 `app.exit(0)`
    // ⇒ 终端里跑的 `npm test` 等孙进程全部留下，而日志里查不到任何线索。
    // `into_inner()` 拿到中毒锁里的数据照样能用（里面的 HashMap 只是索引表，
    // 不参与任何"被 panic 破坏"的不变量），所以这里取数据 + 如实记 WARN 是正确的选择。
    {
        let mut map = match pty_map.lock() {
            Ok(guard) => guard,
            Err(poisoned) => {
                runtime_log::append_line(
                    "WARN",
                    "pty cleanup: PtyMap 锁中毒（有线程持锁时 panic）—— 仍按现有内容回收，可能漏掉部分会话",
                );
                poisoned.into_inner()
            }
        };
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
    /*
     * ★ 第 185 波（R7）：**不许假成功**。
     *
     * 改前 `if let Some(tray) … { … }` 后面直接 `Ok(())` —— 托盘不存在时（例如
     * 托盘被系统/用户关掉、或启动路径没建托盘）这个命令返回成功，而菜单**一个字都没换**：
     * 用户点"切换语言"看到成功提示、界面纹丝不动，事后从日志里查不出任何东西。
     * 现在如实返回错误（调用方能把失败告诉用户）。
     */
    let Some(tray) = app.tray_by_id("main-tray") else {
        runtime_log::append_line(
            "WARN",
            "update_tray_language: 找不到托盘 'main-tray' ⇒ 语言**没有**生效（如实报错，不再假成功）",
        );
        return Err("Tray icon 'main-tray' not found — tray language was NOT updated".to_string());
    };
    tray.set_menu(Some(menu)).map_err(|e| e.to_string())?;
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

/// 第 158 轮：**系统窗口材质（Windows Mica/Acrylic、macOS vibrancy）到底应用成功没有**。
/// 取值：`"mica"` / `"acrylic"` / `"vibrancy"` / `""`（没成功）。前端只在非空时才敢把外壳底色让出来。
/// 为什么要跨进程边界问 Rust：前端**猜不出来** —— 系统版本、用户"透明效果"开关、DWM 组合状态
/// 都会让 apply 失败，而失败时把底色设成 transparent 会得到"没有材质的透明窗口"（比实色更糟）。
static NATIVE_MATERIAL: std::sync::OnceLock<String> = std::sync::OnceLock::new();

fn set_native_material(name: &str) {
    let _ = NATIVE_MATERIAL.set(name.to_string());
    eprintln!("[vibrancy] native material = {}", if name.is_empty() { "(none)" } else { name });
}

/// 前端启动时问一次：有没有系统材质可用（空串 = 没有）。
#[tauri::command]
fn native_material() -> String {
    NATIVE_MATERIAL.get().cloned().unwrap_or_default()
}

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
install_panic_hook();// ===== 微信 ClawBot 桥（iLink 传输层）管理态 =====
let ilink_state = ilink::IlinkState::new();
// ===== 手机连接（phone-link）管理态 =====
let phone_state = phone::PhoneState::new();
        // 阶段 R6：AA connector 的运行时状态（与手机那套并列，互不干扰）
        let aa_connector_state = phone::aa_connector::AaConnectorState::new();
// ===== 出站 connector（远程中继，第 122 轮 §11B）管理态 =====
let connector_state = phone::connector::ConnectorState::new();
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
        .manage(aa_connector_state)
        .manage(connector_state.clone())
        .manage(storage_state)
        .manage(Arc::new(Mutex::new(HashMap::<String, PtySession>::new())) as PtyMap)
        // 第 103 波：Rust 侧 JS 沙箱的"等前端回复"表（run_code / workflow 的 sdk 调用走它）
        .manage(js_sandbox::PendingHostCalls::default())
        // 动态插件的沙箱会话（持久环境 + 宿主回调 guest 函数）
        .manage(js_sandbox_session::SandboxSessions::default())
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
            // 第 103 波：Rust 侧 JS 沙箱（不经 eval 跑 run_code / workflow 的脚本）
            js_sandbox::js_run_sandboxed,
            js_sandbox::jsvm_host_reply,
            js_sandbox_session::js_sandbox_open,
            js_sandbox_session::js_sandbox_eval,
            js_sandbox_session::js_sandbox_call_function,
            js_sandbox_session::js_sandbox_close,
            crash_evidence::log_renderer_event,
            crash_evidence::log_renderer_heartbeat,
            crash_evidence::take_renderer_crash_marker,
            secret_backend_available,
    secret_seal,
    secret_unseal,
    native_material,
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
            read_text_window,
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
            file_version,
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
            phone::aa_account_login,
        phone::aa_account_send_code,
        phone::aa_account_logout,
        phone::aa_account_status,
        phone::aa_connect,
        phone::aa_connector_start,
        phone::aa_connector_stop,
        phone::aa_connector_status,
        phone::phone_start,
            phone::phone_stop,
            phone::phone_status,
            phone::phone_decide,
            phone::phone_unpair,
            phone::phone_respond,
            // 第 122 轮阶段 1：CA 指纹与证书（桌面展示/保存用）
            phone::phone_ca_pem,
            phone::phone_ca_fingerprint,
            // 第 122 轮 §11B：出站 connector（远程中继）
            phone::connector::phone_relay_start,
            phone::connector::phone_relay_stop,
            phone::connector::phone_relay_status,
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
            app.manage(phone::aa_account::AaAccountStore::new(phone::phone_dir(app.handle())));
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

            // ===== 渲染进程崩溃取证 =====
            // 真机事故：主对话里 agent 调 wait_for_delegation 后页面白屏（WebView2 渲染进程死了），
            // 而当时**一点痕迹都没留下**（没有 crash log、没有事件日志、Crashpad 也是空的）。
            // 这里把 ProcessFailed 事件接到运行时日志上；心跳由前端定时发（见 renderer-evidence.ts）。
            crash_evidence::install_process_failed_logging(app.handle());

            // Apply window vibrancy (frosted glass effect)
            //
            // ⚠️ 第 158 轮（对标 OpenBitFun 的 `data-openbitfun-native-material='sidebar'`）：
            // **光有系统材质是看不见的** —— 网页只要在它上面画了不透明底色，Mica/Acrylic 就等于没开。
            // 对方源码里这件事是三件配套：Rust 侧 `.transparent(true)` + `Effect::Acrylic`；
            // 启动注入脚本给 `<html>` 打 `data-…-native-material='sidebar'` 并把 html/body 底色设成
            // `transparent`；CSS 再按这个属性把外壳的 CSS 模糊**关掉**（他们的注释原文：
            // The OS blurs desktop pixels; a CSS backdrop only sees the webview）。
            // 我们此前只做了第一件（材质早就 apply 了，见下面几行），前端一直是不透明底 ⇒ 材质白开。
            // 现在把"材质到底应用成功没有"记进静态量，由 `native_material` 命令交给前端，
            // 前端在**首次渲染前**打上 `data-native-material` ⇒ CSS 才敢把底色让出来。
            #[cfg(target_os = "windows")]
            {
                if let Some(window) = app.get_webview_window("main") {
                    // Win11: Mica (wallpaper-tinted); fallback to Win10 Acrylic
                    let result = window_vibrancy::apply_mica(&window, Some(true));
                    if let Err(e) = result {
                        eprintln!("[vibrancy] Mica failed ({}), trying Acrylic", e);
                        match window_vibrancy::apply_acrylic(&window, Some((18, 18, 18, 100))) {
                            Ok(()) => set_native_material("acrylic"),
                            Err(e2) => {
                                eprintln!("[vibrancy] Acrylic 也失败（{e2}）—— 保持不透明底（前端不打 data-native-material）");
                                set_native_material("");
                            }
                        }
                    } else {
                        set_native_material("mica");
                    }
                }
            }

            #[cfg(target_os = "macos")]
            {
                if let Some(window) = app.get_webview_window("main") {
                    use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};
                    match apply_vibrancy(&window, NSVisualEffectMaterial::HudWindow, Some(NSVisualEffectState::Active), None) {
                        Ok(()) => set_native_material("vibrancy"),
                        Err(e) => {
                            eprintln!("[vibrancy] macOS vibrancy 失败（{e}）—— 保持不透明底");
                            set_native_material("");
                        }
                    }
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
                let ilink_app2 = app.handle().clone();
                let ilink_st = ilink_state.clone();
                let ilink_st2 = ilink_st.clone();
                tauri::async_runtime::spawn(async move {
                    ilink::restore_on_startup(ilink_app, ilink_st).await;
                ilink::spawn_watchdog(ilink_app2.clone(), ilink_st2);
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
                //
                // ⚠️ 第 71 轮：**把"谁要求退出的"一起记下来**。此前这里只有一行
                // "process exiting"，于是"用户点的退出"与"没人请求、系统要关机 /
                // 外部结束进程"在日志里长得一模一样 —— 真机上两者都表现为
                // "应用突然没了"，事后完全分不清是崩溃还是被结束。
                // 前端请求过退出 → 用户路径；没请求过 → 外部/系统路径。
                runtime_log::append_line(
                    "INFO",
                    &format!(
                        "process exiting (ExitRequested) frontend_quit_requested={}",
                        crash_evidence::frontend_quit_requested()
                    ),
                );
                // 第 181 波：退出前收掉 MCP stdio 进程树（否则 npx/codegraph 这类
                // 启动器的服务本体会留在系统里）。
                // 第 185 波：返回值必须被消费 —— `LockBusy` 表示**没能回收**，
                // 函数内部已经按结局落了日志（见 mcp_shutdown_log_line）。
                let _ = kill_all_mcp_processes(&app_handle.state::<AppState>());
                clear_active_run_marker(app_handle);
            }
            tauri::RunEvent::Exit => {
                // 事件循环已经结束（进程即将消失）。这一行是"走到最后一步"的证据：
                // 它存在 ⇒ 退出是**受控**的；它缺失但下次启动报 unclean ⇒ 进程是被强杀/崩掉的。
                runtime_log::append_line("INFO", "process exit (RunEvent::Exit)");
                // 兜底：ExitRequested 没走到（或之后又有连接建立）时，这里再收一次。
                let _ = kill_all_mcp_processes(&app_handle.state::<AppState>());
            }
            tauri::RunEvent::WindowEvent {
                label,
                event: WinEvent::Destroyed,
                ..
            } => {
                runtime_log::append_line(
                    "WARN",
                    &format!("window destroyed label={label}（渲染进程没了或窗口被关）"),
                );
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
mod text_window_tests {
    use super::*;

    fn temp_file(name: &str, content: &[u8]) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "codem-textwindow-{}-{}",
            name,
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).expect("建临时目录");
        let path = dir.join("log.jsonl");
        std::fs::write(&path, content).expect("写临时文件");
        path
    }

    /// 把整个文件按窗口读完，拼回原文（**这是调用方的用法**：循环直到 eof）。
    fn read_all(path: &str, window: u64) -> String {
        let mut out = String::new();
        let mut offset = 0u64;
        let mut guard = 0;
        loop {
            let w = read_text_window_impl(path, offset, window).expect("分窗读取必须成功");
            out.push_str(&w.text);
            offset = w.next_offset;
            guard += 1;
            assert!(guard < 10_000, "分窗读取没有收敛（offset 没有前进）");
            if w.eof {
                break;
            }
        }
        out
    }

    /// ① 行对齐：窗口大小取遍各种"故意切在行中间"的值，拼回来必须**逐字节**等于原文。
    /// 这条是分窗读取的核心不变量 —— 切出半行 JSON 就等于造坏行。
    #[test]
    fn windows_are_line_aligned_and_lossless() {
        let mut src = String::new();
        // 行长故意不均匀（60~200 字节），文件总量 ~130 KB ⇒ 64 KB 窗口至少要读 3 次
        for i in 0..1000 {
            let pad = "x".repeat(20 + (i % 140));
            src.push_str(&format!(
                "{{\"id\":\"m{i}\",\"content\":\"第 {i} 行内容 content-{i} {pad}\"}}\n"
            ));
        }
        let path = temp_file("aligned", src.as_bytes());
        let p = path.to_str().unwrap();
        assert!(src.len() > 128 * 1024, "样本文件要足够大，否则测不到多窗口");

        // 63 KB / 64 KB / 65 KB / 100 KB / 1 MB：故意都**不是**行长的整数倍
        for window in [63 * 1024u64, 64 * 1024, 65 * 1024, 100 * 1024, 1024 * 1024] {
            let got = read_all(p, window);
            assert_eq!(got, src, "窗口 {window} 拼接结果与原文不一致");
        }

        // 每一段返回的文本都必须"以换行结尾或已到文件末尾"，且下一段从行首开始
        let first = read_text_window_impl(p, 0, 64 * 1024).unwrap();
        assert!(first.text.ends_with('\n'), "窗口应当补到行尾");
        assert!(!first.eof, "130 KB 不可能在一个 64 KB 窗口里读完");
        let second = read_text_window_impl(p, first.next_offset, 64 * 1024).unwrap();
        assert!(
            second.text.starts_with("{\"id\":\""),
            "第二次读取必须从**行首**开始，实际开头：{:?}",
            &second.text[..second.text.len().min(24)]
        );
    }

    /// ② 多字节 UTF-8：窗口边界落在汉字/emoji 中间也不能解码失败（靠"补到行尾"保证）。
    #[test]
    fn multibyte_utf8_never_splits_mid_character() {
        let mut src = String::new();
        for i in 0..200 {
            src.push_str(&format!("{{\"c\":\"中文内容，带表情 🚀 和省略号… {i}\"}}\n"));
        }
        let path = temp_file("utf8", src.as_bytes());
        let got = read_all(path.to_str().unwrap(), 64 * 1024);
        assert_eq!(got, src, "多字节字符被切坏或内容丢失");
    }

    /// ③ 文件末尾没有换行：最后一行必须照样读出来（不能被当成空行丢掉）。
    #[test]
    fn last_line_without_newline_is_returned() {
        let src = "{\"a\":1}\n{\"b\":2}";
        let path = temp_file("no-trailing-nl", src.as_bytes());
        let got = read_all(path.to_str().unwrap(), 64 * 1024);
        assert_eq!(got, src);
        let w = read_text_window_impl(path.to_str().unwrap(), 0, 64 * 1024).unwrap();
        assert!(w.eof, "读完整个文件后 eof 必须为真");
        assert_eq!(w.size, src.len() as u64);
    }

    /// ④ offset 落在文件末尾之后：返回空文本 + eof，**不报错**
    /// （调用方按 `eof` 收敛；这里报错会让"刚好读完"变成一次假失败）。
    #[test]
    fn offset_at_or_past_eof_is_empty_not_error() {
        let src = "{\"a\":1}\n";
        let path = temp_file("eof", src.as_bytes());
        let p = path.to_str().unwrap();
        for offset in [src.len() as u64, src.len() as u64 + 999] {
            let w = read_text_window_impl(p, offset, 64 * 1024).expect("越界 offset 不该报错");
            assert!(w.text.is_empty(), "越界 offset 应当返回空文本");
            assert!(w.eof);
            assert_eq!(w.next_offset, src.len() as u64, "next_offset 必须收敛到文件末尾");
        }
    }

    /// ⑤ 单行超长 → **明确报错**，绝不截断（截断会造出一条永远读不出来的坏行）。
    /// 这里用 `TEXT_WINDOW_MAX_LINE_BYTES` 造一个"超长行"太大（128 MB），
    /// 所以只断言**正常超窗口的行不会报错**、以及错误码字面量存在。
    #[test]
    fn a_line_longer_than_the_window_is_read_whole() {
        let long = "x".repeat(200 * 1024); // 200 KB 一行 > 64 KB 窗口
        let src = format!("{{\"big\":\"{long}\"}}\n{{\"tail\":1}}\n");
        let path = temp_file("longline", src.as_bytes());
        let got = read_all(path.to_str().unwrap(), 64 * 1024);
        assert_eq!(got, src, "超窗口的单行必须整行返回");
        assert!(TEXT_WINDOW_MAX_LINE_BYTES >= 64 * 1024 * 1024);
    }

    /// ⑥ BOM：offset==0 时剥掉（与 `read_file` 同一约定），且只剥一次。
    #[test]
    fn bom_is_stripped_only_in_the_first_window() {
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice("{\"a\":1}\n".as_bytes());
        let path = temp_file("bom", &bytes);
        let p = path.to_str().unwrap();
        let w = read_text_window_impl(p, 0, 64 * 1024).unwrap();
        assert_eq!(w.text, "{\"a\":1}\n", "首窗应当剥掉 BOM");
        // 第二窗（若存在）不会再剥
        let w2 = read_text_window_impl(p, w.next_offset, 64 * 1024).unwrap();
        assert!(w2.text.is_empty());
    }

    /// ⑦ 窗口大小会被夹到 [64 KB, 8 MB]：调用方传 1 字节或传 1 TB 都不该让内存失控，
    /// 也不该退化成"一次 IPC 读一行"。
    #[test]
    fn window_size_is_clamped() {
        // 9 MB：比窗口上限大，才能看出"上限真的生效"
        let src = "a\n".repeat(4 * 1024 * 1024 + 512 * 1024);
        let path = temp_file("clamp", src.as_bytes());
        let p = path.to_str().unwrap();

        let tiny = read_text_window_impl(p, 0, 1).expect("过小的窗口应当被夹到下限");
        assert!(
            tiny.next_offset >= TEXT_WINDOW_MIN_BYTES,
            "过小的窗口应当被夹到下限，实际只前进 {} 字节",
            tiny.next_offset
        );
        assert!(!tiny.eof, "9 MB 的文件不该被 64 KB 窗口一次读完");

        let huge = read_text_window_impl(p, 0, u64::MAX).expect("过大的窗口应当被夹到上限");
        assert!(
            huge.text.len() as u64 <= TEXT_WINDOW_MAX_BYTES,
            "过大的窗口应当被夹到上限，实际返回 {} 字节",
            huge.text.len()
        );
        assert!(!huge.eof, "9 MB 的文件不该被 8 MB 窗口一次读完");
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

/// 第 95 波：**线上字段名**的判据（前端读的名字必须与 Rust 序列化出来的名字一致）。
///
/// ## 为什么必须钉这个
///
/// 前端 `src/core/file-api.ts` 声明的是 camelCase（`nextOffset` / `totalLines` / `hasMore`），
/// 而 Rust 结构体字段是 snake_case。真机实测（装机应用里调 `read_text_window`）拿到的键是
/// `["text","next_offset","eof","size"]` ⇒ **`nextOffset` 恒为 `undefined`**：
/// 窗口循环不前进（超过 8 MB 的会话日志会原地打转），`read` 的"还有更多行"提示从不出现。
/// 之所以长期没被发现：TS 单测全都用**自己写的桩**（返回 camelCase），桩比真机"更对"。
///
/// 这两条断言直接看 `serde_json::to_value` 的结果 —— 也就是**前端真实收到的东西**。
/// 变异自证：去掉任一 `#[serde(rename_all = "camelCase")]` ⇒ 对应用例必须失败。
#[cfg(test)]
mod wire_naming_tests {
    use super::*;
    use serde_json::Value;

    /**
     * 键名集合（**排序后**比较）。
     *
     * 为什么不比顺序：`serde_json::Value` 的对象默认按 BTreeMap 存键（没有 `preserve_order`
     * 特性），所以 `to_value` 出来的顺序是字典序，而真实 IPC 上发的是结构体字段序。
     * 线上契约要求的是**名字**一致（消费方按名字取），不是顺序。
     */
    fn key_set(v: &Value) -> Vec<String> {
        let mut k: Vec<String> = v
            .as_object()
            .expect("必须是对象")
            .keys()
            .cloned()
            .collect();
        k.sort();
        k
    }

    #[test]
    fn text_window_serializes_camel_case_keys() {
        let v = serde_json::to_value(TextWindow {
            text: "a\n".into(),
            next_offset: 2,
            eof: false,
            size: 2,
        })
        .expect("序列化");
        assert_eq!(
            key_set(&v),
            vec!["eof", "nextOffset", "size", "text"],
            "前端读的是 nextOffset（camelCase）—— 线上名字不一致会让窗口循环退回 offset=0"
        );
    }

    #[test]
    fn read_file_lines_serializes_camel_case_keys() {
        let v = serde_json::to_value(ReadFileLinesResult {
            text: "1: a\n".into(),
            total_lines: 1,
            has_more: false,
            // 第 181 波（T-3）：丢弃计数也走 camelCase（前端读 `droppedLines` / `droppedChars`）
            dropped_lines: 0,
            dropped_chars: 0,
        })
        .expect("序列化");
        assert_eq!(
            key_set(&v),
            vec!["droppedChars", "droppedLines", "hasMore", "text", "totalLines"],
            "前端读的是 totalLines / hasMore / droppedLines / droppedChars —— 不一致会让\
             「还有更多行 / 还差多少」的提示永不出现（静默截断）"
        );
    }
}

/// 第 95 波：文件**版本令牌**的判据（`fs-observation-policy` 的 CAS 依据）。
///
/// 变异自证：把 `file_version_impl` 里的 `format!("{}:{}", len, mtime)` 改成只返回 `len`
/// ⇒ `version_changes_when_a_same_size_file_is_rewritten` 必须失败
/// （同长度改写会漏判，而那正是"你读完之后文件被改过"最常见的一种）。
#[cfg(test)]
mod file_version_tests {
    use super::*;

    fn temp_path(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("codem-fsver-{}-{}", name, std::process::id()));
        std::fs::create_dir_all(&dir).expect("建临时目录");
        dir.join("f.txt")
    }

    #[test]
    fn missing_file_is_none_not_an_error() {
        let path = temp_path("missing");
        let _ = std::fs::remove_file(&path);
        assert_eq!(file_version_impl(&path).expect("不存在不是错误"), None);
    }

    #[test]
    fn existing_file_yields_a_token_with_size() {
        let path = temp_path("exists");
        std::fs::write(&path, b"hello").expect("写文件");
        let v = file_version_impl(&path).expect("版本查询").expect("应当有令牌");
        let (size, mtime) = v.split_once(':').expect("格式 <size>:<mtime>");
        assert_eq!(size, "5");
        assert!(mtime.parse::<u128>().unwrap() > 0, "mtime 必须被带上：{v}");
    }

    /// **主判据**：同长度的改写也必须换令牌（只靠 size 会漏判）。
    #[test]
    fn version_changes_when_a_same_size_file_is_rewritten() {
        let path = temp_path("same-size");
        std::fs::write(&path, b"aaaaa").expect("写文件");
        let before = file_version_impl(&path).unwrap().unwrap();

        // 保证 mtime 一定不同：同一个文件系统时间戳粒度可能是 100ns，先等一下再写
        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::write(&path, b"bbbbb").expect("改写（同长度）");
        let after = file_version_impl(&path).unwrap().unwrap();

        assert_eq!(before.split(':').next(), after.split(':').next(), "前置：两次长度相同");
        assert_ne!(before, after, "同长度改写必须换令牌（否则 CAS 形同虚设）");
    }

    #[test]
    fn version_changes_when_size_changes() {
        let path = temp_path("grow");
        std::fs::write(&path, b"a").expect("写文件");
        let before = file_version_impl(&path).unwrap().unwrap();
        std::fs::write(&path, b"a-much-longer").expect("改写");
        let after = file_version_impl(&path).unwrap().unwrap();
        assert_ne!(before, after);
    }
}

/// 第 94 波：`append_file` 的**换行守卫**（真实数据丢失那个缺陷的判据）。
///
/// 判据形态就是交接单 §3.4 里写的那一条：**写 2 条完整行 + 半截尾行 → 再 append 一条
/// → 断言那条仍然可读**（也就是它没有被粘到残尾上变成"一条坏行里裹着两条记录"）。
///
/// 变异自证：删掉 `if last[0] != b'\n' { file.write_all(b"\n")… }` 那三行 ⇒
/// `appending_after_a_torn_tail_keeps_the_new_record_readable` 必须失败
/// （最后一行会变成 `{"id":"m2",…{"id":"m3",…}`，按行 JSON.parse 全部失败）。
#[cfg(test)]
mod append_file_tests {
    use super::*;

    fn temp_file(name: &str, content: &[u8]) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("codem-append-{}-{}", name, std::process::id()));
        std::fs::create_dir_all(&dir).expect("建临时目录");
        let path = dir.join("session.jsonl");
        std::fs::write(&path, content).expect("写临时文件");
        path
    }

    /// 把文件按行切开，**逐行** JSON.parse —— 这就是读侧的判据（坏行会被丢掉）。
    fn parsed_ids(path: &std::path::Path) -> (Vec<String>, usize) {
        let raw = std::fs::read_to_string(path).expect("读回文件");
        let mut ids = Vec::new();
        let mut bad = 0usize;
        for line in raw.lines().filter(|l| !l.trim().is_empty()) {
            match serde_json::from_str::<serde_json::Value>(line) {
                Ok(v) => match v.get("id").and_then(|x| x.as_str()) {
                    Some(id) => ids.push(id.to_string()),
                    None => bad += 1,
                },
                Err(_) => bad += 1,
            }
        }
        (ids, bad)
    }

    /// 反向对照：干净文件（以换行结尾）上追加 —— 不能因为加了守卫就多出空行/多写字节。
    #[test]
    fn appending_to_a_clean_file_stays_line_separated() {
        let path = temp_file("clean", b"{\"id\":\"m1\"}\n{\"id\":\"m2\"}\n");
        append_file_impl(&path, "{\"id\":\"m3\"}").expect("追加必须成功");
        let (ids, bad) = parsed_ids(&path);
        assert_eq!(bad, 0, "干净文件上追加不该产生坏行");
        assert_eq!(ids, vec!["m1", "m2", "m3"]);
        let raw = std::fs::read_to_string(&path).unwrap();
        assert_eq!(raw, "{\"id\":\"m1\"}\n{\"id\":\"m2\"}\n{\"id\":\"m3\"}\n", "逐字节形状");
    }

    /// **主判据**：文件尾是半截行（没有换行）时，新追加的记录必须**自成一行且可读**。
    #[test]
    fn appending_after_a_torn_tail_keeps_the_new_record_readable() {
        // 2 条完整行 + 1 条崩溃留下的半截尾行（没有结尾换行）
        let path = temp_file(
            "torn",
            b"{\"id\":\"m1\"}\n{\"id\":\"m2\"}\n{\"id\":\"m3\",\"conte",
        );
        append_file_impl(&path, "{\"id\":\"m4\"}").expect("追加必须成功");

        let raw = std::fs::read_to_string(&path).unwrap();
        // 残尾自己仍然是坏行（该丢），但它**不能**把 m4 拖下水
        let lines: Vec<&str> = raw.lines().filter(|l| !l.trim().is_empty()).collect();
        assert_eq!(lines.len(), 4, "补了换行之后新记录应当独占一行；实际：{raw:?}");
        assert_eq!(lines[2], "{\"id\":\"m3\",\"conte", "残尾保持原样（不伪造它完整）");
        assert_eq!(lines[3], "{\"id\":\"m4\"}", "新记录必须自成一行");

        let (ids, bad) = parsed_ids(&path);
        assert_eq!(bad, 1, "只有那一条残尾是坏行");
        assert_eq!(ids, vec!["m1", "m2", "m4"], "**m4 必须仍然可读**（旧实现里它会和残尾粘成一条坏行，被永久丢掉）");
    }

    /// 空文件 / 只有一条记录：不该多补换行（否则每行前面多一个空行）。
    #[test]
    fn empty_and_single_line_files_are_not_padded() {
        let empty = temp_file("empty", b"");
        append_file_impl(&empty, "{\"id\":\"a\"}").expect("空文件追加");
        assert_eq!(std::fs::read_to_string(&empty).unwrap(), "{\"id\":\"a\"}\n");

        let single = temp_file("single", b"{\"id\":\"a\"}");
        append_file_impl(&single, "{\"id\":\"b\"}").expect("无换行尾追加");
        assert_eq!(std::fs::read_to_string(&single).unwrap(), "{\"id\":\"a\"}\n{\"id\":\"b\"}\n");
    }

    /// **连追加**：多字节 UTF-8 内容也不许被切开（残尾可能正好停在一个多字节字符中间）。
    #[test]
    fn repeated_appends_survive_multibyte_content() {
        let path = temp_file("utf8", "{\"id\":\"m1\",\"content\":\"中文内容\"}".as_bytes());
        for i in 2..5 {
            append_file_impl(&path, &format!("{{\"id\":\"m{i}\",\"content\":\"中文 {i}\"}}")).expect("追加");
        }
        let (ids, bad) = parsed_ids(&path);
        assert_eq!(bad, 0, "整条写入的记录不该产生坏行");
        assert_eq!(ids, vec!["m1", "m2", "m3", "m4"]);
    }

    // ========== 第 181 波（T-3）：截断诊断的**精确计数** ==========

    fn lines_file(name: &str, content: &str) -> String {
        let dir = std::env::temp_dir().join(format!("codem-lines-{}-{}", name, std::process::id()));
        std::fs::create_dir_all(&dir).expect("建临时目录");
        let path = dir.join("f.txt");
        std::fs::write(&path, content).expect("写文件");
        path.to_string_lossy().to_string()
    }

    /// 判据 1：`dropped_lines` / `dropped_chars` 必须与"全量读一遍再数"**逐条相符**。
    ///
    /// ⚠️ **判据设计踩过的坑（第一版在这里假绿，记档）**：
    /// 最早的样例每行只有 1 个字符、且期望值是用**同一套代数**从 `kept` 推出来的
    /// （`total - kept.len()`）—— 那是个恒等式：无论实现有没有统计"被 offset 跳过的行"，
    /// 两边都一起变，**永远相等**。于是变异（把 offset 分支的计数删掉）**不咬**。
    ///
    /// 修法两条：① 用**长度不等**的行（丢 3 个 1 字符行与丢 3 个 10 字符行，
    /// 字符数差得很明显）；② 期望值**独立硬编码**（直接写死数字），不再从 `kept` 推。
    #[test]
    fn dropped_counts_match_a_full_read() {
        // 行内容刻意不等长：`a`(1) / `bb`(2) / `ccc`(3) / `dddd`(4) / `eeeee`(5)
        let content = "a\nbb\nccc\ndddd\neeeee\n";
        // (名字, offset, limit, 期望: total, dropped_lines, dropped_chars, has_more)
        let cases: Vec<(&str, usize, usize, usize, usize, usize, bool)> = vec![
            // 从第 1 行读 3 行 ⇒ 丢 dddd(4) + eeeee(5) = 2 行 / 9 字符；后面还有 ⇒ has_more
            ("head", 1, 3, 5, 2, 9, true),
            // 从第 4 行读到尾 ⇒ **丢 1 字符 + 2 + 3 = 6 字符**（全部来自 offset 跳过）；
            // 后面没有了 ⇒ has_more=false —— 这一格专门咬"offset 分支没计数"
            ("tail", 4, 2, 5, 3, 6, false),
            // 中间一段：丢 a(1) + eeeee(5) = 2 行 / 6 字符
            ("middle", 2, 3, 5, 2, 6, true),
            // 全读 ⇒ 一个都不丢
            ("all", 1, 5, 5, 0, 0, false),
        ];
        for (name, offset, limit, total, dropped_lines, dropped_chars, has_more) in cases {
            let path = lines_file(name, content);
            let got = read_file_lines_impl(&path, offset, limit, 100_000).expect("读失败");
            assert_eq!(got.total_lines, total, "{name}: 总行数");
            assert_eq!(got.dropped_lines, dropped_lines, "{name}: 丢弃行数");
            assert_eq!(got.dropped_chars, dropped_chars, "{name}: 丢弃字符数");
            assert_eq!(got.has_more, has_more, "{name}: has_more = 返回范围之后还有行");
        }
    }

    /// 判据 1b：返回文本本身也要对（带 `N: ` 行号前缀、且按 offset 对齐）。
    #[test]
    fn returned_text_carries_line_numbers_from_offset() {
        let path = lines_file("textshape", "a\nbb\nccc\n");
        let got = read_file_lines_impl(&path, 2, 2, 100_000).expect("读失败");
        assert_eq!(got.text, "2: bb\n3: ccc", "行号必须从 offset 开始且 1-indexed");
    }

    /// 判据 2：**恰好读满**（limit == 总行数）时不许报"还有更多"、丢弃数必须为 0。
    ///
    /// 反向对照：这是最容易 off-by-one 的那一格（把"读完了"报成"还有很多"，
    /// 模型就会白翻一页）。
    #[test]
    fn reading_everything_reports_nothing_dropped() {
        let path = lines_file("all", "1\n2\n3\n");
        let got = read_file_lines_impl(&path, 1, 3, 100_000).expect("读失败");
        assert_eq!(got.total_lines, 3);
        assert!(!got.has_more, "全读完了不该说还有更多");
        assert_eq!(got.dropped_lines, 0, "全读完了丢弃数必须是 0");
        assert_eq!(got.dropped_chars, 0, "全读完了丢弃字符数必须是 0");
    }

    /// 判据 3：**按字符上限截断**时，丢弃计数要把"没装下的那些行"也算进去。
    ///
    /// 改前这一支直接 `break` ⇒ 连 `total_lines` 都停在截断处（模型看到"共 2 行"，
    /// 而文件其实有几百行）。这条判据同时钉住那个老缺口。
    #[test]
    fn max_chars_truncation_still_counts_everything() {
        let content = (1..=50).map(|i| format!("line-{i}")).collect::<Vec<_>>().join("\n");
        let path = lines_file("maxchars", &content);
        // 给一个只装得下前几行的字符预算
        let got = read_file_lines_impl(&path, 1, 1000, 60).expect("读失败");
        assert_eq!(got.total_lines, 50, "总行数必须是**整个文件**的，不是截断处的");
        assert!(got.has_more, "被 max_chars 截断也算还有更多");
        assert_eq!(
            got.dropped_lines,
            50 - got.text.lines().count(),
            "丢弃行数 = 总行数 - 实际返回行数"
        );
        assert!(got.dropped_chars > 0, "丢弃字符数必须为正");
    }

    // ========== 第 181 波（T-4）：对"全量参照算法"的差分测试 ==========

    /**
     * **全量参照实现**（与生产实现完全独立的一条路）。
     *
     * 它按最朴素的方式做：整个文件读成字符串 → 按 `\n` 切开 → 取 `[offset-1, +limit)` →
     * 加 `N: ` 前缀 → 数总计/丢弃。生产实现是流式、有字符预算、逐行 number 的，
     * 两者的**可观测结果必须逐字节相等**。
     *
     * 这就是 Pi `tools-read-differential.test.ts` 的手法：手写几个用例挡不住
     * "行号错位 / 差一" 这类缺陷，只有一个**独立参照实现**能挡住。
     */
    fn reference_read(content: &str, offset: usize, limit: usize) -> (String, usize, usize, usize) {
        /**
         * 空文件 = **0 行**（没有行可以编号）。
         *
         * 这一条是差分测试**当场咬出来**的契约边界：参照实现第一版按
         * `split('\n')` 得到 `[""]` 就算 1 行，而生产实现（`BufRead::lines()` 一行都读不到）
         * 给 0 —— 两边对"空文件有几行"理解不同。**0 才是对的**（与"结尾换行不额外算一行"
         * 同一套直觉：行是"有内容的行"）。
         */
        if content.is_empty() {
            return (String::new(), 0, 0, 0);
        }
        let all: Vec<&str> = content.split('\n').collect();
        // 尾部空串 = 文件以 \n 结尾 ⇒ 不额外算一行（与 BufRead::lines() 一致）
        let all = if content.ends_with('\n') && all.len() > 1 {
            &all[..all.len() - 1]
        } else {
            &all[..]
        };
        let total = all.len();
        let start = offset.saturating_sub(1).min(total);
        let end = (start + limit).min(total);
        let text = all[start..end]
            .iter()
            .enumerate()
            .map(|(i, l)| format!("{}: {}", start + i + 1, l.trim_end_matches('\r')))
            .collect::<Vec<_>>()
            .join("\n");
        let dropped_lines = total - (end - start);
        /**
         * 字符数按**行内容**计（不含行尾）：CRLF 的 `\r` 不算。
         *
         * 这也是差分测试咬出来的：参照实现第一版直接用 `split('\n')` 的切片，
         * 于是 CRLF 行会把自己那个 `\r` 算进去，而生产实现走 `BufRead::lines()`
         * （它会把 `\r\n` 归一成 `\n`）⇒ 两边差一个字符/行。按行内容计才与
         * "模型看到的内容"一致 —— 行号前缀后面跟的就是归一化后的内容。
         */
        let dropped_chars = all[..start]
            .iter()
            .chain(all[end..].iter())
            .map(|l| l.trim_end_matches('\r').chars().count())
            .sum::<usize>();
        (text, total, dropped_lines, dropped_chars)
    }

    /// 判据 4：**差分测试** —— 生产实现 vs 全量参照，参数与内容都造到边界。
    ///
    /// 覆盖：多字节中文/emoji、超长行、CRLF、以/不以换行结尾、空文件、offset 超界、
    /// offset=0、limit=0、offset+limit 越界。`max_chars` 给足（不触发预算），
    /// 好让这一条只考"行选择与计数"这一件事。
    #[test]
    fn bounded_read_matches_the_full_file_reference() {
        let contents = [
            "a\nbb\nccc\n",
            "1\n2\n3\n4\n5",
            "",
            "\n",
            "中文行\nemoji 😀 行\n第三行\n",
            "CRLF\r\n第二行\r\n第三行\r\n",
            &format!("{}\nshort\n", "x".repeat(5000)),
            "tab\tseparated\nline2\n",
        ];
        let offsets = [0usize, 1, 2, 3, 99];
        let limits = [0usize, 1, 3, 99];
        let mut checked = 0usize;
        for (ci, content) in contents.iter().enumerate() {
            let path = lines_file(&format!("diff{ci}"), content);
            for offset in offsets {
                for limit in limits {
                    // 生产实现要求 offset >= 1（命令层会 `.max(1)`）
                    let eff_offset = offset.max(1);
                    let got = read_file_lines_impl(&path, eff_offset, limit, 1_000_000).expect("读失败");
                    let (text, total, dropped_lines, dropped_chars) =
                        reference_read(content, eff_offset, limit);
                    let what = format!("内容#{ci}({content:?}) offset={offset} limit={limit}");
                    assert_eq!(got.text, text, "{what}: 返回文本");
                    assert_eq!(got.total_lines, total, "{what}: 总行数");
                    assert_eq!(got.dropped_lines, dropped_lines, "{what}: 丢弃行数");
                    assert_eq!(got.dropped_chars, dropped_chars, "{what}: 丢弃字符数");
                    checked += 1;
                }
            }
        }
        assert!(checked >= 100, "差分规模太小（{checked} 组）—— 判据会变成摆设");
    }
}

/// 第 183 波（有界读改字节扫描）的 UTF-8 边界判据。
///
/// 字节扫描版**只对返回窗口**做 UTF-8 校验 ⇒ 窗口内严格、窗口外宽容。
/// 这两条一起把"有意放宽的那一条"钉住，免得后人以为漏了校验。
#[cfg(test)]
mod bounded_read_utf8_tests {
    use super::*;

    /// 判据 5：**窗口内**的非 UTF-8 必须报错（与改前一致）。
    #[test]
    fn invalid_utf8_inside_the_window_still_errors() {
        let dir = std::env::temp_dir().join(format!("codem-utf8-{}-a", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("bad.txt");
        let mut bytes = b"bad \xFF line\ngood line\n".to_vec();
        bytes.extend_from_slice(b"third\n");
        std::fs::write(&path, &bytes).unwrap();

        let err = read_file_lines_impl(path.to_str().unwrap(), 1, 10, 100_000).unwrap_err();
        assert!(err.contains("非 UTF-8"), "窗口内非法字节必须报错：{err}");
        let _ = std::fs::remove_file(&path);
    }

    /// 判据 6：**窗口外**的非 UTF-8 **不再**让整次读取失败（有意放宽，见实现文档）。
    #[test]
    fn invalid_utf8_outside_the_window_is_tolerated() {
        let dir = std::env::temp_dir().join(format!("codem-utf8-{}-b", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("tailbad.txt");
        let mut bytes = b"good one\ngood two\n".to_vec();
        bytes.extend_from_slice(b"bad \xFF tail\n");
        std::fs::write(&path, &bytes).unwrap();

        let got = read_file_lines_impl(path.to_str().unwrap(), 1, 2, 100_000)
            .expect("窗口外非法字节不该让读取失败");
        assert_eq!(got.total_lines, 3, "总行数照常统计");
        assert_eq!(got.text, "1: good one\n2: good two");
        assert_eq!(got.dropped_lines, 1, "非法字节那行计入丢弃");
        assert!(got.has_more, "后面还有行 ⇒ has_more");
        let _ = std::fs::remove_file(&path);
    }
}

/// ★ 第 185 波判据：R1（glob 环/深度/结果上限）、R2（退出时抢不到锁不许静默）、
/// R3（execute_command 读取期上限 + 超时不留读线程）、R4（.cmd 引号与"真程序起没起"）、
/// R5（workspace 沙箱的真判定）。
///
/// 每条判据都对应一个**改前会红**的事实；把对应的修复改坏，这一条必须变红
/// （变异自证记录见本轮交接报告）。
#[cfg(test)]
mod harden_185_tests {
    use super::*;

    /// 独立的临时目录（每个判据一个，避免互相干扰）。
    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("codem-185-{}-{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("建临时目录");
        dir
    }

    // ==================== R1 ====================

    /// 极深目录：深度上限必须真的生效（函数返回、更深的文件不被算进来，且**如实标记**）。
    #[test]
    fn r1_depth_cap_stops_the_walk() {
        let root = scratch("deep");
        let mut deep = root.clone();
        for _ in 0..12 {
            deep = deep.join("a");
        }
        std::fs::create_dir_all(&deep).expect("建 12 层目录");
        std::fs::write(deep.join("deep.txt"), b"x").unwrap();
        std::fs::write(root.join("shallow.txt"), b"x").unwrap();

        let capped = glob_search_walk(
            &root,
            "*.txt",
            GlobLimits {
                max_depth: 3,
                max_results: 100,
                offset: 0,
            },
        )
        .expect("必须能返回");
        assert!(capped.depth_limited, "撞到深度上限必须被记下来（不许静默）");
        assert!(
            capped.files.iter().any(|f| f.ends_with("shallow.txt")),
            "浅层命中仍要返回：{:?}",
            capped.files
        );
        assert!(
            !capped.files.iter().any(|f| f.ends_with("deep.txt")),
            "超过深度上限的目录不该被遍历：{:?}",
            capped.files
        );

        // 反向对照：默认上限（生产口径）必须覆盖 12 层 —— 上限不能小到把正常项目切掉
        let full = glob_search_walk(&root, "deep.txt", GlobLimits::default()).expect("必须能返回");
        assert_eq!(
            full.files.len(),
            1,
            "默认深度 {} 必须覆盖 12 层（否则就是「修好了环、弄丢了文件」）",
            GLOB_MAX_DEPTH
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    /// 造一个目录链接/接合点。失败返回 false（环境不支持 ⇒ 判据**明说跳过**）。
    fn try_make_dir_link(target: &std::path::Path, link: &std::path::Path) -> bool {
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt as _;
            // 接合点（/J）不需要管理员权限；`raw_arg` 免得 std 再替我们加一层引号
            let cmdline = format!("/c mklink /J \"{}\" \"{}\"", link.display(), target.display());
            let ok = std::process::Command::new("cmd")
                .raw_arg(&cmdline)
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .map(|s| s.success())
                .unwrap_or(false);
            return ok && std::fs::symlink_metadata(link).is_ok();
        }
        #[cfg(not(target_os = "windows"))]
        {
            std::os::unix::fs::symlink(target, link).is_ok()
        }
    }

    /// **环判据**：自指接合点（本机 `%LOCALAPPDATA%\Application Data` 那种）必须
    /// **不被进入**。改前 `path.is_dir()` 会跟随它 ⇒ 无限递归（先永不返回，再栈溢出 abort）。
    ///
    /// 这里刻意同时断言 `!depth_limited`：环必须由**重解析点跳过**切断，
    /// 而不是"靠深度上限兜住" —— 否则去掉 `is_symlink()` 判断这条判据不会红。
    #[test]
    fn r1_self_referencing_reparse_point_is_not_followed() {
        let root = scratch("loop");
        let inner = root.join("inner");
        std::fs::create_dir_all(&inner).unwrap();
        std::fs::write(inner.join("marker.txt"), b"x").unwrap();

        let link = root.join("loop");
        if !try_make_dir_link(&root, &link) {
            eprintln!("[r1] 本环境无法创建目录链接/接合点 ⇒ 跳过环判据（深度判据仍然覆盖）");
            let _ = std::fs::remove_dir_all(&root);
            return;
        }
        assert!(
            std::fs::symlink_metadata(&link)
                .map(|m| m.file_type().is_symlink())
                .unwrap_or(false),
            "创建出来的必须真的是重解析点（否则这条判据测的是个假东西）"
        );

        let started = std::time::Instant::now();
        let out = glob_search_walk(&root, "*.txt", GlobLimits::default()).expect("必须能返回");
        assert!(
            started.elapsed().as_secs() < 20,
            "环必须被立刻切断（不能靠时间磨）"
        );
        assert!(
            !out.depth_limited,
            "环应当被「跳过重解析点」切断；撞到深度上限说明接合点被**进入了**：{:?}",
            out.files
        );
        let markers = out
            .files
            .iter()
            .filter(|f| f.ends_with("marker.txt"))
            .count();
        assert_eq!(
            markers, 1,
            "接合点没被进入 ⇒ 同一个文件只应出现一次：{:?}",
            out.files
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 结果条数上限：必须有界，且**调用方必须能知道**（改前是无界增长）。
    #[test]
    fn r1_result_cap_truncates_and_tells_the_caller() {
        let root = scratch("cap");
        for i in 0..10 {
            std::fs::write(root.join(format!("f{i}.txt")), b"x").unwrap();
        }
        let out = glob_search_walk(
            &root,
            "*.txt",
            GlobLimits {
                max_depth: 8,
                max_results: 3,
                offset: 0,
            },
        )
        .expect("必须能返回");
        assert_eq!(out.files.len(), 3, "结果必须有界");
        assert!(out.truncated, "撞上限必须被记下来（不许静默）");

        // 调用方必须能知道 —— 而且知道得**够具体**（下一步该怎么做），见 GLOB-LIMIT-1/3。
        let res = glob_result_from(out, &GlobLimitRequest::resolve(Some(3)), 0);
        assert!(res.truncated);
        assert!(
            res.hint.as_deref().unwrap_or("").contains("offset="),
            "截断的 hint 必须给出下一步：{:?}",
            res.hint
        );
        assert!(
            GLOB_MAX_RESULTS >= 1_000 && GLOB_MAX_DEPTH >= 8,
            "生产上限不能小到把正常搜索切掉"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    // ==================== GLOB-LIMIT（第 186 波：截断是数据，不是异常）====================
    //
    // 设计错误的形态（改前）：`glob_search` 的契约是 `Result<Vec<String>, String>`，
    // 超限 ⇒ `Err("... matched more than 20000 entries ...")`。
    // 三重代价：① 调用方**拿不到数据**（批处理超大目录时这个工具直接不可用）；
    // ② "匹配到 2 万+"与"参数写错"被压成同一种输出；③ 没有下一步（`hint`）。
    // 现在：`{ files, truncated, depth_limited, returned, hint }`（见 `GlobSearchResult`）。

    /// 造 `n` 个 `g0000.txt …`，返回（目录，**排序后的文件名**）。
    fn scratch_with_files(name: &str, n: usize) -> (std::path::PathBuf, Vec<String>) {
        let root = scratch(name);
        let mut names = Vec::new();
        for i in 0..n {
            let f = format!("g{i:04}.txt");
            std::fs::write(root.join(&f), b"x").unwrap();
            names.push(f);
        }
        names.sort();
        (root, names)
    }

    /// 只取路径末段（`read_dir` 的顺序不保证，判据要比的是**集合**）。
    fn basenames(files: &[String]) -> Vec<String> {
        let mut v: Vec<String> = files
            .iter()
            .map(|f| f.replace('\\', "/").rsplit('/').next().unwrap_or("").to_string())
            .collect();
        v.sort();
        v
    }

    /// **GLOB-LIMIT-1**：结果数超过 `limit` 时**不报错** ⇒ 回 `limit` 条 + `truncated: true`。
    #[test]
    fn glob_limit_1_over_limit_is_data_not_an_error() {
        let (root, all) = scratch_with_files("limit-1", 10);
        let root_str = root.to_str().unwrap();

        let res = run_glob_search("*.txt", root_str, &root, Some(3), None)
            .expect("★ 超过 limit 不许再返回 Err —— 那只是换个方式卡住（改前就是这个形态）");

        assert_eq!(res.files.len(), 3, "必须**正好**回 limit 条");
        assert_eq!(res.returned, 3, "returned 必须与 files.len() 一致");
        assert!(res.truncated, "超限必须如实说「至少还有更多」");
        assert!(!res.depth_limited, "浅目录不该报深度受限");
        assert_eq!(basenames(&res.files).len(), 3, "名单不许带重复");
        assert!(all.len() > res.returned, "前提：确实有超过 limit 条匹配");

        let hint = res.hint.clone().expect("截断必须给 hint（否则调用方不知道怎么办）");
        assert!(hint.contains("offset=3"), "hint 必须写明下一页的 offset：{hint}");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// **GLOB-LIMIT-2**：`offset` 翻页能**枚举到全部**
    /// —— 两次调用（`offset=0` / `offset=limit`）的并集 == 全量，且第二次 `truncated=false`。
    #[test]
    fn glob_limit_2_offset_pages_through_everything() {
        let (root, all) = scratch_with_files("limit-2", 8);
        let root_str = root.to_str().unwrap();
        let limit = 4usize;

        let first = run_glob_search("*.txt", root_str, &root, Some(limit), Some(0)).unwrap();
        assert_eq!(first.files.len(), 4, "第一页取 limit 条");
        assert!(first.truncated, "还有 4 条没取 ⇒ 必须说「至少还有更多」");

        let second = run_glob_search("*.txt", root_str, &root, Some(limit), Some(limit)).unwrap();
        assert_eq!(second.files.len(), 4, "第二页取剩下的");
        assert!(
            !second.truncated,
            "★ 第二页取完必须如实说「没有了」（改前这里只会得到一句「超限」错误）"
        );

        let mut union = basenames(&first.files);
        union.extend(basenames(&second.files));
        union.sort();
        union.dedup();
        assert_eq!(union.len(), 8, "两页不许重叠：{union:?}");
        assert_eq!(union, all, "★ 两页并集必须 == 全量（翻页真的能枚举全部）");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// **GLOB-LIMIT-3**：`limit` 越界被**夹住**，且 `hint` **如实说明**（静默夹是不许的）。
    #[test]
    fn glob_limit_3_out_of_range_limit_is_clamped_and_said_out_loud() {
        let (root, _all) = scratch_with_files("limit-3", 5);
        let root_str = root.to_str().unwrap();

        // ① 超过上限：夹到 GLOB_LIMIT_MAX，且请求值必须原样出现在 hint 里
        let requested = GLOB_LIMIT_MAX + 12_345;
        let big = run_glob_search("*.txt", root_str, &root, Some(requested), None).unwrap();
        let hint = big
            .hint
            .clone()
            .expect("★ 夹过 limit 就必须给 hint —— 静默夹会让调用方以为真拿到了那么多");
        assert!(hint.contains(&requested.to_string()), "要说明请求了多少：{hint}");
        assert!(
            hint.contains(&GLOB_LIMIT_MAX.to_string()),
            "要说明实际按多少跑：{hint}"
        );
        assert!(!big.truncated, "5 条文件远没到上限");

        // ② 低于下限：夹到 1（不是「回 0 条」那种更隐蔽的失真）
        let zero = run_glob_search("*.txt", root_str, &root, Some(0), None).unwrap();
        assert_eq!(zero.files.len(), 1, "limit=0 必须夹到 {GLOB_LIMIT_MIN}");
        assert!(zero.truncated, "只回 1 条而还有 4 条 ⇒ 必须说还有更多");
        let hint0 = zero.hint.clone().unwrap();
        assert!(hint0.contains("0"), "要说明请求值是 0：{hint0}");
        assert!(hint0.contains("clamped to 1"), "要说明实际夹到 1：{hint0}");

        // ③ 反向对照：**合法** limit 不许被夹（否则 hint 会永远带着一句废话）
        let ok = run_glob_search("*.txt", root_str, &root, Some(5), None).unwrap();
        assert_eq!(ok.files.len(), 5);
        assert!(!ok.truncated);
        assert!(
            ok.hint.is_none(),
            "什么都没发生时不许写空洞的 hint：{:?}",
            ok.hint
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// **GLOB-LIMIT-4**：深度上限与「不跟随重解析点」**仍然生效**，且这次是在**命令入口**上验
    /// （既有判据 `r1_depth_cap_stops_the_walk` / `r1_self_referencing_reparse_point_is_not_followed`
    /// 在 walk 层，一个字都没被削弱；这条把同一事实钉到 `run_glob_search` 的返回上）。
    #[test]
    fn glob_limit_4_depth_cap_and_reparse_points_still_hold() {
        // ① 深度：默认上限必须覆盖 12 层（不许「修好了环、弄丢了文件」）
        let root = scratch("limit-4-deep");
        let mut deep = root.clone();
        for _ in 0..12 {
            deep = deep.join("a");
        }
        std::fs::create_dir_all(&deep).unwrap();
        std::fs::write(deep.join("deep.txt"), b"x").unwrap();
        std::fs::write(root.join("shallow.txt"), b"x").unwrap();
        let root_str = root.to_str().unwrap();

        let ok = run_glob_search("deep.txt", root_str, &root, None, None).unwrap();
        assert_eq!(ok.files.len(), 1, "默认深度必须覆盖 12 层");
        assert!(!ok.depth_limited, "没撞到深度上限就不许报");

        // 撞到深度上限 ⇒ 如实上报（而且是**数据**里的一栏，不是一句错误）
        let capped = glob_search_walk(
            &root,
            "*.txt",
            GlobLimits {
                max_depth: 3,
                max_results: 100,
                offset: 0,
            },
        )
        .unwrap();
        assert!(capped.depth_limited, "撞到深度上限必须被记下来");
        assert!(
            !capped.files.iter().any(|f| f.ends_with("deep.txt")),
            "超过深度上限的目录不该被遍历"
        );
        let res = glob_result_from(capped, &GlobLimitRequest::resolve(None), 0);
        assert!(res.depth_limited, "命令契约里也要如实带上这一栏");
        let hint = res.hint.unwrap_or_default();
        assert!(
            hint.contains(&GLOB_MAX_DEPTH.to_string()),
            "深度受限必须出现在 hint 里（调用方要能据此换更浅的 path）：{hint}"
        );

        // ② 重解析点：命令入口跑一遍环，同一个文件只应出现一次，且**不是**靠深度上限兜住的
        let loop_root = scratch("limit-4-loop");
        let inner = loop_root.join("inner");
        std::fs::create_dir_all(&inner).unwrap();
        std::fs::write(inner.join("marker.txt"), b"x").unwrap();
        if try_make_dir_link(&loop_root, &loop_root.join("loop")) {
            let out = run_glob_search(
                "*.txt",
                loop_root.to_str().unwrap(),
                &loop_root,
                None,
                None,
            )
            .unwrap();
            assert!(
                !out.depth_limited,
                "环必须被「跳过重解析点」切断（撞深度上限说明接合点被进入了）：{:?}",
                out.files
            );
            assert_eq!(
                out.files.iter().filter(|f| f.ends_with("marker.txt")).count(),
                1,
                "接合点没被进入 ⇒ 同一个文件只应出现一次：{:?}",
                out.files
            );
        } else {
            eprintln!("[GLOB-LIMIT-4] 本环境无法创建目录链接/接合点 ⇒ 环这一半跳过（walk 层判据仍覆盖）");
        }
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&loop_root);
    }

    // ==================== R2 ====================

    /// **不许静默**：抢不到 MCP 进程表锁时必须重试，失败后必须留下"没收到"的日志，
    /// 并且**不许**出现"已回收"这种谎报。
    #[test]
    fn r2_mcp_shutdown_never_gives_up_silently() {
        // ① 一直抢不到 ⇒ 必须把重试预算用完（改前是一次 try_lock 就 `return`）
        let mut tries = 0;
        let got = drain_mcp_handles_with(4, std::time::Duration::from_millis(1), || {
            tries += 1;
            None
        });
        assert!(got.is_none());
        assert_eq!(tries, 4, "抢不到锁必须重试，而不是第一次就放弃");

        // ② 这个结局**必须**有日志，而且必须如实说"没收到"
        let busy = mcp_shutdown_log_line(&McpShutdownOutcome::LockBusy)
            .expect("抢不到锁必须留下日志（改前是静默 return）");
        assert_eq!(busy.0, "WARN", "必须是 WARN 级");
        assert!(
            busy.1.contains("没能回收"),
            "必须如实说没收到：{}",
            busy.1
        );
        assert!(
            !busy.1.contains("已回收"),
            "不许谎报收干净：{}",
            busy.1
        );

        // ③ 真的收到时要如实说收到几棵
        let reaped = mcp_shutdown_log_line(&McpShutdownOutcome::Reaped(2)).expect("收到也要记");
        assert_eq!(reaped.0, "INFO");
        assert!(reaped.1.contains('2'), "{}", reaped.1);

        // ④ 前面抢不到、后面抢到 ⇒ 句柄必须真的拿到（重试得有实际意义）
        let mut tries2 = 0;
        let got2 = drain_mcp_handles_with(5, std::time::Duration::from_millis(1), || {
            tries2 += 1;
            if tries2 < 3 {
                None
            } else {
                Some(vec![("srv".to_string(), Some(4321))])
            }
        })
        .expect("重试之后应当抢到");
        assert_eq!(got2, vec![("srv".to_string(), Some(4321))]);
        assert_eq!(tries2, 3);

        // ⑤ "表是空的"与"抢不到锁"是两件不同的事，不能混成一个结局
        assert_ne!(McpShutdownOutcome::NothingToDo, McpShutdownOutcome::LockBusy);
        assert!(mcp_shutdown_log_line(&McpShutdownOutcome::NothingToDo).is_none());
    }

    // ==================== R3 ====================

    /// 读取阶段就有上限（改前 `read_to_end` 全量进内存，截断发生在 join 之后），
    /// 并且截断要**如实标注 + 给出真实总量**。
    #[test]
    fn r3_exec_output_reading_is_bounded_and_marks_truncation() {
        let data = vec![b'x'; 100_000];
        let mut cursor = std::io::Cursor::new(data);
        let flag = std::sync::atomic::AtomicBool::new(false);
        let (kept, total) = read_stream_bounded(&mut cursor, 1_000, &flag);
        assert_eq!(
            kept.len(),
            1_000,
            "读取阶段就必须截住（改前这里是 100000 字节全进内存）"
        );
        assert_eq!(total, 100_000, "真实总量必须留下来（否则没法如实标注）");

        let rendered = render_stream_bounded(&kept, total, "stdout");
        assert!(rendered.contains("truncated"), "必须标注被截断：{rendered}");
        assert!(
            rendered.contains("100000"),
            "必须给出真实总量（只说'截断了'不够）：{rendered}"
        );

        // 没截断时**不许**冒出标记（假截断同样是假事实）
        assert_eq!(render_stream_bounded(b"hello", 5, "stdout"), "hello");
    }

    /// 超时路径：置 `abandon` 后读线程必须立刻收手；`join_thread_within` 到点返回 `None`
    /// （调用方据此如实记 WARN，而不是假装线程结束了）。
    #[test]
    fn r3_abandoned_reader_stops_immediately() {
        let mut cursor = std::io::Cursor::new(vec![b'y'; 50_000]);
        let flag = std::sync::atomic::AtomicBool::new(true);
        let (kept, total) = read_stream_bounded(&mut cursor, 10_000, &flag);
        assert!(
            kept.is_empty() && total == 0,
            "已放弃的读线程不许继续累积：{} 字节 / total={}",
            kept.len(),
            total
        );

        let slow = std::thread::spawn(|| {
            std::thread::sleep(std::time::Duration::from_millis(300));
        });
        assert!(
            join_thread_within(slow, std::time::Duration::from_millis(20)).is_none(),
            "没结束的线程必须返回 None"
        );
        let quick = std::thread::spawn(|| 7u32);
        assert_eq!(
            join_thread_within(quick, std::time::Duration::from_millis(500)),
            Some(7)
        );
    }

    /// **端到端**：改过读取路径之后，命令仍然能跑、输出仍然正确，且超限时**如实标注**。
    #[cfg(target_os = "windows")]
    #[tokio::test]
    async fn r3_execute_command_still_works_and_marks_truncation() {
        let ok = execute_command("Write-Output 'hello-185'".to_string(), None, Some(30_000))
            .await
            .expect("普通命令必须成功");
        assert_eq!(ok["stdout"].as_str().unwrap().trim(), "hello-185");
        assert_eq!(ok["exitCode"].as_i64(), Some(0));

        // 约 160 KB 输出（> 50 KB 上限）：必须出现**带真实总量**的截断标注
        let big = execute_command(
            "1..4000 | ForEach-Object { 'x' * 40 }".to_string(),
            None,
            Some(120_000),
        )
        .await
        .expect("大量输出的命令也必须成功返回");
        let stdout = big["stdout"].as_str().unwrap();
        assert!(
            stdout.contains("stdout truncated: kept") && stdout.contains("bytes total"),
            "超限必须如实标注：{}",
            &stdout[..200.min(stdout.len())]
        );
    }

    /// **超时路径端到端**：必须及时返回明确错误（而不是等命令自己跑完）。
    #[cfg(target_os = "windows")]
    #[tokio::test]
    async fn r3_execute_command_timeout_returns_error_promptly() {
        let started = std::time::Instant::now();
        let err = execute_command(
            "Write-Output 'start'; Start-Sleep -Seconds 30; Write-Output 'end'".to_string(),
            None,
            Some(1_000),
        )
        .await
        .expect_err("超时必须返回错误");
        assert!(err.contains("timed out"), "{err}");
        assert!(
            started.elapsed().as_secs() < 20,
            "超时必须及时返回（实际 {:?}）",
            started.elapsed()
        );
    }

    /// R7：stat 失败必须是**未知**（`None`），不能伪装成"0 字节空文件"。
    #[test]
    fn r7_file_size_helper_reports_unknown_instead_of_zero() {
        let err = std::io::Error::new(std::io::ErrorKind::PermissionDenied, "denied");
        assert_eq!(
            file_size_or_unknown(Err(err)),
            None,
            "stat 失败必须返回 None（未知），不能写 0"
        );
        let dir = scratch("size");
        let file = dir.join("a.bin");
        std::fs::write(&file, b"12345").unwrap();
        assert_eq!(
            file_size_or_unknown(std::fs::metadata(&file)),
            Some(5),
            "读得到就如实给大小"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ==================== R4（第 186 波后：判定 + wrapper 文本） ====================

    /// 引用：含空格的路径必须整体被引用（改前 cmd 把 `C:\Program` 当命令 ⇒ 假成功）。
    ///
    /// 第 186 波改口径：引用不再发生在"我们给 `cmd /c` 的那一整行"上，而是发生在
    /// **wrapper 正文**里（`cmd_wrapper_text`）。判据因此直接断言 wrapper 正文。
    #[test]
    fn r4_cmd_args_are_quoted_in_the_wrapper() {
        let text = cmd_wrapper_text(
            r"C:\Program Files\x.cmd",
            &[r"C:\Program Files\node.exe".to_string(), "plain".to_string()],
        );
        assert!(
            text.contains(r#""C:\Program Files\x.cmd" "C:\Program Files\node.exe" "plain""#),
            "每个 token 都必须整体被引用（含空格路径不许被空格截断）：{text:?}"
        );
        assert!(text.starts_with("@echo off\r\n"), "必须 @echo off（否则回显污染 MCP stdout）：{text:?}");
        assert!(text.ends_with("\r\n"), "必须是 CRLF 行尾（批处理口径）：{text:?}");
    }

    /// wrapper 里**不许有落在引号外的元字符**（`&`/`|`/`^`/`<`/`>`），
    /// 且 `%` / `!` / `"` 这些"跨层说不清"的字符必须**被拒绝**而不是被"聪明转义"。
    #[test]
    fn r4_no_metacharacter_can_escape_the_wrapper_quotes() {
        /// 按 cmd 的引号状态机扫一遍：返回落在**引号外**的元字符。
        fn unquoted_metachars(text: &str) -> Vec<char> {
            let mut out = Vec::new();
            let mut in_quotes = false;
            for c in text.chars() {
                match c {
                    '"' => in_quotes = !in_quotes,
                    '&' | '|' | '<' | '>' | '^' if !in_quotes => out.push(c),
                    _ => {}
                }
            }
            assert!(!in_quotes, "引号必须成对（否则边界会漂到参数之外）：{text:?}");
            out
        }

        let nasty = vec![
            "a & calc.exe".to_string(),
            "b | whoami".to_string(),
            "c ^ & del".to_string(),
            r"C:\Program Files\node.exe".to_string(),
            r"C:\dir\".to_string(),
        ];
        let spec = build_cmd_wrapper(r"C:\Program Files\x.cmd", &nasty).expect("这些都该可证");
        assert!(
            unquoted_metachars(&spec.text).is_empty(),
            "有元字符落在引号外 ⇒ 会被 cmd 执行：{:?}",
            spec.text
        );

        // `%` / `!` / `"` 一律拒绝（不是"中性化"）：错因必须点名，且不许被静默改写。
        let err = build_cmd_wrapper(r"C:\x.cmd", &["%EVIL%".to_string()]).unwrap_err();
        assert!(err.contains("第 1 个参数"), "必须点名第几个参数：{err}");
        assert!(err.contains("百分号"), "必须说清是 `%`：{err}");
        let err = build_cmd_wrapper(r"C:\x.cmd", &["a!b!c".to_string()]).unwrap_err();
        assert!(err.contains("感叹号"), "必须说清是 `!`：{err}");
        let err = build_cmd_wrapper(r"C:\x.cmd", &[r#"d" & calc.exe"#.to_string()]).unwrap_err();
        assert!(err.contains("双引号"), "必须说清是 `\"`：{err}");

        // 反向对照：**不许**出现"把 `%` 翻倍后放行"这种中间态
        assert!(
            build_cmd_wrapper(r"C:\x.cmd", &["a%%b".to_string()]).is_err(),
            "任何 `%` 都不许被放行（`%%` 的折叠语义跨层说不清）"
        );
    }

    /// 合法实参**一字不许改**：`&`/`|`/`^`/空格/中文/结尾反斜杠在 wrapper 正文里必须原样出现
    /// （只允许"结尾反斜杠翻倍"这一处、且有理由的改写）。
    #[test]
    fn r4_legal_args_are_not_rewritten() {
        let args = vec![
            "a & b".to_string(),
            "c | d".to_string(),
            "e ^ f".to_string(),
            "g h".to_string(),
            "中文参数".to_string(),
        ];
        let spec = build_cmd_wrapper("x.cmd", &args).expect("这些都该可证");
        for a in &args {
            assert!(spec.text.contains(a), "合法实参被改形了（{a}）：{:?}", spec.text);
        }
        // 结尾反斜杠：必须翻倍（否则会把收尾引号转义掉）
        assert_eq!(quote_cmd_arg_for_wrapper(r"C:\dir\"), r#""C:\dir\\""#);
        assert_eq!(quote_cmd_arg_for_wrapper("plain"), r#""plain""#);
        assert_eq!(quote_cmd_arg_for_wrapper(""), r#""""#);
    }

    /// 命令路径本身也不能有"会在 wrapper 行里炸掉"的字符（点名字符位置）。
    #[test]
    fn r4_command_path_is_preflighted_too() {
        let err = build_cmd_wrapper(r#"C:\a"b\x.cmd"#, &[]).unwrap_err();
        // `C:\a"b\x.cmd` 里 `"` 是第 5 个字符（1-based）
        assert!(err.contains("命令路径第 5 个字符"), "必须点名第几号字符：{err}");
        let err = build_cmd_wrapper("", &[]).unwrap_err();
        assert!(err.contains("命令为空"), "{err}");
    }

    /// 探测结论：cmd 壳立刻退出时**不许报成功**，且要把 cmd 自己的错误带给调用方。
    #[test]
    fn r4_probe_verdict_refuses_to_report_success() {
        let msg = cmd_probe_verdict(
            r"C:\Program Files\x.cmd",
            Some(1),
            r"'C:\Program' 不是内部或外部命令，也不是可运行的程序",
        );
        assert!(msg.contains("没有真正启动"), "{msg}");
        assert!(msg.contains("exit=Some(1)"), "退出码必须带上：{msg}");
        assert!(
            msg.contains("不是内部或外部命令"),
            "cmd 自己的错误必须带给调用方（否则用户无从修）：{msg}"
        );
        assert!(msg.contains("command=「C:\\Program Files\\x.cmd」"), "{msg}");
    }

    // （第 185 波那条"含空格路径的 `.cmd` 端到端"已搬进 `harden_186_tests`：
    //   那边是同一件事的**新口径**版本 —— 走 wrapper 而不是"拼整行"。
    //   这里不再保留旧写法的副本，避免"同一判据两份实现互相打架"。）

    // ==================== R4-186：真 cmd.exe 端到端判据表 ====================
    //
    // 判据口径（重点）：**不测"我们拼出来的字符串长什么样"**（那是判据与实现互相证明的
    // 假绿形态），而是真的起 `cmd.exe /d /s /c ""<wrapper>""`，让 wrapper 把目标
    // （`.cmd` → `.exe`）拉起来，再检查**目标进程自己的 argv** 是否逐字节等于输入。
    //
    // 目标进程是一个只有 `main` 的小探针（`probe-src/argv_probe.rs`），判据**现场用
    // `rustc` 编它**（见 `build_probe`）⇒ 不引入 node/python 依赖、也不依赖
    // "先跑过 `cargo build --bins`"，但整条链与生产同形。
    mod harden_186_tests {
        use super::scratch;
        use super::*;

        /// 目标进程 argv 的逐字节期望表示（与探针 `escape_bytes` 同一口径）。
        fn want_argv(i: usize, s: &str) -> String {
            format!("argv{}={}:{}", i, s.len(), escape_argv_bytes_for_test(s))
        }

        /// 与 `probe-src/argv_probe.rs::escape_bytes` 同一口径（判据侧独立实现一份：
        /// 如果哪天探针的转义口径变了，判据必须跟着红，而不是"两边一起改就永远绿"）。
        fn escape_argv_bytes_for_test(s: &str) -> String {
            let mut out = String::with_capacity(s.len());
            for b in s.as_bytes() {
                if (0x20..0x7f).contains(b) && *b != b'\\' {
                    out.push(*b as char);
                } else {
                    out.push_str(&format!("\\x{:02X}", b));
                }
            }
            out
        }

        /// 现场把 argv 探针编译出来（每个测试进程只编一次，多个判据共用）。
        ///
        /// 用 `rustc` 直编而不是加 `build.rs`：判据自己保证"探针存在且是当前源码编的"，
        /// 不受"`cargo test --lib` 不会顺手构建 bins"这个坑影响。
        ///
        /// 路径**每个进程唯一**（带 pid + 启动纳秒）：固定路径会撞上"上一轮测试留下的
        /// 文件还被占着"⇒ `LNK1104: 无法打开文件`（实测踩到）。
        fn build_probe() -> &'static std::path::Path {
            static PROBE: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();
            PROBE.get_or_init(|| {
                let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("probe-src")
                    .join("argv_probe.rs");
                assert!(src.exists(), "探针源文件必须存在：{}", src.display());
                let nanos = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_nanos())
                    .unwrap_or(0);
                let out = std::env::temp_dir().join(format!(
                    "codem-186-argv-probe-{}-{}.exe",
                    std::process::id(),
                    nanos
                ));
                let st = std::process::Command::new("rustc")
                    .arg("--edition")
                    .arg("2021")
                    .arg("-O")
                    .arg("-o")
                    .arg(&out)
                    .arg(&src)
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::piped())
                    .output()
                    .expect("rustc 必须能起来（判据环境需要 rustc）");
                assert!(
                    st.status.success(),
                    "编译 argv 探针失败：{}",
                    String::from_utf8_lossy(&st.stderr)
                );
                out
            })
        }

        /// 起一个**真的** wrapper：`cmd.exe /d /s /c ""<wrapper>""`（生产那条 raw_arg 路径）。
        async fn run_wrapper(text: &str) -> (std::process::Output, std::path::PathBuf) {
            let path = write_cmd_wrapper(text).expect("写 wrapper");
            let out = tokio::process::Command::new("cmd.exe")
                .arg("/d")
                .arg("/s")
                .arg("/c")
                // 双外层引号正是生产口径：`/s` 剥掉最外层那一对 ⇒ 剩 `"路径"`。
                .raw_arg(format!("\"{}\"", path.display()))
                .output()
                .await
                .expect("cmd 必须能起来");
            (out, path)
        }

        fn read_argv_dump(path: &std::path::Path) -> Vec<String> {
            std::fs::read_to_string(path)
                .unwrap_or_default()
                .lines()
                .map(|s| s.to_string())
                .collect()
        }

        /// 造一个 `.cmd` 启动器：把 `%*` 原样转发给目标 `.exe`（真实 npm cmd-shim 的形态）。
        fn make_shim(dir: &std::path::Path, name: &str, exe: &std::path::Path) -> std::path::PathBuf {            let shim = dir.join(format!("{name}.cmd"));
            std::fs::write(
                &shim,
                format!(
                    "@ECHO off\r\nSETLOCAL\r\nSET \"TARGET_EXE={}\"\r\n\
                     ENDLOCAL & SET \"TARGET_EXE=%TARGET_EXE%\"\r\n\"%TARGET_EXE%\" %*\r\n",
                    exe.display()
                ),
            )
            .expect("写 shim");
            shim
        }

        /// **主判据（判据表逐条）**：真的把 wrapper 跑起来，逐字节比对目标进程的 argv。
        ///
        /// 覆盖判据表里"能保真"的那一半：`&` / `|` / `^` / 空格 / 中文 / 结尾反斜杠 /
        /// `<` `>` `(` `)`；同时跑两跳（`.cmd` shim 用 `%*` 转发的真实形态）。
        #[cfg(target_os = "windows")]
        #[tokio::test]
        async fn r186_hazard_table_is_byte_exact_or_rejected() {
            let dir = scratch("186-table").join("dir with space");
            std::fs::create_dir_all(&dir).unwrap();
            let exe = build_probe();
            let shim = make_shim(&dir, "server shim", &exe);
            let shim_str = shim.display().to_string();

            /*
             * 能保真的实参（每一条都必须逐字节回来）：
             *   - `&` / `|` / `^`：引号内是字面量，不会被当成第二条命令
             *   - `<` `>` `(` `)` `;` `,` `=`：同上
             *   - 空格 / 中文：只验证"没被截断、没被转码"
             *   - 结尾反斜杠：验证"它没把收尾引号吃掉"
             */
            let keep: Vec<&str> = vec![
                "amp & calc.exe",
                "pipe | whoami",
                "caret ^ & del",
                "lt a<b>c gt",
                "paren a(b)c",
                "semi a;b,c=d",
                "two words",
                "中文 参数",
                "trailing C:\\dir\\",
                "empty-ok",
                "",
            ];
            for (idx, arg) in keep.iter().enumerate() {
                let out_file = dir.join(format!("argv-{idx}.txt"));
                // 探针形态：`<exe> <MAGIC> <落盘路径> <实参…>`（见 probe-src/argv_probe.rs）
                let args: Vec<String> = vec![
                    ARGV_DUMP_MAGIC.to_string(),
                    out_file.display().to_string(),
                    (*arg).to_string(),
                    format!("second-{idx}"),
                ];
                let spec = build_cmd_wrapper(&shim_str, &args)
                    .unwrap_or_else(|e| panic!("{arg:?} 应当可证，却被拒绝：{e}"));
                let (out, wrapper) = run_wrapper(&spec.text).await;
                let dump = read_argv_dump(&out_file);
                // 探针把自己的 argv（= 我们传的那两个实参）逐字节写了出来 ⇒ 比对。
                let want = vec![want_argv(0, &args[2]), want_argv(1, &args[3])];
                assert_eq!(
                    dump, want,
                    "实参 {arg:?} 没有逐字节传到目标进程（argv 判据口径）：\nstdout={}\nstderr={}\nwrapper={:?}",
                    String::from_utf8_lossy(&out.stdout),
                    String::from_utf8_lossy(&out.stderr),
                    spec.text
                );
                let _ = std::fs::remove_file(&wrapper);
            }

            /*
             * **证不到保真**的实参（必须如实拒绝，并点名第几个参数）：
             * `%PATH%`（变量形态）、`"`、`!`、CR/LF、以及 `%*` 形态本身。
             */
            let reject: Vec<(&str, &str)> = vec![
                ("%PATH%", "百分号"),
                ("%*", "百分号"),
                ("100%", "百分号"),
                (r"C:\100%\docs", "百分号"),
                (r#"say "hi" now"#, "双引号"),
                ("a!b!c", "感叹号"),
                ("line\r\nbreak", "回车"),
                ("nul\0byte", "NUL"),
            ];
            for (arg, needle) in reject {
                let args: Vec<String> = vec!["first".to_string(), arg.to_string()];
                let err = build_cmd_wrapper(&shim_str, &args)
                    .err()
                    .unwrap_or_else(|| panic!("{arg:?} 证不到逐字节保真，必须拒绝"));
                assert!(
                    err.contains("第 2 个参数"),
                    "错误信息必须点名是第几个参数（{arg:?}）：{err}"
                );
                assert!(err.contains(needle), "错误信息必须说清原因（{arg:?}）：{err}");
                // 反向对照：**不许**留下"改写后放行"的中间态
                assert_eq!(
                    build_cmd_wrapper(&shim_str, &[arg.to_string()]).is_err(),
                    true,
                    "{arg:?} 在任何位置都必须被拒（不许有位置相关的特例）"
                );
            }

            let _ = std::fs::remove_dir_all(dir.parent().unwrap());
        }

        /// **端到端（保留第 185 波那条）**：`.cmd` 真的起来了、`&` 没被当第二条命令。
        ///
        /// 改前是"把整行交 `cmd /c`"；现在改成"生成 wrapper，再交 `cmd /c` 起 wrapper"。
        /// 反向对照仍然保留：**无引号**的旧拼法必须起不来目标（"假成功"的取证）。
        #[cfg(target_os = "windows")]
        #[tokio::test]
        async fn r4_cmd_wrapper_really_starts_a_script_with_spaces() {
            let dir = scratch("cmdspace").join("dir with space");
            std::fs::create_dir_all(&dir).unwrap();
            let script = dir.join("hello.cmd");
            std::fs::write(
                &script,
                "@echo off\r\nsetlocal EnableDelayedExpansion\r\nset \"A=%~1\"\r\necho ARG1=[!A!]\r\n",
            )
            .unwrap();
            let script_str = script.display().to_string();

            // ① 生产口径：wrapper（含空格路径的目标 + 含 & 的实参）
            let spec = build_cmd_wrapper(&script_str, &["a & b".to_string()]).expect("可证");
            let (out, wrapper) = run_wrapper(&spec.text).await;
            let text = String::from_utf8_lossy(&out.stdout);
            assert!(
                text.contains("ARG1=[a & b]"),
                "含空格路径 + 含 & 的 arg 必须原样传到脚本：stdout={text} stderr={}",
                String::from_utf8_lossy(&out.stderr)
            );

            // ② 反向对照：改前的无引号拼法 ⇒ 目标根本没起来（"假成功"的取证）
            let legacy = format!("\"{} {}\"", script_str, "plain");
            let legacy_out = tokio::process::Command::new("cmd.exe")
                .arg("/d")
                .arg("/s")
                .arg("/c")
                .raw_arg(&legacy)
                .output()
                .await
                .expect("对照命令也应当能起来 cmd");
            let legacy_text = String::from_utf8_lossy(&legacy_out.stdout);
            assert!(
                !legacy_text.contains("ARG1="),
                "反向对照失败：无引号拼法居然也起来了目标？{legacy_text}"
            );
            assert!(
                !legacy_out.status.success(),
                "反向对照：无引号拼法必须是非零退出（真程序没启动）"
            );

            let _ = std::fs::remove_file(&wrapper);
            let _ = std::fs::remove_dir_all(dir.parent().unwrap());
        }

        /// **退出码不许失真**：wrapper 结尾的 `exit /b %ERRORLEVEL%` 必须把目标退出码带出来。
        #[cfg(target_os = "windows")]
        #[tokio::test]
        async fn r186_wrapper_propagates_the_exit_code() {
            let dir = scratch("186-exit");
            std::fs::create_dir_all(&dir).unwrap();
            let script = dir.join("fail.cmd");
            std::fs::write(&script, "@echo off\r\nexit /b 17\r\n").unwrap();
            let spec = build_cmd_wrapper(&script.display().to_string(), &[]).expect("可证");
            let (out, wrapper) = run_wrapper(&spec.text).await;
            assert_eq!(
                out.status.code(),
                Some(17),
                "wrapper 必须把目标的退出码带出来（否则「立刻失败」的诊断会失真）：stderr={}",
                String::from_utf8_lossy(&out.stderr)
            );
            let _ = std::fs::remove_file(&wrapper);
            let _ = std::fs::remove_dir_all(&dir);
        }

        /// **生命周期**：wrapper 临时文件必须真的落在受控目录（系统临时目录）里。
        #[test]
        fn r186_wrapper_file_lives_in_the_temp_dir() {
            let spec = build_cmd_wrapper("x.cmd", &[]).expect("可证");
            let path = write_cmd_wrapper(&spec.text).expect("写文件");
            let name = path.file_name().unwrap().to_string_lossy().to_string();
            assert!(
                name.starts_with(CMD_WRAPPER_PREFIX),
                "临时文件必须带可识别的前缀（否则僵尸回收认不出）：{name}"
            );
            assert_eq!(
                path.parent().unwrap(),
                std::env::temp_dir(),
                "必须在受控目录（系统临时目录）里"
            );
            assert_eq!(
                std::fs::read_to_string(&path).unwrap(),
                spec.text,
                "落盘内容必须与纯函数给出的文本一致（不允许写的时候再改一次）"
            );
            let _ = std::fs::remove_file(&path);
        }

        /// **生命周期**：守卫 drop（= spawn 失败 / 探测失败 / 提前 return 那三条路）必须删文件。
        #[test]
        fn r186_wrapper_file_is_removed_when_the_guard_drops() {
            let spec = build_cmd_wrapper("x.cmd", &[]).expect("可证");
            let path = write_cmd_wrapper(&spec.text).expect("写文件");
            assert!(path.exists(), "先确认真的写出来了：{}", path.display());
            {
                let _guard = CmdWrapperFile(path.clone());
                assert!(path.exists(), "守卫活着的时候文件必须在（不能提前删）");
            }
            assert!(
                !path.exists(),
                "守卫 drop 必须删掉 wrapper（失败路径不能留临时文件）：{}",
                path.display()
            );
        }

        /// **生命周期**：成功路径的延迟删除必须真的发生（MCP 是长驻进程 ⇒ 不能"等它退出再删"）。
        #[cfg(target_os = "windows")]
        #[tokio::test]
        async fn r186_wrapper_file_is_removed_after_the_success_delay() {
            let dir = scratch("186-life");
            std::fs::create_dir_all(&dir).unwrap();
            // 目标故意活很久：证明"删 wrapper"不依赖目标退出。
            let sleeper = dir.join("sleep.cmd");
            std::fs::write(&sleeper, "@echo off\r\nping -n 6 127.0.0.1 >nul\r\n").unwrap();
            let spec = build_cmd_wrapper(&sleeper.display().to_string(), &[]).expect("可证");
            let path = write_cmd_wrapper(&spec.text).expect("写文件");

            let mut child = tokio::process::Command::new("cmd.exe")
                .arg("/d")
                .arg("/s")
                .arg("/c")
                .raw_arg(format!("\"{}\"", path.display()))
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
                .expect("spawn");
            assert!(path.exists(), "刚起来的时候文件还要在（cmd 正在读它）");

            schedule_cmd_wrapper_cleanup(path.clone());
            // 上限给足（3 s），只断言"最终必须没了"
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
            while path.exists() && std::time::Instant::now() < deadline {
                tokio::time::sleep(std::time::Duration::from_millis(25)).await;
            }
            assert!(
                !path.exists(),
                "成功路径也必须删 wrapper 临时文件（否则长驻 MCP 会一直攒临时文件）：{}",
                path.display()
            );
            assert!(
                child.try_wait().map(|s| s.is_none()).unwrap_or(false),
                "目标进程此时应当**还在跑**（证明删除与目标退出解耦）"
            );
            let _ = child.kill().await;
            let _ = std::fs::remove_dir_all(&dir);
        }

        /// 僵尸回收的形状：只认带前缀、且**足够老**的文件；新文件一个都不许动
        /// （另一个 Codem 实例可能正在用）。
        #[test]
        fn r186_reaper_does_not_touch_fresh_wrappers() {
            let spec = build_cmd_wrapper("x.cmd", &[]).expect("可证");
            let fresh = write_cmd_wrapper(&spec.text).expect("写文件");
            reap_stale_cmd_wrappers();
            assert!(
                fresh.exists(),
                "刚写出来的 wrapper 绝不能被回收（否则会删掉别的实例正在用的文件）：{}",
                fresh.display()
            );
            let _ = std::fs::remove_file(&fresh);
            // 前缀是回收的唯一凭据 ⇒ 必须够特别
            assert!(
                CMD_WRAPPER_PREFIX.starts_with("codem-"),
                "前缀必须带产品名，避免误伤别人的临时文件"
            );
            // 门槛必须"比一次运行长得多"：这是**故意**保守的取值
            assert!(
                CMD_WRAPPER_STALE_SECS >= 600,
                "回收门槛太小会误删同时运行的实例正在用的文件：{CMD_WRAPPER_STALE_SECS}"
            );
        }

        /// 探针的**参数约定必须是同一个串**：判据直接读探针源文件，
        /// 不靠"两边一起改就永远绿"（改了一边，这条会红）。
        #[test]
        fn r186_probe_source_and_lib_agree_on_the_magic() {
            assert_eq!(ARGV_DUMP_MAGIC, "--codem-argv-dump-186");
            let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("probe-src")
                .join("argv_probe.rs");
            let text = std::fs::read_to_string(&src)
                .unwrap_or_else(|e| panic!("读不到探针源码 {}：{e}", src.display()));
            assert!(
                text.contains(&format!("const ARGV_DUMP_MAGIC: &str = \"{ARGV_DUMP_MAGIC}\";")),
                "探针源码里的魔法串与 lib 侧不一致（判据约定会错位）：{}",
                src.display()
            );
        }

        /// 探针本身**必须真的能报告自己的 argv**（否则上面那条主判据只是在测空文件）。
        /// 反向对照：给错魔法串时它必须什么都不写 —— 那说明这条判据真的在看"探针有没有生效"。
        #[cfg(target_os = "windows")]
        #[test]
        fn r186_probe_really_dumps_its_own_argv() {
            let dir = scratch("186-probe");
            std::fs::create_dir_all(&dir).unwrap();
            let exe = build_probe();
            let good = dir.join("good.txt");
            let st = std::process::Command::new(&exe)
                .arg(ARGV_DUMP_MAGIC)
                .arg(&good)
                .arg("a & b")
                .arg("")
                .status()
                .expect("探针必须能起来");
            assert!(st.success(), "探针正常退出");
            let dump = read_argv_dump(&good);
            assert_eq!(
                dump,
                vec![want_argv(0, "a & b"), want_argv(1, "")],
                "探针必须如实报告自己的 argv（含空实参）"
            );

            // 反向对照：魔法串不对 ⇒ 不写文件
            let bad = dir.join("bad.txt");
            let _ = std::process::Command::new(&exe)
                .arg("--not-the-magic")
                .arg(&bad)
                .output()
                .expect("跑得起来");
            assert!(
                !bad.exists(),
                "魔法串不对时探针不许写文件（否则判据可能在看上一次的残留）"
            );
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    // ==================== R5 ====================

    /// **主判据**：同前缀的兄弟目录必须判**越界**（改前字符串前缀 ⇒ 放行一次越界写）。
    /// 同时：工作区**内**的"还不存在的新文件"必须放行（不能修成假失败）。
    #[test]
    fn r5_prefix_similar_sibling_is_outside_the_workspace() {
        let base = scratch("ws");
        let ws = base.join("mimo-gui");
        let sibling = base.join("mimo-gui-backup");
        std::fs::create_dir_all(&ws).unwrap();
        std::fs::create_dir_all(&sibling).unwrap();
        let ws_res = resolve_sandbox_path(&ws).unwrap();

        // 界内：还没创建的文件（write_file 的常态）
        let inside = resolve_sandbox_path(&ws.join("src").join("new-file.txt")).unwrap();
        assert!(
            path_within_workspace(&inside, &ws_res),
            "工作区内、父目录还不存在的新文件必须放行：{}",
            inside.display()
        );

        // 越界：同前缀兄弟目录（字符串前缀判定会放行它）
        let outside = resolve_sandbox_path(&sibling.join("x.txt")).unwrap();
        assert!(
            !path_within_workspace(&outside, &ws_res),
            "同前缀兄弟目录必须判越界（改前 `starts_with` 会放行）：{}",
            outside.display()
        );

        // 越界：`..` 词法逃逸
        let escape = resolve_sandbox_path(&ws.join("..").join("mimo-gui-backup").join("y.txt")).unwrap();
        assert!(
            !path_within_workspace(&escape, &ws_res),
            "`..` 逃逸必须判越界：{}",
            escape.display()
        );

        // 工作区自身（带结尾分隔符也算界内）
        assert!(path_within_workspace(&ws_res, &ws_res));
        let with_sep = std::path::PathBuf::from(format!(
            "{}{}",
            ws.display(),
            std::path::MAIN_SEPARATOR
        ));
        assert!(path_within_workspace(
            &resolve_sandbox_path(&with_sep).unwrap(),
            &ws_res
        ));

        let _ = std::fs::remove_dir_all(&base);
    }

    /// 大小写必须按 **Windows 语义** 判定（改前按字节比较 ⇒ 同一个目录被拒 = 假失败）。
    ///
    /// ## 为什么这样写（第一版判据是「假绿」，必须记下来）
    ///
    /// 第一版用"大写写的工作区 + 大写写的目标"去测，结果**变异也绿**：因为
    /// `resolve_sandbox_path` 对**已存在**的路径走真 `canonicalize`，而 Windows 的
    /// `canonicalize` 会把大小写还原成磁盘上的真名 ⇒ 两侧自动同形，大小写折叠那一行
    /// 根本没被走到。真正的缺口在**比较规则**本身（前端给的工作区字符串与磁盘真名
    /// 大小写不一致，例如 `c:\ws` vs `C:\WS`），所以要直接钉 `path_within_workspace`。
    #[cfg(target_os = "windows")]
    #[test]
    fn r5_case_difference_is_still_inside_on_windows() {
        // ① 比较规则：只在大小写上不同的同一目录必须判**界内**
        assert!(
            path_within_workspace(
                std::path::Path::new(r"C:\MIMO-GUI\src\f.ts"),
                std::path::Path::new(r"c:\mimo-gui")
            ),
            "Windows 上大小写不同是同一个目录，不许判越界（改前按字节比较 ⇒ 假失败）"
        );
        assert!(path_within_workspace(
            std::path::Path::new(r"C:\MimoGui"),
            std::path::Path::new(r"c:\mimogui")
        ));
        // 越界方向不受影响（同前缀兄弟目录仍然越界）
        assert!(!path_within_workspace(
            std::path::Path::new(r"C:\MIMO-GUI-BACKUP\f.ts"),
            std::path::Path::new(r"c:\mimo-gui")
        ));

        // ② 端到端：不存在的盘（两侧都走词法规范化，大小写**原样保留**）
        //    ⇒ 这一条在没有大小写折叠时会红
        let target = resolve_sandbox_path(std::path::Path::new(r"Q:\NONEXISTENT-ws\f.txt")).unwrap();
        let ws_lexical = resolve_sandbox_path(std::path::Path::new(r"q:\nonexistent-WS")).unwrap();
        assert!(
            path_within_workspace(&target, &ws_lexical),
            "盘符/目录大小写不同必须判界内：{} vs {}",
            target.display(),
            ws_lexical.display()
        );

        // ③ 真磁盘：大写写的工作区字符串不能把界内路径判出去
        let base = scratch("case");
        let ws_real = base.join("MimoGui");
        std::fs::create_dir_all(ws_real.join("src")).unwrap();
        std::fs::write(ws_real.join("src").join("f.ts"), b"x").unwrap();
        let ws_upper = resolve_sandbox_path(&std::path::PathBuf::from(
            ws_real.to_string_lossy().to_uppercase(),
        ))
        .unwrap();
        let inside = resolve_sandbox_path(&ws_real.join("src").join("f.ts")).unwrap();
        assert!(
            path_within_workspace(&inside, &ws_upper),
            "{} 应在 {} 之内",
            inside.display(),
            ws_upper.display()
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    /// `\\?\` 长路径前缀必须剥掉（`canonicalize` 总会带它，而工作区是普通形式 ⇒ 假失败）。
    #[test]
    fn r5_verbatim_prefix_is_stripped() {
        assert_eq!(
            strip_verbatim_prefix(std::path::Path::new(r"\\?\C:\ws\a.txt")),
            std::path::PathBuf::from(r"C:\ws\a.txt")
        );
        assert_eq!(
            strip_verbatim_prefix(std::path::Path::new(r"\\?\UNC\srv\share\a")),
            std::path::PathBuf::from(r"\\srv\share\a")
        );
        assert_eq!(
            strip_verbatim_prefix(std::path::Path::new(r"C:\ws\a.txt")),
            std::path::PathBuf::from(r"C:\ws\a.txt")
        );
    }

    /// R7 同类面：`list_directory_sandboxed` 的 size 在 stat 失败时必须是
    /// **未知（null）**，而不是伪装成"0 字节空文件"。
    #[test]
    fn r7_unknown_size_is_not_reported_as_zero() {
        let known = FileInfo {
            name: "a.txt".to_string(),
            is_dir: false,
            is_file: true,
            size: Some(5),
        };
        let unknown = FileInfo {
            name: "b.txt".to_string(),
            is_dir: false,
            is_file: true,
            size: None,
        };
        assert_eq!(serde_json::to_value(&known).unwrap()["size"], 5);
        assert_eq!(
            serde_json::to_value(&unknown).unwrap()["size"],
            serde_json::Value::Null,
            "stat 失败必须是 null（未知），不能写成 0（假事实）"
        );
    }

    // ==================== R8（误拒修复：关了沙箱就真的关） ====================

    /// **主判据（两个方向）**：写侧守卫必须**跟着开关走**。
    ///
    /// 同一组路径（工作区外的兄弟目录、工作区内的新文件）在两个方向下结果必须**相反** ——
    /// 只测"开着 ⇒ 拦"那一个方向，一个**无条件拦**的实现会全绿（那正是本缺陷的形态）。
    ///
    /// 改前这里会红：`write_file` 是"给了 workspace 就拦"，关掉沙箱也照样拦 ⇒ 误拒。
    #[test]
    fn r8_write_guard_follows_the_sandbox_switch() {
        let base = scratch("r8-mode");
        let ws = base.join("ws");
        std::fs::create_dir_all(&ws).unwrap();
        let outside = base.join("outside").join("x.txt");
        let inside = ws.join("src").join("new-file.txt");
        let ws_str = ws.to_string_lossy().to_string();
        let outside_str = outside.to_string_lossy().to_string();
        let inside_str = inside.to_string_lossy().to_string();

        // ① 沙箱**关** ⇒ 工作区外也必须放行（关了就真的关）—— 这就是用户点名的误拒
        assert!(
            write_sandbox_violation(&outside_str, Some(&ws_str), Some(false))
                .unwrap()
                .is_none(),
            "沙箱关闭时工作区外的写必须放行（改前这里会拦 = 关了沙箱沙箱还生效）"
        );
        // 沙箱关 + 界内：同样放行
        assert!(write_sandbox_violation(&inside_str, Some(&ws_str), Some(false))
            .unwrap()
            .is_none());

        // ② 沙箱**开** ⇒ 工作区外必须拦，且文案说清是沙箱
        let denied = write_sandbox_violation(&outside_str, Some(&ws_str), Some(true))
            .unwrap()
            .expect("沙箱开启时工作区外的写必须被拒");
        assert!(
            denied.contains("outside the workspace"),
            "拒绝文案必须说清原因：{denied}"
        );
        // ③ 沙箱开 + 界内 ⇒ 放行（不许把好调用也拦了）
        assert!(
            write_sandbox_violation(&inside_str, Some(&ws_str), Some(true))
                .unwrap()
                .is_none(),
            "沙箱开启时工作区内的新文件必须放行（不许修成假失败）"
        );

        // ④ 两个方向必须相反 —— 逐条对照，防"无条件拦"混过单方向判据
        let off = write_sandbox_violation(&outside_str, Some(&ws_str), Some(false)).unwrap();
        let on = write_sandbox_violation(&outside_str, Some(&ws_str), Some(true)).unwrap();
        assert_ne!(
            off.is_none(),
            on.is_none(),
            "同一路径在开/关两个方向下必须给出**相反**结论"
        );

        let _ = std::fs::remove_dir_all(&base);
    }

    /// 边界：① 没给 `workspace` ⇒ 不判（既有前置条件语义，与 TS 侧一致）；
    /// ② 开关**缺省** ⇒ 按"开着"处理（fail-closed，不许静默关掉用户开着的沙箱）。
    #[test]
    fn r8_guard_defaults_and_missing_workspace() {
        let base = scratch("r8-defaults");
        let ws = base.join("ws");
        std::fs::create_dir_all(&ws).unwrap();
        let outside = base.join("outside").join("x.txt");
        let ws_str = ws.to_string_lossy().to_string();
        let outside_str = outside.to_string_lossy().to_string();

        assert!(
            write_sandbox_violation(&outside_str, None, Some(true))
                .unwrap()
                .is_none(),
            "没给 workspace ⇒ 不判（既有语义：应用自管读写不走工具路径）"
        );
        assert!(
            write_sandbox_violation(&outside_str, Some(&ws_str), None)
                .unwrap()
                .is_some(),
            "开关缺省必须按「开着」处理（fail-closed），不许把用户开着的沙箱静默关掉"
        );
        assert!(
            write_sandbox_violation(&outside_str, None, Some(false))
                .unwrap()
                .is_none()
        );

        let _ = std::fs::remove_dir_all(&base);
    }
}
