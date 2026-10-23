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

function defaultMemoryIndex(projectName: string): string {
  return [
    `# ${projectName} · 记忆索引`,
    "",
    "> 协调者只读这个索引；需要正文时按路径读，不要把整库塞进上下文。",
    "",
    "- `brief.md` — 项目目标/约束/验收",
    "- `reports/` — thread 报告",
    "",
  ].join(String.fromCharCode(10));
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
  const memoryPath = projectStatePath(projectPath, "MEMORY.md");
  if (!(await fileApi.exists(memoryPath))) {
    await writeText(memoryPath, defaultMemoryIndex(projectName), projectPath);
  }
  if (!(await fileApi.exists(projectStatePath(projectPath, "state.json")))) {
    await writeProjectState(projectPath, state);
  }
  return state;
}

export async function setCoordinatorSession(projectPath: string, sessionId: string | null, projectName?: string): Promise<ProjectState> {
  const state = await ensureProjectState(projectPath, projectName);
  const previous = state.coordinatorSessionId;
  state.coordinatorSessionId = sessionId;
  await writeProjectState(projectPath, state);
  await appendProjectEvent(projectPath, {
    at: Date.now(),
    type: sessionId ? "coordinator.assigned" : "coordinator.cleared",
    sessionId: sessionId ?? undefined,
    data: previous && previous !== sessionId ? { replaced: previous } : undefined,
  });
  return state;
}

/** 删除协调者会话时清空指针；不影响其他 thread。 */
export async function clearCoordinatorIfMatches(projectPath: string, sessionId: string): Promise<boolean> {
  const state = await readProjectState(projectPath);
  if (state.coordinatorSessionId !== sessionId) return false;
  state.coordinatorSessionId = null;
  await writeProjectState(projectPath, state);
  await appendProjectEvent(projectPath, { at: Date.now(), type: "coordinator.cleared", sessionId });
  return true;
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

export interface InvalidReport {
  file: string;
  error: string;
}

export interface ReportScan {
  valid: ThreadReport[];
  invalid: InvalidReport[];
}

/**
 * 扫描全部报告，**坏报告不再静默丢弃**：返回 `{valid, invalid}`。
 * 协调者上下文会显示坏报告数量，Overview 也会显示；静态消费方仍可用 `listReports()`。
 */
export async function scanReports(projectPath: string): Promise<ReportScan> {
  const dir = projectStatePath(projectPath, "reports");
  let entries: Array<{ name: string; isDirectory: boolean }> = [];
  try {
    entries = await fileApi.listDirectory(dir);
  } catch {
    return { valid: [], invalid: [] };
  }
  const valid: ThreadReport[] = [];
  const invalid: InvalidReport[] = [];
  for (const entry of entries) {
    if (entry.isDirectory || !entry.name.endsWith(".json")) continue;
    const file = `${dir}/${entry.name}`;
    const parsed = await readJson<unknown>(file, projectPath);
    if (!parsed) {
      invalid.push({ file: entry.name, error: "JSON 解析失败" });
      continue;
    }
    try {
      valid.push(validateThreadReport(parsed));
    } catch (e) {
      invalid.push({ file: entry.name, error: e instanceof Error ? e.message : String(e) });
    }
  }
  valid.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0) || a.report_id.localeCompare(b.report_id));
  return { valid, invalid };
}

export async function listReports(projectPath: string): Promise<ThreadReport[]> {
  return (await scanReports(projectPath)).valid;
}
/**
 * 报告里声明为 log/file 的证据，必须在主工作区真实存在。
 * 返回缺失的 ref；`command` 是命令文本，不做文件存在性判断。
 */
export async function missingEvidenceRefs(projectPath: string, report: ThreadReport): Promise<string[]> {
  const missing: string[] = [];
  for (const ev of report.evidence ?? []) {
    if (ev.kind !== "log" && ev.kind !== "file") continue;
    const ref = ev.ref || "";
    if (!ref || ref.startsWith("/") || /^[A-Za-z]:/.test(ref)) continue;
    const existsOnDisk = await fileApi.exists(`${projectPath.replace(/[\/]+$/, "")}/${ref}`);
    if (!existsOnDisk) missing.push(ev.ref);
  }
  return missing;
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

export interface GateCheck {
  reportId: string;
  gateId: string;
  command?: string;
  ok: boolean;
  reason?: string;
  exitCode?: number;
  outputTail?: string;
  checkedAt: number;
}

export async function readGateChecks(projectPath: string): Promise<GateCheck[]> {
  const parsed = await readJson<{ checks?: GateCheck[] }>(projectStatePath(projectPath, "gate-checks.json"), projectPath);
  return Array.isArray(parsed?.checks) ? parsed!.checks : [];
}

async function writeGateChecks(projectPath: string, checks: GateCheck[]): Promise<void> {
  await writeText(projectStatePath(projectPath, "gate-checks.json"), JSON.stringify({ checks }, null, 2) + String.fromCharCode(10), projectPath);
}

/**
 * 独立重验 gate：只对每 thread 最新报告里 `passed=true` 的 gate 执行。
 * **必须由用户显式触发**（Overview 的「重验 gate」按钮），不在每次读上下文时偷偷跑命令。
 * 没有 `command` 的 gate 记为 no-command（未重验），不能算 done。
 */
export async function verifyProjectGates(
  projectPath: string,
  opts: { timeoutMs?: number } = {}
): Promise<GateCheck[]> {
  const reports = await listReports(projectPath);
  const latestByThread = new Map<string, ThreadReport>();
  for (const r of reports) {
    const prev = latestByThread.get(r.thread_id);
    if (!prev || (r.timestamp ?? 0) >= (prev.timestamp ?? 0)) latestByThread.set(r.thread_id, r);
  }
  const checks: GateCheck[] = [];
  for (const report of latestByThread.values()) {
    for (const gate of report.gates ?? []) {
      if (!gate.passed) continue;
      const base = { reportId: report.report_id, gateId: gate.id, command: gate.command, checkedAt: Date.now() };
      if (!gate.command || !gate.command.trim()) {
        checks.push({ ...base, ok: false, reason: "no-command" });
        continue;
      }
      try {
        const r = await fileApi.executeCommand(gate.command, projectPath, opts.timeoutMs ?? 120000);
        const output = ((r.stdout || "") + String.fromCharCode(10) + (r.stderr || "")).trim();
        checks.push({
          ...base,
          ok: r.exitCode === 0,
          exitCode: r.exitCode,
          outputTail: output.slice(-800),
          reason: r.exitCode === 0 ? undefined : "command-failed",
        });
      } catch (e) {
        checks.push({ ...base, ok: false, reason: e instanceof Error ? e.message : String(e) });
      }
    }
  }
  await writeGateChecks(projectPath, checks);
  return checks;
}

export async function readMemoryIndex(projectPath: string): Promise<string> {
  return (await readText(projectStatePath(projectPath, "MEMORY.md"), projectPath)) ?? "";
}

export async function readBrief(projectPath: string): Promise<string> {
  return (await readText(projectStatePath(projectPath, "brief.md"), projectPath)) ?? "";
}
