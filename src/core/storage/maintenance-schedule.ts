/**
 * **维护任务的空闲闸**（第 46 波 ✓，治本 ✓ 不靠提示词 ✗）。
 *
 * ## 修的是什么（真机取证 ✓）
 *
 * `App.tsx` 原来在 DB 就绪时**立刻**跑 `runDatabaseMaintenance()` ✓（`void (async …)()` ✓）。
 * 它虽然没被 await ✓，但跑在**同一条 JS 线程**上 ✓ ⇒ 与**第一个回合**并发 ✗。
 *
 * 侧车时间线取证 ✓（24 个侧车 ✓，只看到发请求之前的那段 ✓）：
 *   · 每格前半段**最大静默**合计 **158s ≈ 6.6s/格** ✓，而它们都夹在这些行之间 ✗：
 *       `[Maintenance] 会话计数对账：检查 492 个、修正 1 个` ✓（11s / 5s ✗）
 *       `[IpcTrace] storage.compact params={}` ✓（12s / 6s ✗）
 *       `[Store] saveMessages: …跳过未变化 N 条` ✓（32s / 10s ✗）
 *   · 同一批的 `llm timing` 里 `ctx` 合计 **602s** ✓（其中 `prep` 590s ✓）——
 *     按"只算 LLM + 工具"的老账，这 **~7.5% 墙钟**会被**整段漏掉** ✗
 *   ⇒ ★ 结论 ✓：**库维护跑在了关键路径上** ✗ —— 它既不是 LLM 也不是工具 ✓，是我们自己的账 ✓
 *
 * ## 修法（结构性 ✓）
 *
 * 维护是**后台维护** ✓，没有任何理由与"用户正在等的第一个回合"抢线程 ✗
 *   ⇒ 加一道**空闲闸** ✓：**没有任何回合在跑**时才开跑 ✓；若正在跑 ⇒ 退避重试 ✓。
 *   ⇒ 对照 DSH ✓：`dsh-workspace-changes` 那类簿记也都挂在**轮次边界**上 ✓，
 *     而不是"开机就抢"✓；本项与 A/B 同属"把非关键路径的东西挪出关键路径"✓。
 *
 * ## 为什么抽成模块 ✓
 *   · 纯逻辑 + 注入依赖 ✓ ⇒ 可以用行为判据钉住 ✓（App.tsx 没有便宜的整机夹具 ✗）
 *   · 判据要能证明**"有回合在跑时绝不启动"** ✓（这正是 bug 的形状 ✓）
 */

export interface IdleGateDeps {
  /** 现在有没有回合在跑（流式中）✓ */
  isBusy: () => boolean;
  /** 睡一会儿 ✓（注入以便判据里用假时钟 ✓） */
  sleep: (ms: number) => Promise<void>;
  /** 现在时刻（ms ✓） */
  now: () => number;
}

export interface IdleGateOptions {
  /** 退避步长（ms ✓）。默认 2s ✓ */
  stepMs?: number;
  /** 等待上限（ms ✓）。默认 10 分钟 ✓ —— 到点仍忙就**照样开跑** ✓（维护不能被饿死 ✓） */
  maxWaitMs?: number;
  /** 忙时先多等一会儿，避免"刚结束一个回合又立刻开新回合"的抖动 ✓。默认 3s ✓ */
  settleMs?: number;
}

export interface IdleGateResult {
  /** 是否等到了空闲 ✓（false = 等超时了，按"照样开跑"处理 ✓） */
  idle: boolean;
  /** 实际等待了多久 ✓ */
  waitedMs: number;
}

/**
 * 等到"没有回合在跑"✓。语义刻意保守 ✓：
 *   · 忙 ⇒ 退避后重试 ✓（绝不在忙的时候开跑 ✗）
 *   · 超过 `maxWaitMs` ⇒ 返回 `{ idle: false }` ✓，由调用方决定**照样跑** ✓（不饿死维护 ✓）
 */
export async function waitForIdle(deps: IdleGateDeps, opts: IdleGateOptions = {}): Promise<IdleGateResult> {
  const stepMs = opts.stepMs && opts.stepMs > 0 ? opts.stepMs : 2_000;
  const maxWaitMs = opts.maxWaitMs && opts.maxWaitMs > 0 ? opts.maxWaitMs : 10 * 60_000;
  const settleMs = opts.settleMs && opts.settleMs >= 0 ? opts.settleMs : 3_000;
  const t0 = deps.now();
  for (;;) {
    const waited = deps.now() - t0;
    if (!deps.isBusy()) {
      /**
       * 再"静一静"一下 ✓：如果 settle 之后仍然空闲 ⇒ 才算真空闲 ✓。
       * 为什么 ✓：维护是**重活** ✓，若刚好卡在"上一回合结束、下一回合还没开始"的缝隙里开跑 ✗，
       * 下一个回合就会与它并发 ✗ —— 那正是本 bug 的形状 ✓。
       */
      if (settleMs > 0) {
        await deps.sleep(settleMs);
        if (deps.isBusy()) {
          if (deps.now() - t0 >= maxWaitMs) return { idle: false, waitedMs: deps.now() - t0 };
          continue;
        }
      }
      return { idle: true, waitedMs: deps.now() - t0 };
    }
    if (waited >= maxWaitMs) return { idle: false, waitedMs: waited };
    await deps.sleep(stepMs);
  }
}
