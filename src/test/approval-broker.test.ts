/**
 * 审批代理（approval broker）—— 第 122 轮阶段 0.1。
 *
 * ## 这个文件守的是"远端能不能安全地回答权限请求"
 *
 * 修的病：手机/微信发起的回合里，需要批准的工具**被静默拒绝**
 * （`executor.ts:368-374` 的缺省策略；微信自己注释承认了，见 `wechat-bridge.ts:665`）。
 * 用户看到的是"任务莫名没做"，而不是"它在等你点同意"。
 *
 * 但**把审批权交给走网络的路径**是整个阶段 0 里风险最高的一项 ——
 * 它等于把"是否允许执行一个可能破坏性的操作"的决定权交给远端。
 * 所以这个文件里的判据不是"功能能用"，而是**它不能怎么被用坏**：
 *
 * | 判据 | 守的是 |
 * |---|---|
 * | AB-1 | 正常放行/拒绝两条路都通（先证明功能本身可用） |
 * | AB-2 | **只生效一次**：第二个回答方必须拿到 `approval_not_pending`，且**不能改变结果** |
 * | AB-3 | 动作名白名单：只有 `allow`/`deny`，别的一律拒 |
 * | AB-4 | **刻意不支持"总是允许"**：远端回答时 `alwaysAllow` 必须为 false |
 * | AB-5 | 回合收尾时未回答的**一律按拒绝**（fail-closed），且状态是 closed/expired |
 * | AB-6 | 收尾之后**不能再被回答**（"回合都结束了，谁批的都不算"） |
 * | AB-7 | 入参预览**有上限且截断要注明**（write 的 content 可能有几 MB） |
 * | AB-8 | 已决定条目**有界**（长会话不能把表撑爆） |
 * | AB-9 | 订阅者会收到通知；单个订阅者抛错不影响审批本身 |
 * | AB-10 | 读待批项默认**只给仍在等待的**（界面不该显示已处理的按钮） |
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  requestApproval,
  answerApproval,
  listApprovals,
  closeSessionApprovals,
  closeAllApprovals,
  subscribeApprovals,
  approvalRevision,
  summarizeApprovalInput,
  APPROVAL_PREVIEW_MAX_CHARS,
  DECIDED_HISTORY_LIMIT,
  __resetApprovalsForTests,
} from "../core/permission/approval-broker";
import type { PermissionRequest } from "../core/permission/permission";

let seq = 0;
function req(over: Partial<PermissionRequest> = {}): PermissionRequest {
  seq++;
  return {
    id: `perm-test-${seq}`,
    sessionId: "s-1",
    tool: "write",
    input: { path: "D:\\proj\\a.ts", content: "x" },
    timestamp: 1000 + seq,
    ...over,
  };
}

beforeEach(() => {
  __resetApprovalsForTests();
  seq = 0;
});

describe("第 122 轮阶段 0.1 · 审批代理", () => {
  it("AB-1: 放行与拒绝两条路都通（先证明功能可用）", async () => {
    const r1 = req();
    const p1 = requestApproval(r1, "phone");
    expect(listApprovals({ sessionId: "s-1" }).map((a) => a.requestId)).toEqual([r1.id]);
    const ans1 = answerApproval(r1.id, "allow", "phone");
    expect(ans1.ok).toBe(true);
    await expect(p1).resolves.toMatchObject({ requestId: r1.id, action: "allow" });

    const r2 = req();
    const p2 = requestApproval(r2, "phone");
    expect(answerApproval(r2.id, "deny", "desktop").ok).toBe(true);
    await expect(p2).resolves.toMatchObject({ requestId: r2.id, action: "deny" });
  });

  it("AB-2: **只生效一次** —— 第二个回答方拿到 not_pending，且结果不被改写", async () => {
    const r = req();
    const p = requestApproval(r, "phone");
    expect(answerApproval(r.id, "deny", "phone").ok).toBe(true);

    // 桌面这边晚了一步（用户在电脑上也想点"允许"）
    const second = answerApproval(r.id, "allow", "desktop");
    expect(second.ok).toBe(false);
    expect(second.ok === false && second.code).toBe("approval_not_pending");

    // 关键：结果仍是先到的那个「拒绝」，**没有被后到的"允许"改写**
    await expect(p).resolves.toMatchObject({ action: "deny" });
  });

  it("AB-3: 动作名白名单 —— 只有 allow / deny（别的一律拒）", () => {
    const r = req();
    requestApproval(r, "phone");
    for (const bad of ["always", "accept", "ALLOW", "", "yes"]) {
      const out = answerApproval(r.id, bad as never, "phone");
      expect(out.ok, `动作 "${bad}" 不该被接受`).toBe(false);
      expect(out.ok === false && out.code).toBe("approval_invalid_action");
    }
    // 无效动作**不能**把这条消耗掉：合法动作仍然可以回答
    expect(listApprovals().length).toBe(1);
    expect(answerApproval(r.id, "allow", "phone").ok).toBe(true);
  });

  it("AB-4: **刻意不支持「总是允许」** —— 远端回答时 alwaysAllow 必须为 false", async () => {
    /**
     * DSH 的契约是「a grant always applies once」（插件 `approvals.ts:14`），
     * 只给 `allow-once` / `reject` 两个动作。我们照抄：
     * 远端在网络上，一个"以后都别问我"的按钮会让后面所有同类操作**永久放行**，
     * 而用户可能只是想在手机上快速点过这一步。
     */
    const r = req();
    const p = requestApproval(r, "phone");
    answerApproval(r.id, "allow", "phone");
    const result = await p;
    expect(result.alwaysAllow, "远端批准绝不允许带 alwaysAllow").toBe(false);
  });

  it("AB-5: 回合收尾 ⇒ 未回答的**一律按拒绝**收尾（fail-closed）", async () => {
    const a = req({ sessionId: "s-1" });
    const b = req({ sessionId: "s-1" });
    const c = req({ sessionId: "s-2" }); // 别的会话，不该被牵连
    const pa = requestApproval(a, "phone");
    const pb = requestApproval(b, "phone");
    const pc = requestApproval(c, "phone");

    const closed = closeSessionApprovals("s-1", "turn_end");
    expect(closed).toBe(2);
    await expect(pa).resolves.toMatchObject({ action: "deny" });
    await expect(pb).resolves.toMatchObject({ action: "deny" });

    // 别的会话仍在等待（收尾必须按会话隔离）
    expect(listApprovals({ sessionId: "s-2" }).length).toBe(1);
    expect(answerApproval(c.id, "allow", "phone").ok).toBe(true);
    await expect(pc).resolves.toMatchObject({ action: "allow" });
  });

  it("AB-6: 收尾之后**不能再被回答** —— 回合都结束了，谁批的都不算", async () => {
    const r = req();
    const p = requestApproval(r, "phone");
    closeSessionApprovals("s-1", "aborted");
    const late = answerApproval(r.id, "allow", "phone");
    expect(late.ok).toBe(false);
    expect(late.ok === false && late.code).toBe("approval_not_pending");
    // 结果仍然是收尾时的拒绝
    await expect(p).resolves.toMatchObject({ action: "deny" });
  });

  it("AB-6b: `closeAllApprovals` 是进程级收口（引擎销毁 / 全局取消）", async () => {
    const a = requestApproval(req({ sessionId: "s-1" }), "wechat");
    const b = requestApproval(req({ sessionId: "s-9" }), "phone");
    expect(closeAllApprovals("cancelled")).toBe(2);
    await expect(a).resolves.toMatchObject({ action: "deny" });
    await expect(b).resolves.toMatchObject({ action: "deny" });
  });

  it("AB-7: 入参预览**有上限**、截断必须注明，且**不能只剩路径**（否则用户没法判断）", () => {
    // write 的 content 可能有几 MB —— 不能整包发给手机
    const huge = "甲".repeat(APPROVAL_PREVIEW_MAX_CHARS * 3);
    const preview = summarizeApprovalInput({ path: "D:\\x.md", content: huge });
    expect(preview.length).toBeLessThan(APPROVAL_PREVIEW_MAX_CHARS + 200);
    /**
     * ⚠️ 这一条是**测试抓出来的真缺陷**：第一版遇到 `path` 就直接返回路径、把 `content`
     * 整个丢掉，于是手机上显示 `path: D:\x.md` —— 用户完全无法判断"要往里写什么"，
     * 而审批的全部意义就是让他判断该不该做。现在长字段给**有上限的摘录**。
     */
    expect(preview, "写操作必须能看到内容摘录，不能只有路径").toContain("content:");
    expect(preview, "写操作必须能看到内容摘录，不能只有路径").toContain("甲");
    /**
     * 截断提示的**判据要判"用户知不知道自己在看节选"**，而不是判某一句话。
     * 上面那个大字段走的是**单字段摘录**（`此处显示前 800 字符`），
     * 而总长超限时走的是**整体截断**（`预览已截断`）—— 两条路都得让用户知道两件事：
     * ① 这是节选；② **原文到底多长**（不知道原长就无法判断"剩下的是不是关键部分"）。
     */
    expect(preview, "必须写明这是节选").toMatch(/此处显示前|预览已截断/);
    expect(preview, "必须给出原长").toContain(String(huge.length));

    // bash 家族：命令本身才是最该看的，且排在第一位
    const cmd = summarizeApprovalInput({ command: "git status", workdir: "D:\\proj" });
    expect(cmd.startsWith("command: git status")).toBe(true);
    expect(cmd).toContain("workdir: D:\\proj");

    // 未超限时不出现截断提示（不要没事就喊截断）
    expect(summarizeApprovalInput({ path: "D:\\a.ts" })).toBe("path: D:\\a.ts");

    // 不可序列化要如实说，而不是给空串
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(summarizeApprovalInput(circular)).toContain("无法序列化");
  });

  it("AB-8: 已决定条目**有界** —— 长会话不能把表撑爆", () => {
    for (let i = 0; i < DECIDED_HISTORY_LIMIT + 40; i++) {
      const r = req();
      requestApproval(r, "phone");
      answerApproval(r.id, "allow", "phone");
    }
    const decided = listApprovals({ includeDecided: true });
    expect(decided.length).toBeLessThanOrEqual(DECIDED_HISTORY_LIMIT);
    // 而且留下的应该是**最近的**（老的先被回收）
    const ids = decided.map((d) => d.requestId);
    expect(ids).toContain(`perm-test-${DECIDED_HISTORY_LIMIT + 40}`);
    expect(ids).not.toContain("perm-test-1");
  });

  it("AB-9: 订阅者收到通知；单个订阅者抛错不影响审批本身", async () => {
    const good = vi.fn();
    const offBad = subscribeApprovals(() => {
      throw new Error("订阅者内部错误");
    });
    const offGood = subscribeApprovals(good);
    const before = approvalRevision();

    const r = req();
    const p = requestApproval(r, "phone");
    expect(good).toHaveBeenCalled();
    expect(approvalRevision()).toBeGreaterThan(before);

    expect(() => answerApproval(r.id, "allow", "phone")).not.toThrow();
    await expect(p).resolves.toMatchObject({ action: "allow" });
    offBad();
    offGood();
  });

  it("AB-10: 读待批项默认**只给仍在等待的**；`includeDecided` 才带上已处理的", async () => {
    const open = req();
    const done = req();
    requestApproval(open, "phone");
    requestApproval(done, "phone");
    answerApproval(done.id, "allow", "desktop");

    const pendingOnly = listApprovals();
    expect(pendingOnly.map((a) => a.requestId)).toEqual([open.id]);
    expect(pendingOnly[0].responseRequired).toBe(true);

    const all = listApprovals({ includeDecided: true });
    expect(all.length).toBe(2);
    const finished = all.find((a) => a.requestId === done.id)!;
    // 已处理的必须**带上谁批的、批了什么** —— 另一个回答方据此显示"已被桌面处理"，
    // 而不是继续显示两个按钮（那是 DSH `approvals.ts:69-72` 的判据）
    expect(finished.responseRequired).toBe(false);
    expect(finished.decidedBy).toBe("desktop");
    expect(finished.decidedAction).toBe("allow");
  });
});
