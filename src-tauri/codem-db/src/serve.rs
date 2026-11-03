//! `codem-db serve` —— **长驻**的 stdio 行协议（一条 JSON 一行，NDJSON）。
//!
//! ## 为什么需要它（而不是继续用 `codem-db-cli invoke`）
//!
//! `codem-db-cli` 是**一次调用一个进程**：每次都要重新打开库（PRAGMA + schema 幂等检查 +
//! 安装删除审计触发器）。对契约测试、迁移、排查足够；但对 `codem-host` 这种常驻服务是错的：
//!
//! 1. **单写者**要求全进程只有一条写连接。每次开新连接等于把"单写者"降级成"多连接抢锁"，
//!    WAL 下会退化成 `SQLITE_BUSY` 重试（`busy_timeout=5000` 只是兜底，不是语义）；
//! 2. 每次调用 ~几十毫秒的打开成本，落在**流式响应的热路径**上（工具调用写索引）；
//! 3. 事务属于连接 —— `serve` 之外没有任何地方能安全地跨多条命令持有状态。
//!
//! 所以 serve 的语义只有一句：**一个进程、一个 Engine、一条 stdin、一条 stdout、逐行应答**。
//!
//! ## 帧格式（为什么是 NDJSON 而不是 LSP 的 Content-Length）
//!
//! 两端都由我们控制、载荷全是 UTF-8 JSON、没有二进制体；NDJSON 可以直接用
//! `read_line` / `split('\n')`，也能被 `Get-Content` / `jq -c` 直接看。LSP 的头部帧多一层
//! 状态机（半包、长度与编码不一致），在没有二进制需求的场景里只增加出错面。
//!
//! 代价：**一行就是一条消息**，所以 JSON 里不能出现裸换行 —— `serde_json` 默认就转义
//! `\n`，天然满足。单行上限见 [`MAX_LINE_BYTES`]（超限报错而不是 OOM）。
//!
//! ## 响应形状
//!
//! 与 Tauri 命令层（`src-tauri/src/storage.rs::StorageReply`）**逐字段对齐**，并多带一个 `id`：
//!
//! ```json
//! {"id":1,"ok":true,"result":{...},"engine":"rust"}
//! {"id":2,"ok":false,"error":{"code":"UNSUPPORTED","message":"…","retryable":false,"hint":"…"},"engine":"rust"}
//! ```
//!
//! 对齐是刻意的：`packages/host` 的 `NodeTransport` 与 `rust-port.ts` 的 `tauriTransport`
//! 共用同一套解包代码（`WireReply`），所以"换传输"不需要第二份错误映射表
//! （判据：`tests/serve_contract.rs` 的 `SERVE-*` 与 `src/test/host-wire-parity.test.ts`）。
//!
//! ## 请求形状
//!
//! ```json
//! {"id":1,"command":"messages.list","params":{"session_id":"s1","limit":20}}
//! {"id":2,"op":"batch","commands":[{"command":"messages.create","params":{...}}]}
//! {"id":3,"op":"health"}            // health / capabilities / ping / shutdown
//! ```
//!
//! `op` 缺省时按 `invoke` 处理（有 `command` 就行）；`op` 显式给 `invoke` 也接受。

use std::io::{BufRead, Write};

use crate::{capabilities, dispatch, DbError, Engine};
use serde_json::{json, Value};

/// 单行上限（字节）。
///
/// 32 MiB 的依据：真机最长的单条结果是一次 `messages.list`（200 行 × 含工具正文），
/// 实测在数 MB 量级；再往上应当分页而不是靠帧撑大。超限必须**明确报错**，
/// 不能让 `read_line` 无界增长（那是 OOM 而不是"慢"）。
pub const MAX_LINE_BYTES: usize = 32 * 1024 * 1024;

/// 一条请求处理完的结果。
#[derive(Debug, Clone)]
pub struct ServeOutcome {
    /// 要写回 stdout 的一行（已含换行符）
    pub line: String,
    /// 是否请求关闭（`op":"shutdown"`）
    pub shutdown: bool,
}

impl ServeOutcome {
    fn reply(id: Value, result: Result<Value, DbError>, shutdown: bool) -> Self {
        let body = match result {
            Ok(v) => json!({ "id": id, "ok": true, "result": v, "engine": "rust" }),
            Err(e) => json!({
                "id": id,
                "ok": false,
                "engine": "rust",
                "error": {
                    "code": e.code.as_str(),
                    "message": e.message,
                    "retryable": e.retryable,
                    "hint": e.code.hint(),
                },
            }),
        };
        Self {
            line: format!("{}\n", serde_json::to_string(&body).unwrap_or_else(|_| "{}".into())),
            shutdown,
        }
    }

    /// 解析失败等**没有 id** 的应答（id 一律 null：调用方据此知道"这条没被识别"）
    fn protocol_error(message: impl Into<String>) -> Self {
        Self::reply(Value::Null, Err(DbError::other(message)), false)
    }
}

/// 处理一行请求。空行返回 `None`（不产生应答，避免心跳把 stdout 刷满）。
///
/// 刻意做成**纯函数**（除了 Engine 的读写）：契约测试可以逐行喂，不需要起进程。
pub fn handle_line(engine: &Engine, line: &str) -> Option<ServeOutcome> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.len() > MAX_LINE_BYTES {
        return Some(ServeOutcome::protocol_error(format!(
            "单行请求超过上限 {} 字节（{} 字节）：请改用分页参数，而不是继续增大一帧",
            MAX_LINE_BYTES,
            trimmed.len()
        )));
    }
    let req: Value = match serde_json::from_str(trimmed) {
        Ok(v) => v,
        Err(e) => {
            return Some(ServeOutcome::protocol_error(format!(
                "请求不是合法 JSON：{e}"
            )))
        }
    };
    if !req.is_object() {
        return Some(ServeOutcome::protocol_error(
            "请求必须是 JSON 对象（形如 {\"id\":1,\"command\":\"health\"}）",
        ));
    }
    let id = req.get("id").cloned().unwrap_or(Value::Null);
    let op = req
        .get("op")
        .and_then(|x| x.as_str())
        .unwrap_or("invoke")
        .to_string();

    let outcome = match op.as_str() {
        "invoke" => {
            let Some(command) = req.get("command").and_then(|x| x.as_str()) else {
                return Some(ServeOutcome::reply(
                    id,
                    Err(DbError::other("缺少 command（或改用 op=health/capabilities/batch）")),
                    false,
                ));
            };
            let params = req.get("params").cloned().unwrap_or_else(|| json!({}));
            dispatch(engine, command, &params)
        }
        "batch" => {
            let Some(items) = req.get("commands").and_then(|x| x.as_array()) else {
                return Some(ServeOutcome::reply(
                    id,
                    Err(DbError::other("batch 需要 commands 数组")),
                    false,
                ));
            };
            let mut done: Vec<Value> = Vec::new();
            let mut failure: Option<DbError> = None;
            for it in items {
                let Some(command) = it.get("command").and_then(|x| x.as_str()) else {
                    failure = Some(DbError::other("batch 每项都需要 command 字段"));
                    break;
                };
                let params = it.get("params").cloned().unwrap_or_else(|| json!({}));
                match dispatch(engine, command, &params) {
                    Ok(v) => done.push(json!({ "command": command, "ok": true, "result": v })),
                    Err(e) => {
                        // 与 CLI / Tauri 命令层共用同一句文案（`batch_failure_message`），
                        // 三处形状不可能再分叉。
                        let completed: Vec<String> = done
                            .iter()
                            .filter_map(|d| d.get("command").and_then(|c| c.as_str()))
                            .map(|s| s.to_string())
                            .collect();
                        failure = Some(DbError::new(
                            e.code,
                            crate::batch_failure_message(
                                done.len() + 1,
                                command,
                                &e.message,
                                &completed,
                            ),
                        ));
                        break;
                    }
                }
            }
            match failure {
                Some(e) => return Some(ServeOutcome::reply(id, Err(e), false)),
                None => Ok(json!({ "count": done.len(), "results": done })),
            }
        }
        "health" => match engine.health() {
            Ok(h) => Ok(serde_json::to_value(h).unwrap_or(Value::Null)),
            Err(e) => return Some(ServeOutcome::reply(id, Err(e), false)),
        },
        "capabilities" => Ok(capabilities()),
        "ping" => Ok(json!({ "pong": true, "pid": std::process::id() })),
        "shutdown" => {
            return Some(ServeOutcome::reply(id, Ok(json!({ "closing": true })), true));
        }
        other => {
            return Some(ServeOutcome::reply(
                id,
                Err(DbError::unsupported(format!(
                    "未知 op：{other}（可用：invoke / batch / health / capabilities / ping / shutdown）"
                ))),
                false,
            ))
        }
    };
    Some(ServeOutcome::reply(id, outcome, false))
}

/// 跑 serve 主循环：**stdin 逐行读、stdout 逐行写并立即 flush**。
///
/// flush 是硬要求：不 flush 时 Node 侧会等到 8 KB 缓冲满才看到第一条应答，
/// 表现是"发了一条命令，对面像死了一样"（真机排查过这类"假死"）。
pub fn run_stdio(engine: &Engine) -> std::io::Result<()> {
    let stdin = std::io::stdin();
    let mut reader = std::io::BufReader::new(stdin.lock());
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    let mut buf = String::new();
    loop {
        buf.clear();
        let n = reader.read_line(&mut buf)?;
        if n == 0 {
            return Ok(()); // EOF：调用方关了写端，正常退出
        }
        match handle_line(engine, &buf) {
            None => continue,
            Some(o) => {
                out.write_all(o.line.as_bytes())?;
                out.flush()?;
                if o.shutdown {
                    return Ok(());
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 纯函数边界：空行/空格行不产生应答（否则心跳会把 stdout 刷成噪声）。
    #[test]
    fn empty_lines_are_silent() {
        let dir = tempfile::tempdir().unwrap();
        let (engine, _) = Engine::open_with_recovery(dir.path().join("db.bin")).unwrap();
        assert!(handle_line(&engine, "").is_none());
        assert!(handle_line(&engine, "   \t ").is_none());
    }

    /// 坏 JSON 必须回结构化错误、且 id 为 null（调用方据此区分"没被识别"）。
    #[test]
    fn malformed_json_is_a_structured_error() {
        let dir = tempfile::tempdir().unwrap();
        let (engine, _) = Engine::open_with_recovery(dir.path().join("db.bin")).unwrap();
        let out = handle_line(&engine, "{not json").unwrap();
        let v: Value = serde_json::from_str(out.line.trim()).unwrap();
        assert_eq!(v["ok"], false);
        assert!(v["id"].is_null());
        assert_eq!(v["error"]["code"], "OTHER");
        assert_eq!(v["engine"], "rust");
    }

    /// id 必须原样回显（数字/字符串都保留类型）—— 否则 Node 侧无法把应答配回请求。
    #[test]
    fn id_is_echoed_verbatim() {
        let dir = tempfile::tempdir().unwrap();
        let (engine, _) = Engine::open_with_recovery(dir.path().join("db.bin")).unwrap();
        let out = handle_line(&engine, r#"{"id":"a-1","op":"ping"}"#).unwrap();
        let v: Value = serde_json::from_str(out.line.trim()).unwrap();
        assert_eq!(v["id"], "a-1");
        assert_eq!(v["result"]["pong"], true);
    }
}
