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

/// `console.log` → 会话日志
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
    LOGS.with(|l| {
        let mut l = l.borrow_mut();
        l.push_str(&line);
        l.push('\n');
    });
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
                let handle = NEXT_HANDLE.with(|n| {
                    let mut n = n.borrow_mut();
                    let id = *n;
                    *n += 1;
                    id
                });
                HANDLES.with(|h| h.borrow_mut().insert(handle, value.clone()));
                functions.push((key_str, handle));
            } else if let Ok(Some(json)) = value.to_json(ctx) {
                data.insert(key_str, json);
            }
        }
    } else if let Ok(Some(json)) = service.to_json(ctx) {
        // 不是对象（数字/字符串/数组）：整份当数据
        data.insert("value".to_string(), json);
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
}
