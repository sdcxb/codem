/**
 * 压缩保留集的预算规划 + 压缩后上下文**真的变小**（第 83 波）
 *
 * 两件必须守住的事：
 *  ① `planCompactionKeep`：固定的"保留最近 20 条"在保留集本身很大时永远压不进窗口
 *     （用户现场：861 条会话，压缩后请求仍 ~105 万 token，迭代 1→2→3→4 反复压缩白烧）。
 *     规划器必须成半收缩、守住下限、并在"连下限都装不下"时明确判定 overBudget。
 *  ② 压缩的删除必须在**读路径**上生效：索引软删除 + 权威日志墓碑 + 内存镜像剔除，
 *     三者缺一就会被日志合并复活（压缩等于没做）。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";

const files = new Map<string, string>();
function installFsStub(): void {
  files.clear();
  (window as any).__TAURI__ = {
    core: {
      invoke: async (cmd: string, args: any) => {
        if (cmd === "get_app_data_dir") return "C:\\appdata\\";
        if (cmd === "write_file") { files.set(args.path, args.content); return undefined; }
        if (cmd === "append_file") { files.set(args.path, (files.get(args.path) ?? "") + args.content + "\n"); return undefined; }
        if (cmd === "read_file") { if (!files.has(args.path)) throw new Error("no such file"); return files.get(args.path); }
        if (cmd === "list_directory") return [];
        if (cmd === "delete_file") { files.delete(args.path); return undefined; }
        if (cmd === "rename_file") { const c = files.get(args.oldPath); files.delete(args.oldPath); if (c !== undefined) files.set(args.newPath, c); return undefined; }
        return undefined;
      },
    },
  };
  (globalThis as any).__TAURI__ = (window as any).__TAURI__;
}

import { planCompactionKeep, alignKeepToRoundBoundary } from "../core/llm/compaction-budget";
import { estimateTokens } from "../core/llm/token-tracker";
import { getDatabase, initDatabase, resetDatabaseFatalState, resetSaveFailureState } from "../core/storage/database";
import {
  createMessage, listMessages, deleteMessagesByIds, deleteMessage, hydrateSessionLog, clearSessionLogCache, listVisibleMessages,
} from "../core/storage/message";
import { flushSessionLogWrites, readSessionMessages, appendSessionMessage, __resetJsonlCache } from "../core/storage/session-jsonl";
import { getStoragePort, hasStoragePort } from "../core/storage/port";
import type { FakeStoragePort } from "./fake-storage-port";
import type { Message } from "../store";

/** B 态（端口在 rust）时产品使用的内存假端口；A 态（`CODEM_TEST_PORT=0`）为 null */
function activePort(): FakeStoragePort | null {
  if (!hasStoragePort()) return null;
  const port = getStoragePort();
  return port.kind === "rust" ? (port as unknown as FakeStoragePort) : null;
}

/**
 * ⚠️ **每个用例用独立的会话 id**（第 84 轮）。
 *
 * `message.ts` 里有一份**模块级**的"本进程已软删除 id"集合（`localHiddenIds`，按会话分组），
 * 它是读路径的权威补充、且刻意不随端口更换而清空。而本文件原来的所有用例共用同一个
 * `SESSION` 与同一批 id（`m0..m39`）：CB-7 软删除 `m0..m34` 之后，那份集合在**后续用例里
 * 仍然生效** —— 于是 CB-8 里 `listMessages` 只剩 5 条（于是"删前 35 条"删错了对象）、
 * CB-9/CB-11 里刚建的消息被上一条用例的隐藏集合整批过滤掉（读到空列表）。
 *
 * 这不是产品缺陷（生产里会话 id 是唯一的，不存在"同一会话被两条用例反复重建"），
 * 而是**用例之间通过模块级状态串味**：新端口 ≠ 新进程。用独立会话 id 隔开即可。
 */
const SESSION_BASE = "sess-compaction-budget";
let SESSION = SESSION_BASE;
let caseSeq = 0;

const mk = (id: string, ts: number, content?: string): Message =>
  ({ id, role: "user", content: content ?? `内容 ${id}`, timestamp: ts } as Message);

describe("压缩保留集预算规划", () => {
  it("CB-1: 保留集在预算内 → 不动（小会话压缩行为不变）", () => {
    const plan = planCompactionKeep({
      totalMessages: 100,
      desiredKeep: 20,
      budget: 100000,
      minKeep: 4,
      estimate: () => 5000,
      align: (n) => n,
    });
    expect(plan.keepCount).toBe(20);
    expect(plan.shrunk).toBe(false);
    expect(plan.overBudget).toBe(false);
  });

  it("CB-2: 保留集超预算 → 成半收缩直到进预算（用户现场：20 条自己就顶满窗口）", () => {
    // 每条 10 万 token：20 条 = 200 万，预算 100 万 → 应收敛到 8 条（80 万）
    const perMessage = 100_000;
    const plan = planCompactionKeep({
      totalMessages: 861,
      desiredKeep: 20,
      budget: 1_000_000 / 2,
      minKeep: 4,
      estimate: (n) => n * perMessage,
      align: (n) => n,
    });
    expect(plan.shrunk).toBe(true);
    expect(plan.estimated).toBeLessThanOrEqual(500_000);
    expect(plan.keepCount).toBeGreaterThanOrEqual(4);
    expect(plan.overBudget).toBe(false);
  });

  it("CB-3: 连下限都装不下 → overBudget 明确置位（压缩救不了，必须如实上报）", () => {
    const plan = planCompactionKeep({
      totalMessages: 861,
      desiredKeep: 20,
      budget: 1000,
      minKeep: 4,
      estimate: (n) => n * 100_000,
      align: (n) => n,
    });
    expect(plan.keepCount).toBe(4);
    expect(plan.overBudget).toBe(true);
  });

  it("CB-4: 对齐可能把条数顶回去 —— 不许因此死循环", () => {
    let calls = 0;
    const plan = planCompactionKeep({
      totalMessages: 100,
      desiredKeep: 20,
      budget: 1,
      minKeep: 4,
      estimate: () => 10_000,
      align: (n) => { calls++; return n + 1; }, // 恶意对齐：永远不减
    });
    expect(calls).toBeLessThan(12);
    expect(plan.keepCount).toBeGreaterThanOrEqual(1);
    expect(plan.overBudget).toBe(true);
  });

  it("CB-5: 轮次边界对齐 —— 不能从工具结果中间开始保留", () => {
    const messages = [
      { role: "user" }, { role: "assistant" }, { role: "tool" }, { role: "tool" },
      { role: "user" }, { role: "assistant" }, { role: "tool" },
    ];
    // 最近 3 条 = [user(4), assistant(5), tool(6)]，边界正好落在 user 上 → 保留 3 条
    expect(alignKeepToRoundBoundary(messages, 3)).toBe(3);
    // 保留 1 条时，位置 6 是 tool（最后一条）→ 回退到 5（assistant）→ 保留 2 条
    expect(alignKeepToRoundBoundary(messages, 1)).toBe(2);
    // 全保留
    expect(alignKeepToRoundBoundary(messages, 99)).toBe(7);
    // 空数组安全
    expect(alignKeepToRoundBoundary([], 5)).toBe(0);
  });

  it("CB-6: estimateTokens 对中文/代码是真实量级（预算计算的地基）", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("你好")).toBeGreaterThan(0);
    const long = "上下文压缩测试".repeat(1000);
    expect(estimateTokens(long)).toBeGreaterThan(1000); // 中文 ≈ 1 token/字量级
  });
});

describe("压缩后的读路径（真机上压缩必须真的变小）", () => {
  beforeEach(async () => {
    installFsStub();
    __resetJsonlCache();
    clearSessionLogCache();
    resetSaveFailureState();
    resetDatabaseFatalState();
    // 每条用例一个会话 id：见 SESSION_BASE 处的说明（模块级隐藏集合会跨用例串味）
    SESSION = `${SESSION_BASE}-${++caseSeq}`;
    await initDatabase();
    getDatabase().run("DELETE FROM messages");
    getDatabase().run(
      "INSERT OR REPLACE INTO sessions (id, project_id, title, created_at, last_message_at, message_count) VALUES (?,'','t',0,0,0)",
      [SESSION],
    );
  });

  afterEach(() => {
    delete (window as any).__TAURI__;
    __resetJsonlCache();
    clearSessionLogCache();
  });

  it("CB-7: 压缩删除后，listMessages / listVisibleMessages 都必须只剩保留集（复活的 bug 不许回来）", async () => {
    for (let i = 0; i < 40; i++) createMessage(mk(`m${i}`, 1000 + i), SESSION);
    await flushSessionLogWrites();
    await hydrateSessionLog(SESSION);
    expect(listMessages(SESSION)).toHaveLength(40);

    const before = listMessages(SESSION);
    const removed = before.slice(0, 35).map((m) => m.id);
    deleteMessagesByIds(removed);

    expect(listMessages(SESSION).map((m) => m.id)).toEqual(["m35", "m36", "m37", "m38", "m39"]);
    expect(listVisibleMessages(SESSION).map((m) => m.id)).toEqual(["m35", "m36", "m37", "m38", "m39"]);
  });

  it("CB-8: 重启进程（清空内存镜像、重新 hydrate）后也不复活 —— 墓碑真的落到了日志里", async () => {
    for (let i = 0; i < 40; i++) createMessage(mk(`m${i}`, 1000 + i), SESSION);
    await flushSessionLogWrites();
    await hydrateSessionLog(SESSION);
    deleteMessagesByIds(listMessages(SESSION).slice(0, 35).map((m) => m.id));
    await flushSessionLogWrites();

    // 模拟重启：清镜像、清日志读缓存，再从磁盘日志读一次
    clearSessionLogCache();
    __resetJsonlCache();
    const { messages } = await readSessionMessages(SESSION);
    expect(messages.map((m) => m.id)).toEqual(["m35", "m36", "m37", "m38", "m39"]);
    await hydrateSessionLog(SESSION);
    expect(listMessages(SESSION)).toHaveLength(5);
  });

  it("CB-9: 硬删除后同 id 再写入 = 重新出现（后写者胜）；但**压缩软删除的 id 保持隐藏**", async () => {
    createMessage(mk("m1", 1000), SESSION);
    createMessage(mk("m2", 2000), SESSION);
    createMessage(mk("m3", 3000), SESSION);
    await flushSessionLogWrites();
    await hydrateSessionLog(SESSION);

    // ① 硬删除（用户删消息）：索引行没了 + 墓碑 → 同 id 再写入应当重新出现
    deleteMessage("m1");
    await flushSessionLogWrites();
    clearSessionLogCache();
    __resetJsonlCache();
    await hydrateSessionLog(SESSION);
    expect(listMessages(SESSION).map((m) => m.id)).toEqual(["m2", "m3"]);
    createMessage(mk("m1", 4000, "重新写入的内容"), SESSION);
    await flushSessionLogWrites();
    clearSessionLogCache();
    __resetJsonlCache();
    await hydrateSessionLog(SESSION);
    expect(listMessages(SESSION).find((m) => m.id === "m1")?.content).toBe("重新写入的内容");

    // ② 压缩软删除（hidden=1）：即使日志/陈旧自动保存再写一遍，也**不许复活**回上下文
    await flushSessionLogWrites();
    await hydrateSessionLog(SESSION);
    deleteMessagesByIds(["m2"]);
    await appendSessionMessage(SESSION, mk("m2", 5000, "陈旧自动保存又写了一遍"));
    await flushSessionLogWrites();
    clearSessionLogCache();
    __resetJsonlCache();
    await hydrateSessionLog(SESSION);
    expect(listMessages(SESSION).map((m) => m.id), "压缩掉的会话历史不能被陈旧写入拉回上下文").not.toContain("m2");
  });

  it("CB-10: 传空数组 / 未知 id 不炸（压缩在没有可删消息时也会走到这里）", async () => {
    createMessage(mk("keep", 1000), SESSION);
    await flushSessionLogWrites();
    await hydrateSessionLog(SESSION);
    expect(deleteMessagesByIds([])).toBe(0);
    expect(deleteMessagesByIds(["不存在"] )).toBe(1); // 计数如实，但不影响读路径
    expect(listMessages(SESSION).map((m) => m.id)).toEqual(["keep"]);
  });

  it("CB-11: 老版本留下的现场（索引 hidden=1、日志里没有墓碑）也必须不复活", async () => {
    // 复刻用户现场：老代码只改了索引（hidden=1），日志里干干净净
    for (let i = 0; i < 10; i++) createMessage(mk(`m${i}`, 1000 + i), SESSION);
    await flushSessionLogWrites();
    const softIds = Array.from({ length: 7 }, (_, i) => `m${i}`);
    const port = activePort();
    if (port) {
      /**
       * B 态：索引就是**端口**，所以"老版本只改索引"要用端口命令复刻 ——
       * `messages.delete {soft:true}` 只把 `hidden` 置 1，**不写墓碑**。
       *
       * 刻意不调用产品的 `deleteMessagesByIds`：它会顺带记进程内的隐藏集合，
       * 那就不是"日志里干干净净、只有索引知道"的现场了（本用例考的正是这一条）。
       */
      await port.data.execute("messages.delete", { ids: softIds, soft: true });
    } else {
      const db = getDatabase();
      for (const id of softIds) db.run("UPDATE messages SET hidden = 1 WHERE id = ?", [id]);
    }
    clearSessionLogCache();
    __resetJsonlCache();
    await hydrateSessionLog(SESSION); // 日志里 10 条都在，且没有墓碑

    const visible = listMessages(SESSION).map((m) => m.id);
    expect(visible, "索引里已软删除的消息不能被日志复活").toEqual(["m7", "m8", "m9"]);
  });

  it("CB-12: 用户现场的整段链条 —— 大保留集 → 规划收缩 → 删除生效 → 上下文真的掉到预算内", async () => {
    // 复刻用户的失败形态：**保留集本身**就超预算（每条 ~5 万 token，最近 20 条 ≈ 100 万）
    const big = "生产管控指标模型与数据源适配说明。".repeat(3000); // ≈5 万字 ≈5 万 token
    for (let i = 0; i < 30; i++) createMessage(mk(`b${i}`, 1000 + i, big), SESSION);
    await flushSessionLogWrites();
    await hydrateSessionLog(SESSION);

    const before = listMessages(SESSION);
    const beforeTokens = before.reduce((n, m) => n + estimateTokens(String(m.content)), 0);
    expect(before).toHaveLength(30);

    // 窗口 1M，预算取一半（与 doCompactMessages 口径一致）
    const windowTokens = 1_000_000;
    const budget = Math.floor(windowTokens * 0.5);
    const plan = planCompactionKeep({
      totalMessages: before.length,
      desiredKeep: 20,
      budget,
      minKeep: 4,
      estimate: (n) => before.slice(-n).reduce((sum, m) => sum + estimateTokens(String(m.content)), 0),
      align: (n) => alignKeepToRoundBoundary(before, n),
    });

    console.log(
      `[CB-12] 压缩前 ${before.length} 条 ≈ ${beforeTokens} tokens；规划保留 ${plan.initialKeep} → ${plan.keepCount} 条（估算 ${plan.estimated}，预算 ${budget}）`,
    );
    expect(beforeTokens).toBeGreaterThan(budget);
    expect(plan.shrunk).toBe(true);
    expect(plan.estimated).toBeLessThanOrEqual(budget);

    // 执行删除（压缩的真实删除路径），确认读路径只剩保留集、且总量确实掉到预算内
    const removed = before.slice(0, before.length - plan.keepCount).map((m) => m.id);
    deleteMessagesByIds(removed);
    const after = listMessages(SESSION);
    const afterTokens = after.reduce((n, m) => n + estimateTokens(String(m.content)), 0);
    console.log(`[CB-12] 压缩后 ${after.length} 条 ≈ ${afterTokens} tokens`);

    expect(after).toHaveLength(plan.keepCount);
    expect(afterTokens).toBeLessThanOrEqual(budget);
    expect(afterTokens).toBeLessThan(beforeTokens);
  });
});
