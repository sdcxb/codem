/**
 * LIGHT-UI —— **亮色模式观感不变式**门禁（第 65 轮）。
 *
 * ## 为什么需要这个门禁（本轮抓到的真缺陷）
 *
 * 用户反馈"暗色已经比较美观，亮色还是很粗糙、像原型"。本会话模型**不能读图**，
 * 所以先把观感拆成可量化项，在装机版上量出来（`.preview-shot/audit-light-ui-01-measure.json`
 * / `-02-conversation.json`）：
 *
 *  - **抬升方向反了**：画布 `#fcfcfb`（lum 0.973）→ 面板 `#f5f5f3`（0.912）→
 *    内嵌块/用户消息 `#ededea`（0.845）。用户消息是一块 **dLum −0.128** 的深灰块贴在近白底上
 *    （+12% 边框 + 阴影）——"像色卡拼贴"就是这么来的。
 *    而**暗色档本来就是相反方向**（`--bg-primary` 最暗 → `--bg-secondary` 更亮 → `--bg-tertiary` 更亮），
 *    两档方向不一致，于是暗色好看、亮色别扭。
 *  - **线条四种色相、整体偏重**：`rgb(31 31 30/12%)`（33 条，对比度 1.27）、`/7%`、
 *    `rgba(208,215,222,.6)`（**冷**蓝灰）、`rgba(0,0,0,.06)`（**纯黑**）。
 *    参考实现（frakio-work）只有一种：`rgb(17 24 39 / 9%)`（白底 1.201）。
 *  - **两套调色板同屏**：`styles.css` 是暖中性（`rgb(31 31 30/…)`），
 *    `codem-ui.css` 的亮色档是 GitHub **冷**灰（`rgba(246,248,250,…)`、`rgba(208,215,222,…)`、
 *    `rgba(0,0,0,…)`）——代码块/表头是冷的、侧栏与用户消息是暖的。
 *  - **功能色用饱和 web 色**：安全模式的 `#22c55e` 图标与文字「完全访问」在近白底上只有 **2.22:1**；
 *    弱文字 `#8a8880` 落进内嵌灰块只有 **3.03:1**（而它被大量用在 10–12px 小字上）。
 *  - **该用的令牌是死的**：`--message-bubble-user` 早就在 `codem-ui.css` 亮色档里定义好了
 *    （`rgba(107,92,231,.10)` 品牌色浅底），但**零引用** —— 于是用户气泡用了别的（灰块）。
 *
 * 这些都不是"感觉问题"，每一条都能算成一个数。所以这里把**数与不变量**固化成门禁：
 * 以后谁把抬升方向改回去、谁的亮色档里又混进冷灰/纯黑/饱和色、谁的令牌变成死的，测试立刻红。
 *
 * ⚠️ 判据口径与真机探针**同一套数学**（WCAG 相对亮度 + alpha 合成），
 * 便于把门禁数值与真机读数逐项对上。
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

/* ---------------- 颜色数学（与探针一致） ---------------- */
const parseColor = (v: string): [number, number, number, number] | null => {
  const s = String(v).trim();
  const hex = /^#([0-9a-f]{6})$/i.exec(s);
  if (hex) { const n = parseInt(hex[1], 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1]; }
  const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)/i.exec(s);
  if (!m) return null;
  let a = m[4] === undefined ? 1 : parseFloat(m[4]);
  if (String(m[4]).endsWith("%")) a /= 100;
  return [+m[1], +m[2], +m[3], a];
};
const over = (f: [number, number, number, number], b: [number, number, number, number]): [number, number, number, number] =>
  [f[0] * f[3] + b[0] * (1 - f[3]), f[1] * f[3] + b[1] * (1 - f[3]), f[2] * f[3] + b[2] * (1 - f[3]), 1];
const lum = (c: [number, number, number, number]) => {
  const f = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
};
const contrast = (a: [number, number, number, number], b: [number, number, number, number]) => {
  const l1 = lum(a), l2 = lum(b);
  const hi = Math.max(l1, l2), lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
};

/* ---------------- 抽出亮色档令牌块 ---------------- */
const styles = read("src/styles.css");
const codemUi = read("src/styles/codem-ui.css");
const lightBlock = /:root,\s*\[data-theme="light"\]\s*\{([\s\S]*?)\n\}/.exec(styles)?.[1] ?? "";
const codemUiLight = /\/\* Light theme glass tokens[\s\S]*?\[data-theme="light"\]\s*\{([\s\S]*?)\n\}/.exec(codemUi)?.[1] ?? "";

const token = (block: string, name: string): string | null =>
  new RegExp(`${name}:\\s*([^;]+);`).exec(block)?.[1]?.trim() ?? null;

const need = (v: string | null, name: string): string => {
  expect(v, `亮色档里应定义 ${name}`).toBeTruthy();
  return v!;
};
const color = (v: string | null, name: string) => {
  const c = parseColor(need(v, name));
  expect(c, `${name} 应是可解析的颜色：${v}`).toBeTruthy();
  return c!;
};

describe("LIGHT-UI 亮色模式观感不变式", () => {
  it("LIGHT-UI-0（前提）：解析到了亮色档令牌块，且能读出关键令牌", () => {
    expect(lightBlock.length, "styles.css 的亮色档块没解析到").toBeGreaterThan(200);
    expect(codemUiLight.length, "codem-ui.css 的亮色档块没解析到").toBeGreaterThan(100);
    for (const t of ["--bg-primary", "--bg-secondary", "--bg-tertiary", "--text-muted", "--border-primary"]) {
      expect(token(lightBlock, t), `亮色档缺 ${t}`).toBeTruthy();
    }
  });

  /**
   * LIGHT-UI-1 抬升方向：**内容面最亮 → 面板次之 → 内嵌块再次之**，且内嵌块与内容面有可辨识差。
   *
   * 改动前是反的（画布 0.973 > 面板 0.912 > 内嵌 0.845），用户消息因此是一块 dLum −0.128 的深灰块。
   * 上界 0.12 就是"不许再出现那种大灰块"；下界 0.04 是"内嵌块仍要看得出来"。
   */
  it("LIGHT-UI-1：面阶梯必须是「内容面最亮 → 面板 → 内嵌块」，且内嵌块不得再变成大灰块", () => {
    const p = lum(color(token(lightBlock, "--bg-primary"), "--bg-primary"));
    const s = lum(color(token(lightBlock, "--bg-secondary"), "--bg-secondary"));
    const t = lum(color(token(lightBlock, "--bg-tertiary"), "--bg-tertiary"));
    expect(p, `内容面应比面板亮（primary ${p.toFixed(3)} vs secondary ${s.toFixed(3)}）——暗色档就是这个方向`).toBeGreaterThanOrEqual(s);
    expect(s, `面板应比内嵌块亮（secondary ${s.toFixed(3)} vs tertiary ${t.toFixed(3)}）`).toBeGreaterThanOrEqual(t);
    expect(p, `内容面应接近纯白（当前 ${p.toFixed(3)}）`).toBeGreaterThanOrEqual(0.97);
    const delta = p - t;
    expect(delta, `内嵌块与内容面的亮度差 ${delta.toFixed(3)} 太小，内嵌块会看不见`).toBeGreaterThanOrEqual(0.04);
    expect(delta, `内嵌块比内容面暗了 ${delta.toFixed(3)}（改动前用户消息块是 0.128）—— 这又变成"深灰大色块"了`).toBeLessThanOrEqual(0.12);
  });

  /**
   * LIGHT-UI-2 线条：强度落在参考实现的带内（1.10–1.35），且 `--border-secondary` 必须更弱。
   * 参考 `rgb(17 24 39 / 9%)` 在白底上是 1.201；我们改动前是 1.269（12%）。
   */
  it("LIGHT-UI-2：1px 线在内容面上的对比度落在参考带宽内，且次级线更弱", () => {
    const bg = color(token(lightBlock, "--bg-primary"), "--bg-primary");
    const b1 = contrast(over(color(token(lightBlock, "--border-primary"), "--border-primary"), bg), bg);
    const b2 = contrast(over(color(token(lightBlock, "--border-secondary"), "--border-secondary"), bg), bg);
    expect(b1, `主线条对比度 ${b1.toFixed(3)} 过强（参考实现 1.201，改动前 1.269）—— 界面会像线框稿`).toBeLessThanOrEqual(1.35);
    expect(b1, `主线条对比度 ${b1.toFixed(3)} 过弱，边框会看不见`).toBeGreaterThanOrEqual(1.1);
    expect(b2, "次级线条必须比主线条弱").toBeLessThan(b1);
  });

  /**
   * LIGHT-UI-2b 结构分隔线：`--border-separator` 必须**比主线条弱**、又不能弱到看不见；
   * 而且消费它的规则必须落在**界面真的会渲染的类**上。
   *
   * ## 为什么加这一条（第 67 轮的真缺陷）
   *
   * 用户看到对照页后说"把 `--border-separator` 降到 5%" —— 令牌值本身好守，
   * 但同一轮里我犯的错是**改错了地方**：把"回复过程条目之间的线"改到了 `.tool-item` 上，
   * 而全项目**没有任何组件渲染这个类**（TSX 里的 `tool-item` 全是 `sidebar-tool-item` /
   * `agent-tool-item` 的子串）。于是"改完了"，界面上一个像素都没动。
   *
   * 所以这条断言分两半：
   *   ① 数值：分隔线弱于主线条、强于"完全看不见"，且亮/暗两档都定义了；
   *   ② **资格**：画过程条目线条的那几个类名，必须在 `.tsx/.ts` 里以**标识符整词**出现。
   *      ②才是真正防复发的那一半 —— 它让"给一个不存在的类写样式"当场变红。
   */
  it("LIGHT-UI-2b：结构分隔线弱于主线条且看得见，且只画在真的会被渲染的类上", () => {
    const darkBlock = /\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/.exec(styles)?.[1] ?? "";
    const lp = color(token(lightBlock, "--bg-primary"), "--bg-primary");
    const sepLight = color(token(lightBlock, "--border-separator"), "--border-separator");
    const sepDark = color(token(darkBlock, "--border-separator"), "--border-separator");
    const b1 = contrast(over(color(token(lightBlock, "--border-primary"), "--border-primary"), lp), lp);
    const b2 = contrast(over(color(token(lightBlock, "--border-secondary"), "--border-secondary"), lp), lp);
    const sep = contrast(over(sepLight, lp), lp);

    expect(sep, `分隔线（${sep.toFixed(3)}）必须弱于主线条（${b1.toFixed(3)}）—— 它是"分节"不是"控件边界"`).toBeLessThan(b1);
    // 上界钉住用户的那次决定：分隔线**不得强于 5% 那次级线**（7% 时是 1.146，用户看到实际效果后要求降到 5%）
    expect(sep, `分隔线（${sep.toFixed(3)}）比次级线（${b2.toFixed(3)}）还重 —— 用户第 67 轮明确要求降到 5% 那一档`).toBeLessThanOrEqual(b2 + 1e-9);
    expect(sep, `分隔线只有 ${sep.toFixed(3)}，等于看不见了（5% 约 1.104）`).toBeGreaterThanOrEqual(1.05);
    expect(sepDark[3], "暗色档分隔线必须有可见的 alpha").toBeGreaterThan(0.03);

    // ② 资格：过程条目线条的规则必须落在真实渲染的类上
    //
    // ⚠️ 语料**必须排除测试目录**：否则下面这份类名清单会把自己写进语料，
    // `rendered.has("随便乱写的名字")` 恒为真 —— 变异测试（把清单里换成 `tool-card-headZZZ`）
    // 当场证明过：不排除时断言永远绿，等于什么都没守。
    const tsCorpus = (function walk(dir: string, acc: string[] = []): string[] {
      for (const n of readdirSync(dir)) {
        const p = join(dir, n);
        if (statSync(p).isDirectory()) {
          if (n === "test" || n === "__snapshots__") continue;
          walk(p, acc);
        } else if (/\.tsx?$/.test(n) && !/\.test\.tsx?$/.test(n)) acc.push(readFileSync(p, "utf8"));
      }
      return acc;
    })(join(ROOT, "src")).join("\n");
    const rendered = new Set(tsCorpus.match(/[A-Za-z_][\w-]*/g) ?? []);

    // 这几条是"过程条目/卡内行/详情段"真正会被渲染的类（`ToolCallCard.tsx` / `ToolCallGroup.tsx`）
    const decoratingClasses = ["tool-card-head", "tool-card-row", "tool-io-section--bordered", "tool-pill-detail-section"];
    const missing = decoratingClasses.filter((c) => !rendered.has(c));
    expect(
      missing,
      `这些类名在 .tsx/.ts 里根本不是"整词"（多半是某个更长类名的子串），给它们写样式等于没写：${missing.join(", ")}`,
    ).toEqual([]);

    // 线条必须改由"两端渐隐"的伪元素画，而不是全宽硬边框。
    // ⚠️ 先挖掉注释：这些规则上方的注释里**写着**改动前的旧声明（`border-bottom: 1px solid var(--border-primary)`），
    // 不挖掉就会拿注释当证据（第一次跑这条断言就是这么红的 —— 注释里的旧写法被当成了违规）。
    const codemUi = readFileSync(join(ROOT, "src", "styles", "codem-ui.css"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "));
    for (const sel of [".tool-card-head:not(:last-child)::after", ".tool-card-row:not(:last-child)::after"]) {
      const body = new RegExp(`${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`).exec(codemUi)?.[1] ?? "";
      expect(body, `${sel} 不见了 —— 过程条目线条又退回全宽硬边框了`).toBeTruthy();
      expect(body, `${sel} 必须用 var(--border-separator) 的渐隐渐变`).toMatch(/linear-gradient\([^)]*var\(--border-separator\)/);
    }
    const hardBorder = /\.tool-card-(head|row)\s*\{[^}]*border-bottom:\s*1px solid var\(--border-primary\)/.exec(codemUi);
    expect(hardBorder, "`.tool-card-head`/`.tool-card-row` 又出现全宽 9% 硬线（会和卡片外框叠成两条平行线）").toBeNull();
  });

  /**
   * LIGHT-UI-2c 回复里的**分节线**（Markdown `<hr>`）—— 用户第 69 轮在对照页里**逐状态选定**的形态：
   *
   * - **鼠标不在回复上（平时）**：候选 D —— **不要线，只留留白**；
   * - **鼠标移到回复上**：候选 C —— 5% 浓度 + 左右各内缩 24px + 两端各渐隐 8%。
   *
   * 改前（真机量到）：`background: var(--border-primary)`（控件边框档 9%）、宽 = 整个正文列
   * （758px，左右内缩 0，两端硬切）、暗色档另有手写 16% 白覆盖（亮色的约 1.8 倍）。
   *
   * 这条断言守四件事：
   * ① 平时**不画线**（`background: none`），线只在悬停态；
   * ② 悬停那条线走**结构分隔线档** + 两端渐隐（不是控件边框档、不是全宽硬边）；
   * ③ **悬停态不许动几何**（这条最关键：两态间距若不同，一屏十几条线会让内容上下跳）——
   *    悬停规则只许改 `opacity`，内缩必须画在伪元素上；
   * ④ 不许再有暗色档的硬编码覆盖。
   */
  it("LIGHT-UI-2c：分节线平时留白、悬停才长线（分隔线档 + 两端渐隐），且悬停不改几何", () => {
    const code = codemUi.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "));

    // ① 平时：不画线，只留白
    const base = /\.rich-content-hr\s*\{([^}]*)\}/.exec(code)?.[1] ?? "";
    expect(base, "找不到 `.rich-content-hr` 规则").toBeTruthy();
    expect(base, "平时（鼠标不在回复上）不该画线 —— 用户选定的是候选 D：只留留白").toMatch(/background:\s*none/);
    expect(base, "分节线高度应当是 1px（更粗就是更粗糙）").toMatch(/height:\s*1px/);
    expect(base, "两态间距必须恒定（这里给的是候选 D 的 2em）").toMatch(/margin:\s*2em 0/);

    // ② 悬停那条线：分隔线档 + 两端渐隐 + 内缩画在伪元素上
    const line = /\.rich-content-hr::after\s*\{([^}]*)\}/.exec(code)?.[1] ?? "";
    expect(line, "找不到 `.rich-content-hr::after`（悬停那条线应当画在伪元素上）").toBeTruthy();
    expect(
      line,
      "悬停线必须用 var(--border-separator)（结构分隔线档）—— 改前用的是控件边框档（--border-primary），比它重一倍",
    ).toMatch(/var\(--border-separator\)/);
    expect(line, "悬停线必须是**两端渐隐**的渐变；全宽硬边就是用户说的『粗糙』").toMatch(/linear-gradient\(/);
    expect(line, "悬停线的左右内缩必须画在伪元素上（left/right），不是改 <hr> 的 margin").toMatch(/left:\s*24px/);
    expect(line, "悬停线默认不可见（靠 opacity 切换，才能淡入）").toMatch(/opacity:\s*0/);

    // ③ 悬停规则只许改透明度：改几何 = 悬停时内容跳
    const hover = /\.rich-content:is\(:hover,\s*:focus-within\)\s*\.rich-content-hr::after\s*\{([^}]*)\}/.exec(code)?.[1] ?? "";
    expect(hover, "找不到悬停规则 `.rich-content:is(:hover, :focus-within) .rich-content-hr::after`").toBeTruthy();
    expect(hover, "悬停规则必须让线可见（opacity: 1）").toMatch(/opacity:\s*1/);
    for (const prop of ["margin", "padding", "height", "width", "left", "right", "top", "bottom"]) {
      expect(
        new RegExp(`(^|;)\\s*${prop}\\s*:`).test(hover),
        `悬停规则里出现了几何属性 \`${prop}\` —— 悬停会改布局（两态间距不同 ⇒ 一屏十几条线会让内容上下跳）`,
      ).toBe(false);
    }

    expect(
      /\[data-theme="dark"\]\s*\.rich-content-hr/.test(code),
      "暗色档的 `.rich-content-hr` 覆盖又回来了 —— 那条覆盖是手写的 16% 白（亮色档的约 1.8 倍），浓度应当交给令牌两档各自解析",
    ).toBe(false);
  });

  /**
   * LIGHT-UI-3 对比度下限：正文/次级/弱级文字、以及**全部功能色**都要在内容面与内嵌块上达标。
   * 这条直接拦住两类真缺陷：`#22c55e` 安全色（2.22）与 `#8a8880` 弱文字落进灰块（3.03）。
   */
  it("LIGHT-UI-3：文字与功能色在内容面/内嵌块上都 ≥4.5:1（正文 ≥7:1）", () => {
    const surfaces = new Map<string, [number, number, number, number]>([
      ["内容面", color(token(lightBlock, "--bg-primary"), "--bg-primary")],
      ["内嵌块", color(token(lightBlock, "--bg-tertiary"), "--bg-tertiary")],
    ]);
    const checks: Array<[string, number]> = [
      ["--text-primary", 7],
      ["--text-secondary", 4.5],
      ["--text-muted", 4.5],
      ["--success", 4.5],
      ["--warning", 4.5],
      ["--error", 4.5],
      ["--info", 4.5],
      ["--security-ask", 4.5],
      ["--security-auto", 4.5],
      ["--security-full", 4.5],
      ["--accent", 4.5],
    ];
    const fails: string[] = [];
    for (const [name, min] of checks) {
      const c = parseColor(token(lightBlock, name) ?? "");
      if (!c) { fails.push(`${name} 解析失败`); continue; }
      for (const [sname, s] of surfaces) {
        const r = contrast(over(c, s), s);
        if (r < min) fails.push(`${name} 在${sname}上只有 ${r.toFixed(2)}:1（要求 ≥${min}）`);
      }
    }
    expect(fails, `亮色档对比度不达标：\n  - ${fails.join("\n  - ")}`).toEqual([]);
  });

  /**
   * LIGHT-UI-4 调色板唯一性：亮色档里**不许**再出现冷灰（GitHub 系）、纯黑 alpha、或饱和 web 色。
   *
   * 这一条是"两套调色板同屏"的直接防线：改动前亮色档里同时存在
   * `rgba(246,248,250,…)`（冷白）、`rgba(208,215,222,…)`（冷边）、`rgba(0,0,0,…)`（纯黑边）、
   * `#22c55e/#3b82f6/#8b5cf6`（Tailwind 饱和色）与暖中性的 `rgb(31 31 30/…)`。
   */
  it("LIGHT-UI-4：亮色档里不许出现冷灰 / 纯黑 alpha / 饱和 web 色（只允许一种白点）", () => {
    const forbidden: Array<[string, RegExp]> = [
      ["冷白 rgba(246,248,250,…) / rgba(234,238,242,…)", /rgba?\(\s*(246,\s*248,\s*250|234,\s*238,\s*242|186,\s*196,\s*204|170,\s*180,\s*188|240,\s*240,\s*244)/],
      ["冷边 rgba(208,215,222,…)", /rgba?\(\s*(208,\s*215,\s*222|17,\s*24,\s*39)/],
      ["纯黑 alpha rgba(0,0,0,…)", /rgba?\(\s*0,\s*0,\s*0\s*[,/]/],
      ["饱和 web 色（Tailwind 500 号）", /#(22c55e|3b82f6|8b5cf6|ef4444|f59e0b|10b981|6366f1|4ade80|60a5fa|c084fc|a855f7|0ea5e9)\b/i],
    ];
    const hits: string[] = [];
    for (const [label, file, block] of [
      ["styles.css", "styles.css", lightBlock],
      ["codem-ui.css", "codem-ui.css", codemUiLight],
    ] as const) {
      // 去掉注释行再扫（注释里会**解释**这些颜色，那是文档不是取值）
      const code = block.split(/\r?\n/).filter((l) => !/^\s*(\/\*|\*|\/\/)/.test(l)).join("\n");
      for (const [what, re] of forbidden) {
        if (re.test(code)) hits.push(`${file}（${label} 亮色档）：${what}`);
      }
    }
    expect(hits, `亮色档混进了别的色系 —— 同屏会出现两种白点：\n  - ${hits.join("\n  - ")}`).toEqual([]);
  });

  /**
   * LIGHT-UI-5 死令牌：亮色档定义的每个令牌，全项目至少要有一个 `var()` 消费方。
   *
   * 这条盯的是本轮那条真缺陷的**成因**：`--message-bubble-user` 定义了、但零引用，
   * 于是"设计意图"和"实际渲染"分叉（气泡用了灰块）。注释不算消费方。
   *
   * 口径：`var(--x)` 与 `var(--x, fallback)` 都算（带兜底的写法以前被漏统计过，
   * 差点让 `--user-bg` 被误删 —— 详见 `src/styles.css` 里那段注释）。
   */
  it("LIGHT-UI-5：亮色档里不许有零消费方的令牌（设计意图与现实分叉）", () => {
    const defined = [...new Set([...lightBlock.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gim)].map((m) => m[1]))];
    expect(defined.length, "亮色档令牌数明显偏少，解析可能坏了").toBeGreaterThan(50);

    const files: string[] = [];
    (function walk(dir: string) {
      for (const n of readdirSync(dir)) {
        const p = join(dir, n);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(css|ts|tsx)$/.test(n)) files.push(p);
      }
    })(join(ROOT, "src"));
    const texts = files.filter((f) => !/\.test\./.test(f)).map((f) => readFileSync(f, "utf8"));

    const dead = defined.filter((tok) => !texts.some((t) => new RegExp(`var\\(\\s*${tok}\\s*[,)]`).test(t)));
    expect(dead, `这些令牌定义了却没有任何消费方（第 65 轮的用户气泡就是这么变成灰块的）：\n  - ${dead.join("\n  - ")}`).toEqual([]);
  });

  /**
   * LIGHT-UI-6 用户气泡：两档必须**同源**（同一个令牌），且不得再用 `--bg-tertiary`。
   * 三套皮肤（默认/hub/dream）都要给色，否则某个皮肤下气泡会掉回默认档或直接没有边框。
   */
  it("LIGHT-UI-6：用户气泡走 --message-bubble-user(+border)，两档与三套皮肤都给色", () => {
    const rule = /\.user\s+\.message-content\s*\{([^}]*)\}/.exec(styles)?.[1] ?? "";
    expect(rule, "找不到 `.user .message-content` 规则").toBeTruthy();
    expect(rule, "用户气泡必须用 --message-bubble-user（第 65 轮：改动前用 --bg-tertiary，是一块深灰）").toMatch(/background:\s*var\(--message-bubble-user\)/);
    expect(rule, "用户气泡边框必须走 --message-bubble-user-border").toMatch(/border:\s*1px solid var\(--message-bubble-user-border\)/);
    expect(rule, "用户气泡不得再退回 --bg-tertiary").not.toMatch(/background:\s*var\(--bg-tertiary\)/);

    // 两档主题各自给色（同名令牌，不同取值）
    const darkBlock = /\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/.exec(styles)?.[1] ?? "";
    expect(token(lightBlock, "--message-bubble-user"), "亮色档缺气泡色").toBeTruthy();
    expect(token(darkBlock, "--message-bubble-user"), "暗色档缺气泡色").toBeTruthy();
    expect(token(lightBlock, "--message-bubble-user"), "两档气泡色不该完全相同（否则等于没做主题区分）")
      .not.toBe(token(darkBlock, "--message-bubble-user"));

    // 三套皮肤
    for (const skin of ["src/styles/skin-hub.css", "src/styles/skin-dream.css"]) {
      const s = read(skin);
      expect(s, `${skin} 缺 --message-bubble-user`).toMatch(/--message-bubble-user\s*:/);
      expect(s, `${skin} 缺 --message-bubble-user-border（否则该皮肤下气泡没有边框）`).toMatch(/--message-bubble-user-border\s*:/);
    }
  });

  /**
   * LIGHT-UI-8 品牌色浅底上的品牌色文字：必须是 `--accent-strong`，不能是 `--accent`。
   *
   * 真机读数（1.16.115 前一个构建）：`.model-badge` 是
   * `background: var(--accent-muted); color: var(--accent)`，对比度只有 4.22:1；
   * 而它常常叠在**用户气泡**（本身也是品牌色浅底）上 —— 双层浅底只剩 3.94:1。
   * 全项目当时有 12 条规则是同一写法（选中态/标签/徽标），已统一改用 `--accent-strong`
   * （亮色 #5b46cf 在 15% 浅底上 4.80；暗色 #a99bff 在 20% 浅底上 5.37）。
   *
   * 这条断言按**规则体**判定：同一个 `{}` 里既有 `background: var(--accent-muted)`
   * 又有 `color: var(--accent)` 就报错（`--accent` 是"面/边框/填充"用的，不是"浅底上的文字"用的）。
   */
  it("LIGHT-UI-8：品牌浅底上的品牌色文字必须用 --accent-strong（不许用 --accent）", () => {
    const files: string[] = [];
    (function walk(dir: string) {
      for (const n of readdirSync(dir)) {
        const p = join(dir, n);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.css$/.test(n)) files.push(p);
      }
    })(join(ROOT, "src"));

    const bad: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/([^\n{}]+)\{([^{}]*)\}/g)) {
        const [, sel, body] = m;
        if (/background:\s*var\(--accent-muted\)/.test(body) && /color:\s*var\(--accent\)\s*;/.test(body)) {
          bad.push(`${f.replace(ROOT, "").replace(/\\/g, "/")} :: ${sel.trim().replace(/\s+/g, " ").slice(0, 60)}`);
        }
      }
    }
    expect(bad, `品牌浅底上的文字对比度不足 4.5:1，应改用 --accent-strong：\n  - ${bad.join("\n  - ")}`).toEqual([]);
  });

  /**
   * LIGHT-UI-9 两档主题都要能算出 `--accent-strong` 并且**过线**：
   * 亮色在 15% 浅底（叠在用户气泡上）≥4.5；暗色在 20% 浅底（叠在暗色气泡上）≥4.5。
   */
  it("LIGHT-UI-9：两档的 --accent-strong 在各自的品牌浅底 chip 上都 ≥4.5:1", () => {
    const darkBlock = /\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/.exec(styles)?.[1] ?? "";
    const cases: Array<[string, string, string, string]> = [
      ["亮色", lightBlock, "--accent-muted", "--bg-primary"],
      ["暗色", darkBlock, "--accent-muted", "--bg-primary"],
    ];
    const fails: string[] = [];
    for (const [label, block, mutedName, baseName] of cases) {
      const strong = parseColor(token(block, "--accent-strong") ?? "");
      const muted = parseColor(token(block, mutedName) ?? "");
      const base = parseColor(token(block, baseName) ?? "");
      if (!strong || !muted || !base) { fails.push(`${label}：令牌解析失败`); continue; }
      const chip = over(muted, base);
      const r = contrast(over(strong, chip), chip);
      if (r < 4.5) fails.push(`${label}：--accent-strong 在品牌浅底上只有 ${r.toFixed(2)}:1`);
    }
    expect(fails, fails.join("；")).toEqual([]);
  });

  /**
   * LIGHT-UI-7 与参考实现的定量对齐：主线条对比度、弱文字对比度都要落在参考的同一带内。
   * （参考：线条 1.201；文字 16.10 / 5.35 / 3.56 —— 弱文字我们**不跟**参考的 3.56，
   * 因为我们有大量 10–12px 小字，按 WCAG 正文线要求 ≥4.5。）
   */
  it("LIGHT-UI-7：线条与参考实现对得上（1.15–1.28 带内），弱文字比参考更严（≥4.5:1）", () => {
    const bg = color(token(lightBlock, "--bg-primary"), "--bg-primary");
    const border = contrast(over(color(token(lightBlock, "--border-primary"), "--border-primary"), bg), bg);
    expect(border, `主线条 ${border.toFixed(3)} 与参考实现的 1.201 差得太远`).toBeGreaterThanOrEqual(1.15);
    expect(border).toBeLessThanOrEqual(1.28);
    const muted = contrast(color(token(lightBlock, "--text-muted"), "--text-muted"), bg);
    expect(muted, `弱文字 ${muted.toFixed(2)}:1 低于 4.5（参考实现只到 3.56，但它没有我们这么多 10px 小字）`).toBeGreaterThanOrEqual(4.5);
  });
});
