/**
 * 第 197 轮：**两项 UI 改动的门禁**。
 *
 * ## 用户要求
 *   1. 「app 启动后左下角的用户头像和用户名，增加个功能，点击它，打开设置页面。」
 *   2. 「设置里，把高级和帮助移到最后去。」
 *
 * ## 这一套为什么是源码级判据
 * 两件事都是**结构/顺序**性质，用 jsdom 渲染整块侧栏（依赖 store、identity、
 * 插件加载）成本高且容易因为无关依赖而碎；而它们要守的东西恰好是可静态断言的：
 *   · 点用户区能开设置（onSettings 接线 + 语义是按钮 + 插件按钮不许被包进按钮里）
 *   · 设置侧栏里"高级""帮助"这两项排在最后
 * **如实标注**：源码级判据守不了"点下去真的弹出来了" —— 那由装机版实机确认。
 *
 * ## 第 231 波：一条前提**作废**并换成现实里的那条（不是把判据删掉了事）
 *
 * 原来这里钉着「`onPerf` 应当仍然落到 performance」（`App.tsx` 里必须出现
 * `setSettingsInitialTab("performance")`）。这条前提**从一开始就钉着死代码**：
 * `7d768d3f`（UI restructure）把 Sidebar 上「性能 / CI-CD」两个按钮移走之后，
 * `Sidebar` 只是**声明并解构**了 `onPerf` / `onCicd` 两个 prop，**函数体里一次都没读**
 * （`git show 7d768d3f -- src/components/Sidebar.tsx` 可复核：`onClick={onPerf}` 那两处被删）。
 * 也就是说那段 `setSettingsInitialTab("performance")` 永远不会被执行 —— 判据绿着，功能早没了。
 *
 * 后来 `perf` 的入口由**底部页签**承担（`20bd7781` 恢复四页签；`BOTTOM-TAB-1..9` 判据守其可达性），
 * `cicd` 的入口则由右侧浮层 `PanelSidebar` 承担。所以现实是：
 *   · perf 的正当入口 = 底部「性能」页签（点它 ⇒ `onSelect("perf")` ⇒ `setBottomTab("perf")`）；
 *   · Sidebar 上**没有**这两个入口，也不该再接收这两个 prop。
 * 于是把前提换成上面那两条，并**额外**钉住"不许出现点了没反应的死按钮"（源码里连 prop 名都不许有）。
 * ⚠️ 这条判据与 `BOTTOM-TAB-4`（点每个页签回传它自己）有意重叠：前提就住在这一条里，
 * 换掉一处前提必须在新位置把同一件事重新说清楚，而不是靠"别处还有一条"。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { BOTTOM_TAB_ENTRIES } from "../core/ui/bottom-tab-entries";

const ROOT = process.cwd();
const SIDEBAR = readFileSync(path.join(ROOT, "src/components/Sidebar.tsx"), "utf8");
const SETTINGS = readFileSync(path.join(ROOT, "src/components/SettingsPanel.tsx"), "utf8");
const CSS = readFileSync(path.join(ROOT, "src/styles.css"), "utf8");
const APP = readFileSync(path.join(ROOT, "src/App.tsx"), "utf8");
/** 右侧浮层（cicd 的正当入口在这里） */
const PANEL_SIDEBAR = readFileSync(path.join(ROOT, "src/components/PanelSidebar.tsx"), "utf8");


beforeEach(() => {
  cleanup();
});

/**
 * 取某条 CSS 规则的**规则体内文**（`selector {` 到其后第一个 `}`）。
 *
 * ⚠️ **为什么必须限定在规则里**：第一版我直接对整份 styles.css 做 `toMatch`，
 * 断言「`.sidebar-user-me` 必须占前两列」—— 而这份 19000 行的样式表里
 * **别处也有 `grid-column: 1 / 3`**，于是把这条规则改成 `grid-column: 1 / 2`
 * （插件按钮会移位）门禁照样全绿。变异自证当场把这一条照了出来。
 * **整份样式表里出现过的字符串，不能当作"这条规则写对了"的证据。**
 */
function cssRuleBody(selector: string): string {
  const at = CSS.indexOf(`${selector} {`);
  expect(at, `styles.css 里找不到规则 ${selector}`).toBeGreaterThan(-1);
  const end = CSS.indexOf("}", at);
  expect(end).toBeGreaterThan(at);
  return CSS.slice(at, end);
}

/** 取设置侧栏那一段（从 settings-sidebar 到它的闭合 div） */
function settingsNavBlock() {  const start = SETTINGS.indexOf('className="settings-sidebar"');
  expect(start, "没找到设置侧栏容器").toBeGreaterThan(-1);
  /* 取到 "settings-content" 之前即可（那是右半边内容区的起点） */
  const end = SETTINGS.indexOf('className="settings-content"', start);
  expect(end, "没找到 settings-content 作为结束锚点").toBeGreaterThan(start);
  return SETTINGS.slice(start, end);
}

/** 从上到下抽 (tabId, 中文名) */
function navItems() {
  const block = settingsNavBlock();
  const items = [];
  for (const part of block.split("</button>")) {
    const tab = part.match(/setActiveTab\("([^"]+)"\)/);
    const zh = part.match(/lang === "zh" \? "([^"]+)"/);
    if (tab && zh) items.push({ tab: tab[1], zh: zh[1] });
  }
  return items;
}

describe("USERCLICK-197 侧栏底部用户区点击打开设置", () => {
  it("USERCLICK-197-1 用户区在 onSettings 存在时是可点按钮，且指向 onSettings", () => {
    expect(SIDEBAR, "用户区没有接 onSettings").toMatch(/onClick=\{onSettings\}/);
    /* 必须是 button，才能白拿键盘可达与读屏语义 */
    expect(SIDEBAR, "用户区应当渲染成 button").toMatch(/className="sidebar-user-me sidebar-user-me--clickable"/);
    /* 无障碍名要有（图标按钮扫得出来） */
    expect(SIDEBAR, "可点用户区缺 aria-label / title").toMatch(/aria-label=\{S\.sidebar\.settings\[lang\]\}/);
  });

  it("USERCLICK-197-2 ★不许出现 button 套 button（非法 HTML）", () => {
    /* 这一块里本来就有插件管理按钮；如果把它包进外层 button，
       浏览器会把结构拆开、行为不可预期。所以必须是"相邻的两个按钮"。 */
    const at = SIDEBAR.indexOf('className="sidebar-user-area"');
    expect(at, "找不到用户区").toBeGreaterThan(-1);
    const seg = SIDEBAR.slice(at - 40, at + 2600);
    /* 外层容器是 div，不是 button */
    expect(seg, "外层容器不该是 button").toMatch(/<div className="sidebar-user-area">/);
    /* 里面恰好两个 button：用户区自身 + 插件按钮 */
    const opens = (seg.match(/<button/g) || []).length;
    expect(opens, `用户区里 button 数量异常（${opens}）—— 疑似嵌套`).toBe(2);
    expect(seg, "插件按钮应当与用户区**相邻**，而不是被包住").toMatch(/sidebar-user-plugin-btn/);
  });

  it("USERCLICK-197-3 onSettings 不存在时退回普通容器（不出现点了没反应的死按钮）", () => {
    /* 设置被插件禁用时 settingsEnabled=false ⇒ onSettings 为 undefined。
       此时若仍渲染成 button，用户点了没反应 —— 比"不能点"更糟。 */
    expect(SIDEBAR, "缺少 onSettings 的三元分支").toMatch(/\{onSettings \? \(/);
    expect(SIDEBAR, "退回分支里应当是没有 --clickable 的普通 div").toMatch(/<div className="sidebar-user-me">/);
  });

  it("USERCLICK-197-4 可点态有悬停与焦点反馈，且不改变原有布局位置", () => {
    /* 占掉外层 grid 的前两列，插件按钮才能留在第三列（位置不变）。
       注意：断言**限定在 `.sidebar-user-me` 这条规则里**，不是整份样式表。 */
    const meBody = cssRuleBody(".sidebar-user-me");
    expect(meBody, "用户区必须占前两列，否则插件按钮会移位").toMatch(/grid-column:\s*1\s*\/\s*3/);
    expect(meBody, "用户区自己也要是两列 grid（头像 + 信息）")
      .toMatch(/grid-template-columns:\s*max-content\s+minmax\(0,\s*1fr\)/);
    /* 可点态的视觉处理 */
    const clickable = cssRuleBody(".sidebar-user-me--clickable");
    expect(clickable, "可点态应当有负外边距抵消内边距，保证视觉位置不变")
      .toMatch(/margin:\s*calc\(var\(--space-2\) \* -1\)/);
    expect(CSS, "缺悬停/焦点背景").toMatch(/\.sidebar-user-me--clickable:is\(:hover, :focus-visible\)/);
    const focus = cssRuleBody(".sidebar-user-me--clickable:focus-visible");
    expect(focus, "缺焦点环（键盘用户要看得见）").toMatch(/outline:\s*2px solid var\(--accent\)/);
  });
});

describe("SETTINGSORDER-197 设置里「高级」「帮助」排到最后", () => {
  it("SETTINGSORDER-197-1 两项都在，且是列表的最后两项", () => {
    const items = navItems();
    expect(items.length, "没解析出设置项").toBeGreaterThan(3);
    const tabs = items.map((i) => i.tab);
    const adv = tabs.indexOf("advanced");
    const help = tabs.indexOf("help");
    expect(adv, "找不到「高级」").toBeGreaterThan(-1);
    expect(help, "找不到「帮助」").toBeGreaterThan(-1);
    expect(help, "「帮助」应当是最后一项").toBe(tabs.length - 1);
    expect(adv, "「高级」应当是倒数第二项").toBe(tabs.length - 2);
    /* 相邻且顺序是 高级 → 帮助 */
    expect(help - adv, "两项应当相邻").toBe(1);
  });

  it("SETTINGSORDER-197-2 它们不再夹在日常功能中间（按 tab 逐个钉住相对顺序）", () => {
    const tabs = navItems().map((i) => i.tab);
    const pos = (t: string) => tabs.indexOf(t);
    /* 用户点名的"移到最后"—— 也就是它们必须排在宠物/用量/性能**之后** */
    for (const daily of ["pet", "usage", "performance"]) {
      expect(pos(daily), `${daily} 应当排在「高级」之前`).toBeLessThan(pos("advanced"));
    }
    /* 几个日常区块也要排在它们之前（原先「高级/帮助」是夹在这些中间偏前的位置） */
    for (const early of ["appearance", "tools", "ollama", "voice"]) {
      expect(pos(early), `${early} 应当排在「高级」之前`).toBeLessThan(pos("advanced"));
    }
    /**
     * ⚠️ 顺序断言只用**下标**，不用"绝对条数"。第一版我写死了
     * `common === [general, appearance, …, pet]`，结果实际列表是 **22 项**（我只数了 12），
     * 判据当场把正确代码判红。**别把"我以为有几项"写进判据** ——
     * 相对顺序才是这次改动的契约，条数另有专门一条断言兜着。
     */
    expect(tabs[0], "第一项应当仍是「通用」").toBe("general");
    expect(tabs[1], "第二项应当仍是「外观」").toBe("appearance");
  });

  it("SETTINGSORDER-197-3 只动了渲染顺序：跳转入口仍落在原来的页", () => {
    /* 只调顺序不该影响任何人"点进来落哪一页"。逐个钉住既有入口。 */
    expect(APP, "打开设置应当仍然落到 general").toMatch(/setSettingsInitialTab\("general"\)/);
    /**
     * ⚠️ 第 231 波：原来这里还有一条「`onPerf` 应当仍然落到 performance」。
     * 那条前提守的是**死代码**（Sidebar 从 `7d768d3f` 起就不再读 `onPerf`），
     * 而 perf 的入口早已换成底部页签 ⇒ 前提搬到下面 `PERFENTRY-231` 并换成现实里的那条。
     * **没有删判据**：断言条数从 1 条变成 4 条，钉的是同一件事（perf 怎么进、进去落在哪）。
     */
    /* 两个 tab 的 id 不变（改 id 会让会话里保存的"上次所在页"失效） */
    expect(SETTINGS).toMatch(/activeTab === "advanced"/);
    expect(SETTINGS).toMatch(/activeTab === "help"/);
    /* 没有重复的 tab 标识（重复会导致两个条目抢同一个高亮） */
    const tabs = navItems().map((i) => i.tab);
    expect(new Set(tabs).size, "有重复的 tab 标识").toBe(tabs.length);
    /* 数量取"至少这么多"而不是精确值：精确值放这儿只会变成又一处理论上会误报的地方，
       而"少了一个入口"这种真问题由上面那条 tab 集合断言（每个分区都存在）来守。 */
    expect(tabs.length, `设置项太少了（${tabs.length}）`).toBeGreaterThan(15);
    /**
     * ⚠️ 这里**只列实际存在的分区**。第一版我凭印象写了 `models`，
     * 结果这个设置面板里**根本没有** `models` 这个 tab（模型配置在别的分区里）——
     * 判据当场把正确代码判红。**别把"我以为有哪几项"写进判据**；
     * 要钉就用真实存在的那些（下面这份是从渲染顺序里逐条读出来的，共 22 项）。
     */
    for (const must of ["general", "appearance", "security", "tools", "persona", "pet", "usage", "performance", "advanced", "help"]) {
      expect(tabs, `缺少分区 ${must}`).toContain(must);
    }
  });
});

/**
 * 第 231 波：**`onPerf` / `onCicd` 两个死 prop 的收尾判据**（取代原来那条「onPerf → 设置页」）。
 *
 * 现实（取证见文件头）：Sidebar 不再有这两个入口，perf 走底部页签、cicd 走右侧浮层。
 * 这四条钉的就是"收尾没有把入口弄丢、也没有留下点了没反应的按钮"：
 *   1. Sidebar 一个字节里都不许再出现 `onPerf` / `onCicd`（声明、解构、`onClick` 全算）；
 *   2. App 不再给 Sidebar 传这两个 prop（传了也没人读 = 假接线）；
 *   3. perf 的入口是底部页签，点它回传的必须是 `perf`（不是"跳设置页"、不是"没反应"）；
 *   4. 两条正当入口都还在：设置面板自己的「性能」分区（`setActiveTab("performance")`）、
 *      右侧浮层的 cicd 页签（`PanelSidebar` 的 tab 登记）。
 */
describe("PERFENTRY-231 Sidebar 的 onPerf / onCicd 死 prop 收尾", () => {
  it("PERFENTRY-231-1 Sidebar 的 props 里不再有 onPerf / onCicd（也没有任何 onCicd/onPerf 引用）", () => {
    const from = SIDEBAR.indexOf("interface SidebarProps");
    expect(from, "找不到 SidebarProps 接口").toBeGreaterThan(-1);
    const propsBlock = SIDEBAR.slice(from, SIDEBAR.indexOf("}", from));
    expect(propsBlock, "SidebarProps 里还有 onCicd（死 prop 没清干净）").not.toMatch(/\bonCicd\b/);
    expect(propsBlock, "SidebarProps 里还有 onPerf（死 prop 没清干净）").not.toMatch(/\bonPerf\b/);
    expect(SIDEBAR, "Sidebar 里还有 onCicd/onPerf 的引用（声明或 onClick 都算）").not.toMatch(/\bon(?:Perf|Cicd)\b/);
  });

  it("PERFENTRY-231-2 App 不再给 Sidebar 传 onPerf / onCicd", () => {
    expect(APP, "App.tsx 还在给 Sidebar 传 onPerf（没人读 = 假接线）").not.toMatch(/\bonPerf\b/);
    expect(APP, "App.tsx 还在给 Sidebar 传 onCicd（没人读 = 假接线）").not.toMatch(/\bonCicd\b/);
    /* 收尾不许把别的接线一起带走：Sidebar 仍收得到它的既有 prop */
    expect(APP, "App.tsx 仍在给 Sidebar 传 onSettings").toMatch(/onSettings=\{/);
    expect(APP, "App.tsx 仍在给 Sidebar 传 onAgents").toMatch(/onAgents=\{/);
  });

  it("PERFENTRY-231-3 ★perf 的入口是登记表里的「设置 → 性能」分区（页签栏已于第 233 波隐藏）", () => {
    /**
     * 第 233 波：顶部页签栏整体隐藏（用户要求），所以这条判据的口径从
     * 「点页签把 perf 回传 setter」改成「perf 有一条**登记在表里**的可达入口」。
     * 事实仍然是同一个渲染：设置 → 性能分区渲染的就是 `PerformanceDashboard`。
     */
    const perfEntries = BOTTOM_TAB_ENTRIES.perf ?? [];
    expect(perfEntries.length, "perf 必须至少有一条登记入口").toBeGreaterThan(0);
    expect(
      perfEntries.some((e) => e.kind === "settings-section" && e.file === "src/components/SettingsPanel.tsx"),
      "perf 的入口必须登记为设置面板的性能分区",
    ).toBe(true);
    expect(SETTINGS, "设置面板必须仍有性能分区").toContain('activeTab === "performance"');
    /*
     * 同一个组件的证据：性能分区那一段里就直接渲染 `<PerformanceDashboard`。
     * 用子串切片而不是长正则 —— 这一行上的正则转义被生成脚本吃掉过一次（`` 变成退格符），
     * 切片写法没有转义面，读起来也更直。
     */
    const perfBlockStart = SETTINGS.indexOf('{activeTab === "performance" && (');
    expect(perfBlockStart, "设置面板里找不到性能分区的渲染块").toBeGreaterThan(0);
    expect(
      SETTINGS.slice(perfBlockStart, perfBlockStart + 400),
      "性能分区渲染的必须是同一个 PerformanceDashboard",
    ).toContain("<PerformanceDashboard");
    expect(PANEL_SIDEBAR, "perf 不走右侧抽屉（那里没有性能页签）").not.toMatch(/id:\s*"perf"/);

    /**
     * 反向的一半：**perf 不再走「跳设置页初始 tab」那条路**（那是死 prop 的产物）。
     * 现在"进设置再点分区"是真入口，但 App 仍不该用 `setSettingsInitialTab("performance")` 代跳。
     */
    expect(APP, "perf 不该再从设置页初始 tab 代跳（那是死 prop 的产物）").not.toMatch(/setSettingsInitialTab\("performance"\)/);
    /* 页签栏已隐藏：App 不许再渲染它，也不许再有"点页签才有落点"的接线 */
    expect(APP, "页签栏已隐藏，App 不该再渲染 BottomPanelTabs").not.toMatch(/<BottomPanelTabs/);
    expect(APP, "App.tsx 里必须仍有 perf 面板的兜底分支（面板本体不删）").toMatch(/bottomTab === "perf"/);
  });

  it("PERFENTRY-231-4 两条正当入口都还在：设置页的性能分区 + 右侧浮层的 cicd 页签", () => {
    /* 设置面板自己的「性能」分区（Sidebar 的 onPerf 走的就是它，现在它自己就是入口） */
    expect(SETTINGS, "设置面板里没有「性能」分区了").toMatch(/setActiveTab\("performance"\)/);
    /* cicd：右侧浮层的页签（`7d768d3f` 起它的入口就在这里） */
    expect(PANEL_SIDEBAR, "右侧浮层里没有 cicd 页签登记").toMatch(/id: "cicd"/);
    expect(PANEL_SIDEBAR, "右侧浮层的 cicd 页签必须挂在门控上").toMatch(/if \(cicdEnabled\) \{/);
  });
});
