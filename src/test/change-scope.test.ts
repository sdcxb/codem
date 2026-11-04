import { describe, expect, it } from "vitest";
import {
  classifyChangePath,
  classifyChangeText,
  looksLikeDocumentTask,
  requiresCodeVerification,
} from "../core/llm/change-scope";

describe("CHANGE-SCOPE：按改动对象决定是否要求代码验证", () => {
  it("明确文档路径不要求测试/构建；明确代码路径要求", () => {
    expect(classifyChangePath("D:/任务/方案.docx")).toBe("document");
    expect(classifyChangePath("D:/任务/方案.md")).toBe("document");
    expect(classifyChangePath("src/core/llm/agentic-loop.ts")).toBe("code");
    expect(classifyChangePath("src-tauri/Cargo.toml")).toBe("code");
    expect(classifyChangePath("D:/任务/无扩展名")).toBe("unknown");
  });

  it("文本分类能识别命令里的 docx 与代码路径", () => {
    expect(classifyChangeText("python build_doc.py --out 方案.docx")).toEqual({
      code: true,
      document: true,
    });
    expect(classifyChangeText("python build_doc.py")).toEqual({ code: true, document: false });
  });

  it("文档任务描述只在没有明确路径时兜底，且不被代码词误判", () => {
    expect(looksLikeDocumentTask("写一份任务三实施方案文档，按章节整理")).toBe(true);
    expect(looksLikeDocumentTask("把材料整理成 docx 文档")).toBe(true);
    expect(looksLikeDocumentTask("修复文档生成脚本的 bug")).toBe(false);
    expect(looksLikeDocumentTask("修掉 TypeScript 类型错误")).toBe(false);
  });

  it("收尾判定：文档-only 不要求；代码/混合/未知默认要求", () => {
    expect(
      requiresCodeVerification({
        touchedCode: false,
        touchedDocument: true,
        touchedUnknown: false,
        userMessage: "写文档",
      }),
    ).toBe(false);
    expect(
      requiresCodeVerification({
        touchedCode: true,
        touchedDocument: true,
        touchedUnknown: false,
        userMessage: "写文档",
      }),
    ).toBe(true);
    expect(
      requiresCodeVerification({
        touchedCode: false,
        touchedDocument: false,
        touchedUnknown: true,
        userMessage: "写一份 docx 方案",
      }),
    ).toBe(false);
    expect(
      requiresCodeVerification({
        touchedCode: false,
        touchedDocument: false,
        touchedUnknown: true,
        userMessage: "修掉登录接口的 bug",
      }),
    ).toBe(true);
  });
});
