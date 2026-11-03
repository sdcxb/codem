/**
 * 桌面远程网关的**文件面**（M3）：`workspace.list` / `workspace.read` / `workspace.diff`。
 *
 * ## 数据从哪来
 *
 * 只有一个根：**桌面当前项目**（`useProjectStore.currentProject.path`）；没有打开项目时
 * 回落到桌面的默认工作区（`get_default_cwd`，与底栏文件树同一个 fallback）。
 * 网关不复制文件、不建第二份工作区、不读桌面 SQLite —— 所有字节都由本文件的
 * `invoke` 注入点交给 Rust 侧读取（`gateway_workspace_*`）。
 *
 * ## 为什么文件读取必须是 Rust 命令，而不是复用 `read_file` / `list_directory`
 *
 * 那两个桌面命令没有工作区边界（`list_directory` 还返回绝对路径、跟随符号链接），
 * 而桌面沙箱**默认关闭** —— 复用它们等于把"用户为本机方便关掉沙箱"变成
 * "手机可读整块磁盘"。所以边界只在 Rust 里判（无条件、与沙箱开关无关），本模块
 * 只负责协议形状、敏感审批与 git。
 *
 * ## 敏感路径：与 Host **同一张规则表**
 *
 * 判定复用 `packages/host/src/sensitive-paths.ts`（`classifySensitivePath`），
 * grant 状态复用 `packages/host/src/sensitive-approvals.ts`（一次性、TTL 5 分钟、
 * 绑定工具+键+文件清单）。本模块不复制规则，只把 Host 的"读取时审批"接到网关上。
 *
 * 两阶段语义与 Host 相同：首次 `APPROVAL_REQUIRED`（**不含正文**）→ 手机
 * `approval.respond` → 带同一个 `approvalId` 重试，消费一次性 grant。
 *
 * ## 只读
 *
 * 没有写文件、没有终端、没有回滚。M3 的协议面也只有这三条。
 */
import {
  buildSensitiveReadDetails,
  classifySensitivePath,
  normalizeWorkspacePath,
  type SensitivePathVerdict,
  type SensitiveRuleId,
} from "../../../packages/host/src/sensitive-paths";
import {
  ApprovalGrantStore,
  SENSITIVE_APPROVAL_MAX_PENDING,
  SENSITIVE_APPROVAL_TTL_MS,
  type SensitiveApprovalGrant,
  type SensitiveApprovalTool,
} from "../../../packages/host/src/sensitive-approvals";
import type {
  SensitiveApprovalRequiredDetails,
  WorkspaceDiffResult,
  WorkspaceListResult,
  WorkspaceReadResult,
} from "../../../packages/protocol/src/index";

/** 网关上"批准后会发生什么"必须说**这条**链路，不能照抄 Host 的"发送给模型"。 */
const GATEWAY_SENSITIVE_READ_NOTICE =
  "批准后文件内容会发送到这台手机（若再贴进对话，也会发给模型服务商）；拒绝则不会读取任何字节。";
const GATEWAY_SENSITIVE_DIFF_NOTICE =
  "批准后这些文件的差异内容会发送到这台手机（若再贴进对话，也会发给模型服务商）；拒绝则不会返回任何 patch。";

/** 单次 diff 的字符上限（超出时截断并明说，不假装完整）。 */
export const GATEWAY_DIFF_MAX_CHARS = 200_000;
/** 目录列表上限（与 Host 同量级；超出静默截断是已知限制）。 */
export const GATEWAY_LIST_MAX_ENTRIES = 500;

export type GatewayWorkspaceErrorKind =
  | "INVALID_PARAMS"
  | "NOT_FOUND"
  | "APPROVAL_REQUIRED"
  | "CONFLICT"
  | "INTERNAL";

/**
 * 文件面失败。
 *
 * `details` 只在 `APPROVAL_REQUIRED` 时出现，形状是协议的
 * `SensitiveApprovalRequiredDetails`（由 `gateway-engine` 放进 `error.data.details`）。
 */
export class GatewayWorkspaceError extends Error {
  constructor(
    readonly kind: GatewayWorkspaceErrorKind,
    message: string,
    readonly details?: SensitiveApprovalRequiredDetails,
    readonly hint?: string,
  ) {
    super(message);
    this.name = "GatewayWorkspaceError";
  }
}

interface GatewayGitResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

/** 桌面注入点：全部显式传入，判据才能在 Node 里构造本服务。 */
export interface GatewayWorkspaceDeps {
  /** Tauri `invoke`（生产由 desktop-engine 传 `window.__TAURI__.core.invoke`）。 */
  invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
  /** 桌面唯一 git 通道（`runGitCommand`；argv 形态，不经 shell）。 */
  runGit: (cwd: string, args: string[]) => Promise<GatewayGitResult>;
  /** 桌面当前项目根；没有打开项目返回 null。 */
  currentProjectPath: () => string | null;
  /** 桌面的默认工作区（`get_default_cwd`）。 */
  defaultWorkspacePath: () => Promise<string>;
  now?: () => number;
}

/** 待批敏感读取（网关本地表；只给桌面读，不注册到桌面审批代理）。 */
interface GatewayPendingApproval {
  requestId: string;
  sessionId: string;
  tool: string;
  preview: string;
  input: Record<string, unknown>;
  status: string;
  revision: number;
}

interface PendingEntry {
  id: string;
  tool: SensitiveApprovalTool;
  summary: string;
  details: Record<string, unknown>;
  grant: SensitiveApprovalGrant;
  expiresAt: number;
}

type GatewayApprovalResponse =
  | { handled: false }
  | { handled: true; ok: true }
  | { handled: true; ok: false; message: string };

export interface GatewayWorkspaceService {
  list(path: string): Promise<WorkspaceListResult>;
  read(path: string, offset: number, limit: number, approvalId?: string): Promise<WorkspaceReadResult>;
  diff(path: string, base: string, approvalId?: string): Promise<WorkspaceDiffResult>;
  /** 当前根（只用于 `host.diagnostics`；解析失败返回 null）。 */
  root(): Promise<string | null>;
  /** 网关本地的待批敏感读取（合并进 `approval.list`）。 */
  listPendingApprovals(): GatewayPendingApproval[];
  /** 答复网关本地审批；`handled:false` = 不是网关的文件审批（交给桌面代理）。 */
  respondApproval(approvalId: string, decision: "allow" | "deny"): GatewayApprovalResponse;
}

const MAX_PATH_CHARS = 1024;
const MAX_APPROVAL_ID_CHARS = 128;
const DEFAULT_READ_LIMIT = 200_000;
const MAX_READ_LIMIT = 2_000_000;
const MAX_OFFSET = 10_000_000;
const BASE_RE = /^[A-Za-z0-9._~^/-]+$/;

function newApprovalId(): string {
  return `appr-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function errorText(e: unknown): string {
  if (typeof e === "string") return e;
  const message = (e as { message?: unknown })?.message;
  return typeof message === "string" ? message : String(e);
}

/**
 * Tauri 侧错误 → 协议错误。
 *
 * Rust 只回稳定前缀（`E_WORKSPACE_*`），文案里**不含绝对路径**；这里也不把原始
 * 错误拼进去（`Err(String)` 可能带 OS 路径）。
 */
function fromInvokeError(e: unknown): GatewayWorkspaceError {
  const text = errorText(e);
  if (text.includes("E_WORKSPACE_ROOT")) {
    return new GatewayWorkspaceError(
      "NOT_FOUND",
      "桌面没有可用的工作区目录（项目可能已被移动或删除）",
      undefined,
      "请在桌面重新打开项目，或确认默认工作区存在",
    );
  }
  if (text.includes("E_WORKSPACE_PATH")) {
    return new GatewayWorkspaceError(
      "INVALID_PARAMS",
      "路径不在工作区内（只接受工作区相对路径）",
      undefined,
      "绝对路径、盘符、.. 与符号链接逃逸都会被拒绝",
    );
  }
  if (text.includes("E_WORKSPACE_TARGET")) {
    return new GatewayWorkspaceError(
      "NOT_FOUND",
      "文件或目录不存在，或已不是原来的类型（可能刚被移动/替换）",
      undefined,
      "刷新文件列表后重试",
    );
  }
  return new GatewayWorkspaceError(
    "INTERNAL",
    "读取桌面工作区失败",
    undefined,
    "请确认桌面仍在运行且项目目录可读",
  );
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new GatewayWorkspaceError("INVALID_PARAMS", `${field} 必须是字符串`);
  }
  return value;
}

/**
 * 工作区相对路径归一化 + 词法拒绝。
 *
 * Rust 侧还会再判一次（它才是边界）；这里先拒绝是为了让手机立刻拿到
 * `INVALID_PARAMS`，而不是先跑一趟 IPC。
 */
function normalizeRequestPath(raw: unknown, allowRoot: boolean): string {
  const value = requireString(raw, "path");
  if (value.length > MAX_PATH_CHARS) {
    throw new GatewayWorkspaceError("INVALID_PARAMS", `path 过长（>${MAX_PATH_CHARS}）`);
  }
  if (value.includes("\u0000") || value.includes("\n") || value.includes("\r")) {
    throw new GatewayWorkspaceError("INVALID_PARAMS", "path 不能包含 NUL/换行");
  }
  const posix = value.replace(/\\/g, "/");
  if (posix.startsWith("/") || posix.startsWith("//") || /^[A-Za-z]:/.test(posix)) {
    throw new GatewayWorkspaceError("INVALID_PARAMS", "path 必须是工作区相对路径");
  }
  const parts = posix.split("/").filter((part) => part.length > 0 && part !== ".");
  if (parts.some((part) => part === "..")) {
    throw new GatewayWorkspaceError("INVALID_PARAMS", "path 不能包含 ..");
  }
  // Windows 备用数据流（`file.txt:secret`）不是普通文件路径；Rust 侧同样拒绝。
  if (parts.some((part) => part.includes(":"))) {
    throw new GatewayWorkspaceError("INVALID_PARAMS", "path 不能包含冒号");
  }
  const rel = parts.join("/");
  if (!rel && !allowRoot) {
    throw new GatewayWorkspaceError("INVALID_PARAMS", "path 必填（不能是工作区根）");
  }
  return rel;
}

function clampOffset(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(n)) return 0;
  return Math.min(MAX_OFFSET, Math.max(0, Math.trunc(n)));
}

function clampLimit(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(n)) return DEFAULT_READ_LIMIT;
  return Math.min(MAX_READ_LIMIT, Math.max(1, Math.trunc(n)));
}

/** git 基线：只接受保守字符集，且不许以 `-` 开头（避免被当成选项）。 */
function normalizeGitBase(raw: unknown): string {
  if (raw === undefined || raw === null || raw === "") return "HEAD";
  if (typeof raw !== "string") {
    throw new GatewayWorkspaceError("INVALID_PARAMS", "base 必须是字符串");
  }
  const base = raw.trim();
  if (!base || base.length > 128 || !BASE_RE.test(base) || base.startsWith("-")) {
    throw new GatewayWorkspaceError(
      "INVALID_PARAMS",
      "base 不是合法的 git 基线（只接受分支/标签/提交号）",
    );
  }
  return base;
}

function normalizeChangedPath(line: string): string {
  return normalizeWorkspacePath(line);
}

function sensitiveFilesOf(paths: string[]): {
  denied: string[];
  sensitive: string[];
  rules: SensitiveRuleId[];
} {
  const denied = new Set<string>();
  const sensitive = new Set<string>();
  const rules = new Set<SensitiveRuleId>();
  for (const raw of paths) {
    const rel = normalizeChangedPath(raw);
    if (!rel) continue;
    const verdict: SensitivePathVerdict | null = classifySensitivePath(rel);
    if (!verdict || verdict.action === "allow") continue;
    if (verdict.action === "deny") denied.add(rel);
    else {
      sensitive.add(rel);
      rules.add(verdict.rule);
    }
  }
  return { denied: [...denied], sensitive: [...sensitive], rules: [...rules] };
}

function describeLabels(files: string[]): string {
  const labels = new Set<string>();
  for (const f of files) {
    const v = classifySensitivePath(f);
    if (v) labels.add(v.label);
  }
  return [...labels].join("、");
}

/**
 * 新建只读文件面。生产依赖由 `desktop-engine` 注入；判据直接构造本服务。
 */
export function createGatewayWorkspace(deps: GatewayWorkspaceDeps): GatewayWorkspaceService {
  const now = deps.now ?? Date.now;
  const grants = new ApprovalGrantStore(now);
  const pending = new Map<string, PendingEntry>();

  function prunePending(): void {
    const current = now();
    for (const [id, entry] of pending) {
      if (entry.expiresAt <= current) pending.delete(id);
    }
  }

  function registerApproval(
    tool: SensitiveApprovalTool,
    summary: string,
    details: Record<string, unknown>,
    grant: SensitiveApprovalGrant,
  ): never {
    prunePending();
    while (pending.size >= SENSITIVE_APPROVAL_MAX_PENDING) {
      const oldest = pending.keys().next();
      if (oldest.done) break;
      pending.delete(oldest.value);
      grants.delete(oldest.value);
    }
    const approvalId = newApprovalId();
    const expiresAt = now() + SENSITIVE_APPROVAL_TTL_MS;
    pending.set(approvalId, { id: approvalId, tool, summary, details, grant, expiresAt });
    const data: SensitiveApprovalRequiredDetails = {
      approvalRequired: true,
      approvalId,
      tool,
      summary,
      details: details as SensitiveApprovalRequiredDetails["details"],
      expiresAt,
    };
    throw new GatewayWorkspaceError("APPROVAL_REQUIRED", summary, data);
  }

  async function resolveRoot(): Promise<string> {
    const current = String(deps.currentProjectPath() ?? "").trim();
    if (current) return current;
    const fallback = String((await deps.defaultWorkspacePath()) ?? "").trim();
    if (fallback) return fallback;
    throw new GatewayWorkspaceError(
      "NOT_FOUND",
      "桌面没有打开项目，也没有可用的默认工作区",
      undefined,
      "请在桌面打开一个项目",
    );
  }

  async function invokeList(workspace: string, path: string): Promise<unknown> {
    try {
      return await deps.invoke<unknown>("gateway_workspace_list", { workspace, path });
    } catch (e) {
      throw fromInvokeError(e);
    }
  }

  async function stat(workspace: string, path: string): Promise<{ rel: string; size: number; kind: string }> {
    let got: unknown;
    try {
      got = await deps.invoke<unknown>("gateway_workspace_stat", { workspace, path });
    } catch (e) {
      throw fromInvokeError(e);
    }
    const record = (got ?? {}) as Record<string, unknown>;
    return {
      rel: typeof record.rel === "string" ? record.rel : "",
      size: typeof record.size === "number" ? record.size : 0,
      kind: typeof record.kind === "string" ? record.kind : "other",
    };
  }

  async function invokeRead(
    workspace: string,
    path: string,
    rel: string,
    offset: number,
    limit: number,
  ): Promise<WorkspaceReadResult> {
    try {
      return await deps.invoke<WorkspaceReadResult>("gateway_workspace_read", {
        workspace,
        path,
        expectRel: rel,
        offset,
        limit,
      });
    } catch (e) {
      throw fromInvokeError(e);
    }
  }

  async function runGit(cwd: string, args: string[]): Promise<GatewayGitResult> {
    try {
      return await deps.runGit(cwd, args);
    } catch {
      throw new GatewayWorkspaceError(
        "CONFLICT",
        "无法运行 git（可能未安装或工作区不可访问）",
        undefined,
        "请确认桌面环境里有 git；非 git 工作区不提供 diff",
      );
    }
  }

  function requireRepo(check: GatewayGitResult): boolean {
    if (check.exitCode === 124) {
      throw new GatewayWorkspaceError(
        "CONFLICT",
        "读取 git 状态超时（工作区可能过大或磁盘忙）",
        undefined,
        "稍后重试；或缩小到具体文件再查看差异",
      );
    }
    return (check.exitCode ?? -1) === 0 && check.stdout.trim() === "true";
  }

  async function readImpl(
    path: string,
    offsetRaw: unknown,
    limitRaw: unknown,
    approvalId?: string,
  ): Promise<WorkspaceReadResult> {
    const pathArg = normalizeRequestPath(path, false);
    const offset = clampOffset(offsetRaw);
    const limit = clampLimit(limitRaw);
    const root = await resolveRoot();
    const info = await stat(root, pathArg);
    if (info.kind !== "file") {
      throw new GatewayWorkspaceError("INVALID_PARAMS", "只能预览普通文件");
    }
    const verdict = classifySensitivePath(info.rel);
    if (verdict) {
      if (verdict.action === "deny") {
        throw new GatewayWorkspaceError(
          "INVALID_PARAMS",
          `不允许读取应用内部产物：${info.rel}`,
          undefined,
          "该目录由 Codem 自动生成，不是项目内容；请从项目文件里取值",
        );
      }
      if (verdict.action === "ask") {
        const grant = approvalId
          ? grants.consume(approvalId, "workspace.read", info.rel)
          : null;
        if (!grant || !grant.files.includes(info.rel)) {
          registerApproval(
            "workspace.read",
            `读取敏感文件 ${info.rel}（${verdict.label}）—— 批准后内容会发送到这台手机`,
            {
              // 覆盖 Host builder 的 notice：这条链路的接收方是手机，不是模型。
              ...buildSensitiveReadDetails(info.rel, verdict),
              notice: GATEWAY_SENSITIVE_READ_NOTICE,
            },
            { tool: "workspace.read", key: info.rel, files: [info.rel] },
          );
        }
      }
    }
    // expectRel：Rust 读之前会再 resolve 一次并比对；不一致 = stat 之后目标被换掉了。
    return invokeRead(root, pathArg, info.rel, offset, limit);
  }

  /**
   * 未跟踪的新文件在 `git diff HEAD -- <path>` 里永远是空的。
   * 空 patch 会被界面画成"没有改动"（假事实），所以按文件内容合成一个
   * 只有新增行的 unified patch；二进制 / 读不出文本时如实 `supported:false + reason`。
   */
  async function synthesizeUntrackedPatch(
    root: string,
    rel: string,
  ): Promise<{ patch: string; supported: boolean; reason?: string }> {
    // 敏感判定已经在调用方做过（未跟踪文件也在 union 清单里）；这里只是读内容。
    let got: WorkspaceReadResult;
    try {
      got = await invokeRead(root, rel, rel, 0, GATEWAY_DIFF_MAX_CHARS);
    } catch (e) {
      const mapped = e instanceof GatewayWorkspaceError ? e : fromInvokeError(e);
      return { patch: "", supported: false, reason: mapped.message };
    }
    if (got.encoding === "binary") {
      return { patch: "", supported: false, reason: "该文件是二进制（或非 UTF-8）新文件，无法显示文本差异。" };
    }
    const text = String(got.text ?? "");
    const lines = text.length === 0 ? [] : text.split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    const normalized = lines.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
    const body = normalized.map((line) => `+${line}`).join("\n");
    const header =
      `diff --git a/${rel} b/${rel}\n` +
      "new file mode 100644\n" +
      "--- /dev/null\n" +
      `+++ b/${rel}\n` +
      `@@ -0,0 +1,${normalized.length} @@`;
    const trailer = !text.endsWith("\n") && normalized.length > 0 ? "\n\\ No newline at end of file" : "";
    const patch = `${header}${body ? `\n${body}` : ""}${trailer}\n`;
    if (got.truncated || patch.length > GATEWAY_DIFF_MAX_CHARS) {
      return {
        patch: patch.slice(0, GATEWAY_DIFF_MAX_CHARS),
        supported: true,
        reason: "文件较大，差异只显示前 200,000 字符；完整内容请在桌面查看。",
      };
    }
    return { patch, supported: true };
  }

  async function diffImpl(path: string, baseRaw: unknown, approvalId?: string): Promise<WorkspaceDiffResult> {
    const pathArg = normalizeRequestPath(path, true);
    const base = normalizeGitBase(baseRaw);
    const root = await resolveRoot();
    const info = await stat(root, pathArg);
    /*
     * git 和敏感判定都按**真实目标**（解析符号链接之后）的路径：
     * 否则 `notes.txt -> .env` 这类别名会用"普通文件名"绕过敏感规则。
     */
    const targetPath = info.rel;

    const repo = await runGit(root, ["rev-parse", "--is-inside-work-tree"]);
    if (!requireRepo(repo)) {
      return { path: targetPath || ".", diff: "", supported: false };
    }

    const gitPathArgs = targetPath ? ["--", targetPath] : [];
    const changedNamesResult = await runGit(root, [
      "--no-pager",
      // 文件名里的 `[` / `*` 不是 git 通配符：路径已经过真实 stat，必须按字面匹配。
      "--literal-pathspecs",
      // 只读：不要让 git 为了刷新 stat 信息去写 index。
      "--no-optional-locks",
      "diff",
      "--name-only",
      "--no-renames",
      "-z",
      base,
      ...gitPathArgs,
    ]);
    if ((changedNamesResult.exitCode ?? -1) !== 0) {
      throw new GatewayWorkspaceError(
        "CONFLICT",
        "无法读取 git 变更清单（基线可能不存在，或工作区不可访问）",
        undefined,
        "确认 base 是有效的分支/标签/提交号后重试",
      );
    }
    const changed = changedNamesResult.stdout.split("\u0000").filter(Boolean);

    /**
     * 未跟踪的新文件不在 `git diff` 里；单独列出来，既用于敏感预检，
     * 也用于"不能把空 patch 画成没有改动"。
     */
    const untrackedResult = await runGit(root, [
      "--literal-pathspecs",
      "--no-optional-locks",
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
      ...(targetPath ? ["--", targetPath] : []),
    ]);
    const untracked = (untrackedResult.exitCode ?? -1) === 0
      ? untrackedResult.stdout.split("\u0000").filter(Boolean)
      : [];

    const untrackedRel = untracked.map(normalizeChangedPath);
    const changedRel = changed.map(normalizeChangedPath);
    const targetIsFile = Boolean(targetPath) && info.kind === "file";
    let untrackedOrIgnored = untrackedRel.includes(targetPath);
    /*
     * `--others --exclude-standard` 不含被忽略的文件（`.env` 就是典型）。
     * 文件确实存在、又不在 changed 里时，用 `ls-files --error-unmatch` 区分
     * "已跟踪但没改"（diff 为空是正确事实）与"未跟踪/被忽略"（要合成 patch）。
     */
    if (targetIsFile && !changedRel.includes(targetPath) && !untrackedOrIgnored) {
      const trackedProbe = await runGit(root, [
        "--literal-pathspecs",
        "--no-optional-locks",
        "ls-files",
        "--error-unmatch",
        "--",
        targetPath,
      ]);
      if ((trackedProbe.exitCode ?? -1) !== 0) untrackedOrIgnored = true;
    }

    /*
     * 目标文件本身也要参与敏感预检：`.env` 常常被 gitignore（不在 changed，
     * 也不在 `--others --exclude-standard` 里），不能因为 git 不认它就不审批。
     * 已跟踪且**没有改动**的目标不必审批：这次 diff 一定是空的，没有内容可读。
     */
    const targetInDiff =
      targetIsFile && (changedRel.includes(targetPath) || untrackedOrIgnored);
    const scan = sensitiveFilesOf([
      ...changed,
      ...untracked,
      ...(targetInDiff ? [targetPath] : []),
    ]);
    if (scan.denied.length > 0) {
      throw new GatewayWorkspaceError(
        "INVALID_PARAMS",
        `不允许查看应用内部产物的差异：${scan.denied.join(", ")}`,
        undefined,
        "该目录由 Codem 自动生成，不是项目内容",
      );
    }
    if (scan.sensitive.length > 0) {
      const key = `${targetPath || "."}|${base}`;
      const grant = approvalId ? grants.consume(approvalId, "workspace.diff", key) : null;
      const covered = Boolean(grant && scan.sensitive.every((file) => grant.files.includes(file)));
      if (!covered) {
        const labelText = describeLabels(scan.sensitive);
        const summary =
          `查看差异时将读取 ${scan.sensitive.length} 个敏感文件` +
          (labelText ? `（${labelText}）` : "") +
          " —— 批准后内容会发送到这台手机";
        registerApproval(
          "workspace.diff",
          summary,
          {
            path: targetPath || ".",
            base,
            files: scan.sensitive.slice(0, 10),
            fileCount: scan.sensitive.length,
            truncated: scan.sensitive.length > 10,
            rules: scan.rules,
            scope: "shared-desktop-workspace",
            notice: GATEWAY_SENSITIVE_DIFF_NOTICE,
          },
          { tool: "workspace.diff", key, files: scan.sensitive },
        );
      }
    }

    if (targetIsFile && !changedRel.includes(targetPath) && untrackedOrIgnored) {
      const synthesized = await synthesizeUntrackedPatch(root, targetPath);
      return {
        path: targetPath,
        diff: synthesized.patch,
        supported: synthesized.supported,
        ...(synthesized.reason ? { reason: synthesized.reason } : {}),
      };
    }

    const result = await runGit(root, [
      "--no-pager",
      "--literal-pathspecs",
      "--no-optional-locks",
      "diff",
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      base,
      ...gitPathArgs,
    ]);
    if ((result.exitCode ?? -1) !== 0) {
      throw new GatewayWorkspaceError(
        "CONFLICT",
        "读取差异失败（git 退出码非 0）",
        undefined,
        "请确认基线有效、工作区可访问；完整错误请在桌面查看",
      );
    }
    const raw = result.stdout;
    if (raw.length > GATEWAY_DIFF_MAX_CHARS) {
      return {
        path: targetPath || ".",
        diff: raw.slice(0, GATEWAY_DIFF_MAX_CHARS),
        supported: true,
        reason: "差异较大，只显示前 200,000 字符；完整内容请在桌面查看。",
      };
    }
    return { path: targetPath || ".", diff: raw, supported: true };
  }

  return {
    async list(path) {
      const pathArg = normalizeRequestPath(path ?? ".", true);
      const root = await resolveRoot();
      const raw = await invokeList(root, pathArg);
      if (!Array.isArray(raw)) {
        // 形状不对 ≠ 空目录：伪装成空列表会让用户以为项目里没有文件。
        throw new GatewayWorkspaceError("INTERNAL", "桌面返回了无法识别的目录列表");
      }
      const entries = (raw as Array<Record<string, unknown>>)
        .map((entry) => {
          const name = typeof entry.name === "string" ? entry.name : "";
          const type = entry.type === "dir" ? "dir" : entry.type === "file" ? "file" : null;
          if (!name || !type) return null;
          const size = typeof entry.size === "number" ? entry.size : undefined;
          return { name, type, ...(size !== undefined ? { size } : {}) } as const;
        })
        .filter((entry): entry is { name: string; type: "file" | "dir"; size?: number } => Boolean(entry))
        .slice(0, GATEWAY_LIST_MAX_ENTRIES);
      return { path: pathArg, entries };
    },

    read(path, offset, limit, approvalId) {
      return readImpl(path, offset, limit, approvalId);
    },

    diff(path, base, approvalId) {
      return diffImpl(path, base, approvalId);
    },

    async root() {
      try {
        return await resolveRoot();
      } catch {
        return null;
      }
    },

    listPendingApprovals() {
      prunePending();
      return [...pending.values()].map((entry) => ({
        requestId: entry.id,
        // 工作区读取不属于任何会话（与 Host 的 sessionId:"" 同一语义）。
        sessionId: "",
        tool: entry.tool,
        preview: entry.summary,
        input: entry.details,
        status: "open",
        revision: 0,
      }));
    },

    respondApproval(approvalId, decision) {
      if (!approvalId || approvalId.length > MAX_APPROVAL_ID_CHARS) return { handled: false };
      /*
       * 先按 id 找，再判过期：过期项要回"已过期"，而不是伪装成"不是我的审批"
       * （后者会让桌面代理再查一遍，最后得到一句含糊的"已处理或已失效"）。
       */
      const entry = pending.get(approvalId);
      if (!entry) return { handled: false };
      pending.delete(approvalId);
      if (entry.expiresAt <= now()) {
        grants.delete(approvalId);
        return { handled: true, ok: false, message: "这个文件读取审批已过期，请重新发起读取" };
      }
      if (decision === "allow") {
        const remaining = Math.max(1_000, Math.min(SENSITIVE_APPROVAL_TTL_MS, entry.expiresAt - now()));
        grants.grant(approvalId, entry.grant, remaining);
      }
      return { handled: true, ok: true };
    },
  };
}
