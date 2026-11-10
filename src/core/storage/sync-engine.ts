/**
 * 多设备同步引擎（25 号文 P2 · 多设备 Host 同步）。
 *
 * ## 这条线现在是怎么接上的（别再把它读成"未接线模块"）
 *
 * ```
 * 设置 →「设备同步」(DeviceSyncSettings)          ← 开关 / Host 地址 / 配对码 / 立即同步 / 游标
 *   ↓ 写 sync-config（backend=gateway, autoSync…）
 * App.tsx 启动 + 配置变更 → applySyncRuntime()   ← 定时器只在开关打开时存在（默认关）
 *   ↓
 * SyncEngine.syncNow()  ── push ──►  POST <host>/rpc  sync.push
 *                       ── pull ──►  POST <host>/rpc  sync.pull
 *                       ── 快照 ──►  POST <host>/rpc  sync.snapshot（首次同步 / 游标落后时）
 *                       ── 记忆 ──►  POST <host>/rpc  sync.memory
 *   ↓（Host 侧）
 * gateway-engine.ts（形状/鉴权/错误码）→ gateway-sync.ts（账本/幂等/游标/ACL/快照）
 *   ↓（Host 数据）
 * session_events（宿主事件日志） + messages（会话快照） + MemoryService（rev/墓碑/冲突合并）
 * ```
 *
 * 判据：`src/test/device-sync-gateway.test.ts`（两台设备 + 假 fetch 的完整往返）、
 * `device-sync-ledger.test.ts`（账本只修剪所有设备都拉过的前缀）、
 * `device-sync-acl.test.ts`（项目范围）、`device-sync-snapshot.test.ts`（快照重建与幂等）、
 * `device-sync-memory.test.ts`（并集/冲突）、`device-sync-ui.test.tsx`（默认关、开启后 fake timer 触发、失败可见）。
 *
 * ## 为什么有三个后端
 *
 * - `gateway`：**本轮新增**，对端是另一台装了 Codem 的桌面（ADR-0005 远程网关）。
 *   认证复用网关的**设备 cookie**（`pair.claim` 一次性配对码换 30 天 HttpOnly cookie），
 *   所以这里**不存任何 token**：凭据在 WebView 的 cookie 罐里，`credentials: "include"` 带着走。
 * - `supabase` / `rest-api`：旧后端保留（架构没变，只是多了第三种）。
 *
 * ## 冲突与边界（写清楚，别让人以为它什么都能同步）
 *
 * - **事件**按 `seq` 增量、按 `eventId` 幂等；冲突用 **LWW**（同一会话里时间戳更新的那条生效，
 *   并计数）。宿主把"同 eventId 但内容被改写"的推送**直接拒绝**（那说明发送方在同一 seq 上
 *   改了内容，静默接受会让两台设备永久分叉）。
 * - **记忆**不在这里合并：交给宿主 `MemoryService.mergeRemoteForSync`（rev/墓碑/冲突，
 *   双方内容都留 + 写 `memory-conflicts` 审计）。本文件只负责搬运与展示 conflicts 数量。
 * - **不同步原始 JSONL，但快照能还原完整会话内容**：同步单位是事件、会话快照与记忆。
 *   原始 JSONL 不逐字节同步（残留只有字节级导出差异），附件正文也不传；快照带完整消息
 *   （正文/工具结果/元数据）与附件**元数据**，客户端按 id 幂等写入本机消息存储。
 * - **项目范围由设备自述、宿主强制过滤**：`config.projectIds` 空 = 全部；非空时
 *   pull/push/snapshot 都带它，宿主按 `projectIdOfSession` 过滤，无项目映射的会话 fail-closed。
 * - **历史会话**按会话增量补（每会话一个推送水位）；宿主侧按会话逐个补扫（见 gateway-sync.ts）。
 *   新设备首次同步 / 游标落后时走 `sync.snapshot` 分页重建（`snapshotRemaining` 表示还有多少轮）。
 *   大库要多轮才追平 —— 进度看设置里的游标数字。
 *
 * ## 失败语义
 *
 * - 网络类错误**自动重试**（最多 {@link SYNC_RETRY_MAX_ATTEMPTS} 次、指数退避，有界）；
 * - 业务拒绝（未配对 401 / deviceId 冒充 / 记忆未就绪）**不重试**（重发不会变好）；
 * - 失败写 `reportAdvisory`（不弹横幅：用户能做的动作就是"看设置里的最后错误 + 再点一次同步"），
 *   同时进 `sync-state.lastError` 给设置区显示。
 *
 * IP 声明：本文件所有代码均为原创实现。
 */

import { getSetting, setSetting, getSettingJSON, mergeDefaults, setSettingJSON } from "./settings";
import type { SessionEvent, SessionEventType } from "./event-types";
import { registerCustomEventType, isValidEventType } from "./event-types";
import { reportAdvisory, reportPersistFailure } from "./persist-failure";
import {
  SYNC_MARKER_KEY,
  SYNC_PLACEHOLDER_SEQ_FLOOR,
  estimateSyncBytes,
  type GatewaySyncEvent,
  type GatewaySyncSnapshotMessage,
} from "../remote/gateway-sync";

// ========== Types ==========

/** 远程后端类型 */
type RemoteBackendType = "supabase" | "rest-api" | "gateway" | "none";

/** 同步方向 */
type SyncDirection = "push" | "pull" | "both";

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
  /**
   * 网关后端（`backend: "gateway"`）的 Host 地址，例如 `http://127.0.0.1:54321`
   * 或 Tailscale Serve 的 `https://xxx.ts.net`。**不含** `/rpc`。
   */
  gatewayUrl?: string;
  /** 配对成功时 Host 分配的设备 id（只用于展示与排障；鉴权仍是 cookie） */
  gatewayDeviceId?: string;
  /** 配对成功时刻（毫秒；0/缺省 = 没配对过） */
  gatewayPairedAt?: number;
  /** 是否同步记忆（默认 true；关掉就只同步事件） */
  syncMemory?: boolean;
  /** 是否自动同步（**默认关**：只有显式开启才会联网） */
  autoSync: boolean;
  /** 自动同步间隔（毫秒） */
  autoSyncInterval: number;
  /** 同步方向 */
  direction: SyncDirection;
  /** 同步哪些会话（空 = 全部） */
  sessionIds: string[];
  /**
   * 项目 allowlist（**空数组 = 全部项目**；显式列表 = 只同步这些项目）。
   *
   * 这是本设备**自述的范围**：`sync.pull` / `sync.push` / `sync.snapshot` 都会带上它，
   * 宿主按 `projectIdOfSession` 过滤（范围外/无项目映射的会话不返回、推送拒收）。
   * 它防的是"范围配置写错/漏过滤导致跨项目串数据"，不是对抗性身份边界（身份仍是配对 cookie）。
   */
  projectIds?: string[];
}

/** 同步状态（设置区展示的全部数字都来自这里） */
export interface SyncState {
  /** 本机已推送的最大本地 seq（所有会话的推送水位的最大值） */
  lastPushedSeq: number;
  /** 已拉取的 Host 账本序号（单调整数，直接当 pull 游标用） */
  lastPulledSeq: number;
  /** 最后一次同步时间 */
  lastSyncAt: number;
  /** 最后一次同步状态 */
  lastSyncStatus: "idle" | "syncing" | "success" | "error";
  /** 最后一次错误信息（人话） */
  lastError?: string;
  /** 最后一次同步推了多少条 / 拉了多少条 / 冲突多少条 */
  lastPushedCount?: number;
  lastPulledCount?: number;
  lastConflicts?: number;
  /** Host 账本里出现过的设备数（最近一次 pull 的读数） */
  lastDevices?: number;
  /** 记忆同步：最近一次是否成功 + 冲突条数 */
  lastMemoryAt?: number;
  lastMemoryConflicts?: number;
  lastMemoryError?: string;
  /** 每会话推送水位（有界 {@link SYNC_PUSH_CURSOR_MAX}；避免"某个会话没加载完就永久漏事件"） */
  pushedCursors?: Record<string, number>;
  /** 已应用过的事件幂等键（有界 {@link SYNC_SEEN_EVENT_MAX}） */
  seenEventIds?: string[];
  /** 最近一次被宿主账本要求「用快照重建」的时间与当时的 `oldestSeq`（设置区显示） */
  lastResetAt?: number;
  lastResetOldestSeq?: number;
  /** 最近一次会话快照时间 / 完成的会话数 / 写入的消息数 */
  lastSnapshotAt?: number;
  lastSnapshotSessions?: number;
  lastSnapshotMessages?: number;
  /** 已按快照重建完成的会话 id（有界 {@link SYNC_SNAPSHOT_DONE_MAX}；重建未完成时下一轮接着做） */
  snapshotDone?: string[];
  /** 还没重建的会话数（>0 ⇒ 设置区显示「重建中」，下一轮同步继续） */
  snapshotRemaining?: number;
  /** 最近一次宿主 ACL 过滤掉的会话数（>0 说明范围外的会话确实被挡在门外） */
  lastFilteredSessions?: number;
  /** 最近一次因为本机项目范围而没推的会话数 */
  lastProjectSkipped?: number;
}

/** 同步结果 */
export interface SyncResult {
  pushed: number;
  pulled: number;
  conflicts: number;
  /** 记忆同步是否成功（只同步事件时不作数） */
  memoryOk?: boolean;
  error?: string;
}

/** 本地事件（同步的单位）。 */
export interface SyncLocalEvent {
  seq: number;
  sessionId: string;
  type: string;
  payload: Record<string, unknown>;
  timestamp: number;
}

/** 本地记忆的读/合并结果（`sync-local-store` 实现，判据可替换）。 */
export type SyncLocalMemoryExport =
  | { ok: true; payload: string; deviceId: string; entries: number }
  | { ok: false; reason: string };

export interface SyncLocalMemoryMerge {
  ok: boolean;
  payload: string;
  entries: number;
  conflicts: unknown[];
  changed: boolean;
  reason?: string;
}

/**
 * 本地端口的**唯一注入面**。
 *
 * 为什么是注入而不是直接 import：`sync-local-store` 会拉起会话/消息/记忆这些重模块，
 * 只有真正同步时才需要实例化（没开同步的用户不该为它付费）；判据也能用内存实现
 * 把"两台设备"的完整往返跑完，不必起真库。
 */
export interface SyncLocalPorts {
  /** 本机会话 id（有界；跳过子代理内部会话） */
  listSessionIds(): string[];
  /** 读某会话 seq ≥ fromSeq 的事件（插入顺序） */
  readEvents(sessionId: string, fromSeq: number): SyncLocalEvent[];
  /** 追加一条事件；返回落库 seq（0 = 未落库） */
  appendEvent(sessionId: string, type: string, payload: Record<string, unknown>): number;
  /** 确保会话行存在（拉取到陌生会话时用）；false = 建不出来 */
  ensureSession(sessionId: string, hint: { deviceId: string; timestamp: number; title?: string }): boolean;
  /** 远端 `session_meta` 的标题回写 */
  updateSessionTitle?(sessionId: string, title: string): void;
  /**
   * 首次推送某会话前，给一次**有界**的事件镜像加载等待（可选）。
   *
   * 为什么要它：`readFrom` 对"没加载完"与"确实没有"同形；不给等待机会，
   * 刚启动的那次同步会把所有会话当成"没有历史"（水位不动，永远推不出去）。
   */
  waitLoaded?(sessionId: string): Promise<void>;
  /** 会话 → 项目（可选：有项目 allowlist 时用来在本机先筛掉范围外会话，避免每轮都被宿主管拒） */
  projectIdOfSession?(sessionId: string): string | null;
  /**
   * 把快照消息写入本地消息存储（**按 id 幂等**：已存在的消息跳过）。
   *
   * 生产实现复用 `MessageStorage.createMessage`（权威日志 + 查询索引）；
   * 判据端口可以用内存实现。缺省 ⇒ 该端口不支持快照重建（只用于不想测消息面的旧判据）。
   */
  writeSnapshotMessages?(
    sessionId: string,
    messages: readonly GatewaySyncSnapshotMessage[],
  ): { written: number; skipped: number };
  memory: {
    read(): Promise<SyncLocalMemoryExport>;
    merge(payload: string, remoteDeviceId: string): Promise<SyncLocalMemoryMerge>;
    recordConflicts(records: readonly unknown[]): Promise<number>;
  };
}

// ========== Constants ==========

const SYNC_CONFIG_KEY = "codem-sync-config";
const SYNC_STATE_KEY = "codem-sync-state";
const DEVICE_ID_KEY = "codem-device-id";

/** 配置/状态变化时派发的事件（设置区与 App 都听它，避免各自轮询） */
export const SYNC_CONFIG_CHANGED_EVENT = "codem-sync-config-changed";
export const SYNC_COMPLETED_EVENT = "codem-sync-completed";

/** 单次 RPC 的超时（网关 → 渲染层有 15s 上限，这里留出余量） */
const SYNC_REQUEST_TIMEOUT_MS = 12_000;
/** 网络类错误自动重试次数（**有界**：3 次后停手并把错误显示出来） */
export const SYNC_RETRY_MAX_ATTEMPTS = 3;
/** 退避基数（毫秒）：400 → 800 */
const SYNC_RETRY_BASE_DELAY_MS = 400;
/** 单次 push 请求最多带多少条（与网关/宿主上限一致） */
const SYNC_PUSH_BATCH = 200;
/** 单次同步最多发多少个 push 请求（有界：大库要多轮追平） */
const SYNC_PUSH_MAX_BATCHES = 5;
/** 单次同步最多检查多少个会话 */
const SYNC_PUSH_MAX_SESSIONS = 40;
/** 单次 pull 请求条数 */
const SYNC_PULL_LIMIT = 200;
/** 每会话推送水位上限 */
export const SYNC_PUSH_CURSOR_MAX = 200;
/** 已应用事件幂等键上限 */
export const SYNC_SEEN_EVENT_MAX = 2000;
/** 单次同步最多重建多少个会话的快照（大量会话分多轮；进度写进 `snapshotRemaining`） */
const SYNC_SNAPSHOT_MAX_SESSIONS = 40;
/** 单会话快照最多翻多少页（防御宿主分页游标永不结束；正常 ≤ 页数需求） */
const SYNC_SNAPSHOT_MAX_PAGES = 500;
/** 已完成快照的会话 id 上限 */
const SYNC_SNAPSHOT_DONE_MAX = 200;
/** 项目 allowlist 上限（与网关/宿主同口径） */
const SYNC_PROJECT_IDS_MAX = 50;
const SYNC_PROJECT_ID_MAX_LEN = 256;

// ========== Default Config ==========

export const DEFAULT_SYNC_CONFIG: SyncConfig = {
  backend: "none",
  autoSync: false,
  autoSyncInterval: 30_000, // 30 seconds
  direction: "both",
  sessionIds: [],
  syncMemory: true,
  projectIds: [],
};

/**
 * 项目 allowlist 归一化（与宿主/网关同一口径：去空白、去重、截断）。
 *
 * 空数组 = **全部项目**；这是设置页与同步请求共用的唯一实现（别在界面里再写一版）。
 */
export function normalizeSyncProjectIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const id = item.trim();
    if (!id || id.length > SYNC_PROJECT_ID_MAX_LEN) continue;
    if (!out.includes(id)) out.push(id);
    if (out.length >= SYNC_PROJECT_IDS_MAX) break;
  }
  return out;
}

// ========== Config Management ==========

/** 获取同步配置 */
export function getSyncConfig(): SyncConfig {
  const saved = getSettingJSON<SyncConfig>(SYNC_CONFIG_KEY, DEFAULT_SYNC_CONFIG);
  const merged = mergeDefaults(DEFAULT_SYNC_CONFIG, saved);
  // 磁盘上的形状不可信：allowlist 统一在这里归一化（空 = 全部）
  return { ...merged, projectIds: normalizeSyncProjectIds(merged.projectIds) };
}

/** 保存同步配置 */
export function setSyncConfig(config: SyncConfig): void {
  setSettingJSON(SYNC_CONFIG_KEY, {
    ...config,
    projectIds: normalizeSyncProjectIds(config.projectIds),
  });
  dispatchWindowEvent(SYNC_CONFIG_CHANGED_EVENT);
}

/** 获取同步状态（设置区/判据共用；返回副本） */
export function getSyncState(): SyncState {
  const saved = getSettingJSON<SyncState>(SYNC_STATE_KEY, {
    lastPushedSeq: 0,
    lastPulledSeq: 0,
    lastSyncAt: 0,
    lastSyncStatus: "idle",
  });
  return { ...saved };
}

/** 保存同步状态 */
function setSyncState(state: SyncState): void {
  setSettingJSON(SYNC_STATE_KEY, state);
}

function dispatchWindowEvent(name: string): void {
  try {
    if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
      window.dispatchEvent(new Event(name));
    }
  } catch {
    // 非浏览器环境（判据/SSR）忽略
  }
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

// ========== 本地端口（懒加载）==========

let localPortsOverride: SyncLocalPorts | null = null;
let localPortsPromise: Promise<SyncLocalPorts> | null = null;

/**
 * 注入本地端口（判据用）。
 *
 * 生产不调用它：默认走 `await import("./sync-local-store")` —— 那个模块会拉起
 * 会话/消息/记忆，只有真正同步时才需要。
 */
export function configureSyncLocalPorts(ports: SyncLocalPorts | null): void {
  localPortsOverride = ports;
  localPortsPromise = null;
}

async function getLocalPorts(): Promise<SyncLocalPorts> {
  if (localPortsOverride) return localPortsOverride;
  if (!localPortsPromise) {
    localPortsPromise = import("./sync-local-store").then((mod) => mod.createLocalSyncPorts());
  }
  return localPortsPromise;
}

// ========== 网关 RPC ==========

/** 同步 RPC 的**具名**失败（`retryable` 决定要不要重发）。 */
export class SyncRpcError extends Error {
  readonly kind: string;
  readonly retryable: boolean;
  constructor(kind: string, message: string, retryable = false) {
    super(message);
    this.name = "SyncRpcError";
    this.kind = kind;
    this.retryable = retryable;
  }
}

/** Host 地址归一化（去尾斜杠与 `/rpc`；非法返回空串）。 */
export function normalizeGatewayUrl(raw: string | undefined | null): string {
  if (typeof raw !== "string") return "";
  let text = raw.trim();
  if (!text) return "";
  text = text.replace(/\/+$/, "");
  if (text.endsWith("/rpc")) text = text.slice(0, -4).replace(/\/+$/, "");
  if (!/^https?:\/\/[^\s]+$/i.test(text)) return "";
  return text;
}

let rpcSeq = 0;

/**
 * 设备 token 的本地存储键（**与 `sync-config` 分开**）。
 *
 * 为什么不放进配置：配置会被设置面板展示、被"导出设置/诊断"带走，凭据不该跟着走。
 * 这里按本仓的凭据约定**先封存**（`secret_seal`，走 Rust 的密钥后端），后端不可用时
 * 退回明文并在日志里说明 —— 与 `secret-store.ts` 的迁移口径一致。
 */
const SYNC_DEVICE_TOKEN_KEY = "codem-sync-device-token";

interface StoredDeviceToken {
  /** 封存后的密文（优先） */
  sealed?: string;
  /** 明文（密钥后端不可用时的**降级**，等同 cookie 明文） */
  plaintext?: string;
}

/** Tauri 的 invoke（不在 Tauri 里 = null：判据/浏览器走 fetch 分支） */
function tauriInvoke(): ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null {
  try {
    const invoke = (globalThis as { __TAURI__?: { core?: { invoke?: unknown } } }).__TAURI__?.core?.invoke;
    return typeof invoke === "function"
      ? (invoke as (cmd: string, args?: Record<string, unknown>) => Promise<unknown>)
      : null;
  } catch {
    return null;
  }
}

/** 读本机保存的设备 token（封存优先；解不开就当没有 ⇒ 走重新配对）。 */
async function readDeviceToken(): Promise<string> {
  const saved = getSettingJSON<StoredDeviceToken | null>(SYNC_DEVICE_TOKEN_KEY, null);
  if (!saved) return "";
  if (typeof saved.plaintext === "string" && saved.plaintext) return saved.plaintext;
  if (typeof saved.sealed === "string" && saved.sealed) {
    const invoke = tauriInvoke();
    if (!invoke) return "";
    try {
      const reply = (await invoke("secret_unseal", { sealed: saved.sealed })) as { plaintext?: string } | null;
      return typeof reply?.plaintext === "string" ? reply.plaintext : "";
    } catch {
      return "";
    }
  }
  return "";
}

/** 保存设备 token（能封存就封存；封存失败写明文并留一行日志，不丢凭据）。 */
async function saveDeviceToken(token: string): Promise<void> {
  const value = String(token ?? "").trim();
  if (!value) {
    setSettingJSON(SYNC_DEVICE_TOKEN_KEY, null);
    return;
  }
  const invoke = tauriInvoke();
  if (invoke) {
    try {
      const reply = (await invoke("secret_seal", { plaintext: value })) as { sealed?: string } | null;
      if (typeof reply?.sealed === "string" && reply.sealed) {
        setSettingJSON(SYNC_DEVICE_TOKEN_KEY, { sealed: reply.sealed });
        return;
      }
    } catch {
      // 落到下面的明文分支
    }
  }
  console.warn("[sync] 设备 token 未能封存（密钥后端不可用）⇒ 按明文保存；撤销配对可清除");
  setSettingJSON(SYNC_DEVICE_TOKEN_KEY, { plaintext: value });
}

/** 清掉本机设备 token（取消配对时）。 */
function clearDeviceToken(): void {
  try {
    setSettingJSON(SYNC_DEVICE_TOKEN_KEY, null);
  } catch {
    // 清不掉也不该阻断"取消配对"：下次配对会覆盖它
  }
}

interface RawRpcReply {
  status: number;
  body: unknown;
  /** 应答里新种下的设备 token（`pair.claim` 才有） */
  deviceToken?: string;
}

/**
 * 发一条 `/rpc`（**两种通道**，语义完全相同）。
 *
 * - **Tauri 里**：走 Rust `gateway_client_rpc`。为什么不是渲染层 fetch —— 网关的
 *   `origin_allowed` 只允许同源页面，客户端是另一台桌面（`tauri://localhost`），
 *   POST JSON 还会先撞 CORS 预检 ⇒ 渲染层这条路在真机上是 403/405。Rust 发的请求
 *   **不带 Origin**（与 curl 同类），凭据仍是网关的设备 cookie，安全模型一条没放宽。
 * - **非 Tauri**（判据/浏览器里打开）：走 `fetch` + `credentials: "include"`。
 */
async function gatewayPost(
  url: string,
  payload: string,
  fetchImpl: typeof fetch | undefined,
): Promise<RawRpcReply> {
  const target = `${url}/rpc`;
  const invoke = fetchImpl ? null : tauriInvoke();
  if (invoke) {
    const token = await readDeviceToken();
    let reply: { status?: number; body?: string; device_token?: string | null } | null;
    try {
      reply = (await invoke("gateway_client_rpc", {
        args: {
          url: target,
          body: payload,
          ...(token ? { token } : {}),
          timeoutMs: SYNC_REQUEST_TIMEOUT_MS,
        },
      })) as { status?: number; body?: string; device_token?: string | null } | null;
    } catch (e) {
      throw new SyncRpcError("transport", `连接 Host 失败：${String((e as Error)?.message ?? e)}`, true);
    }
    const status = Number(reply?.status) || 0;
    let body: unknown = null;
    try {
      body = JSON.parse(String(reply?.body ?? ""));
    } catch {
      body = null;
    }
    return {
      status,
      body,
      deviceToken: typeof reply?.device_token === "string" ? reply.device_token : undefined,
    };
  }

  const response = await (fetchImpl ?? fetch)(target, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: payload,
    signal: AbortSignal.timeout(SYNC_REQUEST_TIMEOUT_MS),
  });
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

/** 一条 JSON-RPC 调用（把 HTTP/JSON-RPC 两层失败都映射成 `SyncRpcError`）。 */
async function gatewayRpc<T>(
  config: SyncConfig,
  method: string,
  params: Record<string, unknown>,
  fetchImpl?: typeof fetch,
): Promise<T> {
  const base = normalizeGatewayUrl(config.gatewayUrl);
  if (!base) throw new SyncRpcError("invalid-config", "Host 地址未配置或不合法（需要 http(s)://…）");
  const reply = await gatewayPost(
    base,
    JSON.stringify({ jsonrpc: "2.0", id: ++rpcSeq, method, params }),
    fetchImpl,
  );
  if (reply.status === 401) {
    throw new SyncRpcError("unauthorized", "设备未配对或凭据已失效（请在设置里重新配对）");
  }
  if (reply.status !== 200) {
    throw new SyncRpcError("http", `Host 应答 ${reply.status || "?"}`, reply.status >= 500 || reply.status === 0);
  }
  const body = (reply.body ?? {}) as {
    result?: T;
    error?: { code?: number; message?: string; data?: { kind?: string; retryable?: boolean } };
  };
  if (body.error) {
    throw new SyncRpcError(
      body.error.data?.kind || "rpc-error",
      body.error.message || `Host 拒绝（${body.error.code ?? "?"}）`,
      body.error.data?.retryable === true,
    );
  }
  if (body.result === undefined) {
    throw new SyncRpcError("bad-response", "Host 应答缺少 result", true);
  }
  return body.result;
}

/** 等待（重试用；判据用 fake timer 推）。 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 网络类错误自动重试（有界）。业务拒绝不重试。 */
async function withRetry<T>(label: string, run: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= SYNC_RETRY_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await run();
    } catch (e) {
      lastError = e;
      const retryable = e instanceof SyncRpcError ? e.retryable : true;
      if (!retryable || attempt === SYNC_RETRY_MAX_ATTEMPTS) break;
      await delay(SYNC_RETRY_BASE_DELAY_MS * attempt);
    }
  }
  if (lastError instanceof Error) throw lastError;
  throw new SyncRpcError("unknown", `${label} 失败：${String(lastError)}`);
}

// ========== 配对 ==========

export interface PairGatewayResult {
  ok: boolean;
  deviceId?: string;
  /** Host 自报的名字（展示用） */
  hostId?: string;
  error?: string;
}

/**
 * 用一次性配对码把本机登记到 Host（`pair.claim`，与手机浏览器走**同一条**配对流程）。
 *
 * 成功后：
 * - Host 会种下发 HttpOnly 设备 cookie（30 天）。**浏览器里**凭据留在 cookie 罐；
 * - **Tauri 桌面里**（客户端的主要形态）渲染层拿不到 HttpOnly cookie，所以由 Rust
 *   `gateway_client_rpc` 把应答里的 `Set-Cookie` 读出来、把 token 交给本模块**封存保存**
 *   （`codem-sync-device-token`，密钥后端可用时是密文）—— 它不进 `sync-config`，
 *   设置面板与"导出设置"都带不走它。
 */
export async function pairGateway(input: {
  url: string;
  code: string;
  deviceName?: string;
  fetchImpl?: typeof fetch;
}): Promise<PairGatewayResult> {
  const base = normalizeGatewayUrl(input.url);
  if (!base) return { ok: false, error: "Host 地址不合法（需要 http(s)://…）" };
  const code = String(input.code ?? "").replace(/\s+/g, "");
  if (!/^\d{6}$/.test(code)) return { ok: false, error: "配对码应为 6 位数字" };
  try {
    const reply = await gatewayPost(
      base,
      JSON.stringify({
        jsonrpc: "2.0",
        id: ++rpcSeq,
        method: "pair.claim",
        params: {
          code,
          deviceName: input.deviceName || "Codem 桌面",
          platform: "desktop",
        },
      }),
      input.fetchImpl,
    );
    const body = (reply.body ?? null) as
      | {
          result?: { deviceId?: string; hostId?: string };
          error?: { message?: string; data?: { reason?: string } };
        }
      | null;
    if (!body) return { ok: false, error: "Host 应答不可解析" };
    if (body.error) {
      return { ok: false, error: body.error.message || "配对失败（配对码无效或已过期）" };
    }
    // Rust 通道会把设备 token 带回来；非 Tauri（浏览器/判据）则留在 cookie 罐里
    if (reply.deviceToken) await saveDeviceToken(reply.deviceToken);
    const deviceId = String(body.result?.deviceId ?? "");
    let config = getSyncConfig();
    config = {
      ...config,
      backend: "gateway",
      gatewayUrl: base,
      gatewayDeviceId: deviceId || undefined,
      gatewayPairedAt: Date.now(),
    };
    setSyncConfig(config);
    return { ok: true, deviceId, hostId: body.result?.hostId };
  } catch (e) {
    return { ok: false, error: `连接 Host 失败：${String((e as Error)?.message ?? e)}` };
  }
}

/** 取消配对（只清本机配置与设备 token；Host 侧设备仍然有效，撤销请去 Host 的「连接手机」）。 */
export function unpairGateway(): void {
  const config = getSyncConfig();
  clearDeviceToken();
  setSyncConfig({
    ...config,
    backend: "none",
    gatewayUrl: undefined,
    gatewayDeviceId: undefined,
    gatewayPairedAt: undefined,
    autoSync: false,
  });
}

// ========== Sync Engine ==========

/** 拉取结果（网关 `sync.pull` 的应答形状，客户端只关心这几个字段）。 */
interface PullReply {
  events: Array<{
    hostSeq: number;
    eventId: string;
    deviceId: string;
    sessionId: string;
    type: string;
    payload: Record<string, unknown>;
    timestamp: number;
  }>;
  nextSeq: number;
  hasMore: boolean;
  devices?: number;
  /** 宿主账本已修剪到本设备游标之后 ⇒ 本次增量不完整，必须走快照重建 */
  resetRequired?: boolean;
  /** 账本里还能续拉的最早 hostSeq（`resetRequired` 时用于排障/展示） */
  oldestSeq?: number;
  /** 宿主累计容量丢弃条数（>0 要能看见） */
  droppedEntries?: number;
  /** 被 ACL 过滤掉的会话数 */
  filteredSessions?: number;
}

/** 快照应答（`sync.snapshot`；分页从新往旧）。 */
interface SnapshotReply {
  sessionId?: string;
  messages?: GatewaySyncSnapshotMessage[];
  nextBefore?: number | null;
  hasMore?: boolean;
  total?: number;
  hostSeq?: number;
  filteredSessions?: number;
}

/** 一轮快照重建的结果（`cursor` 见 `snapshotHostSessions` 的注释）。 */
interface SnapshotOutcome {
  sessions: number;
  messages: number;
  cursor: number;
  done: string[];
  remaining: number;
  error?: string;
}

class SyncEngine {
  private static instance: SyncEngine | null = null;
  private autoSyncTimer: ReturnType<typeof setInterval> | null = null;
  private syncing = false;

  static getInstance(): SyncEngine {
    if (!SyncEngine.instance) {
      SyncEngine.instance = new SyncEngine();
    }
    return SyncEngine.instance;
  }

  /**
   * 构造**不自动开定时器**。
   *
   * 原实现在构造函数里按配置自启 —— 那让"默认关"依赖构造顺序（模块可能在设置变更前
   * 就被 import）。现在只有一个入口：{@link applySyncRuntime}（App 启动 + 配置变更时调）。
   */
  private constructor() {}

  /** 执行一次同步（push → pull → 记忆）。 */
  async syncNow(): Promise<SyncResult> {
    if (this.syncing) {
      return { pushed: 0, pulled: 0, conflicts: 0, error: "同步正在进行中" };
    }
    const config = getSyncConfig();
    if (config.backend === "none") {
      return { pushed: 0, pulled: 0, conflicts: 0, error: "未配置同步后端" };
    }
    if (!isSyncReady()) {
      return { pushed: 0, pulled: 0, conflicts: 0, error: syncNotReadyReason(config) };
    }

    this.syncing = true;
    this.updateState({ lastSyncStatus: "syncing", lastError: undefined });

    try {
      let result: SyncResult = { pushed: 0, pulled: 0, conflicts: 0 };

      if (config.direction === "push" || config.direction === "both") {
        const pushResult = await this.push(config);
        result.pushed = pushResult.pushed;
        result.error = pushResult.error;
      }

      if (config.direction === "pull" || config.direction === "both") {
        const pullResult = await this.pull(config);
        result.pulled = pullResult.pulled;
        result.conflicts = pullResult.conflicts;
        if (pullResult.error && !result.error) result.error = pullResult.error;
      }

      /*
       * 记忆同步放在 pull 之后：先把对方的新事件收下（对话发生了什么），再对账记忆。
       * 只在 `both` 方向做 —— 记忆同步本质是双向（推本地 + 接受合并结果），
       * 单方向配置下不做会让人意外。
       */
      if (config.backend === "gateway" && config.direction === "both" && config.syncMemory !== false) {
        const memory = await this.syncMemory(config);
        result.memoryOk = memory.ok;
        result.conflicts += memory.conflicts;
        if (!memory.ok && !result.error) result.error = memory.error;
      }

      this.updateState({
        lastSyncAt: Date.now(),
        lastSyncStatus: result.error ? "error" : "success",
        lastError: result.error,
        lastPushedCount: result.pushed,
        lastPulledCount: result.pulled,
        lastConflicts: result.conflicts,
      });

      if (result.error) {
        reportAdvisory("sync.runFailed", `多设备同步未完成：${result.error}`, {
          title: "多设备同步未完成",
          nextStep: "在「设置 → 设备同步」查看最后错误；网络/配对问题处理后点「立即同步」。",
        });
      }
      dispatchWindowEvent(SYNC_COMPLETED_EVENT);
      return result;
    } catch (err) {
      const message = String((err as Error)?.message ?? err);
      this.updateState({
        lastSyncAt: Date.now(),
        lastSyncStatus: "error",
        lastError: message,
      });
      reportAdvisory("sync.runFailed", `多设备同步失败：${message}`, {
        title: "多设备同步失败",
        nextStep: "在「设置 → 设备同步」查看最后错误并重试。",
      });
      dispatchWindowEvent(SYNC_COMPLETED_EVENT);
      return { pushed: 0, pulled: 0, conflicts: 0, error: message };
    } finally {
      this.syncing = false;
    }
  }

  /** Push：把本机新事件推给后端（网关后端按 `eventId` 幂等）。 */
  async push(config: SyncConfig = getSyncConfig()): Promise<SyncResult> {
    if (config.backend === "gateway") return this.pushGateway(config);
    return this.pushLegacy(config);
  }

  /** Pull：把后端的新事件应用到本机。 */
  async pull(config: SyncConfig = getSyncConfig()): Promise<SyncResult> {
    if (config.backend === "gateway") return this.pullGateway(config);
    return this.pullLegacy(config);
  }

  /** 记忆同步（仅网关后端）：推本地整份 → 宿主合并 → 把合并结果收回本地。 */
  async syncMemory(config: SyncConfig = getSyncConfig()): Promise<{
    ok: boolean;
    conflicts: number;
    error?: string;
  }> {
    if (config.backend !== "gateway") return { ok: true, conflicts: 0 };
    const ports = await getLocalPorts();
    const deviceId = getDeviceId();
    const exported = await ports.memory.read();
    if (!exported.ok) {
      this.updateState({ lastMemoryAt: Date.now(), lastMemoryError: exported.reason });
      return { ok: false, conflicts: 0, error: `读取本机记忆失败：${exported.reason}` };
    }
    try {
      const reply = await withRetry("sync.memory", () =>
        gatewayRpc<{ payload: string; entries: number; conflicts: unknown[]; changed: boolean }>(
          config,
          "sync.memory",
          { deviceId, payload: exported.payload },
        ),
      );
      const conflicts = Array.isArray(reply.conflicts) ? reply.conflicts : [];
      // 宿主已经合并过：本地再合并一次是为了收敛（通常 changed=false，只接受对方条目）
      const merged = await ports.memory.merge(String(reply.payload ?? ""), "host");
      const recorded = await ports.memory.recordConflicts(conflicts);
      if (!merged.ok) {
        this.updateState({
          lastMemoryAt: Date.now(),
          lastMemoryConflicts: conflicts.length,
          lastMemoryError: merged.reason,
        });
        return { ok: false, conflicts: conflicts.length, error: `合并记忆失败：${merged.reason ?? "未知原因"}` };
      }
      this.updateState({
        lastMemoryAt: Date.now(),
        lastMemoryConflicts: conflicts.length,
        lastMemoryError: undefined,
        lastConflicts: (getSyncState().lastConflicts ?? 0) + recorded,
      });
      return { ok: true, conflicts: conflicts.length };
    } catch (e) {
      const message = String((e as Error)?.message ?? e);
      this.updateState({ lastMemoryAt: Date.now(), lastMemoryError: message });
      return { ok: false, conflicts: 0, error: `记忆同步失败：${message}` };
    }
  }

  /**
   * 启动自动同步。
   *
   * 每次启动都**重读配置**（间隔可能刚被改过）；已经在跑就先停掉再起 ——
   * 否则改间隔不会生效（`setInterval` 的周期在创建时就固定了）。
   */
  startAutoSync(): void {
    const config = getSyncConfig();
    this.stopAutoSync();
    if (!config.autoSync || config.backend === "none") return;
    const interval = Math.max(5_000, Number(config.autoSyncInterval) || 30_000);
    this.autoSyncTimer = setInterval(() => {
      /*
       * 定时同步的失败**必须**走统一上报（PF-4 的接线契约）：
       * `syncNow()` 内部已经把可预期失败写进状态并返回 result，走到这里的只有
       * "连状态都没写下去"的意外（比如 settings 写失败）—— 那种失败不能只留一句 console。
       */
      void this.syncNow().catch((err) => {
        reportPersistFailure("syncEngine.autoSync", err, "定时同步未能完成（下一轮会重试）", {
          consequence: "本次自动同步没有执行；可在「设置 → 设备同步」点「立即同步」重试。",
        });
      });
    }, interval);
  }

  /** 停止自动同步。 */
  stopAutoSync(): void {
    if (this.autoSyncTimer) {
      clearInterval(this.autoSyncTimer);
      this.autoSyncTimer = null;
    }
  }

  /** 自动同步是否在跑（设置区显示 + 判据用） */
  isAutoSyncRunning(): boolean {
    return this.autoSyncTimer !== null;
  }

  // ========== 网关后端 ==========

  private async pushGateway(config: SyncConfig): Promise<SyncResult> {
    const ports = await getLocalPorts();
    const deviceId = getDeviceId();
    const state = getSyncState();
    const projectIds = normalizeSyncProjectIds(config.projectIds);
    const allowProjects = new Set(projectIds);
    const cursors: Record<string, number> = { ...(state.pushedCursors ?? {}) };
    /*
     * 项目范围：本机先筛一遍（有 `projectIdOfSession` 端口时）。这不是信任问题 ——
     * 宿主任一拒收都不会写库；这里只是避免"每轮都把范围外的事件推到宿主被拒"的噪声。
     */
    let projectSkipped = 0;
    const wanted = (config.sessionIds.length > 0 ? config.sessionIds : ports.listSessionIds()).filter((id) => {
      if (typeof id !== "string" || id.length === 0) return false;
      if (allowProjects.size === 0) return true;
      const projectId = ports.projectIdOfSession?.(id) ?? null;
      if (projectId && allowProjects.has(projectId)) return true;
      // 无项目映射（或不在 allowlist）⇒ 不推（fail-closed：与宿主同一条规则）
      projectSkipped += 1;
      return false;
    });
    const sessions = wanted.slice(0, SYNC_PUSH_MAX_SESSIONS);
    let pushed = 0;
    let batches = 0;
    let maxCursor = Math.max(0, ...Object.values(cursors));
    let filteredSessions = 0;
    /** 首次推送的会话给一次加载等待（有界：不然刚启动那一轮会把"没加载"当成"没有历史"） */
    let loadBudget = 5;

    for (const sessionId of sessions) {
      if (batches >= SYNC_PUSH_MAX_BATCHES) break;
      const cursor = cursors[sessionId] ?? 0;
      if (cursor === 0 && loadBudget > 0 && ports.waitLoaded) {
        loadBudget -= 1;
        await ports.waitLoaded(sessionId);
      }
      let events: SyncLocalEvent[];
      try {
        events = ports.readEvents(sessionId, cursor + 1);
      } catch (e) {
        return { pushed, pulled: 0, conflicts: 0, error: `读取本机会话事件失败：${String((e as Error)?.message ?? e)}` };
      }
      /*
       * 只推**本机产生**的、**已落定**的事件：
       * - 同步标记（`__sync`）= 从别的设备拉回来的，推回去会造成回声；
       * - 占位 seq（未落库）的 seq 之后会变，`eventId` 也就跟着变 ⇒ 幂等键失效。
       */
      const pending = events.filter(
        (event) =>
          event.seq > 0 &&
          event.seq < SYNC_PLACEHOLDER_SEQ_FLOOR &&
          !hasSyncMarker(event.payload),
      );
      if (pending.length === 0) continue;
      for (let offset = 0; offset < pending.length; offset += SYNC_PUSH_BATCH) {
        if (batches >= SYNC_PUSH_MAX_BATCHES) break;
        const batch = pending.slice(offset, offset + SYNC_PUSH_BATCH);
        const payload: GatewaySyncEvent[] = batch.map((event) => ({
          eventId: `${deviceId}:${event.sessionId}:${event.seq}`,
          deviceId,
          sessionId: event.sessionId,
          type: event.type,
          payload: event.payload,
          timestamp: event.timestamp,
        }));
        let reply: {
          accepted: number;
          duplicates: number;
          rejected: unknown[];
          storageFailed?: number;
          filteredSessions?: number;
        };
        try {
          reply = await withRetry("sync.push", () =>
            gatewayRpc(config, "sync.push", { deviceId, events: payload, projectIds }),
          );
        } catch (e) {
          return { pushed, pulled: 0, conflicts: 0, error: describeSyncError("推送事件", e) };
        }
        batches += 1;
        pushed += Number(reply.accepted ?? 0);
        filteredSessions += Number(reply.filteredSessions) || 0;
        const lastSeq = batch[batch.length - 1].seq;
        cursors[sessionId] = lastSeq;
        if (lastSeq > maxCursor) maxCursor = lastSeq;
        /*
         * `rejected` 里全是"这一批里有条没收下"（形状非法/重复但内容不符/会话建不出来）：
         * 不静默 —— 写进状态与 advisory，游标仍然前进（否则每次同步都会卡在同一个坏事件上，
         * 后面的新事件永远推不出去）。这是**有意的取舍**：坏事件留在本机可查，好事件不被堵死。
         */
        const rejected = Array.isArray(reply.rejected) ? reply.rejected : [];
        if (rejected.length > 0) {
          reportAdvisory(
            "sync.pushRejected",
            `宿主拒收了 ${rejected.length} 条事件（会话 ${sessionId}）`,
            { sample: JSON.stringify(rejected.slice(0, 3)) },
          );
        }
      }
    }

    this.updateState({
      lastPushedSeq: maxCursor,
      pushedCursors: trimCursorMap(cursors),
      lastFilteredSessions: filteredSessions || state.lastFilteredSessions || 0,
      lastProjectSkipped: projectSkipped,
    });
    return { pushed, pulled: 0, conflicts: 0 };
  }

  private async pullGateway(config: SyncConfig): Promise<SyncResult> {
    const ports = await getLocalPorts();
    const deviceId = getDeviceId();
    const projectIds = normalizeSyncProjectIds(config.projectIds);
    const state = getSyncState();
    const sinceSeq = Math.max(0, Number(state.lastPulledSeq) || 0);
    let reply: PullReply;
    try {
      reply = await withRetry("sync.pull", () =>
        gatewayRpc<PullReply>(config, "sync.pull", {
          deviceId,
          sinceSeq,
          projectIds,
          ...(config.sessionIds.length > 0 ? { sessionIds: config.sessionIds } : {}),
          limit: SYNC_PULL_LIMIT,
        }),
      );
    } catch (e) {
      return { pushed: 0, pulled: 0, conflicts: 0, error: describeSyncError("拉取事件", e) };
    }

    /*
     * ★ 游标落后：宿主账本已经修剪掉本设备还没拉的那一段 ⇒ **不许**把这次的空增量
     * 当成「同步完成」（那正是「静默缺事件」）。走快照把完整会话内容搬过来，并重置游标。
     */
    if (reply.resetRequired === true) {
      return this.rebuildAfterReset(config, deviceId, {
        oldestSeq: Number(reply.oldestSeq) || 0,
        filteredSessions: Number(reply.filteredSessions) || 0,
        devices: Number(reply.devices) || 0,
      });
    }

    const seen = new Set<string>(Array.isArray(state.seenEventIds) ? state.seenEventIds : []);
    let pulled = 0;
    let conflicts = 0;
    let skippedSessions = 0;
    let sessionUnknown = 0;
    const applied: string[] = [];
    /**
     * 每会话的"已有时间戳"索引（惰性建一次）。
     *
     * 为什么不在每条事件里 `readEvents(sessionId, 0)`：那是**整会话读**，
     * 一次 pull 里 200 条事件就会把同一个大会话读 200 遍（真实浪费，不是理论问题）。
     * 建索引本身也只读一次，且和 LWW 判定用的是同一份快照。
     */
    const timestampIndex = new Map<string, Set<number>>();
    const timestampsOf = (sessionId: string): Set<number> => {
      const cached = timestampIndex.get(sessionId);
      if (cached) return cached;
      const set = new Set<number>();
      try {
        for (const local of ports.readEvents(sessionId, 0)) set.add(Number(local.timestamp));
      } catch {
        // 读不到就当没有：宁可多追加一条（幂等键会挡住重复），也不吞掉远端事件
      }
      timestampIndex.set(sessionId, set);
      return set;
    };

    for (const event of Array.isArray(reply.events) ? reply.events : []) {
      if (!event || typeof event.eventId !== "string" || !event.eventId) continue;
      // 自己推上去的事件会随账本回来：跳过（不是冲突，也不是新事件）
      if (event.deviceId === deviceId) continue;
      if (seen.has(event.eventId)) continue;
      if (!event.sessionId || typeof event.sessionId !== "string") continue;
      if (!ensureRemoteEventType(event.type)) {
        // 类型不认识就注册不了 ⇒ 这条落不了库：**说清楚**，不假装拉到了
        sessionUnknown += 1;
        reportAdvisory(
          "sync.applyUnknownType",
          `远端事件类型无法注册，已跳过一条：${String(event.type)}`,
          { sample: event.eventId },
        );
        continue;
      }
      try {
        if (!ports.ensureSession(event.sessionId, {
          deviceId: event.deviceId || "host",
          timestamp: Number(event.timestamp) || Date.now(),
          title: readSessionTitle(event),
        })) {
          skippedSessions += 1;
          continue;
        }
        /*
         * LWW：同会话里同一时间戳已经有一条 ⇒ 视为同一件事（重复），计一次冲突并跳过。
         * 事件日志是 append-only，所以这里不"覆盖"，只保证不会把同一条重复追加。
         */
        const timestamp = Number(event.timestamp) || 0;
        const known = timestampsOf(event.sessionId);
        if (timestamp > 0 && known.has(timestamp)) {
          conflicts += 1;
          seen.add(event.eventId);
          continue;
        }
        const seq = ports.appendEvent(event.sessionId, String(event.type), {
          ...(event.payload ?? {}),
          [SYNC_MARKER_KEY]: { eventId: event.eventId, deviceId: event.deviceId || "host" },
        });
        if (!seq) {
          sessionUnknown += 1;
          continue;
        }
        if (timestamp > 0) known.add(timestamp);
        pulled += 1;
        seen.add(event.eventId);
        applied.push(event.eventId);
        if (event.type === "session_meta") {
          const title = readSessionTitle(event);
          if (title) ports.updateSessionTitle?.(event.sessionId, title);
        }
      } catch (e) {
        sessionUnknown += 1;
        reportAdvisory("sync.applyEventFailed", `应用远端事件失败：${String((e as Error)?.message ?? e)}`, {
          sample: event.eventId,
        });
      }
    }

    /*
     * 首次同步 / 上一轮重建没做完：事件流**不是**消息（本仓 `event-projection` 明确不承担
     * 消息投影）⇒ 新设备必须用 `sync.snapshot` 把会话正文搬过来，否则界面上一个字的对话都没有。
     */
    let snapshot: SnapshotOutcome | null = null;
    if (this.needsSnapshot(state)) {
      snapshot = await this.snapshotHostSessions(config, deviceId, projectIds, false);
    }

    const nextSeq = Math.max(sinceSeq, Number(reply.nextSeq) || 0);
    this.updateState({
      lastPulledSeq: nextSeq,
      seenEventIds: trimSeenEvents(seen, applied),
      lastDevices: Number(reply.devices) || getSyncState().lastDevices || 0,
      lastFilteredSessions: Number(reply.filteredSessions) || getSyncState().lastFilteredSessions || 0,
      ...(snapshot
        ? {
            // 失败时**不**记「已完成」：下一轮必须重试（否则一次网络抖动就等于永久没有会话内容）
            lastSnapshotAt: snapshot.error ? state.lastSnapshotAt : Date.now(),
            lastSnapshotSessions: snapshot.sessions,
            lastSnapshotMessages: snapshot.messages,
            snapshotDone: snapshot.done,
            snapshotRemaining: snapshot.error ? Math.max(1, snapshot.remaining) : snapshot.remaining,
          }
        : {}),
    });
    if (skippedSessions > 0 || sessionUnknown > 0) {
      reportAdvisory(
        "sync.applySkipped",
        `有 ${skippedSessions + sessionUnknown} 条远端事件未落地（会话建不出来或事件日志未就绪）`,
        { nextStep: "检查本机是否至少有一个项目；事件会在下一轮同步重试。" },
      );
    }
    return {
      pushed: 0,
      pulled,
      conflicts,
      ...(snapshot?.error ? { error: snapshot.error } : {}),
    };
  }

  /** 这一轮要不要做会话快照（首次同步 / 上一次重建还没做完）。 */
  private needsSnapshot(state: SyncState): boolean {
    if (state.lastSnapshotAt === undefined || state.lastSnapshotAt === 0) return true;
    return (state.snapshotRemaining ?? 0) > 0;
  }

  /**
   * `resetRequired` 之后的重建：搬完整会话内容 + **重置游标**，并如实把这次重置写进状态。
   *
   * 为什么必须重置游标：旧游标落在宿主已修剪的范围里，继续用它只会每轮都 `resetRequired`
   * （永远拉不到东西）。快照返回的 `hostSeq` 是「读完消息那一刻的账本位置」——
   * 之后产生的事件都会大于它，所以不会再漏。
   */
  private async rebuildAfterReset(
    config: SyncConfig,
    deviceId: string,
    info: { oldestSeq: number; filteredSessions: number; devices: number },
  ): Promise<SyncResult> {
    const projectIds = normalizeSyncProjectIds(config.projectIds);
    const outcome = await this.snapshotHostSessions(config, deviceId, projectIds, true);
    const now = Date.now();
    this.updateState({
      lastResetAt: now,
      lastResetOldestSeq: info.oldestSeq,
      lastPulledSeq: outcome.error ? getSyncState().lastPulledSeq : outcome.cursor,
      lastSnapshotAt: now,
      lastSnapshotSessions: outcome.sessions,
      lastSnapshotMessages: outcome.messages,
      snapshotDone: outcome.done,
      snapshotRemaining: outcome.remaining,
      lastFilteredSessions: info.filteredSessions || getSyncState().lastFilteredSessions || 0,
      lastDevices: info.devices || getSyncState().lastDevices || 0,
    });
    return {
      pushed: 0,
      pulled: 0,
      conflicts: 0,
      ...(outcome.error ? { error: outcome.error } : {}),
    };
  }

  /**
   * 把宿主会话内容按快照搬进本机消息存储（分页 ≤200 条；重复 id 幂等）。
   *
   * `reset=true`：清空「已完成」集合，全量重建（宿主账本丢了/修剪之后）。
   * 返回 `cursor` = 各会话快照点里**最小**的 hostSeq（取最小而不是最大：取大会跳过
   * 两次快照之间产生的事件；小一点最多只是下一轮多收几条幂等事件）。
   */
  private async snapshotHostSessions(
    config: SyncConfig,
    deviceId: string,
    projectIds: string[],
    reset: boolean,
  ): Promise<SnapshotOutcome> {
    const ports = await getLocalPorts();
    const state = getSyncState();
    const done = reset ? [] : [...(state.snapshotDone ?? [])];
    if (!ports.writeSnapshotMessages) {
      // 端口没有消息面（旧判据的纯内存端口）⇒ 不做快照，也不把「未实现」冒充成「已完成」
      return { sessions: 0, messages: 0, cursor: 0, done: trimSnapshotDone(done), remaining: 0 };
    }
    const doneSet = new Set(done);
    let list: { items?: Array<{ id?: string; title?: string }>; hasMore?: boolean };
    try {
      list = await withRetry("session.list", () => gatewayRpc(config, "session.list", { limit: 300 }));
    } catch (e) {
      return {
        sessions: 0,
        messages: 0,
        cursor: 0,
        done: trimSnapshotDone(done),
        remaining: 0,
        error: describeSyncError("读取宿主会话列表", e),
      };
    }
    const pending = (Array.isArray(list.items) ? list.items : [])
      .map((item) => ({
        id: String(item?.id ?? ""),
        title: typeof item?.title === "string" ? item.title : "",
      }))
      .filter((item) => item.id.length > 0 && !doneSet.has(item.id));
    const batch = pending.slice(0, SYNC_SNAPSHOT_MAX_SESSIONS);
    let sessions = 0;
    let messages = 0;
    let cursor: number | null = null;
    for (const item of batch) {
      try {
        const outcome = await this.snapshotOneSession(config, deviceId, projectIds, ports, item);
        messages += outcome.messages;
        if (outcome.hostSeq !== null) {
          cursor = cursor === null ? outcome.hostSeq : Math.min(cursor, outcome.hostSeq);
        }
        done.push(item.id);
        doneSet.add(item.id);
        sessions += 1;
      } catch (e) {
        return {
          sessions,
          messages,
          cursor: cursor ?? 0,
          done: trimSnapshotDone(done),
          remaining: pending.length - sessions,
          error: describeSyncError(`重建会话快照（${item.id}）`, e),
        };
      }
    }
    return {
      sessions,
      messages,
      cursor: cursor ?? 0,
      done: trimSnapshotDone(done),
      remaining: pending.length - batch.length,
    };
  }

  /** 一个会话的完整快照（按 `nextBefore` 从新往旧翻页，写完再算完成）。 */
  private async snapshotOneSession(
    config: SyncConfig,
    deviceId: string,
    projectIds: string[],
    ports: SyncLocalPorts,
    item: { id: string; title: string },
  ): Promise<{ messages: number; hostSeq: number | null }> {
    let before: number | null = null;
    let messages = 0;
    let pages = 0;
    let hostSeq: number | null = null;
    let ensured = false;
    const writeSnapshotMessages = ports.writeSnapshotMessages;
    if (!writeSnapshotMessages) {
      throw new SyncRpcError("unsupported", "本机端口未实现快照写入（sync.snapshot 无法落地）");
    }
    for (;;) {
      const page = await withRetry("sync.snapshot", () =>
        gatewayRpc<SnapshotReply>(config, "sync.snapshot", {
          deviceId,
          sessionId: item.id,
          projectIds,
          limit: 200,
          ...(before !== null ? { before } : {}),
        }),
      );
      const pageHostSeq = Number(page.hostSeq);
      if (Number.isFinite(pageHostSeq) && pageHostSeq >= 0) {
        hostSeq = hostSeq === null ? pageHostSeq : Math.min(hostSeq, pageHostSeq);
      }
      if ((Number(page.filteredSessions) || 0) > 0) {
        // 项目范围外：不写、不建会话（宿主已经按 ACL 拒答；这台设备本来就不该看到它）
        return { messages, hostSeq };
      }
      const list = Array.isArray(page.messages) ? page.messages : [];
      for (const message of list) {
        if (!message || typeof message.id !== "string" || !message.id) {
          throw new SyncRpcError("bad-response", "快照消息缺少 id（拒绝写入来路不明的消息）", true);
        }
      }
      if (!ensured) {
        if (
          !ports.ensureSession(item.id, {
            deviceId: "host",
            timestamp: Number(list[0]?.timestamp) || Date.now(),
            title: item.title,
          })
        ) {
          throw new SyncRpcError("session-unknown", "本机建不出会话行（至少需要一个项目）");
        }
        ensured = true;
      }
      const written = writeSnapshotMessages(item.id, list);
      messages += written.written;
      if (page.hasMore !== true) return { messages, hostSeq };
      const nextBefore = Number(page.nextBefore);
      if (!Number.isFinite(nextBefore) || nextBefore < 0 || list.length === 0) {
        // 「还有更多」却不给可用游标 ⇒ 协议违约：说清楚，别让上层以为已经拉全
        throw new SyncRpcError("bad-response", "快照分页游标无效（hasMore=true 但没有 nextBefore）", true);
      }
      pages += 1;
      if (pages > SYNC_SNAPSHOT_MAX_PAGES) {
        throw new SyncRpcError("bad-response", `快照页数超过上限（${SYNC_SNAPSHOT_MAX_PAGES}）`, false);
      }
      before = Math.floor(nextBefore);
    }
  }

  // ========== 旧后端（Supabase / REST，保留）==========

  private async pushLegacy(config: SyncConfig): Promise<SyncResult> {
    const state = getSyncState();
    const ports = await getLocalPorts();
    const deviceId = getDeviceId();
    const sessionIds = config.sessionIds;
    let totalPushed = 0;
    let maxSeqPushed = state.lastPushedSeq;

    for (const sessionId of sessionIds) {
      const events = ports
        .readEvents(sessionId, state.lastPushedSeq + 1)
        .filter((event) => event.seq > 0 && event.seq < SYNC_PLACEHOLDER_SEQ_FLOOR && !hasSyncMarker(event.payload));
      if (events.length === 0) continue;
      const remoteEvents = events.map((event) => ({
        localSeq: event.seq,
        deviceId,
        sessionId: event.sessionId,
        eventType: event.type as SessionEventType,
        payload: event.payload,
        timestamp: event.timestamp,
      }));
      try {
        const pushed = await this.pushToRemote(remoteEvents, config);
        totalPushed += pushed;
        for (const event of events) if (event.seq > maxSeqPushed) maxSeqPushed = event.seq;
      } catch (err) {
        return { pushed: totalPushed, pulled: 0, conflicts: 0, error: String((err as Error)?.message ?? err) };
      }
    }
    this.updateState({ lastPushedSeq: maxSeqPushed });
    return { pushed: totalPushed, pulled: 0, conflicts: 0 };
  }

  private async pullLegacy(config: SyncConfig): Promise<SyncResult> {
    const state = getSyncState();
    const ports = await getLocalPorts();
    const deviceId = getDeviceId();
    try {
      const remoteEvents = await this.pullFromRemote(state.lastPulledSeq, config);
      if (remoteEvents.length === 0) return { pushed: 0, pulled: 0, conflicts: 0 };
      let pulled = 0;
      let conflicts = 0;
      let maxRemoteSeq = state.lastPulledSeq;
      for (const remoteEvent of remoteEvents) {
        if (remoteEvent.deviceId === deviceId) {
          if (remoteEvent.remoteSeq > maxRemoteSeq) maxRemoteSeq = remoteEvent.remoteSeq;
          continue;
        }
        const existing = ports
          .readEvents(remoteEvent.sessionId, 0)
          .find((local) => local.timestamp === remoteEvent.timestamp);
        if (existing) {
          conflicts += 1;
          if (remoteEvent.timestamp > existing.timestamp) {
            this.applyRemoteEvent(ports, remoteEvent);
            pulled += 1;
          }
        } else {
          this.applyRemoteEvent(ports, remoteEvent);
          pulled += 1;
        }
        if (remoteEvent.remoteSeq > maxRemoteSeq) maxRemoteSeq = remoteEvent.remoteSeq;
      }
      this.updateState({ lastPulledSeq: maxRemoteSeq });
      return { pushed: 0, pulled, conflicts };
    } catch (err) {
      return { pushed: 0, pulled: 0, conflicts: 0, error: String((err as Error)?.message ?? err) };
    }
  }

  private applyRemoteEvent(ports: SyncLocalPorts, remote: RemoteEvent): void {
    try {
      if (!ports.ensureSession(remote.sessionId, { deviceId: remote.deviceId, timestamp: remote.timestamp })) return;
      ports.appendEvent(remote.sessionId, remote.eventType, {
        ...remote.payload,
        [SYNC_MARKER_KEY]: { eventId: `${remote.deviceId}:${remote.sessionId}:${remote.localSeq}`, deviceId: remote.deviceId },
      });
    } catch {
      // 旧后端的应用失败不阻断整体同步（下一轮重试）
    }
  }

  // ========== 内部 ==========

  private updateState(partial: Partial<SyncState>): void {
    const current = getSyncState();
    setSyncState({ ...current, ...partial });
  }

  /** Push 事件到远程后端（旧后端） */
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

  /** 从远程后端拉取事件（旧后端） */
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
      signal: AbortSignal.timeout(20_000),
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

    const response = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
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
      signal: AbortSignal.timeout(20_000),
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

    const response = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
    if (!response.ok) {
      throw new Error(`REST API pull failed: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    return (data.events || []) as RemoteEvent[];
  }
}

// ========== 旧后端形状 ==========

/** 远程事件条目（旧后端） */
interface RemoteEvent {
  remoteSeq: number;
  localSeq: number;
  deviceId: string;
  sessionId: string;
  eventType: SessionEventType;
  payload: Record<string, unknown>;
  timestamp: number;
}

// ========== 内部工具 ==========

function hasSyncMarker(payload: unknown): boolean {
  return Boolean(payload && typeof payload === "object" && !Array.isArray(payload) && SYNC_MARKER_KEY in (payload as object));
}

/** 远端事件类型可能是本机不认识的自定义类型：注册它（否则追加时会报"未注册事件类型"）。 */
function ensureRemoteEventType(type: string): boolean {
  const name = String(type ?? "").trim();
  if (!name) return false;
  if (isValidEventType(name)) return true;
  try {
    registerCustomEventType(name);
    return true;
  } catch {
    return false;
  }
}

/** 从 `session_meta` 事件里读标题（用于本地建会话/回写标题）。 */
function readSessionTitle(event: { type: string; payload?: Record<string, unknown> }): string {
  if (event.type !== "session_meta") return "";
  const title = event.payload?.title;
  return typeof title === "string" ? title.trim() : "";
}

function describeSyncError(action: string, error: unknown): string {
  if (error instanceof SyncRpcError) {
    if (error.kind === "unauthorized") {
      return `${action}失败：设备未配对或凭据已失效（请重新配对）`;
    }
    return `${action}失败：${error.message}`;
  }
  return `${action}失败：${String((error as Error)?.message ?? error)}`;
}

/** 推送水位有界（丢最旧的会话水位 —— 它会被从 0 重扫，重复事件由 eventId 幂等挡住）。 */
function trimCursorMap(cursors: Record<string, number>): Record<string, number> {
  const entries = Object.entries(cursors);
  if (entries.length <= SYNC_PUSH_CURSOR_MAX) return cursors;
  entries.sort((a, b) => b[1] - a[1]);
  return Object.fromEntries(entries.slice(0, SYNC_PUSH_CURSOR_MAX));
}

/** 幂等键有界：保留旧集合里靠后的 + 本轮新应用的。 */
function trimSeenEvents(seen: Set<string>, applied: readonly string[]): string[] {
  const list = [...seen];
  if (list.length <= SYNC_SEEN_EVENT_MAX) return list;
  const appliedSet = new Set(applied);
  const keep: string[] = [];
  for (const id of list) if (appliedSet.has(id)) keep.push(id);
  for (const id of list) {
    if (keep.length >= SYNC_SEEN_EVENT_MAX) break;
    if (!appliedSet.has(id)) keep.push(id);
  }
  return keep.slice(0, SYNC_SEEN_EVENT_MAX);
}

/** 已完成快照的会话 id 有界（丢最老的；那些会话不会再被重建，但内容已经在本地）。 */
function trimSnapshotDone(done: string[]): string[] {
  return done.length > SYNC_SNAPSHOT_DONE_MAX ? done.slice(done.length - SYNC_SNAPSHOT_DONE_MAX) : done;
}

function syncNotReadyReason(config: SyncConfig): string {
  if (config.backend === "gateway") {
    if (!normalizeGatewayUrl(config.gatewayUrl)) return "Host 地址未配置（设置 → 设备同步）";
    return "";
  }
  if (config.backend === "supabase") return "Supabase 地址/密钥未配置";
  if (config.backend === "rest-api") return "REST API 地址未配置";
  return "未配置同步后端";
}

// ========== Singleton Access ==========

function getSyncEngine(): SyncEngine {
  return SyncEngine.getInstance();
}

// ========== 对外 API ==========

/** 立即同步一次（设置里的「立即同步」按钮）。 */
export function syncNow(): Promise<SyncResult> {
  return getSyncEngine().syncNow();
}

/** 当前同步摘要（设置区展示：配置 + 状态 + 设备 id）。 */
export function getSyncSummary(): {
  config: SyncConfig;
  state: SyncState;
  deviceId: string;
  autoSyncRunning: boolean;
} {
  return {
    config: getSyncConfig(),
    state: getSyncState(),
    deviceId: getDeviceId(),
    autoSyncRunning: getSyncEngine().isAutoSyncRunning(),
  };
}

/**
 * 按当前配置**对齐运行时**（App 启动 + 配置变更时调用）。
 *
 * 这是"自动同步只在开关打开时存在"的唯一落点：
 * - `autoSync` 关 / 后端未配置 ⇒ 定时器不存在（**默认关**，不会有任何联网）；
 * - 打开 ⇒ 起定时器（间隔改了就按新间隔重建）。
 *
 * @returns 是否在运行 + 没在运行的原因（设置区如实显示，不假装"已开启"）
 */
export function applySyncRuntime(): { running: boolean; reason?: string } {
  const engine = getSyncEngine();
  const config = getSyncConfig();
  if (!config.autoSync) {
    engine.stopAutoSync();
    return { running: false, reason: "自动同步已关闭" };
  }
  if (config.backend === "none") {
    engine.stopAutoSync();
    return { running: false, reason: "未选择同步后端（先去「设备同步」配对）" };
  }
  if (!isSyncReady()) {
    engine.stopAutoSync();
    return { running: false, reason: syncNotReadyReason(config) || "同步配置不完整" };
  }
  engine.startAutoSync();
  return { running: engine.isAutoSyncRunning() };
}

/** 停掉自动同步（登出/关开关/关窗口时用）。 */
export function stopSyncRuntime(): void {
  getSyncEngine().stopAutoSync();
}

/** 判据用：重置单例的定时器与本地端口注入（不影响已落盘配置）。 */
export function __resetSyncRuntimeForTests(): void {
  stopSyncRuntime();
  localPortsOverride = null;
  localPortsPromise = null;
}

/** 检查同步是否就绪 */
export function isSyncReady(): boolean {
  const config = getSyncConfig();
  if (config.backend === "none") return false;
  if (config.backend === "gateway") return Boolean(normalizeGatewayUrl(config.gatewayUrl));
  if (config.backend === "supabase") return Boolean(config.supabaseUrl && config.supabaseKey);
  if (config.backend === "rest-api") return Boolean(config.apiUrl);
  return false;
}

/** 判据/诊断用：估算一条事件的线上字节（与宿主同一口径）。 */
export function estimateEventBytes(event: { type: string; payload: Record<string, unknown> }): number {
  return estimateSyncBytes(JSON.stringify(event));
}

/** 单条事件的幂等键（客户端与判据同一规则：`deviceId:sessionId:seq`）。 */
export function syncEventId(deviceId: string, sessionId: string, seq: number): string {
  return `${deviceId}:${sessionId}:${seq}`;
}

/** 事件是否属于"同步来源"（判据用：拉回来的事件都带标记）。 */
export function isSyncedEvent(event: Pick<SessionEvent, "payload">): boolean {
  return hasSyncMarker(event.payload);
}
