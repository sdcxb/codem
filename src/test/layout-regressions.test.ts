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

  it("LAYOUT-13: 会裁切的容器里，焦点环必须走 inset（不许外扩被裁）", () => {
    const css = readCss("src/styles.css");
    const row = blockOf(css, '.input-tools-left :is(button, [role="button"], [tabindex], input, select):focus-visible {');
    expect(row, "输入工具行的焦点环规则不见了").toBeTruthy();
    expect(row, "外扩环会被 overflow:hidden 的行裁掉 ⇒ 必须 outline:none（并用 !important 压住全局环）").toContain("outline: none !important");
    expect(row).toContain("inset 0 0 0 var(--focus-ring-width)");
    const side = blockOf(css, '.right-sidebar :is(button, [role="tab"], [role="button"], [tabindex], a):focus-visible {');
    expect(side, "右侧栏贴边控件的焦点环规则不见了").toBeTruthy();
    expect(side).toContain("outline: none !important");
    expect(side).toContain("inset 0 0 0 var(--focus-ring-width)");
  });

  it("LAYOUT-14: 皮肤卡说明最多两行（窄窗口折行必须有界）", () => {
    const desc = blockOf(readCss("src/styles.css"), ".skin-card-desc {");
    expect(desc).toBeTruthy();
    expect(desc).toContain("-webkit-line-clamp: 2");
    expect(desc).toContain("line-clamp: 2");
  });

  it("LAYOUT-15: 任务中心统计卡正文超出时要滚动，不许静默裁切", () => {
    const css = readCss("src/plugins/library-ops/styles/library-ops.css");
    const body = /\n\.lo-card--status \.lo-card__body,\r?\n\.lo-card--sessions \.lo-card__body,\r?\n\.lo-card--activity \.lo-card__body \{([^}]*)\}/.exec(css);
    expect(body, "找不到三张统计卡的 body 规则").toBeTruthy();
    expect(body![1], "800×600 实测内容比 320px 高，hidden 会裁掉底部").toContain("overflow-y: auto");
    expect(body![1]).not.toContain("overflow: hidden");
  });

  it("LAYOUT-16: 审计工具必须带状态覆盖（子页签 / hover / focus / 浮层）", () => {
    const tool = readFileSync(join(ROOT, "tools/ui-audit/layout-audit.mjs"), "utf8");
    for (const rule of ["R9", "R12"]) {
      expect(tool, `布局审计缺少 ${rule}`).toContain(`push("${rule}"`);
    }
    for (const rule of ["R10", "R11", "R13"]) {
      expect(tool, `布局审计缺少 ${rule}`).toContain(`rule: '${rule}'`);
    }
    for (const flag of ["SUBSTATES", "HOVER", "FOCUS"]) {
      expect(tool, `状态覆盖开关 ${flag} 不见了`).toContain(`const ${flag} =`);
    }
    expect(tool, "二级页签探测").toContain("collectSubstates");
    expect(tool, "焦点环裁剪探测").toContain("focusRingInfo");
  });

  it("LAYOUT-17: 插件市场卡片的说明两行封顶（窄卡不折成三行）", () => {
    const note = blockOf(readCss("src/styles.css"), ".market-skill-meta--note {");
    expect(note, "缺 .market-skill-meta--note 规则").toBeTruthy();
    expect(note).toContain("-webkit-line-clamp: 2");
    expect(note).toContain("line-clamp: 2");
    const footer = blockOf(readCss("src/styles.css"), ".market-skill-card-footer {");
    expect(footer, "页脚必须允许换行（否则 meta 被按钮挤成两行）").toContain("flex-wrap: wrap");
  });

  it("LAYOUT-18: 任务中心设置区：操作按钮与小节标题不许折字", () => {
    const css = readCss("src/plugins/library-ops/styles/library-ops.css");
    const actions = blockOf(css, ".lo-settings__actions {");
    expect(actions, "缺 .lo-settings__actions").toBeTruthy();
    expect(actions).toContain("flex-wrap: wrap");
    expect(css, "操作按钮文字必须不折").toMatch(/\.lo-settings__actions > \.lo-btn \{ white-space: nowrap; \}/);
    const title = blockOf(css, ".lo-section-title {");
    expect(title).toContain("flex-wrap: wrap");
    const hint = blockOf(css, ".lo-section-title__hint {");
    expect(hint).toContain("white-space: nowrap");
  });

  it("LAYOUT-19: 中文小节标题不许带西文大写字距", () => {
    const nb = readCss("src/styles/notebook-workspace.css");
    const label = blockOf(nb, ".nb-section-label {");
    expect(label, "缺 .nb-section-label").toBeTruthy();
    expect(label, "中文小节标签不该有 letter-spacing（10px + 0.5px 会显得松散）").not.toContain("letter-spacing");
  });

  it("LAYOUT-20: 不许出现「悬空选择器列表」（顶层逗号 + 段落横幅注释 + 下一条规则）", () => {
    // 第 13 轮静态分析实测三处：段落操作条 / 三个 0 引用按钮类 / pet-window-mode，
    // 都因「顶层选择器列表尾部逗号 + 紧跟段落横幅注释」把下一条规则的样式并进了自己。
    // 只扫大括号深度 0 的逗号（声明值里的逗号不算，避免 box-shadow 多值误报）。
    const offenders: string[] = [];
    for (const file of CSS_FILES) {
      const css = readFileSync(file, "utf8");
      let depth = 0;
      for (let i = 0; i < css.length; i++) {
        const ch = css[i];
        if (ch === "/" && css[i + 1] === "*") {
          const end = css.indexOf("*/", i + 2);
          i = end < 0 ? css.length : end + 1;
          continue;
        }
        if (ch === "{") { depth++; continue; }
        if (ch === "}") { depth = Math.max(0, depth - 1); continue; }
        if (ch !== "," || depth !== 0) continue;
        let j = i + 1;
        while (j < css.length && /\s/.test(css[j])) j++;
        if (!css.startsWith("/*", j)) continue;
        const end = css.indexOf("*/", j);
        const comment = css.slice(j, end + 2);
        if (/^\/\*\s*=/.test(comment)) {
          const line = css.slice(0, i).split("\n").length;
          offenders.push(`${file.replace(ROOT + "\\", "").replace(ROOT + "/", "")}:${line}`);
        }
      }
    }
    expect(offenders, "尾部逗号后跟段落横幅注释 ⇒ 下一条规则会被并入这组选择器").toEqual([]);
  });

  it("LAYOUT-21: 会裁切的容器内统一 inset 焦点环（含 !important 压过全局环）", () => {
    const css = readCss("src/styles.css");
    const rule = css.match(/\:is\(\.chat-body[^{]*\{[^}]*\}/);
    expect(rule, "缺「裁切容器内统一 inset 环」这条策略").toBeTruthy();
    for (const cls of [".chat-body", ".settings-body", ".modal-editor", ".task-center-panel", ".notebook-manager", ".terminal-drawer"]) {
      expect(rule![0], `策略里必须包含 ${cls}`).toContain(cls);
    }
    expect(rule![0]).toContain("outline: none !important");
    expect(rule![0]).toContain("inset 0 0 0 var(--focus-ring-width)");
  });

  it("LAYOUT-22: 全局兜底环 (0,3,0) 之下，各组件的 inset 环必须带 !important", () => {
    const css = readCss("src/styles.css");
    /* 直接按「规则 + 其后 300 字符内出现 outline: none !important」断言，避免 continue 式静默通过 */
    const checks: Array<[string, string]> = [
      ["workspace-tabs 组", "\\.workspace-tabs > \\*:focus-visible,"],
      ["kg-node", "\\.kg-node:focus-visible \\{"],
      ["sidebar-user-me", "\\.sidebar-user-me--clickable:focus-visible \\{"],
    ];
    for (const [name, re] of checks) {
      const m = new RegExp(re + "[\\s\\S]{0,400}?outline: none !important").exec(css);
      expect(m, `${name} 的 outline:none 不带 !important（会被全局环盖过，外扩环再被容器裁掉）`).toBeTruthy();
    }
    const ppt = readCss("src/components/ppt/ppt-editor.css");
    expect(ppt).toMatch(/\.ppt-slide-canvas:focus-visible \{[\s\S]{0,120}?outline: none !important/);
    const ui = readCss("packages/ui/src/ui.css");
    expect(ui).toMatch(/\.file-entry:focus-visible \{[\s\S]{0,120}?outline: none !important/);
  });

  it("LAYOUT-23: 有选中环的元素用「内嵌 outline」画焦点，不许顶掉 box-shadow", () => {
    const css = readCss("src/styles.css");
    const block = blockOf(css, ".skin-card:focus-visible,");
    expect(block, "缺皮肤卡/项目按钮的焦点规则").toBeTruthy();
    expect(block).toContain("outline: var(--focus-ring-width) solid var(--focus-ring-color) !important");
    expect(block).toContain("outline-offset: calc(-1 * var(--focus-ring-width)) !important");
    /* 统一 inset 策略必须排除搜索框（胶囊已有 :has 环）与这两类（active 用 box-shadow） */
    const wide = /:is\([^)]*settings-body[^{]*\{/.exec(css)?.[0] ?? "";
    for (const cls of [".sp-search-input", ".skin-card", ".sidebar-project-btn"]) {
      expect(wide, `统一策略必须排除 ${cls}（否则会覆盖其 box-shadow/形成双环）`).toContain(`:not(${cls})`);
    }
  });

  it("LAYOUT-24: 审计工具支持「同类多实例」模式（按文本长度/disabled 再分变体）", () => {
    const tool = readFileSync(join(ROOT, "tools/ui-audit/layout-audit.mjs"), "utf8");
    expect(tool, "缺 --multi 开关").toContain("const MULTI =");
    expect(tool, "hover/focus 的 key 必须带变体").toContain("multiVariants");
    expect(tool, "收集器必须把 multi 传进页面").toContain("JSON.stringify(MULTI)");
    expect(tool, "变体必须考虑 disabled、文本长度档与宽度档").toMatch(/txt\.length >= 14[\s\S]{0,160}\(el\.disabled \? "d" : "e"\)[\s\S]{0,200}r\.width >= 220/);
  });

  it("LAYOUT-25: 真实模型场景必须覆盖 审批 / 工具错误 / 取消（工具确认失败要留证据）", () => {
    const tool = readFileSync(join(ROOT, "tools/ui-audit/layout-audit.mjs"), "utf8");
    for (const name of ["dialog-tool-error", "dialog-abort", "dialog-tool-confirm"]) {
      expect(tool, `缺场景 ${name}`).toContain(`name: "${name}"`);
    }
    expect(tool, "取消场景必须点 .cancel-btn").toContain(".cancel-btn");
    expect(tool, "工具确认失败要记录证据而不是静默跳过").toContain("no confirmation panel for dangerous command");
    expect(tool, "真实场景必须用真实键盘/发送按钮，不能只靠合成事件").toContain("send-btn:not(.cancel-btn)");
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
