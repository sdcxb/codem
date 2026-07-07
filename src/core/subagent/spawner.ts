import type { SubagentSpawner, SubagentTask, SubagentResult } from "./subagent";
import type { LLMEngine } from "../llm";
import * as MessageStorage from "../storage/message";

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * 实际的子智能体 Spawner
 * 基于 LLMEngine 执行子智能体任务
 */
export class LLMSubagentSpawner implements SubagentSpawner {
  private engine: LLMEngine;
  private activeTasks: Map<string, { abort: AbortController; task: SubagentTask }> = new Map();

  constructor(engine: LLMEngine) {
    this.engine = engine;
  }

  async spawn(taskData: Omit<SubagentTask, "id" | "status" | "createdAt">): Promise<SubagentTask> {
    const task: SubagentTask = {
      id: (taskData as any).id || `sub-${generateId()}`,
      name: (taskData as any).name || `Agent-${generateId()}`,
      parentId: taskData.parentId,
      agentId: taskData.agentId,
      prompt: taskData.prompt,
      cwd: taskData.cwd,
      status: "pending",
      persistent: taskData.persistent || false,
      timeout: taskData.timeout,
      createdAt: Date.now(),
    };

    // Store parent abort signal for cancellation propagation
    const parentAbortSignal = (taskData as any).parentAbortSignal as AbortSignal | undefined;

    // 异步执行子智能体
    this.executeTask(task, parentAbortSignal).catch((err) => {
      console.error(`[SubagentSpawner] Task ${task.id} failed:`, err);
    });

    return task;
  }

  private async executeTask(task: SubagentTask, parentAbortSignal?: AbortSignal): Promise<void> {
    const abort = new AbortController();
    this.activeTasks.set(task.id, { abort, task });

    // Listen to parent abort signal to cancel sub-agent when main task is cancelled
    if (parentAbortSignal) {
      parentAbortSignal.addEventListener("abort", () => {
        console.log(`[SubagentSpawner] Parent aborted, cancelling task ${task.id}`);
        abort.abort();
      });
    }

    task.status = "running";
    task.startedAt = Date.now();
    console.log(`[SubagentSpawner] Task ${task.id} started`);

    try {
      // Generate a unique session ID for the sub-agent
      const sessionId = `sub-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

      // Execute main loop
      let output = "";
      let toolResults: string[] = [];
      let toolCallCount = 0;
      let currentAssistantMsgId = "";
      let currentText = "";
      let currentReasoning = "";
      for await (const event of this.engine.processSubagent(sessionId, task.prompt, task.cwd, task.agentId)) {
        if (abort.signal.aborted) {
          task.status = "cancelled";
          task.completedAt = Date.now();
          console.log(`[SubagentSpawner] Task ${task.id} cancelled`);
          return;
        }

        // Capture text response
        if (event.type === "text_delta") {
          currentText += event.text;
          output += event.text;
        }

        // Capture reasoning (DeepSeek thinking mode)
        if (event.type === "reasoning_delta") {
          currentReasoning += event.text;
        }

        // Save assistant message when tool calls start
        if (event.type === "tool_start") {
          if (!currentAssistantMsgId) {
            currentAssistantMsgId = `assistant-${Date.now()}`;
            MessageStorage.createMessage({
              id: currentAssistantMsgId,
              role: "assistant",
              content: currentText || "",
              reasoning: currentReasoning || undefined,
              timestamp: Date.now(),
              status: "streaming",
            }, sessionId);
          }
          // Save tool call
          MessageStorage.addToolCall(currentAssistantMsgId, {
            id: event.toolCall.id,
            tool: event.toolCall.name,
            args: event.toolCall.input,
            status: "running",
          });
        }

        // Capture tool results and save to database
        if (event.type === "tool_complete" && event.result) {
          toolCallCount++;
          let toolOutput = typeof event.result === "string" ? event.result : (event.result as any).output || "";
          // Filter out <system-reminder> tags from tool results
          toolOutput = toolOutput.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
          console.log(`[SubagentSpawner] Task ${task.id} tool_complete: ${toolOutput.substring(0, 100)}...`);
          if (toolOutput) {
            toolResults.push(toolOutput);
          }
          // Save tool result to database
          if (currentAssistantMsgId) {
            MessageStorage.updateToolCall(currentAssistantMsgId, event.toolCall.id, {
              status: "done",
              result: toolOutput,
            });
          }
        }
        // Capture tool errors and save to database
        if (event.type === "tool_error") {
          toolCallCount++;
          const errorOutput = event.error || "Unknown error";
          console.log(`[SubagentSpawner] Task ${task.id} tool_error: ${errorOutput}`);
          toolResults.push(`Error: ${errorOutput}`);
          // Save tool error to database
          if (currentAssistantMsgId) {
            MessageStorage.updateToolCall(currentAssistantMsgId, event.toolCall.id, {
              status: "error",
              result: `Error: ${errorOutput}`,
            });
          }
        }
      }
      
      // Update assistant message with final text content and reasoning
      if (currentAssistantMsgId) {
        const update: any = {};
        if (currentText) update.content = currentText;
        if (currentReasoning) update.reasoning = currentReasoning;
        if (Object.keys(update).length > 0) {
          MessageStorage.updateMessage(currentAssistantMsgId, update);
        }
      }
      console.log(`[SubagentSpawner] Task ${task.id} finished, ${toolCallCount} tool calls, output length: ${output.length}`);

      // Filter <system-reminder> tags from AI text output
      output = output.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();

      // Combine AI text output with tool results
      const fullOutput = toolResults.length > 0
        ? output + "\n\n[工具结果]\n" + toolResults.join("\n---\n")
        : output;

      // Parse result
      const { parseTaskResult } = await import("./subagent");
      const result = parseTaskResult(fullOutput);

      task.status = "completed";
      task.result = result;
      task.completedAt = Date.now();
      console.log(`[SubagentSpawner] Task ${task.id} completed, result status: ${result.status}, output length: ${result.output.length}`);
    } catch (err: any) {
      task.status = "failed";
      task.error = err.message;
      task.completedAt = Date.now();
      console.error(`[SubagentSpawner] Task ${task.id} failed:`, err.message);
    } finally {
      this.activeTasks.delete(task.id);
    }
  }

  async cancel(taskId: string): Promise<void> {
    const active = this.activeTasks.get(taskId);
    if (active) {
      active.abort.abort();
      this.activeTasks.delete(taskId);
    }
  }

  getStatus(taskId: string): SubagentTask["status"] {
    const active = this.activeTasks.get(taskId);
    return active?.task.status || "pending";
  }

  getResult(taskId: string): SubagentResult | undefined {
    const active = this.activeTasks.get(taskId);
    return active?.task.result;
  }

  /** Cancel all running tasks */
  cancelAll(): void {
    for (const [taskId, active] of this.activeTasks) {
      if (active.task.status === "running") {
        console.log(`[SubagentSpawner] Cancelling all tasks, aborting ${taskId}`);
        active.abort.abort();
      }
    }
  }
}
