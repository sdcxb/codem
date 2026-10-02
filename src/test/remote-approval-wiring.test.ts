/**
 * 远端审批**接线**判据 —— 第 122 轮阶段 0.1。
 *
 * `approval-broker.test.ts` 守的是代理本身（一次性、fail-closed、有界…）。
 * 这个文件守的是**接线**：把代理造好了却没人喂它，是本仓栽过多次的形态
 * （`output-contract` 框架齐备、零个工具注册过契约，于是整套校验恒真）。
 *
 * | 判据 | 守的是 |
 * |---|---|
 * | RAW-1 | 手机路由表认得 `/api/approvals` 与 `/api/approvals/<id>`（且不误吞其它路径） |
 * | RAW-2 | 微信的回复词表：整条消息才作数，日常句子不能误判成"同意" |
 * | RAW-3 | 通知文案必须写明「只对这一次生效」（远端不该有"永久放行"的暗示） |
 * | RAW-4 | 手机回合**真的**把权限请求交给了代理（不是留着缺省 auto-deny） |
 * | RAW-5 | 手机回合收尾**真的**收口待批项（否则手机没在看就永远挂着） |
 * | RAW-6 | 微信同上（RAW-4/5 的微信版） |
 * | RAW-7 | 微信的审批回复**必须排在"跑回合"之前** —— 顺序反了用户就会撞"正在处理中" |
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parsePhonePath, mapMessages, PHONE_CONTENT_MAX_CHARS, PHONE_REASONING_MAX_CHARS, PHONE_TOOL_BRIEF_MAX_CHARS, PHONE_TOOL_CALLS_MAX } from "../core/phone-link/phone-link";
import { parseApprovalReply, describeApprovalNotice, describePendingApprovals } from "../core/wechat-bridge/wechat-bridge";
import type { ApprovalView } from "../core/permission/approval-broker";

const read = (p: string) => readFileSync(p, "utf8");

describe("第 122 轮阶段 0.1 · 远端审批接线", () => {
  it("RAW-1: 手机路由认得审批两条路径，且不误吞其它路径", () => {
    expect(parsePhonePath("/api/approvals")).toEqual({ type: "approvals" });
    expect(parsePhonePath("/api/approvals/perm-123-abc")).toEqual({
      type: "approval_answer",
      requestId: "perm-123-abc",
    });
    // 阶段 0.2 / 0.3 的两条
    expect(parsePhonePath("/api/chat/cancel")).toEqual({ type: "chat_cancel" });
    expect(parsePhonePath("/api/sessions/s1/run")).toEqual({ type: "run", sessionId: "s1" });
    // 既有路由不受影响
    expect(parsePhonePath("/api/status")).toEqual({ type: "status" });
    expect(parsePhonePath("/api/sessions/s1/messages")).toEqual({ type: "messages", sessionId: "s1" });
    // 边界：不能把 approvals 前缀吞成别的路由，也不能对非 /api 放行
    expect(parsePhonePath("/api/approvals/")).toBeNull();
    expect(parsePhonePath("/api/approvalsx")).toBeNull();
    expect(parsePhonePath("/notapi/approvals")).toBeNull();
    expect(parsePhonePath("/api/sessions/s1/ru")).toBeNull();
  });

  it("RAW-2: 微信回复词表 —— 只有**整条消息**是那个词才算回答", () => {
    // 正例
    for (const t of ["同意", "同意。", " 允许 ", "批准", "OK", "yes", "y", "allow"]) {
      expect(parseApprovalReply(t), `「${t}」应判为同意`).toBe("allow");
    }
    for (const t of ["拒绝", "拒绝！", "不同意", "不行", "no", "n", "deny"]) {
      expect(parseApprovalReply(t), `「${t}」应判为拒绝`).toBe("deny");
    }
    /**
     * 反例是这条判据的重点：**不做子串匹配**。
     * 这些句子出现在"有待批项"的上下文里时，绝不能被当成回答 ——
     * 那会让一次无关的闲聊意外放行一个写操作。
     */
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
    // 远端**没有**"永久放行"，文案不能给出这种暗示
    expect(notice).toContain("只对这一次生效");

    const view = { tool: "bash" } as ApprovalView;
    const pend = describePendingApprovals([view]);
    expect(pend).toContain("bash");
    expect(pend).toContain("同意");
  });

  it("RAW-4: 手机回合**真的**把权限请求交给了代理（不是留着缺省 auto-deny）", () => {
    const src = read("src/core/phone-link/phone-link.ts");
    expect(src).toContain('from "../permission/approval-broker"');
    expect(src, "必须给 executeSessionTurn 传 onPermissionRequest").toMatch(
      /onPermissionRequest:\s*\(request\)\s*=>\s*requestApproval\(request,\s*"phone"\)/,
    );
    /**
     * 反向判据：那条**旧的代码注释**不该还在。
     *
     * ⚠️ 必须带上 `//` 前缀才判 —— 文件头的说明性注释里**故意引用了原话**作为
     * 历史背景（"本文件里那条…自己写明了它"）。第一版不带前缀，于是把那段引用
     * 也算成了"旧注释还在"，红得莫名其妙。判据要盯**代码注释**，不是**所有提到它的文字**。
     */
    expect(src).not.toContain("// onPermissionRequest 缺省策略已安全");
  });

  it("RAW-5: 手机回合收尾**真的**收口待批项（否则手机没在看就永远挂着）", () => {
    const src = read("src/core/phone-link/phone-link.ts");
    // 收口必须在 finally 里（成功/失败/超时三条路都要收）
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
    // 旧的那条代码注释不该还在（带 `//` 前缀才判，理由见 RAW-4）
    expect(src).not.toContain("// onPermissionRequest 缺省策略已安全");
  });

  it("RAW-7: 微信的审批回复**必须排在「跑回合」之前**（顺序反了用户会撞「正在处理中」）", () => {
    const src = read("src/core/wechat-bridge/wechat-bridge.ts");
    const start = src.indexOf("async function processInbound(");
    const end = src.indexOf("// ---- 阶段 0.1：审批通知与回复", start);
    expect(start, "找不到 processInbound").toBeGreaterThan(0);
    expect(end, "找不到 processInbound 的结束标记").toBeGreaterThan(start);
    const body = src.slice(start, end);
    const approvalIdx = body.indexOf("tryHandleApprovalReply");
    const turnIdx = body.indexOf("await runAgentTurn(");
    expect(approvalIdx, "processInbound 里必须调用 tryHandleApprovalReply").toBeGreaterThan(0);
    expect(turnIdx, "processInbound 里必须调用 runAgentTurn").toBeGreaterThan(0);
    expect(
      approvalIdx,
      "审批回复必须**先于**跑回合被检查：回合还在等批准时 isSessionExecuting 为真，" +
        "后检查会让用户的「同意」撞上「上一条消息仍在处理中」",
    ).toBeLessThan(turnIdx);
  });

  it("RAW-8: 阶段 0.2/0.3 的后端动作真的接到既有能力上（不另起一套）", () => {
    const src = read("src/core/phone-link/phone-link.ts");
    // 中断必须复用既有的 cancelSessionExecution（前台/后台共用同一 abort 路径）
    expect(src, "中断要复用 cancelSessionExecution").toMatch(/cancelSessionExecution\(sessionId\)/);
    expect(src, "停止时也要收口待批项（否则卡片一直挂着）").toMatch(
      /closeSessionApprovals\(sessionId,\s*"cancelled"\)/,
    );
    // 进行中状态必须复用 isSessionExecuting，而不是自己维护一个标志
    expect(src, "运行状态要复用 isSessionExecuting").toMatch(/isSessionExecuting\(sessionId\)/);
  });

  it("RAW-9: 阶段 0.4 历史保真 —— 工具摘要有上限，思维链按需", () => {
    const msgs = [
      {
        id: "a1",
        role: "assistant",
        content: "x".repeat(PHONE_CONTENT_MAX_CHARS * 2),
        timestamp: 1,
        reasoning: "r".repeat(PHONE_REASONING_MAX_CHARS * 2),
        toolCalls: [
          { tool: "bash", args: { command: "npx vitest run" }, result: "3 passed", status: "done" },
          { tool: "edit", args: { file_path: "D:\\a.ts" }, result: "写入失败", status: "error" },
        ],
        generatedFiles: ["D:\\a.ts"],
      },
    ];
    // 默认不带思维链（一次 80 条各带一段会大一个量级）
    const thin = mapMessages(msgs as never[]);
    expect(thin[0].reasoning).toBeUndefined();
    // 但工具调用必须在（否则用户不知道 agent 干了什么 —— 这正是 0.4 要修的）
    expect(thin[0].toolCalls?.length).toBe(2);
    expect(thin[0].toolCalls?.[0].tool).toBe("bash");
    expect(thin[0].toolCalls?.[0].brief, "参数摘要要给人看命令本身").toContain("npx vitest run");
    expect(thin[0].toolCalls?.[1].status).toBe("error");
    expect(thin[0].generatedFiles).toEqual(["D:\\a.ts"]);
    // 正文与工具摘要都必须有上限（手机不该为一次列表拉几百 KB）
    expect(thin[0].content.length).toBeLessThan(PHONE_CONTENT_MAX_CHARS + 100);
    expect(thin[0].toolCalls?.[0].brief!.length).toBeLessThan(PHONE_TOOL_BRIEF_MAX_CHARS + 100);

    // 按需打开思维链
    const fat = mapMessages(msgs as never[], true);
    expect(fat[0].reasoning).toBeDefined();
    expect(fat[0].reasoning!.length).toBeLessThan(PHONE_REASONING_MAX_CHARS + 100);

    // 工具条数也要有上限（一次几百个工具调用不该把手机页面撑死）
    const many = mapMessages(
      [{ id: "a2", role: "assistant", content: "", timestamp: 1, toolCalls: Array.from({ length: 200 }, (_, i) => ({ tool: `t${i}`, status: "done" })) }] as never[],
    );
    expect(many[0].toolCalls!.length).toBe(PHONE_TOOL_CALLS_MAX);
  });

  it("RAW-10: 手机页面真的有这三个东西（审批卡片 / 停止 / 工具渲染）", () => {
    const html = read("src-tauri/src/phone/ui/app.html");
    /**
     * ⚠️ 这里必须断言**调用形态**（带 query 的完整路径），不能只断言 `/api/approvals`。
     *
     * 第一版只写了 `toContain("/api/approvals")`，变异自证当场打脸：把请求路径改成
     * `/api/approvals-DISABLED?sessionId=` 之后**判据照样全绿** ——
     * 因为 `/api/approvals` 是那个被改坏的前缀。
     * 断言要盯"它真的在拉这个 URL"，不是"文件里出现过这几个字"。
     */
    expect(html, "审批列表必须真的按 sessionId 拉").toContain('/api/approvals?sessionId=');
    expect(html, "审批回答必须 POST 到 /api/approvals/<id>").toContain('/api/approvals/" + encodeURIComponent(a.requestId)');
    expect(html).toContain('id="apAllow"');
    expect(html).toContain('id="apDeny"');
    expect(html).toContain("只对这一次生效");
    // 停止按钮 + 真的会发取消请求
    expect(html).toContain('api("/api/chat/cancel"');
    expect(html).toContain('id="runStop"');
    // 运行状态真的会拉
    expect(html).toContain('"/run"');
    // 工具渲染
    expect(html).toContain("toolCalls");
    // 轮询里要同时拉这三样（审批/状态不是"消息变化"驱动的）
    expect(html).toMatch(/loadMessages\(\);\s*loadApprovals\(\);\s*loadRun\(\)/);
  });
});
