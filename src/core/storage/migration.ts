import { initDatabase } from "./database";
import * as SessionStorage from "./session";
import * as MessageStorage from "./message";
import { getSetting, setSetting, setSettingJSON, getSettingJSON, removeSetting } from "./settings";

interface MigrationResult {
  projects: number;
  sessions: number;
  messages: number;
  errors: string[];
}

/**
 * 迁移旧 mimo-* 前缀的 SQLite settings key 到 codem-* 前缀
 * 同时从 localStorage 迁移数据到 SQLite settings 表
 */
function migrateSettingsKeys(): number {
  let migrated = 0;

  // 旧 key → 新 key 映射（SQLite settings 表内部迁移）
  const keyMap: Record<string, string> = {
    "mimo-settings": "codem-settings",
    "mimo-app-identity": "codem-app-identity",
    "mimo-user": "codem-user",
    "mimo-identity": "codem-identity",
    "mimo-mcp-servers": "codem-mcp-servers",
    "mimo-cost-tracker": "codem-cost-tracker",
    "mimo-worktree-settings": "codem-worktree-settings",
    "mimo-project-execution-modes": "codem-project-execution-modes",
    "mimo-automation-config": "codem-automation-config",
  };

  for (const [oldKey, newKey] of Object.entries(keyMap)) {
    const existing = getSetting(newKey);
    if (existing) continue; // 新 key 已有数据，跳过

    const oldData = getSetting(oldKey);
    if (oldData) {
      setSetting(newKey, oldData);
      removeSetting(oldKey);
      migrated++;
      console.log(`[Migration] SQLite key: ${oldKey} → ${newKey}`);
    }
  }

  return migrated;
}

/**
 * 从 localStorage 迁移到 SQLite settings 表
 * 处理还未迁移到 SQLite 的 localStorage 数据
 */
function migrateFromLocalStorageToSettings(): number {
  let migrated = 0;

  // localStorage key → SQLite settings key 映射
  const lsKeyMap: Record<string, string> = {
    "mimo-settings": "codem-settings",
    "mimo-identity": "codem-identity",
    "mimo-user": "codem-user",
    "mimo-theme": "codem-theme",
  };

  for (const [lsKey, sqliteKey] of Object.entries(lsKeyMap)) {
    const existing = getSetting(sqliteKey);
    if (existing) continue; // SQLite 已有数据，跳过

    try {
      const lsData = localStorage.getItem(lsKey);
      if (lsData) {
        setSetting(sqliteKey, lsData);
        localStorage.removeItem(lsKey);
        migrated++;
        console.log(`[Migration] localStorage → SQLite: ${lsKey} → ${sqliteKey}`);
      }
    } catch {
      // localStorage 可能不可用
    }
  }

  // 迁移 mimo-cli-session-* 的 localStorage key 到 SQLite settings
  try {
    const keysToRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith("mimo-cli-session-")) {
        const newKey = "codem-" + key.substring(5); // mimo- → codem-
        const existing = getSetting(newKey);
        if (!existing) {
          const data = localStorage.getItem(key);
          if (data) {
            setSetting(newKey, data);
            migrated++;
            console.log(`[Migration] localStorage → SQLite: ${key} → ${newKey}`);
          }
        }
        keysToRemove.push(key);
      }
    }
    // 清理已迁移的 localStorage key
    for (const key of keysToRemove) {
      localStorage.removeItem(key);
    }
  } catch {
    // localStorage 可能不可用
  }

  return migrated;
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

    // 1. 迁移 SQLite settings 表内旧 key → 新 key
    const settingsMigrated = migrateSettingsKeys();
    if (settingsMigrated > 0) {
      console.log(`[Migration] Migrated ${settingsMigrated} settings keys from mimo-* to codem-*`);
    }

    // 2. 从 localStorage 迁移到 SQLite settings 表
    const lsMigrated = migrateFromLocalStorageToSettings();
    if (lsMigrated > 0) {
      console.log(`[Migration] Migrated ${lsMigrated} items from localStorage to SQLite`);
    }

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
