import type { SubagentSpawner, SubagentTask, SubagentResult } from "./subagent";
import type { LLMEngine } from "../llm";

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
      ...taskData,
      id: `sub-${generateId()}`,
      status: "pending",
      createdAt: Date.now(),
    };

    // 异步执行子智能体
    this.executeTask(task).catch((err) => {
      console.error(`[SubagentSpawner] Task ${task.id} failed:`, err);
    });

    return task;
  }

  private async executeTask(task: SubagentTask): Promise<void> {
    const abort = new AbortController();
    this.activeTasks.set(task.id, { abort, task });

    task.status = "running";
    task.startedAt = Date.now();

    try {
      // 创建子智能体会话
      const session = this.engine.sessions.createSession(task.cwd || ".", task.agentId);

      // 执行主循环
      let output = "";
      for await (const event of this.engine.process(session.id, task.prompt, task.cwd, task.agentId)) {
        if (abort.signal.aborted) {
          task.status = "cancelled";
          return;
        }

        if (event.type === "text_delta") {
          output += event.text;
        }
      }

      // 解析结果
      const { parseTaskResult } = await import("./subagent");
      const result = parseTaskResult(output);

      task.status = "completed";
      task.result = result;
      task.completedAt = Date.now();
    } catch (err: any) {
      task.status = "failed";
      task.error = err.message;
      task.completedAt = Date.now();
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
}
