/**
 * 皮肤选择 / 头像预设的**可访问性**门禁（第 83 轮，来自 UI/UX 走查）
 *
 * ## 走查发现的（以及一条**修正**）
 *
 * 第一轮走查报「头像预设按钮 50 个无名」「每个皮肤页签 40 个无名」。
 * 第 83 轮回读 DOM/源码后要分成两件事说：
 *
 * 1. **头像预设按钮其实有名字**，只是名字来自子元素 `<img alt="preset">`
 *    （`textContent` 为空）—— 走查的度量只看 `textContent`，于是误报。
 *    但"50 个按钮的可访问名**全都是同一个无意义的 preset**"仍然是真的问题（读屏无法区分）。
 *    修法：每个按钮给可区分的 `aria-label`（预设头像 N）+ `aria-pressed` 表达选中；
 *    度量侧也修了（`audit-walk-lib.mjs::__name` 现在会读后代 img 的 alt）。
 * 2. **皮肤卡片是真的缺陷**：`<div className="skin-card" onClick=…>` ——
 *    不可聚焦、没有 role、**键盘完全用不了**（Tab 跳过、Enter/Space 无反应），
 *    读屏也不会念成可选控件。修法：改成真正的 `<button type="button">` + `aria-pressed`。
 *
 * ## 判据
 *
 * | 编号 | 判据 |
 * | --- | --- |
 * | A11Y-1 | `SkinSelector` 里皮肤卡片必须是 `<button>`（不许是带 onClick 的 div） |
 * | A11Y-2 | 皮肤卡片必须带 `aria-pressed`（选中态不能只靠 `active` 类名）与可区分的 `aria-label` |
 * | A11Y-3 | 头像预设按钮必须**每个都有自己的 `aria-label`**（含序号），不许靠 `alt="preset"` 这种同一串 |
 * | A11Y-4 | 走查度量必须认得出"名字来自后代图片 alt"（否则下次还会误报同一件事） |
 */

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const ROOT = process.cwd();
const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");

describe("皮肤 / 头像选择的可访问性（第 83 轮走查）", () => {
  it("A11Y-1/A11Y-2: 皮肤卡片是真正的 button，且带 aria-pressed 与可区分名字", () => {
    const src = strip(fs.readFileSync(path.join(ROOT, "src/components/SkinSelector.tsx"), "utf8"));
    expect(src, "皮肤卡片不许再是带 onClick 的 div").not.toMatch(/<div[^>]*className=\{`skin-card/);
    const i = src.indexOf("skin-selector-grid");
    expect(i, "找不到皮肤网格").toBeGreaterThan(0);
    const block = src.slice(i, i + 1200);
    expect(block, "必须是 <button>").toMatch(/<button/);
    expect(block, "必须有 type=button（否则在表单里会触发提交）").toContain('type="button"');
    expect(block, "选中态必须有 aria-pressed（不能只靠 active 类名）").toContain("aria-pressed");
    expect(block, "每个皮肤要有可区分的可访问名").toMatch(/aria-label=\{lang === "zh" \? `皮肤：\$\{s\.name\}`/);
    // 反向对照：判据真的在判
    expect(/<div[^>]*className=\{`skin-card/.test('  <div className={`skin-card ${x}`} onClick={f}>'), "对照项：旧写法必须能被识别").toBe(true);
  });

  it("A11Y-3: 头像预设按钮每个都有自己的 aria-label（不许共用 alt=preset）", () => {
    const src = strip(fs.readFileSync(path.join(ROOT, "src/components/SettingsPanel.tsx"), "utf8"));
    const i = src.indexOf("preset-avatar-grid");
    expect(i, "找不到头像预设网格").toBeGreaterThan(0);
    const block = src.slice(i, i + 1200);
    expect(block, "每个按钮要带序号的 aria-label").toMatch(/aria-label=\{lang === "zh" \? `预设头像 \$\{i \+ 1\}`/);
    expect(block, "要用到 map 的索引（i）才能区分").toMatch(/PRESET_AVATARS\.map\(\(url, i\)/);
    expect(block, "选中态要能表达").toContain("aria-pressed");
    expect(block, "装饰性图片的 alt 必须留空（名字由按钮的 aria-label 给）").toMatch(/<img src=\{url\} alt="" /);
    expect(block, "不该再靠 alt=preset 当名字").not.toContain('alt="preset"');
  });

  it("A11Y-4: 走查度量认得「名字来自后代图片 alt」（否则下次照旧误报）", () => {
    const lib = fs.readFileSync(path.join(ROOT, ".preview-shot/audit-walk-lib.mjs"), "utf8");
    expect(lib, "必须读后代 img 的 alt").toMatch(/querySelectorAll\('img\[alt\]'\)/);
    expect(lib, "必须读 aria-labelledby 指向的文本").toContain("aria-labelledby");
    expect(lib, "顺序上 aria-label 优先").toMatch(/getAttribute\('aria-label'\)[\s\S]{0,400}getAttribute\('title'\)[\s\S]{0,400}img\[alt\]/);
  });
});
