/**
 * 第 230 波 · 面板那一行：**本处 0 条、别处还有**。
 *
 * ## 被守的形态（用户拍板的那两件事之一）
 *
 * 面板的待批准列表按**当前位置**过滤（`listPending(undefined, ctx)`）—— 这是对的
 * （在项目 A 不该看到项目 B 的待批准内容）。但 `MEMORY_PENDING_BACKLOG_LIMIT` 那道闸读的是
 * **全局**存量（第 229 波）⇒ 完全可能出现「本处 0 条、库内已满」：
 * 用户看到"没有待批准"，同时新候选已经被静默降级成对话级了 —— 两个读数对不上，
 * 而用户没有任何地方能看出"积压其实满了"。
 *
 * ## 判据要断的四件事（全是**真渲染**，不是比对 props）
 *
 * 1. `本处 == 0 && 全局 > 0` ⇒ 出现那一行，且 **N = 全局数**（逐字文案）；
 * 2. `本处 > 0` ⇒ **不出现**（本处有待批准时那句话是多余的，而且会与"有 N 条等待批准"打架）；
 * 3. `全局 == 0` ⇒ **不出现**（不许在任何空库上显示"其它项目还有 0 条"）；
 * 4. **口径不许分叉**：那一行的数必须等于闸门读的那个数（`countPendingEntries()`），
 *    且**别处**的待批准条目**不许**因为这一行被放进面板（否则就是跨项目泄漏内容）。
 *
 * ## 变异自证（每条判据都先被"改坏"验过）
 *
 * - 条件改成**恒真**（去掉 `globalPending > 0`）⇒ 判据 3 红；
 * - 条件改成**恒假**（`pending.length > 0`）⇒ 判据 1 红；
 * - N 换成**本地数**（`stats.pendingEntries` / `pending.length`）⇒ 判据 1 与 4 红；
 * - N 换成**常量 0** ⇒ 判据 1 的逐字断言红；
 * - 把"本处"那份换成全局（让面板列出别处的条目）⇒ 判据 4 红。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import { createElement } from "react";

const confirmSpy = vi.hoisted(() => vi.fn());
vi.mock("../core/ui/native-dialog", () => ({
  confirmDialog: confirmSpy,
  alertDialog: vi.fn().mockResolvedValue(undefined),
}));

import { setStoragePort } from "../core/storage/port";
import { createFakeStoragePort, type FakeStoragePort } from "./fake-storage-port";
import { saveMemory, setSetting } from "../core/storage/settings";
import { MemoryService, MEMORY_WRITE_APPROVAL_KEY } from "../core/memory/memory";
import * as memoryModule from "../core/memory/memory";
import { MemoryManager } from "../components/MemoryManager";

/** 当前上下文 */
const PROJ = "proj-230";
const SESSION = "sess-230";
/** 别处（另一个项目 / 另一个对话） */
const OTHER_PROJ = "proj-230-其它";
const OTHER_SESSION = "sess-230-其它";

let port: FakeStoragePort;
let svc: MemoryService;

/** 造 N 条**属于别处**的待批准条目（当前 ctx 下不可见，但计入全局） */
function seedOtherProjectPending(n: number, from = 0): void {
  for (let i = from; i < from + n; i++) {
    svc.add({
      scope: "project",
      projectId: OTHER_PROJ,
      key: `别处待审事实 ${i}`,
      content: `第 ${i} 条属于**别的项目**的待批准内容（当前项目里不该看见它）`,
      source: "auto",
      status: "pending",
      batchId: "batch-230-其它",
    });
  }
}

/** 造 N 条**属于当前上下文**的待批准条目 */
function seedLocalPending(n: number): void {
  for (let i = 0; i < n; i++) {
    svc.add({
      scope: "project",
      projectId: PROJ,
      key: `本处待审事实 ${i}`,
      content: `第 ${i} 条属于**当前项目**的待批准内容`,
      source: "auto",
      status: "pending",
      batchId: "batch-230-本处",
    });
  }
}

async function renderPanel(): Promise<HTMLElement> {
  const { container } = render(
    createElement(MemoryManager, { onClose: () => {}, projectId: PROJ, sessionId: SESSION } as never),
  );
  await act(async () => {
    await Promise.resolve();
  });
  return container;
}

/** 那一行（不存在时返回 null） */
function otherLine(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>('[data-testid="memory-other-projects-pending"]');
}

function lineText(container: HTMLElement): string {
  return (otherLine(container)?.textContent ?? "").replace(/\s+/g, " ").trim();
}

beforeEach(() => {
  saveMemory("");
  setSetting(MEMORY_WRITE_APPROVAL_KEY, JSON.stringify({ platform: true, project: true, conversation: false }));
  port = createFakeStoragePort({ seed: { settings: [{ key: "noop", value: "" }] } });
  setStoragePort(port);
  svc = new MemoryService();
  vi.spyOn(memoryModule, "getMemoryService").mockReturnValue(svc);
  confirmSpy.mockReset();
  confirmSpy.mockResolvedValue(false);
});

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
  setStoragePort(null);
});

describe("MEM-OTHER-PENDING：本处 0 条、别处还有 —— 一行如实读数", () => {
  it("MOP-1：本处 0 条 + 全局 3 条 ⇒ 出现，且 N 是**全局**数（逐字文案）", async () => {
    seedOtherProjectPending(3);
    /* 前提（不是断言实现，而是先确认夹具真的造出了"本处 0 / 全局 3"这个场景） */
    expect(svc.countPendingEntries(), "前提：全局 3 条").toBe(3);
    expect(svc.listPending(undefined, { projectId: PROJ, sessionId: SESSION }), "前提：本处 0 条").toHaveLength(0);

    const container = await renderPanel();
    expect(otherLine(container), "本处 0 条、全局 >0 ⇒ 必须出现这一行").toBeTruthy();
    expect(lineText(container), "N 必须是**全局**数（3），且文案逐字如此").toBe(
      "其它项目还有 3 条待批准（去记忆体检处置）",
    );
  });

  it("MOP-2：本处 >0 ⇒ **不出现**（本处有待批准时不加这一行）", async () => {
    seedLocalPending(2);
    seedOtherProjectPending(3);
    expect(svc.countPendingEntries(), "前提：全局 5 条").toBe(5);

    const container = await renderPanel();
    expect(
      container.querySelectorAll(".memory-pending-item"),
      "前提：本处那 2 条在面板里（本处 >0 的形态）",
    ).toHaveLength(2);
    expect(otherLine(container), "本处 >0 ⇒ 不许出现「其它项目还有…」").toBeNull();
  });

  it("MOP-3：全局 == 0（空库）⇒ **不出现**（不许显示「还有 0 条」）", async () => {
    const container = await renderPanel();
    expect(svc.countPendingEntries(), "前提：库内一条待批准都没有").toBe(0);
    expect(otherLine(container), "全局 0 ⇒ 不许出现这一行").toBeNull();
    expect(lineText(container), "而且界面上不该有任何「还有 0 条」的字样").not.toContain("还有 0 条");
  });

  it("MOP-4：口径与闸门同一处，且**别处的内容不许进面板**", async () => {
    seedOtherProjectPending(4);
    const container = await renderPanel();

    /*
     * ① 数字口径：那一行的 N 必须等于**闸门读的那个数**（`countPendingEntries()`）。
     *    这条断言是"两处口径不许分叉"的落点 —— 它不关心实现怎么写，只比对两个来源。
     */
    expect(lineText(container), "N 必须等于闸门口径（countPendingEntries）").toBe(
      `其它项目还有 ${svc.countPendingEntries()} 条待批准（去记忆体检处置）`,
    );

    /*
     * ② 不许用"把本处那份改成全局"来解决这个不一致：那会把**别的项目**的待批准内容
     *    直接摊在面板里（含全文摘要，可编辑/可删）—— 这正是 `listPending` 按 ctx 过滤要防的。
     *    所以：本处 0 条时待批准区整块不渲染，一条别人的条目都不许露出来。
     */
    expect(container.querySelectorAll(".memory-pending-item"), "不许把别处的待批准条目列进面板").toHaveLength(0);
    expect(container.querySelector(".memory-pending-title"), "待批准区整块不该出现").toBeNull();
    expect(
      (container.textContent ?? "").includes("别处待审事实"),
      "别处的条目**键名**一个字都不许出现在面板上（跨项目泄漏）",
    ).toBe(false);

    /*
     * ③ 既有动作语义一个都没被这一行改掉：本处 0 条时那些控件本来就不渲染，
     *    现在同样不渲染（不是被这一行"顺手禁掉"了）。
     */
    expect(container.querySelector(".memory-pending-batch-bar"), "批量条不该出现").toBeNull();
    expect(container.querySelector(".memory-pending-all-bar"), "一键全部批准/拒绝条不该出现").toBeNull();
    expect(container.querySelector(".memory-pending-check-all"), "全选框不该出现").toBeNull();
  });

  it("MOP-5：别处那几条在被处理掉之后，这一行立刻消失（读数跟着刷新走，不是一次性的）", async () => {
    seedOtherProjectPending(2);
    const container = await renderPanel();
    expect(lineText(container), "前提：先出现（全局 2 条）").toBe("其它项目还有 2 条待批准（去记忆体检处置）");

    /*
     * 用**服务层**把别处那两条删掉（等价于用户在记忆体检里处置掉它们），
     * 再走面板的真实刷新路径（切筛选/重渲染都会 `loadEntries()`）——
     * 这里直接用 `countPendingEntries` 复核服务层状态，再用 rerender 走一次面板挂载，
     * 确认那一行不会"留在那里"（陈旧读数）。
     */
    for (const e of svc.listPending(undefined, { projectId: OTHER_PROJ, sessionId: OTHER_SESSION })) svc.delete(e.id);
    expect(svc.countPendingEntries(), "前提：别处已清空").toBe(0);

    cleanup();
    const after = await renderPanel();
    expect(otherLine(after), "清空之后这一行必须消失").toBeNull();
  });
});
