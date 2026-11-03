/**
 * 文件树（桌面侧边栏 / 面板侧栏 / 插件槽）—— **平台适配器**。
 *
 * 行的结构、图标、排序、搜索过滤、Git 徽章与样式只有一份，在
 * `packages/ui/src/{file-tree,file-tree-view}.tsx`（手机壳文件浏览用同一个组件）。
 * 这里只保留桌面**平台能力**：
 * - `list_directory`（`showHidden: true`）与 `git status --porcelain` 两个 Tauri 调用；
 * - 目录缓存 / Git 状态缓存及其失效（`onFileChangesTracked`）；
 * - 展开状态与"展开即懒加载子目录"的取数时序；
 * - 搜索词（受控）与刷新（清缓存）。
 *
 * 数据形状就是 Tauri 返回的形状（`FileTreeEntry`），不再存在第二份条目类型。
 */
import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { Spinner } from "./ui/Spinner";
import { onFileChangesTracked } from "../core/environment/file-change-tracker";
import { FileTree, type FileTreeStrings } from "../../packages/ui/src/file-tree-view";
import { filterTree, findEntry, sortEntries, type FileTreeEntry } from "../../packages/ui/src/file-tree";

type FileEntry = FileTreeEntry;

interface FileExplorerProps {
  cwd: string;
  onFileClick?: (path: string) => void;
  refreshKey?: number;
  /** Called when a file is dragged out of the file explorer (for composer drop) */
  onFileDragStart?: (path: string, name: string) => void;
  /** Currently selected file path (for highlight) */
  selectedPath?: string | null;
}

/** 桌面文案（接线判据用同一对象比对共享层渲染结果） */
export const DESKTOP_FILE_TREE_STRINGS: FileTreeStrings = {
  searchPlaceholder: "筛选文件...",
  refreshTitle: "刷新",
  loading: "正在加载...",
  empty: "无法加载目录",
  emptySearch: "无匹配文件",
};

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
    <FileTree
      entries={displayTree}
      strings={DESKTOP_FILE_TREE_STRINGS}
      expanded={expanded}
      onToggle={(path) => void toggleExpand(path)}
      onOpenFile={onFileClick}
      onFileDragStart={onFileDragStart}
      selectedPath={selectedPath}
      query={searchQuery}
      onQueryChange={setSearchQuery}
      onRefresh={() => {
        dirCache.clear();
        setRefreshTick((t) => t + 1);
      }}
      loading={loading}
      loadingSlot={<Spinner size="sm" label="" />}
    />
  );
}
