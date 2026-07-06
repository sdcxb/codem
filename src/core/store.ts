import { create } from "zustand";
import type { Project, Session, ProjectSkill, ProjectMemory, ProjectInstructions, ProjectConfig, Attachment } from "./types";
import * as ProjectStorage from "./storage/project";
import * as SessionStorage from "./storage/session";

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
    try { ProjectStorage.createProject(project); } catch (e) { console.error("[Store] createProject save failed:", e); }
    const updated = [...get().projects, project];
    set({ projects: updated, currentProject: project, sessions: [] });
    return project;
  },

  openProject: (projectId) => {
    const project = get().projects.find((p) => p.id === projectId);
    if (!project) return;
    let sessions: Session[] = [];
    try { sessions = SessionStorage.listSessions(projectId); } catch {}
    try { ProjectStorage.updateProject(projectId, { lastAccessedAt: Date.now() }); } catch {}
    set({ currentProject: { ...project, lastAccessedAt: Date.now() }, currentSession: null, sessions });
  },

  deleteProject: (projectId) => {
    try { ProjectStorage.deleteProject(projectId); } catch {}
    try { for (const s of SessionStorage.listSessions(projectId)) SessionStorage.deleteSession(s.id); } catch {}
    set({
      projects: get().projects.filter((p) => p.id !== projectId),
      currentProject: get().currentProject?.id === projectId ? null : get().currentProject,
    });
  },

  setProjects: (projects) => set({ projects }),

  updateProject: (projectId, update) => {
    try { ProjectStorage.updateProject(projectId, { ...update, lastAccessedAt: Date.now() }); } catch {}
    const projects = get().projects.map((p) => p.id === projectId ? { ...p, ...update, lastAccessedAt: Date.now() } : p);
    set({ projects, currentProject: get().currentProject?.id === projectId ? { ...get().currentProject!, ...update } : get().currentProject });
  },

  getProjectSessions: (pid) => { try { return SessionStorage.listSessions(pid); } catch { return []; } },

  createSession: (title) => {
    const project = get().currentProject;
    const newId = generateId();
    console.log(`[createSession] Creating new session: ${newId}, project: ${project?.id}`);
    const session: Session = { id: newId, projectId: project?.id || "", title: title || `对话 ${get().sessions.length + 1}`, createdAt: Date.now(), lastMessageAt: Date.now(), messageCount: 0, attachments: [] };
    try { SessionStorage.createSession(session); } catch (e) { console.error("[Store] createSession failed:", e); }
    const updated = [...get().sessions, session];
    set({ sessions: updated, currentSession: session });
    console.log(`[createSession] Set currentSession to: ${session.id}`);
    return session;
  },

  forkSession: (sourceSessionId, messageIndex) => {
    const project = get().currentProject;
    if (!project) throw new Error("No project selected");
    const newSession: Session = { id: generateId(), projectId: project.id, title: "分叉自对话", createdAt: Date.now(), lastMessageAt: Date.now(), messageCount: 0, attachments: [] };
    try { SessionStorage.createSession(newSession); } catch {}
    const updated = [...get().sessions, newSession];
    set({ sessions: updated, currentSession: newSession });
    return newSession;
  },

  switchSession: (sessionId) => { const s = get().sessions.find((s) => s.id === sessionId); if (s) set({ currentSession: s }); },

  deleteSession: (sessionId) => {
    try { SessionStorage.deleteSession(sessionId); } catch {}
    set({ sessions: get().sessions.filter((s) => s.id !== sessionId), currentSession: get().currentSession?.id === sessionId ? null : get().currentSession });
  },

  setSessions: (sessions) => set({ sessions }),

  updateSession: (sessionId, update) => {
    try { SessionStorage.updateSession(sessionId, { ...update, lastMessageAt: Date.now() }); } catch {}
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
