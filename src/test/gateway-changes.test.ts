/**
 * 桌面网关变更面判据（GWC-S1..GWC-S8，ADR-0005 M3）。
 *
 * 被守的对象是**桌面注入的那份数据**：`turn_file_changes` + 会话自己的工作区。
 * 服务实现与 Host 共用（`packages/host/src/changes.ts`），所以这里只钉
 * **桌面特有的差异**，不重复 Host 的 `CHG-P*`：
 *
 * | 判据 | 钉什么 | 变异（改坏哪里 ⇒ 红） |
 * |---|---|---|
 * | GWC-S1 | `workspaceFor(sessionId)` 决定 git 的 cwd；不同会话各在自己的仓库取对象 | 固定用"当前项目" ⇒ 红 |
 * | GWC-S2 | 会话没有工作目录 ⇒ `supported=false + reason`（不是空列表/不是 INTERNAL） | 编一个根 ⇒ 红 |
 * | GWC-S3 | 记录来自另一个工作区（cat-file 失败）⇒ `supported=false + 原因`，不跑 diff | 当成 INTERNAL ⇒ 红 |
 * | GWC-S4 | 敏感路径硬拒绝，且**一次 git 都不跑**（变更记录不是内容出口） | 先取 patch 再拒绝 ⇒ 红 |
 * | GWC-S5 | 列表只在"非 git 且无记录"时 supported=false；有记录照常返回 | 因非 git 藏记录 ⇒ 红 |
 * | GWC-S6 | `hasMore` 来自存储引擎；offset/limit 原样传给桌面查询 | 用 items.length 猜 ⇒ 红 |
 * | GWC-S7 | 未跟踪新文件（A）的树 diff 为空 ⇒ 实说"快照里没有内容" | 画成空 diff ⇒ 红 |
 * | GWC-S8 | 未知会话 ⇒ NOT_FOUND；记录不属于该会话 ⇒ NOT_FOUND | 返回空/空 patch ⇒ 红 |
 */
import { describe, expect, it, vi } from "vitest";

import {
  HOST_CHANGE_DIFF_MAX_CHARS,
  createChangesService,
  type ChangesServiceDeps,
} from "../../packages/host/src/changes";
import { HostError } from "../../packages/host/src/errors";
import type { TurnFileChangeRecord } from "../core/storage/file-change-storage";

function record(over: Partial<TurnFileChangeRecord> = {}): TurnFileChangeRecord {
  return {
    id: "tfc-desktop-1",
    session_id: "sess-a",
    message_id: "assistant-1",
    turn_index: 2,
    before_tree: "a".repeat(40),
    after_tree: "b".repeat(40),
    changed_files: JSON.stringify([
      { path: "src/a.ts", status: "M", additions: 4, deletions: 1 },
      { path: "assets/logo.bin", status: "A" },
    ]),
    patch_sha256: "hash",
    current_brief: "Turn 2: 2 file(s) changed",
    status: "completed",
    created_at: 1_700_000_000_000,
    ...over,
  };
}

interface Harness {
  deps: ChangesServiceDeps;
  calls: Array<{ workspace: string; args: string[] }>;
  workspaces: string[];
}

function harness(
  over: Partial<ChangesServiceDeps> = {},
  rows: TurnFileChangeRecord[] = [record()],
): Harness {
  const calls: Array<{ workspace: string; args: string[] }> = [];
  const workspaces: string[] = [];
  const deps: ChangesServiceDeps = {
    sessionExists: async () => true,
    queryPage: async () => ({ items: rows, hasMore: false }),
    getById: async (id) => rows.find((r) => r.id === id) ?? null,
    workspaceFor: async (sessionId) => {
      workspaces.push(sessionId);
      return sessionId === "sess-a" ? "C:\\repo-a" : "C:\\repo-b";
    },
    isGitWorkspace: async () => true,
    runGit: async (workspace, args) => {
      calls.push({ workspace, args });
      return { stdout: "", stderr: "", exitCode: 0 };
    },
    ...over,
  };
  return { deps, calls, workspaces };
}

async function expectHostError(p: Promise<unknown>, kind: string): Promise<HostError> {
  try {
    await p;
    throw new Error(`应当抛 ${kind}`);
  } catch (e) {
    expect(e).toBeInstanceOf(HostError);
    expect((e as HostError).kind).toBe(kind);
    return e as HostError;
  }
}

describe("GWC-S1 按会话取工作区（不是桌面当前项目）", () => {
  it("list/diff 都用该会话的 workspace，而不是一个固定根", async () => {
    const h = harness();
    const svc = createChangesService(h.deps);

    await svc.list("sess-a");
    expect(h.workspaces).toEqual(["sess-a"]);

    // diff 的记录属于 sess-a ⇒ NOT_FOUND（连 git 都不该跑）
    await expectHostError(svc.diff("sess-b", "tfc-desktop-1", "src/a.ts"), "NOT_FOUND");
    expect(h.calls).toEqual([]);
  });

  it("diff 在记录所属会话的工作区里查对象/取 patch", async () => {
    const rows = [record({ id: "tfc-b", session_id: "sess-b" })];
    const h = harness({}, rows);
    const svc = createChangesService(h.deps);

    const got = await svc.diff("sess-b", "tfc-b", "src/a.ts");
    expect(got.supported).toBe(true);
    expect(h.workspaces).toContain("sess-b");
    expect(h.calls.every((c) => c.workspace === "C:\\repo-b"), JSON.stringify(h.calls)).toBe(true);
    expect(h.calls.find((c) => c.args[0] === "cat-file")?.args).toEqual([
      "cat-file",
      "-e",
      "a".repeat(40),
    ]);
    const diffArgs = h.calls.find((c) => c.args[0] === "diff")?.args ?? [];
    expect(diffArgs.slice(0, 5)).toEqual([
      "diff",
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      "-M",
    ]);
    expect(diffArgs.slice(5, 8)).toEqual(["a".repeat(40), "b".repeat(40), "--"]);
    expect(diffArgs.at(-1), "路径按字面匹配（不是 git 通配符）").toBe(":(literal)src/a.ts");
  });
});

describe("GWC-S2 没有工作目录", () => {
  it("空列表 ⇒ supported=false + 明说会话没有工作目录", async () => {
    const h = harness({ workspaceFor: async () => null }, []);
    const got = await createChangesService(h.deps).list("sess-a");
    expect(got.items).toEqual([]);
    expect(got.supported).toBe(false);
    expect(got.reason).toContain("没有可用的工作目录");
    expect(h.calls).toEqual([]);
  });

  it("diff ⇒ supported=false + 原因，不是 INTERNAL", async () => {
    const h = harness({ workspaceFor: async () => null });
    const got = await createChangesService(h.deps).diff("sess-a", "tfc-desktop-1", "src/a.ts");
    expect(got.supported).toBe(false);
    expect(got.patch).toBe("");
    expect(got.reason).toContain("没有可用的工作目录");
    expect(h.calls).toEqual([]);
  });
});

describe("GWC-S3 跨工作区 / 对象缺失", () => {
  it("cat-file 失败 ⇒ supported=false + 跨工作区原因，且不跑 diff", async () => {
    const h = harness({
      runGit: async (workspace, args) => {
        h.calls.push({ workspace, args });
        return args[0] === "cat-file"
          ? { stdout: "", stderr: "missing", exitCode: 1 }
          : { stdout: "should-not-run", stderr: "", exitCode: 0 };
      },
    });
    const got = await createChangesService(h.deps).diff("sess-a", "tfc-desktop-1", "src/a.ts");
    expect(got.supported).toBe(false);
    expect(got.patch).toBe("");
    expect(got.reason).toContain("另一个工作区");
    expect(h.calls.filter((c) => c.args[0] === "diff")).toEqual([]);
  });

  it("cat-file 超时 ⇒ CONFLICT（不是「另一个工作区」这种假事实）", async () => {
    const h = harness({
      runGit: async (workspace, args) => {
        h.calls.push({ workspace, args });
        return { stdout: "", stderr: "git 超时", exitCode: 124 };
      },
    });
    await expectHostError(
      createChangesService(h.deps).diff("sess-a", "tfc-desktop-1", "src/a.ts"),
      "CONFLICT",
    );
    expect(h.calls.filter((c) => c.args[0] === "diff")).toEqual([]);
  });
});

describe("GWC-S4 敏感文件是内容出口的硬边界", () => {
  it("敏感路径 ⇒ supported=false、无 patch、且不跑 git", async () => {
    const h = harness(
      { isSensitivePath: (p) => p === ".env" },
      [record({ changed_files: JSON.stringify([{ path: ".env", status: "M" }]) })],
    );
    const got = await createChangesService(h.deps).diff("sess-a", "tfc-desktop-1", ".env");
    expect(got.supported).toBe(false);
    expect(got.patch).toBe("");
    expect(got.reason).toContain("敏感");
    expect(h.calls).toEqual([]);
  });

  it("非敏感路径照常返回（对照）", async () => {
    const h = harness({ isSensitivePath: (p) => p === ".env" });
    const got = await createChangesService(h.deps).diff("sess-a", "tfc-desktop-1", "src/a.ts");
    expect(got.supported).toBe(true);
  });
});

describe("GWC-S5 非 git 但有历史记录", () => {
  it("记录是真的就照常返回；空列表才报非 git", async () => {
    const withRows = harness({ isGitWorkspace: async () => false });
    const got = await createChangesService(withRows.deps).list("sess-a");
    expect(got.supported).toBe(true);
    expect(got.items).toHaveLength(1);

    const empty = harness({ isGitWorkspace: async () => false }, []);
    const none = await createChangesService(empty.deps).list("sess-a");
    expect(none.supported).toBe(false);
    expect(none.reason).toContain("不是 git 仓库");
  });
});

describe("GWC-S6 分页来自桌面查询", () => {
  it("offset/limit 原样传入；hasMore 用引擎结果", async () => {
    const seen: Array<{ offset: number; limit: number }> = [];
    const h = harness({
      queryPage: async (_sid, offset, limit) => {
        seen.push({ offset, limit });
        return { items: [record()], hasMore: true };
      },
    });
    const got = await createChangesService(h.deps).list("sess-a", 40, 20);
    expect(seen).toEqual([{ offset: 40, limit: 20 }]);
    expect(got.hasMore, "不许用 items.length === limit 猜").toBe(true);
  });
});

describe("GWC-S7 未跟踪新文件", () => {
  it("A 状态但 tree diff 为空 ⇒ 实说快照里没有内容", async () => {
    const h = harness({}, [
      record({ changed_files: JSON.stringify([{ path: "new.ts", status: "A" }]) }),
    ]);
    const got = await createChangesService(h.deps).diff("sess-a", "tfc-desktop-1", "new.ts");
    expect(got.supported).toBe(false);
    expect(got.patch).toBe("");
    expect(got.reason).toContain("未跟踪");
  });
});

describe("GWC-S8 身份与截断", () => {
  it("未知会话 / 记录属于别的会话 ⇒ NOT_FOUND", async () => {
    const h = harness({ sessionExists: async (id) => id === "sess-a" });
    const svc = createChangesService(h.deps);
    await expectHostError(svc.list("ghost"), "NOT_FOUND");
    await expectHostError(svc.diff("sess-b", "tfc-desktop-1", "src/a.ts"), "NOT_FOUND");
  });

  it("超过 200KB 截断并标 truncated", async () => {
    const h = harness({
      runGit: async () => ({
        stdout: "+".repeat(HOST_CHANGE_DIFF_MAX_CHARS + 50),
        stderr: "",
        exitCode: 0,
      }),
    });
    const got = await createChangesService(h.deps).diff("sess-a", "tfc-desktop-1", "src/a.ts");
    expect(got.supported).toBe(true);
    expect(got.truncated).toBe(true);
    expect(got.patch.length).toBe(HOST_CHANGE_DIFF_MAX_CHARS);
  });
});
