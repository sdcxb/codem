/**
 * 图标按钮的可访问名（第 84 轮）
 *
 * ## 现场（走查 + 静态审计两条线交叉出来的）
 *
 * 走查用**修好之后**的度量（认得 `img[alt]` / `aria-labelledby`）重跑 152 个入口，
 * 报出 8 个面板有"无名按钮"，逐个看 HTML 只有三处：`.settings-close`、`.notebook-close-btn`、
 * `.session-recovery-close` —— 全是**纯图标关闭按钮**。
 * 于是补了一条**静态**规则去全仓扫（走查只能看到它点到过的那些状态），
 * 结果真实规模远大于三处。
 *
 * ## 两个"工具自己在说谎"的坑（都踩过，都写进注释）
 *
 * 1. 规则第一版拿**整个属性区**测 `/close/i` ⇒ `onClick={onClose}` 也算"close"，
 *    一次匹配 41 个按钮（其中一些是写着"取消"的文字按钮，贴 `aria-label="关闭"` 会**覆盖它的名字**）。
 *    ⇒ 必须只看 **className 的值**，并且要求内容是**图标**（动态 `{children}` 一律不报）。
 * 2. 属性区原来用非贪婪正则 `<button\b([\s\S]*?)>` 截取 —— 而 `onClick={() => …}` 里的 `=>` 带 `>`，
 *    正则在箭头函数处就截断 ⇒ 属性不完整、内容从半截开始 ⇒ **大量漏报**
 *    （当时报 55 处，按正确的标签扫描是 **195 处**）。现在按字符扫描（跳过引号、跟踪花括号深度）。
 *    A11Y-ICON-4 就是钉这一条的。
 *
 * ## 判据
 *
 * | 编号 | 判据 | 严格度 |
 * | --- | --- | --- |
 * | A11Y-ICON-1 | `className` 含 `close` 的图标按钮**必须**有可访问名 | 严格（= 0） |
 * | A11Y-ICON-2 | 折叠侧栏的 `.sidebar-rail-btn` **必须**有可访问名（Tooltip 不算） | 严格（= 0） |
 * | A11Y-ICON-3 | 其余无名图标按钮总数**只许降不许升**（棘轮，基线见常量） | 棘轮 |
 * | A11Y-ICON-4 | 扫描器必须认得带 `onClick={() => …}` 的按钮（否则又是那个漏报） | 反向对照 |
 */

import { describe, it, expect } from "vitest";
import {
  scanNamelessIconButtons,
  buttonTags,
  classNameOf,
  isIconOnlyBody,
} from "../../tools/ui-audit/icon-button-scan.mjs";

const ROOT = process.cwd();

/**
 * 棘轮基线：**修完 39 处之后**的实测值（第 84 轮）。
 *
 * - 修的是：**全部图标关闭按钮（31 处）** + **折叠侧栏的图标条（8 处）**；
 * - 剩下的是需要**逐个看语义**才能起名的（每个组件的图标按钮含义不同，机械补名字就是造假），
 *   已登记在 `docs/GAP-LIST.md` 的 O-4 里，清单用
 *   `node .preview-shot/audit-icon-buttons.mjs` 随时可打印；
 * - **只许降不许升**：新写的图标按钮忘了名字会让这条红。
 */
const NAMELESS_ICON_BUTTON_BASELINE = 156;

describe("图标按钮的可访问名（第 84 轮）", () => {
  const findings = scanNamelessIconButtons(ROOT);

  it("A11Y-ICON-1: 关闭类图标按钮必须都有可访问名（严格 = 0）", () => {
    const bad = findings.filter((f) => /close/i.test(f.cls));
    expect(
      bad,
      `这些关闭按钮没有可访问名（读屏只念"按钮"）：\n  - ${bad.map((b) => `${b.rel}:${b.line} ${b.cls}`).join("\n  - ")}`,
    ).toEqual([]);
  });

  it("A11Y-ICON-2: 折叠侧栏的图标条必须有可访问名（Tooltip 不算名字）", () => {
    const bad = findings.filter((f) => /sidebar-rail-btn/.test(f.cls));
    expect(
      bad,
      `折叠侧栏的图标按钮没有可访问名（读屏不念 tooltip）：\n  - ${bad.map((b) => `${b.rel}:${b.line}`).join("\n  - ")}`,
    ).toEqual([]);
  });

  it("A11Y-ICON-3: 其余无名图标按钮总数只许降不许升（棘轮）", () => {
    const rest = findings.filter((f) => !/close/i.test(f.cls) && !/sidebar-rail-btn/.test(f.cls));
    expect(
      rest.length,
      `无名图标按钮从 ${NAMELESS_ICON_BUTTON_BASELINE} 涨到 ${rest.length} —— 新写的图标按钮要带 aria-label。` +
        `\n（清单：node .preview-shot/audit-icon-buttons.mjs）` +
        `\n前三处：${rest.slice(0, 3).map((r) => `${r.rel}:${r.line}`).join(" / ")}`,
    ).toBeLessThanOrEqual(NAMELESS_ICON_BUTTON_BASELINE);
    if (rest.length < NAMELESS_ICON_BUTTON_BASELINE) {
      console.log(`[a11y] 无名图标按钮降到 ${rest.length}（基线 ${NAMELESS_ICON_BUTTON_BASELINE}）—— 请把基线收紧。`);
    }
  });

  it("A11Y-ICON-4: 扫描器必须认得带箭头函数的按钮（第一版就在这漏报）", () => {
    /*
     * 这条是**给扫描器本身**的判据：`onClick={() => …}` 里的 `>` 会把朴素正则截断，
     * 于是属性区不完整、内容区错位 ⇒ 那个按钮被当成"有文字"而漏报。
     * 反向对照直接把那种写法喂进来。
     */
    const sample = `<div>
  <button className="x-close" onClick={() => doSomething()}>
    <X size={14} />
  </button>
</div>`;
    const tags = buttonTags(sample);
    expect(tags, "必须只认出一个 button 开始标签").toHaveLength(1);
    expect(classNameOf(tags[0].tag), "属性区必须完整（className 取得到）").toBe("x-close");
    expect(isIconOnlyBody(sample, tags[0].end), "内容只有图标 ⇒ 必须判为图标按钮（第一版在这里漏报）").toBe(true);

    // 有可见文字的按钮不能被算成"图标按钮"
    const textBtn = `<button className="x-close" onClick={() => f()}>\n  取消\n</button>`;
    const t2 = buttonTags(textBtn);
    expect(isIconOnlyBody(textBtn, t2[0].end), "有可见文字的按钮不许被判成图标按钮").toBe(false);
  });
});
