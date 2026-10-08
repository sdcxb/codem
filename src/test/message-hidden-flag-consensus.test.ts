/**
 * `hidden` 的判定**只有一份**，且按**数字**读 —— 第 184 波存储审计 S2 的回归判据。
 *
 * ## 缺陷形态（审计原文）
 *
 * 写侧（`session-jsonl.ts` 的 serializer）写的是**数字** `hidden: Number(...)`（= 1），
 * 而 `message.ts::listMessagesMerged` 的那道"日志行被隐藏"防线写的是
 * `(rec as any).hidden === true` —— 拿**布尔**比**数字**，**恒不成立**：
 * 那道防御纵深从来没有生效过。于是"重启之后 + 该会话的消息镜像未被加载"
 * （S2 只驻留 3 个会话、字节/行数预算逐出、加载失败）时，`listMessages(sid)` 会把
 * **已被压缩隐藏**的消息从日志镜像整批合回来 —— 正是「压缩 840 条、token 一点没降」的形态。
 *
 * ## 判据（本文件守的三条）
 *
 * - S2-A 日志里 `hidden: 1`（数字）**必须**被合并防线排除；
 * - S2-B 写侧 / 读侧 / 重建侧三处对同一个数字 `1` 得到**同一个结论**（这就是"同源"）；
 * - S2-C 【同源守卫】四处判定都引共用函数，且 `src/core/storage` 里**不再有**
 *   `hidden === true` 这种把数字当布尔的写法（第四种读法会在这里变红）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { setStoragePort } from "../core/storage/port";
import { createFakeStoragePort, type FakeStoragePort } from "./fake-storage-port";
import { textWindowSlice } from "./helpers/tauri-fs-stub";

const A = "sess-hidden-a";
const B = "sess-hidden-b";
const APP_DIR = "C:\\appdata\\";

const files = new Map<string, string>();
function installFsStub(): void {
  files.clear();
  (window as any).__TAURI__ = {
    core: {
      invoke: async (cmd: string, args: any) => {
        if (cmd === "get_app_data_dir") return APP_DIR;
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
        if (cmd === "delete_file") {
          files.delete(args.path);
          return undefined;
        }
        if (cmd === "path_exists") return files.has(args.path);
        return undefined;
      },
    },
  };
  (globalThis as any).__TAURI__ = (window as any).__TAURI__;
}

/** 一份夹带压缩/裁剪标记的会话日志 */
function seedMixedLog(sessionId: string): void {
  const lines = [
    JSON.stringify({ v: 1, id: "m1", sessionId, role: "user", content: "正常消息", timestamp: 1 }),
    // 被**上下文压缩**隐藏（数字 1，且不是裁剪）→ 读路径必须排除
    JSON.stringify({ v: 1, id: "m2", sessionId, role: "user", content: "被压缩隐藏", timestamp: 2, hidden: 1 }),
    // 被**索引裁剪**隐藏（hidden=1 且 trimmed=1）→ 读路径必须**保留**（否则用户少看到历史）
    JSON.stringify({
      v: 1,
      id: "m3",
      sessionId,
      role: "user",
      content: "被裁剪（历史仍应读得到）",
      timestamp: 3,
      hidden: 1,
      trimmed: 1,
    }),
  ];
  files.set(`${APP_DIR}sessions\\${sessionId}.jsonl`, `${lines.join("\n")}\n`);
}

let port: FakeStoragePort | null = null;

beforeEach(async () => {
  installFsStub();
  const msgMod = await import("../core/storage/message");
  msgMod.clearSessionLogCache();
  const jsonl = await import("../core/storage/session-jsonl");
  jsonl.__resetJsonlCache();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  setStoragePort((port = createFakeStoragePort()));
});

afterEach(() => {
  setStoragePort(null);
  delete (window as any).__TAURI__;
  vi.restoreAllMocks();
});

describe("`hidden` 按数字判、且四处同源（第 184 波存储审计 S2）", () => {
  it("S2-A: 镜像未加载时，日志里 `hidden: 1` 的行**必须**被合并防线排除", async () => {
    const msgMod = await import("../core/storage/message");
    seedMixedLog(A);
    // 端口撤掉 = "索引读不可用 + hiddenIds 为空"（= 镜像未加载的等价形态）：
    // 此时唯一还站着的防线就是"日志行 hidden"那一道 —— 它修前是死的。
    setStoragePort(null);
    expect(await msgMod.hydrateSessionLog(A), "夹具前提：日志镜像已就绪（3 行）").toBe(3);

    const merged = msgMod.listMessagesMerged(A);
    expect(
      merged.map((m) => m.id),
      "被压缩隐藏的 m2 绝不能合回来；被裁剪的 m3 必须保留（那是「被裁的历史仍读得到」）",
    ).toEqual(["m1", "m3"]);
  });

  it("S2-B: 写侧 / 读侧 / 重建侧对同一个数字 1 得到**同一个结论**", async () => {
    const msgMod = await import("../core/storage/message");
    const jsonl = await import("../core/storage/session-jsonl");

    // ① 写侧：日志里写下来的必须是**数字**
    await jsonl.appendSessionMessage(B, {
      id: "w1",
      role: "user",
      content: "被压缩的消息",
      timestamp: 1,
      hidden: 1,
    } as never);
    await jsonl.flushSessionLogWrites();
    const raw = files.get(`${APP_DIR}sessions\\${B}.jsonl`) ?? "";
    const line = JSON.parse(raw.trim().split("\n")[0]) as { hidden?: unknown };
    expect(line.hidden, "写侧写的是数字 1（不是布尔 true）").toBe(1);

    // ② 读侧（logMirrorMessage）：读回来的也是数字
    seedMixedLog(A);
    expect(await msgMod.hydrateSessionLog(A)).toBe(3);
    expect(msgMod.logMirrorMessage(A, "m2")?.hidden, "读侧必须读得出数字 1").toBe(1);
    expect(msgMod.logMirrorMessage(A, "m3")?.trimmed, "裁剪标记同样要读得出来").toBe(1);

    // ③ 重建侧（session-log-bridge → 引擎行）：落库的 hidden 也是 1
    port = createFakeStoragePort({ seed: { sessions: [{ id: A, project_id: "p", title: "t" }] } });
    setStoragePort(port);
    const bridge = await import("../core/storage/session-log-bridge");
    const rebuilt = await bridge.rebuildIndexFromSessionLogs(A);
    expect(rebuilt.messages).toBeGreaterThan(0);
    const rows = port.__table("messages") as Array<Record<string, unknown>>;
    expect(Number(rows.find((r) => r.id === "m2")?.hidden ?? 0), "重建侧必须把隐藏状态还原成 1").toBe(1);
  });

  it("S2-C【同源守卫】: `src/core/storage` 里不再有把 `hidden` 当布尔判的写法，四处都引共用判定", () => {
    const dir = join(__dirname, "..", "core", "storage");
    const read = (f: string) => readFileSync(join(dir, f), "utf8");
    /**
     * ⚠️ 扫描前**必须去注释**（与 `maintenance-rust-mode.test.ts` 的 MR-6 同一条做法）：
     * 这个缺陷本身的说明就写在注释里（"原来写的是 `hidden === true`"），
     * 不去注释的话，判据会被自己的解释文字判红。
     */
    const codeOnly = (src: string) =>
      src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

    const offenders: string[] = [];
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".ts")) continue;
      if (/hidden\s*===\s*true/.test(codeOnly(read(f)))) offenders.push(f);
    }
    expect(offenders, `以下文件仍在把数字当布尔判（这就是那道死防线）：${offenders.join("、")}`).toEqual([]);

    const jsonlSrc = codeOnly(read("session-jsonl.ts"));
    const msgSrc = codeOnly(read("message.ts"));
    const bridgeSrc = codeOnly(read("session-log-bridge.ts"));

    expect(jsonlSrc, "写侧必须用共用判定").toMatch(/hiddenFlagOf\(message/);
    expect(jsonlSrc, "共用判定必须定义在 session-jsonl（唯一来源）").toMatch(
      /export function hiddenFlagOf/,
    );
    expect(msgSrc, "读侧（logMirrorMessage）必须用共用判定").toMatch(/hiddenFlagOf\(rec\)/);
    expect(msgSrc, "合并防线必须用共用判定（且区分裁剪）").toMatch(/isCompressedHidden\(rec\)/);
    expect(bridgeSrc, "重建侧必须用共用判定").toMatch(/hidden:\s*hiddenFlagOf\(rec\)/);
  });
});
