/**
 * 深规划器：**一次只读分析 → 一份覆盖整个目标的里程碑计划**。
 *
 * 设计依据 `GOAL-MODE-PLAN.md` §5。要点：
 *
 * 1. **只读**：规划器能做的只有「读工作区文件 / 拿一份程序生成的侦察摘要 / 调模型」——
 *    依赖面里**没有**任何写文件 / 跑命令的能力（结构上做不到，不是靠提示词约束）；
 * 2. **一次深规划**：模型直接给出**整体里程碑**，不允许「先做第一步再看」；
 * 3. **校验不过就重写**：`validatePlanDraft` 的错误清单会原样喂回去（最多 3 次）——
 *    绝不允许把动作型 phase 硬塞进计划；
 * 4. **分类与规划合并成一次调用**：`multi-phase` 才建目标；`single-phase` / `question`
 *    直接回落现有 run 自主（少一次模型往返）。
 *
 * 模型可以**请求读**具体文件（`{"classification":"need-reads","reads":[...]}`）：
 * 程序按白名单读（工作区内、≤12 个/轮、≤60KB/个、最多 3 轮）再把内容追加进下一次请求。
 * 这**不是**第二个 agent 循环：没有工具调用协议、没有写能力、轮数固定且有界。
 */

import { readFile, isPathWithinWorkspace, listDirectory } from "../file-api";
import { getLang } from "../i18n/lang";
import { extractJSON } from "../llm/output-parser";
import type { PlanDraft, PlanViolation } from "./plan-validate";
import { formatViolations, validatePlanDraft } from "./plan-validate";
import type {
  Acceptance,
  GoalBudget,
  GoalEvidence,
  GoalPlan,
  PlanPhase,
} from "./types";
import { DEFAULT_GOAL_BUDGET } from "./types";

// ========== 依赖（生产由 App 注入模型调用；判据注入假实现） ==========

interface PlannerCompleteRequest {
  system: string;
  user: string;
}

export type PlannerComplete = PlannerDeps["complete"];

interface PlannerDeps {
  /** 一次非流式模型调用（不允许工具） */
  complete: (req: PlannerCompleteRequest) => Promise<string>;
  /** 读一个工作区内的文本文件（默认走 file-api 的只读接口） */
  readTextFile?: (absPath: string, maxBytes: number) => Promise<string>;
  /** 程序生成的工作区侦察摘要（默认：目录树 + package.json 脚本 + 文档清单） */
  briefing?: (cwd: string) => Promise<string>;
  now?: () => number;
}

export interface PlanGoalArgs {
  sessionId: string;
  userMessage: string;
  cwd: string;
  deps: PlannerDeps;
  budget?: GoalBudget;
  signal?: AbortSignal;
  /** 计划重写上限（默认 3） */
  maxPlanAttempts?: number;
}

export type PlanGoalResult =
  | {
      kind: "multi-phase";
      statement: string;
      principles: string[];
      nonGoals: string[];
      constraints: string[];
      acceptance: Acceptance[];
      plan: GoalPlan;
    }
  | { kind: "single-phase"; reason: string }
  | { kind: "question"; reason: string }
  | { kind: "failed"; reason: string; violations: PlanViolation[] };

/** 每轮最多读几个文件 / 每文件最多读多少字节 / 最多几轮补读 */
const MAX_READS_PER_ROUND = 12;
const MAX_FILE_BYTES = 60_000;
const MAX_READ_ROUNDS = 3;
const MAX_BRIEFING_CHARS = 12_000;
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "target",
  "dist",
  "build",
  ".preview-shot",
  ".codem",
  "art",
  "prototype",
  ".dsh-desktop-ref",
]);

// ========== 默认只读实现 ==========

/** 拼接工作区内的路径（Windows / POSIX 都要对；工作区路径决定分隔符） */
function joinWorkspacePath(base: string, rel: string): string {
  const sep = base.includes("\\") ? "\\" : "/";
  return `${base.replace(/[\\/]+$/, "")}${sep}${rel.replace(/^[\\/]+/, "")}`;
}

async function defaultReadTextFile(absPath: string, maxBytes: number): Promise<string> {
  const text = await readFile(absPath);
  return text.length > maxBytes ? text.slice(0, maxBytes) : text;
}

/**
 * 工作区侦察摘要（**只读**）。
 *
 * 为什么需要它：深规划如果对仓库一无所知，产出的计划必然空泛；但规划阶段又不该有
 * 工具循环。折中：程序按固定规则采一次「目录树 + 关键文件线索」，随请求一起给模型，
 * 模型要细节时再按 `reads` 请求具体文件（仍然只读、有界）。
 */
async function defaultBriefing(cwd: string): Promise<string> {
  const lines: string[] = [];
  let budget = 160;
  const walk = async (dir: string, depth: number, prefix: string): Promise<void> => {
    if (budget <= 0 || depth > 2) return;
    let entries: Array<{ name: string; path: string; isDirectory: boolean; size?: number }>;
    try {
      entries = await listDirectory(dir);
    } catch {
      return;
    }
    entries.sort((a, b) => (a.isDirectory === b.isDirectory ? a.name.localeCompare(b.name) : a.isDirectory ? -1 : 1));
    for (const entry of entries) {
      if (budget <= 0) return;
      if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
      if (entry.isDirectory) {
        lines.push(`${prefix}${entry.name}/`);
        budget--;
        await walk(entry.path, depth + 1, `${prefix}${entry.name}/`);
      } else {
        lines.push(`${prefix}${entry.name}`);
        budget--;
      }
    }
  };
  await walk(cwd, 0, "");

  const manifestLines: string[] = [];
  for (const name of ["package.json", "tsconfig.json"]) {
    try {
      const raw = await readFile(joinWorkspacePath(cwd, name));
      if (name === "package.json") {
        const parsed = JSON.parse(raw) as { name?: string; version?: string; scripts?: Record<string, string> };
        manifestLines.push(`package.json: ${parsed.name ?? "?"}@${parsed.version ?? "?"}`);
        const scripts = Object.keys(parsed.scripts ?? {});
        if (scripts.length > 0) manifestLines.push(`scripts: ${scripts.join(", ")}`);
      } else {
        manifestLines.push(`${name}: 存在（${raw.length} 字节）`);
      }
    } catch {
      // 文件不存在不是错误：侦察摘要只陈述存在的东西
    }
  }

  const body = lines.join("\n").slice(0, MAX_BRIEFING_CHARS);
  return [
    `工作区：${cwd}`,
    manifestLines.length > 0 ? `清单：\n${manifestLines.join("\n")}` : "",
    `文件树（最多 2 层，已省略 node_modules/.git/target 等）：\n${body || "(空)"}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

// ========== 提示词 ==========

function planSystemPrompt(zh: boolean): string {
  const schema = `{
  "classification": "multi-phase",
  "statement": "一句话重述用户真正要的结果（不是复述原话）",
  "principles": ["用户给的原则/偏好"],
  "nonGoals": ["明确不做的事"],
  "constraints": ["技术/兼容/安全/时间约束"],
  "goalAcceptance": [
    {"kind": "command|test|artifact", "description": "可检查的整体完成标准", "command": "…", "path": "…", "contains": "…"}
  ],
  "strategy": "总体策略：为什么选这条路径（一段话）",
  "invariants": ["执行期间必须始终成立的事（至少含用户原则/安全边界）"],
  "phases": [
    {
      "key": "p1",
      "title": "阶段标题",
      "outcome": "做完之后什么变了/什么可用了/什么决定了（可验收的结果）",
      "covers": ["A1"],
      "acceptance": [
        {"kind": "command|test|artifact", "description": "本阶段客观检查", "command": "…", "path": "…", "contains": "…"}
      ],
      "dependsOn": [],
      "risks": ["主要风险"]
    }
  ]
}`;
  if (zh) {
    return `你是「长程目标模式」的深规划器。你的任务：先判断这个请求属于哪一类，再（只有多阶段时）产出一份覆盖**整个目标**的里程碑计划。

## 分类
- "question"：纯问答/解释/咨询，不需要改工作区 → 只回 {"classification":"question","reason":"…"}
- "single-phase"：一个可验收交付（一次修改、一个 bug、一个文件/一个模块）→ 只回 {"classification":"single-phase","reason":"…"}
- "multi-phase"：确实需要 ≥3 个**可独立验收的交付物**（跨模块、迁移、多个交付物、需要分阶段验证）→ 输出完整计划 JSON

分类纪律（重要）：
- 宁可判 "single-phase" 走单轮自主，也不要把一件事拆成无意义微步；
- 只有「每个阶段都能独立验收、且删掉任一阶段目标就不完整」时才判 multi-phase。

## 计划纪律
- 阶段数 3–12，**按结果拆，不按动作拆**；
- 严禁把「读文件 / 跑一次测试 / 查看日志 / 列目录 / 搜索代码」当成一个阶段；
- 每个阶段 outcome 必须回答「做完之后什么变了 / 什么可用了 / 什么决定了」；
- 每个阶段至少一条**确定性**验收（command/test/artifact）—— 验收必须能被程序执行，
  「人工确认/看起来对」不算验收；
- 目标级验收（goalAcceptance）每一条都必须被某个阶段的 covers 覆盖（用 "A1"… 引用）；
- invariants 非空，至少包含用户原则与安全边界；
- 计划必须覆盖整个目标 —— 不允许「先做第一步再看」。

## 输出
只输出 JSON（不要 markdown 包裹、不要解释）。多阶段时结构：
${schema}

## 需要更多信息时
如果你必须先读具体文件才能给出可靠计划，先只回：
{"classification":"need-reads","reads":[{"path":"相对工作区的路径","lines":200}]}
（最多 12 个文件；只能读工作区内文件；程序会把内容追加到下一次请求。）
不要请求写操作 —— 规划阶段是只读的。`;
  }
  return `You are the deep planner for "long-horizon goal mode". First classify the request; only for multi-phase produce a milestone plan covering the WHOLE goal.

## Classification
- "question": pure Q&A / explanation, no workspace change → reply only {"classification":"question","reason":"…"}
- "single-phase": one verifiable deliverable (one fix, one file/module) → reply only {"classification":"single-phase","reason":"…"}
- "multi-phase": genuinely needs ≥3 independently verifiable deliverables → output the full plan JSON

Bias: prefer "single-phase" (run autonomy) over inventing micro-steps. Only use multi-phase when every phase is independently verifiable and the goal is incomplete without any one of them.

## Plan rules
- 3–12 phases, split by RESULT not by ACTION;
- NEVER make "read a file", "run tests once", "inspect logs", "list dirs" a phase;
- each phase outcome must answer "what changed / what works / what was decided";
- each phase needs ≥1 deterministic acceptance (command/test/artifact); human review is not acceptance;
- every goal acceptance must be covered by some phase's "covers" (reference "A1"…);
- invariants non-empty; plan must cover the whole goal (no "do step 1 then look").

## Output
JSON only (no markdown fence, no prose). Multi-phase shape:
${schema}

If you must read specific files first, reply only:
{"classification":"need-reads","reads":[{"path":"workspace-relative path","lines":200}]}
(max 12 files, workspace-only, read-only; contents are appended to the next request.)`;
}

function planUserPrompt(args: {
  userMessage: string;
  briefing: string;
  extraReads: string;
  priorErrors: string;
  zh: boolean;
}): string {
  const { userMessage, briefing, extraReads, priorErrors, zh } = args;
  if (zh) {
    return [
      "## 用户请求",
      userMessage,
      "",
      "## 工作区侦察（程序只读采集）",
      briefing,
      extraReads ? `\n## 你请求读取的文件\n${extraReads}` : "",
      priorErrors ? `\n## 上一次的计划没有通过校验，请修正这些问题后重写完整计划\n${priorErrors}` : "",
      "",
      "现在输出 JSON。",
    ]
      .filter(Boolean)
      .join("\n");
  }
  return [
    "## User request",
    userMessage,
    "",
    "## Workspace reconnaissance (read-only, collected by the program)",
    briefing,
    extraReads ? `\n## Files you asked to read\n${extraReads}` : "",
    priorErrors ? `\n## The previous plan failed validation. Fix these issues and rewrite the WHOLE plan\n${priorErrors}` : "",
    "",
    "Output JSON now.",
  ]
    .filter(Boolean)
    .join("\n");
}

// ========== 计划解析 ==========

interface NeedReadsResponse {
  classification: "need-reads";
  reads?: Array<{ path?: unknown; lines?: unknown }>;
}

function isNeedReads(value: unknown): value is NeedReadsResponse {
  return !!value && typeof value === "object" && (value as { classification?: unknown }).classification === "need-reads";
}

function readRequestPath(entry: { path?: unknown; lines?: unknown }): { path: string; lines: number } | null {
  if (typeof entry?.path !== "string" || entry.path.trim().length === 0) return null;
  const lines = typeof entry.lines === "number" && Number.isFinite(entry.lines) ? Math.max(1, Math.min(2000, Math.floor(entry.lines))) : 200;
  return { path: entry.path.trim(), lines };
}

/** 取文件前 N 行（只读；路径必须在工作区内） */
async function readRequestedFiles(
  cwd: string,
  request: NeedReadsResponse,
  deps: PlannerDeps,
): Promise<string> {
  const read = deps.readTextFile ?? defaultReadTextFile;
  const requested = (Array.isArray(request.reads) ? request.reads : [])
    .slice(0, MAX_READS_PER_ROUND)
    .map(readRequestPath)
    .filter((v): v is { path: string; lines: number } => v !== null);
  const chunks: string[] = [];
  for (const item of requested) {
    const abs = /^[a-zA-Z]:[\\/]|^\//.test(item.path) ? item.path : joinWorkspacePath(cwd, item.path);
    if (!isPathWithinWorkspace(abs, cwd)) {
      // 结构性的只读边界：不读工作区外的文件，并把这个事实告诉模型（不是静默跳过）
      chunks.push(`### ${item.path}\n（拒绝：规划阶段只能读工作区内的文件）`);
      continue;
    }
    try {
      const text = await read(abs, MAX_FILE_BYTES);
      const sliced = text.split("\n").slice(0, item.lines).join("\n");
      chunks.push(`### ${item.path}\n\`\`\`\n${sliced}\n\`\`\``);
    } catch (e) {
      chunks.push(`### ${item.path}\n（读取失败：${e instanceof Error ? e.message : String(e)}）`);
    }
  }
  return chunks.join("\n\n");
}

// ========== 主流程 ==========

/**
 * 跑一次深规划。
 *
 * 返回 `failed` 时**不建目标**（调用方回落 run 自主并如实告知失败原因）—— 让用户被
 * 「规划失败」永久挡在门外，比回落到普通执行更糟；而悄悄不建目标又不告知，是假成功。
 */
export async function planGoal(args: PlanGoalArgs): Promise<PlanGoalResult> {
  const { deps, userMessage, cwd, signal } = args;
  const zh = getLang() === "zh";
  const now = deps.now ?? Date.now;
  const maxAttempts = Math.max(1, args.maxPlanAttempts ?? 3);
  const briefingFn = deps.briefing ?? defaultBriefing;

  let briefing = "";
  try {
    briefing = await briefingFn(cwd);
  } catch (e) {
    briefing = `（侦察失败：${e instanceof Error ? e.message : String(e)}）`;
  }

  const system = planSystemPrompt(zh);
  let extraReads = "";
  let priorErrors = "";
  let readRounds = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (signal?.aborted) return { kind: "failed", reason: "规划被取消", violations: [] };
    const raw = await deps.complete({
      system,
      user: planUserPrompt({ userMessage, briefing, extraReads, priorErrors, zh }),
    });
    if (signal?.aborted) return { kind: "failed", reason: "规划被取消", violations: [] };
    const parsed = extractJSON<Record<string, unknown>>(raw);
    if (!parsed) {
      priorErrors = zh ? "输出的不是可解析的 JSON（必须只输出 JSON）。" : "Output was not parseable JSON (JSON only).";
      continue;
    }

    if (isNeedReads(parsed)) {
      if (readRounds >= MAX_READ_ROUNDS) {
        priorErrors = zh
          ? `最多只能补读 ${MAX_READ_ROUNDS} 轮；请基于已有材料直接给出分类与计划。`
          : `At most ${MAX_READ_ROUNDS} read rounds; produce the classification/plan now.`;
        continue;
      }
      readRounds++;
      const chunk = await readRequestedFiles(cwd, parsed, deps);
      extraReads = [extraReads, chunk].filter(Boolean).join("\n\n");
      // 补读不算「计划重写」：不计入 attempt（否则读两轮就没篇幅写计划了）
      attempt--;
      continue;
    }

    const classification = parsed.classification;
    if (classification === "question" || classification === "single-phase") {
      const reason = typeof parsed.reason === "string" ? parsed.reason : "";
      return { kind: classification, reason };
    }
    if (classification !== "multi-phase") {
      priorErrors = zh
        ? `classification 必须是 question/single-phase/multi-phase/need-reads 之一（收到 ${String(classification)}）。`
        : `classification must be question/single-phase/multi-phase/need-reads (got ${String(classification)}).`;
      continue;
    }

    const validated = validatePlanDraft(parsed as unknown as PlanDraft, {
      budget: args.budget ?? DEFAULT_GOAL_BUDGET,
      now: now(),
    });
    if (!validated.ok) {
      priorErrors = formatViolations(validated.violations);
      continue;
    }
    const plan: GoalPlan = {
      ...validated.plan,
      version: 1,
      contractVersion: 1,
      goalId: "",
    };
    return {
      kind: "multi-phase",
      statement: validated.statement,
      principles: validated.principles,
      nonGoals: validated.nonGoals,
      constraints: validated.constraints,
      acceptance: validated.acceptance,
      plan,
    };
  }

  return {
    kind: "failed",
    reason: zh
      ? `规划器在 ${maxAttempts} 次内没有产出通过校验的里程碑计划`
      : `Planner failed to produce a validated milestone plan within ${maxAttempts} attempts`,
    violations: [],
  };
}

// ========== 重规划 ==========

export interface ReplanArgs {
  goal: { statement: string; principles: string[]; nonGoals: string[]; constraints: string[]; acceptance: Acceptance[] };
  /** 当前计划（只用于告诉模型「哪些阶段已经完成、不要重做」） */
  plan: GoalPlan;
  /** 失败/触发重规划的阶段（key） */
  failedPhaseKey?: string;
  trigger: string;
  /** 触发证据（必须有；空数组 = 无证据重规划，调用方不该走到这里） */
  evidence: GoalEvidence[];
  donePhases: Array<{ phase: PlanPhase; evidence: GoalEvidence[] }>;
  cwd: string;
  deps: PlannerDeps;
  signal?: AbortSignal;
  maxPlanAttempts?: number;
}

export type ReplanResult =
  | { kind: "plan"; plan: GoalPlan }
  | { kind: "failed"; reason: string; violations: PlanViolation[] };

/**
 * 受控重规划：只重写**未完成部分**。
 *
 * 已完成阶段由调用方（runner）原样保留并合并 —— 这里产出的计划只覆盖剩余工作，
 * 所以阶段数下限放宽到 1（剩余工作可能就剩一个里程碑），但**仍然强制结果导向/验收/无环/不重复**。
 */
export async function planReplan(args: ReplanArgs): Promise<ReplanResult> {
  const { deps, goal, plan, donePhases, evidence, trigger, signal } = args;
  const zh = getLang() === "zh";
  const maxAttempts = Math.max(1, args.maxPlanAttempts ?? 3);
  const now = deps.now ?? Date.now;

  const doneKeys = new Set(donePhases.map((d) => d.phase.key));
  // 已完成阶段覆盖过的目标验收 id（重规划只需覆盖剩下的）
  const doneAcceptanceIds = new Set<string>();
  for (const d of donePhases) for (const id of d.phase.covers) doneAcceptanceIds.add(id);

  const evidenceText = evidence
    .slice(-8)
    .map((e) => `- [${e.passed ? "pass" : "fail"}] ${e.phaseKey}/${e.acceptanceId}：${e.summary}`)
    .join("\n");
  const priorPlanText = plan.phases
    .map((p) => `- [${p.status}] ${p.key} ${p.title} —— ${p.outcome}${doneKeys.has(p.key) ? "（已完成，禁止重做/删除）" : ""}`)
    .join("\n");

  let priorErrors = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (signal?.aborted) return { kind: "failed", reason: "重规划被取消", violations: [] };
    const user = zh
      ? [
          "## 目标（不可变契约）",
          goal.statement,
          goal.principles.length > 0 ? `原则：${goal.principles.join("；")}` : "",
          goal.nonGoals.length > 0 ? `非目标：${goal.nonGoals.join("；")}` : "",
          `整体验收：${goal.acceptance.map((a) => a.id).join(", ")}`,
          "",
          "## 当前计划（已完成阶段必须原样保留，不许重做）",
          priorPlanText,
          "",
          `## 重规划触发：${trigger}`,
          "## 触发证据（必须据此调整计划，不要凭空换方案）",
          evidenceText || "（无）",
          "",
          `## 要求`,
          `- 只输出**剩余工作**的里程碑计划（1–12 个阶段，按结果拆，禁止动作型阶段）；`,
          `- 已完成阶段的覆盖（${[...doneAcceptanceIds].join(", ") || "无"}）无需重复覆盖，但剩余目标验收必须被覆盖；`,
          `- 新阶段不得与已完成阶段的 outcome 重复；`,
          "",
          priorErrors ? `## 上一次重写未通过校验\n${priorErrors}` : "",
          "现在输出计划 JSON（多阶段结构，classification 固定 multi-phase）。",
        ]
          .filter(Boolean)
          .join("\n")
      : [
          "## Goal (immutable contract)",
          goal.statement,
          goal.principles.length > 0 ? `Principles: ${goal.principles.join("; ")}` : "",
          goal.nonGoals.length > 0 ? `Non-goals: ${goal.nonGoals.join("; ")}` : "",
          `Acceptance: ${goal.acceptance.map((a) => a.id).join(", ")}`,
          "",
          "## Current plan (completed phases MUST be preserved verbatim; do not redo them)",
          priorPlanText,
          "",
          `## Replan trigger: ${trigger}`,
          "## Trigger evidence (adjust the plan from this evidence, do not invent a new direction)",
          evidenceText || "(none)",
          "",
          "## Requirements",
          "- Output ONLY the remaining-work milestone plan (1–12 phases, by RESULT, no action phases);",
          `- Completed coverage (${[...doneAcceptanceIds].join(", ") || "none"}) need not be covered again, but remaining goal acceptance must be;`,
          "- New phases must not duplicate completed outcomes;",
          "",
          priorErrors ? `## Previous rewrite failed validation\n${priorErrors}` : "",
          "Output the plan JSON now (multi-phase shape, classification fixed to multi-phase).",
        ]
          .filter(Boolean)
          .join("\n");
    const raw = await deps.complete({ system: planSystemPrompt(zh), user });
    const parsed = extractJSON<Record<string, unknown>>(raw);
    if (!parsed) {
      priorErrors = zh ? "输出的不是可解析的 JSON。" : "Output was not parseable JSON.";
      continue;
    }
    if (parsed.classification !== undefined && parsed.classification !== "multi-phase") {
      // 重规划必须是多阶段计划（剩余工作也可以只有 1 个阶段，但结构仍是 phases[]）
      parsed.classification = "multi-phase";
    }
    const validated = validatePlanDraft(parsed as unknown as PlanDraft, {
      now: now(),
      coveredByDone: [...doneAcceptanceIds],
      contractAcceptanceIds: goal.acceptance.map((a) => a.id),
      allowContractOmission: true,
      minPhases: 1,
      maxPhases: 12,
    });
    if (!validated.ok) {
      priorErrors = formatViolations(validated.violations);
      continue;
    }
    return {
      kind: "plan",
      plan: {
        goalId: plan.goalId,
        version: plan.version + 1,
        contractVersion: plan.contractVersion,
        strategy: validated.plan.strategy,
        invariants: validated.plan.invariants,
        phases: validated.plan.phases,
        createdAt: now(),
      },
    };
  }
  return {
    kind: "failed",
    reason: zh
      ? `重规划在 ${maxAttempts} 次内没有产出通过校验的计划`
      : `Replan failed to produce a validated plan within ${maxAttempts} attempts`,
    violations: [],
  };
}
