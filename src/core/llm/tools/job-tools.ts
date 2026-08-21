/**
 * P2-19/20: Job Tools — job_list / job_output / job_kill
 *
 * Wraps JobManager methods as LLM tools for background task management.
 * 对标 dsh 的 background job tools.
 */

import type { ToolDef, ToolContext, ToolExecuteResult } from "../tools";
import { getJobManager } from "./job-manager";

export function createJobTools(): ToolDef[] {
  return [
    // job_list
    {
      id: "job_list",
    guidance: "Use job_list to list all background jobs and their statuses.",
      description: `List all background jobs (bash commands running in the background).

Returns a list of jobs with their ID, command, status, and start time.`,
      parameters: { type: "object", properties: {} },
      async execute(_args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolExecuteResult> {
        const jobs = getJobManager().listJobs();
        if (jobs.length === 0) {
          return { title: "job_list", output: "No background jobs running." };
        }
        const lines = jobs.map(j =>
          `- ${j.id} [${j.status}] "${j.command}" (started: ${new Date(j.startedAt).toISOString()})`
        );
        return { title: `Background Jobs (${jobs.length})`, output: lines.join("\n") };
      },
    },

    // job_output
    {
      id: "job_output",
    guidance: "Use job_output to read the output of a background job started with bash run_in_background.",
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
        const output = getJobManager().getOutput(args.jobId as string);
        if (!output) {
          return { title: "job_output", output: `Job not found: ${args.jobId}` };
        }
        const stdout = output.stdout ? `stdout:\n${output.stdout}` : "(no stdout)";
        const stderr = output.stderr ? `stderr:\n${output.stderr}` : "(no stderr)";
        return {
          title: `Job ${args.jobId} [${output.status}]`,
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
        const killed = getJobManager().kill(args.jobId as string);
        if (killed) {
          return { title: "Job Killed", output: `✅ Job ${args.jobId} has been killed.` };
        }
        return { title: "job_kill", output: `❌ Job ${args.jobId} not found or not running.` };
      },
    },
  ];
}
