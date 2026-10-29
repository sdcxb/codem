/**
 * project_report —— 让 thread 用**契约 JSON** 向项目协调者汇报。
 *
 * 为什么不是让模型“在聊天里说做完了”：协调者不读 thread 聊天记录；
 * 只有 `.codem/project/reports/*.json` 是它的事实来源。这个工具是 thread 唯一
 * 被支持的写法，校验失败会当场返回错误（而不是写一份坏报告让协调者猜）。
 */

import type { ToolDef, ToolContext, ToolExecuteResult } from "../tools";
import { writeThreadReport } from "../../project/coordinator/storage";
import { exists, readFile, writeFile } from "../../file-api";
import { getSession } from "../../storage/session";
import { resolveMainProjectRoot } from "../../project/coordinator/project-root";

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function createProjectReportTool(): ToolDef {
  return {
    id: "project_report",
    contract: { sideEffectScope: "workspace", accessScope: "workspace" },
    guidance:
      "Use project_report when you are a thread in a coordinated project: it writes the v3.1 report the coordinator reads. " +
      "status=done requires evidence kind=log; passed gates require verified_by=command plus evidence_ref; blocked requires options (>=2) and default.",
    /** 延迟加载后，模型只能先看到这一行提示；把"什么时候用/什么时候别用"写在这里 */
    searchHint:
      "项目工作台：作为 coordinated project 的 thread，向协调者交 v3.1 契约报告（project_report）。" +
      "只在项目 thread 里用；普通会话不需要（协调者不读聊天记录，报告才是事实来源）。",
    description: `Write a v3.1 thread report into the project's .codem/project/reports/ directory.

The coordinator does NOT read your chat transcript. This report is your only supported way to tell it:
- what you changed (changes)
- what evidence exists (evidence; status=done requires kind=log)
- which gates passed (gates; passed=true requires verified_by=command + evidence_ref)
- what blocks you (blocking; question + >=2 options + default)

Report fields:
- report_id (optional; generated if omitted)
- status: in_progress | done | blocked | failed
- summary: <=300 chars
- changes: [{ path, kind? }]
- evidence: [{ kind: log|command|file, ref, note? }]
- gates: [{ id, passed, verified_by: command|manual|none, evidence_ref?, command? }]
- blocking: { question, options: string[], default }
- supersedes / conflict / resolution (optional)`,
    parameters: {
      type: "object",
      properties: {
        report_id: { type: "string", description: "Stable report id; generated when omitted" },
        status: { type: "string", enum: ["in_progress", "done", "blocked", "failed"] },
        summary: { type: "string", description: "One-line outcome, max 300 chars" },
        changes: {
          type: "array",
          items: {
            type: "object",
            properties: { path: { type: "string" }, kind: { type: "string" } },
            required: ["path"],
          },
        },
        evidence: {
          type: "array",
          items: {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["log", "command", "file"] },
              ref: { type: "string" },
              note: { type: "string" },
            },
            required: ["kind", "ref"],
          },
        },
        gates: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              passed: { type: "boolean" },
              verified_by: { type: "string", enum: ["command", "manual", "none"] },
              evidence_ref: { type: "string" },
              command: { type: "string", description: "Re-runnable command for this gate (required for done across restarts)" },
            },
            required: ["id", "passed", "verified_by"],
          },
        },
        blocking: {
          type: "object",
          properties: {
            question: { type: "string" },
            options: { type: "array", items: { type: "string" } },
            default: { type: "string" },
          },
          required: ["question", "options", "default"],
        },
        supersedes: { type: "string" },
        conflict: { type: "string" },
        resolution: { type: "string" },
        pull_request: {
          type: "object",
          properties: {
            url: { type: "string" },
            number: { type: "number" },
            title: { type: "string" },
            state: { type: "string", enum: ["draft", "open", "merged", "closed"] },
            checks: { type: "string", enum: ["pending", "passing", "failing", "none"] },
          },
          required: ["state"],
        },
      },
      required: ["status", "summary"],
    },
    async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolExecuteResult> {
      const projectPath = await resolveMainProjectRoot(ctx.cwd || ctx.workspace || "");
      if (!projectPath) {
        return { title: "project_report", output: "没有可用工作区，无法写项目报告", isError: true };
      }
      const reportId = str(args.report_id) || `${ctx.sessionId}-${Date.now()}`;
      try {
        /*
         * 证据必须跟着报告进主工作区：thread 在 worktree 里跑，`.codem/evidence/...`
         * 默认只在 worktree；协调者读主工作区会看不到。这里把相对路径的 log/file
         * 复制到 `.codem/evidence/<threadId>/`，并改写 ref 后再生效。
         */
        const rawEvidence = Array.isArray(args.evidence) ? args.evidence : [];
        const evidence = await Promise.all(rawEvidence.map(async (ev) => {
          if (!ev || typeof ev !== "object") return ev;
          const e = ev as Record<string, unknown>;
          const kind = str(e.kind);
          const ref = str(e.ref);
          if (kind !== "log" && kind !== "file") return ev;
          if (!ref || ref.startsWith("/") || /^[A-Za-z]:/.test(ref)) return ev;
          const trimSlash = (p: string) => p.replace(/\/+$/, "");
          const local = `${trimSlash(ctx.cwd)}/${ref}`;
          const main = `${trimSlash(projectPath)}/${ref}`;
          if (!(await exists(local)) || (await exists(main))) return ev;
          const name = ref.split("/").pop() || "evidence.log";
          const target = `.codem/evidence/${ctx.sessionId}/${name}`;
          const content = await readFile(local, { workspace: ctx.cwd });
          await writeFile(`${trimSlash(projectPath)}/${target}`, content, { workspace: projectPath });
          return { ...e, ref: target };
        }));
        const sessionTitle = getSession(ctx.sessionId)?.title;
        const report = await writeThreadReport(projectPath, {
          ...args,
          evidence,
          report_id: reportId,
          thread_id: ctx.sessionId,
        }, { title: sessionTitle });
        return {
          title: "Project report written",
          output: `✅ 报告已写入 .codem/project/reports/${report.report_id}.json\nstatus=${report.status}\nsummary=${report.summary}`,
          isError: false,
          metadata: { reportId: report.report_id, status: report.status },
        };
      } catch (e: any) {
        return {
          title: "Project report rejected",
          output: `❌ 报告未写入：${e?.message || e}`,
          isError: true,
        };
      }
    },
  };
}

