/**
 * SIDEBAR-POLL：侧栏 5s 刷新的**成本**与**定时器生命周期**（第 6 轮，带回归基线）。
 *
 * ## 修之前的实测形态（这就是基线）
 *
 * `loadAllSessions()` 是 `for (const p of projects) getProjectSessions(p.id)`，
 * 而 `getProjectSessions` → `listSessions(pid)` → 端口 `domains.find({project_id})`，
 * 实现是「整表复制 + 全量过滤」⇒ **每 5 秒 = 项目数 × 整表复制**。
 * 更糟的是它被塞进依赖 `[allSessions]` 的 effect，而定时器又调它：
 * `setAllSessions` 换对象 ⇒ effect 重跑 ⇒ 清掉旧 interval 再建新的 ⇒ **每次 tick 都在重建定时器**。
 *
 * ## 判据（本文件）
 *
 * - 5s × 2 个 tick：**只有 `listSessionsGroupedByProject`**（整表读一次）被调用，
 *   `listSessions(projectId)` **0 次**（旧实现的标志）；
 * - 每次 tick 的整表读**恰好 1 次**（不是每项目一次，也不是每渲染一次）；
 * - 定时器不被重建：2 个 tick 后总调用数 = 初始 1 次 + 2 次（多出来的说明 effect 在自触发）。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import { createElement } from "react";
import { setStoragePort } from "../core/storage/port";
import { createFakeStoragePort } from "./fake-storage-port";
import { useProjectStore } from "../core/store";
import { Sidebar } from "../components/Sidebar";
import * as SessionStorage from "../core/storage/session";
import type { Project } from "../core/types";

const P1: Project = { id: "proj-1", name: "项目一", path: "C:\\work\\one", createdAt: 1, lastAccessedAt: 1 };
const P2: Project = { id: "proj-2", name: "项目二", path: "C:\\work\\two", createdAt: 2, lastAccessedAt: 2 };

function seedPort() {
  const sessions = [
    { id: "s1", project_id: P1.id, title: "一号", created_at: 10, last_message_at: 10, message_count: 1, pinned: 0 },
    { id: "s2", project_id: P1.id, title: "二号", created_at: 20, last_message_at: 20, message_count: 2, pinned: 0 },
    { id: "s3", project_id: P2.id, title: "三号", created_at: 30, last_message_at: 30, message_count: 3, pinned: 0 },
  ];
  const port = createFakeStoragePort({ seed: { sessions } });
  setStoragePort(port);
  return port;
}

beforeEach(() => {
  seedPort();
  useProjectStore.setState({
    projects: [P1, P2],
    currentProject: P1,
    currentSession: null,
    sessions: [],
  } as never);
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  useProjectStore.setState({ projects: [], sessions: [], currentProject: null, currentSession: null } as never);
  setStoragePort(null);
});

describe("SIDEBAR-POLL：5s 刷新只读一次整表", () => {
  it("两个 tick 之后：整表读 3 次（初始 + 2），逐项目读 0 次", async () => {
    const grouped = vi.spyOn(SessionStorage, "listSessionsGroupedByProject");
    const perProject = vi.spyOn(SessionStorage, "listSessions");

    await act(async () => {
      render(createElement(Sidebar, { identity: null } as never));
    });

    const groupedAfterMount = grouped.mock.calls.length;
    expect(groupedAfterMount, "挂载时必须立刻读一次（否则侧栏空白）").toBe(1);

    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });

    expect(
      perProject.mock.calls.length,
      "还在按项目逐个 listSessions ⇒ 每次刷新都是「项目数 × 整表复制」",
    ).toBe(0);
    expect(
      grouped.mock.calls.length,
      "定时器被重建 / effect 自触发会让这里多出几次整表读",
    ).toBe(3);
  });

  it("页面隐藏时跳过刷新（用户看不到，不必每 5s 读库）", async () => {
    const grouped = vi.spyOn(SessionStorage, "listSessionsGroupedByProject");
    await act(async () => {
      render(createElement(Sidebar, { identity: null } as never));
    });
    const before = grouped.mock.calls.length;

    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    await act(async () => {
      vi.advanceTimersByTime(10000);
    });
    expect(grouped.mock.calls.length, "隐藏时仍在刷新 ⇒ 笔记本上白烧 IO").toBe(before);
    hidden.mockRestore();
  });
});
