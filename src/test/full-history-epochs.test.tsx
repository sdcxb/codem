/**
 * 完整历史面板从 marker 投影 context_epochs，并显示“检查点索引 N”。
 */
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { createFakeStoragePort } from "./fake-storage-port";
import { setStoragePort } from "../core/storage/port";

vi.mock("../core/storage/context-history", () => ({
  readContextHistory: () => ({
    timeline: [{
      id: "compact-100-1",
      role: "user",
      content: "摘要",
      timestamp: 10,
      status: "done",
      metadata: { contextEpoch: { epochId: "compact-100-1", seq: 1, cutoffMessageId: "m3", createdAt: 100 } },
    }],
    model: [],
    modelCount: 0,
  }),
}));

import { FullHistoryPanel } from "../components/FullHistoryPanel";

afterEach(() => {
  cleanup();
  setStoragePort(null);
});

it("FH-6: 派生表有行时显示检查点索引", async () => {
  setStoragePort(createFakeStoragePort({
    seed: { sessions: [{ id: "s1", project_id: "", title: "t", created_at: 0, last_message_at: 0, message_count: 0 }] },
  }));
  render(createElement(FullHistoryPanel, { open: true, sessionId: "s1", onClose: () => {} }));
  expect(await screen.findByText(/检查点索引 1/)).toBeTruthy();
});
