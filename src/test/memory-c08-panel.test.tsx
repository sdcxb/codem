/**
 * C08「Memory Graph」面板判据：`validUntil` / `confidence` / 冲突的**只读展示**。
 *
 * ## 被守的缺陷
 *
 * 记忆层（`memory.ts`）早就有有效期、置信度、显式冲突与 `conflicts()`，`memory-tools.ts`
 * 的输出也带来源/过期/置信度/冲突 —— 但 `MemoryManager.tsx` 一个字段都不展示。
 * 用户只能从工具面（模型调用）看到这些事实，**自己在面板上看不到**：过期条目照常显示成
 * 有效记忆、冲突的两条并排躺着也不说它们打架。这正是 C08 的「冲突可见 / 有效期可见」边界。
 *
 * ## 判据口径（每条都能变红）
 *
 * - C08-PANEL-1：有有效期/置信度字段 ⇒ 行与详情都出现对应文本与状态（过期必须写「已过期」，
 *   置信度 0 是合法值、必须显示 —— 0 与「没标注」是两件事）；
 * - C08-PANEL-2：没有这些字段的旧条目 ⇒ **不渲染、不占位、不抛错**（空值不占位）；
 * - C08-PANEL-3：自动判定（同 key 内容不同）的冲突徽标要点名对家并可点击定位；
 * - C08-PANEL-3b：显式 `conflictOf`（只连两条、不成组）也必须标出（`conflicts()` 会漏掉这种形态）；
 * - C08-PANEL-4：无冲突条目没有冲突徽标（阴性对照）。
 *
 * 变异自证：把 `isExpiredMemoryEntry(entry)` 判成恒 `false` ⇒ 第 1 条立即红
 * （`已过期` 消失、只剩「有效期至」）。
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

const PROJ = "proj-c08";
const SESSION = "sess-c08";
const DAY = 24 * 60 * 60 * 1000;

let port: FakeStoragePort;
let svc: MemoryService;

function seed(): MemoryService {
  const service = new MemoryService();
  // 过期 + 有置信度：行上必须出现「已过期」与「置信度 0.3」
  service.add({
    scope: "project",
    projectId: PROJ,
    key: "过期约定",
    content: "这条约定早就作废了，不能再当现行约定用。",
    source: "manual",
    validUntil: Date.now() - DAY,
    confidence: 0.3,
  });
  // 未过期 + 置信度 0（0 是合法值，不是「未标注」）
  service.add({
    scope: "project",
    projectId: PROJ,
    key: "有效约定",
    content: "这条约定还有效。",
    source: "manual",
    validUntil: Date.now() + DAY,
    confidence: 0,
  });
  // 旧条目：一个 C08 字段都没有（面板必须正常显示、不占位）
  service.add({
    scope: "project",
    projectId: PROJ,
    key: "旧条目",
    content: "升级前写入的旧记忆，一个 C08 字段都没有。",
    source: "manual",
  });
  // 自动判定的冲突：同 scope + 同 key、内容不同 ⇒ 互为一组
  service.add({
    scope: "project",
    projectId: PROJ,
    key: "部署方式",
    content: "用蓝绿部署。",
    source: "manual",
  });
  service.add({
    scope: "project",
    projectId: PROJ,
    key: "部署方式",
    content: "用滚动部署。",
    source: "manual",
  });
  // 显式断言：`conflictOf` 只连两条、不会成组 —— 面板也必须标出来（这条曾被 `conflicts()` 漏掉）
  const windowA = service.add({
    scope: "project",
    projectId: PROJ,
    key: "发布窗口",
    content: "周五凌晨发布。",
    source: "manual",
  });
  service.add({
    scope: "project",
    projectId: PROJ,
    key: "发布窗口（另一说法）",
    content: "周一上午发布。",
    source: "manual",
    conflictOf: windowA.entry!.id,
  });
  return service;
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

/** 按**键名**取主列表里的一行（不按下标：同时间戳的排序不稳定） */
function rowFor(container: HTMLElement, key: string): HTMLElement {
  const keyEl = Array.from(container.querySelectorAll(".memory-item-key")).find(
    (el) => (el.textContent ?? "") === key,
  );
  expect(keyEl, `主列表里必须有「${key}」这一行（前提）`).toBeTruthy();
  return keyEl!.closest(".memory-item") as HTMLElement;
}

/** 取主列表里键名等于 `key` 的**全部**行（冲突组有两条） */
function rowsFor(container: HTMLElement, key: string): HTMLElement[] {
  return Array.from(container.querySelectorAll(".memory-item")).filter(
    (row) => row.querySelector(".memory-item-key")?.textContent === key,
  ) as HTMLElement[];
}

function selectRow(row: HTMLElement): void {
  act(() => {
    fireEvent.click(row);
  });
}

function detailOf(container: HTMLElement): HTMLElement {
  const detail = container.querySelector(".memory-detail");
  expect(detail, "点选条目后必须出现详情面板（前提）").toBeTruthy();
  return detail as HTMLElement;
}

beforeEach(() => {
  saveMemory("");
  setSetting(MEMORY_WRITE_APPROVAL_KEY, JSON.stringify({ platform: true, project: true, conversation: true }));
  port = createFakeStoragePort({ seed: { settings: [{ key: "noop", value: "" }] } });
  setStoragePort(port);
  svc = seed();
  vi.spyOn(memoryModule, "getMemoryService").mockReturnValue(svc);
});

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
  setStoragePort(null);
});

describe("C08-PANEL：记忆面板只读展示有效期 / 置信度 / 冲突", () => {
  it("C08-PANEL-1：有过期/置信度字段 ⇒ 行与详情都渲染对应文本；过期状态写「已过期」", async () => {
    const container = await renderPanel();

    const expiredRow = rowFor(container, "过期约定");
    const expiredBadge = expiredRow.querySelector(".memory-source-badge.expired");
    expect(expiredBadge, "过期条目必须有独立的「已过期」状态徽标（不是普通有效期样式）").toBeTruthy();
    expect(expiredBadge!.textContent, "过期条目必须在行上直接说「已过期」").toContain("已过期");
    expect(expiredBadge!.textContent, "过期也要给出原有效期（可核对）").toContain("有效期至");
    expect(expiredRow.textContent, "置信度必须在行上可见").toContain("置信度 0.3");
    expect(expiredRow.textContent, "来源本来就是面板既有能力，不能被这轮改丢").toContain("手动");

    selectRow(expiredRow);
    const detail = detailOf(container);
    expect(
      detail.querySelector(".memory-expired-text")?.textContent,
      "详情必须重复「已过期」这个状态",
    ).toContain("已过期");
    expect(detail.textContent).toContain("有效期");
    expect(detail.textContent).toContain("0.3");

    const validRow = rowFor(container, "有效约定");
    const validBadge = validRow.querySelector(".memory-source-badge.expiring");
    expect(validBadge, "未过期但有有效期的条目要有独立状态徽标").toBeTruthy();
    expect(validBadge!.textContent, "未过期条目要给出有效期").toContain("有效期至");
    expect(validRow.querySelector(".memory-source-badge.expired"), "未过期条目不许被标成已过期").toBeNull();
    expect(validRow.textContent, "置信度 0 是合法值，必须显示（0 与未标注是两件事）").toContain("置信度 0");
  });

  it("C08-PANEL-2：无 C08 字段的旧条目 ⇒ 不渲染、不占位、不抛错", async () => {
    const container = await renderPanel();

    const row = rowFor(container, "旧条目");
    expect(row.textContent, "旧条目不该凭空多出有效期").not.toContain("有效期");
    expect(row.textContent, "旧条目不该凭空多出置信度").not.toContain("置信度");
    expect(row.textContent, "旧条目没有冲突，不该出现冲突标记").not.toContain("冲突");

    // 点开详情同样一个字段都不该出现（空值不占位）
    selectRow(row);
    const detail = detailOf(container);
    expect(detail.textContent, "详情也不许给旧条目编造有效期").not.toContain("有效期");
    expect(detail.textContent, "详情也不许给旧条目编造置信度").not.toContain("置信度");
    expect(detail.textContent, "详情也不许给旧条目编造冲突").not.toContain("冲突");
  });

  it("C08-PANEL-3：冲突条目互相点名，徽标可点击定位到对家", async () => {
    const container = await renderPanel();

    const conflictRows = rowsFor(container, "部署方式");
    expect(conflictRows, "前提：同 key 不同内容的两条都在列表里").toHaveLength(2);

    const badges = conflictRows
      .map((row) => row.querySelector(".memory-source-badge.conflict"))
      .filter((badge): badge is HTMLElement => Boolean(badge));
    expect(badges, "两条冲突条目的行上都要有冲突徽标").toHaveLength(2);
    expect(badges[0].textContent, "徽标要点名与哪条冲突").toContain("部署方式");
    expect(badges[0].textContent).toContain("冲突");

    // 点徽标 ⇒ 定位到冲突对家：详情里出现「冲突」栏与可点的对家
    act(() => {
      fireEvent.click(badges[0]);
    });
    const detail = detailOf(container);
    expect(detail.textContent, "详情必须说明这条和谁冲突").toContain("冲突");
    const links = Array.from(detail.querySelectorAll(".memory-conflict-link")) as HTMLElement[];
    expect(links, "详情里要给出可点击定位的冲突对家").toHaveLength(1);
    expect(links[0].textContent).toBe("部署方式");

    const before = detail.querySelector(".memory-detail-content")?.textContent;
    act(() => {
      fireEvent.click(links[0]);
    });
    const after = detailOf(container).querySelector(".memory-detail-content")?.textContent;
    expect(after, "点对家后详情必须换成另一条的内容（真的定位过去了）").not.toBe(before);
    expect(["用蓝绿部署。", "用滚动部署。"], "定位到的必须是这组冲突里的另一条").toContain(after);
  });

  it("C08-PANEL-3b：显式 conflictOf（只连两条、不成组）也必须标出并互相点名", async () => {
    const container = await renderPanel();
    const rowA = rowFor(container, "发布窗口");
    const rowB = rowFor(container, "发布窗口（另一说法）");
    const badgeA = rowA.querySelector(".memory-source-badge.conflict") as HTMLElement | null;
    const badgeB = rowB.querySelector(".memory-source-badge.conflict") as HTMLElement | null;
    expect(badgeA, "conflictOf 指向另一条时必须标冲突（conflicts() 会漏掉这种形态）").toBeTruthy();
    expect(badgeB, "被指向的那条也要互相点名").toBeTruthy();
    expect(badgeA!.textContent).toContain("发布窗口（另一说法）");
    expect(badgeB!.textContent).toContain("发布窗口");

    // 点徽标 ⇒ 详情里给出可定位的对家
    act(() => {
      fireEvent.click(badgeA!);
    });
    const links = Array.from(detailOf(container).querySelectorAll(".memory-conflict-link")) as HTMLElement[];
    expect(links.map((link) => link.textContent), "定位到对家后，对家的详情要指回原来那条").toEqual(["发布窗口"]);
  });

  it("C08-PANEL-4：无冲突的条目没有冲突徽标（阴性对照）", async () => {
    const container = await renderPanel();
    expect(rowFor(container, "旧条目").querySelector(".memory-source-badge.conflict"), "无冲突条目不许出现徽标").toBeNull();
    expect(rowFor(container, "过期约定").querySelector(".memory-source-badge.conflict")).toBeNull();
    expect(container.querySelectorAll(".memory-source-badge.conflict"), "全库冲突徽标数 = 冲突条目数").toHaveLength(4);
  });
});
