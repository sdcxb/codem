/**
 * 底部面板页签 —— **入口可达性棘轮**（BOTTOM-TAB-1..8）。
 *
 * ## 守的缺陷（真机 + git 取证，2026-10-17）
 *
 * `BottomTab` 有 7 个成员，但页签栏（`App.tsx` 三套皮肤里的 `.panel-tabs`）在 `e1bdd01e`
 * 之后被改成 `display: none`，且**只剩 chat / terminal 有 setter**：
 *
 * | 成员 | 类型里有 | 渲染分支 | setter | 面板组件 |
 * |---|---|---|---|---|
 * | chat / terminal | ✓ | ✓ | ✓ | ✓ |
 * | perf | ✓ | ✗（`e1bdd01e` 删） | ✗ | `PerformanceDashboard`（槽位有贡献者） |
 * | files | ✓ | ✗（从来没有） | ✗ | `FileExplorer`（组件在，槽位无人注册） |
 * | jobs | ✓ | ✗（从来没有） | ✗ | **不存在**（只有会话头部的 `JobsBadge`） |
 * | cicd | ✓ | ✗（`a2a6826b` 删） | ✗ | `CicdPanel`（槽位有贡献者） |
 * | game | ✓ | ✓ | ✗（**刻意**，GAME-4 钉住） | `GameView`（懒加载） |
 *
 * 于是四个成员是「单测绿、功能死」的中间态：类型与门控都在，界面永远进不去。
 *
 * ## 判据（每个 `BottomTab` 成员必须满足二者之一）
 *
 * 1. **有可见入口**：页签栏渲染出该成员，点击真的把它回传给 setter（行为级，不是读源码字符串），
 *    且 `App.tsx` 里有它的渲染分支与降级回退；
 * 2. **被显式登记为「刻意无入口」**：登记表里写明理由（`game` 属于这一类，理由要引用 `GAME-4`）。
 *
 * **成员清单从类型定义现算**（`type BottomTab = "…" | "…";`），不许手抄：
 * 新加一个成员而忘了入口/登记 ⇒ 本判据红。
 *
 * ## 变异自证（BOTTOM-TAB-7 就是内建的反向对照）
 *
 * - 删掉 `BOTTOM_PANEL_TABS` 里任意一条入口 ⇒ BOTTOM-TAB-1/3/4/6 红；
 * - 把 `game` 从 `DELIBERATELY_ENTRYLESS_TABS` 里删掉 ⇒ BOTTOM-TAB-1 红（无人登记又无入口）；
 * - 把某条登记的理由清空 ⇒ BOTTOM-TAB-2 红。
 */
import { describe, expect, it, beforeEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import fs from "node:fs";
import path from "node:path";
import {
  BOTTOM_PANEL_GATE_FLAGS,
  BOTTOM_PANEL_TABS,
  BottomPanelTabs,
  DELIBERATELY_ENTRYLESS_TABS,
  type BottomPanelGates,
  type BottomPanelTabId,
} from "../components/BottomPanelTabs";

const ROOT = path.join(__dirname, "..", "..");
const APP_PATH = path.join(ROOT, "src", "App.tsx");
const APP_SRC = fs.readFileSync(APP_PATH, "utf8");

const ALL_ON: BottomPanelGates = { perf: true, files: true, jobs: true, cicd: true };

/** 从**类型定义现算**成员清单（不许手抄；新增成员漏了入口就会出现在 missing 里） */
function membersFromTypeDefinition(src: string): string[] {
  const decl = /type\s+BottomTab\s*=\s*([^;]+);/.exec(src);
  if (!decl) throw new Error("App.tsx 里找不到 type BottomTab 定义 —— 成员清单必须从它现算");
  return [...decl[1].matchAll(/"([A-Za-z0-9_-]+)"/g)].map((m) => m[1]);
}

/** 判据核心（纯函数，便于反向对照）：成员要么有入口，要么被登记为刻意无入口且写明理由 */
function auditBottomTabEntries(
  members: readonly string[],
  visibleIds: readonly string[],
  entryless: Readonly<Record<string, string>>,
): { missing: string[]; emptyReason: string[]; unknownRegistered: string[] } {
  return {
    missing: members.filter((m) => !visibleIds.includes(m) && !(m in entryless)),
    emptyReason: Object.entries(entryless)
      .filter(([, reason]) => !reason || !reason.trim())
      .map(([id]) => id),
    unknownRegistered: Object.keys(entryless).filter((k) => !members.includes(k)),
  };
}

const MEMBERS = membersFromTypeDefinition(APP_SRC);
const VISIBLE_IDS: BottomPanelTabId[] = BOTTOM_PANEL_TABS.map((t) => t.id);

/** 页签 → 它的内容槽位（真机上这四个 SlotBridge 各自挂一个面板） */
const SLOT_OF: Readonly<Record<string, string>> = {
  perf: "app.performance-dashboard",
  files: "app.file-explorer",
  jobs: "app.jobs",
  cicd: "app.cicd-panel",
};

/** 全仓现算某个槽位的注册方数量（`slots.register({ name: '<slot>' …`） */
function slotContributors(slot: string): number {
  let n = 0;
  const walk = (dir: string) => {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      if (fs.statSync(p).isDirectory()) {
        if (name === "node_modules" || name === "test") continue;
        walk(p);
        continue;
      }
      if (!/\.tsx?$/.test(name)) continue;
      const src = fs.readFileSync(p, "utf8");
      const re = new RegExp("register\\(\\{\\s*name:\\s*['\"]" + slot.replace(/\./g, "\\.") + "['\"]", "g");
      n += (src.match(re) || []).length;
    }
  };
  walk(path.join(ROOT, "src"));
  return n;
}

/** 取出 App.tsx 里某个槽位那一个 JSX 元素（`name="<slot>"` 到下一个 `/>`） */
function appElementFor(src: string, slot: string): string {
  const start = src.indexOf('name="' + slot + '"');
  if (start < 0) return "";
  const end = src.indexOf("/>", start);
  return end < 0 ? src.slice(start) : src.slice(start, end + 2);
}

beforeEach(() => {
  cleanup();
});

describe("底部面板页签入口棘轮", () => {
  it("BOTTOM-TAB-1: 每个 BottomTab 成员要么有可见入口，要么被显式登记为刻意无入口", () => {
    const audit = auditBottomTabEntries(MEMBERS, VISIBLE_IDS, DELIBERATELY_ENTRYLESS_TABS);
    expect(
      audit.missing,
      "这些成员既没有页签入口、也没有被登记为刻意无入口（成员清单从 type BottomTab 现算）：" +
        audit.missing.join(", ") +
        " —— 加成员就得给入口，或者写进 DELIBERATELY_ENTRYLESS_TABS 并说明理由",
    ).toEqual([]);
    expect(audit.unknownRegistered, "登记表里有不是 BottomTab 成员的表项（登记漂移）").toEqual([]);
    expect(audit.emptyReason, "刻意无入口的登记必须写明理由").toEqual([]);
  });

  it("BOTTOM-TAB-2: game 必须登记为刻意无入口，理由引用 GAME-4；且 game 不许出现在入口里", () => {
    expect(VISIBLE_IDS, "产品决定：不给游戏加 UI 入口").not.toContain("game");
    const reason = DELIBERATELY_ENTRYLESS_TABS.game;
    expect(reason, "game 必须在刻意无入口登记里（事实由 GAME-4 钉住）").toBeTruthy();
    expect(reason, "game 的登记理由必须引用 GAME-4，否则与既有判据脱钩").toContain("GAME-4");
    expect(
      /setBottomTab\(\s*["']game["']\s*\)/.test(APP_SRC),
      "App.tsx 里不许出现任何把 bottomTab 设成 game 的 setter（GAME-4 的另一半）",
    ).toBe(false);
  });

  it("BOTTOM-TAB-3: 入口真的渲染出来（可见入口数 == 页签按钮数）", () => {
    render(createElement(BottomPanelTabs, { tab: "chat", gates: ALL_ON, lang: "zh", onSelect: () => {} }));
    const rendered = screen
      .getAllByRole("tab")
      .map((el) => el.getAttribute("data-bottom-tab"))
      .filter((v): v is string => !!v);
    expect(rendered.sort(), "页签栏渲染出的入口必须与登记一致").toEqual([...VISIBLE_IDS].sort());
  });

  it("BOTTOM-TAB-4: 点每个入口都会把**它自己**回传给 setter（有 setter，且不是死按钮）", () => {
    const picked: BottomPanelTabId[] = [];
    render(
      createElement(BottomPanelTabs, {
        tab: "chat",
        gates: ALL_ON,
        lang: "zh",
        onSelect: (id: BottomPanelTabId) => picked.push(id),
      }),
    );
    for (const btn of screen.getAllByRole("tab")) {
      fireEvent.click(btn);
    }
    expect([...picked].sort(), "每个入口点击后回传的 id 必须覆盖全部可见成员").toEqual([...VISIBLE_IDS].sort());
  });

  it("BOTTOM-TAB-5: 门控为 false 的成员不渲染入口（不得进入）+ App 里必须有对应的降级回退", () => {
    for (const entry of BOTTOM_PANEL_TABS) {
      if (!entry.gate) continue;
      const gates: BottomPanelGates = { ...ALL_ON, [entry.gate]: false };
      render(createElement(BottomPanelTabs, { tab: "chat", gates, lang: "zh", onSelect: () => {} }));
      expect(
        screen.queryByRole("tab", { name: new RegExp(entry.zh) }),
        "门控 " + String(entry.gate) + " 为 false 时不许渲染 " + entry.id + " 入口",
      ).toBeNull();
      cleanup();

      // 状态机一致：App.tsx 的门控 effect 必须把该页签拉回 chat
      const flag = BOTTOM_PANEL_GATE_FLAGS[entry.gate];
      const degrade = new RegExp('bottomTab\\s*===\\s*"' + entry.id + '"\\s*&&\\s*!' + flag);
      expect(
        degrade.test(APP_SRC),
        "App.tsx 的降级 effect 里必须有 bottomTab === " + entry.id + " && !" + flag + " 的回退（否则开关关掉后页面卡在空面板）",
      ).toBe(true);
    }
  });

  it("BOTTOM-TAB-6: 每个可见入口在 App.tsx 里都有渲染分支（点开看得见东西，不是空白）", () => {
    for (const entry of BOTTOM_PANEL_TABS) {
      expect(
        APP_SRC.includes('bottomTab === "' + entry.id + '"'),
        entry.id + " 有入口却没有渲染分支 ⇒ 点开是空白（无入口的成员才允许只有分支）",
      ).toBe(true);
    }
  });

  it("BOTTOM-TAB-7: 反向对照 —— 判据函数本身能抓到「漏入口」和「空理由」", () => {
    // 变异 ①：新增成员漏了入口与登记
    expect(auditBottomTabEntries(["chat", "perf"], ["chat"], {}).missing).toEqual(["perf"]);
    // 变异 ②：登记了但理由为空
    expect(auditBottomTabEntries(["chat", "game"], ["chat"], { game: "  " }).emptyReason).toEqual(["game"]);
    // 变异 ③：登记表里出现非成员（漂移）
    expect(auditBottomTabEntries(["chat"], ["chat"], { ghost: "理由" }).unknownRegistered).toEqual(["ghost"]);
    // 正向对照：都齐了就必须全空
    expect(auditBottomTabEntries(["chat", "game"], ["chat"], { game: "理由" })).toEqual({
      missing: [],
      emptyReason: [],
      unknownRegistered: [],
    });
    // 成员清单确实是从类型定义现算的（不是空数组/手抄）
    expect(MEMBERS).toContain("chat");
    expect(MEMBERS).toContain("game");
    expect(MEMBERS.length).toBeGreaterThanOrEqual(7);
  });

  it("BOTTOM-TAB-8: 三套皮肤共用同一条页签栏，且不再有 display:none 的死容器", () => {
    expect(
      /className="panel-tabs"[^>]*display:\s*"none"/.test(APP_SRC),
      "页签栏容器不许再被 display:none 藏起来（那正是入口消失的形态）",
    ).toBe(false);

    const mountCount = (APP_SRC.match(/<BottomPanelTabs\b/g) || []).length;
    expect(mountCount, "三套皮肤（hub / dream / 默认）各自的页签栏都要挂同一个组件").toBeGreaterThanOrEqual(3);

    const wiredCount = (APP_SRC.match(/onSelect=\{setBottomTab\}/g) || []).length;
    expect(wiredCount, "页签栏的 onSelect 必须直接接到 setBottomTab（有 setter）").toBeGreaterThanOrEqual(3);
  });

  it("BOTTOM-TAB-9: 只有「有贡献者」的槽位才允许挂降级横幅（否则横幅就是假信息）", () => {
    /*
     * 真机截图抓到的假信息：`app.jobs` 槽位**没有**任何注册方，却挂了 showDegraded，
     * 于是「任务」页签顶上出现「⚠️ 此面板使用默认组件（插件已关闭：app.jobs）」——
     * 插件根本没关，只是没有插件贡献这个槽位。这条判据从源码现算注册方数量：
     * 0 个注册方的槽位，App.tsx 里那一个 SlotBridge 不许带 showDegraded。
     */
    // 反向对照：已知有注册方的槽位必须能被数出来（证明扫描器不是恒 0 的假绿）
    expect(slotContributors("app.jobs-badge"), "反向对照：app.jobs-badge 至少有 1 个注册方").toBeGreaterThan(0);

    for (const [id, slot] of Object.entries(SLOT_OF)) {
      const contributors = slotContributors(slot);
      const element = appElementFor(APP_SRC, slot);
      expect(element, id + " 的渲染分支里找不到槽位 " + slot).not.toBe("");
      if (contributors === 0) {
        expect(
          element.includes("showDegraded"),
          "槽位 " + slot + " 没有任何注册方（现算 " + contributors + " 个），" +
            id + " 页签不许挂 showDegraded —— 那会告诉用户「插件已关闭」，是假信息",
        ).toBe(false);
      }
    }
  });
});
