/**
 * UIDOC：组件目录 + 文档令牌对账。
 *
 * 两条判据：
 * - `UIDOC-1`：`docs/ui-spec.md` 引用的每个令牌都有定义；`:root` 里的 `--ease-*` / `--duration-*`
 *   必须全部写进文档（对标 open-claude-ui 的 `check-tokens.mjs`）；
 * - `UIDOC-2`：`docs/component-gallery.html` 里用到的组件类**必须都在 CSS 契约里**
 *   （目录看着像真的、实际类名早改名 ⇒ 这类腐化只有机器能抓）。
 *
 * 页面自身的类用 `gallery-` 前缀，不参与契约检查。
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { scanDocTokens } from "../../tools/audit/check-doc-tokens.mjs";

const ROOT = path.resolve(__dirname, "..", "..");

describe("UIDOC 文档 ↔ 实现", () => {
  it("UIDOC-1: ui-spec 引用的令牌全部有定义，动效令牌全部已记录", () => {
    const result = scanDocTokens();
    expect(result.missing, `未定义令牌：${result.missing.join(", ")}`).toEqual([]);
    expect(result.undocumented, `未记录的动效令牌：${result.undocumented.join(", ")}`).toEqual([]);
    expect(result.referenced.length).toBeGreaterThan(20);
  });

  it("UIDOC-2: 组件目录用到的类都在 CSS 契约里（只允许 gallery- 前缀的页面自有类）", () => {
    const html = fs.readFileSync(path.join(ROOT, "docs", "component-gallery.html"), "utf8");
    const contract = JSON.parse(
      fs.readFileSync(path.join(ROOT, "tools", "ui-audit", "css-contract.json"), "utf8"),
    ) as { classes?: string[]; classNames?: string[] } | string[];
    const known = new Set(
      Array.isArray(contract) ? contract : (contract.classes ?? contract.classNames ?? Object.keys(contract)),
    );

    // 契约快照是"派生视图"：少数复合选择器里的修饰类（如 `.guidance-item.pending` 的 pending）
    // 与个别压缩样式表里的类不会出现在 key 里。真相源是 CSS 文本本身，所以这里做两级判定：
    // 先在契约里找，找不到再到所有 CSS 文本里找 `.class`（仍是机器可判，不靠人眼）。
    const cssText = ["src/styles.css", "src/styles/codem-ui.css"]
      .map((f) => fs.readFileSync(path.join(ROOT, f), "utf8"))
      .join("\n");

    const used = new Set<string>();
    for (const m of html.matchAll(/class="([^"]+)"/g)) {
      for (const cls of m[1].split(/\s+/)) if (cls) used.add(cls);
    }
    const escapeRe = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const missing = [...used].filter((cls) => {
      if (cls.startsWith("gallery-")) return false;
      if (known.has(cls)) return false;
      return !new RegExp(`\\.${escapeRe(cls)}\\b`).test(cssText);
    });
    expect(missing, `组件目录里这些类没有 CSS 定义（文档已腐化）：${missing.join(", ")}`).toEqual([]);

    // 关键组件必须在场（防止"检查通过但目录里什么也没有"）
    for (const cls of ["midturn-guidance-header", "diff-split-grid", "guidance-item-attachments", "sp-toggle"]) {
      expect(used.has(cls), `目录缺少 ${cls}`).toBe(true);
    }
  });
});
