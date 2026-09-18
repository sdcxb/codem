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
    /// 本次进程里若发生过"损坏库自动重建"，这里是那份坏文件的备份路径
    ///
    /// 渲染侧必须知道这件事（写"索引需要重建"标记 + 提示用户）：
    /// 悄悄恢复等于用户永远不知道自己丢过一次索引。
    recovered_from: Mutex<Option<String>>,
    /**
     * 库路径**是不是标准位置**（`%APPDATA%\com.codem.app`），以及若不是则为什么。
     *
     * 第 55 轮新增：非标准位置原来是"静默"的 —— 数据目录解析失败时应用会
     * 在**工作目录**里建一个新库，用户看到的却是"另一个库"（真机事故：用户数据
     * 落进仓库工作目录，差点被提交）。现在这两个字段由 `storage_health` 暴露，
     * 界面/诊断能直接看到"这次的库不在标准位置，原因是 X"。
     */
    db_path_standard: bool,
    db_path_reason: Option<String>,
}

impl StorageState {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            engine: Mutex::new(None),
            recovered_from: Mutex::new(None),
            db_path_standard: true,
            db_path_reason: None,
        }
    }

    /// 惰性打开引擎（幂等；已打开则直接复用）
    ///
    /// 第 19 轮：改用 `Engine::open_with_recovery` —— 库文件损坏时**先备份坏文件再重建**，
    /// 而不是让"本进程没有存储"。备份路径记在 state 里，由 `storage_health` 报给渲染侧。
    fn engine(&self) -> Result<std::sync::MutexGuard<'_, Option<Engine>>, DbError> {
        let mut guard = self
            .engine
            .lock()
            .map_err(|_| DbError::new(codem_db::ErrorCode::Unavailable, "存储状态锁已中毒"))?;
        if guard.is_none() {
            let (engine, recovered) = Engine::open_with_recovery(&self.path)?;
            if let Some(backup) = recovered {
                if let Ok(mut slot) = self.recovered_from.lock() {
                    *slot = Some(backup.to_string_lossy().to_string());
                }
            }
            *guard = Some(engine);
        }
        Ok(guard)
    }

    /// 本次进程是否发生过损坏恢复（诊断/健康检查用）
    pub fn recovered_from(&self) -> Option<String> {
        self.recovered_from.lock().ok().and_then(|g| g.clone())
    }

    pub fn path(&self) -> &std::path::Path {
        &self.path
    }
}

/// 数据目录的解析结果：路径 + **它是怎么来的**。
///
/// 「怎么来的」必须一起返回，因为"库文件在哪"这件事**不能靠猜**：
/// 第 55 轮真事故就是解析退到当前目录之后，用户数据落进了仓库工作目录，
/// 而没有任何一处能说出"这次用的是非标准位置"。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedDbPath {
    pub path: PathBuf,
    /// `true` = 标准位置（`%APPDATA%\com.codem.app`）
    pub standard: bool,
    /// 非标准时必须能说清原因（写进日志 / 健康检查，别让它静默）
    pub reason: Option<String>,
}

/// 解析库文件路径：**标准位置是** `%APPDATA%\com.codem.app\codem-db-rust.bin`
///
/// 刻意**不依赖 `AppHandle`**：Tauri 的 `.manage(state)` 必须在 `.build()` 之前调用，
/// 而 AppHandle 那时才存在。所以这里自行解析，但**必须与 Tauri 用同一条规则**。
///
/// ## 第 55 轮修正（两件事）
///
/// ### ① 优先用"已知文件夹"，而不是 `APPDATA` 环境变量
///
/// 原实现读 `std::env::var_os("APPDATA")`，而 Tauri 的 `app_data_dir()` 走的是
/// Windows 的 `SHGetKnownFolderPath(FOLDERID_RoamingAppData)`（`dirs` crate 同款）。
/// **两者不等价**：环境变量缺失（自定义环境启动、被清掉、被改）时，
/// 渲染侧（走 Tauri）照样拿到真实的数据目录，而引擎（走环境变量）解析失败——
/// **同一个事实两个来源**，真机后果就是"渲染侧把日志写进真目录、引擎把库建到别处"。
/// 现在引擎也用 `dirs::data_dir()`，两边**按构造一致**。
///
/// ### ② 绝不再退回"当前目录里的裸文件名"
///
/// 原来的兜底是 `PathBuf::from(DB_FILE_NAME)`（相对路径 = 工作目录），理由是
/// "宁可可用也不要存储层直接不可用"。真机后果（2026-09-18 实测）：`APPDATA` 缺失时
/// 应用**静默**在 `C:\mimo-gui\`（仓库工作目录）建了一个**全新的库** ——
/// 用户看到的是另一个库、数据写进任意目录（那次还差点被 `git add -A` 提交进公开仓库）、
/// 两个库就此分叉而没有任何信号。
///
/// 现在的顺序（每一步都能说清"为什么是这里"，非标准一律告警 + 由 `storage_info` 暴露）：
///
/// 1. `CODEM_DB_PATH`（显式覆盖，**唯一**受支持的"把库放到别处"的方式）；
/// 2. `dirs::data_dir()`（**与 Tauri 同源**：Windows = Roaming AppData）；
/// 3. `XDG_DATA_HOME` / `HOME`（非 Windows 习惯）；
/// 4. `%USERPROFILE%\.codem`（Windows 上连已知文件夹都取不到时的**私有**目录）；
/// 5. 全都没有 → 工作目录下的 **`.codem-portable/`** 子目录（名字自带说明）＋ 大声告警。
pub fn resolve_db_path() -> ResolvedDbPath {
    resolve_db_path_from(
        std::env::var_os("CODEM_DB_PATH"),
        dirs::data_dir(),
        std::env::var_os("XDG_DATA_HOME"),
        std::env::var_os("HOME"),
        std::env::var_os("USERPROFILE"),
    )
}

/// 纯函数形态：把"各种候选来源"作为参数传进来，**每一档都可被单测覆盖**。
///
/// 抽出来的理由很直接：真机上的分支（已知文件夹取不到、环境变量全缺）在测试里造不出来，
/// 而"造不出来的分支"恰恰是最容易写错、也最没人复核的那种。
pub(crate) fn resolve_db_path_from(
    explicit: Option<std::ffi::OsString>,
    known_folder: Option<PathBuf>,
    xdg: Option<std::ffi::OsString>,
    home: Option<std::ffi::OsString>,
    userprofile: Option<std::ffi::OsString>,
) -> ResolvedDbPath {
    let identifier = "com.codem.app";
    let non_empty = |v: Option<std::ffi::OsString>| -> Option<PathBuf> {
        v.filter(|s| !s.is_empty()).map(PathBuf::from)
    };

    // ① 显式覆盖
    if let Some(p) = non_empty(explicit) {
        return ResolvedDbPath {
            path: p,
            standard: false,
            reason: Some("由环境变量 CODEM_DB_PATH 指定".to_string()),
        };
    }

    // ② 与 Tauri 同源的已知文件夹（这是"标准位置"）
    if let Some(base) = known_folder {
        return ResolvedDbPath {
            path: base.join(identifier).join(DB_FILE_NAME),
            standard: true,
            reason: None,
        };
    }

    // ③ XDG / HOME（非 Windows 习惯）
    if let Some(xdg) = non_empty(xdg) {
        return ResolvedDbPath {
            path: xdg.join(identifier).join(DB_FILE_NAME),
            standard: false,
            reason: Some("取不到系统数据目录，退回 XDG_DATA_HOME".to_string()),
        };
    }
    if let Some(home) = non_empty(home) {
        return ResolvedDbPath {
            path: home.join(".local/share").join(identifier).join(DB_FILE_NAME),
            standard: false,
            reason: Some("取不到系统数据目录，退回 $HOME/.local/share".to_string()),
        };
    }

    // ④ Windows 上连已知文件夹都取不到时的私有目录（**仍不在工作目录里**）
    if let Some(profile) = non_empty(userprofile) {
        return ResolvedDbPath {
            path: profile.join(".codem").join(DB_FILE_NAME),
            standard: false,
            reason: Some("取不到系统数据目录，退回 %USERPROFILE%\\.codem（用户私有目录）".to_string()),
        };
    }

    // ⑤ 最后兜底：**带名字的子目录**（不是裸相对文件名），并在下面统一告警
    ResolvedDbPath {
        path: PathBuf::from(".codem-portable").join(DB_FILE_NAME),
        standard: false,
        reason: Some(
            "系统数据目录与 APPDATA / XDG_DATA_HOME / HOME / USERPROFILE 全部不可用：\
             退回工作目录下的 .codem-portable/"
                .to_string(),
        ),
    }
}

/// 解析并**把非标准位置说出来**（供 `init_state` 与诊断使用）
pub fn resolve_db_path_warned() -> ResolvedDbPath {
    let resolved = resolve_db_path();
    if let Some(reason) = &resolved.reason {
        eprintln!(
            "[Storage] ⚠️ 库文件不在标准位置：{} —— 原因：{reason}。\
             若这不是你想要的，请设置 CODEM_DB_PATH 指定库路径（或用标准环境启动，让 APPDATA 可用）。",
            resolved.path.to_string_lossy()
        );
    }
    resolved
}

/// Rust 引擎的库文件名。与 WASM 侧 `codem-db.bin` **刻意分开**：
/// 迁移期两个引擎可并存对照、互不锁文件；数据搬迁由 P4 的迁移/对账工具负责。
pub const DB_FILE_NAME: &str = "codem-db-rust.bin";

/// 初始化存储态（在 `run()` 里构造并 `manage`）。
///
/// 走 `resolve_db_path_warned()`：**非标准位置必须留下一行告警**（第 55 轮）。
pub fn init_state() -> StorageState {
    let resolved = resolve_db_path_warned();
    let mut state = StorageState::new(resolved.path);
    state.db_path_standard = resolved.standard;
    state.db_path_reason = resolved.reason;
    state
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
                /*
                 * 错误信息里**不再内嵌已完成步骤的完整 JSON**（第 44 轮）。
                 *
                 * 原来这里把 `done` 整个序列化进 message，于是"第 3 步失败"这条错误会带上
                 * 前两步的**完整结果** —— 一条 `messages.list` 的结果就能是几 MB，
                 * 而这段文本会原样出现在：
                 * ① 用户看到的告警（"数据保存失败：batch 在第 2 步失败…已完成 1 步：[{…7MB…}]"）；
                 * ② 日志文件；③ 渲染侧的错误对象里。
                 * 实测形态就是"界面上弹出一坨 JSON"。
                 *
                 * 排查真正需要的是"第几步、哪条命令、为什么失败、前面成功了几步"，
                 * 不是一个可复现的结果快照。要结果快照的调用方应当改用**逐条调用**
                 * （那也是它本来就能做到的事）。所以这里只留**命令名清单**：
                 * 足够回答"前面那几步做了什么"，且长度与数据量无关。
                 *
                 * ⚠️ 第 45 轮 Z-7：这段格式化**搬进 `codem_db::batch_failure_message`** 了。
                 * 起因：CLI 那份 batch 有一份**自己的**文案（仍在内嵌完整结果 JSON），
                 * 而两边的注释都写着"与另一侧对齐"却已经分歧 —— 说明"同一件事写两份"
                 * 靠注释是维持不住的。现在两处调用同一个函数，形状不可能再分叉；
                 * 这里只负责把"已完成的命令名"收集起来。
                 */
                let completed: Vec<String> = done
                    .iter()
                    .filter_map(|d| d.get("command").and_then(|c| c.as_str()))
                    .map(|s| s.to_string())
                    .collect();
                return reply(Err(DbError::new(
                    e.code,
                    codem_db::batch_failure_message(
                        done.len() + 1,
                        &item.command,
                        &e.message,
                        &completed,
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
        let mut v = serde_json::to_value(h).map_err(|e| DbError::other(e.to_string()))?;
        // 第 55 轮：**库路径的来源**也要附着在 health 上（与下面的"损坏恢复"同理）。
        //
        // 渲染侧每次启动都调 `health`，所以"这次的库不在标准位置"会自动被看到。
        // `db_path_standard` 只有 `init_state()` 走过 `resolve_db_path_warned()`
        // 才会是 `false`；直接 `StorageState::new(路径)`（测试/工具）默认按标准处理。
        if let Value::Object(ref mut map) = v {
            map.insert("db_path".to_string(), Value::String(state.path().to_string_lossy().to_string()));
            map.insert("db_path_standard".to_string(), Value::Bool(state.db_path_standard));
            if let Some(reason) = &state.db_path_reason {
                map.insert("db_path_reason".to_string(), Value::String(reason.clone()));
            }
        }
        /* 把"是否发生过损坏恢复"附在健康检查上（第 19 轮）。
         *
         * 为什么放在这里而不是单开一条命令：渲染侧**每次启动都会调 health**（端口预热的第一步），
         * 而恢复这事只在打开引擎时发生一次 —— 附着在 health 上就自动被看到，
         * 不需要调用方记得"额外问一句"（那种设计一定会有人忘）。 */
        if let Some(backup) = state.recovered_from() {
            if let Value::Object(ref mut map) = v {
                map.insert("recovered".to_string(), Value::Bool(true));
                map.insert("recovered_from".to_string(), Value::String(backup.clone()));
                /*
                 * 第 47 轮补：附上**从损坏库抢救出来的项目 / 会话归属**。
                 *
                 * 为什么必须由引擎这边给：损坏恢复之后新库里 `sessions` 表是空的，
                 * 而渲染侧重建索引时要知道"每个会话属于哪个项目"（否则所有复活的
                 * 会话都落到"全局项目"）。这个映射只存在于那份坏文件的备份里。
                 *
                 * 为什么走 health 而**不新增一条命令**：渲染侧启动时一定会调 health，
                 * 附着上去就不会有人忘；而且新增命令要同步改渲染侧的命令清单与
                 * 双向对齐门禁，为一个只在"库损坏过"时才非空的字段加一条永久契约不划算。
                 *
                 * 读一次就缓存（`health` 会被反复调用，而抢救文件在进程内不会变）。
                 */
                if let Some(salvaged) = recovered_projects_cached(&backup) {
                    map.insert("recovered_projects".to_string(), salvaged);
                }
            }
        }
        Ok(v)
    }))
}

/// 读一次"损坏抢救"旁路文件并缓存。
///
/// 文件由引擎在 `open_with_recovery` 里写成（`<db>.recovered-projects.json`），
/// 形状：`{ "projects": [...], "sessions": [{"id","project_id"}], "settings": [{"key","value","updated_at"}] }`。
///
/// ⭐ 第 57 轮加了 `settings` 一节（审计里「损坏库备份**无等价物**」的闭合动作）：
/// 消息有权威日志、归属有 `projects`/`sessions` 这两节，而**设置原本一个等价物都没有** ——
/// 库损坏建新库之后，用户的偏好就永久没了。**写不写回由渲染侧的策略决定**
/// （`recovery-restore.ts::BLOCKED_RESTORE_KEYS` 逐条写着哪些不许继承），
/// 引擎这边只负责"如实抄出来"。
///
/// 读不到 / 解析不了 → `None`：**这不是错误**（库损坏到读不出这些表时就没有这个文件，
/// 或者它被用户删了）。渲染侧会走原来的路径（落到全局项目 + `withoutProject` 告警），
/// 也就是说这条路径**只可能把归属与设置救回来，不可能让恢复变坏**。
fn recovered_projects_cached(backup: &str) -> Option<Value> {
    use std::sync::OnceLock;
    static CACHE: OnceLock<Option<Value>> = OnceLock::new();
    CACHE
        .get_or_init(|| {
            let path = format!("{backup}.recovered-projects.json");
            // 备选路径：引擎写的是"**库**路径 + .recovered-projects.json"，
            // 而这里的 backup 是"**备份**路径"，两者不同 —— 两个都试
            let candidates = [path, format!("{}.recovered-projects.json", backup.replace(".corrupt-", ""))];
            for p in candidates {
                let Ok(text) = std::fs::read_to_string(&p) else {
                    continue;
                };
                let Ok(parsed) = serde_json::from_str::<Value>(&text) else {
                    continue;
                };
                return Some(parsed);
            }
            None
        })
        .clone()
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
///
/// 第 55 轮加了**路径来源**两个字段：`standard` 与 `reason`。
/// 为什么必须暴露：数据目录解析失败时应用会在别处建库（旧实现是工作目录），
/// 而"库在哪、为什么在那儿"如果只有 stderr 一行日志，界面与诊断面板都看不到 ——
/// 用户看到的只是"我的历史不见了"。有了这两个字段，UI 才有办法把真相说出来。
#[tauri::command]
pub fn storage_info(state: State<'_, StorageState>) -> Value {
    json!({
        "engine": "rust",
        "path": state.path().to_string_lossy(),
        "exists": state.path().exists(),
        "standard": state.db_path_standard,
        "reason": state.db_path_reason,
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

    /// ## 第 55 轮：解析规则必须满足两条**能复现**的判据
    ///
    /// 用纯函数 `resolve_db_path_from` 把每一档都造出来（真机上造不出的分支，
    /// 恰恰是最容易写错、最没人复核的那些）。
    ///
    /// ① **与 Tauri 同源**：有"已知文件夹"时就用它（真机事故的反面：
    ///    `APPDATA` 环境变量在不在，都不该改变库的位置）；
    /// ② **绝不退回"当前目录里的裸文件名"**：那是真事故的根因
    ///    （数据落进仓库工作目录，差点被提交）。
    #[test]
    fn resolve_db_path_rules_are_reproducible() {
        use std::ffi::OsString;

        // ① 显式覆盖优先，且不依赖其它任何来源
        let r = resolve_db_path_from(
            Some(OsString::from(r"C:\explicit\db.bin")),
            Some(PathBuf::from(r"C:\Users\t\AppData\Roaming")),
            Some(OsString::from("/xdg")),
            Some(OsString::from("/home/t")),
            Some(OsString::from(r"C:\Users\t")),
        );
        assert_eq!(r.path, PathBuf::from(r"C:\explicit\db.bin"));
        assert!(!r.standard, "显式覆盖不算标准位置");
        assert!(r.reason.is_some(), "非标准位置必须能说清原因");

        // ② 标准位置 = 已知文件夹（**与 Tauri `app_data_dir()` 同源**）
        let r = resolve_db_path_from(None, Some(PathBuf::from(r"C:\Users\t\AppData\Roaming")), None, None, None);
        assert_eq!(
            r.path,
            PathBuf::from(r"C:\Users\t\AppData\Roaming")
                .join("com.codem.app")
                .join(DB_FILE_NAME)
        );
        assert!(r.standard);
        assert!(r.reason.is_none(), "标准位置不该有'原因'");

        // ③ 空的环境变量**不算提供**（`Some("")` 与 `None` 同义）
        let r = resolve_db_path_from(
            Some(OsString::from("")),
            Some(PathBuf::from(r"C:\Users\t\AppData\Roaming")),
            Some(OsString::from("")),
            None,
            None,
        );
        assert!(r.standard, "空 CODEM_DB_PATH 不该被当成覆盖");

        // ④ 已知文件夹取不到 → 逐级退回，但**每一级都不在工作目录里**
        let r = resolve_db_path_from(None, None, Some(OsString::from("/xdg")), None, None);
        assert_eq!(r.path, PathBuf::from("/xdg").join("com.codem.app").join(DB_FILE_NAME));
        assert!(!r.standard && r.reason.is_some());

        let r = resolve_db_path_from(None, None, None, Some(OsString::from("/home/t")), None);
        assert_eq!(
            r.path,
            PathBuf::from("/home/t").join(".local/share").join("com.codem.app").join(DB_FILE_NAME)
        );
        assert!(r.reason.is_some());

        let r = resolve_db_path_from(None, None, None, None, Some(OsString::from(r"C:\Users\t")));
        assert_eq!(r.path, PathBuf::from(r"C:\Users\t").join(".codem").join(DB_FILE_NAME));
        assert!(!r.path.is_relative(), "用户私有目录也必须是绝对路径");
        assert!(r.reason.is_some());

        // ⑤ **全部不可用** → 兜底也必须是"带名字的子目录"，绝不是裸文件名
        let r = resolve_db_path_from(None, None, None, None, None);
        assert!(
            r.path.starts_with(".codem-portable"),
            "最后的兜底必须是带名字的子目录（可辨认、可忽略），实际：{:?}",
            r.path
        );
        assert_ne!(
            r.path,
            PathBuf::from(DB_FILE_NAME),
            "绝不允许退回'当前目录里的裸文件名'（第 55 轮真事故的根因）"
        );
        assert!(r.reason.is_some(), "兜底档必须带原因（会被 eprintln 告警）");
    }

    /// 真机的那次事故：`APPDATA` 环境变量被清掉时，**库的位置不该变**。
    ///
    /// 这一条与上一条的区别：它真的去读环境变量与 `dirs::data_dir()`，
    /// 所以它守的是"引擎与 Tauri 同源"这个**接线**（纯函数测不到接线）。
    #[test]
    fn db_path_does_not_depend_on_appdata_env_var() {
        static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());

        let saved_appdata = std::env::var_os("APPDATA");
        let saved_explicit = std::env::var_os("CODEM_DB_PATH");
        std::env::remove_var("CODEM_DB_PATH");

        let with_appdata = resolve_db_path();
        std::env::remove_var("APPDATA");
        let without_appdata = resolve_db_path();

        assert_eq!(
            with_appdata.path, without_appdata.path,
            "清掉 APPDATA 之后库的位置变了 —— 那正是真事故（数据落进工作目录）的形态"
        );
        assert!(!without_appdata.path.is_relative(), "库路径必须是绝对路径或带名字的子目录");

        if let Some(v) = saved_appdata {
            std::env::set_var("APPDATA", v);
        }
        if let Some(v) = saved_explicit {
            std::env::set_var("CODEM_DB_PATH", v);
        }
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
