/**
 * 文档索引状态（UI 用的小型外部 store）。
 *
 * ## 为什么不用 `src/store.ts`
 *
 * 那是会话/消息的主 store（1097 行，任何改动都会波及所有会话路径）。
 * 文档索引状态只服务「徽标 + 状态条」这一小块，独立 store 更小、更不容易踩到
 * 持久化/归属判据；组件用 `useSyncExternalStore` 订阅即可。
 */

import { useSyncExternalStore } from "react";
import {
  documentStats,
  listDocuments,
  subscribeDocumentProgress,
  type DocumentProgress,
  type DocumentRecord,
} from "./client";
import { runDocumentOcr } from "./ocr";
import { ensureCollectionVectorsInBackground } from "./vector-index";

export interface DocStatusSnapshot {
  collectionId: string | null;
  documents: DocumentRecord[];
  byStatus: Record<string, number>;
  totalChunks: number;
  loading: boolean;
  lastError: string | null;
  progress: DocumentProgress | null;
}

const EMPTY: DocStatusSnapshot = {
  collectionId: null,
  documents: [],
  byStatus: {},
  totalChunks: 0,
  loading: false,
  lastError: null,
  progress: null,
};

let snapshot: DocStatusSnapshot = EMPTY;
const listeners = new Set<() => void>();
let unlisten: (() => void) | null = null;

function emit(next: Partial<DocStatusSnapshot>): void {
  snapshot = { ...snapshot, ...next };
  for (const listener of listeners) listener();
}

function getDocStatusSnapshot(): DocStatusSnapshot {
  return snapshot;
}

function subscribeDocStatus(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useDocStatus(): DocStatusSnapshot {
  return useSyncExternalStore(subscribeDocStatus, getDocStatusSnapshot, getDocStatusSnapshot);
}

/** 拉一次索引状态（列表 + 统计）。失败**不抛**：UI 显示可行动错误，不阻塞对话。 */
export async function refreshDocStatus(collectionId: string): Promise<DocStatusSnapshot> {
  emit({ collectionId, loading: true, lastError: null });
  try {
    const [list, stats] = await Promise.all([
      listDocuments({ collectionId, limit: 200 }),
      documentStats(collectionId),
    ]);
    emit({
      documents: list.items,
      byStatus: stats.by_status ?? {},
      totalChunks: stats.total_chunks ?? 0,
      loading: false,
    });
  } catch (e: any) {
    emit({ loading: false, lastError: e?.message ?? String(e) });
  }
  return snapshot;
}

/** 开始监听摄取进度；进度到达时回刷列表（节流：500ms）。 */
export async function startDocProgressWatcher(collectionId: string): Promise<() => void> {
  if (unlisten) {
    unlisten();
    unlisten = null;
  }
  let timer: ReturnType<typeof setTimeout> | null = null;
  const stop = await subscribeDocumentProgress((progress) => {
    emit({ progress });
    /*
     * 摄取完成 ⇒ 若文档是扫描件/图片页，自动开始视觉转录（Q6：图片页用视觉理解做索引）。
     * 放在这里而不是 ingest 调用点：`documents_ingest` 是后台线程，完成信号只有事件。
     */
    if (progress.stage === "done") {
      void ensureCollectionOcr(collectionId);
      // 向量索引是可选增强：没配置 embedding 时函数立即返回，不影响 FTS。
      ensureCollectionVectorsInBackground(collectionId);
    }
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      void refreshDocStatus(collectionId);
    }, 500);
  });
  unlisten = stop;
  return () => {
    if (timer) clearTimeout(timer);
    stop();
    if (unlisten === stop) unlisten = null;
  };
}

/** OCR 进度回显（stage=ocr；`pages` 表示已完成页数，`percent` 为 0–100）。 */
function reportOcrProgress(done: number, total: number): void {
  emit({
    progress: {
      stage: "ocr",
      pages: done,
      percent: total > 0 ? Math.min(100, Math.round((done * 100) / total)) : 0,
      at: Date.now(),
    },
  });
}

const ocrRunning = new Set<string>();

/**
 * 对集合内所有 `needs_ocr` 文档依次做视觉转录。
 *
 * - 同一集合并发去重（事件可能连续到达）；
 * - 单文档失败不影响其他文档；失败原因由 `runDocumentOcr` 写回 `documents.error`；
 * - 结束后回刷状态，UI 的状态条随之更新。
 */
async function ensureCollectionOcr(collectionId: string): Promise<void> {
  if (ocrRunning.has(collectionId)) return;
  ocrRunning.add(collectionId);
  try {
    const list = await listDocuments({ collectionId, status: "needs_ocr", limit: 10 });
    for (const doc of list.items) {
      try {
        await runDocumentOcr(doc.id, { onProgress: reportOcrProgress });
      } catch (e: any) {
        console.warn("[doc-ocr] 视觉转录失败（文档保持 needs_ocr）:", doc.id, e?.message ?? e);
      }
    }
  } catch (e: any) {
    console.warn("[doc-ocr] 查询待转录文档失败:", e?.message ?? e);
  } finally {
    ocrRunning.delete(collectionId);
    await refreshDocStatus(collectionId);
  }
}

/** 清空（切换项目/会话或卸载时）。 */
export function resetDocStatus(): void {
  if (unlisten) {
    unlisten();
    unlisten = null;
  }
  snapshot = EMPTY;
  for (const listener of listeners) listener();
}

