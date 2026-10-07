/**
 * 第 46 波：**git 命令批量化协议** ✓（目标② 的实测着力点 ✓）。
 *
 * ## 为什么（真机实测 ✓，同一工作区同一台机器）
 *
 * ```
 *   git rev-parse 'HEAD^{tree}'（直接 ✓）                          52 ms
 *   powershell -NoProfile -Command "git rev-parse 'HEAD^{tree}'"  289 ms  ← ★ 每次多付 ~240 ms ✗
 *   6 × 独立 powershell -Command                                  1 648 ms
 *   1 × powershell 里跑 6 条 git（批量化 ✓）                        638 ms  ← ★ 省 ~1 s ✓
 * ```
 * 应用里每条 git 都经 `execute_command` ⇒ **一个 PowerShell 进程** ✓；而
 * `snapshotWorkingTree` 一轮 3 条 ✓ + `finalize()`（**每轮都调** ✓）的 diff 若干条 ✓
 * ⇒ 真机侧车里"工具结果回来 → `Iteration N completed`"之间稳定 **~2 s 且零日志** ✗ 就是这里 ✓。
 *
 * ## 判据（钉**协议**，不钉"我的代码还在" ✓）
 *
 * | id | 钉什么 | 变异（应当红 ✗） |
 * |---|---|---|
 * | `GB-1` | 3 条命令的正常输出 ⇒ 逐条拆对（含各自退出码 ✓）| 把哨兵行算进 stdout ⇒ 红 |
 * | `GB-2` | ★ **"空输出 + 退出码 0"与"命令失败"必须分得开** ✓（`stash create` 干净工作区就是前者 ✓）| 丢掉退出码 ⇒ 红 |
 * | `GB-3` | 多行输出（未跟踪文件清单 ✓）逐条不串 ✓ | 用 `parts[i]` 直接当 stdout ⇒ 红 |
 * | `GB-4`（反向对照）| 命令条数与段数不匹配（解析不了 ✓）⇒ 不许抛异常、也不许把上一段的码算到别人头上 ✓ | 越界读 ⇒ 红 |
 */
import { describe, expect, it, vi } from "vitest";
import { GIT_BATCH_SENTINEL, parseGitBatchOutput } from "../core/environment/file-change-tracker";
import { setStoragePort } from "../core/storage/port";
import { createFakeStoragePort } from "./fake-storage-port";

/** 按真机协议拼一段输出 ✓：`out0 SENT c0\n out1 SENT c1\n …` */
function wire(outputs: Array<{ stdout: string; exitCode: number }>): string {
  return outputs.map((o) => `${o.stdout}${GIT_BATCH_SENTINEL}${o.exitCode}\n`).join("");
}

describe("第 46 波：git 批量化协议", () => {
  it("GB-1: 三条命令的正常输出逐条拆对（退出码各自归位 ✓）", () => {
    const out = wire([
      { stdout: "stash-abc", exitCode: 0 },
      { stdout: "tree-abc", exitCode: 0 },
      { stdout: "new-file.ts\nother.ts", exitCode: 0 },
    ]);
    const r = parseGitBatchOutput(out, 3);
    expect(r.length).toBe(3);
    expect(r[0].stdout).toBe("stash-abc");
    expect(r[1].stdout).toBe("tree-abc");
    expect(r[2].stdout).toBe("new-file.ts\nother.ts");
    expect(r.map((x) => x.exitCode)).toEqual([0, 0, 0]);
  });

  it("GB-2: ★ 空输出+退出码 0（干净工作区的 stash create ✓）与命令失败必须分得开", () => {
    const clean = parseGitBatchOutput(
      wire([
        { stdout: "", exitCode: 0 },
        { stdout: "tree-abc", exitCode: 0 },
      ]),
      2,
    );
    expect(clean[0].stdout, "干净工作区：空").toBe("");
    expect(clean[0].exitCode, "★ 空输出但成功 ⇒ 不能当成失败").toBe(0);

    const failed = parseGitBatchOutput(
      wire([
        { stdout: "", exitCode: 128 },
        { stdout: "tree-abc", exitCode: 0 },
      ]),
      2,
    );
    expect(failed[0].stdout).toBe("");
    expect(failed[0].exitCode, "★ 失败必须如实带出来").toBe(128);
  });

  it("GB-3: 多行输出不许串到别条头上（含最后一条的多行 ✓）", () => {
    const r = parseGitBatchOutput(
      wire([
        { stdout: "a1\na2", exitCode: 0 },
        { stdout: "b1", exitCode: 1 },
        { stdout: "c1\nc2\nc3", exitCode: 0 },
      ]),
      3,
    );
    expect(r[0].stdout).toBe("a1\na2");
    expect(r[1].stdout, "中间那条的前一行是上一条的退出码 ⇒ 不许混进 stdout").toBe("b1");
    expect(r[1].exitCode).toBe(1);
    expect(r[2].stdout).toBe("c1\nc2\nc3");
    expect(r[2].exitCode).toBe(0);
  });

  it("GB-4 反向对照: 段数不足/输出里没有哨兵 ⇒ 不抛异常、也不许张冠李戴", () => {
    /** 没有哨兵（例如某个夹具只回一个裸字符串 ✓）：第 0 条拿到全部，其余**空**且**不算成功** ✗ */
    const noSentinel = parseGitBatchOutput("tree-abc", 3);
    expect(noSentinel.length, "条数必须仍然等于命令数（调用方按位置解构 ✓）").toBe(3);
    expect(noSentinel[0].stdout).toBe("tree-abc");
    expect(noSentinel[1].stdout).toBe("");
    expect(noSentinel[2].stdout).toBe("");

    const tooFew = parseGitBatchOutput(wire([{ stdout: "only", exitCode: 0 }]), 3);
    expect(tooFew.length).toBe(3);
    expect(tooFew[0].stdout).toBe("only");
    expect(() => parseGitBatchOutput("", 3)).not.toThrow();
  });

  /**
   * ★ `GB-5`：**行为级** —— 数 Tauri 调用次数 ✓。
   *
   * 这一条钉的是"**省了几条 git 进程**"这个收益本身 ✓（而不是"我调了批量化函数" ✗）：
   * `--name-status` 与 `--stat` 必须出现在**同一次** `execute_command` 里 ✓；
   * 而 `snapshotWorkingTree` 的三条也必须只占**一次** ✓。
   */
  it("GB-5: name-status 与 stat 必须来自同一次调用（省的是 PowerShell 进程 ✓）", async () => {
    const calls: string[] = [];
    (window as any).__TAURI__ = {
      core: {
        invoke: vi.fn(async (cmd: string, args: any) => {
          if (cmd !== "execute_command") return null;
          const c = String(args.command);
          calls.push(c);
          const S = GIT_BATCH_SENTINEL;
          if (c.includes("rev-parse --is-inside-work-tree")) {
            /** ⚠️ 这一条走的是**单命令** `runGit` 路径 ✓（不带哨兵 ✗）—— 加哨兵会让 start() 判成"不是 git 仓库" ✗ */
            return { stdout: "true", stderr: "", exitCode: 0 };
          }
          if (c.includes("stash create")) {
            /** 快照那一次：三条命令 ✓。★ 第二次快照要给出**不同**的树 ✓，否则走"无变更 ⇒ null"分支 ✗ */
            const nth = calls.filter((x) => x.includes("stash create")).length;
            const tree = nth === 1 ? "tree-abc" : "tree-def";
            const stash = nth === 1 ? "stash-abc" : "stash-def";
            return { stdout: `${stash}${S}0\n` + `${tree}${S}0\n` + `new-file.ts${S}0\n`, stderr: "", exitCode: 0 };
          }
          if (c.includes("HEAD^{tree}")) {
            /** `start()` 里取 beforeTree 也是**单命令**路径 ✓（不带哨兵 ✗） */
            return { stdout: "tree-abc", stderr: "", exitCode: 0 };
          }
          if (c.includes("--name-status")) {
            /** 两条 diff 那一次 ✓ */
            return { stdout: `M\tsrc/a.ts${S}0\n` + ` 1 file changed, 3 insertions(+)${S}0\n`, stderr: "", exitCode: 0 };
          }
          return { stdout: "", stderr: "", exitCode: 0 };
        }),
      },
    };
    setStoragePort(
      createFakeStoragePort({
        seed: { sessions: [{ id: "s1", project_id: "p1", title: "t", created_at: 1, last_message_at: 1, message_count: 0 }] },
      }) as never,
    );
    const { FileChangeTracker } = await import("../core/environment/file-change-tracker");
    const tracker = new FileChangeTracker("/fake/repo", "s1", "m1", 1);
    expect(await tracker.start()).toBe(true);
    /**
     * ★ 第 46 波：**新契约** —— `finalize()` 只在"自上次以来有**会改工作区**的工具跑过"时才进 git ✓
     * （见 `file-change-tracker.ts` 里 `finalize()` 顶部的长说明 ✓）。
     * ⇒ 本判据的意图是"**批量化有没有省进程**" ✓ ⇒ 必须先声明一次"可能有改动" ✓，
     *   否则走的是另一条更省的分支 ✓（那条由 `GB-7` 单独钉 ✓）。
     */
    tracker.noteMutation();
    const result = await tracker.finalize();
    console.log("[GB-5] 调用次数：", calls.length, "；含 --name-status 的：", calls.filter((c) => c.includes("--name-status")).length);
    const diffCalls = calls.filter((c) => c.includes("--name-status"));
    expect(diffCalls.length, "★ 两条 diff 只能占一次调用").toBe(1);
    expect(diffCalls[0], "★ 同一次调用里必须同时有 --stat").toContain("--stat");
    /**
     * ★ **进程数**这条才是最直接的收益口径 ✓（每多一次 `execute_command` 就多一个 PowerShell 进程 ✗，
     * 实测 ~240ms/次 ✗）。改动前的口径：
     * ```
     * start()    ：is-inside-work-tree(1) + 快照(3) + rev-parse HEAD^{tree}(1) = 5
     * finalize() ：快照(3) + name-status(1) + stat(1) + binary(1)             = 6
     *                                                              合计 11 ✗
     * 现在        ：3 + 3 = 6 ✓（少 5 个进程 ⇒ ~1.2s/轮 ✓）
     * ```
     */
    expect(calls.length, "★ 一次 start+finalize 的进程数不许超过 6（改动前是 11 ✗）").toBeLessThanOrEqual(6);
    expect(result, "夹具前提：这一轮要有变更 ✓").not.toBeNull();
    expect(result!.changedFiles.map((f) => f.path)).toContain("src/a.ts");
  });

  /**
   * ★ `GB-7`（第 46 波 ✓）：**没声明改动 ⇒ 一次 git 都不发** ✓。
   *
   * 这是本轮 B 切片的核心判据 ✓：纯读的迭代（读文件/搜索/看计划 ✓）**不该付 git 的钱** ✗。
   * 用**调用计数**钉 ✓（不靠计时 ✗ —— CI 会抖 ✓）：
   *   · `finalize()` 必须返回 `null` ✓
   *   · 且 `execute_command` 的**新增次数 = 0** ✓（= 一个 PowerShell 进程都没起 ✓）
   * 变异 ✓：把 `finalize()` 顶部那段"无声明就返回 null"去掉 ⇒ 本判据立刻变红 ✗。
   */
  it("GB-7: 没有 noteMutation() ⇒ finalize 返回 null 且**不发任何 git** ✓", async () => {
    const calls: string[] = [];
    (window as any).__TAURI__ = {
      core: {
        invoke: vi.fn(async (cmd: string, args: any) => {
          if (cmd !== "execute_command") return null;
          const c = String(args.command);
          calls.push(c);
          if (c.includes("rev-parse --is-inside-work-tree")) return { stdout: "true", stderr: "", exitCode: 0 };
          if (c.includes("HEAD^{tree}")) return { stdout: "tree-abc", stderr: "", exitCode: 0 };
          if (c.includes("stash create")) return { stdout: `stash${GIT_BATCH_SENTINEL}0\ntree-abc${GIT_BATCH_SENTINEL}0\n`, stderr: "", exitCode: 0 };
          return { stdout: "", stderr: "", exitCode: 0 };
        }),
      },
    };
    setStoragePort(
      createFakeStoragePort({
        seed: { sessions: [{ id: "s1", project_id: "p1", title: "t", created_at: 1, last_message_at: 1, message_count: 0 }] },
      }) as never,
    );
    const { FileChangeTracker, __resetFileChangeSnapshotCache, __fileChangeSnapshotStats } = await import(
      "../core/environment/file-change-tracker"
    );
    __resetFileChangeSnapshotCache();
    const tracker = new FileChangeTracker("/fake/repo-7", "s1", "m1", 1);
    expect(await tracker.start()).toBe(true);
    const before = calls.length;
    const result = await tracker.finalize(); // ← 刻意**不**调 noteMutation()
    const after = calls.length;
    expect(result, "没声明改动 ⇒ 不许产出记录").toBeNull();
    expect(after - before, "★ 一次 git 都不许发（= 一个 PowerShell 进程都不起）").toBe(0);
    expect(__fileChangeSnapshotStats().skippedNoMutation, "跳过次数必须可机检").toBeGreaterThanOrEqual(1);
  });

  /**
   * ★ `GB-6`：**哨兵必须含 Windows 文件名非法字符** ✓（防"仓库里有个同名文件"把解析撞错位 ✗）。
   *
   * 这条是"先怀疑自己的改动"那一步 ✓：`ls-files --others` 的输出就是**文件名清单** ✓，
   * 哨兵若是合法文件名 ✗ ⇒ 撞名时 `split` 错位 ⇒ **静默读错别人的内容** ✗（不报错的那种 ✗）。
   */
  it("GB-6: 哨兵必须含 Windows 文件名非法字符（< > | ? * ✓）", () => {
    console.log("[GB-6] 哨兵：", GIT_BATCH_SENTINEL);
    const illegal = ["<", ">", "|", "?", "*"];
    expect(
      illegal.some((c) => GIT_BATCH_SENTINEL.includes(c)),
      "★ 哨兵里至少要有一个 Windows 路径非法字符 —— 否则一个同名文件就能让解析错位 ✗",
    ).toBe(true);
    /** 反向对照：哨兵仍必须可用于 split（非空、无换行 ✓） */
    expect(GIT_BATCH_SENTINEL.length).toBeGreaterThan(8);
    expect(GIT_BATCH_SENTINEL).not.toMatch(/[\r\n]/);
  });
});
