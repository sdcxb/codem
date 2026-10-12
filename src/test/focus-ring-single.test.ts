/**
 * 第 210 波（用户实报 UI bug）：
 * > 设置里选择框、编辑框，外层会出来紫色的框，弄得平台很丑。排查修复所有类似问题。
 *
 * 真机实测（修前）：聚焦设置里的模型下拉时**同时有 2 个元素在画环** ——
 * 外层容器（半透明主题色）+ 控件自己（浏览器默认色 rgb(101,85,224)）⇒ 双层紫框、颜色还不一致。
 *
 * 口径：**一个焦点目标只画一个环**（控件自己那个，用主题色）。
 * 父级的"整行标红/无效态"这类**没有重复**的状态照旧保留。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const css = readFileSync(path.resolve(__dirname, "../styles.css"), "utf8");

describe("FOCUS-RING：一个焦点目标只许一个环", () => {
  it("FOCUS-RING-1：容器不许再因为「里面有焦点」而画环（那是双层框的来源）", () => {
    /* 允许容器因为"里面有焦点"改**边框色**，但**不许画 outline / 光环** */
    const parentRingRules = [
      /\.setting-group:has\([^)]*:focus-visible\)[^{]*\{[^}]*outline/s,
      /\.sp-row:has\([^)]*:focus-visible\)[^{]*\{[^}]*outline/s,
      /\.mcp-form-row:has\([^)]*:focus-visible\)[^{]*\{[^}]*outline/s,
      /\.plugin-mgr-dialog-item:has\([^)]*:focus-visible\)[^{]*\{[^}]*outline/s,
      /\.sp-card:has\([^)]*:focus-visible\)[^{]*\{[^}]*box-shadow/s,
      /\.tool-card:has\([^)]*:focus-visible\)[^{]*\{[^}]*box-shadow/s,
      /\.market-skill-card:has\([^)]*:focus-visible\)[^{]*\{[^}]*box-shadow/s,
    ];
    for (const re of parentRingRules) {
      expect(css, `不该再有父级焦点环：${re}`).not.toMatch(re);
    }
  });

  it("FOCUS-RING-2：控件自己要有一个**主题色**的环（别露浏览器默认色，也别没有环）", () => {
    expect(css, "原生控件要有主题环").toMatch(
      /:is\(select, input[^{]*\):focus-visible\s*\{[^}]*outline:\s*var\(--focus-ring-width\) solid var\(--focus-ring-color\)/s,
    );
    expect(css, "偏移也要统一").toMatch(/outline-offset:\s*var\(--focus-ring-offset\)/);
  });

  it("FOCUS-RING-3（反向对照）：父级的「无效态标红」这类**没有重复**的状态必须保留", () => {
    expect(css, "整行标红的父级状态不许被误删").toMatch(/:has\(input:user-invalid\)/);
  });
});
