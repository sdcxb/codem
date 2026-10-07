/**
 * **流式时间归属**（第 48 波 ✓）：`[provider] stream timing net=… self=…`。
 *
 * 为什么要有这条 ✓：② 的读数里我们**每 1k 输出**约为 DSH 的 2× ✗，而两边
 * **模型同名、`reasoningEffort` 同为 high** ✓（已实测 ✓）⇒ 剩下的可能是
 * ①「等 provider 出下一块」✗ 还是 ②「我们解析/产出事件（含消费者每 delta 的工作）」✓。
 * 没有这一刀就只能猜 ✗ —— 而猜测会把力气花在错的地方 ✗。
 *
 * 判据只钉**格式化与口径** ✓（真实计时由真机日志给 ✓，不靠单测模拟时间 ✗）。
 */
import { describe, expect, it } from "vitest";
import { formatProviderStreamTiming } from "../core/llm/provider";

describe("流式时间归属的格式化（第 48 波 ✓）", () => {
  it("PT-1 两个数都出现，且带各自的占比 ✓", () => {
    const s = formatProviderStreamTiming({ netMs: 3000, selfMs: 1000, chunks: 12 });
    expect(s).toContain("net=3000ms(75%)");
    expect(s).toContain("self=1000ms(25%)");
    expect(s).toContain("chunks=12");
    expect(s.startsWith("[provider] stream timing"), "前缀要稳定（好 grep ✓）").toBe(true);
  });

  it("PT-2 全等边界：一半一半 ✓", () => {
    expect(formatProviderStreamTiming({ netMs: 500, selfMs: 500, chunks: 1 })).toContain("net=500ms(50%)");
  });

  it("PT-3 总时长为 0 时不许出 NaN ✗", () => {
    const s = formatProviderStreamTiming({ netMs: 0, selfMs: 0, chunks: 0 });
    expect(s).toContain("net=0ms(0%)");
    expect(s).not.toContain("NaN");
  });

  it("PT-4 小数毫秒被取整 ✓（日志好读 ✓）", () => {
    const s = formatProviderStreamTiming({ netMs: 1234.7, selfMs: 765.2, chunks: 3 });
    expect(s).toContain("net=1235ms");
    expect(s).toContain("self=765ms");
  });

  it("PT-5 接线：provider 的流式循环里真的调了它 ✓（且用「总时长 − net」算 self ✓）", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/core/llm/provider.ts", "utf8");
    expect(src, "必须在流式收尾处打这条日志").toContain("formatProviderStreamTiming({");
    expect(src, "self 必须由「总时长 − net」算（一处插入即可 ✓）").toMatch(
      /selfMs:\s*Math\.max\(0,\s*Date\.now\(\)\s*-\s*__t0\s*-\s*__netMs\)/,
    );
    expect(src, "net 必须来自 reader.read() 的等待 ✓").toMatch(/__netMs \+= Date\.now\(\) - __tRead0/);
  });
});
