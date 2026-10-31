/**
 * 完整历史面板：用户能看到压缩前的旧消息，且面板只读。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { createElement } from "react";

const confirmMock = vi.hoisted(() => vi.fn(async () => true));

vi.mock("../core/ui/native-dialog", () => ({
  confirmDialog: confirmMock,
  alertDialog: vi.fn(async () => undefined),
}));

const timeline = [
  { id: "old", role: "user", content: "压缩前的提问", timestamp: 1, status: "done" },
  { id: "old-a", role: "assistant", content: "压缩前的回答", timestamp: 2, status: "done", reasoning: "旧思考" },
  { id: "compact-1-1", role: "user", content: "[上下文已自动压缩]\n摘要", timestamp: 3, status: "done" },
  { id: "new", role: "user", content: "最近消息", timestamp: 4, status: "done" },
];

vi.mock("../core/storage/context-history", () => ({
  readContextHistory: () => ({ timeline, model: timeline.slice(2), modelCount: 2 }),
}));

vi.mock("../core/storage/context-migration", () => ({
  migrateSessionLegacyHistory: vi.fn(async () => ({ hiddenRows: 0, alreadyDurable: 0, appended: 0, failed: 0, dryRun: false })),
}));

vi.mock("../core/storage/context-rollback", () => ({
  rollbackSessionToClassicHidden: vi.fn(async (_sid: string, opts?: { dryRun?: boolean }) => (
    opts?.dryRun
      ? { epochId: "epoch-1", cutoffMessageId: "m3", candidates: 2, hidden: 0, failed: 0, sessionId: _sid, dryRun: true }
      : { epochId: "epoch-1", cutoffMessageId: "m3", candidates: 2, hidden: 2, failed: 0, sessionId: _sid, dryRun: false }
  )),
}));

import { FullHistoryPanel } from "../components/FullHistoryPanel";

afterEach(() => cleanup());

describe("FullHistoryPanel", () => {
  it("FH-1: 渲染完整历史、检查点与「模型可见」计数", () => {
    render(createElement(FullHistoryPanel, { open: true, sessionId: "s1", onClose: () => {} }));
    expect(screen.getByText("压缩前的提问")).toBeTruthy();
    expect(screen.getByText("压缩前的回答")).toBeTruthy();
    expect(screen.getByTestId("history-checkpoint")).toBeTruthy();
    expect(screen.getByText(/历史 4 条 · 模型可见 2 条/)).toBeTruthy();
    expect(screen.getByText("只读")).toBeTruthy();
  });

  it("FH-2: Esc 关闭", () => {
    const onClose = vi.fn();
    render(createElement(FullHistoryPanel, { open: true, sessionId: "s1", onClose }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("FH-3: 切到模型视图只显示 cutoff 之后的集合", () => {
    render(createElement(FullHistoryPanel, { open: true, sessionId: "s1", onClose: () => {} }));
    fireEvent.click(screen.getByText("模型"));
    expect(screen.getByText("模型视图")).toBeTruthy();
    expect(screen.queryByText("压缩前的提问")).toBeNull();
    expect(screen.getByText("最近消息")).toBeTruthy();
  });

  it("FH-4: 回滚按钮先 dry-run 预览，确认后执行并显示报告", async () => {
    confirmMock.mockClear();
    const { rollbackSessionToClassicHidden } = await import("../core/storage/context-rollback");
    render(createElement(FullHistoryPanel, { open: true, sessionId: "s1", onClose: () => {} }));
    fireEvent.click(screen.getByText("回滚到旧版"));
    await screen.findByText(/回滚完成：2 条/);
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(vi.mocked(rollbackSessionToClassicHidden)).toHaveBeenNthCalledWith(1, "s1", { dryRun: true });
    expect(vi.mocked(rollbackSessionToClassicHidden)).toHaveBeenNthCalledWith(2, "s1");
  });

  it("FH-5: jsdom 视口未知时 fail-open 全量渲染，不出现载入按钮", () => {
    const original = timeline.slice();
    try {
      for (let i = 0; i < 130; i++) {
        timeline.push({ id: `bulk-${i}`, role: "user", content: `批量消息 ${i}`, timestamp: 100 + i, status: "done" });
      }
      render(createElement(FullHistoryPanel, { open: true, sessionId: "s1", onClose: () => {} }));
      expect(screen.queryByText(/载入更早/)).toBeNull();
      expect(screen.getByText("批量消息 0")).toBeTruthy();
    } finally {
      timeline.length = 0;
      timeline.push(...original);
    }
  });
});
