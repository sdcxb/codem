/**
 * 桩臂：把**参考解**写进工作区，可选地交回一份用量。
 *
 * 它的作用是证明判据在正确解上**会亮绿**（与 noop-agent 配成一对：
 * 一个必须全红、一个必须全绿，这套判据才算真的在判）。
 *
 * ⚠️ 它**不是**被测对象 —— 它不需要理解任务，只是把已知正确的文件抄进去。
 * 所以它跑出来的数字**不能**当作"我方水平"，只能当作"尺子本身能工作"的证据。
 *
 * 环境变量（由 `run-arm.mjs` 注入）：
 *   EVAL_TASK_ID        要取哪个任务的参考解
 *   EVAL_WORKSPACE      工作区
 *   EVAL_EMIT_USAGE=1   顺便写一份 .arm-usage.json
 *   EVAL_FAKE_TOKENS    可选：写进用量的 token 数（默认 4200），用来验算成对差值
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TASKS } from "../tasks.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ws = process.env.EVAL_WORKSPACE;
const taskId = process.env.EVAL_TASK_ID;

if (!ws || !taskId) {
  console.error("reference-solver: 缺少 EVAL_WORKSPACE / EVAL_TASK_ID");
  process.exit(2);
}

const task = TASKS.find((t) => t.id === taskId);
if (!task) {
  console.error(`reference-solver: 任务集里没有 ${taskId}`);
  process.exit(2);
}

for (const [rel, content] of Object.entries(task.reference)) {
  const target = resolve(ws, rel);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, "utf8");
}

if (process.env.EVAL_EMIT_USAGE === "1") {
  const tokens = Number(process.env.EVAL_FAKE_TOKENS ?? 4200);
  writeFileSync(
    join(ws, ".arm-usage.json"),
    JSON.stringify({
      inputTokens: Math.round(tokens * 0.9),
      outputTokens: Math.round(tokens * 0.1),
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: tokens,
      toolCalls: 4,
      estimatedCostUsd: tokens / 1_000_000,
    }),
    "utf8",
  );
}

console.log(`reference-solver: 已把 ${taskId} 的参考解写入工作区（${HERE}）`);
