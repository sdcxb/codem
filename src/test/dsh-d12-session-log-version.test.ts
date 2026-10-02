/**
 * DSH-D12 —— 会话日志的**格式版本**必须被读侧校验：更新版本写的日志要**大声失败**，
 * 不能被读成「正文是空的消息」（第 103+ 轮）。
 *
 * ## 缺陷
 *
 * 写侧一直在写版本（`session-jsonl.ts::appendSessionMessage` 的 `v: LINE_VERSION`，
 * 墓碑那两条也一样），而**读侧从来没有读过 `v`**（全仓 `parsed.v` 零引用）。
 * 于是「版本」只写在纸上，一份**更新版本**写的日志会被当成普通行读进来：
 *
 * - 字段改名 → 落到默认值（serializer 那句 `content: typeof … === "string" ? … : ""`
 *   会把正文读成**空串**）；
 * - 而日志是**权威副本**：读路径「日志覆盖索引」、索引重建按日志落库 ——
 *   于是「读成空」不只是这一次显示错了，它会被**固化**进用户数据（静默降级）。
 *
 * 前车之鉴就在仓库里：`src/core/recovery/recovery.ts:54-78` 那个
 * `if (parsed.version === 1) { return parsed; } } catch {}` + 「返回默认数据」的写法，
 * 把「看不懂的新数据」直接替换成默认值。
 *
 * ## 本轮的政策（**不做迁移链**）
 *
 * | 行里的 `v` | 处置 |
 * | --- | --- |
 * | 缺失 / 非数字 | 视为 **v0（最老的格式）**，照旧读 —— **不报错**（本机真有这种日志；测试夹具里也大量存在） |
 * | `v ≤ LINE_VERSION`（0 或 1） | 照旧读 |
 * | `v > LINE_VERSION` | **抛 `E_SESSION_LOG_VERSION`**（稳定机器可读代码） |
 *
 * ## 读失败必须**流进三态机制**，不能被吞成「没有数据」
 *
 * `session-jsonl.ts` 里 `readSessionMessages` 的 catch 早就写明这条纪律：只有「文件确实不存在」
 * 才返回空，其余**照原样抛出**。所以版本错误必须穿过 `forEachLogLine` → 那个 catch →
 * `hydrateSessionLog` 的 `logReadFailures` ⇒ `sessionLogReadState()` 变 **`failed`**
 * （界面说「暂时读不到…」并给重试，而不是欢迎页）。本文件把这条链路整条钉住。
 *
 * ## 桩的忠实度
 *
 * 与 `dsh-d11-…` 同一套：`write_file` 是「临时文件 + rename 覆盖」（`lib.rs:720-739`），
 * `append_file` 是 `writeln!`（追加 + 换行，**不 fsync**，`lib.rs:767-780`）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetPersistFailures } from "../core/storage/persist-failure";
import { setStoragePort } from "../core/storage/port";
import { __resetDataRootCache } from "../core/storage/data-root";
import { createFakeStoragePort } from "./fake-storage-port";
import { readFileWithCap, textWindowSlice } from "./helpers/tauri-fs-stub";

const S = "sess-dsh-d12";
const APP_DIR = "C:/fake-appdata/";
const files = new Map<string, string>();

function installFakeFs(): void {
  files.clear();
  (globalThis as any).window = globalThis.window ?? ({} as any);
  (window as any).__TAURI__ = {
    core: {
      invoke: async (cmd: string, args?: Record<string, unknown>) => {
        const path = String(args?.path ?? "");
        if (cmd === "get_app_data_dir") return APP_DIR;
        if (cmd === "read_text_window") return textWindowSlice(files, args);
        if (cmd === "read_file") return readFileWithCap(files, args);
        if (cmd === "append_file") {
          files.set(path, (files.get(path) ?? "") + String(args?.content ?? "") + "\n");
          return null;
        }
        if (cmd === "write_file") {
          // Rust 侧：同目录 `.{文件名}.codem-tmp` → fsync → rename 覆盖
          const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
          const tmp = `${path.slice(0, cut + 1)}.${path.slice(cut + 1)}.codem-tmp`;
          files.set(tmp, String(args?.content ?? ""));
          const content = files.get(tmp)!;
          files.delete(tmp);
          files.set(path, content);
          return null;
        }
        if (cmd === "rename_file") {
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

/**
 * 未来版本的一行：字段还**改了名**（`body` 而不是 `content`）。
 *
 * 这正是「静默降级」最危险的形态：旧读法不报错，它只是把 `content` 取成 `""`
 * —— 一条**空正文的助手消息**，而随后的写路径会把它当成事实重新持久化。
 */
const FUTURE_LINE = JSON.stringify({ v: 2, id: "m1", role: "assistant", body: "新格式正文", timestamp: 1 });

/** 用产品自己的写入器把日志写到磁盘（走 write_file，即「临时文件 + rename」那条路） */
async function writeLog(lines: string[]): Promise<void> {
  const { __writeSessionLogForTests, flushSessionLogWrites, __resetJsonlCache } = await import(
    "../core/storage/session-jsonl"
  );
  __resetJsonlCache();
  await __writeSessionLogForTests(S, lines);
  await flushSessionLogWrites();
}

beforeEach(async () => {
  resetPersistFailures();
  installFakeFs();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  setStoragePort(createFakeStoragePort());
  const msgMod = await import("../core/storage/message");
  msgMod.clearSessionLogCache();
  msgMod.__resetSessionLogReadFailuresForTests();
  (await import("../core/storage/session-jsonl")).__resetJsonlCache();
  __resetDataRootCache();
});

afterEach(() => {
  setStoragePort(null);
  resetPersistFailures();
  vi.restoreAllMocks();
  delete (window as any).__TAURI__;
});

describe("会话日志的格式版本（写侧写了，读侧必须校验）", () => {
  it("D12-1: `v` 高于本版本 ⇒ 大声失败（稳定错误码），绝不吐一条空正文的消息", async () => {
    await writeLog([FUTURE_LINE]);

    const { readSessionMessages, isSessionLogVersionError, SESSION_LOG_VERSION_ERROR_CODE } = await import(
      "../core/storage/session-jsonl"
    );

    // ① 直接读：必须抛（而不是「跳过一个坏行 + 返回空集合」）
    let thrown: unknown = null;
    try {
      const r = await readSessionMessages(S);
      // 走到这里就说明它「读成功了」—— 那正是缺陷形态：结果里会有一条空正文的 m1
      thrown = { resolved: r };
    } catch (e) {
      thrown = e;
    }
    expect(
      thrown,
      "更新版本的日志必须让读**失败**；若这里解析出结果，那就是把「看不懂」降级成了「没有内容」",
    ).toBeInstanceOf(Error);
    const err = thrown as Error & { code?: string; foundVersion?: number };
    expect(err.message, "错误必须带稳定机器可读代码 E_SESSION_LOG_VERSION").toContain(
      SESSION_LOG_VERSION_ERROR_CODE,
    );
    expect(err.code, "代码要能在 catch 里按字段读出来（不是靠正则匹配文案）").toBe(
      SESSION_LOG_VERSION_ERROR_CODE,
    );
    expect(err.foundVersion, "错误要如实带上日志里写的那个版本").toBe(2);
    expect(isSessionLogVersionError(err), "调用方要有一个稳定的判据函数").toBe(true);
  });

  it("D12-2: 读失败必须流进三态机制（failed），不许被写成「这个会话没有消息」", async () => {
    await writeLog([FUTURE_LINE]);

    const msgMod = await import("../core/storage/message");
    const { sessionLogReadState, hydrateSessionLog, logLiveMessageCount, listMessages, logMirrorMessage } = msgMod;

    expect(sessionLogReadState(S), "夹具前提：还没读过 → pending").toBe("pending");

    // 读失败 ⇒ 返回 0（调用方接口不变）但**状态是 failed**，不是 hydrated
    expect(await hydrateSessionLog(S)).toBe(0);
    expect(
      sessionLogReadState(S),
      "读失败必须是 failed —— 界面据此说「暂时读不到」并给重试；hydrated 会让界面说「这个会话是空的」",
    ).toBe("failed");
    expect(logLiveMessageCount(S), "读失败的会话**不许**驻留一份空镜像（null = 不知道，不是 0）").toBeNull();

    // ② 结果里**不能**出现 id === "m1" 且正文为空的消息
    const listed = listMessages(S);
    expect(
      listed.find((m) => m.id === "m1" && (m.content ?? "") === ""),
      "这正是缺陷形态：`body` 字段名读不出来 → 正文变成空串 → 一条空的助手消息",
    ).toBeUndefined();
    expect(listed.some((m) => m.id === "m1"), "读不出来的会话不该吐出半条消息").toBe(false);
    expect(logMirrorMessage(S, "m1"), "日志镜像里也不许有它").toBeNull();
    expect(msgMod.getMessage("m1"), "索引里本来就没有它（日志是唯一来源）").toBeNull();
  });

  it("D12-3: 混合日志里只要有一行是更新版本 ⇒ 整份读取失败（不许跳过新行、只读旧行）", async () => {
    await writeLog([
      JSON.stringify({ v: 1, id: "old1", role: "user", content: "能读懂的一行", timestamp: 1 }),
      FUTURE_LINE,
    ]);

    const { readSessionMessages } = await import("../core/storage/session-jsonl");
    await expect(
      readSessionMessages(S),
      "同 id 后写者胜的语义救不了这件事：新版本的行可能是**任何**一条消息的新版本，" +
        "跳过它等于静默丢数据；所以整份读取失败（上层会说「读不到」并给重试）",
    ).rejects.toThrow(/E_SESSION_LOG_VERSION/);
  });

  it("D12-4: 兼容方向 —— 没有 `v` 字段的老日志照旧读得出来（v0 政策，绝不报错）", async () => {
    await writeLog([
      JSON.stringify({ id: "old1", role: "user", content: "更早的格式：没有 v 字段", timestamp: 1 }),
      JSON.stringify({ v: 1, id: "old2", role: "assistant", content: "当前格式", timestamp: 2 }),
    ]);

    const { readSessionMessages } = await import("../core/storage/session-jsonl");
    const { messages, skippedLines } = await readSessionMessages(S);
    expect(skippedLines, "老日志不是坏行").toBe(0);
    expect(messages.map((m) => m.id).sort()).toEqual(["old1", "old2"]);
    expect(messages.find((m) => m.id === "old1")?.content).toBe("更早的格式：没有 v 字段");
    expect(messages.find((m) => m.id === "old2")?.content).toBe("当前格式");

    const msgMod = await import("../core/storage/message");
    expect(await msgMod.hydrateSessionLog(S), "两条都要读进来").toBe(2);
    expect(msgMod.sessionLogReadState(S)).toBe("hydrated");
    expect(msgMod.listMessages(S).map((m) => m.content)).toEqual(["更早的格式：没有 v 字段", "当前格式"]);
  });

  it("D12-5: 版本校验不改变「坏行只计数」的既有语义（半截 JSON 仍然只计数、不致命）", async () => {
    await writeLog([
      JSON.stringify({ v: 1, id: "ok1", role: "user", content: "好行", timestamp: 1 }),
      "{ 这行是半截 JSON", // 崩在写入中途的形态
      JSON.stringify({ v: 1, id: "ok2", role: "assistant", content: "好行 2", timestamp: 2 }),
    ]);

    const { readSessionMessages } = await import("../core/storage/session-jsonl");
    const { messages, skippedLines } = await readSessionMessages(S);
    expect(skippedLines, "坏行仍然只计数（版本校验只对「看得懂的 JSON + 更新的版本」生效）").toBe(1);
    expect(messages.map((m) => m.id)).toEqual(["ok1", "ok2"]);
  });
});
