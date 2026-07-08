import type { SubagentSpawner, SubagentTask, SubagentResult, SubagentActivity } from "./subagent";
import type { LLMEngine } from "../llm";
import * as MessageStorage from "../storage/message";
import { getLang } from "../i18n/lang";

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

/** Get a human-readable label for a tool call */
function getToolLabel(toolName: string): string {
  const zh = getLang() === "zh";
  const titleMap: Record<string, string> = {
    read_file: zh ? "读取文件" : "read_file",
    write_file: zh ? "写入文件" : "write_file",
    edit_file: zh ? "编辑文件" : "edit_file",
    multi_edit_file: zh ? "编辑文件" : "multi_edit_file",
    list_directory: zh ? "列出目录" : "list_directory",
    list_dir: zh ? "列出目录" : "list_dir",
    search_code: zh ? "搜索代码" : "search_code",
    grep_search: zh ? "搜索代码" : "grep_search",
    codebase_search: zh ? "搜索代码库" : "codebase_search",
    run_terminal_command: zh ? "运行命令" : "run_command",
    run_test: zh ? "运行测试" : "run_test",
    web_fetch: zh ? "获取网页" : "web_fetch",
    spawn_subagent: zh ? "创建子智能体" : "spawn_subagent",
    create_file: zh ? "创建文件" : "create_file",
    delete_file: zh ? "删除文件" : "delete_file",
    file_search: zh ? "搜索文件" : "file_search",
    glob_file_search: zh ? "搜索文件" : "glob_file_search",
    todo_write: zh ? "更新任务" : "update_tasks",
  };
  return titleMap[toolName] || toolName;
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
      activities: [],
    };

    // Store parent abort signal for cancellation propagation
    const parentAbortSignal = (taskData as any).parentAbortSignal as AbortSignal | undefined;

    // 异步执行子智能体
    this.executeTask(task, parentAbortSignal).catch((err) => {
      console.error(`[SubagentSpawner] Task ${task.id} failed:`, err);
    });

    return task;
  }

  /** Add a new activity to the task */
  private addActivity(task: SubagentTask, activity: SubagentActivity): void {
    if (!task.activities) task.activities = [];
    task.activities.push(activity);
  }

  /** Mark all running activities as done */
  private completeRunningActivities(task: SubagentTask): void {
    if (!task.activities) return;
    for (const a of task.activities) {
      if (a.status === "running") {
        a.status = "done";
        a.completedAt = Date.now();
      }
    }
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
    task.activities = [];
    console.log(`[SubagentSpawner] Task ${task.id} started`);

    // Track if we have a running thinking activity
    let hasRunningThinking = false;

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
          this.completeRunningActivities(task);
          console.log(`[SubagentSpawner] Task ${task.id} cancelled`);
          return;
        }

        // Capture text response — also marks thinking as done
        if (event.type === "text_delta") {
          currentText += event.text;
          output += event.text;
          // Text output means thinking is done
          if (hasRunningThinking) {
            this.completeRunningActivities(task);
            hasRunningThinking = false;
          }
        }

        // Capture reasoning (DeepSeek thinking mode) — start a thinking activity
        if (event.type === "reasoning_delta") {
          currentReasoning += event.text;
          if (!hasRunningThinking) {
            const zh = getLang() === "zh";
            this.addActivity(task, {
              id: `act-${generateId()}`,
              type: "thinking",
              label: zh ? "思考" : "Thinking",
              status: "running",
              startedAt: Date.now(),
            });
            hasRunningThinking = true;
          }
        }

        // Save assistant message when tool calls start
        if (event.type === "tool_start") {
          // Tool starts → thinking is done
          if (hasRunningThinking) {
            this.completeRunningActivities(task);
            hasRunningThinking = false;
          }

          // Add tool activity
          this.addActivity(task, {
            id: `act-${generateId()}`,
            type: "tool",
            label: getToolLabel(event.toolCall.name),
            status: "running",
            startedAt: Date.now(),
          });

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
          // Mark the tool activity as done
          if (task.activities) {
            const lastTool = [...task.activities].reverse().find(a => a.type === "tool" && a.status === "running");
            if (lastTool) {
              lastTool.status = "done";
              lastTool.completedAt = Date.now();
            }
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
          // Mark the tool activity as done
          if (task.activities) {
            const lastTool = [...task.activities].reverse().find(a => a.type === "tool" && a.status === "running");
            if (lastTool) {
              lastTool.status = "done";
              lastTool.completedAt = Date.now();
            }
          }
        }

        // On new iteration start, mark all running activities as done
        if (event.type === "start" && (event as any).iteration > 1) {
          this.completeRunningActivities(task);
          hasRunningThinking = false;
        }

        // On end event, mark all running activities as done
        if (event.type === "end") {
          this.completeRunningActivities(task);
          hasRunningThinking = false;
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
        ? output + "\n\n" + (getLang() === "zh" ? "[工具结果]" : "[Tool Results]") + "\n" + toolResults.join("\n---\n")
        : output;

      // Parse result
      const { parseTaskResult } = await import("./subagent");
      const result = parseTaskResult(fullOutput);

      task.status = "completed";
      task.result = result;
      task.completedAt = Date.now();
      this.completeRunningActivities(task);
      console.log(`[SubagentSpawner] Task ${task.id} completed, result status: ${result.status}, output length: ${result.output.length}`);
    } catch (err: any) {
      task.status = "failed";
      task.error = err.message;
      task.completedAt = Date.now();
      this.completeRunningActivities(task);
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
