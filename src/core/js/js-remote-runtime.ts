/**
 * **Rust 侧 JS 沙箱的前端适配层**：把 guest 的工具调用接到 TS 的 SDK 实现上。
 *
 * ## 为什么是这个形状（第 103 波）
 *
 * 执行在 Rust（`src-tauri/src/js_sandbox.rs` 的 `js_run_sandboxed`），因为那里宿主调用可以**阻塞** ——
 * guest 看到的是同步函数，不需要 WebView 侧那套 asyncify 挂起机制
 * （那套一次执行只能挂起一次：2 次工具调用 0/5 成功，交接单 §16.3）。
 *
 * **闸门仍然只有一份**：危险命令分析、受保护路径、覆盖确认、沙箱路径判定全在 TS 侧，
 * Rust 只做"发事件 → 等回复"。所以这里不是"第二套 SDK"，而是**同一个 sdk 对象**换个执行前端。
 *
 * 协议：
 * ```
 *   Rust:  emit("jsvm://host-call", { id, name, args })   // args 是参数数组的 JSON
 *   前端:  methods[name](JSON.parse(args)) → 结果
 *   前端:  invoke("jsvm_host_reply", { reply: { id, result } })   // 或 { id, error }
 *   Rust:  阻塞等这条回复，把 result 当字符串交回 guest（guest 侧 `__sdk` 再 JSON.parse）
 * ```
 */
import type { ToolSDK } from "../llm/tools/run-code";

/** 宿主方法的统一签名（参数数组进、任意可 JSON 化值出；抛错即"调用失败"） */
export type RemoteHostMethod = (args: unknown[]) => unknown | Promise<unknown>;

export interface RustSandboxOptions {
  code: string;
  /** 暴露给 guest 的方法（键名就是 guest 里 `sdk.<name>`） */
  methods: Record<string, RemoteHostMethod>;
  /** 循环迭代上限（默认交给 Rust：100 万） */
  loopLimit?: number;
  /** 一次执行里最多几次工具调用（默认交给 Rust：200） */
  hostCallLimit?: number;
}

export interface RustSandboxOutcome {
  ok: boolean;
  /** 完成值（JSON 文本，可能为 null） */
  value?: string | null;
  /** 错误（JSON 文本：`{"message":...}`） */
  error?: string | null;
  stdout: string;
  stderr: string;
  budgetExceeded: boolean;
  hostCalls: number;
}

interface TauriGlobal {
  core?: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> };
  event?: {
    listen: (
      name: string,
      handler: (event: { payload: unknown }) => void,
    ) => Promise<() => void>;
  };
}

function tauri(): TauriGlobal | null {
  const api = (globalThis as unknown as { __TAURI__?: TauriGlobal }).__TAURI__;
  return api?.core?.invoke ? api : null;
}

/** 出错时给一句能看懂的话（并说明这是环境问题，不是用户代码问题） */
function tauriUnavailable(): RustSandboxOutcome {
  return {
    ok: false,
    error: JSON.stringify({
      message: "JS 沙箱不可用：这个环境没有 Tauri 运行时（run_code 需要在应用里跑）",
    }),
    stdout: "",
    stderr: "",
    budgetExceeded: false,
    hostCalls: 0,
  };
}

/**
 * 当前注册的宿主方法表。
 *
 * 用"当前表"而不是把表塞进事件里：事件只带方法名，前端按名查这张表。
 * 并发执行（两次 run_code 同时在跑）时以**最后一次注册**为准 —— 实例上不会发生
 * （工具调用是串行的），但这里显式写下来，免得以后有人以为它是 per-run 隔离的。
 */
let currentMethods: Record<string, RemoteHostMethod> = {};
let listenerReady: Promise<void> | null = null;
let listenerDispose: (() => void) | null = null;

/** 注册一次性的宿主调用监听（幂等） */
async function ensureHostCallListener(): Promise<void> {
  if (listenerReady) return listenerReady;
  listenerReady = (async () => {
    const api = tauri();
    if (!api?.event?.listen) return; // 非 Tauri 环境：由调用方给出可读错误
    listenerDispose = await api.event.listen("jsvm://host-call", (event) => {
      const payload = event?.payload as { id: number; name: string; args: string } | undefined;
      if (!payload || typeof payload.id !== "number") return;
      void handleHostCall(payload);
    });
  })();
  return listenerReady;
}

/** 处理一次来自 Rust 的工具调用请求：执行 → 回复（成功/失败二选一） */
async function handleHostCall(payload: {
  id: number;
  name: string;
  args: string;
  session_id?: number | null;
}): Promise<void> {
  const api = tauri();
  if (!api?.core?.invoke) return;
  const sessionId = payload.session_id ?? null;
  let replyArgs: Record<string, unknown>;
  try {
    let result: unknown;
    if (sessionId !== null) {
      /**
       * 会话形态（动态插件）：分两类。
       *  · `__provide` —— guest 的 `ctx.provide(name, service)`；交给调用方建服务代理；
       *  · 其它 —— 调用方的 `onCall`。
       * 回调 guest 函数（服务代理）走的是 `js_sandbox_call_function` 命令，**不经过**这里，
       * 所以不存在"host → guest → host"的环。
       */
      const handlers = sessionHandlers.get(sessionId);
      if (payload.name === "__provide") {
        const descriptor = JSON.parse(payload.args || "{}") as ProvidedServiceDescriptor;
        result = handlers?.onProvide ? await handlers.onProvide(descriptor) : { ok: true };
      } else if (handlers?.onCall) {
        const parsed = payload.args ? (JSON.parse(payload.args) as unknown[]) : [];
        result = await handlers.onCall(payload.name, Array.isArray(parsed) ? parsed : [parsed]);
      } else {
        throw new Error(`会话 ${sessionId} 没有提供工具 ${payload.name}`);
      }
    } else {
      const method = currentMethods[payload.name];
      if (!method) throw new Error(`运行时没有提供工具 ${payload.name}`);
      const parsed = payload.args ? (JSON.parse(payload.args) as unknown[]) : [];
      result = await method(Array.isArray(parsed) ? parsed : [parsed]);
    }
    replyArgs = { reply: { id: payload.id, result: JSON.stringify(result ?? null) } };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    replyArgs = { reply: { id: payload.id, error: message } };
  }
  try {
    await api.core.invoke("jsvm_host_reply", replyArgs);
  } catch (error) {
    // 回复失败（例如已超时清理）：只能记一条，不能抛（抛了会变成未捕获的 rejection）
    console.warn("[js-remote-runtime] 回复工具调用失败：", error);
  }
}

/** 执行一段脚本（在 Rust 侧引擎里；宿主调用回到这里的 `methods`） */
export async function runSandboxedInRust(options: RustSandboxOptions): Promise<RustSandboxOutcome> {
  const api = tauri();
  if (!api?.core?.invoke) return tauriUnavailable();
  await ensureHostCallListener();
  currentMethods = options.methods;

  const raw = (await api.core.invoke("js_run_sandboxed", {
    code: options.code,
    methods: Object.keys(options.methods),
    loopLimit: options.loopLimit ?? null,
    hostCallLimit: options.hostCallLimit ?? null,
  })) as Partial<RustSandboxOutcome> | undefined;

  return {
    ok: Boolean(raw?.ok),
    value: raw?.value ?? null,
    error: raw?.error ?? null,
    stdout: String(raw?.stdout ?? ""),
    stderr: String(raw?.stderr ?? ""),
    budgetExceeded: Boolean(raw?.budgetExceeded),
    hostCalls: Number(raw?.hostCalls ?? 0),
  };
}

/** 测试用：清掉监听状态（也让"非 Tauri 环境"的判据可重复运行） */
export function __resetJsRemoteRuntimeForTests(): void {
  listenerReady = null;
  currentMethods = {};
  sessionHandlers.clear();
  if (listenerDispose) {
    try {
      listenerDispose();
    } catch {
      /* ignore */
    }
    listenerDispose = null;
  }
}

// =====================================================================================
// 会话形态（动态插件用）：持久环境 + 宿主回调 guest 函数
// =====================================================================================

/** `ctx.provide(name, service)` 到达前端时的描述符 */
export interface ProvidedServiceDescriptor {
  name: string;
  /** 函数属性名 → guest 里的 handle（宿主用 `callSandboxFunction` 回调） */
  functions: Record<string, number>;
  /** 非函数属性（JSON 快照） */
  data: Record<string, unknown>;
}

export interface SandboxSessionHandlers {
  /** guest 调 `ctx.provide(...)`；调用方通常据此建"服务代理" */
  onProvide?: (descriptor: ProvidedServiceDescriptor) => unknown | Promise<unknown>;
  /** 其它宿主调用 */
  onCall?: (name: string, args: unknown[]) => unknown | Promise<unknown>;
}

/** 每个会话自己的处理器（事件里带 `session_id`，据此路由） */
const sessionHandlers = new Map<number, SandboxSessionHandlers>();

/** 解析 invoke 返回的 JSON 文本（Rust 侧统一回字符串） */
function parseJsonText(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** 打开一个沙箱会话（跑插件代码）；返回会话 id */
export async function openSandboxSession(options: {
  code: string;
  loopLimit?: number;
} & SandboxSessionHandlers): Promise<number> {
  const api = tauri();
  if (!api?.core?.invoke) throw new Error("JS 沙箱不可用：这个环境没有 Tauri 运行时");
  await ensureHostCallListener();
  const raw = (await api.core.invoke("js_sandbox_open", {
    code: options.code,
    loopLimit: options.loopLimit ?? null,
  })) as number;
  const sessionId = Number(raw);
  sessionHandlers.set(sessionId, { onProvide: options.onProvide, onCall: options.onCall });
  return sessionId;
}

/** 在会话里求值（给插件工厂/实例方法用）；返回解析后的值 */
export async function evalInSandboxSession(sessionId: number, expression: string): Promise<unknown> {
  const api = tauri();
  if (!api?.core?.invoke) throw new Error("JS 沙箱不可用：这个环境没有 Tauri 运行时");
  const raw = await api.core.invoke("js_sandbox_eval", { sessionId, expression });
  return parseJsonText(raw);
}

/** **回调 guest 的函数**（服务代理走这里）；返回解析后的值 */
export async function callSandboxFunction(sessionId: number, handle: number, args: unknown[]): Promise<unknown> {
  const api = tauri();
  if (!api?.core?.invoke) throw new Error("JS 沙箱不可用：这个环境没有 Tauri 运行时");
  const raw = await api.core.invoke("js_sandbox_call_function", {
    sessionId,
    handle,
    argsJson: JSON.stringify(args ?? []),
  });
  return parseJsonText(raw);
}

/** 关闭会话（插件被 retract 时）；返回是否真的关掉了一个 */
export async function closeSandboxSession(sessionId: number): Promise<boolean> {
  const api = tauri();
  sessionHandlers.delete(sessionId);
  if (!api?.core?.invoke) return false;
  try {
    return Boolean(await api.core.invoke("js_sandbox_close", { sessionId }));
  } catch (error) {
    console.warn("[js-remote-runtime] 关闭沙箱会话失败：", error);
    return false;
  }
}

/**
 * 从 `ToolSDK` 造出宿主方法表（`run_code` / `workflow` 共用）。
 *
 * ## 为什么这里返回的是"**已经变换过的**"值
 *
 * guest 侧 `sdk.read(p)` 的既有契约是"**返回文件内容字符串**"，而 `ToolSDK.read` 也正好返回字符串 ——
 * 所以宿主方法直接把 `sdk.read(...)` 的结果交回去即可，不需要再在 guest 里做一层
 * "取 `.content`" 的形状变换。这样**不引入 prelude**（少一段注入 JS，少一个出错面），
 * 而且与旧实现给模型的观感逐字一致。
 */
export function hostMethodsFromToolSdk(sdk: ToolSDK): Record<string, RemoteHostMethod> {
  return {
    bash: (args) => sdk.bash(String(args[0] ?? ""), (args[1] as { timeout_ms?: number }) ?? undefined),
    read: (args) => sdk.read(String(args[0] ?? "")),
    write: async (args) => {
      await sdk.write(String(args[0] ?? ""), String(args[1] ?? ""));
      return true;
    },
    glob: (args) => sdk.glob(String(args[0] ?? ""), args[1] as string | undefined),
    grep: (args) => sdk.grep(String(args[0] ?? ""), (args[1] as { path?: string; glob?: string }) ?? undefined),
    fetch: (args) => sdk.fetch(String(args[0] ?? "")),
  };
}

export type { ToolSDK };
