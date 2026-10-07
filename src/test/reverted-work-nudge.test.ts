/**
 * 第 46 波：`reverted` 守卫的文案必须**按还原类型给具体救法** ✓（目标① 的实测着力点 ✓）。
 *
 * ## 真机证据（**只有一条命令、没有 `pop`** ✓）
 *
 * `1.16.295` 批的 `repo-02` run-2（**败** ✗）控制台侧车里，涉及 stash 的命令**逐字只有一条** ✓：
 * ```
 * git stash push -- src/core/llm/tools.ts; Write-Host "stash-exit=$LASTEXITCODE"; npx vitest run …
 * ```
 * ★ **全轮一次 `git stash pop` 都没有** ✗ ⇒ 模型为了做"这条红是不是既有"的基线对比 ✓，
 * 把自己的修复 stash 走了 ✓ 且没恢复 ✓（最终 `diff` 只剩 1083 字符 ✗）。
 * 而当时 `reverted` 守卫**确实开火了** ✓（`phase:"reverted"` @38 ✓），文案却是泛泛的
 * "请把它**做回来**"✗ —— **没告诉它改动还在 stash 里** ✗。
 *
 * ⇒ 所以这一波把文案**按类型分支** ✓：`stash` ⇒ 给 `git stash list` / `git stash pop` ✓；
 * 丢弃式（`checkout --` / `restore` / `reset --hard`）⇒ 明说"改动不在任何地方了，只能重做" ✓。
 *
 * ## 判据
 *
 * | id | 钉什么 | 变异（应当红 ✗） |
 * |---|---|---|
 * | `REV-1` | `stash` 型 ⇒ 文案**必须**给出 `git stash list` 与 `git stash pop` ✓ | 返回通用文案 ⇒ 红 |
 * | `REV-2`（反向对照）| `discard` 型 ⇒ 文案**不许**出现 stash 字样 ✓（救法不同，不许套模板 ✗）| 两支合并 ⇒ 红 |
 * | `REV-3` | 既有口径不许丢：`git stash list` / `show` 是"看"、**不是还原** ✓ | 把它算成还原 ⇒ 红 |
 * | `REV-4` | 结构：循环里的文案**只由** `buildRevertedWorkNudge` 造 ✓（不许再手写一份 ✗）| 内联模板 ⇒ 红 |
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildRevertedWorkNudge, looksLikeRevertCommand, revertKindOf } from "../core/llm/completion-guards";
import { stripComments } from "./helpers/settings-key-scan";

const ROOT = process.cwd();
const LOOP = () => stripComments(readFileSync(join(ROOT, "src", "core", "llm", "agentic-loop.ts"), "utf8"));

describe("第 46 波：还原守卫的文案（按类型给救法）", () => {
  it("REV-1: stash 型 ⇒ 必须给出 `git stash list` 与 `git stash pop`（真机就是忘了 pop ✗）", () => {
    const text = buildRevertedWorkNudge("stash");
    console.log("[REV-1] 文案：\n" + text);
    expect(text, "要让它先看到底有没有自己的那条").toContain("git stash list");
    expect(text, "★ 关键：告诉它改动还在 stash 里、怎么恢复").toContain("git stash pop");
    expect(text, "仍要保留'有意放弃就说明理由'那条出路 ✓").toContain("说明理由");
  });

  it("REV-2 反向对照: discard 型 ⇒ 不许出现 stash 字样（救法不同，不许套模板 ✗）", () => {
    const text = buildRevertedWorkNudge("discard");
    console.log("[REV-2] 文案：\n" + text);
    expect(text, "丢弃式要明说'只能重做'").toContain("重做");
    expect(text, "不许提 stash（那会误导它去找一个不存在的 stash ✗）").not.toContain("stash");
  });

  it("REV-3: 既有口径不许丢 —— `git stash list` / `show` 是'看'不是还原", () => {
    expect(revertKindOf("git stash list"), "看不是还原").toBeNull();
    expect(revertKindOf("git stash show -p"), "看不是还原").toBeNull();
    expect(revertKindOf("git stash push -m tmp"), "push 是还原").toBe("stash");
    expect(revertKindOf("git checkout -- src/core/llm/tools.ts"), "带 -- 的 checkout 是丢弃式").toBe("discard");
    expect(revertKindOf("git restore src/core/llm/tools.ts"), "restore 是丢弃式").toBe("discard");
    expect(revertKindOf("git reset --hard HEAD"), "reset --hard 是丢弃式").toBe("discard");
    expect(revertKindOf("npx vitest run src/test/x.test.ts"), "普通命令不是还原").toBeNull();
    expect(looksLikeRevertCommand("git stash list"), "旧口径也要一致（list 不算 ✗）").toBe(false);
  });

  it("REV-4: 结构 —— 循环里的文案只由 `buildRevertedWorkNudge` 造（不许再手写一份 ✗）", () => {
    const src = LOOP();
    expect(src, "循环必须调用这个构造器").toContain("buildRevertedWorkNudge(");
    expect(src, "旧的泛泛文案不许再留在循环里（两份必然漂移 ✗）").not.toContain("几乎总是**收尾时误撤**");
    expect(src, "还原类型要记进侧车（否则'哪种还原'事后看不出来 ✗）").toContain("kind: this.revertedKind");
  });
});
