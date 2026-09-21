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
   * LIGHT-UI-6 用户气泡：**中性浅底 + 无边框 + 无投影**，圆角收到 10px。
   *
   * 真机证据（`.preview-shot/audit-visual-detail-01.mjs`，1.16.115 装机版）：
   * **平行双线 21 对里有 20 对**由气泡的品牌色边框引起 —— 气泡底边与相邻
   * `button.toolbar-btn` 上边相距 **1px**、与 `span.collapse-btn` 底边相距 **0px**，
   * 两条不同颜色的 1px 线贴在一起（品牌紫 16% vs 中性 9%）。
   * 这就是"气泡边框线条看着毛"的成因，也是用户点名的第一处。
   */
  it("LIGHT-UI-6：用户气泡是中性的「无边框浅底」（不许再用品牌色边框）", () => {
    const rule = /\.user\s+\.message-content\s*\{([^}]*)\}/.exec(styles)?.[1] ?? "";
    expect(rule, "找不到 `.user .message-content` 规则").toBeTruthy();
    expect(rule, "气泡底色必须走中性的 --state-selected-bg").toMatch(/background:\s*var\(--state-selected-bg\)/);
    expect(rule, "气泡不许有边框（真机：它与相邻工具条边框叠成两条平行线）").toMatch(/border:\s*none/);
    expect(rule, "气泡不许有投影（浅底自己就够分层）").toMatch(/box-shadow:\s*none/);
    expect(rule, "气泡圆角收到 --radius-md（参考实现常用 8/10px）").toMatch(/border-radius:\s*var\(--radius-md\)/);
    expect(rule, "气泡不得使用品牌色").not.toMatch(/--accent|message-bubble/);
  });

  /**
   * LIGHT-UI-10 状态表达**不许用品牌色**（填充或边框），只允许中性。
   *
   * 这是本轮的**核心对标结论**：参考实现选中态品牌填充 1 处 / 中性 85 处、品牌色边框 2 处、
   * hover 里品牌色 3 处；我们改动前分别是 **69 / 11 / 44 / 116**。
   * 用户看到的"左侧栏里紫色的框"就是这么来的：`.sidebar-tool-row` 常驻 8% 紫底、
   * `.sidebar-tool-item.active` 18% 紫底、`.sidebar-project.active` 紫底，
   * 四个 22×22 图标按钮 hover 时整块变紫 + 紫边框 + 白字。
   *
   * 判据：**状态选择器**（`.active/.selected/.is-active/.is-selected/[aria-*]/:hover`）的规则体里，
   * 出现 `background: var(--accent…)` 或边框用 `var(--accent…)` 即违规；
   * 白名单 = 品牌色语义正确的那些（主操作按钮、进度/图表填充、开关、危险色、焦点环、加载态、徽标）。
   */
  it("LIGHT-UI-10：状态选择器不许用品牌色填充或边框（只允许中性状态令牌）", () => {
    const STATE = /(\.active\b|\.selected\b|\.is-active\b|\.is-selected\b|\[aria-selected=|\[aria-expanded=|:hover)/;
    const KEEP = [
      /* ⚠️ **不许写 `/bar-/` 或 `/-bar\b/`**：它们会匹配 `sideBAR-…`
         （`.sidebar-tool-row` / `.sidebar-project` / `.sidebar-session`…），
         于是**整个左侧栏**被放过 —— 本轮前两遍迁移脚本就是这么漏掉"左侧栏紫色框"的，
         直到真机复量仍量到紫底才发现。要放行的是"数值条"，用具体词根。 */
      /progress/, /\bfill\b/, /chart|usage|meter|gauge|score/, /heatmap/, /token-activity-cell/, /level-\d/,
      /toggle-entry/, /checkmark/, /input:checked/, /danger/, /error/, /warning/, /success/,
      /focus-visible/, /focus\b/, /logo/, /blob-/, /backdrop/, /caret/, /spinner/, /pulse/,
      /loading/, /skeleton/, /indicator/, /resize-handle/, /recover/, /dot/,
      /badge/, /pill/, /tag\b/, /chip/, /mention/, /highlight/, /selection/,
      /* 主操作按钮（静止态即品牌色填充）与**页签下划线指示器**：品牌色在这两处是语义正确的 */
      /--primary|\.primary\b/, /tab\b|-tab/,
    ];
    const files: string[] = [];
    (function walk(dir: string) {
      for (const n of readdirSync(dir)) {
        const p = join(dir, n);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.css$/.test(n) && !/skin-(hub|dream)/.test(p)) files.push(p);
      }
    })(join(ROOT, "src"));

    /** 取"状态选择器"去掉状态部分后的基选择器（用于判断它是不是主操作按钮） */
    const baseOf = (sel: string) =>
      sel
        .replace(/:hover|:focus-visible|:focus|:not\([^)]*\)|\[aria-[^\]]*\]/g, "")
        .replace(/\.(active|selected|is-active|is-selected)\b/g, "")
        .replace(/\s+/g, " ")
        .trim();

    const bad: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      const rules = [...src.matchAll(/([^\n{}]+)\{([^{}]*)\}/g)];
      for (const m of rules) {
        const sel = m[1].trim();
        const body = m[2];
        if (!STATE.test(sel)) continue;
        if (KEEP.some((k) => k.test(sel))) continue;
        /**
         * **主操作按钮**的 hover 允许继续用品牌色：判据是"它的**静止态**本来就是品牌色填充"。
         * 这样门禁不必维护一张按钮名字清单（`.snapshot-restore-btn` / `.mcp-server-btn.connect`
         * 这类名字无法穷举），而是按**语义**判定：静止就是品牌色的按钮，hover 加深品牌色是对的。
         */
        const base = baseOf(sel);
        const isPrimary =
          base.length > 0 &&
          rules.some((r2) => {
            const s2 = r2[1].trim();
            if (s2 !== base) return false;
            return /background(?:-color)?:\s*var\(--accent\)/.test(r2[2]);
          });
        if (isPrimary) continue;

        const rel = f.replace(ROOT, "").replace(/\\/g, "/");
        if (/background(?:-color)?:\s*var\(--accent/.test(body)) bad.push(`${rel} :: ${sel.slice(0, 60)} —— 品牌色填充`);
        if (/border[^:;{}]*:\s*[^;]*var\(--accent/.test(body)) bad.push(`${rel} :: ${sel.slice(0, 60)} —— 品牌色边框`);
      }
    }
    expect(bad, `状态表达必须中性（品牌色只留给主操作/进度/焦点环）—— "紫色框"的来源：\n  - ${bad.join("\n  - ")}`).toEqual([]);
  });

  /**
   * LIGHT-UI-11 实线边框粗细只允许 1px。
   *
   * 真机台账：非 1px 的线 8 段**全在同一个 32px 头像上**（2px 边框）；静态普查另有 51 处。
   * 现在收敛：`2px/1.5px + 中性色` → 1px、`2px/3px + 品牌色` → 1px 中性、
   * `border-left: 3px + 状态色` → 2px（保留语义色，只是不再是最粗的线）。
   *
   * 例外都是**"环/挖空"，不是"线"**：spinner 的转圈环、徽标用背景色描一圈把自己从底上"切"出来
   * —— 它们必须是 2px 才有意义；皮肤（hub/dream）与内嵌游戏有自己的美术方向，不在本门禁范围。
   */
  it("LIGHT-UI-11：实线边框粗细只允许 1px（环/挖空与游戏皮肤例外）", () => {
    const files: string[] = [];
    (function walk(dir: string) {
      for (const n of readdirSync(dir)) {
        const p = join(dir, n);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.css$/.test(n) && !/skin-(hub|dream)|monopoly-game/.test(p)) files.push(p);
      }
    })(join(ROOT, "src"));
    const RING = /spinner|progress|ring|badge|avatar|swatch|thumb|checkmark|dot\b/;
    const bad: string[] = [];
    for (const f of files) {
      const lines = readFileSync(f, "utf8").split(/\r?\n/);
      let sel = "";
      lines.forEach((line, i) => {
        const open = /^([^\n{}]+)\{/.exec(line.trim());
        if (open) sel = open[1].trim();
        const m = /border(?:-(?:top|right|bottom|left))?:\s*([0-9.]+)px\s+solid\s+([^;{}]+)/.exec(line);
        if (!m) return;
        const w = parseFloat(m[1]);
        const color = m[2].trim();
        if (w === 1) return;
        if (/transparent$/.test(color)) return;                 // 占位边框：防 hover 抖动，视觉上不存在
        if (w === 2 && /^border-left:/.test(line.trim())) return; // 状态条：语义色左线，2px 上限
        if (RING.test(sel)) return;                              // 环 / 挖空，不是"线"
        bad.push(`${f.replace(ROOT, "").replace(/\\/g, "/")}:${i + 1}  ${sel}  ${line.trim().slice(0, 50)}`);
      });
    }
    expect(bad, `边框粗细不统一（满屏 1px 里出现 2px/3px 就是"这一处特别粗"）：\n  - ${bad.join("\n  - ")}`).toEqual([]);
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
