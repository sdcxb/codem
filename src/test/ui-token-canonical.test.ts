/**
 * v2 调色板的**取值契约**：与 `docs/design/tokens.json` 逐值一致 + 实算对比度。
 *
 * ## 为什么需要"逐值一致"
 *
 * 同一套色值要在三个地方出现：桌面 CSS、`docs/design/tokens.json`（机读真相源）、手机端（Batch 6B）。
 * 三者一旦漂移，"三端同一套 token"就是一句空话。这里把前两者钉在一起：
 * 改 CSS 忘了改 JSON（或反之）当场红。
 *
 * ## 为什么对比度要自己算
 *
 * 仓库已有的 `tools/audit/scan-color-roles.mjs` 只扫四个基础样式表里的配对 —— 它不认识
 * `[data-ui="v2"]` 这个新作用域。而 v2 是另一套明度，必须自己算：
 * 正文 ≥7、次级在阅读面上 ≥6、muted ≥4.5、accent/状态色 ≥4.5（含自身 8%/15% 淡底），
 * 状态实心块上的文字 ≥4.5。算不出来（不是 hex/rgba）就报红，而不是"跳过"。
 *
 * ## 为什么复用 `contrast-checker` 而不是就地写一份
 *
 * 亮度公式的阈值字面量（`0.04045`/`12.92`/`2.4`）**只许出现在唯一来源文件**里
 * （判据 `contrast-luminance-single-source` 的 CR-1b 会扫全仓）。就地再写一份 = 制造第二真相源，
 * 而且历史上那三份镜像已经因为阈值版本不同（0.03928 vs 0.04045）埋过一次坑。
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compositeOver, contrastOfRgba, resolveRgba, type Rgba } from "../core/theme/contrast-checker";

const ROOT = join(__dirname, "..", "..");
const CSS_PATH = join(ROOT, "src", "core", "theme", "unslop-tokens.css");
const JSON_PATH = join(ROOT, "docs", "design", "tokens.json");

const DARK_SELECTOR = ':root[data-ui="v2"]';
const LIGHT_SELECTOR = ':root[data-ui="v2"][data-theme="light"]';

type Theme = "dark" | "light";
interface Block {
  selector: string;
  body: string;
}

/** 按出现顺序切出 `selector { body }`（够用于本文件：没有嵌套规则） */
function cssBlocks(css: string): Block[] {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: Block[] = [];
  let buf = "";
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "{") {
      const selector = buf.trim().replace(/\s+/g, " ");
      let depth = 1;
      let j = i + 1;
      let body = "";
      while (j < src.length && depth > 0) {
        const c = src[j];
        if (c === "{") depth += 1;
        else if (c === "}") {
          depth -= 1;
          if (depth === 0) break;
        }
        body += c;
        j += 1;
      }
      out.push({ selector, body });
      buf = "";
      i = j + 1;
      continue;
    }
    if (ch === "}") {
      buf = "";
      i += 1;
      continue;
    }
    buf += ch;
    i += 1;
  }
  return out;
}

/** 取某个作用域里第一次出现的 `--token: value` */
function declarations(block: Block): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of block.body.split(/;\s*(?:\r?\n|$)/)) {
    const m = /^\s*(--[a-z0-9-]+)\s*:\s*([\s\S]+?)\s*$/.exec(line);
    if (!m) continue;
    if (!map.has(m[1])) map.set(m[1], m[2].replace(/\s+/g, " ").trim());
  }
  return map;
}

const css = readFileSync(CSS_PATH, "utf8");
const blocks = cssBlocks(css);
const darkDecls = declarations(blocks.find((b) => b.selector === DARK_SELECTOR)!);
const lightDecls = declarations(blocks.find((b) => b.selector === LIGHT_SELECTOR)!);
const canonical = JSON.parse(readFileSync(JSON_PATH, "utf8")) as {
  palette: Record<string, Record<Theme, string>>;
};

const SURFACE_KEYS = ["--ui-bg", "--ui-sidebar", "--ui-surface", "--ui-surface-raised", "--ui-surface-active"] as const;

function rawOf(theme: Theme, key: string): string | undefined {
  return (theme === "dark" ? darkDecls : lightDecls).get(key);
}

function colorOf(theme: Theme, key: string): Rgba {
  const raw = rawOf(theme, key);
  const parsed = raw ? resolveRgba(raw) : null;
  expect(parsed, `${theme} 档缺少或无法解析 ${key}（值：${raw ?? "缺失"}）`).toBeTruthy();
  return parsed!;
}

describe("v2 调色板：CSS 与 tokens.json 逐值一致", () => {
  it("两个作用域都存在且各有足够的原始令牌", () => {
    expect(blocks.some((b) => b.selector === DARK_SELECTOR), "缺暗色作用域").toBe(true);
    expect(blocks.some((b) => b.selector === LIGHT_SELECTOR), "缺亮色作用域").toBe(true);
    expect(darkDecls.size, "暗色块令牌太少，解析可能坏了").toBeGreaterThan(15);
    expect(lightDecls.size, "亮色块令牌太少，解析可能坏了").toBeGreaterThan(15);
  });

  it("tokens.json 的每个 --ui-* 与 CSS 同值（两档都比）", () => {
    const mismatches: string[] = [];
    for (const [key, values] of Object.entries(canonical.palette)) {
      for (const theme of ["dark", "light"] as const) {
        const raw = rawOf(theme, key);
        if (!raw) {
          mismatches.push(`${theme} 档缺 ${key}`);
          continue;
        }
        const a = resolveRgba(raw);
        const b = resolveRgba(values[theme]);
        if (!a || !b) {
          mismatches.push(`${theme} ${key} 无法解析（css=${raw} json=${values[theme]}）`);
          continue;
        }
        const same =
          Math.round(a.r) === Math.round(b.r) &&
          Math.round(a.g) === Math.round(b.g) &&
          Math.round(a.b) === Math.round(b.b) &&
          Math.abs(a.a - b.a) < 0.005;
        if (!same) mismatches.push(`${theme} ${key}: css=${raw} json=${values[theme]}`);
      }
    }
    expect(mismatches, `CSS 与 docs/design/tokens.json 漂移：\n  ${mismatches.join("\n  ")}`).toEqual([]);
  });

  it("两档定义的 --ui-* 集合相同（少一个就会一路继承到另一个档）", () => {
    const darkKeys = [...darkDecls.keys()].filter((k) => k.startsWith("--ui-")).sort();
    const lightKeys = [...lightDecls.keys()].filter((k) => k.startsWith("--ui-")).sort();
    expect(darkKeys).toEqual(lightKeys);
  });

  it("Batch 0 不改几何：v2 作用域里不许出现 radius / space / control / fs 令牌", () => {
    for (const block of blocks) {
      if (!block.selector.includes('[data-ui="v2"]')) continue;
      const geometry = [...declarations(block).keys()].filter((k) =>
        /^--(radius|space|control|fs-|lh-|ls-|icon-|chrome-height|sidebar-row-h)/.test(k),
      );
      expect(geometry, `v2 令牌文件里出现了几何令牌（Batch 0 的验收要求布局指纹不变）：${geometry.join(", ")}`).toEqual([]);
    }
  });
});

describe("v2 调色板：对比度", () => {
  for (const theme of ["dark", "light"] as const) {
    it(`${theme}：正文 / 次级 / muted 在 5 个表面上都过线`, () => {
      const surfaces = SURFACE_KEYS.map((k) => ({ key: k, color: colorOf(theme, k) }));
      /* 口径：4.5 是可读线（所有面都要过）；6 是"阅读面"的目标（正文真正停留的地方）。
         次级文字在 hover/active 这种过渡面上只要求 4.5 —— 那是 WCAG 的线，不是"顺手挑的数"；
         反过来说，正文面（bg/surface）必须优于 6。 */
      const readingSurfaces = new Set(["--ui-bg", "--ui-surface"]);
      const rules: Array<{ token: string; floor: number; readingFloor?: number }> = [
        { token: "--ui-text", floor: 7, readingFloor: 7 },
        { token: "--ui-text-secondary", floor: 4.5, readingFloor: 6 },
        { token: "--ui-text-muted", floor: 4.5, readingFloor: 4.5 },
      ];
      const failures: string[] = [];
      for (const rule of rules) {
        const fg = colorOf(theme, rule.token);
        for (const surface of surfaces) {
          const floor = readingSurfaces.has(surface.key) ? (rule.readingFloor ?? rule.floor) : rule.floor;
          const ratio = contrastOfRgba(fg, surface.color);
          if (ratio < floor) failures.push(`${rule.token} on ${surface.key} = ${ratio.toFixed(2)} < ${floor}`);
        }
      }
      expect(failures, failures.join("\n")).toEqual([]);
    });

    it(`${theme}：accent 作为文字在表面与自身 8%/15% 淡底上都过线，accent-ink 过线`, () => {
      const accent = colorOf(theme, "--ui-accent");
      const ink = colorOf(theme, "--ui-accent-ink");
      const failures: string[] = [];
      for (const key of SURFACE_KEYS) {
        const surface = colorOf(theme, key);
        const onSurface = contrastOfRgba(accent, surface);
        if (onSurface < 4.5) failures.push(`accent on ${key} = ${onSurface.toFixed(2)}`);
        /* 只测真实存在的两档淡底：`--accent-surface` = 8%、`--accent-muted` / `--accent-surface-strong` = 15%。
           20% 在这个产品里没有对应令牌，测它等于给一个不存在的场景设门槛。 */
        for (const alpha of [0.08, 0.15]) {
          const tint = compositeOver({ ...accent, a: alpha }, surface);
          const onTint = contrastOfRgba(accent, tint);
          if (onTint < 4.5) failures.push(`accent on ${key}+${Math.round(alpha * 100)}% = ${onTint.toFixed(2)}`);
        }
      }
      const inkRatio = contrastOfRgba(ink, accent);
      if (inkRatio < 4.5) failures.push(`accent-ink on accent = ${inkRatio.toFixed(2)}`);
      expect(failures, failures.join("\n")).toEqual([]);
    });

    it(`${theme}：状态色在表面与自身 20% 淡底上过线，实心块上的文字过线`, () => {
      const failures: string[] = [];
      const surface = colorOf(theme, "--ui-surface");
      const bg = colorOf(theme, "--ui-bg");
      const onStatus = colorOf(theme, "--ui-on-status");
      for (const key of ["--ui-success", "--ui-danger", "--ui-warning", "--ui-info"]) {
        const color = colorOf(theme, key);
        for (const [label, base] of [["surface", surface], ["bg", bg]] as const) {
          const ratio = contrastOfRgba(color, base);
          if (ratio < 4.5) failures.push(`${key} on ${label} = ${ratio.toFixed(2)}`);
        }
        const tint = compositeOver({ ...color, a: 0.2 }, surface);
        const onTint = contrastOfRgba(color, tint);
        if (onTint < 4.5) failures.push(`${key} on own 20% tint = ${onTint.toFixed(2)}`);
        const solid = contrastOfRgba(onStatus, color);
        if (solid < 4.5) failures.push(`on-status on ${key} = ${solid.toFixed(2)}`);
      }
      expect(failures, failures.join("\n")).toEqual([]);
    });

    it(`${theme}：accent 就是拍板的琥珀（暗 #c6a15b），且状态色不是第二个 accent`, () => {
      if (theme === "dark") expect(canonical.palette["--ui-accent"].dark.toLowerCase()).toBe("#c6a15b");
      const accent = colorOf(theme, "--ui-accent");
      /* 判"是否是第二个主色"用**通道差**而不是明度差：v2 的调色板刻意把状态色压到相近明度
         （否则在深底上一块亮红会抢走焦点），但色相必须拉得开（≥20/255）。 */
      for (const key of ["--ui-danger", "--ui-info"] as const) {
        const color = colorOf(theme, key);
        const channelDelta = Math.max(
          Math.abs(color.r - accent.r),
          Math.abs(color.g - accent.g),
          Math.abs(color.b - accent.b),
        );
        expect(channelDelta, `${key} 与 accent 的色相太接近，会读成同一个主色`).toBeGreaterThanOrEqual(20);
      }
    });
  }
});
