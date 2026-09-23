/**
 * 渲染侧崩溃取证 —— 心跳 + 全局异常 + 卸载留痕（第 71 轮）
 *
 * ## 为什么需要它（真机事故）
 *
 * 用户报：主对话里 agent 调 `wait_for_delegation` 后十几秒，**窗口还在，但页面白屏 /
 * 显示「页面已崩溃」**。事后查遍本机：
 * `codem-crash.log` 不存在（那是 Rust panic 写的）、运行时日志没有异常、
 * Windows 事件日志里没有 codem.exe 的崩溃记录、`EBWebView\Crashpad\reports` 是空的。
 * ——**"页面崩了"这件事当时完全不可归因**。
 *
 * 这个模块补的是"人还在的时候留下的水位"：
 *
 * | 证据 | 想回答的问题 |
 * | --- | --- |
 * | 每 20 秒一次心跳（JS 堆 + DOM 节点数 + 在跑的回合数） | 渲染进程是不是**涨死的**？死前涨到多少 |
 * | Rust 侧在同一行附上**进程树内存**（宿主 + 所有 `msedgewebview2.exe`） | JS 堆看不见的 WASM / 解码图像那部分涨没涨 |
 * | `window.onerror` / `unhandledrejection` | 崩溃前有没有先出错（打包版里这些原本只进控制台，用户看不见） |
 * | `pagehide` / `beforeunload` | 页面是**被卸载**（刷新/关窗）还是**直接消失**（崩溃） |
 *
 * 配合 Rust 侧 `ProcessFailed` 监听（`src-tauri/src/crash_evidence.rs`），
 * 下一次"白屏"会留下：**哪个进程死了 / 什么原因 / 退出码 / 出错模块 / 死前内存水位**。
 *
 * ## 诚实交代的边界
 *
 * - 心跳是**定时**的：崩得太快（比如几秒内爆掉）可能只有上一条心跳可看 —— 但它至少
 *   给出了基线，比"什么都没有"强得多；
 * - `performance.memory` 只有 Chromium 系有（本应用正是 WebView2，故可用）；
 *   拿不到时**如实写 `heap=?`**，不编造数字；
 * - 心跳只在有 Tauri 宿主时发（浏览器预览/测试环境静默跳过，不报错）。
 */

/** 默认心跳间隔。20 秒：一次会话 8 小时约 1440 行（每行 ~150 字节，可忽略） */
export const HEARTBEAT_INTERVAL_MS = 20_000;

/** 心跳采样（纯函数，便于单测与突变验证） */
export interface RendererSample {
  /** JS 已用堆（MB），取不到时为 null */
  heapUsedMB: number | null;
  /** JS 堆上限（MB），取不到时为 null */
  heapLimitMB: number | null;
  /** DOM 节点数 */
  domNodes: number;
  /** 页面上渲染出来的消息气泡数（界面规模的粗代理） */
  messageBubbles: number;
  /** 是否正有一轮在跑（有停止按钮 / 流式光标） */
  turnRunning: boolean;
  /** 页面已存活秒数（能区分"刚启动就崩"与"跑了两小时才崩"） */
  uptimeSec: number;
}

interface MemoryInfo {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
}

function readMemory(): MemoryInfo | null {
  const m = (performance as unknown as { memory?: MemoryInfo }).memory;
  if (!m || typeof m.usedJSHeapSize !== "number") return null;
  return m;
}

const MB = (bytes: number) => Math.round((bytes / (1024 * 1024)) * 10) / 10;

/** 采集一次样本。任何一步拿不到都如实记为 `?`，绝不编造数字。 */
export function collectSample(now = Date.now()): RendererSample {
  const mem = readMemory();
  let domNodes = -1;
  let messageBubbles = -1;
  let turnRunning = false;
  try {
    domNodes = document.getElementsByTagName("*").length;
    messageBubbles = document.querySelectorAll(".message").length;
    turnRunning = !!document.querySelector(".stop-button, .btn-stop, .streaming-cursor");
  } catch {
    /* 极端情况下（页面已在销毁）取不到就算了，保持 -1 */
  }
  return {
    heapUsedMB: mem ? MB(mem.usedJSHeapSize) : null,
    heapLimitMB: mem ? MB(mem.jsHeapSizeLimit) : null,
    domNodes,
    messageBubbles,
    turnRunning,
    uptimeSec: Math.round((now - startedAt) / 1000),
  };
}

/** 一行可读文本（写进运行时日志的就是它 —— 纯函数，单测逐字段钉住） */
export function formatSample(s: RendererSample): string {
  const heap =
    s.heapUsedMB === null || s.heapLimitMB === null
      ? "heap=?"
      : `heap=${s.heapUsedMB}/${s.heapLimitMB}MB`;
  return (
    `${heap} dom=${s.domNodes < 0 ? "?" : s.domNodes}` +
    ` msgs=${s.messageBubbles < 0 ? "?" : s.messageBubbles}` +
    ` turn=${s.turnRunning ? "running" : "idle"}` +
    ` uptime=${s.uptimeSec}s`
  );
}

interface TauriInvoke {
  invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
}

function invoke(cmd: string, args: Record<string, unknown>): void {
  const api = (globalThis as unknown as { __TAURI__?: { core?: TauriInvoke } }).__TAURI__;
  const fn = api?.core?.invoke;
  if (typeof fn !== "function") return; // 浏览器预览 / 单测：静默跳过
  try {
    // 心跳是"尽力而为"的：宿主没起来 / IPC 忙，都不能反过来影响应用
    void Promise.resolve(fn(cmd, args)).catch(() => {});
  } catch {
    /* 同上 */
  }
}

async function invokeAsync(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
  const api = (globalThis as unknown as { __TAURI__?: { core?: TauriInvoke } }).__TAURI__;
  const fn = api?.core?.invoke;
  if (typeof fn !== "function") return null;
  try {
    return await fn(cmd, args);
  } catch {
    return null;
  }
}

// ========== 崩溃标记：让"白屏一闪、自己恢复了"对用户可见 ==========

/** Rust 侧落盘的崩溃标记（`renderer-crash.json`，前端读完即删） */
export interface RendererCrashRecord {
  at?: number;
  kind: string;
  reason: string;
  exitCode: number;
  process?: string;
  module?: string;
  memory?: string;
}

/**
 * 解析崩溃标记。**任何缺字段都不编造**：缺的一律留空，解析不了就返回 null
 * （宁可不弹提示，也不许弹一条自己编的"原因"）。
 */
export function parseRendererCrashRecord(raw: string | null): RendererCrashRecord | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const r = parsed as Record<string, unknown>;
  const kind = typeof r.kind === "string" ? r.kind : "";
  const reason = typeof r.reason === "string" ? r.reason : "";
  if (!kind && !reason) return null;
  return {
    at: typeof r.at === "number" ? r.at : undefined,
    kind,
    reason,
    exitCode: typeof r.exitCode === "number" ? r.exitCode : 0,
    process: typeof r.process === "string" ? r.process : undefined,
    module: typeof r.module === "string" ? r.module : undefined,
    memory: typeof r.memory === "string" ? r.memory : undefined,
  };
}

/** 给用户看的提示文本（带上可转述给开发者的判据字段） */
export function formatRendererCrashMessage(record: RendererCrashRecord): string {
  const when = record.at ? new Date(record.at).toLocaleString() : "刚刚";
  return (
    `检测到界面渲染进程崩溃（${when}），已自动重载恢复；会话数据都在本地数据库里，不受影响。\n` +
    `判据（反馈问题时请附上这一行）：kind=${record.kind} reason=${record.reason} exit_code=${record.exitCode}` +
    (record.module ? ` module=${record.module}` : "") +
    (record.memory ? ` | ${record.memory}` : "")
  );
}

/**
 * 启动时检查"上次渲染进程崩溃"标记并上报（读完即删，只报一次）。
 *
 * @param report 上报回调（App 传 `addPersistAlert` 之类；**注入**而不是在这里 import store，
 *               否则这个诊断模块会把整个应用商店拖进依赖图）
 */
export async function reportRendererCrashIfAny(
  report: (message: string, record: RendererCrashRecord) => void,
): Promise<RendererCrashRecord | null> {
  const raw = await invokeAsync("take_renderer_crash_marker");
  const record = parseRendererCrashRecord(typeof raw === "string" ? raw : null);
  if (!record) return null;
  try {
    report(formatRendererCrashMessage(record), record);
  } catch {
    /* 上报失败不影响启动 */
  }
  return record;
}

let startedAt = Date.now();
let timer: ReturnType<typeof setInterval> | null = null;
let installed = false;

/**
 * 已挂上的监听器 —— 卸载时要逐个摘掉。
 *
 * ⚠️ 为什么必须记着它们（第一次写就踩了）：`installed` 只防"同一次启动里装两遍"，
 * 一旦外部把状态重置（测试的 `__resetRendererEvidence`、将来可能的"重装取证"），
 * 老监听器还挂在 window 上 —— 于是一条异常会被上报**多次**，日志里同一件事出现 N 行，
 * 而"重复上报"看起来又很像"真的出了 N 次错"。测试里这一点是当场爆出来的（6 条而不是 2 条）。
 */
let listeners: Array<[string, EventListener]> = [];

/** 摘掉全部监听器与定时器（幂等） */
function teardown(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
  for (const [type, fn] of listeners) window.removeEventListener(type, fn);
  listeners = [];
}

/** 供测试重置内部状态（生产路径不该调它） */
export function __resetRendererEvidence(): void {
  teardown();
  installed = false;
  startedAt = Date.now();
}

/**
 * 装上全部渲染侧取证。**幂等**：重复调用不会挂两个定时器 / 两层监听。
 *
 * 由 `App.tsx` 在启动时调用一次。
 */
export function installRendererEvidence(intervalMs = HEARTBEAT_INTERVAL_MS): void {
  if (installed) return;
  installed = true;
  startedAt = Date.now();

  /** 挂监听并记账（卸载时能摘干净） */
  const on = (type: string, fn: EventListener) => {
    window.addEventListener(type, fn);
    listeners.push([type, fn]);
  };

  // ① 心跳：把"死前水位"留在磁盘上
  const beat = () => {
    const sample = collectSample();
    invoke("log_renderer_heartbeat", { sample: formatSample(sample) });
  };
  beat();
  timer = setInterval(beat, intervalMs);

  // ② 全局异常：打包版里这些原本只进控制台（用户看不到）
  on("error", (e) => {
    const ev = e as ErrorEvent;
    const where = ev.filename ? `${ev.filename}:${ev.lineno}:${ev.colno}` : "unknown";
    invoke("log_renderer_event", {
      level: "ERROR",
      message: `window.onerror ${ev.message} @ ${where} | ${formatSample(collectSample())}`,
    });
  });
  on("unhandledrejection", (e) => {
    const reason = (e as PromiseRejectionEvent).reason;
    const text = reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason);
    invoke("log_renderer_event", {
      level: "ERROR",
      message: `unhandledrejection ${text} | ${formatSample(collectSample())}`,
    });
  });

  // ③ 卸载：区分"页面被卸载"（刷新/关窗，正常）与"页面直接消失"（崩溃，没有这一行）
  on("pagehide", () => {
    invoke("log_renderer_event", {
      level: "INFO",
      message: `pagehide | ${formatSample(collectSample())}`,
    });
  });
  on("beforeunload", () => {
    invoke("log_renderer_event", {
      level: "INFO",
      message: `beforeunload | ${formatSample(collectSample())}`,
    });
  });
}
