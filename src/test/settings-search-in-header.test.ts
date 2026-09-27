/**
 * SEARCHMOVE-198：**设置搜索框在标题栏中间，不在左侧栏里**（第 198 轮）
 *
 * ## 用户现场
 * 「搜索设置留的区域太小了，把它从这个地方拿走，移到设置窗口弹窗
 * **标题栏**【带 ⚙️ 设置】的那个**中间**。」
 *
 * ## 为什么原来确实太小（实测出来的数，不是感觉）
 * `.settings-panel` 宽 **760px**，而 `.settings-sidebar` 只占 **160px** ——
 * 搜索框挂在侧栏里，减掉自身左右内边距后，真正能打字的宽度不到 **120px**。
 * 搬进标题栏后可用宽度约 **520px**（受 `max-width` 约束，窗口变窄时自动收）。
 *
 * ## 这条门禁守什么
 *   · 搜索框在 `.settings-header` 内、且**在** `.settings-sidebar` **之前**（结构位置）；
 *   · 侧栏里**不再**有搜索框（防止"搬了但没搬干净"或又被放回去）；
 *   · 走的是 `--in-header` 那一支样式（`--bordered` 那支已随搬运删除）；
 *   · 输入框高度用**存在**的令牌（写一个不存在的令牌会让 height 静默失效 ⇒ 框塌成 0）。
 * **守不了**："看着是不是在正中间" —— 那由装机版实机量几何。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const PANEL = readFileSync(path.join(ROOT, "src/components/SettingsPanel.tsx"), "utf8");
const CSS = readFileSync(path.join(ROOT, "src/styles.css"), "utf8");

/** 取某条 CSS 规则的规则体内文（限定断言范围，别拿整份样式表当证据） */
function cssRuleBody(selector: string): string {
  const at = CSS.indexOf(`${selector} {`);
  expect(at, `styles.css 里找不到规则 ${selector}`).toBeGreaterThan(-1);
  const end = CSS.indexOf("}", at);
  return CSS.slice(at, end);
}

/**
 * 剥掉 CSS 注释（保留换行，行号不错位）。
 *
 * ⚠️ **必要**：本项目注释里**大量引用真实选择器**（例如"原来 `.sp-search-input { outline: none }`
 * 压不住"这种说明），直接 `indexOf` 选择器会命中**注释里那句话**，
 * 切出来的"规则体"是注释片段 ⇒ 断言莫名其妙地失败（第 199 轮实测踩到）。
 * `ui-audit` 的扫描器同样先剥注释再匹配 —— 这里与它保持一致。
 */
function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
}

describe("SEARCHMOVE-198 设置搜索框移到标题栏中间", () => {
  it("SEARCHMOVE-198-1 搜索框在标题栏里，且排在左侧栏**之前**", () => {
    const headerAt = PANEL.indexOf('className="settings-header"');
    const sidebarAt = PANEL.indexOf('className="settings-sidebar"');
    const searchAt = PANEL.indexOf('settings-search-box--in-header');
    expect(headerAt, "找不到 .settings-header").toBeGreaterThan(-1);
    expect(sidebarAt, "找不到 .settings-sidebar").toBeGreaterThan(-1);
    expect(searchAt, "找不到搬过去之后的搜索框（--in-header）").toBeGreaterThan(-1);
    /* 在标题栏区间内 */
    const headerEnd = PANEL.indexOf("settings-body", headerAt);
    expect(searchAt, "搜索框不在标题栏区间里").toBeGreaterThan(headerAt);
    expect(searchAt, "搜索框不在标题栏区间里").toBeLessThan(headerEnd);
    /* 且在左侧栏之前（左侧栏属于 body） */
    expect(searchAt, "搜索框应当出现在左侧栏之前").toBeLessThan(sidebarAt);
  });

  it("SEARCHMOVE-198-2 ★左侧栏里不再有搜索框（防止搬不干净或被放回去）", () => {
    const sidebarAt = PANEL.indexOf('className="settings-sidebar"');
    const contentAt = PANEL.indexOf('className="settings-content"', sidebarAt);
    expect(contentAt, "找不到 settings-content 作为侧栏结束锚点").toBeGreaterThan(sidebarAt);
    const sidebarBlock = PANEL.slice(sidebarAt, contentAt);
    expect(sidebarBlock, "左侧栏里仍然有搜索框").not.toContain("settings-search-box");
    expect(sidebarBlock, "左侧栏里仍然有搜索输入框").not.toContain("sp-search-input");
    expect(sidebarBlock, "左侧栏里仍然有搜索占位符").not.toContain("搜索设置...");
  });

  it("SEARCHMOVE-198-3 搜索的**功能**没被搬丢（输入、清空、匹配提示都还在）", () => {
    /* 搬家最容易出的错是"把元素挪了、把状态或回调漏了"。逐条钉住。 */
    expect(PANEL, "缺 value 绑定").toMatch(/value=\{settingsSearch\}/);
    expect(PANEL, "缺 onChange 绑定").toMatch(/onChange=\{\(e\) => setSettingsSearch\(e\.target\.value\)\}/);
    expect(PANEL, "缺清空按钮").toMatch(/onClick=\{\(\) => setSettingsSearch\(""\)\}/);
    expect(PANEL, "缺匹配结果提示").toMatch(/sp-search-status/);
    /* 自动跳到第一个匹配分组的副作用也必须在 */
    expect(PANEL, "缺「搜索后自动跳到首个匹配分组」的副作用").toMatch(/if \(first && first !== activeTab\) setActiveTab\(first as any\)/);
  });

  it("SEARCHMOVE-198-4 样式走 `--in-header` 那一支，且用**存在**的令牌定高", () => {
    const body = cssRuleBody(".settings-search-box--in-header");
    /* 弹性撑开 + 上限 + min-width:0（防长占位符把容器撑破） */
    expect(body, "应当是 flex:1 撑开").toMatch(/flex:\s*1/);
    expect(body, "应当有 max-width 上限（否则会把 ✕ 挤出去）").toMatch(/max-width:\s*520px/);
    expect(body, "缺 min-width: 0（flex 项经典坑）").toMatch(/min-width:\s*0/);
    /* 输入框定高只能用**真实存在**的令牌：写不存在的令牌会让 height 整条失效。
       ⚠️ 我第一版就写了 `--control-sm` —— 本项目里没有这个令牌（只有 --control-std
       与 --control-std-compact），框会塌成 0 高。这条断言就是把那一类错钉住。 */
    const inputRule = CSS.slice(CSS.indexOf(".settings-search-box--in-header .sp-search-input"));
    const heightDecl = inputRule.slice(0, inputRule.indexOf("}"));
    const token = heightDecl.match(/height:\s*var\((--[a-z0-9-]+)\)/);
    expect(token, "输入框高度应当走 var(--control-*) 令牌").toBeTruthy();
    expect(CSS, `令牌 ${token?.[1]} 在 styles.css 里没有定义`).toContain(`${token?.[1]}:`);
  });

  it("SEARCHMOVE-198-5 反向守卫：`--bordered` 那支已删除（死规则不许留）", () => {
    /* 搜索框搬走后 `--bordered` 没有调用方了；留着就是一条死规则。 */
    expect(PANEL, "TSX 里不该再有 --bordered").not.toContain("settings-search-box--bordered");
    expect(CSS, "styles.css 里不该还有 --bordered 的规则体").not.toMatch(/^\.settings-search-box--bordered\s*\{/m);
  });
});

/**
 * SEARCHRING-199：**搜索框的焦点环必须收在搜索区内**（第 199 轮）
 *
 * ## 用户现场
 * 「搜索设置内的紫色编辑框太大，都超过搜索设置的外边区域了。」
 *
 * ## 成因（用 CDP `CSS.getMatchedStylesForNode` 读出来的，不是推断）
 * 全局 `codem-ui.css` 里那条
 * `button:focus-visible, a:focus-visible, input:focus-visible, … { outline: 2px solid var(--accent); outline-offset: 2px }`
 * 特异度 **(0,1,1)**，作用在**输入框本身** ⇒ 环画在输入框盒**之外 4px**。
 * 装机版实测：输入框 478×38 ⇒ 环外沿 486×**46**，而搜索行只有 520×**42**
 * ⇒ 横向被左右 padding(8px) 兜住，**纵向兜不住，上下各溢出 2px**。
 * （这也解释了为什么"给它写 `outline: none`"没用：`.sp-search-input` 是 (0,1,0)，
 *   压不住 (0,1,1)。**我先后试过 `outline: none` 与 `outline-width: 0`，实测都被它盖过去。**）
 *
 * ## 修法
 * 环从输入框挪到**搜索行**、并改成 `inset`（画在盒内）⇒ 几何上不可能溢出。
 * 装机版实测结果：`input outline-width = 0px`，`.sp-search` 得到
 * `rgb(101,85,224) 0px 0px 0px 2px inset`。
 */
describe("SEARCHRING-199 搜索框焦点环收在搜索区内", () => {
  it("SEARCHRING-199-1 环画在搜索行上、且是 inset（几何上不越界）", () => {
    const at = CSS.indexOf(".sp-search:has(.sp-search-input:focus-visible)");
    expect(at, "找不到搜索行的焦点环规则").toBeGreaterThan(-1);
    const body = CSS.slice(at, CSS.indexOf("}", at));
    expect(body, "环必须是 inset（否则又画到盒外去了）").toMatch(/box-shadow:\s*inset/);
    expect(body, "环应当用品牌色令牌").toMatch(/var\(--accent\)/);
  });

  it("SEARCHRING-199-2 ★触发条件必须是 :focus-visible，不是 :focus-within", () => {
    /* 与第 187 轮给输入区定下的规矩一致：**只有键盘可见焦点才亮环**，鼠标点进来不亮。 */
    expect(CSS, "找不到 :has(:focus-visible) 的触发条件").toMatch(
      /\.sp-search:has\(\.sp-search-input:focus-visible\)/,
    );
    expect(CSS, "不该出现 .sp-search:focus-within 这种写法").not.toMatch(/\.sp-search:focus-within/);
  });

  it("SEARCHRING-199-3 ★输入框那圈必须用 `!important` 按掉（普通声明压不住全局规则）", () => {
    /**
     * ⚠️ 必须先**剥掉注释**再找规则 —— 我第一版直接 `CSS.indexOf(".sp-search-input {")`，
     * 结果命中的是**注释里那句话**（「`.sp-search-input { outline: none }` 特异度不够」），
     * 于是切出来的"规则体"是注释片段、断言当然失败。**注释里提到选择器是常事，
     * 校验必须针对真实规则。**
     */
    const clean = stripCssComments(CSS);
    const at = clean.indexOf(".sp-search-input {");
    expect(at, "找不到 .sp-search-input 规则").toBeGreaterThan(-1);
    const body = clean.slice(at, clean.indexOf("}", at));
    /* 全局那条是 (0,1,1)，`.sp-search-input` 只有 (0,1,0) ⇒ 必须 !important。 */
    expect(body, "输入框的 outline 归零必须带 !important").toMatch(/outline-width:\s*0\s*!important/);
    expect(body, "不该写成 outline: none（语义过宽，且会踩 focus-outline-none 门禁）")
      .not.toMatch(/outline:\s*none/);
    /**
     * ★ **第 200 轮补的这条**：光按掉 `outline` **不够**。
     * 本文件里还有一条全局文本输入规则：
     *   `input:focus-visible, textarea:focus-visible, [contenteditable=true]:focus-visible {
     *      outline: none; box-shadow: 0 0 0 var(--focus-ring-width) var(--focus-ring-color) }`
     * 它画的是 **box-shadow 环**。只关 outline 时，输入框上仍留着那圈 box-shadow，
     * 与搜索行的内嵌环叠成**两个紫框** —— 用户第 200 轮反馈的正是这个
     * （「出现了两个紫色边框，其中一个包裹住整个块」）。
     * ⇒ **"关掉焦点环"必须把 outline 与 box-shadow 两条通道一起关。**
     */
    expect(body, "输入框的 box-shadow 也必须按掉（否则还剩第二个紫框）")
      .toMatch(/box-shadow:\s*none\s*!important/);
  });

  it("SEARCHRING-199-4 替代环不许丢（键盘用户必须看得见焦点）", () => {
    /* "抑制 outline"唯一正当的前提：别处给了可见的替代环。
       若有人删掉那条 :has 规则、只留 !important 抑制 ⇒ 键盘焦点会**彻底不可见**。 */
    const clean = stripCssComments(CSS);
    const hasRing = /\.sp-search:has\(\.sp-search-input:focus-visible\)\s*\{[^}]*box-shadow:\s*inset/.test(clean);
    expect(hasRing, "按掉了输入框的环，就必须在搜索行上补一个 inset 环").toBe(true);
  });

  it("SEARCHRING-199-5 ★上面那条压制的前提仍在（那条全局 box-shadow 环确实存在）", () => {
    /* 这条判据的**理由**：本文件里真有一条给文本输入画 box-shadow 环的全局规则。
       若哪天它被删了/改了，`.sp-search-input` 上那两条 !important 就可以简化甚至去掉 ——
       让它红，提醒重看，而不是留一条"理由已经消失"的压制。 */
    const clean = stripCssComments(CSS);
    expect(
      clean,
      "styles.css 里那条 `input:focus-visible … box-shadow: 0 0 0 var(--focus-ring-width)` 不在了 —— " +
        "请重新评估 .sp-search-input 上那两条 !important 压制是否还需要",
    ).toMatch(/input:focus-visible[\s\S]{0,260}box-shadow:\s*0 0 0 var\(--focus-ring-width\)/);
  });
});
