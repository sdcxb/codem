//! 结构化存储错误 —— **错误是值，不是进程中毒**。
//!
//! 这是迁移到 Rust 的核心收益之一：WASM 陷阱（`memory access out of bounds`）会让整个模块
//! 进入不可恢复状态（之后每次调用都 trap），而原生 SQLite 的内存/锁/IO 问题都是**可处理的返回值**。
//! 这里把 `rusqlite::Error` 映射成渲染侧能辨认的稳定错误码 + `retryable` 标记，
//! 让调用方可以"重试 / 降级 / 上报"，而不是"整个数据库层死掉"。

use serde::Serialize;

/// 与渲染侧 `src/core/storage/port.ts` 的 `StorageErrorCode` **一一对应**（改这里必须同步改那边）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCode {
    /// 数据库忙（可重试）
    Busy,
    /// 锁冲突（可重试）
    Locked,
    /// 内存/磁盘不足（降级或上报，不是重试）
    NoMem,
    /// 库损坏（走"从权威日志重建索引"）
    Corrupt,
    /// 文件系统错误（可重试）
    Io,
    /// 约束冲突（业务处理）
    Constraint,
    /// 目标不存在
    NotFound,
    /// 引擎未就绪/已关闭
    Unavailable,
    /// 端口未实现该能力（迁移期）
    Unsupported,
    Other,
}

impl ErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            ErrorCode::Busy => "BUSY",
            ErrorCode::Locked => "LOCKED",
            ErrorCode::NoMem => "NOMEM",
            ErrorCode::Corrupt => "CORRUPT",
            ErrorCode::Io => "IO",
            ErrorCode::Constraint => "CONSTRAINT",
            ErrorCode::NotFound => "NOT_FOUND",
            ErrorCode::Unavailable => "UNAVAILABLE",
            ErrorCode::Unsupported => "UNSUPPORTED",
            ErrorCode::Other => "OTHER",
        }
    }

    /// 是否值得重试（与 port.ts 的 RETRYABLE 集合保持一致）
    pub fn retryable(self) -> bool {
        matches!(
            self,
            ErrorCode::Busy | ErrorCode::Locked | ErrorCode::Io | ErrorCode::Unavailable
        )
    }

    /// 渲染侧应该怎么处理（写进错误消息，便于日志与界面直接可读）
    pub fn hint(self) -> &'static str {
        match self {
            ErrorCode::Busy | ErrorCode::Locked => "数据库正忙/被锁：可稍后重试",
            ErrorCode::NoMem => "内存或磁盘不足：请减少并发写入、清理旧会话或释放空间",
            ErrorCode::Corrupt => "数据库文件损坏：请从会话追加日志重建索引（不要继续写入）",
            ErrorCode::Io => "文件系统错误：请检查磁盘与权限后重试",
            ErrorCode::Constraint => "约束冲突：调用方需要先满足依赖（如外键指向的行）",
            ErrorCode::NotFound => "目标记录不存在",
            ErrorCode::Unavailable => "存储引擎未就绪或已关闭",
            ErrorCode::Unsupported => "该能力尚未实现（迁移期）",
            ErrorCode::Other => "其它存储错误",
        }
    }
}

/// 存储层错误：`code` 是稳定契约，`message` 只供人读。
#[derive(Debug, Clone, Serialize)]
pub struct DbError {
    pub code: ErrorCode,
    pub message: String,
    pub retryable: bool,
}

impl DbError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            retryable: code.retryable(),
        }
    }

    pub fn unsupported(what: impl Into<String>) -> Self {
        Self::new(ErrorCode::Unsupported, what)
    }

    pub fn other(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Other, message)
    }

    /// 供日志/CLI 展示的单行文本
    pub fn to_line(&self) -> String {
        format!("[{}] {}（{}）", self.code.as_str(), self.message, self.code.hint())
    }

    /// 缺参数属于**调用方 bug**（不是引擎故障）：单独构造，避免被当成"存储损坏"
    pub fn missing(param: &str) -> Self {
        Self::new(ErrorCode::Other, format!("缺少必填参数 {param}"))
    }

    /// 参数类型不对（同样是调用方 bug）
    pub fn invalid(param: &str, why: impl Into<String>) -> Self {
        Self::new(ErrorCode::Other, format!("参数 {param} 不合法：{}", why.into()))
    }
}

impl std::fmt::Display for DbError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.to_line())
    }
}

impl std::error::Error for DbError {}

/// 从 rusqlite 错误映射（按 `ErrorCode` + 扩展码细分；映射表就是"错误是值"的实现）
impl From<rusqlite::Error> for DbError {
    fn from(e: rusqlite::Error) -> Self {
        use rusqlite::Error as R;
        use rusqlite::ffi;

        match &e {
            R::SqliteFailure(err, msg) => {
                let detail = msg.clone().unwrap_or_else(|| format!("{:?}", err.code));
                // 扩展码优先（更精确）：SQLITE_BUSY_SNAPSHOT / SQLITE_IOERR_* / SQLITE_CORRUPT_* …
                let ext = err.extended_code;
                let code = if ext & 0xff == ffi::SQLITE_BUSY {
                    ErrorCode::Busy
                } else if ext & 0xff == ffi::SQLITE_LOCKED {
                    ErrorCode::Locked
                } else if ext & 0xff == ffi::SQLITE_NOMEM || ext & 0xff == ffi::SQLITE_FULL {
                    ErrorCode::NoMem
                } else if ext & 0xff == ffi::SQLITE_CORRUPT || ext & 0xff == ffi::SQLITE_NOTADB {
                    ErrorCode::Corrupt
                } else if ext & 0xff == ffi::SQLITE_IOERR {
                    ErrorCode::Io
                } else if ext & 0xff == ffi::SQLITE_CONSTRAINT {
                    ErrorCode::Constraint
                } else if ext & 0xff == ffi::SQLITE_READONLY {
                    ErrorCode::Io
                } else {
                    match err.code {
                        rusqlite::ErrorCode::DatabaseBusy => ErrorCode::Busy,
                        rusqlite::ErrorCode::DatabaseLocked => ErrorCode::Locked,
                        rusqlite::ErrorCode::DatabaseCorrupt | rusqlite::ErrorCode::NotADatabase => ErrorCode::Corrupt,
                        rusqlite::ErrorCode::SystemIoFailure | rusqlite::ErrorCode::DiskFull => ErrorCode::Io,
                        rusqlite::ErrorCode::ConstraintViolation => ErrorCode::Constraint,
                        // authorizer 拒绝：这是**能力边界**，不是可重试的故障（渲染侧不该重试）
                        rusqlite::ErrorCode::AuthorizationForStatementDenied => ErrorCode::Unsupported,
                        _ => ErrorCode::Other,
                    }
                };
                DbError::new(code, detail)
            }
            R::QueryReturnedNoRows => DbError::new(ErrorCode::NotFound, "记录不存在"),
            R::InvalidQuery | R::InvalidParameterName(_) | R::InvalidParameterCount(_, _) => {
                DbError::new(ErrorCode::Other, format!("SQL 使用错误：{e}"))
            }
            _ => DbError::other(e.to_string()),
        }
    }
}

pub type DbResult<T> = Result<T, DbError>;
