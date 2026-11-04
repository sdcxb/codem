/**
 * 文档索引的**内存假后端**（判据用）。
 *
 * 与真机走同一条客户端代码路径（`DocumentBackend`），只是把 IPC 换成内存实现：
 * - 命令调用可被记录（断言「发了哪条命令、参数对不对」）；
 * - 摄取/分块上传可被记录（断言「单块 ≤4MB」「finish 后 sha 一致」）。
 */

import type {
  DocumentBackend,
  DocumentChunkMeta,
  DocumentRecord,
  DocumentSearchHit,
  IngestRequest,
} from "../../core/document/client";

export interface FakeDocSeed {
  documents?: DocumentRecord[];
  hits?: DocumentSearchHit[];
  chunks?: Record<string, DocumentChunkMeta[]>;
  texts?: Record<string, string>;
  byStatus?: Record<string, number>;
  totalChunks?: number;
  headings?: Array<{ heading: string; block_no: number }>;
  /** 向量命中（`documents.vector_search`） */
  vectors?: Array<{ document_id: string; chunk_no: number; score: number; name?: string | null; page_from?: number | null; page_to?: number | null; heading_path?: string | null }>;
  /** 向量覆盖状态（`documents.vector_status`） */
  vectorStatus?: Array<{ document_id: string; model: string; chunks: number; dim?: number | null }>;
}

export interface FakeDocHandle {
  backend: DocumentBackend;
  calls: Array<{ name: string; params: Record<string, unknown> }>;
  ingests: IngestRequest[];
  /** 每次 blobAppend 的**解码后字节数**（用来断言 4MB 分块）。 */
  blobChunkBytes: number[];
  /** uploadId → 累计字节 */
  uploads: Map<string, number>;
  seed: FakeDocSeed;
}

function base64Bytes(base64: string): number {
  if (!base64) return 0;
  let padding = 0;
  if (base64.endsWith("==")) padding = 2;
  else if (base64.endsWith("=")) padding = 1;
  return Math.floor((base64.length * 3) / 4) - padding;
}

export function createFakeDocumentBackend(seed: FakeDocSeed = {}): FakeDocHandle {
  const calls: Array<{ name: string; params: Record<string, unknown> }> = [];
  const ingests: IngestRequest[] = [];
  const blobChunkBytes: number[] = [];
  const uploads = new Map<string, number>();
  let uploadSeq = 0;

  const documents = seed.documents ?? [];
  const backend: DocumentBackend = {
    async command<T>(name: string, params: Record<string, unknown> = {}): Promise<T> {
      calls.push({ name, params });
      switch (name) {
        case "documents.list":
          return { items: documents, has_more: false } as unknown as T;
        case "documents.get": {
          const found = documents.find((d) => d.id === params.id);
          if (!found) throw new Error("文档不存在");
          return found as unknown as T;
        }
        case "documents.stats":
          return {
            by_status:
              seed.byStatus ??
              documents.reduce<Record<string, number>>((acc, d) => {
                acc[d.status] = (acc[d.status] ?? 0) + 1;
                return acc;
              }, {}),
            total_chunks: seed.totalChunks ?? documents.reduce((n, d) => n + d.chunk_count, 0),
          } as unknown as T;
        case "documents.search":
          return { items: seed.hits ?? [], has_more: false } as unknown as T;
        case "documents.chunks":
          return {
            items: seed.chunks?.[String(params.document_id)] ?? [],
            has_more: false,
          } as unknown as T;
        case "documents.outline":
          return { headings: seed.headings ?? [] } as unknown as T;
        case "documents.health":
          return { path: "C:\\x\\documents\\index.db", schema_version: 1, documents: documents.length, chunks: 0 } as unknown as T;
        case "documents.vector_search":
          return { items: seed.vectors ?? [], dim: 2 } as unknown as T;
        case "documents.vector_status":
          return { items: seed.vectorStatus ?? [] } as unknown as T;
        case "documents.vector_upsert":
          return { upserted: (params.vectors as unknown[] | undefined)?.length ?? 0, dim: 2, model: "m" } as unknown as T;
        case "documents.delete":
          return { deleted: 1 } as unknown as T;
        default:
          return {} as unknown as T;
      }
    },
    async ingest(request: IngestRequest) {
      ingests.push(request);
      return { job_id: `job-${ingests.length}` };
    },
    async cancel(jobId: string) {
      return { ok: true, cancelled: jobId };
    },
    async blobBegin(name: string) {
      uploadSeq += 1;
      const upload_id = `up-${uploadSeq}`;
      uploads.set(upload_id, 0);
      void name;
      return { upload_id };
    },
    async blobAppend(uploadId: string, dataBase64: string) {
      const n = base64Bytes(dataBase64);
      blobChunkBytes.push(n);
      uploads.set(uploadId, (uploads.get(uploadId) ?? 0) + n);
      return { received: uploads.get(uploadId) };
    },
    async blobFinish(uploadId: string, name: string) {
      void name;
      const size = uploads.get(uploadId) ?? 0;
      return { sha256: "f".repeat(64), size, path: `C:\\x\\documents\\blobs\\${"f".repeat(64)}` };
    },
    async blobAbort(uploadId: string) {
      uploads.delete(uploadId);
      return { ok: true };
    },
    async readText(documentId: string, chunkNo: number) {
      const key = `${documentId}#${chunkNo}`;
      return {
        text: seed.texts?.[key] ?? `text of ${key}`,
        citation: { pageFrom: 1, pageTo: 1, headingPath: "第一章" },
        hasMore: false,
      };
    },
    async pdfProbe() {
      return { available: true };
    },
  };

  return { backend, calls, ingests, blobChunkBytes, uploads, seed };
}

/** 造一条最小文档记录（默认 ready）。 */
export function makeDoc(overrides: Partial<DocumentRecord> = {}): DocumentRecord {
  return {
    id: "doc_1",
    collection_id: "p1",
    kind: "attachment",
    dedupe_key: "blob:abc",
    name: "报告.docx",
    size: 1024,
    page_count: 3,
    block_count: 10,
    chunk_count: 5,
    text_bytes: 1000,
    status: "ready",
    created_at: 1,
    updated_at: 2,
    ...overrides,
  };
}
