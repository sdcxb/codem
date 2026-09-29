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
 * ## 第 120/121 轮：判据从「名单」→「契约」→「命名谓词」
 *
 * 本文件原来断言的是「`read_attachment` 不在那两份硬编码名单里」；第 120 轮改成
 * 验契约；第 121 轮把「访问边界」从 `sideEffectScope` 拆成独立的 `accessScope`，
 * 于是沙箱的判据变成谓词 `requiresPathGuard(contract)`。
 *
 * 断言也一路跟着变强：验名单只说明「这个守卫会不会管」；
 * 验契约/谓词还能说明「为什么它判不了」与「判据是哪个概念」。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createDefaultToolRegistry } from "../core/llm/tools";
import { requiresPathGuard } from "../core/llm/tool-contract";

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

  it("沙箱判据是命名谓词而不是工具名名单（名单已删除）", () => {
    // 旧实现特征：`const readTools = [...]` / `const writeTools = [...]`
    expect(pipelineSrc).not.toMatch(/const readTools = \[/);
    expect(pipelineSrc).not.toMatch(/const allProtectedTools/);
    // 第 121 轮：读的是谓词（它内部读 `accessScope`，不是 `sideEffectScope`）
    expect(pipelineSrc).toMatch(/requiresPathGuard\(contract\)/);
  });

  it("谓词读的是 accessScope（访问边界），不是 sideEffectScope（改了什么）", () => {
    // 这条是拆字段的**核心断言**：两者混用时沙箱完全没有区分能力
    // （实测 51 个工具里 sideEffectScope === "none" 的有 0 个）。
    expect(requiresPathGuard({ accessScope: "workspace" } as never)).toBe(true);
    expect(requiresPathGuard({ accessScope: "none" } as never)).toBe(false);
    // 只读工具属于「无副作用但访问工作区」—— 沙箱**必须**覆盖
    const registry = createDefaultToolRegistry();
    const read = registry.getContract("read");
    expect(read.sideEffectScope).toBe("none");
    expect(read.accessScope).toBe("workspace");
    expect(requiresPathGuard(read)).toBe(true);
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
    expect(pipelineSrc).toContain('allowedInReadOnlyMode(contract) ? "Read from" : "Write to"');
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
  it("真实写工具都受沙箱路径检查（accessScope != none）", () => {
    const registry = createDefaultToolRegistry();
    for (const id of ["write", "edit", "multi_edit", "bash"]) {
      const c = registry.getContract(id);
      expect(c.accessScope, `${id} 不该是 none`).not.toBe("none");
      expect(requiresPathGuard(c), `${id} 应受路径检查`).toBe(true);
    }
  });

  it("真实只读工具仍被覆盖（沙箱要拦「工作区外读取」）", () => {
    const registry = createDefaultToolRegistry();
    for (const id of ["read", "grep", "glob"]) {
      const c = registry.getContract(id);
      // 只读 ⇒ 副作用是 none（它不改任何东西）
      expect(c.sideEffectScope, `${id} 是只读，不该有副作用`).toBe("none");
      // 但它**访问**工作区 ⇒ 沙箱要覆盖它
      expect(c.accessScope, `${id} 会访问工作区`).toBe("workspace");
      expect(requiresPathGuard(c), `${id} 应受路径检查`).toBe(true);
    }
  });
});
