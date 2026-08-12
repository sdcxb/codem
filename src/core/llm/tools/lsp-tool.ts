/**
 * LSP Tool — Language Server Protocol 风格的代码导航工具
 *
 * 设计决策（来自 CLAUDE-CODE-IMPACT-ANALYSIS.md）：
 *
 * 1. 无状态设计：每次查询通过 executeCommand 调用一次性脚本，
 *    不需要长驻子进程。这避免了 Tauri 的 stdin/stdout 限制。
 *
 * 2. 通用语言支持：使用正则模式匹配，支持所有编程语言。
 *    对 TypeScript/JavaScript 有增强的模式识别。
 *
 * 3. 与 codebase_search 的区别：
 *    - codebase_search: 语义搜索（基于 CodeGraph）
 *    - lsp: 精确符号导航（定义跳转、引用查找、类型信息）
 *
 * 4. 结果大小受 P1-5 工具结果持久化保护：find_references 在大型
 *    项目中可能返回上百个引用，超过 50KB 会自动持久化到磁盘。
 */

import type { ToolDef, ToolContext, ToolExecuteResult } from "../tools";
import { grepSearch, executeCommand } from "../../file-api";

// ========== Types ==========

type LSPOperation =
  | "definition"
  | "references"
  | "hover"
  | "document_symbols"
  | "workspace_symbols";

interface LSPParams {
  operation: LSPOperation;
  /** 目标文件路径 */
  file: string;
  /** 行号 (1-indexed) — definition/references/hover 需要 */
  line?: number;
  /** 列号 (0-indexed) — definition/references/hover 需要 */
  column?: number;
  /** 符号名称 — workspace_symbols 需要 */
  symbol?: string;
  /** 搜索路径 — workspace_symbols 需要，默认 cwd */
  path?: string;
}

// ========== Symbol Patterns ==========

/**
 * Symbol declaration patterns for various languages.
 * Each pattern captures the symbol name from declarations.
 */
const DECLARATION_PATTERNS: Array<{ regex: RegExp; group: string }> = [
  // TypeScript/JavaScript: function, class, interface, type, const, let, var, enum
  { regex: /(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+(\w+)/g, group: "function" },
  { regex: /(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/g, group: "class" },
  { regex: /(?:export\s+)?interface\s+(\w+)/g, group: "interface" },
  { regex: /(?:export\s+)?type\s+(\w+)\s*[=<]/g, group: "type" },
  { regex: /(?:export\s+)?(?:const|let|var)\s+(\w+)\s*[:=]/g, group: "variable" },
  { regex: /(?:export\s+)?enum\s+(\w+)/g, group: "enum" },
  // Python: def, class
  { regex: /(?:async\s+)?def\s+(\w+)\s*\(/g, group: "function" },
  { regex: /class\s+(\w+)\s*[\(:]/g, group: "class" },
  // Rust: fn, struct, enum, trait, impl
  { regex: /(?:pub\s+)?(?:async\s+)?fn\s+(\w+)\s*[\(<]/g, group: "function" },
  { regex: /(?:pub\s+)?struct\s+(\w+)/g, group: "struct" },
  { regex: /(?:pub\s+)?enum\s+(\w+)/g, group: "enum" },
  { regex: /(?:pub\s+)?trait\s+(\w+)/g, group: "trait" },
  // Go: func, type, struct
  { regex: /func\s+(?:\([^)]*\)\s+)?(\w+)\s*\(/g, group: "function" },
  { regex: /type\s+(\w+)\s+(?:struct|interface)/g, group: "type" },
  // Java/C#: method, class
  { regex: /(?:public|private|protected|static)\s+.*?\s+(\w+)\s*\([^)]*\)\s*\{/g, group: "method" },
  { regex: /(?:public|abstract)\s+class\s+(\w+)/g, group: "class" },
];

// ========== Core Logic ==========

/**
 * Extract the word at a specific position in a line.
 */
function getWordAtPosition(line: string, column: number): string {
  const before = line.substring(0, column);
  const after = line.substring(column);
  const wordStart = before.search(/[\w$]+$/);
  const wordEnd = after.search(/[^\w$]/);
  const start = wordStart === -1 ? column : before.length - (before.length - wordStart);
  const end = wordEnd === -1 ? line.length : column + wordEnd;
  return line.substring(start, end);
}

/**
 * Find the definition of a symbol by searching for its declaration pattern.
 * Uses grep to find declaration patterns across the workspace.
 */
async function findDefinition(
  symbol: string,
  searchPath: string,
): Promise<string> {
  // Build grep patterns for the symbol as a declaration
  const patterns = [
    `function\\s+${escapeRegex(symbol)}\\b`,
    `class\\s+${escapeRegex(symbol)}\\b`,
    `interface\\s+${escapeRegex(symbol)}\\b`,
    `type\\s+${escapeRegex(symbol)}\\b`,
    `(?:const|let|var)\\s+${escapeRegex(symbol)}\\b`,
    `enum\\s+${escapeRegex(symbol)}\\b`,
    `def\\s+${escapeRegex(symbol)}\\b`,
    `fn\\s+${escapeRegex(symbol)}\\b`,
    `struct\\s+${escapeRegex(symbol)}\\b`,
    `trait\\s+${escapeRegex(symbol)}\\b`,
  ];
  const combinedPattern = patterns.join("|");

  try {
    const results = await grepSearch(combinedPattern, searchPath, undefined);
    if (results.length === 0) {
      return `No definition found for "${symbol}" in ${searchPath}`;
    }
    // Format results with file:line references
    const formatted = results.slice(0, 20).map(r => {
      // grep results are in format "file:line:content"
      const match = r.match(/^(.+?):(\d+):\s*(.*)$/);
      if (match) {
        const [, file, lineNum, content] = match;
        return `  ${file}:${lineNum}\n    ${content.trim()}`;
      }
      return `  ${r}`;
    });
    return `Definition of "${symbol}" (${results.length} match${results.length > 1 ? "es" : ""}):\n${formatted.join("\n")}`;
  } catch (error: any) {
    return `Error searching for definition: ${error.message}`;
  }
}

/**
 * Find all references to a symbol using grep.
 */
async function findReferences(
  symbol: string,
  searchPath: string,
): Promise<string> {
  try {
    // Use word boundary matching for accurate reference finding
    const pattern = `\\b${escapeRegex(symbol)}\\b`;
    const results = await grepSearch(pattern, searchPath, undefined);
    if (results.length === 0) {
      return `No references found for "${symbol}" in ${searchPath}`;
    }
    const formatted = results.slice(0, 50).map(r => {
      const match = r.match(/^(.+?):(\d+):\s*(.*)$/);
      if (match) {
        const [, file, lineNum, content] = match;
        return `  ${file}:${lineNum}: ${content.trim().substring(0, 120)}`;
      }
      return `  ${r}`;
    });
    const truncated = results.length > 50 ? `\n... and ${results.length - 50} more` : "";
    return `References to "${symbol}" (${results.length} total):\n${formatted.join("\n")}${truncated}`;
  } catch (error: any) {
    return `Error searching for references: ${error.message}`;
  }
}

/**
 * Get hover information (type signature) for a symbol at a position.
 */
async function getHover(
  file: string,
  line: number,
  column: number,
  content: string,
): Promise<string> {
  const lines = content.split("\n");
  const targetLine = lines[line - 1] || "";
  const symbol = getWordAtPosition(targetLine, column);

  if (!symbol) {
    return `No symbol found at ${file}:${line}:${column}`;
  }

  // Look for the declaration of this symbol in the same file
  const declPatterns = DECLARATION_PATTERNS.map(p => p.regex);
  for (let i = 0; i < lines.length; i++) {
    for (const pattern of declPatterns) {
      pattern.lastIndex = 0;
      const match = pattern.exec(lines[i]);
      if (match && match[1] === symbol) {
        // Return the declaration line and a few lines after for context
        const contextEnd = Math.min(lines.length, i + 4);
        const context = lines.slice(i, contextEnd).join("\n");
        return `Symbol: ${symbol}\nLocation: ${file}:${i + 1}\nDeclaration:\n${context}`;
      }
    }
  }

  // If not found in file, search workspace
  const defResult = await findDefinition(symbol, file.substring(0, file.lastIndexOf(/[\\/]/.test(file) ? /[\\/]/ : "/")));
  return defResult;
}

/**
 * Extract document symbols (declarations) from a file.
 */
function extractDocumentSymbols(content: string, filePath: string): string {
  const lines = content.split("\n");
  const symbols: Array<{ name: string; type: string; line: number; preview: string }> = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const { regex, group } of DECLARATION_PATTERNS) {
      regex.lastIndex = 0;
      const match = regex.exec(line);
      if (match) {
        const name = match[1];
        // Avoid duplicates
        if (!symbols.some(s => s.name === name && s.line === i + 1)) {
          symbols.push({
            name,
            type: group,
            line: i + 1,
            preview: line.trim().substring(0, 100),
          });
        }
      }
    }
  }

  if (symbols.length === 0) {
    return `No symbols found in ${filePath}`;
  }

  const formatted = symbols.map(s =>
    `  ${s.type.padEnd(10)} ${s.name.padEnd(30)} ${filePath}:${s.line}\n    ${s.preview}`,
  );
  return `Document symbols in ${filePath} (${symbols.length}):\n${formatted.join("\n")}`;
}

/**
 * Search for symbols across the workspace.
 */
async function searchWorkspaceSymbols(
  symbol: string,
  searchPath: string,
): Promise<string> {
  return findDefinition(symbol, searchPath);
}

// ========== Utility ==========

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ========== Tool Definition ==========

export function createLSPTool(): ToolDef {
  return {
    id: "lsp",
    // P0-2: LSP is a deferred tool — its full schema is large (~400 tokens).
    // The LLM gets a compact searchHint instead, and must call tool_search("lsp")
    // to retrieve the full schema before using it.
    shouldDefer: true,
    searchHint:
      "Code navigation: find definitions, references, hover info, and document symbols. " +
      "Use when you need precise code structure understanding (better than grep for declarations). " +
      "Search for this tool when you need to jump to definitions or find all references of a symbol.",
    description:
      "Language Server Protocol tool for code navigation. Supports 5 operations:\n" +
      "1. definition — Find where a symbol is declared (jump to definition)\n" +
      "2. references — Find all references to a symbol (find usages)\n" +
      "3. hover — Get type/signature info for a symbol at a position\n" +
      "4. document_symbols — List all declarations in a file (outline view)\n" +
      "5. workspace_symbols — Search for symbol declarations across the project\n\n" +
      "Use this tool when you need to understand code structure, find definitions, or locate usages. " +
      "More precise than grep for code navigation because it understands declaration syntax.",
    parameters: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          description: "LSP operation: definition, references, hover, document_symbols, or workspace_symbols",
          enum: ["definition", "references", "hover", "document_symbols", "workspace_symbols"],
        },
        file: {
          type: "string",
          description: "Target file path (required for definition, references, hover, document_symbols)",
        },
        line: {
          type: "number",
          description: "Line number (1-indexed). Required for hover. For definition/references, the symbol at this line is used.",
        },
        column: {
          type: "number",
          description: "Column number (0-indexed). Required for hover. For definition/references, the symbol at this position is used.",
        },
        symbol: {
          type: "string",
          description: "Symbol name to search for. Required for workspace_symbols. For definition/references, if not provided, the symbol at file:line:column is used.",
        },
        path: {
          type: "string",
          description: "Search directory for workspace_symbols. Defaults to current working directory.",
        },
      },
      required: ["operation", "file"],
    },
    async execute(args, ctx): Promise<ToolExecuteResult> {
      const operation = args.operation as LSPOperation;
      const file = args.file as string;
      const line = args.line as number | undefined;
      const column = args.column as number | undefined;
      const symbol = args.symbol as string | undefined;
      const searchPath = (args.path as string) || ctx.cwd;

      try {
        switch (operation) {
          case "definition": {
            let targetSymbol = symbol;
            if (!targetSymbol && line !== undefined && column !== undefined) {
              // Read the file and extract the symbol at the position
              const { readFile } = await import("../../file-api");
              const content = await readFile(file);
              const lines = content.split("\n");
              const targetLine = lines[line - 1] || "";
              targetSymbol = getWordAtPosition(targetLine, column);
            }
            if (!targetSymbol) {
              return { title: `lsp: definition`, output: "Error: symbol is required (either provide 'symbol' or 'line'+'column')" };
            }
            const result = await findDefinition(targetSymbol, searchPath);
            return { title: `lsp: definition "${targetSymbol}"`, output: result };
          }

          case "references": {
            let targetSymbol = symbol;
            if (!targetSymbol && line !== undefined && column !== undefined) {
              const { readFile } = await import("../../file-api");
              const content = await readFile(file);
              const lines = content.split("\n");
              const targetLine = lines[line - 1] || "";
              targetSymbol = getWordAtPosition(targetLine, column);
            }
            if (!targetSymbol) {
              return { title: `lsp: references`, output: "Error: symbol is required (either provide 'symbol' or 'line'+'column')" };
            }
            const result = await findReferences(targetSymbol, searchPath);
            return { title: `lsp: references "${targetSymbol}"`, output: result };
          }

          case "hover": {
            if (line === undefined || column === undefined) {
              return { title: `lsp: hover`, output: "Error: line and column are required for hover operation" };
            }
            const { readFile } = await import("../../file-api");
            const content = await readFile(file);
            const result = await getHover(file, line, column, content);
            return { title: `lsp: hover ${file}:${line}:${column}`, output: result };
          }

          case "document_symbols": {
            const { readFile } = await import("../../file-api");
            const content = await readFile(file);
            const result = extractDocumentSymbols(content, file);
            return { title: `lsp: symbols ${file}`, output: result };
          }

          case "workspace_symbols": {
            if (!symbol) {
              return { title: `lsp: workspace_symbols`, output: "Error: symbol is required for workspace_symbols operation" };
            }
            const result = await searchWorkspaceSymbols(symbol, searchPath);
            return { title: `lsp: search "${symbol}"`, output: result };
          }

          default:
            return { title: `lsp`, output: `Error: Unknown operation "${operation}". Supported: definition, references, hover, document_symbols, workspace_symbols` };
        }
      } catch (error: any) {
        return { title: `lsp: ${operation}`, output: `Error: ${error.message}` };
      }
    },
  };
}
