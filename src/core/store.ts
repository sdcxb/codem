import { create } from "zustand";
import type { Project, Session, ProjectSkill, ProjectMemory, ProjectInstructions, ProjectConfig, Attachment } from "./types";
import * as ProjectStorage from "./storage/project";
import * as SessionStorage from "./storage/session";
import { getProjectExecutionMode, createWorktree, removeWorktree, getWorktreeRoot } from "./environment";
import { reportPersistFailure, reportActionFailure } from "./storage/persist-failure";

interface ProjectState {
  currentProject: Project | null;
  currentSession: Session | null;
  projects: Project[];
  sessions: Session[];
  skills: ProjectSkill[];
  memories: ProjectMemory[];
  instructions: ProjectInstructions;
  config: ProjectConfig;
  dbReady: boolean;

  createProject: (name: string, path: string, description?: string) => Project;
  openProject: (projectId: string) => void;
  deleteProject: (projectId: string) => void;
  setProjects: (projects: Project[]) => void;
  updateProject: (projectId: string, update: Partial<Project>) => void;
  getProjectSessions: (projectId: string) => Session[];

  createSession: (title?: string) => Session;
  forkSession: (sourceSessionId: string, messageIndex: number) => Session;
  switchSession: (sessionId: string) => void;
  deleteSession: (sessionId: string) => void;
  setSessions: (sessions: Session[]) => void;
  updateSession: (sessionId: string, update: Partial<Session>) => void;
  renameSession: (sessionId: string, title: string) => void;

  addAttachment: (sessionId: string, attachment: Attachment) => void;
  removeAttachment: (sessionId: string, attachmentId: string) => void;

  addSkill: (skill: ProjectSkill) => void;
  removeSkill: (name: string) => void;
  updateSkill: (name: string, update: Partial<ProjectSkill>) => void;
  setSkills: (skills: ProjectSkill[]) => void;

  addMemory: (memory: ProjectMemory) => void;
  removeMemory: (id: string) => void;
  updateMemory: (id: string, update: Partial<ProjectMemory>) => void;
  setMemories: (memories: ProjectMemory[]) => void;

  setInstructions: (instructions: ProjectInstructions) => void;
  updateInstructions: (content: string) => void;

  setProjectConfig: (config: Partial<ProjectConfig>) => void;
  loadFromDB: () => void;
}

const generateId = () => `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

export const useProjectStore = create<ProjectState>((set, get) => ({
  currentProject: null,
  currentSession: null,
  projects: [],
  sessions: [],
  skills: [],
  memories: [],
  instructions: { content: "", rules: [] },
  config: { allowedTools: [], autoApprove: false },
  dbReady: false,

  loadFromDB: () => {
    try {
      const projects = ProjectStorage.listProjects();
      console.log("[Store] loadFromDB: found", projects.length, "projects");
      set({ projects, dbReady: true });
      console.log("[Store] dbReady set to true, projects:", get().projects.length);
    } catch (e) {
      console.error("[Store] loadFromDB failed:", e);
      set({ dbReady: true });
    }
  },

  createProject: (name, path, description) => {
    const project: Project = { id: generateId(), name, path, createdAt: Date.now(), lastAccessedAt: Date.now(), description };
    try { ProjectStorage.createProject(project); } catch (e) { reportPersistFailure("store.createProject", e); }
    const updated = [...get().projects, project];
    set({ projects: updated, currentProject: project, sessions: [] });
    return project;
  },

  openProject: (projectId) => {
    const project = get().projects.find((p) => p.id === projectId);
    if (!project) return;
    let sessions: Session[] = [];
    try { sessions = SessionStorage.listSessions(projectId); } catch (e) { console.warn('[store.ts]', e) }
    try { ProjectStorage.updateProject(projectId, { lastAccessedAt: Date.now() }); } catch (e) { console.warn('[store.ts]', e) }
    set({ currentProject: { ...project, lastAccessedAt: Date.now() }, currentSession: null, sessions });
  },

  deleteProject: (projectId) => {
    try { ProjectStorage.deleteProject(projectId); } catch (e) { reportPersistFailure("store.deleteProject", e); }
    try { for (const s of SessionStorage.listSessions(projectId)) SessionStorage.deleteSession(s.id); } catch (e) { console.warn('[store.ts]', e) }
    set({
      projects: get().projects.filter((p) => p.id !== projectId),
      currentProject: get().currentProject?.id === projectId ? null : get().currentProject,
    });
  },

  setProjects: (projects) => set({ projects }),

  updateProject: (projectId, update) => {
    try { ProjectStorage.updateProject(projectId, { ...update, lastAccessedAt: Date.now() }); } catch (e) { reportPersistFailure("store.updateProject", e); }
    const projects = get().projects.map((p) => p.id === projectId ? { ...p, ...update, lastAccessedAt: Date.now() } : p);
    set({ projects, currentProject: get().currentProject?.id === projectId ? { ...get().currentProject!, ...update } : get().currentProject });
  },

  getProjectSessions: (pid) => { try { return SessionStorage.listSessions(pid); } catch { return []; } },

  createSession: (title) => {
    const project = get().currentProject;
    const projectId = project?.id || "";
    const newId = generateId();
    console.log(`[createSession] Creating new session: ${newId}, project: ${projectId}`);
    // 从数据库查询实际会话数，避免内存中的 sessions 列表不同步导致编号错误
    let sessionNumber = 1;
    try {
      const existingSessions = SessionStorage.listSessions(projectId);
      sessionNumber = existingSessions.length + 1;
    } catch (e) {
      console.warn("[createSession] Failed to count existing sessions:", e);
    }
    // 如果内存中 sessions 更长，使用内存长度（防止重复编号）
    const memCount = get().sessions.length;
    if (memCount >= sessionNumber) sessionNumber = memCount + 1;
    const session: Session = {
      id: newId, projectId,
      title: title || `对话 ${sessionNumber}`,
      createdAt: Date.now(), lastMessageAt: Date.now(),
      messageCount: 0, attachments: [],
    };
    // Inherit execution mode from project preference
    if (project?.path) {
      try {
        const execMode = getProjectExecutionMode(project.path);
        session.executionMode = execMode;
      } catch (e) { console.warn('[store.ts]', e) }
    }
    // 第 84 波（B 类缺陷：假成功）：会话创建失败不能假装成功。
    // 原来异常只打一条 console.error，然后照样把该会话设为 currentSession ——
    // 用户在这个"数据库里不存在"的会话里聊天，重启后整段对话凭空消失。
    // 现在：瞬时失败重试一次；仍然失败则**明确上报**（事件 + 错误级别日志），
    // 让界面能提示用户，而不是安静地丢数据。
    let persistError: any = null;
    try {
      SessionStorage.createSession(session);
    } catch (e1) {
      console.error("[Store] createSession 写入失败，重试一次:", e1);
      try {
        SessionStorage.createSession(session);
      } catch (e2) {
        persistError = e2;
        console.error("[Store] createSession 重试仍失败（该会话只存在于内存）:", e2);
      }
    }
    if (persistError) {
      try {
        window.dispatchEvent(new CustomEvent("codem:session-persist-failed", {
          detail: { sessionId: session.id, projectId, error: persistError?.message || String(persistError) },
        }));
      } catch { /* 非浏览器环境（测试）忽略 */ }
    }
    const updated = [...get().sessions, session];
    set({ sessions: updated, currentSession: session });
    console.log(`[createSession] Set currentSession to: ${session.id}, title: ${session.title}`);
    return session;
  },

  forkSession: (sourceSessionId, messageIndex) => {
    const project = get().currentProject;
    if (!project) throw new Error("No project selected");
    const newSession: Session = { id: generateId(), projectId: project.id, title: "分叉自对话", createdAt: Date.now(), lastMessageAt: Date.now(), messageCount: 0, attachments: [] };
    // Inherit execution mode from project preference
    const execMode = getProjectExecutionMode(project.path);
    newSession.executionMode = execMode;
    // If worktree mode, create an isolated worktree for the forked session
    if (execMode === "git_worktree" && project.path) {
      try {
        const wtPath = createWorktreeSync(project.path, newSession.id);
        newSession.worktreePath = wtPath;
      } catch (e) {
        console.error("[forkSession] Failed to create worktree:", e);
        newSession.executionMode = "current_workspace";
      }
    }
    try { SessionStorage.createSession(newSession); } catch (e) { console.warn('[store.ts]', e) }
    const updated = [...get().sessions, newSession];
    set({ sessions: updated, currentSession: newSession });
    return newSession;
  },

  switchSession: (sessionId) => { const s = get().sessions.find((s) => s.id === sessionId); if (s) set({ currentSession: s }); },

  deleteSession: (sessionId) => {
    // Clean up worktree if this session had one
    const session = get().sessions.find(s => s.id === sessionId);
    if (session?.worktreePath && session.executionMode === "git_worktree") {
      const projectPath = get().currentProject?.path;
      if (projectPath) {
        removeWorktreeSync(projectPath, session.worktreePath);
      }
    }
    // Clean up the engine's per-session loop pool to free memory
    try {
      // ESM: dynamic import instead of require
      import("./llm").then(({ getLLMEngine }) => {
        const engine = getLLMEngine();
        engine.cleanupSessionLoop?.(sessionId);
      }).catch(() => {});
    } catch (e) { console.warn('[store.ts]', e) }
    // Clean up abort controller if present
    try {
      // useAppStore is in this module — no need to import from elsewhere
      // Abort controllers are managed in App.tsx's ref, not in store
    } catch (e) { console.warn('[store.ts]', e) }
    try { SessionStorage.deleteSession(sessionId); } catch (e) { console.warn('[store.ts]', e) }
    set({ sessions: get().sessions.filter((s) => s.id !== sessionId), currentSession: get().currentSession?.id === sessionId ? null : get().currentSession });
  },

  setSessions: (sessions) => set({ sessions }),

  updateSession: (sessionId, update) => {
    try { SessionStorage.updateSession(sessionId, { ...update, lastMessageAt: Date.now() }); } catch (e) { reportPersistFailure("store.updateSession", e); }
    const updated = get().sessions.map((s) => s.id === sessionId ? { ...s, ...update, lastMessageAt: Date.now() } : s);
    set({ sessions: updated, currentSession: get().currentSession?.id === sessionId ? { ...get().currentSession!, ...update } : get().currentSession });
  },

  renameSession: (id, title) => { get().updateSession(id, { title }); },

  addAttachment: (sid, att) => { const s = get().sessions.find((s) => s.id === sid); if (s) get().updateSession(sid, { attachments: [...(s.attachments || []), att] }); },
  removeAttachment: (sid, aid) => { const s = get().sessions.find((s) => s.id === sid); if (s) get().updateSession(sid, { attachments: (s.attachments || []).filter((a) => a.id !== aid) }); },

  addSkill: (skill) => set((s) => ({ skills: [...s.skills, skill] })),
  removeSkill: (name) => set((s) => ({ skills: s.skills.filter((sk) => sk.name !== name) })),
  updateSkill: (name, u) => set((s) => ({ skills: s.skills.map((sk) => sk.name === name ? { ...sk, ...u } : sk) })),
  setSkills: (skills) => set({ skills }),

  addMemory: (m) => set((s) => ({ memories: [...s.memories, m] })),
  removeMemory: (id) => set((s) => ({ memories: s.memories.filter((m) => m.id !== id) })),
  updateMemory: (id, u) => set((s) => ({ memories: s.memories.map((m) => m.id === id ? { ...m, ...u } : m) })),
  setMemories: (memories) => set({ memories }),

  setInstructions: (instructions) => set({ instructions }),
  updateInstructions: (content) => set((s) => ({ instructions: { ...s.instructions, content } })),
  setProjectConfig: (config) => set((s) => ({ config: { ...s.config, ...config } })),
}));

// ========== Worktree sync wrappers ==========
// These wrap async worktree operations for use in sync store actions.
// The async creation runs in the background; runAgenticLoop will create
// the worktree if session.worktreePath is still empty when sending a message.

function createWorktreeSync(projectPath: string, sessionId: string, branch?: string): string {
  const worktreeRoot = getWorktreeRoot(projectPath);
  const worktreePath = `${worktreeRoot}/${sessionId}`;
  // Fire async creation — persist to session on success
  createWorktree(projectPath, sessionId, branch).then((actualPath) => {
    // Persist the worktree path once creation succeeds
    try {
      const store = useProjectStore.getState();
      store.updateSession(sessionId, { worktreePath: actualPath });
    } catch (e) {
      reportPersistFailure("store.persistWorktreePath", e, "会话 worktree 路径未保存");
    }
  }).catch(e => {
    // 第 87 波：worktree 创建失败后已悄悄回退到主工作区 —— 用户必须在改动文件前知道这件事
    reportActionFailure("store.createWorktree", e, "会话已回退为在主工作区运行");
    // Mark session as fallback to local mode
    try {
      const store = useProjectStore.getState();
      store.updateSession(sessionId, { executionMode: "current_workspace" });
    } catch (e) { reportPersistFailure("store.fallbackExecutionMode", e); }
  });
  // Return predicted path immediately (will be confirmed by async callback)
  return worktreePath;
}

function removeWorktreeSync(projectPath: string, worktreePath: string): void {
  // Fire-and-forget async removal
  removeWorktree(projectPath, worktreePath).catch(e => {
    reportActionFailure("store.removeWorktree", e, "worktree 目录未清理（磁盘上会残留）");
  });
}
