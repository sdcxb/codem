/**
 * 第 227 波 · 界面那一半（用户直报）：
 *
 * > 弹出上下文窗口，我点了压缩上下文按钮，没出现进度也没出现压缩提示。
 * > 这样很容易让人误操作，以为没压缩重复点。
 *
 * ## 缺陷是什么（先写清楚，否则判据会写成"测实现"）
 *
 * - **进度画不出来**：`manualCompact()` 是同步动作，`setCompacting(true)` 与紧接着的
 *   `false` 被 React 批进同一帧 ⇒「⏳ 压缩中…」这一帧**从来没被 paint 过**；
 * - **回执 3 秒就消失**：`setTimeout(() => setCompactResult(null), 3000)` ——
 *   用户先看数字、再找提示，找的时候它已经没了 ⇒ 他会**再点一次**；
 * - **再点真的会再压一次**：守卫 `compactingRef` 在动作结束的同一刻就放开了，
 *   第二次删的是刚保留下来的那批旧消息（多丢一批上下文）。
 *
 * 判据守在**用户能看见的东西**上：进度态真的出现过、回执不会再自己消失、
 * 压缩完成后按钮进冷却期并写明"刚刚压缩了什么"、冷却期内的点击不再触发第二次压缩。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent, act, screen } from "@testing-library/react";
import { createElement } from "react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ContextMonitor } from "../components/ContextMonitor";

const listVisibleMessagesMock = vi.fn();
const deleteMessagesByIdsMock = vi.fn();
const createMessageMock = vi.fn();

vi.mock("../core/storage/message", () => ({
  listMessages: (...args: unknown[]) => listVisibleMessagesMock(...args),
  listVisibleMessages: (...args: unknown[]) => listVisibleMessagesMock(...args),
  deleteMessagesByIds: (...args: unknown[]) => deleteMessagesByIdsMock(...args),
  /** ★ 全量审计：手动压缩回执会读它（mock 必须覆盖被消费的公开面） */
  getLastDeleteReport: vi.fn(() => ({ requested: 0, unresolved: 0, sessions: [], softDeleteResponded: true })),
  createMessage: (...args: unknown[]) => createMessageMock(...args),
}));

function makeMessages(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `m${i}`,
    role: i % 2 === 0 ? "user" : "assistant",
    content: `content ${i}`,
    timestamp: i,
  }));
}

const compactButton = () => screen.getByText(/压缩上下文|压缩中|已压缩/) as HTMLButtonElement;
const receipt = () => screen.queryByTestId("compact-result");

/** 让出那一帧（组件刻意让出一帧，否则进度态永远不会被画出来） */
async function letFramePass() {
  // ⚠️ 这里用的是假定时器（为了能"等 3.5 秒 / 8 秒"而不真等），所以必须用
  // `advanceTimersByTimeAsync` —— 普通 `setTimeout(40)` 在假定时器下永远不会触发（第一版就卡在这）。
  await act(async () => {
    await vi.advanceTimersByTimeAsync(40);
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  listVisibleMessagesMock.mockReset().mockReturnValue(makeMessages(30));
  deleteMessagesByIdsMock.mockReset();
  createMessageMock.mockReset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("CB：手动压缩的**可见反馈**与防重复点（第 227 波）", () => {
  it("CB-1：点一下 ⇒ 进度出现、压缩真的发生、**回执出现**且写明移除了多少", async () => {
    render(createElement(ContextMonitor, { sessionId: "s1", visible: true }));
    await letFramePass();

    expect(receipt(), "还没压缩 ⇒ 不该有回执").toBeNull();
    fireEvent.click(compactButton());

    /* 进度态必须真的出现过（原实现被批进同一帧 ⇒ 用户永远看不到） */
    expect(screen.getByText(/压缩中/), "点了要立刻显示「压缩中」").toBeTruthy();
    expect(compactButton().disabled, "压缩期间按钮必须禁用").toBe(true);

    await letFramePass();

    expect(deleteMessagesByIdsMock, "压缩要真的发生").toHaveBeenCalledTimes(1);
    const text = receipt()?.textContent ?? "";
    expect(text, "回执必须出现（这就是用户说的『没出现压缩提示』）").toContain("压缩完成");
    expect(text, "要说清移除了多少").toMatch(/移除 10 条/);
    expect(text, "也要说清保留了多少").toMatch(/保留最近 20 条/);
    expect(text, "还要告诉用户对话里多了什么（否则他不知道下一步看哪儿）").toContain("[上下文已手动压缩]");
  });

  it("CB-2：回执**不许再自己消失**（原来 3 秒后就没了 ⇒ 用户以为没压缩）", async () => {
    render(createElement(ContextMonitor, { sessionId: "s1", visible: true }));
    await letFramePass();
    fireEvent.click(compactButton());
    await letFramePass();
    expect(receipt()).toBeTruthy();

    // 原来的写法会在 3 秒后清掉它
    await act(async () => {
      vi.advanceTimersByTime(3500);
    });
    expect(receipt(), "3.5 秒后回执必须还在（它是「这次点了有没有发生」的唯一证据）").toBeTruthy();
  });

  it("CB-3：压缩完成后进**冷却期**：按钮禁用 + 写明刚刚压缩过；冷却结束恢复可点", async () => {
    render(createElement(ContextMonitor, { sessionId: "s1", visible: true }));
    await letFramePass();
    fireEvent.click(compactButton());
    await letFramePass();

    expect(compactButton().disabled, "刚压缩完不该立刻又能点（那正是「重复点再压一次」的入口）").toBe(true);
    expect(compactButton().textContent, "按钮上要能看出刚刚压缩过").toContain("已压缩");
    expect(compactButton().title, "并说明为什么暂时点不了").toContain("刚刚压缩过");

    await act(async () => {
      vi.advanceTimersByTime(9000);
    });
    expect(compactButton().disabled, "冷却结束 ⇒ 恢复可点").toBe(false);
    expect(compactButton().textContent).toContain("压缩上下文");
  });

  it("CB-4（反向对照）：冷却期内再点**不会**触发第二次压缩（重复点真的会多删一批）", async () => {
    render(createElement(ContextMonitor, { sessionId: "s1", visible: true }));
    await letFramePass();
    fireEvent.click(compactButton());
    await letFramePass();
    expect(deleteMessagesByIdsMock).toHaveBeenCalledTimes(1);

    fireEvent.click(compactButton()); // 用户以为"没压上"，又点了一次
    await act(async () => {
      vi.advanceTimersByTime(100);
    });
    expect(deleteMessagesByIdsMock, "冷却期内的点击必须被挡住").toHaveBeenCalledTimes(1);
  });

  it("CB-9（全量审计）：回执要用真实删除结果 —— 索引没回应或有条目查不到归属时必须说明", async () => {
    /*
     * 被守的缺陷：`deleteMessagesByIds` 恒返回「计划删多少」，而索引侧可能没回应（端口缺能力）
     * 或有若干 id 查不到归属 ⇒ 回执那句「移除 N 条」会高于真实值，且没有任何提示。
     */
    const messageModule = await import("../core/storage/message");
    (messageModule.getLastDeleteReport as unknown as { mockReturnValue: (v: unknown) => void }).mockReturnValue({
      requested: 30,
      unresolved: 3,
      sessions: ["s1"],
      softDeleteResponded: true,
    });
    render(createElement(ContextMonitor, { sessionId: "s1", visible: true }));
    await letFramePass();
    fireEvent.click(compactButton());
    await letFramePass();
    const text = receipt()?.textContent ?? "";
    expect(text, "要写明有几条查不到归属（实际没被隐藏）").toContain("3 条查不到归属");
  });

  it("CB-10（全量审计）：手动压缩完成后必须广播「压缩已应用」事件（外壳要重载聊天区）", async () => {
    /*
     * 被守的缺陷：自动路径在 `compaction_end` 后会 `loadMessages`，手动路径原来只刷新自己面板的数字 ⇒
     * 用户看到「移除 N 条」而对话列表里一条没少（界面自相矛盾）。
     */
    const seen: Array<{ sessionId?: string }> = [];
    const onApplied = (e: Event) => seen.push((e as CustomEvent<{ sessionId?: string }>).detail ?? {});
    window.addEventListener("codem:compaction-applied", onApplied);
    try {
      render(createElement(ContextMonitor, { sessionId: "s1", visible: true }));
      await letFramePass();
      fireEvent.click(compactButton());
      await letFramePass();
      expect(seen.length, "压缩成功必须广播事件").toBeGreaterThan(0);
      expect(seen.at(-1)?.sessionId, "事件要带会话归属（外壳据此判断是否正在看这个会话）").toBe("s1");
    } finally {
      window.removeEventListener("codem:compaction-applied", onApplied);
    }
  });

  it("CB-5：没有可移除的消息时也要说清**为什么**（不许只是默默无事发生）", async () => {
    listVisibleMessagesMock.mockReturnValue(makeMessages(12)); // ≤20 条 ⇒ 无可移除
    render(createElement(ContextMonitor, { sessionId: "s1", visible: true }));
    await letFramePass();

    fireEvent.click(compactButton());
    await letFramePass();

    expect(deleteMessagesByIdsMock, "没得压就不该动库").not.toHaveBeenCalled();
    const text = receipt()?.textContent ?? "";
    expect(text, "要如实说这次没移除任何东西").toContain("没有可移除的消息");
    expect(text, "并给出原因（保留最近 20 条）").toContain("20 条");
    expect(text, "还要解释为什么占用没降（否则用户以为按钮坏了）").toContain("系统提示与工具定义");
    expect(compactButton().disabled, "没发生过压缩 ⇒ 不该进冷却期").toBe(false);
  });

  it("CB-6：换会话 ⇒ 回执清掉（上一条会话的读数不许挂到新会话上）", async () => {
    const { rerender } = render(createElement(ContextMonitor, { sessionId: "s1", visible: true }));
    await letFramePass();
    fireEvent.click(compactButton());
    await letFramePass();
    expect(receipt()).toBeTruthy();

    rerender(createElement(ContextMonitor, { sessionId: "s2", visible: true }));
    await letFramePass();
    expect(receipt(), "换会话后回执必须消失（否则是假信息）").toBeNull();
    expect(compactButton().disabled, "冷却期也要跟着会话一起清掉").toBe(false);
  });

  it("CB-7（结构棘轮）：人读反馈的三条接线都得在源码里", () => {
    const src = readFileSync(path.resolve(__dirname, "../components/ContextMonitor.tsx"), "utf8");
    /* 只看**代码行**：注释里正解释着"原来那句 setTimeout(...) 是错的" —— 拿全文匹配会把它算进去 */
    const code = src
      .split("\n")
      .filter((line) => {
        const t = line.trimStart();
        return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
      })
      .join("\n");
    expect(src, "压缩前必须让出一帧（否则「压缩中」永远画不出来）").toMatch(
      /await new Promise\(\(resolve\) => setTimeout\(resolve, 16\)\)/,
    );
    expect(code, "不许再有「3 秒后把回执清掉」那种代码").not.toContain("setTimeout(() => setCompactResult(null)");
    expect(code, "要有冷却期常量").toMatch(/const COMPACT_COOLDOWN_MS = \d+/);
    expect(code, "冷却期内按钮必须禁用").toMatch(/disabled=\{compacting \|\| compactCooldown\}/);
    expect(src, "回执要有可断言的测试钩子").toContain('data-testid="compact-result"');
  });
});

describe("FC-D5k（第 228 波审计）：锁被占而跳过的回执", () => {
  it("必须说清是「没有压缩：另一次压缩正在进行」，不许说成「本次没有可移除的消息」", async () => {
    /*
     * 被守的缺陷：manualCompact 返回值里的 skipped 被 state 类型丢掉 ⇒ 面板走 removed>0 的 else 分支，
     * 显示「本次没有可移除的消息（可压缩的部分不足）」—— 而其实有几十条可压，只是锁被占。
     * ⚠️ 这个文件用**假定时器**（为了等 3.5s/8s 而不真等）⇒ 让帧必须用 advanceTimersByTimeAsync。
     */
    const lock = await import("../core/llm/compaction-control");
    const spy = vi.spyOn(lock, "acquireCompactionLock").mockReturnValue(false);
    render(createElement(ContextMonitor, { sessionId: "s-skip", visible: true }));
    await letFramePass();
    fireEvent.click(compactButton());
    await letFramePass();
    const text = receipt()?.textContent ?? "";
    expect(text, "必须说清是**跳过**").toContain("另一次压缩正在进行");
    expect(text, "不许把它说成「没有可移除的消息」").not.toContain("本次没有可移除的消息");
    spy.mockRestore();
  });
});
