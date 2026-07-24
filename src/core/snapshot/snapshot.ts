import { readFile as apiReadFile, writeFile as apiWriteFile, listDirectory, deletePath } from "../file-api";

// ========== Snapshot Types ==========
export interface SnapshotFile {
  path: string;
  content: string;
  hash: string;
  timestamp: number;
  /** true 表示该文件在快照创建前不存在（AI 新建的文件），回滚时应删除而非写空内容 */
  isNew?: boolean;
}

export interface Snapshot {
  id: string;
  sessionId: string;
  messageIndex: number;
  files: SnapshotFile[];
  timestamp: number;
  description?: string;
}

export interface FileChange {
  path: string;
  type: "added" | "modified" | "deleted";
  before?: string;
  after?: string;
}

export interface SnapshotConfig {
  storageDir: string;
  maxSnapshots: number;
  ignorePatterns: string[];
}

const DEFAULT_CONFIG: SnapshotConfig = {
  storageDir: ".codem-snapshots",
  maxSnapshots: 50,
  ignorePatterns: ["node_modules", ".git", ".codem-snapshots"],
};

// ========== Path Helper ==========
/** 拼接路径，处理多余的分隔符 */
function joinPath(...parts: string[]): string {
  return parts
    .map((p, i) => (i === 0 ? p.replace(/[\\/]+$/, "") : p.replace(/^[\\/]+|[\\/]+$/g, "")))
    .filter((p) => p.length > 0)
    .join("\\");
}

// ========== File API Helpers ==========
async function apiGet(path: string): Promise<string> {
  return apiReadFile(path);
}

async function apiWrite(path: string, content: string): Promise<void> {
  await apiWriteFile(path, content);
}

async function apiMkdir(path: string): Promise<void> {
  const isTauri = !!(window as any).__TAURI__;
  if (isTauri) {
    try {
      const { invoke } = (window as any).__TAURI__.core;
      await invoke("execute_command", { command: `mkdir "${path}"` });
    } catch {}
  }
}

async function apiList(path: string): Promise<Array<{ name: string; path: string; isDirectory: boolean }>> {
  return listDirectory(path);
}

async function apiDelete(path: string): Promise<void> {
  await deletePath(path);
}

function simpleHash(content: string): string {
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

// ========== Snapshot Service ==========
export class SnapshotService {
  private cwd: string;
  private config: SnapshotConfig;

  constructor(cwd: string, config?: Partial<SnapshotConfig>) {
    this.cwd = cwd;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  private get snapshotDir() {
    return joinPath(this.cwd, this.config.storageDir);
  }

  private getSnapshotPath(snapshotId: string): string {
    return joinPath(this.snapshotDir, `${snapshotId}.json`);
  }

  async create(sessionId: string, messageIndex: number, description?: string): Promise<Snapshot> {
    const id = `snap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const snapshot: Snapshot = {
      id,
      sessionId,
      messageIndex,
      files: [],
      timestamp: Date.now(),
      description,
    };

    await apiMkdir(this.snapshotDir);
    await apiWrite(this.getSnapshotPath(id), JSON.stringify(snapshot, null, 2));

    // 清理超出上限的旧快照
    await this.pruneOldSnapshots();

    return snapshot;
  }

  async recordFile(snapshotId: string, filePath: string, content: string, isNew: boolean = false): Promise<void> {
    const snapshotPath = this.getSnapshotPath(snapshotId);
    try {
      const data = await apiGet(snapshotPath);
      const snapshot: Snapshot = JSON.parse(data);

      // 避免重复记录同一文件
      const existingIdx = snapshot.files.findIndex((f) => f.path === filePath);
      const fileEntry: SnapshotFile = {
        path: filePath,
        content,
        hash: simpleHash(content),
        timestamp: Date.now(),
        isNew,
      };
      if (existingIdx >= 0) {
        snapshot.files[existingIdx] = fileEntry;
      } else {
        snapshot.files.push(fileEntry);
      }

      await apiWrite(snapshotPath, JSON.stringify(snapshot, null, 2));
    } catch {}
  }

  async restore(snapshotId: string): Promise<FileChange[]> {
    const snapshotPath = this.getSnapshotPath(snapshotId);
    const data = await apiGet(snapshotPath);
    const snapshot: Snapshot = JSON.parse(data);
    const changes: FileChange[] = [];

    for (const file of snapshot.files) {
      // 读取当前文件内容（回滚前）
      let before = "";
      let fileExists = false;
      try {
        before = await apiGet(file.path);
        fileExists = true;
      } catch {}

      if (file.isNew) {
        // 新建的文件 → 回滚时删除
        if (fileExists) {
          await apiDelete(file.path);
        }
        changes.push({
          path: file.path,
          type: "deleted",
          before,
          after: undefined,
        });
      } else {
        // 已有文件 → 恢复原始内容
        await apiWrite(file.path, file.content);
        changes.push({
          path: file.path,
          type: fileExists ? "modified" : "added",
          before,
          after: file.content,
        });
      }
    }

    return changes;
  }

  async getAll(): Promise<Snapshot[]> {
    try {
      const entries = await apiList(this.snapshotDir);
      const snapshots: Snapshot[] = [];
      for (const entry of entries) {
        if (entry.name.endsWith(".json")) {
          try {
            const data = await apiGet(entry.path);
            snapshots.push(JSON.parse(data));
          } catch {}
        }
      }
      return snapshots.sort((a, b) => b.timestamp - a.timestamp);
    } catch {
      return [];
    }
  }

  /** 删除单个快照 */
  async delete(snapshotId: string): Promise<void> {
    const snapshotPath = this.getSnapshotPath(snapshotId);
    await apiDelete(snapshotPath);
  }

  /** 清理超出 maxSnapshots 上限的旧快照 */
  private async pruneOldSnapshots(): Promise<void> {
    try {
      const all = await this.getAll();
      if (all.length <= this.config.maxSnapshots) return;

      // getAll 已按时间倒序排列，删除最旧的
      const toDelete = all.slice(this.config.maxSnapshots);
      for (const snapshot of toDelete) {
        await apiDelete(this.getSnapshotPath(snapshot.id));
      }
    } catch {}
  }
}

// ========== Singleton ==========
const instances = new Map<string, SnapshotService>();

export function getSnapshotService(cwd: string): SnapshotService {
  if (!instances.has(cwd)) {
    instances.set(cwd, new SnapshotService(cwd));
  }
  return instances.get(cwd)!;
}
