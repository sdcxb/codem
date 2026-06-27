import { initDatabase } from "./database";
import * as ProjectStorage from "./project";
import * as SessionStorage from "./session";
import * as MessageStorage from "./message";
import type { Project, Session } from "../types";
import type { Message } from "../../store";

const PROJECTS_KEY = "mimo-projects";
const SESSIONS_PREFIX = "mimo-sessions-";
const CHAT_PREFIX = "mimo-chat-";
const SESSIONS_KEY_V2 = "mimo-sessions-v2";

interface MigrationResult {
  projects: number;
  sessions: number;
  messages: number;
  errors: string[];
}

export async function migrateFromLocalStorage(): Promise<MigrationResult> {
  const result: MigrationResult = {
    projects: 0,
    sessions: 0,
    messages: 0,
    errors: [],
  };

  try {
    // Initialize SQLite database
    await initDatabase();

    // 1. Migrate projects
    const projectsData = localStorage.getItem(PROJECTS_KEY);
    if (projectsData) {
      const projects: Project[] = JSON.parse(projectsData);
      for (const project of projects) {
        try {
          const existing = ProjectStorage.getProject(project.id);
          if (!existing) {
            ProjectStorage.createProject(project);
            result.projects++;
          }
        } catch (e) {
          result.errors.push(`Failed to migrate project ${project.id}: ${e}`);
        }
      }
    }

    // 2. Migrate sessions (from project-scoped storage)
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(SESSIONS_PREFIX)) {
        const projectId = key.slice(SESSIONS_PREFIX.length);
        try {
          const sessionsData = localStorage.getItem(key);
          if (sessionsData) {
            const sessions: Session[] = JSON.parse(sessionsData);
            for (const session of sessions) {
              const existing = SessionStorage.getSession(session.id);
              if (!existing) {
                SessionStorage.createSession(session);
                result.sessions++;
              }
            }
          }
        } catch (e) {
          result.errors.push(`Failed to migrate sessions for project ${projectId}: ${e}`);
        }
      }
    }

    // 3. Migrate chat messages
    // Key format: mimo-chat-${projectId}-${sessionId}
    // Both IDs are ${timestamp}-${random}, so split produces 5+ parts
    // Session ID = last 2 parts joined by "-"
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(CHAT_PREFIX)) {
        const remainder = key.slice(CHAT_PREFIX.length);
        const parts = remainder.split("-");
        const sessionId = parts.slice(2).join("-");
        if (sessionId) {
          try {
            const messagesData = localStorage.getItem(key);
            if (messagesData) {
              const messages: Message[] = JSON.parse(messagesData);
              for (const message of messages) {
                const existing = MessageStorage.getMessage(message.id);
                if (!existing) {
                  MessageStorage.createMessage(message, sessionId);
                  result.messages++;
                }
              }
            }
          } catch (e) {
            result.errors.push(`Failed to migrate messages for session ${sessionId}: ${e}`);
          }
        }
      }
    }

    // 4. Migrate V2 sessions (from llm/session.ts)
    const sessionsV2Data = localStorage.getItem(SESSIONS_KEY_V2);
    if (sessionsV2Data) {
      try {
        const sessionsV2 = JSON.parse(sessionsV2Data);
        for (const [id, session] of Object.entries(sessionsV2)) {
          const sess = session as any;
          const existing = SessionStorage.getSession(id);
          if (!existing) {
            SessionStorage.createSession({
              id,
              projectId: sess.projectId || "",
              title: sess.title || `Session ${id}`,
              model: sess.model,
              createdAt: sess.createdAt || Date.now(),
              lastMessageAt: sess.updatedAt || Date.now(),
              messageCount: sess.messages?.length || 0,
            });
            result.sessions++;

            // Migrate messages from V2 session
            if (sess.messages && Array.isArray(sess.messages)) {
              for (const msg of sess.messages) {
                const existingMsg = MessageStorage.getMessage(msg.id);
                if (!existingMsg) {
                  // Convert V2 message format to store Message format
                  const content = msg.parts
                    ?.filter((p: any) => p.type === "text")
                    .map((p: any) => p.content)
                    .join("\n") || "";

                  MessageStorage.createMessage({
                    id: msg.id,
                    role: msg.role,
                    content,
                    timestamp: msg.timestamp || Date.now(),
                    model: msg.model,
                    status: "done",
                  }, id);
                  result.messages++;
                }
              }
            }
          }
        }
      } catch (e) {
        result.errors.push(`Failed to migrate V2 sessions: ${e}`);
      }
    }

    console.log("[Migration] Completed:", result);
    return result;
  } catch (e) {
    result.errors.push(`Migration failed: ${e}`);
    console.error("[Migration] Failed:", e);
    return result;
  }
}

export function clearLocalStorage(): void {
  // Remove migrated keys
  const keysToRemove: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (
      key?.startsWith(PROJECTS_KEY) ||
      key?.startsWith(SESSIONS_PREFIX) ||
      key?.startsWith(CHAT_PREFIX) ||
      key === SESSIONS_KEY_V2
    ) {
      keysToRemove.push(key);
    }
  }
  keysToRemove.forEach((key) => localStorage.removeItem(key));
  console.log(`[Migration] Cleared ${keysToRemove.length} localStorage keys`);
}
