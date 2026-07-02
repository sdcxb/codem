import type { ProcessorEvent } from "../llm/processor";

// ========== Sub-agent Types ==========
export type SubagentStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export interface SubagentTask {
  id: string;
  parentId: string;
  agentId: string;
  prompt: string;
  cwd: string;
  status: SubagentStatus;
  persistent: boolean;
  result?: SubagentResult;
  error?: string;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  timeout?: number;
}

export interface SubagentResult {
  status: "success" | "partial" | "failed" | "blocked";
  summary: string;
  output: string;
  filesTouched: string[];
  findings: string[];
}

export interface SubagentConfig {
  /** Default timeout for subagents (ms) */
  defaultTimeout: number;
  /** Maximum concurrent subagents */
  maxConcurrent: number;
  /** Maximum nesting depth */
  maxDepth: number;
}

const DEFAULT_CONFIG: SubagentConfig = {
  defaultTimeout: 10 * 60 * 1000, // 10 minutes
  maxConcurrent: 5,
  maxDepth: 3,
};

// ========== Subagent Spawner ==========
export interface SubagentSpawner {
  spawn(task: Omit<SubagentTask, "id" | "status" | "createdAt">): Promise<SubagentTask>;
  cancel(taskId: string): Promise<void>;
  getStatus(taskId: string): SubagentStatus;
  getResult(taskId: string): SubagentResult | undefined;
}

// ========== Subagent Manager ==========
export class SubagentManager {
  private tasks: Map<string, SubagentTask> = new Map();
  private config: SubagentConfig;
  private spawner?: SubagentSpawner;
  private listeners: Map<string, (event: ProcessorEvent) => void> = new Map();

  constructor(config?: Partial<SubagentConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Set the spawner implementation */
  setSpawner(spawner: SubagentSpawner) {
    this.spawner = spawner;
  }

  /** Spawn a subagent task */
  async spawn(
    parentId: string,
    agentId: string,
    prompt: string,
    cwd: string,
    timeout?: number,
    persistent?: boolean,
  ): Promise<SubagentTask> {
    if (!this.spawner) {
      throw new Error("No spawner configured");
    }

    // Check concurrency
    const running = this.getRunningTasks();
    if (running.length >= this.config.maxConcurrent) {
      throw new Error(`Maximum concurrent subagents (${this.config.maxConcurrent}) reached`);
    }

    // Check depth
    const depth = this.getDepth(parentId);
    if (depth >= this.config.maxDepth) {
      throw new Error(`Maximum nesting depth (${this.config.maxDepth}) reached`);
    }

    const task = await this.spawner.spawn({
      parentId,
      agentId,
      prompt,
      cwd,
      timeout: timeout || this.config.defaultTimeout,
      persistent: persistent || false,
    });

    this.tasks.set(task.id, task);

    // Start the task
    this.startTask(task.id);

    return task;
  }

  /** Start a task */
  private async startTask(taskId: string) {
    const task = this.tasks.get(taskId);
    if (!task) return;

    task.status = "running";
    task.startedAt = Date.now();
    this.tasks.set(taskId, task);

    // Set timeout
    if (task.timeout) {
      setTimeout(() => {
        if (task.status === "running") {
          this.cancel(taskId);
        }
      }, task.timeout);
    }
  }

  /** Complete a task */
  completeTask(taskId: string, result: SubagentResult) {
    const task = this.tasks.get(taskId);
    if (!task) return;

    task.status = "completed";
    task.result = result;
    task.completedAt = Date.now();
    this.tasks.set(taskId, task);
  }

  /** Fail a task */
  failTask(taskId: string, error: string) {
    const task = this.tasks.get(taskId);
    if (!task) return;

    task.status = "failed";
    task.error = error;
    task.completedAt = Date.now();
    this.tasks.set(taskId, task);
  }

  /** Cancel a task */
  async cancel(taskId: string) {
    const task = this.tasks.get(taskId);
    if (!task) return;

    if (task.status === "running" && this.spawner) {
      await this.spawner.cancel(taskId);
    }

    task.status = "cancelled";
    task.completedAt = Date.now();
    this.tasks.set(taskId, task);
  }

  /** Get a task */
  getTask(taskId: string): SubagentTask | undefined {
    return this.tasks.get(taskId);
  }

  /** Get all tasks for a parent */
  getChildTasks(parentId: string): SubagentTask[] {
    return Array.from(this.tasks.values())
      .filter((t) => t.parentId === parentId)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Get running tasks */
  getRunningTasks(): SubagentTask[] {
    return Array.from(this.tasks.values())
      .filter((t) => t.status === "running");
  }

  /** Get all tasks */
  getAllTasks(): SubagentTask[] {
    return Array.from(this.tasks.values())
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Get nesting depth */
  private getDepth(taskId: string): number {
    let depth = 0;
    let currentId = taskId;

    while (currentId) {
      const task = this.tasks.get(currentId);
      if (!task) break;
      currentId = task.parentId;
      depth++;
    }

    return depth;
  }

  /** Wait for a task to complete */
  async waitForCompletion(taskId: string, timeout?: number): Promise<SubagentResult> {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      const checkInterval = 1000;
      const maxWait = timeout || 10 * 60 * 1000;

      const check = () => {
        const task = this.tasks.get(taskId);
        if (!task) {
          reject(new Error("Task not found"));
          return;
        }

        if (task.status === "completed" && task.result) {
          resolve(task.result);
          return;
        }

        if (task.status === "failed") {
          reject(new Error(task.error || "Task failed"));
          return;
        }

        if (task.status === "cancelled") {
          reject(new Error("Task cancelled"));
          return;
        }

        if (Date.now() - startTime > maxWait) {
          reject(new Error("Timeout waiting for task"));
          return;
        }

        setTimeout(check, checkInterval);
      };

      check();
    });
  }

  /** Emit event for a task */
  emitEvent(taskId: string, event: ProcessorEvent) {
    const listener = this.listeners.get(taskId);
    if (listener) {
      listener(event);
    }
  }

  /** Subscribe to task events */
  onEvent(taskId: string, listener: (event: ProcessorEvent) => void) {
    this.listeners.set(taskId, listener);
    return () => {
      this.listeners.delete(taskId);
    };
  }

  /** Get stats */
  getStats(): {
    total: number;
    running: number;
    completed: number;
    failed: number;
    cancelled: number;
  } {
    const tasks = Array.from(this.tasks.values());
    return {
      total: tasks.length,
      running: tasks.filter((t) => t.status === "running").length,
      completed: tasks.filter((t) => t.status === "completed").length,
      failed: tasks.filter((t) => t.status === "failed").length,
      cancelled: tasks.filter((t) => t.status === "cancelled").length,
    };
  }

  /** Clear completed tasks */
  clearCompleted() {
    for (const [id, task] of this.tasks) {
      if (task.status === "completed" || task.status === "failed" || task.status === "cancelled") {
        this.tasks.delete(id);
      }
    }
  }
}

// ========== Task Result Parser ==========
export function parseTaskResult(output: string): SubagentResult {
  const lines = output.split("\n");
  let status: SubagentResult["status"] = "success";
  let summary = "";
  let filesTouched: string[] = [];
  let findings: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    // Parse status
    if (trimmed.startsWith("**Status**:")) {
      const statusStr = trimmed.replace("**Status**:", "").trim().toLowerCase();
      if (statusStr.includes("success")) status = "success";
      else if (statusStr.includes("partial")) status = "partial";
      else if (statusStr.includes("failed")) status = "failed";
      else if (statusStr.includes("blocked")) status = "blocked";
    }

    // Parse summary
    if (trimmed.startsWith("**Summary**:")) {
      summary = trimmed.replace("**Summary**:", "").trim();
    }

    // Parse files touched
    if (trimmed.startsWith("**Files touched**:")) {
      const filesStr = trimmed.replace("**Files touched**:", "").trim();
      if (filesStr !== "(none)") {
        filesTouched = filesStr.split(",").map((f) => f.trim());
      }
    }

    // Parse findings
    if (trimmed.startsWith("**Findings worth promoting**:")) {
      const findingsStr = trimmed.replace("**Findings worth promoting**:", "").trim();
      if (findingsStr !== "(none)") {
        findings = findingsStr.split("\n").map((f) => f.replace(/^-\s*/, "").trim()).filter(Boolean);
      }
    }
  }

  return {
    status,
    summary: summary || "Task completed",
    output,
    filesTouched,
    findings,
  };
}

// ========== Singleton ==========
let instance: SubagentManager | null = null;

export function getSubagentManager(): SubagentManager {
  if (!instance) {
    instance = new SubagentManager();
  }
  return instance;
}
