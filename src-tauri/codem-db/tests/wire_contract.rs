//! 渲染侧 ↔ Rust 的**线协议**契约测试（P3）。
//!
//! ## 这个文件想解决的问题
//!
//! `src-tauri/src/storage.rs` 把引擎包成 `StorageReply`，`src/core/storage/rust-port.ts`
//! 按同一形状解包。但 Rust 的单元测试**看不见** TS 侧对字段名的假设 ——
//! 一边写 `wal_size_bytes`、另一边读 `walSizeBytes`，编译都过，运行时静默拿到 `undefined`。
//!
//! 这类"跨语言字段名漂移"只能靠**把两边期望的形状都写成断言**来拦：
//! - 本文件断言 Rust 序列化出来的**确切键名**（snake_case、布尔值、错误码大写）；
//! - TS 侧 `src/test/rust-port-wire.test.ts` 用同一份 JSON 走端口解包。
//!
//! 两边共用一份"金样本"（`tests/wire-fixtures.json`），任一改动只要让两边不一致就会红。

use codem_db::{dispatch, Engine};
use serde_json::{json, Value};

fn engine(name: &str) -> (tempfile::TempDir, Engine) {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join(format!("{name}.bin"));
    let eng = Engine::open(&path).expect("open");
    (dir, eng)
}

/// 与 `src-tauri/src/storage.rs::reply()` 完全同构的包装（该函数依赖 Tauri 的 State，
/// 无法在此直接调用；这里复制其**形状**，并由 `storage.rs` 自己的单测守住实现一致）。
fn reply(result: Result<Value, codem_db::DbError>) -> Value {
    match result {
        Ok(v) => json!({ "ok": true, "result": v, "engine": "rust" }),
        Err(e) => json!({
            "ok": false,
            "engine": "rust",
            "error": {
                "code": e.code.as_str(),
                "message": e.message,
                "retryable": e.retryable,
                "hint": e.code.hint(),
            }
        }),
    }
}

fn call(eng: &Engine, command: &str, params: Value) -> Value {
    reply(dispatch(eng, command, &params))
}

#[test]
fn wire_fixtures_match_both_sides() {
    let (_d, eng) = engine("wire");

    // 准备一份组合数据，覆盖：成功写 / 成功分页读 / 成功单条读 / 各类错误
    call(&eng, "projects.upsert", json!({ "id": "p1", "name": "线协议项目" }));
    call(
        &eng,
        "sessions.upsert",
        json!({ "id": "s1", "project_id": "p1", "title": "线协议会话" }),
    );
    call(
        &eng,
        "messages.create",
        json!({
            "id": "m1", "session_id": "s1", "role": "user",
            "content": "线协议内容", "reasoning": null, "timestamp": 1_700_000_000_000_i64
        }),
    );
    call(
        &eng,
        "settings.set",
        json!({ "key": "codem-theme", "value": "dark" }),
    );

    let fixtures = json!({
        "_comment": "由 src-tauri/codem-db/tests/wire_contract.rs 生成/校验；TS 侧 src/test/rust-port-wire.test.ts 用同一份样本断言解包结果。字段名是跨语言契约，改名等于破坏协议。",
        "_generatedBy": "cargo test --manifest-path src-tauri/codem-db/Cargo.toml --test wire_contract",
        "_generatedAtMs": codem_db::schema::now_ms(),
        "write": call(&eng, "settings.set", json!({ "key": "codem-font-size", "value": "14" })),
        "list": call(&eng, "messages.list", json!({
            "session_id": "s1", "limit": 2, "include_hidden": true
        })),
        "single": call(&eng, "messages.get", json!({ "id": "m1" })),
        "missing": call(&eng, "messages.get", json!({ "id": "nope" })),
        "count": call(&eng, "messages.count", json!({ "session_id": "s1" })),
        "error_not_found": call(&eng, "messages.update", json!({ "id": "nope", "content": "x" })),
        "error_constraint": call(&eng, "messages.create", json!({
            "id": "orphan", "session_id": "no-such", "role": "user", "content": "x"
        })),
        "error_unsupported": call(&eng, "sql.raw", json!({ "sql": "SELECT 1" })),
        "error_bad_param": call(&eng, "messages.create", json!({ "id": "m2", "session_id": "s1" })),
    });

    // ===== 成功形状 =====
    let write = &fixtures["write"];
    assert_eq!(write["ok"], json!(true), "成功响应必须自描述 ok:true");
    assert!(write["error"].is_null(), "成功响应不该带 error");
    assert!(
        write["result"]["written"].is_number(),
        "写命令必须回报 written（渲染侧据此判断是否真的落库）"
    );

    let list = &fixtures["list"];
    let result = &list["result"];
    assert!(result["items"].is_array(), "列表必须是 items 数组");
    // 字段名：snake_case（TS 侧读 has_more / next_cursor）
    assert!(result["has_more"].is_boolean(), "分页必须显式给 has_more");
    assert!(
        result["next_cursor"].is_null() || result["next_cursor"].is_string(),
        "next_cursor 必须是 string 或 null"
    );
    let first = &result["items"][0];
    for key in [
        "id",
        "session_id",
        "role",
        "content",
        "reasoning",
        "timestamp",
        "model",
        "status",
    ] {
        assert!(first.get(key).is_some(), "消息行缺少契约字段 {key}");
    }
    assert_eq!(first["status"], json!("done"), "status 缺省值必须是 done（渲染侧依赖）");

    // 单条：{item: {...}}；缺失：{item: null} —— TS 侧把 null 归一成空列表
    assert!(fixtures["single"]["result"]["item"].is_object());
    assert!(
        fixtures["missing"]["result"]["item"].is_null(),
        "查不到必须是 item:null（而不是报错、也不是空对象）"
    );
    assert_eq!(fixtures["count"]["result"]["count"], json!(1));
    assert_eq!(fixtures["count"]["result"]["total"], json!(1));
    assert_eq!(fixtures["count"]["result"]["visible"], json!(1));
    assert_eq!(fixtures["count"]["result"]["hidden"], json!(0));

    // ===== 错误形状（渲染侧按 code 分支） =====
    for (name, expected_code, expected_retryable) in [
        ("error_not_found", "NOT_FOUND", false),
        ("error_constraint", "CONSTRAINT", false),
        ("error_unsupported", "UNSUPPORTED", false),
        ("error_bad_param", "OTHER", false),
    ] {
        let e = &fixtures[name];
        assert_eq!(e["ok"], json!(false), "{name} 必须 ok:false");
        assert!(e["result"].is_null(), "{name} 不该带 result");
        assert_eq!(
            e["error"]["code"],
            json!(expected_code),
            "{name} 的错误码是渲染侧的分支依据"
        );
        assert_eq!(e["error"]["retryable"], json!(expected_retryable));
        assert!(e["error"]["message"].is_string());
        assert!(
            !e["error"]["hint"].as_str().unwrap_or("").is_empty(),
            "{name} 必须带可读的处置建议"
        );
    }

    // 写金样本（供 TS 侧测试读取并断言）。
    // `_generatedAtMs` 让 TS 侧能判断样本是否"过期很久"，见 rust-port-wire.test.ts 的 WIRE-0。
    let out = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/wire-fixtures.json");
    let mut prev_at: Option<i64> = None;
    if let Ok(existing) = std::fs::read_to_string(&out) {
        if let Ok(v) = serde_json::from_str::<Value>(&existing) {
            prev_at = v.get("_generatedAtMs").and_then(|x| x.as_i64());
        }
    }
    assert!(
        prev_at.is_none_or(|t| codem_db::schema::now_ms() >= t),
        "时间戳不该倒退"
    );
    std::fs::write(&out, serde_json::to_string_pretty(&fixtures).unwrap())
        .expect("写入 wire-fixtures.json");
}

/// 真实生产路径（`%APPDATA%\com.codem.app\codem-db-rust.bin`）必须可用。
///
/// 目的不是写用户数据，而是证明**引擎能在真实路径上开库、写、读、checkpoint**——
/// 这正是打包版首次启动会走的那条路。用 `_wireprobe` 后缀避免碰真实文件。
#[test]
fn engine_works_at_production_path_shape() {
    let Some(appdata) = std::env::var_os("APPDATA") else {
        // 非 Windows / 无 APPDATA 的环境跳过（CI 里可能如此），不算失败
        return;
    };
    let dir = std::path::PathBuf::from(appdata).join("com.codem.app");
    if !dir.exists() {
        // 应用还没跑过：不创建用户目录，只证明同名路径可写即可
        return;
    }
    let path = dir.join("codem-db-wireprobe.bin");
    let _ = std::fs::remove_file(&path);
    let _ = std::fs::remove_file(format!("{}-wal", path.to_string_lossy()));

    {
        let eng = Engine::open(&path).expect("在生产路径上开库");
        let r = call(&eng, "settings.set", json!({ "key": "wire", "value": "ok" }));
        assert_eq!(r["ok"], json!(true));
        let got = call(&eng, "settings.get_all", json!({}));
        assert_eq!(got["result"]["wire"], json!("ok"));
        eng.checkpoint().expect("checkpoint");
        assert!(eng.integrity_check().unwrap().ok, "真实路径上的库必须完整");
    }

    // 清理（不留痕）
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{}", path.to_string_lossy(), suffix));
    }
}
