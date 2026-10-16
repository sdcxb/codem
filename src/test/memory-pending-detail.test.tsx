/**
 * 第 226 波（用户直报）：
 *
 * > 记忆系统中，审批的时候，看不到详细信息无法评估审批是否通过，增加个双击展开详细信息的功能。
 *
 * ## 缺陷是什么（先说清，否则判据会被写成"测实现"）
 *
 * 待批准区每一行原来只渲染 `entry.content.substring(0, 80)` —— 而"该不该批准"要同时看
 * **完整内容** + **作用域/生效范围** + **归属** + **来源**（自动提取的条目可信度不同）。
 * 光看前 80 字只能猜：自动提取的长条目里，前 80 字常常只是铺垫，"这条到底在说什么、
 * 批准之后会在哪生效"都读不出来 ⇒ 用户只能盲批或盲拒。
 *
 * ## 这一族判据守什么（都是"用户会直接撞上"的形态）
 *
 * - **摘要照旧**：折叠时仍是 80 字摘要（不许反过来把全文铺在列表里 —— 那会让待批准区
 *   变成一面墙，"逐条处置"直接不可用）；
 * - **展开即全文**：详情块里的内容必须**一字不少**（再截断一次就等于功能没做）；
 * - **判断依据齐**：完整内容 / 键 / 作用域与生效范围 / 归属 / 来源 / 状态 / 批次 / 时间；
 * - **只影响被双击的那一条**（列表里点开一条，别的条目不许跟着展开）；
 * - **控件区不受影响**：双击落在勾选框/批准/拒绝上时不许顺手展开这一行；
 * - **手势要被写出来**：双击没有可点的外观，界面上必须有一句常驻提示；
 * - **展开状态跟着待批准列表收敛**（"幽灵展开"与既有的"幽灵选中"同理）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent, act } from "@testing-library/react";
import { createElement } from "react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { setStoragePort } from "../core/storage/port";
import { createFakeStoragePort, type FakeStoragePort } from "./fake-storage-port";
import { saveMemory, setSetting } from "../core/storage/settings";
import { MemoryService, MEMORY_WRITE_APPROVAL_KEY, MEMORY_SOURCE_KIND_LABEL } from "../core/memory/memory";
import * as memoryModule from "../core/memory/memory";
import { MemoryManager } from "../components/MemoryManager";

const PROJ = "proj-226";
const SESSION = "sess-226";

/** 长内容：前 80 字是"铺垫"，关键信息在**结尾**（这正是用户看不到的那部分） */
const PREFIX = "这是一条很长的自动提取记忆，开头几句只是铺垫，真正的结论在后面。";
const TAIL = "【全文结尾标记：结论在这里】";
const LONG_CONTENT = PREFIX + "补充说明".repeat(20) + TAIL;

const SHORT_CONTENT = "短条目：这句话本身就完整。";

let port: FakeStoragePort;
let svc: MemoryService;

function seed(): MemoryService {
  const service = new MemoryService();
  service.add({
    scope: "project",
    projectId: PROJ,
    key: "长条目",
    content: LONG_CONTENT,
    source: "auto",
    status: "pending",
    batchId: "batch-226",
    tags: ["架构", "约定"],
  });
  service.add({
    scope: "conversation",
    sessionId: SESSION,
    key: "短条目",
    content: SHORT_CONTENT,
    source: "auto",
    status: "pending",
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

/** 按**键名**取某一行的 DOM（不按下标：并列时间戳时排序不稳定，本仓踩过） */
function rowForOrNull(container: HTMLElement, key: string): HTMLElement | null {
  const keyEl = Array.from(container.querySelectorAll(".memory-pending-key")).find(
    (el) => (el.textContent ?? "") === key,
  );
  return (keyEl?.closest(".memory-pending-item") as HTMLElement | null) ?? null;
}

function rowFor(container: HTMLElement, key: string): HTMLElement {
  const row = rowForOrNull(container, key);
  expect(row, `必须有「${key}」那一行（前提）`).toBeTruthy();
  return row as HTMLElement;
}

function detailOf(container: HTMLElement, key: string): HTMLElement | null {
  return rowForOrNull(container, key)?.querySelector<HTMLElement>(".memory-pending-detail") ?? null;
}

function summaryOf(container: HTMLElement, key: string): string {
  return rowFor(container, key).querySelector(".memory-pending-content")?.textContent ?? "";
}

function expand(container: HTMLElement, key: string): void {
  act(() => {
    // 双击落在**摘要**上（真实的用户手势就是点这一行看全文）
    fireEvent.doubleClick(rowFor(container, key).querySelector(".memory-pending-content")!);
  });
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

describe("MEM-APPROVE-DETAIL：待批准区双击展开详细信息（第 226 波）", () => {
  it("MD-1（反向对照）：折叠时仍是 80 字摘要 —— 关键信息（结尾）不在 DOM 里，也不该有详情块", async () => {
    const container = await renderPanel();
    expect(summaryOf(container, "长条目"), "前提：摘要取的是前 80 字").toHaveLength(80);
    expect(summaryOf(container, "长条目"), "摘要里看不到结尾结论（这正是用户判断不了的原因）").not.toContain(TAIL);
    expect(container.textContent, "折叠状态下列表里不许出现全文（否则待批准区会变成一面墙）").not.toContain(TAIL);
    expect(container.querySelectorAll(".memory-pending-detail"), "没双击 ⇒ 一个详情块都不该有").toHaveLength(0);
  });

  it("MD-2：双击 ⇒ 展开详情块，完整内容**一字不少**，且八项判断依据齐备", async () => {
    const container = await renderPanel();
    expand(container, "长条目");

    const detail = detailOf(container, "长条目");
    expect(detail, "双击之后必须出现详情块").toBeTruthy();
    expect(
      detail!.querySelector(".memory-detail-content")?.textContent,
      "详情块里的内容必须与人库的那份逐字一致（再截断一次 = 功能没做）",
    ).toBe(LONG_CONTENT);
    expect(detail!.textContent, "结尾结论必须看得到").toContain(TAIL);

    const text = detail!.textContent ?? "";
    for (const label of [
      "完整内容", // 这条记忆在说什么
      "键",
      "作用域与生效范围", // 批准后在哪生效
      "归属",
      "来源",
      "状态", // 会不会进上下文
      "批次",
      MemoryService.PANEL_TIMESTAMP_LABEL, // 最后修改时间
      "标签",
    ]) {
      expect(text, `判断依据缺了「${label}」，用户就还是判断不了`).toContain(label);
    }
    expect(text, "作用域口径要来自唯一那份表（项目级）").toContain("项目级");
    expect(text, "要写明批准后对这个项目以后的每个对话生效").toContain("这个项目以后的每个对话");
    expect(text, "归属要能看出就是当前项目（用户最常问的就是这句）").toContain("就是当前项目");
    expect(text, "来源要说清是自动提取的（可信度不同）").toContain(MEMORY_SOURCE_KIND_LABEL.auto);
    expect(text, "状态要如实说未进上下文").toContain("待批准（未进上下文）");
    expect(text, "批次要能核对（可整批撤销）").toContain("batch-226");
    expect(text, "标签要显示").toContain("架构");
  });

  it("MD-3：再双击一次 ⇒ 收起（回到摘要态）", async () => {
    const container = await renderPanel();
    expand(container, "长条目");
    expect(detailOf(container, "长条目")).toBeTruthy();

    act(() => {
      fireEvent.doubleClick(rowFor(container, "长条目").querySelector(".memory-pending-content")!);
    });
    expect(detailOf(container, "长条目"), "再双击必须收起").toBeNull();
    expect(container.textContent, "收起后全文不该再留在 DOM 里").not.toContain(TAIL);
  });

  it("MD-4：展开只影响被双击的那一条（别的条目保持折叠）", async () => {
    const container = await renderPanel();
    expand(container, "长条目");
    expect(detailOf(container, "长条目")).toBeTruthy();
    expect(detailOf(container, "短条目"), "没被双击的条目不许跟着展开").toBeNull();

    expand(container, "短条目");
    expect(detailOf(container, "长条目"), "展开第二条不许把第一条收起来").toBeTruthy();
    expect(detailOf(container, "短条目")).toBeTruthy();
    expect(container.querySelectorAll(".memory-pending-detail")).toHaveLength(2);
  });

  it("MD-5（反向对照）：双击落在勾选框上不许展开这一行（控件区的行为原样保留）", async () => {
    const container = await renderPanel();
    const check = rowFor(container, "长条目").querySelector<HTMLInputElement>("input[type=checkbox]")!;

    /*
     * ★ 第 229 波：面板现在**默认勾选本批**（用户要求"面板少动手"），于是"一进面板就是未勾选"
     * 这个前提不再成立 —— 无条件点一下会把它**取消**掉，下面的前提断言当场红。
     * 这条判据要守的没变（"勾选框上的双击不许展开这一行"），只是需要一个**已知的已勾选状态**：
     * 所以写成"没勾上才去勾"（对"有默认勾选"和"没有默认勾选"两种实现都成立，不会变成哑巴）。
     */
    if (!check.checked) {
      act(() => {
        fireEvent.click(check);
      });
    }
    expect(check.checked, "前提：这一条已被勾选").toBe(true);

    act(() => {
      fireEvent.doubleClick(check);
    });
    expect(detailOf(container, "长条目"), "勾选框上的双击不是「展开详情」这个手势").toBeNull();
    expect(check.checked, "勾选状态不许被这个手势改动").toBe(true);
    expect(container.textContent, "也不许因此把全文渲染出来").not.toContain(TAIL);
  });

  /**
   * MD-6：收敛的**两个方向**都要挡住。
   *
   * 「幽灵展开」（处置完的 id 还留在集合里）在本仓**无法从 DOM 直接观察** ——
   * 那个 id 已经不在列表里了，除非同一 id 再次出现（导入 JSON / 撤销批次那条路，
   * 见 `undoBatch` 是**删除**语义、不做恢复），否则状态藏在 React 里。
   * 所以那条能力由 MD-8 的**接线棘轮**守（与第 196 波把「幽灵选中」写成
   * MB-UI-2 + MUT-9 的做法一致：一条能力、两处接线，判据断言的是接线本身）。
   *
   * 这里守的是**反方向**——收敛不许"过头"：一有列表变化就把展开全清掉，
   * 用户展开一条、处置另一条，自己刚看的那条就自己收起来了（真机上是"我刚点开就被合上"）。
   */
  it("MD-6：处置之后收敛不许过头 —— 仍待批准的那条**保持展开**，新来的条目默认折叠", async () => {
    const container = await renderPanel();
    expand(container, "长条目");
    expand(container, "短条目");
    /* 先塞一条新的待批准：下面点「批准」会触发 loadEntries，于是它会一起被读进来 */
    svc.add({
      scope: "project",
      projectId: PROJ,
      key: "后到条目",
      content: "后到的待批准记忆内容（用来验证它不会继承别人的展开状态）",
      source: "auto",
      status: "pending",
    });

    await act(async () => {
      fireEvent.click(
        Array.from(rowFor(container, "长条目").querySelectorAll("button")).find(
          (b) => (b.textContent ?? "") === "批准",
        )!,
      );
    });

    expect(detailOf(container, "长条目"), "被批准的那条已经离开待批准区").toBeNull();
    expect(rowForOrNull(container, "长条目"), "被批准的那条整行都不该还在").toBeNull();
    expect(detailOf(container, "短条目"), "列表一变就把展开全清掉 = 用户刚点开就被合上（收敛不许过头）").toBeTruthy();
    expect(detailOf(container, "后到条目"), "新出现的待批准条目必须是折叠的（不许继承别人的展开态）").toBeNull();
  });
});

describe("MEM-APPROVE-DETAIL：接线与可发现性（第 226 波结构棘轮）", () => {
  const src = readFileSync(path.resolve(__dirname, "../components/MemoryManager.tsx"), "utf8");

  it("MD-7：界面必须**写出**这个手势（双击没有可点的外观，不写出来用户永远不知道）", async () => {
    const container = await renderPanel();
    const hint = container.querySelector(".memory-pending-expand-hint")?.textContent ?? "";
    expect(hint, "待批准区要有常驻提示").toContain("双击");
    expect(hint, "并说清展开能看到什么").toContain("完整内容");
  });

  it("MD-8：接线棘轮 —— 双击切换展开、控件区排除、展开集合走同一条收敛能力", () => {
    expect(src, "行上要挂双击").toContain("onDoubleClick=");
    expect(src, "双击要真的切换展开状态").toMatch(/onDoubleClick=\{[\s\S]{0,240}?togglePendingExpanded\(entry\.id\)/);
    expect(
      src,
      "点在控件上（勾选框/批准/拒绝）时不许展开 —— 那时这一行多半已经要被处置了",
    ).toMatch(/closest\("button, input, label, select, a"\)/);
    expect(src, "展开块要独占一行（否则长文本会把批准/拒绝按钮挤出去）").toContain("memory-pending-detail");
    /*
     * 幽灵展开这条能力：**勾选集合与展开集合共用同一个 `pruneAliveIds`**。
     * 断言"两个 setter 都走它"，而不是"某段具体代码长什么样" ——
     * 这样将来重构实现（换名字、换写法）不会假红，而"把收敛拆掉/只留一处"必然红。
     */
    expect(src, "勾选集合要随待批准列表收敛（第 196 波就有的那条能力）").toMatch(
      /setSelectedPending\(\(prev\) => pruneAliveIds\(prev, pending\)\)/,
    );
    expect(
      src,
      "展开集合也必须走同一条能力（自己再写一份 = 修一处漏一处，幽灵展开就是这么来的）",
    ).toMatch(/setExpandedPending\(\(prev\) => pruneAliveIds\(prev, pending\)\)/);
    /* 判断口径不许在展开块里被硬编码第二份：状态那句话必须走同一处 helper */
    expect(src, "状态文案要收敛到 entryStatusText（详情面板与展开块同一句）").toMatch(
      /const renderPendingDetail[\s\S]{0,2000}?entryStatusText\(entry/,
    );
    const statusCalls = src.match(/entryStatusText\(/g) ?? [];
    expect(statusCalls.length, "两处渲染都要用它（自己再写一份三元表达式就是两套说法）").toBeGreaterThanOrEqual(3);
  });

  /**
   * ★ 第 228 波审计新增：**单条动作也要看落库结果**。
   *
   * 被守的缺陷：面板的单条删除/批准/拒绝只改内存 + 刷新列表，而 `save()` 的返回值语义是
   * "本次写入已被接受"，**不等于已落库**（它自己的注释就这么写）⇒ 落库失败时用户在列表里看到
   * 条目已经消失、**该动作零回执**，重启后条目又回来。同仓的编辑/新建/导入/体检批量都等
   * `flushPendingPersist()` 并如实回执（口径不一致）。
   */
  it("MD-9：面板单条动作要等确认落库并如实回执（落库失败不许显示成「已经删掉了」）", async () => {
    /* 落库失败：`memory.set` 一直失败 ⇒ 面板必须说"未落库"而不是静默 */
    const failing = createFakeStoragePort({
      seed: { settings: [{ key: "noop", value: "" }] },
      failCommands: ["memory.set"],
    });
    setStoragePort(failing);
    const service = new MemoryService();
    service.add({ scope: "project", projectId: PROJ, key: "要删的条目", content: "内容", source: "manual" });

    const container = render(
      createElement(MemoryManager, { onClose: () => {}, projectId: PROJ, sessionId: SESSION } as never),
    ).container;
    await act(async () => {
      await Promise.resolve();
    });

    /* `.memory-delete-btn` 只在"详情面板里选中了某一条"时出现 ⇒ 先点开一条 */
    const firstRow = container.querySelector(".memory-item") as HTMLElement | null;
    if (firstRow) {
      await act(async () => {
        fireEvent.click(firstRow);
        await Promise.resolve();
      });
    }
    const delBtn = container.querySelector(".memory-delete-btn");
    expect(delBtn, "前提：详情面板里有一个删除按钮（只对已选中的那一条出现）").toBeTruthy();
    await act(async () => {
      fireEvent.click(delBtn as HTMLElement);
      await Promise.resolve();
    });

    /* ★ 用 waitFor 而不是固定 sleep：落库失败链里有**重试退避**，固定等待会偶发假红 */
    const { waitFor } = await import("@testing-library/react");
    await waitFor(
      () => {
        const notice = container.querySelector(".memory-notice")?.textContent ?? "";
        expect(notice, "动作回执必须写出「未落库」（否则用户以为删掉了，重启后又回来）").toContain("未落库");
      },
      { timeout: 5000 },
    );
  });
});
