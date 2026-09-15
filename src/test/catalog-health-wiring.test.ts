/**
 * 接线验证：provider 真的会在"服务器拒绝模型名"时记账吗？（第 81 波）
 *
 * 上一个文件（catalog-health.test.ts）测的是记账规则本身；这里测的是**接线**——
 * 用户的问题（"内置的条目要是供应商改名了怎么办"）最终要靠 `LLMProvider.stream/complete`
 * 这两条真实错误路径把证据交上去。规则对但没接上，等于没做。
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  store: {} as Record<string, unknown>,
  setSettingJSON: vi.fn((key: string, value: unknown) => {
    mocks.store[key] = JSON.parse(JSON.stringify(value));
  }),
  getSettingJSON: vi.fn((key: string, fallback: unknown) =>
    key in mocks.store ? mocks.store[key] : fallback,
  ),
  fetch: vi.fn(),
}));

vi.mock("../core/storage/settings", () => ({
  getSettingJSON: mocks.getSettingJSON,
  setSettingJSON: mocks.setSettingJSON,
  getSetting: vi.fn(() => null),
  setSetting: vi.fn(),
}));

import { OpenAICompatibleProvider } from "../core/llm/provider";
import { isCatalogModelRejected, __resetCatalogHealthCache } from "../core/llm/catalog-health";

const REJECT_BODY =
  '{"error":{"message":"The supported API model names are deepseek-flash, deepseek-v4-pro, but you passed deepseek-v4-flash-vision-exp"}}';

function makeProvider(models: Array<{ id: string; name: string }>) {
  return new OpenAICompatibleProvider({
    id: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    apiKey: "sk-test",
    models: models.map((m) => ({ ...m, contextWindow: 1000000, maxOutputTokens: 8192 })),
  } as any);
}

function okStreamResponse(): Response {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(
          'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}\n\n',
        ),
      );
      controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

beforeEach(() => {
  mocks.store = {};
  mocks.fetch.mockReset();
  vi.stubGlobal("fetch", mocks.fetch);
  __resetCatalogHealthCache();
});

describe("provider ↔ 目录健康状态的接线", () => {
  it("CH-15: 流式请求被 400『模型名不支持』拒绝 → 记账（用户能看到的依据）", async () => {
    mocks.fetch.mockResolvedValue(new Response(REJECT_BODY, { status: 400 }));
    const provider = makeProvider([{ id: "deepseek-v4-flash-vision-exp", name: "vision" }]);

    const events: unknown[] = [];
    let thrown: any = null;
    try {
      for await (const ev of provider.stream({ model: "deepseek-v4-flash-vision-exp", messages: [] } as any)) {
        events.push(ev);
      }
    } catch (e) {
      thrown = e;
    }

    expect(thrown?.message).toContain("API error 400");
    expect(isCatalogModelRejected("deepseek", "deepseek-v4-flash-vision-exp")).toBe(true);
  });

  it("CH-16: 上下文超限的 400 不许被记成『模型名失效』", async () => {
    mocks.fetch.mockResolvedValue(
      new Response(
        '{"error":{"message":"This model\'s maximum context length is 1048576 tokens. However, you requested 1048735 tokens"}}',
        { status: 400 },
      ),
    );
    const provider = makeProvider([{ id: "deepseek-flash", name: "flash" }]);

    await expect(
      (async () => {
        for await (const _ of provider.stream({ model: "deepseek-flash", messages: [] } as any)) {
          /* 只关心抛错 */
        }
      })(),
    ).rejects.toThrow(/API error 400/);

    expect(isCatalogModelRejected("deepseek", "deepseek-flash")).toBe(false);
  });

  it("CH-17: 一次成功就撤销旧标记（供应商把名字改回来了）", async () => {
    mocks.fetch.mockResolvedValueOnce(new Response(REJECT_BODY, { status: 400 }));
    const provider = makeProvider([{ id: "deepseek-v4-flash-vision-exp", name: "vision" }]);

    try {
      for await (const _ of provider.stream({ model: "deepseek-v4-flash-vision-exp", messages: [] } as any)) {
        /* 期望抛错 */
      }
    } catch {
      /* 400 → 抛错，标记写入 */
    }
    expect(isCatalogModelRejected("deepseek", "deepseek-v4-flash-vision-exp")).toBe(true);

    mocks.fetch.mockResolvedValueOnce(okStreamResponse());
    for await (const _ of provider.stream({ model: "deepseek-v4-flash-vision-exp", messages: [] } as any)) {
      /* 消费到结束 */
    }
    expect(isCatalogModelRejected("deepseek", "deepseek-v4-flash-vision-exp")).toBe(false);
  });

  it("CH-18: 非流式 complete() 的同一类错误也记账（两条路径都接上）", async () => {
    mocks.fetch.mockResolvedValue(new Response(REJECT_BODY, { status: 400 }));
    const provider = makeProvider([{ id: "deepseek-v4-flash-vision-exp", name: "vision" }]);

    await expect(
      provider.complete({ model: "deepseek-v4-flash-vision-exp", messages: [] } as any),
    ).rejects.toThrow(/API error 400/);
    expect(isCatalogModelRejected("deepseek", "deepseek-v4-flash-vision-exp")).toBe(true);
  });
});
