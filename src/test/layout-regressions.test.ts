/**
 * LAYOUT-REG：把「挤压 / 竖排 / 静默裁切」这三类排版事故钉成源码判据（第 8 轮）。
 *
 * ## 为什么要有这一层（之前为什么漏）
 *
 * 第 7 轮之前的「深度排查」= `tools/ui-audit/scan-ui.mjs`（源码级 token 扫描）
 * + `_crawl.mjs`（运行时 console 错误 / 死点击 / 空白浮层）。
 * 两者**都不量排版**：`grid-template-columns: repeat(auto-fill, minmax(48px, max-content))`
 * 在源码里是"合法样式"，在运行时也不报错、不溢出控制台 —— 但真机上它会把一行状态条
 * 拆成 23 条 40px 的窄列，计数竖排成 1/0/6/0/0（用户截图就是这个）。
 *
 * 所以补两层：
 * 1. **运行时**：`tools/ui-audit/layout-audit.mjs`（CDP 量真实几何，R1..R6 判据）；
 * 2. **源码**（本文件）：把这次查出来的每个根因钉住，防止有人再写回去。
 *
 * 本文件的判据都是「读 CSS/脚本源码 + 结构断言」，不需要跑起来，因此可以进全量测试。
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..");

function walkCss(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walkCss(p, out);
    else if (name.endsWith(".css")) out.push(p);
  }
  return out;
}

const CSS_FILES = [join(ROOT, "src"), join(ROOT, "packages")].flatMap((d) => walkCss(d));

function blockOf(css: string, selector: string): string | null {
  const idx = css.indexOf(selector);
  if (idx < 0) return null;
  const open = css.indexOf("{", idx);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  return null;
}

/** 剥掉 /* … *\/ 注释：本文件的断言是"代码里还有没有这种写法"，注释里的说明不算。 */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, " ");
}
const readCss = (rel: string) => stripComments(readFileSync(join(ROOT, rel), "utf8"));

describe("LAYOUT-REG：挤压/竖排/裁切的根因（第 8 轮）", () => {
  it("LAYOUT-1: 不许再用 `repeat(auto-fill, minmax(<窄>, max-content))` 铺单行工具栏", () => {
    /*
     * 这条形状**只适合"很多等宽小格子、允许换行"**（emoji 选择器、chip 云）。
     * 一旦用在"一行状态条/两栏对齐"上，auto-fill 会铺出几十条空列，每个子项各占一格 ⇒
     * 挤压/竖排。L1 就是真机那次（`.lo-task__bar` 23 列、竖排 1/0/6/0/0）。
     *
     * 允许清单里的三处都是"很多小格子"的语义；新增必须在这里写明理由。
     */
    const allow = [".identity-emoji-grid", ".bootstrap-emoji-grid", ".lo-zone-occupants"];
    const offenders: string[] = [];
    for (const file of CSS_FILES) {
      const css = stripComments(readFileSync(file, "utf8"));
      const ruleRe = /([^{}]+)\{([^}]*)\}/g;
      let m: RegExpExecArray | null;
      while ((m = ruleRe.exec(css))) {
        const selector = m[1].replace(/\s+/g, " ").trim();
        const body = m[2];
        if (!/grid-template-columns\s*:[^;]*auto-fill[^;]*max-content/.test(body)) continue;
        if (allow.some((a) => selector.includes(a))) continue;
        offenders.push(`${file.replace(ROOT + "\\", "").replace(ROOT + "/", "")} → ${selector}`);
      }
    }
    expect(
      offenders,
      "这种 grid 形状会把一行拆成几十条窄列（真机：状态条竖排）。要横排请用 flex；" +
        "要换行的等宽小格子请加进 allow 并写明理由",
    ).toEqual([]);
  });

  it("LAYOUT-2: `.lo-task__bar` 必须是 flex 单行（不是 auto-fill 网格）", () => {
    const body = blockOf(readCss("src/plugins/library-ops/styles/library-ops.css"), ".lo-task__bar {");
    expect(body, "找不到 .lo-task__bar 规则").toBeTruthy();
    expect(body).toContain("display: flex");
    expect(body, "又变回网格 ⇒ auto-fill 会把状态条拆成几十列").not.toContain("grid-template-columns");
    const meta = blockOf(readCss("src/plugins/library-ops/styles/library-ops.css"), ".lo-task__meta {");
    expect(meta, "计数组必须不换行（否则「图标+数字」竖排）").toContain("flex-wrap: nowrap");
  });

  it("LAYOUT-3: `.sp-slider-row` 不许被并进 `.kg-legend` 的 grid 选择器组", () => {
    const css = readCss("src/styles.css");
    /* 找到 .kg-legend 的 grid 规则，检查它的选择器组里没有 .sp-slider-row */
    const legendIdx = css.indexOf(".kg-legend {");
    expect(legendIdx, "找不到 .kg-legend 规则").toBeGreaterThan(-1);
    const selectorStart = css.lastIndexOf("}", legendIdx) + 1;
    const selectorGroup = css.slice(selectorStart, legendIdx);
    expect(
      selectorGroup,
      "把 .sp-slider-row 并进 grid 组 ⇒ 滑块行变成 8 条 96px 轨道，「宠物大小 40%」被折行",
    ).not.toContain(".sp-slider-row");
    const slider = blockOf(css, ".sp-slider-row {");
    expect(slider, "滑块行应保持 flex（标签左、数值右）").toContain("display: flex");
  });

  it("LAYOUT-4: 记忆条目标题单行省略（不再被徽标挤成两行）", () => {
    const css = readCss("src/styles.css");
    const key = blockOf(css, ".memory-item-key {");
    expect(key).toContain("text-overflow: ellipsis");
    expect(key).toContain("min-width: 0");
    const badges = blockOf(css, ".memory-item-badges {");
    expect(badges, "徽标组必须不换行（否则 1280 宽会竖排 3 行）").toContain("flex-wrap: nowrap");
  });

  it("LAYOUT-5: 记忆体检正文用 line-clamp（不许静默裁切）", () => {
    const body = blockOf(readCss("src/styles.css"), ".mc-entry-content {");
    expect(body).toContain("-webkit-line-clamp");
    expect(body, "clamp 之外别再写死 max-height（两套限制会打架）").not.toContain("max-height: 4em");
  });

  it("LAYOUT-6: 用量图表的提示气泡在最左/最右柱子上不许越出卡片", () => {
    const css = readCss("src/styles/codem-ui.css");
    expect(css, "缺第一个柱子的左对齐覆盖").toContain(".usage-chart-bar:first-child .usage-chart-bar-tooltip");
    expect(css, "缺最后一个柱子的右对齐覆盖").toContain(".usage-chart-bar:last-child .usage-chart-bar-tooltip");
  });

  it("LAYOUT-8: 插件卡片的徽标不许换行（名称先省略）", () => {
    const css = readCss("src/styles.css");
    const badge = blockOf(css, ".ofm-compact-badge {");
    expect(badge, "找不到 .ofm-compact-badge 规则").toBeTruthy();
    expect(badge, "徽标会被长名称挤成两行（真机：「外部服/务」）").toContain("white-space: nowrap");
    const name = blockOf(css, ".market-skill-name {");
    expect(name, "名称必须可省略，否则它自己撑破标题行").toContain("text-overflow: ellipsis");
  });

  it("LAYOUT-9: 搜索框是「胶囊 + 裸输入框」：内层不许自带底/高度", () => {
    const v2 = readCss("src/styles/unslop-v2.css");
    expect(
      v2,
      "设置里「所有输入框染 raised 底」的规则必须排除 .sp-search-input（否则底色溢出胶囊边框）",
    ).toContain('input[type="text"]:not(.sp-search-input)');
    const ui = readCss("src/styles/codem-ui.css");
    const input = blockOf(ui, ".settings-side-search .sp-search-input {");
    expect(input, "找不到侧栏搜索输入框规则").toBeTruthy();
    expect(input).toContain("background: transparent");
    expect(input, "高度必须跟随胶囊（30px），否则会从胶囊里溢出来").toContain("height: 100%");
    const pill = blockOf(ui, ".settings-side-search {");
    expect(pill, "胶囊自身要裁掉溢出（双保险）").toContain("overflow: hidden");
  });

  it("LAYOUT-10: 卡片型按钮不许被「统一 28px 高」压扁（两条规则都要排除）", () => {
    const v2 = readCss("src/styles/unslop-v2.css");
    /* 两处 blanket 规则：设置面板 / 弹窗+任务中心。少排一处，那一处的卡片就会被压扁 */
    const settingsRule = /\[data-ui="v2"\] \.settings-panel :is\(button, \.btn\)[^{]*\{/.exec(v2)?.[0] ?? "";
    const modalRule = /\[data-ui="v2"\] :is\(\.modal-panel, \.modal-editor, \.search-dialog, \.task-center-panel\) :is\(button, \.btn\)[^{]*\{/.exec(v2)?.[0] ?? "";
    expect(settingsRule, "找不到设置面板的按钮高度规则").not.toBe("");
    expect(modalRule, "找不到弹窗/任务中心的按钮高度规则").not.toBe("");
    for (const cls of [".sp-mode-btn", ".skin-card", ".lo-session-card", ".lo-scene-option"]) {
      expect(settingsRule, `设置面板按钮规则必须排除卡片 ${cls}`).toContain(`:not(${cls})`);
      expect(modalRule, `弹窗按钮规则必须排除卡片 ${cls}（任务中心里的卡片属于这一条）`).toContain(`:not(${cls})`);
    }
  });

  it("LAYOUT-11: 带文字的「新建」按钮不许套用正方形图标按钮尺寸", () => {
    const v2 = readCss("src/styles/unslop-v2.css");
    const square = blockOf(v2, '[data-ui="v2"] .market-skill-link-btn:not(.agent-new-btn) {');
    expect(square, "正方形只应用于纯图标按钮").toBeTruthy();
    expect(square).toContain("width: 28px");
    const text = blockOf(v2, '[data-ui="v2"] .agent-new-btn {');
    expect(text, "带文字的按钮宽度必须按内容走").toContain("width: auto");
  });

  it("LAYOUT-12: 记忆管理器整页可滚，列表区有明确高度（不许被压成 0）", () => {
    const css = readCss("src/styles.css");
    const root = blockOf(css, ".memory-manager {");
    expect(root).toContain("flex-direction: column");
    expect(root, "管理器必须可纵向滚动（内容比弹窗高）").toContain("overflow-y: auto");
    const content = blockOf(css, ".memory-content {");
    expect(content, "列表区必须有明确高度（原来 flex:1 被挤成 0）").toContain("height: clamp(");
    expect(content, "列表区不许再靠 flex:1 抢高度").toContain("flex: 0 0 auto");
  });

  it("LAYOUT-7: 运行时布局审计工具必须在仓库里（否则这一类问题只能靠肉眼）", () => {
    const tool = readFileSync(join(ROOT, "tools/ui-audit/layout-audit.mjs"), "utf8");
    for (const rule of ["R1", "R2", "R3", "R4"]) {
      expect(tool, `布局审计缺少 ${rule} 判据`).toContain(`push("${rule}"`);
    }
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    expect(pkg.scripts["audit:layout"], "npm 脚本必须能直接跑起来").toContain("layout-audit.mjs");
  });
});
