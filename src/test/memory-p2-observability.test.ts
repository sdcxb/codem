/**
 * P2-B：记忆**可观测指标**（服务 API + 面板顶部展示）。
 *
 * ## 被守的缺陷（24 §P2「观测面板：注入条数、token、截断、usage、search 命中」）
 *
 * 改前：注入条数/字符/截断、检索命中、读取命中都只存在于服务内部（`computeInjection` 的
 * 局部变量），面板顶部只有"总计/各作用域/待批准/归档/体积"。—— 用户无法回答
 * 「这一轮到底注入了多少记忆」「我刚才那次检索命中了吗」；排查"记忆没生效"时只能靠猜。
 *
 * 这一组判据钉住：
 * 1. **指标随注入/检索变化**（注入 -> lines/chars/truncated；检索 -> queries/hits；读取 -> hits）；
 * 2. **按会话累计**（A 会话的数不许算到 B 会话上）；
 * 3. **重启保留**（计数落在 settings 小键里，`new MemoryService()` 读数不变）；
 * 4. **坏数据回 0**（坏 JSON / 非法计数器 ⇒ 0，绝不因此阻断记忆功能）；
 * 5. usage top N / 归档计数 / 整合撤销可用性都来自真实状态；
 * 6. **面板顶部显示**这四个关键指标，且**空态有一句解释**（不是一片空白）。
 *
 * 变异自证：把 `recordSearchHit`/`recordInjection` 改成空实现（计数恒 0）⇒ 1/6 立刻红；
 * 把持久化改成不写 settings ⇒ 3 红；把坏数据分支改成抛错 ⇒ 4 红。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { createFakeStoragePort, type FakeStoragePort } from "./fake-storage-port";
import { setStoragePort } from "../core/storage/port";
import { getMemoryService, MemoryService } from "../core/memory/memory";
import { createMemoryReadTool, createMemorySearchTool } from "../core/llm/tools/memory-tools";
import { setSetting } from "../core/storage/settings";

const PROJ = "c:\\work\\p2b";
const SESSION = "s-p2b";
const OTHER_SESSION = "s-p2b-other";
const OBS_KEY = "memory-observability";

function toolCtx(sessionId: string = SESSION) {
  return {
    sessionId,
    messageId: "m1",
    cwd: PROJ,
    abort: new AbortController().signal,
    messages: [],
    metadata: () => {},
  } as never;
}

let port: FakeStoragePort;

function freshPort(opts: Parameters<typeof createFakeStoragePort>[0] = {}): FakeStoragePort {
  port = createFakeStoragePort(opts);
  setStoragePort(port);
  return port;
}

describe("P2-B：可观测指标（服务 API）", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    freshPort();
  });
  afterEach(() => {
    setStoragePort(null);
    vi.restoreAllMocks();
  });

  it("P2-B-1: 指标随注入变化（条数/字符/截断）", () => {
    const svc = new MemoryService();
    svc.add({ scope: "platform", key: "平台约定", content: "回答用中文", source: "manual" });
    const before = svc.memoryObservability({ projectId: PROJ, sessionId: SESSION });
    expect(before.injection.lines, "还没注入过 ⇒ 0").toBe(0);
    expect(before.injection.chars).toBe(0);
    expect(before.injection.truncated).toBe(0);

    const text = svc.buildMemoryPrompt(undefined, PROJ, SESSION);
    expect(text, "前提：这次注入真的有内容").toContain("平台约定");

    const after = svc.memoryObservability({ projectId: PROJ, sessionId: SESSION });
    expect(after.injection.lines, "注入条数必须涨").toBeGreaterThan(0);
    expect(after.injection.chars, "注入字符数必须涨").toBeGreaterThan(0);
    // 只注入了 1 条 ⇒ 没有任何条目被条数上限/字符预算挡下
    expect(after.injection.truncated).toBe(0);
  });

  it("P2-B-2: 检索 / 读取命中按会话累计（A 会话的数不算到 B 上）", async () => {
    // 工具面用的是**单例**服务（`getMemoryService()`）；计数也落在它身上
    const svc = getMemoryService();
    await svc.reload();
    svc.add({ scope: "project", projectId: PROJ, key: "构建约定", content: "跑 npm run build", source: "manual" });
    const toolsSession = "s-p2b-tools";
    const toolsOther = "s-p2b-tools-other";

    const search = createMemorySearchTool();
    await search.execute({ query: "构建" }, toolCtx(toolsSession));
    await search.execute({ query: "构建" }, toolCtx(toolsSession));
    const read = createMemoryReadTool();
    const hit = (await search.execute({ query: "构建" }, toolCtx(toolsSession))) as never as {
      value: { ids: string[] };
    };
    await read.execute({ id: hit.value.ids[0] }, toolCtx(toolsSession));

    const mine = svc.memoryObservability({ projectId: PROJ, sessionId: toolsSession });
    expect(mine.search.queries, "三次 memory_search").toBe(3);
    expect(mine.search.hits, "每次至少命中 1 条").toBeGreaterThanOrEqual(3);
    expect(mine.read.hits, "memory_read 命中一次").toBe(1);

    const other = svc.memoryObservability({ projectId: PROJ, sessionId: toolsOther });
    expect(other.search.queries, "别的会话必须是独立计数").toBe(0);
    expect(other.search.hits).toBe(0);
    expect(other.read.hits).toBe(0);
  });

  it("P2-B-3: 重启保留（计数落在 settings 小键里，新实例读得到）", async () => {
    const svc = new MemoryService();
    svc.add({ scope: "platform", key: "正文不该进指标", content: "机密正文不要进指标键", source: "manual" });
    svc.recordSearchHit(SESSION, 4);
    svc.recordReadHit(SESSION);
    await svc.flushPendingPersist();

    expect(
      port.__table("settings").some((row) => row.key === OBS_KEY),
      "计数必须真的写进 settings（否则重启就丢了）",
    ).toBe(true);
    const raw = String(port.__table("settings").find((row) => row.key === OBS_KEY)?.value ?? "");
    expect(raw, "只许存计数，不许把记忆正文写进去").not.toContain("机密正文");

    const reloaded = new MemoryService();
    const metrics = reloaded.memoryObservability({ projectId: PROJ, sessionId: SESSION });
    expect(metrics.search.queries).toBe(1);
    expect(metrics.search.hits).toBe(4);
    expect(metrics.read.hits).toBe(1);
  });

  it("P2-B-4: 坏数据回 0（坏 JSON / 非法计数器都不许把指标或记忆搞坏）", () => {
    setStoragePort(null);
    freshPort();
    setSetting(OBS_KEY, "{ this is not json");
    const svc = new MemoryService();
    const broken = svc.memoryObservability({ projectId: PROJ, sessionId: SESSION });
    expect(broken.search.queries, "坏 JSON ⇒ 0（不是抛错）").toBe(0);
    expect(broken.injection.lines).toBe(0);

    // 合法 JSON + 非法计数器（字符串/负数/缺失）⇒ 逐项归 0
    setSetting(
      OBS_KEY,
      JSON.stringify({
        version: 1,
        sessions: {
          [SESSION]: { injectionLines: "很多", searchQueries: -3, searchHits: null, readHits: 1.5 },
        },
      }),
    );
    const svc2 = new MemoryService();
    const sanitized = svc2.memoryObservability({ projectId: PROJ, sessionId: SESSION });
    expect(sanitized.injection.lines, "字符串计数 ⇒ 0").toBe(0);
    expect(sanitized.search.queries, "负数计数 ⇒ 0").toBe(0);
    expect(sanitized.search.hits, "null ⇒ 0").toBe(0);
    expect(sanitized.read.hits, "非整数示例 1.5 ⇒ 1（向下取整，不丢真实计数）").toBe(1);

    // 坏数据之后**功能照常**：新计数从 0 起累加并覆盖成合法形状
    svc2.recordSearchHit(SESSION, 1);
    expect(svc2.memoryObservability({ sessionId: SESSION }).search.hits).toBe(1);
  });

  it("P2-B-5: usage top N / 归档计数 / 撤销可用性都来自真实状态", () => {
    const svc = new MemoryService();
    const used = svc.add({ scope: "platform", key: "常被读的约定", content: "读过很多次", source: "manual" }).entry!;
    svc.add({ scope: "platform", key: "没读过的约定", content: "usage 为 0", source: "manual" });
    svc.markUsed([used.id, used.id, used.id]);

    const before = svc.memoryObservability({ projectId: PROJ, sessionId: SESSION });
    expect(before.usage.top.length, "只列 usageCount > 0 的条目").toBe(1);
    expect(before.usage.top[0].id).toBe(used.id);
    expect(before.usage.top[0].usageCount).toBe(3);
    expect(before.archived).toBe(0);
    expect(before.consolidationUndo.available, "还没整合过 ⇒ 撤销不可用").toBe(false);

    // 用真实的 consolidate() 产生一条可撤销记录（两条近重复的 auto 条目）
    svc.add({
      scope: "platform",
      key: "Vitest 位置参数是路径子串匹配",
      content: "vitest 的位置参数按路径子串匹配；传多个参数时是 OR 关系。记号 ALPHA。",
      source: "auto",
    });
    svc.add({
      scope: "platform",
      key: "vitest 路径参数按子串匹配、多参数为 OR",
      content: "Vitest 位置参数匹配语义：路径子串匹配，多个参数之间是 OR。记号 BETA。",
      source: "auto",
    });
    const result = svc.consolidate();
    expect(result.changed, "前提：这次整合真的改了条目").toBeGreaterThan(0);
    expect(result.undoToken).toBeTruthy();

    const after = svc.memoryObservability({ projectId: PROJ, sessionId: SESSION });
    expect(after.consolidationUndo.available, "有未过期的撤销记录 ⇒ 可用").toBe(true);
    expect(after.consolidationUndo.changes).toBeGreaterThan(0);
    expect(after.archived, "整合只归档不删除 ⇒ 归档计数必须涨").toBeGreaterThan(0);
  });
});

describe("P2-B：面板顶部展示指标（含空态）", () => {
  beforeEach(async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    freshPort();
    /*
     * 面板读的是**单例**（`getMemoryService()`）：先把它喂成"有指标"的状态，
     * 再渲染 —— 这样断言的是"面板真的读了服务层的数"，而不是面板自己造了一个数。
     */
    const svc = getMemoryService();
    await svc.reload();
    svc.add({ scope: "platform", key: "平台约定", content: "回答用中文", source: "manual" });
    svc.buildMemoryPrompt("platform", PROJ, SESSION);
    svc.recordSearchHit(SESSION, 2);
  });
  afterEach(() => {
    cleanup();
    setStoragePort(null);
    vi.restoreAllMocks();
  });

  /*
   * 计时口径：P2-B-6 是文件里**第一个**动态 import `MemoryManager` 的用例（冷启动要现场编译
   * 整棵组件图）。实测 4.4–5.3s 抖动 ⇒ 默认 5s 在满载/冷缓存时假红。只放宽计时，断言不变。
   */
  it("P2-B-6: 顶部显示注入 / 检索命中 / 归档 / 撤销四格", async () => {
    const { MemoryManager } = await import("../components/MemoryManager");
    const { container } = render(
      createElement(MemoryManager, { onClose: () => {}, projectId: PROJ, sessionId: SESSION } as never),
    );
    await act(async () => {
      await Promise.resolve();
    });
    const text = (testId: string) => container.querySelector(`[data-testid="${testId}"]`)?.textContent ?? null;
    expect(container.querySelector('[data-testid="memory-observability"]'), "指标区必须渲染").toBeTruthy();
    expect(Number(text("memory-obs-injected"))).toBeGreaterThan(0);
    expect(text("memory-obs-search-hits"), "检索命中按会话累计").toBe("2");
    expect(text("memory-obs-archived")).toBe("0");
    expect(text("memory-obs-undo"), "没有整合记录 ⇒ 不可用").toBe("不可用");
    expect(
      container.querySelector('[data-testid="memory-observability-empty"]'),
      "有指标时不该显示空态",
    ).toBeNull();
  }, 15_000);

  it("P2-B-7: 空态 —— 本会话没有注入/检索记录时给一句解释（不是一片空白）", async () => {
    const { MemoryManager } = await import("../components/MemoryManager");
    const { container } = render(
      createElement(MemoryManager, { onClose: () => {}, projectId: PROJ, sessionId: "s-never-used" } as never),
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="memory-observability-empty"]')?.textContent ?? "").toContain(
      "还没有注入 / 检索记录",
    );
    // 数字仍照常显示 0（"没有注入"是事实，不是空数据）
    expect(container.querySelector('[data-testid="memory-obs-injected"]')?.textContent).toBe("0");
  });
});
