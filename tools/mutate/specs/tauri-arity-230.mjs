/**
 * 变异自证（第 230 波 · 判据 `TAURI-ARITY-1` / `TAURI-ARITY-2`）：
 * **命令签名与 Rust 侧调用点必须同步**。
 *
 * 这一波守的是一个真缺陷（本轮实测）：`execute_command` 加了 `shell` / `bash_path` 两个形参，
 * 而 `lib.rs` 里三条 `#[tokio::test]` 用例还按 3 参调用 ⇒ `E0061 ×3` ⇒
 * **`cargo test --lib` 在 HEAD 上根本编译不过**，而平时的门禁一条都看不见它。
 *
 * | 变异 | 坏法 | 必须红在哪 |
 * | --- | --- | --- |
 * | MUT-1 | 某条用例**少传一个实参**（正是本轮真缺陷的形状） | `TAURI-ARITY-1` |
 * | MUT-2 | 某条用例**多传一个实参** | `TAURI-ARITY-1` |
 * | MUT-3 | 给命令**加一个形参**却不改调用点 | `TAURI-ARITY-1` / `TAURI-ARITY-2` |
 *
 * MUT-3 刻意从"签名那一侧"改坏：这证明判据不是只盯着调用点（两边任何一边动都会红）。
 */
export default {
  description:
    "第 230 波：`#[tauri::command]` 的形参个数与 lib.rs 里调用实参个数必须一致（挡住「改了签名忘了改 Rust 测试」⇒ cargo test --lib 编不过）",
  mutations: [
    {
      id: "MUT-1 某条用例少传一个实参（本轮真缺陷的形状）",
      why:
        "TAURI-ARITY-1：`execute_command` 是 5 参而这里只给 4 个 ⇒ 编译期 E0061 ⇒ 整个 Rust 单测面静默消失",
      patches: [
        {
          file: "src-tauri/src/lib.rs",
          from: "        let ok = execute_command(\"Write-Output 'hello-185'\".to_string(), None, Some(30_000), None, None)",
          to: "        let ok = execute_command(\"Write-Output 'hello-185'\".to_string(), None, Some(30_000), None)",
        },
      ],
      tests: ["src/test/tauri-command-test-arity.test.ts"],
      expectRed: true,
    },
    {
      id: "MUT-2 某条用例多传一个实参",
      why: "TAURI-ARITY-1：反过来多给一个也会 E0061（判据必须两边都看得见，不能只查「够不够」）",
      patches: [
        {
          file: "src-tauri/src/lib.rs",
          from: "            Some(120_000),\n            None,\n            None,\n        )",
          to: "            Some(120_000),\n            None,\n            None,\n            None,\n        )",
        },
      ],
      tests: ["src/test/tauri-command-test-arity.test.ts"],
      expectRed: true,
    },
    {
      id: "MUT-3 给命令加一个形参却不改调用点",
      why:
        "TAURI-ARITY-1 / TAURI-ARITY-2：从**签名那一侧**改坏 —— 证明这条判据不是只盯着调用点，" +
        "而是两边任何一边动都会红（这正是本轮缺陷的成因方向）",
      patches: [
        {
          file: "src-tauri/src/lib.rs",
          from: "    // 显式 bash 路径（插件设置来的）；为空则按标准位置探测。\n    bash_path: Option<String>,\n) -> Result<serde_json::Value, String> {",
          to: "    // 显式 bash 路径（插件设置来的）；为空则按标准位置探测。\n    bash_path: Option<String>,\n    extra_probe: Option<String>,\n) -> Result<serde_json::Value, String> {",
        },
      ],
      tests: ["src/test/tauri-command-test-arity.test.ts"],
      expectRed: true,
    },
  ],
};
