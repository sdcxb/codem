/**
 * 跨会话 Agent 协作 — 类型定义
 *
 * 方案3 核心类型：委派任务、会话间消息、编排状态。
 * 所有类型集中在此文件，供 bus / orchestrator / storage / tools 共享。
 */

// ========== 委派任务状态 ==========

export type DelegationState = "pending" | "running" | "completed" | "failed" | "cancelled";

// ========== 会话间消息 ==========

export type SessionMessageType =
  | "delegation" // 委派请求：源 → 目标
  | "result" // 委派结果：目标 → 源
  | "status" // 状态更新（permission_required / busy / idle）
  | "cancel"; // 取消委派

export interface SessionMessage {
  id: string;
  type: SessionMessageType;
  sourceSessionId: string;
  targetSessionId: string;
  /** 委派的任务描述（delegation 类型时必填） */
  task?: string;
  /** 回传的结果文本（result 类型时必填） */
  result?: string;
  /** 状态详情（status 类型时使用） */
  detail?: string;
  /** 关联的 delegationTaskId */
  taskId?: string;
  timestamp: number;
}

// ========== 委派任务 ==========

export interface DelegationTask {
  id: string;
  sourceSessionId: string;
  targetSessionId: string;
  /** 委派给目标会话的任务描述 */
  task: string;
  status: DelegationState;
  /** 目标会话完成后回传的结果 */
  result?: string;
  /** 失败时的错误信息 */
  error?: string;
  /** 当前所属项目 ID（用于隔离不同项目的委派） */
  projectId: string;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  /** Squad ID if this delegation is part of a squad (optional, for squad routing) */
  squadId?: string;
  /** Member ID if this delegation targets a specific squad member */
  memberId?: string;
  /**
   * 第 62 波：子会话执行进度。
   *
   * 事故背景：父会话 `wait_for_delegation` 会**无限期阻塞**，而子会话在原地打转（反复枚举同一目录），
   * 于是父会话十几分钟里既没有产出、也不知道子会话在干什么。现在子会话定期上报进度，
   * 等待超时后父会话能拿到「已跑多久 / 调了多少次工具 / 最新输出」并自行决定继续等还是先干别的。
   */
  progress?: DelegationProgress;
  /** 已累计等待时长（ms）—— 父会话反复"再等一轮"时用它兜住总时长 */
  waitedMs?: number;
}

interface DelegationProgress {
  /** 已完成的工具调用次数 */
  toolCalls: number;
  /** 子会话最新的文本片段（截断，用于判断它在干什么） */
  lastText: string;
  updatedAt: number;
  /** 最近一次工具调用描述（第 62 波加：一眼看出是不是在重复同一件事） */
  lastTool?: string;
}

// ========== 编排器配置 ==========

export interface DelegationConfig {
  /** 最大委派深度（A→B→C 为深度 2） */
  maxDepth: number;
  /** 最大并发委派任务数 */
  maxConcurrent: number;
  /** 委派任务超时（ms），0 = 不超时 */
  defaultTimeout: number;
  /**
   * 第 64 波（用户质疑「用时间做可靠性」之后重做）：等待**不再按固定时钟返回**，
   * 而是按**子会话的活动**返回 —— 满足任一条件就返回：
   *   · 任务结束（完成/失败/取消）；
   *   · 子会话**连续 `waitIdleMs` 没有上报任何进度**（= 它安静了，而不是"它跑了很久"）。
   *
   * 这样合法的长任务（一直在产出）可以被一直等下去，而卡住的会话会很快"安静"下来被识别。
   * 原来的「单次 3 分钟 / 累计 8 分钟」是拍出来的钟表阈值，已删除。
   */
  waitIdleMs: number;
  /**
   * 第 64 波：后台/委派会话的**空闲**上限（ms）—— 时间只用来测"沉默"，不用来测"总共跑了多久"。
   *
   * 语义对齐 DSH 的 `idleWatchdog`：后台会话每收到一个事件就重新上弦，只有连续这么久
   * **一个事件都没有**才中止。`<= 0` 表示不设空闲上限。
   */
  turnIdleMs: number;
  /**
   * 第 64 波：后台/委派会话单轮的**资源**预算（估算 token，0 = 不限）。
   *
   * 上限用**资源**而不是时钟：合法的大任务可以随便跑多久，但花钱要有数
   * （DSH 同样把 `maxTokens` 这类上限放在 settings schema 里，而不是散落的魔法数字）。
   */
  turnTokenBudget: number;
  /**
   * 第 65 波（审计补）：单个工具**在飞**多久算挂死（ms，默认 20 分钟）。
   *
   * 为什么需要单独一条：一个跑了 10 分钟的构建/测试期间**本来就没有事件**，
   * 空闲看门狗会把这种合法长工具当成卡死。所以工具的"在飞时长"要有自己的上限，
   * 而"空闲"只在**既没有事件、也没有工具在飞**时才判定。`<= 0` 表示不设上限。
   */
  toolFlightMs: number;
  /**
   * ## ★ 第 309 波：**停顿窗口**（ms，默认 `turnIdleMs / 4` ✓）—— 与 `turnIdleMs` **分开**的短尺子 ✓
   *
   * ## 为什么必须有它（`§13.226` 正式读数给的硬证据 ✓）
   *
   * `1.16.287` 的 `STALL-4` 交叉表 ✓：
   * ```
   * 结局 × 结束形态
   *               settled  stalled  unknown
   *   passed            5        6        0
   *   failed            0       13        0
   * ⇒ 失败的轮次里：被掐停 13 条 / 走到收尾段 0 条
   * ```
   * ★ **13 条失败轮，没有一条走到过收尾段** ✗ —— 一条都没有 ✓。
   *
   * 机制 ✓：`executor` 的消费循环**只有一道闸门**（`abort.signal.aborted` ✓），
   * 而它由 `turnIdleMs = 5 分钟` 触发 ✓ —— 而**跑批 2 分钟就放弃** ✗
   * ⇒ `break` 永远来不及 ⇒ **收尾段跑不到** ✓ ⇒ 四把完成守卫**一次都没机会开火** ✓
   * （§13.224 查过：守卫**本来就有** ✓、判据**早就写对了** ✓，缺的只是"机会"✓）。
   *
   * ## 与 `turnIdleMs` 的**关键区别**（**处置不同** ✓）
   *
   * | | 判据 | 处置 |
   * |---|---|---|
   * | `turnIdleMs` ✓ | 沉默 5 分钟 | **中止**这个回合 ✗ |
   * | **本字段** ✓ | 沉默 `stallMs`（**更短** ✓） | **`break` 出循环** ✓ ⇒ **收尾段跑** ✓（**不中止** ✓） |
   *
   * ⚠️ **必须比 `turnIdleMs` 短** ✗⇒✓（取成相等就等于没改 ✓，判据 `STALLW-2` 钉这条 ✓）。
   * ⚠️ **工具在飞时不算停顿** ✓（一个跑 10 分钟的构建期间本来就没有事件 ✓，
   * §13.224 第一节说明过"空闲 vs 工具挂死"是**用户质疑后重做**的口径 ✓，不许退回去 ✗）。
   * `<= 0` 表示**关闭**这条（回到旧行为 ✓）。
   */
  stallMs: number;
  /**
   * ## ★ 第 309 波：**"工具在飞"的等待上限**（ms，默认 `toolFlightMs / 4` = 5 分钟 ✓）
   *
   * ## 为什么必须有它（真机取证 ✓，归档 §13.234 ✓）
   *
   * `toolsInFlight` **只在收到工具完成事件时才 `--`** ✓ ⇒
   * ★ **"工具开始了、完成事件永不回来" ⇒ 它永远 `> 0`** ✗ ⇒
   * **两道看门狗一起失效** ✓：`turnIdleMs`（工具在飞就 `pulse()` 续命 ✓）
   * + `stallMs`（旧版"工具在飞 ⇒ 无条件重新排队" ✗）。
   * 唯一还在跑的是 `toolFlightMs`（**20 分钟** ✗）⇒ 远超跑批的 2 分钟 ✗
   * ⇒ 回合被外人结束 ✓ ⇒ **收尾段一行都没执行** ✓ ⇒ 四把完成守卫**一次都没机会开火** ✓。
   *
   * ## 口径（**"延期"本身也要有上限** ✓）
   *
   * 工具在飞时**照常**按 `stallMs` 计时 ✓，但每次触发只增加 `flightWaitedMs` ✓；
   * **累计**超过本值 ⇒ 判定"**工具没回来**"✓ ⇒ **交出控制权**（`break` ✓、**不 `abort`** ✓）。
   * ⚠️ 取值边界 ✓：**必须严格小于 `toolFlightMs`** ✓（那条是"中止"✓）；
   * **必须显著大于正常工具时长** ✓（合法长工具不许误杀 ✗）。
   * `<= 0` ⇒ 取 `toolFlightMs / 4` ✓。
   */
  flightStallMs: number;
}

export const DEFAULT_DELEGATION_CONFIG: DelegationConfig = {
  maxDepth: 2,
  maxConcurrent: 5,
  defaultTimeout: 0, // 任务本身不设超时，依赖 abort 信号取消
  waitIdleMs: 3 * 60 * 1000, // 子会话连续 3 分钟没有进度上报 → 判定"安静了"，带进度返回
  turnIdleMs: 5 * 60 * 1000, // 后台会话连续 5 分钟没有任何事件 → 判定空闲（对齐 DSH 的流空闲默认值）
  turnTokenBudget: 200_000, // 资源预算（估算 token 代理值，含工具入参/结果）：0 = 不限
  // ↑ 第 65 波从 0 改为有限值：第三类打转（每次输出都不一样）只有资源上限兜得住。
  //   200k 是"明显异常"的量级（正常后台任务远低于此），刻意给得宽松以免误杀大任务。
  toolFlightMs: 20 * 60 * 1000, // 单个工具在飞超过 20 分钟判定挂死（工具自带超时通常更早触发）
  // 第 309 波：停顿窗口 = 空闲窗口的 1/4（见 `stallMs` 的长注释）；比 turnIdleMs 短才有意义
  stallMs: (5 * 60 * 1000) / 4,
  // 第 309 波：「工具在飞」的等待上限 = 工具挂死上限的 1/4 = 5 分钟
  //（见 `flightStallMs` 的长注释：必须严格小于 toolFlightMs，且显著大于正常工具时长）
  flightStallMs: (20 * 60 * 1000) / 4,
};

// ========== DB 行类型 ==========

export interface DelegationTaskRow {
  id: string;
  source_session_id: string;
  target_session_id: string;
  task: string;
  status: string;
  result: string | null;
  error: string | null;
  project_id: string;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
}
