/**
 * 回归测试：流式 text_delta 拼接不应重复首段文本
 *
 * Bug 现象：LLM 回复过程中出现句子首词重复，如
 *   「已已获取足够机构信息」「现在现在追加第三部分」「第三第三部分已追加」
 *
 * 根因：App.tsx text_delta 分支用累积的 assistantContent 初始化消息 content，
 * 而 streamBuffer 的 buf.text 也从第一个 delta 开始累积；100ms 后 flush 把
 * buf.text 整个 append 到已含同样文本的消息上 → 开头段落被写入两次。
 *
 * 修复：safeAddMessage 初始化 content 改为空字符串，文本统一由 buffer flush
 * 追加（与 reasoning/knowledge_sources 分支一致，对标 DSH block_updated
 * 全量替换的单一写入通道思想）。
 */
import { describe, it, expect } from "vitest";
import { useAppStore } from "../store";

let seq = 0;

/** 模拟修复后的 App.tsx text_delta 分支：消息初始化 content 为空，文本由 buffer append */
function simulateFixedStreaming(deltas: string[]): string {
  const msgId = `assistant-fixed-${++seq}`;
  let buffer = "";
  for (const delta of deltas) {
    const exists = useAppStore.getState().messages.find((m) => m.id === msgId);
    if (!exists) {
      useAppStore.getState().addMessage({
        id: msgId,
        role: "assistant",
        content: "", // 修复后：空 content，避免与 buffer 重复
        timestamp: Date.now(),
        status: "streaming",
      });
    }
    buffer += delta;
    // 模拟一次 flush：把累积 buffer 追加到消息
    useAppStore.getState().appendToMessage(msgId, buffer);
    buffer = "";
  }
  return useAppStore.getState().messages.find((m) => m.id === msgId)?.content || "";
}

/** 模拟旧逻辑（bug）：消息初始化用累积文本，buffer 也从第一个 delta 累积 */
function simulateBuggyStreaming(deltas: string[]): string {
  const msgId = `assistant-buggy-${++seq}`;
  let accumulated = "";
  let buffer = "";
  for (const delta of deltas) {
    accumulated += delta;
    const exists = useAppStore.getState().messages.find((m) => m.id === msgId);
    if (!exists) {
      useAppStore.getState().addMessage({
        id: msgId,
        role: "assistant",
        content: accumulated, // 旧逻辑：累积文本初始化
        timestamp: Date.now(),
        status: "streaming",
      });
      // buffer 也从第一个 delta 累积（与修复前一致）
      buffer += delta;
    } else {
      buffer += delta;
    }
  }
  // 100ms 后 flush：append 整个 buffer（含第一个 delta → 首段重复）
  useAppStore.getState().appendToMessage(msgId, buffer);
  return useAppStore.getState().messages.find((m) => m.id === msgId)?.content || "";
}

describe("流式 text_delta 拼接不应重复首段", () => {
  it("REPRO-STREAM-001: 多 delta 在 flush 周期内到达 → 首段不重复", () => {
    const result = simulateFixedStreaming(["已", "获取足够机构信息"]);
    expect(result).toBe("已获取足够机构信息");
  });

  it("REPRO-STREAM-002: 三句连续输出 → 每句首词不重复", () => {
    const result = simulateFixedStreaming([
      "已获取足够机构信息\n",
      "现在追加第三部分\n",
      "第三部分已追加",
    ]);
    expect(result).toBe("已获取足够机构信息\n现在追加第三部分\n第三部分已追加");
  });

  it("REPRO-STREAM-003: 单字首 delta + 长 delta → 首词不重复", () => {
    const result = simulateFixedStreaming(["已", "获取足够机构信息\n现在追加第三部分"]);
    expect(result).toBe("已获取足够机构信息\n现在追加第三部分");
  });

  it("REPRO-STREAM-004: 旧逻辑（累积文本初始化 + buffer 重复累积）必然产生首段重复", () => {
    const result = simulateBuggyStreaming(["已", "获取足够机构信息"]);
    // 旧逻辑：初始化 content="已"，flush append buffer="已获取足够机构信息" → 首字重复
    expect(result).toBe("已已获取足够机构信息");
  });
});
