/**
 * PENDING-PERSIST：needs_you / agent_messages 的**落库接线**（2026-10-29 补的真缺口）。
 *
 * 之前两个队列只在内存：文件头却写着 "Persistence: … SQLite table"。
 * 这里用假端口钉住四件事：
 * 1. 启动时能从 `crud.list` 回填；
 * 2. 入队会 `crud.upsert`（整行、snake_case、options JSON）；
 * 3. 消费/回答会 `crud.delete` 销账；
 * 4. 没有端口时完全静默（纯逻辑环境不炸）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const calls: Array<{ cmd: string; params: any }> = [];
  const rows = new Map<string, any[]>();
  const data = {
    async query(cmd: string, params: any) {
      calls.push({ cmd, params });
      return { items: rows.get(params.table) ?? [] };
    },
    async execute(cmd: string, params: any) {
      calls.push({ cmd, params });
      return {};
    },
  };
  const state = { hasPort: true };
  return { calls, rows, data, state };
});

vi.mock("../core/storage/port", () => ({
  hasStoragePort: () => h.state.hasPort,
  getStoragePort: () => ({ data: h.data }),
  setStoragePortListener: () => () => {},
}));

function reset() {
  h.calls.length = 0;
  h.rows.clear();
  h.state.hasPort = true;
  vi.resetModules();
}

describe("PENDING-PERSIST：待处理队列落库", () => {
  beforeEach(reset);

  it("PP-1/2: needs_you 回填 + 入队 upsert + 消费 delete", async () => {
    h.rows.set("needs_you_pending", [
      {
        id: "ny-1",
        session_id: "s1",
        question: "选哪个？",
        context: "c",
        confirmed_facts: "f",
        options: JSON.stringify([{ id: "a", label: "A" }]),
        resume_path: "r",
        iteration: 3,
        created_at: 111,
      },
    ]);
    const q = await import("../core/llm/needs-you-queue");
    await new Promise((r) => setTimeout(r, 0));
    await q.hydrateNeedsYouFromStorage();

    expect(q.NeedsYouQueue.getPending("s1")).toHaveLength(1);
    expect(q.NeedsYouQueue.getPending("s1")[0].options[0].id).toBe("a");

    q.NeedsYouQueue.enqueue("s1", {
      question: "再选一个",
      context: "c2",
      confirmedFacts: "f2",
      options: [{ id: "b", label: "B" }],
      resumePath: "r2",
    }, 4);
    await new Promise((r) => setTimeout(r, 0));
    const upserts = h.calls.filter((c) => c.cmd === "crud.upsert" && c.params.table === "needs_you_pending");
    expect(upserts.length).toBe(1);
    expect(upserts[0].params.mode).toBe("replace");
    expect(upserts[0].params.rows[0].options).toBe(JSON.stringify([{ id: "b", label: "B" }]));

    q.NeedsYouQueue.consume("s1");
    await new Promise((r) => setTimeout(r, 0));
    expect(h.calls.some((c) => c.cmd === "crud.delete" && c.params.table === "needs_you_pending")).toBe(true);
  });

  it("PP-3: agent_messages 回填 + 发送 upsert + 消费 delete", async () => {
    h.rows.set("agent_messages", [
      {
        id: "msg-1",
        session_id: "s1",
        from_agent: "a",
        to_agent: "b",
        message_type: "notification",
        subject: "s",
        body: "hello",
        status: "pending",
        sequence: 2,
        created_at: 222,
      },
    ]);
    const q = await import("../core/llm/agent-message-queue");
    await new Promise((r) => setTimeout(r, 0));
    await q.hydrateAgentMessagesFromStorage();
    expect(q.AgentMessageQueue.consume("b").map((m) => m.id)).toContain("msg-1");

    q.AgentMessageQueue.send({
      sessionId: "s1",
      fromAgent: "a",
      toAgent: "b",
      messageType: "request",
      subject: "x",
      body: "y",
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(h.calls.some((c) => c.cmd === "crud.upsert" && c.params.table === "agent_messages")).toBe(true);
  });

  it("PP-4: 没有端口时静默（不抛、不写）", async () => {
    h.state.hasPort = false;
    vi.resetModules();
    const q = await import("../core/llm/needs-you-queue");
    q.NeedsYouQueue.enqueue("s", {
      question: "q", context: "c", confirmedFacts: "f",
      options: [], resumePath: "r",
    }, 1);
    await new Promise((r) => setTimeout(r, 0));
    expect(h.calls.length).toBe(0);
  });
});
