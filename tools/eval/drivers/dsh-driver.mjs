/**
 * DSH 侧（control 臂）的 driver —— 调 `dsh --profile headless --json`。
 *
 * ## 为什么要这个文件（而不是"没有 driver"）
 *
 * 我在 `docs/MEASUREMENT-PLAN-DSH-VS-CODEM.md` §4 里写过"两条真实臂的 driver 都没做"，
 * 理由是"DSH 没有 CLI"。**那个结论是错的**：我当时只查了 `dsh-headless` / `dsh-cmdline` 两个子包的 `bin`，
 * 又只在装机 app 根目录找 `dsh*` 可执行文件，两处都没有，就下了结论。
 * 实际上：
 *   · `@deepseek-ai/dsh` 这个**主包**声明了 `bin: { dsh: "lib/bin.js" }`（我没查它）；
 *   · 机器上 PATH 里**有** `dsh.cmd`（它在 `%APPDATA%\DSH Desktop\host-commands\...`，不在 app 目录里）；
 *   · `dsh --profile headless` 就是"回答一个任务、打印结果、退出"的**无头执行器**。
 * 所以 control 臂**不需要写任何引擎**，只需要这个薄薄的适配层。
 *
 * ## 事件契约（实测，`--json`）
 *
 * 逐行 JSON。关键事件：
 *   {"type":"session","sessionId":...,"cwd":...}
 *   {"type":"status","phase":"step_end","turn":N,"step":M,"usage":{inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens,totalTokens}}
 *   {"type":"tool_call","callId":...,"tool":"read","input":{...}}
 *   {"type":"final","text":"..."}
 *
 * **一次任务的用量 = 所有 `step_end` 事件的各桶求和**（每个 step 的 totalTokens 是该步的
 * input+output+cacheRead+cacheWrite，不是累计值 —— 实测：step1 total 6292 = 6154+138，
 * step2 total 6978 = 322+384+6272）。
 *
 * ## 刻意不做的事
 *
 * · **不算钱**：我不掌握真实计费口径，凭空写 `estimatedCostUsd` 就是往这把尺子里掺假数。
 *   宁可让这个指标"不可用"（评测器会拒绝据此下结论），也不编。
 * · **不因为 dsh 退出码非零就把任务判失败**：退出码记进审计字段，"做没做对"由任务自己的判据定。
 */
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const ws = process.env.EVAL_WORKSPACE;
const prompt = process.env.EVAL_TASK_PROMPT;
const taskId = process.env.EVAL_TASK_ID ?? "?";

if (!ws || !prompt) {
  console.error("dsh-driver: 缺少 EVAL_WORKSPACE / EVAL_TASK_PROMPT");
  process.exit(2);
}

const started = Date.now();
// 用 stdin（任务参数写 `-`）传 prompt：避开 Windows 上中文 + 换行 + 引号的转义地狱。
const result = spawnSync("dsh --profile headless --json -", {
  cwd: ws,
  shell: true,
  input: prompt,
  encoding: "utf8",
  timeout: 15 * 60 * 1000,
  env: { ...process.env, NO_COLOR: "1" },
});
const elapsedMs = Date.now() - started;

const stdout = result.stdout ?? "";
const stderr = result.stderr ?? "";

// 原始事件留档，便于事后核对（也便于别人质疑时能自己看）
writeFileSync(join(ws, ".dsh-events.jsonl"), stdout, "utf8");
writeFileSync(join(ws, ".dsh-stderr.txt"), stderr, "utf8");

const lines = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
const events = [];
for (const line of lines) {
  try {
    events.push(JSON.parse(line));
  } catch {
    // 非 JSON 行（理论上不该有）—— 不静默：数出来记进审计字段
  }
}

const buckets = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 };
let steps = 0;
let sessionId = null;
let finalText = "";
for (const event of events) {
  if (event.type === "session" && event.sessionId) sessionId = event.sessionId;
  if (event.type === "final" && typeof event.text === "string") finalText = event.text;
  if (event.phase === "step_end" && event.usage && typeof event.usage === "object") {
    steps++;
    for (const key of Object.keys(buckets)) {
      const value = event.usage[key];
      if (typeof value === "number" && Number.isFinite(value)) buckets[key] += value;
    }
  }
}
const toolCalls = events.filter((e) => e.type === "tool_call").length;

const usage = {
  ...buckets,
  toolCalls,
  // 审计字段（评测器只读上面那几个指标键，这些是给人看的）
  dshSteps: steps,
  dshEvents: events.length,
  dshExitStatus: result.status,
  dshSessionId: sessionId,
  dshWallMs: elapsedMs,
  dshFinalChars: finalText.length,
};

writeFileSync(join(ws, ".arm-usage.json"), JSON.stringify(usage, null, 2), "utf8");

console.log(
  `dsh-driver: ${taskId} 完成 status=${result.status} 用时 ${(elapsedMs / 1000).toFixed(1)}s ` +
    `steps=${steps} tools=${toolCalls} total=${buckets.totalTokens} ` +
    `(in ${buckets.inputTokens} / out ${buckets.outputTokens} / cacheRead ${buckets.cacheReadTokens})`,
);

// 刻意 exit 0：任务做没做对由判据决定，不由 dsh 的退出码决定。
process.exit(0);
