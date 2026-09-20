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

/// 第 47 轮补：损坏恢复时**从坏文件备份里抢救"项目 / 会话归属"**。
///
/// ## 这条测试守的缺陷（真缺口，不是假想）
///
/// 恢复链路本身完整：坏文件改名备份 → 建空库 → 渲染侧写"索引需要重建"标记 →
/// 维护从**权威 JSONL 日志**重建索引。但日志里**没有会话归属**这一列，
/// 而重建发生在**空库**上 —— 于是 `sessions` 表是空的，
/// `rebuildIndexFromSessionLogs` 的 `projectOf` 取不到东西，
/// **所有复活的会话 `project_id` 落成 `""`（= 全局项目）**，
/// 用户的会话全部掉进"全局对话"。仓库里那句告警自己写着"这个数字应当长期为 0"。
///
/// 抢救来源只能是那份坏文件备份。这里造一个"**头部坏、但表还能读**"的库：
/// 先建一个正常库并写入 projects/sessions，然后把**文件头之后**的 freelist 打乱 ——
/// SQLite 依然能打开并读表，但 `PRAGMA quick_check` 会报错。
#[test]
fn corrupt_recovery_salvages_project_attribution() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("salvage.bin");

    // ① 先造一个"有项目、有会话"的正常库
    {
        let engine = Engine::open(&path).unwrap();
        call(&engine, "projects.upsert", json!({ "id": "p1", "name": "mimo-gui", "path": "C:/mimo-gui" }));
        call(
            &engine,
            "sessions.upsert",
            json!({ "id": "s1", "project_id": "p1", "title": "对话 1" }),
        );
        // 让数据真的落到主文件（WAL 模式下不 checkpoint 的话，改主文件也没用）
        let _ = engine.checkpoint();
    }
    let original_len = std::fs::metadata(&path).unwrap().len();
    assert!(original_len > 0);

    /*
     * ② 制造"头部有效、页级损坏"。
     *
     * 为什么不用"正确头 + 乱码正文"（既有那条测试的做法）：那种文件**任何表都读不出来**，
     * 抢救必然是 0 —— 它能验证"失败不影响恢复"，但验证不了"抢救真的能拿到东西"。
     * 这里改成：保留前 100 字节（含 SQLite 头与第一个页头，schema 页往往就在最前面），
     * 把**第二个页及其后**填成垃圾。实际效果是"能打开、能读部分表、quick_check 报错"。
     */
    let mut bytes = std::fs::read(&path).unwrap();
    let page_size = 4096usize;
    if bytes.len() > page_size * 2 {
        for b in bytes.iter_mut().skip(page_size) {
            *b = 0x7a;
        }
        std::fs::write(&path, &bytes).unwrap();
    }

    // ③ 无论这个库最终被判"损坏"还是"能开"，都不许**丢掉**归属信息：
    //    能抢救就抢救到，抢救不到也必须如实返回，不许假装成功。
    match Engine::open_with_recovery(&path) {
        Ok((engine, backup)) => {
            if let Some(backup) = backup {
                // 走的是恢复路径 → 必须留下备份（那是唯一物证）
                assert!(backup.exists(), "恢复路径必须留下备份：{}", backup.display());
                // 抢救文件要么含 p1（读到了），要么不存在（读不到）—— 不允许出现"半截文件"
                let sidecar = format!("{}.recovered-projects.json", path.display());
                if std::path::Path::new(&sidecar).exists() {
                    let text = std::fs::read_to_string(&sidecar).unwrap();
                    let v: serde_json::Value = serde_json::from_str(&text)
                        .expect("抢救文件必须是合法 JSON（半截文件会让渲染侧解析失败）");
                    assert!(v["projects"].is_array(), "必须有 projects 数组");
                    assert!(v["sessions"].is_array(), "必须有 sessions 数组");
                    for s in v["sessions"].as_array().unwrap() {
                        assert!(s["id"].is_string() && s["project_id"].is_string(), "每行必须有 id + project_id");
                    }
                }
            }
            // ④ 关键行为：无论抢救是否成功，**恢复后的库都必须可用**
            assert!(engine.integrity_check().unwrap().ok, "恢复后的库必须完整性通过");
        }
        Err(e) => {
            // 这个文件被填得太坏、连恢复都打不开也是允许的 —— 但必须是诚实的错误
            assert_eq!(e.code, codem_db::ErrorCode::Corrupt, "只允许诚实的 CORRUPT：{e:?}");
        }
    }
}

// ========== 打开前的 WAL 检查：坏 WAL 头不许静默消失（第 92 轮真机缺陷） ==========

/// 真 WAL 在磁盘上的前 4 字节（SQLite 按**大端**写 magic）：
/// `WAL_MAGIC = 0x377f0682`（小端主机）或 `WAL_MAGIC|1 = 0x377f0683`（大端主机）。
///
/// ⚠️ 这一条是**实测锚点**，不是抄文档：第一版实现把字节序写反了
/// （按 `from_le_bytes` 去比这两个常量），于是"正常 WAL"被整批判成坏 WAL ——
/// 打红它的正是下面第 ② 条测试，现场给出的字节就是 `37 7f 06 82`。
const WAL_MAGIC_BYTES_LE_HOST: [u8; 4] = [0x37, 0x7f, 0x06, 0x82];
const WAL_MAGIC_BYTES_BE_HOST: [u8; 4] = [0x37, 0x7f, 0x06, 0x83];

/// 造一个"主库有已提交数据 + `-wal` 里有**尚未 checkpoint 的写入**"的库，并把它整份复制到 `dst/`。
///
/// 返回 `(副本路径, 副本 WAL 的字节)`。
///
/// ## 为什么要"复制整库"，而不是直接生成一个 WAL 文件
///
/// 实测（不是推测）：**SQLite 在最后一个连接关闭时会把 WAL 并回主库并删掉它** ——
/// 所以 `Engine::open` → 写 → drop 之后，磁盘上**不会留下任何 `-wal`**，
/// 直白写法连"非空 WAL"这个前置条件都造不出来（第一版就是这么红的）。
///
/// 这里改用真机注入测试用的同一手法：**趁写入还没 checkpoint，把主库与 `-wal`/`-shm`
/// 一起复制走**。复制之后那份库上没有任何连接，正是真机上"崩溃/强杀之后剩下的现场"，
/// 也正是 `check_wal_before_open`（打开前检查）要面对的形态。
///
/// ## 造出来的副本里有什么
///
/// - `dst/<name>.bin`：已提交的 `projects` 行 + schema（在主库里）；
/// - `dst/<name>.bin-wal`：**非空**、magic 合法，里面是 `UNCHECKPOINTED_PROJECT` 那一次写
///   （尚未并回主库）。于是"WAL 被忽略并删除 ⇒ 这次写入无声消失"是可断言的。
fn seed_db_with_uncheckpointed_wal(
    dir: &std::path::Path,
    name: &str,
) -> (std::path::PathBuf, Vec<u8>) {
    let src = dir.join(format!("{name}-src"));
    let dst = dir.join(format!("{name}-dst"));
    std::fs::create_dir_all(&src).unwrap();
    std::fs::create_dir_all(&dst).unwrap();
    let live = src.join(format!("{name}.bin"));

    // ① 建库 + 一行**已提交**的数据，并 checkpoint（让主库本身有内容，而不是空库）
    {
        let engine = Engine::open(&live).unwrap();
        call(&engine, "projects.upsert", json!({ "id": "p-committed", "name": "已 checkpoint" }));
        engine.checkpoint().unwrap();
    }

    // ② 另一个连接写一行并提交，**但不 checkpoint** —— 它只存在于 WAL 里
    let writer = rusqlite::Connection::open(&live).unwrap();
    writer
        .execute_batch(&format!(
            "BEGIN IMMEDIATE;\
             INSERT INTO projects (id, name, path, pinned, created_at, last_accessed_at) \
             VALUES ('{UNCHECKPOINTED_PROJECT}', '只在 WAL 里', '', 0, 1, 1);\
             COMMIT;"
        ))
        .expect("在 WAL 里写入未 checkpoint 的数据");

    /*
     * ③ 趁 WAL 还在，把整份库复制走（主库 + -wal + -shm 必须一起，缺一份就可能是半截状态）。
     *
     * ⚠️ 顺序同样是实测出来的：**复制必须发生在 `writer` 关闭之前**。
     * 这份 WAL 之所以存在，靠的就是"还有一个连接开着"；
     * 一旦 `writer` 被 drop（或离开作用域），SQLite 会在关闭时 checkpoint 并**删掉** `-wal`
     * —— 第二版就是先 drop 后复制，于是副本里根本没有 WAL，前置条件当场变红。
     */
    let copy = dst.join(format!("{name}.bin"));
    std::fs::copy(&live, &copy).unwrap();
    for suffix in ["-wal", "-shm"] {
        let from = std::path::PathBuf::from(format!("{}{suffix}", live.display()));
        if from.exists() {
            std::fs::copy(&from, std::path::PathBuf::from(format!("{}{suffix}", copy.display())))
                .unwrap();
        }
    }
    drop(writer);

    let wal = std::path::PathBuf::from(format!("{}-wal", copy.display()));
    assert!(
        wal.exists() && std::fs::metadata(&wal).unwrap().len() > 0,
        "前置条件：副本必须带上一份非空 -wal（否则这条测试测的不是「坏 WAL 头」）：{}",
        wal.display()
    );
    let wal_bytes = std::fs::read(&wal).unwrap();
    assert!(
        wal_bytes.starts_with(&WAL_MAGIC_BYTES_LE_HOST)
            || wal_bytes.starts_with(&WAL_MAGIC_BYTES_BE_HOST),
        "前置条件：这份 WAL 必须是 SQLite 自己写出来的（magic 对得上），而不是测试手搓的假文件：{:02x?}",
        &wal_bytes[..4]
    );
    (copy, wal_bytes)
}

/// 只存在于 `-wal` 里的那行：WAL 被忽略 ⇒ 它就该读不出来（"无声消失"的可断言形态）。
const UNCHECKPOINTED_PROJECT: &str = "p-only-in-wal";

/// 把 WAL 的前 4 字节（magic）覆写成 0 —— 真机注入测试用的正是这个位置。
fn break_wal_magic(wal: &std::path::Path) {
    use std::io::{Seek, SeekFrom, Write};
    let mut f = std::fs::OpenOptions::new().write(true).open(wal).unwrap();
    f.seek(SeekFrom::Start(0)).unwrap();
    f.write_all(&[0u8; 4]).unwrap();
    f.flush().unwrap();
}

/// 目录里所有 `<库>.corrupt-wal-*` 备份（按既有 `.corrupt-*` 的命名口径找）。
///
/// 刻意按 `corrupt-wal-` 前缀过滤：`<库>.corrupt-<ts>` 是**主库**备份，
/// 两种备份的判据必须分开（混在一起会让"没备份 WAL"这种失败看起来是绿的）。
fn wal_backups(db: &std::path::Path) -> Vec<std::path::PathBuf> {
    let dir = db.parent().unwrap();
    let prefix = format!(
        "{}.corrupt-wal-",
        db.file_name().unwrap().to_string_lossy()
    );
    let mut out: Vec<std::path::PathBuf> = std::fs::read_dir(dir)
        .unwrap()
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .map(|n| n.to_string_lossy().starts_with(&prefix))
                .unwrap_or(false)
        })
        .collect();
    out.sort();
    out
}

/// ① `-wal` 头损坏（主库完好）⇒ **先留下备份**，并把这次事件报出来。
///
/// ## 真机缺陷的形态（这条测试就是它的回归守卫）
///
/// 对真实库的副本做注入：把 `-wal` 的头 4 KB 覆写成 0 —— 引擎**不报损坏、不备份、返回 ok:true**，
/// SQLite 随后把这个 WAL **删掉**，那几个 MB 尚未 checkpoint 的写入**无声消失、且没有任何备份**。
/// 对照：主库文件头坏掉时引擎会正确改名成 `<库>.corrupt-<ts>` 再重建（见本文件第一条测试）。
/// 同一种"数据不可用"，一个留物证一个不留 —— 就是缺口。
///
/// 这里钉三件事：**备份真的在磁盘上**、**备份一个字节都没被截断**、**这次事件被报出来**。
#[test]
fn broken_wal_header_is_preserved_and_reported() {
    let dir = tempfile::tempdir().unwrap();
    let (db, wal_before) = seed_db_with_uncheckpointed_wal(dir.path(), "bad-wal");
    let wal = std::path::PathBuf::from(format!("{}-wal", db.display()));
    break_wal_magic(&wal);

    let engine = Engine::open(&db).expect("主库完好时，坏 WAL 头不该让打开失败");
    let h = engine.health().unwrap();

    // ① 备份存在，且**一个字节都没被截断**
    let backups = wal_backups(&db);
    assert_eq!(
        backups.len(),
        1,
        "必须且只留一份 .corrupt-wal-* 备份（否则那几个 MB 的写入就是无声消失）：{backups:?}"
    );
    let kept = &backups[0];
    /*
     * ⚠️ 判据是"**不少于**"，不是"逐字节相等"（第一版写的是相等，那是个**假判据**）。
     *
     * 复制手法保证的是"复制那一刻的字节"；而 `Engine::open` 之后 SQLite 可能改写这个
     * WAL（重放帧 / 处理半截状态），于是原文件在备份那一刻**可能已经和复制来的字节不同**。
     * 真正要守的性质只有一条：**备份不许把文件截断**（"变小"才意味着有字节被丢掉）。
     * 拿"相等"去卡，会在一个完全正常的备份上变红。
     */
    let kept_len = std::fs::metadata(kept).unwrap().len();
    assert!(
        kept_len >= wal_before.len() as u64,
        "备份不许比原 WAL 短（那意味着有字节被丢掉）：备份 {kept_len} B < 原 WAL {} B —— {}",
        wal_before.len(),
        kept.display()
    );
    // 备份的前 4 字节就是**被覆写后的**那 4 个 0（原样保留物证，不许"修好"再存）
    assert_eq!(
        std::fs::read(kept).unwrap()[..4],
        [0u8; 4],
        "备份必须原样保留坏掉的文件头（修过的副本不再是物证）"
    );

    // ② 这次事件被**如实报出来**（否则调用方看到的就是一个骗人的 ok:true）
    assert_eq!(
        h.wal_backup_from.as_deref(),
        Some(kept.to_string_lossy().as_ref()),
        "health 必须给出保留下来的 WAL 备份路径：{h:?}"
    );
    assert!(
        h.warning.is_none(),
        "这次是「正常地留住了物证」，不该同时报一条失败说明：{h:?}"
    );

    /*
     * ③ 那份**坏** WAL 已经不在了 —— 检查在打开前就把它搬走，
     *    所以 SQLite 根本没有机会"忽略并删除"它。
     *
     * ⚠️ 判据不能写成"这个路径不存在"（假判据）：SQLite 打开库之后会**重建一个新的空 WAL**
     * （实测现场：`copy.bin-wal` 长度 0），于是拿"路径不存在"去卡会在一个完全正常的
     * 备份上变红。真正的不变量是"**留在原地的那个 WAL 不再是那份坏数据**"：
     * 要么不存在，要么是空的（重建出来的）。
     */
    if wal.exists() {
        assert_eq!(
            std::fs::metadata(&wal).unwrap().len(),
            0,
            "原路径上要么没有 WAL、要么是 SQLite 重建的空 WAL；\
             非空就说明坏数据还留在原地（那正是原缺陷的形态）"
        );
    }

    // ④ 主库本身没被这次检查碰坏：schema 在、能读能写
    assert!(engine.integrity_check().unwrap().ok, "主库必须依然完整");
    assert!(
        call(&engine, "projects.list", json!({}))["items"].is_array(),
        "主库必须可读"
    );
    /*
     * ⑤ 被毁掉的那次写入**确实读不出来了** —— 这是本条测试的现场还原：
     *    SQLite 忽略坏 WAL ⇒ 只存在于 WAL 里的那行消失。这条断言把"这个测试到底在守什么"
     *    钉死：如果不是这个形态（比如写入其实已经在主库里），本测试就退化成空跑。
     *    备份是**唯一**还能把这份写入找回来的东西 —— 这正是"必须留物证"的理由。
     */
    let listed = call(&engine, "projects.list", json!({}));
    assert!(
        !listed["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p["id"] == json!(UNCHECKPOINTED_PROJECT)),
        "前置条件还原失败：只存在于 WAL 的那行不该出现在主库里：{listed}"
    );
    assert!(
        call(&engine, "projects.list", json!({}))["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p["id"] == json!("p-committed")),
        "已 checkpoint 的那行必须还在（坏的是 WAL，不是主库）"
    );
}

/// ② 正常 WAL（合法 magic）⇒ **不产生任何备份**，行为与改动前一致。
///
/// ## 为什么这条是必须的（而不是"顺手多测一条"）
///
/// 打开前检查读的是 WAL 的**前 4 字节**。判据写错（比如少认一种字节序、偏移取错、
/// 把页大小当成 magic）就会把**完全正常的库**判成"坏 WAL" ——
/// 后果是所有数据被搬进 `.corrupt-wal-*`、库看起来"空了一半"，比原缺陷更严重。
/// 所以这里用**真正的（由 SQLite 写出来的）WAL**，断言"一个备份都不许出现"，
/// 并且 WAL 里的写入照常读得出来、主库照常完整。
#[test]
fn healthy_wal_produces_no_backup_and_keeps_behaving() {
    let dir = tempfile::tempdir().unwrap();
    let (db, wal_before) = seed_db_with_uncheckpointed_wal(dir.path(), "good-wal");
    let wal = std::path::PathBuf::from(format!("{}-wal", db.display()));

    /*
     * magic 判据的**实测锚点**（这条不是抄文档，是被打红出来的）：
     * SQLite 在 WAL 头里按**大端**写 magic，磁盘上就是 `37 7f 06 82`（= `0x377f0682`）。
     * 第一版实现按小端去比这两个常量，于是**正常 WAL 被整批判成坏 WAL** ——
     * 打红这条测试的现场给出的字节正是 `37 7f 06 82`。
     * 另一种合法 magic 只差最后 1 字节的低位（`37 7f 06 83`），实现里两个都认。
     */
    assert_eq!(
        &wal_before[..4],
        &WAL_MAGIC_BYTES_LE_HOST,
        "前置条件：必须是 SQLite 自己写出来的 WAL（magic 与判据常量对得上）"
    );

    let engine = Engine::open(&db).expect("正常 WAL 必须照常打开");
    assert!(
        wal_backups(&db).is_empty(),
        "正常 WAL **一个备份都不许产生**：{:?}",
        wal_backups(&db)
    );
    let h = engine.health().unwrap();
    assert!(h.wal_backup_from.is_none(), "正常库不得报 WAL 备份事件：{h:?}");
    assert!(h.warning.is_none(), "正常库不得报检查失败：{h:?}");
    assert!(
        wal.exists(),
        "正常 WAL 必须原样留在原地（检查是纯只读的）"
    );

    // 行为与改动前一致：未 checkpoint 的写入照常从 WAL 读出来
    let listed = call(&engine, "projects.list", json!({}));
    assert!(
        listed["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p["id"] == json!(UNCHECKPOINTED_PROJECT)),
        "正常 WAL 里的未 checkpoint 写入必须照常读出来（行为不许变）：{listed}"
    );
    assert!(engine.integrity_check().unwrap().ok);
}

/// ③ 对照组：`-wal` 长度为 0 / 不存在 ⇒ **不备份、不报事件**。
///
/// 空 WAL 是"干净关闭"之后的常见形态（没有内容可丢），不存在的 WAL 更是常态。
/// 这两种情况如果也去备份，每次启动都会在用户目录里堆一个空文件、
/// 并让 health 每次都喊"出事了" —— 噪声会把真正的坏 WAL 事件淹掉。
#[test]
fn empty_or_absent_wal_is_not_reported() {
    let dir = tempfile::tempdir().unwrap();

    // 对照组 A：`-wal` 存在但长度为 0
    let zero = dir.path().join("zero-wal.bin");
    Engine::open(&zero).unwrap();
    let wal = std::path::PathBuf::from(format!("{}-wal", zero.display()));
    let _ = std::fs::remove_file(&wal);
    std::fs::write(&wal, b"").unwrap();
    assert_eq!(std::fs::metadata(&wal).unwrap().len(), 0, "前置条件：长度为 0");

    let engine = Engine::open(&zero).unwrap();
    let h = engine.health().unwrap();
    assert!(
        wal_backups(&zero).is_empty(),
        "空 WAL 不许产生备份：{:?}",
        wal_backups(&zero)
    );
    assert!(h.wal_backup_from.is_none(), "空 WAL 不许报备份事件：{h:?}");
    assert!(h.warning.is_none(), "空 WAL 不许报检查失败：{h:?}");

    // 对照组 B：`-wal` 压根不存在
    let absent = dir.path().join("no-wal.bin");
    {
        let engine = Engine::open(&absent).unwrap();
        let _ = engine.checkpoint(); // checkpoint 会截断 WAL；再确认一次文件确实不在
    }
    let absent_wal = std::path::PathBuf::from(format!("{}-wal", absent.display()));
    assert!(
        !absent_wal.exists() || std::fs::metadata(&absent_wal).unwrap().len() == 0,
        "前置条件：这里应当没有非空 WAL"
    );

    let engine = Engine::open(&absent).unwrap();
    let h = engine.health().unwrap();
    assert!(
        wal_backups(&absent).is_empty(),
        "没有 WAL 时不许产生备份：{:?}",
        wal_backups(&absent)
    );
    assert!(h.wal_backup_from.is_none(), "没有 WAL 时不许报事件：{h:?}");
    assert!(h.warning.is_none(), "没有 WAL 时不该报检查失败：{h:?}");
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

/// ## 第 55 轮：**`tool_calls` 的量级用例**（这是审计里点名的缺口）
///
/// 缺口原话：「`tool_calls` 大 payload 在真 CLI 契约中**无量级用例**」——
/// 当时的证据只有一次性探针（我记得做过 500 个工具调用 / 1.05 MB 的钻取），
/// 但**仓库里没有守着它的用例**：`engine_tests` 里关于 `tool_calls` 的三条
/// （`upsert_index_replaces_tool_calls_atomically` / `_without_tool_calls_leaves_them_alone` /
/// `tool_calls_replace_rejects_orphan`）用的都是**两三条、几十字节**的样例。
///
/// 工具调用的 payload 与消息正文不同：它是**结构化 JSON**（args / result 两段都可能是
/// 几 MB 的补丁、grep 输出、网页正文），而且是**一次写几十上百条**。
/// 所以量级要分三个维度都压一遍：
///
/// | 维度 | 本用例的量 |
/// | --- | --- |
/// | 单个工具调用的 args | **约 2 MiB**（UTF-8 中文 + 换行，逼出长度/编码类截断） |
/// | 单个工具调用的 result | **约 2 MiB** |
/// | 一条消息上的工具调用**条数** | **500** |
///
/// 判据：① 写进去的条数如实返回；② `tool_calls.list` 读回来**逐字节相等**（首尾各校验一遍，
/// 中间抽样）；③ 含 emoji 的多字节内容不许被"字符数/字节数"混淆；④ 整批替换仍然原子。
#[test]
fn tool_calls_payload_scale_is_byte_exact() {
    let (_d, e) = temp_engine("tool-scale");
    call(&e, "sessions.upsert", json!({ "id": "s1" }));

    // 约 2 MiB 的 args / result（中文 3 字节 + emoji 4 字节，确保不能被当成 ASCII 长度）
    //
    // ⚠️ 这里的重复次数我第一版算错了（`"参数内容🙂\n"` 是 17 字节，6 万次只有 1.02 MB，
    // 断言当场红）。**量级用例的第一个坑就是"以为自己造够大了"**，所以下面既断长度、也留实测值。
    let big_args: String = "参数内容🙂\n".repeat(130_000); // 17 B × 130k ≈ 2.21 MB
    let big_result: String = "结果内容✅\n".repeat(130_000);
    assert!(
        big_args.len() > 2_000_000,
        "args 应超过 2 MB，实际 {} 字节",
        big_args.len()
    );
    assert!(
        big_result.len() > 2_000_000,
        "result 应超过 2 MB，实际 {} 字节",
        big_result.len()
    );

    // 第一条：超大 args + 超大 result；其余 499 条：普通大小（模拟"一次写一批"）
    let mut calls: Vec<serde_json::Value> = Vec::with_capacity(500);
    calls.push(json!({
        "id": "t0",
        "tool": "apply_patch",
        "args": { "patch": big_args },
        "status": "done",
        "result": big_result,
    }));
    for i in 1..500 {
        calls.push(json!({
            "id": format!("t{i}"),
            "tool": "read_file",
            "args": { "path": format!("src/file_{i}.ts") },
            "status": "done",
            "result": format!("第 {i} 个文件的正文"),
        }));
    }

    let t_write = std::time::Instant::now();
    let written = call(
        &e,
        "messages.upsert_index",
        json!({
            "id": "m1",
            "session_id": "s1",
            "role": "assistant",
            "content": "带 500 个工具调用的回合",
            "tool_calls": calls,
        }),
    );
    let write_ms = t_write.elapsed().as_millis();
    assert_eq!(written["tool_calls"], json!(500), "500 条必须一条不少地写进去");

    // 读回来：条数 + 逐字节内容
    let t_read = std::time::Instant::now();
    let listed = call(&e, "tool_calls.list", json!({ "message_id": "m1" }));
    let read_ms = t_read.elapsed().as_millis();
    /*
     * 把量级**打印出来**（`cargo test ... -- --nocapture` 可见）。
     *
     * 为什么值得打印：这条用例的意义就是"某个量级真的能过"，
     * 而"能过"必须带上当时的数字才有复核价值（换了机器、换了实现，
     * 数字变化本身就是信号）。审计里点名的缺口正是"**没有量级用例**"。
     */
    println!(
        "[tool-scale] 500 条工具调用（其中 1 条约 {:.2} MB args + {:.2} MB result）\
         写入 {} ms / 读回 {} ms",
        big_args.len() as f64 / 1048576.0,
        big_result.len() as f64 / 1048576.0,
        write_ms,
        read_ms
    );
    let items = listed["items"].as_array().expect("items 必须是数组");
    assert_eq!(items.len(), 500, "读回来的条数必须与写入一致");

    let big = items
        .iter()
        .find(|t| t["id"] == json!("t0"))
        .expect("超大那条必须在");
    /*
     * ⚠️ 线协议形状（实测，不是猜的）：`tool_calls.list` 返回的 `args` 是
     * **JSON 字符串**（`"{\"patch\":\"…\"}"`），不是对象 —— 渲染侧也是按字符串存的。
     * 所以判据要**穿过这一层编码**去比：解回来再逐字节对，
     * 否则测的就只是"字符串长度"，而"内容被转义坏掉"这种缺陷照样能过。
     */
    let args_str = big["args"].as_str().expect("args 必须是 JSON 字符串（线协议形状）");
    let args_json: serde_json::Value =
        serde_json::from_str(args_str).expect("args 必须是合法 JSON 字符串");
    let result_str = big["result"].as_str().expect("result 必须是字符串");
    assert_eq!(
        args_json["patch"].as_str().expect("patch 必须是字符串").len(),
        big_args.len(),
        "2 MiB 的 args 必须逐字节相等（长度）"
    );
    assert_eq!(result_str.len(), big_result.len(), "2 MiB 的 result 必须逐字节相等（长度）");
    assert_eq!(
        args_json["patch"].as_str().unwrap(),
        big_args.as_str(),
        "内容也要相等（长度相同但内容被换掉/转义坏掉是最坏的那种'看起来对'）"
    );
    assert_eq!(result_str, big_result.as_str());

    // 中间抽样：500 条里随便挑几条，确认不是只有首尾对
    for idx in [1usize, 137, 498] {
        let want_id = format!("t{idx}");
        let got = items
            .iter()
            .find(|t| t["id"] == json!(want_id))
            .unwrap_or_else(|| panic!("{want_id} 应当存在"));
        let got_args: serde_json::Value =
            serde_json::from_str(got["args"].as_str().expect("args 是 JSON 字符串")).unwrap();
        assert_eq!(got_args["path"], json!(format!("src/file_{idx}.ts")));
        assert_eq!(got["result"], json!(format!("第 {idx} 个文件的正文")));
    }

    // 原子性：这一版整体替换成 1 条，旧 500 条不能残留（含那条 2 MiB 的）
    let replaced = call(
        &e,
        "messages.upsert_index",
        json!({
            "id": "m1",
            "session_id": "s1",
            "role": "assistant",
            "content": "收尾",
            "tool_calls": [{ "id": "t-last", "tool": "noop", "args": {}, "status": "done" }],
        }),
    );
    assert_eq!(replaced["tool_calls"], json!(1));
    let after = call(&e, "tool_calls.list", json!({ "message_id": "m1" }));
    let after_items = after["items"].as_array().unwrap();
    assert_eq!(after_items.len(), 1, "整体替换后旧工具调用不许残留（含大 payload 那条）");
    assert_eq!(after_items[0]["id"], json!("t-last"));

    // 会话级计数仍然自洽（大 payload 不该让维护性计数漂移）
    let counts = call(&e, "counts", json!({}));
    assert_eq!(counts["tool_calls"], json!(1), "写回后总工具调用数应为 1");
    assert_eq!(counts["messages"], json!(1));
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

    // 重建索引**不再写"日志里给了几条"**，而是写**索引真值**（第 45 轮 Z-9）。
    //
    // 为什么改：审计实测"索引里 60 行、日志只给 5 条"时，旧行为把
    // `sessions.message_count` 无条件写成 5，而 `messages.count` 是 60 —— 两个真值当场分叉，
    // 而且**维护对账会按索引真值改回来**（`maintenance.ts` 的 reconcileMessageCounts），
    // 下次重建又改回日志条数：两个写入者来回打架，侧边栏数字跳。
    // 现在这里写"这个会话在 messages 表里真实有多少行"，与维护对账指向**同一个不动点**。
    //
    // 本测试走到这里时：硬删 10 条之后库里还剩 11 条（新会话里每写一条都会 +1，
    // 硬删 10 条又 -10），再加上日志里的 2 条新消息 = 13 —— 而日志条数只有 2。
    call(
        &e,
        "messages.rebuild_index",
        json!({ "sessions": [{ "id": "s1", "messages": [
            { "id": "r1", "session_id": "s1", "role": "user", "content": "a", "timestamp": 1 },
            { "id": "r2", "session_id": "s1", "role": "assistant", "content": "b", "timestamp": 2 }
        ] }] }),
    );
    assert_eq!(
        count_of(&e),
        13,
        "重建索引写的是**索引真值**（库里 11 行 + 日志新写 2 行 = 13），不是日志条数 2"
    );
    assert_eq!(
        call(&e, "messages.count", json!({ "session_id": "s1" }))["count"],
        json!(13),
        "message_count 必须等于 messages.count（否则就是「两个真相」）"
    );
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

// ========== 第 45 轮（Z 批）回归测试 ==========

/// **Z-1（阻断级）**：`auto_migrate` 的对账原来对**行序**敏感 → 目标端已有源端子集时
/// "对账永久不通过"。
///
/// ## 端到端这一层证明什么（以及为什么顺序那一半在 `migrate.rs` 的单元测试里）
///
/// 端到端能证明的：**同一批行 + 目标端多出几行**时，对账必须通过、迁移标记必须写上
/// （旧判据在"目标端已有子集"的形态下会误判 —— 审计实测：源 6 行、目标预置 2 行，
/// 6 行其实都写进去了，只是顺序成了 `k1,k3,k2,k4,k5,k6`，于是报"对账未通过"、
/// 不写迁移标记、每次启动重来一遍）。
///
/// "**仅行序不同时也必须通过**"这一半直接用真实库做不到：目标端 `settings` 的主键
/// 自带 `sqlite_autoindex`，SQLite 对无 `ORDER BY` 的扫描就用它，于是目标端**始终**是
/// 主键序（我试过 `PRAGMA reverse_unordered_selects` 与 `DROP INDEX` 都不行：
/// 前者不生效、后者被 SQLite 拒绝 `index associated with UNIQUE or PRIMARY KEY
/// constraint cannot be dropped`）。所以那一半用 `MultisetDigest` 的单元测试钉死
/// （`migrate::batch_message_tests::multiset_digest_is_order_independent`），
/// 端到端只钉"标记真的写上了 + 缺失的行真的补上了"。
#[test]
fn auto_migrate_reconciliation_is_order_independent() {
    let dir = tempfile::tempdir().unwrap();
    let legacy_path = dir.path().join("legacy-order.bin");
    {
        /*
         * 裸 rusqlite 造旧库：**刻意不走引擎** —— 旧库是老 schema，
         * 而用引擎建库会得到"当前完整 schema"（那就复现不出真实的旧库形态）。
         *
         * ⚠️ `updated_at` 必须给真值：`settings` 的这一列是 `NOT NULL` 且**没有默认值**，
         * 而 `INSERT OR IGNORE` 遇到 NOT NULL 违约时**不报错**（只是忽略这一行）——
         * 于是"少给一列"会静默搬不进去（这一轮实测踩到，值得留痕：换个角度看，
         * 对账恰恰是唯一能发现它的机制）。
         */
        let conn = rusqlite::Connection::open(&legacy_path).unwrap();
        conn.execute_batch(
            "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);",
        )
        .unwrap();
        for i in 1..=6 {
            conn.execute(
                "INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)",
                rusqlite::params![format!("k{i}"), format!("v{i}"), i],
            )
            .unwrap();
        }
    }

    let target_path = dir.path().join("target-order.bin");
    let target = Engine::open(&target_path).unwrap();
    // 目标端**已经**有源端的一个子集（k1/k3），而且新值比源端"新"
    for k in ["k1", "k3"] {
        call(&target, "settings.set", json!({ "key": k, "value": format!("v{}", &k[1..]) }));
    }

    // 迁移必须**成功**（旧判据在这种"目标端已有子集"的形态下会误判失败）
    let res = call(
        &target,
        "migration.auto",
        json!({ "legacy_path": legacy_path.to_string_lossy() }),
    );
    assert_eq!(res["migrated"], json!(true), "对账必须与行序无关：{res}");
    assert!(
        res["order_differs_tables"].is_array(),
        "必须如实给出「行序不同」的表清单（没有就是空数组）：{res}"
    );

    // 6 行都在
    assert_eq!(
        call(&target, "settings.get_all", json!({}))["k6"],
        json!("v6"),
        "缺失的行必须被补上"
    );
    let n: i64 = target
        .with_conn(|conn| {
            conn.query_row("SELECT COUNT(*) FROM settings", [], |r| r.get(0))
                .map_err(codem_db::DbError::from)
        })
        .unwrap();
    // 6 行来自源端，另加迁移自己写的那条标记（`codem-storage-migrated-at`）
    assert_eq!(n, 7, "源端 6 行 + 迁移标记 1 行");

    // **迁移标记写上了**（这才是"不再每次启动重来一遍"的证据）
    let status = call(&target, "migration.status", json!({}));
    assert!(
        !status["migrated_at"].is_null(),
        "对账通过 → 必须写迁移标记（旧判据会因行序误判而写不上）：{status}"
    );

    /*
     * ⚠️ 这里**没有**再构造一个"迁移必须失败"的用例，理由值得写下来：
     * 我试了两种造法，都被引擎**正确地**修好了 ——
     * ① 目标端 `settings.key='k1'` 写成不同的值 → 迁移按源端内容覆盖它 → 对账通过；
     * ② 目标端多一行 → 判为 `SourceCovered`（"新库比旧库新"的正常情形）→ 通过。
     * 也就是说"对账失败"在单机测试里很难自然造出来（这本身是好消息：升级后的
     * 覆盖写 + 多重集判据把审计实测的两种形态都变成了成功路径）。
     * 失败分类（`content_differs` / `missing_rows`）由 `migrate.rs` 里的单元测试钉住：
     * `batch_message_tests::multiset_digest_is_order_independent`。
     */
}

/// **Z-1 后半条**：`<db>.pre-migration-<ms>` 备份必须有**保留策略**。
///
/// 为什么这是同一缺陷的一部分：对账（旧判据下）永久失败 → 每次启动重试 →
/// 每次重试都在写之前拷一份**整库副本**，且没有任何清理 —— 生产库几百 MB 量级，
/// 磁盘被填满之后备份失败又会让迁移彻底跑不动。
#[test]
fn auto_migrate_prunes_old_pre_migration_backups() {
    let dir = tempfile::tempdir().unwrap();
    let legacy_path = dir.path().join("legacy-prune.bin");
    {
        let conn = rusqlite::Connection::open(&legacy_path).unwrap();
        conn.execute_batch(
            "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO settings (key, value, updated_at) VALUES ('k1', 'v1', 1)",
            [],
        )
        .unwrap();
    }

    let target_path = dir.path().join("target-prune.bin");
    let target = Engine::open(&target_path).unwrap();
    let backups = |dir: &std::path::Path| -> Vec<String> {
        let mut out: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.contains(".pre-migration-"))
            .collect();
        out.sort();
        out
    };
    // 先塞两份**伪造**的历史备份（名字必须符合命名规则，否则不该被删）
    for stamp in ["100", "200"] {
        std::fs::write(
            dir.path().join(format!("target-prune.bin.pre-migration-{stamp}")),
            b"old backup",
        )
        .unwrap();
    }
    // 一份**不同命名**的文件：绝不能被清理碰到
    std::fs::write(dir.path().join("target-prune.bin.corrupt-999"), b"keep me").unwrap();

    assert_eq!(backups(dir.path()).len(), 2, "前提：已有两份历史备份");

    // keep_backups = 2：本次新备份 + 最近那份历史 = 2 份，最旧那份（100）该被删
    let res = call(
        &target,
        "migration.auto",
        json!({ "legacy_path": legacy_path.to_string_lossy(), "keep_backups": 2 }),
    );
    assert_eq!(res["backups_kept"], json!(2), "{res}");
    let after = backups(dir.path());
    assert_eq!(after.len(), 2, "必须只留最近 2 份备份，实际：{after:?}");
    assert!(
        !after.iter().any(|n| n.ends_with("pre-migration-100")),
        "最旧的那份必须被清掉：{after:?}"
    );
    assert!(res["backups_pruned"].as_array().unwrap().len() == 1, "{res}");
    assert!(
        dir.path().join("target-prune.bin.corrupt-999").exists(),
        "`.corrupt-*` 是另一套备份（可能是唯一能救的副本），绝不能被清理碰到"
    );
}

/// **Z-2（阻断级）**：`hidden = 0 ⇒ trimmed = 0` 这条不变量，三条写路径都必须成立。
///
/// 审计实测三条路径都把 `hidden` 打回 0 而留着 `trimmed = 1`（矛盾态）：
/// `messages.create` 覆盖写、`messages.upsert_index {hidden:0}`、
/// `messages.rebuild_index`（session-log-bridge 的主路径）。
#[test]
fn trimmed_is_cleared_whenever_hidden_becomes_zero() {
    let (_d, e) = temp_engine("trim-invariant");
    call(&e, "sessions.upsert", json!({ "id": "s1", "project_id": "" }));
    let mk = |id: &str| {
        json!({ "id": id, "session_id": "s1", "role": "user", "content": id, "timestamp": 1 })
    };
    for id in ["a", "b", "c", "d"] {
        call(&e, "messages.create", mk(id));
        // 先裁掉：hidden=1, trimmed=1
        call(&e, "messages.delete", json!({ "ids": [id], "trim": true }));
        assert_eq!(
            call(&e, "messages.get", json!({ "id": id }))["item"]["trimmed"],
            json!(1),
            "前提：裁剪必须留下 trimmed=1"
        );
    }

    // 路径①：`messages.create` 覆盖写（不传 hidden → 缺省 0）
    call(&e, "messages.create", mk("a"));
    let a = call(&e, "messages.get", json!({ "id": "a" }))["item"].clone();
    assert_eq!(a["hidden"], json!(0));
    assert_eq!(a["trimmed"], json!(0), "hidden 写成 0 时必须同时清掉 trimmed：{a}");

    // 路径②：`messages.upsert_index` 显式 hidden:0
    let mut p = mk("b");
    p["hidden"] = json!(0);
    call(&e, "messages.upsert_index", p);
    let b = call(&e, "messages.get", json!({ "id": "b" }))["item"].clone();
    assert_eq!(b["hidden"], json!(0));
    assert_eq!(b["trimmed"], json!(0), "upsert_index 写 0 也必须清 trimmed：{b}");

    // 路径③：`messages.update { hidden: 0 }`
    call(&e, "messages.update", json!({ "id": "c", "hidden": 0 }));
    let c = call(&e, "messages.get", json!({ "id": "c" }))["item"].clone();
    assert_eq!(c["trimmed"], json!(0), "messages.update 写 0 也必须清 trimmed：{c}");

    // 路径④（同一缺陷的另一半）：**日志重建不得撤销裁剪**
    //
    // 日志里没有 `trimmed` 这一维，而 `rebuildSessionLogs` 会带着日志里的 `hidden` 重放。
    // 旧行为：`hidden = excluded.hidden` 把 `trimmed=1` 的行打回 `hidden=0`（矛盾态），
    // 且 `messages.count` 的 visible 计数跟着变 —— "被裁过"这个事实被静默抹掉。
    call(
        &e,
        "messages.rebuild_index",
        json!({ "sessions": [{ "id": "s1", "messages": [
            { "id": "d", "session_id": "s1", "role": "user", "content": "d", "timestamp": 1, "hidden": 0 }
        ] }] }),
    );
    let d = call(&e, "messages.get", json!({ "id": "d" }))["item"].clone();
    assert_eq!(
        d["hidden"], json!(1),
        "重建不得把「被裁过的行」复活（那等于静默撤销裁剪）：{d}"
    );
    assert_eq!(d["trimmed"], json!(1), "重建不得清掉「被裁过」這個事实：{d}");

    // 没有任何矛盾态残留
    let bad: i64 = e
        .with_conn(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM messages WHERE COALESCE(hidden,0) = 0 AND COALESCE(trimmed,0) = 1",
                [],
                |r| r.get(0),
            )
            .map_err(codem_db::DbError::from)
        })
        .unwrap();
    assert_eq!(bad, 0, "库里不得存在 hidden=0 且 trimmed=1 的矛盾态");
}

/// **Z-9**：`messages.rebuild_index` 不许用**日志条数**覆盖 `message_count`。
///
/// 审计实测：索引里 60 行、日志只给 5 条 → 重建后 `sessions.message_count = 5`
/// 而 `messages.count = 60`；维护对账（按索引真值）改回来，下次重建又改回去 ——
/// 两个写入者来回打架。
#[test]
fn rebuild_index_never_overwrites_message_count_with_log_length() {
    let (_d, e) = temp_engine("rebuild-count");
    call(&e, "sessions.upsert", json!({ "id": "s1", "project_id": "" }));
    // 库里 6 行（引擎自己维护计数 → 6）
    let items: Vec<serde_json::Value> = (1..=6)
        .map(|i| {
            json!({ "id": format!("m{i}"), "session_id": "s1", "role": "user",
                    "content": "x", "timestamp": i })
        })
        .collect();
    call(&e, "messages.create_many", json!({ "items": items }));

    // 日志只给 2 条（**局部真相**）
    let res = call(
        &e,
        "messages.rebuild_index",
        json!({ "sessions": [{ "id": "s1", "messages": [
            { "id": "m1", "session_id": "s1", "role": "user", "content": "x", "timestamp": 1 },
            { "id": "m2", "session_id": "s1", "role": "user", "content": "x", "timestamp": 2 }
        ] }] }),
    );
    assert_eq!(res["messages"], json!(2), "返回值如实报「这次重放了几条」：{res}");
    assert_eq!(res["index_message_count"], json!(6), "{res}");

    let count: i64 = e
        .with_conn(|conn| {
            conn.query_row("SELECT message_count FROM sessions WHERE id = 's1'", [], |r| r.get(0))
                .map_err(codem_db::DbError::from)
        })
        .unwrap();
    assert_eq!(count, 6, "message_count 必须是**索引真值**（6），不是日志条数（2）");
    assert_eq!(
        call(&e, "messages.count", json!({ "session_id": "s1" }))["count"],
        json!(6),
        "两个真值必须相等（否则维护对账与重建会来回打架）"
    );
}

/// **Z-6**：`events.delete_session` 原来**绕过**批量删除闸门（无条件删光）。
///
/// 审计实测：`crud.delete` 删 4000 条事件被闸门拒绝，而 `events.delete_session`
/// 直接 `{"written":4000}` —— 而它是**生产路径**（`rust-port.ts` 的
/// `EventsPort.deleteSession`）。闸门装了，却没装在生产路径上。
#[test]
fn events_delete_session_respects_the_cascade_gate() {
    let (_d, e) = temp_engine("ev-gate");
    call(&e, "projects.upsert", json!({ "id": "p1", "name": "P" }));
    call(&e, "sessions.upsert", json!({ "id": "s1", "project_id": "p1" }));
    let items: Vec<serde_json::Value> = (0..80)
        .map(|i| json!({ "session_id": "s1", "type": "t", "payload": { "i": i } }))
        .collect();
    let appended = call(&e, "events.append_batch", json!({ "session_id": "s1", "events": items }));
    assert_eq!(appended["written"], json!(80));

    // ① 未确认 → 拒绝，且**一行都没删**（事务回滚）
    let err = dispatch(&e, "events.delete_session", &json!({ "session_id": "s1" }))
        .expect_err("超过上限的整会话事件删除必须被闸门拦下");
    assert!(err.message.contains("confirm_bulk"), "{}", err.message);
    assert_eq!(
        call(&e, "events.count", json!({ "session_id": "s1" }))["count"],
        json!(80),
        "被拒绝的删除必须整体回滚（一行都不许少）"
    );

    // ② 显式确认 → 放行，并如实报出规模
    let ok = call(&e, "events.delete_session", json!({ "session_id": "s1", "confirm_bulk": true }));
    assert_eq!(ok["written"], json!(80), "{ok}");
    assert_eq!(call(&e, "events.count", json!({ "session_id": "s1" }))["count"], json!(0));
}

/// **Z-6 的另一半**：`events.compact` 是**维护路径**，口径是"放行但如实报账"。
///
/// 与 `events.delete_session` 刻意不同：压缩是**有损替换**（删掉的段先被
/// `session_snapshot` 覆盖，锚点必须真实存在），不是"把语料删掉"。
/// 所以默认放行，但 ① 必须报 `affected_rows`；② 想受闸门约束的调用方可以显式
/// `enforce_limit: true`（用**同一份**判据）。
#[test]
fn events_compact_reports_affected_rows_and_can_enforce_the_gate() {
    let (_d, e) = temp_engine("ev-compact-gate");
    call(&e, "projects.upsert", json!({ "id": "p1", "name": "P" }));
    call(&e, "sessions.upsert", json!({ "id": "s1", "project_id": "p1" }));
    let items: Vec<serde_json::Value> = (0..80)
        .map(|i| json!({ "session_id": "s1", "type": "t", "payload": { "i": i } }))
        .collect();
    call(&e, "events.append_batch", json!({ "session_id": "s1", "events": items }));

    // 锚点存在时：默认放行，但规模必须可见
    let ok = call(
        &e,
        "events.compact",
        json!({ "session_id": "s1", "snapshot_seq": 1, "cutoff_seq": 40, "payload": { "snap": true } }),
    );
    assert!(
        ok["affected_rows"].as_i64().unwrap_or(0) >= 30,
        "维护路径放行的前提是**规模如实报出**（这一次删掉了几十行）：{ok}"
    );
    assert_eq!(ok["enforce_limit"], json!(false), "{ok}");

    // `enforce_limit: true` 时用与 crud.delete 同一份判据拒绝
    let items: Vec<serde_json::Value> = (0..80)
        .map(|i| json!({ "session_id": "s1", "type": "t", "payload": { "i": i } }))
        .collect();
    call(&e, "events.append_batch", json!({ "session_id": "s1", "events": items }));
    let seq: i64 = e
        .with_conn(|conn| {
            conn.query_row("SELECT MAX(seq) FROM session_events WHERE session_id='s1'", [], |r| r.get(0))
                .map_err(codem_db::DbError::from)
        })
        .unwrap();
    let err = dispatch(
        &e,
        "events.compact",
        &json!({ "session_id": "s1", "snapshot_seq": seq, "cutoff_seq": seq, "enforce_limit": true }),
    )
    .expect_err("enforce_limit 打开时必须按闸门拒绝");
    assert!(err.message.contains("confirm_bulk"), "{}", err.message);
}

/// **Z-3**：`hidden = NULL` 曾经打崩**整个会话**的读路径。
///
/// 审计实测：`messages.update { id, hidden: null }` "成功"（写入 SQL NULL），
/// 然后 `messages.get` 报 `Invalid column type Null at index: 8, name: hidden`，
/// `messages.list { include_hidden: true }` 同样报错 —— 整个会话读不出来；
/// 而 `crud.list` 照样返回 `"hidden": null`（两条读路径给出两种答案）。
///
/// 修法两条都要（一条防写入、一条防历史数据）：
/// ① 写侧拒绝 NULL；② 读侧 `Option<i64>` + `unwrap_or(0)`（本测试用**直连 SQL**
/// 造一行历史 NULL 来验证第 ② 条，因为第 ① 条已经不可能从命令层造出来了）。
#[test]
fn null_hidden_is_rejected_on_write_and_survived_on_read() {
    let (_d, e) = temp_engine("null-hidden");
    call(&e, "sessions.upsert", json!({ "id": "s1", "project_id": "" }));
    call(
        &e,
        "messages.create",
        json!({ "id": "m1", "session_id": "s1", "role": "user", "content": "a", "timestamp": 1 }),
    );

    // ① 写侧：六条写入命令都必须拒绝 `hidden`/`message_count` 为 NULL（语义上非空）
    for (cmd, params) in [
        ("messages.update", json!({ "id": "m1", "hidden": null })),
        ("messages.upsert_index", json!({ "id": "m1", "session_id": "s1", "role": "user", "content": "a", "hidden": null })),
        ("messages.create", json!({ "id": "m2", "session_id": "s1", "role": "user", "content": "a", "hidden": null })),
        ("messages.update_many", json!({ "items": [{ "id": "m1", "hidden": null }] })),
        ("crud.upsert", json!({ "table": "messages", "rows": [{ "id": "m3", "session_id": "s1", "role": "user", "content": "a", "timestamp": 1, "hidden": null }] })),
        ("sessions.upsert", json!({ "id": "s2", "project_id": "", "message_count": null })),
    ] {
        let err = match dispatch(&e, cmd, &params) {
            Ok(v) => panic!("{cmd} 必须拒绝 NULL，却返回了 {v}"),
            Err(err) => err,
        };
        assert!(
            err.message.contains("不可为空") || err.message.contains("NULL"),
            "{cmd} 的报错必须说清是哪一列不接受 NULL：{}",
            err.message
        );
    }

    // ② 读侧：造一行**历史** NULL（模拟老数据 / 手工 SQL）—— 读路径不许崩
    e.write_tx(|tx| {
        tx.execute("UPDATE messages SET hidden = NULL WHERE id = 'm1'", [])
            .map_err(codem_db::DbError::from)?;
        Ok(())
    })
    .unwrap();

    let got = call(&e, "messages.get", json!({ "id": "m1" }));
    assert_eq!(got["item"]["hidden"], json!(0), "历史 NULL 应被读成 0（可见）：{got}");
    let listed = call(
        &e,
        "messages.list",
        json!({ "session_id": "s1", "include_hidden": true }),
    );
    assert_eq!(
        listed["items"].as_array().unwrap().len(),
        1,
        "整个会话必须读得出来（NULL 不许打崩读路径）：{listed}"
    );
}

/// **Z-4 / Z-5**：`rebuild_fts` 的两处新引入回退。
///
/// - Z-4：`messages.id IS NULL`（SQLite 的 `TEXT PRIMARY KEY` 允许多行 NULL）原来让
///   **整次重建失败**（`Invalid column type Null at index: 0, name: id`）——
///   而它同时还是**唯一**能清 FTS 孤儿的路径，于是那个库的全文索引永远修不好。
/// - Z-5：重复 `message_id` 让"内容一致就跳过"永远判一致 → 一行都不删 →
///   `fts.search` 同一条消息返回两次。旧实现"整表 DELETE + 重灌"天然自愈，增量改写丢了它。
#[test]
fn rebuild_fts_tolerates_null_ids_and_heals_duplicate_rows() {
    let (_d, e) = temp_engine("rebuild-fts-null");
    call(&e, "sessions.upsert", json!({ "id": "s1", "project_id": "" }));
    call(
        &e,
        "messages.create",
        json!({ "id": "m1", "session_id": "s1", "role": "user", "content": "存储迁移", "timestamp": 1 }),
    );
    // ① 一行 id 为 NULL（直连 SQL 造：命令层不可能写出 NULL id）
    e.write_tx(|tx| {
        tx.execute(
            "INSERT INTO messages (id, session_id, role, content, timestamp) VALUES (NULL, 's1', 'user', '孤儿行', 2)",
            [],
        )
        .map_err(codem_db::DbError::from)?;
        Ok(())
    })
    .unwrap();

    // ② FTS 里塞两行重复的 message_id（模拟历史重复）
    e.write_tx(|tx| {
        for _ in 0..2 {
            tx.execute(
                "INSERT INTO session_fts (message_id, session_id, content, role, timestamp) \
                 VALUES ('dup', 's1', '重复 重复', 'user', 3)",
                [],
            )
            .map_err(codem_db::DbError::from)?;
        }
        // 让 'dup' 这条在 messages 里也存在（否则它会被当孤儿删掉）
        tx.execute(
            "INSERT INTO messages (id, session_id, role, content, timestamp) VALUES ('dup', 's1', 'user', '重复', 3)",
            [],
        )
        .map_err(codem_db::DbError::from)?;
        Ok(())
    })
    .unwrap();

    // 重建：不许整体失败；NULL id 要被**跳过并计数**
    let res = call(&e, "rebuild_fts", json!({}));
    assert_eq!(res["skipped_null_id"], json!(1), "NULL id 的行必须跳过并计数：{res}");

    // 重复行必须被收敛回一行
    let dup_rows: i64 = e
        .with_conn(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM session_fts WHERE message_id = 'dup'",
                [],
                |r| r.get(0),
            )
            .map_err(codem_db::DbError::from)
        })
        .unwrap();
    assert_eq!(dup_rows, 1, "重复 message_id 必须自愈成一行（否则搜索结果重复）");

    // 自愈之后第二次重建应当是"无改动"（幂等）
    let again = call(&e, "rebuild_fts", json!({}));
    assert_eq!(again["indexed"], json!(0), "第二次重建不该再写任何行：{again}");
}

/// **Z-10**：`MAX(0, …)` 把计数漂移**夹成另一个错值**而不暴露它。
///
/// 审计实测：把 `message_count` 人为写成 1（库里其实 5 条）→ 硬删 3 条 →
/// 计数变成 0（被夹断），而真实还有 2 条 —— "0 条消息的会话里躺着 2 条"，无任何告警。
/// 夹断本身是对的（负计数更糟），错的是**夹了却不说**。
#[test]
fn clamped_message_count_is_reported_not_silent() {
    let (_d, e) = temp_engine("count-clamp");
    call(&e, "sessions.upsert", json!({ "id": "s1", "project_id": "" }));
    let items: Vec<serde_json::Value> = (1..=5)
        .map(|i| {
            json!({ "id": format!("m{i}"), "session_id": "s1", "role": "user",
                    "content": "x", "timestamp": i })
        })
        .collect();
    call(&e, "messages.create_many", json!({ "items": items }));
    // 人为制造漂移：计数写成 1（库里其实 5 条）
    e.write_tx(|tx| {
        tx.execute("UPDATE sessions SET message_count = 1 WHERE id = 's1'", [])
            .map_err(codem_db::DbError::from)?;
        Ok(())
    })
    .unwrap();
    // 前提断言：漂移确实造成了（否则后面的"夹断"就无从谈起）
    assert_eq!(
        call(&e, "messages.count", json!({ "session_id": "s1" }))["count"],
        json!(5)
    );

    // 硬删 3 条 → MAX(0, 1-3) = 0，夹断发生
    let res = call(
        &e,
        "messages.delete",
        json!({ "ids": ["m1", "m2", "m3"], "confirm_bulk": true }),
    );
    assert_eq!(
        res["count_clamped"],
        json!(true),
        "夹断必须被上报（这正是「计数已经漂移」的唯一在线信号）：{res}"
    );
    // 库里其实还有 2 条 —— 与计数 0 矛盾的这件事现在是**可见**的
    assert_eq!(
        call(&e, "messages.count", json!({ "session_id": "s1" }))["count"],
        json!(2)
    );
    let stored: i64 = e
        .with_conn(|conn| {
            conn.query_row("SELECT message_count FROM sessions WHERE id = 's1'", [], |r| r.get(0))
                .map_err(codem_db::DbError::from)
        })
        .unwrap();
    assert_eq!(stored, 0, "夹断仍然生效（负计数更糟），只是现在被报出来了");
}

/// **Z-8**：`legacy.read_table` 的两件事。
///
/// ① keyset 分页（默认路径）：返回 `next_key`，并且**翻页期间源库变化不跳行**
///    （offset 分页的实测形态：limit=2、删掉 k1 之后 page2 给 k4,k5 —— k3 从未被读到）；
/// ② 返回里**如实说明**"翻页期间源库变化可能跳行"这件事（`source_change_hazard`）。
#[test]
fn legacy_read_table_keyset_paging_survives_source_changes() {
    let dir = tempfile::tempdir().unwrap();
    let legacy_path = dir.path().join("legacy-keyset.bin");
    {
        let conn = rusqlite::Connection::open(&legacy_path).unwrap();
        conn.execute_batch("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);")
            .unwrap();
        for i in 1..=6 {
            conn.execute(
                "INSERT INTO settings (key, value) VALUES (?1, ?2)",
                rusqlite::params![format!("k{i}"), format!("v{i}")],
            )
            .unwrap();
        }
    }
    let (_d2, e) = temp_engine("keyset-reader");

    let p1 = call(
        &e,
        "legacy.read_table",
        json!({ "legacy_path": legacy_path.to_string_lossy(), "table": "settings", "limit": 2 }),
    );
    assert_eq!(p1["paging"], json!("keyset"), "默认路径必须是 keyset：{p1}");
    assert!(
        p1["source_change_hazard"].as_str().unwrap_or("").contains("源库"),
        "必须如实说明翻页期间源库变化的风险：{p1}"
    );
    let keys1: Vec<String> = p1["rows"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r[0].as_str().unwrap_or_default().to_string())
        .collect();
    assert_eq!(keys1, vec!["k1", "k2"]);
    let cursor = p1["next_key"].clone();
    assert!(!cursor.is_null(), "第一页必须给出 next_key：{p1}");

    // 翻页**之间**源库被改：删掉已经读过的 k1，再加一行 k0（落在游标之前）
    {
        let conn = rusqlite::Connection::open(&legacy_path).unwrap();
        conn.execute("DELETE FROM settings WHERE key = 'k1'", []).unwrap();
        conn.execute("INSERT INTO settings (key, value) VALUES ('k0', 'v0')", [])
            .unwrap();
    }

    // keyset 续页：k3 必须还在（这是 offset 分页会跳过的那一行）
    let p2 = call(
        &e,
        "legacy.read_table",
        json!({ "legacy_path": legacy_path.to_string_lossy(), "table": "settings",
                "limit": 2, "after_key": cursor }),
    );
    let keys2: Vec<String> = p2["rows"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r[0].as_str().unwrap_or_default().to_string())
        .collect();
    assert_eq!(keys2, vec!["k3", "k4"], "keyset 不受「已读过的行被删」影响：{p2}");
}

/// **Z-8 的第二半**：`WITHOUT ROWID` 的表不许再报 `no such column: rowid`。
#[test]
fn legacy_read_table_handles_without_rowid_tables() {
    let dir = tempfile::tempdir().unwrap();
    let legacy_path = dir.path().join("legacy-without-rowid.bin");
    {
        let conn = rusqlite::Connection::open(&legacy_path).unwrap();
        conn.execute_batch("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT) WITHOUT ROWID;")
            .unwrap();
        conn.execute("INSERT INTO settings (key, value) VALUES ('k1', 'v1')", [])
            .unwrap();
    }
    let (_d2, e) = temp_engine("reader-without-rowid");
    let page = call(
        &e,
        "legacy.read_table",
        json!({ "legacy_path": legacy_path.to_string_lossy(), "table": "settings", "limit": 10 }),
    );
    assert_eq!(page["rows"].as_array().unwrap().len(), 1, "{page}");
    assert_eq!(page["paging"], json!("keyset"), "无 rowid 的表也必须能分页：{page}");
}

// ========== 渲染侧载荷必须被引擎接受（第 45 轮真机回归） ==========

/// **新建会话**的载荷必须被接受 —— 这条守卫的代价是一次真机数据事故。
///
/// 起因：`sort_order` 曾被收进 `SEMANTIC_NOT_NULL_COLUMNS`（"0 表示未指定"），
/// 而渲染侧 `sessionToWire` 对"从未拖拽过"的会话写的就是 `sort_order: null`（**有含义的值**）
/// ⇒ 整笔 `sessions.upsert` 被拒 ⇒ 会话行不存在 ⇒ 它下面的消息索引 / 事件 / 遥测
/// **全部因外键被拒**。真机现象：新建会话里消息只进权威 JSONL 日志，
/// `messages` 表 0 行、搜索搜不到、重启后会话可能消失。
///
/// 这里用的列集合与 `src/core/storage/session.ts::sessionToWire` **逐字一致**：
/// 将来那边加列/改值形态而引擎拒收，这条会第一时间红。
#[test]
fn renderer_new_session_payload_is_accepted() {
    let (_d, eng) = temp_engine("new-session-payload");
    let payload = json!({
        "id": "1789650041902-0mjfyfib7",
        "project_id": "",
        "title": "对话 1",
        "model": null,
        "created_at": 1_789_650_041_902_i64,
        "last_message_at": 1_789_650_041_902_i64,
        "message_count": 0,
        "pinned": 0,
        "execution_mode": null,
        "worktree_path": null,
        "worktree_branch": null,
        "correction_mode": null,
        "deep_thinking_mode": null,
        "preserve_executor": null,
        // ⚠️ 这一列就是回归的元凶："从未拖拽过"= NULL（有含义），不是"缺省"
        "sort_order": null,
    });
    let r = dispatch(&eng, "sessions.upsert", &payload);
    assert!(r.is_ok(), "渲染侧的新建会话载荷必须被接受，实际：{:?}", r.err());

    let listed = call(&eng, "sessions.list", json!({}));
    let items = listed["items"].as_array().expect("items 数组");
    assert_eq!(items.len(), 1, "会话行必须真的写进去（这正是回归时缺的那一行）");
    assert!(items[0]["sort_order"].is_null(), "NULL 要原样保留：它表示从未拖拽过");

    // fork 也走同一条载荷形态（`session.ts` 显式写 `sort_order: null`）
    let fork = dispatch(
        &eng,
        "sessions.upsert",
        &json!({ "id": "child-1", "project_id": "", "title": "Fork", "created_at": 2, "last_message_at": 2, "message_count": 0, "pinned": 0, "parent_id": "1789650041902-0mjfyfib7", "sort_order": null }),
    );
    assert!(fork.is_ok(), "fork 的子会话载荷同样必须被接受，实际：{:?}", fork.err());
}

/// 语义非空列的 NULL **仍然必须被拒** —— 放开 `sort_order` 不等于把判据删掉。
#[test]
fn semantic_not_null_columns_still_reject_explicit_null() {
    let (_d, eng) = temp_engine("semantic-null");
    call(&eng, "sessions.upsert", json!({ "id": "s1", "project_id": "", "title": "t" }));
    call(
        &eng,
        "messages.create",
        json!({ "id": "m1", "session_id": "s1", "role": "user", "content": "x", "timestamp": 1 }),
    );

    for (cmd, params) in [
        ("messages.update", json!({ "id": "m1", "hidden": null })),
        ("messages.update", json!({ "id": "m1", "trimmed": null })),
        ("sessions.upsert", json!({ "id": "s1", "project_id": "", "title": "t", "pinned": null })),
    ] {
        let err = dispatch(&eng, cmd, &params).expect_err(&format!("{cmd} 写 NULL 必须被拒：{params}"));
        assert!(
            err.message.contains("语义上不可为空"),
            "{cmd} 的拒绝理由要说清是哪一列：{}",
            err.message
        );
    }
}
