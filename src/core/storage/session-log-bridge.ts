/**
 * 会话追加日志 ↔ SQLite 索引的桥接（第 78 波）
 *
 * 为什么要单独一层：`database.ts`（底层）需要"回填日志 + 裁剪索引"，而这两件事只能用
 * `message.ts` 的读接口；如果 `database.ts` 直接 import `message.ts` 就会形成
 * `database → message → database` 的模块循环。桥接层放在两者之上、由 `database.ts`
 * **动态 import**，循环就断开了（与 `event-log` 的处理方式一致）。
 */

import { listMessages, trimIndexedMessages, hydrateSessionLog, rebuildSessionFts } from "./message";
import { backfillSessionLog, listSessionLogs, flushSessionLogWrites, compactSessionLog } from "./session-jsonl";
import { initDatabase } from "./database";
import { hydrateAttachmentsForSession } from "./attachment-files";

export { trimIndexedMessages };

/**
 * 预热会话里所有外置附件（第 80 波）。
 *
 * 附件读取路径是同步的，而外置内容在文件里 —— 启动维护/进入会话时把外置内容读进内存缓存，
 * 之后同步路径透明命中（`getAttachmentContent` 不会再拿到 `file:` 标记）。
 *
 * @returns 预热的附件数与清理掉的孤儿附件文件数
 */
export async function hydrateAllAttachments(): Promise<{ warmed: number; orphansRemoved: number }> {
  const out = { warmed: 0, orphansRemoved: 0 };
  try {
    const { getDatabase } = await import("./database");
    const db = getDatabase();
    const rows = db.exec("SELECT id, content FROM attachments WHERE content LIKE 'file:%'");
    const entries = rows?.[0]?.values?.map((r) => ({ id: String(r[0]), content: String(r[1]) })) ?? [];
    out.warmed = await hydrateAttachmentsForSession(entries);

    // 孤儿清理：文件在、数据库里已无对应标记（附件被删/会话被清）→ 磁盘不能只涨不降
    const allRows = db.exec("SELECT content FROM attachments WHERE content LIKE 'file:%'");
    const referenced = new Set(allRows?.[0]?.values?.map((r) => String(r[0]).slice("file:".length)) ?? []);
    const { pruneOrphanAttachmentFiles } = await import("./attachment-files");
    out.orphansRemoved = (await pruneOrphanAttachmentFiles(referenced)).deletedFiles;
  } catch (e) {
    console.warn("[Attachment] 外置附件预热/清理失败（跳过）:", e);
  }
  return out;
}

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
      await rebuildSessionFts(sessionId); // 索引与日志对齐（含孤儿清理与补齐）
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

// ========== 索引重建（第 91 波：自愈） ==========

/**
 * 从**权威日志**重建 SQLite 查询索引。
 *
 * 为什么这是"数据库崩了也不丢数据"的最后一块拼图：
 * 分层本来就写着"日志是权威、索引可重建"，但**重建方向从来没有实现过** ——
 * 只有"索引 → 日志"的回填（`backfillAllSessions`）。于是索引一崩（WASM 陷阱、
 * 索引文件损坏、被裁剪过），用户只能重启撞运气；索引里的附件/工具调用也不会自己回来。
 *
 * 现在：日志里有什么，索引就能重建出什么（幂等：同 id 覆盖写）。
 * 触发点有两个：①启动维护时若发现"上次崩溃"标记；②手工/维护显式调用。
 *
 * @returns 重建的会话数与消息数
 */
export async function rebuildIndexFromSessionLogs(sessionId?: string): Promise<{ sessions: number; messages: number }> {
  await initDatabase();
  const { readSessionMessages } = await import("./session-jsonl");
  const { getDatabase } = await import("./database");
  const db = getDatabase();

  const targets = sessionId ? [sessionId] : await listSessionLogs();
  const out = { sessions: 0, messages: 0 };

  for (const sid of targets) {
    try {
      const { messages } = await readSessionMessages(sid);
      if (messages.length === 0) continue;
      db.run("BEGIN TRANSACTION");
      try {
        /**
         * 先补 `sessions` 行（第 91 波实测发现）。
         *
         * `messages.session_id` 有指向 `sessions(id)` 的外键 —— 崩溃后重建的库是空的，
         * 直接插消息会 `FOREIGN KEY constraint failed`（真机验证时就是这么失败的）。
         * 会话归属项目在日志里没有记录，落到内置的全局项目 `""`（initDatabase 会种下这一行），
         * 标题取首条 user 消息的首行，便于用户在列表里认出来。
         */
        const firstUser = messages.find((m) => m.role === "user");
        const title = (firstUser?.content || `会话 ${sid}`).split("\n")[0].slice(0, 60) || `会话 ${sid}`;
        const firstTs = messages[0]?.timestamp ?? Date.now();
        const lastTs = messages[messages.length - 1]?.timestamp ?? firstTs;
        db.run(
          `INSERT INTO sessions (id, project_id, title, created_at, last_message_at, message_count, pinned)
             VALUES (?, '', ?, ?, ?, ?, 0)
           ON CONFLICT(id) DO UPDATE SET last_message_at = excluded.last_message_at, message_count = excluded.message_count`,
          [sid, title, firstTs, lastTs, messages.length],
        );
        for (const rec of messages) {
          db.run(
            `INSERT OR REPLACE INTO messages
               (id, session_id, role, content, reasoning, timestamp, model, prompt_tokens, completion_tokens, cost, status, hidden)
             VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, 0)`,
            [
              rec.id,
              sid,
              rec.role,
              rec.content ?? "",
              (rec as any).reasoning ?? null,
              rec.timestamp ?? Date.now(),
              (rec as any).model ?? null,
              (rec as any).status ?? "done",
            ],
          );
          // 工具调用：日志里带着完整数组，索引侧重建（幂等：先清后插）
          const toolCalls = (rec as any).toolCalls as Array<any> | undefined;
          if (Array.isArray(toolCalls)) {
            db.run("DELETE FROM tool_calls WHERE message_id = ?", [rec.id]);
            for (const tc of toolCalls) {
              db.run(
                "INSERT INTO tool_calls (id, message_id, tool, args, result, status, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)",
                [
                  tc.id ?? `${rec.id}-${tc.tool}`,
                  rec.id,
                  tc.tool ?? "unknown",
                  JSON.stringify(tc.args ?? {}),
                  tc.result ?? null,
                  tc.status ?? "done",
                  tc.metadata ? JSON.stringify(tc.metadata) : null,
                ],
              );
            }
          }
          out.messages++;
        }
        db.run("COMMIT");
      } catch (e) {
        db.run("ROLLBACK");
        throw e;
      }
      out.sessions++;
    } catch (e) {
      console.warn(`[SessionLog] 会话 ${sid} 索引重建失败（跳过）:`, e);
    }
  }
  if (out.messages > 0) {
    console.log(`[Database] 索引已从权威日志重建：${out.sessions} 个会话 / ${out.messages} 条消息`);
  }
  return out;
}

/**
 * 压缩膨胀的追加日志（第 79 波收尾项）：对行数明显多于"唯一消息数"的会话重写日志。
 * 幂等、失败保留原文件；压缩后再 hydrate 一次，保证内存镜像同步。
 */
export async function compactOversizedSessionLogs(): Promise<{ compactedSessions: number; linesSaved: number }> {
  const out = { compactedSessions: 0, linesSaved: 0 };
  for (const sessionId of await listSessionLogs()) {
    try {
      const result = await compactSessionLog(sessionId);
      if (result.compacted) {
        out.compactedSessions++;
        out.linesSaved += result.linesBefore - result.linesAfter;
        await hydrateSessionLog(sessionId); // 镜像跟着换成压缩后的版本
      }
    } catch (e) {
      console.warn(`[SessionLog] 会话 ${sessionId} 日志压缩失败（跳过）:`, e);
    }
  }
  return out;
}
