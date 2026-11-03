/**
 * 敏感读取的**两阶段审批**（RPC 侧）与一次性授权（grant）。
 *
 * ## 为什么 RPC 不能用"阻塞式审批"（工具那套）
 *
 * 工具跑在某一轮的循环里，Host 可以发 `approval.requested` 事件、等客户端答复；
 * 但 `workspace.read` / `workspace.diff` 可能发生在**没有选中会话**的时候（文件浏览器），
 * 事件流是按 sessionId 订阅的 ⇒ 没有会话就没有卡片可投递。所以 RPC 走两阶段：
 *
 * 1. 第一次调用：Host 登记一个待答复审批，返回 `APPROVAL_REQUIRED` + `details`（不返回正文）；
 * 2. 用户在客户端点"批准" ⇒ `approval.respond`；
 * 3. 客户端带**同一个** `approvalId` 重试 ⇒ Host 消费一次性 grant，才真的读。
 *
 * ## grant 的语义（判据 SRPC-2/3/8）
 *
 * - **一次性**：消费即删。批准一次只覆盖这一次读取，不产生"以后都能读"的记忆；
 * - **精确**：grant 绑定工具 + 路径（read）或 路径+基线（diff），换路径/换基线一律重新审批；
 * - **有 TTL**：5 分钟未用即失效（审批卡挂了很久之后点"批准"不该还能读）；
 * - **拒绝不发 grant**：`approval.respond` 只在 allow 时登记 grant。
 *
 * ## 为什么把判定/grant 放在纯模块里
 *
 * `HostRuntime` 需要数据库与子进程才能构造；把"要不要审批、grant 怎么用"抽出来，
 * 判据就能对着临时目录直接验证（而不是靠静态断言 runtime.ts 里有某行代码）。
 */
import { realpath } from "node:fs/promises";
import { relative, resolve } from "node:path";

import type {
  ApprovalRequestView,
  SensitiveApprovalRequiredDetails,
  WorkspaceDiffResult,
} from "../../protocol/src/index";
import { HostError } from "./errors";
import {
  buildSensitiveReadDetails,
  buildSensitiveReadSummary,
  classifySensitivePath,
  normalizeWorkspacePath,
  type SensitivePathVerdict,
  type SensitiveRuleId,
} from "./sensitive-paths";
import {
  ApprovalGrantStore,
  SENSITIVE_APPROVAL_TTL_MS,
  type SensitiveApprovalGrant,
  type SensitiveApprovalRegistrar,
  type SensitiveApprovalRegistration,
  type SensitiveApprovalTool,
} from "./sensitive-approvals";
import { resolveInsideRoot } from "./tools";
import { readWorkspaceFile, type WorkspaceFileText } from "./workspace";

export {
  ApprovalGrantStore,
  SENSITIVE_APPROVAL_MAX_PENDING,
  SENSITIVE_APPROVAL_TTL_MS,
  type SensitiveApprovalGrant,
  type SensitiveApprovalRegistrar,
  type SensitiveApprovalRegistration,
  type SensitiveApprovalTool,
} from "./sensitive-approvals";

function newApprovalId(): string {
  return `appr-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 工作区相对路径（realpath 之后计算：符号链接指到哪就按哪判） */
export async function workspaceRelativePath(root: string, abs: string): Promise<string> {
  const rootReal = await realpath(root).catch(() => resolve(root));
  const absReal = await realpath(abs).catch(() => abs);
  return normalizeWorkspacePath(relative(rootReal, absReal).split("\\").join("/"));
}

function approvalRequired(
  tool: SensitiveApprovalTool,
  summary: string,
  details: Record<string, unknown>,
  grant: SensitiveApprovalGrant,
  register: SensitiveApprovalRegistrar,
): HostError {
  const approvalId = newApprovalId();
  const expiresAt = Date.now() + SENSITIVE_APPROVAL_TTL_MS;
  const view: ApprovalRequestView = {
    approvalId,
    /*
     * RPC 读取可能没有选中会话（文件浏览器）。空串是一份**明确的**"属于工作区、不属于任何会话"，
     * 不是占位符：`approval.list(sessionId)` 按会话过滤时不会把它算进任何会话。
     */
    sessionId: "",
    tool,
    summary,
    details,
    createdAt: Date.now(),
    expiresAt,
  };
  register({ view, grant: { ...grant, files: [...grant.files] } });
  const data: SensitiveApprovalRequiredDetails = {
    approvalRequired: true,
    approvalId,
    tool,
    summary,
    details: details as SensitiveApprovalRequiredDetails["details"],
    expiresAt,
  };
  return new HostError("APPROVAL_REQUIRED", summary, {
    hint: "请用户在客户端确认；批准后带同一个 approvalId 重试（一次性）",
    details: data,
  });
}

export interface GuardedReadOptions {
  root: string;
  path: string;
  offset?: number;
  limit?: number;
  /** 上一次 `APPROVAL_REQUIRED` 返回的审批 ID */
  approvalId?: string;
  /** 只有共享桌面工作区才启用（Android 本机 / 开发机手跑为 false） */
  shared: boolean;
  grants: ApprovalGrantStore;
  register: SensitiveApprovalRegistrar;
}

/**
 * `workspace.read` 的受控实现。
 *
 * 顺序**不能反**：先 `resolveInsideRoot`（路径逃逸在这里就被拒，审批不能用来探测路径存在性），
 * 再判敏感、再查 grant，最后才真正读文件。
 */
export async function readWorkspaceFileGuarded(opts: GuardedReadOptions): Promise<WorkspaceFileText> {
  if (!opts.shared) {
    return readWorkspaceFile(opts.root, opts.path, opts.offset, opts.limit);
  }
  const abs = await resolveInsideRoot(opts.root, opts.path);
  const rel = await workspaceRelativePath(opts.root, abs);
  const verdict = classifySensitivePath(rel);
  if (verdict) {
    if (verdict.action === "deny") {
      throw new HostError("INVALID_PARAMS", `不允许读取应用内部产物：${rel}`, {
        hint: "该目录由 Codem 自动生成，不是项目内容；请从项目文件里取值",
      });
    }
    if (verdict.action === "ask") {
      const grant = opts.approvalId
        ? opts.grants.consume(opts.approvalId, "workspace.read", rel)
        : null;
      if (!grant || !grant.files.includes(rel)) {
        throw approvalRequired(
          "workspace.read",
          buildSensitiveReadSummary(rel, verdict),
          buildSensitiveReadDetails(rel, verdict),
          { tool: "workspace.read", key: rel, files: [rel] },
          opts.register,
        );
      }
    }
  }
  return readWorkspaceFile(opts.root, opts.path, opts.offset, opts.limit);
}

/** 跑一条 git 命令（由 runtime 注入：Host 已在 `git-exec.ts` 收口了环境/超时/输出上限） */
export type GitDiffRunner = (args: string[]) => Promise<{
  code: number | null;
  out: string;
  err: string;
}>;

export interface GuardedDiffOptions {
  root: string;
  path: string;
  base?: string;
  approvalId?: string;
  shared: boolean;
  grants: ApprovalGrantStore;
  register: SensitiveApprovalRegistrar;
  run: GitDiffRunner;
}

function describeSensitiveFiles(files: string[]): { labelText: string; rules: SensitiveRuleId[] } {
  const labels = new Set<string>();
  const rules = new Set<SensitiveRuleId>();
  for (const f of files) {
    const v: SensitivePathVerdict | null = classifySensitivePath(f);
    if (!v) continue;
    labels.add(v.label);
    rules.add(v.rule);
  }
  return {
    labelText: [...labels].join("、"),
    rules: [...rules],
  };
}

/**
 * `workspace.diff` 的受控实现。
 *
 * 敏感文件清单来自**只读预检**（`git diff --name-only`）：先知道"这次 diff 里有没有 `.env`"，
 * 再决定要不要审批。批准后重试时再算一次清单 —— 若期间又出现了未覆盖的敏感文件，
 * 会**再要一次审批**（fail-closed，不拿旧批准放行新文件）。
 */
export async function diffWorkspaceFileGuarded(opts: GuardedDiffOptions): Promise<WorkspaceDiffResult> {
  const abs = await resolveInsideRoot(opts.root, opts.path || ".");
  const rel = await workspaceRelativePath(opts.root, abs);
  const check = await opts.run(["rev-parse", "--is-inside-work-tree"]);
  if (check.code !== 0 || check.out.trim() !== "true") {
    return { path: opts.path, diff: "", supported: false };
  }
  const safeBase = /^[A-Za-z0-9._~^/-]+$/.test(opts.base ?? "") ? String(opts.base) : "HEAD";
  const gitPathArgs = rel ? ["--", rel] : [];

  if (opts.shared) {
    const names = await opts.run(["--no-pager", "diff", "--name-only", safeBase, ...gitPathArgs]);
    const changed = names.code === 0
      ? names.out
          .split(/\r?\n/)
          .map((line) => normalizeWorkspacePath(line))
          .filter(Boolean)
      : [];
    const denied: string[] = [];
    const sensitive: string[] = [];
    for (const changedPath of changed) {
      const v = classifySensitivePath(changedPath);
      if (!v || v.action === "allow") continue;
      if (v.action === "deny") denied.push(changedPath);
      else sensitive.push(changedPath);
    }
    if (denied.length > 0) {
      throw new HostError("INVALID_PARAMS", `不允许查看应用内部产物的差异：${denied.join(", ")}`, {
        hint: "该目录由 Codem 自动生成，不是项目内容",
      });
    }
    if (sensitive.length > 0) {
      const key = `${rel || "."}|${safeBase}`;
      const grant = opts.approvalId
        ? opts.grants.consume(opts.approvalId, "workspace.diff", key)
        : null;
      const covered = Boolean(grant && sensitive.every((file) => grant.files.includes(file)));
      if (!covered) {
        const { labelText, rules } = describeSensitiveFiles(sensitive);
        const summary =
          `查看差异时将读取 ${sensitive.length} 个敏感文件` +
          (labelText ? `（${labelText}）` : "") +
          " —— 批准后内容将发送给模型";
        const details = {
          path: rel || ".",
          base: safeBase,
          files: sensitive.slice(0, 10),
          fileCount: sensitive.length,
          truncated: sensitive.length > 10,
          rules,
          scope: "shared-desktop-workspace",
          notice:
            "批准后这些文件的差异内容会发送给模型（及模型服务商）；拒绝则不会返回任何 patch。",
        };
        throw approvalRequired("workspace.diff", summary, details, {
          tool: "workspace.diff",
          key,
          files: sensitive,
        }, opts.register);
      }
    }
  }

  const diff = await opts.run(["--no-pager", "diff", "--no-color", safeBase, ...gitPathArgs]);
  return {
    path: opts.path,
    diff: diff.code === 0 ? diff.out : `git diff 失败：${diff.err.trim()}`,
    supported: true,
  };
}
