/**
 * 25 号文 P2：**自适应 steward 策略**的判据（SP-1..SP-8）。
 *
 * ## 守什么
 *
 * 1. **默认完全等价旧值**：`resolveStewardPolicy({})` 必须是 0.7 / 0.9 / 20；
 *    `decideEpochAction` 在默认输入下（含 threshold / hardThreshold / 连压）的
 *    **action 与 reason 都要与拆分前的实现逐字一致**（本文件内用一份冻结的旧实现做对照）。
 * 2. **窗口越大阈值不降**：小窗口把 consider 往下拉（最多 0.10），大窗口（≥128k）不动；
 *    窗口阶梯上 consider 必须单调不降。
 * 3. **大单轮提前**：单轮观测 > 窗口 10% 才调整，约 30% 到顶（−0.10），并有 0.55 硬下限。
 * 4. **连压 ≥2 提前 hard**：2 次 → 0.88，3 次 → 0.86，≥5 次 → 0.85（只降不升）。
 * 5. **可注入**：给 `policy` 时 `decideEpochAction` 用它；不给时按 `threshold`/观测现算。
 *
 * ## 变异自证（把实现改坏，判据必须红）
 *
 * - 忽略观测（`observedAvgTurnTokens` 不参与 consider）⇒ SP-4 / SP-7 红；
 * - 让大窗口也降阈值（窗口方向写反）⇒ SP-2 / SP-3 红；
 * - 连压不降 hard ⇒ SP-5 红；
 * - 默认值改成 0.8 / 0.95 / 12（或给默认 reason 拼上「自适应」）⇒ SP-1 / SP-2 红。
 */
import { describe, it, expect } from "vitest";
import { resolveStewardPolicy } from "../core/context/steward-policy";
import { decideEpochAction, type EpochDecisionInput } from "../core/context/segment-switch";

/**
 * **冻结的旧实现**（引入 P2 之前 `decideEpochAction` 的逐字副本）。
 *
 * 为什么要在判据里抄一份：默认等价性不能靠「我觉得没改」——
 * 它必须能与一份**不随实现演进的对照**逐字比较。这份副本只服务本文件，
 * 产品代码不许 import 它（判据文件不在 knip 的 project 里）。
 */
function legacyDecide(input: EpochDecisionInput): { action: string; reason: string } {
  const threshold = Number.isFinite(input.threshold) ? Number(input.threshold) : 0.7;
  const hard = Number.isFinite(input.hardThreshold) ? Number(input.hardThreshold) : 0.9;
  const pressure = Number.isFinite(input.pressure) ? Number(input.pressure) : 0;
  const streak = Math.max(0, Math.floor(Number(input.consecutiveCompactions) || 0));
  const turnCompleted = input.turnCompleted === true;
  if (pressure >= hard) {
    return { action: "switch", reason: `pressure ${pressure.toFixed(3)} >= hard ${hard}` };
  }
  if (!turnCompleted && pressure < threshold) {
    return { action: "none", reason: `pressure ${pressure.toFixed(3)} < consider ${threshold}` };
  }
  if (streak >= 2) {
    return { action: "switch", reason: `after ${streak} consecutive compactions` };
  }
  if (!turnCompleted) {
    return { action: "compact", reason: `mid-turn (not completed) at pressure ${pressure.toFixed(3)}` };
  }
  if (pressure < threshold) {
    return {
      action: "none",
      reason: `completed below consider ${threshold} at pressure ${pressure.toFixed(3)}`,
    };
  }
  return {
    action: "switch",
    reason: `completed turn at pressure ${pressure.toFixed(3)} >= consider ${threshold}`,
  };
}

describe("SP-1：默认值就是旧值（0.7 / 0.9 / 20）", () => {
  it("空输入 ⇒ 0.7 / 0.9 / 20，且标记为未调整", () => {
    const policy = resolveStewardPolicy();
    expect(policy.consider).toBe(0.7);
    expect(policy.hard).toBe(0.9);
    expect(policy.keepRecent).toBe(20);
    expect(policy.adjusted).toBe(false);
    expect(policy.modelContextWindow).toBe(128_000);
    expect(policy.observedAvgTurnTokens).toBe(0);
  });

  it("配置基线原样透传：threshold=0.8 / keepRecent=12 / hard=0.95 时不因默认值被改写", () => {
    const policy = resolveStewardPolicy({ baseConsider: 0.8, baseHard: 0.95, baseKeepRecent: 12 });
    expect(policy.consider).toBe(0.8);
    expect(policy.hard).toBe(0.95);
    expect(policy.keepRecent).toBe(12);
    expect(policy.adjusted).toBe(false);
  });
});

describe("SP-2：默认输入下 decideEpochAction 与旧实现逐字一致", () => {
  it("压力 × 完成态 × 连压 × threshold 的网格：action 恒等；无调整时 reason 也恒等", () => {
    const pressures = [0, 0.01, 0.2, 0.5, 0.69, 0.7, 0.75, 0.89, 0.9, 0.93, 1];
    const thresholds = [0.7, 0.8];
    const streaks = [0, 1, 2, 3];
    const completions = [false, true];
    for (const pressure of pressures) {
      for (const threshold of thresholds) {
        for (const streak of streaks) {
          for (const turnCompleted of completions) {
            const input: EpochDecisionInput = { pressure, threshold, turnCompleted, consecutiveCompactions: streak };
            const expected = legacyDecide(input);
            const actual = decideEpochAction(input);
            /**
             * 连压 ≥2 时 P2 会下调 hard（0.9 → 0.88/0.86/0.85）——这是**有意的调整**，
             * 但它不能改变动作：旧实现本来就在连压 ≥2 时 switch，所以 action 必须逐点相同。
             * reason 的逐字等价只在「没有调整」时要求（连压 <2 且窗口/观测都是默认）。
             */
            expect(actual.action, `默认输入下 action 必须与旧实现一致：${JSON.stringify(input)}`).toBe(expected.action);
            if (streak < 2) {
              expect(actual.reason, `未调整时 reason 必须逐字一致：${JSON.stringify(input)}`).toBe(expected.reason);
            }
          }
        }
      }
    }
  });

  it("连压 2/3 时 action 与旧实现相同（hard 下调只改救援时机，不改结果）", () => {
    for (const pressure of [0, 0.5, 0.75, 0.89, 0.93]) {
      for (const turnCompleted of [false, true]) {
        for (const streak of [2, 3]) {
          const input: EpochDecisionInput = { pressure, turnCompleted, consecutiveCompactions: streak };
          expect(decideEpochAction(input).action, JSON.stringify(input)).toBe(legacyDecide(input).action);
        }
      }
    }
  });

  it("显式 hardThreshold 也按基线使用（0.7 / 0.8 两档对照）", () => {
    for (const hardThreshold of [0.7, 0.8, 0.95]) {
      const input: EpochDecisionInput = { pressure: 0.75, turnCompleted: true, hardThreshold };
      expect(decideEpochAction(input)).toEqual(legacyDecide(input));
    }
  });
});

describe("SP-3：小窗口提前、大窗口不变（窗口越大阈值不降）", () => {
  it("窗口阶梯上 consider 单调不降；≥128k 一律回到 0.7", () => {
    const windows = [8_000, 24_000, 64_000, 128_000, 200_000, 1_000_000];
    const consider = windows.map((window) => resolveStewardPolicy({ modelContextWindow: window }).consider);
    for (let i = 1; i < consider.length; i += 1) {
      expect(consider[i], `窗口 ${windows[i]} 的 consider 不许低于更小窗口 ${windows[i - 1]}`).toBeGreaterThanOrEqual(
        consider[i - 1],
      );
    }
    expect(consider[0], "小窗口必须提前 consider").toBeLessThan(0.7);
    expect(consider.slice(3), "≥128k 必须与默认完全一致").toEqual([0.7, 0.7, 0.7]);
  });

  it("24k 窗口：consider < 0.7 但 hard 仍是 0.9（窗口只调 consider）", () => {
    const policy = resolveStewardPolicy({ modelContextWindow: 24_000 });
    expect(policy.consider).toBeLessThan(0.7);
    expect(policy.consider).toBeGreaterThanOrEqual(0.55);
    expect(policy.hard).toBe(0.9);
    expect(policy.adjusted).toBe(true);
    expect(policy.reason).toContain("窗口");
  });

  it("大窗口（1M）不调整，reason 不出现「自适应」", () => {
    const policy = resolveStewardPolicy({ modelContextWindow: 1_000_000 });
    expect(policy).toMatchObject({ consider: 0.7, hard: 0.9, keepRecent: 20, adjusted: false });
    expect(decideEpochAction({ pressure: 0.68, turnCompleted: false, policy }).action).toBe("none");
  });
});

describe("SP-4：单轮观测大 ⇒ consider 提前（有下限）", () => {
  it("≤ 窗口 10% 不调整；越大越低；30%+ 到顶但仍 ≥0.55", () => {
    const window = 128_000;
    expect(resolveStewardPolicy({ modelContextWindow: window, observedAvgTurnTokens: 12_800 }).adjusted).toBe(false);
    const mid = resolveStewardPolicy({ modelContextWindow: window, observedAvgTurnTokens: 25_600 }); // 20%
    const big = resolveStewardPolicy({ modelContextWindow: window, observedAvgTurnTokens: 40_000 }); // 31%
    expect(mid.consider).toBeLessThan(0.7);
    expect(big.consider).toBeLessThan(mid.consider);
    expect(big.consider).toBeGreaterThanOrEqual(0.55);
    expect(mid.reason).toContain("单轮观测");
  });

  it("极端观测 + 小窗口 ⇒ 只到下限 0.55，且 hard 仍高于 consider", () => {
    const policy = resolveStewardPolicy({ modelContextWindow: 8_000, observedAvgTurnTokens: 8_000 });
    expect(policy.consider).toBe(0.55);
    expect(policy.hard).toBeGreaterThan(policy.consider);
  });

  it("观测为 0 / 缺失 ⇒ 不做单轮调整（不把「上下文多大」当单轮体量）", () => {
    expect(resolveStewardPolicy({ modelContextWindow: 128_000, observedAvgTurnTokens: 0 }).adjusted).toBe(false);
  });
});

describe("SP-5：连压 ≥2 ⇒ hard 提前（只降不升）", () => {
  it("0/1 次不动；2 次 0.88；3 次 0.86；≥5 次 0.85", () => {
    expect(resolveStewardPolicy({ consecutiveCompactions: 0 }).hard).toBe(0.9);
    expect(resolveStewardPolicy({ consecutiveCompactions: 1 }).hard).toBe(0.9);
    expect(resolveStewardPolicy({ consecutiveCompactions: 2 }).hard).toBe(0.88);
    expect(resolveStewardPolicy({ consecutiveCompactions: 3 }).hard).toBe(0.86);
    expect(resolveStewardPolicy({ consecutiveCompactions: 5 }).hard).toBe(0.85);
    expect(resolveStewardPolicy({ consecutiveCompactions: 50 }).hard).toBe(0.85);
  });

  it("0.89 的中途：默认 hard 0.9 只压缩；连压 2 的 hard 0.88 让它走 hard 救援", () => {
    const baseline = decideEpochAction({ pressure: 0.89, turnCompleted: false });
    expect(baseline.action, "前提：默认 0.89 < 0.9 ⇒ 中途只压缩").toBe("compact");
    const streakPolicy = resolveStewardPolicy({ consecutiveCompactions: 2 });
    const rescued = decideEpochAction({ pressure: 0.89, turnCompleted: false, policy: streakPolicy });
    expect(rescued.action, "连压把 hard 降到 0.88 ⇒ 0.89 应当被救援换段").toBe("switch");
    expect(rescued.reason).toContain("hard");
  });
});

describe("SP-6：注入策略真的改变决策（提前但不越界）", () => {
  it("24k 窗口策略：0.65 的中途从 none 变 compact；0.65 的完成态从 none 变 switch", () => {
    const policy = resolveStewardPolicy({ modelContextWindow: 24_000 });
    expect(decideEpochAction({ pressure: 0.65, turnCompleted: false }).action).toBe("none");
    expect(decideEpochAction({ pressure: 0.65, turnCompleted: false, policy }).action).toBe("compact");
    expect(decideEpochAction({ pressure: 0.65, turnCompleted: true }).action).toBe("none");
    expect(decideEpochAction({ pressure: 0.65, turnCompleted: true, policy }).action).toBe("switch");
  });

  it("直接给观测（不经 policy）也生效：0.61 的完成态 + 40000 单轮 ⇒ switch", () => {
    expect(decideEpochAction({ pressure: 0.61, turnCompleted: true }).action).toBe("none");
    const adjusted = decideEpochAction({
      pressure: 0.61,
      turnCompleted: true,
      modelContextWindow: 128_000,
      observedAvgTurnTokens: 40_000,
    });
    expect(adjusted.action).toBe("switch");
    expect(adjusted.reason, "调整过就必须能解释").toContain("自适应");
  });
});

describe("SP-7：reason 可审计，默认 reason 逐字不变", () => {
  it("未调整 ⇒ reason 不含「自适应」；调整 ⇒ 含窗口/观测/连压与最终阈值", () => {
    expect(decideEpochAction({ pressure: 0.75, turnCompleted: false }).reason).not.toContain("自适应");
    const adjusted = decideEpochAction({ pressure: 0.75, turnCompleted: false, modelContextWindow: 24_000 });
    expect(adjusted.reason).toContain("自适应");
    expect(adjusted.reason).toContain("consider");
    expect(adjusted.reason).toContain("hard");
    expect(adjusted.reason).toContain("0.619");
  });
});
