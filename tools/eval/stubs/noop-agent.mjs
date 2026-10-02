/**
 * 桩臂：**什么都不做**（不修任何东西），可选地交回一份用量。
 *
 * 它的作用是证明**判据会区分对错** —— 一个什么都不做的 agent 必须被判成失败。
 * 如果它也能"通过"，那这套任务集的判据就是假的（本仓库被这种假绿咬过多次）。
 *
 * 环境变量（由 `run-arm.mjs` 注入）：
 *   EVAL_WORKSPACE      工作区
 *   EVAL_EMIT_USAGE=1   顺便写一份 .arm-usage.json（用来验证"用量有上报"的那条路径）
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const ws = process.env.EVAL_WORKSPACE;
if (!ws) {
  console.error("noop-agent: 缺少 EVAL_WORKSPACE");
  process.exit(2);
}

if (process.env.EVAL_EMIT_USAGE === "1") {
  writeFileSync(
    join(ws, ".arm-usage.json"),
    JSON.stringify({
      inputTokens: 1000,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 1050,
      toolCalls: 1,
      estimatedCostUsd: 0.0002,
    }),
    "utf8",
  );
}

// 刻意什么都不做：不修 bug、不加功能。
console.log(`noop-agent: 收到任务 ${process.env.EVAL_TASK_ID ?? "?"}，按设计什么都不做`);
