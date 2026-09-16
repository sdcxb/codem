//! 存储引擎的 Tauri 命令层（第 92 波 P3 前置）
//!
//! ## 定位
//!
//! 这一层**只做三件事**：解析参数 → 调 `codem_db::dispatch` → 序列化结果。
//! 没有业务逻辑，也没有 SQL —— 渲染进程能表达的一切都必须是 `codem-db` crate 里的
//! 类型化仓储命令（`docs/ARCH-SQLITE-TO-RUST.md` §2.1）。
//!
//! ## 为什么错误要"包一层"而不是直接 `Result<T, String>`
//!
//! 渲染侧要按 `code` 决定"重试 / 降级 / 上报"。把错误序列化成
//! `{code, message, retryable}` 交给前端，前端才能复用统一的失败通道；
//! 如果只给一个字符串，渲染侧只能靠正则猜，等于把"错误是值"又退回"错误是文本"。
//!
//! ## 阻塞与并发
//!
//! Tauri 命令默认在**独立线程池**上执行（非 async 命令），因此这里用同步的
//! `Mutex<Option<Engine>>` 是安全的：所有写都经 `Engine::write_tx` 的同一把锁串行化，
//! 这正是"单写者"的落点。`Engine::open` 很轻（PRAGMA + schema 幂等检查），
//! 首次调用时惰性打开，之后复用连接。
//!
//! ## 库文件位置
//!
//! `<app_data_dir>/codem-db-rust.bin`。
//! 与 WASM 侧用的 `codem-db.bin` **刻意分开**：迁移期两个引擎可以并存对照，
//! 互不锁文件；数据搬迁由 P4 的迁移/对账工具负责，而不是"两个引擎抢同一个文件"。
//!
//! ## ⚠️ 给后来者：新增仓储命令后**必须重建 Tauri 二进制**
//!
//! 这个坑实测踩过**两次**（新增 `config_warmup`、`events.list` 之后）：
//! - 在 `codem-db` crate 里加了命令、`cargo test` 全绿、TS 契约测试（假 transport）也全绿；
//! - 但**没有重建应用二进制**，于是真机上每条新命令都报"未实现的仓储命令"。
//!
//! 原因：`cargo test` 测的是 crate 自己的 `dispatch`，TS 契约测试用的是假 transport，
//! **两者都看不见"应用里注册的 dispatch 表"**。只有真机会暴露。
//! 所以：`cargo build`（from `src-tauri`）之后再上真机。
//! `src/test/storage-command-parity.test.ts` 守着"源码层面"的一致性（声明/分支/注册），
//! 但"二进制是否是最新的"只能靠这条流程纪律。

use std::path::PathBuf;
use std::sync::Mutex;

use codem_db::{capabilities, dispatch, DbError, Engine};
use serde_json::{json, Value};
use tauri::State;

/// 存储命令的统一返回体：**成功与失败都自描述**，渲染侧不需要猜字段。
#[derive(serde::Serialize)]
pub struct StorageReply {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<StorageErrorPayload>,
    /// 引擎种类（迁移期渲染侧据此决定"读哪边"）
    pub engine: &'static str,
}

#[derive(serde::Serialize)]
pub struct StorageErrorPayload {
    pub code: &'static str,
    pub message: String,
    pub retryable: bool,
    /// 给渲染侧的可读处置建议（日志与界面直接用）
    pub hint: &'static str,
}

impl From<DbError> for StorageErrorPayload {
    fn from(e: DbError) -> Self {
        Self {
            code: e.code.as_str(),
            message: e.message,
            retryable: e.retryable,
            hint: e.code.hint(),
        }
    }
}

pub struct StorageState {
    /// 库文件路径（惰性打开时使用；诊断与迁移工具也要读它）
    path: PathBuf,
    engine: Mutex<Option<Engine>>,
}

impl StorageState {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            engine: Mutex::new(None),
        }
    }

    /// 惰性打开引擎（幂等；已打开则直接复用）
    fn engine(&self) -> Result<std::sync::MutexGuard<'_, Option<Engine>>, DbError> {
        let mut guard = self
            .engine
            .lock()
            .map_err(|_| DbError::new(codem_db::ErrorCode::Unavailable, "存储状态锁已中毒"))?;
        if guard.is_none() {
            let engine = Engine::open(&self.path)?;
            *guard = Some(engine);
        }
        Ok(guard)
    }

    pub fn path(&self) -> &std::path::Path {
        &self.path
    }
}

/// 解析库文件路径：`%APPDATA%\com.codem.app\codem-db-rust.bin`
///
/// 刻意**不依赖 `AppHandle`**：Tauri 的 `.manage(state)` 必须在 `.build()` 之前调用，
/// 而 AppHandle 那时才存在。这里用与 Tauri `app_data_dir()` 相同的规则
/// （Windows: `%APPDATA%\<identifier>`）自行解析，既消除了初始化顺序耦合，
/// 又让 CLI / 测试 / 迁移工具能用同一套路径规则。
pub fn resolve_db_path() -> PathBuf {
    let identifier = "com.codem.app";
    let base = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("XDG_DATA_HOME").map(PathBuf::from))
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")));
    match base {
        Some(dir) => dir.join(identifier).join(DB_FILE_NAME),
        // 极端情况（环境变量都缺失）：退回当前目录，宁可可用也不要"存储层直接不可用"
        None => PathBuf::from(DB_FILE_NAME),
    }
}

/// Rust 引擎的库文件名。与 WASM 侧 `codem-db.bin` **刻意分开**：
/// 迁移期两个引擎可并存对照、互不锁文件；数据搬迁由 P4 的迁移/对账工具负责。
pub const DB_FILE_NAME: &str = "codem-db-rust.bin";

/// 初始化存储态（在 `run()` 里构造并 `manage`）
pub fn init_state() -> StorageState {
    StorageState::new(resolve_db_path())
}

fn reply(result: Result<Value, DbError>) -> StorageReply {
    match result {
        Ok(v) => StorageReply {
            ok: true,
            result: Some(v),
            error: None,
            engine: "rust",
        },
        Err(e) => StorageReply {
            ok: false,
            result: None,
            error: Some(e.into()),
            engine: "rust",
        },
    }
}

/// 统一的仓储命令入口。
///
/// **不接受 SQL**：`command` 是仓储命令名（`codem_db::COMMANDS` 白名单），
/// `params` 是结构化 JSON。越界的一律 `UNSUPPORTED`。
#[tauri::command]
pub fn storage_invoke(
    state: State<'_, StorageState>,
    command: String,
    params: Option<Value>,
) -> StorageReply {
    let params = params.unwrap_or_else(|| json!({}));
    let guard = match state.engine() {
        Ok(g) => g,
        Err(e) => return reply(Err(e)),
    };
    let Some(engine) = guard.as_ref() else {
        return reply(Err(DbError::new(
            codem_db::ErrorCode::Unavailable,
            "存储引擎未就绪",
        )));
    };
    reply(dispatch(engine, &command, &params))
}

/// 批量写：顺序执行、每步一个独立事务、失败即停并如实回报"已完成几步"。
///
/// 之所以不是"整批一个事务"：渲染侧的批量写调用点跨不同领域（会话 / 消息 / 事件），
/// 把它们绑成一个事务会让"一条消息写失败"回滚掉整个会话的写入 —— 那不是调用方要的语义。
/// 需要真正原子性的批次用 `messages.create_many` 这类**单命令内的多行事务**。
#[tauri::command]
pub fn storage_batch(
    state: State<'_, StorageState>,
    commands: Vec<StorageBatchItem>,
) -> StorageReply {
    let guard = match state.engine() {
        Ok(g) => g,
        Err(e) => return reply(Err(e)),
    };
    let Some(engine) = guard.as_ref() else {
        return reply(Err(DbError::new(
            codem_db::ErrorCode::Unavailable,
            "存储引擎未就绪",
        )));
    };
    let mut done: Vec<Value> = Vec::new();
    for item in &commands {
        let params = item.params.clone().unwrap_or_else(|| json!({}));
        match dispatch(engine, &item.command, &params) {
            Ok(v) => done.push(json!({ "command": item.command, "ok": true, "result": v })),
            Err(e) => {
                return reply(Err(DbError::new(
                    e.code,
                    format!(
                        "batch 在第 {} 步失败（command={}）：{}；已完成 {} 步：{}",
                        done.len() + 1,
                        item.command,
                        e.message,
                        done.len(),
                        serde_json::to_string(&done).unwrap_or_default()
                    ),
                )));
            }
        }
    }
    reply(Ok(json!({ "count": done.len(), "results": done })))
}

#[derive(serde::Deserialize)]
pub struct StorageBatchItem {
    pub command: String,
    #[serde(default)]
    pub params: Option<Value>,
}

/// 健康与规模（诊断面板 / 迁移对账 / 渲染侧判断"读哪边"）
#[tauri::command]
pub fn storage_health(state: State<'_, StorageState>) -> StorageReply {
    let guard = match state.engine() {
        Ok(g) => g,
        Err(e) => return reply(Err(e)),
    };
    let Some(engine) = guard.as_ref() else {
        return reply(Err(DbError::new(
            codem_db::ErrorCode::Unavailable,
            "存储引擎未就绪",
        )));
    };
    reply(engine.health().and_then(|h| {
        serde_json::to_value(h).map_err(|e| DbError::other(e.to_string()))
    }))
}

/// 完整性检查（迁移对账 / 损坏后判断是否重建索引）
#[tauri::command]
pub fn storage_integrity_check(state: State<'_, StorageState>) -> StorageReply {
    let guard = match state.engine() {
        Ok(g) => g,
        Err(e) => return reply(Err(e)),
    };
    let Some(engine) = guard.as_ref() else {
        return reply(Err(DbError::new(
            codem_db::ErrorCode::Unavailable,
            "存储引擎未就绪",
        )));
    };
    reply(
        engine
            .integrity_check()
            .and_then(|r| serde_json::to_value(r).map_err(|e| DbError::other(e.to_string()))),
    )
}

/// WAL checkpoint（退出前调用；不是整库导出）
#[tauri::command]
pub fn storage_checkpoint(state: State<'_, StorageState>) -> StorageReply {
    let guard = match state.engine() {
        Ok(g) => g,
        Err(e) => return reply(Err(e)),
    };
    let Some(engine) = guard.as_ref() else {
        return reply(Err(DbError::new(
            codem_db::ErrorCode::Unavailable,
            "存储引擎未就绪",
        )));
    };
    reply(engine.checkpoint().map(|_| json!({ "ok": true })))
}

/// 命令清单与硬上限（自省；契约测试也用它做覆盖校验）
#[tauri::command]
pub fn storage_capabilities() -> Value {
    capabilities()
}

/// 库文件路径 + 是否存在（迁移工具与诊断用）
#[tauri::command]
pub fn storage_info(state: State<'_, StorageState>) -> Value {
    json!({
        "engine": "rust",
        "path": state.path().to_string_lossy(),
        "exists": state.path().exists(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn search_paths_are_sane() {
        // 只验证路径拼接与状态构造，不依赖 Tauri 运行时
        let st = StorageState::new(PathBuf::from("x/codem-db-rust.bin"));
        assert!(st.path().ends_with("codem-db-rust.bin"));
        // 惰性打开：构造后还没打开任何连接
        assert!(st.engine.lock().unwrap().is_none());
    }

    #[test]
    fn error_payload_carries_code_and_hint() {
        let e = DbError::new(codem_db::ErrorCode::Busy, "database is locked");
        let p: StorageErrorPayload = e.into();
        assert_eq!(p.code, "BUSY");
        assert!(p.retryable, "BUSY 必须标记为可重试");
        assert!(!p.hint.is_empty());
    }

    #[test]
    fn unsupported_error_is_not_retryable() {
        let p: StorageErrorPayload = DbError::unsupported("未知命令").into();
        assert_eq!(p.code, "UNSUPPORTED");
        assert!(!p.retryable, "能力边界不该建议重试");
    }

    #[test]
    fn reply_shape_is_self_describing() {
        let ok = reply(Ok(json!({ "written": 1 })));
        assert!(ok.ok && ok.error.is_none());
        let err = reply(Err(DbError::new(
            codem_db::ErrorCode::NotFound,
            "messages.update 未命中任何行",
        )));
        assert!(!err.ok && err.result.is_none());
        assert_eq!(err.error.unwrap().code, "NOT_FOUND");
    }
}
