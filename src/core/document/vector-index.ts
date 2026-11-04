/**
 * 文档向量索引（可选能力，ADR-0008 §16）。
 *
 * ## 为什么是「可选 + 后台补齐」
 *
 * 向量检索需要 embedding 模型（本地 ONNX 或远程 API）。它不该成为文档索引的
 * 前置条件：没配置时 FTS 仍然可用。配置后，摄取完成的文档在后台按块嵌入并写入
 * `document_vectors`；`doc_cross_search` 再按需做混合检索。
 *
 * ## 成本闸门
 *
 * - 只有 `settings.embedding.enabled === true` 才自动跑（不把“默认本地模型”当成用户同意）；
 * - 每份文档最多补 `MAX_CHUNKS_PER_DOC` 块（避免一次摄取把 CPU/API 打满），
 *   剩余块下次触发继续；`vector_status` 能看到覆盖进度。
 */

import { generateEmbeddings, getMultimodalSettings } from "../llm/multimodal";
import {
  documentChunks,
  listDocuments,
  readDocumentChunk,
  vectorStatus,
  vectorUpsert,
  type DocumentRecord,
} from "./client";

const MAX_CHUNKS_PER_DOC = 512;
const EMBED_BATCH = 16;

export interface VectorIndexOptions {
  /** 测试注入；缺省用 `generateEmbeddings` */
  embed?: (texts: string[]) => Promise<number[][]>;
  onProgress?: (done: number, total: number) => void;
}

export interface VectorIndexResult {
  documents: number;
  chunks: number;
  skipped: number;
  model: string;
}

function embeddingModelId(): string | null {
  const cfg = getMultimodalSettings().embedding;
  if (!cfg?.enabled) return null;
  return cfg.model || (cfg.providerId === "local" ? "local-all-MiniLM-L6-v2" : "text-embedding-3-small");
}

function isVectorConfigured(): boolean {
  return embeddingModelId() !== null;
}

async function defaultEmbed(texts: string[]): Promise<number[][]> {
  const result = await generateEmbeddings({ texts });
  return result.map((r) => r.embedding);
}

/** 是否需要/可以做向量补齐（UI 可用来显示“向量索引可用”）。 */
export function isVectorIndexAvailable(): boolean {
  return isVectorConfigured();
}

/**
 * 为集合内 ready 文档补齐向量（幂等：已覆盖的文档跳过）。
 * 任何失败只记录并继续下一份文档 —— 向量是增强能力，不能拖垮 FTS。
 */
export async function ensureCollectionVectors(
  collectionId: string,
  options: VectorIndexOptions = {},
): Promise<VectorIndexResult> {
  const model = embeddingModelId();
  const result: VectorIndexResult = { documents: 0, chunks: 0, skipped: 0, model: model ?? "" };
  if (!model) return result;

  const list = await listDocuments({ collectionId, status: "ready", limit: 100 });
  const embed = options.embed ?? defaultEmbed;

  for (const doc of list.items as DocumentRecord[]) {
    try {
      const status = await vectorStatus({ documentId: doc.id });
      const covered = status.items
        .filter((x) => x.model === model)
        .reduce((n, x) => n + x.chunks, 0);
      if (covered >= doc.chunk_count && doc.chunk_count > 0) {
        result.skipped += 1;
        continue;
      }

      const chunks = await documentChunks({ documentId: doc.id, limit: MAX_CHUNKS_PER_DOC });
      const targets = chunks.items.slice(0, MAX_CHUNKS_PER_DOC);
      if (targets.length === 0) continue;

      let replaceAll = covered === 0;
      let done = 0;
      for (let i = 0; i < targets.length; i += EMBED_BATCH) {
        const batch = targets.slice(i, i + EMBED_BATCH);
        const texts: string[] = [];
        for (const c of batch) {
          const read = await readDocumentChunk(doc.id, c.chunk_no);
          texts.push(read.text.slice(0, 1200));
        }
        const vectors = await embed(texts);
        if (vectors.length !== batch.length) throw new Error("embedding 数量与块数不一致");
        await vectorUpsert({
          documentId: doc.id,
          model,
          replaceAll,
          vectors: batch.map((c, idx) => ({ chunk_no: c.chunk_no, vector: vectors[idx] })),
        });
        replaceAll = false;
        done += batch.length;
        result.chunks += batch.length;
        options.onProgress?.(done, targets.length);
      }
      result.documents += 1;
    } catch (e: any) {
      console.warn("[doc-vectors] 向量补齐失败（该文档保留纯 FTS 可用）:", doc.id, e?.message ?? e);
    }
  }
  return result;
}

// 防止同一集合并发重复嵌入（摄取事件可能连续触发）
const running = new Set<string>();

export function ensureCollectionVectorsInBackground(collectionId: string): void {
  if (!isVectorConfigured()) return;
  if (running.has(collectionId)) return;
  running.add(collectionId);
  void ensureCollectionVectors(collectionId)
    .catch((e) => console.warn("[doc-vectors] 后台向量补齐失败:", e?.message ?? e))
    .finally(() => running.delete(collectionId));
}
