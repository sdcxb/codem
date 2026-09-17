/**
 * **引擎的重试判断必须优先于渲染侧本地表**（第 45 轮线协议审计 P2-5）。
 *
 * ## 缺陷形态
 *
 * 引擎的错误体里本来就带 `retryable`（`error.rs` 的 `DbError.retryable` → `storage.rs` 原样转发），
 * 而渲染侧此前把它**丢掉**、只用 `StorageError` 构造函数里那张按 `code` 重算的本地表。
 *
 * 两边一旦不一致，后果是**可观察的行为错**，不是"用词不同"：
 * - 引擎说 `IO` 这一次不该重试（例如磁盘只读），渲染侧照旧重试 3 次；
 * - 引擎说某个 `OTHER` 其实可以重试，渲染侧直接放弃。
 *
 * 所以这里从**行为**上钉住：同一个 `code`，线协议给不同的 `retryable`，写命令的实际尝试次数必须不同。
 */
import { describe, it, expect } from "vitest";
import { RustStoragePort, type StorageTransport } from "../core/storage/rust-port";
import { StorageError } from "../core/storage/port";

interface Call {
  command: string;
  params?: Record<string, unknown>;
}

/** 每次都失败、并记录调用次数的传输（用白名单里的写命令 `crud.upsert` 触发重试逻辑） */
function failingTransport(error: Record<string, unknown>): { transport: StorageTransport; calls: Call[] } {
  const calls: Call[] = [];
  const transport: StorageTransport = {
    invokeCommand: async (command: string, params?: Record<string, unknown>) => {
      calls.push({ command, params });
      return { ok: false, engine: "rust", error } as never;
    },
    invokeBatch: async () => ({ ok: true, result: { count: 0, results: [] } }) as never,
    health: async () => ({ ok: true, result: { ready: true } }) as never,
    integrityCheck: async () => ({ ok: true, result: { ok: true, detail: "ok" } }) as never,
    checkpoint: async () => ({ ok: true, result: { ok: true } }) as never,
    capabilities: async () => ({ commands: [] }) as never,
  };
  return { transport, calls };
}

describe("错误重试策略：线协议的 retryable 优先", () => {
  it("RTP-1: 引擎说 `IO` **不可重试** → 一次都不许重试（本地表本来会重试 3 次）", async () => {
    const { transport, calls } = failingTransport({
      code: "IO",
      message: "disk is read-only",
      retryable: false,
      hint: "检查磁盘权限",
    });
    const port = new RustStoragePort(transport, () => {});

    const err = await port.data.execute("crud.upsert", { table: "settings", rows: [] }).catch((e) => e);
    expect(err).toBeInstanceOf(StorageError);
    expect((err as StorageError).code).toBe("IO");
    expect((err as StorageError).retryable, "引擎的判断必须被采纳").toBe(false);
    expect(calls.length, "不可重试 → 只发一次").toBe(1);
  });

  it("RTP-2: 引擎说某个 `OTHER` **可重试** → 白名单命令必须真的重试", async () => {
    const { transport, calls } = failingTransport({
      code: "OTHER",
      message: "transient engine hiccup",
      retryable: true,
      hint: "稍后重试",
    });
    const port = new RustStoragePort(transport, () => {});

    const err = await port.data.execute("crud.upsert", { table: "settings", rows: [] }).catch((e) => e);
    expect((err as StorageError).retryable, "引擎说可重试就要可重试（本地表会判 OTHER 不可重试）").toBe(true);
    expect(calls.length, "有界重试：最多 3 次尝试（50/150/400ms 退避）").toBe(3);
  });

  it("RTP-3: 线协议**没带** retryable 时回落本地表（老传输/手搓错误不许变语义）", async () => {
    const { transport, calls } = failingTransport({ code: "BUSY", message: "database is locked" });
    const port = new RustStoragePort(transport, () => {});

    const err = await port.data.execute("crud.upsert", { table: "settings", rows: [] }).catch((e) => e);
    expect((err as StorageError).retryable, "BUSY 在本地表里是可重试的").toBe(true);
    expect(calls.length).toBe(3);

    const { transport: t2, calls: c2 } = failingTransport({ code: "CONSTRAINT", message: "foreign key" });
    const port2 = new RustStoragePort(t2, () => {});
    const err2 = await port2.data.execute("crud.upsert", { table: "settings", rows: [] }).catch((e) => e);
    expect((err2 as StorageError).retryable, "CONSTRAINT 在本地表里不可重试").toBe(false);
    expect(c2.length).toBe(1);
  });
});
