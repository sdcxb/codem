/**
 * 第 169 波：**"改完又还原"守卫的判据** ✓。
 *
 * ## 真机取证（1.16.268 的收尾段诊断 ✓）
 *
 * ```
 * run-3（failed、diff=0、29 次调用）
 * [agent-loop] 收尾段：进入 modified=true edited=4 lookedAtSource=true tests=8 red=0
 * ```
 * ⇒ 收尾段走到了 ✓、两把守卫都**正确地**沉默 ✓ —— 而它 **`edited=4` 却 `diff=0`** ✗
 * ⇒ 唯一解释：**改完、跑完测试（全绿）、又把改动还原掉了** ✗
 * （日志里出现过 `git stash push -- src/core/llm/tools.ts` ✓，而评测的 `selfRestoreCommands` 漏了它 ✗）。
 *
 * ## 判据
 *
 * - **RV-1**：还原过、之后再没编辑 ⇒ **必须提醒** ✓；
 * - **RV-2 反向对照**：没还原过 ⇒ 不提醒 ✓；
 * - **RV-3 反向对照**：还原之后**又编辑了** ⇒ 不提醒 ✓（那是"撤掉错的一版、重做一版"✓ 的正常动作 ✓）；
 * - **RV-4**：每会话一次 ✓；
 * - **RV-5**：还原型命令的识别 ✓（`git checkout -- x` / `restore` / `stash` / `reset --hard` ✓ 认；
 *   普通的 `git status` / `git diff` / `git add` **不认** ✗ —— 别把"看一眼"当成"还原"✓）。
 *
 * 变异：把 `git stash` 从识别里去掉 ⇒ RV-5 红 ✓（而真机证据正是 `git stash push` ✗）。
 */
import { describe, expect, it } from "vitest";
import { looksLikeRevertCommand, shouldNudgeRevertedWork } from "../core/llm/completion-guards";

describe("第 169 波：改完又还原守卫", () => {
  it("RV-1: 还原过、之后再没编辑就收尾 ⇒ 必须提醒（run-3 的形状 ✗）", () => {
    expect(
      shouldNudgeRevertedWork({ revertedAfterEdit: true, alreadyNudged: false }),
      "edited=4 却 diff=0 ⇒ 改动被还原、留下的东西是空的 ⇒ 不许安静地过去",
    ).toBe(true);
  });

  it("RV-2 反向对照: 没还原过 ⇒ 不提醒", () => {
    expect(shouldNudgeRevertedWork({ revertedAfterEdit: false, alreadyNudged: false })).toBe(false);
  });

  it("RV-4: 每会话一次 ⇒ 提醒过就不再提醒", () => {
    expect(shouldNudgeRevertedWork({ revertedAfterEdit: true, alreadyNudged: true })).toBe(false);
  });

  it("RV-5: 还原型命令的识别（认 stash / checkout -- / restore / reset --hard；不认 status/diff/add）", () => {
    for (const c of [
      'git stash push -- src/core/llm/tools.ts',
      'git stash',
      'git checkout -- src/core/llm/tools.ts',
      'git checkout src/core/llm/tools.ts --',
      'git restore src/core/llm/tools.ts',
      'git reset --hard HEAD',
    ]) {
      expect(looksLikeRevertCommand(c), `应当认作还原型：${c}`).toBe(true);
    }
    for (const c of ["git status --short", "git diff --stat", "git add -A", "git stash list", "git log --oneline -1"]) {
      /** ⚠️ `git stash list` 是**看**不是**还原** ✓ —— 真机里它常和还原一起出现 ✗，必须区分 ✓。 */
      expect(looksLikeRevertCommand(c), `不该认作还原型：${c}`).toBe(false);
    }
  });
});
