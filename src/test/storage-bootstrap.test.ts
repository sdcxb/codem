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
import { STORAGE_ENGINE_KEY, getStoragePort, hasStoragePort, setStoragePort } from "../core/storage/port";
import {
  DEFAULT_ENGINE,
  registerRustStoragePort,
  selectedEngine,
  shutdownRustStoragePort,
} from "../core/storage/bootstrap";
import type { StorageTransport } from "../core/storage/rust-port";

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

describe("存储引导 —— 回滚开关", () => {
  it("BOOT-1: 没有开关时用默认引擎（P5 第 2 段起为 rust）", () => {
    expect(selectedEngine()).toBe(DEFAULT_ENGINE);
    expect(DEFAULT_ENGINE, "默认引擎已切到 rust —— 这是 P5 的核心开关").toBe("rust");
  });

  it("BOOT-2: 回滚开关已退役 —— 写 wasm 也仍然注册 rust 端口", async () => {
    /**
     * 第 15 轮（v1.16.62）：旧引擎已从渲染进程移除，回滚开关**不再被读取**。
     * 这条用例从前断言「写 wasm 就跳过注册」；现在那样的行为只会制造一个**假的**安全感
     * ——用户以为切回去还能用，实际切过去没有任何引擎可用。
     * 所以契约改成：**任何 localStorage 取值都不影响引擎选择**，端口照常注册。
     */
    localStorage.setItem(STORAGE_ENGINE_KEY, "wasm");
    const r = await registerRustStoragePort(makeTransport());
    expect(r.kind, "开关退役后必须照样注册端口").toBe("registered");
    expect(hasStoragePort(), "端口必须已注册").toBe(true);
    expect(getStoragePort().kind).toBe("rust");
    expect(reported, "这不是失败，不该上报错误").toEqual([]);
  });

  it("BOOT-3: 注册端口并预热配置（开关已退役，取值不再影响结果）", async () => {
    localStorage.setItem(STORAGE_ENGINE_KEY, "rust");
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

  it("BOOT-4: 开关值非法也不影响引擎选择（已退役，恒为 rust）", () => {
    localStorage.setItem(STORAGE_ENGINE_KEY, "postgres");
    expect(selectedEngine(), "引擎选择不再读 localStorage").toBe("rust");
  });

  it("BOOT-5: localStorage 抛异常时立刻退回默认（不能因为读开关把启动搞挂）", () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("SecurityError: localStorage 被禁用");
      },
    });
    try {
      expect(selectedEngine()).toBe(DEFAULT_ENGINE);
    } finally {
      if (original) Object.defineProperty(globalThis, "localStorage", original);
    }
  });
});

describe("存储引导 —— 失败必须可见、且不注册半死端口", () => {
  it("BOOT-6: 引擎打不开时上报 + 不注册端口（否则调用方以为有后端，实际全静默失败）", async () => {
    localStorage.setItem(STORAGE_ENGINE_KEY, "rust");
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
    expect(reported.length).toBe(1);
    expect(reported[0].note).toContain("WASM");
  });

  it("BOOT-7: IPC 通道整个炸了也要被包住并上报", async () => {
    localStorage.setItem(STORAGE_ENGINE_KEY, "rust");
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
    localStorage.setItem(STORAGE_ENGINE_KEY, "rust");
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
    localStorage.setItem(STORAGE_ENGINE_KEY, "rust");
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
    expect(reported[0].note).toContain("未生效");
  });

  it("BOOT-10: 未注册端口时 shutdown 是安全的 no-op", async () => {
    await expect(shutdownRustStoragePort()).resolves.toBeUndefined();
    expect(reported).toEqual([]);
  });

  it("BOOT-11: 已注册 rust 端口时 shutdown 会排空并 checkpoint", async () => {
    localStorage.setItem(STORAGE_ENGINE_KEY, "rust");
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
