/**
 * Tool Pipeline — 5-Layer Waterfall Execution
 *
 * Design (对标 DeepSeek Harness 5-layer tool pipeline):
 *
 * 1. pre-execute (waterfall): hooks, permission, bash-analyzer → can deny/modify
 *    R3-1.4: AbortSignal check — if already aborted, return ABORTED_BEFORE_DISPATCH
 * 2. monotonic guards (frozen order): sandbox, protected path, overwrite protection
 * 3. execute (waterfall): tool.execute() + timeout + retry + metrics
 *    R3-1.4: AbortSignal forwarded into toolHandler, catches AbortError → ABORTED
 * 4. post-execute (waterfall): hooks → result accept/reject/replace/append
 * 5. finalize (freeze): finalizeContent → write event → return authoritative result
 *
 * R3-1.5: Parallel execution classification
 * - Tools can declare `isConcurrencySafe(args)` returning true
 * - Concurrency-safe calls may overlap in a bounded rolling pool
 * - Exclusive calls run alone as ordering barriers
 * - Classification is unary: unknown/invalid/throwing → exclusive
 *
 * Layers are executed in strict order. Each layer can:
 * - Pass through (return the input unchanged)
 * - Modify (replace the input/output)
 * - Deny (stop execution and return an error)
 *
 * The pipeline wraps the existing tool execution logic, providing
 * a structured middleware system that's easier to extend and test.
 */

import type { ToolCallResult } from "./types";
import type { ToolContext, ToolDef } from "./tools";
import type { ToolExecutorContext } from "./streaming-executor";
import { validateAndRenderOutput } from "./output-value";
import { validateToolArgs, describeArgProblems } from "./input-args";
import { RepeatToolReminderMiddleware } from "./repeat-tool-reminder";
import { analyzeBashCommand } from "../permission/bash-analyzer";
import { CONCURRENCY_SAFE_TOOL_IDS } from './concurrency-policy';
import {
  allowedInReadOnlyMode,
  isShellLike,
  requiresPathGuard,
  resolveToolContract,
  type ResolvedToolContract,
  type ToolContract,
} from './tool-contract';

// ========== Pipeline Types ==========

/** Result of a pre-execute middleware */
export interface PreExecuteResult {
  action: "proceed" | "deny" | "modify";
  /** If action is "deny", the error message */
  denyMessage?: string;
  /** If action is "modify", the modified tool name and args */
  modifiedName?: string;
  modifiedArgs?: Record<string, unknown>;
}

/** Result of a guard middleware */
export interface GuardResult {
  action: "proceed" | "deny";
  /** If action is "deny", the error message */
  denyMessage?: string;
}

/** Result of a post-execute middleware */
export interface PostExecuteResult {
  action: "keep" | "replace" | "append" | "reject";
  /** If action is "replace", the new output */
  replacedOutput?: string;
  /** If action is "append", text to append to output */
  appendedText?: string;
  /** If action is "reject", the error message */
  rejectMessage?: string;
}

/** Final result of the pipeline */
export interface PipelineResult {
  result: ToolCallResult;
  /** Events emitted during during execution (for telemetry/replay) */
  events: PipelineEvent[];
  /** R3-1.5: Whether this call is concurrency-safe (can overlap with siblings) */
  concurrencySafe?: boolean;
}

/** Internal event log for telemetry and replay */
export interface PipelineEvent {
  layer: "pre-execute" | "guard" | "execute" | "post-execute" | "finalize";
  middleware: string;
  action: string;
  timestamp: number;
  data?: Record<string, unknown>;
}

// ========== Middleware Interfaces ==========

/** Pre-execute middleware: runs before tool execution */
export interface PreExecuteMiddleware {
  name: string;
  execute(
    toolName: string,
    args: Record<string, unknown>,
    ctx: ToolExecutorContext,
  ): Promise<PreExecuteResult>;
}

/** Guard middleware: monotonic checks that can't be reordered */
export interface GuardMiddleware {
  name: string;
  execute(
    toolName: string,
    args: Record<string, unknown>,
    ctx: ToolExecutorContext,
  ): Promise<GuardResult>;
}

/** Post-execute middleware: runs after tool execution */
export interface PostExecuteMiddleware {
  name: string;
  execute(
    toolName: string,
    args: Record<string, unknown>,
    result: ToolCallResult,
    ctx: ToolExecutorContext,
  ): Promise<PostExecuteResult>;
}

  /** Finalize middleware: runs after all post-execute, before returning */
export interface FinalizeMiddleware {
  name: string;
  execute(
    toolName: string,
    args: Record<string, unknown>,
    result: ToolCallResult,
    ctx: ToolExecutorContext,
    events: PipelineEvent[],
  ): Promise<ToolCallResult>;
}

// R3-1.5: Concurrency classification

/** A function that classifies whether a tool call is safe to run concurrently */
export type ConcurrencyClassifier = (args: Record<string, unknown>) => boolean;

/** R3-1.5: Tool concurrency registration — declares if a tool's calls can overlap */
interface ToolConcurrencyRegistration {
  toolName: string;
  classifier: ConcurrencyClassifier;
}

// R3-1.4: Abort error names to detect
const ABORT_ERROR_NAMES = new Set(["AbortError", "AbortErrorError"]);

/** Check if an error was caused by an abort */
function isAbortError(error: any): boolean {
  if (!error) return false;
  if (ABORT_ERROR_NAMES.has(error.name)) return true;
  if (error.name === "TimeoutError" && error.cause?.name === "AbortError") return true;
  return false;
}

// ========== Pipeline Implementation ==========

export class ToolPipeline {
  private preExecuteMiddlewares: PreExecuteMiddleware[] = [];
  private guardMiddlewares: GuardMiddleware[] = [];
  private postExecuteMiddlewares: PostExecuteMiddleware[] = [];
  private finalizeMiddlewares: FinalizeMiddleware[] = [];
  // R3-1.5: Tool concurrency registrations
  private concurrencyRegistrations: Map<string, ConcurrencyClassifier> = new Map();
  /**
   * 原始契约查询器（第 121 轮）。
   *
   * 归一化（`normalizeInput`）与结果渲染（`renderOutput`）是**行为钩子**，
   * `ResolvedToolContract` 只承载值、刻意不带函数 —— 所以这两个从原始声明取。
   */
  private rawContractOf?: (toolName: string) => ToolContract | undefined;
  /** 工具定义查询器（入参校验要读它下发给模型的 `parameters` schema）。 */
  private toolDefOf?: (toolName: string) => ToolDef | undefined;

  /** 注入原始契约查询器（由 `initDefaultPipeline` 调用）。 */
  setRawContractOf(fn: (toolName: string) => ToolContract | undefined): void {
    this.rawContractOf = fn;
  }

  /**
   * 注入工具定义查询器（由 `initDefaultPipeline` 调用）。
   *
   * 入参校验要读 `ToolDef.parameters` —— 那是**下发给模型的同一份 schema**，
   * 用它校验才不会出现「发给模型一套、实际校验另一套」的错位。
   */
  setToolDefOf(fn: (toolName: string) => ToolDef | undefined): void {
    this.toolDefOf = fn;
  }

  /** Register a pre-execute middleware */
  registerPreExecute(m: PreExecuteMiddleware): void {
    this.preExecuteMiddlewares.push(m);
  }

  /** Register a guard middleware (order matters — guards are monotonic) */
  registerGuard(m: GuardMiddleware): void {
    this.guardMiddlewares.push(m);
  }

  /** Register a post-execute middleware */
  registerPostExecute(m: PostExecuteMiddleware): void {
    this.postExecuteMiddlewares.push(m);
  }

  /** Register a finalize middleware */
  registerFinalize(m: FinalizeMiddleware): void {
    this.finalizeMiddlewares.push(m);
  }

  // R3-1.5: Register a concurrency classifier for a tool
  registerConcurrency(toolName: string, classifier: ConcurrencyClassifier): void {
    this.concurrencyRegistrations.set(toolName, classifier);
  }

  // R3-1.5: Classify whether a tool call is concurrency-safe
  // Returns true ONLY when the classifier returns exactly true; unknown/invalid/throwing → false (exclusive)
  classifyConcurrency(toolName: string, args: Record<string, unknown>): boolean {
    const classifier = this.concurrencyRegistrations.get(toolName);
    if (!classifier) return false;
    try {
      return classifier(args) === true;
    } catch {
      return false;
    }
  }

  /**
   * Execute a tool through the full 5-layer pipeline.
   *
   * @param toolName - Name of the tool to execute
   * @param args - Tool arguments
   * @param ctx - Execution context
   * @param toolHandler - The actual tool handler function
   * @returns Pipeline result with the final ToolCallResult and events
   */
  async execute(
    toolName: string,
    args: Record<string, unknown>,
    ctx: ToolExecutorContext,
    toolHandler: (name: string, args: Record<string, unknown>, ctx: ToolExecutorContext) => Promise<ToolCallResult>,
  ): Promise<PipelineResult> {
    const events: PipelineEvent[] = [];
    let currentName = toolName;
    let currentArgs = args;

    // ===== R3-1.4: Abort check — if signal already aborted, return ABORTED_BEFORE_DISPATCH =====
    if (ctx.abort?.aborted) {
      events.push({
        layer: "pre-execute",
        middleware: "abort-check",
        action: "aborted_before_dispatch",
        timestamp: Date.now(),
      });
      return {
        /**
         * ★ 第 46 波：**这一条原来也绕过了 finalize** ✗（第 21 处自查 ✓）——
         * `execute` 里真正会**返回结果**的出口共 7 个，我 296 只补了三条 ✗，
         * `pre-execute` 阶段的**三条**（abort / normalize-input / validate-args）全漏了 ✗。
         * 它们都**很常见** ✓（模型给错参数是常事 ✓、回合被中止也常见 ✓）⇒
         * 绕过 finalize 就没有 `tool_result` 事件 ⇒ 缺口 ✓ + UI 可能停在 running ✓（= 120s 白等 ✗）。
         */
        result: await this.finalizeResult(
          {
            id: ctx.messageId,
            name: currentName,
            input: currentArgs,
            output: "Error: tool call aborted before dispatch",
            status: "error",
            error: "ABORTED_BEFORE_DISPATCH",
          },
          currentName,
          currentArgs,
          ctx,
          events,
        ),
        events,
      };
    }

    // ===== 第 121 轮：入参归一化（必须在权限判定之前）=====
    //
    // 位置是全部的意义（照 zcode `tool/executor/call-runner.ts`）：归一化之后的
    // 入参**替换**后续所有层（权限 / hook / 守卫 / handler）看到的那一份。
    // 放在这里（而不是更晚）的理由是下面那条：`classifyConcurrency` 与
    // pre-execute 层的权限判定都读 `currentArgs`，晚了就会出现
    // 「权限层按原始入参判、执行层按归一化入参做」的错位。
    //
    // 归一化抛错 ⇒ 视为**入参非法**，直接给出可行动的错误（不入权限、不执行）。
    // 归一化钩子从**原始**契约取（`ResolvedToolContract` 只承载值、不带函数，见
    // `ToolRegistry.getRawContract()` 的说明）。
    const hook = this.rawContractOf?.(currentName);
    if (hook?.normalizeInput) {
      try {
        currentArgs = hook.normalizeInput(currentArgs) ?? currentArgs;
      } catch (e) {
        const msg = `Error: ${(e as Error)?.message ?? e}`;
        events.push({
          layer: "pre-execute",
          middleware: "normalize-input",
          action: "deny",
          timestamp: Date.now(),
        });
        return {
          /** ★ 第 46 波：与 abort 那条同因 —— 必须过 finalize（见上面那条注释 ✓）。 */
          result: await this.finalizeResult(
            {
              id: ctx.messageId,
              name: currentName,
              input: args,
              output: msg,
              status: "error",
              // errorSource:"tool" ⇒ 让模型看到文本并自行纠正，不累加连续错误
              errorSource: "tool",
              error: msg,
            },
            currentName,
            args,
            ctx,
            events,
          ),
          events,
        };
      }
    }

    // ===== R3-1.5: Concurrency classification =====
    const concurrencySafe = this.classifyConcurrency(currentName, currentArgs);

    // ===== 第 121 轮：入参校验（归一化之后、权限判定之前）=====
    //
    // 放在归一化之后：先让工具把别名/默认值补成规范形态，再按下发的 schema 判，
    // 否则会误拦「用了合法别名」的调用（归一化本来就是为它们存在的）。
    //
    // 放在权限判定之前：缺参数/类型错的调用**不该走到权限询问**（用户被问一个
    // 注定会失败的调用毫无意义），也不该执行。
    //
    // 违规以 `errorSource: "tool"` 返回 ⇒ 模型能看到「哪个参数错了、期望什么」并
    // 自行纠正，不累加 `consecutiveErrors`（与第 84 波对工具失败的处理同取向）。
    const toolDef = this.toolDefOf?.(currentName);
    if (toolDef) {
      const problems = validateToolArgs(currentName, toolDef.parameters, currentArgs);
      if (problems.length > 0) {
        const msg = describeArgProblems(currentName, problems, toolDef.parameters);
        events.push({
          layer: "pre-execute",
          middleware: "validate-args",
          action: "deny",
          timestamp: Date.now(),
        });
        return {
          /** ★ 第 46 波：与 abort / normalize 两条同因 —— 必须过 finalize（见上 ✓）。 */
          result: await this.finalizeResult(
            {
              id: ctx.messageId,
              name: currentName,
              input: currentArgs,
              output: `Error: ${msg}`,
              status: "error",
              errorSource: "tool",
              error: msg,
            },
            currentName,
            currentArgs,
            ctx,
            events,
          ),
          events,
        };
      }
    }

    // ===== Layer 1: pre-execute (waterfall) =====
    for (const mw of this.preExecuteMiddlewares) {
      const result = await mw.execute(currentName, currentArgs, ctx);
      const event: PipelineEvent = {
        layer: "pre-execute",
        middleware: mw.name,
        action: result.action,
        timestamp: Date.now(),
      };
      events.push(event);

      if (result.action === "deny") {
        return {
          result: await this.finalizeResult(
            { id: ctx.messageId, name: currentName, input: currentArgs, output: result.denyMessage || "Denied by pre-execute middleware", status: "error", error: result.denyMessage },
            currentName,
            currentArgs,
            ctx,
            events,
          ),
          events,
        };
      }
      if (result.action === "modify") {
        if (result.modifiedName) currentName = result.modifiedName;
        if (result.modifiedArgs) currentArgs = result.modifiedArgs;
      }
    }

    // ===== Layer 2: monotonic guards (frozen order) =====
    for (const mw of this.guardMiddlewares) {
      const result = await mw.execute(currentName, currentArgs, ctx);
      const event: PipelineEvent = {
        layer: "guard",
        middleware: mw.name,
        action: result.action,
        timestamp: Date.now(),
      };
      events.push(event);

      if (result.action === "deny") {
        return {
          result: await this.finalizeResult(
            { id: ctx.messageId, name: currentName, input: currentArgs, output: result.denyMessage || "Denied by guard", status: "error", error: result.denyMessage },
            currentName,
            currentArgs,
            ctx,
            events,
          ),
          events,
        };
      }
    }

    // ===== Layer 3: execute =====
    // R3-1.4: AbortSignal is already on ctx.abort — tools that forward it can cooperatively cancel.
    let result: ToolCallResult;
    try {
      result = await toolHandler(currentName, currentArgs, ctx);
      events.push({
        layer: "execute",
        middleware: "tool",
        action: "completed",
        timestamp: Date.now(),
        data: { outputLength: result.output?.length || 0 },
      });
    } catch (error: any) {
      // R3-1.4: Detect abort during execution → ABORTED status
      if (isAbortError(error) || ctx.abort?.aborted) {
        result = {
          id: ctx.messageId,
          name: currentName,
          input: currentArgs,
          output: "Error: tool call was aborted",
          status: "error",
          error: "ABORTED",
        };
        events.push({
          layer: "execute",
          middleware: "tool",
          action: "aborted",
          timestamp: Date.now(),
        });
      } else {
        result = {
          id: ctx.messageId,
          name: currentName,
          input: currentArgs,
          output: `Error: ${error.message}`,
          status: "error",
          error: error.message,
        };
        events.push({
          layer: "execute",
          middleware: "tool",
          action: "error",
          timestamp: Date.now(),
          data: { error: error.message },
        });
      }
    }

    // ===== Layer 4: post-execute (waterfall) =====
    for (const mw of this.postExecuteMiddlewares) {
      const postResult = await mw.execute(currentName, currentArgs, result, ctx);
      const event: PipelineEvent = {
        layer: "post-execute",
        middleware: mw.name,
        action: postResult.action,
        timestamp: Date.now(),
      };
      events.push(event);

      switch (postResult.action) {
        case "replace":
          if (postResult.replacedOutput !== undefined) {
            result = { ...result, output: postResult.replacedOutput };
          }
          break;
        case "append":
          if (postResult.appendedText) {
            result = {
              ...result,
              output: (result.output || "") + "\n" + postResult.appendedText,
            };
          }
          break;
        case "reject":
          return {
            result: await this.finalizeResult(
              {
                ...result,
                output: postResult.rejectMessage || "Rejected by post-execute middleware",
                status: "error",
                // 明确标注：这是管线层的拒绝，不是工具自报失败（不要被上面的 ...result 带成 "tool"）
                errorSource: "pipeline",
              },
              currentName,
              currentArgs,
              ctx,
              events,
            ),
            events,
          };
      }
    }

    // ===== Layer 5: finalize (freeze) =====
    result = await this.finalizeResult(result, currentName, currentArgs, ctx, events);

    return { result, events, concurrencySafe };
  }

  /**
   * ★ 第 46 波：**finalize 层是唯一的收尾口** ✓ —— 所有出口都必须过这里 ✓。
   *
   * ## 为什么（用户**第五次**报障的真因 ✓，见 `tool-pipeline-finalize-all-exits.test.ts`）
   *
   * 写 `tool_call` / `tool_result` 事件的是 finalize 层的 `EventLogFinalizeMiddleware` ✓，
   * 而这条管线原来有**三处早退绕过它** ✗：`pre-execute deny`（:361）、`guard deny`（:391）、
   * `post-execute reject`（:479）—— 都直接 `return` ✓ ⇒ **被拒绝/被拦下的调用一条事件都不写** ✗
   * ⇒ 那一行助手消息"既无文本事件、又无工具事件"⇒ 维护自检判 `VISIBLE_BUT_NOT_RECORDED` ✓
   * ⇒ ★ **每次跑任务都新报一条缺口** ✓（真机：`error` 态的 tool_calls 里 6/16 没有事件 ✓，
   * 而 `done` 的 484/484 都有 ✓）。
   *
   * ## 口径
   *
   * 收成**一处** ✓（不是在三处各补一次 ✗ —— 那是"靠记得"，而这是结构问题 ✓）：
   * 谁要 `return`，谁就得先过这里 ✓。判据 `PIPE-1..5` 钉住三条早退 + 成功路径的反向对照 ✓。
   */
  private async finalizeResult(
    result: ToolCallResult,
    toolName: string,
    args: Record<string, unknown>,
    ctx: ToolExecutorContext,
    events: PipelineEvent[],
  ): Promise<ToolCallResult> {
    let out = result;
    for (const mw of this.finalizeMiddlewares) {
      out = await mw.execute(toolName, args, out, ctx, events);
    }
    events.push({
      layer: "finalize",
      middleware: "pipeline",
      action: "finalized",
      timestamp: Date.now(),
    });
    return out;
  }

  /** Clear all middlewares and concurrency registrations */
  clear(): void {
    this.preExecuteMiddlewares = [];
    this.guardMiddlewares = [];
    this.postExecuteMiddlewares = [];
    this.finalizeMiddlewares = [];
    this.concurrencyRegistrations.clear();
  }
}

// ========== Built-in Middlewares ==========

/**
 * Permission middleware (pre-execute layer)
 * Wraps the existing permission check logic.
 */
class PermissionMiddleware implements PreExecuteMiddleware {
  name = "permission";
  private checkPermission: (
    toolName: string,
    args: Record<string, unknown>,
    ctx: ToolExecutorContext,
  ) => Promise<{ allowed: boolean; denyMessage?: string }>;

  constructor(
    checkPermission: (
      toolName: string,
      args: Record<string, unknown>,
      ctx: ToolExecutorContext,
    ) => Promise<{ allowed: boolean; denyMessage?: string }>,
  ) {
    this.checkPermission = checkPermission;
  }

  async execute(
    toolName: string,
    args: Record<string, unknown>,
    ctx: ToolExecutorContext,
  ): Promise<PreExecuteResult> {
    const result = await this.checkPermission(toolName, args, ctx);
    if (!result.allowed) {
      return { action: "deny", denyMessage: result.denyMessage };
    }
    return { action: "proceed" };
  }
}

/**
 * 沙箱 guard middleware (guard layer)
 * Checks if file paths are within the workspace when sandbox mode is enabled.
 */

/**
 * 从 shell 类入参里找出**第一个跑到工作区之外**的路径（找不到就返回 `null`）。
 *
 * ## 为什么要这个（第 97 波）
 *
 * 沙箱原来的判据是"入参里有 `path` 就查它，没有就放行" —— 而 `bash` 的路径**藏在命令文本里**，
 * 于是同一个沙箱里：`read C:\other\x` 被拒，`bash { command: "Get-Content C:\\other\\x" }` 却读得到。
 *
 * ## 判据（保守：只报**能确定**的逃逸）
 *
 * 1. **绝对路径**：盘符（`C:\…` / `C:/…`）与 UNC（`\\server\share`）；
 * 2. **含 `..` 的相对路径**：按 `cwd` 解析后判断（`HEAD..main` 这类不含分隔符的 token 会解析成
 *    工作区内的相对名 ⇒ 自然放行，不会误报 git 的区间写法）；
 * 3. `workdir` 入参（`bash` 支持它，等于换个目录再执行）。
 *
 * ## 明确的边界（别把它当密不透风的隔离）
 *
 * - **URL 不算路径**：`https://example.com/x` 里的 `s://` 长得像盘符，先剥掉再扫；
 * - **变量引用判不了**：`$env:USERPROFILE\…` / `%APPDATA%\…` / `~` 都是运行期才展开的，
 *   文本层看不见 ⇒ 放行（这是**有意的边界**，不是遗漏）；
 * - 文本层判据天然挡不住编码/拼接/脚本里二次构造的路径 —— 所以评测那一侧还有"污染检测"兜底。
 *
 * @param args   工具入参（读 `command` / `code` / `script` / `workdir`）
 * @param cwd    当前工作区
 * @param isWithin 由宿主注入的"在不在工作区内"判定（与 `SandboxGuard` 用的是同一个）
 */
export function findOutOfWorkspacePath(
  args: Record<string, unknown>,
  cwd: string,
  isWithin: (path: string, cwd: string) => boolean,
): string | null {
  if (!cwd) return null;
  const sep = cwd.includes("/") && !cwd.includes("\\") ? "/" : "\\";

  /** 把相对路径按 cwd 解析并折叠 `..` / `.`（文本层，不碰文件系统） */
  const resolveAgainstCwd = (p: string): string => {
    const normalized = p.replace(/\\/g, "/");
    const base = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
    const parts = `${base}/${normalized.replace(/^\/+/, "")}`.split("/");
    const out: string[] = [];
    for (const part of parts) {
      if (part === "" || part === ".") continue;
      if (part === "..") out.pop();
      else out.push(part);
    }
    const joined = out.join("/");
    // 盘符要保留成 `C:/…` 的形状（isWithin 两种写法都见得到）
    return /^[A-Za-z]:/.test(joined) ? joined : joined;
  };

  const candidates: string[] = [];
  if (typeof args.workdir === "string" && args.workdir.trim()) candidates.push(args.workdir.trim());
  // 命令文本：bash 的 `command`、run_code 的 `code`、workflow 的 `script` —— 都可能是 shell
  for (const key of ["command", "code", "script"]) {
    const raw = args[key];
    if (typeof raw !== "string" || !raw) continue;
    // 1) 先剥掉 URL，避免把 `https://…` 的 `s://` 当成盘符
    const text = raw.replace(/[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"'`]+/g, " ");
    // 2) 绝对路径（盘符 / UNC）
    for (const m of text.match(/(?:^|[^\w])([A-Za-z]:[\\/][^\s"'`;|&)<>,]*)/g) ?? []) {
      candidates.push(m.replace(/^[^\w]*/, "").replace(/[.,;:]+$/, ""));
    }
    for (const m of text.match(/\\\\[^\s"'`;|&)<>,]+/g) ?? []) candidates.push(m);
    // 3) 含 `..` 的相对路径。
    //
    // ⚠️ **裸 `..` 也算候选**（真机实测抓到的漏洞）：第一版要求 token 里带 `/` 或 `\` 才当路径，
    // 于是 `Get-ChildItem ..`（一条就能列出父目录 = 隔壁主仓库）**一路放行**。
    // 不做正则会误报吗：`HEAD..main` 这类 git 区间会解析成"工作区内的相对名" ⇒ 仍然放行。
    for (const m of text.match(/[^\s"'`;|&)<>,]*\.\.[^\s"'`;|&)<>,]*/g) ?? []) candidates.push(m);
  }

  for (const candidate of candidates) {
    if (!candidate) continue;
    const absolute = /^[A-Za-z]:[\\/]/.test(candidate) || candidate.startsWith("\\\\") || candidate.startsWith("/");
    const resolved = absolute ? candidate.replace(/\\/g, "/") : resolveAgainstCwd(candidate);
    let within = false;
    try {
      within = isWithin(resolved, cwd) || isWithin(resolved.replace(/\//g, sep), cwd);
    } catch {
      // 判定器抛错 ⇒ 当作"拦不住"，放行（不因为沙箱自身的问题挡住正常调用）
      within = true;
    }
    if (!within) return candidate;
  }
  return null;
}
class SandboxGuard implements GuardMiddleware {
  name = "sandbox";
  private isEnabled: () => boolean;
  private isWithinWorkspace: (path: string, cwd: string) => boolean;
  /** 契约查询器；见 `contractFor()` 的说明。 */
  private contractOf?: (toolName: string) => ResolvedToolContract;

  constructor(
    isEnabled: () => boolean,
    isWithinWorkspace: (path: string, cwd: string) => boolean,
    contractOf?: (toolName: string) => ResolvedToolContract,
  ) {
    this.isEnabled = isEnabled;
    this.isWithinWorkspace = isWithinWorkspace;
    this.contractOf = contractOf;
  }

  async execute(
    toolName: string,
    args: Record<string, unknown>,
    ctx: ToolExecutorContext,
  ): Promise<GuardResult> {
    if (!this.isEnabled()) return { action: "proceed" };

    // 第 121 轮：判据改读 `accessScope`（**访问**了哪类边界），不再读
    // `sideEffectScope`（**改变**了哪类状态）—— 两个概念已拆开（见 tool-contract.ts）。
    //
    // 拆之前用 `sideEffectScope !== "none"` 有个实测后果：51 个工具里 `"none"` 的有
    // **0 个**（因为只读工具为了让沙箱覆盖自己，都被填成了 workspace/network），
    // 于是这个粗筛一次都不命中、对沙箱毫无区分能力。现在 `read` 是
    // `sideEffectScope: "none"` + `accessScope: "workspace"`，语义各归其位。
    const contract = this.contractFor(toolName);
    if (!requiresPathGuard(contract)) return { action: "proceed" };

    // 取路径：读/写工具的入参都叫 `path`（个别历史工具用 `file_path`）。
    // 取不到就放行 —— **这不是漏洞，是有意的边界**：沙箱管的是「路径在不在
    // 工作区内」，而按 id 访问的资源（附件）根本没有路径可判。
    // 「附件不算沙箱范围」是产品决策，见 `src/test/sandbox-boundary.test.ts`。
    const path = (args.path || args.file_path) as string;
    if (!path) {
      /**
       * 第 97 波：**沙箱也要管住 shell 的路径**。
       *
       * 原来这里一句 `return { action: "proceed" }` —— 判据是"入参里没有 path 就放行"（附件那种
       * 按 id 访问的资源确实判不了）。但 `bash` 的入参是 `command` / `workdir`：**它的路径藏在命令文本里**，
       * 于是"沙箱已开启"时，`read C:\other\file` 被拒、而
       * `bash { command: "Get-Content C:\\other\\file" }` **照样读得到**。
       *
       * 实测后果（真实仓库档评测）：工作区的 git 已经修干净了（历史里只有 bug 状态、参考解不可达），
       * 被测 agent 直接跑去**隔壁主仓库**把参考解读走：
       *   `cd C:\mimo-gui; git show HEAD:src/core/llm/edit-matchers.ts | Select-String 'findAmbiguousLiteral'`
       * 那一次 21 次工具调用碰了工作区之外 ⇒ 成绩作废。
       *
       * 判据（见 `src/test/sandbox-shell-path-leak.test.ts`）：
       * 命令文本里的**绝对路径**（含盘符 / UNC）与**含 `..` 的相对路径**、以及 `workdir`，
       * 只要解析出来在工作区之外就拒绝；URL（`https://…`）与变量（`$env:X` / `%X%`）不算路径。
       *
       * ⚠️ 边界（写在明处，别当它是密不透风的）：这是**文本层**的判据，不是内核级隔离 ——
       * 变量拼出来的路径、编码后的路径、脚本里二次构造的路径都拦不住。
       * 所以评测那边还有一道"污染检测"兜底（`.preview-shot/_codem-repo-eval.mjs` 的 `contaminated`）。
       */
      const leak = findOutOfWorkspacePath(args, ctx.cwd, (p, cwd) => this.isWithinWorkspace(p, cwd));
      if (leak) {
        return {
          action: "deny",
          denyMessage:
            `Sandbox: the command references "${leak}" which is outside the workspace "${ctx.cwd}". ` +
            `The sandbox is enabled — disable it in settings or stay within the workspace.`,
        };
      }
      return { action: "proceed" };
    }

    // Resolve relative paths
    let resolvedPath = path;
    if (!/^[A-Za-z]:[\\/]/.test(path) && !path.startsWith("/")) {
      const sep = ctx.cwd.includes("/") && !ctx.cwd.includes("\\") ? "/" : "\\";
      resolvedPath = ctx.cwd.replace(/[\\/]+$/, "") + sep + path.replace(/^[\\/]+/, "");
    }

    if (!this.isWithinWorkspace(resolvedPath, ctx.cwd)) {
      // 文案按工具类别说清楚：原来对**所有**工具都说 "Write to"，
      // 于是「读操作被沙箱拒绝」时用户看到「写入被拒绝」，排查方向被带偏。
      // 现在三态由契约给出（`destructive` / `readOnly`），不再靠名单。
      const verb = contract.destructive ? "Delete" : allowedInReadOnlyMode(contract) ? "Read from" : "Write to";
      return {
        action: "deny",
        denyMessage: `Sandbox: ${verb} "${path}" is outside the workspace "${ctx.cwd}". The sandbox is enabled — disable it in settings or use a path within the workspace.`,
      };
    }
    return { action: "proceed" };
  }

  /** 取契约；未注入 `contractOf` 时按「访问工作区」保守处理（不放行）。 */
  private contractFor(toolName: string): ResolvedToolContract {
    if (this.contractOf) {
      try {
        return this.contractOf(toolName);
      } catch {
        // 查询器抛错 ⇒ 保守：当作会访问外部边界（继续走路径检查）
      }
    }
    return { ...resolveToolContract(undefined, toolName), accessScope: "workspace" };
  }
}

/**
 * Plan mode guard middleware (guard layer)
 *
 * 计划模式是「只读契约」，所以本守卫的判据是 **`contract.readOnly`** ——
 * 不是「工具名在不在写工具名单里」。
 *
 * 第 120 轮之前这里有两问题：
 * 1. 名单硬编码（`delete`、`delete_file` 都不对应真实工具，而真实的
 *    `delete_note` / `job_kill` / `cordis_undo` 之类写手段不在名单里）；
 * 2. 于是「计划模式只读」这个承诺只能靠名单碰巧写对来维持。
 *
 * 现在一个只读工具天然放行、非只读天然拦下，**新增写工具不需要谁记得登记**。
 * `bash` / `terminal` 这类「同一工具既可能只读也可能写」的，额外按命令意图判
 * （见下面第 83 波那段）。
 */
export class PlanModeGuard implements GuardMiddleware {
  name = "plan-mode";
  private isPlanMode: () => boolean;
  private contractOf?: (toolName: string) => ResolvedToolContract;

  constructor(isPlanMode: () => boolean, contractOf?: (toolName: string) => ResolvedToolContract) {
    this.isPlanMode = isPlanMode;
    this.contractOf = contractOf;
  }

  private contractFor(toolName: string): ResolvedToolContract {
    if (this.contractOf) {
      try {
        return this.contractOf(toolName);
      } catch {
        // 查询器抛错 ⇒ 保守：当作非只读（计划模式宁严不宽）
      }
    }
    return { ...resolveToolContract(undefined, toolName), readOnly: false };
  }

  async execute(
    toolName: string,
    args: Record<string, unknown>,
    _ctx: ToolExecutorContext,
  ): Promise<GuardResult> {
    if (!this.isPlanMode()) return { action: "proceed" };

    const contract = this.contractFor(toolName);

    /**
     * 第 83 波（审计修正）：**bash 也是写手段**。
     *
     * 原来这份名单里没有 shell 类工具 —— 于是计划模式（只读契约）下
     * `Set-Content -Path src/x.ts -Value '…'`、`Remove-Item …` 照样能执行，
     * "计划模式只读"这个承诺被绕过。现在按命令意图判定：只读查询放行，
     * 其余（写/危险/认不出的）一律拒绝，并把原因说清楚。
     *
     * 第 121 轮：这段逻辑抽成 `isShellLike()` 并写明理由 —— 它是本仓**唯一**
     * 一处必须按工具名特判的地方。隐式留在守卫里会让「契约化已经消灭了按名
     * 硬编码」这个结论变得不准确。
     */
    if (isShellLike(toolName, contract)) {
      const command = String((args as any)?.command ?? (args as any)?.cmd ?? "");
      // 没有 command 参数的系统类工具（例如终端会话操作）：除非契约声明只读，否则拦下
      if (!command) {
        return contract.readOnly
          ? { action: "proceed" }
          : {
              action: "deny",
              denyMessage: `Blocked: Cannot use "${toolName}" in Plan mode. Plan mode is read-only. Ask the user to switch to Default mode to execute changes.`,
            };
      }

      let classification: "readonly" | "write" | "dangerous" = "write";
      try {
        classification = analyzeBashCommand(command).classification as any;
      } catch {
        classification = "write"; // 判不出来按"会写"处理（计划模式是只读契约，宁严不宽）
      }
      if (classification !== "readonly") {
        return {
          action: "deny",
          denyMessage:
            `Blocked: Plan mode is read-only — this ${toolName} command looks like "${classification}" (not a read-only query).\n` +
            `Command: ${command.slice(0, 160)}\n` +
            `Ask the user to approve the plan (switch to Default mode) before executing changes.`,
        };
      }

      /**
       * 命令意图是只读 ⇒ **直接放行，不再看工具的 `readOnly` 声明**。
       *
       * 这里踩过一次坑（PLAN-4 当场红）：`bash` / 终端类工具是「同一工具
       * 既可能只读也可能写」的 —— 它们的契约**不能**是 `readOnly: true`
       * （那会让 `Set-Content` 也走只读通道）。所以判据必须是**命令意图**，
       * 而不是工具声明。
       *
       * 第一版写成「命令只读 ⇒ 落到下面那句 `if (!contract.readOnly) deny`」，
       * 于是 `Get-ChildItem -Path src` 这种纯只读查询也被拦下 ——
       * 计划模式直接没法调研，这正是第 83 波想修的反面。
       */
      return { action: "proceed" };
    }

    // 只读工具（由契约声明）天然放行；其余一律拦下。
    // 这一条替代了旧的写工具名单 —— 新增写工具只要没声明 readOnly 就会被拦住，
    // 不需要谁记得把它加进名单。
    if (!contract.readOnly) {
      return {
        action: "deny",
        denyMessage: `Blocked: Cannot use "${toolName}" in Plan mode. Plan mode is read-only. Ask the user to switch to Default mode to execute changes.`,
      };
    }

    return { action: "proceed" };
  }
}

/**
 * Security scan middleware (pre-execute layer)
 *
 * 扫描工具参数里是否出现**明文凭据**（sk-/Bearer/password:/私钥头…）。
 *
 * 第 84 波（审计修正）：这个中间件原来是**空的** —— 匹配到模式后直接
 * `return { action: "proceed" }`，注释却写着 "we'll append to result in post-execute"，
 * 而根本没有对应的 post-execute 实现。也就是说它给了"有安全检查"的错觉，
 * 实际什么也没做、什么也没记。
 *
 * 现在：真正把命中记录下来（工具名 + 模式名 + **脱敏**上下文），
 * 让"模型把密钥写进文件/命令"这类事故在运行日志里可追溯。
 * 面向用户的提示由 streaming-executor 的 `scanParametersForSecrets` 追加到工具结果里
 * （那条路径覆盖每一次工具调用，且会把警告显示给模型）。
 *
 * 有意**不阻断**：写 `.env`、生成密钥文件、把 token 传给 CLI 都是合法操作；
 * 这里只负责"让事情可见"，不替用户决定。
 */
export class SecurityScanMiddleware implements PreExecuteMiddleware {
  name = "security-scan";

  private sensitivePatterns: Array<{ name: string; re: RegExp }> = [
    { name: "api-key", re: /(?:sk-|pk-|Bearer\s+)[a-zA-Z0-9]{20,}/i },
    { name: "password", re: /(?:password|passwd|pwd)\s*[:=]\s*\S+/i },
    { name: "secret-or-token", re: /(?:secret|token)\s*[:=]\s*\S+/i },
    { name: "private-key", re: /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----/i },
  ];

  async execute(
    toolName: string,
    args: Record<string, unknown>,
    _ctx: ToolExecutorContext,
  ): Promise<PreExecuteResult> {
    const scanTools = ["write", "edit", "multi_edit", "bash"];
    if (!scanTools.includes(toolName)) return { action: "proceed" };

    const argsStr = JSON.stringify(args);
    const hits = this.sensitivePatterns.filter((p) => p.re.test(argsStr)).map((p) => p.name);
    if (hits.length > 0) {
      console.warn(
        `[SecurityScan] ${toolName} 的参数疑似包含明文凭据（${hits.join("、")}）—— 已放行，未做改动。` +
          `如果这不是有意的（例如写入 .env/密钥文件），请检查是否有密钥被意外写进代码或提交。`,
      );
    }
    return { action: "proceed" };
  }
}

/**
 * Hook PreExecute middleware (pre-execute layer)
 * S0-2: Wraps HookManager.executePreToolHooks as a pipeline middleware.
 * Hooks can deny (block) or modify the tool input.
 */
export class HookPreExecuteMiddleware implements PreExecuteMiddleware {
  name = "hooks-pre";

  async execute(
    toolName: string,
    args: Record<string, unknown>,
    ctx: ToolExecutorContext,
  ): Promise<PreExecuteResult> {
    try {
      const { getHookManager } = await import("../hooks/hook-manager");
      const hookManager = getHookManager();
      const result = await hookManager.executePreToolHooks(toolName, args, {
        sessionId: ctx.sessionId,
        toolName,
        input: args,
        cwd: ctx.cwd,
      });

      if (result.action === "deny") {
        return { action: "deny", denyMessage: result.denyMessage || `Blocked by hook` };
      }
      if (result.action === "modify" && result.modifiedInput) {
        return { action: "modify", modifiedArgs: result.modifiedInput };
      }
      return { action: "proceed" };
    } catch (err: any) {
      // Hooks are non-blocking — don't fail the tool execution
      console.warn(`[HookPreExecute] Error (non-blocking): ${err.message}`);
      return { action: "proceed" };
    }
  }
}

/**
 * Hook PostExecute middleware (post-execute layer)
 * S0-2: Wraps HookManager.executePostToolHooks as a pipeline middleware.
 * Hooks can modify the tool output.
 */
export class HookPostExecuteMiddleware implements PostExecuteMiddleware {
  name = "hooks-post";

  async execute(
    toolName: string,
    args: Record<string, unknown>,
    result: ToolCallResult,
    ctx: ToolExecutorContext,
  ): Promise<PostExecuteResult> {
    if (!result.output) return { action: "keep" };

    try {
      const { getHookManager } = await import("../hooks/hook-manager");
      const hookManager = getHookManager();
      const hookedOutput = await hookManager.executePostToolHooks(toolName, args, result.output, {
        sessionId: ctx.sessionId,
        toolName,
        input: args,
        result: result.output,
        cwd: ctx.cwd,
      });

      if (hookedOutput !== result.output) {
        return { action: "replace", replacedOutput: hookedOutput };
      }
      return { action: "keep" };
    } catch (err: any) {
      console.warn(`[HookPostExecute] Error (non-blocking): ${err.message}`);
      return { action: "keep" };
    }
  }
}

/**
 * 结果契约校验 + 渲染（finalize 层）。
 *
 * ## 第 121 轮：从「恒真」改成真校验
 *
 * 这个中间件此前调的是 `validateToolOutput`（`output-contract.ts`），而那份实现
 * 在**没有任何工具注册契约**时会走 `if (!contract?.schema) return { valid: true }`
 * 这条短路 —— 实测全仓 `registerOutputContract(` 零命中，所以它**永远恒真**；
 * 而且即使验失败也只 `console.warn` 后放行。
 *
 * 现在改读工具**自己声明的** `contract.outputSchema`：
 * - 声明了 ⇒ 校验 `result.value`，**违规就拦**（把可行动的错误还给模型，
 *   而不是让一份形状错误的数据继续往下流）；
 * - 声明了且提供了 `renderOutput` ⇒ 用它把 `value` 渲染成 `output`；
 * - 没声明 ⇒ 原样放行（老工具零变化）。
 *
 * ## 为什么违规要拦而不是只告警
 *
 * DSH 的做法是直接 `throw new ToolOutputError`（`core/tools/src/index.ts:1796`）。
 * 我们**不抛**，而是把它变成一条 `status: "error"` + `errorSource: "tool"` 的结果——
 * 这样模型能看到「我拿到的形状不对，应该是什么样」并自行纠正，而不是整轮崩掉
 * （与第 84 波对工具失败的处理同取向）。
 *
 * 但**必须让用户也可见**：`errorSource: "tool"` 的结果会走 `tool_complete`
 * 带 error 状态，界面显示失败。这正是旧实现缺的那一环。
 */
class OutputContractValidationMiddleware implements FinalizeMiddleware {
  name = "output-contract";

  private rawContractOf?: (toolName: string) => ToolContract | undefined;

  constructor(rawContractOf?: (toolName: string) => ToolContract | undefined) {
    this.rawContractOf = rawContractOf;
  }

  async execute(
    toolName: string,
    _args: Record<string, unknown>,
    result: ToolCallResult,
    _ctx: ToolExecutorContext,
    events: PipelineEvent[],
  ): Promise<ToolCallResult> {
    // 工具**自己汇报**的失败（errorSource: `tool`，例如 glob 的 catch 分支）已经是一句
    // 可行动的错误文本，不能再被包装一次 —— 否则模型看到的是「格式违规」而不是
    // 真正的原因（这类遮蔽在本仓出过多次，所以显式挡掉）。
    //
    // 第 97 波：**循环合成的结果**（`errorSource: "loop"`）也挡掉。它们不是工具产出的，
    // 自然没有工具的 `value`：读缓存命中 / 重复写被跳过 / 守卫抑制都是这种形态。
    // 不挡的后果是真机上的四个主力工具全废（每次缓存命中都变成
    // `Error: read declared outputSchema but returned no value`）。
    if (result.status === "error" || result.errorSource === "tool" || result.errorSource === "loop") return result;

    const declared = this.rawContractOf?.(toolName);
    if (!declared?.outputSchema) {
      // 未声明结果契约 ⇒ 零变化（这是渐进路径的关键：不给老工具引入风险）
      return result;
    }

    // 声明了契约却没给值 ⇒ 这是**实现漏了**，不是数据违规。如实报出来。
    //
    // 第 97 波：**但"没给值"绝不许把工具自己的失败文本顶掉**。
    // 真机形态：`read` 一个不存在的文件 → 工具返回 `Error: 系统找不到指定的文件。`
    // （内容型工具不会被文本推断成失败，所以没走上面的早退），契约层于是把它换成
    // `Error: read declared outputSchema but returned no value` —— 真正的原因（文件不存在）
    // 就此消失，模型也没法纠正。现在：输出本身就是一句失败 ⇒ 保留它，只把契约问题
    // 记一条 warn 给开发者看。
    if (result.value === undefined) {
      const text = String(result.output ?? "");
      if (/^\s*(?:error|错误|失败)\s*[:：-]/i.test(text)) {
        console.warn(
          `[tool-contract] ${toolName} 声明了 outputSchema 但这次没给 value（输出是一句失败，原样透传）: ${text.slice(0, 160)}`,
        );
        return { ...result, status: "error", error: text.split("\n", 1)[0], errorSource: "tool" };
      }
      events.push({
        layer: "finalize",
        middleware: "output-contract",
        action: "deny",
        timestamp: Date.now(),
      });
      return {
        ...result,
        status: "error",
        errorSource: "tool",
        output:
          `Error: ${toolName} declared outputSchema but returned no \`value\`. ` +
          `Return the structured value so it can be validated.`,
      };
    }

    const { output, violations } = validateAndRenderOutput(
      { outputSchema: declared.outputSchema, renderOutput: declared.renderOutput },
      result.value,
    );

    if (violations.length > 0) {
      events.push({
        layer: "finalize",
        middleware: "output-contract",
        action: "deny",
        timestamp: Date.now(),
      });
      return {
        ...result,
        status: "error",
        errorSource: "tool",
        output:
          `Error: ${toolName} returned a value that violates its declared outputSchema:\n` +
          violations.map((v) => `  - ${v.path}: ${v.message}`).join("\n"),
      };
    }

    // 渲染成功 ⇒ 用渲染结果作为模型可见文本（结构化值保留在 result.value 上）
    return { ...result, output };
  }
}

/**
 * Event log finalize middleware (finalize layer)
 * Writes tool_call and tool_result events to the event log.
 */
let warnedEventLogFatal = false;

export class EventLogFinalizeMiddleware implements FinalizeMiddleware {
  name = "event-log";

  async execute(
    toolName: string,
    args: Record<string, unknown>,
    result: ToolCallResult,
    ctx: ToolExecutorContext,
    _events: PipelineEvent[],
  ): Promise<ToolCallResult> {
    try {
      const { getEventLog } = await import("../storage/event-log");
      const eventLog = getEventLog();

      /**
       * ⚠️ **不能只写 `result.id`**（第 71 轮真机实测）：工具处理器返回的结果里
       * `id` 一直是空串（`agentic-loop.ts` 里的 `id: ""` 是字面量），于是事件日志里
       * 每条 `tool_call` / `tool_result` 的 `toolCallId` 都是空 —— 事件日志是
       * "执行轨迹 / 事后复盘"的数据源，空 id 让这些记录没法回指到具体调用。
       * 调用 id 由 `streaming-executor` 按次注入 ctx（见 `ToolExecutorContext.toolCallId`）。
       */
      const toolCallId = result.id || ctx.toolCallId || "";

      eventLog.append(ctx.sessionId, "tool_call", {
        toolCallId,
        messageId: ctx.messageId,
        tool: toolName,
        args,
        status: result.status,
      });

      eventLog.append(ctx.sessionId, "tool_result", {
        toolCallId,
        messageId: ctx.messageId,
        result: result.output,
        error: result.error,
        status: result.status === "error" ? "error" : "completed",
      });
    } catch (err) {
      /**
       * 第 90 波（用户现场）：数据库崩掉后，这里**每次工具调用**都打一行
       * "Failed to write tool events (non-critical)"，日志里同类错误刷满屏，
       * 而且看不出"数据库整体已经不可用"这个真正的问题。
       * 现在：存储不可用只提示一次，不再逐次刷屏。
       *
       * 第 18 轮：判据从 `isDatabaseFatal()`（旧引擎致命态，rust 下恒为 false）
       * 换成 `storageUnavailable()`（端口未注册 = 本进程没有可用存储）。
       * 抢救会话那件事现在由 App 监听 `codem:storage-unavailable` 负责
       * （生产者是 bootstrap 的注册失败路径，见 `storage/health.ts`）。
       */
      const { storageUnavailable } = await import("../storage/health");
      if (storageUnavailable()) {
        if (!warnedEventLogFatal) {
          warnedEventLogFatal = true;
          console.warn(
            "[EventLogFinalize] 存储不可用，停止写入工具事件（本次运行内不再提示；界面已提示抢救当前会话）",
          );
        }
      } else {
        console.warn("[EventLogFinalize] Failed to write tool events (non-critical):", err);
      }
    }

    return result;
  }
}

// ========== Singleton ==========

let pipelineInstance: ToolPipeline | null = null;

export function getToolPipeline(): ToolPipeline {
  if (!pipelineInstance) {
    pipelineInstance = new ToolPipeline();
  }
  return pipelineInstance;
}

/**
 * Initialize the default tool pipeline with built-in middlewares.
 * Called once during application startup.
 */
export async function initDefaultPipeline(config: {
  isPlanMode: () => boolean;
  isSandboxEnabled: () => boolean;
  isPathWithinWorkspace: (path: string, cwd: string) => boolean;
  checkPermission: (
    toolName: string,
    args: Record<string, unknown>,
    ctx: ToolExecutorContext,
  ) => Promise<{ allowed: boolean; denyMessage?: string }>;
  /**
   * 契约查询器（第 120 轮）。
   *
   * 沙箱/计划模式这些守卫原来是**按工具名硬编码名单**判断「要不要管这个工具」，
   * 名单里还混着 `read_file` / `cat` / `find` 等不对应任何真实工具的幽灵名。
   * 改为读工具自己的声明：`sideEffectScope !== "none"` ⇒ 碰外部世界 ⇒ 要管。
   *
   * 未注入时守卫退化为「不介入」（保守），调用方（`agentic-loop`）会注入。
   */
  contractOf?: (toolName: string) => ResolvedToolContract;
  /**
   * 原始契约查询器（第 121 轮）。
   *
   * `contractOf` 给的是**解析后的值**（判据用）；这个给的是**原始声明**，
   * 因为归一化与结果渲染是**行为钩子**，解析后的契约刻意不带函数。
   */
  rawContractOf?: (toolName: string) => ToolContract | undefined;
  /** 工具定义查询器（入参校验用）。未注入时跳过入参校验。 */
  toolDefOf?: (toolName: string) => ToolDef | undefined;
  /** R3-1.1: Spill policy — 超过此字节大小的纯文本工具输出被溢出存储 + 替换为预览 */
  maxInlineBytes?: number;
}): Promise<ToolPipeline> {
  const pipeline = getToolPipeline();
  pipeline.clear();

  // 并发分类器：名单唯一定义在 concurrency-policy.ts。
  // 此处曾硬编码另一份 9 名字名单（含 read_file / list_dir / zvec_grep_rg 等
  // 不对应任何真实工具的幽灵名），与 streaming-executor 的默认名单**互不一致** ——
  // 同一个概念两份真相，其中一份还整体失效。现在统一来源。
  //
  // 注：第 120 轮起并发的主判据也改成了工具契约（`streaming-executor`
  // 的 `contractOf`）；这里注册的分类器供**管线内部**查询使用，保留名字来源
  // 以兼容运行时注册的工具（MCP）。
  for (const toolName of CONCURRENCY_SAFE_TOOL_IDS) {
    pipeline.registerConcurrency(toolName, () => true);
  }

  // Layer 1: pre-execute
  pipeline.registerPreExecute(new PermissionMiddleware(config.checkPermission));
  pipeline.registerPreExecute(new SecurityScanMiddleware());
  // S0-2: HookManager PreToolUse hooks as pre-execute middleware
  pipeline.registerPreExecute(new HookPreExecuteMiddleware());

  // Layer 2: guards (monotonic — order is frozen)
  pipeline.registerGuard(new PlanModeGuard(config.isPlanMode, config.contractOf));
  pipeline.registerGuard(
    new SandboxGuard(config.isSandboxEnabled, config.isPathWithinWorkspace, config.contractOf),
  );

  // Layer 3: execute (handled by toolHandler in pipeline.execute())

  // Layer 4: post-execute
  // R3-1.2: RepeatToolReminder — 连续相同调用检测 + 升级提醒
  // 放在 hooks 之前：先检测重复，再让 hooks 处理结果
  pipeline.registerPostExecute(new RepeatToolReminderMiddleware());

  // R3-1.1: SpillPolicy — 必须在 hooks 之前注册（prepend 语义），
  // 因为 spill 需要先委托下游（hooks）处理后再 bound 最终结果。
  // 但我们的管线是顺序执行（非 prepend），所以 spill 放在 hooks 之后
  // — hooks 可能修改输出，spill 再 bound 修改后的结果。
  pipeline.registerPostExecute(new HookPostExecuteMiddleware());
  if (config.maxInlineBytes !== undefined && config.maxInlineBytes > 0) {
    const { SpillPolicyMiddleware } = await import("./spill-policy");
    pipeline.registerPostExecute(new SpillPolicyMiddleware({ maxInlineBytes: config.maxInlineBytes }));
  }

  // Layer 5: finalize
  pipeline.setRawContractOf(config.rawContractOf ?? (() => undefined));
  pipeline.setToolDefOf(config.toolDefOf ?? (() => undefined));
  pipeline.registerFinalize(new OutputContractValidationMiddleware(config.rawContractOf));
  pipeline.registerFinalize(new EventLogFinalizeMiddleware());

  return pipeline;
}
