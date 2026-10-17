/**
 * 第 155 波：**先验前提** —— 新收尾提醒在真实仓库里对 `src/core/llm/tools.ts` 找不找得到同族判据？
 *
 * 为什么必须先验 ✗：1.16.251 之前，同族判据这套机制**在真机上一次都没产出过** ✗，
 * 原因有两个（grep 行按 `:` 切拿到盘符 `C` ✗、只试最长的 3 个符号 ✗），都已修 ✓ ——
 * 但修完之后我只在 `tmp-*.mjs` 上见过它产出 ✓，**没有**再确认过 `tools.ts` ✓。
 * 如果它现在仍然是 null ✗，那本波加的那条收尾提醒就是**哑的** ✗（等于没加 ✓）。
 *
 * ⚠️ 第 231 波：两条用例给**显式超时 20 秒**。它们要对真实仓库跑一遍 grep
 * （`siblingCriteriaFiles` ⇒ `nodeGrepSource`），是整树扫描：单跑约 **1.1–1.2 秒**，
 * 但全量 8 worker 并行时实测撞过默认 5000ms（`Test timed out in 5000ms`，断言还没跑到）。
 * 抬超时不动任何断言 —— 只是不再把「机器此刻忙」误报成「机制失效」。
 */
import { describe, expect, it } from "vitest";
import { siblingCriteriaFiles, unrunSiblingCriteria } from "../core/llm/task-keyword-search";
import { nodeFsSource } from "./helpers/node-fs-source";
import { nodeGrepSource } from "./helpers/node-grep-source";

const SCAN_TIMEOUT_MS = 20_000;

describe("第 155 波：收尾提醒的前提（真实仓库里能不能找到同族判据）", () => {
  it("PREM-1: `src/core/llm/tools.ts` 必须能找到同族判据文件（否则提醒是哑的 ✗）", async () => {
    const files = await siblingCriteriaFiles(process.cwd(), "src/core/llm/tools.ts", {
      src: nodeFsSource(),
      search: nodeGrepSource(),
    });
    console.log("[前提] tools.ts 的同族判据：", JSON.stringify(files));
    expect(
      files.length,
      "改了这个文件却一条同族判据都找不到 ⇒ 收尾提醒永远不会触发 ✗（这正是 251 波之前那类'机制静默失效'✗）",
    ).toBeGreaterThan(0);
  }, SCAN_TIMEOUT_MS);

  it("PREM-2: 一条都没跑过时，判定必须把找到的判据点出来", async () => {
    const files = await siblingCriteriaFiles(process.cwd(), "src/core/llm/tools.ts", {
      src: nodeFsSource(),
      search: nodeGrepSource(),
    });
    const unrun = unrunSiblingCriteria({
      editedSources: ["src/core/llm/tools.ts"],
      siblingsOf: new Map([["src/core/llm/tools.ts", files]]),
      runStatus: new Map(),
    });
    console.log("[前提] 判定结果：", JSON.stringify(unrun));
    expect(unrun.length, "没跑过任何判据 ⇒ 必须点出来").toBe(Math.min(files.length, 6));
  }, SCAN_TIMEOUT_MS);
});
