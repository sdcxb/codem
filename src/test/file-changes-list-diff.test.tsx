/**
 * 桌面适配器的「打开 diff」链路（CHG-D1/2，第 270 波）。
 *
 * 共享组件只发 `onOpenFile(change, file)`；桌面这一侧负责用记录里的
 * before/after tree 跑 `git show <tree>:<path>`，再交给 `DiffViewer`。
 * 这条判据钉三件事：
 * 1. 真的走了 `command-api`（命令里带 `core.quotepath=false`，中文/空格路径不被转义）；
 * 2. before/after 两段文本都来自**对应 tree**（不是把工作区当前内容当 before）；
 * 3. 记录缺 tree 时行不可点（不会假装能看 diff）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { setCommandInvoker } from "../core/command-api";
import { setStoragePort } from "../core/storage/port";
import { __resetFileChangeWindow } from "../core/storage/file-change-storage";
import { __resetVerificationChecksForTests } from "../core/environment/verification-checks";
import { createFakeStoragePort } from "./fake-storage-port";
import { FileChangesList } from "../components/FileChangesList";

const BEFORE_TREE = "a".repeat(40);
const AFTER_TREE = "b".repeat(40);
const BEFORE = "old line\n";
const AFTER = "new line\n";

vi.mock("../components/DiffViewer", () => ({
  DiffViewer: (props: { before: string; after: string; filePath: string }) => (
    <div data-testid="diff-viewer" data-path={props.filePath}>
      <pre data-testid="diff-before">{props.before}</pre>
      <pre data-testid="diff-after">{props.after}</pre>
    </div>
  ),
}));

const ROW = {
  id: "tfc-d1",
  session_id: "sess-d1",
  message_id: "m-d1",
  turn_index: 2,
  before_tree: BEFORE_TREE,
  after_tree: AFTER_TREE,
  changed_files: JSON.stringify([
    { path: "src/a.ts", status: "M", additions: 1, deletions: 1 },
  ]),
  patch_sha256: null,
  current_brief: "Turn 2",
  status: "completed",
  created_at: Date.now(),
};

const calls: string[] = [];

beforeEach(() => {
  calls.length = 0;
  __resetFileChangeWindow();
  __resetVerificationChecksForTests();
  setCommandInvoker(null);
  setStoragePort(createFakeStoragePort({ seed: { turn_file_changes: [ROW] } }) as never);
  (window as unknown as { __TAURI__?: unknown }).__TAURI__ = {
    core: {
      invoke: async (command: string, args?: Record<string, unknown>) => {
        if (command !== "execute_command") return null;
        const text = String(args?.command ?? "");
        calls.push(text);
        if (text.includes(BEFORE_TREE)) return { stdout: BEFORE, stderr: "", exitCode: 0 };
        if (text.includes(AFTER_TREE)) return { stdout: AFTER, stderr: "", exitCode: 0 };
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    },
  };
});

afterEach(() => {
  cleanup();
  delete (window as unknown as { __TAURI__?: unknown }).__TAURI__;
  setStoragePort(null);
  setCommandInvoker(null);
  __resetFileChangeWindow();
});

describe("CHG-D1 桌面打开 diff：before/after 来自各自 tree", () => {
  it("点击文件行 ⇒ 两次 git show，DiffViewer 拿到两段正确内容", async () => {
    render(<FileChangesList sessionId="sess-d1" workspace="C:/ws" />);
    await waitFor(() => expect(screen.getByText("src/a.ts")).toBeTruthy());

    fireEvent.click(screen.getByText("src/a.ts"));

    await waitFor(() => expect(screen.getByTestId("diff-viewer")).toBeTruthy());
    expect(screen.getByTestId("diff-before").textContent).toBe(BEFORE);
    expect(screen.getByTestId("diff-after").textContent).toBe(AFTER);
    expect(screen.getByTestId("diff-viewer").getAttribute("data-path")).toBe("src/a.ts");

    const shows = calls.filter((c) => c.includes(" show "));
    expect(shows).toHaveLength(2);
    expect(shows[0], "必须关掉 core.quotepath，否则非 ASCII 路径取不到").toContain("core.quotepath=false");
    expect(shows.some((c) => c.includes(`${BEFORE_TREE}:src/a.ts`))).toBe(true);
    expect(shows.some((c) => c.includes(`${AFTER_TREE}:src/a.ts`))).toBe(true);
  });
});

describe("CHG-D2 缺 tree 的记录行不可点", () => {
  it("before_tree=null ⇒ 文件行是静态的，不调用 git show", async () => {
    setStoragePort(
      createFakeStoragePort({
        seed: { turn_file_changes: [{ ...ROW, id: "tfc-d2", before_tree: null }] },
      }) as never,
    );
    __resetFileChangeWindow();
    render(<FileChangesList sessionId="sess-d1" workspace="C:/ws" />);
    await waitFor(() => expect(screen.getByText("src/a.ts")).toBeTruthy());

    const row = screen.getByText("src/a.ts").closest(".inspector-file-row")!;
    expect(row.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(row);
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.filter((c) => c.includes(" show "))).toEqual([]);
    expect(screen.queryByTestId("diff-viewer")).toBeNull();
  });
});
