/**
 * 文件变更列表 —— **桌面与手机的唯一展示实现**（只读）。
 *
 * ## 归属线
 *
 * - 本组件只负责"长什么样"：最近一轮 / 历史轮次 / 文件行 / 统计 / 空态 / 检查区块；
 * - **取数**由宿主注入：桌面 `FileChangesList` 用 `FileChangeStorage.loadBySession()`，
 *   手机 `SessionChangesPane` 用 `transport.sessionChanges`；
 * - **diff 视图不进这里**：注入 `onOpenFile(change, file)`，由各端打开自己的视图
 *   （桌面 `DiffViewer` 需要 before/after 两段文本；手机只有统一 patch ——
 *   两套输入硬塞进一个组件就会变成两份 diff 渲染，见 `diff-view.tsx` 文件头）。
 *
 * ## 能力位是**数据**，不是平台判断
 *
 * `capabilities.revert` / `capabilities.checks` 为 false ⇒ 对应控件/区块**不出现**。
 * 手机首版不提供回滚（Host 回滚要审批 + 残留上报），也不下发 checks
 * （`checks` 是**按会话**的设置面记录，不绑定这一轮）—— 画一个禁用按钮或空区块
 * 等于假装有。
 *
 * ## 空态矩阵（四种，互不冒充）
 *
 * | 状态 | 文案 |
 * |---|---|
 * | 读取中 | `读取中…` |
 * | 读取失败 | `文件变更记录读取失败` + 错误原文 |
 * | 不支持 | `此 Host 不记录文件变更` + 原因（非 git / 没装 git） |
 * | 没有记录 | `暂无文件变更记录` + `Agent 执行修改后会自动记录` |
 */
import { useState } from "react";
import { ChevronDown, ChevronRight, FileText, GitBranch, RefreshCw, RotateCcw } from "lucide-react";

import type { ChangedFileView, TurnChangesView } from "../../protocol/src/index";
import {
  baseName,
  changesEmptyKind,
  fileStatusClass,
  formatAddition,
  formatDeletion,
  formatTotals,
  historyChanges,
  latestChange,
  turnLabel,
} from "./changes-model";
import { MOBILE_PATCH_DIFF_STRINGS } from "./mobile-patch-diff-strings";
import { PatchDiffView } from "./patch-diff-view";

export interface ChangesCapabilities {
  /** 出现"回滚"按钮（Host 首版 false） */
  revert: boolean;
  /** 出现"最近检查"区块（手机首版 false） */
  checks: boolean;
}

export interface ChangesCheckView {
  command: string;
  ok: boolean;
}

export interface ChangesListProps {
  records: TurnChangesView[];
  /** 首次读取（没有记录时显示"读取中…"） */
  loading?: boolean;
  /** 读取失败（与"没有记录"必须分开） */
  error?: string | null;
  /** Host 是否具备记录能力；false 时显示 reason */
  supported?: boolean;
  reason?: string;
  hasMore?: boolean;
  /** 正在加载下一页（按钮禁用，不重置列表） */
  loadingMore?: boolean;
  capabilities: ChangesCapabilities;
  /** 桌面注入本会话的验证检查；`capabilities.checks=false` 时忽略 */
  checks?: ChangesCheckView[];
  /** 打开某个文件的 diff（缺省 / 记录缺 tree 时行不可点） */
  onOpenFile?: (change: TurnChangesView, file: ChangedFileView) => void;
  onRevert?: (change: TurnChangesView) => void;
  onLoadMore?: () => void;
  /** 手动刷新（不假装实时：没有变更事件） */
  onRefresh?: () => void;
}

function EmptyState(props: ChangesListProps): React.ReactElement {
  const kind = changesEmptyKind(props);
  if (kind === "loading") {
    return (
      <div className="file-changes-empty empty-hint" role="status">
        读取中…
      </div>
    );
  }
  if (kind === "error") {
    return (
      <div className="file-changes-empty" role="alert">
        <GitBranch className="icon-lg file-changes-empty-icon" aria-hidden="true" />
        <div>文件变更记录读取失败</div>
        <div className="file-changes-empty-detail">{props.error}</div>
      </div>
    );
  }
  if (kind === "unsupported") {
    return (
      <div className="file-changes-empty" role="status">
        <GitBranch className="icon-lg file-changes-empty-icon" aria-hidden="true" />
        <div>此 Host 不记录文件变更</div>
        <div className="file-changes-empty-detail">{props.reason || "当前工作区不具备记录条件"}</div>
      </div>
    );
  }
  return (
    <div className="file-changes-empty" role="status">
      <GitBranch className="icon-lg file-changes-empty-icon" aria-hidden="true" />
      <div>暂无文件变更记录</div>
      <div className="file-changes-empty-detail">Agent 执行修改后会自动记录</div>
    </div>
  );
}

function FileRow(props: {
  change: TurnChangesView;
  file: ChangedFileView;
  className: string;
  compact?: boolean;
  onOpenFile?: (change: TurnChangesView, file: ChangedFileView) => void;
}): React.ReactElement {
  const { change, file, onOpenFile } = props;
  const canOpen = change.treesAvailable && Boolean(onOpenFile);
  const title = canOpen
    ? file.path
    : !change.treesAvailable
      ? `${file.path}（这条记录缺少 before/after 快照，无法查看逐行 diff）`
      : `${file.path}（当前连接不支持单文件 diff）`;
  const content = (
    <>
      <FileText className="icon-xs change-file-icon" aria-hidden="true" />
      <span className={props.compact ? "change-file-path" : "inspector-file-path"}>
        {props.compact ? baseName(file.path) : file.path}
      </span>
      <span className={fileStatusClass(file.status)}>{file.status}</span>
      {props.compact ? null : (
        <>
          <span className="inspector-file-stat diff-stat-add">{formatAddition(file)}</span>
          <span className="inspector-file-stat diff-stat-del">{formatDeletion(file)}</span>
        </>
      )}
    </>
  );
  if (canOpen) {
    return (
      <button
        type="button"
        role="listitem"
        className={props.className}
        title={title}
        onClick={() => onOpenFile?.(change, file)}
      >
        {content}
      </button>
    );
  }
  return (
    <div role="listitem" className={props.className} title={title} aria-disabled="true">
      {content}
    </div>
  );
}

function ChecksBlock(props: { checks: ChangesCheckView[] }): React.ReactElement {
  return (
    <div className="inspector-checks">
      <div className="inspector-checks-title">最近检查</div>
      {props.checks.length === 0 ? (
        <div className="inspector-checks-empty empty-hint">
          本轮没有检查记录（未运行测试 / 类型检查 / 构建）
        </div>
      ) : (
        <ul className="inspector-check-list">
          {props.checks.slice(0, 5).map((c, i) => (
            <li key={`${c.command}-${i}`} className={c.ok ? "inspector-check ok" : "inspector-check failed"}>
              <span className="inspector-check-dot" aria-hidden="true" />
              <code className="inspector-check-cmd" title={c.command}>
                {c.command.length > 60 ? `${c.command.slice(0, 60)}…` : c.command}
              </code>
              <span className="inspector-check-verdict">{c.ok ? "通过" : "失败"}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function FilesBlock(props: {
  change: TurnChangesView;
  className: string;
  compact?: boolean;
  onOpenFile?: (change: TurnChangesView, file: ChangedFileView) => void;
}): React.ReactElement {
  const { change } = props;
  if (change.filesParseError) {
    return (
      <div className="inspector-files-error" role="alert">
        这条记录的改动清单损坏（无法解析），文件列表可能不完整
      </div>
    );
  }
  if (change.files.length === 0) {
    return <div className="inspector-files-empty empty-hint">这一条记录没有可展示的文件</div>;
  }
  return (
    <div className={props.compact ? "turn-change-files" : "inspector-file-rows"} role="list">
      {change.files.map((file, i) => (
        <FileRow
          key={`${file.path}-${i}`}
          change={change}
          file={file}
          className={props.className}
          compact={props.compact}
          onOpenFile={props.onOpenFile}
        />
      ))}
    </div>
  );
}

export function ChangesList(props: ChangesListProps): React.ReactElement {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const emptyKind = changesEmptyKind(props);
  const records = props.records;
  const latest = latestChange(records);
  const history = historyChanges(records);
  const totals = latest ? formatTotals(latest) : null;

  return (
    <div className="file-changes-list">
      {props.onRefresh ? (
        <div className="changes-toolbar">
          <span className="changes-toolbar-hint">只读变更记录</span>
          <button type="button" className="changes-refresh" onClick={() => props.onRefresh?.()}>
            <RefreshCw className="icon-xs" aria-hidden="true" /> 刷新
          </button>
        </div>
      ) : null}

      {props.error && records.length > 0 ? (
        <div className="file-changes-error-banner" role="alert">
          读取失败（下面仍是上次读到的记录）：{props.error}
        </div>
      ) : null}

      {emptyKind !== "ready" ? <EmptyState {...props} /> : null}

      {latest ? (
        <section className="inspector-latest" aria-label="最近一轮改动">
          <div className="inspector-latest-head">
            <span className="inspector-latest-title">最近一轮</span>
            <span className="inspector-latest-turn">{turnLabel(latest)}</span>
            <span className="inspector-latest-stats">
              {totals ? (
                <>
                  <span className="diff-stat-add">{totals.add}</span> <span className="diff-stat-del">{totals.del}</span>
                </>
              ) : (
                <span className="inspector-stats-unknown" title="这次改动没有逐行统计（二进制或旧记录）">
                  +— −—
                </span>
              )}
            </span>
            <span className="inspector-latest-count">{latest.files.length} 个文件</span>
          </div>

          <FilesBlock change={latest} className="inspector-file-row" onOpenFile={props.onOpenFile} />

          {props.capabilities.checks ? <ChecksBlock checks={props.checks ?? []} /> : null}

          {props.capabilities.revert && props.onRevert ? (
            <button
              type="button"
              className="revert-btn"
              onClick={() => props.onRevert?.(latest)}
              disabled={latest.status === "reverted"}
              title="回滚最近一轮的变更"
            >
              <RotateCcw className="icon-xs" aria-hidden="true" /> 回滚本轮
            </button>
          ) : null}
        </section>
      ) : null}

      {history.length > 0 ? <div className="inspector-history-title">历史轮次</div> : null}

      {history.map((record) => {
        const isExpanded = expandedId === record.changeId;
        const isReverted = record.status === "reverted";
        return (
          <div key={record.changeId} className={isReverted ? "turn-change-group reverted" : "turn-change-group"}>
            <div
              className="turn-change-header"
              onClick={() => setExpandedId(isExpanded ? null : record.changeId)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setExpandedId(isExpanded ? null : record.changeId);
                }
              }}
            >
              {isExpanded ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}
              <span className="turn-label">
                {turnLabel(record)}
                {isReverted ? <span className="reverted-tag">已回滚</span> : null}
              </span>
              <span className="turn-file-count">{record.files.length} 个文件</span>
            </div>
            {isExpanded ? (
              <div className="turn-change-files">
                <div className="turn-brief">本轮改动 {record.files.length} 个文件</div>
                <FilesBlock
                  change={record}
                  className="change-file-row"
                  compact
                  onOpenFile={props.onOpenFile}
                />
                {props.capabilities.revert && props.onRevert ? (
                  <button
                    type="button"
                    className="revert-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      props.onRevert?.(record);
                    }}
                    disabled={isReverted}
                    title="回滚此轮变更"
                  >
                    <RotateCcw size={12} aria-hidden="true" /> 回滚
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })}

      {props.hasMore && props.onLoadMore ? (
        <button
          type="button"
          className="changes-load-more"
          onClick={() => props.onLoadMore?.()}
          disabled={props.loadingMore}
        >
          {props.loadingMore ? "加载中…" : "加载更多"}
        </button>
      ) : null}
    </div>
  );
}

/** 手机/远程单文件 diff 的只读浮层（桌面用自己的 `DiffViewer`，不走这里） */
export interface ChangeDiffView {
  path: string;
  status: string;
  patch: string;
  truncated: boolean;
  supported: boolean;
  reason?: string;
}

export function ChangeDiffOverlay(props: {
  view: ChangeDiffView | null;
  onClose: () => void;
}): React.ReactElement | null {
  if (!props.view) return null;
  const { view } = props;
  return (
    <div className="changes-diff-overlay" onClick={props.onClose} role="presentation">
      <div
        className="changes-diff-panel"
        role="dialog"
        aria-label={`${view.path} 的差异`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="changes-diff-head">
          <span className="changes-diff-path" title={view.path}>
            {view.path}
          </span>
          <span className={fileStatusClass(view.status)}>{view.status}</span>
          <button type="button" className="changes-diff-close" onClick={props.onClose}>
            关闭
          </button>
        </div>
        {view.supported ? (
          view.patch.trim() ? (
            <>
              <div className="changes-diff-body">
                <PatchDiffView patch={view.patch} strings={MOBILE_PATCH_DIFF_STRINGS} />
              </div>
              {view.truncated ? (
                <div className="diff-truncated-note">…（diff 已截断，超过 200 KB）</div>
              ) : null}
            </>
          ) : (
            <div className="file-browser-empty">（这里没有可显示的逐行差异）</div>
          )
        ) : (
          <div className="file-browser-empty">{view.reason || "这条记录无法显示 diff"}</div>
        )}
      </div>
    </div>
  );
}
