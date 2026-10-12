/**
 * 第 206 波判据：**按模型归属路由**（用户实报）
 *
 * > 这个插件启动后，我们 codem 里刷新和管理 free 模型列表，Our Free Model（免费模型插件）提示请先配置
 * > API Key【免费模型不要 key 才对】。然后选择其中一个 free 模型，对话，提示：执行出错
 * > [Error] openai not configured. Debug: DB has settings=true, providers=7, openai hasKey=false
 *
 * 两件事：
 * ① **路由**：档案槽位里记的 provider 还是 openai，而用户选的是插件给的模型 ⇒ 请求发去了 openai。
 *    修法是按**模型归属**覆盖 provider（插件提供的模型 ⇒ 走 free-model，密钥运行时注册、用户不用配）。
 * ② **不误导**：那条托管供应商**故意不落盘密钥**，界面不能因此说「请先配置 API Key」（免费模型不需要）。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  MANAGED_FREE_MODEL_PROVIDER_ID,
  freeModelIdSnapshot,
  isFreeModelId,
  resolveModelSelection,
  routeProviderForModel,
  setFreeModelIds,
} from "../core/free-model-plugin/model-index";

const root = path.resolve(__dirname, "../..");

describe("FREE-ROUTE：内置免费模型的归属索引", () => {
  it("FREE-ROUTE-1：只有插件当下提供的模型才认（清空 + 重建，不残留已下线的）", () => {
    setFreeModelIds(["a-free", "b-free"]);
    expect(isFreeModelId("a-free")).toBe(true);
    expect(isFreeModelId("gpt-4o"), "别人的模型不该被认领").toBe(false);
    expect(isFreeModelId(""), "空 id 不算").toBe(false);
    expect(isFreeModelId(null)).toBe(false);

    /* 插件刷新后清单变了 ⇒ 旧 id 必须被忘掉（否则会把请求发去一个已经不在的模型） */
    setFreeModelIds(["c-free"]);
    expect(isFreeModelId("a-free"), "已下线的旧 id 不该再被认领").toBe(false);
    expect(isFreeModelId("c-free")).toBe(true);
    expect(freeModelIdSnapshot()).toEqual(["c-free"]);
  });

  it("FREE-ROUTE-2：托管供应商 id 只有一份来源（引擎与插件不许各写一个字符串）", () => {
    expect(MANAGED_FREE_MODEL_PROVIDER_ID).toBe("free-model");
    const service = readFileSync(path.join(root, "src/core/free-model-plugin/service.ts"), "utf8");
    expect(service, "service 里不许再写死那个 id 的字面量").not.toMatch(/MANAGED_PROVIDER_ID = "free-model"/);
    expect(service, "要从索引模块取（单一来源）").toContain("MANAGED_FREE_MODEL_PROVIDER_ID");
    expect(service, "刷新清单时要把归属索引同步给引擎").toContain("setFreeModelIds(");
  });

  it("FREE-ROUTE-3（结构棘轮）：引擎的 resolveSlot 必须在**入口处**做归属覆盖", () => {
    const engine = readFileSync(path.join(root, "src/core/llm/index.ts"), "utf8");
    expect(engine, "引擎要调用归属覆盖（纯函数）").toContain("routeProviderForModel(");
    expect(engine, "覆盖要发生在对外入口 resolveSlot 里").toMatch(
      /resolveSlot\(slot: TaskSlot\)[\s\S]{0,1200}?routeProviderForModel\(/,
    );
    /*
     * 为什么要求"包一层"而不是逐条 return 改：resolveSlot 有多条返回路径，
     * 漏掉一条就会静默发错 provider。判据把"原实现被改名 + 入口包一层"这个形态锁住。
     */
    expect(engine, "原实现要改名成 resolveSlotRaw（入口包一层才盖得住所有路径）").toContain(
      "private resolveSlotRaw(slot: TaskSlot)",
    );
  });

  it("FREE-ROUTE-4：界面不许因为托管供应商没有落盘密钥就说「请先配置 API Key」", () => {
    const panel = readFileSync(path.join(root, "src/components/SettingsPanel.tsx"), "utf8");
    expect(panel, "要认出托管条目").toContain('managedBy === "free-model-plugin"');
    expect(panel, "并说明它无需 Key").toMatch(/无需 API Key/);
  });
});

describe("FREE-ROUTE：按模型归属覆盖 provider（行为）", () => {
  it("FREE-ROUTE-5：插件提供的模型 ⇒ provider 被覆盖成 free-model（用户报的 openai not configured 就出在这一步）", () => {
    setFreeModelIds(["mimo-v2.6-flash-free", "nemotron-3-ultra-free"]);

    const openaiSlot = routeProviderForModel({ providerId: "openai", modelId: "mimo-v2.6-flash-free" });
    expect(openaiSlot.providerId, "免费模型不能发去 openai（那份 key 本来就没有）").toBe(
      MANAGED_FREE_MODEL_PROVIDER_ID,
    );
    expect(openaiSlot.modelId, "模型 id 不许被改掉").toBe("mimo-v2.6-flash-free");

    const other = routeProviderForModel({ providerId: "openai", modelId: "gpt-4o" });
    expect(other.providerId, "别人的模型一个字都不能动").toBe("openai");

    const already = routeProviderForModel({ providerId: MANAGED_FREE_MODEL_PROVIDER_ID, modelId: "mimo-v2.6-flash-free" });
    expect(already.providerId).toBe(MANAGED_FREE_MODEL_PROVIDER_ID);

    /* 插件没起来 / 清单为空时不许乱认领 */
    setFreeModelIds([]);
    expect(routeProviderForModel({ providerId: "openai", modelId: "mimo-v2.6-flash-free" }).providerId).toBe("openai");
  });
});

/**
 * 第 208 波：引擎兜底必须**现读设置**（用户实报的另一半 —— 选了 free 模型却不生效）。
 * 真机证据：设置里已改成免费模型，引擎仍打 `fallback: provider=deepseek, model=deepseek-flash`
 * （它手里那份 config.defaultModel 是启动时抄的旧副本）。
 */
describe("FREE-ROUTE：引擎兜底按当前设置算", () => {
  const fallback = { providerId: "deepseek", modelId: "deepseek-flash" };

  it("FREE-ROUTE-6：设置里选了插件模型 ⇒ 就用它、且供应商是插件（不听旧副本）", () => {
    setFreeModelIds(["ling-3.1-flash-free"]);
    const r = resolveModelSelection("ling-3.1-flash-free", ["deepseek", "openai"], fallback);
    expect(r, "设置里选的模型必须赢过引擎的旧副本").toEqual({
      providerId: MANAGED_FREE_MODEL_PROVIDER_ID,
      modelId: "ling-3.1-flash-free",
    });
  });

  it("FREE-ROUTE-7：设置里选了普通供应商的模型 ⇒ 供应商跟着模型走；设置里没有就沿用兜底", () => {
    setFreeModelIds([]);
    const owned = resolveModelSelection("moonshot-v1-32k", ["deepseek", "moonshot"], fallback);
    expect(owned.providerId, "按模型特征认出供应商").toBe("moonshot");
    expect(owned.modelId).toBe("moonshot-v1-32k");

    expect(resolveModelSelection("", ["deepseek"], fallback), "设置为空 ⇒ 原样兜底").toEqual(fallback);
    expect(resolveModelSelection(null, ["deepseek"], fallback)).toEqual(fallback);
    expect(resolveModelSelection("totally-unknown", ["deepseek"], fallback)).toEqual({
      providerId: "deepseek",
      modelId: "totally-unknown",
    });
  });

  it("FREE-ROUTE-8（结构棘轮）：引擎的兜底分支不许再直接返回 config 里那份副本", () => {
    const engine = readFileSync(path.join(root, "src/core/llm/index.ts"), "utf8");
    expect(engine, "兜底要调 resolveModelSelection").toContain("resolveModelSelection(");
    expect(engine, "要现读设置（codem-settings）").toMatch(/resolveModelSelection\(s\?\.model/);
    expect(engine, "日志要标明是现读的（便于真机取证）").toContain("（现读设置）");
  });
});
