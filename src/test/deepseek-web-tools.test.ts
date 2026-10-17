/**
 * DeepSeek Search / Fetch 接入判据（`DSWEB-*`）。
 *
 * ## 这一组守什么
 *
 * 1. **请求构造**：URL（含 baseUrl 的 `/v1` 归一）、方法、`Authorization`、body 字段与默认值
 *    （`count` 默认 10、`need_content` 默认 false）；
 * 2. **响应映射**：官方十个字段逐个落地，`null` 与 `authority=-1` 不许被"修正"成空串/0；
 * 3. **错误映射**：400/401/402/403/404/408/413/429/500/504 逐条中文可读（含状态码与官方
 *    message）；**408/429/5xx 有限重试，其它 4xx（尤其 402）不重试**；**Key 绝不进错误信息**；
 * 4. **开关语义**：关闭 ⇒ 不发 DeepSeek 请求（spy 断言）；开启但没 Key ⇒ 明确报错；
 *    开启后失败 ⇒ **不回退**（静默回退会把 402/401 掩盖成"搜到了"）；
 * 5. **`web_fetch`**：注册、受「工具管理」禁用列表与 Fetch 开关**双重**约束、
 *    请求构造、正文截断**明确标注**、URL 三类非法形态、**200 但正文为空必须判失败**。
 *
 * ## 为什么每条都对着"能变红"写
 *
 * 判据里出现的数字/文案一律**写死**（不 import 被实现的常量）：若写
 * `expect(body.count).toBe(DEEPSEEK_DEFAULT_SEARCH_COUNT)`，把常量从 10 改成 8
 * 判据会跟着一起变绿 —— 那就等于没测。变异登记见
 * `tools/mutate/specs/deepseek-web-tools-233.json`（MUT-1..6）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
/** 模块级共享的 mock 存储 + fetch spy（hoisted：`vi.mock` 工厂先于 import 执行） */
const h = vi.hoisted(() => ({
  store: { raw: new Map<string, string>() },
  fetchSpy: vi.fn(),
}));

vi.mock("../core/storage/settings", async () => {
  const { createSettingsMock } = await import("./settings-mock");
  return createSettingsMock({ store: h.store });
});

import {
  deepseekSearch,
  createWebFetchTool,
  readDeepSeekWebConfig,
  setDeepSeekFetchEnabled,
  setDeepSeekSearchCount,
  setDeepSeekSearchEnabled,
} from "../core/llm/tools/deepseek-web";
import { createWebSearchTool } from "../core/llm/tools/web-search";
import { ToolRegistry, invalidateDisabledToolsCache } from "../core/llm/tools";

const API_KEY = "sk-test-deepseek-key-0123456789";
const BASE_URL = "https://api.deepseek.com/v1";
const SETTINGS_KEY = "codem-settings";
const SEARCH_ENABLED_KEY = "codem-deepseek-web-search";
const FETCH_ENABLED_KEY = "codem-deepseek-web-fetch";
const SEARCH_COUNT_KEY = "codem-deepseek-web-search-count";

/** 造一个够用的 Response 替身（fetchWithTimeout 只用 ok/status；两条路径分别用 json/text） */
function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function seedProvider(apiKey: string = API_KEY, baseUrl: string = BASE_URL, model = "deepseek-chat"): void {
  h.store.raw.set(
    SETTINGS_KEY,
    JSON.stringify({
      mode: "api",
      model,
      providers: [{ id: "deepseek", name: "DeepSeek", apiKey, baseUrl }],
    }),
  );
}

function enableSearch(enabled: boolean): void {
  h.store.raw.set(SEARCH_ENABLED_KEY, enabled ? "1" : "0");
}

function enableFetch(enabled: boolean): void {
  h.store.raw.set(FETCH_ENABLED_KEY, enabled ? "1" : "0");
}

/** 取第 n 次请求的 body（已解析） */
function bodyOf(callIndex = 0): Record<string, unknown> {
  const init = h.fetchSpy.mock.calls[callIndex][1] as RequestInit;
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

beforeEach(() => {
  h.store.raw.clear();
  h.fetchSpy.mockReset();
  vi.stubGlobal("fetch", h.fetchSpy);
  invalidateDisabledToolsCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  invalidateDisabledToolsCache();
});

// ==================== 1. 请求构造 ====================

describe("DSWEB-1 请求构造", () => {
  it("DSWEB-1-1: Search 打到 /v1/tools/search，POST + Bearer + JSON", async () => {
    seedProvider();
    h.fetchSpy.mockResolvedValueOnce(jsonResponse(200, { results: [] }));

    await deepseekSearch("讯飞星火 最新版本");

    expect(h.fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = h.fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.deepseek.com/v1/tools/search");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${API_KEY}`);
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });

  it("DSWEB-1-2: body 缺省 count=10、need_content=false，且不带可选字段", async () => {
    seedProvider();
    h.fetchSpy.mockResolvedValueOnce(jsonResponse(200, { results: [] }));

    await deepseekSearch("q");

    expect(bodyOf()).toEqual({ query: "q", count: 10, need_content: false });
  });

  it("DSWEB-1-3: 设置里的条数生效；模型显式传的条数优先", async () => {
    seedProvider();
    h.store.raw.set(SEARCH_COUNT_KEY, "25");

    h.fetchSpy.mockResolvedValueOnce(jsonResponse(200, { results: [] }));
    await deepseekSearch("q");
    expect(bodyOf(0).count).toBe(25);

    h.fetchSpy.mockResolvedValueOnce(jsonResponse(200, { results: [] }));
    await deepseekSearch("q", { count: 3 });
    expect(bodyOf(1).count).toBe(3);

    // 越界要被夹紧到官方范围内（1..50），不许把 999 发出去
    h.fetchSpy.mockResolvedValueOnce(jsonResponse(200, { results: [] }));
    await deepseekSearch("q", { count: 999 });
    expect(bodyOf(2).count).toBe(50);
  });

  it("DSWEB-1-4: baseUrl 没 /v1 时自动补；尾斜杠不叠成双斜杠", async () => {
    seedProvider(API_KEY, "https://api.deepseek.com");
    h.fetchSpy.mockResolvedValueOnce(jsonResponse(200, { results: [] }));
    await deepseekSearch("q");
    expect(h.fetchSpy.mock.calls[0][0]).toBe("https://api.deepseek.com/v1/tools/search");

    h.store.raw.clear();
    seedProvider(API_KEY, "https://api.deepseek.com/v1/");
    h.fetchSpy.mockResolvedValueOnce(jsonResponse(200, { results: [] }));
    await deepseekSearch("q");
    expect(h.fetchSpy.mock.calls[1][0]).toBe("https://api.deepseek.com/v1/tools/search");
  });

  it("DSWEB-1-5: ori_question / localization / need_content=true 原样透传", async () => {
    seedProvider();
    h.fetchSpy.mockResolvedValueOnce(jsonResponse(200, { results: [] }));

    await deepseekSearch("q", {
      oriQuestion: "原始问题",
      localization: "zh-CN",
      needContent: true,
    });

    expect(bodyOf()).toEqual({
      query: "q",
      count: 10,
      need_content: true,
      ori_question: "原始问题",
      localization: "zh-CN",
    });
  });

  it("DSWEB-1-6: query 为空/超 128 字 ⇒ 明确报错且不发请求", async () => {
    seedProvider();
    await expect(deepseekSearch("   ")).rejects.toThrow(/query 不能为空/);
    await expect(deepseekSearch("字".repeat(129))).rejects.toThrow(/128/);
    expect(h.fetchSpy).not.toHaveBeenCalled();
  });
});

// ==================== 2. 响应映射 ====================

describe("DSWEB-2 响应映射", () => {
  it("DSWEB-2-1: 十个字段逐个落地（含 null 的 site_name/site_icon/date 与 authority=-1）", async () => {
    seedProvider();
    h.fetchSpy.mockResolvedValueOnce(
      jsonResponse(200, {
        results: [
          {
            rerank_score: 2.5,
            title: "无站点信息的结果",
            url: "https://e.test/a",
            snippet: "摘要",
            summary: "长摘要",
            content: "",
            site_name: null,
            site_icon: null,
            date: null,
            authority: -1,
          },
          {
            rerank_score: 0.4,
            title: "全字段结果",
            url: "https://e.test/b",
            snippet: "摘要2",
            summary: "长摘要2",
            content: "正文2",
            site_name: "Example",
            site_icon: "https://e.test/i.png",
            date: "2025-10-01T00:00:00Z",
            authority: 3,
          },
        ],
      }),
    );

    const hits = await deepseekSearch("q");

    expect(hits).toHaveLength(2);
    expect(hits[0]).toEqual({
      title: "无站点信息的结果",
      url: "https://e.test/a",
      snippet: "摘要",
      summary: "长摘要",
      content: "",
      siteName: null,
      siteIcon: null,
      date: null,
      authority: -1,
      rerankScore: 2.5,
    });
    expect(hits[1]).toEqual({
      title: "全字段结果",
      url: "https://e.test/b",
      snippet: "摘要2",
      summary: "长摘要2",
      content: "正文2",
      siteName: "Example",
      siteIcon: "https://e.test/i.png",
      date: "2025-10-01T00:00:00Z",
      authority: 3,
      rerankScore: 0.4,
    });
  });

  it("DSWEB-2-2: 无结果 = 空数组（正常返回，不是错误）", async () => {
    seedProvider();
    h.fetchSpy.mockResolvedValueOnce(jsonResponse(200, { results: [] }));
    await expect(deepseekSearch("q")).resolves.toEqual([]);
  });

  it("DSWEB-2-3: 开启后 web_search 优先走 DeepSeek，输出带 summary/权威度/相关度，sources 仍是三字段", async () => {
    seedProvider();
    enableSearch(true);
    h.fetchSpy.mockResolvedValueOnce(
      jsonResponse(200, {
        results: [
          {
            rerank_score: 2.5,
            title: "T",
            url: "https://e.test/a",
            snippet: "S",
            summary: "SM",
            content: "",
            site_name: "Example",
            site_icon: null,
            date: "2025-10-01T00:00:00Z",
            authority: 3,
          },
        ],
      }),
    );

    const result = await createWebSearchTool().execute({ query: "q" }, {} as never);

    expect(result.isError).toBe(false);
    expect(result.metadata?.source).toBe("DeepSeek Search");
    expect(result.output).toContain("[Search source: DeepSeek Search]");
    expect(result.output).toContain("Summary: SM");
    expect(result.output).toContain("权威度: 3/4（极权威）");
    expect(result.output).toContain("相关度: 2.50（优质）");
    expect(result.output).toContain("站点: Example");
    // 既有消费者（UI 搜索卡片）只读这三个字段：多出来的字段不许改变它们的形状
    expect(result.metadata?.sources).toEqual([
      { url: "https://e.test/a", title: "T", snippet: "S" },
    ]);
    expect(String(h.fetchSpy.mock.calls[0][0])).toContain("/tools/search");
  });

  it("DSWEB-2-4: web_search 的 num_results 会传给 DeepSeek 当 count", async () => {
    seedProvider();
    enableSearch(true);
    h.fetchSpy.mockResolvedValueOnce(jsonResponse(200, { results: [] }));

    await createWebSearchTool().execute({ query: "q", num_results: 4 }, {} as never);

    expect(bodyOf().count).toBe(4);
  });
});

// ==================== 3. 错误映射与重试 ====================

describe("DSWEB-3 错误映射与重试", () => {
  const CASES: Array<[number, string]> = [
    [400, "请求不合法"],
    [401, "API Key 无效"],
    [402, "余额不足"],
    [403, "安全策略"],
    [404, "没有取到可用内容"],
    [408, "读取请求体超时"],
    [413, "请求体过大"],
    [429, "QPS"],
    [500, "服务器内部错误"],
    [504, "下游"],
  ];

  it("DSWEB-3-1: 十个状态码逐条映射成中文（含状态码与官方 message）", async () => {
    for (const [status, hint] of CASES) {
      h.store.raw.clear();
      seedProvider();
      h.fetchSpy.mockReset();
      h.fetchSpy.mockResolvedValue(
        jsonResponse(status, {
          error: { message: `official-msg-${status}`, type: "invalid_request_error", param: null, code: "some-code" },
        }),
      );

      let message = "";
      try {
        await deepseekSearch("q", { retryBaseDelayMs: 0 });
      } catch (e) {
        message = (e as Error).message;
      }

      expect(message, `HTTP ${status} 应当有中文可读提示`).toContain(`HTTP ${status}`);
      expect(message, `HTTP ${status} 应当带上语义提示`).toContain(hint);
      expect(message, `HTTP ${status} 应当带上官方 message`).toContain(`official-msg-${status}`);
      expect(message).toContain("DeepSeek Search");
    }
  });

  it("DSWEB-3-2: 429 会重试（第 2 次成功时只报成功）", async () => {
    seedProvider();
    h.fetchSpy
      .mockResolvedValueOnce(jsonResponse(429, { error: { message: "rate limited" } }))
      .mockResolvedValueOnce(jsonResponse(200, { results: [] }));

    await expect(deepseekSearch("q", { retryBaseDelayMs: 0 })).resolves.toEqual([]);
    expect(h.fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("DSWEB-3-3: 401 不重试（只请求一次）", async () => {
    seedProvider();
    h.fetchSpy.mockResolvedValue(jsonResponse(401, { error: { message: "invalid key" } }));

    await expect(deepseekSearch("q", { retryBaseDelayMs: 0 })).rejects.toThrow(/401/);
    expect(h.fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("DSWEB-3-4: 402 不重试（只请求一次）—— 重试永远不会把余额变出来", async () => {
    seedProvider();
    h.fetchSpy.mockResolvedValue(jsonResponse(402, { error: { message: "Insufficient Balance" } }));

    await expect(deepseekSearch("q", { retryBaseDelayMs: 0 })).rejects.toThrow(/402/);
    expect(h.fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("DSWEB-3-5: 5xx 重试上限 2 次（共 3 次请求），失败文案里写明已重试次数", async () => {
    seedProvider();
    h.fetchSpy.mockResolvedValue(jsonResponse(500, { error: { message: "boom" } }));

    let message = "";
    try {
      await deepseekSearch("q", { retryBaseDelayMs: 0 });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(h.fetchSpy).toHaveBeenCalledTimes(3);
    expect(message).toContain("已重试 2 次");
  });

  it("DSWEB-3-6: 错误信息与日志里都不含 API Key", async () => {
    seedProvider();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      // 最坏情况：服务端把请求头回显进 message；我们仍然不许把它带出去
      h.fetchSpy.mockResolvedValue(
        jsonResponse(401, { error: { message: `bad key ${API_KEY}`, type: "auth", param: null, code: "401" } }),
      );
      let message = "";
      try {
        await deepseekSearch("q", { retryBaseDelayMs: 0 });
      } catch (e) {
        message = (e as Error).message;
      }

      expect(message.length).toBeGreaterThan(0);
      expect(message).not.toContain(API_KEY);

      const logged = [...warnSpy.mock.calls, ...errorSpy.mock.calls, ...logSpy.mock.calls]
        .map((args) => args.map((a) => String(a)).join(" "))
        .join("\n");
      expect(logged).not.toContain(API_KEY);
    } finally {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it("DSWEB-3-7: Fetch 的 403/404 也映射成中文，且 403 不重试", async () => {
    seedProvider();
    enableFetch(true);
    h.fetchSpy.mockResolvedValue(jsonResponse(403, { error: { message: "blocked by policy" } }));

    const forbidden = await createWebFetchTool().execute({ url: "https://e.test/a" }, {} as never);
    expect(forbidden.isError).toBe(true);
    expect(forbidden.output).toContain("403");
    expect(forbidden.output).toContain("安全策略");
    expect(forbidden.output).toContain("blocked by policy");
    expect(h.fetchSpy).toHaveBeenCalledTimes(1);

    h.fetchSpy.mockReset();
    h.fetchSpy.mockResolvedValue(jsonResponse(404, { error: { message: "no content" } }));
    const notFound = await createWebFetchTool().execute({ url: "https://e.test/a" }, {} as never);
    expect(notFound.isError).toBe(true);
    expect(notFound.output).toContain("404");
    expect(notFound.output).toContain("没有取到可用内容");
  });
});

// ==================== 4. 开关语义（不回退、不空转） ====================

describe("DSWEB-4 开关语义", () => {
  it("DSWEB-4-1: 开关关闭 ⇒ 不发任何 /tools/ 请求，走原来的 LLM 知识检索", async () => {
    seedProvider();
    enableSearch(false);
    h.fetchSpy.mockResolvedValueOnce(
      jsonResponse(200, { choices: [{ message: { content: "来自模型记忆的回答" } }] }),
    );

    const result = await createWebSearchTool().execute({ query: "q" }, {} as never);

    expect(result.isError).toBe(false);
    expect(result.metadata?.source).toBe("deepseek (LLM knowledge)");
    const urls = h.fetchSpy.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("/tools/"))).toBe(false);
    expect(urls).toEqual(["https://api.deepseek.com/v1/chat/completions"]);
  });

  it("DSWEB-4-2: 开启但没有 Key ⇒ 明确报错且零网络请求（不许静默回退）", async () => {
    seedProvider("");
    enableSearch(true);

    const result = await createWebSearchTool().execute({ query: "q" }, {} as never);

    expect(result.isError).toBe(true);
    expect(result.output).toContain("没有配置 DeepSeek API Key");
    expect(result.output).toContain("不回退");
    expect(h.fetchSpy).not.toHaveBeenCalled();
  });

  it("DSWEB-4-3: 开启后 DeepSeek 失败 ⇒ 只报错，不回退到旧后端", async () => {
    seedProvider();
    enableSearch(true);
    h.fetchSpy.mockResolvedValue(jsonResponse(402, { error: { message: "Insufficient Balance" } }));

    const result = await createWebSearchTool().execute({ query: "q" }, {} as never);

    expect(result.isError).toBe(true);
    expect(result.metadata?.source).toBe("DeepSeek Search");
    expect(result.output).toContain("402");
    expect(result.output).toContain("余额不足");
    expect(result.output).not.toContain("LLM knowledge");
    // 402 不重试 ⇒ 恰好一次请求，且打的是 DeepSeek（没有 chat/completions 的回退请求）
    expect(h.fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(h.fetchSpy.mock.calls[0][0])).toContain("/tools/search");
  });

  it("DSWEB-4-4: 缺省配置 = 两个开关关闭、条数 10、baseUrl 兜底官方地址", () => {
    const config = readDeepSeekWebConfig();
    expect(config.searchEnabled).toBe(false);
    expect(config.fetchEnabled).toBe(false);
    expect(config.searchCount).toBe(10);
    expect(config.apiKey).toBe("");
    expect(config.baseUrl).toBe("https://api.deepseek.com/v1");
  });

  it("DSWEB-4-5: 开关与条数写进去能读回来（写读同一份键）", () => {
    setDeepSeekSearchEnabled(true);
    setDeepSeekFetchEnabled(true);
    setDeepSeekSearchCount(30);

    expect(h.store.raw.get(SEARCH_ENABLED_KEY)).toBe("1");
    expect(h.store.raw.get(FETCH_ENABLED_KEY)).toBe("1");
    expect(h.store.raw.get(SEARCH_COUNT_KEY)).toBe("30");

    const config = readDeepSeekWebConfig();
    expect(config.searchEnabled).toBe(true);
    expect(config.fetchEnabled).toBe(true);
    expect(config.searchCount).toBe(30);

    setDeepSeekSearchEnabled(false);
    setDeepSeekFetchEnabled(false);
    expect(readDeepSeekWebConfig().searchEnabled).toBe(false);
    expect(readDeepSeekWebConfig().fetchEnabled).toBe(false);
  });
});

// ==================== 5. web_fetch 工具 ====================

describe("DSWEB-5 web_fetch 工具", () => {
  it("DSWEB-5-1: 工具 id/参数/契约正确，且默认注册表里有它", async () => {
    const tool = createWebFetchTool();
    expect(tool.id).toBe("web_fetch");
    expect(tool.contract).toMatchObject({ readOnly: true, accessScope: "network" });
    expect(tool.parameters).toMatchObject({
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"],
    });

    // 默认注册表（`createDefaultToolRegistry`）是模型真正看到的入口
    const { createDefaultToolRegistry } = await import("../core/llm/tools");
    const registry = createDefaultToolRegistry();
    expect(registry.getAll().map((t) => t.id)).toContain("web_fetch");
  });

  it("DSWEB-5-2: 受「工具管理」禁用列表约束（定义层看不见、执行层拒绝）", async () => {
    seedProvider();
    enableFetch(true);
    const registry = new ToolRegistry();
    registry.register(createWebFetchTool());

    h.store.raw.set("codem-disabled-tools", JSON.stringify(["web_fetch"]));
    invalidateDisabledToolsCache();

    expect(registry.getAll().map((t) => t.id)).not.toContain("web_fetch");
    const refused = await registry.execute("call-1", "web_fetch", { url: "https://e.test/a" }, {} as never);
    expect(refused.status).toBe("error");
    expect(String(refused.error)).toContain("禁用");
    expect(h.fetchSpy).not.toHaveBeenCalled();
  });

  it("DSWEB-5-3: Fetch 开关关闭 ⇒ 明确拒绝且零网络请求", async () => {
    seedProvider();
    enableFetch(false);

    const result = await createWebFetchTool().execute({ url: "https://e.test/a" }, {} as never);

    expect(result.isError).toBe(true);
    expect(result.output).toContain("关闭");
    expect(result.metadata?.disabled).toBe(true);
    expect(h.fetchSpy).not.toHaveBeenCalled();
  });

  it("DSWEB-5-4: 没配 Key ⇒ 明确报错且零网络请求", async () => {
    seedProvider("");
    enableFetch(true);

    const result = await createWebFetchTool().execute({ url: "https://e.test/a" }, {} as never);

    expect(result.isError).toBe(true);
    expect(result.output).toContain("未配置 DeepSeek API Key");
    expect(h.fetchSpy).not.toHaveBeenCalled();
  });

  it("DSWEB-5-5: Fetch 请求构造（/v1/tools/fetch、body 只有 url、带 Bearer）", async () => {
    seedProvider();
    enableFetch(true);
    h.fetchSpy.mockResolvedValueOnce(jsonResponse(200, { title: "页面标题", content: "正文内容" }));

    const result = await createWebFetchTool().execute({ url: "https://e.test/a?x=1" }, {} as never);

    const [url, init] = h.fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.deepseek.com/v1/tools/fetch");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${API_KEY}`);
    expect(JSON.parse(String(init.body))).toEqual({ url: "https://e.test/a?x=1" });
    expect(result.isError).toBe(false);
    expect(result.output).toContain("Title: 页面标题");
    expect(result.output).toContain("正文内容");
  });

  it("DSWEB-5-6: 正文超 20000 字 ⇒ 截断并明确标注（模型要知道被截断了）", async () => {
    seedProvider();
    enableFetch(true);
    h.fetchSpy.mockResolvedValueOnce(jsonResponse(200, { title: "长文", content: "字".repeat(25000) }));

    const result = await createWebFetchTool().execute({ url: "https://e.test/long" }, {} as never);

    expect(result.isError).toBe(false);
    expect(result.metadata?.truncated).toBe(true);
    expect(result.metadata?.totalChars).toBe(25000);
    expect(result.output).toContain("正文已截断");
    expect(result.output).toContain("25000");
    expect(result.output).toContain("20000");
    // 正文保留 20000 字 + 注记（注记本身不许把"截断"这件事藏起来）
    const contentChars = result.metadata?.contentChars as number;
    expect(contentChars).toBeGreaterThan(20000);
    expect(contentChars).toBeLessThan(21000);
  });

  it("DSWEB-5-7: 短正文不标注截断", async () => {
    seedProvider();
    enableFetch(true);
    h.fetchSpy.mockResolvedValueOnce(jsonResponse(200, { title: "短文", content: "就这一句" }));

    const result = await createWebFetchTool().execute({ url: "https://e.test/short" }, {} as never);

    expect(result.metadata?.truncated).toBe(false);
    expect(result.output).not.toContain("正文已截断");
  });

  it("DSWEB-5-8: 非法 URL（空/非 http/带凭据/无主机名）一律明确拒绝且不发请求", async () => {
    seedProvider();
    enableFetch(true);

    const cases: Array<[Record<string, unknown>, string]> = [
      [{}, "url 必填"],
      [{ url: "   " }, "url 必填"],
      [{ url: "file:///etc/passwd" }, "只支持 http/https"],
      [{ url: "https://user:pass@e.test/a" }, "用户名/密码"],
      [{ url: "不是网址" }, "不是合法的绝对 URL"],
    ];
    for (const [args, hint] of cases) {
      const result = await createWebFetchTool().execute(args, {} as never);
      expect(result.isError, `${JSON.stringify(args)} 应当判失败`).toBe(true);
      expect(result.output).toContain(hint);
    }
    expect(h.fetchSpy).not.toHaveBeenCalled();
  });

  it("DSWEB-5-9: 200 但正文为空 ⇒ 显式判失败（内容型工具不按首行推断成败）", async () => {
    seedProvider();
    enableFetch(true);
    h.fetchSpy.mockResolvedValueOnce(jsonResponse(200, { title: "", content: "" }));

    const result = await createWebFetchTool().execute({ url: "https://e.test/empty" }, {} as never);

    expect(result.isError).toBe(true);
    expect(result.output).toContain("正文为空");
    expect(result.metadata?.empty).toBe(true);
  });

  it("DSWEB-5-10: title 缺失时按空串处理，不编造", async () => {
    seedProvider();
    enableFetch(true);
    h.fetchSpy.mockResolvedValueOnce(jsonResponse(200, { content: "只有正文" }));

    const result = await createWebFetchTool().execute({ url: "https://e.test/a" }, {} as never);

    expect(result.isError).toBe(false);
    expect(result.metadata?.title).toBe("");
    expect(result.output).toContain("Title: (无标题)");
  });
});

// ==================== 6. 设置键读写对称（SKEY-2 的自证） ====================

describe("DSWEB-6 设置键对称", () => {
  /**
   * 为什么这里要自己再扫一遍：SKEY-2（`settings-keys-symmetry.test.ts`）会机械对账全仓
   * 设置键的读写两侧，但它**只报总数** —— 如果扫描器恰好没认出我这三个键（例如写入侧
   * 写成三元表达式），它会安静通过，而"设置项存在、效果不落地"正是这类缺陷的典型现场。
   * 所以这里用**同一个扫描器**把这三个键逐个点名，确认两侧都命中。
   */
  it("DSWEB-6-1: codem-deepseek-web-* 三个键在扫描器口径下都有读方与写方", async () => {
    const { scanText, constsFrom } = await import("./helpers/settings-key-scan");

    const root = join(__dirname, "..", "..");
    const files = [
      join(root, "src", "core", "llm", "tools", "deepseek-web.ts"),
      join(root, "src", "components", "SettingsPanel.tsx"),
    ];
    const global = new Map<string, string>();
    const perFile = new Map<string, Map<string, string>>();
    for (const f of files) {
      const local = constsFrom(readFileSync(f, "utf8"));
      for (const [k, v] of local) global.set(k, v);
      perFile.set(f, local);
    }

    const reads = new Set<string>();
    const writes = new Set<string>();
    for (const f of files) {
      for (const hit of scanText(readFileSync(f, "utf8"), perFile.get(f) ?? new Map(), global)) {
        (hit.isWrite ? writes : reads).add(hit.key);
      }
    }

    for (const key of [
      "codem-deepseek-web-search",
      "codem-deepseek-web-fetch",
      "codem-deepseek-web-search-count",
    ]) {
      expect(writes.has(key), `${key} 缺少写入方`).toBe(true);
      expect(reads.has(key), `${key} 缺少读取方`).toBe(true);
    }
  });
});

// ==================== 7. 设置面板（设置 → DeepSeek 区域） ====================

describe("DSWEB-7 设置面板接线", () => {
  /**
   * 这一组是**源码级**判据（与仓里 `CP-001..004` 同一口径）：设置面板的渲染要拉起半套
   * 应用（framer-motion、多个 store、Tauri 端口），为两个开关把整块 UI 都 mock 掉，
   * 得到的"绿"并不比直接钉接线更可信。真正需要行为证据的部分（开关写入 → 工具读取）
   * 已经由 `DSWEB-4-5` / `DSWEB-6-1` 用**真读写**覆盖了。
   */
  const panelSource = () =>
    readFileSync(join(__dirname, "..", "components", "SettingsPanel.tsx"), "utf8");

  it("DSWEB-7-1: DeepSeek 卡片里有 Search/Fetch 两个开关，且写的是同一组 setter", () => {
    const src = panelSource();
    expect(src).toContain("网页搜索（DeepSeek Search）");
    expect(src).toContain("网页抓取（DeepSeek Fetch）");
    expect(src).toContain("setDeepSeekSearchEnabled(next)");
    expect(src).toContain("setDeepSeekFetchEnabled(next)");
    // 只对 DeepSeek 那张卡片生效（其它 provider 不许出现这组开关）
    expect(src).toContain('provider.id === "deepseek"');
  });

  it("DSWEB-7-2: key 未配置时开关 disabled + 提示先填 key", () => {
    const src = panelSource();
    expect(src).toContain("disabled={!provider.apiKey}");
    expect(src).toContain("先在上方填写并点「保存并刷新」");
  });

  it("DSWEB-7-3: 说明里写明计费与限速口径（5 元/1000 次、QPS 5、失败不计费）", () => {
    const src = panelSource();
    expect(src).toContain("5 元/1000 次");
    expect(src).toContain("QPS 5");
    expect(src).toContain("失败或无结果不计费");
  });

  it("DSWEB-7-4: 只读展示的 base URL 走工具侧同一个解析函数（不是自己拼字符串）", () => {
    const src = panelSource();
    expect(src).toContain("deepseekToolBaseUrl(deepseekWeb.baseUrl)");
    expect(src).toContain("实际使用的 base URL（只读");
  });

  it("DSWEB-7-5: 条数输入受 1..50 约束，且缺省值来自模块常量", () => {
    const src = panelSource();
    expect(src).toMatch(/max=\{DEEPSEEK_MAX_SEARCH_COUNT\}/);
    expect(src).toContain("DEEPSEEK_DEFAULT_SEARCH_COUNT");
    expect(src).toMatch(/min=\{1\}/);
  });
});
