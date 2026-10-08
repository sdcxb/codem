import * as SessionStorage from "./session";
import * as MessageStorage from "./message";
import {
  getSetting,
  setSettingJSON,
  getSettingJSON,
  removeSetting,
  setSettingConfirmed,
} from "./settings";
// 第 45 轮 D-17：把迁移过来的主题同时写进首屏镜像（否则镜像停在旧值，
// 下次启动 index.html 的预渲染脚本会按旧档位先渲染一帧）
import { THEME_SETTING_KEY, THEME_CACHE_KEY, isThemeMode, cacheTheme } from "../theme/theme-default";

interface MigrationResult {
  projects: number;
  sessions: number;
  messages: number;
  errors: string[];
}

/**
 * 迁移旧 mimo-* 前缀的 SQLite settings key 到 codem-* 前缀
 * 同时从 localStorage 迁移数据到 SQLite settings 表
 *
 * ## ⚠️ 第 184 波存储审计 S4：**先确认落库成功，才允许删源**
 *
 * 原来是 `setSetting(newKey, oldData); removeSetting(oldKey);` —— 两次写都是
 * "内存即时生效 + **异步**落库"（`settings.ts` 的 `writeThrough` 只 `.catch(report)；
 * `rust-port.ts` 的 `config.set` 失败只走 `onFailure`），而删除是**立刻**执行的。
 * 于是复制那条 IPC 失败（`callWithRetry` 重试耗尽 / 磁盘满 / 引擎忙）时**源键已经被删掉**：
 * 键表第一行 `mimo-settings → codem-settings` 就是**整份设置（含 provider 配置）丢失**，
 * 既没有回滚也没有重试。
 *
 * 现在改成 `await setSettingConfirmed(...)`：**确认落库成功之后**才 `removeSetting`；
 * 失败就保留源键、如实告警，下次启动自然重试（源还在，数据不丢）。
 * 这与 `secret-store` 里明写的纪律是同一条："封存成功 → 原子写回 → **才**清明文"。
 */
async function migrateSettingsKeys(): Promise<number> {
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
      /**
       * ⚠️ 顺序：**复制并确认落库 → 才删源**。删源不看复制结果就是"失败即丢数据"。
       * 确认失败时 `continue`：源键**原封不动**，本次不迁移（下次启动重试）。
       */
      const copied = await setSettingConfirmed(newKey, oldData);
      if (!copied) {
        console.warn(
          `[Migration] SQLite key: ${oldKey} → ${newKey} 复制**未确认落库** —— ` +
            `本次**不删除源键**（${oldKey} 数据保留，下次启动重试；重启后若仍失败请检查磁盘/引擎状态）`,
        );
        continue;
      }
      removeSetting(oldKey);
      migrated++;
      console.log(`[Migration] SQLite key: ${oldKey} → ${newKey}`);
    }
  }

  // 第 45 轮 D-17：`mimo-theme → codem-theme` 迁移后补写首屏镜像。
  // 老用户从没有过 `codem-theme-cache`（镜像键是第 36 波才有的），
  // 若这里不补，`index.html` 的预渲染脚本读不到镜像 → 首帧按 CSS 默认档渲染，
  // 与刚迁移过来的档位不一致（浅色用户看不出，暗色用户会看到白闪）。
  try {
    const migratedTheme = getSetting(THEME_SETTING_KEY);
    if (isThemeMode(migratedTheme)) {
      cacheTheme(migratedTheme);
      console.log(`[Migration] 补写首屏主题镜像 ${THEME_CACHE_KEY}=${migratedTheme}`);
    }
  } catch {
    /* 镜像只是首屏预测，写不进去不影响功能 */
  }

  return migrated;
}

/**
 * 从 localStorage 迁移到 SQLite settings 表
 * 处理还未迁移到 SQLite 的 localStorage 数据
 *
 * ⚠️ 第 184 波存储审计 S4：与 `migrateSettingsKeys` 同一条纪律 ——
 * **确认落库成功之后**才删掉 localStorage 里的源（否则复制失败时源被删 = 数据丢失）。
 */
async function migrateFromLocalStorageToSettings(): Promise<number> {
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
        const copied = await setSettingConfirmed(sqliteKey, lsData);
        if (!copied) {
          console.warn(
            `[Migration] localStorage → SQLite: ${lsKey} → ${sqliteKey} 复制**未确认落库** —— ` +
              `本次**不删除 localStorage 源**（数据保留，下次启动重试）`,
          );
          continue;
        }
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
        if (existing) {
          // 新键已有数据 ⇒ 这份 localStorage 只是残留，可以直接清（没有要复制的东西）
          keysToRemove.push(key);
          continue;
        }
        const data = localStorage.getItem(key);
        if (!data) {
          // 源本身就是空 ⇒ 没有可复制的内容，清了不丢数据
          keysToRemove.push(key);
          continue;
        }
        /**
         * ⚠️ S4 同一条纪律：**确认落库成功之后**才把源列进待清理名单。
         * 失败时**不列**（源留在 localStorage，下次启动重试）—— 否则就是"复制失败即丢数据"。
         */
        const copied = await setSettingConfirmed(newKey, data);
        if (copied) {
          migrated++;
          keysToRemove.push(key);
          console.log(`[Migration] localStorage → SQLite: ${key} → ${newKey}`);
        } else {
          console.warn(
            `[Migration] localStorage → SQLite: ${key} → ${newKey} 复制**未确认落库** —— ` +
              `本次**保留 localStorage 源**（下次启动重试）`,
          );
        }
      }
    }
    // 清理**已确认迁移**的 localStorage key
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
    /**
     * ⚠️ 这里曾经是**整个启动路径上最后一处会加载 WASM 库的地方**（P5 第 7 段真机抓到）。
     *
     * 原实现无条件 `await initDatabase()` —— 于是"引擎为 rust、不加载 WASM 库"的改动
     * 在打包版里**被无声地废掉了**：日志里明明写着"不加载 WASM 数据库"，
     * 紧接着却是 `[Database] sql.js 引擎：wasm` + `Loaded 11137024 bytes from file`
     * + `Saved 11137024 bytes to file`（整库读进来又写回去，省下的内存全花回来）。
     *
     * 第 18 轮：那次调用连"有条件的版本"（`if (!rustActive) initDatabase()`）也一并删掉了 ——
     * A 态（回滚到旧引擎）已不存在，端口是唯一形态，所以这里**没有需要用旧库的场合**。
     * 本函数真正需要的只有"设置"那一半（① 旧 settings key 改名；② localStorage → settings），
     * 两者都走设置接口（rust 模式下就是端口命令，与旧库无关）。
     */
    // 1. 迁移 SQLite settings 表内旧 key → 新 key
    const settingsMigrated = await migrateSettingsKeys();
    if (settingsMigrated > 0) {
      console.log(`[Migration] Migrated ${settingsMigrated} settings keys from mimo-* to codem-*`);
    }

    // 2. 从 localStorage 迁移到 SQLite settings 表
    const lsMigrated = await migrateFromLocalStorageToSettings();
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
