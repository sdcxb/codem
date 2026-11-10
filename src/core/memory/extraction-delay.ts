/**
 * 空闲批次延迟的**档位常量**（24 号文 §P0-3：「空闲/延迟批次（例如 30–120 秒）」）。
 *
 * 为什么单独一个文件：调度器（`extraction-batcher.ts`）与引擎（`llm/index.ts`）
 * 都要用同一组数字 —— 判据与运行时不许各写一份（那正是"两套口径"的老毛病）。
 */

/** 下限：30 秒（比这更短就退化成"每回合立即跑"，那是这条需求要治的形态） */
export const EXTRACTION_IDLE_DELAY_MIN_MS = 30_000;

/** 上限：120 秒（再长用户会觉得"记忆系统不工作了"） */
export const EXTRACTION_IDLE_DELAY_MAX_MS = 120_000;
