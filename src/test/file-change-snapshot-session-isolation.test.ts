/**
 * 「改动前快照」的复用必须**按会话隔离**（第 233 轮审计 · P2 记录重叠）。
 *
 * ## 缺陷形态
 *
 * `beforeSnapshotCache` 的键原来只有**工作区路径**：
 *
 * ```ts
 * const cached = beforeSnapshotCache.get(this.workspace);
 * ```
 *
 * 而子代理（`spawn_subagent`）与父会话**共用同一个 cwd**。于是：
 * 1. 子 loop 的 `start()` 命中父会话的缓存 ⇒ 子记录里含**父本轮的早期改动**；
 * 2. 子代理 `finalize()` 把它的 after 写进同一个键 ⇒ 父会话下一轮的 before 变成
 *    "子代理改完之后" ⇒ 子代理的改动从父记录里消失。
 *
 * 两条记录因此重叠/互缺，而回滚是**按记录**回滚的 —— 对任一条回滚都会连带撤销另一轮产物。
 *
 * ## 判据
 *
 * | # | 行为 |
 * |---|---|
 * | FCS-S1 | 同一会话的连续 `start()` 仍然复用（性能契约不许丢，反向对照） |
 * | FCS-S2 | 不同会话（同 cwd）**不许**复用对方的快照 |
 * | FCS-S3 | 播种（测试钩子）也按会话区分 |
 *
 * 变异自证：把键改回 `workspace` ⇒ FCS-S2 立刻红。
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
const PARENT = "session-parent";
const CHILD = "session-child";

function seed(sessionId: string): void {
  __seedFileChangeSnapshot(WS, `tree-${sessionId}`, { ref: `tree-${sessionId}`, untracked: [] } as unknown as never, sessionId);
}

describe("改动前快照：按会话隔离", () => {
  beforeEach(() => __resetFileChangeSnapshotCache());

  it("FCS-S1（反向对照）: 同一会话连续 start 仍然复用（不复用就等于没缓存）", async () => {
    seed(PARENT);
    await new FileChangeTracker(WS, PARENT, "m1", 1).start();
    await new FileChangeTracker(WS, PARENT, "m2", 2).start();
    const st = __fileChangeSnapshotStats();
    expect(st.taken, "同一会话已播种，不该再取").toBe(0);
    expect(st.reused, "两次都复用").toBe(2);
  });

  it("FCS-S2: 不同会话（同 cwd）不许复用对方的 before 快照", async () => {
    seed(PARENT);
    const child = new FileChangeTracker(WS, CHILD, "m1", 1);
    const ok = await child.start();

    /**
     * 子代理这边**不许**拿到父会话的基准：
     * - 命中缓存 ⇒ 子记录会把父本轮的早期改动算成自己的（回滚越界）；
     * - 这里没有 git（vitest 恒 false）⇒ `start()` 会失败并返回 false，
     *   这正是"没有借用父会话基准"的可观测证据。
     */
    expect(ok, "子会话不许借用父会话的快照").toBe(false);
    expect(__hasFileChangeSnapshot(WS, PARENT), "父会话的缓存在").toBe(true);
    expect(__hasFileChangeSnapshot(WS, CHILD), "子会话没有缓存（没有借用）").toBe(false);
    const anyChild = child as unknown as { beforeTree?: unknown; active: boolean };
    expect(anyChild.beforeTree, "子会话不许凭空得到 beforeTree（初值是 null）").toBeFalsy();
    expect(anyChild.active, "也不许被置成 active").toBe(false);
  });

  it("FCS-S3: 播种按会话区分（同一工作区两份互不影响）", () => {
    seed(PARENT);
    expect(__hasFileChangeSnapshot(WS, PARENT)).toBe(true);
    expect(__hasFileChangeSnapshot(WS, CHILD)).toBe(false);
    seed(CHILD);
    expect(__hasFileChangeSnapshot(WS, CHILD)).toBe(true);
  });
});
