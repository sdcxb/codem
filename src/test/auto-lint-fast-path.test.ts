/**
 * 第 42 波：**写入/编辑后的自动 lint 必须是"快路径"** ✓ —— 目标② 的实测着力点 ✓。
 *
 * ## 为什么（**先是量出来的，不是猜的** ✓）
 *
 * 目标② 拆账（`.preview-shot/_tool-durations.mjs` ✓，12 个侧车、249 个工具批）：
 * ```
 * 工具执行占会话跨度 **42%** ✓；其中 bash 1901s（基本是测试）✓
 * edit / multi_edit / write 共 63 批 ≈ 416s ✓ 单批最大 15.8s ✓
 * read（对照）69 批只 8s、均 0.1s ✓ ⇒ 这笔时间**在工具内部**，不是循环开销 ✓
 * ```
 * 而 `tools.ts::autoLint` 每次写入/编辑后跑的是 **`npx tsc --noEmit --pretty <文件>`** ✓ ——
 * 实测 **5.5 s/次** ✓（`node` 直接 `--check` 只要 **0.17 s** ✓；tsc 加 `--noResolve` 后 1.4~1.9 s ✓）。
 *
 * ## 判据（**功能不许丢，只许变快** ✓）
 *
 * | id | 钉什么 | 变异（应当红 ✗） |
 * |---|---|---|
 * | `LINT-1` | `.ts` **语法坏** ⇒ 必须报出来（带 `[lint]` ✓）| 快路径只返回 null（静默 ✗）|
 * | `LINT-2` | 反向对照：`.ts` **语法好** ⇒ 不许报 ✓ | 总是报 ✗ |
 * | `LINT-3` | 结构：`.ts` 走 **`node … --check`** ✓（**不许**再 `npx tsc` ✗）| 改回 tsc ⇒ 红 |
 * | `LINT-4` | 结构：`.tsx` 走 tsc 且**带 `--noResolve`** ✓（node 不认 `.tsx` ✗ —— 实测 `ERR_UNKNOWN_FILE_EXTENSION` ✓）| 把 `.tsx` 交给 node ⇒ 红 |
 * | `LINT-5` | 路径仍**单引号包裹 + 转义** ✓（既有的防 `$` 展开规则不许丢 ✗）| 换成双引号 ⇒ 红 |
 */
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";

/**
 * ★ 忠实桩（本仓库的既定手法 ✓）：只替换**IPC 那一层** ——
 * 把 `executeCommand` 接到**真的 PowerShell** 上跑真命令 ✓（`powershell -NoProfile -Command` ✓，
 * 与产品的 Rust 侧同一条路 ✓）。这样 `autoLint` 的**命令字符串本身**是被真跑的 ✓
 * —— 否则"快路径到底查不查得出语法错"就只是我在读字符串 ✗。
 */
vi.mock("../core/file-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../core/file-api")>();
  return {
    ...actual,
    executeCommand: async (cmd: string) => {
      const r = spawnSync("powershell", ["-NoProfile", "-Command", cmd], { encoding: "utf8", timeout: 60_000 });
      return { exitCode: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    },
  };
});

import { autoLint } from "../core/llm/tools";
import { stripComments } from "./helpers/settings-key-scan";

const TOOLS_SRC = () =>
  stripComments(readFileSync(join(process.cwd(), "src", "core", "llm", "tools.ts"), "utf8"));

describe("第 42 波：autoLint 的快路径（目标② 的实测着力点）", () => {
  it("LINT-1: `.ts` 语法坏 ⇒ 必须报出来（快路径不许把功能吃掉 ✗）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "autolint-"));
    const file = join(dir, "broken.ts");
    writeFileSync(file, "const a: number = 1;\nfunction f({\n", "utf8");
    try {
      const out = await autoLint(file);
      expect(out, "语法坏必须报（这是这个功能的全部意义 ✓）").not.toBeNull();
      expect(String(out)).toContain("[lint]");
      console.log("[LINT-1] 报出来的内容：", JSON.stringify(String(out).slice(0, 200)));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("LINT-2 反向对照: `.ts` 语法好 ⇒ 不许报", async () => {
    const dir = mkdtempSync(join(tmpdir(), "autolint-"));
    const file = join(dir, "ok.ts");
    writeFileSync(file, "export const a: number = 1;\nexport function f(x: number): number {\n  return x + a;\n}\n", "utf8");
    try {
      expect(await autoLint(file), "语法好的文件不许产 lint 噪音 ✓").toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it("LINT-3: 结构 —— `.ts` 走 `node … --check`（不许再 `npx tsc` ✗，那是 5.5s ⇒ 0.17s 的差 ✓）", () => {
    const src = TOOLS_SRC();
    const ts = /"\.ts":\s*\{[^}]*\}/.exec(src)?.[0] ?? "";
    console.log("[LINT-3] .ts 项：", ts.replace(/\s+/g, " "));
    expect(ts, "拿不到 .ts 的 lint 命令 ⇒ 判据自己先失效 ✗").not.toBe("");
    expect(ts, "`.ts` 必须走 node 的 --check（实测 0.17s ✓）").toContain("--check");
    expect(ts, "`.ts` 不许再走 npx tsc（实测 5.5s ✗）").not.toContain("tsc");
  });

  it("LINT-4: 结构 —— `.tsx` 走 tsc 且带 `--noResolve`（node 不认 .tsx ✗）", () => {
    const src = TOOLS_SRC();
    const tsx = /"\.tsx":\s*\{[^}]*\}/.exec(src)?.[0] ?? "";
    console.log("[LINT-4] .tsx 项：", tsx.replace(/\s+/g, " "));
    expect(tsx, "拿不到 .tsx 的 lint 命令 ⇒ 判据自己先失效 ✗").not.toBe("");
    expect(tsx, "`.tsx` 要用 tsc（node --check 对 .tsx 直接 ERR_UNKNOWN_FILE_EXTENSION ✗）").toContain("tsc");
    expect(tsx, "tsc 必须带 --noResolve（实测 5.5s ⇒ 1.85s ✓）").toContain("--noResolve");
  });

  it("LINT-5: 路径仍单引号包裹 + 单引号转义（防 PowerShell 把 $ 展开 ✗）", () => {
    const src = TOOLS_SRC();
    expect(src, "必须仍按单引号转义（'' ✓）").toContain("replace(/'/g, \"''\")");
    expect(src, "命令里必须用单引号包路径").toMatch(/'\$\{safeFile\}'/);
    expect(src, "不许出现双引号包路径").not.toMatch(/"\$\{safeFile\}"/);
  });
});
