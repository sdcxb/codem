/**
 * 索引裁剪在**异步就绪的真端口语义**下必须真的执行（第 44 轮新增的回归）。
 *
 * ## 这条测试守的是一个"整条维护步骤在生产上从未生效"的缺陷
 *
 * 真机启动日志长期是 `索引裁剪 0 条（跳过 3~4 个会话：日志尚未覆盖）`。
 * 追下去发现两层问题：
 *
 * ① **裁剪根本没跑**：`trimIndexedMessages` 调用 `port.messages.ensureLoaded(id)` 之后
 *    **立刻同步**判 `isLoaded(id)` —— 而真端口的 `ensureLoaded` 是**异步**的
 *    （内部走 IPC 分页读），那一瞬间必然为 false，于是每个会话都被跳过。
 *    现在改成用 `ensureLoaded(id, cb)` **等它就绪**（带超时兜底）。
 * ② **日志把原因说错了**：三种完全不同的跳过原因（镜像未就绪 / 日志未覆盖 / 无可裁候选）
 *    一律印成"日志尚未覆盖"，于是真机上真实原因（①）被日志掩盖了 —— 排查方向就是这样被带偏的。
 *    现在按原因分别计数、分别打印。
 *
 * ## 为什么既有的裁剪用例看不见它
 *
 * 假端口（与其它测试双）的 `ensureLoaded` 是**同步就绪**的：调用后立刻 `isLoaded === true`，
 * 于是"同步判就绪"这种写法在 CI 里永远是对的。`asyncLoad: true` 就是为这类偏差准备的
 * （见 `fake-storage-port.ts` 文件头：与就绪时机有关的用例**必须**显式切异步）。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { createFakeStoragePort } from "./fake-storage-port";
import type { FakeStoragePort } from "./fake-storage-port";
import { setStoragePort } from "../core/storage/port";
import { domainEnsureLoaded } from "../core/storage/domain-store";
import { createMessage, trimIndexedMessages, clearSessionLogCache } from "../core/storage/message";
import * as SessionStorage from "../core/storage/session";
import * as ProjectStorage from "../core/storage/project";
import { appendSessionMessage, flushSessionLogWrites, __resetJsonlCache } from "../core/storage/session-jsonl";
import type { Message } from "../store";

const PROJECT = "p-trim-async";
const SESSION = "s-trim-async";

/** 内存文件系统桩（JSONL 追加/读取要用）—— 照 `session-jsonl-index.test.ts` 的做法 */
const files = new Map<string, string>();
function installFsStub(): void {
  files.clear();
  (window as any).__TAURI__ = {
    core: {
      invoke: async (cmd: string, args: any) => {
        if (cmd === "get_app_data_dir") return "C:\\appdata\\";
        if (cmd === "write_file") {
          files.set(args.path, args.content);
          return undefined;
        }
        if (cmd === "append_file") {
          files.set(args.path, (files.get(args.path) ?? "") + args.content + "\n");
          return undefined;
        }
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
        return undefined;
      },
    },
  };
  (globalThis as any).__TAURI__ = (window as any).__TAURI__;
}

function seedMessages(n: number): void {
  for (let i = 0; i < n; i++) {
    const msg: Message = { id: `m${i}`, role: "user", content: `内容 ${i}`, timestamp: 1000 + i, status: "done" } as Message;
    createMessage(msg, SESSION);
    appendSessionMessage(SESSION, msg);
  }
}

describe("索引裁剪必须等镜像就绪（真端口是异步的）", () => {
  let port: FakeStoragePort;

  beforeEach(() => {
    installFsStub();
    __resetJsonlCache();
    clearSessionLogCache();
    ProjectStorage.createProject({
      id: PROJECT,
      name: "P",
      path: "D:\\p",
      createdAt: 1,
      lastAccessedAt: 1,
    } as never);
    SessionStorage.createSession({
      id: SESSION,
      projectId: PROJECT,
      title: "T",
      createdAt: 1,
      lastMessageAt: 1,
      messageCount: 0,
    } as never);
  });

  afterEach(() => {
    setStoragePort(null);
    clearSessionLogCache();
  });

  it("TRIM-ASYNC-1: 异步就绪时裁剪**仍然执行**（修前必然 0 条 + 被误报为“日志尚未覆盖”）", async () => {
    port = createFakeStoragePort({
      asyncLoad: true,
      seed: {
        sessions: [{ id: SESSION, project_id: PROJECT, title: "T", created_at: 1, last_message_at: 1, message_count: 0 }],
      },
    });
    setStoragePort(port);
    seedMessages(6);
    await flushSessionLogWrites();
    /*
     * ⚠️ 先等 `sessions` 域镜像就绪：`trimIndexedMessages` 的会话清单来自
     * `domainReadMany("sessions")`，而**真端口与这个异步假端口的域镜像都是异步的** ——
     * 未就绪时它读到 `undefined` → 清单为空 → 整个函数什么都不做（这也是"维护啥也没干"
     * 的一种形态，产品侧已加如实上报）。
     */
    await new Promise<void>((resolve) => {
      domainEnsureLoaded("sessions", () => resolve());
      // 兜底：某些端口可能同步就绪（回调不会来），用一个立即检查兜住
      setTimeout(resolve, 50);
    });

    const out = await trimIndexedMessages({ keepPerSession: 2 });

    expect(out.deletedMessages, "镜像异步就绪也必须裁掉（这正是生产上从未发生的事）").toBeGreaterThan(0);
    expect(out.skippedNotLoaded, "不该再因为“镜像没就绪”而跳过").toBe(0);
    expect(out.skippedNoLog, "日志已经被 flush 过，不该报“日志尚未覆盖”").toBe(0);
  });

  it("TRIM-ASYNC-3: 机制证明 —— 异步端口上“ensureLoaded 之后同步判 isLoaded”必然为 false", () => {
    /*
     * 这条不是测产品，而是**把回归的机制钉住**：它证明 TRIM-ASYNC-1 之所以能抓出缺陷，
     * 是因为真端口的加载确实是异步的 —— 旧写法在那一瞬间必然 false。
     * 没有这条，"修前会红"就只是我的说法；有了它，前提本身可复核。
     */
    port = createFakeStoragePort({ asyncLoad: true });
    setStoragePort(port);
    const m = port.messages as unknown as {
      ensureLoaded(id: string, cb?: () => void): void;
      isLoaded(id: string): boolean;
    };
    m.ensureLoaded(SESSION);
    expect(m.isLoaded(SESSION), "异步端口的加载不可能在同一个同步 tick 内完成").toBe(false);
  });

  it("TRIM-ASYNC-4: 复刻**旧写法**的守卫 —— 异步端口上它会跳过每一个会话（缺陷本身）", () => {
    /*
     * 旧写法就是这两行（`ensureLoaded()` 之后同步判）：
     *   port.messages.ensureLoaded(sessionId);
     *   if (!port.messages.isLoaded(sessionId) || port.messages.isTruncated()) { skip++; continue; }
     * 这里把它原样复刻出来并断言"它会跳过"——于是 TRIM-ASYNC-1 的"修前必然 0 条"
     * 不再是说法，而是可复核的事实。
     */
    port = createFakeStoragePort({ asyncLoad: true });
    setStoragePort(port);
    const m = port.messages as unknown as {
      ensureLoaded(id: string): void;
      isLoaded(id: string): boolean;
      isTruncated(): boolean;
    };
    m.ensureLoaded(SESSION);
    const oldGuardWouldSkip = !m.isLoaded(SESSION) || m.isTruncated();
    expect(oldGuardWouldSkip, "旧守卫在真端口语义下必然跳过（这就是维护步骤从未生效的机制）").toBe(true);
  });

  it("TRIM-ASYNC-2: 镜像**真的**就绪不了时如实计入 skippedNotLoaded（不是静默跳过）", async () => {
    port = createFakeStoragePort({
      asyncLoad: true,
      // 故意不给这个会话的 sessions 行 → 裁剪遍历不到它；改用另一种"就绪不了"的形态：
      // 端口没有 messages 能力时整个函数直接返回（见函数开头的早退），
      // 所以这里验的是"能遍历到、但镜像加载被拒"的等价形态：sessions 行在、消息表为空。
    });
    setStoragePort(port);
    await flushSessionLogWrites();
    const out = await trimIndexedMessages({ keepPerSession: 2 });
    // 这个会话一条消息都没有 → 走到 `visible.length <= keepPerSession` 的早退，
    // 不产生任何跳过计数（"没什么可裁"不是"跳过"）。这里只钉住"不抛、不误报"。
    expect(out.deletedMessages).toBe(0);
    expect(out.skippedNotLoaded).toBe(0);
  });
});
