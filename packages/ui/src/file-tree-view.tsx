/**
 * 文件树视图 `FileTree` —— 桌面侧边栏/面板侧栏与手机壳文件浏览共用的**唯一**实现。
 *
 * 归属线（同 `diff-view.tsx`）：
 * - 这里只有"文件树长什么样 + 怎么响应点击/键盘/拖拽"：搜索栏、行、Git 徽章、子层、空/加载提示；
 * - 数据（条目从哪来、目录怎么懒加载、缓存与失效）由宿主注入；
 * - 文案全部注入（`strings` 必填）—— 共享层不猜语言。
 *
 * DOM/类名与迁移前的桌面文件树逐字一致（`.file-entry` / `.file-entry-icon` / `.file-name` /
 * `.git-status-badge` / `.file-children` / `role="treeitem"`），因此既有 CSS 与键盘判据不变；
 * 样式随组件搬进 `packages/ui/src/ui.css`（桌面与手机同一份）。
 *
 * ⚠️ `aria-expanded` 是"这行能不能展开"的语义：手机把目录点击当成"进入目录"（单层导航），
 * 所以手机侧恒为 `false` —— 这是数据源差异，不是第二套行为（见 `file-browser.tsx`）。
 */
import * as React from "react";
import { memo } from "react";
import { Folder, FolderOpen, RefreshCw, Search } from "lucide-react";

import {
  formatSize,
  GIT_STATUS_BADGES,
  getFileIcon,
  sortEntries,
  type FileTreeEntry,
} from "./file-tree";

/** 文件树文案（必填：共享层没有默认语言） */
export interface FileTreeStrings {
  searchPlaceholder: string;
  refreshTitle: string;
  loading: string;
  /** 空目录 / 读不到 */
  empty: string;
  /** 有搜索词但没命中 */
  emptySearch: string;
}

export interface FileTreeProps {
  entries: FileTreeEntry[];
  strings: FileTreeStrings;
  /** 已展开的目录路径；不传当作全部收起 */
  expanded?: ReadonlySet<string>;
  /** 目录被点击（桌面：展开/收起；手机：进入目录） */
  onToggle?: (path: string) => void;
  /** 文件被点击 */
  onOpenFile?: (path: string) => void;
  /** 文件被拖走（桌面 InputArea 的 drop 通道） */
  onFileDragStart?: (path: string, name: string) => void;
  selectedPath?: string | null;
  /** 搜索词（受控）；不传 `onQueryChange` 就不渲染搜索栏 */
  query?: string;
  onQueryChange?: (value: string) => void;
  /** 刷新按钮；不传就不渲染 */
  onRefresh?: () => void;
  loading?: boolean;
  /** 宿主注入的加载指示（桌面 Spinner）；不给就只显示 `strings.loading` */
  loadingSlot?: React.ReactNode;
}

export function FileTree(props: FileTreeProps): React.ReactElement {
  const { strings } = props;
  const search = props.onQueryChange ? (
    <div className="file-explorer-search">
      <div className="file-explorer-search-bar">
        <Search size={14} className="file-explorer-search-icon" />
        <input
          type="text"
          value={props.query ?? ""}
          onChange={(e) => props.onQueryChange?.(e.target.value)}
          placeholder={strings.searchPlaceholder}
          className="file-explorer-search-input"
        />
        {props.onRefresh ? (
          <button
            className="file-explorer-search-refresh"
            onClick={props.onRefresh}
            title={strings.refreshTitle}
          >
            <RefreshCw size={14} />
          </button>
        ) : null}
      </div>
    </div>
  ) : null;

  return (
    <div className="file-explorer">
      {search}
      <div className="file-tree">
        {props.loading ? (
          <div className="empty-hint is-compact">
            {props.loadingSlot ? (
              <>
                {props.loadingSlot} {strings.loading}
              </>
            ) : (
              strings.loading
            )}
          </div>
        ) : null}
        {!props.loading && props.entries.length === 0 ? (
          <div className="empty-hint is-compact">{props.query ? strings.emptySearch : strings.empty}</div>
        ) : null}
        {props.entries.map((entry) => (
          <FileTreeRow
            key={entry.path}
            entry={entry}
            depth={0}
            expanded={props.expanded}
            onToggle={props.onToggle}
            onOpenFile={props.onOpenFile}
            onFileDragStart={props.onFileDragStart}
            selectedPath={props.selectedPath}
          />
        ))}
      </div>
    </div>
  );
}

interface FileTreeRowProps {
  entry: FileTreeEntry;
  depth: number;
  expanded?: ReadonlySet<string>;
  onToggle?: (path: string) => void;
  onOpenFile?: (path: string) => void;
  onFileDragStart?: (path: string, name: string) => void;
  selectedPath?: string | null;
}

const FileTreeRow = memo(function FileTreeRow(props: FileTreeRowProps): React.ReactElement {
  const { entry, depth, expanded, selectedPath, onToggle, onOpenFile, onFileDragStart } = props;
  const isExpanded = expanded?.has(entry.path) ?? false;
  const isSelected = selectedPath === entry.path;
  const Icon = entry.isDirectory ? (isExpanded ? FolderOpen : Folder) : getFileIcon(entry.name);
  const gitBadge = entry.gitStatus ? GIT_STATUS_BADGES[entry.gitStatus] : null;
  const className =
    "file-entry " +
    (entry.isDirectory ? "directory" : "file") +
    (entry.gitStatus ? " git-changed" : "") +
    (isSelected ? " selected" : "");

  return (
    <div>
      <div
        className={className}
        style={{ paddingLeft: 8 + depth * 14 + "px" }}
        draggable={!entry.isDirectory}
        onDragStart={(e) => {
          if (entry.isDirectory) return;
          // Set drag data for the composer to receive
          e.dataTransfer.setData("application/x-file-path", entry.path);
          e.dataTransfer.setData("application/x-file-name", entry.name);
          e.dataTransfer.setData("text/plain", entry.path);
          e.dataTransfer.effectAllowed = "copy";
          onFileDragStart?.(entry.path, entry.name);
        }}
        onClick={() => {
          if (entry.isDirectory) {
            onToggle?.(entry.path);
          } else {
            onOpenFile?.(entry.path);
          }
        }}
        // 第 39 波：文件树条目此前是**不可聚焦的 div** —— 键盘用户根本到不了它（不是"焦点看不见"，
        // 是"焦点到不了"）。补 role/tabIndex 与 Enter/Space 处理；焦点环由全局
        // `:is(a,button,[role=button],summary,[tabindex]):focus-visible` 规则提供。
        role="treeitem"
        tabIndex={0}
        aria-expanded={entry.isDirectory ? isExpanded : undefined}
        aria-selected={isSelected}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            if (entry.isDirectory) onToggle?.(entry.path);
            else onOpenFile?.(entry.path);
          }
        }}
        title={entry.path}
      >
        <Icon size={14} className="file-entry-icon" />
        <span className="file-name">{entry.name}</span>
        {gitBadge ? <span className={"git-status-badge " + gitBadge.className}>{gitBadge.label}</span> : null}
        {typeof entry.size === "number" ? <span className="file-entry-size">{formatSize(entry.size)}</span> : null}
      </div>
      {entry.isDirectory && isExpanded && entry.children ? (
        <div className="file-children">
          {sortEntries(entry.children).map((child) => (
            <FileTreeRow
              key={child.path}
              entry={child}
              depth={depth + 1}
              expanded={expanded}
              onToggle={onToggle}
              onOpenFile={onOpenFile}
              onFileDragStart={onFileDragStart}
              selectedPath={selectedPath}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
});
