/**
 * Automation Manager — 自动任务触发器
 *
 * 对标 wecode-ref 的 subscription/trigger 体系：
 * - FileWatchTrigger: 监听文件变化 → 触发自动对话
 * - TimerTrigger: 定时器/cron → 触发自动对话
 * - 支持启用/禁用、多触发器并存
 *
 * 触发后会创建一个新会话并发送预设消息。
 * 如果当前项目是 worktree 模式，会自动创建独立 worktree。
 */

import { getSettingJSON, setSettingJSON } from "../storage/settings";
import { executeCommand } from "../file-api";

// ========== Types ==========

export type TriggerType = "file_watch" | "timer";

export interface AutomationTrigger {
  id: string;
  name: string;
  type: TriggerType;
  enabled: boolean;
  /** 预设发送的消息 */
  message: string;
  /** file_watch: 监听的文件路径或 glob 模式 */
  watchPath?: string;
  /** file_watch: 触发后冷却时间(ms)，防止连续触发 */
  cooldownMs?: number;
  /** timer: 触发间隔(ms) */
  intervalMs?: number;
  /** 上次触发时间 */
  lastTriggered?: number;
}

export interface AutomationConfig {
  triggers: AutomationTrigger[];
  /** Recent trigger history (newest first) */
  history?: TriggerHistoryEntry[];
}

export interface TriggerHistoryEntry {
  triggerId: string;
  triggerName: string;
  timestamp: number;
  message: string;
}

const SETTINGS_KEY = "codem-automation-config";
const MAX_HISTORY = 50;

// ========== Config ==========

export function getAutomationConfig(): AutomationConfig {
  try {
    return getSettingJSON<AutomationConfig>(SETTINGS_KEY, { triggers: [] });
  } catch {
    return { triggers: [] };
  }
}

export function setAutomationConfig(config: AutomationConfig): void {
  setSettingJSON(SETTINGS_KEY, config);
  window.dispatchEvent(new CustomEvent("codem-automation-config-changed"));
}

/** Add a trigger history entry (keeps last MAX_HISTORY) */
export function addTriggerHistory(entry: TriggerHistoryEntry): void {
  const config = getAutomationConfig();
  if (!config.history) config.history = [];
  config.history.unshift(entry);
  if (config.history.length > MAX_HISTORY) {
    config.history = config.history.slice(0, MAX_HISTORY);
  }
  setSettingJSON(SETTINGS_KEY, config);
}

export function addTrigger(trigger: AutomationTrigger): void {
  const config = getAutomationConfig();
  config.triggers.push(trigger);
  setAutomationConfig(config);
}

export function removeTrigger(id: string): void {
  const config = getAutomationConfig();
  config.triggers = config.triggers.filter(t => t.id !== id);
  setAutomationConfig(config);
}

export function updateTrigger(id: string, update: Partial<AutomationTrigger>): void {
  const config = getAutomationConfig();
  config.triggers = config.triggers.map(t => t.id === id ? { ...t, ...update } : t);
  setAutomationConfig(config);
}

// ========== Timer Engine ==========

class TimerEngine {
  private timers: Map<string, ReturnType<typeof setInterval>> = new Map();
  private onTrigger: ((trigger: AutomationTrigger) => void) | null = null;

  setHandler(handler: (trigger: AutomationTrigger) => void): void {
    this.onTrigger = handler;
  }

  start(): void {
    const config = getAutomationConfig();
    this.stopAll();

    for (const trigger of config.triggers) {
      if (!trigger.enabled || trigger.type !== "timer" || !trigger.intervalMs) continue;
      const timer = setInterval(() => {
        this.fire(trigger);
      }, trigger.intervalMs);
      this.timers.set(trigger.id, timer);
    }
  }

  stopAll(): void {
    for (const timer of this.timers.values()) {
      clearInterval(timer);
    }
    this.timers.clear();
  }

  private fire(trigger: AutomationTrigger): void {
    // Check cooldown (debounce)
    if (trigger.cooldownMs && trigger.lastTriggered) {
      const elapsed = Date.now() - trigger.lastTriggered;
      if (elapsed < trigger.cooldownMs) return;
    }
    // Update last triggered
    updateTrigger(trigger.id, { lastTriggered: Date.now() });
    // Log to history
    addTriggerHistory({
      triggerId: trigger.id,
      triggerName: trigger.name,
      timestamp: Date.now(),
      message: trigger.message,
    });
    this.onTrigger?.(trigger);
  }

  refresh(): void {
    this.start();
  }
}

export const timerEngine = new TimerEngine();

// ========== File Watch Engine ==========
// Uses polling-based file watching via PowerShell (Tauri native notify is future work)

class FileWatchEngine {
  private pollers: Map<string, ReturnType<typeof setInterval>> = new Map();
  private fileSizes: Map<string, number> = new Map();
  private onTrigger: ((trigger: AutomationTrigger) => void) | null = null;

  setHandler(handler: (trigger: AutomationTrigger) => void): void {
    this.onTrigger = handler;
  }

  start(): void {
    const config = getAutomationConfig();
    this.stopAll();

    for (const trigger of config.triggers) {
      if (!trigger.enabled || trigger.type !== "file_watch" || !trigger.watchPath) continue;
      // Poll file size every 2 seconds
      const poller = setInterval(() => this.check(trigger), 2000);
      this.pollers.set(trigger.id, poller);
    }
  }

  stopAll(): void {
    for (const p of this.pollers.values()) clearInterval(p);
    this.pollers.clear();
    this.fileSizes.clear();
  }

  private async check(trigger: AutomationTrigger): Promise<void> {
    if (!trigger.watchPath) return;
    // Check cooldown
    if (trigger.cooldownMs && trigger.lastTriggered) {
      const elapsed = Date.now() - trigger.lastTriggered;
      if (elapsed < trigger.cooldownMs) return;
    }

    try {
      // Use PowerShell to get file length
      const safePath = trigger.watchPath.replace(/'/g, "''");
      const result = await executeCommand(
        `(Get-Item -LiteralPath '${safePath}' -ErrorAction SilentlyContinue).Length`
      );
      const sizeStr = result.stdout.trim();
      if (!sizeStr) return; // File doesn't exist
      const size = parseInt(sizeStr);
      if (isNaN(size)) return;

      const prevSize = this.fileSizes.get(trigger.id);
      if (prevSize === undefined) {
        // First check — just record
        this.fileSizes.set(trigger.id, size);
        return;
      }
      if (size !== prevSize) {
        // File changed — fire trigger
        this.fileSizes.set(trigger.id, size);
        updateTrigger(trigger.id, { lastTriggered: Date.now() });
        // Log to history
        addTriggerHistory({
          triggerId: trigger.id,
          triggerName: trigger.name,
          timestamp: Date.now(),
          message: trigger.message,
        });
        this.onTrigger?.(trigger);
      }
    } catch {
      // Ignore errors
    }
  }

  refresh(): void {
    this.start();
  }
}

export const fileWatchEngine = new FileWatchEngine();

// ========== Combined Engine ==========

export function startAutomationEngines(onTrigger: (trigger: AutomationTrigger) => void): void {
  timerEngine.setHandler(onTrigger);
  fileWatchEngine.setHandler(onTrigger);
  timerEngine.start();
  fileWatchEngine.start();
}

export function stopAutomationEngines(): void {
  timerEngine.stopAll();
  fileWatchEngine.stopAll();
}

export function refreshAutomationEngines(): void {
  timerEngine.refresh();
  fileWatchEngine.refresh();
}
