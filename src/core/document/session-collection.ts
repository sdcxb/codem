/**
 * 会话 → 文档集合的映射（ADR-0008 §3）。
 *
 * 有项目：集合 = 项目 id（跨会话复用同一份文档库）；
 * 无项目：集合 = `session:<sessionId>`（本会话私有的兜底，未来可提升到全局库）。
 *
 * 为什么单独一个文件：工具层、ledger 注入、UI 状态都要用同一个判定；
 * 三处各写一遍必然漂移（真机上就出现过「面板按项目过滤、工具按会话过滤」的错位）。
 */

import { useProjectStore } from "../store";
import { collectionIdFor } from "./client";

/** 取会话所属集合。session 不存在或属于别的会话时退回会话级集合。 */
export function collectionIdForSession(sessionId: string): string {
  try {
    const session = useProjectStore.getState().currentSession;
    if (session && session.id === sessionId) {
      return collectionIdFor(session.projectId || undefined, sessionId);
    }
  } catch {
    /* store 尚未初始化（测试/早期启动）：退回会话级 */
  }
  return `session:${sessionId}`;
}
