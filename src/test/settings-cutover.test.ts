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
 * 2. 端口未注册时：**不抛、如实给默认值**（旧库路径已随 L4 删除，见下方说明）；
 * 3. 端口未预热时读要如实回退 + 留痕，不能假装有值。
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { setStoragePort } from "../core/storage/port";
import { getSetting, getSettingJSON, removeSetting, setSetting } from "../core/storage/settings";

/**
 * 用 `legacyReads` / `legacyWrites` 两个计数器守"rust 引擎下不得访问旧库"。
 *
 * 它已经**不再是证据**，所以删掉：
 *
 * 1. `settings.ts` 现在只 import `./port` 与 `./domain-store` —— 全仓没有任何模块
 *    再 import `storage/database`，那个 mock 永远不会被触发，
 *    `expect(legacyReads).toBe(0)` 因此恒真（`legacyWrites` 甚至从没被断言过）；
 * 2. 更重要的是：`vi.mock` 指向的**模块本身会随引擎一起删除** ——
 *    留着一个指向不存在模块的 mock，下一步删引擎时整个文件会直接报"模块找不到"。
 *
 * 契约没有丢：下面每条用例都断言**端口侧的可观测效果**
 * （读到缓存值 / `set` 被调用一次 / 未预热回退默认值），这些是真的会咬的判据。
 */
vi.mock("../core/storage/persist-failure", () => ({
  reportPersistFailure: () => {},
  reportActionFailure: () => {},
  // 第 90 轮：通道新增的第三种语气也必须 mock —— 漏一个就会让被测代码抛
  // TypeError，而那个异常会被生产代码的 catch 吞掉（换成"看起来像守卫判错"的假象）
  reportAdvisory: () => {},
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
});

describe("配置面切换 —— rust 引擎下", () => {
  it("SET-1: 端口已注册且是 rust → 读走端口缓存（同步、不碰旧库）", async () => {
    const { port, config } = fakeRustPort({ theme: "dark" });
    await config.warmup();
    setStoragePort(port);

        expect(getSetting("theme")).toBe("dark");
    expect(getSetting("不存在")).toBeNull();
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

describe("配置面切换 —— 未注册端口（默认/回滚已退役）", () => {
  it("SET-6: 端口未注册时读路径不抛、如实给默认值（旧库路径已删）", async () => {
    setStoragePort(null);
    /*
     * 这条用例原来叫"走原 WASM 路径（回滚开关生效的前提）"：那时端口未注册 =
     * 回滚到旧库，`getSetting` 会去读 WASM 库，测试环境（Browser mode）读出 null。
     *
     * 回滚开关与旧库路径都已删除，现在端口未注册就是**没有配置源**：
     * 正确行为是"不抛、给默认值"（旧实现会抛，把一次读变成整块界面崩）。
     * 断言本身（返回 null 而不是抛）没变，变的是它现在守的语义 —— 更严格了。
     */
    expect(getSetting("任意键")).toBeNull();
  });

  /**
   * 第 19 轮：这里原来还有一条 SET-7（`kind: "wasm"` 的端口里 config 面全是 `throw`，
   * 断言 `getSetting` 返回 null）——它守的是"别误用 wasm 端口的配置面"。
   *
   * 第 19 轮：wasm 端口形态已不存在（旧引擎删除），而 `kind` 收成常量后 `rustConfig()`
   * 只剩"端口在不在"一条判据：**端口在就必定用它的配置面**（不再有"看着像端口、
   * 实际不该用"的中间形态），所以那条断言已无对应代码路径，直接删除。
   * 真正有意义的"未预热不误用"由上面 SET-5 守着（`configWarmed:false`）。
   */
});
