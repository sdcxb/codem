/**
 * P0-1：记忆**取回**链路（`memory_search` / `memory_read` / 注入提示 / 使用信号 / 提取源）。
 *
 * ## 被守的缺陷（24 §0.1–§0.2）
 *
 * 注入每行只给**摘要上限**（`MEMORY_INJECT_LINE_MAX`，现为 120 字符），而一条记忆允许
 * 10,000 字符 —— 长约定后半段在库里、模型却没有任何入口把它取回来。这一组判据钉住"取回"的四个面：
 *
 * 1. 检索能命中，且**作用域 fail-closed**（看不到别的项目 / 未批准条目）；
 * 2. 读取给的是**全文**，不是再截一次摘要；
 * 3. 读取记一次使用信号，并**落库**（重启后还在），且它只影响块内顺序、
 *    不影响"从没读过"的条目的既有顺序；
 * 4. 注入行是**索引式**的（`- [date] (id) key — 摘要… ·用N`）：id 恒在行内，
 *    `…` 只在摘要超限时出现，模型据此随时能读回全文。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeStoragePort } from "./fake-storage-port";
import { setStoragePort } from "../core/storage/port";
import { getMemoryService, MEMORY_INJECT_LINE_MAX, MemoryService } from "../core/memory/memory";
import { createMemoryReadTool, createMemorySearchTool } from "../core/llm/tools/memory-tools";
import { createMessage, listMessages, listTimelineMessages, pickExtractionMessages } from "../core/storage/message";
import { buildContextEpochMetadata } from "../core/context/context-view";

const PROJ = "c:\\work\\alpha";
const OTHER_PROJ = "c:\\work\\beta";
const SESSION = "s-mem-tools";

function toolCtx(cwd: string = PROJ) {
  return {
    sessionId: SESSION,
    messageId: "m1",
    cwd,
    abort: new AbortController().signal,
    messages: [],
    metadata: () => {},
  } as never;
}

describe("memory_search / memory_read（P0-1）", () => {
  let svc: MemoryService;

  beforeEach(async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    setStoragePort(createFakeStoragePort({}));
    svc = getMemoryService();
    await svc.reload();
  });

  afterEach(() => {
    setStoragePort(null);
    vi.restoreAllMocks();
  });

  it("MR-1: 检索命中返回 id / scope / key（模型据此才能读全文）", async () => {
    svc.add({ scope: "project", key: "构建命令", content: "跑 npm run build，不要直接 tsc", projectId: PROJ, source: "manual" });
    const tool = createMemorySearchTool();
    const res = await tool.execute({ query: "构建" }, toolCtx());

    expect(res.isError).toBe(false);
    expect(res.output).toContain("[");
    expect(res.output, "必须有 id").toMatch(/\[mem-[^\]]+\]|\[[^\]]+\]/);
    expect(res.output).toContain("构建命令");
    expect(res.output).toContain("memory_read");
  });

  it("MR-2: 作用域 fail-closed —— 别的项目的条目搜不到", async () => {
    svc.add({ scope: "project", key: "alpha 的约定", content: "只属于 alpha", projectId: PROJ, source: "manual" });
    svc.add({ scope: "project", key: "beta 的约定", content: "只属于 beta", projectId: OTHER_PROJ, source: "manual" });

    const tool = createMemorySearchTool();
    const inAlpha = await tool.execute({ query: "约定" }, toolCtx(PROJ));
    expect(inAlpha.output).toContain("alpha 的约定");
    expect(inAlpha.output, "beta 的条目不许出现").not.toContain("beta 的约定");

    const inBeta = await tool.execute({ query: "约定" }, toolCtx(OTHER_PROJ));
    expect(inBeta.output).toContain("beta 的约定");
    expect(inBeta.output).not.toContain("alpha 的约定");
  });

  it("MR-3: 未批准（pending）的条目不可检索（不许绕开审批）", async () => {
    svc.add({ scope: "project", key: "待批准的约定", content: "还没批", projectId: PROJ, source: "auto", status: "pending" });
    const tool = createMemorySearchTool();
    const res = await tool.execute({ query: "待批准" }, toolCtx());
    expect(res.output).not.toContain("待批准的约定");
  });

  it("MR-4: memory_read 返回全文（1200 字不被截到 200）", async () => {
    const long = "长约定" + "细节".repeat(600); // 1200 字
    const added = svc.add({ scope: "project", key: "超长约定", content: long, projectId: PROJ, source: "manual" });
    expect(added.ok, "夹具必须真的写进去").toBe(true);

    const tool = createMemoryReadTool();
    const res = await tool.execute({ id: added.entry!.id }, toolCtx());
    expect(res.isError).toBe(false);
    expect(res.output).toContain("细节".repeat(100));
    expect(res.output.length).toBeGreaterThan(1000);
  });

  it("MR-5: memory_read 记一次使用信号，并真的落库（重启后仍在）", async () => {
    const added = svc.add({ scope: "project", key: "常用约定", content: "会被读", projectId: PROJ, source: "manual" });
    const tool = createMemoryReadTool();
    await tool.execute({ id: added.entry!.id }, toolCtx());
    await svc.flushPendingPersist();

    const reloaded = new MemoryService();
    const entry = reloaded.listAll(injectionCtx()).find((e) => e.id === added.entry!.id);
    expect(entry?.usageCount, "usageCount 必须落库").toBe(1);
    expect(entry?.lastUsedAt, "lastUsedAt 必须落盘").toBeGreaterThan(0);
  });

  it("MR-12: memory_read 的契约与事实一致（会写 usage ⇒ 非只读 + memory 副作用）", async () => {
    const added = svc.add({ scope: "project", key: "契约约定", content: "读一次就记 usage", projectId: PROJ, source: "manual" });
    const tool = createMemoryReadTool();
    /*
     * 被守的缺陷：它声明 `readOnly: true / sideEffectScope: "none"`，实际却调
     * `markUsed` 持久化 usageCount —— 权限层会按「只读」放行一个会写记忆库的工具。
     * 变异自证：把契约改回只读/无副作用 ⇒ 下面两条立刻红；把 markUsed 摘掉 ⇒
     * 行为断言与 MR-5 同时红。
     */
    expect(tool.contract?.readOnly, "会写记忆库的工具不能声明为只读").toBe(false);
    expect(tool.contract?.sideEffectScope, "副作用范围必须显式是 memory").toBe("memory");

    const used = vi.spyOn(svc, "markUsed");
    try {
      const res = await tool.execute({ id: added.entry!.id }, toolCtx());
      expect(res.isError).toBe(false);
      expect(used, "声明说会写 usage，执行体就必须真的调 markUsed").toHaveBeenCalled();
    } finally {
      used.mockRestore();
    }

    /* 反向对照：search 不写任何东西，必须保持只读/无副作用（别一锅端） */
    const search = createMemorySearchTool();
    expect(search.contract?.readOnly).toBe(true);
    expect(search.contract?.sideEffectScope).toBe("none");
  });

  it("MR-6: 读不到的 id 如实报错（不伪装成「没有这条记忆」）", async () => {
    const tool = createMemoryReadTool();
    const res = await tool.execute({ id: "mem-does-not-exist" }, toolCtx());
    expect(res.isError).toBe(true);
    expect(res.output).toMatch(/not visible|not exist/i);
  });

  it("MR-7: 注入行**恒**带 (id)（索引式）；摘要超限以 … 标记，用行内 id 能读回摘要之后的尾部", async () => {
    const long = "长".repeat(400);
    const short = "短";
    const longAdded = svc.add({ scope: "project", key: "长的", content: long, projectId: PROJ, source: "manual" });
    const shortAdded = svc.add({ scope: "project", key: "短的", content: short, projectId: PROJ, source: "manual" });

    const prompt = svc.buildMemoryPrompt("project", PROJ, undefined);
    const longLine = prompt.split("\n").find((l) => l.includes("长的"))!;
    const shortLine = prompt.split("\n").find((l) => l.includes("短的"))!;

    /**
     * 24 §0.4 索引式注入的行格式：`- [date] (id) key — 摘要…`。
     * id **恒在行内**（不再只在被截断时出现），摘要上限走 `MEMORY_INJECT_LINE_MAX`。
     */
    const lineShape = /^- \[([^\]]+)\] \(([^)]+)\) (.+?) — (.*)$/;
    const longMatch = lineShape.exec(longLine);
    expect(longMatch, `注入行必须是「- [date] (id) key — 摘要」形态，实际：${longLine.slice(0, 80)}`).not.toBeNull();
    const [, , longId, longKey, longSummary] = longMatch!;
    expect(longKey, "key 必须原样在行内（摘要之前）").toBe("长的");
    expect(longId, "行内 id 必须就是条目的 id（不是另编一个）").toBe(longAdded.entry!.id);
    expect(
      longSummary.replace(/…$/, "").length,
      "摘要不得超过 MEMORY_INJECT_LINE_MAX",
    ).toBeLessThanOrEqual(MEMORY_INJECT_LINE_MAX);
    expect(longLine.endsWith("…"), "正文长于摘要上限时必须以 … 收尾").toBe(true);
    expect(longLine, "usageCount=0 ⇒ 一个字都不许加").not.toContain("·用");

    const shortMatch = lineShape.exec(shortLine);
    expect(shortMatch, "未截断的行也必须是同一形态（id 恒在行内）").not.toBeNull();
    const [, , shortId, , shortSummary] = shortMatch!;
    expect(shortId, "未截断的条目同样带 id").toBe(shortAdded.entry!.id);
    expect(shortSummary, "未截断 ⇒ 没有 …").toBe("短");
    expect(shortLine, "未截断的条目不许多余标记").not.toContain("…");

    /**
     * 光有"行里有 id"还不够：那个 id 必须**真的能读回同一句结论**（含摘要之后的尾部）。
     * 否则提示就是一句指错门的指路牌（模型照做 → not found → 更糟）。
     */
    const readBack = await createMemoryReadTool().execute({ id: longId }, toolCtx());
    expect(readBack.isError).toBe(false);
    expect(readBack.output, "读回来的必须就是被截断的那条（含摘要上限之后的尾部）").toContain(long.slice(-50));

    // 取用一次 ⇒ 行尾出现「·用1」（使用信号只在 >0 时写，这条同时钉住"加"的那一侧）
    const afterRead = svc.buildMemoryPrompt("project", PROJ, undefined).split("\n").find((l) => l.includes("长的"))!;
    expect(afterRead, "取用一次之后行尾必须有 ·用1").toContain("·用1");
    expect(
      svc.buildMemoryPrompt("project", PROJ, undefined).split("\n").find((l) => l.includes("短的"))!,
      "没被取用的条目仍然不许出现 ·用",
    ).not.toContain("·用");
  });

  it("MR-11: conversation 作用域 —— 本会话可见、别的会话读不到（ctx 的唯一来源是 sessionId）", async () => {
    /**
     * `scopeContext` 是工具层作用域的唯一来源。只测 project 隔离抓不到"丢掉 sessionId"
     * 这类变异（那种变异下 project 用例全绿，而本会话的 conversation 记忆在工具里彻底消失）。
     */
    const mine = svc.add({
      scope: "conversation",
      key: "本会话约定",
      content: "只属于当前对话",
      sessionId: SESSION,
      source: "manual",
    });
    const other = svc.add({
      scope: "conversation",
      key: "别的会话约定",
      content: "属于另一个对话",
      sessionId: "s-other",
      source: "manual",
    });

    const search = createMemorySearchTool();
    const hit = await search.execute({ query: "会话约定" }, toolCtx());
    expect(hit.output).toContain("本会话约定");
    expect(hit.output, "别的对话的记忆不许出现").not.toContain("别的会话约定");

    const read = createMemoryReadTool();
    const ok = await read.execute({ id: mine.entry!.id }, toolCtx());
    expect(ok.isError).toBe(false);
    const denied = await read.execute({ id: other.entry!.id }, toolCtx());
    expect(denied.isError, "跨会话按 id 直接读也必须被拒").toBe(true);
  });

  it("MR-8: 使用信号只影响块内顺序（读过的排前，其余不动）", () => {
    const older = svc.add({ scope: "project", key: "OLD", content: "旧", projectId: PROJ, source: "manual" });
    const newer = svc.add({ scope: "project", key: "NEW", content: "新", projectId: PROJ, source: "manual" });

    const before = svc.buildMemoryPrompt("project", PROJ, undefined);
    expect(before.indexOf("NEW"), "改前：创建序倒序（新的在前）").toBeLessThan(before.indexOf("OLD"));

    svc.markUsed([older.entry!.id]);
    const after = svc.buildMemoryPrompt("project", PROJ, undefined);
    expect(after.indexOf("OLD"), "读过一次之后，旧条目排到前面").toBeLessThan(after.indexOf("NEW"));
    expect(newer.entry!.id).toBeTruthy();
  });
});

function injectionCtx() {
  return { projectId: PROJ, sessionId: SESSION } as never;
}

describe("提取源（P0-1 / 24 §0.2②）", () => {
  const S = "s-extract-source";

  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    setStoragePort(createFakeStoragePort({
      seed: { sessions: [{ id: S, project_id: "", title: "t", created_at: 0, last_message_at: 0, message_count: 0 }] },
    }));
  });
  afterEach(() => {
    setStoragePort(null);
    vi.restoreAllMocks();
  });

  it("MR-9: 压缩之后，提取源仍能看到被摘要取代的原文", () => {
    createMessage({ id: "m1", role: "user", content: "压缩前的重要事实", timestamp: 1, status: "done" }, S);
    createMessage({ id: "m2", role: "assistant", content: "压缩前的回答", timestamp: 2, status: "done" }, S);
    createMessage({ id: "m3", role: "user", content: "压缩后", timestamp: 3, status: "done" }, S);
    createMessage({
      id: "compact-100-1",
      role: "user",
      content: "[上下文已自动压缩] 摘要",
      timestamp: 4,
      status: "done",
      metadata: buildContextEpochMetadata({
        epochId: "compact-100-1",
        cutoffMessageId: "m3",
        createdAt: 100,
        kind: "compact",
        segmentSeq: 1,
      }) ?? undefined,
    }, S);

    expect(listMessages(S).map((m) => m.id), "前提：模型视图只有最新段").toEqual(["compact-100-1", "m3"]);
    const extraction = pickExtractionMessages(listMessages(S), listTimelineMessages(S)).map((m) => m.id);
    expect(extraction, "提取源必须含压缩前原文").toContain("m1");
    expect(extraction).toContain("m2");
  });

  it("MR-10: 没有压缩时，提取源与模型视图逐条相同（灰度安全）", () => {
    createMessage({ id: "n1", role: "user", content: "一", timestamp: 1, status: "done" }, S);
    createMessage({ id: "n2", role: "assistant", content: "二", timestamp: 2, status: "done" }, S);
    const picked = pickExtractionMessages(listMessages(S), listTimelineMessages(S));
    expect(picked.map((m) => m.id)).toEqual(listMessages(S).map((m) => m.id));
  });
});
