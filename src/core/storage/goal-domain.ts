/**
 * 长程目标模式的**数据层适配器**（ADR-0006 五张表）。
 *
 * ## 为什么单独一层（而不是让 `goal/store.ts` 直接读领域镜像）
 *
 * `src/test/no-sync-mirror-reads.test.ts` 的分层规则：**数据层以外**不许直接依赖
 * 「同步领域读」（`domainReadMany/One`）——那意味着文件必须等镜像驻留才能工作。
 * 领域投影本身是正当的（小域、有界），但"谁可以做这件事"必须写在数据层里，
 * 所以这里只放**行读写 + 失败上报**，业务规则（一个会话一个 active goal、不变契约）仍在
 * `goal/store.ts`。
 *
 * ## 失败上报的口径
 *
 * `domainWrite` 返回 `false` = 端口没接手（镜像未注册/未就绪）。这**必须**如实走
 * `reportPersistFailure`（用户可见的持久化失败）——目标状态是"重启后还要继续"的东西，
 * 静默丢失等于把长任务变成一次性表演。
 */

import { reportPersistFailure } from "./persist-failure";
import { domainReadMany, domainWrite } from "./domain-store";

/** 五张目标表（与 `schema.sql` / `tables.json` 一一对应） */
export type GoalDomainTable =
  | "goal_contracts"
  | "goal_plans"
  | "goal_phases"
  | "goal_evidence"
  | "goal_decisions";

/** 上报文案用的 area（与表名一一对应；分诊表里按 `<动态>` 登记，见 register 说明） */
const AREA: Record<GoalDomainTable, string> = {
  goal_contracts: "goal.contract",
  goal_plans: "goal.plan",
  goal_phases: "goal.phase",
  goal_evidence: "goal.evidence",
  goal_decisions: "goal.decision",
};

/** 读该表的全部匹配行（端口未接手 ⇒ undefined，调用方按"读不到"处理） */
export function readGoalRows<R>(
  table: GoalDomainTable,
  convert: (row: Record<string, unknown>) => R,
  where?: Record<string, unknown>,
): R[] | undefined {
  return domainReadMany(table, convert, where);
}

/** 整行覆盖写入（`INSERT OR REPLACE` 语义）；失败如实上报，不静默 */
export function writeGoalRows(table: GoalDomainTable, rows: Array<Record<string, unknown>>): void {
  const ok = domainWrite(table, rows, {
    mode: "replace",
    scope: AREA[table],
    note: `目标模式写入未落库（${table}）`,
  });
  if (!ok) {
    reportPersistFailure(
      AREA[table],
      new Error("端口未接手（该域镜像未注册或未就绪）"),
      `目标模式写入未落库（${table}）—— 重启后该目标状态可能丢失`,
    );
  }
}

/** 单个阶段写入失败时的专用上报（`goal/store.ts` 在"阶段不存在"时用） */
export function reportGoalPhaseMissing(phaseKey: string): void {
  reportPersistFailure("goal.phase", new Error("阶段不存在"), `阶段 ${phaseKey} 未保存（不存在）`);
}

/** 目标不存在时的专用上报（更新状态/计划时用） */
export function reportGoalMissing(): void {
  reportPersistFailure("goal.update", new Error("目标不存在"), "目标状态未保存（目标不存在）");
}
