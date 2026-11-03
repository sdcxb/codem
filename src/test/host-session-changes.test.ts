/**
 * `session.changes` / `session.change.diff` 判据（CHG-P1..8，第 270 波）。
 *
 * 服务层（`packages/host/src/changes.ts`）与 HTTP 面解耦，所以这里直接喂依赖：
 * 存储用假 `queryPage`/`getById`，git 用假 `runGit`。断言的是**下发的形状**与
 * **空态语义**，不是"函数被调用过"。
 *
 * | 判据 | 钉什么 | 变异（改坏哪里 ⇒ 红） |
 * |---|---|---|
 * | CHG-P1 | 响应里没有 patch / before_tree / after_tree | 把整行 spread 进视图 ⇒ 红 |
 * | CHG-P2 | `hasMore` 来自引擎，不靠 items.length 猜 | 改成 `items.length === limit` ⇒ 红 |
 * | CHG-P3 | 未知会话 ⇒ NOT_FOUND（不是空列表） | 返回空 ⇒ 红 |
 * | CHG-P4 | numstat 缺失 ⇒ 字段缺席、totals 缺席（不是 0） | `?? 0` ⇒ 红 |
 * | CHG-P5 | 非 git 且无记录 ⇒ supported=false + reason | 返回 supported=true ⇒ 红 |
 * | CHG-P6 | 分页参数（offset/limit）与 50 上限 | 忽略 offset / 无上限 ⇒ 红 |
 * | CHG-P7 | 单文件 diff：路径必须属于该记录；缺 tree / 非 git ⇒ supported=false；200KB 截断 | 不校验路径 / 不截断 ⇒ 红 |
 * | CHG-P8 | `changed_files` 坏了 ⇒ `filesParseError`（不是空文件列表） | 吞成 [] ⇒ 红 |
 */
import { describe, expect, it } from "vitest";

import {
  HOST_CHANGE_DIFF_MAX_CHARS,
  HOST_CHANGES_PAGE_MAX,
  createChangesService,
  type ChangesServiceDeps,
} from "../../packages/host/src/changes";
import { HostError } from "../../packages/host/src/errors";
import type { TurnFileChangeRecord } from "../core/storage/file-change-storage";

function record(over: Partial<TurnFileChangeRecord> = {}): TurnFileChangeRecord {
  return {
    id: "tfc-1",
    session_id: "s1",
    message_id: "host-assistant-1",
    turn_index: 3,
    before_tree: "a".repeat(40),
    after_tree: "b".repeat(40),
    changed_files: JSON.stringify([
      { path: "src/a.ts", status: "M", additions: 12, deletions: 3 },
      { path: "assets/logo.bin", status: "A" },
    ]),
    patch_sha256: "hash",
    current_brief: "Turn 3: 2 file(s) changed",
    status: "completed",
    created_at: 1_700_000_000_000,
    ...over,
  };
}

function service(over: Partial<ChangesServiceDeps> = {}, rows: TurnFileChangeRecord[] = [record()]) {
  const calls: Array<{ sessionId: string; offset: number; limit: number }> = [];
  const deps: ChangesServiceDeps = {
    sessionExists: async () => true,
    queryPage: async (sessionId, offset, limit) => {
      calls.push({ sessionId, offset, limit });
      return { items: rows, hasMore: false };
    },
    getById: async (id) => rows.find((r) => r.id === id) ?? null,
    workspaceFor: async () => "/ws",
    isGitWorkspace: async () => true,
    runGit: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    ...over,
  };
  return { svc: createChangesService(deps), calls };
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

describe("CHG-P1 列表不携带 PC 侧坐标与大字段", () => {
  it("响应里没有 patch / before_tree / after_tree", async () => {
    const { svc } = service();
    const got = await svc.list("s1");
    const json = JSON.stringify(got);
    expect(json).not.toContain("before_tree");
    expect(json).not.toContain("after_tree");
    expect(json).not.toContain('"patch"');
    expect(got.items[0].changeId).toBe("tfc-1");
    expect(got.items[0].treesAvailable).toBe(true);
  });
});

describe("CHG-P2 hasMore 来自引擎", () => {
  it("只有 1 条但引擎说还有 ⇒ hasMore=true", async () => {
    const { svc } = service({ queryPage: async () => ({ items: [record()], hasMore: true }) });
    const got = await svc.list("s1", 0, 20);
    expect(got.items).toHaveLength(1);
    expect(got.hasMore, "不许用 items.length === limit 猜").toBe(true);
  });
});

describe("CHG-P3 未知会话", () => {
  it("抛 NOT_FOUND，不返回空列表", async () => {
    const { svc } = service({ sessionExists: async () => false });
    await expectHostError(svc.list("ghost"), "NOT_FOUND");
  });
});

describe("CHG-P4 numstat 缺失", () => {
  it("additions/deletions 键缺席；totals 只对有的文件求和", async () => {
    const { svc } = service();
    const got = await svc.list("s1");
    const [modified, added] = got.items[0].files;
    expect(modified.additions).toBe(12);
    expect(modified.deletions).toBe(3);
    expect("additions" in added, "缺 numstat 时不许下发 0").toBe(false);
    expect("deletions" in added).toBe(false);
    expect(got.items[0].totals).toEqual({ additions: 12, deletions: 3 });
  });

  it("所有文件都缺统计 ⇒ totals 整个缺席", async () => {
    const { svc } = service({}, [
      record({ changed_files: JSON.stringify([{ path: "a.bin", status: "A" }]) }),
    ]);
    const got = await svc.list("s1");
    expect(got.items[0].totals).toBeUndefined();
  });
});

describe("CHG-P5 非 git 工作区", () => {
  it("没有记录 ⇒ supported=false + reason（不是「没有改动」）", async () => {
    const { svc } = service({ isGitWorkspace: async () => false }, []);
    const got = await svc.list("s1");
    expect(got.items).toEqual([]);
    expect(got.supported).toBe(false);
    expect(got.reason).toContain("不是 git 仓库");
  });

  it("已经有历史记录 ⇒ 仍然返回（记录是真的，不能因为现在不是仓库就藏起来）", async () => {
    const { svc } = service({ isGitWorkspace: async () => false });
    const got = await svc.list("s1");
    expect(got.supported).toBe(true);
    expect(got.items).toHaveLength(1);
  });
});

describe("CHG-P6 分页参数", () => {
  it("offset/limit 原样传给存储；limit 上限 50", async () => {
    const { svc, calls } = service();
    await svc.list("s1", 40, 20);
    expect(calls.at(-1)).toEqual({ sessionId: "s1", offset: 40, limit: 20 });

    await svc.list("s1", -5, 500);
    expect(calls.at(-1)).toEqual({ sessionId: "s1", offset: 0, limit: HOST_CHANGES_PAGE_MAX });
  });
});

describe("CHG-P7 单文件 diff", () => {
  it("路径不在该记录清单里 ⇒ INVALID_PARAMS（不接受任意路径）", async () => {
    const { svc } = service();
    await expectHostError(svc.diff("s1", "tfc-1", "../secret.txt"), "INVALID_PARAMS");
    await expectHostError(svc.diff("s1", "tfc-1", "src/other.ts"), "INVALID_PARAMS");
  });

  it("记录/会话对不上 ⇒ NOT_FOUND", async () => {
    const { svc } = service();
    await expectHostError(svc.diff("s2", "tfc-1", "src/a.ts"), "NOT_FOUND");
    await expectHostError(svc.diff("s1", "ghost", "src/a.ts"), "NOT_FOUND");
  });

  it("缺 tree ⇒ supported=false + reason（不是「没有改动」）", async () => {
    const { svc } = service({}, [record({ before_tree: null })]);
    const got = await svc.diff("s1", "tfc-1", "src/a.ts");
    expect(got.supported).toBe(false);
    expect(got.patch).toBe("");
    expect(got.reason).toContain("快照");
  });

  it("非 git 工作区 ⇒ supported=false + reason", async () => {
    const { svc } = service({ isGitWorkspace: async () => false });
    const got = await svc.diff("s1", "tfc-1", "src/a.ts");
    expect(got.supported).toBe(false);
    expect(got.reason).toContain("不是 git 仓库");
  });

  it("成功：传 before/after + -- path，200KB 截断", async () => {
    const calls: string[][] = [];
    const big = "+".repeat(HOST_CHANGE_DIFF_MAX_CHARS + 100);
    const { svc } = service({
      runGit: async (_workspace, args) => {
        calls.push(args);
        return { stdout: big, stderr: "", exitCode: 0 };
      },
    });
    const got = await svc.diff("s1", "tfc-1", "src\\a.ts");
    const diffCall = calls.find((c) => c[0] === "diff");
    expect(diffCall?.slice(0, 5)).toEqual(["diff", "--no-color", "--no-ext-diff", "--no-textconv", "-M"]);
    expect(diffCall?.slice(5, 8)).toEqual(["a".repeat(40), "b".repeat(40), "--"]);
    expect(diffCall?.at(-1), "路径归一成 posix 且按字面匹配").toBe(":(literal)src/a.ts");
    expect(got.supported).toBe(true);
    expect(got.truncated).toBe(true);
    expect(got.patch.length).toBe(HOST_CHANGE_DIFF_MAX_CHARS);
  });

  it("A 状态但 tree diff 为空 ⇒ 明说未跟踪快照缺内容，不画成空 diff", async () => {
    const { svc } = service({}, [
      record({ changed_files: JSON.stringify([{ path: "new.ts", status: "A" }]) }),
    ]);
    const got = await svc.diff("s1", "tfc-1", "new.ts");
    expect(got.supported).toBe(false);
    expect(got.reason).toContain("未跟踪");
  });

  it("当前工作区没有该 tree ⇒ supported=false + 工作区原因（不是 INTERNAL）", async () => {
    const { svc } = service({
      runGit: async (_workspace, args) =>
        args[0] === "cat-file"
          ? { stdout: "", stderr: "missing", exitCode: 1 }
          : { stdout: "", stderr: "", exitCode: 0 },
    });
    const got = await svc.diff("s1", "tfc-1", "src/a.ts");
    expect(got.supported).toBe(false);
    expect(got.reason).toContain("工作区");
  });

  it("对象存在但 git diff 非 0 ⇒ INTERNAL（可定位的失败，不是空 diff）", async () => {
    const { svc } = service({
      runGit: async (_workspace, args) =>
        args[0] === "cat-file"
          ? { stdout: "", stderr: "", exitCode: 0 }
          : { stdout: "", stderr: "fatal: bad object", exitCode: 128 },
    });
    await expectHostError(svc.diff("s1", "tfc-1", "src/a.ts"), "INTERNAL");
  });
});

describe("CHG-P9 共享工作区：敏感文件不通过变更记录下发 patch", () => {
  it("敏感路径 ⇒ supported=false + 原因；且一次 git 都不跑（不先读内容再拒绝）", async () => {
    const calls: string[][] = [];
    const { svc } = service(
      {
        isSensitivePath: (p) => p === ".env",
        runGit: async (_workspace, args) => {
          calls.push(args);
          return { stdout: "SECRET=1", stderr: "", exitCode: 0 };
        },
      },
      [record({ changed_files: JSON.stringify([{ path: ".env", status: "M" }]) })],
    );
    const got = await svc.diff("s1", "tfc-1", ".env");
    expect(got.supported).toBe(false);
    expect(got.patch).toBe("");
    expect(got.reason).toContain("敏感");
    expect(calls, "拒绝必须发生在跑 git 之前").toEqual([]);
  });

  it("反向对照：非敏感路径照常返回 patch", async () => {
    const { svc } = service({ isSensitivePath: (p) => p === ".env" });
    const got = await svc.diff("s1", "tfc-1", "src/a.ts");
    expect(got.supported).toBe(true);
  });
});

describe("CHG-P8 changed_files 损坏", () => {
  it("坏 JSON ⇒ filesParseError=true（不是空列表）", async () => {
    const { svc } = service({}, [record({ changed_files: "{not json" })]);
    const got = await svc.list("s1");
    expect(got.items[0].files).toEqual([]);
    expect(got.items[0].filesParseError).toBe(true);
  });

  it("数组里混入无 path 的项 ⇒ filesParseError=true，合法项仍保留", async () => {
    const { svc } = service({}, [
      record({ changed_files: JSON.stringify([{ status: "M" }, { path: "ok.ts", status: "M" }]) }),
    ]);
    const got = await svc.list("s1");
    expect(got.items[0].files.map((f) => f.path)).toEqual(["ok.ts"]);
    expect(got.items[0].filesParseError).toBe(true);
  });
});
