/**
 * `NodeTransport` 的信封语义（NTRANS-*）。
 *
 * 这一层是"存储层能不能在 Host 里原样复用"的关键：`rust-port.ts` 的 3416 行代码
 * 全都假定 `StorageTransport` 返回的是 `{ok,result,error,engine}` 信封。
 * 只要 NodeTransport 的信封走样，错误码/重试/镜像会一起错 —— 而且是**静默**的。
 */
import { describe, expect, it } from "vitest";

import { NodeTransport } from "../../packages/host/src/db/node-transport";

interface FakeReply {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string; retryable: boolean; hint?: string };
  engine?: string;
}

function fakeClient(reply: FakeReply, health?: Record<string, unknown>) { const healthResult = health ?? { ready: true, tables: 40 };
  const calls: Array<{ command: string; params?: Record<string, unknown> }> = [];
  return {
    calls,
    client: {
      async invoke(command: string, params?: Record<string, unknown>) {
        calls.push({ command, params });
        return reply;
      },
      async batch(commands: Array<{ command: string }>) {
        calls.push({ command: `batch:${commands.length}` });
        return reply;
      },
      async op(op: string) {
        calls.push({ command: `op:${op}` });
        return op === "health" ? { id: 1, ok: true, result: healthResult, engine: "rust" } : reply;
      },
    },
  };
}

describe("NTRANS-1 透传信封", () => {
  it("成功信封原样返回（不解包、不改字段）", async () => {
    const { client, calls } = fakeClient({ id: 1, ok: true, result: { written: 1 }, engine: "rust" });
    const t = new NodeTransport(client as never, "C:/tmp/db.bin");
    const reply = (await t.invokeCommand("settings.set", { key: "k", value: 1 })) as unknown as FakeReply;
    expect(reply).toEqual({ id: 1, ok: true, result: { written: 1 }, engine: "rust" });
    expect(calls[0]).toEqual({ command: "settings.set", params: { key: "k", value: 1 } });
  });

  it("失败信封原样返回（让 rust-port 的 unwrap 去抛 StorageError）", async () => {
    const error = { code: "BUSY", message: "busy", retryable: true, hint: "稍后重试" };
    const { client } = fakeClient({ id: 2, ok: false, error });
    const t = new NodeTransport(client as never, "C:/tmp/db.bin");
    const reply = (await t.invokeCommand("messages.list", {})) as unknown as FakeReply;
    expect(reply.ok).toBe(false);
    expect(reply.error).toEqual(error);
  });
});

describe("NTRANS-2 健康与能力", () => {
  it("health 把 db_path 附在 health 上（与 Tauri 命令层同形）", async () => {
    const { client } = fakeClient({ id: 1, ok: true, result: {} }, { ready: true, tables: 40 });
    const t = new NodeTransport(client as never, "C:/data/codem-db-rust.bin");
    const reply = (await t.health()) as unknown as FakeReply & { result: Record<string, unknown> };
    expect(reply.ok).toBe(true);
    expect(reply.result.ready).toBe(true);
    expect(reply.result.db_path).toBe("C:/data/codem-db-rust.bin");
    expect(reply.result.db_path_standard).toBe(true);
  });

  it("health 失败时返回 ok:false 而不是抛（调用方要能诊断）", async () => {
    // 这条要的是"引擎连不上"的信封：用专用假客户端，避免通用 fake 的 health 分支掩盖它
    const client = {
      async invoke() {
        return { id: 1, ok: true, result: {}, engine: "rust" };
      },
      async batch() {
        return { id: 2, ok: true, result: {}, engine: "rust" };
      },
      async op() {
        return { id: 3, ok: false, error: { code: "UNAVAILABLE", message: "down", retryable: true }, engine: "rust" };
      },
    };
    const t = new NodeTransport(client as never, "db.bin");
    const reply = (await t.health()) as unknown as FakeReply;
    expect(reply.ok).toBe(false);
    expect(reply.error?.code).toBe("UNAVAILABLE");
  });
});
