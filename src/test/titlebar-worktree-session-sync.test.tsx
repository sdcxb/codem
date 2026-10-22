/**
 * TITLEBAR-WT-1..2：标题栏切换「新工作树」必须同时改**当前会话**，不能只改项目偏好。
 *
 * 真机事故（2026-10-22）：已有会话点标题栏切 worktree 后，按钮变绿、项目偏好已写，
 * 但 `session.executionMode` 仍是 current_workspace；下一次发送不建 worktree，
 * 请求直接跑在主工作区 —— 界面说一套、执行做一套。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/react";
import { TitleBar } from "../components/TitleBar";
import { useProjectStore } from "../core/store";
import { useAppStore } from "../store";

const setProjectExecutionMode = vi.fn();

vi.mock("../core/environment", () => ({
  getProjectExecutionMode: () => "current_workspace",
  setProjectExecutionMode: (...args: unknown[]) => setProjectExecutionMode(...args),
  hasUncommittedChanges: async () => false,
  isGitRepo: async () => true,
  decideWorktreeDirtyGuard: (dirty: boolean | null) => (dirty === false ? "proceed" : "ask"),
}));

vi.mock("../core/ui/native-dialog", () => ({
  alertDialog: vi.fn(async () => undefined),
  confirmDialog: vi.fn(async () => true),
}));

vi.mock("../core/storage/settings", () => ({
  getSetting: () => ({}),
  setSetting: vi.fn(),
  removeSetting: vi.fn(),
}));

vi.mock("../core/theme", () => ({
  ThemeManager: { getSkin: () => null, getInstance: () => ({ setTheme: vi.fn() }) },
}));

const project = { id: "p1", path: "C:/workspace/demo", name: "demo", pinned: 0, createdAt: 1, lastAccessedAt: 1 };
const session = {
  id: "s1", projectId: "p1", title: "对话", createdAt: 1, lastMessageAt: 1, messageCount: 0,
  executionMode: "current_workspace" as const,
};

beforeEach(() => {
  setProjectExecutionMode.mockClear();
  useAppStore.setState({ isStreaming: false });
  useProjectStore.setState({
    currentProject: project as never,
    currentSession: { ...session } as never,
    sessions: [{ ...session }] as never,
    dbReady: true,
  });
});

describe("标题栏 worktree 切换同步当前会话", () => {
  it("TITLEBAR-WT-1：切到新工作树时，当前会话 executionMode 立即变 git_worktree", async () => {
    const { container } = render(<TitleBar />);
    const btn = container.querySelector(".execution-mode-toggle") as HTMLButtonElement;
    await waitFor(() => expect(btn.title).toContain("切换为新工作树"));
    fireEvent.click(btn);
    await waitFor(() => {
      expect(useProjectStore.getState().currentSession?.executionMode).toBe("git_worktree");
    });
    expect(setProjectExecutionMode).toHaveBeenCalledWith("C:/workspace/demo", "git_worktree");
  });

  it("TITLEBAR-WT-2：切回本地处理时，清掉 worktreePath（否则发送仍优先用它）", async () => {
    useProjectStore.setState({
      currentSession: { ...session, executionMode: "git_worktree", worktreePath: "C:/workspace/demo/.codem-worktrees/s1" } as never,
      sessions: [{ ...session, executionMode: "git_worktree", worktreePath: "C:/workspace/demo/.codem-worktrees/s1" }] as never,
    });
    const { container } = render(<TitleBar />);
    const btn = container.querySelector(".execution-mode-toggle") as HTMLButtonElement;
    await waitFor(() => expect(btn.title).toContain("切换为本地处理"));
    fireEvent.click(btn);
    await waitFor(() => {
      const s = useProjectStore.getState().currentSession;
      expect(s?.executionMode).toBe("current_workspace");
      expect(s?.worktreePath).toBeUndefined();
    });
  });
});
