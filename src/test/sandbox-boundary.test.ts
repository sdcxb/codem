/**
 * 门禁：`SandboxGuard` 的工具名单与拒绝文案。
 *
 * ## 这个文件存在的两个理由
 *
 * ### 1. `read_attachment` **按设计不在沙箱范围内**（产品决策，别再"顺手补上"）
 *
 * 决策：**附件不算沙箱范围。** 原因有两条，任何一条都足以否决「把
 * `read_attachment` 加进 `readTools`」：
 *
 * - **技术上加了也不生效**：守卫靠 `args.path || args.file_path` 取路径，
 *   而 `read_attachment` 的参数只有 `attachment_id` / `name` / `offset` / `limit`
 *   （`read-attachment.ts:146-156`），没有 path ⇒ 守卫在「取不到 path 就 proceed」
 *   那一步已经返回了。加一行不生效的代码只会让人以为它受保护。
 * - **产品上不该生效**：附件按设计就住在**工作区之外**
 *   （`read-attachment.ts:248-261`：`sandboxPath` 相对工作区解析，否则用
 *   `target.path` 这个绝对路径，在 app data / 用户目录里）。把附件纳入
 *   「必须在工作区内」的判定，结果不是更安全，而是**附件一律读不了**。
 *   附件是用户主动挂上来的，不是 agent 自己找的文件，不属沙箱要防的东西。
 *
 * 所以本门禁**反向**断言：`read_attachment` 不得出现在沙箱名单里。
 * 如果将来真要覆盖它，必须先改守卫的取路径方式（解析 attachment_id → 磁盘路径），
 * 并同时改这条断言 —— 那时会有意识地做，而不是"顺手加个名字"。
 *
 * ### 2. 拒绝文案必须按读/写说对
 *
 * 原文案对**所有**工具都说 `Write to ...`，于是「读操作被沙箱拒绝」时
 * 用户看到「写入被拒绝」，排查方向被带偏。这是一个纯文案 bug，
 * 由 SandboxGuard 的实现直接断言。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PIPELINE = join(__dirname, "..", "core", "llm", "tool-pipeline.ts");
const src = readFileSync(PIPELINE, "utf8");

/** 取出 SandboxGuard.execute 里那两个工具名单的字面量。 */
function sandboxToolLists(): { writeTools: string[]; readTools: string[] } {
  // 限定在 SandboxGuard 类体内，避免匹配到别的中间件的同名变量
  const start = src.indexOf("class SandboxGuard");
  expect(start, "找不到 SandboxGuard").toBeGreaterThan(0);
  const body = src.slice(start, start + 4000);

  const grab = (name: string): string[] => {
    const m = body.match(new RegExp(`const ${name} = \\[([^\\]]*)\\]`));
    if (!m) return [];
    return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
  };
  return { writeTools: grab("writeTools"), readTools: grab("readTools") };
}

describe("沙箱边界：附件按设计不受沙箱约束", () => {
  it("read_attachment 不在沙箱工具名单里（这是产品决策，不是遗漏）", () => {
    const { writeTools, readTools } = sandboxToolLists();
    expect(writeTools.length).toBeGreaterThan(0);
    expect(readTools.length).toBeGreaterThan(0);
    // 反向断言：两个名单都不许含它
    expect(
      [...writeTools, ...readTools],
      "read_attachment 被加进沙箱名单了 —— 它的参数里没有 path，加了也不生效，" +
        "而且附件按设计住在工作区之外，纳入沙箱会让附件一律读不了。" +
        "若要真的覆盖它，先改守卫的取路径方式并同步改本断言。",
    ).not.toContain("read_attachment");
  });

  it("read_attachment 的入参确实没有 path / file_path（说明「加了也不生效」）", () => {
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

  it("守卫取不到 path 时确实会放行（这是「加了也不生效」的机制）", () => {
    // `const path = (args.path || args.file_path) as string; if (!path) return proceed`
    expect(src).toMatch(/const path = \(args\.path \|\| args\.file_path\)/);
    expect(src).toMatch(/if \(!path\) return \{ action: "proceed" \}/);
  });

  it("写工具与读工具都在名单里（沙箱本身没有缩水）", () => {
    const { writeTools, readTools } = sandboxToolLists();
    for (const w of ["write", "edit", "multi_edit"]) {
      expect(writeTools, `${w} 应当在写工具名单`).toContain(w);
    }
    for (const r of ["read", "grep", "glob"]) {
      expect(readTools, `${r} 应当在读工具名单`).toContain(r);
    }
  });
});

describe("沙箱拒绝文案按读/写分类", () => {
  it("写工具说 Write to", () => {
    expect(src).toContain('writeTools.includes(toolName) ? "Write to" : "Read from"');
  });

  it("删除说明确说 Delete", () => {
    expect(src).toContain('toolName === "delete_file" ? "Delete"');
  });

  it("不再存在对所有工具一律说 Write to 的旧文案", () => {
    expect(
      src.includes('Sandbox: Write to "${path}" is outside the workspace'),
      "旧的「一律说 Write to」文案还在 —— 读操作被拒时会告诉用户「写入被拒绝」",
    ).toBe(false);
  });

  it("文案仍是可行动的（给出原因 + 下一步）", () => {
    const idx = src.indexOf("Sandbox: ${verb}");
    expect(idx).toBeGreaterThan(0);
    const msg = src.slice(idx, idx + 260);
    expect(msg).toMatch(/outside the workspace/);
    expect(msg).toMatch(/disable it in settings|use a path within the workspace/);
  });
});
