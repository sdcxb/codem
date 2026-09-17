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

const failures: string[] = [];
vi.mock("../core/storage/persist-failure", () => ({
  reportPersistFailure: (_s: string, _e: unknown, note: string) => failures.push(note),
  reportActionFailure: (_s: string, _e: unknown, note: string) => failures.push(note),
}));

const settle = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

/**
 * 假端口。
 *
 * `rows` 可以是单个数组（则该数组会被当成**每一张表**的内容 —— 只适合单表用例），
 * 也可以是 `{ 表名: 行数组 }`。**多表用例必须用后者**：
 * 假端口如果对所有 `table` 都回同一份行，镜像里就会混入"不属于这张表的行"，
 * 断言会以莫名其妙的方式失败（这里踩过一次）。
 */
function portWith(
  rows: Array<Record<string, unknown>> | Record<string, Array<Record<string, unknown>>>,
  opts: { rowCount?: number } = {},
) {
  const executed: Array<{ cmd: string; params: Record<string, unknown> }> = [];
  const byTable = Array.isArray(rows) ? null : rows;
  const fallback = Array.isArray(rows) ? rows : [];
  const total = opts.rowCount ?? fallback.length;
  const rowsFor = (table: string) => (byTable ? byTable[table] ?? [] : fallback);
  const transport = {
    invokeCommand: async (command: string, params?: Record<string, unknown>) => {
      if (command === "crud.list") {
        const p = params ?? {};
        const table = String(p.table ?? "");
        const limit = Number(p.limit ?? 1000);
        const offset = Number(p.offset ?? 0);
        // 模拟 engine 的分页：按 offset/limit 切片，并给出 has_more
        const src = rowsFor(table);
        const count = byTable ? src.length : total;
        const all = Array.from({ length: count }, (_, i) => src[i] ?? { id: `pad-${i}` });
        const items = all.slice(offset, offset + limit);
        return { ok: true, result: { items, has_more: offset + items.length < count, next_cursor: null } } as never;
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
  vi.useRealTimers();
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
    /*
     * 契约更新（B4 批）：这里的期望从"抛错"改为"返回 null 且**不碰旧库**"。
     *
     * 原因：本文件的 `getDatabase` mock 是"一旦被访问就抛错"，所以
     * **不抛错本身就证明了旧库没被访问** —— 这是比原来更强的断言。
     *
     * 原断言的语义是"未路由 → 回退旧库 → 旧库抛错"，但那条回退只在
     * **端口未注册**（A 态）时才对；这里是 **B 态**（端口在 rust、镜像未就绪），
     * 而 rust 模式下旧库刻意不存在 —— 回退过去必然失败。所以 B 态的正确行为是
     * 由端口负责：读给该域的合理空结果（null），写删如实上报。
     */
    expect(getAccount("a1"), "B 态读给空结果").toBeNull();
    expect(failures.every((n) => !n.includes("旧库")), "不应有任何'回退旧库'的上报").toBe(true);
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

  it("DOM-9: 端口未注册时读路径**不抛**，返回诚实的空结果（第 17 轮 L4：A 态回退已删）", async () => {
    setStoragePort(null);
    const { listAccounts } = await import("../core/storage/account");
    /**
     * 这条用例原来断言的是 `toThrow()` —— 用"旧库被 mock 成抛错"来**证明走了旧路径**。
     * 而旧库在 rust 模式下刻意不存在，A 态（旧库回退）已在整个仓库删除
     * （见 `docs/ROLLBACK-SWITCH-RETIREMENT.md` 第八节），所以那个断言守的是一条死路径。
     *
     * 新契约（同样是"诚实"的，只是诚实的方式变了）：
     * 读路径在没有端口时**不抛**，返回该域的合理空结果 —— 调用方拿到 `[]`
     * （界面显示"没有账号"），而不是整块面板崩成"此面板不可用"。
     *
     * 第 19 轮：这里原来还有一条 DOM-10（`setStoragePort({kind:"wasm", …})`）断同样的东西。
     * 第 19 轮：wasm 端口形态已不存在（旧引擎删除），而"没有端口"是**唯一**的
     * "没有可用存储"形态，所以两条用例合并成这一条（`setStoragePort(null)`）——断言一条都没丢。
     */
    expect(listAccounts()).toEqual([]);
  });
});

describe("域镜像分流 —— v2_sessions / prompt_drafts / turn_file_changes", () => {
  it("DOM-11: v2_sessions 的 JSON 列往返保真（messages / total_usage）", async () => {
    const { port, executed } = portWith([]);
    setStoragePort(port);
    await port.start();
    port.domains.ensureLoaded("v2_sessions");
    await settle();

    const { saveV2Session, loadV2Sessions } = await import("../core/storage/v2-session");
    saveV2Session({
      id: "s1",
      projectId: "p1",
      title: "会话",
      model: "m",
      messages: [{ id: "m1", content: "内容" }],
      totalUsage: { promptTokens: 3, completionTokens: 4, cost: 0.5 },
      createdAt: 1,
      updatedAt: 2,
    } as never);

    const loaded = loadV2Sessions().get("s1");
    expect(loaded?.messages).toEqual([{ id: "m1", content: "内容" }]);
    expect(loaded?.totalUsage).toEqual({ promptTokens: 3, completionTokens: 4, cost: 0.5 });

    await settle();
    const up = executed.find((e) => e.cmd === "crud.upsert");
    const row = (up?.params.rows as Array<Record<string, unknown>>)[0];
    expect(row.messages, "JSON 列必须以文本落库").toBe(JSON.stringify([{ id: "m1", content: "内容" }]));
    expect(typeof row.total_usage).toBe("string");
  });

  it("DOM-12: prompt_drafts 版本号在镜像上算出同样结果（MAX(version)+1）", async () => {
    const { port, executed } = portWith([
      { id: "d1", session_id: "s1", version: 1, content: "第一版", tags: "[]", created_at: 1 },
      { id: "d2", session_id: "s1", version: 2, content: "第二版", tags: '["a"]', created_at: 2 },
    ]);
    setStoragePort(port);
    await port.start();
    port.domains.ensureLoaded("prompt_drafts");
    await settle();

    const { savePromptDraft, loadPromptDrafts } = await import("../core/storage/prompt-draft");
    const id = savePromptDraft("s1", "第三版", ["x"]);
    const list = loadPromptDrafts("s1");
    expect(list.map((d) => d.version), "应按 version DESC").toEqual([3, 2, 1]);
    expect(list[0].id).toBe(id);
    expect(list[0].tags).toEqual(["x"]);

    await settle();
    const up = executed.find((e) => e.cmd === "crud.upsert");
    const row = (up?.params.rows as Array<Record<string, unknown>>)[0];
    expect(row.version, "新版本号必须是 3（旧实现是 MAX(version)+1）").toBe(3);
  });

  it("DOM-13: turn_file_changes.updateStatus 保住 A 类语义（不存在时返回 0）", async () => {
    const { port } = portWith([
      {
        id: "t1",
        session_id: "s1",
        message_id: "m1",
        turn_index: 1,
        before_tree: null,
        after_tree: null,
        patch: null,
        changed_files: null,
        patch_sha256: null,
        current_brief: null,
        status: "completed",
        created_at: 1,
      },
    ]);
    setStoragePort(port);
    await port.start();
    port.domains.ensureLoaded("turn_file_changes");
    await settle();

    const { FileChangeStorage } = await import("../core/storage/file-change-storage");
    // 存在 → 更新成功，返回 1，且立刻可读
    expect(FileChangeStorage.updateStatus("t1", "reverted")).toBe(1);
    expect(FileChangeStorage.getById("t1")?.status).toBe("reverted");

    // 不存在 → 必须返回 0（第 84 波修过的 A 类问题：不能静默当成成功）
    expect(FileChangeStorage.updateStatus("nope", "reverted")).toBe(0);

    // 列表按 turn_index DESC
    expect(FileChangeStorage.listBySession("s1").map((r) => r.id)).toEqual(["t1"]);
  });

  it("DOM-14: turn_file_changes 删除按会话生效（不牵连别的会话）", async () => {
    const { port } = portWith([
      { id: "t1", session_id: "s1", message_id: "m", turn_index: 1, status: "completed", created_at: 1 },
      { id: "t2", session_id: "s2", message_id: "m", turn_index: 1, status: "completed", created_at: 1 },
    ]);
    setStoragePort(port);
    await port.start();
    port.domains.ensureLoaded("turn_file_changes");
    await settle();

    const { FileChangeStorage } = await import("../core/storage/file-change-storage");
    FileChangeStorage.deleteBySession("s1");
    expect(FileChangeStorage.listBySession("s1")).toEqual([]);
    expect(FileChangeStorage.listBySession("s2"), "别的会话不该被牵连").toHaveLength(1);
  });
});

// ========== 目标域（goals） ==========

function goalRow(over: Record<string, unknown> = {}) {
  return {
    id: "g1",
    session_id: "s1",
    title: "目标",
    description: null,
    status: "pending",
    priority: "normal",
    parent_id: null,
    success_criteria: null,
    created_at: 1,
    updated_at: 1,
    completed_at: null,
    ...over,
  };
}

describe("域镜像分流 —— goals", () => {
  it("DOM-15: listGoals 的过滤与排序与旧 SQL 逐字一致（priority DESC, created_at ASC）", async () => {
    const { port } = portWith([
      goalRow({ id: "g-low", priority: "low", created_at: 5 }),
      goalRow({ id: "g-high-late", priority: "high", created_at: 9 }),
      goalRow({ id: "g-high-early", priority: "high", created_at: 3 }),
      goalRow({ id: "g-normal", priority: "normal", created_at: 7 }),
      goalRow({ id: "g-other-session", session_id: "s2", priority: "high", created_at: 1 }),
    ]);
    setStoragePort(port);
    await port.start();
    port.domains.ensureLoaded("goals");
    await settle();

    const { listGoals } = await import("../core/goal/goal");
    // 旧实现是 TEXT 列的 BINARY 排序 → DESC 得到 normal → low → high（反直觉但必须一致）；
    // 同优先级按 created_at ASC
    const expectOrder = ["g-normal", "g-low", "g-high-early", "g-high-late"];
    expect(listGoals("s1").map((g) => g.id)).toEqual(expectOrder);
    // status 过滤必须生效（旧实现是拼在 SQL 里的 AND status = ?）
    expect(listGoals("s1", "pending").map((g) => g.id)).toEqual(expectOrder);
    expect(listGoals("s1", "completed")).toEqual([]);
  });

  it("DOM-16: getGoal 走镜像但保留「没有这行」与「没接手」的区别", async () => {
    const { port } = portWith([goalRow({ id: "g1", title: "存在的目标", description: "说明" })]);
    setStoragePort(port);
    await port.start();
    port.domains.ensureLoaded("goals");
    await settle();

    const { getGoal } = await import("../core/goal/goal");
    expect(getGoal("g1")?.title).toBe("存在的目标");
    expect(getGoal("g1")?.description).toBe("说明");
    // 行不存在必须返回 null（而不是让调用方去读一个被 mock 成抛错的旧库）
    expect(getGoal("nope")).toBeNull();
  });

  it("DOM-17: createGoal 落库列名与旧 INSERT 一致，且立刻可读", async () => {
    const { port, executed } = portWith([]);
    setStoragePort(port);
    await port.start();
    port.domains.ensureLoaded("goals");
    await settle();

    const { createGoal, getGoal } = await import("../core/goal/goal");
    const created = createGoal({
      sessionId: "s1",
      title: "新目标",
      status: "pending",
      priority: "high",
      successCriteria: "标准",
    });
    expect(created.id.startsWith("goal-")).toBe(true);
    expect(created.createdAt).toBeGreaterThan(0);
    // 写完立刻可读（本地镜像已更新）
    expect(getGoal(created.id)?.successCriteria).toBe("标准");

    await settle();
    const up = executed.find((e) => e.cmd === "crud.upsert");
    expect(up?.params.table).toBe("goals");
    const row = (up?.params.rows as Array<Record<string, unknown>>)[0];
    expect(row).toMatchObject({
      id: created.id,
      session_id: "s1",
      title: "新目标",
      priority: "high",
      success_criteria: "标准",
      description: null,
    });
    expect(typeof row.completed_at !== "undefined", "列必须显式列出（整体 upsert 缺列会被写 NULL）").toBe(true);
  });

  it("DOM-18: updateGoal 整体写回，未改动列不丢，completed 时补 completed_at", async () => {
    const { port, executed } = portWith([
      goalRow({ id: "g1", title: "旧标题", description: "旧说明", priority: "high", success_criteria: "旧标准" }),
    ]);
    setStoragePort(port);
    await port.start();
    port.domains.ensureLoaded("goals");
    await settle();

    const { updateGoal, getGoal } = await import("../core/goal/goal");
    updateGoal("g1", { title: "新标题", status: "completed" });

    const after = getGoal("g1");
    expect(after?.title).toBe("新标题");
    expect(after?.status).toBe("completed");
    expect(after?.completedAt, "status=completed 必须补 completed_at").toBeGreaterThan(0);
    expect(after?.description, "未改动列必须保留").toBe("旧说明");
    expect(after?.successCriteria).toBe("旧标准");
    expect(after?.priority).toBe("high");

    await settle();
    const up = executed.find((e) => e.cmd === "crud.upsert");
    expect(up?.params.mode, "整体替换语义").toBe("replace");
    const row = (up?.params.rows as Array<Record<string, unknown>>)[0];
    expect(row.description, "未改动列必须一起写回").toBe("旧说明");
    expect(row.completed_at).toBe(after?.completedAt);

    // 目标不存在 → 什么都不写（与旧实现 UPDATE 影响 0 行一致）
    const before = executed.filter((e) => e.cmd === "crud.upsert").length;
    updateGoal("nope", { title: "x" });
    expect(executed.filter((e) => e.cmd === "crud.upsert").length).toBe(before);
  });
});

// ========== 收件箱域（inbox） ==========

function inboxRow(over: Record<string, unknown> = {}) {
  return {
    id: "i1",
    category: "issue",
    title: "通知",
    body: null,
    source_type: null,
    source_id: null,
    project_id: null,
    squad_id: null,
    issue_id: null,
    priority: "normal",
    read: 0,
    archived: 0,
    created_at: 100,
    ...over,
  };
}

describe("域镜像分流 —— inbox", () => {
  it("DOM-19: listAll 与旧 SQL 的三条过滤 + created_at DESC + LIMIT 100 一致", async () => {
    const rows = [
      inboxRow({ id: "i-p1-unread", project_id: "p1", created_at: 30 }),
      inboxRow({ id: "i-global", project_id: null, created_at: 20 }),
      inboxRow({ id: "i-p2", project_id: "p2", created_at: 10 }),
      inboxRow({ id: "i-read", project_id: "p1", read: 1, created_at: 40 }),
      inboxRow({ id: "i-archived", project_id: "p1", archived: 1, created_at: 50 }),
      inboxRow({ id: "i-squad", category: "squad", project_id: "p1", created_at: 60 }),
    ];
    // 再加 100 行，验证 LIMIT 100 确实生效
    for (let i = 0; i < 100; i++) {
      rows.push(inboxRow({ id: `i-bulk-${i}`, project_id: "p9", created_at: 1 }));
    }
    const { port } = portWith(rows);
    setStoragePort(port);
    await port.start();
    port.domains.ensureLoaded("inbox");
    await settle();

    const { InboxStorage } = await import("../core/inbox/inbox-storage");
    // 归档的永不出现
    expect(InboxStorage.listAll().some((r) => r.id === "i-archived")).toBe(false);
    // created_at DESC
    expect(InboxStorage.listAll()[0].id).toBe("i-squad");
    // LIMIT 100
    expect(InboxStorage.listAll()).toHaveLength(100);
    // projectId：命中本工程 **或** 全局（project_id IS NULL），且未读优先
    expect(InboxStorage.listAll({ projectId: "p1" }).map((r) => r.id).sort()).toEqual([
      "i-global",
      "i-p1-unread",
      "i-read",
      "i-squad",
    ]);
    expect(InboxStorage.listAll({ projectId: "p1", unreadOnly: true }).map((r) => r.id).sort()).toEqual([
      "i-global",
      "i-p1-unread",
      "i-squad",
    ]);
    expect(InboxStorage.listAll({ projectId: "p1", unreadOnly: true, category: "issue" }).map((r) => r.id).sort()).toEqual([
      "i-global",
      "i-p1-unread",
    ]);
  });

  it("DOM-20: getUnreadCount / markRead / archive / delete 在镜像上语义不变", async () => {
    const { port, executed } = portWith([
      inboxRow({ id: "i1", project_id: "p1" }),
      inboxRow({ id: "i2", project_id: null }),
      inboxRow({ id: "i3", project_id: "p2" }),
      inboxRow({ id: "i4", project_id: "p1", read: 1 }),
      inboxRow({ id: "i5", project_id: "p1", archived: 1 }),
    ]);
    setStoragePort(port);
    await port.start();
    port.domains.ensureLoaded("inbox");
    await settle();

    const { InboxStorage } = await import("../core/inbox/inbox-storage");
    expect(InboxStorage.getUnreadCount()).toBe(3); // i1 i2 i3
    expect(InboxStorage.getUnreadCount("p1")).toBe(2); // i1 + 全局 i2

    // markRead：只改目标行
    InboxStorage.markRead("i1");
    expect(InboxStorage.getUnreadCount("p1")).toBe(1);
    // 不存在的 id：**任何写都不能发生**。
    // 旧实现是 `UPDATE … WHERE id = ?` 影响 0 行；镜像路径若照搬"读出来再整体 upsert"，
    // 就会 upsert 出一行幽灵通知（踩过一次），所以这里要按 `=== null` 判空。
    const unreadBefore = InboxStorage.getUnreadCount();
    InboxStorage.markRead("nope");
    InboxStorage.archive("nope");
    expect(InboxStorage.getUnreadCount(), "不存在的 id 不该产生任何行").toBe(unreadBefore);
    expect(InboxStorage.listAll()).toHaveLength(4); // i1 i2 i3 i4（i5 已归档）

    // archive：从列表消失、且不再计入未读
    InboxStorage.archive("i2");
    expect(InboxStorage.listAll().some((r) => r.id === "i2")).toBe(false);
    expect(InboxStorage.getUnreadCount()).toBe(1);

    // delete
    InboxStorage.delete("i3");
    expect(InboxStorage.getUnreadCount()).toBe(0);

    await settle();
    const upserts = executed.filter((e) => e.cmd === "crud.upsert");
    expect(upserts.length, "两次写穿（markRead / archive），幽灵写必须是 0 次").toBe(2);
    for (const up of upserts) {
      expect(up.params.mode).toBe("replace");
      const row = (up.params.rows as Array<Record<string, unknown>>)[0];
      expect(row.title, "整体写回必须带上未改动列").toBe("通知");
    }
    expect(executed.filter((e) => e.cmd === "crud.delete")[0]?.params).toEqual({
      table: "inbox",
      where: { id: "i3" },
    });
  });

  it("DOM-21: markAllRead 只碰未读，且全局通知也算命中", async () => {
    const { port, executed } = portWith([
      inboxRow({ id: "i1", project_id: "p1" }),
      inboxRow({ id: "i2", project_id: null }),
      inboxRow({ id: "i3", project_id: "p2" }),
      inboxRow({ id: "i4", project_id: "p1", read: 1 }),
    ]);
    setStoragePort(port);
    await port.start();
    port.domains.ensureLoaded("inbox");
    await settle();

    const { InboxStorage } = await import("../core/inbox/inbox-storage");
    InboxStorage.markAllRead("p1");
    expect(InboxStorage.getUnreadCount("p1"), "p1 + 全局都已读").toBe(0);
    expect(InboxStorage.getUnreadCount(), "p2 不受影响").toBe(1);

    await settle();
    const up = executed.find((e) => e.cmd === "crud.upsert");
    const ids = (up?.params.rows as Array<Record<string, unknown>>).map((r) => r.id).sort();
    expect(ids, "已读的 i4 不该被重复写").toEqual(["i1", "i2"]);
  });

  it("DOM-22: create 顺手清 30 天外的通知，且清理走域端口（不会把删掉的行写回 Rust）", async () => {
    const day = 24 * 60 * 60 * 1000;
    vi.useFakeTimers();
    const now = new Date("2026-03-01T00:00:00Z").getTime();
    vi.setSystemTime(now);

    const { port, executed } = portWith([
      inboxRow({ id: "old", created_at: now - 40 * day }),
      inboxRow({ id: "fresh", created_at: now - 2 * day }),
      // 边界：刚好 30 天内（29 天 23 小时）→ 不能被杀
      inboxRow({ id: "edge", created_at: now - 30 * day + 60 * 60 * 1000 }),
    ]);
    setStoragePort(port);
    await port.start();
    port.domains.ensureLoaded("inbox");
    await settle();

    const { InboxStorage } = await import("../core/inbox/inbox-storage");
    const created = InboxStorage.create({
      id: "new",
      category: "system",
      title: "新通知",
      body: null,
      source_type: null,
      source_id: null,
      project_id: null,
      squad_id: null,
      issue_id: null,
      priority: "normal",
    });
    expect(created.read).toBe(0);
    expect(created.created_at, "时间必须可复现（假时钟）").toBe(now);
    expect(created.priority).toBe("normal");

    // 40 天前的必须立刻从镜像消失（不能等到下次重载）
    expect(
      InboxStorage.listAll().some((r) => r.id === "old"),
      "40 天前的通知必须已被清掉",
    ).toBe(false);
    expect(InboxStorage.listAll().some((r) => r.id === "fresh")).toBe(true);
    expect(InboxStorage.listAll().some((r) => r.id === "edge"), "未过期的不能被误杀").toBe(true);

    await settle();
    const del = executed.filter((e) => e.cmd === "crud.delete");
    expect(
      del.map((d) => (d.params.where as Record<string, unknown>).id),
      "只该删掉过期那一条，且按 id 写穿（线协议 where 不支持范围条件）",
    ).toEqual(["old"]);

    // deleteOlderThan 是同一个原语：范围条件是**显式时间戳**，没有 TTL 算术，
    // 所以用两个时间点精确钉住「过了期的删、没过的留」。
    // 时间算术不要靠心算：now-5天 = 1771891200000 < fresh(now-2天 = 1772150400000)
    //                                < edge(now-30天+1小时 = 1769734800000)？ 用 node 核对过再写断言。
    InboxStorage.deleteOlderThan(now - 3 * day); // 只留 3 天内 → fresh 与 new
    expect(InboxStorage.listAll().map((r) => r.id).sort()).toEqual(["fresh", "new"]);

    InboxStorage.deleteOlderThan(now - day); // 只留 1 天内 → 只剩刚创建的
    expect(InboxStorage.listAll().map((r) => r.id)).toEqual(["new"]);
  });
});

// ========== 智能体画像（agent_profiles） ==========

describe("域镜像分流 —— agent_profiles", () => {
  it("DOM-23: skills 的 JSON 往返与 update 的列保留（未知 key 不进 upsert）", async () => {
    // 必须让 `Date.now()` 也走假时钟：`update` 会写 `updated_at = Date.now()`，
    // 而真实时间可能早于固定基准，排序断言就会莫名其妙地翻过来（这里踩过一次）。
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-01T00:00:00Z").getTime());
    const { port, executed } = portWith([
      {
        id: "p1",
        identity: "审查者",
        domain: "代码",
        scope: "review",
        skills: '["ts","rust"]',
        experience_summary: "旧摘要",
        created_at: 1,
        updated_at: 1,
      },
    ]);
    setStoragePort(port);
    await port.start();
    port.domains.ensureLoaded("agent_profiles");
    await settle();

    const { AgentProfileStorage } = await import("../core/storage/agent-profile-storage");
    // 读：JSON 文本 → 数组
    expect(AgentProfileStorage.getById("p1")?.skills).toEqual(["ts", "rust"]);

    // 写：数组 → JSON 文本，未改动列保留，未知 key 被忽略
    AgentProfileStorage.update("p1", {
      skills: ["go"],
      experience_summary: "新摘要",
      // @ts-expect-error 故意塞未知列：旧实现会把它拼进 SQL（会报错或写错列）
      bogus: "不该出现",
    });
    const after = AgentProfileStorage.getById("p1");
    expect(after?.skills).toEqual(["go"]);
    expect(after?.experience_summary).toBe("新摘要");
    expect(after?.identity).toBe("审查者");
    expect(after?.domain).toBe("代码");
    expect(after?.updated_at).toBeGreaterThan(1);

    await settle();
    const up = executed.find((e) => e.cmd === "crud.upsert");
    const row = (up?.params.rows as Array<Record<string, unknown>>)[0];
    expect(row.skills).toBe('["go"]');
    expect(row).not.toHaveProperty("bogus");
    expect(row.identity, "未改动列必须一起写回").toBe("审查者");

    // 新增 + 列表排序（updated_at DESC）+ 删除。
    // 时间必须**推进**再建：假时钟是冻结的，同一毫秒创建的两行 `updated_at` 相同，
    // 排序就是并列（结果取决于实现里的比较细节），那样的断言没有意义。
    const createdAt = new Date("2026-03-01T01:00:00Z").getTime();
    vi.setSystemTime(createdAt);
    const created = AgentProfileStorage.create({
      id: "p2",
      identity: "执行者",
      domain: "构建",
      scope: "build",
    });
    expect(created.updated_at).toBe(createdAt);
    expect(AgentProfileStorage.listAll().map((p) => p.id)).toEqual(["p2", "p1"]);
    AgentProfileStorage.delete(created.id);
    expect(AgentProfileStorage.listAll().map((p) => p.id)).toEqual(["p1"]);
    expect(AgentProfileStorage.getById("p2")).toBeNull();
  });
});

// ========== 议题域（issues + issue_comments） ==========

function issueRow(over: Record<string, unknown> = {}) {
  return {
    id: "is1",
    title: "议题",
    description: null,
    status: "todo",
    priority: "normal",
    assignee_type: null,
    assignee_id: null,
    project_id: null,
    squad_id: null,
    session_id: null,
    labels: null,
    created_at: 1,
    updated_at: 1,
    ...over,
  };
}

describe("域镜像分流 —— issues", () => {
  it("DOM-24: update 保住 A 类语义（空 updates→0，不存在→0，存在→1）", async () => {
    const { port, executed } = portWith([
      issueRow({ id: "is1", title: "原标题", project_id: "p1", description: "原说明" }),
    ]);
    setStoragePort(port);
    await port.start();
    port.domains.ensureLoaded("issues");
    await settle();

    const { IssueStorage } = await import("../core/issue/issue-storage");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    // 空 updates 必须返回 0（第 84 波修的 A 类问题：调用方会误以为"已更新"）
    expect(IssueStorage.update("is1", {})).toBe(0);
    expect(warn, "空更新必须留痕").toHaveBeenCalled();
    // 议题不存在也必须返回 0
    expect(IssueStorage.update("nope", { title: "x" })).toBe(0);
    // 存在 → 1，且未改动列保留
    expect(IssueStorage.update("is1", { status: "done" })).toBe(1);
    const after = IssueStorage.getById("is1");
    expect(after?.status).toBe("done");
    expect(after?.description).toBe("原说明");
    expect(after?.project_id).toBe("p1");

    await settle();
    const upserts = executed.filter((e) => e.cmd === "crud.upsert");
    expect(upserts.length, "空更新与不存在的议题都不能产生写入").toBe(1);
    expect((upserts[0].params.rows as Array<Record<string, unknown>>)[0].description).toBe("原说明");
  });

  it("DOM-25: 过滤/排序/统计与旧 SQL 一致，且评论落库时顶起议题 updated_at", async () => {
    const { port, executed } = portWith({
      issues: [
        issueRow({ id: "a", status: "todo", project_id: "p1", squad_id: "q1", assignee_id: "u1", updated_at: 10 }),
        issueRow({ id: "b", status: "done", project_id: "p1", updated_at: 20 }),
        issueRow({ id: "c", status: "todo", project_id: "p2", updated_at: 30 }),
      ],
      issue_comments: [
        {
          id: "cm1",
          issue_id: "a",
          author_type: "agent",
          author_id: null,
          author_name: "助手",
          content: "评论",
          is_system: 0,
          created_at: 50,
        },
      ],
    });
    setStoragePort(port);
    await port.start();
    port.domains.ensureLoaded("issues");
    port.domains.ensureLoaded("issue_comments");
    await settle();

    const { IssueStorage } = await import("../core/issue/issue-storage");
    // updated_at DESC
    expect(IssueStorage.listAll().map((r) => r.id)).toEqual(["c", "b", "a"]);
    expect(IssueStorage.listAll({ projectId: "p1" }).map((r) => r.id)).toEqual(["b", "a"]);
    expect(IssueStorage.listAll({ status: "todo" }).map((r) => r.id)).toEqual(["c", "a"]);
    expect(IssueStorage.listAll({ squadId: "q1" }).map((r) => r.id)).toEqual(["a"]);
    expect(IssueStorage.listAll({ assigneeId: "u1" }).map((r) => r.id)).toEqual(["a"]);
    // GROUP BY status
    expect(IssueStorage.getStats()).toMatchObject({ todo: 2, done: 1, backlog: 0, cancelled: 0 });
    expect(IssueStorage.getStats("p1")).toMatchObject({ todo: 1, done: 1 });

    // 评论：只读本议题、按 created_at ASC
    expect(IssueStorage.getComments("a").map((r) => r.id)).toEqual(["cm1"]);
    expect(IssueStorage.getComments("b")).toEqual([]);

    // 新增评论 → 议题 updated_at 被顶起（旧实现是 UPDATE issues SET updated_at）
    const before = IssueStorage.getById("a")!.updated_at;
    const comment = IssueStorage.addComment({
      id: "cm2",
      issue_id: "a",
      author_type: "user",
      author_id: "me",
      author_name: null,
      content: "第二条",
      is_system: 0,
    });
    expect(comment.created_at).toBeGreaterThan(0);
    expect(IssueStorage.getById("a")!.updated_at).toBeGreaterThan(before);
    expect(IssueStorage.getComments("a").map((r) => r.id)).toEqual(["cm1", "cm2"]);

    // 给**不存在**的议题加评论：不能 upsert 出一行幽灵议题
    IssueStorage.addComment({
      id: "cm3",
      issue_id: "ghost",
      author_type: "user",
      author_id: null,
      author_name: null,
      content: "幽灵",
      is_system: 1,
    });
    expect(IssueStorage.getById("ghost"), "不存在的议题不该被凭空创建").toBeNull();

    await settle();
    const tables = executed.filter((e) => e.cmd === "crud.upsert").map((e) => e.params.table);
    // 两条评论各写一次；议题只在"评论挂到真实议题上"时被 touch 一次
    // （挂到不存在的议题上时**什么都不写** —— 否则会 upsert 出一行幽灵议题）
    expect(tables.filter((t) => t === "issue_comments").length).toBe(2);
    expect(tables.filter((t) => t === "issues").length, "touch 只发生在真实议题上").toBe(1);
  });
});

// ========== 团队域（squads + squad_members） ==========

function squadRow(over: Record<string, unknown> = {}) {
  return {
    id: "sq1",
    name: "团队",
    leader_agent_id: "ag1",
    instructions: null,
    project_id: null,
    archived: 0,
    created_at: 1,
    updated_at: 1,
    ...over,
  };
}

describe("域镜像分流 —— squads", () => {
  it("DOM-26: 归档可见性与项目过滤与旧 SQL 一致；空更新不写库", async () => {
    const { port, executed } = portWith({
      squads: [
        squadRow({ id: "s1", project_id: "p1", updated_at: 10 }),
        squadRow({ id: "s2", project_id: "p2", updated_at: 20 }),
        squadRow({ id: "s3", project_id: "p1", archived: 1, updated_at: 30 }),
      ],
      squad_members: [
        {
          id: "m1",
          squad_id: "s1",
          member_type: "agent",
          member_id: "ag1",
          member_name: "甲",
          role_description: null,
          created_at: 5,
        },
      ],
    });
    setStoragePort(port);
    await port.start();
    port.domains.ensureLoaded("squads");
    port.domains.ensureLoaded("squad_members");
    await settle();

    const { SquadStorage } = await import("../core/squad/squad-storage");
    // 默认排除已归档 + updated_at DESC
    expect(SquadStorage.listAll().map((s) => s.id)).toEqual(["s2", "s1"]);
    expect(SquadStorage.listAll(true).map((s) => s.id)).toEqual(["s3", "s2", "s1"]);
    expect(SquadStorage.listByProject("p1").map((s) => s.id)).toEqual(["s1"]);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const beforeCount = executed.length;
    SquadStorage.update("s1", {});
    expect(executed.length, "空更新不能产生任何写入").toBe(beforeCount);
    expect(warn).toHaveBeenCalled();
    SquadStorage.update("nope", { name: "x" });
    expect(executed.length, "不存在的团队也不能产生写入").toBe(beforeCount);

    // 正常更新：改名 + 未改动列保留
    SquadStorage.update("s1", { name: "新名字" });
    expect(SquadStorage.getById("s1")?.name).toBe("新名字");
    expect(SquadStorage.getById("s1")?.leader_agent_id).toBe("ag1");

    // 归档：从默认列表消失
    SquadStorage.archive("s2");
    expect(SquadStorage.listAll().map((s) => s.id)).toEqual(["s1"]);

    // 成员：按 created_at ASC；改角色不丢其它列；移除生效
    expect(SquadStorage.getMembers("s1").map((m) => m.id)).toEqual(["m1"]);
    SquadStorage.updateMemberRole("m1", "负责构建");
    expect(SquadStorage.getMembers("s1")[0].role_description).toBe("负责构建");
    expect(SquadStorage.getMembers("s1")[0].member_name).toBe("甲");
    SquadStorage.updateMemberRole("ghost", "x"); // 不存在 → 不写
    expect(SquadStorage.getMembers("s1")).toHaveLength(1);
    SquadStorage.removeMember("m1");
    expect(SquadStorage.getMembers("s1")).toEqual([]);
  });
});

// ========== 闪卡域（flashcards） ==========

function cardRow(over: Record<string, unknown> = {}) {
  return {
    id: "fc1",
    notebook_id: "nb1",
    note_id: null,
    front: "正面",
    back: "背面",
    tags: null,
    ease_factor: 2.5,
    interval_days: 0,
    repetitions: 0,
    next_review: 100,
    created_at: 1,
    updated_at: 1,
    ...over,
  };
}

describe("域镜像分流 —— flashcards", () => {
  it("DOM-27: tags JSON 往返、到期过滤、SM-2 复习结果与旧实现一致", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-03-01T00:00:00Z").getTime();
    vi.setSystemTime(now);

    const { port, executed } = portWith([
      cardRow({ id: "due", notebook_id: "nb1", note_id: "n1", tags: '["a"]', next_review: now - 1, created_at: 5 }),
      cardRow({ id: "later", notebook_id: "nb1", next_review: now + 10_000, created_at: 9 }),
      cardRow({ id: "other-nb", notebook_id: "nb2", next_review: now - 1 }),
    ]);
    setStoragePort(port);
    await port.start();
    port.domains.ensureLoaded("flashcards");
    await settle();

    const { getDueFlashcards, getDueFlashcardsByNote, listFlashcards, reviewFlashcard, updateFlashcard } =
      await import("../core/knowledge/flashcard-store");

    expect(listFlashcards("nb1").map((c) => c.id), "next_review ASC, created_at DESC").toEqual(["due", "later"]);
    expect(getDueFlashcards("nb1").map((c) => c.id)).toEqual(["due"]);
    expect(getDueFlashcardsByNote("n1").map((c) => c.id)).toEqual(["due"]);
    // tags JSON → 数组
    expect(listFlashcards("nb1")[0].tags).toEqual(["a"]);

    // SM-2：repetitions 0 → 通过一次后 intervalDays=1，repetitions=1
    reviewFlashcard("due", "good");
    const after = listFlashcards("nb1").find((c) => c.id === "due")!;
    expect(after.repetitions).toBe(1);
    expect(after.intervalDays).toBe(1);
    expect(after.nextReview).toBe(now + 24 * 60 * 60 * 1000);
    // ease: 2.5 + (0.1 - 1*(0.08 + 1*0.02)) = 2.5
    expect(after.easeFactor).toBeCloseTo(2.5, 6);
    // 复习后不再"到期"
    expect(getDueFlashcards("nb1").map((c) => c.id)).toEqual([]);

    // 失败评级 → 重置
    reviewFlashcard("due", "again");
    const reset = listFlashcards("nb1").find((c) => c.id === "due")!;
    expect(reset.repetitions).toBe(0);
    expect(reset.intervalDays).toBe(0);
    expect(reset.easeFactor).toBeLessThan(2.5);

    // updateFlashcard：tags 写回 JSON 文本；空更新不写
    updateFlashcard("due", { tags: ["x", "y"] });
    expect(listFlashcards("nb1").find((c) => c.id === "due")!.tags).toEqual(["x", "y"]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const beforeCount = executed.length;
    updateFlashcard("due", {});
    expect(executed.length).toBe(beforeCount);
    expect(warn).toHaveBeenCalled();

    await settle();
    const up = executed.filter((e) => e.cmd === "crud.upsert");
    const tagWrite = up.map((e) => (e.params.rows as Array<Record<string, unknown>>)[0]).find((r) => r.tags === '["x","y"]');
    expect(tagWrite, "tags 必须以 JSON 文本落库").toBeTruthy();
    expect(tagWrite?.ease_factor, "未改动列必须一起写回").toBeDefined();
  });

  it("DOM-28: deleteFlashcardsByNotebook 只删本笔记本（范围条件按镜像筛 id 写穿）", async () => {
    const { port, executed } = portWith([
      cardRow({ id: "c1", notebook_id: "nb1" }),
      cardRow({ id: "c2", notebook_id: "nb1" }),
      cardRow({ id: "c3", notebook_id: "nb2" }),
    ]);
    setStoragePort(port);
    await port.start();
    port.domains.ensureLoaded("flashcards");
    await settle();

    const { deleteFlashcardsByNotebook, listFlashcards } = await import("../core/knowledge/flashcard-store");
    deleteFlashcardsByNotebook("nb1");
    expect(listFlashcards("nb1")).toEqual([]);
    expect(listFlashcards("nb2").map((c) => c.id), "别的笔记本不该被牵连").toEqual(["c3"]);

    await settle();
    const ids = executed
      .filter((e) => e.cmd === "crud.delete")
      .map((e) => (e.params.where as Record<string, unknown>).id)
      .sort();
    expect(ids, "必须逐 id 写穿（线协议 where 不支持范围条件）").toEqual(["c1", "c2"]);
  });
});

// ========== 委派域（delegation_tasks） ==========

function taskRow(over: Record<string, unknown> = {}) {
  return {
    id: "d1",
    source_session_id: "s-src",
    target_session_id: "s-dst",
    task: "任务",
    status: "pending",
    result: null,
    error: null,
    project_id: "p1",
    created_at: 1,
    started_at: null,
    completed_at: null,
    ...over,
  };
}

describe("域镜像分流 —— delegation_tasks", () => {
  it("DOM-29: 按源/目标/项目/未完成查询与旧 SQL 一致；更新不存在时不留痕", async () => {
    const { port, executed } = portWith([
      taskRow({ id: "t1", status: "pending", created_at: 1, source_session_id: "s1", target_session_id: "s2" }),
      taskRow({ id: "t2", status: "running", created_at: 2, source_session_id: "s1", target_session_id: "s3" }),
      taskRow({ id: "t3", status: "completed", created_at: 3, source_session_id: "s9", target_session_id: "s2", project_id: "p2", completed_at: 30 }),
      taskRow({ id: "t4", status: "failed", created_at: 4, source_session_id: "s9", target_session_id: "s9", project_id: "p2", completed_at: 40 }),
    ]);
    setStoragePort(port);
    await port.start();
    port.domains.ensureLoaded("delegation_tasks");
    await settle();

    const d = await import("../core/session/delegation-storage");
    // created_at ASC
    expect(d.getDelegationsBySource("s1").map((t) => t.id)).toEqual(["t1", "t2"]);
    expect(d.getDelegationsByTarget("s2").map((t) => t.id)).toEqual(["t1", "t3"]);
    expect(d.getDelegationsByProject("p2").map((t) => t.id)).toEqual(["t3", "t4"]);
    // 只有 pending/running
    expect(d.getActiveDelegations().map((t) => t.id)).toEqual(["t1", "t2"]);
    // created_at DESC + limit
    expect(d.getRecentDelegations().map((t) => t.id)).toEqual(["t4", "t3", "t2", "t1"]);
    expect(d.getRecentDelegations(2).map((t) => t.id)).toEqual(["t4", "t3"]);
    expect(d.getRecentDelegations(0).map((t) => t.id), "limit 至少为 1").toEqual(["t4"]);

    // 状态更新：未改动列保留（result/error 清不清由 extra 决定）
    d.updateDelegationTaskStatus("t1", "running", { startedAt: 111 });
    const t1 = d.getDelegationTask("t1")!;
    expect(t1.status).toBe("running");
    expect(t1.startedAt).toBe(111);
    expect(t1.task).toBe("任务");

    const before = executed.filter((e) => e.cmd === "crud.upsert").length;
    d.updateDelegationTaskStatus("ghost", "running");
    expect(executed.filter((e) => e.cmd === "crud.upsert").length, "不存在的任务不能产生写入").toBe(before);
    expect(d.getDelegationTask("ghost")).toBeNull();
  });

  it("DOM-30: clearCompletedDelegations 保留最近 N 条（只动已完成/失败/取消）", async () => {
    const { port, executed } = portWith([
      taskRow({ id: "a", status: "completed", completed_at: 10 }),
      taskRow({ id: "b", status: "completed", completed_at: 20 }),
      taskRow({ id: "c", status: "failed", completed_at: 30 }),
      taskRow({ id: "d", status: "cancelled", completed_at: null }),
      taskRow({ id: "live", status: "running", completed_at: null }),
    ]);
    setStoragePort(port);
    await port.start();
    port.domains.ensureLoaded("delegation_tasks");
    await settle();

    const d = await import("../core/session/delegation-storage");
    // 保留最近 1 条：completed_at 最大的 c 留下；并列/空值的那几条按 id 稳定删
    d.clearCompletedDelegations(1);
    const left = d.getRecentDelegations().map((t) => t.id).sort();
    expect(left, "未完成的任务永远不清理").toContain("live");
    expect(left, "最新的已完成（c, completed_at=30）必须留下").toContain("c");
    expect(left).not.toContain("a");
    expect(left).not.toContain("b");

    await settle();
    const deleted = executed
      .filter((e) => e.cmd === "crud.delete")
      .map((e) => (e.params.where as Record<string, unknown>).id);
    expect(deleted.sort(), "只能删已完成/失败/取消").toEqual(["a", "b", "d"]);
  });
});

// ========== 知识域（notebooks / sources / chunks / notes / links / graph / groups / versions） ==========

function nbRow(over: Record<string, unknown> = {}) {
  return {
    id: "nb1",
    name: "笔记本",
    description: null,
    summary: null,
    summary_status: "pending",
    source_count: 0,
    chunk_count: 0,
    group_id: null,
    created_at: 1,
    updated_at: 1,
    ...over,
  };
}

describe("域镜像分流 —— knowledge/notebooks + sources + counts", () => {
  it("DOM-31: 计数在同一份数据上算完再写回（旧实现是两条 COUNT + 一条 UPDATE）", async () => {
    const { port, executed } = portWith({
      notebooks: [nbRow({ id: "nb1" })],
      notebook_sources: [
        { id: "s1", notebook_id: "nb1", name: "a", type: "text", status: "indexed", chunk_count: 2, created_at: 1 },
        { id: "s2", notebook_id: "nb1", name: "b", type: "text", status: "pending", chunk_count: 0, created_at: 2 },
        { id: "s9", notebook_id: "nb2", name: "别的", type: "text", status: "pending", chunk_count: 0, created_at: 3 },
      ],
      notebook_chunks: [
        { id: "c1", source_id: "s1", notebook_id: "nb1", content: "x", chunk_index: 0, token_count: 1, created_at: 1 },
        { id: "c2", source_id: "s1", notebook_id: "nb1", content: "y", chunk_index: 1, token_count: 1, created_at: 1 },
        { id: "c9", source_id: "s9", notebook_id: "nb2", content: "z", chunk_index: 0, token_count: 1, created_at: 1 },
      ],
    });
    setStoragePort(port);
    await port.start();
    port.domains.ensureLoaded("notebooks");
    port.domains.ensureLoaded("notebook_sources");
    port.domains.ensureLoaded("notebook_chunks");
    await settle();

    const k = await import("../core/knowledge/storage");
    k.refreshNotebookCounts("nb1");
    const nb = k.getNotebook("nb1")!;
    expect(nb.sourceCount, "只数本笔记本的来源").toBe(2);
    expect(nb.chunkCount, "只数本笔记本的文本块").toBe(2);
    expect(nb.updatedAt).toBeGreaterThan(1);

    await settle();
    const up = executed.filter((e) => e.cmd === "crud.upsert" && e.params.table === "notebooks");
    const row = (up[up.length - 1].params.rows as Array<Record<string, unknown>>)[0];
    expect(row).toMatchObject({ id: "nb1", source_count: 2, chunk_count: 2 });

    // 别的笔记本不受影响
    expect(k.getNotebook("nb2")).toBeNull(); // 端口里没有 nb2
    expect(k.listSources("nb1").map((s) => s.id)).toEqual(["s1", "s2"]);
  });

  it("DOM-32: listNotebooksByGroup 区分「未分组」与「某个分组」", async () => {
    const { port } = portWith({
      notebooks: [
        nbRow({ id: "nb-a", group_id: "g1", updated_at: 10 }),
        nbRow({ id: "nb-b", group_id: null, updated_at: 20 }),
        nbRow({ id: "nb-c", group_id: "g2", updated_at: 30 }),
      ],
    });
    setStoragePort(port);
    await port.start();
    port.domains.ensureLoaded("notebooks");
    await settle();

    const k = await import("../core/knowledge/storage");
    expect(k.listNotebooks().map((n) => n.id), "updated_at DESC").toEqual(["nb-c", "nb-b", "nb-a"]);
    expect(k.listNotebooksByGroup(null).map((n) => n.id), "IS NULL 才是未分组").toEqual(["nb-b"]);
    expect(k.listNotebooksByGroup("g1").map((n) => n.id)).toEqual(["nb-a"]);

    // 更新：未改动列保留，group_id 置空后落到"未分组"
    k.updateNotebook("nb-a", { name: "改名", groupId: null });
    const after = k.getNotebook("nb-a")!;
    expect(after.name).toBe("改名");
    expect(after.groupId).toBeUndefined();
    expect(k.listNotebooksByGroup(null).map((n) => n.id).sort()).toEqual(["nb-a", "nb-b"]);
    // 空更新不写库
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    k.updateNotebook("nb-a", {});
    expect(warn).toHaveBeenCalled();
  });

  it("DOM-33: embedding 的 Base64 往返 + 文本块按 chunk_index 排序 + 按来源批量删", async () => {
    const vec = new Float32Array([1.5, -2.25, 0, 3]);
    const b64 = Buffer.from(
      new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength),
    ).toString("base64");
    const { port, executed } = portWith({
      notebook_chunks: [
        { id: "c2", source_id: "s1", notebook_id: "nb1", content: "第二", chunk_index: 1, embedding: b64, token_count: 2, created_at: 5 },
        { id: "c1", source_id: "s1", notebook_id: "nb1", content: "第一", chunk_index: 0, embedding: null, token_count: 1, created_at: 5 },
        { id: "c3", source_id: "s2", notebook_id: "nb1", content: "别的来源", chunk_index: 0, embedding: null, token_count: 1, created_at: 5 },
      ],
    });
    setStoragePort(port);
    await port.start();
    port.domains.ensureLoaded("notebook_chunks");
    await settle();

    const k = await import("../core/knowledge/storage");
    // 排序断言必须先把 chunk_index 写在注释里核对一遍：
    // c1→0、c2→1、c3→0，所以正确的顺序是 c1、c3（同为 0，保持相对次序）、c2。
    expect(k.getChunks("nb1").map((c) => c.id), "chunk_index ASC").toEqual(["c1", "c3", "c2"]);
    expect(k.getChunkCount("nb1")).toBe(3);
    // Base64 → Float32Array 必须逐元素一致（向量检索全靠它）
    const withVec = k.getChunks("nb1").find((c) => c.id === "c2")!;
    expect(withVec.embedding).toBeInstanceOf(Float32Array);
    expect(Array.from(withVec.embedding!)).toEqual([1.5, -2.25, 0, 3]);

    // 新增：向量编码回 Base64
    const created = k.addChunk({
      sourceId: "s1",
      notebookId: "nb1",
      content: "新的",
      chunkIndex: 9,
      embedding: vec,
      tokenCount: 4,
    });
    await settle();
    const up = executed.filter((e) => e.cmd === "crud.upsert").pop()!;
    const row = (up.params.rows as Array<Record<string, unknown>>)[0];
    expect(row.embedding, "embedding 必须以 Base64 文本落库").toBe(b64);
    expect(row.id).toBe(created.id);

    // 按来源删：只删 s1 的两个
    k.deleteChunksBySource("s1");
    expect(k.getChunks("nb1").map((c) => c.id), "只剩 s2 的").toEqual(["c3"]);
  });
});

describe("域镜像分流 —— knowledge/notes + links + versions", () => {
  it("DOM-34: 笔记排序（pin_order DESC, updated_at DESC）、tags JSON、版本快照与回滚", async () => {
    const { port, executed } = portWith({
      notes: [
        { id: "n1", notebook_id: "nb1", source_id: null, title: "未置顶", content: "a", content_type: "markdown", tags: "[\"x\"]", pin_order: 0, created_at: 1, updated_at: 10 },
        { id: "n2", notebook_id: "nb1", source_id: null, title: "置顶", content: "b", content_type: "markdown", tags: null, pin_order: 5, created_at: 1, updated_at: 1 },
      ],
      note_versions: [],
      note_links: [],
    });
    setStoragePort(port);
    await port.start();
    port.domains.ensureLoaded("notes");
    port.domains.ensureLoaded("note_versions");
    port.domains.ensureLoaded("note_links");
    await settle();

    const k = await import("../core/knowledge/storage");
    expect(k.listNotes("nb1").map((n) => n.id), "pin_order 优先").toEqual(["n2", "n1"]);
    expect(k.listNotes("nb1")[1].tags, "tags JSON → 数组").toEqual(["x"]);

    // 更新：tags 编码回 JSON，未改动列保留
    k.updateNote("n1", { title: "改了", tags: ["y", "z"] });
    const n1 = k.getNote("n1")!;
    expect(n1.title).toBe("改了");
    expect(n1.tags).toEqual(["y", "z"]);
    expect(n1.content, "未改动列保留").toBe("a");

    // 存版本（快照当前状态）
    await settle();
    k.saveNoteVersion("n1", "第一版");
    const versions = k.listNoteVersions("n1");
    expect(versions).toHaveLength(1);
    expect(versions[0].title).toBe("改了");
    expect(versions[0].versionNote).toBe("第一版");
    expect(versions[0].tags).toEqual(["y", "z"]);

    // 回滚：先自动存一份当前状态，再把笔记改回版本内容
    k.updateNote("n1", { title: "又改了", content: "内容变了" });
    k.restoreNoteVersion(versions[0].id);
    const restored = k.getNote("n1")!;
    expect(restored.title).toBe("改了");
    expect(restored.content).toBe("a");
    expect(k.listNoteVersions("n1"), "回滚前会自动存一份").toHaveLength(2);

    // 空更新不写库
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const before = executed.length;
    k.updateNote("n1", {});
    expect(executed.length).toBe(before);
    expect(warn).toHaveBeenCalled();
  });

  it("DOM-35: 笔记链接去重 + 双向查询（旧实现的返回值恒为 true）", async () => {
    const { port, executed } = portWith({ note_links: [] });
    setStoragePort(port);
    await port.start();
    port.domains.ensureLoaded("note_links");
    await settle();

    const k = await import("../core/knowledge/storage");
    // 第一次：真的新增
    expect(k.addNoteLink("a", "b", "见 b")).toBe(true);
    expect(k.getNoteLinks("a").map((l) => l.id)).toHaveLength(1);
    expect(k.getBacklinks("b")).toHaveLength(1);
    expect(k.getBacklinks("a"), "反向链接不该凭空出现").toHaveLength(0);

    // 第二次（同一对笔记）：必须在**写入之前**判定为已存在 → 返回 false 且不新增行
    await settle();
    const writesBefore = executed.filter((e) => e.cmd === "crud.upsert").length;
    expect(k.addNoteLink("a", "b", "再来一次"), "重复链接必须返回 false").toBe(false);
    expect(k.getNoteLinks("a"), "不能出现重复行").toHaveLength(1);
    expect(executed.filter((e) => e.cmd === "crud.upsert").length).toBe(writesBefore);

    // 反向也算同一条链接（source/target 对调是另一条）
    expect(k.addNoteLink("b", "a")).toBe(true);
    expect(k.getNoteLinks("a")).toHaveLength(2);
    expect(k.getBacklinks("a")).toHaveLength(1);
  });
});

describe("域镜像分流 —— knowledge/graph", () => {
  it("DOM-36: findOrCreateNode 的合并语义与返回值一致（旧实现返回值是字面量）", async () => {
    const { port, executed } = portWith({
      graph_nodes: [
        {
          id: "nd1",
          notebook_id: "nb1",
          label: "概念A",
          entity_type: "concept",
          description: null,
          source_ids: '["s1"]',
          chunk_ids: '["k1"]',
          weight: 1,
          community_id: null,
          created_at: 1,
        },
      ],
      graph_edges: [],
    });
    setStoragePort(port);
    await port.start();
    port.domains.ensureLoaded("graph_nodes");
    port.domains.ensureLoaded("graph_edges");
    await settle();

    const k = await import("../core/knowledge/storage");

    // 命中已有节点：weight +1，新的 source/chunk 合并进去（不重复加已有的）
    const node = k.findOrCreateNode("nb1", "概念A", "concept", undefined, "s2", "k1");
    expect(node.weight, "权重必须真的 +1").toBe(2);
    expect(node.sourceIds.sort(), "新来源合并进来").toEqual(["s1", "s2"]);
    expect(node.chunkIds, "已存在的 chunk 不该重复").toEqual(["k1"]);

    // 返回值必须与落库一致（旧实现返回 weight:2 的字面量与只含新 id 的数组）
    const persisted = k.getGraphData("nb1").nodes[0];
    expect(persisted.weight).toBe(node.weight);
    expect(persisted.sourceIds.sort()).toEqual(node.sourceIds.sort());
    expect(persisted.chunkIds).toEqual(node.chunkIds);

    // 没命中 → 走新增
    const fresh = k.findOrCreateNode("nb1", "概念B", "concept", "说明", "s9");
    expect(fresh.weight).toBe(1);
    expect(fresh.sourceIds).toEqual(["s9"]);
    expect(k.getGraphData("nb1").nodes.map((n) => n.label).sort()).toEqual(["概念A", "概念B"]);

    await settle();
    const ups = executed.filter((e) => e.cmd === "crud.upsert" && e.params.table === "graph_nodes");
    const last = (ups[ups.length - 1].params.rows as Array<Record<string, unknown>>)[0];
    expect(last.source_ids, "落库的是合并后的 JSON").toBe('["s9"]');
  });

  it("DOM-37: 图谱边的去重、按节点级联删除、按笔记本清空", async () => {
    const { port, executed } = portWith({
      graph_nodes: [
        { id: "a", notebook_id: "nb1", label: "A", entity_type: "concept", source_ids: "[]", chunk_ids: "[]", weight: 1, created_at: 1 },
        { id: "b", notebook_id: "nb1", label: "B", entity_type: "concept", source_ids: "[]", chunk_ids: "[]", weight: 1, created_at: 1 },
        { id: "c", notebook_id: "nb2", label: "C", entity_type: "concept", source_ids: "[]", chunk_ids: "[]", weight: 1, created_at: 1 },
      ],
      graph_edges: [
        { id: "e1", notebook_id: "nb1", source_node_id: "a", target_node_id: "b", relation_type: "related", weight: 1, created_at: 1 },
        { id: "e2", notebook_id: "nb2", source_node_id: "c", target_node_id: "c", relation_type: "related", weight: 1, created_at: 1 },
      ],
    });
    setStoragePort(port);
    await port.start();
    port.domains.ensureLoaded("graph_nodes");
    port.domains.ensureLoaded("graph_edges");
    await settle();

    const k = await import("../core/knowledge/storage");
    // 已存在同一条边 → 返回已有那条，不新增行
    const dup = k.addGraphEdge("nb1", "a", "b");
    expect(dup?.id, "重复边应返回已存在的那条").toBe("e1");
    expect(k.getGraphData("nb1").edges).toHaveLength(1);

    // 新的关系类型 = 另一条边
    const neu = k.addGraphEdge("nb1", "a", "b", "depends_on");
    expect(neu?.id).not.toBe("e1");
    expect(k.getGraphData("nb1").edges).toHaveLength(2);

    // 删节点 → 相连的边一起消失
    k.deleteGraphNode("a");
    expect(k.getGraphData("nb1").nodes.map((n) => n.id)).toEqual(["b"]);
    expect(k.getGraphData("nb1").edges, "相连的边必须一起删").toEqual([]);
    expect(k.getGraphData("nb2").edges, "别的笔记本不受影响").toHaveLength(1);

    // 按笔记本清空
    k.deleteGraphData("nb2");
    expect(k.getGraphData("nb2")).toEqual({ nodes: [], edges: [] });

    await settle();
    const delIds = executed.filter((e) => e.cmd === "crud.delete").map((e) => (e.params.where as Record<string, unknown>).id);
    expect(delIds).toContain("e1");
    expect(delIds).toContain("e2");
  });

  it("DOM-38: 分组排序与删除时把笔记本移到未分组", async () => {
    const { port } = portWith({
      notebook_groups: [
        { id: "g1", name: "乙", parent_id: null, sort_order: 2, created_at: 1 },
        { id: "g2", name: "甲", parent_id: null, sort_order: 1, created_at: 2 },
        { id: "g3", name: "子", parent_id: "g1", sort_order: 0, created_at: 3 },
      ],
      notebooks: [nbRow({ id: "nb-in", group_id: "g1" }), nbRow({ id: "nb-out", group_id: null })],
    });
    setStoragePort(port);
    await port.start();
    port.domains.ensureLoaded("notebook_groups");
    port.domains.ensureLoaded("notebooks");
    await settle();

    const k = await import("../core/knowledge/storage");
    const debugGroups = k.listGroups().map((g) => g.id);
    // sort_order ASC, name ASC
    expect(k.listGroups().map((g) => g.id), "按 sort_order").toEqual(["g3", "g2", "g1"]);
    expect(k.listGroups(null).map((g) => g.id), "顶级分组").toEqual(["g2", "g1"]);
    expect(k.listGroups("g1").map((g) => g.id)).toEqual(["g3"]);

    // 删除分组：组内笔记本移到未分组；**子分组不会级联删除**（旧实现只删自己，
    // 子分组会变成指向已删父分组的孤儿 —— 这里如实钉住旧行为，不顺手"修好"它）
    k.deleteGroup("g1");
    expect(k.listGroups().map((g) => g.id), "只删自己，子分组仍在").toEqual(["g3", "g2"]);
    expect(k.listGroups("g1").map((g) => g.id), "子分组已成孤儿（父分组不存在）").toEqual(["g3"]);
    expect(k.getNotebook("nb-in")?.groupId, "组内笔记本必须变成未分组").toBeUndefined();
    expect(k.listNotebooksByGroup(null).map((n) => n.id).sort()).toEqual(["nb-in", "nb-out"]);
    void debugGroups;
  });
});

// ========== projects 域（P5 第 1 段：真机发现它从没接过端口） ==========

function projectRow(over: Record<string, unknown> = {}) {
  return {
    id: "p1",
    name: "项目",
    path: "C:/p1",
    description: null,
    pinned: 0,
    created_at: 1,
    last_accessed_at: 1,
    ...over,
  };
}

describe("域镜像分流 —— projects", () => {
  it("DOM-39: 列表过滤与排序与旧 SQL 一致（隐藏全局项目与笔记本虚拟项目）", async () => {
    const { port } = portWith({
      projects: [
        projectRow({ id: "", name: "全局对话", last_accessed_at: 99 }),
        projectRow({ id: "notebook:nb1", name: "笔记本虚拟项目", last_accessed_at: 98 }),
        projectRow({ id: "p-a", name: "A", pinned: 0, last_accessed_at: 10 }),
        projectRow({ id: "p-b", name: "B", pinned: 1, last_accessed_at: 5 }),
        projectRow({ id: "p-c", name: "C", pinned: 1, last_accessed_at: 20 }),
      ],
    });
    setStoragePort(port);
    await port.start();
    port.domains.ensureLoaded("projects");
    await settle();

    const projects = await import("../core/storage/project");
    // 全局项目与 notebook: 虚拟项目都不能出现在列表里；置顶优先，其次按最近访问
    expect(projects.listProjects().map((p) => p.id), "pinned DESC, last_accessed_at DESC").toEqual([
      "p-c",
      "p-b",
      "p-a",
    ]);
    // 但按 id 直接取仍然取得到（全局项目是外键种子，别的地方要用）
    expect(projects.getProject("")?.name).toBe("全局对话");
    expect(projects.getProject("notebook:nb1")?.name).toBe("笔记本虚拟项目");
  });

  it("DOM-40: createProject 补齐缺省时间（旧实现漏字段会被 sql.js 直接抛错）", async () => {
    const { port, executed } = portWith({ projects: [] });
    setStoragePort(port);
    await port.start();
    port.domains.ensureLoaded("projects");
    await settle();

    const projects = await import("../core/storage/project");
    // 真机上漏传 createdAt/lastAccessedAt 时，旧实现抛
    // "Wrong API use : tried to bind a value of an unknown type (undefined)"
    projects.createProject({
      id: "p-new",
      name: "新项目",
      path: "C:/new",
      pinned: false,
    } as never);

    const got = projects.getProject("p-new");
    expect(got?.name).toBe("新项目");
    expect(got?.createdAt, "缺省时间必须是真实数字，不能是 undefined").toBeGreaterThan(0);
    expect(got?.lastAccessedAt).toBeGreaterThan(0);

    await settle();
    const up = executed.find((e) => e.cmd === "crud.upsert");
    const row = (up?.params.rows as Array<Record<string, unknown>>)[0];
    expect(row.pinned, "pinned 以 0/1 落库").toBe(0);
    expect(typeof row.created_at).toBe("number");
    expect(row).not.toHaveProperty("createdAt");
  });

  it("DOM-41: update/delete 走端口，未改动列保留，空更新不写库", async () => {
    const { port, executed } = portWith({
      projects: [projectRow({ id: "p1", name: "旧名", description: "旧说明", pinned: 0 })],
    });
    setStoragePort(port);
    await port.start();
    port.domains.ensureLoaded("projects");
    await settle();

    const projects = await import("../core/storage/project");
    projects.updateProject("p1", { name: "新名", pinned: true });
    const after = projects.getProject("p1")!;
    expect(after.name).toBe("新名");
    expect(after.pinned).toBe(true);
    expect(after.description, "未改动列必须保留").toBe("旧说明");

    // 不存在的项目 → 不写
    const before = executed.filter((e) => e.cmd === "crud.upsert").length;
    projects.updateProject("nope", { name: "x" });
    expect(executed.filter((e) => e.cmd === "crud.upsert").length).toBe(before);

    // 空更新 → 不写且留痕
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    projects.updateProject("p1", {});
    expect(executed.filter((e) => e.cmd === "crud.upsert").length).toBe(before);
    expect(warn).toHaveBeenCalled();

    projects.deleteProject("p1");
    expect(projects.getProject("p1")).toBeNull();
    await settle();
    expect(executed.filter((e) => e.cmd === "crud.delete")[0]?.params).toEqual({
      table: "projects",
      where: { id: "p1" },
    });
  });
});

// ========== message_feedback 域（P5 第 1 段：宽松版反馈原来在 Rust 下写不进去） ==========

describe("域镜像分流 —— message_feedback（宽松版反馈）", () => {
  it("DOM-42: 评分/备注/版本乐观并发在镜像路径上语义不变", async () => {
    const { port, executed } = portWith({ message_feedback: [] });
    setStoragePort(port);
    await port.start();
    port.domains.ensureLoaded("message_feedback");
    await settle();

    const fb = await import("../core/llm/feedback");
    const MID = "m1";
    const SID = "s1";

    // 首次写入：无现有版本，ifVersion 必须是 null
    const put1 = fb.putMessageFeedback(SID, MID, "like", "备注一", null);
    expect(put1.ok).toBe(true);
    if (!put1.ok) return;
    const read1 = fb.getMessageFeedback(MID);
    expect(read1?.rating).toBe("like");
    expect(read1?.note).toBe("备注一");
    expect(read1?.version).toBe(put1.item.version);
    expect(read1?.createdAt).toBeGreaterThan(0);

    // 版本不符必须被拒（乐观并发）
    const conflict = fb.putMessageFeedback(SID, MID, "dislike", undefined, "wrong");
    expect(conflict.ok).toBe(false);
    expect(fb.getMessageFeedback(MID)?.rating, "冲突时不能改动现有反馈").toBe("like");

    // 正确版本：能改
    const put2 = fb.putMessageFeedback(SID, MID, "dislike", "备注二", read1!.version);
    expect(put2.ok).toBe(true);
    if (put2.ok) expect(put2.item.version).not.toBe(read1!.version);
    expect(fb.getMessageFeedback(MID)?.note).toBe("备注二");

    // 按会话列出
    expect(fb.listMessageFeedback(SID).map((f) => f.messageId)).toEqual([MID]);
    expect(fb.listMessageFeedback("other")).toEqual([]);

    // 删除（带版本校验）
    expect(fb.deleteMessageFeedback(MID, fb.getMessageFeedback(MID)!.version)).toEqual({ ok: true, absent: true });
    expect(fb.getMessageFeedback(MID)).toBeNull();
    // 已不存在时再删：absent
    expect(fb.deleteMessageFeedback(MID, null)).toEqual({ ok: true, absent: true });

    await settle();
    const ups = executed.filter((e) => e.cmd === "crud.upsert" && e.params.table === "message_feedback");
    expect(ups.length, "两次成功写入（冲突那次不能写）").toBe(2);
    const row = (ups[ups.length - 1].params.rows as Array<Record<string, unknown>>)[0];
    expect(row, "四列必须一起落库").toMatchObject({
      message_id: "m1",
      session_id: "s1",
      feedback: "dislike",
      note: "备注二",
    });
    expect(typeof row.version).toBe("string");
    expect(typeof row.updated_at).toBe("number");
  });

  it("DOM-43: 历史行 id 不是 fb-<messageId> 时也保持「一条消息最多一条反馈」", async () => {
    const { port, executed } = portWith({
      message_feedback: [
        {
          id: "legacy-row-id",
          message_id: "m1",
          session_id: "s1",
          feedback: "like",
          timestamp: 1,
          note: null,
          version: "v-old",
          created_at: 1,
          updated_at: 1,
        },
      ],
    });
    setStoragePort(port);
    await port.start();
    port.domains.ensureLoaded("message_feedback");
    await settle();

    const fb = await import("../core/llm/feedback");
    const put = fb.putMessageFeedback("s1", "m1", "dislike", "改了", "v-old");
    expect(put.ok).toBe(true);
    // 必须**先删旧行再加新行**，否则会留下两条反馈
    expect(fb.listMessageFeedback("s1"), "不能出现两条反馈").toHaveLength(1);

    await settle();
    const dels = executed.filter((e) => e.cmd === "crud.delete");
    expect(dels.map((d) => (d.params.where as Record<string, unknown>).id)).toEqual(["legacy-row-id"]);
  });
});
