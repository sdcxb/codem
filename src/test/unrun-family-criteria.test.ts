/**
 * 第 156 波：**族口径的收尾判定** ✓ —— 用**真机读数指出的信号**（族），而不是"共享符号"✗。
 *
 * ## 为什么（第 154/155 波的教训）
 *
 * 我先做的是"共享符号"✗，先验前提一量就发现是哑的 ✗：
 * 对 `tools.ts` 只找得到 `dsh-d10`（**已经跑过的那条** ✗），漏掉 `dsh-d8` / `dsh-d9` ✗；
 * 两次放宽都还是找不到 ✗。而真机读数早就指出差别是「**同族跑了几条**」✓：
 * 通过轮跑了整个 `dsh-*` 族 ✓，失败轮只跑了一条 ✗。
 *
 * ## 判据（**直接用真实仓库** ✓ —— 这就是失败轮的原始形状 ✓）
 *
 * - **FAM-1**：只跑了 `dsh-d10…` ⇒ 必须点出族里**没跑过的** `dsh-d8…` 与 `dsh-d9…` ✓；
 * - **FAM-2 反向对照**：族跑齐 ⇒ **不许**点 ✓；
 * - **FAM-3**：一条判据都没跑过（`runFiles` 为空）⇒ 不点 ✓（那是"没验证"那条守卫的职责 ✓，
 *   这条不该重复喊 ✗）。
 *
 * 变异：不减去"跑过的"（`run.has(file)` 不再跳过）⇒ FAM-2 红 ✓。
 */
import { describe, expect, it } from "vitest";
import { unrunFamilyCriteria } from "../core/llm/task-keyword-search";
import { nodeFsSource } from "./helpers/node-fs-source";

const ROOT = process.cwd();
const D8 = "src/test/dsh-d8-edit-ambiguity.test.ts";
const D9 = "src/test/dsh-d9-multi-edit-partial-failure.test.ts";
const D10 = "src/test/dsh-d10-write-not-executed-is-error.test.ts";

describe("第 156 波：族口径的收尾判定（失败轮的原始形状 ✓）", () => {
  it("FAM-1: 只跑了 dsh-d10 ⇒ 必须点出 dsh-d8 与 dsh-d9（失败轮就是这么栽的 ✗）", async () => {
    const unrun = await unrunFamilyCriteria({ root: ROOT, runFiles: [D10], src: nodeFsSource(), max: 20 });
    console.log("[族口径] 没跑过的同族判据：", JSON.stringify(unrun));
    expect(unrun, "族里没跑过的两条必须被点出来").toContain(D8);
    expect(unrun, "族里没跑过的两条必须被点出来").toContain(D9);
  });

  it("FAM-2 反向对照: 族跑齐 ⇒ 不许点（别把收尾变成复读机 ✗）", async () => {
    /** 先列出整个 `dsh-` 族（用 `collectTestFiles` 的口径 ✓）：把族成员都当成"跑过" ✓ */
    const all = await unrunFamilyCriteria({ root: ROOT, runFiles: [D10], src: nodeFsSource(), max: 50 });
    const family = [D10, ...all];
    const unrun = await unrunFamilyCriteria({ root: ROOT, runFiles: family, src: nodeFsSource(), max: 50 });
    expect(unrun, "整族都跑过 ⇒ 一条都不该点").toEqual([]);
  });

  it("FAM-3: 一条都没跑过 ⇒ 不点（那是「改了但没验证」那条守卫的职责 ✗）", async () => {
    const unrun = await unrunFamilyCriteria({ root: ROOT, runFiles: [], src: nodeFsSource(), max: 20 });
    expect(unrun).toEqual([]);
  });
});
