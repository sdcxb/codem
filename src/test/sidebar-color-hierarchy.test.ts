/**
 * ★ 第 185 波（用户报「亮色模式下配色有种廉价感」）：**侧栏的"颜色语义"判据**。
 *
 * ## 用户要的是什么
 *
 * 1. 左侧栏里【MCP、技能、记忆、智能体】那一栏（`.sidebar-tool-row`）：
 *    默认底**灰**，鼠标移上去**紫**（此前是反的：默认淡紫、悬停灰）。
 * 2. 左侧栏里**选中的项目/对话**：图标与文字变**紫**（此前只换底色、文字是主色）。
 *
 * ## 为什么这两条值得判据（而不只是"改个颜色"）
 *
 * 亮色档里 `#6555e0 × 8%` 铺在近白侧栏上就是一层**淡紫**。淡紫在这套配色里本来是
 * "**你正在这里**"的语义色（`.sidebar-rail-btn.active` 的 `--accent-muted`、
 * `.sidebar-session.active` 的 `--accent-muted` 都用它）。让一个**没有选中语义**的分组底
 * 也用淡紫，就把这个语义稀释了 —— 用户感到的"廉价"是这么来的。
 * 所以判据要钉的不是"某个色值"，而是**语义归属**：紫 = 当前/焦点，灰 = 常态。
 *
 * ## 判据写法（吸取第 184 波复审的教训）
 *
 * 复审抓到过"判据与实现互相证明"的假绿（断言'文件里有这行字符串'，把语句罩回条件里照样过）。
 * 这里改成**解析 CSS 规则块、断言块内声明**，并配**反向对照**（未选中态不许是品牌色）
 * 与**结构性对照**（默认底与悬停底必须是两个不同的值 —— 少了这条，"把两者换回去"的变异会漏过）。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CSS = readFileSync(join(process.cwd(), "src", "styles.css"), "utf8").replace(/\r\n/g, "\n");

/** 取出某个**选择器在行首**的规则块内容（`@media` 里的缩进版本与皮肤覆盖不算）。 */
function ruleBody(selector: string): string {
  const lines = CSS.split("\n");
  const head = `${selector} {`;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim() !== head) continue;
    const out: string[] = [];
    for (let j = i + 1; j < lines.length; j += 1) {
      if (lines[j].trim() === "}") return out.join("\n");
      out.push(lines[j]);
    }
  }
  throw new Error(`找不到规则块：${head}（判据失效应视为红，不许静默通过）`);
}

/** 从声明块里取某条属性的值 */
function decl(body: string, prop: string): string {
  const m = new RegExp(`(?:^|\\n)\\s*${prop}\\s*:\\s*([^;]+);`).exec(body);
  if (!m) throw new Error(`块里没有 ${prop} 声明：\n${body}`);
  return m[1].trim();
}

describe("第 185 波 · 侧栏颜色语义（默认灰 / 悬停紫 / 选中紫）", () => {
  it("SC-1:【MCP/技能/记忆/智能体】那一栏的**默认底**必须是中性色（不许是品牌紫）", () => {
    const bg = decl(ruleBody(".sidebar-tool-row"), "background");
    expect(bg, `默认底不许动用品牌色（那是"你正在这里"的语义）：${bg}`).not.toMatch(/--accent/);
    expect(bg, `默认底要是中性令牌：${bg}`).toMatch(/--row-hover|--bg-tertiary|--text-base/);
  });

  it("SC-2: 同一栏**悬停/键盘焦点进入**时变品牌紫（就是原来那份浅紫）", () => {
    const bg = decl(ruleBody(".sidebar-tool-row:is(:hover, :focus-within)"), "background");
    expect(bg, `悬停要变紫：${bg}`).toMatch(/--accent/);
  });

  it("SC-3 结构性对照：默认底与悬停底**必须是两个不同的值**（这条专治'换回去'的变异）", () => {
    const normal = decl(ruleBody(".sidebar-tool-row"), "background");
    const hover = decl(ruleBody(".sidebar-tool-row:is(:hover, :focus-within)"), "background");
    expect(normal, "默认与悬停是同一个值 ⇒ 用户根本看不到变化").not.toBe(hover);
  });

  it("SC-4: 选中的**项目**行：图标与文字一起变品牌紫（`color` 走 `currentColor` 会传到 lucide 图标）", () => {
    const body = ruleBody(".sidebar-project.active > .sidebar-project-header");
    expect(decl(body, "color"), "选中项目的图标/文字要变紫（深一档，见 LIGHT-UI-8）").toBe(
      "var(--accent-strong)",
    );
    expect(decl(body, "background"), "底色仍是品牌浅底（选中感不能只靠文字色）").toBe("var(--accent-muted)");
  });

  it("SC-5: 选中的**对话**行：文字变品牌紫（会话行没有图标元素，只有标题——见下方注释）", () => {
    const body = ruleBody(".sidebar-session.active");
    // ⚠️ 必须是 --accent-strong：底是 --accent-muted，同色品牌文字压在上面对比度不够
    // （既有判据 `LIGHT-UI-8` 守这条；我第一版写 --accent 被它当场抓住）。
    expect(decl(body, "color"), "选中对话的文字要变紫（深一档，见 LIGHT-UI-8）").toBe(
      "var(--accent-strong)",
    );
    expect(decl(body, "background")).toBe("var(--accent-muted)");
  });

  it("SC-6 反向对照：**未选中**态不许沾品牌色（否则「选中」就没有对比了）", () => {
    expect(decl(ruleBody(".sidebar-session"), "color"), "未选中的会话行是次要文字色").toBe(
      "var(--text-secondary)",
    );
    // 悬停只提亮到主色，不许直接给品牌色（紫留给"选中"）
    const hoverBg = decl(ruleBody(".sidebar-session:not(.active):is(:hover, :focus-visible)"), "background");
    expect(hoverBg, "未选中的悬停底是中性行底").toBe("var(--row-hover)");
  });

  it("SC-7: 选中项目时**动作按钮与展开箭头不许跟着变紫**（主次：它们是动作，不是「当前项目」）", () => {
    const body = ruleBody(".sidebar-project.active > .sidebar-project-header");
    expect(body, "选中规则里不许出现动作按钮/箭头选择器").not.toMatch(/sidebar-project-btn|sidebar-project-arrow/);
    // 反向取证：这两者确实各自带色 ⇒ 不会被上面的 `color` 继承成紫
    expect(decl(ruleBody(".sidebar-project-btn"), "color")).toBe("var(--text-secondary)");
    expect(decl(ruleBody(".sidebar-project-arrow"), "color")).toBe("var(--text-muted)");
  });

  it("SC-8: 这些规则都必须落在**默认皮肤**（styles.css）里，不是只改了某个皮肤覆盖", () => {
    // 用户报的是"默认皮肤、亮色模式" ⇒ 默认皮肤本身必须改到；
    // 皮肤文件（skin-dream.css）可以有自己的覆盖，但不能是"唯一改动处"。
    expect(CSS).toContain(".sidebar-tool-row {");
    expect(ruleBody(".sidebar-tool-row").length, "默认皮肤里的规则块不该是空的").toBeGreaterThan(0);
  });
});
