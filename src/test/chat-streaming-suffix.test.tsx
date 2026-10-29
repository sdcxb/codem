/**
 * 流式期间不许每 flush 付 O(n²)（第 233 轮审计 · P1 卡顿）。
 *
 * ## 缺陷形态（两处，都实测过）
 *
 * 1. **O(n²) 的后缀扫描**：`ChatPanel` 对每条 assistant 行都做
 *    `displayMessages.slice(i + 1).some(m => m.role === "assistant")`。
 *    单行 O(n)、整列 O(n²)，而且跑在**渲染体**里 ⇒ 每次流式 flush（100ms 一次）
 *    都要重算一遍。1000 行会话每 flush 搬 50 万次元素。
 * 2. **memo 被 inline 回调击穿**：`<MessageBubble onDeleteFiles={(files) => handleDeleteFiles(msg.id, files)} />`
 *    —— `MessageBubble` 是 `memo()`，但这个箭头函数**每次渲染都是新引用** ⇒
 *    每一行都必然重渲染，`memo` 形同不存在。流式时"只有最后一行在变"变成了"整列都在重渲染"。
 *
 * ## 判据
 *
 * | # | 行为 |
 * |---|---|
 * | STREAM-1 | 后缀数组与"逐行 `slice().some()`"的参考实现**完全一致**（反向对照） |
 * | STREAM-2 | 2 万行规模下有界（O(n²) 在这里是 4 亿次元素搬运） |
 * | STREAM-3 | `hasAfter` 语义：`hasAfter[i]` 看的是 **i 之后**，不含 i |
 * | STREAM-4 | 每行拿到的是**稳定引用**的 `onDeleteFiles`（同一行两次渲染拿到同一个函数） |
 *
 * 变异自证：把 `computeHasAssistantAfter` 改成逐行 `slice` ⇒ STREAM-2 超时；
 * 把 `onDeleteFiles` 改回 inline 箭头 ⇒ STREAM-4 红。
 */
import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { computeHasAssistantAfter } from "../core/ui/message-suffix";
import { useStableMessageHandlers } from "../components/useStableMessageHandlers";

type M = { role: string; id: string };

const msg = (role: string, id: string): M => ({ role, id });

/** 参考实现：逐行 `slice().some()`（修复前 ChatPanel 的写法） */
function referenceHasAfter(messages: readonly M[]): boolean[] {
  const out: boolean[] = [];
  for (let i = 0; i < messages.length; i++) {
    out.push(messages.slice(i + 1).some((m) => m.role === "assistant"));
  }
  out.push(false);
  return out;
}

describe("流式：后缀扫描", () => {
  it("STREAM-1（反向对照）: 与逐行 slice().some() 完全一致", () => {
    const fixtures: M[][] = [
      [],
      [msg("user", "u1")],
      [msg("assistant", "a1")],
      [msg("user", "u1"), msg("assistant", "a1")],
      [msg("assistant", "a1"), msg("assistant", "a2"), msg("user", "u2"), msg("assistant", "a3")],
      [msg("user", "u1"), msg("tool", "t1"), msg("assistant", "a1")],
    ];
    for (const f of fixtures) {
      expect(computeHasAssistantAfter(f), JSON.stringify(f)).toEqual(referenceHasAfter(f));
    }
  });

  it("STREAM-2: 2 万行规模下有界（O(n²) 在这里是 4 亿次搬运）", () => {
    const many: M[] = Array.from({ length: 20_000 }, (_, i) => msg(i % 2 === 0 ? "user" : "assistant", `m-${i}`));
    const t0 = performance.now();
    const hasAfter = computeHasAssistantAfter(many);
    const ms = performance.now() - t0;
    expect(hasAfter).toHaveLength(20_001);
    expect(ms, `2 万行耗时 ${ms.toFixed(0)}ms（O(n²) 参考实现是秒级）`).toBeLessThan(100);
  });

  it("STREAM-3: hasAfter[i] 只看 i 之后（不含 i）", () => {
    const f = [msg("assistant", "a1")];
    const hasAfter = computeHasAssistantAfter(f);
    expect(hasAfter[0], "第 0 行**之后**没有 assistant（它自己是）").toBe(false);
    const g = [msg("assistant", "a1"), msg("assistant", "a2")];
    const h = computeHasAssistantAfter(g);
    expect(h[0]).toBe(true);
    expect(h[1]).toBe(false);
  });
});

describe("流式：memo 不被 inline 回调击穿", () => {
  it("STREAM-4: 同一行两次渲染拿到**同一个** onDeleteFiles 引用", () => {
    const calls: Array<[string, string[]]> = [];
    const { result, rerender } = renderHook(
      ({ ids }: { ids: string[] }) =>
        useStableMessageHandlers<string[]>((id, files) => {
          calls.push([id, files]);
        }, ids),
      { initialProps: { ids: ["m-1", "m-2"] } },
    );
    const first = result.current("m-1");
    const second = result.current("m-1");
    expect(second, "同一行必须是同一个函数引用（否则 memo 永远失效）").toBe(first);
    expect(result.current("m-2")).not.toBe(first);

    // 变更列表后（新增一行）已经存在的行仍是同一个引用
    rerender({ ids: ["m-1", "m-2", "m-3"] });
    expect(result.current("m-1")).toBe(first);

    // 回调仍然带着正确的 id 工作
    first(["a.txt"]);
    expect(calls).toEqual([["m-1", ["a.txt"]]]);
  });
});
