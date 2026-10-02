/**
 * 阶段 R4 判据 —— 通知/交互模型：R4-1..R4-10。
 *
 * 依据是它插件侧的 `host/dsh-runtime/approvals.ts` 与 `identity.ts`。
 *
 * | 判据 | 守的是 |
 * |---|---|
 * | R4-1 | 八态齐备，且 pending/terminal **覆盖全部、互斥**（漏一个就有人永远等下去） |
 * | R4-2 | 动作 id 是 `allow-once`/`reject`（**不是** allow/deny），不认识的不许猜 |
 * | R4-3 | 通知形状逐字段对齐（含 `blocking` / `source` / `context` / `metadata`） |
 * | R4-4 | **落定后不给动作**，且不再 `blocking`（否则界面会一直显示"卡着"） |
 * | R4-5 | 缺省文案必须写明"**仅对本次请求生效**"（安全承诺，不能省） |
 * | R4-6 | 错误码逐字（not_pending / invalid_action / unavailable） |
 * | R4-7 | 历史收敛**只丢已落定的**，待处理的一条都不许丢 |
 * | R4-8 | 回合结束把待处理置 `expired`（否则卡片挂着、点了才发现失效） |
 * | R4-9 | 标识派生：`aaItemId` 用 `\0` 分隔（不同条目不许撞 id） |
 * | R4-10 | 规范 JSON 按**码点**排序（非 BMP 键上不能与 Python 分叉） |
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  NOTICE_STATUSES,
  isPendingStatus,
  isTerminalStatus,
  CLOSED_HISTORY_LIMIT,
  platformSessionId,
  aaItemId,
  REMOTE_ACTION_ALLOW,
  REMOTE_ACTION_REJECT,
  CODE_NOT_PENDING,
  CODE_INVALID_ACTION,
  CODE_UNAVAILABLE,
  remoteActionToInternal,
  noticeFromApproval,
  countPending,
  trimClosedHistory,
  expirePendingForTurnEnd,
  type ApprovalLike,
} from "../core/phone-link/aa-notice";
import { canonicalJson, compareCodePoints, sha256Hex } from "../core/phone-link/aa-protocol-ids";

const pendingApproval: ApprovalLike = {
  requestId: "evt-1",
  tool: "bash",
  reason: "要执行 rm -rf",
  callId: "call-9",
  status: "open",
  revision: 3,
};

describe("阶段 R4 · 通知/交互模型", () => {
  it("R4-1: 八态齐备，pending/terminal 覆盖全部且互斥", () => {
    expect(NOTICE_STATUSES).toHaveLength(8);
    for (const s of NOTICE_STATUSES) {
      // 恰好属于 pending 或 terminal 之一 —— 漏一个状态就会有人永远等下去
      expect(isPendingStatus(s) !== isTerminalStatus(s), `${s} 必须恰好属于一类`).toBe(true);
    }
    // 它的 DSH 适配层实际用到的五个都在这八态里
    for (const s of ["open", "responding", "resolved", "closed", "expired"]) {
      if (s === "closed") continue; // closed 是它内部字段，不是协议态
      expect(NOTICE_STATUSES).toContain(s as never);
    }
    // responding 必须是 pending（这正是我们阶段 0 缺的那一态）
    expect(isPendingStatus("responding")).toBe(true);
    expect(isTerminalStatus("resolved")).toBe(true);
  });

  it("R4-2: 动作 id 是 allow-once / reject，不认识的不许猜", () => {
    expect(REMOTE_ACTION_ALLOW).toBe("allow-once");
    expect(REMOTE_ACTION_REJECT).toBe("reject");
    expect(remoteActionToInternal("allow-once")).toBe("allow");
    expect(remoteActionToInternal("reject")).toBe("deny");
    // 我们自己的内部词汇**不是**远端的词汇 —— 不许把旧的当成合法的远端动作
    expect(remoteActionToInternal("allow")).toBeNull();
    expect(remoteActionToInternal("deny")).toBeNull();
    expect(remoteActionToInternal("")).toBeNull();
    expect(remoteActionToInternal("allow-always")).toBeNull();
  });

  it("R4-3: 通知形状逐字段对齐", () => {
    const n = noticeFromApproval(pendingApproval, "sess-abc");
    expect(n.noticeId).toBe(aaItemId("sess-abc", "approval", "evt-1"));
    expect(n.noticeId.startsWith("dsh_")).toBe(true);
    expect(n.sessionId).toBe("sess-abc");
    expect(n.runtime).toBe("dsh");
    expect(n.type).toBe("interaction");
    expect(n.interactionType).toBe("approval");
    expect(n.title).toBe("请求批准：bash");
    expect(n.message).toBe("要执行 rm -rf");
    expect(n.severity).toBe("warning");
    expect(n.status).toBe("open");
    expect(n.revision).toBe(3);
    expect(n.responseRequired).toBe(true);
    expect(n.blocking).toEqual({ scope: "session", targetId: "sess-abc" });
    expect(n.source).toEqual({ runtime: "dsh", component: "dsh.approval" });
    expect(n.context).toEqual({ toolName: "bash", callId: "call-9" });
    expect(n.metadata).toEqual({ eventId: "evt-1" });
    // 没有 callId 时 context 里**不该**出现这个键（不是 null）
    const noCall = noticeFromApproval({ ...pendingApproval, callId: undefined }, "s");
    expect("callId" in noCall.context).toBe(false);
    expect(Object.keys(noCall.context)).toEqual(["toolName"]);
  });

  it("R4-4: 落定后不给动作，且不再 blocking", () => {
    for (const status of ["resolved", "expired", "cancelled", "failed"]) {
      const n = noticeFromApproval({ ...pendingApproval, status }, "s");
      expect(n.actions, `${status} 之后不该还有动作`).toEqual([]);
      expect(n.responseRequired, `${status} 之后不该要求响应`).toBe(false);
      /**
       * blocking 必须清掉：留着的话界面会一直显示"这个会话被卡住了"，
       * 而实际回合早就走完了。
       */
      expect(n.blocking, `${status} 之后不该继续阻塞`).toBeNull();
    }
    // 中间态仍然算待处理（有人点了但还没落地）
    for (const status of ["responding", "response_accepted", "resolving"]) {
      const n = noticeFromApproval({ ...pendingApproval, status }, "s");
      expect(n.responseRequired, `${status} 应仍算待处理`).toBe(true);
      expect(n.blocking).not.toBeNull();
    }
  });

  it("R4-5: 缺省文案必须写明「仅对本次请求生效」", () => {
    const noReason = noticeFromApproval({ ...pendingApproval, reason: undefined }, "s");
    /**
     * 这不是文案洁癖：它是一句**安全承诺** ——
     * 用户看到"允许"时要知道这**不会**变成长期放行。
     * 我们的实现也确实只支持一次性授权（`alwaysAllow` 恒为 false）。
     */
    expect(noReason.message).toContain("仅对本次请求生效");
    // 有 reason 时用 reason（它的行为）
    expect(noticeFromApproval(pendingApproval, "s").message).toBe("要执行 rm -rf");
  });

  it("R4-6: 错误码逐字", () => {
    expect(CODE_NOT_PENDING).toBe("dsh_approval_not_pending");
    expect(CODE_INVALID_ACTION).toBe("dsh_approval_invalid_action");
    expect(CODE_UNAVAILABLE).toBe("dsh_approval_unavailable");
  });

  it("R4-7: 历史收敛只丢已落定的，待处理的一条都不许丢", () => {
    expect(CLOSED_HISTORY_LIMIT).toBe(128);
    // 200 条已落定 + 3 条待处理
    const entries = [
      ...Array.from({ length: 200 }, (_, i) => ({ id: `c${i}`, status: "resolved" })),
      { id: "p1", status: "open" },
      { id: "p2", status: "responding" },
      { id: "p3", status: "response_accepted" },
    ];
    const kept = trimClosedHistory(entries);
    expect(kept.filter((e) => e.status === "resolved")).toHaveLength(128);
    // ⚠️ 待处理的一条都不能少 —— 丢了会让卡片凭空消失、而回合永远等下去
    for (const id of ["p1", "p2", "p3"]) {
      expect(kept.some((e) => e.id === id), `${id} 不该被收敛掉`).toBe(true);
    }
    // 保留的已落定项是**最近的**（丢最旧的）
    expect(kept.some((e) => e.id === "c199")).toBe(true);
    expect(kept.some((e) => e.id === "c0")).toBe(false);
    // 不超过上限时原样返回
    const small = [{ id: "a", status: "resolved" }];
    expect(trimClosedHistory(small)).toBe(small);
  });

  it("R4-8: 回合结束把待处理置 expired", () => {
    const entries = [
      { id: "a", status: "open" },
      { id: "b", status: "responding" },
      { id: "c", status: "resolved" },
      { id: "d", status: "expired" },
    ];
    const { changed, expiredCount } = expirePendingForTurnEnd(entries);
    expect(expiredCount).toBe(2);
    expect(changed.find((e) => e.id === "a")!.status).toBe("expired");
    expect(changed.find((e) => e.id === "b")!.status).toBe("expired");
    // 已落定的**不许**被动（把 resolved 改成 expired 会让"已批准"变成"已失效"）
    expect(changed.find((e) => e.id === "c")!.status).toBe("resolved");
    expect(changed.find((e) => e.id === "d")!.status).toBe("expired");
    // 原数组不被就地改（纯函数）
    expect(entries[0].status).toBe("open");
    // 没有待处理时不报"改了 2 条"
    expect(expirePendingForTurnEnd([{ id: "x", status: "resolved" }]).expiredCount).toBe(0);
  });

  it("R4-9: 标识派生 —— `\\0` 分隔，不同条目不许撞 id", () => {
    // aaItemId 与它 identity.ts 的 itemId 同语义
    const id = aaItemId("s1", "approval", "e1");
    expect(id.startsWith("dsh_")).toBe(true);
    expect(id).toHaveLength(4 + 64);
    // 分隔符必须真的存在：否则 ("ab","c","d") 与 ("a","bc","d") 会撞
    expect(aaItemId("ab", "c", "d")).not.toBe(aaItemId("a", "bc", "d"));
    expect(aaItemId("a", "bc", "d")).not.toBe(aaItemId("a", "b", "cd"));
    // 与 sha256Hex 的实现一致（自己能算出来）
    expect(id).toBe(`dsh_${sha256Hex("s1\u0000approval\u0000e1")}`);
    // platformSessionId：幂等的前缀是 `aa_<ns16>_`（不是 `sess_dsh_`）。
    const nsPrefix = `aa_${sha256Hex("codem").slice(0, 16)}_`;
    const platform = platformSessionId("codem", "ext-1");
    expect(platform.startsWith("sess_dsh_")).toBe(true);
    expect(platform).toBe(`sess_dsh_${sha256Hex("codem:dsh:ext-1").slice(0, 24)}`);
    // 已经是 `aa_<ns16>_<ext>` 形式 ⇒ 剥掉前缀返回 ext
    expect(platformSessionId("codem", `${nsPrefix}ext-1`)).toBe("ext-1");
    /**
     * ⚠️ 而 `sess_dsh_...` 形式的输入**不会**被当成平台 id —— 它会**再派生一次**。
     * 我第一版想当然地断言"传进去什么就返回什么"（幂等），判据当场红。
     * 查它的 `identity.ts`：幂等前缀确实是 `aa_<ns16>_`，我记错了对象。
     * 这里把这个**实际行为**钉下来（而不是钉我脑子里的版本）。
     */
    expect(platformSessionId("codem", platform)).not.toBe(platform);
    // 派生是确定性的（同样的输入永远同样的输出）
    expect(platformSessionId("codem", platform)).toBe(platformSessionId("codem", platform));
    // 非法字符 / 带空格 ⇒ 走派生，不原样返回
    expect(platformSessionId("codem", "has space")).not.toBe("has space");
    // 命名空间不同 ⇒ 同一外部 id 得到不同平台 id
    expect(platformSessionId("other", "ext-1")).not.toBe(platformSessionId("codem", "ext-1"));
  });

  it("R4-10: 规范 JSON 按**码点**排序（非 BMP 键上不能与 Python 分叉）", () => {
    /**
     * JS 默认 `.sort()` 比的是 **UTF-16 码元**，Python 的 `sort_keys=True` 比**码点**。
     * 非 BMP 字符（emoji）上两者结果相反：U+FFFD 的码元是 `FFFD`，
     * 而 U+10000 的码元是 `D800 DC00` —— 按码元会把 emoji 排在 U+FFFD **前面**，
     * 按码点则应排在其后。
     */
    expect(compareCodePoints("\u{10000}", "\uFFFD")).toBeGreaterThan(0);
    // 用默认 sort 会得到相反的结论（这就是必须自己比的原因）
    expect(["\u{10000}", "\uFFFD"].sort()[0]).toBe("\u{10000}");

    const obj = { "\u{10000}": 1, "\uFFFD": 2, a: 3 };
    const out = canonicalJson(obj);
    // 码点序：a(0x61) < U+FFFD(0xFFFD) < U+10000
    expect(out).toBe('{"a":3,"\uFFFD":2,"\u{10000}":1}');
    // 紧凑、非 ASCII 原样
    expect(out).not.toContain(": ");
    expect(canonicalJson({ b: 1, a: { z: 2, y: 3 }, c: "甲" })).toBe(
      '{"a":{"y":3,"z":2},"b":1,"c":"甲"}',
    );
    expect(canonicalJson([1, "甲", null])).toBe('[1,"甲",null]');
  });

  it("R4-11: countPending 只数待处理的", () => {
    expect(
      countPending([
        { ...pendingApproval, requestId: "a", status: "open" },
        { ...pendingApproval, requestId: "b", status: "responding" },
        { ...pendingApproval, requestId: "c", status: "resolved" },
        { ...pendingApproval, requestId: "d", status: "expired" },
      ]),
    ).toBe(2);
    expect(countPending([])).toBe(0);
  });

  it("R4-12: 通知层**真的接进了**路由，且读的是同一份状态（不许是悬空模块）", () => {
    const src = readFileSync("src/core/phone-link/phone-link.ts", "utf8");
    // 路由存在
    expect(src).toContain('case "notices"');
    expect(src).toContain('rest === "/notices"');
    expect(src).toContain("noticeFromApproval(");
    /**
     * 关键：通知必须读 `listApprovals`（阶段 0 那份状态），
     * **不许**另建一份。两份真相 = 桌面收起了卡片、手机还显示能点。
     */
    const caseIdx = src.indexOf('case "notices"');
    const block = src.slice(caseIdx, caseIdx + 900);
    expect(block, "通知必须读阶段 0 那份审批状态").toContain("listApprovals(");
    expect(block, "不许自建一份待批表").not.toContain("new Map(");
    // 回答路由要接受它的动作词汇，并且**不猜**（不认识 → 400）
    expect(src).toContain("remoteActionToInternal(");
    expect(src).toMatch(/action 必须是 allow\/deny（本地）或 allow-once\/reject（远端）/);
  });
});
