/**
 * 第 15 轮：取消后立刻重发的竞态判据。
 *
 * 背景（只读调查 + 源码证据）：
 * - `handleCancel` 只调 `setStreaming(false)`，而 store 里 `isStreaming = activeSessions.size > 0`
 *   ⇒ 取消瞬间 `activeSessions` 还在，`isStreaming` 仍是 true；
 * - `ChatPanel` 的发送分流按 `activeSessions` 判断 ⇒ 立刻再发会被当成 mid-turn guidance；
 * - 已取消的回合不会消费 guidance ⇒ 气泡被 `clearGuidanceMessages()` 清掉、文本只留在内存队列，
 *   用户看到的是「消息发出去就没了」。
 *
 * 这组判据守三件事：① 取消必须同步清会话忙碌态；② 取消要收口挂起的审批；
 * ③ 没有在跑的回合时，guidance 入口必须兜底成普通发送。另有跨回合延迟定时器的守卫。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, beforeEach } from "vitest";
import { useAppStore } from "../store";

const ROOT = process.cwd();
const APP = readFileSync(join(ROOT, "src/App.tsx"), "utf8");

describe("CANCEL-15：取消后立刻重发不许被 guidance 吞掉", () => {
  it("handleCancel 必须同步清会话忙碌态（只 setStreaming 是空操作）", () => {
    const start = APP.indexOf("const handleCancel = () => {");
    expect(start, "找不到 handleCancel").toBeGreaterThan(0);
    const end = APP.indexOf("const handleGlobalPause", start);
    const body = APP.slice(start, end);
    expect(body, "取消必须 setSessionActive(id, false)，否则 isStreaming 仍为 true").toMatch(
      /setSessionActive\(\s*currentSession\.id\s*,\s*false\s*\)/,
    );
    expect(body, "取消必须把挂起的审批 resolve 掉（否则回合永远等）").toContain("action: \"deny\", reason: \"cancelled\"");
    expect(body, "取消必须收口覆盖写确认").toContain("action: \"reject\"");
  });

  it("guidance 入口在没有在跑回合时必须兜底为普通发送", () => {
    const start = APP.indexOf("const handleSendGuidance = useCallback(");
    expect(start).toBeGreaterThan(0);
    const end = APP.indexOf("}, [addGuidanceMessage]);", start);
    const body = APP.slice(start, end);
    expect(body, "没有执行中的回合时直接走普通发送").toMatch(/!isSessionExecuting\(session\.id\)[\s\S]{0,160}handleSendRef\.current\?\./);
    expect(body, "sendGuidance 返回 null 时也要兜底").toMatch(/if \(!item\) \{[\s\S]{0,120}handleSendRef\.current\?\./);
  });

  it("跨回合的延迟定时器必须带回合序号守卫（2s 进度 / 2.5s 宠物卡）", () => {
    expect(APP).toContain("const turnToken = ++turnTokenRef.current;");
    expect(APP).toMatch(/turnTokenRef\.current !== turnToken[\s\S]{0,160}setStepProgress\(null\)/);
    expect((APP.match(/turnTokenRef\.current !== turnToken/g) ?? []).length, "2s 进度与 2.5s 宠物卡都要守卫").toBeGreaterThanOrEqual(2);
    /* 两个定时器（2s 进度 / 2.5s 宠物卡）各有一处守卫 */
  });

  it("取消后发送要等旧回合释放会话锁（毫秒级），不能直接判忙", () => {
    /* 取消后旧回合 finally 可能还在释放锁：必须等（最多 10s），不能直接判忙 */
    expect(APP).toMatch(/if \(isSessionExecuting\(session\.id\)\) \{[\s\S]{0,160}i < 100 && isSessionExecuting/);
  });
});

describe("CANCEL-15：store 的忙碌态语义（顺序必须是先清会话再 setStreaming）", () => {
  const S = "cancel15-session";

  beforeEach(() => {
    useAppStore.getState().setSessionActive(S, false);
    useAppStore.getState().setStreaming(false);
  });

  it("先 setSessionActive(false) 再 setStreaming(false) ⇒ isStreaming 归零", () => {
    useAppStore.getState().setSessionActive(S, true);
    useAppStore.getState().setStreaming(true);
    expect(useAppStore.getState().isStreaming).toBe(true);

    useAppStore.getState().setSessionActive(S, false);
    useAppStore.getState().setStreaming(false);
    expect(useAppStore.getState().isStreaming).toBe(false);
    expect(useAppStore.getState().activeSessions.has(S)).toBe(false);
  });

  it("只 setStreaming(false) 而 activeSessions 还在 ⇒ 仍然是流式中（旧 bug 的形态）", () => {
    useAppStore.getState().setSessionActive(S, true);
    useAppStore.getState().setStreaming(true);
    useAppStore.getState().setStreaming(false);
    expect(useAppStore.getState().isStreaming, "这正是取消后消息被当 guidance 的原因").toBe(true);
  });
});
