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
import { analyzeBashCommand, evaluateWithBashAnalysis } from "../../permission/bash-analyzer";

// ========== 与 write 工具对齐的覆盖保护参数 ==========

/**
 * `src/core/llm/tools.ts:321` 的 `OVERWRITE_SIMILARITY_THRESHOLD`（0.1）。
 *
 * 该常量与下面的 `calculateContentSimilarity` 在 `tools.ts` 中是**模块私有**的，
 * 且本次任务禁止改动 `tools.ts` —— 所以在本地复刻一份（而不是发明一套新判据）。
 * 两者是同一个判据的两份实现，**存在漂移风险**：`tools.ts` 那份若改了阈值或算法，
 * 这里不会自动跟随，也没有测试能发现（`tools.ts` 的实现没有导出，
 * 无法在测试里做交叉断言）。要消除该风险需要把判据提到共享模块 —— 那会动到
 * `tools.ts`，超出本次修复范围，故只在此如实记录。
 */
const OVERWRITE_SIMILARITY_THRESHOLD = 0.1;

/**
 * 与 `src/core/llm/tools.ts:303-318` 的 `calculateContentSimilarity` 逐行等价：
 * 按行去空白求交集占比。返回 0.0（完全不同）～ 1.0（逐字相同）。
 *
 * 之所以不复用 `tools.ts` 的实现：它是私有的，而本任务不允许改 `tools.ts`。
 * export 只是为了能被测试直接钉住算法（见同名测试文件）。
 */
export function calculateContentSimilarity(oldContent: string, newContent: string): number {
  if (oldContent === newContent) return 1.0;
  if (!oldContent || !newContent) return 0.0;

  const oldLines = new Set(oldContent.split("\n").map(l => l.trim()).filter(l => l.length > 0));
  const newLines = newContent.split("\n").map(l => l.trim()).filter(l => l.length > 0);

  if (newLines.length === 0) return 0.0;

  let commonLines = 0;
  for (const line of newLines) {
    if (oldLines.has(line)) commonLines++;
  }

  return commonLines / Math.max(newLines.length, oldLines.size);
}

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

/**
 * 判断 `sdk.bash` 是否必须**拒绝执行**（fail-closed）。
 *
 * 返回 `null` = 允许执行；返回字符串 = 拒绝原因（调用方抛错，脚本与模型都能读到）。
 *
 * ## 规则为什么是「dangerous 一律拒绝」而不是「按模式放行」
 *
 * `analyzeBashCommand` 的 `dangerous` 分类是 `isAutoApprovable`
 * （`security-mode.ts:149-184`）唯一会否掉的东西 —— 也就是说，
 * `dangerous` 的含义正是「**在任何模式下都不许静默执行**」：
 *
 * - `full`：用户显式放弃审批，直接调 `bash` 工具确实会执行；但 `run_code` 内部
 *   拿不到任何审批通道（`ToolContext` 没有 `executeTool`/`onPermissionRequest`，
 *   见 `tools.ts:409-439`）。此时若放行，等于把「用户放弃审批」偷换成
 *   「模型可以在一个被 `isAutoApprovable` 恒判可放行的外壳里执行危险命令」——
 *   而真正的危险闸门（`evaluateWithBashAnalysis`，`bash-analyzer.ts:291`）
 *   只会把 `allow` 升级成 `ask`，**不会**降级成 deny。所以「拒绝」与之一致。
 * - `ask` / `auto`：本应询问用户。这里**没有**可用的询问通道（同样的缺口），
 *   而 `agentic-loop.ts:1005-1019` 已经为「需要问却没人可问」立了先例：
 *   **明确拒绝并说清原因**，不许落到缺省放行。这里照做。
 *
 * 结论：拒绝 + 告诉模型去直接调 `bash` 工具（那条路上用户会被问到）是唯一
 * 既不放行危险命令、又不假装问过的行为。
 *
 * ## fail-closed
 *
 * 分析器抛错时**同样拒绝**（`security-mode.ts:159-163` 的 `catch { return false }`
 * 是同一约定的先例）：拿不准就不执行，而不是当作安全。
 */
function refuseDangerousCommand(
  command: string,
  securityMode: ToolContext["securityMode"],
  timeoutMs: number,
): string | null {
  let analysis: ReturnType<typeof analyzeBashCommand>;
  try {
    analysis = analyzeBashCommand(command);
  } catch (err: any) {
    return (
      `Error: refused to execute this command inside run_code — the bash security analyzer threw ` +
      `(${err?.message || String(err)}), so it was treated as unsafe (fail-closed). ` +
      `Call the \`bash\` tool directly instead so the normal permission checks apply. ` +
      `[command: ${command}] [timeout_ms: ${timeoutMs}]`
    );
  }

  if (analysis.classification !== "dangerous") return null;

  const detail = analysis.dangerousPatterns.join("; ");
  let evaluated = "";
  try {
    const settlement = evaluateWithBashAnalysis(command, "allow");
    evaluated = settlement.action === "ask"
      ? ` The user approval gate would have to be honoured (the analyzer raises the action to 「ask」), but run_code has no approval channel.`
      : "";
  } catch (err: any) {
    // 它抛错**不影响「拒绝」这个决定**（拒绝是无条件的），但也不能静默吞掉：
    // 写进理由里，否则排查时分不清「确定危险」与「判不出来所以保守拒绝」。
    evaluated = ` (evaluateWithBashAnalysis also threw: ${err?.message || String(err)}; refusing conservatively)`;
  }

  return (
    `Error: refused to execute this command inside run_code — analyzeBashCommand classified it as "dangerous". ` +
    `Detected patterns: ${detail}. ` +
    `run_code executes nested calls without a user-approval channel, so a dangerous command cannot be approved here; ` +
    `refusing is the fail-closed behaviour.${evaluated} ` +
    `Call the \`bash\` tool directly with the same command so the user is asked. ` +
    `[command: ${command}] [timeout_ms: ${timeoutMs}] [security_mode: ${securityMode ?? "unset"}]`
  );
}

/**
 * 读盘失败是不是「这个路径不存在」。
 *
 * ⚠️ 这是**文本判据**，而文本判据会随文案微调静默失效（仓库里 `src/core/storage/session-jsonl.ts`
 * 的 `isFileMissingError` 已经写过这条教训）。这里用它是因为**方向是保守的**：
 * 判成"不存在" ⇒ 当新建（不问）；**判不出来 ⇒ 按"可能已存在"处理（去问）**。
 * 所以它误判的后果是"多问一次"，而不是"少问一次"。
 */
function isMissingPathError(message: string): boolean {
  return (
    // Node / fetch 层惯例（测试桩与部分 JS 侧路径用这个）
    /\bENOENT\b/.test(message) ||
    /\bENOTDIR\b/.test(message) ||
    // Rust `std::fs` 侧的文案（真机链路：`Failed to read ...: os error 2`）
    /os error 2\b/.test(message) ||
    /no such file/i.test(message) ||
    /cannot find the (file|path)/i.test(message) ||
    /找不到指定的(路径|文件)/.test(message)
  );
}

/**
 * `sdk.write` 的覆盖确认 —— 与 `write` 工具（`tools.ts:1400-1460`）同一判据：
 * 文件已存在、非空、且与**逐行等价**的相似度低于 0.1 时，
 * 在 `securityMode === "ask"` 且有 `onWriteConfirm` 的情况下询问用户（「ask」模式），
 * 并尊重结果（reject / custom ⇒ 不写盘并报明原因）。
 *
 * 与 `write` 工具的两点差异（都不是放宽）：
 * 1. 这里**没有** `append` 语义（`sdk.write` 的契约就是覆盖），所以不做 append 分支。
 * 2. `write` 工具在「没有回调」时打印 warning 后照写；这里同样照写 ——
 *    闸门的缺失由 `createRunCodeTool` 的 guidance/description 如实说明，
 *    不在这一层发明新策略。
 */
async function confirmWriteIfNeeded(
  path: string,
  content: string,
  ctx: ToolContext,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  let existingContent: string | null = null;
  /**
   * 读盘失败**不能**被当成"文件不存在"。旧实现的 catch 是空的 ⇒ `existingContent` 保持 null
   * ⇒ 走下面的"新建"分支 ⇒ **跳过覆盖确认**。那是这一层的 fail-open，而且窗口是真实的：
   * 二进制/超大文件、权限、引擎暂时不可用都会让 `read_file` 失败，而 `write_file` 可能照样写得下去
   * —— 于是用户在被覆盖之前**一次都没被问过**。
   *
   * 现在的方向是保守的：只有**能确认不存在**才当新建；**判不出来一律按"可能已存在"处理**（去问）。
   */
  let readFailure: string | null = null;
  try {
    const { readFile } = await import("../../file-api");
    existingContent = await readFile(path);
  } catch (err: any) {
    const detail = String(err?.message ?? err ?? "");
    readFailure = isMissingPathError(detail) ? null : detail;
  }

  if (readFailure === null && (existingContent === null || existingContent.length === 0)) return { ok: true };

  const secMode = ctx.securityMode || "ask";
  const canConfirm = Boolean(ctx.onWriteConfirm) && secMode === "ask";

  if (readFailure === null) {
    const similarity = calculateContentSimilarity(existingContent!, content);
    if (similarity >= OVERWRITE_SIMILARITY_THRESHOLD) return { ok: true };
    if (!canConfirm) {
      // 与 write 工具一致：auto/full 模式跳过 Diff 确认；没有回调时无从确认。
      return { ok: true };
    }
  } else if (!canConfirm) {
    // 读不到、又无从确认（auto/full 或无回调）：与 write 工具一致不阻塞，但**留下痕迹**。
    console.warn(
      `[run-code] sdk.write could not read the existing content of "${path}" (${readFailure}); ` +
        `proceeding without an overwrite confirmation (mode=${secMode}, onWriteConfirm=${Boolean(ctx.onWriteConfirm)})`,
    );
    return { ok: true };
  }

  const confirmResult = await ctx.onWriteConfirm!({
    filePath: path,
    existingContent: existingContent ?? "",
    newContent: content,
  });
  if (confirmResult.action === "reject") {
    return {
      ok: false,
      reason:
        `Error: the user rejected the overwrite of "${path}" by sdk.write inside run_code ` +
        (readFailure === null
          ? `(existing ${existingContent!.length} bytes, similarity ${calculateContentSimilarity(existingContent!, content).toFixed(3)} < ${OVERWRITE_SIMILARITY_THRESHOLD}). `
          : `(its existing content could not be read: ${readFailure}). `) +
        `Nothing was written. Use the \`edit\` tool for targeted modifications, or ask the user how to proceed.`,
    };
  }
  if (confirmResult.action === "custom") {
    return {
      ok: false,
      reason:
        `Error: sdk.write did not write "${path}" — the user gave a ONE-TIME instruction for this write instead of ` +
        `approving the overwrite: "${confirmResult.instruction}". ` +
        `Nothing was written. Apply that instruction (prefer the \`edit\` tool) and then write again; ` +
        `the instruction applies only to that one operation.`,
    };
  }
  return { ok: true };
}

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
          // 只 import 既有实现，不改 `tools.ts`。
          const { isProtectedPath } = await import("../tools");
          if (isProtectedPath(path)) {
            throw new Error(
              `Error: This path is protected and cannot be written to by sdk.write: "${path}". ` +
              `Protected paths include .git/, .env, .codem-snapshots/, node_modules/. ` +
              `Use the 'edit' tool for modifying existing files in safe locations.`,
            );
          }
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