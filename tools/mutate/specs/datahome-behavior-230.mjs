/**
 * 变异自证（第 230 波 · Rust 侧行为判据）：`CODEM_DATA_HOME` 的**语义**
 * （`storage::tests::ISO-1`…`ISO-3` 与接线那条）。
 *
 * 运行面是 `cargo`（`runner: "cargo"`）：`tests` 是 libtest 的位置过滤串，
 * **逐个单跑**，只认 `test <路径> ... FAILED` 且路径含该过滤串
 * （编译错误、别的用例红了都记 `error`，不算"判据变红"—— 这是本仓的变异纪律）。
 *
 * | 变异 | 坏法 | 必须红在哪 |
 * | --- | --- | --- |
 * | MUT-1 | 隔离根分支恒假（开关被短路） | `data_home_env_moves_the_whole_root_and_empty_means_unset` |
 * | MUT-2 | `resolve_db_path` 不再把隔离根传进去（接线断） | `resolve_db_path_reads_data_home_env_and_returns_when_unset` |
 * | MUT-3 | 补齐目录时不真的建（`if false`） | `ensure_isolated_root_creates_every_required_dir` |
 * | MUT-4 | 默认档被改坏（委托时把 `CODEM_DB_PATH` 丢掉） | `default_resolution_is_identical_to_pre_230_rules` |
 *
 * MUT-4 是"默认路径逐字节不变"那条的正向证明：它把**非隔离**那一侧改坏，
 * 判据必须红 —— 否则那条判据只是在证明"代码里有一行 if"。
 */
export default {
  description:
    "第 230 波：隔离数据根的 Rust 行为判据（默认逐字段不变 / 设了就整根走 / 空串等于没设 / 补齐必需目录 / 接线真读环境变量）",
  mutations: [
    {
      id: "MUT-1 隔离根分支恒假（开关被短路）",
      why:
        "设了 CODEM_DATA_HOME 也拿不到隔离根 ⇒ 库与日志回落到真目录；" +
        "这条与 MUT-2 的区别是它短路的是「解析」那一层（纯函数），而 MUT-2 短路的是「接线」",
      runner: "cargo",
      patches: [
        {
          file: "src-tauri/src/storage.rs",
          from: "    if let Some(root) = data_home {\n        return ResolvedDbPath {",
          to: "    if let Some(root) = data_home.filter(|_| false) {\n        return ResolvedDbPath {",
        },
      ],
      tests: ["storage::tests::data_home_env_moves_the_whole_root_and_empty_means_unset"],
      expectRed: true,
    },
    {
      id: "MUT-2 resolve_db_path 不再把隔离根传进去（接线断）",
      why: "纯函数是对的、但没人调用它的隔离分支 ⇒ 真机行为与默认完全一样（这类「接不上线」最难靠读代码发现）",
      runner: "cargo",
      patches: [
        {
          file: "src-tauri/src/storage.rs",
          from: '        isolated_data_home(),\n        std::env::var_os("CODEM_DB_PATH"),',
          to: '        None,\n        std::env::var_os("CODEM_DB_PATH"),',
        },
      ],
      tests: ["storage::tests::resolve_db_path_reads_data_home_env_and_returns_when_unset"],
      expectRed: true,
    },
    {
      id: "MUT-3 补齐目录时不真的建（if false）",
      why: "`ensure_isolated_root` 返回 Ok 但一个目录都没建 ⇒ 隔离根不齐，而调用方拿到的是「成功」",
      runner: "cargo",
      patches: [
        {
          file: "src-tauri/src/storage.rs",
          from: "        if !p.exists() {\n            std::fs::create_dir_all(&p)",
          to: "        if false {\n            std::fs::create_dir_all(&p)",
        },
      ],
      tests: ["storage::tests::ensure_isolated_root_creates_every_required_dir"],
      expectRed: true,
    },
    {
      id: "MUT-4 默认档被改坏（委托时把 CODEM_DB_PATH 丢掉）",
      why:
        "非隔离那一侧被改坏（`CODEM_DB_PATH` 失效）⇒ 「默认路径逐字节不变」那条必须红；" +
        "否则它只是在证明「代码里有一个 if」，不是在证明默认路径真的没变",
      runner: "cargo",
      patches: [
        {
          file: "src-tauri/src/storage.rs",
          from: "    resolve_db_path_from(explicit, known_folder, xdg, home, userprofile)\n}",
          to: "    resolve_db_path_from(None, known_folder, xdg, home, userprofile)\n}",
        },
      ],
      tests: ["storage::tests::default_resolution_is_identical_to_pre_230_rules"],
      expectRed: true,
    },
  ],
};
