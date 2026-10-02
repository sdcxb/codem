/**
 * run_code 工具 — TypeScript 代码执行
 *
 * Design (对标 DeepSeek Harness run_code):
 * - 代码在**应用进程内**执行（`new Function`），拥有应用自身权限 —— **不是**安全沙箱
 * - 代码可以通过 sdk 对象调用其他工具 (bash, read, write 等)
 * - 嵌套调用**与直接调用同一个工具受同一道闸门**（见下方「权限对齐」）
 * - 超时保护防止无限循环
 * - 结果以 stdout/stderr 形式返回
 *
 * ## 权限对齐（本次修复的核心）
 *
 * 修复前这里是**闸门旁路**：`sdk.bash` 直接 `executeCommand(...)`、
 * `sdk.write` 直接 `writeFile(...)`，从不经过 `analyzeBashCommand`
 * （`src/core/permission/bash-analyzer.ts:201`）与 `write` 工具的覆盖确认
 * （`src/core/llm/tools.ts:1400-1460`）。于是模型可以把
 * `Remove-Item -Recurse -Force ...` 包在 `run_code` 里执行 —— 而 `run_code`
 * 本身在 `isAutoApprovable`（`src/core/permission/security-mode.ts:149-184`）下
 * 恒为「可自动放行」，比 `bash` 还宽松。
 *
 * 现在：`sdk.bash` 执行前先分类；`dangerous` **一律拒绝执行**（fail-closed，
 * 分析器抛错同样拒绝）；`sdk.write` 覆盖已有文件时走与 `write` 相同的确认路径。
 *
 * 仍未解决的（如实记录）：执行本身仍是进程内 `new Function`，
 * 全局对象白名单**不是**安全边界，本文件不再声称它是。
 */

import type { ToolDef, ToolContext, ToolExecuteResult } from "../tools";
/**
 * 闸门（危险命令 / 受保护路径 / 覆盖确认）已抽到 `../tool-gates`，与
 * `workflow-engine.ts` **共用同一份实现**（原来这里是本地私有副本，
 * 而 workflow 侧根本没有闸门 —— 见 `tool-gates.ts` 的文件头）。
 *
 * `calculateContentSimilarity` / `OVERWRITE_SIMILARITY_THRESHOLD` 从本文件
 * **重新导出**：`pi-p2-run-code-permission-parity.test.ts` 直接从 `run-code.ts`
 * 引它来钉住算法，保持该测试一字不改。
 */
import {
  confirmWriteIfNeeded,
  refuseDangerousCommand,
  refuseProtectedPathWrite,
} from "../tool-gates";

export { calculateContentSimilarity, OVERWRITE_SIMILARITY_THRESHOLD } from "../tool-gates";

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

// ========== 权限对齐辅助（闸门） ==========
//
// 闸门实现已全部搬到 `src/core/llm/tool-gates.ts`（`refuseDangerousCommand` /
// `refuseProtectedPathWrite` / `confirmWriteIfNeeded`），由 `run_code` 与
// `workflow` **共用同一份**。原来这里的私有副本已删除 —— 保留副本正是
// 「两个进程内 SDK 各有一道闸门、其中一个漏装」这类缺陷的温床。
// 逐字搬运的语义说明（为什么 dangerous 一律拒绝 / 为什么读不到现有内容也要问）
// 跟着函数一起搬到了 `tool-gates.ts`。

// ========== Tool Definition ==========

export function createRunCodeTool(): ToolDef {
  return {
    id: "run_code",
    contract: { sideEffectScope: "system", accessScope: "system" },
    guidance: "Use run_code to execute TypeScript/JavaScript for calculations, data processing, quick scripts, and verifying logic. It runs IN-PROCESS, inside this application and with the application's own privileges; there is no isolation boundary. Nested sdk.bash / sdk.write calls face the same permission checks as direct tool calls, and dangerous bash commands are refused.",
    description: `Execute TypeScript code in-process: it runs inside this application, with the application's own privileges and no isolation boundary. The code can use the \`sdk\` object to call other tools:
- sdk.bash(command) — run a shell command; refused if it is classified dangerous (use the bash tool directly so the user is asked)
- sdk.read(path) — read a file
- sdk.write(path, content) — write a file; overwriting a differing existing file requires user confirmation in ask mode
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
          // FIX: 传有界超时（默认 30s），避免 sdk.bash 内命令挂 600s；
          // 且 Rust 超时会杀进程树。
          const cmdTimeout = Math.min(opts?.timeout_ms || 30_000, 120_000);
          const refusal = refuseDangerousCommand(command, ctx.securityMode, cmdTimeout);
          if (refusal) throw new Error(refusal);
          const { executeCommand } = await import("../../file-api");
          const result = await executeCommand(command, ctx.cwd, cmdTimeout);
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
          // 受保护路径（.git/ .env node_modules/ …）：`write` 工具在建任何东西之前就拒绝
          // （`tools.ts:1385-1391`，`isProtectedPath`，`tools.ts:291`）。
          // 与 `workflow` 共用同一实现（`tool-gates.ts`），判据只有一份。
          const protectedRefusal = await refuseProtectedPathWrite(path);
          if (protectedRefusal) throw new Error(protectedRefusal);
          const confirmed = await confirmWriteIfNeeded(path, content, ctx);
          if (!confirmed.ok) throw new Error(confirmed.reason);
          const { writeFile } = await import("../../file-api");
          // 保持原样：workspace 参数是 writeFile 自带的沙箱检查（S5）。
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
          // FIX: 有界超时（15s），避免 LLM 代码 fetch 慢 URL 挂起
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 15_000);
          try {
            const response = await fetch(url, { signal: controller.signal });
            return await response.text();
          } finally {
            clearTimeout(timer);
          }
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

/**
 * Convenience wrapper for executing code from providers.
 *
 * ## 可达性与闸门（本次修复）
 *
 * 它**不是** `run_code` 工具的执行体（工具走上面的 `createRunCodeTool().execute`），
 * 但它的 `sdk.bash` / `sdk.write` 与工具内部那份是同一个缺口，所以同一道闸门也装在这里：
 * 危险命令只被拒绝、绝不执行。它没有任何
 * `ToolContext`，因此**没有**审批通道可用 —— 这正是「拒绝」而不是「询问」的理由
 * （与 `refuseDangerousCommand` 的注释同一套依据）。
 *
 * 已知问题（本次不改，仅记录）：`code-runtime-provider.ts:20-22` 的 `runWithSDK`
 * 把一个 `sdk` 传进 `options`，但本函数的 `options` 类型只有 `timeout` / `cwd`，
 * `sdk` 被静默丢弃 —— 也就是说那个方法名在说一套、做的却是另一套。
 */
export async function execRunCode(code: string, options?: { timeout?: number; cwd?: string }): Promise<{ stdout: string; stderr: string; error?: string }> {
  const sdk: ToolSDK = {
    bash: async (cmd: string) => {
      // FIX: 有界超时（options.timeout 或默认 60s）
      const timeout = Math.min(options?.timeout || 60_000, 300_000);
      const refusal = refuseDangerousCommand(cmd, undefined, timeout);
      if (refusal) throw new Error(refusal);
      const { executeCommand } = await import("../../file-api");
      const result = await executeCommand(cmd, options?.cwd, timeout);
      return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode ?? 0 };
    },
    read: async (path: string) => { const { readFile } = await import("../../file-api"); return readFile(path); },
    write: async (path: string, content: string) => { const { writeFile } = await import("../../file-api"); return writeFile(path, content); },
    glob: async (pattern: string) => { const { globSearch } = await import("../../file-api"); return globSearch(pattern); },
    grep: async (pattern: string) => { const { grepSearch } = await import("../../file-api"); const results = await grepSearch(pattern); return results.map((r: any) => ({ file: r.file || r.path || "", line: r.line || 0, content: r.content || r.line_text || "" })); },
    fetch: async (url: string) => { const res = await fetch(url); return res.text(); },
  };
  return executeCode(code, sdk, options?.timeout ?? 30_000);
}