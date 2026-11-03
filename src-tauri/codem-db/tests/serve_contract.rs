//! `codem-db serve` 的**契约测试**（SERVE-*）。
//!
//! 这一组判据守的是「常驻行协议」本身，而不是仓储语义（后者由 `wire_contract.rs` 守）：
//!
//! 1. **形状与 Tauri 命令层逐字段对齐** —— 因为 `packages/host` 的 `NodeTransport` 与
//!    渲染侧 `rust-port.ts` 的 `tauriTransport` **共用同一套解包代码**；形状一分叉，
//!    "换传输不改业务"这句话就不成立。
//! 2. **id 原样回显** —— 这是把应答配回请求的唯一依据。
//! 3. **一条连接、一个 Engine** —— serve 存在的理由；若它退化成"每行重开库"，
//!    单写者就不在进程边界上成立了。
//! 4. **错误是值** —— 坏 JSON / 未知命令 / 批中失败都必须回结构化错误，不许 panic、不许退出。
//!
//! 变异自证（做过）：把 `handle_line` 的 `id` 改成固定 `null` ⇒ SERVE-2/3 变红；
//! 把 batch 的"失败即停"改成"继续执行" ⇒ SERVE-5 变红；把 `run_stdio` 的 flush 去掉
//! ⇒ `serve_roundtrip_via_process` 超时（进程不吐行）。

use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};

use codem_db::serve::{handle_line, MAX_LINE_BYTES};
use codem_db::Engine;
use serde_json::{json, Value};

fn open_tmp() -> (tempfile::TempDir, Engine) {
    let dir = tempfile::tempdir().expect("tempdir");
    let (engine, _recovered) =
        Engine::open_with_recovery(dir.path().join("db.bin")).expect("open engine");
    (dir, engine)
}

fn send(engine: &Engine, line: &str) -> Value {
    let out = handle_line(engine, line).expect("non-empty line must produce a reply");
    assert!(
        out.line.ends_with('\n'),
        "每行应答必须以换行结束（NDJSON 帧），否则调用方的 read_line 会等下一行"
    );
    serde_json::from_str(out.line.trim()).expect("reply must be valid JSON")
}

fn inv(engine: &Engine, id: u64, command: &str, params: Value) -> Value {
    send(
        engine,
        &json!({ "id": id, "command": command, "params": params }).to_string(),
    )
}

/// SERVE-1：capabilities 必须列出全部仓储命令，且带上"没有整库导出"这条边界。
#[test]
fn serve_capabilities_expose_command_inventory() {
    let (_dir, engine) = open_tmp();
    let r = send(&engine, r#"{"id":1,"op":"capabilities"}"#);
    assert_eq!(r["ok"], true);
    assert_eq!(r["engine"], "rust");
    let cmds = r["result"]["commands"].as_array().expect("commands array");
    assert!(
        cmds.len() >= 80,
        "命令清单只剩 {} 条：serve 不认识新命令时会一律 UNSUPPORTED",
        cmds.len()
    );
    assert!(cmds.iter().any(|c| c == "messages.list"));
    assert!(cmds.iter().any(|c| c == "settings.set"));
    assert_eq!(r["result"]["no_whole_file_export"], true);
}

/// SERVE-2：**同一进程内**写入后立即读回（单连接、单 Engine），且应答形状与 StorageReply 对齐。
///
/// 这条是 serve 与 `invoke` 的本质区别：`invoke` 每次重开库，这里必须是同一条连接。
#[test]
fn serve_write_then_read_in_one_process() {
    let (_dir, engine) = open_tmp();
    let a = inv(
        &engine,
        10,
        "sessions.upsert",
        json!({ "id": "s1", "project_id": "", "title": "会话" }),
    );
    assert_eq!(a["ok"], true, "sessions.upsert 失败：{a}");
    assert_eq!(a["id"], 10);
    assert_eq!(a["engine"], "rust");
    assert_eq!(a["result"]["written"], 1);

    let b = inv(
        &engine,
        11,
        "messages.create",
        json!({ "id": "m1", "session_id": "s1", "role": "user", "content": "你好" }),
    );
    assert_eq!(b["ok"], true, "messages.create 失败：{b}");

    let c = inv(&engine, 12, "messages.get", json!({ "id": "m1" }));
    assert_eq!(c["ok"], true);
    assert_eq!(c["result"]["item"]["id"], "m1");
    assert_eq!(c["result"]["item"]["content"], "你好");
    assert_eq!(c["result"]["item"]["session_id"], "s1");
}

/// SERVE-3：未知命令 ⇒ 结构化 UNSUPPORTED（含 hint），且必须回显 id。
#[test]
fn serve_unknown_command_is_structured_and_keeps_id() {
    let (_dir, engine) = open_tmp();
    let r = send(&engine, r#"{"id":"req-9","command":"sql.raw","params":{}}"#);
    assert_eq!(r["ok"], false);
    assert_eq!(r["id"], "req-9");
    assert_eq!(r["error"]["code"], "UNSUPPORTED");
    assert_eq!(r["error"]["retryable"], false);
    assert!(
        r["error"]["hint"].as_str().unwrap_or("").contains("尚未实现"),
        "缺 hint：调用方只能靠猜 code 的语义"
    );
}

/// SERVE-4：坏 JSON 不许 panic，必须回 id=null 的协议级错误（调用方据此知道"没被识别"）。
#[test]
fn serve_malformed_line_does_not_kill_the_session() {
    let (_dir, engine) = open_tmp();
    let bad = send(&engine, "{oops");
    assert_eq!(bad["ok"], false);
    assert!(bad["id"].is_null());
    assert_eq!(bad["error"]["code"], "OTHER");
    // 同一会话随后的正常请求必须还能用（协议错误不是进程中毒）
    let ok = send(&engine, r#"{"id":1,"op":"ping"}"#);
    assert_eq!(ok["ok"], true);
}

/// SERVE-5：batch 部分成功 —— 失败即停、如实报步数与已完成命令名，且**不内嵌已完成结果体**。
#[test]
fn serve_batch_stops_at_first_failure_and_reports_names_only() {
    let (_dir, engine) = open_tmp();
    let r = send(
        &engine,
        &json!({
            "id": 5,
            "op": "batch",
            "commands": [
                { "command": "sessions.upsert", "params": { "id": "s2", "project_id": "" } },
                { "command": "messages.create", "params": { "id": "m2", "session_id": "s2", "role": "user", "content": "ok" } },
                { "command": "messages.create", "params": { "id": "m3", "session_id": "s2" } }
            ]
        })
        .to_string(),
    );
    assert_eq!(r["ok"], false);
    let msg = r["error"]["message"].as_str().expect("message");
    assert!(msg.contains("第 3 步"), "步号必须如实：{msg}");
    assert!(msg.contains("messages.create"), "失败命令名必须出现：{msg}");
    assert!(
        msg.contains("sessions.upsert") && msg.contains("→"),
        "已完成命令名清单必须出现：{msg}"
    );
    assert!(
        msg.len() < 400,
        "错误文案不许内嵌已完成结果体（长度 {}）",
        msg.len()
    );
}

/// SERVE-6：跨行写入必须落在**同一条连接**上（计数可见），否则"单写者"只是注释。
#[test]
fn serve_keeps_one_connection_across_lines() {
    let (_dir, engine) = open_tmp();
    let _ = inv(&engine, 1, "sessions.upsert", json!({ "id": "s3", "project_id": "" }));
    for i in 0..3 {
        let r = inv(
            &engine,
            2 + i,
            "messages.create",
            json!({ "id": format!("m3-{i}"), "session_id": "s3", "role": "user", "content": "x" }),
        );
        assert_eq!(r["ok"], true, "{r}");
    }
    let c = inv(&engine, 9, "counts", json!({ "tables": ["messages"] }));
    assert_eq!(c["ok"], true, "{c}");
    assert_eq!(c["result"]["messages"], 3);
}

/// SERVE-7：shutdown 必须回 closing=true 并置 shutdown 位（进程据此退出）。
#[test]
fn serve_shutdown_signals_exit() {
    let (_dir, engine) = open_tmp();
    let out = handle_line(&engine, r#"{"id":7,"op":"shutdown"}"#).expect("reply");
    assert!(out.shutdown, "shutdown 位没置，进程会一直等下一行");
    let v: Value = serde_json::from_str(out.line.trim()).unwrap();
    assert_eq!(v["result"]["closing"], true);
}

/// SERVE-8：单行上限必须有界（防止无界 read_line 造成 OOM，而不是"慢"）。
#[test]
fn serve_line_cap_is_bounded_but_generous() {
    assert!(
        MAX_LINE_BYTES >= 8 * 1024 * 1024,
        "上限 {} 太小：一条 messages.list 就可能被拒",
        MAX_LINE_BYTES
    );
    assert!(MAX_LINE_BYTES <= 256 * 1024 * 1024, "上限过大 = 没有护栏");
}

/// SERVE-9（真进程）：起 `codem-db-cli serve`，逐行往返，证明 stdout 每行立即 flush。
///
/// 纯函数测试**看不见** flush：`handle_line` 只返回字符串。真机故障形态恰恰是
/// "函数都对，但调用方一条应答都收不到"（缓冲没刷）。所以这一条必须有真进程。
#[test]
fn serve_roundtrip_via_process() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("db.bin");
    let exe = env!("CARGO_BIN_EXE_codem-db-cli");
    let mut child = Command::new(exe)
        .arg("--db")
        .arg(&db)
        .arg("serve")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn serve");
    let mut stdin = child.stdin.take().expect("stdin");
    let mut stdout = BufReader::new(child.stdout.take().expect("stdout"));

    let mut roundtrip = |req: Value| -> Value {
        writeln!(stdin, "{req}").expect("write request");
        stdin.flush().expect("flush request");
        let mut line = String::new();
        stdout.read_line(&mut line).expect("read reply");
        assert!(!line.is_empty(), "serve 没有应答就 EOF 了");
        serde_json::from_str(line.trim()).expect("reply json")
    };

    let ping = roundtrip(json!({ "id": 1, "op": "ping" }));
    assert_eq!(ping["ok"], true);
    let up = roundtrip(json!({ "id": 2, "command": "sessions.upsert", "params": { "id": "sp", "project_id": "" } }));
    assert_eq!(up["ok"], true, "{up}");
    let list = roundtrip(json!({ "id": 3, "command": "sessions.list", "params": {} }));
    assert_eq!(list["ok"], true, "{list}");
    let bye = roundtrip(json!({ "id": 4, "op": "shutdown" }));
    assert_eq!(bye["result"]["closing"], true);

    drop(stdin);
    let status = child.wait().expect("wait");
    assert!(status.success(), "serve 退出码 {:?}", status.code());
}
