export interface Project {
  id: string;
  name: string;
  path: string;
  createdAt: number;
  lastAccessedAt: number;
  description?: string;
  pinned?: boolean;
}

export interface Session {
  id: string;
  projectId: string;
  title: string;
  createdAt: number;
  lastMessageAt: number;
  messageCount: number;
  model?: string;
  attachments?: Attachment[];
  pinned?: boolean;
  /** Git worktree path for this session (worktree mode only) */
  worktreePath?: string;
  /** Execution mode: local shared workspace or isolated worktree */
  executionMode?: "current_workspace" | "git_worktree";
  /** Selected branch for worktree mode */
  worktreeBranch?: string;
  /** P1: Correction mode flag */
  correctionMode?: number;
  /** P1: Deep thinking mode flag */
  deepThinkingMode?: number;
  /** P1: Preserve executor mode flag */
  preserveExecutor?: number;
  /**
   * fork 谱系：本会话是从哪个会话分叉出来的（`null`/`undefined` = 根会话）。
   *
   * ## 为什么要进这个类型（第 54 轮）
   *
   * `sessions.parent_id` 是**迁移加的列**，读侧一直有消费者
   * （`session-search.ts` 的 `session_trace` 工具会输出 `Parent: …` / `Ancestors: […]`），
   * 而写侧原来只在 `forkSession` 里**手工往行里塞**这一个字段：
   * `[{ ...sessionToWire(child), parent_id: sourceSessionId, sort_order: null }]`。
   *
   * 关键在于**建行那条路用的是 `mode: "insert"`**（`domainWrite` 的默认值）：引擎侧是裸
   * `INSERT INTO`，落库的那一行**就是构造器给出的那些列**。于是构造器漏列在 insert 路径上是
   * **静默 NULL** —— 实体里带着 `parentId` 也进不了库。第 45 轮给子智能体补 `sessions` 行时
   * 就是这个形态：子会话行建出来了，但谱系是 NULL，`session_trace` 永远报 `Parent: (root)`。
   *
   * 现在它是 `Session` 的正常字段：构造器统一写它，写侧只有一种形状。
   *
   * ⚠️ **更正（同一轮的自查）**：本注释的初版写的是"`updateSession` / `togglePinned` /
   * `reorderSessions` 走 `replace`，而 `replace` = `INSERT OR REPLACE`，所以改名会把
   * `parent_id` 清成 NULL"。**这句话是错的**：`crud.rs:412-429` 里 `replace` 是
   * "先 UPDATE 只写本次提供的列，0 行才 INSERT"，**未提供的列保持原值**（引擎用例
   * `crud_upsert_replace_does_not_cascade_delete_children` 断言的就是这条），
   * 渲染侧镜像也合并写（`rust-port.ts:2063`）。当时"会清空"的只有测试基座，
   * 那是假端口比引擎更严格造出来的假象（已改，见 `fake-storage-port.ts`）。
   */
  parentId?: string | null;
}

export interface Attachment {
  id: string;
  name: string;
  type: "file" | "image" | "code" | "url";
  path?: string;
  content?: string;
  preview?: string;
  sandboxPath?: string;
  mimeType?: string;
  size?: number;
  addedAt: number;
}

export interface ProjectSkill {
  name: string;
  description: string;
  content: string;
  paths?: string[];
  whenToUse?: string;
  allowedTools?: string[];
}

export interface ProjectMemory {
  id: string;
  name: string;
  description: string;
  type: "user" | "feedback" | "project" | "reference";
  content: string;
  filePath?: string;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectInstructions {
  content: string;
  localContent?: string;
  rules: ProjectRule[];
}

export interface ProjectRule {
  name: string;
  content: string;
  paths?: string[];
  enabled: boolean;
}

export interface ProjectConfig {
  allowedTools: string[];
  mcpServers?: Record<string, unknown>;
  model?: string;
  autoApprove?: boolean;
}

// ========== Hierarchical Config Types ==========

export type ConfigLevel = "app" | "project" | "subfolder";

export interface HierarchicalConfig {
  level: ConfigLevel;
  basePath: string;
  agents: string;        // AGENTS.md content
  soul: string;          // SOUL.md content
  identity: IdentityConfig;
  user: UserConfig;
  tools: string;         // TOOLS.md content
  bootstrap: string;     // BOOTSTRAP.md content
  heartbeat: string;     // HEARTBEAT.md content
  exists: Record<string, boolean>;
}

export interface IdentityConfig {
  name: string;
  creature: string;
  vibe: string;
  emoji: string;
  avatar: string;
  raw: string;           // raw markdown content
}

export interface UserConfig {
  name: string;
  callBy: string;
  pronouns: string;
  timezone: string;
  notes: string;
  context: string;
  raw: string;
  /** 用户头像 URL 或 base64 data URI（空字符串表示使用默认头像） */
  avatar?: string;
}

export interface MergedConfig {
  agents: string;
  soul: string;
  identity: IdentityConfig;
  user: UserConfig;
  tools: string;
  heartbeat: string;
  hasBootstrap: boolean;
  levels: ConfigLevel[];
}

export interface AppIdentity {
  name: string;
  creature: string;
  vibe: string;
  emoji: string;
  avatar: string;
  onboarded: boolean;
}
