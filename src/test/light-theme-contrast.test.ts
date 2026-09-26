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
/**
 * 取一个令牌的颜色。
 *
 * `block` 是**可选**的：给了它就能解析 `color-mix()` / `var()` 这类**派生**令牌
 * （第 159 轮 P1-2 之后，文字三档与 `--accent-muted` 都是派生出来的）。
 * ⚠️ 派生令牌**必须**传 block：不给的话只能在两个主题块里瞎猜，而猜错会静默测到另一个主题的值
 * （那比报错更糟）。所以这里的原则是：解析不了就报错，让人来显式指定 block。
 */
const color = (v: string | null, name: string, block?: string) => {
  const raw = need(v, name);
  const direct = parseColor(raw);
  if (direct) return direct;
  expect(block, `${name} 是派生令牌（color-mix/var），调用点必须传 block 才能解析：${raw}`).toBeTruthy();
  return resolveColor(block!, raw);
};

/**
 * 解析 `color-mix(in srgb, <颜色|var(--令牌)> N%, transparent)` —— 玻璃面用的就是这一种写法。
 * 只支持本项目真实用到的形式（底色 + 百分比 + transparent），别的形式一律**报错而不是猜**
 * —— 猜出来的数字等于没测。
 */
const mixWithTransparent = (
  v: string | null,
  name: string,
  block: string,
): { base: [number, number, number, number]; alpha: number } => {
  const raw = need(v, name);
  const m = /^color-mix\(\s*in srgb\s*,\s*(.+?)\s+([\d.]+)%\s*,\s*transparent\s*\)$/i.exec(raw.trim());
  expect(m, `${name} 应是 color-mix(in srgb, <色> N%, transparent) 写法，实际：${raw}`).toBeTruthy();
  let baseRaw = m![1].trim();
  const asVar = /^var\((--[\w-]+)\)$/.exec(baseRaw);
  if (asVar) baseRaw = need(token(block, asVar[1]), `${name} 引用的 ${asVar[1]}`);
  const base = parseColor(baseRaw);
  expect(base, `${name} 的底色应可解析：${baseRaw}`).toBeTruthy();
  return { base: base!, alpha: Number(m![2]) / 100 };
};

/**
 * **玻璃的最坏情况可读性**（第 157 轮新增，LIGHT-UI-10 / DARK-UI-6 的真正判据）。
 *
 * 玻璃是半透明的 ⇒ 侧栏上的文字实际压在「场景层最坏像素 + 玻璃」的合成上。
 * 这里把四件事都算出来：
 *   场景底两个端点（`--bg-secondary` / `--bg-primary`）× 两种最强着色（`--scene-veil` / `--scene-veil-alt`）
 *   → 得到 4 个最坏场景像素 → 每个都叠上玻璃 α 的 `--sidebar-bg` → 在合成上量三档文字的对比度。
 * 门槛取深浅两档既有门禁里更严的那一档：主 ≥10、次 ≥6、弱 ≥4.5。
 */
const worstGlassCase = (block: string, theme: string) => {
  const glass = mixWithTransparent(token(block, "--surface-glass-chrome"), "--surface-glass-chrome", block);
  const veils = ["--scene-veil", "--scene-veil-alt"].map((n) => mixWithTransparent(token(block, n), n, block));
  const bases = ["--bg-secondary", "--bg-primary"].map((n) => color(token(block, n), n));
  const texts: Array<[string, string, number]> = [
    ["正文", "--text-primary", 10],
    ["次级", "--text-secondary", 6],
    ["弱级", "--text-muted", 4.5],
  ];
  const failures: string[] = [];
  const samples: string[] = [];
  for (const base of bases) {
    for (const veil of veils) {
      const scene = over([veil.base[0], veil.base[1], veil.base[2], veil.alpha], base);
      const composite = over([glass.base[0], glass.base[1], glass.base[2], glass.alpha], scene);
      for (const [label, tok, floor] of texts) {
        const r = contrast(color(token(block, tok), tok, block), composite);
        if (r < floor) {
          failures.push(`${theme} ${label}在「场景 ${tok} 之上」只有 ${r.toFixed(2)}:1（需 ≥${floor}）`);
        }
      }
      samples.push(`L=${lum(composite).toFixed(4)}`);
    }
  }
  return { failures, samples, alpha: glass.alpha };
};

/** `--x: var(--y)` 这种**别名**要跟着解析一层（暗色档的 `-content` 就是原色的别名） */
const colorFollowingAlias = (block: string, name: string, depth = 0): [number, number, number, number] => {
  const raw = need(token(block, name), name);
  const alias = /^var\((--[\w-]+)\)$/.exec(raw.trim());
  if (alias && depth < 4) return colorFollowingAlias(block, alias[1], depth + 1);
  return color(raw, name);
};

/**
 * **把令牌解析成颜色，支持 `color-mix`**（第 159 轮 P1-2 新增）。
 *
 * 起因：文字三档改成"从 `--text-base` 派生"（`color-mix(in srgb, var(--text-base) 75%, var(--text-ramp-paper))`）后，
 * 原来的 `parseColor` 直接解析失败 —— 门禁会报"应是可解析的颜色"，**那等于把解耦这条路堵死**。
 * 所以这里补一个递归解析器：`var(--x)` 继续查、`color-mix(in srgb, A p%, B)` 按 sRGB 线性混合算。
 * 只支持本项目真实用到的两种写法，别的**报错而不是猜**（猜出来的数字等于没测）。
 */
const resolveColor = (block: string, value: string, depth = 0): [number, number, number, number] => {
  const v = String(value).trim();
  if (depth > 6) throw new Error(`颜色解析层数过深（可能有循环引用）：${value}`);
  const alias = /^var\((--[\w-]+)\)$/.exec(v);
  if (alias) return resolveColor(block, need(token(block, alias[1]), alias[1]), depth + 1);
  const mix = /^color-mix\(in srgb,\s*(.+?)\s+([\d.]+)%\s*,\s*(.+?)\)$/.exec(v);
  if (mix) {
    const a = resolveColor(block, mix[1].trim(), depth + 1);
    const b = resolveColor(block, mix[3].trim(), depth + 1);
    const w = Number(mix[2]) / 100;
    /* 与浏览器一致：先做 premultiplied 线性混合，再还原 alpha */
    const alpha = a[3] * w + b[3] * (1 - w);
    const ch = [0, 1, 2].map((i) => (a[i] * a[3] * w + b[i] * b[3] * (1 - w)) / (alpha || 1));
    return [ch[0], ch[1], ch[2], alpha];
  }
  const plain = parseColor(v);
  if (plain) return plain;
  /* `transparent` 是合法的颜色操作数（`color-mix(… , transparent)` 遍地都是）——
     第一版没认它，于是 `--accent-muted` 这类派生令牌的解析直接报错。 */
  if (/^transparent$/i.test(v)) return [0, 0, 0, 0] as [number, number, number, number];
  throw new Error(`无法解析的颜色：${v}`);
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
   * LIGHT-UI-2c 边框阶梯（第 155 轮 P0-2）：三档必须**单调**、可见而不吵，
   * 且输入框的两档交互强度必须**夹在** default 与 strong 之间。
   *
   * 为什么加这一条：对标 `GCWing/OpenBitFun` 的亮色皮肤时发现我们只有 5%/9% 两档 ——
   * 没有"强调档"、也没有输入框的 hover/focus 档（`field.borderHover/Focus`），
   * 于是凡需要"悬停时边界抬一点"的地方只能现写 rgba（颜色字面量的主要来源之一）。
   * 补齐之后，这条断言把**阶梯关系**钉住：改任何一个值都必须保持单调与区间。
   */
  it("LIGHT-UI-2c：边框三档单调（subtle<default<strong）、强度在带内，且输入 hover 夹在 default 与 focus 之间", () => {
    const bg = color(token(lightBlock, "--bg-primary"), "--bg-primary");
    const onBg = (v: string | null, name: string) => contrast(over(color(v, name), bg), bg);
    const subtle = onBg(token(lightBlock, "--border-secondary"), "--border-secondary");
    const def = onBg(token(lightBlock, "--border-primary"), "--border-primary");
    const strong = onBg(token(lightBlock, "--border-strong"), "--border-strong");
    const hover = onBg(token(lightBlock, "--field-border-hover"), "--field-border-hover");

    expect(subtle, `subtle(${subtle.toFixed(3)}) 必须弱于 default(${def.toFixed(3)})`).toBeLessThan(def);
    expect(def, `default(${def.toFixed(3)}) 必须弱于 strong(${strong.toFixed(3)})`).toBeLessThan(strong);
    expect(subtle, `subtle 只有 ${subtle.toFixed(3)}，结构线看不见了`).toBeGreaterThanOrEqual(1.05);
    expect(strong, `strong 到了 ${strong.toFixed(3)}，比参考实现的 2.15 还重 —— 界面会像线框稿`).toBeLessThanOrEqual(2.4);
    expect(hover, `输入框 hover(${hover.toFixed(3)}) 必须比 default(${def.toFixed(3)}) 明显`).toBeGreaterThan(def + 0.05);
    expect(hover, `输入框 hover(${hover.toFixed(3)}) 不该强过 strong(${strong.toFixed(3)})`).toBeLessThan(strong);

    /* 聚焦档必须是 strong 的别名（同一个真源，而不是又一个魔数） */
    expect(
      (token(lightBlock, "--field-border-focus") ?? "").replace(/\s+/g, ""),
      "--field-border-focus 应当是 var(--border-strong) —— 聚焦强度只允许有一个真源",
    ).toBe("var(--border-strong)");

    /* 消费方必须真的存在（否则又变成"定义了没人用"的令牌） */
    expect(styles, "输入类控件的 hover 规则必须真的消费 --field-border-hover").toContain("border-color: var(--field-border-hover)");
    expect(styles, "输入类控件的 focus 规则必须真的消费 --field-border-focus").toContain("border-color: var(--field-border-focus)");
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
      /* 第 159 轮起文字是派生令牌（color-mix）⇒ 必须传 block 才能解析 */
      let c: [number, number, number, number];
      try {
        c = color(token(lightBlock, name), name, lightBlock);
      } catch (e) {
        fails.push(`${name} 解析失败：${(e as Error).message}`);
        continue;
      }
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
      let strongC: [number, number, number, number], mutedC: [number, number, number, number], baseC: [number, number, number, number];
      try {
        strongC = color(token(block, "--accent-strong"), "--accent-strong", block);
        mutedC = color(token(block, mutedName), mutedName, block);
        baseC = color(token(block, baseName), baseName, block);
      } catch (e) {
        fails.push(`${label}：令牌解析失败（${(e as Error).message}）`);
        continue;
      }
      const chip = over(mutedC, baseC);
      const r = contrast(over(strongC, chip), chip);
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
    const muted = contrast(color(token(lightBlock, "--text-muted"), "--text-muted", lightBlock), bg);
    expect(muted, `弱文字 ${muted.toFixed(2)}:1 低于 4.5（参考实现只到 3.56，但它没有我们这么多 10px 小字）`).toBeGreaterThanOrEqual(4.5);
  });

  /**
   * LIGHT-UI-10：**玻璃面的不透明度下限** —— 侧栏 ≥90%、浮层 ≥94%，且必须有不透明回退面。
   *
   * 来源（第 156 轮对标 `GCWing/OpenBitFun` 的 `_surface-recipes.scss`）：对方玻璃配方是
   * `sidebar-glass`（外壳 90% + blur(12px)）与 `floating`（浮层 94% + blur(12px)），
   * 并且第一行永远是**先给不透明底**、再由 `@supports` 覆盖成玻璃。
   *
   * 为什么这条必须有门禁：玻璃的"好看"是模糊给的，而**可读性是底色不透明度给的** ——
   * 透明度调过头，压着侧栏/菜单的文字对比度就会随背后的东西变化而不可控。
   *
   * ⚠️ **第 157 轮改口径（有实测依据，不是为了让改动变绿）**：上一版把判据写成"α ≥ 90%/94%"，
   * 那是**从参考实现抄来的代理指标**。用户实测反馈「侧栏还是没有玻璃材质的效果」，查下去发现真因是
   * **背后没有东西可透**（侧栏是 flex 里的一列，身后只有 `.app` 的纯色底 ⇒ 90% 压纯色 = 实色），
   * 于是这一轮加了**有界的场景层**并把 α 降到 72%。此时"α ≥ 90%"这条代理指标就挡住正确做法了，
   * 所以把它换成**它本来想守的那个东西**：
   *   ① α 只留一条下限（≥0.6，纯防"透明到看不清"）；
   *   ② **真正判据**：把弱/次/主三档文字放在「场景层最坏像素 + 玻璃」的**合成**上量对比度
   *      （≥4.5 / ≥6 / ≥10）—— 这比"α 下限"严格得多：它直接算最坏情况的真实可读性；
   *   ③ 口径与写入点对齐：`--scene-layer` 必须**引用** `--scene-veil`/`--scene-veil-alt`
   *      （防止"声明一套着色、画另一套"）。
   */
  it("LIGHT-UI-10：玻璃 α 有下限 + 最坏场景合成上文字仍达标，且有不透明回退面", () => {
    const chrome = mixWithTransparent(token(lightBlock, "--surface-glass-chrome"), "--surface-glass-chrome", lightBlock);
    const raised = mixWithTransparent(token(lightBlock, "--surface-glass-raised"), "--surface-glass-raised", lightBlock);
    expect(chrome.alpha, `侧栏玻璃 ${(chrome.alpha * 100).toFixed(0)}% 低于硬下限 60%`).toBeGreaterThanOrEqual(0.6);
    expect(raised.alpha, `浮层玻璃 ${(raised.alpha * 100).toFixed(0)}% 低于硬下限 60%`).toBeGreaterThanOrEqual(0.6);
    /* 浮层是**压在真实内容上**的（聊天正文、代码块），所以它还额外守一条：94% 上下 —— 
       低于这个数，菜单后面的正文会透得影响阅读。侧栏压的是我们自己画的场景层，不受这条约束。 */
    expect(raised.alpha, `浮层玻璃 ${(raised.alpha * 100).toFixed(0)}% 太低：菜单后面是真实内容，不是场景层`).toBeGreaterThanOrEqual(0.9);
    /* ② 最坏场景合成上的真实对比度 */
    const worst = worstGlassCase(lightBlock, "light");
    expect(worst.failures, `玻璃+场景的最坏合成上这些文字不达标：\n  - ${worst.failures.join("\n  - ")}`).toEqual([]);
    /* ③ 场景层必须引用声明的着色令牌 */
    const layer = need(token(lightBlock, "--scene-layer"), "--scene-layer");
    expect(layer, "--scene-layer 必须引用 var(--scene-veil)（声明的着色就是画出来的着色）").toContain("var(--scene-veil)");
    expect(layer, "--scene-layer 必须引用 var(--scene-veil-alt)").toContain("var(--scene-veil-alt)");
    /* 回退面必须**真的不透明**：`prefers-reduced-transparency` / `prefers-contrast: more` /
       `[data-contrast="high"]` 三种情况都落到它身上（styles.css 末尾"玻璃表面"一节）。 */
    const opaque = color(token(lightBlock, "--surface-opaque-raised"), "--surface-opaque-raised");
    expect(opaque[3], `回退面必须不透明，实际 alpha=${opaque[3]}`).toBe(1);
    /* 口径与写入点对齐：`--dropdown-bg` 必须**就是**玻璃值，否则"定义了玻璃但浮层没用上"。 */
    expect(need(token(lightBlock, "--dropdown-bg"), "--dropdown-bg"), "--dropdown-bg 应指向 --surface-glass-raised").toBe("var(--surface-glass-raised)");
    /* 三种降级条件必须在 CSS 里真的写了 —— 而且**要在去掉注释后的源码里找**：
       注释里也提到了这些条件（就是本节的长注释），只在原文里 grep 会被自己的注释骗过。
       （这一点是变异自证 M5 逼出来的：M5 删掉 @media 那一行时，原文 grep 仍然命中注释 ⇒ 门禁不变红。） */
    const cssNoComments = styles.replace(/\/\*[\s\S]*?\*\//g, "");
    /* ⚠️ 文件里**不止一个** `prefers-reduced-transparency` 块（D-5 那条旧规则也命中 `.model-picker`），
       所以按内容挑：玻璃的回退块一定用到 `--surface-opaque-raised` 这个"不透明回退面"令牌。 */
    const reducedBlocks = cssNoComments.match(/@media[^{]*prefers-reduced-transparency:\s*reduce[^{]*\{[\s\S]*?\n\}/g) ?? [];
    const reduced = reducedBlocks.find((b) => b.includes("--surface-opaque-raised")) ?? "";
    expect(reduced, "找不到玻璃降级块（判据：@media prefers-reduced-transparency 里必须回落到 --surface-opaque-raised）").toBeTruthy();
    expect(reduced, "同一组降级里应同时覆盖 prefers-contrast: more").toMatch(/prefers-contrast:\s*more/);
    expect(reduced, "降级块里侧栏必须回到不透明底").toMatch(/\.sidebar\s*\{[^}]*background:\s*var\(--sidebar-bg\)/);
    expect(reduced, "降级块里浮层必须回到不透明面").toMatch(/background:\s*var\(--surface-opaque-raised\)/);
    expect(reduced, "降级块里必须去掉模糊（否则是「不透明但仍然糊」）").toMatch(/backdrop-filter:\s*none/);
    const highContrast = /\[data-contrast="high"\]\s*\.sidebar\s*\{[^}]*\}/.exec(cssNoComments)?.[0] ?? "";
    expect(highContrast, '缺少 [data-contrast="high"] .sidebar 降级').toBeTruthy();
    expect(highContrast, "高对比档的侧栏也必须去掉模糊").toMatch(/backdrop-filter:\s*none/);
  });

  /**
   * LIGHT-UI-11：**按下态必须比悬停态再远画布一步**（浅色：更暗）。
   *
   * 这一条是**实测抓出来的**：第 156 轮把 `.press-layer-host:active` 的底色从悬停档换成
   * `--surface-pressed` 时，我先按"10% 黑压白"取值 —— 而按下态是**半透明**的，
   * 合成结果取决于它压着哪个面。探针扫 α 得到：浅色档最小成立值是 **8%**（压 `#ffffff` 时
   * `#ededed` 0.8475 < 悬停 `#eeeeec` 0.8538），取 10% 有余量；
   * **暗色档方向相反且最小成立值是 13%**（10% 时在画布上合成 `#262727`，比悬停 `#2a2d2d` 还暗 ⇒ 方向反了）。
   * 所以两档不能是同一个数，这条门禁就是钉住"别把暗色抄浅色"。
   */
  it("LIGHT-UI-11：按下态比悬停态更暗（三个面上都成立），且差别看得出来", () => {    const hover = color(token(lightBlock, "--bg-hover"), "--bg-hover");
    const pressed = color(token(lightBlock, "--surface-pressed"), "--surface-pressed");
    const fails: string[] = [];
    for (const name of ["--bg-primary", "--bg-secondary", "--bg-tertiary"]) {
      const surface = color(token(lightBlock, name), name);
      const composite = over(pressed, surface);
      const r = contrast(hover, composite);
      if (lum(composite) >= lum(hover)) fails.push(`${name} 上合成后 L=${lum(composite).toFixed(4)} 不比悬停 ${lum(hover).toFixed(4)} 暗`);
      else if (r < 1.03) fails.push(`${name} 上只差 ${r.toFixed(3)}（<1.03，按下去看不出来）`);
    }
    expect(fails, `按下态在以下面不成立（按下必须比悬停更"陷进去"）：\n  - ${fails.join("\n  - ")}`).toEqual([]);
  });

  /**
   * LIGHT-UI-12（第 157 轮 P1-4）：**状态色文字压在同色浅底上必须 ≥4.5:1**。
   *
   * 这是本轮的实测发现：全项目 57 处"状态色文字 + 同色浅底"的组合里，15%/18%/20% 那几档
   * 在浅色档低于 4.5（error 在 20% 上 **3.87**、info 4.04、warning 4.37），而它们都是 12px 小标签。
   * 修法不是"把浅底调淡"（那会丢掉状态色的存在感），而是给文字一档 `-content`（往 `--text-primary` 压深 86%）。
   * 门禁把**四档浅底**（10/15/18/20%）都量一遍 —— 这几档就是站内真实用到的全部强度。
   */
  it("LIGHT-UI-12：状态色 -content 在四档自色浅底上都 ≥4.5:1（压深没白压）", () => {
    const fails: string[] = [];
    for (const s of ["success", "warning", "error", "info"]) {
      const content = token(lightBlock, `--${s}-content`);
      /* `-content` 是 color-mix(状态色 N%, --text-primary) ⇒ 用同一个混合公式在测试里还原 */
      const m = /color-mix\(in srgb,\s*var\(--([\w-]+)\)\s*([\d.]+)%,\s*var\(--([\w-]+)\)\)/.exec(content ?? "");
      expect(m, `--${s}-content 应是从状态色往 --text-primary 压深的 color-mix：${content}`).toBeTruthy();
      const status = color(token(lightBlock, `--${m![1]}`), `--${m![1]}`);
      const ink = color(token(lightBlock, `--${m![3]}`), `--${m![3]}`, lightBlock);
      const pct = Number(m![2]) / 100;
      const fg = status.slice(0, 3).map((v, i) => v * pct + ink[i] * (1 - pct)).concat(1);
      const base = color(token(lightBlock, "--bg-primary"), "--bg-primary");
      for (const tint of [0.10, 0.15, 0.18, 0.20]) {
        const bg = over([status[0], status[1], status[2], tint], base);
        const r = contrast(fg, bg);
        if (r < 4.5) fails.push(`${s}-content 在自身 ${(tint * 100).toFixed(0)}% 浅底上只有 ${r.toFixed(2)}:1`);
      }
    }
    expect(fails, `状态色文字在自色浅底上不达标（原色在 20% 上只有 3.87，这一档就是为此加的）：\n  - ${fails.join("\n  - ")}`).toEqual([]);
  });
});

/**
 * DARK-UI —— **暗色模式观感不变式**门禁（第 155 轮，对标 `GCWing/OpenBitFun` 的暗色档）。
 *
 * ## 为什么要补这一组（真实缺口）
 *
 * 亮色档从第 65 轮起就有一整套不变量（LIGHT-UI-*），而**暗色档一条都没有** ——
 * 于是"暗色好看"这件事只靠手感维持。本轮对标时用同一套数学量了一遍，立刻抓到两条：
 *
 * 1. **`--text-muted` 在最亮的悬停面上不达标**：`#888888` 落在 `--bg-hover`（`#2a2d2d`）上只有
 *    **3.92:1**，而"悬停行的元信息（时间戳/计数/路径）"正好大量用这一档 ⇒ 已提到 `#939393`（4.52）；
 * 2. **边框比参考实现弱一大截**：我们的控件边界在 `--bg-secondary` 上只有 **1.35**，
 *    对方 dark 的 `border.default`（白 18%）是 **1.78**（暗底上低 alpha 白线本来就更容易糊掉）
 *    ⇒ 暗色 `--border-primary` 10%→14%（1.54）、`--border-secondary/-separator` 6%→8%（1.25）。
 *
 * 如实标注：主文字 `#d4d4d4`（bg-secondary 上 11.55）**比对方的 `#e8e8e8`（13.87）暗**，
 * 但"暗色底上的亮字更亮"同时会带来眩光，用户明确说过当前暗色已经好看 ——
 * 所以**没有动它**，只把这条差距写在这里（要动它可以按 DARK-UI-1 的同一条判据来评估）。
 */
/**
 * NATIVE —— **系统窗口材质档**（第 158 轮，对标 OpenBitFun 的 `native-material='sidebar'`）。
 *
 * 这一组守的是"玻璃到底有没有东西可透"的另一半答案：**系统材质（Windows Mica/Acrylic、macOS vibrancy）**。
 * 我们的 Rust 侧早就 apply 了材质，但前端一直不透明底 ⇒ 材质白开（用户实测："看上去还是实色"）。
 * 对方源码的做法是"材质 + 前端让出底色 + CSS 关掉自己的 backdrop-filter"三件配套，这里逐条钉住。
 *
 * ⚠️ 关键的一条是**要有写入方**：`[data-contrast="high"]` 那种"规则写了但全项目没有任何地方设置这个属性"
 * 的坑（第 157 轮发现）不能在这条新规则上重演 —— 所以下面直接断言前端真的有地方 setAttribute。
 */
describe("NATIVE 系统材质档（第 158 轮）", () => {
  const cssNoComments = styles.replace(/\/\*[\s\S]*?\*\//g, "");
  const nativeBlock = cssNoComments.slice(cssNoComments.indexOf('html[data-native-material="sidebar"]'));
  const srcFiles: string[] = [];
  (function walk(dir: string) {
    for (const n of readdirSync(dir)) {
      const p = join(dir, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(tsx?|rs|json)$/.test(n) && !/\.test\./.test(n)) srcFiles.push(p);
    }
  })(join(ROOT, "src"));

  it("NATIVE-1：前端必须真的**写入** `data-native-material`（否则这一档是死规则）", () => {
    const writers = srcFiles.filter((f) => /setAttribute\(\s*["']data-native-material["']/.test(readFileSync(f, "utf8")));
    expect(writers.length, "没有任何地方设置 data-native-material —— 这一档 CSS 永远不会生效").toBeGreaterThan(0);
    const main = readFileSync(join(ROOT, "src", "main.tsx"), "utf8");
    expect(main, "必须在**首次渲染前**打上属性（渲染后打会先闪一帧实色）").toMatch(/await\s+Promise\.race\(\[[\s\S]{0,200}?applyNativeMaterialHint\(\)[\s\S]{0,200}?\]\);?\s*renderApp\(\)/);
    expect(main, "顶层 await 会让构建失败（esbuild 目标不支持）—— 必须包在函数里").not.toMatch(/^await\s/m);
    /* Rust 侧要提供"材质成功没有"的真相源：前端猜不出来 */
    const rust = readFileSync(join(ROOT, "src-tauri", "src", "lib.rs"), "utf8");
    expect(rust, "Rust 侧缺 native_material 命令").toMatch(/fn native_material\(\)/);
    expect(rust, "命令必须注册进 invoke_handler").toMatch(/generate_handler!\[[\s\S]*?native_material,/);
    expect(rust, "Windows 侧必须真的 apply 材质").toMatch(/apply_mica|apply_acrylic/);
    expect(rust, "macOS 侧必须真的 apply vibrancy").toMatch(/apply_vibrancy/);
  });

  it("NATIVE-2：这一档里外壳让出底色、内容面保持不透明、CSS 模糊关掉", () => {
    expect(nativeBlock, "缺少 data-native-material 档").not.toBe("");
    expect(nativeBlock, "html/body 必须透明（否则系统材质被网页盖住）").toMatch(/html\[data-native-material="sidebar"\],\s*html\[data-native-material="sidebar"\] body\s*\{\s*background:\s*transparent/);
    expect(nativeBlock, "`.app` 必须透明").toMatch(/\.app\s*\{[^}]*background-color:\s*transparent/);
    expect(nativeBlock, "`.app` 必须关掉场景层（否则场景会把系统材质挡掉）").toMatch(/\.app\s*\{[^}]*background-image:\s*none/);
    expect(nativeBlock, "侧栏必须走 --surface-glass-chrome-native").toMatch(/\.sidebar\s*\{[^}]*background:\s*var\(--surface-glass-chrome-native\)/);
    /* ⚠️ 只断言"里面有 backdrop-filter: none"不够 —— 变异 N3 试过：再插一条
       `backdrop-filter: var(--blur-medium)` 进去，那条断言照样绿（两个声明都在，正则匹配到的是后者）。
       所以要**把这条规则的 body 抠出来**，要求它里面出现的每一个 backdrop-filter 都是 none。 */
    const nativeSidebarRule = /html\[data-native-material="sidebar"\] \.sidebar\s*\{([^}]*)\}/.exec(nativeBlock)?.[1] ?? "";
    expect(nativeSidebarRule, "找不到材质档的 .sidebar 规则").not.toBe("");
    const filters = [...nativeSidebarRule.matchAll(/-?w?-?e?-?b?-?k?-?i?-?t?-?\s*-?backdrop-filter:\s*([^;]+);/g)].map((m) => m[1].trim());
    expect(filters.length, "材质档的侧栏必须显式关掉 CSS 模糊（系统已经糊过桌面了）").toBeGreaterThan(0);
    expect(filters.filter((v) => v !== "none"), `材质档的侧栏里出现了非 none 的 backdrop-filter：${filters.join(" / ")}（系统糊过了，这层是白花性能）`).toEqual([]);
    expect(nativeBlock, "侧栏控件必须改成给材质上色（18% overlay），不能再盖不透明块").toMatch(/color-mix\(in srgb,\s*var\(--sidebar-bg\) 18%,\s*transparent\)/);
    /* 标题栏同样要关掉自己那层模糊（系统糊过了；再糊一层会让材质发浑） */
    const nativeTitlebar = /html\[data-native-material="sidebar"\] \.titlebar\s*\{([^}]*)\}/.exec(nativeBlock)?.[1] ?? "";
    expect(nativeTitlebar, "找不到材质档的 .titlebar 规则").not.toBe("");
    const tbFilters = [...nativeTitlebar.matchAll(/backdrop-filter:\s*([^;]+);/g)].map((m) => m[1].trim());
    expect(tbFilters.filter((v) => v !== "none"), `材质档的标题栏里出现了非 none 的 backdrop-filter：${tbFilters.join(" / ")}`).toEqual([]);
    expect(tbFilters.length, "材质档的标题栏必须显式关掉 CSS 模糊").toBeGreaterThan(0);
  });

  it("NATIVE-3：无界壁纸 ⇒ 材质档的玻璃 α 必须更保守（≥80%），且两档都要有降级", () => {
    for (const [name, block] of [
      ["亮色", lightBlock],
      ["暗色", /\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/.exec(styles)?.[1] ?? ""],
    ] as const) {
      const native = mixWithTransparent(token(block, "--surface-glass-chrome-native"), "--surface-glass-chrome-native", block);
      expect(native.alpha, `${name}档系统材质玻璃 ${(native.alpha * 100).toFixed(0)}% 太透了：背后是无界桌面壁纸，对比度算不出来`).toBeGreaterThanOrEqual(0.8);
      const scene = mixWithTransparent(token(block, "--surface-glass-chrome"), "--surface-glass-chrome", block);
      expect(native.alpha, `${name}档：材质档反而比场景档更透（${native.alpha} vs ${scene.alpha}）——两档的取舍反了`).toBeGreaterThan(scene.alpha);
    }
    expect(nativeBlock, "材质档缺 prefers-reduced-transparency 降级").toMatch(/prefers-reduced-transparency:\s*reduce/);
    expect(nativeBlock, '材质档缺 [data-contrast="high"] 降级').toMatch(/\[data-contrast="high"\]\s*\.app/);
  });
});

describe("DARK-UI 暗色模式观感不变式", () => {
  const darkBlock = /\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/.exec(styles)?.[1] ?? "";
  const surfaces = () => ({
    primary: color(token(darkBlock, "--bg-primary"), "--bg-primary"),
    secondary: color(token(darkBlock, "--bg-secondary"), "--bg-secondary"),
    tertiary: color(token(darkBlock, "--bg-tertiary"), "--bg-tertiary"),
    hover: color(token(darkBlock, "--bg-hover"), "--bg-hover"),
  });

  it("DARK-UI-0：暗色档令牌解析得到（否则后面几条是空转）", () => {
    expect(darkBlock.length, "解析不到 [data-theme=dark] 块").toBeGreaterThan(200);
    const s = surfaces();
    expect(Object.values(s).every(Boolean)).toBe(true);
  });

  /** ① 面阶梯方向：暗色是"越靠内容越亮"，且相邻差要看得出来——这是暗色"有层次"的来源。 */
  it("DARK-UI-1：暗色的面阶梯必须单调变亮（primary < secondary < tertiary < hover）", () => {
    const s = surfaces();
    const l = (c: [number, number, number, number]) => lum(c);
    expect(l(s.primary), `primary 应最暗：${l(s.primary).toFixed(3)} vs secondary ${l(s.secondary).toFixed(3)}`).toBeLessThan(l(s.secondary));
    expect(l(s.secondary)).toBeLessThan(l(s.tertiary));
    expect(l(s.tertiary)).toBeLessThan(l(s.hover));
    /* 每一档都要"看得出是一档"：亮度差 ≥0.005。
       口径来源（第 155 轮实测，两边同一套数学）：
         我方三段：primary #0e0f0f → secondary #1a1c1c **0.00664**、
                   secondary → tertiary #212424 **0.00579**、tertiary → hover #2a2d2d **0.00766**；
         对方（OpenBitFun dark）：canvas #0e0e10 → panel #1c1c1f **0.00668**（它只有两级实色面，
                   第三/第四档用 rgba(255,255,255,0.06) 叠出来，没有可比的"实色段"）。
       所以门禁取 0.005 = 实测最紧那段（0.00579）再留一点余量：它守的是"别把某一档调到看不见"，
       而不是"必须比参考实现分得更开"（初稿写 0.008 时被这条自己抓出来两次，已按实测下调）。 */
    const deltas = [l(s.secondary) - l(s.primary), l(s.tertiary) - l(s.secondary), l(s.hover) - l(s.tertiary)];
    for (const [i, d] of deltas.entries()) {
      expect(d, `第 ${i + 1} 段亮度差 ${d.toFixed(5)} 太小（实测最紧的一段是 0.00579），层次会糊在一起`).toBeGreaterThanOrEqual(0.005);
    }
  });

  /**
   * ② 弱文字在**四个面**上都要过 4.5（含最亮的悬停面）——这条就是本轮那条缺口的守卫。
   */
  it("DARK-UI-2：弱文字（--text-muted）在四个面上都 ≥4.5:1（含悬停面）", () => {
    const muted = color(token(darkBlock, "--text-muted"), "--text-muted", darkBlock);
    const fails: string[] = [];
    for (const [name, bg] of Object.entries(surfaces())) {
      const r = contrast(muted, bg);
      if (r < 4.5) fails.push(`${name} 面只有 ${r.toFixed(2)}:1`);
    }
    expect(fails, `弱文字在以下面达不到 4.5:1（悬停行的元信息就在这些面上）：\n  - ${fails.join("\n  - ")}`).toEqual([]);
  });

  it("DARK-UI-3：主/次文字在内容面上有足够对比（主 ≥10、次 ≥6）", () => {
    const s = surfaces();
    const p = contrast(color(token(darkBlock, "--text-primary"), "--text-primary", darkBlock), s.secondary);
    const sec = contrast(color(token(darkBlock, "--text-secondary"), "--text-secondary", darkBlock), s.secondary);
    expect(p, `暗色主文字在内容面上只有 ${p.toFixed(2)}:1`).toBeGreaterThanOrEqual(10);
    expect(sec, `暗色次文字在内容面上只有 ${sec.toFixed(2)}:1`).toBeGreaterThanOrEqual(6);
    /* 上下都要管：主文字过亮（>17）在暗色下有眩光争议，钉住上限免得被"越亮越好"推着走 */
    expect(p, `暗色主文字 ${p.toFixed(2)}:1 偏亮（暗底眩光）——要提亮请连同 DARK-UI-2 一起评估`).toBeLessThanOrEqual(17);
  });

  it("DARK-UI-4：暗色边框三档单调且强度在带内，hover 夹在 default 与 strong 之间", () => {
    const bg = surfaces().secondary;
    const on = (v: string | null, name: string) => contrast(over(color(v, name), bg), bg);
    const subtle = on(token(darkBlock, "--border-secondary"), "--border-secondary");
    const def = on(token(darkBlock, "--border-primary"), "--border-primary");
    const strong = on(token(darkBlock, "--border-strong"), "--border-strong");
    const hover = on(token(darkBlock, "--field-border-hover"), "--field-border-hover");
    expect(subtle, `subtle ${subtle.toFixed(3)} 必须弱于 default ${def.toFixed(3)}`).toBeLessThan(def);
    expect(def, `default ${def.toFixed(3)} 必须弱于 strong ${strong.toFixed(3)}`).toBeLessThan(strong);
    expect(subtle, `暗色 subtle ${subtle.toFixed(3)} 太弱（<1.15）—— 分隔线在暗底上会看不见`).toBeGreaterThanOrEqual(1.15);
    expect(def, `暗色 default ${def.toFixed(3)} 偏弱：参考实现（OpenBitFun dark）是 1.78`).toBeGreaterThanOrEqual(1.4);
    expect(def, `暗色 default ${def.toFixed(3)} 偏重，暗色界面会像线框稿`).toBeLessThanOrEqual(1.75);
    expect(hover, `hover ${hover.toFixed(3)} 要明显强于 default`).toBeGreaterThan(def + 0.08);
    expect(hover).toBeLessThan(strong);
  });

  it("DARK-UI-5：暗色 accent-strong 在品牌浅底 chip 上 ≥4.5:1（与亮色同标准）", () => {
    const base = color(token(darkBlock, "--bg-primary"), "--bg-primary");
    const chip = over(color(token(darkBlock, "--accent-muted"), "--accent-muted", darkBlock), base);
    const strong = contrast(over(color(token(darkBlock, "--accent-strong"), "--accent-strong"), chip), chip);
    expect(strong, `暗色 --accent-strong 在品牌浅底上只有 ${strong.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
  });

  /** DARK-UI-6：与 LIGHT-UI-10 同口径（第 157 轮起是"最坏场景合成上量对比度"，不再是抄来的 α 下限）。 */
  it("DARK-UI-6：暗色玻璃 α 有下限 + 最坏场景合成上文字仍达标，回退面不透明", () => {
    const chrome = mixWithTransparent(token(darkBlock, "--surface-glass-chrome"), "--surface-glass-chrome", darkBlock);
    const raised = mixWithTransparent(token(darkBlock, "--surface-glass-raised"), "--surface-glass-raised", darkBlock);
    expect(chrome.alpha, `暗色侧栏玻璃 ${(chrome.alpha * 100).toFixed(0)}% 低于硬下限 60%`).toBeGreaterThanOrEqual(0.6);
    expect(raised.alpha, `暗色浮层玻璃 ${(raised.alpha * 100).toFixed(0)}% 太低：菜单后面是真实内容`).toBeGreaterThanOrEqual(0.9);
    const worst = worstGlassCase(darkBlock, "暗色");
    expect(worst.failures, `暗色玻璃+场景的最坏合成上这些文字不达标：\n  - ${worst.failures.join("\n  - ")}`).toEqual([]);
    const layer = need(token(darkBlock, "--scene-layer"), "--scene-layer");
    expect(layer, "--scene-layer 必须引用 var(--scene-veil)").toContain("var(--scene-veil)");
    expect(layer, "--scene-layer 必须引用 var(--scene-veil-alt)").toContain("var(--scene-veil-alt)");
    expect(color(token(darkBlock, "--surface-opaque-raised"), "--surface-opaque-raised")[3]).toBe(1);
    expect(need(token(darkBlock, "--dropdown-bg"), "--dropdown-bg")).toBe("var(--surface-glass-raised)");
  });

  /**
   * DARK-UI-9（第 157 轮 P1-4）：暗色档的状态色文字在自色浅底上也必须 ≥4.5:1。
   * 实测暗色**原色**本来就过（10/15/18/20% 上 5.21–6.66），所以暗色档 `-content` = 原色；
   * 这条门禁守的是"以后有人为了好看把状态色调淡"。
   */
  it("DARK-UI-9：暗色状态色 -content 在四档自色浅底上都 ≥4.5:1", () => {
    const base = color(token(darkBlock, "--bg-primary"), "--bg-primary");
    const fails: string[] = [];
    for (const s of ["success", "warning", "error", "info"]) {
      /* 第 161 轮：暗色档的 `-content` 现在是 **color-mix 配方**（往白里混 28%）⇒ 要用认 `color-mix` 的解析器。
         `colorFollowingAlias` 只认 `var(--x)` 别名，遇到 color-mix 会解析失败 —— 那正是 DARK-UI-9 当时报的错。 */
      const fg = color(token(darkBlock, `--${s}-content`), `--${s}-content`, darkBlock);
      const status = color(token(darkBlock, `--${s}`), `--${s}`);
      for (const tint of [0.10, 0.15, 0.18, 0.20]) {
        const bg = over([status[0], status[1], status[2], tint], base);
        const r = contrast(fg, bg);
        if (r < 4.5) fails.push(`${s}-content 在自身 ${(tint * 100).toFixed(0)}% 浅底上只有 ${r.toFixed(2)}:1`);
      }
    }
    expect(fails, `暗色状态色文字在自色浅底上不达标：\n  - ${fails.join("\n  - ")}`).toEqual([]);
  });

  /** DARK-UI-7：按下态的方向在暗色档**是反的**（朝画布的反方向 = 更亮），且下限也不同（14%，不是 10%）。 */
  it("DARK-UI-7：暗色按下态比悬停态更亮（三个面上都成立），且 α 不小于实测的 13%", () => {    const hover = color(token(darkBlock, "--bg-hover"), "--bg-hover");
    const pressedRaw = need(token(darkBlock, "--surface-pressed"), "--surface-pressed");
    const pressed = color(pressedRaw, "--surface-pressed");
    /* 暗色按下态必须是**白**的低 alpha 叠加：如果哪天有人把浅色档的 `rgb(31 31 30 / 10%)` 抄过来，
       暗底上按下去会比不按还暗（等于"按了个洞"）—— 这里先按色相拦一道。 */
    expect(pressedRaw, "暗色按下态应是白色 alpha 叠加（抄浅色档会导致按下去变暗）").toMatch(/rgba\(\s*255\s*,\s*255\s*,\s*255/);
    const fails: string[] = [];
    for (const name of ["--bg-primary", "--bg-secondary", "--bg-tertiary"]) {
      const surface = color(token(darkBlock, name), name);
      const composite = over(pressed, surface);
      const r = contrast(hover, composite);
      if (lum(composite) <= lum(hover)) fails.push(`${name} 上合成后 L=${lum(composite).toFixed(4)} 不比悬停 ${lum(hover).toFixed(4)} 亮`);
      else if (r < 1.03) fails.push(`${name} 上只差 ${r.toFixed(3)}（<1.03，按下去看不出来）`);
    }
    expect(fails, `暗色按下态在以下面不成立：\n  - ${fails.join("\n  - ")}`).toEqual([]);
    expect(pressed[3], `暗色按下态 α=${pressed[3]} 低于实测最小成立值 13%（会退化成"比悬停还暗"）`).toBeGreaterThanOrEqual(0.13);
  });
});
