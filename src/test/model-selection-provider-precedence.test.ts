/**
 * 选供应商的**优先级**判据（真机缺陷，2026-11-06）
 *
 * ## 真机现场（用户设置 provider=`aicodewith`、model=`claude-haiku-4-5-20251001`）
 *
 * 真实回合**必然失败**，CDP console：
 *
 * ```
 * Access to fetch at 'https://api.anthropic.com/v1/chat/completions' from origin
 * 'http://tauri.localhost' has been blocked by CORS policy
 * [AgenticLoop] LLM stream error … TypeError Failed to fetch
 * ```
 *
 * 路由日志：`[LLMEngine.getAgenticLoop] … provider.id=claude, provider.baseUrl=https://api.anthropic.com/v1`
 * 而设置里写的是 `aicodewith`。
 *
 * ## 根因（就是本判据要锁住的那一行）
 *
 * `resolveModelSelection` 在兜底时**只按模型名**去找它"属于哪家"：
 *
 * ```ts
 * const owned = providers.find((p) => model.startsWith(`${p}-`) || model.includes(p));
 * ```
 *
 * `claude-haiku-4-5-20251001` 以 `claude-` 开头 ⇒ 命中内置 `claude`（baseUrl
 * `https://api.anthropic.com/v1`）⇒ **用户显式选的 `aicodewith` 被模型名顶掉**。
 * `gpt-*` / `gemini-*` / `deepseek-*` 有同一类风险（聚合供应商的模型 id 与原生前缀同形）。
 *
 * ## 期望语义（判据逐条对应）
 *
 * 1. 显式 provider（非空、非 `auto`、且**已登记**）⇒ 一律用它；模型名只用于列表/能力，不参与选供应商；
 * 2. `auto` / 空 / 未设置 ⇒ 才走模型名启发式（既有行为不回归）；
 * 3. 显式 provider **不存在** ⇒ **fail-closed**（`unavailable` + 报错），
 *    **不许**再按模型名回退（旧行为正是 `claude-*` → `api.anthropic.com` 的来源）；
 * 4. 模型为空 + 显式 provider 已登记 ⇒ 用**该 provider 自己的默认模型**；
 *    没有默认模型同样 fail-closed（不许静默借兜底供应商的模型）。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * settings 走**共享 mock 基座**（`./settings-mock`，单一实现；`new LLMEngine()`
 * 内部会读 `loadMemoryChecked` 等导出，手写 mock 会缺面）。
 */
vi.mock("../core/storage/settings", async () => (await import("./settings-mock")).createSettingsMock());

import { createSettingsMock, settingsMockStore } from "./settings-mock";
import * as settingsModule from "../core/storage/settings";
import { LLMEngine } from "../core/llm/index";
import {
  MANAGED_FREE_MODEL_PROVIDER_ID,
  resolveModelSelection,
  setFreeModelIds,
} from "../core/free-model-plugin/model-index";

const settingsMock = settingsModule as unknown as Record<string, unknown>;
const store = settingsMockStore(settingsMock).raw;

/** 真机上那一份设置（只留本判据关心的字段） */
const USER_SETTINGS = {
  mode: "api",
  provider: "aicodewith",
  model: "claude-haiku-4-5-20251001",
  providers: [{ id: "aicodewith", name: "AI Code With", apiKey: "sk-test-only" }],
};

const FALLBACK = { providerId: "openai", modelId: "gpt-4o" };

/** 引擎注册表里真实存在的那几个 id（真机日志里 `claude` 就是靠 `claude-` 前缀被抢走的） */
const PROVIDERS = ["openai", "anthropic", "claude", "mimo", "deepseek", "aicodewith", "moonshot", "gemini"];

/** 抓 console.warn（只关心本判据需要的诊断；引擎构造时可能有别的 warn，按文案过滤） */
function captureWarnings(): { calls: string[]; restore: () => void } {
  const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
  return {
    get calls() {
      return spy.mock.calls.map((c) => String(c[0]));
    },
    restore: () => spy.mockRestore(),
  } as { calls: string[]; restore: () => void };
}

beforeEach(() => {
  store.clear();
  setFreeModelIds([]);
});

describe("PROVIDER-PRECEDENCE：显式 provider 优先（真机 CORS 缺陷的根因）", () => {
  it("PREC-1：provider=aicodewith + model=claude-haiku-4-5-20251001 ⇒ 选 aicodewith（不许被 claude 前缀抢走）", () => {
    const r = resolveModelSelection("claude-haiku-4-5-20251001", PROVIDERS, FALLBACK, "aicodewith");
    expect(r.providerId, "用户显式选的供应商必须赢过模型名前缀").toBe("aicodewith");
    expect(r.modelId).toBe("claude-haiku-4-5-20251001");

    /*
     * 变异自证点：若把显式优先去掉（改回模型名优先），上一行会变成 "claude"
     * ⇒ 真机上就是 api.anthropic.com 的 CORS 失败。
     */
  });

  it("PREC-2：引擎 resolveSlot 现读 codem-settings 的 provider ⇒ provider.id=aicodewith、baseUrl 不是 api.anthropic.com", () => {
    store.set("codem-settings", JSON.stringify(USER_SETTINGS));
    const engine = new LLMEngine();
    const resolved = engine.resolveSlot("chat");

    expect(resolved.providerId).toBe("aicodewith");
    expect(resolved.modelId).toBe("claude-haiku-4-5-20251001");

    const provider = engine.providers.get(resolved.providerId) as unknown as {
      id: string;
      config?: { baseUrl?: string };
    };
    expect(provider, "选中的供应商必须真的在注册表里").toBeTruthy();
    const baseUrl = String(provider.config?.baseUrl ?? "");
    expect(baseUrl, "必须发往 AI Code With 的端点").toBe("https://api.aicodewith.ai/v1");
    expect(baseUrl, "不许发往 Anthropic（真机 CORS 就是它）").not.toContain("api.anthropic.com");
  });

  it("PREC-3：显式 provider 对 gpt-*/gemini-*/deepseek-* 同形模型 id 也照样优先（同类风险一次盖住）", () => {
    const cases: Array<[string, string]> = [
      ["gpt-5.4", "openai"],
      ["gemini-3-pro-preview", "gemini"],
      ["deepseek-v4-pro", "deepseek"],
      ["claude-sonnet-4-6", "anthropic"],
    ];
    for (const [model, builtin] of cases) {
      const r = resolveModelSelection(model, PROVIDERS, FALLBACK, "aicodewith");
      expect(r.providerId, `${model} 不能被内置 ${builtin} 抢走`).toBe("aicodewith");
      expect(r.modelId).toBe(model);
    }
  });
});

describe("PROVIDER-PRECEDENCE：auto / 未设置才走模型名启发式（既有行为不回归）", () => {
  it("PREC-4：provider=auto + model=claude-* ⇒ 仍是内置 claude", () => {
    const r = resolveModelSelection("claude-haiku-4-5-20251001", PROVIDERS, FALLBACK, "auto");
    expect(r.providerId, "auto 才允许按模型名推断").toBe("claude");
    expect(r.modelId).toBe("claude-haiku-4-5-20251001");
  });

  it("PREC-5：provider 为空/纯空白/未设置 ⇒ 都走启发式（gpt-* 仍回 openai）", () => {
    for (const explicit of ["", "   ", null, undefined]) {
      const r = resolveModelSelection("gpt-4o", PROVIDERS, FALLBACK, explicit);
      expect(r.providerId, `explicit=${JSON.stringify(explicit)} 应走启发式`).toBe("openai");
    }
    /* 设置里没有模型且**没有显式 provider** ⇒ 原样兜底（既有行为） */
    expect(resolveModelSelection("", PROVIDERS, FALLBACK, "auto")).toEqual(FALLBACK);
    expect(resolveModelSelection(null, PROVIDERS, FALLBACK)).toEqual(FALLBACK);
  });
});

describe("PROVIDER-PRECEDENCE：模型为空时也尊重显式 provider（C 项修复）", () => {
  const DEFAULTS = {
    aicodewith: "claude-haiku-4-5-20251001",
    deepseek: "deepseek-v4-flash",
  };

  it("PREC-10：model 为空 + 显式 provider 已登记 ⇒ 用该 provider 的默认模型（不静默借兜底）", () => {
    const r = resolveModelSelection("", PROVIDERS, FALLBACK, "aicodewith", DEFAULTS);
    expect(r.providerId, "不许因为没模型就把用户选的供应商一起丢掉").toBe("aicodewith");
    expect(r.modelId, "必须是该 provider 自己的默认模型").toBe(DEFAULTS.aicodewith);
    expect(r.modelId, "不许静默用兜底供应商的模型（gpt-4o）").not.toBe(FALLBACK.modelId);

    const nullCase = resolveModelSelection(null, PROVIDERS, FALLBACK, "deepseek", DEFAULTS);
    expect(nullCase.providerId).toBe("deepseek");
    expect(nullCase.modelId).toBe(DEFAULTS.deepseek);

    /* 没有默认模型 ⇒ fail-closed（不许静默借兜底） */
    const noDefault = resolveModelSelection("", PROVIDERS, FALLBACK, "moonshot", DEFAULTS);
    expect(noDefault.unavailable, "没有默认模型必须报错").toBe(true);
    expect(noDefault.error).toMatch(/没有默认模型|重选/);

    /* 引擎级：真实 registry 里 aicodewith 的默认模型（静态目录第一条） */
    store.set("codem-settings", JSON.stringify({ mode: "api", provider: "aicodewith", model: "" }));
    const engine = new LLMEngine();
    const resolved = engine.resolveSlot("chat");
    expect(resolved.providerId).toBe("aicodewith");
    const aicw = engine.providers.get("aicodewith") as unknown as { config: { models: Array<{ id: string }> } };
    expect(resolved.modelId, "模型为空时用该 provider 的默认模型").toBe(aicw.config.models[0].id);
    expect(resolved.modelId).not.toBe(FALLBACK.modelId);

    /* 反向对照：auto/空 provider 时仍原样兜底（既有行为不回归） */
    expect(resolveModelSelection("", PROVIDERS, FALLBACK, "auto")).toEqual(FALLBACK);
  });

  it("PREC-11：model 为空 + 显式 provider 不存在 ⇒ unavailable（不回退兜底供应商）", () => {
    const r = resolveModelSelection(null, PROVIDERS, FALLBACK, "no-such-provider");
    expect(r.unavailable, "不存在的供应商必须 fail-closed").toBe(true);
    expect(r.providerId, "必须保留用户选的那个 id（便于诊断/重选）").toBe("no-such-provider");
    expect(r.providerId, "不许回退到兜底供应商").not.toBe(FALLBACK.providerId);
    expect(String(r.error)).toMatch(/未注册/);

    /* 有模型时同样 fail-closed（别只修空模型那条分支） */
    const r2 = resolveModelSelection("totally-unknown-model", PROVIDERS, FALLBACK, "not-a-provider");
    expect(r2.unavailable).toBe(true);
    expect(r2.providerId).toBe("not-a-provider");
    expect(r2.providerId).not.toBe(FALLBACK.providerId);
  });
});

describe("PROVIDER-PRECEDENCE：显式 provider 不存在 ⇒ fail-closed（不回退模型名路由）", () => {
  it("PREC-6：provider=不存在的 id ⇒ unavailable，且 providerId 仍是用户选的 id（不是 claude）", () => {
    const r = resolveModelSelection("claude-haiku-4-5-20251001", PROVIDERS, FALLBACK, "not-a-provider");
    expect(r.unavailable, "不存在的供应商必须 fail-closed").toBe(true);
    expect(r.providerId, "★ 不许按模型名回退到内置 claude（真机 CORS 的根因）").not.toBe("claude");
    expect(r.providerId).toBe("not-a-provider");
    expect(String(r.error), "错误要能让用户去设置里重选").toMatch(/未注册/);
    expect(String(r.error)).toContain("not-a-provider");
  });

  it("PREC-7：引擎的兜底对不存在的 provider 抛可识别错误（不静默发往 openai）", () => {
    store.set(
      "codem-settings",
      JSON.stringify({ mode: "api", provider: "no-such-provider", model: "totally-unknown-model" }),
    );
    const engine = new LLMEngine();
    const warnings = captureWarnings();
    try {
      expect(
        () => engine.resolveSlot("chat"),
        "引擎必须把「provider 未注册」报出来，而不是悄悄换一家发请求",
      ).toThrow(/no-such-provider[\s\S]*未注册|未注册[\s\S]*no-such-provider/);
    } finally {
      warnings.restore();
    }
  });
});

describe("PROVIDER-PRECEDENCE：免费模型插件的既有归属不被回归", () => {
  it("PREC-8：没写显式 provider 时，插件模型仍归 free-model（FREE-ROUTE-6 的语义保留）", () => {
    setFreeModelIds(["ling-3.1-flash-free"]);
    expect(resolveModelSelection("ling-3.1-flash-free", PROVIDERS, FALLBACK)).toEqual({
      providerId: MANAGED_FREE_MODEL_PROVIDER_ID,
      modelId: "ling-3.1-flash-free",
    });
  });

  it("PREC-9：显式 provider 就是 free-model（界面选免费模型时会写它）⇒ 直接用，不绕路", () => {
    setFreeModelIds(["ling-3.1-flash-free"]);
    const r = resolveModelSelection(
      "ling-3.1-flash-free",
      [...PROVIDERS, MANAGED_FREE_MODEL_PROVIDER_ID],
      FALLBACK,
      MANAGED_FREE_MODEL_PROVIDER_ID,
    );
    expect(r.providerId).toBe(MANAGED_FREE_MODEL_PROVIDER_ID);
  });
});
