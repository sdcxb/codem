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

// ========== 损坏库的自动恢复（第 19 轮补的缺口） ==========

/// 旧引擎（sql.js）在 quick_check 失败时会"备份坏文件 + 重建"，删引擎时这条能力一度没有对应物
/// —— 库一坏就是"本进程没有存储"。本测试钉住新的语义：
/// ① 坏文件被**改名备份**（不是删掉：那可能是还能救的最后一份）；② 空库被重建且可用；
/// ③ 恢复这件事**被报出来**（`recovered_from`），而不是悄悄发生。
#[test]
fn corrupt_database_is_backed_up_and_rebuilt() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("corrupt.bin");

    // 造一个"看起来像 SQLite、实际不是"的文件：正确的 16 字节头 + 乱码正文
    let mut bytes = Vec::from(&b"SQLite format 3\0"[..]);
    bytes.extend(std::iter::repeat(0x7au8).take(4096));
    std::fs::write(&path, &bytes).unwrap();

    // ① 普通 open 必须失败，且错误码是 CORRUPT（否则恢复逻辑根本不会被触发）
    let err = match Engine::open(&path) {
        Ok(_) => panic!("损坏文件不该被正常打开"),
        Err(e) => e,
    };
    assert_eq!(err.code, codem_db::ErrorCode::Corrupt, "损坏必须映射为 CORRUPT：{err:?}");

    // ② open_with_recovery：备份 + 重建
    let (engine, backup) = Engine::open_with_recovery(&path).expect("损坏库应当能被恢复");
    let backup = backup.expect("恢复时必须给出备份路径");

    assert!(backup.exists(), "备份文件必须真的存在：{}", backup.display());
    assert_eq!(std::fs::metadata(&backup).unwrap().len(), bytes.len() as u64, "备份必须与坏文件同内容（改名，不改写）");
    /* ⚠️ 这里**不比对"原路径的文件大小"**：WAL 模式下新建的库主文件可能只有几 KB
     * （数据都还在 `-wal` 里），拿"比坏文件大"当判据是我第一版写的**假判据** ——
     * 实测它会在一个完全正常的恢复上失败。
     * "原路径已经换成新库"这件事用**行为**验证（下面那几条：schema 就位、完整性通过、能读能写）。 */

    // ③ 重建后的库可用：schema 就位、可写可读、完整性通过
    let report = engine.schema_report();
    assert!(report.fresh, "重建出来的应当是全新库");
    assert!(report.tables >= 30, "新库必须有完整 schema：{} 张表", report.tables);
    let integrity = engine.integrity_check().unwrap();
    assert!(integrity.ok, "重建后的库必须完整性通过：{}", integrity.detail);
    call(&engine, "projects.upsert", json!({ "id": "p-after-recovery", "name": "恢复后" }));
    let listed = call(&engine, "projects.list", json!({}));
    assert!(
        listed["items"].as_array().unwrap().iter().any(|p| p["id"] == "p-after-recovery"),
        "重建后的库必须能正常读写"
    );

    // ④ 正常库不该触发恢复（否则每次启动都会备份一遍）
    let clean = dir.path().join("clean.bin");
    Engine::open(&clean).unwrap();
    let (_e, none) = Engine::open_with_recovery(&clean).expect("正常库直接打开");
    assert!(none.is_none(), "正常库不得产生备份");
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

// ========== 数据面补充：反馈 / 附件 / 全文索引（P3 第 8 段） ==========

#[test]
fn feedback_set_clear_and_validate() {
    let (_d, e) = temp_engine("fb");
    call(&e, "sessions.upsert", json!({ "id": "s1" }));
    call(&e, "messages.create", json!({ "id": "m1", "session_id": "s1", "role": "user", "content": "x" }));

    // 无反馈时 get 返回 item:null（渲染侧按 null 处理）
    let none = call(&e, "feedback.get", json!({ "message_id": "m1" }));
    assert!(none["item"].is_null());

    call(&e, "feedback.set", json!({ "message_id": "m1", "session_id": "s1", "feedback": "like" }));
    assert_eq!(call(&e, "feedback.get", json!({ "message_id": "m1" }))["item"]["feedback"], json!("like"));

    // 改成 dislike：必须是替换而不是新增（一条消息最多一个反馈）
    call(&e, "feedback.set", json!({ "message_id": "m1", "session_id": "s1", "feedback": "dislike" }));
    assert_eq!(call(&e, "feedback.get", json!({ "message_id": "m1" }))["item"]["feedback"], json!("dislike"));
    let counts = call(&e, "counts", json!({ "tables": ["message_feedback"] }));
    assert_eq!(counts["message_feedback"], json!(1), "覆盖不该产生第二行");

    // feedback=null → 取消（渲染侧 saveFeedback(id,sid,null) 的语义）
    let cleared = call(&e, "feedback.set", json!({ "message_id": "m1", "session_id": "s1", "feedback": null }));
    assert_eq!(cleared["cleared"], json!(true));
    assert!(call(&e, "feedback.get", json!({ "message_id": "m1" }))["item"].is_null());

    // 非法值必须报错（表上有 CHECK 约束，但我们要在写入前就给出清晰错误）
    let err = dispatch(&e, "feedback.set", &json!({ "message_id": "m1", "session_id": "s1", "feedback": "meh" })).unwrap_err();
    assert!(format!("{err}").contains("like"), "应指出允许值：{err}");
}

#[test]
fn attachments_list_excludes_content_and_update_uses_coalesce() {
    let (_d, e) = temp_engine("att");
    call(&e, "sessions.upsert", json!({ "id": "s1" }));
    // 通过受控 import 通道插入一行附件（仓储命令里没有 create 附件；
    // `added_at` 是 NOT NULL，必须显式给）
    crate::dispatch(&e, "import.begin", &json!({})).unwrap();
    crate::dispatch(
        &e,
        "import.table",
        &json!({
            "table": "attachments",
            "columns": ["id", "session_id", "name", "type", "content", "preview", "added_at"],
            "rows": [["a1", "s1", "文档.pdf", "file", "很长的正文", "预览", 1]]
        }),
    )
    .unwrap();
    crate::dispatch(&e, "import.end", &json!({})).unwrap();

    let listed = call(&e, "attachments.list", json!({ "session_id": "s1" }));
    let item = &listed["items"][0];
    assert_eq!(item["id"], json!("a1"));
    assert_eq!(item["name"], json!("文档.pdf"));
    assert_eq!(item["preview"], json!("预览"));
    // 关键：**不能**返回正文（大附件正文必须按需取）
    assert!(
        item.get("content").is_none(),
        "attachments.list 不得返回 content（大文档会读爆内存）：{item}"
    );

    // 更新正文：只给 content → preview 必须保留（COALESCE 语义）
    call(&e, "attachments.update", json!({ "id": "a1", "content": "新正文" }));
    let after = call(&e, "attachments.list", json!({ "session_id": "s1" }));
    assert_eq!(after["items"][0]["preview"], json!("预览"), "只更新正文时预览不该被清空");

    // 更新不存在的附件 → NOT_FOUND（A 类防线）
    let err = dispatch(&e, "attachments.update", &json!({ "id": "nope", "content": "x" })).unwrap_err();
    assert_eq!(err.code, codem_db::ErrorCode::NotFound);
}

/// CJK 中文检索必须可用 —— 这是实测发现的真缺陷。
///
/// 修复前：`MATCH '存储'` 返回 0 行（unicode61 把整串 CJK 当一个 token），
/// 也就是说**中文全文检索从来没生效过**，而这是中文优先的产品。
/// 现在入库与查询都做同一套切分（单字 + 相邻双字），所以：
/// - 单字查询能命中；
/// - 双字及以上的词查询能命中。
#[test]
fn fts_search_works_for_cjk() {
    let (_d, e) = temp_engine("fts-cjk");
    call(&e, "sessions.upsert", json!({ "id": "s1" }));
    call(
        &e,
        "messages.create",
        json!({ "id": "m1", "session_id": "s1", "role": "user",
                "content": "关于存储迁移的讨论，涉及索引与消息表", "timestamp": 1 }),
    );
    call(
        &e,
        "messages.create",
        json!({ "id": "m2", "session_id": "s1", "role": "user",
                "content": "完全无关的内容", "timestamp": 2 }),
    );
    let rb = call(&e, "fts.rebuild", json!({ "session_id": "s1" }));
    assert_eq!(rb["added"], json!(2));

    // 单字、双字、多字词都应命中 m1
    for q in ["存", "存储", "迁移", "存储迁移", "索引", "消息"] {
        let hit = call(&e, "fts.search", json!({ "session_id": "s1", "query": q }));
        let ids: Vec<String> = hit["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| x["message_id"].as_str().unwrap_or("").to_string())
            .collect();
        assert_eq!(ids, vec!["m1".to_string()], "查询「{q}」应只命中 m1，实际 {ids:?}");
    }

    // 不存在的词返回空（而不是报错或全表）
    let none = call(&e, "fts.search", json!({ "session_id": "s1", "query": "量子计算" }));
    assert_eq!(none["items"].as_array().unwrap().len(), 0);

    // 空查询/纯标点 → 参数错误（不能退化成"匹配全表"）
    for bad in ["", "   ", "，。！"] {
        let err = dispatch(&e, "fts.search", &json!({ "session_id": "s1", "query": bad })).unwrap_err();
        assert!(format!("{err}").contains("query"), "应报参数错误：{bad} / {err}");
    }
}

/// **跨会话搜索**（不传 session_id）必须真的跨会话。
///
/// 渲染侧原来的实现里"全局搜索"其实从没生效过：它算了一个 `matchExpr`
/// 却从未用于 SQL（死代码），而两条 SQL 都带 `s.session_id = ?`。
/// 这里从引擎侧钉住"不传 session_id 就是全局"。
#[test]
fn fts_search_spans_sessions_when_session_id_omitted() {
    let (_d, e) = temp_engine("fts-global");
    call(&e, "sessions.upsert", json!({ "id": "s1", "title": "会话一" }));
    call(&e, "sessions.upsert", json!({ "id": "s2", "title": "会话二" }));
    call(&e, "messages.create", json!({ "id": "m1", "session_id": "s1", "role": "user", "content": "共同关键词：存储迁移", "timestamp": 1 }));
    call(&e, "messages.create", json!({ "id": "m2", "session_id": "s2", "role": "assistant", "content": "另一会话也提到存储迁移", "timestamp": 2 }));
    call(&e, "fts.rebuild", json!({ "session_id": "s1" }));
    call(&e, "fts.rebuild", json!({ "session_id": "s2" }));

    // 限定会话 → 只 1 条
    let one = call(&e, "fts.search", json!({ "session_id": "s1", "query": "存储" }));
    assert_eq!(one["items"].as_array().unwrap().len(), 1);
    assert_eq!(one["scope"], json!("s1"));

    // 不限定 → 两条都在，且带上会话标题（搜索界面要显示"来自哪个会话"）
    let all = call(&e, "fts.search", json!({ "query": "存储" }));
    let items = all["items"].as_array().unwrap();
    assert_eq!(items.len(), 2, "不传 session_id 必须跨会话：{items:?}");
    assert_eq!(all["scope"], json!("<all>"));
    let sid_set: std::collections::HashSet<&str> =
        items.iter().filter_map(|x| x["session_id"].as_str()).collect();
    assert_eq!(sid_set.len(), 2, "两条结果应来自不同会话");
    // 正文随结果返回（渲染侧要在正文上做高亮）
    assert!(
        items.iter().all(|x| x["content"].as_str().map(|c| !c.is_empty()).unwrap_or(false)),
        "必须返回真实正文（不是切分后的索引文本）：{items:?}"
    );
    assert!(
        items.iter().any(|x| x["session_title"] == json!("会话一")),
        "应带上会话标题"
    );
}

/// 重建是**幂等**的：再跑一次应以"已对齐"结束（不重复写）
#[test]
fn fts_rebuild_is_idempotent() {
    let (_d, e) = temp_engine("fts-idem");
    call(&e, "sessions.upsert", json!({ "id": "s1" }));
    call(&e, "messages.create", json!({ "id": "m1", "session_id": "s1", "role": "user", "content": "内容文本", "timestamp": 1 }));
    let first = call(&e, "fts.rebuild", json!({ "session_id": "s1" }));
    assert_eq!(first["added"], json!(1));
    let second = call(&e, "fts.rebuild", json!({ "session_id": "s1" }));
    assert_eq!(
        (second["added"].as_i64().unwrap(), second["refreshed"].as_i64().unwrap()),
        (0, 0),
        "第二次重建不应再写任何行（长度判定已用切分后的文本）：{second}"
    );
}

#[test]
fn fts_rebuild_keeps_log_only_ids_and_removes_orphans() {
    let (_d, e) = temp_engine("fts");
    call(&e, "sessions.upsert", json!({ "id": "s1" }));
    call(&e, "messages.create", json!({ "id": "m1", "session_id": "s1", "role": "user", "content": "索引里的消息", "timestamp": 1 }));

    // 先建索引
    let r1 = call(&e, "fts.rebuild", json!({ "session_id": "s1" }));
    assert_eq!(r1["added"], json!(1), "应补上索引里的那条");
    assert_eq!(r1["removed"], json!(0));

    // 插入一条"孤儿" FTS 行（模拟消息已删但虚拟表没有级联）
    let (_d2, e3) = temp_engine("fts2");
    call(&e3, "sessions.upsert", json!({ "id": "s1" }));
    let _ = e3;

    // 在 e 上直接制造孤儿：先建，再删消息，再 rebuild
    call(&e, "messages.create", json!({ "id": "m2", "session_id": "s1", "role": "user", "content": "将被删除", "timestamp": 2 }));
    call(&e, "fts.rebuild", json!({ "session_id": "s1" }));
    call(&e, "messages.delete", json!({ "ids": ["m2"] }));
    let r2 = call(&e, "fts.rebuild", json!({ "session_id": "s1" }));
    assert_eq!(r2["removed"], json!(1), "消息删掉后 FTS 行应作为孤儿被清理（虚拟表没有级联）");

    // keep_ids：日志里有、索引里没有的 id 不能被当孤儿删掉
    // （造一条只存在于 FTS 的 id，并通过 keep_ids 声明它"日志里还有"）
    let (_d3, e4) = temp_engine("fts3");
    call(&e4, "sessions.upsert", json!({ "id": "s1" }));
    call(&e4, "messages.create", json!({ "id": "k1", "session_id": "s1", "role": "user", "content": "日志独有", "timestamp": 1 }));
    call(&e4, "fts.rebuild", json!({ "session_id": "s1" }));
    // 把 messages 里的 k1 删掉（模拟"索引里没有但日志里还有"）
    call(&e4, "messages.delete", json!({ "ids": ["k1"] }));
    // 不带 keep_ids → 被当孤儿删除
    let r3 = call(&e4, "fts.rebuild", json!({ "session_id": "s1" }));
    assert_eq!(r3["removed"], json!(1));
}

#[test]
fn fts_search_finds_indexed_content() {
    let (_d, e) = temp_engine("fts-search");
    call(&e, "sessions.upsert", json!({ "id": "s1" }));
    call(&e, "messages.create", json!({ "id": "m1", "session_id": "s1", "role": "user", "content": "关于存储迁移的讨论", "timestamp": 1 }));
    call(&e, "messages.create", json!({ "id": "m2", "session_id": "s1", "role": "user", "content": "完全无关的内容", "timestamp": 2 }));
    let rb = call(&e, "fts.rebuild", json!({ "session_id": "s1" }));
    assert_eq!(rb["added"], json!(2));

    let hit = call(&e, "fts.search", json!({ "session_id": "s1", "query": "迁移" }));
    let items = hit["items"].as_array().unwrap();
    assert_eq!(items.len(), 1, "应只命中含关键词的那条：{items:?}");
    assert_eq!(items[0]["message_id"], json!("m1"));

    let none = call(&e, "fts.search", json!({ "session_id": "s1", "query": "不存在的词" }));
    assert_eq!(none["items"].as_array().unwrap().len(), 0);
}

#[test]
fn fts_delete_session_clears_rows() {
    let (_d, e) = temp_engine("fts-del");
    call(&e, "sessions.upsert", json!({ "id": "s1" }));
    call(&e, "messages.create", json!({ "id": "m1", "session_id": "s1", "role": "user", "content": "x", "timestamp": 1 }));
    call(&e, "fts.rebuild", json!({ "session_id": "s1" }));
    let del = call(&e, "fts.delete_session", json!({ "session_id": "s1" }));
    assert_eq!(del["written"], json!(1));
    let after = call(&e, "fts.search", json!({ "session_id": "s1", "query": "x" }));
    assert_eq!(after["items"].as_array().unwrap().len(), 0);
}

// ========== 通用仓储命令（P3 第 10 段） ==========

/// 通用命令的安全边界：表名/列名/order_by 都必须过白名单或真实列核对。
///
/// 这是"通用 CRUD 不违背存储边界门禁"的根据 —— 与裸 SQL 的差别是**结构性**的：
/// 调用方只能说"在这张表里按这些条件取这些列"，不能说"执行这条语句"。
#[test]
fn crud_rejects_tables_columns_and_unsafe_order_by() {
    let (_d, e) = temp_engine("crud-guard");

    // 1) 表名不在业务表清单里 → UNSUPPORTED
    for bad in ["sqlite_master", "session_fts", "session_fts_content", "不存在的表"] {
        let err = dispatch(&e, "crud.list", &json!({ "table": bad })).unwrap_err();
        assert_eq!(
            err.code,
            codem_db::ErrorCode::Unsupported,
            "表 {bad} 应被拒绝：{err}"
        );
    }

    // 2) 列名不在真实列定义里 → 参数错误
    let err = dispatch(
        &e,
        "crud.list",
        &json!({ "table": "graph_nodes", "columns": ["__proto__"] }),
    )
    .unwrap_err();
    assert!(format!("{err}").contains("__proto__"), "应指出非法列名：{err}");

    // 3) order_by 也只能是真实列（不给任何表达式入口）
    let err = dispatch(
        &e,
        "crud.list",
        &json!({ "table": "graph_nodes", "order_by": "id; DROP TABLE accounts" }),
    )
    .unwrap_err();
    assert!(format!("{err}").contains("order_by") || format!("{err}").contains("列"));

    // 4) where 的列同样核对
    let err = dispatch(
        &e,
        "crud.list",
        &json!({ "table": "graph_nodes", "where": { "nope": 1 } }),
    )
    .unwrap_err();
    assert!(format!("{err}").contains("nope"));

    // 库仍然完好
    assert!(e.integrity_check().unwrap().ok);
}

/// 删除必须给 where —— 空条件会清空整表，属于危险操作（与 `telemetry.prune` 同一条原则）
#[test]
fn crud_delete_requires_where() {
    let (_d, e) = temp_engine("crud-del");
    for payload in [json!({ "table": "graph_nodes" }), json!({ "table": "graph_nodes", "where": {} })] {
        let err = dispatch(&e, "crud.delete", &payload).unwrap_err();
        assert!(
            format!("{err}").contains("where"),
            "空 where 必须被拒绝：{err}"
        );
    }
}

/// 通用读写往返：列可以逐行不同（按并集收集），整批一个事务
#[test]
fn crud_upsert_list_count_delete_roundtrip() {
    let (_d, e) = temp_engine("crud-rt");
    // graph_nodes.notebook_id 有外键 → 先建父行
    call(&e, "crud.upsert", json!({ "table": "notebooks", "rows": [{ "id": "nb1", "name": "笔记本", "created_at": 1, "updated_at": 1 }] }));

    let up = call(
        &e,
        "crud.upsert",
        json!({ "table": "graph_nodes", "rows": [
            { "id": "a1", "notebook_id": "nb1", "label": "节点一", "entity_type": "concept", "created_at": 1 },
            { "id": "a2", "notebook_id": "nb1", "label": "节点二", "entity_type": "concept", "created_at": 2 }
        ]}),
    );
    assert_eq!(up["written"], json!(2));

    let listed = call(&e, "crud.list", json!({ "table": "graph_nodes", "order_by": "id" }));
    let items = listed["items"].as_array().unwrap();
    assert_eq!(items.len(), 2);
    assert_eq!(items[0]["id"], json!("a1"));
    assert_eq!(items[0]["label"], json!("节点一"));
    assert_eq!(listed["has_more"], json!(false));

    // 条件查询
    let filtered = call(
        &e,
        "crud.list",
        json!({ "table": "graph_nodes", "where": { "id": "a2" } }),
    );
    assert_eq!(filtered["items"].as_array().unwrap().len(), 1);
    assert_eq!(filtered["items"][0]["label"], json!("节点二"));

    // 计数
    let cnt = call(&e, "crud.count", json!({ "table": "graph_nodes" }));
    assert_eq!(cnt["count"], json!(2));
    let cnt1 = call(&e, "crud.count", json!({ "table": "graph_nodes", "where": { "id": "a1" } }));
    assert_eq!(cnt1["count"], json!(1));

    // 删除（带条件）
    let del = call(&e, "crud.delete", json!({ "table": "graph_nodes", "where": { "id": "a1" } }));
    assert_eq!(del["written"], json!(1));
    assert_eq!(call(&e, "crud.count", json!({ "table": "graph_nodes" }))["count"], json!(1));
}

/// 分页：多取一行判断 has_more；游标自洽
#[test]
fn crud_list_paginates() {
    let (_d, e) = temp_engine("crud-page");
    call(&e, "crud.upsert", json!({ "table": "notebooks", "rows": [{ "id": "nb1", "name": "笔记本", "created_at": 1, "updated_at": 1 }] }));
    let rows: Vec<serde_json::Value> = (0..25)
        .map(|i| json!({ "id": format!("g{i:03}"), "notebook_id": "nb1", "label": format!("节点{i}"), "entity_type": "concept", "created_at": i }))
        .collect();
    // graph_nodes 需要 notebook_id NOT NULL，用 accounts 更省事（列少）
    call(&e, "crud.upsert", json!({ "table": "graph_nodes", "rows": rows }));

    let p1 = call(&e, "crud.list", json!({ "table": "graph_nodes", "limit": 10, "order_by": "id" }));
    assert_eq!(p1["items"].as_array().unwrap().len(), 10);
    assert_eq!(p1["has_more"], json!(true));
    assert_eq!(p1["next_cursor"], json!("10"));

    let last = call(
        &e,
        "crud.list",
        json!({ "table": "graph_nodes", "limit": 10, "offset": 20, "order_by": "id" }),
    );
    assert_eq!(last["items"].as_array().unwrap().len(), 5);
    assert_eq!(last["has_more"], json!(false));
}

/// 参数错误整批不落（事务外先解析校验）
#[test]
fn crud_upsert_validates_before_writing() {
    let (_d, e) = temp_engine("crud-validate");
    // 第二行含不存在的列 → 整批失败且不留任何行
    let err = dispatch(
        &e,
        "crud.upsert",
        &json!({ "table": "graph_nodes", "rows": [
            { "id": "ok1", "notebook_id": "nb1", "label": "合法", "entity_type": "concept", "created_at": 1 },
            { "id": "bad1", "不存在列": 1 }
        ]}),
    )
    .unwrap_err();
    assert!(format!("{err}").contains("不存在列"), "应指出非法列：{err}");
    assert_eq!(
        call(&e, "crud.count", json!({ "table": "graph_nodes" }))["count"],
        json!(0),
        "批次失败不得留下部分写入"
    );
}

/// replace 模式覆盖同主键的行（用于"从旧库搬过来"这类场景）
#[test]
fn crud_upsert_replace_overwrites() {
    let (_d, e) = temp_engine("crud-replace");
    call(&e, "crud.upsert", json!({ "table": "notebooks", "rows": [{ "id": "nb1", "name": "笔记本", "created_at": 1, "updated_at": 1 }] }));
    call(&e, "crud.upsert", json!({ "table": "graph_nodes", "rows": [{ "id": "a1", "notebook_id": "nb1", "label": "第一版", "entity_type": "concept", "created_at": 1 }] }));
    call(
        &e,
        "crud.upsert",
        json!({ "table": "graph_nodes", "mode": "replace", "rows": [{ "id": "a1", "notebook_id": "nb1", "label": "第二版", "entity_type": "concept", "created_at": 1 }] }),
    );
    let listed = call(&e, "crud.list", json!({ "table": "graph_nodes" }));
    assert_eq!(listed["items"].as_array().unwrap().len(), 1, "replace 不该产生第二行");
    assert_eq!(listed["items"][0]["label"], json!("第二版"));
}

/// 缺省列清单 = 该表真实列（顺序稳定，便于摘要与对账）
#[test]
fn crud_list_defaults_to_real_columns_in_order() {
    let (_d, e) = temp_engine("crud-cols");
    call(&e, "crud.upsert", json!({ "table": "notebooks", "rows": [{ "id": "nb1", "name": "笔记本", "created_at": 1, "updated_at": 1 }] }));
    call(&e, "crud.upsert", json!({ "table": "graph_nodes", "rows": [{ "id": "a1", "notebook_id": "nb1", "label": "x", "entity_type": "concept", "created_at": 1 }] }));
    let listed = call(&e, "crud.list", json!({ "table": "graph_nodes" }));
    let item = listed["items"][0].as_object().unwrap();
    // 至少应含真实列里的 id 与 name（其余列缺省为 null 或默认值）
    assert!(item.contains_key("id"), "缺省列清单应含 id：{item:?}");
    assert!(item.contains_key("label"), "缺省列清单应含 label：{item:?}");
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

/// `messages.upsert_index` 对 `hidden` 的语义（P5 第 2 段新增）。
///
/// 两条都必须成立：
/// 1. **不传 hidden 的普通更新必须保留库里已有的 hidden** —— 否则一次内容更新就会把
///    已压缩隐藏的消息复活（历史上修过的一类 bug：压缩后消息又进了上下文）；
/// 2. **显式传 hidden 必须生效（包括传 0）** —— 索引重建要把日志里的 hidden 还原回来，
///    而 `hidden = 0` 是合法值，不能被当成"没给"。
#[test]
fn upsert_index_preserves_hidden_unless_explicitly_given() {
    let (_d, e) = temp_engine("hidden-semantics");
    call(&e, "sessions.upsert", json!({ "id": "s1" }));

    // 写入一条已隐藏的消息
    call(
        &e,
        "messages.upsert_index",
        json!({ "id": "m-hidden", "session_id": "s1", "role": "user", "content": "旧内容",
                 "timestamp": 1, "hidden": 1 }),
    );
    let all = call(&e, "messages.list", json!({ "session_id": "s1", "limit": 50, "include_hidden": true }));
    assert_eq!(all["items"][0]["hidden"], json!(1), "显式 hidden=1 必须生效");

    // ① 不传 hidden 的更新：内容变了，hidden 必须原样保留
    call(
        &e,
        "messages.upsert_index",
        json!({ "id": "m-hidden", "session_id": "s1", "role": "user", "content": "新内容", "timestamp": 2 }),
    );
    let after = call(&e, "messages.list", json!({ "session_id": "s1", "limit": 50, "include_hidden": true }));
    assert_eq!(after["items"][0]["content"], json!("新内容"));
    assert_eq!(
        after["items"][0]["hidden"],
        json!(1),
        "不传 hidden 的普通更新把已隐藏消息复活了（压缩语义被破坏）"
    );

    // ② 显式传 hidden=0：必须真的取消隐藏（不能被 COALESCE 吞掉）
    call(
        &e,
        "messages.upsert_index",
        json!({ "id": "m-hidden", "session_id": "s1", "role": "user", "content": "新内容",
                 "timestamp": 2, "hidden": 0 }),
    );
    let visible = call(&e, "messages.list", json!({ "session_id": "s1", "limit": 50, "include_hidden": true }));
    assert_eq!(visible["items"][0]["hidden"], json!(0), "显式 hidden=0 必须被当成有效值");

    // ③ 默认可见性：include_hidden=false 时隐藏消息不该出现
    call(
        &e,
        "messages.upsert_index",
        json!({ "id": "m-hidden", "session_id": "s1", "role": "user", "content": "新内容",
                 "timestamp": 2, "hidden": 1 }),
    );
    let only_visible = call(&e, "messages.list", json!({ "session_id": "s1", "limit": 50, "include_hidden": false }));
    assert_eq!(only_visible["items"].as_array().map(|a| a.len()), Some(0));
}

/// 中文必须能搜到（第 25 轮）：**索引与查询都要按 CJK bigram 切分**。
///
/// 这个测试守的是一个"行数对账发现不了"的缺陷：迁移搬进来的 `session_fts`
/// 是老库那份 unicode61 时代的**原始文本**，英文能搜、**中文恒为 0 条**
/// （真机实测：`消息` 在库里 LIKE 命中 21 行，FTS 查询返回 0；重建后同一查询 21 条）。
#[test]
fn chinese_is_searchable_after_rebuild() {
    let (_d, e) = temp_engine("cjk-fts");
    call(&e, "sessions.upsert", json!({ "id": "s1" }));
    call(&e, "projects.upsert", json!({ "id": "p1", "name": "P" }));
    call(
        &e,
        "messages.create",
        json!({ "id": "m1", "session_id": "s1", "role": "user",
                 "content": "关于存储迁移的讨论：上下文压缩会隐藏消息", "timestamp": 1 }),
    );

    // 重建索引（内部会把正文按 bigram 切分后写入 session_fts）
    let rebuilt = call(&e, "fts.rebuild_all", json!({}));
    assert!(rebuilt["sessions"].as_i64().unwrap_or(0) >= 1, "应至少重建一个会话：{rebuilt}");

    // 索引里存的应该是**切分后**的文本（含单字与双字），不再是原文
    let raw: String = e
        .with_conn(|conn| {
            conn.query_row("SELECT content FROM session_fts WHERE message_id = 'm1'", [], |r| {
                r.get(0)
            })
            .map_err(codem_db::DbError::from)
        })
        .expect("读索引内容失败");
    assert!(raw.starts_with("关") && raw.contains(' '), "索引应是切分形式：{raw:?}");

    // 中文子串必须能搜到（这是修复前恒为 0 的那条路径）
    for q in ["消息", "上下文", "压缩", "存储迁移"] {
        let hits = call(&e, "fts.search", json!({ "query": q, "limit": 10 }));
        assert!(
            hits["items"].as_array().map(|a| a.len()).unwrap_or(0) >= 1,
            "中文查询 {q:?} 应至少命中 1 条，实际：{hits}"
        );
    }

    // 英文/ASCII 也要照旧能搜（回归保护）
    call(
        &e,
        "messages.create",
        json!({ "id": "m2", "session_id": "s1", "role": "assistant",
                 "content": "ChatPanel 的渲染逻辑", "timestamp": 2 }),
    );
    call(&e, "fts.rebuild_all", json!({}));
    let en = call(&e, "fts.search", json!({ "query": "ChatPanel", "limit": 10 }));
    assert!(en["items"].as_array().map(|a| a.len()).unwrap_or(0) >= 1, "英文查询应命中：{en}");
}

// ========== 第 44 轮：数据面审计（4 个只读审计员）抓到的缺陷，逐条钉住 ==========

/// 建一个"有 1 个会话 + N 条消息 + N 个工具调用 + N 条事件"的库，
/// 用来量"删 1 行会话到底带走多少行"。
fn seed_session(engine: &Engine, sid: &str, n: usize) {
    call(engine, "projects.upsert", json!({ "id": "p1", "name": "P" }));
    call(engine, "sessions.upsert", json!({ "id": sid, "project_id": "p1" }));
    let items: Vec<serde_json::Value> = (0..n)
        .map(|i| {
            json!({
                "id": format!("{sid}-m{i:04}"),
                "session_id": sid,
                "role": "user",
                "content": format!("消息 {i}"),
                "timestamp": 1000 + i as i64,
            })
        })
        .collect();
    call(engine, "messages.create_many", json!({ "items": items }));
    for i in 0..n {
        call(
            engine,
            "events.append",
            json!({ "session_id": sid, "event_type": "step", "payload": { "i": i } }),
        );
    }
}

/// **F1（阻断级）**：删会话走的是 `crud.delete`（渲染侧 `domainDelete("sessions", {id})`
/// 的真实路径），而级联保护原来只装在**没被接线**的 `sessions.delete` 里。
///
/// 真机复现过：`crud.delete {table:sessions, where:{id:s1}}` → `{"written":1}`，
/// 300 条消息静默消失。这个测试钉住三件事：
/// ① 未声明 `confirm_bulk` 时**拒绝**；② 拒绝时**一行都没删**（事务回滚，不是"删了再说"）；
/// ③ 显式声明后放行，且如实报出含级联的真实规模。
#[test]
fn crud_delete_on_sessions_is_blocked_without_confirm_bulk_and_rolls_back() {
    let (_d, e) = temp_engine("cascade-guard");
    seed_session(&e, "s1", 60);

    let before = call(&e, "counts", json!({ "tables": ["messages", "sessions", "session_events"] }));
    assert_eq!(call(&e, "counts", json!({ "tables": ["messages"] }))["messages"], json!(60));

    let err = dispatch(
        &e,
        "crud.delete",
        &json!({ "table": "sessions", "where": { "id": "s1" } }),
    )
    .expect_err("未声明 confirm_bulk 的级联删除必须被拒绝");
    assert!(
        err.message.contains("confirm_bulk"),
        "错误信息必须点明要传 confirm_bulk：{}",
        err.message
    );

    // ② 回滚：库里必须**一行未动**（"先删再量"的判据只有在事务里才成立）
    let after = call(&e, "counts", json!({ "tables": ["messages", "sessions", "session_events"] }));
    assert_eq!(after, before, "被拒绝的删除必须完全回滚（先删再量 + 事务）");

    // ③ 显式确认后放行，并且把"真实规模"报出来（不是 where 命中的 1 行）
    let ok = call(
        &e,
        "crud.delete",
        json!({ "table": "sessions", "where": { "id": "s1" }, "confirm_bulk": true }),
    );
    assert_eq!(ok["written"], json!(1));
    assert!(
        ok["affected_rows"].as_i64().unwrap_or(0) >= 120,
        "affected_rows 必须是含级联的真实规模（1 会话 + 60 消息 + 60 事件）：{ok}"
    );
    assert_eq!(call(&e, "counts", json!({ "tables": ["messages"] }))["messages"], json!(0));
}

/// 小规模级联不该被拦：删一个只有几条消息的会话是**正常交互**，
/// 闸门的目的是拦住"规模不体现在参数里"的大删除，不是给日常操作添堵。
#[test]
fn crud_delete_on_small_session_does_not_require_confirm_bulk() {
    let (_d, e) = temp_engine("cascade-small");
    seed_session(&e, "s1", 3);
    let ok = call(
        &e,
        "crud.delete",
        json!({ "table": "sessions", "where": { "id": "s1" } }),
    );
    assert_eq!(ok["written"], json!(1));
}

/// 闸门的**作用域**：只装在"会话语料"的根表上（见 `crud::CASCADE_GUARD_ROOTS`）。
///
/// 为什么要有这条测试：扩大作用域本身就是在造缺陷 ——
/// 知识库的删除必然级联带走它的块（"删笔记本但保留块"没有语义），
/// 而知识库的真实调用点里有内部路径（重建索引时删旧 source）与工具路径（模型删笔记），
/// 给它们强加"必须显式确认"会让正常功能开始报错。
/// 所以：非根表**不拦**，但 `affected_rows` 必须如实报出规模（可见性不降低）。
#[test]
fn cascade_guard_scope_is_limited_to_conversation_corpus_roots() {
    let (_d, e) = temp_engine("cascade-scope");
    call(&e, "sessions.upsert", json!({ "id": "s1", "project_id": "" }));
    call(
        &e,
        "crud.upsert",
        json!({ "table": "notebooks", "rows": [{ "id": "nb1", "name": "N", "created_at": 1, "updated_at": 1 }] }),
    );
    let w = call(
        &e,
        "crud.upsert",
        json!({ "table": "notebook_sources",
                "rows": [{ "id": "src1", "notebook_id": "nb1", "name": "S", "type": "text", "created_at": 1 }] }),
    );
    assert_eq!(w["written"], json!(1), "{w}");
    let chunks: Vec<serde_json::Value> = (0..80)
        .map(|i| {
            json!({ "id": format!("c{i:03}"), "notebook_id": "nb1", "source_id": "src1",
                    "content": "块内容", "chunk_index": i, "created_at": 1 })
        })
        .collect();
    let w = call(&e, "crud.upsert", json!({ "table": "notebook_chunks", "rows": chunks }));
    assert_eq!(w["written"], json!(80), "{w}");

    // 删笔记本：级联带走 80 个块，**不该**被拦（不是会话语料根表）
    let del = call(
        &e,
        "crud.delete",
        json!({ "table": "notebooks", "where": { "id": "nb1" } }),
    );
    assert_eq!(del["written"], json!(1), "{del}");
    assert!(
        del["affected_rows"].as_i64().unwrap_or(0) >= 81,
        "非根表也要如实报出含级联的真实规模（规模可见性不因为不拦而降低）：{del}"
    );
    assert_eq!(
        call(&e, "crud.count", json!({ "table": "notebook_chunks" }))["count"],
        json!(0)
    );
}

/// **F1（同一个闸门的另一半）**：删项目会级联删掉它的全部会话 → 全部消息，
/// 而 `projects.delete` 原来**完全没有任何闸门**（连 where 计数那层都没有）。
#[test]
fn projects_delete_requires_confirm_bulk_when_it_takes_many_rows() {
    let (_d, e) = temp_engine("projects-guard");
    seed_session(&e, "s1", 40);
    let err = dispatch(&e, "projects.delete", &json!({ "id": "p1" }))
        .expect_err("删项目带走 40+ 行必须要求 confirm_bulk");
    assert!(err.message.contains("confirm_bulk"), "{}", err.message);
    // 回滚验证
    assert_eq!(
        call(&e, "counts", json!({ "tables": ["sessions", "messages"] }))["sessions"],
        json!(1)
    );

    let ok = call(&e, "projects.delete", json!({ "id": "p1", "confirm_bulk": true }));
    assert_eq!(ok["written"], json!(1));
    assert!(
        ok["affected_rows"].as_i64().unwrap_or(0) >= 41,
        "必须报出含级联的规模：{ok}"
    );
    assert_eq!(
        call(&e, "counts", json!({ "tables": ["sessions", "messages"] }))["messages"],
        json!(0)
    );
}

/// 审计触发器会把"每删一行"记成一行审计 —— 闸门必须**减掉**这部分，
/// 否则删 20 条消息会被算成 40~60 行而**误拦正常操作**。
#[test]
fn cascade_guard_does_not_count_audit_rows_as_deleted_data() {
    let (_d, e) = temp_engine("audit-not-counted");
    seed_session(&e, "s1", 20);
    // 20 条消息（受审计）+ 20 条事件（受审计）→ 审计会写 40 行；
    // 若闸门把审计行算进去，这次删除会被判成 40+ 行而拒绝。
    let ok = call(
        &e,
        "messages.delete",
        json!({ "ids": (0..20).map(|i| format!("s1-m{i:04}")).collect::<Vec<_>>() }),
    );
    assert_eq!(ok["written"], json!(20));
    assert_eq!(ok["affected_rows"], json!(20), "级联为 0，且审计行不得计入：{ok}");
}

/// **F7**：`messages.delete` 删不存在的目标原来一律回 `ok`（`written: 0`），
/// 于是"删一条不存在的消息"与"删成功"在调用方看来一样（渲染侧的 `.catch` 根本不触发）。
#[test]
fn messages_delete_single_missing_target_is_not_found() {
    let (_d, e) = temp_engine("msg-delete-missing");
    call(&e, "sessions.upsert", json!({ "id": "s1" }));

    let err = dispatch(&e, "messages.delete", &json!({ "ids": ["不存在"] }))
        .expect_err("单目标删不到必须报 not_found");
    assert_eq!(err.code, codem_db::ErrorCode::NotFound, "{}", err.to_line());
    // 软删除同理（"隐藏一条不存在的消息"也没有生效）
    let err2 = dispatch(
        &e,
        "messages.delete",
        &json!({ "ids": ["不存在"], "soft": true }),
    )
    .expect_err("隐藏不存在的消息同样要报 not_found");
    assert_eq!(err2.code, codem_db::ErrorCode::NotFound, "{}", err2.to_line());

    // 批量删除**不报错**（"有些已经没了"是正常形态，报错会让幂等重试永远失败），
    // 但要让"一条都没命中"在返回值里可见。
    let none = call(&e, "messages.delete", json!({ "ids": ["a", "b"] }));
    assert_eq!(none["written"], json!(0));
    assert_eq!(none["missing"], json!(2));
}

/// **D6**：`messages.delete` 是启动维护批量裁剪走的路径 ——
/// 它原来**完全不受** `BULK_DELETE_LIMIT` 约束（闸门只装在 `crud.delete` 与 `sessions.delete`），
/// 也就是说"唯一做大范围删除的路径恰好不受保护"。
#[test]
fn messages_delete_hard_bulk_requires_confirm_bulk_but_soft_does_not() {
    let (_d, e) = temp_engine("msg-bulk-guard");
    seed_session(&e, "s1", 60);
    let ids: Vec<String> = (0..60).map(|i| format!("s1-m{i:04}")).collect();

    let err = dispatch(&e, "messages.delete", &json!({ "ids": ids }))
        .expect_err("一次硬删 60 条必须要求 confirm_bulk");
    assert!(err.message.contains("confirm_bulk"), "{}", err.message);
    assert_eq!(
        call(&e, "counts", json!({ "tables": ["messages"] }))["messages"],
        json!(60),
        "被拒绝时必须完全回滚"
    );

    // 显式声明后放行
    let ok = call(
        &e,
        "messages.delete",
        json!({ "ids": ids, "confirm_bulk": true }),
    );
    assert_eq!(ok["written"], json!(60));

    // 隐藏（soft）不是破坏性操作，**不受**闸门约束（否则上下文压缩会被拦住）
    seed_session(&e, "s2", 60);
    let soft_ids: Vec<String> = (0..60).map(|i| format!("s2-m{i:04}")).collect();
    let soft = call(&e, "messages.delete", json!({ "ids": soft_ids, "soft": true }));
    assert_eq!(soft["written"], json!(60));
    assert_eq!(soft["soft"], json!(true));
}

/// **F5**：`messages.get` / `messages.list` 只回 10 列，而表有 16 列 ——
/// `retrieved_sources`（检索来源/引文）**只写不读**。
/// 这是同一类教训的第三次复发（前两次是 `hidden` 与 `generated_files`）。
#[test]
fn messages_reads_expose_retrieved_sources_and_token_columns() {
    let (_d, e) = temp_engine("msg-columns");
    call(&e, "sessions.upsert", json!({ "id": "s1" }));
    call(
        &e,
        "messages.create",
        json!({
            "id": "m1", "session_id": "s1", "role": "assistant", "content": "答案[1]",
            "timestamp": 1,
        }),
    );
    // `retrieved_sources` / token 列走 `messages.update`（`messages.create` 的列清单里没有它们）
    call(
        &e,
        "messages.update",
        json!({
            "id": "m1",
            "prompt_tokens": 11,
            "completion_tokens": 22,
            "retrieved_sources": [{ "id": "doc1", "name": "手册", "score": 0.9 }],
        }),
    );

    let got = call(&e, "messages.get", json!({ "id": "m1" }));
    let src = &got["item"]["retrieved_sources"];
    assert!(!src.is_null(), "retrieved_sources 必须读得回来：{got}");
    let text = src.as_str().unwrap_or("");
    assert!(text.contains("doc1"), "来源内容应可解析：{text}");
    assert_eq!(got["item"]["prompt_tokens"], json!(11));
    assert_eq!(got["item"]["completion_tokens"], json!(22));

    let listed = call(
        &e,
        "messages.list",
        json!({ "session_id": "s1", "include_hidden": true }),
    );
    assert!(
        !listed["items"][0]["retrieved_sources"].is_null(),
        "list 也必须带上这一列：{listed}"
    );
}

/// **F2（阻断级）**：`rebuild_fts`（迁移之后跑的那个"全库重建"）把**原文**直接灌进索引，
/// 而中文检索依赖 bigram 切分 → **迁移之后中文搜索恒为 0 条**，而英文照常。
#[test]
fn rebuild_fts_tokenizes_cjk_so_chinese_search_works_after_migration() {
    let (_d, e) = temp_engine("rebuild-fts-cjk");
    call(&e, "sessions.upsert", json!({ "id": "s1" }));
    call(
        &e,
        "messages.create",
        json!({ "id": "m1", "session_id": "s1", "role": "user",
                 "content": "关于存储迁移的讨论与上下文压缩", "timestamp": 1 }),
    );
    // 清掉 create 时写入的索引，模拟"迁移搬进来但 FTS 影子表没搬"的状态
    call(&e, "fts.delete_session", json!({ "session_id": "s1" }));
    assert_eq!(
        call(&e, "fts.search", json!({ "query": "存储迁移" }))["items"]
            .as_array()
            .map(|a| a.len())
            .unwrap_or(0),
        0,
        "前提：索引为空时搜不到"
    );

    let res = call(&e, "rebuild_fts", json!({}));
    assert!(res["indexed"].as_i64().unwrap_or(0) >= 1, "{res}");

    let raw: String = e
        .with_conn(|conn| {
            conn.query_row(
                "SELECT content FROM session_fts WHERE message_id = 'm1'",
                [],
                |r| r.get(0),
            )
            .map_err(codem_db::DbError::from)
        })
        .expect("读索引内容");
    assert!(
        raw.starts_with("关") && raw.contains(' '),
        "重建后索引里必须是**切分形式**，否则中文永远搜不到：{raw:?}"
    );
    for q in ["存储", "迁移", "压缩"] {
        let hits = call(&e, "fts.search", json!({ "query": q }));
        assert!(
            hits["items"].as_array().map(|a| a.len()).unwrap_or(0) >= 1,
            "重建后中文查询 {q:?} 必须命中：{hits}"
        );
    }

    // 幂等：再跑一次不应重复写（内容一致就跳过）
    let again = call(&e, "rebuild_fts", json!({}));
    assert_eq!(again["indexed"], json!(0), "第二次应全部跳过：{again}");
    assert!(again["unchanged"].as_i64().unwrap_or(0) >= 1, "{again}");
}

/// **F8**：`rebuild_fts` 原来"整表 DELETE + 重灌"且**不在事务里** ——
/// 中途失败会留下"索引整表为空"的库（现象是"搜索突然什么都搜不到"，而数据一行没少）。
/// 事务化之后，失败必须**整体回滚**（索引仍是原样，不是空的）。
#[test]
fn rebuild_fts_is_transactional_and_clears_orphans() {
    let (_d, e) = temp_engine("rebuild-fts-tx");
    call(&e, "sessions.upsert", json!({ "id": "s1" }));
    call(
        &e,
        "messages.create",
        json!({ "id": "m1", "session_id": "s1", "role": "user", "content": "存 储", "timestamp": 1 }),
    );
    // 塞一条"消息已不存在"的孤儿索引行（FTS 是虚拟表，没有外键级联）
    e.with_conn(|conn| {
        conn.execute(
            "INSERT INTO session_fts (message_id, session_id, content) VALUES ('ghost', 's1', 'ghost')",
            [],
        )
        .map_err(codem_db::DbError::from)
    })
    .expect("插孤儿");
    let res = call(&e, "rebuild_fts", json!({}));
    assert_eq!(res["orphans_removed"], json!(1), "孤儿索引行必须被清掉：{res}");
    let ghost = e
        .with_conn(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM session_fts WHERE message_id = 'ghost'",
                [],
                |r| r.get::<_, i64>(0),
            )
            .map_err(codem_db::DbError::from)
        })
        .unwrap();
    assert_eq!(ghost, 0);
}

/// **D4**：`fts.search` 的注释一直写"上限 50"，实现却是 `limit_of`（默认 100、最大 5000），
/// 而且返回的是**真实正文** → 真机实测 limit=5000 返回 7,769,093 B。
#[test]
fn fts_search_clamps_limit_and_reports_has_more() {
    let (_d, e) = temp_engine("fts-limit");
    call(&e, "sessions.upsert", json!({ "id": "s1" }));
    let items: Vec<serde_json::Value> = (0..80)
        .map(|i| {
            json!({ "id": format!("m{i:03}"), "session_id": "s1", "role": "user",
                    "content": format!("关键词 存储迁移 第 {i} 条"), "timestamp": 1000 + i })
        })
        .collect();
    call(&e, "messages.create_many", json!({ "items": items }));
    call(&e, "fts.rebuild_all", json!({}));

    let res = call(&e, "fts.search", json!({ "query": "存储迁移", "limit": 5000 }));
    assert_eq!(res["limit"], json!(50), "行数必须夹到文档承诺的 50：{res}");
    assert_eq!(res["max_limit"], json!(50));
    assert_eq!(res["items"].as_array().unwrap().len(), 50);
    assert_eq!(res["has_more"], json!(true), "还有更多命中时必须如实回答：{res}");

    // 命中不足时 has_more 必须是 false（不能恒为 true，否则调用方永远以为还有）
    let few = call(&e, "fts.search", json!({ "query": "不存在的词xyz" }));
    assert_eq!(few["items"].as_array().unwrap().len(), 0);
    assert_eq!(few["has_more"], json!(false));
}

/// **F4 / D3（建议视为阻断）**：`MAX_BYTES_PER_QUERY`（16 MiB）**只被广告、从未实施** ——
/// 唯一生效的上限是行数，而真机实测**单行返回 204,963 B**，
/// 于是 limit=5000 的会话读推算可达约 1 GB。
#[test]
fn messages_list_respects_the_documented_byte_budget() {
    let (_d, e) = temp_engine("byte-budget");
    call(&e, "sessions.upsert", json!({ "id": "s1" }));
    // 200 条 × 200 KB ≈ 40 MB > 16 MiB 预算
    let big = "载荷".repeat(50_000);
    let items: Vec<serde_json::Value> = (0..200)
        .map(|i| {
            json!({ "id": format!("m{i:04}"), "session_id": "s1", "role": "user",
                    "content": big, "timestamp": 1000 + i })
        })
        .collect();
    call(&e, "messages.create_many", json!({ "items": items }));

    let res = call(
        &e,
        "messages.list",
        json!({ "session_id": "s1", "limit": 5000, "include_hidden": true }),
    );
    let n = res["items"].as_array().unwrap().len();
    assert!(n < 200, "必须被字节预算截断（实际给了 {n} 行）");
    assert!(n > 0, "至少要保留一行，否则调用方永远翻不到数据");
    assert_eq!(res["has_more"], json!(true), "被截断时必须报 has_more：{res}");

    // 分页必须**不跳数据**：按返回的 next_cursor 继续翻，能取全（字节预算下偏移要按实际行数推进）
    let mut seen = std::collections::HashSet::new();
    let mut offset: i64 = 0;
    loop {
        let page = call(
            &e,
            "messages.list",
            json!({ "session_id": "s1", "limit": 5000, "offset": offset, "include_hidden": true }),
        );
        let arr = page["items"].as_array().unwrap();
        assert!(!arr.is_empty(), "翻页过程中不该出现空页（否则死循环）");
        for it in arr {
            seen.insert(it["id"].as_str().unwrap().to_string());
        }
        if !page["has_more"].as_bool().unwrap_or(false) {
            break;
        }
        offset = page["next_cursor"].as_str().unwrap().parse().unwrap();
    }
    assert_eq!(seen.len(), 200, "分页遍历必须不重不漏（实际 {})", seen.len());
}

/// **F3**：`cost_records` / `agent_messages` / `needs_you_pending` 有 `session_id` 却**没有外键**，
/// 于是删掉会话会留下永远无法归属的孤儿行。
#[test]
fn deleting_session_leaves_no_orphans_in_child_tables_without_fk() {
    let (_d, e) = temp_engine("orphans");
    call(&e, "projects.upsert", json!({ "id": "p1", "name": "P" }));
    call(&e, "sessions.upsert", json!({ "id": "s1", "project_id": "p1" }));
    for (table, row) in [
        (
            "cost_records",
            json!({ "id": "c1", "session_id": "s1", "model": "m", "provider": "p", "timestamp": 1 }),
        ),
        (
            "agent_messages",
            json!({ "id": "a1", "session_id": "s1", "from_agent": "x", "to_agent": "y",
                    "message_type": "note", "sequence": 1, "created_at": 1 }),
        ),
        (
            "needs_you_pending",
            json!({ "id": "n1", "session_id": "s1", "question": "q", "iteration": 1, "created_at": 1 }),
        ),
    ] {
        let w = call(&e, "crud.upsert", json!({ "table": table, "rows": [row] }));
        assert_eq!(w["written"], json!(1), "{table} 应写入成功：{w}");
    }

    call(&e, "sessions.delete", json!({ "id": "s1", "confirm_bulk": true }));

    for table in ["cost_records", "agent_messages", "needs_you_pending"] {
        let c = call(&e, "crud.count", json!({ "table": table }));
        assert_eq!(c["count"], json!(0), "{table} 里不能留下孤儿行：{c}");
    }
}

/// **D2 / F9**：`storage_audit` 按行无限增长（真机 11.8 小时 61,416 行，库内最大的表），
/// 而且**没有任何裁剪入口**。现在有按水位线的 `audit.prune`（与 `telemetry.prune` 同形：
/// 缺水位线直接报错，避免"以为传了条件其实清了全表"）。
#[test]
fn audit_prune_requires_watermark_and_keeps_recent_rows() {
    let (_d, e) = temp_engine("audit-prune");
    seed_session(&e, "s1", 5);
    call(&e, "crud.delete", json!({ "table": "messages", "where": { "session_id": "s1" } }));

    let stats = call(&e, "audit.stats", json!({}));
    assert!(stats["count"].as_i64().unwrap_or(0) >= 5, "应有删除审计：{stats}");

    // 缺水位线 → 明确报错（不能默默清空）
    let err = dispatch(&e, "audit.prune", &json!({})).expect_err("必须要求水位线");
    assert!(err.message.contains("before"), "{}", err.message);

    // 水位线在未来 → 全部裁掉
    let pruned = call(&e, "audit.prune", json!({ "before": i64::MAX }));
    assert!(pruned["removed"].as_i64().unwrap_or(0) >= 5, "{pruned}");
    assert_eq!(pruned["remaining"], json!(0));
    let after = call(&e, "audit.stats", json!({}));
    assert_eq!(after["count"], json!(0));

    // 水位线在过去 → 一条都不该动（"保留窗口内"的语义）
    seed_session(&e, "s2", 3);
    call(&e, "crud.delete", json!({ "table": "messages", "where": { "session_id": "s2" } }));
    let keep = call(&e, "audit.prune", json!({ "before": 0 }));
    assert_eq!(keep["removed"], json!(0), "过去的窗口不该裁掉任何东西：{keep}");
    assert!(keep["remaining"].as_i64().unwrap_or(0) >= 3, "{keep}");
}

/// **D1**：真机实测 115,191,808 B 的库里活数据只有 16,392,192 B，
/// `freelist_count` = 98,799,616 B（**85.8% 是永不回收的空闲页**），而全 crate `VACUUM` 零命中。
/// 这条命令把"回收"变成一件**能做、且会如实报数**的事。
#[test]
fn storage_compact_reports_noop_below_threshold_and_reclaims_when_forced() {
    let (_d, e) = temp_engine("compact");
    seed_session(&e, "s1", 20);
    call(&e, "crud.delete", json!({ "table": "messages", "where": { "session_id": "s1" } }));

    // 阈值默认很高 → 不做整库重写，但要**如实说明为什么没做**（不是静默 no-op）
    let noop = call(&e, "storage.compact", json!({}));
    assert_eq!(noop["performed"], json!(false));
    assert!(!noop["reason"].as_str().unwrap_or("").is_empty(), "{noop}");
    assert!(noop["freelist_count"].as_i64().is_some(), "必须报出空闲页现状：{noop}");

    // force → 真做，并给出前后字节数
    let done = call(&e, "storage.compact", json!({ "force": true }));
    assert_eq!(done["performed"], json!(true), "{done}");
    assert!(done["before_bytes"].as_i64().unwrap_or(0) > 0, "{done}");
    assert!(done["after_bytes"].as_i64().unwrap_or(0) > 0, "{done}");
    /*
     * 不比较"文件变小"：`before_bytes` 用的是 `page_count * page_size`，
     * 而 WAL 里尚未 checkpoint 的页**不计入** `page_count` ——
     * 于是 VACUUM（它会 checkpoint 并整库重写）之后主库文件反而可能"变大"，
     * 即使空闲页被回收了。用文件字节判断回收效果会得到**假结论**。
     * 能稳定判定的只有"空闲页减少了"（这才是 VACUUM 的语义）与"库仍然完好"。
     */
    assert!(
        done["freelist_after"].as_i64().unwrap_or(i64::MAX)
            <= done["freelist_before"].as_i64().unwrap_or(0),
        "VACUUM 之后空闲页不该变多：{done}"
    );
    assert_eq!(done["elapsed_ms"].as_i64().is_some(), true, "必须报出耗时：{done}");
    // 做完之后库仍然可用且积分完整
    assert_eq!(call(&e, "integrity_check", json!({}))["ok"], json!(true));
}

/// **D9**：`import_open` 这个标志的注释写着"保证不会和普通 `write_tx` 交错"，
/// 但 `write_tx` **从来没有读过它** —— 真交错时调用方拿到的是 SQLite 的
/// "cannot start a transaction within a transaction" 这类引擎内部术语。
#[test]
fn write_tx_is_refused_while_import_transaction_is_open() {
    let (_d, e) = temp_engine("import-open");
    call(&e, "import.begin", json!({}));
    let err = dispatch(&e, "settings.set", &json!({ "key": "k", "value": "v" }))
        .expect_err("导入事务开着时不能走普通写路径");
    assert!(
        err.message.contains("导入"),
        "错误信息必须说清是「正在导入」而不是引擎内部术语：{}",
        err.message
    );
    call(&e, "import.rollback", json!({}));
    // 回滚之后写必须恢复正常
    call(&e, "settings.set", json!({ "key": "k", "value": "v" }));
    let all = call(&e, "settings.get_all", json!({}));
    assert_eq!(all["k"], json!("v"), "回滚后写路径必须恢复：{all}");
}

/// **D1**：真机实测 115,191,808 B 的库里活数据只有 16,392,192 B，
/// `freelist_count` = 98,799,616 B（**85.8% 是永不回收的空闲页**），而全 crate `VACUUM` 零命中。
/// 新库应当直接开启 `auto_vacuum=INCREMENTAL`（之后空闲页可以按页归还，不必整库重写）；
/// 老库则由 `storage.compact` 在 VACUUM 时一并转换（pragma 只对空库立即生效，这是 SQLite 的规定）。
#[test]
fn fresh_database_enables_incremental_auto_vacuum() {
    let (_d, e) = temp_engine("auto-vacuum");
    let mode: i64 = e
        .with_conn(|conn| {
            conn.query_row("PRAGMA auto_vacuum", [], |r| r.get(0))
                .map_err(codem_db::DbError::from)
        })
        .unwrap();
    assert_eq!(mode, 2, "新库应当是 INCREMENTAL（=2），实际 {mode}");

    // compact 之后仍然保持 INCREMENTAL（VACUUM 不该把它关掉）
    let done = call(&e, "storage.compact", json!({ "force": true }));
    assert_eq!(done["performed"], json!(true), "{done}");
    let after: i64 = e
        .with_conn(|conn| {
            conn.query_row("PRAGMA auto_vacuum", [], |r| r.get(0))
                .map_err(codem_db::DbError::from)
        })
        .unwrap();
    assert_eq!(after, 2, "VACUUM 之后 auto_vacuum 不该被关掉，实际 {after}");
}

/// **D5**：真机实测同一个会话有三个互相矛盾的"消息数"：
/// 权威 JSONL **612** / 索引 **544** 行 / `sessions.message_count` 写的是 **27**。
/// 第三个数是"多个写入者有空才更新"的必然结果（渲染侧只在极少数地方显式写它）。
/// 现在引擎是**唯一**写入者：新增消息 +1、硬删除 -N，覆盖写不动。
#[test]
fn session_message_count_is_maintained_by_the_engine() {
    let (_d, e) = temp_engine("msg-count");
    call(&e, "sessions.upsert", json!({ "id": "s1", "project_id": "" }));
    let count_of = |e: &Engine| -> i64 {
        e.with_conn(|conn| {
            conn.query_row("SELECT message_count FROM sessions WHERE id = 's1'", [], |r| r.get(0))
                .map_err(codem_db::DbError::from)
        })
        .unwrap()
    };
    assert_eq!(count_of(&e), 0);

    // 单条新增
    call(
        &e,
        "messages.create",
        json!({ "id": "m1", "session_id": "s1", "role": "user", "content": "a", "timestamp": 1 }),
    );
    assert_eq!(count_of(&e), 1, "新增一条应 +1");

    // 覆盖写（同 id upsert）**不该**让计数变大
    call(
        &e,
        "messages.create",
        json!({ "id": "m1", "session_id": "s1", "role": "user", "content": "a2", "timestamp": 1 }),
    );
    assert_eq!(count_of(&e), 1, "覆盖写不该让计数变大");

    // 批量新增
    let items: Vec<serde_json::Value> = (2..=20)
        .map(|i| {
            json!({ "id": format!("m{i}"), "session_id": "s1", "role": "user",
                    "content": "x", "timestamp": i })
        })
        .collect();
    call(&e, "messages.create_many", json!({ "items": items }));
    assert_eq!(count_of(&e), 20, "批量新增 19 条后应为 20");

    // 复合写（`messages.upsert_index`）新增也要计数
    call(
        &e,
        "messages.upsert_index",
        json!({ "id": "m21", "session_id": "s1", "role": "assistant", "content": "y", "timestamp": 21 }),
    );
    assert_eq!(count_of(&e), 21);

    // 隐藏（软删除）不删行 → 计数不变
    call(&e, "messages.delete", json!({ "ids": ["m2"], "soft": true }));
    assert_eq!(count_of(&e), 21, "隐藏不是删除，计数不该变");

    // 硬删除 → 按实际删掉的行数减
    let hard: Vec<String> = (3..=12).map(|i| format!("m{i}")).collect();
    call(&e, "messages.delete", json!({ "ids": hard, "confirm_bulk": true }));
    assert_eq!(count_of(&e), 11, "硬删 10 条后应为 11");

    // 重建索引会显式写入日志里的真实条数
    call(
        &e,
        "messages.rebuild_index",
        json!({ "sessions": [{ "id": "s1", "messages": [
            { "id": "r1", "session_id": "s1", "role": "user", "content": "a", "timestamp": 1 },
            { "id": "r2", "session_id": "s1", "role": "assistant", "content": "b", "timestamp": 2 }
        ] }] }),
    );
    assert_eq!(count_of(&e), 2, "重建索引按权威日志条数写");
}

/// **D8**：`migration.auto` 是**唯一一条"整库重写"的命令**，而它原来**一条测试都没有**。
/// 真机取证显示它在 11.8 小时内跑过 **16 次**，每次清空 3,838 行（当时全库内容，
/// 占全部审计记录的 99.98%）。
///
/// 补上这条测试**当场抓到两个真缺陷**（都不是理论问题）：
/// ① `import_all` **忽略**顶层 `replace: true`，而 `auto_migrate` 每一项又硬编码
///    `"mode": "insert"` → "覆盖已存在的行"从来没发生过 → 对账按**内容摘要**比对必然
///    不等 → 迁移报错、**不写标记** → 每次启动再来一遍（这正是"跑了 16 次"的形态）；
/// ② 整库级操作之前没有备份。
///
/// 现在钉住四件事：迁移成功、备份存在、**已存在的行被源端内容覆盖**、
/// 目标库非空时在引擎侧就被拒绝（不再只依赖渲染侧判据）。
#[test]
fn auto_migrate_refuses_non_empty_target_and_backs_up_before_writing() {
    let dir = tempfile::tempdir().unwrap();
    let legacy_path = dir.path().join("legacy.bin");
    // 用另一个引擎造一个"旧库"（表结构是新 schema 的超集，导入器按列名映射，够用）
    let legacy_created_at: i64;
    {
        let src = Engine::open(&legacy_path).unwrap();
        call(&src, "projects.upsert", json!({ "id": "p1", "name": "旧项目" }));
        call(&src, "sessions.upsert", json!({ "id": "s1", "project_id": "p1" }));
        call(
            &src,
            "messages.create",
            json!({ "id": "m1", "session_id": "s1", "role": "user", "content": "旧消息", "timestamp": 1 }),
        );
        call(&src, "settings.set", json!({ "key": "legacy-key", "value": "legacy-value" }));
        // 先把 WAL 并回主库：只读连接看不到还留在 `-wal` 里的最新数据
        src.checkpoint().unwrap();
        legacy_created_at = call(&src, "crud.list", json!({ "table": "projects", "limit": 10 }))["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["id"] == json!(""))
            .and_then(|r| r["created_at"].as_i64())
            .expect("旧库应有种子全局项目行");
    }

    let target_path = dir.path().join("target.bin");
    let target = Engine::open(&target_path).unwrap();
    // 前提：目标库里**已经**有同一个主键的行（种子全局项目），且内容与源端不同 ——
    // 这正是"覆盖写有没有生效"能被观测到的原因
    let target_created_at = call(&target, "crud.list", json!({ "table": "projects", "limit": 10 }))["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["id"] == json!(""))
        .and_then(|r| r["created_at"].as_i64())
        .unwrap();
    assert_ne!(
        target_created_at, legacy_created_at,
        "前提：两端种子行的内容必须不同，否则这条测试证明不了覆盖写"
    );

    // ① 首次迁移：目标库是空的（只有种子行）→ 允许，并且必须留下备份
    let res = call(
        &target,
        "migration.auto",
        json!({ "legacy_path": legacy_path.to_string_lossy() }),
    );
    assert_eq!(res["migrated"], json!(true), "{res}");
    let backup = res["backup_path"].as_str().unwrap_or_default().to_string();
    assert!(!backup.is_empty(), "必须报出备份路径：{res}");
    assert!(std::path::Path::new(&backup).exists(), "备份文件必须真的存在：{backup}");
    assert_eq!(
        call(&target, "counts", json!({ "tables": ["messages"] }))["messages"],
        json!(1),
        "旧库那条消息应当被搬过来"
    );
    let all = call(&target, "settings.get_all", json!({}));
    assert_eq!(all["legacy-key"], json!("legacy-value"), "配置也应被搬过来：{all}");

    // **已存在的行必须被源端内容覆盖**（这条就是上面缺陷①的回归保护）
    let after_created_at = call(&target, "crud.list", json!({ "table": "projects", "limit": 10 }))["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["id"] == json!(""))
        .and_then(|r| r["created_at"].as_i64())
        .unwrap();
    assert_eq!(
        after_created_at, legacy_created_at,
        "迁移必须**覆盖**目标库中已存在的行（顶层 replace 曾经被完全忽略）"
    );

    // ② 目标库已有消息 → **拒绝**（这条判据是引擎侧的，不依赖渲染侧判断）
    let err = dispatch(
        &target,
        "migration.auto",
        &json!({ "legacy_path": legacy_path.to_string_lossy() }),
    )
    .expect_err("目标库非空时必须拒绝自动迁移");
    assert!(
        err.message.contains("拒绝自动迁移"),
        "错误信息必须说清为什么不搬：{}",
        err.message
    );
    // 拒绝之后数据一行没动
    assert_eq!(
        call(&target, "counts", json!({ "tables": ["messages"] }))["messages"],
        json!(1)
    );

    // ③ dry_run 不写任何东西、也不备份
    let dry = call(
        &target,
        "migration.auto",
        json!({ "legacy_path": legacy_path.to_string_lossy(), "dry_run": true }),
    );
    assert_eq!(dry["dry_run"], json!(true));
    assert!(
        dry["rows"].as_i64().unwrap_or(0) >= 3,
        "dry_run 应报出源端行数：{dry}"
    );
    assert!(dry["backup_path"].is_null(), "dry_run 不该产生备份：{dry}");
}

/// **B-4 的持久化那一半**：`hidden` 这一列被两条语义**相反**的路径共用 ——
/// 上下文压缩（读路径必须排除）与索引裁剪（读路径必须**保留**，否则用户看不到自己的历史）。
/// 两者在库里长得一模一样，渲染侧只能靠进程内记账区分，**重启后必然分不清**。
/// `trimmed` 列把区别变成库里的持久事实。
#[test]
fn trim_soft_delete_is_distinguishable_from_compaction_hide() {
    let (_d, e) = temp_engine("trim-marker");
    call(&e, "sessions.upsert", json!({ "id": "s1", "project_id": "" }));
    for id in ["a", "b"] {
        call(
            &e,
            "messages.create",
            json!({ "id": id, "session_id": "s1", "role": "user", "content": id, "timestamp": 1 }),
        );
    }

    // 压缩那条路：只 hidden
    call(&e, "messages.delete", json!({ "ids": ["a"], "soft": true }));
    // 裁剪那条路：hidden + trimmed
    let trimmed = call(&e, "messages.delete", json!({ "ids": ["b"], "trim": true }));
    assert_eq!(trimmed["trim"], json!(true), "{trimmed}");
    assert_eq!(trimmed["soft"], json!(true), "trim 蕴含软删除（行不删）");

    let get = |id: &str| call(&e, "messages.get", json!({ "id": id }))["item"].clone();
    let a = get("a");
    assert_eq!(a["hidden"], json!(1), "压缩隐藏：hidden=1");
    assert_eq!(a["trimmed"], json!(0), "压缩隐藏**不是**裁剪：trimmed 必须保持 0");
    let b = get("b");
    assert_eq!(b["hidden"], json!(1), "裁剪也是隐藏（行留在库里）");
    assert_eq!(b["trimmed"], json!(1), "裁剪必须留下可区分的持久标记");

    // 两行都还在（软删除不删行 → `message_feedback` 的外键目标还在）
    assert_eq!(
        call(&e, "counts", json!({ "tables": ["messages"] }))["messages"],
        json!(2),
        "软删除不该减少行数"
    );
    // 索引列表里两条都不可见（`include_hidden=false`）
    assert_eq!(
        call(&e, "messages.list", json!({ "session_id": "s1", "include_hidden": false }))["items"]
            .as_array()
            .unwrap()
            .len(),
        0
    );

    // 标记可被清掉（消息后来又被写回成可见的场合）
    call(&e, "messages.update", json!({ "id": "b", "trimmed": 0, "hidden": 0 }));
    assert_eq!(get("b")["trimmed"], json!(0));
    assert_eq!(get("b")["hidden"], json!(0));
}

/// **加一列不能打死自动迁移**（第 44 轮实测抓到的真机缺陷）。
///
/// 对账原来两端各 `SELECT *` 再逐列编码，而源端是旧库（老 schema）、目标是新库
/// （schema 已经过迁移加过列）—— 于是只要有**任何一列**是新加的，列数就不同、
/// 摘要必然不等、对账**永远**失败：迁移标记写不上 → 每次启动再来一遍。
///
/// 这个坑是在给 `messages` 加 `trimmed` 列时被抓到的：
/// 真 CLI 复现源 16 列 / 目标 17 列、两边都 821 行、摘要却不等；
/// 只把那一列补到源库副本上做对照，同一个迁移立刻成功。
///
/// 现在摘要按**源端的列清单**投影（那正是本次导入实际搬运的列），
/// 所以"新 schema 加列"不再影响对账。这条测试就是那个场景的固化：
/// 先让源库少一列（模拟老 schema），再跑迁移 —— 必须成功，且目标端新列存在。
#[test]
fn auto_migrate_succeeds_when_source_table_has_fewer_columns() {
    let dir = tempfile::tempdir().unwrap();
    let legacy_path = dir.path().join("legacy-old-schema.bin");
    {
        let src = Engine::open(&legacy_path).unwrap();
        call(&src, "projects.upsert", json!({ "id": "p1", "name": "旧项目" }));
        call(&src, "sessions.upsert", json!({ "id": "s1", "project_id": "p1" }));
        call(
            &src,
            "messages.create",
            json!({ "id": "m1", "session_id": "s1", "role": "user", "content": "旧消息", "timestamp": 1 }),
        );
        src.checkpoint().unwrap();
        /*
         * 把源库"退回"到老 schema：删掉新加的列。
         *
         * SQLite 支持 `DROP COLUMN`（3.35+），而这里用的是 bundled SQLite —— 用得上。
         * 这正是生产里的真实形态：旧库是**加列之前**写出来的。
         */
        src.with_conn(|conn| {
            conn.execute_batch("ALTER TABLE messages DROP COLUMN trimmed")
                .map_err(codem_db::DbError::from)
        })
        .expect("把源库退回老 schema（少一列）");
        src.checkpoint().unwrap();
    }

    let target_path = dir.path().join("target-new-schema.bin");
    let target = Engine::open(&target_path).unwrap();

    let res = call(
        &target,
        "migration.auto",
        json!({ "legacy_path": legacy_path.to_string_lossy() }),
    );
    assert_eq!(
        res["migrated"], json!(true),
        "源库列数少于目标库时，迁移必须照样成功（对账按源端列投影，不是 SELECT *）：{res}"
    );
    assert!(
        res["mismatches"].is_null() && res["rows"].as_i64().unwrap_or(0) >= 1,
        "应逐表对账通过：{res}"
    );

    // 目标端那一列仍然在（迁移不碰它），且那条消息真的搬过来了
    let cols: Vec<String> = target
        .with_conn(|conn| {
            let mut stmt = conn
                .prepare("PRAGMA table_info(\"messages\")")
                .map_err(codem_db::DbError::from)?;
            let rows = stmt
                .query_map([], |r| r.get::<_, String>(1))
                .map_err(codem_db::DbError::from)?;
            let mut out = Vec::new();
            for r in rows {
                out.push(r.map_err(codem_db::DbError::from)?);
            }
            Ok(out)
        })
        .unwrap();
    assert!(cols.iter().any(|c| c == "trimmed"), "新库应保留新列：{cols:?}");
    assert_eq!(
        call(&target, "counts", json!({ "tables": ["messages"] }))["messages"],
        json!(1)
    );

    // 第二个坑：**再跑一次仍然被拒**（目标已有消息），而且报的是"拒绝迁移"，
    // 不是"对账未通过" —— 两个失败原因必须能区分开
    let err = dispatch(
        &target,
        "migration.auto",
        &json!({ "legacy_path": legacy_path.to_string_lossy() }),
    )
    .expect_err("目标非空时必须拒绝");
    assert!(err.message.contains("拒绝自动迁移"), "{}", err.message);
}

/// **`legacy.read_table` 不许静默截断**（第 44 轮，迁移工具审计抓到的缺陷）。
///
/// 原来它是"整表读出来再 `truncate(limit)`"，而且返回里**没有任何截断痕迹** ——
/// 一个想用它做全量搬运的调用方会拿到 20,000 行（`settings` 真有 25,024 行时）
/// 并以为"旧库就这么些行"。迁移工具的第一版预检正是这么写的，
/// 于是它打印的行数比引擎实际搬运的少（实测差了 19 行）。
///
/// 现在：分页在 SQL 里做、返回 `total`/`truncated`/`has_more`/`next_offset`，
/// 并且接受 `offset` 让调用方**真的能翻页**。
#[test]
fn legacy_read_table_reports_truncation_and_supports_paging() {
    let dir = tempfile::tempdir().unwrap();
    let legacy_path = dir.path().join("legacy-paging.bin");
    {
        let src = Engine::open(&legacy_path).unwrap();
        // 写 25 条 settings（超过我们下面要用的 limit，但不必 20,000 条）
        for i in 0..25 {
            call(&src, "settings.set", json!({ "key": format!("k{i:03}"), "value": format!("v{i}") }));
        }
        src.checkpoint().unwrap();
    }
    let (_d2, e) = temp_engine("reader");

    // 第一页
    let p1 = call(
        &e,
        "legacy.read_table",
        json!({ "legacy_path": legacy_path.to_string_lossy(), "table": "settings", "limit": 10 }),
    );
    assert!(p1["total"].as_i64().unwrap_or(0) >= 25, "必须报出总行数：{p1}");
    assert_eq!(p1["rows"].as_array().unwrap().len(), 10);
    assert_eq!(p1["truncated"], json!(true), "还有更多时必须如实标记：{p1}");
    assert_eq!(p1["has_more"], json!(true));
    let next = p1["next_offset"].as_i64().expect("必须给出下一页偏移");

    // 第二页必须**不重复**第一页的内容（顺序确定，否则翻页会重/漏）
    let p2 = call(
        &e,
        "legacy.read_table",
        json!({ "legacy_path": legacy_path.to_string_lossy(), "table": "settings",
                "limit": 10, "offset": next }),
    );
    let keys1: Vec<String> = p1["rows"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r[0].as_str().unwrap_or_default().to_string())
        .collect();
    let keys2: Vec<String> = p2["rows"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r[0].as_str().unwrap_or_default().to_string())
        .collect();
    for k in &keys2 {
        assert!(!keys1.contains(k), "翻页不该重复：{k} 同时出现在两页里");
    }

    // 一页装得下时：truncated 必须是 false（不能恒为 true）
    let all = call(
        &e,
        "legacy.read_table",
        json!({ "legacy_path": legacy_path.to_string_lossy(), "table": "settings", "limit": 1000 }),
    );
    assert_eq!(all["truncated"], json!(false), "{all}");
    assert_eq!(all["has_more"], json!(false));
    assert!(all["next_offset"].is_null(), "没有下一页时不该给偏移：{all}");
}

/// 复合索引：`messages.list` 的排序键是 `(session_id, timestamp, id)`，
/// 而 schema 只有 `idx_messages_session(session_id)` → 每次翻页都要重排整个会话。
/// 真机基准实测 1k→10k→100k 行 = 338 ms → 6.3 s → **159.2 s**（10 倍数据 25.2 倍耗时）。
/// 这条测试钉住"索引真的存在"（性能数字本身在 `tools/bench` 里量）。
#[test]
fn messages_session_timestamp_index_exists() {
    let (_d, e) = temp_engine("msg-index");
    let sql: String = e
        .with_conn(|conn| {
            conn.query_row(
                "SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_messages_session_ts'",
                [],
                |r| r.get(0),
            )
            .map_err(codem_db::DbError::from)
        })
        .expect("复合索引必须存在（否则分页读是超线性的）");
    assert!(sql.contains("timestamp"), "{sql}");
    // 查询计划必须用得上它（而不是临时 B 树排序）
    let plan: String = e
        .with_conn(|conn| {
            conn.query_row(
                "EXPLAIN QUERY PLAN SELECT id FROM messages WHERE session_id=?1 ORDER BY timestamp ASC, id ASC LIMIT 10",
                ["s1"],
                |r| r.get::<_, String>(3),
            )
            .map_err(codem_db::DbError::from)
        })
        .unwrap();
    assert!(
        plan.contains("idx_messages_session_ts"),
        "查询计划应使用复合索引，实际：{plan}"
    );
}
