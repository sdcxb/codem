/**
 * SIDEBAR-POLL：会话列表刷新从「每 5s 重读整表」改为「**有写才读** + 30s 兜底」（第 6 轮，带回归基线）。
 *
 * ## 基线（改之前）
 *
 * 5s 定时器无条件 `listSessionsGroupedByProject()` 一次（= 整张 sessions 表读一遍）；
 * 10 秒就是 2 次，一分钟 12 次 —— 而绝大多数时候**什么都没变**。
 *
 * ## 改之后
 *
 * - 没有域写 ⇒ 10 秒、20 秒里**一次都不读**（只有挂载与"内容相关变化"各一次）；
 * - 有 `sessions` / `messages` 写 ⇒ 1.5s 合并窗口后读一次；
 * - 流式期间的消息写**不触发**（否则每 100ms 一次写会把轮询变成 400ms 轮询）；
 * - 30s 安全轮询兜底（通知覆盖不到镜像重载/引擎侧变化）；
 * - 页面隐藏时一律不读。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import { createElement } from "react";
import { setStoragePort } from "../core/storage/port";
import { createFakeStoragePort } from "./fake-storage-port";
import { useProjectStore } from "../core/store";
import { useAppStore } from "../store";
import { Sidebar } from "../components/Sidebar";
import * as SessionStorage from "../core/storage/session";
import { notifyDomainWrite, __resetDomainWriteListeners } from "../core/storage/domain-write-events";
import type { Project } from "../core/types";

const P1: Project = { id: "proj-1", name: "项目一", path: "C:\\work\\one", createdAt: 1, lastAccessedAt: 1 };
const P2: Project = { id: "proj-2", name: "项目二", path: "C:\\work\\two", createdAt: 2, lastAccessedAt: 2 };

function seedPort() {
  const port = createFakeStoragePort({
    seed: {
      sessions: [
        { id: "s1", project_id: P1.id, title: "一号", created_at: 10, last_message_at: 10, message_count: 1, pinned: 0 },
        { id: "s2", project_id: P2.id, title: "二号", created_at: 20, last_message_at: 20, message_count: 2, pinned: 0 },
      ],
    },
  });
  setStoragePort(port);
}

async function mountSidebar() {
  await act(async () => {
    render(createElement(Sidebar, { identity: null } as never));
  });
}

beforeEach(() => {
  seedPort();
  useProjectStore.setState({
    projects: [P1, P2],
    currentProject: P1,
    currentSession: null,
    sessions: [],
  } as never);
  useAppStore.setState({ isStreaming: false } as never);
  __resetDomainWriteListeners();
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  __resetDomainWriteListeners();
  useProjectStore.setState({ projects: [], sessions: [], currentProject: null, currentSession: null } as never);
  setStoragePort(null);
});

describe("SIDEBAR-POLL：有写才读", () => {
  it("没有域写：10 秒内一次都不重读", async () => {
    const grouped = vi.spyOn(SessionStorage, "listSessionsGroupedByProject");
    await mountSidebar();
    const afterMount = grouped.mock.calls.length;

    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });

    expect(grouped.mock.calls.length, "无写入还每 5s 整表读一次 ⇒ 这就是要修的成本").toBe(afterMount);
  });

  it("写了会话表 ⇒ 1.5s 合并窗口后读一次", async () => {
    const grouped = vi.spyOn(SessionStorage, "listSessionsGroupedByProject");
    await mountSidebar();
    const before = grouped.mock.calls.length;

    await act(async () => {
      notifyDomainWrite("sessions");
      notifyDomainWrite("sessions");
      notifyDomainWrite("messages");
      vi.advanceTimersByTime(1600);
    });

    expect(grouped.mock.calls.length, "三次写合并成一次读").toBe(before + 1);
  });

  it("流式期间的消息写不触发刷新（否则比轮询更糟）", async () => {
    const grouped = vi.spyOn(SessionStorage, "listSessionsGroupedByProject");
    await mountSidebar();
    const before = grouped.mock.calls.length;

    act(() => {
      useAppStore.setState({ isStreaming: true } as never);
    });
    await act(async () => {
      for (let i = 0; i < 10; i++) notifyDomainWrite("messages");
      vi.advanceTimersByTime(3000);
    });

    expect(grouped.mock.calls.length, "流式期间不该刷新侧栏").toBe(before);
  });

  it("30s 安全轮询兜底（通知覆盖不到的变化）", async () => {
    const grouped = vi.spyOn(SessionStorage, "listSessionsGroupedByProject");
    await mountSidebar();
    const before = grouped.mock.calls.length;
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    expect(grouped.mock.calls.length, "兜底没了 ⇒ 引擎侧变化永远不同步").toBe(before + 1);
  });

  it("页面隐藏：写与兜底都不读", async () => {
    const grouped = vi.spyOn(SessionStorage, "listSessionsGroupedByProject");
    await mountSidebar();
    const before = grouped.mock.calls.length;
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    await act(async () => {
      notifyDomainWrite("sessions");
      vi.advanceTimersByTime(31_000);
    });
    expect(grouped.mock.calls.length, "隐藏时还在读 ⇒ 后台白烧 IO").toBe(before);
    hidden.mockRestore();
  });
});
