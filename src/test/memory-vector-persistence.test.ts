/**
 * 24 号文 P2-C：**向量持久化 / 检索**（引擎 `memories.embedding` 列 + `memories.vector_search`）。
 *
 * ## 被守的缺陷
 *
 * 24 号文 P2 的上一轮只做了**进程内**向量缓存（`embedding.ts` 的 `Map`）：进程退出即失效。
 * 于是每次启动后的第一次检索都要把候选重新 embed 一遍，而"语义近但词不同"的条目
 * 在**新实例**里根本不存在（缓存是空的）。本轮把向量落进 `memories` 表，让跨重启的
 * 混合检索成立；embedder 缺省（默认部署）时仍然是**零网络、零向量**。
 *
 * ## 判据
 *
 * | # | 行为 |
 * |---|---|
 * | MEM-VEC-1 | 有 embedder 时，保存后向量真的**落库**（`memories.embedding` 非空 + 走的是 upsert 命令） |
 * | MEM-VEC-2 | **新实例**（重启）仍能向量检索：语义近但词不同的条目只可能从向量那一路进来 |
 * | MEM-VEC-3 | 没有 embedder ⇒ 零向量写入、零 embed 调用、`vectorBackend = "none"` |
 * | MEM-VEC-4 | embedder 坏了 ⇒ 记忆照样保存成功（失败不阻断），且如实上报 |
 * | MEM-VEC-5 | 反向对照：把库里的向量删掉 ⇒ MEM-VEC-2 的检索立刻失去那条命中（证明它是真的靠持久化向量） |
 *
 * ## 变异自证
 *
 * - 让 `scheduleEmbeddings` 走进程内缓存而不调 `memories.upsert_embeddings` ⇒ MEM-VEC-1/2/5 红；
 * - 把 `searchVectorCandidates` 从 `searchAcrossScopes` 里摘掉 ⇒ MEM-VEC-2 红；
 * - 没有 embedder 时仍然发向量写 ⇒ MEM-VEC-3 红。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setStoragePort } from "../core/storage/port";
import { createFakeStoragePort, type FakeStoragePort } from "./fake-storage-port";
import { getPersistFailures, resetPersistFailures } from "../core/storage/persist-failure";
import { MemoryService } from "../core/memory/memory";
import { setMemoryEmbedder, type MemoryEmbedder } from "../core/memory/index";

const PROJ = "c:\\work\\vector";
const SESSION = "s-vector";

/**
 * 假 embedder 的"语义"（3 维）：
 * - `release` 与 `上线` 同向（[1,0,0]）—— 两组词**没有任何共同字符**，词法检索抓不到；
 * - `deploy` 映射到 [0,1,0]（词形相近但语义无关）；
 * - 其余 [0,0,1]。
 */
function fakeVector(text: string): number[] {
  const lower = text.toLowerCase();
  if (lower.includes("release") || lower.includes("上线")) return [1, 0, 0];
  if (lower.includes("deploy")) return [0, 1, 0];
  return [0, 0, 1];
}

interface CountingEmbedder extends MemoryEmbedder {
  calls: number;
}

function makeEmbedder(id = "fake-vector-v1"): CountingEmbedder {
  return {
    id,
    dimensions: 3,
    calls: 0,
    async embed(texts: string[]): Promise<number[][]> {
      this.calls += texts.length;
      return texts.map(fakeVector);
    },
  };
}

let port: FakeStoragePort;

beforeEach(() => {
  resetPersistFailures();
  port = createFakeStoragePort();
  setStoragePort(port);
});
afterEach(() => {
  setMemoryEmbedder(null);
  setStoragePort(null);
  vi.restoreAllMocks();
});

function seed(svc: MemoryService): { lexical: string; semantic: string; other: string } {
  const lexical = svc.add({
    scope: "project",
    projectId: PROJ,
    key: "release 发布约定",
    content: "release 之前必须跑完回归",
    source: "manual",
  }).entry!;
  const semantic = svc.add({
    scope: "project",
    projectId: PROJ,
    key: "上线流程",
    content: "上线前要跑完回归并留档",
    source: "manual",
  }).entry!;
  const other = svc.add({
    scope: "project",
    projectId: PROJ,
    key: "部署备注",
    content: "deploy 一次就好",
    source: "manual",
  }).entry!;
  return { lexical: lexical.id, semantic: semantic.id, other: other.id };
}

const keys = (results: Array<{ entry: { key: string } }>) => results.map((r) => r.entry.key);

/** 库里 `memories` 表里这条的向量（fake port 用数组代替 BLOB） */
function embeddingOf(id: string): unknown {
  const row = port.__table("memories").find((r) => r.id === id);
  return row?.embedding;
}

describe("MEM-VEC：向量持久化 / 检索（跨重启）", () => {
  it("MEM-VEC-1/2：保存后向量落库；**新实例**仍能检索到语义近但词不同的条目", async () => {
    const embedder = makeEmbedder();
    setMemoryEmbedder(embedder);
    const svc = new MemoryService();
    const ids = seed(svc);
    await svc.flushPendingPersist();

    // ① 向量真的落库（不是"算完就扔"）
    expect(
      port.__writes().some((w) => w.command === "memories.upsert_embeddings"),
      "保存路径必须真的发向量写命令",
    ).toBe(true);
    for (const id of Object.values(ids)) {
      expect(Array.isArray(embeddingOf(id)), `条目 ${id} 的向量必须落库（embedding 列非空）`).toBe(true);
    }

    /*
     * ② 重启：新实例的进程内向量缓存是**空的** —— 它能拿到语义条目只可能来自库里的向量。
     *
     * 这里直接检查引擎答复（而不是最终排序）：重排本身还会按"同作用域可注入条目"扩候选，
     * 所以"结果里有没有它"不足以证明**持久化向量**在工作；能证明的是
     * 「新实例发出的 `memories.vector_search` 真的带回了这条 id」。
     */
    const replies: Array<{ items?: Array<{ id?: string }> }> = [];
    const original = port.data.command.bind(port.data);
    const spy = vi.spyOn(port.data, "command").mockImplementation(async (cmd: string, params?: Record<string, unknown>) => {
      const reply = await original(cmd, params);
      if (cmd === "memories.vector_search") replies.push(reply as { items?: Array<{ id?: string }> });
      return reply;
    });

    const restarted = new MemoryService();
    const out = await restarted.searchAcrossScopes("release", { projectId: PROJ, sessionId: SESSION }, { hybrid: true, limit: 5 });
    expect(out.vectorBackend, "新实例的向量检索走的是**持久化**向量").toBe("persisted");
    expect(out.backend).toBe("fts+hybrid");
    expect(keys(out.results)).toContain("release 发布约定");
    expect(replies.length, "新实例必须真的发一次向量检索").toBeGreaterThan(0);
    expect(
      replies.some((r) => (r.items ?? []).some((item) => item.id === ids.semantic)),
      "新实例的向量检索必须带回语义条目（它不含查询词，词法永远搜不到）",
    ).toBe(true);

    // ③ 反向对照（也就是"向量不落库"的变异形态）：把 payload 原样搬到**另一个库**，
    //    那个库里没有 `memories` 行 ⇒ 向量检索必须 0 命中。
    //
    //    ⚠️ 不能靠"删掉当前库的 embedding 列"来做这件事：`__table()` 返回的是行的副本，
    //    删副本不会改到端口里的数据 —— 那样写出来的"红"其实是恒真。
    const stored = (await port.data.command("memory.get", {})) as { content?: string };
    spy.mockRestore();
    const barePort = createFakeStoragePort({ seed: { memory: [{ id: "default", content: stored.content ?? "" }] } });
    setStoragePort(barePort);
    const lostReplies: Array<{ items?: Array<{ id?: string }> }> = [];
    const original2 = barePort.data.command.bind(barePort.data);
    vi.spyOn(barePort.data, "command").mockImplementation(async (cmd: string, params?: Record<string, unknown>) => {
      const reply = await original2(cmd, params);
      if (cmd === "memories.vector_search") lostReplies.push(reply as { items?: Array<{ id?: string }> });
      return reply;
    });
    const withoutVectors = new MemoryService();
    await withoutVectors.searchAcrossScopes("release", { projectId: PROJ, sessionId: SESSION }, { hybrid: true, limit: 5 });
    expect(
      lostReplies.flatMap((r) => r.items ?? []).length,
      "换到一个没有向量行的库 ⇒ 向量检索必须 0 命中（证明上面那条真的靠持久化）",
    ).toBe(0);
  });

  it("MEM-VEC-3：没有 embedder（默认部署）⇒ 零向量写入、零 embed 调用、vectorBackend=none", async () => {
    setMemoryEmbedder(null);
    const svc = new MemoryService();
    seed(svc);
    await svc.flushPendingPersist();

    expect(
      port.__writes().some((w) => w.command === "memories.upsert_embeddings"),
      "没有 embedder 时一次向量写都不许发生（零网络/零向量）",
    ).toBe(false);

    const out = await svc.searchAcrossScopes("release", { projectId: PROJ, sessionId: SESSION }, { hybrid: true, limit: 5 });
    expect(out.vectorBackend, "没有 embedder ⇒ 向量这一路根本不该被调用").toBe("none");
    expect(out.backend, "回退纯词法（与加这个功能之前逐字一致）").toBe("fts+fallback");
    expect(keys(out.results)).toContain("release 发布约定");
  });

  it("MEM-VEC-4：embedder 坏了 ⇒ 记忆照样保存成功，失败如实上报（不阻断）", async () => {
    const broken: MemoryEmbedder = {
      id: "broken",
      dimensions: 3,
      async embed(): Promise<number[][]> {
        throw new Error("embedder 挂了");
      },
    };
    setMemoryEmbedder(broken);
    const svc = new MemoryService();
    const ids = seed(svc);

    // 保存本身必须成功（向量不是权威数据）
    expect(svc.getLastPersistError(), "向量失败不许污染记忆的落库结论").toBeNull();
    await svc.flushPendingPersist();
    expect(svc.getLoadState().ok).toBe(true);
    expect(port.__writes().some((w) => w.command === "memory.set"), "记忆内容仍然落库了").toBe(true);
    expect(Array.isArray(embeddingOf(ids.semantic)), "向量没写进去（失败可见，不假装成功）").toBe(false);
    expect(
      getPersistFailures().some((f) => f.area === "memory.embedding"),
      "向量失败必须走统一上报通道（用户/日志看得见）",
    ).toBe(true);

    // 检索仍然可用：没有向量 ⇒ 回退词法，不报错
    const out = await svc.searchAcrossScopes("release", { projectId: PROJ, sessionId: SESSION }, { hybrid: true, limit: 5 });
    expect(out.backend).toBe("fts+fallback");
  });

  it("MEM-VEC-5：改一条只重算/重写这一条的向量（向量跟着内容走）", async () => {
    const embedder = makeEmbedder();
    setMemoryEmbedder(embedder);
    const svc = new MemoryService();
    const ids = seed(svc);
    await svc.flushPendingPersist();
    const before = port.__writes().filter((w) => w.command === "memories.upsert_embeddings").length;

    svc.update(ids.semantic, { content: "上线前要跑完回归、留档、并通知值班" }, { actor: "user" });
    await svc.flushPendingPersist();
    const writes = port.__writes().filter((w) => w.command === "memories.upsert_embeddings").slice(before);
    expect(writes.length, "改一条 ⇒ 只发一次向量写（不重算全部条目）").toBe(1);
    const batch = (writes[0].params as { embeddings?: Array<{ id: string }> }).embeddings ?? [];
    expect(batch.map((e) => e.id), "只包含改过的那一条").toEqual([ids.semantic]);
  });
});
