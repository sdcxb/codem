/**
 * P2-19/20: Job Tools — job_list / job_output / job_kill
 *
 * Wraps the **real** background-task source as LLM tools.
 * 对标 dsh 的 background job tools.
 *
 * ## ★ 第 185 波（T3）：这里原来有**两条**来源，其中一条是断线的死实现
 *
 * 改前本文件同时读两个来源：
 * - `terminal_send run_in_background` 创建的 PTY 后台发送（`TerminalManager`，id 前缀
 *   `pty-job-`）—— **真的能用**（`terminal-tools.ts:341-399` 的 `sendBackground`）；
 * - `bash run_in_background` 创建的普通后台命令（`JobManager`，id 前缀 `job-`）——
 *   **全仓无调用方**：`JobManager.start()` 是唯一写 `this.jobs` 的地方，而
 *   `getJobManager().start(` 零命中；`bash` 的 `parameters` 里也**没有** `background` 字段。
 *
 * 后果是"引导模型去用一条不存在的路"：`job_output` 永远回 `Job not found`，
 * 而 guidance 明确让模型用它收 `bash run_in_background` 的产出 ⇒ 模型反复换 id 重试，
 * 或断定"后台任务丢了"。
 *
 * ## 为什么选**如实下线**而不是把 `JobManager` 接上
 *
 * 「接上」要能成立，`job_kill` 必须**真的**能停下那条命令。而 `JobManager` 的后台命令走
 * `executeCommand`（Rust `execute_command` 一次 IPC 跑完），Rust 侧只提供"超时杀进程树"，
 * **没有按 id 杀**的入口；`kill()` 只是在 Map 里把状态改成 `killed` —— 命令照旧在跑。
 * 那正是同一份审计在 T3 里点名的「假成功」：对还在跑的进程报 ✅。
 * 在"不改 `src-tauri/`"的约束下，这条只能如实下线（真实可用的后台通道是 PTY 那条，
 * 它有会话 id、能发 SIGINT）。
 *
 * 于是本文件现在只服务 PTY 后台发送，guidance/description 也只提它。
 * 判据：`src/test/job-tools-background-truth.test.ts`。
 */

import type { ToolDef, ToolContext, ToolExecuteResult } from "../tools";
import {
  getTerminalBackgroundJob,
  listTerminalBackgroundJobs,
  killTerminalBackgroundJob,
} from "./terminal-tools";

function isPtyJobId(jobId: string): boolean {
  return jobId.startsWith("pty-job-");
}

export function createJobTools(): ToolDef[] {
  return [
    // job_list
    {
      id: "job_list",
      contract: { readOnly: true, accessScope: "session" },
      guidance:
        "Use job_list to list background jobs (terminal_send run_in_background) and their statuses.",
      description: `List all background jobs started with \`terminal_send run_in_background\`.

Returns a list of jobs with their ID, session, status, and start time.`,
      parameters: { type: "object", properties: {} },
      async execute(_args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolExecuteResult> {
        const ptyJobs = listTerminalBackgroundJobs();
        if (ptyJobs.length === 0) {
          return { title: "job_list", output: "No background jobs running.", isError: false };
        }
        const lines = ptyJobs.map(
          (p) =>
            `- ${p.id} [${p.status}] (terminal send, session: ${p.sessionId}, started: ${new Date(p.startedAt).toISOString()})`,
        );
        return { title: `Background Jobs (${ptyJobs.length})`, output: lines.join("\n"), isError: false };
      },
    },

    // job_output
    {
      id: "job_output",
      contract: { readOnly: true, accessScope: "session" },
      guidance:
        "Use job_output to read the output of a background job started with terminal_send run_in_background.",
      description: `Get the output (stdout/stderr) of a background terminal job by ID.

Use this to check on long-running background sends.`,
      parameters: {
        type: "object",
        properties: {
          jobId: { type: "string", description: "The job ID to check" },
        },
        required: ["jobId"],
      },
      async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolExecuteResult> {
        const jobId = args.jobId as string;

        /**
         * 非 `pty-job-` 前缀的 id 一律**如实**报"找不到"。
         *
         * 改前这里会去查 `JobManager`（那条路无产出者）⇒ 无论模型给什么 id 都是
         * `Job not found`，而模型是被 guidance 引导来的，于是只能反复换 id 重试。
         * 现在 id 空间里只有一种真实来源，报错也就是一句可信的事实。
         */
        const pty = isPtyJobId(jobId) ? getTerminalBackgroundJob(jobId) : undefined;
        if (!pty) {
          return {
            title: "job_output",
            output:
              `Job not found: ${jobId}. Background jobs are created by \`terminal_send\` with ` +
              `\`run_in_background: true\`; the id it returns starts with \`pty-job-\`.`,
            isError: true,
          };
        }
        const stdout = pty.stdout ? `stdout:\n${pty.stdout}` : "(no stdout)";
        const stderr = pty.stderr ? `stderr:\n${pty.stderr}` : "(no stderr)";
        const wait = pty.waitReason ? `\n[wait: ${pty.waitReason}]` : "";
        return {
          title: `Job ${jobId} [${pty.status}]`,
          output: `${stdout}\n\n${stderr}${wait}`, isError: false,
        };
      },
    },

    // job_kill
    {
      id: "job_kill",
      contract: { destructive: true, sideEffectScope: "session", accessScope: "session" },
      description: `Kill a running background terminal job by ID.

Sends SIGINT (Ctrl+C) to the terminal session that owns the job.`,
      parameters: {
        type: "object",
        properties: {
          jobId: { type: "string", description: "The job ID to kill" },
        },
        required: ["jobId"],
      },
      async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolExecuteResult> {
        const jobId = args.jobId as string;

        if (!isPtyJobId(jobId)) {
          return {
            title: "job_kill",
            output: `Job not found: ${jobId} (background job ids start with \`pty-job-\`).`,
            isError: true,
          };
        }

        /**
         * ★ 第 185 波（T3）：**三态**，不再把"本来就没在跑"报成"杀掉了"。
         *
         * 改前 `killBackgroundJob` 对**已结束**的 job 直接 `return true`，这里据此打 ✅ ——
         * 一次不存在的成功。模型会以为"命令被我停住了"，而它其实早就自己跑完了
         * （或者根本不是这个原因停的），后续判断全建立在假事实上。
         */
        const outcome = await killTerminalBackgroundJob(jobId);
        if (outcome === "killed") {
          return {
            title: "Job Killed",
            output: `✅ Job ${jobId} has been killed (SIGINT sent to terminal).`, isError: false,
          };
        }
        if (outcome === "already-finished") {
          const job = getTerminalBackgroundJob(jobId);
          return {
            title: "job_kill",
            output:
              `Job ${jobId} had already finished (status: ${job?.status ?? "unknown"}) — nothing was killed. ` +
              `Use job_output to read its output.`,
            isError: true,
          };
        }
        return { title: "job_kill", output: `❌ Job ${jobId} not found.`, isError: true };
      },
    },
  ];
}
