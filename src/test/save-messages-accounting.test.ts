/**
 * 第 45 波：`saveMessages` 的**成本账**必须可信 ✓（目标② 的第三块 ✓，只记不判 ✓）。
 *
 * ## 为什么（**先加留档，别先改逻辑** ✓ —— 交接 §9 ✓）
 *
 * 用**不受背景行污染**的口径量过（`.preview-shot/_console-attribution.mjs` 的"按轮残差"段 ✓）：
 * ```
 * 轮间空档 3755s − 实测工具 2452s = ★ 残差 1303s（占会话跨度 21%）
 * 同期 saveMessages 2945 次 / 落库 11172 条
 * ```
 * 而 `saveMessages` 的调用方是**流式 flush（每 100ms）** ✓ ⇒ 一条消息在一次流式回复里被反复落库 ✓。
 *
 * ⚠️ ★ **≈442ms/次 是推出来的** ✗ ⇒ 所以先只打点 ✓（`S1-1..3`），
 * **量到之后再动手** ✓ —— 本波已经用同一手法**否掉**过一个假设（"逐 delta 写消息行" ⇒ `msgw=0` ✓）。
 *
 * ## 判据
 *
 * | id | 钉什么 | 变异（应当红 ✗） |
 * |---|---|---|
 * | `S1-1` | 记账**忠实**：写了 N 条 ⇒ `msgs === N` ✓（不是"遍历到的条数" ✗）| 记成 `msgs.length` ⇒ 红 |
 * | `S1-2` | **取走即清零** ✓ | 取走不清零 ⇒ 数字越滚越大 ✗ |
 * | `S1-3` | 结构：`llm timing` 行必须带 `save=` 与 `savemsgs=` ✓ | 删掉 ⇒ 红 |
 * | `S1-4` | 结构：`store.ts` 的记账**包住整个写循环** ✓（写在循环外/前 ⇒ 量不到落库 ✗）| 把 `noteSaveBatch` 移到循环前 ⇒ 红 |
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { noteSaveBatch, takeSaveStats, __resetSaveStatsForTests } from "../core/storage/persist-stats";
import { stripComments } from "./helpers/settings-key-scan";

const ROOT = process.cwd();

describe("第 45 波：saveMessages 的成本账（只记不判，目标② 归因用）", () => {
  it("S1-1: 记账忠实 —— 写了 7 条 ⇒ msgs === 7（不是遍历到的条数 ✗）", () => {
    __resetSaveStatsForTests();
    noteSaveBatch(7, 123);
    noteSaveBatch(0, 5);
    const s = takeSaveStats();
    expect(s.calls, "两次调用都要数到").toBe(2);
    expect(s.msgs, "只数**真写下去**的条数（跳过未变化的不算 ✗）").toBe(7);
    expect(s.ms, "累计毫秒").toBe(128);
    expect(s.maxMs, "单次最大 ≤ 累计").toBeLessThanOrEqual(s.ms);
  });

  it("S1-2 反向对照: 取走即清零（两次 take 之间不再记 ⇒ 第二次全 0）", () => {
    __resetSaveStatsForTests();
    noteSaveBatch(3, 40);
    expect(takeSaveStats().calls).toBe(1);
    expect(takeSaveStats(), "取走不清零 ⇒ 每轮读数虚高 ✗").toEqual({ calls: 0, msgs: 0, ms: 0, maxMs: 0 });
  });

  it("S1-3: 结构 —— `llm timing` 那行必须带 `save=` 与 `savemsgs=`", () => {
    const src = stripComments(readFileSync(join(ROOT, "src", "core", "llm", "agentic-loop.ts"), "utf8"));
    expect(src, "要带上这一笔账").toContain("save=${");
    expect(src, "条数也要（只知道「调用了几次」看不出「写了几条」✗）").toContain("savemsgs=");
    expect(src, "账要从 core 侧模块取（不许 core 反向依赖 UI ✗）").toContain("takeSaveStats");
  });

  it("S1-4: 结构 —— 记账必须**包住整个写循环**（写在外面 ⇒ 量不到落库 ✗）", () => {
    const src = stripComments(readFileSync(join(ROOT, "src", "store.ts"), "utf8"));
    const t0 = src.indexOf("const __saveT0 = performance.now();");
    const note = src.indexOf("noteSaveBatch(written, performance.now() - __saveT0);");
    expect(t0, "找不到起点 ⇒ 判据自己先失效 ✗").toBeGreaterThan(-1);
    expect(note, "找不到记账 ⇒ 判据自己先失效 ✗").toBeGreaterThan(-1);
    expect(t0, "记账必须在起点**之后**（否则包不住 ✓）").toBeLessThan(note);
    const loop = src.indexOf("for (const msg of msgs) {");
    expect(loop, "找不到写循环 ⇒ 判据自己先失效 ✗").toBeGreaterThan(-1);
    expect(t0, "起点必须在写循环**之前** ✓").toBeLessThan(loop);
    expect(note, "记账必须在写循环**之后** ✓").toBeGreaterThan(loop);
  });
});
