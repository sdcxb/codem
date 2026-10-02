/**
 * DSH-D11 —— `updateMessage` 的**读-改-写**不许把字段从权威副本里抹掉（第 103+ 轮）。
 *
 * ## 缺陷（形态与为什么它是"权威副本被保护它的代码弄丢"那一类）
 *
 * `updateMessage` 是"取一份现存快照 → `{...base, ...update}` → **追加**进权威日志（同 id 后写者胜）"。
 * 它原来的基准是 `logMirrorMessage(...) ?? safeGetMessage(...)`，也就是**优先用日志镜像**。
 * 而那份镜像有两重问题：
 *
 * 1. **它只由 hydrate 写入**（进会话时读一次，见 `message.ts::cachedLogMessages` 的注释），
 *    写路径从不更新它 —— 于是它最多只反映"进会话那一刻"的日志；
 * 2. **它手挑字段**（旧实现只搬 8 个）：`attachments` / `metadata` / `generatedFiles` /
 *    `retrievedSources` / `hidden` / `trimmed` 全都不在里面。
 *
 * 后果：基准里没有的字段，新追加的那一行就没有。而日志是**权威副本** ——
 * 读路径"日志覆盖索引"、索引重建按日志落库，所以那些字段不是"这次读不到"，
 * 而是**被永久抹掉**（`Message.attachments` 是 `src/store.ts:69` 的真实字段）。
 *
 * ## 本文件钉住四件事
 *
 * - **D11-1**：附件住在**索引的 attachments 表**里（真机形态：JSONL 行里从来没有它们），
 *   日志镜像里没有 —— 一次只改正文的 `updateMessage` 不许把附件从权威日志里抹掉；
 * - **D11-2**：`metadata` **只有日志能承载**（消息行的列投影里没有它，`MessageRow` /
 *   `MirrorMessageRow` 都没有这一列）—— 以索引为基准时不许顺手把它删掉；
 * - **D11-3**：写侧（serializer）与读侧（`logMirrorMessage`）必须**共用同一份字段定义**：
 *   新建的消息连**原始日志行**都要带 `attachments` / `metadata`；
 * - **D11-4**：普通形态（创建时就带附件 + metadata）走完整往返，读回来的值逐字段相同。
 *
 * ## 为什么桩要**忠实**（这一条是本仓库反复付代价的地方）
 *
 * Rust 侧 `write_file` 是"**先写同目录临时文件 → fsync → rename 覆盖**"（`lib.rs:720-739`），
 * `append_file` 是 `writeln!`（追加 + **一个换行**，**不 fsync**，`lib.rs:767-780`）。
 * 桩若把 `write_file` 写成"直接覆盖整文件"，就会比实现**更狠**（真实实现不会留下半截目标文件），
 * 于是"原子替换"这类契约在测试里永远测不出来。所以这里的 `write_file` 逐字模仿那套 dance，
 * `append_file` 逐字模仿 `writeln!`。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetPersistFailures } from "../core/storage/persist-failure";
import { setStoragePort } from "../core/storage/port";
import { __resetDataRootCache } from "../core/storage/data-root";
import { createFakeStoragePort, type FakeStoragePort } from "./fake-storage-port";
import { readFileWithCap, textWindowSlice } from "./helpers/tauri-fs-stub";
import type { Message, MessageAttachment } from "../store";

const S = "sess-dsh-d11";
const APP_DIR = "C:/fake-appdata/";

const files = new Map<string, string>();
/** 记录每次文件 IPC（用来证明 write_file 走的是"临时文件 + rename"） */
const fileCalls: Array<{ cmd: string; path: string }> = [];

/**
 * 内存文件桩：形状与语义都对齐 `src-tauri/src/lib.rs`（见文件头"桩要忠实"）。
 *
 * `storage_info` 刻意**不实现**（返回 null）→ `resolveDataRoot()` 走 `get_app_data_dir` 兜底，
 * 与"引擎起不来但 Tauri 数据目录拿得到"同形。
 */
function installFakeFs(): void {
  files.clear();
  fileCalls.length = 0;
  (globalThis as any).window = globalThis.window ?? ({} as any);
  (window as any).__TAURI__ = {
    core: {
      invoke: async (cmd: string, args?: Record<string, unknown>) => {
        const path = String(args?.path ?? "");
        if (cmd === "get_app_data_dir") return APP_DIR;
        if (cmd === "read_text_window") return textWindowSlice(files, args);
        if (cmd === "read_file") return readFileWithCap(files, args);
        if (cmd === "append_file") {
          fileCalls.push({ cmd, path });
          // Rust: `writeln!(file, "{}", content)` —— 追加内容 + 一个换行，**不 fsync**
          files.set(path, (files.get(path) ?? "") + String(args?.content ?? "") + "\n");
          return null;
        }
        if (cmd === "write_file") {
          fileCalls.push({ cmd, path });
          // Rust: 同目录 `.{文件名}.codem-tmp` → fsync → rename 覆盖（目标文件不会出现半截内容）
          const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
          const tmp = `${path.slice(0, cut + 1)}.${path.slice(cut + 1)}.codem-tmp`;
          files.set(tmp, String(args?.content ?? ""));
          const content = files.get(tmp)!;
          files.delete(tmp);
          files.set(path, content);
          return null;
        }
        if (cmd === "rename_file") {
          fileCalls.push({ cmd, path: String(args?.oldPath ?? "") });
          const content = files.get(String(args?.oldPath));
          files.delete(String(args?.oldPath));
          if (content !== undefined) files.set(String(args?.newPath), content);
          return null;
        }
        if (cmd === "list_directory") return [];
        if (cmd === "path_exists") return files.has(path);
        if (cmd === "delete_file") {
          files.delete(path);
          return null;
        }
        return null;
      },
    },
  };
}

/** 附件（真机形态：正文按 id 懒加载，日志/镜像里只留元数据 —— 见 `attachmentsFromMirror`） */
const ATT: MessageAttachment = {
  id: "a1",
  name: "report.md",
  type: "file",
  preview: "# 报告",
  mimeType: "text/markdown",
  size: 61,
  sandboxPath: ".attachments/a1-report.md",
};

const METADATA = { origin: "dsh-d11", note: "结构化元数据只有日志能承载" };

/** 产品写附件行的**同一条命令**（`message.ts::writeAttachmentsViaPort` → `crud.upsert` replace） */
async function seedAttachmentRow(port: FakeStoragePort, messageId: string): Promise<void> {
  await port.data.execute("crud.upsert", {
    table: "attachments",
    mode: "replace",
    primaryKey: "id",
    rows: [
      {
        id: ATT.id,
        session_id: S,
        message_id: messageId,
        name: ATT.name,
        type: ATT.type,
        preview: ATT.preview,
        sandbox_path: ATT.sandboxPath,
        mime_type: ATT.mimeType,
        size: ATT.size,
        added_at: 1,
      },
    ],
  });
}

/** 磁盘上**这个 id 的最后一行**（后写者胜 ⇒ 最后一行就是权威副本里的当前状态） */
async function lastLogRecordFor(id: string): Promise<Record<string, unknown>> {
  const { sessionLogPath, flushSessionLogWrites } = await import("../core/storage/session-jsonl");
  await flushSessionLogWrites();
  const raw = files.get(await sessionLogPath(S)) ?? "";
  const lines = raw.split("\n").filter((l) => l.trim());
  const mine = lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((r) => r.id === id);
  expect(mine.length, `日志里 must 有 ${id} 的行`).toBeGreaterThan(0);
  return mine[mine.length - 1];
}

let port: FakeStoragePort;

beforeEach(async () => {
  resetPersistFailures();
  installFakeFs();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  port = createFakeStoragePort({
    seed: {
      sessions: [{ id: S, project_id: "p1", title: "D11", created_at: 1, last_message_at: 1, message_count: 0 }],
      messages: [],
    },
  });
  setStoragePort(port);

  const msgMod = await import("../core/storage/message");
  msgMod.clearSessionLogCache();
  msgMod.__resetSessionLogReadFailuresForTests();
  const jsonl = await import("../core/storage/session-jsonl");
  jsonl.__resetJsonlCache();
  __resetDataRootCache();
});

afterEach(async () => {
  const { flushSessionLogWrites } = await import("../core/storage/session-jsonl");
  await flushSessionLogWrites();
  setStoragePort(null);
  resetPersistFailures();
  vi.restoreAllMocks();
  delete (window as any).__TAURI__;
});

describe("updateMessage 的读-改-写不许丢字段（权威日志是追加日志，字段丢了就永久丢了）", () => {
  it("D11-1: 附件只住在索引的 attachments 表里（日志镜像没有它）→ 只改正文的更新不许把附件从权威日志里抹掉", async () => {
    const { createMessage, hydrateSessionLog, logMirrorMessage, updateMessage, listMessages } =
      await import("../core/storage/message");

    // ① 一条已存在的消息：**正文与 metadata 进日志**，附件行单独进索引（产品就是这么写的）
    createMessage({ id: "m1", role: "assistant", content: "v1", timestamp: 1, metadata: METADATA } as Message, S);
    await seedAttachmentRow(port, "m1");

    // ② 会话打开 → hydrate：日志镜像被填充（这一步是镜像的**唯一**写入者）
    expect(await hydrateSessionLog(S), "夹具前提：日志里有 1 条").toBe(1);

    // ⭐ 夹具前提（这条用例的整个理由）：索引里有附件，而**日志镜像里没有**
    //    —— 因为真机上 JSONL 行从来没有附件（旧写入器的字段清单里没有它），
    //    而镜像只反映日志。若这两条断言不成立，本用例测不到"以陈旧镜像为基准"这件事。
    const fromIndex = (await import("../core/storage/message")).getMessage("m1");
    expect(fromIndex?.attachments?.map((a) => a.id), "索引侧（attachments 表）必须有附件").toEqual(["a1"]);
    expect(
      logMirrorMessage(S, "m1")?.attachments,
      "夹具前提：日志镜像里**没有**附件（这正是「陈旧且被削过字段的镜像」那一态）",
    ).toBeUndefined();
    expect(logMirrorMessage(S, "m1")?.metadata, "metadata 只有日志镜像有（索引的列投影里没有它）").toEqual(METADATA);

    // ③ 只改正文（流式回复/工具结果的最常见形态）
    updateMessage("m1", { content: "v2" });
    await new Promise((r) => setTimeout(r, 0));

    // ④ 权威副本：最后一行必须同时带上新正文、附件与 metadata
    const record = await lastLogRecordFor("m1");
    expect(record.content, "正文必须是新版本").toBe("v2");
    expect(
      record.attachments,
      "附件必须跟着这一行进权威日志 —— 基准里没有它，新写的那一行就没有它（而日志是权威副本）",
    ).toEqual([ATT]);
    expect(record.metadata, "metadata 同理").toEqual(METADATA);

    // ⑤ 重建内存镜像（丢掉缓存重新 hydrate）→ 从**磁盘上的日志**读回来的状态仍然完整
    const msgMod = await import("../core/storage/message");
    msgMod.clearSessionLogCache();
    expect(await hydrateSessionLog(S)).toBe(1);
    const roundTripped = logMirrorMessage(S, "m1")!;
    expect(roundTripped.content).toBe("v2");
    expect(roundTripped.attachments, "重新 hydrate 之后附件必须还在，且值相同").toEqual([ATT]);
    expect(roundTripped.metadata).toEqual(METADATA);

    // ⑥ 读路径（索引 ∪ 日志）同样给得出
    const merged = listMessages(S).find((m) => m.id === "m1")!;
    expect(merged.content).toBe("v2");
    expect(merged.attachments?.map((a) => a.id)).toEqual(["a1"]);
  });

  it("D11-2: metadata 只有日志能承载 → 以索引为基准时**不许**顺手删掉它（裸 `??` 反转会踩到这里）", async () => {
    const { createMessage, hydrateSessionLog, logMirrorMessage, updateMessage } = await import(
      "../core/storage/message"
    );

    createMessage({ id: "m2", role: "user", content: "v1", timestamp: 2, metadata: METADATA } as Message, S);
    await hydrateSessionLog(S);

    // 夹具前提：索引**给不出** metadata（消息行的列投影里没有这一列）
    const msgMod = await import("../core/storage/message");
    expect(msgMod.getMessage("m2")?.metadata, "索引侧没有 metadata 这一列").toBeUndefined();
    expect(logMirrorMessage(S, "m2")?.metadata, "只有日志镜像有它").toEqual(METADATA);

    updateMessage("m2", { content: "v2" });
    await new Promise((r) => setTimeout(r, 0));

    const record = await lastLogRecordFor("m2");
    expect(record.content).toBe("v2");
    expect(
      record.metadata,
      "metadata 不能因为「基准换成了索引」而消失 —— 索引给不出的字段必须由日志镜像补上",
    ).toEqual(METADATA);

    msgMod.clearSessionLogCache();
    await hydrateSessionLog(S);
    expect(logMirrorMessage(S, "m2")?.metadata).toEqual(METADATA);
  });

  it("D11-3: 写侧与读侧共用一份字段定义 —— 新建消息的**原始日志行**就带 attachments / metadata", async () => {
    const { createMessage } = await import("../core/storage/message");
    const { readSessionMessages, flushSessionLogWrites } = await import("../core/storage/session-jsonl");

    createMessage(
      {
        id: "m3",
        role: "user",
        content: "带附件的消息",
        timestamp: 3,
        attachments: [ATT],
        metadata: METADATA,
      } as Message,
      S,
    );
    await flushSessionLogWrites();

    const record = await lastLogRecordFor("m3");
    expect(record.attachments, "权威日志行必须带附件（否则「索引可从日志重建」在附件上不成立）").toEqual([ATT]);
    expect(record.metadata, "权威日志行必须带 metadata（session-log-bridge 一直在读它，写侧从来没写过）").toEqual(
      METADATA,
    );

    const { messages } = await readSessionMessages(S);
    const parsed = messages.find((m) => m.id === "m3")!;
    expect(parsed.attachments).toEqual([ATT]);
    expect(parsed.metadata).toEqual(METADATA);
    expect(
      (parsed.attachments as Array<Record<string, unknown>>)[0].content,
      "附件**正文**刻意不进日志（append-only 每次更新追加一整行，正文可达几十 MB）",
    ).toBeUndefined();
  });

  it("D11-4: 普通形态（创建时就带附件 + metadata）走完整往返：更新后重新 hydrate，值逐字段相同", async () => {
    const { createMessage, hydrateSessionLog, logMirrorMessage, updateMessage } = await import(
      "../core/storage/message"
    );

    createMessage(
      {
        id: "m4",
        role: "user",
        content: "v1",
        timestamp: 4,
        attachments: [ATT],
        metadata: METADATA,
        generatedFiles: ["/tmp/out.ts"],
        retrievedSources: [{ sourceId: "s1", sourceName: "手册", chunkIndex: 0, snippet: "片段", score: 0.9 }],
      } as Message,
      S,
    );
    await hydrateSessionLog(S);

    updateMessage("m4", { content: "v2" });
    await new Promise((r) => setTimeout(r, 0));

    const msgMod = await import("../core/storage/message");
    msgMod.clearSessionLogCache();
    await hydrateSessionLog(S);

    const got = logMirrorMessage(S, "m4")!;
    expect(got.content).toBe("v2");
    expect(got.attachments, "附件（含 sandboxPath / mimeType / size / preview）必须原样往返").toEqual([ATT]);
    expect(got.metadata).toEqual(METADATA);
    // 顺带钉住同一类"手挑字段"漏掉的两个字段（faithful 映射的一部分）
    expect(got.generatedFiles).toEqual(["/tmp/out.ts"]);
    expect(got.retrievedSources?.[0]?.sourceId).toBe("s1");
  });
});
