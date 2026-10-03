/**
 * 第 117 波：**重复 (caseId, runNumber) 的处置**。
 *
 * ## 为什么要有判据（代价付过两次）
 *
 * 判定器与成对报告都按 **(caseId, runNumber)** 配对。同一个键有两条（结果还可能不同）
 * ⇒ 该对**直接被阻塞**，那一轮白跑。实测：
 *  · `repo-02 / control / run-2`：策略复跑写过 failed，补跑链又写 passed；
 *  · `repo-06 / treatment / run-2`：errored 一条，重跑又写一条 failed。
 *
 * 处置原则是 **"既不阻塞配对，也不丢数据"**：新来的重复记录挪到高位 run 号并留下
 * `parkedFrom` / `parkNote`，而不是删掉它。
 *
 * 变异自证：让 `planRecordAppend` 直接原样返回（不做挪位）⇒ PA-2/PA-3 红。
 */
import { describe, it, expect } from "vitest";

import { planRecordAppend, isParkedRecord, PARK_BASE } from "../../tools/eval/record-append.mjs";

const row = (caseId, runNumber, outcome) => ({ caseId, runNumber, outcome });

describe("第 117 波：重复运行号的处置", () => {
  it("PA-1: 没有重复 ⇒ 原样写入，不产生警告", () => {
    const planned = planRecordAppend([row("repo-01", 1, "passed")], row("repo-01", 2, "passed"));
    expect(planned.parked).toBe(false);
    expect(planned.warning).toBeNull();
    expect(planned.record.runNumber).toBe(2);
    expect(planned.record.parkedFrom).toBeUndefined();
  });

  it("PA-2: 同一个 (caseId, runNumber) 已存在 ⇒ **挪到高位 run 号**，并留下出处", () => {
    const planned = planRecordAppend([row("repo-02", 2, "failed")], row("repo-02", 2, "passed"));
    expect(planned.parked).toBe(true);
    expect(planned.record.runNumber).toBe(PARK_BASE);
    expect(planned.record.parkedFrom).toBe(2);
    expect(String(planned.record.parkNote), "要说清为什么挪").toMatch(/只能有一条/);
    expect(planned.warning, "要打一行可读的警告").toMatch(/挪到 run-900/);
    // **数据不丢**：结果本身仍在
    expect(planned.record.outcome).toBe("passed");
  });

  it("PA-3: 连续多条重复 ⇒ 高位 run 号依次递增（不会互相覆盖）", () => {
    const existing = [row("repo-02", 2, "failed"), row("repo-02", PARK_BASE, "passed")];
    const planned = planRecordAppend(existing, row("repo-02", 2, "errored"));
    expect(planned.record.runNumber).toBe(PARK_BASE + 1);
  });

  it("PA-4: 不同任务的相同 run 号**不算**重复（按键判定，不是只按 run 号）", () => {
    const planned = planRecordAppend([row("repo-03", 2, "failed")], row("repo-04", 2, "passed"));
    expect(planned.parked).toBe(false);
    expect(planned.record.runNumber).toBe(2);
  });

  /**
   * PA-5/PA-6（第 121 波补）：**"挪位记录"的判定必须抽成共享函数**。
   *
   * 起因是一次真实的近失：我把这条过滤分别写进 `ab-report` 与 `repo-paired-report`
   * 的读取路径，重构时 `repo-paired-report` 里漏掉一个回调引用 ⇒ **CLI 一跑就 ReferenceError**，
   * 而整套自测（28 条）**全绿** —— 因为它们不经过那条路径。
   * 所以：判定收成一处（`isParkedRecord`），并用判据钉住。
   */
  it("PA-5: 挪位记录的两个信号都要认（parkedFrom/parkNote，以及 runNumber ≥ 900 兜底）", () => {
    expect(isParkedRecord({ caseId: "x", runNumber: 2, parkedFrom: 2 })).toBe(true);
    expect(isParkedRecord({ caseId: "x", runNumber: 5, parkNote: "重复键" })).toBe(true);
    expect(isParkedRecord({ caseId: "x", runNumber: 900 })).toBe(true);
    expect(isParkedRecord({ caseId: "x", runNumber: 901 })).toBe(true);
  });

  it("PA-6 反向对照: 正常记录与脏输入都不算挪位（别把正常数据排除掉）", () => {
    expect(isParkedRecord({ caseId: "x", runNumber: 2, outcome: "passed" })).toBe(false);
    expect(isParkedRecord({ caseId: "x", runNumber: 89 })).toBe(false);
    expect(isParkedRecord(null)).toBe(false);
    expect(isParkedRecord(undefined)).toBe(false);
  });
});
