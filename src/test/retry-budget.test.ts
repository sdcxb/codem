/**
 * `RETRY-BUDGET-1/2`：重试的**最坏路径**必须落在声明的预算内，且预算用尽必须**用户可见**
 * （第 191 波 O-41 的可判据那一半）。
 *
 * ## 背景（O-41）
 *
 * `DEFAULT_RETRY_CONFIG` 是 `maxAttempts: 10` / `baseDelay: 500ms` / `×2` / 单次上限 5 分钟 /
 * **总预算 30 分钟**。用户等待的**最坏路径**由两部分组成：
 * ① 退避等待之和（可精确算）；② 每次请求本身的耗时（不可预估，只能靠**墙钟预算**兜住）。
 *
 * 旧形态的两个缺口：
 * - 没有任何判据把 ① 与声明的预算放在一起核对（"30 分钟"名义很大、实际很少触到 —— 真正
 *   触到它的是**请求本身很慢**的情形，`totalTimeout` 在墙钟上强制）；
 * - 预算用尽只有一句 `console.warn`（打包版里用户看不到），界面上只剩最后那个 provider
 *   错误 —— 用户不知道"我们已经重试了 9 次、把预算用完了"（`RETRY-BUDGET-2`）。
 *
 * ⚠️ **不变量**：默认值本身是**产品决策**（O-41 要求先出证据再向用户请示），所以本文件
 * **不**改默认值，只钉"最坏等待 ≤ 声明预算"与"预算用尽必须可见"两条。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { RetryExecutor, type RetryConfig } from "../core/retry/retry";
import { getPersistFailures, resetPersistFailures } from "../core/storage/persist-failure";

/** 只有 sleep 参与（用假定时器把退避压缩掉），用来精确量"退避等待之和" */
const failing = () => {
  const err = new Error("at capacity") as Error & { status?: number };
  err.status = 529;
  return err;
};

afterEach(() => {
  vi.useRealTimers();
  resetPersistFailures();
});

describe("RETRY-BUDGET：最坏路径与预算一致性（O-41）", () => {
  it("RETRY-BUDGET-1a: 默认配置下「退避等待之和」必须 ≤ 声明的总预算（把两个口径放在一起算）", async () => {
    vi.useFakeTimers();
    const exec = new RetryExecutor();
    const cfg = exec.getConfig() as RetryConfig;
    expect(cfg.maxAttempts).toBe(10);
    expect(cfg.baseDelay).toBe(500);
    expect(cfg.backoffMultiplier).toBe(2);
    expect(cfg.totalTimeout).toBe(30 * 60_000);

    /*
     * `maxAttempts = 10` ⇒ 最多 **9** 次重试（第 10 次失败后 `shouldRetry` 为假）。
     * delay(attempt) = min(base × multiplier^attempt, maxDelay)，attempt 从 0 起。
     */
    let sum = 0;
    const delays: number[] = [];
    for (let attempt = 0; attempt < cfg.maxAttempts - 1; attempt++) {
      const d = exec.getDelay(attempt);
      delays.push(d);
      sum += d;
    }
    // 逐条与公式核对（防"算错了却看起来对"）
    expect(delays).toEqual([500, 1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 128_000]);
    expect(sum, "退避等待之和（255.5s ≈ 4.26 分钟）必须落在 30 分钟预算内").toBe(255_500);
    expect(sum).toBeLessThan(cfg.totalTimeout);
    // 单次退避都不许超过 maxDelay（5 分钟）
    for (const d of delays) expect(d).toBeLessThanOrEqual(cfg.maxDelay);

    // 走一遍真实流程（假定时器快进）：请求次数 = maxAttempts，重试事件 = maxAttempts - 1
    let calls = 0;
    const p = exec.execute(async () => {
      calls++;
      throw failing();
    });
    const settled = p.catch((e) => e as Error);
    await vi.advanceTimersByTimeAsync(sum + 60_000);
    const err = await settled;
    expect(err.message).toBe("at capacity");
    expect(calls, "默认配置下最多请求 maxAttempts 次（不是无限重试）").toBe(cfg.maxAttempts);
    expect(exec.getState().totalWaitTime, "累计等待恰好等于退避之和").toBe(sum);
  });

  it("RETRY-BUDGET-1b: 墙钟预算是硬约束 —— 请求本身很慢时由它兜住（不许只看 sleep）", async () => {
    vi.useFakeTimers();
    // 单次请求 6 分钟（假定时器快进）⇒ 第 3 次之前总预算（10 分钟）就该耗尽
    const exec = new RetryExecutor({ maxAttempts: 10, totalTimeout: 10 * 60_000, baseDelay: 1 });
    let calls = 0;
    const p = exec.execute(async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 6 * 60_000));
      throw failing();
    });
    const settled = p.catch((e) => e as Error);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    await settled;
    expect(calls, "墙钟预算 10 分钟 + 每次请求 6 分钟 ⇒ 最多 2 次（sleep 口径会允许 10 次）").toBe(2);
  });

  it("RETRY-BUDGET-1c: Retry-After 受单次上限约束（不许拿一个超大值跳过预算）", () => {
    const exec = new RetryExecutor();
    expect(exec.getDelay(0, 60 * 60_000), "Retry-After 一小时也要夹到 maxDelay（5 分钟）").toBe(5 * 60_000);
    expect(exec.getDelay(0, 3_000), "正常 Retry-After 原样使用").toBe(3_000);
  });

  it("RETRY-BUDGET-2: 预算用尽必须**用户可见**（action 通道），不是只有一句 console", async () => {
    vi.useFakeTimers();
    resetPersistFailures();
    const exec = new RetryExecutor({ maxAttempts: 5, totalTimeout: 1, baseDelay: 1 });
    const p = exec.execute(async () => {
      throw failing();
    });
    const settled = p.catch((e) => e as Error);
    await vi.advanceTimersByTimeAsync(10_000);
    await settled;

    const site = getPersistFailures().find((f) => f.area === "loop.retryBudget");
    expect(site, "预算用尽必须走上报表（否则打包版里用户看不到原因）").toBeTruthy();
    expect(site!.kind, "它是「这一回合没有完成」（action），不是写盘失败").toBe("action");
    expect(site!.lastMessage, "要说清是**预算**用尽，而不是笼统的 provider 错误").toMatch(/重试预算已用尽/);
  });
});
