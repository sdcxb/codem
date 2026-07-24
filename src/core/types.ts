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
