/**
 * 第 46 波：**失败/被拒的调用也必须写工具事件** ✓ —— 用户**第五次**报的"记录与界面不一致"的真因 ✓。
 *
 * ## 报障原文（第五次 ✓）与真机指纹
 *
 * > 【存储自检：本次新发现记录与界面不一致：不变量审计：本次新产生 1 条缺口（历史缺口另有 1032 条）…】
 *
 * advisory 里带的指纹样例（四次报障各一条 ✓）：
 * ```
 * 1791330056615-o8x9pqydx | VISIBLE_BUT_NOT_RECORDED | assistant-1791330136711-13
 * ```
 * 只读打开真库查那几条 ✓：
 * ```
 * status=done  content=0 字  reasoning=383 字      ← 有正文缺失但有思考
 * tool_calls 表里挂在这一行上的：1 条（tool=run_code / bash，status=**error** ✗）
 * 引用它的会话事件：★ 一条都没有 ✗
 * 按 toolCallId 反查：★ 一条事件都没有 ✗（**不是挂错人**，是**根本没写** ✓）
 * 最近 500 条 tool_calls：done 484/484 都有事件 ✓；**error 16 条里 6 条没有** ✗
 * ```
 * ⇒ ★ **真因（读代码定案 ✓）**：`tool-pipeline.ts` 里**三条早退绕过了 finalize 层** ✗ ——
 * `pre-execute deny`（:361）、**guard deny**（:391）、**post-execute reject**（:479）都直接 `return` ✓，
 * 而写事件的是 finalize 层（`EventLogFinalizeMiddleware` ✓）⇒ **被拒绝/被拦下的调用一条事件都不写** ✗
 * ⇒ 那一行助手消息"既没有文本事件、也没有工具事件"⇒ 维护自检判 `VISIBLE_BUT_NOT_RECORDED` ✓
 * ⇒ ★ **每次跑任务都新报一条缺口** ✓（用户看到的就是它 ✓）。
 *
 * ## 判据（**钉"事件真的写了"，不是"我的规则还在"** ✓ —— 第四次报障的教训 ✓）
 *
 * 用**真的** `EventLogFinalizeMiddleware` + 记录式假事件日志 ✓，对三条早退路径各跑一次 ✓：
 * | id | 钉什么 |
 * |---|---|
 * | `PIPE-1` | `pre-execute deny` ⇒ 必须有 `tool_call` + `tool_result`，且 `messageId` 是这一行 ✓ |
 * | `PIPE-2` | `guard deny` ⇒ 同上 ✓ |
 * | `PIPE-3` | `post-execute reject` ⇒ 同上 ✓ |
 * | `PIPE-4`（反向对照）| **成功**的调用仍然**恰好** 1 条 `tool_call` + 1 条 `tool_result` ✓（不许重复 ✗）|
 * | `PIPE-5`（结局）| ★ 把"被拒的那一行"喂进**真的**不变量检查 ⇒ 必须**不是** `VISIBLE_BUT_NOT_RECORDED` ✓ |
 *
 * ### ★★ 第 46 波后补：**`execute` 里一共有 7 个会产出结果的出口**，上面三条只覆盖 3 个 ✗
 *
 * 审计（本波查清 ✓）：真正的出口是 **7 个** ✓ —— 上面三条 + **pre-execute 阶段另三条**
 * （abort / normalize-input / validate-args ✗）+ 成功路径 ✓。那三条**原先全绕过 finalize** ✗（已补 ✓），
 * 而它们**都很常见** ✓（给错参数是常事 ✓、回合中途中止也常见 ✓）⇒
 * ★ 只补三条时，缺口仍会从这三条路继续产 ✗（用户第五次报障不会真的停 ✗）。
 * | id | 钉什么 |
 * |---|---|
 * | `PIPE-6` | ★ **abort-before-dispatch** ⇒ 必须写 `tool_call` + `tool_result` ✓ |
 * | `PIPE-7` | ★ **normalize-input 抛错** ⇒ 同上 ✓ |
 * | `PIPE-8` | ★ **validate-args 失败** ⇒ 同上 ✓ |
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

/** 记录式假事件日志 ✓（只记 `append` 的 sessionId/type/payload ✓） */
const appended: Array<{ sessionId: string; type: string; payload: Record<string, unknown> }> = [];
vi.mock("../core/storage/event-log", () => ({
  getEventLog: () => ({
    append: (sessionId: string, type: string, payload: Record<string, unknown>) => {
      appended.push({ sessionId, type, payload });
      return { seq: appended.length, sessionId, type, payload };
    },
  }),
}));

import { ToolPipeline, EventLogFinalizeMiddleware } from "../core/llm/tool-pipeline";
import type { FinalizeMiddleware, GuardMiddleware, PostExecuteMiddleware, PreExecuteMiddleware } from "../core/llm/tool-pipeline";
import type { ToolCallResult, ToolExecutorContext } from "../core/llm/types";

const SESSION = "sess-pipe-exits";
const MSG = "assistant-1-1";

function mockCtx(): ToolExecutorContext {
  return { sessionId: SESSION, messageId: MSG, toolCallId: "call-x" } as unknown as ToolExecutorContext;
}
function okHandler(): (n: string, a: Record<string, unknown>, c: ToolExecutorContext) => Promise<ToolCallResult> {
  return async (name, args, ctx) => ({ id: ctx.messageId, name, input: args, output: "tool output", status: "completed" });
}
const eventsFor = (type: string) => appended.filter((a) => a.type === type && a.payload.messageId === MSG);

describe("第 46 波：失败/被拒的调用也必须写工具事件（第五次报障的真因）", () => {
  beforeEach(() => {
    appended.length = 0;
  });

  async function runWith(register: (p: ToolPipeline) => void, ctx?: ToolExecutorContext) {
    const pipeline = new ToolPipeline();
    pipeline.registerFinalize(new EventLogFinalizeMiddleware() as unknown as FinalizeMiddleware);
    register(pipeline);
    return pipeline.execute("write", { path: "/x" }, ctx ?? mockCtx(), okHandler());
  }

  it("PIPE-1: pre-execute 拒绝 ⇒ 必须写 tool_call + tool_result（旧实现直接 return，跳过 finalize ✗）", async () => {
    const mw: PreExecuteMiddleware = {
      name: "deny-pre",
      async execute() {
        return { action: "deny", denyMessage: "Not allowed" };
      },
    };
    const { result } = await runWith((p) => p.registerPreExecute(mw));
    expect(result.status, "夹具前提：这一路必须是 error").toBe("error");
    expect(eventsFor("tool_call").length, "★ 被拒的调用也要写 tool_call（否则那一行成了可见但无记录 ✗）").toBe(1);
    expect(eventsFor("tool_result").length, "★ 同上，tool_result 也要").toBe(1);
    expect(String(eventsFor("tool_result")[0].payload.status), "失败态要如实标 error").toBe("error");
  });

  it("PIPE-2: guard 拦下 ⇒ 必须写 tool_call + tool_result", async () => {
    const guard: GuardMiddleware = {
      name: "deny-guard",
      async execute() {
        return { action: "deny", denyMessage: "Blocked by guard" };
      },
    };
    const { result } = await runWith((p) => p.registerGuard(guard));
    expect(result.status).toBe("error");
    expect(eventsFor("tool_call").length, "★ guard 拦下也要写").toBe(1);
    expect(eventsFor("tool_result").length, "★ 同上").toBe(1);
  });

  it("PIPE-3: post-execute reject ⇒ 必须写 tool_call + tool_result（真机样例正是这一路 ✓）", async () => {
    const post: PostExecuteMiddleware = {
      name: "reject-post",
      async execute() {
        return { action: "reject", rejectMessage: "Rejected by post-execute middleware" };
      },
    };
    const { result } = await runWith((p) => p.registerPostExecute(post));
    expect(result.status, "夹具前提：post-execute reject 必须是 error").toBe("error");
    expect(eventsFor("tool_call").length, "★ 被拒也要写（真机上 write 被拒就是这么漏的 ✗）").toBe(1);
    expect(eventsFor("tool_result").length, "★ 同上").toBe(1);
  });

  it("PIPE-4 反向对照: 成功的调用仍然**恰好** 1+1 条（不许因为收口而重复 ✗）", async () => {
    const { result } = await runWith(() => {});
    expect(result.status).toBe("completed");
    expect(eventsFor("tool_call").length, "成功路径不许变成两条").toBe(1);
    expect(eventsFor("tool_result").length, "同上").toBe(1);
  });

  it("PIPE-5（结局口径）: 被拒的那一行，不变量检查**不许**判它 VISIBLE_BUT_NOT_RECORDED", async () => {
    const post: PostExecuteMiddleware = {
      name: "reject-post",
      async execute() {
        return { action: "reject", rejectMessage: "Rejected" };
      },
    };
    await runWith((p) => p.registerPostExecute(post));
    /**
     * 用**真的**检查器 + 注入数据 ✓（第 143 波的注入口 ✓，不必碰镜像 ✓）：
     * 消息侧只给"那一行助手消息"（空正文 ✓ —— 就是真机样例的形状 ✓）。
     */
    const { checkVisibleRecordedInvariant } = await import("../core/llm/runtime-invariants");
    const res = checkVisibleRecordedInvariant(SESSION, undefined, {
      events: appended.map((a) => ({ type: a.type, payload: a.payload })) as never,
      messages: [{ id: MSG, role: "assistant", content: "", status: "done" }] as never,
    });
    console.log("[PIPE-5] 违规：", JSON.stringify(res.violations));
    expect(res.violations.length, "★ 被拒的调用写不出事件 ⇒ 这一行被判缺口 ⇒ 用户第五次报障 ✓").toBe(0);
  });

  it("PIPE-6: ★ abort-before-dispatch ⇒ 必须写 tool_call + tool_result（这一条原先也绕过 finalize ✗）", async () => {
    const abortedCtx = { ...mockCtx(), abort: { aborted: true } } as unknown as ToolExecutorContext;
    const { result } = await runWith(() => {}, abortedCtx);
    expect(result.status, "夹具前提：中止路径必须是 error").toBe("error");
    expect(String(result.error), "夹具前提：必须是那条 ABORTED 分支").toContain("ABORTED_BEFORE_DISPATCH");
    expect(eventsFor("tool_call").length, "★ 中止的调用也要写 tool_call").toBe(1);
    expect(eventsFor("tool_result").length, "★ 同上（否则这一行又是可见但无记录 ✗）").toBe(1);
  });

  it("PIPE-7: ★ normalize-input 抛错 ⇒ 必须写 tool_call + tool_result", async () => {
    const { result } = await runWith((p) => {
      p.setRawContractOf(
        () =>
          ({
            normalizeInput: () => {
              throw new Error("normalize boom");
            },
          }) as never,
      );
    });
    expect(result.status, "夹具前提：归一化失败必须是 error").toBe("error");
    expect(String(result.output), "夹具前提：要带上那句话").toContain("normalize boom");
    expect(eventsFor("tool_call").length, "★ 归一化失败的调用也要写 tool_call").toBe(1);
    expect(eventsFor("tool_result").length, "★ 同上").toBe(1);
  });

  it("PIPE-8: ★ validate-args 失败 ⇒ 必须写 tool_call + tool_result", async () => {
    const { result } = await runWith((p) => {
      /** 造一个"必然不满足"的 schema ✓（缺必填参数 ✓） */
      p.setToolDefOf(
        () =>
          ({
            name: "write",
            parameters: { type: "object", required: ["must_have_this"], properties: {} },
          }) as never,
      );
    });
    expect(result.status, "夹具前提：参数校验失败必须是 error").toBe("error");
    expect(eventsFor("tool_call").length, "★ 参数不合法的调用也要写 tool_call（模型给错参数是常事 ✗）").toBe(1);
    expect(eventsFor("tool_result").length, "★ 同上").toBe(1);
  });
});
