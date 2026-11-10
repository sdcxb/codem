/**
 * C08「可验证 Memory Graph」判据（营销 P1）。
 *
 * ## 被守的承诺（`docs/marketing/CONTEXT-OS-ACCEPTANCE.md` C08）
 *
 * 「记忆带来源、作用域、有效期、置信度、冲突与使用信号。
 *  `memory_read/search` 可取回全文与来源；冲突可见；过期可识别；scope 不泄漏；usage 参与排序。」
 *
 * ## 这一组判据分七条（每条都能因实现坏而变红）
 *
 * - **C08-1**：检索结果自带来源/作用域；`memory_read` 取回**全文**（不是再截一次摘要）；
 * - **C08-2**：有效期与**过期标记**出现在检索结果里（`expired` 逐字可断言）；
 * - **C08-3**：注入侧同样标注过期（行内 `已过期` + 块级提示），未过期的标「有效期至」；
 * - **C08-4**：冲突**可见**（同 scope+key 内容不同 ⇒ 互相给出对方 id）且**有查询**
 *   （`MemoryService.conflicts`）；内容逐字相同的两份**不算冲突**（那是判重的事）；
 * - **C08-5**：使用信号参与排序（注入块内 + 检索结果同分时）；
 * - **C08-6**：作用域**不泄漏** —— 别的项目里同 key 的条目既不进检索/冲突，也读不到；
 * - **C08-7**：字段**向后兼容** —— 旧 payload（没有新字段）照常读；新字段跨重载保住；
 *   非法值收敛成「未标注」而不是被编造。
 *
 * ⚠️ 本文件的注释里中文引号一律「」，与仓库纪律一致。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeStoragePort } from "./fake-storage-port";
import { setStoragePort } from "../core/storage/port";
import { saveMemory } from "../core/storage/settings";
import {
  MEMORY_EXPIRED_NOTICE_PREFIX,
  MemoryService,
  getMemoryService,
  injectionScopeContext,
  isExpiredMemoryEntry,
  type MemoryEntry,
} from "../core/memory/memory";
import { createMemoryReadTool, createMemorySearchTool } from "../core/llm/tools/memory-tools";

const PROJ = "c:\\work\\alpha";
const OTHER_PROJ = "c:\\work\\beta";
const SESSION = "s-c08";

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

const scopeCtx = () => injectionScopeContext(PROJ, SESSION);

/** 造一条「手写项目记忆」（默认 active，直接可注入/可检索） */
function addEntry(
  svc: MemoryService,
  fields: Partial<MemoryEntry> & { key: string; content: string },
): MemoryEntry {
  const result = svc.add({
    scope: "project",
    projectId: PROJ,
    source: "manual",
    ...fields,
  });
  expect(result.ok, `写入失败：${result.message ?? ""}`).toBe(true);
  return result.entry as MemoryEntry;
}

describe("C08 可验证 Memory Graph", () => {
  let svc: MemoryService;

  beforeEach(async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    saveMemory("");
    setStoragePort(createFakeStoragePort({}));
    svc = getMemoryService();
    await svc.reload();
  });

  afterEach(() => {
    setStoragePort(null);
    vi.restoreAllMocks();
  });

  it("C08-1：检索带来源与作用域；memory_read 取回全文（不是再截一次摘要）", async () => {
    const longBody = `第一条约定：跑 npm run build；${"补".repeat(400)}；最后一句在 500 字之后。`;
    const entry = addEntry(svc, { key: "构建与验证", content: longBody });

    const search = createMemorySearchTool();
    const hit = await search.execute({ query: "构建" }, toolCtx());
    expect(hit.isError).toBe(false);
    expect(hit.output, "来源必须出现在检索行里（谁写的决定可信度）").toContain("source=manual");
    /*
     * P2-A：检索行现在写成 `(scope · project=…)` —— 跨作用域检索（`scopeMode=all`）时
     * 光有 `(project)` 分不清是**哪个**项目的约定。判据同步加强成"作用域 + 归属键都要在"。
     */
    expect(hit.output, "作用域必须出现在检索行里").toContain("(project");
    expect(hit.output, "归属键必须出现在检索行里（跨作用域时据此判断是谁家的约定）").toContain(
      `project=${PROJ}`,
    );

    const read = createMemoryReadTool();
    const full = await read.execute({ id: entry.id }, toolCtx());
    expect(full.isError).toBe(false);
    expect(full.output, "读全文：正文必须完整（含 400 字之后的结尾）").toContain("最后一句在 500 字之后。");
    expect(full.output, "来源必须在读取结果里").toContain("source: manual");
    expect((full.value as { totalChars: number }).totalChars).toBe(longBody.length);
  });

  it("C08-2：有效期与过期标记出现在检索结果里（expired 逐字可见）", async () => {
    const now = Date.now();
    const stale = addEntry(svc, {
      key: "旧部署方式",
      content: "部署到旧集群 A",
      validUntil: now - 24 * 60 * 60 * 1000,
      confidence: 0.9,
    });
    const fresh = addEntry(svc, {
      key: "新部署方式",
      content: "部署到新集群 B",
      validUntil: now + 24 * 60 * 60 * 1000,
      confidence: 0.7,
    });

    const search = createMemorySearchTool();
    const res = await search.execute({ query: "部署" }, toolCtx());
    const lines = res.output.split("\n").filter((l) => l.includes("部署"));
    const staleLine = lines.find((l) => l.includes(stale.id)) ?? "";
    const freshLine = lines.find((l) => l.includes(fresh.id)) ?? "";

    expect(staleLine, "过期条目必须标 expired").toContain("expired");
    expect(staleLine, "过期条目仍要给出有效期本身").toContain("validUntil=");
    expect(freshLine, "未过期条目不许出现 expired").not.toContain("expired");
    expect(freshLine, "未过期条目要给有效期").toContain("validUntil=");
    expect(staleLine, "置信度必须可见").toContain("confidence=0.9");
    expect((res.value as { expired: number }).expired).toBe(1);

    // 读取路径同样要标（模型读完正文才做决定，这里不给等于没标）
    const read = createMemoryReadTool();
    const staleRead = await read.execute({ id: stale.id }, toolCtx());
    expect(staleRead.output).toContain("expired");
    expect(staleRead.output).toContain("confidence: 0.9");
    expect((staleRead.value as { expired: boolean }).expired).toBe(true);

    const freshRead = await read.execute({ id: fresh.id }, toolCtx());
    expect((freshRead.value as { expired: boolean }).expired).toBe(false);
  });

  it("C08-3：注入侧标注过期（行内标记 + 块级提示），未过期标「有效期至」", () => {
    const now = Date.now();
    addEntry(svc, {
      key: "旧约定",
      content: "过期的那条",
      validUntil: now - 60_000,
    });
    addEntry(svc, {
      key: "新约定",
      content: "还作数的那条",
      validUntil: now + 60_000,
    });

    const prompt = svc.buildMemoryPrompt("project", PROJ, SESSION);
    expect(prompt, "过期条目行内必须有已过期标记").toContain("已过期");
    expect(prompt, "块级必须给结论（不是只在行尾埋一个词）").toContain(MEMORY_EXPIRED_NOTICE_PREFIX);
    expect(prompt, "未过期条目要给有效期").toContain("有效期至");

    // 没有有效期 ⇒ 注入行一个字符都不多（旧数据行为逐字不变）
    const legacy = addEntry(svc, { key: "无有效期", content: "老数据没有有效期" });
    expect(isExpiredMemoryEntry(legacy), "没有有效期不等于过期").toBe(false);
    const second = svc.buildMemoryPrompt("project", PROJ, SESSION);
    expect(second, "存在过期条目的块仍要提示").toContain(MEMORY_EXPIRED_NOTICE_PREFIX);
  });

  it("C08-4：冲突可见且可查询（同 scope+key 内容不同）；内容相同不算冲突", async () => {
    const a = addEntry(svc, { key: "部署方式", content: "部署用脚本 A（蓝绿）" });
    const b = addEntry(svc, { key: "部署方式", content: "部署用脚本 B（滚动）" });
    // 逐字重复：这是判重的事，不是冲突（否则「冲突」这个词会贬值）
    const dup = addEntry(svc, { key: "日志位置", content: "日志在 logs/app.log" });
    const dup2 = addEntry(svc, { key: "日志位置", content: "日志在 logs/app.log" });

    const search = createMemorySearchTool();
    const res = await search.execute({ query: "部署" }, toolCtx());
    const lineA = res.output.split("\n").find((l) => l.includes(a.id)) ?? "";
    const lineB = res.output.split("\n").find((l) => l.includes(b.id)) ?? "";
    expect(lineA, "A 必须给出与它冲突的 B 的 id").toContain(b.id);
    expect(lineB, "B 必须给出与它冲突的 A 的 id").toContain(a.id);
    expect(res.output, "冲突结论要有可读提示").toContain("conflict");

    const groups = svc.conflicts(scopeCtx());
    const deploy = groups.find((g) => g.ids.includes(a.id) && g.ids.includes(b.id));
    expect(deploy, "冲突查询必须能查到这一组").toBeTruthy();
    expect(deploy?.bucket).toBe("key");
    expect(deploy?.ids.length).toBe(2);
    expect(
      groups.some((g) => g.ids.includes(dup.id) && g.ids.includes(dup2.id)),
      "逐字相同的两份不许被当成冲突",
    ).toBe(false);
  });

  it("C08-5：使用信号参与排序（注入块内 + 检索同分时）", async () => {
    // 三条同分条目（都命中「约定」）。使用次数刻意与创建序**不同向**，否则断言是空转：
    // 没有 usage 时注入按创建序倒序（e3,e2,e1）、检索按插入序（e1,e2,e3）；
    // 有 usage 时两边都必须是 e1(5) → e3(1) → e2(0)。
    const e1 = addEntry(svc, { key: "alpha 约定", content: "alpha 的说明" });
    const e2 = addEntry(svc, { key: "beta 约定", content: "beta 的说明" });
    const e3 = addEntry(svc, { key: "gamma 约定", content: "gamma 的说明" });
    svc.markUsed([e1.id, e1.id, e1.id, e1.id, e1.id]); // e1 = 5
    svc.markUsed([e3.id]); // e3 = 1，e2 = 0
    expect(svc.get(e1.id)?.usageCount).toBe(5);
    expect(svc.get(e3.id)?.usageCount).toBe(1);
    expect(svc.get(e2.id)?.usageCount ?? 0).toBe(0);

    const prompt = svc.buildMemoryPrompt("project", PROJ, SESSION);
    const pos = [prompt.indexOf(e1.id), prompt.indexOf(e3.id), prompt.indexOf(e2.id)];
    expect(pos.every((p) => p >= 0)).toBe(true);
    expect(pos[0], "被读得最多的那条必须排最前（否则它会被每轮新写入挤掉）").toBeLessThan(pos[1]);
    expect(pos[1], "同分区间内 usage 高的在前").toBeLessThan(pos[2]);

    // 检索侧：三条同分（都命中「约定」）⇒ usage 决定先后
    const search = createMemorySearchTool();
    const res = await search.execute({ query: "约定" }, toolCtx());
    const ids = (res.value as { ids: string[] }).ids;
    expect(ids, "检索同分时 usage 高的排前（不是按插入序）").toEqual([e1.id, e3.id, e2.id]);
  });

  it("C08-6：作用域不泄漏 —— 别的项目的条目进不了检索/冲突/读取", async () => {
    const mine = addEntry(svc, { key: "共享 key", content: "alpha 的说法" });
    const outsider = svc.add({
      scope: "project",
      projectId: OTHER_PROJ,
      source: "manual",
      key: "共享 key",
      content: "beta 的说法（不许出现在 alpha）",
      validUntil: Date.now() - 1000,
    });
    expect(outsider.ok).toBe(true);
    const outsiderId = outsider.entry?.id as string;

    const search = createMemorySearchTool();
    const res = await search.execute({ query: "共享" }, toolCtx(PROJ));
    expect(res.output).toContain(mine.key);
    expect(res.output, "别的项目的正文不许出现").not.toContain("beta 的说法");
    expect(res.output, "别的项目的 id 不许出现（冲突列表也不行）").not.toContain(outsiderId);

    const groups = svc.conflicts(scopeCtx());
    expect(
      groups.some((g) => g.ids.includes(outsiderId)),
      "冲突查询不许跨项目（那是侧信道）",
    ).toBe(false);

    const read = createMemoryReadTool();
    const denied = await read.execute({ id: outsiderId }, toolCtx(PROJ));
    expect(denied.isError, "别的项目的条目读不到").toBe(true);
    expect(denied.output).not.toContain("beta 的说法");

    // 反向：在 beta 里能看到它自己（证明上面不是「谁都看不到」）
    const inBeta = await search.execute({ query: "共享" }, toolCtx(OTHER_PROJ));
    expect(inBeta.output).toContain("beta 的说法");
  });

  it("C08-7：字段向后兼容 —— 旧 payload 照常读、新字段跨重载保住、非法值不当真", async () => {
    // ① 旧 payload：没有 source/validUntil/confidence/conflict 任何新字段
    saveMemory(
      JSON.stringify({
        version: 2,
        entries: {
          "mem-legacy": { id: "mem-legacy", scope: "project", projectId: PROJ, key: "旧条目", content: "旧正文", timestamp: 1 },
        },
      }),
    );
    await svc.reload();
    const legacy = svc.listAll(scopeCtx()).find((e) => e.id === "mem-legacy");
    expect(legacy, "旧 payload 必须照常读出来").toBeTruthy();
    expect(isExpiredMemoryEntry(legacy as MemoryEntry), "缺省 = 永不过期").toBe(false);
    expect((legacy as MemoryEntry).confidence, "缺省 = 未标注（不是 0）").toBeUndefined();

    // ② 新字段跨重载保住（白名单漏登记 ⇒ 重启后悄悄丢）
    const withAll = addEntry(svc, {
      key: "带全部维度",
      content: "带有效期与置信度",
      validUntil: 1_900_000_000_000,
      confidence: 0.42,
      conflictGroup: "g-1",
    });
    await svc.saveConfirmed();
    const before = svc.get(withAll.id) as MemoryEntry;
    expect(before.validUntil).toBe(1_900_000_000_000);
    expect(before.confidence).toBe(0.42);
    await svc.reload();
    const after = svc.get(withAll.id) as MemoryEntry;
    expect(after.validUntil, "有效期必须跨重载保住").toBe(1_900_000_000_000);
    expect(after.confidence, "置信度必须跨重载保住").toBe(0.42);
    expect(after.conflictGroup, "冲突组标签必须跨重载保住").toBe("g-1");

    // ③ 非法值：越界置信度/坏有效期 ⇒ 当成「未标注」而不是被夹成 0/1 或编造日期
    saveMemory(
      JSON.stringify({
        version: 2,
        entries: {
          "mem-bad": {
            id: "mem-bad",
            scope: "project",
            projectId: PROJ,
            key: "坏字段",
            content: "坏值不许编造",
            timestamp: 1,
            validUntil: -5,
            confidence: 7,
          },
        },
      }),
    );
    await svc.reload();
    const bad = svc.get("mem-bad") as MemoryEntry;
    expect(bad.validUntil, "负有效期 ⇒ 永不过期").toBeUndefined();
    expect(bad.confidence, "越界置信度 ⇒ 未标注（不夹成 1）").toBeUndefined();
  });
});
