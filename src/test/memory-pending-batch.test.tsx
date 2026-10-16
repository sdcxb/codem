/**
 * 第 196 波 · 界面那一半：待批准区的**勾选 + 批量同意 / 批量拒绝（含全选）**。
 *
 * ## 为什么必须在真渲染上测
 *
 * 服务层的批量语义已经在 `memory-approve-scope-batch.test.ts` 里钉住了。这一族要挡的是
 * **接线层面的错法**（都是本仓库踩过的形态）：
 * - 勾了没反应（按钮 disabled 判据写错：`selectedPending` 非空但按钮仍禁用，或反过来恒可点）；
 * - 「全选」按"集合非空"判而不是"是不是全都选中了" ⇒ 全选之后再点一次无法取消；
 * - 批量之后**选中状态没清**（下一次点批量会带着已经处理过的 id 去算数 —— "幽灵选中"）；
 * - 全选之后取消一条，批量却把**全部**都处理了（数字与实际动作不一致）。
 *
 * 断言的是**真 DOM**：勾选框的 `checked`、按钮的 `disabled`、按钮文案里的数字、
 * 待批准区条目的增减，以及动作后的提示语。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent, act } from "@testing-library/react";
import { createElement } from "react";

/**
 * ★ 第 229 波：「一键全部拒绝」必须走 `confirmDialog`（NC-1 禁止裸 `window.confirm`：
 * Tauri dialog 下它返回 Promise ⇒ 闸门静默失效）。这里换成可控 spy，
 * 用来分别验证"确认删除"与"取消不删"两条路（与 `memory-checkup.test.tsx` 同一套写法）。
 */
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

const PROJ = "proj-196";
const SESSION = "sess-196";

let port: FakeStoragePort;
let svc: MemoryService;

function seedPending(n: number): MemoryService {
  const service = new MemoryService();
  for (let i = 0; i < n; i++) {
    service.add({
      scope: "project",
      projectId: PROJ,
      key: `待审事实 ${i}`,
      content: `第 ${i} 条待批准的自动记忆内容（足够长以便入库）`,
      source: "auto",
      status: "pending",
      batchId: "batch-196",
    });
  }
  return service;
}

/** 渲染面板（`getMemoryService` 换成我们自己的实例，数据面是假端口） */
async function renderPanel(): Promise<HTMLElement> {
  const { container } = render(createElement(MemoryManager, { onClose: () => {}, projectId: PROJ, sessionId: SESSION } as never));
  await act(async () => {
    await Promise.resolve();
  });
  return container;
}

/** 待批准区里每一行的勾选框 */
function rowChecks(container: HTMLElement): HTMLInputElement[] {
  return Array.from(container.querySelectorAll<HTMLInputElement>(".memory-pending-item input[type=checkbox]"));
}

function selectAllCheck(container: HTMLElement): HTMLInputElement {
  const el = container.querySelector<HTMLInputElement>(".memory-pending-check-all input[type=checkbox]");
  expect(el, "必须有「全选」勾选框").toBeTruthy();
  return el!;
}

/** 按文案找批量按钮（不按下标） */
function batchButton(container: HTMLElement, kind: "同意" | "拒绝"): HTMLButtonElement {
  const btn = Array.from(container.querySelectorAll<HTMLButtonElement>(".memory-pending-batch-bar button")).find((b) =>
    (b.textContent ?? "").includes(`批量${kind}`),
  );
  expect(btn, `必须有「批量${kind}」按钮`).toBeTruthy();
  return btn!;
}

/**
 * ★ 第 229 波：「一键全部批准 / 全部拒绝」按钮（在 `.memory-pending-all-bar` 里）。
 *
 * ⚠️ 刻意与 `batchButton`（`.memory-pending-batch-bar`）**分开取**：两组按钮的数字口径不同
 * （勾选数 vs 待批准总数），合成一个查询就会让判据无法区分"点错了哪一个"——
 * 而"点错按钮"正是这一族判据要挡的形态。
 */
function allButton(container: HTMLElement, kind: "批准" | "拒绝"): HTMLButtonElement {
  const btn = Array.from(container.querySelectorAll<HTMLButtonElement>(".memory-pending-all-bar button")).find((b) =>
    (b.textContent ?? "").includes(`全部${kind}`),
  );
  expect(btn, `必须有「全部${kind}」按钮`).toBeTruthy();
  return btn!;
}

/** 待批准条目的键名列表（真 DOM 顺序） */
function pendingKeys(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll(".memory-pending-key")).map((el) => el.textContent ?? "");
}

/**
 * 按**键名**取某一行的勾选框。
 *
 * ⚠️ 不用下标：`listPending` 按 `timestamp` 倒序，而三条夹具条目是同一个毫秒里写进去的
 * （`Date.now()` 精度），排序在并列时不稳定 ⇒ 按下标取的"第 1 行"在单独跑与全量跑时
 * 可能是不同的条目（我第一次就是这么写的，单独跑绿、全量跑红）。
 * 判据要断的是"勾了哪几条"，不是"它们排第几"。
 */
function checkForKey(container: HTMLElement, key: string): HTMLInputElement {
  const keys = Array.from(container.querySelectorAll(".memory-pending-key"));
  const row = keys.find((el) => (el.textContent ?? "") === key)?.closest(".memory-pending-item");
  const input = row?.querySelector<HTMLInputElement>("input[type=checkbox]");
  expect(input, `必须有「${key}」那一行（前提）`).toBeTruthy();
  return input!;
}

/** 勾选框对应的键名（用 DOM 关系反查，保留给"全选"这类按行操作的用例） */
function keysOfChecked(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll(".memory-pending-item"))
    .filter((row) => row.querySelector<HTMLInputElement>("input[type=checkbox]")?.checked)
    .map((row) => row.querySelector(".memory-pending-key")?.textContent ?? "");
}

function noticeText(container: HTMLElement): string {
  const notices = Array.from(container.querySelectorAll(".memory-notice")).map((el) => el.textContent ?? "");
  return notices.join(" | ");
}

/**
 * ★ 第 229 波：把待批准区的勾选**清零**。
 *
 * 为什么需要它：这一波加了「本批默认勾选」（用户要求"面板少动手"），于是
 * **"初始态 = 没有勾选"这个前提不再成立**（夹具三条同批 ⇒ 一进面板就全勾上了）。
 * 下面几条判据要守的东西一个字没变（"没有勾选时按钮禁用" / "全选↔全不选" / "批量只动勾选的"），
 * 它们只是需要一个"无勾选"的起点 ⇒ 用**真实界面路径**（点「全选」框）把它清零。
 *
 * 为什么循环两次就够：「全选」框的语义是"是不是全都选中了"→ 全选中就清空、否则就全选。
 * 从任意状态出发，第 1 次必到"全选中"或"全不选"，第 2 次必到另一端 ⇒ 两次之内一定清空。
 */
function clearPendingSelection(container: HTMLElement): void {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (keysOfChecked(container).length === 0) return;
    act(() => {
      fireEvent.click(selectAllCheck(container));
    });
  }
}

beforeEach(() => {
  saveMemory("");
  setSetting(MEMORY_WRITE_APPROVAL_KEY, JSON.stringify({ platform: true, project: true, conversation: false }));
  port = createFakeStoragePort({ seed: { settings: [{ key: "noop", value: "" }] } });
  setStoragePort(port);
  svc = seedPending(3);
  vi.spyOn(memoryModule, "getMemoryService").mockReturnValue(svc);
  /* ★ 第 229 波：二次确认的答案由每条用例自己给（默认"取消"，fail-closed） */
  confirmSpy.mockReset();
  confirmSpy.mockResolvedValue(false);
});

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
  setStoragePort(null);
});

describe("MEM-BATCH-UI：待批准区的勾选 + 批量同意/拒绝（含全选）", () => {
  it("MB-UI-1：清空勾选后两个批量按钮是禁用的（不许出现「点了没反应」）", async () => {
    const container = await renderPanel();
    expect(pendingKeys(container), "前提：三条待批准都在").toHaveLength(3);
    /*
     * ★ 第 229 波：默认勾选本批之后，"初始态无勾选"这个前提不再成立（见 MB-UI-6）。
     * 这条判据要守的东西没变 ——「没有勾选时按钮必须禁用、数字必须是 0」——
     * 所以先把勾选清零再断言（清零走真实界面路径，不直接改 state）。
     */
    clearPendingSelection(container);
    expect(keysOfChecked(container), "前提：勾选已清零").toHaveLength(0);
    expect(batchButton(container, "同意").disabled, "一条都没勾 ⇒ 批量同意必须禁用").toBe(true);
    expect(batchButton(container, "拒绝").disabled, "一条都没勾 ⇒ 批量拒绝必须禁用").toBe(true);
    expect(batchButton(container, "同意").textContent, "按钮上要显示当前勾选数").toContain("（0）");
  });

  it("MB-UI-2：勾两条 ⇒ 批量同意只处理这两条（第三条仍在待批准区）", async () => {
    const container = await renderPanel();
    clearPendingSelection(container);
    act(() => {
      fireEvent.click(checkForKey(container, "待审事实 1"));
      fireEvent.click(checkForKey(container, "待审事实 2"));
    });

    const approve = batchButton(container, "同意");
    expect(approve.disabled, "勾了就该可点").toBe(false);
    expect(approve.textContent, "按钮数字 = 当前勾选数").toContain("（2）");
    expect(keysOfChecked(container).sort(), "前提：勾中的确实是这两条").toEqual(["待审事实 1", "待审事实 2"]);

    await act(async () => {
      fireEvent.click(approve);
    });
    expect(pendingKeys(container), "只处理勾选的那两条").toEqual(["待审事实 0"]);
    expect(noticeText(container), "回执要说清批准了几条").toContain("批量批准 2 条");
    /*
     * 勾选状态必须清空 —— 判据落在**可观察的读数**上（按钮数字 + 是否禁用），
     * 而不是去读旧 DOM 节点：被处理掉的行会随 React 卸载，读它们的 `checked` 量到的是
     * 一个**已脱离文档**的节点（我第一次就是这么写的，读出来是 true，纯属量错对象）。
     * 如果选中集合没清，这里会显示「（2）」并且按钮仍可点。
     */
    expect(batchButton(container, "同意").textContent, "批量之后勾选数必须归零").toContain("（0）");
    expect(batchButton(container, "同意").disabled, "没有选中 ⇒ 按钮回到禁用").toBe(true);
  });

  it("MB-UI-3：全选 ⇒ 再点一次全不选；**部分勾选时点全选仍是全选**（不是清空）", async () => {
    const container = await renderPanel();
    /* ★ 第 229 波：默认勾选本批 ⇒ 先清零，否则下面第一次点「全选」会变成"全不选" */
    clearPendingSelection(container);
    const all = selectAllCheck(container);

    act(() => {
      fireEvent.click(all);
    });
    expect(rowChecks(container).every((c) => c.checked), "全选 ⇒ 每一行都被勾上").toBe(true);
    expect(batchButton(container, "拒绝").textContent, "按钮数字 = 全部").toContain("（3）");

    act(() => {
      fireEvent.click(selectAllCheck(container));
    });
    expect(rowChecks(container).some((c) => c.checked), "再点一次必须全不选").toBe(false);
    expect(batchButton(container, "拒绝").disabled).toBe(true);

    /*
     * 反向对照（这一条是**变异逼出来的**）：只勾一条时点「全选」，必须变成"全部选中"。
     * 如果实现把"集合非空"当成"已经全选了"，这里会被**清空** —— 用户看到的是
     * "我点全选，结果全没了"（而"全选 → 再点 → 全不选"那条路径两种实现恰好一样，
     * 只靠上面对照不出来）。
     */
    act(() => {
      fireEvent.click(checkForKey(container, "待审事实 0"));
    });
    expect(keysOfChecked(container), "前提：只勾了一条").toHaveLength(1);
    act(() => {
      fireEvent.click(selectAllCheck(container));
    });
    expect(keysOfChecked(container).length, "部分勾选时点「全选」⇒ 必须选中全部（不许清空）").toBe(3);
  });

  it("MB-UI-4：全选之后取消一条 ⇒ 批量拒绝只删掉剩下两条", async () => {
    const container = await renderPanel();
    clearPendingSelection(container); // ★ 第 229 波：默认勾选本批 ⇒ 先清零再走"全选"
    act(() => {
      fireEvent.click(selectAllCheck(container));
    });
    act(() => {
      fireEvent.click(checkForKey(container, "待审事实 1")); // 取消这一条
    });

    await act(async () => {
      fireEvent.click(batchButton(container, "拒绝"));
    });
    expect(pendingKeys(container), "被取消勾选的那一条必须留在待批准区").toEqual(["待审事实 1"]);
    expect(noticeText(container)).toContain("批量拒绝 2 条");
    expect(svc.listPending(undefined, { projectId: PROJ }), "服务层也要只剩一条").toHaveLength(1);
  });

  it("MB-UI-5（反向对照）：全选 + 批量同意之后，待批准区整块消失，且记忆真的生效", async () => {
    const container = await renderPanel();
    clearPendingSelection(container); // ★ 第 229 波：默认勾选本批 ⇒ 先清零再走"全选"
    act(() => {
      fireEvent.click(selectAllCheck(container));
    });
    await act(async () => {
      fireEvent.click(batchButton(container, "同意"));
    });

    expect(container.querySelector(".memory-pending-section"), "没有待批准条目时整块不该再渲染").toBeNull();
    expect(svc.getStats({ projectId: PROJ, sessionId: SESSION }).pendingEntries, "统计也要归零").toBe(0);
    expect(
      svc.buildMemoryPrompt("project", PROJ, SESSION),
      "批准之后必须真的进上下文（否则「批量同意」是个假动作）",
    ).toContain("第 0 条待批准的自动记忆内容");
  });

  /* ===== 第 229 波：本批默认勾选 + 一键全部批准 / 全部拒绝（用户要求「面板少动手」） ===== */

  it("MB-UI-6：一进面板就**默认勾选本批**，并显示「本批 N 条 / 待批准共 M 条」", async () => {
    const container = await renderPanel();
    /*
     * 被守的缺陷（用户实报「待批准条数过多、频繁打扰」）：积压摆在面板里，而用户要处置的是
     * **刚产生的那一批** —— 旧实现要求他先点一次「全选」（默认一个都不勾），
     * 而积压意味着这个动作每轮都要重来一次。
     */
    expect(pendingKeys(container), "前提：三条待批准都在").toHaveLength(3);
    expect(keysOfChecked(container), "打开面板即默认勾选本批（三条同批 ⇒ 三条都勾）").toHaveLength(3);
    expect(batchButton(container, "同意").disabled, "默认勾上了 ⇒ 批量按钮立即可点").toBe(false);
    expect(batchButton(container, "同意").textContent, "勾选数=本批条数").toContain("（3）");
    const hint = container.querySelector(".memory-pending-batch-hint")?.textContent ?? "";
    expect(hint, "界面必须说清「本批几条」与「待批准共几条」两个口径").toContain("本批 3 条");
    expect(hint, "两个口径都要在（只有本批数会让用户以为总共就这么多）").toContain("待批准共 3 条");
  });

  it("MB-UI-6b（反向对照）：**没有批次号**的旧数据不默认勾选（不许替用户猜）", async () => {
    /*
     * 旧自动记忆（升级前写的那批）没有 `batchId` ⇒ "本批"这个概念不存在。
     * 如果不做这条反向对照，一个"无脑全勾"的实现也能让 MB-UI-6 变绿 ——
     * 而它会在用户的旧数据上一次性勾满，让「批量拒绝」变成一次误点删 N 条。
     */
    saveMemory(""); // ★ 先清掉 beforeEach 写的那三条（否则新实例会把它们跟旧数据一起读进来）
    const legacy = new MemoryService();
    for (let i = 0; i < 3; i++) {
      legacy.add({
        scope: "project",
        projectId: PROJ,
        key: `旧自动事实 ${i}`,
        content: `第 ${i} 条没有批次号的旧自动记忆（足够长以便入库）`,
        source: "auto",
        status: "pending",
      });
    }
    vi.spyOn(memoryModule, "getMemoryService").mockReturnValue(legacy);

    const container = await renderPanel();
    expect(pendingKeys(container), "前提：三条旧待批准都在").toHaveLength(3);
    expect(keysOfChecked(container), "没有批次号 ⇒ 一条都不许默认勾选").toHaveLength(0);
    expect(batchButton(container, "拒绝").disabled, "相应地，批量按钮保持禁用").toBe(true);
    expect(
      container.querySelector(".memory-pending-batch-hint")?.textContent ?? "",
      "要如实说明为什么没有「本批」（不许把它显示成「本批 3 条」）",
    ).toContain("没有批次号");
  });

  it("MB-UI-7：**一键全部批准**不看勾选（清零勾选也能一次批准全部）", async () => {
    const container = await renderPanel();
    clearPendingSelection(container);
    expect(keysOfChecked(container), "前提：一条都没勾").toHaveLength(0);

    await act(async () => {
      fireEvent.click(allButton(container, "批准"));
    });

    expect(container.querySelector(".memory-pending-section"), "全部批准 ⇒ 待批准区整块消失").toBeNull();
    expect(svc.getStats({ projectId: PROJ, sessionId: SESSION }).pendingEntries, "统计归零").toBe(0);
    expect(
      svc.buildMemoryPrompt("project", PROJ, SESSION),
      "批准后必须真的进上下文（否则「一键全部批准」是假动作）",
    ).toContain("第 0 条待批准的自动记忆内容");
    expect(noticeText(container), "回执要说清这次动了多少条").toMatch(/3/);
  });

  it("MB-UI-8（反向对照）：**一键全部拒绝**要先二次确认；取消 ⇒ 一条都不许删", async () => {
    const container = await renderPanel();
    confirmSpy.mockResolvedValue(false);
    await act(async () => {
      fireEvent.click(allButton(container, "拒绝"));
    });
    expect(confirmSpy, "删除全部必须先问一次").toHaveBeenCalled();
    expect(pendingKeys(container), "取消 ⇒ 待批准区一条不少").toHaveLength(3);
    expect(svc.listPending(undefined, { projectId: PROJ }), "服务层也一条不少").toHaveLength(3);
    expect(noticeText(container), "要如实说清什么都没删").toContain("已取消");

    /* 另一半：确认之后必须**真的**把全部删掉（否则取消那半条判据一个"什么都不做"的实现也能过） */
    confirmSpy.mockResolvedValue(true);
    await act(async () => {
      fireEvent.click(allButton(container, "拒绝"));
    });
    expect(container.querySelector(".memory-pending-section"), "确认 ⇒ 整块消失").toBeNull();
    expect(svc.listPending(undefined, { projectId: PROJ }), "服务层清零").toHaveLength(0);
  });

  it("MB-UI-9：用户手动清空勾选后**不许被自动勾回来**（默认勾选只发生一次）", async () => {
    const container = await renderPanel();
    expect(keysOfChecked(container), "前提：默认已勾选").toHaveLength(3);
    clearPendingSelection(container);
    expect(keysOfChecked(container), "清空之后必须保持清空").toHaveLength(0);
    /*
     * 再触发一次"批次不变的重渲染"（勾一条 ⇒ setState ⇒ 重渲染）：如果自动勾选写成了
     * "每次渲染都补齐本批"，这里会被勾回三条 —— 用户看到的是"我取消不掉"。
     */
    act(() => {
      fireEvent.click(checkForKey(container, "待审事实 0"));
    });
    expect(keysOfChecked(container), "重渲染之后仍然只有用户自己勾的那一条").toEqual(["待审事实 0"]);
  });
});
