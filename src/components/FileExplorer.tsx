/**
 * FileExplorer — 文件浏览器（对标 wecode WorkspaceFileTree）
 *
 * 特性：
 * - 顶部搜索栏（筛选文件名）
 * - 紧凑密度（item 高度 28px，对标 wecode compact density）
 * - 目录优先排序 + 字母序
 * - 文件类型 Lucide 图标（对标 wecode complete icon set）
 * - Git 状态标签
 * - 选中高亮
 * - 支持拖拽文件到编辑窗
 * - 空目录自动折叠
 */

import { useState, useEffect, useCallback, useRef, memo, useMemo } from "react";
import { onFileChangesTracked } from "../core/environment/file-change-tracker";
import {
  Search, RefreshCw,
  Folder, FolderOpen,
  FileText, FileCode, FileJson, FileImage, FileVideo,
  FileArchive, FileCog, FileTerminal, FileType, Database,
  type LucideIcon,
} from "lucide-react";

interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  children?: FileEntry[];
  gitStatus?: string; // M, A, D, U, R, or null
}

interface FileExplorerProps {
  cwd: string;
  onFileClick?: (path: string) => void;
  refreshKey?: number;
  /** Called when a file is dragged out of the file explorer (for composer drop) */
  onFileDragStart?: (path: string, name: string) => void;
  /** Currently selected file path (for highlight) */
  selectedPath?: string | null;
}

// Directory cache shared across instances
const dirCache = new Map<string, FileEntry[]>();
// Git status cache: Map<workspacePath, Map<filePath, status>>
const gitStatusCache = new Map<string, Map<string, string>>();

async function loadDirectoryFromTauri(path: string): Promise<FileEntry[]> {
  try {
    const { invoke } = (window as any).__TAURI__.core;
    // showHidden: true — 文件树需要显示 .wecode-ref 等点开头目录（v1.9.1）
    // LLM 工具调用的 listDirectory (file-api.ts) 不传此参数，仍保持隐藏过滤
    const entries = await invoke("list_directory", { path, showHidden: true });
    return entries || [];
  } catch {
    return [];
  }
}

async function loadGitStatus(workspace: string): Promise<Map<string, string>> {
  try {
    const { invoke } = (window as any).__TAURI__.core;
    const result = await invoke("execute_command", {
      command: "git -C \"" + workspace + "\" status --porcelain",
      cwd: workspace,
    });
    const statusMap = new Map<string, string>();
    const stdout = result.stdout || "";
    for (const line of stdout.split("\n")) {
      if (line.length < 3) continue;
      const status = line.substring(0, 2).trim();
      const filePath = line.substring(3).trim().replace(/"/g, "");
      // Use first char as the status indicator
      const statusChar = status[0] === "?" ? "U" : status[0] || status[1] || "M";
      statusMap.set(filePath, statusChar);
    }
    gitStatusCache.set(workspace, statusMap);
    return statusMap;
  } catch {
    return new Map();
  }
}

function getGitStatus(workspace: string, filePath: string): string | undefined {
  const statusMap = gitStatusCache.get(workspace);
  if (!statusMap) return undefined;
  // Try exact match
  if (statusMap.has(filePath)) return statusMap.get(filePath);
  // Try relative path
  const relative = filePath.replace(/\\/g, "/").replace(workspace.replace(/\\/g, "/") + "/", "");
  return statusMap.get(relative);
}

// ==================== 文件类型图标映射（对标 wecode complete icon set） ====================

const EXT_ICON_MAP: Record<string, LucideIcon> = {
  // 代码
  ts: FileCode, tsx: FileCode, js: FileCode, jsx: FileCode,
  py: FileCode, rs: FileCode, go: FileCode, java: FileCode,
  c: FileCode, cpp: FileCode, h: FileCode, hpp: FileCode,
  cs: FileCode, rb: FileCode, php: FileCode, swift: FileCode,
  kt: FileCode, lua: FileCode, r: FileCode, dart: FileCode,
  scala: FileCode, clj: FileCode, vue: FileCode, svelte: FileCode,
  graphql: FileCode, gql: FileCode, proto: FileCode,
  // Web
  html: FileCode, css: FileCode, scss: FileCode, less: FileCode,
  // 数据/配置
  json: FileJson, yaml: FileJson, yml: FileJson, toml: FileJson,
  xml: FileCode, ini: FileCog, cfg: FileCog, conf: FileCog,
  env: FileCog,
  // 文档
  md: FileText, txt: FileText, pdf: FileText,
  doc: FileText, docx: FileText,
  // 图片
  png: FileImage, jpg: FileImage, jpeg: FileImage, gif: FileImage,
  bmp: FileImage, svg: FileImage, webp: FileImage, ico: FileImage,
  // 视频
  mp4: FileVideo, webm: FileVideo, avi: FileVideo, mov: FileVideo,
  mkv: FileVideo, ogv: FileVideo,
  // 压缩
  zip: FileArchive, tar: FileArchive, gz: FileArchive, rar: FileArchive, "7z": FileArchive,
  // 脚本
  sh: FileTerminal, bash: FileTerminal, bat: FileTerminal, ps1: FileTerminal,
  // 数据库
  sql: Database, db: Database, sqlite: Database,
  // 字体
  ttf: FileType, otf: FileType, woff: FileType, woff2: FileType,
};

function getFileIcon(name: string): LucideIcon {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  return EXT_ICON_MAP[ext] || FileText;
}

// ==================== 排序：目录优先 + 字母序（对标 wecode sortEntries） ====================

function sortEntries(entries: FileEntry[]): FileEntry[] {
  return [...entries].sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) {
      return a.isDirectory ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });
}

// ==================== 搜索过滤 ====================

function filterTree(entries: FileEntry[], query: string): FileEntry[] {
  if (!query) return entries;
  const lower = query.toLowerCase();
  const result: FileEntry[] = [];
  for (const entry of entries) {
    if (entry.isDirectory) {
      const filteredChildren = entry.children ? filterTree(entry.children, query) : [];
      if (entry.name.toLowerCase().includes(lower) || filteredChildren.length > 0) {
        result.push({ ...entry, children: filteredChildren });
      }
    } else {
      if (entry.name.toLowerCase().includes(lower)) {
        result.push(entry);
      }
    }
  }
  return result;
}

// ==================== 主组件 ====================

export function FileExplorer({ cwd, onFileClick, refreshKey, onFileDragStart, selectedPath }: FileExplorerProps) {
  const [tree, setTree] = useState<FileEntry[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [gitLoaded, setGitLoaded] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);
  const [searchQuery, setSearchQuery] = useState("");
  const abortRef = useRef<AbortController | null>(null);

  // Load git status on mount and when cwd changes
  useEffect(() => {
    loadGitStatus(cwd).then(() => setGitLoaded(true));
  }, [cwd]);

  // Listen for file change events → auto refresh
  useEffect(() => {
    const unsubscribe = onFileChangesTracked(() => {
      loadGitStatus(cwd).then(() => {
        // Invalidate dir cache for changed paths
        dirCache.clear();
        setRefreshTick((t) => t + 1);
      });
    });
    return unsubscribe;
  }, [cwd]);

  const loadDirectory = useCallback(async (path: string, signal?: AbortSignal, forceRefresh?: boolean): Promise<FileEntry[]> => {
    if (!forceRefresh) {
      const cached = dirCache.get(path);
      if (cached) return cached;
    } else {
      dirCache.delete(path);
    }

    let entries: FileEntry[];
    entries = await loadDirectoryFromTauri(path);

    if (entries.length > 0) {
      dirCache.set(path, entries);
    }
    return entries;
  }, []);

  useEffect(() => {
    abortRef.current?.abort();
    abortRef.current = new AbortController();
    setLoading(true);
    const isRefresh = refreshKey !== undefined && refreshKey > 0;
    loadDirectory(cwd, abortRef.current.signal, isRefresh).then((entries) => {
      // Attach git status to entries
      const statusMap = gitStatusCache.get(cwd);
      if (statusMap) {
        const attachStatus = (entries: FileEntry[]): FileEntry[] => {
          return entries.map((e) => {
            const status = getGitStatus(cwd, e.path);
            return { ...e, gitStatus: status, children: e.children ? attachStatus(e.children) : undefined };
          });
        };
        entries = attachStatus(entries);
      }
      setTree(entries);
      setLoading(false);
    });
    return () => abortRef.current?.abort();
  }, [cwd, loadDirectory, refreshKey, refreshTick, gitLoaded]);

  const toggleExpand = useCallback(async (path: string) => {
    const next = new Set(expanded);
    if (next.has(path)) {
      next.delete(path);
    } else {
      next.add(path);
      const entry = findEntry(tree, path);
      if (entry && !entry.children) {
        const children = await loadDirectory(path);
        entry.children = children;
        setTree([...tree]);
      }
    }
    setExpanded(next);
  }, [expanded, tree, loadDirectory]);

  // Sorted + filtered tree
  const displayTree = useMemo(() => {
    const sorted = sortEntries(tree);
    return searchQuery ? filterTree(sorted, searchQuery) : sorted;
  }, [tree, searchQuery]);

  // Auto-expand all directories when searching (so filtered results are visible)
  useEffect(() => {
    if (searchQuery) {
      const allDirs = new Set<string>();
      const collectDirs = (entries: FileEntry[]) => {
        for (const e of entries) {
          if (e.isDirectory) {
            allDirs.add(e.path);
            if (e.children) collectDirs(e.children);
          }
        }
      };
      collectDirs(displayTree);
      setExpanded(allDirs);
    }
  }, [searchQuery]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="file-explorer">
      {/* 搜索栏 — 对标 wecode WorkspaceFileTree 搜索栏 */}
      <div className="file-explorer-search">
        <div className="file-explorer-search-bar">
          <Search size={14} className="file-explorer-search-icon" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="筛选文件..."
            className="file-explorer-search-input"
          />
          <button
            className="file-explorer-search-refresh"
            onClick={() => {
              dirCache.clear();
              setRefreshTick((t) => t + 1);
            }}
            title="刷新"
          >
            <RefreshCw size={14} />
          </button>
        </div>
      </div>

      <div className="file-tree">
        {loading && <div className="file-loading">正在加载...</div>}
        {!loading && displayTree.length === 0 && (
          <div className="file-empty">{searchQuery ? "无匹配文件" : "无法加载目录"}</div>
        )}
        {displayTree.map((entry) => (
          <FileEntryNode
            key={entry.path}
            entry={entry}
            depth={0}
            expanded={expanded}
            onToggle={toggleExpand}
            onFileClick={onFileClick}
            onFileDragStart={onFileDragStart}
            selectedPath={selectedPath}
          />
        ))}
      </div>
    </div>
  );
}

// ==================== 文件树节点 ====================

interface FileEntryNodeProps {
  entry: FileEntry;
  depth: number;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  onFileClick?: (path: string) => void;
  onFileDragStart?: (path: string, name: string) => void;
  selectedPath?: string | null;
}

const GIT_STATUS_BADGES: Record<string, { label: string; className: string }> = {
  M: { label: "M", className: "git-status-modified" },
  A: { label: "A", className: "git-status-added" },
  D: { label: "D", className: "git-status-deleted" },
  U: { label: "U", className: "git-status-untracked" },
  R: { label: "R", className: "git-status-renamed" },
};

const FileEntryNode = memo(function FileEntryNode({ entry, depth, expanded, onToggle, onFileClick, onFileDragStart, selectedPath }: FileEntryNodeProps) {
  const isExpanded = expanded.has(entry.path);
  const isSelected = selectedPath === entry.path;
  const Icon = entry.isDirectory
    ? (isExpanded ? FolderOpen : Folder)
    : getFileIcon(entry.name);
  const gitBadge = entry.gitStatus ? GIT_STATUS_BADGES[entry.gitStatus] : null;
  const className = "file-entry " + (entry.isDirectory ? "directory" : "file")
    + (entry.gitStatus ? " git-changed" : "")
    + (isSelected ? " selected" : "");

  return (
    <div>
      <div
        className={className}
        style={{ paddingLeft: (8 + depth * 14) + "px" }}
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
            onToggle(entry.path);
          } else {
            onFileClick?.(entry.path);
          }
        }}
        title={entry.path}
      >
        <Icon size={14} className="file-entry-icon" />
        <span className="file-name">{entry.name}</span>
        {gitBadge && (
          <span className={"git-status-badge " + gitBadge.className}>{gitBadge.label}</span>
        )}
      </div>
      {entry.isDirectory && isExpanded && entry.children && (
        <div className="file-children">
          {sortEntries(entry.children).map((child) => (
            <FileEntryNode
              key={child.path}
              entry={child}
              depth={depth + 1}
              expanded={expanded}
              onToggle={onToggle}
              onFileClick={onFileClick}
              onFileDragStart={onFileDragStart}
              selectedPath={selectedPath}
            />
          ))}
        </div>
      )}
    </div>
  );
});

function findEntry(entries: FileEntry[], path: string): FileEntry | null {
  for (const e of entries) {
    if (e.path === path) return e;
    if (e.children) {
      const found = findEntry(e.children, path);
      if (found) return found;
    }
  }
  return null;
}
