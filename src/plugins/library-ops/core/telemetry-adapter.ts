/**
 * 遥测适配层 —— 把 Codem 的真实运行数据映射成图书馆快照。
 *
 * 这是「运营监控」的**唯一数据入口**：所有面板、场景、角色动画都只消费
 * `LibrarySnapshot`，因此监控与场景天然一致（同一份真相源）。
 *
 * 数据来源（全部只读、全部防御式访问）：
 *   useProjectStore       项目 / 会话 / 当前会话
 *   useAppStore           消息 / 工具调用 / 活跃会话 / LLM 状态 / 步骤进度
 *   AgentTeamsService     运行时团队（队长 + 成员 + 任务 + 邮箱）
 *   SubagentRuntime       子智能体任务（spawn / fork / 后台）
 *   CostTracker           真实 token / 成本（provider 上报优先）
 *   SquadManager          团队模板（角色模板）
 *   AgentRegistry         智能体定义
 *   TelemetryCollector    遥测事件
 *
 * 设计约束：
 * 1. **绝不写宿主状态** —— 关闭插件后宿主行为零变化。
 * 2. **服务缺失不崩** —— 每个来源独立 try/catch，失败写入 `sources.failed`
 *    （可见性优先，不静默吞错）。
 * 3. **可注入** —— `collectSnapshotSync(deps)` 接受依赖对象，测试无需启动宿主。
 */

import type {
  ActorMetrics,
  LibraryActivity,
  LibraryActor,
  LibraryEvent,
  LibraryMetrics,
  LibrarySnapshot,
  SnapshotSources,
  TeamMemberSummary,
  TeamSummary,
  TeamTaskStatus,
} from "../types";
import { ACTIVITY_META } from "../types";
import { generateLook } from "../data/characters";
import { resolveZoneId } from "../data/library-map";

// ========== 依赖契约（结构类型，避免硬依赖宿主模块） ==========

export interface ProjectLike {
  id: string;
  name: string;
  path: string;
}

export interface SessionLike {
  id: string;
  projectId: string;
  title: string;
  lastMessageAt: number;
  messageCount: number;
  model?: string;
  executionMode?: string;
  worktreeBranch?: string;
}

export interface ToolCallLike {
  id: string;
  tool: string;
  status: "pending" | "running" | "done" | "error";
  result?: string;
  args?: Record<string, unknown>;
}

export interface MessageLike {
  id: string;
  role: string;
  content: string;
  timestamp: number;
  model?: string;
  toolCalls?: ToolCallLike[];
  generatedFiles?: string[];
  status?: string;
}

export interface AppStateLike {
  messages: MessageLike[];
  /** 宿主为 Map<sessionId, boolean>；测试也可能传 Set */
  activeSessions: Map<string, boolean> | Set<string>;
  llmStatus: string;
  stepProgress: { current: number; total: number; title: string } | null;
  agentActivities: Array<{ type: string; label: string; status: string }>;
}

export interface ProjectStateLike {
  projects: ProjectLike[];
  sessions: SessionLike[];
  currentProject: ProjectLike | null;
  currentSession: SessionLike | null;
}

export interface TeamMemberLike {
  id: string;
  name: string;
  role?: string;
  status: string;
  model?: string;
  provider?: string;
}

export interface TeamTaskLike {
  id: string;
  subject: string;
  status: string;
  assignee?: string;
  dependencies: string[];
  attempt: number;
  output?: string;
}

export interface AgentTeamLike {
  id: string;
  name: string;
  captainSessionId: string;
  members: TeamMemberLike[];
  tasks: TeamTaskLike[];
  mailbox: Array<{ id: string; to: string; from: string; deliveredAt?: number }>;
  createdAt: number;
  updatedAt: number;
  archived: boolean;
}

export interface SubagentTaskLike {
  id: string;
  name: string;
  parentId: string;
  agentId: string;
  status: string;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  error?: string;
  activities?: Array<{ type: string; label: string; status: string; startedAt: number }>;
}

export interface CostStatsLike {
  totalRecords: number;
  totalCost: number;
  todayCost: number;
  totalSessions: number;
  totalInputTokens: number;
  totalOutputTokens: number;
}

export interface SquadLike {
  id: string;
  name: string;
  members: Array<{ memberName: string; roleDescription: string | null }>;
}

/** 跨会话委派任务（只读，用于把「被委派的会话」也画成角色） */
export interface DelegationLike {
  id: string;
  sourceSessionId: string;
  targetSessionId: string;
  task: string;
  status: string;
  projectId?: string;
}

export interface AgentDefLike {
  id: string;
  name: string;
  description?: string;
}

export interface TelemetryEventLike {
  sessionId: string;
  name: string;
  timestamp: number;
  data?: Record<string, unknown>;
}

/** 适配层依赖（可注入，测试用 fake） */
export interface AdapterDeps {
  projectState?: () => ProjectStateLike | null;
  appState?: () => AppStateLike | null;
  teams?: () => AgentTeamLike[];
  subagentTasks?: () => SubagentTaskLike[];
  /** 跨会话委派（可选；缺省时场景里不出现「被委派的会话」角色） */
  delegations?: () => DelegationLike[];
  costStats?: () => CostStatsLike | null;
  squads?: () => SquadLike[];
  agentDefs?: () => AgentDefLike[];
  /** 遥测事件（按会话 id 拉取，宿主遥测接口按会话查询） */
  telemetryEvents?: (sessionIds: string[]) => TelemetryEventLike[];
  now?: () => number;
}

/** 缺省依赖：动态 import 宿主服务（懒加载 + 缓存 + 失败降级） */
let cachedDefaultDeps: AdapterDeps | null = null;

export async function loadDefaultDeps(): Promise<AdapterDeps> {
  if (cachedDefaultDeps) return cachedDefaultDeps;
  const deps: AdapterDeps = { now: () => Date.now() };

  try {
    const [{ useProjectStore }, { useAppStore }] = await Promise.all([
      import("../../../core/store"),
      import("../../../store"),
    ]);
    deps.projectState = () => useProjectStore.getState() as unknown as ProjectStateLike;
    deps.appState = () => useAppStore.getState() as unknown as AppStateLike;
  } catch (e) {
    console.warn("[library-ops] project/app store unavailable:", e);
  }

  try {
    const { AgentTeamsService } = await import("../../../core/provider/agent-teams-service");
    deps.teams = () => AgentTeamsService.getInstance().listAll() as unknown as AgentTeamLike[];
  } catch (e) {
    console.warn("[library-ops] agent-teams service unavailable:", e);
  }

  try {
    const { getSubagentRuntime } = await import("../../../core/subagent");
    deps.subagentTasks = () => {
      const rt = getSubagentRuntime();
      if (!rt) return [];
      return (rt.getAllTasks() as unknown as SubagentTaskLike[]) ?? [];
    };
  } catch (e) {
    console.warn("[library-ops] subagent runtime unavailable:", e);
  }

  try {
    const { getDelegationOrchestrator } = await import("../../../core/session");
    deps.delegations = () =>
      (getDelegationOrchestrator().getAllDelegations() as unknown as DelegationLike[]) ?? [];
  } catch (e) {
    console.warn("[library-ops] delegation orchestrator unavailable:", e);
  }

  try {
    const { getCostTracker } = await import("../../../core/llm/cost-tracker");
    deps.costStats = () => getCostTracker().getStats();
  } catch (e) {
    console.warn("[library-ops] cost tracker unavailable:", e);
  }

  try {
    const { getSquadManager } = await import("../../../core/squad/squad");
    deps.squads = () =>
      getSquadManager()
        .listSquads()
        .map((s) => ({
          id: s.id,
          name: s.name,
          members: s.members.map((m) => ({ memberName: m.memberName, roleDescription: m.roleDescription })),
        }));
  } catch (e) {
    console.warn("[library-ops] squad manager unavailable:", e);
  }

  try {
    const { getAgentRegistry } = await import("../../../core/agent/agent");
    deps.agentDefs = () =>
      (getAgentRegistry().getAll() as unknown as AgentDefLike[]) ?? [];
  } catch (e) {
    console.warn("[library-ops] agent registry unavailable:", e);
  }

  try {
    const { getTelemetry } = await import("../../../core/telemetry/telemetry");
    deps.telemetryEvents = (sessionIds: string[]) => {
      const collector = getTelemetry();
      const out: TelemetryEventLike[] = [];
      for (const sid of sessionIds.slice(0, 12)) {
        for (const ev of collector.query(sid, undefined, 20) as unknown as TelemetryEventLike[]) {
          out.push(ev);
        }
      }
      return out;
    };
  } catch {
    // 遥测为可选来源：静默降级（快照 sources 中该计数为 0）
  }

  cachedDefaultDeps = deps;
  return deps;
}

/** 测试用：清空缺省依赖缓存 */
export function _resetDefaultDeps(): void {
  cachedDefaultDeps = null;
}

// ========== 工具函数 ==========

/**
 * 会话是否正在跑 agent loop。
 * 宿主 `useAppStore.activeSessions` 是 `Map<sessionId, boolean>`；此处同时兼容 Set，
 * 避免口径不一致导致「活跃会话」永远为 0。
 */
function isActive(activeSessions: AppStateLike["activeSessions"], id: string): boolean {
  if (!activeSessions) return false;
  const anySessions = activeSessions as unknown as { has?: (k: string) => boolean; get?: (k: string) => unknown };
  if (typeof anySessions.get === "function") return Boolean(anySessions.get(id));
  if (typeof anySessions.has === "function") return Boolean(anySessions.has(id));
  return false;
}

/** 工具名 → 角色动作（岗位语义化，让「在做什么」一眼可读） */
export function toolToActivity(tool: string): LibraryActor["activity"] {
  const t = (tool || "").toLowerCase();
  if (/^(read|grep|glob|list_dir|read_file|read_file_lines|search_notebook)/.test(t)) return "reading";
  if (/^(write|edit|multi_edit|str_replace|apply_patch|create_file)/.test(t)) return "writing";
  if (/^(bash|run_code|run_test|pwsh|terminal_|job_|subprocess)/.test(t)) return "working";
  if (/(web_search|web_fetch|zvec_grep_search|http_get|fetch)/.test(t)) return "searching";
  if (/(ask_user|ask_clarification|exit_plan_mode|request_permission|decision)/.test(t)) return "blocked";
  if (/(spawn_subagent|subagent|send_message|agent_teams_|squad_|workflow|ralph)/.test(t)) return "thinking";
  if (/(todo|plan|update_plan|show_todo|goal)/.test(t)) return "thinking";
  if (/(load_skill|skill_)/.test(t)) return "reading";
  if (/(memory|note_|flashcard|knowledge)/.test(t)) return "working";
  return "working";
}

/** 最近一次工具调用的动作（无工具则 null） */
function activityFromMessages(messages: MessageLike[] | undefined): {
  activity: LibraryActor["activity"] | null;
  focus?: string;
  toolCount: number;
  toolErrors: number;
  lastAt: number;
  tokensHint: number;
} {
  let toolCount = 0;
  let toolErrors = 0;
  let lastAt = 0;
  let focus: string | undefined;
  let activity: LibraryActor["activity"] | null = null;
  if (!messages?.length) return { activity, focus, toolCount, toolErrors, lastAt, tokensHint: 0 };

  // 从后往前找最近一条带工具调用的消息
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    lastAt = Math.max(lastAt, m.timestamp ?? 0);
    const calls = m.toolCalls;
    if (!calls?.length) continue;
    for (let j = calls.length - 1; j >= 0; j--) {
      const c = calls[j];
      toolCount++;
      if (c.status === "error") toolErrors++;
      if (activity === null && c.status !== "pending") {
        activity = toolToActivity(c.tool);
        focus = describeToolCall(c);
      }
    }
  }
  return { activity, focus, toolCount, toolErrors, lastAt, tokensHint: 0 };
}

function describeToolCall(call: ToolCallLike): string {
  const args = call.args ?? {};
  const target =
    (typeof args.file_path === "string" && args.file_path) ||
    (typeof args.path === "string" && args.path) ||
    (typeof args.pattern === "string" && args.pattern) ||
    (typeof args.command === "string" && args.command) ||
    (typeof args.query === "string" && args.query) ||
    "";
  const short = String(target).split(/[\\/]/).pop() || String(target);
  const truncated = short.length > 42 ? `${short.slice(0, 39)}…` : short;
  return truncated ? `${call.tool} · ${truncated}` : call.tool;
}

/** 会话「在馆待命」窗口：最近 6 小时有活动视为待命，更久视为休眠 */
const IDLE_WINDOW_MS = 6 * 3600_000;

function emptyMetrics(): ActorMetrics {
  return { tasks: 0, done: 0, failed: 0, tools: 0, tokens: 0, cost: 0, errors: 0 };
}

function severityOf(activity: LibraryActor["activity"]) {
  return ACTIVITY_META[activity].severity;
}

// ========== 主流程 ==========

/**
 * 同步采集快照（纯函数，依赖全部由参数注入）。
 * 生产环境用 `collectSnapshot()` 自动注入真实依赖。
 */
export function collectSnapshotSync(deps: AdapterDeps, at?: number): LibrarySnapshot {
  const now = at ?? deps.now?.() ?? Date.now();
  const failed: string[] = [];

  const projectState = safe(() => deps.projectState?.() ?? null, "projectStore", failed);
  const appState = safe(() => deps.appState?.() ?? null, "appStore", failed);
  const teams = safe(() => deps.teams?.() ?? [], "agentTeams", failed) ?? [];
  const subagents = safe(() => deps.subagentTasks?.() ?? [], "subagentRuntime", failed) ?? [];
  const cost = safe(() => deps.costStats?.() ?? null, "costTracker", failed);
  const squads = safe(() => deps.squads?.() ?? [], "squadManager", failed) ?? [];
  const agentDefs = safe(() => deps.agentDefs?.() ?? [], "agentRegistry", failed) ?? [];
  const delegations = safe(() => deps.delegations?.() ?? [], "delegationOrchestrator", failed) ?? [];

  const sessions = projectState?.sessions ?? [];
  const currentSessionId = projectState?.currentSession?.id ?? null;
  const activeSessions = appState?.activeSessions ?? new Set<string>();
  const telemetry =
    safe(() => deps.telemetryEvents?.(sessions.map((s) => s.id)) ?? [], "telemetry", failed) ?? [];

  // ---- 团队摘要 ----
  const teamSummaries: TeamSummary[] = teams.map((t) => {
    const taskCounts: Record<TeamTaskStatus, number> = {
      pending: 0,
      claimed: 0,
      in_progress: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
    };
    for (const task of t.tasks) {
      const key = (task.status as TeamTaskStatus) ?? "pending";
      if (taskCounts[key] === undefined) taskCounts.pending++;
      else taskCounts[key]++;
    }
    const members: TeamMemberSummary[] = t.members.map((m) => {
      const mine = t.tasks.filter((x) => x.assignee === m.name);
      const running = mine.find((x) => x.status === "in_progress" || x.status === "claimed");
      return {
        id: m.id,
        name: m.name,
        role: m.role,
        status: m.status,
        model: m.model,
        tasks: mine.length,
        done: mine.filter((x) => x.status === "completed").length,
        currentTask: running?.subject,
      };
    });
    const captainSession = sessions.find((s) => s.id === t.captainSessionId);
    const done = taskCounts.completed;
    return {
      id: t.id,
      name: t.name,
      captainSessionId: t.captainSessionId,
      captainName: captainSession?.title ?? "队长会话",
      memberCount: t.members.filter((m) => m.status !== "removed").length,
      members,
      tasks: t.tasks.map((x) => ({
        id: x.id,
        subject: x.subject,
        status: (x.status as TeamTaskStatus) ?? "pending",
        assignee: x.assignee,
        dependencies: x.dependencies ?? [],
        attempt: x.attempt ?? 0,
      })),
      taskCounts,
      unread: t.mailbox.filter((m) => m.deliveredAt === undefined).length,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      archived: t.archived,
      completion: t.tasks.length > 0 ? done / t.tasks.length : 0,
    };
  });

  // ---- 角色（演员） ----
  //
  // 角色绑定规则（v1.15.0）：馆内角色 = **队长 + 团队成员 + 子智能体 + 正在被委派的会话**。
  // 只读地反映「谁真的在为这个项目干活」：
  // - 没有团队、没有子智能体、也没有在途委派时，场景里只剩**队长**一个人（待命态）；
  // - 普通闲置会话不再各自变成一个角色（以前会把馆内塞满）；
  // - 团队模板（`squads`）只在模板里存在的角色不再占位，避免「没建队却满馆人」。
  const actors: LibraryActor[] = [];
  const teamByCaptain = new Map(teams.filter((t) => !t.archived).map((t) => [t.captainSessionId, t]));
  const sessionById = new Map(sessions.map((s) => [s.id, s]));

  // 1) 队长：当前会话 + 所有运行时团队的队长会话
  const captainIds = new Set<string>();
  if (currentSessionId) captainIds.add(currentSessionId);
  for (const t of teams) {
    if (!t.archived) captainIds.add(t.captainSessionId);
  }
  for (const id of captainIds) {
    const s = sessionById.get(id);
    const team = teamByCaptain.get(id);
    const isCurrent = id === currentSessionId;
    const active = isActive(activeSessions, id);
    const roleLabel = team ? `队长 · ${team.name}` : "队长 · 主控";
    const info = activityFromMessages(isCurrent ? appState?.messages : undefined);
    let activity: LibraryActor["activity"] = "sleeping";
    if (active) {
      activity = info.activity ?? (appState?.llmStatus === "executing_tools" ? "working" : "thinking");
    } else if (isCurrent) {
      activity = info.activity ?? "idle";
    } else if (now - (s?.lastMessageAt ?? 0) < IDLE_WINDOW_MS) {
      activity = "idle";
    }
    const metrics = emptyMetrics();
    metrics.tools = info.toolCount;
    metrics.errors = info.toolErrors;
    if (team) {
      metrics.tasks = team.tasks.length;
      metrics.done = team.tasks.filter((t) => t.status === "completed").length;
      metrics.failed = team.tasks.filter((t) => t.status === "failed" || t.status === "cancelled").length;
    }
    actors.push({
      id: `session:${id}`,
      name: s?.title || (team ? team.name : "队长会话"),
      roleLabel,
      kind: "captain",
      teamId: team?.id,
      teamName: team?.name,
      model: s?.model,
      look: generateLook(`session:${id}`, roleLabel),
      activity,
      statusLabel: ACTIVITY_META[activity].zh,
      focus: info.focus,
      lastEventAt: Math.max(s?.lastMessageAt ?? 0, info.lastAt),
      metrics,
      preferredZoneId: resolveZoneId(roleLabel),
    });
  }

  // 2) 团队成员
  for (const t of teams) {
    if (t.archived) continue;
    for (const m of t.members) {
      if (m.status === "removed") continue;
      const roleLabel = m.role ? `成员 · ${m.role}` : `成员 · ${t.name}`;
      const activity = memberActivity(m.status);
      const metrics = emptyMetrics();
      const mine = t.tasks.filter((x) => x.assignee === m.name);
      metrics.tasks = mine.length;
      metrics.done = mine.filter((x) => x.status === "completed").length;
      metrics.failed = mine.filter((x) => x.status === "failed" || x.status === "cancelled").length;
      const running = mine.find((x) => x.status === "in_progress" || x.status === "claimed");
      actors.push({
        id: `member:${m.id}`,
        name: m.name,
        roleLabel,
        kind: "member",
        teamId: t.id,
        teamName: t.name,
        parentId: t.captainSessionId,
        model: m.model,
        look: generateLook(`member:${m.id}`, roleLabel),
        activity,
        statusLabel: ACTIVITY_META[activity].zh,
        focus: running?.subject ?? m.role,
        lastEventAt: t.updatedAt,
        metrics,
        preferredZoneId: resolveZoneId(roleLabel),
      });
    }
  }

  // 3) 子智能体（有团队 / 无团队都显示：它们本身就是独立的工作单元）
  for (const task of subagents) {
    const roleLabel = task.agentId ? `子智能体 · ${task.agentId}` : "子智能体 · 通用";
    const activity = subagentActivity(task);
    const metrics = emptyMetrics();
    metrics.tools = task.activities?.filter((a) => a.type === "tool").length ?? 0;
    metrics.errors = task.status === "failed" ? 1 : 0;
    const last = task.activities?.[task.activities.length - 1];
    actors.push({
      id: `subagent:${task.id}`,
      name: task.name || task.id.slice(-8),
      roleLabel,
      kind: "subagent",
      parentId: task.parentId,
      look: generateLook(`subagent:${task.id}`, roleLabel),
      activity,
      statusLabel: ACTIVITY_META[activity].zh,
      focus: last?.label,
      lastEventAt: task.completedAt ?? task.startedAt ?? task.createdAt,
      metrics,
      preferredZoneId: resolveZoneId(roleLabel),
    });
  }

  // 4) 在途委派的目标会话（跨会话委派也是一种「派活」，让被派活的会话进馆）
  const delegatedSessionIds = new Set<string>();
  for (const d of delegations) {
    if (d.status !== "pending" && d.status !== "running") continue;
    if (d.targetSessionId) delegatedSessionIds.add(d.targetSessionId);
  }
  for (const sid of delegatedSessionIds) {
    if (captainIds.has(sid)) continue;
    const s = sessionById.get(sid);
    const d = delegations.find((x) => x.targetSessionId === sid && (x.status === "pending" || x.status === "running"));
    const roleLabel = "委派 · 协作会话";
    const activity: LibraryActor["activity"] = d?.status === "running" ? "working" : "thinking";
    actors.push({
      id: `session:${sid}`,
      name: s?.title || d?.task?.slice(0, 24) || "协作会话",
      roleLabel,
      kind: "session",
      parentId: d?.sourceSessionId,
      model: s?.model,
      look: generateLook(`session:${sid}`, roleLabel),
      activity,
      statusLabel: ACTIVITY_META[activity].zh,
      focus: d?.task,
      lastEventAt: s?.lastMessageAt ?? now,
      metrics: emptyMetrics(),
      preferredZoneId: resolveZoneId(roleLabel),
    });
  }

  // 5) 兜底：连队长都没有（没有会话数据）时，至少让值班馆员在馆内待命
  if (actors.length === 0) {
    for (const def of agentDefs.slice(0, 4)) {
      const roleLabel = def.description ? `智能体 · ${def.description}` : `智能体 · ${def.name}`;
      actors.push({
        id: `agent:${def.id}`,
        name: def.name,
        roleLabel,
        kind: "system",
        look: generateLook(`agent:${def.id}`, roleLabel),
        activity: "idle",
        statusLabel: "待命",
        lastEventAt: now,
        metrics: emptyMetrics(),
        preferredZoneId: resolveZoneId(roleLabel),
      });
    }
  }
  if (actors.length === 0) {
    actors.push({
      id: "system:library-clerk",
      name: "值班馆员",
      roleLabel: "系统 · 图书馆值守",
      kind: "system",
      look: generateLook("system:library-clerk", "系统 · 图书馆值守"),
      activity: "idle",
      statusLabel: "待命",
      focus: "等待智能体入场",
      lastEventAt: now,
      metrics: emptyMetrics(),
      preferredZoneId: resolveZoneId("系统 · 图书馆值守"),
    });
  }

  // ---- 汇总指标 ----
  const allTasks = teamSummaries.flatMap((t) => t.tasks);
  const messages = appState?.messages ?? [];
  const toolStats = activityFromMessages(messages);
  const metrics: LibraryMetrics = {
    sessions: sessions.length,
    activeSessions: sessions.filter((s) => isActive(activeSessions, s.id)).length,
    teams: teamSummaries.filter((t) => !t.archived).length,
    tasksTotal: allTasks.length,
    tasksDone: allTasks.filter((t) => t.status === "completed").length,
    tasksFailed: allTasks.filter((t) => t.status === "failed").length,
    tasksRunning: allTasks.filter((t) => t.status === "in_progress" || t.status === "claimed").length,
    tasksPending: allTasks.filter((t) => t.status === "pending").length,
    actors: actors.length,
    actorsWorking: actors.filter((a) => ACTIVITY_META[a.activity].severity === "active").length,
    actorsIdle: actors.filter((a) => a.activity === "idle" || a.activity === "sleeping").length,
    actorsBlocked: actors.filter((a) => a.activity === "blocked").length,
    actorsError: actors.filter((a) => a.activity === "error").length,
    tokensIn: cost?.totalInputTokens ?? 0,
    tokensOut: cost?.totalOutputTokens ?? 0,
    tokensCached: 0,
    costTotal: cost?.totalCost ?? 0,
    costToday: cost?.todayCost ?? 0,
    toolCalls: toolStats.toolCount,
    toolErrors: toolStats.toolErrors,
    filesTouched: countFilesTouched(messages),
    messages: messages.length,
    health: 1,
  };
  metrics.health = computeHealth(metrics);

  const events = buildEvents({ actors, teams: teamSummaries, telemetry, messages, now });
  const activity = buildActivity({ sessions, messages, teams: teamSummaries, now });

  const sources: SnapshotSources = {
    sessions: sessions.length,
    activeSessions: metrics.activeSessions,
    teams: teamSummaries.length,
    teamMembers: actors.filter((a) => a.kind === "member").length,
    subagents: subagents.length,
    teamTemplates: squads.length,
    agentProfiles: agentDefs.length,
    telemetryEvents: telemetry.length,
    failed,
  };

  return { at: now, actors, teams: teamSummaries, metrics, events, activity, sources, sampleMs: 0 };
}

/**
 * 活动分布（真实数据，不编造）：
 * - perDay：每个会话按 lastMessageAt 归入当天；当前会话的每条消息也计入 —— 反映「哪天真的在干活」。
 * - perHour：近 24 小时内消息与会话活动按小时分桶。
 * - kinds：会话类型（主控 / worktree 分支 / 队长 / 委派）。
 */
function buildActivity(input: {
  sessions: SessionLike[];
  messages: MessageLike[];
  teams: TeamSummary[];
  now: number;
}): LibraryActivity {
  const { sessions, messages, teams, now } = input;
  const perDay: Record<string, number> = {};
  const perHour = new Array<number>(24).fill(0);
  const kinds: Record<string, number> = {};

  const captainSessions = new Set(teams.filter((t) => !t.archived).map((t) => t.captainSessionId));
  for (const s of sessions) {
    const kind = captainSessions.has(s.id)
      ? "captain"
      : s.executionMode === "git_worktree"
        ? "worktree"
        : "chat";
    kinds[kind] = (kinds[kind] ?? 0) + 1;
    const at = s.lastMessageAt || 0;
    if (at > 0) {
      perDay[dayKey(at)] = (perDay[dayKey(at)] ?? 0) + 1;
      if (now - at < 24 * 3600_000) perHour[new Date(at).getHours()] += 1;
    }
  }

  for (const m of messages) {
    const at = m.timestamp || 0;
    if (at <= 0) continue;
    perDay[dayKey(at)] = (perDay[dayKey(at)] ?? 0) + 1;
    if (now - at < 24 * 3600_000) perHour[new Date(at).getHours()] += 1;
  }

  // 补齐最近 14 天（缺失补 0，保证热力图格子数稳定）
  const filled: Record<string, number> = {};
  for (let i = 13; i >= 0; i--) {
    const key = dayKey(now - i * 86_400_000);
    filled[key] = perDay[key] ?? 0;
  }

  return { perDay: filled, perHour, kinds };
}

function dayKey(at: number): string {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function memberActivity(status: string): LibraryActor["activity"] {
  switch (status) {
    case "working":
      return "working";
    case "idle":
      return "idle";
    case "absent":
      return "sleeping";
    default:
      return "idle";
  }
}

function subagentActivity(task: SubagentTaskLike): LibraryActor["activity"] {
  switch (task.status) {
    case "running": {
      const last = task.activities?.[task.activities.length - 1];
      if (last?.type === "tool") return toolToActivity(last.label);
      return "thinking";
    }
    case "pending":
      return "thinking";
    case "completed":
      return "done";
    case "failed":
      return "error";
    case "cancelled":
      return "idle";
    default:
      return "idle";
  }
}

function countFilesTouched(messages: MessageLike[]): number {
  const files = new Set<string>();
  for (const m of messages) {
    for (const f of m.generatedFiles ?? []) files.add(f);
    for (const c of m.toolCalls ?? []) {
      if (c.tool !== "write" && c.tool !== "edit" && c.tool !== "multi_edit") continue;
      const p = (c.args?.file_path ?? c.args?.path) as string | undefined;
      if (p) files.add(p);
    }
  }
  return files.size;
}

/** 健康度：完成率 × 无错率 × 活跃度（缺数据时按中性值处理，不虚高） */
export function computeHealth(m: LibraryMetrics): number {
  const completion = m.tasksTotal > 0 ? m.tasksDone / m.tasksTotal : 0.6;
  const errorRate = m.toolCalls > 0 ? m.toolErrors / m.toolCalls : 0;
  const clean = Math.max(0, 1 - errorRate * 2);
  const activity = m.actors > 0 ? Math.min(1, (m.actorsWorking + m.actorsIdle * 0.4) / m.actors) : 0.5;
  const raw = completion * 0.4 + clean * 0.35 + activity * 0.25;
  return Math.max(0, Math.min(1, Math.round(raw * 100) / 100));
}

function buildEvents(input: {
  actors: LibraryActor[];
  teams: TeamSummary[];
  telemetry: TelemetryEventLike[];
  messages: MessageLike[];
  now: number;
}): LibraryEvent[] {
  const { actors, teams, telemetry, messages, now } = input;
  const events: LibraryEvent[] = [];

  // 最近的工具调用（倒序取 20 条）
  const calls: Array<{ msgId: string; call: ToolCallLike; at: number }> = [];
  for (const m of messages) {
    for (const c of m.toolCalls ?? []) calls.push({ msgId: m.id, call: c, at: m.timestamp ?? 0 });
  }
  calls.sort((a, b) => b.at - a.at);
  for (const { msgId, call, at } of calls.slice(0, 20)) {
    const act = toolToActivity(call.tool);
    events.push({
      id: `tool:${msgId}:${call.id}`,
      at,
      kind: "tool",
      severity: call.status === "error" ? "bad" : call.status === "running" ? "active" : severityOf(act),
      text: `${call.tool} · ${describeToolCall(call)}`,
    });
  }

  // 团队任务状态
  for (const team of teams) {
    for (const task of team.tasks) {
      const sev: LibraryEvent["severity"] =
        task.status === "completed" ? "ok" : task.status === "failed" ? "bad" : task.status === "in_progress" ? "active" : "wait";
      events.push({
        id: `task:${team.id}:${task.id}:${task.status}`,
        at: team.updatedAt,
        kind: "task",
        severity: sev,
        text: `[${team.name}] ${task.id} ${task.subject}`,
        teamId: team.id,
        actorId: task.assignee ? `member:${task.assignee}` : undefined,
      });
    }
  }

  // 角色状态（当前焦点）
  for (const a of actors) {
    if (!a.focus) continue;
    events.push({
      id: `actor:${a.id}:${a.activity}:${a.focus}`,
      at: a.lastEventAt || now,
      kind: a.kind === "subagent" ? "agent" : "session",
      severity: severityOf(a.activity),
      text: `${a.name} — ${a.focus}`,
      actorId: a.id,
      teamId: a.teamId,
    });
  }

  // 遥测事件
  for (const ev of telemetry.slice(0, 30)) {
    events.push({
      id: `telemetry:${ev.sessionId}:${ev.name}:${ev.timestamp}`,
      at: ev.timestamp,
      kind: "system",
      severity: /error|fail/i.test(ev.name) ? "bad" : "active",
      text: `${ev.name}`,
      value: typeof ev.data?.tokens === "number" ? ev.data.tokens : undefined,
    });
  }

  events.sort((a, b) => b.at - a.at);
  const unique: LibraryEvent[] = [];
  const seenIds = new Set<string>();
  for (const e of events) {
    if (seenIds.has(e.id)) continue;
    seenIds.add(e.id);
    unique.push(e);
    if (unique.length >= 120) break;
  }
  return unique;
}

function safe<T>(fn: () => T, name: string, failed: string[]): T | null {
  try {
    return fn();
  } catch (e) {
    console.warn(`[library-ops] source "${name}" failed:`, e);
    failed.push(name);
    return null;
  }
}

/** 生产入口：注入真实依赖并采集 */
export async function collectSnapshot(): Promise<LibrarySnapshot> {
  const started = typeof performance !== "undefined" ? performance.now() : Date.now();
  const deps = await loadDefaultDeps();
  const snap = collectSnapshotSync(deps);
  const ended = typeof performance !== "undefined" ? performance.now() : Date.now();
  return { ...snap, sampleMs: Math.round((ended - started) * 100) / 100 };
}
