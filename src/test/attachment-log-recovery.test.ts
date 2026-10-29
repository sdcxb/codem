/**
 * 附件正文在**索引重建后仍可取回**（第 233 轮审计 · P0）。
 *
 * ## 缺陷形态
 *
 * `attachments` 表是**可重建的投影**，但重建路径（`messages_rebuild_index`）只重放
 * messages / tool_calls，**不重放 attachments**；权威日志里也没有 `file:<路径>` 标记
 * （外置是**异步队列**做的，日志行写下时附件还是内联形态，而 `attachmentsForLog`
 * 按设计不写 `content`）。
 *
 * 净效果：库损坏 → 恢复 → 重建索引之后
 * - `attachments` 表是空的（没有行）；
 * - 日志里也没有任何东西指向正文文件；
 * - 正文文件还在磁盘上（`<dataRoot>/attachments/<safeId>-<safeName>`），**却不可达**。
 *
 * 于是 `getAttachmentContent(id)` 永远返回 `undefined`，界面上附件点开是空的 ——
 * 文件在、名字在，没人知道它属于谁。
 *
 * 修法：文件名里就带着附件 id（`externalizeAttachmentContent` 的规则），所以
 * `getAttachmentContent` 在「索引未命中」时再试一条路 —— 按 id 扫附件目录找回文件
 * （`findExternalFileByAttachmentId`），把标记补回同步缓存；界面的 400ms×4 重试
 * 会自然命中。**不新增 DB 命令、不改日志格式**。
 *
 * ## 判据
 *
 * | # | 行为 |
 * |---|---|
 * | ATT-REC-1 | 内联正文**不进**日志（append-only 日志不被几十 MB 正文撑大） |
 * | ATT-REC-2 | 索引里**没有**这一行时，仍能按附件 id 找回文件并读到正文 |
 * | ATT-REC-3 | 索引里有行时行为不变（反向对照：端口缓存优先） |
 *
 * 变异自证：让 `findExternalFileByAttachmentId` 恒返回 `undefined`（或去掉
 * `warmAttachmentContentFromFiles` 的调用）⇒ ATT-REC-2 立刻红。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";

const files = new Map<string, string>();

function installFsStub(): void {
  files.clear();
  (window as any).__TAURI__ = {
    core: {
      invoke: async (cmd: string, args: any) => {
        if (cmd === "get_app_data_dir") return "C:\\appdata\\";
        if (cmd === "write_file") { files.set(args.path, args.content); return undefined; }
        if (cmd === "append_file") { files.set(args.path, (files.get(args.path) ?? "") + args.content + "\n"); return undefined; }
        if (cmd === "read_text_window") return textWindowSlice(files, args);
        if (cmd === "read_file") {
          if (!files.has(args.path)) throw new Error("no such file");
          return files.get(args.path);
        }
        if (cmd === "list_directory") {
          const dir = String(args.path);
          const sep = dir.endsWith("\\") ? "" : "\\";
          const out: Array<{ name: string; path: string; isDirectory: boolean }> = [];
          for (const key of files.keys()) {
            if (!key.startsWith(dir + sep)) continue;
            const rest = key.slice(dir.length + sep.length);
            if (rest.includes("\\")) continue;
            out.push({ name: rest, path: key, isDirectory: false });
          }
          return out;
        }
        if (cmd === "delete_file") { files.delete(args.path); return undefined; }
        if (cmd === "rename_file") {
          const c = files.get(args.oldPath);
          files.delete(args.oldPath);
          if (c !== undefined) files.set(args.newPath, c);
          return undefined;
        }
        return undefined;
      },
    },
  };
  (globalThis as any).__TAURI__ = (window as any).__TAURI__;
}

import { textWindowSlice } from "./helpers/tauri-fs-stub";
import {
  createMessage,
  getAttachmentContent,
  clearSessionLogCache,
  __resetAttachmentContentCacheForTests,
} from "../core/storage/message";
import {
  clearExternalContentCache,
  DEFAULT_EXTERNALIZE_THRESHOLD,
  FILE_CONTENT_PREFIX,
  hydrateAttachmentsForSession,
} from "../core/storage/attachment-files";
import { flushSessionLogWrites, __resetJsonlCache, readSessionMessages } from "../core/storage/session-jsonl";
import { setStoragePort, getStoragePort } from "../core/storage/port";
import { createFakeStoragePort } from "./fake-storage-port";
import type { FakeStoragePort } from "./fake-storage-port";
import type { Message } from "../store";

const SESSION = "sess-att-rec";

function bigBody(): string {
  return "长文档正文-" + "x".repeat(DEFAULT_EXTERNALIZE_THRESHOLD + 64);
}

function userMsg(id: string, attId: string, content: string): Message {
  return {
    id,
    role: "user",
    content: "带大附件",
    timestamp: 2000,
    attachments: [
      { id: attId, name: "big.md", type: "file", content, size: content.length, mimeType: "text/markdown" },
    ],
  } as unknown as Message;
}

function attachmentRows(): Array<Record<string, unknown>> {
  const port = getStoragePort() as unknown as FakeStoragePort;
  return port.__table("attachments");
}

/** 等外置队列跑完（异步、幂等） */
async function waitExternalized(): Promise<void> {
  await new Promise((r) => setTimeout(r, 50));
  await flushSessionLogWrites();
}

beforeEach(() => {
  installFsStub();
  __resetJsonlCache();
  clearSessionLogCache();
  clearExternalContentCache();
  setStoragePort(
    createFakeStoragePort({
      seed: {
        sessions: [
          { id: SESSION, project_id: "", title: "t", created_at: 0, last_message_at: 0, message_count: 0 },
        ],
      },
    }),
  );
});

afterEach(() => {
  delete (globalThis as any).__TAURI__;
  __resetJsonlCache();
  clearSessionLogCache();
  clearExternalContentCache();
});

describe("附件正文：索引重建后仍可取回", () => {
  it("ATT-REC-1: 内联正文不进日志", async () => {
    createMessage(userMsg("m-big", "att-big", bigBody()), SESSION);
    createMessage(userMsg("m-small", "att-small", "短内容"), SESSION);
    await waitExternalized();

    const { messages } = await readSessionMessages(SESSION);
    const big = messages.find((m) => m.id === "m-big")?.attachments?.[0] as
      | { content?: string; name?: string }
      | undefined;
    const small = messages.find((m) => m.id === "m-small")?.attachments?.[0] as
      | { content?: string }
      | undefined;

    expect(big?.content, "正文不进日志").toBeUndefined();
    expect(small?.content, "正文不进日志").toBeUndefined();
    // 元数据仍然在（渲染侧要靠它显示附件条）
    expect(big?.name).toBe("big.md");
  });

  it("ATT-REC-2: 索引里没有这一行（模拟重建）⇒ 仍能按附件 id 找回文件并读到正文", async () => {
    const body = bigBody();
    createMessage(userMsg("m1", "att-1", body), SESSION);
    await waitExternalized();

    const row = attachmentRows().find((r) => String(r.id) === "att-1");
    const stored = String(row?.content ?? "");
    expect(stored.startsWith(FILE_CONTENT_PREFIX), "外置已发生，库里是标记").toBe(true);
    const path = stored.slice(FILE_CONTENT_PREFIX.length);
    expect(files.get(path), "正文全文确实在文件里").toBe(body);

    // 预热（真实流程里由启动维护 `hydrateAllAttachments` 做）
    await hydrateAttachmentsForSession([{ id: "att-1", content: stored }]);
    expect(getAttachmentContent("att-1"), "常态：预热后同步命中").toBe(body);

    // 模拟重建：删掉 attachments 行 + 清掉所有内存缓存（正文文件仍在桩里）
    // `__table()` 返回的是**克隆**，改它不会改端口里的行 —— 必须走端口命令删除。
    await (getStoragePort() as unknown as { data: { execute: (c: string, p?: unknown) => Promise<unknown> } })
      .data.execute("crud.delete", { table: "attachments", where: { id: "att-1" } });
    clearExternalContentCache();
    clearSessionLogCache();
    __resetAttachmentContentCacheForTests(); // 模拟进程重启：同步缓存全空
    expect(attachmentRows().length, "索引里确实已经没有附件行").toBe(0);

    // 第一次未命中 → 触发「按 id 找文件」的预取；等它跑完，再读即命中
    expect(getAttachmentContent("att-1")).toBeUndefined();
    await new Promise((r) => setTimeout(r, 50));
    expect(getAttachmentContent("att-1"), "重建后必须能按 id 找回正文").toBe(body);
  });

  it("ATT-REC-3（反向对照）: 索引有行时走端口缓存，且外置文件确实写下去了", async () => {
    const body = bigBody();
    createMessage(userMsg("m2", "att-2", body), SESSION);
    await waitExternalized();
    const row = attachmentRows().find((r) => String(r.id) === "att-2");
    const stored = String(row?.content ?? "");
    await hydrateAttachmentsForSession([{ id: "att-2", content: stored }]);
    expect(getAttachmentContent("att-2")).toBe(body);
    expect([...files.keys()].some((p) => p.includes("attachments"))).toBe(true);
  });
});
