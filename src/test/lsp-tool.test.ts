/**
 * Tests for P0-1: LSP Tool
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ToolContext } from "../core/llm/tools";

// Mock file-api — factory must be self-contained (vi.mock is hoisted)
vi.mock("../core/file-api", () => {
  const mockFileContent = `import { readFile } from "fs";

export interface MyInterface {
  name: string;
  value: number;
}

export class MyClass {
  constructor(private name: string) {}

  public getName(): string {
    return this.name;
  }
}

export function myFunction(x: number): string {
  return String(x);
}

export const myConstant = 42;
`;
  return {
    readFile: vi.fn().mockResolvedValue(mockFileContent),
    grepSearch: vi.fn().mockResolvedValue([
      "src/foo.ts:5:export interface MyInterface {",
      "src/foo.ts:10:export class MyClass {",
      "src/foo.ts:18:export function myFunction(x: number): string {",
      "src/foo.ts:22:export const myConstant = 42;",
      "src/bar.ts:3:const obj = new MyClass();",
      "src/bar.ts:5:const result = myFunction(123);",
    ]),
    executeCommand: vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 }),
    writeFile: vi.fn().mockResolvedValue(undefined),
    globSearch: vi.fn().mockResolvedValue(["src/foo.ts", "src/bar.ts"]),
    isPathWithinWorkspace: vi.fn().mockReturnValue(true),
  };
});

const mockCtx: ToolContext = {
  sessionId: "test-session",
  messageId: "test-msg",
  cwd: "/test/project",
  abort: new AbortController().signal,
  messages: [],
  metadata: () => {},
};

describe("P0-1: LSP Tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should register with id 'lsp'", async () => {
    const { createLSPTool } = await import("../core/llm/tools/lsp-tool");
    const tool = createLSPTool();
    expect(tool.id).toBe("lsp");
  });

  it("should have description explaining all 5 operations", async () => {
    const { createLSPTool } = await import("../core/llm/tools/lsp-tool");
    const tool = createLSPTool();
    expect(tool.description).toContain("definition");
    expect(tool.description).toContain("references");
    expect(tool.description).toContain("hover");
    expect(tool.description).toContain("document_symbols");
    expect(tool.description).toContain("workspace_symbols");
  });

  it("should require 'operation' and 'file' parameters", async () => {
    const { createLSPTool } = await import("../core/llm/tools/lsp-tool");
    const tool = createLSPTool();
    expect(tool.parameters.required).toContain("operation");
    expect(tool.parameters.required).toContain("file");
  });

  it("should list all 5 operations in enum", async () => {
    const { createLSPTool } = await import("../core/llm/tools/lsp-tool");
    const tool = createLSPTool();
    const props = tool.parameters.properties as any;
    expect(props.operation.enum).toEqual([
      "definition",
      "references",
      "hover",
      "document_symbols",
      "workspace_symbols",
    ]);
  });

  it("should find definition of a symbol", async () => {
    const { createLSPTool } = await import("../core/llm/tools/lsp-tool");
    const tool = createLSPTool();
    const result = await tool.execute(
      { operation: "definition", file: "src/foo.ts", symbol: "MyClass" },
      mockCtx,
    );
    expect(result.title).toContain("MyClass");
    expect(result.output).toContain("class");
  });

  it("should find references to a symbol", async () => {
    const { createLSPTool } = await import("../core/llm/tools/lsp-tool");
    const tool = createLSPTool();
    const result = await tool.execute(
      { operation: "references", file: "src/foo.ts", symbol: "MyClass" },
      mockCtx,
    );
    expect(result.output).toContain("References");
    expect(result.output).toContain("MyClass");
  });

  it("should return hover info for a symbol at position", async () => {
    const { createLSPTool } = await import("../core/llm/tools/lsp-tool");
    const tool = createLSPTool();
    // Line 8 is "export class MyClass {", column 13 is at "MyClass"
    const result = await tool.execute(
      { operation: "hover", file: "src/foo.ts", line: 8, column: 13 },
      mockCtx,
    );
    expect(result.output).toContain("MyClass");
  });

  it("should extract document symbols from a file", async () => {
    const { createLSPTool } = await import("../core/llm/tools/lsp-tool");
    const tool = createLSPTool();
    const result = await tool.execute(
      { operation: "document_symbols", file: "src/foo.ts" },
      mockCtx,
    );
    expect(result.output).toContain("MyInterface");
    expect(result.output).toContain("MyClass");
    expect(result.output).toContain("myFunction");
    expect(result.output).toContain("myConstant");
  });

  it("should search workspace symbols", async () => {
    const { createLSPTool } = await import("../core/llm/tools/lsp-tool");
    const tool = createLSPTool();
    const result = await tool.execute(
      { operation: "workspace_symbols", file: "src/foo.ts", symbol: "MyClass" },
      mockCtx,
    );
    expect(result.output).toContain("MyClass");
  });

  it("should return error for unknown operation", async () => {
    const { createLSPTool } = await import("../core/llm/tools/lsp-tool");
    const tool = createLSPTool();
    const result = await tool.execute(
      { operation: "unknown_op" as any, file: "src/foo.ts" },
      mockCtx,
    );
    expect(result.output).toContain("Error");
    expect(result.output).toContain("Unknown operation");
  });

  it("should return error when hover is called without line/column", async () => {
    const { createLSPTool } = await import("../core/llm/tools/lsp-tool");
    const tool = createLSPTool();
    const result = await tool.execute(
      { operation: "hover", file: "src/foo.ts" },
      mockCtx,
    );
    expect(result.output).toContain("Error");
    expect(result.output).toContain("line and column are required");
  });

  it("should return error when workspace_symbols is called without symbol", async () => {
    const { createLSPTool } = await import("../core/llm/tools/lsp-tool");
    const tool = createLSPTool();
    const result = await tool.execute(
      { operation: "workspace_symbols", file: "src/foo.ts" },
      mockCtx,
    );
    expect(result.output).toContain("Error");
    expect(result.output).toContain("symbol is required");
  });
});
