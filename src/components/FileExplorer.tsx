import { useState, useEffect, useCallback, useRef, memo } from "react";
import { onFileChangesTracked } from "../core/environment/file-change-tracker";

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
}

// Directory cache shared across instances
const dirCache = new Map<string, FileEntry[]>();
// Git status cache: Map<workspacePath, Map<filePath, status>>
const gitStatusCache = new Map<string, Map<string, string>>();

async function loadDirectoryFromTauri(path: string): Promise<FileEntry[]> {
  try {
    const { invoke } = (window as any).__TAURI__.core;
    const entries = await invoke("list_directory", { path });
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

export function FileExplorer({ cwd, onFileClick, refreshKey }: FileExplorerProps) {
  const [tree, setTree] = useState<FileEntry[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [gitLoaded, setGitLoaded] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  // Load git status on mount and when cwd changes
  useEffect(() => {
    loadGitStatus(cwd).then(() => setGitLoaded(true));
  }, [cwd]);

  // Listen for file change events 鈫?auto refresh
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

  return (
    <div className="file-explorer">
      <div className="file-tree">
        {loading && <div className="file-loading">鍔犺浇涓?..</div>}
        {!loading && tree.length === 0 && (
          <div className="file-empty">鏃犳硶鍔犺浇鐩綍</div>
        )}
        {tree.map((entry) => (
          <FileEntryNode
            key={entry.path}
            entry={entry}
            depth={0}
            expanded={expanded}
            onToggle={toggleExpand}
            onFileClick={onFileClick}
          />
        ))}
      </div>
    </div>
  );
}

interface FileEntryNodeProps {
  entry: FileEntry;
  depth: number;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  onFileClick?: (path: string) => void;
}

const GIT_STATUS_BADGES: Record<string, { label: string; className: string }> = {
  M: { label: "M", className: "git-status-modified" },
  A: { label: "A", className: "git-status-added" },
  D: { label: "D", className: "git-status-deleted" },
  U: { label: "U", className: "git-status-untracked" },
  R: { label: "R", className: "git-status-renamed" },
};

const FileEntryNode = memo(function FileEntryNode({ entry, depth, expanded, onToggle, onFileClick }: FileEntryNodeProps) {
  const isExpanded = expanded.has(entry.path);
  const icon = entry.isDirectory ? (isExpanded ? "馃搨" : "馃搧") : getFileIcon(entry.name);
  const gitBadge = entry.gitStatus ? GIT_STATUS_BADGES[entry.gitStatus] : null;
  const className = "file-entry " + (entry.isDirectory ? "directory" : "file") + (entry.gitStatus ? " git-changed" : "");

  return (
    <div>
      <div
        className={className}
        style={{ paddingLeft: (12 + depth * 16) + "px" }}
        onClick={() => {
          if (entry.isDirectory) {
            onToggle(entry.path);
          } else {
            onFileClick?.(entry.path);
          }
        }}
      >
        <span className="file-icon">{icon}</span>
        <span className="file-name">{entry.name}</span>
        {gitBadge && (
          <span className={"git-status-badge " + gitBadge.className}>{gitBadge.label}</span>
        )}
      </div>
      {entry.isDirectory && isExpanded && entry.children && (
        <div className="file-children">
          {entry.children.map((child) => (
            <FileEntryNode
              key={child.path}
              entry={child}
              depth={depth + 1}
              expanded={expanded}
              onToggle={onToggle}
              onFileClick={onFileClick}
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

function getFileIcon(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase();
  const icons: Record<string, string> = {
    ts: "\u{1F4D8}", tsx: "\u{1F4D8}", js: "\u{1F4D7}", jsx: "\u{1F4D7}",
    json: "\u{1F4CB}", md: "\u{1F4DD}", css: "\u{1F3A8}", html: "\u{1F310}",
    py: "\u{1F40D}", rs: "\u{1F980}", go: "\u{1F48E}", java: "\u2615",
    sh: "\u2699\uFE0F", bat: "\u2699\uFE0F", exe: "\u2699\uFE0F",
    png: "\u{1F5BC}\uFE0F", jpg: "\u{1F5BC}\uFE0F", gif: "\u{1F5BC}\uFE0F", svg: "\u{1F5BC}\uFE0F",
    zip: "\u{1F4E6}", tar: "\u{1F4E6}",
  };
  return icons[ext || ""] || "\u{1F4C4}";
}

