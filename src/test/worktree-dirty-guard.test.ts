/**
 * 「切换执行模式」那道防丢改动闸门：**问不到不等于干净**（第 86 轮）
 *
 * ## 现场（两个失败层叠出来的形态）
 *
 * 第 85 轮走查点「切换执行模式」：工作区**明明是脏的**（有未提交改动），
 * 却**没有弹确认框、模式直接切走了**（第 84 轮同一个探针是弹了的）。
 *
 * 翻代码找到**两层 fail-open**：
 * 1. `worktree-manager.ts::hasUncommittedChanges` 的 `catch { return false }` ——
 *    git 检查失败被汇报成"**工作区是干净的**"；
 * 2. `TitleBar.tsx` 又包了一层 `catch { /* 检查失败则继续 *\/ }` —— 抛错也照切。
 *
 * 于是"git 只要没跑通，防丢改动的提醒就静默消失"。而这道提醒存在的**唯一理由**
 * 就是防止用户在脏工作区上切模式而丢改动。
 *
 * ## 修法
 *
 * - `hasUncommittedChanges` 改成**三态**：`true` / `false` / **`null`（问不到）**，
 *   并且 `null` 走**上报通道**（横幅可见），不再冒充"干净"；
 * - 新增纯函数 `decideWorktreeDirtyGuard(dirty)`：**只有 `false` 才直接切**，
 *   `true` 与 `null` 都要先问（`null` 的问句如实说明"无法确认"）；
 * - `TitleBar` 删掉那层 `catch`，改用判据函数。
 *
 * ## 判据
 *
 * | 编号 | 判据 |
 * | --- | --- |
 * | WG-1 | `null`（问不到）必须走 `ask`，**不许**当 `proceed`（这条就是那个洞） |
 * | WG-2 | git 调用失败时 `hasUncommittedChanges` 返回 **null**（不是 false），并上报 |
 * | WG-3 | 结构：`worktree-manager` 的 catch 不再 `return false`；`TitleBar` 不再有"检查失败则继续"的 catch，且必须用判据函数 |
 * | WG-4 | 反向对照：把 `null` 当干净的老写法必须能被判据识别 |
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import { decideWorktreeDirtyGuard } from "../core/environment/worktree-manager";
import { getPersistFailures, resetPersistFailures } from "../core/storage/persist-failure";

const mocks = vi.hoisted(() => ({ executeCommand: vi.fn() }));

vi.mock("../core/file-api", () => ({
  executeCommand: mocks.executeCommand,
  exists: vi.fn(async () => false),
}));

import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = process.cwd();
const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");

beforeEach(() => {
  resetPersistFailures();
  mocks.executeCommand.mockReset();
});

describe("切换执行模式的防丢改动闸门（第 86 轮）", () => {
  it("WG-1: 只有「确认干净」才直接切；有改动与问不到都要先问", () => {
    expect(decideWorktreeDirtyGuard(false), "确认干净 ⇒ 直接切").toBe("proceed");
    expect(decideWorktreeDirtyGuard(true), "确认有改动 ⇒ 问").toBe("ask");
    expect(decideWorktreeDirtyGuard(null), "**问不到 ⇒ 必须问**（这就是那个洞）").toBe("ask");
  });

  it("WG-2: git 检查失败 ⇒ 返回 null 并上报（不许冒充「干净」）", async () => {
    const { hasUncommittedChanges } = await import("../core/environment/worktree-manager");

    mocks.executeCommand.mockRejectedValueOnce(new Error("git 没跑通（sandbox 拒绝）"));
    const failed = await hasUncommittedChanges("C:/repo");
    expect(failed, "失败必须是 null，而不是 false（false = 干净）").toBeNull();
    const areas = getPersistFailures().map((f) => f.area);
    expect(areas, "失败要走上报通道，否则用户永远不知道这道闸门失效了").toContain("worktree.hasUncommittedChanges");

    resetPersistFailures();
    mocks.executeCommand.mockResolvedValueOnce({ stdout: " M src/a.ts\n" });
    expect(await hasUncommittedChanges("C:/repo"), "有改动 ⇒ true").toBe(true);
    mocks.executeCommand.mockResolvedValueOnce({ stdout: "\n" });
    expect(await hasUncommittedChanges("C:/repo"), "输出为空 ⇒ false").toBe(false);
    expect(getPersistFailures(), "成功路径不该上报").toHaveLength(0);
  });

  it("WG-3: 结构判据 —— 两处 fail-open 都必须消失", () => {
    const wm = strip(fs.readFileSync(path.join(ROOT, "src/core/environment/worktree-manager.ts"), "utf8"));
    /*
     * ⚠️ 判据要**限定在 `hasUncommittedChanges` 的函数体里**：这个文件里还有别的
     * `catch { return false }`（例如 `isGitRepo` 失败时返回 false —— 那是"这个目录不算 Git 仓库"，
     * 后果是"不提供工作树模式"，不是"脏工作区被当成干净"）。第一版对**整份文件**断言，
     * 于是把那个无关的 catch 也扫进来、用例红了却指向错的地方。
     */
    const fnStart = wm.indexOf("export async function hasUncommittedChanges");
    expect(fnStart, "找不到 hasUncommittedChanges").toBeGreaterThan(-1);
    const fnBody = wm.slice(fnStart, wm.indexOf("export function", fnStart));
    expect(fnBody, "catch 里不许再 return false（把「问不到」说成「干净」）").not.toMatch(
      /catch\s*(\([^)]*\))?\s*\{[^}]*return false/,
    );
    expect(fnBody, "失败必须返回 null").toMatch(/return null;/);
    expect(fnBody, "失败要上报").toContain("reportActionFailure");
    expect(wm, "必须导出判据函数").toContain("export function decideWorktreeDirtyGuard");

    const tb = strip(fs.readFileSync(path.join(ROOT, "src/components/TitleBar.tsx"), "utf8"));
    expect(tb, "不许再有「检查失败则继续」的 catch").not.toContain("检查失败则继续");
    expect(tb, "必须用判据函数决定要不要问").toContain("decideWorktreeDirtyGuard(");
    expect(tb, "问句要区分「确认有改动」与「无法确认」").toMatch(/unsure|无法确认/);
    expect(tb, "仍然必须 await 确认框").toMatch(/await confirmDialog\(/);
  });

  it("WG-4: 反向对照 —— 老写法（null 当干净）必须会被判据抓住", () => {
    const oldGuard = (dirty: boolean | null) => (dirty ? "ask" : "proceed"); // 改前的语义
    expect(oldGuard(null), "老写法把 null 当干净 ⇒ proceed").toBe("proceed");
    expect(
      decideWorktreeDirtyGuard(null),
      "新判据必须与老写法在此分道扬镳（这正是 WG-1 要钉的差异）",
    ).not.toBe(oldGuard(null));
  });
});
