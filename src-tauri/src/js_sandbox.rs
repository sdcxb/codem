//! **Rust 侧 JS 沙箱**：不经 `eval`、也不经 WebView 的 CSP，跑 `run_code` / `workflow` 的脚本。
//!
//! ## 为什么在 Rust 侧（第 103 波的血泪教训）
//!
//! 装好的应用 CSP 不含 `unsafe-eval`，所以 WebView 里 `new Function` / `eval` 直接抛 CSP 违规
//! （`run_code` 与 `workflow` 在真机上因此完全不可用）。
//! 先用"QuickJS 编成 WASM 在页面里跑"顶了一版（`src/core/js/js-vm.ts`），**同步路径**很好用
//! （hooks 已迁完），但**异步宿主函数**那条路有个硬限制：asyncify 引擎一次执行只能挂起一次 ——
//! 实测 1 次工具调用 5/5 成功、2 次 0/5、3+ 次 0/5，而且损坏留在**进程**里（交接单 §16.3）。
//!
//! 这里换成 Rust 侧引擎（`boa_engine`）：宿主调用**阻塞**等待（生产里是"发事件 → 等前端回复"），
//! guest 看到的就是一个**同步**函数 —— 没有挂起、没有挂起上限。
//!
//! ## 判据（本文件末尾 `js_sandbox_tests`）
//!
//! · 基本求值 / `console.log` 捕获 / `await` 可用；
//! · **多次**宿主调用（这正是 WebView 侧做不到的那件事）；
//! · 宿主抛错时 guest 能 catch 到可读原因；
//! · 死循环被**循环迭代上限**打断（确定性，不依赖墙钟）；
//! · 隔离：guest 里没有 `process` / `window` / `require`。
//!
//! ## 与前端的分工（**闸门只有一份**）
//!
//! 危险命令分析、受保护路径、覆盖确认都在 TS 侧。本模块**不复制**这些判断，
//! 它只做"把 guest 的调用转发给宿主、把结果带回来"，宿主由调用方注入。
//!
//! ## 线程模型（为什么要 thread_local）
//!
//! boa 的 `NativeFunction` 用 `from_copy_closure` 时闭包必须 `Copy`，
//! 而我们要在里面持有"宿主回调 + 输出缓冲"。这里改成 **thread_local 状态 + 函数指针**：
//! 一次执行独占当前线程（执行期间不会重入），因此状态是安全的。
use boa_engine::{
    builtins::promise::PromiseState, js_string, native_function::NativeFunction, Context, JsError,
    JsNativeError, JsResult, JsValue, Source,
};
use std::cell::RefCell;
use std::rc::Rc;

/// 宿主调用的实现：收 `(方法名, 参数 JSON)`，返回 `Result<结果 JSON, 错误文本>`。
///
/// 生产环境里它是"发 Tauri 事件 → 阻塞等前端回复"；测试里是一个闭包。
/// **它是阻塞的** —— 这正是本设计的关键：guest 侧同步即可，不需要 asyncify。
pub type HostCall = dyn Fn(&str, &str) -> Result<String, String>;

/// 一次执行的预算与输入。
pub struct SandboxOptions<'a> {
    /// 代码（会被包进单层 async IIFE + try/catch，所以可以用 `await`）
    pub code: &'a str,
    /// 宿主调用实现
    pub host: Rc<HostCall>,
    /// 暴露给 guest 的方法名单（决定 `sdk` 上有哪些函数）
    pub methods: &'a [&'a str],
    /// 循环迭代上限（防 `while(true)`；boa 的确定性上限，不依赖墙钟）
    pub loop_limit: u64,
    /// 宿主调用次数上限（防御：脚本疯狂调用工具时不要无限跑下去）
    pub host_call_limit: u32,
}

impl<'a> SandboxOptions<'a> {
    /// 默认预算：循环 100 万次、宿主调用 200 次（够用且能兜住失控脚本）
    pub fn new(code: &'a str, host: Rc<HostCall>, methods: &'a [&'a str]) -> Self {
        Self {
            code,
            host,
            methods,
            loop_limit: 1_000_000,
            host_call_limit: 200,
        }
    }
}

/// 执行结果。
pub struct SandboxOutcome {
    /// 正常结束
    pub ok: bool,
    /// 完成值（JSON 文本）
    pub value: Option<String>,
    /// 错误（JSON：`{"message":...}`）
    pub error: Option<String>,
    /// `console.log/info` 收集
    pub stdout: String,
    /// `console.error/warn` 收集
    pub stderr: String,
    /// 因超出执行预算被中断
    pub budget_exceeded: bool,
    /// 宿主调用次数（诊断用：WebView 侧就是因为这个数字 >1 才崩的）
    pub host_calls: u32,
}

thread_local! {
    static HOST: RefCell<Option<Rc<HostCall>>> = const { RefCell::new(None) };
    static STDOUT: RefCell<String> = const { RefCell::new(String::new()) };
    static STDERR: RefCell<String> = const { RefCell::new(String::new()) };
    static HOST_CALLS: RefCell<u32> = const { RefCell::new(0) };
    static HOST_CALL_LIMIT: RefCell<u32> = const { RefCell::new(200) };
    static OVER_LIMIT: RefCell<bool> = const { RefCell::new(false) };
    /// 已产出的输出字节总量（`console.log` 与 `console.error` **一起**算）
    static OUTPUT_BYTES: RefCell<usize> = const { RefCell::new(0) };
    /// 输出撞到上限（与"循环/宿主调用超预算"分开报告 —— 两者的修法不同）
    static OUTPUT_OVER: RefCell<bool> = const { RefCell::new(false) };
}

/// 一次执行允许产出的输出上限（字节，stdout + stderr 合计）。
///
/// ## 为什么必须有它（第 181 波，对标 Pi `319fecb89`）
///
/// 修复前 `console.log` 把每一行 `push_str` 进一个**无界 `String`**，唯一的兜底是"循环迭代
/// 上限"（100 万次）与宿主调用上限 —— 而 `for (;;) console.log("x".repeat(1e6))` 在撞到
/// 迭代上限之前就能把宿主进程的内存吃光（脚本本应是被隔离的一方，却把宿主打死）。
///
/// ## 为什么是"失败"而不是"截断"
///
/// 截断会让模型以为它看到了全部输出（本仓库最忌讳的"静默降级"）。所以撞上限时
/// **报一个可读的错误并中断脚本**，同时把"输出被限制"这件事写进错误文案。
pub const MAX_OUTPUT_BYTES: usize = 16 * 1024 * 1024;

fn json_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

/// 往输出缓冲里追加一行。**返回 `Err` 表示撞到 `MAX_OUTPUT_BYTES`**（调用方负责变成 JS 异常）。
///
/// 记账是 stdout + stderr **合计**的：只记一边的话，脚本交替写两个流就能绕过上限。
fn push_to(sink: &RefCell<String>, text: &str) -> Result<(), String> {
    let total = OUTPUT_BYTES.with(|c| {
        let mut c = c.borrow_mut();
        *c = c.saturating_add(text.len() + 1);
        *c
    });
    if total > MAX_OUTPUT_BYTES {
        OUTPUT_OVER.with(|f| *f.borrow_mut() = true);
        return Err(format!(
            "script output exceeded the limit of {} bytes of console output. \
             Print a summary instead, or write large data to a file with a tool.",
            MAX_OUTPUT_BYTES
        ));
    }
    let mut s = sink.borrow_mut();
    s.push_str(text);
    s.push('\n');
    Ok(())
}

/// 把 `push_to` 的失败变成 JS 侧可捕获的异常（guest 的 try/catch 拦得住，但上限状态已经记下）
fn output_error(message: String) -> JsError {
    JsNativeError::error().with_message(message).into()
}

/// `console.log` / `console.error` 的实现（同一个函数，接不同的缓冲）
fn console_entry(_this: &JsValue, args: &[JsValue], ctx: &mut Context) -> JsResult<JsValue> {
    let mut line = String::new();
    for (i, arg) in args.iter().enumerate() {
        if i > 0 {
            line.push(' ');
        }
        line.push_str(&match arg.as_string() {
            Some(s) => s.to_std_string_escaped(),
            None => arg
                .to_string(ctx)
                .map(|s| s.to_std_string_escaped())
                .unwrap_or_else(|_| "?".to_string()),
        });
    }
    // 由 prelude 决定写哪个缓冲：这里统一写 stdout，stderr 用下面那个入口
    STDOUT.with(|s| push_to(s, &line)).map_err(output_error)?;
    Ok(JsValue::undefined())
}

fn console_err_entry(_this: &JsValue, args: &[JsValue], ctx: &mut Context) -> JsResult<JsValue> {
    let mut line = String::new();
    for (i, arg) in args.iter().enumerate() {
        if i > 0 {
            line.push(' ');
        }
        line.push_str(&match arg.as_string() {
            Some(s) => s.to_std_string_escaped(),
            None => arg
                .to_string(ctx)
                .map(|s| s.to_std_string_escaped())
                .unwrap_or_else(|_| "?".to_string()),
        });
    }
    STDERR.with(|s| push_to(s, &line)).map_err(output_error)?;
    Ok(JsValue::undefined())
}

/// `__hostCall(name, argsJson)`：**阻塞**等宿主结果；错误包成信封带回去（由 guest 侧抛）
fn host_call_entry(_this: &JsValue, args: &[JsValue], ctx: &mut Context) -> JsResult<JsValue> {
    let name = args
        .first()
        .and_then(|v| v.as_string())
        .map(|s| s.to_std_string_escaped())
        .unwrap_or_default();
    let payload = args
        .get(1)
        .and_then(|v| v.as_string())
        .map(|s| s.to_std_string_escaped())
        .unwrap_or_else(|| "[]".to_string());

    let limit = HOST_CALL_LIMIT.with(|l| *l.borrow());
    let count = HOST_CALLS.with(|c| {
        let mut c = c.borrow_mut();
        *c += 1;
        *c
    });
    if count > limit {
        OVER_LIMIT.with(|f| *f.borrow_mut() = true);
        let envelope = format!(
            r#"{{"__jsvmError":"{}"}}"#,
            json_escape(&format!(
                "一次执行里最多调用 {limit} 次工具（当前脚本已调用 {count} 次）；请把脚本拆小，或直接用 bash / 其它工具"
            ))
        );
        return Ok(JsValue::from(js_string!(envelope.as_str())));
    }

    let host = HOST.with(|h| h.borrow().clone());
    let Some(host) = host else {
        return Ok(JsValue::from(js_string!(r#"{"__jsvmError":"宿主未就绪"}"#)));
    };
    let _ = ctx;
    match host(&name, &payload) {
        Ok(json) => Ok(JsValue::from(js_string!(json.as_str()))),
        Err(message) => {
            let envelope = format!(r#"{{"__jsvmError":"{}"}}"#, json_escape(&message));
            Ok(JsValue::from(js_string!(envelope.as_str())))
        }
    }
}

/// 执行一段 guest 代码，返回结果（同步、阻塞）。
pub fn run_sandboxed(options: SandboxOptions<'_>) -> SandboxOutcome {
    // 装置 thread_local 状态
    HOST.with(|h| *h.borrow_mut() = Some(options.host.clone()));
    STDOUT.with(|s| s.borrow_mut().clear());
    STDERR.with(|s| s.borrow_mut().clear());
    HOST_CALLS.with(|c| *c.borrow_mut() = 0);
    HOST_CALL_LIMIT.with(|l| *l.borrow_mut() = options.host_call_limit);
    OVER_LIMIT.with(|f| *f.borrow_mut() = false);

    let mut context = Context::default();
    context
        .runtime_limits_mut()
        .set_loop_iteration_limit(options.loop_limit);

    let _ = context.register_global_callable(js_string!("__log"), 0, NativeFunction::from_fn_ptr(console_entry));
    let _ = context.register_global_callable(js_string!("__err"), 0, NativeFunction::from_fn_ptr(console_err_entry));
    let _ = context.register_global_callable(js_string!("__hostCall"), 2, NativeFunction::from_fn_ptr(host_call_entry));

    let methods_json = options
        .methods
        .iter()
        .map(|m| format!("\"{}\"", json_escape(m)))
        .collect::<Vec<_>>()
        .join(",");

    let prelude = format!(
        r#"
globalThis.console = {{ log: __log, info: __log, warn: __err, error: __err }};
globalThis.__sdk = function (name, args) {{
  const out = JSON.parse(__hostCall(String(name), JSON.stringify(args === undefined ? [] : args)));
  if (out && typeof out === "object" && out.__jsvmError !== undefined) {{
    return Promise.reject(new Error(String(out.__jsvmError)));
  }}
  return Promise.resolve(out === null || out === undefined ? null : (("__jsvmValue" in out) ? out.__jsvmValue : out));
}};
globalThis.sdk = {{}};
[{methods_json}].forEach(function (name) {{
  globalThis.sdk[name] = function () {{
    return globalThis.__sdk(name, Array.prototype.slice.call(arguments));
  }};
}});
"#
    );

    // 第 181 波：每次执行的输出记账从零开始（thread_local 会跨次复用）
    OUTPUT_BYTES.with(|c| *c.borrow_mut() = 0);
    OUTPUT_OVER.with(|f| *f.borrow_mut() = false);

    let mut out = SandboxOutcome {
        ok: true,
        value: None,
        error: None,
        stdout: String::new(),
        stderr: String::new(),
        budget_exceeded: false,
        host_calls: 0,
    };

    if let Err(error) = context.eval(Source::from_bytes(prelude.as_bytes())) {
        out.ok = false;
        out.error = Some(format!(
            r#"{{"message":"预置脚本失败：{}"}}"#,
            json_escape(&error.to_string())
        ));
        out.stdout = STDOUT.with(|s| s.borrow().clone());
        out.stderr = STDERR.with(|s| s.borrow().clone());
        out.host_calls = HOST_CALLS.with(|c| *c.borrow());
        return out;
    }

    // 单层 async 帧 + try/catch：用户代码的 `return` 就是完成值（与 WebView 侧同一形状）
    let wrapped = format!(
        r#"(async () => {{
  try {{
{}
  }} catch (e) {{
    return {{ __jsvmGuestError: {{ message: String((e && e.message) || e), stack: e && e.stack ? String(e.stack) : undefined, name: e && e.name ? String(e.name) : undefined }} }};
  }}
}})()"#,
        options.code
    );

    match context.eval(Source::from_bytes(wrapped.as_bytes())) {
        Ok(value) => {
            // 推进 promise 的 job（`await` 靠它）
            if let Err(error) = context.run_jobs() {
                out.ok = false;
                out.error = Some(format!(r#"{{"message":"{}"}}"#, json_escape(&error.to_string())));
            } else {
                match settle_completion(&value, &mut context) {
                    Ok(json) => out.value = json,
                    Err(message) => {
                        out.ok = false;
                        out.error = Some(message);
                    }
                }
            }
        }
        Err(error) => {
            let text = error.to_string();
            let over_host_limit = OVER_LIMIT.with(|f| *f.borrow());
            // 第 181 波：输出撞上限是一种**独立的**失败（不是"循环太久"）。分开报，
            // 因为修法不同：前者要脚本少打印/落盘，后者要脚本少循环。
            let output_over = OUTPUT_OVER.with(|f| *f.borrow());
            // boa 的超预算错误文案是 RuntimeLimitError: reached the maximum number of iteration
            // loops on this execution（实测）—— 第一版只匹配了 "loop iteration limit"，
            // 于是循环确实被中断了、budget_exceeded 却是 false，判据因此红。
            // 这里按**实测文案**匹配，并留几个同义写法兜底。
            let exceeded = over_host_limit
                || text.contains("RuntimeLimitError")
                || text.contains("maximum number of iteration")
                || text.contains("iteration loops")
                || text.contains("loop iteration limit")
                || text.contains("stack size limit")
                || text.contains("recursion limit");
            out.ok = false;
            out.budget_exceeded = exceeded || output_over;
            out.error = Some(format!(
                r#"{{"message":"{}"}}"#,
                json_escape(&if output_over {
                    format!(
                        "脚本输出超出上限（{} 字节的 console 输出，已中断）：请只打印摘要，\
                         大块数据请用工具写进文件",
                        MAX_OUTPUT_BYTES
                    )
                } else if exceeded {
                    "执行超出预算：脚本循环太久或调用工具过多（已中断）".to_string()
                } else {
                    text
                })
            ));
        }
    }

    out.stdout = STDOUT.with(|s| s.borrow().clone());
    out.stderr = STDERR.with(|s| s.borrow().clone());
    out.host_calls = HOST_CALLS.with(|c| *c.borrow());
    HOST.with(|h| *h.borrow_mut() = None);

    // 第 181 波：**统一的报告归一化**。
    //
    // 为什么必须放在这里（实测踩到的坑）：脚本里 `try/catch` 会自己接住输出上限抛出的错误，
    // 于是它走的是 `settle_completion` 的 **guest 错误信封**那条路 —— 上面那个
    // `match context.eval` 的 Err 分支根本不会执行。结果是：机制生效了（脚本确实停下了、
    // 缓冲确实有界），但 `budget_exceeded` 还是 false、给模型看的还是英文原话。
    // 把归一化提到"唯一的报告出口"，两条路都覆盖。
    if OUTPUT_OVER.with(|f| *f.borrow()) {
        out.ok = false;
        out.budget_exceeded = true;
        out.error = Some(format!(
            r#"{{"message":"{}"}}"#,
            json_escape(&format!(
                "脚本输出超出上限（{} 字节的 console 输出，已中断）：请只打印摘要，\
                 大块数据请用工具写进文件",
                MAX_OUTPUT_BYTES
            ))
        ));
    }

    out
}

/// 完成值：普通值 JSON 化；Promise 看结算结果；识别 guest 的错误信封。
fn settle_completion(value: &JsValue, context: &mut Context) -> Result<Option<String>, String> {
    let settled: JsValue = if let Some(promise) = value.as_promise() {
        match promise.state() {
            PromiseState::Fulfilled(v) => v,
            PromiseState::Rejected(reason) => {
                let text = reason
                    .to_string(context)
                    .map(|s| s.to_std_string_escaped())
                    .unwrap_or_else(|_| "guest 抛出了不可读的错误".to_string());
                return Err(format!(r#"{{"message":"{}"}}"#, json_escape(&text)));
            }
            PromiseState::Pending => {
                return Err(
                    r#"{"message":"脚本留下了一个未结算的 Promise（可能 await 了永不完成的东西）"}"#
                        .to_string(),
                );
            }
        }
    } else {
        value.clone()
    };

    // guest 自报的错误信封
    if let Some(obj) = settled.as_object() {
        if let Ok(marker) = obj.get(js_string!("__jsvmGuestError"), context) {
            if !marker.is_undefined() {
                let text = marker
                    .to_json(context)
                    .ok()
                    .flatten()
                    .map(|j| j.to_string())
                    .unwrap_or_else(|| r#"{"message":"guest 抛出错误但没带 message"}"#.to_string());
                return Err(text);
            }
        }
    }

    match settled.to_json(context) {
        Ok(None) => Ok(None),
        Ok(Some(serde_json::Value::Null)) => Ok(None),
        Ok(Some(json)) => Ok(Some(json.to_string())),
        Err(error) => Err(format!(
            r#"{{"message":"返回值无法序列化：{}"}}"#,
            json_escape(&error.to_string())
        )),
    }
}

// =====================================================================================
// Tauri 侧：命令 + "宿主调用 → 前端回复"的桥
// =====================================================================================

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::mpsc::{self, Sender};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

/// 一次宿主调用的请求（发给前端）
#[derive(Clone, Serialize)]
pub struct HostCallRequest {
    pub id: u64,
    pub name: String,
    /// 参数数组的 JSON
    pub args: String,
    /// 来自哪个沙箱会话（动态插件用；单发执行时为 `None`）
    ///
    /// 为什么需要它：会话形态里 guest 调 `ctx.provide(...)`，前端必须知道
    /// "这是哪个插件交出来的服务"，才能把描述符记到那个插件名下、并给它建代理。
    pub session_id: Option<u64>,
}

/// 前端回复宿主调用时提交的内容
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostCallReply {
    pub id: u64,
    /// 成功：结果 JSON（会被 guest 的 `__sdk` 解析）
    pub result: Option<String>,
    /// 失败：可读原因
    pub error: Option<String>,
}

/// 等待前端回复的宿主调用表
#[derive(Default)]
pub struct PendingHostCalls(pub Mutex<HashMap<u64, Sender<Result<String, String>>>>);

/// 发给前端的命令结果（`rename_all` 让 TS 侧拿到 camelCase）
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JsSandboxResult {
    pub ok: bool,
    pub value: Option<String>,
    pub error: Option<String>,
    pub stdout: String,
    pub stderr: String,
    pub budget_exceeded: bool,
    pub host_calls: u32,
}

/// 每个宿主调用的等待上限（单次工具调用；总时长由前端再兜一层）
const HOST_CALL_TIMEOUT: Duration = Duration::from_secs(120);

/// **执行一段 guest 代码**（在 Rust 侧引擎里跑；宿主调用走"事件 → 前端回复"）。
///
/// 为什么是 async 命令：真正的执行放在 blocking 线程（它要**阻塞**等前端回复），
/// 不能占住 async 运行时。
#[tauri::command]
pub async fn js_run_sandboxed(
    app: AppHandle,
    code: String,
    methods: Vec<String>,
    loop_limit: Option<u64>,
    host_call_limit: Option<u32>,
) -> Result<JsSandboxResult, String> {
    let methods_owned: Vec<String> = methods;
    let app_for_host = app.clone();

    let outcome = tauri::async_runtime::spawn_blocking(move || {
        let methods_ref: Vec<&str> = methods_owned.iter().map(|s| s.as_str()).collect();
        let host: Rc<HostCall> = {
            let app = app_for_host;
            Rc::new(move |name: &str, args: &str| -> Result<String, String> {
                let state = app.state::<PendingHostCalls>();
                let id = {
                    // 自增 id：用时间戳 + 计数足够（同进程唯一即可）
                    use std::sync::atomic::{AtomicU64, Ordering};
                    static NEXT: AtomicU64 = AtomicU64::new(1);
                    NEXT.fetch_add(1, Ordering::Relaxed)
                };
                let (tx, rx) = mpsc::channel::<Result<String, String>>();
                {
                    let mut pending = state.0.lock().map_err(|e| format!("内部错误：{e}"))?;
                    pending.insert(id, tx);
                }
                let request = HostCallRequest {
                    id,
                    name: name.to_string(),
                    args: args.to_string(),
                    session_id: None,
                };
                if let Err(error) = app.emit("jsvm://host-call", request) {
                    if let Ok(mut pending) = state.0.lock() {
                        pending.remove(&id);
                    }
                    return Err(format!("无法把工具调用发给前端：{error}"));
                }
                match rx.recv_timeout(HOST_CALL_TIMEOUT) {
                    Ok(result) => result,
                    Err(_) => {
                        if let Ok(mut pending) = state.0.lock() {
                            pending.remove(&id);
                        }
                        Err(format!(
                            "工具调用超时（{}s）：前端没有回复 {name}",
                            HOST_CALL_TIMEOUT.as_secs()
                        ))
                    }
                }
            })
        };
        let mut options = SandboxOptions::new(&code, host, &methods_ref);
        if let Some(limit) = loop_limit {
            options.loop_limit = limit;
        }
        if let Some(limit) = host_call_limit {
            options.host_call_limit = limit;
        }
        run_sandboxed(options)
    })
    .await
    .map_err(|error| format!("执行线程失败：{error}"))?;

    Ok(JsSandboxResult {
        ok: outcome.ok,
        value: outcome.value,
        error: outcome.error,
        stdout: outcome.stdout,
        stderr: outcome.stderr,
        budget_exceeded: outcome.budget_exceeded,
        host_calls: outcome.host_calls,
    })
}

/// 前端回复一次宿主调用（成功/失败二选一）
#[tauri::command]
pub fn jsvm_host_reply(state: State<'_, PendingHostCalls>, reply: HostCallReply) -> Result<(), String> {
    let sender = {
        let mut pending = state.0.lock().map_err(|e| format!("内部错误：{e}"))?;
        pending.remove(&reply.id)
    };
    let Some(sender) = sender else {
        // 迟到/重复的回复：不算错误（可能已经超时清理过），但要让调用方知道
        return Err(format!("没有在等待 id={} 的回复（可能已超时）", reply.id));
    };
    let outcome = match (reply.result, reply.error) {
        (_, Some(error)) => Err(error),
        (Some(result), None) => Ok(result),
        (None, None) => Ok("null".to_string()),
    };
    sender.send(outcome).map_err(|e| format!("前端回复时通道已关闭：{e}"))
}

// =====================================================================================
// 判据（Rust 侧：引擎语义；宿主桥与命令由 TS 侧判据 + 真机探针覆盖）
// =====================================================================================

#[cfg(test)]
mod js_sandbox_tests {
    use super::*;
    use std::sync::Mutex;

    /// 一个记录调用并返回固定结果的宿主（模拟 sdk.bash 等）
    fn recording_host(log: Rc<Mutex<Vec<(String, String)>>>) -> Rc<HostCall> {
        Rc::new(move |name: &str, args: &str| {
            log.lock().unwrap().push((name.to_string(), args.to_string()));
            Ok(format!(
                r#"{{"__jsvmValue":{{"echo":"{}:{}"}}}}"#,
                name,
                args.trim_matches(|c| c == '[' || c == ']' || c == '"')
            ))
        })
    }

    const METHODS: &[&str] = &["bash", "read"];

    #[test]
    fn basic_eval_and_console() {
        let log = Rc::new(Mutex::new(Vec::new()));
        let out = run_sandboxed(SandboxOptions::new(
            r#"console.log("hello", 1 + 1); return 40 + 2;"#,
            recording_host(log),
            METHODS,
        ));
        assert!(out.ok, "应当成功：{:?}", out.error);
        assert_eq!(out.value.as_deref(), Some("42"));
        assert!(out.stdout.contains("hello 2"), "stdout={:?}", out.stdout);
    }

    #[test]
    fn guest_can_await_and_call_host_repeatedly() {
        // 这正是 WebView 侧做不到的：一次执行里**多次**工具调用
        let log = Rc::new(Mutex::new(Vec::new()));
        let out = run_sandboxed(SandboxOptions::new(
            r#"
            const a = await sdk.bash("one");
            const b = await sdk.bash("two");
            const c = await sdk.read("three");
            return [a.echo, b.echo, c.echo];
            "#,
            recording_host(log.clone()),
            METHODS,
        ));
        assert!(out.ok, "应当成功：{:?}", out.error);
        assert_eq!(out.host_calls, 3, "宿主调用次数应当记到 3");
        let value = out.value.unwrap_or_default();
        assert!(value.contains("bash:one"), "value={value}");
        assert!(value.contains("bash:two"), "value={value}");
        assert!(value.contains("read:three"), "value={value}");
        assert_eq!(log.lock().unwrap().len(), 3);
    }

    #[test]
    fn host_error_is_catchable_and_readable() {
        let host: Rc<HostCall> = Rc::new(|_name: &str, _args: &str| Err("宿主拒绝了这次调用".to_string()));
        let out = run_sandboxed(SandboxOptions::new(
            r#"
            let caught = "none";
            try { await sdk.bash("x"); } catch (e) { caught = String(e && e.message ? e.message : e); }
            return caught;
            "#,
            host,
            METHODS,
        ));
        assert!(out.ok, "应当成功（错误被 guest catch）：{:?}", out.error);
        assert_eq!(out.value.as_deref(), Some("\"宿主拒绝了这次调用\""));
    }

    #[test]
    fn guest_error_is_reported_readably() {
        let log = Rc::new(Mutex::new(Vec::new()));
        let out = run_sandboxed(SandboxOptions::new(
            r#"throw new Error("我把参数写错了");"#,
            recording_host(log),
            METHODS,
        ));
        assert!(!out.ok);
        let error = out.error.unwrap_or_default();
        assert!(error.contains("我把参数写错了"), "error={error}");
        assert!(!error.contains("[object Object]"), "不许是 object：{error}");
    }

    #[test]
    fn infinite_loop_is_stopped_by_budget() {
        let log = Rc::new(Mutex::new(Vec::new()));
        let started = std::time::Instant::now();
        let out = run_sandboxed(SandboxOptions::new(r#"while (true) {}"#, recording_host(log), METHODS));
        assert!(!out.ok, "死循环必须被中断");
        assert!(out.budget_exceeded, "应当标记为超出预算：{:?}", out.error);
        assert!(
            started.elapsed().as_secs() < 30,
            "中断要及时（实际 {:?}）",
            started.elapsed()
        );
    }

    #[test]
    fn guest_is_isolated_from_host_globals() {
        let log = Rc::new(Mutex::new(Vec::new()));
        let out = run_sandboxed(SandboxOptions::new(
            r#"return [typeof process, typeof window, typeof require, typeof globalThis.__TAURI__].join(",");"#,
            recording_host(log),
            METHODS,
        ));
        assert!(out.ok, "应当成功：{:?}", out.error);
        assert_eq!(
            out.value.as_deref(),
            Some("\"undefined,undefined,undefined,undefined\"")
        );
    }

    #[test]
    fn host_call_limit_is_enforced() {
        let log = Rc::new(Mutex::new(Vec::new()));
        let mut options = SandboxOptions::new(
            r#"for (let i = 0; i < 5; i++) { try { await sdk.bash("x"); } catch (e) {} } return "done";"#,
            recording_host(log.clone()),
            METHODS,
        );
        options.host_call_limit = 2;
        let out = run_sandboxed(options);
        assert!(out.host_calls >= 3, "应当记录了超限的调用：{}", out.host_calls);
        assert_eq!(log.lock().unwrap().len(), 2, "宿主只应真正被调用 2 次");
    }

    // ========== 第 181 波：输出上限（对标 Pi 319fecb89） ==========

    /// 单行输出 + 一行换行的开销，是"有界"判据允许的余量
    const ONE_LINE: usize = 1024 * 1024 + 2;

    /// 判据 1：无界打印**不许**把宿主撑爆 —— 输出撞上限即中断，且缓冲留在上限附近。
    ///
    /// ⚠️ **机制要分清**（第一版判据在这里踩过坑）：`for(;;) console.log("")` 会先撞
    /// **循环迭代上限**（boa 的 1e6），那也是"有界"，但它**没有**验证输出上限这条新防线。
    /// 所以这里用**大行**（1 MiB）让输出先撞上限，并断言错误文案说的是"输出超出上限"
    /// 而不是"循环太久" —— 后者只证明旧防线还在。
    #[test]
    fn unbounded_printing_is_stopped_by_output_limit() {
        let log = Rc::new(Mutex::new(Vec::new()));
        let started = std::time::Instant::now();
        // ⚠️ 必须抬高高循环预算：`"x".repeat(1024*1024)` **本身就按字符计入循环迭代**
        // （实测：默认 1e6 预算下它直接抛"循环太久"，一个字都没打印）—— 那是**旧的**
        // 那道防线，不能用来验证新防线。这里把预算抬到 5e6，让输出真正先撞上限。
        let mut options = SandboxOptions::new(
            r#"const s = "x".repeat(1024 * 1024); for (;;) { console.log(s); }"#,
            recording_host(log),
            METHODS,
        );
        options.loop_limit = 5_000_000;
        let out = run_sandboxed(options);
        assert!(!out.ok, "无限打印必须被中断");
        assert!(
            out.budget_exceeded,
            "必须标记为超出预算（输出上限）：{:?}",
            out.error
        );
        let error = out.error.unwrap_or_default();
        assert!(
            error.contains("输出超出上限") || error.contains("output exceeded"),
            "错误必须说清是「输出超出上限」而不是「循环太久」：{error}"
        );
        assert!(
            out.stdout.len() <= MAX_OUTPUT_BYTES + ONE_LINE,
            "stdout 必须有界：实际 {} 字节，上限 {} + 一行",
            out.stdout.len(),
            MAX_OUTPUT_BYTES
        );
        assert!(
            out.stdout.len() >= MAX_OUTPUT_BYTES - ONE_LINE,
            "应当确实写到了上限附近（否则判据是假的）：实际 {} 字节",
            out.stdout.len()
        );
        assert!(
            started.elapsed().as_secs() < 60,
            "中断要及时（实际 {:?}）",
            started.elapsed()
        );
    }

    /// 判据 2：**反向对照** —— 正常量级的输出照常收集，一个字都不许被砍。
    #[test]
    fn normal_output_is_not_truncated() {
        let log = Rc::new(Mutex::new(Vec::new()));
        let out = run_sandboxed(SandboxOptions::new(
            r#"console.log("alpha"); console.log("beta"); return 1;"#,
            recording_host(log),
            METHODS,
        ));
        assert!(out.ok, "正常脚本应当成功：{:?}", out.error);
        assert!(
            out.stdout.contains("alpha") && out.stdout.contains("beta"),
            "正常输出不许被砍：{:?}",
            out.stdout
        );
    }

    /// 判据 3：**空串死循环**也必须有界。
    ///
    /// 注意这条与判据 1 的分工：空串循环**不会**撞输出上限（累计量很小），它会撞
    /// **循环迭代上限**。所以这里明确断言"有界性"这个事实本身（`budget_exceeded`
    /// + 出错），而不要求文案是"输出上限"—— 两条防线各自覆盖一类失控，缺一不可。
    #[test]
    fn empty_print_loop_is_also_bounded() {
        let log = Rc::new(Mutex::new(Vec::new()));
        let out = run_sandboxed(SandboxOptions::new(
            r#"for (;;) { console.log(""); }"#,
            recording_host(log),
            METHODS,
        ));
        assert!(
            !out.ok && out.budget_exceeded,
            "空串死循环也必须被中断（由循环迭代上限兜住）：ok={} budget={} err={:?}",
            out.ok,
            out.budget_exceeded,
            out.error
        );
        assert!(
            out.stdout.len() <= MAX_OUTPUT_BYTES + ONE_LINE,
            "空串循环的输出也必须是有界的：实际 {} 字节",
            out.stdout.len()
        );
    }

    /// 判据 4：**stderr 也记账**（两条流合计算，否则脚本交替写两个流就能绕过上限）。
    #[test]
    fn stderr_counts_towards_the_same_limit() {
        let log = Rc::new(Mutex::new(Vec::new()));
        let mut options = SandboxOptions::new(
            r#"const s = "y".repeat(1024 * 1024); for (;;) { console.error(s); }"#,
            recording_host(log),
            METHODS,
        );
        options.loop_limit = 5_000_000; // 同判据 1：让输出先撞上限，而不是先撞循环上限
        let out = run_sandboxed(options);
        assert!(
            !out.ok && out.budget_exceeded,
            "console.error 也必须受上限约束：ok={} budget={} err={:?}",
            out.ok,
            out.budget_exceeded,
            out.error
        );
        assert!(
            out.stderr.len() <= MAX_OUTPUT_BYTES + ONE_LINE,
            "stderr 必须有界：实际 {} 字节",
            out.stderr.len()
        );
        assert!(
            out.stderr.len() >= MAX_OUTPUT_BYTES - ONE_LINE,
            "应当确实写到了上限附近（否则判据是假的）：实际 {} 字节",
            out.stderr.len()
        );
    }
}
