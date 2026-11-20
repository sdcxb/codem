/**
 * STORE-SUB：外壳组件不许**整店订阅**（第 6 轮，带回归基线）。
 *
 * ## 修之前的实测形态
 *
 * `App` / `ChatPanel` / `Sidebar` / `InputArea` / `RightSidebar` 都是
 * `const {...} = useAppStore()` / `useProjectStore()`（无选择器）。
 * Zustand v5 里这等价于「订阅整个 state 对象」⇒ **任何一次 `set()` 都会让它们重渲染**，
 * 包括它们根本不读的字段（`feedback`、`persistAlerts`、别的会话的 `activeSessions`…）。
 * App 一重渲染，TitleBar / Sidebar / RightSidebar / ChatPanel 整棵子树跟着重建（都不是 memo）。
 *
 * ## 判据
 *
 * 1. **无关字段变化**（只往 `feedback` 里写一条）⇒ 侧栏的 commit 数**不增加**；
 * 2. **相关字段变化**（projects 列表换一份）⇒ commit 数**必须增加**（反向对照，
 *    防止"给个永远不更新的选择器"这种假优化）；
 * 3. 源码口径：这 5 个文件里不许再出现 `= useAppStore();` / `= useProjectStore();`。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, cleanup, act, waitFor } from "@testing-library/react";
import { Profiler, createElement } from "react";
import fs from "node:fs";
import path from "node:path";
import { setStoragePort } from "../core/storage/port";
import { createFakeStoragePort } from "./fake-storage-port";
import { useProjectStore } from "../core/store";
import { useAppStore } from "../store";
import { Sidebar } from "../components/Sidebar";
import type { Project } from "../core/types";

const P1: Project = { id: "proj-sub", name: "订阅项目", path: "C:\\work\\sub", createdAt: 1, lastAccessedAt: 1 };

function seedPort() {
  const port = createFakeStoragePort({
    seed: {
      sessions: [
        { id: "sub-1", project_id: P1.id, title: "会话一", created_at: 1, last_message_at: 1, message_count: 1, pinned: 0 },
      ],
    },
  });
  setStoragePort(port);
}

beforeEach(() => {
  seedPort();
  useProjectStore.setState({
    projects: [P1],
    currentProject: P1,
    currentSession: null,
    sessions: [],
  } as never);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useProjectStore.setState({ projects: [], sessions: [], currentProject: null, currentSession: null } as never);
  setStoragePort(null);
});

describe("STORE-SUB：无关字段不得触发外壳重渲染", () => {
  it("往 feedback 写一条（侧栏不读它）⇒ 侧栏 commit 数不变", async () => {
    let commits = 0;
    await act(async () => {
      render(
        createElement(
          Profiler,
          { id: "sidebar", onRender: () => { commits += 1; } } as never,
          createElement(Sidebar, { identity: null } as never),
        ),
      );
    });
    await waitFor(() => expect(commits).toBeGreaterThan(0));
    const before = commits;

    await act(async () => {
      useAppStore.setState((s) => ({ feedback: { ...s.feedback, "msg-x": "like" } }) as never);
    });

    expect(
      commits,
      "无关字段变化也重渲染 ⇒ 外壳在跟着整店任何一次 set() 跑（这就是整店订阅的成本）",
    ).toBe(before);
  });

  it("projects 换一份（侧栏读它）⇒ commit 数必须增加（反向对照）", async () => {
    let commits = 0;
    await act(async () => {
      render(
        createElement(
          Profiler,
          { id: "sidebar2", onRender: () => { commits += 1; } } as never,
          createElement(Sidebar, { identity: null } as never),
        ),
      );
    });
    const before = commits;
    await act(async () => {
      useProjectStore.setState({ projects: [{ ...P1, name: "改过名" }] } as never);
    });
    expect(commits, "相关字段变了却不重渲染 ⇒ 选择器写错了（界面会停在旧数据）").toBeGreaterThan(before);
  });
});

describe("STORE-SUB：源码口径", () => {
  const FILES = [
    "src/App.tsx",
    "src/components/ChatPanel.tsx",
    "src/components/Sidebar.tsx",
    "src/components/InputArea.tsx",
    "src/components/RightSidebar.tsx",
  ];

  it("五个外壳组件都不再有整店订阅", () => {
    const offenders: string[] = [];
    for (const rel of FILES) {
      const src = fs.readFileSync(path.join(process.cwd(), rel), "utf8");
      for (const m of src.matchAll(/=\s*use(?:App|Project)Store\(\);/g)) {
        offenders.push(`${rel}: ${m[0]}`);
      }
    }
    expect(offenders, `这些地方又回到了整店订阅：\n  ${offenders.join("\n  ")}`).toEqual([]);
  });
});
