//! 渲染进程崩溃取证 —— 「窗口还在，但白屏 / 显示『页面已崩溃』」（第 71 轮）
//!
//! ## 真机现场（用户报的）
//!
//! 主对话里 agent 调了 `wait_for_delegation`，十几秒后**窗口还在，但页面白屏 /
//! 显示「页面已崩溃」**。这是 **WebView2 渲染进程死掉**的形态，不是 Rust 侧 panic。
//!
//! ## 为什么当时查不出任何东西（这次要根治的"本"）
//!
//! 崩溃后我把能查的地方都查了一遍，**一条痕迹都没有**：
//!
//! | 查的地方 | 结果 | 为什么没有 |
//! | --- | --- | --- |
//! | `%APPDATA%\com.codem.app\codem-crash.log` | 不存在 | 那是 **Rust panic** hook 写的，渲染进程死不会经过它 |
//! | `codem-runtime-*.log` | 无 FATAL、无异常 | 运行时日志只记 Rust 侧事件（启动/exec/PTY/退出） |
//! | Windows 事件日志（Application Error / WER） | 无 codem.exe 记录 | 真正崩的是 `msedgewebview2.exe`；渲染进程被 **OOM 杀掉**时连它也不写事件 |
//! | `EBWebView\Crashpad\reports` | 空 | 渲染进程 OOM 不是段错误，不产生 dump |
//!
//! 结论：**"页面崩了"这件事当时是不可归因的** —— 只能靠用户描述"白屏"来猜。
//!
//! ## 现在补的三路证据
//!
//! 1. **WebView2 `ProcessFailed` 事件**（最直接的一路）：失败类型（渲染进程退出 /
//!    无响应 / 浏览器进程退出 / 子框架渲染进程退出）、原因（`Reason`）、退出码
//!    （OOM 与访问违例的退出码不同）、出问题的进程描述、**出错模块路径**
//!    （`FailureSourceModulePath`，native 崩溃时能指出是哪个 DLL）→ 一行 ERROR 进运行时日志；
//! 2. **前端心跳 + 进程树内存**（判断是不是"涨死的"）：前端每 20 秒发一次
//!    `log_renderer_event`，本模块顺手把**本进程 + 所有 `msedgewebview2.exe` 子进程的工作集**
//!    一起记下 —— 渲染进程被 OOM 杀掉时，**最后一次心跳就是它死前的水位**；
//! 3. **渲染侧异常与卸载**：`window.onerror` / `unhandledrejection` / `pagehide`
//!    （前端那侧接线，见 `src/core/diagnostics/renderer-evidence.ts`）。
//!
//! 另加一条"退出原因"的区分：`ExitRequested` 时记下**前端有没有请求过退出** ——
//! 「用户点的退出」与「谁都没请求、进程却要结束」（系统关机 / 外部结束）在日志里不再是同一行。
//!
//! ## 诚实交代的边界
//!
//! - 心跳里的 JS 堆**只覆盖 JS 对象**，覆盖不到 WASM（本仓库带 ONNX Runtime WASM）与
//!   解码后的图像 —— 那部分只体现在**进程工作集**上，所以两者都记；
//! - `ProcessFailed` 只有在 WebView2 运行时把事件递上来时才有；如果整个宿主进程被
//!   外部强杀，仍然只有"下次启动 unclean_exit=true"这一条线索。

use std::sync::atomic::{AtomicBool, Ordering};

use crate::runtime_log;
use tauri::AppHandle;

/// 前端是否**主动请求**过退出（`quit_app`）。
///
/// 用途：把 `ExitRequested` 分成"用户点的退出"与"谁都没请求却要结束"。
/// 后者（系统关机、任务管理器结束、外部 `taskkill`）在真机上与"崩溃"极像，
/// 而此前两者在日志里是同一行字，事后无法区分。
static FRONTEND_QUIT_REQUESTED: AtomicBool = AtomicBool::new(false);

pub fn mark_frontend_quit_requested() {
    FRONTEND_QUIT_REQUESTED.store(true, Ordering::SeqCst);
}

pub fn frontend_quit_requested() -> bool {
    FRONTEND_QUIT_REQUESTED.load(Ordering::SeqCst)
}

// ========== 失败类型 / 原因的名字（真机实测：原样打 `Debug` 出来是给人看的吗？）==========

/**
 * ⚠️ 真机实测踩到的：直接 `format!("{kind:?}")` 打出来是
 * `COREWEBVIEW2_PROCESS_FAILED_KIND(1)` —— **数字对人不友好**，
 * 排查时还要回查枚举值。这里按 COM 常量逐值映射成名字，**同时保留数字**
 * （`RENDER_PROCESS_EXITED(1)`）：名字给人看，数字给以后对文档/对版本用。
 * 不认识的值如实写 `UNKNOWN(9)`，不猜。
 */
pub fn kind_name(value: i32) -> String {
    let name = match value {
        0 => "UNKNOWN",
        1 => "RENDER_PROCESS_EXITED",
        2 => "RENDER_PROCESS_UNRESPONSIVE",
        3 => "FRAME_RENDER_PROCESS_EXITED",
        4 => "UTILITY_PROCESS_EXITED",
        5 => "SANDBOX_HELPER_PROCESS_EXITED",
        6 => "GPU_PROCESS_EXITED",
        7 => "PPAPI_BROKER_PROCESS_EXITED",
        8 => "PPAPI_PLUGIN_PROCESS_EXITED",
        9 => "UNKNOWN_PROCESS_EXITED",
        _ => "UNRECOGNIZED",
    };
    format!("{name}({value})")
}

/// 失败原因（`OUT_OF_MEMORY` 与 `CRASHED` 的处置完全不同，所以必须分得开）
pub fn reason_name(value: i32) -> String {
    let name = match value {
        0 => "UNEXPECTED",
        1 => "UNRESPONSIVE",
        2 => "TERMINATED",
        3 => "CRASHED",
        4 => "LAUNCH_FAILED",
        5 => "OUT_OF_MEMORY",
        6 => "PROFILE_DELETED",
        _ => "UNRECOGNIZED",
    };
    format!("{name}({value})")
}

// ========== 渲染进程崩溃后的**有界**自动恢复 ==========

/// 恢复预算的时间窗（秒）
pub const RELOAD_WINDOW_SECS: u64 = 600;
/// 一个时间窗内最多重载几次
pub const MAX_RELOAD_ATTEMPTS: u32 = 3;

/// 重载预算（纯数据，便于单测；不直接持有原子量）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReloadBudget {
    /// 本时间窗的起点（epoch 秒；0 = 还没开始过）
    pub window_start_secs: u64,
    /// 本时间窗内已经重载过几次
    pub attempts: u32,
}

impl Default for ReloadBudget {
    fn default() -> Self {
        Self { window_start_secs: 0, attempts: 0 }
    }
}

/// 决定"要不要为这次渲染进程失败重载页面"，并返回新的预算。
///
/// 为什么要**有界**：渲染进程崩了以后页面是死的（用户看到的正是"白屏 / 页面已崩溃"），
/// 重载一次通常就能恢复可用（状态都在磁盘上）。但如果崩溃是**加载时就崩**
/// （例如某个会话大到渲染必崩），无限重载会变成一个死循环 —— 那比白屏更糟。
/// 所以：10 分钟内最多 3 次，超出就**停手并如实记下来**，让用户看到日志里的原因。
pub fn decide_reload(budget: ReloadBudget, now_secs: u64) -> (bool, ReloadBudget) {
    let expired =
        budget.window_start_secs == 0 || now_secs.saturating_sub(budget.window_start_secs) >= RELOAD_WINDOW_SECS;
    let start = if expired { now_secs } else { budget.window_start_secs };
    let attempts = if expired { 0 } else { budget.attempts };
    if attempts >= MAX_RELOAD_ATTEMPTS {
        return (false, ReloadBudget { window_start_secs: start, attempts });
    }
    (true, ReloadBudget { window_start_secs: start, attempts: attempts + 1 })
}

fn epoch_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// 把 `ProcessFailed` 的字段拼成一行（纯函数：单测逐字段钉住措辞，避免"少记了退出码"）。
pub fn describe_process_failed(
    kind: &str,
    reason: &str,
    exit_code: i32,
    process: &str,
    failure_module: &str,
) -> String {
    let mut line = format!(
        "WebView2 进程失败 kind={kind} reason={reason} exit_code={exit_code}",
    );
    if !process.is_empty() {
        line.push_str(&format!(" process={process}"));
    }
    if !failure_module.is_empty() {
        line.push_str(&format!(" failure_module={failure_module}"));
    }
    line.push_str(&format!(
        " frontend_quit_requested={}",
        frontend_quit_requested()
    ));
    line
}

/// 把"进程树内存"采样拼成一行（纯函数，单测钉住：总内存 = 宿主 + 各 WebView2 子进程之和）。
pub fn describe_memory_sample(host_bytes: u64, webview: &[(u32, u64)]) -> String {
    let webview_total: u64 = webview.iter().map(|(_, b)| *b).sum();
    let detail = webview
        .iter()
        .map(|(pid, bytes)| format!("{pid}:{}MB", bytes / (1024 * 1024)))
        .collect::<Vec<_>>()
        .join(",");
    format!(
        "host={}MB webview_total={}MB webview_procs={} [{}] total={}MB",
        host_bytes / (1024 * 1024),
        webview_total / (1024 * 1024),
        webview.len(),
        detail,
        (host_bytes + webview_total) / (1024 * 1024),
    )
}

/// 前端证据落盘（心跳 / 前端异常 / 页面卸载都走它）。
///
/// 级别只允许四种，**不认识的一律降级成 INFO 并如实写下来** —— 不静默丢弃，
/// 也不让前端随便往日志里塞级别（它会破坏"级别 = 可信度"这个约定）。
#[tauri::command]
pub fn log_renderer_event(level: String, message: String) -> Result<(), String> {
    let level = match level.as_str() {
        "INFO" | "WARN" | "ERROR" | "SAMPLE" => level,
        _ => {
            runtime_log::append_line(
                "WARN",
                &format!("renderer sent unknown level {level:?}; recorded as INFO"),
            );
            "INFO".to_string()
        }
    };
    // 单行截断由 runtime_log 负责（8KB），这里只保证前缀可检索。
    runtime_log::append_line(&level, &format!("renderer {message}"));
    Ok(())
}

/// 心跳：前端每 20 秒一次，附上**进程树内存**（渲染进程被 OOM 杀时，这就是它死前的水位）。
#[tauri::command]
pub fn log_renderer_heartbeat(sample: String) -> Result<(), String> {
    let mem = process_tree_memory();
    runtime_log::append_line(
        "SAMPLE",
        &format!("renderer heartbeat {sample} | {}", describe_memory_sample(mem.0, &mem.1)),
    );
    Ok(())
}

/// 崩溃标记文件名（与 `codem-crash.log` / `active-run.json` 同目录）
pub const RENDERER_CRASH_MARKER: &str = "renderer-crash.json";

/**
 * 把"渲染进程崩了"这件事写成一个**一次性标记**，供重载后的前端消费。
 *
 * 为什么除了日志还要这个：日志是给排查用的，用户不会去翻；而"白屏一闪、自己恢复了"
 * 如果**不告诉用户**，那就成了"神秘现象"（用户无法反馈，我们也就没有下一份现场）。
 * 前端读到就弹一条常驻提示（走既有 `addPersistAlert` 通道），读完即删 —— 一次性。
 */
fn write_renderer_crash_marker(kind: &str, reason: &str, exit_code: i32, process: &str, module: &str, memory: &str) {
    let dir = runtime_log::default_base_dir();
    let _ = std::fs::create_dir_all(&dir);
    let record = serde_json::json!({
        "at": epoch_secs() * 1000,
        "kind": kind,
        "reason": reason,
        "exitCode": exit_code,
        "process": process,
        "module": module,
        "memory": memory,
    });
    let _ = std::fs::write(
        dir.join(RENDERER_CRASH_MARKER),
        serde_json::to_string_pretty(&record).unwrap_or_default(),
    );
}

/// 取出并清除崩溃标记（没有就返回 `None`）。前端在启动时调一次。
#[tauri::command]
pub fn take_renderer_crash_marker() -> Option<String> {
    let path = runtime_log::default_base_dir().join(RENDERER_CRASH_MARKER);
    let text = std::fs::read_to_string(&path).ok()?;
    let _ = std::fs::remove_file(&path);
    Some(text)
}

/// 本进程 + 所有 WebView2 子进程的工作集（字节）。子进程列表为 `(pid, bytes)`。
///
/// 非 Windows 平台返回 `(0, [])` —— 这些平台另有工具（Activity Monitor / ps），
/// 本模块刻意不做跨平台抽象：**多写一层抽象只会让 Windows 这条真正要用的路更脆**。
pub fn process_tree_memory() -> (u64, Vec<(u32, u64)>) {
    #[cfg(windows)]
    {
        windows_impl::process_tree_memory_windows()
    }
    #[cfg(not(windows))]
    {
        (0, Vec::new())
    }
}

#[cfg(windows)]
mod windows_impl {
    use windows::Win32::Foundation::{CloseHandle, HANDLE, MAX_PATH};
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows::Win32::System::ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
    use windows::Win32::System::Threading::{
        OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    /// 一次快照：`(pid, parent_pid, exe_name)`
    fn snapshot_processes() -> Vec<(u32, u32, String)> {
        let mut out = Vec::new();
        unsafe {
            let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
                return out;
            };
            let mut entry = PROCESSENTRY32W {
                dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
                ..Default::default()
            };
            if Process32FirstW(snap, &mut entry).is_ok() {
                loop {
                    let name = String::from_utf16_lossy(
                        &entry.szExeFile[..entry
                            .szExeFile
                            .iter()
                            .position(|c| *c == 0)
                            .unwrap_or(MAX_PATH as usize)],
                    );
                    out.push((entry.th32ProcessID, entry.th32ParentProcessID, name));
                    if Process32NextW(snap, &mut entry).is_err() {
                        break;
                    }
                }
            }
            let _ = CloseHandle(snap);
        }
        out
    }

    fn working_set_bytes(pid: u32) -> Option<u64> {
        unsafe {
            let handle: HANDLE = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
            let mut counters = PROCESS_MEMORY_COUNTERS {
                cb: std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32,
                ..Default::default()
            };
            let ok = GetProcessMemoryInfo(handle, &mut counters, counters.cb).is_ok();
            let _ = CloseHandle(handle);
            if ok {
                Some(counters.WorkingSetSize as u64)
            } else {
                None
            }
        }
    }

    /// 本进程工作集 + 其**后代**里所有 `msedgewebview2.exe` 的工作集
    pub fn process_tree_memory_windows() -> (u64, Vec<(u32, u64)>) {
        let all = snapshot_processes();
        let me = std::process::id();

        // 后代判定：反复扩集合直到不再增长（WebView2 的进程树可能有 3~4 层）
        let mut descendants: Vec<u32> = vec![me];
        loop {
            let before = descendants.len();
            for (pid, parent, _) in &all {
                if descendants.contains(parent) && !descendants.contains(pid) {
                    descendants.push(*pid);
                }
            }
            if descendants.len() == before {
                break;
            }
        }

        let host = working_set_bytes(me).unwrap_or(0);
        let mut webview = Vec::new();
        for (pid, _, name) in &all {
            if *pid == me || !descendants.contains(pid) {
                continue;
            }
            if !name.eq_ignore_ascii_case("msedgewebview2.exe") {
                continue;
            }
            if let Some(bytes) = working_set_bytes(*pid) {
                webview.push((*pid, bytes));
            }
        }
        webview.sort_by_key(|(pid, _)| *pid);
        (host, webview)
    }
}

/// 注册 WebView2 `ProcessFailed` → 运行时日志（Windows）。其它平台是 no-op。
pub fn install_process_failed_logging(app: &AppHandle) {
    #[cfg(windows)]
    {
        use tauri::Manager;
        use webview2_com::Microsoft::Web::WebView2::Win32::{
            ICoreWebView2ProcessFailedEventArgs2, ICoreWebView2ProcessFailedEventArgs3,
        };
        use webview2_com::{take_pwstr, ProcessFailedEventHandler};
        use windows::core::Interface;

        let Some(window) = app.get_webview_window("main") else {
            runtime_log::append_line("WARN", "crash-evidence: 主窗口不存在，无法挂 ProcessFailed");
            return;
        };
        // 交给 handler 一份窗口句柄：渲染进程崩了以后要**主动重载**（有界，见 decide_reload）
        let reload_window = window.clone();
        let budget = std::sync::Arc::new(std::sync::Mutex::new(ReloadBudget::default()));
        let installed = window.with_webview(move |platform| {
            let controller = platform.controller();
            let core = match unsafe { controller.CoreWebView2() } {
                Ok(core) => core,
                Err(e) => {
                    runtime_log::append_line(
                        "WARN",
                        &format!("crash-evidence: 取 CoreWebView2 失败（{e}）"),
                    );
                    return;
                }
            };
            let handler = ProcessFailedEventHandler::create(Box::new(
                move |_sender, args: Option<webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2ProcessFailedEventArgs>| {
                let Some(args) = args else { return Ok(()) };
                let mut kind_raw = Default::default();
                let _ = unsafe { args.ProcessFailedKind(&mut kind_raw) };
                let kind_value = kind_raw.0;
                let kind = kind_name(kind_value);

                // 2 号接口才有 Reason/ExitCode/ProcessDescription；3 号才有出错模块路径。
                // 老运行时上拿不到就拿不到 —— 记 "unknown"，不编造。
                let (reason, exit_code, process, module) =
                    match args.cast::<ICoreWebView2ProcessFailedEventArgs2>() {
                        Ok(a2) => {
                            let mut reason = Default::default();
                            let _ = unsafe { a2.Reason(&mut reason) };
                            let mut exit_code = 0i32;
                            let _ = unsafe { a2.ExitCode(&mut exit_code) };
                            let mut process = windows::core::PWSTR::null();
                            let process = if unsafe { a2.ProcessDescription(&mut process) }.is_ok() {
                                take_pwstr(process)
                            } else {
                                String::new()
                            };
                            let module = match args.cast::<ICoreWebView2ProcessFailedEventArgs3>() {
                                Ok(a3) => {
                                    let mut p = windows::core::PWSTR::null();
                                    if unsafe { a3.FailureSourceModulePath(&mut p) }.is_ok() {
                                        take_pwstr(p)
                                    } else {
                                        String::new()
                                    }
                                }
                                Err(_) => String::new(),
                            };
                            (reason_name(reason.0), exit_code, process, module)
                        }
                        Err(_) => ("unknown".to_string(), 0, String::new(), String::new()),
                    };

                let mem = process_tree_memory();
                let memory_line = describe_memory_sample(mem.0, &mem.1);
                runtime_log::append_line(
                    "ERROR",
                    &format!(
                        "{} | {}",
                        describe_process_failed(&kind, &reason, exit_code, &process, &module),
                        memory_line
                    ),
                );
                write_renderer_crash_marker(&kind, &reason, exit_code, &process, &module, &memory_line);

                // ===== 有界自动恢复 =====
                // 渲染进程退出/无响应 ⇒ 页面是死的（用户看到"白屏 / 页面已崩溃"）。
                // 重载一次通常就能恢复（会话/消息都在磁盘上）。预算用完就停手（见 decide_reload）。
                let renderer_died = kind_value == 1 || kind_value == 2;
                if renderer_died {
                    let (allow, next) = {
                        let mut guard = budget.lock().unwrap_or_else(|e| e.into_inner());
                        let (allow, next) = decide_reload(*guard, epoch_secs());
                        *guard = next;
                        (allow, next)
                    };
                    if allow {
                        runtime_log::append_line(
                            "WARN",
                            &format!(
                                "crash-evidence: 渲染进程已死，自动重载页面（本次时间窗第 {}/{} 次）",
                                next.attempts, MAX_RELOAD_ATTEMPTS
                            ),
                        );
                        if let Err(e) = reload_window.reload() {
                            runtime_log::append_line(
                                "ERROR",
                                &format!("crash-evidence: 自动重载失败（{e}）—— 页面会停在崩溃页"),
                            );
                        }
                    } else {
                        runtime_log::append_line(
                            "ERROR",
                            &format!(
                                "crash-evidence: {} 秒内已重载 {} 次，停止自动恢复（继续重载会变成死循环）—— 页面停在崩溃页，原因见上一行",
                                RELOAD_WINDOW_SECS, MAX_RELOAD_ATTEMPTS
                            ),
                        );
                    }
                }
                Ok(())
            }));
            let mut token = 0i64;
            if let Err(e) = unsafe { core.add_ProcessFailed(&handler, &mut token) } {
                runtime_log::append_line(
                    "WARN",
                    &format!("crash-evidence: add_ProcessFailed 失败（{e}）"),
                );
            }
        });
        match installed {
            Ok(()) => runtime_log::append_line("INFO", "crash-evidence: ProcessFailed 监听已挂上"),
            Err(e) => runtime_log::append_line(
                "WARN",
                &format!("crash-evidence: with_webview 失败（{e}）"),
            ),
        }
    }
    #[cfg(not(windows))]
    {
        let _ = app;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crash_line_carries_every_field_the_diagnosis_needs() {
        let line = describe_process_failed(
            "RenderProcessExited",
            "OutOfMemory",
            5,
            "Renderer",
            "C:\\Windows\\System32\\onnxruntime.dll",
        );
        // 四个判据字段一个都不能少：类型、原因、退出码、出错模块
        assert!(line.contains("kind=RenderProcessExited"), "{line}");
        assert!(line.contains("reason=OutOfMemory"), "{line}");
        assert!(line.contains("exit_code=5"), "{line}");
        assert!(line.contains("process=Renderer"), "{line}");
        assert!(line.contains("failure_module=C:\\Windows\\System32\\onnxruntime.dll"), "{line}");
        // 退出原因也要在同一行里（否则事后分不清"用户退出"与"外部结束"）
        assert!(line.contains("frontend_quit_requested="), "{line}");
    }

    #[test]
    fn crash_line_omits_absent_optional_fields_instead_of_printing_empty_labels() {
        let line = describe_process_failed("BrowserProcessExited", "unknown", -1, "", "");
        assert!(!line.contains("process="), "空的可选字段不该出现：{line}");
        assert!(!line.contains("failure_module="), "空的可选字段不该出现：{line}");
        assert!(line.contains("exit_code=-1"), "{line}");
    }

    #[test]
    fn memory_sample_totals_host_plus_webview_children() {
        let line = describe_memory_sample(100 * 1024 * 1024, &[(7, 200 * 1024 * 1024), (9, 50 * 1024 * 1024)]);
        assert!(line.contains("host=100MB"), "{line}");
        assert!(line.contains("webview_total=250MB"), "{line}");
        assert!(line.contains("webview_procs=2"), "{line}");
        assert!(line.contains("total=350MB"), "{line}");
        assert!(line.contains("[7:200MB,9:50MB]"), "每个子进程都要能看见：{line}");
    }

    #[test]
    fn memory_sample_without_webview_is_still_a_legible_line() {
        let line = describe_memory_sample(80 * 1024 * 1024, &[]);
        assert!(line.contains("webview_total=0MB"), "{line}");
        assert!(line.contains("webview_procs=0"), "{line}");
        assert!(line.contains("[]"), "{line}");
    }

    #[test]
    fn frontend_quit_flag_is_visible_to_the_crash_line() {
        mark_frontend_quit_requested();
        let line = describe_process_failed("RenderProcessExited", "Crashed", 0, "Renderer", "");
        assert!(line.contains("frontend_quit_requested=true"), "{line}");
    }

    #[test]
    fn failure_kinds_and_reasons_are_named_not_just_numbered() {
        // 真机实测：原样 Debug 打出来是 `COREWEBVIEW2_PROCESS_FAILED_KIND(1)`，对人不友好
        assert_eq!(kind_name(1), "RENDER_PROCESS_EXITED(1)");
        assert_eq!(kind_name(2), "RENDER_PROCESS_UNRESPONSIVE(2)");
        assert_eq!(kind_name(6), "GPU_PROCESS_EXITED(6)");
        assert_eq!(reason_name(5), "OUT_OF_MEMORY(5)");
        assert_eq!(reason_name(3), "CRASHED(3)");
        // 不认识的值如实标出来，并且**数字要保留**（对文档/对版本用）
        assert_eq!(kind_name(99), "UNRECOGNIZED(99)");
        assert_eq!(reason_name(-1), "UNRECOGNIZED(-1)");
    }

    #[test]
    fn reload_budget_is_bounded_and_resets_after_the_window() {
        let t0 = 1_000_000u64;
        let (allow1, b1) = decide_reload(ReloadBudget::default(), t0);
        assert!(allow1, "第一次必须允许重载");
        assert_eq!(b1.attempts, 1);
        let (allow2, b2) = decide_reload(b1, t0 + 10);
        assert!(allow2);
        assert_eq!(b2.attempts, 2);
        let (allow3, b3) = decide_reload(b2, t0 + 20);
        assert!(allow3);
        assert_eq!(b3.attempts, MAX_RELOAD_ATTEMPTS);
        // 第四次：同一时间窗内预算已用尽 ⇒ 必须停手（否则会变成崩溃—重载死循环）
        let (allow4, b4) = decide_reload(b3, t0 + 30);
        assert!(!allow4, "预算用尽后不许再重载");
        assert_eq!(b4.attempts, MAX_RELOAD_ATTEMPTS);
        // 时间窗过去之后重新给预算
        let (allow5, b5) = decide_reload(b4, t0 + RELOAD_WINDOW_SECS + 1);
        assert!(allow5, "新时间窗应当重新允许");
        assert_eq!(b5.attempts, 1);
        assert_eq!(b5.window_start_secs, t0 + RELOAD_WINDOW_SECS + 1);
    }
}
