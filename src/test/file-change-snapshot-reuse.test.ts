/**
 * 第 188 波：**目标②的修复判据（修正版）** —— "上一次的 after" 就是 "下一次的 before" ✓。
 *
 * ## 为什么是修正版 ✗
 *
 * 第 186 波我加过缓存却**没有效果** ✗，原因后来查明 ✓：**`finalize()` 每轮都会被调用** ✓
 * （每轮记录一次文件变更 ✓），而我把"清缓存"放在 `finalize()` 里 ✗ ⇒ 缓存每轮被清 ✗。
 *
 * 真机打点（1.16.280 ✓）也把 2.3s 锁死在 `await start()` 上 ✓：
 * ```
 * preTrackerCtor t=…647
 * iterT0         t=…992   ⇒ **2345ms** ✗（两点之间只有"构造（平凡）+ start()"✓）
 * ```
 *
 * ## 判据（不靠计时 ✗、不依赖 git ✗ —— 播种式 ✓）
 *
 * - **FCS-1**：已有可复用快照 ⇒ `start()` ×3 **全部复用、一次都不再取** ✓；
 * - **FCS-2 反向对照（本轮的关键 ✗）**：`finalize()` **不许**把缓存清掉 ✗，
 *   而必须把它**换成 after 快照** ✓（否则缓存每轮被清 ⇒ 等于没缓存 ✗ —— 这正是 186 波失败的原因 ✓）；
 * - **FCS-3**：复用进来的实例必须带上 `beforeSnapshot`/`beforeTree` 且 `active` ✓
 *   （否则 `finalize()` 走 `return null` ✗）。
 *
 * 变异：把 `start()` 顶部的复用分支去掉 ⇒ **FCS-1/FCS-3 红** ✓；
 * 把 `finalize()` 末尾的"写入 after"换回 `delete` ⇒ **FCS-2 红** ✓（正是 186 波的坑 ✓）。
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
const seed = () => __seedFileChangeSnapshot(WS, "tree-1", { ref: "tree-1", untracked: [] } as unknown as never);

describe("第 188 波：改动前快照跨迭代复用（上一次的 after = 下一次的 before）", () => {
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

  it("FCS-2 反向对照: finalize() 不许把缓存清掉 ✗（186 波就是栽在这里 ✓）", async () => {
    __resetFileChangeSnapshotCache();
    seed();
    const t = new FileChangeTracker(WS, "s1", "m1", 1);
    await t.start();
    expect(__hasFileChangeSnapshot(WS), "start 之后缓存里有 ✓").toBe(true);
    /**
     * `finalize()` 会去拍 after 快照（这里 `isGitRepo` 为 false ⇒ 它拿不到 after ✓），
     * 但它**绝不能**把缓存删掉 ✗ —— 否则下一轮又得重新拍 ✗。
     */
    await t.finalize().catch(() => null);
    expect(
      __hasFileChangeSnapshot(WS),
      "finalize 之后缓存必须**还在** ✓（186 波把它删了 ⇒ 等于没缓存 ✗）",
    ).toBe(true);
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
