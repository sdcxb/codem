/**
 * P2-19/20: Job Tools — job_list / job_output / job_kill
 *
 * Wraps JobManager methods as LLM tools for background task management.
 * 对标 dsh 的 background job tools.
 *
 * 支持两类后台任务：
 * - bash run_in_background 创建的普通后台命令（JobManager，id 前缀 job-）
 * - terminal_send run_in_background 创建的 PTY 后台发送（TerminalManager，id 前缀 pty-job-）
 */

import type { ToolDef, ToolContext, ToolExecuteResult } from "../tools";
import { getJobManager } from "./job-manager";
import { getTerminalBackgroundJob, listTerminalBackgroundJobs, killTerminalBackgroundJob } from "./terminal-tools";

function isPtyJobId(jobId: string): boolean {
  return jobId.startsWith("pty-job-");
}

export function createJobTools(): ToolDef[] {
  return [
    // job_list
    {
      id: "job_list",
      guidance: "Use job_list to list all background jobs and their statuses.",
      description: `List all background jobs (bash commands or terminal sends running in the background).

Returns a list of jobs with their ID, command, status, and start time.`,
      parameters: { type: "object", properties: {} },
      async execute(_args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolExecuteResult> {
        const jobs = getJobManager().listJobs();
        const ptyJobs = listTerminalBackgroundJobs();
        if (jobs.length === 0 && ptyJobs.length === 0) {
          return { title: "job_list", output: "No background jobs running." };
        }
        const lines = jobs.map(j =>
          `- ${j.id} [${j.status}] "${j.command}" (started: ${new Date(j.startedAt).toISOString()})`
        );
        for (const p of ptyJobs) {
          lines.push(`- ${p.id} [${p.status}] (terminal send, session: ${p.sessionId}, started: ${new Date(p.startedAt).toISOString()})`);
        }
        return { title: `Background Jobs (${jobs.length + ptyJobs.length})`, output: lines.join("\n") };
      },
    },

    // job_output
    {
      id: "job_output",
      guidance: "Use job_output to read the output of a background job started with bash run_in_background or terminal_send run_in_background.",
      description: `Get the output (stdout/stderr) of a background job by ID.

Use this to check on long-running background commands.`,
      parameters: {
        type: "object",
        properties: {
          jobId: { type: "string", description: "The job ID to check" },
        },
        required: ["jobId"],
      },
      async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolExecuteResult> {
        const jobId = args.jobId as string;

        if (isPtyJobId(jobId)) {
          const pty = getTerminalBackgroundJob(jobId);
          if (!pty) {
            return { title: "job_output", output: `Job not found: ${jobId}` };
          }
          const stdout = pty.stdout ? `stdout:\n${pty.stdout}` : "(no stdout)";
          const stderr = pty.stderr ? `stderr:\n${pty.stderr}` : "(no stderr)";
          const wait = pty.waitReason ? `\n[wait: ${pty.waitReason}]` : "";
          return {
            title: `Job ${jobId} [${pty.status}]`,
            output: `${stdout}\n\n${stderr}${wait}`,
          };
        }

        const output = getJobManager().getOutput(jobId);
        if (!output) {
          return { title: "job_output", output: `Job not found: ${jobId}` };
        }
        const stdout = output.stdout ? `stdout:\n${output.stdout}` : "(no stdout)";
        const stderr = output.stderr ? `stderr:\n${output.stderr}` : "(no stderr)";
        return {
          title: `Job ${jobId} [${output.status}]`,
          output: `${stdout}\n\n${stderr}`,
        };
      },
    },

    // job_kill
    {
      id: "job_kill",
      description: `Kill a running background job by ID.

Use this when a background command needs to be terminated.`,
      parameters: {
        type: "object",
        properties: {
          jobId: { type: "string", description: "The job ID to kill" },
        },
        required: ["jobId"],
      },
      async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolExecuteResult> {
        const jobId = args.jobId as string;

        if (isPtyJobId(jobId)) {
          const killed = await killTerminalBackgroundJob(jobId);
          if (killed) {
            return { title: "Job Killed", output: `✅ Job ${jobId} has been killed (SIGINT sent to terminal).` };
          }
          return { title: "job_kill", output: `❌ Job ${jobId} not found or not running.` };
        }

        const killed = getJobManager().kill(jobId);
        if (killed) {
          return { title: "Job Killed", output: `✅ Job ${jobId} has been killed.` };
        }
        return { title: "job_kill", output: `❌ Job ${jobId} not found or not running.` };
      },
    },
  ];
}
