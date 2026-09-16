/**
 * 配置面扩展域切换契约（P3 第 3 段）：`quick_phrases` / `mcp_servers` / `memory`。
 *
 * ## 为什么这三个域能和 settings 走同一条路
 *
 * 判据是**量级**而非名字：实测生产库这几张表都是 0~1 行，所以可以整表进内存镜像，
 * 于是同步读成立、878 个调用点的迁移经验直接复用。
 *
 * ## 这里要钉住的语义（都与渲染侧历史行为逐条对齐）
 *
 * - `quick_phrases` 的 **使用次数自增**（`saveQuickPhrase` 存一次涨一次）——
 *   这是最容易被"顺手改成覆盖"的地方，一旦改错用户会看到快捷键排序错乱；
 * - `mcp_servers.enabled` 必须是**布尔**（渲染侧按真值用）；
 * - `memory` 没有记录时返回**空串**（不是 null）；
 * - rust 引擎下**不得访问旧库**（否则两个库各写一半）。
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { setStoragePort } from "../core/storage/port";
import {
  deleteQuickPhrase,
  incrementQuickPhraseUsage,
  loadMcpServers,
  loadMemory,
  loadQuickPhrases,
  removeMcpServer,
  saveMcpServer,
  saveMemory,
  saveQuickPhrase,
} from "../core/storage/settings";

let legacyTouched = 0;
vi.mock("../core/storage/database", () => ({
  getDatabase: () => {
    legacyTouched++;
    throw new Error("旧库（WASM）不应在 rust 引擎下被访问");
  },
  persistDatabase: () => {
    legacyTouched++;
  },
}));
const reported: string[] = [];
vi.mock("../core/storage/persist-failure", () => ({
  reportPersistFailure: (_scope: string, _e: unknown, note: string) => {
    reported.push(note);
  },
  reportActionFailure: (_scope: string, _e: unknown, note: string) => {
    reported.push(note);
  },
}));

/** 假 Rust 端口：configDomain 用真实现（RustConfigDomainCache），transport 用假的 */
async function fakePort(initial?: { quick_phrases?: unknown[]; mcp_servers?: unknown[]; memory?: string }) {
  const { RustStoragePort } = await import("../core/storage/rust-port");
  const invocations: Array<{ command: string; params: Record<string, unknown> }> = [];
  const warmupPayload = {
    quick_phrases: initial?.quick_phrases ?? [],
    mcp_servers: initial?.mcp_servers ?? [],
    memory: initial?.memory ?? "",
  };
  const transport = {
    invokeCommand: async (command: string, params?: Record<string, unknown>) => {
      invocations.push({ command, params: params ?? {} });
      if (command === "config_warmup") return { ok: true, result: warmupPayload } as never;
      if (command === "settings.get_all") return { ok: true, result: {} } as never;
      return { ok: true, result: { written: 1 } } as never;
    },
    invokeBatch: async () => ({ ok: true, result: { count: 0, results: [] } }) as never,
    health: async () => ({ ok: true, result: { ready: true, engine: "rust" } }) as never,
    integrityCheck: async () => ({ ok: true, result: { ok: true } }) as never,
    checkpoint: async () => ({ ok: true, result: { ok: true } }) as never,
    capabilities: async () => ({ commands: [] }) as never,
  };
  const port = new RustStoragePort(transport as never, (_s, _e, note) => reported.push(note));
  await port.start();
  return { port, invocations };
}

afterEach(() => {
  setStoragePort(null);
  legacyTouched = 0;
  reported.length = 0;
  vi.restoreAllMocks();
});

describe("配置面扩展域 —— quick_phrases", () => {
  it("CFG-1: 空库时返回空数组（不是异常、不是 null）", async () => {
    const { port } = await fakePort();
    setStoragePort(port);
    expect(loadQuickPhrases()).toEqual([]);
    expect(legacyTouched, "rust 引擎下不得访问旧库").toBe(0);
  });

  it("CFG-2: 保存后立即可读，且 usage_count 是 1（与渲染侧语义一致）", async () => {
    const { port } = await fakePort();
    setStoragePort(port);
    saveQuickPhrase({
      id: "q1",
      title: "标题",
      content: "内容",
      category: "coding",
      usageCount: 0,
      createdAt: 0,
      updatedAt: 0,
    });
    const list = loadQuickPhrases();
    expect(list).toHaveLength(1);
    expect(list[0].usageCount).toBe(1);
    expect(list[0].title).toBe("标题");
    expect(list[0].category).toBe("coding");
  });

  it("CFG-3: 重复保存同一 id → usage_count 递增，且不产生第二行", async () => {
    const { port } = await fakePort();
    setStoragePort(port);
    const phrase = {
      id: "q1",
      title: "标题",
      content: "内容",
      category: "coding" as const,
      usageCount: 0,
      createdAt: 0,
      updatedAt: 0,
    };
    saveQuickPhrase(phrase);
    saveQuickPhrase({ ...phrase, title: "新标题" });
    const list = loadQuickPhrases();
    expect(list, "upsert 不能变成 insert").toHaveLength(1);
    expect(list[0].usageCount, "第二次保存应涨到 2").toBe(2);
    expect(list[0].title).toBe("新标题");
  });

  it("CFG-4: 使用次数单独累加（incrementQuickPhraseUsage）", async () => {
    const { port } = await fakePort();
    setStoragePort(port);
    saveQuickPhrase({ id: "q1", title: "T", content: "C", category: "other", usageCount: 0, createdAt: 0, updatedAt: 0 });
    incrementQuickPhraseUsage("q1");
    incrementQuickPhraseUsage("q1");
    expect(loadQuickPhrases()[0].usageCount).toBe(3);
  });

  it("CFG-5: 删除后不再出现", async () => {
    const { port } = await fakePort();
    setStoragePort(port);
    saveQuickPhrase({ id: "q1", title: "T", content: "C", category: "other", usageCount: 0, createdAt: 0, updatedAt: 0 });
    deleteQuickPhrase("q1");
    expect(loadQuickPhrases()).toEqual([]);
  });

  it("CFG-6: 写穿发出的命令与参数形状正确（snake_case，与 Rust 契约一致）", async () => {
    const { port, invocations } = await fakePort();
    setStoragePort(port);
    saveQuickPhrase({ id: "q9", title: "T", content: "C", category: "test", usageCount: 3, createdAt: 7, updatedAt: 0 });
    const call = invocations.find((i) => i.command === "quick_phrases.save");
    expect(call, "必须发出 quick_phrases.save").toBeTruthy();
    expect(call?.params).toMatchObject({ id: "q9", title: "T", category: "test", usage_count: 3, created_at: 7 });
    expect(typeof call?.params.updated_at).toBe("number");
  });
});

describe("配置面扩展域 —— mcp_servers", () => {
  it("CFG-7: enabled 往返保持布尔（不变成 0/1）", async () => {
    const { port } = await fakePort({
      mcp_servers: [{ id: "s1", name: "伺服", config: "{}", enabled: true }],
    });
    setStoragePort(port);
    const list = loadMcpServers();
    expect(list).toHaveLength(1);
    expect(list[0].enabled).toBe(true);
    expect(typeof list[0].enabled).toBe("boolean");
  });

  it("CFG-8: 保存覆盖同 id，不新增行；删除生效", async () => {
    const { port } = await fakePort();
    setStoragePort(port);
    saveMcpServer("s1", "A", "{}", true);
    saveMcpServer("s1", "B", "{}", false);
    const list = loadMcpServers();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe("B");
    expect(list[0].enabled).toBe(false);
    removeMcpServer("s1");
    expect(loadMcpServers()).toEqual([]);
  });
});

describe("配置面扩展域 —— memory", () => {
  it("CFG-9: 没有记录时返回空串（渲染侧语义，不能是 null）", async () => {
    const { port } = await fakePort();
    setStoragePort(port);
    expect(loadMemory()).toBe("");
  });

  it("CFG-10: 保存后可读；覆盖不新增（单行）", async () => {
    const { port, invocations } = await fakePort();
    setStoragePort(port);
    saveMemory("第一版");
    expect(loadMemory()).toBe("第一版");
    saveMemory("第二版");
    expect(loadMemory()).toBe("第二版");
    const calls = invocations.filter((i) => i.command === "memory.set");
    expect(calls).toHaveLength(2);
    expect(calls[1].params).toEqual({ content: "第二版" });
  });
});

describe("配置面扩展域 —— 未预热与失败处置", () => {
  it("CFG-11: 未预热时同步读返回默认值 + 留痕（不抛）", async () => {
    const { RustStoragePort } = await import("../core/storage/rust-port");
    const transport = {
      invokeCommand: async () => {
        throw new Error("IPC 未就绪");
      },
      invokeBatch: async () => ({ ok: true, result: {} }) as never,
      health: async () => ({ ok: true, result: { ready: true } }) as never,
      integrityCheck: async () => ({ ok: true, result: {} }) as never,
      checkpoint: async () => ({ ok: true, result: {} }) as never,
      capabilities: async () => ({}) as never,
    };
    const port = new RustStoragePort(transport as never, (_s, _e, note) => reported.push(note));
    // 刻意不 start()（不预热），只注册端口
    setStoragePort(port);
    expect(loadMemory(), "未预热必须回退默认值").toBe("");
    expect(loadQuickPhrases()).toEqual([]);
    expect(reported.length, "未预热必须留痕").toBeGreaterThan(0);
  });

  it("CFG-12: 扩展域预热失败不阻塞启动（只上报，settings 仍可用）", async () => {
    const { RustStoragePort } = await import("../core/storage/rust-port");
    const transport = {
      invokeCommand: async (command: string) => {
        if (command === "config_warmup") {
          return { ok: false, error: { code: "OTHER", message: "扩展域炸了", retryable: false } } as never;
        }
        if (command === "settings.get_all") return { ok: true, result: { theme: "dark" } } as never;
        return { ok: true, result: {} } as never;
      },
      invokeBatch: async () => ({ ok: true, result: {} }) as never,
      health: async () => ({ ok: true, result: { ready: true, engine: "rust" } }) as never,
      integrityCheck: async () => ({ ok: true, result: {} }) as never,
      checkpoint: async () => ({ ok: true, result: {} }) as never,
      capabilities: async () => ({}) as never,
    };
    const port = new RustStoragePort(transport as never, (_s, _e, note) => reported.push(note));
    const health = await port.start(); // 不应抛
    setStoragePort(port);
    expect(health.ready, "扩展域失败不该让整个引擎不可用").toBe(true);
    expect(reported.some((n) => n.includes("降级")), "必须上报降级").toBe(true);
    // settings 仍然可用（它是独立预热阶段）
    const { getSetting } = await import("../core/storage/settings");
    expect(getSetting("theme")).toBe("dark");
  });
});
