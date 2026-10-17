/**
 * 底部面板成员 —— **入口可达性棘轮**（BOTTOM-TAB-1..9，第 233 波改写）。
 *
 * ## 这一波的前提变了（不是把断言删掉，而是按新现实重写）
 *
 * 第 231 波的口径是「每个成员必须有一条**可见页签**入口」，于是判据绑在页签栏上：
 * `BOTTOM-TAB-3/4/5/8` 都假设「`<BottomPanelTabs>` 被渲染、点一下把 id 回传 setter」。
 *
 * 用户随后要求**把顶部那条页签栏整体隐藏**（理由：这些都有其它入口）。所以前提从
 * 「页签栏可见」变成「**入口可达**」：入口可以是页签栏，也可以是**登记在表里的其它入口点**
 * （标题栏按钮 / 命令面板 / 设置分区 / 右侧抽屉页签 / 面板关闭按钮）。
 *
 * - 成员清单仍**从类型定义现算**（`src/core/ui/bottom-tab-entries.ts` 的 `BottomPanelTabId`；
 *   `App.tsx` 的 `type BottomTab` 必须只是它的别名，不许第二份手写 union）；
 * - 入口点必须**逐条登记**（`BOTTOM_TAB_ENTRIES`），且**每条都要在源码里真的找到**（文件 + 符号）；
 * - `game` 仍登记为刻意无入口（理由引用 `GAME-4`）。
 *
 * ## 判据
 *
 * | # | 守什么 |
 * |---|---|
 * | 1 | 每个成员要么有至少一条登记入口，要么被登记为刻意无入口且写明理由；登记不许漂移、不许空理由 |
 * | 2 | `game` 必须登记为刻意无入口、理由引用 `GAME-4`、且 App 里没有任何 `setBottomTab("game")` |
 * | 3 | 每条登记的入口都**真实存在**：`file` 存在且包含 `symbol`（防止「口头声明有入口」） |
 * | 4 | 页签栏**确实已隐藏**：App 不再渲染 `<BottomPanelTabs>`、不再出现 `panel-tabs`，组件文件已删除 |
 * | 5 | 门控仍生效：降级回退**由 `BOTTOM_PANEL_GATE_FLAGS` 现算**，四个面板分支都带门控 |
 * | 6 | 面板本体没被删；且 0 贡献者的槽位不许挂 `showDegraded`（假横幅） |
 * | 7 | 反向对照：入口审计函数必须能抓到「漏入口」「空理由」「登记漂移」 |
 * | 8 | 入口的**宿主面**正确：files / jobs / cicd 在右侧抽屉、perf 在设置分区、terminal 在标题栏 |
 * | 9 | 隐藏后不留假扩展点：`bottom-panel.tabs` 槽位已撤销，也没有任何 render 出口 |
 *
 * ## 变异（真跑过，先红后绿）
 *
 * - 删掉 `BOTTOM_TAB_ENTRIES` 里 `jobs` 的全部入口 ⇒ BOTTOM-TAB-1/3 红；
 * - 把 `game` 从 `DELIBERATELY_ENTRYLESS_TABS` 删掉 ⇒ BOTTOM-TAB-1 红；
 * - 把某条入口的 `symbol` 改成不存在的字符串 ⇒ BOTTOM-TAB-3 红。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  BOTTOM_PANEL_GATE_FLAGS,
  BOTTOM_TAB_ENTRIES,
  DELIBERATELY_ENTRYLESS_TABS,
  type BottomTabEntry,
} from "../core/ui/bottom-tab-entries";

const ROOT = path.join(__dirname, "..", "..");
const APP_PATH = path.join(ROOT, "src", "App.tsx");
const APP_SRC = fs.readFileSync(APP_PATH, "utf8");
const REGISTRY_PATH = path.join(ROOT, "src", "core", "ui", "bottom-tab-entries.ts");
const REGISTRY_SRC = fs.readFileSync(REGISTRY_PATH, "utf8");
const SIDEBAR_SRC = fs.readFileSync(path.join(ROOT, "src", "components", "PanelSidebar.tsx"), "utf8");
const SETTINGS_SRC = fs.readFileSync(path.join(ROOT, "src", "components", "SettingsPanel.tsx"), "utf8");
const TITLEBAR_SRC = fs.readFileSync(path.join(ROOT, "src", "components", "TitleBar.tsx"), "utf8");

/** 从**类型定义现算**成员清单（类型是唯一来源，不许手抄） */
function membersFromTypeUnion(src: string): string[] {
  const decl = /export\s+type\s+BottomPanelTabId\s*=\s*([^;]+);/.exec(src);
  if (!decl) throw new Error("登记模块里找不到 export type BottomPanelTabId —— 成员清单必须从它现算");
  return [...decl[1].matchAll(/"([A-Za-z0-9_-]+)"/g)].map((m) => m[1]);
}

/** 判据核心（纯函数，便于反向对照）：成员要么有登记入口，要么被登记为刻意无入口且写明理由 */
function auditEntries(
  members: readonly string[],
  entries: Readonly<Record<string, readonly BottomTabEntry[]>>,
  entryless: Readonly<Record<string, string>>,
): { missing: string[]; emptyReason: string[]; unknownRegistered: string[] } {
  const withEntries = Object.entries(entries)
    .filter(([, list]) => list.length > 0)
    .map(([id]) => id);
  return {
    missing: members.filter((m) => !withEntries.includes(m) && !(m in entryless)),
    emptyReason: Object.entries(entryless)
      .filter(([, reason]) => !reason || !reason.trim())
      .map(([id]) => id),
    unknownRegistered: [...Object.keys(entries), ...Object.keys(entryless)].filter((k) => !members.includes(k)),
  };
}

/** 逐条核对入口的「文件 + 符号」真的存在（防止登记表变成口头声明） */
function missingEntryEvidence(entries: Readonly<Record<string, readonly BottomTabEntry[]>>): string[] {
  const missing: string[] = [];
  for (const [id, list] of Object.entries(entries)) {
    for (const entry of list) {
      const abs = path.join(ROOT, entry.file);
      if (!fs.existsSync(abs)) {
        missing.push(id + " → " + entry.file + " 不存在（" + entry.why + "）");
        continue;
      }
      const src = fs.readFileSync(abs, "utf8");
      if (!src.includes(entry.symbol)) missing.push(id + " → " + entry.file + " 里找不到 " + entry.symbol);
    }
  }
  return missing;
}

/** 全仓现算某个槽位的注册方数量（slots.register({ name: '<slot>' …） */
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

/** 取出 App.tsx 里某个槽位那一个 JSX 元素（name="<slot>" 到下一个 />） */
function appElementFor(src: string, slot: string): string {
  const start = src.indexOf('name="' + slot + '"');
  if (start < 0) return "";
  const end = src.indexOf("/>", start);
  return end < 0 ? src.slice(start) : src.slice(start, end + 2);
}

const MEMBERS = membersFromTypeUnion(REGISTRY_SRC);

/** 页签 → 它的内容槽位（面板本体仍在；槽位是否有贡献者由扫描现算） */
const SLOT_OF: Readonly<Record<string, string>> = {
  perf: "app.performance-dashboard",
  files: "app.file-explorer",
  jobs: "app.jobs",
  cicd: "app.cicd-panel",
};

describe("底部面板成员入口棘轮（页签栏已隐藏）", () => {
  it("BOTTOM-TAB-1: 每个成员要么有登记入口，要么被登记为刻意无入口（理由非空）", () => {
    const audit = auditEntries(MEMBERS, BOTTOM_TAB_ENTRIES, DELIBERATELY_ENTRYLESS_TABS);
    expect(
      audit.missing,
      "这些成员既没有登记入口、也没有被登记为刻意无入口（成员清单从类型定义现算）：" +
        audit.missing.join(", ") +
        " —— 加成员就得给入口，或者写进 DELIBERATELY_ENTRYLESS_TABS 并说明理由",
    ).toEqual([]);
    expect(audit.unknownRegistered, "登记表里有不是成员的条目（登记漂移）").toEqual([]);
    expect(audit.emptyReason, "刻意无入口的登记必须写明理由").toEqual([]);

    // 成员类型只能有一份：App.tsx 的 BottomTab 必须是别名，不许再手写一份 union
    expect(APP_SRC, "App.tsx 的 type BottomTab 必须只是 BottomPanelTabId 的别名（不许第二份 union）").toMatch(
      /type\s+BottomTab\s*=\s*BottomPanelTabId\s*;/,
    );
    expect(MEMBERS.length, "成员清单必须真的从类型现算到（不是空数组）").toBeGreaterThanOrEqual(7);
  });

  it("BOTTOM-TAB-2: game 必须登记为刻意无入口、理由引用 GAME-4；入口表里不许有 game", () => {
    expect(Object.keys(BOTTOM_TAB_ENTRIES), "产品决定：不给游戏加入口").not.toContain("game");
    const reason = DELIBERATELY_ENTRYLESS_TABS.game;
    expect(reason, "game 必须在刻意无入口登记里（事实由 GAME-4 钉住）").toBeTruthy();
    expect(reason, "game 的登记理由必须引用 GAME-4，否则与既有判据脱钩").toContain("GAME-4");
    expect(
      /setBottomTab\(\s*["']game["']\s*\)/.test(APP_SRC),
      "App.tsx 里不许出现任何把 bottomTab 设成 game 的 setter（GAME-4 的另一半）",
    ).toBe(false);
  });

  it("BOTTOM-TAB-3: 每条登记入口都真实存在（文件 + 符号都在），且每个成员至少一条", () => {
    const missing = missingEntryEvidence(BOTTOM_TAB_ENTRIES);
    expect(missing, "登记了但源码里找不到的入口：\n" + missing.join("\n")).toEqual([]);
    for (const member of MEMBERS) {
      if (member in DELIBERATELY_ENTRYLESS_TABS) continue;
      expect((BOTTOM_TAB_ENTRIES[member] ?? []).length, member + " 至少要有 1 条登记入口").toBeGreaterThan(0);
    }
  });

  it("BOTTOM-TAB-4: 页签栏确实已隐藏（不渲染、组件已删、不再出现 panel-tabs）", () => {
    expect(APP_SRC, "App.tsx 不许再渲染 <BottomPanelTabs>").not.toMatch(/<BottomPanelTabs\b/);
    expect(APP_SRC, "App.tsx 不许再 import BottomPanelTabs").not.toMatch(/import\s*\{[^}]*BottomPanelTabs[^}]*\}/);
    expect(APP_SRC, "页签栏容器类名不该再出现在 App.tsx").not.toContain('"panel-tabs"');
    expect(
      fs.existsSync(path.join(ROOT, "src", "components", "BottomPanelTabs.tsx")),
      "页签栏组件文件已删除（入口栏不再存在）",
    ).toBe(false);
  });

  it("BOTTOM-TAB-5: 门控仍生效，且降级回退由登记表现算（不是手写四条 if）", () => {
    expect(APP_SRC, "降级 effect 必须遍历 BOTTOM_PANEL_GATE_FLAGS（成员与门控只留一份来源）").toContain(
      "Object.entries(BOTTOM_PANEL_GATE_FLAGS)",
    );
    for (const [gate, flag] of Object.entries(BOTTOM_PANEL_GATE_FLAGS)) {
      expect(flag, gate + " 的门控变量名必须是 App 里真实存在的 flag").toMatch(/Enabled$/);
      expect(APP_SRC, "App.tsx 必须仍然声明 " + flag).toContain(flag);
      expect(REGISTRY_SRC, "登记表必须仍然包含 " + gate).toContain(gate);
    }
    // 四个面板分支都必须带门控（关掉插件后不许进空面板）
    for (const id of Object.keys(BOTTOM_TAB_ENTRIES)) {
      const gate = (BOTTOM_PANEL_GATE_FLAGS as Record<string, string>)[id];
      if (!gate) continue;
      const branches = APP_SRC.split("\n").filter((line) => line.includes('bottomTab === "' + id + '"'));
      expect(branches.length, id + " 必须仍有内容分支").toBeGreaterThan(0);
      expect(
        branches.some((line) => new RegExp(gate).test(line)),
        id + " 的内容分支必须带门控 " + gate + "（否则插件关掉后会渲染空面板）",
      ).toBe(true);
    }
  });

  it("BOTTOM-TAB-6: 面板本体没被删；0 贡献者的槽位不许挂 showDegraded（假横幅）", () => {
    for (const [id, slot] of Object.entries(SLOT_OF)) {
      const element = appElementFor(APP_SRC, slot);
      expect(element, id + " 的兜底分支里找不到槽位 " + slot + "（面板本体不许删）").not.toBe("");
      const contributors = slotContributors(slot);
      if (contributors === 0) {
        expect(
          element.includes("showDegraded"),
          "槽位 " + slot + " 没有任何注册方（现算 " + contributors + " 个），" + id + " 不许挂 showDegraded —— 那是假信息",
        ).toBe(false);
      }
    }
    // 反向对照：已知有注册方的槽位必须能被数出来（证明扫描器不是恒 0）
    expect(slotContributors("app.jobs-badge"), "反向对照：app.jobs-badge 至少有 1 个注册方").toBeGreaterThan(0);
  }, 20_000);

  it("BOTTOM-TAB-7: 反向对照 —— 入口审计函数能抓到「漏入口 / 空理由 / 登记漂移」", () => {
    const entry = (symbol: string): BottomTabEntry => ({ kind: "sidebar-tab", file: "x", symbol, why: "对照" });
    expect(auditEntries(["chat", "perf"], { chat: [entry("a")] }, {}).missing).toEqual(["perf"]);
    expect(auditEntries(["chat", "game"], { chat: [entry("a")] }, { game: "  " }).emptyReason).toEqual(["game"]);
    expect(auditEntries(["chat"], { chat: [entry("a")], ghost: [entry("b")] }, {}).unknownRegistered).toEqual(["ghost"]);
    expect(auditEntries(["chat"], { chat: [] }, {})).toEqual({
      missing: ["chat"],
      emptyReason: [],
      unknownRegistered: [],
    });
  });

  it("BOTTOM-TAB-8: 入口的宿主面正确（右侧抽屉 / 设置分区 / 标题栏），抽屉的 jobs 页签真的渲染 JobsPanel", () => {
    const byKind = (id: string, kind: BottomTabEntry["kind"]) =>
      (BOTTOM_TAB_ENTRIES[id] ?? []).filter((e) => e.kind === kind);
    for (const id of ["files", "jobs", "cicd"]) {
      expect(byKind(id, "sidebar-tab").length, id + " 的入口应在右侧抽屉（PanelSidebar）").toBeGreaterThan(0);
    }
    expect(byKind("perf", "settings-section").length, "perf 的入口应在设置分区").toBeGreaterThan(0);
    expect(byKind("terminal", "titlebar").length, "terminal 的入口应在标题栏").toBeGreaterThan(0);

    expect(SIDEBAR_SRC).toMatch(/id:\s*"jobs"/);
    expect(SIDEBAR_SRC).toContain('effectiveTab === "jobs"');
    expect(SIDEBAR_SRC).toMatch(/effectiveTab === "jobs"[\s\S]{0,200}<JobsPanel\b/);
    expect(SIDEBAR_SRC, "jobs 页签要跟插件门控一致").toContain("@codem/ui-jobs");
    expect(SETTINGS_SRC).toMatch(/activeTab === "performance"[\s\S]{0,200}<PerformanceDashboard\b/);
    expect(TITLEBAR_SRC).toContain("onToggleTerminal");
    expect(APP_SRC).toMatch(/onToggleTerminal=\{\(\) => setBottomTab\(/);
  });

  it("BOTTOM-TAB-9: 隐藏后不留假扩展点 —— bottom-panel.tabs 槽位已撤销", () => {
    const declareSlots = fs.readFileSync(path.join(ROOT, "src", "core", "slots", "declare-slots.ts"), "utf8");
    expect(
      /declareSlot\(\s*['"]bottom-panel\.tabs['"]/.test(declareSlots),
      "没有宿主的槽位不许继续声明（否则是「看起来能扩展其实没人渲染」的假扩展点）",
    ).toBe(false);
    const allSources = (dir: string, out: string[] = []): string[] => {
      for (const name of fs.readdirSync(dir)) {
        const p = path.join(dir, name);
        if (fs.statSync(p).isDirectory()) {
          if (name === "node_modules" || name === "test") continue;
          allSources(p, out);
        } else if (/\.tsx?$/.test(name)) out.push(fs.readFileSync(p, "utf8"));
      }
      return out;
    };
    const bridged = allSources(path.join(ROOT, "src")).filter((src) =>
      /<Slot(List)?Bridge\s+name="bottom-panel\.tabs"/.test(src),
    );
    expect(bridged.length, "没有任何宿主渲染 bottom-panel.tabs，源码里也不许再有它的 render 出口").toBe(0);
  });
});
