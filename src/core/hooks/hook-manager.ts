/**
 * Hook Manager — Registration, matching, and execution of hooks
 *
 * Design (from CLAUDE-CODE-IMPACT-ANALYSIS.md):
 *
 * 1. Hooks are stored in settings (getSettingJSON/setSettingJSON)
 * 2. PreToolUse hooks run AFTER permission check, BEFORE tool.execute()
 * 3. If a hook returns "deny", the tool is not executed
 * 4. If a hook returns "modify", the input is replaced
 * 5. Hook timeout default 10s — timeout = skip (don't block tool)
 * 6. Command hooks execute via executeCommand (shell)
 * 7. Function hooks evaluate JS in a safe manner
 *
 * Impact analysis notes:
 * - Sub-agents don't inherit PreToolUse hooks (prevents recursion)
 * - Hook deny creates snapshot but no write → harmless waste
 * - readCache key must use modified path if hook modifies input
 */

import { getSettingJSON, setSettingJSON } from "../storage/settings";
import { executeCommand } from "../file-api";
import {
  type HookDefinition,
  type HookConfig,
  type HookContext,
  type PreToolHookResult,
  type PostToolHookResult,
  type HookEventType,
  DEFAULT_HOOK_CONFIG,
  shouldFireHook,
} from "./hook-types";

// ========== Constants ==========

const SETTINGS_KEY = "codem-hooks-config";
const DEFAULT_HOOK_TIMEOUT_MS = 10_000;

// ========== Hook Manager ==========

/**
 * 运行时钩子（程序注册，不落盘）。
 *
 * 第 86 波（审计修正）：`hooks-provider.ts` 一直把 `ctx.get('hooks')` 暴露成一个
 * 有 `register` / `unregister` / `executeHooks` / `listHooks` / `clearAllHooks` 的服务，
 * 并声称"第三方插件通过 ctx.hooks.register() 注册自定义钩子"、
 * "ToolPipeline 会调用 ctx.hooks.executeHooks('PreToolUse', …)"。
 * 但 `HookManager` **根本没有这些方法**（只有基于 settings 配置的钩子），于是：
 *   · 任何插件调用 `ctx.hooks.register(...)` 直接 TypeError；
 *   · provider 里的 `clearAllHooks()` 是空函数（注释说"Map 会自动回收"，
 *     但那个 manager 仍被 service 引用着），禁用插件不会清任何东西；
 *   · `_active: true` 让上层以为钩子服务可用。
 *
 * 现在补上真正的运行时钩子（内存、不落盘、进程内生命周期），并让 Pre/PostToolUse
 * 执行链同时跑它们 —— provider 的承诺从此成立。
 */
export interface RuntimeHook {
  id: string;
  event: HookEventType;
  name: string;
  handler: (payload: any) => any;
  timeoutMs: number;
}

export class HookManager {
  private config: HookConfig;
  /** Whether hooks are enabled globally */
  private enabled: boolean = true;
  /** Whether this is a sub-agent context (PreToolUse hooks disabled) */
  private subAgentMode: boolean = false;
  /** 程序注册的运行时钩子（内存，不写 settings） */
  private runtimeHooks: RuntimeHook[] = [];
  private runtimeHookSeq = 0;

  constructor() {
    this.config = this.loadConfig();
  }

  // ========== Runtime hooks（程序注册） ==========

  /** 注册一个运行时钩子，返回可传给 unregister 的 id */
  register(event: HookEventType | string, handler: (payload: any) => any, options?: { timeout?: number; name?: string }): string {
    if (typeof handler !== "function") {
      throw new Error(`hooks.register: handler 必须是函数（event=${event}）`);
    }
    const id = `runtime-hook-${++this.runtimeHookSeq}`;
    this.runtimeHooks.push({
      id,
      event: event as HookEventType,
      name: options?.name || `runtime:${event}`,
      handler,
      timeoutMs: options?.timeout ?? DEFAULT_HOOK_TIMEOUT_MS,
    });
    return id;
  }

  /** 注销运行时钩子；返回是否真的删掉了 */
  unregister(event: HookEventType | string, handlerId: string): boolean {
    const before = this.runtimeHooks.length;
    this.runtimeHooks = this.runtimeHooks.filter((h) => !(h.id === handlerId && h.event === event));
    return this.runtimeHooks.length < before;
  }

  /** 列出钩子（配置钩子 + 运行时钩子）；给出 id/event/type 便于排查 */
  listHooks(event?: HookEventType | string): Array<{ id: string; event: string; name: string; type: "config" | "runtime"; enabled: boolean }> {
    const fromConfig = this.config.hooks
      .filter((h) => !event || h.event === event)
      .map((h) => ({ id: h.id, event: String(h.event), name: h.name, type: "config" as const, enabled: h.enabled !== false }));
    const fromRuntime = this.runtimeHooks
      .filter((h) => !event || h.event === event)
      .map((h) => ({ id: h.id, event: String(h.event), name: h.name, type: "runtime" as const, enabled: !this.subAgentMode }));
    return [...fromConfig, ...fromRuntime];
  }

  /** 清空运行时钩子（配置钩子在 settings 里，不在这里删） */
  clearAllHooks(): void {
    this.runtimeHooks = [];
  }

  /** 运行时钩子数量（诊断/测试用） */
  runtimeHookCount(): number {
    return this.runtimeHooks.length;
  }

  /**
   * 通用事件分发：跑该事件下的**运行时**钩子，按注册顺序等待并收集结果。
   * 单个钩子抛错或超时不会中断其它钩子，但会在结果里留下 `{ error }` 记录。
   */
  async executeHooks(event: HookEventType | string, payload: any): Promise<any[]> {
    const hooks = this.runtimeHooks.filter((h) => h.event === event);
    const results: any[] = [];
    for (const hook of hooks) {
      const timeoutMs = hook.timeoutMs > 0 ? hook.timeoutMs : DEFAULT_HOOK_TIMEOUT_MS;
      try {
        const value = await Promise.race([
          Promise.resolve(hook.handler(payload)),
          this.timeout(timeoutMs),
        ]);
        results.push(value);
      } catch (e: any) {
        const message = e?.message || String(e);
        console.warn(`[HookManager] runtime hook "${hook.name}" (${event}) 失败：${message}`);
        results.push({ error: message, hookId: hook.id });
      }
    }
    return results;
  }

  // ========== Config ==========

  loadConfig(): HookConfig {
    try {
      return getSettingJSON<HookConfig>(SETTINGS_KEY, DEFAULT_HOOK_CONFIG);
    } catch {
      return DEFAULT_HOOK_CONFIG;
    }
  }

  saveConfig(config: HookConfig): void {
    this.config = config;
    setSettingJSON(SETTINGS_KEY, config);
    window.dispatchEvent(new CustomEvent("codem-hooks-config-changed"));
  }

  getConfig(): HookConfig {
    return this.config;
  }

  addHook(hook: HookDefinition): void {
    const config = this.getConfig();
    config.hooks.push(hook);
    this.saveConfig(config);
  }

  removeHook(id: string): void {
    const config = this.getConfig();
    config.hooks = config.hooks.filter(h => h.id !== id);
    this.saveConfig(config);
  }

  updateHook(id: string, updates: Partial<HookDefinition>): void {
    const config = this.getConfig();
    const idx = config.hooks.findIndex(h => h.id === id);
    if (idx >= 0) {
      config.hooks[idx] = { ...config.hooks[idx], ...updates };
      this.saveConfig(config);
    }
  }

  // ========== Mode Control ==========

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  setSubAgentMode(isSubAgent: boolean): void {
    this.subAgentMode = isSubAgent;
  }

  // ========== Hook Execution ==========

  /**
   * Execute PreToolUse hooks for a tool.
   * Returns the combined result (first deny wins, last modify applies).
   */
  async executePreToolHooks(
    toolName: string,
    input: Record<string, unknown>,
    ctx: HookContext,
  ): Promise<PreToolHookResult> {
    // Skip if hooks disabled or sub-agent mode
    if (!this.enabled || this.subAgentMode) {
      return { action: "allow" };
    }

    const hooks = this.config.hooks.filter(h =>
      shouldFireHook(h, "PreToolUse", toolName, input),
    );

    // 第 86 波：运行时钩子（程序注册）与配置钩子同源参与判定
    const runtimeHooks = this.runtimeHooks.filter((h) => h.event === "PreToolUse");

    if (hooks.length === 0 && runtimeHooks.length === 0) {
      return { action: "allow" };
    }

    let currentInput = input;

    for (const hook of hooks) {
      try {
        const result = await this.executeSingleHook(hook, {
          ...ctx,
          toolName,
          input: currentInput,
        });

        if (result.action === "deny") {
          return {
            action: "deny",
            denyMessage: result.denyMessage || `Blocked by hook "${hook.name}"`,
          };
        }

        if (result.action === "modify") {
          if (result.modifiedInput) {
            currentInput = result.modifiedInput;
          } else {
            // 声明要改参数却没给参数：不能当成"没发生"，否则钩子静默失效
            const message = `Hook "${hook.name}" returned action "modify" without modifiedInput — blocked instead of silently running the original input`;
            console.warn(`[HookManager] ${message}`);
            return { action: "deny", denyMessage: message };
          }
        }
      } catch (error: any) {
        // 第 84 波：原来无论钩子出什么错都"继续放行"。守卫失败 ≠ 通过。
        const message = `PreToolUse hook "${hook.name}" threw: ${error?.message || error}`;
        console.warn(`[HookManager] ${message}`);
        if (!hook.allowOnError) {
          return {
            action: "deny",
            denyMessage: `${message}（守卫钩子未生效，默认拦下；如确需放行请为该钩子设置 allowOnError）`,
          };
        }
      }
    }

    // If input was modified, return the modified input
    if (currentInput !== input) {
      return { action: "modify", modifiedInput: currentInput };
    }

    /**
     * 运行时钩子（第 86 波）：
     *   · 返回 undefined / null → "没有意见"（放行，继续问下一个）；
     *   · 返回 `{action:"allow"|"deny"|"modify"}` → 按语义处理；
     *   · 返回**无法识别**的东西 → 拦下（与函数钩子同一套 fail-closed 规则，
     *     否则插件写错 action 名字会静默变成"放行"）；
     *   · 钩子抛错/超时 → 拦下并说明（守卫没生效 ≠ 通过）。
     */
    for (const hook of runtimeHooks) {
      let value: any;
      try {
        value = await Promise.race([
          Promise.resolve(hook.handler({ event: "PreToolUse", toolName, input: currentInput, ctx })),
          this.timeout(hook.timeoutMs > 0 ? hook.timeoutMs : DEFAULT_HOOK_TIMEOUT_MS),
        ]);
      } catch (error: any) {
        const message = `Runtime PreToolUse hook "${hook.name}" failed: ${error?.message || error}`;
        console.warn(`[HookManager] ${message} — 守卫未生效，fail-closed 拦下`);
        return { action: "deny", denyMessage: message };
      }
      if (value === undefined || value === null) continue;

      const action = value?.action;
      if (action === undefined) continue; // 只是记录/统计，没有裁决
      if (action === "allow") continue;
      if (action === "deny") {
        return { action: "deny", denyMessage: value.denyMessage || `Blocked by runtime hook "${hook.name}"` };
      }
      if (action === "modify") {
        if (value.modifiedInput && typeof value.modifiedInput === "object") {
          currentInput = value.modifiedInput;
          continue;
        }
        const message = `Runtime hook "${hook.name}" returned action "modify" without a valid modifiedInput`;
        console.warn(`[HookManager] ${message} — 拦下`);
        return { action: "deny", denyMessage: message };
      }
      const message = `Runtime hook "${hook.name}" returned an unrecognized action ${JSON.stringify(action)} (expected "allow" | "deny" | "modify")`;
      console.warn(`[HookManager] ${message} — 拦下`);
      return { action: "deny", denyMessage: message };
    }

    if (currentInput !== input) {
      return { action: "modify", modifiedInput: currentInput };
    }

    return { action: "allow" };
  }

  /**
   * Execute PostToolUse hooks for a tool.
   * Returns the (possibly modified) output.
   */
  async executePostToolHooks(
    toolName: string,
    input: Record<string, unknown>,
    output: string,
    ctx: HookContext,
  ): Promise<string> {
    // Skip if hooks disabled
    if (!this.enabled) {
      return output;
    }

    const hooks = this.config.hooks.filter(h =>
      shouldFireHook(h, "PostToolUse", toolName, input),
    );

    const hasRuntimePost = this.runtimeHooks.some((h) => h.event === "PostToolUse");

    if (hooks.length === 0 && !hasRuntimePost) {
      return output;
    }

    let currentOutput = output;

    for (const hook of hooks) {
      try {
        const result = await this.executeSinglePostHook(hook, {
          ...ctx,
          toolName,
          input,
          result: currentOutput,
        });

        if (result.action === "modify" && result.modifiedOutput) {
          currentOutput = result.modifiedOutput;
        }
      } catch (error: any) {
        console.warn(`[HookManager] PostToolUse hook "${hook.name}" error: ${error.message}`);
      }
    }

    // 第 86 波：运行时 PostToolUse 钩子（可返回字符串直接替换输出，或 {modifiedOutput}）
    const runtimePost = this.runtimeHooks.filter((h) => h.event === "PostToolUse");
    for (const hook of runtimePost) {
      try {
        const value = await Promise.race([
          Promise.resolve(hook.handler({ event: "PostToolUse", toolName, input, result: currentOutput, ctx })),
          this.timeout(hook.timeoutMs > 0 ? hook.timeoutMs : DEFAULT_HOOK_TIMEOUT_MS),
        ]);
        if (typeof value === "string") {
          currentOutput = value;
        } else if (value && typeof value === "object" && typeof (value as any).modifiedOutput === "string") {
          currentOutput = (value as any).modifiedOutput;
        }
      } catch (error: any) {
        console.warn(`[HookManager] Runtime PostToolUse hook "${hook.name}" failed: ${error?.message || error}`);
      }
    }

    return currentOutput;
  }

  /**
   * Execute SessionStart hooks.
   */
  async executeSessionStartHooks(ctx: HookContext): Promise<void> {
    if (!this.enabled) return;

    const hooks = this.config.hooks.filter(h =>
      h.enabled && h.event === "SessionStart",
    );

    for (const hook of hooks) {
      try {
        await this.executeCommandHook(hook, ctx);
      } catch (error: any) {
        console.warn(`[HookManager] SessionStart hook "${hook.name}" error: ${error.message}`);
      }
    }
  }

  /**
   * Execute Stop hooks.
   */
  async executeStopHooks(ctx: HookContext): Promise<void> {
    if (!this.enabled) return;

    const hooks = this.config.hooks.filter(h =>
      h.enabled && h.event === "Stop",
    );

    for (const hook of hooks) {
      try {
        await this.executeCommandHook(hook, ctx);
      } catch (error: any) {
        console.warn(`[HookManager] Stop hook "${hook.name}" error: ${error.message}`);
      }
    }
  }

  // ========== Internal Execution ==========

  private async executeSingleHook(
    hook: HookDefinition,
    ctx: HookContext,
  ): Promise<PreToolHookResult> {
    if (hook.type === "command" && hook.command) {
      return this.executeCommandPreHook(hook, ctx);
    } else if (hook.type === "function" && hook.function) {
      return this.executeFunctionPreHook(hook, ctx);
    }
    return { action: "allow" };
  }

  private async executeSinglePostHook(
    hook: HookDefinition,
    ctx: HookContext,
  ): Promise<PostToolHookResult> {
    if (hook.type === "command" && hook.command) {
      // Command PostToolUse hooks just run — they don't modify output
      await this.executeCommandHook(hook, ctx);
      return { action: "keep" };
    } else if (hook.type === "function" && hook.function) {
      return this.executeFunctionPostHook(hook, ctx);
    }
    return { action: "keep" };
  }

  /**
   * Execute a command-type PreToolUse hook.
   * Shell command output determines the action:
   * - "DENY" → deny
   * - "MODIFY: <json>" → modify input
   * - Anything else → allow
   *
   * 第 84 波（审计修正）：**退出码必须被读取**。
   * 原来只看 stdout —— 一个 `exit 1` / `exit 7` 的守卫钩子（拦下来最常见的写法）
   * 等于什么都没做：用户以为钩子能拦、实际全部放行。属于"安全阀被缺省分支绕过"。
   * 现在遵循通用钩子约定并 fail-closed：
   *   · 退出码 2            → 拦下（stderr 作为原因）
   *   · 其它非 0 退出码/超时 → 默认**拦下**（钩子没给出裁决 ≠ 允许）；
   *                           仅当 hook.allowOnError === true 时才放行并告警
   *   · 声明了 MODIFY: 但 JSON 非法 → 拦下（原意是改参数，改不成不能当成没这回事）
   */
  private async executeCommandPreHook(
    hook: HookDefinition,
    ctx: HookContext,
  ): Promise<PreToolHookResult> {
    const timeoutMs = hook.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;
    const command = hook.command!;

    try {
      const result = await Promise.race([
        executeCommand(command, ctx.cwd, timeoutMs), // FIX: 超时真正杀进程树
        this.timeout(timeoutMs),
      ]);

      const stdout = (result.stdout || "").trim();
      const stderr = (result.stderr || "").trim();
      const exitCode = typeof result.exitCode === "number" ? result.exitCode : 0;

      if (stdout === "DENY") {
        return {
          action: "deny",
          denyMessage: `Hook "${hook.name}" denied this operation${stderr ? `: ${stderr.slice(0, 300)}` : ""}`,
        };
      }
      if (stdout.startsWith("MODIFY:")) {
        try {
          const json = stdout.substring(7).trim();
          const modifiedInput = JSON.parse(json);
          // 修改后的输入必须是对象，否则 deny（原来返回原参数继续跑 = 静默失效）
          if (!modifiedInput || typeof modifiedInput !== "object" || Array.isArray(modifiedInput)) {
            const message = `Hook "${hook.name}" returned "MODIFY:" but the payload is not a JSON object — blocked instead of running with unmodified input`;
            console.warn(`[HookManager] ${message}`);
            return { action: "deny", denyMessage: message };
          }
          return { action: "modify", modifiedInput };
        } catch (e: any) {
          const message = `Hook "${hook.name}" returned "MODIFY:" with invalid JSON (${e?.message || "parse error"}) — blocked instead of running with unmodified input`;
          console.warn(`[HookManager] ${message}`);
          return { action: "deny", denyMessage: message };
        }
      }

      if (exitCode !== 0) {
        const detail = stderr ? `: ${stderr.slice(0, 300)}` : "";
        const message = `Hook "${hook.name}" exited with code ${exitCode}${detail}`;
        if (hook.allowOnError) {
          console.warn(`[HookManager] ${message} — 按 allowOnError 放行`);
          return { action: "allow" };
        }
        console.warn(`[HookManager] ${message} — 钩子未给出裁决，fail-closed 拦下该工具调用`);
        return { action: "deny", denyMessage: `${message}（钩子未给出裁决，默认拦下；如确需放行请为该钩子设置 allowOnError）` };
      }

      return { action: "allow" };
    } catch (error: any) {
      const isTimeout = String(error?.message || "").includes("timed out");
      const message = isTimeout
        ? `Hook "${hook.name}" timed out after ${timeoutMs}ms`
        : `Hook "${hook.name}" failed to run: ${error?.message || error}`;
      if (hook.allowOnError) {
        console.warn(`[HookManager] ${message} — 按 allowOnError 放行`);
        return { action: "allow" };
      }
      console.warn(`[HookManager] ${message} — 守卫未生效，fail-closed 拦下该工具调用`);
      return { action: "deny", denyMessage: `${message}（守卫钩子未生效，默认拦下；如确需放行请为该钩子设置 allowOnError）` };
    }
  }

  /**
   * Execute a command-type hook (for SessionStart/Stop/PostToolUse).
   * These don't return a result — they just run.
   *
   * 仍不阻塞流程（生命周期钩子没有裁决语义），但**非零退出码不再被吞掉**：
   * 以前一个每次都失败的 SessionStart 钩子完全静默，用户没有任何线索。
   */
  private async executeCommandHook(
    hook: HookDefinition,
    ctx: HookContext,
  ): Promise<void> {
    const timeoutMs = hook.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;
    const command = hook.command!;

    try {
      const result = await Promise.race([
        executeCommand(command, ctx.cwd, timeoutMs), // FIX: 超时真正杀进程树
        this.timeout(timeoutMs),
      ]);
      const exitCode = typeof result?.exitCode === "number" ? result.exitCode : 0;
      if (exitCode !== 0) {
        const stderr = (result?.stderr || "").trim();
        console.warn(
          `[HookManager] Hook "${hook.name}" (${hook.event}) exited with code ${exitCode}${stderr ? `: ${stderr.slice(0, 300)}` : ""}`,
        );
      }
    } catch (error: any) {
      if (String(error?.message || "").includes("timed out")) {
        console.warn(`[HookManager] Hook "${hook.name}" timed out after ${timeoutMs}ms — skipping`);
        return;
      }
      throw error;
    }
  }

  /**
   * Execute a function-type PreToolUse hook.
   * The function body receives (ctx) and returns { action, denyMessage?, modifiedInput? }
   */
  private async executeFunctionPreHook(
    hook: HookDefinition,
    ctx: HookContext,
  ): Promise<PreToolHookResult> {
    // Use Function constructor for sandboxed evaluation
    // Note: this is NOT fully sandboxed — production should use a VM
    try {
      const fn = new Function("ctx", hook.function!);
      const result = fn(ctx);
      if (result && typeof result === "object") {
        const action = (result as PreToolHookResult).action;
        // 第 84 波：返回了无法识别的 action（例如写成 {action:"denied"} / {deny:true}）
        // 时，原来会被下游当成"非 deny 非 modify"→ 静默放行。守卫写法错了必须报错。
        if (action !== "allow" && action !== "deny" && action !== "modify") {
          const message = `Function hook "${hook.name}" returned an unrecognized action ${JSON.stringify(action)} (expected "allow" | "deny" | "modify") — blocked instead of silently allowing`;
          console.warn(`[HookManager] ${message}`);
          return { action: "deny", denyMessage: message };
        }
        return result as PreToolHookResult;
      }
      return { action: "allow" };
    } catch (error: any) {
      const message = `Function hook "${hook.name}" threw: ${error?.message || error}`;
      console.warn(`[HookManager] ${message}`);
      // 与 command 钩子一致：默认 fail-closed，allowOnError 才放行
      if (hook.allowOnError) return { action: "allow" };
      return { action: "deny", denyMessage: `${message}（守卫钩子未生效，默认拦下；如确需放行请为该钩子设置 allowOnError）` };
    }
  }

  /**
   * Execute a function-type PostToolUse hook.
   */
  private async executeFunctionPostHook(
    hook: HookDefinition,
    ctx: HookContext,
  ): Promise<PostToolHookResult> {
    try {
      const fn = new Function("ctx", hook.function!);
      const result = fn(ctx);
      if (result && typeof result === "object") {
        return result as PostToolHookResult;
      }
      return { action: "keep" };
    } catch (error: any) {
      console.warn(`[HookManager] Function hook "${hook.name}" error: ${error.message}`);
      return { action: "keep" };
    }
  }

  private timeout(ms: number): Promise<never> {
    return new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`Hook timed out after ${ms}ms`)), ms);
    });
  }
}

// ========== Singleton ==========

let instance: HookManager | null = null;

export function getHookManager(): HookManager {
  if (!instance) {
    instance = new HookManager();
  }
  return instance;
}

export function resetHookManager(): void {
  instance = null;
}

