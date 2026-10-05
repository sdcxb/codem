/**
 * 第 186 波：**目标②的修复判据** —— "改动前快照"每回合只取一次 ✓。
 *
 * ## 真机依据（打点，不是猜 ✓）
 *
 * ```
 * prep打点 compactionOut t=…058   ⇒ 压缩块 0ms ✓
 * prep打点 iterT0        t=…915   ⇒ **1857ms** ✗✗
 * ```
 * 那 124 行里唯一的重量级 `await` 是每轮的 `new FileChangeTracker(...)` + `await start()` ✗，
 * 而 `start()` 会跑 `rev-parse` 与 **`git stash create`**（每轮各起 git 进程 ✗）
 * ⇒ 30–49 轮 ≈ 60–90s ✓，与总账对上 ✓。
 *
 * ## 判据（**不靠计时** ✗、也**不依赖 git** ✗）
 *
 * `isGitRepo()` 走宿主 IPC ✓、在 vitest 里恒 false ✗ ⇒ 用**播种**方式测缓存行为 ✓
 * （与 `MTC-*` 同一思路：测行为，不测计时 ✓）。
 *
 * - **FCS-1**：已播种 ⇒ `start()` ×3 **全部复用、不再取快照** ✓（`taken=0 reused=3` ✓）；
 * - **FCS-2 反向对照**：`finalize()` 之后缓存必须**被清掉** ✓（下一回合重新拍 ✓）；
 * - **FCS-3**：复用进来的实例必须带上 `beforeSnapshot`/`beforeTree` 且 `active` ✓
 *   （否则 `finalize()` 走 `return null` ✗ —— 那是"文件变更面板恒空"的老缺陷 ✓）。
 *
 * 变异：去掉 `start()` 顶部的缓存读取 ⇒ **FCS-1 红** ✓。
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  FileChangeTracker,
  __fileChangeSnapshotStats,
  __hasFileChangeSnapshot,
  __resetFileChangeSnapshotCache,
  __seedFileChangeSnapshot,
} from "../core/environment/file-change-tracker";

const WS = process.cwd();

/** 播种一条"改动前快照"✓ —— 绕开 `isGitRepo`（宿主 IPC，vitest 里恒 false ✗）✓。 */
const seed = () => __seedFileChangeSnapshot(WS, "tree-1", { ref: "tree-1", untracked: [] } as unknown as never);

describe("第 186 波：改动前快照每回合只取一次", () => {
  beforeEach(() => __resetFileChangeSnapshotCache());

  it("FCS-1: 已有可复用快照 ⇒ start() ×3 全部复用、一次都不再取", async () => {
    __resetFileChangeSnapshotCache();
    seed();
    await new FileChangeTracker(WS, "s1", "m1", 1).start();
    await new FileChangeTracker(WS, "s1", "m2", 2).start();
    await new FileChangeTracker(WS, "s1", "m3", 3).start();
    const st = __fileChangeSnapshotStats();
    expect(st.taken, "已播种就不该再取快照 ✓（原来每轮都跑 git stash create ✗）").toBe(0);
    expect(st.reused, "三次 start 全部复用 ✓").toBe(3);
  });

  it("FCS-2 反向对照: finalize() 之后缓存必须被清掉（跨回合基准不许沿用 ✗）", async () => {
    __resetFileChangeSnapshotCache();
    seed();
    const t = new FileChangeTracker(WS, "s1", "m1", 1);
    await t.start();
    expect(__hasFileChangeSnapshot(WS), "start 之后缓存里有 ✓").toBe(true);
    await t.finalize();
    expect(__hasFileChangeSnapshot(WS), "finalize 之后必须清掉 ✓（否则下一回合会拿上一回合的基准 ✗）").toBe(false);
  });

  it("FCS-3: 复用进来的实例必须带上 beforeSnapshot/beforeTree 且 active（否则 finalize 恒 null ✗）", async () => {
    __resetFileChangeSnapshotCache();
    seed();
    const second = new FileChangeTracker(WS, "s1", "m2", 2);
    await second.start();
    const anyT = second as unknown as { beforeSnapshot: unknown; beforeTree: unknown; active: boolean };
    expect(anyT.beforeSnapshot, "复用也必须带上基准 ✓").toBeTruthy();
    expect(anyT.beforeTree, "复用也必须带上 beforeTree ✓").toBeTruthy();
    expect(anyT.active, "复用也要置 active ✓（finalize 第一句会看它 ✓）").toBe(true);
  });
});
