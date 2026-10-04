/**
 * 第 114 波：**门禁 —— 前端可达的代码不许把 `node:fs` 当真的用**。
 *
 * ## 为什么必须有一条门禁（这是第三次踩同一个坑了）
 *
 * `vite.config.ts` 把前端的 `fs` / `node:fs` alias 到 `src/stubs/node-fs-stub.ts`，
 * 而那个桩**不会访问磁盘**：
 *
 * | 桩函数 | 返回 | 真实语义 |
 * |---|---|---|
 * | `readdirSync` | **`[]`** | 「**列不出来**」，不是「空目录」 |
 * | `readFileSync` | `""` | 「读不到」 |
 * | `existsSync` | `false` | 「不知道」 |
 * | `statSync` | `{}` | 「没有信息」 |
 *
 * ⇒ 前端代码一旦用它，**在 Node/Vitest 里一切正常 ✓、在装机版里静默失效** ✗，
 * 而所有判据都是绿的 ✗。历史上已经栽过两次：
 * ① 第 122 轮 `ui-handoff.ts`（`existsSync` 恒 false ⇒ 交接按钮真机完全不可用）；
 * ② 第 113 波 `task-keyword-search.ts`（`readdirSync` 恒 `[]` ⇒ 两个提示机制
 *   在 1.16.236/237/238 三个版本里**一次都没生效** ✗，而判据全绿 ✗）。
 *
 * ## 这条门禁的口径
 *
 * 扫 `src/core/llm/**` 的**生产**文件（排除 `*.test.*` 与测试夹具），
 * 只要出现 `from "node:fs"` / `from "fs"` 就报违规 ✗ —— 前端可达的模块要用
 * `core/file-api.ts` 的 IPC 接口（`listDirectory` / `readFile` / `readTextWindow`）。
 *
 * 变异自证：把 `task-keyword-search.ts` 的 import 改回 `node:fs` ⇒ 本判据必须红。
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/** 递归收集目录下的生产 TS 文件（排除测试与夹具） */
function productionFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue;
      if (/\.test\.(ts|tsx)$/.test(entry.name)) continue;
      if (/[\\/](test|tests|__tests__|fixtures)[\\/]/.test(full)) continue;
      out.push(full);
    }
  };
  if (statSync(root).isDirectory()) walk(root);
  return out;
}

const FS_IMPORT_RE = /from\s+["'](?:node:)?fs["']/;

describe("第 114 波：前端可达代码不许把 node:fs 当真（它是桩，真机静默失效）", () => {
  it("FSG-1: src/core/llm 的生产文件里不许出现 `from \"node:fs\"` / `from \"fs\"`", () => {
    const root = join(process.cwd(), "src", "core", "llm");
    const offenders: string[] = [];
    for (const file of productionFiles(root)) {
      const text = readFileSync(file, "utf8");
      if (FS_IMPORT_RE.test(text)) offenders.push(relative(process.cwd(), file).replace(/\\/g, "/"));
    }
    expect(
      offenders,
      `这些前端可达的模块用了 node:fs —— 在装机版里拿到的是桩（readdirSync 恒 [] / existsSync 恒 false）` +
        `⇒ 功能会**静默失效**，而判据全绿 ✗。请改用 core/file-api.ts 的 IPC 接口：\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });

  it("FSG-2 反向对照: 门禁自己得认得出来（拿一段已知违规的文本试）", () => {
    // 反向对照：这条正则必须能抓住真实写法，否则门禁是空的
    expect(FS_IMPORT_RE.test(`import { readdirSync } from "node:fs";`)).toBe(true);
    expect(FS_IMPORT_RE.test(`import { readFileSync } from "fs";`)).toBe(true);
    expect(FS_IMPORT_RE.test(`import { listDirectory } from "../file-api";`)).toBe(false);
  });
});
