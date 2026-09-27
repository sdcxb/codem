/**
 * SESSINT —— **把会话标成"内部"这个动作**（第 190 轮）。
 *
 * 用户问的是「原有聊天产生的子智能体对话还是在目录里没被收纳，有什么策略吗？」。
 * 实测（`.preview-shot/_audit-190-legacy-internal.mjs`）给出的结论是：
 * **自动判据不可用**，得由"知道真相的那一方"显式声明。于是新增工具 `set_session_internal`。
 *
 * 本文件钉住它的四条行为：
 * - SESSINT-1：标成内部 ⇒ 该会话**立刻**从 `listSessions` 消失；
 * - SESSINT-2：**可逆** —— 传 `false` 就回到列表（所以"标错"不丢数据）；
 * - SESSINT-3：会话不存在时**如实报错且不抛**（工具不该把回合打断）；
 * - SESSINT-4：**子智能体轨迹在建行时就置 1**（不需要靠这个工具事后补）。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setStoragePort } from "../core/storage/port";
import { createFakeStoragePort } from "./fake-storage-port";
import { createSession, listSessions, getSession } from "../core/storage/session";
import { createSetSessionInternalTool } from "../core/session/tools";

const ROOT = join(__dirname, "..", "..");

const mk = (id: string, projectId = "proj", extra: Record<string, unknown> = {}) =>
  createSession({ id, projectId, title: id, createdAt: Date.now(), lastMessageAt: Date.now(), messageCount: 0, ...extra });

/** 工具 execute 的签名带 ctx，本文件不关心它 */
const run = (args: Record<string, unknown>) => createSetSessionInternalTool().execute(args, {} as never);

describe("SESSINT：会话的内部标记（第 190 轮）", () => {
  beforeEach(() => {
    setStoragePort(createFakeStoragePort());
  });

  it("SESSINT-1：标成内部 ⇒ 立刻从对话目录消失（但行还在，按 ID 仍读得到）", async () => {
    mk("s1", "proj");
    mk("s2", "proj");
    expect(listSessions("proj").map((s) => s.id).sort(), "前提：两个都在列表里").toEqual(["s1", "s2"]);

    const out = await run({ session_id: "s2", internal: true, reason: "为用户一次性任务开的" });
    expect(String(out.output), "工具应当回报已标记").toMatch(/内部|internal/);

    expect(listSessions("proj").map((s) => s.id), "s2 应当从目录里消失，s1 不受影响").toEqual(["s1"]);
    expect(getSession("s2"), "行必须还在（消息/事件/成本还要靠它过外键）").toBeTruthy();
    expect(getSession("s2")!.isInternal, "标志要真的落库（建行/改行走的是同一套 wire 映射）").toBe(true);
  });

  it("SESSINT-2：可逆 —— 传 internal:false 就回到目录（标错不丢数据）", async () => {
    mk("s1", "proj");
    await run({ session_id: "s1", internal: true });
    expect(listSessions("proj").map((s) => s.id), "先确认被藏起来了").toEqual([]);

    await run({ session_id: "s1", internal: false });
    expect(listSessions("proj").map((s) => s.id), "撤销后应当回到列表").toEqual(["s1"]);
    expect(getSession("s1")!.isInternal).toBe(false);
  });

  it("SESSINT-3：会话不存在 ⇒ 如实报错、**不抛**（工具不该把回合打断）", async () => {
    mk("s1", "proj");
    let out: { output?: string } | undefined;
    await expect((async () => { out = await run({ session_id: "no-such-session", internal: true }); })()).resolves.toBeUndefined();
    expect(String(out?.output), "要明确说找不到，而不是假装成功").toMatch(/找不到|not found/i);
    expect(listSessions("proj").map((s) => s.id), "别的会话不受影响").toEqual(["s1"]);
  });

  /**
   * SESSINT-3b：工具**必须回读校验**（写没写成不能靠"调用没抛异常"来断定）。
   *
   * ## ⚠️ 这条为什么是**源码判据**而不是行为用例（如实标注）
   *
   * 我第一版写了个行为用例：把假端口设成 `failWrites`，指望模拟"库没落盘"。
   * **没模拟成** —— 实测（临时探针）发现假端口在 `failWrites` 下**仍然更新读侧镜像**
   * （那是刻意的：UI 要能立刻看到自己的操作），于是回读拿到的是新值、`ok=true`，
   * 用例红在"工具报成功"上 —— 而真引擎**拒绝写时不会更新镜像**，行为与假端口相反。
   * 也就是说：**用这个假端口造不出"写被拒"的场景**，硬写只会得到一条与真机相反的用例。
   *
   * 而这个校验**已经被真事实验证过一次**：`SESSINT-1` 在 `isInternal` 从 `updateSession`
   * 白名单里漏掉时（第 190 轮真踩到的 bug）当场红 —— 那正是"读回来看，发现没写成"的路径。
   *
   * 所以这里用窄的源码判据守住"校验存在且比较的是真值"，并如实写明它守不了什么：
   * 它不证明"校验逻辑正确"，只证明"这段代码还在"。
   */
  it("SESSINT-3b：工具必须回读校验（写没写成不能靠「没抛异常」断定）", () => {
    const src = readFileSync(join(ROOT, "src/core/session/tools.ts"), "utf8");
    expect(src, "工具里必须回读一次并把结果与实际值比较").toMatch(
      /const after = SessionStorage\.getSession\(sessionId\);[\s\S]{0,120}const ok = !!after && after\.isInternal === internal;/,
    );
    expect(src, "未生效时必须**如实报告**（不能无条件报成功）").toMatch(/标记\*\*未生效\*\*|did NOT take effect/);
  });

  it("SESSINT-4：子智能体轨迹在建行时就置 1（不是靠事后补）", async () => {
    mk("parent-1", "proj");
    const { ensureSubagentSession } = await import("../core/subagent/subagent-session");
    const childId = `sub-${Date.now()}-intflag01`;
    expect(ensureSubagentSession(childId, "parent-1"), "子会话行应当建成功").toBe(true);

    const child = getSession(childId);
    expect(child, "子会话行必须存在（外键依赖）").toBeTruthy();
    expect(child!.isInternal, "建行时就该带上内部标记 —— 否则它会出现一瞬再被过滤，且依赖运行期补写").toBe(true);
    expect(listSessions("proj").map((s) => s.id), "因此它从一开始就不在目录里").toEqual(["parent-1"]);
  });
});

/**
 * SESSINT-B —— **老数据回填**（第 191 轮）。
 *
 * ⚠️ 这一组的存在本身要记一笔：第 190 轮我在**自己这台机器**上查库，看到 `sub-%` 是 0 行，
 * 就写下「老数据里根本没有子智能体会话条目，这个前提不成立」。
 * **用户当场纠正：「我是再另一个电脑里安装后测试的，你不要这么机械！」**
 * 他那台机器上旧版本**确实**把子智能体会话写进了 `sessions` 表 ⇒ 出现在侧栏，
 * 而 `is_internal` 是 189 轮才加的列、老行是 0 ⇒ 过滤对它们无效。
 * 所以必须有回填，而且回填的判据必须是"旧代码自己写下的形态"。
 */
describe("SESSINT-B：老数据的内部会话回填（第 191 轮）", () => {
  beforeEach(() => {
    setStoragePort(createFakeStoragePort());
  });

  it("SESSINT-B1：老形态的子智能体会话被回填成内部 ⇒ 从目录消失", async () => {
    const { backfillInternalSessions } = await import("../core/storage/session");
    /* 造"老数据"：isInternal 故意不设（=0），只有旧代码写下的 id/标题形态 */
    mk("parent-1", "proj");
    mk(`sub-1790000000001-aaa111bbb`, "proj", { title: "子智能体 sub-1790000000001-aaa111bbb" });
    /* ⚠️ 第二种形态：id 不是 sub- 形态，但标题是 `子智能体 <id>`（childTitle 写死的前缀） */
    mk("1790000000002-ccc222ddd", "proj", { title: "子智能体 1790000000002-ccc222ddd" });
    /* 一个真对话做对照 */
    mk("real-1", "proj", { title: "对话 1" });

    expect(listSessions("proj").map((s) => s.id).sort(), "回填前：子会话形态就已经被过滤（判据2 兜底）")
      .toEqual(["parent-1", "real-1"]);

    const marked = backfillInternalSessions(
      ["parent-1", "sub-1790000000001-aaa111bbb", "1790000000002-ccc222ddd", "real-1"]
        .map((id) => getSession(id)!),
    );
    expect(marked, "应当回填 2 条子智能体会话").toBe(2);
    expect(getSession("sub-1790000000001-aaa111bbb")!.isInternal, "列要真的写上").toBe(true);
    expect(getSession("1790000000002-ccc222ddd")!.isInternal, "标题形态的那条也要写上").toBe(true);
    expect(getSession("real-1")!.isInternal, "**真对话绝不能被标记**").toBe(false);
    expect(getSession("parent-1")!.isInternal, "父会话也不能被标记").toBe(false);
  });

  it("SESSINT-B2：回填**幂等**（第二次跑不重复标记）", async () => {
    const { backfillInternalSessions } = await import("../core/storage/session");
    mk("sub-1790000000003-ddd333eee", "proj", { title: "子智能体 sub-1790000000003-ddd333eee" });
    const rows = () => [getSession("sub-1790000000003-ddd333eee")!];
    expect(backfillInternalSessions(rows()), "第一次应当标记 1 条").toBe(1);
    expect(backfillInternalSessions(rows()), "第二次应当标记 0 条（已经标过）").toBe(0);
  });

  it("SESSINT-B3：只认两种旧形态，**不做**「首条消息像任务书」之类的推测", async () => {
    const { backfillInternalSessions } = await import("../core/storage/session");
    /* 一条"看起来像子智能体"的普通会话：标题是"对话 2"、id 是普通形态。
       哪怕它其实是被委派用的，回填也**不许**动它 —— 第 190 轮实测过：
       真机 5 条委派关系里有一条目标会话首条用户消息是「我们正在对标 codex 开发本项目…」，
       那是人打的。误判代价（用户找不到自己的会话）远大于漏判。 */
    mk("1790000000004-eee444fff", "proj", { title: "对话 2" });
    const marked = backfillInternalSessions([getSession("1790000000004-eee444fff")!]);
    expect(marked, "不匹配旧形态的会话一条都不许动").toBe(0);
    expect(getSession("1790000000004-eee444fff")!.isInternal).toBe(false);
    expect(listSessions("proj").map((s) => s.id), "它应当照旧留在目录里").toEqual(["1790000000004-eee444fff"]);
  });

  it("SESSINT-B4：单条标记失败不打断整批（能改多少改多少）", async () => {
    const { backfillInternalSessions } = await import("../core/storage/session");
    mk("sub-1790000000005-fff555ggg", "proj", { title: "子智能体 sub-1790000000005-fff555ggg" });
    mk("sub-1790000000006-hhh666iii", "proj", { title: "子智能体 sub-1790000000006-hhh666iii" });
    const seen: string[] = [];
    const marked = backfillInternalSessions(
      ["sub-1790000000005-fff555ggg", "sub-1790000000006-hhh666iii"].map((id) => getSession(id)!),
      (id) => {
        seen.push(id);
        if (id.endsWith("fff555ggg")) throw new Error("模拟单条写失败");
      },
    );
    expect(seen.length, "两条都要尝试").toBe(2);
    expect(marked, "成功的那条算 1 条（失败的不算、也不抛）").toBe(1);
  });
});
