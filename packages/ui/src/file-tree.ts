/**
 * 文件树的**纯数据层**：图标映射、目录优先排序、搜索过滤、Git 状态徽章、尺寸文案。
 *
 * 桌面 `src/components/FileExplorer.tsx` 与手机壳（`packages/ui/src/file-browser.tsx`）
 * 共用这一份；这里没有任何宿主依赖（不碰 Tauri / store / 子进程），
 * 数据从哪来由宿主注入（桌面 `list_directory`，手机 `workspace.list`）。
 */
import {
  Database,
  FileArchive,
  FileCode,
  FileCog,
  FileImage,
  FileJson,
  FileTerminal,
  FileText,
  FileType,
  FileVideo,
  type LucideIcon,
} from "lucide-react";

/** 文件树条目（桌面 Tauri payload 与手机 `workspace.list` 条目的公共形状） */
export interface FileTreeEntry {
  name: string;
  /** 完整路径（桌面绝对路径；手机是相对工作区路径） */
  path: string;
  isDirectory: boolean;
  children?: FileTreeEntry[];
  /** M, A, D, U, R（桌面 Git 状态；手机暂不提供） */
  gitStatus?: string;
  /** 字节数（手机列表显示；桌面不传） */
  size?: number;
}

// ==================== 文件类型图标映射（对标 wecode complete icon set） ====================

export const EXT_ICON_MAP: Record<string, LucideIcon> = {
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

export function getFileIcon(name: string): LucideIcon {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  return EXT_ICON_MAP[ext] || FileText;
}

// ==================== 排序：目录优先 + 字母序 ====================

export function sortEntries(entries: FileTreeEntry[]): FileTreeEntry[] {
  return [...entries].sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) {
      return a.isDirectory ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });
}

// ==================== 搜索过滤 ====================

export function filterTree(entries: FileTreeEntry[], query: string): FileTreeEntry[] {
  if (!query) return entries;
  const lower = query.toLowerCase();
  const result: FileTreeEntry[] = [];
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

export function findEntry(entries: FileTreeEntry[], path: string): FileTreeEntry | null {
  for (const e of entries) {
    if (e.path === path) return e;
    if (e.children) {
      const found = findEntry(e.children, path);
      if (found) return found;
    }
  }
  return null;
}

// ==================== Git 状态徽章 ====================

export const GIT_STATUS_BADGES: Record<string, { label: string; className: string }> = {
  M: { label: "M", className: "git-status-modified" },
  A: { label: "A", className: "git-status-added" },
  D: { label: "D", className: "git-status-deleted" },
  U: { label: "U", className: "git-status-untracked" },
  R: { label: "R", className: "git-status-renamed" },
};

// ==================== 尺寸文案 ====================

export function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
