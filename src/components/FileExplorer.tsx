import { useState, useEffect, useCallback, useRef, memo } from "react";

interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  children?: FileEntry[];
}

interface FileExplorerProps {
  cwd: string;
  onFileClick?: (path: string) => void;
  refreshKey?: number;
}

// Directory cache shared across instances
const dirCache = new Map<string, FileEntry[]>();

async function loadDirectoryFromTauri(path: string): Promise<FileEntry[]> {
  try {
    const { invoke } = (window as any).__TAURI__.core;
    const entries = await invoke("list_directory", { path });
    return entries || [];
  } catch {
    return [];
  }
}

export function FileExplorer({ cwd, onFileClick, refreshKey }: FileExplorerProps) {
  const [tree, setTree] = useState<FileEntry[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

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
      setTree(entries);
      setLoading(false);
    });
    return () => abortRef.current?.abort();
  }, [cwd, loadDirectory, refreshKey]);

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
        {loading && <div className="file-loading">加载中...</div>}
        {!loading && tree.length === 0 && (
          <div className="file-empty">无法加载目录</div>
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

const FileEntryNode = memo(function FileEntryNode({ entry, depth, expanded, onToggle, onFileClick }: FileEntryNodeProps) {
  const isExpanded = expanded.has(entry.path);
  const icon = entry.isDirectory ? (isExpanded ? "📂" : "📁") : getFileIcon(entry.name);

  return (
    <div>
      <div
        className={`file-entry ${entry.isDirectory ? "directory" : "file"}`}
        style={{ paddingLeft: `${12 + depth * 16}px` }}
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
    ts: "📘", tsx: "📘", js: "📗", jsx: "📗",
    json: "📋", md: "📝", css: "🎨", html: "🌐",
    py: "🐍", rs: "🦀", go: "💎", java: "☕",
    sh: "⚙️", bat: "⚙️", exe: "⚙️",
    png: "🖼️", jpg: "🖼️", gif: "🖼️", svg: "🖼️",
    zip: "📦", tar: "📦",
  };
  return icons[ext || ""] || "📄";
}
