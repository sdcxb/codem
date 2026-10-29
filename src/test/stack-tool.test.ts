/**
 * STACK-TOOL：`stack_market` 工具的可见结果（list / install / 参数校验）。
 */
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchStackIndex: vi.fn(async () => [
    { name: "review-pack", version: "1.0.0", description: "评审包", skills: ["code-review"] },
  ]),
  installStackFromMarket: vi.fn(async () => ({
    name: "review-pack",
    version: "1.0.0",
    installed: ["code-review"],
    missing: [],
    failed: [],
  })),
}));

vi.mock("../core/skill/stack-market", () => mocks);

import { createStackMarketTool } from "../core/skill/stack-tool";

const ctx = { sessionId: "s", messageId: "m", cwd: "/tmp", messages: [], metadata: () => {} } as any;

describe("STACK-TOOL", () => {
  it("ST-1: list 返回包名/版本/技能", async () => {
    const r = await createStackMarketTool().execute({ action: "list" }, ctx);
    expect(r.output).toContain("review-pack@1.0.0");
    expect(r.output).toContain("code-review");
    expect(r.isError).toBe(false);
  });

  it("ST-2: install 缺 name → 明确报错（不调市场）", async () => {
    const r = await createStackMarketTool().execute({ action: "install" }, ctx);
    expect(r.isError).toBe(true);
    expect(mocks.installStackFromMarket).not.toHaveBeenCalled();
  });

  it("ST-3: install 成功/有缺失都要如实输出", async () => {
    const r = await createStackMarketTool().execute({ action: "install", name: "review-pack" }, ctx);
    expect(mocks.installStackFromMarket).toHaveBeenCalledWith("review-pack");
    expect(r.output).toContain("installed: code-review");
    expect(r.isError).toBe(false);

    mocks.installStackFromMarket.mockResolvedValueOnce({
      name: "review-pack", version: "1.0.0", installed: [], missing: ["x"], failed: [],
    } as any);
    const r2 = await createStackMarketTool().execute({ action: "install", name: "review-pack" }, ctx);
    expect(r2.isError).toBe(true);
    expect(r2.output).toContain("missing: x");
  });
});
