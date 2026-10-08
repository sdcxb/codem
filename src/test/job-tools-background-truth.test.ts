/**
 * ★ 第 185 波 T3 判据：后台任务工具**不许引导模型去用一条不存在的路**。
 *
 * ## 钉的是什么缺陷（`.preview-shot/_audit184-tools.md` 的 T3）
 *
 * `job_list` / `job_output` / `job_kill` 原来同时读两个来源，其中一个是**断线的死实现**：
 *
 * - `terminal_send run_in_background` 创建的 PTY 后台发送（`pty-job-`）—— **真的能用**；
 * - `bash run_in_background` 创建的普通后台命令（`JobManager`，`job-`）—— **全仓无调用方**：
 *   `JobManager.start()` 是唯一写 `this.jobs` 的地方，而 `getJobManager().start(` 零命中；
 *   `bash` 的 `parameters` 里也**没有** `background` 字段。
 *
 * 后果：`job_output` 永远 `Job not found`，而 guidance 明确让模型用它收 `bash run_in_background`
 * 的产出 ⇒ 模型反复换 id 重试、或断定"后台任务丢了"。另：`killBackgroundJob` 对**已结束**
 * 的 job 直接 `return true` ⇒ `job_kill` 报一次不存在的 ✅（假成功）。
 *
 * ## 本轮的选择：**如实下线**（理由写在 `job-tools.ts` 的文件头）
 *
 * 「接上」要成立，`job_kill` 必须真的能停下命令；而那条路走 `execute_command`（Rust 一次
 * IPC 跑完），Rust 侧只提供"超时杀进程树"、**没有按 id 杀**的入口 —— 把还在跑的进程标成
 * `killed` 正是同一份审计点名的假成功。在"不改 `src-tauri/`"的约束下只能下线。
 *
 * ## 判据
 *
 * | id | 钉什么 |
 * |---|---|
 * | `T3-A` | 模型面向的 guidance/description **不再提** `bash run_in_background`；`bash` 也没有 `background` 参数 |
 * | `T3-B` | `job_output("job-…")`（旧 guidance 承诺过的那种 id）如实报失败，并指出唯一真实来源 |
 * | `T3-C` | 真实 PTY 后台任务 ⇒ `job_output` **真的取到输出**（正向对照，证明这条工具没被一起废掉） |
 * | `T3-D` | `job_kill` 对**已结束**的 job 不许报 ✅（假成功），要如实说"它早就结束了" |
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

import { createJobTools } from "../core/llm/tools/job-tools";
import {
  createTerminalOpenTool,
  createTerminalSendTool,
  resetTerminalManagerForTest,
} from "../core/llm/tools/terminal-tools";
import { createDefaultToolRegistry } from "../core/llm/tools";
import type { ToolContext } from "../core/llm/tools";

function ctxFor(cwd: string): ToolContext {
  return {
    sessionId: "test-session",
    messageId: "test-msg",
    cwd,
    abort: new AbortController().signal,
    messages: [],
    metadata: () => {},
  };
}

const jobTool = (id: string) => createJobTools().find((t) => t.id === id)!;

beforeEach(() => {
  resetTerminalManagerForTest();
});

describe("第 185 波 T3：后台任务工具不许指向死实现", () => {
  it("T3-A: 模型面向的文案不再提 bash run_in_background，且 bash 没有 background 参数", () => {
    for (const tool of createJobTools()) {
      const text = `${tool.guidance ?? ""}\n${tool.description ?? ""}`;
      expect(text, `${tool.id} 的文案不许再引导模型用 bash run_in_background`).not.toMatch(
        /bash\s+run_in_background/i,
      );
    }
    // job_output 的文案必须点明唯一真实来源（否则模型无从知道该从哪拿 id）
    const outText = `${jobTool("job_output").guidance}\n${jobTool("job_output").description}`;
    expect(outText).toMatch(/terminal_send/);

    // bash 工具的参数表里没有 background —— "bash run_in_background 这个入口不存在"是事实
    const bash = createDefaultToolRegistry().get("bash")!;
    const props = (bash.parameters as { properties?: Record<string, unknown> }).properties ?? {};
    expect(Object.keys(props), "bash 不接受 background/run_in_background（原来也没有，所以不许在别处假装有）").not.toContain(
      "background",
    );
    expect(Object.keys(props)).not.toContain("run_in_background");
  });

  it("T3-B: job_output 对 job- 形式的 id 如实报失败（不再假装有 JobManager 那条路）", async () => {
    const out = await jobTool("job_output").execute({ jobId: "job-1700000000000-abc123" }, ctxFor("C:/ws"));
    expect(out.isError, "★ 取不到就是失败，不许报成功").toBe(true);
    expect(out.output).toContain("Job not found");
    expect(out.output, "要告诉模型 id 该从哪来").toMatch(/terminal_send/);
  });

  it("T3-C: 正向对照 —— 真实 PTY 后台任务的输出真的取得到", async () => {
    let ptyCb: ((e: any) => void) | null = null;
    const invoke = vi.fn(async (command: string) => {
      if (command === "spawn_pty") return "pty-t3-001";
      if (command === "write_pty") {
        if (ptyCb) ptyCb({ payload: { id: "pty-t3-001", data: "background output line\r\n" } });
        return null;
      }
      return null;
    });
    (window as any).__TAURI__ = {
      core: { invoke },
      event: {
        listen: vi.fn(async (event: string, cb: (e: any) => void) => {
          if (event === "pty-output") ptyCb = cb;
          return () => {};
        }),
      },
    };

    await createTerminalOpenTool().execute({ type: "shell", cwd: "C:/ws" }, ctxFor("C:/ws"));
    const sent = await createTerminalSendTool().execute(
      { sessionId: "pty-t3-001", text: "sleep 1", submit: true, run_in_background: true },
      ctxFor("C:/ws"),
    );
    const jobId = sent.metadata?.jobId as string;
    expect(jobId, "真实的后台任务 id 前缀是 pty-job-").toMatch(/^pty-job-/);

    // 等后台静默窗口收完输出
    await new Promise((r) => setTimeout(r, 700));
    const out = await jobTool("job_output").execute({ jobId }, ctxFor("C:/ws"));
    expect(out.isError).toBe(false);
    expect(out.output, "★ 这条工具必须真的能取到输出（否则就是「工具整体是死的」）").toContain(
      "background output line",
    );
  });

  it("T3-D: job_kill 对已结束的 job 不许报 ✅（假成功）", async () => {
    let ptyCb: ((e: any) => void) | null = null;
    const invoke = vi.fn(async (command: string) => {
      if (command === "spawn_pty") return "pty-t3-002";
      if (command === "write_pty") {
        if (ptyCb) ptyCb({ payload: { id: "pty-t3-002", data: "done\r\n" } });
        return null;
      }
      return null;
    });
    (window as any).__TAURI__ = {
      core: { invoke },
      event: {
        listen: vi.fn(async (event: string, cb: (e: any) => void) => {
          if (event === "pty-output") ptyCb = cb;
          return () => {};
        }),
      },
    };

    await createTerminalOpenTool().execute({ type: "shell", cwd: "C:/ws" }, ctxFor("C:/ws"));
    const sent = await createTerminalSendTool().execute(
      { sessionId: "pty-t3-002", text: "echo done", submit: true, run_in_background: true },
      ctxFor("C:/ws"),
    );
    const jobId = sent.metadata?.jobId as string;

    /** 等它自己跑完（静默窗口 400ms + 轮询）—— 此时 status 已不是 running。 */
    await new Promise((r) => setTimeout(r, 700));
    const before = await jobTool("job_output").execute({ jobId }, ctxFor("C:/ws"));
    expect(before.title, "夹具前提：这个 job 已经结束了").toMatch(/\[completed\]/);

    const killed = await jobTool("job_kill").execute({ jobId }, ctxFor("C:/ws"));
    expect(killed.isError, "★ 早就结束的任务不许回一次不存在的成功").toBe(true);
    expect(killed.output, "要如实说它已经结束了，而不是「已杀死」").toMatch(/already finished/i);
    expect(killed.output).not.toContain("✅");
  });
});
