/**
 * 网关 run 归属表（ADR-0005 M2 写路径第一批）。
 *
 * ## 它解决什么
 *
 * 桌面远程网关的写路径是"手机只能操作打不开第二套循环"：
 * `prompt.send` 交给渲染层的 `executeSessionTurn`（桌面唯一 Agent 循环）后
 * **立即**返回一个 `runId`；`run.cancel` 必须能凭这个 id 说清"取消的是哪一次运行"。
 * 这个模块只做三件事，执行/存储一律复用桌面既有实现（本文件不 import
 * `../llm` / `../session` / `../storage`）：
 *
 * 1. **runId 归属**：`runId → { sessionId, clientId, state }`，取消只作用于
 *    网关自己发起、且还没结束的那一次；
 * 2. **同会话单 run**：同一会话已有活动 run 时拒绝第二个，并区分"你自己的"
 *    （`BUSY`）与"别的设备的"（`RUN_OWNED`）—— 两种情况的文案不同，用户才知道
 *    是该等一下还是该去那台设备上停；
 * 3. **`requestId` 幂等**：同一条请求重发不产生第二次执行（手机断线重试很常见；
 *    再跑一遍会重复写文件）。
 *
 * ## ⚠️ `clientId` 不是鉴权
 *
 * 它来自共享 UI 的 `localStorage`（`transport.ts` 的 `getClientId()`），是**客户端
 * 自述**，可以伪造。这里只用它做归属、文案与幂等匹配；真正的安全边界是 Rust 网关
 * 的配对 cookie（`gateway/mod.rs` 的 `handle_rpc`）。不要把这里的判断当成权限判断。
 *
 * ## 为什么不做租约（lease）
 *
 * 桌面进程从不查询租约：前台回合只看 `activeExecutions`（`executor.ts`），后台回合
 * 同理。所以租约只能约束"手机之间"，不能增加"桌面是唯一写者"的保证（那是既有事实）；
 * 而共享 UI 里也**没有**接管/租约界面。先加一个没有 UI 承接的租约 = 半成品，
 * 留到需要多设备接管时再连同界面一起做。
 *
 * 本模块是纯内存、纯逻辑：可在 Node 测试里直接构造，不依赖 Tauri/存储。
 */

/** 一次网关 run 的生命周期。`running` 之外的三个都是终态。 */
type GatewayRunState = "running" | "finished" | "failed" | "cancelled";

/** 对外只读快照（调用方拿不到内部对象，避免事后被改）。 */
export interface GatewayRunSnapshot {
  runId: string;
  sessionId: string;
  /** 发起方自述标识（见文件头：**不是**鉴权） */
  clientId: string;
  /** 幂等键（`prompt.send` 的 `requestId`）；未提供时不做重发去重 */
  requestId?: string;
  state: GatewayRunState;
  startedAt: number;
  endedAt?: number;
  /** 已经收到取消请求（终态会因此落成 `cancelled`） */
  cancelRequested: boolean;
}

export interface GatewayRunClaimInput {
  sessionId: string;
  /** 发起方自述标识；缺省按空串处理（单设备/测试） */
  clientId?: string;
  /** 幂等键；同一会话 + 同一 clientId 下重发返回同一个 runId */
  requestId?: string;
}

/** `claim()` 失败原因：`INVALID` 是防御性分支（网关层已先校验），另两个是真实冲突。 */
type GatewayRunClaimFailure = "INVALID" | "BUSY" | "RUN_OWNED";

export type GatewayRunClaim =
  | { ok: true; run: GatewayRunSnapshot; deduplicated: boolean }
  | { ok: false; code: GatewayRunClaimFailure; active?: GatewayRunSnapshot };

/** `requestCancel()` 的应答：`cancelled:false` = 那次运行已经结束（没有可取消的东西）。 */
export type GatewayRunCancel =
  | { ok: true; run: GatewayRunSnapshot; cancelled: boolean }
  | { ok: false; code: "RUN_NOT_FOUND" | "RUN_OWNED"; run?: GatewayRunSnapshot };

export interface GatewayRunRegistryOptions {
  /** 保留的已完成条目上限（活动 run 永不淘汰）。默认 100。 */
  maxRuns?: number;
  /** 时钟（测试注入） */
  now?: () => number;
  /** runId 生成（测试注入） */
  newRunId?: () => string;
}

export const DEFAULT_GATEWAY_RUN_HISTORY = 100;

function normalize(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** 内部条目；对外一律经 `snapshot()`。 */
type RunEntry = GatewayRunSnapshot;

export class GatewayRunRegistry {
  private readonly runs = new Map<string, RunEntry>();
  private readonly maxRuns: number;
  private readonly now: () => number;
  private readonly newRunId: () => string;

  constructor(opts: GatewayRunRegistryOptions = {}) {
    this.maxRuns = Math.max(1, Math.trunc(opts.maxRuns ?? DEFAULT_GATEWAY_RUN_HISTORY));
    this.now = opts.now ?? (() => Date.now());
    this.newRunId =
      opts.newRunId ??
      (() => `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
  }

  /**
   * 为一次新运行占位。
   *
   * 顺序是刻意的：**先看幂等键，再看会话忙闲**。手机断线重发同一条 `requestId` 时，
   * 即使那次运行还在跑，也该拿回**同一个** runId（而不是 `BUSY`），否则界面会显示
   * "发送失败"，而桌面其实正在处理它。
   */
  claim(input: GatewayRunClaimInput): GatewayRunClaim {
    const sessionId = normalize(input.sessionId);
    const clientId = normalize(input.clientId);
    const requestId = normalize(input.requestId);
    if (!sessionId) return { ok: false, code: "INVALID" };

    if (requestId) {
      const previous = this.findByRequest(sessionId, clientId, requestId);
      if (previous) {
        return { ok: true, run: this.snapshot(previous), deduplicated: true };
      }
    }

    const active = this.activeForSession(sessionId);
    if (active) {
      return active.clientId === clientId
        ? { ok: false, code: "BUSY", active: this.snapshot(active) }
        : { ok: false, code: "RUN_OWNED", active: this.snapshot(active) };
    }

    const run: RunEntry = {
      runId: this.newRunId(),
      sessionId,
      clientId,
      ...(requestId ? { requestId } : {}),
      state: "running",
      startedAt: this.now(),
      cancelRequested: false,
    };
    this.runs.set(run.runId, run);
    this.prune();
    return { ok: true, run: this.snapshot(run), deduplicated: false };
  }

  /**
   * 请求取消一次运行。**不**在这里中止循环 —— 中止是调用方的事
   * （`cancelSessionExecution` + `closeSessionApprovals`），本模块只回答"允许不允许"。
   */
  requestCancel(input: { runId: string; clientId?: string }): GatewayRunCancel {
    const runId = normalize(input.runId);
    const clientId = normalize(input.clientId);
    const run = runId ? this.runs.get(runId) : undefined;
    if (!run) return { ok: false, code: "RUN_NOT_FOUND" };
    // 已经结束的运行没有可取消的东西：如实说"没取消"，不报错（手机晚一步点停止很常见）。
    if (run.state !== "running") return { ok: true, run: this.snapshot(run), cancelled: false };
    // 只允许发起者取消。别的设备发起的 run 由那台设备（或桌面）停 —— 这里如实拒绝，
    // 而不是"帮他停了"（那会让另一台手机的界面永远等一个被悄悄中止的结果）。
    if (run.clientId !== clientId) return { ok: false, code: "RUN_OWNED", run: this.snapshot(run) };
    run.cancelRequested = true;
    return { ok: true, run: this.snapshot(run), cancelled: true };
  }

  /**
   * 结算一次运行（回合真正结束后调用）。幂等：只有第一次生效。
   *
   * `outcome` 由调用方按回合结果给；但**只要取消过，终态就是 `cancelled`** ——
   * 被取消的回合在 executor 里也会返回 `success:false`，若按 `failed` 记账，
   * 手机上看到的会是"失败"而不是"你停的"。
   */
  finish(runId: string, outcome: "finished" | "failed"): GatewayRunSnapshot | undefined {
    const run = this.runs.get(normalize(runId));
    if (!run) return undefined;
    if (run.state !== "running") return this.snapshot(run);
    run.state = run.cancelRequested ? "cancelled" : outcome;
    run.endedAt = this.now();
    this.prune();
    return this.snapshot(run);
  }

  get(runId: string): GatewayRunSnapshot | undefined {
    const run = this.runs.get(normalize(runId));
    return run ? this.snapshot(run) : undefined;
  }

  /**
   * 只查幂等键，**不占位**。
   *
   * 为什么需要它（`claim()` 里也有同样的查询）：`prompt.send` 的预检会把
   * "这个会话正在执行"报成 `BUSY`，而重发同一条 `requestId` 时正在执行的**就是它自己** ——
   * 先做忙判定会让幂等永远失效（手机丢了一次应答，重发得到"忙"而不是同一个 runId）。
   * 所以调用方必须在忙预检**之前**先问这里。
   */
  findByRequestId(input: {
    sessionId: string;
    clientId?: string;
    requestId?: string;
  }): GatewayRunSnapshot | undefined {
    const sessionId = normalize(input.sessionId);
    const requestId = normalize(input.requestId);
    if (!sessionId || !requestId) return undefined;
    const found = this.findByRequest(sessionId, normalize(input.clientId), requestId);
    return found ? this.snapshot(found) : undefined;
  }

  /** 该会话当前活动（`running`）的 run；没有返回 `undefined`。 */
  activeForSession(sessionId: string): GatewayRunSnapshot | undefined {
    const id = normalize(sessionId);
    if (!id) return undefined;
    for (const run of this.runs.values()) {
      if (run.state === "running" && run.sessionId === id) return this.snapshot(run);
    }
    return undefined;
  }

  /** 当前活动 run 数（诊断用；与 `executor` 的 `activeExecutions` 不是同一张表）。 */
  activeCount(): number {
    let count = 0;
    for (const run of this.runs.values()) if (run.state === "running") count++;
    return count;
  }

  /** 保留条目数（测试/诊断用）。 */
  size(): number {
    return this.runs.size;
  }

  private findByRequest(
    sessionId: string,
    clientId: string,
    requestId: string,
  ): GatewayRunSnapshot | undefined {
    for (const run of this.runs.values()) {
      if (run.sessionId !== sessionId) continue;
      if (run.clientId !== clientId) continue;
      if (run.requestId !== requestId) continue;
      return run;
    }
    return undefined;
  }

  /** 只淘汰**终态**条目（活动 run 一律保留：它们是"谁在跑"的唯一记录）。 */
  private prune(): void {
    if (this.runs.size <= this.maxRuns) return;
    for (const [runId, run] of this.runs) {
      if (this.runs.size <= this.maxRuns) break;
      if (run.state === "running") continue;
      this.runs.delete(runId);
    }
  }

  private snapshot(run: RunEntry): GatewayRunSnapshot {
    return { ...run };
  }
}
