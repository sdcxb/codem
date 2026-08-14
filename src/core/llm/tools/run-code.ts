/**
 * run_code 工具 — TypeScript 代码执行
 *
 * Design (对标 DeepSeek Harness run_code):
 * - 在隔离的环境中执行 TypeScript 代码
 * - 代码可以通过 sdk 对象调用其他工具 (bash, read, write 等)
 * - 超时保护防止无限循环
 * - 结果以 stdout/stderr 形式返回
 */

import type { ToolDef, ToolContext, ToolExecuteResult } from "../tools";

// ========== Tool SDK (available inside run_code) ==========

export interface ToolSDK {
  /** Execute a bash command */
  bash(command: string, opts?: { timeout_ms?: number }): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  /** Read a file */
  read(path: string): Promise<string>;
  /** Write a file */
  write(path: string, content: string): Promise<void>;
  /** Search files by glob */
  glob(pattern: string, path?: string): Promise<string[]>;
  /** Grep search */
  grep(pattern: string, opts?: { path?: string; glob?: string }): Promise<Array<{ file: string; line: number; content: string }>>;
  /** Fetch a URL */
  fetch(url: string): Promise<string>;
}

// ========== Code Execution ==========

export async function executeCode(
  code: string,
  sdk: ToolSDK,
  timeoutMs: number = 30_000,
): Promise<{ stdout: string; stderr: string; error?: string }> {
  let stdout = "";
  let stderr = "";

  const consoleProxy = {
    log: (...args: any[]) => {
      stdout += args.map(a => typeof a === "string" ? a : JSON.stringify(a, null, 2)).join(" ") + "\n";
    },
    error: (...args: any[]) => {
      stderr += args.map(a => typeof a === "string" ? a : JSON.stringify(a, null, 2)).join(" ") + "\n";
    },
    warn: (...args: any[]) => {
      stderr += args.map(a => typeof a === "string" ? a : JSON.stringify(a, null, 2)).join(" ") + "\n";
    },
    info: (...args: any[]) => {
      stdout += args.map(a => typeof a === "string" ? a : JSON.stringify(a, null, 2)).join(" ") + "\n";
    },
  };

  const wrappedCode = `
    return (async () => {
      ${code}
    })();
  `;

  try {
    const fn = new Function("sdk", "console", "Promise", "JSON", "Math", "Date", "Array", "Object", "String", "Number", "Boolean", "RegExp", "Map", "Set", "Error", wrappedCode);

    const result = await Promise.race([
      fn(sdk, consoleProxy, Promise, JSON, Math, Date, Array, Object, String, Number, Boolean, RegExp, Map, Set, Error),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Code execution timed out after ${timeoutMs}ms`)), timeoutMs),
      ),
    ]);

    if (result !== undefined) {
      stdout += `\n[Result]: ${typeof result === "string" ? result : JSON.stringify(result, null, 2)}`;
    }

    return { stdout, stderr };
  } catch (err: any) {
    return {
      stdout,
      stderr,
      error: err.message || String(err),
    };
  }
}

// ========== Tool Definition ==========

export function createRunCodeTool(): ToolDef {
  return {
    id: "run_code",
    description: `Execute TypeScript code in a sandboxed environment. The code can use the \`sdk\` object to call other tools:
- sdk.bash(command) — execute a shell command
- sdk.read(path) — read a file
- sdk.write(path, content) — write a file
- sdk.glob(pattern) — search for files
- sdk.grep(pattern) — search file contents
- sdk.fetch(url) — fetch a URL

The code runs in an async context, so you can use \`await\`. Use \`console.log()\` for output.
Timeout: 30 seconds.`,
    parameters: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description: "TypeScript code to execute. Must be valid TS/JS. Use `await` for async operations. Use `sdk` object for tool access.",
        },
        timeout_ms: {
          type: "number",
          description: "Execution timeout in milliseconds (default: 30000, max: 120000)",
        },
      },
      required: ["code"],
    },
    async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolExecuteResult> {
      const code = args.code as string;
      const timeoutMs = Math.min(args.timeout_ms as number || 30_000, 120_000);

      if (!code || code.trim().length === 0) {
        return {
          title: "run_code",
          output: "Error: code parameter is required and must not be empty.",
        };
      }

      const sdk: ToolSDK = {
        async bash(command: string, opts?: { timeout_ms?: number }) {
          const { executeCommand } = await import("../../file-api");
          const result = await executeCommand(command, ctx.cwd);
          return {
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: result.exitCode ?? 0,
          };
        },
        async read(path: string) {
          const { readFile } = await import("../../file-api");
          return await readFile(path);
        },
        async write(path: string, content: string) {
          const { writeFile } = await import("../../file-api");
          await writeFile(path, content, { workspace: ctx.cwd });
        },
        async glob(pattern: string, path?: string) {
          const { globSearch } = await import("../../file-api");
          return await globSearch(pattern, path || ctx.cwd);
        },
        async grep(pattern: string, opts?: { path?: string; glob?: string }) {
          const { grepSearch } = await import("../../file-api");
          const results = await grepSearch(pattern, opts?.path || ctx.cwd, opts?.glob);
          return results.map(r => ({ file: r, line: 0, content: r }));
        },
        async fetch(url: string) {
          const response = await fetch(url);
          return await response.text();
        },
      };

      try {
        const result = await executeCode(code, sdk, timeoutMs);

        let output = "";
        if (result.stdout) output += result.stdout;
        if (result.stderr) output += "\n[stderr]:\n" + result.stderr;
        if (result.error) output += "\n[error]: " + result.error;

        return {
          title: "run_code",
          output: output || "(no output)",
        };
      } catch (err: any) {
        return {
          title: "run_code",
          output: "Error: " + err.message,
        };
      }
    },
  };
}
