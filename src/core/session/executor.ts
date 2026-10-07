/**
 * SessionExecutor — 程序化触发会话执行
 *
 * 当 DelegationOrchestrator 接收到委派请求时，通过本模块在目标会话
 * 后台启动一次 agent loop 执行。与 App.tsx 中的 runAgenticLoop 不同，
 * 本模块不直接操作 React 状态，而是：
 *
 * 1. 直接调用 engine.process() 获取事件流
 * 2. 将消息写入 DB（MessageStorage）——用户切换到该会话时自然加载
 * 3. 通过 SessionMessageBus 发送状态更新（UI 层监听后刷新）
 * 4. 执行完成后通知 DelegationOrchestrator
 *
 * 设计参考：subagent/spawner.ts 的 LLMSubagentSpawner.executeTask
 */

import type { LLMEngine } from "../llm";
import type { LoopEvent } from "../llm/agentic-loop";
import * as MessageStorage from "../storage/message";
import { reportPersistFailure } from "../storage/persist-failure";
import { retainToolResult } from "../storage/spill";
import * as SessionStorage from "../storage/session";
/* 第 193 轮：前缀常量与回填判据共用一处定义（两处各写一遍，改的时候必漏一处） */
import { DELEGATED_TASK_PREFIX } from "../storage/session";
import { getSessionMessageBus } from "./bus";
import { idleWatchdog } from "./idle-watchdog";
import { recordLoopStop } from "../llm/loop-stop-log";
import { getDelegationOrchestrator } from "./orchestrator";
import type { DelegationTask } from "./types";
import { useAppStore } from "../../store";
import { useProjectStore } from "../store";
import { getEventLog } from "../storage/event-log";
import { EXIT_REASON_DETAIL_KEY } from "../llm/agentic-loop";
import { getLang } from "../i18n/lang";
import { getEffectiveSecurityMode } from "../permission/security-mode";

// ========== 类型 ==========

export interface ExecuteSessionTurnParams {
  /** 目标会话 ID */
  sessionId: string;
  /** 要执行的消息/任务描述 */
  message: string;
  /** 工作目录 */
  cwd: string;
  /** LLM 引擎实例 */
  engine: LLMEngine;
  /** 关联的委派任务 ID（可选，非委派触发时为空） */
  delegationTaskId?: string;
  /** abort 信号 */
  abortSignal?: AbortSignal;
  /** 权限请求回调（后台执行时由 UI 层提供） */
  onPermissionRequest?: (request: import("../permission/permission").PermissionRequest) => Promise<import("../permission/permission").PermissionResult>;
}

export interface ExecuteSessionTurnResult {
  /** 最终的 assistant 文本输出 */
  output: string;
  /** 工具调用次数 */
  toolCallCount: number;
  /** 是否成功完成 */
  success: boolean;
  /** 错误信息 */
  error?: string;
}

// ========== 活跃执行追踪 ==========

/** 当前正在执行的会话集合（**前台回合与后台回合共用同一张表**，见下） */
const activeExecutions = new Map<string, AbortController>();

/**
 * 前台回合的**执行登记**（第 45 轮功能上下文审计 P1-I2）。
 *
 * ## 为什么需要它
 *
 * `AgenticLoop` 实例按会话池化复用，`run()` 的第一件事就是覆盖
 * `abortController` / `state` / `currentSessionId`（`agentic-loop.ts:787–795`）。
 * 前台（`App.tsx` 的 `runAgenticLoop`）与后台（本文件的 `executeSessionTurn`：
 * 委派 / 微信桥 / 手机续聊）若同时进入同一会话，两轮会互相清空 `readCache`/`writeCache`、
 * 共用 `msgCache` 与 `securityMode` —— 表现为"工具调用被判重复而跳过""上下文少一段"。
 *
 * 后台路一直有 `isSessionExecuting` 守卫（`executeSessionTurn` 的入口），
 * 前台路原来**没有**。这里让前台把自己的回合登记进**同一张表**，
 * 于是 `isSessionExecuting` 对两个方向都成立、`executeSessionTurn` 也会拒绝与前台并发。
 * `endSessionExecution` 必须与它成对（调用方用 `try/finally` 包住整个回合）。
 *
 * ⚠️ 登记表里存的 controller 只是"忙碌"标记：前台的中止仍然走
 * `abortControllersRef` + `engineRef.current.abortSession(session.id)`（既有路径不变）。
 */
export function startSessionExecution(sessionId: string): void {
  if (activeExecutions.has(sessionId)) return;
  activeExecutions.set(sessionId, new AbortController());
}

/** 注销前台回合的登记（与 `startSessionExecution` 成对） */
export function endSessionExecution(sessionId: string): void {
  activeExecutions.delete(sessionId);
}

/**
 * 第 65 波：把一个循环事件折算成"吃了多少上下文"的粗略估计（字符数）。
 *
 * 只统计模型自己吐出的 text/reasoning 是不够的 —— 真正把上下文撑满的是**工具结果**
 * （一次列出几千行、一次读一个文件），以及**工具入参**（写文件时整篇内容都在入参里）。
 * 这里把三者都算上，再除以 3 换算成估算 token（与工具栏的估算口径一致）。
 */
function estimateEventTokens(event: any): string | undefined {
  const parts: string[] = [];
  if (typeof event?.text === "string") parts.push(event.text);
  if (event?.toolCall?.input) {
    try { parts.push(JSON.stringify(event.toolCall.input)); } catch { /* 忽略不可序列化的入参 */ }
  }
  const result = event?.result;
  if (typeof result === "string") parts.push(result);
  else if (result && typeof result === "object" && typeof result.output === "string") parts.push(result.output);
  return parts.length > 0 ? parts.join("") : undefined;
}

// ========== 核心执行函数 ==========

/**
 * 在指定会话中程序化执行一次 agent loop。
 *
 * 这是 runAgenticLoop 的"后台精简版"：
 * - 不操作 React state（不调用 addMessage/addToolCall）
 * - 直接写 DB（MessageStorage.createMessage / addToolCall / updateToolCall）
 * - 通过 SessionMessageBus 广播状态（UI 层可选择性监听刷新）
 * - 完成后通知 DelegationOrchestrator
 */
export async function executeSessionTurn(params: ExecuteSessionTurnParams): Promise<ExecuteSessionTurnResult> {
  const { sessionId, message, cwd, engine, delegationTaskId, abortSignal, onPermissionRequest } = params;
  const zh = getLang() === "zh";
  const bus = getSessionMessageBus();
  const orchestrator = getDelegationOrchestrator();

  // 防止同一会话被重复执行
  if (activeExecutions.has(sessionId)) {
    const errMsg = zh ? `会话 ${sessionId} 已在执行中` : `Session ${sessionId} is already executing`;
    /**
     * 第 83 波（审计修正）：这里原来**只返回** `success:false`，不通知编排器 ——
     * 而调用方（App 的委派处理器）只挂了 `.catch`，返回值根本没人看：
     * 任务在 `delegate()` 里已经是 running，于是**永久停在"执行中"**，
     * 父会话一直等一个不会来的结果。这里必须把失败写回任务。
     */
    if (delegationTaskId) {
      try {
        orchestrator.failTask(delegationTaskId, errMsg);
      } catch (e) {
        console.warn("[SessionExecutor] failTask failed:", e);
      }
    }
    return { output: "", toolCallCount: 0, success: false, error: errMsg };
  }

  const abort = new AbortController();
  activeExecutions.set(sessionId, abort);

  /**
   * 第 83 波（审计修正）：把"中止"真正接到引擎上。
   *
   * 背景：本函数的两道看门狗（空闲 / 工具挂死）与预算都只调 `abort.abort()`，
   * 而 `abort.signal` **只有在本循环拿到下一个事件时**才会被检查 ——
   * 如果循环正卡在一个工具的 await 上（例如权限/写确认弹窗没人点、provider 停摆），
   * 就再也没有"下一个事件"，中止信号形同虚设：会话永久卡住，
   * `activeExecutions` 永久占用（此后任何委派都被判"已在执行中"）。
   * App 侧的桌面路径早就是这么做的（`sessionAbort.abort()` + `engine.abortSession(id)`），
   * 后台路径漏了后半截。这里补上。
   */
  const abortEngine = () => {
    try {
      (engine as any).abortSession?.(sessionId);
    } catch (e) {
      console.warn("[SessionExecutor] engine.abortSession failed:", e);
    }
  };
  abort.signal.addEventListener("abort", abortEngine, { once: true });

  // 联动外部 abort 信号
  if (abortSignal) {
    abortSignal.addEventListener("abort", () => abort.abort());
    /**
     * ## 第 309 波：**传进来的信号已经是中止态时，必须当场联动** ✗→✓
     *
     * `addEventListener("abort", …)` 只在**将来**发生 abort 时触发 ✓ ——
     * 若调用方给的信号**在传进来之前就已经中止** ✗，那个回调**永远不会跑** ✗
     * ⇒ 内部 `abort.signal.aborted` 恒为 `false` ✗ ⇒ 这一轮**照常跑到底** ✗
     * （它该做的"别跑了"完全没有生效 ✓）。
     *
     * 这条是**第 309 波的判据 `END-1` 顺带抓出来的** ✓（先写判据的价值：
     * 写"中止必须留下原因"这条判据时，我用一个**已中止**的信号造夹具 ✓，
     * 结果发现连"中止"本身都没有传递进去 ✗）。
     *
     * `AbortSignal` 的语义本来就是"**已经**中止就是中止" ✓（`aborted` 是状态、
     * 不是事件 ✓）—— 所以这里**不改**任何既有语义，只是把漏掉的那一半补上 ✓。
     */
    if (abortSignal.aborted) abort.abort();
  }

  // 标记会话为活跃（UI 层会显示 streaming 指示器）
  useAppStore.getState().setSessionActive(sessionId, true);

  // 通知 UI：后台执行开始
  bus.send(sessionId, {
    type: "status",
    sourceSessionId: delegationTaskId ? orchestrator.getTask(delegationTaskId)?.sourceSessionId || "" : "",
    targetSessionId: sessionId,
    detail: "execution_started",
    taskId: delegationTaskId,
  });

  let assistantContent = "";
  let reasoningContent = "";
  let toolCallCount = 0;
  let currentAssistantMsgId = "";
  // P6：记录 end 事件的 stop reason（too_many_errors/max_iterations/no_progress/overflow…），
  // 用于"无任何文本产出即异常终止"时落库并返回失败（否则微信/手机端静默无回复）。
  let endReason: string | undefined;
  /**
   * 第 70 波（TASK 2 同类清查）：end 事件的**结果本体**也要留下来。
   *
   * `{ type: "error"; error }` 与 `{ type: "aborted" }` 这两种形状**不带 `reason`** ——
   * 只读 `result.reason` 的字符串判据看不见它们（`endReason` 会是 undefined），
   * 于是一个"LLM 硬失败"的后台/委派回合会被 `completeTask` 当成**成功**交回父会话。
   */
  let endResult: any = undefined;

  // 第 64 波（用户质疑「用时间做可靠性」之后重做）：
  // 原来是「15 分钟墙钟上限」—— 那是**错的机制**：合法的长任务（装依赖、跑全量测试、编译）
  // 会被误杀，而"还在产出废话"的卡死循环在到点前谁也拦不住。
  // 现在按 DSH 的分法（`@deepseek-ai/dsh-timeout`）：
  //   · **空闲看门狗**（时间只用于测"沉默"）：每个事件 `pulse()` 一次，只有连续 N 分钟
  //     **一个事件都没有**才中止 —— 还在干活就永远不会被杀；
  //   · **资源预算**（上限用资源而不是时钟）：后台会话累计估算 token 超过预算才中止。
  // 两者都是"配置项"，不是散落的魔法数字（DSH 同样把上限放在 settings schema 里）。
  let abortedBy: "idle" | "budget" | "tool_hung" | "cancel" | null = null;
  let lastToolLabel = "";
  const delegCfg = getDelegationOrchestrator().getConfig?.();
  const idleMs = delegCfg?.turnIdleMs ?? 5 * 60 * 1000;
  const tokenBudget = delegCfg?.turnTokenBudget ?? 0; // 0 = 不限
  const watchdog = idleWatchdog(abort.signal, idleMs, "BACKGROUND_TURN_IDLE");
  let estimatedTokens = 0;

  /**
   * 第 65 波（审计发现）：**"事件流沉默"不等于"卡住"** —— 一个跑了 10 分钟的构建/测试
   * 期间本来就不会有事件。原来的空闲看门狗会把这种**合法长工具**当成卡死砍掉，
   * 父会话也会看到"安静 3 分钟"而误以为它卡住。
   *
   * 按 DSH 的思路把两种语义拆开（它的 `deadline` 与 `idleWatchdog` 也是分给不同能力的）：
   *   · **空闲**（`idle`）：既没有事件、也没有工具在跑，连续 `idleMs` → 才是真的停摆；
   *   · **工具挂死**（`tool_hung`）：单个工具在飞超过 `toolFlightMs`（默认 20 分钟）→ 那个工具卡死了
   *     （正常情况下工具自己的超时会更早触发）。
   * 工具在飞期间每 30 秒心跳一次：既给看门狗续命，也**向父会话上报进度**（它据此知道"还在干活"）。
   */
  const toolFlightMs = delegCfg?.toolFlightMs ?? 20 * 60 * 1000;

  /**
   * ## ★ 第 309 波：**停顿窗口**（`stallMs` ✓）—— 与 `idleMs` **分开**的短尺子 ✓
   *
   * ## 为什么必须有它（`§13.226` 交叉表给的硬证据 ✓）
   *
   * `1.16.287` 正式读数 ✓：
   * ```
   * 结局 × 结束形态
   *               settled  stalled  unknown
   *   passed            5        6        0
   *   failed            0       13        0
   * ⇒ 失败的轮次里：被掐停 13 条 / 走到收尾段 0 条
   * ```
   * ★ **13 条失败轮，没有一条走到过收尾段** ✗ —— 一条都没有 ✓。
   *
   * 机制（`§13.227` ✓）：下面那个 `for await` **只有一道闸门** ✓
   * （`if (abort.signal.aborted) break;` ✓），而 `abort` 由
   * `idleWatchdog(…, idleMs = 5 分钟, …)` 触发 ✓ ——
   * 而**跑批 2 分钟就放弃** ✗ ⇒ ★ **`break` 永远来不及** ✗
   * ⇒ 收尾段跑不到 ✓ ⇒ `shouldNudgeZeroOutput` 等四把守卫**一次都没机会开火** ✓
   * （§13.224 查过：守卫**本来就有** ✓、判据也**早就写对了** ✓，缺的只是"机会"✓）。
   *
   * ## 口径（**只交出控制权，不中止** ✓ —— 这是与 `idleMs` 的关键区别 ✓）
   *
   * | | 判据（沉默多久 ✓） | 处置 |
   * |---|---|---|
   * | `idleWatchdog` ✓ | `idleMs`（5 分钟 ✓） | **中止**这个回合 ✗ |
   * | **本判据** ✓ | **`stallMs`**（**更短** ✓，默认 `idleMs / 4` ✓） | **`break` 出循环** ✓ ⇒ **收尾段跑** ✓ |
   *
   * ⚠️ 三条边界 ✓：
   * 1. **必须比 `idleMs` 短** ✗⇒✓：取成相等就等于没改 ✓（判据 `STALLW-2` 钉这条 ✓）；
   * 2. **不许 `abort`** ✗：那会把"还想继续"的轮次直接杀掉 ✓
   *    （而目标① 要的是"**催它继续**"✓）；
   * 3. **工具在飞时不算停顿** ✓：一个跑 10 分钟的构建期间本来就没有事件 ✓
   *    （§13.224 第一节那条注释说明过这是**用户质疑后重做**的机制 ✓，不许退回去 ✗）。
   */
  const stallMs = Math.max(1_000, delegCfg?.stallMs ?? Math.floor(idleMs / 4));
  /** 最后一次"有事件"的时刻（`noteActivity` 每次刷新 ✓） */
  let lastActivityAt = Date.now();
  /** 是否因"停顿"交出过控制权（进原因口径 ✓，**不许与 `idle` 混名** ✗） */
  let stalledOut = false;
  /**
   * ⚠️ ⚠️ **第 309 波第一次写错的地方（留证 ✓）**：
   *
   * 我第一版把停顿判据写成"在循环体里 `if (Date.now() - lastActivityAt >= stallMs) break;`" ✗ ——
   * **那个判据永远不会触发** ✗：循环体只在**收到事件**时才执行 ✓，
   * 而"停顿"的定义就是**收不到事件** ✗ ⇒ 判据所在的那段代码**根本不会被跑到** ✓。
   * ⇒ ★ 与 §13.209 那个错误**逐字同源** ✓（"把东西写在到不了的位置"✗）——
   * 我在同一个方向上**第三次**踩它 ✓（`turn_end` 一次 ✓、心跳一次 ✓、这次一次 ✓）。
   *
   * 正解 ✓：停顿必须由**独立的定时器**发现 ✓，再用一个**自己的**信号让循环退出 ✓
   * （`AbortSignal.timeout` 不行 ✗ —— 它不会随事件重置 ✓；用一个控制器 + 每次 `pulse` 重排定时器 ✓）。
   */
  const stallController = new AbortController();
  let stallTimer: ReturnType<typeof setTimeout> | undefined;
  const clearStallTimer = () => {
    if (stallTimer !== undefined) clearTimeout(stallTimer);
    stallTimer = undefined;
  };
  /**
   * ## ★★ 第 309 波（`FLIGHT-1..4` ✓）：**"工具在飞"不能是一条没有上限的免死金牌** ✗→✓
   *
   * ## 真机取证（`r288` / `1.16.288` ✓，归档 §13.234 ✓）
   *
   * 第 2 轮发出**两个** bash ✓，而控制台里 `Tool executed` **只有 1 条** ✓：
   * ```
   * Single-response dedup: 2 tool calls:
   *   [bash("cd …; ls; echo …; cat package.json"),
   *    bash("cd …; npx vitest run src/test/dsh-d10-write-not-execu…")]   ← ★ 这条**从未出现**
   * t=…451709  [AgenticLoop] Tool executed: bash, path: cd "…"; ls; …      ← 只有第 1 条
   * （此后 4 秒控制台还有噪音，然后**整个回合结束** ✗：Iteration 2 completed 从未打出 ✗）
   * ```
   * ⇒ 而 `toolsInFlight` 只在**收到完成事件**时才 `--` ✓（`:548` / `:600` ✓）
   * ⇒ ★ **"工具开始了、完成事件永不回来" ⇒ `toolsInFlight` 永远 `> 0`** ✗ ⇒
   * **两道看门狗一起失效** ✓：`idleWatchdog`（工具在飞就 `pulse()` 续命 ✓）+ **本函数的旧版**
   * （`toolsInFlight > 0` ⇒ **无条件重新排队** ✗）。
   * 唯一还在跑的是 `toolFlightMs`（默认 **20 分钟** ✗）⇒ **远超跑批的 2 分钟** ✗
   * ⇒ 回合被外人结束 ✓ ⇒ **收尾段一行都没执行** ✓（`收尾` / `nudge` / `zero-output` / `turn_end`
   * 在控制台里**全是 0 行** ✓）⇒ 四把完成守卫**一次都没机会开火** ✓。
   *
   * ## 口径（**这里的关键是"延期本身也要有上限"** ✓）
   *
   * 旧版：工具在飞 ⇒ **无条件**重新排队 ✗ —— 那个"延期"**没有尽头** ✗。
   * 新版 ✓：重新排队**但**累计等待超过 `flightStallMs` 就**照样交出控制权** ✓。
   * ⚠️ 三条取值边界 ✓：
   * 1. **必须严格小于 `toolFlightMs`** ✓（20 分钟那条是"**中止**"✓，本条只是"**交出控制权**"✓）；
   * 2. **必须显著大于正常工具时长** ✓（合法长工具**不许误杀** ✗ ——
   *    这是 §13.224 第一节那条"用户质疑后重做"的口径 ✓）；
   * 3. **处置与 `stallMs` 一致** ✓：`break` 出循环 ⇒ **收尾段有机会跑** ✓、**不 `abort`** ✓。
   */
  const flightStallMs = Math.max(1_000, delegCfg?.flightStallMs ?? Math.floor(toolFlightMs / 4));
  /** 工具在飞期间"重新排队"累计等了多久（超过 `flightStallMs` 就不再等 ✓） */
  let flightWaitedMs = 0;
  /** 重排停顿定时器：工具在飞时**也计时** ✓，但给一个更长的上限 ✓（见上面长注释 ✓） */
  const armStallTimer = () => {
    clearStallTimer();
    if (stallMs <= 0) return;
    stallTimer = setTimeout(() => {
      /**
       * 工具在飞 ⇒ **延期** ✓，但**延期有上限** ✓ ——
       * 不超过 `flightStallMs` 时重新排队 ✓；超过了 ⇒ ★ **它已经不是在飞，是丢了** ✓
       * （"一个永不回来的工具"与本条要防的形态逐字一致 ✓，§13.234 ✓）。
       */
      if (toolsInFlight > 0) {
        flightWaitedMs += stallMs;
        if (flightWaitedMs < flightStallMs) {
          armStallTimer();
          return;
        }
        stalledOut = true;
        console.warn(
          `[Executor] 会话 ${sessionId} 有 ${toolsInFlight} 个工具在飞、` +
            `已累计等待 ${Math.round(flightWaitedMs / 1000)}s（上限 ${Math.round(flightStallMs / 1000)}s）` +
            `—— 判定"工具没回来"，交出控制权（**不中止**），让收尾守卫判一次`,
        );
        stallController.abort();
        return;
      }
      stalledOut = true;
      console.warn(
        `[Executor] 会话 ${sessionId} 连续 ${Math.round(stallMs / 1000)}s 没有事件 —— ` +
          `交出控制权（**不中止**），让收尾守卫判一次`,
      );
      stallController.abort();
    }, stallMs);
    (stallTimer as any)?.unref?.();
  };

  let toolsInFlight = 0;
  /** 起手就上弦 ✓（第一轮也在计时 ✓） */
  armStallTimer();
  let toolFlightTimer: ReturnType<typeof setTimeout> | undefined;
  const clearToolFlight = () => {
    if (toolFlightTimer !== undefined) clearTimeout(toolFlightTimer);
    toolFlightTimer = undefined;
  };
  const armToolFlight = () => {
    if (toolFlightTimer !== undefined || toolFlightMs <= 0) return;
    toolFlightTimer = setTimeout(() => {
      abortedBy = "tool_hung";
      console.warn(`[Executor] 会话 ${sessionId} 的工具 ${lastToolLabel || "(unknown)"} 在飞超过 ${Math.round(toolFlightMs / 1000)}s，判定挂死并中止`);
      abort.abort();
    }, toolFlightMs);
    (toolFlightTimer as any)?.unref?.();
  };

  // 工具在飞期间的心跳：续命 + 上报进度（父会话的"安静判定"据此保持正确）
  const flightHeartbeat = setInterval(() => {
    if (toolsInFlight <= 0) return;
    watchdog.pulse();
    reportProgress();
  }, 30_000);
  (flightHeartbeat as any)?.unref?.();

  // 标记委派任务为 running
  if (delegationTaskId) {
    orchestrator.startTask(delegationTaskId);
  }

  /** 第 62 波：把进度上报给编排器（等待超时的父会话据此看到子会话在干什么） */
  const reportProgress = () => {
    if (!delegationTaskId) return;
    orchestrator.updateProgress(delegationTaskId, {
      toolCalls: toolCallCount,
      lastText: assistantContent.slice(-400),
      lastTool: lastToolLabel || undefined,
    });
  };

  /**
   * 每个事件都算一次"还活着"：重新上弦空闲看门狗，并累计估算 token 预算。
   * 这是与"墙钟"最关键的区别 —— 时间只在**没有事件**时流逝。
   */
  const noteActivity = (text?: string) => {
    watchdog.pulse();
    lastActivityAt = Date.now();
    /** ★ 有事件 ⇒ 累计等待清零 ✓（工具真的回来了 ⇒ 不是"丢了"✓） */
    flightWaitedMs = 0;
    armStallTimer();
    if (typeof text === "string" && text.length > 0) {
      estimatedTokens += Math.ceil(text.length / 3);
      if (tokenBudget > 0 && estimatedTokens > tokenBudget) {
        abortedBy = "budget";
        console.warn(
          `[Executor] 会话 ${sessionId} 累计估算 token 超过预算 ${tokenBudget}（约 ${estimatedTokens}），按资源上限中止`,
        );
        abort.abort();
      }
    }
  };

  try {
    // 保存用户消息到 DB（委派任务作为 user message 注入目标会话）
    const userMsgId = `user-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
    const prefix = delegationTaskId ? DELEGATED_TASK_PREFIX : "";
    // 第 63 波（审计补）：给"接收方"一句兜底约束。
    // 交接正文再规范，也可能漏东西；漏了的时候模型的本能是"把整个盘扫一遍找找看" ——
    // 那正是第 62 波事故的行为。所以这句必须由系统注入（而不是指望交接里写了）。
    const receiverNote = delegationTaskId
      ? (getLang() === "zh"
          ? "\n\n---\n[系统提示] 这是一次**会话交接**：上面是对方给你的全部信息，你没有它的对话历史。" +
            "需要文件内容时，**直接用正文里给出的绝对路径 read**；" +
            "如果正文缺少你要的信息（文件不存在、路径没给、完成判据不清），**先明确报告缺什么**，" +
            "不要靠反复枚举目录/递归扫描来猜。同一个目录枚举超过几次就会被系统拦下并终止。"
          : "\n\n---\n[SYSTEM] This is a session handover: the text above is ALL you get — you have none of the sender's history. " +
            "When you need file content, `read` the absolute path given above. " +
            "If something you need is missing (no path, file not found, no definition of done), REPORT WHAT IS MISSING first — " +
            "do not guess by repeatedly enumerating directories or scanning recursively. Repeated enumeration of the same target gets blocked and terminated.")
      : "";
    MessageStorage.createMessage({
      id: userMsgId,
      role: "user",
      content: prefix + message + receiverNote,
      timestamp: Date.now(),
      status: "done",
    }, sessionId);
    /**
     * ⚠️ 第 154 轮（O-28）：这里原来还有一次**显式的** `getEventLog().append(sessionId, "user_message", …)`。
     *
     * 它是历史遗留（C5 事件双写时代），而 `user_message` / `assistant_text` 早已有
     * **唯一写入点**：`MessageStorage.appendMessageTextEvent`（由 `createMessage` /
     * `updateMessage` 的定稿分支调用，按正文指纹去重，见 message.ts 的长注释）。
     * 两处都写 ⇒ 真机副本库里每条用户消息 / 每条有正文的助手回复都留下**两条**事件
     * （实测：`wx-…-im-wechat` 会话 `seq=8951/8952` 两条 `user_message`、
     * `seq=8971/8972` 两条 `assistant_text`）。重复行没有信息量，只会污染
     * `session-event-search` 的结果 —— 一个事实一个写入者。
     */

    // 委派/后台任务同样遵循用户选择的安全模式（项目级 > 全局 > 默认 ask），
    // 不再硬编码 "auto" —— 否则用户在 UI 选择"完全访问"后委派任务仍被权限层拦截。
    const effectiveSecurityMode = getEffectiveSecurityMode(cwd) || "ask";

    /**
     * 第 83 波：**当前轮次的助手消息一定是一张真实存在的行**（用户现场：委派出去的 b 会话原地打转）。
     *
     * 背景：这条路径不碰 React store（不像 App.tsx 每轮 `saveMessages` 会把消息 upsert 进库），
     * 所有写入都直接打 DB。以前只有 `reasoning_delta` / `text_delta` 会**顺带**建行，
     * 于是两类事件都会丢历史：
     *   · `start`（iteration > 1）只换了 id 不建行 → 第 2 轮之后**整轮**写不进去；
     *   · 模型"不说话直接调工具"时 `currentAssistantMsgId` 还是空的 → 这次调用与结果直接跳过。
     * 而 `AgenticLoop` 每轮都从库里重建上下文，历史缺了 → 模型重发同一个工具调用 → 死循环，
     * 父会话一直等不到结果。
     */
    const createdAssistantIds = new Set<string>();
    const ensureAssistantMessage = (): string => {
      if (!currentAssistantMsgId) currentAssistantMsgId = `assistant-${Date.now()}`;
      if (!createdAssistantIds.has(currentAssistantMsgId)) {
        createdAssistantIds.add(currentAssistantMsgId);
        MessageStorage.createMessage({
          id: currentAssistantMsgId,
          role: "assistant",
          content: assistantContent,
          timestamp: Date.now(),
          status: "streaming",
        }, sessionId);
      }
      return currentAssistantMsgId;
    };

    for await (const event of engine.process(sessionId, message, cwd, undefined, {
      /**
       * 第 154 轮（O-28）：把"本轮助手消息的**真实行 id**"交给引擎。
       *
       * 为什么必须给：工具事件（`tool_call` / `tool_result`）的 `messageId` 由引擎写，
       * 而消费方（维护自检、事件投影）拿它去 `messages` 表里找那一行。引擎自造的
       * `msg-…` 在表里**没有这一行** ⇒ 微信回合的三个纯工具轮助手行被判
       * `VISIBLE_BUT_NOT_RECORDED`（真机 1.16.152 报"本次新产生 3 条"）。
       *
       * `ensureAssistantMessage()` 正是"拿到本轮的 id，没有行就建行"的语义：
       * 模型一句话不说直接调工具时，它在这里建行（与被删掉的 tool_start 兜底同源）。
       */
      resolveAssistantMessageId: () => ensureAssistantMessage(),
      onPermissionRequest: onPermissionRequest || ((_req) => {
        // 默认策略：后台执行时若用户模式为 full 则放行；否则自动拒绝需要权限的操作
        if (effectiveSecurityMode === "full") {
          return Promise.resolve({ requestId: _req?.id || "", action: "allow", alwaysAllow: false } as any);
        }
        return Promise.resolve({ requestId: _req?.id || "", action: "deny", reason: "Background execution: auto-deny" } as any);
      }),
      securityMode: effectiveSecurityMode,
    })) {
      /**
       * ★ 第 309 波：**两道闸门** ✓ ——
       * ① `abort.signal`（既有的"中止"语义 ✓，`idle`/`budget`/`tool_hung`/`cancel` ✓）；
       * ② `stallController.signal`（新增的"**停顿**"语义 ✓，只 break、**不中止** ✓）。
       * ⚠️ 但**光靠这里不够** ✗ —— 循环体只在**收到事件**时才跑 ✓，
       * 而停顿的定义就是收不到事件 ✗ ⇒ 真正的发现者是上面那个定时器 ✓；
       * 这一行只是"用定时器的结果退出循环" ✓。
       */
      if (abort.signal.aborted) break;
      if (stallController.signal.aborted) break;

      // 每个事件都是"还活着"的证据：重新上弦空闲看门狗 + 计入资源预算。
      // 第 65 波修正：预算必须把**工具输入/输出**也算进去 —— 只统计模型吐出的文本
      // 会严重低估（真正吃上下文的是工具结果），于是预算形同虚设。
      noteActivity(estimateEventTokens(event as any));

      switch (event.type) {
        case "reasoning_delta":
          reasoningContent += event.text;
          ensureAssistantMessage();
          MessageStorage.updateMessage(currentAssistantMsgId, { reasoning: reasoningContent });
          break;

        case "text_delta":
          assistantContent += event.text;
          ensureAssistantMessage();
          MessageStorage.updateMessage(currentAssistantMsgId, { content: assistantContent });
          break;

        case "tool_start": {
          const tc = "toolCall" in event ? event.toolCall : null;
          if (tc) {
            // 第 62 波：记下"最近一次工具"，等待超时的父会话据此判断子会话是否在原地打转
            const raw = (tc.input as any)?.command ?? (tc.input as any)?.path ?? "";
            lastToolLabel = `${tc.name}${raw ? `: ${String(raw).replace(/\s+/g, " ").slice(0, 80)}` : ""}`;
            // 第 65 波：工具在飞 → 让空闲看门狗"暂停判定"，并另起一道"工具挂死"上限
            toolsInFlight++;
            armToolFlight();
            reportProgress();
          }
          if (tc) {
            /**
             * 第 83 波：工具调用必须挂在一张**真实存在**的消息上。
             *
             * 模型完全可能"一句正文都不说、直接调工具"（带思考的模型常把预算全花在 reasoning 上），
             * 那时 `currentAssistantMsgId` 还是空的 —— 以前这里是 `if (tc && currentAssistantMsgId)`，
             * 于是这次调用与它的结果在历史里**凭空消失**：下一轮模型从库里重建上下文，
             * 看到的是"我没调用过任何工具"，于是重发同一个调用 → 死循环。
             */
            MessageStorage.addToolCall(ensureAssistantMessage(), {
              id: tc.id,
              tool: tc.name,
              args: { ...tc.input, name: tc.input?.name || (tc as any).metadata?.name },
              status: "running",
            });
          }
          break;
        }

        case "tool_complete": {
          toolCallCount++;
          toolsInFlight = Math.max(0, toolsInFlight - 1);
          if (toolsInFlight === 0) clearToolFlight();
          reportProgress();
          const tc = "toolCall" in event ? event.toolCall : null;
          if (tc) {
            // 第 83 波：结果同样要落在真实存在的消息上（见 tool_start 的说明）
            ensureAssistantMessage();
            let resultStr: string;
            let toolMetadata: Record<string, any> | undefined;
            if (typeof event.result === "string") {
              resultStr = event.result;
            } else if (event.result && typeof event.result === "object" && "output" in event.result) {
              resultStr = (event.result as any).output;
              // 提取结构化元数据（如 subagentId 等）
              if ((event.result as any).metadata) {
                toolMetadata = (event.result as any).metadata;
              }
            } else {
              resultStr = JSON.stringify(event.result || "");
            }
            resultStr = resultStr.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
            // 第 76 波（对齐 DSH dsh-spill-policy）：超大工具结果溢出到会话私有文件，
            // 库里/上下文里只留 head+tail 预览和一行"全文在哪"的说明。
            // 为什么在这里做：这是工具结果进库、进上下文的**唯一入口**，
            // 在这里拦一次，DB 体积、后续每轮的上下文、以及每次整库导出的峰值都一起受控。
            // 失败必须退回原文（宁可库大一点，也不能把工具结果变成一句"保存失败"）。
            try {
              const retained = await retainToolResult(resultStr, {
                sessionId,
                toolName: tc.name,
                callId: tc.id,
              });
              if (retained.spilled) {
                console.log(
                  `[Spill] 工具结果 ${retained.totalBytes} 字节超过上限，已省略 ${retained.omittedBytes} 字节；全文：${retained.locator}`,
                );
              }
              resultStr = retained.text;
            } catch (e) {
              console.warn("[Spill] 溢出保存失败，保留完整结果:", e);
            }
            MessageStorage.updateToolCall(currentAssistantMsgId, tc.id, {
              status: "done",
              result: resultStr,
              ...(toolMetadata ? { metadata: toolMetadata } : {}),
            });
          }
          break;
        }

        case "tool_error": {
          toolCallCount++;
          toolsInFlight = Math.max(0, toolsInFlight - 1);
          if (toolsInFlight === 0) clearToolFlight();
          const tc = "toolCall" in event ? event.toolCall : null;
          const err = "error" in event ? event.error : "Unknown error";
          if (tc) {
            ensureAssistantMessage();
            MessageStorage.updateToolCall(currentAssistantMsgId, tc.id, {
              status: "error",
              result: err,
            });
          }
          break;
        }

        case "start": {
          // 新迭代：finalize 上一个 assistant message，开启新的一条
          const iter = "iteration" in event ? event.iteration : 1;
          if (iter > 1 && currentAssistantMsgId) {
            MessageStorage.updateMessage(currentAssistantMsgId, {
              status: "done",
              reasoning: reasoningContent || undefined,
            });
            /**
             * ## ⚠️ 第 171 波：**中途定稿也要"钉住空行"** ✗→✓
             *
             * 收尾处（本文件后面那个 `if (currentAssistantMsgId)` 分支 ✓）早就有这段逻辑 ✓：
             * 空正文 + 没调工具的助手行要补一条空 `assistant_text` 把自己钉住 ✓（FWT-C1c ✓），
             * 否则投影重建时**凭空消失** ✓、不变量判 `VISIBLE_BUT_NOT_RECORDED` ✗。
             *
             * 但**中途**这次定稿（`iter > 1` 时把上一条落成 `done` ✓）**没有**那段 ✗ ⇒
             * 一次"什么都没产出"的迭代（模型只吐 reasoning 就结束、或该轮空转 ✓）
             * 就留下**空且无事件**的助手行 ✓ —— 这正是用户两次报的
             * `assistant-…-20`（第 20 次迭代 ⇒ **中途行** ✓）那条缺口 ✓。
             *
             * 处置与收尾处**一致** ✓（同一个判据 FWT-C1c：空正文 + 零工具调用 ⇒ 补空事件 ✓），
             * 不另立第二套口径 ✗（同一个角落在两处用两种做法，正是本仓库反复吃亏的形态 ✓）。
             */
            if (!assistantContent) {
              try {
                const settled = MessageStorage.getMessage(currentAssistantMsgId);
                if (settled && (settled.toolCalls?.length ?? 0) === 0) {
                  const ev = getEventLog().append(sessionId, "assistant_text", {
                    messageId: currentAssistantMsgId,
                    content: "",
                  });
                  if (ev.seq === 0) throw new Error("事件未落库（seq=0，端口未接手）");
                }
              } catch (e) {
                reportPersistFailure(
                  "executor.settleEmptyAssistantMidIteration",
                  e,
                  `会话 ${sessionId} 的中途空助手行 ${currentAssistantMsgId} 在事件日志里没有记录`,
                  {
                    title: "存储：中途定稿的空助手行没进事件日志",
                    consequence:
                      "这一行**只存在于消息存储里**：事件日志是投影重建的数据源，重建时它会消失" +
                      "（运行时不变量的 VISIBLE_BUT_NOT_RECORDED 判的就是这种形态）。",
                  },
                );
              }
            }
            currentAssistantMsgId = `assistant-${Date.now()}-${iter}`;
            assistantContent = "";
            reasoningContent = "";
            // 第 83 波：新迭代的消息**立刻建行**（见 ensureAssistantMessage 的说明）——
            // 以前只换 id 不建行，第 2 轮之后整轮的正文/工具调用/结果全都写不进去。
            ensureAssistantMessage();
          }
          break;
        }

        case "end":
          // 通知 UI 执行结束
          endResult = (event as any)?.result;
          endReason =
            endResult?.type === "error"
              ? `error: ${endResult.error ?? "LLM 调用失败"}`
              : endResult?.type === "aborted"
                ? "aborted"
                : (event as any)?.result?.reason || (event as any)?.reason || undefined;
          bus.send(sessionId, {
            type: "status",
            sourceSessionId: delegationTaskId ? orchestrator.getTask(delegationTaskId)?.sourceSessionId || "" : "",
            targetSessionId: sessionId,
            detail: "execution_completed",
            taskId: delegationTaskId,
          });
          break;
      }
    }

    /**
     * ## 第 309 波：**「这一轮为什么结束」必须留下痕迹** ✓（`END-1/2/3` ✓）
     *
     * ## 要修的缺陷（真机读数换来的 ✓，§13.188 ✓）
     *
     * 上面那个消费循环里有一处 `if (abort.signal.aborted) break;` ✓（第 385 行附近 ✓）。
     * **`break` 之后没有 `endResult`** ✗ ⇒ 下面 `const endShape = endResult?.type` 是 `undefined` ✗
     * ⇒ 那一整段失败记账（`error` / `aborted` / `overflow` ✓）**全部跳过** ✗
     * ⇒ 这一轮在事件日志里**没有任何"结束原因"** ✗。
     *
     * 真机形态（`repo-04` / `1.16.283` ✓）：3 次工具调用 → 再无任何事件 ✗、
     * `maxIteration=3` ✓、`loopStops=[]` ✓、`diffChars=0` ✓、收尾消息 `status:"streaming"` ✓。
     * 而那把「零产出守卫」**本该触发** ✓（判据跑过且 4 failed ✓、读过源码 ✓）
     * —— 它一次都没写 ✗，正是因为**那段代码根本没执行到** ✗。
     *
     * ⇒ 一个**被中止**的回合与一个**正常收尾**的回合，在记录里长得一样 ✗，
     * 而这两件事的修法**完全不同** ✓（前者是看门狗/预算/provider ✓、
     * 后者是完成守卫 ✓）——所以"目标①为什么失败"这件事**一直归因不了** ✗。
     *
     * ## 本波只做一件事：**让它可见** ✓（不改任何行为 ✗）
     *
     * - 不改 `endResult` ✓、不改返回值形状 ✓、不产生用户可见消息 ✓；
     * - 四个中止原因必须**能区分** ✓（`idle` / `budget` / `tool_hung` / `cancel` ✓）——
     *   写死成一个常量就等于没量 ✗（判据 `END-3` 钉这条 ✓）；
     * - 正常收尾的 `reason` 与中止**不同名** ✓（`loop_end` vs `abort:*` ✓，
     *   判据 `END-2` 钉这条 ✓）。
     *
     * ⚠️ **"该不该在这些形态下继续干"是下一条判据的事** ✗（本轮不做 ✓）——
     * 先把"发生了什么"量出来，再谈处置 ✓（handoff §7 第 1 条：量证才能收口 ✓）。
     */
    try {
      const abortCause = abortedBy ?? (watchdog.timedOut() ? "idle" : abort.signal.aborted ? "cancel" : null);
      /**
       * ## 第 309 波（第二版）：把**循环内部的出口原因**也带上 ✓
       *
       * `agentic-loop` 的 `run()` 里有一批**比收尾段更早**的出口 ✓
       * （`critical_service_unavailable` / `cost_limit` / `context_overflow` / `repeat_guard` /
       * `write_rejected_by_user` / `output_truncated` / `plan_stale` / `completed` … ✓）。
       * 走前几条的回合**收尾守卫连机会都没有** ✗ —— 而记录里只留下"没催过" ✓，
       * **与"守卫判定错"长得一模一样** ✗（真机 `repo-02` 卡的就是这件事 ✓，归档 §13.201 ✓）。
       *
       * ⚠️ 这个值走**实例字段**而不是会话事件 ✓ —— 第一版写成事件，
       * 当场把 `dsh-d5-prefix-cache-stability` 打红 ✗（每轮多一条事件 ⇒
       * 上下文摘要里的 `M total events` 变了 ⇒ 第二轮不再以第一轮为前缀 ⇒ 破坏前缀缓存 ✓）。
       * 详见 `agentic-loop.ts::noteExit` 的说明 ✓。
       */
      /**
       * ⚠️ 出口原因**从 `endResult.detail` 取** ✓（不是从 loop 实例 ✗）——
       * 这一版是**真机查出来的换道** ✓：
       *
       * 1. `agentic-loop` 的 `noteExit` 现在把原因挂进 `LoopResult.detail` ✓
       *    （键 `EXIT_REASON_DETAIL_KEY` ✓），随**既有的 `end` 事件**出来 ✓ ——
       *    而那条通道**已被证明能到达** ✓（`repo-08 r3` 真机的事件里看得到 `loopStops` 载荷 ✓）。
       * 2. 第一版走"循环之后自己 `getEventLog().append("turn_end", …)`" ✓ ——
       *    装上 `1.16.284` 真机跑两轮之后：**全库 101 536 条 `session_events` 里 `turn_end` 是 0 条** ✗
       *    （同一次运行的 `loop_stopped` 有 5 条 ✓ ⇒ 事件日志没坏 ✓，是那条写路径没落地 ✗）。
       *
       * ⚠️ 所以这段 `turn_end` 的写入**仍然保留** ✓（它本身是有用的观测 ✓），
       * 但**不再依赖它**来传出口原因 ✓ —— 原因走 `detail` ✓，两条路都能到 ✓。
       */
      const exitedVia =
        (endResult?.detail as Record<string, unknown> | undefined)?.[EXIT_REASON_DETAIL_KEY] ?? null;
      /**
       * ## ★ 第 309 波：这里**曾经**加过一发诊断探针（已删 ✓，结论留在归档 §13.209）
       *
       * 探针用的是**已被真机证明会落地**的那条链（`recordLoopStop` ✓），
       * 目的是一刀切开"那段代码没执行"与"`getEventLog()` 实例不对"✓。**结果：探针也没落地** ✓
       * ⇒ **那段代码根本没执行** ✗ ⇒ 真因是**那些回合从没走到循环之后**
       * （`maxIteration` 很小 ✓、会话末行还是 `status: "streaming"` ✗、
       * 引擎静默 2 分钟后被跑批判"跑完" ✓，而应用的消费循环仍在等下一个事件 ✓）。
       *
       * ⇒ **出口原因挂 `detail` 对"被掐停的回合"也无能为力** ✗（它同样在循环之后 ✓）——
       * 真正要在**循环内部**报 ✓（`recordLoopStop` 那条链在循环里也落地 ✓，见 §13.209 的下一步 ✓）。
       */
      getEventLog().append(sessionId, "turn_end", {
        reason: abortCause ? `abort:${abortCause}` : "loop_end",
        abortCause,
        detail: endResult?.type ?? null,
        /** ★ 循环内部的具体出口 ✓（`null` = 引擎没报，或走的是消费侧 `break` ✓） */
        exitReason: exitedVia,
        iteration: (engine as unknown as { getState?: () => { iteration?: number } }).getState?.()?.iteration ?? null,
        toolCalls: toolCallCount,
      });
    } catch (e) {
      // 观测设施写不进去**不该影响任务本身** ✓（与 `recordLoopStop` 同一条纪律 ✓）；
      // 但也**不静默** ✗ —— 留一行 warn ✓。
      console.warn("[SessionExecutor] 结束原因未记录:", e);
    }

    /**
     * 收尾：把最后一条助手消息定稿（第 154 轮 O-28 修正）。
     *
     * ## 改前这里有**两次**写，而第二次是多余的
     *
     * 原来：① `updateMessage(…, {status:"done", content})`；② 紧接着再**显式** append
     * 一条 `assistant_text`。① 走的就是**唯一写入点** `MessageStorage.appendMessageTextEvent`
     * （`updateMessage` 的"状态落到终态"分支），它按正文指纹去重、已经写了同一条事件 ——
     * 于是真机副本库里每条有正文的回复都留下**两条** `assistant_text`
     * （实测 `wx-…-im-wechat` 会话 `seq=8971/8972`；用户/助手两侧各两条）。
     * 而 ② 外面那句 `catch (e) { console.warn('[executor.ts]', e) }` 会把写入失败
     * 吞成控制台里的一行字 —— O-28 排查时它一度是最可疑的一环（实测：三条缺口与它无关，
     * 真因是工具事件挂的 messageId 不是消息行的 id，见 `engine.process` 上的说明）。
     *
     * ## 为什么还保留"空正文"那一次写入（**只在这一种形态下**）
     *
     * 唯一写入点**刻意**不给空正文的助手行写 `assistant_text`（纯工具轮的事实记在
     * `tool_call` / `tool_result` 事件里，口径见 FWT-C1a）。但有一个角落它盖不住：
     * **空正文、且一个工具都没调**的收尾行（模型只吐了 reasoning 就结束、或达到迭代上限）
     * —— 这种行在事件日志里一条记录都没有，投影重建时**会凭空消失**，
     * 正是 `runtime-invariants` 判 `VISIBLE_BUT_NOT_RECORDED` 的那一类（FWT-C1c）。
     * 所以只有它补一条空 `assistant_text` 把自己钉住；有工具调用的空行由工具事件记账，不补。
     */
    if (currentAssistantMsgId) {
      MessageStorage.updateMessage(currentAssistantMsgId, {
        status: "done",
        content: assistantContent,
        reasoning: reasoningContent || undefined,
      });
      if (!assistantContent) {
        try {
          const settled = MessageStorage.getMessage(currentAssistantMsgId);
          if (settled && (settled.toolCalls?.length ?? 0) === 0) {
            const ev = getEventLog().append(sessionId, "assistant_text", {
              messageId: currentAssistantMsgId,
              content: "",
            });
            /**
             * `append` 在"端口没接手"时**不抛**，而是返回一条 `seq === 0` 的未落库事件
             * （event-log.ts:226 的既定契约）—— 所以"没抛"不等于"写进去了"，
             * 这里必须按 `seq` 判，并把失败按原话上报（别再退回 console.warn。
             */
            if (ev.seq === 0) throw new Error("事件未落库（seq=0，端口未接手）");
          }
        } catch (e) {
          reportPersistFailure(
            "executor.settleEmptyAssistant",
            e,
            `会话 ${sessionId} 的空助手行 ${currentAssistantMsgId} 在事件日志里没有记录`,
            {
              title: "存储：收尾的空助手行没进事件日志",
              consequence:
                "这一行**只存在于消息存储里**：事件日志是投影重建的数据源，重建时它会消失" +
                "（运行时不变量的 VISIBLE_BUT_NOT_RECORDED 判的就是这种形态）。",
            },
          );
        }
      }
    }

    // 如果用户正在查看这个会话，刷新消息列表
    const viewingSession = useProjectStore.getState().currentSession?.id;
    if (viewingSession === sessionId) {
      useAppStore.getState().loadMessages(sessionId);
    }

    // 过滤 system-reminder 标签
    const cleanOutput = assistantContent.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();

    // 第 64 波：被"空闲看门狗"或"资源预算"中止 —— 明确说明是哪一种，并把已有产出交回去。
    // 注意这**不是**"到点就杀"：还在产出的事件会让看门狗不断重新上弦（合法长任务不会被误杀）。
    if (watchdog.timedOut() || abortedBy) {
      const zht = getLang() === "zh";
      const reason: "idle" | "budget" | "tool_hung" =
        abortedBy === "budget" ? "budget" : abortedBy === "tool_hung" ? "tool_hung" : "idle";
      const note =
        reason === "budget"
          ? zht
            ? `[后台执行达到资源上限：估算 token 约 ${estimatedTokens} / 预算 ${tokenBudget}] 已完成 ${toolCallCount} 次工具调用，最近一次工具：${lastToolLabel || "(无)"}。` +
              `如果这是正常的大任务，请提高预算或拆小；如果是原地打转，检查它是否在重复同一件事。`
            : `[Background turn hit its token budget: ~${estimatedTokens} / ${tokenBudget}] ${toolCallCount} tool calls, last tool: ${lastToolLabel || "(none)"}.`
          : reason === "tool_hung"
            ? zht
              ? `[工具挂死：${lastToolLabel || "(unknown)"} 在飞超过 ${Math.round(toolFlightMs / 1000)} 秒] 已强制中止。` +
                `注意这**不是**"跑得久被砍"——工具自己的超时本该更早触发；请检查该工具是否需要更长的超时或是否真的卡住。`
              : `[Tool hung: ${lastToolLabel || "(unknown)"} in flight for over ${Math.round(toolFlightMs / 1000)}s] aborted.`
            : zht
              ? `[后台执行空闲超时：连续 ${Math.round(idleMs / 1000)} 秒**既没有事件、也没有工具在跑**] 已完成 ${toolCallCount} 次工具调用，最近一次工具：${lastToolLabel || "(无)"}。` +
                `空闲超时意味着**它已经不产出任何东西**（不是"跑得久"）—— 常见原因是模型停摆或 provider 无响应。`
              : `[Background turn idle timeout: no event and no tool in flight for ${Math.round(idleMs / 1000)}s] ${toolCallCount} tool calls, last tool: ${lastToolLabel || "(none)"}.`;
      MessageStorage.createMessage({
        id: `err-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        role: "system",
        content: note,
        timestamp: Date.now(),
        status: "error",
      }, sessionId);
      // 第 65 波：停止原因结构化落库（idle / budget 两类），便于统计"哪种卡法最多"
      recordLoopStop(sessionId, reason, {
        toolCalls: toolCallCount,
        lastTool: lastToolLabel,
        estimatedTokens,
        tokenBudget,
        idleMs,
      });
      if (delegationTaskId) {
        orchestrator.failTask(delegationTaskId, `${note}\n\n${zht ? "已产出的内容" : "Partial output"}:\n${cleanOutput || "(none)"}`);
      }
      return { output: cleanOutput, toolCallCount, success: false, error: note };
    }

    /**
     * 第 70 波（TASK 2 同类清查）：按**形状**识别"不是完成"的收场。
     *
     * `{ type: "error"; error }`（LLM 调用最终失败）、`{ type: "aborted" }`（中途停止）
     * 与 `{ type: "overflow"; message }`（上下文彻底用尽）**都不带 `reason`**，
     * 所以上面那条字符串判据（以及 STALL 名单）对它们完全失效 ——
     * 一个失败的后台/委派回合会在最后被 `completeTask` 当成成功交回父会话。
     * （下面 P6 的注释把 `overflow` 也算进"reason 覆盖"，但 overflow 形状里根本没有
     * `reason` 字段 —— 那是一条恒假的声称。）
     *
     * 这里的判据刻意**不看有没有文本**：失败回合自己也会吐一段说明文本
     * （`executeIteration` 的可见失败上报），那段文本不该把失败洗成"正常完成"。
     */
    const endShape = endResult?.type;
    if (endShape === "error" || endShape === "aborted" || endShape === "overflow") {
      const zhf = getLang() === "zh";
      const detail =
        endShape === "error"
          ? String(endResult.error ?? (zhf ? "LLM 调用失败" : "LLM call failed"))
          : endShape === "overflow"
            ? String(endResult.message ?? (zhf ? "上下文窗口已满" : "context window exhausted"))
            : String(abortedBy ?? "cancel");
      const note =
        endShape === "error"
          ? zhf
            ? `[Agentic 循环失败: ${detail}] 这不是正常完成 —— 已产出的内容附在下方，请确认后再继续。`
            : `[Agentic loop failed: ${detail}] NOT a normal completion. Partial output below.`
          : endShape === "overflow"
            ? zhf
              ? `[上下文已用尽: ${detail}] 这不是正常完成 —— 已产出的内容附在下方，请确认后再继续。`
              : `[Context exhausted: ${detail}] NOT a normal completion. Partial output below.`
            : zhf
              ? `[回合被中止: ${detail}] 这不是正常完成 —— 已产出的内容附在下方，请确认后再继续。`
              : `[Turn aborted: ${detail}] NOT a normal completion. Partial output below.`;
      MessageStorage.createMessage({
        id: `err-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        role: "system",
        content: note,
        timestamp: Date.now(),
        status: "error",
      }, sessionId);
      if (delegationTaskId) {
        if (endShape === "aborted") orchestrator.cancelTask(delegationTaskId);
        else orchestrator.failTask(delegationTaskId, `${note}\n\n${cleanOutput || "(none)"}`);
      }
      return {
        output: cleanOutput,
        toolCallCount,
        success: false,
        error:
          endShape === "error"
            ? `循环失败: ${detail}`
            : endShape === "overflow"
              ? `上下文已用尽: ${detail}`
              : `回合被中止: ${detail}`,
      };
    }

    // P6：end 事件带异常 reason 且无任何文本产出 → 落库 system error 并返回失败
    //（对照 App runAgenticLoop 的 loop-error-* 行为；否则微信/手机端静默无回复）。
    // 判据：只要 endReason 存在且非正常 "completed" 即视为异常——覆盖全部 reason
    //（too_many_errors/max_iterations/no_progress/overflow/safety_valve/
    //  critical_service_unavailable/write_rejected_by_user/cost limit 长串等），
    // 避免枚举集合漏掉新增 reason。
    if (!cleanOutput && endReason && endReason !== "completed") {
      const errMsg = `[Agentic 循环异常终止: ${endReason}] 请检查会话详情或重试。`;
      MessageStorage.createMessage({
        id: `err-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        role: "system",
        content: errMsg,
        timestamp: Date.now(),
        status: "error",
      }, sessionId);
      // 通知编排器任务失败（若为委派触发）
      if (delegationTaskId) {
        orchestrator.failTask(delegationTaskId, errMsg);
      }
      return {
        output: "",
        toolCallCount,
        success: false,
        error: `循环异常终止: ${endReason}`,
      };
    }

    // 第 65 波（审计发现）：循环因**停滞/打转**类原因停止时，即使模型吐了文字，
    // 也不能当成"任务完成"上报 —— 否则父会话收到一个"已完成"、实际是"卡住了"的结果，
    // 它会拿着半成品继续往下走。这类停止要按**失败**交回，并把已有产出一起附上。
    const STALL_STOP_REASONS = new Set(["plan_stale", "repeat_guard", "no_progress", "too_many_errors"]);
    if (endReason && STALL_STOP_REASONS.has(endReason)) {
      const zhs = getLang() === "zh";
      const note = zhs
        ? `[循环因「${endReason}」停止：这不是正常完成] 已调用工具 ${toolCallCount} 次。已产出的内容附在下方，请人工确认后再继续。`
        : `[Loop stopped due to "${endReason}": NOT a normal completion] ${toolCallCount} tool calls. Partial output below — verify before continuing.`;
      MessageStorage.createMessage({
        id: `err-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        role: "system",
        content: note,
        timestamp: Date.now(),
        status: "error",
      }, sessionId);
      recordLoopStop(sessionId, endReason === "plan_stale" ? "plan_stale" : "no_gain", {
        endReason,
        toolCalls: toolCallCount,
        partialOutputChars: cleanOutput.length,
      });
      if (delegationTaskId) {
        orchestrator.failTask(delegationTaskId, `${note}\n\n${zhs ? "已产出的内容" : "Partial output"}:\n${cleanOutput || "(none)"}`);
      }
      return { output: cleanOutput, toolCallCount, success: false, error: note };
    }

    // 通知编排器任务完成
    // 第 63 波（审计补）：被取消（用户点了终止 / 父会话 cancel_delegation）而 abort 掉的执行，
    // 不能在这里又报"完成" —— 否则取消会被收尾逻辑悄悄改回已完成。
    //
    // 第 83 波（审计修正）：**中止也不能对调用方报成功**。
    // 取消时循环直接 break、不产生 `end` 事件 → `endReason` 是 undefined →
    // 上面那几处"失败分支"一个都不会命中 → 这里就 `success: true` 返回了，
    // 于是桥接层（微信/手机）把它当成"处理完成（无文本输出）"，用户看到的是"AI 没回话"。
    if (abort.signal.aborted) {
      const zhAbort = getLang() === "zh";
      const note = zhAbort
        ? `[回合被中止：${abortedBy ?? "cancel"}] 已完成 ${toolCallCount} 次工具调用，最近一次工具：${lastToolLabel || "(无)"}。` +
          `中止**不是**正常完成 —— 已产出的内容附在下方，请确认后再继续。`
        : `[Turn aborted: ${abortedBy ?? "cancel"}] ${toolCallCount} tool calls, last tool: ${lastToolLabel || "(none)"}. Aborted is NOT a normal completion.`;
      MessageStorage.createMessage({
        id: `err-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        role: "system",
        content: note,
        timestamp: Date.now(),
        status: "error",
      }, sessionId);
      if (delegationTaskId) {
        console.log(`[SessionExecutor] ${sessionId} 已中止，不再上报完成（委派任务保持 cancelled）`);
        orchestrator.cancelTask(delegationTaskId);
      }
      return { output: cleanOutput, toolCallCount, success: false, error: note };
    }

    if (delegationTaskId) {
      orchestrator.completeTask(delegationTaskId, cleanOutput || "[No output]");
    }

    return {
      output: cleanOutput,
      toolCallCount,
      success: true,
    };
  } catch (err: any) {
    console.error(`[SessionExecutor] Failed for session ${sessionId}:`, err);

    // 通知编排器任务失败
    if (delegationTaskId) {
      orchestrator.failTask(delegationTaskId, err.message || String(err));
    }

    // 写错误消息到 DB
    MessageStorage.createMessage({
      id: `err-${Date.now()}`,
      role: "system",
      content: `[Delegation Error] ${err.message || String(err)}`,
      timestamp: Date.now(),
      status: "error",
    }, sessionId);

    return {
      output: "",
      toolCallCount,
      success: false,
      error: err.message || String(err),
    };
  } finally {
    // 第 64 波：看门狗必须释放（它持有定时器）
    watchdog.dispose();
    // 第 65 波：工具挂死上限 + 心跳也要清掉（否则任务结束后还会跑）
    clearToolFlight();
    clearInterval(flightHeartbeat);
    /**
     * ★ 第 309 波：**停顿定时器也要清** ✓ —— 自查发现的一处泄漏 ✓。
     *
     * 它虽然 `unref()` 过 ✓（不会把进程钉住 ✓），但**会在回合结束后照样开火** ✗：
     * 那时它会 `stallController.abort()` ✓ 并打一条"交出控制权"的日志 ✓
     * —— 而**那一轮早就结束了** ✓ ⇒ 日志**骗人** ✓（"看起来停了、其实已经完事"✗），
     * 而且 `stalledOut` 会被置真 ✓（污染原因口径 ✓）。
     * ⇒ 与 `watchdog.dispose()` / `clearToolFlight()` **同一处置** ✓（本仓库既有口径 ✓）。
     */
    clearStallTimer();

    // 清理活跃执行追踪
    activeExecutions.delete(sessionId);

    // 标记会话为非活跃
    useAppStore.getState().setSessionActive(sessionId, false);

    // 如果是委派任务被 abort，标记为 cancelled
    // （但"空闲/预算中止"已经按失败落库，别覆盖成 cancelled）
    if (abort.signal.aborted && delegationTaskId && !watchdog.timedOut() && !abortedBy) {
      orchestrator.cancelTask(delegationTaskId);
    }
  }
}

// ========== 辅助方法 ==========

/** 检查指定会话是否正在后台执行 */
export function isSessionExecuting(sessionId: string): boolean {
  return activeExecutions.has(sessionId);
}

/** 取消指定会话的后台执行 */
export function cancelSessionExecution(sessionId: string): void {
  const controller = activeExecutions.get(sessionId);
  if (controller) {
    controller.abort();
  }
}

/**
 * 处理目标会话的待处理委派任务。
 * 在应用启动或会话切换时调用，检查是否有 pending 的委派需要执行。
 */
export async function processPendingDelegations(
  sessionId: string,
  engine: LLMEngine,
  cwd: string,
  onPermissionRequest?: ExecuteSessionTurnParams["onPermissionRequest"],
): Promise<void> {
  const orchestrator = getDelegationOrchestrator();
  const pending = orchestrator.getPendingDelegationsForTarget(sessionId);

  for (const task of pending) {
    if (isSessionExecuting(sessionId)) {
      // 会话正在执行，等待当前执行完成后再处理
      break;
    }

    console.log(`[SessionExecutor] Processing pending delegation ${task.id} for session ${sessionId}`);

    await executeSessionTurn({
      sessionId,
      message: task.task,
      cwd,
      engine,
      delegationTaskId: task.id,
      onPermissionRequest,
    });
  }
}
