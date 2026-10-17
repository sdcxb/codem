/**
 * MPS-231：记忆面板**待批准列表必须能滚**（用户实报缺陷）。
 *
 * ## 用户报的缺陷（原话要点）
 * 面板头部写着「待批准的自动记忆（11 条）」，但列表**只显示 7 条、没有滚动条**，
 * 第 8 条被裁在底部，剩下 3 条**既看不到也批不了**。
 *
 * ## 真机量测（隔离数据根 + 12 条 pending，CDP 压视口 1200×700）
 *
 * | 量 | 修前 |
 * | --- | --- |
 * | `.memory-manager` | y 71 → 629（高 558） |
 * | `.memory-pending-section` | y **289** → **908**（高 **619**，比面板还高 61px） |
 * | `section.overflowY` | `visible`（没有任何滚动区） |
 * | `section.scrollTop = 400` 之后 | 仍是 **0**（`moved: false`）；`manager.scrollTop` 同样不动 |
 * | 第 12 条 `getBoundingClientRect()` | y 859 → **895**（越过面板底边 629，也在视口 700 之外） |
 * | `elementFromPoint(40, y12)` | 命中 `tour-overlay`（不是第 12 条） |
 *
 * 也就是说：**没有任何元素负责滚动**，溢出被祖先 `.app-content` 的 `overflow: hidden` 裁掉 ——
 * 这正是"第 8 条起不可达"的成因。
 *
 * ## 判据（happy-dom 没有布局引擎，所以分两层）
 *
 * 1. **声明判据**（本文件，可跑在任何机器上）：拆成两段之后
 *    `.memory-pending-section` 必须可压缩（`flex` + `min-height: 0`）且有高度上限；
 *    `.memory-pending-list` 必须是**唯一的滚动区**（`overflow-y: auto` + `min-height: 0` + `flex: 1 1 auto`）；
 *    `.memory-pending-head` 必须不参与收缩（`flex: none`）—— 否则读数字的那一行会被列表挤掉。
 * 2. **几何判据**（真机，`.preview-shot/_mem231-probe.mjs`）：滚到列表末尾后第 12 条
 *    `getBoundingClientRect()` 必须整体落在面板可视区内、`elementFromPoint` 必须命中它自己、
 *    顶部提示/批量栏的 y 在滚动前后**不变**。happy-dom 里 `getBoundingClientRect()` 全 0、
 *    连 `getComputedStyle` 都不参与样式表计算（本仓 `memory-panel-layout.test.tsx` 已记过这件事），
 *    所以几何那半只能真机跑 —— 两层合起来才算这件事被钉住。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent, act } from "@testing-library/react";
import { createElement } from "react";

vi.mock("../core/ui/native-dialog", () => ({
  confirmDialog: vi.fn().mockResolvedValue(false),
  alertDialog: vi.fn().mockResolvedValue(undefined),
}));

import { setStoragePort } from "../core/storage/port";
import { createFakeStoragePort } from "./fake-storage-port";
import { saveMemory, setSetting } from "../core/storage/settings";
import { MemoryService, MEMORY_WRITE_APPROVAL_KEY } from "../core/memory/memory";
import * as memoryModule from "../core/memory/memory";
import { MemoryManager } from "../components/MemoryManager";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(__dirname, "..", "..");
const STYLES = fs.readFileSync(path.join(ROOT, "src", "styles.css"), "utf8");
const PROJ = "proj-231";
const SESSION = "sess-231";
const COUNT = 12;

/** 取某选择器的**顶层**规则体（选择器必须独占一行开头；忽略 `.a .b` 里的子串）。 */
function ruleBody(css: string, selector: string): string {
  const re = new RegExp(`(^|\\})\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^{}]*)\\}`, "m");
  const m = css.match(re);
  expect(m, `styles.css 里找不到规则 ${selector}`).toBeTruthy();
  return m![2];
}

/** 规则体 → 声明表（值里可能出现 `1 1 auto` 这类多值，按第一个 `:` 切即可） */
function declarations(body: string): Record<string, string> {
  /* 先剥注释：规则体里允许写「为什么这样」（本仓到处是），不剥的话 `a /* … *\/ b:` 会被拼成一个怪名字 */
  const clean = body.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: Record<string, string> = {};
  for (const chunk of clean.split(";")) {
    const i = chunk.indexOf(":");
    if (i < 0) continue;
    const name = chunk.slice(0, i).trim();
    if (name) out[name] = chunk.slice(i + 1).trim();
  }
  return out;
}

function seedPending(n: number): MemoryService {
  const service = new MemoryService();
  for (let i = 0; i < n; i++) {
    service.add({
      scope: "project",
      projectId: PROJ,
      key: `待审事实 ${i + 1}`,
      content: `第 ${i + 1} 条待批准的自动记忆内容（MPS-231 的滚动判据用，序号 ${i + 1}）`,
      source: "auto",
      status: "pending",
    });
  }
  return service;
}

async function renderPanel(container?: HTMLElement): Promise<HTMLElement> {
  const r = render(
    createElement(MemoryManager, { onClose: () => {}, projectId: PROJ, sessionId: SESSION } as never),
  );
  await act(async () => {
    await Promise.resolve();
  });
  return container ?? r.container;
}

beforeEach(() => {
  saveMemory("");
  setSetting(MEMORY_WRITE_APPROVAL_KEY, JSON.stringify({ platform: true, project: true, conversation: false }));
  setStoragePort(createFakeStoragePort({ seed: { settings: [{ key: "noop", value: "" }] } }));
  vi.spyOn(memoryModule, "getMemoryService").mockReturnValue(seedPending(COUNT));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("MPS-231 待批准列表必须能滚（用户实报：11 条只看得到 7 条）", () => {
  it("MPS-231-1 ★结构：section 可压缩 + list 是唯一滚动区 + head 不参与收缩", () => {
    const section = declarations(ruleBody(STYLES, ".memory-pending-section"));
    expect(section["display"], "section 必须是 flex 列（否则高度无法分配给内部滚动区）").toBe("flex");
    expect(section["flex-direction"], "section 必须是纵向 flex").toBe("column");
    expect(
      section["min-height"],
      "section 缺 min-height: 0 —— flex 子项的默认 min-height:auto 会让它宁可溢出也不缩，" +
        "这正是用户看到「第 8 条被裁掉」的机制",
    ).toBe("0");
    const maxH = section["max-height"] ?? "";
    expect(maxH, "section 必须有高度上限（否则它会把下面的内容全挤走）").toMatch(/^\d+(\.\d+)?%$/);
    const pct = Number(maxH.replace("%", ""));
    expect(pct, `上限 ${pct}% 太大：待批准区不该占掉大半个面板`).toBeLessThanOrEqual(60);
    expect(section["overflow"], "section 自己裁住溢出（滚动交给内部 list）").toBe("hidden");
    /*
     * 到了上限就**不再让位**：真机量过三种写法（VP 1200×700、12 条 pending）——
     * `flex: 0 1 auto` 会被继续压到 246px（列表只剩 104px，约 3 条可见），
     * `flex: 0 0 auto` 稳在上限 307px（列表 164px，4 条可见）。让位让掉的是用户的决策效率。
     */
    expect(section["flex"], "section 到了 max-height 就不许再被压缩（flex 0 0 auto）").toBe("0 0 auto");

    const list = declarations(ruleBody(STYLES, ".memory-pending-list"));
    expect(list["overflow-y"], "★滚动区缺 overflow-y: auto —— 这就是缺陷本身").toBe("auto");
    expect(list["min-height"], "滚动区缺 min-height: 0，则它撑不成可滚（flex 子项的默认行为）").toBe("0");
    expect(list["flex"], "滚动区必须吃满 section 剩下的高度").toBe("1 1 auto");
    expect(list["overscroll-behavior"], "滚到头不许把滚动传给外层").toBe("contain");

    const head = declarations(ruleBody(STYLES, ".memory-pending-head"));
    expect(head["flex"], "不滚的头部必须 flex: none（否则它会被列表挤掉，读数/批量栏就看不见了）").toBe("none");
  });

  it("MPS-231-2 ★12 条全部落在滚动区里；顶部提示与批量栏在滚动区**之外**", async () => {
    const container = await renderPanel();
    const list = container.querySelector(".memory-pending-list");
    expect(list, "必须有 .memory-pending-list（唯一滚动区）").toBeTruthy();
    const head = container.querySelector(".memory-pending-head");
    expect(head, "必须有 .memory-pending-head（不滚的那一半）").toBeTruthy();

    const items = Array.from(list!.querySelectorAll(".memory-pending-item"));
    expect(items.length, `渲染出来的待批准条目数应当是 ${COUNT}（一条都不许被丢掉）`).toBe(COUNT);
    /*
     * ⚠️ 别按"最后渲染的那条 = 第 12 条"来断言：`listPending` 按 `timestamp` 倒序，
     * 而 12 条夹具是在同一个毫秒里写进去的（`Date.now()` 的精度），并列时顺序不稳定
     * —— 本仓 `memory-pending-batch.test.tsx` 已经为这个坑写过一次注释。
     * 所以这里只断"12 条都在、且是 12 个**不同**的条目"（顺序无关），
     * "能不能滚到末尾"由真机几何判据（`.preview-shot/_mem231-probe.mjs`）负责。
     */
    const keys = items.map((el) => el.querySelector(".memory-pending-key")?.textContent ?? "");
    expect(new Set(keys).size, "12 条应当是 12 个不同的条目（不许被去重/覆盖成更少）").toBe(COUNT);
    expect(
      keys.slice().sort(),
      "12 条（一个不少）都必须在滚动区里",
    ).toEqual(Array.from({ length: COUNT }, (_, i) => `待审事实 ${i + 1}`).sort());

    /* 顶部三块（标题读数 / 勾选+批量 / 本批+一键全部）在 head 里，不在滚动区里 ⇒ 滚列表时它们不走 */
    for (const sel of [".memory-pending-title", ".memory-pending-batch-bar", ".memory-pending-all-bar"]) {
      const el = container.querySelector(sel);
      expect(el, "缺少 " + sel).toBeTruthy();
      expect(list!.contains(el), sel + " 不许在滚动区里（它要在滚动后仍在原位）").toBe(false);
      expect(head!.contains(el), sel + " 必须在 head 里").toBe(true);
    }
    /* 条目一行也不许跑到 head 里（否则它就不随列表滚了） */
    expect(head!.querySelector(".memory-pending-item"), "条目不许出现在 head 里").toBeNull();
  });

  it("MPS-231-3 展开一条之后，展开块仍在滚动区里（不让'看清一条'把后面的挤没）", async () => {
    const container = await renderPanel();
    const list = container.querySelector(".memory-pending-list")!;
    const first = list.querySelector(".memory-pending-item")!;
    act(() => {
      fireEvent.doubleClick(first);
    });
    const detail = list.querySelector(".memory-pending-detail, .memory-pending-expanded, .memory-detail");
    expect(detail, "双击后应当出现展开块").toBeTruthy();
    expect(detail!.closest(".memory-pending-list"), "展开块必须在滚动区内部（这样它只撑大 scrollHeight）").toBe(list);
  });

  it("MPS-231-4 收尾没有动语义：读数 / 勾选框 / 批量 / 一键全部 / 单条批准拒绝 / 关闭都在", async () => {
    const container = await renderPanel();
    expect(container.querySelector(".memory-pending-title")!.textContent).toContain(`${COUNT} 条`);
    expect(container.querySelectorAll(".memory-pending-item input[type=checkbox]").length).toBe(COUNT);
    expect(container.querySelector(".memory-pending-check-all input[type=checkbox]"), "缺「全选」").toBeTruthy();
    const text = (container.textContent ?? "");
    expect(text).toContain("批量同意（");
    expect(text).toContain("批量拒绝（");
    expect(text).toContain(`全部批准（${COUNT}）`);
    expect(text).toContain(`全部拒绝（${COUNT}）`);
    expect(text).toContain("批准");
    expect(text).toContain("拒绝");
    expect(container.querySelector(".memory-manager-close"), "缺关闭按钮").toBeTruthy();
  });
});
