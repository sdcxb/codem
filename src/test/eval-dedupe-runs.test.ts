/**
 * 第 122 波：**收尾整理的语义**（`tools/eval/dedupe-runs.mjs` 的 `planDedupe`）。
 *
 * ## 为什么这条判据非有不可
 *
 * 这个脚本是**数据集的最终裁决者**：它决定"哪个 run 号上留哪条记录"，
 * 而判定器/成对报告/符号检验**都按 (caseId, runNumber) 配对**。
 * 它一旦错了（例如把干净记录挪走、留下脏记录），结论就会**静默地**建在脏数据上 ——
 * 而且事后从报告里看不出来（报告只会显示"某个 run-2 的结果"）。
 *
 * ## 它要修的那个真实场景
 *
 * 两个机制原本规则相反：写入守卫把**新来**的重复记录挪到 900+（键干净了，但**旧记录留在正位**）；
 * 收尾整理按"键"去重时，那条**干净记录**就会被当成多余的排除掉。
 * 实测踩到：`repo-06` 的干净 run 变成 `run-901:passed`，正位 `run-2/run-3` 留着脏记录。
 *
 * 所以 `planDedupe` 必须**先按 `parkedFrom` 把记录归回原本的键**，再在组内保留最后一条。
 *
 * 变异自证：把 `keyOf` 里的 `?? r.parkedFrom` 去掉（不归位）⇒ PD-1 立刻红。
 */
import { describe, it, expect } from "vitest";

import { planDedupe, PARK_FROM } from "../../tools/eval/dedupe-runs.mjs";

const rec = (caseId, runNumber, outcome, extra = {}) => ({ caseId, runNumber, outcome, ...extra });

describe("第 122 波：收尾整理（按原始 run 号归一，组内保留最后一条）", () => {
  it("PD-1: 被守卫挪走的**干净记录**是组内最后一条 ⇒ 必须回到原本的 run 号（回到正位）", () => {
    const rows = [
      rec("repo-06", 2, "failed"), // 脏期那条（正位）
      rec("repo-06", 3, "failed"),
      rec("repo-06", 901, "passed", { parkedFrom: 2, parkNote: "重复键" }), // 干净那条被守卫挪走
    ];
    const { rows: fixed } = planDedupe(rows);
    const run2 = fixed.filter((r) => r.runNumber === 2);
    expect(run2, "run-2 上应当只剩一条").toHaveLength(1);
    expect(run2[0].outcome, "留在 run-2 的必须是干净的通过那条").toBe("passed");
    expect(run2[0].parkedFrom, "回到正位后不该再带挪位痕迹").toBeUndefined();
    // 旧的那条（run-2 的脏记录）被挪走，但**数据不丢**；run-3 本来就只有一条 ⇒ 原地不动
    const parked = fixed.filter((r) => r.runNumber >= PARK_FROM);
    expect(parked, "只该挪走 run-2 组里让位的那一条").toHaveLength(1);
    expect(parked[0].outcome).toBe("failed");
    expect(parked[0].parkedFrom, "挪走的记录必须留下出处").toBe(2);
    expect(fixed.filter((r) => r.runNumber === 3).map((r) => r.outcome), "run-3 只有一条，不该被动").toEqual(["failed"]);
  });

  it("PD-2: 整理后**不再有重复键**（这是它能安全喂给判定器的前提）", () => {
    const rows = [
      rec("a", 2, "passed"),
      rec("a", 2, "failed"),
      rec("a", 900, "errored", { parkedFrom: 2 }),
      rec("b", 3, "passed"),
      rec("b", 3, "passed"),
    ];
    const { rows: fixed } = planDedupe(rows);
    const keys = fixed.map((r) => `${r.caseId}|${r.runNumber}`);
    expect(new Set(keys).size, `整理后仍有重复键：${keys.join(", ")}`).toBe(keys.length);
  });

  it("PD-3: 没有重复时**一个字段都不该动**（反向对照：别把正常数据改坏）", () => {
    const rows = [rec("a", 2, "passed"), rec("a", 3, "failed"), rec("b", 2, "failed")];
    const { rows: fixed, moves } = planDedupe(rows);
    expect(moves).toHaveLength(0);
    expect(fixed).toEqual(rows);
  });

  it("PD-4: 不同任务的同号互不影响（键里必须带 caseId）", () => {
    const rows = [rec("a", 2, "passed"), rec("b", 2, "failed"), rec("c", 2, "passed")];
    const { rows: fixed, moves } = planDedupe(rows);
    expect(moves).toHaveLength(0);
    expect(fixed.filter((r) => r.runNumber === 2)).toHaveLength(3);
  });
});
