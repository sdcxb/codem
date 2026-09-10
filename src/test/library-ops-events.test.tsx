/**
 * LO-EVT —— 时间线事件来源（v1.15.2）
 *
 * 背景：用户反馈「有项目有对话，但看板 → 时间线是空的」。
 * 根因是事件来源太窄：以前只有**工具调用 / 团队任务 / 角色焦点 / 遥测**会变成事件，
 * 纯聊天（只问答、没调工具）的会话在时间线里就是空的。
 *
 * 现在对话消息本身也是事件（用户发言 / 助手回复 / 失败消息），
 * 并且时间线为空时会列出「采样看到了什么」，避免再出现无法解释的空白页。
 */
import { describe, it, expect } from "vitest";
import { render, act, fireEvent } from "@testing-library/react";
import { collectSnapshotSync } from "../plugins/library-ops/core/telemetry-adapter";
import type { AdapterDeps } from "../plugins/library-ops/core/telemetry-adapter";
import { TimelinePanel } from "../plugins/library-ops/components/monitor/TimelinePanel";

const NOW = 1_800_000_000_000;

function baseDeps(overrides: Partial<AdapterDeps> = {}): AdapterDeps {
  return {
    now: () => NOW,
    projectState: () => ({
      projects: [{ id: "p1", name: "项目", path: "C:/p", createdAt: 0, lastAccessedAt: 0 }],
      sessions: [
        {
          id: "s1",
          projectId: "p1",
          title: "主控会话",
          createdAt: NOW - 60_000,
          lastMessageAt: NOW - 1_000,
          messageCount: 4,
          model: "deepseek-v4",
        } as never,
      ],
      currentProject: { id: "p1", name: "项目", path: "C:/p", createdAt: 0, lastAccessedAt: 0 } as never,
      currentSession: { id: "s1", projectId: "p1", title: "主控会话" } as never,
    }),
    appState: () => ({
      messages: [],
      activeSessions: new Set<string>(),
      llmStatus: "idle",
      stepProgress: null,
      agentActivities: [],
    } as never),
    teams: () => [],
    subagentTasks: () => [],
    costStats: () => null,
    squads: () => [],
    agentDefs: () => [],
    delegations: () => [],
    telemetryEvents: () => [],
    ...overrides,
  };
}

describe("LO-EVT 时间线事件来源", () => {
  it("LO-EVT-1: 纯聊天会话（无工具调用）也有事件 —— 用户发言与助手回复", () => {
    const snap = collectSnapshotSync(
      baseDeps({
        appState: () =>
          ({
            messages: [
              { id: "m1", role: "user", content: "帮我看看这个项目", timestamp: NOW - 3000 },
              { id: "m2", role: "assistant", content: "好的，我先读一下目录结构", timestamp: NOW - 2000 },
            ],
            activeSessions: new Set(["s1"]),
            llmStatus: "idle",
            stepProgress: null,
            agentActivities: [],
          }) as never,
      }),
    );

    const texts = snap.events.map((e) => e.text);
    expect(texts.some((t) => t.includes("用户：帮我看看这个项目"))).toBe(true);
    expect(texts.some((t) => t.includes("助手：好的，我先读一下目录结构"))).toBe(true);
    expect(snap.events.every((e) => e.kind === "session")).toBe(true);
  });

  it("LO-EVT-2: 工具调用仍然各自成条目（不与消息事件重复）", () => {
    const snap = collectSnapshotSync(
      baseDeps({
        appState: () =>
          ({
            messages: [
              {
                id: "m1",
                role: "assistant",
                content: "",
                timestamp: NOW - 2000,
                toolCalls: [{ id: "t1", tool: "read", args: { file_path: "src/a.ts" }, status: "done" }],
              },
            ],
            activeSessions: new Set(["s1"]),
            llmStatus: "executing_tools",
            stepProgress: null,
            agentActivities: [],
          }) as never,
      }),
    );

    // 空正文的助手消息不产生消息事件（id 前缀 msg:），只有工具 + 角色焦点事件
    expect(snap.events.some((e) => e.id.startsWith("msg:"))).toBe(false);
    const tool = snap.events.find((e) => e.kind === "tool")!;
    expect(tool.text).toContain("read");
    expect(tool.text).toContain("a.ts");
  });

  it("LO-EVT-3: 失败消息 → error 事件（severity=bad）", () => {
    const snap = collectSnapshotSync(
      baseDeps({
        appState: () =>
          ({
            messages: [{ id: "m9", role: "assistant", content: "请求超时", status: "error", timestamp: NOW - 500 }],
            activeSessions: new Set(),
            llmStatus: "error",
            stepProgress: null,
            agentActivities: [],
          }) as never,
      }),
    );
    const err = snap.events.find((e) => e.kind === "error")!;
    expect(err).toBeTruthy();
    expect(err.severity).toBe("bad");
    expect(err.text).toContain("请求超时");
  });

  it("LO-EVT-4: 时间线为空时给出诊断（列出采样计数与事件来源说明）", () => {
    const snap = collectSnapshotSync(baseDeps());
    expect(snap.events.length).toBe(0);
    const { container } = render(<TimelinePanel snapshot={snap} zh />);
    // 不再是干巴巴的「暂无事件」
    expect(container.textContent).toContain("这个窗口里暂时没有事件");
    expect(container.querySelector(".lo-diag")).toBeTruthy();
    expect(container.textContent).toContain("遥测事件");
    expect(container.textContent).toContain("时间线的事件来自");
  });

  it("LO-EVT-5: 类别筛选下为空时文案区分「该类无事件」", async () => {
    const snap = collectSnapshotSync(
      baseDeps({
        appState: () =>
          ({
            messages: [{ id: "m1", role: "user", content: "你好", timestamp: NOW - 100 }],
            activeSessions: new Set(),
            llmStatus: "idle",
            stepProgress: null,
            agentActivities: [],
          }) as never,
      }),
    );
    const { container } = render(<TimelinePanel snapshot={snap} zh />);
    // 有 session 事件 → 默认显示列表
    expect(container.querySelectorAll(".lo-timeline__item").length).toBeGreaterThan(0);
    // 切到「成本」筛选 → 无事件，但文案说明是该类别没有
    const costBtn = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "成本")!;
    await act(async () => {
      fireEvent.click(costBtn);
    });
    expect(container.textContent).toContain("该类别下暂无事件");
  });
});
