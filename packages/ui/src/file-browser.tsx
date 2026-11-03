/**
 * 工作区文件浏览/只读预览（ADR-0003 矩阵：文件树 + 只读预览）。
 *
 * 只走 `SessionTransport` 的 `listWorkspace` / `readWorkspace`：
 * - 手机连 PC 时由 Host 读工作区；桌面本地实现没接线时明确显示"不支持"，不假装有数据；
 * - 目录逃逸、二进制、超大文件都由 Host 侧拒绝/截断，这里只负责展示与分页提示。
 *
 * **行组件与桌面是同一份**（`./file-tree-view`）：桌面 `FileExplorer` 只是把
 * `list_directory` / `git status` 换成 Tauri 取数，行的 DOM/键盘/样式完全一致。
 * 手机这里把一次 `workspace.list` 的一层结果喂给同一个组件 —— 数据源差异（单层 vs 嵌套、
 * 无 Git 状态）由注入的数据表达，不是第二套行组件。
 */
import { useCallback, useEffect, useState } from "react";

import { ApprovalCard, type ApprovalDecisionRequest, type DecisionOutcome } from "./approval-card";
import { FileTree, type FileTreeStrings } from "./file-tree-view";
import type { FileTreeEntry } from "./file-tree";
import { HostRpcError } from "./host-client";
import { MOBILE_PATCH_DIFF_STRINGS } from "./mobile-patch-diff-strings";
import { PatchDiffView } from "./patch-diff-view";
import type { SessionTransport } from "./transport";

interface Entry {
  name: string;
  type: "file" | "dir";
  size?: number;
}

/**
 * Host `APPROVAL_REQUIRED` 的 `details`（敏感读取审批）。
 *
 * 刻意在 UI 侧**结构化重述**而不是 import `@codem/protocol`：手机壳的 bundle 与协议包
 * 是两条发布节奏，这里只要字段形状；判据在 Host 侧保证形状稳定。
 */
interface SensitiveApprovalDetails {
  approvalRequired: true;
  approvalId: string;
  tool: string;
  summary: string;
  details: {
    path?: string;
    rule?: string;
    label?: string;
    reason?: string;
    risk?: "low" | "medium" | "high";
    files?: string[];
    fileCount?: number;
    base?: string;
    notice?: string;
    scope?: string;
  };
  expiresAt: number;
}

/** 从任意异常里识别 `APPROVAL_REQUIRED`；其他错误返回 null（不许吞掉） */
function approvalRequiredFrom(e: unknown): SensitiveApprovalDetails | null {
  if (!(e instanceof HostRpcError) || e.kind !== "APPROVAL_REQUIRED") return null;
  const details = e.details as SensitiveApprovalDetails | undefined;
  if (!details || details.approvalRequired !== true || typeof details.approvalId !== "string") return null;
  return details;
}

/**
 * 审批卡数据：**只有路径/规则/原因/文件清单**，绝不包含文件正文。
 *
 * 这是用户真正要判断的事（"批准后内容会发给模型"），所以 `notice` 放在明细第一段。
 */
function toApprovalRequest(details: SensitiveApprovalDetails): ApprovalDecisionRequest {
  const d = details.details;
  const files = d.files ?? [];
  const fileLine =
    files.length > 0
      ? `文件：${files.join("、")}${d.fileCount && d.fileCount > files.length ? ` 等 ${d.fileCount} 个` : ""}`
      : "";
  const detail = [d.reason, fileLine, d.notice].filter((part): part is string => Boolean(part)).join("\n");
  return {
    kind: "approval",
    id: details.approvalId,
    tool: details.tool,
    summary: details.summary,
    ...(detail ? { detail } : {}),
    ...(d.path ? { resource: d.path } : {}),
    ...(d.risk ? { risk: d.risk } : {}),
    ...(d.scope === "shared-desktop-workspace" ? { originLabel: "[共享桌面工作区]" } : {}),
  };
}

/** 手机文案（桌面文件树有自己的一套，见 `src/components/FileExplorer.tsx`） */
const FILE_TREE_STRINGS: FileTreeStrings = {
  searchPlaceholder: "筛选文件",
  refreshTitle: "刷新",
  loading: "读取中…",
  empty: "（空目录）",
  emptySearch: "无匹配文件",
};

/**
 * 取一份只读 diff —— 预览里的 `Diff` 按钮与第三列的「差异」页签**同一段实现**。
 *
 * 只做"调用"这一件事：`supported === false`（不是 git 仓库）原样返回给调用方决定文案，
 * 不在这里吞成空串（那会把"不是仓库"和"没有改动"混成同一个空态）。
 */
export async function loadWorkspaceDiff(
  transport: SessionTransport,
  path: string,
  approvalId?: string,
): Promise<{ path: string; diff: string; supported: boolean; reason?: string }> {
  if (!transport.diffWorkspace) throw new Error("当前连接不支持 diff（只读/本地模式）");
  /*
   * 没有 approvalId 时保持**原来的调用形状**（只传 path）：既有传输实现与判据都按这个形状
   * 断言；多传一个 undefined 会让 `toHaveBeenCalledWith(path)` 变红，也会让自写传输困惑。
   */
  return approvalId ? transport.diffWorkspace(path, "HEAD", approvalId) : transport.diffWorkspace(path);
}

export function FileBrowser(props: {
  transport: SessionTransport;
  onClose: () => void;
  inline?: boolean;
  /**
   * 当前预览的文件（相对工作区路径）上报给宿主；**目录切换/返回/重进都上报 `null`**。
   * 手机壳用它把第三列「差异」页签绑到"当前选中的文件"，组件自己仍以 `preview` 为唯一真源
   * （不引入第二份受控 selection）。
   */
  onSelectFile?: (path: string | null) => void;
}): React.ReactElement {
  const [path, setPath] = useState("");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState<{ path: string; text: string; truncated: boolean; binary?: boolean } | null>(null);
  const [diff, setDiff] = useState<string | null>(null);
  const [diffNote, setDiffNote] = useState("");
  /**
   * 待答复的敏感读取审批（内联渲染在文件浏览器里）。
   *
   * 为什么不能只靠聊天里的审批卡：文件浏览器是全屏 overlay（`position: fixed`），
   * 聊天里的卡会被它盖住 —— 用户看不到、也就无法批准。
   */
  const [approval, setApproval] = useState<{
    request: ApprovalDecisionRequest;
    kind: "read" | "diff";
    path: string;
  } | null>(null);
  const [approvalBusy, setApprovalBusy] = useState(false);

  const supported = Boolean(props.transport.listWorkspace && props.transport.readWorkspace);

  const load = useCallback(
    async (dir: string) => {
      if (!props.transport.listWorkspace) return;
      setLoading(true);
      setError("");
      // 换目录 = 当前选中的文件不再属于这一层，选择随之清空
      props.onSelectFile?.(null);
      try {
        const got = await props.transport.listWorkspace(dir || ".");
        setEntries(got.entries ?? []);
        setPath(got.path ?? dir);
        setPreview(null);
      } catch (e) {
        setError(String((e as Error)?.message ?? e));
      } finally {
        setLoading(false);
      }
    },
    [props.transport, props.onSelectFile],
  );

  useEffect(() => {
    if (supported) void load("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supported]);

  async function openFile(rel: string, approvalId?: string): Promise<void> {
    if (!props.transport.readWorkspace) return;
    setError("");
    setLoading(true);
    try {
      const got = await props.transport.readWorkspace(rel, 0, 200_000, approvalId);
      setDiff(null);
      setDiffNote("");
      setPreview({ path: rel, text: got.text, truncated: got.truncated, binary: got.encoding === "binary" });
      setApproval((current) => (current?.kind === "read" && current.path === rel ? null : current));
      props.onSelectFile?.(rel);
    } catch (e) {
      const required = approvalRequiredFrom(e);
      if (required) {
        // 首次/未覆盖：只显示审批卡，**不显示任何正文**（Host 也没返回正文）
        setApproval({ request: toApprovalRequest(required), kind: "read", path: rel });
        return;
      }
      setError(String((e as Error)?.message ?? e));
    } finally {
      setLoading(false);
    }
  }

  async function showDiff(rel: string, approvalId?: string): Promise<void> {
    // 先清掉上一份 patch：新请求要审批时，界面不能还挂着**别的文件**的差异。
    setDiff(null);
    setDiffNote("");
    try {
      const got = await loadWorkspaceDiff(props.transport, rel, approvalId);
      if (!got.supported) {
        setDiffNote(got.reason ?? "此工作区不是 git 仓库，无法显示 diff");
        return;
      }
      // 存原始 patch：空态文案在渲染处决定，不把文案塞进 diff 字符串
      setDiff(got.diff);
      setDiffNote(got.reason ?? "");
      setApproval((current) => (current?.kind === "diff" && current.path === rel ? null : current));
    } catch (e) {
      const required = approvalRequiredFrom(e);
      if (required) {
        setApproval({ request: toApprovalRequest(required), kind: "diff", path: rel });
        return;
      }
      setDiffNote(String((e as Error)?.message ?? e));
    }
  }

  async function resolveApproval(outcome: DecisionOutcome): Promise<void> {
    const current = approval;
    if (!current) return;
    const respond = props.transport.respondApproval;
    if (!respond) {
      setError("当前连接不支持审批，无法读取该文件");
      return;
    }
    const allow = outcome.kind === "allow";
    setApprovalBusy(true);
    try {
      await respond(current.request.id, allow ? "allow" : "deny", `ui-file-browser-${Date.now()}`);
      setApproval(null);
      if (allow) {
        if (current.kind === "read") await openFile(current.path, current.request.id);
        else await showDiff(current.path, current.request.id);
      } else {
        setDiff(null);
        setDiffNote("");
        setError(
          current.kind === "read"
            ? `已拒绝读取敏感文件 ${current.path}（未读取任何内容）`
            : `已拒绝查看敏感文件的差异 ${current.path}（未返回任何 patch）`,
        );
      }
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setApprovalBusy(false);
    }
  }

  const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";

  /** 一层目录条目 → 共享文件树条目（`path` 是相对工作区路径，点击即进入/预览） */
  const rows: FileTreeEntry[] = entries.map((e) => ({
    name: e.name,
    path: path ? `${path}/${e.name}` : e.name,
    isDirectory: e.type === "dir",
    size: e.size,
  }));

  return (
    <div className={`file-browser${props.inline ? " inline" : ""}`} role="dialog" aria-label="workspace files">
      <div className="file-browser-head">
        <button
          className="file-browser-back"
          onClick={() => {
            if (preview) {
              setPreview(null);
              props.onSelectFile?.(null);
              return;
            }
            if (parent !== path) void load(parent);
          }}
          disabled={!path && !preview}
        >
          返回
        </button>
        <span className="file-browser-path">{preview ? preview.path : path || "工作区根"}</span>
        {preview && props.transport.diffWorkspace ? (
          <button onClick={() => void showDiff(preview.path)}>Diff</button>
        ) : null}
        {props.inline ? null : <button onClick={props.onClose}>关闭</button>}
      </div>

      {!supported ? <div className="file-browser-empty">当前连接不支持文件浏览（只读/本地模式）</div> : null}
      {error ? <div className="file-browser-error">{error}</div> : null}

      {approval ? (
        <div className="file-browser-approval">
          <ApprovalCard
            request={approval.request}
            // 一次性授权：不提供「始终允许」（Host 的读取审批没有会话记忆）
            capabilities={{ alwaysAllow: false, rejectReason: false }}
            busy={approvalBusy}
            onResolve={(_id, outcome) => void resolveApproval(outcome)}
          />
        </div>
      ) : null}

      {!preview && supported ? (
        <FileTree
          entries={rows}
          strings={FILE_TREE_STRINGS}
          onToggle={(p) => void load(p)}
          onOpenFile={(p) => void openFile(p)}
          loading={loading}
        />
      ) : null}

      {preview ? (
        <div className="file-browser-preview">
          {preview.binary ? (
            "（二进制文件，不预览）"
          ) : diff !== null ? (
            diff.trim() ? (
              <PatchDiffView patch={diff} strings={MOBILE_PATCH_DIFF_STRINGS} />
            ) : (
              "（没有未提交的改动）"
            )
          ) : (
            <>
              {preview.text}
              {preview.truncated ? "\n…（已截断）" : ""}
            </>
          )}
          {diffNote ? `\n${diffNote}` : ""}
        </div>
      ) : null}
    </div>
  );
}

/**
 * 第三列的「差异」面板：显示**当前选中文件**的只读 diff。
 *
 * - 取数与预览里的 `Diff` 按钮是同一个 `loadWorkspaceDiff`（一处实现两处用）；
 * - 触发是显式的（选中变化 / 手动「刷新」）：`SessionTransport` 没有工作区变更事件，
 *   所以这里不轮询、不假装能实时；
 * - 空态矩阵写死在渲染里（未选文件 / 连接不支持 / 读取中 / 不是 git 仓库 / 没有改动 / 出错），
 *   每种都给出**不同的**文案 —— 把「出错」画成「没有改动」是这类面板最常见的假绿。
 */
export function WorkspaceDiffPane(props: {
  transport: SessionTransport;
  /** 当前选中的文件（相对工作区路径）；`null` = 还没选 */
  path: string | null;
  /** 空态里的「去选择」；不给就不渲染这颗按钮 */
  onChooseFile?: () => void;
}): React.ReactElement {
  const supported = typeof props.transport.diffWorkspace === "function";
  type State =
    | { kind: "idle" }
    | { kind: "unsupported" }
    | { kind: "loading" }
    | { kind: "not-git"; message?: string }
    | { kind: "ready"; diff: string; note?: string }
    | { kind: "error"; message: string };
  const [state, setState] = useState<State>({ kind: "idle" });
  /** 手动刷新：只递增这个 key 重跑 effect，选择本身仍是宿主的 state */
  const [reloadKey, setReloadKey] = useState(0);
  /** 敏感 diff 的内联审批（与 `FileBrowser` 同一套两阶段协议） */
  const [approval, setApproval] = useState<{ request: ApprovalDecisionRequest; path: string } | null>(null);
  const [approvalBusy, setApprovalBusy] = useState(false);

  const requestDiff = useCallback(
    async (path: string, approvalId?: string): Promise<State> => {
      try {
        const got = await loadWorkspaceDiff(props.transport, path, approvalId);
        return got.supported
          ? { kind: "ready", diff: got.diff, ...(got.reason ? { note: got.reason } : {}) }
          : { kind: "not-git", ...(got.reason ? { message: got.reason } : {}) };
      } catch (e) {
        const required = approvalRequiredFrom(e);
        if (required) {
          setApproval({ request: toApprovalRequest(required), path });
          return { kind: "loading" };
        }
        return { kind: "error", message: String((e as Error)?.message ?? e) };
      }
    },
    [props.transport],
  );

  useEffect(() => {
    const path = props.path;
    if (!path) {
      setState({ kind: "idle" });
      return;
    }
    if (!supported) {
      setState({ kind: "unsupported" });
      return;
    }
    let cancelled = false;
    setState({ kind: "loading" });
    void requestDiff(path).then((next) => {
      if (!cancelled) setState(next);
    });
    return () => {
      cancelled = true;
    };
  }, [props.path, supported, reloadKey, requestDiff]);

  async function resolveApproval(outcome: DecisionOutcome): Promise<void> {
    const current = approval;
    if (!current) return;
    const respond = props.transport.respondApproval;
    if (!respond) {
      setState({ kind: "error", message: "当前连接不支持审批，无法查看该差异" });
      return;
    }
    const allow = outcome.kind === "allow";
    setApprovalBusy(true);
    try {
      await respond(current.request.id, allow ? "allow" : "deny", `ui-file-diff-${Date.now()}`);
      setApproval(null);
      if (allow) {
        setState({ kind: "loading" });
        setState(await requestDiff(current.path, current.request.id));
      } else {
        setState({ kind: "error", message: `已拒绝查看敏感文件的差异 ${current.path}（未返回任何 patch）` });
      }
    } catch (e) {
      setState({ kind: "error", message: String((e as Error)?.message ?? e) });
    } finally {
      setApprovalBusy(false);
    }
  }

  let body: React.ReactNode;
  switch (state.kind) {
    case "idle":
      body = (
        <>
          <div className="empty-hint is-compact">先在「文件」里选一个文件</div>
          {props.onChooseFile ? <button onClick={props.onChooseFile}>去选择</button> : null}
        </>
      );
      break;
    case "unsupported":
      body = <div className="file-browser-empty">当前连接不支持 diff（只读/本地模式）</div>;
      break;
    case "loading":
      body = <div className="empty-hint is-compact">读取中…</div>;
      break;
    case "not-git":
      body = (
        <div className="empty-hint is-compact">
          {state.message ?? "此工作区不是 git 仓库，无法显示 diff"}
        </div>
      );
      break;
    case "error":
      body = <div className="file-browser-error">{state.message}</div>;
      break;
    default:
      body = (
        <div className="file-browser-preview">
          {state.diff.trim() ? (
            <PatchDiffView patch={state.diff} strings={MOBILE_PATCH_DIFF_STRINGS} />
          ) : (
            "（没有未提交的改动）"
          )}
          {state.note ? `\n${state.note}` : ""}
        </div>
      );
      break;
  }

  return (
    <div className="file-browser inline">
      <div className="file-browser-head">
        <span className="file-browser-path">{props.path ?? "未选择文件"}</span>
        {props.path && supported ? <button onClick={() => setReloadKey((k) => k + 1)}>刷新</button> : null}
      </div>
      {body}
      {approval ? (
        <ApprovalCard
          request={approval.request}
          capabilities={{ alwaysAllow: false, rejectReason: false }}
          busy={approvalBusy}
          onResolve={(_id, outcome) => void resolveApproval(outcome)}
        />
      ) : null}
    </div>
  );
}
