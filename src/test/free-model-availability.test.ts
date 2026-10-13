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
  isFreeModelKnownSlow,
  isTimeoutFailure,
  isUpstreamModelFailure,
  markFreeModelSlowFromError,
  markFreeModelAvailable,
  markFreeModelUnavailableFromError,
  recordFreeModelHealth,
  setFreeModelIds,
  shouldAutoProbe,
  summarizeManagedModelList,
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



/**
 * 第 216 波（用户要求：「把"超时也标注"那条也做了」）：
 *
 * 真机实测逼出来的区分 —— `nemotron-3.5-lightning-free` 的 1-token 探测**通过**（2.6s），
 * 但真聊天 **60 秒没答完**。这种情形如果标成"当前不可用"，就是**过度断言**：
 * 用户会永久避开一个其实能用的模型 ✗。所以"慢/超时"必须单独一类、文案也不同。
 */
describe("AVAIL：慢/超时与不可用必须分开（第 216 波）", () => {
  it("AVAIL-5：真实调用超时 ⇒ 标「最近一次调用超时」，**不许**说成「当前不可用」", () => {
    /* 这条用例覆盖三个模型：先把它们放进「插件提供的模型」集合（否则回写会被"不是插件的模型"挡掉） */
    setFreeModelIds(["ling-3.1-flash-free", "mimo-v2.6-flash-free", "nemotron-3.5-lightning-free"]);
    const now = Date.now();
    expect(isTimeoutFailure("Provider stream error: request timed out after 60s"), "超时要认得出来").toBe(true);
    expect(isTimeoutFailure("AbortError: The operation was aborted"), "中止也算超时").toBe(true);
    expect(isTimeoutFailure("Endpoint is unavailable."), "上游说不可用不是超时").toBe(false);

    expect(markFreeModelSlowFromError("nemotron-3.5-lightning-free", "request timed out"), "该记").toBe(true);
    expect(isFreeModelKnownSlow("nemotron-3.5-lightning-free", now), "要能读出「慢」").toBe(true);

    const suffix = freeModelUnavailableSuffix("nemotron-3.5-lightning-free", "zh", now);
    expect(suffix, "要说清楚是超时").toContain("最近一次调用超时");
    expect(suffix, "**不许**说不可用（过度断言）").not.toContain("当前不可用");

    markFreeModelUnavailableFromError("ling-3.1-flash-free", "Upstream request failed: Endpoint is unavailable.");
    expect(freeModelUnavailableSuffix("ling-3.1-flash-free", "zh", now), "不可用照旧").toContain("当前不可用");
    expect(isFreeModelKnownSlow("ling-3.1-flash-free", now), "不可用不算「慢」").toBe(false);

    expect(markFreeModelSlowFromError("mimo-v2.6-flash-free", "socket hang up"), "网络抖动不算超时").toBe(false);
    expect(freeModelUnavailableSuffix("mimo-v2.6-flash-free", "zh", now), "什么都不标").toBe("");
  });

  it("AVAIL-6（结构棘轮）：真实调用要**同时**回写这两类；探测失败记「不可用」；回灌保留类别", () => {
    const provider = readFileSync(path.join(root, "src/core/llm/provider.ts"), "utf8");
    expect(provider, "不可用回写").toContain("markFreeModelUnavailableFromError(request.model");
    expect(provider, "超时回写").toContain("markFreeModelSlowFromError(request.model");
    expect(service, "探测失败记为「不可用」（1 个 token 都要 12 秒 = 不能用）").toMatch(
      /recordFreeModelHealth\(id, \{ ok: false, at: Date\.now\(\), reason: "unavailable"/,
    );
    expect(service, "回灌必须保留 reason（否则重启后「超时」会被读成「不可用」）").toMatch(
      /recordFreeModelHealth\(id, \{ ok: !!entry\.ok, at: entry\.at, reason: entry\.reason/,
    );
  });
});

/**
 * 第 218 波（用户实报）：
 * > 选择 ling-3.1-flash-free 模型，还是报错，既然不行为什么设置里刷新模型的时候，还是会出现这个模型
 *
 * 口径修正：**只标注不够** —— 已知不可用的免费模型必须**从列表里拿掉**（别让用户再踩一次），
 * 但**当前选中的那个要留着**（并带「当前不可用」后缀），否则用户不知道自己在用什么 ✗；
 * 而且隐藏必须**如实说出来**（静默消失比看到不可用的模型更糟 —— 用户会以为模型丢了）。
 */
describe("AVAIL：已知不可用的模型要从列表里消失（第 218 波）", () => {
  const panel = readFileSync(path.resolve(__dirname, "../components/SettingsPanel.tsx"), "utf8");
  const chat = readFileSync(path.resolve(__dirname, "../components/ChatPanel.tsx"), "utf8");

  it("AVAIL-7：两处列表都要**过滤掉**已知不可用的（当前选中的除外）", () => {
    expect(panel, "设置里的模型列表要过滤").toMatch(
      /isUnavailable\(m\.id\)[\s\S]{0,120}?\.map\(/,
    );
    expect(panel, "当前选中的那个要留着（否则用户不知道在用哪个）").toMatch(
      /filter\(\(m\) => m\.id === settings\.model \|\| !freeModelPlugin\.models\.isUnavailable\(m\.id\)\)/,
    );
    expect(chat, "对话里的模型选择器也要过滤").toMatch(
      /filter\(\(m\) => m\.id === model \|\| !freeModelPlugin\.models\.isUnavailable\(m\.id\)\)/,
    );
  });

  it("AVAIL-8：隐藏必须**如实说明**（不许静默消失）", () => {
    expect(panel, "要告诉用户隐藏了几个").toMatch(/已隐藏 \$\{hidden\} 个当前不可用的免费模型/);
    expect(panel, "并给出刷新结论的入口").toContain("检测可用性");
  });

  it("AVAIL-9（反向对照）：过期结论不许继续隐藏（上游恢复了模型要自己回来）", () => {
    /* 隐藏依赖 isUnavailable ⇒ 它依赖 freeModelHealthOf 的 TTL ⇒ 过期即 false（AVAIL-2 已钉住） */
    const now = Date.now();
    setFreeModelIds(["ling-3.1-flash-free"]);
    markFreeModelUnavailableFromError("ling-3.1-flash-free", "Endpoint is unavailable.");
    expect(isFreeModelKnownUnavailable("ling-3.1-flash-free", now), "刚失败 ⇒ 隐藏").toBe(true);
    expect(isFreeModelKnownUnavailable("ling-3.1-flash-free", now + HEALTH_TTL_MS + 1), "过期 ⇒ 放回来").toBe(false);
  });
});


/**
 * 第 219 波（用户实报：升级到 314 后「刷新模型列表」**还是**列出 25 个，不能用的照样出现）：
 *
 * 我上一波只给"插件目录"那条渲染分支加了过滤 ✗，而**刷新之后**模型来自
 * `dynamicModels` 那条分支 ⇒ 过滤被绕过（用户看到的就是这条）。
 *
 * 教训落成判据：**同一个口径必须在所有渲染模型选项的地方生效** ——
 * 设置面板里至少有三条分支（插件目录 / 刷新后的 dynamicModels / 内置兜底），
 * 每条都要过滤 + 带后缀；少一条，用户就还能看到"刷得出来但不能用"的模型 ✗。
 */
describe("AVAIL：所有渲染模型选项的分支都要同一口径（第 219 波）", () => {
  const panel = readFileSync(path.resolve(__dirname, "../components/SettingsPanel.tsx"), "utf8");

  it("AVAIL-10：三条分支都要过滤（插件目录 / 刷新后的 dynamicModels / 内置兜底）", () => {
    /* 三条分支的写法本来就不同（单行/多行），所以按**过滤调用**计数，而不是某种固定写法 */
    const filters = panel.match(/models\.isUnavailable\(m\.id\)/g) ?? [];
    expect(filters.length, "至少三条渲染分支都要有这条过滤（少一条就会漏出刷得出来但不能用的模型）").toBeGreaterThanOrEqual(3);
    /* 刷新后的那条分支（dynamicModels）单独点名：用户实报的就是它 */
    const dynStart = panel.indexOf("orderModelsByHealth(p.id, dynModels)");
    const dynBranch = panel.slice(dynStart, dynStart + 1600);
    expect(dynStart, "找不到刷新后的 dynamicModels 分支").toBeGreaterThan(0);
    expect(dynBranch, "该分支必须过滤掉已知不可用的免费模型").toContain(".filter(");
    expect(dynBranch, "过滤条件要看可用性").toContain("isUnavailable(m.id)");
    expect(panel, "并且要带可用性后缀（慢/超时与不可用分开）").toMatch(
      /isFreeModelId\(m\.id\) \? freeModelPlugin\.models\.unavailableSuffix\(m\.id/,
    );
  });
});


/**
 * 第 220 波（用户实报：升级到 314 后点「刷新模型列表」**还是**列出 25 个、不能用的照样出现）：
 *
 * 根因是**设计缺口**而不是渲染漏了 —— 可用性结论只由「检测可用性」或真实调用失败产生，
 * 而过期（>30 分钟）就一律当"未知" ⇒ **刷新之后如果没人测，列表就是错的** ✗。
 * 用户的期待是"刷新完就该反映真实可用性" ⇒ 所以：**刷新完在后台自动测一遍**、**启动时结论过期也自动测**。
 */
describe("AVAIL：过期就自动补测（第 220 波）", () => {
  it("AVAIL-11（纯函数）：没有结论 / 结论过期 ⇒ 该自动测；结论新鲜 ⇒ 不重复测", () => {
    const now = Date.now();
    expect(shouldAutoProbe({}, now), "从没测过 ⇒ 该测").toBe(true);
    expect(shouldAutoProbe({ a: { ok: true, at: now - 1000 } }, now), "刚测过 ⇒ 不重复测").toBe(false);
    expect(
      shouldAutoProbe({ a: { ok: false, at: now - HEALTH_TTL_MS - 1 } }, now),
      "结论过期 ⇒ 该测（这正是用户遇到的：昨天测过、今天列表还是错的）",
    ).toBe(true);
  });

  it("AVAIL-12（结构棘轮）：刷新（托管供应商）与启动都要触发它，且**不许阻塞**", () => {
    const panel = readFileSync(path.resolve(__dirname, "../components/SettingsPanel.tsx"), "utf8");
    const app = readFileSync(path.resolve(__dirname, "../App.tsx"), "utf8");
    expect(panel, "刷新后要自动补测").toMatch(/if \(isManagedFreeModel\) \{[\s\S]{0,200}?autoProbeIfStale\(/);
    expect(panel, "补测完要让界面重渲染（否则列表不会更新）").toMatch(/autoProbeIfStale\(\(\) => \{[\s\S]{0,200}?setDynamicModels\(/);
    expect(panel, "**不许** await（刷新按钮不能卡住）").not.toMatch(/await freeModelPlugin\.models\.autoProbeIfStale/);
    expect(app, "启动时也要补测（结论过期的情况）").toContain("autoProbeIfStale()");

    const service = readFileSync(path.resolve(__dirname, "../../src/core/free-model-plugin/service.ts"), "utf8");
    expect(service, "并发只允许一个自动探测（否则刷新连点会打爆上游）").toMatch(/if \(autoProbeInFlight\) return false;/);
    expect(service, "自动探测失败只记日志（后台自检不该弹错误）").toMatch(/console\.warn\([\s\S]{0,120}?后台自动检测可用性失败/);
  });
});



/**
 * 第 221 波（用户实报：清单里过滤了，但刷新提示还写着「✓ 获取到 25 个模型」）：
 * 提示必须和**列表里真实可见的数量**一致 —— 只报"拉回来多少"是误导。
 */
describe("AVAIL：刷新提示要和列表里可见的数量一致（第 221 波）", () => {
  const panel = readFileSync(path.resolve(__dirname, "../components/SettingsPanel.tsx"), "utf8");

  it("AVAIL-13（纯函数）：汇总口径 = 总数 / 隐藏数 / 可见数（当前选中的不算隐藏）", () => {
    const models = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const bad = (id: string) => id === "b" || id === "c";
    expect(summarizeManagedModelList(models, bad), "两个不可用都被藏起来").toEqual({ total: 3, hidden: 2, visible: 1 });
    expect(summarizeManagedModelList(models, bad, "b"), "当前选中的那个不算隐藏（它要留着）").toEqual({
      total: 3,
      hidden: 1,
      visible: 2,
    });
    expect(summarizeManagedModelList(models, () => false), "都可用 ⇒ 隐藏 0").toEqual({ total: 3, hidden: 0, visible: 3 });
  });

  it("AVAIL-14（结构棘轮）：刷新提示要用这个口径，且后台测完要刷新提示里的数字", () => {
    expect(panel, "提示要报总数").toContain("✓ 获取到 ${s.total} 个模型");
    expect(panel, "并且要报隐藏了几个（不能只报拉回来多少）").toMatch(/已隐藏 \$\{s\.hidden\} 个当前不可用的（可见 \$\{s\.visible\} 个）/);
    expect(panel, "后台测完要刷新提示").toMatch(/autoProbeIfStale\(\(\) => \{[\s\S]{0,300}?setRefreshStatus/);
  });
});


