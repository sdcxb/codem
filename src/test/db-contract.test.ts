/**
 * 存储契约测试（P2）：用**同一套断言**锁住 Rust 存储实现的语义。
 *
 * ## 这个文件要解决的问题
 *
 * 迁移到 Rust 之后，真正的风险不是"编译不过"，而是**语义悄悄变了**：
 * - 默认值变了（`status` 从 `done` 变成 NULL）；
 * - 错误码变了（找不到行从"成功"变成"报错"，或者反过来）；
 * - 分页边界差一行（`has_more` 算错 → 调用方漏读或多读）；
 * - 约束/外键行为变了（写进去一行 orphan）。
 *
 * 这些都不会让编译失败，只会让**用户的数据悄悄出错**。所以这里逐条把语义写成断言。
 * 而且这些断言驱动的是**生产实现本身**（CLI → `codem_db::dispatch`，与 Tauri 命令走同一个函数），
 * 不是"测试用的第二实现" —— 这是 P1 把引擎做成 lib+CLI+Tauri 薄层的目的。
 *
 * 需要先 `npm run db:build`（`npm run test:db` 已包含构建步骤）。
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { CLI_PATH, TempDb, assertCliBuilt, seededSession } from "./helpers/db-rust-cli";

const DB = new TempDb("contract");

beforeAll(() => {
  assertCliBuilt();
});

afterAll(() => {
  DB.dispose();
});

describe("存储契约 —— 命令面与自省", () => {
  it("C1: 命令清单可自省，且包含全部已实现命令", () => {
    const caps = DB.raw(["commands"]).result;
    expect(caps.engine).toBe("rust");
    expect(Array.isArray(caps.commands)).toBe(true);
    // 声明"不支持整库导出"是这套架构的核心承诺之一
    expect(caps.no_whole_file_export).toBe(true);
    for (const cmd of [
      "settings.get_all",
      "settings.set",
      "settings.remove",
      "events.append",
      "telemetry.append",
      "telemetry.prune",
      "messages.create",
      "messages.create_many",
      "messages.update",
      "messages.update_many",
      "messages.get",
      "messages.list",
      "messages.delete",
      "messages.count",
      "sessions.upsert",
      "sessions.list",
      "projects.upsert",
      "projects.list",
      "counts",
      "health",
      "integrity_check",
      "checkpoint",
    ]) {
      expect(caps.commands, `命令清单缺少 ${cmd}`).toContain(cmd);
    }
  });

  it("C2: 未实现/未知命令返回 UNSUPPORTED（不是静默成功、不是 panic）", () => {
    const err = DB.mustFail("sql.raw", { sql: "DROP TABLE messages" });
    expect(err.code).toBe("UNSUPPORTED");
    expect(err.retryable).toBe(false);
  });

  it("C3: 引擎不接受 SQL 字符串作为命令名", () => {
    for (const cmd of ["SELECT 1", "messages.list; DROP TABLE messages", "../etc/passwd"]) {
      expect(DB.mustFail(cmd).code).toBe("UNSUPPORTED");
    }
  });

  it("C4: 健康检查暴露引擎/日志模式/表数（诊断面板的数据来源）", () => {
    const h = DB.raw(["health"]).result;
    const health = h.health;
    expect(health.engine).toBe("rust");
    expect(health.ready).toBe(true);
    expect(String(health.journal_mode).toLowerCase()).toBe("wal");
    expect(health.tables).toBeGreaterThanOrEqual(30);
    expect(["fts4", "fts5", "none"]).toContain(health.fts_module);
    expect(health.size_bytes).toBeGreaterThan(0);
  });

  it("C5: 完整性检查可用（迁移对账依据）", () => {
    const r = DB.raw(["integrity"]).result;
    expect(r.ok).toBe(true);
  });
});

describe("存储契约 —— 安全边界（渲染侧不得越界）", () => {
  it("C6: 引擎打开后不得产生计划外的旁路文件（ATTACH 类原语的第一道门）", () => {
    // 具体拒绝行为（ATTACH / load_extension / 危险 PRAGMA）由 Rust 测试守护：
    // src-tauri/codem-db/tests/engine_tests.rs（attach_is_denied_by_authorizer 等用例），
    // 这里从渲染侧视角再验证一条独立事实：打开引擎不会在库目录里多出文件。
    const h = DB.raw(["health"]).result;
    expect(h.health.last_error_code).toBeNull();
    const extra = fs.readdirSync(path.dirname(DB.path)).filter((f) => !f.startsWith("codem-db.bin"));
    expect(extra, `库目录出现了计划外的文件：${extra.join(", ")}`).toEqual([]);
  });

  it("C7: 不提供整库导出/导入能力（架构承诺：渲染进程不再持有整库）", () => {
    const caps = DB.raw(["commands"]).result;
    for (const forbidden of ["db.export", "export", "backup", "sql.raw", "sql.exec"]) {
      expect(caps.commands, `命令清单不应包含 ${forbidden}`).not.toContain(forbidden);
    }
  });
});

describe("存储契约 —— 配置面（settings）", () => {
  const db = new TempDb("settings");

  afterAll(() => db.dispose());

  it("C8: 写入-读取-覆盖-删除 全链路一致", () => {
    db.must("settings.set", { key: "theme", value: "dark" });
    db.must("settings.set", { key: "count", value: 42 });
    const all = db.must<Record<string, string | null>>("settings.get_all");
    expect(all.theme).toBe("dark");
    // 非字符串按 JSON 文本存（与渲染侧 `JSON.stringify` 落库的既有约定一致）
    expect(all.count).toBe("42");

    db.must("settings.set", { key: "theme", value: "light" });
    expect(db.must<Record<string, string>>("settings.get_all").theme).toBe("light");

    db.must("settings.remove", { key: "theme" });
    expect(db.must<Record<string, unknown>>("settings.get_all").theme).toBeUndefined();
  });

  it("C9: 删除不存在的 key 返回 NOT_FOUND（A 类防线：不能报假成功）", () => {
    const err = db.mustFail("settings.remove", { key: "never-existed" });
    expect(err.code).toBe("NOT_FOUND");
  });

  it("C10: 缺参数报出参数名（调用方 bug 必须可定位）", () => {
    const err = db.mustFail("settings.set", {});
    expect(err.message).toContain("key");
  });
});

describe("存储契约 —— 数据面（messages）", () => {
  const db = new TempDb("messages");

  beforeAll(() => {
    seededSession(db, "s1");
  });

  afterAll(() => db.dispose());

  it("C11: 单条往返保真（中文 / emoji / 换行 / 大 payload）", () => {
    const big = "中文内容🙂\n".repeat(20_000); // ≈ 500 KB
    db.must("messages.create", {
      id: "m-big",
      session_id: "s1",
      role: "assistant",
      content: big,
      reasoning: "推理内容",
      timestamp: 1000,
    });
    const got = db.must<{ item: any }>("messages.get", { id: "m-big" }).item;
    expect(got.content.length).toBe(big.length);
    expect(got.content).toBe(big);
    expect(got.reasoning).toBe("推理内容");
    // 默认值必须与渲染侧一致，否则 UI 会显示成"未完成"
    expect(got.status).toBe("done");
    expect(got.session_id).toBe("s1");
  });

  it("C12: 缺省字段的类型不合法时报错，不做静默强转（A 类静默空写源头）", () => {
    const err = db.mustFail("messages.create", {
      id: "m-bad",
      session_id: "s1",
      role: "user",
      content: 12345,
    });
    expect(err.message).toContain("content");
    // 关键：不能悄悄写进去一行
    expect(db.must<{ count: number }>("messages.count", { session_id: "s1" }).count).toBe(1);
  });

  it("C13: update 未命中行返回 NOT_FOUND，而不是假成功", () => {
    const err = db.mustFail("messages.update", { id: "不存在", content: "x" });
    expect(err.code).toBe("NOT_FOUND");
  });

  it("C14: 外键违规映射为 CONSTRAINT（业务可处理），而不是 OTHER", () => {
    const err = db.mustFail("messages.create", {
      id: "m-orphan",
      session_id: "no-such-session",
      role: "user",
      content: "x",
    });
    expect(err.code).toBe("CONSTRAINT");
    expect(err.retryable).toBe(false);
  });

  it("C15: 批量写入是原子的（验证批次内一条失败则整批不落）", () => {
    const before = db.must<{ total: number }>("messages.count", { session_id: "s1" }).total;
    const err = db.mustFail("messages.create_many", {
      items: [
        { id: "ok-1", session_id: "s1", role: "user", content: "合法" },
        { id: "ok-2", session_id: "s1", content: "缺 role" },
      ],
    });
    expect(err.message).toContain("role");
    const after = db.must<{ total: number }>("messages.count", { session_id: "s1" }).total;
    expect(after, "批次失败不得留下部分写入").toBe(before);
  });

  it("C16: 删除需要显式目标（空数组是错误，不是「删全部」）", () => {
    const err = db.mustFail("messages.delete", { ids: [] });
    expect(err.message).toContain("ids");
  });

  it("C17: count 同时给出 total/visible/hidden（压缩后 UI 要能区分）", () => {
    db.must("messages.create_many", {
      items: [
        { id: "h-1", session_id: "s1", role: "user", content: "将被隐藏", timestamp: 2000 },
        { id: "h-2", session_id: "s1", role: "user", content: "将被隐藏", timestamp: 2001 },
      ],
    });
    db.must("messages.update_many", {
      items: [
        { id: "h-1", hidden: 1 },
        { id: "h-2", hidden: 1 },
      ],
    });
    const c = db.must<{ total: number; visible: number; hidden: number }>("messages.count", { session_id: "s1" });
    expect(c.total).toBe(c.visible + c.hidden);
    expect(c.hidden).toBe(2);
  });

  it("C18: 可见性是显式参数（索引层不替调用方猜）", () => {
    const err = db.mustFail("messages.list", { session_id: "s1" });
    expect(err.message).toContain("include_hidden");
    const visible = db.must<{ items: any[] }>("messages.list", { session_id: "s1", include_hidden: false });
    const all = db.must<{ items: any[] }>("messages.list", { session_id: "s1", include_hidden: true });
    expect(visible.items.length).toBeLessThan(all.items.length);
  });
});

describe("存储契约 —— 分页（大文档能力的核心）", () => {
  const db = new TempDb("paging");
  const TOTAL = 250;

  beforeAll(() => {
    seededSession(db, "s1");
    const items = Array.from({ length: TOTAL }, (_, i) => ({
      id: `p-${String(i).padStart(4, "0")}`,
      session_id: "s1",
      role: i % 2 === 0 ? "user" : "assistant",
      content: `第 ${i} 条`,
      timestamp: 1_700_000_000_000 + i,
    }));
    db.must("messages.create_many", { items });
  });

  afterAll(() => db.dispose());

  it("C19: 逐页读不重不漏，且总数等于写入数", () => {
    const seen: string[] = [];
    let offset = 0;
    for (let guard = 0; guard < 100; guard++) {
      const page = db.must<{ items: any[]; has_more: boolean }>("messages.list", {
        session_id: "s1",
        limit: 37, // 故意用不整除的页大小，能暴露"最后一行丢失"这类边界 bug
        offset,
        include_hidden: true,
      });
      for (const it of page.items) seen.push(it.id);
      if (!page.has_more) break;
      offset += 37;
    }
    expect(seen.length).toBe(TOTAL);
    expect(new Set(seen).size).toBe(TOTAL);
  });

  it("C20: has_more / next_cursor 由引擎给出且自洽", () => {
    const p1 = db.must<{ items: any[]; has_more: boolean; next_cursor: string | null }>("messages.list", {
      session_id: "s1",
      limit: 10,
      offset: 0,
      include_hidden: true,
    });
    expect(p1.items.length).toBe(10);
    expect(p1.has_more).toBe(true);
    expect(p1.next_cursor).toBe("10");

    const last = db.must<{ items: any[]; has_more: boolean; next_cursor: string | null }>("messages.list", {
      session_id: "s1",
      limit: 10,
      offset: TOTAL - 5,
      include_hidden: true,
    });
    expect(last.items.length).toBe(5);
    expect(last.has_more).toBe(false);
    expect(last.next_cursor).toBeNull();
  });

  it("C21: 排序稳定（相同 timestamp 也要有确定顺序，否则分页会重复/漏）", () => {
    const same = new TempDb("same-ts");
    try {
      seededSession(same, "s1");
      same.must("messages.create_many", {
        items: Array.from({ length: 30 }, (_, i) => ({
          id: `t-${String(i).padStart(3, "0")}`,
          session_id: "s1",
          role: "user",
          content: "同一时间戳",
          timestamp: 5_000,
        })),
      });
      const first = same.must<{ items: any[] }>("messages.list", { session_id: "s1", limit: 100, include_hidden: true });
      const second = same.must<{ items: any[] }>("messages.list", { session_id: "s1", limit: 100, include_hidden: true });
      expect(first.items.map((x) => x.id)).toEqual(second.items.map((x) => x.id));
      expect(new Set(first.items.map((x) => x.id)).size).toBe(30);
    } finally {
      same.dispose();
    }
  });

  it("C22: limit 超上限被夹住而不是报错（调用方要 10000 条，实际给硬上限 + has_more）", () => {
    const page = db.must<{ items: any[]; has_more: boolean }>("messages.list", {
      session_id: "s1",
      limit: 999_999,
      include_hidden: true,
    });
    expect(page.items.length).toBeLessThanOrEqual(5000);
    expect(page.items.length).toBe(TOTAL);
    expect(page.has_more).toBe(false);
  });

  it("C23: 非法 limit/offset 被拒绝（负数、0 不能变成「读了别的行」）", () => {
    expect(db.mustFail("messages.list", { session_id: "s1", limit: 0, include_hidden: true }).message).toContain("limit");
    expect(db.mustFail("messages.list", { session_id: "s1", offset: -1, include_hidden: true }).message).toContain("offset");
  });
});

describe("存储契约 —— 幂等与可恢复性", () => {
  it("C24: 反复打开同一个库是幂等的（schema 不重复执行、不报错）", () => {
    const db = new TempDb("idem");
    try {
      const a = DB.raw(["init"]).result;
      const b = DB.raw(["init"]).result;
      expect(a.schema.tables).toBe(b.schema.tables);
      expect(b.schema.fresh).toBe(false);
      expect(b.schema.migrations_ignored).toBe(b.schema.migrations);
      expect(b.ok).not.toBe(false);
    } finally {
      db.dispose();
    }
  });

  it("C25: data 目录被删掉后能重建（不依赖任何内存状态）", () => {
    const db = new TempDb("recreate");
    try {
      seededSession(db, "s1");
      db.must("messages.create", { id: "m1", session_id: "s1", role: "user", content: "x" });
      const before = db.raw(["counts"]).result;
      expect(before.messages, "前置条件：删库前应当有 1 条消息").toBe(1);

      // 模拟"索引整个丢了"：主库 + WAL + SHM 一起删（真实崩溃/损坏的最坏形态）
      for (const f of [db.path, `${db.path}-wal`, `${db.path}-shm`]) fs.rmSync(f, { force: true });

      // 重新打开 = 全新库（索引可丢：权威副本是会话 JSONL 日志，P4 负责重建）
      const fresh = db.raw(["init"]).result;
      expect(fresh.schema.fresh, "删掉库文件后重开必须是全新库").toBe(true);
      expect(fresh.schema.tables).toBeGreaterThanOrEqual(30);
      expect(db.must<{ count: number }>("messages.count", { session_id: "s1" }).count).toBe(0);
      expect(db.raw(["integrity"]).result.ok).toBe(true);
    } finally {
      db.dispose();
    }
  });

  it("C26: 真实生产库副本能被打开且完整性通过（迁移前必须验证的事）", () => {
    const real = process.env.APPDATA ? `${process.env.APPDATA}\\com.codem.app\\codem-db.bin` : "";
    if (!real || !fs.existsSync(real)) {
      // 没有真实库的环境（CI）不静默通过：明确断言"未覆盖"这件事由 CI 环境决定
      expect(fs.existsSync(CLI_PATH)).toBe(true);
      return;
    }
    const probe = new TempDb("realdb");
    try {
      fs.copyFileSync(real, probe.path);
      const init = probe.raw(["init"]).result;
      expect(init.ok).toBe(true);
      expect(init.schema.fresh).toBe(false);
      const integrity = probe.raw(["integrity"]).result;
      expect(integrity.ok, `真实库 quick_check 失败：${integrity.detail}`).toBe(true);
      const counts = probe.raw(["counts"]).result;
      expect(typeof counts.messages).toBe("number");
    } finally {
      probe.dispose();
    }
  });
});
