/**
 * STACK-UI：技能市场页签里的「技能包」区块。
 * 只钉可见行为：加载后列出包；点安装调用市场并显示结果；索引失败显示错误。
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

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

import { StackMarketSection } from "../components/StackMarketSection";

describe("STACK-UI", () => {
  it("SU-1: 加载后列出技能包，点安装显示结果", async () => {
    const user = userEvent.setup();
    render(<StackMarketSection />);
    expect(await screen.findByText("review-pack")).toBeTruthy();
    expect(screen.getByText("v1.0.0")).toBeTruthy();
    expect(screen.getByText("code-review")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "安装" }));
    await waitFor(() => expect(mocks.installStackFromMarket).toHaveBeenCalledWith("review-pack"));
    expect(await screen.findByText(/已安装 1/)).toBeTruthy();
  });

  it("SU-2: 索引失败 → 显示错误，不崩", async () => {
    mocks.fetchStackIndex.mockRejectedValueOnce(new Error("网络不可用"));
    render(<StackMarketSection />);
    expect(await screen.findByText(/网络不可用/)).toBeTruthy();
  });
});
