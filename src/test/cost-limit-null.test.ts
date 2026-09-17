/**
 * 成本上限的 `null` 哨兵：**"清空输入框"必须真的等于"不限"，并且能活过重启**
 * （第 45 轮设置审计 D-12 的引擎侧那一半）。
 *
 * ## 守的是什么
 *
 * 设置页把输入框清空时的语义是"不限"。原来类型是 `number | undefined`，而 `undefined`
 * 的**自有属性会被 `JSON.stringify` 丢掉** —— 落库对象里根本没有这个键，重启时与默认值
 * merge（`{...DEFAULT_CONFIG.limits, ...saved}`）→ **$5 上限复活**，而界面刚显示过"已保存"。
 *
 * 真机上要发现它得走"清空 → 重启 → 看上限又回来"三步，很容易漏，所以两半都要钉住：
 * ① UI 侧写出的载荷里**有**这个键且值为 `null`（`settings-dead-keys` 的 SKEY-D12-1）；
 * ② `CostTracker` 读回来时 `null` **不被默认值顶掉**（本文件）。
 *
 * 类型层面也必须诚实：`CostTrackerConfig["limits"]` 三个字段都是 `number | null` 之后，
 * 设置页写 `null` 不再需要 `as any` 绕过类型系统 —— 那条 `as any` 正是缺陷能长期隐身的原因。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createFakeStoragePort } from "./fake-storage-port";
import { setStoragePort, type StoragePort } from "../core/storage/port";
import { setSetting, setSettingJSON, getSetting } from "../core/storage/settings";

const KEY = "codem-cost-limits";

beforeEach(() => {
  setStoragePort(createFakeStoragePort() as unknown as StoragePort);
});

describe("成本上限的 null 哨兵（清空 = 不限，且活过重启）", () => {
  it("CLN-1: 写出去的 JSON 里**必须有** `perSession: null` 这个键", () => {
    setSettingJSON(KEY, { perSession: null, perDay: 20 });

    const raw = getSetting(KEY);
    expect(raw, "键必须落库（否则重启后连读都读不到）").toBeTruthy();
    expect(
      raw,
      "`null` 的键必须留在 JSON 里 —— 键消失就等于重启后默认上限复活（D-12 的病灶）",
    ).toContain('"perSession":null');
    expect(JSON.parse(String(raw)).perDay, "同一次写入里的别的键不受影响").toBe(20);
  });

  it("CLN-2: 重启（新实例从库里读回）后仍是 `null` —— 默认 $5 不许复活", async () => {
    setSettingJSON(KEY, { perSession: null, perDay: 20 });

    const { CostTracker } = await import("../core/llm/cost-tracker");
    const tracker = new CostTracker();
    const limits = tracker.getLimits();

    expect(limits.perSession, "清空过就是 null，不能被 DEFAULT_CONFIG 的 $5 顶回去").toBeNull();
    expect(limits.perDay).toBe(20);
  });

  it("CLN-3: 从未配置过时默认值仍然生效（别把守卫修成「永远不限」）", async () => {
    const { CostTracker } = await import("../core/llm/cost-tracker");
    const tracker = new CostTracker();
    const limits = tracker.getLimits();

    expect(limits.perSession, "从未配置时应是默认 $5").toBe(5);
    expect(limits.perDay).toBe(20);
  });

  it("CLN-4: 把上限改回具体数字时照常生效（哨兵不吞正常值）", async () => {
    setSettingJSON(KEY, { perSession: null });
    const { CostTracker } = await import("../core/llm/cost-tracker");
    const tracker = new CostTracker();
    tracker.setLimits({ perSession: 12.5 });

    expect(getSetting(KEY), "库里应当是新值").toContain('"perSession":12.5');
    expect(new CostTracker().getLimits().perSession).toBe(12.5);
  });

  it("CLN-5: `setSetting` 写裸串（旧形态）时也要能读回来 —— 不许为了新哨兵打断老值", async () => {
    // 模拟老库里那三个字段本来就是裸 JSON（历史上写入形态不止一种）
    setSetting(KEY, JSON.stringify({ perDay: 7 }));
    const { CostTracker } = await import("../core/llm/cost-tracker");
    const limits = new CostTracker().getLimits();
    expect(limits.perDay).toBe(7);
    expect(limits.perSession, "老值里没有这个键 → 落回默认").toBe(5);
  });
});
