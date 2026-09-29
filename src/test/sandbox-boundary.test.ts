/**
 * 门禁：沙箱边界与拒绝文案。
 *
 * ## 这个文件存在的两个理由
 *
 * ### 1. `read_attachment` **按设计不受沙箱约束**（产品决策，别再"顺手补上"）
 *
 * 决策：**附件不算沙箱范围。** 两条理由，任何一条都足以否决「把
 * `read_attachment` 当成沙箱工具」：
 *
 * - **技术上判不了**：沙箱管的是「路径在不在工作区内」，而 `read_attachment`
 *   的入参只有 `attachment_id` / `name` / `offset` / `limit`
 *   （`read-attachment.ts:146-156`）—— **没有 path**，守卫取不到要判的东西。
 * - **产品上不该判**：附件按设计就住在**工作区之外**
 *   （`read-attachment.ts:248-261`：`sandboxPath` 相对工作区解析，否则用
 *   `target.path` 这个绝对路径，在 app data / 用户目录里）。把附件纳入
 *   「必须在工作区内」的判定，结果不是更安全，而是**附件一律读不了**。
 *   附件是用户主动挂上来的，不是 agent 自己找的文件。
 *
 * ### 2. 拒绝文案必须按读/写/删说对
 *
 * 原文案对**所有**工具都说 `Write to ...`，于是「读操作被沙箱拒绝」时
 * 用户看到「写入被拒绝」，排查方向被带偏。
 *
 * ## 第 120 轮：判据从「名单」改成「契约」
 *
 * 本文件原来断言的是「`read_attachment` 不在那两份硬编码名单里」。
 * 守卫改成读工具契约（`sideEffectScope` / `readOnly` / `destructive`）之后，
 * 名单不存在了 —— 所以断言也改成**直接验契约**，这比验名单更强：
 * 名单只说明「这个守卫会不会管」，契约还说明「为什么它判不了」。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createDefaultToolRegistry } from "../core/llm/tools";

const PIPELINE = join(__dirname, "..", "core", "llm", "tool-pipeline.ts");
const pipelineSrc = readFileSync(PIPELINE, "utf8");

describe("沙箱边界：附件按设计不受沙箱约束", () => {
  it("read_attachment 的契约是只读，但它**没有 path 参数**（所以沙箱判不了）", () => {
    const registry = createDefaultToolRegistry();
    const c = registry.getContract("read_attachment");
    // 它确实是只读的 —— 但它不是「沙箱要管的那种只读文件访问」
    expect(c.readOnly).toBe(true);

    const att = readFileSync(
      join(__dirname, "..", "core", "llm", "tools", "read-attachment.ts"),
      "utf8",
    );
    const paramBlock = att.slice(att.indexOf("parameters:"), att.indexOf("parameters:") + 1200);
    expect(paramBlock).toContain("attachment_id");
    // 关键：没有 path 参数，守卫取不到路径
    expect(paramBlock).not.toMatch(/^\s*path:\s*\{/m);
    expect(paramBlock).not.toContain("file_path");
  });

  it("守卫在取不到 path 时确实会放行（这是「判不了」的机制）", () => {
    expect(pipelineSrc).toMatch(/const path = \(args\.path \|\| args\.file_path\)/);
    expect(pipelineSrc).toMatch(/if \(!path\) return \{ action: "proceed" \}/);
  });

  it("沙箱判据是契约而不是工具名名单（名单已删除）", () => {
    // 旧实现特征：`const readTools = [...]` / `const writeTools = [...]`
    expect(pipelineSrc).not.toMatch(/const readTools = \[/);
    expect(pipelineSrc).not.toMatch(/const allProtectedTools/);
    // 新判据：读契约的 sideEffectScope
    expect(pipelineSrc).toMatch(/contract\.sideEffectScope === "none"/);
  });

  it("幽灵名不会以「名单」形式回归（沙箱曾含 read_file / cat / find 等）", () => {
    for (const ghost of ["read_file", "list_dir", "cat", "head", "tail", "find", "delete_file"]) {
      // 允许出现在注释里（解释历史），但不允许出现在数组字面量里
      expect(
        new RegExp(`\\[\\s*[^\\]]*"${ghost}"`).test(pipelineSrc),
        `${ghost} 又出现在沙箱名单里了 —— 它不对应任何真实工具`,
      ).toBe(false);
    }
  });
});

describe("沙箱拒绝文案按读/写/删分类", () => {
  it("文案按契约三态给出动词", () => {
    expect(pipelineSrc).toContain('contract.destructive ? "Delete"');
    expect(pipelineSrc).toContain('contract.readOnly ? "Read from" : "Write to"');
  });

  it("不再存在对所有工具一律说 Write to 的旧文案", () => {
    expect(
      pipelineSrc.includes('Sandbox: Write to "${path}" is outside the workspace'),
      "旧的「一律说 Write to」文案还在 —— 读操作被拒时会告诉用户「写入被拒绝」",
    ).toBe(false);
  });

  it("文案仍是可行动的（给出原因 + 下一步）", () => {
    const idx = pipelineSrc.indexOf("Sandbox: ${verb}");
    expect(idx).toBeGreaterThan(0);
    const msg = pipelineSrc.slice(idx, idx + 260);
    expect(msg).toMatch(/outside the workspace/);
    expect(msg).toMatch(/disable it in settings|use a path within the workspace/);
  });
});

describe("沙箱覆盖没有缩水（契约驱动后仍拦住真写工具）", () => {
  it("真实写工具的 sideEffectScope 都不是 none（否则沙箱会放过它们）", () => {
    const registry = createDefaultToolRegistry();
    for (const id of ["write", "edit", "multi_edit", "bash"]) {
      const c = registry.getContract(id);
      expect(c.sideEffectScope, `${id} 不该是 none`).not.toBe("none");
    }
  });

  it("真实只读工具仍被覆盖（沙箱要拦「工作区外读取」）", () => {
    const registry = createDefaultToolRegistry();
    for (const id of ["read", "grep", "glob"]) {
      const c = registry.getContract(id);
      expect(c.sideEffectScope, `${id} 会碰工作区，沙箱应覆盖`).toBe("workspace");
    }
  });
});
