/**
 * turn 结束的呈现：**失败/中断绝不许显示"任务完成"**。
 *
 * ## 缺陷形态（三处同源）
 *
 * `App.tsx` 的 `case "end"` 里判据是 `result.type === "stop" && reason === "error"`：
 *  1. `{ type: "stop"; reason: "error" }` **从来没有被任何代码构造过** —— 死判据；
 *  2. 循环真正返回的 `{ type: "error"; error }`（LLM 调用最终失败）与
 *     `{ type: "aborted" }`（用户中途停止）**一个都没处理** → 失败的回合掉进"任务完成"；
 *  3. 整段 stop 处理还嵌在 `type === "overflow"` 分支**里面** ——
 *     连 `reason: "completed"` 的正常完成都到不了，"任务完成"卡从未显示过。
 *
 * 呈现决策已抽成纯函数 `describeTurnOutcome`（渲染层没有便宜的整机夹具；
 * 而源码文本断言正是让这个"判据恒假"活下来的原因）。
 *
 * 后台/委派路径（`executeSessionTurn`）同源：它只读 `result.reason`，
 * `{type:"error"}` / `{type:"aborted"}` 没有 reason → 失败回合被当成**成功**交回父会话。
 *
 * ## 判据
 *
 * | # | 造法 | 判据 |
 * | --- | --- | --- |
 * | TURN-ERR | `{type:"error", error}` | 有错误正文、`completionCard === false`、消息 status=error |
 * | TURN-ABORT | `{type:"aborted"}` | 显示"已停止"、`completionCard === false`、不算 error |
 * | TURN-DONE | `{type:"stop", reason:"completed"}` | **唯一**会显示完成卡的形状 |
 * | TURN-DEAD | 旧的死形状 `{type:"stop", reason:"error"}` | 也不许显示完成卡（判据不看 reason） |
 * | EXEC-ERR | 后台回合以 `{type:"error"}` 收场（**且有文本**） | `success === false` |
 * | EXEC-ABORT | 后台回合以 `{type:"aborted"}` 收场 | `success === false` |
 * | EXEC-OK | 反向对照：`{type:"stop", reason:"completed"}` | `success === true` |
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { describeTurnOutcome } from "../core/llm/turn-outcome";
import { executeSessionTurn } from "../core/session/executor";
import { createProject } from "../core/storage/project";
import { createSession } from "../core/storage/session";
import { resetSessionMessageBus } from "../core/session/bus";
import { resetDelegationOrchestrator } from "../core/session/orchestrator";

const PROJECT = "proj-turn-outcome";
const CWD = "D:\\turn-outcome";

beforeEach(() => {
  vi.clearAllMocks();
  resetSessionMessageBus();
  resetDelegationOrchestrator();
  createProject({
    id: PROJECT,
    name: "呈现测试",
    path: CWD,
    createdAt: Date.now(),
    lastAccessedAt: Date.now(),
  } as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function makeSession(id: string): string {
  createSession({
    id,
    projectId: PROJECT,
    title: "呈现测试会话",
    createdAt: Date.now(),
    lastMessageAt: Date.now(),
    messageCount: 0,
  } as never);
  return id;
}

/** 只吐给定事件的假引擎（`executeSessionTurn` 唯一需要的接口是 `process()`） */
function fakeEngine(events: any[]) {
  return {
    process: async function* () {
      for (const e of events) yield e;
    },
    abortSession() {},
  } as never;
}

describe("TURN：end 事件的呈现决策（渲染层与后台路径共用的判据）", () => {
  it("TURN-ERR: {type:'error'} → 错误正文透出、绝不显示完成卡、消息标 error", () => {
    const outcome = describeTurnOutcome({ type: "error", error: "API error 400: bad model" }, { lang: "zh" });

    expect(outcome.kind).toBe("error");
    expect(outcome.completionCard, "失败的回合显示『任务完成』正是本次要修的缺陷").toBe(false);
    expect(outcome.suppressTaskBubble, "失败时不许冒『任务完成！修改了 N 个文件』的气泡").toBe(true);
    expect(String(outcome.notice), "错误正文必须给用户看到（不能只有控制台一行）").toContain("bad model");
    expect(outcome.messageStatus).toBe("error");
    expect(outcome.turnStatus?.kind, "助手下方的 TurnStatus 行要显示失败").toBe("error");
  });

  it("TURN-ABORT: {type:'aborted'} → 显示已停止/被中断，不是完成、也不是 error", () => {
    const outcome = describeTurnOutcome({ type: "aborted" }, { lang: "zh" });

    expect(outcome.kind).toBe("aborted");
    expect(outcome.completionCard, "用户按了停止，界面却说『任务完成』是错的").toBe(false);
    expect(outcome.suppressTaskBubble).toBe(true);
    expect(String(outcome.notice), "要说清是中断，而不是出错").toMatch(/已停止|中断/);
    expect(outcome.messageStatus, "用户主动停止不是错误状态").toBe("done");
    expect(String(outcome.petPhase)).toMatch(/停止/);
  });

  it("TURN-DONE: 只有 {type:'stop', reason:'completed'} 会走完成态", () => {
    const done = describeTurnOutcome({ type: "stop", reason: "completed", usage: {} }, { lang: "zh" });
    expect(done.kind).toBe("completed");
    expect(done.completionCard, "正常完成必须显示完成卡（原来这条被嵌在 overflow 分支里，永远到不了）").toBe(true);
    expect(done.suppressTaskBubble, "正常完成照旧报喜").toBe(false);
    expect(done.notice).toBeUndefined();
    expect(done.messageStatus).toBe("done");
  });

  it("TURN-DEAD: 旧的死形状 {type:'stop', reason:'error'} 也不许显示完成卡", () => {
    const outcome = describeTurnOutcome({ type: "stop", reason: "error" }, { lang: "zh" });
    expect(outcome.completionCard).toBe(false);
    expect(outcome.kind).toBe("stopped");
  });

  it("TURN-OVERFLOW: overflow 形状落 max-tokens 状态（旧判据 result.reason === 'overflow' 恒假）", () => {
    const outcome = describeTurnOutcome({ type: "overflow", message: "上下文窗口已满" }, { lang: "zh" });
    expect(outcome.kind).toBe("overflow");
    expect(outcome.completionCard).toBe(false);
    expect(String(outcome.notice)).toContain("上下文窗口已满");
    expect(outcome.turnStatus?.kind).toBe("max-tokens");
  });

  it("TURN-TOOMANY: {type:'stop', reason:'too_many_errors'} → 报错、不报完成", () => {
    const outcome = describeTurnOutcome({ type: "stop", reason: "too_many_errors" }, { lang: "zh" });
    expect(outcome.completionCard).toBe(false);
    expect(String(outcome.notice)).toMatch(/连续失败/);
    expect(outcome.turnStatus?.kind).toBe("error");
    expect(outcome.turnStatus?.code).toBe("too_many_errors");
  });

  /**
   * 第 93 波：`plan_stale` = 循环被**停滞守卫杀掉**，必须有自己的终态。
   *
   * 用户报的正是「任务提前停掉，然后说完成了」；一手证据（会话
   * `1790981803954-u5dmdoahw`）里循环在第 24 个迭代被杀。这条判据要钉住：
   * **说清"因停滞而停止、这不是正常完成、请人工确认"**，并且带上停滞量级。
   */
  it("TURN-PLAN-STALE: {type:'stop', reason:'plan_stale', detail} → 明确说「这不是正常完成」", () => {
    const outcome = describeTurnOutcome(
      { type: "stop", reason: "plan_stale", usage: {}, detail: { stalledFor: 24 } },
      { lang: "zh" },
    );

    expect(outcome.kind).toBe("stopped");
    expect(outcome.completionCard, "循环被杀掉却显示完成卡，正是用户报的那个缺陷").toBe(false);
    expect(outcome.suppressTaskBubble, "停滞停止不许冒「任务完成！修改了 N 个文件」的气泡").toBe(true);
    expect(String(outcome.notice), "必须说清是停滞停止").toMatch(/停滞/);
    expect(String(outcome.notice), "必须明说这不是正常完成").toMatch(/不是正常完成/);
    expect(String(outcome.notice), "要带上停滞量级（24 个迭代），否则用户不知道有多严重").toContain("24");
    expect(outcome.turnStatus?.kind, "助手下方的 TurnStatus 行要标出来").toBe("error");
    expect(outcome.turnStatus?.code).toBe("plan_stale");
    expect(outcome.messageStatus).toBe("error");
    expect(String(outcome.petPhase), "宠物也不许摆出「完成任务」的样子").toMatch(/问题/);
  });

  it("TURN-PLAN-STALE-B 反向对照: 只有 completed 才走完成态（停滞停止不许被宽恕）", () => {
    const stale = describeTurnOutcome({ type: "stop", reason: "plan_stale" }, { lang: "en" });
    expect(stale.kind).toBe("stopped");
    expect(stale.completionCard).toBe(false);
    // 没有 detail 也要能给出一句人话（不能因为没有量级就静默）
    expect(String(stale.notice)).toMatch(/NOT a normal completion|stall/i);

    const done = describeTurnOutcome({ type: "stop", reason: "completed" }, { lang: "en" });
    expect(done.kind, "反向对照：真完成照旧是 completed").toBe("completed");
    expect(done.completionCard).toBe(true);
  });
});

describe("EXEC：后台/委派回合的 end 结果分类", () => {
  it("EXEC-ERR: 以 {type:'error'} 收场（**且有文本**）→ success:false", async () => {
    const sessionId = makeSession("sess-turn-outcome-err");
    const res = await executeSessionTurn({
      sessionId,
      message: "跑",
      cwd: CWD,
      engine: fakeEngine([
        { type: "text_delta", text: "⚠️ **LLM 调用失败**（iteration 1）：API error 400: bad model" },
        { type: "end", result: { type: "error", error: "API error 400: bad model" } },
      ]),
    });

    expect(
      res.success,
      "{type:'error'} 没有 reason，旧的字符串判据看不见它 —— 失败回合被当成成功交回父会话",
    ).toBe(false);
    expect(String(res.error)).toContain("bad model");
  });

  it("EXEC-OVERFLOW: 以 {type:'overflow'} 收场 → success:false（上下文用尽不是完成；旧判据 result.reason==='overflow' 恒假）", async () => {
    const sessionId = makeSession("sess-turn-outcome-overflow");
    const res = await executeSessionTurn({
      sessionId,
      message: "跑",
      cwd: CWD,
      engine: fakeEngine([
        { type: "text_delta", text: "上下文快满了" },
        { type: "end", result: { type: "overflow", message: "上下文窗口已满，请开启新对话。" } },
      ]),
    });

    expect(res.success, "overflow 形状没有 reason，旧的字符串判据看不见它").toBe(false);
  });

  it("EXEC-ABORT: 以 {type:'aborted'} 收场 → success:false（中止不是完成）", async () => {    const sessionId = makeSession("sess-turn-outcome-abort");
    const res = await executeSessionTurn({
      sessionId,
      message: "跑",
      cwd: CWD,
      engine: fakeEngine([
        { type: "text_delta", text: "半截回答" },
        { type: "end", result: { type: "aborted" } },
      ]),
    });

    expect(res.success, "被中断的回合不许报完成").toBe(false);
  });

  it("EXEC-PLAN-STALE（第 93 波）: 循环被停滞守卫杀掉 → 后台/委派路径必须按失败交回", async () => {
    const sessionId = makeSession("sess-turn-outcome-stale");
    const res = await executeSessionTurn({
      sessionId,
      message: "跑",
      cwd: CWD,
      engine: fakeEngine([
        { type: "text_delta", text: "Now I have the full picture. Let me read the actual edit tool implementation…" },
        {
          type: "end",
          result: { type: "stop", reason: "plan_stale", usage: {}, detail: { stalledFor: 24 } },
        },
      ]),
    });

    expect(
      res.success,
      "被停滞守卫杀掉的循环如果报成功，父会话会拿着半成品继续往下走",
    ).toBe(false);
    expect(String(res.error)).toMatch(/plan_stale|停滞/);
  });

  it("EXEC-OK 反向对照: {type:'stop', reason:'completed'} → success:true", async () => {
    const sessionId = makeSession("sess-turn-outcome-ok");
    const res = await executeSessionTurn({
      sessionId,
      message: "跑",
      cwd: CWD,
      engine: fakeEngine([
        { type: "text_delta", text: "正常回答" },
        { type: "end", result: { type: "stop", reason: "completed" } },
      ]),
    });

    expect(res.success, "正常完成不许被这次改动误判成失败").toBe(true);
  });
});

/**
 * 第 93 波：**后台完成通知**这条接线（App.tsx 的 `finally`）。
 *
 * 这一段只能用源码接线检查来钉：通知逻辑在巨型组件 `App.tsx` 的 `finally` 里，
 * 没有便宜的整机夹具，而它的**判据**（什么算完成）已经由上面那些纯函数用例覆盖。
 * 所以这里只钉一件事，并明确标注它是**接线检查、不是行为判据**：
 * 那条通知必须被"真完成"这个条件守着，不许退回无条件发送。
 * （用户报的「任务提前停掉，然后说完成了」里，这条原生通知
 *  「任务完成 — …」是最直接的来源之一：原来它对停滞停止、LLM 失败、用户取消一律照发。）
 */
describe("App 接线：后台「任务完成」通知必须被真完成守着（接线检查，不是行为判据）", () => {
  it("APP-NOTIFY-GATE: 通知条件里必须出现终态判定（completed），不许无条件发", () => {
    const fs = require("fs");
    const path = require("path");
    const appSrc = fs.readFileSync(path.join(__dirname, "../App.tsx"), "utf-8");
    const idx = appSrc.indexOf("Task completion notification when app is in background");
    expect(idx, "找不到那段后台完成通知（代码搬家了就更新这条接线检查）").toBeGreaterThan(-1);
    const notifyBlock = appSrc.slice(idx, idx + 2000);
    expect(
      notifyBlock,
      '后台通知必须由「这一轮真的完成了」守着（`turnOutcomeForNotify?.kind === "completed"`）——' +
        "无条件发通知 = 停滞/失败/取消也会收到「任务完成」",
    ).toMatch(/if \(!windowVisibleRef\.current && turnOutcomeForNotify\?\.kind === "completed"\)/);
    expect(
      appSrc,
      "`turnOutcomeForNotify` 必须是唯一那份呈现决策（describeTurnOutcome）的结果，不许另立判据",
    ).toMatch(/const outcome = describeTurnOutcome\([\s\S]{0,400}?turnOutcomeForNotify = outcome;/);
  });
});
