import { readFile as apiReadFile, writeFile as apiWriteFile, listDirectory } from "../file-api";

// ========== Snapshot Types ==========
export interface SnapshotFile {
  path: string;
  content: string;
  hash: string;
  timestamp: number;
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
  storageDir: ".mimo-snapshots",
  maxSnapshots: 50,
  ignorePatterns: ["node_modules", ".git", ".mimo-snapshots"],
};

// ========== Helpers ==========
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
    return `${this.cwd}\\${this.config.storageDir}`;
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
    await apiWrite(`${this.snapshotDir}\\${id}.json`, JSON.stringify(snapshot, null, 2));
    return snapshot;
  }

  async recordFile(snapshotId: string, filePath: string, content: string): Promise<void> {
    const snapshotPath = `${this.snapshotDir}\\${snapshotId}.json`;
    try {
      const data = await apiGet(snapshotPath);
      const snapshot: Snapshot = JSON.parse(data);
      snapshot.files.push({
        path: filePath,
        content,
        hash: simpleHash(content),
        timestamp: Date.now(),
      });
      await apiWrite(snapshotPath, JSON.stringify(snapshot, null, 2));
    } catch {}
  }

  async restore(snapshotId: string): Promise<FileChange[]> {
    const snapshotPath = `${this.snapshotDir}\\${snapshotId}.json`;
    const data = await apiGet(snapshotPath);
    const snapshot: Snapshot = JSON.parse(data);
    const changes: FileChange[] = [];

    for (const file of snapshot.files) {
      let before = "";
      try {
        before = await apiGet(file.path);
      } catch {}

      await apiWrite(file.path, file.content);
      changes.push({
        path: file.path,
        type: before ? "modified" : "added",
        before,
        after: file.content,
      });
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
}

// ========== Singleton ==========
const instances = new Map<string, SnapshotService>();

export function getSnapshotService(cwd: string): SnapshotService {
  if (!instances.has(cwd)) {
    instances.set(cwd, new SnapshotService(cwd));
  }
  return instances.get(cwd)!;
}
