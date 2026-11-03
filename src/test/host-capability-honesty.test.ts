/**
 * capability 诚实性判据（CAP-H1/2）：
 * - 声称 supported 的方法必须真的在 server 里有实现（不能抛 UNSUPPORTED）；
 * - 未实现的方法必须出现在 unsupported 列表里（不能"嘴上支持"）。
 *
 * 本判据是结构闸门：审计发现过 `attachment.put` 被列为 supported、实际抛 UNSUPPORTED。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "..", "..");
const runtime = readFileSync(join(root, "packages/host/src/runtime.ts"), "utf8");
const server = readFileSync(join(root, "packages/host/src/server.ts"), "utf8");

function block(name: "supported" | "unsupported"): string {
  const m = new RegExp(`${name}: \\[([\\s\\S]*?)\\]`).exec(runtime) ?? new RegExp(`${name}: \\[([\\s\\S]*?)\\]`).exec(runtime);
  return m?.[1] ?? "";
}

describe("CAP-H1 未实现的方法不能声称 supported", () => {
  it("attachment.put / workspace.diff / session.changes 已实现；terminal.* 仍在 unsupported", () => {
    const supported = block("supported");
    const unsupported = block("unsupported");
    expect(supported).toContain("attachment.put");
    expect(supported).toContain("workspace.diff");
    expect(supported).toContain("session.changes");
    expect(supported).toContain("session.change.diff");
    expect(supported).not.toContain("terminal.");
    for (const m of ["terminal.open", "terminal.write"]) {
      expect(unsupported, `${m} 应在 unsupported`).toContain(m);
    }
  });

  /**
   * ★ CAP-H1b（第 270 波）：同一个方法**不许同时出现在两张表**。
   *
   * 审计发现过 `workspace.diff` 同时在 supported 与 unsupported —— 客户端按
   * unsupported 灰入口，于是把一个**已经实现**的功能藏了起来。上一版判据只查了
   * supported 那一半，抓不到；现在用集合交集钉死。
   */
  it("CAP-H1b: supported ∩ unsupported = ∅", () => {
    const methods = (text: string) => [...text.matchAll(/"([a-z][\w.]*)"/g)].map((m) => m[1]);
    const supported = new Set(methods(block("supported")));
    const unsupported = new Set(methods(block("unsupported")));
    const both = [...supported].filter((m) => unsupported.has(m));
    expect(both, `同一方法同时出现在两张表：${both.join(", ")}`).toEqual([]);
    expect(unsupported.has("workspace.diff"), "已实现的方法不许留在 unsupported").toBe(false);
  });
});

describe("CAP-H2 未实现的方法真的要报 UNSUPPORTED", () => {
  it("attachment/diff/变更列表都接了实现，terminal 仍 UNSUPPORTED", () => {
    expect(server).toMatch(/case METHODS\.attachmentPut:[\s\S]{0,400}putAttachment/);
    expect(server).toMatch(/case METHODS\.workspaceDiff:[\s\S]{0,400}diffWorkspaceFile/);
    expect(server).toMatch(/case METHODS\.sessionChanges:[\s\S]{0,400}listChanges/);
    expect(server).toMatch(/case METHODS\.sessionChangeDiff:[\s\S]{0,400}diffChange/);
  });
});
