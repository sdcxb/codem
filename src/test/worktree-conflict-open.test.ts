/**
 * worktree 合并冲突的「先打开看」最小增强（2026-10-28 拍板 D3-C）。
 *
 * 背景：冲突时默认 `merge --abort` 回滚（安全），UI 只能整次选边。C 选项不改变回滚策略，
 * 只补「列出冲突文件 + 逐个打开」这一层。判据：
 *
 * | # | 行为 |
 * |---|---|
 * | WTC-1 | 相对路径拼到主工作区上，并把 `\` 统一成 `/`（Windows 混用会让解析失败） |
 * | WTC-2 | 已是绝对路径时原样返回（不重复拼接） |
 * | WTC-3（接线） | 冲突区块用 `conflictAbsolutePath` + `openFileDirectly`，且**保留**回滚与整次选边 |
 *
 * 变异自证：把 `conflictAbsolutePath` 改成直接返回 `rel` ⇒ WTC-1 红；
 * 把冲突区块的「打开」按钮删掉 ⇒ WTC-3 红。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { conflictAbsolutePath } from "../core/environment/worktree-manager";

const ROOT = join(__dirname, "..", "..");

describe("D3-C：冲突文件路径与打开入口", () => {
  it("WTC-1: 相对路径拼到主工作区，分隔符统一", () => {
    expect(conflictAbsolutePath("C:\\proj\\demo", "src/a.ts")).toBe("C:/proj/demo/src/a.ts");
    expect(conflictAbsolutePath("C:/proj/demo/", "src\\b.ts")).toBe("C:/proj/demo/src/b.ts");
    expect(conflictAbsolutePath("C:\\proj\\demo", "src\\nested\\c.ts")).toBe("C:/proj/demo/src/nested/c.ts");
  });

  it("WTC-2: 已是绝对路径时原样返回", () => {
    expect(conflictAbsolutePath("C:\\proj", "D:\\other\\x.ts")).toBe("D:\\other\\x.ts");
    expect(conflictAbsolutePath("C:\\proj", "/tmp/x.ts")).toBe("/tmp/x.ts");
  });

  it("WTC-3: 冲突区块接了「打开」且保留回滚/选边", () => {
    const src = readFileSync(join(ROOT, "src/components/GitInfoPanel.tsx"), "utf8");
    expect(src, "冲突文件必须能逐个打开").toContain("openFileDirectly(conflictAbsolutePath(");
    expect(src, "冲突时仍要有「以工作树为准」").toContain('handleMergeWorktree("worktree")');
    expect(src, "冲突时仍要有「以主工作区为准」").toContain('handleMergeWorktree("main")');
    // 回滚策略不变：默认仍是 abort（不在 UI 里传别的默认）
    expect(src, "默认回滚不能被悄悄改成停在冲突态").toContain('onConflict ?? "abort"');
  });
});
