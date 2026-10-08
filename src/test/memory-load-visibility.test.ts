/**
 * `memory.load` 的**可见性口径**（MEM-LOAD-QUIET / MEM-LOAD-VISIBLE）。
 *
 * ## 真机取证（用户直接看到横幅）
 *
 * 装机版 1.16.299 启动后用户界面弹出：
 *
 * > 操作没有生效（memory.load）：没有可用的存储端口（本次既读不到也写不了记忆）。
 * > 该功能本次不可用，请重试或检查日志。
 *
 * 而同一个会话的控制台里是三条：
 *
 * ```
 * [PersistFailure] memory.load 操作失败（第 1 次）：没有可用的存储端口（…）
 * [memory] 迁移推迟（不写标记、不覆盖）：没有可用的存储端口
 * [PersistFailure] memory.load 操作失败（第 2 次）：记忆容器形状不认识（顶层是 object，且没有 entries 字段）
 * ```
 *
 * 第 2 次已经走到"解析容器形状" ⇒ **端口后来就绪了、自动重载也真的跑了**（R2 的修复在真机生效）。
 * 问题在于**第 1 次那次失败已经作为用户可见错误报出、并且不会因为后来成功而撤回**
 * ⇒ 用户看到的是一条**陈旧且不可操作**的横幅（"请重试"是假建议：他什么都做不了，
 * 系统自己就好了）。更要命的是：同区域去重（`App.tsx` 的 `reportedPersistAreas`）
 * 会把**第 2 次那条真正该报的**（形状不认识）挡在门外。
 *
 * ## 口径（修复后）
 *
 * | 情形 | 通道 | 用户看到什么 |
 * | --- | --- | --- |
 * | 端口/预热**还没就绪**（系统自己会重试） | `advisory`（提醒/日志） | 一条"记忆尚未就绪、系统会自动重试"的提醒，**不是**错误 |
 * | 读到过、重试后**仍然**读不出来（形状不认识 / JSON 坏 / 迁移抛出） | `action`（用户可见错误） | 一条**可操作**的错误：是什么、旧数据动没动、能不能回退、去哪里看 |
 *
 * 两条方向相反的纪律同时钉住：
 * - **不许把暂时性的当成错误弹**（MEM-LOAD-QUIET-1）；
 * - **后来成功要撤回先前的记录**（MEM-LOAD-QUIET-2），而**持久的失败一条都不许藏**（MEM-LOAD-VISIBLE-1）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setStoragePort } from "../core/storage/port";
import { createFakeStoragePort, type FakeStoragePort } from "./fake-storage-port";
import { saveMemory } from "../core/storage/settings";
import { getPersistFailures, resetPersistFailures, composePersistAlertText, type PersistFailureDetail } from "../core/storage/persist-failure";
import { MemoryService } from "../core/memory/memory";
import { stripComments } from "./helpers/settings-key-scan";

/** 真机那种存量形状（id-keyed 裸映射）——启动期暂时失败之后必须能正常读出来 */
const LEGACY_ID_KEYED = JSON.stringify({
  "mem-1791424659167-eirq3sf0m": { scope: "project", key: "开发环境:Windows + PowerShell", content: "IDMAP_QUIET_FACT" },
  "mem-1791424659168-4orrzpxyh": { scope: "project", key: "构建签名", content: "IDMAP_QUIET_FACT_2" },
});

/** 真正不认识的形状（端口已就绪也读不出来 ⇒ 结论性失败） */
const GARBAGE_SHAPE = JSON.stringify({ foo: { bar: 1 } });

let port: FakeStoragePort;

function mount(opts: Parameters<typeof createFakeStoragePort>[0] = {}): FakeStoragePort {
  const p = createFakeStoragePort(opts);
  setStoragePort(p);
  return p;
}

/** warp 假端口的配置面（`configWarmed:false` 之后用它把端口"弄就绪"） */
async function warmupDomain(p: FakeStoragePort): Promise<void> {
  await (p as unknown as { configDomain: { warmup(): Promise<unknown> } }).configDomain.warmup();
}

function loadEntry() {
  return getPersistFailures().find((f) => f.area === "memory.load");
}

/**
 * 捕获**界面真正收到的那条 detail**（`codem:persist-failed`）。
 *
 * 只读 `getPersistFailures()` 是不够的：它拿不到 `consequence` / `title` ——
 * 而那两句正是用户看到的"后果/怎么办"（`App.tsx` 的监听器就是拿 detail 去
 * `composePersistAlertText` 的）。这里照同一条路走一遍，断言"横幅上印了什么"。
 */
function captureDetails(): PersistFailureDetail[] {
  const seen: PersistFailureDetail[] = [];
  window.addEventListener("codem:persist-failed", ((ev: Event) => {
    seen.push((ev as CustomEvent).detail as PersistFailureDetail);
  }) as EventListener);
  return seen;
}

/** 用户看到的那句话（与应用里同一个拼装函数、同一份 detail） */
function bannerOf(details: PersistFailureDetail[], area = "memory.load"): string {
  const detail = [...details].reverse().find((d) => d.area === area);
  expect(detail, `界面必须收到 ${area} 的上报`).toBeTruthy();
  return composePersistAlertText(detail!);
}

/** 捕获"撤回"通知（App 用它摘掉横幅） */
function watchWithdrawals(): string[] {
  const withdrawn: string[] = [];
  window.addEventListener("codem:persist-failed-withdrawn", ((ev: Event) => {
    withdrawn.push(((ev as CustomEvent).detail as { area?: string } | undefined)?.area ?? "");
  }) as EventListener);
  return withdrawn;
}

beforeEach(() => {
  resetPersistFailures();
  port = mount();
});

afterEach(() => {
  vi.restoreAllMocks();
  setStoragePort(null);
});

describe("MEM-LOAD-QUIET：启动期的暂时性失败不许弹用户可见错误", () => {
  it("MEM-LOAD-QUIET-1：冷启动（端口未就绪）⇒ 不产生用户可见错误，且系统随后自动恢复", async () => {
    const details = captureDetails();
    port = mount({ configWarmed: false, seed: { memory: [{ id: "default", content: LEGACY_ID_KEYED }] } });
    const svc = new MemoryService();

    // ① fail-closed 本身不变：构造时端口未就绪 ⇒ 读失败（写入照旧被拒）
    expect(svc.getLoadState().ok, "端口未就绪仍不许当成'空库'").toBe(false);

    // ② 但**不许**当成用户可见错误：只能走 advisory（提醒/日志）
    const entry = loadEntry();
    expect(entry, "暂时性失败也要留下可诊断的一条（不许整个吞掉）").toBeTruthy();
    expect(entry!.kind, "端口没就绪是系统自恢复的暂时状态 ⇒ advisory，不是 action/persist").toBe("advisory");
    const banner = bannerOf(details);
    expect(banner, "不许冒充失败（'该功能本次不可用'是假陈述）").not.toContain("该功能本次不可用");
    expect(banner, "要写明系统自己会重试（用户不需要动手）").toMatch(/自动|重试/);

    // ③ 系统随后自动恢复：端口就绪 + 重读（真机上就是 bootstrap 的"端口注册后 reload"）
    await warmupDomain(port);
    svc.reload();
    expect(svc.getLoadState().ok, "端口就绪之后自动重读必须成功").toBe(true);
    expect(svc.listAll({ includePending: true, includeUnscoped: true, showAllProjects: true }), "存量记忆读得出来").toHaveLength(2);
  });

  it("MEM-LOAD-QUIET-1b：不依赖用户点面板（写前惰性重试那条路）也会自动恢复", async () => {
    port = mount({ configWarmed: false, seed: { memory: [{ id: "default", content: LEGACY_ID_KEYED }] } });
    const svc = new MemoryService();
    expect(loadEntry()!.kind).toBe("advisory");

    await warmupDomain(port);
    const added = svc.add({ scope: "platform", key: "恢复后写的", content: "AFTER_QUIET_RECOVERY", source: "manual" });
    expect(added.ok, "端口就绪后写入必须成功（不许被一条陈旧的失败锁死）").toBe(true);
    expect(loadEntry(), "成功之后不许留下陈旧的可见错误").toBeUndefined();
  });

  it("MEM-LOAD-QUIET-2：先失败后成功 ⇒ 撤回先前那条（不留陈旧横幅）", async () => {
    const withdrawn = watchWithdrawals();
    port = mount({ configWarmed: false, seed: { memory: [{ id: "default", content: LEGACY_ID_KEYED }] } });
    const svc = new MemoryService();
    expect(loadEntry(), "第 1 次失败如实留痕").toBeTruthy();

    await warmupDomain(port);
    svc.reload();

    expect(svc.getLoadState().ok).toBe(true);
    expect(loadEntry(), "恢复之后 `memory.load` 不许留在失败表里（那就是陈旧横幅的来源）").toBeUndefined();
    expect(withdrawn, "必须**撤回**（界面据此摘掉横幅）").toContain("memory.load");
  });

  it("MEM-LOAD-QUIET-2b：界面通道——撤回要能摘掉横幅，且同区域去重必须被重置", async () => {
    const { useAppStore } = await import("../store");
    useAppStore.setState({ persistAlerts: [] });
    useAppStore.getState().addPersistAlert({ area: "memory.load", kind: "advisory", message: "记忆尚未就绪（系统会自动重试）" });
    expect(useAppStore.getState().persistAlerts).toHaveLength(1);

    useAppStore.getState().withdrawPersistAlert("memory.load");
    expect(
      useAppStore.getState().persistAlerts.filter((a) => a.area === "memory.load"),
      "撤回之后横幅必须消失",
    ).toHaveLength(0);

    /*
     * App 侧接线（与 `persist-alert-channel.test.ts::ALERT-5` 同一类"通道接线"断言）：
     * `reportedPersistAreas` 是"同一区域只提示一次"的进程内去重 —— 撤回时**必须**把它一起清掉，
     * 否则"先暂时性提醒、后结论性错误"的现场里，**该报的那条会被去重挡掉**。
     */
    const app = stripComments(readFileSync(join(__dirname, "..", "App.tsx"), "utf8"));
    expect(app, "App 必须监听撤回事件").toContain("codem:persist-failed-withdrawn");
    const idx = app.indexOf("onPersistWithdrawn");
    expect(idx, "App 里必须有撤回处理函数").toBeGreaterThan(0);
    const around = app.slice(idx, idx + 900);
    expect(around, "撤回必须把横幅摘掉").toContain("withdrawPersistAlert");
    expect(around, "撤回必须重置同区域去重（否则该报的会被挡掉）").toContain("reportedPersistAreas.delete");
  });
});

describe("MEM-LOAD-VISIBLE：该让用户看到的失败仍然必须可见且可操作", () => {
  it("MEM-LOAD-VISIBLE-1：端口已就绪但形状**仍然**不认识 ⇒ 用户可见错误 + 可操作文案", () => {
    const details = captureDetails();
    saveMemory(GARBAGE_SHAPE);
    const svc = new MemoryService();

    expect(svc.getLoadState().ok, "不认识的形状必须继续 fail-closed").toBe(false);
    const entry = loadEntry();
    expect(entry, "持久的读失败**必须**上报（不许被 QUIET 那条一起藏掉）").toBeTruthy();
    expect(entry!.kind, "端口已就绪、仍然读不出来 ⇒ 这是结论性失败（用户可见错误）").toBe("action");

    const banner = bannerOf(details);
    expect(banner, "要说明**是什么**问题").toMatch(/形状|entries/);
    expect(banner, "要说明旧数据动没动").toMatch(/没有|未被|保持原样/);
    expect(banner, "要说明**能不能回退**（迁移前快照）").toMatch(/回退|快照/);
    expect(banner, "要说明**去哪里看/怎么办**").toMatch(/设置 → 记忆/);
  });

  it("MEM-LOAD-VISIBLE-1b：半截 JSON（解析失败）同样可见、同样可操作", () => {
    const details = captureDetails();
    saveMemory('{"mem-1":{"scope":"project","key":"k"');
    const svc = new MemoryService();
    expect(svc.getLoadState().kind).toBe("parse");
    const entry = loadEntry();
    expect(entry?.kind, "解析失败也是结论性失败").toBe("action");
    const banner = bannerOf(details);
    expect(banner, "要说明是解析/数据损坏").toMatch(/解析|JSON/);
    expect(banner, "要给出可操作去处").toMatch(/设置 → 记忆/);
  });

  it("MEM-LOAD-VISIBLE-2：先暂时性、后结论性 ⇒ 结论性那条必须能显示（先撤回再报）", async () => {
    const withdrawn = watchWithdrawals();
    port = mount({ configWarmed: false, seed: { memory: [{ id: "default", content: GARBAGE_SHAPE }] } });
    const svc = new MemoryService();

    // 第 1 次：端口未就绪 ⇒ 暂时性（advisory）
    expect(loadEntry()!.kind).toBe("advisory");

    // 第 2 次：端口就绪、重读 ⇒ 形状仍不认识 ⇒ 结论性
    await warmupDomain(port);
    svc.reload();

    expect(loadEntry()!.kind, "结论性失败不许被'暂时性那条已经展示过'挡住").toBe("action");
    expect(loadEntry()!.lastMessage).toMatch(/形状|entries/);
    expect(withdrawn, "必须先撤回 advisory，界面才会显示这条该报的错误").toContain("memory.load");
  });
});
