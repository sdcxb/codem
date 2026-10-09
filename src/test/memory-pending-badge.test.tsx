/**
 * `MEM-BADGE-1/2/3`：外壳级「待批准记忆」角标（GAP-LIST `O-45` / `S4`）。
 *
 * ## 被守的缺陷
 *
 * 默认审批开启时，自动提取的记忆先进待批准区、**不进上下文**（设计如此）。
 * 在 O-45 之前，「有一批待批准正等着」**只在用户主动打开记忆面板**时才看得见
 * （面板里的 `.memory-pending-hint` 与顶部「待批准」那一格）—— 而记忆面板是个模态框，
 * 离开它就看不见。于是默认配置下的用户会以为自动记忆不好使（这正是 S4 当初要治的病）。
 *
 * ## 怎么断言「外壳真的在说这件事」
 *
 * **不 mock 组件、不读 props**：真渲染 `Sidebar`（角标在里面自己从 store 推作用域、
 * 自己调 `getStats`），再真渲染 `MemoryManager`，然后比对**两块 DOM** 上的数字：
 *
 * - 角标：`.memory-pending-badge` 的文本；
 * - 面板：顶部「待批准」那一格 `（.memory-stat 里 label=待批准 的 .memory-stat-value）`。
 *
 * 两者若是各自算一份，数字就会分叉 —— 判据断开的是这个，不是"有没有传对 prop"。
 *
 * ## 三条判据与各自的反向对照
 *
 * - `MEM-BADGE-1`：有 pending ⇒ 角标出现，且数字 **等于**面板那个数；并且
 *   **只算当前位置的**（项目 B 的待批准不许混进来）。
 * - `MEM-BADGE-1b`（防"只读一次的静态值"）：**在挂载之后**往服务里再加一条 pending
 *   ⇒ 角标必须自己往前走（证明它挂在 `codem-memory-changed` 上，不是一个算完就冻住的数）。
 * - `MEM-BADGE-2`：把 pending 清空 ⇒ 角标**消失**；反向对照是同一条用例里先断言它**在**
 *   —— 防「加了个永远亮着的点」。
 * - `MEM-BADGE-3`：点角标本身要能到记忆面板（角标是装饰 `aria-hidden`，但必须落在入口按钮里）；
 *   反向对照是"点之前面板不在"。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent, act } from "@testing-library/react";
import { createElement, useState } from "react";
import { setStoragePort } from "../core/storage/port";
import { createFakeStoragePort } from "./fake-storage-port";
import { MemoryService, projectIdFromCwd, MEMORY_PRE_MIGRATION_KEY, MEMORY_UNKNOWN_OWNER_TITLE, MEMORY_UNKNOWN_SCOPE_TITLE } from "../core/memory/memory";
import * as memoryModule from "../core/memory/memory";
import { setSetting } from "../core/storage/settings";
import { memoryPanelScope } from "../core/memory/panel-scope";
import { useProjectStore } from "../core/store";
import { Sidebar } from "../components/Sidebar";
import { MemoryManager } from "../components/MemoryManager";
import type { Project, Session } from "../core/types";

const PROJECT_A: Project = { id: "proj-a", name: "阿尔法项目", path: "C:\\work\\alpha", createdAt: 1, lastAccessedAt: 1 };
const PROJECT_B: Project = { id: "proj-b", name: "贝塔项目", path: "C:\\work\\beta", createdAt: 1, lastAccessedAt: 1 };
/** 条目里存的是**归一化后的工作目录**（`projectIdFromCwd`），不是 `Project.id` */
const PROJ_A_ID = projectIdFromCwd(PROJECT_A.path)!;
const PROJ_B_ID = projectIdFromCwd(PROJECT_B.path)!;

const SESSION_A: Session = { id: "sess-a", projectId: PROJECT_A.id, title: "对话一（重构）", createdAt: 1, lastMessageAt: 1, messageCount: 0 };
const SESSION_B: Session = { id: "sess-b", projectId: PROJECT_B.id, title: "对话二（发布）", createdAt: 1, lastMessageAt: 1, messageCount: 0 };

/**
 * 五条**待批准**记忆：
 * - 平台级 1 条（处处可见 ⇒ 是"角标读法本身通不通"的恒真对照）；
 * - 项目 A 2 条 + 项目 B 1 条 ⇒ 当前在 A 时角标必须是 **3**（1+2），不是 4。
 *
 * 另有 1 条**已生效**的手动条目：它不该被算进「待批准」（防"把总数当待批准数"）。
 */
function makeService(): MemoryService {
  const svc = new MemoryService();
  const pending = (scope: "platform" | "project", key: string, projectId?: string) =>
    svc.add({ scope, projectId, key, content: `${key} 的内容足够长以便入库`, source: "auto", status: "pending" });
  pending("platform", "平台待批准");
  pending("project", "项目A待批准一", PROJ_A_ID);
  pending("project", "项目A待批准二", PROJ_A_ID);
  pending("project", "项目B待批准", PROJ_B_ID);
  svc.add({ scope: "project", projectId: PROJ_A_ID, key: "已生效的手动条目", content: "这条不是待批准状态", source: "manual" });
  return svc;
}

function seedStore(current: "A" | "B") {
  useProjectStore.setState({
    projects: [PROJECT_A, PROJECT_B],
    sessions: [SESSION_A, SESSION_B],
    currentProject: current === "A" ? PROJECT_A : PROJECT_B,
    currentSession: current === "A" ? SESSION_A : SESSION_B,
  } as never);
}

/** 与 `App.tsx` 同形：`Sidebar.onMemory` ⇒ 挂出记忆面板，作用域走 `memoryPanelScope()` */
function Shell({ projectPath, sessionId }: { projectPath: string; sessionId: string }) {
  const [show, setShow] = useState(false);
  const scope = memoryPanelScope(projectPath, sessionId);
  return createElement(
    "div",
    null,
    createElement(Sidebar, { identity: null, onMemory: () => setShow(true) } as never),
    show ? createElement(MemoryManager, { onClose: () => setShow(false), projectId: scope.projectId, sessionId: scope.sessionId }) : null,
  );
}

/** 角标数字（读**文本**；不在时返回 `null`，所以"消失"是可断言的） */
function badgeText(container: HTMLElement): string | null {
  const el = container.querySelector(".memory-pending-badge");
  return el ? (el.textContent ?? "") : null;
}

/** 面板顶部「待批准」那一格的数字（按**文案**找格子，不按下标） */
function panelPending(container: HTMLElement): string | null {
  for (const stat of Array.from(container.querySelectorAll(".memory-stat"))) {
    if (stat.querySelector(".memory-stat-label")?.textContent === "待批准") {
      return stat.querySelector(".memory-stat-value")?.textContent ?? null;
    }
  }
  return null;
}

function renderShell(current: "A" | "B") {
  seedStore(current);
  const projectPath = current === "A" ? PROJECT_A.path : PROJECT_B.path;
  const sessionId = current === "A" ? SESSION_A.id : SESSION_B.id;
  const { container } = render(createElement(Shell, { projectPath, sessionId }));
  return container;
}

let svc: MemoryService;
let spy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  setStoragePort(createFakeStoragePort());
  svc = makeService();
  spy = vi.spyOn(memoryModule, "getMemoryService").mockReturnValue(svc);
});

afterEach(() => {
  spy.mockRestore();
  cleanup();
  useProjectStore.setState({ projects: [], sessions: [], currentProject: null, currentSession: null } as never);
  setStoragePort(null);
});

describe("MEM-BADGE：自动记忆的「待批准」必须在外壳上看得见（离开面板也看得见）", () => {
  it("MEM-BADGE-1：有 pending ⇒ 角标出现，数字 = 面板那个数（且只算当前位置的）", async () => {
    const container = await act(async () => renderShell("A"));

    // 恒真对照：平台级那条在 A 里也可见 ⇒ 角标至少要有 1；若连它都没有，说明读法本身没通
    expect(badgeText(container), "有 3 条待批准（平台 1 + 项目 A 2）时角标必须出现").toBe("3");
    expect(container.querySelector(".memory-pending-badge"), "角标必须落在侧栏「记忆」入口上").toBeTruthy();

    // 面板那一侧（同一份 store 夹具、同一条 `memoryPanelScope`）—— 两边数字必须相等
    await act(async () => {
      fireEvent.click(container.querySelector(".memory-pending-badge")!);
    });
    expect(panelPending(container), "面板「待批准」那一格必须与角标是同一个数").toBe(badgeText(container));
    expect(panelPending(container), "3 = 平台 1 + 项目 A 2；若为 4 说明把项目 B 的待批准也算进来了").toBe("3");
  });

  it("MEM-BADGE-1 反向对照（另一个项目）：切到项目 B ⇒ 数字跟着作用域走（1 平台 + 1 项目B = 2）", async () => {
    const container = await act(async () => renderShell("B"));
    expect(badgeText(container), "项目 B 里应是 1 平台 + 1 项目B = 2（不是 3 —— 判据跟着当前作用域走）").toBe("2");
  });

  it("MEM-BADGE-1b：挂载之后再写入一条 pending ⇒ 角标自己往前走（不是算完就冻住的数）", async () => {
    const container = await act(async () => renderShell("A"));
    expect(badgeText(container)).toBe("3");

    // 侧栏不重新挂载：只有"记忆域变了"这件事发生
    await act(async () => {
      svc.add({ scope: "project", projectId: PROJ_A_ID, key: "新提取的待批准", content: "挂载之后才出现的一条", source: "auto", status: "pending" });
    });
    expect(badgeText(container), "新写入一条 pending 之后角标必须变成 4（否则它只是个初始值）").toBe("4");
  });

  it("MEM-BADGE-1c：面板里**三处**「待批准」必须是同一个数（含「无归属」条目）", async () => {
    /*
     * 现场（第 192 波取证）：面板同时有**两个**不同的待批准数 ——
     * 顶部那一格走 `getStats`（`listAll`，`includeUnscoped: true`），
     * 而提示条与「待批准的自动记忆（N 条）」走 `listPending`（过去用**裸 ctx**，
     * 无归属条目被 `visibleIn` 挡掉）⇒ 实测 **1 vs 0**，而且那一条在界面上**根本不出现**：
     * 用户既看不到也批不了，却一直占着「待批准」的位置。
     *
     * 这条判据把三处数字钉成同一个（角标是第四处，它必须等于前三处）。
     */
    // 换一个**干净**的数据面：`new MemoryService()` 会从端口读回上一段夹具写下的域内容
    setStoragePort(createFakeStoragePort());
    const withUnscoped = new MemoryService();
    withUnscoped.add({ scope: "platform", key: "平台待批准", content: "平台级待批准内容", source: "auto", status: "pending" });
    withUnscoped.add({ scope: "project", projectId: PROJ_A_ID, key: "项目A待批准", content: "项目 A 待批准内容", source: "auto", status: "pending" });
    // **无归属**：迁移后的旧 session 记忆形态（`project` 但没有 `projectId`）
    withUnscoped.add({ scope: "project", key: "无归属待批准", content: "没有归属键的待批准内容", source: "auto", status: "pending" });
    spy.mockReturnValue(withUnscoped);

    const container = await act(async () => renderShell("A"));
    await act(async () => {
      fireEvent.click(container.querySelector(".memory-pending-badge")!);
    });

    const stat = panelPending(container);
    const hint = /有 (\d+) 条自动记忆等待批准/.exec(container.textContent ?? "")?.[1] ?? null;
    const sectionTitle = /待批准的自动记忆（(\d+) 条/.exec(container.textContent ?? "")?.[1] ?? null;

    expect(stat, "顶部统计格必须算上无归属的那条（1 平台 + 1 项目A + 1 无归属 = 3）").toBe("3");
    expect(hint, "提示条的条数必须与顶部那一格**同一个数**").toBe(stat);
    expect(sectionTitle, "「待批准的自动记忆（N 条）」必须与顶部那一格**同一个数**").toBe(stat);
    expect(badgeText(container), "外壳角标必须是同一个数").toBe(stat);
    // 反向对照：无归属那条必须**真的出现**在待批准区里（否则用户既看不到也批不了）
    expect(container.textContent, "无归属的待批准条目必须出现在界面上（它一直占着位置）").toContain("无归属待批准");
  });

  it("MEM-REVERT-1：快照回退之后，角标必须**立刻**跟着变（不许等用户去打开面板）", async () => {
    /*
     * 真机现场（1.16.303，钻取实例）：点了体检里的「回退到迁移前」之后，体检自己已经是
     * `待批准 0`，而**侧栏角标还停在 `9`** —— 直到打开记忆面板（面板挂载时才 `reload()`）才跟着变。
     * 根因：`restorePreMigrationSnapshot()` 是**绕过 `save()/load()` 直接写库 + 直接改内存态**的，
     * 因此没人发「记忆域变了」这条通知。
     */
    setStoragePort(createFakeStoragePort());
    const reverted = { scope: "project", key: "回退后的待批准", content: "回退前快照里的内容足够长", source: "auto", status: "pending" };
    // 迁移前快照：**裸映射**（存量真实形状）——回退要认它，且里面那条是待批准。
    // 快照在设置里的形状是 `{takenAt, entries, raw}`（`getPreMigrationSnapshot` 的唯一口径）
    setSetting(
      MEMORY_PRE_MIGRATION_KEY,
      JSON.stringify({
        takenAt: 1,
        entries: 1,
        raw: JSON.stringify({ "mem-reverted-1": { ...reverted, id: "mem-reverted-1", timestamp: 1 } }),
      }),
    );
    const restoredSvc = new MemoryService();
    spy.mockReturnValue(restoredSvc);
    expect(restoredSvc.getStats({ projectId: PROJ_A_ID, sessionId: SESSION_A.id }).pendingEntries, "前置：回退前是干净的").toBe(0);

    const container = await act(async () => renderShell("A"));
    expect(badgeText(container), "前置：回退前没有角标").toBeNull();

    await act(async () => {
      const r = await restoredSvc.restorePreMigrationSnapshot();
      expect(r.ok, "快照回退必须成功（否则下面测的不是回退那条路）").toBe(true);
    });

    expect(badgeText(container), "回退之后角标必须立刻出现（不许等用户打开面板才刷新）").toBe("1");
  });

  it("MEM-REVERT-2：回退提示里点名的组，必须是体检**真的会产出**的那个组标题", async () => {
    /*
     * 真机现场：回退后 21 条落进了「归属未知（旧数据）」组，而提示文案写的是「作用域无法识别」——
     * 指错了组（那个组只装"作用域根本不是三者之一"的条目）。两处现在共用 `memory.ts` 的一对常量，
     * 这条判据把"提示点名的组 == 体检会产出的组标题"钉住。
     */
    setStoragePort(createFakeStoragePort());
    setSetting(
      MEMORY_PRE_MIGRATION_KEY,
      JSON.stringify({
        takenAt: 1,
        entries: 1,
        raw: JSON.stringify({ "mem-reverted-2": { id: "mem-reverted-2", scope: "conversation", key: "无归属的旧对话记忆", content: "旧 session 记忆：没有 sessionId ⇒ 归属说不清", source: "auto", timestamp: 1 } }),
      }),
    );
    const svc2 = new MemoryService();
    const r = await svc2.restorePreMigrationSnapshot();
    expect(r.ok).toBe(true);

    expect(r.message, "提示必须点名「归属未知（旧数据）」组（真机回退后条目就落在那里）").toContain(MEMORY_UNKNOWN_OWNER_TITLE);
    expect(r.message, "提示也要点名「作用域无法识别」组（另一类旧数据会落在那里）").toContain(MEMORY_UNKNOWN_SCOPE_TITLE);

    /*
     * ⚠️ 如实留白：这里**没有**再断言"体检确实会产出这两个组标题"。
     * 试过两种夹具（`project` 无归属键 / `conversation` 无 sessionId），在**裸夹具**下它们都落进
     * 「归属已失效（目标项目/对话不存在）」，而真机（5 个项目在场、21 条旧数据）落进「归属未知（旧数据）」——
     * 这一差异**本轮没查清**（它与体检的归属解析索引有关），所以那半只由**真机读数**背书
     * （见 GAP-LIST 的 C-68 与交接「第 192 波」的真机一节），不在这里假装钉住。
     *
     * 真正被这条判据钉住的是：**回退提示点名的组名必须来自与体检同一对常量**
     * （`MEMORY_UNKNOWN_OWNER_TITLE` / `MEMORY_UNKNOWN_SCOPE_TITLE`）—— 真机现场它曾经只写「作用域无法识别」，
     * 而条目实际落在「归属未知（旧数据）」，等于指错组。
     */
    expect(r.message, "提示不许再写成「只有作用域无法识别一个组」的旧口径").toMatch(/「归属未知（旧数据）」\/「作用域无法识别」/);
  });

  it("MEM-BADGE-2：pending 清零 ⇒ 角标消失（反向对照：清之前它在）", async () => {
    const container = await act(async () => renderShell("A"));
    // 反向对照的第一步：此刻必须在 —— 否则"消失"这件事是恒真的
    expect(badgeText(container), "清零之前角标必须在（否则这条判据是恒真）").toBe("3");

    await act(async () => {
      const scope = memoryPanelScope(PROJECT_A.path, SESSION_A.id);
      for (const e of svc.listPending(undefined, { projectId: scope.projectId, sessionId: scope.sessionId })) {
        // 批准 / 拒绝都把条目**移出**待批准状态；既有 API 会各自落库（因而会发通知）
        if (e.source === "auto") svc.reject(e.id);
      }
    });

    expect(svc.getStats(memoryPanelScope(PROJECT_A.path, SESSION_A.id)).pendingEntries, "前置条件：服务侧确实清零了").toBe(0);
    expect(badgeText(container), "清零之后角标必须**消失**（防「加了个永远亮着的点」）").toBeNull();
  });

  it("MEM-BADGE-3：点角标能到记忆面板（反向对照：点之前面板不在）", async () => {
    const container = await act(async () => renderShell("A"));
    expect(container.querySelector(".memory-manager"), "点之前面板不该在（否则下面那条断言是恒真）").toBeNull();

    const badge = container.querySelector(".memory-pending-badge");
    expect(badge, "先要有角标可点").toBeTruthy();
    await act(async () => {
      fireEvent.click(badge!);
    });
    expect(container.querySelector(".memory-manager"), "点角标必须真的把记忆面板打开").toBeTruthy();
  });
});
