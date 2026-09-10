/**
 * LO-SKIN 样式入口守卫 —— 插件样式表必须由视图挂载点导入。
 *
 * 背景：v1.15.0 重写视图外壳时漏掉了 `styles/library-ops.css` 的 import，
 * 结果「任务管理 → 看板 / 子智能体」两个页签整片无样式（页面没自适应、内容显示不全），
 * 而版面审计只看几何、看不出来。这里用源码断言把入口钉死：
 * 插件视图的每个挂载点（外壳 / 概览用量嵌入）都必须能拿到样式（由外壳统一导入）。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

describe("LO-SKIN 样式入口", () => {
  it("LO-SKIN-1: LibraryOpsViewShell 导入插件样式表（唯一入口）", () => {
    const shell = read("plugins/library-ops/components/LibraryOpsViewShell.tsx");
    expect(shell).toMatch(/import\s+["'][^"']*styles\/library-ops\.css["']/);
  });

  it("LO-SKIN-2: 两个宿主视图与概览嵌入都通过外壳/自身引入样式（不各自漏掉）", () => {
    for (const rel of [
      "plugins/library-ops/components/LibraryOpsBoardView.tsx",
      "plugins/library-ops/components/LibraryOpsSceneView.tsx",
      "plugins/library-ops/components/LibraryOpsUsageEmbed.tsx",
    ]) {
      const src = read(rel);
      // 要么自己导入样式，要么经由外壳（外壳已导入）
      const importsCss = /import\s+["'][^"']*library-ops\.css["']/.test(src);
      const usesShell = /from\s+["'][^"']*LibraryOpsViewShell["']/.test(src);
      expect(importsCss || usesShell, `${rel} 必须能拿到插件样式`).toBe(true);
    }
  });

  it("LO-SKIN-3: 概览嵌入自带容器查询上下文（否则 @container lo 自适应规则失效）", () => {
    const css = read("plugins/library-ops/styles/library-ops.css");
    expect(css).toMatch(/\.lo-embed\s*\{[^}]*container-type:\s*inline-size/);
    expect(css).toMatch(/\.lo-embed\s*\{[^}]*container-name:\s*lo/);
    const embed = read("plugins/library-ops/components/LibraryOpsUsageEmbed.tsx");
    expect(embed).toContain('className="lo-embed"');
    // 不能渲染 .lo-task 外壳（那是宿主页签外壳，会嵌套两套布局）
    expect(embed).not.toContain('className="lo-task"');
  });
});
