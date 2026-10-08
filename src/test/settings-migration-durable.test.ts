/**
 * 设置键迁移：**确认落库成功之后才删源** —— 第 184 波存储审计 S4 的回归判据。
 *
 * ## 缺陷形态（审计原文）
 *
 * `migration.ts` 原来是 `setSetting(newKey, oldData); removeSetting(oldKey);` ——
 * 两次都是"内存即时生效 + **异步**落库"（`settings.ts::writeThrough` 只 `.catch(report)`，
 * `rust-port.ts::config.set` 失败只走 `onFailure`），而删除是**立刻**执行的。
 * 于是复制那条 IPC 失败（`callWithRetry` 重试耗尽 / 磁盘满 / 引擎忙）时**源键已经被删掉**：
 * 键表第一行 `mimo-settings → codem-settings` 就是**整份设置（含 provider 配置）丢失**，
 * 既没有回滚也没有重试（`App.tsx` 每次启动都跑这一段）。
 *
 * ## 判据（本文件守的四条）
 *
 * - S4-A 复制**失败** ⇒ 源键必须还在（且**没有**发出删除命令）；
 * - S4-B 【对照】复制成功 ⇒ 源键被删（否则迁移永远重复、库里两份数据）；
 * - S4-C localStorage 那一路同一条纪律（复制失败不许删 localStorage 源）；
 * - S4-D 端口不支持"确认式写入"时**如实回绝**（不删源），不许退化成"先删了再说"。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setStoragePort } from "../core/storage/port";
import { createFakeStoragePort, type FakeStoragePort } from "./fake-storage-port";

const OLD_KEY = "mimo-settings";
const NEW_KEY = "codem-settings";
const OLD_DATA = JSON.stringify({ mode: "cli", model: "mimo-v2.5-pro", providers: { a: { apiKey: "k" } } });

const seededRow = { key: OLD_KEY, value: OLD_DATA };

function makePort(opts: { failWrites?: boolean } = {}): FakeStoragePort {
  const port = createFakeStoragePort({
    failWrites: opts.failWrites,
    seed: { settings: [seededRow] },
  });
  setStoragePort(port);
  return port;
}

const settingsRows = (port: FakeStoragePort) => port.__table("settings") as Array<Record<string, unknown>>;
const deleteCommands = (port: FakeStoragePort) =>
  port.__writes().filter((w) => w.command === "crud.delete" && (w.params as { table?: string })?.table === "settings");

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  setStoragePort(null);
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("设置键迁移必须「先确认落库、再删源」（第 184 波存储审计 S4）", () => {
  it("S4-A: 复制落库**失败** ⇒ 源键必须还在，且**没有**发过删除命令", async () => {
    const port = makePort({ failWrites: true });
    const { migrateFromLocalStorage } = await import("../core/storage/migration");
    const { getSetting } = await import("../core/storage/settings");

    await migrateFromLocalStorage();

    expect(getSetting(OLD_KEY), "复制没成 ⇒ 源键必须原封不动（修前这里已经被删掉了）").toBe(OLD_DATA);
    expect(
      settingsRows(port).some((r) => r.key === OLD_KEY),
      "库里的源行也必须还在（内存镜像说没了不算）",
    ).toBe(true);
    expect(deleteCommands(port), "复制没确认落库就不许发删除命令（那正是丢数据的那一步）").toEqual([]);
  });

  it("S4-B【对照】: 复制确认落库成功 ⇒ 源键被删（迁移照常完成）", async () => {
    const port = makePort();
    const { migrateFromLocalStorage } = await import("../core/storage/migration");
    const { getSetting, getSettingJSON } = await import("../core/storage/settings");

    await migrateFromLocalStorage();

    expect(getSettingJSON<{ model?: string }>(NEW_KEY, null)?.model, "新键必须有数据").toBe("mimo-v2.5-pro");
    expect(getSetting(OLD_KEY), "复制成功之后源键必须被删（否则每次启动都重复迁移）").toBeNull();
    expect(settingsRows(port).some((r) => r.key === OLD_KEY), "库里的源行也要清掉").toBe(false);
    expect(deleteCommands(port).length, "这一次删除是**该**发的").toBeGreaterThan(0);
  });

  it("S4-C: localStorage 那一路同一条纪律（复制失败不许删 localStorage 源）", async () => {
    localStorage.setItem("mimo-theme", "light");
    makePort({ failWrites: true });
    const { migrateFromLocalStorage } = await import("../core/storage/migration");

    await migrateFromLocalStorage();

    expect(
      localStorage.getItem("mimo-theme"),
      "复制没成 ⇒ localStorage 源必须保留（修前这里已经被清掉了）",
    ).toBe("light");

    // 对照：端口正常时源应当被清掉
    localStorage.setItem("mimo-theme", "light");
    makePort();
    await migrateFromLocalStorage();
    expect(localStorage.getItem("mimo-theme"), "复制成功之后才清 localStorage 源").toBeNull();
  });

  it("S4-D: 端口不支持「确认式写入」时如实回绝（不删源），不许退化成先删了再说", async () => {
    const port = makePort();
    // 模拟"端口没有这个能力"：删掉 setConfirmed
    delete (port.config as { setConfirmed?: unknown }).setConfirmed;
    const { migrateFromLocalStorage } = await import("../core/storage/migration");
    const { getSetting } = await import("../core/storage/settings");

    await migrateFromLocalStorage();

    expect(getSetting(OLD_KEY), "判不了「写进去了没有」⇒ 必须保留源键").toBe(OLD_DATA);
    expect(deleteCommands(port), "没有确认能力时一条删除命令都不该发").toEqual([]);
  });

  /**
   * ★ 第 185 波（复审 I-5）：**`settingsWarmed:false` 这条路径原来在替身上是假的**。
   *
   * 真端口未预热**拒写并返回 false**（`rust-port.ts:859-865` / `:926-934`）；而替身的
   * `set` / `setConfirmed` **不看 warmed**、无条件写内存 + 发 `crud.upsert`、`setConfirmed`
   * 直接返回 `true` ⇒ 同一段迁移在替身上**删源键**、在真机上**保留源键** ——
   * S4 那条数据丢失防线在 CI 里跑的是**相反**的行为（判据保真度问题，不是测试写法问题）。
   */
  it("S4-E: 设置面未预热 ⇒ 拒写 ⇒ 源键必须还在（替身与真端口同形）", async () => {
    const port = createFakeStoragePort({
      seed: { settings: [seededRow] },
      settingsWarmed: false,
    });
    setStoragePort(port);
    const { migrateFromLocalStorage } = await import("../core/storage/migration");

    await migrateFromLocalStorage();

    expect(
      settingsRows(port).some((r) => r.key === OLD_KEY),
      "未预热时复制不可能成功 ⇒ 源键必须原封不动（改前替身返回 true ⇒ 这里被删掉）",
    ).toBe(true);
    expect(
      settingsRows(port).some((r) => r.key === NEW_KEY),
      "未预热不许把新键写进库（那是拿空表覆盖的同一类风险）",
    ).toBe(false);
    expect(deleteCommands(port), "复制未确认 ⇒ 一条删除命令都不该发").toEqual([]);
  });
});
