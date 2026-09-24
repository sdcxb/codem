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
  /** persist = 落盘失败（重启会丢）；action = 动作失败（功能没生效）；advisory = 发现/提醒（没有东西失败） */
  kind: "persist" | "action" | "advisory";
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
  /**
   * 覆盖开头那句**标题**（第 52 轮）。
   *
   * 只在"两种 kind 的前缀都不成立"时才传：典型是维护自检发现并**已经修好**的不一致
   * —— 那不是"操作没有生效"，也不是"数据保存失败"。开头假 = 整条不可信。
   */
  title?: string;
}

/** 窗口事件的 detail 形状（`consequence` / `title` 见上） */
export interface PersistFailureDetail {
  area: string;
  message: string;
  count: number;
  kind: "persist" | "action" | "advisory";
  consequence?: string;
  title?: string;
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
  kind: "persist" | "action" | "advisory" = "persist",
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
  if (options?.title) detail.title = options.title;

  /**
   * 控制台那一行也要**说真话**：`advisory`（发现/提醒）不是失败，
   * 所以既不该打 `error`，也不该印「写盘失败 / 操作失败」。
   * （第 88 轮实测抓到：一条"发现明文凭据 1 处"的**安全提醒**，
   *  在控制台里长成 `[PersistFailure] … 操作失败（第 1 次）` —— 读日志的人会以为普查坏了。）
   */
  if (kind === "advisory") {
    console.warn(
      `[Advisory] ${area}：${message}` +
        (extra ? `（${extra}）` : "") +
        (options?.consequence ? ` —— ${options.consequence}` : ""),
    );
  } else {
    /**
     * 第 88 轮：**控制台那段也要是真的**。
     *
     * `persist` 的默认标签是「写盘失败」，可这只是"两种默认里比较像的那个" ——
     * 维护里的裁剪没跑成、完整性检查没跑成、空间回收没跑成，**没有任何写盘动作失败**；
     * 真机取证就是这么印的：`[PersistFailure] maintenance.integrityCheck 写盘失败（第 1 次）：…`
     * 而消息正文写的是"完整性检查失败"。
     * 调用方给了 `title`（它本来就是"开头那句真实的话"）时就用它当控制台标签，
     * 否则保持原样（既有调用点行为不变）。
     */
    const label = options?.title ?? (kind === "persist" ? "写盘失败" : "操作失败");
    console.error(
      `[PersistFailure] ${area} ${label}（第 ${entry.count} 次）：${message}` +
        (extra ? `（${extra}）` : "") +
        (options?.consequence
          ? ` —— ${options.consequence}`
          : kind === "persist"
            ? " —— 本次改动只存在于内存，重启后可能丢失。"
            : " —— 该功能本次没有生效。"),
    );
  }

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
 * **提醒/发现**上报（第 88 轮）：既不是"写盘失败"，也不是"操作没生效"，
 * 而是"我们查到了某件事，你要知道"。
 *
 * ## 为什么必须单独一条通道（真机实测的现场）
 *
 * 凭据普查发现"设置里有疑似明文凭据"、自检发现"本次新产生 N 条双写缺口" ——
 * 这些都是**功能正常跑完**之后的**发现**。它们原来借用失败通道，于是界面上印出：
 *
 * - 横幅：`安全提示：设置里存在明文凭据：设置里存在疑似凭据 1 处。该功能本次不可用，请重试或检查日志。`
 *   —— **"请重试"是假建议**（再跑一次还是同样的发现），"不可用"是假陈述（功能刚跑成功了）；
 * - 控制台：`[PersistFailure] maintenance.credentialCensus 操作失败（第 1 次）`、
 *   `[PersistFailure] maintenance.invariantAudit.new 写盘失败（第 1 次）`
 *   —— 后者更是把"审计发现"印成了"写盘失败"。
 *
 * 判据就一条：**印出来的必须是真的**。发现类消息需要一个不假装失败的语气，
 * 而"发现"的严重程度也不该被失败通道的措辞稀释掉（用户会以为重试一下就好）。
 *
 * @param area 区域标识（例如 `maintenance.credentialCensus`）
 * @param finding 发现了什么（**陈述事实**，不要写成错误消息）
 * @param options `title` 覆盖标题；`nextStep` 写"建议怎么做"（会印在横幅上）；`sample` 是给日志的样例/位置
 */
export function reportAdvisory(
  area: string,
  finding: string,
  options?: { title?: string; nextStep?: string; sample?: string },
): PersistFailureEntry {
  return reportFailure(area, new Error(finding), options?.sample, "advisory", {
    ...(options?.title ? { title: options.title } : {}),
    ...(options?.nextStep ? { consequence: options.nextStep } : {}),
  });
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
  const isAdvisory = detail.kind === "advisory";
  const reason = detail.message || "未知原因";
  /**
   * 第 52 轮：`title` 可以**替换开头那句**。
   *
   * 为什么还需要它：`kind` 只有两种前缀（"数据保存失败" / "操作没有生效"），
   * 而有些被上报的事情**两者都不成立** —— 典型是维护里的对账发现
   * "索引落后于权威日志"：那不是用户的操作没生效，也不是数据保存失败，
   * 而是**自检发现了不一致并已经修好**。真机上那条横幅当时印的是
   * "操作没有生效（maintenance.indexBehindLog）：…" —— 一句话开头就是假的，
   * 而后半句（"已逐会话重建，补回 3 行"）才是真的。**开头假 = 整条不可信。**
   *
   * 第 88 轮：这一类被正式立成第三个 kind（`advisory`）—— 不再靠调用方各自传 title 打补丁，
   * 且**后缀也不再借用失败语气**（"请重试"这类假建议在提醒里不该出现）。
   */
  const head = detail.title
    ? detail.title
    : isAdvisory
      ? `提醒（${detail.area}）`
      : isAction
        ? `操作没有生效（${detail.area}）`
        : `数据保存失败（${detail.area}）`;
  if (isAdvisory) {
    // 提醒：没有"失败"，所以既不写后果也不写重试建议；给了 nextStep 就印建议本身。
    // 次数后缀也换说法 —— "已累计失败 N 次"对发现类消息是假的（它没失败）。
    return (
      `${head}：${reason}。` +
      (detail.consequence ?? "") +
      (detail.count > 1 ? `（本次维护过程中同类提示 ${detail.count} 次）` : "")
    );
  }
  if (isAction) {
    return (
      `${head}：${reason}。` +
      (detail.consequence ?? "该功能本次不可用，请重试或检查日志") +
      (detail.count > 1 ? `（已累计失败 ${detail.count} 次）` : "") +
      `。`
    );
  }
  return (
    `${head}：${reason}。` +
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
