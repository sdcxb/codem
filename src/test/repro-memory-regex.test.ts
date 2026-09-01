/**
 * 回归测试：memory.search 使用含正则元字符的查询词不应抛 SyntaxError
 *
 * 用户日志：
 *   [extractMemories] Failed to extract memories: SyntaxError: Invalid regular
 *   expression: /+/g: Nothing to repeat
 *   at new RegExp(<anonymous>) ... at zwe.search
 *
 * 根因（memory.ts search）：对查询分词直接 new RegExp(term, "g")，
 * 若 term 含 "+"、"*"、"(" 等元字符（例如提取出的记忆内容片段），
 * 构造正则时抛 SyntaxError，导致记忆提取/搜索整体失败。
 *
 * 修复：先对 term 转义正则元字符再构造 RegExp。
 */
import { describe, it, expect } from "vitest";

import { MemoryService } from "../core/memory/memory";

function makeService(): MemoryService {
  const svc = new MemoryService();
  (svc as any).entries = new Map([
    ["k1", { id: "k1", key: "k1", content: "项目使用 C++ 与 CMake，依赖 + 号路径", scope: "project", timestamp: 1 }],
    ["k2", { id: "k2", key: "k2", content: "正则表达式 (a+b)* 是危险的", scope: "project", timestamp: 2 }],
  ]);
  return svc;
}

describe("memory.search: 查询含正则元字符不应抛错", () => {
  it("REG-001: 查询词含 + 号 → 正常返回结果，不抛 SyntaxError", () => {
    const svc = makeService();
    expect(() => svc.search("C++ +", "project", 10)).not.toThrow();
    const results = svc.search("C++", "project", 10);
    expect(results.length).toBeGreaterThan(0);
  });

  it("REG-002: 查询词含括号/星号 → 不抛错", () => {
    const svc = makeService();
    expect(() => svc.search("(a+b)* 正则", "project", 10)).not.toThrow();
    const results = svc.search("(a+b)*", "project", 10);
    expect(results.length).toBeGreaterThan(0);
  });

  it("REG-003: 普通查询不受影响", () => {
    const svc = makeService();
    const results = svc.search("CMake", "project", 10);
    expect(results.length).toBeGreaterThan(0);
  });
});
