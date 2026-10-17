/**
 * 变异自证（第 230 波 · 判据 `ISO-S1`…`ISO-S6`）：隔离数据根 `CODEM_DATA_HOME` 的**接线**。
 *
 * 这一波守的是"**整根**跟着走"这件事：漏接一处，隔离钻取就仍然在写用户的真目录
 * （第 229 波真机实测过的形态）。所以每条变异都针对一个真实会漏的口子：
 *
 * | 变异 | 漏法 | 必须红在哪 |
 * | --- | --- | --- |
 * | MUT-1 | 应用数据目录的唯一入口不再看隔离根 | `ISO-S2` |
 * | MUT-2 | 运行日志目录不再看隔离根 | `ISO-S3` |
 * | MUT-3 | 插件目录退回真目录（`app_data_dir()` 又多一处） | `ISO-S2` / `ISO-S4` |
 * | MUT-4 | 必需目录表少一条（表与消费方分叉） | `ISO-S5` |
 * | MUT-5 | TS 侧把 `sessions` 目录改名（表没跟着改） | `ISO-S5` |
 * | MUT-6 | 空串不再算「没设」（`filter(|s| !s.is_empty())` 被去掉） | `ISO-S1` |
 *
 * 行为面（"设了就整根走 / 默认路径不变 / 补齐目录"）在 cargo 波次 `datahome-behavior-230` 里，
 * 两侧刻意分开：`specRunner()` 规定同一波次不许混两种运行面。
 */
export default {
  description:
    "第 230 波：CODEM_DATA_HOME 的接线不变量（ISO-S1..S6）—— 读点唯一、app_data_dir 只剩一处、日志/功能目录同入口、必需目录表与消费方对齐",
  mutations: [
    {
      id: "MUT-1 唯一入口不再看隔离根（lib.rs::app_data_dir_path）",
      why:
        "ISO-S2：这是「整根」唯一的收口点。它一看不见隔离根，get_app_data_dir / 默认工作目录 / " +
        "崩溃标记 / panic 现场 / 插件 / 手机 全部回落到真目录",
      patches: [
        {
          file: "src-tauri/src/lib.rs",
          from: "    if let Some(root) = storage::isolated_data_home() {\n        return Ok(root);\n    }\n    app.path().app_data_dir().map_err(|e| e.to_string())",
          to: "    app.path().app_data_dir().map_err(|e| e.to_string())",
        },
      ],
      tests: ["src/test/data-home-isolation-switch.test.ts"],
      expectRed: true,
    },
    {
      id: "MUT-2 运行日志目录不再看隔离根（default_base_dir）",
      why: "ISO-S3：运行日志是「这次进程写进数据根的东西」，隔离钻取时它落在真目录 = 没隔离",
      patches: [
        {
          file: "src-tauri/src/runtime_log.rs",
          from: "    if let Some(root) = crate::storage::isolated_data_home() {\n        return root;\n    }\n",
          to: "",
        },
      ],
      tests: ["src/test/data-home-isolation-switch.test.ts"],
      expectRed: true,
    },
    {
      id: "MUT-3 插件目录退回真目录（ofm.rs）",
      why: "ISO-S2 / ISO-S4：插件数据目录（含几百 MB 便携 Node）会写进真目录；同时 app_data_dir() 出现第二处调用",
      patches: [
        {
          file: "src-tauri/src/ofm.rs",
          from: "    let dir = crate::app_data_dir_path(&app)\n        .map_err(|e| format!(\"取不到应用数据目录：{e}\"))?\n        .join(OFM_EXTENSION_DIR);",
          to: "    let dir = app\n        .path()\n        .app_data_dir()\n        .map_err(|e| format!(\"取不到应用数据目录：{e}\"))?\n        .join(OFM_EXTENSION_DIR);",
        },
      ],
      tests: ["src/test/data-home-isolation-switch.test.ts"],
      expectRed: true,
    },
    {
      id: "MUT-4 必需目录表少了 sessions",
      why: "ISO-S5：`ensure_isolated_root` 不再建 `sessions/` ⇒ 隔离根不是齐的（权威日志落点没了）",
      patches: [
        {
          file: "src-tauri/src/storage.rs",
          from: 'pub const ISOLATED_ROOT_SUBDIRS: &[&str] = &["sessions", "attachments", "spill", ".codem/skills"];',
          to: 'pub const ISOLATED_ROOT_SUBDIRS: &[&str] = &["attachments", "spill", ".codem/skills"];',
        },
      ],
      tests: ["src/test/data-home-isolation-switch.test.ts"],
      expectRed: true,
    },
    {
      id: "MUT-5 TS 侧把 sessions 目录改名（表没跟着改）",
      why:
        "ISO-S5：这条变异模拟「消费方改了目录名而 Rust 那张表没跟着改」 —— " +
        "它证明那张表不是抄在注释里的一份死清单，而是**被源码对着核**的",
      patches: [
        {
          file: "src/core/storage/session-jsonl.ts",
          from: "cachedDir = `${base}sessions${sep}`;",
          to: "cachedDir = `${base}session-logs${sep}`;",
        },
      ],
      tests: ["src/test/data-home-isolation-switch.test.ts"],
      expectRed: true,
    },
    {
      id: "MUT-6 空串不再算「没设」（filter 被去掉）",
      why:
        "ISO-S1：`set CODEM_DATA_HOME=` 会留下一个存在的空变量 ⇒ 数据根被解析成相对的当前目录 ⇒ " +
        "第 55 轮真事故的形态（数据落进工作目录）",
      patches: [
        {
          file: "src-tauri/src/storage.rs",
          from: "pub(crate) fn isolated_data_home_from(v: Option<std::ffi::OsString>) -> Option<PathBuf> {\n    v.filter(|s| !s.is_empty()).map(PathBuf::from)",
          to: "pub(crate) fn isolated_data_home_from(v: Option<std::ffi::OsString>) -> Option<PathBuf> {\n    v.map(PathBuf::from)",
        },
      ],
      tests: ["src/test/data-home-isolation-switch.test.ts"],
      expectRed: true,
    },
  ],
};
