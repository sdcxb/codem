import * as fileApi from "../../file-api";
import { validateThreadReport } from "./report-contract";
import type {
  ProjectEvent,
  ProjectState,
  ProjectThread,
  ProjectThreadStatus,
  ThreadReport,
} from "./types";

/**
 * 项目状态落盘（P0）。
 *
 * 目录（相对于项目根，可人工检查/提交）：
 * ```
 * .codem/project/
 *   state.json         协调者会话 id + thread registry
 *   brief.md           项目 brief（协调者每次重建都读）
 *   gates.json         验收门禁
 *   events.jsonl       不可变事件流（追加）
 *   reports/<id>.json  thread 报告（v3.1）
 * ```
 * 所有 I/O 都带 `workspace: projectPath`，走已有的沙箱判定；状态文件不是隐藏内存，
 * 用户随时可以打开看、改、删。
 */

const PROJECT_SUBDIR = ".codem/project";

export function projectStateDir(projectPath: string): string {
  return `${projectPath.replace(/[\\/]+$/, "")}/${PROJECT_SUBDIR}`;
}

export function projectStatePath(projectPath: string, name: string): string {
  return `${projectStateDir(projectPath)}/${name}`;
}

function defaultState(): ProjectState {
  return { version: 1, coordinatorSessionId: null, threads: [], updatedAt: Date.now() };
}

function defaultBrief(projectName: string): string {
  return [
    `# ${projectName} · 项目 brief`,
    "",
    "> 这是协调者每次重建上下文时读的项目 brief。写目标、约束、验收，不写聊天记录。",
    "",
    "## 目标",
    "",
    "（待填）",
    "",
    "## 约束",
    "",
    "（待填）",
    "",
    "## 验收",
    "",
    "（待填）",
    "",
  ].join("\n");
}

async function readText(path: string, workspace: string): Promise<string | null> {
  try {
    return await fileApi.readFile(path, { workspace });
  } catch {
    return null;
  }
}

async function readJson<T>(path: string, workspace: string): Promise<T | null> {
  const text = await readText(path, workspace);
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

async function writeText(path: string, content: string, workspace: string): Promise<void> {
  await fileApi.writeFile(path, content, { workspace });
}

/** 读取项目状态；不存在时返回默认值（不落盘）。 */
export async function readProjectState(projectPath: string): Promise<ProjectState> {
  const state = await readJson<ProjectState>(projectStatePath(projectPath, "state.json"), projectPath);
  if (!state || state.version !== 1) return defaultState();
  return {
    version: 1,
    coordinatorSessionId: typeof state.coordinatorSessionId === "string" ? state.coordinatorSessionId : null,
    threads: Array.isArray(state.threads) ? state.threads.filter((t) => t && typeof t.sessionId === "string") : [],
    updatedAt: typeof state.updatedAt === "number" ? state.updatedAt : Date.now(),
  };
}

export async function writeProjectState(projectPath: string, state: ProjectState): Promise<void> {
  await writeText(
    projectStatePath(projectPath, "state.json"),
    JSON.stringify({ ...state, updatedAt: Date.now() }, null, 2) + "\n",
    projectPath
  );
}

/** 确保目录与 brief 存在；返回当前状态。 */
export async function ensureProjectState(projectPath: string, projectName = "Project"): Promise<ProjectState> {
  const state = await readProjectState(projectPath);
  const briefPath = projectStatePath(projectPath, "brief.md");
  if (!(await fileApi.exists(briefPath))) {
    await writeText(briefPath, defaultBrief(projectName), projectPath);
  }
  if (!(await fileApi.exists(projectStatePath(projectPath, "state.json")))) {
    await writeProjectState(projectPath, state);
  }
  return state;
}

export async function setCoordinatorSession(projectPath: string, sessionId: string | null, projectName?: string): Promise<ProjectState> {
  const state = await ensureProjectState(projectPath, projectName);
  state.coordinatorSessionId = sessionId;
  await writeProjectState(projectPath, state);
  await appendProjectEvent(projectPath, {
    at: Date.now(),
    type: sessionId ? "coordinator.assigned" : "coordinator.cleared",
    sessionId: sessionId ?? undefined,
  });
  return state;
}

export async function registerThread(
  projectPath: string,
  thread: { sessionId: string; title: string; worktreePath?: string; status?: ProjectThreadStatus }
): Promise<ProjectThread> {
  const state = await ensureProjectState(projectPath);
  const now = Date.now();
  const existing = state.threads.find((t) => t.sessionId === thread.sessionId);
  const next: ProjectThread = existing
    ? { ...existing, title: thread.title, worktreePath: thread.worktreePath ?? existing.worktreePath, status: thread.status ?? existing.status, updatedAt: now }
    : {
        sessionId: thread.sessionId,
        title: thread.title,
        status: thread.status ?? "idle",
        worktreePath: thread.worktreePath,
        createdAt: now,
        updatedAt: now,
      };
  state.threads = existing
    ? state.threads.map((t) => (t.sessionId === thread.sessionId ? next : t))
    : [...state.threads, next];
  await writeProjectState(projectPath, state);
  return next;
}

export async function listReports(projectPath: string): Promise<ThreadReport[]> {
  const dir = projectStatePath(projectPath, "reports");
  let entries: Array<{ name: string; isDirectory: boolean }> = [];
  try {
    entries = await fileApi.listDirectory(dir);
  } catch {
    return [];
  }
  const reports: ThreadReport[] = [];
  for (const entry of entries) {
    if (entry.isDirectory || !entry.name.endsWith(".json")) continue;
    const parsed = await readJson<unknown>(`${dir}/${entry.name}`, projectPath);
    if (!parsed) continue;
    try {
      reports.push(validateThreadReport(parsed));
    } catch {
      // 坏报告不能静默当成好报告；context 里会有 unknown 计数（见 buildCoordinatorContext）
    }
  }
  return reports.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0) || a.report_id.localeCompare(b.report_id));
}

/**
 * 写入一份 thread 报告：先校验，再落盘，再更新 thread registry，最后追加事件。
 * 校验失败**不写任何东西**。
 */
export async function writeThreadReport(
  projectPath: string,
  input: unknown,
  opts: { title?: string; worktreePath?: string } = {}
): Promise<ThreadReport> {
  const report = validateThreadReport(input);
  const stamped: ThreadReport = { ...report, timestamp: report.timestamp ?? Date.now() };
  const dir = projectStatePath(projectPath, "reports");
  await writeText(`${dir}/${stamped.report_id}.json`, JSON.stringify(stamped, null, 2) + "\n", projectPath);

  const state = await ensureProjectState(projectPath);
  const status: ProjectThreadStatus =
    stamped.status === "done" ? "done" :
    stamped.status === "blocked" ? "blocked" :
    stamped.status === "failed" ? "failed" : "working";
  const existing = state.threads.find((t) => t.sessionId === stamped.thread_id);
  const now = Date.now();
  const thread: ProjectThread = existing
    ? { ...existing, status, lastReportId: stamped.report_id, updatedAt: now }
    : {
        sessionId: stamped.thread_id,
        title: opts.title ?? stamped.thread_id,
        status,
        worktreePath: opts.worktreePath,
        createdAt: now,
        updatedAt: now,
        lastReportId: stamped.report_id,
      };
  state.threads = existing
    ? state.threads.map((t) => (t.sessionId === stamped.thread_id ? thread : t))
    : [...state.threads, thread];
  await writeProjectState(projectPath, state);
  await appendProjectEvent(projectPath, {
    at: now,
    type: "report.written",
    sessionId: stamped.thread_id,
    data: { reportId: stamped.report_id, status: stamped.status },
  });
  return stamped;
}

export async function appendProjectEvent(projectPath: string, event: ProjectEvent): Promise<void> {
  try {
    await fileApi.appendFile(
      projectStatePath(projectPath, "events.jsonl"),
      JSON.stringify(event) + "\n"
    );
  } catch {
    // 事件是辅助追溯，不阻断报告/状态写入；但调用方可以从 state/report 回读事实。
  }
}

export interface ProjectGate {
  id: string;
  title: string;
  passed: boolean;
  verified_by: "command" | "manual" | "none";
  evidence_ref?: string;
  updatedAt: number;
}

export async function registerGate(projectPath: string, gate: Omit<ProjectGate, "updatedAt">): Promise<ProjectGate> {
  const path = projectStatePath(projectPath, "gates.json");
  const current = (await readJson<{ gates?: ProjectGate[] }>(path, projectPath))?.gates ?? [];
  const next: ProjectGate = { ...gate, updatedAt: Date.now() };
  const gates = current.some((g) => g.id === gate.id)
    ? current.map((g) => (g.id === gate.id ? next : g))
    : [...current, next];
  await writeText(path, JSON.stringify({ gates }, null, 2) + "\n", projectPath);
  return next;
}

export async function readGates(projectPath: string): Promise<ProjectGate[]> {
  const parsed = await readJson<{ gates?: ProjectGate[] }>(projectStatePath(projectPath, "gates.json"), projectPath);
  return Array.isArray(parsed?.gates) ? parsed!.gates : [];
}

export async function readBrief(projectPath: string): Promise<string> {
  return (await readText(projectStatePath(projectPath, "brief.md"), projectPath)) ?? "";
}
