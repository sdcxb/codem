/**
 * 启动时序的真实打点（第 233 轮审计 · 冷启动收尾）。
 *
 * ## 为什么需要它
 *
 * 我们改了两处启动时序（材质探测最多阻塞 60ms、启动屏就绪即放行点击），
 * 但 `tsc`/vitest/`vite build` **都证明不了**"用户到底等了多久"：
 * 它们要么在 jsdom 里跑（没有真实 paint），要么只量产物体积。
 * 这一条打点让「首帧 / FCP / 就绪」三个时刻**落到磁盘**，装机后可以直接核对。
 *
 * ## 为什么落到 runtime 日志（而不是 console / localStorage）
 *
 * 仓库已有渲染侧落盘通道：`invoke("log_renderer_event", { level, message })`
 * （`src-tauri/src/crash_evidence.rs` → `runtime_log.rs`，写入
 * `%APPDATA%\com.codem.app\codem-runtime-YYYY-MM-DD.log`，前缀 `renderer `）。
 * 复用它有三点好处：不新增 Rust 命令、不改产品行为、日志**可留存**（console 一退出就没了，
 * localStorage 不是明文取证格式）。
 *
 * ## 纪律
 *
 * - **一次**：`phase` 从非 ready 变成 ready 时发一次，重复渲染不重复发。
 * - **不阻塞**：`invoke` 是异步且不 await，双 `requestAnimationFrame` 之后才读 paint 条目
 *   （首帧已经画完，读数才是真的）。
 * - **不造数**：拿不到的指标写 `n/a`，绝不补 0。
 */
export interface BootTimings {
  /** 首个 paint 条目（通常是背景色） */
  firstPaint: number | null;
  /** 首次内容绘制（我们的启动屏） */
  fcp: number | null;
  /** 打点时刻（ready 之后两帧） */
  ready: number;
  /** `performance.timeOrigin`（用于与进程启动时间对齐） */
  origin: number;
}

/** 读真实 paint 条目；没有就返回 null（不猜） */
export function readBootTimings(): BootTimings {
  let firstPaint: number | null = null;
  let fcp: number | null = null;
  try {
    for (const entry of performance.getEntriesByType("paint") as PerformanceEntry[]) {
      if (entry.name === "first-paint") firstPaint = entry.startTime;
      if (entry.name === "first-contentful-paint") fcp = entry.startTime;
    }
  } catch {
    // 老 WebView 没有 paint timing：留 null
  }
  return {
    firstPaint,
    fcp,
    ready: performance.now(),
    origin: Math.round(performance.timeOrigin),
  };
}

/** 把一条打点格式化成单行（同时便于判据断言与 grep） */
export function formatBootTimings(t: BootTimings): string {
  const num = (v: number | null, digits = 1) => (v === null ? "n/a" : v.toFixed(digits));
  return (
    `boot first-paint=${num(t.firstPaint)}` +
    ` fcp=${num(t.fcp)}` +
    ` ready=${num(t.ready)}` +
    ` origin=${t.origin}`
  );
}

/** 落一行启动打点；不抛、不 await（拿不到通道就静默返回 false） */
export function reportBootTimings(): boolean {
  try {
    const invoke = (globalThis as unknown as {
      __TAURI__?: { core?: { invoke?: (cmd: string, args: unknown) => unknown } };
    }).__TAURI__?.core?.invoke;
    if (typeof invoke !== "function") return false;
    const line = formatBootTimings(readBootTimings());
    void Promise.resolve(invoke("log_renderer_event", { level: "SAMPLE", message: line })).catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

/**
 * 启动屏进入"就绪"时调用：等两帧再读 paint 条目并落盘。
 * 这里刻意不返回 promise —— 启动路径不该为日志多等一个微任务。
 */
export function reportBootTimingsAfterPaint(): void {
  try {
    if (typeof requestAnimationFrame !== "function") return;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        reportBootTimings();
      });
    });
  } catch {
    // 没有 rAF（极端环境）就干脆不打点
  }
}
