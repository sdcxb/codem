/**
 * 「回滚」必须可知情、可撤销（第 47 轮补，UI/UX 审计 P0）
 *
 * ## 守的缺陷
 *
 * 两个回滚入口（`SnapshotPanel` 的快照回滚、`FileChangesList` 的单轮回滚）原来
 * **单击即执行**：覆盖快照里记过的文件、**永久删除**快照之后新建的文件，
 * 而回滚前的状态只被读进 `FileChange.before` 用于打印一句"N 个文件"，随即丢弃 ——
 * 一次误点 = 用户此后所有修改全部消失，**没有任何路径拿回来**。
 * 仓库对更轻的操作都有确认（删会话/删项目/清遥测/恢复面板），只有这两处没有。
 *
 * ## 本文件守什么
 *
 * | 组 | 守什么 |
 * | --- | --- |
 * | `SNAP47-1` | `preview()` **只读**：算出"将覆盖哪些、将删除哪些"，且不写任何文件 |
 * | `SNAP47-2` | `preview()` 的分类正确（`isNew` 且存在 → 删除；其余 → 覆盖） |
 * | `SNAP47-3` | `restore()` 在动手**之前**创建"回滚前自动快照"，且它记录的是**当前**内容 |
 * | `SNAP47-4` | 回滚前快照的存在使得"回滚可再退回"（拿它再回滚一次能恢复原状） |
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * 一个最小的内存文件系统替身，接到 `snapshot.ts` 依赖的 file-api 上。
 *
 * 为什么要这一层：`SnapshotService` 的 `restore()` 会真的读写文件，
 * 而"回滚前快照"这件事**只能通过观察它读了什么、写了什么**来验证。
 */
const files = new Map<string, string>();
const writes: Array<{ path: string; content: string }> = [];
const deletes: string[] = [];

vi.mock("../core/file-api", () => ({
  readFile: async (p: string) => {
    const v = files.get(p.replace(/\\/g, "/"));
    if (v === undefined) throw new Error(`ENOENT: ${p}`);
    return v;
  },
  writeFile: async (p: string, c: string) => {
    const key = p.replace(/\\/g, "/");
    files.set(key, c);
    writes.push({ path: key, content: c });
  },
  listDirectory: async () => [] as Array<{ name: string; path: string; isDirectory: boolean }>,
  makeDirectory: async () => {},
  deleteDirectoryPermanent: async (p: string) => {
    deletes.push(p);
    files.delete(p.replace(/\\/g, "/"));
  },
  deleteFile: async (p: string) => {
    deletes.push(p);
    files.delete(p.replace(/\\/g, "/"));
  },
  deletePath: async (p: string) => {
    deletes.push(p);
    files.delete(p.replace(/\\/g, "/"));
  },
  listDirectoryRecursive: async () => [],
  exists: async (p: string) => files.has(p.replace(/\\/g, "/")),
  renameFile: async () => {},
  appendFile: async () => {},
}));

beforeEach(() => {
  files.clear();
  writes.length = 0;
  deletes.length = 0;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** 造一个 service + 一份手写快照文件（跳过 create 流程，直接摆好状态） */
async function setup(filesInSnapshot: Array<{ path: string; content: string; isNew: boolean }>) {
  const { SnapshotService } = await import("../core/snapshot/snapshot");
  const cwd = "C:/ws";
  const svc = new SnapshotService(cwd);
  // 快照 id 用固定值，文件放在 service 自己的目录下
  const snapshotId = "snap-test-1";
  const snapshotPath = `${cwd}/.codem-snapshots/${snapshotId}.json`;
  files.set(snapshotPath, JSON.stringify({
    id: snapshotId,
    sessionId: "s1",
    messageIndex: 0,
    timestamp: Date.now(),
    files: filesInSnapshot,
  }));
  return { svc, snapshotId, snapshotPath };
}

describe("SNAP47：回滚的可知情与可撤销", () => {
  it("SNAP47-1: preview() 只读 —— 算清影响面且**不写任何文件**", async () => {
    const { svc, snapshotId } = await setup([
      { path: "C:/ws/a.ts", content: "旧内容", isNew: false },
      { path: "C:/ws/new.ts", content: "新建内容", isNew: true },
    ]);
    files.set("C:/ws/a.ts", "当前内容");
    files.set("C:/ws/new.ts", "当前内容");

    writes.length = 0;
    deletes.length = 0;
    const preview = await svc.preview(snapshotId);

    expect(preview.willModify, "a.ts 是快照里已有的 → 会被覆盖").toEqual(["C:/ws/a.ts"]);
    expect(preview.willDelete, "new.ts 是快照之后新建的 → 会被删除").toEqual(["C:/ws/new.ts"]);
    expect(writes.length, "preview **绝不能**写文件").toBe(0);
    expect(deletes.length, "preview **绝不能**删文件").toBe(0);
    expect(files.get("C:/ws/a.ts"), "内容也不许被改").toBe("当前内容");
  });

  it("SNAP47-2: 已经不存在的新建文件不列进'将删除'（避免虚报影响面）", async () => {
    const { svc, snapshotId } = await setup([
      { path: "C:/ws/gone.ts", content: "x", isNew: true },
    ]);
    // 用户自己已经把那个文件删了
    const preview = await svc.preview(snapshotId);
    expect(preview.willDelete, "文件本来就不在 → 不该吓唬用户说要删").toEqual([]);
    expect(preview.total).toBe(1);
  });

  it("SNAP47-3: restore() 在动手**之前**存一份'回滚前自动快照'，记录的是当前内容", async () => {
    const { svc, snapshotId } = await setup([
      { path: "C:/ws/a.ts", content: "旧内容", isNew: false },
    ]);
    files.set("C:/ws/a.ts", "用户在快照之后的修改");

    const changes = await svc.restore(snapshotId);

    // ① 文件确实被回滚了
    expect(files.get("C:/ws/a.ts")).toBe("旧内容");
    expect(changes.length).toBe(1);

    // ② 存在一份"回滚前自动快照"，且它记的是**回滚前**的内容
    const preId = (changes as unknown as { preRollbackSnapshotId?: string }).preRollbackSnapshotId;
    expect(preId, "回滚前必须留下快照 id（UI 据此提示可撤销）").toBeTruthy();
    const preContent = files.get(`C:/ws/.codem-snapshots/${preId}.json`);
    expect(preContent, "快照文件必须写出来").toBeTruthy();
    const pre = JSON.parse(preContent!);
    const entry = pre.files.find((f: { path: string }) => f.path === "C:/ws/a.ts");
    expect(
      entry?.content,
      "记录的必须是**回滚前**（= 用户修改后的）内容，否则这份快照没有撤销能力",
    ).toBe("用户在快照之后的修改");
    expect(entry?.isNew, "回滚前快照里它当然不是新建文件").toBe(false);
  });

  it("SNAP47-4: 拿'回滚前快照'再回滚一次能退回原状（回滚真的可撤销）", async () => {
    const { svc, snapshotId } = await setup([
      { path: "C:/ws/a.ts", content: "旧内容", isNew: false },
    ]);
    files.set("C:/ws/a.ts", "用户改了它");

    const changes = await svc.restore(snapshotId);
    expect(files.get("C:/ws/a.ts"), "第一次回滚：回到快照里的内容").toBe("旧内容");

    const preId = (changes as unknown as { preRollbackSnapshotId?: string }).preRollbackSnapshotId!;
    await svc.restore(preId);

    expect(
      files.get("C:/ws/a.ts"),
      "用回滚前快照再回滚 → 退回用户改过的内容（这就是'可撤销'）",
    ).toBe("用户改了它");
  });
});
