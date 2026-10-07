/**
 * `BUSY`（第 309 波）：跑批的"界面在干活吗"**必须认得出应用真正渲染的措辞** ✓
 *
 * ## 守的缺陷（**真机留档换来的** ✓，归档 §13.237）
 *
 * `r289` 的 `busySamples`（留档 ✓，逐字 ✓）：
 * ```
 *  13s busy=True   … 处理中 · 10s 第1/5步 …
 * ★19s busy=False … **正在执行工具** · 16s 第2/5步 …   ← 界面在显示，探针不认
 * ```
 * ⇒ 于是 `stable` 先到 `3/3` ✓，跑批在 **`引擎静默=6s`** 时就判"跑完" ✓
 * ⇒ **把应用的应用层收尾全部掐掉** ✓（`收尾段` / `nudge` / `turn_end` 在控制台**全 0 行** ✓）。
 *
 * ## 这个判据的两条腿（**缺一条都不行** ✓）
 *
 * | 腿 | 钉什么 |
 * |---|---|
 * | **① 覆盖** ✓ | 应用**实际渲染**的每一个状态措辞，探针**都要认** ✓ |
 * | **② 不放松** ✗ | **不许**把"计数文本"之类**并非状态宣告**的东西算成"在干活" ✗ |
 *
 * ⚠️ 第 ② 条是**这条判据真正的价值** ✓：只做第 ① 条会变成"把尺子调松来好看" ✗
 * （§13.237 第五节那条纪律 ✓）。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const HARNESS = readFileSync(join(ROOT, ".preview-shot/_codem-repo-eval.mjs"), "utf8");
const CHATPANEL = readFileSync(join(ROOT, "src/components/ChatPanel.tsx"), "utf8");

/** 从 `StreamingTimer` 的 `statusLabels` 里取出**应用实际渲染**的全部中文措辞 ✓ */
function renderedStatusLabels(): string[] {
  const start = CHATPANEL.indexOf("const statusLabels");
  expect(start, "`StreamingTimer` 的 statusLabels 必须存在（它是权威来源）").toBeGreaterThan(0);
  const block = CHATPANEL.slice(start, start + 900);
  return [...block.matchAll(/zh:\s*"([^"]+)"/g)].map((m) => m[1]);
}

/** 取出 `BUSY_PROBE` 里那个 `busyText` 正则的字面量 ✓ */
function busyRegexSource(): string {
  const i = HARNESS.indexOf("const busyText =");
  expect(i, "`BUSY_PROBE` 里的 busyText 必须存在").toBeGreaterThan(0);
  const line = HARNESS.slice(i, HARNESS.indexOf("\n", i));
  const m = line.match(/\/(.+?)\//);
  expect(m, "busyText 必须是一个正则字面量").not.toBeNull();
  return String(m?.[1] ?? "");
}

describe("BUSY：界面'在干活吗'的判据必须与应用实际渲染对齐", () => {
  it("BUSY-1: 应用**实际渲染**的每个状态措辞，探针都要认得（★ 本轮修的正是这条）", () => {
    const labels = renderedStatusLabels();
    expect(labels.length, "应当能取到若干状态措辞").toBeGreaterThanOrEqual(3);
    const re = new RegExp(busyRegexSource());
    const missed = labels.filter((l) => !re.test(l));
    expect(
      missed,
      `★ 探针认不出的措辞：${missed.join("、")} —— ` +
        `真机里「正在执行工具」就是被漏认的那个（19s busy=False，而界面正在显示它）`,
    ).toEqual([]);
  });

  it("BUSY-2（反向）: 不许把「计数文本」之类并非状态宣告的东西算成在干活", () => {
    const re = new RegExp(busyRegexSource());
    /**
     * 为什么必须钉这一条 ✗：只做 `BUSY-1` 会变成"**把尺子调松来好看**"✗ ——
     * 「↓ N 条新消息」这类**计数**在真机里经常变化 ✓，但它**可能只是别的会话/维护在刷新** ✗，
     * **不代表这一轮在干活** ✗。用它去判"在干活"会让跑批**永远不会判完** ✗。
     */
    for (const trap of ["↓ 3 条新消息", "12 条新消息", "成功", "已完成 5 步"]) {
      expect(re.test(trap), `不许把「${trap}」这类文本算成"在干活"（那是调松尺子）`).toBe(false);
    }
  });

  it("BUSY-3: 「停止」按钮那条腿必须还在（两腿都要）", () => {
    expect(HARNESS, "stopBtn 那条腿不许被删（它是最可靠的'在干活'信号）").toMatch(/stopBtn/);
    expect(HARNESS, "busy 必须是 stopBtn **或** busyText").toMatch(/busy:\s*stopBtn\s*\|\|\s*busyText/);
  });
});
