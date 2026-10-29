/**
 * 改动前快照的前置判定（P0：真机「操作没有生效 (loop.preCallSnapshot): os error 3」）。
 *
 * 判据钉三件事：
 * 1. 工作区不存在 → 跳过（不报错、不弹"功能不可用"）；
 * 2. 工作区存在 → 照常快照（不许因为"可能不存在"就一律跳过）；
 * 3. exists 自己抛错 → **不跳过**（探测失败不许悄悄放弃回滚证据）。
 */
import { describe, expect, it, vi } from "vitest";

import { decidePreCallSnapshot } from "../core/environment/pre-call-snapshot";

describe("PRECALL：快照前置判定", () => {
  it("PRECALL-1: 工作区不存在 → 跳过快照，并给出原因", async () => {
    const exists = vi.fn().mockResolvedValue(false);
    const d = await decidePreCallSnapshot("C:\\missing-workspace", exists);
    expect(d.skip).toBe(true);
    expect(String(d.reason)).toContain("missing-workspace");
    expect(exists).toHaveBeenCalledWith("C:\\missing-workspace");
  });

  it("PRECALL-2: 工作区存在 → 不跳过（照常取快照）", async () => {
    const d = await decidePreCallSnapshot("C:\\repo", vi.fn().mockResolvedValue(true));
    expect(d.skip).toBe(false);
  });

  it("PRECALL-3: 没有 cwd → 跳过（无工作区可快照）", async () => {
    const exists = vi.fn();
    const d = await decidePreCallSnapshot(undefined, exists);
    expect(d.skip).toBe(true);
    expect(exists, "没有 cwd 时不该再探测文件系统").not.toHaveBeenCalled();
  });

  it("PRECALL-4: exists 自己抛错 → 不跳过（让真实快照路径去上报）", async () => {
    const d = await decidePreCallSnapshot("C:\\repo", vi.fn().mockRejectedValue(new Error("file-api down")));
    expect(d.skip).toBe(false);
  });
});
