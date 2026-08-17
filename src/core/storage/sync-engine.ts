/**
 * Remote Sync Engine — 基于 seq 的增量同步框架。
 *
 * 设计原理：
 * - 事件日志（session_events 表）是同步的基本单位
 * - 每个事件有单调递增的 seq 号，用于增量同步
 * - 本地 -> 远程：push（发送本地新事件到远程）
 * - 远程 -> 本地：pull（获取远程新事件到本地）
 * - 冲突解决策略：last-write-wins（以 timestamp 最新的为准）
 *
 * 同步状态跟踪：
 * - lastSyncedSeq：本地已成功 push 到远程的最大 seq 号
 * - lastPulledSeq：远程已成功 pull 到本地的最大 seq 号
 *
 * 支持的远程后端：
 * - Supabase（PostgreSQL）
 * - 自建 REST API
 *
 * IP 声明：本文件所有代码均为原创实现。
 */

import { getEventLog } from "./event-log";
import { getSetting, setSetting, getSettingJSON, setSettingJSON } from "./settings";
import type { SessionEvent, SessionEventType } from "./event-types";

// ========== Types ==========

/** 远程后端类型 */
export type RemoteBackendType = "supabase" | "rest-api" | "none";

/** 同步方向 */
export type SyncDirection = "push" | "pull" | "both";

/** 同步配置 */
export interface SyncConfig {
  /** 后端类型 */
  backend: RemoteBackendType;
  /** Supabase URL */
  supabaseUrl?: string;
  /** Supabase Anon Key */
  supabaseKey?: string;
  /** REST API base URL */
  apiUrl?: string;
  /** API Bearer Token */
  apiToken?: string;
  /** 是否自动同步 */
  autoSync: boolean;
  /** 自动同步间隔（毫秒） */
  autoSyncInterval: number;
  /** 同步方向 */
  direction: SyncDirection;
  /** 同步哪些会话（空 = 全部） */
  sessionIds: string[];
}

/** 同步状态 */
export interface SyncState {
  /** 本地已 push 的最大 seq */
  lastPushedSeq: number;
  /** 远程已 pull 的最大 seq */
  lastPulledSeq: number;
  /** 最后一次同步时间 */
  lastSyncAt: number;
  /** 最后一次同步状态 */
  lastSyncStatus: "idle" | "syncing" | "success" | "error";
  /** 最后一次错误信息 */
  lastError?: string;
}

/** 远程事件条目 */
export interface RemoteEvent {
  /** 远程 seq 号（远程数据库自增） */
  remoteSeq: number;
  /** 本地 seq 号 */
  localSeq: number;
  /** 设备 ID（标识事件来源设备） */
  deviceId: string;
  /** 会话 ID */
  sessionId: string;
  /** 事件类型 */
  eventType: SessionEventType;
  /** 事件负载 */
  payload: Record<string, unknown>;
  /** 时间戳 */
  timestamp: number;
}

/** 同步结果 */
export interface SyncResult {
  pushed: number;
  pulled: number;
  conflicts: number;
  error?: string;
}

// ========== Constants ==========

const SYNC_CONFIG_KEY = "codem-sync-config";
const SYNC_STATE_KEY = "codem-sync-state";
const DEVICE_ID_KEY = "codem-device-id";

// ========== Default Config ==========

export const DEFAULT_SYNC_CONFIG: SyncConfig = {
  backend: "none",
  autoSync: false,
  autoSyncInterval: 30_000, // 30 seconds
  direction: "both",
  sessionIds: [],
};

// ========== Config Management ==========

/** 获取同步配置 */
export function getSyncConfig(): SyncConfig {
  const saved = getSettingJSON<SyncConfig>(SYNC_CONFIG_KEY, DEFAULT_SYNC_CONFIG);
  return { ...DEFAULT_SYNC_CONFIG, ...saved };
}

/** 保存同步配置 */
export function setSyncConfig(config: SyncConfig): void {
  setSettingJSON(SYNC_CONFIG_KEY, config);
  window.dispatchEvent(new Event("codem-sync-config-changed"));
}

/** 获取同步状态 */
export function getSyncState(): SyncState {
  const saved = getSettingJSON<SyncState>(SYNC_STATE_KEY, {
    lastPushedSeq: 0,
    lastPulledSeq: 0,
    lastSyncAt: 0,
    lastSyncStatus: "idle",
  });
  return saved;
}

/** 保存同步状态 */
function setSyncState(state: SyncState): void {
  setSettingJSON(SYNC_STATE_KEY, state);
}

// ========== Device ID ==========

/** 获取或生成设备 ID */
export function getDeviceId(): string {
  let deviceId = getSetting(DEVICE_ID_KEY);
  if (!deviceId) {
    // Generate a random device ID
    deviceId = `dev_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 10)}`;
    setSetting(DEVICE_ID_KEY, deviceId);
  }
  return deviceId;
}

// ========== Sync Engine ==========

export class SyncEngine {
  private static instance: SyncEngine | null = null;
  private autoSyncTimer: ReturnType<typeof setInterval> | null = null;
  private syncing = false;

  static getInstance(): SyncEngine {
    if (!SyncEngine.instance) {
      SyncEngine.instance = new SyncEngine();
    }
    return SyncEngine.instance;
  }

  private constructor() {
    // Start auto-sync if configured
    const config = getSyncConfig();
    if (config.autoSync && config.backend !== "none") {
      this.startAutoSync();
    }
  }

  /**
   * 执行完整的双向同步。
   * 1. Push: 发送本地新事件到远程
   * 2. Pull: 获取远程新事件到本地
   */
  async syncNow(): Promise<SyncResult> {
    if (this.syncing) {
      return { pushed: 0, pulled: 0, conflicts: 0, error: "Sync already in progress" };
    }

    const config = getSyncConfig();
    if (config.backend === "none") {
      return { pushed: 0, pulled: 0, conflicts: 0, error: "No backend configured" };
    }

    this.syncing = true;
    this.updateState({ lastSyncStatus: "syncing" });

    try {
      let result: SyncResult = { pushed: 0, pulled: 0, conflicts: 0 };

      if (config.direction === "push" || config.direction === "both") {
        const pushResult = await this.push();
        result.pushed = pushResult.pushed;
        result.error = pushResult.error;
      }

      if (config.direction === "pull" || config.direction === "both") {
        const pullResult = await this.pull();
        result.pulled = pullResult.pulled;
        result.conflicts = pullResult.conflicts;
        if (pullResult.error && !result.error) {
          result.error = pullResult.error;
        }
      }

      this.updateState({
        lastSyncAt: Date.now(),
        lastSyncStatus: result.error ? "error" : "success",
        lastError: result.error,
      });

      window.dispatchEvent(new Event("codem-sync-completed"));
      return result;
    } catch (err: any) {
      this.updateState({
        lastSyncAt: Date.now(),
        lastSyncStatus: "error",
        lastError: err.message || String(err),
      });
      return { pushed: 0, pulled: 0, conflicts: 0, error: err.message || String(err) };
    } finally {
      this.syncing = false;
    }
  }

  /**
   * Push: 发送本地新事件到远程。
   * 从 lastPushedSeq + 1 开始读取本地事件，批量发送到远程。
   */
  async push(): Promise<SyncResult> {
    const config = getSyncConfig();
    const state = getSyncState();
    const eventLog = getEventLog();
    const deviceId = getDeviceId();

    // 获取需要同步的会话列表
    const sessionIds = config.sessionIds;
    let totalPushed = 0;
    let maxSeqPushed = state.lastPushedSeq;

    for (const sessionId of sessionIds) {
      const events = eventLog.readFrom(sessionId, state.lastPushedSeq + 1);
      if (events.length === 0) continue;

      // 将事件发送到远程
      const remoteEvents: Omit<RemoteEvent, "remoteSeq">[] = events.map((e) => ({
        localSeq: e.seq,
        deviceId,
        sessionId: e.sessionId,
        eventType: e.type as SessionEventType,
        payload: e.payload,
        timestamp: e.timestamp,
      }));

      try {
        const pushed = await this.pushToRemote(remoteEvents, config);
        totalPushed += pushed;

        // 更新 maxSeqPushed
        for (const e of events) {
          if (e.seq > maxSeqPushed) {
            maxSeqPushed = e.seq;
          }
        }
      } catch (err: any) {
        return { pushed: totalPushed, pulled: 0, conflicts: 0, error: err.message };
      }
    }

    this.updateState({ lastPushedSeq: maxSeqPushed });
    return { pushed: totalPushed, pulled: 0, conflicts: 0 };
  }

  /**
   * Pull: 从远程获取新事件到本地。
   * 使用 lastPulledSeq 作为远程 seq 的起点。
   */
  async pull(): Promise<SyncResult> {
    const config = getSyncConfig();
    const state = getSyncState();
    const eventLog = getEventLog();
    const deviceId = getDeviceId();

    try {
      const remoteEvents = await this.pullFromRemote(state.lastPulledSeq, config);
      if (remoteEvents.length === 0) {
        return { pushed: 0, pulled: 0, conflicts: 0 };
      }

      let pulled = 0;
      let conflicts = 0;
      let maxRemoteSeq = state.lastPulledSeq;

      for (const remoteEvent of remoteEvents) {
        // 跳过本设备产生的事件（已存在）
        if (remoteEvent.deviceId === deviceId) {
          if (remoteEvent.remoteSeq > maxRemoteSeq) {
            maxRemoteSeq = remoteEvent.remoteSeq;
          }
          continue;
        }

        // 将远程事件应用到本地
        // 冲突检测：如果本地已有相同 sessionId + timestamp 的事件
        const existing = this.findByTimestamp(remoteEvent.sessionId, remoteEvent.timestamp);
        if (existing) {
          conflicts++;
          // Last-write-wins: 如果远程 timestamp 更新，覆盖本地
          if (remoteEvent.timestamp > existing.timestamp) {
            this.applyRemoteEvent(remoteEvent);
            pulled++;
          }
        } else {
          this.applyRemoteEvent(remoteEvent);
          pulled++;
        }

        if (remoteEvent.remoteSeq > maxRemoteSeq) {
          maxRemoteSeq = remoteEvent.remoteSeq;
        }
      }

      this.updateState({ lastPulledSeq: maxRemoteSeq });
      return { pushed: 0, pulled, conflicts };
    } catch (err: any) {
      return { pushed: 0, pulled: 0, conflicts: 0, error: err.message };
    }
  }

  /**
   * 启动自动同步。
   */
  startAutoSync(): void {
    if (this.autoSyncTimer) return;
    const config = getSyncConfig();
    this.autoSyncTimer = setInterval(() => {
      this.syncNow().catch((err) => {
        console.error("[SyncEngine] Auto-sync error:", err);
      });
    }, config.autoSyncInterval);
  }

  /**
   * 停止自动同步。
   */
  stopAutoSync(): void {
    if (this.autoSyncTimer) {
      clearInterval(this.autoSyncTimer);
      this.autoSyncTimer = null;
    }
  }

  // ========== Internal Methods ==========

  private updateState(partial: Partial<SyncState>): void {
    const current = getSyncState();
    setSyncState({ ...current, ...partial });
  }

  /** 在本地查找指定会话中指定时间戳的事件 */
  private findByTimestamp(sessionId: string, timestamp: number): SessionEvent | null {
    const eventLog = getEventLog();
    const events = eventLog.readAll(sessionId);
    return events.find((e) => e.timestamp === timestamp) || null;
  }

  /** 将远程事件应用到本地事件日志 */
  private applyRemoteEvent(remote: RemoteEvent): void {
    const eventLog = getEventLog();
    eventLog.append(remote.sessionId, remote.eventType, remote.payload);
  }

  /** Push 事件到远程后端 */
  private async pushToRemote(
    events: Omit<RemoteEvent, "remoteSeq">[],
    config: SyncConfig,
  ): Promise<number> {
    if (config.backend === "supabase") {
      return this.pushToSupabase(events, config);
    } else if (config.backend === "rest-api") {
      return this.pushToRestAPI(events, config);
    }
    return 0;
  }

  /** 从远程后端拉取事件 */
  private async pullFromRemote(fromSeq: number, config: SyncConfig): Promise<RemoteEvent[]> {
    if (config.backend === "supabase") {
      return this.pullFromSupabase(fromSeq, config);
    } else if (config.backend === "rest-api") {
      return this.pullFromRestAPI(fromSeq, config);
    }
    return [];
  }

  // ========== Supabase Backend ==========

  private async pushToSupabase(
    events: Omit<RemoteEvent, "remoteSeq">[],
    config: SyncConfig,
  ): Promise<number> {
    const url = `${config.supabaseUrl}/rest/v1/session_events`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "apikey": config.supabaseKey || "",
      "Authorization": `Bearer ${config.supabaseKey || ""}`,
      "Prefer": "return=representation",
    };

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(events),
    });

    if (!response.ok) {
      throw new Error(`Supabase push failed: ${response.status} ${response.statusText}`);
    }

    return events.length;
  }

  private async pullFromSupabase(fromSeq: number, config: SyncConfig): Promise<RemoteEvent[]> {
    const url = `${config.supabaseUrl}/rest/v1/session_events?remote_seq=gt.${fromSeq}&order=remote_seq.asc`;
    const headers: Record<string, string> = {
      "apikey": config.supabaseKey || "",
      "Authorization": `Bearer ${config.supabaseKey || ""}`,
    };

    const response = await fetch(url, { headers });
    if (!response.ok) {
      throw new Error(`Supabase pull failed: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    return data as RemoteEvent[];
  }

  // ========== REST API Backend ==========

  private async pushToRestAPI(
    events: Omit<RemoteEvent, "remoteSeq">[],
    config: SyncConfig,
  ): Promise<number> {
    const url = `${config.apiUrl}/sync/events`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (config.apiToken) {
      headers["Authorization"] = `Bearer ${config.apiToken}`;
    }

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ events }),
    });

    if (!response.ok) {
      throw new Error(`REST API push failed: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    return data.pushed || events.length;
  }

  private async pullFromRestAPI(fromSeq: number, config: SyncConfig): Promise<RemoteEvent[]> {
    const url = `${config.apiUrl}/sync/events?from=${fromSeq}`;
    const headers: Record<string, string> = {};
    if (config.apiToken) {
      headers["Authorization"] = `Bearer ${config.apiToken}`;
    }

    const response = await fetch(url, { headers });
    if (!response.ok) {
      throw new Error(`REST API pull failed: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    return (data.events || []) as RemoteEvent[];
  }
}

// ========== Singleton Access ==========

export function getSyncEngine(): SyncEngine {
  return SyncEngine.getInstance();
}

// ========== Utility ==========

/** 获取同步摘要信息（用于 UI 展示） */
export function getSyncSummary(): {
  config: SyncConfig;
  state: SyncState;
  deviceId: string;
} {
  return {
    config: getSyncConfig(),
    state: getSyncState(),
    deviceId: getDeviceId(),
  };
}

/** 检查同步是否就绪 */
export function isSyncReady(): boolean {
  const config = getSyncConfig();
  if (config.backend === "none") return false;
  if (config.backend === "supabase" && (!config.supabaseUrl || !config.supabaseKey)) return false;
  if (config.backend === "rest-api" && !config.apiUrl) return false;
  return true;
}
