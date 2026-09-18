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
    /// 显式导入事务（P4）。
    ///
    /// 迁移要把 6000+ 行分表导入，必须"全成或全不成"。但 rusqlite 的
    /// `Transaction` 借用了 `&mut Connection`，没法在函数之间传递；
    /// 于是这里用 `BEGIN`/`COMMIT` 手工管理，并用一个标志位保证
    /// **不会和普通 `write_tx` 交错**（交错会让 COMMIT 把别人的写入一起提交）。
    import_open: Mutex<bool>,
    /// 导入事务里累计写入的行数（`import_commit` 回报给调用方）
    import_written: Mutex<usize>,
}

/// 从**损坏的旧库**里抢救"项目 / 会话归属 / **设置**"，写成旁路文件。
///
/// ## 为什么必须抢救（第 47 轮补：一个"零缺口"清单上的真缺口）
///
/// 损坏恢复的链路是：`open_with_recovery` 把坏文件**改名**成 `<db>.corrupt-<ts>`，
/// 然后建一个**全新空库**；渲染侧拿到 `health.recovered` → 写"索引需要重建"标记 →
/// 维护时 `rebuildIndexFromSessionLogs()` 从**权威 JSONL 日志**把索引重建回来。
///
/// 消息正文、`hidden`、`parent_message_id`、`metadata`、工具调用都能从日志还原 ——
/// **但 `project_id` 不能**：日志记的是"消息"，不是"会话归属"
/// （`session-log-bridge.ts` 里那段注释写得很清楚：`sessions[].project_id` 只能从
/// `sessions` 域镜像取）。而重建发生在**空库**上，`sessions` 表当时是空的
/// → `projectOf` 取不到任何东西 → **所有被复活的会话 `project_id` 落成 `""`**。
///
/// `""` 在引擎里是"**全局项目**"的缺省语义，于是真机形态会是：
/// 用户的会话全部掉进"全局对话"，而他**明明有项目**。这不是"少了一点元数据"，
/// 是**归属错误**；仓库里那句告警自己就写着"这个数字应当长期为 0"。
///
/// 抢救的唯一来源就是那份坏文件的备份（"备份不能省"的理由之一，见
/// `open_with_recovery` 的注释）。读得到的部分（哪怕只有 `sessions` 表）就够救归属。
///
/// ## 第 57 轮补：**`settings` 也必须抢救**（同一个缺口的另一半）
///
/// 上一段列出的"能从日志还原"清单里**没有 `settings`**：会话 JSONL 记的是消息，
/// 而设置（模型/provider 选择、安全模式、主题、语言、各类水位与标记、插件禁用清单…）
/// **只存在于索引库里**。于是"库损坏 → 建新库"这条路上，用户的全部偏好设置
/// 连同那份坏文件一起被搁置 —— 而坏文件里它们**通常是读得出来的**。
/// 这就是审计里那条「损坏库备份**无等价物**」的真身：
/// 消息有等价物（权威日志）、归属有等价物（本函数）、**设置一个都没有**。
///
/// 所以这里把 `settings` 一起抄进旁路文件（形状见下面的写文件段），
/// 由渲染侧按**一份显式策略**决定哪些能往回写 ——
/// 策略里最关键的三条"**不许继承**"写在渲染侧 `recovery-restore.ts`
/// 的 `BLOCKED_RESTORE_KEYS` 上（内容水位会武装自愈的破坏性路径、
/// 完整性检查时间戳会让新库推迟自检、FTS 重建标记会让新库跳过重建）。
///
/// ## 为什么写成**旁路文件**而不是直接写进新库
///
/// 抢救时机在 `open()` 里，那时**渲染侧还没开始重建**，而重建（`messages.rebuild_index`）
/// 自己会 upsert `sessions` 行。两条路都写 `sessions` 会变成"两个写入者"，
/// 且引擎侧不知道哪些会话该有行（消息清单在渲染侧）。旁路文件是**一次性、只读的输入**：
/// 渲染侧重建时读它补 `projectOf`，读完即用，不产生第二个真相源。
/// `settings` 走同一条路还有个额外好处：**删掉旁路文件就等于"不要这次抢救"**，
/// 不需要去新库里回滚任何东西。
///
/// ## 失败处置（关键：**绝不影响恢复本身**）
///
/// 坏文件"坏"到读不出 `sessions` 是完全可能的（头部损坏、页级损坏）。所以：
/// 整个函数**返回结果而不抛错**，任何一步失败都返回 `0` 并让调用方继续完成恢复
/// —— 恢复的主要价值是"应用还能用 + 消息从日志回来"，归属抢救是**加分项**。
/// 抢救不到时渲染侧仍会走原来的路径（落到全局项目 + `withoutProject` 计数 + 告警），
/// 也就是说**这一步只可能变好，不可能把恢复弄坏**。
///
/// ⚠️ 第 57 轮同时把"**`sessions` 读不出来就整体放弃**"这个闸门去掉了：
/// 原来 `if sessions.is_empty() { return 0 }` 会让"只有 settings 读得出来"的坏库
/// **连设置也救不回来** —— 而设置与 `sessions` 的可读性完全独立（不同页、不同表）。
/// 现在三张表各自尽力，谁能读出来就救谁（返回条数，写文件的条件是"有任意一项"）。
fn salvage_projects_from_corrupt(backup: &Path, db_path: &Path) -> usize {
    // 只读打开：绝不动那份备份（它可能是用户唯一的物证）
    let src = match Connection::open_with_flags(
        backup,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
    ) {
        Ok(c) => c,
        Err(_) => return 0,
    };
    // 坏库上不加锁、不等锁：读不出来就放弃（busy_timeout 太长会拖住应用启动）
    let _ = src.busy_timeout(Duration::from_millis(500));

    let mut projects: Vec<(String, String, String, Option<String>, i64, i64, i64, i64)> = Vec::new();
    {
        // `projects` 可能与 `sessions` 一样受损；任一表读不出就整体放弃（宁可什么都不做）
        let mut stmt = match src.prepare(
            "SELECT id, name, path, description, pinned, created_at, last_accessed_at FROM projects",
        ) {
            Ok(s) => s,
            Err(_) => return 0,
        };
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, Option<String>>(3)?,
                r.get::<_, i64>(4).unwrap_or(0),
                r.get::<_, i64>(5).unwrap_or(0),
                r.get::<_, i64>(6).unwrap_or(0),
                // 保留位：给未来的列留出位置（当前恒 0，但列结构先固定下来）
                0i64,
            ))
        });
        let rows = match rows {
            Ok(r) => r,
            Err(_) => return 0,
        };
        for row in rows.flatten() {
            projects.push(row);
        }
    }

    let mut sessions: Vec<(String, String)> = Vec::new();
    {
        let mut stmt = match src.prepare("SELECT id, project_id FROM sessions") {
            Ok(s) => s,
            Err(_) => return 0,
        };
        let rows = stmt.query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1).unwrap_or_default()))
        });
        let rows = match rows {
            Ok(r) => r,
            Err(_) => return 0,
        };
        for row in rows.flatten() {
            sessions.push(row);
        }
    }

    /*
     * `settings`：**独立尽力**（第 57 轮）。
     *
     * 读不出来就是 0 条（`Err(_) => Vec::new()`），**不影响**上面两张表的抢救 ——
     * 这正是"某张表的损坏不该连累其它表"的落点。
     */
    let mut settings: Vec<(String, String, i64)> = Vec::new();
    if let Ok(mut stmt) = src.prepare("SELECT key, value, updated_at FROM settings") {
        if let Ok(rows) = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1).unwrap_or_default(),
                r.get::<_, i64>(2).unwrap_or(0),
            ))
        }) {
            for row in rows.flatten() {
                settings.push(row);
            }
        }
    }

    drop(src);
    if projects.is_empty() && sessions.is_empty() && settings.is_empty() {
        return 0; // 什么都读不出来：不留空文件（渲染侧按"没有抢救数据"处理）
    }

    // 只写**能从坏库里读出来的**那些行。用旁路文件承载，引擎不碰新库。
    let mut out = String::from("{\n  \"projects\": [\n");
    for (i, (id, name, path, desc, pinned, created, accessed, _)) in projects.iter().enumerate() {
        let comma = if i + 1 == projects.len() { "" } else { "," };
        out.push_str(&format!(
            "    {{\"id\":{},\"name\":{},\"path\":{},\"description\":{},\"pinned\":{},\"created_at\":{},\"last_accessed_at\":{}}}{comma}\n",
            json_str(id),
            json_str(name),
            json_str(path),
            desc.as_deref().map(json_str).unwrap_or_else(|| "null".to_string()),
            pinned,
            created,
            accessed,
        ));
    }
    out.push_str("  ],\n  \"sessions\": [\n");
    for (i, (id, project_id)) in sessions.iter().enumerate() {
        let comma = if i + 1 == sessions.len() { "" } else { "," };
        out.push_str(&format!(
            "    {{\"id\":{},\"project_id\":{}}}{comma}\n",
            json_str(id),
            json_str(project_id),
        ));
    }
    out.push_str("  ],\n  \"settings\": [\n");
    for (i, (key, value, updated_at)) in settings.iter().enumerate() {
        let comma = if i + 1 == settings.len() { "" } else { "," };
        out.push_str(&format!(
            "    {{\"key\":{},\"value\":{},\"updated_at\":{}}}{comma}\n",
            json_str(key),
            json_str(value),
            updated_at,
        ));
    }
    out.push_str("  ]\n}\n");

    let sidecar = salvage_sidecar_path(db_path);
    if std::fs::write(&sidecar, out).is_err() {
        return 0; // 写不进去 = 抢救不到（渲染侧会按原路径走并如实告警）
    }
    sessions.len() + settings.len()
}

/// 抢救文件的路径：与库同目录的 `<db>.recovered-projects.json`
fn salvage_sidecar_path(db_path: &Path) -> PathBuf {
    PathBuf::from(format!("{}.recovered-projects.json", db_path.display()))
}

/// 把字符串转成 JSON 字面量（只处理转义，不做别的事 —— 值全部来自数据库里的 TEXT）
fn json_str(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
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
    out.push('"');
    out
}

/// 把损坏的库文件改名备份（`<name>.corrupt-<ts>`），并返回备份路径。
///
/// 细节：
/// - **改名而不是复制**：坏文件可能很大，复制既慢又占双份空间；改名之后原路径就空了，
///   紧接着的 `open_inner` 会建一个新库。用户在磁盘上仍然拿得到那份坏数据。
/// - **WAL / SHM 一起搬走**：损坏常常出在 WAL 里（半截事务）。只搬主文件会留下
///   `-wal`/`-shm`，新库打开时可能又把它当成自己的日志读进去 —— 那就是"重建了还是坏的"。
/// - 改名失败（被占用/权限）→ 退回 `copy`，仍失败则如实报 IO 错误，**不假装成功**。
fn backup_corrupt_file(path: &Path) -> DbResult<PathBuf> {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let backup = PathBuf::from(format!("{}.corrupt-{stamp}", path.display()));

    let mut moved_any = false;
    for suffix in ["", "-wal", "-shm"] {
        let from = PathBuf::from(format!("{}{suffix}", path.display()));
        if !from.exists() {
            continue;
        }
        let to = PathBuf::from(format!("{}{suffix}", backup.display()));
        if std::fs::rename(&from, &to).is_ok() {
            moved_any = true;
            continue;
        }
        // 改名失败（Windows 上文件被占用是常见原因）→ 退回复制
        std::fs::copy(&from, &to)
            .map_err(|e| DbError::new(ErrorCode::Io, format!("备份损坏库失败（{}）：{e}", from.display())))?;
        let _ = std::fs::remove_file(&from);
        moved_any = true;
    }

    if !moved_any {
        return Err(DbError::new(
            ErrorCode::Io,
            format!("库被判损坏但文件不存在，无法备份：{}", path.display()),
        ));
    }
    Ok(backup)
}

impl Engine {
    /// 打开（或新建）库：PRAGMA → 装安全边界 → schema/迁移
    pub fn open(path: impl AsRef<Path>) -> DbResult<Self> {
        Self::open_inner(path.as_ref())
    }

    /// **打开失败且属于"库损坏"时：备份坏文件、重建空库**（第 19 轮补的缺口）。
    ///
    /// ## 为什么需要它（这条能力曾经存在，删 sql.js 时丢了）
    ///
    /// 旧引擎（sql.js）在 `PRAGMA quick_check` 失败时会把坏文件备份成 `<path>.corrupt-<ts>`，
    /// 然后重建一个空库继续跑 —— 索引丢了没关系，**权威副本是会话 JSONL**，
    /// 下次启动的维护会从日志把索引重建回来。删掉旧引擎之后这条能力**没有对应物**：
    /// 库文件一旦损坏，`Engine::open` 直接失败 → 渲染侧端口注册失败 →
    /// 「本进程没有可用存储」→ 用户看到的是"应用不能用了"，而他的数据其实还在日志里。
    ///
    /// ## 为什么"备份"不能省
    ///
    /// 重建 = 从零开始；备份 = 把**可能还能救的那一份**原样留在磁盘上（改名，不改内容）。
    /// 直接删掉坏文件等于替用户销毁证据，而这类文件用 `.recover` / 手工 SQL 有时还能捞出东西。
    ///
    /// ## 返回值
    ///
    /// `(engine, Some(备份路径))` = 发生过恢复；`(engine, None)` = 正常打开。
    /// **调用方必须把这件事报出去**（渲染侧会据此写"索引需要重建"标记并提示用户），
    /// 悄悄恢复 = 用户永远不会知道自己丢过一次索引。
    pub fn open_with_recovery(path: impl AsRef<Path>) -> DbResult<(Self, Option<PathBuf>)> {
        let path = path.as_ref().to_path_buf();
        match Self::open_inner(&path) {
            Ok(engine) => Ok((engine, None)),
            Err(e) if e.code == ErrorCode::Corrupt => {
                let backup = backup_corrupt_file(&path)?;
                /*
                 * 第 47 轮补：在**建新库之前**抢救"项目 / 会话归属"。
                 *
                 * 时机很关键：这一步只读那份刚改名的备份，产出一个旁路文件；
                 * 渲染侧重建索引时读它补 `project_id`（否则所有复活的会话都落到
                 * "全局项目"）。**失败不影响恢复** —— 见函数注释。
                 */
                let salvaged = salvage_projects_from_corrupt(&backup, &path);
                if salvaged > 0 {
                    // 信息级：这是一件"抢救到了"的**好事**，不是错误
                    eprintln!(
                        "[codem-db] 损坏恢复：已从备份抢救 {salvaged} 个会话的项目归属 → {}",
                        salvage_sidecar_path(&path).display()
                    );
                }
                // 重建：坏文件已经改名走了，这里拿到的一定是全新库
                let engine = Self::open_inner(&path)?;
                Ok((engine, Some(backup)))
            }
            Err(e) => Err(e),
        }
    }

    fn open_inner(path: &Path) -> DbResult<Self> {
        let path = path.to_path_buf();
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

        /*
         * 自动回收空闲页（第 44 轮：真机实测 115,191,808 B 的库里活数据只有 16,392,192 B，
         * `freelist_count` = 98,799,616 B —— **85.8% 是永不回收的空闲页**，全 crate 零处 VACUUM）。
         *
         * ⚠️ 顺序极其关键：这句必须在**其它任何 pragma 之前**。
         *
         * SQLite 的 `auto_vacuum` 只对**还没有页的库**生效；一旦库里有了页，
         * 写这个 pragma 会被**静默忽略**（不报错、读回来还是 0）。
         * 而紧跟着的那串 pragma 里 `journal_mode=WAL` 就会把文件头写出来 ——
         * 于是"先设 WAL、再设 auto_vacuum"永远拿不到想要的结果。
         * （这个坑是写这条测试时踩到的：先按直觉把 auto_vacuum 拼进那串 pragma，
         *   测试报 `auto_vacuum == 0`，而代码看上去完全正确。）
         *
         * 老库（已有页）不在这里处理：它需要一次 `VACUUM` 才能转换，
         * 那个动作留给 `storage.compact`（那里本来就要整库重写，顺手转换不额外花钱）。
         */
        let pages_on_disk: i64 = conn
            .query_row("PRAGMA page_count", [], |r| r.get(0))
            .unwrap_or(0);
        if pages_on_disk == 0 {
            conn.execute_batch("PRAGMA auto_vacuum=INCREMENTAL;")
                .map_err(DbError::from)?;
        }

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

        let mut schema_report = schema::apply(&conn)?;

        /*
         * 删除审计（第 31 轮事故）。
         *
         * 装在**引擎打开时**、而不是"某个命令里"，是刻意的：
         * 事故的形态是"数据消失了，但渲染侧的端口审计里没有任何删除" ——
         * 也就是说，光在命令层记账抓不到它。触发器在 SQLite 内部执行，
         * 无论删除来自哪条路径都会留下记录。
         */
        crate::audit::install(&conn)?;

        /*
         * 报表必须在**全部打开步骤做完之后**取数（真机/CI 发现的缺陷）。
         *
         * `audit::install` 会建一张 `storage_audit` 表，而它是在 `schema::apply`
         * **之后**执行的 —— 于是"全新库第一次打开"报出来的表数比"第二次打开"少 1：
         * 第一次的报表取在审计表建好之前，第二次的报表取在它已存在之后。
         *
         * 后果不是功能坏掉，而是**诊断数字不可信**（同一个库每次打开报的表数不同，
         * `engine_tests::schema_apply_is_idempotent` 正是被这条打红的）。
         * 这类"报表与实际状态不一致"的问题必须在这里收口：报表是排查事故的依据，
         * 一个会随打开次数漂移的数字比没有数字更糟。
         */
        schema_report.tables = schema::table_count(&conn)?;

        Ok(Self {
            path,
            conn: Mutex::new(conn),
            opened_at: Instant::now(),
            last_error_code: Mutex::new(None),
            schema_report,
            import_open: Mutex::new(false),
            import_written: Mutex::new(0),
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
        /*
         * 导入事务开着的时候**不许**走普通写路径（第 44 轮：把注释里的承诺真的兑现）。
         *
         * `import_open` 这个标志存在的理由，注释里写得很清楚："保证不会和普通 `write_tx` 交错
         * —— 交错会让 COMMIT 把别人的写入一起提交"。但在这一轮之前，`write_tx`
         * **从来没有读过它**：真交错时 SQLite 会以 `BEGIN DEFERRED` 撞上已有事务、
         * 抛一句"cannot start a transaction within a transaction"，
         * 调用方拿到的是**引擎内部术语**而不是"现在正在导入，稍后再写"。
         *
         * 更糟的一种可能是：如果哪天有人把 `transaction()` 换成 `savepoint()`（看起来更"稳"），
         * 交错就会**真的发生**，而且是静默的 —— 导入事务的 `COMMIT` 会把这次写入一起提交，
         * 于是"导入失败 → 回滚"不再能保证"库里回到导入前"。标志位就是为这件事存在的，
         * 那么使用它必须发生在**唯一的写入口**上。
         */
        if self.import_in_progress() {
            return Err(DbError::new(
                ErrorCode::Unavailable,
                "正在导入（import.begin 与 import.end 之间），此时不接受普通写入：\
                 导入事务提交时会把并发的写入一起提交，导致导入失败后无法完整回滚",
            ));
        }
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

    // ===== 导入事务（P4 迁移原语：跨调用、全成或全不成） =====

    /// 开始导入事务。重复调用是幂等的（不会嵌套 BEGIN）。
    pub fn import_begin(&self) -> DbResult<()> {
        let mut open = self
            .import_open
            .lock()
            .map_err(|_| DbError::new(ErrorCode::Unavailable, "导入状态锁已中毒"))?;
        if *open {
            return Ok(());
        }
        let conn = self
            .conn
            .lock()
            .map_err(|_| DbError::new(ErrorCode::Unavailable, "连接锁已中毒（不应发生）"))?;
        conn.execute_batch("BEGIN IMMEDIATE").map_err(DbError::from)?;
        *open = true;
        if let Ok(mut n) = self.import_written.lock() {
            *n = 0;
        }
        Ok(())
    }

    /// 提交导入事务，返回累计写入行数。
    pub fn import_commit(&self) -> DbResult<usize> {
        let mut open = self
            .import_open
            .lock()
            .map_err(|_| DbError::new(ErrorCode::Unavailable, "导入状态锁已中毒"))?;
        if !*open {
            return Err(DbError::other("没有进行中的导入事务（import.end 必须先 import.begin）"));
        }
        let conn = self
            .conn
            .lock()
            .map_err(|_| DbError::new(ErrorCode::Unavailable, "连接锁已中毒（不应发生）"))?;
        conn.execute_batch("COMMIT").map_err(DbError::from)?;
        *open = false;
        Ok(self.import_written.lock().map(|g| *g).unwrap_or(0))
    }

    /// 回滚导入事务（失败收尾；没有进行中的事务时是安全的 no-op）
    pub fn import_rollback(&self) -> DbResult<()> {
        let mut open = self
            .import_open
            .lock()
            .map_err(|_| DbError::new(ErrorCode::Unavailable, "导入状态锁已中毒"))?;
        if !*open {
            return Ok(());
        }
        let conn = self
            .conn
            .lock()
            .map_err(|_| DbError::new(ErrorCode::Unavailable, "连接锁已中毒（不应发生）"))?;
        let rollback = conn.execute_batch("ROLLBACK").map_err(DbError::from);
        *open = false;
        rollback
    }

    /// 导入期间写一行：走显式导入事务（不自己 BEGIN），并累计计数。
    pub fn import_write<T>(&self, f: impl FnOnce(&Connection) -> DbResult<T>) -> DbResult<T> {
        {
            let open = self
                .import_open
                .lock()
                .map_err(|_| DbError::new(ErrorCode::Unavailable, "导入状态锁已中毒"))?;
            if !*open {
                return Err(DbError::other(
                    "import.table 必须在 import.begin 之后调用（否则每批各行独立提交，中途失败会留下半个库）",
                ));
            }
        }
        let conn = self
            .conn
            .lock()
            .map_err(|_| DbError::new(ErrorCode::Unavailable, "连接锁已中毒（不应发生）"))?;
        let out = f(&conn);
        if let Ok(n) = &out {
            if let Ok(mut w) = self.import_written.lock() {
                *w += 1; // 按"批次"计；精确行数由各命令自己回报
                let _ = n;
            }
        }
        out
    }

    /// 是否有进行中的导入事务（诊断用）
    pub fn import_in_progress(&self) -> bool {
        self.import_open.lock().map(|g| *g).unwrap_or(false)
    }
}

#[cfg(test)]
mod salvage_tests {
    use super::*;
    use serde_json::{json, Value};

    /// 造一个"正常库"，用于验证抢救**读取**逻辑（不制造损坏）。
    ///
    /// ## 为什么这里不造损坏（分工说明）
    ///
    /// 恢复链路有三段：① `open_inner` 判 CORRUPT → ② `backup_corrupt_file` 改名 →
    /// ③ `salvage_projects_from_corrupt` 读备份写旁路文件。
    /// `engine_tests::corrupt_recovery_salvages_project_attribution` 覆盖的是"①→② 会发生、
    /// 且恢复后库可用"，而它**允许旁路文件不存在**（坏到读不出任何表时本就该没有）
    /// —— 所以它钉不住"抢救到底抄了哪些表"。
    /// 本模块直接对 ③ 下手：喂一个**能读的文件**，逐项断言旁路文件的内容。
    /// 两段合起来才是完整链路（③ 在真机上的触发条件由 ① 保证）。
    fn seed_db(path: &std::path::Path) {
        let engine = Engine::open(path).unwrap();
        engine
            .write_tx(|tx| {
                tx.execute(
                    "INSERT INTO projects (id, name, path, description, pinned, created_at, last_accessed_at) \
                     VALUES ('p1','mimo-gui','C:/mimo-gui',NULL,0,1,1)",
                    [],
                )
                .map_err(DbError::from)?;
                tx.execute(
                    "INSERT INTO sessions (id, project_id, title, created_at, last_message_at, message_count, pinned) \
                     VALUES ('s1','p1','对话 1',1,1,0,0)",
                    [],
                )
                .map_err(DbError::from)?;
                for (k, v) in [
                    ("codem-language", "zh"),
                    ("codem-theme", "dark"),
                    // 这条**必须**被抄进旁路文件：它是"不许继承"的键之一，
                    // 但"读出来"和"写回去"是两件事 —— 策略在渲染侧，
                    // 引擎侧只负责**如实抄出来**（渲染侧才有"该不该写回"的知识）。
                    ("codem-storage-content-watermark", "{\"at\":1,\"messages\":821}"),
                ] {
                    tx.execute(
                        "INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, 1)",
                        rusqlite::params![k, v],
                    )
                    .map_err(DbError::from)?;
                }
                Ok(())
            })
            .unwrap();
        let _ = engine.checkpoint();
    }

    #[test]
    fn salvage_sidecar_carries_settings_and_ownership() {
        let dir = tempfile::tempdir().unwrap();
        let live = dir.path().join("codem-db-rust.bin");
        seed_db(&live);

        // 直接把"活库"当成备份喂进去（读取逻辑与真备份完全同一条路径）
        let n = salvage_projects_from_corrupt(&live, &live);
        assert!(n >= 4, "应当救出 2 项归属 + 3 条设置，实际 {n}");

        let sidecar = salvage_sidecar_path(&live);
        let text = std::fs::read_to_string(&sidecar).expect("旁路文件必须写出来");
        let v: Value = serde_json::from_str(&text).expect("必须是合法 JSON（半截文件会让渲染侧解析失败）");

        // ⚠️ 项目行**不止 1 条**：schema 阶段会种一行 `id = ""` 的"全局项目"
        // （`sessions.project_id` 缺省就是 `""`，靠这一行满足外键）。
        // 第一版断言 `len() == 1` 就是这么红的 —— 判据要盯"我们那条在不在"，
        // 而不是"总数等于几"（总数由 schema 决定，不是本函数的行为）。
        let projects = v["projects"].as_array().unwrap();
        assert!(
            projects.iter().any(|p| p["id"] == json!("p1") && p["name"] == json!("mimo-gui")),
            "项目必须逐字带出：{projects:?}"
        );
        assert_eq!(v["sessions"].as_array().unwrap().len(), 1);
        assert!(
            v["sessions"].as_array().unwrap()[0]["project_id"] == json!("p1"),
            "会话归属必须带出：{:?}",
            v["sessions"]
        );
        let settings = v["settings"].as_array().expect("必须有 settings 数组（第 57 轮新增）");
        assert_eq!(settings.len(), 3, "三条设置都要抄出来：{settings:?}");
        assert!(
            settings.iter().any(|s| s["key"] == json!("codem-language") && s["value"] == json!("zh")),
            "键值必须逐字带出：{settings:?}"
        );
        assert!(
            settings.iter().any(|s| s["key"] == json!("codem-storage-content-watermark")),
            "「不许继承」的键也要**读出来**（读与写是两件事，策略在渲染侧）"
        );
    }

    #[test]
    fn salvage_returns_zero_and_writes_nothing_for_unreadable_file() {
        let dir = tempfile::tempdir().unwrap();
        let live = dir.path().join("codem-db-rust.bin");
        std::fs::write(&live, vec![0x41u8; 8192]).unwrap();

        let n = salvage_projects_from_corrupt(&live, &live);
        assert_eq!(n, 0, "读不出来的文件不许报成'抢救到了'");
        assert!(
            !salvage_sidecar_path(&live).exists(),
            "读不出任何东西时**不许留空文件** —— 空文件会让渲染侧以为'抢救过但没有内容'"
        );
    }
}