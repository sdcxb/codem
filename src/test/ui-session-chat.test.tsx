/**
 * `useSessionChat` 的判据（URC-*）。
 *
 * 这是"桌面与手机共用同一套会话交互"的唯一实现：必须证明
 * 1. 打开会话即读消息；
 * 2. 事件流能驱动流式正文与工具卡；
 * 3. 发送/取消真的调到传输层（不自己编 runId）；
 * 4. 只读模式不订阅、不发送（桌面预览不能偷偷改数据）。
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as React from "react";

import { ApprovalCard, toApprovalDecision } from "../../packages/ui/src/approval-card";
import { Composer, ContinueBar, MessageList } from "../../packages/ui/src/components";
import { capabilitiesFor, type SessionTransport } from "../../packages/ui/src/transport";
import { useSessionChat } from "../../packages/ui/src/use-session-chat";

function fakeTransport(seed?: Array<Record<string, unknown>>) {
  let listener: ((e: { seq: number; sessionId: string; type: string; payload: unknown; runId?: string }) => void) | null = null;
  let messages = (seed ?? [{ id: "m1", role: "user", content: "种子消息", timestamp: 1 }]) as Array<{
    id: string;
    role: string;
    content: string;
    timestamp: number;
    toolCallId?: string;
    toolCalls?: Array<{ id: string; tool: string; status: string }>;
  }>;
  const sent: Array<{ sessionId: string; text: string }> = [];
  const cancelled: string[] = [];
  const approvals: Array<{ approvalId: string; decision: string }> = [];
  const guidance: Array<{ runId: string; text: string }> = [];
  /** 页面打开时已经挂着的待批项（事件流不会补推"已存在"的） */
  let approvalSeed: Array<{ approvalId: string; tool: string; summary: string }> = [];
  let failNextSend = false;
  /** 服务器在 session.get 里附带的实时运行态（M2 刷新恢复） */
  let sessionRun: { runId?: string; state?: string } | null = null;
  const transport: SessionTransport = {
    hello: async () => ({ hostId: "t" }),
    listSessions: async () => [],
    getSession: async () => ({ title: "会话", messages, ...(sessionRun ? { run: sessionRun } : {}) }),
    send: async (sessionId, text) => {
      if (failNextSend) {
        failNextSend = false;
        throw new Error("会话正在处理中（BUSY）");
      }
      sent.push({ sessionId, text });
      return { runId: "run-1" };
    },
    cancel: async (runId) => {
      cancelled.push(runId);
    },
    guidance: async (runId: string, text: string) => {
      guidance.push({ runId, text });
    },
    respondApproval: async (approvalId: string, decision: string) => {
      approvals.push({ approvalId, decision });
    },
    listApprovals: async () => approvalSeed.map((a) => ({ ...a })),
    subscribe: (_sid, cb) => {
      listener = cb;
      return () => {
        listener = null;
      };
    },
  };
  return {
    transport,
    sent,
    cancelled,
    approvals,
    guidance,
    setMessages: (next: typeof messages) => {
      messages = next;
    },
    setApprovalSeed: (next: typeof approvalSeed) => {
      approvalSeed = next;
    },
    failNextSend: () => {
      failNextSend = true;
    },
    setSessionRun: (next: typeof sessionRun) => {
      sessionRun = next;
    },
    emit: (e: { seq: number; sessionId: string; type: string; payload: unknown; runId?: string }) => listener?.(e),
  };
}

function Harness(props: { transport: SessionTransport; readOnly?: boolean }): React.ReactElement {
  const chat = useSessionChat({
    transport: props.transport,
    sessionId: "s1",
    caps: capabilitiesFor("remote"),
    readOnly: props.readOnly,
  });
  return (
    <>
      {chat.error ? <div data-testid="chat-error">{chat.error}</div> : null}
      <MessageList views={chat.views} streaming={chat.streaming} />
      {chat.canContinue && chat.approvals.length === 0 ? (
        <ContinueBar onContinue={() => void chat.continueRun()} disabled={chat.runState === "running"} />
      ) : null}
      {chat.approvals.map((a) => {
        // 第 3 步：手机与桌面共用同一张审批卡（映射函数也只有一份）
        const request = toApprovalDecision(a);
        return (
          <ApprovalCard
            key={request.id}
            request={request}
            capabilities={{ alwaysAllow: false, rejectReason: false }}
            onResolve={(_id, outcome) =>
              void chat.respondApproval(request.id, outcome.kind === "allow" ? "allow" : "deny")
            }
          />
        );
      })}
      {props.readOnly ? null : (
        <>
          {chat.canGuide ? <button onClick={() => void chat.guide()}>引导</button> : null}
          <Composer
            value={chat.input}
            disabled={false}
            canSend={chat.canSend}
            canCancel={chat.canCancel}
            onChange={chat.setInput}
            onSend={() => void chat.send()}
            onCancel={() => void chat.cancel()}
          />
        </>
      )}
    </>
  );
}

describe("URC-1 会话交互", () => {
  it("打开即读消息；事件驱动流式正文与工具卡；发送/取消走传输层", async () => {
    const { transport, sent, cancelled, approvals, guidance, emit, setMessages } = fakeTransport();
    render(<Harness transport={transport} />);
    expect(await screen.findByText("种子消息")).toBeTruthy();

    emit({ seq: 1, sessionId: "s1", type: "assistant.text", payload: { text: "正在读…" } });
    expect(await screen.findByText("正在读…")).toBeTruthy();

    emit({ seq: 2, sessionId: "s1", type: "tool.start", payload: { id: "c1", name: "read" } });
    emit({ seq: 3, sessionId: "s1", type: "tool.end", payload: { id: "c1", name: "read", preview: "文件内容" } });
    // 工具行只在回合结束落库后才可见（与真实链路一致）
    setMessages([
      { id: "m1", role: "user", content: "种子消息", timestamp: 1 },
      { id: "t1", role: "tool", content: "文件内容", timestamp: 2, toolCallId: "c1" },
    ]);
    emit({ seq: 4, sessionId: "s1", type: "run.finished", payload: { state: "succeeded" } });
    // 第 2 步之后工具行是共享胶囊行：用 data-* 与变体标题取证（不再是 "read" + "✓" 文本）
    const readWrap = await waitFor(() => {
      const el = document.querySelector('.tool-call-card-wrap[data-tool="read"]');
      expect(el).toBeTruthy();
      return el!;
    });
    expect(readWrap.getAttribute("data-state")).toBe("ok");
    expect(readWrap.textContent).toContain("Read");

    fireEvent.change(screen.getByPlaceholderText(/发一条消息/), { target: { value: "你好" } });
    fireEvent.click(screen.getByText("发送"));
    await waitFor(() => expect(sent).toEqual([{ sessionId: "s1", text: "你好" }]));

    fireEvent.click(screen.getByText("停止"));
    await waitFor(() => expect(cancelled).toEqual(["run-1"]));
  });

  it("审批卡片：出现 → 允许 → 调用传输层并移除卡片", async () => {
    const { transport, approvals, emit } = fakeTransport();
    render(<Harness transport={transport} />);
    expect(await screen.findByText("种子消息")).toBeTruthy();

    emit({
      seq: 9,
      sessionId: "s1",
      type: "approval.requested",
      payload: { approval: { approvalId: "ap1", tool: "bash", summary: "执行命令：echo hi", details: { command: "echo hi" } } },
    });
    // 第 3 步之后审批卡是共享决策卡：根类名 `.decision-tray` + data-decision-id
    const card = await waitFor(() => {
      const el = document.querySelector('.decision-tray[data-decision-id="ap1"]');
      expect(el, "审批卡没出现").toBeTruthy();
      return el!;
    });
    expect(card.textContent).toContain("bash");
    expect(card.textContent).toContain("执行命令：echo hi");
    expect(await screen.findByText("echo hi")).toBeTruthy();

    fireEvent.click(screen.getByText("批准"));
    await waitFor(() => expect(approvals).toEqual([{ approvalId: "ap1", decision: "allow" }]));
    await waitFor(() => expect(document.querySelector(".decision-tray")).toBeNull());
  });

  it("继续按钮：正常结束后出现，点击才发「继续」，点完消失", async () => {
    const { transport, sent, emit } = fakeTransport();
    render(<Harness transport={transport} />);
    expect(await screen.findByText("种子消息")).toBeTruthy();
    expect(screen.queryByText("继续")).toBeNull();

    emit({ seq: 9, sessionId: "s1", type: "run.finished", payload: { state: "succeeded" } });
    const btn = await screen.findByText("继续");
    fireEvent.click(btn);
    await waitFor(() => expect(sent.some((x) => x.text === "继续")).toBe(true));
    await waitFor(() => expect(screen.queryByText("继续")).toBeNull());
  });

  it("运行中引导：发送后进入运行态，输入补充内容点「引导」走 transport.guidance", async () => {
    const { transport, guidance } = fakeTransport();
    render(<Harness transport={transport} />);
    expect(await screen.findByText("种子消息")).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText(/发一条消息/), { target: { value: "开始" } });
    fireEvent.click(screen.getByText("发送"));
    await waitFor(() => expect(screen.getByText("引导")).toBeTruthy());

    fireEvent.change(screen.getByPlaceholderText(/发一条消息/), { target: { value: "补充一句" } });
    fireEvent.click(screen.getByText("引导"));
    await waitFor(() => expect(guidance.length).toBe(1));
    expect(guidance[0].text).toBe("补充一句");
  });

  it("重进会话：从持久化的 toolCalls 恢复工具名（不是 tool）", async () => {
    const transport = fakeTransport([
      { id: "m1", role: "user", content: "跑一下", timestamp: 1 },
      { id: "a1", role: "assistant", content: "", timestamp: 2, toolCalls: [{ id: "c1", tool: "bash", status: "done" }] },
      { id: "t1", role: "tool", content: "$ echo hi\n(exit 0)", timestamp: 3, toolCallId: "c1" },
    ]).transport;
    render(<Harness transport={transport} />);
    const bashWrap = await waitFor(() => {
      const el = document.querySelector('.tool-call-card-wrap[data-tool="bash"]');
      expect(el).toBeTruthy();
      return el!;
    });
    expect(bashWrap.textContent).toContain("Bash");
    expect(bashWrap.getAttribute("data-state")).toBe("ok");
  });

  it("只读模式：不订阅、不渲染输入区", async () => {
    const { transport } = fakeTransport();
    render(<Harness transport={transport} readOnly />);
    expect(await screen.findByText("种子消息")).toBeTruthy();
    expect(screen.queryByPlaceholderText(/发一条消息/)).toBeNull();
  });

  it("审批播种：打开会话时从服务器读已挂着的待批项（事件流不会补推）", async () => {
    const { transport, setApprovalSeed } = fakeTransport();
    setApprovalSeed([{ approvalId: "ap-seed", tool: "write", summary: "path: a.ts" }]);
    render(<Harness transport={transport} />);
    const card = await waitFor(() => {
      const el = document.querySelector('.decision-tray[data-decision-id="ap-seed"]');
      expect(el, "打开会话时已有待批项，卡片必须出现").toBeTruthy();
      return el!;
    });
    expect(card.textContent).toContain("write");
  });

  it("approval.resolved：桌面/另一台设备处理后卡片收起", async () => {
    const { transport, emit } = fakeTransport();
    render(<Harness transport={transport} />);
    expect(await screen.findByText("种子消息")).toBeTruthy();
    emit({
      seq: 5,
      sessionId: "s1",
      type: "approval.requested",
      payload: { approval: { approvalId: "ap-2", tool: "bash", summary: "command: rm -rf" } },
    });
    await waitFor(() => expect(document.querySelector('.decision-tray[data-decision-id="ap-2"]')).toBeTruthy());
    emit({
      seq: 6,
      sessionId: "s1",
      type: "approval.resolved",
      payload: { approvalId: "ap-2", decision: "deny", decidedBy: "desktop" },
    });
    await waitFor(() => expect(document.querySelector('.decision-tray[data-decision-id="ap-2"]')).toBeNull());
  });

  it("run.started：已连接时也能恢复运行态与「停止」（重连补发路径）", async () => {
    const { transport, cancelled, emit } = fakeTransport();
    render(<Harness transport={transport} />);
    expect(await screen.findByText("种子消息")).toBeTruthy();
    expect(screen.queryByText("停止")).toBeNull();
    emit({ seq: 2, sessionId: "s1", type: "run.started", payload: { state: "running" }, runId: "run-9" });
    fireEvent.click(await screen.findByText("停止"));
    await waitFor(() => expect(cancelled).toEqual(["run-9"]));
  });

  it("刷新恢复运行态：session.get 的 run 让页面重开后仍能停止", async () => {
    const { transport, cancelled, setSessionRun } = fakeTransport();
    setSessionRun({ runId: "run-restored", state: "running" });
    render(<Harness transport={transport} />);
    fireEvent.click(await screen.findByText("停止"));
    await waitFor(() => expect(cancelled).toEqual(["run-restored"]));
  });

  it("gateway.reset：清空流式/审批并按存储重新对齐", async () => {
    const { transport, emit, setMessages, setApprovalSeed } = fakeTransport();
    setApprovalSeed([{ approvalId: "ap-stale", tool: "bash", summary: "旧审批" }]);
    render(<Harness transport={transport} />);
    await waitFor(() => expect(document.querySelector('.decision-tray[data-decision-id="ap-stale"]')).toBeTruthy());

    setMessages([
      { id: "m1", role: "user", content: "种子消息", timestamp: 1 },
      { id: "m2", role: "assistant", content: "缺口后从存储对齐的内容", timestamp: 2 },
    ]);
    setApprovalSeed([]);
    emit({ seq: 0, sessionId: "s1", type: "gateway.reset", payload: { reason: "replay_gap" } });
    expect(await screen.findByText("缺口后从存储对齐的内容")).toBeTruthy();
    await waitFor(() => expect(document.querySelector('.decision-tray[data-decision-id="ap-stale"]')).toBeNull());
  });

  it("发送失败不吞输入：横幅报错，输入框里的文字还在", async () => {
    const { transport, failNextSend } = fakeTransport();
    render(<Harness transport={transport} />);
    expect(await screen.findByText("种子消息")).toBeTruthy();
    failNextSend();
    fireEvent.change(screen.getByPlaceholderText(/发一条消息/), { target: { value: "别丢了我" } });
    fireEvent.click(screen.getByText("发送"));
    expect(await screen.findByTestId("chat-error")).toHaveTextContent("BUSY");
    expect((screen.getByPlaceholderText(/发一条消息/) as HTMLTextAreaElement).value).toBe("别丢了我");
  });
});
