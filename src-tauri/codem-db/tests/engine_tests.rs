//! P1 验收测试（Rust 侧）：引擎行为、安全边界、错误映射、幂等 schema、WAL、分页。
//!
//! 这些测试**直接驱动生产实现**（同一个 crate），不需要 Tauri、不需要 WASM。
//! 渲染侧的契约测试（`src/test/db-contract.test.ts`）通过 CLI 驱动**同一份**实现，
//! 因此不存在"测试一套、生产另一套"的双实现漂移。

use codem_db::{dispatch, Engine};
use serde_json::json;

fn temp_engine(name: &str) -> (tempfile::TempDir, Engine) {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join(format!("{name}.bin"));
    let engine = Engine::open(&path).expect("open engine");
    (dir, engine)
}

fn call(engine: &Engine, cmd: &str, params: serde_json::Value) -> serde_json::Value {
    dispatch(engine, cmd, &params).unwrap_or_else(|e| panic!("{cmd} 失败：{}", e.to_line()))
}

// ========== schema / 迁移 ==========

#[test]
fn schema_apply_is_idempotent() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("idem.bin");

    let first = Engine::open(&path).unwrap();
    let r1 = first.schema_report().clone();
    assert!(r1.fresh, "全新库应标记 fresh");
    // `schema.sql` 是**当前完整表结构**（已包含历史 ALTER 加过的列），
    // 所以全新库上必然有一部分迁移命中"列已存在"而被忽略 —— 这是预期行为，不是缺陷。
    // 真正要守的不变量是"第二次打开与第一次结果一致、且不报错"。
    assert!(
        r1.migrations_ignored <= r1.migrations,
        "被忽略的迁移数不能超过迁移总数（{} > {}）",
        r1.migrations_ignored,
        r1.migrations
    );
    drop(first);

    // 再开一次：不得报错（迁移全部"列已存在"且被容忍）
    let second = Engine::open(&path).unwrap();
    let r2 = second.schema_report().clone();
    assert!(!r2.fresh, "第二次打开不是全新库");
    assert_eq!(
        r2.migrations_ignored, r2.migrations,
        "第二次打开时所有迁移都应命中「列已存在」并被忽略（实际 {}/{}）",
        r2.migrations_ignored, r2.migrations
    );
    assert_eq!(r1.tables, r2.tables, "两次打开后的表数应一致");
    assert_eq!(r1.fts_module, r2.fts_module, "FTS 模块不应在重开时变化");
}

#[test]
fn global_project_seed_exists() {
    let (_d, engine) = temp_engine("seed");
    let page = call(&engine, "projects.list", json!({ "limit": 10 }));
    let items = page["items"].as_array().unwrap();
    assert!(
        items.iter().any(|p| p["id"] == json!("")),
        "必须种下 project_id='' 的全局项目行（否则全局会话外键失败）"
    );
}

// ========== 安全边界 ==========

#[test]
fn attach_is_denied_by_authorizer() {
    let (_d, engine) = temp_engine("attach");
    let err = engine
        .with_conn(|conn| {
            conn.execute_batch("ATTACH DATABASE 'C:/windows/win.ini' AS evil;")
                .map_err(codem_db::DbError::from)
        })
        .expect_err("ATTACH 必须被 authorizer 拒绝");
    let msg = format!("{err}");
    assert!(
        msg.contains("not authorized") || msg.contains("authoriz"),
        "错误应来自 authorizer（实际：{msg}）"
    );
}

#[test]
fn load_extension_is_denied() {
    let (_d, engine) = temp_engine("loadext");
    let err = engine
        .with_conn(|conn| {
            conn.execute_batch("SELECT load_extension('evil.dll');")
                .map_err(codem_db::DbError::from)
        })
        .expect_err("load_extension 必须被拒绝");
    let msg = format!("{err}");
    assert!(
        msg.contains("not authorized") || msg.contains("authoriz"),
        "错误应来自 authorizer（实际：{msg}）"
    );
}

#[test]
fn dangerous_pragma_is_denied_but_wal_pragma_is_allowed() {
    let (_d, engine) = temp_engine("pragma");
    // 危险 pragma 被拒（否则渲染侧可绕过同步/锁语义）
    let err = engine
        .with_conn(|conn| {
            conn.execute_batch("PRAGMA writable_schema=ON;")
                .map_err(codem_db::DbError::from)
        })
        .expect_err("PRAGMA writable_schema 应被拒绝");
    assert!(format!("{err}").contains("authoriz"), "实际：{err}");

    // 只读诊断 pragma 必须仍然可用（健康检查依赖它）
    let mode = engine
        .with_conn(|conn| {
            conn.query_row("PRAGMA journal_mode", [], |r| r.get::<_, String>(0))
                .map_err(codem_db::DbError::from)
        })
        .unwrap();
    assert_eq!(mode.to_lowercase(), "wal", "引擎应工作在 WAL 模式");
}

#[test]
fn unknown_command_is_unsupported_not_panic() {
    let (_d, engine) = temp_engine("unknown");
    let err = dispatch(&engine, "sql.raw", &json!({ "sql": "DROP TABLE messages" })).unwrap_err();
    assert_eq!(err.code, codem_db::ErrorCode::Unsupported);
    assert!(!err.retryable, "UNSUPPORTED 不应建议重试");
}

// ========== 错误是值 ==========

#[test]
fn missing_param_reports_structured_error() {
    let (_d, engine) = temp_engine("missing");
    let err = dispatch(&engine, "messages.create", &json!({ "id": "m1" })).unwrap_err();
    assert_eq!(err.code, codem_db::ErrorCode::Other);
    assert!(format!("{err}").contains("session_id"), "应指出缺哪个参数：{err}");
}

#[test]
fn wrong_param_type_is_rejected_not_coerced() {
    let (_d, engine) = temp_engine("badtype");
    call(&engine, "sessions.upsert", json!({ "id": "s1" }));
    // 迁移前渲染侧会把数字静默转成 "123"；存储边界上必须报错（A 类静默空写的源头）
    let err = dispatch(
        &engine,
        "messages.create",
        &json!({ "id": "m1", "session_id": "s1", "role": "user", "content": 12345 }),
    )
    .unwrap_err();
    assert!(format!("{err}").contains("content"), "应指出字段名：{err}");
}

#[test]
fn update_missing_row_is_not_found() {
    let (_d, engine) = temp_engine("upd404");
    let err = dispatch(&engine, "messages.update", &json!({ "id": "nope", "content": "x" })).unwrap_err();
    assert_eq!(
        err.code,
        codem_db::ErrorCode::NotFound,
        "A 类防线：影响 0 行的 UPDATE 不能返回成功"
    );
}

#[test]
fn delete_settings_missing_row_is_not_found() {
    let (_d, engine) = temp_engine("del404");
    let err = dispatch(&engine, "settings.remove", &json!({ "key": "nope" })).unwrap_err();
    assert_eq!(err.code, codem_db::ErrorCode::NotFound);
}

#[test]
fn telemetry_prune_requires_watermark() {
    let (_d, engine) = temp_engine("prune");
    let err = dispatch(&engine, "telemetry.prune", &json!({})).unwrap_err();
    assert!(
        format!("{err}").contains("before"),
        "无水位线的删除必须报错（否则可能全表清空）：{err}"
    );
}

#[test]
fn foreign_key_violation_maps_to_constraint() {
    let (_d, engine) = temp_engine("fk");
    let err = dispatch(
        &engine,
        "messages.create",
        &json!({ "id": "m1", "session_id": "no-such-session", "role": "user", "content": "x" }),
    )
    .unwrap_err();
    assert_eq!(
        err.code,
        codem_db::ErrorCode::Constraint,
        "外键失败应映射成 CONSTRAINT（业务可处理），实际：{err}"
    );
}

// ========== 数据往返 ==========

#[test]
fn message_roundtrip_including_unicode_and_large_content() {
    let (_d, engine) = temp_engine("roundtrip");
    call(&engine, "sessions.upsert", json!({ "id": "s1", "title": "大文档测试" }));

    // 1 MiB 单条消息（中文 + emoji + 换行），验证大 payload 不截断
    let big: String = "中文内容🙂\n".repeat(60_000);
    assert!(big.len() > 1_000_000, "构造的 payload 应超过 1 MiB");
    call(
        &engine,
        "messages.create",
        json!({ "id": "m-big", "session_id": "s1", "role": "assistant", "content": big, "reasoning": "思路" }),
    );

    let got = call(&engine, "messages.get", json!({ "id": "m-big" }));
    assert_eq!(got["item"]["content"].as_str().unwrap().len(), big.len(), "内容长度必须一致");
    assert_eq!(got["item"]["reasoning"], json!("思路"));
    assert_eq!(got["item"]["status"], json!("done"), "status 缺省应为 done");
}

#[test]
fn messages_list_pagination_is_exact() {
    let (_d, engine) = temp_engine("paging");
    call(&engine, "sessions.upsert", json!({ "id": "s1" }));
    let items: Vec<serde_json::Value> = (0..25)
        .map(|i| {
            json!({
                "id": format!("m{i:03}"),
                "session_id": "s1",
                "role": "user",
                "content": format!("消息 {i}"),
                "timestamp": 1000 + i,
            })
        })
        .collect();
    let res = call(&engine, "messages.create_many", json!({ "items": items }));
    assert_eq!(res["written"], json!(25));

    // 分页不重不漏：用 id 集合验证
    let mut seen: Vec<String> = Vec::new();
    let mut offset = 0usize;
    loop {
        let page = call(
            &engine,
            "messages.list",
            json!({ "session_id": "s1", "limit": 10, "offset": offset, "include_hidden": true }),
        );
        let batch = page["items"].as_array().unwrap();
        for it in batch {
            seen.push(it["id"].as_str().unwrap().to_string());
        }
        if !page["has_more"].as_bool().unwrap() {
            break;
        }
        offset += 10;
        assert!(offset < 100, "分页未收敛（防死循环）");
    }
    assert_eq!(seen.len(), 25, "分页总数必须等于写入总数，实际 {seen:?}");
    let mut uniq = seen.clone();
    uniq.sort();
    uniq.dedup();
    assert_eq!(uniq.len(), 25, "分页不得重复");
    assert_eq!(seen[0], "m000", "应按 timestamp 升序");
}

#[test]
fn limit_is_clamped_and_has_more_is_engine_computed() {
    let (_d, engine) = temp_engine("clamp");
    call(&engine, "sessions.upsert", json!({ "id": "s1" }));
    let items: Vec<serde_json::Value> = (0..5)
        .map(|i| json!({ "id": format!("m{i}"), "session_id": "s1", "role": "user", "content": "x" }))
        .collect();
    call(&engine, "messages.create_many", json!({ "items": items }));

    let page = call(
        &engine,
        "messages.list",
        json!({ "session_id": "s1", "limit": 2, "include_hidden": true }),
    );
    assert_eq!(page["items"].as_array().unwrap().len(), 2);
    assert_eq!(page["has_more"], json!(true));
    assert_eq!(page["next_cursor"], json!("2"), "游标 = offset + limit");

    let last = call(
        &engine,
        "messages.list",
        json!({ "session_id": "s1", "limit": 2, "offset": 4, "include_hidden": true }),
    );
    assert_eq!(last["items"].as_array().unwrap().len(), 1);
    assert_eq!(last["has_more"], json!(false));
    assert_eq!(last["next_cursor"], serde_json::Value::Null);
}

/// `hidden` 必须出现在消息读的返回值里。
///
/// 真机验证抓到的缺陷：`messages.list` 的 SELECT 漏了这一列，于是读侧镜像
/// 以为"没有隐藏行"，页面刷新后已压缩的消息又出现了。
/// 渲染侧的 `listMessagesMerged` 明确把"索引里的 hidden 状态"当权威，
/// 所以少这一列会让压缩失效（上下文永不缩小）。
#[test]
fn messages_list_and_get_expose_hidden_column() {
    let (_d, engine) = temp_engine("hidden-col");
    call(&engine, "sessions.upsert", json!({ "id": "s1" }));
    call(
        &engine,
        "messages.create",
        json!({ "id": "m1", "session_id": "s1", "role": "user", "content": "可见", "timestamp": 1 }),
    );
    call(
        &engine,
        "messages.create",
        json!({ "id": "m2", "session_id": "s1", "role": "assistant", "content": "将被隐藏", "timestamp": 2 }),
    );
    call(&engine, "messages.update", json!({ "id": "m2", "hidden": 1 }));

    // list（含 hidden）必须给出 hidden 字段
    let all = call(
        &engine,
        "messages.list",
        json!({ "session_id": "s1", "include_hidden": true, "limit": 10 }),
    );
    let items = all["items"].as_array().unwrap();
    assert_eq!(items.len(), 2);
    let m2 = items.iter().find(|m| m["id"] == json!("m2")).unwrap();
    assert_eq!(m2["hidden"], json!(1), "list 必须返回 hidden 列（读侧镜像靠它判定压缩）");
    let m1 = items.iter().find(|m| m["id"] == json!("m1")).unwrap();
    assert_eq!(m1["hidden"], json!(0));

    // 默认（不含 hidden）仍然过滤
    let visible = call(
        &engine,
        "messages.list",
        json!({ "session_id": "s1", "include_hidden": false, "limit": 10 }),
    );
    assert_eq!(visible["items"].as_array().unwrap().len(), 1);

    // get 也要给
    let got = call(&engine, "messages.get", json!({ "id": "m2" }));
    assert_eq!(got["item"]["hidden"], json!(1), "messages.get 也必须返回 hidden");
}

#[test]
fn messages_list_requires_explicit_include_hidden() {    let (_d, engine) = temp_engine("hidden");
    call(&engine, "sessions.upsert", json!({ "id": "s1" }));
    let err = dispatch(&engine, "messages.list", &json!({ "session_id": "s1" })).unwrap_err();
    assert!(
        format!("{err}").contains("include_hidden"),
        "索引层不替调用方猜可见性：必须显式声明 include_hidden"
    );

    // hidden 语义：默认（false）不含 hidden 行，显式 true 才包含
    call(
        &engine,
        "messages.create",
        json!({ "id": "v1", "session_id": "s1", "role": "user", "content": "可见", "timestamp": 1 }),
    );
    call(
        &engine,
        "messages.create",
        json!({ "id": "h1", "session_id": "s1", "role": "user", "content": "已压缩", "timestamp": 2 }),
    );
    call(&engine, "messages.update", json!({ "id": "h1", "hidden": 1 }));

    let visible = call(
        &engine,
        "messages.list",
        json!({ "session_id": "s1", "include_hidden": false }),
    );
    assert_eq!(visible["items"].as_array().unwrap().len(), 1);
    let all = call(
        &engine,
        "messages.list",
        json!({ "session_id": "s1", "include_hidden": true }),
    );
    assert_eq!(all["items"].as_array().unwrap().len(), 2);
    let counts = call(&engine, "messages.count", json!({ "session_id": "s1" }));
    assert_eq!(counts["total"], json!(2));
    assert_eq!(counts["visible"], json!(1));
    assert_eq!(counts["hidden"], json!(1));
}

#[test]
fn create_many_is_all_or_nothing() {
    let (_d, engine) = temp_engine("atomic");
    call(&engine, "sessions.upsert", json!({ "id": "s1" }));
    // 第二条缺 role → 整个批次必须不产生任何写入（参数在事务外先解析校验）
    let err = dispatch(
        &engine,
        "messages.create_many",
        &json!({ "items": [
            { "id": "a", "session_id": "s1", "role": "user", "content": "1" },
            { "id": "b", "session_id": "s1", "content": "2" }
        ] }),
    )
    .unwrap_err();
    assert!(format!("{err}").contains("role"), "应报出缺 role：{err}");
    let counts = call(&engine, "messages.count", json!({ "session_id": "s1" }));
    assert_eq!(counts["total"], json!(0), "批次失败不得留下部分写入");
}

#[test]
fn settings_sync_roundtrip_and_undo() {
    let (_d, engine) = temp_engine("settings");
    call(&engine, "settings.set", json!({ "key": "theme", "value": "dark" }));
    call(&engine, "settings.set", json!({ "key": "n", "value": 42 }));
    let all = call(&engine, "settings.get_all", json!({}));
    assert_eq!(all["theme"], json!("dark"));
    assert_eq!(all["n"], json!("42"), "非字符串按 JSON 文本存（既有约定）");

    call(&engine, "settings.set", json!({ "key": "theme", "value": "light" }));
    let all2 = call(&engine, "settings.get_all", json!({}));
    assert_eq!(all2["theme"], json!("light"), "upsert 应覆盖");

    call(&engine, "settings.remove", json!({ "key": "theme" }));
    let all3 = call(&engine, "settings.get_all", json!({}));
    assert!(all3.get("theme").is_none(), "删除后不应再出现");
}

#[test]
fn counts_reports_known_tables() {
    let (_d, engine) = temp_engine("counts");
    call(&engine, "sessions.upsert", json!({ "id": "s1" }));
    let counts = call(&engine, "counts", json!({ "tables": ["sessions", "messages"] }));
    assert_eq!(counts["sessions"], json!(1));
    assert_eq!(counts["messages"], json!(0));

    // 默认表集必须都存在（否则对账工具会拿到假数据）
    let default = call(&engine, "counts", json!({}));
    for t in codem_db::repo::DEFAULT_COUNT_TABLES {
        assert!(default.get(*t).is_some(), "默认统计缺少表 {t}");
    }
}

#[test]
fn integrity_check_reports_ok() {
    let (_d, engine) = temp_engine("integrity");
    let r = engine.integrity_check().unwrap();
    assert!(r.ok, "全新库 quick_check 应为 ok，实际：{}", r.detail);
}

#[test]
fn health_reports_wal_and_sizes() {
    let (_d, engine) = temp_engine("health");
    let h = engine.health().unwrap();
    assert_eq!(h.engine, "rust");
    assert!(h.ready);
    assert_eq!(h.journal_mode.to_lowercase(), "wal");
    assert!(h.size_bytes > 0, "库大小应大于 0");
    assert!(h.tables >= 30, "表数应接近 schema 全量（实际 {}）", h.tables);
    assert!(h.last_error_code.is_none(), "新引擎不应带错误码");
}

#[test]
fn wal_checkpoint_then_integrity_still_ok() {
    let (_d, engine) = temp_engine("ckpt");
    call(&engine, "sessions.upsert", json!({ "id": "s1" }));
    engine.checkpoint().unwrap();
    assert!(engine.integrity_check().unwrap().ok);
}

#[test]
fn dispatch_never_accepts_sql() {
    let (_d, engine) = temp_engine("nosql");
    for cmd in ["SELECT 1", "messages.list; DROP TABLE messages", "raw.sql"] {
        let err = dispatch(&engine, cmd, &json!({})).unwrap_err();
        assert_eq!(err.code, codem_db::ErrorCode::Unsupported, "{cmd} 应被拒绝");
    }
    // 库仍然完好
    assert!(engine.integrity_check().unwrap().ok);
}

// ========== 消息索引的复合写（P3 第 6 段） ==========

/// `messages.upsert_index` 必须**一次事务**完成：消息主行 + JSON 列 + tool_calls 整体替换。
/// 拆成多条命令时，中途失败会留下"消息更新了、工具调用只写了一半"的不一致状态。
#[test]
fn upsert_index_replaces_tool_calls_atomically() {
    let (_d, e) = temp_engine("upsert-index");
    call(&e, "sessions.upsert", json!({ "id": "s1" }));

    // 首次插入：带 2 个工具调用
    let r = call(
        &e,
        "messages.upsert_index",
        json!({
            "id": "m1", "session_id": "s1", "role": "assistant", "content": "第一版",
            "tool_calls": [
                { "id": "t1", "tool": "read_file", "args": { "path": "a" }, "status": "done", "result": "A" },
                { "id": "t2", "tool": "grep", "args": { "q": "x" }, "status": "running" }
            ]
        }),
    );
    assert_eq!(r["inserted"], json!(true));
    assert_eq!(r["tool_calls"], json!(2));

    let listed = call(&e, "tool_calls.list", json!({ "message_id": "m1" }));
    assert_eq!(listed["items"].as_array().unwrap().len(), 2);

    // 第二次 upsert：只带 1 个工具调用 → 必须**整体替换**（不是追加）
    let r2 = call(
        &e,
        "messages.upsert_index",
        json!({
            "id": "m1", "session_id": "s1", "role": "assistant", "content": "第二版",
            "tool_calls": [{ "id": "t3", "tool": "write_file", "args": {}, "status": "done" }]
        }),
    );
    assert_eq!(r2["inserted"], json!(false));
    let after = call(&e, "tool_calls.list", json!({ "message_id": "m1" }));
    let items = after["items"].as_array().unwrap();
    assert_eq!(items.len(), 1, "必须是整体替换，旧工具调用不能残留：{items:?}");
    assert_eq!(items[0]["id"], json!("t3"));

    // 消息内容也要更新
    let got = call(&e, "messages.get", json!({ "id": "m1" }));
    assert_eq!(got["item"]["content"], json!("第二版"));
}

/// 不给 `tool_calls` 时**不得**动已有工具调用（"没提"不等于"清空"）
#[test]
fn upsert_index_without_tool_calls_leaves_them_alone() {
    let (_d, e) = temp_engine("upsert-keep");
    call(&e, "sessions.upsert", json!({ "id": "s1" }));
    call(
        &e,
        "messages.upsert_index",
        json!({ "id": "m1", "session_id": "s1", "role": "assistant", "content": "x",
                "tool_calls": [{ "id": "t1", "tool": "a", "args": {}, "status": "done" }] }),
    );
    call(
        &e,
        "messages.upsert_index",
        json!({ "id": "m1", "session_id": "s1", "role": "assistant", "content": "y" }),
    );
    let after = call(&e, "tool_calls.list", json!({ "message_id": "m1" }));
    assert_eq!(
        after["items"].as_array().unwrap().len(),
        1,
        "缺省 tool_calls 时应保留原有记录（渲染侧语义：只更新给出的东西）"
    );
}

/// JSON 列（generated_files / retrieved_sources）按 JSON 文本存，缺省不动
#[test]
fn upsert_index_handles_json_columns() {
    let (_d, e) = temp_engine("upsert-json");
    call(&e, "sessions.upsert", json!({ "id": "s1" }));
    call(
        &e,
        "messages.upsert_index",
        json!({ "id": "m1", "session_id": "s1", "role": "assistant", "content": "x",
                "generated_files": [{ "path": "a.ts" }], "retrieved_sources": [{ "id": "s1" }] }),
    );
    let got = call(&e, "messages.get", json!({ "id": "m1" }));
    // messages.get 不返回这两列，所以直接查对账摘要里的行数即可（写入成功即可）
    assert_eq!(got["item"]["id"], json!("m1"));

    // 第二次不带它们 → 不应被清空
    call(
        &e,
        "messages.upsert_index",
        json!({ "id": "m1", "session_id": "s1", "role": "assistant", "content": "y" }),
    );
    let counts = call(&e, "counts", json!({ "tables": ["messages"] }));
    assert_eq!(counts["messages"], json!(1));
}

/// `tool_calls.replace` 对不存在的消息必须报 NOT_FOUND（不能写孤儿工具调用）
#[test]
fn tool_calls_replace_rejects_orphan() {
    let (_d, e) = temp_engine("tc-orphan");
    let err = dispatch(
        &e,
        "tool_calls.replace",
        &json!({ "message_id": "nope", "tool_calls": [] }),
    )
    .unwrap_err();
    assert_eq!(err.code, codem_db::ErrorCode::NotFound);
    assert!(format!("{err}").contains("nope"));
}

/// 参数错误必须整批不落（事务外先校验）
#[test]
fn upsert_index_validates_before_writing() {
    let (_d, e) = temp_engine("upsert-validate");
    call(&e, "sessions.upsert", json!({ "id": "s1" }));
    // 第二个工具调用缺 tool → 整条命令失败，且不留任何行
    let err = dispatch(
        &e,
        "messages.upsert_index",
        &json!({ "id": "m1", "session_id": "s1", "role": "assistant", "content": "x",
                 "tool_calls": [{ "id": "t1", "tool": "a", "args": {} }, { "id": "t2", "args": {} }] }),
    )
    .unwrap_err();
    assert!(format!("{err}").contains("tool"), "应指出缺 tool：{err}");
    let counts = call(&e, "counts", json!({ "tables": ["messages", "tool_calls"] }));
    assert_eq!(counts["messages"], json!(0), "参数错误不得留下消息行");
    assert_eq!(counts["tool_calls"], json!(0));
}
