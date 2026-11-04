/**
 * 子代理启动闸门（第 186 波，长尾效率）。
 *
 * 真机证据：`repo-06` 一轮里出现约 166 次 subagent、982 次 glob、2550 次 bash，
 * 但主循环只记录 283 次工具调用 —— 差额来自子代理各自又做了一整套搜索/测试。
 * 结果总 token 被放大到 104M，而 DSH 只有 35.9M。
 *
 * 这里只做**启动侧**的两件事，不改变已完成子代理的结果：
 *   1. 同一父会话在窗口内最多启动 N 个（默认 8 / 10 分钟）；
 *   2. 完全相同的 prompt 在窗口内不重复派生，直接告诉调用方复用已有子代理。
 *
 * 为什么不做"最多 N 个存活"：存活数要等 runtime settlement，且后台/front 的
 * 生命周期不同；把启动量按窗口限住已经能挡住"每轮又派生一批"的放大，同时
 * 不误杀真正需要多个独立子任务的回合。并发存活上限由调用侧用
 * `runtime.listChildren()` 再挡一层（见 `subagent-tools.ts`）。
 *
 * 这是纯状态机：时间由调用方传入，判据不需要 sleep。
 */

export interface SubagentAdmissionLimits {
  /** 同一父会话在一个窗口内最多启动多少次 */
  maxStartsPerWindow: number;
  /** 窗口长度（毫秒） */
  windowMs: number;
  /** 相同 prompt 的去重窗口（毫秒） */
  duplicateWindowMs: number;
}

export const DEFAULT_SUBAGENT_ADMISSION_LIMITS: SubagentAdmissionLimits = {
  maxStartsPerWindow: 8,
  windowMs: 10 * 60 * 1000,
  duplicateWindowMs: 10 * 60 * 1000,
};

export interface SubagentAdmissionDecision {
  ok: boolean;
  /** 拒绝时给模型看的具体原因（可行动，不是泛泛的 "denied"） */
  reason?: string;
  /** 同 prompt 已存在的启动时间，供调用方提示复用 */
  duplicateAt?: number;
}

interface ParentState {
  starts: number[];
  prompts: Map<string, number>;
}

/** 纯状态机；`now` 可由调用方注入，便于判据与跨时区测试 */
export class SubagentAdmission {
  private readonly limits: SubagentAdmissionLimits;
  private readonly parents = new Map<string, ParentState>();

  constructor(limits: Partial<SubagentAdmissionLimits> = {}) {
    this.limits = { ...DEFAULT_SUBAGENT_ADMISSION_LIMITS, ...limits };
  }

  /**
   * 检查是否允许启动，不记账。调用方通过后再调用 `record()`。
   * 允许"检查 → 启动失败 → 不记账"的形态，避免一次失败把预算吃掉。
   */
  check(parentKey: string, prompt: string, now = Date.now()): SubagentAdmissionDecision {
    const state = this.stateOf(parentKey, now);
    const normalized = normalizePrompt(prompt);

    const duplicateAt = state.prompts.get(normalized);
    if (duplicateAt !== undefined && now - duplicateAt < this.limits.duplicateWindowMs) {
      return {
        ok: false,
        duplicateAt,
        reason:
          `相同任务的子代理刚刚启动过（${Math.max(0, Math.round((now - duplicateAt) / 1000))}s 前），` +
          `不要重复派生；用 send_message 复用那个子代理，或直接在主循环完成。`,
      };
    }

    if (state.starts.length >= this.limits.maxStartsPerWindow) {
      const oldest = state.starts[0] ?? now;
      const waitSec = Math.max(1, Math.ceil((this.limits.windowMs - (now - oldest)) / 1000));
      return {
        ok: false,
        reason:
          `本窗口内已启动 ${state.starts.length} 个子代理（上限 ${this.limits.maxStartsPerWindow}）；` +
          `请先复用已有结果/在主循环完成，约 ${waitSec}s 后再试。`,
      };
    }

    return { ok: true };
  }

  /** 记录一次实际启动。必须只在启动成功后调用。 */
  record(parentKey: string, prompt: string, now = Date.now()): void {
    const state = this.stateOf(parentKey, now);
    state.starts.push(now);
    state.prompts.set(normalizePrompt(prompt), now);
  }

  /** 当前窗口内的启动数（日志/测试用） */
  recentStarts(parentKey: string, now = Date.now()): number {
    return this.stateOf(parentKey, now).starts.length;
  }

  /** 清空所有会话（测试/进程退出用） */
  reset(): void {
    this.parents.clear();
  }

  private stateOf(parentKey: string, now: number): ParentState {
    let state = this.parents.get(parentKey);
    if (!state) {
      state = { starts: [], prompts: new Map() };
      this.parents.set(parentKey, state);
    }
    const cutoff = now - Math.max(this.limits.windowMs, this.limits.duplicateWindowMs);
    state.starts = state.starts.filter((at) => at > cutoff);
    for (const [prompt, at] of state.prompts) {
      if (at <= cutoff) state.prompts.delete(prompt);
    }
    return state;
  }
}

function normalizePrompt(prompt: string): string {
  return String(prompt ?? "").replace(/\s+/g, " ").trim();
}

let singleton: SubagentAdmission | null = null;

export function getSubagentAdmission(): SubagentAdmission {
  if (!singleton) singleton = new SubagentAdmission();
  return singleton;
}

/** 运行时切换（测试或多个引擎并存）时重置，避免跨会话污染 */
export function resetSubagentAdmission(): void {
  singleton = null;
}
