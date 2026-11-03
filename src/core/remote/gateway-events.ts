/**
 * 网关**事件发布**（ADR-0005 M2）：把桌面循环事件按顺序交给 Rust 网关广播。
 *
 * ## 一条数据面，不双写
 *
 * 事件只有**一个**产生点：`executeSessionTurn` 的 `engine.process` 循环。本模块只做
 * 两件事：
 *   1. 把内部 `LoopEvent` 映射成协议事件（与 Host 的 `mapLoopEvent` 同名同形）；
 *   2. 用一个**串行队列**调用 `gateway_publish_event`，保证 `tool.start` 一定早于
 *      `tool.end`、终态一定最后到（每次 `invoke` 都是独立 IPC，不排队就会乱序）。
 *
 * 它不写会话日志、不写消息、不新起循环：`session_events` / `messages` 仍由
 * `executor` 写。手机看到的是同一次运行的实时投影。
 *
 * ## 为什么事件类型白名单只在 Rust 侧
 *
 * 事件会原样送到已配对设备，所以 Rust 的 `PUBLISHABLE_EVENT_TYPES` 是唯一闸门
 * （多一份 TS 清单 = 必然漂移）。这里只负责产出**已知**类型；如果映射写错，
 * Rust 会拒绝并且 `GatewayEventPublisher` 会把失败报出来（不静默）。
 *
 * ## 审批事件从哪来
 *
 * 审批不是循环事件，而是桌面审批代理（`approval-broker`）的状态变化：
 * `ApprovalEventTracker` 对比"上一次看到的待批表"和"现在"，产出
 * `approval.requested` / `approval.resolved`。手机答完、桌面答完、回合收口
 * （fail-closed）都会经过同一张表 ⇒ 一台设备处理，另一台立刻收起卡片。
 */
import {
  toGatewayApprovalItem,
  type GatewayApprovalView,
} from "./gateway-engine";

/** 发往 Rust 网关的一条事件（`gateway_publish_event` 的参数形状）。 */
export interface GatewayOutboundEvent {
  sessionId: string;
  type: string;
  payload: Record<string, unknown>;
  runId?: string;
}

/** 工具结果摘要上限（与 Host 事件流一致：手机不该为一次工具拉几百 KB）。 */
export const TOOL_PREVIEW_MAX_CHARS = 2000;

/** 工具入参里单个字符串的上限（写文件时 `content` 可能是整篇文件）。 */
const TOOL_ARG_STRING_MAX_CHARS = 2000;
/** 工具入参序列化后的总上限（超过就只保留可展示的短字段）。 */
const TOOL_ARGS_MAX_BYTES = 64 * 1024;

function clip(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

/**
 * 工具入参投影：只给手机**可展示**的摘要，不搬运整篇文件内容。
 *
 * 为什么必须在这里做（而不是等 Rust 拒绝）：一次 `write` 的 `input.content` 可能是
 * 几 MB；原样走 IPC + SSE 会拖慢整条链路，而且 Rust 的 256KB 保护会直接丢掉这条
 * `tool.start`（手机上少一张工具卡）。这里按"短字段原样、长字符串截断、深度/广度有界"
 * 生成摘要；真的还超大就只留 `path/file_path/command` 这类短字段并标记 truncated。
 */
function summarizeToolArgs(input: unknown): Record<string, unknown> {
  const clipValue = (value: unknown, depth: number): unknown => {
    if (typeof value === "string") return clip(value, TOOL_ARG_STRING_MAX_CHARS);
    if (value === null || typeof value !== "object") return value;
    if (depth >= 4) return "[truncated]";
    if (Array.isArray(value)) {
      return value.slice(0, 50).map((item) => clipValue(item, depth + 1));
    }
    const out: Record<string, unknown> = {};
    let count = 0;
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (++count > 64) {
        out["…"] = "[truncated]";
        break;
      }
      out[key] = clipValue(item, depth + 1);
    }
    return out;
  };
  try {
    const clipped = clipValue(input, 0);
    if (JSON.stringify(clipped).length <= TOOL_ARGS_MAX_BYTES) {
      return (clipped ?? {}) as Record<string, unknown>;
    }
    const source = (input ?? {}) as Record<string, unknown>;
    const brief: Record<string, unknown> = {};
    for (const key of ["path", "file_path", "command"]) {
      if (typeof source[key] === "string") brief[key] = clip(source[key] as string, 200);
    }
    return { ...brief, truncated: true, note: "参数过大，已省略" };
  } catch {
    // 循环引用/不可枚举等异常形态：不猜内容，交一个空摘要（卡片仍显示工具名）。
    return {};
  }
}

/** 循环事件的最小结构（避免把 `agentic-loop` 的巨大类型拖进网关层）。 */
export interface GatewayLoopEventLike {
  type: string;
  text?: string;
  toolCall?: { id?: string; name?: string; input?: unknown };
  result?: unknown;
  error?: unknown;
}

/**
 * `LoopEvent` → 协议事件。返回 `null` = 这一条不发给手机（迭代边界/心跳等）。
 *
 * 映射刻意与 Host 运行时同名同形（`assistant.text` / `tool.start` / `tool.end` /
 * `tool.error` / `assistant.reasoning`）：共享 UI 的 reducer 只有一份。
 */
export function mapLoopEventToGatewayEvent(
  event: GatewayLoopEventLike,
  ctx: { sessionId: string; runId: string },
): GatewayOutboundEvent | null {
  const runId = ctx.runId;
  switch (event.type) {
    case "text_delta": {
      const text = typeof event.text === "string" ? event.text : "";
      // 空 delta 没有信息量；手机端 append 空串也不会显示，别浪费一次 IPC。
      if (!text) return null;
      return { sessionId: ctx.sessionId, type: "assistant.text", payload: { text }, runId };
    }
    case "reasoning_delta": {
      const text = typeof event.text === "string" ? event.text : "";
      if (!text) return null;
      return { sessionId: ctx.sessionId, type: "assistant.reasoning", payload: { text }, runId };
    }
    case "tool_start": {
      const call = event.toolCall;
      if (!call) return null;
      return {
        sessionId: ctx.sessionId,
        type: "tool.start",
        payload: {
          ...(call.id ? { id: call.id } : {}),
          ...(call.name ? { name: call.name } : {}),
          // 入参只给摘要（写文件的整篇内容不进事件流），手机卡片仍能显示路径/命令。
          ...(call.input !== undefined ? { args: summarizeToolArgs(call.input) } : {}),
        },
        runId,
      };
    }
    case "tool_complete": {
      const call = event.toolCall;
      if (!call) return null;
      const result = event.result as { output?: unknown; isError?: unknown } | string | undefined;
      const preview =
        typeof result === "string"
          ? clip(result, TOOL_PREVIEW_MAX_CHARS)
          : typeof result?.output === "string"
            ? clip(result.output, TOOL_PREVIEW_MAX_CHARS)
            : "";
      return {
        sessionId: ctx.sessionId,
        type: "tool.end",
        payload: {
          ...(call.id ? { id: call.id } : {}),
          ...(call.name ? { name: call.name } : {}),
          preview,
          isError: Boolean(typeof result === "object" && result?.isError),
        },
        runId,
      };
    }
    case "tool_error": {
      const call = event.toolCall;
      if (!call) return null;
      return {
        sessionId: ctx.sessionId,
        type: "tool.error",
        payload: {
          ...(call.id ? { id: call.id } : {}),
          ...(call.name ? { name: call.name } : {}),
          error: String(event.error ?? "unknown"),
        },
        runId,
      };
    }
    default:
      return null;
  }
}

/**
 * **串行**事件发布器：保证发布顺序 = 产生顺序。
 *
 * 为什么必须串行：每次 `invoke("gateway_publish_event")` 是独立 IPC，Tauri 侧可能
 * 并发处理；`tool.end` 抢在 `tool.start` 前面到达会让手机永久显示"运行中"。
 *
 * 失败策略：**不吞**（第一次失败 `console.warn`，含方法名与原因），但也不阻断
 * 后续事件 —— 一次 IPC 抖动不该让整轮事件消失。`flush()` 供判据等待队列清空。
 */
export class GatewayEventPublisher {
  private chain: Promise<void> = Promise.resolve();
  private failed = 0;
  private reported = false;

  constructor(
    private readonly send: (event: GatewayOutboundEvent) => Promise<unknown>,
    private readonly warn: (message: string, error: unknown) => void = (message, error) =>
      console.warn(message, error),
  ) {}

  publish(event: GatewayOutboundEvent): void {
    if (!event.sessionId.trim() || !event.type.trim()) {
      this.warn("[gateway-events] 拒绝发布空 sessionId/type 的事件", event);
      return;
    }
    this.chain = this.chain.then(async () => {
      try {
        await this.send(event);
      } catch (e) {
        this.failed += 1;
        if (!this.reported) {
          this.reported = true;
          this.warn(
            `[gateway-events] 事件发布失败（${event.type}）；手机端可能看不到这一条`,
            e,
          );
        }
      }
    });
  }

  /** 等队列清空（判据/收尾用）。 */
  flush(): Promise<void> {
    return this.chain;
  }

  /** 失败计数（诊断用；成功不累计）。 */
  failureCount(): number {
    return this.failed;
  }
}

/**
 * 一次 run 的终态事件（**唯一**映射点）。
 *
 * `state` 用 `gateway-runs` 的终态词（`finished` / `failed` / `cancelled`）；
 * 线上事件名与载荷用协议词（`run.finished` + `succeeded` …）。取消过的 run
 * 必须落成 `cancelled`（而不是 failed），手机才知道"是你停的"。
 */
export function gatewayTerminalEvent(
  sessionId: string,
  runId: string,
  state: string,
  error?: string,
): GatewayOutboundEvent {
  const type =
    state === "cancelled" ? "run.cancelled" : state === "failed" ? "run.failed" : "run.finished";
  const wireState = state === "cancelled" ? "cancelled" : state === "failed" ? "failed" : "succeeded";
  return {
    sessionId,
    type,
    payload: { state: wireState, ...(error ? { error } : {}) },
    runId,
  };
}

interface TrackedApproval {
  open: boolean;
  decision?: "allow" | "deny";
  decidedBy?: string;
}

/**
 * 审批表 → 事件。**唯一**比较点：谁（手机/桌面/回合收尾）改了表，都会在这里
 * 变成 `approval.requested` / `approval.resolved`。
 */
export class ApprovalEventTracker {
  private readonly known = new Map<string, TrackedApproval>();

  /**
   * 对比当前表与上一次快照，产出事件。
   *
   * 首次调用会为"当前仍待批"的条目产出 `requested`（这是对的：手机接上时它们
   * 本来就该显示），但不会为历史已决定的条目补事件。
   */
  diff(views: GatewayApprovalView[]): GatewayOutboundEvent[] {
    const events: GatewayOutboundEvent[] = [];
    const seen = new Set<string>();
    for (const view of views) {
      seen.add(view.requestId);
      const open = view.status === "open";
      const previous = this.known.get(view.requestId);
      if (open && !previous) {
        events.push({
          sessionId: view.sessionId,
          type: "approval.requested",
          payload: { approval: toGatewayApprovalItem(view) },
        });
      } else if (previous?.open && !open) {
        events.push({
          sessionId: view.sessionId,
          type: "approval.resolved",
          payload: {
            approvalId: view.requestId,
            decision: view.decidedAction ?? "deny",
            decidedBy: view.decidedBy ?? "desktop",
          },
        });
      }
      this.known.set(view.requestId, {
        open,
        ...(view.decidedAction ? { decision: view.decidedAction } : {}),
        ...(view.decidedBy ? { decidedBy: view.decidedBy } : {}),
      });
    }
    // 防御性：待批条目从表里整个消失（正常不会发生：trim 只淘汰已决定项）。
    // 如实发一条拒绝，别让手机留一张永远点不动的卡片。
    for (const [requestId, previous] of this.known) {
      if (seen.has(requestId)) continue;
      if (previous.open) {
        events.push({
          sessionId: "",
          type: "approval.resolved",
          payload: { approvalId: requestId, decision: "deny", decidedBy: "desktop" },
        });
      }
      this.known.delete(requestId);
    }
    // 会话 ID 为空的事件发布器会拒绝（见 publish 的校验）；这里提前去掉，
    // 避免把一条无效事件送进队列（那只会在 Rust 侧报错，问题却在这里）。
    return events.filter((event) => event.sessionId.trim().length > 0);
  }
}
