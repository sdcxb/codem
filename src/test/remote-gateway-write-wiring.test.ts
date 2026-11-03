/**
 * 网关写路径**接线**判据（GW-X1..GW-X6，ADR-0005 M2 写路径第一批）。
 *
 * `remote-gateway-write.test.ts` 守协议形状，`gateway-run-registry.test.ts` 守归属表。
 * 这个文件守的是**它们真的接上了桌面唯一循环** —— 本仓反复出现"零件造好了但没人装"：
 *
 * | 判据 | 守的是 |
 * |---|---|
 * | GW-X1 | `prompt.send` / `run.cancel` 注入到网关数据层（不是写在别处） |
 * | GW-X2 | 执行只走**一个** `executeSessionTurn` 调用点（没有第二套循环） |
 * | GW-X3 | 网关回合是"先受理后执行"：不 `await` 回合、不阻塞 15s 的 Rust 往返 |
 * | GW-X4 | 预检与启动之间**没有 await**（忙判定 + run 归属 + 登记是一个原子块） |
 * | GW-X5 | 取消复用既有能力：`cancelSessionExecution` + 审批收口 |
 * | GW-X6 | 机器级并发上限在网关路径上真的有（AA 路径的缺口不延续） |
 * | GW-X7 | 审批两条接在桌面**同一张**待批表上（手机/桌面/回合收尾同一个真相） |
 * | GW-X8 | 事件来自唯一循环的观察者（不双写、不轮询），发布走唯一命令且串行 |
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { gatewayConcurrencyRejection } from "../core/remote/desktop-engine";

const ROOT = join(__dirname, "..", "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const ENGINE = "src/core/remote/desktop-engine.ts";

function sliceFunction(src: string, start: string, end: string): string {
  const from = src.indexOf(start);
  const to = src.indexOf(end, from);
  expect(from, `找不到 ${start}`).toBeGreaterThan(0);
  expect(to, `找不到 ${start} 的结束标记 ${end}`).toBeGreaterThan(from);
  return src.slice(from, to);
}

describe("网关写路径接线", () => {
  it("GW-X1: 两个写方法注入到网关数据层", () => {
    const src = read(ENGINE);
    const deps = sliceFunction(src, "await handleGatewayRequest(", "const route = parseRemotePath(");
    expect(deps).toContain("sendPrompt: gatewaySendPrompt");
    expect(deps).toContain("cancelRun: gatewayCancelRun");
    // 网关只认自己的路径：不能退化成 /api/* 的分支
    expect(deps).toContain("listSessions: flattenSessions");
    expect(deps).toContain("getSession: gatewaySessionDetail");
  });

  it("GW-X2: 执行只有一个调用点（网关复用桌面 Agent 循环，不建第二套）", () => {
    const src = read(ENGINE);
    const calls = src.match(/executeSessionTurn\(\{/g) ?? [];
    expect(calls.length, "桌面引擎里只允许一个 executeSessionTurn 调用点").toBe(1);
    expect(src).not.toContain("new AgenticLoop(");
    expect(src).not.toContain("engine.process(");

    // 网关回合必须走 AA 同一条 runAgentTurn（→ 上面的唯一调用点），
    // 并且把循环事件**只**接给观察者（不是第二条执行路径）。
    const gatewaySend = sliceFunction(src, "async function gatewaySendPrompt(", "function gatewayCancelRun(");
    expect(gatewaySend).toContain("runAgentTurn(sessionId, text, {");
    expect(gatewaySend).toContain("onLoopEvent: (event) =>");
    expect(gatewaySend).toContain("mapLoopEventToGatewayEvent(event, { sessionId, runId })");
  });

  it("GW-X3: 先受理后执行 —— 网关路径不 await 回合，且终态一定发布", () => {
    const src = read(ENGINE);
    const gatewaySend = sliceFunction(src, "async function gatewaySendPrompt(", "function gatewayCancelRun(");
    expect(gatewaySend).toContain("const turn = runAgentTurn(sessionId, text, {");
    expect(gatewaySend).toContain("void turn.then(");
    expect(gatewaySend, "网关返回 runId 前不能等回合跑完（Rust 往返只有 15s）").not.toContain(
      "await runAgentTurn(",
    );
    // 结算必须记账（finished/failed），否则归属表会永远显示 running
    expect(gatewaySend).toContain('gatewayRuns.finish(runId, result.ok ? "finished" : "failed")');
    // 终态必须发事件（取消过的 run 落成 cancelled，手机才知道"是你停的"）
    expect(gatewaySend).toContain("publishGatewayRunTerminal(");
    expect(gatewaySend).toContain("settled?.state");
  });

  it("GW-X4: 预检之后到启动之前没有 await（忙判定 + 归属 + 登记必须原子）", () => {
    const src = read(ENGINE);
    const gatewaySend = sliceFunction(src, "async function gatewaySendPrompt(", "function gatewayCancelRun(");
    const preIdx = gatewaySend.indexOf("const pre = await preflightRemoteTurn(sessionId);");
    const busyIdx = gatewaySend.indexOf("if (isSessionExecuting(sessionId))", preIdx);
    const claimIdx = gatewaySend.indexOf("gatewayRuns.claim(", busyIdx);
    const startIdx = gatewaySend.indexOf("const turn = runAgentTurn(sessionId, text, {", claimIdx);
    expect(preIdx).toBeGreaterThan(0);
    expect(busyIdx).toBeGreaterThan(preIdx);
    expect(claimIdx).toBeGreaterThan(busyIdx);
    expect(startIdx).toBeGreaterThan(claimIdx);

    // 幂等键必须**先于**忙预检：否则重发同一条 requestId 会得到 BUSY（用户看到"发送失败"，
    // 而桌面正在跑他的上一条）。
    const dedupIdx = gatewaySend.indexOf("gatewayRuns.findByRequestId(");
    expect(dedupIdx).toBeGreaterThan(0);
    expect(dedupIdx).toBeLessThan(preIdx);

    // 从预检到启动的这段里，"await" 只允许出现在预检那一行本身。
    const critical = gatewaySend.slice(preIdx, startIdx);
    expect(
      (critical.match(/\bawait\b/g) ?? []).length,
      "预检与启动之间插入 await 会让桌面回合有机会抢进同一会话",
    ).toBe(1);
  });

  it("GW-X5: 取消复用既有能力（abort + 审批收口），不另起中断机制", () => {
    const src = read(ENGINE);
    const gatewayCancel = sliceFunction(src, "function gatewayCancelRun(", "async function handleRemoteRequest(");
    expect(gatewayCancel).toContain("cancelSessionExecution(sessionId)");
    // 循环可能正 await onPermissionRequest：不 resolve 那个 Promise，abort 结束不了回合
    expect(gatewayCancel).toContain('closeSessionApprovals(sessionId, "cancelled")');

    // 取消只作用于网关自己的 run：归属表先判（RUN_NOT_FOUND / RUN_OWNED 如实拒绝）
    expect(gatewayCancel).toContain("gatewayRuns.requestCancel(");
    expect(gatewayCancel).toContain('kind: "RUN_NOT_FOUND"');
    // 桌面回合不能被网关"假装停掉"：文案必须说清只能去桌面停
    expect(gatewayCancel).toContain("桌面回合只能在桌面停止");
  });

  it("GW-X6: 机器级并发上限在网关路径上真的有（且不是永远放行的装饰）", () => {
    const src = read(ENGINE);
    const gatewaySend = sliceFunction(src, "async function gatewaySendPrompt(", "function gatewayCancelRun(");
    expect(gatewaySend).toContain("gatewayConcurrencyRejection(getActiveExecutionCount(), getConcurrencyLimit())");
    expect(gatewaySend).toContain('kind: "BUSY_LIMIT"');
    // 判定的结果必须真的被 if 消费（`if (false && busyLimit)` 这种"装饰性守卫"要红）
    expect(gatewaySend).toMatch(
      /const busyLimit = gatewayConcurrencyRejection\(getActiveExecutionCount\(\), getConcurrencyLimit\(\)\);\s*\n\s*if \(busyLimit\) \{/,
    );

    // 行为判据：上限判定本身可被单测（不再只是"源码里出现过这个字符串"）。
    expect(gatewayConcurrencyRejection(0, 1)).toBeNull();
    expect(gatewayConcurrencyRejection(1, 1)).toContain("并发上限");
    expect(gatewayConcurrencyRejection(1, 2)).toBeNull();
    expect(gatewayConcurrencyRejection(2, 2)).toContain("并发上限");
    // 上限不可信时按 1 处理：宁可少跑一轮，也不在"算不出来"时让远程把机器打满
    expect(gatewayConcurrencyRejection(1, Number.NaN)).toContain("并发上限（1）");
    expect(gatewayConcurrencyRejection(1, 0)).toContain("并发上限（1）");
    expect(gatewayConcurrencyRejection(0, Number.NaN)).toBeNull();
  });

  it("GW-X7: 审批两条接在桌面同一张待批表上（不是网关另存一份）", () => {
    const src = read(ENGINE);
    const deps = sliceFunction(src, "await handleGatewayRequest(", "const route = parseRemotePath(");
    expect(deps).toContain("listApprovals: gatewayListApprovals");
    expect(deps).toContain("respondApproval: gatewayRespondApproval");

    const listFn = sliceFunction(src, "function gatewayListApprovals(", "function gatewayRespondApproval(");
    expect(listFn, "读待批必须走代理的 listApprovals").toContain("listApprovals({");
    expect(listFn).toContain("includeDecided: input.includeDecided === true");

    const respondFn = sliceFunction(src, "function gatewayRespondApproval(", "async function invokeRemoteRespond(");
    // 答复必须走代理的唯一裁决点（一次性 + fail-closed 都在那里）
    expect(respondFn).toContain('answerApproval(input.approvalId, input.decision, "phone")');
    expect(respondFn).not.toContain("resolve(");

    // 桌面 UI 同步：订阅代理变化 → 发 requested/resolved（任何一方回答都会同步）
    expect(src).toContain("subscribeApprovals(publishApprovalChanges)");
    expect(src).toContain("gatewayApprovalEvents.diff(");
    expect(src).toContain("{ includeDecided: true }");
  });

  it("GW-X8: 事件来自唯一循环的观察者（不双写、不轮询），发布走唯一命令且串行", () => {
    const src = read(ENGINE);
    const runTurn = sliceFunction(src, "async function runAgentTurn(", "async function handleRemoteRequest(");
    // 观察者只是透传：不参与执行、不写库
    expect(runTurn).toContain("...(opts?.onLoopEvent ? { onEvent: opts.onLoopEvent } : {})");

    const executor = read("src/core/session/executor.ts");
    expect(executor).toContain("onEvent?: (event: LoopEvent) => void;");
    expect(executor, "观察者必须在消费循环里被调用").toContain("onEvent(event);");
    // 观察者异常不许影响回合（观测设施的纪律）
    expect(executor).toContain('console.warn("[SessionExecutor] onEvent observer failed:", e);');

    // 事件模块不得成为第二个写入者
    const eventsSrc = read("src/core/remote/gateway-events.ts");
    for (const banned of ["MessageStorage", "createMessage", "updateMessage", "getEventLog", "append("]) {
      expect(eventsSrc, `事件投影不得写会话数据：${banned}`).not.toContain(banned);
    }

    // 发布只有一个命令，且必须串行（IPC 乱序会让 tool.end 抢在 tool.start 前面）
    expect(src).toContain('invoke("gateway_publish_event"');
    expect(eventsSrc).toContain("this.chain = this.chain.then(");
    expect(
      (src.match(/invoke\("gateway_publish_event"/g) ?? []).length,
      "发布入口只允许一处",
    ).toBe(1);
  });
});
