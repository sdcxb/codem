/**
 * DOCI-1 / DOCI-6（契约部分）：文档索引库落地与命令面。
 *
 * 这些断言刻意看**源码结构**而不是只跑实现：
 * - 索引库必须是**独立的 schema 文件**，主库 `tables.json` 不许出现文档表
 *   （否则 1GB 级索引会挤进会话主库，VACUUM/恢复/备份全被拖慢）；
 * - 渲染侧发出的每条 `documents.*` 命令都必须登记在 Rust `COMMANDS` 白名单里
 *   （否则真机会回 `UNSUPPORTED`，而单测全绿——这是本仓踩过的经典假绿）。
 */
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  DocumentIndexError,
  documentStats,
  listDocuments,
  searchDocuments,
} from "../core/document/client";
import {
  __resetDocumentBackendForTests,
  setDocumentBackend,
} from "../core/document/test-seams";
import { createFakeDocumentBackend, makeDoc } from "./helpers/documents-fake";

const ROOT = path.join(__dirname, "..", "..");

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), "utf-8");
}

describe("DOCI-1 索引库落地（独立库，可重建）", () => {
  it("documents.sql 含 5 张表与 (collection_id, dedupe_key) 唯一键", () => {
    const sql = read("src-tauri/codem-db/sql/documents.sql");
    for (const table of [
      "documents",
      "document_pages",
      "document_blocks",
      "document_chunks",
      "document_ingest_state",
    ]) {
      expect(sql, `缺少表 ${table}`).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
    expect(sql).toMatch(/UNIQUE\s*\(\s*collection_id\s*,\s*dedupe_key\s*\)/);
    // chunk 不存正文：只存 offset/len/preview（1GB 文本存两遍＝自找磁盘灾难）
    expect(sql).toContain("text_offset");
    expect(sql).toContain("preview");
    expect(sql).not.toMatch(/document_chunks\s*\([^)]*\btext\s+TEXT/i);
  });

  it("主库 tables.json 不含文档表（索引库与主库隔离）", () => {
    const tables = JSON.parse(read("src-tauri/codem-db/sql/tables.json")) as { tables: string[] };
    expect(Array.isArray(tables.tables)).toBe(true);
    expect(tables.tables).toHaveLength(45);
    for (const t of tables.tables) {
      expect(t.startsWith("document"), `主库不许出现文档表 ${t}`).toBe(false);
    }
  });

  it("渲染侧用的 documents.* 命令都在 Rust COMMANDS 白名单里", () => {
    const client = read("src/core/document/client.ts");
    const used = new Set([...client.matchAll(/"(documents\.[a-z_]+)"/g)].map((m) => m[1]));
    // 工具/状态 store 里也可能直接写字面量
    for (const rel of ["src/core/llm/tools/document-tools.ts", "src/core/document/status-store.ts"]) {
      const text = read(rel);
      for (const m of text.matchAll(/"(documents\.[a-z_]+)"/g)) used.add(m[1]);
    }
    expect(used.size).toBeGreaterThan(4);

    const lib = read("src-tauri/codem-db/src/lib.rs");
    const block = lib.slice(lib.indexOf("pub const COMMANDS"), lib.indexOf("];", lib.indexOf("pub const COMMANDS")));
    const registered = new Set([...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]));
    for (const command of used) {
      expect(registered.has(command), `白名单缺少 ${command}`).toBe(true);
    }
  });

  it("命令调用走结构化参数（不拼 SQL）", async () => {
    const fake = createFakeDocumentBackend({ documents: [makeDoc()] });
    setDocumentBackend(fake.backend);
    await listDocuments({ collectionId: "p1", status: "ready", limit: 7 });
    await searchDocuments({ collectionId: "p1", query: "迁移", limit: 3 });
    await documentStats("p1");

    expect(fake.calls.map((c) => c.name)).toEqual([
      "documents.list",
      "documents.search",
      "documents.stats",
    ]);
    expect(fake.calls[0].params).toMatchObject({ collection_id: "p1", status: "ready", limit: 7 });
    expect(fake.calls[1].params).toMatchObject({ query: "迁移", limit: 3 });
    for (const call of fake.calls) {
      const serialized = JSON.stringify(call.params).toLowerCase();
      expect(serialized).not.toContain("select ");
      expect(serialized).not.toContain("insert ");
    }
  });

  afterEach(() => {
    __resetDocumentBackendForTests();
  });
});

describe("DOCI-1 错误信封（ok=false 必须抛，不许吞）", () => {
  it("DocumentIndexError 带稳定 code", () => {
    const err = new DocumentIndexError("索引库不可用", "UNAVAILABLE");
    expect(err.name).toBe("DocumentIndexError");
    expect(err.code).toBe("UNAVAILABLE");
    expect(err.message).toContain("不可用");
  });
});
