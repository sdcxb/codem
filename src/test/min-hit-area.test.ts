/**
 * 命中区下限（第 94 轮，O-4 ② 的直接产出）。
 *
 * ## 现场（真机走查量出来的）
 *
 * 收件箱面板报出 **7 处"真控件但命中区不足"**：
 *  - 每行的「归档」按钮：`padding:2px` + 12px 图标 = **16×19**（「归档」是这条通知**唯一的移除入口**）；
 *  - 「显示已归档」的复选框：**13×13**，外面那层 label 只有 20px 高，撑不到 24。
 *
 * 都低于 WCAG 2.5.8 的 24×24 最小目标尺寸 ⇒ 鼠标/触控都难命中。
 *
 * ## 判据
 *
 * | 编号 | 判据 |
 * | --- | --- |
 * | MH-1 | 那两个归档按钮必须带 `ICON_HIT`（24×24 下限 + 居中） |
 * | MH-2 | `ICON_HIT` / `LABEL_HIT` 常量本身必须真的写着 24（不许被"悄悄改小"） |
 * | MH-3 | 反向对照：老的 `padding:"2px"` 写法不许回来 |
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..");
const SRC = readFileSync(join(ROOT, "src", "components", "task-center", "InboxTab.tsx"), "utf8");

describe("命中区下限（第 94 轮）", () => {
  it("MH-1 归档/恢复按钮与「显示已归档」那一行都用了命中区常量", () => {
    const count = (SRC.match(/\.\.\.ICON_HIT/g) ?? []).length;
    expect(count, "两个归档按钮（归档 / 恢复）都要带 ICON_HIT").toBe(2);
    expect(SRC, "「显示已归档」的 label 要带 LABEL_HIT").toContain("...LABEL_HIT");
  });

  it("MH-2 常量必须真的写着 24（下限不许被改小）", () => {
    /**
     * ⚠️ 判据必须**限定在该常量自己的块里**（`[^}]*` 不跨 `}`）——
     * 第一版用 `{[\s\S]{0,200}?minWidth: 24` 这种"往后找 200 字"，会**越界读到
     * 下一个常量**（LABEL_HIT 的 minHeight: 24）⇒ 把 ICON_HIT 的 24 改成 16 也能过。
     * 变异演练 M2 就是拿这一条把它试出来的。
     */
    expect(SRC, "ICON_HIT 必须同时给 minWidth: 24 与 minHeight: 24").toMatch(
      /const ICON_HIT = \{[^}]*minWidth:\s*24[^}]*minHeight:\s*24[^}]*\}/,
    );
    expect(SRC, "LABEL_HIT 必须给 minHeight: 24").toMatch(/const LABEL_HIT = \{[^}]*minHeight:\s*24[^}]*\}/);
    // 居中对齐：命中区变大之后图标不能跑偏
    expect(SRC).toMatch(/const ICON_HIT = \{[^}]*justifyContent:\s*"center"[^}]*\}/);
  });

  it("MH-3 反向对照：老的 `padding: \"2px\"` 不许回来（那正是 16×19 的来源）", () => {
    expect(SRC, 'archive 按钮不许再写 padding:"2px"').not.toMatch(/handleArchive[\s\S]{0,200}?padding:\s*"2px"/);
    expect(SRC, 'unarchive 按钮不许再写 padding:"2px"').not.toMatch(/handleUnarchive[\s\S]{0,200}?padding:\s*"2px"/);
  });
});
