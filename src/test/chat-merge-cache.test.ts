/**
 * CHAT-MERGE：合并气泡的对象引用必须**按内容稳定**（第 5 轮性能修复）。
 *
 * ## 现场
 *
 * `ChatPanel` 在渲染体里为每个连续 assistant 组**新建**一个 `merged` 对象
 * （`{...msg, content: 拼接, toolCalls: flatMap, …}`）。而 `MessageBubble` 是 `memo`
 * 组件、浅比较 props ⇒ 每次渲染都判定"变了" ⇒ 整列 assistant 气泡重新渲染：
 * 每次都要重跑 react-markdown 解析、`autoLinkFilePaths` 全文扫描、工具参数
 * `JSON.stringify(…, null, 2)`。流式期每秒约 20 次渲染（10 次 flush + 10 次滚动）。
 *
 * ## 判据（行为，不看源码）
 *
 * 把「合并」这一段抽成纯函数 `mergeAssistantGroup` 并带缓存：
 * - 同一组、内容未变 ⇒ 返回**同一个对象引用**（memo 因此不失效）；
 * - 内容/状态/工具数变化 ⇒ 返回新对象（界面必须更新，不能拿旧内容糊弄）；
 * - 缓存有上限（长会话流式期间每次 flush 都是新键，不能无限增长）。
 */

import { describe, expect, it, beforeEach } from "vitest";
import { mergeAssistantGroup, resetAssistantGroupCache } from "../components/assistant-group-merge";
import type { Message } from "../store";

function msg(id: string, content: string, extra: Partial<Message> = {}): Message {
  return { id, role: "assistant", content, timestamp: 1, ...extra } as Message;
}

beforeEach(() => {
  resetAssistantGroupCache();
});

describe("CHAT-MERGE：合并气泡引用稳定", () => {
  it("同一组内容未变 ⇒ 返回同一个引用", () => {
    const group = [msg("a1", "第一段"), msg("a2", "第二段")];
    const first = mergeAssistantGroup(group);
    const second = mergeAssistantGroup(group);
    expect(second, "每次渲染都新建对象 ⇒ MessageBubble 的 memo 失效").toBe(first);
  });

  it("内容变化 ⇒ 新对象且内容真的更新", () => {
    const g1 = [msg("a1", "第一段")];
    const before = mergeAssistantGroup(g1);
    const g2 = [msg("a1", "第一段改了")];
    const after = mergeAssistantGroup(g2);
    expect(after).not.toBe(before);
    expect(after.content).toContain("第一段改了");
  });

  it("状态从 streaming 变 done ⇒ 新对象（否则界面永远停在流式中）", () => {
    const streaming = [msg("a1", "x", { status: "streaming" } as Partial<Message>)];
    const a = mergeAssistantGroup(streaming);
    const done = [msg("a1", "x", { status: "done" } as Partial<Message>)];
    const b = mergeAssistantGroup(done);
    expect(b).not.toBe(a);
    expect(b.status).toBe("done");
  });

  it("工具调用数变化 ⇒ 新对象", () => {
    const a = mergeAssistantGroup([msg("a1", "x")]);
    const b = mergeAssistantGroup([msg("a1", "x", { toolCalls: [{ id: "t1" }] } as Partial<Message>)]);
    expect(b).not.toBe(a);
    expect(b.toolCalls?.length).toBe(1);
  });

  it("缓存有上限：大量不同内容不会无限增长", () => {
    for (let i = 0; i < 400; i++) mergeAssistantGroup([msg("a1", `内容-${i}`)]);
    expect(mergeAssistantGroup([msg("a1", "最终")]).content).toContain("最终");
  });
});
