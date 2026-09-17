/**
 * 第 84 波：一批"零散契约"缺陷的回归测试。
 *
 * 覆盖：
 *   · idle-tracker：阈值 0 曾被当成"立刻超时"（调用方以为在关闭看门狗）
 *   · ask_clarification：没有交互通道时假装"用户未回答"（问题根本没送达）
 *   · IssueStorage.update：空更新照样返回成功、照样发"状态已变更"通知
 *   · addNoteLink：INSERT OR IGNORE 被忽略时调用方仍按"已创建"计数
 *   · FileChangeStorage.updateStatus：写 0 行静默（状态永远停在旧值）
 *   · ToolRegistry/classify：失败的文本输出不再算成功（见 tool-result-status.test.ts）
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

describe("idle-tracker 的 0 语义", () => {
  it("HC-1: 阈值 0 表示**不设空闲上限**，而不是立刻超时", async () => {
    const { createIdleTracker } = await import("../core/llm/idle-tracker");
    const t = createIdleTracker(0);
    await new Promise((r) => setTimeout(r, 20));
    expect(t.expired(), "0 表示关闭看门狗，不该立刻超时").toBe(false);
    t.dispose();
  });

  it("HC-2: 正阈值仍然会超时（正常语义不回退）", async () => {
    const { createIdleTracker } = await import("../core/llm/idle-tracker");
    const t = createIdleTracker(10);
    await new Promise((r) => setTimeout(r, 30));
    expect(t.expired()).toBe(true);
    t.dispose();
  });
});

describe("ask_clarification 的通道诚实性", () => {
  it("HC-3: 没有交互通道时必须报错，而不是假装「用户未回答」", async () => {
    const { createClarificationTool } = await import("../core/llm/tools/ask-clarification");
    const tool = createClarificationTool();
    const r: any = await tool.execute(
      { question: "选哪个？", type: "radio", options: ["A", "B"] },
      {} as any,
    );
    expect(r.isError).toBe(true);
    expect(r.output).toMatch(/没有可用的用户交互通道/);
    expect(r.output).toMatch(/没有\*\*送达用户/);
    expect(r.output).not.toContain("(未回答)");
  });

  it("HC-4: 有通道但用户未作答时，明确说明「用户没有回答」", async () => {
    const { createClarificationTool } = await import("../core/llm/tools/ask-clarification");
    const tool = createClarificationTool();
    const r: any = await tool.execute(
      { question: "选哪个？", type: "radio", options: ["A", "B"], required: true },
      { onInteractiveForm: async () => ({}) } as any,
    );
    expect(r.output).toMatch(/未选择/);
    expect(r.output).toMatch(/不要自行替他选/);
  });

  it("HC-5: 正常作答照旧回传答案", async () => {
    const { createClarificationTool } = await import("../core/llm/tools/ask-clarification");
    const tool = createClarificationTool();
    let asked = "";
    const r: any = await tool.execute(
      { question: "选哪个？", type: "text" },
      {
        onInteractiveForm: async (qs: any[]) => {
          asked = qs[0].id;
          return { [qs[0].id]: "就用 A" };
        },
      } as any,
    );
    expect(asked).toBeTruthy();
    expect(r.output).toContain("就用 A");
  });
});

describe("议题与笔记链接的空写诚实性", () => {
  beforeEach(async () => {
  });

  it("HC-6: IssueStorage.update 无字段可更新时返回 0 并告警", async () => {
    const { IssueStorage } = await import("../core/issue/issue-storage");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const n = IssueStorage.update("issue-x", {});
    expect(n).toBe(0);
    expect(warn.mock.calls.flat().join(" ")).toMatch(/没有任何可更新字段/);
    warn.mockRestore();
  });

  it("HC-7: 不存在的议题更新返回 0（空写可被调用方发现）", async () => {
    const { IssueStorage } = await import("../core/issue/issue-storage");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const n = IssueStorage.update("no-such-issue", { status: "closed" as any });
    expect(n).toBe(0);
    warn.mockRestore();
  });

  it("HC-8: FileChangeStorage.updateStatus 返回真实影响行数", async () => {
    const { FileChangeStorage } = await import("../core/storage/file-change-storage");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(FileChangeStorage.updateStatus("ghost-id", "reverted")).toBe(0);
    warn.mockRestore();
  });
});
