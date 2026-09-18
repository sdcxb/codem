/**
 * 「读不到」不许被渲染成「你没有数据」（第 47 轮补，UI/UX 审计 P1）
 *
 * ## 守的缺陷
 *
 * 三处把"这次读没有真的拿到数据"与"确实没有数据"渲染成同一个界面：
 * 1. `SnapshotService.getAll()` 的 `catch { return [] }` → 调用方的 `readFailed`
 *    守卫**永远不可能为真**，那个"快照列表读取失败，请重试"的分支**永不渲染** ——
 *    用户看到「暂无快照」，以为快照丢了；
 * 2. `store.loadMessages` 读失败 → `messages: []` → 界面显示「开始新对话」欢迎页，
 *    用户以为**对话被清空了**（仓库自己记过一次真机事故：确实有 27 条消息的会话
 *    点开是空白且无任何报错），之后输入的每句话都追加进这个他以为"空"的会话；
 * 3. `loadFromDB` 失败 → 「暂无项目」。
 *
 * ## 为什么这组用例**直接驱动真实实现**
 *
 * 原来那条 `RL-2a` 把 `getAll` **打桩成 throw** 来验证"读取失败要可见" ——
 * 于是它是**永远绿的**：真实实现根本不 reject，那个分支在真机上永远不会走到。
 * 这就是"测试双比实现宽松把缺陷藏起来"的经典形态（本仓库第 46/47 轮已因此栽过几次）。
 * 所以这里**不 mock 服务**，只 mock 最底层的文件 API，让真实的 `catch` 逻辑跑起来。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/** 最底层文件 API 的替身：`failList` 为真时 `listDirectory` 抛错（模拟引擎/目录读不出来） */
const fsMock = vi.hoisted(() => ({
  failList: false,
  files: new Map<string, string>(),
  entries: [] as Array<{ name: string; path: string; isDirectory: boolean }>,
}));

vi.mock("../core/file-api", () => ({
  readFile: async (p: string) => {
    const v = fsMock.files.get(p.replace(/\\/g, "/"));
    if (v === undefined) throw new Error(`ENOENT: ${p}`);
    return v;
  },
  writeFile: async (p: string, c: string) => {
    fsMock.files.set(p.replace(/\\/g, "/"), c);
  },
  listDirectory: async () => {
    if (fsMock.failList) throw new Error("引擎不可用：读目录失败");
    return fsMock.entries;
  },
  makeDirectory: async () => {},
  deleteDirectoryPermanent: async () => {},
  deleteFile: async () => {},
  deletePath: async () => {},
  exists: async () => false,
  renameFile: async () => {},
  appendFile: async () => {},
}));

beforeEach(() => {
  fsMock.failList = false;
  fsMock.files.clear();
  fsMock.entries = [];
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("READFAIL：'读不到'必须与'没有数据'分开", () => {
  it("READFAIL-1: 列目录失败时 getAll 必须**抛出**，而不是返回空数组", async () => {
    const { SnapshotService } = await import("../core/snapshot/snapshot");
    const svc = new SnapshotService("C:/ws");
    fsMock.failList = true;

    /*
     * 改前：`catch { return [] }` → 调用方拿到空数组，`readFailed` 永远不置真，
     * 界面显示「暂无快照」（用户以为快照丢了）。
     */
    await expect(
      svc.getAll(),
      "读不到目录必须抛出，让调用方能显示'读取失败'而不是'暂无快照'",
    ).rejects.toThrow(/读目录失败/);
  });

  it("READFAIL-2: 目录读得到但没有快照 → 返回空数组（这才是真的'暂无快照'）", async () => {
    const { SnapshotService } = await import("../core/snapshot/snapshot");
    const svc = new SnapshotService("C:/ws");
    fsMock.entries = [];

    await expect(svc.getAll(), "确实没有快照 → 空数组，不抛").resolves.toEqual([]);
  });

  it("READFAIL-3: 单个快照文件坏掉 → 跳过它但**其余照常列出**（一个坏文件不该让整张列表消失）", async () => {
    const { SnapshotService } = await import("../core/snapshot/snapshot");
    const svc = new SnapshotService("C:/ws");
    fsMock.entries = [
      { name: "good.json", path: "C:/ws/.codem-snapshots/good.json", isDirectory: false },
      { name: "bad.json", path: "C:/ws/.codem-snapshots/bad.json", isDirectory: false },
    ];
    fsMock.files.set(
      "C:/ws/.codem-snapshots/good.json",
      JSON.stringify({ id: "good", sessionId: "s", messageIndex: 0, timestamp: 2, files: [] }),
    );
    fsMock.files.set("C:/ws/.codem-snapshots/bad.json", "{ 这不是合法 JSON");

    const list = await svc.getAll();
    expect(list.map((s) => s.id), "坏的跳过、好的照常").toEqual(["good"]);
  });

  it("READFAIL-4: 快照按时间倒序返回（最新在前）—— 这条不变量不许被改动破坏", async () => {
    const { SnapshotService } = await import("../core/snapshot/snapshot");
    const svc = new SnapshotService("C:/ws");
    fsMock.entries = [
      { name: "old.json", path: "C:/ws/.codem-snapshots/old.json", isDirectory: false },
      { name: "new.json", path: "C:/ws/.codem-snapshots/new.json", isDirectory: false },
    ];
    fsMock.files.set(
      "C:/ws/.codem-snapshots/old.json",
      JSON.stringify({ id: "old", sessionId: "s", messageIndex: 0, timestamp: 100, files: [] }),
    );
    fsMock.files.set(
      "C:/ws/.codem-snapshots/new.json",
      JSON.stringify({ id: "new", sessionId: "s", messageIndex: 0, timestamp: 200, files: [] }),
    );

    expect((await svc.getAll()).map((s) => s.id)).toEqual(["new", "old"]);
  });
});

describe("READFAIL：store 的 messagesReadUnavailable 三态", () => {
  /** 让"读路径可用性"判据返回指定位（避免依赖真实端口/镜像状态） */
  async function stubReadAvailability(unavailable: boolean) {
    const msgMod = await import("../core/storage/message");
    vi.spyOn(msgMod, "isMessagesReadUnavailable").mockReturnValue(unavailable);
    return msgMod;
  }

  it("READFAIL-5: 读路径**可用**且确实为空 → unavailable=false（欢迎页是对的）", async () => {
    const { useAppStore } = await import("../store");
    const msgMod = await stubReadAvailability(false);
    vi.spyOn(msgMod, "listMessages").mockReturnValue([]);

    useAppStore.getState().loadMessages("s-empty");

    expect(useAppStore.getState().messages.length).toBe(0);
    expect(
      useAppStore.getState().messagesReadUnavailable,
      "读路径可用 + 空 = 真没有消息 → 欢迎页（改前与改后一致，这条防止把正常路径改坏）",
    ).toBe(false);
  });

  it("READFAIL-6: 读到的会话**有消息** → unavailable=false（正常路径）", async () => {
    const { useAppStore } = await import("../store");
    const msgMod = await stubReadAvailability(false);
    vi.spyOn(msgMod, "listMessages").mockReturnValue([
      { id: "m1", role: "user", content: "hi", timestamp: 1 } as never,
    ]);

    useAppStore.getState().loadMessages("s-has");

    expect(useAppStore.getState().messages.length).toBe(1);
    expect(
      useAppStore.getState().messagesReadUnavailable,
      "有消息 → 当然不是'读不到'",
    ).toBe(false);
  });

  it("READFAIL-7: 读取**抛错** → unavailable=true（界面必须说'读不到'，不能说'你没有数据'）", async () => {
    const { useAppStore } = await import("../store");
    const msgMod = await stubReadAvailability(true);
    vi.spyOn(msgMod, "listMessages").mockImplementation(() => {
      throw new Error("引擎不可用");
    });

    useAppStore.getState().loadMessages("s-boom");

    expect(useAppStore.getState().messages.length).toBe(0);
    expect(
      useAppStore.getState().messagesReadUnavailable,
      "读抛错 = 读不到 → 界面要显示'暂时读不到你的历史'+重试，而不是欢迎页",
    ).toBe(true);
  });

  it("READFAIL-8: 读路径**不可用**（镜像没接手）→ 即使返回空也标 unavailable", async () => {
    const { useAppStore } = await import("../store");
    const msgMod = await stubReadAvailability(true);
    /*
     * 这正是真机事故的形态：会话里**确实有 27 条消息**，但镜像还没接手 →
     * `listMessages` 返回空 → 改前渲染成"开始新对话"，用户以为对话被清空了。
     */
    vi.spyOn(msgMod, "listMessages").mockReturnValue([]);

    useAppStore.getState().loadMessages("s-mirror-lagging");

    expect(useAppStore.getState().messages.length).toBe(0);
    expect(
      useAppStore.getState().messagesReadUnavailable,
      "读路径不可用 → 必须说'读不到'（这条就是那次 27 条消息会话显示空白的形态）",
    ).toBe(true);
  });
});

// ==========================================================================
// READFAIL：项目列表的第三处同形（loadFromDB → 「暂无项目」）
// ==========================================================================

describe("READFAIL：项目列表的三态（第三处同形）", () => {
  async function stubProjectRead(unavailable: boolean) {
    const projMod = await import("../core/storage/project");
    vi.spyOn(projMod, "isProjectsReadUnavailable").mockReturnValue(unavailable);
    return projMod;
  }

  it("READFAIL-9: 项目**确实为空**且读路径可用 → unavailable=false（「暂无项目」是对的）", async () => {
    const { useProjectStore } = await import("../core/store");
    const projMod = await stubProjectRead(false);
    vi.spyOn(projMod, "listProjects").mockReturnValue([]);

    useProjectStore.getState().loadFromDB();

    expect(useProjectStore.getState().projects.length).toBe(0);
    expect(
      useProjectStore.getState().projectsReadUnavailable,
      "读路径可用 + 空 = 用户确实没有项目 → 显示「暂无项目」正确",
    ).toBe(false);
  });

  it("READFAIL-10: 读路径**不可用** → unavailable=true（必须说'暂时读不到'，不能说'你没有项目'）", async () => {
    const { useProjectStore } = await import("../core/store");
    const projMod = await stubProjectRead(true);
    // 冷启动/引擎起不来时的形态：镜像还没接手 → listProjects() 返回空
    vi.spyOn(projMod, "listProjects").mockReturnValue([]);

    useProjectStore.getState().loadFromDB();

    expect(useProjectStore.getState().projects.length).toBe(0);
    expect(
      useProjectStore.getState().projectsReadUnavailable,
      "读路径不可用 → 必须说'暂时读不到'（否则用户会以为自己建过的项目全没了）",
    ).toBe(true);
  });

  it("READFAIL-11: 列项目**抛错** → unavailable=true（抛错也是'读不到'，不是空列表）", async () => {
    const { useProjectStore } = await import("../core/store");
    await stubProjectRead(false);
    const projMod = await import("../core/storage/project");
    vi.spyOn(projMod, "listProjects").mockImplementation(() => {
      throw new Error("引擎不可用");
    });

    useProjectStore.getState().loadFromDB();

    expect(useProjectStore.getState().projectsReadUnavailable).toBe(true);
    expect(useProjectStore.getState().dbReady, "dbReady 仍要为真，否则界面会一直卡在加载态").toBe(true);
  });

  it("READFAIL-12: 有项目 → unavailable=false（正常路径不许被改坏）", async () => {
    const { useProjectStore } = await import("../core/store");
    const projMod = await stubProjectRead(false);
    vi.spyOn(projMod, "listProjects").mockReturnValue([
      { id: "p1", name: "P", path: "C:/p", createdAt: 1, lastAccessedAt: 2 } as never,
    ]);

    useProjectStore.getState().loadFromDB();

    expect(useProjectStore.getState().projects.length).toBe(1);
    expect(useProjectStore.getState().projectsReadUnavailable).toBe(false);
  });
});
