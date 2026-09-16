//! 存储引擎：单写者 + WAL 增量落盘（第 92 波 P1）
//!
//! 与渲染侧 sql.js 实现的根本差别：
//! - **没有整库导出**：WAL 模式下每次提交只写变化的页；
//! - **单写者**：所有写经同一把互斥锁（`Mutex<Connection>`），跨 await 不会交错；
//! - **错误是值**：见 `error.rs`；引擎不再可能"中毒"；
//! - **安全边界**：见 `authorizer.rs`。

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use rusqlite::{Connection, OpenFlags};
use serde::Serialize;

use crate::authorizer;
use crate::error::{DbError, DbResult, ErrorCode};
use crate::schema::{self, SchemaReport};

/// 单条语句的行数上限（Rust 侧硬上限；渲染侧分页请求也会被夹住）
pub const MAX_ROWS_PER_QUERY: usize = 5_000;
/// 单次查询返回的近似字节上限（防止大 payload 把 IPC/内存打爆）
pub const MAX_BYTES_PER_QUERY: usize = 16 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
pub struct Health {
    pub engine: &'static str,
    pub ready: bool,
    pub path: String,
    /// 页数 × 页大小（增量落盘下的"当前库大小"）
    pub size_bytes: i64,
    pub journal_mode: String,
    /// WAL 文件当前字节数（文件系统读取；不是 checkpoint 结果，健康检查保持只读）
    pub wal_size_bytes: i64,
    pub tables: usize,
    pub fts_module: String,
    pub last_error_code: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Integrity {
    pub ok: bool,
    pub detail: String,
}

pub struct Engine {
    path: PathBuf,
    conn: Mutex<Connection>,
    opened_at: Instant,
    last_error_code: Mutex<Option<String>>,
    schema_report: SchemaReport,
}

impl Engine {
    /// 打开（或新建）库：PRAGMA → 装安全边界 → schema/迁移
    pub fn open(path: impl AsRef<Path>) -> DbResult<Self> {
        let path = path.as_ref().to_path_buf();
        if let Some(dir) = path.parent() {
            if !dir.as_os_str().is_empty() {
                std::fs::create_dir_all(dir)
                    .map_err(|e| DbError::new(ErrorCode::Io, format!("创建目录失败：{e}")))?;
            }
        }

        let conn = Connection::open_with_flags(
            &path,
            OpenFlags::SQLITE_OPEN_READ_WRITE
                | OpenFlags::SQLITE_OPEN_CREATE
                | OpenFlags::SQLITE_OPEN_URI,
        )
        .map_err(DbError::from)?;

        // === 引擎级 PRAGMA（必须在装 authorizer 之前设置）===
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;\
             PRAGMA synchronous=NORMAL;\
             PRAGMA busy_timeout=5000;\
             PRAGMA foreign_keys=ON;\
             PRAGMA temp_store=MEMORY;",
        )
        .map_err(DbError::from)?;

        // === 安全边界 ===
        authorizer::install(&conn);

        let schema_report = schema::apply(&conn)?;

        Ok(Self {
            path,
            conn: Mutex::new(conn),
            opened_at: Instant::now(),
            last_error_code: Mutex::new(None),
            schema_report,
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn schema_report(&self) -> &SchemaReport {
        &self.schema_report
    }

    pub fn uptime(&self) -> Duration {
        self.opened_at.elapsed()
    }

    /// 只读访问（单写者模型下，读也用同一连接 —— SQLite 连接本身是串行化的）
    pub fn with_conn<T>(&self, f: impl FnOnce(&Connection) -> DbResult<T>) -> DbResult<T> {
        let guard = self
            .conn
            .lock()
            .map_err(|_| DbError::new(ErrorCode::Unavailable, "连接锁已中毒（不应发生）"))?;
        let out = f(&guard);
        if let Err(e) = &out {
            if let Ok(mut slot) = self.last_error_code.lock() {
                *slot = Some(e.code.as_str().to_string());
            }
        } else if let Ok(mut slot) = self.last_error_code.lock() {
            *slot = None;
        }
        out
    }

    /// 写事务：**所有写都走这里**（顺序执行、全成或全败）
    pub fn write_tx<T>(&self, f: impl FnOnce(&rusqlite::Transaction<'_>) -> DbResult<T>) -> DbResult<T> {
        let mut guard = self
            .conn
            .lock()
            .map_err(|_| DbError::new(ErrorCode::Unavailable, "连接锁已中毒（不应发生）"))?;
        let tx = guard.transaction().map_err(DbError::from)?;
        match f(&tx) {
            Ok(v) => {
                tx.commit().map_err(DbError::from)?;
                if let Ok(mut slot) = self.last_error_code.lock() {
                    *slot = None;
                }
                Ok(v)
            }
            Err(e) => {
                let _ = tx.rollback();
                if let Ok(mut slot) = self.last_error_code.lock() {
                    *slot = Some(e.code.as_str().to_string());
                }
                Err(e)
            }
        }
    }

    pub fn health(&self) -> DbResult<Health> {
        self.with_conn(|conn| {
            let page_count: i64 = conn
                .query_row("PRAGMA page_count", [], |r| r.get(0))
                .unwrap_or(0);
            let page_size: i64 = conn
                .query_row("PRAGMA page_size", [], |r| r.get(0))
                .unwrap_or(0);
            let journal_mode: String = conn
                .query_row("PRAGMA journal_mode", [], |r| r.get(0))
                .unwrap_or_else(|_| "unknown".to_string());
            // 注意：`PRAGMA wal_checkpoint(...)` 返回一行三列，且**会写**（把 WAL 页并回主库）。
            // 健康检查必须是只读的：这里只读 `journal_mode`/`page_count` 等，不做 checkpoint。
            let tables: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%'",
                    [],
                    |r| r.get(0),
                )
                .unwrap_or(0);
            Ok(Health {
                engine: "rust",
                ready: true,
                path: self.path.to_string_lossy().to_string(),
                size_bytes: page_count * page_size,
                journal_mode,
                // SQLite 的 WAL 文件名 = 主库路径 + "-wal"
                wal_size_bytes: {
                    let wal = format!("{}-wal", self.path.to_string_lossy());
                    std::fs::metadata(&wal).map(|m| m.len() as i64).unwrap_or(0)
                },
                tables: tables as usize,
                fts_module: schema::fts_module(conn).unwrap_or_else(|_| "unknown".to_string()),
                last_error_code: self
                    .last_error_code
                    .lock()
                    .ok()
                    .and_then(|g| g.clone()),
            })
        })
    }

    /// 完整性检查（迁移对账与"要不要重建索引"的判断依据）
    pub fn integrity_check(&self) -> DbResult<Integrity> {
        self.with_conn(|conn| {
            let detail: String = conn
                .query_row("PRAGMA quick_check", [], |r| r.get(0))
                .unwrap_or_else(|e| format!("check failed: {e}"));
            Ok(Integrity {
                ok: detail.eq_ignore_ascii_case("ok"),
                detail,
            })
        })
    }

    /// WAL checkpoint（不是整库导出：只把 WAL 里的页并回主库）
    pub fn checkpoint(&self) -> DbResult<()> {
        self.with_conn(|conn| {
            conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))
                .map(|_| ())
                .map_err(DbError::from)
        })
    }

    /// 表行数（迁移对账用）
    pub fn table_counts(&self, tables: &[String]) -> DbResult<Vec<(String, i64)>> {
        self.with_conn(|conn| {
            let mut out = Vec::new();
            for t in tables {
                // 表名来自调用方白名单（CLI/对账工具），这里仍做一次字符校验，避免拼接注入
                if !t.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
                    return Err(DbError::other(format!("非法表名：{t}")));
                }
                let n: i64 = conn
                    .query_row(&format!("SELECT COUNT(*) FROM {t}"), [], |r| r.get(0))
                    .unwrap_or(0);
                out.push((t.clone(), n));
            }
            Ok(out)
        })
    }
}
