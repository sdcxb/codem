/**
 * 压缩摘要的**输入**必须忠实 —— 它是长会话里模型唯一的记忆。
 *
 * ## 修的两个缺陷（都在 `agentic-loop.ts`）
 *
 * **① 单条消息被砍到 500 / 200 字。** `buildConversationText` 原来对用户/AI 正文
 * `substring(0, 500)`、对工具参数与结果 `substring(0, 200)`。长编码任务里那等于让摘要
 * **只读得到每条消息的开头** —— 摘要一丢状态，之后模型就重复劳动，甚至把改好的东西改回去。
 *
 * **② 整体超 12000 字就 `substring(0, 12000)` —— 保留最旧的、丢掉最新的。**
 * 这在编码任务里是**方向性错误**：最新的上下文（刚跑完的测试输出、刚改的文件、刚犯的错）
 * 恰恰最该进摘要。现在同时保留头与尾，并把省略量写在中间。
 *
 * ## 为什么断言落在"真实产物"上
 *
 * 只测两个辅助函数不够 —— 那样把 `buildConversationText` 里的调用点改回 500 字，
 * 辅助函数的用例照样绿。所以这里**通过真实实例调 `buildConversationText`**，
 * 断言它吐出来的摘要输入里到底有没有完整正文、有没有明说截断。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { AgenticLoop, boundOne, boundConversationForSummary } from "../core/llm/agentic-loop";
import { createDefaultToolRegistry } from "../core/llm/tools";
import { setStoragePort } from "../core/storage/port";
import { createFakeStoragePort } from "./fake-storage-port";

function makeLoop() {
  const provider = {
    id: "test-provider",
    name: "Test",
    async *stream() {
      yield { type: "text_delta", text: "ok" };
      yield { type: "end", finishReason: "stop" };
    },
    async complete() {
      return { content: "summary", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, finishReason: "stop" };
    },
    async listModels() {
      return [];
    },
    async fetchModelsFromServer() {
      return [];
    },
    isConfigured() {
      return true;
    },
  };
  return new AgenticLoop(provider as any, createDefaultToolRegistry(), {
    model: "test-model",
    maxIterations: 1,
  });
}

beforeEach(() => {
  setStoragePort(createFakeStoragePort());
});

describe("压缩摘要输入必须忠实", () => {
  it("① 长用户消息不再被砍到 500 字（完整进摘要输入）", () => {
    const loop = makeLoop() as any;
    const long = "用".repeat(3000);
    const text = loop.buildConversationText([{ role: "user", content: long }]);
    expect(text.includes(long), "3000 字的用户请求必须完整进摘要输入；被砍掉就说明又回到 500 字截断了").toBe(true);
  });

  it("① 长 AI 正文同样不砍；长工具参数与结果按上限截断并**明说**", () => {
    const loop = makeLoop() as any;
    const longText = "答".repeat(3000);
    const longArgs = "a".repeat(9000);
    const longResult = "r".repeat(9000);

    const text = loop.buildConversationText([
      {
        role: "assistant",
        content: longText,
        toolCalls: [{ tool: "bash", args: { command: longArgs }, result: longResult }],
      },
    ]);

    expect(text.includes(longText), "AI 正文必须完整进摘要输入").toBe(true);
    expect(text.includes(longArgs), "工具参数超上限就该被截断（否则摘要请求会无界膨胀）").toBe(false);
    expect(text.includes(longResult), "工具结果超上限就该被截断").toBe(false);
    expect(text.includes("已省略"), "截断必须**明说**省略了多少字符，不许静默").toBe(true);
  });

  it("① 摘要标记（已有摘要）整段带进，不做任何截断", () => {
    const loop = makeLoop() as any;
    const marker = "<!-- CODEM_COMPACTION_SUMMARY -->\n" + "摘".repeat(4000);
    const text = loop.buildConversationText([{ role: "user", content: marker }]);
    expect(text.includes("摘".repeat(4000)), "级联摘要的完整结论不能被砍").toBe(true);
  });

  it("② 整体超上限时**保住最新的上下文**（头尾都留，不是砍掉尾巴）", () => {
    /*
     * ⚠️ 第一版这里用 5 万 + 5 万（总和 10 万、上限 6 万）—— **变异没有咬住**：
     * 只砍头时前 6 万字符里仍然包含 1 万个 T，`includes("T"×200)` 照样成立 ⇒ 判据假绿。
     * 这正是"判据必须会红"要防的东西。现在把头部做得**远大于**上限、尾巴做小，
     * 只砍头就绝对够不到尾巴 ⇒ 方向一改就必红。
     */
    const head = "H".repeat(200000);
    const tail = "T".repeat(5000);
    const bounded = boundConversationForSummary(head + tail);

    expect(bounded.length).toBeLessThan(head.length + tail.length);
    expect(bounded.includes("中间省略了"), "必须写明省略了多少").toBe(true);
    expect(
      bounded.includes("T".repeat(200)),
      "最新的上下文（尾巴）必须在 —— 只保留头部就是「丢掉最新的」，在编码任务里是方向性错误",
    ).toBe(true);
    expect(bounded.includes("H".repeat(200)), "最早的上下文也要留一部分").toBe(true);
  });

  it("② 没超上限时原样返回（不许无谓改写）", () => {
    const text = "short conversation";
    expect(boundConversationForSummary(text)).toBe(text);
  });

  it("boundOne 在未超上限时逐字返回（不许加省略标记）", () => {
    expect(boundOne("abc", 10)).toBe("abc");
    expect(boundOne("a".repeat(10), 10)).toBe("a".repeat(10));
  });
});
void vi;
