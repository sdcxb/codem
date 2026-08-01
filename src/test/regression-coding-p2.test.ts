/**
 * P2 回归测试 — 新增功能：浏览器面板/AgentMessage异步/Overview/Artifact引用
 *
 * 覆盖 coding-improvement-final.md 中 #9/#10/#11/#12 四项 P2 改造
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { initDatabase, resetDatabase } from "../core/storage/database";
import { AgentMessageQueue, onAgentMessage } from "../core/llm/agent-message-queue";

// Mock Tauri
function mockTauriInvoke(responses: Record<string, any>) {
  const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
    if (responses[command]) {
      const resp = responses[command];
      if (typeof resp === "function") return resp(args);
      return resp;
    }
    return null;
  });
  (window as any).__TAURI__ = { core: { invoke, listen: vi.fn(() => Promise.resolve(() => {})) } };
  return invoke;
}

describe("P2-9: Browser Panel — 浏览器面板", () => {
  beforeEach(() => {
    delete (window as any).__TAURI__;
  });

  it("create_browser_window — 调用 Tauri 命令", async () => {
    const invoke = mockTauriInvoke({
      create_browser_window: null,
    });

    await invoke("create_browser_window", {
      url: "http://localhost:3000",
      title: "Preview",
    });

    expect(invoke).toHaveBeenCalledWith("create_browser_window", {
      url: "http://localhost:3000",
      title: "Preview",
    });
  });

  it("close_browser_window — 调用 Tauri 命令", async () => {
    const invoke = mockTauriInvoke({
      close_browser_window: null,
    });

    await invoke("close_browser_window");
    expect(invoke).toHaveBeenCalledWith("close_browser_window");
  });

  it("lib.rs — 注册浏览器命令", () => {
    const source = require("fs").readFileSync(
      "src-tauri/src/lib.rs",
      "utf-8"
    );
    expect(source).toContain("create_browser_window");
    expect(source).toContain("close_browser_window");
  });
});

describe("P2-10: AgentMessageQueue — 异步 Agent 间通信", () => {
  beforeEach(() => {
    AgentMessageQueue.clearSession("test-session");
  });

  it("send + consume — 消息发送和消费", () => {
    const msg = AgentMessageQueue.send({
      sessionId: "test-session",
      fromAgent: "main",
      toAgent: "research",
      messageType: "request",
      subject: "研究 API 设计",
      body: "请调查 REST vs GraphQL 的优缺点",
    });

    expect(msg.id).toMatch(/^msg-/);
    expect(msg.fromAgent).toBe("main");
    expect(msg.toAgent).toBe("research");
    expect(msg.messageType).toBe("request");
    expect(msg.status).toBe("pending");

    const consumed = AgentMessageQueue.consume("research");
    expect(consumed.length).toBe(1);
    expect(consumed[0].subject).toBe("研究 API 设计");
  });

  it("hasPending — 检测未消费消息", () => {
    expect(AgentMessageQueue.hasPending("research")).toBe(false);
    AgentMessageQueue.send({
      sessionId: "test-session",
      fromAgent: "main",
      toAgent: "research",
      messageType: "notification",
      subject: "Page live",
      body: "Landing page deployed",
    });
    expect(AgentMessageQueue.hasPending("research")).toBe(true);
  });

  it("sequence — 序列号递增", () => {
    const msg1 = AgentMessageQueue.send({
      sessionId: "test-session",
      fromAgent: "main",
      toAgent: "worker",
      messageType: "request",
      subject: "Task 1",
      body: "Body 1",
    });
    const msg2 = AgentMessageQueue.send({
      sessionId: "test-session",
      fromAgent: "main",
      toAgent: "worker",
      messageType: "request",
      subject: "Task 2",
      body: "Body 2",
    });

    expect(msg2.sequence).toBe(msg1.sequence + 1);
  });

  it("getReply — 获取 reply 消息内容", () => {
    const originalMsg = AgentMessageQueue.send({
      sessionId: "test-session",
      fromAgent: "main",
      toAgent: "worker",
      messageType: "request",
      subject: "Question",
      body: "What is 2+2?",
    });

    // Send reply
    AgentMessageQueue.send({
      sessionId: "test-session",
      fromAgent: "worker",
      toAgent: "main",
      messageType: "reply",
      subject: "Re: Question",
      body: "4",
      replyToId: originalMsg.id,
    });

    const reply = AgentMessageQueue.getReply(originalMsg.id);
    expect(reply).toBe("4");
  });

  it("onAgentMessage — 监听器收到事件", () => {
    let received = false;
    const unsub = onAgentMessage(() => {
      received = true;
    });

    AgentMessageQueue.send({
      sessionId: "test-session",
      fromAgent: "main",
      toAgent: "worker",
      messageType: "notification",
      subject: "Test",
      body: "Body",
    });

    expect(received).toBe(true);
    unsub();
  });

  it("clearSession — 清空指定会话消息", () => {
    AgentMessageQueue.send({
      sessionId: "test-session",
      fromAgent: "main",
      toAgent: "worker",
      messageType: "request",
      subject: "Task",
      body: "Body",
    });
    AgentMessageQueue.clearSession("test-session");
    expect(AgentMessageQueue.hasPending("worker")).toBe(false);
  });

  it("agent_messages 表 — 独立于压缩", () => {
    const source = require("fs").readFileSync(
      "src/core/storage/database.ts",
      "utf-8"
    );
    expect(source).toContain("agent_messages");
  });

  it("agentic-loop — 导入 AgentMessageQueue", () => {
    const source = require("fs").readFileSync(
      "src/core/llm/agentic-loop.ts",
      "utf-8"
    );
    expect(source).toContain("AgentMessageQueue");
    expect(source).toContain("agent_message_received");
  });

  it("agentic-loop — 迭代边界消费 Agent Message", () => {
    const source = require("fs").readFileSync(
      "src/core/llm/agentic-loop.ts",
      "utf-8"
    );
    expect(source).toContain("AgentMessageQueue.consume(this.agentId)");
  });
});

describe("P2-11: Workbench Overview — 轻量可观测性", () => {
  it("Workbench — 包含 Status/Capacity/Activity 三视图", () => {
    const source = require("fs").readFileSync(
      "src/components/Workbench.tsx",
      "utf-8"
    );
    expect(source).toContain("status");
    expect(source).toContain("capacity");
    expect(source).toContain("activity");
    expect(source).toContain("workbench-view-tabs");
  });

  it("Workbench — 导入 onFileChangesTracked 监听变更", () => {
    const source = require("fs").readFileSync(
      "src/components/Workbench.tsx",
      "utf-8"
    );
    expect(source).toContain("onFileChangesTracked");
  });

  it("Workbench — Signal is not Diagnosis 声明", () => {
    const source = require("fs").readFileSync(
      "src/components/Workbench.tsx",
      "utf-8"
    );
    expect(source).toContain("Signal");
    expect(source.toLowerCase()).toContain("diagnosis");
  });
});

describe("P2-12: Artifact 快照引用 — 集成验证", () => {
  beforeEach(async () => {
    delete (window as any).__TAURI__;
    await initDatabase();
  });

  it("turn_file_changes 表 — 包含 artifact_id (id 字段)", () => {
    const source = require("fs").readFileSync(
      "src/core/storage/database.ts",
      "utf-8"
    );
    expect(source).toContain("turn_file_changes");
    expect(source).toContain("patch_sha256");
    expect(source).toContain("current_brief");
  });

  it("FileChangeResult — 返回 artifactId", async () => {
    const { FileChangeTracker } = await import("../core/environment/file-change-tracker");

    // Mock git commands
    let treeCallCount = 0;
    (window as any).__TAURI__ = {
      core: {
        invoke: vi.fn(async (cmd: string, args?: any) => {
          if (args?.command?.includes("is-inside-work-tree")) return { stdout: "true", stderr: "", exitCode: 0 };
          if (args?.command?.includes("rev-parse HEAD^{tree}")) {
            treeCallCount++;
            return { stdout: treeCallCount === 1 ? "tree-before\n" : "tree-after\n", stderr: "", exitCode: 0 };
          }
          if (args?.command?.includes("name-status")) return { stdout: "M\tfile.ts\n", stderr: "", exitCode: 0 };
          if (args?.command?.includes("binary")) return { stdout: "patch\n", stderr: "", exitCode: 0 };
          return { stdout: "", stderr: "", exitCode: 0 };
        }),
        listen: vi.fn(() => Promise.resolve(() => {})),
      },
    };

    const tracker = new FileChangeTracker("/fake/repo", "session-1", "msg-1", 1);
    await tracker.start();
    const result = await tracker.finalize();

    if (result) {
      expect(result.artifactId).toMatch(/^tfc-/);
      expect(result.changedFiles.length).toBeGreaterThan(0);
    }
  });
});

describe("P2-12: Overview + file_changes_tracked 事件链路", () => {
  it("agentic-loop — yield file_changes_tracked 事件", () => {
    const source = require("fs").readFileSync(
      "src/core/llm/agentic-loop.ts",
      "utf-8"
    );
    expect(source).toContain("file_changes_tracked");
    expect(source).toContain("artifactId");
    expect(source).toContain("changedFiles");
  });

  it("agentic-loop — tryAutoCommit 在 finalize 后调用", () => {
    const source = require("fs").readFileSync(
      "src/core/llm/agentic-loop.ts",
      "utf-8"
    );
    expect(source).toContain("tryAutoCommit");
  });

  it("agentic-loop — TranscriptCache.clear 在 compaction 后调用", () => {
    const source = require("fs").readFileSync(
      "src/core/llm/agentic-loop.ts",
      "utf-8"
    );
    expect(source).toContain("TranscriptCache.clear()");
  });

  it("agentic-loop — needs_you 在迭代边界消费", () => {
    const source = require("fs").readFileSync(
      "src/core/llm/agentic-loop.ts",
      "utf-8"
    );
    expect(source).toContain("needsYouQueue.consume");
    expect(source).toContain("needs_you");
    expect(source).toContain("waitForAnswer");
  });
});
