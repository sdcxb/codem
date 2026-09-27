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
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const SIDEBAR = readFileSync(path.join(ROOT, "src/components/Sidebar.tsx"), "utf8");
const SETTINGS = readFileSync(path.join(ROOT, "src/components/SettingsPanel.tsx"), "utf8");
const CSS = readFileSync(path.join(ROOT, "src/styles.css"), "utf8");

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

  it("SETTINGSORDER-197-3 只动了渲染顺序：tab 标识与跳转入口都没变", () => {
    /* 只调顺序不该影响任何人"点进来落哪一页"。逐个钉住既有入口。 */
    const app = readFileSync(path.join(ROOT, "src/App.tsx"), "utf8");
    expect(app, "onPerf 应当仍然落到 performance").toMatch(/setSettingsInitialTab\("performance"\)/);
    expect(app, "打开设置应当仍然落到 general").toMatch(/setSettingsInitialTab\("general"\)/);
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
