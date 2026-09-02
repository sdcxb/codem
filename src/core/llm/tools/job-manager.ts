/**
 * Job Manager — Bash 后台任务管理
 *
 * Design (对标 DeepSeek Harness background jobs):
 * - bash 工具支持 background: true 参数
 * - 后台任务有自己的 ID，可查询状态和输出
 * - job_kill 可终止后台任务
 * - job_list 列出所有后台任务
 * - job_output 获取任务输出
 */

import { executeCommand } from "../../file-api";

// ========== Types ==========

export interface BackgroundJob {
  id: string;
  command: string;
  cwd: string;
  status: "running" | "completed" | "killed" | "error";
  exitCode?: number;
  stdout: string;
  stderr: string;
  startedAt: number;
  completedAt?: number;
  abortController?: AbortController;
}

// ========== Job Manager ==========

class JobManager {
  private jobs = new Map<string, BackgroundJob>();

  /**
   * Start a background bash command.
   */
  async start(command: string, cwd: string, timeoutMs?: number): Promise<string> {
    const id = `job-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
    const abortController = new AbortController();

    const job: BackgroundJob = {
      id,
      command,
      cwd,
      status: "running",
      stdout: "",
      stderr: "",
      startedAt: Date.now(),
      abortController,
    };

    this.jobs.set(id, job);

    // Execute in background (don't await)
    this.executeJob(job, timeoutMs).catch(err => {
      job.status = "error";
      job.stderr += `\n[JobManager]: ${err.message}`;
      job.completedAt = Date.now();
    });

    return id;
  }

  private async executeJob(job: BackgroundJob, timeoutMs?: number): Promise<void> {
    try {
      // FIX: 后台任务也传有界超时（job 创建时可指定），Rust 超时杀进程树。
      const result = await executeCommand(job.command, job.cwd, timeoutMs);
      job.stdout = result.stdout;
      job.stderr = result.stderr;
      job.exitCode = result.exitCode ?? 0;
      job.status = job.exitCode === 0 ? "completed" : "error";
      job.completedAt = Date.now();
    } catch (err: any) {
      if (job.status === "killed") return;
      job.stderr += `\n[JobManager]: ${err.message}`;
      job.status = "error";
      job.exitCode = -1;
      job.completedAt = Date.now();
    }
  }

  /**
   * Get a job by ID.
   */
  getJob(id: string): BackgroundJob | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    // Return a copy without the abortController
    const { abortController, ...rest } = job;
    return rest;
  }

  /**
   * List all jobs.
   */
  listJobs(): BackgroundJob[] {
    return Array.from(this.jobs.values()).map(job => {
      const { abortController, ...rest } = job;
      return rest;
    });
  }

  /**
   * Get the latest output for a job.
   */
  getOutput(id: string): { stdout: string; stderr: string; status: string } | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    return {
      stdout: job.stdout,
      stderr: job.stderr,
      status: job.status,
    };
  }

  /**
   * Kill a running job.
   */
  kill(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job || job.status !== "running") return false;
    job.abortController?.abort();
    job.status = "killed";
    job.completedAt = Date.now();
    return true;
  }

  /**
   * Clean up completed jobs older than the given age.
   */
  cleanup(maxAgeMs: number = 300_000): void {
    const now = Date.now();
    for (const [id, job] of this.jobs) {
      if (job.completedAt && now - job.completedAt > maxAgeMs) {
        this.jobs.delete(id);
      }
    }
  }
}

// ========== Singleton ==========

let jobManager: JobManager | null = null;

export function getJobManager(): JobManager {
  if (!jobManager) {
    jobManager = new JobManager();
  }
  return jobManager;
}
