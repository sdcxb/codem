/**
 * SteZhReportNotice：回复后只提示，不改写正文。
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("../core/ste-zh", () => ({
  STE_ZH_CHANGED_EVENT: "codem:ste-zh-test",
  getSteZhMode: () => "smart",
  validateSteZhReport: (text: string, toolCalls: any[] | undefined) =>
    /已验证/.test(text) && !(toolCalls || []).some((t) => t.tool === "bash")
      ? [{ code: "verified-without-command", message: "缺少命令证据" }]
      : [],
}));

import { SteZhReportNotice } from "../components/SteZhReportNotice";

describe("STE-ZH 回复后告警", () => {
  it("STE-UI-2: 已验证但无命令 → 显示告警；有命令 → 不显示", () => {
    const { rerender } = render(<SteZhReportNotice text="已完成，已验证。" toolCalls={[]} />);
    expect(screen.getByRole("status")).toHaveTextContent("缺少命令证据");
    rerender(
      <SteZhReportNotice
        text="已完成，已验证。"
        toolCalls={[{ tool: "bash", args: { command: "npm test" } }]}
      />,
    );
    expect(screen.queryByRole("status")).toBeNull();
  });
});
