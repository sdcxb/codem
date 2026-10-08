/**
 * 记忆体检（Memory Checkup）—— 「设置 → 记忆体检」视图的**数据层**。
 *
 * ## 为什么单独一个模块
 *
 * 这个视图的核心是**归属解析**与**分组**，两者都是纯数据问题（与 React 无关）。
 * 放进组件里会变成"边渲染边查库"，正是用户点名的性能坑（列表可能几百条 ⇒ N+1）。
 * 因此这里把口径固定下来：
 *
 * 1. **批量**：先用 `buildOwnershipIndex()` 把所有项目、所有会话**各读一次**（域镜像内部一次
 *    `domains.all`），之后所有解析都打内存索引 —— 渲染 N 条记忆只有 **2 次**存储读；
 * 2. **分组只用于展示**：这里输出的 `groupKey` 不参与任何写操作，删除/改归属必须由调用方
 *    带上**用户显式勾选的 id**（见 `MemoryService.removeMany`）；
 * 3. **未知就是未知**：解析不到归属一律如实进 `unknown` 组并给出原因，
 *    **绝不**把"归属未知"静默塞进平台级（那等于替用户编造归属）。
 *
 * ## 与迁移的关系（为什么旧数据会出现在"归属未知"组）
 *
 * 旧 `project` 条目没有 `projectId`，它当时的实际可见范围就是"到处生效"，
 * 因此迁移规则把它降为 `platform`（见 `MemoryService.migrateScopeModel`）—— 它们出现在**平台级**组，正确；
 * 旧 `session` 条目迁移成 `conversation` 且**不带 sessionId**（于是仍然不被注入，与迁移前一致），
 * 它们没有归属可解析 ⇒ 进**归属未知**组，组头写明原因。
 */
import {
  getMemoryService,
  isLegacyPoolInjectionPaused,
  projectIdFromCwd,
  type MemoryEntry,
  type MemoryScope,
  type MemoryStatus,
  type MemoryService,
} from "./memory";
import { listProjects } from "../storage/project";
import type { Project } from "../types";
import { listSessions, getSession } from "../storage/session";

/**
 * 来源三态。
 *
 * `unknown` 存在的原因：旧数据里**没有任何字段**能区分"用户手写的"和"当时自动提取的"，
 * 所以一律显示"未知（旧数据）"，**不许**被标成 manual 或 auto（那是编造来源）。
 */
export type CheckupSource = "manual" | "auto" | "unknown";

interface CheckupEntry {
  id: string;
  key: string;
  content: string;
  timestamp: number;
  scope: MemoryScope;
  /** 库里作用域字段的**原始值**（可能是 `"workspace"` 这类本模块不认识的词，M-5 要显示出来） */
  scopeRaw: string;
  source: CheckupSource;
  status: MemoryStatus;
  /**
   * 该条目在**当前上下文**里会不会被注入（界面要能自证，不许让用户以为它生效着）。
   *
   * 第 187 波（I4）起与注入侧**完全同口径**：不只看 scope/归属/status，
   * 还算上"每作用域每来源 20 条 + 总字符预算"的截断 ⇒ 第 21 条起如实显示"不进上下文"。
   */
  injected: boolean;
  /** `injected === false` 的**真实原因**（I4：不许只给一个 false 让用户猜） */
  notInjectedReason?: string;
  /** 旧版跨项目池标记（M-2） */
  legacyPool: boolean;
  projectId?: string;
  sessionId?: string;
  batchId?: string;
  tags?: string[];
  filePath?: string;
}

export interface CheckupGroup {
  /** 稳定 key（React 列表用，也是判据的断言锚点） */
  groupKey: string;
  /** 分组归属的类型 */
  kind: "platform" | "legacy-pool" | "project" | "conversation" | "unknown" | "unknown-scope";
  /** 组标题（项目名 / 对话标题；解析不到时是 id + 标注） */
  title: string;
  /** 组头补充说明（归属未知组**必须**写明原因） */
  note: string;
  /** 该组的归属是否没能解析出来（已删除的项目/对话，或旧数据没有归属） */
  unresolved: boolean;
  /** M-2：这一组是否提供「保留为平台级」这类处置动作（旧版跨项目池专用） */
  actionable?: boolean;
  projectId?: string;
  sessionId?: string;
  entries: CheckupEntry[];
}

export interface MemoryCheckup {
  groups: CheckupGroup[];
  total: number;
  pendingCount: number;
  unresolvedCount: number;
  /** 各来源态的条数（旧数据单列一档） */
  sourceCounts: Record<CheckupSource, number>;
  /** 组数（判据/界面头部用） */
  groupCount: number;
  /** 旧版跨项目池的条数（M-2） */
  legacyPoolCount: number;
  /** 作用域无法识别的条数（M-5） */
  unknownScopeCount: number;
  /** 「暂停注入旧版跨项目记忆」当前是否打开（M-2；界面据此显示开关状态与后果） */
  legacyPoolPaused: boolean;
  /** 实际会被注入的条数（I4：与注入侧同一口径） */
  injectedCount: number;
  /** 被注入上限（每块 20 条 / 总字符预算）挡住的条数（I4：如实披露） */
  truncatedCount: number;
}

/** 归属索引的解析结果：能解析出名字，还是一无所知 */
type OwnerResolution =
  | { ok: true; name: string }
  | { ok: false; reason: string };

export interface OwnershipIndex {
  projects: Map<string, Project>;
  sessions: Map<string, { id: string; title: string; parentProjectId?: string }>;
  /** `projectId`（= 归一化工作目录）→ 项目 */
  resolveProject(rawId?: string): OwnerResolution;
  /** `sessionId` → 会话 */
  resolveSession(rawId?: string): OwnerResolution;
  /** `projectId` → 项目名（解析不到给"未知（已删除的项目）"这类如实措辞） */
  projectName(rawId?: string): string;
  /** `sessionId` → 对话标题 */
  sessionTitle(rawId?: string): string;
  /** 会话归属的项目名（对话分组头展示"项目名 / 对话标题"用） */
  sessionProjectName(sessionId?: string): string;
}

const UNKNOWN_PROJECT = "未知（已删除的项目）";
const UNKNOWN_SESSION = "未知（已删除的对话）";

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

/**
 * 批量建立归属索引（**整个视图只有这两次存储读**）。
 *
 * - 项目：`listProjects()` 一次（域镜像内部一次批量读）；
 * - 会话：每个项目 `listSessions(projectId)` 一次（同样是镜像内的一次过滤，不是每次一条 SQL）。
 *
 * 记忆条目里存的 `projectId` 是**归一化后的工作目录**（见 `projectIdFromCwd`），
 * 而项目表里是 UUID —— 所以这里同时按 `id` 与归一化 `path` 建索引。
 */
function buildOwnershipIndex(): OwnershipIndex {
  let all: Project[] = [];
  try {
    all = listProjects();
  } catch (e) {
    console.warn("[memory-checkup] 项目列表读取失败:", e);
  }
  const sessionsByProject = new Map<string, Array<{ id: string; title: string }>>();
  for (const p of all) {
    if (!p?.id) continue;
    try {
      sessionsByProject.set(p.id, listSessions(p.id).map((s) => ({ id: s.id, title: s.title || "(无标题)" })));
    } catch (e) {
      console.warn("[memory-checkup] 会话列表读取失败:", e);
      sessionsByProject.set(p.id, []);
    }
  }
  return buildOwnershipIndexFrom(all, sessionsByProject, (id) => {
    try {
      const s = getSession(id);
      if (!s?.id) return null;
      const raw = asRecord(s);
      const parent = (raw.projectId ?? raw.project_id) as string | undefined;
      return { id: s.id, title: s.title || "(无标题)", parentProjectId: parent || undefined };
    } catch (e) {
      console.warn("[memory-checkup] 会话读取失败:", e);
      return null;
    }
  });
}

/** 单条会话兜底读取器（索引里没有时用；子会话会被 `listSessions` 滤掉，需要单独补一次） */
export type SessionLookup = (id: string) => { id: string; title: string; parentProjectId?: string } | null;

/**
 * **纯函数**版本的索引构造（判据与界面共用同一条口径）。
 *
 * 界面把 `useProjectStore` 里已经加载好的项目/会话直接传进来 ⇒ 连那两次存储读都省了；
 * 判据传自造数据 ⇒ 不依赖真实工作区。
 */
export function buildOwnershipIndexFrom(
  projectList: Project[],
  sessionsByProject: Map<string, Array<{ id: string; title: string }>>,
  lookupSession?: SessionLookup,
): OwnershipIndex {
  const projects = new Map<string, Project>();
  const byPath = new Map<string, Project>();
  for (const p of projectList) {
    if (!p?.id) continue;
    projects.set(p.id, p);
    const normalized = projectIdFromCwd(p.path);
    if (normalized) byPath.set(normalized, p);
  }

  const sessions = new Map<string, { id: string; title: string; parentProjectId?: string }>();
  for (const [projectId, list] of sessionsByProject) {
    for (const s of list) {
      if (!s?.id) continue;
      sessions.set(s.id, { id: s.id, title: s.title || "(无标题)", parentProjectId: projectId });
    }
  }

  const findSession = (id: string) => {
    const cached = sessions.get(id);
    if (cached) return cached;
    const looked = lookupSession?.(id);
    if (looked) {
      sessions.set(looked.id, looked);
      return looked;
    }
    return undefined;
  };

  const resolveProject = (rawId?: string): OwnerResolution => {
    if (!rawId) return { ok: false, reason: UNKNOWN_PROJECT };
    const p = projects.get(rawId) ?? byPath.get(rawId) ?? byPath.get(projectIdFromCwd(rawId) ?? "");
    return p ? { ok: true, name: p.name || p.path || p.id } : { ok: false, reason: UNKNOWN_PROJECT };
  };

  const resolveSession = (rawId?: string): OwnerResolution => {
    if (!rawId) return { ok: false, reason: UNKNOWN_SESSION };
    const s = findSession(rawId);
    return s ? { ok: true, name: s.title } : { ok: false, reason: UNKNOWN_SESSION };
  };

  return {
    projects,
    sessions,
    resolveProject,
    resolveSession,
    projectName: (rawId?: string) => {
      const r = resolveProject(rawId);
      return r.ok ? r.name : UNKNOWN_PROJECT;
    },
    sessionTitle: (rawId?: string) => {
      const r = resolveSession(rawId);
      return r.ok ? r.name : UNKNOWN_SESSION;
    },
    sessionProjectName: (sessionId?: string) => {
      if (!sessionId) return UNKNOWN_PROJECT;
      const s = findSession(sessionId);
      if (!s?.parentProjectId) return UNKNOWN_PROJECT;
      const p = projects.get(s.parentProjectId);
      return p ? p.name || p.path || p.id : UNKNOWN_PROJECT;
    },
  };
}

/** 来源三态：**只有明确记过的来源才算数**，其余一律"未知（旧数据）" */
export function checkupSourceOf(entry: MemoryEntry): CheckupSource {
  const raw = entry.source;
  if (raw === "manual" || raw === "auto") return raw;
  return "unknown";
}

/**
 * 该条目在当前上下文里会不会被注入（与 `MemoryService` 的注入口径一致）。
 * 体检视图用它显示"这条现在不生效"，所以必须用**用户当前位置**算，不能用条目自己的归属算。
 */
function checkupInjected(entry: MemoryEntry, ctx: { projectId?: string; sessionId?: string }): boolean {
  if ((entry.status ?? "active") !== "active") return false;
  if (entry.scope === "platform") return true;
  if (entry.scope === "project") return Boolean(entry.projectId) && entry.projectId === ctx.projectId;
  return Boolean(entry.sessionId) && entry.sessionId === ctx.sessionId;
}

/** 组头里「归属未知」的原因文案（判据 MEM-CHECK-2 断言它必须出现） */
export const UNRESOLVED_REASON = "旧版本没有记录归属，无法判断属于哪个项目/对话";

/**
 * 「归属已失效」的原因文案（I9）。
 *
 * 与 `UNRESOLVED_REASON` **必须分开**：旧数据是"从来没有过归属"，而这一条是
 * "有归属键、但目标（项目/对话）现在解析不到了"（项目被删、目录不在了、worktree 被清理）。
 * 两种情况给同一句理由，就会把**几分钟前刚写的**条目标成"旧数据"，并给出错误的原因。
 */
const STALE_OWNER_REASON = "归属键还在，但目标项目/对话已经不存在（解析不到），所以当前不会被注入";

/** 旧版跨项目池组的标题（M-2；判据与界面共用同一句） */
const LEGACY_POOL_TITLE = "旧版跨项目记忆（无法判断归属，可能被污染）";

/** 旧版跨项目池组的说明（M-2：必须写明**为什么**它与平台级不同，以及为什么没有批次可撤） */
const LEGACY_POOL_REASON =
  "这些条目来自旧版本的 project 记忆池：当时只按作用域过滤、不记录归属，" +
  "所以它们可能混进了别的项目的内容，而今天仍然在所有项目生效。" +
  "旧数据没有批次信息（「撤销批次」对它们没有意义），请用批量删除、归位，或先「暂停注入」再逐条处置。";

/** 作用域无法识别组的标题与说明（M-5） */
const UNKNOWN_SCOPE_TITLE = "作用域无法识别";
const UNKNOWN_SCOPE_REASON =
  "这些条目的作用域不是 platform / project / conversation 三者之一（例如更老版本写的 workspace、大小写不符或空值）：" +
  "它们过去在界面上完全看不见、也删不掉，现在单独列出，可删除或归位。";

/**
 * 生成体检数据。
 *
 * 分组口径（与产品注入口径一一对应）：
 * - `platform` 且**没有** `legacyPool` 标记 ⇒ 「平台级」组；
 * - `platform` 且**有** `legacyPool` 标记 ⇒ 「旧版跨项目记忆（无法判断归属，可能被污染）」组
 *   （M-2：与平台级**分开**，组头写明原因，并提供批量删除/归位/保留为平台级）；
 * - `project` 且 `projectId` 能解析到项目 ⇒ 「项目级 · <项目名>」组；
 * - `conversation` 且 `sessionId` 能解析到对话 ⇒ 「对话级 · <项目名> / <对话标题>」组；
 * - 有归属键但解析不到 ⇒ 「归属未知（旧数据）」组，但组头**分开**写两种原因（I9）；
 * - 作用域不是三者之一 ⇒ 「作用域无法识别」组（M-5：可删除/可归位，计入清空全部）。
 */
export function createMemoryCheckup(
  ctx?: { projectId?: string; sessionId?: string },
  opts?: {
    index?: OwnershipIndex;
    entries?: MemoryEntry[];
    service?: Pick<MemoryService, "listAll"> & Partial<Pick<MemoryService, "injectionPlan" | "injectionExplanations">>;
  },
): MemoryCheckup {
  const index = opts?.index ?? buildOwnershipIndex();
  const service = opts?.service ?? getMemoryService();
  /**
   * 列表口径：**跨项目全量 + 全部视图开关**（含未批准、含无归属）。
   *
   * - `showAllProjects` 是**体检专用**：审查必须能看到所有项目/对话的条目
   *   （它不影响注入 —— 注入路径永远只按当前位置过滤）；
   * - `ctx` 里的 projectId/sessionId 仍然传下去，但只用于算每条的 `injected`
   *   （"这条**现在**会不会生效"）—— 它由上面的 `checkupInjected` 按当前位置逐条判定。
   */
  const entries =
    opts?.entries ?? service.listAll({ ...ctx, includePending: true, includeUnscoped: true, showAllProjects: true });

  /**
   * I4 / F5：**注入判定与真实原因**由注入侧给出（**单一口径**，界面/体检/注入三处共用）。
   *
   * 没有 `injectionExplanations` 的实现（判据里传的假 service）退回"只按 scope/归属/status 判"，
   * 并如实把 `truncatedCount` 记为 0 —— 不许假装算过截断。
   */
  const plan = service.injectionExplanations?.({ ...ctx }) ?? null;
  const checkupInjectedWithReason = (entry: MemoryEntry): { injected: boolean; reason?: string } => {
    if (plan) {
      return plan.injected.has(entry.id)
        ? { injected: true }
        : { injected: false, reason: plan.reasons.get(entry.id) ?? "不在当前项目/对话的作用域内" };
    }
    // 兜底分支：只给不带 injectionExplanations 的测试替身用（口径与注入侧一致）
    if ((entry.status ?? "active") !== "active") return { injected: false, reason: "待批准（未批准不进上下文）" };
    if (isLegacyPoolInjectionPaused() && entry.legacyPool === true) {
      return { injected: false, reason: "已打开「暂停注入旧版跨项目记忆」" };
    }
    if (entry.scope !== "platform" && entry.scope !== "project" && entry.scope !== "conversation") {
      return { injected: false, reason: "作用域无法识别，注入路径不认识它" };
    }
    return { injected: checkupInjected(entry, ctx ?? {}) };
  };

  const platform: CheckupEntry[] = [];
  const legacyPool: CheckupEntry[] = [];
  const projectGroups = new Map<string, CheckupEntry[]>();
  const conversationGroups = new Map<string, CheckupEntry[]>();
  const unresolved: CheckupEntry[] = [];
  const unresolvedStale: CheckupEntry[] = [];
  const unknownScope: CheckupEntry[] = [];
  const sourceCounts: Record<CheckupSource, number> = { manual: 0, auto: 0, unknown: 0 };
  let pendingCount = 0;
  let injectedCount = 0;

  for (const e of entries) {
    const source = checkupSourceOf(e);
    sourceCounts[source]++;
    if ((e.status ?? "active") === "pending") pendingCount++;

    const verdict = checkupInjectedWithReason(e);
    if (verdict.injected) injectedCount++;

    const item: CheckupEntry = {
      id: e.id,
      key: e.key,
      content: e.content,
      timestamp: e.timestamp,
      scope: e.scope,
      scopeRaw: typeof e.scope === "string" ? e.scope : "",
      source,
      status: e.status ?? "active",
      /*
       * `injected` = "这条**现在**会不会进上下文" ⇒ 一律拿**当前位置**算
       * （当前项目 A 的用户看到项目 B 的条目时，它应当显示"不进上下文"，而不是"因为它属于 B 所以生效"）。
       */
      injected: verdict.injected,
      notInjectedReason: verdict.reason,
      legacyPool: e.legacyPool === true,
      projectId: e.projectId,
      sessionId: e.sessionId,
      batchId: e.batchId,
      tags: e.tags,
      filePath: e.filePath,
    };

    // M-5：作用域不是三者之一 ⇒ 单独一组（过去所有界面都看不见它们）
    if (e.scope !== "platform" && e.scope !== "project" && e.scope !== "conversation") {
      unknownScope.push(item);
      continue;
    }
    if (e.scope === "platform") {
      // M-2：旧版跨项目池与真正的平台级**分开**
      if (e.legacyPool === true) legacyPool.push(item);
      else platform.push(item);
      continue;
    }
    if (e.scope === "project") {
      const resolved = index.resolveProject(e.projectId);
      if (e.projectId && resolved.ok) {
        const list = projectGroups.get(e.projectId) ?? [];
        list.push(item);
        projectGroups.set(e.projectId, list);
      } else if (e.projectId) {
        // I9：有归属键但解析不到 ⇒ 「归属已失效」，与"旧数据从来没有归属"分开
        unresolvedStale.push(item);
      } else {
        unresolved.push(item);
      }
      continue;
    }
    const resolved = index.resolveSession(e.sessionId);
    if (e.sessionId && resolved.ok) {
      const list = conversationGroups.get(e.sessionId) ?? [];
      list.push(item);
      conversationGroups.set(e.sessionId, list);
    } else if (e.sessionId) {
      unresolvedStale.push(item);
    } else {
      unresolved.push(item);
    }
  }

  const groups: CheckupGroup[] = [];

  if (platform.length > 0) {
    groups.push({
      groupKey: "platform",
      kind: "platform",
      title: "平台级",
      note: "所有项目、所有对话都会生效",
      unresolved: false,
      entries: platform,
    });
  }

  /**
   * M-2：**旧版跨项目记忆**单独一组。
   *
   * 位置紧跟平台级之后、用独立的 `kind` 与组头 —— 判据同时钉住"与平台级分开"与"组头写明原因"。
   */
  if (legacyPool.length > 0) {
    groups.push({
      groupKey: "legacy-project-pool",
      kind: "legacy-pool",
      title: LEGACY_POOL_TITLE,
      note: LEGACY_POOL_REASON,
      unresolved: true,
      actionable: true,
      entries: legacyPool,
    });
  }

  for (const [projectId, list] of projectGroups) {
    const resolved = index.resolveProject(projectId);
    groups.push({
      groupKey: `project:${projectId}`,
      kind: "project",
      title: `项目级 · ${resolved.ok ? resolved.name : projectId}`,
      note: "仅该项目内的所有对话生效",
      unresolved: false,
      projectId,
      entries: list,
    });
  }

  for (const [sessionId, list] of conversationGroups) {
    const session = index.resolveSession(sessionId);
    groups.push({
      groupKey: `conversation:${sessionId}`,
      kind: "conversation",
      title: `对话级 · ${index.sessionProjectName(sessionId)} / ${session.ok ? session.name : sessionId}`,
      note: "仅该对话生效",
      unresolved: false,
      sessionId,
      entries: list,
    });
  }

  if (unresolved.length > 0) {
    groups.push({
      groupKey: "unknown",
      kind: "unknown",
      title: "归属未知（旧数据）",
      note: UNRESOLVED_REASON,
      unresolved: true,
      entries: unresolved,
    });
  }

  /* I9：归属**已失效**（有归属键但目标解析不到）单列一组，理由与「旧数据从来没有归属」不同 */
  if (unresolvedStale.length > 0) {
    groups.push({
      groupKey: "unknown-stale-owner",
      kind: "unknown",
      title: "归属已失效（目标项目/对话不存在）",
      note: STALE_OWNER_REASON,
      unresolved: true,
      entries: unresolvedStale,
    });
  }

  /* M-5：作用域无法识别 —— 必须给用户一个能删除/归位的入口，并计入「清空全部」 */
  if (unknownScope.length > 0) {
    groups.push({
      groupKey: "unknown-scope",
      kind: "unknown-scope",
      title: UNKNOWN_SCOPE_TITLE,
      note: UNKNOWN_SCOPE_REASON,
      unresolved: true,
      entries: unknownScope,
    });
  }

  return {
    groups,
    total: entries.length,
    pendingCount,
    unresolvedCount: unresolved.length + unresolvedStale.length,
    sourceCounts,
    groupCount: groups.length,
    legacyPoolCount: legacyPool.length,
    unknownScopeCount: unknownScope.length,
    legacyPoolPaused: isLegacyPoolInjectionPaused(),
    injectedCount,
    truncatedCount: plan?.truncated ?? 0,
  };
}

/** 「归位」目标：平台级 / 某项目级 / 某对话级 */
export type CheckupRetarget =
  | { scope: "platform" }
  | { scope: "project"; projectId: string }
  | { scope: "conversation"; sessionId: string };

/** 归位目标的可读标题（用在确认文案与回执里） */
function describeRetarget(target: CheckupRetarget): string {
  if (target.scope === "platform") return "平台级（所有项目）";
  if (target.scope === "project") return `项目级（${target.projectId}）`;
  return `对话级（${target.sessionId}）`;
}

/**
 * 手工归位：把条目改成用户指定的作用域/归属。
 *
 * 这是**用户显式动作**（不是自动判断），因此允许改作用域与归属；
 * 但**来源与批次归属保持不动**（来源是历史事实，不该因为归位而被重写）。
 *
 * 第 187 波两处收紧：
 * - **归一化（B3 / I2）**：`projectId` 必须过 `projectIdFromCwd()` —— 界面下拉给的是
 *   **原始项目路径**（`C:\work\alpha`），而注入侧的 ctx 是归一化后的（`c:\work\alpha`）。
 *   原样写进去 ⇒ 条目"归位成功"却**永不进上下文**（界面自相矛盾：组头说生效、徽标说不进）。
 *   归一化口径**只有这一处**（`projectIdFromCwd`），界面与数据层共用。
 * - **处置即摘标记（M-2）**：用户显式改过归属的旧池条目不再是"跨项目池"成员
 *   （它已经落到一个具体项目/对话，或已被显式保留为平台级）⇒ 摘掉 `legacyPool`。
 * - **容量（B5）**：`update` 会守容量并返回 false，这里把真实原因回执给用户。
 */
export async function retargetEntry(id: string, target: CheckupRetarget): Promise<{ ok: boolean; message: string }> {
  const service = getMemoryService();
  const entry = service.get(id);
  if (!entry) return { ok: false, message: `未找到记忆：${id}` };
  const normalizedProjectId = target.scope === "project" ? projectIdFromCwd(target.projectId) ?? target.projectId : undefined;
  const updates: Partial<MemoryEntry> =
    target.scope === "platform"
      ? { scope: "platform", projectId: undefined, sessionId: undefined, legacyPool: undefined }
      : target.scope === "project"
        ? { scope: "project", projectId: normalizedProjectId, sessionId: undefined, legacyPool: undefined }
        : { scope: "conversation", sessionId: target.sessionId, projectId: undefined, legacyPool: undefined };
  // 容量拒绝 / 截断要**如实回执**（`getLastWriteError()` 是 update 的可见失败通道）
  service.getLastWriteError();
  const ok = service.update(id, updates, { actor: "user" });
  if (!ok) {
    const reason = service.getLastWriteError() ?? "未知原因";
    return { ok: false, message: `归位失败：${reason}` };
  }
  /*
   * F6：`update` 只把改动交给**确认链**（"已接受"不等于"已落库"）⇒ 回执必须等确认结果，
   * 否则库写不进去时界面上那句「已归位」就是**假成功**（重启后改动消失，而用户已被告知成功）。
   */
  const landed = await service.flushPendingPersist();
  if (!landed) {
    return { ok: false, message: `归位未落库：${service.getLastPersistError() ?? "未知原因"}（重启后这次归位会失效）` };
  }
  const truncated = service.getLastWriteError();
  return {
    ok: true,
    message:
      `已归位并已落库：${entry.key} → ${describeRetarget({ ...target, ...(normalizedProjectId ? { projectId: normalizedProjectId } : {}) } as CheckupRetarget)}` +
      (truncated ? `（注意：${truncated}）` : ""),
  };
}

/**
 * 「保留为平台级」（M-2）：只摘掉旧版跨项目池标记，**不改可见范围**。
 *
 * 用户看过内容、确认它确实该对所有项目生效时用它 —— 条目从「旧版跨项目记忆」组
 * 移进普通「平台级」组，之后不再受「暂停注入」开关影响。
 */
export async function keepAsPlatformPool(id: string): Promise<{ ok: boolean; message: string }> {
  const service = getMemoryService();
  const entry = service.get(id);
  if (!entry) return { ok: false, message: `未找到记忆：${id}` };
  if (entry.legacyPool !== true) return { ok: false, message: "该条目不属于「旧版跨项目记忆」组（无需保留）" };
  const ok = service.update(id, { legacyPool: undefined }, { actor: "user" });
  if (!ok) return { ok: false, message: `保留失败：${service.getLastWriteError() ?? id}` };
  // F6：同样等确认，不许给假成功回执
  const landed = await service.flushPendingPersist();
  if (!landed) return { ok: false, message: `保留未落库：${service.getLastPersistError() ?? "未知原因"}（重启后这次保留会失效）` };
  // F3：确认落库之后，把"上一次写失败"的粘性残迹清掉 —— 否则本次成功会被后续回执报成失败
  service.clearLastPersistErrorIfLanded();
  return {
    ok: true,
    message: `已保留为平台级：${entry.key}（可见范围不变，仍对所有项目生效；不再受「暂停注入」影响）`,
  };
}

/**
 * **导入回执**（F3，第 188 波复审）—— 纯函数，界面用它、判据直接钉它。
 *
 * 为什么要有它：导入的回执原来在组件里**同一个 tick** 读完 `getLastPersistError()` 就拼出来，
 * 而写入走的是**异步确认链** ⇒ 两个方向都失真（失败说成功、成功说失败）。现在把"确认结果
 * → 那句话"抽成纯函数：
 * - `imported > 0 && landed` ⇒ 只能说成功（**不许**出现失败字样）；
 * - `imported > 0 && !landed` ⇒ 必须说清失败（**不许**出现"成功导入"）；
 * - `imported === 0 && !landed` ⇒ 那是**上一次**写入的粘性失败，必须与本次区分（否则用户会以为
 *   是这次导入坏了）。
 */
export function formatMemoryImportReceipt(
  result: { imported: number; rejectedCapacity: number; rejectedInvalid: number; truncated: number },
  landed: boolean,
  lastPersistError: string | null,
): string {
  const extras = [
    result.rejectedCapacity > 0 ? `${result.rejectedCapacity} 条因目标作用域已达容量上限被拒绝` : "",
    result.rejectedInvalid > 0 ? `${result.rejectedInvalid} 条格式不合法（缺 id/key/content）被跳过` : "",
    result.truncated > 0 ? `${result.truncated} 条内容超长已截断` : "",
  ].filter(Boolean);
  const tail = extras.length > 0 ? `\n${extras.join("；")}。` : "";
  if (result.imported > 0 && !landed) {
    return (
      `导入 ${result.imported} 条记忆到内存，但**写入数据库失败**：${lastPersistError ?? "未知原因"}\n` +
      `重启后这些记忆会丢失。${tail}`
    );
  }
  if (result.imported === 0 && !landed) {
    return (
      `未导入任何记忆（可能所有记忆已存在）。` +
      `另有一次**上一次**写入数据库的失败仍未消除：${lastPersistError ?? "未知原因"}（与本次导入无关）${tail}`
    );
  }
  return (result.imported > 0 ? `成功导入 ${result.imported} 条记忆` : "未导入任何记忆（可能所有记忆已存在）") + tail;
}

/** 批量「保留为平台级」（M-2 的批量处置入口） */
export async function keepManyAsPlatform(ids: string[]): Promise<{ kept: number; failed: number; message: string }> {
  const service = getMemoryService();
  /*
   * F3（第 188 波复审）：批量动作也要**接确认并如实回执**。
   *
   * 修复前这里只回 `{kept, failed}` 两个数字，`keepAsPlatformPool` 里的失败回执被整个丢掉
   * （调用方看到的只是"N 条失败"），而且**没有任何判据**钉住那两行 flush ——
   * 删掉它们全量仍绿（审计实测）。现在：
   * - 逐条的失败原因**收集并带回**（`failures`），界面能说清是哪一条、为什么；
   * - 循环结束后再 `flushPendingPersist()` 一次：把**整个批次**在途的确认都等完，
   *   并把"库层面到底落没落"作为 `ok` 一并回传（不再是"每条自己说自己成功"）。
   */
  let kept = 0;
  let failed = 0;
  const failures: string[] = [];
  for (const id of ids) {
    const result = await keepAsPlatformPool(id);
    if (result.ok) kept++;
    else {
      failed++;
      if (failures.length < 5) failures.push(result.message);
    }
  }
  const landed = await service.flushPendingPersist();
  const landedNote = landed ? "已确认落库" : `但**未落库**：${service.getLastPersistError() ?? "未知原因"}（重启后这些保留会失效）`;
  return {
    kept,
    failed,
    message:
      `保留为平台级：${kept} 条，${landedNote}` +
      (failed > 0 ? `；${failed} 条没有生效（${failures.join("；")}）` : ""),
  };
}
