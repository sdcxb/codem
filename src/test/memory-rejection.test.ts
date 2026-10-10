/**
 * 第 200 波判据：**用户拒绝过的同类记忆，不再自动写入、也不再请求批准**；但**用户主动要求记住的放行**。
 *
 * ## 用户原话
 *
 * > 记忆系统里我已经拒绝的类似记忆，不要再自动写入和让我审批，每次自动写入查一下是否有已经类似拒绝的。
 * > 我在聊天里主动让它记忆的放行。
 *
 * ## 旧实现的洞
 *
 * 「拒绝 = 删除」—— 删完不留痕，于是下一轮（或下一个对话、下一次换了工作目录之后）模型把同一件事
 * 重新推导出来，用户**又被问一次**。真机取证：同一条事实被写了 5 遍，用户逐条拒绝后仍然换着说法回来。
 *
 * ## 判据清单
 *
 * - `REJ-1`：拒绝一条待批准条目 ⇒ 留下一条"已拒绝"记录（含标题/正文/作用域/时间）。
 * - `REJ-2`：此后**换个说法**再提取同一件事 ⇒ 不写入、不进待批准；日志如实说明被哪条记录挡住。
 * - `REJ-3`（反向对照 · 用户主动要求）：同一条事实带 `explicit: true` ⇒ **照常写入且直接生效**。
 * - `REJ-4`（反向对照 · 不误伤）：与已拒绝记录**不同**的事实（真机那对 0.23 的误报）照常写入。
 * - `REJ-5`：删除**已生效**的记忆**不**产生拒绝记录（那是"不想要这条"，不是"拒绝这个提议"）；
 *   删除**待批准**的条目**要**产生（用户意图相同）。
 * - `REJ-6`：拒绝记录有界（超过上限丢最旧的）+ 落库后重载仍在。
 * - `REJ-7`（退路）：`clearRejections()` 之后同类又能被写入（误点拒绝不能变成永久锁死）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setStoragePort } from "../core/storage/port";
import { createFakeStoragePort } from "./fake-storage-port";
import { saveMemory, setSetting, setSettingJSON } from "../core/storage/settings";
import { MemoryService, MEMORY_WRITE_APPROVAL_KEY } from "../core/memory/memory";
import { LLMEngine } from "../core/llm/index";
import * as MessageStorage from "../core/storage/message";

const PROJ_A = "c:\\work\\alpha";
const SESSION = "s-200";

/** 真机库里"同一条事实的两种写法"（0.54 那一对） */
const FACT_A = {
  key: "Vitest 位置参数匹配语义",
  content: "vitest 的位置参数按**路径子串**匹配（不是 glob），多个参数之间是**或**关系。",
};
const FACT_A_REWORDED = {
  key: "vitest 路径参数按子串匹配、多参数为 OR",
  content: "vitest 的位置参数是按路径子串匹配，多个参数之间为 OR 关系。",
};
/** 真机库里那对**不同**的事实（合并 0.23，判重不该认，拒绝记录也不该挡） */
const OTHER_FACT = {
  key: "二进制 MCP 资源不内联",
  content: "读取二进制 MCP 资源时不会内联大段 base64，而是返回占位摘要。",
};

function engineForExtraction(memory: MemoryService, sessionId: string, payloads: string[], messageCount = 12) {
  setSettingJSON(`memory-enabled-${sessionId}`, true);
  const engine = new LLMEngine();
  (engine as unknown as { memory: MemoryService }).memory = memory;
  const provider = { id: "test", isConfigured: () => true, complete: async () => ({ content: "[]" }) };
  (engine as unknown as { providers: unknown }).providers = { get: () => provider };
  (engine as unknown as { profileManager: unknown }).profileManager = { resolveSlot: () => null };
  vi.spyOn(MessageStorage, "listMessages").mockImplementation(
    () =>
      Array.from({ length: messageCount }, (_, i) => ({
        id: `m${i}`,
        role: i % 2 ? "assistant" : "user",
        content: "x",
      })) as never,
  );
  let call = 0;
  vi.spyOn(engine, "spawnForked").mockImplementation((async () => {
    const payload = payloads[Math.min(call, payloads.length - 1)];
    call += 1;
    return payload;
  }) as never);
  return engine;
}

/** 让"下一轮"真的被允许跑（水位按消息条数走，涨够 4 条才重开） */
function growSession(extra: number, base = 12): void {
  vi.spyOn(MessageStorage, "listMessages").mockImplementation(
    () =>
      Array.from({ length: base + extra }, (_, i) => ({
        id: `n${i}`,
        role: i % 2 ? "assistant" : "user",
        content: "x",
      })) as never,
  );
}

beforeEach(() => {
  saveMemory("");
  setStoragePort(createFakeStoragePort({ seed: { settings: [{ key: "noop", value: "" }] } }));
  /* 默认审批：项目级需批准（这样"是否进待批准"是可观察的） */
  setSetting(MEMORY_WRITE_APPROVAL_KEY, JSON.stringify({ platform: true, project: true, conversation: false }));
});

afterEach(() => {
  vi.restoreAllMocks();
  setStoragePort(null);
});

describe("MEM-REJECT：已拒绝记录", () => {
  it("REJ-1：拒绝一条待批准条目 ⇒ 留下一条记录（标题/正文/作用域/时间都在）", () => {
    const svc = new MemoryService();
    const added = svc.add({ scope: "project", projectId: PROJ_A, key: FACT_A.key, content: FACT_A.content, source: "auto", status: "pending" });
    expect(added.ok).toBe(true);
    expect(svc.reject(added.entry!.id), "拒绝应当成功").toBe(true);

    const records = svc.listRejections();
    expect(records, "拒绝必须留痕（旧实现是「拒绝 = 删除」，什么都不留）").toHaveLength(1);
    expect(records[0].key).toBe(FACT_A.key);
    expect(records[0].content).toContain("路径子串");
    expect(records[0].scope).toBe("project");
    expect(records[0].rejectedAt).toBeGreaterThan(0);
    expect(svc.get(added.entry!.id), "条目本身仍然被删掉（拒绝 = 不要它）").toBeUndefined();
  });

  it("REJ-2：拒过之后，**换个说法**的同一件事不再写入、也不再进待批准", async () => {
    const svc = new MemoryService();
    const added = svc.add({ scope: "project", projectId: PROJ_A, key: FACT_A.key, content: FACT_A.content, source: "auto", status: "pending" });
    svc.reject(added.entry!.id);

    const engine = engineForExtraction(svc, SESSION, [
      JSON.stringify([{ ...FACT_A_REWORDED, scope: "project" }]),
    ]);
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });

    await engine.extractMemoriesFromSession(SESSION, PROJ_A);

    expect(svc.listByScope("project", { projectId: PROJ_A, includePending: true, includeUnscoped: true }), "不许写进去").toHaveLength(0);
    expect(svc.listPending(undefined, { projectId: PROJ_A }), "更不该再让用户批准一次").toHaveLength(0);
    expect(
      logs.some((l) => l.includes("用户拒绝过同类")),
      "被拒绝记录挡住这件事要如实写进日志（否则用户以为提取坏了）",
    ).toBe(true);
  });

  it("REJ-3（反向对照）：用户**在对话里主动要求记住**的 ⇒ 放行，且直接生效", async () => {
    const svc = new MemoryService();
    const added = svc.add({ scope: "project", projectId: PROJ_A, key: FACT_A.key, content: FACT_A.content, source: "auto", status: "pending" });
    svc.reject(added.entry!.id);

    const engine = engineForExtraction(svc, SESSION, [
      JSON.stringify([{ ...FACT_A_REWORDED, scope: "project", explicit: true }]),
    ]);
    await engine.extractMemoriesFromSession(SESSION, PROJ_A);

    const all = svc.listByScope("project", { projectId: PROJ_A, includePending: true, includeUnscoped: true });
    expect(all, "用户说了记住 ⇒ 必须放行（否则「我让你记的你没记」）").toHaveLength(1);
    expect(all[0].status ?? "active", "用户主动要求 = 已经批准 ⇒ 直接生效，不再问一次").toBe("active");
    expect(svc.listPending(undefined, { projectId: PROJ_A }), "不该再进待批准").toHaveLength(0);
  });

  it("REJ-4（反向对照 · 不误伤）：与已拒绝记录**不同**的事实照常写入", async () => {
    const svc = new MemoryService();
    const added = svc.add({ scope: "project", projectId: PROJ_A, key: FACT_A.key, content: FACT_A.content, source: "auto", status: "pending" });
    svc.reject(added.entry!.id);

    const engine = engineForExtraction(svc, SESSION, [JSON.stringify([{ ...OTHER_FACT, scope: "project" }])]);
    await engine.extractMemoriesFromSession(SESSION, PROJ_A);

    const pending = svc.listPending(undefined, { projectId: PROJ_A });
    expect(pending.map((p) => p.key), "不同的事实不该被某条拒绝记录连坐").toEqual([OTHER_FACT.key]);
  });

  it("REJ-5：删**已生效**的不算拒绝；删**待批准**的才算", () => {
    const svc = new MemoryService();
    const active = svc.add({ scope: "project", projectId: PROJ_A, key: "已生效的事实", content: "这条已经生效了", source: "auto" });
    const pending = svc.add({ scope: "project", projectId: PROJ_A, key: "待批准的事实", content: "这条还在等批准", source: "auto", status: "pending" });

    expect(svc.delete(active.entry!.id), "前提：已生效那条删得掉").toBe(true);
    expect(svc.listRejections(), "删一条已生效的记忆 = 不想要它了，不是「拒绝这个提议」⇒ 不留记录").toHaveLength(0);

    svc.delete(pending.entry!.id);
    expect(svc.listRejections().map((r) => r.key), "删一条待批准 = 拒绝这个提议 ⇒ 留记录").toEqual(["待批准的事实"]);
  });

  it("REJ-6：拒绝记录有界（超上限丢最旧的）且落库后仍在", async () => {
    const svc = new MemoryService();
    /* 造 70 条（上限 60）：最旧的 10 条应当被丢掉 */
    for (let i = 0; i < 70; i++) {
      const r = svc.add({
        scope: "project",
        projectId: PROJ_A,
        key: `提议 ${i}`,
        content: `第 ${i} 条互不相同的提议内容（足够长）`,
        source: "auto",
        status: "pending",
      });
      svc.reject(r.entry!.id);
    }
    const records = svc.listRejections();
    expect(records.length, "有界（REJECTION_KEEP_MAX=60）").toBeLessThanOrEqual(60);
    expect(records.some((r) => r.key === "提议 69"), "最新的必须还在").toBe(true);
    expect(records.some((r) => r.key === "提议 0"), "最旧的应当被丢掉").toBe(false);

    await svc.flushPendingPersist();
    const reloaded = new MemoryService();
    expect(reloaded.listRejections().length, "落库之后重载仍在（否则重启就忘了）").toBe(records.length);
    expect(reloaded.listRejections().some((r) => r.key === "提议 69"), "重载后最新的那条也在").toBe(true);
  });

  it("REJ-6b：拒绝记录落库/重载后**仍然挡得住同类**（真机那 0.54 的一对）", async () => {
    const svc = new MemoryService();
    const added = svc.add({ scope: "project", projectId: PROJ_A, key: FACT_A.key, content: FACT_A.content, source: "auto", status: "pending" });
    svc.reject(added.entry!.id);
    await svc.flushPendingPersist();

    const reloaded = new MemoryService();
    expect(reloaded.listRejections(), "前提：重载后记录在").toHaveLength(1);
    expect(
      reloaded.findRejectedSimilarTo(FACT_A_REWORDED),
      "重启之后那句「别再问我」必须仍然生效（否则用户会以为它忘了）",
    ).toBeTruthy();
  });

  it("REJ-7（退路）：清空已拒绝记录之后，同类又能被自动写入", async () => {
    const svc = new MemoryService();
    const added = svc.add({ scope: "project", projectId: PROJ_A, key: FACT_A.key, content: FACT_A.content, source: "auto", status: "pending" });
    svc.reject(added.entry!.id);
    expect(svc.findRejectedSimilarTo(FACT_A_REWORDED), "前提：现在是被挡住的").toBeTruthy();

    const cleared = svc.clearRejections();
    expect(cleared.cleared).toBe(1);
    expect(svc.listRejections()).toHaveLength(0);

    const engine = engineForExtraction(svc, SESSION, [JSON.stringify([{ ...FACT_A_REWORDED, scope: "project" }])]);
    await engine.extractMemoriesFromSession(SESSION, PROJ_A);
    expect(svc.listPending(undefined, { projectId: PROJ_A }), "清空后又能走了（误点拒绝不该永久锁死）").toHaveLength(1);
  });

  it("REJ-8：批量拒绝同样逐条留痕", () => {
    const svc = new MemoryService();
    const a = svc.add({ scope: "project", projectId: PROJ_A, key: "批量一", content: "批量拒绝的第一条内容", source: "auto", status: "pending" });
    const b = svc.add({ scope: "project", projectId: PROJ_A, key: "批量二", content: "批量拒绝的第二条内容", source: "auto", status: "pending" });
    const r = svc.rejectMany([a.entry!.id, b.entry!.id]);
    expect(r.changed).toBe(2);
    expect(svc.listRejections().map((x) => x.key).sort(), "批量拒绝也要留痕（用户是逐条点的「拒绝」）").toEqual([
      "批量一",
      "批量二",
    ]);
  });
});
