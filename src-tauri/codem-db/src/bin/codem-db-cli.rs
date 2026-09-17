//! `codem-db-cli` —— 存储引擎的命令行入口
//!
//! ## 为什么需要它（P1 的关键设计）
//!
//! 契约测试跑在 vitest（Node）里，**无法直接调用 Tauri IPC**。把引擎做成 CLI 后：
//! - 契约测试可以**真的驱动生产实现**（而不是"测试 WASM、生产 Rust"的双实现分歧）；
//! - 迁移对账、规模压测、故障复现都能离线用同一条命令完成；
//! - Tauri 命令层只剩"解码 → dispatch → 编码"，没有业务逻辑。
//!
//! 用法：
//!   codem-db-cli --db <path> init
//!   codem-db-cli --db <path> health
//!   codem-db-cli --db <path> integrity
//!   codem-db-cli --db <path> counts [table,table]
//!   codem-db-cli --db <path> invoke <command> ['{"json":"params"}']
//!   codem-db-cli --db <path> invoke <command> -        # 参数从 stdin 读（绕开 shell 引号规则）
//!   codem-db-cli --db <path> batch '<[{"command":"…","params":{…}}]>'
//!   codem-db-cli --db <path> commands
//!
//! 约定：**stdout 只输出一行 JSON**（结果或错误），退出码 0=成功、1=错误。
//!
//! ## ⚠️ `--db` 是**读写**打开的（会应用 schema 并安装删除审计触发器）
//!
//! 这一条必须写在最显眼的地方，因为它踩过一次：有人想"只用 CLI 读一下旧库"，
//! 于是 `--db <旧库路径>`，结果那个文件被改动了（多出 8 个触发器 + 新表结构，
//! sha256 前后不同）—— 而旧库是**回滚时唯一的那一份**。
//!
//! 要读旧库，请用**只读**通道（它们内部都是 `SQLITE_OPEN_READ_ONLY`）：
//!   codem-db-cli --db <新库> invoke legacy.read_table -   # 参数 {"legacy_path":"<旧库>","table":"messages"}
//!   codem-db-cli --db <新库> invoke migration.auto  -     # 参数 {"legacy_path":"<旧库>"}
//! 也就是说：`--db` 指向**目标（新）库**，旧库通过参数传进去。
//!
//! 响应形状（**每条响应都自描述**，调用方不需要猜）：
//! - 成功：`{"ok":true, ...}`（`invoke` 是 `{"ok":true,"result":…}`）
//! - 失败：`{"ok":false,"error":{"code":"BUSY","message":"…","retryable":true}}`
//!
//! ## batch 的语义（与渲染侧 `StorageDataPort.write` 对齐）
//!
//! 顺序执行、每步一个独立事务、**失败即停**，并返回 `completed`（已成功步数）与 `failed_at`。
//! 之所以不是"整批一个事务"：渲染侧的批量写调用点分布在不同领域（会话/消息/事件），
//! 把它们的成败绑成一个事务会让"一条消息写失败"回滚掉整个会话的写入 —— 那不是调用方要的语义。
//! 需要真正原子性的地方用 `messages.create_many` / `messages.update_many` 这种**单命令内的多行事务**。

use std::process::ExitCode;

use codem_db::migrate;
use codem_db::{capabilities, dispatch, DbError, Engine};
use serde_json::{json, Value};

fn usage() -> &'static str {
    "codem-db-cli --db <path> <init|health|integrity|checkpoint|counts|commands|invoke|batch> [args]"
}

fn print_json(v: &Value) {
    println!("{}", serde_json::to_string(v).unwrap_or_else(|_| "{}".to_string()));
}

fn error_json(e: &DbError) -> Value {
    json!({ "code": e.code.as_str(), "message": e.message, "retryable": e.retryable })
}

/// `counts` 的可选表名参数：`counts messages,sessions` → `["messages","sessions"]`（缺省 = 引擎默认表集）
fn tables_arg(rest: &[String]) -> Value {
    match rest.get(1) {
        None => Value::Null,
        Some(s) => Value::Array(
            s.split(',')
                .map(|x| x.trim())
                .filter(|x| !x.is_empty())
                .map(|x| Value::String(x.to_string()))
                .collect(),
        ),
    }
}

/// 从 stdin 读一段 JSON 文本。
///
/// 两个必须处理的现实问题（否则脚本/测试会莫名失败）：
/// 1. **BOM**：PowerShell 的 `'…' | native.exe` 会带上 UTF-8 BOM（`\u{feff}`），
///    serde_json 会报 `expected value at line 1 column 1`，看起来像"参数写错了"；
/// 2. 空输入：视为 `{}`（`invoke <cmd> -` 且没喂数据时不应当报错）。
fn read_stdin_json() -> Result<Option<Value>, DbError> {
    use std::io::Read;
    let mut bytes = Vec::new();
    std::io::stdin()
        .read_to_end(&mut bytes)
        .map_err(|e| DbError::other(format!("读取 stdin 失败：{e}")))?;
    // 去 BOM（UTF-16 的两种 BOM 也一并跳过，虽然实践中少见）
    let text = if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        String::from_utf8_lossy(&bytes[3..]).to_string()
    } else if bytes.starts_with(&[0xFF, 0xFE]) || bytes.starts_with(&[0xFE, 0xFF]) {
        String::from_utf8_lossy(&bytes[2..]).to_string()
    } else {
        String::from_utf8_lossy(&bytes).to_string()
    };
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    serde_json::from_str(trimmed)
        .map(Some)
        .map_err(|e| DbError::other(format!("stdin 不是合法 JSON：{e}")))
}

/// 解析一个位置参数为 JSON 对象（缺省 `{}`）。
///
/// `-` 表示**从 stdin 读 JSON**：这是给脚本/契约测试用的。
/// 实测教训：PowerShell 把参数里的 `"` 转义成 `\"` 传给原生程序，
/// 于是 `invoke sessions.list '{"limit":3}'` 会变成非法 JSON（`key must be a string`）。
/// 用 stdin 传参可以完全绕开各 shell 的引号规则差异。
fn params_arg(rest: &[String], idx: usize) -> Result<Value, DbError> {
    match rest.get(idx) {
        None => Ok(json!({})),
        Some(raw) if raw == "-" => Ok(read_stdin_json()?.unwrap_or_else(|| json!({}))),
        Some(raw) => serde_json::from_str(raw)
            .map_err(|e| DbError::other(format!("参数不是合法 JSON：{e}"))),
    }
}

fn run(engine: &Engine, path: &str, rest: &[String]) -> Result<Value, DbError> {
    let Some(command) = rest.first().map(|s| s.as_str()) else {
        return Err(DbError::other(format!("缺少子命令。用法：{}", usage())));
    };
    match command {
        "init" => Ok(json!({
            "ok": true,
            "engine": "rust",
            "schema": engine.schema_report(),
            "path": path,
        })),
        // 注意：每个分支都已经是 `Result`（用 `?` 或 `map`）。
        // 不能把 `Result` 塞进 `Ok(json!{...})` —— 那样会序列化成 `{"Ok": ...}` 而不是结果本身。
        "health" => engine.health().map(|h| json!({ "ok": true, "health": h })),
        "integrity" => {
            let r = engine.integrity_check()?;
            Ok(json!({ "ok": r.ok, "detail": r.detail }))
        }
        "checkpoint" => {
            engine.checkpoint()?;
            Ok(json!({ "ok": true }))
        }
        "commands" => Ok(capabilities()),
        // 一次性导入：**整批在同一个进程/连接里完成**。
        //
        // 为什么必须有这个子命令（而不是让人连续调用 import.begin / import.table / import.end）：
        // `--db` 每次调用都会新开一个连接，而事务属于连接 —— 上一次调用开的 BEGIN
        // 会随进程退出被回滚，下一次调用看到的是"没有进行中的事务"。
        // 实测踩过：CLI 报 "import.table 必须在 import.begin 之后调用"，但表面上明明按顺序调了。
        "import" => {
            let payload = read_stdin_json()?.ok_or_else(|| {
                DbError::other("import 需要从 stdin 读 JSON：数组或 {\"tables\":[…]}")
            })?;
            migrate::import_all(engine, &payload)
        }
        "counts" => dispatch(engine, "counts", &json!({ "tables": tables_arg(rest) })),
        /*
         * 删除审计（第 31 轮事故排查）。
         *
         * `audit`            → 最近 50 条被删/被隐藏的行（哪张表、什么时候、哪个会话）
         * `audit summary`    → 按 (表, 操作) 聚合（"哪张表被清得最多"）
         * `audit clear`      → 清空审计表（排查完成后收尾）
         *
         * 之所以做成 CLI 子命令而不是只走 `invoke`：事故排查往往在**应用没启动**
         * 的现场做（库可能是脏的、应用一开就变），CLI 能在不启动应用的前提下取证。
         */
        "audit" => match rest.get(1).map(|s| s.as_str()) {
            Some("clear") => dispatch(engine, "audit.clear", &json!({})),
            Some("summary") => dispatch(engine, "audit.summary", &json!({})),
            _ => {
                let limit = rest
                    .get(1)
                    .and_then(|s| s.parse::<u64>().ok())
                    .unwrap_or(50);
                dispatch(engine, "audit.recent", &json!({ "limit": limit }))
            }
        },
        "invoke" => {
            let cmd = rest
                .get(1)
                .ok_or_else(|| DbError::other("invoke 需要命令名"))?;
            let params = params_arg(rest, 2)?;
            // 引擎错误原样上抛（退出码 1 + 结构化 JSON），不做包装 —— 契约测试直接读 code。
            // 成功时也要带上 `ok: true`：**每条响应都必须是自描述的**，
            // 否则调用方无法区分"命令结果"和"错误体"，只能靠猜字段名（实测被契约测试抓住过）。
            dispatch(engine, cmd, &params).map(|v| json!({ "ok": true, "result": v }))
        }
        "batch" => {
            let raw = rest
                .get(1)
                .ok_or_else(|| DbError::other("batch 需要 JSON 数组（或 `-` 从 stdin 读）"))?;
            let items: Value = if raw == "-" {
                read_stdin_json()?
                    .ok_or_else(|| DbError::other("batch 的 stdin 为空（需要 JSON 数组）"))?
            } else {
                serde_json::from_str(raw)
                    .map_err(|e| DbError::other(format!("参数不是合法 JSON：{e}")))?
            };
            let arr = items
                .as_array()
                .ok_or_else(|| DbError::other("batch 需要数组"))?;
            let mut results = Vec::new();
            for it in arr {
                let cmd = it
                    .get("command")
                    .and_then(|x| x.as_str())
                    .ok_or_else(|| DbError::other("batch 每项都需要 command 字段"))?
                    .to_string();
                let params = it.get("params").cloned().unwrap_or_else(|| json!({}));
                match dispatch(engine, &cmd, &params) {
                    Ok(v) => results.push(json!({ "command": cmd, "ok": true, "result": v })),
                    Err(e) => {
                        /*
                         * 部分成功是**事实**，必须如实返回（调用方据此决定补偿）。
                         *
                         * ⚠️ 第 45 轮 Z-7：文案改由 `codem_db::batch_failure_message` 统一生成
                         * —— 这里原来是 `…已完成 {} 步：{}` + `serde_json::to_string(&results)`，
                         * 把**已完成的完整结果 JSON** 内嵌进错误（一条 `messages.list` 就是几 MB），
                         * 于是 CLI/Tauri 两条 batch 的**错误形状分歧**：那边早在第 44 轮就改成
                         * 只留命令名清单了，这边没跟上（两侧注释都声称"与另一侧对齐"）。
                         * 现在文案只有一处实现，不可能再分歧。
                         */
                        let completed: Vec<String> = results
                            .iter()
                            .filter_map(|d| d.get("command").and_then(|c| c.as_str()))
                            .map(|s| s.to_string())
                            .collect();
                        return Err(DbError::new(
                            e.code,
                            codem_db::batch_failure_message(
                                results.len() + 1,
                                &cmd,
                                &e.message,
                                &completed,
                            ),
                        ));
                    }
                }
            }
            Ok(json!({ "ok": true, "count": results.len(), "results": results }))
        }
        other => Err(DbError::unsupported(format!(
            "未知子命令：{other}。用法：{}",
            usage()
        ))),
    }
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut db_path: Option<String> = None;
    let mut rest: Vec<String> = Vec::new();
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--db" => {
                i += 1;
                match args.get(i) {
                    Some(p) => db_path = Some(p.clone()),
                    None => {
                        print_json(&json!({
                            "ok": false,
                            "error": error_json(&DbError::other("--db 需要一个路径")),
                        }));
                        return ExitCode::from(1);
                    }
                }
            }
            "--help" | "-h" => {
                eprintln!("{}", usage());
                return ExitCode::SUCCESS;
            }
            other => rest.push(other.to_string()),
        }
        i += 1;
    }

    let Some(path) = db_path else {
        eprintln!("{}", usage());
        print_json(&json!({
            "ok": false,
            "error": error_json(&DbError::other("缺少 --db <path>")),
        }));
        return ExitCode::from(1);
    };

    // 打开引擎（含 schema/迁移）：失败也返回结构化错误，绝不 panic。
    //
    // 第 19 轮：改用 `open_with_recovery` —— 库文件损坏时**先备份坏文件再重建**，
    // 并在响应里报出 `recovered_from`。CLI 与 Tauri 命令层共用这一条路径，
    // 所以契约测试（C28）验证的就是生产行为。
    let (engine, recovered_from) = match Engine::open_with_recovery(&path) {
        Ok(pair) => pair,
        Err(e) => {
            print_json(&json!({ "ok": false, "path": path, "error": error_json(&e) }));
            return ExitCode::from(1);
        }
    };

    /*
     * 打开成功之后再提醒一次：如果这个库看起来是**旧引擎（sql.js）**写出来的，
     * 那么刚才那次打开已经改动过它了（应用 schema + 安装删除审计触发器）。
     *
     * 为什么不直接拒绝打开：判据（"有 sessions 表但没有 storage_audit"）对
     * 极老的 Rust 库也可能成立，而那种库恰恰**需要**被打开以应用迁移 ——
     * 拒绝会让它永久打不开。所以这里选择"如实说出来"而不是"替用户决定"。
     * 真正该做的是让调用方一开始就别把 `--db` 指向旧库（见文件头的说明）。
     */
    if let Ok(true) = engine.with_conn(|conn| {
        let has_sessions: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='sessions'",
                [],
                |r| r.get(0),
            )
            .map_err(codem_db::DbError::from)?;
        let has_audit: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='storage_audit'",
                [],
                |r| r.get(0),
            )
            .map_err(codem_db::DbError::from)?;
        Ok(has_sessions > 0 && has_audit == 0)
    }) {
        eprintln!(
            "[codem-db-cli] ⚠️ {path} 看起来不是本引擎创建的库（有 sessions 表、但没有 storage_audit）。\
             `--db` 是**读写**打开的，这次调用可能已经改动了这个文件。\
             要只读读旧库，请用 `--db <新库> invoke legacy.read_table -`（参数里传 legacy_path）。"
        );
    }

    // 统一的成功包装：**每条成功响应都带 `ok:true`**。
    // 这样调用方永远不需要"猜字段名"来判断这是结果还是错误体。
    // （实测被契约测试抓到过：`commands`/`counts` 等分支曾经漏了这个字段。）
    match run(&engine, &path, &rest) {
        Ok(mut v) => {
            if let Value::Object(ref mut map) = v {
                /*
                 * 第 44 轮修正：**不能无条件覆盖 `ok`**。
                 *
                 * 这里原来是无条件 `map.insert("ok", true)`，于是 `integrity` 子命令
                 * 的 `ok` 被它盖掉 —— 实测数据页损坏的库：
                 * `{"detail":"*** in database main ***\nTree 1239 page 2049: btreeInitPage() returns error code 11…","ok":true}`
                 * 也就是说：**损坏的库报 ok:true**。任何读顶层 `.ok` 的契约测试、
                 * 排查脚本、CI 判据都会被这条假绿骗过去 —— 而 `integrity` 存在的唯一理由
                 * 就是回答"这个库还好吗"。
                 *
                 * 现在的规则：`ok` 缺省为 true，但**已经带了 `ok` 的响应一律尊重它自己的判断**
                 * （`integrity` 是唯一会带 `false` 的分支；将来若有别的自检命令同理）。
                 */
                map.entry("ok".to_string())
                    .or_insert(Value::Bool(true));
                /* 发生过"损坏库自动恢复"时**必须报出来**：调用方（渲染侧 / 排查者）
                 * 要据此写"索引需要重建"标记并提示用户 —— 悄悄恢复等于用户永远不知道自己丢过一次索引。 */
                if let Some(backup) = &recovered_from {
                    map.insert(
                        "recovered_from".to_string(),
                        Value::String(backup.display().to_string()),
                    );
                    map.insert("recovered".to_string(), Value::Bool(true));
                }
            }
            print_json(&v);
            ExitCode::SUCCESS
        }
        Err(e) => {
            print_json(&json!({ "ok": false, "path": path, "error": error_json(&e) }));
            ExitCode::from(1)
        }
    }
}
