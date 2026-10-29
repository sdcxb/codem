/**
 * P1-3：后台任务完成通知 —— 「后台干完活要主动告诉模型，而不是等它轮询」。
 *
 * ## 缺陷形态（改前）
 *
 * `terminal_send run_in_background` 的 job 完成之后，**唯一的取法是模型自己记得再调
 * `job_output`**。长命令的完成时机不由模型决定，于是：
 * - 它不知道跑完了，继续等或直接宣布「还在跑」；
 * - 就算知道，job id 只存在于对话里 —— 压缩摘要掉就再没人读那条结果。
 *
 * ## 这一组判据钉的四件事
 *
 * | # | 判据 | 防的假修 |
 * | --- | --- | --- |
 * | BJN-1 | 完成即登记，下一回合**出现在请求尾部** | 只登记不注入（等于没做） |
 * | BJN-2 | 同一回合只播一次 | 每次迭代都贴一遍，白烧 token |
 * | BJN-3 | 没被 `job_output` 读掉的，**下一回合还会出现** | 播一次就销账（压缩后彻底丢） |
 * | BJN-4 | 读过才销账；长输出**不贴正文** | 把不可信输出抬成 user 指令 / 撑爆上下文 |
 * | BJN-5 | 通知**不进 system 前缀** | 每轮前缀都变 ⇒ 前缀缓存整段失效 |
 */
import { describe, it, expect, beforeEach } from "vitest";

import { AgenticLoop } from "../core/llm/agentic-loop";
import { createDefaultToolRegistry } from "../core/llm/tools";
import { clearTimeContext } from "../core/llm/time-context";
import {
  clearBackgroundJobNotices,
  collectBackgroundJobNotices,
  isBackgroundJobUnread,
  listPendingBackgroundJobNotices,
  markBackgroundJobRead,
  noteBackgroundJobCompletion,
  MAX_ANNOUNCEMENTS,
  PREVIEW_MAX_CHARS,
} from "../core/llm/background-job-notices";

const SESSION = "bjn-session";
const OTHER = "bjn-other";
const CWD = "C:\\bjn";
const SYSTEM_PROMPT = "你是测试用助手。这是系统提示，必须逐字节稳定。";

function note(overrides: Partial<Parameters<typeof noteBackgroundJobCompletion>[0]> = {}) {
  noteBackgroundJobCompletion({
    jobId: "pty-job-1",
    terminalId: "term-1",
    sessionId: SESSION,
    status: "completed",
    waitReason: "inferred_idle",
    outputChars: 12,
    outputSample: "build ok\n",
    completedAt: 1_700_000_000_000,
    ...overrides,
  });
}

class RecordingProvider {
  id = "bjn-provider";
  name = "BJN Mock";
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

async function runOnce(sessionId: string): Promise<RecordingProvider> {
  const provider = new RecordingProvider();
  const loop = new AgenticLoop(provider as any, createDefaultToolRegistry(), {
    maxIterations: 2,
    model: "bjn-model",
    securityMode: "full",
  });
  for await (const _e of loop.run(sessionId, "继续", CWD, SYSTEM_PROMPT)) {
    /* drain */
  }
  return provider;
}

beforeEach(() => {
  clearBackgroundJobNotices();
  clearTimeContext(SESSION);
  clearTimeContext(OTHER);
});

describe("P1-3 后台任务完成通知", () => {
  it("BJN-1/BJN-2: 完成即登记，同一回合只播一次（第二次为空）", () => {
    note();
    const first = collectBackgroundJobNotices(SESSION, "turn-1");
    expect(first, "完成的后台任务必须被播报").toContain("pty-job-1");
    expect(first).toContain("job_output");
    expect(first).toContain("build ok");

    const second = collectBackgroundJobNotices(SESSION, "turn-1");
    expect(second, "同一回合的第二次迭代不该重复播报").toBe("");
  });

  it("BJN-3: 没被 job_output 读掉的，下一回合仍然出现（压缩只动消息，动不到这张表）", () => {
    note();
    expect(collectBackgroundJobNotices(SESSION, "turn-1")).toContain("pty-job-1");
    // 模拟压缩：消息被摘要掉了 —— 但登记表在会话之外，不受影响
    const nextTurn = collectBackgroundJobNotices(SESSION, "turn-2");
    expect(nextTurn, "未读结果必须在下一回合重新 surface").toContain("pty-job-1");
    expect(isBackgroundJobUnread("pty-job-1")).toBe(true);
  });

  it("BJN-4: 读过才销账；长输出只报大小、不贴正文", () => {
    const long = "x".repeat(PREVIEW_MAX_CHARS + 50);
    note({ jobId: "pty-job-long", outputChars: long.length, outputSample: long });
    const text = collectBackgroundJobNotices(SESSION, "turn-1");
    expect(text).toContain("pty-job-long");
    expect(text, "超过预览上限的输出不许整段贴进上下文").not.toContain("x".repeat(PREVIEW_MAX_CHARS));
    expect(text).toContain("chars");

    expect(markBackgroundJobRead("pty-job-long")).toBe(true);
    expect(isBackgroundJobUnread("pty-job-long")).toBe(false);
    expect(collectBackgroundJobNotices(SESSION, "turn-2"), "读过之后不该再播").toBe("");
  });

  it("BJN-4b: 播报到上限后主动退场（没人读的结果不永久占位）", () => {
    note();
    for (let i = 1; i <= MAX_ANNOUNCEMENTS; i += 1) {
      expect(collectBackgroundJobNotices(SESSION, `turn-${i}`)).toContain("pty-job-1");
    }
    expect(collectBackgroundJobNotices(SESSION, "turn-after"), "超过播报上限后不再出现").toBe("");
  });

  it("会话隔离：A 会话的通知不出现在 B 会话", () => {
    note({ sessionId: SESSION });
    expect(collectBackgroundJobNotices(OTHER, "turn-1"), "通知按归属会话隔离").toBe("");
    expect(collectBackgroundJobNotices(SESSION, "turn-1")).toContain("pty-job-1");
  });

  it("来源未知（sessionId 空串）的通知对所有会话可见 —— 宁可多报一次也不静默丢", () => {
    note({ sessionId: "" });
    expect(collectBackgroundJobNotices(OTHER, "turn-1")).toContain("pty-job-1");
  });

  it("BJN-5: 通知真的到达模型，且只出现在尾部，不进 system 前缀", async () => {
    note();
    const provider = await runOnce(SESSION);
    expect(provider.requests.length).toBeGreaterThanOrEqual(1);
    const req = provider.requests[0];
    const system = String(req.messages[0].content);
    expect(req.messages[0].role).toBe("system");
    expect(system, "后台任务通知绝不能进 system 前缀").not.toContain("Background jobs finished");

    const last = String(req.messages[req.messages.length - 1].content);
    expect(last, "通知必须真的到达模型（尾部消息）").toContain("pty-job-1");
    expect(last).toContain("Background jobs finished");
  });

  it("BJN-5b: 第二轮请求仍是第一轮的前缀（通知不破坏前缀缓存）", async () => {
    note();
    const first = await runOnce(SESSION);
    const second = await runOnce(SESSION);
    const a = first.requests[0].messages.map((m: any) => JSON.stringify(m));
    const b = second.requests[0].messages.map((m: any) => JSON.stringify(m));
    // 第二轮会多一条「历史 assistant 消息」+ 新的尾部通知；关键断言是 system 与首条用户消息没变
    expect(b[0]).toBe(a[0]);
    expect(String(second.requests[0].messages[0].content)).not.toContain("Background jobs finished");
  });

  it("listPendingBackgroundJobNotices 只返回事实，不返回输出样本", () => {
    note();
    const listed = listPendingBackgroundJobNotices(SESSION);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ jobId: "pty-job-1", status: "completed" });
    expect("outputSample" in listed[0], "登记表不该保存输出正文").toBe(false);
  });
});
