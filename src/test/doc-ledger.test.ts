/**
 * DOCI-8：DocumentLedger —— 只保留「文件 / 已读 / 事实」，且 ≤2,000 token。
 *
 * 为什么这条重要：文档正文是最贵的上下文。ledger 的作用是让下游轮次
 * **不必重读正文**就知道看过什么；它一旦超预算，就会把压缩后省下的空间又吃回去。
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  hasDocumentLedger,
  recordDocumentFact,
  recordDocumentRead,
  recordDocumentSearch,
  renderDocumentLedger,
} from "../core/document/ledger";
import { __resetDocumentLedgerForTests } from "../core/document/test-seams";
import { estimateDocTokens } from "../core/document/client";

const COLLECTION = "p1";

function hit(chunkNo: number, name = "报告.docx") {
  return {
    document_id: "doc_1",
    chunk_no: chunkNo,
    name,
    status: "ready",
    page_from: 12,
    page_to: 13,
    heading_path: "3.2 迁移",
    text_offset: 0,
    text_len: 100,
    preview: "迁移步骤",
    score: 1,
  };
}

afterEach(() => __resetDocumentLedgerForTests());

describe("DOCI-8 ledger", () => {
  it("没有内容时渲染空串（不把普通对话变成永远带一段固定文本）", () => {
    expect(hasDocumentLedger(COLLECTION)).toBe(false);
    expect(renderDocumentLedger(COLLECTION)).toBe("");
  });

  it("检索/阅读后包含文件、页码、标题与 chunk 坐标", () => {
    recordDocumentSearch(COLLECTION, [hit(3), hit(4)]);
    recordDocumentRead({
      collectionId: COLLECTION,
      documentId: "doc_1",
      documentName: "报告.docx",
      chunkNo: 7,
      pageFrom: 20,
      pageTo: 20,
      headingPath: "第四章 结论",
    });

    const text = renderDocumentLedger(COLLECTION);
    expect(text).toContain("[文档索引]");
    expect(text).toContain("报告.docx");
    expect(text).toContain("p.12-13");
    expect(text).toContain("§3.2 迁移");
    expect(text).toContain("chunk 3");
    expect(text).toContain("p.20 §第四章 结论 (chunk 7)");
    expect(text).toContain("不要整篇读入");
  });

  it("渲染 ≤2,000 token（即使塞满 80 条已读）", () => {
    recordDocumentSearch(
      COLLECTION,
      Array.from({ length: 60 }, (_, i) => hit(i)),
    );
    for (let i = 0; i < 30; i += 1) {
      recordDocumentFact(COLLECTION, `事实 ${i}：${"很长的确认内容".repeat(40)}`);
    }
    const text = renderDocumentLedger(COLLECTION, 2000);
    expect(estimateDocTokens(text)).toBeLessThanOrEqual(2000);
  });

  it("事实去重、可清空", () => {
    recordDocumentFact(COLLECTION, "迁移分三步");
    recordDocumentFact(COLLECTION, "迁移分三步");
    const text = renderDocumentLedger(COLLECTION);
    expect(text.match(/迁移分三步/g)).toHaveLength(1);

    __resetDocumentLedgerForTests();
    expect(hasDocumentLedger(COLLECTION)).toBe(false);
    expect(renderDocumentLedger(COLLECTION)).toBe("");
  });

  it("不同集合互不干扰", () => {
    recordDocumentSearch("p1", [hit(1)]);
    recordDocumentSearch("p2", [hit(2, "另一个.docx")]);
    expect(renderDocumentLedger("p1")).toContain("报告.docx");
    expect(renderDocumentLedger("p1")).not.toContain("另一个.docx");
    expect(renderDocumentLedger("p2")).toContain("另一个.docx");
  });
});
