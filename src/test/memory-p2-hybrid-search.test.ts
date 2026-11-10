/**
 * 任务 A（混合检索）+ 任务 C（检索结果缓存）：24 §P2 残余子集的可落地部分。
 *
 * ## 被守的形态
 *
 * 改前：`memory_search` 只有词法检索（settings 扫描 / FTS 镜像），没有可注入的 embedding 重排，
 * 也没有任何检索结果缓存 —— 同一查询在连续调用里每次都重扫全量条目。
 *
 * 这一组判据钉住：
 *
 * **任务 A（混合检索，默认关闭）**
 * 1. `hybrid` 缺省 ⇒ 一次 embed 都不发生（零网络），结果与纯词法逐字一致；
 * 2. 装了 embedder + `hybrid:true` ⇒ 语义近但**词不同**的条目进入结果并排到"弱词法命中"之前；
 * 3. 没有 embedder / embed 抛错 / 向量形状不符 ⇒ **回退纯词法**、`backend` 标
 *    `fts+fallback`，结果仍包含全部词法命中（不报错）；
 * 4. 向量缓存按 `embedder.id + 文本` 复用（同文本不重复 embed），换 id 后重新取；
 * 5. 工具面 `hybrid` 只接受布尔（字符串 `"true"` 被拒绝，不静默当 false）。
 *
 * **任务 C（结果缓存）**
 * 6. 同键查询在 TTL 内命中缓存（用 fake 时钟证明"没有再扫一遍"）；
 * 7. 保存成功（`save`）后缓存失效 —— 新写入的条目立刻可被同一查询搜到；
 * 8. 不同 scope（projectId）不串缓存；
 * 9. LRU 上限 100：第 101 个查询把最旧的键挤掉。
 *
 * ## 变异自证（本文件对应的一半）
 *
 * - 把 `searchAcrossScopes` 里 `hybrid` 恒当 false ⇒ A2/A7 红；
 * - 把"没有 embedder 就回退"改成抛错 ⇒ A3 红；
 * - 把 `embedTexts` 的缓存查询删掉 ⇒ A6 红（第二批仍会调用 embed）；
 * - 把 `save()` 里的 `clearSearchCache()` 删掉 ⇒ C2 红；
 * - 把缓存键里的 projectId 去掉 ⇒ C3 红。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeStoragePort, type FakeStoragePort } from "./fake-storage-port";
import { setStoragePort } from "../core/storage/port";
import { getMemoryService, MemoryService, type MemoryScopeContext } from "../core/memory/memory";
import { setMemoryEmbedder, type MemoryEmbedder } from "../core/memory/index";
import { createMemorySearchTool } from "../core/llm/tools/memory-tools";

const PROJ_A = "c:\\work\\hybrid-alpha";
const PROJ_B = "c:\\work\\hybrid-beta";
const SESSION = "s-hybrid";

/**
 * 假 embedder 的"语义"：把文本映射到 3 维空间。
 *
 * - `release` / `上线` 是**同一语义**（[1,0,0]）—— 注意这两组词**没有任何共同字符**，
 *   正是"语义近但词不同"的形态；
 * - `deploy` 故意映射到另一个方向（[0,1,0]）：它与查询共享词形，但（按这个假模型）
 *   语义无关 —— 用来证明"词法命中"与"语义命中"是两个可分开的信号。
 */
function fakeVector(text: string): number[] {
  const lower = text.toLowerCase();
  if (lower.includes("上线") || lower.includes("release")) return [1, 0, 0];
  if (lower.includes("deploy")) return [0, 1, 0];
  return [0, 0, 1];
}

interface CountingEmbedder extends MemoryEmbedder {
  /** 每次 `embed()` 的入参（用于断言"缓存命中后没有再取"） */
  batches: string[][];
}

function makeEmbedder(id = "fake-semantic-v1"): CountingEmbedder {
  const batches: string[][] = [];
  return {
    id,
    dimensions: 3,
    batches,
    async embed(texts: string[]): Promise<number[][]> {
      batches.push([...texts]);
      return texts.map(fakeVector);
    },
  };
}

function seedService(svc: MemoryService): void {
  // 强词法命中（key 里就有查询词）—— 分数足够高，任何语义分都不该把它挤下去
  svc.add({
    scope: "project",
    projectId: PROJ_A,
    key: "release 发布约定",
    content: "release 之前必须跑完回归",
    source: "manual",
  });
  // 语义近、词不同（不含 release/deploy，但假模型判定语义相同）
  svc.add({
    scope: "project",
    projectId: PROJ_A,
    key: "上线流程",
    content: "上线前要跑完回归并留档",
    source: "manual",
  });
  // 弱词法命中（正文里出现一次 deploy），语义无关
  svc.add({
    scope: "project",
    projectId: PROJ_A,
    key: "部署备注",
    content: "deploy 一次就好",
    source: "manual",
  });
  // 别的项目（跨作用域检索不许带出来）
  svc.add({
    scope: "project",
    projectId: PROJ_B,
    key: "beta 约定",
    content: "beta 项目跑 build-b",
    source: "manual",
  });
  // 平台级（跨作用域检索恒可见）
  svc.add({
    scope: "platform",
    key: "全局偏好",
    content: "回答一律用中文",
    source: "manual",
  });
}

let port: FakeStoragePort;

function freshPort(opts: Parameters<typeof createFakeStoragePort>[0] = {}): FakeStoragePort {
  port = createFakeStoragePort(opts);
  setStoragePort(port);
  return port;
}

function toolCtx(): never {
  return {
    sessionId: SESSION,
    messageId: "m1",
    cwd: PROJ_A,
    abort: new AbortController().signal,
    messages: [],
    metadata: () => {},
  } as never;
}

const ids = (results: Array<{ entry: { id: string; key: string } }>): string[] =>
  results.map((r) => r.entry.key);

describe("任务 A：混合检索（可选 embedding 重排，默认关闭）", () => {
  let svc: MemoryService;

  beforeEach(() => {
    // console.info 是跨作用域检索的审计行（每个用例都会打），测试里静音
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    freshPort();
    svc = new MemoryService();
    seedService(svc);
  });

  afterEach(() => {
    setMemoryEmbedder(null);
    setStoragePort(null);
    vi.restoreAllMocks();
  });

  it("A1 默认关闭：装了 embedder 也不调用；结果与纯词法一致", async () => {
    /*
     * 24 号文 P2-C 之后，注入 embedder 会触发**后台向量持久化**（写库那一路，不是检索）。
     * 所以断言改成"这次检索自己调了几次"（差值），并在前面把在途写入落定 ——
     * 否则计数里会混进后台那几批，"检索有没有调 embed"就不可判定了。
     */
    await svc.flushPendingPersist();
    const embedder = makeEmbedder();
    setMemoryEmbedder(embedder);
    const before = embedder.batches.length;

    const out = await svc.searchAcrossScopes("release deploy", { projectId: PROJ_A }, { limit: 5 });
    expect(out.backend, "没传 hybrid ⇒ 走原来的词法路径").toBe("settings");
    expect(out.hybrid, "hybrid 必须是 false（默认关闭）").toBe(false);
    expect(embedder.batches.length - before, "默认关闭 ⇒ 这次检索一次 embed 都不许发生").toBe(0);
    // 词法：强命中第一、弱命中第二；语义条目（不含查询词）不出现
    expect(ids(out.results)).toEqual(["release 发布约定", "部署备注"]);
  });

  it("A2 语义近但词不同的条目能排到弱词法命中之前（强词法命中仍是第一）", async () => {
    await svc.flushPendingPersist();
    const embedder = makeEmbedder();
    setMemoryEmbedder(embedder);
    const before = embedder.batches.length;

    const out = await svc.searchAcrossScopes(
      "release deploy",
      { projectId: PROJ_A },
      { limit: 3, hybrid: true },
    );
    expect(out.backend, "embedder 可用 ⇒ 语义分真的参与排序").toBe("fts+hybrid");
    expect(out.hybrid).toBe(true);
    /*
     * 两批：①向量检索取**查询向量**（必须先有它才能去库里找近邻）；②重排取"查询 + 候选"
     * （查询命中进程内缓存，实际只发候选）。共 2 次 `embed()` —— 持久化向量检索让这个数字
     * 从 1 变成 2，但仍然是**两次有界批量**，不是"每个候选一次"。
     */
    expect(embedder.batches.length - before, "向量检索 1 批 + 重排 1 批").toBe(2);
    expect(ids(out.results)).toEqual(["release 发布约定", "上线流程", "部署备注"]);
    // 分数必须有序（混合分是连续值，不是另一套整数权重）
    expect(out.results[0].score).toBeGreaterThan(out.results[1].score);
    expect(out.results[1].score).toBeGreaterThan(out.results[2].score);
    // 语义条目的摘要来自权威正文（没有词法命中位置，取正文开头）
    expect(out.results[1].snippet).toContain("上线前要跑完回归");
  });

  it("A3 没有 embedder：hybrid=true 回退纯词法，backend=fts+fallback，不报错", async () => {
    setMemoryEmbedder(null);

    const out = await svc.searchAcrossScopes(
      "release deploy",
      { projectId: PROJ_A },
      { limit: 5, hybrid: true },
    );
    expect(out.backend).toBe("fts+fallback");
    expect(out.lexicalBackend, "回退时仍如实给出真实取数路径").toBe("settings");
    // 至少包含全部词法命中（不劣化）
    expect(ids(out.results)).toEqual(["release 发布约定", "部署备注"]);
  });

  it("A4 embed 抛错：回退纯词法且保留词法命中（失败不演成错误）", async () => {
    setMemoryEmbedder({
      id: "broken",
      dimensions: 3,
      async embed() {
        throw new Error("embedder 断网");
      },
    });

    const out = await svc.searchAcrossScopes(
      "release deploy",
      { projectId: PROJ_A },
      { limit: 5, hybrid: true },
    );
    expect(out.backend).toBe("fts+fallback");
    expect(ids(out.results)).toContain("release 发布约定");
    expect(ids(out.results)).toContain("部署备注");
    expect(vi.mocked(console.warn).mock.calls.some((c) => String(c[0]).includes("回退纯词法"))).toBe(true);
  });

  it("A5 向量形状不符：同样回退（不许把坏向量当 0 分之外的任何东西）", async () => {
    setMemoryEmbedder({
      id: "wrong-dim",
      dimensions: 3,
      async embed(texts) {
        return texts.map(() => [1, 0]); // 2 维 ≠ 声明 3 维
      },
    });

    const out = await svc.searchAcrossScopes(
      "release deploy",
      { projectId: PROJ_A },
      { limit: 5, hybrid: true },
    );
    expect(out.backend).toBe("fts+fallback");
    expect(ids(out.results)).toEqual(["release 发布约定", "部署备注"]);
  });

  it("A6 向量缓存：同文本不重复 embed；换 embedder.id 后重新取（不串旧向量）", async () => {
    await svc.flushPendingPersist();
    const embedder = makeEmbedder();
    setMemoryEmbedder(embedder);
    const ctx: MemoryScopeContext = { projectId: PROJ_A };
    const started = embedder.batches.length;

    const first = await svc.searchWithHybrid("release deploy", undefined, 5, ctx);
    expect(first.backend).toBe("fts+hybrid");
    const batchesAfterFirst = embedder.batches.length - started;
    expect(batchesAfterFirst, "第一次必须真的取向量").toBe(1);

    const second = await svc.searchWithHybrid("release deploy", undefined, 5, ctx);
    expect(second.backend).toBe("fts+hybrid");
    expect(embedder.batches.length - started, "同文本第二轮应全部命中进程内向量缓存").toBe(batchesAfterFirst);
    expect(ids(second.results)).toEqual(ids(first.results));

    const embedderV2 = makeEmbedder("fake-semantic-v2");
    setMemoryEmbedder(embedderV2);
    await svc.searchWithHybrid("release deploy", undefined, 5, ctx);
    expect(embedderV2.batches.length, "换实现 ⇒ 必须重新取向量（旧向量空间不可比）").toBe(1);
    // 旧实现的缓存没有被清空到"影响正确性"的地步：它本来也不会再被用到
    expect(embedder.batches.length - started).toBe(batchesAfterFirst);
  });

  it("A7 工具面：hybrid 缺省 = 纯词法；hybrid=true 透传到服务层；非布尔被拒绝", async () => {
    const singleton = getMemoryService();
    await singleton.reload();
    seedService(singleton);
    const embedder = makeEmbedder();
    setMemoryEmbedder(embedder);

    const plain = (await createMemorySearchTool().execute(
      { query: "release deploy", scopeMode: "all", projectId: PROJ_A },
      toolCtx(),
    )) as never as { isError: boolean; value: { backend: string; hybrid: boolean } };
    expect(plain.isError).toBe(false);
    expect(plain.value.hybrid).toBe(false);
    expect(plain.value.backend).toBe("settings");
    expect(embedder.batches.length, "默认关闭 ⇒ 工具面也不许 embed").toBe(0);

    const hybrid = (await createMemorySearchTool().execute(
      { query: "release deploy", scopeMode: "all", projectId: PROJ_A, hybrid: true },
      toolCtx(),
    )) as never as { isError: boolean; value: { backend: string; hybrid: boolean } };
    expect(hybrid.isError).toBe(false);
    expect(hybrid.value.hybrid).toBe(true);
    expect(hybrid.value.backend).toBe("fts+hybrid");

    const bad = (await createMemorySearchTool().execute(
      { query: "release deploy", scopeMode: "all", projectId: PROJ_A, hybrid: "true" },
      toolCtx(),
    )) as never as { isError: boolean; output: string };
    expect(bad.isError, "字符串 \"true\" 不许静默当 false").toBe(true);
    expect(bad.output).toContain("hybrid");
  });
});

describe("任务 C：检索结果缓存（进程内 LRU + TTL 30s，保存即失效）", () => {
  let svc: MemoryService;

  function seedOne(): void {
    svc.add({ scope: "platform", key: "缓存约定", content: "缓存命中的词", source: "manual" });
  }

  beforeEach(() => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    // 强制 settings 回退，让 `search()`（同步词法扫描）成为可观测的调用点
    freshPort({ failCommands: ["memories.search"] });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    svc = new MemoryService();
    seedOne();
  });

  afterEach(() => {
    setStoragePort(null);
    vi.restoreAllMocks();
  });

  it("C1 同键查询在 TTL 内命中缓存；31 秒后重新取数（fake 计时）", async () => {
    const searchSpy = vi.spyOn(svc, "search");
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);

    await svc.searchAcrossScopes("缓存", { projectId: PROJ_A }, { limit: 5 });
    expect(searchSpy, "第一次必须真的扫一遍").toHaveBeenCalledTimes(1);

    now.mockReturnValue(1_020_000); // +20s，仍在 30s TTL 内
    await svc.searchAcrossScopes("缓存", { projectId: PROJ_A }, { limit: 5 });
    expect(searchSpy, "TTL 内命中缓存 ⇒ 不再扫").toHaveBeenCalledTimes(1);

    now.mockReturnValue(1_031_000); // +31s，过期
    await svc.searchAcrossScopes("缓存", { projectId: PROJ_A }, { limit: 5 });
    expect(searchSpy, "过期后必须重新取数").toHaveBeenCalledTimes(2);
  });

  it("C2 保存成功 ⇒ 缓存失效（新写入的条目立刻能被同一查询搜到）", async () => {
    const searchSpy = vi.spyOn(svc, "search");
    const first = await svc.searchAcrossScopes("新词", { projectId: PROJ_A }, { limit: 5 });
    expect(first.results).toHaveLength(0);
    await svc.searchAcrossScopes("新词", { projectId: PROJ_A }, { limit: 5 });
    expect(searchSpy, "第二次走缓存").toHaveBeenCalledTimes(1);

    // add() 走 save() ⇒ 必须清空缓存
    svc.add({ scope: "platform", key: "新约定", content: "新词 第一次出现", source: "manual" });
    const after = await svc.searchAcrossScopes("新词", { projectId: PROJ_A }, { limit: 5 });
    expect(searchSpy, "保存后必须重新取数").toHaveBeenCalledTimes(2);
    expect(after.results.map((r) => r.entry.key)).toContain("新约定");
  });

  it("C3 不同 scope 不串缓存（A 项目的结果不会当成 B 项目的）", async () => {
    svc.add({ scope: "project", projectId: PROJ_B, key: "beta 缓存约定", content: "缓存词 beta", source: "manual" });
    const searchSpy = vi.spyOn(svc, "search");

    const a = await svc.searchAcrossScopes("缓存词", { projectId: PROJ_A }, { limit: 5 });
    const b = await svc.searchAcrossScopes("缓存词", { projectId: PROJ_B }, { limit: 5 });

    expect(searchSpy, "不同 projectId ⇒ 缓存键不同 ⇒ 各自取数").toHaveBeenCalledTimes(2);
    expect(a.results.map((r) => r.entry.key)).not.toContain("beta 缓存约定");
    expect(b.results.map((r) => r.entry.key)).toContain("beta 缓存约定");
  });

  it("C4 LRU 上限 100：第 101 个查询把最旧的键挤掉", async () => {
    const searchSpy = vi.spyOn(svc, "search");
    for (let i = 0; i < 101; i++) {
      // 每个查询都补一个唯一词，避免与种子条目互相命中
      await svc.searchAcrossScopes(`唯一查询-${i}`, { projectId: PROJ_A }, { limit: 5 });
    }
    const calls = searchSpy.mock.calls.length;
    expect(calls).toBe(101);
    // 第 0 个键已被淘汰 ⇒ 再来一次必须重新取数
    await svc.searchAcrossScopes("唯一查询-0", { projectId: PROJ_A }, { limit: 5 });
    expect(searchSpy.mock.calls.length).toBe(calls + 1);
    // 而最近刚用过的键仍在缓存里
    await svc.searchAcrossScopes("唯一查询-100", { projectId: PROJ_A }, { limit: 5 });
    expect(searchSpy.mock.calls.length).toBe(calls + 1);
  });

  it("C5 缓存键含 embedder id：换 embedder 后同查询不会复用旧结果", async () => {
    const embedderV1 = makeEmbedder();
    setMemoryEmbedder(embedderV1);
    try {
      const first = await svc.searchAcrossScopes(
        "release deploy",
        { projectId: PROJ_A },
        { limit: 5, hybrid: true },
      );
      expect(first.backend, "有 embedder ⇒ 语义分参与排序（候选来自平台条目）").toBe("fts+hybrid");

      const embedderV2 = makeEmbedder("fake-semantic-v2");
      setMemoryEmbedder(embedderV2);
      await svc.searchAcrossScopes("release deploy", { projectId: PROJ_A }, { limit: 5, hybrid: true });
      expect(embedderV2.batches.length, "换 embedder ⇒ 缓存键变化 ⇒ 重新取向量").toBeGreaterThan(0);
    } finally {
      setMemoryEmbedder(null);
    }
  });
});
