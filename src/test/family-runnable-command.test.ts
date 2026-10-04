/**
 * 第 121 波：**"这一族可以一起跑"这条事实**的判据。
 *
 * ## 为什么加它（依据是被证伪的那条路线）
 *
 * 243 的读数（机制确认已送达 ✓）显示：`repo-02` 两轮都**只碰 `dsh-d10`** ✗、
 * 从没碰被判分的 `dsh-d9` ✗ ⇒ 主判据被违反 ✗。
 * 也就是说**"把判据名送到眼前"不够** ✗ —— 模型会挑**字面最像**的那一条就收工 ✗。
 *
 * 于是加一条**关于仓库的事实** ✓：这一族可以用一条命令一起跑 ✓。
 * 它不替模型做事（跑不跑、怎么改仍是它的判断 ✓）、不判断（无"你应该/你漏了" ✗）、
 * 对通过与不通过一视同仁（同一条事实任何时候都成立 ✓）。
 *
 * 变异自证：把命令那行删掉 ⇒ TSN-10 红；把措辞改成夹带判断 ⇒ TSR-2 红（沿用）。
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { buildTaskSearchNotice, buildFamilyReminder } from "../../src/core/llm/task-keyword-search";
import { nodeFsSource } from "./helpers/node-fs-source";

/** 够大（≥50 个测试文件）且目标族在 src/test 下 */
function workspace() {
  const root = mkdtempSync(join(tmpdir(), "codem-family-runnable-"));
  mkdirSync(join(root, "src", "test"), { recursive: true });
  for (let i = 0; i < 60; i++) writeFileSync(join(root, "src", "test", `noise-${String(i).padStart(2, "0")}.test.ts`), "// n");
  for (let i = 1; i <= 6; i++) writeFileSync(join(root, "src", "test", `dsh-d${i}-usage-bucket.test.ts`), "// usage 记账\n");
  return root;
}

describe("第 121 波：把「这一族可以一起跑」当事实给出", () => {
  it("TSN-10: 清单/提醒里给出这一族的**可运行命令**（含正确的目录与通配）", async () => {
    const root = workspace();
    try {
      const notice = await buildTaskSearchNotice(root, "记账的桶数不对 usage", { src: nodeFsSource() });
      expect(notice, "夹具前提：应当给出清单").toBeTruthy();
      expect(notice!, "必须给出可运行命令").toMatch(/npx vitest run src\/test\/dsh-\*\.test\.ts/);

      const reminder = await buildFamilyReminder(root, "记账的桶数不对 usage", { src: nodeFsSource() });
      expect(reminder, "夹具前提：应当给出族提醒").toBeTruthy();
      expect(reminder!, "族提醒里也要有这条命令").toMatch(/npx vitest run src\/test\/dsh-\*\.test\.ts/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("TSN-11 反向对照: 目录不同 ⇒ 命令里的目录要跟着变（不是写死的 src/test）", async () => {
    const root = mkdtempSync(join(tmpdir(), "codem-family-runnable2-"));
    try {
      mkdirSync(join(root, "packages", "billing", "tests"), { recursive: true });
      for (let i = 0; i < 60; i++) {
        writeFileSync(join(root, "packages", "billing", "tests", `noise-${String(i).padStart(2, "0")}.test.ts`), "// n");
      }
      for (let i = 1; i <= 6; i++) {
        writeFileSync(join(root, "packages", "billing", "tests", `dsh-d${i}-usage-bucket.test.ts`), "// usage\n");
      }
      const reminder = await buildFamilyReminder(root, "usage 记账", { src: nodeFsSource() });
      expect(reminder, "夹具前提").toBeTruthy();
      expect(reminder!, "命令里的目录应当来自成员实际所在目录").toContain("packages/billing/tests/dsh-*.test.ts");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
