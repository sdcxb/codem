/**
 * 引用格式（citation）—— 文档检索结果的**稳定坐标**。
 *
 * 硬约束（ADR-0008 §10.1）：每条结果都要让模型与用户能回到原文：
 * `documentId + chunkId + page/heading`。缺的字段**省略**，不编造。
 */

export interface CitationInput {
  documentId: string;
  chunkNo?: number;
  name?: string | null;
  pageFrom?: number;
  pageTo?: number;
  headingPath?: string | null;
  textSource?: string | null;
  ocrModel?: string | null;
}

/** 生成单行 citation，形如 `[file: 报告.docx | page: 12-13 | §3.2 迁移 | chunk: doc_x#42]`。 */
export function formatCitation(input: CitationInput): string {
  const parts: string[] = [];
  parts.push(`file: ${input.name || input.documentId}`);
  if (typeof input.pageFrom === "number" && input.pageFrom > 0) {
    parts.push(
      typeof input.pageTo === "number" && input.pageTo > input.pageFrom
        ? `page: ${input.pageFrom}-${input.pageTo}`
        : `page: ${input.pageFrom}`,
    );
  }
  if (input.headingPath) parts.push(`§${input.headingPath}`);
  if (typeof input.chunkNo === "number") parts.push(`chunk: ${input.documentId}#${input.chunkNo}`);
  else parts.push(`doc: ${input.documentId}`);
  if (input.textSource === "vision") {
    parts.push(`source: vision${input.ocrModel ? `(${input.ocrModel})` : ""}`);
  }
  return `[${parts.join(" | ")}]`;
}

/** 解析 `doc_x#42` 形态的 chunk 引用（工具参数容错用）。 */
export function parseChunkRef(ref: string): { documentId: string; chunkNo?: number } {
  const m = /^(.*)#(\d+)$/.exec(ref.trim());
  if (m) return { documentId: m[1], chunkNo: Number(m[2]) };
  return { documentId: ref.trim() };
}
