/**
 * B1：手机新建的会话**写进桌面同一份库**，并且桌面立刻看得见。
 *
 * 为什么不用 mock 掉 `ProjectStorage/SessionStorage`：那只能证明"函数被调用了"，
 * 证明不了"桌面列表真的多了一条" —— 而后者才是判据要的（`flattenSessions` 是网关
 * 会话列表的**唯一**来源，也是桌面侧栏读的那张表）。这里用真实域镜像 + 假存储端口
 * （与 `domain-mirror.test.ts` 同一套夹具形态），把整条写路径跑一遍。
 *
 * 项目创建（`project.create`）需要真实文件系统判定目录存在，已在
 * `gateway-create.test.ts` 钉住网关契约；这里覆盖不依赖磁盘的会话创建路径。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { setStoragePort } from "../core/storage/port";
import { RustStoragePort } from "../core/storage/rust-port";
import { __awaitPendingWrites } from "../core/storage/domain-store";
import { listSessions } from "../core/storage/session";
import { useProjectStore } from "../core/store";
import { flattenSessions, gatewayCreateSession, gatewayListProjects } from "../core/remote/desktop-engine";

const failures: string[] = [];
vi.mock("../core/storage/persist-failure", () => ({
  reportPersistFailure: (_s: string, _e: unknown, note: string) => failures.push(note),
  reportActionFailure: (_s: string, _e: unknown, note: string) => failures.push(note),
  reportAdvisory: (_s: string, finding: unknown) => failures.push(typeof finding === "string" ? finding : String(finding)),
}));

const settle = async () => {
  for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

function projectRow(over: Record<string, unknown> = {}) {
  return {
    id: "p1",
    name: "demo",
    path: "D:\\work\\demo",
    description: null,
    pinned: 0,
    created_at: 1,
    last_accessed_at: 1,
    ...over,
  };
}

function portWith(rowsByTable: Record<string, Array<Record<string, unknown>>>) {
  const executed: Array<{ cmd: string; params: Record<string, unknown> }> = [];
  const transport = {
    invokeCommand: async (command: string, params: Record<string, unknown> = {}) => {
      const p = params;
      if (command === "crud.list") {
        const table = String(p.table ?? "");
        const all = rowsByTable[table] ?? [];
        const where = (p.where as Record<string, unknown> | undefined) ?? {};
        const matched = all.filter((r) => Object.entries(where).every(([k, v]) => r[k] === v));
        const offset = Number(p.offset ?? 0);
        const limit = Number(p.limit ?? 1000);
        const items = matched.slice(offset, offset + limit);
        return { ok: true, result: { items, has_more: offset + items.length < matched.length, next_cursor: null } } as never;
      }
      if (command === "crud.upsert") {
        const table = String(p.table ?? "");
        const target = (rowsByTable[table] ??= []);
        const incoming = (p.rows as Array<Record<string, unknown>> | undefined) ?? [];
        for (const row of incoming) {
          const at = target.findIndex((r) => r.id === row.id);
          if (at >= 0) target[at] = { ...target[at], ...row };
          else target.push(row);
        }
        return { ok: true, result: { written: incoming.length } } as never;
      }
      if (command === "crud.delete") return { ok: true, result: { written: 0 } } as never;
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
  const origExecute = port.data.execute.bind(port.data);
  port.data.execute = async (cmd: string, params: Record<string, unknown> = {}) => {
    executed.push({ cmd, params });
    return origExecute(cmd, params);
  };
  return { port, executed };
}

async function ready(rowsByTable: Record<string, Array<Record<string, unknown>>>) {
  const { port, executed } = portWith(rowsByTable);
  setStoragePort(port);
  await port.start();
  port.domains.ensureLoaded("projects");
  port.domains.ensureLoaded("sessions");
  await settle();
  return { port, executed, rowsByTable };
}

afterEach(() => {
  setStoragePort(null);
  failures.length = 0;
  useProjectStore.setState({ currentProject: null, sessions: [] });
  vi.restoreAllMocks();
});

describe("B1-DESKTOP-1 项目列表投影", () => {
  it("gatewayListProjects 读桌面 projects 表（不含内部 wx-workspace）", async () => {
    await ready({
      projects: [projectRow(), projectRow({ id: "wx-workspace", name: "微信", path: "C:\\wx" })],
      sessions: [],
    });
    const list = gatewayListProjects();
    expect(list).toEqual([{ id: "p1", name: "demo", path: "D:\\work\\demo", pinned: false, lastAccessedAt: 1 }]);
  });
});

describe("B1-DESKTOP-2 手机建会话 → 桌面列表出现同一条", () => {
  it("写进 sessions 表、当前项目内存列表立刻可见、flattenSessions 也看得到", async () => {
    const { rowsByTable } = await ready({ projects: [projectRow()], sessions: [] });
    const project = gatewayListProjects()[0];
    useProjectStore.setState({
      currentProject: { id: project.id, name: project.name, path: project.path, createdAt: 1, lastAccessedAt: 1 } as never,
      sessions: [],
    });

    const outcome = await gatewayCreateSession({ title: "手机建的会话", projectId: "p1" });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const created = outcome.value;
    expect(created.projectId).toBe("p1");
    expect(created.projectName).toBe("demo");
    expect(created.title).toBe("手机建的会话");

    // ① 库里有（桌面重启后仍在）
    expect(listSessions("p1").map((s) => s.id)).toContain(created.id);
    expect(rowsByTable.sessions?.some((s) => s.id === created.id)).toBe(true);
    // ② 桌面内存列表立刻有（不用等重载）
    expect(useProjectStore.getState().sessions.map((s) => s.id)).toContain(created.id);
    // ③ 网关/桌面的**唯一**会话列表源也看得到
    const flat = flattenSessions();
    expect(flat.find((s) => s.id === created.id)).toMatchObject({
      title: "手机建的会话",
      projectId: "p1",
      projectName: "demo",
    });
  });

  it("同名会话追加序号（侧栏可分辨）；未知项目 ⇒ NOT_FOUND 且不写库", async () => {
    const { executed } = await ready({ projects: [projectRow()], sessions: [] });
    const first = await gatewayCreateSession({ title: "同名", projectId: "p1" });
    const second = await gatewayCreateSession({ title: "同名", projectId: "p1" });
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.value.title).toBe("同名");
      expect(second.value.title).toBe("同名 · 2");
    }

    const before = executed.filter((e) => e.cmd === "crud.upsert" && e.params.table === "sessions").length;
    const bad = await gatewayCreateSession({ title: "x", projectId: "nope" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.code).toBe("NOT_FOUND");
      expect(bad.message).toContain("nope");
    }
    const after = executed.filter((e) => e.cmd === "crud.upsert" && e.params.table === "sessions").length;
    expect(after).toBe(before);
  });

  it("不选项目 ⇒ 全局会话（projectId 空串），出现在 flattenSessions 的全局段", async () => {
    await ready({ projects: [projectRow()], sessions: [] });
    const outcome = await gatewayCreateSession({ title: "全局会话" });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.projectId).toBe("");
    expect(flattenSessions().find((s) => s.id === outcome.value.id)?.projectId).toBe("");
  });
});
