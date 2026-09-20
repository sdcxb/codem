/**
 * `AgentMessageQueue` 的内存上界（第 62 轮；稳定性审计实测发现）
 *
 * ## 这条用例钉的是什么
 *
 * 审计（`.preview-shot/audit-stability.md`）把 `consumedReplies` 列为"无上界内存结构"：
 * 每次 `send({messageType:"reply"})` 都会把**一整段回复正文**塞进一个**从不删除**的 Map —— 
 * 也就是说"agent 之间来回对话越多，进程常驻内存越大"，而且没有任何上限或逐出。
 *
 * 修法是**条数上界 + FIFO 逐出**（`MAX_CONSUMED_REPLIES = 200`），
 * 因为回复在同一个回合内就会被 `getReply` 读走，超出窗口的老回复被逐出后返回 `null`
 * —— 而 `null` 本来就是"还没回复"这一态的返回值，调用方必须处理它。
 *
 * ## 用例的判据
 *
 * 1. 正常量级（不超过上界）⇒ **一个字都不能丢**（不能把修上界修成"经常查不到回复"）；
 * 2. 超过上界 ⇒ 最老的被逐出、最新的在（FIFO），且**总量不越界**；
 * 3. 逐出只影响"老回复"，`getReply` 对近期回复照常返回正文。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const sendReply = (id: string, body: string, to = "agent-a") => {
  // 动态 import 保证每个用例拿到同一模块实例（模块级 Map 状态）
  return import("../core/llm/agent-message-queue").then(({ AgentMessageQueue }) => {
    AgentMessageQueue.send({
      sessionId: "s1",
      fromAgent: "agent-b",
      toAgent: to,
      messageType: "reply",
      subject: "re",
      body,
      replyToId: id,
    });
    return AgentMessageQueue;
  });
};

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("AMQ：agent 消息队列的内存上界", () => {
  it("AMQ-1: 上界以内——回复正文一个字都不许丢（不能把'加界'修成'查不到'）", async () => {
    const q = await import("../core/llm/agent-message-queue").then((m) => m.AgentMessageQueue);
    const body = "回复正文-".repeat(50);
    for (let i = 0; i < 20; i++) await sendReply(`keep-${i}`, `${body}${i}`);
    for (let i = 0; i < 20; i++) {
      expect(q.getReply(`keep-${i}`), `第 ${i} 条回复必须查得到`).toBe(`${body}${i}`);
    }
    // 没回复过的消息 id 仍然是 null（不能编一个出来）
    expect(q.getReply("never-replied")).toBeNull();
  });

  it("AMQ-2: 超过上界——最老的被逐出、最新的一定在（FIFO），且不报错", async () => {
    const q = await import("../core/llm/agent-message-queue").then((m) => m.AgentMessageQueue);
    // 上界是 200，这里写 260 条（正文用小串，避免用例吃内存）
    for (let i = 0; i < 260; i++) await sendReply(`cap-${i}`, `b${i}`);
    expect(q.getReply("cap-259"), "最新的必须在").toBe("b259");
    expect(q.getReply("cap-0"), "最老的应已被逐出（FIFO）").toBeNull();
    // 逐出只影响老条目：靠近上界边缘的仍然在
    expect(q.getReply("cap-200")).toBe("b200");
  });
});
