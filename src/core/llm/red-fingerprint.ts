/**
 * 红判据指纹（第 186 波 · 长尾收敛）。
 *
 * 真机 repo-06 的形态：它不是"零信息增益"（一直在读新文件，所以 RepeatGuard/StallGuard
 * 都不会停），但**同一组判据反复红、期间没有改过文件**。这属于"验证在重复、实现没动"，
 * 是比"没信息"更具体、也更可证明的停滞信号。
 *
 * 本模块只做纯状态机：
 *   · 同一组红判据 + 没有发生写操作 + 这一轮确实跑过测试 ⇒ 连续计数；
 *   · 红判据集合变化、发生写操作、或没跑测试 ⇒ 不增加计数（集合变化则重置）；
 *   · `askAfter` 次 ⇒ 注入一次可行动自查，不打断；
 *   · `stopAfter` 次 ⇒ 调用方结束为 `blocked`（**绝不能是 completed**）。
 *
 * 阈值刻意比 StallGuard 小（4/12），因为它要求"没有写 + 同一组红"，
 * 比"没有新信息"更硬；但仍给一次 ask 与较长窗口，避免误杀"正在读代码找根因"。
 */
export interface RedFingerprintSignal {
  /** 当前仍红的判据文件（排序前的原始集合即可） */
  redFiles: readonly string[];
  /** 工作区写版本号：每次真实写操作 +1；变了就重置连续计数 */
  mutationRevision: number;
  /** 这一轮是否真的跑过测试；没跑就不计数 */
  ranTests: boolean;
}

/**
 * @public 对外动作联合类型（`RedFingerprintDecision.action` 的公开形状）。
 * 只在声明处出现是正常的：消费方用 `RedFingerprintDecision`，但类型别名是 API 面的一部分。
 */
export type RedFingerprintAction = "none" | "ask" | "stop";

export interface RedFingerprintDecision {
  action: RedFingerprintAction;
  /** 连续多少次"同一组红 + 无写" */
  streak: number;
  /** 当前红判据（排序后的稳定键，日志/文案用） */
  key: string;
  message?: string;
}

export interface RedFingerprintLimits {
  askAfter: number;
  stopAfter: number;
}

export const DEFAULT_RED_FINGERPRINT_LIMITS: RedFingerprintLimits = {
  askAfter: 4,
  stopAfter: 12,
};

export class RedFingerprintGuard {
  private readonly limits: RedFingerprintLimits;
  private lastKey: string | null = null;
  private lastMutationRevision: number | null = null;
  private streak = 0;
  private asked = false;

  constructor(limits: Partial<RedFingerprintLimits> = {}) {
    this.limits = { ...DEFAULT_RED_FINGERPRINT_LIMITS, ...limits };
  }

  reset(): void {
    this.lastKey = null;
    this.lastMutationRevision = null;
    this.streak = 0;
    this.asked = false;
  }

  get currentStreak(): number {
    return this.streak;
  }

  note(signal: RedFingerprintSignal): RedFingerprintDecision {
    const redFiles = [...new Set(signal.redFiles.map((f) => String(f).replace(/\\/g, "/")))].sort();
    const key = redFiles.join("\u0000");

    // 没跑测试 / 没有红判据 ⇒ 不是"反复验证同一组红"，重置观察窗口。
    if (!signal.ranTests || redFiles.length === 0) {
      this.reset();
      return { action: "none", streak: 0, key };
    }

    const workspaceChanged = this.lastMutationRevision !== null && this.lastMutationRevision !== signal.mutationRevision;
    if (this.lastKey === null || key !== this.lastKey || workspaceChanged) {
      this.lastKey = key;
      this.lastMutationRevision = signal.mutationRevision;
      this.streak = 1;
      this.asked = false;
      return { action: "none", streak: 1, key };
    }

    this.streak++;

    if (this.streak >= this.limits.stopAfter) {
      return {
        action: "stop",
        streak: this.streak,
        key,
        message:
          `同一组判据连续 ${this.streak} 次仍是红的，而且期间**没有改过任何文件**。\n` +
          `继续重复跑同一组测试不会带来新信息；请人工确认下一步，或换一个**不同的**根因/实验。`,
      };
    }

    if (!this.asked && this.streak >= this.limits.askAfter) {
      this.asked = true;
      return {
        action: "ask",
        streak: this.streak,
        key,
        message:
          `[SYSTEM REMINDER — 判据停滞] 同一组判据已经连续 ${this.streak} 次是红的，` +
          `而且期间没有改过文件（红判据：${redFiles.join(", ")}）。\n` +
          `不要继续用同样的方式跑同一组测试。请先说明：\n` +
          `  1) 你现在的根因假设是什么？\n` +
          `  2) 下一步要改哪一个具体点，为什么它能让这组红转绿？\n` +
          `然后改文件、再验证；如果判断任务无法完成，明确说明阻塞原因。`,
      };
    }

    return { action: "none", streak: this.streak, key };
  }
}
