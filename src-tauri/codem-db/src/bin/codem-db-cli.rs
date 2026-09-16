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
        "counts" => dispatch(engine, "counts", &json!({ "tables": tables_arg(rest) })),
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
                        // 部分成功是**事实**，必须如实返回（调用方据此决定补偿）
                        return Err(DbError::new(
                            e.code,
                            format!(
                                "batch 在第 {} 步失败（command={cmd}）：{}；已完成 {} 步：{}",
                                results.len() + 1,
                                e.message,
                                results.len(),
                                serde_json::to_string(&results).unwrap_or_default()
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

    // 打开引擎（含 schema/迁移）：失败也返回结构化错误，绝不 panic
    let engine = match Engine::open(&path) {
        Ok(e) => e,
        Err(e) => {
            print_json(&json!({ "ok": false, "path": path, "error": error_json(&e) }));
            return ExitCode::from(1);
        }
    };

    // 统一的成功包装：**每条成功响应都带 `ok:true`**。
    // 这样调用方永远不需要"猜字段名"来判断这是结果还是错误体。
    // （实测被契约测试抓到过：`commands`/`counts` 等分支曾经漏了这个字段。）
    match run(&engine, &path, &rest) {
        Ok(mut v) => {
            if let Value::Object(ref mut map) = v {
                map.insert("ok".to_string(), Value::Bool(true));
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
