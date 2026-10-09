/**
 * `MEM-CHECK-5a-行为`：设置面板「记忆体检」页签**真的**把「当前项目 + 当前对话」传进视图（GAP-LIST O-44）。
 *
 * ## 这条判据为什么必须存在
 *
 * `memory-checkup.test.tsx::MEM-CHECK-5a` 是**源码级接线检查**（页签 id / 文案 / 渲染哪个组件 /
 * 不许 `new MemoryService`）。它挡得住「改名、删行」，**挡不住「传错值」** —— 而传错 ctx 的表现是
 * 「体检显示别项目的记忆」：用户看到的是**别人的内容**，与「页签改名」完全不是一个量级。
 *
 * 渲染 `SettingsPanel` 要拖进整套 store/dialog/端口桩，所以这一层一直没有行为判据。
 * 本文件用**最小桩**补上（桩的写法照抄既有先例 `src/test/settings-dead-keys.test.ts:320`
 * 的 `render(createElement(SettingsPanel, { onClose: () => {} }))`，
 * 以及 `src/test/audit184-render-layer-fixes.test.tsx:156` 的 `useProjectStore.setState(...)`
 * 注入 store 夹具 —— 不另发明一套）。
 *
 * ## 怎么断言「视图拿到的 ctx 是这一对」
 *
 * **不 mock 视图**：真渲染 `MemoryCheckupView`，让 ctx 的**后果**落在 DOM 上。
 * 视图对每一条记忆渲染「不进上下文」徽标（`MemoryCheckupView.tsx:299`），
 * 而「进不进」由 `checkupInjected()`（`core/memory/checkup.ts:273-278`）**只用 ctx** 判定：
 *
 * - `project` 条目：`entry.projectId === ctx.projectId`；
 * - `conversation` 条目：`entry.sessionId === ctx.sessionId`；
 * - `platform` 条目：恒真（正好当**恒真对照**，证明这套读法不是「全都读成不注入」）。
 *
 * 于是「A 项目的条目显示已生效、B 项目的条目显示不进上下文」这一对断言，
 * 等价于 `ctx.projectId === 项目A的归一化 id`（既不是 `undefined`，也不是项目 B）。
 * 用真视图而不是 props 探针的好处：**连同「页签能点开、视图真渲染」一起钉住**。
 *
 * ## 反向对照（判据不许恒真）
 *
 * 同一个读法在三种上下文来源下必须给出**不同**答案：
 * ① 当前 = A ⇒ A 的条目生效、B 的不生效；
 * ② 当前 = B ⇒ 逐条翻转（证明判据跟着 `currentProject/currentSession` 走，不是硬编码 A）；
 * ③ 当前 = null（ctx 退化成空对象）⇒ 项目级/对话级**一条都不生效**，只剩平台级。
 * ③ 就是「把上下文来源改成空对象 ⇒ 判据必须红」的**文件内**取证；
 * ①③ 之间的差异也证明这三条断言不是恒真。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent, act } from "@testing-library/react";
import { createElement } from "react";
import { setStoragePort } from "../core/storage/port";
import { createFakeStoragePort } from "./fake-storage-port";
import { MemoryService, projectIdFromCwd } from "../core/memory/memory";
import * as memoryModule from "../core/memory/memory";
import { useProjectStore } from "../core/store";
import { SettingsPanel } from "../components/SettingsPanel";
import type { Project, Session } from "../core/types";

const PROJECT_A: Project = { id: "proj-a", name: "阿尔法项目", path: "C:\\work\\alpha", createdAt: 1, lastAccessedAt: 1 };
const PROJECT_B: Project = { id: "proj-b", name: "贝塔项目", path: "C:\\work\\beta", createdAt: 1, lastAccessedAt: 1 };
/** 条目里存的是**归一化后的工作目录**（`projectIdFromCwd`），不是 `Project.id` —— 别把两者混为一谈 */
const PROJ_A_ID = projectIdFromCwd(PROJECT_A.path)!;
const PROJ_B_ID = projectIdFromCwd(PROJECT_B.path)!;

const SESSION_A: Session = { id: "sess-a", projectId: PROJECT_A.id, title: "对话一（重构）", createdAt: 1, lastMessageAt: 1, messageCount: 0 };
const SESSION_B: Session = { id: "sess-b", projectId: PROJECT_B.id, title: "对话二（发布）", createdAt: 1, lastMessageAt: 1, messageCount: 0 };

/** 五条记忆：平台 1 条（恒注入）+ 两个项目各 1 条 + 两个对话各 1 条（用于区分「是不是当前那对」） */
const KEY_PLATFORM = "平台条目";
const KEY_PROJECT_A = "项目A条目";
const KEY_PROJECT_B = "项目B条目";
const KEY_SESSION_A = "对话A条目";
const KEY_SESSION_B = "对话B条目";

function makeService(): MemoryService {
  const svc = new MemoryService();
  svc.add({ scope: "platform", key: KEY_PLATFORM, content: "PLATFORM", source: "manual" });
  svc.add({ scope: "project", projectId: PROJ_A_ID, key: KEY_PROJECT_A, content: "PROJ_A", source: "manual" });
  svc.add({ scope: "project", projectId: PROJ_B_ID, key: KEY_PROJECT_B, content: "PROJ_B", source: "manual" });
  svc.add({ scope: "conversation", sessionId: SESSION_A.id, key: KEY_SESSION_A, content: "SESS_A", source: "manual" });
  svc.add({ scope: "conversation", sessionId: SESSION_B.id, key: KEY_SESSION_B, content: "SESS_B", source: "manual" });
  return svc;
}

type Current = "A" | "B" | null;

/** store 夹具：**两个项目、两个会话**都在，只有「当前」那对不同（这正是「传错值」能藏身的地方） */
function seedStore(current: Current) {
  useProjectStore.setState({
    projects: [PROJECT_A, PROJECT_B],
    sessions: [SESSION_A, SESSION_B],
    currentProject: current === "A" ? PROJECT_A : current === "B" ? PROJECT_B : null,
    currentSession: current === "A" ? SESSION_A : current === "B" ? SESSION_B : null,
  } as never);
}

/**
 * 从真渲染出来的 DOM 里读每条记忆的「进不进上下文」。
 *
 * 读法只用视图的**稳定类名**（`.mc-entry` / `.mc-entry-key` / `.mc-source-badge.not-injected`）——
 * 与 `css-checkup-classes.test.ts` 钉住的同一批类名（那组判据保证类名不会被悄悄改名）。
 */
function readInjection(container: HTMLElement): Map<string, { injected: boolean; reason: string }> {
  const out = new Map<string, { injected: boolean; reason: string }>();
  for (const el of Array.from(container.querySelectorAll(".mc-entry"))) {
    const key = el.querySelector(".mc-entry-key")?.textContent ?? "";
    if (!key) continue;
    out.set(key, {
      injected: !el.querySelector(".mc-source-badge.not-injected"),
      reason: el.querySelector(".mc-entry-reason")?.textContent ?? "",
    });
  }
  return out;
}

/** 渲染真的 `SettingsPanel` → 点「记忆体检」页签 → 返回 DOM 里的注入态 */
async function openCheckupTab(current: Current) {
  seedStore(current);
  const { container } = render(createElement(SettingsPanel, { onClose: () => {} }));
  await act(async () => {});

  // 页签按**文案**找（不按下标：本仓有过「按位置取按钮、按钮被挪走 ⇒ 判据红得像功能坏了」的教训）
  const tab = Array.from(container.querySelectorAll("button")).find((b) =>
    /记忆体检|Memory checkup/.test(b.textContent || ""),
  );
  expect(tab, "设置侧栏里必须有「记忆体检」页签按钮").toBeTruthy();
  await act(async () => {
    fireEvent.click(tab!);
  });

  expect(container.querySelector(".memory-checkup"), "点了页签必须真的渲染出记忆体检视图").toBeTruthy();
  return { container, state: readInjection(container) };
}

let spy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // 端口是唯一形态（与全局 setup.ts 同口径，这里显式一次以便本文件自带夹具边界）
  setStoragePort(createFakeStoragePort());
  const svc = makeService();
  spy = vi.spyOn(memoryModule, "getMemoryService").mockReturnValue(svc);
});

afterEach(() => {
  spy.mockRestore();
  cleanup();
  useProjectStore.setState({ projects: [], sessions: [], currentProject: null, currentSession: null } as never);
  setStoragePort(null);
});

describe("MEM-CHECK-5a-行为：页签把「当前项目 + 当前对话」传进体检视图", () => {
  it("MEM-CHECK-5a-行为：当前 = 项目A / 对话A ⇒ A 的条目生效，B 的条目显示不进上下文", async () => {
    const { container, state } = await openCheckupTab("A");

    expect(Array.from(state.keys()).sort(), "五条记忆都要渲染出来（否则下面的断言是空转）").toEqual(
      [KEY_PROJECT_A, KEY_PROJECT_B, KEY_SESSION_A, KEY_SESSION_B, KEY_PLATFORM].sort(),
    );

    // 恒真对照：平台级在任何 ctx 下都生效 —— 它绿说明「读注入态」这套读法本身是通的
    expect(state.get(KEY_PLATFORM)!.injected, "平台级条目恒注入").toBe(true);

    // ctx.projectId 必须 === 当前项目的归一化 id：既不是 undefined，也不是项目 B
    expect(state.get(KEY_PROJECT_A)!.injected, "当前项目（A）的条目必须判定为生效 ⇒ ctx.projectId 是 A").toBe(true);
    expect(state.get(KEY_PROJECT_B)!.injected, "**别的项目（B）** 的条目不许判定为生效 ⇒ ctx.projectId 不是 B").toBe(false);
    expect(state.get(KEY_PROJECT_B)!.reason, "不注入必须给真实原因").toContain("不注入的原因");

    // ctx.sessionId 必须 === 当前对话 id：既不是 undefined，也不是另一个对话
    expect(state.get(KEY_SESSION_A)!.injected, "当前对话（sess-a）的条目必须判定为生效 ⇒ ctx.sessionId 不是 undefined").toBe(true);
    expect(state.get(KEY_SESSION_B)!.injected, "**别的对话（sess-b）** 的条目不许判定为生效 ⇒ ctx.sessionId 不是 sess-b").toBe(false);

    // 汇总口径同步（1 平台 + 1 项目 + 1 对话 = 3）
    expect(container.textContent, "汇总里的「实际注入」必须是 3 条").toContain("实际注入 3 条");
  });

  it("MEM-CHECK-5a-反向对照（另一个项目）：当前 = 项目B / 对话B ⇒ 同一套断言逐条翻转", async () => {
    const { container, state } = await openCheckupTab("B");

    expect(state.get(KEY_PROJECT_B)!.injected, "切到项目 B 后，B 的条目必须生效").toBe(true);
    expect(state.get(KEY_PROJECT_A)!.injected, "切到项目 B 后，A 的条目必须不生效（判据跟着 currentProject 走）").toBe(false);
    expect(state.get(KEY_SESSION_B)!.injected, "切到对话 B 后，B 的条目必须生效").toBe(true);
    expect(state.get(KEY_SESSION_A)!.injected, "切到对话 B 后，A 的条目必须不生效（判据跟着 currentSession 走）").toBe(false);
    expect(container.textContent).toContain("实际注入 3 条");
  });

  it("MEM-CHECK-5a-反向对照（空上下文）：没有当前项目/对话 ⇒ 项目级与对话级一条都不生效", async () => {
    const { container, state } = await openCheckupTab(null);

    // 这就是「把上下文来源改成空对象」的**文件内**取证：上一组断言在这里必须整组翻红
    expect(state.get(KEY_PLATFORM)!.injected, "平台级照旧生效（对照：不是所有条目都读成不注入）").toBe(true);
    for (const key of [KEY_PROJECT_A, KEY_PROJECT_B, KEY_SESSION_A, KEY_SESSION_B]) {
      expect(state.get(key)!.injected, `没有当前上下文时「${key}」不许判定为生效`).toBe(false);
    }
    expect(
      container.textContent,
      "空上下文下只有平台级进上下文 —— 若这里也是 3 条，说明判据根本没在看 ctx",
    ).toContain("实际注入 1 条");
  });
});
