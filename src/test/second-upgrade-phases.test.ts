/**
 * 二次升级 Phase A/D/E/F 的收尾判据（第 233 轮 · 一次做完）。
 *
 * 这四条都是**视觉/布局契约**：没有交互可驱动，只能钉"生效的 CSS 声明 + 令牌口径"，
 * 再把"字体族不许动"这条硬约束一起钉住（用户明确要求）。
 *
 * | # | 阶段 | 行为 |
 * |---|---|---|
 * | PHASE-A-1 | A 收尾 | 正文滚动容器保留滚动条位置（`scrollbar-gutter: stable`），消除 11px 抖动 |
 * | PHASE-D-1 | D | 设置页卡片标题统一 13px/600（走令牌，不写字面值） |
 * | PHASE-D-2 | D | 窄容器（≤520px）行式设置回退单列，控件拉满宽度 |
 * | PHASE-E-1 | E | 移除 `text-rendering: optimizeLegibility`（与参考实现仅 antialiased 对齐） |
 * | PHASE-E-2 | E | **字体族一律不动**：全仓 `font-family` 声明只许用令牌/系统栈，不许出现新字体名 |
 * | PHASE-F-1 | F | 右栏允许 480 宽档时不挤正文：聊天区最小宽度为 0（flex 溢出保护） |
 *
 * 变异自证：删掉 `scrollbar-gutter` ⇒ PHASE-A-1 红；把标题改回 `--fs-base` ⇒ PHASE-D-1 红；
 * 加一行 `text-rendering: optimizeLegibility` ⇒ PHASE-E-1 红。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..");
const css = readFileSync(join(ROOT, "src/styles.css"), "utf8");
const codemUi = readFileSync(join(ROOT, "src/styles/codem-ui.css"), "utf8");
const allCss = css + "\n" + codemUi;

/** 取某个选择器的声明块（顶层） */
function block(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(source)?.[2] ?? "";
}

describe("二次升级 Phase A：滚动条占位", () => {
  it("PHASE-A-1: 正文滚动容器必须预留滚动条位置（stable）", () => {
    const body = block(css, ".chat-body");
    expect(body, "找不到 .chat-body 规则").not.toBe("");
    expect(body, "缺少 scrollbar-gutter ⇒ 有无滚动条时正文左右各差 11px").toMatch(
      /scrollbar-gutter:\s*stable/,
    );
  });

  it("PHASE-A-2: ≤1440 正文列必须与 Composer 同宽（真机实测 770 vs 732 的缺口）", () => {
    // 窄档：容器 max-width 对齐到 reading-column ⇒ 内容列 = reading-column − 2*gutter
    const narrow = [...css.matchAll(/@media \(max-width: 1440px\) \{([\s\S]*?)\n\}/g)]
      .map((m) => m[1])
      .join("\n");
    expect(narrow, "缺少 ≤1440 的正文列宽度对齐").toMatch(
      /\.messages-container\s*\{[^}]*max-width:\s*var\(--reading-column\)/,
    );
    // Composer 在同一档位是 reading-column − 2*gutter（两边必须同一个口径）
    expect(css, "Composer 的窄档口径应包含 reading-column − 2*gutter").toMatch(
      /\.input-area\.input-card-container \{[^}]*max-width:[\s\S]{0,160}?calc\(var\(--reading-column\) - var\(--reading-gutter\) \* 2\)/,
    );
  });
});

describe("二次升级 Phase F：右栏宽档不挤正文", () => {
  it("PHASE-F-2: Composer 的上限也要夹「容器宽 − 2*gutter」（右栏拉宽时不比正文宽）", () => {
    // 真机取证（右栏 428）：正文 642、Composer 712 —— 差 70px，正是这里缺的夹紧
    expect(css, "Composer 的窄档上限必须是 min(阅读列, 容器宽 − 2*gutter)").toMatch(
      /max-width:\s*min\(\s*calc\(var\(--reading-column\) - var\(--reading-gutter\) \* 2\),\s*calc\(100% - var\(--reading-gutter\) \* 2\)\s*\)/,
    );
  });
});

describe("二次升级 Phase D：设置页统一", () => {
  it("PHASE-D-1: 卡片标题统一 13px/600，且走令牌", () => {
    const title = block(css, ".settings-section-title");
    expect(title, "找不到 .settings-section-title").not.toBe("");
    // 13px = --fs-base（--fs-sm 是 12px，真机截图抓到的就是掉这一档）
    expect(title, "标题字号应为 13px（--fs-base）").toMatch(/font-size:\s*var\(--fs-base\)/);
    expect(title, "字重走令牌（600 对应 --weight-bold = 620）").toMatch(/font-weight:\s*var\(--weight-bold\)/);
    expect(title, "不许写死字重").not.toMatch(/font-weight:\s*600/);
  });

  it("PHASE-D-2: 窄容器回退单列（控件拉满）", () => {
    const media = /@media \(max-width: 520px\) \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
    expect(media, "缺少 ≤520px 的窄容器回退").not.toBe("");
    expect(media, "行式设置必须回退单列").toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)/);
    expect(media, "控件必须拉满宽度").toMatch(/width:\s*100%/);
  });
});

describe("二次升级 Phase E：字体与渲染", () => {
  it("PHASE-E-1: 不许再有 text-rendering: optimizeLegibility", () => {
    expect(allCss, "参考实现只有 antialiased；optimizeLegibility 会让字形与它不一致").not.toMatch(
      /text-rendering:\s*optimizeLegibility/,
    );
  });

  it("PHASE-E-2（硬约束）: 字体族只有既有那几处，没有新增字体名", () => {
    /*
     * `@font-face { font-family: 'AlimamaFangYuanTi' }` 是**定义**自带字体（不是"使用某个字体族"），
     * 它不属于"改字体族"这条约束的对象 ⇒ 先剥掉 @font-face 块再扫使用处。
     */
    const usageOnly = allCss.replace(/@font-face\s*\{[^}]*\}/g, "");
    const families = [...usageOnly.matchAll(/font-family:\s*([^;]+);/g)].map((m) => m[1].trim());
    expect(families.length, "字体族声明数量异常（可能被整体删掉了）").toBeGreaterThan(0);
    const allowed = /var\(--font|inherit|system-ui|-apple-system|BlinkMacSystemFont|"Segoe UI"|Segoe UI|sans-serif|monospace|ui-monospace|JetBrains Mono|Cascadia|Consolas|Menlo|Monaco|"Courier New"|monospace|"Microsoft YaHei"|"PingFang SC"|"Hiragino Sans GB"|"Noto Sans SC"|"Source Han Sans|Source Han Sans|"Helvetica Neue"|Helvetica|Arial|"WenQuanYi|WenQuanYi|"Sarasa|Sarasa|emoji|Emoji|Symbol|serif/i;
    const offenders = families.filter((f) => !allowed.test(f));
    expect(offenders, `出现了未登记的字体族（不许改字体族）：${offenders.join(" | ")}`).toEqual([]);
  });
});

describe("二次升级 Phase F：右栏宽档不挤正文", () => {
  it("PHASE-F-1: 聊天区允许收缩到 0（防 flex 溢出把正文挤扁）", () => {
    const panel = block(css, ".chat-panel");
    expect(panel, "找不到 .chat-panel").not.toBe("");
    // flex 子项默认 min-width:auto ⇒ 右栏拉到 480 时正文会被撑破；必须显式 0
    expect(panel, "缺少 min-width: 0").toMatch(/min-width:\s*0/);
  });
});
