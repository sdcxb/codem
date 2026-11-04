/**
 * DOCI-7：`read` 对二进制文档**结构化重定向**。
 *
 * 现状（1.18.5）：`read` 对 .docx/.pdf 走 UTF-8 行读，要么报「非 UTF-8」，
 * 要么给出替换字符 —— 模型据此会说「文件坏了/是空的」。重定向要把模型送到
 * doc_outline/doc_search/doc_read，并带上集合 id，省掉一次瞎猜。
 */
import { describe, expect, it } from "vitest";
import type { ToolContext } from "../core/llm/tools";
import { createReadFileTool } from "../core/llm/tools";

function ctx(): ToolContext {
  return {
    sessionId: "s1",
    messageId: "m1",
    cwd: "C:\\project",
    abort: new AbortController().signal,
    messages: [],
    metadata: () => {},
  } as unknown as ToolContext;
}

describe("DOCI-7 read 重定向", () => {
  for (const ext of ["docx", "pdf", "xlsx", "pptx", "doc", "xls", "ppt"]) {
    it(`read("a.${ext}") 返回文档工具重定向（不吐二进制）`, async () => {
      const tool = createReadFileTool();
      const res = await tool.execute({ path: `C:\\project\\a.${ext}` }, ctx());
      expect(res.isError).toBe(false);
      expect((res.metadata as any)?.redirect).toBe("document");
      expect((res.metadata as any)?.documentExt).toBe(ext);
      expect(res.output).toContain("doc_outline");
      expect(res.output).toContain("doc_search");
      expect(res.output).toContain("collection_id");
      // 不能出现「这是空文件/坏文件」这类会让模型下假结论的说法
      expect(res.output).not.toContain("文件为空");
      expect(res.output).not.toContain("非 UTF-8");
    });
  }

  it("文本文件（.md）不被重定向（走正常读取路径）", async () => {
    const tool = createReadFileTool();
    const res = await tool.execute({ path: "C:\\project\\readme.md" }, ctx());
    expect((res.metadata as any)?.redirect).toBeUndefined();
  });

  it("重定向消息里带当前集合提示（项目/会话级）", async () => {
    const tool = createReadFileTool();
    const res = await tool.execute({ path: "C:\\project\\a.docx" }, ctx());
    expect((res.metadata as any)?.collectionId).toMatch(/^session:s1$/);
  });
});
