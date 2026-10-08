/**
 * ★ 第 185 波（用户报「梦幻皮肤里项目和全局对话的底色是白色」）：**皮肤毛玻璃必须压得住原生材质档**。
 *
 * ## 缺陷机制（真机 A/B 实测，不是推理）
 *
 * `styles.css` 的原生材质档里有：
 * ```
 * html[data-native-material="sidebar"] .sidebar { backdrop-filter: none; }
 * ```
 * 它的特异性是 **(0,2,1)**（`html` 类型 + 属性 + 类），而梦幻皮肤的
 * `[data-skin="dream"] .sidebar { backdrop-filter: blur(...) }` 是 **(0,2,0)**
 * ⇒ **不加 `!important` 就会被干掉**。
 *
 * 真机 A/B（同一底色 `rgba(255,255,255,0.65)`）：
 * · 带 `data-native-material="sidebar"` ⇒ `backdrop-filter: none`
 * · 去掉该属性 ⇒ `backdrop-filter: blur(12px)`
 * 也就是说「白」不是底色问题，而是**模糊被关掉了**：只剩 65% 白底、后面什么都没有。
 *
 * 为什么在梦幻皮肤下必须保住模糊：那条原生材质规则的注释写着"系统已经糊过桌面了"——
 * 它糊的是**桌面**；而梦幻皮肤的壁纸是**画在 webview 内部**的一层 DOM（`--dream-bg-image`），
 * 系统材质糊不到它 ⇒ 关掉 CSS 模糊后，侧栏后面什么都不剩。
 *
 * ## 判据
 *
 * | # | 判据 |
 * | --- | --- |
 * | SKIN-BLUR-1 | **凡是会被原生材质档 `backdrop-filter: none` 压掉的那些选择器**（本仓库当前是 `.sidebar` / `.titlebar`），皮肤里给它们设的 `blur(...)` 必须带 `!important` |
 * | SKIN-BLUR-2 | 那条会造成冲突的原生材质规则必须存在（否则这条判据守的是一个不存在的敌人 —— 它一旦被删，这条要跟着重审） |
 * | SKIN-BLUR-3 | 反向对照：`backdrop-filter: none`（**故意**去模糊的地方，如消息外层）不受这条约束 |
 * | SKIN-BLUR-4 | 具体钉住 `.sidebar` 这一条（用户报的那处），并断言它带 `!important` |
 *
 * ⚠️ 判据第一版写成了"皮肤里**每条** blur 都必须 `!important`" ⇒ 把 `.code-block` / `.tool-result` /
 * `.search-overlay` 这些**根本不在原生材质档里**的选择器也报成红（假红）。
 * 现在按"原生材质档实际针对的选择器集合"取交集 —— 只约束真会相撞的那些。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
const SKINS = ["src/styles/skin-dream.css", "src/styles/skin-hub.css"];
const BASE = read("src/styles.css");

/**
 * 从 `styles.css` 里读出"原生材质档会关掉模糊"的那些**基础选择器**（如 `.sidebar`、`.titlebar`）。
 * 这是冲突集合的**唯一来源** —— 判据不自己维护一份名单，免得两边漂移。
 */
function nativeMaterialBlurKilled(): string[] {
  const lines = BASE.split("\n");
  const out = new Set<string>();
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^html\[data-native-material[^{]*\{/.test(lines[i])) continue;
    const sel = lines[i].split("{")[0].trim();
    const body: string[] = [];
    for (let j = i + 1; j < lines.length && lines[j].trim() !== "}"; j += 1) body.push(lines[j]);
    if (!body.some((l) => /backdrop-filter:\s*none/.test(l))) continue;
    // `html[data-native-material="sidebar"] .sidebar` ⇒ 取 `.sidebar`
    const m = /\s(\.[-\w]+)\s*$/.exec(sel);
    if (m) out.add(m[1]);
  }
  return [...out];
}

/** 收集某文件里所有 backdrop-filter 声明及其所在规则的选择器 */
function blurDecls(css: string): Array<{ sel: string; decl: string; important: boolean }> {
  const out: Array<{ sel: string; decl: string; important: boolean }> = [];
  const lines = css.split("\n");
  let sel = "";
  let buf: string[] = [];
  let inComment = false;
  for (const line of lines) {
    if (inComment) {
      if (line.includes("*/")) inComment = false;
      continue;
    }
    if (/^\s*\/\*/.test(line)) {
      if (!line.includes("*/")) inComment = true;
      continue;
    }
    if (!sel && line.includes("{")) {
      sel = line.split("{")[0].trim();
      buf = [];
      continue;
    }
    if (sel) {
      if (line.trim() === "}") {
        for (const l of buf) {
          const m = /(-webkit-)?backdrop-filter\s*:\s*([^;]+);/.exec(l);
          if (m) out.push({ sel, decl: m[2].trim(), important: /!important/.test(m[2]) });
        }
        sel = "";
        buf = [];
        continue;
      }
      buf.push(line);
    }
  }
  return out;
}

describe("第 185 波 · 皮肤毛玻璃 vs 原生材质档", () => {
  it("SKIN-BLUR-1: 会被原生材质档压掉的那些选择器，皮肤里的 blur 必须带 !important", () => {
    const killed = nativeMaterialBlurKilled();
    expect(killed.length, "原生材质档里找不到任何关模糊的规则 —— 判据的前提没了").toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const file of SKINS) {
      for (const d of blurDecls(read(file))) {
        if (!/blur\(/.test(d.decl) || d.important) continue;
        // 皮肤规则形如 `[data-skin="dream"] .sidebar` ⇒ 看它最后一个复合选择器是否落在冲突集合里
        const last = d.sel.split(/\s+/).pop() ?? "";
        if (killed.includes(last)) offenders.push(`${file} :: ${d.sel} => ${d.decl}`);
      }
    }
    expect(
      offenders,
      `这些毛玻璃会被原生材质档（特异性更高的 backdrop-filter:none：${killed.join(" / ")}）压掉 ⇒ 梦幻皮肤下变成一片白底：\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("SKIN-BLUR-2: 造成冲突的原生材质规则必须仍在（它被删了这条判据就要重审）", () => {
    // 取证：这条规则是"敌人"，判据守的是它与皮肤规则的优先级之争
    expect(
      BASE,
      "原生材质档里那条 backdrop-filter:none 不在了 —— 若是有意删除，请连同 SKIN-BLUR-1 的理由一起重审",
    ).toMatch(/html\[data-native-material="sidebar"\]\s+\.sidebar\s*\{[^}]*backdrop-filter:\s*none/s);
  });

  it("SKIN-BLUR-3 反向对照：故意的 `backdrop-filter: none` 不受这条约束", () => {
    const noneDecls = blurDecls(read("src/styles/skin-dream.css")).filter((d) => d.decl.startsWith("none"));
    expect(noneDecls.length, "梦幻皮肤里有若干处是**故意**去模糊的（如消息外层）").toBeGreaterThan(0);
    // 它们不该被 SKIN-BLUR-1 报出来（上面只挑 blur( 的），这里把这条意图写死
    expect(noneDecls.every((d) => !/blur\(/.test(d.decl))).toBe(true);
  });

  it("SKIN-BLUR-4: 用户报的那一处（`.sidebar`）必须带 !important", () => {
    const decls = blurDecls(read("src/styles/skin-dream.css")).filter((d) => d.sel === '[data-skin="dream"] .sidebar');
    expect(decls.length, "梦幻皮肤必须给 .sidebar 设模糊").toBeGreaterThan(0);
    for (const d of decls) {
      expect(d.important, `${d.sel} 的 ${d.decl} 必须带 !important（否则被原生材质档压掉 ⇒ 死白）`).toBe(true);
    }
  });

  /**
   * ★ 第 185 波（用户报「有的类型选择器多了个外边框；text 1 行对、3 行错」）：
   * 梦幻皮肤给**每个** `pre` 描边，而多行代码块外面那层裸 `<pre>` 里包着 `.content-frame`
   * （它自己已经有一条**同色**边框）⇒ 同色双层外框。单行走行内代码、没有这层 `<pre>`，
   * 所以只有多行看得出来。真机取证：`.content-frame` 的祖先链里出现
   * `pre.(no-class) [1px rgba(0,0,0,0.12)]`，而 1 行的卡片祖先链上没有任何边框元素。
   */
  it("SKIN-BLUR-5: 卡片内部的 `pre` 不许再描边（否则多行代码块出现同色双层外框）", () => {
    const css = read("src/styles/skin-dream.css");
    // 前提：那条"给所有 pre 描边"的规则必须在（否则这条判据守的是不存在的敌人）
    expect(css, "梦幻皮肤给所有 pre 描边的规则不在了 —— 若有意删除，请连同本条一起重审").toMatch(
      /\[data-skin="dream"\]\s+pre,\s*\n\[data-skin="dream"\]\s+\.code-block\s*\{[^}]*border:\s*1px solid/s,
    );
    // 修复：**包着卡片的那层 `pre`** 必须被显式去掉边框。
    // ⚠️ 第一版判据把方向搞反了（写成"`.content-frame` 内部的 pre"），真机复核实测边框**依旧在** ——
    // 真实结构是 `pre > .content-frame`（`pre` 是祖先）。这里按真实结构断言 `:has()`。
    // ⚠️ 第二版判据是**裸正则**匹配 `border: none`，被变异注释里同样的文字骗过 ⇒ 现在先剥注释再按声明解析。
    const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
    const rule = /\[data-skin="dream"\]\s+pre:has\([^)]*\)[^{]*\{([^}]*)\}/s.exec(stripped);
    expect(rule, "找不到「包着卡片的 pre」那条规则（必须用 :has() 命中祖先 pre）").toBeTruthy();
    const decls = (rule?.[1] ?? "")
      .split(";")
      .map((d) => d.trim())
      .filter(Boolean)
      .map((d) => {
        const i = d.indexOf(":");
        return { prop: d.slice(0, i).trim(), value: d.slice(i + 1).trim() };
      });
    const borderDecl = decls.find((d) => d.prop === "border" || d.prop === "border-top");
    expect(
      borderDecl?.value,
      `包着卡片的那层 pre 必须被显式去掉边框（重复描边：卡片自己已经画过一条同色边框）。实际声明：${JSON.stringify(decls)}`,
    ).toBe("none");
  });
});
