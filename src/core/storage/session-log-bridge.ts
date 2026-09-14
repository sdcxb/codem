/**
 * 会话追加日志 ↔ SQLite 索引的桥接（第 78 波）
 *
 * 为什么要单独一层：`database.ts`（底层）需要"回填日志 + 裁剪索引"，而这两件事只能用
 * `message.ts` 的读接口；如果 `database.ts` 直接 import `message.ts` 就会形成
 * `database → message → database` 的模块循环。桥接层放在两者之上、由 `database.ts`
 * **动态 import**，循环就断开了（与 `event-log` 的处理方式一致）。
 */

import { listMessages, trimIndexedMessages, hydrateSessionLog } from "./message";
import { backfillSessionLog, listSessionLogs, flushSessionLogWrites } from "./session-jsonl";
import { initDatabase } from "./database";

export { trimIndexedMessages };

/**
 * 把**每个会话**的 SQLite 历史回填进追加日志（幂等：已存在的消息不会被重复追加）。
 *
 * 迁移语义：从这一版起，追加日志是权威存储；SQLite 退化为可重建的查询索引。
 * 老会话第一次跑维护时会被回填一次，之后只有新消息会追加。
 *
 * @returns 本次回填的消息总数
 */
export async function backfillAllSessions(): Promise<number> {
  await initDatabase();
  let sessionIds: string[] = [];
  try {
    const { getDatabase } = await import("./database");
    const rows = getDatabase().exec("SELECT DISTINCT session_id FROM messages");
    sessionIds = rows?.[0]?.values?.map((r) => String(r[0])) ?? [];
  } catch (e) {
    console.warn("[SessionLog] 枚举会话失败（跳过回填）:", e);
    return 0;
  }

  let total = 0;
  for (const sessionId of sessionIds) {
    try {
      const messages = listMessages(sessionId);
      if (messages.length === 0) continue;
      await flushSessionLogWrites(); // 先把在途追加写完，避免重复回填
      total += await backfillSessionLog(sessionId, messages);
      // 回填后把日志读进内存镜像，读路径立刻就能合并出完整历史
      await hydrateSessionLog(sessionId);
    } catch (e) {
      console.warn(`[SessionLog] 会话 ${sessionId} 回填失败（跳过）:`, e);
    }
  }
  return total;
}

/** 已存在日志文件的会话数（诊断用） */
export async function countSessionLogs(): Promise<number> {
  return (await listSessionLogs()).length;
}
