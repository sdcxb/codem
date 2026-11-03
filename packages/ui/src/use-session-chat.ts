/**
 * **共享会话交互 hook**（阶段 2）：把"一个会话的完整交互"做成一份，供任何外壳复用。
 *
 * 桌面（local transport）与手机（remote transport）现在不只共用组件，连
 * "打开会话 → 订阅事件 → 收发 → 工具卡 → 收尾"这套行为也只有一份；
 * 布局（header/footer 怎么摆）留给外壳，hook 只给状态与动作。
 */
import { useEffect, useMemo, useRef, useState } from "react";

import type { HostEvent } from "./host-client";
import type { ApprovalItem } from "./components";
import { messageViews, type MessageRow, type MessageView, type ToolInfo } from "./session-view";
import type { Capabilities, SessionTransport } from "./transport";

export interface UseSessionChatOptions {
  transport: SessionTransport;
  sessionId: string;
  caps: Capabilities;
  /** 只读：不订阅事件、发送被拒绝（桌面预览用） */
  readOnly?: boolean;
  /** 自动化用：挂载后自动发送这段文本（只发一次） */
  autoSendText?: string;
  onRunState?: (state: string | null) => void;
}

export interface SessionChatState {
  views: MessageView[];
  streaming: string;
  runState: string | null;
  runId: string | null;
  error: string;
  approvals: ApprovalItem[];
  /** 上一轮正常结束后才为 true：给用户一个「继续」按钮（**不自动续跑**，合规要求） */
  canContinue: boolean;
  continueRun: () => Promise<void>;
  /** 运行中引导（steer）：把输入注入当前 run，不另起一轮 */
  guide: () => Promise<void>;
  canGuide: boolean;
  /** 已上传、待随下一条消息发送的附件 */
  attachments: Array<{ id: string; name: string }>;
  attach: (file: File) => Promise<void>;
  removeAttachment: (id: string) => void;
  attaching: boolean;
  canAttach: boolean;
  respondApproval: (approvalId: string, decision: "allow" | "deny") => Promise<void>;
  input: string;
  canSend: boolean;
  canCancel: boolean;
  setInput: (value: string) => void;
  send: (text?: string) => Promise<void>;
  cancel: () => Promise<void>;
}

export function useSessionChat(opts: UseSessionChatOptions): SessionChatState {
  const { transport, sessionId, caps, readOnly, autoSendText } = opts;
  const [rows, setRows] = useState<MessageRow[]>([]);
  const [tools, setTools] = useState<Record<string, ToolInfo>>({});
  const [streaming, setStreaming] = useState("");
  const [runState, setRunState] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [input, setInput] = useState(autoSendText ?? "");
  const [error, setError] = useState("");
  const [approvals, setApprovals] = useState<ApprovalItem[]>([]);
  const [attachments, setAttachments] = useState<Array<{ id: string; name: string }>>([]);
  const [attaching, setAttaching] = useState(false);
  const [canContinue, setCanContinue] = useState(false);
  const toolOrder = useRef<string[]>([]);
  const requestSeq = useRef(1);
  const autoSent = useRef(false);
  const onRunStateRef = useRef(opts.onRunState);
  onRunStateRef.current = opts.onRunState;

  const views = useMemo(() => messageViews(rows, tools), [rows, tools]);

  async function refresh(): Promise<void> {
    const got = await transport.getSession(sessionId);
    /**
     * 刷新后的运行态恢复（M2）：页面重开/事件流重连时，runId 只存在于上一次
     * 内存里。`session.get` 会带上"这个会话有没有网关发起、还在跑的 run"，
     * 有了它「停止」按钮才不是摆设。只在**确实在跑**时写入；已经结束的
     * 不覆盖（终态事件比这次快照更新）。
     */
    const run = (got as { run?: { runId?: string; state?: string } | null }).run;
    if (run && run.runId && run.state === "running") {
      setRunId(run.runId);
      setRunState("running");
    }
    // 工具行在库里没有 callId：按本轮事件顺序回填，卡片才显示得出 read/grep 名字
    const order = toolOrder.current.splice(0);
    const fromDb: Record<string, ToolInfo> = {};
    for (const m of got.messages) {
      const calls = (m as { toolCalls?: Array<{ id?: string; tool?: string; name?: string; status?: string; args?: unknown }> }).toolCalls;
      if (!Array.isArray(calls)) continue;
      for (const c of calls) {
        if (c?.id) fromDb[c.id] = { name: c.tool ?? c.name ?? "tool", status: c.status ?? "done", ...(c.args !== undefined ? { args: c.args } : {}) };
      }
    }
    if (Object.keys(fromDb).length > 0) setTools((prev) => ({ ...fromDb, ...prev }));
    setRows(
      got.messages.map((m) =>
        m.role === "tool"
          ? { ...m, toolCallId: (m as { toolCallId?: string }).toolCallId ?? order.shift() ?? null }
          : m,
      ),
    );
  }

  /**
   * 从服务器重新读待批项（页面打开、事件缺口、回合结束时都用它）。
   *
   * 事件流只推"变化"：页面打开时**已经挂着**的审批不会再有 requested 事件。
   * 读取失败不清空现有卡片（事件流可能仍在工作），但把错误如实显示出来。
   */
  async function reloadApprovals(): Promise<void> {
    if (readOnly || !transport.listApprovals) return;
    try {
      setApprovals(await transport.listApprovals());
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    }
  }

  function onEvent(event: HostEvent): void {
    switch (event.type) {
      case "run.started":
        /**
         * 重连后补发的 `run.started`：恢复"这个会话正在跑"。`runId` 以事件里的
         * 为准（发送应答与事件流可能来自两次连接）。
         */
        setRunState("running");
        if (typeof event.runId === "string" && event.runId) setRunId(event.runId);
        break;
      case "assistant.text":
        setStreaming((prev) => prev + String((event.payload as { text?: string })?.text ?? ""));
        break;
      case "tool.start": {
        const p = event.payload as { id?: string; name?: string; args?: unknown };
        if (p?.id) {
          toolOrder.current.push(p.id);
          setTools((m) => ({ ...m, [p.id!]: { name: p.name ?? "tool", status: "running", ...(p.args !== undefined ? { args: p.args } : {}) } }));
        }
        break;
      }
      case "tool.end": {
        const p = event.payload as { id?: string; name?: string; preview?: string };
        if (p?.id)
          setTools((m) => ({
            ...m,
            [p.id!]: { name: p.name ?? m[p.id!]?.name ?? "tool", status: "done", output: p.preview ?? "" },
          }));
        break;
      }
      case "approval.requested": {
        const a = (event.payload as { approval?: { approvalId?: string; tool?: string; summary?: string; details?: Record<string, unknown> } })?.approval;
        if (a?.approvalId) {
          setApprovals((prev) =>
            prev.some((x) => x.approvalId === a.approvalId)
              ? prev
              : [...prev, { approvalId: a.approvalId!, tool: a.tool ?? "tool", summary: a.summary ?? "", ...(a.details ? { details: a.details } : {}) }],
          );
        }
        break;
      }
      case "approval.resolved": {
        /**
         * 桌面/另一台设备/回合收尾处理了这条审批：卡片必须收起。
         * 没有这一条时，手机上的"批准"按钮会点出一个 `NOT_PENDING` 错误。
         */
        const id = (event.payload as { approvalId?: string })?.approvalId;
        if (id) setApprovals((prev) => prev.filter((x) => x.approvalId !== id));
        break;
      }
      case "gateway.reset": {
        /**
         * 事件缺口/网关换代：Rust 已经无法保证补发完整，界面按"重新对齐"处理。
         *
         * 不做增量猜测：清掉流式正文与待批卡片，从桌面存储重读消息与待批表。
         * 正文由 `refresh()` 里已落库的 assistant 行承载（重放正文会让它重复）。
         */
        setStreaming("");
        setApprovals([]);
        setCanContinue(false);
        void refresh().catch((e) => setError(String((e as Error)?.message ?? e)));
        void reloadApprovals();
        break;
      }
      case "run.finished":
      case "run.failed":
      case "run.cancelled": {
        const state =
          event.type === "run.finished"
            ? String((event.payload as { state?: string })?.state ?? "succeeded")
            : event.type === "run.failed"
              ? "failed"
              : "cancelled";
        setRunState(state);
        setStreaming("");
        // 运行结束 ⇒ Host 已拒绝所有挂起审批（runtime.clearApprovalsForRun），界面也要同步清掉
        setApprovals([]);
        // 合规要求（AGENTS.md §5.9）：**不自动续跑**，只给一个「继续」按钮，用户点才发下一轮
        setCanContinue(state === "succeeded");
        void refresh().catch((e) => setError(String((e as Error)?.message ?? e)));
        // 事件只推变化；终态后重读一次，避免"审批卡片残留"（例如 resolved 事件丢失）。
        void reloadApprovals();
        break;
      }
      default:
        break;
    }
  }

  useEffect(() => {
    setRows([]);
    setStreaming("");
    setTools({});
    setApprovals([]);
    toolOrder.current = [];
    void refresh().catch((e) => setError(String((e as Error)?.message ?? e)));
    if (readOnly) return;
    // 页面打开时可能已经有待批项（事件流不会补推"已存在"的审批）。
    void reloadApprovals();
    return transport.subscribe(sessionId, onEvent);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transport, sessionId, readOnly]);

  useEffect(() => {
    onRunStateRef.current?.(runState);
  }, [runState]);

  async function send(textArg?: string): Promise<void> {
    const text = (textArg ?? input).trim();
    if (!text || readOnly) return;
    setCanContinue(false);
    setInput("");
    setError("");
    try {
      const accepted = await transport.send(sessionId, text, `chat-${Date.now()}-${requestSeq.current++}`, attachments.map((a) => a.id));
      setAttachments([]);
      setRunId(accepted.runId);
      setRunState("running");
    } catch (e) {
      /**
       * 发送失败**不能把用户输入吞掉**（原来清空后只在横幅报错，用户得重打一遍）。
       * 运行态也不在这里改：上一次 run 可能还在跑（`BUSY` 就是那种情形）。
       */
      setInput(text);
      setError(String((e as Error)?.message ?? e));
    }
  }

  async function attach(file: File): Promise<void> {
    if (!transport.putAttachment || !caps.attachments || readOnly) {
      setError("当前连接不支持附件");
      return;
    }
    setAttaching(true);
    setError("");
    try {
      const buf = await file.arrayBuffer();
      let binary = "";
      const bytes = new Uint8Array(buf);
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      const got = await transport.putAttachment(file.name, file.type || "application/octet-stream", btoa(binary));
      setAttachments((prev) => [...prev, { id: got.attachmentId, name: file.name }]);
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setAttaching(false);
    }
  }

  function removeAttachment(id: string): void {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }

  async function guide(): Promise<void> {
    const text = input.trim();
    if (!text || !runId || runState !== "running" || !transport.guidance) return;
    setError("");
    try {
      await transport.guidance(runId, text);
      setInput("");
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    }
  }

  async function continueRun(): Promise<void> {
    if (!canContinue || readOnly) return;
    await send("继续");
  }

  async function respondApproval(approvalId: string, decision: "allow" | "deny"): Promise<void> {
    const target = approvals.find((a) => a.approvalId === approvalId);
    if (!target) return;
    setError("");
    try {
      if (!transport.respondApproval) throw new Error("当前传输不支持审批（只读/本地模式）");
      await transport.respondApproval(approvalId, decision, `approval-${Date.now()}`);
      setApprovals((prev) => prev.filter((a) => a.approvalId !== approvalId));
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
      // `approval_not_pending` = 另一台设备/回合收尾已经处理了它：重读一次，
      // 让卡片回到界面的真实状态（而不是留一个永远点不动的按钮）。
      void reloadApprovals();
    }
  }

  async function cancel(): Promise<void> {
    if (!runId || !caps.cancelRun || readOnly) return;
    try {
      await transport.cancel(runId, `cancel-${Date.now()}`);
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    }
  }

  useEffect(() => {
    if (!autoSendText || autoSent.current) return;
    autoSent.current = true;
    const timer = setTimeout(() => void send(autoSendText), 400);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSendText, sessionId]);

  return {
    views,
    streaming,
    runState,
    runId,
    error,
    approvals,
    canContinue,
    continueRun,
    guide,
    attachments,
    attach,
    removeAttachment,
    attaching,
    canAttach: caps.attachments && Boolean(transport.putAttachment),
    canGuide: runState === "running" && Boolean(transport.guidance),
    respondApproval,
    input,
    canSend: Boolean(input.trim()) && !readOnly,
    canCancel: runState === "running" && Boolean(runId) && caps.cancelRun && !readOnly,
    setInput,
    send,
    cancel,
  };
}
