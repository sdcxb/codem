/**
 * 首次切换时的配置导入契约（P3）。
 *
 * ## 为什么"只导入一次"必须被测试
 *
 * 导入逻辑的触发条件是"Rust 库一个设置都没有"。如果它在每次启动都跑，
 * 那么用户**清空/修改任意设置之后重启，都会被旧库的值覆盖回来** ——
 * 表现出来就是"改了的设置过一会儿自己变回去"，而且只在特定条件下复现，极难排查。
 *
 * 所以这里钉住两件事：
 * 1. 首次（Rust 库为空）→ 从旧库导入；
 * 2. 之后（Rust 库非空）→ **一次都不导入**（旧库连读都不该读）。
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { setStoragePort } from "../core/storage/port";

/** 记录旧库被访问的次数（导入判定的第二步才允许访问它） */
let legacyQueries = 0;
const legacyRows: Array<[string, string]> = [
  ["codem-theme", "dark"],
  ["codem-language", "zh"],
  ["codem-display-mode", "unified"],
];

vi.mock("../core/storage/database", () => ({
  getDatabase: () => {
    legacyQueries++;
    if (legacyRows.length === 0) return { exec: () => [] };
    return {
      exec: () => [{ columns: ["key", "value"], values: legacyRows.map((r) => [...r]) }],
    };
  },
  persistDatabase: () => {},
}));
vi.mock("../core/storage/persist-failure", () => ({
  reportPersistFailure: () => {},
  reportActionFailure: () => {},
}));

function rustPortWith(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  let warmed = false;
  let flushed = 0;
  const config = {
    async warmup() {
      warmed = true;
      return store.size;
    },
    get<T>(key: string, fallback: T): T {
      if (!warmed) return fallback;
      const v = store.get(key);
      return (v === undefined ? fallback : (v as unknown as T)) as T;
    },
    set(key: string, value: unknown) {
      store.set(key, typeof value === "string" ? value : JSON.stringify(value));
    },
    remove(key: string) {
      store.delete(key);
    },
    stats: () => ({ warmed, keys: store.size, pendingWrites: 0, failures: 0 }),
    async flush() {
      flushed++;
    },
  };
  return {
    port: { kind: "rust" as const, engine: {} as never, data: {} as never, config: config as never, append: {} as never },
    store,
    getFlushed: () => flushed,
  };
}

afterEach(() => {
  setStoragePort(null);
  legacyQueries = 0;
  vi.restoreAllMocks();
});

describe("首次切换的配置导入", () => {
  it("IMP-1: Rust 库为空时从旧库导入全部配置，并写入「已导入」标记", async () => {
    const { port, store } = rustPortWith({});
    await (port.config as { warmup: () => Promise<number> }).warmup();
    setStoragePort(port);

    const { importSettingsFromLegacyDb } = await import("../core/storage/bootstrap");
    const n = await importSettingsFromLegacyDb();
    expect(n).toBe(3);
    expect(store.get("codem-theme")).toBe("dark");
    expect(store.get("codem-language")).toBe("zh");
    expect(store.get("codem-display-mode")).toBe("unified");
    // 标记键：保证下次不再导入
    expect(store.has("codem-settings-imported-from-legacy")).toBe(true);
  });

  it("IMP-2: Rust 库已有配置时**一次都不导入**（旧库连读都不读）", async () => {
    const { port } = rustPortWith({ "codem-theme": "light" });
    await (port.config as { warmup: () => Promise<number> }).warmup();
    setStoragePort(port);

    const { importSettingsFromLegacyDb } = await import("../core/storage/bootstrap");
    const n = await importSettingsFromLegacyDb();
    expect(n, "非首次必须完全不导入").toBe(0);
    expect(legacyQueries, "非首次连旧库都不该读（避免覆盖用户后来的修改）").toBe(0);
  });

  it("IMP-3: 端口未预热时不导入（预热前不知道 Rust 库是否为空）", async () => {
    const { port } = rustPortWith({});
    // 刻意不 warmup
    setStoragePort(port);

    const { importSettingsFromLegacyDb } = await import("../core/storage/bootstrap");
    expect(await importSettingsFromLegacyDb()).toBe(0);
    expect(legacyQueries).toBe(0);
  });

  it("IMP-4: 端口不是 rust（未注册 / wasm）时不导入", async () => {
    const { importSettingsFromLegacyDb } = await import("../core/storage/bootstrap");
    setStoragePort(null);
    expect(await importSettingsFromLegacyDb()).toBe(0);

    const { port } = rustPortWith({});
    setStoragePort({ ...port, kind: "wasm" } as never);
    expect(await importSettingsFromLegacyDb()).toBe(0);
    expect(legacyQueries).toBe(0);
  });

  it("IMP-5: 旧库读不到（全新安装）时不报错、不导入", async () => {
    legacyRows.length = 0;
    try {
      const { port, store } = rustPortWith({});
      await (port.config as { warmup: () => Promise<number> }).warmup();
      setStoragePort(port);

      const { importSettingsFromLegacyDb } = await import("../core/storage/bootstrap");
      expect(await importSettingsFromLegacyDb()).toBe(0);
      expect(store.size, "没有可导入的内容时不该凭空造出设置").toBe(0);
    } finally {
      legacyRows.push(["codem-theme", "dark"], ["codem-language", "zh"], ["codem-display-mode", "unified"]);
    }
  });

  it("IMP-6: 导入后必须 flush（否则退出时可能还没落库）", async () => {
    const { port, getFlushed } = rustPortWith({});
    await (port.config as { warmup: () => Promise<number> }).warmup();
    setStoragePort(port);

    const { importSettingsFromLegacyDb } = await import("../core/storage/bootstrap");
    await importSettingsFromLegacyDb();
    expect(getFlushed(), "导入是批量写，必须显式排空队列").toBeGreaterThan(0);
  });
});
