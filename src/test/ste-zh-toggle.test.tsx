/**
 * SteZhToggle：顶部按钮必须能一键启停，并通过 aria-pressed 反映状态。
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

const setEnabled = vi.fn();
vi.mock("../core/ste-zh", () => ({
  STE_ZH_CHANGED_EVENT: "codem:ste-zh-test",
  isSteZhEnabled: () => false,
  setSteZhEnabled: (v: boolean) => setEnabled(v),
}));

import { SteZhToggle } from "../components/SteZhToggle";

describe("STE-ZH 顶部开关", () => {
  it("STE-UI-1: 默认关闭；点击后请求开启", () => {
    render(<SteZhToggle />);
    const btn = screen.getByRole("button", { name: /STE 汇报规范/ });
    expect(btn).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(btn);
    expect(setEnabled).toHaveBeenCalledWith(true);
  });
});
