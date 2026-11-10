/**
 * C03 可观测性：ContextMonitor 的缓存用量必须**两态分明**。
 *
 * ## 被修的形态
 *
 * 旧实现里聚合 usage 的 `cacheHitTokens` 被初始化成 0，于是界面无论 provider
 * 有没有上报缓存，都显示「缓存命中 0%」—— 用户看到的是「确定没命中」，
 * 而事实是「provider 没给这个字段，我们不知道」。这属于本仓库最忌讳的假读数。
 *
 * ## 判据
 *
 * | id | 场景 | 钉什么 |
 * |---|---|---|
 * | CACHE-UI-1 | provider 上报了读 1200 / 写 300 | 显示 `缓存命中：…%（读 1200 / 写 300）` |
 * | CACHE-UI-2 | provider 未上报任何缓存字段 | 显示 `provider 未上报缓存字段`，且**不许**出现 `缓存命中：0%` |
 *
 * 变红方式：把 `formatCacheUsageLabel` 的未上报分支改成 `缓存命中：0%（读 0 / 写 0）` ⇒ CACHE-UI-2 红。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";

import { ContextMonitor } from "../components/ContextMonitor";
import { getCostTracker } from "../core/llm/cost-tracker";
import { parseProviderUsage, toTokenUsage } from "../core/llm/usage-normalize";

const SESSION_REPORTED = "cache-ui-reported";
const SESSION_UNREPORTED = "cache-ui-unreported";

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** 等面板的轮询把会话累计读进来（首帧就能读到，但状态更新在 effect 里） */
async function waitCacheStat(): Promise<HTMLElement> {
  return waitFor(() => {
    const el = screen.getByTestId("context-cache-stat");
    const reported = el.querySelector("[data-cache-reported]")?.getAttribute("data-cache-reported");
    expect(reported, "缓存读数必须已经算过一次（否则断言会读到占位文案）").not.toBe("none");
    return el;
  });
}

describe("C03：ContextMonitor 缓存用量两态", () => {
  it("CACHE-UI-1：provider 上报 ⇒ 显示「缓存命中：X%（读 Y / 写 Z）」", async () => {
    getCostTracker().recordUsage({
      sessionId: SESSION_REPORTED,
      model: "claude-haiku-4-5-20251001",
      provider: "aicodewith",
      usage: toTokenUsage(
        parseProviderUsage({
          input_tokens: 300,
          output_tokens: 20,
          cache_read_input_tokens: 1200,
          cache_creation_input_tokens: 300,
        }),
      ),
      duration: 1,
      toolCalls: 0,
    });

    render(<ContextMonitor sessionId={SESSION_REPORTED} visible={true} />);
    const stat = await waitCacheStat();
    await waitFor(() => {
      expect(stat.textContent, "上报后必须给出百分比与读/写明细").toContain("缓存命中：66.7%");
    });
    expect(stat.textContent, "读缓存数字要可读").toContain("读 1200");
    expect(stat.textContent, "写缓存数字要可读").toContain("写 300");
    expect(stat.textContent, "上报态不该出现「未上报」").not.toContain("provider 未上报缓存字段");
  });

  it("CACHE-UI-2：provider 未上报 ⇒ 显示「provider 未上报缓存字段」，绝不显示 0%", async () => {
    getCostTracker().recordUsage({
      sessionId: SESSION_UNREPORTED,
      model: "claude-haiku-4-5-20251001",
      provider: "aicodewith",
      usage: { promptTokens: 1000, completionTokens: 10, totalTokens: 1010 } as never,
      duration: 1,
      toolCalls: 0,
    });

    render(<ContextMonitor sessionId={SESSION_UNREPORTED} visible={true} />);
    const stat = await waitCacheStat();
    await waitFor(() => {
      expect(stat.textContent, "未上报必须如实说清，而不是报 0%").toContain("provider 未上报缓存字段");
    });
    expect(stat.textContent, "「缓存命中 0%」正是本波要消灭的假读数").not.toContain("缓存命中：0%");
    expect(stat.textContent).not.toContain("读 0");
  });
});
