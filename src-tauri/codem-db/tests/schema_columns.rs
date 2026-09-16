//! **列级** schema 契约：建一个全新库，逐表逐列比对"渲染侧 TS 真源声明的列"。
//!
//! ## 为什么必须有这一项（而不是只比对文件）
//!
//! `npm run audit:schema-parity` 比的是 **`schema.sql` 这个文件**有没有被重新生成过。
//! 它是"生成物没被手改"的证据，**不是"库能接受真源声明的所有列"的证据**：
//!
//! - 真源（`src/core/storage/database.ts`）里有一半列是后来用
//!   `ALTER TABLE … ADD COLUMN` 加上去的（23 条）；`schema.sql` 里根本不含这些列。
//! - 运行期靠 `schema::apply()` 的迁移把列补齐 —— 这段逻辑**没有任何门禁覆盖**。
//!   一旦 `migrations.json` 生成漏一条、或迁移被 `migrations_ignored` 静默吞掉，
//!   表现是"渲染侧写入某列失败/静默丢列"，而门禁全绿。
//!
//! 本测试直接从**真源 TS 文本**里解析出「每张表应有的列」，全部走一遍
//! `PRAGMA table_info`，再逐列核对。缺表、缺列都会在这里失败。
//!
//! 注意这里**不写**具体列名字面量：清单来自真源，真源改了就自动跟着变；
//! 需要人工判断的地方只有"解析失败"（解析不到 CREATE TABLE 会直接 panic，不会静默通过）。

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

/// 仓库根目录（本文件在 `src-tauri/codem-db/tests/` 下）
fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|p| p.parent())
        .expect("CARGO_MANIFEST_DIR 应有 ../../ 前缀")
        .to_path_buf()
}

fn real_source() -> String {
    let p = repo_root().join("src").join("core").join("storage").join("database.ts");
    std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("读不到真源 {}：{e}", p.display()))
}

/// `const SCHEMA = \`…\`;` 里的 DDL 文本
fn schema_ddl(src: &str) -> String {
    let start = src.find("const SCHEMA").expect("真源里找不到 SCHEMA 定义");
    let open = src[start..].find('`').expect("SCHEMA 不是模板字符串") + start;
    let close = src[open + 1..].find('`').expect("SCHEMA 模板字符串没有结束反引号") + open + 1;
    src[open + 1..close].to_string()
}

/// 从 DDL 里解析 `CREATE TABLE IF NOT EXISTS x ( 列 类型, … )`，得到「表 → 列集合」
///
/// 只做够用的解析：按行切、去掉约束行（PRIMARY KEY / FOREIGN KEY / UNIQUE / CHECK / CONSTRAINT），
/// 列名取每行第一个标识符。解析出的表数为 0 会 panic —— 静默通过是最坏的结果。
fn ddl_columns(ddl: &str) -> BTreeMap<String, BTreeSet<String>> {
    let mut out: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut current: Option<String> = None;
    for raw_line in ddl.lines() {
        let line = raw_line.trim();
        let upper = line.to_uppercase();
        if upper.starts_with("CREATE TABLE") {
            // 形如 `CREATE TABLE IF NOT EXISTS notebooks (` —— 表名是开括号前的最后一个词
            let head = line.split('(').next().unwrap_or(line);
            let name = head
                .split_whitespace()
                .last()
                .unwrap_or("")
                .trim()
                .trim_matches(|c| c == '"' || c == '`' || c == '[')
                .to_string();
            assert!(!name.is_empty(), "解析不出表名：{line}");
            out.entry(name.clone()).or_default();
            current = Some(name);
            continue;
        }
        if line.starts_with(')') {
            current = None;
            continue;
        }
        let Some(table) = current.clone() else { continue };
        if line.is_empty() {
            continue;
        }
        let kw = upper.split_whitespace().next().unwrap_or("");
        if matches!(kw, "PRIMARY" | "FOREIGN" | "UNIQUE" | "CHECK" | "CONSTRAINT") {
            continue;
        }
        let Some(col) = line.split_whitespace().next() else { continue };
        let col = col.trim_matches(|c| c == '"' || c == '`' || c == '[');
        if col.is_empty() {
            continue;
        }
        out.entry(table).or_default().insert(col.to_string());
    }
    assert!(!out.is_empty(), "从 DDL 里一张表都没解析出来（真源结构变了？）");
    out
}

/// 从真源里解析 `ALTER TABLE x ADD COLUMN y …` 迁移语句，得到「表 → 列集合」
fn migration_columns(src: &str) -> BTreeMap<String, BTreeSet<String>> {
    let start = src.find("const migrations").expect("真源里找不到 migrations 定义");
    let open = src[start..].find('[').expect("migrations 不是数组") + start;
    let close = src[open..].find("];").expect("migrations 数组没有结束") + open;
    let body = &src[open..close];

    let mut out: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for stmt in body.split('"').filter(|s| s.to_uppercase().contains("ALTER TABLE")) {
        let toks: Vec<&str> = stmt.split_whitespace().collect();
        // ALTER TABLE <t> ADD COLUMN <c> …
        let ti = toks
            .iter()
            .position(|t| t.eq_ignore_ascii_case("TABLE"))
            .expect("ALTER TABLE 语句里没有 TABLE");
        let ci = toks
            .iter()
            .position(|t| t.eq_ignore_ascii_case("COLUMN"))
            .expect("ALTER TABLE 语句里没有 COLUMN");
        let table = toks.get(ti + 1).expect("ALTER TABLE 后面没有表名");
        let col = toks.get(ci + 1).expect("ADD COLUMN 后面没有列名");
        out.entry(table.to_string())
            .or_default()
            .insert(col.trim_matches(|c| c == '"' || c == '`').to_string());
    }
    assert!(!out.is_empty(), "从真源里没解析出任何 ALTER TABLE 迁移");
    out
}

#[test]
fn fresh_db_accepts_every_column_the_ts_source_declares() {
    let src = real_source();
    let from_ddl = ddl_columns(&schema_ddl(&src));
    let from_migrations = migration_columns(&src);

    // 临时库（进程退出后由 TempDir 语义外的显式删除处理）
    let dir = std::env::temp_dir().join(format!("codem-schema-cols-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("建临时目录失败");
    let path = dir.join("fresh.bin");
    let _ = std::fs::remove_file(&path);

    let engine = codem_db::Engine::open(&path).expect("打开（新建）库失败");
    let report = engine.schema_report();
    assert!(report.fresh, "应当是新建库（临时路径不该有旧文件）");

    // `migrations_ignored` 只允许来自"该列已在 CREATE TABLE 里"（重叠是正常的：
    // 老库靠 ALTER 加列，新库的 CREATE TABLE 里也写了这些列）。
    // 这里不去硬编码条数（写死的数字只会变成下一个需要维护的常量），
    // 而是核对"被忽略的条数"确实等于"与 CREATE TABLE 重叠的迁移条数"。
    let overlapping = from_migrations
        .iter()
        .map(|(t, cols)| match from_ddl.get(t) {
            Some(base) => cols.iter().filter(|c| base.contains(*c)).count(),
            None => 0,
        })
        .sum::<usize>();
    assert_eq!(
        report.migrations_ignored, overlapping,
        "被忽略的迁移条数应当正好等于与 CREATE TABLE 重叠的列数（真源/生成物不一致？）"
    );
    assert!(
        report.migrations > 0 && report.migrations == from_migrations.values().map(|c| c.len()).sum::<usize>(),
        "migrations.json 的条数与真源里 ALTER TABLE 的条数不一致"
    );

    // 期望 = CREATE TABLE 的列 ∪ 迁移加的列
    let mut expected = from_ddl.clone();
    for (table, cols) in &from_migrations {
        let entry = expected.entry(table.clone()).or_default();
        for c in cols {
            entry.insert(c.clone());
        }
    }

    let mut problems: Vec<String> = Vec::new();
    engine
        .with_conn(|conn| {
            for (table, want) in &expected {
                let mut stmt = conn
                    .prepare("SELECT name FROM pragma_table_info(?1)")
                    .map_err(codem_db::DbError::from)?;
                let got: BTreeSet<String> = stmt
                    .query_map([table], |r| r.get::<_, String>(0))
                    .map_err(codem_db::DbError::from)?
                    .filter_map(Result::ok)
                    .collect();
                if got.is_empty() {
                    problems.push(format!("缺表：{table}（真源声明了它）"));
                    continue;
                }
                for col in want {
                    if !got.contains(col) {
                        problems.push(format!("{table} 缺列：{col}"));
                    }
                }
            }
            Ok(())
        })
        .expect("遍历表结构失败");

    let _ = std::fs::remove_dir_all(&dir);

    assert!(
        problems.is_empty(),
        "真源声明的表/列在新建库里不存在（共 {} 项）：\n  {}",
        problems.len(),
        problems.join("\n  ")
    );
}

#[test]
fn every_migration_column_lands_even_on_a_fresh_database() {
    // 这一项盯的是"迁移被静默吞掉"：ignored 只允许出现在**列已存在于 CREATE TABLE** 的情况，
    // 不允许出现"执行成功但列没加上"。
    let src = real_source();
    let hard = migration_columns(&src);
    let soft: BTreeSet<String> = ddl_columns(&schema_ddl(&src))
        .into_iter()
        .map(|(t, c)| format!("{t}.{}", c.iter().next().unwrap_or(&String::new())))
        .collect();
    assert!(!soft.is_empty());

    let dir = std::env::temp_dir().join(format!("codem-schema-mig-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("建临时目录失败");
    let path = dir.join("fresh.bin");
    let _ = std::fs::remove_file(&path);
    let engine = codem_db::Engine::open(&path).expect("打开（新建）库失败");

    let mut missing: Vec<String> = Vec::new();
    engine
        .with_conn(|conn| {
            for (table, cols) in &hard {
                let mut stmt = conn
                    .prepare("SELECT name FROM pragma_table_info(?1)")
                    .map_err(codem_db::DbError::from)?;
                let got: BTreeSet<String> = stmt
                    .query_map([table], |r| r.get::<_, String>(0))
                    .map_err(codem_db::DbError::from)?
                    .filter_map(Result::ok)
                    .collect();
                for col in cols {
                    if !got.contains(col) {
                        missing.push(format!("{table}.{col}"));
                    }
                }
            }
            Ok(())
        })
        .expect("遍历表结构失败");

    let _ = std::fs::remove_dir_all(&dir);
    assert!(missing.is_empty(), "迁移声明的列没落到库里：{missing:?}");
}
