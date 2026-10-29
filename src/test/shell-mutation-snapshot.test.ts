/**
 * 快照判据必须把 **shell 类工具**算进去（第 233 轮审计 · P1 数据链）。
 *
 * ## 缺陷形态
 *
 * `needsPreCallSnapshot(contract)` 的判据是 `sideEffectScope === "workspace" && !readOnly`
 * —— 而 `bash` 的契约是 `sideEffectScope: "system"`（它属于"影响系统"，不专指工作区），
 * 于是：
 *
 * - 纯 shell 改的工作区（`npm install` 写 lockfile、`git apply`、`prettier --write`、
 *   `sed -i`）**一条 `turn_file_changes` 都不记**（右栏"改动"看不到、回滚回不到）；
 * - 更糟的是**下一轮**：文件工具拍快照时的 before 树仍停在这一轮 shell 改动之前，
 *   于是那些改动被算进**下一轮**的记录里 —— 对下一轮回滚会连带撤销上一轮的产物。
 *
 * ## 判据（不是"所有 shell 都拍"）
 *
 * 每次 bash 都拍快照是有代价的（一次 git 树对象）。所以用**同一套命令意图判定**
 * （`analyzeBashCommand`，计划模式守卫用的就是它）：
 * - `write` / `dangerous` ⇒ 拍（可能改工作区）；
 * - `readonly`（`Get-ChildItem` / `git status` / `grep`）⇒ **不拍**（不增加 git 调用）；
 * - 判不出来 / 没有 command ⇒ 拍（宁严不宽，与计划模式同一取向）。
 *
 * ## 判据清单
 *
 * | # | 行为 |
 * |---|---|
 * | SNAP-1 | `bash` + 写类命令（`npm install`）⇒ 需要快照 |
 * | SNAP-2 | `bash` + 只读命令（`Get-ChildItem -Path src`）⇒ **不需要**（反向对照：不能给每次查询加一次 git） |
 * | SNAP-3 | `write` ⇒ 需要；`read` ⇒ 不需要（既有契约判据不受影响） |
 * | SNAP-4 | 空命令 / 判不出来 ⇒ 需要（fail-safe） |
 * | SNAP-5 | 执行循环真的按这个判据走（带 args 调用） |
 *
 * 变异自证：把 `needsPreCallSnapshotForCall` 里的 shell 分支去掉 ⇒ SNAP-1 立刻红。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { needsPreCallSnapshotForCall, mayMutateWorkspaceViaShell } from "../core/llm/tool-contract";
import { createDefaultToolRegistry } from "../core/llm/tools";

const registry = createDefaultToolRegistry();
const bash = registry.getContract("bash");
const write = registry.getContract("write");
const read = registry.getContract("read");

const ROOT = join(__dirname, "..", "..");

describe("shell 改工作区必须进快照/改动记录", () => {
  it("SNAP-1: bash + 写类命令 ⇒ 需要快照", () => {
    for (const command of ["npm install", "git apply x.patch", "prettier --write src", "Set-Content -Path a.ts -Value x"]) {
      expect(
        needsPreCallSnapshotForCall("bash", bash, { command }),
        `「${command}」会改工作区，必须拍快照（否则改动不进 turn_file_changes）`,
      ).toBe(true);
    }
  });

  it("SNAP-2（反向对照）: bash + 只读命令 ⇒ 不需要快照", () => {
    for (const command of ["Get-ChildItem -Path src", "git status", "Select-String -Path a.ts -Pattern x"]) {
      const mayMutate = mayMutateWorkspaceViaShell("bash", bash, { command });
      expect(mayMutate, `「${command}」是只读查询，不该为它发 git`).toBe(false);
    }
  });

  it("SNAP-3（反向对照）: 既有契约判据不受影响", () => {
    expect(needsPreCallSnapshotForCall("write", write, { path: "a.ts" })).toBe(true);
    expect(needsPreCallSnapshotForCall("read", read, { path: "a.ts" })).toBe(false);
  });

  it("SNAP-4: 空命令 / 判不出来 ⇒ 按可能写处理（fail-safe）", () => {
    expect(needsPreCallSnapshotForCall("bash", bash, {})).toBe(true);
    expect(needsPreCallSnapshotForCall("bash", bash, { command: "   " })).toBe(true);
  });

  it("SNAP-5: 执行循环用的是这个判据（带 args），不是只按契约", () => {
    const src = readFileSync(join(ROOT, "src/core/llm/agentic-loop.ts"), "utf8");
    expect(src, "循环必须把 args 传进判据").toContain("needsPreCallSnapshotForCall(");
    expect(src).toContain("callContract, args");
  });
});
