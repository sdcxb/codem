/**
 * 存储迁移门禁（P2）：把"迁移还差多少"变成每次跑测试都会检查的数字。
 *
 * ## 为什么需要这个门禁
 *
 * P0 的盘点是**一次性脚本**，而一次性结论会失效。实测就发生过一次严重低估：
 * 盘点脚本的正则写作 `db\.(exec|run|prepare)\(['"]`（要求引号紧跟括号），
 * 而项目源码是 CRLF 且普遍写成
 *
 *     db.run(
 *       "INSERT INTO messages …",
 *
 * 于是**所有 INSERT（写路径！）都被漏掉**，报出"159 个调用点 / 82 个方法"，
 * 真实值是 **277 / 129**。少了 43% 的工作量，而且是写路径 ——
 * 按旧数字排期，"快迁完了"会永远不到。
 *
 * 本文件做三件事：
 * 1. **交叉校验**两个扫描器（`storage-inventory.mjs` 与 `storage-coverage.mjs`）的方法集合完全一致
 *    —— 任何一边的规则漂了，这里立刻变红；
 * 2. 覆盖率不得低于下限（`CODEM_DB_COVERAGE_MIN`，随迁移推进上调）；
 * 3. 映射表里引用的 Rust 命令必须**真实存在**于 `codem-db/src/lib.rs` 的 `COMMANDS`
 *    —— 防"导出文档说实现了、代码里没有"。
 */

import { describe, expect, it } from "vitest";
import { computeCoverage, implementedCommands, rustCommands } from "../../tools/audit/storage-coverage.mjs";

const coverage = computeCoverage();

describe("存储迁移门禁 —— 盘点与 Rust 实现必须对得上", () => {
  it("GATE-DB-1: 两个扫描器（inventory / coverage）的方法集合完全一致", () => {
    expect(
      coverage.inventoryDrift,
      `扫描器规则漂移（这曾经导致 43% 的工作量被漏掉）：${JSON.stringify(coverage.inventoryDrift)}`,
    ).toBeNull();
  });

  it("GATE-DB-2: 覆盖率不低于下限（迁移必须持续推进）", () => {
    const min = Number(process.env.CODEM_DB_COVERAGE_MIN ?? 10);
    expect(
      coverage.coveragePercent,
      `方法覆盖率 ${coverage.coveragePercent}% 低于下限 ${min}%（已实现 ${coverage.implementedMethods}/${coverage.requiredMethods}）`,
    ).toBeGreaterThanOrEqual(min);
  });

  it("GATE-DB-3: 映射表引用的 Rust 命令必须真实存在于 COMMANDS", () => {
    expect(
      coverage.phantomCommands,
      `映射表引用了 Rust 侧不存在的命令：${coverage.phantomCommands.join(", ")}`,
    ).toEqual([]);
  });

  it("GATE-DB-4: 盘点规模在合理范围（防止扫描器「扫到 0 个」这类静默失效）", () => {
    // 这些下限不是"期望值"，而是**防退化护栏**：扫描器写坏了会扫出远小于此的数字，
    // 那时覆盖率会因为分母变小而"看起来变好"—— 这是最隐蔽的失效。
    expect(coverage.scannedFiles).toBeGreaterThan(500);
    expect(coverage.requiredMethods).toBeGreaterThan(100);
    expect(coverage.totalSites).toBeGreaterThan(200);
    expect(coverage.rustCommandCount).toBeGreaterThan(15);
  });

  it("GATE-DB-5: 写路径必须被盘点覆盖（messages/sessions/settings 的 insert 不能缺席）", () => {
    // 直接钉住"曾经被漏掉的那一类"：如果正则又退回"引号必须紧跟括号"，这条会立刻红。
    const required = new Set(
      computeCoverage()
        .done.concat(coverage.pending)
        .map((m: { method: string }) => m.method),
    );
    for (const must of ["messages.insert", "messages.update", "sessions.insert", "settings.insert"]) {
      expect(required.has(must), `写路径 ${must} 未被盘点覆盖（扫描器漏了写入调用）`).toBe(true);
    }
  });

  it("GATE-DB-6: 已实现集合的每个命令都必须在 Rust 侧注册", () => {
    const rust = rustCommands();
    const missing = [...implementedCommands()].filter((c) => !rust.has(c));
    expect(missing, `以下命令在映射表里但不在 Rust COMMANDS 中：${missing.join(", ")}`).toEqual([]);
  });
});
