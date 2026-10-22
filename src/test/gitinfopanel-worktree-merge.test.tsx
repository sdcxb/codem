/**
 * GITPANEL-WT-MERGE-1：GitInfoPanel 的「合并回主工作区」按钮必须真的把主路径/工作树路径传给合并函数，
 * 合并成功后清理 worktree 并把会话切回本地（2026-10-22 真机缺口的产品化收口）。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/react";
import { GitInfoPanel } from "../components/GitInfoPanel";
import { useProjectStore } from "../core/store";
import { useAppStore } from "../store";

const mergeWorktreeToProject = vi.fn(async () => ({ commitSha: "abc1234", mergedSha: "def5678", conflictsResolved: null }));
const removeWorktree = vi.fn(async () => undefined);

vi.mock("../core/environment", () => ({
  mergeWorktreeToProject: (...args: unknown[]) => mergeWorktreeToProject(...(args as [])),
  removeWorktree: (...args: unknown[]) => removeWorktree(...(args as [])),
}));

vi.mock("../core/ui/native-dialog", () => ({
  confirmDialog: vi.fn(async () => true),
  alertDialog: vi.fn(async () => undefined),
}));

vi.mock("../core/file-api", () => ({
  executeCommand: vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })),
}));

vi.mock("../core/environment/git-commit-service", () => ({
  onAutoCommitted: () => () => undefined,
}));

const project = { id: "p1", path: "C:/main", name: "main", pinned: 0, createdAt: 1, lastAccessedAt: 1 };
const wtPath = "C:/main/.codem-worktrees/s1";
const session = {
  id: "s1", projectId: "p1", title: "对话", createdAt: 1, lastMessageAt: 1, messageCount: 0,
  executionMode: "git_worktree" as const, worktreePath: wtPath,
};

beforeEach(() => {
  mergeWorktreeToProject.mockClear();
  removeWorktree.mockClear();
  useAppStore.setState({ isStreaming: false });
  useProjectStore.setState({
    currentProject: project as never,
    currentSession: { ...session } as never,
    sessions: [{ ...session }] as never,
    dbReady: true,
  });
});

describe("GitInfoPanel worktree 合并按钮", () => {
  it("GITPANEL-WT-MERGE-1：点击后传主路径+工作树路径，成功后清理并切回本地", async () => {
    const spy = vi.spyOn(useProjectStore.getState(), "updateSession").mockImplementation(() => undefined);
    const { findByText } = render(<GitInfoPanel />);
    const btn = await findByText("合并回主工作区");
    fireEvent.click(btn);
    await waitFor(() => expect(mergeWorktreeToProject).toHaveBeenCalledWith("C:/main", wtPath, { onConflict: "abort" }));
    expect(removeWorktree).toHaveBeenCalledWith("C:/main", wtPath);
    expect(spy).toHaveBeenCalledWith("s1", { executionMode: "current_workspace", worktreePath: undefined });
    spy.mockRestore();
  });
});
