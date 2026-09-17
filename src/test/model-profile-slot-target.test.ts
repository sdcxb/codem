/**
 * 模型档案的槽位更新必须打到**正在编辑的那个档案**（第 45 轮设置审计 D-6）。
 *
 * ## 缺陷形态（两种，第二种是数据错误）
 *
 * `updateSlot(slot, config)` 原来按 `this.activeProfileId` 定位，而"激活的档案"与
 * "正在编辑的档案"是两个不同的东西 —— `ModelProfilePanel` 进入编辑态只设 `editingProfileId`，
 * 不切换激活档案：
 *
 * 1. 激活的是内置 `default`（全新安装就是这样）→ 返回 `false`，编辑**静默消失**（调用方忽略返回值）；
 * 2. 激活的是另一个自建档案 A，用户在 B 上编辑 → **改动落到 A 并 `save()` 落盘**，界面却显示 B。
 *
 * 所以判据必须落在**落库内容**上：改完 B 之后，B 变了、A 没变、`default` 没变。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createFakeStoragePort } from "./fake-storage-port";
import { setStoragePort, type StoragePort } from "../core/storage/port";
import { getSetting, setSettingJSON } from "../core/storage/settings";

const KEY = "codem-model-profiles";

/** 造一个"两个自建档案 + 内置 default"的库，并让 A 处于激活态 */
function seed(activeId: string): void {
  setStoragePort(createFakeStoragePort() as unknown as StoragePort);
  setSettingJSON(KEY, {
    activeProfileId: activeId,
    profiles: [
      { id: "default", name: "默认", description: "", isBuiltIn: true, enabled: true, slots: {} },
      { id: "A", name: "档案 A", description: "", isBuiltIn: false, enabled: true, slots: {} },
      { id: "B", name: "档案 B", description: "", isBuiltIn: false, enabled: true, slots: {} },
    ],
  });
}

async function manager() {
  const mod = await import("../core/llm/model-profile");
  /*
   * 每个用例一个**新实例**：`getModelProfileManager()` 返回的是模块级单例，
   * 用例之间会通过它的内存状态串味（实测：前一条用例写的槽位会出现在后一条的断言里）。
   * 这里刻意不用单例 —— 要测的是"槽位写到哪个档案"，不是单例的生命周期。
   */
  return new mod.ModelProfileManager();
}

function stored(path: "A" | "B" | "default"): Record<string, unknown> {
  const raw = JSON.parse(String(getSetting(KEY)));
  const p = (raw.profiles as Array<Record<string, unknown>>).find((x) => x.id === path);
  return (p?.slots ?? {}) as Record<string, unknown>;
}

beforeEach(() => {
  setStoragePort(null);
});

describe("模型档案：编辑槽位必须打到被编辑的那个档案", () => {
  it("MP-1: 激活 A、编辑 B → 只有 B 落盘（A 与 default 都不许被动到）", async () => {
    seed("A");
    const m = await manager();
    /*
     * ⚠️ 判据不能写 `A === {}` / `default === {}`：内置 `default` 本来就带一个 `vision` 槽位
     * （`BUILTIN_PROFILES` 的定义），写死空对象会把"内置默认值"误判成"被改过"。
     * 正确的判据是"**与改动前逐字一致**"——所以先取基线。
     */
    const beforeA = JSON.stringify(stored("A"));

    const ok = m.updateSlot("chat", { model: "deepseek-v4-pro" } as never, "B");
    expect(ok, "对自建档案的编辑必须成功").toBe(true);

    expect(stored("B").chat, "改动必须落在被编辑的档案 B 上").toMatchObject({ model: "deepseek-v4-pro" });
    expect(JSON.stringify(stored("A")), "激活档案 A 不许被顺带改写（这正是原来的数据错误）").toBe(beforeA);
    /*
     * 内置 `default` **会**在每次 load 时被代码里的定义刷新（`ModelProfileManager.load()`
     * 的注释写着这就是设计："built-in profiles may have been updated — always use latest
     * built-in definitions"）。所以对它的判据不是"与种子逐字一致"，而是"等于代码里的内置定义"
     * —— 顺带证明这次更新没有把别的东西塞进内置档案。
     */
    expect(stored("default"), "内置档案只应等于代码里的定义（含它的 vision 槽位）").toEqual({
      vision: { provider: "deepseek", model: "deepseek-v4-flash-vision-exp" },
    });
  });

  it("MP-2: 激活内置 default、编辑 B → 必须成功（原来会静默失败）", async () => {
    seed("default");
    const m = await manager();

    const ok = m.updateSlot("chat", { model: "gpt-4o" } as never, "B");
    expect(ok, "内置档案被激活不该让别人的编辑失败").toBe(true);
    expect(stored("B").chat).toMatchObject({ model: "gpt-4o" });
  });

  it("MP-3: 编辑**内置档案本身** → 仍然拒绝（内置档案不可改，语义不变）", async () => {
    seed("A");
    const m = await manager();
    expect(m.updateSlot("chat", { model: "x" } as never, "default"), "内置档案必须不可编辑").toBe(false);
    expect(stored("default")).toEqual({});
  });

  it("MP-4: 不传 profileId 时保持既有语义（默认作用于激活档案）", async () => {
    seed("A");
    const m = await manager();
    expect(m.updateSlot("chat", { model: "legacy-call" } as never)).toBe(true);
    expect(stored("A").chat, "老调用点（不传 id）仍作用于激活档案").toMatchObject({ model: "legacy-call" });
    expect(stored("B")).toEqual({});
  });

  it("MP-5: 传一个不存在的档案 id → 返回 false（不写任何东西）", async () => {
    seed("A");
    const m = await manager();
    expect(m.updateSlot("chat", { model: "x" } as never, "no-such")).toBe(false);
    expect(stored("A")).toEqual({});
    expect(stored("B")).toEqual({});
  });
});
