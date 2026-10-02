/**
 * GUIDANCE-CARRYOVER：上一轮结束后入队的引导消息**不许被静默删除**。
 *
 * ## 缺陷形态（修复前）
 *
 * `agentic-loop.run()` 的第一件事是 `this.guidanceQueue.expire(sessionId)` ——
 * 一句静默删除。窗口是真实的：
 *
 * 1. `sendGuidance()`（`agentic-loop.ts:4094`）只检查 `currentSessionId`；
 * 2. `currentSessionId` 在 `run()` 开头赋值后**从不复位**（全文件只有
 *    `:880` 一处赋值）；
 * 3. 于是「循环已经决定停下、下一次 `run()` 还没开始」的间隙里，用户手打的纠偏
 *    **入队成功**（`enqueue` 返回条目、UI 气泡出现），紧接着下一次 `run()` 把它删掉：
 *    模型没见过、用户也没有任何信号；
 * 4. `guidance-queue.ts` 的 `expire` 文档还写着「Called when the agentic loop finishes」，
 *    与唯一的调用点（回合**开始**）不符。
 *
 * ## 本轮选定的处置
 *
 * 把残留**变成一条真实且落库的 user 消息**（内容用既有的
 * `GUIDANCE_MESSAGE_TEMPLATE` 包裹，与本轮正常消费的引导同形态），
 * 并 `yield guidance_received` 让 UI 收掉状态栏气泡。三选一的理由写在
 * `agentic-loop.ts` 那段注释里（① 没有单点终态；③ 只告知仍然丢内容）。
 *
 * ## 断言落在哪（为什么不是源码文本）
 *
 * - (a) 回合结束后 `sendGuidance()` **真的入队成功**（复现窗口本身）；
 * - (b) 下一轮 **provider 收到的请求里**带着这段文本（模型真的看到了）；
 * - (c) 它**落库**了、且**只有一份**（不是重复注入）；
 * - (d) 循环 yield 了 `guidance_received`（UI 可见性）；
 * - (e) 队列被清空（不会在更后面的轮次反复出现）。
 */
import { describe, it, expect, beforeEach } from "vitest";

import * as ProjectStorage from "../core/storage/project";
import * as SessionStorage from "../core/storage/session";
import * as MessageStorage from "../core/storage/message";
import { createDefaultToolRegistry } from "../core/llm/tools";
import { AgenticLoop } from "../core/llm/agentic-loop";

const SESSION_ID = "guidance-carryover-session";
const PROJECT_ID = "guidance-carryover-project";
const CWD = "C:\\guidance-carryover";
const SYSTEM_PROMPT = "你是测试用助手。";

/** 用户在「循环已停下、下一轮还没开始」的间隙里打出的纠偏指令 */
const MID_TURN_GUIDANCE = "先别改那个文件，改成先补一个失败测试";

function textEvents(text: string): any[] {
  return [
    { type: "text_delta", text },
    { type: "end", finishReason: "stop" },
  ];
}

class RecordingProvider {
  id = "guidance-provider";
  name = "Guidance Mock";
  requests: any[] = [];
  private streamQueue: any[][] = [];
  isConfigured() {
    return true;
  }
  setScript(scripts: any[][]) {
    this.streamQueue = scripts;
  }
  async *stream(request: any): AsyncGenerator<any> {
    this.requests.push(request);
    const script = this.streamQueue.length > 0 ? this.streamQueue.shift()! : textEvents("收到");
    for (const event of script) yield event;
  }
  async complete() {
    return { content: "{}", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
  }
  async listModels() {
    return [];
  }
  async fetchModelsFromServer() {
    return [];
  }
}

/** 跑完一整轮，返回这一轮 yield 的事件 */
async function runTurn(
  loop: AgenticLoop,
  userMessage: string,
): Promise<any[]> {
  const events: any[] = [];
  for await (const e of loop.run(SESSION_ID, userMessage, CWD, SYSTEM_PROMPT)) {
    events.push(e);
  }
  return events;
}

function persistedGuidanceMessages(): any[] {
  return MessageStorage.listMessages(SESSION_ID).filter((m: any) =>
    String(m.content).includes(MID_TURN_GUIDANCE),
  );
}

describe("引导消息残留：不许静默丢弃", () => {
  let provider: RecordingProvider;
  let loop: AgenticLoop;

  beforeEach(() => {
    ProjectStorage.createProject({
      id: PROJECT_ID,
      name: "引导残留测试项目",
      path: CWD,
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
    });
    SessionStorage.createSession({
      id: SESSION_ID,
      projectId: PROJECT_ID,
      title: "引导残留测试会话",
      createdAt: Date.now(),
      lastMessageAt: Date.now(),
      messageCount: 0,
    });

    provider = new RecordingProvider();
    provider.setScript([textEvents("第一轮收到")]);
    loop = new AgenticLoop(provider as any, createDefaultToolRegistry(), {
      maxIterations: 4,
      model: "guidance-model",
      securityMode: "full",
    });
  });

  it("GUIDE-CARRY-1: 回合结束后的间隙里发的引导，下一轮必须被模型看到（且落库、且只一次）", async () => {
    // ---- 第一轮：正常跑完 ----
    await runTurn(loop, "看一下这个 bug");

    // ---- 复现窗口：回合已结束，但 sendGuidance 仍然入队成功 ----
    const item = loop.sendGuidance(MID_TURN_GUIDANCE);
    expect(
      item,
      "前置条件：回合结束后 sendGuidance 仍然入队成功 —— 这正是「静默删除」的窗口（若这里为 null，说明窗口已被关掉，本用例的前提不成立）",
    ).not.toBeNull();
    expect(loop.hasPendingGuidance(), "前置条件：引导确实在队列里").toBe(true);

    // ---- 第二轮：新的用户消息 ----
    provider.setScript([textEvents("第二轮收到")]);
    const events = await runTurn(loop, "继续");

    // ---- (d) 可见性：循环把「这条引导被接管」告诉了 UI ----
    const received = events.filter((e) => e.type === "guidance_received");
    expect(
      received.length,
      "必须 yield guidance_received（UI 靠它收掉状态栏气泡；否则气泡永久残留）",
    ).toBe(1);
    expect(received[0].message).toBe(MID_TURN_GUIDANCE);
    expect(received[0].guidanceId).toBe(item!.id);

    // ---- (b) 模型真的看到了：第二轮第一次请求的正文里带着这段文本 ----
    const secondTurnRequests = provider.requests.slice(1);
    expect(secondTurnRequests.length, "第二轮应当至少有一次请求").toBeGreaterThan(0);
    const seenByModel = secondTurnRequests[0].messages.some((m: any) =>
      String(m.content).includes(MID_TURN_GUIDANCE),
    );
    expect(
      seenByModel,
      "用户的话必须真的到达模型 —— 静默删除的旧行为在这里会失败",
    ).toBe(true);

    // ---- (c) 落库、且只有一份 ----
    const persisted = persistedGuidanceMessages();
    expect(persisted.length, "引导必须落库成一条真实 user 消息（DSH：inbox 是持久投影）").toBe(1);
    expect(persisted[0].role).toBe("user");
    expect(String(persisted[0].content)).toContain(MID_TURN_GUIDANCE);

    // ---- (e) 队列已清空：不会在更后面的轮次反复出现 ----
    expect(loop.hasPendingGuidance(), "接管之后队列必须是空的（否则会重复注入）").toBe(false);
  });

  it("GUIDE-CARRY-2: 落库的消息在被接管的那一轮之后仍然留在历史里（不是一次性临时消息）", async () => {
    await runTurn(loop, "看一下这个 bug");
    loop.sendGuidance(MID_TURN_GUIDANCE);

    provider.setScript([textEvents("第二轮收到")]);
    await runTurn(loop, "继续");

    // 第三轮（与引导无关的新任务）：历史里仍然有它 —— 这是"持久投影"与"临时注入"的区别
    provider.setScript([textEvents("第三轮收到")]);
    const thirdTurnStart = provider.requests.length;
    await runTurn(loop, "换个任务");

    const thirdTurnRequest = provider.requests[thirdTurnStart];
    expect(
      thirdTurnRequest.messages.some((m: any) => String(m.content).includes(MID_TURN_GUIDANCE)),
      "落库的消息应当留在会话历史里，后续轮次仍能看到",
    ).toBe(true);
    expect(persistedGuidanceMessages().length, "不许在后续轮次重复落库").toBe(1);
  });
});
