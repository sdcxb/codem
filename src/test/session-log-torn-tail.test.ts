/**
 * 会话日志的**残尾**（torn tail）与「粘在残尾后面的合法记录」（第 94 波）。
 *
 * ## 缺陷形态（真实数据丢失）
 *
 * Rust 侧的 `append_file` 原来**从不检查文件是否以换行结尾**，于是崩在写入中途留下的
 * 半截尾行会把**下一条记录**粘在同一行上：
 *
 * ```text
 * {"id":"m1",...}                     ← 完整行
 * {"id":"m2",...}                     ← 完整行
 * {"id":"m3","conte{"id":"m4",...}    ← 残尾 + 粘上来的下一条
 * ```
 *
 * 读侧把解析不了的行**直接丢掉**，而压缩（`compactSessionLog`）的安全闸门只比行数
 * （`linesAfter < linesBefore`）⇒ **看不见"一行坏行里裹着一条合法记录"**
 * ⇒ **m4 被永久删除**（它是真的写入过的消息）。
 *
 * 修法分两头：
 *   · **写侧**（Rust `append_file_impl`）：追加前确保文件以换行结尾 + `sync_all()`
 *     —— 判据在 `src-tauri/src/lib.rs` 的 `append_file_tests`（含变异自证）；
 *   · **读侧**（本文件）：残尾**要被看见**（`tornTailLines` + 一条 warn），
 *     并且要把粘住的合法记录**抢救回来**（`salvagedLines`）—— 已经损坏的日志也救得回来。
 *
 * ## 判据
 *
 * | # | 造法 | 判据 |
 * | --- | --- | --- |
 * | TORN-A | 2 条完整行 + 半截尾行（无结尾换行） | `messages = [m1, m2]`；`tornTailLines === 1`；`salvagedLines === 0`（残尾自己该丢） |
 * | TORN-B | 2 条完整行 + **粘连行**（残尾 + 完整记录 m4） | **m4 必须仍然可读**（`salvagedLines === 1`）—— 这是"永久删除一条合法记录"的直接反例 |
 * | TORN-C | ≥200 行日志（含一条粘连行）→ 跑 `compactSessionLog` | 压缩后 m4 **仍然可读**（压缩不许把它删掉） |
 * | TORN-D | 反向对照：干净日志 | 三个计数都是 0，消息一条不多一条不少 |
 *
 * 变异自证：把 `salvageGluedRecord` 的调用去掉（坏行一律 `skippedLines++` 丢弃）⇒
 * TORN-B 与 TORN-C 必须变红。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { textWindowSlice } from "./helpers/tauri-fs-stub";
import { setStoragePort } from "../core/storage/port";
import { createFakeStoragePort } from "./fake-storage-port";
import {
  readSessionMessages,
  sessionLogPath,
  compactSessionLog,
  flushSessionLogWrites,
  __resetJsonlCache,
} from "../core/storage/session-jsonl";
import { clearSessionLogCache } from "../core/storage/message";

const SESSION = "sess-torn-tail";

/** 内存文件系统桩（与 `session-jsonl-index.test.ts` 同一套命令面） */
const files = new Map<string, string>();
const invokeCalls: string[] = [];

function installFsStub(): void {
  files.clear();
  invokeCalls.length = 0;
  (window as any).__TAURI__ = {
    core: {
      invoke: async (cmd: string, args: any) => {
        invokeCalls.push(cmd);
        if (cmd === "get_app_data_dir") return "C:\\appdata\\";
        if (cmd === "write_file") {
          files.set(args.path, args.content);
          return undefined;
        }
        if (cmd === "append_file") {
          files.set(args.path, (files.get(args.path) ?? "") + args.content + "\n");
          return undefined;
        }
        if (cmd === "read_text_window") return textWindowSlice(files, args);
        if (cmd === "read_file") {
          if (!files.has(args.path)) throw new Error("no such file");
          return files.get(args.path);
        }
        if (cmd === "delete_file") {
          files.delete(args.path);
          return undefined;
        }
        if (cmd === "rename_file") {
          const content = files.get(args.oldPath);
          files.delete(args.oldPath);
          if (content !== undefined) files.set(args.newPath, content);
          return undefined;
        }
        return undefined;
      },
    },
  };
}

/** 造一条合法日志行（形状与产品写的一致，够用即可） */
function logLine(id: string, content = `内容 ${id}`): string {
  return JSON.stringify({ id, sessionId: SESSION, role: "user", content, timestamp: 1000 });
}

/** 把**原始字节**写进日志文件（`__writeSessionLogForTests` 总会补换行，这里要精确控制） */
async function writeRaw(raw: string): Promise<string> {
  const path = await sessionLogPath(SESSION);
  files.set(path, raw);
  return path;
}

beforeEach(() => {
  installFsStub();
  __resetJsonlCache();
  clearSessionLogCache();
  setStoragePort(createFakeStoragePort());
  vi.clearAllMocks();
});

afterEach(() => {
  delete (window as any).__TAURI__;
  __resetJsonlCache();
  clearSessionLogCache();
});

describe("会话日志的残尾与抢救（第 94 波）", () => {
  it("TORN-A: 半截尾行要被**看见**（tornTailLines），前面的完整行照常可读", async () => {
    await writeRaw(`${logLine("m1")}\n${logLine("m2")}\n{"id":"m3","conte`);

    const r = await readSessionMessages(SESSION);
    expect(r.messages.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(r.tornTailLines, "文件末尾没有换行 ⇒ 最后一行是残尾，必须被计数（原来它与普通坏行无法区分）").toBe(1);
    expect(r.salvagedLines).toBe(0);
    expect(r.skippedLines, "残尾自己是一条没写完的记录：该丢").toBe(1);
  });

  it("TORN-B（主判据）: 残尾粘住的那条**合法记录**必须被抢救回来，不许被永久丢掉", async () => {
    // 崩在写 m3 的中途 → 下一条 m4 被粘上来，整行 JSON.parse 失败
    await writeRaw(`${logLine("m1")}\n${logLine("m2")}\n{"id":"m3","conte${logLine("m4")}`);

    const r = await readSessionMessages(SESSION);
    expect(
      r.messages.map((m) => m.id),
      "m4 是**真的被写入过**的记录：它原来会随那条坏行一起被丢掉（永久删除用户数据）",
    ).toEqual(["m1", "m2", "m4"]);
    expect(r.salvagedLines, "抢救成功要能被观测到").toBe(1);
    expect(r.tornTailLines).toBe(1);
    expect(r.messages.find((m) => m.id === "m4")?.content).toBe("内容 m4");
  });

  it("TORN-C: 压缩**不许**把粘在残尾后面的记录删掉（它原来是「一行坏行里裹着一条」）", async () => {
    const lines: string[] = [];
    for (let i = 0; i < 260; i++) lines.push(logLine(`old-${i}`));
    // 同 id 的旧行（后写者胜的语义：压缩后应当只剩最后一条）+ 一条粘连行
    lines.push(logLine("dup", "旧版本"));
    lines.push(logLine("dup", "最终版本"));
    // 最后一行：残尾 + 粘住的完整记录（没有结尾换行 ⇒ 它同时也是残尾行）
    lines.push(`{"id":"torn","conte${logLine("glued-after-torn", "我粘在残尾后面")}`);
    await writeRaw(lines.join("\n") + "\n");

    await flushSessionLogWrites();
    const before = await readSessionMessages(SESSION);
    expect(before.messages.some((m) => m.id === "glued-after-torn"), "前置：抢救在读侧已经生效").toBe(true);

    await compactSessionLog(SESSION);
    clearSessionLogCache();
    __resetJsonlCache();

    const after = await readSessionMessages(SESSION);
    expect(
      after.messages.some((m) => m.id === "glued-after-torn"),
      "压缩会整体覆盖写回：在压缩里丢掉它就等于**永久删除**（闸门只比行数，看不见这种形态）",
    ).toBe(true);
    expect(after.messages.find((m) => m.id === "dup")?.content).toBe("最终版本");
  });

  it("TORN-D 反向对照: 干净的日志不该被这套机制影响（三个计数都是 0）", async () => {
    await writeRaw([logLine("m1"), logLine("m2"), logLine("m3")].join("\n") + "\n");

    const r = await readSessionMessages(SESSION);
    expect(r.messages.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
    expect(r.tornTailLines, "正常结束的日志没有残尾").toBe(0);
    expect(r.skippedLines).toBe(0);
    expect(r.salvagedLines).toBe(0);
  });
});
