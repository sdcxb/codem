/**
 * RAWCTX：水位/折叠的读数必须用**原始 token（选择前）**，不能用"选择后"的估算。
 *
 * ## 被守的缺陷（2026-10-19，用户实报「折叠了还是提示上下文将满」）
 *
 * `summarizeModelContext().usedTokens` 统计的是**按优先级塞进预算后**的消息：
 * 原始内容远超预算时它恒定贴近预算（≈100%），而折叠后再选一次又会把别的消息塞进来
 * ⇒ 折叠前后读数可能**不降反升**，`foldForLevelIfNeeded` 的目标永远达不成。
 * 真机日志：253K token / 128K 窗口，两会话折叠后读数都在 100%。
 *
 * 判据 `RAWCTX-1..4`；变异 `raw-context-metric`。
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  estimateRawContextTokens,
  summarizeModelContext,
} from "../core/llm/compaction-budget";
import { foldForLevelIfNeeded } from "../core/llm/tool-output-fold";

const ROOT = path.resolve(__dirname, "..", "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

function toolMsg(id: string, chars: number, tool = "read") {
  return {
    id,
    role: "assistant",
    content: "",
    toolCalls: [{ tool, result: "x".repeat(chars), status: "done" }],
  };
}

describe("RAWCTX 原始 token 口径", () => {
  it("RAWCTX-1: 原始估算把正文/工具结果/参数都算进去，且不受优先级选择影响", () => {
    const msgs: any[] = [{ id: "u", role: "user", content: "开始" }];
    for (let i = 0; i < 100; i++) {
      msgs.push({ id: `a${i}`, role: "assistant", content: "", toolCalls: [{ tool: "read", result: "字".repeat(5_000) }] });
    }
    const raw = estimateRawContextTokens(msgs);
    // 预算下限是 16000：给一个很小的窗口，选择后必然被截到预算附近
    const selected = summarizeModelContext(msgs as never[], 1000).usedTokens;
    expect(raw, "原始估算应包含全部内容").toBeGreaterThan(3000);
    expect(selected, "选择后口径会被预算截断（这正是不能拿来当读数的地方）").toBeLessThan(raw);
  });

  it("RAWCTX-2: 折叠能真正降低原始读数（选择后口径做不到）", () => {
    const msgs: any[] = [];
    for (let i = 0; i < 60; i++) msgs.push(toolMsg(`t${i}`, 20_000));
    msgs.push({ id: "final", role: "assistant", content: "done" });
    const window = 128_000;
    const budget = Math.round(window * 0.9);
    const before = estimateRawContextTokens(msgs) / budget;
    expect(before, "构造场景必须真的超过提示线").toBeGreaterThan(1);

    const fold = foldForLevelIfNeeded(msgs, {
      available: budget,
      estimate: (ms) => estimateRawContextTokens(ms),
    });
    expect(fold.folded, "必须真的折叠").toBeGreaterThan(0);
    expect(fold.ratioAfter, `折叠后原始水位应显著下降（实际 ${(fold.ratioAfter * 100).toFixed(0)}%）`).toBeLessThan(0.7);
  });

  it("RAWCTX-3: 三个读数点都接原始口径（水位 / 面板 / 引擎）", () => {
    const water = read("src/core/context/water-level.ts");
    expect(water).toContain("estimateRawContextTokens(ms as never[])");
    expect(water, "百分比超过预算时显示 100%").toContain("Math.min(100, display.percent)");

    const monitor = read("src/components/ContextMonitor.tsx");
    expect(monitor).toContain("estimateRawContextTokens(ms as never[])");
    expect(monitor).toContain("estimateRawContextTokens(pruneStaleToolResults(visible as any[]))");

    const loop = read("src/core/llm/agentic-loop.ts");
    expect(loop).toContain("const before = estimateRawContextTokens(messages as never[]);");
    expect(loop).toContain("estimate: (ms) => estimateRawContextTokens(ms as never[])");
  });

  it("RAWCTX-4: 原始读数 > 预算时百分比被夹在 100%（不显示 220% 这种数字）", () => {
    const water = read("src/core/context/water-level.ts");
    // 断言夹取发生在 percent 上、而 ratio 保留真实值（等级仍会到 critical）
    const at = water.indexOf("Math.min(100, display.percent)");
    expect(at).toBeGreaterThan(0);
    expect(water.slice(Math.max(0, at - 300), at)).toContain("ratio: display.ratio");
  });
});
