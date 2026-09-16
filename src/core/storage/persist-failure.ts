/**
 * 持久化失败上报（第 87 波审计）。
 *
 * ## 为什么需要它
 *
 * B 类问题（假成功）机器扫描发现：全项目有 **31 处**"写/动作类函数"里的 catch
 * **只写一行 console.warn/error** 就继续往下走，调用方与界面完全看不出失败。典型：
 *
 * ```
 * updateSession: (sessionId, update) => {
 *   try { SessionStorage.updateSession(...); } catch (e) { console.warn('[store.ts]', e) }
 *   set({ sessions: updated, ... });   // ← 界面照常更新，像是保存成功了
 * }
 * ```
 * 用户看到标题改了、置顶了、项目删了，重启后一切照旧（或半新半旧）。
 *
 * ## 设计取舍
 *
 * - **不改控制流**：写失败仍然不抛（这些是 UI 高频路径，抛错会打断交互），
 *   但必须**可见**：统一走这里 → 一条 error 日志 + 一次窗口事件（界面提示用户）
 *   + 计数（诊断与测试可断言）。
 * - **按 area 去重告警**：同一个区域的失败第一次就提示，随后只累计次数，
 *   避免磁盘满时弹几百条提示。
 * - 事件名 `codem:persist-failed`，detail: `{ area, message, count }`。
 */

export interface PersistFailureEntry {
  area: string;
  count: number;
  lastMessage: string;
  lastAt: number;
  /** persist = 落盘失败（重启会丢）；action = 动作失败（功能没生效） */
  kind: "persist" | "action";
}

const failures = new Map<string, PersistFailureEntry>();
let listener: ((detail: { area: string; message: string; count: number; kind: "persist" | "action" }) => void) | null = null;

/** 注册一个上报回调（App 用它把失败变成用户可见的提示）。返回取消函数。 */
export function setPersistFailureListener(
  cb: ((detail: { area: string; message: string; count: number; kind: "persist" | "action" }) => void) | null,
): void {
  listener = cb;
}

/**
 * 上报一次"被吞掉的失败"。
 *
 * @param area 区域标识（例如 "store.updateSession" / "recovery.saveState"）
 * @param error 原始异常
 * @param extra 额外上下文（会拼进日志/事件消息）
 * @param kind persist = 写盘失败（重启后会丢）；action = 动作没生效（功能静默缺失）
 */
export function reportFailure(
  area: string,
  error: unknown,
  extra?: string,
  kind: "persist" | "action" = "persist",
): PersistFailureEntry {
  const message = error instanceof Error ? error.message : String(error ?? "unknown error");
  const prev = failures.get(area);
  const entry: PersistFailureEntry = {
    area,
    count: (prev?.count ?? 0) + 1,
    lastMessage: message,
    lastAt: Date.now(),
    kind,
  };
  failures.set(area, entry);

  console.error(
    `[PersistFailure] ${area} ${kind === "persist" ? "写盘失败" : "操作失败"}（第 ${entry.count} 次）：${message}` +
      (extra ? `（${extra}）` : "") +
      (kind === "persist" ? " —— 本次改动只存在于内存，重启后可能丢失。" : " —— 该功能本次没有生效。"),
  );

  try {
    listener?.({ area, message, count: entry.count, kind });
  } catch {
    /* 上报回调自身出错不能反过来影响主流程 */
  }
  try {
    if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
      window.dispatchEvent(
        new CustomEvent("codem:persist-failed", { detail: { area, message, count: entry.count, kind } }),
      );
    }
  } catch {
    /* 非浏览器环境（测试/SSR）忽略 */
  }

  return entry;
}

/** 写盘失败上报（reportFailure 的 persist 简写，保留旧名以便既有调用点不改） */
export function reportPersistFailure(area: string, error: unknown, extra?: string): PersistFailureEntry {
  return reportFailure(area, error, extra, "persist");
}

/** 动作失败上报（功能没生效，不涉及落盘） */
export function reportActionFailure(area: string, error: unknown, extra?: string): PersistFailureEntry {
  return reportFailure(area, error, extra, "action");
}

/** 当前累计的失败（按次数倒序；诊断与测试用） */
export function getPersistFailures(): PersistFailureEntry[] {
  return [...failures.values()].sort((a, b) => b.count - a.count).map((e) => ({ ...e }));
}

/** 是否发生过持久化失败 */
export function hasPersistFailures(): boolean {
  return failures.size > 0;
}

/** 清空（测试与"重置诊断数据"用） */
export function resetPersistFailures(): void {
  failures.clear();
}
