/**
 * 第 109 波：**判据族提醒**（在第一次测试跑出红的那一刻再放一次）。
 *
 * ## 判据依据（第 108 波测出来的中介变量）
 *
 * | 运行 | 结果 | 碰过那条判据吗 |
 * |---|---|---|
 * | repo-02 run-2 | ✅ | 碰了 ✓ |
 * | repo-02 run-3 | ❌ | 没碰 ✗ |
 * | repo-03 run-2 | ❌ | 没碰 ✗ |
 * | repo-03 run-3 | ✅ | 碰了 ✓ |
 *
 * ⇒ **"有没有主动碰那条判据"对成败的预测力 4/4** ✓ ⇒ 下一步就是让"碰"这件事更可靠 ✓。
 * 同一份完整清单在 repo-02 上 run-2 用了、run-3 没用 ⇒ 问题是**注意力衰减**
 * （清单只在第一条消息里投递一次，之后被 20+ 次工具调用推远）✗
 * ⇒ 在**需要它的时刻**再放一次 ✓。
 *
 * 变异自证：把"紧凑提醒"改成返回 null ⇒ TSR-1 红；把措辞改成夹带判断 ⇒ TSR-2 红；
 * 让 `MIN_FILES_FOR_CLUSTERS` 门控失效（小仓库也给提醒）⇒ TSR-3 红。
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { buildFamilyReminder } from "../../src/core/llm/task-keyword-search";

function bigWorkspace() {
  const root = mkdtempSync(join(tmpdir(), "codem-family-reminder-"));
  // 够大（≥ MIN_FILES_FOR_CLUSTERS），且有两个族
  for (let i = 0; i < 60; i++) writeFileSync(join(root, `noise-${String(i).padStart(2, "0")}.test.ts`), "// n");
  for (let i = 1; i <= 6; i++) writeFileSync(join(root, `dsh-d${i}-usage-thing.test.ts`), "// x");
  return root;
}

describe("第 109 波：判据族提醒（红了之后再放一次）", () => {
  it("TSR-1: 给出与任务词面相近的族的成员文件名（不是只给个数量）", () => {
    const root = bigWorkspace();
    try {
      const reminder = buildFamilyReminder(root, "用量统计面板的数字偏低，怀疑记账只记了一部分 usage");
      expect(reminder, "有相关族时应当给出提醒").toBeTruthy();
      expect(reminder).toContain("[判据族提醒]");
      // 相关族的成员应当**具体列出来**（而不是只给数量）
      expect(reminder, `相关族的成员要列出来（实际：${reminder}）`).toContain("dsh-d3-usage-thing.test.ts");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("TSR-2: 措辞只陈述事实（不许出现「你没碰过/你该看」这类判断）", () => {
    const root = bigWorkspace();
    try {
      const reminder = buildFamilyReminder(root, "usage 记账")!;
      for (const banned of ["你没", "你该", "必须", "务必", "漏了", "忽略了"]) {
        expect(reminder, `不该出现判断式措辞「${banned}」`).not.toContain(banned);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("TSR-3 反向对照: 小仓库里不给这段提醒（否则每个项目都被塞一段噪声）", () => {
    const root = mkdtempSync(join(tmpdir(), "codem-family-reminder-small-"));
    try {
      writeFileSync(join(root, "a.test.ts"), "// x");
      writeFileSync(join(root, "b.test.ts"), "// y");
      expect(buildFamilyReminder(root, "usage 记账")).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
