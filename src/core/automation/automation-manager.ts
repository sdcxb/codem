/**
 * Automation Manager — 自动任务触发器
 *
 * Subscription/trigger 体系：
 * - FileWatchTrigger: 监听文件变化 → 触发自动对话
 * - TimerTrigger: 定时器/cron → 触发自动对话
 * - 支持启用/禁用、多触发器并存
 *
 * 触发后会创建一个新会话并发送预设消息。
 * 如果当前项目是 worktree 模式，会自动创建独立 worktree。
 */

import { getSettingJSON, setSettingJSON } from "../storage/settings";
import { executeCommand } from "../file-api";
import { getInboxManager } from "../inbox/inbox";

// ========== Types ==========

export type TriggerType = "file_watch" | "timer" | "cron" | "issue_status";

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
  /** cron: cron 表达式（简化版，如 "0 9 * * 1-5" = 工作日 9 点） */
  cronExpression?: string;
  /** issue_status: 监听的状态值（如 "done", "blocked"） */
  issueStatusFilter?: string;
  /** issue_status: 监听的项目 ID（可选，留空 = 全局） */
  issueProjectId?: string;
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
    // Write to Inbox
    try {
      getInboxManager().add({
        category: "automation",
        title: `自动化触发: ${trigger.name}`,
        body: trigger.message.substring(0, 200),
        sourceType: "automation",
        sourceId: trigger.id,
        priority: "low",
      });
    } catch {}
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
        try { getInboxManager().add({ category: "automation", title: `文件监听触发: ${trigger.name}`, body: trigger.message.substring(0, 200), sourceType: "automation", sourceId: trigger.id, priority: "low" }); } catch {}
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

// ========== Cron Engine ==========

/**
 * 简化版 cron 解析：支持 5 段格式 "minute hour day-of-month month day-of-week"
 * 每段支持: * (通配), 数字, 逗号分隔列表, - 范围, / 步长
 * 例: "0 9 * * 1-5" = 工作日9点, "every-30-min" = 每30分钟
 */
function parseCronField(field: string, min: number, max: number): number[] {
  if (field === "*") return Array.from({ length: max - min + 1 }, (_, i) => min + i);
  if (field.startsWith("*/")) {
    const step = parseInt(field.substring(2));
    return Array.from({ length: Math.floor((max - min) / step) + 1 }, (_, i) => min + i * step);
  }
  const values: number[] = [];
  for (const part of field.split(",")) {
    if (part.includes("-")) {
      const [s, e] = part.split("-").map(Number);
      for (let i = s; i <= e; i++) values.push(i);
    } else {
      values.push(parseInt(part));
    }
  }
  return values.filter((v) => v >= min && v <= max);
}

function shouldFireCron(expr: string, date: Date): boolean {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [minF, hourF, domF, monF, dowF] = parts;
  const mins = parseCronField(minF, 0, 59);
  const hours = parseCronField(hourF, 0, 23);
  const doms = parseCronField(domF, 1, 31);
  const mons = parseCronField(monF, 1, 12);
  const dows = parseCronField(dowF, 0, 6); // 0=Sunday
  return mins.includes(date.getMinutes()) &&
         hours.includes(date.getHours()) &&
         doms.includes(date.getDate()) &&
         mons.includes(date.getMonth() + 1) &&
         dows.includes(date.getDay());
}

class CronEngine {
  private timer: ReturnType<typeof setInterval> | null = null;
  private onTrigger: ((trigger: AutomationTrigger) => void) | null = null;

  setHandler(handler: (trigger: AutomationTrigger) => void): void {
    this.onTrigger = handler;
  }

  start(): void {
    this.stopAll();
    // Check every 30 seconds
    this.timer = setInterval(() => this.checkAll(), 30000);
  }

  stopAll(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private checkAll(): void {
    const config = getAutomationConfig();
    const now = new Date();
    for (const trigger of config.triggers) {
      if (!trigger.enabled || trigger.type !== "cron" || !trigger.cronExpression) continue;
      if (trigger.cooldownMs && trigger.lastTriggered) {
        const elapsed = Date.now() - trigger.lastTriggered;
        if (elapsed < trigger.cooldownMs) continue;
        if (elapsed < 60000) continue; // at most once per minute
      }
      if (shouldFireCron(trigger.cronExpression, now)) {
        updateTrigger(trigger.id, { lastTriggered: Date.now() });
        addTriggerHistory({
          triggerId: trigger.id,
          triggerName: trigger.name,
          timestamp: Date.now(),
          message: trigger.message,
        });
        try { getInboxManager().add({ category: "automation", title: `Cron 触发: ${trigger.name}`, body: trigger.message.substring(0, 200), sourceType: "automation", sourceId: trigger.id, priority: "low" }); } catch {}
        this.onTrigger?.(trigger);
      }
    }
  }

  refresh(): void {
    this.start();
  }
}

export const cronEngine = new CronEngine();

// ========== Issue Status Trigger Engine ==========

/**
 * 监听 Issue 状态变化，当 Issue 状态匹配触发器的 issueStatusFilter 时触发。
 * 由 IssueManager.update() 调用 notifyIssueStatusChange() 驱动。
 */
class IssueStatusEngine {
  private onTrigger: ((trigger: AutomationTrigger) => void) | null = null;

  setHandler(handler: (trigger: AutomationTrigger) => void): void {
    this.onTrigger = handler;
  }

  /** Called by IssueManager when an issue's status changes */
  notifyStatusChange(issueId: string, newStatus: string, projectId: string | null): void {
    const config = getAutomationConfig();
    for (const trigger of config.triggers) {
      if (!trigger.enabled || trigger.type !== "issue_status") continue;
      if (trigger.issueStatusFilter && trigger.issueStatusFilter !== newStatus) continue;
      if (trigger.issueProjectId && trigger.issueProjectId !== projectId) continue;
      if (trigger.cooldownMs && trigger.lastTriggered) {
        const elapsed = Date.now() - trigger.lastTriggered;
        if (elapsed < trigger.cooldownMs) continue;
      }
      updateTrigger(trigger.id, { lastTriggered: Date.now() });
        addTriggerHistory({
          triggerId: trigger.id,
          triggerName: trigger.name,
          timestamp: Date.now(),
          message: trigger.message.replace(/\{issue_id\}/g, issueId).replace(/\{status\}/g, newStatus),
        });
        try { getInboxManager().add({ category: "issue", title: `Issue 触发自动化: ${trigger.name}`, body: `Issue ${issueId.substring(0, 16)} → ${newStatus}`, sourceType: "automation", sourceId: trigger.id, issueId, projectId: projectId ?? undefined, priority: "normal" }); } catch {}
        this.onTrigger?.(trigger);
    }
  }

  refresh(): void {
    // No polling needed — event-driven
  }
}

export const issueStatusEngine = new IssueStatusEngine();

/** Public API: called by IssueManager when issue status changes */
export function notifyIssueStatusChange(issueId: string, newStatus: string, projectId: string | null): void {
  issueStatusEngine.notifyStatusChange(issueId, newStatus, projectId);
}

// ========== Combined Engine ==========

export function startAutomationEngines(onTrigger: (trigger: AutomationTrigger) => void): void {
  timerEngine.setHandler(onTrigger);
  fileWatchEngine.setHandler(onTrigger);
  cronEngine.setHandler(onTrigger);
  issueStatusEngine.setHandler(onTrigger);
  timerEngine.start();
  fileWatchEngine.start();
  cronEngine.start();
}

export function stopAutomationEngines(): void {
  timerEngine.stopAll();
  fileWatchEngine.stopAll();
  cronEngine.stopAll();
}

export function refreshAutomationEngines(): void {
  timerEngine.refresh();
  fileWatchEngine.refresh();
  cronEngine.refresh();
}
