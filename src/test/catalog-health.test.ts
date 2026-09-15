/**
 * 内置目录条目的**实证健康状态**（第 81 波）
 *
 * 起因（用户提问）：「内置的话如果供应商改名了怎么办？」
 *
 * 这一层要守住的底线：
 *   ① 只有"服务器明确不认识这个模型名"才记账 —— 网络抖动、401、429、上下文超限都不许记，
 *      否则会把一个能用的模型冤枉成失效；
 *   ② 一旦某次调用成功，标记必须自动撤销（证据翻转，结论翻转）；
 *   ③ 坏数据、过期数据不能让界面崩，也不能永远有效；
 *   ④ 常态（本来就 ok）不许反复写盘。
 *
 * 真实样本（DeepSeek，2026-09-13 实测）：
 *   HTTP 400 {"error":{"message":"The supported API model names are deepseek-flash,
 *   deepseek-v4-pro, but you passed DeepSeek-V4-Flash-Vision-Exp"}}
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
}));

vi.mock("../core/storage/settings", () => ({
  getSettingJSON: mocks.getSettingJSON,
  setSettingJSON: mocks.setSettingJSON,
  getSetting: vi.fn(() => null),
  setSetting: vi.fn(),
}));

import {
  getCatalogHealth,
  isCatalogModelRejected,
  getCatalogHealthFor,
  recordCatalogRejection,
  recordCatalogSuccess,
  describeCatalogHealth,
  orderModelsByHealth,
  extractServerMessage,
  catalogModelLabelSuffix,
  clearCatalogHealth,
  __resetCatalogHealthCache,
} from "../core/llm/catalog-health";
import { isUnknownModelError } from "../core/llm/provider-errors";

const DS_REJECTION =
  'API error 400: {"error":{"message":"The supported API model names are deepseek-flash, deepseek-v4-pro, but you passed DeepSeek-V4-Flash-Vision-Exp","type":"invalid_request_error"}}';

beforeEach(() => {
  mocks.store = {};
  mocks.setSettingJSON.mockClear();
  mocks.getSettingJSON.mockClear();
  __resetCatalogHealthCache();
  clearCatalogHealth();
  mocks.setSettingJSON.mockClear();
});

describe("未知模型名错误识别（不能冤枉能用的模型）", () => {
  it("CH-1: 认得各家的『模型名不对』措辞", () => {
    expect(isUnknownModelError(DS_REJECTION, 400)).toBe(true);
    expect(isUnknownModelError("model_not_found", 404)).toBe(true);
    expect(isUnknownModelError("The model 'gpt-5' does not exist", 404)).toBe(true);
    expect(isUnknownModelError('model "llama9" not found, try pulling it first', 404)).toBe(true);
    expect(isUnknownModelError("invalid model id", 400)).toBe(true);
    expect(isUnknownModelError("Invalid model name: foo", 400)).toBe(true);
    expect(isUnknownModelError("invalid model:", 400)).toBe(true);
  });

  it("CH-1b: 参数类措辞『Invalid model input』不算名字问题（那会把能用的模型标成失效）", () => {
    expect(isUnknownModelError("Invalid model input format: image too large", 400)).toBe(false);
    expect(isUnknownModelError("invalid model parameter temperature", 400)).toBe(false);
  });

  it("CH-2: 网络/鉴权/限流/上下文超限一律不算（否则会误标）", () => {
    expect(isUnknownModelError("fetch failed: ECONNRESET", undefined)).toBe(false);
    expect(isUnknownModelError("401 Unauthorized: invalid api key", 401)).toBe(false);
    expect(isUnknownModelError("429 rate limit exceeded", 429)).toBe(false);
    expect(isUnknownModelError("500 internal server error", 500)).toBe(false);
    // 上下文超限的措辞里带 model —— 必须是 false（能用的模型不能被标失效）
    expect(
      isUnknownModelError(
        '{"error":{"message":"This model\'s maximum context length is 1048576 tokens. However, you requested 1048735 tokens"}}',
        400,
      ),
    ).toBe(false);
    expect(isUnknownModelError("", 400)).toBe(false);
    expect(isUnknownModelError(undefined, 400)).toBe(false);
  });

  it("CH-3: 从 API 错误里抽出服务器那句人话（去掉前缀与 JSON 外壳）", () => {
    expect(extractServerMessage(DS_REJECTION)).toContain("The supported API model names are");
    expect(extractServerMessage(DS_REJECTION)).not.toContain("API error 400");
    expect(extractServerMessage("API error 500: boom")).toBe("boom");
    expect(extractServerMessage('{"message":"plain"}')).toBe("plain");
    expect(extractServerMessage(undefined)).toBe("");
  });
});

describe("失效标记的记账规则", () => {
  it("CH-4: 服务器拒绝 → 记账并保留服务器原话；能读出时间", () => {
    const recorded = recordCatalogRejection("deepseek", "deepseek-v4-flash-vision-exp", DS_REJECTION, 400);
    expect(recorded).toBe(true);
    const entry = getCatalogHealth("deepseek", "deepseek-v4-flash-vision-exp");
    expect(entry?.status).toBe("rejected");
    expect(entry?.detail).toContain("supported API model names");
    expect(isCatalogModelRejected("deepseek", "deepseek-v4-flash-vision-exp")).toBe(true);
    // 给用户看的说明里必须有"时间 + 服务器原话"
    const text = describeCatalogHealth(entry);
    expect(text).toContain("被服务器拒绝");
    expect(text).toContain("supported API model names");
    expect(text).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
  });

  it("CH-5: 大小写不敏感（同一模型的不同写法是同一条记录）", () => {
    recordCatalogRejection("deepseek", "DeepSeek-V4-Flash-Vision-Exp", DS_REJECTION, 400);
    expect(isCatalogModelRejected("deepseek", "deepseek-v4-flash-vision-exp")).toBe(true);
  });

  it("CH-6: 非模型名类错误不记账（网络失败不能标失效）", () => {
    expect(recordCatalogRejection("deepseek", "deepseek-flash", "fetch failed", undefined)).toBe(false);
    expect(recordCatalogRejection("deepseek", "deepseek-flash", "429 rate limit", 429)).toBe(false);
    expect(getCatalogHealth("deepseek", "deepseek-flash")).toBeUndefined();
    expect(mocks.setSettingJSON).not.toHaveBeenCalled();
  });

  it("CH-7: 调用成功 → 标记自动撤销（证据翻转）", () => {
    recordCatalogRejection("deepseek", "deepseek-v4-flash-vision-exp", DS_REJECTION, 400);
    expect(isCatalogModelRejected("deepseek", "deepseek-v4-flash-vision-exp")).toBe(true);

    recordCatalogSuccess("deepseek", "deepseek-v4-flash-vision-exp");
    const entry = getCatalogHealth("deepseek", "deepseek-v4-flash-vision-exp");
    expect(entry?.status).toBe("ok");
    expect(entry?.detail).toBeUndefined();
    expect(isCatalogModelRejected("deepseek", "deepseek-v4-flash-vision-exp")).toBe(false);
    expect(describeCatalogHealth(entry)).toContain("成功");
  });

  it("CH-8: 常态不写盘（每次成功请求都写 localStorage 是纯浪费）", () => {
    recordCatalogSuccess("deepseek", "deepseek-flash"); // 首次：留一条可用实证
    const writes = mocks.setSettingJSON.mock.calls.length;
    for (let i = 0; i < 20; i++) recordCatalogSuccess("deepseek", "deepseek-flash");
    expect(mocks.setSettingJSON.mock.calls.length).toBe(writes);
  });

  it("CH-9: 坏数据 / 过期数据被丢掉，不崩也不永久有效", () => {
    const now = Date.now();
    mocks.store["codem-catalog-health"] = {
      deepseek: {
        good: { status: "rejected", at: now - 1000, detail: "x" },
        ancient: { status: "rejected", at: now - 40 * 24 * 3600 * 1000, detail: "y" }, // 40 天前 → 过期
        bogus: { status: "weird", at: now },
        notime: { status: "ok" },
        notobj: "nope",
      },
      broken: "not-an-object",
    };
    __resetCatalogHealthCache();

    expect(isCatalogModelRejected("deepseek", "good")).toBe(true);
    expect(isCatalogModelRejected("deepseek", "ancient")).toBe(false);
    expect(isCatalogModelRejected("deepseek", "bogus")).toBe(false);
    expect(isCatalogModelRejected("deepseek", "notime")).toBe(false);
    expect(getCatalogHealthFor("broken")).toEqual({});
    // 完全没记录过的 provider 也要安全
    expect(getCatalogHealthFor("openai")).toEqual({});
    expect(getCatalogHealth("", "")).toBeUndefined();
  });

  it("CH-10: 读取储层抛异常时静默降级（不把界面带崩）", () => {
    mocks.getSettingJSON.mockImplementationOnce(() => {
      throw new Error("localStorage disabled");
    });
    __resetCatalogHealthCache();
    expect(getCatalogHealthFor("deepseek")).toEqual({});
    expect(recordCatalogRejection("deepseek", "x", DS_REJECTION, 400)).toBe(true);
  });

  it("CH-11: 单个 provider 的记录数有上限（不会无限增长，且丢掉的是最旧的）", () => {
    for (let i = 0; i < 120; i++) {
      recordCatalogRejection("deepseek", `model-${i}`, DS_REJECTION, 400);
    }
    const bucket = getCatalogHealthFor("deepseek");
    expect(Object.keys(bucket).length).toBeLessThanOrEqual(80);
    // 保留的是最近的 —— 注意这些写入**在同一毫秒内**（时间戳打平），
    // 所以这条断言同时守住"打平时必须按写入顺序保留最新的"（全量跑用例时踩过）。
    expect(bucket["model-119"]).toBeDefined();
    expect(bucket["model-0"]).toBeUndefined();
  });
});

describe("下拉列表的顺序与标注（用户看到的结论）", () => {
  it("CH-12: 被拒绝的条目沉到末尾，其余保持服务器顺序", () => {
    const models = [
      { id: "deepseek-v4-flash-vision-exp" },
      { id: "deepseek-flash" },
      { id: "deepseek-v4-pro" },
    ];
    expect(orderModelsByHealth("deepseek", models).map((m) => m.id)).toEqual([
      "deepseek-v4-flash-vision-exp",
      "deepseek-flash",
      "deepseek-v4-pro",
    ]);

    recordCatalogRejection("deepseek", "deepseek-v4-flash-vision-exp", DS_REJECTION, 400);
    expect(orderModelsByHealth("deepseek", models).map((m) => m.id)).toEqual([
      "deepseek-flash",
      "deepseek-v4-pro",
      "deepseek-v4-flash-vision-exp",
    ]);
    // 原数组不能被就地改动（React state 不许被外部排序改掉）
    expect(models.map((m) => m.id)[0]).toBe("deepseek-v4-flash-vision-exp");
  });

  it("CH-13: 其它 provider 的标记不影响本 provider", () => {
    recordCatalogRejection("deepseek", "deepseek-flash", DS_REJECTION, 400);
    expect(isCatalogModelRejected("openai", "deepseek-flash")).toBe(false);
    expect(orderModelsByHealth("openai", [{ id: "deepseek-flash" }]).length).toBe(1);
  });

  it("CH-14: 来源后缀措辞 —— 服务器**自己列出**的模型被拒时不许说『内置目录』", () => {
    expect(catalogModelLabelSuffix({ catalogOnly: true, rejected: true })).toBe(
      "（内置目录，服务器已拒绝此名字）",
    );
    expect(catalogModelLabelSuffix({ catalogOnly: false, rejected: true })).toBe("（服务器已拒绝此名字）");
    expect(catalogModelLabelSuffix({ catalogOnly: true, rejected: false })).toBe("（内置目录，服务器未列出）");
    expect(catalogModelLabelSuffix({ catalogOnly: false, rejected: false })).toBe("");
    expect(catalogModelLabelSuffix({})).toBe("");
  });
});
