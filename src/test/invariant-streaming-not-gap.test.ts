/**
 * 第 159 波：**"被中断的回合"不算缺口** ✓（纸面规则与代码不符的那一处 ✗→✓）。
 *
 * ## 真机取证（只读打开真库 ✓）
 *
 * 用户两次报「不变量审计：本次新产生 N 条缺口」✗。定位到具体行之后发现：
 *
 * | 消息 | status | 正文 | 同会话邻居 |
 * |---|---|---|---|
 * | `assistant-1791185162837-30` | **streaming** ✗ | 238 字符 | 全是 `done` ✓ |
 * | `assistant-1791193314043-19` | **streaming** ✗ | 801 字符 | 全是 `done` ✓ |
 * | `assistant-1791193558048-18` | **streaming** ✗ | 419 字符 | 全是 `done` ✓ |
 * | `assistant-1791195256267-15` | **streaming** ✗ | 452 字符 | 全是 `done` ✓ |
 *
 * ⇒ 这些是**回合被中断**留下的流式行 ✓（应用被强杀：装机时的 `Stop-Process` ✓、评测驱动的停止 ✓），
 * **不是**"写入路径漏写事件"✗。
 *
 * 而 `runtime-invariants.ts` 的函数头**规则 2** 早就写着「流式中间态不是定稿」✓，
 * 代码里却**从没判过 `status`** ✗（连类型里都没有这个字段 ✗）—— 于是每被强杀一次就多报一条缺口 ✗。
 *
 * ## 判据（两侧都要钉 ✓）
 *
 * - **IVS-1**：`status='streaming'` 且有正文、没有事件 ⇒ **不算缺口** ✓；
 * - **IVS-2 反向对照**：`status='done'` 且有正文、没有事件 ⇒ **仍然算缺口** ✓
 *   （这条最关键 ✗：修完 IVS-1 之后，绝不能把真缺口一起放过 ✓）。
 *
 * 变异：把 `status` 判断去掉 ⇒ IVS-1 红 ✓。
 */
import { describe, expect, it, vi } from "vitest";

const messages: Array<Record<string, unknown>> = [];
vi.mock("../core/storage/message", () => ({
  listMessages: () => messages,
}));
vi.mock("../core/storage/event-log", () => ({
  getEventLog: () => ({ readAll: () => [] }),
}));

const { runAllInvariants } = await import("../core/llm/runtime-invariants");

describe("第 159 波：被中断的回合（status=streaming）不算缺口", () => {
  it("IVS-1: streaming + 有正文 + 无事件 ⇒ 不算缺口（真机那 4 条就是这个形状 ✓）", () => {
    messages.length = 0;
    messages.push({ id: "assistant-1", role: "assistant", content: "被强杀时留下的正文", status: "streaming", hidden: 0 });
    const res = runAllInvariants("s1");
    expect(
      res.violations.filter((v) => v.type === "VISIBLE_BUT_NOT_RECORDED"),
      "流式中间态不是定稿 ⇒ 不该报缺口（函数头规则 2 早就写了 ✓）",
    ).toEqual([]);
  });

  it("IVS-2 反向对照: done + 有正文 + 无事件 ⇒ **仍然**算缺口（不许把真缺口一起放过 ✗）", () => {
    messages.length = 0;
    messages.push({ id: "assistant-2", role: "assistant", content: "定稿了却没有事件", status: "done", hidden: 0 });
    const res = runAllInvariants("s1");
    expect(
      res.violations.filter((v) => v.type === "VISIBLE_BUT_NOT_RECORDED").length,
      "定稿的消息没有事件 = 真缺口 ⇒ 必须照报 ✓",
    ).toBe(1);
  });
});
