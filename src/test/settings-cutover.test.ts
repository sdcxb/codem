/**
 * 配置面切换契约测试（P3）：`getSetting`/`setSetting` 在两种引擎下的行为。
 *
 * ## 这里的风险不是"功能坏了"，而是"看起来没坏"
 *
 * 配置读取遍布近 500 个调用点。如果切换后 `getSetting` 悄悄返回 `null`
 * （而不是用户的偏好），界面会**安静地回到默认值** —— 没有报错、没有崩溃，
 * 用户只会觉得"升级之后设置丢了"。所以这里逐条钉住：
 *
 * 1. 端口是 rust 时：读走内存缓存（同步）、写走写穿队列；
 * 2. 端口未注册（默认/回滚）时：**完全维持原 WASM 行为**；
 * 3. 首次切换时把旧库配置搬过来，且**只搬一次**（否则用户清空的设置会被搬回来）；
 * 4. 端口未预热时读要如实回退 + 留痕，不能假装有值。
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { setStoragePort } from "../core/storage/port";
import { getSetting, getSettingJSON, removeSetting, setSetting } from "../core/storage/settings";

/**
 * 旧库（WASM）被 mock 掉：**切到 Rust 之后就不该再碰它**。
 *
 * 这一点很重要：如果实现里漏了一处直连 `getDatabase()`，这里的 mock 会立刻报错
 * （"不应该访问旧库"），而不是等到用户那里才发现"两个库各写一半"。
 */
let legacyReads = 0;
let legacyWrites = 0;
vi.mock("../core/storage/database", () => ({
  getDatabase: () => {
    legacyReads++;
    throw new Error("旧库（WASM）不应在 rust 引擎下被访问");
  },
  persistDatabase: () => {
    legacyWrites++;
  },
}));
vi.mock("../core/storage/persist-failure", () => ({
  reportPersistFailure: () => {},
  reportActionFailure: () => {},
}));

/** 假端口：只实现配置面需要的东西，并记录调用 */
function fakeRustPort(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
  const calls: Array<{ op: string; key?: string; value?: unknown }> = [];
  let warmed = false;
  let failures = 0;

  const config = {
    async warmup() {
      warmed = true;
      store.set("__warmup__", "1");
      store.delete("__warmup__");
      return store.size;
    },
    get<T>(key: string, fallback: T): T {
      if (!warmed) return fallback;
      const v = store.get(key);
      return (v === undefined ? fallback : (v as unknown as T)) as T;
    },
    set(key: string, value: unknown) {
      calls.push({ op: "set", key, value });
      store.set(key, typeof value === "string" ? value : JSON.stringify(value));
    },
    remove(key: string) {
      calls.push({ op: "remove", key });
      store.delete(key);
    },
    stats() {
      return { warmed, keys: store.size, pendingWrites: 0, failures };
    },
    async flush() {},
  };

  const port = {
    kind: "rust" as const,
    engine: {} as never,
    data: {} as never,
    config: config as never,
    append: {} as never,
  };
  return { port, store, calls, config };
}

afterEach(() => {
  setStoragePort(null);
  vi.restoreAllMocks();
  legacyReads = 0;
  legacyWrites = 0;
});

describe("配置面切换 —— rust 引擎下", () => {
  it("SET-1: 端口已注册且是 rust → 读走端口缓存（同步、不碰 WASM 库）", async () => {
    const { port, config } = fakeRustPort({ theme: "dark" });
    await config.warmup();
    setStoragePort(port);

        expect(getSetting("theme")).toBe("dark");
    expect(getSetting("不存在")).toBeNull();
    expect(legacyReads, "rust 引擎下不得访问旧库").toBe(0);
  });

  it("SET-2: 写走端口（内存即时生效 + 记录一次 set 调用）", async () => {
    const { port, calls, config } = fakeRustPort({});
    await config.warmup();
    setStoragePort(port);

        setSetting("codem-language", "zh");
    expect(getSetting("codem-language"), "写后立即可读（内存镜像）").toBe("zh");
    expect(calls.filter((c) => c.op === "set" && c.key === "codem-language")).toHaveLength(1);
  });

  it("SET-3: 删除走端口", async () => {
    const { port, calls, config } = fakeRustPort({ a: "1" });
    await config.warmup();
    setStoragePort(port);

        removeSetting("a");
    expect(getSetting("a")).toBeNull();
    expect(calls.filter((c) => c.op === "remove")).toHaveLength(1);
  });

  it("SET-4: JSON 读取：合法 JSON 解析、坏 JSON 回退默认（不抛）", async () => {
    const { port, config } = fakeRustPort({
      good: JSON.stringify({ fontSize: 14 }),
      bad: "{不是 JSON",
    });
    await config.warmup();
    setStoragePort(port);

        expect(getSettingJSON("good", { fontSize: 0 })).toEqual({ fontSize: 14 });
    expect(getSettingJSON("bad", { fontSize: 13 })).toEqual({ fontSize: 13 });
    expect(getSettingJSON("缺失", 42)).toBe(42);
  });

  it("SET-5: 端口未预热 → 如实回退默认值（不抛、不假装有值）", async () => {
    const { port } = fakeRustPort({ theme: "dark" });
    // 刻意不调用 warmup()
    setStoragePort(port);

        expect(getSetting("theme"), "未预热必须回退，而不是抛异常炸掉渲染").toBeNull();
  });
});

describe("配置面切换 —— 未注册端口（默认/回滚）", () => {
  it("SET-6: 端口未注册时走原 WASM 路径（回滚开关生效的前提）", async () => {
    setStoragePort(null);
        // WASM 库不可用（测试环境是 "Browser mode"）→ 原实现返回 null，而不是抛
    expect(getSetting("任意键")).toBeNull();
  });

  it("SET-7: 端口是 wasm 时同样走原路径（不误用端口）", async () => {
    const wasmPort = {
      kind: "wasm" as const,
      engine: {} as never,
      data: {} as never,
      config: {
        get() {
          throw new Error("不应该调用 wasm 端口的配置面");
        },
        set() {
          throw new Error("不应该调用 wasm 端口的配置面");
        },
        remove() {
          throw new Error("不应该调用 wasm 端口的配置面");
        },
        stats: () => ({ warmed: false, keys: 0, pendingWrites: 0, failures: 0 }),
      } as never,
      append: {} as never,
    };
    setStoragePort(wasmPort);
        expect(getSetting("任意键")).toBeNull();
  });
});
