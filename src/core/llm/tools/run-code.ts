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
  /**
   * Grep search：每条命中一行。
   *
   * `line` 可以是 `null` —— 那表示**这一行没解析出真实行号**（不该拿 0 冒充）。
   * 第 184 波（G5）改：改前 `line` 恒为 0，模型据此定位必然出错。
   */
  grep(pattern: string, opts?: { path?: string; glob?: string }): Promise<Array<{ file: string; line: number | null; content: string }>>;
  /** Fetch a URL */
  fetch(url: string): Promise<string>;
}

// ========== Code Execution ==========

/**
 * 脚本执行前端：默认是 **Rust 侧 JS 沙箱**（`js_run_sandboxed`）。
 *
 * ## 为什么要可注入（第 103 波）
 *
 * 执行搬到 Rust 之后，vitest 里没有 Tauri 运行时 ⇒ 那些"**闸门**"判据
 * （`pi-p2-run-code-permission-parity` / `workflow-permission-parity`）就没法再驱动真实引擎。
 * 但它们真正要钉的是"**工具把哪些方法交给了执行器、那些方法是否过闸门**" ——
 * 这件事不需要引擎：注入一个**记录型 runner** 拿到方法表，直接调用即可。
 *
 * 于是分工变成（三层，各管一件事）：
 *  · **vitest**：钉"方法表里有 bash/read/write/…" + "每个方法都过闸门"（确定性、不依赖引擎）；
 *  · **Rust `cargo test`**（`js_sandbox_tests`）：钉引擎语义（**多次**宿主调用、错误传递、预算中断、隔离）；
 *  · **真机探针**：钉端到端（脚本真的在装好的应用里跑起来）。
 */
export type ScriptRunner = (options: {
  code: string;
  sdk: ToolSDK;
  timeoutMs: number;
}) => Promise<{
  ok: boolean;
  value?: string | null;
  error?: string | null;
  stdout: string;
  stderr: string;
  budgetExceeded?: boolean;
}>;

let injectedRunner: ScriptRunner | null = null;

/** 测试用：注入一个脚本执行前端（传 `null` 恢复默认的 Rust 沙箱） */
export function __setScriptRunnerForTests(runner: ScriptRunner | null): void {
  injectedRunner = runner;
}

/** 默认前端：Rust 侧 boa 沙箱（宿主调用经事件回到本进程的 sdk 实现） */
const rustRunner: ScriptRunner = async ({ code, sdk, timeoutMs }) => {
  const { runSandboxedInRust, hostMethodsFromToolSdk } = await import("../../js/js-remote-runtime");
  const outcome = await runSandboxedInRust({
    code,
    // 宿主方法表 = SDK 的**同一个实现**，只是换个执行前端；
    // 危险命令分析 / 受保护路径 / 覆盖确认 / 沙箱路径判定都在这些方法里（TS 侧）生效，
    // Rust **不做**任何权限判断（免得出现第二套闸门）。
    methods: hostMethodsFromToolSdk(sdk),
    loopLimit: Math.max(1_000_000, timeoutMs * 1000),
  });
  return {
    ok: outcome.ok,
    value: outcome.value ?? null,
    error: outcome.error ?? null,
    stdout: outcome.stdout ?? "",
    stderr: outcome.stderr ?? "",
    budgetExceeded: outcome.budgetExceeded,
  };
};

/**
 * 执行 `run_code` / `workflow` 的代码。
 *
 * ## 第 103 波：`new Function` → **Rust 侧 JS 引擎**（`boa_engine`）
 *
 * 为什么必须迁（真机实测）：装好的应用里 CSP **没有 `unsafe-eval`**，
 * 于是这里原来的 `new Function(...)` 在真机上**直接抛 CSP 违规**：
 * `Evaluating a string as JavaScript violates … 'unsafe-eval' is not an allowed source of script`。
 * `run_code` 与 `workflow` 因此**在真机上等于不可用**（既有的权限判据全绿，是因为它们跑在
 * vitest/Node 里 —— 又一次"判据长在生产里不执行的链路上"）。
 *
 * 执行模型（`src-tauri/src/js_sandbox.rs` + `src/core/js/js-remote-runtime.ts`）：
 *  · guest 在 Rust 侧的 boa 引擎里跑，**没有** `process` / `window` / `require` / `__TAURI__`；
 *  · `sdk.*` 调用变成"Rust 发事件 → 前端执行真正的工具（**同一套闸门**）→ 阻塞等回复"，
 *    所以 guest 看到的是同步函数、可以用 `await`，且**没有次数上限**
 *    （WebView 侧的 asyncify 引擎一次执行只能挂起一次，那条路已被这一步取代；见交接单 §16.3）；
 *  · 超时/失控由 Rust 的**循环迭代上限**兜住（确定性，不依赖墙钟）。
 */
export async function executeCode(
  code: string,
  sdk: ToolSDK,
  timeoutMs: number = 30_000,
): Promise<{ stdout: string; stderr: string; error?: string }> {
  const runner = injectedRunner ?? rustRunner;
  const outcome = await runner({ code, sdk, timeoutMs });

  let stdout = outcome.stdout ?? "";
  const stderr = outcome.stderr ?? "";
  let error: string | undefined;

  if (!outcome.ok) {
    // Rust 侧把错误包成 `{"message": ...}`；解开给模型一句人话
    const raw = String(outcome.error ?? "");
    try {
      const parsed = JSON.parse(raw) as { message?: string };
      error = parsed?.message ?? raw;
    } catch {
      error = raw || (outcome.budgetExceeded ? "执行超出预算（脚本循环太久或调用工具过多）" : "未知错误");
    }
  }

  /** 完成值的渲染与旧实现保持一致：`[Result]: <字符串或 JSON>` */
  if (outcome.ok && outcome.value !== null && outcome.value !== undefined) {
    let rendered = String(outcome.value);
    try {
      const parsed = JSON.parse(rendered) as unknown;
      rendered = typeof parsed === "string" ? parsed : JSON.stringify(parsed, null, 2);
    } catch {
      /* 不是 JSON 就原样输出 */
    }
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
    guidance: "Use run_code to execute JavaScript for calculations, data processing, quick scripts, and verifying logic. The script runs in its own JavaScript engine (Rust-side `boa`, NOT the app's WebView) and cannot see the application's globals (window / document / process / __TAURI__); everything it does goes through the injected `sdk`, and nested sdk.bash / sdk.write calls face the same permission checks as direct tool calls (dangerous bash commands are refused). That is a capability boundary, not a safety guarantee: `sdk.bash` is still a shell.",
    /**
     * ★ 第 184 波（G5）：描述必须与实现**同形**（"描述即契约"）。
     *
     * ## 改前的三处失真（都会被模型照字面用）
     *
     * 1. **引擎写错**：写的 "QuickJS compiled to WebAssembly"，而真机跑的是 **Rust `boa_engine`**
     *    （`src-tauri/src/js_sandbox.rs:11`）。模型据此推断可用 API/超时语义会错。
     *    （QuickJS/WASM 那条路在第 103 波就被换掉了 —— 它一次执行只能挂起一次，
     *    2 次宿主调用 0/5 成功。）
     * 2. **逐条没标 async / 没写返回形状**：五个 SDK 方法**全是 async**，模型不 await 时
     *    拿到的是 Promise（`JSON.stringify(promise)` 会得到 `{}`）。上游 Pi 的同款缺陷
     *    （`#10555`）就是这么来的，修法是**改描述**而不是再提醒一句。
     * 3. **`sdk.fetch` 返回的是字符串**（`response.text()`），不是 `Response` ——
     *    照标准 fetch 直觉写 `res.ok` / `res.json()` 会拿到 undefined 或抛错。
     *
     * 判据：`run-code-sdk-contract.test.ts`。
     */
    description: `Execute JavaScript in its own engine (Rust-side boa — NOT the app's WebView, and not QuickJS). The script cannot see the application's own globals (window / document / process / require / __TAURI__); everything it does goes through the injected \`sdk\` object. **Every sdk method is async — you must \`await\` it** (an un-awaited call gives you a Promise, and \`JSON.stringify(promise)\` is \`{}\`):
- \`await sdk.bash(command, opts?)\` → \`{ stdout: string, stderr: string, exitCode: number }\`; refused if the command is classified dangerous (use the bash tool directly so the user is asked)
- \`await sdk.read(path)\` → \`string\` (file content); a path outside the workspace is refused while the user's workspace restriction is on
- \`await sdk.write(path, content)\` → \`void\`; a path outside the workspace is refused while the user's workspace restriction is on, and overwriting a differing existing file requires user confirmation in ask mode
- \`await sdk.glob(pattern, path?)\` → \`string[]\` (matching paths); the search path and the pattern must stay inside the workspace while the user's workspace restriction is on
- \`await sdk.grep(pattern, opts?)\` → \`{ file: string, line: number, content: string }[]\` (one entry per matching line; \`line\` is 1-based); the search path must stay inside the workspace while the user's workspace restriction is on
- \`await sdk.fetch(url)\` → \`string\` — the response **body text only** (no status, no headers, no \`json()\`); it aborts after 15s

Use \`console.log()\` for output. The engine has no network or filesystem access of its own — everything goes through \`sdk\`.
Timeout: 30 seconds by default (really interrupted, not just abandoned).`,
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
          output: "Error: code parameter is required and must not be empty.", isError: true,
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
          /**
           * ★ 第 185 波（T2）：**读侧也要过工作区判定**（与写侧同一份实现）。
           *
           * 原来是裸 `readFile(path)` ⇒ 沙箱开启时 `await sdk.read("C:/Users/x/.ssh/id_rsa")`
           * 读得到工作区外的文件，而同样带 `path` 的 `read` 工具调用会被 `SandboxGuard` 拒 ——
           * 同一个沙箱两条相反的事实。`ctx.cwd` 就是这里的工作区，必须传下去
           * （`file-api.ts` 的 `assertWithinWorkspace` 在没有 workspace 时不做判定，
           * 所以"忘了传"就等于"没检查"）。
           */
          const { readFile } = await import("../../file-api");
          return await readFile(path, { workspace: ctx.cwd });
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
          // ★ 第 185 波（T2）：搜索路径与模式都要过工作区判定（同一个 `isPathWithinWorkspace`）
          const { globSearch } = await import("../../file-api");
          return await globSearch(pattern, path || ctx.cwd, { workspace: ctx.cwd });
        },
        async grep(pattern: string, opts?: { path?: string; glob?: string }) {
          const { grepSearch } = await import("../../file-api");
          // ★ 第 185 波（T2）：同上（`pattern` 是正则，只判搜索路径）
          const results = await grepSearch(pattern, opts?.path || ctx.cwd, opts?.glob, {
            workspace: ctx.cwd,
          });
          /**
           * ★ 第 184 波（G5）：**这里原来把结果整个映射错了**。
           *
           * 改前是 `results.map(r => ({ file: r, line: 0, content: r }))` ——
           * `grepSearch` 返回的是**已经拼好的整行字符串** `path:行号:内容`
           * （`file-api.ts:298` 的 `$_.Path + ':' + $_.LineNumber + ':' + $_.Line`），
           * 于是 `file` 与 `content` 是同一坨原文、而 `line` **恒为 0**。
           * 模型据此定位（"改第 0 行"）必然出错，而且看不出哪一段是文件名。
           *
           * 现在按真实格式拆开。**拆不开时不再编行号** —— 退回 `line: null` 并把原文放进
           * `content`（"宁可说得少，也不许编数字"，与截断诊断同一纪律）。
           */
          return results.map((raw) => {
            const m = /^(.*?):(\d+):([\s\S]*)$/.exec(raw);
            if (!m) return { file: "", line: null as number | null, content: raw };
            return { file: m[1], line: Number(m[2]), content: m[3] };
          });
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
          output: output || "(no output)", isError: false,
        };
      } catch (err: any) {
        return {
          title: "run_code",
          output: "Error: " + err.message, isError: true,
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
    read: async (path: string) => { const { readFile } = await import("../../file-api"); return readFile(path, { workspace: options?.cwd }); },
    write: async (path: string, content: string) => { const { writeFile } = await import("../../file-api"); return writeFile(path, content, { workspace: options?.cwd }); },
    glob: async (pattern: string) => { const { globSearch } = await import("../../file-api"); return globSearch(pattern, options?.cwd, { workspace: options?.cwd }); },
    grep: async (pattern: string) => { const { grepSearch } = await import("../../file-api"); const results = await grepSearch(pattern, options?.cwd, undefined, { workspace: options?.cwd }); return results.map((r: any) => ({ file: r.file || r.path || "", line: r.line || 0, content: r.content || r.line_text || "" })); },
    fetch: async (url: string) => { const res = await fetch(url); return res.text(); },
  };
  return executeCode(code, sdk, options?.timeout ?? 30_000);
}