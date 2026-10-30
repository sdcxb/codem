/**
 * 完整历史的数据层投影（UI 只调这里，不直接碰同步整会话读）。
 *
 * `src/components/FullHistoryPanel.tsx` 需要「完整时间线 + 模型可见条数」两样东西；
 * 按第 144 波的结构边界，同步整会话读只许留在数据层，UI 不能直接 `listMessages(`。
 * 这个文件就是那层薄投影：一次读两份，组件只拿结果。
 */
import { listMessages, listTimelineMessages } from "./message";
import type { Message } from "../../store";

export interface ContextHistorySnapshot {
  /** 含旧压缩 hidden / 索引裁剪 trimmed 的完整时间线 */
  timeline: Message[];
  /** 模型当前可见集合（检查点 cutoff 之后） */
  model: Message[];
  /** 模型当前可见条数（用于「历史 N / 模型 M」） */
  modelCount: number;
}

export function readContextHistory(sessionId: string): ContextHistorySnapshot {
  const timeline = listTimelineMessages(sessionId);
  const model = listMessages(sessionId);
  return { timeline, model, modelCount: model.length };
}
