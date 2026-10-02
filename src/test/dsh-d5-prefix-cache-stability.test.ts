/**
 * D5：每轮易变文本**不许进 system 前缀**（前缀缓存 / KV cache 稳定性）。
 *
 * ## 缺陷形态
 *
 * `agentic-loop.ts` 原先把时间上下文拼进 `apiMessages[0].content`：
 * `sysMsg.content += "\n\n" + timeContextMessage`。那段文本含**秒级**时间戳，
 * 于是"每一轮的前缀都不一样" ⇒ provider 的 prompt cache（DeepSeek 的 KV cache）
 * 整段失效 —— 命中缓存的输入价约为未命中的 1/4，且慢得多。
 *
 * 修法（与 DSH `context/time-context` 对齐）：易变上下文作为**独立的尾部 user 消息**
 * 注入（稳定前缀一字不动），并且**节流**（10 分钟，DSH 默认 `refreshIntervalMs`）。
 *
 * ## 这一组用例为什么断言"实际请求"
 *
 * 只看源码会假绿（这段注入原来还带着 `apiMessages[0].role === "system"` 的判据，
 * 而真实会话里 `apiMessages[0]` 是第一条 user 消息 —— 那个判据恒假，
 * 也就是说注入**从来没生效过**）。所以这里**拦截 provider 收到的请求本体**：
 *
 * | # | 判据 |
 * | --- | --- |
 * | D5-A | 两轮请求的 `messages[0]`（system）**逐字节相同**，且都不含 `Time sampled` |
 * | D5-B | 易变上下文确实**到达了模型**，位置在**尾部**（不是前缀）——防"干脆不注入"这种假修 |
 * | D5-C | 同一会话几秒后的第二轮**不再重复注入**（节流生效） |
 * | D5-D | 第二轮的整条消息序列是第一轮的**前缀**（逐字节）——这正是 KV cache 能命中的判据 |
 */
import { describe, it, expect, beforeEach } from "vitest";

import { AgenticLoop } from "../core/llm/agentic-loop";
import { createDefaultToolRegistry } from "../core/llm/tools";
import { clearTimeContext } from "../core/llm/time-context";

const SESSION_ID = "dsh-d5-prefix";
const CWD = "C:\\d5-prefix";
const SYSTEM_PROMPT = "你是测试用助手。这是系统提示，必须逐字节稳定。";

class RecordingProvider {
  id = "d5-provider";
  name = "D5 Mock";
  requests: any[] = [];
  isConfigured() {
    return true;
  }
  async *stream(request: any): AsyncGenerator<any> {
    this.requests.push(request);
    yield { type: "text_delta", text: "收到" };
    yield { type: "end", finishReason: "stop" };
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

async function runOnce(provider: RecordingProvider, sessionId: string, message: string): Promise<void> {
  const loop = new AgenticLoop(provider as any, createDefaultToolRegistry(), {
    maxIterations: 2,
    model: "d5-model",
    securityMode: "full",
  });
  for await (const _e of loop.run(sessionId, message, CWD, SYSTEM_PROMPT)) {
    /* drain */
  }
}

/** 把一条消息序列序列化成可逐字节比较的文本 */
function serialize(messages: any[]): string[] {
  return messages.map((m) => JSON.stringify(m));
}

describe("D5：易变上下文不得进入 system 前缀", () => {
  beforeEach(() => {
    // 时间上下文的节流状态是**会话级**的模块单例：显式清掉，用例之间不许串味
    clearTimeContext(SESSION_ID);
  });

  it("D5: 同一会话两轮（相隔数秒）→ messages[0] 逐字节一致且不含时间戳；易变内容只在尾部且被节流", async () => {
    const first = new RecordingProvider();
    await runOnce(first, SESSION_ID, "你好（第一轮）");

    // 跨过"秒"边界：如果前缀里带秒级时间戳，两轮一定不同
    await new Promise((r) => setTimeout(r, 1200));

    const second = new RecordingProvider();
    await runOnce(second, SESSION_ID, "你好（第二轮）");

    expect(first.requests.length).toBeGreaterThanOrEqual(1);
    expect(second.requests.length).toBeGreaterThanOrEqual(1);
    const req1 = first.requests[0];
    const req2 = second.requests[0];

    // ---- D5-A：system 消息必须逐字节稳定，且不含秒级时间戳 ----
    expect(req1.messages[0].role).toBe("system");
    expect(req2.messages[0].role).toBe("system");
    expect(
      req2.messages[0].content,
      "两轮请求的 system 消息必须逐字节相同（前缀缓存的前提）",
    ).toBe(req1.messages[0].content);
    expect(
      String(req1.messages[0].content),
      "时间戳（秒级易变文本）绝不许出现在 system 前缀里",
    ).not.toContain("Time sampled");
    expect(String(req2.messages[0].content)).not.toContain("Time sampled");

    // ---- D5-B：易变内容确实到达了模型，但只在**尾部** ----
    const last1 = String(req1.messages[req1.messages.length - 1].content);
    expect(
      last1,
      "时间上下文必须真的注入（作为独立的尾部消息）——否则就是'干脆不注入'的假修",
    ).toContain("Time sampled");
    expect(req1.messages[0].id).not.toBe(req1.messages[req1.messages.length - 1].id);

    // ---- D5-C：节流（同一会话 10 分钟内不再重复注入）----
    const req2HasTime = req2.messages.some((m: any) => String(m.content).includes("Time sampled"));
    expect(
      req2HasTime,
      "同一会话相隔几秒的第二轮不该再注入时间上下文（refreshIntervalMs = 600_000）",
    ).toBe(false);

    // ---- D5-D：第二轮的整条消息序列是第一轮的前缀（逐字节）----
    const ser1 = serialize(req1.messages);
    const ser2 = serialize(req2.messages);
    expect(ser2.length).toBeLessThanOrEqual(ser1.length);
    expect(
      ser2,
      "第二轮请求必须是第一轮请求的前缀（逐字节）——这正是 provider 前缀缓存能命中的判据",
    ).toEqual(ser1.slice(0, ser2.length));
  });
});
