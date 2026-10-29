/**
 * 图谱抽取：**全批失败不许丢掉旧图谱**（第 233 轮审计 · P1）。
 *
 * ## 缺陷形态
 *
 * `extractKnowledgeGraph` 在调 LLM **之前**就 `deleteGraphData(notebookId)`：
 *
 * ```ts
 * const sources = listSources(notebookId);
 * deleteGraphData(notebookId);              // ← 先清库
 * for (...batches...) {                      // ← 这里才可能全部失败
 *   try { await callLLMForExtraction(...) } catch { warnings.push(...) }
 * }
 * return { ...finalData, warnings };         // ← 返回空图 + 警告
 * ```
 *
 * 于是：provider 掉线 / 未配置 / 每条都超时的时候，用户点一次「抽取图谱」，
 * **既有图谱被清空**，返回一张空图（只是多了 warnings）。
 * 这与同文件里已经修过的那条（C-3："读不到块不许清库"）是**同一类**缺陷的另一半：
 * 前面守住了"读不到"，没守住"读到了但抽不出来"。
 *
 * ## 判据
 *
 * | # | 行为 |
 * |---|---|
 * | GR-10 | 所有批次都失败 ⇒ **不调用** `deleteGraphData`（旧图谱原样保留），并如实带 warnings |
 * | GR-11 | 至少一批成功 ⇒ 照旧先清后写（反向对照：不能因为怕失败就只增不删） |
 * | GR-12 | 第一批失败、第二批成功 ⇒ 仍然清库一次（且只清一次） |
 *
 * 变异自证：把 `deleteGraphData` 挪回循环之前 ⇒ GR-10 立刻红。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

interface FakeChunk {
  id: string;
  sourceId?: string;
  content: string;
  notebookId?: string;
}
interface FakeNode {
  id: string;
  label: string;
  entityType: string;
  description?: string;
  sourceIds: string[];
  chunkIds: string[];
  weight: number;
  community?: number;
}
interface FakeEdge {
  sourceNodeId: string;
  targetNodeId: string;
  relationType: string;
}

const db = {
  chunks: [] as FakeChunk[],
  sources: [] as Array<{ id: string; name: string }>,
  nodes: [] as FakeNode[],
  edges: [] as FakeEdge[],
  calls: [] as Array<{ fn: string; args: unknown[] }>,
  seq: 0,
};

vi.mock("../core/knowledge/storage", () => ({
  getChunksOrStatus: () => ({ ok: true, chunks: db.chunks, state: "ready" }),
  listSources: () => db.sources,
  findOrCreateNode: (_nb: string, label: string, entityType: string, description?: string) => {
    db.calls.push({ fn: "findOrCreateNode", args: [label] });
    const existing = db.nodes.find((n) => n.label === label);
    if (existing) {
      existing.weight += 1;
      return existing;
    }
    const node: FakeNode = {
      id: `node-${++db.seq}`,
      label,
      entityType,
      description,
      sourceIds: [],
      chunkIds: [],
      weight: 1,
    };
    db.nodes.push(node);
    return node;
  },
  addGraphEdge: (a: string, b: string, t: string) => {
    db.calls.push({ fn: "addGraphEdge", args: [a, b, t] });
    db.edges.push({ sourceNodeId: a, targetNodeId: b, relationType: t });
  },
  findNodeByLabel: (_nb: string, label: string) => db.nodes.find((n) => n.label === label) ?? null,
  deleteGraphData: () => {
    db.calls.push({ fn: "deleteGraphData", args: [] });
    db.nodes = [];
    db.edges = [];
  },
  getGraphData: () => ({ nodes: [...db.nodes], edges: [...db.edges] }),
  assignCommunities: () => {},
  updateNodeCommunity: (nodeId: string, communityId: number) => {
    const node = db.nodes.find((n) => n.id === nodeId);
    if (node) node.community = communityId;
  },
}));

const llm = {
  responses: [] as string[],
  throwOn: new Set<number>(),
  calls: 0,
};

/* 假 LLM：`callLLMForExtraction` 里走的是 `await import("../llm/index")` 的 complete() */
vi.mock("../core/llm/index", () => ({
  getLLMEngine: () => ({
    getConfiguredProvider: () => ({
      model: "test-model",
      provider: {
        complete: async () => {
          const idx = llm.calls++;
          if (llm.throwOn.has(idx)) throw new Error("provider 掉线（模拟）");
          return { content: llm.responses[idx] ?? JSON.stringify({ entities: [], relations: [] }) };
        },
      },
    }),
  }),
}));

import { extractKnowledgeGraph } from "../core/knowledge/graph-extractor";

const extraction = (entities: unknown[], relations: unknown[] = []) =>
  JSON.stringify({ entities, relations });

function seedChunks(count: number) {
  db.chunks = Array.from({ length: count }, (_, i) => ({
    id: `chunk-${i + 1}`,
    sourceId: `src-${(i % 2) + 1}`,
    content: `第 ${i + 1} 块的正文，提到 ISA-95 与 MOM。`,
    notebookId: "nb-1",
  }));
}

const callsOf = (fn: string) => db.calls.filter((c) => c.fn === fn);

/** 一批里能抽到实体的正常响应 */
const OK_BATCH = extraction([{ label: "ISA-95", type: "标准", description: "层级模型" }]);

beforeEach(() => {
  db.chunks = [];
  db.sources = [{ id: "src-1", name: "来源 1" }];
  db.nodes = [];
  db.edges = [];
  db.calls = [];
  db.seq = 0;
  llm.responses = [];
  llm.throwOn = new Set();
  llm.calls = 0;
});

describe("图谱抽取：全批失败不许丢旧图谱", () => {
  it("GR-10: 所有批次都失败 ⇒ 不调用 deleteGraphData，旧图谱保留，且带 warnings", async () => {
    // 既有一张"旧图谱"
    db.nodes = [
      { id: "old-1", label: "旧实体", entityType: "概念", sourceIds: [], chunkIds: [], weight: 1 },
    ];
    seedChunks(12);
    llm.throwOn = new Set([0, 1]); // 两批全失败

    const result = await extractKnowledgeGraph("nb-1");

    expect(
      callsOf("deleteGraphData"),
      "全批失败时清库 = 用户的图谱被一次失败操作抹掉（与 C-3 同类的另一半）",
    ).toHaveLength(0);
    expect(db.nodes.map((n) => n.label), "旧图谱必须还在").toContain("旧实体");
    expect(result.warnings?.length ?? 0, "失败必须如实上报").toBeGreaterThan(0);
  });

  it("GR-11（反向对照）: 至少一批成功 ⇒ 照旧先清后写", async () => {
    db.nodes = [
      { id: "old-1", label: "旧实体", entityType: "概念", sourceIds: [], chunkIds: [], weight: 1 },
    ];
    seedChunks(12);
    llm.responses = [OK_BATCH, OK_BATCH];

    const result = await extractKnowledgeGraph("nb-1");

    expect(callsOf("deleteGraphData"), "成功路径仍要清旧图（否则出现重复节点）").toHaveLength(1);
    expect(db.nodes.map((n) => n.label)).not.toContain("旧实体");
    expect(result.nodes.length).toBeGreaterThan(0);
  });

  it("GR-12: 第一批失败、第二批成功 ⇒ 清库一次（不能因为先失败就永远不清）", async () => {
    db.nodes = [
      { id: "old-1", label: "旧实体", entityType: "概念", sourceIds: [], chunkIds: [], weight: 1 },
    ];
    seedChunks(12);
    llm.throwOn = new Set([0]);
    llm.responses = [OK_BATCH, OK_BATCH];

    const result = await extractKnowledgeGraph("nb-1");

    expect(callsOf("deleteGraphData")).toHaveLength(1);
    expect(db.nodes.map((n) => n.label)).not.toContain("旧实体");
    expect(result.nodes.length).toBeGreaterThan(0);
    expect(result.warnings?.length ?? 0, "失败那一批仍要上报").toBeGreaterThan(0);
  });
});
