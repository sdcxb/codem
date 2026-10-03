/**
 * 计划停滞检测（第 65 波；判据在第 93 波被**治本修正**）。
 *
 * ## 这道阀门要拦的是什么
 *
 * 前两道阀门各自有明确的盲区（第 64 波结论）：
 *   · **零信息增益**（`loop-guard.ts`）：要求"拿到的内容与之前**完全相同**"。若模型每次拿到的
 *     内容都不一样（时间戳、进度百分比、越挖越深的目录树…），它永远判不出来；
 *   · **空闲看门狗**（`idle-watchdog.ts`）：要求"完全没有事件"。一直在动就判不出来。
 * 这道阀门补的是第三类打转：**一直在动、内容也一直在变，但任务一步没往前走**。
 *
 * ## ⚠️ 第 93 波治本修正：判据从「有没有写盘」扩成「有没有获得新信息」
 *
 * 原来的判据是「计划没修订 **且** 没有产出交付物」，而"产出交付物"只认**写盘**
 * （写入/编辑/会改盘的命令）。它在真实大仓库里会**误杀称职的探索**：
 *
 *   一手证据（用户报「任务提前停掉，然后说完成了」）：在咱们自己仓库上跑真实任务的会话
 *   `1790981803954-u5dmdoahw` 里，模型正在**逐文件读代码**（"Now I have the full picture.
 *   Let me read the actual edit tool implementation…"），每个迭代都读到了**新内容**，
 *   事件流里却留下 `plan_stale_ask stalledFor=12` 与 `plan_stale stalledFor=24` ——
 *   第 12 轮提醒、第 24 轮**直接把循环杀掉**。
 *
 * 缺陷的根子是：**"读到新内容"被当成了"没推进"**。而这个信息增益信号**早就有了** ——
 * `RepeatGuard.noteResult()` 返回的 `gained`（这次拿到的内容是不是已经见过的）
 * 就是现成的、机械可算的"新信息"证据，只是没有接进这道阀门。
 *
 * 现在推进信号有**三条**（任一成立即清零，都与"模型说了什么"无关）：
 *   1. 模型修订了计划（`planRevision` 变了）；
 *   2. 产出了交付物（真的写盘 / 可证明会改盘的命令）；
 *   3. **获得了新信息**（`gainedInformation`：这一轮读/查拿回来的内容**不是已经见过的**）。
 *
 * 于是 12 / 24 这两个阈值**换算了单位**：数的不再是"连续迭代数"，而是
 * **「连续多少次既没写盘、也没有拿到任何新信息、计划也没动」** —— 也就是可证明的零进展。
 * 在真实大仓库里"逐文件读、越读越准"的探索**永远到不了这个窗口**（每次都是新信息）。
 *
 * ## 设计取舍：先问，再停
 *
 * 只按"没产出东西"就杀是危险的，所以分两档：
 *   · `askAfter`：连续这么多**零进展**迭代 → **注入一个聚焦问题**（不打断、不杀），
 *     要求它一句话说清卡在哪、并更新计划或明确报告缺什么（这是"恢复"而不是"止损"）；
 *   · `stopAfter`：问过之后**再连续**这么多零进展迭代 → 才停（reason: `plan_stale`）。
 *
 * 连读 24 个迭代都拿不到任何新信息、也没写下任何东西，停是站得住的：
 * 那已经不是"在探索"，而是**在反复拿同一份旧内容**（何况 `RepeatGuard` 会更早介入）。
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
  /**
   * 本轮是否**获得了新信息**（第 93 波治本新增）。
   *
   * 来源是 `RepeatGuard.noteResult()` 的 `gained`：这一轮实际执行的调用拿回来的内容
   * **不是之前已经见过的** ⇒ 读到/查到的东西是新的 ⇒ 探索在推进。
   *
   * 为什么必须把它算作推进：真实大仓库里的称职探索是"逐文件读、越读越准"，
   * 十几个迭代里一个交付物都没有（很正常），但它**一直在获得新信息**。
   * 只认"写盘"会把这种探索判成零进展，第 24 轮把循环杀掉（第 93 波一手证据）。
   *
   * 反向语义同样重要：**反复拿回同一份旧内容**（零信息增益）不算推进 ——
   * 那才是真的卡住了。
   */
  gainedInformation: boolean;
  /** 当前步骤标题，仅用于提醒文案（让模型知道"你停在哪一步"） */
  stepLabel?: string;
}

export interface StallLimits {
  /**
   * 连续多少次**零进展迭代**后先**问**（不打断）。
   *
   * 「零进展迭代」= 计划没修订 **且** 没产出交付物 **且** 没获得新信息（见 `StallSignal`）。
   */
  askAfter: number;
  /** 问过之后再连续多少次仍然零进展 → 停 */
  stopAfter: number;
  /** 文案里怎么称呼当前会话 */
  label: string;
}

export const DEFAULT_STALL_LIMITS: StallLimits = {
  // 计量单位是**零进展迭代**（不是总迭代数）：读新内容、写盘、改计划都会清零。
  // 于是 12 这个窗口在实际会话里意味着"连着 12 轮什么新东西都没拿到" —— 足够宽松，
  // 又足以在真的卡住时早早提醒。停档取两倍（24），避免"刚好在临界点被砍"。两者都可配。
  askAfter: 12,
  stopAfter: 24,
  label: "本次会话",
};

type StallAction = "none" | "ask" | "stop";

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
    /** 计划/产物/信息增益推进了多少次（= 真实进展的度量） */
    progressResets: 0,
    /**
     * 其中靠**信息增益**清零的次数（第 93 波）。
     *
     * 这个计数存在的意义：它是"这道阀门到底有没有把大仓库里的探索误判成停滞"的
     * 可观测指标 —— 真实仓库任务里它应当是**非零且很大**的（每读一个新文件 +1）。
     * 为 0 就说明信息增益根本没有接进循环。
     */
    informationGainResets: 0,
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
   * 「有推进」的定义三条（都与"模型说了什么"无关）：**模型修订了计划**、
   * **产出了交付物**、或**获得了新信息**。只要有一条成立就清零 ——
   * 因此"在大仓库里读一堆文件、越读越准"的合法节奏**永远不会**被误判（第 93 波治本）。
   */
  noteIteration(signal: StallSignal): StallDecision {
    const planChanged = this.lastPlanRevision !== null && this.lastPlanRevision !== signal.planRevision;
    this.lastPlanRevision = signal.planRevision;

    if (planChanged || signal.producedArtifact || signal.gainedInformation) {
      if (this.stalled > 0) this.stats.progressResets++;
      if (signal.gainedInformation) this.stats.informationGainResets++;
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
          `计划没有修订${signal.stepLabel ? `（当前步骤：${signal.stepLabel}）` : ""}，没有产出任何交付物` +
          `（没有写入/编辑/会改盘的命令），而且**每次读/查拿回来的都是已经见过的内容**（零信息增益）。\n` +
          `请用**一两条**回答清楚，然后继续干活：\n` +
          `  1) 你现在卡在哪？（缺什么信息、哪个文件/命令不配合）\n` +
          `  2) 下一步具体做什么 —— 如果要改计划，现在就调用 update_plan；\n` +
          `  3) 如果任务其实已经做完，直接给出结论并结束。\n` +
          `不要继续重复看同一批东西：**读是为了写**。如果还需要读，就换**没读过的**文件/范围。`,
      };
    }

    if (this.stalled >= this.limits.stopAfter) {
      this.stats.stops++;
      return {
        action: "stop",
        stalledFor: this.stalled,
        message:
          `已连续 ${this.stalled} 个迭代**没有任何推进**（计划没修订、没有产出任何交付物、` +
          `也没有获得任何新信息 —— 每次读/查拿回来的都是已经见过的内容），` +
          `而且在第 ${this.limits.askAfter} 个迭代时已经提醒过一次仍未改变。\n` +
          `继续下去只会消耗时间与费用：请人工确认下一步，或把任务拆得更小、把「完成判据」写得更具体。`,
      };
    }

    return { action: "none", stalledFor: this.stalled };
  }
}
