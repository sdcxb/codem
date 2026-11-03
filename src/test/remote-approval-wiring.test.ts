/**
 * 远端审批**接线**判据。
 *
 * `approval-broker.test.ts` 守的是代理本身（一次性、fail-closed、有界…）。
 * 这个文件守的是**接线**：把代理造好了却没人喂它，是本仓栽过多次的形态。
 *
 * | 判据 | 守的是 |
 * |---|---|
 * | RAW-1 | 引擎路由认得 `/api/approvals` 与 `/api/approvals/<id>`（且不误吞其它路径） |
 * | RAW-2 | 微信的回复词表：整条消息才作数，日常句子不能误判成"同意" |
 * | RAW-3 | 通知文案必须写明「只对这一次生效」 |
 * | RAW-4 | 引擎回合**真的**把权限请求交给了代理（不是留着缺省 auto-deny） |
 * | RAW-5 | 引擎回合收尾**真的**收口待批项 |
 * | RAW-6 | 微信同上（RAW-4/5 的微信版） |
 * | RAW-7 | 微信的审批回复**必须排在"跑回合"之前** |
 * | RAW-8 | 中断/运行状态复用既有能力（不另起一套） |
 * | RAW-9 | 历史保真：工具摘要有上限，思维链按需 |
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  parseRemotePath,
  mapMessages,
  REMOTE_CONTENT_MAX_CHARS,
  REMOTE_REASONING_MAX_CHARS,
  REMOTE_TOOL_BRIEF_MAX_CHARS,
  REMOTE_TOOL_CALLS_MAX,
} from "../core/remote/desktop-engine";
import { parseApprovalReply, describeApprovalNotice, describePendingApprovals } from "../core/wechat-bridge/wechat-bridge";
import type { ApprovalView } from "../core/permission/approval-broker";

const read = (p: string) => readFileSync(p, "utf8");
const ENGINE = "src/core/remote/desktop-engine.ts";

describe("远端审批接线", () => {
  it("RAW-1: 引擎路由认得审批两条路径，且不误吞其它路径", () => {
    expect(parseRemotePath("/api/approvals")).toEqual({ type: "approvals" });
    expect(parseRemotePath("/api/approvals/perm-123-abc")).toEqual({
      type: "approval_answer",
      requestId: "perm-123-abc",
    });
    expect(parseRemotePath("/api/chat/cancel")).toEqual({ type: "chat_cancel" });
    expect(parseRemotePath("/api/sessions/s1/run")).toEqual({ type: "run", sessionId: "s1" });
    expect(parseRemotePath("/api/status")).toEqual({ type: "status" });
    expect(parseRemotePath("/api/sessions/s1/messages")).toEqual({ type: "messages", sessionId: "s1" });
    expect(parseRemotePath("/api/notices")).toEqual({ type: "notices" });
    // 旧 LAN 事件/在场路由必须不再存在
    expect(parseRemotePath("/api/events")).toBeNull();
    expect(parseRemotePath("/api/presence")).toBeNull();
    // 边界：不能把 approvals 前缀吞成别的路由，也不能对非 /api 放行
    expect(parseRemotePath("/api/approvals/")).toBeNull();
    expect(parseRemotePath("/api/approvalsx")).toBeNull();
    expect(parseRemotePath("/notapi/approvals")).toBeNull();
    expect(parseRemotePath("/api/sessions/s1/ru")).toBeNull();
  });

  it("RAW-2: 微信回复词表 —— 只有**整条消息**是那个词才算回答", () => {
    for (const t of ["同意", "同意。", " 允许 ", "批准", "OK", "yes", "y", "allow"]) {
      expect(parseApprovalReply(t), `「${t}」应判为同意`).toBe("allow");
    }
    for (const t of ["拒绝", "拒绝！", "不同意", "不行", "no", "n", "deny"]) {
      expect(parseApprovalReply(t), `「${t}」应判为拒绝`).toBe("deny");
    }
    for (const t of [
      "你可以帮我看看这个文件吗",
      "同意这个方案吗？",
      "先不要动那个目录，等我确认",
      "好的",
      "",
      "   ",
    ]) {
      expect(parseApprovalReply(t), `「${t}」不该被判成回答`).toBeNull();
    }
  });

  it("RAW-3: 通知文案必须写明「只对这一次生效」", () => {
    const notice = describeApprovalNotice("write", "path: D:\\a.ts");
    expect(notice).toContain("write");
    expect(notice).toContain("path: D:\\a.ts");
    expect(notice).toContain("同意");
    expect(notice).toContain("拒绝");
    expect(notice).toContain("只对这一次生效");

    const view = { tool: "bash" } as ApprovalView;
    const pend = describePendingApprovals([view]);
    expect(pend).toContain("bash");
    expect(pend).toContain("同意");
  });

  it("RAW-4: 引擎回合**真的**把权限请求交给了代理", () => {
    const src = read(ENGINE);
    expect(src).toContain('from "../permission/approval-broker"');
    // 单表达式形状：箭头函数直接返回 requestApproval 的 Promise
    expect(src).toContain('onPermissionRequest: (request) => requestApproval(request, "phone")');
    expect(src).not.toContain("// onPermissionRequest 缺省策略已安全");
  });

  it("RAW-5: 引擎回合收尾**真的**收口待批项（否则远端没在看就永远挂着）", () => {
    const src = read(ENGINE);
    const runTurnIdx = src.indexOf("async function runAgentTurn(");
    const body = src.slice(runTurnIdx, runTurnIdx + 4000);
    const finallyIdx = body.indexOf("} finally {");
    const closeIdx = body.indexOf('closeSessionApprovals(sessionId, "turn_end")');
    expect(finallyIdx, "runAgentTurn 必须有 finally").toBeGreaterThan(0);
    expect(closeIdx, "finally 里必须 closeSessionApprovals").toBeGreaterThan(finallyIdx);
  });

  it("RAW-6: 微信回合同样接了代理与收口", () => {
    const src = read("src/core/wechat-bridge/wechat-bridge.ts");
    expect(src).toContain('from "../permission/approval-broker"');
    expect(src).toMatch(/requestApproval\(request,\s*"wechat"\)/);
    expect(src).toMatch(/closeSessionApprovals\(sessionId,\s*"turn_end"\)/);
    expect(src).not.toContain("// onPermissionRequest 缺省策略已安全");
  });

  it("RAW-7: 微信的审批回复**必须排在「跑回合」之前**", () => {
    const src = read("src/core/wechat-bridge/wechat-bridge.ts");
    const start = src.indexOf("async function processInbound(");
    const end = src.indexOf("// ---- 阶段 0.1：审批通知与回复", start);
    expect(start, "找不到 processInbound").toBeGreaterThan(0);
    expect(end, "找不到 processInbound 的结束标记").toBeGreaterThan(start);
    const body = src.slice(start, end);
    const approvalIdx = body.indexOf("tryHandleApprovalReply");
    const turnIdx = body.indexOf("await runAgentTurn(");
    expect(approvalIdx).toBeGreaterThan(0);
    expect(turnIdx).toBeGreaterThan(0);
    expect(approvalIdx).toBeLessThan(turnIdx);
  });

  it("RAW-8: 中断/运行状态复用既有能力（不另起一套）", () => {
    const src = read(ENGINE);
    expect(src, "中断要复用 cancelSessionExecution").toMatch(/cancelSessionExecution\(sessionId\)/);
    expect(src, "停止时也要收口待批项").toMatch(
      /closeSessionApprovals\(sessionId,\s*"cancelled"\)/,
    );
    expect(src, "运行状态要复用 isSessionExecuting").toMatch(/isSessionExecuting\(sessionId\)/);
  });

  it("RAW-9: 历史保真 —— 工具摘要有上限，思维链按需", () => {
    const msgs = [
      {
        id: "a1",
        role: "assistant",
        content: "x".repeat(REMOTE_CONTENT_MAX_CHARS * 2),
        timestamp: 1,
        reasoning: "r".repeat(REMOTE_REASONING_MAX_CHARS * 2),
        toolCalls: [
          { tool: "bash", args: { command: "npx vitest run" }, result: "3 passed", status: "done" },
          { tool: "edit", args: { file_path: "D:\\a.ts" }, result: "写入失败", status: "error" },
        ],
        generatedFiles: ["D:\\a.ts"],
      },
    ];
    const thin = mapMessages(msgs as never[]);
    expect(thin[0].reasoning).toBeUndefined();
    expect(thin[0].toolCalls?.length).toBe(2);
    expect(thin[0].toolCalls?.[0].tool).toBe("bash");
    expect(thin[0].toolCalls?.[0].brief).toContain("npx vitest run");
    expect(thin[0].toolCalls?.[1].status).toBe("error");
    expect(thin[0].generatedFiles).toEqual(["D:\\a.ts"]);
    expect(thin[0].content.length).toBeLessThan(REMOTE_CONTENT_MAX_CHARS + 100);
    expect(thin[0].toolCalls?.[0].brief!.length).toBeLessThan(REMOTE_TOOL_BRIEF_MAX_CHARS + 100);

    const fat = mapMessages(msgs as never[], true);
    expect(fat[0].reasoning).toBeDefined();
    expect(fat[0].reasoning!.length).toBeLessThan(REMOTE_REASONING_MAX_CHARS + 100);

    const many = mapMessages(
      [{ id: "a2", role: "assistant", content: "", timestamp: 1, toolCalls: Array.from({ length: 200 }, (_, i) => ({ tool: `t${i}`, status: "done" })) }] as never[],
    );
    expect(many[0].toolCalls!.length).toBe(REMOTE_TOOL_CALLS_MAX);
  });
});
