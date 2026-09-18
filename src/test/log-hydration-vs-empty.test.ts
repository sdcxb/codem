/**
 * 索引为空 + 权威日志还没读 → **不许渲染成「开始新对话」**（第 50 轮，关掉最后一段残留缺口）
 *
 * ## 守的缺陷（这是"空 vs 读不到"这一类的最后一段）
 *
 * `listMessages` 合并的是**索引 + 权威日志**，两者都为空时它返回 `[]` —— 而这一个 `[]`
 * 在过去同时代表三件事：①真的没有消息；②索引镜像还在加载；③**权威日志还没 hydrate**。
 * 第 49 轮关掉了②（"还没到"渲染成加载态），①③仍然混在一起。
 *
 * ③ 的后果与②不同、而且更重：日志才是**权威副本**，索引只是可重建的查询索引。
 * "索引为空而日志里有内容"正是这套架构要救的场景（索引被裁 / 崩溃丢掉写入），
 * 而那时界面会说"这个会话没有消息"、渲染**欢迎页**，用户以为自己那个有内容的会话被清空了。
 *
 * ## 为什么这条以前没人发现
 *
 * 进会话时**没有生产代码**调 `hydrateSessionLog` —— 日志只在**启动维护的回填**里被 hydrate。
 * 于是"启动维护跑完"之后一切正常，缺陷只在"维护还没跑到那个会话"时出现，
 * 而用例里大家都是先 `await hydrateSessionLog(...)` 再读（测试把这一步替做了）。
 *
 * ## 判据
 *
 * | 情形 | `messagesLoading` | `messagesReadUnavailable` | 界面 |
 * | --- | --- | --- | --- |
 * | 索引空 + 日志**还没读** | `true` | `false` | 「正在读取历史消息…」 |
 * | 索引空 + 日志读到 3 条 | `false`（消息已渲染） | `false` | 3 条消息 |
 * | 索引空 + 日志读过、确实为空 | `false` | `false` | 欢迎页（**正确的**空会话） |
 * | 索引空 + 日志**读失败** | `false` | `true` | 「暂时读不到…」+ 重试 |
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setStoragePort } from "../core/storage/port";
import { resetPersistFailures } from "../core/storage/persist-failure";
import { __resetSaveFingerprints, useAppStore } from "../store";
import { createFakeStoragePort, type FakeStoragePort } from "./fake-storage-port";

const SESSION = "sess-log-lagging";
const APP_DIR = "C:/fake-appdata/";
const files = new Map<string, string>();

/** 夹具：假的应用数据目录 + 假的文件 IPC（JSONL 走这两个动词） */
function installFakeFs(seedJsonl: string | null, opts: { readFails?: boolean } = {}) {
  files.clear();
  const logPath = `${APP_DIR}sessions/${SESSION}.jsonl`;
  if (seedJsonl !== null) files.set(logPath, seedJsonl);
  (globalThis as any).window = globalThis.window ?? ({} as any);
  (window as any).__TAURI__ = {
    core: {
      invoke: async (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === "get_app_data_dir") return APP_DIR;
        if (cmd === "read_file") {
          if (opts.readFails) throw new Error("IPC 读文件失败");
          const p = String(args?.path);
          if (!files.has(p)) throw new Error(`not found: ${p}`);
          return files.get(p);
        }
        if (cmd === "write_file") {
          files.set(String(args?.path), String(args?.content ?? ""));
          return null;
        }
        if (cmd === "list_directory") return { entries: [], files: [] };
        return null;
      },
    },
  };
  return logPath;
}

/** 一行合法 JSONL 记录（只给读路径真正需要的字段） */
const jsonlLine = (id: string, content: string, ts: number) =>
  JSON.stringify({ id, role: "user", content, timestamp: ts });

let port: FakeStoragePort;

beforeEach(async () => {
  resetPersistFailures();
  __resetSaveFingerprints();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});

  // 索引里**这个会话一行都没有**（模拟"索引被裁 / 崩溃丢掉写入"）
  port = createFakeStoragePort({
    seed: {
      sessions: [
        { id: SESSION, project_id: "p1", title: "S", created_at: 1, last_message_at: 2, message_count: 0 },
      ],
      messages: [],
    },
  });
  setStoragePort(port);

  const msgMod = await import("../core/storage/message");
  msgMod.clearSessionLogCache();
  msgMod.__resetSessionLogReadFailuresForTests();
  const jsonl = await import("../core/storage/session-jsonl");
  jsonl.__resetJsonlCache?.();

  const s = useAppStore.getState();
  s.clearMessages();
});

afterEach(() => {
  useAppStore.getState().clearMessages();
  setStoragePort(null);
  __resetSaveFingerprints();
  resetPersistFailures();
  vi.restoreAllMocks();
  delete (window as any).__TAURI__;
});

/** 等条件成立（这条链是异步的：读文件 + 回调重读） */
async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return cond();
}

describe("LOGLAG：索引为空时，权威日志读没读决定了界面该说什么", () => {
  it("LOGLAG-1: 索引空 + 日志还没读 → **不许**渲染欢迎页（应报'正在读取'），读到后消息自动出现", async () => {
    installFakeFs(
      [jsonlLine("m1", "第一条", 1000), jsonlLine("m2", "第二条", 1001), jsonlLine("m3", "第三条", 1002)].join("\n"),
    );

    useAppStore.getState().loadMessages(SESSION);

    // 同步这一帧：索引空、日志还没读 → 既不是"读不到"，也**不能**是"真的空"
    const during = useAppStore.getState();
    expect(during.messages.length, "前置：这一帧确实读不到东西").toBe(0);
    expect(
      during.messagesReadUnavailable,
      "日志还没读 ≠ 读不到（这是'还没到'）",
    ).toBe(false);
    expect(
      during.messagesLoading,
      "必须进入加载态 —— 否则界面会渲染欢迎页'开始新对话'，用户以为会话被清空了",
    ).toBe(true);

    // 日志读完之后：消息要自动补上（不许停在加载态）
    const arrived = await waitFor(() => useAppStore.getState().messages.length === 3);
    expect(arrived, "索引为空但日志里有 3 条 → 读路径必须把它们合并出来").toBe(true);
    const after = useAppStore.getState();
    expect(after.messages.map((m) => m.content)).toEqual(["第一条", "第二条", "第三条"]);
    expect(after.messagesLoading, "消息到了就该退出加载态").toBe(false);
    expect(after.messagesReadUnavailable).toBe(false);
  });

  it("LOGLAG-2: 索引空 + 日志读过、确实为空 → 落到欢迎页（**正确的**空会话，不许卡在加载态）", async () => {
    installFakeFs(null); // 目录里没有这个会话的日志文件

    useAppStore.getState().loadMessages(SESSION);

    expect(useAppStore.getState().messagesLoading, "第一帧：日志还没读 → 加载态").toBe(true);

    const settled = await waitFor(() => useAppStore.getState().messagesLoading === false);
    expect(
      settled,
      "日志读过了（文件不存在 = 读到 0 条，是一次定论）→ 必须退出加载态，否则界面永远停在'正在读取…'",
    ).toBe(true);
    const after = useAppStore.getState();
    expect(after.messages.length).toBe(0);
    expect(
      after.messagesReadUnavailable,
      "这是真的空会话 → 欢迎页是对的，不该报'读不到'",
    ).toBe(false);
  });

  it("LOGLAG-3: 读日志**失败** → 说'读不到'（不许把失败谎报成'这个会话没有消息'）", async () => {
    installFakeFs("", { readFails: true });

    useAppStore.getState().loadMessages(SESSION);

    /*
     * 读失败必须变成 `sessionLogReadState === "failed"`。
     * ⚠️ 注意 `readSessionMessages` 内部把"文件不存在"也当成空（那是正常的），
     * 所以这里用 `read_file` 直接抛错来制造真正的失败。
     */
    const message = await import("../core/storage/message");
    const failed = await waitFor(() => message.sessionLogReadState(SESSION) === "failed");
    expect(failed, "读失败的会话必须被记成定论（failed），不能永远留在 pending").toBe(true);
    expect(
      message.sessionLogReadState(SESSION),
      "pending 会让界面永远显示'正在读取…'，那比'读不到'更糟",
    ).toBe("failed");
  });

  it("LOGLAG-4: 三态判据本身（hydrated / pending / failed）", async () => {
    installFakeFs(jsonlLine("m1", "有内容", 1000));
    const message = await import("../core/storage/message");

    expect(message.sessionLogReadState(SESSION), "还没读过 → pending").toBe("pending");

    const n = await message.hydrateSessionLog(SESSION);
    expect(n).toBe(1);
    expect(message.sessionLogReadState(SESSION), "读过（哪怕 0 条）→ hydrated").toBe("hydrated");

    // 幂等：重复 ensure 不会重复读（回调立即触发）
    let called = 0;
    message.ensureSessionLogHydrated(SESSION, () => { called++; });
    await new Promise((r) => setTimeout(r, 20));
    expect(called, "已 hydrated → 回调立刻执行（不再发 IO）").toBe(1);
  });
});
