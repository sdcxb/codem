/**
 * 外观档位（高对比 + 密度）门禁 —— 第 159 轮 P2-1。
 *
 * ## 这一组守的是一条**真实缺口**
 *
 * 第 156/157 轮我把 `[data-contrast="high"]`（D7）和密度档的 CSS 写了，但
 * **全项目没有任何地方设置这两个属性**（当时 `grep data-contrast src/` 只命中 CSS 与测试）⇒
 * "规则写了、没人触发"：用户永远看不到，而 CSS 侧的门禁**全绿**（它只断言规则存在，不问谁触发）。
 * 这与 `--message-bubble-user`（定义了零引用）是同一类问题：**口径与写入点必须对齐**。
 *
 * 所以这里有三层断言：
 *   ① 写入方存在（设置页 + 首屏镜像 + 启动路径），且**在首帧之前**生效；
 *   ② 档位语义正确（DB → 镜像 → 默认；非法值一律退回默认；属性是幂等的）；
 *   ③ 密度档只覆盖控件高度、每档都更矮、且都不低于 24px 命中区下限。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  applyAppearanceAttributes,
  applyContrastAttribute,
  applyDensityAttribute,
  isContrastMode,
  isDensityMode,
  readCachedContrast,
  readCachedDensity,
  resolveEffectiveContrast,
  resolveEffectiveDensity,
  CONTRAST_CACHE_KEY,
  CONTRAST_SETTING_KEY,
  DENSITY_CACHE_KEY,
  DENSITY_SETTING_KEY,
  DEFAULT_CONTRAST,
  DEFAULT_DENSITY,
} from "../core/theme/appearance-modes";

const ROOT = join(__dirname, "..", "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const styles = read("src/styles.css");

/** 收集 `src/` 下所有非测试源码（用来断言"有没有写入方"） */
const sourceFiles = (): Array<{ path: string; text: string }> => {
  const out: Array<{ path: string; text: string }> = [];
  (function walk(dir: string) {
    for (const n of readdirSync(dir)) {
      const p = join(dir, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(n) && !/\.test\./.test(n)) out.push({ path: p, text: readFileSync(p, "utf8") });
    }
  })(join(ROOT, "src"));
  return out;
};

describe("APPEARANCE 外观档位（第 159 轮 P2-1）", () => {
  beforeEach(() => {
    document.documentElement.removeAttribute("data-contrast");
    document.documentElement.removeAttribute("data-density");
    localStorage.clear();
  });

  /* ---------- ① 写入方必须在（缺口回归位） ---------- */

  it("APPEARANCE-1：`data-contrast` 与 `data-density` 必须**真的有写入方**（否则规则是死的）", () => {
    const files = sourceFiles();
    for (const attr of ["data-contrast", "data-density"]) {
      const writers = files.filter((f) => new RegExp(`setAttribute\\(\\s*["']${attr}["']`).test(f.text));
      expect(writers.length, `没有任何地方设置 ${attr} —— 这一档 CSS 永远不会生效（第 157 轮踩过的坑）`).toBeGreaterThan(0);
    }
    /* 设置页必须真的把它接上（用户能改）。⚠️ 认**常量引用**也算 —— 常量是更好的写法，
       门禁要守的是"落库这一步有没有"，不是"字面量有没有出现"（第一版卡死在这里）。 */
    const panel = read("src/components/SettingsPanel.tsx");
    expect(panel, "设置页必须写入对比度设置（常量 CONTRAST_SETTING_KEY 或其字面量）").toMatch(/CONTRAST_SETTING_KEY|["']codem-contrast["']/);
    expect(panel, "设置页必须写入密度设置").toMatch(/DENSITY_SETTING_KEY|["']codem-density["']/);
    /* ⚠️ 只断言"调用过 applyDensityAttribute"不够 —— 变异 A1 试过：把设置页 onChange 里那一行删掉，
       仍然能命中"DB 校正"那条调用（`applyDensityAttribute(dbDensity)`），门禁照样绿。
       所以要钉**用户改档时立即应用**这个具体形态：`applyXxxAttribute(next)`。 */
    expect(panel, "设置页改对比度时必须立即应用（applyContrastAttribute(next)）").toMatch(/applyContrastAttribute\(next\)/);
    expect(panel, "设置页改密度时必须立即应用（applyDensityAttribute(next)）").toMatch(/applyDensityAttribute\(next\)/);
    /* 首屏镜像：换了档不能先闪一帧旧档 */
    const html = read("index.html");
    expect(html, "index.html 首屏脚本必须读 codem-contrast-cache").toContain("codem-contrast-cache");
    expect(html, "index.html 首屏脚本必须读 codem-density-cache").toContain("codem-density-cache");
  });

  /* ---------- ② 档位语义 ---------- */

  it("APPEARANCE-2：解析顺序是 DB → 镜像 → 默认，非法值一律退回默认", () => {
    expect(isContrastMode("high")).toBe(true);
    expect(isContrastMode("High")).toBe(false);
    expect(isDensityMode("compact")).toBe(true);
    expect(isDensityMode("dense")).toBe(false);

    /* 都没有 → 默认档 */
    expect(resolveEffectiveContrast()).toBe(DEFAULT_CONTRAST);
    expect(resolveEffectiveDensity()).toBe(DEFAULT_DENSITY);

    /* 只有镜像 → 用镜像（这就是"启动期有效值"的意义：不把镜像覆盖成默认） */
    localStorage.setItem(CONTRAST_CACHE_KEY, "high");
    localStorage.setItem(DENSITY_CACHE_KEY, "compact");
    expect(resolveEffectiveContrast()).toBe("high");
    expect(resolveEffectiveDensity()).toBe("compact");

    /* DB 有值 → DB 赢 */
    const db: Record<string, string> = { [CONTRAST_SETTING_KEY]: "normal", [DENSITY_SETTING_KEY]: "comfortable" };
    expect(resolveEffectiveContrast((k) => db[k] ?? null)).toBe("normal");
    expect(resolveEffectiveDensity((k) => db[k] ?? null)).toBe("comfortable");

    /* DB 里的脏值不能生效（退回镜像/默认） */
    const bad: Record<string, string> = { [CONTRAST_SETTING_KEY]: "HIGH!!", [DENSITY_SETTING_KEY]: "tiny" };
    expect(resolveEffectiveContrast((k) => bad[k] ?? null)).toBe("high");
    expect(resolveEffectiveDensity((k) => bad[k] ?? null)).toBe("compact");

    /* 读取设置抛错也不能把启动搞崩 */
    expect(
      resolveEffectiveContrast(() => {
        throw new Error("db not ready");
      }),
    ).toBe("high");
  });

  it("APPEARANCE-3：写属性是幂等的，并把镜像一起补上（首屏预测不会落后）", () => {
    applyContrastAttribute("high");
    expect(document.documentElement.getAttribute("data-contrast")).toBe("high");
    expect(readCachedContrast()).toBe("high");
    expect(localStorage.getItem(CONTRAST_CACHE_KEY)).toBe("high");

    /* 再写一次同样的值：属性不变、不抛错（幂等） */
    applyContrastAttribute("high");
    expect(document.documentElement.getAttribute("data-contrast")).toBe("high");

    applyDensityAttribute("compact");
    expect(document.documentElement.getAttribute("data-density")).toBe("compact");
    expect(readCachedDensity()).toBe("compact");

    /* 一次应用两档 */
    const applied = applyAppearanceAttributes((k) => (k === CONTRAST_SETTING_KEY ? "normal" : "comfortable"));
    expect(applied).toEqual({ contrast: "normal", density: "comfortable" });
    expect(document.documentElement.getAttribute("data-contrast")).toBe("normal");
    expect(document.documentElement.getAttribute("data-density")).toBe("comfortable");
  });

  /* ---------- ③ 密度档的 CSS 口径 ---------- */

  it("APPEARANCE-4：密度档只覆盖控件高度，且每档更矮、都不低于 24px 命中区", () => {
    const block = /\[data-density="compact"\]\s*\{([\s\S]*?)\n\}/.exec(styles)?.[1] ?? "";
    expect(block, "缺少 [data-density=\"compact\"] 档").not.toBe("");
    const px = (v: string) => Number(/^(\d+(?:\.\d+)?)px$/.exec(v.trim())?.[1] ?? NaN);
    const pairs: Array<[string, string]> = [
      ["--control-xs", "--control-xs-compact"],
      ["--control-dense", "--control-dense-compact"],
      ["--control-md", "--control-md-compact"],
      ["--control-std", "--control-std-compact"],
      ["--control-form", "--control-form-compact"],
    ];
    /* ⚠️ 控件高度令牌定义在**第一个 `:root` 块**（与主题无关的那块），不在亮色档里 ——
       第一版读的是 `:root, [data-theme="light"]` 块，于是读到空字符串、断言报"不是 px 值"。 */
    const firstRoot = /^:root\s*\{([\s\S]*?)\n\}/m.exec(styles)?.[1] ?? "";
    expect(firstRoot.length, "没解析到第一个 :root 块").toBeGreaterThan(500);
    const token = (blockText: string, name: string) => new RegExp(`--${name.slice(2)}\\s*:\\s*([^;]+);`).exec(blockText)?.[1]?.trim() ?? "";
    for (const [full, compact] of pairs) {
      expect(block, `密度档必须覆盖 ${full}`).toContain(`--${full.slice(2)}: var(--${compact.slice(2)})`);
      const normalPx = px(token(firstRoot, full));
      const compactPx = px(token(firstRoot, compact));
      expect(Number.isNaN(normalPx) || Number.isNaN(compactPx), `${compact} 或 ${full} 不是 px 值`).toBe(false);
      expect(compactPx, `${compact}=${compactPx}px 不小于舒适档 ${full}=${normalPx}px —— 那不叫更紧凑`).toBeLessThan(normalPx);
      expect(compactPx, `${compact}=${compactPx}px 低于 24px 命中区下限（紧凑 ≠ 更难点）`).toBeGreaterThanOrEqual(24);
    }
    /* 不许顺带缩放间距：那会让分组/留白/栅格的层级关系失真，也超出这一档的承诺 */
    expect(block, "密度档不应覆盖 --space-*（只承诺控件高度这一件事）").not.toMatch(/--space-\d+\s*:/);
  });

  it("APPEARANCE-5：两档 CSS 都有降级/对照，且都用同一个属性名（不散落别名）", () => {
    expect(styles, "缺 [data-contrast=\"high\"] 档（D7）").toMatch(/\[data-contrast="high"\]\s*\.sidebar/);
    /* 只允许这一种属性名 —— 出现过 data-contrast-mode 之类的别名就会分叉 */
    expect(styles.match(/data-contrast-mode|data-high-contrast/g) ?? [], "出现了别的对比度属性名").toEqual([]);
    expect(styles.match(/data-densition|data-density-mode/g) ?? [], "出现了别的密度属性名（注意 densition 这种拼错）").toEqual([]);
  });

  /**
   * APPEARANCE-6：**启动路径必须真的应用一次**。
   *
   * 这一条是装机版复核时量出来的：1.16.159 装好后 `data-contrast` / `data-density` 都是 `null`
   * —— 因为当时只有"设置页改档"这一条写入路径，`applyAppearanceAttributes`（DB→镜像→默认那条链）
   * **产品代码里根本没人调**（只有测试在调）。于是"用户改了档 → 清缓存/换机恢复设置"这条路上，
   * 档位会一直是默认值，直到他再碰一次设置页。
   * 现在两处都接上：`main.tsx` 首帧前按镜像应用、`TitleBar` 在 dbReady 后用 DB 真值校正。
   */
  it("APPEARANCE-6：启动路径（首帧 + DB 就绪）都必须应用外观档位", () => {
    const main = read("src/main.tsx");
    expect(main, "main.tsx 的 bootstrap 必须在首帧前按镜像应用一次").toMatch(/applyAppearanceAttributes\(\)/);
    expect(main, "必须发生在 renderApp() 之前").toMatch(/applyAppearanceAttributes\(\)[\s\S]{0,600}?renderApp\(\)/);

    const dbSync = ["src/components/TitleBar.tsx", "src/App.tsx"]
      .map((f) => ({ f, text: read(f) }))
      .filter((x) => /applyAppearanceAttributes\(/.test(x.text));
    expect(dbSync.length, "DB 就绪后必须有一次校正（TitleBar 或 App 里调 applyAppearanceAttributes(getSetting)）").toBeGreaterThan(0);
    expect(dbSync.some((x) => /applyAppearanceAttributes\(\s*getSetting\s*\)/.test(x.text)), "DB 校正必须把 getSetting 传进去（否则读的是镜像，不是真相源）").toBe(true);
  });
});
