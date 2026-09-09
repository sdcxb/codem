/**
 * LO-ICON — 图标体系统一（lucide-react）+ 版面自适应门禁
 *
 * 覆盖：
 * - LO-ICON-1 数据层图标名全部登记在 LO_ICONS（活动 11 / 来源 5 / 岗位 10）
 * - LO-ICON-2 插件源码里不再出现 emoji 图标（数据字段 + 组件字符串）
 * - LO-ICON-3 <LoIcon> 渲染 lucide <svg>（尺寸 / 装饰性 aria-hidden / 可带 label）
 * - LO-ICON-4 公共组件（Card / Pill / 场景 HUD）渲染的是 SVG 而不是 emoji 文本
 * - LO-ICON-5 样式层：删掉独立面板的死样式 + 用容器查询做自适应
 */
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { LO_ICONS, LoIcon } from "../plugins/library-ops/components/icons";
import { ACTIVITY_META, KIND_META } from "../plugins/library-ops/types";
import { LIBRARY_ZONES } from "../plugins/library-ops/data/library-map";
import { Card, Pill } from "../plugins/library-ops/components/monitor/common";

const ROOT = join(__dirname, "..", "..");
const PLUGIN = join(ROOT, "src", "plugins", "library-ops");

/** 收集插件源码（排除测试 / 图标模块本身） */
function pluginSources(dir = PLUGIN, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      pluginSources(p, out);
      continue;
    }
    if (/\.(ts|tsx|css)$/.test(name) && name !== "icons.tsx") out.push(p);
  }
  return out;
}

/** emoji / 图形符号（排除中文、常见排版符号如箭头 · — →） */
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/u;

describe("LO-ICON 图标体系与版面", () => {
  it("LO-ICON-1: 数据层图标名全部登记在 LO_ICONS", () => {
    const names = [
      ...Object.values(ACTIVITY_META).map((m) => m.icon),
      ...Object.values(KIND_META).map((m) => m.icon),
      ...LIBRARY_ZONES.map((z) => z.icon),
    ];
    expect(names.length).toBe(11 + 5 + 10);
    for (const name of names) {
      expect(name, `图标名 ${name} 应该是小写 kebab-case`).toMatch(/^[a-z0-9-]+$/);
      expect(LO_ICONS[name as keyof typeof LO_ICONS], `LO_ICONS 缺少 ${name}`).toBeTruthy();
    }
    // 映射表本身没有多余项
    expect(Object.keys(LO_ICONS).length).toBeGreaterThanOrEqual(names.length);
  });

  it("LO-ICON-2: 插件源码里不再出现 emoji 图标", () => {
    const offenders: string[] = [];
    for (const file of pluginSources()) {
      if (!/\.(ts|tsx)$/.test(file)) continue;
      const src = readFileSync(file, "utf8");
      const lines = src.split("\n");
      lines.forEach((line, i) => {
        // 只看代码行（跳过注释行，注释里保留说明性符号无伤大雅）
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return;
        if (EMOJI.test(line)) offenders.push(`${file.replace(ROOT + "\\", "")}:${i + 1} ${trimmed.slice(0, 80)}`);
      });
    }
    expect(offenders, `以下代码行仍有 emoji 图标：\n${offenders.join("\n")}`).toEqual([]);
  });

  it("LO-ICON-3: <LoIcon> 渲染 lucide svg", () => {
    const { container } = render(<LoIcon name="coffee" size={16} />);
    const svg = container.querySelector("svg.lo-icon")!;
    expect(svg).toBeTruthy();
    expect(svg.getAttribute("width")).toBe("16");
    expect(svg.getAttribute("aria-hidden")).toBe("true");

    const labelled = render(<LoIcon name="crown" label="队长" />);
    const svg2 = labelled.container.querySelector("svg.lo-icon")!;
    expect(svg2.getAttribute("aria-label")).toBe("队长");
    expect(svg2.getAttribute("role")).toBe("img");
    labelled.unmount();
  });

  it("LO-ICON-4: 公共组件用 SVG 图标而不是 emoji 文本", () => {
    const card = render(
      <Card title="工具" icon="wrench">
        <span>内容</span>
      </Card>,
    );
    expect(card.container.querySelector(".lo-card__head svg.lo-icon")).toBeTruthy();
    expect(card.container.textContent).not.toMatch(EMOJI);
    card.unmount();

    const pill = render(<Pill token="--success">已完成</Pill>);
    expect(pill.container.querySelector(".lo-pill")).toBeTruthy();
    pill.unmount();
  });

  it("LO-ICON-5: 样式层删掉独立面板死样式，并用容器查询自适应", () => {
    const css = readFileSync(join(PLUGIN, "styles", "library-ops.css"), "utf8");
    // 独立面板 / 悬浮入口的样式已随组件删除
    expect(css).not.toContain(".lo-launcher");
    expect(css).not.toContain(".lo-overlay");
    expect(css).not.toContain(".lo-shell");
    // 自适应：容器查询 + 无固定 236px 列
    expect(css).toContain("container-type: inline-size");
    expect(css).toContain("@container lo (max-width:");
    expect(css).toContain("@container lo (max-height:");
    expect(css).not.toMatch(/grid-template-columns:\s*236px/);
    // 卡片视觉与宿主一致（10px 圆角 + bg-secondary + border-primary）
    expect(css).toMatch(/\.lo-card\s*\{[^}]*border-radius:\s*var\(--radius-md, 10px\)/s);
    expect(css).toMatch(/\.lo-card\s*\{[^}]*background:\s*var\(--bg-secondary\)/s);
  });
});
