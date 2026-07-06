import { initDatabase } from "./database";
import * as SessionStorage from "./session";
import * as MessageStorage from "./message";

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

    // Migration from localStorage is no longer needed
    // All data is now stored in SQLite
    console.log("[Migration] No localStorage migration needed - using SQLite");

    // Migrate from v2_sessions table to sessions table (if v2_sessions has data)
    console.log("[Migration] Checking v2_sessions table...");
    try {
      const { loadV2Sessions } = await import("./v2-session");
      const v2Sessions = loadV2Sessions();
      console.log("[Migration] Found", v2Sessions.size, "sessions in v2_sessions table");
      for (const [id, v2Session] of v2Sessions) {
        const existing = SessionStorage.getSession(id);
        if (!existing) {
          SessionStorage.createSession({
            id,
            projectId: v2Session.projectId,
            title: v2Session.title,
            model: v2Session.model,
            createdAt: v2Session.createdAt,
            lastMessageAt: v2Session.updatedAt,
            messageCount: v2Session.messages?.length || 0,
          });
          result.sessions++;

          // Migrate messages from V2 session
          if (v2Session.messages && Array.isArray(v2Session.messages)) {
            console.log("[Migration] Migrating", v2Session.messages.length, "messages from v2_sessions for session", id);
            for (const msg of v2Session.messages) {
              const existingMsg = MessageStorage.getMessage(msg.id);
              if (!existingMsg) {
                // Extract content from parts array
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
      console.warn("[Migration] v2_sessions migration skipped:", e);
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
  // No longer needed - localStorage is not used
  console.log("[Migration] clearLocalStorage is deprecated");
}
