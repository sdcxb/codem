/**
 * Workflow Engine — JavaScript 工作流编排
 *
 * Design (对标 DeepSeek Harness workflow tool):
 * - LLM 调用 workflow 工具，传入 JS 代码
 * - 工作流引擎执行代码，可 fan-out 子智能体
 * - 支持并行和串行执行
 * - 结果汇总返回
 */

import type { ToolDef, ToolContext, ToolExecuteResult } from "./tools";
import { executeCode } from "./tools/run-code";

// ========== Workflow SDK ==========

export interface WorkflowSDK {
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
  guidance: "Use workflow to define and execute multi-step automated workflows. Workflows can chain tools, run conditionals, and loop.",
    description: `Execute a JavaScript workflow that can fan-out sub-agents and collect results.

The workflow code receives an \`sdk\` object with:
- sdk.spawn(agentId, prompt) — spawn a sub-agent, returns task ID
- sdk.wait(taskId) — wait for a sub-agent, returns result
- sdk.bash(command) — execute shell command
- sdk.read(path) — read file
- sdk.write(path, content) — write file

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

/** Convenience wrapper for executing workflows from providers */
export async function execWorkflow(code: string, options?: { timeout?: number }): Promise<string> {
  const tool = createWorkflowTool();
  const result = await tool.execute({ code, timeout_ms: options?.timeout }, {} as any);
  return result.output;
}
