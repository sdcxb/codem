/**
 * Workflow Engine — JavaScript 工作流编排
 *
 * Design (对标 DeepSeek Harness workflow tool):
 * - LLM 调用 workflow 工具，传入 JS 代码
 * - 工作流引擎执行代码，可 fan-out 子智能体
 * - 支持并行和串行执行
 * - 结果汇总返回
 *
 * ## 权限对齐（本轮修复的核心）
 *
 * 修复前这里是**与 `run_code` 完全相同的闸门旁路**：`sdk.bash` 直接
 * `executeCommand(...)`（从不经过 `analyzeBashCommand`）、`sdk.write` 直接
 * `writeFile(...)`（从不经过受保护路径检查与覆盖确认）。而 `workflow` 在
 * `isAutoApprovable`（`security-mode.ts:149-184`，末尾 `return true`）下同样恒为
 * 「可自动放行」—— 于是 `Remove-Item -Recurse -Force …` 包在 workflow 里就能
 * 绕过危险命令闸门，且比 `bash` 还宽松。
 *
 * 现在 `sdk.bash` / `sdk.write` 走 `tool-gates.ts` 里**与 `run_code` 同一份**
 * 闸门实现（危险命令一律拒绝、分析器抛错 fail-closed；受保护路径先拒绝；
 * 覆盖写走与 `write` 工具相同的确认路径）。
 *
 * ## 未闭合的部分（如实记录）
 *
 * workflow 的代码**不再用 `new Function` 在本进程里跑**（第 103/116 波）：它走
 * `executeCode()` —— 与 `run_code` 同一条 **Rust 侧 `boa_engine` 沙箱**（无 eval、CSP 不需要
 * `unsafe-eval`）。仍然可以 `sdk.spawn` 起子智能体 —— 子智能体是自己的会话、有自己的权限链，
 * 不在这道闸门覆盖范围内。**本文件仍然不声称 workflow 是权限沙箱**：它沙箱化的是
 * "代码在哪跑"，不是"它能做什么"（后者由 `sdk.*` 上的闸门管）。
 *
 * 接线判据：`workflow-sandbox-wiring.test.ts`（换掉 runner 后 workflow 必须走它、
 * 且不许出现 `new Function`）。
 */

import type { ToolDef, ToolContext, ToolExecuteResult } from "./tools";
import { executeCode } from "./tools/run-code";
import {
  confirmWriteIfNeeded,
  refuseDangerousCommand,
  refuseProtectedPathWrite,
} from "./tool-gates";

// ========== Workflow SDK ==========

interface WorkflowSDK {
  /** Spawn a sub-agent for a subtask */
  spawn(agentId: string, prompt: string): Promise<string>;
  /** Wait for a sub-agent to complete */
  wait(taskId: string): Promise<{ success: boolean; result: string }>;
  /** Execute a bash command */
  bash(command: string): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  /** Read a file */
  read(path: string): Promise<string>;
  /** Write a file */
  write(path: string, content: string): Promise<void>;
}

// ========== Workflow Tool ==========

export function createWorkflowTool(): ToolDef {
  return {
    id: "workflow",
    /**
     * 契约声明（本轮修正）：原来写的是 `{ workspace, workspace }` —— 那**低估了**
     * 它的能力：workflow 能跑任意 shell（改的是**系统**状态，不只是工作区文件），
     * 还能 fan-out 子智能体、写工作区外的路径。
     *
     * 改为与 `bash` / `run_code` / `terminal_*` 同一档的 `{ system, system }`：
     * - `sideEffectScope` 是静态声明，表达不了「取决于脚本内容」，
     *   所以只能按最坏情况声明（`tool-contract.ts:377` 的 `bash` 同款理由）；
     * - 声明成 `system` 之后 `isShellLike()`（`tool-contract.ts:389`）自动为真，
     *   计划模式（只读契约）会在命令意图通道上把它当作「可能写」处理 ——
     *   workflow 没有 `command` 参数，于是按「非只读 ⇒ 拒绝」拦下（原来也是拒绝，
     *   只是走的是通用分支，理由不如现在清楚）。
     *
     * 已知代价（如实记录）：`needsPreCallSnapshot()` = 「改工作区 **或** 破坏性」，
     * 所以 `system` 声明会让 workflow **不再**触发调用前的工作区快照 ——
     * 这与 `bash` / `run_code` 现有行为一致（它们同样不拍快照）。
     * 若要让 workflow 恢复「调用前快照」，需要显式声明 `destructive: true`
     * （那会同时改变计划模式的拒绝文案），本轮不擅自扩大改动范围。
     */
    contract: { sideEffectScope: "system", accessScope: "system" },
    guidance: "Use workflow to define and execute multi-step automated workflows. Workflows can chain tools, run conditionals, and loop. The workflow runs IN-PROCESS with the application's own privileges; nested sdk.bash / sdk.write calls face the same permission gates as run_code (dangerous shell commands are refused outright).",
    description: `Execute a JavaScript workflow that can fan-out sub-agents and collect results.

The workflow code receives an \`sdk\` object with:
- sdk.spawn(agentId, prompt) — spawn a sub-agent, returns task ID
- sdk.wait(taskId) — wait for a sub-agent, returns result
- sdk.bash(command) — execute shell command; refused if it is classified dangerous (use the bash tool directly so the user is asked)
- sdk.read(path) — read file
- sdk.write(path, content) — write file; protected paths (.git/, .env, node_modules/) are refused and overwriting a differing existing file requires user confirmation in ask mode

Example:
\`\`\`javascript
// Parallel fan-out: spawn 3 agents
const tasks = await Promise.all([
  sdk.spawn("explore", "Find all TODO comments in src/"),
  sdk.spawn("explore", "Find all console.log statements"),
  sdk.spawn("explore", "Find unused exports"),
]);

// Collect results
const results = await Promise.all(tasks.map(id => sdk.wait(id)));
console.log(JSON.stringify(results, null, 2));
\`\`\``,
    parameters: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description: "JavaScript workflow code. Use `await` for async operations.",
        },
        timeout_ms: {
          type: "number",
          description: "Execution timeout in milliseconds (default: 120000, max: 300000)",
        },
      },
      required: ["code"],
    },
    async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolExecuteResult> {
      const code = args.code as string;
      const timeoutMs = Math.min(args.timeout_ms as number || 120_000, 300_000);

      if (!code || code.trim().length === 0) {
        return { title: "workflow", output: "Error: code parameter is required." };
      }

      // Build SDK — DSH-style: use SubagentRuntime instead of old SubagentManager
      const sdk: WorkflowSDK = {
        async spawn(agentId, prompt) {
          const { getSubagentRuntime } = await import("../subagent/index");
          const runtime = getSubagentRuntime();
          if (!runtime) throw new Error("SubagentRuntime not available");
          // DSH-style: startContinuable returns { childId, messageId }
          const result = await runtime.startContinuable({
            provider: 'spawn',
            label: agentId,
            request: {
              parentSessionId: ctx.sessionId,
              agentId,
              prompt,
              cwd: ctx.cwd,
            },
            signal: ctx.abort ?? new AbortController().signal,
          });
          return result.childId;
        },
        async wait(taskId) {
          const { getSubagentRuntime } = await import("../subagent/index");
          const runtime = getSubagentRuntime();
          if (!runtime) throw new Error("SubagentRuntime not available");
          // DSH-style: await the executionDone promise instead of polling
          // 对标 DSH SubagentRun.result — 不再轮询
          const activity = runtime.getTask(taskId);
          if (!activity) return { success: false, result: "Task not found" };
          // Wait for the activity to settle via executionDone promise
          await runtime.waitForTask(taskId);
          const updated = runtime.getTask(taskId);
          if (!updated) return { success: false, result: "Task disappeared" };
          if (updated.status === 'completed') {
            return { success: true, result: updated.result?.output || "" };
          }
          if (updated.status === 'failed') {
            return { success: false, result: updated.error || "Task failed" };
          }
          return { success: false, result: `Task ended with status: ${updated.status}` };
        },
        async bash(command) {
          // 闸门（与 run_code 同一份）：危险命令**一律拒绝**，分析器抛错同样拒绝。
          // 为什么是「拒绝」而不是「按模式放行」/「去问用户」：见 tool-gates.ts 的
          // `refuseDangerousCommand` 注释（ToolContext 里没有审批通道）。
          const refusal = refuseDangerousCommand(command, ctx.securityMode, 60_000, "workflow");
          if (refusal) throw new Error(refusal);
          const { executeCommand } = await import("../file-api");
          // FIX: 有界超时（默认 60s），避免工作流内命令挂 600s
          const result = await executeCommand(command, ctx.cwd, 60_000);
          return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode ?? 0 };
        },
        async read(path) {
          const { readFile } = await import("../file-api");
          return await readFile(path);
        },
        async write(path, content) {
          // 受保护路径（.git/ .env node_modules/ …）：`write` 工具在建任何东西之前就拒绝。
          const protectedRefusal = await refuseProtectedPathWrite(path);
          if (protectedRefusal) throw new Error(protectedRefusal);
          // 覆盖确认：与 `write` 工具同一判据（ask 模式 + onWriteConfirm）。
          const confirmed = await confirmWriteIfNeeded(path, content, ctx, "workflow");
          if (!confirmed.ok) throw new Error(confirmed.reason);
          const { writeFile } = await import("../file-api");
          await writeFile(path, content, { workspace: ctx.cwd });
        },
      };

      try {
        const result = await executeCode(code, sdk as any, timeoutMs);
        let output = "";
        if (result.stdout) output += result.stdout;
        if (result.stderr) output += "\n[stderr]:\n" + result.stderr;
        if (result.error) output += "\n[error]: " + result.error;
        return { title: "workflow", output: output || "(no output)" };
      } catch (err: any) {
        return { title: "workflow", output: "Error: " + err.message };
      }
    },
  };
}

/**
 * Convenience wrapper for executing workflows from providers.
 *
 * ## 可达性（本轮实测追踪）
 *
 * **可达**（不是 `execRunCode` 那种死代码）：
 * - `src/core/provider/workflow-provider.ts:18` —— `ctx.provide('workflow', { run(...) })`
 *   的 `run` 就是本函数；
 * - 该 provider 在 `src/core/plugin-loader/builtin-registry.ts:302` 注册为
 *   `@codem/workflow`（`provides: ['workflow']`，默认启用）；
 * - 消费者：`tool-ralph-provider.ts:9`（`ctx.get('workflow').run(...)`）与
 *   `ui-workflow-run-provider.ts:14-16`（`wf.start/getStatus/cancel`，本 provider
 *   没有这些方法，故只有 `run` 这条真被调到）。
 *
 * 所以本函数**必须**与工具入口受同一道闸门。它的 `ctx` 是空对象
 * （没有 cwd / securityMode / onWriteConfirm）：
 * - `sdk.bash`：危险命令照样拒绝（`securityMode` 为 undefined 只影响拒绝文案里那一行）；
 * - `sdk.write`：受保护路径照样拒绝；覆盖确认因没有回调而无从进行 ——
 *   与 `write` 工具「没有回调时照写」的既有约定一致，不在这里发明新策略。
 *
 * 注意：调用方传进来的其实是 `steps`（任意值），而本函数签名是 `code: string` ——
 * 形态不匹配（`workflow-provider.ts:18` 的 `execWorkflow(steps, options)`）。
 * 这不是本轮要修的东西，但会让「provider 路径」在真机上大概率只得到一句执行错误；
 * 即便如此，闸门也必须在这里，否则它就是第二个旁路。
 */
export async function execWorkflow(code: string, options?: { timeout?: number }): Promise<string> {
  const tool = createWorkflowTool();
  const result = await tool.execute({ code, timeout_ms: options?.timeout }, {} as any);
  return result.output;
}
