/**
 * tool_search 的**召回判据**（P0：换个说法还能不能找到 deferred 工具）。
 *
 * 旧实现只做子串/空格分词：中文整串在英文 hint 里必然 miss；"jump to definition" 里的 "to"
 * 又会命中一堆工具。这组用例钉的是"同义说法（中/英）都能召回对应工具"。
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../core/file-api", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  executeCommand: vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 }),
  globSearch: vi.fn().mockResolvedValue([]),
  grepSearch: vi.fn().mockResolvedValue([]),
  isPathWithinWorkspace: vi.fn().mockReturnValue(true),
  exists: vi.fn().mockResolvedValue(true),
}));

import { createDefaultToolRegistry } from "../core/llm/tools";
import { createToolSearchTool } from "../core/llm/tools/tool-search";
import type { ToolContext } from "../core/llm/tools";

const ctx = {
  sessionId: "s",
  messageId: "m",
  cwd: "/tmp",
  messages: [],
  metadata: () => {},
} as unknown as ToolContext;

const cases: Array<[string, string]> = [
  ["lsp", "lsp"],
  ["代码导航", "lsp"],
  ["跳转定义", "lsp"],
  ["找引用", "lsp"],
  ["code navigation", "lsp"],
  ["jump to definition", "lsp"],
  ["document symbols", "lsp"],
  ["workflow", "workflow"],
  ["工作流", "workflow"],
  ["并行子代理", "workflow"],
  ["github", "github_tool"],
  ["拉取请求", "github_tool"],
  ["pr review", "github_tool"],
  ["figma", "figma_fetch"],
  ["设计稿", "figma_fetch"],
  ["浏览器", "browser_automate"],
  ["playwright", "browser_automate"],
  ["朗读", "tts"],
  ["tts", "tts"],
  ["生成图片", "image_gen"],
  ["ppt", "generate_ppt"],
  ["幻灯片", "generate_ppt"],
];

describe("TOOLSEARCH-RECALL：同义说法能召回对应工具", () => {
  it.each(cases)("query=%s → %s", async (query, expected) => {
    const tool = createToolSearchTool(createDefaultToolRegistry());
    const result = await tool.execute({ query }, ctx);
    expect(result.output, `没召回 ${expected}：${query}`).toContain(expected);
    expect(result.output, `被当成"无匹配"了：${query}`).not.toContain("No deferred tool matched");
  });

  it("无匹配时仍然列出全部 deferred（不能只报错了事）", async () => {
    const tool = createToolSearchTool(createDefaultToolRegistry());
    const result = await tool.execute({ query: "nonexistent_tool" }, ctx);
    expect(result.output).toContain("No deferred tool matched");
    expect(result.output).toContain("lsp");
    expect(result.output).toContain("workflow");
  });
});
