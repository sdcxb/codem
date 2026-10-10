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

beforeEach(() => {
  saveMemory("");
  setSetting(MEMORY_WRITE_APPROVAL_KEY, JSON.stringify({ platform: true, project: true, conversation: false }));
  port = createFakeStoragePort({ seed: { settings: [{ key: "noop", value: "" }] } });
  setStoragePort(port);
  svc = seedPending(3);
  vi.spyOn(memoryModule, "getMemoryService").mockReturnValue(svc);
});

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
  setStoragePort(null);
});

describe("MEM-BATCH-UI：待批准区的勾选 + 批量同意/拒绝（含全选）", () => {
  it("MB-UI-1：没勾选时两个批量按钮是禁用的（不许出现「点了没反应」）", async () => {
    const container = await renderPanel();
    expect(pendingKeys(container), "前提：三条待批准都在").toHaveLength(3);
    expect(batchButton(container, "同意").disabled, "一条都没勾 ⇒ 批量同意必须禁用").toBe(true);
    expect(batchButton(container, "拒绝").disabled, "一条都没勾 ⇒ 批量拒绝必须禁用").toBe(true);
    expect(batchButton(container, "同意").textContent, "按钮上要显示当前勾选数").toContain("（0）");
  });

  it("MB-UI-2：勾两条 ⇒ 批量同意只处理这两条（第三条仍在待批准区）", async () => {
    const container = await renderPanel();
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
});
