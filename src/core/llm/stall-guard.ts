/**
 * 计划停滞检测（第 65 波）—— 补上「每次输出都不一样」的空转。
 *
 * ## 为什么还需要第三道检测
 *
 * 前两道各自有明确的盲区（第 64 波结论）：
 *   · **零信息增益**（`loop-guard.ts`）：要求"拿到的内容与之前完全相同"。若模型每次拿到的内容
 *     **都不一样**（时间戳、进度百分比、越挖越深的目录树…），它永远判不出来；
 *   · **空闲看门狗**（`idle-watchdog.ts`）：要求"完全没有事件"。一直在动就判不出来。
 * 而这两类之外还有第三种打转：**输出一直在变，但任务一步没往前走**（计划的步骤没推进、
 * 一个交付物都没产生）。
 *
 * 这一类的判据**不能是内容**（内容确实变了），只能是**状态**：
 *   「计划指纹没变 + 没有产出任何交付物」。
 * 这是我们自己维护的状态（`activePlan` / `macroStep`），机械可算，与模型说什么无关。
 *
 * ## 设计取舍：先问，再停
 *
 * 只按"没产出东西"就杀是危险的 —— **读一大堆文件然后动手**是合法且常见的节奏，
 * 中间可能有十几个迭代没有交付物。所以：
 *   · `askAfter`：连续这么多迭代"计划没动 + 没产出" → **注入一个聚焦问题**（不打断、不杀），
 *     要求它一句话说清卡在哪、并更新计划或明确报告缺什么（这是"恢复"而不是"止损"）；
 *   · `stopAfter`：问过之后**再连续**这么多迭代仍然没有任何推进 → 才停（reason: `plan_stale`）。
 * 真·读文件阶段通常在第一个窗口内就写出了东西；两个窗口都没有任何交付物，停是站得住的。
 */

export interface StallSignal {
  /**
   * 计划修订号：**只在模型成功调用 `update_plan` 时 +1**。
   *
   * 审计修正（第 65 波内）：一开始用「计划标题 + `macroStep`」当指纹，但 `macroStep` 是**UI 启发式步进** ——
   * 每个迭代里首次出现"非侦察类工具"就会 +1（`agentic-loop.ts` 里那段 macroStep 推进逻辑）。
   * 于是只要模型交替做点别的，指纹就一直在变，停滞检测被不断清零、等于失效。
   * 现在只认**真正的计划修订**（模型自己改计划），这才是"任务层面往前走了一步"。
   */
  planRevision: number;
  /** 本轮是否产出了交付物（成功的写入/编辑，或一次会改盘的命令） */
  producedArtifact: boolean;
  /** 当前步骤标题，仅用于提醒文案（让模型知道"你停在哪一步"） */
  stepLabel?: string;
}

export interface StallLimits {
  /** 连续多少次"计划没动 + 没产出"后先**问**（不打断） */
  askAfter: number;
  /** 问过之后再连续多少次仍然没推进 → 停 */
  stopAfter: number;
  /** 文案里怎么称呼当前会话 */
  label: string;
}

export const DEFAULT_STALL_LIMITS: StallLimits = {
  // 12 个迭代：典型的「读一堆 → 动手写」在 10 来个迭代内就会开始产出，留一点余量；
  // 停档取两倍（24），避免"刚好在临界点被砍"。两者都可配。
  askAfter: 12,
  stopAfter: 24,
  label: "本次会话",
};

export type StallAction = "none" | "ask" | "stop";

export interface StallDecision {
  action: StallAction;
  /** 已经连续多少个迭代没有任何推进 */
  stalledFor: number;
  message?: string;
}

export class StallGuard {
  private readonly limits: StallLimits;
  private lastPlanRevision: number | null = null;
  private stalled = 0;
  private asked = false;

  readonly stats = {
    /** 观测到的"无推进"迭代总数 */
    stalledIterations: 0,
    /** 计划/产物推进了多少次（= 真实进展的度量） */
    progressResets: 0,
    asks: 0,
    stops: 0,
  };

  constructor(limits: Partial<StallLimits> = {}) {
    this.limits = { ...DEFAULT_STALL_LIMITS, ...limits };
  }

  reset(): void {
    this.lastPlanRevision = null;
    this.stalled = 0;
    this.asked = false;
  }

  /** 当前连续无推进的迭代数（供日志/契约测试） */
  get stalledIterations(): number {
    return this.stalled;
  }

  /**
   * 每个迭代结束时调用一次。
   *
   * 「有推进」的定义只有两条（都与内容无关）：**模型修订了计划**，或**产出了交付物**。
   * 只要有一条成立就清零 —— 因此"读一堆文件然后动手"的合法节奏不会被误判。
   */
  noteIteration(signal: StallSignal): StallDecision {
    const planChanged = this.lastPlanRevision !== null && this.lastPlanRevision !== signal.planRevision;
    this.lastPlanRevision = signal.planRevision;

    if (planChanged || signal.producedArtifact) {
      if (this.stalled > 0) this.stats.progressResets++;
      this.stalled = 0;
      this.asked = false;
      return { action: "none", stalledFor: 0 };
    }

    this.stalled++;
    this.stats.stalledIterations++;

    if (!this.asked && this.stalled >= this.limits.askAfter) {
      this.asked = true;
      this.stats.asks++;
      return {
        action: "ask",
        stalledFor: this.stalled,
        message:
          `[SYSTEM REMINDER — 进度自查] 你已经连续 ${this.stalled} 个迭代**没有任何推进**：` +
          `计划没有修订${signal.stepLabel ? `（当前步骤：${signal.stepLabel}）` : ""}，也没有产出任何交付物` +
          `（没有写入/编辑/会改盘的命令）。\n` +
          `请用**一两条**回答清楚，然后继续干活：\n` +
          `  1) 你现在卡在哪？（缺什么信息、哪个文件/命令不配合）\n` +
          `  2) 下一步具体做什么 —— 如果要改计划，现在就调用 update_plan；\n` +
          `  3) 如果任务其实已经做完，直接给出结论并结束。\n` +
          `不要继续只读不产出：**读是为了写**。`,
      };
    }

    if (this.stalled >= this.limits.stopAfter) {
      this.stats.stops++;
      return {
        action: "stop",
        stalledFor: this.stalled,
        message:
          `已连续 ${this.stalled} 个迭代**没有任何推进**（计划没修订、也没有产出任何交付物），` +
          `而且在第 ${this.limits.askAfter} 个迭代时已经提醒过一次仍未改变。\n` +
          `继续下去只会消耗时间与费用：请人工确认下一步，或把任务拆得更小、把「完成判据」写得更具体。`,
      };
    }

    return { action: "none", stalledFor: this.stalled };
  }
}
