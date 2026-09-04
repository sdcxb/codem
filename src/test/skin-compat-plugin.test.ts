/**
 * 插件皮肤兼容契约测试（Skin Token Contract）
 *
 * 背景：Codem 三套皮肤（default 亮/暗、dream、hub 恒暗）由 data-skin + data-theme
 * 驱动 CSS 变量令牌切换。插件（市场 UI、插件管理面板、ui-* provider 及将来可适配
 * 的 dsh UI 插件）会直接影响 UI/UX，必须与皮肤兼容——样式只消费令牌、禁止硬编码色。
 *
 * SC-1 auditPluginStyle 能识别裸露色值（hex/rgb/rgba），放行 var() 与 var fallback
 * SC-2 插件影响 UI 的源码（插件市场 Tab / 插件管理弹窗）无硬编码色值（全部走令牌）
 * SC-3 契约登记的核心皮肤令牌在 styles.css 均有定义（防令牌改名/删除断链）
 * SC-4 目录分类动态派生所需：catalog 分类均属受支持分类集合（CATEGORY 标签可渲染）
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  auditPluginStyle,
  findHardcodedColors,
  CORE_SKIN_TOKENS,
} from "../core/theme/skin-tokens";

const ROOT = join(__dirname, "..", "..");

describe("插件皮肤兼容契约", () => {
  it("SC-1: auditPluginStyle 抓硬编码色、放行 var() 与 fallback", () => {
    const bad = `const s = {
      color: "#fff",
      background: 'rgb(0, 0, 0)',
      border: '1px solid #123456',
      opacity: 0.5,
    }`;
    const hits = findHardcodedColors(bad);
    expect(hits.length).toBe(3);
    expect(hits.map(h => h.color)).toEqual(
      expect.arrayContaining(["#fff", "rgb(0, 0, 0)", "#123456"]),
    );

    const ok = `
      color: 'var(--text-primary)',
      background: 'var(--bg-tertiary)',
      accent fallback: 'var(--accent, #7c6cf0)',
      textOnAccent: 'var(--text-on-accent)',
      overlay: 'color-mix(in srgb, var(--accent) 12%, transparent)',
    `;
    expect(auditPluginStyle(ok)).toEqual([]);
  });

  it("SC-2: 插件市场 Tab 与插件管理弹窗源码无硬编码色值（全部走令牌）", () => {
    const files = [
      "src/components/plugin-market/PluginMarketTab.tsx",
      "src/components/PluginManager.tsx",
    ];
    for (const rel of files) {
      const source = readFileSync(join(ROOT, rel), "utf8");
      const violations = auditPluginStyle(source);
      expect(violations, `${rel} 存在硬编码色值（应改用 var(--token)）`).toEqual([]);
    }
  });

  it("SC-3: 契约登记的核心皮肤令牌在 styles.css 均有定义", () => {
    const css = readFileSync(join(ROOT, "src", "styles.css"), "utf8");
    // styles.css 的 :root/[data-theme] 块定义主题令牌
    for (const token of CORE_SKIN_TOKENS) {
      expect(css.includes(`${token}:`), `${token} 应在 styles.css 定义`).toBe(true);
    }
  });

  it("SC-4: 目录分类均在受支持分类集合内（分类标签可渲染）", async () => {
    const { DSH_MARKET_CATALOG } = await import("../core/plugin-market/dsh-market-catalog");
    const supported = new Set(["capability", "tool", "infra", "ui"]);
    for (const entry of DSH_MARKET_CATALOG) {
      expect(supported.has(entry.category), `${entry.dshName} 分类 ${entry.category} 不受支持`).toBe(true);
    }
  });

  it("SC-5: 共享 Badge 语义变体（插件 UI 依赖）无裸露硬编码色，跟随皮肤令牌", () => {
    const css = readFileSync(join(ROOT, "src", "styles.css"), "utf8");
    // 提取全部 .badge-* 规则体（badge 是市场 Tab/插件管理依赖的共享组件）
    const bodies: string[] = [];
    for (const m of css.matchAll(/\.badge-[\w-]+\s*\{([^}]*)\}/g)) {
      bodies.push(m[1]);
    }
    expect(bodies.length).toBeGreaterThan(0);
    const violations = auditPluginStyle(bodies.join("\n"));
    expect(violations, "badge 语义变体必须用 var(--success/--warning/--error/--info) 令牌").toEqual([]);
  });
});
