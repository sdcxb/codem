/**
 * SteZhToggle：顶部按钮必须三态循环（关 → 智能 → 全量），并反映当前模式。
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

const setMode = vi.fn();
vi.mock("../core/ste-zh", () => ({
  STE_ZH_CHANGED_EVENT: "codem:ste-zh-test",
  getSteZhMode: () => "off",
  cycleSteZhMode: (m: string) => (m === "off" ? "smart" : m === "smart" ? "full" : "off"),
  setSteZhMode: (m: string) => setMode(m),
}));

import { SteZhToggle } from "../components/SteZhToggle";

describe("STE-ZH 顶部开关", () => {
  it("STE-UI-1: 默认关闭；点击进入智能模式", () => {
    render(<SteZhToggle />);
    const btn = screen.getByRole("button", { name: /STE 汇报规范/ });
    expect(btn).toHaveAttribute("aria-pressed", "false");
    expect(btn).toHaveAttribute("data-ste-zh-mode", "off");
    fireEvent.click(btn);
    expect(setMode).toHaveBeenCalledWith("smart");
  });
});
