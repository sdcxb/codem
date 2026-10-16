/**
 * `@codem/shell-ops` —— 用 Codem 插件机制实现的 shell 路由插件（入口/元数据）。
 *
 * ## 守的缺陷（真机）
 *
 * Codem 的 `bash` 工具在 Windows 上**实际执行 Windows PowerShell 5.1**
 * （`src-tauri/src/lib.rs` 里写死 `Command::new("powershell")`）。模型按 bash 习惯写命令，
 * 于是反复撞 5.1 的坑（本地实测 2026-10-15）：
 *
 * | 坑 | PowerShell 5.1 | bash |
 * |---|---|---|
 * | `&&` 链式 | 语法错误 | 正常 |
 * | `Set-Content -Encoding UTF8` | 写出 **BOM**（炸 JSON/PostCSS 解析） | 不写 |
 * | 单元素数组转 JSON | 降级成标量 | 用 jq 不降级 |
 * | heredoc / 引号 | 转义地狱 | 原样 |
 *
 * 每次报错 = 一轮「读错误 → 改写 → 再试」，这就是被浪费的 token、时间与注意力。
 *
 * ## 插件做什么（两件事，缺一不可）
 *
 * 1. **真 bash**：执行器换成真正的 bash（Git Bash / 显式配置的路径）；
 * 2. **硬锁回退**：启用期间拒绝点名 `powershell` 的命令；**bash 解析不到时大声失败**，
 *    绝不悄悄退回 PowerShell。两条都在**执行之前**判定（结构约束，不靠提示词）。
 *
 * 出口：Windows 原生活儿（cmdlet / 注册表 / 服务 / COM）走 **PowerShell 7**（`pwsh`）。
 *
 * ## 独立性
 *
 * 可启停：注册进插件管理器（`registerBuiltinPlugin`），状态走既有持久化；
 * 可删除：代码只在本目录 + `builtin-registry.ts` 一行注册 + 消费方一次取值。
 *
 * ## 导出面（2026-10-16 收口，knip 棘轮逼出来的）
 *
 * 包入口**只转出装配真正需要的那一个符号**（`shellOpsProvider` —— `builtin-registry` 用它）。
 * 之前这里把 `policy` / `provider` 的 19 个名字全部原样转出，而它们**没有任何生产消费者**
 * （只有测试与这个 barrel 自己引用）：knip 实测 `exports=73 / types=25`（基线 49/21），
 * 多出来的 24+4 条**全部**来自本插件。删掉这层间接后回到 49/21，新增 0 条。
 *
 * 需要判定或需要服务的人**直接 import 对应模块**（`./policy`、`./provider`）。
 */

export { shellOpsProvider } from "./provider";
