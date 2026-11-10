/**
 * `UI-1`（24 §6）：记忆面板对**长条目**必须显示截断原因（超预算 / 单条上限）并提供「查看全文」；
 * 没有截断的短条目一个多余节点都不渲染。
 *
 * ## 被守的缺陷（改前）
 *
 * 列表预览硬编码 `entry.content.substring(0, 100) + "..."`：
 * - 永远带省略号（短条目也像被截了）；
 * - **截断原因一个字都没有** —— 用户不知道"这条为什么只剩半截"；
 * - 列表里也没有「查看全文」这个动作（只能点进详情面板，长列表逐条核对时非常别扭）。
 *
 * ## 变异自证
 *
 * 把 `reasons` 渲染那一块删掉（或改成永远空数组）⇒「超预算 / 单条上限」断言立刻红；
 * 把 `previewTruncated` 改成 `false` ⇒「查看全文」与全文展开断言红。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { createElement } from "react";
import { setStoragePort } from "../core/storage/port";
import { createFakeStoragePort } from "./fake-storage-port";
import { MemoryService } from "../core/memory/memory";
import * as memoryModule from "../core/memory/memory";
import { setSetting } from "../core/storage/settings";
import { MemoryManager } from "../components/MemoryManager";

const PROJ = "c:\\work\\ui1";
const SESSION = "s-ui1";

const LONG_CONTENT = `LONG_BODY_HEAD ${"长记忆正文。".repeat(40)} LONG_BODY_TAIL_MARKER`;
const TRUNCATED_CONTENT = `TRUNC_HEAD ${"截断正文。".repeat(2600)} TRUNC_TAIL_MARKER`; // > 10000 字符 ⇒ 写入时被截
const SHORT_CONTENT = "SHORT_BODY 这是一条不需要截断的短记忆";

let svc: MemoryService;
let getServiceSpy: ReturnType<typeof vi.spyOn>;

function itemByKey(container: HTMLElement, key: string): HTMLElement {
  const items = Array.from(container.querySelectorAll<HTMLElement>('[data-testid="memory-item"]'));
  const hit = items.find((el) => el.textContent?.includes(key));
  expect(hit, `列表里必须有「${key}」这一条`).toBeTruthy();
  return hit as HTMLElement;
}

async function renderPanel(): Promise<HTMLElement> {
  const view = await act(async () =>
    render(createElement(MemoryManager, { onClose: () => {}, projectId: PROJ, sessionId: SESSION })),
  );
  return view.container;
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  setStoragePort(createFakeStoragePort({ seed: { settings: [{ key: "noop", value: "" }] } }));
  setSetting("memory-write-approval", JSON.stringify({ platform: false, project: false, conversation: false }));
  svc = new MemoryService();
  const long = svc.add({ scope: "project", projectId: PROJ, key: "长条目", content: LONG_CONTENT, source: "manual" });
  const truncated = svc.add({ scope: "project", projectId: PROJ, key: "写入截断条目", content: TRUNCATED_CONTENT, source: "manual" });
  const short = svc.add({ scope: "project", projectId: PROJ, key: "短条目", content: SHORT_CONTENT, source: "manual" });
  expect(long.ok && truncated.ok && short.ok, "夹具必须先真的写进库").toBe(true);
  /* 前置：截断标记必须真的由写入路径落下（不是测试自己编的） */
  expect(truncated.entry?.truncatedAtWrite, "超过单条上限的写入必须留下截断标记").toBe(true);
  getServiceSpy = vi.spyOn(memoryModule, "getMemoryService").mockReturnValue(svc);
});

afterEach(() => {
  getServiceSpy.mockRestore();
  cleanup();
  setStoragePort(null);
  vi.restoreAllMocks();
});

describe("UI-1：长记忆条目的截断原因 + 查看全文", () => {
  it("UI-1a：长条目显示「超预算」原因与「查看全文」；点开后全文（含尾部标记）真的出现", async () => {
    const container = await renderPanel();
    const item = itemByKey(container, "长条目");

    expect(item.textContent, "超预算（注入只取前 120 字符）原因必须可见").toContain("超预算");
    const expand = item.querySelector<HTMLButtonElement>('[data-testid="memory-item-expand"]');
    expect(expand, "长条目必须有「查看全文」").toBeTruthy();
    expect(expand!.textContent).toContain("查看全文");
    expect(item.querySelector('[data-testid="memory-item-full"]'), "点开之前不许已经渲染全文").toBeNull();

    await act(async () => {
      fireEvent.click(expand!);
    });

    const full = itemByKey(container, "长条目").querySelector('[data-testid="memory-item-full"]');
    expect(full, "点开后必须渲染全文块").toBeTruthy();
    expect(full!.textContent, "全文必须含尾部标记（不是又一次截断）").toContain("LONG_BODY_TAIL_MARKER");
    expect(itemByKey(container, "长条目").textContent, "按钮变成「收起全文」").toContain("收起全文");
  });

  it("UI-1b：写入时超过单条上限的条目显示「单条上限」原因，展开后是库里留存的全长（不假装能恢复）", async () => {
    const container = await renderPanel();
    const item = itemByKey(container, "写入截断条目");

    expect(item.textContent, "单条上限原因必须可见").toContain("单条上限");
    const expand = item.querySelector<HTMLButtonElement>('[data-testid="memory-item-expand"]');
    expect(expand, "长条目必须有「查看全文」").toBeTruthy();

    await act(async () => {
      fireEvent.click(expand!);
    });
    const full = itemByKey(container, "写入截断条目").querySelector('[data-testid="memory-item-full"]');
    expect(full).toBeTruthy();
    const stored = svc
      .listAll({ includePending: true, includeUnscoped: true, showAllProjects: true })
      .find((e) => e.key === "写入截断条目")!;
    expect(stored.content.length, "库里留存的就是被截到上限的那一份").toBeLessThanOrEqual(10_000);
    expect(full!.textContent!.length, "展开的是库里留存的全长（10000），不是 100 字符预览").toBeGreaterThan(9_999);
  });

  it("UI-1c（反向对照）：没有截断的短条目**不显示**原因，也没有「查看全文」", async () => {
    const container = await renderPanel();
    const item = itemByKey(container, "短条目");

    expect(item.querySelector('[data-testid="memory-item-truncation"]'), "无截断 ⇒ 不许渲染原因块").toBeNull();
    expect(item.querySelector('[data-testid="memory-item-expand"]'), "无截断 ⇒ 不许出现「查看全文」").toBeNull();
    expect(item.textContent).not.toContain("超预算");
    expect(item.textContent).not.toContain("单条上限");
    expect(item.textContent, "短条目的正文照常可见（不是整块不渲染）").toContain("SHORT_BODY");
  });
});
