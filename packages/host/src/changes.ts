/**
 * `session.changes` / `session.change.diff` 的**业务实现**（与 HTTP 面解耦，可单测）。
 *
 * ## 数据从哪来（由调用方注入，服务本身不选数据面）
 *
 * 同一份实现被两个宿主复用，**数据面各不相同**：
 *
 * - 手机本机 Host：自己的数据根 / SQLite / 工作区（Android 侧 `HostSupervisor`
 *   拉起时给 `--data-home` / `--workspace`）。手机看到的是**经 Host 跑过的回合**的
 *   变更记录，不是桌面渲染进程自己库里那份。桌面 Host sidecar 已随 ADR-0005 M4 退役；
 * - 桌面网关（ADR-0005 M3）：桌面渲染进程的 `turn_file_changes`（`FileChangeStorage`）
 *   与桌面当前会话的工作区。手机看到的就是**桌面那份记录**，网关不建第二份。
 *
 * 本服务只认注入的 `queryPage` / `getById` / `workspaceFor`，不 import 任何进程的库。
 *
 * ## 首版只读（明确不做）
 *
 * - **不回滚**：`turn_file_changes` 里有 tree + patch，数据够，但回滚要审批 + 残留上报 +
 *   写租约，单独一步；本版不暴露方法，客户端能力位 `revert=false`（按钮不出现）。
 * - **不读 `checks`**：验证检查是**按会话**的设置面记录，不绑定这一轮，且不在本表；
 *   下发它等于把"最近检查"伪装成"本轮检查"。
 * - **不读 `patch` 列**：单行上限 500,000 字符，且可能是占位串；列表只读投影列，
 *   单文件 diff 用 before/after tree **现算**（200KB 封顶）。
 */
import type {
  SessionChangesResult,
  SessionChangeDiffResult,
  TurnChangesView,
} from "../../protocol/src/index";

import { HostError } from "./errors";
import type { TurnFileChangeRecord } from "../../../src/core/storage/file-change-storage";
import {
  parseChangedFilesResult,
  toTurnChangesView,
} from "../../../src/core/storage/file-change-storage";

/** Host 列表单页上限（客户端协议层再按 1..50 收窄；这里是服务端硬上限） */
export const HOST_CHANGES_PAGE_MAX = 50;

/** 单文件 diff 的字符上限（与桌面 `WorkspaceDiffPane` 的展示口径同量级） */
export const HOST_CHANGE_DIFF_MAX_CHARS = 200_000;

export interface ChangesServiceDeps {
  sessionExists: (sessionId: string) => Promise<boolean>;
  queryPage: (
    sessionId: string,
    offset: number,
    limit: number,
  ) => Promise<{ items: TurnFileChangeRecord[]; hasMore: boolean }>;
  getById: (id: string) => Promise<TurnFileChangeRecord | null>;
  /**
   * 该会话的**工作区根**：记录里的 before/after 树对象所在的 git 仓库。
   *
   * 为什么要按会话取：桌面网关要服务**所有项目**的会话（`session.list` 就是
   * 全项目的），worktree 会话的 cwd 也不是项目根。用一个固定的"当前项目根"去
   * `cat-file` 会把别的仓库的记录误判成"对象缺失"。
   *
   * `null` = 会话没有可用工作目录（项目被移动/删除），由调用方如实降级。
   */
  workspaceFor: (sessionId: string) => Promise<string | null>;
  /** 该工作区是否是 git 仓库（非 git / 没装 git ⇒ false，不抛） */
  isGitWorkspace: (workspace: string) => Promise<boolean>;
  /** 在**该工作区**跑一条 git（argv，经宿主唯一命令通道） */
  runGit: (
    workspace: string,
    args: string[],
  ) => Promise<{ stdout: string; stderr: string; exitCode: number | null }>;
  /**
   * 共享桌面工作区下判定"这个路径是否敏感"（`sensitive-paths.ts` 的判定）。
   *
   * 提供时，`diff()` 对敏感文件**硬拒绝**（`supported:false + reason`，不返回 patch）：
   * 变更记录是第三个内容出口，若不收口，`workspace.diff` 的审批就能被绕过
   * （bash 改过 `.env` ⇒ 这里直接拿到 patch）。审批卡不适用于它：记录可能来自很久以前，
   * 用户也说不清"当时的 diff 现在还要不要看"，直接不给比"批准后给旧内容"更安全。
   */
  isSensitivePath?: (path: string) => boolean;
}

export interface ChangesService {
  list(sessionId: string, offset?: number, limit?: number): Promise<SessionChangesResult>;
  diff(sessionId: string, changeId: string, path: string): Promise<SessionChangeDiffResult>;
}

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  const n = Number.isFinite(value) ? Math.trunc(value as number) : fallback;
  return Math.min(max, Math.max(min, n));
}

function normalizePath(p: string): string {
  return p.split("\\").join("/");
}

function isSafeRelativePath(p: string): boolean {
  if (!p || p.length > 1024) return false;
  if (p.includes("\u0000") || p.includes("\n") || p.includes("\r")) return false;
  if (/^[A-Za-z]:[\\/]/.test(p) || p.startsWith("/") || p.startsWith("\\")) return false;
  const parts = normalizePath(p).split("/");
  return parts.every((part) => part !== ".." && part !== ".");
}

function treeRef(value: string | null): string | null {
  const ref = String(value ?? "").trim();
  if (!ref) return null;
  // `git stash create` 给的是 40/64 位对象名；只接受对象名，拒绝把任意 ref/选项塞进 argv
  return /^[0-9a-f]{4,64}$/i.test(ref) ? ref : null;
}

/**
 * 创建只读变更服务。
 *
 * 依赖全部显式注入：判据可以喂"假的存储 + 假 git"，从而精确断言
 * "没读 patch" / "numstat 缺失时字段缺席" / "非 git ⇒ supported=false"。
 */
export function createChangesService(deps: ChangesServiceDeps): ChangesService {
  async function requireSession(sessionId: string): Promise<void> {
    if (!(await deps.sessionExists(sessionId))) {
      throw new HostError("NOT_FOUND", `会话不存在：${sessionId}`);
    }
  }

  async function gitRepo(workspace: string): Promise<boolean> {
    try {
      return await deps.isGitWorkspace(workspace);
    } catch {
      return false;
    }
  }

  async function workspaceOf(sessionId: string): Promise<string | null> {
    try {
      const workspace = await deps.workspaceFor(sessionId);
      return workspace && workspace.trim() ? workspace : null;
    } catch {
      return null;
    }
  }

  return {
    async list(sessionId, offset = 0, limit = 20): Promise<SessionChangesResult> {
      await requireSession(sessionId);
      const page = await deps.queryPage(
        sessionId,
        clampInt(offset, 0, 1_000_000, 0),
        clampInt(limit, 1, HOST_CHANGES_PAGE_MAX, 20),
      );
      const workspace = await workspaceOf(sessionId);
      const git = workspace ? await gitRepo(workspace) : false;
      /*
       * 已有历史记录 ⇒ 即使当前工作区不再是仓库也照常返回（记录是真的，不能藏）；
       * 只有"非 git 且一条记录都没有"才是 truly unsupported。
       */
      const supported = git || page.items.length > 0;
      const items: TurnChangesView[] = page.items.map((record) => toTurnChangesView(record));
      return {
        items,
        hasMore: page.hasMore,
        supported,
        ...(supported
          ? {}
          : {
              /*
               * 不下发工作区绝对路径：远程客户端不需要知道 PC 的盘符/目录
               * （与 `hello.dataHome` 对非 loopback 客户端省略是同一条纪律）。
               */
              reason: workspace
                ? "当前工作区不是 git 仓库（或机器上没有 git）。" +
                  "变更记录只对 git 工作区生效；这不是「还没有改动」。"
                : "该会话没有可用的工作目录（项目可能已被移动或删除），无法判断变更记录。",
            }),
      };
    },

    async diff(sessionId, changeId, path): Promise<SessionChangeDiffResult> {
      await requireSession(sessionId);
      const record = await deps.getById(changeId);
      if (!record || record.session_id !== sessionId) {
        throw new HostError("NOT_FOUND", `变更记录不存在：${changeId}`);
      }
      const parsed = parseChangedFilesResult(record);
      const wanted = normalizePath(String(path ?? ""));
      if (!isSafeRelativePath(wanted)) {
        throw new HostError("INVALID_PARAMS", `path 必须是工作区内的相对路径：${String(path ?? "")}`);
      }
      const file = parsed.files.find((f) => normalizePath(f.path) === wanted);
      if (!file) {
        throw new HostError("INVALID_PARAMS", `文件不在该变更记录的清单里：${wanted}`, {
          hint: "客户端应只对本条记录 files[] 里的路径取 diff",
        });
      }
      /*
       * 敏感文件：**不返回 patch**（不弹审批，也不假装"没有改动"）。
       * 顺序放在取 tree / 跑 git 之前：既不多跑 git，也不给"审批后能看到旧内容"的口子。
       */
      if (deps.isSensitivePath?.(wanted)) {
        return {
          path: wanted,
          status: file.status,
          patch: "",
          truncated: false,
          supported: false,
          reason:
            "该文件属于敏感路径（如 .env / .git/config / 私钥），变更记录不返回它的差异。" +
            "请在运行任务的那台电脑上查看；远程端不提供这条内容出口。",
        };
      }

      const before = treeRef(record.before_tree);
      const after = treeRef(record.after_tree);
      if (!before || !after) {
        return {
          path: wanted,
          status: file.status,
          patch: "",
          truncated: false,
          supported: false,
          reason: "这条记录缺少 before/after 快照（旧记录或被清理），无法按文件取 diff —— 不是「没有改动」。",
        };
      }
      const workspace = await workspaceOf(sessionId);
      if (!workspace) {
        return {
          path: wanted,
          status: file.status,
          patch: "",
          truncated: false,
          supported: false,
          reason: "该会话没有可用的工作目录（项目可能已被移动或删除），无法读取它的快照。",
        };
      }
      if (!(await gitRepo(workspace))) {
        return {
          path: wanted,
          status: file.status,
          patch: "",
          truncated: false,
          supported: false,
          reason: "当前工作区不是 git 仓库（或机器上没有 git），无法读取 diff。",
        };
      }

      // 记录里的 before/after 树是**当时那个工作区**的 git 对象；切项目/清理后对象可能不存在。
      // 这不是内部错误，必须如实返回 supported=false（否则手机看到 INTERNAL，像 bug）。
      const objectExists = async (rev: string): Promise<boolean> => {
        const probe = await deps.runGit(workspace, ["cat-file", "-e", rev]);
        if (probe.exitCode === 124) {
          // 超时不是"对象不存在"：把它说成"另一个工作区"就是假事实。
          throw new HostError("CONFLICT", "读取 git 对象超时（工作区可能过大或磁盘忙）", {
            retryable: true,
            hint: "稍后重试；或在桌面本机查看这次变更",
          });
        }
        return (probe.exitCode ?? -1) === 0;
      };
      if (!(await objectExists(before)) || !(await objectExists(after))) {
        return {
          path: wanted,
          status: file.status,
          patch: "",
          truncated: false,
          supported: false,
          reason: "这条变更记录来自另一个工作区（或其 git 对象已被清理），当前工作区无法读取它的快照。",
        };
      }

      const result = await deps.runGit(workspace, [
        "diff",
        "--no-color",
        // 仓库配置里的外部 diff / textconv 会执行程序；变更记录只读，一律关掉。
        "--no-ext-diff",
        "--no-textconv",
        "-M",
        before,
        after,
        "--",
        /*
         * `:(literal)` pathspec：路径来自 `changed_files`，可能含 `[` 等 git 通配符。
         * 不加 literal 时，一个含 `[` 的普通文件会匹配到别的文件（甚至敏感文件）。
         */
        `:(literal)${wanted}`,
      ]);
      if (result.exitCode === 124) {
        throw new HostError("CONFLICT", "读取 git 差异超时（工作区可能过大或磁盘忙）", {
          retryable: true,
          hint: "稍后重试；或在桌面本机查看这次变更",
        });
      }
      if ((result.exitCode ?? -1) !== 0) {
        throw new HostError("INTERNAL", `git diff 失败：${result.stderr.trim() || `exit ${result.exitCode}`}`);
      }
      const raw = result.stdout;
      const patch = raw.length > HOST_CHANGE_DIFF_MAX_CHARS ? raw.slice(0, HOST_CHANGE_DIFF_MAX_CHARS) : raw;
      /**
       * 未跟踪的新文件不在 `stash create` 的树里 ⇒ tree-to-tree diff 为空。
       * 这不是"没有改动"，而是"快照里没有可比较的内容"——必须如实说，不能画成空 diff。
       */
      if (!raw.trim() && file.status === "A") {
        return {
          path: wanted,
          status: file.status,
          patch: "",
          truncated: false,
          supported: false,
          reason: "该文件在记录时是未跟踪的新文件，树快照里没有它的内容，无法显示逐行 diff。",
        };
      }
      return {
        path: wanted,
        status: file.status,
        patch,
        truncated: raw.length > HOST_CHANGE_DIFF_MAX_CHARS,
        supported: true,
      };
    },
  };
}
