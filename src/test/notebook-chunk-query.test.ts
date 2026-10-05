/**
 * 第 197 波：**文本块按需查询的判据（先写判据，再接线 ✓）**。
 *
 * ## 背景（目标里的存储模型 ✓）
 *
 * `notebook_chunks` 每行带一个 Base64 的 embedding（1536 维 ≈ 8KB ✓）⇒
 * 它**天生不该进镜像** ✓（域内已有 2000 行低上限与"不预取"的设计 ✓）。
 * 所以要走"按需查询 + **有界投影**"✓ —— 投影里**不含 embedding** ✗。
 *
 * ## 判据
 *
 * - **NC-1**：查询结果里**没有** `embedding` 字段 ✓
 *   （⚠️ 写这条时它**本来就是红的** ✗ —— 因为方法此刻返回**整行** ✓，
 *   判据先行就是要把它逼出来 ✓）；
 * - **NC-2 反向对照**：`text` / `chunk_index` / `notebook_id` **必须**照常可得 ✓
 *   （只砍 embedding ✗ —— 不许为了省内存把正文也砍掉 ✓，那会直接弄坏检索 ✓）；
 * - **NC-3**：分页取全 ✓（超过单页 ⇒ 必须真的翻页 ✓，与既有查询判据同构 ✓）。
 *
 * 变异：让方法返回整行（不做投影）⇒ **NC-1 红** ✓。
 */
import { describe, expect, it, vi } from "vitest";
import { RustStoragePort } from "../core/storage/rust-port";

const failures: string[] = [];
vi.mock("../core/storage/persist-failure", () => ({
  reportPersistFailure: (_s: string, _e: unknown, note: string) => failures.push(note),
  reportActionFailure: (_s: string, _e: unknown, note: string) => failures.push(note),
  reportAdvisory: (_s, finding, _o) => failures.push(typeof finding === "string" ? finding : String(finding)),
}));

const CHUNKS = 2500; // 故意超过单页 1000 ⇒ 必须真的分页 ✓

function portWithChunks() {
  const transport = {
    invokeCommand: async (command: string, params?: Record<string, unknown>) => {
      const p = params ?? {};
      if (command === "crud.list") {
        const table = String(p.table ?? "");
        if (table !== "notebook_chunks") return { ok: true, result: { items: [], has_more: false } } as never;
        const limit = Number(p.limit ?? 1000);
        const offset = Number(p.offset ?? 0);
        const all = Array.from({ length: CHUNKS }, (_, i) => ({
          id: `c${i}`,
          notebook_id: "nb1",
          source_id: "src1",
          chunk_index: i,
          text: `chunk-${i}`,
          created_at: 1000 + i,
          /** ✗ 这一列就是不该被读进 JS 的那个（8KB/行 ✓） */
          embedding: "A".repeat(2048),
        }));
        const items = all.slice(offset, offset + limit);
        return { ok: true, result: { items, has_more: offset + items.length < CHUNKS } } as never;
      }
      if (command === "settings.get_all") return { ok: true, result: {} } as never;
      if (command === "config_warmup") return { ok: true, result: {} } as never;
      return { ok: true, result: {} } as never;
    },
    invokeBatch: async () => ({ ok: true, result: {} }) as never,
    health: async () => ({ ok: true, result: { ready: true, engine: "rust" } }) as never,
    integrityCheck: async () => ({ ok: true, result: { ok: true } }) as never,
    checkpoint: async () => ({ ok: true, result: { ok: true } }) as never,
    capabilities: async () => ({ commands: [] }) as never,
  };
  return new RustStoragePort(transport as never, (_s, _e, note) => failures.push(note));
}

const PORT = portWithChunks() as unknown as {
  queryNotebookChunks(opts: { notebookId: string; limit?: number }): Promise<Array<Record<string, unknown>>>;
};

describe("第 197 波：文本块的按需查询（有界投影，不含 embedding）", () => {
  it("NC-1: 结果里**没有** embedding 字段（8KB/行不该读进 JS ✗）", async () => {
    const rows = await PORT.queryNotebookChunks({ notebookId: "nb1" });
    expect(rows.length, "应当真的取到行 ✓").toBeGreaterThan(0);
    const withEmbedding = rows.filter((r) => "embedding" in r);
    expect(
      withEmbedding.length,
      "查询结果里**不许**带 embedding ✗ —— 它每行 8KB，读进 JS 只白占内存 ✓（要连 IPC 一起省需引擎支持列投影 ✓）",
    ).toBe(0);
  });

  it("NC-2 反向对照: text / chunk_index / notebook_id 必须照常可得（只砍 embedding ✗）", async () => {
    const rows = await PORT.queryNotebookChunks({ notebookId: "nb1", limit: 3 });
    expect(rows.length).toBe(3);
    for (const r of rows) {
      expect(typeof r.text, "正文必须还在 ✓（砍掉正文会直接弄坏检索 ✗）").toBe("string");
      expect(r.chunk_index, "chunk_index 必须还在 ✓").toBeDefined();
      expect(r.notebook_id, "notebook_id 必须还在 ✓").toBeDefined();
    }
  });

  it("NC-3: 超过单页必须真的分页取全", async () => {
    const rows = await PORT.queryNotebookChunks({ notebookId: "nb1" });
    expect(rows.length, `应当取全 ${CHUNKS} 行 ✓（单页只有 1000 ✓ ⇒ 必须翻页 ✓）`).toBe(CHUNKS);
  });
});
