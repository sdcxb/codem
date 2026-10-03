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
        result: {
          id: ctx.messageId,
          name: currentName,
          input: currentArgs,
          output: "Error: tool call aborted before dispatch",
          status: "error",
          error: "ABORTED_BEFORE_DISPATCH",
        },
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
          result: {
            id: ctx.messageId,
            name: currentName,
            input: args,
            output: msg,
            status: "error",
            // errorSource:"tool" ⇒ 让模型看到文本并自行纠正，不累加连续错误
            errorSource: "tool",
            error: msg,
          },
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
          result: {
            id: ctx.messageId,
            name: currentName,
            input: currentArgs,
            output: `Error: ${msg}`,
            status: "error",
            errorSource: "tool",
            error: msg,
          },
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
          result: {
            id: ctx.messageId,
            name: currentName,
            input: currentArgs,
            output: result.denyMessage || "Denied by pre-execute middleware",
            status: "error",
            error: result.denyMessage,
          },
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
          result: {
            id: ctx.messageId,
            name: currentName,
            input: currentArgs,
            output: result.denyMessage || "Denied by guard",
            status: "error",
            error: result.denyMessage,
          },
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
            result: {
              ...result,
              output: postResult.rejectMessage || "Rejected by post-execute middleware",
              status: "error",
              // 明确标注：这是管线层的拒绝，不是工具自报失败（不要被上面的 ...result 带成 "tool"）
              errorSource: "pipeline",
            },
            events,
          };
      }
    }

    // ===== Layer 5: finalize (freeze) =====
    for (const mw of this.finalizeMiddlewares) {
      result = await mw.execute(currentName, currentArgs, result, ctx, events);
    }
    events.push({
      layer: "finalize",
      middleware: "pipeline",
      action: "finalized",
      timestamp: Date.now(),
    });

    return { result, events, concurrencySafe };
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
export class PermissionMiddleware implements PreExecuteMiddleware {
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
 * Sandbox guard middleware (guard layer)
 * Checks if file paths are within the workspace when sandbox mode is enabled.
 */
export class SandboxGuard implements GuardMiddleware {
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
    if (!path) return { action: "proceed" };

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
    if (result.value === undefined) {
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
