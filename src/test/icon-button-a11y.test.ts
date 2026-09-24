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
 * 棘轮基线：**第 91 轮的实测值 0**。
 *
 * 历史（每一档都是「修掉一批 + 必要时更正工具」）：
 * - 第 84 轮：修完 39 处（图标关闭按钮 31 + 折叠侧栏 8）后基线 **156**；
 * - 第 85 轮：又修 10 处，并**更正第三类误报** —— `{isZh ? "选择文件" : "Choose File"}` 这类
 *   **会渲染出文字**的表达式原来被当成「没有文字」⇒ 156 里含 95 处误报；
 * - 第 86 轮：基线 **51**（修完 10 处之后）；
 * - 第 91 轮（本轮）：把 O-4 剩下的全部修完，并**更正第四类误报** ——
 *   ① `{item.title}` / `{S.ollama.save[lang]}` 这类**非字面量表达式**同样会渲染文字；
 *   ② `{a === b ? <><Clock size={12}/> 恢复中...</> : …}` 这类**嵌套花括号**里的字面量
 *      被 `/\{[^}]*\}/g` 在第一个 `}` 处截断而扫不到。
 *   两类合计 **39 处误报**（报 51，真问题 12）—— 给这些「本来就有可见文字」的按钮加 `aria-label`
 *   会**盖掉**读屏要念的文字，是负优化，所以那 39 处一律不动、只修真的 12 处。
 *   现在**基线 = 0**：新写的图标按钮没有可访问名会直接红。
 */
const NAMELESS_ICON_BUTTON_BASELINE = 0;

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
  it("A11Y-ICON-5: **非字面量表达式**会渲染文字 ⇒ 不许被当成「只有图标」（第 91 轮更正的误报）", () => {
    /*
     * 现场：NewChatPage 的建议卡片按钮内容是「图标 + {item.title} + {item.desc}」，
     * 它**明明有可见文字**（只是文字来自变量），旧判据只看字面量 ⇒ 被报成无名图标按钮。
     * 这类按钮加 aria-label 会**盖掉**读屏本来要念的文字，属于负优化。
     */
    const withVar = `<button className="new-chat-suggestion" onClick={() => pick(item.prompt)}>
  <Icon size={20} className="new-chat-suggestion-icon" />
  <div className="new-chat-suggestion-body">
    <span className="new-chat-suggestion-title">{item.title}</span>
  </div>
</button>`;
    const t1 = buttonTags(withVar);
    expect(isIconOnlyBody(withVar, t1[0].end), "文字来自变量（{item.title}）也算有文字 ⇒ 不许报").toBe(false);

    // 反向：表达式整体是 JSX（播放/暂停那种）且没有字面量 ⇒ 仍然要报
    const iconSwitch = `<button onClick={togglePlay}><Check size={14} />{playing ? <Pause size={16} /> : <Play size={16} />}</button>`;
    const t2 = buttonTags(iconSwitch);
    expect(isIconOnlyBody(iconSwitch, t2[0].end), "整段都是 JSX 图标 ⇒ 只有图标，必须报").toBe(true);
  });

  it("A11Y-ICON-6: 嵌套花括号里的字面量也是文字（第 91 轮更正的误报）", () => {
    /*
     * 现场：SessionRecovery / SnapshotPanel 的按钮内容是
     * 「{recovering === id ? <><Clock size={12} /> 恢复中...</> : <><Undo size={12} /> 恢复此会话</>}」，
     * 里面有两个可见文字，但 /\{[^}]*\}/g 会在 size={12} 的 } 处截断，
     * 于是外层表达式根本没被扫到 ⇒ 误报成「无名图标按钮」。
     */
    const ternary = `<button className="session-recover-btn" onClick={() => handleRecover(id)}>
  {recovering === id ? <><Clock size={12} /> 恢复中...</> : <><Undo size={12} /> 恢复此会话</>}
</button>`;
    const t1 = buttonTags(ternary);
    expect(isIconOnlyBody(ternary, t1[0].end), "嵌套花括号里的字面量必须算文字 ⇒ 不许报").toBe(false);
  });
});
