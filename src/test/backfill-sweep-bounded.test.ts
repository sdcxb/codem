/**
 * SWEEP（第 309 波）：会话日志回填的**有界清扫** ✓
 *
 * ## 守的缺陷（真机读数换来的 ✓，见归档 §13.196）
 *
 * 原来的 `backfillAllSessions` 对**全部会话**无条件走一遍 ✓：逐个
 * `ensureLoaded`（消息镜像 `keepSessions = 3` ⇒ **载入一个逐出一个** ✗）
 * + `rebuildSessionFts`（**一次 `fts.rebuild` IPC** ✓）
 * + `backfillSessionLog` + `hydrateSessionLog` ✓。
 *
 * 真机后果（`repo-01 r3`，`1.16.283` ✓）：一次启动维护把 **373 个会话**逐个走了一遍 ✓，
 * console 里 `[RustStoragePort] 切到会话 …` **1 868 条 = 76% 流量** ✗，
 * 而当前回合真正相关的 `[agent-loop]` 只占 **1%** ✓（证据被噪声淹掉 ✓）。
 * 而该机器日志目录里已有 **391 个 `.jsonl`** ✓ ⇒ 绝大多数会话**早就回填过** ✓，
 * `backfillSessionLog` 对它们是**一条都不写**的增量语义 ✓ ⇒ 那三件重活是**纯开销** ✗。
 *
 * ## 判据
 *
 * | # | 判据 |
 * |---|---|
 * | `SWEEP-1` | 一次清扫处理的会话数**不得超过**上限 ✓（今天 = 全部 ✗） |
 * | `SWEEP-2` | 超出的**必须如实计数**（`deferredSessions` ✓）—— 上限**只许推迟、不许静默跳过** ✗ |
 * | `SWEEP-3` | 多个会话时，**"还没有日志文件"的优先** ✓（它们才是真正要回填的 ✓） |
 * | `SWEEP-4` | 跨多次清扫**必须最终覆盖** ✓（证明是"推迟"而不是"永远不管"✓） |
 * | `SWEEP-5` | **反向**：日志确实缺消息的会话**仍然必须被回填** ✓（短路不许把该做的也跳掉 ✗） |
 *
 * 夹具照抄 `log-backfill-readiness.test.ts` ✓（那里的 `installTauri` 文件桩 +
 * `createFakeStoragePort` ✓，以及它自己写明的"必须先把 `sessions` 域镜像等就绪"那条
 * 夹具要点 ✓ —— 漏了它会走早退分支、把"夹具没准备好"伪装成"被测逻辑没干活"✗）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { textWindowSlice } from "./helpers/tauri-fs-stub";

const files = new Map<string, string>();
const SID = "sweep-sid";

/** 与 `log-backfill-readiness.test.ts` **逐条对齐**的 Tauri 文件桩 ✓
 *
 * ⚠️ 我第一版自己简写了一个桩 ✗ ⇒ 三条判据全红在 `backfilled=0` ✓。
 * 漏的正是 `get_app_data_dir` ✓（日志目录的根就从它来 ✓）与 `append_file` 的**换行** ✓
 * —— 这就是为什么**夹具要照抄而不是重写** ✓（`log-backfill-readiness` 的注释里
 * 也写着它自己第一版漏了一步、于是把"夹具没准备好"伪装成"被测逻辑没干活"✗）。 */
function installTauri() {
  const stub = {
    core: {
      invoke: async (cmd: string, args: Record<string, unknown>) => {
        if (cmd === "get_app_data_dir") return "C:\\appdata\\";
        if (cmd === "storage_info") {
          return { engine: "rust", path: "C:\\appdata\\codem-db-rust.bin", exists: true, standard: true, reason: null };
        }
        if (cmd === "write_file") {
          files.set(args.path as string, args.content as string);
          return undefined;
        }
        if (cmd === "append_file") {
          files.set(args.path as string, (files.get(args.path as string) ?? "") + (args.content as string) + "\n");
          return undefined;
        }
        if (cmd === "read_text_window") return textWindowSlice(files, args);
        if (cmd === "read_file") {
          if (!files.has(args.path as string)) throw new Error("no such file");
          return files.get(args.path as string);
        }
        if (cmd === "exists" || cmd === "path_exists") return files.has(args.path as string);
        /**
         * ⚠️ **必须真的列目录** ✓ —— 我第一版照抄了另一个用例的 `return []` ✗
         * （那个用例根本不需要列目录 ✓），于是 `listSessionLogs()` **恒为空** ✗
         * ⇒ "优先补还没有日志的"这条逻辑**永远挑不中已经补过的** ✓
         * ⇒ 轮 2/3 反复挑同一个会话、`backfilled` 一直是 0 ✓（假绿/假红的温床 ✗）。
         * 真机上 `list_directory` 是 Tauri 命令 ✓（`file-api.ts:148` ✓），这里必须等价实现 ✓。
         */
        if (cmd === "list_directory") {
          const prefix = String(args.path ?? "");
          const norm = (s: string) => s.replace(/[\\/]+$/, "");
          const want = norm(prefix);
          const seen = new Set<string>();
          const out: Array<{ name: string; path: string; isDirectory: boolean }> = [];
          for (const key of files.keys()) {
            const idx = Math.max(key.lastIndexOf("\\"), key.lastIndexOf("/"));
            if (idx < 0) continue;
            if (norm(key.slice(0, idx)) !== want) continue;
            const name = key.slice(idx + 1);
            if (seen.has(name)) continue;
            seen.add(name);
            out.push({ name, path: key, isDirectory: false });
          }
          return out;
        }
        return undefined;
      },
    },
  };
  (window as any).__TAURI__ = stub;
  (globalThis as any).__TAURI__ = stub;
}

/** 建端口 + 播种"索引里有消息、但日志还不存在"（不 `ensureLoaded` ✓） */
async function install(sessionCount: number) {
  const { createFakeStoragePort } = await import("./fake-storage-port");
  const { setStoragePort } = await import("../core/storage/port");
  const sessions = Array.from({ length: sessionCount }, (_, i) => ({
    id: i === 0 ? SID : `${SID}-${i}`,
    project_id: "",
    title: "清扫",
    model: null,
    created_at: 1 + i,
    last_message_at: 2 + i,
    message_count: 2,
    pinned: 0,
  }));
  const messages = sessions.flatMap((s) => [
    { id: `${s.id}-m1`, session_id: s.id, role: "user", content: "第一条", reasoning: null, timestamp: 100, model: null, status: "done", hidden: 0, trimmed: 0 },
    { id: `${s.id}-m2`, session_id: s.id, role: "assistant", content: "第二条", reasoning: null, timestamp: 200, model: null, status: "done", hidden: 0, trimmed: 0 },
  ]);
  const port = createFakeStoragePort({ asyncLoad: true, seed: { sessions, messages } });
  setStoragePort(port);
  return port;
}

/** ⚠️ 夹具要点：`backfillAllSessions` 的清单来自 `domainReadMany("sessions")`，
 *  域镜像与消息镜像**是两套独立就绪状态** —— 不显式等，就会走"域镜像未就绪 → 跳过"那条早退 ✓ */
async function waitForSessionsDomain(): Promise<void> {
  const { domainEnsureLoaded } = await import("../core/storage/domain-store");
  await new Promise<void>((resolve) => {
    domainEnsureLoaded("sessions", () => resolve());
    setTimeout(resolve, 50);
  });
}

const logFiles = () => [...files.keys()].filter((k) => k.endsWith(".jsonl"));

beforeEach(() => {
  files.clear();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (window as any).__TAURI__;
  delete (globalThis as any).__TAURI__;
});

describe("SWEEP：会话日志回填必须是有界的（不再是全量清扫）", () => {
  it("SWEEP-1/2: 上限内的会话被处理，超出的**如实计数**（不许静默跳过）", async () => {
    installTauri();
    await install(3);
    const { setStoragePort } = await import("../core/storage/port");
    void setStoragePort;
    await waitForSessionsDomain();
    const { backfillAllSessions } = await import("../core/storage/session-log-bridge");

    const out = await backfillAllSessions({ mirrorWaitMs: 2000, maxSessions: 1 });

    expect(out.deferredSessions, "3 个会话、上限 1 ⇒ 必须有 2 个被**明确推迟**（不是静默跳过）").toBe(2);
    expect(out.backfilled, "上限内的那个会话仍然要被真的回填").toBe(2);
    expect(logFiles().length, "只允许建出 1 个日志文件").toBe(1);
  });

  it("SWEEP-3/4: 优先补'还没有日志'的；跨多次清扫**最终覆盖**", async () => {
    installTauri();
    await install(3);
    await waitForSessionsDomain();
    const { backfillAllSessions } = await import("../core/storage/session-log-bridge");

    const first = await backfillAllSessions({ mirrorWaitMs: 2000, maxSessions: 1 });
    expect(first.deferredSessions).toBe(2);
    const afterFirst = logFiles().length;
    expect(afterFirst, "第一次必须真的建出一个").toBe(1);

    /** 再扫两次 ⇒ 三个会话应当都被覆盖到（证明是"推迟"而不是"永远不管"✓） */
    await backfillAllSessions({ mirrorWaitMs: 2000, maxSessions: 1 });
    await backfillAllSessions({ mirrorWaitMs: 2000, maxSessions: 1 });
    expect(logFiles().length, "三次清扫、每次 1 个 ⇒ 三个会话都要被覆盖").toBe(3);
  });

  it("SWEEP-5（反向）: 日志确实缺消息的会话**仍然必须被回填**（短路不许把该做的跳掉）", async () => {
    installTauri();
    await install(1);
    await waitForSessionsDomain();
    const { backfillAllSessions } = await import("../core/storage/session-log-bridge");

    // 夹具前提：这一刻日志还没有（真缺）
    expect(logFiles(), "夹具前提：日志还不存在").toHaveLength(0);
    const out = await backfillAllSessions({ mirrorWaitMs: 2000 });
    expect(out.backfilled, "**真缺的必须回填** —— 这是本文件最重要的反向判据").toBe(2);
    expect(out.deferredSessions, "只有一个会话，不需要推迟").toBe(0);
    expect(logFiles(), "日志必须真的被建出来").toHaveLength(1);
    expect(files.get(logFiles()[0])).toContain(`${SID}-m1`);
    expect(files.get(logFiles()[0])).toContain(`${SID}-m2`);
  });
});
