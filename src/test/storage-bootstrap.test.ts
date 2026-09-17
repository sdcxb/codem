/**
 * 存储启动引导契约测试（P3）：回滚开关必须真的能回滚，失败必须真的被上报。
 *
 * ## 为什么这两条最要紧
 *
 * 迁移期最大的风险不是"Rust 有 bug"，而是**出事时退不回去**、以及**出事时没人知道**：
 * - 回滚开关如果读不到（比如它自己被存在了坏掉的数据库里），
 *   那么"数据库打不开"→"开关读不出"→"继续用打不开的数据库"，形成死锁；
 * - 启动失败如果只是 `catch {}`，界面看起来一切正常，实际所有写入都在静默丢失（B 类假成功）。
 *
 * 所以这里逐条验证：开关优先级、幂等、失败上报、以及**不注册半死的端口**。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getStoragePort, hasStoragePort, setStoragePort } from "../core/storage/port";
import { registerRustStoragePort, shutdownRustStoragePort } from "../core/storage/bootstrap";
import type { StorageTransport } from "../core/storage/rust-port";

/**
 * 历史回滚开关的键名（**第 18 轮：没有任何代码读它**）。
 *
 * 这个字符串常量以前从 `port.ts` 导出（`STORAGE_ENGINE_KEY`），那个导出已随开关一起删除。
 * 本文件仍然需要它 —— 用来验证"老安装残留下来的这个键**不影响任何行为**"，
 * 所以在这里就地声明，并注明它已经不属于产品代码。
 */
const LEGACY_ENGINE_KEY = "codem-storage-engine";

/** 记录所有上报（不依赖真实的上报通道实现） */
const reported: Array<{ scope: string; note: string; error: unknown }> = [];

vi.mock("../core/storage/persist-failure", () => ({
  reportActionFailure: (scope: string, error: unknown, note: string) => {
    reported.push({ scope, note, error });
  },
  reportPersistFailure: (scope: string, error: unknown, note: string) => {
    reported.push({ scope, note, error });
  },
}));

function makeTransport(overrides: Partial<StorageTransport> = {}): StorageTransport {
  return {
    invokeCommand: async (command: string) => {
      if (command === "settings.get_all") return { ok: true, result: { theme: "dark" } } as never;
      return { ok: true, result: { written: 1 } } as never;
    },
    invokeBatch: async () => ({ ok: true, result: { count: 0, results: [] } }) as never,
    health: async () =>
      ({
        ok: true,
        result: {
          ready: true,
          path: "C:/tmp/rust.bin",
          size_bytes: 4096,
          journal_mode: "wal",
          wal_size_bytes: 0,
          tables: 45,
          fts_module: "fts5",
          last_error_code: null,
        },
      }) as never,
    integrityCheck: async () => ({ ok: true, result: { ok: true, detail: "ok" } }) as never,
    checkpoint: async () => ({ ok: true, result: { ok: true } }) as never,
    capabilities: async () => ({ commands: [] }) as never,
    ...overrides,
  };
}

beforeEach(() => {
  reported.length = 0;
  setStoragePort(null);
  globalThis.localStorage?.clear();
});

afterEach(() => {
  setStoragePort(null);
  vi.restoreAllMocks();
});

describe("存储引导 —— 回滚开关（已彻底退役：连「选择引擎」这件事都不存在了）", () => {
  it("BOOT-1: 端口是唯一实现 —— 残留的 localStorage 开关值不影响任何行为", async () => {
    /**
     * 第 18 轮：`selectedEngine()` / `DEFAULT_ENGINE` / `LEGACY_ENGINE_KEY` 三个符号已删除。
     * 它们的存在本身就在暗示"还有另一种引擎可选"，而旧引擎（sql.js）已经整体删除、
     * 依赖与 wasm 资源都不在了 —— 留着一个恒返回 `"rust"` 的函数只会误导。
     *
     * 这条用例改成验证**真正重要的那件事**：老安装留下的键**不会影响任何行为**。
     */
    localStorage.setItem(LEGACY_ENGINE_KEY, "wasm");
    const r = await registerRustStoragePort(makeTransport());
    expect(r.kind, "残留的旧开关值不得阻止端口注册").toBe("registered");
    expect(hasStoragePort()).toBe(true);
    expect(getStoragePort().kind).toBe("rust");
  });

  it("BOOT-2: 回滚开关已退役 —— 写 wasm 也仍然注册 rust 端口", async () => {
    /**
     * 第 15 轮（v1.16.62）：旧引擎已从渲染进程移除，回滚开关**不再被读取**。
     * 这条用例从前断言「写 wasm 就跳过注册」；现在那样的行为只会制造一个**假的**安全感
     * ——用户以为切回去还能用，实际切过去没有任何引擎可用。
     * 所以契约改成：**任何 localStorage 取值都不影响引擎选择**，端口照常注册。
     */
    localStorage.setItem(LEGACY_ENGINE_KEY, "wasm");
    const r = await registerRustStoragePort(makeTransport());
    expect(r.kind, "开关退役后必须照样注册端口").toBe("registered");
    expect(hasStoragePort(), "端口必须已注册").toBe(true);
    expect(getStoragePort().kind).toBe("rust");
    expect(reported, "这不是失败，不该上报错误").toEqual([]);
  });

  it("BOOT-3: 注册端口并预热配置（开关已退役，取值不再影响结果）", async () => {
    localStorage.setItem(LEGACY_ENGINE_KEY, "rust");
    const r = await registerRustStoragePort(makeTransport());
    expect(r.kind).toBe("registered");
    if (r.kind === "registered") {
      expect(r.opened, "首次注册必须标记为真的打开了引擎").toBe(true);
      expect(r.health?.ready).toBe(true);
      expect(r.health?.tables).toBe(45);
    }
    expect(hasStoragePort()).toBe(true);
    expect(getStoragePort().kind).toBe("rust");
  });

  it("BOOT-4: 开关值非法也不影响启动（已退役：没有任何代码读它）", async () => {
    localStorage.setItem(LEGACY_ENGINE_KEY, "postgres");
    const r = await registerRustStoragePort(makeTransport());
    expect(r.kind, "非法取值既不阻止注册、也不改变结果").toBe("registered");
    expect(getStoragePort().kind).toBe("rust");
  });

  it("BOOT-5: localStorage 抛异常时启动照常（不能因为一个没人读的键把启动搞挂）", async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("SecurityError: localStorage 被禁用");
      },
    });
    try {
      const r = await registerRustStoragePort(makeTransport());
      expect(r.kind, "localStorage 不可用与存储引擎无关，注册必须照常完成").toBe("registered");
      expect(getStoragePort().kind).toBe("rust");
    } finally {
      if (original) Object.defineProperty(globalThis, "localStorage", original);
    }
  });
});

describe("存储引导 —— 失败必须可见、且不注册半死端口", () => {
  it("BOOT-6: 引擎打不开时上报 + 不注册端口（否则调用方以为有后端，实际全静默失败）", async () => {
    localStorage.setItem(LEGACY_ENGINE_KEY, "rust");
    const t = makeTransport({
      invokeCommand: async (command: string) => {
        if (command === "settings.get_all") {
          return { ok: false, error: { code: "CORRUPT", message: "库损坏", retryable: false } } as never;
        }
        return { ok: true, result: {} } as never;
      },
    });
    const r = await registerRustStoragePort(t);
    expect(r.kind).toBe("failed");
    expect(hasStoragePort(), "半死的端口绝不能注册").toBe(false);
    /**
     * 第 18 轮：文案从"已保持 WASM 数据库"改成"本进程没有可用存储"——
     * 旧引擎已经不存在，引擎起不来就是**没有存储**，不该再暗示"退回 WASM"。
     * 这里同时钉住"失败必须如实上报"（这才是本条用例的本意）。
     */
    expect(reported.length).toBe(1);
    expect(reported[0].note).toContain("没有可用存储");
  });

  it("BOOT-7: IPC 通道整个炸了也要被包住并上报", async () => {
    localStorage.setItem(LEGACY_ENGINE_KEY, "rust");
    const t = makeTransport({
      invokeCommand: async () => {
        throw new Error("IPC 桥不可用");
      },
    });
    const r = await registerRustStoragePort(t);
    expect(r.kind).toBe("failed");
    expect(reported.length).toBe(1);
  });

  it("BOOT-8: 重复注册是幂等的（StrictMode 双调用 / 热重载）", async () => {
    localStorage.setItem(LEGACY_ENGINE_KEY, "rust");
    const t = makeTransport();
    const first = await registerRustStoragePort(t);
    const second = await registerRustStoragePort(t);
    expect(first.kind).toBe("registered");
    expect(second.kind).toBe("registered");
    // 第二次必须明确标出"没有重新打开"：调用方据此决定**不要**读 health
    // （早先复用分支返回 `health:{ready:true}` 且没有 opened 标记，
    //   启动日志于是打印出 "undefined（undefined 表）" —— 真机验证时抓到）
    if (second.kind === "registered") {
      expect(second.opened, "复用分支必须 opened:false").toBe(false);
      expect(second.health, "复用分支不应给 health 快照").toBeUndefined();
    }
    expect(reported).toEqual([]);
  });

  it("BOOT-9: 已注册为 wasm 却要求 rust 时如实上报（不悄悄替换端口）", async () => {
    localStorage.setItem(LEGACY_ENGINE_KEY, "rust");
    // 模拟启动顺序错乱：WASM 端口已经先注册了
    setStoragePort({
      kind: "wasm",
      engine: {} as never,
      data: {} as never,
      config: {} as never,
      append: {} as never,
    });
    const r = await registerRustStoragePort(makeTransport());
    expect(r.kind).toBe("failed");
    expect(getStoragePort().kind, "不得覆盖已注册的端口").toBe("wasm");
    // 第 18 轮：文案里的"回滚开关需要在刷新后生效"已随回滚开关退役；现在直接说"没有可用存储"
    expect(reported[0].note).toContain("没有可用存储");
  });

  it("BOOT-10: 未注册端口时 shutdown 是安全的 no-op", async () => {
    await expect(shutdownRustStoragePort()).resolves.toBeUndefined();
    expect(reported).toEqual([]);
  });

  it("BOOT-11: 已注册 rust 端口时 shutdown 会排空并 checkpoint", async () => {
    localStorage.setItem(LEGACY_ENGINE_KEY, "rust");
    const calls: string[] = [];
    const t = makeTransport({
      checkpoint: async () => {
        calls.push("checkpoint");
        return { ok: true, result: { ok: true } } as never;
      },
    });
    await registerRustStoragePort(t);
    await shutdownRustStoragePort();
    expect(calls).toEqual(["checkpoint"]);
  });
});
