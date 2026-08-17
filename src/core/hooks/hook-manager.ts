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

export class HookManager {
  private config: HookConfig;
  /** Whether hooks are enabled globally */
  private enabled: boolean = true;
  /** Whether this is a sub-agent context (PreToolUse hooks disabled) */
  private subAgentMode: boolean = false;

  constructor() {
    this.config = this.loadConfig();
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

    if (hooks.length === 0) {
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

        if (result.action === "modify" && result.modifiedInput) {
          currentInput = result.modifiedInput;
        }
      } catch (error: any) {
        console.warn(`[HookManager] PreToolUse hook "${hook.name}" error: ${error.message}`);
        // On error, continue (don't block the tool)
      }
    }

    // If input was modified, return the modified input
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

    if (hooks.length === 0) {
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
   */
  private async executeCommandPreHook(
    hook: HookDefinition,
    ctx: HookContext,
  ): Promise<PreToolHookResult> {
    const timeoutMs = hook.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;
    const command = hook.command!;

    try {
      const result = await Promise.race([
        executeCommand(command, ctx.cwd),
        this.timeout(timeoutMs),
      ]);

      const stdout = (result.stdout || "").trim();
      if (stdout === "DENY") {
        return { action: "deny", denyMessage: `Hook "${hook.name}" denied this operation` };
      }
      if (stdout.startsWith("MODIFY:")) {
        try {
          const json = stdout.substring(7).trim();
          const modifiedInput = JSON.parse(json);
          return { action: "modify", modifiedInput };
        } catch {
          // Invalid JSON — treat as allow
        }
      }
      return { action: "allow" };
    } catch (error: any) {
      if (error.message.includes("timed out")) {
        console.warn(`[HookManager] Hook "${hook.name}" timed out after ${timeoutMs}ms — skipping`);
        return { action: "allow" };
      }
      throw error;
    }
  }

  /**
   * Execute a command-type hook (for SessionStart/Stop/PostToolUse).
   * These don't return a result — they just run.
   */
  private async executeCommandHook(
    hook: HookDefinition,
    ctx: HookContext,
  ): Promise<void> {
    const timeoutMs = hook.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;
    const command = hook.command!;

    try {
      await Promise.race([
        executeCommand(command, ctx.cwd),
        this.timeout(timeoutMs),
      ]);
    } catch (error: any) {
      if (error.message.includes("timed out")) {
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
        return result as PreToolHookResult;
      }
      return { action: "allow" };
    } catch (error: any) {
      console.warn(`[HookManager] Function hook "${hook.name}" error: ${error.message}`);
      return { action: "allow" };
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
