import { readFile as apiReadFile, writeFile as apiWriteFile, listDirectory, deleteDirectoryPermanent, deleteFile, deletePath } from "../file-api";

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
      // Use the dedicated Rust make_directory command — no shell interpretation
      // (previous `mkdir "${path}"` via PowerShell could break on paths with
      // PowerShell metacharacters).
      await invoke("make_directory", { path });
    } catch (e) { console.warn('[snapshot.ts]', e) }
  }
}

async function apiList(path: string): Promise<Array<{ name: string; path: string; isDirectory: boolean }>> {
  return listDirectory(path);
}

async function apiDelete(path: string): Promise<void> {
  /**
   * ## ⚠️ 第 47 轮补（UI/UX 审计 P0）：**回滚删掉的用户文件必须进回收站**
   *
   * 这里原来一律走 `deleteDirectoryPermanent`（永久删除、不进回收站）。
   * 那条规则的注释写着"快照目录是应用自管数据" —— 但**这个函数也被"回滚"用来删
   * 用户工作区里的文件**（`restore()` 对 `isNew` 的文件调它）：用户点一次「回滚到此快照」，
   * 此后新建的**源码文件就被永久抹掉**，只能靠记忆重写。
   *
   * 现在分两种情况：
   * - 应用自管目录（快照目录自身）→ 仍然永久删除（删掉只是重新生成，回收站没有价值）；
   * - **用户工作区文件** → 走 `deletePath`（`delete_file` / `delete_directory`），
   *   而 Rust 侧的 `delete_directory` 用的是 `SHFileOperationW` +
   *   `FOF_SILENT | FOF_NOCONFIRMATION | FOF_NOERRORUI | FOF_ALLOWUNDO`
   *   —— **对话框全部抑制、且带 `ALLOWUNDO`**，所以既不会卡在无人可点的对话框上
   *   （这正是历史上放弃 PowerShell+回收站方案的原因），又真的能撤回来。
   */
  const n = path.replace(/\//g, "\\").toLowerCase();
  const isAppOwned = n.includes("\\.codem-snapshots\\") || n.includes("\\.codem\\snapshots\\");
  if (isAppOwned) {
    try {
      await deleteDirectoryPermanent(path);
      return;
    } catch {
      await deleteFile(path);
      return;
    }
  }
  // 用户工作区文件：优先回收站（可撤销），失败再退回永久删除（宁可删掉也不能卡住）
  try {
    await deletePath(path);
  } catch (e) {
    console.warn("[snapshot] 回收站删除失败，退回永久删除:", e);
    await deleteFile(path);
  }
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
    } catch (e) { console.warn('[snapshot.ts]', e) }
  }

  /**
   * ## ⚠️ 第 47 轮补（UI/UX 审计 P0）：回滚前先算清"会动什么"，并**自动留一份回滚前快照**
   *
   * 原来的 `restore()` 直接开干：覆盖文件、永久删除"快照之后新建的文件"，
   * 而**回滚前的状态只被读进 `FileChange.before` 用于打印一句"N 个文件"，随即丢弃**。
   * 也就是说一次误点 = 用户此后所有手工/agent 的修改全部消失，**没有任何路径拿回来**。
   *
   * 现在：
   * 1. `preview()` 先算出"将覆盖哪些、将删除哪些"（**不写任何东西**），
   *    供 UI 在确认框里写清真实影响（"将覆盖 3 个文件、删除 2 个文件"），
   *    而不是让用户点一个"回滚到此快照"按钮去猜；
   * 2. `restore()` 在动手**之前**创建一份"回滚前自动快照"，把这批文件的**当前内容**
   *    存进去 —— 于是"回滚"本身变成**可撤销**的（用那份自动快照再回滚一次即可）。
   *    这一步失败**不阻断**回滚（否则回滚就变成"可能失败的操作"），
   *    但要如实上报：用户必须知道"这次回滚之后没有后悔药"。
   */
  async preview(snapshotId: string): Promise<{
    willModify: string[];
    willDelete: string[];
    /** 快照里记录的文件总数 */
    total: number;
  }> {
    const data = await apiGet(this.getSnapshotPath(snapshotId));
    const snapshot: Snapshot = JSON.parse(data);
    const willModify: string[] = [];
    const willDelete: string[] = [];
    for (const file of snapshot.files) {
      let fileExists = false;
      try {
        await apiGet(file.path);
        fileExists = true;
      } catch {
        /* 不存在 */
      }
      // `isNew` = "这个文件是本快照**之后**新建的" → 回滚要把它删掉
      if (file.isNew) {
        if (fileExists) willDelete.push(file.path);
      } else {
        willModify.push(file.path);
      }
    }
    return { willModify, willDelete, total: snapshot.files.length };
  }

  async restore(snapshotId: string): Promise<FileChange[]> {
    const snapshotPath = this.getSnapshotPath(snapshotId);
    const data = await apiGet(snapshotPath);
    const snapshot: Snapshot = JSON.parse(data);
    const changes: FileChange[] = [];

    /*
     * ① 回滚**之前**：把这批文件"现在的样子"存成一份自动快照。
     * 存的是**当前**内容（`isNew: false`），所以拿它再回滚一次就能退回"回滚前"。
     * 失败不阻断，但要如实上报（见下）。
     */
    let preRollbackSnapshotId: string | null = null;
    try {
      const pre = await this.create(
        snapshot.sessionId,
        snapshot.messageIndex,
        `回滚前自动快照（回滚到 ${snapshotId} 之前的状态）`,
      );
      for (const file of snapshot.files) {
        try {
          const current = await apiGet(file.path);
          await this.recordFile(pre.id, file.path, current, false);
        } catch {
          /* 当前不存在：那份"回滚前快照"里本来就不该有它 */
        }
      }
      preRollbackSnapshotId = pre.id;
    } catch (e) {
      console.warn("[snapshot] 回滚前自动快照创建失败（本次回滚将不可撤销）:", e);
    }

    for (const file of snapshot.files) {
      // 读取当前文件内容（回滚前）
      let before = "";
      let fileExists = false;
      try {
        before = await apiGet(file.path);
        fileExists = true;
      } catch (e) { console.warn('[snapshot.ts]', e) }

      if (file.isNew) {
        // 新建的文件 → 回滚时删除（现在走回收站，见 `apiDelete` 的长注释）
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

    /**
     * ② 把"回滚前快照"的 id 挂到这次结果上（UI 可以据此提示"可用它撤销本次回滚"）。
     * 用 `changes` 之外的一条记录承载：调用方本来就要展示 changes，
     * 多一个字段不会破坏既有调用点（它们是按 `type` 渲染的）。
     */
    if (preRollbackSnapshotId) {
      (changes as FileChange[] & { preRollbackSnapshotId?: string }).preRollbackSnapshotId =
        preRollbackSnapshotId;
    }
    return changes;
  }

  /**
   * 列出全部快照。
   *
   * ## ⚠️ 第 47 轮补（UI/UX 审计 P1）：**"读不到"必须抛出，不许返回空数组**
   *
   * 这里原来的 `catch { return [] }` 让"读不到"与"确实没有快照"变成同一件事，
   * 于是调用方（`SnapshotPanel`）那个 `readFailed` 守卫**永远不可能为真**、
   * 那个"快照列表读取失败，请重试"的分支**永不渲染** —— 用户看到的是「暂无快照」，
   * 以为快照丢了，实际只是没读到。
   *
   * 更糟的是它被测试掩盖了：`renderer-leaks-b.test.ts` 把 `getAll` 打桩成 throw，
   * 所以那条断言永远是绿的（**测试双比实现宽松**的经典形态，本仓库第 46/47 轮
   * 已经因此栽过几次）。把打桩去掉、直接驱动真实实现，才看得见这个缺陷。
   *
   * 现在的语义：
   * - **列目录失败**（引擎/目录读不出来）→ **抛出**，调用方据此显示"读取失败"；
   * - **单个快照文件损坏** → 跳过并计数（一个坏文件不该让整张列表消失），
   *   但要如实告警；
   * - 目录存在但没有快照 → 返回 `[]`（这才是真的"暂无快照"）。
   */
  async getAll(): Promise<Snapshot[]> {
    const entries = await apiList(this.snapshotDir); // 读不到就抛，交给调用方处置
    const snapshots: Snapshot[] = [];
    let skipped = 0;
    for (const entry of entries) {
      if (entry.name.endsWith(".json")) {
        try {
          const data = await apiGet(entry.path);
          snapshots.push(JSON.parse(data));
        } catch (e) {
          skipped += 1;
          console.warn(`[snapshot] 快照文件读取/解析失败，已跳过：${entry.path}`, e);
        }
      }
    }
    if (skipped > 0) {
      console.warn(`[snapshot] 本次列快照跳过了 ${skipped} 个损坏/读不到的文件（其余 ${snapshots.length} 个正常）`);
    }
    return snapshots.sort((a, b) => b.timestamp - a.timestamp);
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
    } catch (e) { console.warn('[snapshot.ts]', e) }
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
