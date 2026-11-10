/**
 * 任务切片（C10：Agent 只拿任务相关切片，**不拿父会话全文**）。
 *
 * ## 为什么要有"切片"而不是把父会话塞给成员
 *
 * 团队成员是独立子会话；把父会话整段聊天复制过去有两个问题：
 * ① token 成本与任务无关（越长越贵）；② 会把"别人的推理/试错/未证实结论"带进
 * 新成员的上下文，诱发基于错误前提的实现。所以成员启动/被派活时只拿：
 * - 任务节点（subject / description / acceptance / 依赖）；
 * - 共享工件引用（文件/文档/测试结果/引用 + 版本）；
 * - 四类证据的缺口与文档同步状态；
 * - 执行纪律（不要凭空声称完成、不要伪造状态）。
 *
 * `parentMessages` 参数**只用于计数与审计**，其 `content` 永远不会进入 prompt；
 * `TaskContextSlice.includesParentConversation` 恒为 `false`（类型上是字面量 `false`）。
 *
 * 这是纯函数：不读存储、不调 LLM、不依赖 subagent runtime；服务层把返回的 prompt
 * 交给 `SubagentRuntime.followup` → `LLMEngine.processSubagent`（复用同一条子智能体
 * 系统提示词组装路径）。
 */

import { completionSpecOf, evidenceOfKind, resolveDocSync } from "./completion";
import {
  TASK_EVIDENCE_KINDS,
  type AgentTeam,
  type DocSyncCheck,
  type TaskEvidenceKind,
  type TeamMember,
  type TeamTask,
} from "./types";

/** 父会话消息只保留这三个字段用于计数；`content` 不参与任何拼接。 */
interface ParentMessageLike {
  id?: string;
  role?: string;
  content?: unknown;
}

export interface TaskSliceInput {
  team: AgentTeam;
  task: TeamTask;
  memberName: string;
  role?: string;
  /** 父会话消息（**只计数**；内容不进入切片） */
  parentMessages?: ReadonlyArray<ParentMessageLike>;
  /** 可注入的文档同步谓词（用于在切片里显示当前同步状态） */
  docSyncCheck?: DocSyncCheck;
  /** Conductor 给该成员的额外任务相关说明（不是父会话聊天） */
  notes?: string;
}

export interface TaskContextSlice {
  taskId: string;
  memberName: string;
  /** 直接作为 subagent user message 的正文 */
  prompt: string;
  /** 结构性保证：这个切片不含父会话全文 */
  includesParentConversation: false;
  /** 父会话消息条数（只用于报告"排除了多少"） */
  parentMessageCount: number;
  /** 实际注入的父会话消息条数（恒为 0） */
  includedParentMessages: 0;
  /** 共享工件坐标（与 prompt 里列出的同一份） */
  artifactRefs: string[];
}

const KIND_LABEL: Record<TaskEvidenceKind, string> = {
  code: "代码",
  doc: "文档",
  test: "测试",
  reference: "引用",
};

function oneLine(value: unknown, max = 200): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function dependencyLines(team: AgentTeam, task: TeamTask): string[] {
  const deps = Array.isArray(task.dependencies) ? task.dependencies : [];
  if (deps.length === 0) return ["- （无前置任务）"];
  return deps.map((id) => {
    const dep = team.tasks.find((candidate) => candidate.id === id);
    return dep
      ? `- ${dep.id} [${dep.status}] ${oneLine(dep.subject, 80)}`
      : `- ${id} [missing]（依赖任务不存在）`;
  });
}

function artifactLines(task: TeamTask): string[] {
  const artifacts = Array.isArray(task.artifacts) ? task.artifacts : [];
  if (artifacts.length === 0) return ["- （还没有登记共享工件）"];
  return artifacts.map((artifact) => `- [${artifact.kind}] ${artifact.ref} @r${artifact.revision}`);
}

function evidenceLines(task: TeamTask): string[] {
  const lines: string[] = [];
  for (const kind of TASK_EVIDENCE_KINDS) {
    const items = evidenceOfKind(task, kind);
    if (items.length === 0) {
      lines.push(`- ${KIND_LABEL[kind]}（${kind}）：缺失`);
      continue;
    }
    const refs = items.map((item) => `${item.ref}${item.status ? ` (${item.status})` : ""}`).join("；");
    lines.push(`- ${KIND_LABEL[kind]}（${kind}）：${refs}`);
  }
  return lines;
}

/**
 * 构造任务相关切片。
 *
 * 注意：函数体里**没有**任何 `parentMessages[...].content` 的读取 —— 这是
 * "不含父会话全文"的结构性实现，而不是一句提示词。
 */
export function buildTaskSlice(input: TaskSliceInput): TaskContextSlice {
  const { team, task, memberName } = input;
  const role = input.role?.trim();
  const parentMessages = Array.isArray(input.parentMessages) ? input.parentMessages : [];
  const spec = completionSpecOf(task);
  const docSync = resolveDocSync(task, input.docSyncCheck);
  const artifacts = Array.isArray(task.artifacts) ? task.artifacts : [];
  const claim = task.claim;

  const lines: string[] = [
    "# 任务切片（仅任务相关上下文）",
    "",
    `你是团队「${team.name}」的成员 ${memberName}${role ? `（角色：${role}）` : ""}。`,
    `本切片只包含任务 ${task.id} 的上下文，**不包含父会话整段聊天**（父会话 ${parentMessages.length} 条消息已排除，注入 0 条）。`,
    "不要假设自己看过父会话；缺少的事实请用工具读取或向队长询问。",
    "",
    `## 任务 ${task.id}：${task.subject}`,
  ];
  if (task.description) lines.push("", "说明：", task.description);
  if (task.acceptance) lines.push("", "验收口径：", task.acceptance);
  if (input.notes) lines.push("", "队长补充（任务相关）：", input.notes);

  lines.push("", "## 前置依赖", ...dependencyLines(team, task));
  lines.push("", "## 共享工件（只共享引用与版本，不共享聊天）", ...artifactLines(task));
  lines.push("", "## 当前证据（完成条件：代码 + 文档 + 测试 + 引用）", ...evidenceLines(task));
  lines.push(
    "",
    "## 完成条件",
    `- 必须登记证据：${spec.requiredEvidence.map((kind) => `${KIND_LABEL[kind]}（${kind}）`).join("、")}；测试证据必须是 pass。`,
    `- Verifier 独立检查：${spec.requireVerification ? "需要（Verifier 不能是实现者）" : "本任务不要求"}。`,
    `- 文档同步：${docSync.synced ? (docSync.checked === false ? "本次派活时未做版本比对（完成门禁会用 C06 账本核对）" : "已同步") : `未同步（${docSync.reason ?? "原因未知"}）`}；文档未同步 ⇒ 任务不得完成。`,
    "- 代码 + 文档 + 测试 + 引用缺任一 ⇒ 明确 blocked，不要声称完成。",
    "",
    "## 执行纪律",
    `- 领取任务用 agent_teams_claim_task（返回 attempt_id）；更新必须携带同一 attempt_id。`,
    "- 只更新自己真正领取并做过的任务；不要伪造状态或证据。",
    "- 需要回退时用 agent_teams_rollback_task：工件会恢复到领取时的上一版，任务回到共享池。",
    "- 完成后用 agent_teams_update_task 提交证据；Verifier 通过前不会进入 completed。",
  );
  if (claim) {
    lines.push("", `## 当前领取`, `- ${claim.by} · attempt #${claim.attempt} · ${new Date(claim.claimedAt).toISOString()}`);
  }

  return {
    taskId: task.id,
    memberName,
    prompt: lines.join("\n"),
    includesParentConversation: false,
    parentMessageCount: parentMessages.length,
    includedParentMessages: 0,
    artifactRefs: artifacts.map((artifact) => `${artifact.kind}:${artifact.ref}@r${artifact.revision}`),
  };
}

export interface MemberBriefInput {
  team: AgentTeam;
  member: Pick<TeamMember, "name" | "role">;
  parentMessages?: ReadonlyArray<ParentMessageLike>;
}

/**
 * 成员启动时的团队切片（还没有具体任务可派）。
 *
 * 只给：团队名/自己的角色/任务看板（任务图）——仍然**不含父会话聊天**。
 * 具体任务到手后由 `buildTaskSlice` 生成任务级切片。
 */
export function buildMemberBrief(input: MemberBriefInput): TaskContextSlice {
  const { team, member } = input;
  const parentMessages = Array.isArray(input.parentMessages) ? input.parentMessages : [];
  const lines: string[] = [
    "# 团队切片（仅任务图，不含父会话聊天）",
    "",
    `你是团队「${team.name}」的成员 ${member.name}${member.role ? `（角色：${member.role}）` : ""}。`,
    `本切片不包含父会话整段聊天（父会话 ${parentMessages.length} 条消息已排除，注入 0 条）。`,
    "",
    "## 任务看板",
  ];
  const tasks = Array.isArray(team.tasks) ? team.tasks : [];
  if (tasks.length === 0) lines.push("- （暂无任务）");
  for (const task of tasks) {
    lines.push(`- ${task.id} [${task.status}] ${oneLine(task.subject, 80)}${task.assignee ? ` @${task.assignee}` : ""}`);
  }
  lines.push(
    "",
    "## 协作方式",
    "- 用 agent_teams_claim_task 领取就绪任务（返回 attempt_id），用 agent_teams_update_task 汇报。",
    "- 共享的是任务图与工件引用，不是聊天记录；不要假设自己看过队长的会话。",
    "- 完成需要代码/文档/测试/引用四类证据 + Verifier 独立检查；文档未同步不算完成。",
  );
  return {
    taskId: "team",
    memberName: member.name,
    prompt: lines.join("\n"),
    includesParentConversation: false,
    parentMessageCount: parentMessages.length,
    includedParentMessages: 0,
    artifactRefs: [],
  };
}
