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
 * - 事件名 `codem:persist-failed`，detail: `{ area, message, count, kind }`。
 *
 * ## 第 48 轮：`consequence` —— 后果那一句必须由**上报方**给，不能由通道瞎猜
 *
 * 通道原来在 `App.tsx` 里给 `persist` 类统一补一句固定后果：
 * "这次改动目前只在内存里，重启应用后会丢失；请检查磁盘空间与数据库文件占用。"
 * 大多数写失败确实如此，但**不是全部** —— 例如插件开关的介质对账
 * （`preferences.disabledPlugins.diverged`）在这一刻**已经把较新的那份恢复进 DB 了**，
 * 于是横幅上同时出现"已按较新的一份恢复"与"重启应用后会丢失"两句**互相矛盾**的话，
 * 还把原因指向磁盘空间（真实原因是一次没走完的写入）。
 *
 * 所以把"后果/建议"变成上报方可以覆盖的一个字段：给了就用它，没给就用通用那句
 * （既有调用点行为完全不变）。判据是"横幅上写的必须是真实情况"。
 */

export interface PersistFailureEntry {
  area: string;
  count: number;
  lastMessage: string;
  lastAt: number;
  /** persist = 落盘失败（重启会丢）；action = 动作失败（功能没生效） */
  kind: "persist" | "action";
}

/** 上报时可选的补充信息 */
export interface PersistFailureOptions {
  /**
   * 覆盖界面上那句"后果/建议"。
   *
   * 只在**通用那句不成立**时才传：通用句假定"改动只存在于内存、重启会丢"。
   * 例如"写入没落地但已按较新的一份恢复"就不成立。
   */
  consequence?: string;
}

/** 窗口事件的 detail 形状（`consequence` 见上） */
export interface PersistFailureDetail {
  area: string;
  message: string;
  count: number;
  kind: "persist" | "action";
  consequence?: string;
}

const failures = new Map<string, PersistFailureEntry>();
let listener: ((detail: PersistFailureDetail) => void) | null = null;

/** 注册一个上报回调（App 用它把失败变成用户可见的提示）。返回取消函数。 */
export function setPersistFailureListener(cb: ((detail: PersistFailureDetail) => void) | null): void {
  listener = cb;
}

/**
 * 上报一次"被吞掉的失败"。
 *
 * @param area 区域标识（例如 "store.updateSession" / "recovery.saveState"）
 * @param error 原始异常
 * @param extra 额外上下文（会拼进日志/事件消息）
 * @param kind persist = 写盘失败（重启后会丢）；action = 动作没生效（功能静默缺失）
 * @param options 见 `PersistFailureOptions`（目前只有 `consequence`：覆盖"后果"那一句）
 */
export function reportFailure(
  area: string,
  error: unknown,
  extra?: string,
  kind: "persist" | "action" = "persist",
  options?: PersistFailureOptions,
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

  const detail: PersistFailureDetail = { area, message, count: entry.count, kind };
  if (options?.consequence) detail.consequence = options.consequence;

  console.error(
    `[PersistFailure] ${area} ${kind === "persist" ? "写盘失败" : "操作失败"}（第 ${entry.count} 次）：${message}` +
      (extra ? `（${extra}）` : "") +
      (options?.consequence
        ? ` —— ${options.consequence}`
        : kind === "persist"
          ? " —— 本次改动只存在于内存，重启后可能丢失。"
          : " —— 该功能本次没有生效。"),
  );

  try {
    listener?.(detail);
  } catch {
    /* 上报回调自身出错不能反过来影响主流程 */
  }
  try {
    if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
      window.dispatchEvent(new CustomEvent("codem:persist-failed", { detail }));
    }
  } catch {
    /* 非浏览器环境（测试/SSR）忽略 */
  }

  return entry;
}

/** 写盘失败上报（reportFailure 的 persist 简写，保留旧名以便既有调用点不改） */
export function reportPersistFailure(
  area: string,
  error: unknown,
  extra?: string,
  options?: PersistFailureOptions,
): PersistFailureEntry {
  return reportFailure(area, error, extra, "persist", options);
}

/** 动作失败上报（功能没生效，不涉及落盘） */
export function reportActionFailure(
  area: string,
  error: unknown,
  extra?: string,
  options?: PersistFailureOptions,
): PersistFailureEntry {
  return reportFailure(area, error, extra, "action", options);
}

/**
 * 把一条上报拼成**界面上显示的那一句话**（纯函数，便于用例直接断言文案）。
 *
 * 第 48 轮从 `App.tsx` 里抽出来：原来这段拼装写在事件监听器里，
 * 于是"横幅上到底印了什么"只能靠真机肉眼核验 —— 而本轮真机核验抓到的正是
 * **印出来的后果与真实情况矛盾**（"已按较新的一份恢复"+"重启应用后会丢失"）。
 * 抽成纯函数之后，文案本身成了可回归的契约
 * （见 `plugin-toggle-medium.test.ts::PLUGIN-MEDIUM-13`）。
 */
export function composePersistAlertText(detail: PersistFailureDetail): string {
  const isAction = detail.kind === "action";
  const reason = detail.message || "未知原因";
  if (isAction) {
    return (
      `操作没有生效（${detail.area}）：${reason}。` +
      (detail.consequence ?? "该功能本次不可用，请重试或检查日志") +
      (detail.count > 1 ? `（已累计失败 ${detail.count} 次）` : "") +
      `。`
    );
  }
  return (
    `数据保存失败（${detail.area}）：${reason}。` +
    (detail.consequence ??
      "这次改动目前只在内存里，重启应用后会丢失；请检查磁盘空间与数据库文件占用。") +
    (detail.count > 1 ? `（该区域已累计失败 ${detail.count} 次）` : "")
  );
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
