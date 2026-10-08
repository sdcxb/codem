//! **Rust 侧 JS 沙箱的"会话"形态**：给动态插件用（第 104 波）。
//!
//! ## 为什么需要"会话"（而不是一次一跑）
//!
//! `js_sandbox::run_sandboxed` 是"跑一段代码、拿一个值、结束"。动态插件不行：
//!
//! ```js
//! module.exports = (ctx) => { ctx.provide('myService', { hello: () => 'world' }) }
//! ```
//!
//! `provide` 交出去的是**带函数的服务** —— 宿主之后要**回调**那个 `hello()`。
//! 于是必须：①环境活着（`Context` 不能销毁）；②能按 handle 调回 guest 的函数。
//!
//! ## 线程模型（boa 的 `Context` 不是 `Send`）
//!
//! 每个会话一个**专属线程**：线程里持有 `Context` 与"handle → JsValue"表，
//! 外部通过 `mpsc` 发命令（求值 / 调函数 / 关闭）。这样既满足 `!Send`，
//! 又让"宿主调用"可以在这条线程上**阻塞**等前端回复（与 `run_sandboxed` 同一套桥）。
//!
//! ## thread_local 的用法
//!
//! 会话线程里的原生函数（`__hostCall` / `provide` / `log`）靠 thread_local 拿到
//! "宿主桥 + handle 表" —— 每个会话独占一条线程，所以这是安全的（与 `js_sandbox.rs` 同一手法）。
use boa_engine::{js_string, native_function::NativeFunction, Context, JsValue, Source};
use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::mpsc::{self, Sender};
use std::sync::Arc;
use std::thread::JoinHandle;

/// 会话版宿主调用：**必须 Send + Sync**（会话在自己的线程里跑，闭包要跨线程）
///
/// 生产里它捕获的是 Tauri 的 `AppHandle`（Send + Sync），内部阻塞等前端回复 ✓；
/// 单发版（`js_sandbox::HostCall`）用 `Rc` 就够，因为它跑在调用者的线程上。
pub type SendHostCall = dyn Fn(&str, &str) -> Result<String, String> + Send + Sync;

/// 发给会话线程的命令
pub enum SessionCommand {
    /// 求值一段表达式，把结果（JSON）带回来
    Eval {
        expression: String,
        reply: Sender<Result<String, String>>,
    },
    /// 调用 guest 里某个函数（按 handle），参数是 JSON 数组
    CallFunction {
        handle: u32,
        args_json: String,
        reply: Sender<Result<String, String>>,
    },
    /// 关掉会话（线程退出）
    Close { reply: Sender<()> },
}

/// 会话句柄（外部拿它发命令）
pub struct SessionHandle {
    tx: Sender<SessionCommand>,
    join: Option<JoinHandle<()>>,
}

impl SessionHandle {
    /// 求值（同步阻塞，直到 guest 返回）
    ///
    /// Tauri 命令走 `handle.tx` 直接发命令（少包一层），所以这里标注允许未使用；
    /// 判据用它，内部也用它 —— 两条路最终都汇到同一条命令通道。
    #[allow(dead_code)]
    pub fn eval(&self, expression: &str) -> Result<String, String> {
        let (tx, rx) = mpsc::channel();
        self.tx
            .send(SessionCommand::Eval {
                expression: expression.to_string(),
                reply: tx,
            })
            .map_err(|_| "会话已关闭".to_string())?;
        rx.recv().map_err(|_| "会话线程没有回复".to_string())?
    }

    /// 调用 guest 函数（宿主侧的服务代理走这里）
    #[allow(dead_code)]
    pub fn call_function(&self, handle: u32, args_json: &str) -> Result<String, String> {
        let (tx, rx) = mpsc::channel();
        self.tx
            .send(SessionCommand::CallFunction {
                handle,
                args_json: args_json.to_string(),
                reply: tx,
            })
            .map_err(|_| "会话已关闭".to_string())?;
        rx.recv().map_err(|_| "会话线程没有回复".to_string())?
    }

    /// 关闭会话并等线程退出
    pub fn close(&mut self) {
        let (tx, rx) = mpsc::channel();
        if self.tx.send(SessionCommand::Close { reply: tx }).is_ok() {
            let _ = rx.recv_timeout(std::time::Duration::from_secs(5));
        }
        if let Some(join) = self.join.take() {
            let _ = join.join();
        }
    }
}

impl Drop for SessionHandle {
    fn drop(&mut self) {
        // 忘了 close 也不能泄漏线程
        if self.join.is_some() {
            self.close();
        }
    }
}

// 会话里被宿主引用的 guest 函数（provide 交出去的那些）
thread_local! {
    static HANDLES: RefCell<HashMap<u32, JsValue>> = RefCell::new(HashMap::new());
    static NEXT_HANDLE: RefCell<u32> = const { RefCell::new(1) };
    static HOST: RefCell<Option<Arc<SendHostCall>>> = const { RefCell::new(None) };
    static LOGS: RefCell<String> = const { RefCell::new(String::new()) };
    /// 会话日志的**记账**（★ 第 185 波）：已收字节数 / 已收行数 / 是否已截断。
    ///
    /// 改前只有 `LOGS` 一个无界 `String`：动态插件只要周期性 `console.log`，
    /// 一次会话就能把宿主内存吃光（Boa context + 这份日志双份持有），而这份日志
    /// **全仓库没有任何消费方** ⇒ 代价全付、信息为零。
    static LOG_BYTES: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    static LOG_LINES: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    /// ★ **截断标记**：撞上限时置位 ⇒ "日志不完整"这件事能被调用方看到（不许静默丢弃）。
    static LOG_TRUNCATED: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// 会话日志的字节上限：与 `js_sandbox.rs::MAX_OUTPUT_BYTES` **同一个数（16 MiB）**。
///
/// ## 为什么必须与单发执行那条路同口径
///
/// 这是**同一类东西的两份实现**（会话版 vs 单发版）。单发版第 181 波已经用 16 MiB
/// 挡住"脚本把宿主内存吃光"；会话版漏了 ⇒ 同一份漏洞在另一条路上继续活着。
pub const MAX_LOG_BYTES: usize = 16 * 1024 * 1024;

/// 会话日志的**行数**上限（第二条闸门）。
///
/// 字节上限已经保证内存有界；这条挡的是"极短行"的病态形态（`console.log('')` 死循环）：
/// 16 MiB 的字节预算放得下上千万行，而每行都要过一次 push + 一次记账，白白拖慢沙箱线程。
/// 20 万行远超任何真实插件的诊断需要。
pub const MAX_LOG_LINES: usize = 200_000;

/// 会话里 guest 函数（handle）的条数上限。
///
/// ## 为什么必须有（改前既无上限、又从不淘汰）
///
/// 每次 `ctx.provide(name, service)` 都会把 service 的每个**函数属性**登记进 `HANDLES`；
/// 而 `JsValue` 是 Boa 的 GC 根 ⇒ 只要它还在这张表里，那个函数对象就**永不回收**。
/// 插件在 `run()` 里循环 `ctx.provide('x'+i, { f(){} })` 就能把宿主内存吃光 ——
/// 这是"漏掉的孪生实现"里的第二条向量（第一条是上面的 LOGS）。
///
/// ## 为什么是"撞上限就地报错"而不是淘汰旧的
///
/// 淘汰（LRU / 环形）会让**已经发给前端的 handle 失效**：前端还按描述符回调那个函数，
/// 失效之后错误发生在很久以后、且现场对不上原因（典型的静默降级）。
/// 4096 远超真实插件所需（一个插件通常 1~20 个服务函数），撞上就是代码本身有问题，
/// 所以这里选择立刻、就地、可读地拒绝。
pub const MAX_HANDLES: usize = 4096;

/// 撞上限时的错误文案（写进 `__jsvmError` ⇒ guest 的 `ctx.provide` 会 throw）。
fn log_limit_message() -> String {
    format!(
        "沙箱会话的 console 输出已达上限（{MAX_LOG_BYTES} 字节 / {MAX_LOG_LINES} 行）——\
         后续输出不再记录（这一次会话的日志已被截断，不是完整日志）。请打印摘要。"
    )
}

fn handle_limit_message() -> String {
    format!(
        "沙箱会话登记的 guest 函数已达上限（{MAX_HANDLES} 个）——\
         已拒绝本次 ctx.provide（不静默丢弃：描述符没有发出去，前端不会拿到失效 handle）。"
    )
}

/// 容量判定：`live + incoming > MAX_HANDLES` ⇒ 拒绝本次 `ctx.provide`。
///
/// 抽成纯函数是为了能被判据直接钉住（真机路径要循环 provide 四千多次才触发）。
fn handle_capacity_exceeded(live: usize, incoming: usize) -> bool {
    live.saturating_add(incoming) > MAX_HANDLES
}

/// 往会话日志里追加一行，**带记账与截断标记**。
///
/// 返回 `Err` 表示撞到上限（`log_entry` 把它变成 JS 异常：guest 的 try/catch 拦得住，
/// 而"输出被限制"这件事已经写进错误文案与 `LOG_TRUNCATED` —— 与 `js_sandbox.rs`
/// 的 `push_to` 同一口径：**报错 + 标记**，不是静默丢掉）。
///
/// 抽成"可注入上限"的纯函数是为了能被判据直接钉住（不必真写 16 MiB）。
#[allow(clippy::too_many_arguments)]
fn push_log_bounded_with(
    sink: &RefCell<String>,
    used_bytes: &std::cell::Cell<usize>,
    used_lines: &std::cell::Cell<usize>,
    truncated: &std::cell::Cell<bool>,
    max_bytes: usize,
    max_lines: usize,
    text: &str,
) -> Result<(), String> {
    if truncated.get() {
        // 已截断：后续行**连记账都不做**（内存与 CPU 都不再增长）
        return Err(log_limit_message());
    }
    let bytes = used_bytes.get().saturating_add(text.len() + 1);
    let lines = used_lines.get().saturating_add(1);
    if bytes > max_bytes || lines > max_lines {
        truncated.set(true);
        used_bytes.set(bytes);
        used_lines.set(lines);
        // ★ 如实标记：留一条说明行（它本身也计入上限附近的少量开销），
        //   而不是"看起来日志到这儿就正常结束了"。
        let marker = format!(
            "[js-sandbox-session] console 输出已达上限（{max_bytes} 字节 / {max_lines} 行）——\
             本会话共记录 {lines} 行；**后续输出已被丢弃**，这不是完整日志。"
        );
        {
            let mut s = sink.borrow_mut();
            s.push_str(&marker);
            s.push('\n');
        }
        return Err(log_limit_message());
    }
    used_bytes.set(bytes);
    used_lines.set(lines);
    let mut s = sink.borrow_mut();
    s.push_str(text);
    s.push('\n');
    Ok(())
}

/// 生产口径的入口：用 `MAX_LOG_BYTES` / `MAX_LOG_LINES` 记账。
///
/// 注意这里必须是**嵌套 `with`**（`with` 闭包给的是 `&Cell<..>` 本身）：
/// 若改成 `c.clone()` 就会拿到一份**副本**去记账 ⇒ 上限永远撞不到（假修复）。
fn push_log(text: &str) -> Result<(), String> {
    LOGS.with(|sink| {
        LOG_BYTES.with(|bytes| {
            LOG_LINES.with(|lines| {
                LOG_TRUNCATED.with(|truncated| {
                    push_log_bounded_with(
                        sink,
                        bytes,
                        lines,
                        truncated,
                        MAX_LOG_BYTES,
                        MAX_LOG_LINES,
                        text,
                    )
                })
            })
        })
    })
}

/// 取走当前会话日志，**并把"是否被截断"一起返回**。
///
/// 为什么必须一起返回：只给文本的话，调用方会把它当成完整日志（静默降级）。
/// 生产消费方是会话收到 `Close`（`js_sandbox_close` → `SessionHandle::close`）之后
/// 在**会话线程上**跑的那条运行时日志；判据也直接用它。
///
/// ⚠️ 只能在会话**自己的线程**上调用（thread_local 语义）——在别的线程取只会拿到空串。
pub fn take_session_logs() -> (String, bool) {
    let text = LOGS.with(|l| std::mem::take(&mut *l.borrow_mut()));
    let truncated = LOG_TRUNCATED.with(|c| c.replace(false));
    LOG_BYTES.with(|c| c.set(0));
    LOG_LINES.with(|c| c.set(0));
    (text, truncated)
}

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

/// 把 `push_log` 的失败变成 JS 侧可捕获的异常（与 `js_sandbox.rs::output_error` 同形）。
fn log_output_error(message: String) -> boa_engine::JsError {
    boa_engine::JsNativeError::error().with_message(message).into()
}

/// `console.log` → 会话日志（★ 第 185 波：**带上限与截断标记**，见 `push_log`）
fn log_entry(_this: &JsValue, args: &[JsValue], ctx: &mut Context) -> boa_engine::JsResult<JsValue> {
    let mut line = String::new();
    for (i, arg) in args.iter().enumerate() {
        if i > 0 {
            line.push(' ');
        }
        line.push_str(
            &arg.to_string(ctx)
                .map(|s| s.to_std_string_escaped())
                .unwrap_or_else(|_| "?".to_string()),
        );
    }
    // 撞上限 ⇒ 变成 JS 异常（guest 的 try/catch 拦得住），同时 `LOG_TRUNCATED` 已置位 ⇒
    // "日志被截断"对调用方可见。**不是**静默丢弃（与 js_sandbox.rs 的 push_to 同口径）。
    push_log(&line).map_err(log_output_error)?;
    Ok(JsValue::undefined())
}

/// `__hostCall(name, argsJson)`：与 `js_sandbox.rs` 同一套桥（阻塞等前端回复）
fn host_call_entry(_this: &JsValue, args: &[JsValue], _ctx: &mut Context) -> boa_engine::JsResult<JsValue> {
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
    let host = HOST.with(|h| h.borrow().clone());
    let Some(host) = host else {
        return Ok(JsValue::from(js_string!(r#"{"__jsvmError":"宿主未就绪"}"#)));
    };
    match host(&name, &payload) {
        Ok(json) => Ok(JsValue::from(js_string!(json.as_str()))),
        Err(message) => Ok(JsValue::from(js_string!(
            format!(r#"{{"__jsvmError":"{}"}}"#, json_escape(&message)).as_str()
        ))),
    }
}

/// `ctx.provide(name, service)`：把服务交给宿主；**函数属性**登记为 handle 供宿主回调。
fn provide_entry(_this: &JsValue, args: &[JsValue], ctx: &mut Context) -> boa_engine::JsResult<JsValue> {
    let name = args
        .first()
        .and_then(|v| v.as_string())
        .map(|s| s.to_std_string_escaped())
        .unwrap_or_default();
    let Some(service) = args.get(1) else {
        return Ok(JsValue::from(js_string!(
            r#"{"__jsvmError":"ctx.provide(name, service) 需要两个参数"}"#
        )));
    };

    // 拆成"函数 → handle"与"数据 → JSON"
    let mut functions: Vec<(String, u32)> = Vec::new();
    // ★ 第 185 波：先收集再登记（**先查容量后插表**），避免"登记了一半、描述符没发出去"
    //   之后那半张表成了谁也调不到的孤儿。
    let mut pending_functions: Vec<(String, JsValue)> = Vec::new();
    let mut data = serde_json::Map::new();
    if let Some(obj) = service.as_object() {
        let keys = obj.own_property_keys(ctx).unwrap_or_default();
        for key in keys {
            let key_str = match &key {
                boa_engine::property::PropertyKey::String(s) => s.to_std_string_escaped(),
                boa_engine::property::PropertyKey::Index(i) => i.get().to_string(),
                // 符号键（Symbol）在沙箱里不参与服务面
                _ => continue,
            };
            if key_str.starts_with("__") {
                continue;
            }
            let Ok(value) = obj.get(js_string!(key_str.as_str()), ctx) else {
                continue;
            };
            if value.as_callable().is_some() {
                pending_functions.push((key_str, value));
            } else if let Ok(Some(json)) = value.to_json(ctx) {
                data.insert(key_str, json);
            }
        }
    } else if let Ok(Some(json)) = service.to_json(ctx) {
        // 不是对象（数字/字符串/数组）：整份当数据
        data.insert("value".to_string(), json);
    }

    /*
     * ★ 第 185 波（R6）：handle 表**必须有上限**，撞上限要**明确失败**。
     *
     * 改前 `HANDLES` 只增不减（每个 `ctx.provide` 都插新 handle，从不淘汰），
     * 而表里的 `JsValue` 是 Boa 的 GC 根 ⇒ 插件循环 provide 就能把宿主内存吃光。
     * 这里在**插入之前**判断容量，超了就返回 `__jsvmError`（前端会看到明确失败，
     * 而不是拿到一个指向已失效 handle 的描述符）。
     */
    let live = HANDLES.with(|h| h.borrow().len());
    if handle_capacity_exceeded(live, pending_functions.len()) {
        return Ok(JsValue::from(js_string!(
            format!(
                r#"{{"__jsvmError":"{}"}}"#,
                json_escape(&handle_limit_message())
            )
            .as_str()
        )));
    }
    for (key_str, value) in pending_functions {
        let handle = NEXT_HANDLE.with(|n| {
            let mut n = n.borrow_mut();
            let id = *n;
            *n += 1;
            id
        });
        HANDLES.with(|h| h.borrow_mut().insert(handle, value));
        functions.push((key_str, handle));
    }

    let descriptor = serde_json::json!({
        "name": name,
        "functions": functions
            .iter()
            .map(|(k, v)| (k.clone(), serde_json::Value::from(*v)))
            .collect::<serde_json::Map<String, serde_json::Value>>(),
        "data": serde_json::Value::Object(data),
    });
    let host = HOST.with(|h| h.borrow().clone());
    let Some(host) = host else {
        return Ok(JsValue::from(js_string!(r#"{"__jsvmError":"宿主未就绪"}"#)));
    };
    match host("__provide", &descriptor.to_string()) {
        Ok(json) => Ok(JsValue::from(js_string!(json.as_str()))),
        Err(message) => Ok(JsValue::from(js_string!(
            format!(r#"{{"__jsvmError":"{}"}}"#, json_escape(&message)).as_str()
        ))),
    }
}

/// 沙箱里**不支持**的 Cordis ctx 面：给一句能看懂的话，而不是 `undefined is not a function`
fn unsupported_message(name: &str) -> String {
    format!(
        r#"{{"__jsvmError":"沙箱化的动态插件里不支持 ctx.{name}()；请只使用 ctx.provide() 与 console.log()"}}"#
    )
}

fn unsupported_get(_this: &JsValue, _args: &[JsValue], _ctx: &mut Context) -> boa_engine::JsResult<JsValue> {
    Ok(JsValue::from(js_string!(unsupported_message("get").as_str())))
}

fn unsupported_on(_this: &JsValue, _args: &[JsValue], _ctx: &mut Context) -> boa_engine::JsResult<JsValue> {
    Ok(JsValue::from(js_string!(unsupported_message("on").as_str())))
}

/// 打开一个会话：在专属线程里建 `Context`、跑插件代码、把 `module.exports` 留在 guest 里。
///
/// @param code   插件代码（形如 `module.exports = (ctx) => { ... }`）
/// @param host   宿主调用实现（生产里是"发事件 → 等前端回复"）
/// @param budget 循环迭代上限（防插件代码死循环）
pub fn open_session(code: String, host: Arc<SendHostCall>, budget: u64) -> Result<SessionHandle, String> {
    let (ready_tx, ready_rx) = mpsc::channel::<Result<(), String>>();
    let (cmd_tx, cmd_rx) = mpsc::channel::<SessionCommand>();

    let join = std::thread::Builder::new()
        .name("js-sandbox-session".to_string())
        .spawn(move || {
            HOST.with(|h| *h.borrow_mut() = Some(host));
            LOGS.with(|l| l.borrow_mut().clear());
            // ★ 第 185 波：记账与截断标记也要跟着会话一起重置（否则上个会话的
            // "已截断"会**误报**到新会话上 —— 那是假事实）。
            LOG_BYTES.with(|c| c.set(0));
            LOG_LINES.with(|c| c.set(0));
            LOG_TRUNCATED.with(|c| c.set(false));
            HANDLES.with(|h| h.borrow_mut().clear());
            NEXT_HANDLE.with(|n| *n.borrow_mut() = 1);

            let mut context = Context::default();
            context.runtime_limits_mut().set_loop_iteration_limit(budget);

            let _ = context.register_global_callable(js_string!("__log"), 0, NativeFunction::from_fn_ptr(log_entry));
            let _ = context.register_global_callable(js_string!("__hostCall"), 2, NativeFunction::from_fn_ptr(host_call_entry));
            let _ = context.register_global_callable(js_string!("__provide"), 2, NativeFunction::from_fn_ptr(provide_entry));
            let _ = context.register_global_callable(js_string!("__unsupportedGet"), 0, NativeFunction::from_fn_ptr(unsupported_get));
            let _ = context.register_global_callable(js_string!("__unsupportedOn"), 0, NativeFunction::from_fn_ptr(unsupported_on));

            // 预置：console / 一个"最小可用"的 ctx（provide + log；其余给可读错误）
            let prelude = r#"
globalThis.console = { log: __log, info: __log, warn: __log, error: __log };
globalThis.module = { exports: {} };
globalThis.exports = globalThis.module.exports;
globalThis.ctx = {
  provide: function (name, service) {
    const raw = __provide(String(name), service);
    const out = JSON.parse(raw);
    if (out && out.__jsvmError) throw new Error(String(out.__jsvmError));
    return function () {};
  },
  get: function () { const raw = __unsupportedGet(); const out = JSON.parse(raw); throw new Error(String(out.__jsvmError)); },
  on: function () { const raw = __unsupportedOn(); const out = JSON.parse(raw); throw new Error(String(out.__jsvmError)); },
};
"#;
            if let Err(error) = context.eval(Source::from_bytes(prelude.as_bytes())) {
                let _ = ready_tx.send(Err(format!("预置失败：{error}")));
                return;
            }
            if let Err(error) = context.eval(Source::from_bytes(code.as_bytes())) {
                let _ = ready_tx.send(Err(format!("插件代码编译/执行失败：{error}")));
                return;
            }
            if let Err(error) = context.run_jobs() {
                let _ = ready_tx.send(Err(format!("插件代码的异步任务失败：{error}")));
                return;
            }
            let _ = ready_tx.send(Ok(()));

            // ---- 命令循环 ----
            for command in cmd_rx {
                match command {
                    SessionCommand::Eval { expression, reply } => {
                        let result = context
                            .eval(Source::from_bytes(expression.as_bytes()))
                            .map_err(|error| error.to_string())
                            .and_then(|value| {
                                let _ = context.run_jobs();
                                settle_to_json(&value, &mut context)
                            });
                        let _ = reply.send(result);
                    }
                    SessionCommand::CallFunction {
                        handle,
                        args_json,
                        reply,
                    } => {
                        let result = call_guest_function(&mut context, handle, &args_json);
                        let _ = reply.send(result);
                    }
                    SessionCommand::Close { reply } => {
                        let _ = reply.send(());
                        break;
                    }
                }
            }
            /*
             * ★ 第 185 波（R6）：会话结束时把这份日志的**事实**落盘。
             *
             * 改前 `LOGS` 全仓库只有"clear"与"push"两处引用 —— **零消费方**：
             * 插件刷了几百万行，代价全付、信息为零。这里在**会话线程上**（thread_local
             * 只有本线程看得到）取一次，把"多少字节 / 是否被截断"写进运行时日志；
             * 只取事实、不转储全文（16 MiB 灌进日志文件毫无意义）。
             */
            let (logs, truncated) = take_session_logs();
            if !logs.is_empty() || truncated {
                crate::runtime_log::append_line(
                    "INFO",
                    &format!(
                        "js 沙箱会话结束：console 输出 {} 字节 / {} 行{}",
                        logs.len(),
                        logs.lines().count(),
                        if truncated {
                            "（**已截断**：这不是完整日志）"
                        } else {
                            ""
                        }
                    ),
                );
            }
            HANDLES.with(|h| h.borrow_mut().clear());
        })
        .map_err(|error| format!("无法创建沙箱线程：{error}"))?;

    match ready_rx.recv_timeout(std::time::Duration::from_secs(30)) {
        Ok(Ok(())) => Ok(SessionHandle {
            tx: cmd_tx,
            join: Some(join),
        }),
        Ok(Err(message)) => {
            let _ = join.join();
            Err(message)
        }
        Err(_) => Err("沙箱会话初始化超时".to_string()),
    }
}

/// 调用 guest 里的函数（按 handle），参数是 JSON 数组；返回值 JSON 化。
fn call_guest_function(context: &mut Context, handle: u32, args_json: &str) -> Result<String, String> {
    let callable = HANDLES.with(|h| h.borrow().get(&handle).cloned());
    let Some(callable) = callable else {
        return Err(format!("没有编号 {handle} 的 guest 函数（可能已被回收）"));
    };
    let parsed: Vec<serde_json::Value> = serde_json::from_str(args_json).unwrap_or_default();
    let mut args: Vec<JsValue> = Vec::with_capacity(parsed.len());
    for value in parsed {
        args.push(JsValue::from_json(&value, context).map_err(|error| error.to_string())?);
    }
    let this = JsValue::undefined();
    let result = callable
        .as_callable()
        .ok_or_else(|| "该 handle 不是函数".to_string())?
        .call(&this, &args, context)
        .map_err(|error| error.to_string())?;
    let _ = context.run_jobs();
    settle_to_json(&result, context)
}

/// 把结果 JSON 化（Promise 则先推进 job 再看结算值）
fn settle_to_json(value: &JsValue, context: &mut Context) -> Result<String, String> {
    let settled: JsValue = if let Some(promise) = value.as_promise() {
        match promise.state() {
            boa_engine::builtins::promise::PromiseState::Fulfilled(v) => v,
            boa_engine::builtins::promise::PromiseState::Rejected(reason) => {
                return Err(reason
                    .to_string(context)
                    .map(|s| s.to_std_string_escaped())
                    .unwrap_or_else(|_| "guest 抛出了不可读的错误".to_string()));
            }
            boa_engine::builtins::promise::PromiseState::Pending => {
                return Err("guest 留下了一个未结算的 Promise".to_string());
            }
        }
    } else {
        value.clone()
    };
    match settled.to_json(context) {
        Ok(Some(json)) => Ok(json.to_string()),
        Ok(None) => Ok("null".to_string()),
        Err(error) => Err(format!("返回值无法序列化：{error}")),
    }
}

// =====================================================================================
// Tauri 侧：会话命令（动态插件用）
// =====================================================================================

use crate::js_sandbox::{HostCallRequest, PendingHostCalls};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

/// 活着的沙箱会话表
#[derive(Default)]
pub struct SandboxSessions(pub Mutex<HashMap<u64, SessionHandle>>);

static NEXT_SESSION_ID: AtomicU64 = AtomicU64::new(1);

/// 给会话用的宿主桥：与 `js_sandbox::js_run_sandboxed` **同一套**事件/回复协议
/// （前端那边只需要一个监听器，两种形态共用）。
fn session_host_call(app: AppHandle, session_id: u64) -> Arc<SendHostCall> {
    Arc::new(move |name: &str, args: &str| -> Result<String, String> {
        let state = app.state::<PendingHostCalls>();
        let id = {
            static NEXT_CALL: AtomicU64 = AtomicU64::new(1);
            NEXT_CALL.fetch_add(1, Ordering::Relaxed)
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
            session_id: Some(session_id),
        };
        if let Err(error) = app.emit("jsvm://host-call", request) {
            if let Ok(mut pending) = state.0.lock() {
                pending.remove(&id);
            }
            return Err(format!("无法把调用发给前端：{error}"));
        }
        match rx.recv_timeout(std::time::Duration::from_secs(60)) {
            Ok(result) => result,
            Err(_) => {
                if let Ok(mut pending) = state.0.lock() {
                    pending.remove(&id);
                }
                Err(format!("调用超时（60s）：前端没有回复 {name}"))
            }
        }
    })
}

/// 打开一个插件会话：跑插件代码（`module.exports = (ctx) => {...}`），返回会话 id。
#[tauri::command]
pub async fn js_sandbox_open(
    app: AppHandle,
    sessions: State<'_, SandboxSessions>,
    code: String,
    loop_limit: Option<u64>,
) -> Result<u64, String> {
    // 会话 id 要在建会话**之前**定下来（宿主回调里要带它，前端据此路由 `__provide`）
    let session_id = NEXT_SESSION_ID.fetch_add(1, Ordering::Relaxed);
    let host = session_host_call(app, session_id);
    let budget = loop_limit.unwrap_or(2_000_000);
    let handle = tauri::async_runtime::spawn_blocking(move || open_session(code, host, budget))
        .await
        .map_err(|error| format!("打开会话的线程失败：{error}"))??;
    let mut map = sessions.0.lock().map_err(|e| format!("内部错误：{e}"))?;
    map.insert(session_id, handle);
    Ok(session_id)
}

/// 求值（给插件工厂/`run` 用）
#[tauri::command]
pub async fn js_sandbox_eval(
    sessions: State<'_, SandboxSessions>,
    session_id: u64,
    expression: String,
) -> Result<String, String> {
    let tx = {
        let map = sessions.0.lock().map_err(|e| format!("内部错误：{e}"))?;
        map.get(&session_id).map(|handle| handle.tx.clone())
    };
    let Some(tx) = tx else {
        return Err(format!("没有会话 {session_id}"));
    };
    tauri::async_runtime::spawn_blocking(move || {
        let (reply_tx, reply_rx) = mpsc::channel();
        tx.send(SessionCommand::Eval {
            expression,
            reply: reply_tx,
        })
        .map_err(|_| "会话已关闭".to_string())?;
        reply_rx.recv().map_err(|_| "会话线程没有回复".to_string())?
    })
    .await
    .map_err(|error| format!("求值线程失败：{error}"))?
}

/// **调用 guest 里的函数**（宿主侧的服务代理走这里）：`provide` 交出去的函数由它回调。
#[tauri::command]
pub async fn js_sandbox_call_function(
    sessions: State<'_, SandboxSessions>,
    session_id: u64,
    handle: u32,
    args_json: Option<String>,
) -> Result<String, String> {
    let tx = {
        let map = sessions.0.lock().map_err(|e| format!("内部错误：{e}"))?;
        map.get(&session_id).map(|handle| handle.tx.clone())
    };
    let Some(tx) = tx else {
        return Err(format!("没有会话 {session_id}"));
    };
    let args = args_json.unwrap_or_else(|| "[]".to_string());
    tauri::async_runtime::spawn_blocking(move || {
        let (reply_tx, reply_rx) = mpsc::channel();
        tx.send(SessionCommand::CallFunction {
            handle,
            args_json: args,
            reply: reply_tx,
        })
        .map_err(|_| "会话已关闭".to_string())?;
        reply_rx.recv().map_err(|_| "会话线程没有回复".to_string())?
    })
    .await
    .map_err(|error| format!("调用线程失败：{error}"))?
}

/// 关闭会话（插件被 retract 时）
#[tauri::command]
pub async fn js_sandbox_close(
    sessions: State<'_, SandboxSessions>,
    session_id: u64,
) -> Result<bool, String> {
    let handle = {
        let mut map = sessions.0.lock().map_err(|e| format!("内部错误：{e}"))?;
        map.remove(&session_id)
    };
    match handle {
        Some(mut handle) => {
            tauri::async_runtime::spawn_blocking(move || handle.close())
                .await
                .map_err(|error| format!("关闭线程失败：{error}"))?;
            Ok(true)
        }
        None => Ok(false),
    }
}

// =====================================================================================
// 判据（Rust 侧：会话语义；命令与前端桥由 TS 判据 + 真机探针覆盖）
// =====================================================================================

#[cfg(test)]
mod js_sandbox_session_tests {
    use super::*;
    use std::sync::Mutex;

    /// 宿主桥：记录调用；`__provide` 回 `{"ok":true}`，其它回 mock 结果
    fn recording_host(log: Arc<Mutex<Vec<(String, String)>>>) -> Arc<SendHostCall> {
        Arc::new(move |name: &str, args: &str| {
            log.lock().unwrap().push((name.to_string(), args.to_string()));
            Ok(r#"{"ok":true}"#.to_string())
        })
    }

    #[test]
    fn plugin_can_export_factory_and_provide_pure_data() {
        let log = Arc::new(Mutex::new(Vec::new()));
        let mut session = open_session(
            r#"
            module.exports = (ctx) => {
              ctx.provide("calc", { version: 2, name: "calculator" });
              return { run: (args) => ({ doubled: (args && args.n ? args.n : 0) * 2 }) };
            };
            "#.to_string(),
            recording_host(log.clone()),
            1_000_000,
        )
        .expect("会话应当打开");

        // 调用导出的工厂（`module.exports` 是个函数），再调用它返回对象的 run
        let factory = session.eval("typeof module.exports").unwrap();
        assert_eq!(factory, "\"function\"");
        let provided = session
            .eval("(function(){ const plugin = module.exports(ctx); return plugin.run({ n: 21 }); })()")
            .unwrap();
        assert!(provided.contains("42"), "provided={provided}");

        // 宿主应当收到过 `__provide`，并且描述符里带服务名与数据
        let calls = log.lock().unwrap();
        let provide = calls.iter().find(|(name, _)| name == "__provide").expect("应当收到 __provide");
        assert!(provide.1.contains("\"calc\""), "descriptor={}", provide.1);
        assert!(provide.1.contains("calculator"), "descriptor={}", provide.1);
        session.close();
    }

    #[test]
    fn provided_functions_are_callable_from_host() {
        let log = Arc::new(Mutex::new(Vec::new()));
        let mut session = open_session(
            r#"
            module.exports = (ctx) => {
              ctx.provide("greeter", { hello: (name) => "hello " + name, pure: 7 });
            };
            "#.to_string(),
            recording_host(log.clone()),
            1_000_000,
        )
        .unwrap();
        session.eval("module.exports(ctx)").unwrap();

        // 从宿主侧描述符里拿到 handle，然后**回调 guest 的函数**
        let descriptor = log
            .lock()
            .unwrap()
            .iter()
            .find(|(name, _)| name == "__provide")
            .map(|(_, args)| args.clone())
            .expect("应当收到 __provide");
        let parsed: serde_json::Value = serde_json::from_str(&descriptor).unwrap();
        let handle = parsed["functions"]["hello"].as_u64().expect("应当登记 hello 的 handle") as u32;

        let out = session.call_function(handle, r#"["world"]"#).unwrap();
        assert_eq!(out, "\"hello world\"", "宿主回调 guest 函数应当拿到值");
        session.close();
    }

    #[test]
    fn plugin_error_is_reported_and_session_fails_to_open() {
        let log = Arc::new(Mutex::new(Vec::new()));
        let error = open_session("this is not js !!".to_string(), recording_host(log), 1_000_000)
            .err()
            .expect("语法错误应当打不开会话");
        assert!(error.contains("插件代码"), "error={error}");
    }

    #[test]
    fn plugin_infinite_loop_is_stopped_by_budget() {
        // 形态 ①：**加载时**就死循环（模块顶层）
        let log = Arc::new(Mutex::new(Vec::new()));
        let started = std::time::Instant::now();
        let error = open_session("while (true) {}".to_string(), recording_host(log), 200_000)
            .err()
            .expect("顶层死循环应当被预算中断");
        assert!(error.contains("插件代码"), "error={error}");
        assert!(started.elapsed().as_secs() < 30, "中断要及时");

        // 形态 ②：死循环在**工厂函数里**（加载时只是定义，调用时才跑）——
        // 第一版判据只测了形态 ①，于是 `.err()` 在"会话正常打开"时 panic。
        // 两种形态都要钉：加载期与调用期都不能把应用卡死。
        let log = Arc::new(Mutex::new(Vec::new()));
        let mut session = open_session(
            "module.exports = (ctx) => { while (true) {} };".to_string(),
            recording_host(log),
            200_000,
        )
        .expect("只定义函数，加载应当成功");
        let started = std::time::Instant::now();
        let call_error = session
            .eval("module.exports(ctx)")
            .err()
            .expect("调用期死循环应当被预算中断");
        assert!(
            call_error.contains("RuntimeLimit") || call_error.contains("iteration"),
            "错误里应当点明是预算：{call_error}"
        );
        assert!(started.elapsed().as_secs() < 30, "调用期中断也要及时");
        session.close();
    }

    #[test]
    fn unsupported_ctx_surface_gives_readable_error() {
        let log = Arc::new(Mutex::new(Vec::new()));
        let mut session = open_session(
            r#"module.exports = (ctx) => { ctx.get("other"); };"#.to_string(),
            recording_host(log),
            1_000_000,
        )
        .unwrap();
        let out = session.eval("(function(){ try { module.exports(ctx); return 'no-throw'; } catch (e) { return String(e.message || e); } })()").unwrap();
        assert!(out.contains("不支持 ctx.get"), "out={out}");
        session.close();
    }

    #[test]
    fn guest_cannot_see_host_globals_and_close_is_clean() {
        let log = Arc::new(Mutex::new(Vec::new()));
        let mut session = open_session(
            "module.exports = () => {};".to_string(),
            recording_host(log),
            1_000_000,
        )
        .unwrap();
        let out = session
            .eval("[typeof process, typeof window, typeof require, typeof globalThis.__TAURI__].join(',')")
            .unwrap();
        assert_eq!(out, "\"undefined,undefined,undefined,undefined\"");
        session.close();
        // 关闭之后再发命令应当是明确失败，而不是挂住
        assert!(session.eval("1+1").is_err(), "关闭后不该还能求值");
    }

    // ==================== ★ 第 185 波（R6）判据 ====================

    /// 会话日志必须有**上限**，撞上限必须**如实标记**（改前无上限、且从不被读）。
    #[test]
    fn session_logs_are_bounded_and_marked_when_truncated() {
        let sink = RefCell::new(String::new());
        let bytes = std::cell::Cell::new(0usize);
        let lines = std::cell::Cell::new(0usize);
        let truncated = std::cell::Cell::new(false);
        // 注入小上限（生产是 16 MiB / 20 万行；判据不必真写 16 MiB）
        let (max_bytes, max_lines) = (64usize, 1_000usize);

        let mut errors = 0usize;
        for _ in 0..50 {
            if push_log_bounded_with(
                &sink,
                &bytes,
                &lines,
                &truncated,
                max_bytes,
                max_lines,
                "xxxxxxxxxx",
            )
            .is_err()
            {
                errors += 1;
            }
        }
        let text = sink.borrow().clone();
        assert!(truncated.get(), "撞上限必须置截断标记（不许静默丢弃）");
        assert!(
            text.len() <= max_bytes + 256,
            "日志必须有界（含说明行）：{}",
            text.len()
        );
        assert!(
            text.contains("已达上限") && text.contains("不是完整日志"),
            "必须如实标记截断：{text}"
        );
        assert!(errors > 0, "撞上限必须把错误交出去（可被 guest try/catch）");

        // 截断之后一个字都不许再涨
        let len_after = sink.borrow().len();
        let err = push_log_bounded_with(
            &sink,
            &bytes,
            &lines,
            &truncated,
            max_bytes,
            max_lines,
            "after",
        )
        .expect_err("截断之后必须继续报错");
        assert!(err.contains("上限"), "错误文案要可读：{err}");
        assert_eq!(sink.borrow().len(), len_after, "截断之后不许再增长");

        // 生产口径：与单发版（js_sandbox.rs）**同一个数**，不能是 0 或随便一个小值
        assert_eq!(
            MAX_LOG_BYTES,
            crate::js_sandbox::MAX_OUTPUT_BYTES,
            "会话版与单发版必须同口径（同一类东西的两份实现）"
        );
        assert!(MAX_LOG_LINES >= 10_000, "行数上限不能小到把正常日志切掉");
    }

    /// `take_session_logs` 必须把「是否被截断」一起交出来（只给文本 = 静默降级）。
    #[test]
    fn taking_session_logs_reports_truncation() {
        // 本判据线程独占这些 thread_local（生产里用得着它们的只有会话线程）
        LOGS.with(|l| l.borrow_mut().clear());
        LOG_BYTES.with(|c| c.set(0));
        LOG_LINES.with(|c| c.set(0));
        LOG_TRUNCATED.with(|c| c.set(false));

        push_log("hello").unwrap();
        let (text, truncated) = take_session_logs();
        assert!(text.contains("hello"), "text={text}");
        assert!(!truncated, "没撞上限就不许报截断（假事实）");
        assert!(
            take_session_logs().0.is_empty(),
            "取走后必须清空（否则下一个会话会继承上一份日志）"
        );
    }

    /// handle 表容量判定：到顶必须**拒绝**（改前只增不减、`JsValue` 永不回收）。
    #[test]
    fn handle_table_refuses_to_grow_past_the_cap() {
        assert!(!handle_capacity_exceeded(0, 1));
        assert!(!handle_capacity_exceeded(MAX_HANDLES - 1, 1));
        assert!(
            handle_capacity_exceeded(MAX_HANDLES, 1),
            "到顶之后必须拒绝（改前只增不减）"
        );
        assert!(handle_capacity_exceeded(MAX_HANDLES - 1, 2));
        let msg = handle_limit_message();
        assert!(
            msg.contains("上限") && msg.contains("不静默丢弃"),
            "错误必须说明是上限、且不静默：{msg}"
        );
        assert!(MAX_HANDLES >= 256, "上限不能小到把正常插件挡住");
    }

    /// **端到端**：循环 `ctx.provide` 超过上限时必须**就地明确失败**
    /// （而不是把宿主内存吃掉、或者回一个指向失效 handle 的描述符）。
    #[test]
    fn provide_beyond_the_handle_cap_fails_loudly() {
        let log = Arc::new(Mutex::new(Vec::new()));
        let mut session = open_session(
            "module.exports = (ctx) => {};".to_string(),
            recording_host(log.clone()),
            20_000_000,
        )
        .expect("会话应当打开");
        let out = session
            .eval(&format!(
                "(function(){{ for (let i = 0; i < {}; i++) {{ \
                   try {{ ctx.provide('s' + i, {{ f: function () {{ return i; }} }}); }} \
                   catch (e) {{ return 'FAILED at ' + i + ': ' + String(e.message || e); }} \
                 }} return 'no-fail'; }})()",
                MAX_HANDLES + 5
            ))
            .expect("循环 provide 必须能返回");
        assert!(
            out.contains("FAILED at"),
            "超过 handle 上限必须就地报错，而不是无界增长：{out}"
        );
        assert!(out.contains("不静默丢弃"), "{out}");
        session.close();
    }
}
