/**
 * 第 215 波判据（用户实报）：
 *
 * > 我刷新了【Our Free Model（免费模型插件）】模型列表选择 ling-3.1-flash-free 并对话，提示执行出错…
 * > 如果失败，为什么刷新还能从列表里刷出来？刷新不应该测一下能否通，是不是真的存在？
 *
 * 事实（已查证）：`catalog.json`（刷新的数据源）只有目录，**没有任何可用性字段**；
 * 插件自己的 `stats.json` 只记**事后**的 calls/failed。所以"刷得出来"从来不等于"能用"。
 *
 * 这一波的判据分两类：
 * ① **行为**（纯函数）：汇总口径、时间戳语义、以及"什么才算上游模型级失败"；
 * ② **结构棘轮**：探测真的带超时与并发上限；两处模型列表真的标注；真实调用失败真的回写。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach } from "vitest";
import {
  HEALTH_TTL_MS,
  clearFreeModelHealth,
  freeModelHealthOf,
  freeModelUnavailableSuffix,
  isFreeModelKnownUnavailable,
  isUpstreamModelFailure,
  markFreeModelAvailable,
  markFreeModelUnavailableFromError,
  recordFreeModelHealth,
  setFreeModelIds,
  summarizeProbe,
} from "../core/free-model-plugin/model-index";

const root = path.resolve(__dirname, "../..");
const service = readFileSync(path.join(root, "src/core/free-model-plugin/service.ts"), "utf8");

beforeEach(() => {
  clearFreeModelHealth();
  setFreeModelIds(["ling-3.1-flash-free", "mimo-v2.6-flash-free"]);
});

describe("AVAIL：模型可用性（第 215 波）", () => {
  it("AVAIL-1：探测汇总口径（纯函数）—— 有几个可用、几个不可用、以及一句人读的话", () => {
    const allOk = summarizeProbe([
      { id: "a", ok: true },
      { id: "b", ok: true },
    ]);
    expect(allOk).toMatchObject({ total: 2, ok: 2, failed: 0, unavailable: [] });
    expect(allOk.text.zh, "全可用时要说全可用").toContain("全部可用");

    const mixed = summarizeProbe([
      { id: "a", ok: true },
      { id: "b", ok: false, error: "Endpoint is unavailable." },
    ]);
    expect(mixed).toMatchObject({ total: 2, ok: 1, failed: 1, unavailable: ["b"] });
    expect(mixed.text.zh, "不可用要报数字").toContain("1/2");
    expect(mixed.text.zh).toContain("1 个当前不可用");
  });

  it("AVAIL-2：可用性结论**带时间戳**，过期一律视为「未知」（上游会恢复，旧结论不许长期劝退）", () => {
    const now = Date.now();
    recordFreeModelHealth("ling-3.1-flash-free", { ok: false, at: now, error: "Endpoint is unavailable." });
    expect(isFreeModelKnownUnavailable("ling-3.1-flash-free", now), "刚检测出的失败要算数").toBe(true);
    expect(freeModelUnavailableSuffix("ling-3.1-flash-free", "zh", now), "并且标注在名字上").toContain("当前不可用");

    const later = now + HEALTH_TTL_MS + 1000;
    expect(freeModelHealthOf("ling-3.1-flash-free", later), "过期 ⇒ 读不到结论").toBeNull();
    expect(isFreeModelKnownUnavailable("ling-3.1-flash-free", later), "过期 ⇒ 不许再说不可用").toBe(false);
    expect(freeModelUnavailableSuffix("ling-3.1-flash-free", "zh", later), "过期 ⇒ 不标注").toBe("");

    markFreeModelAvailable("mimo-v2.6-flash-free");
    expect(isFreeModelKnownUnavailable("mimo-v2.6-flash-free", now + 1000), "成功的模型不许被标不可用").toBe(false);
  });

  it("AVAIL-3：只有**上游模型级失败**才算这个模型不可用（用户自己的网络抖动不许算到模型头上）", () => {
    expect(isUpstreamModelFailure("Provider stream error: Upstream request failed: Endpoint is unavailable.")).toBe(true);
    expect(isUpstreamModelFailure("Your access has been restricted due to repeated policy violations.")).toBe(true);
    expect(isUpstreamModelFailure("Model does not support this protocol.")).toBe(true);
    expect(isUpstreamModelFailure("socket hang up"), "网络抖动不是模型的错").toBe(false);
    expect(isUpstreamModelFailure("invalid api key"), "Key 配错更不是模型的错").toBe(false);

    expect(markFreeModelUnavailableFromError("ling-3.1-flash-free", "socket hang up"), "不该记").toBe(false);
    expect(isFreeModelKnownUnavailable("ling-3.1-flash-free")).toBe(false);
    expect(markFreeModelUnavailableFromError("ling-3.1-flash-free", "Endpoint is unavailable."), "该记").toBe(true);
    expect(isFreeModelKnownUnavailable("ling-3.1-flash-free")).toBe(true);
    /* 不是插件提供的模型（别人的模型）不许被记 */
    expect(markFreeModelUnavailableFromError("gpt-4o", "Endpoint is unavailable.")).toBe(false);
  });

  it("AVAIL-4（结构棘轮）：探测要有超时与并发上限；两处列表要标注；真实失败要回写", () => {
    expect(service, "要有探测实现").toContain("async function probePluginModels");
    expect(service, "每个请求必须有超时（否则卡死的模型会拖住整轮）").toContain("new AbortController()");
    expect(service, "超时要真的接到 fetch 上（不是建个对象摆着）").toMatch(/signal: controller\.signal/);
    expect(service, "并发要有上限").toMatch(/PROBE_CONCURRENCY = \d+/);
    expect(service, "要发最小请求（max_tokens: 1），不是跑真实任务").toContain("max_tokens: 1");
    expect(service, "结果要落盘").toContain("codem-free-model-health");

    const panel = readFileSync(path.join(root, "src/components/SettingsPanel.tsx"), "utf8");
    expect(panel, "设置里的模型列表要标注").toContain("unavailableSuffix");
    const chat = readFileSync(path.join(root, "src/components/ChatPanel.tsx"), "utf8");
    expect(chat, "对话里的模型选择器要标注").toContain("unavailableSuffix");
    const provider = readFileSync(path.join(root, "src/core/llm/provider.ts"), "utf8");
    const card = readFileSync(path.join(root, "src/components/FreeModelPluginCard.tsx"), "utf8");
    expect(card, "落盘失败时界面必须如实说（不许假成功）").toMatch(/summary\.saved\s*\?/);
    expect(provider, "真实调用失败要回写（越用越准，不必只靠手动检测）").toContain(
      "markFreeModelUnavailableFromError(request.model",
    );
  });
});


