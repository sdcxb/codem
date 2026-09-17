/**
 * Rust 存储端口契约测试（P3）：把 `rust-port.ts` 的语义钉死在测试里。
 *
 * ## 为什么必须有这个文件
 *
 * 端口的价值在于**调用方可以依赖它的语义**。而语义最容易在两种地方悄悄破掉：
 * 1. Rust 侧改了返回形状（例如 `has_more` 改名），TS 侧没跟上 —— 于是分页静默少读数据；
 * 2. TS 侧为了"让界面好过一点"吞掉错误 —— 于是失败变成静默数据丢失。
 *
 * 所以这里用**假传输层**（不需要 Tauri 运行时）逐条验证：
 * - 错误必须变成 `StorageError` 且 `code`/`retryable` 与 Rust 契约一致（不是解析文本）；
 * - 分页必须透传 `hasMore`/`nextCursor`（引擎算，渲染侧不猜）；
 * - 批量写失败必须**如实抛出**并带上"已完成几步"；
 * - 配置面预热前同步读要如实回退 + 留痕，写穿失败要走统一上报；
 * - 追加面必须有背压（队列上限、丢弃计数），不能无限吃内存；
 * - **端口发出的每一条命令都必须是仓储命令名，参数里不得出现 SQL**（D 类门禁的运行时版本）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RustStoragePort, rustCapabilities, type StorageTransport } from "../core/storage/rust-port";
import { StorageError } from "../core/storage/port";

interface Call {
  method: string;
  command?: string;
  params?: Record<string, unknown>;
}

/** 假传输层：记录调用、返回预设响应；不依赖 Tauri */
class FakeTransport implements StorageTransport {
  calls: Call[] = [];
  /** command → 响应（可以是错误） */
  replies = new Map<string, unknown>();
  batchReply: unknown = { ok: true, result: { count: 0, results: [] } };
  healthReply: unknown = {
    ok: true,
    result: { ready: true, engine: "rust", path: "C:/tmp/x.bin", size_bytes: 100, journal_mode: "wal", wal_size_bytes: 0, tables: 45, fts_module: "fts5", last_error_code: null },
  };
  integrityReply: unknown = { ok: true, result: { ok: true, detail: "ok" } };
  checkpointReply: unknown = { ok: true, result: { ok: true } };

  capabilitiesReply: unknown = {
    engine: "rust",
    commands: ["settings.get_all", "settings.set", "settings.remove", "messages.list"],
    max_rows_per_query: 5000,
    no_whole_file_export: true,
  };

  async invokeCommand<T>(command: string, params?: Record<string, unknown>): Promise<T> {
    this.calls.push({ method: "invokeCommand", command, params });
    if (this.replies.has(command)) return this.replies.get(command) as T;
    return { ok: true, result: {} } as T;
  }

  async invokeBatch<T>(commands: Array<{ command: string; params?: Record<string, unknown> }>): Promise<T> {
    this.calls.push({ method: "invokeBatch", params: { commands } as unknown as Record<string, unknown> });
    return this.batchReply as T;
  }

  async health<T>(): Promise<T> {
    this.calls.push({ method: "health" });
    return this.healthReply as T;
  }

  async integrityCheck<T>(): Promise<T> {
    this.calls.push({ method: "integrityCheck" });
    return this.integrityReply as T;
  }

  async checkpoint<T>(): Promise<T> {
    this.calls.push({ method: "checkpoint" });
    return this.checkpointReply as T;
  }

  /**
   * ⚠️ **裸 `Value`**，不是 `{ok, result}`（A-5）。
   *
   * `src-tauri/src/storage.rs::storage_capabilities` 的签名是 `-> Value`，
   * 它直接返回 `capabilities()` 的结果 —— 没有 `reply()` 包装。
   * 这个假传输层早先返回的是**扁平对象**，形状恰好与"按扁平字段读"的错误实现
   * 互相吻合，于是那个缺陷在测试里**永远绿**。
   */
  async capabilities<T>(): Promise<T> {
    this.calls.push({ method: "capabilities" });
    return this.capabilitiesReply as T;
  }

  /** 所有被发出的命令名 */
  commands(): string[] {
    const out: string[] = [];
    for (const c of this.calls) {
      if (c.command) out.push(c.command);
      const cmds = (c.params as { commands?: Array<{ command: string }> } | undefined)?.commands;
      for (const inner of cmds ?? []) out.push(inner.command);
    }
    return out;
  }
}

let t: FakeTransport;
let failures: Array<{ stream: string; note: string }>;
let port: RustStoragePort;

beforeEach(() => {
  t = new FakeTransport();
  failures = [];
  port = new RustStoragePort(t, (stream, _e, note) => failures.push({ stream, note }));
});

afterEach(() => {
  vi.useRealTimers();
});

// ========== 真端口的"wire 行 → 镜像行"转换契约（第 44 轮） ==========
//
// ## 为什么必须用**真端口**跑这一组
//
// 第 44 轮给消息加了 `trimmed` 列（区分"索引裁剪隐藏"与"上下文压缩隐藏"），
// 而真端口在 `normalize()` 里做的是 **eager 转换**：只有列在那个函数里被显式搬过来，
// 镜像行才有这个字段。假端口的 `hiddenIds()` 是**惰性读共享表**（原始 wire 行形状），
// 于是"真端口漏搬一列"这类缺陷**在假端口的用例里结构上不可能被发现** ——
// 实测就是这么漏掉的：`trimmed` 没被搬 → 真机上 `hiddenIds()` 把所有隐藏行都当成
// "被上下文压缩" → `listMessagesMerged` 把"被裁剪掉、本该仍读得到的历史"整批删掉。
//
// 所以这一组刻意跨过 `RustStoragePort` → `messages.list` 的**真实转换路径**。
describe("RustStoragePort —— wire 行 → 镜像行的字段搬运（真端口转换契约）", () => {
  it("MIRROR-TRIM: `trimmed` 必须被搬进镜像，且 `hiddenIds()` 据此排除被裁剪的行", async () => {
    t.replies.set("messages.list", {
      ok: true,
      result: {
        items: [
          { id: "m-compressed", session_id: "s1", role: "user", content: "被压缩", timestamp: 1, hidden: 1, trimmed: 0 },
          { id: "m-trimmed", session_id: "s1", role: "user", content: "被裁剪", timestamp: 2, hidden: 1, trimmed: 1 },
          { id: "m-visible", session_id: "s1", role: "user", content: "可见", timestamp: 3, hidden: 0, trimmed: 0 },
        ],
        has_more: false,
        next_cursor: null,
      },
    });
    port.messages.ensureLoaded("s1");
    await new Promise((r) => setTimeout(r, 20));

    const rows = port.messages.list("s1");
    expect(rows.length, "三条都应在镜像里").toBe(3);
    const trimmedRow = rows.find((r) => r.id === "m-trimmed");
    expect(
      trimmedRow && Number(trimmedRow.trimmed ?? -1),
      "wire 行的 trimmed 必须被搬进镜像（漏搬会让下面那条断言在生产上失效）",
    ).toBe(1);

    const hidden = port.messages.hiddenIds("s1");
    expect(hidden.has("m-compressed"), "被上下文压缩的行必须仍算隐藏").toBe(true);
    expect(
      hidden.has("m-trimmed"),
      "被**索引裁剪**的行不该算隐藏 —— 它必须仍能从权威日志读到（用户看得到自己的历史）",
    ).toBe(false);
  });

  it("MIRROR-TRIM-2: 老库/缺列时按 0 处理（等价于“被压缩”），不会把 NULL 当成裁剪", async () => {
    t.replies.set("messages.list", {
      ok: true,
      result: {
        items: [{ id: "m1", session_id: "s1", role: "user", content: "x", timestamp: 1, hidden: 1 }],
        has_more: false,
        next_cursor: null,
      },
    });
    port.messages.ensureLoaded("s1");
    await new Promise((r) => setTimeout(r, 20));
    const rows = port.messages.list("s1");
    expect(Number(rows[0]?.trimmed ?? -1), "缺列 → 0").toBe(0);
    expect(port.messages.hiddenIds("s1").has("m1"), "缺列时按“被压缩”处理（安全一侧）").toBe(true);
  });
});
// ========== 错误是值 ==========

describe("RustStoragePort —— 错误是值（不是文本，也不是进程中毒）", () => {
  it("PORT-1: Rust 的结构化错误变成 StorageError，code/retryable 原样保留", async () => {
    t.replies.set("messages.list", {
      ok: false,
      error: { code: "BUSY", message: "database is locked", retryable: true, hint: "稍后重试" },
    });
    const err = await port.data.query("messages.list", { session_id: "s1" }).catch((e) => e as StorageError);
    expect(err).toBeInstanceOf(StorageError);
    expect(err.code).toBe("BUSY");
    expect(err.retryable, "BUSY 必须可重试 —— 调用方据此决定重试而不是上报故障").toBe(true);
  });

  it("PORT-2: 未知错误码降级为 OTHER，不抛未知异常", async () => {
    t.replies.set("messages.list", {
      ok: false,
      error: { code: "WAT_FUTURE_CODE", message: "来自未来版本", retryable: false },
    });
    const err = await port.data.query("messages.list").catch((e) => e as StorageError);
    expect(err).toBeInstanceOf(StorageError);
    expect(err.code).toBe("OTHER");
  });

  it("PORT-3: NOT_FOUND / CONSTRAINT 不可重试（业务处理，不是故障）", async () => {
    for (const code of ["NOT_FOUND", "CONSTRAINT", "UNSUPPORTED"]) {
      t.replies.set("messages.update", { ok: false, error: { code, message: "x", retryable: false } });
      const err = await port.data.execute("messages.update", { id: "m1" }).catch((e) => e as StorageError);
      expect(err.code).toBe(code);
      expect(err.retryable, `${code} 不应建议重试`).toBe(false);
    }
  });

  it("PORT-4: 响应形状无法识别时报错，而不是当成成功", async () => {
    t.replies.set("messages.count", { nonsense: true });
    await expect(port.data.query("messages.count", { session_id: "s" })).rejects.toBeInstanceOf(StorageError);
  });

  it("PORT-5: 传输层抛出的原生异常也被包装成 StorageError", async () => {
    t.invokeCommand = async () => {
      throw new Error("IPC 通道断了");
    };
    const err = await port.data.query("messages.list").catch((e) => e as StorageError);
    expect(err).toBeInstanceOf(StorageError);
    expect(err.message).toContain("IPC");
  });
});

// ========== 分页语义 ==========

describe("RustStoragePort —— 分页语义（引擎算，渲染侧不猜）", () => {
  it("PORT-6: hasMore / nextCursor 原样透传", async () => {
    t.replies.set("messages.list", {
      ok: true,
      result: { items: [{ id: "a" }, { id: "b" }], has_more: true, next_cursor: "2" },
    });
    const page = await port.data.query<{ id: string }>("messages.list", { session_id: "s" }, { limit: 2 });
    expect(page.items.map((i) => i.id)).toEqual(["a", "b"]);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toBe("2");
  });

  it("PORT-7: 单条查询的 {item} 形状被归一成单元素分页", async () => {
    t.replies.set("messages.get", { ok: true, result: { item: { id: "m1" } } });
    const page = await port.data.query<{ id: string }>("messages.get", { id: "m1" });
    expect(page.items).toEqual([{ id: "m1" }]);
    expect(page.hasMore).toBe(false);
  });

  it("PORT-8: item 为 null 时返回空列表（而不是 [null]，否则调用方会解引用崩溃）", async () => {
    t.replies.set("messages.get", { ok: true, result: { item: null } });
    const page = await port.data.query("messages.get", { id: "缺失" });
    expect(page.items).toEqual([]);
  });

  it("PORT-9: limit/offset 只透传显式给出的值（不替调用方塞默认值）", async () => {
    await port.data.query("messages.list", { session_id: "s" }, { limit: 50 });
    const call = t.calls.find((c) => c.command === "messages.list");
    expect(call?.params).toMatchObject({ session_id: "s", limit: 50 });
    expect(call?.params).not.toHaveProperty("offset");
  });
});

// ========== 批量写 ==========

describe("RustStoragePort —— 批量写语义", () => {
  it("PORT-10: 空批次不发 IPC（省一次往返）", async () => {
    const r = await port.data.write([]);
    expect(r.written).toBe(0);
    expect(t.calls.filter((c) => c.method === "invokeBatch")).toHaveLength(0);
  });

  it("PORT-11: written 为各步之和", async () => {
    t.batchReply = {
      ok: true,
      result: { count: 2, results: [{ result: { written: 3 } }, { result: { written: 1 } }] },
    };
    const r = await port.data.write([
      { command: "messages.create_many", params: { items: [] } },
      { command: "telemetry.append", params: { items: [] } },
    ]);
    expect(r.written).toBe(4);
  });

  it("PORT-12: 批量失败如实抛出（绝不「部分成功却报成功」）", async () => {
    t.batchReply = {
      ok: false,
      error: {
        code: "CONSTRAINT",
        message: "batch 在第 2 步失败（command=messages.create）：外键约束；已完成 1 步：[…]",
        retryable: false,
      },
    };
    const err = await port.data.write([{ command: "sessions.upsert" }, { command: "messages.create" }]).catch(
      (e) => e as StorageError,
    );
    expect(err).toBeInstanceOf(StorageError);
    expect(err.code).toBe("CONSTRAINT");
    expect(err.message, "必须带上「已完成几步」，调用方才能决定补偿").toContain("已完成 1 步");
  });
});

// ========== 配置面 ==========

describe("RustStoragePort —— 配置面（同步读 + 写穿）", () => {
  it("PORT-13: 预热后同步读命中缓存（这是唯一允许的内存镜像）", async () => {
    t.replies.set("settings.get_all", { ok: true, result: { theme: "dark", count: "42" } });
    const n = await port.config.warmup();
    expect(n).toBe(2);
    expect(port.config.get("theme", "light")).toBe("dark");
    expect(port.config.get("count", 0)).toBe("42");
    expect(port.config.stats().warmed).toBe(true);
  });

  it("PORT-14: 未预热时同步读如实回退 + 留痕（不抛、不假装有值）", () => {
    expect(port.config.get("theme", "light")).toBe("light");
    expect(failures.length, "未预热必须留痕").toBe(1);
    expect(failures[0].note).toContain("回退");
  });

  it("PORT-15: set 先内存生效，再写穿落库", async () => {
    t.replies.set("settings.get_all", { ok: true, result: {} });
    await port.config.warmup();
    port.config.set("theme", "dark");
    expect(port.config.get("theme", "light"), "界面必须即时生效").toBe("dark");
    await port.config.flush();
    const call = t.calls.find((c) => c.command === "settings.set");
    expect(call?.params).toEqual({ key: "theme", value: "dark" });
  });

  it("PORT-16: 写穿失败如实上报（不静默吞掉）", async () => {
    t.replies.set("settings.get_all", { ok: true, result: {} });
    await port.config.warmup();
    t.invokeCommand = async (command: string) => {
      if (command === "settings.set") {
        return { ok: false, error: { code: "NOMEM", message: "磁盘满", retryable: false } } as never;
      }
      return { ok: true, result: {} } as never;
    };
    port.config.set("theme", "dark");
    await port.config.flush();
    expect(failures.length).toBe(1);
    expect(failures[0].note).toContain("未保存");
    expect(port.config.stats().failures).toBe(1);
  });

  it("PORT-17: 删除「本来就不存在」的 key 不算失败（幂等删除）", async () => {
    t.replies.set("settings.get_all", { ok: true, result: {} });
    await port.config.warmup();
    t.invokeCommand = async (command: string) => {
      if (command === "settings.remove") {
        return { ok: false, error: { code: "NOT_FOUND", message: "不存在", retryable: false } } as never;
      }
      return { ok: true, result: {} } as never;
    };
    port.config.remove("never-existed");
    await port.config.flush();
    expect(failures, "NOT_FOUND 是正常情形，不该报失败").toEqual([]);
    expect(port.config.stats().failures).toBe(0);
  });

  it("PORT-18: 非字符串值按 JSON 文本存（与既有约定一致）", async () => {
    t.replies.set("settings.get_all", { ok: true, result: {} });
    await port.config.warmup();
    port.config.set("breakpoints", [1, 2, 3]);
    await port.config.flush();
    const call = t.calls.find((c) => c.command === "settings.set");
    expect(call?.params?.value).toBe("[1,2,3]");
  });
});

// ========== 追加面 ==========

describe("RustStoragePort —— 只追加面（入队 + 背压）", () => {
  it("PORT-19: 队列满时返回 false 并计数丢弃（不无限吃内存）", async () => {
    // 让 drain 永远挂住：模拟"落库很慢"
    t.invokeCommand = () => new Promise(() => {});
    let last = true;
    for (let i = 0; i < 5001; i++) last = port.append.append("events", { session_id: "s", event_type: "t" });
    expect(last, "超过上限必须返回 false 让调用方降级").toBe(false);
    const st = port.append.stats();
    expect(st.dropped).toBeGreaterThan(0);
    expect(st.pending).toBeLessThanOrEqual(5000);
  });

  it("PORT-20: 落库失败会累计到 failures 并上报（不静默丢数据）", async () => {
    t.invokeCommand = async (command: string) => {
      if (command === "events.append") {
        return { ok: false, error: { code: "CORRUPT", message: "库损坏", retryable: false } } as never;
      }
      return { ok: true, result: {} } as never;
    };
    port.append.append("events", { session_id: "s", event_type: "t" });
    await port.append.flush();
    expect(port.append.stats().failures).toBe(1);
    expect(failures[0].note).toContain("JSONL");
  });
});

// ========== 引擎生命周期 + 架构承诺 ==========

describe("RustStoragePort —— 引擎与架构承诺", () => {
  it("PORT-21: health 字段完整（诊断面板的数据来源）", async () => {
    const h = await port.engine.health();
    expect(h.engine).toBe("rust");
    expect(h.ready).toBe(true);
    expect(h.journalMode).toBe("wal");
    expect(h.ftsModule).toBe("fts5");
    expect(h.tables).toBe(45);
  });

  it("PORT-22: start = 先预热配置再报健康；stop = 排空队列再 checkpoint", async () => {
    t.replies.set("settings.get_all", { ok: true, result: { a: "1" } });
    await port.start();
    expect(port.config.stats().warmed).toBe(true);
    await port.stop();
    const methods = t.calls.map((c) => c.method);
    expect(methods).toContain("checkpoint");
    expect(methods.indexOf("checkpoint")).toBeGreaterThan(-1);
  });

  it("PORT-23: 能力自省必须声明「不提供整库导出」", async () => {
    const caps = await rustCapabilities(t);
    expect(caps.no_whole_file_export).toBe(true);
    expect(caps.max_rows_per_query).toBeGreaterThan(0);
    expect(caps.commands).toContain("messages.list");
  });

  it("PORT-24: 端口发出的命令都是仓储命令名，且参数里不出现 SQL（D 类门禁的运行时版）", async () => {
    t.replies.set("settings.get_all", { ok: true, result: {} });
    await port.config.warmup();
    port.config.set("k", "v");
    await port.config.flush();
    await port.data.query("messages.list", { session_id: "s" }, { limit: 1 });
    await port.data.execute("messages.count", { session_id: "s" });
    port.append.append("events", { session_id: "s", event_type: "e" });
    await port.append.flush();

    const known = new Set([
      "settings.get_all",
      "settings.set",
      "settings.remove",
      "events.append",
      "telemetry.append",
      "messages.list",
      "messages.count",
    ]);
    for (const cmd of t.commands()) {
      expect(known.has(cmd), `端口发出了非仓储命令：${cmd}`).toBe(true);
    }
    // 参数里不得出现 SQL 关键字（一旦有人把 SQL 塞进参数，这条会红）
    const serialized = JSON.stringify(t.calls.map((c) => c.params ?? {}));
    for (const kw of ["SELECT ", "INSERT INTO", "UPDATE ", "DELETE FROM", "ATTACH", "PRAGMA"]) {
      expect(serialized.includes(kw), `参数里出现了 SQL 片段：${kw}`).toBe(false);
    }
  });

  it("PORT-25: 语料不进渲染进程 —— 端口不缓存查询结果", async () => {
    t.replies.set("messages.list", {
      ok: true,
      result: { items: [{ id: "a", content: "很大的正文" }], has_more: false, next_cursor: null },
    });
    const first = await port.data.query("messages.list", { session_id: "s" }, { limit: 1 });
    t.replies.set("messages.list", { ok: true, result: { items: [], has_more: false, next_cursor: null } });
    const second = await port.data.query("messages.list", { session_id: "s" }, { limit: 1 });
    expect(first.items).toHaveLength(1);
    expect(second.items, "第二次必须重新问引擎，不能吃缓存").toHaveLength(0);
  });
});
