/**
 * 自适应 steward 策略（25 号文 P2）：把「窗口 / 单轮体量 / 连压次数」折算成
 * **决策输入**（consider / hard / keepRecent），不新建第二套压力模型。
 *
 * ## 为什么必须是纯函数
 *
 * 本仓的段式决策（`segment-switch.ts::decideEpochAction`）之所以可复盘，是因为
 * 每个决定都能用「压力 + 两个阈值」解释。自适应如果直接改 `decideEpochAction` 的内部常数，
 * 那种可解释性就没了。所以这里只做一件事：**给同一把水尺换刻度**，并输出人话 reason。
 *
 * 三条边界（写死在这里，判据也钉住）：
 * 1. **只调决策输入**：输出只是 consider / hard / keepRecent，压力仍是 `context.ts` 的
 *    `PRESSURE_THRESHOLDS` 与 `summarizeDisplayPressure` 那一套，本模块不读消息、不估 token。
 * 2. **默认完全等价旧值**：窗口 = 128k、没有单轮观测、连压 < 2 时输出 **0.7 / 0.9 / 20**，
 *    与引入本模块之前逐字一致（`decideEpochAction` 的 reason 也不变）。
 * 3. **保守**：所有调整只许把阈值**往下**挪（更早触发），永远不许抬高；
 *    并有硬下限（consider ≥ 0.55、hard 不低于 consider + 0.05），免得把会话压成抖动。
 *
 * ## 规则（逐条可解释）
 *
 * | 输入 | 调整 | 理由 |
 * |---|---|---|
 * | 窗口 < 128k | consider 下调，最多 −0.10（线性：`(1 - window/128k) × 0.10`） | 小窗口的绝对余量更小，同样的相对压力更危险 |
 * | 窗口 ≥ 128k | **不调**（「窗口越大阈值不降」） | 大窗口有余量，不提前打扰；也不抬高阈值（那会让大窗口过晚压缩） |
 * | 单轮观测 > 窗口 10% | consider 下调，最多 −0.10（10%→30% 线性到顶） | 单轮体量大 = 剩余空间被一口吃掉，提前收拾 |
 * | 连压 ≥ 2 | hard 下调，每次 −0.02、最多 −0.05 | 连压说明压缩已经救不回来，提前换段救援 |
 * | 其它 | 一律不动 | 默认值就是答案 |
 *
 * ## 为什么「单轮观测」只接受增量，不接受「当前压力」
 *
 * 用「当前上下文占窗口多少」当单轮体量，就等于把压力再算一遍 —— 那是第二套压力模型，
 * 也正是 25 号文明确禁止的。本模块只接受调用方观测到的**本轮新增 token**（生产上由
 * `agentic-loop` 用「本回合平均每次调用的 prompt tokens − 上一回合的同口径值」得到），
 * 缺失/为 0 ⇒ 视为「没有可用观测」，不调整。
 */

/** 默认窗口：与 `CompactionConfig.maxContextWindow` 的默认值一致。 */
const BASE_WINDOW = 128_000;
/** 默认 consider / hard / keepRecent：与 `segment-switch.ts`、`CompactionConfig` 的历史默认值一致。 */
const DEFAULT_CONSIDER = 0.7;
const DEFAULT_HARD = 0.9;
const DEFAULT_KEEP_RECENT = 20;

/** 下调硬下限：consider 再低也不能低于它（否则会话会在低压力反复压缩）。 */
const CONSIDER_FLOOR = 0.55;
/** hard 与 consider 的最小间距：hard 必须严格高于 consider，否则「救援」与「常规」分不开。 */
const HARD_GAP = 0.05;
/** 窗口惩罚上限（小窗口最多把 consider 拉低这么多）。 */
const MAX_WINDOW_PENALTY = 0.1;
/** 单轮体量惩罚上限。 */
const MAX_TURN_PENALTY = 0.1;
/** 单轮体量的「免费额度」：≤ 窗口 10% 视为正常，不调整。 */
const TURN_SHARE_FREE = 0.1;
/** 单轮体量惩罚到顶的占比：≥ 窗口 30% 视为「一口吃掉三成窗口」。 */
const TURN_SHARE_FULL = 0.3;
/** 连压救援：≥ 2 次才开始下调 hard。 */
const STREAK_FREE = 2;
/** 每次连压对 hard 的下调步长 / 总上限。 */
const STREAK_STEP = 0.02;
const MAX_STREAK_PENALTY = 0.05;

/** 输入：全部可缺省；缺省即「按默认值 + 无观测」。 */
export interface StewardPolicyInput {
  /** 模型真实上下文窗口（token）；缺省/非法 ⇒ 128000 */
  modelContextWindow?: number;
  /** 本轮观测到的**新增** token 均值；缺省/≤0 ⇒ 没有可用观测（不调整） */
  observedAvgTurnTokens?: number;
  /** 连续压缩次数（loop 的 `state.consecutiveCompactions`） */
  consecutiveCompactions?: number;
  /** 当前压力（0..1）；只用于 reason（不参与阈值计算 —— 压力口径唯一） */
  pressure?: number;
  /** 配置里的考虑线（缺省 0.7） */
  baseConsider?: number;
  /** 配置里的 hard 线（缺省 0.9） */
  baseHard?: number;
  /** 配置里的保留条数（缺省 20） */
  baseKeepRecent?: number;
}

/** 输出：三个决策输入 + 可解释理由。 */
export interface StewardPolicy {
  /** 考虑线（只降不升，下限 0.55） */
  consider: number;
  /** hard 线（只降不升，且恒 > consider） */
  hard: number;
  /** 换段后保留条数（本轮不参与自适应；原样透传配置值） */
  keepRecent: number;
  /** 人话理由（写进 `steward_policy` 审计事件） */
  reason: string;
  /** 是否真的调整过（false ⇒ 与旧默认逐字等价，审计可以不写） */
  adjusted: boolean;
  /** 归一化后的窗口（reason / 审计用） */
  modelContextWindow: number;
  /** 归一化后的单轮观测（0 = 没有可用观测） */
  observedAvgTurnTokens: number;
}

function finiteNumber(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** 保留三位小数：避免 0.7000000000000001 这种读数污染审计与判据。 */
function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** 阈值归一化：只接受 (0,1) 内的有限数，否则回默认值（不静默钳制到边界）。 */
function normalizeRatio(value: unknown, fallback: number): number {
  const n = finiteNumber(value);
  if (n === null || n <= 0 || n >= 1) return fallback;
  return n;
}

/**
 * 计算自适应策略（纯函数：不读存储、不读时钟、不用随机数）。
 *
 * @example
 * resolveStewardPolicy({}); // ⇒ { consider: 0.7, hard: 0.9, keepRecent: 20, adjusted: false, ... }
 * resolveStewardPolicy({ modelContextWindow: 32_000 }); // ⇒ consider < 0.7，hard 仍 0.9
 * resolveStewardPolicy({ consecutiveCompactions: 2 }); // ⇒ hard 0.88，consider 仍 0.7
 */
export function resolveStewardPolicy(input: StewardPolicyInput = {}): StewardPolicy {
  const baseConsider = normalizeRatio(input.baseConsider, DEFAULT_CONSIDER);
  const baseHard = normalizeRatio(input.baseHard, DEFAULT_HARD);
  const baseKeepRecentRaw = finiteNumber(input.baseKeepRecent);
  const baseKeepRecent =
    baseKeepRecentRaw !== null && baseKeepRecentRaw > 0 ? Math.floor(baseKeepRecentRaw) : DEFAULT_KEEP_RECENT;

  const windowRaw = finiteNumber(input.modelContextWindow);
  const modelContextWindow = windowRaw !== null && windowRaw > 0 ? Math.floor(windowRaw) : BASE_WINDOW;

  const observedRaw = finiteNumber(input.observedAvgTurnTokens);
  const observedAvgTurnTokens = observedRaw !== null && observedRaw > 0 ? Math.floor(observedRaw) : 0;

  const streakRaw = finiteNumber(input.consecutiveCompactions);
  const streak = streakRaw !== null && streakRaw > 0 ? Math.floor(streakRaw) : 0;

  const pressureRaw = finiteNumber(input.pressure);
  const pressure = pressureRaw !== null ? pressureRaw : 0;

  const reasons: string[] = [];

  /* 规则 1：小窗口 ⇒ consider 提前（大窗口不动，保证「窗口越大阈值不降」）。 */
  let windowPenalty = 0;
  if (modelContextWindow < BASE_WINDOW) {
    windowPenalty = round3((1 - modelContextWindow / BASE_WINDOW) * MAX_WINDOW_PENALTY);
    if (windowPenalty > 0) {
      reasons.push(`窗口 ${modelContextWindow} < ${BASE_WINDOW} ⇒ consider -${windowPenalty.toFixed(3)}`);
    }
  }

  /* 规则 2：单轮体量大 ⇒ consider 提前（只认调用方观测到的增量，不重算压力）。 */
  let turnShare = 0;
  let turnPenalty = 0;
  if (observedAvgTurnTokens > 0) {
    turnShare = observedAvgTurnTokens / modelContextWindow;
    if (turnShare > TURN_SHARE_FREE) {
      const ratio = Math.min(1, (turnShare - TURN_SHARE_FREE) / (TURN_SHARE_FULL - TURN_SHARE_FREE));
      turnPenalty = round3(ratio * MAX_TURN_PENALTY);
      if (turnPenalty > 0) {
        reasons.push(
          `单轮观测 ${observedAvgTurnTokens} tokens 占窗口 ${(turnShare * 100).toFixed(1)}%` +
            `（> ${(TURN_SHARE_FREE * 100).toFixed(0)}%）⇒ consider -${turnPenalty.toFixed(3)}`,
        );
      }
    }
  }

  /* 规则 3：连压 ≥2 ⇒ hard 提前（救援信号；只降不升）。 */
  let streakPenalty = 0;
  if (streak >= STREAK_FREE) {
    streakPenalty = round3(Math.min(MAX_STREAK_PENALTY, (streak - 1) * STREAK_STEP));
    if (streakPenalty > 0) {
      reasons.push(`连压 ${streak} ≥ ${STREAK_FREE} ⇒ hard -${streakPenalty.toFixed(3)}`);
    }
  }

  const consider = round3(Math.min(baseConsider, Math.max(CONSIDER_FLOOR, baseConsider - windowPenalty - turnPenalty)));
  const hard = round3(Math.min(baseHard, Math.max(consider + HARD_GAP, baseHard - streakPenalty)));
  const adjusted = consider !== baseConsider || hard !== baseHard;

  const reason = adjusted
    ? `${reasons.join("；")}；当前压力 ${pressure.toFixed(3)} ⇒ ` +
      `consider ${consider.toFixed(3)} / hard ${hard.toFixed(3)} / keepRecent ${baseKeepRecent}`
    : `默认值：consider ${baseConsider.toFixed(3)} / hard ${baseHard.toFixed(3)} / keepRecent ${baseKeepRecent}` +
      `（窗口 ${modelContextWindow}、单轮观测 ${observedAvgTurnTokens}、连压 ${streak} 均未触发调整；当前压力 ${pressure.toFixed(3)}）`;

  return {
    consider,
    hard,
    keepRecent: baseKeepRecent,
    reason,
    adjusted,
    modelContextWindow,
    observedAvgTurnTokens,
  };
}
