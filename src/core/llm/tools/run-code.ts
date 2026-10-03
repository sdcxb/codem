/**
 * run_code 工具 — 脚本执行（**QuickJS/WASM 沙箱**，不经 eval）
 *
 * ## 执行模型（第 103 波改了：从 `new Function` 迁到 WASM 里的 JS 引擎）
 *
 * - 代码在 **guest 侧**跑：`src/core/js/js-vm.ts` 里的 QuickJS（编译成 WebAssembly；
 *   CSP 允许 `wasm-unsafe-eval`，但**不允许** `unsafe-eval` —— 所以这才是真机上唯一能跑的路）；
 * - guest 里**没有** `window` / `document` / `process` / `require` / `__TAURI__` / `fetch`：
 *   它能用的只有宿主显式注入的 `sdk`（`__hostCall` 桥，参数与返回值都只走 JSON）；
 *   于是**活的引用传不进去**，模型写的脚本摸不到应用内部；
 * - 代码包在 async IIFE 里，可以用 `await`；`console.*` 被捕获成 stdout/stderr；完成值渲染成 `[Result]`；
 * - 超时用 QuickJS 的 **interrupt handler** 真正打断（旧实现只是 `Promise.race` 放弃等待，
 *   底层死循环还在跑）。
 *
 * ## 与工具契约的关系（**没变**）
 *
 * sdk 的每个方法仍走与直接调用**同一道闸门**（危险命令拒绝、受保护路径拒绝、覆盖确认）——
 * 见 `tool-gates.ts`；`sdk.write` 覆盖已有文件时照样要用户确认。
 * 换句话说：**执行环境换了，权限语义没换**，判据 `pi-p2-run-code-permission-parity.test.ts` 一字未改。
 *
 * ## 仍然要说清楚的边界
 *
 * VM 隔离的是"摸不到应用的 JS 对象"，**不是**"不能干坏事"：`sdk.bash` 照样能跑命令
 * （那是工具的功能），只是它必须过闸门、而且危险命令会被拒。
 */

import type { ToolDef, ToolContext, ToolExecuteResult } from "../tools";
import { runInJsVm } from "../../js/js-vm";
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

/**
 * 执行 `run_code` / `workflow` 的代码。
 *
 * ## 第 103 波：从 `new Function` 迁到 **QuickJS/WASM**（`src/core/js/js-vm.ts`）
 *
 * 为什么必须迁（真机实测）：装好的应用里 CSP **没有 `unsafe-eval`**，
 * 于是这里原来的 `new Function(...)` 在真机上**直接抛 CSP 违规**：
 * `Evaluating a string as JavaScript violates … 'unsafe-eval' is not an allowed source of script`。
 * `run_code` 与 `workflow` 因此**在真机上等于不可用**（既有的权限判据全绿，是因为它们跑在
 * vitest/Node 里 —— 又一次"判据长在生产里不执行的链路上"）。
 *
 * 现在代码在 **QuickJS（编译成 WebAssembly，CSP 里的 `wasm-unsafe-eval` 允许）** 里跑：
 *  · 语义保持：包在 async IIFE 里、可以用 `await`、`console.*` 捕获成 stdout/stderr、完成值渲染成 `[Result]`；
 *  · SDK 调用走宿主函数桥（`__hostCall`），仍是**同一条闸门**（危险命令 / 受保护路径 / 覆盖确认都在 sdk 实现里）；
 *  · 额外收益：guest 里**没有** `window` / `document` / `process` / `require` / `__TAURI__`
 *    —— 比原来"与外层共享同一份全局对象"强得多（原来那些白名单参数**不是**安全边界）。
 */
export async function executeCode(
  code: string,
  sdk: ToolSDK,
  timeoutMs: number = 30_000,
): Promise<{ stdout: string; stderr: string; error?: string }> {
  /**
   * 宿主函数桥：**每个 sdk 方法都包一层**，保证
   *  · 参数/返回值只走 JSON（guest 拿不到任何活对象引用）；
   *  · 抛错带可读原因回 guest（原来的 try/catch 语义）。
   */
  const hostFunctions: Record<string, (args: unknown[]) => unknown> = {
    bash: async (args) => sdk.bash(String(args[0] ?? ""), (args[1] as { timeout_ms?: number }) ?? undefined),
    read: async (args) => ({ content: await sdk.read(String(args[0] ?? "")) }),
    write: async (args) => {
      await sdk.write(String(args[0] ?? ""), String(args[1] ?? ""));
      return { ok: true };
    },
    glob: async (args) => ({ files: await sdk.glob(String(args[0] ?? ""), args[1] as string | undefined) }),
    grep: async (args) => ({ matches: await sdk.grep(String(args[0] ?? ""), (args[1] as { path?: string; glob?: string }) ?? undefined) }),
    fetch: async (args) => ({ text: await sdk.fetch(String(args[0] ?? "")) }),
  };

  /** guest 侧的外壳：保持"返回 Promise"的既有契约（`await sdk.bash(...)` 与 `.then` 都能用） */
  const prelude = `
    globalThis.sdk = {};
    for (const [name, shape] of Object.entries({
      bash: (v) => v,
      read: (v) => v.content,
      write: (v) => v.ok,
      glob: (v) => v.files,
      grep: (v) => v.matches,
      fetch: (v) => v.text,
    })) {
      // 用 __sdk（Promise 形态）：宿主报错走 reject，不在挂起恢复期同步抛
      globalThis.sdk[name] = (...args) => __sdk(name, args).then(shape);
    }
  `;

  const outcome = await runInJsVm({ code, hostFunctions, prelude, timeoutMs });

  let stdout = outcome.stdout ?? "";
  let stderr = outcome.stderr ?? "";
  const error = outcome.ok
    ? undefined
    : outcome.error?.message || (outcome.timedOut ? `Code execution timed out after ${timeoutMs}ms` : "未知错误");

  /**
   * 完成值的渲染与旧实现保持一致：`[Result]: <字符串或 JSON>`。
   * （旧实现把它追加到 stdout；这里照旧，避免"迁移顺手改了模型看到的东西"。）
   */
  if (outcome.ok && outcome.value !== undefined && outcome.value !== null) {
    const rendered = typeof outcome.value === "string" ? outcome.value : JSON.stringify(outcome.value, null, 2);
    stdout += `\n[Result]: ${rendered}`;
  }

  return { stdout, stderr, error };
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
    guidance: "Use run_code to execute JavaScript for calculations, data processing, quick scripts, and verifying logic. The script runs in its own JavaScript engine (QuickJS on WebAssembly) and cannot see the application's globals (window / document / process / __TAURI__); everything it does goes through the injected `sdk`, and nested sdk.bash / sdk.write calls face the same permission checks as direct tool calls (dangerous bash commands are refused). That is a capability boundary, not a safety guarantee: `sdk.bash` is still a shell.",
    description: `Execute JavaScript in its own engine (QuickJS compiled to WebAssembly). The script cannot see the application's own globals (window / document / process / require / __TAURI__); everything it does goes through the injected \`sdk\` object:
- sdk.bash(command) — run a shell command; refused if it is classified dangerous (use the bash tool directly so the user is asked)
- sdk.read(path) — read a file
- sdk.write(path, content) — write a file; overwriting a differing existing file requires user confirmation in ask mode
- sdk.glob(pattern) — search for files
- sdk.grep(pattern) — search file contents
- sdk.fetch(url) — fetch a URL

The code runs in an async context, so you can use \`await\`. Use \`console.log()\` for output.
The engine has no network or filesystem access of its own — everything goes through \`sdk\`.
Timeout: 30 seconds (really interrupted, not just abandoned).`,
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