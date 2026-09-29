/**
 * 浏览器侧的 `node:fs` 桩。
 *
 * # ⚠️ 这里的函数**不会真的访问磁盘**
 *
 * 在 Tauri 里，文件操作走 IPC（`window.__TAURI__.core.invoke`，见 `core/file-api.ts`）。
 * `vite.config.ts` 把这个模块 alias 成 `node:fs`，于是**渲染进程里没有真的 fs**。
 * 下面这些实现返回的都是"空形状"：
 *
 * | 函数 | 返回 | 真实语义 |
 * |---|---|---|
 * | `existsSync` | **恒 `false`** | 是「**不知道**」，不是「不存在」 |
 * | `readFileSync` | `""` | 是「**读不到**」，不是「空文件」 |
 * | `readdirSync` | `[]` | 是「**列不出来**」，不是「空目录」 |
 * | `statSync` | `{}` | 是「**没有信息**」 |
 *
 * ## 为什么必须把这句话写在文件里（第 122 轮的事故）
 *
 * 我给「开启新对话（交接当前工作）」写 `src/core/session/ui-handoff.ts` 时，
 * 用 `import { existsSync } from "node:fs"` 核实"这条路径真的在磁盘上吗"。结果：
 *
 * - **Node / Vitest**：真 `fs`，工作正常，8 条用例全绿；
 * - **装机版**：`existsSync` 恒 `false` ⇒ `verifiedPaths` 永远为空 ⇒
 *   `primaryPath` 永远为 null ⇒ 交接正文永远没有绝对路径 ⇒ 协议校验永远拒绝
 *   ⇒ **这个按钮在真机上完全不可用**，而测试一个都不红。
 *
 * 真机诊断印在提示条上的原文把它钉死了：
 * ```
 * ［cwd="C:\Users\abee\AppData\Roaming\com.codem.app\workspace\" home="" homeExists=false effective=null］
 * ```
 * cwd 明明是**真实存在**的目录，`existsSync` 却说它不存在；而 `homeExists` 是
 * `false` 而不是"抛错" ⇒ 它在正常返回，只是永远返回 false。
 *
 * ## 正确用法
 *
 * 需要"真的问磁盘"时**不要**用这个模块：
 * - 渲染进程 → `core/file-api.ts`（`exists` / `readFile` / `listDirectory` …，走 Tauri IPC）；
 * - 需要在纯函数里判断存在性 → 把检查器**注入**进去
 *   （范例见 `ui-handoff.ts` 的 `ExistsChecker`）；
 * - 只在 Node 侧跑的脚本（`core/skills/**` 之类）→ 用真 `node:fs` 没问题，
 *   它们不进浏览器 bundle。
 *
 * 这条约定由 `src/test/renderer-standin-guards.test.ts` 的 STUB-* 判据守着。
 */

export const existsSync = (_path: string): boolean => false
export const mkdirSync = (_path: string, _opts?: any): void => {}
export const writeFileSync = (_path: string, _data: any, _opts?: any): void => {}
export const readFileSync = (_path: string, _opts?: any): string => ""
export const readdirSync = (_path: string): string[] => []
export const unlinkSync = (_path: string): void => {}
export const statSync = (_path: string): any => ({})
export const promises = {
  readFile: async (_path: string, _opts?: any): Promise<string> => "",
  writeFile: async (_path: string, _data: any, _opts?: any): Promise<void> => {},
  mkdir: async (_path: string, _opts?: any): Promise<void> => {},
  readdir: async (_path: string): Promise<string[]> => [],
  stat: async (_path: string): Promise<any> => ({}),
  exists: async (_path: string): Promise<boolean> => false,
  unlink: async (_path: string): Promise<void> => {},
}
export default { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, unlinkSync, statSync, promises }
