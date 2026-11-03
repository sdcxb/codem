/**
 * 共享视图模型的判据（SV-*）。
 *
 * 这些映射是"手机/桌面看到同一种东西"的唯一来源：纯函数、无 DOM，
 * 所以两端（以及未来的 Android 壳）不可能各自解释出两套显示。
 */
import { describe, expect, it } from "vitest";

import { messageViews, roleLabel, runStateLabel, sessionMeta, toolCardTitle } from "../../packages/ui/src/session-view";

describe("SV-1 消息行 → 视图", () => {
  it("普通消息保留角色与正文；工具行关联调用名", () => {
    const views = messageViews(
      [
        { id: "u1", role: "user", content: "你好" },
        { id: "a1", role: "assistant", content: "在" },
        { id: "t1", role: "tool", content: "文件内容", toolCallId: "c1" },
      ],
      { c1: { name: "read", status: "done", output: "文件内容" } },
    );
    expect(views.map((v) => v.kind)).toEqual(["text", "text", "tool"]);
    expect(views[0]).toMatchObject({ roleLabel: "user", body: "你好" });
    expect(views[2]).toMatchObject({ toolName: "read", output: "文件内容" });
  });

  it("关联不上调用时用 id 兜底（不丢信息、不假装知道名字）", () => {
    const [view] = messageViews([{ id: "t1", role: "tool", content: "x", toolCallId: "c9" }]);
    expect(view).toMatchObject({ kind: "tool", toolName: "tool:c9" });
  });
});

describe("SV-2 状态与元信息", () => {
  it("运行状态是人话；未知状态退回就绪", () => {
    expect(runStateLabel("running")).toBe("运行中");
    expect(runStateLabel("succeeded")).toBe("已完成");
    expect(runStateLabel("failed")).toBe("已失败");
    expect(runStateLabel(null)).toBe("就绪");
  });

  it("会话副标题只拼真实存在的字段（不造假时间）", () => {
    expect(sessionMeta({ messageCount: 3 })).toBe("3 条消息");
    expect(sessionMeta({})).toBe("");
  });

  it("工具卡标题的状态符号固定", () => {
    expect(toolCardTitle("read", "running")).toBe("read …");
    expect(toolCardTitle("read", "done")).toBe("read ✓");
    expect(toolCardTitle("read", "error")).toBe("read ✗");
    expect(roleLabel("assistant")).toBe("assistant");
  });
});
