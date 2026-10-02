/**
 * D5b：计划上下文（planContext）**不许进 system 前缀** —— 同一轮跨迭代的前缀稳定性。
 *
 * ## 缺陷形态（修复前）
 *
 * `executeIteration` 把「当前执行计划 + 进行到第几步」拼进了 system 消息：
 *
 *     const planContext = renderPlanSection(this.activePlan.plan, this.macroStep);
 *     const baseSystemPrompt = planContext ? `${systemPrompt}\n\n${planContext}` : systemPrompt;
 *
 * `dsh-d5-prefix-cache-stability.test.ts` 守的是**跨轮**（时间戳不再进前缀），
 * 但 `planContext` 的输入在**同一轮**里就会变：
 *   · `macroStep` 由 `run()` 在消费本迭代事件时推进（tool_start 分支的 `this.macroStep++`）；
 *   · `activePlan.plan` 会被 `update_plan` 改写。
 * 于是同一轮第 2 次请求的 `messages[0]` 与第 1 次不同 ⇒ provider 的前缀缓存
 * （DeepSeek KV cache，命中价约为未命中的 1/4）整段失效。
 *
 * ## 这一组用例为什么断言"实际请求"
 *
 * 只看源码会假绿：把 `planContext` 从 system 拼回前缀里、或干脆不注入，
 * 源码正则都照样匹配。所以这里**拦截 provider 收到的请求本体**：
 *
 * | # | 判据 |
 * | --- | --- |
 * | D5B-A | 同一轮跨迭代：每次请求的 `messages[0]`（system）**逐字节相同** |
 * | D5B-B | 计划段**确实到达了模型**，且不在 `messages[0]` 里（防"干脆不注入"） |
 * | D5B-C | 计划段的内容在迭代之间**真的变了**（1/4 步 → 2/4 步）——这是"留在前缀必炸缓存"的前提 |
 * | D5B-D | 稳定前缀（前若干条历史）在两次请求之间逐字节一致 |
 */
import { describe, it, expect, beforeEach } from "vitest";

import * as ProjectStorage from "../core/storage/project";
import * as SessionStorage from "../core/storage/session";
import { createDefaultToolRegistry } from "../core/llm/tools";
import { AgenticLoop } from "../core/llm/agentic-loop";

const SESSION_ID = "dsh-d5b-plan-prefix";
const PROJECT_ID = "dsh-d5b-plan-prefix-project";
const CWD = "C:\\d5b-plan";
const SYSTEM_PROMPT = "你是测试用助手。这是系统提示，必须逐字节稳定。";

/** 计划段的固定开头（`plan-utils.ts::renderPlanSection`） */
const PLAN_MARKER = "当前执行计划";

const PLAN_JSON = JSON.stringify([
  { title: "分析卡死原因" },
  { title: "诊断调用链路" },
  { title: "修复卡死" },
  { title: "测试验证卡死不再出现" },
]);

function toolEvents(callId: string, name: string, input: Record<string, unknown>): any[] {
  return [
    { type: "tool_use_start", id: callId, name },
    { type: "tool_use_delta", id: callId, input: JSON.stringify(input) },
    { type: "tool_use_end", id: callId, input },
    { type: "end", finishReason: "tool_use" },
  ];
}

function textEvents(text: string): any[] {
  return [
    { type: "text_delta", text },
    { type: "end", finishReason: "stop" },
  ];
}

/** 记录每次 `stream()` 收到的**请求本体**，同时按脚本逐迭代产出事件。 */
class RecordingScriptedProvider {
  id = "d5b-provider";
  name = "D5b Mock";
  config: any = {};
  requests: any[] = [];
  private streamQueue: any[][] = [];
  private completeQueue: any[] = [];

  setScript(scripts: any[][]) {
    this.streamQueue = scripts;
  }
  setCompleteReplies(replies: any[]) {
    this.completeQueue = replies;
  }
  isConfigured() {
    return true;
  }
  async *stream(request: any): AsyncGenerator<any> {
    this.requests.push(request);
    const script = this.streamQueue.length > 0
      ? this.streamQueue.shift()!
      : textEvents("（脚本耗尽）");
    for (const event of script) yield event;
  }
  async complete() {
    const reply = this.completeQueue.length > 0 ? this.completeQueue.shift()! : { content: "{}" };
    return { content: reply.content, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
  }
  async listModels() {
    return [];
  }
  async fetchModelsFromServer() {
    return [];
  }
}

/** 计划段所在的那条尾部消息（找不到则返回 null） */
function planMessage(request: any): any | null {
  return request.messages.find((m: any) => String(m.content).includes(PLAN_MARKER)) ?? null;
}

/** 注入的临时尾部消息（不落库，因此不属于"稳定前缀"） */
function isInjectedTrailingMessage(m: any): boolean {
  const id = String(m?.id ?? "");
  return id.startsWith("plan-context-") || id.startsWith("turn-context-");
}

/** "稳定前缀"的长度 = 第一条注入的临时消息之前的历史条数 */
function stablePrefixLength(request: any): number {
  const idx = request.messages.findIndex(isInjectedTrailingMessage);
  return idx === -1 ? request.messages.length : idx;
}

describe("D5b：计划上下文不得进入 system 前缀（同一轮跨迭代）", () => {
  let provider: RecordingScriptedProvider;
  let loop: AgenticLoop;

  beforeEach(() => {
    ProjectStorage.createProject({
      id: PROJECT_ID,
      name: "前缀稳定性测试项目",
      path: CWD,
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
    });
    SessionStorage.createSession({
      id: SESSION_ID,
      projectId: PROJECT_ID,
      title: "前缀稳定性测试会话",
      createdAt: Date.now(),
      lastMessageAt: Date.now(),
      messageCount: 0,
    });

    provider = new RecordingScriptedProvider();
    // 规划调用返回 4 步语义计划（与 step-plan 集成测试同一份夹具）
    provider.setCompleteReplies([{ content: PLAN_JSON }]);
    // 三次迭代：it1 bash（1→2）、it2 bash（2→3）、it3 文本收尾
    provider.setScript([
      toolEvents("tc-1", "bash", { command: "echo probe-1" }),
      toolEvents("tc-2", "bash", { command: "echo probe-2" }),
      textEvents("完成"),
    ]);

    loop = new AgenticLoop(provider as any, createDefaultToolRegistry(), {
      maxIterations: 10,
      model: "d5b-model",
      securityMode: "full",
    });
  });

  it("D5B：同一轮 3 次迭代 → system 消息逐字节稳定，计划段只在尾部且每轮更新", async () => {
    for await (const _e of loop.run(SESSION_ID, "修复页面卡死的问题", CWD, SYSTEM_PROMPT)) {
      /* drain */
    }

    // 前置条件：真的发生了**同一轮的多次迭代**（否则本用例证明不了跨迭代稳定性）
    expect(
      provider.requests.length,
      "夹具失效：只发生了 1 次请求 —— 那只能证明跨轮稳定，证明不了跨迭代",
    ).toBeGreaterThanOrEqual(3);

    const first = provider.requests[0];

    for (let i = 0; i < provider.requests.length; i++) {
      const req = provider.requests[i];

      // ---- D5B-A：system 消息必须逐字节相同，且不含计划段 ----
      expect(req.messages[0].role, `第 ${i + 1} 次请求的 messages[0] 必须是 system`).toBe("system");
      expect(
        req.messages[0].content,
        `第 ${i + 1} 次请求的 system 消息与第 1 次不同 —— 同一轮迭代之间前缀变了，KV cache 必失效`,
      ).toBe(first.messages[0].content);
      expect(
        String(req.messages[0].content),
        `第 ${i + 1} 次请求把计划段拼进了 system 前缀（每轮都会变 ⇒ 前缀缓存失效）`,
      ).not.toContain(PLAN_MARKER);

      // ---- D5B-B：计划段确实到达了模型，且**不在**前缀里 ----
      const plan = planMessage(req);
      expect(
        plan,
        `第 ${i + 1} 次请求里找不到计划段 —— 那是"干脆不注入"的假修（模型看不到计划就无法 update_plan）`,
      ).toBeTruthy();
      expect(plan!.id, "计划段不能是 system 消息（system 由 messages[0] 承载）").not.toBe(
        req.messages[0].id,
      );
      expect(
        req.messages.indexOf(plan),
        "计划段必须在消息序列的尾部（前缀之后）",
      ).toBeGreaterThan(0);
    }

    // ---- D5B-C：计划段内容在迭代之间**真的变了**（这是"留在前缀必炸缓存"的前提）----
    const plan0 = String(planMessage(provider.requests[0])!.content);
    const plan1 = String(planMessage(provider.requests[1])!.content);
    expect(plan0, "第 1 次迭代应显示进行到第 1 步").toContain("进行到第 1/4 步");
    expect(plan1, "第 2 次迭代应显示进行到第 2 步（macroStep 在同一轮内推进了）").toContain(
      "进行到第 2/4 步",
    );
    expect(
      plan1,
      "计划段在迭代之间必须真的变化 —— 若两轮相同，本用例证明不了「留在前缀会击穿缓存」",
    ).not.toBe(plan0);

    // ---- D5B-D：稳定前缀（历史部分）逐字节一致 ----
    const stableLen = stablePrefixLength(first);
    expect(stableLen, "稳定前缀至少要有 system 消息").toBeGreaterThan(0);
    const second = provider.requests[1];
    expect(
      second.messages.slice(0, stableLen),
      "第 2 次请求的稳定前缀必须与第 1 次逐字节相同",
    ).toEqual(first.messages.slice(0, stableLen));
  });
});
