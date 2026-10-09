/**
 * `MEM-CHECK-5a-ctx-props`：**直接断言** `SettingsPanel` 传给 `MemoryCheckupView` 的那两个 props
 * 就是「当前项目 / 当前对话」（GAP-LIST O-44）。
 *
 * ## 与 `memory-checkup-ctx-behavior.test.tsx` 的分工
 *
 * 那个文件**不 mock 视图**，走真渲染 + DOM 后果（「这条现在会不会生效」），钉的是「传错 ctx 用户会看到
 * 别项目的记忆」这个**后果**；本文件把视图换成一个**探针**（只记录 props、不渲染），
 * 钉的是**值本身**：`projectId` 恰好是当前项目归一化后的 id、`sessionId` 恰好是当前对话 id。
 * 两者互补，缺一个都会留下一类改法（改值 vs 改后果）没人守。
 *
 * ## 反向对照（判据不许恒真）
 *
 * - 当前 = 项目A/对话A ⇒ 两个 props 必须**等于** A 的那一对，且**不等于** B 的那一对；
 * - 当前 = null ⇒ 两个 props 必须是 `undefined`（**不许**退化成「硬编码上一次/第一个项目」）。
 *   这一对合起来才说明断言在真的读 store：把 ctx 写死成 A ⇒ 第二条红；
 *   把 ctx 写成空对象 ⇒ 第一条红。
 *
 * 桩的写法照抄既有先例（`src/test/settings-dead-keys.test.ts:320` 的最小渲染桩 +
 * `src/test/audit184-render-layer-fixes.test.tsx:38-55` 的 `vi.hoisted` + `vi.mock` 与
 * `:156` 的 `useProjectStore.setState`）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent, act } from "@testing-library/react";
import { createElement } from "react";
import { setStoragePort } from "../core/storage/port";
import { createFakeStoragePort } from "./fake-storage-port";
import { projectIdFromCwd } from "../core/memory/memory";
import { useProjectStore } from "../core/store";
import type { Project, Session } from "../core/types";

/**
 * 探针：`SettingsPanel` 每渲染一次体检视图就往 `calls` 里塞一份 props。
 *
 * `vi.hoisted` 是必须的 —— `vi.mock` 的工厂会被提升到 import 之前，
 * 普通 `const` 在那时还不存在（既有先例见 `audit184-render-layer-fixes.test.tsx`）。
 */
const probe = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>> }));

vi.mock("../components/MemoryCheckupView", () => ({
  MemoryCheckupView: (props: Record<string, unknown>) => {
    probe.calls.push(props);
    return null;
  },
}));

import { SettingsPanel } from "../components/SettingsPanel";

const PROJECT_A: Project = { id: "proj-a", name: "阿尔法项目", path: "C:\\work\\alpha", createdAt: 1, lastAccessedAt: 1 };
const PROJECT_B: Project = { id: "proj-b", name: "贝塔项目", path: "C:\\work\\beta", createdAt: 1, lastAccessedAt: 1 };
const PROJ_A_ID = projectIdFromCwd(PROJECT_A.path)!;
const PROJ_B_ID = projectIdFromCwd(PROJECT_B.path)!;

const SESSION_A: Session = { id: "sess-a", projectId: PROJECT_A.id, title: "对话一（重构）", createdAt: 1, lastMessageAt: 1, messageCount: 0 };
const SESSION_B: Session = { id: "sess-b", projectId: PROJECT_B.id, title: "对话二（发布）", createdAt: 1, lastMessageAt: 1, messageCount: 0 };

/** 两个项目、两个会话都在 store 里；只有「当前」那对不同 —— 「传错值」能藏身的地方正是这里 */
function seedStore(current: "A" | "B" | null) {
  useProjectStore.setState({
    projects: [PROJECT_A, PROJECT_B],
    sessions: [SESSION_A, SESSION_B],
    currentProject: current === "A" ? PROJECT_A : current === "B" ? PROJECT_B : null,
    currentSession: current === "A" ? SESSION_A : current === "B" ? SESSION_B : null,
  } as never);
}

/** 渲染真 `SettingsPanel` → 点「记忆体检」页签 → 返回探针收到的那份 props */
async function openCheckupTab(current: "A" | "B" | null) {
  seedStore(current);
  const { container } = render(createElement(SettingsPanel, { onClose: () => {} }));
  await act(async () => {});

  expect(probe.calls, "还没点页签就渲染了体检视图？那说明它不是页签驱动的").toHaveLength(0);

  const tab = Array.from(container.querySelectorAll("button")).find((b) =>
    /记忆体检|Memory checkup/.test(b.textContent || ""),
  );
  expect(tab, "设置侧栏里必须有「记忆体检」页签按钮").toBeTruthy();
  await act(async () => {
    fireEvent.click(tab!);
  });

  expect(probe.calls.length, "点了页签必须真的渲染体检视图").toBeGreaterThan(0);
  return probe.calls[probe.calls.length - 1]!;
}

beforeEach(() => {
  setStoragePort(createFakeStoragePort());
  probe.calls.length = 0;
});

afterEach(() => {
  cleanup();
  useProjectStore.setState({ projects: [], sessions: [], currentProject: null, currentSession: null } as never);
  setStoragePort(null);
});

describe("MEM-CHECK-5a-ctx-props：传给体检视图的 ctx 就是当前这一对", () => {
  it("MEM-CHECK-5a-ctx-props：当前 = 项目A / 对话A ⇒ props 是 A 的归一化 id 与 A 的会话 id", async () => {
    const props = await openCheckupTab("A");

    expect(props.projectId, "projectId 必须存在（undefined = 体检把当前项目丢了）").not.toBeUndefined();
    expect(props.projectId, "projectId 必须是**当前项目**（路径归一化后）的 id").toBe(PROJ_A_ID);
    expect(props.projectId, "projectId 不许是**别的项目**的 id").not.toBe(PROJ_B_ID);

    expect(props.sessionId, "sessionId 必须存在（undefined = 体检把当前对话丢了）").not.toBeUndefined();
    expect(props.sessionId, "sessionId 必须是**当前对话**的 id").toBe(SESSION_A.id);
    expect(props.sessionId, "sessionId 不许是别的对话的 id").not.toBe(SESSION_B.id);

    // 页签的接线完整性：「归属」那一栏可点的回调必须一起传下来
    expect(typeof props.onNavigate, "归属栏跳转回调必须传下来").toBe("function");
  });

  it("MEM-CHECK-5a-ctx-props-反向对照（另一个当前）：当前 = 项目B / 对话B ⇒ 同一组断言逐条翻转", async () => {
    const props = await openCheckupTab("B");
    expect(props.projectId, "切到项目 B 后 props.projectId 必须跟着变").toBe(PROJ_B_ID);
    expect(props.projectId, "切到项目 B 后 props.projectId 不许还是 A").not.toBe(PROJ_A_ID);
    expect(props.sessionId, "切到对话 B 后 props.sessionId 必须跟着变").toBe(SESSION_B.id);
    expect(props.sessionId, "切到对话 B 后 props.sessionId 不许还是 A").not.toBe(SESSION_A.id);
  });

  it("MEM-CHECK-5a-ctx-props-反向对照（空上下文）：没有当前项目/对话 ⇒ 两个 props 都是 undefined，不许硬编码", async () => {
    const props = await openCheckupTab(null);
    // 上一组断言在这里必须整组翻红 —— 这就是「把上下文来源改成空对象 ⇒ 判据红」的文件内取证
    expect(props.projectId, "没有当前项目时不许退化成某个项目（硬编码 A 或 B）").toBeUndefined();
    expect(props.sessionId, "没有当前对话时不许退化成某个会话").toBeUndefined();
  });
});
