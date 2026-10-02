/**
 * 门禁：**活跃目标必须真的到达模型**（而不是只在源码里"看起来"注入了）。
 *
 * ## 这份测试为什么被重写
 *
 * 旧版本断言的是**源码文本**：`# Active Goals` 附近 400 字符内要有 `content +=`。
 * 这种断言会**假绿** —— 那个注入被 `if (apiMessages[0].role === "system")` 守着，
 * 而真实会话里 `apiMessages[0]` **不是** system 消息（system 由 `executeIteration`
 * 单独构造，`messagesToLLMMessages` 明确丢掉 system 行），所以判据恒假、
 * 注入从来没有生效过：**用户建的活跃目标一次都没给模型看过**，
 * 而源码文本测试一路是绿的。项目规则是"主张必须用行为钉住"，所以这里改成
 * **拦截 provider 实际收到的请求本体**来断言。
 *
 * ## 判据（全部落在"请求里到底有什么"）
 *
 * | # | 造法 | 判据 |
 * | --- | --- | --- |
 * | GOAL-A | 第 1 轮（iteration 1）+ 一个探针工具调用 | 请求里**没有**目标（`iteration > 1` 门控仍在） |
 * | GOAL-B | 第 2 轮请求 | 目标标题 + 成功判据出现在**尾部** user 消息里 |
 * | GOAL-C | 同一请求的 `messages[0]`（system） | **不含**目标文本（前缀缓存：易变内容不许进前缀） |
 * | GOAL-D | blocked 目标 | 同样被列出（旧实现把 blocked 与 in_progress 一起注入） |
 * | GOAL-E | 反向对照：没有活跃目标 | 任何请求里都不出现 `# Active Goals`（不是"永远拼一段固定文本"） |
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

import { AgenticLoop } from "../core/llm/agentic-loop";
import { createDefaultToolRegistry } from "../core/llm/tools";
import { createGoal, listGoals, updateGoal } from "../core/goal/goal";

const CWD = "C:\\goal-injection";
const SESSION = "test-goal-injection-session";
const PROBE = "goal_probe";

/** 脚本化 provider：把每个请求原样记下来（判据就是"模型收到了什么"） */
class RecordingProvider {
  id = "goal-injection-provider";
  name = "Goal Injection Mock";
  requests: any[] = [];
  private queue: any[][] = [];

  setScript(scripts: any[][]) {
    this.queue = scripts;
  }
  isConfigured() {
    return true;
  }
  async *stream(request: any): AsyncGenerator<any> {
    this.requests.push(request);
    const script = this.queue.shift();
    if (!script) throw new Error("脚本耗尽（不该发生的额外调用）");
    for (const item of script) {
      if (item instanceof Error) throw item;
      yield item;
    }
  }
  async complete() {
    return { content: "{}", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
  }
  async listModels() {
    return [];
  }
  async fetchModelsFromServer() {
    return [];
  }
}

/** 第 1 轮：调用一个只读探针工具 ⇒ 循环进入第 2 轮（目标是 iteration > 1 才注入的） */
function probeIteration(): any[] {
  const id = "call_probe";
  return [
    { type: "tool_use_start", id, name: PROBE },
    { type: "tool_use_delta", id, input: JSON.stringify({ note: "go" }) },
    { type: "tool_use_end", id, input: { note: "go" } },
    { type: "end", finishReason: "tool_use" },
  ];
}

function finalIteration(text: string): any[] {
  return [{ type: "text_delta", text }, { type: "end", finishReason: "stop" }];
}

function registryWithProbe() {
  const registry = createDefaultToolRegistry();
  registry.register({
    id: PROBE,
    description: "测试探针：不做任何事，只把循环推进到第 2 轮",
    parameters: { type: "object", properties: { note: { type: "string" } }, required: [] },
    contract: {
      readOnly: true,
      sideEffectScope: "none",
      accessScope: "none",
      persistResult: false,
    },
    async execute() {
      return { title: "probe", output: "probe ok" };
    },
  } as any);
  return registry;
}

/** 跑两轮并返回 provider 记下的请求 */
async function runTwoIterations(sessionId: string): Promise<any[]> {
  const provider = new RecordingProvider();
  provider.setScript([probeIteration(), finalIteration("第二轮")]);
  const loop = new AgenticLoop(provider as any, registryWithProbe(), {
    maxIterations: 4,
    model: "goal-model",
    securityMode: "full",
  });
  for await (const _e of loop.run(sessionId, "开始吧", CWD, "system prompt")) {
    /* drain */
  }
  return provider.requests;
}

function messageWithGoals(request: any): any | undefined {
  return request?.messages?.find((m: any) => String(m.content ?? "").includes("# Active Goals"));
}

function cancelAllGoals(sessionId: string): void {
  for (const g of listGoals(sessionId)) {
    updateGoal(g.id, { status: "cancelled" } as never);
  }
}

describe("活跃目标注入：模型实际收到的请求里必须真的有目标", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cancelAllGoals(SESSION);
  });

  it("GOAL-A/B/C: 第 2 轮的请求里带上目标，位置在尾部 user 消息（system 前缀不许有）", async () => {
    const created = createGoal({
      sessionId: SESSION,
      title: "注入测试目标",
      status: "in_progress",
      priority: "normal",
      successCriteria: "目标出现在请求里",
    } as never);

    const requests = await runTwoIterations(SESSION);
    expect(requests.length, "前置：探针工具调用必须把循环推进到第 2 轮（否则第 2 轮无从观察）").toBeGreaterThanOrEqual(2);

    // GOAL-A：第 1 轮不该有目标（iteration > 1 门控）
    expect(
      messageWithGoals(requests[0]),
      "第 1 轮就注入目标会让模型重复自己刚说过的东西 —— iteration > 1 的门控必须保留",
    ).toBeUndefined();

    // GOAL-B：第 2 轮**必须**有目标，且标题/判据都在
    const req2 = requests[1];
    const goalMsg = messageWithGoals(req2);
    expect(
      goalMsg,
      "目标必须出现在**模型实际收到的请求**里 —— 旧实现被恒假的 apiMessages[0].role 判据挡住，一次都没到过模型",
    ).toBeTruthy();
    expect(String(goalMsg.content)).toContain(created.title);
    expect(String(goalMsg.content)).toContain("目标出现在请求里");
    // 位置：最后一条消息，role 是 user（与 time-context 同一处置的尾部消息）
    expect(req2.messages[req2.messages.length - 1], "目标所在消息必须是尾部的最后一条").toBe(goalMsg);
    expect(goalMsg.role).toBe("user");

    // 注入措辞的既有契约（防重复劳动 / 允许如实说被卡住）
    expect(String(goalMsg.content)).toMatch(/Do NOT redo work that is already done/i);
    expect(String(goalMsg.content)).toMatch(/update_goal/);
    expect(String(goalMsg.content)).toMatch(/blocked on something only the/i);

    // GOAL-C：system 前缀里不许有易变的目标文本（前缀缓存判据）
    expect(
      String(req2.messages[0].content),
      "目标随状态变化，写进 system 前缀会整段击穿前缀缓存",
    ).not.toContain("# Active Goals");
  });

  it("GOAL-D: blocked 目标也会被列出（与 in_progress 同一份摘要）", async () => {
    const blocked = createGoal({
      sessionId: SESSION,
      title: "被阻塞的目标",
      status: "blocked",
      priority: "normal",
    } as never);

    const requests = await runTwoIterations(SESSION);
    const goalMsg = messageWithGoals(requests[1]);
    expect(goalMsg, "blocked 目标同样要到达模型").toBeTruthy();
    expect(String(goalMsg.content)).toContain(blocked.title);
    expect(String(goalMsg.content)).toContain("[blocked]");
  });

  it("GOAL-E 反向对照：没有活跃目标时任何请求都不该出现注入段", async () => {
    const requests = await runTwoIterations(SESSION);
    expect(requests.length).toBeGreaterThanOrEqual(2);
    for (const req of requests) {
      expect(
        messageWithGoals(req),
        "没有活跃目标却拼出注入段 —— 那说明这段文本是常量，测试等于没测",
      ).toBeUndefined();
    }
  });
});
