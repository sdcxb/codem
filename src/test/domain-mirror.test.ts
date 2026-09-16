/**
 * 域镜像分流契约（P3 第 11 段）：账号域为例。
 *
 * ## 这段代码的形状在 14 个域模块里重复出现，所以规则必须钉死一次
 *
 * 每个域都是"纯 CRUD + 同步读"。走**通用域镜像**（按表加载 → 同步读 → 写穿 + 本地更新）。
 * 路由规则与事件/消息镜像同源：**只有镜像加载完成后才切换** ——
 * 否则会出现"写进 Rust、读到的还是旧值"（读与写落在不同处）。
 *
 * 另外两条边界也要钉住：
 * - 表**超过镜像上限**时放弃镜像并回退旧路径（避免某天图谱涨到十万行压死渲染进程）；
 * - 语义化写操作（`setActiveAccount` 的"先清空再置位"）不能退化成普通 upsert，
 *   必须保持"只有一个 active"这个不变量。
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { setStoragePort } from "../core/storage/port";
import { RustStoragePort } from "../core/storage/rust-port";

vi.mock("../core/storage/database", () => ({
  getDatabase: () => {
    throw new Error("旧库不应在已路由的域上被访问");
  },
  persistDatabase: () => {},
}));
vi.mock("../core/storage/write-guard", () => ({ runGuarded: () => undefined }));
const failures: string[] = [];
vi.mock("../core/storage/persist-failure", () => ({
  reportPersistFailure: (_s: string, _e: unknown, note: string) => failures.push(note),
  reportActionFailure: (_s: string, _e: unknown, note: string) => failures.push(note),
}));

const settle = async () => {
  for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 1));
};

/** 假端口：`crud.list` 返回给定行；记录 `crud.upsert` / `crud.delete` */
function portWith(rows: Array<Record<string, unknown>>, opts: { rowCount?: number } = {}) {
  const executed: Array<{ cmd: string; params: Record<string, unknown> }> = [];
  const total = opts.rowCount ?? rows.length;
  const transport = {
    invokeCommand: async (command: string, params?: Record<string, unknown>) => {
      if (command === "crud.list") {
        const p = params ?? {};
        const limit = Number(p.limit ?? 1000);
        const offset = Number(p.offset ?? 0);
        // 模拟 engine 的分页：按 offset/limit 切片，并给出 has_more
        const all = Array.from({ length: total }, (_, i) => rows[i] ?? { id: `pad-${i}` });
        const items = all.slice(offset, offset + limit);
        return { ok: true, result: { items, has_more: offset + items.length < total, next_cursor: null } } as never;
      }
      if (command === "settings.get_all") return { ok: true, result: {} } as never;
      if (command === "config_warmup") return { ok: true, result: {} } as never;
      return { ok: true, result: { written: 1 } } as never;
    },
    invokeBatch: async () => ({ ok: true, result: { count: 0, results: [] } }) as never,
    health: async () => ({ ok: true, result: { ready: true, engine: "rust" } }) as never,
    integrityCheck: async () => ({ ok: true, result: { ok: true } }) as never,
    checkpoint: async () => ({ ok: true, result: { ok: true } }) as never,
    capabilities: async () => ({ commands: [] }) as never,
  };
  const port = new RustStoragePort(transport as never, (_s, _e, note) => failures.push(note));
  // 记录 data.execute（RustStoragePort 内部持有 transport，这里用 spy 更直接）
  const origExecute = port.data.execute.bind(port.data);
  port.data.execute = async (cmd: string, params: Record<string, unknown> = {}) => {
    executed.push({ cmd, params });
    return origExecute(cmd, params);
  };
  return { port, executed };
}

function accountRow(over: Record<string, unknown> = {}) {
  return {
    id: "a1",
    email: "a1@example.com",
    url: "https://a1",
    access_token: "tok-a1",
    refresh_token: null,
    token_expiry: null,
    org_id: null,
    is_active: 0,
    created_at: 1,
    updated_at: 1,
    ...over,
  };
}

afterEach(() => {
  setStoragePort(null);
  failures.length = 0;
  vi.restoreAllMocks();
});

describe("域镜像分流 —— 账号域", () => {
  it("DOM-1: 镜像加载完成后，列表读走镜像且不碰旧库", async () => {
    const { port } = portWith([accountRow({ id: "a1" }), accountRow({ id: "a2", email: "a2@example.com" })]);
    setStoragePort(port);
    await port.start();
    port.domains.ensureLoaded("accounts");
    await settle();

    const { listAccounts } = await import("../core/storage/account");
    const list = listAccounts();
    expect(list.map((a) => a.id).sort()).toEqual(["a1", "a2"]);
    expect(list[0].email).toBeDefined();
  });

  it("DOM-2: 排序与旧实现一致（updated_at DESC）", async () => {
    const { port } = portWith([
      accountRow({ id: "old", updated_at: 10 }),
      accountRow({ id: "new", updated_at: 20 }),
    ]);
    setStoragePort(port);
    await port.start();
    port.domains.ensureLoaded("accounts");
    await settle();

    const { listAccounts } = await import("../core/storage/account");
    expect(listAccounts().map((a) => a.id)).toEqual(["new", "old"]);
  });

  it("DOM-3: 未加载完的域不路由（读与写必须同处）", async () => {
    const { port } = portWith([accountRow()]);
    setStoragePort(port);
    await port.start();
    // 刻意不 ensureLoaded → 未就绪
    expect(port.domains.isReady("accounts")).toBe(false);

    const { getAccount } = await import("../core/storage/account");
    // 未路由 → 走旧库（被 mock 成抛错）→ 原实现会把错误抛出（这里只断言"没有走镜像"）
    expect(() => getAccount("a1")).toThrow();
  });

  it("DOM-4: 写入走 crud.upsert 且本地镜像立刻可读", async () => {
    const { port, executed } = portWith([]);
    setStoragePort(port);
    await port.start();
    port.domains.ensureLoaded("accounts");
    await settle();

    const { createAccount, getAccount } = await import("../core/storage/account");
    createAccount({
      id: "a9",
      email: "a9@example.com",
      url: "https://a9",
      accessToken: "tok",
      isActive: true,
      createdAt: 1,
      updatedAt: 2,
    });
    // 立刻可读（本地镜像已更新）
    expect(getAccount("a9")?.email).toBe("a9@example.com");
    await settle();
    const up = executed.find((e) => e.cmd === "crud.upsert");
    expect(up, "必须发出 crud.upsert").toBeTruthy();
    expect(up?.params.table).toBe("accounts");
    expect((up?.params.rows as Array<Record<string, unknown>>)[0]).toMatchObject({
      id: "a9",
      email: "a9@example.com",
      access_token: "tok",
      is_active: 1,
    });
  });

  it("DOM-5: 更新是「当前完整行 + 改动」整体 upsert（不漏列、不猜数据）", async () => {
    const { port, executed } = portWith([accountRow()]);
    setStoragePort(port);
    await port.start();
    port.domains.ensureLoaded("accounts");
    await settle();

    const { updateAccount, getAccount } = await import("../core/storage/account");
    updateAccount("a1", { email: "changed@example.com" });
    const after = getAccount("a1");
    expect(after?.email).toBe("changed@example.com");
    // 未被改动的列必须保留（否则会"静默丢字段"）
    expect(after?.accessToken).toBe("tok-a1");
    expect(after?.url).toBe("https://a1");

    const up = executed.find((e) => e.cmd === "crud.upsert");
    const row = (up?.params.rows as Array<Record<string, unknown>>)[0];
    expect(row.email).toBe("changed@example.com");
    expect(row.access_token, "未改动列必须一起写回").toBe("tok-a1");
  });

  it("DOM-6: setActiveAccount 保持「只有一个 active」的不变量", async () => {
    const { port, executed } = portWith([
      accountRow({ id: "a1", is_active: 1 }),
      accountRow({ id: "a2", is_active: 0 }),
      accountRow({ id: "a3", is_active: 0 }),
    ]);
    setStoragePort(port);
    await port.start();
    port.domains.ensureLoaded("accounts");
    await settle();

    const { setActiveAccount, getActiveAccount, listAccounts } = await import("../core/storage/account");
    setActiveAccount("a2");

    const active = listAccounts().filter((a) => a.isActive);
    expect(active.map((a) => a.id), "必须恰好一个 active").toEqual(["a2"]);
    expect(getActiveAccount()?.id).toBe("a2");

    const up = executed.find((e) => e.cmd === "crud.upsert");
    const rows = up?.params.rows as Array<Record<string, unknown>>;
    expect(rows.filter((r) => r.is_active === 1).map((r) => r.id)).toEqual(["a2"]);
  });

  it("DOM-7: 删除后立刻从镜像消失", async () => {
    const { port, executed } = portWith([accountRow({ id: "a1" }), accountRow({ id: "a2" })]);
    setStoragePort(port);
    await port.start();
    port.domains.ensureLoaded("accounts");
    await settle();

    const { deleteAccount, getAccount, listAccounts } = await import("../core/storage/account");
    deleteAccount("a1");
    expect(getAccount("a1")).toBeNull();
    expect(listAccounts().map((a) => a.id)).toEqual(["a2"]);
    await settle();
    const del = executed.find((e) => e.cmd === "crud.delete");
    expect(del?.params).toEqual({ table: "accounts", where: { id: "a1" } });
  });

  it("DOM-8: 表超过镜像上限 → 放弃镜像并回退旧路径（不把渲染进程压死）", async () => {
    // 造一个 5001 行的表（超过默认上限 5000）
    const { port } = portWith([], { rowCount: 5001 });
    setStoragePort(port);
    await port.start();
    port.domains.ensureLoaded("accounts");
    await settle();

    expect(port.domains.isReady("accounts"), "超上限必须放弃镜像").toBe(false);
    expect(port.domains.stats().refused, "应记录被拒绝的表").toContain("accounts");
    expect(failures.some((n) => n.includes("上限")), "应留痕说明原因").toBe(true);
  });

  it("DOM-9: 端口未注册（默认/回滚）时完全不接手", async () => {
    setStoragePort(null);
    const { listAccounts } = await import("../core/storage/account");
    // 旧库被 mock 成抛错 → 原实现会把错误抛出（证明走的是旧路径）
    expect(() => listAccounts()).toThrow();
  });

  it("DOM-10: 端口是 wasm 时不接手（回滚开关生效）", async () => {
    setStoragePort({
      kind: "wasm",
      engine: {} as never,
      data: {} as never,
      config: {} as never,
      append: {} as never,
    });
    const { listAccounts } = await import("../core/storage/account");
    expect(() => listAccounts()).toThrow();
  });
});
