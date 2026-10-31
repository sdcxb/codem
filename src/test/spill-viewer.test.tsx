/**
 * 溢出全文查看：能看到按钮、读取全文、文件丢了如实报错。
 */
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";

const readSpillText = vi.hoisted(() => vi.fn(async () => "full spill body"));
vi.mock("../core/storage/spill", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../core/storage/spill")>();
  return { ...actual, readSpillText };
});

import { ToolCallCard } from "../components/ToolCallCard";

afterEach(() => cleanup());

const result = "head\n\n（已省略 10 字节；完整结果保存在：C:\\tmp\\spill\\a.txt）";

it("SV-1: 溢出结果展开后可查看全文", async () => {
  const { container } = render(createElement(ToolCallCard, {
    toolName: "bash",
    toolResult: result,
    status: "done",
  }));
  fireEvent.click(container.querySelector(".tool-call-pill")!);
  fireEvent.click(await screen.findByText("查看溢出全文"));
  expect(await screen.findByText("full spill body")).toBeTruthy();
  expect(readSpillText).toHaveBeenCalledWith("C:\\tmp\\spill\\a.txt");
});

it("SV-2: 文件丢失时显示丢失态，不显示空全文", async () => {
  readSpillText.mockRejectedValueOnce(new Error("E_FILE_NOT_FOUND"));
  const { container } = render(createElement(ToolCallCard, {
    toolName: "bash",
    toolResult: result,
    status: "done",
  }));
  fireEvent.click(container.querySelector(".tool-call-pill")!);
  fireEvent.click(await screen.findByText("查看溢出全文"));
  expect(await screen.findByText(/全文文件已丢失或读不到/)).toBeTruthy();
});
