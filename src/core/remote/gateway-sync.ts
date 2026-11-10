/**
 * 多设备 Host 同步（25 号文 P2）的**宿主侧数据面**。
 *
 * ## 它是什么
 *
 * 桌面远程网关（`gateway-engine.ts`）新增三条 JSON-RPC：`sync.pull` / `sync.push` /
 * `sync.memory`。网关那一层只做**形状与错误码**；真正的数据在这里：
 *
 * - **同步日志（journal）**：宿主自己维护的一本**有序、有界**的账，每条事件一个 `hostSeq`
 *   （宿主自己分配的单调整数）。客户端用它当游标 —— 不直接用 `session_events.seq`，
 *   因为那个 seq 有**占位**阶段（`rust-port.ts` 的 `appendLocal` 先发一个
 *   `MAX_SAFE_INTEGER - 1e6` 起的假 seq，落库后由 `reconcile` 改成真 seq），
 *   拿它当游标会漏事件（见 `latestSeq` 的长注释：这就是"增量投影此后再也读不到事件"那个坑）。
 * - **两类条目**：
 *   - `push`：别的设备推上来的事件。**正文随日志一起存**（有界），所以客户端拉取
 *     不依赖会话事件镜像是否已加载；
 *   - `native`：宿主**自己**产生的事件。只存 `(sessionId, storageSeq)` 引用，正文在
 *     `session_events` 里（单一来源，不在设置里存第二份对话内容）。
 * - **记忆**：`sync.memory` 把对方整份 payload 交给宿主 `MemoryService` 做 rev/墓碑/冲突合并
 *   （复用 `merge.ts`），落库后把**合并结果**回给对方。
 *
 * ## 四条硬纪律
 *
 * 1. **幂等**：同一 `eventId` 只入账一次（第二次是 `duplicates`，不写库）。同 id 但内容指纹
 *    不同 ⇒ **拒绝**（`conflict`）并留 advisory —— 那说明发送方在同一 seq 上改写了事件，
 *    静默接受会让两台设备的同一事件永久分叉。
 * 2. **账本不丢未拉取事件**：修剪只删「所有已知设备都已拉过」的前缀
 *    （`hostSeq ≤ min(deviceCursors)`）。条数/字节上限不再是「到 1200 就丢最旧的」——
 *    那种做法会让慢设备（以及新设备）静默缺事件。没有设备游标时按时间保留
 *    {@link HOST_SYNC_RETENTION_MS}（7 天）/ 最多 {@link HOST_SYNC_JOURNAL_MAX_ENTRIES} 条；
 *    有设备游标时**绝不**因为条数上限丢别的设备还没拉的事件，超界只回报
 *    `overCapacity` / `resetRequired`（让落后的设备走快照重建）。
 * 3. **游标落后必须可见**：`sinceSeq < 已修剪到的最大 hostSeq`（或客户端游标超过宿主
 *    已分配的 hostSeq，说明账本被重建过）⇒ `resetRequired: true` + `oldestSeq`。
 *    客户端**不许**把这当成"没有新事件"：它必须走 `sync.snapshot` 重建并重设游标。
 * 4. **不许静默丢**：丢日志条目、宿主侧追加事件未落库、记忆合并失败，都会走
 *    `reportAdvisory` / `reportPersistFailure`，并在 RPC 结果里带出来（`dropped` / `rejected`）。
 *
 * ## 项目范围（ACL）
 *
 * `sync.pull` / `sync.push` / `sync.snapshot` 都带 `projectIds`（**空的显式列表 = 全部**）。
 * 非空时按 `HostSyncPorts.projectIdOfSession` 过滤：项目不在列表里的会话**不返回 / 拒收**，
 * 且**没有项目映射的会话一律拒绝**（fail-closed —— 不知道归属就不能证明它在允许范围里）。
 * 结果里的 `filteredSessions` 如实计数。这是**设备自述的范围**（配合设置里的编辑入口）：
 * 它防的是"范围配置写错/漏过滤导致跨项目泄漏"，不是对抗性身份伪造 —— 真正的身份边界
 * 仍是配对 cookie（Rust 鉴权）。
 *
 * ## 边界（它**不**做的事）
 *
 * - 不同步原始 JSONL（会话正文的权威副本仍是本机 `session-jsonl`）；`sync.snapshot`
 *   传**消息**（含工具调用/结果），能还原完整会话内容，但"逐字节一样的 JSONL"不保证，
 *   附件正文也不传（见 `GatewaySyncSnapshotMessage` 的注释）；
 * - 不做"整库搬迁"：历史事件按会话逐个补扫（每次 pull 最多扫
 *   {@link HOST_SYNC_SCAN_SESSIONS_PER_PULL} 个会话），大库要多轮才补齐；
 *   快照按会话分页（≤200 条/≤2MB 一页），大量会话要多轮。
 *
 * 本文件**不 import storage**（`session_events` / 消息 / 记忆都由 `HostSyncPorts` 注入，
 * 生产实现在 `gateway-sync-host.ts`）—— 这样判据能用内存端口跑完两台设备的完整往返。
 */

import { reportAdvisory, reportPersistFailure } from "../storage/persist-failure";

// ========== 协议常量 ==========

/** 单次 pull 最多返回多少条（有界：客户端按游标续拉）。 */
const SYNC_MAX_PULL_EVENTS = 500;
/** 单次 push 最多接收多少条。 */
const SYNC_MAX_PUSH_EVENTS = 200;
/** 单次响应字节上限（超过就截断并回 `hasMore`）。 */
const SYNC_MAX_RESPONSE_BYTES = 1024 * 1024;
/** 单条事件 payload 上限（超过 ⇒ rejected，不截断 —— 截断等于伪造内容）。 */
const SYNC_MAX_PAYLOAD_BYTES = 256 * 1024;
/** 单次 sync.memory 的 payload 上限（记忆整份 JSON）。 */
const SYNC_MAX_MEMORY_BYTES = 4 * 1024 * 1024;
/** 单次 sync.snapshot 最多返回多少条消息（客户端按 `nextBefore` 续拉）。 */
const SYNC_SNAPSHOT_MAX_MESSAGES = 200;
/** 单页快照的字节预算（**至少一条**：单条超大消息不截断，见 `readSnapshotPage`）。 */
const SYNC_SNAPSHOT_MAX_BYTES = 2 * 1024 * 1024;
/** 项目 allowlist 的条数与单条长度上限（与网关参数校验同口径）。 */
const SYNC_PROJECT_IDS_MAX = 50;
const SYNC_PROJECT_ID_MAX_LEN = 256;

const SYNC_MAX_SESSION_ID_LEN = 256;
const SYNC_MAX_EVENT_ID_LEN = 512;
const SYNC_MAX_TYPE_LEN = 128;

/**
 * 未落库事件的占位 seq 下限（与 `rust-port.ts` 的 `placeholderBase` 同值）。
 *
 * 为什么要在这里重复一个数字：同步只认**已落定**的事件。占位 seq 会在落库后变成真 seq，
 * 一旦被当成游标就会跳过一个区间（`event-log.ts` 的 `latestSeq` 为此专门排除了占位）。
 */
export const SYNC_PLACEHOLDER_SEQ_FLOOR = Number.MAX_SAFE_INTEGER - 1_000_000;

/** 宿主事件 payload 里标记"这条是同步推上来的"的键（供补扫跳过，避免二次入账）。 */
export const SYNC_MARKER_KEY = "__sync";

// ========== 有界参数 ==========

export const HOST_SYNC_JOURNAL_KEY = "codem-sync-host-journal";
/**
 * 账本**软上限**：条数 5 万 / 字节 8 MB。
 *
 * 注意它不再是「到界就丢最旧的」：修剪的第一原则是「只删所有已知设备都已拉过的前缀」。
 * 达到这个上限时，宿主只回报 `overCapacity` / `resetRequired`（慢设备走快照重建），
 * **不**擅自把别人还没拉的事件删掉。只有在**没有任何设备游标**时（还没有客户端）
 * 才按时间/条数做一次策略性修剪 —— 那批数据没有任何已知读者。
 */
const HOST_SYNC_JOURNAL_MAX_ENTRIES = 50_000;
const HOST_SYNC_JOURNAL_MAX_BYTES = 8 * 1024 * 1024;
/** 没有设备游标时的保留窗口（毫秒）。 */
const HOST_SYNC_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const HOST_SYNC_DEVICE_MAX = 32;
/** 设备游标上限：超过时保留**游标最大**的那些（被淘汰的设备会收到 resetRequired ⇒ 快照重建）。 */
const HOST_SYNC_DEVICE_CURSOR_MAX = 64;
const HOST_SYNC_NATIVE_CURSOR_MAX = 200;
/** 每次 pull 补扫多少个宿主会话（轮转，避免每次都从同一批开始）。 */
const HOST_SYNC_SCAN_SESSIONS_PER_PULL = 12;
/** 每个会话每次补扫最多入账多少条。 */
const HOST_SYNC_SCAN_EVENTS_PER_SESSION = 200;
/** 每次 pull 补扫总共最多入账多少条。 */
const HOST_SYNC_SCAN_EVENTS_PER_PULL = 600;


// ========== 类型 ==========

/** 一条待推送事件（`sync.push` 的入参形状 = 客户端本地事件）。 */
export interface GatewaySyncEvent {
  /** 稳定幂等键：`<deviceId>:<sessionId>:<localSeq>`（同一条事件永远同一个 id）。 */
  eventId: string;
  deviceId: string;
  sessionId: string;
  type: string;
  payload: Record<string, unknown>;
  timestamp: number;
}

/** pull 返回的一条事件（多一个宿主序）。 */
interface GatewayPulledEvent extends GatewaySyncEvent {
  hostSeq: number;
}

interface GatewaySyncPullInput {
  sinceSeq: number;
  sessionIds?: string[];
  limit: number;
  /** 调用方设备（用它推进账本里的 `deviceCursors`；缺省 = 不记游标）。 */
  deviceId?: string;
  /** 项目 allowlist（空/缺省 = 全部；非空时无项目映射的会话 fail-closed）。 */
  projectIds?: string[];
}

export interface GatewaySyncPullResult {
  events: GatewayPulledEvent[];
  /** 下一次 pull 的 `sinceSeq`（= 本次返回的最大 hostSeq；没返回就原样）。 */
  nextSeq: number;
  hasMore: boolean;
  /** 宿主账本里出现过的设备数（只算推送过事件的）。 */
  devices: number;
  /** 本次补扫的宿主会话数（可观测：0 表示没扫）。 */
  scannedSessions: number;
  /** 本次因正文已不可读（会话被删/事件被清）而丢掉的条目数。 */
  missingBodies: number;
  /** 宿主账本累计因超界/超期丢弃的条目数（>0 说明有客户端落后太多）。 */
  droppedEntries: number;
  /** 累计因超界被丢、且当时**还有设备没拉过**的条目数（不静默：这些客户端会收到 resetRequired）。 */
  droppedUnpulled: number;
  /**
   * 客户端游标落在**已修剪范围**里（或超过了宿主已分配的 hostSeq）⇒ 必须用
   * `sync.snapshot` 重建，不能把本次的「没有事件」当成同步完成。
   */
  resetRequired: boolean;
  /** 账本里还能续拉的最早 hostSeq（没有条目时 = `nextSeq`）。 */
  oldestSeq: number;
  /** 本次被项目 allowlist 过滤掉的会话数（>0 说明有会话不在本设备的范围里）。 */
  filteredSessions: number;
  /** 账本超过条数/字节上限，且已没有「所有设备都拉过」的前缀可以修剪。 */
  overCapacity: boolean;
  serverTime: number;
}

interface GatewaySyncPushRejection {
  eventId: string;
  reason: "invalid" | "foreign-device" | "conflict" | "session-unknown" | "project-forbidden";
}

export interface GatewaySyncPushResult {
  accepted: number;
  duplicates: number;
  rejected: GatewaySyncPushRejection[];
  hostSeqMax: number;
  devices: number;
  /** 宿主侧写入 `session_events` 失败的条数（账本已收，但宿主本机投影没有它）。 */
  storageFailed: number;
  /** 因项目 allowlist 拒收的会话数（fail-closed：没有项目映射也算）。 */
  filteredSessions: number;
}

/**
 * 快照里的一条消息（**完整会话内容**的传输形态）。
 *
 * 与 `Message` 的差别只有一处：**附件只带元数据**（`content`/`preview` 不传）。
 * 附件正文是外置文件/字节级内容，属于本功能的已知边界（见 25 号文）；正文/工具结果
 * 不截断 —— 传输不完整比"明确说没同步附件"更糟。
 */
export interface GatewaySyncSnapshotMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
  reasoning?: string;
  model?: string;
  status?: string;
  toolCalls?: Array<{
    id: string;
    tool: string;
    args: Record<string, unknown>;
    result?: string;
    status: string;
    metadata?: Record<string, unknown>;
  }>;
  metadata?: Record<string, unknown>;
  attachments?: Array<{
    id: string;
    name: string;
    type: string;
    mimeType?: string;
    size?: number;
    sandboxPath?: string;
  }>;
  generatedFiles?: string[];
  retrievedSources?: unknown[];
}

interface GatewaySyncSnapshotInput {
  deviceId?: string;
  sessionId: string;
  /** 只取 `timestamp >= sinceTimestamp` 的消息（增量；缺省 = 全部）。 */
  sinceTimestamp?: number;
  /**
   * 分页游标：**时间线索引的排他上界**（从 0 起算；缺省 = 消息总数）。
   *
   * 用索引而不是时间戳：同一毫秒里可能有多条消息，按时间戳分页会漏/重。
   */
  before?: number;
  limit?: number;
  projectIds?: string[];
}

export interface GatewaySyncSnapshotResult {
  sessionId: string;
  messages: GatewaySyncSnapshotMessage[];
  /** 继续拉**更早**消息时传给 `before` 的值；`null` = 没有更早的了。 */
  nextBefore: number | null;
  hasMore: boolean;
  /** 满足 `sinceTimestamp` 过滤后的总条数（不是本页条数）。 */
  total: number;
  /** 宿主账本当前已分配的最大 hostSeq（客户端据此把游标重置到快照点）。 */
  hostSeq: number;
  /** 被项目 allowlist 过滤掉的会话数（0/1；fail-closed 时为 1 且 `messages` 为空）。 */
  filteredSessions: number;
  serverTime: number;
}

export interface GatewaySyncMemoryOutcome {
  ok: boolean;
  /** 合并后的整份 payload（`ok:false` 时缺省）。 */
  payload?: string;
  entries?: number;
  conflicts?: unknown[];
  changed?: boolean;
  reason?: string;
}

/**
 * 宿主侧数据面（网关只按这个接口调用）。
 *
 * 四个方法都**不抛**业务错误：pull/push 的失败是内部异常（网关映射成 INTERNAL），
 * 记忆合并的失败是 `ok:false` + 原因（那是**可预期**的拒绝：payload 损坏/记忆未就绪）。
 */
export interface GatewaySyncApi {
  pull(input: GatewaySyncPullInput): Promise<GatewaySyncPullResult>;
  push(input: { deviceId: string; events: unknown[]; projectIds?: string[] }): Promise<GatewaySyncPushResult>;
  snapshot(input: GatewaySyncSnapshotInput): Promise<GatewaySyncSnapshotResult>;
  mergeMemory(input: { deviceId: string; payload: string }): Promise<GatewaySyncMemoryOutcome>;
}

/** 宿主侧 `session_events` 的一行（与 `event-log.readFrom` 的返回同形）。 */
export interface HostSyncStoredEvent {
  seq: number;
  sessionId: string;
  type: string;
  payload: string;
  timestamp: number;
}

/**
 * 注入的数据端口（生产实现见 `gateway-sync-host.ts`）。
 *
 * 为什么连"读日志"都是注入的：判据要能在**内存里**跑完两台设备的完整往返
 * （推 → 拉 → 游标推进 → 重复推送幂等），而不是起一个真桌面。
 */
export interface HostSyncPorts {
  now(): number;
  loadJournal(): unknown;
  saveJournal(journal: HostSyncJournal): void;
  /** 宿主当前所有会话语 id（有界由调用方决定）。 */
  listSessionIds(): string[];
  /**
   * 读某会话 seq ≥ fromSeq 的事件（**插入顺序**）。
   *
   * 顺序是硬要求：补扫靠"遇到未落定的占位就停下"来保证不漏，按 seq 排序会破坏它。
   */
  readEvents(sessionId: string, fromSeq: number): Promise<HostSyncStoredEvent[]>;
  /** 追加一条事件；返回落库 seq（`0` = 未落库）。 */
  appendEvent(sessionId: string, type: string, payload: Record<string, unknown>): number;
  /** 确保会话行存在（远端事件落库需要外键目标）；返回 false = 建不出来。 */
  ensureSession(
    sessionId: string,
    hint: { deviceId: string; timestamp: number; title?: string },
  ): boolean;
  /** 远端 `session_meta` 事件里的标题回写（可选：宿主没有会话面时不接）。 */
  updateSessionTitle?(sessionId: string, title: string): void;
  /**
   * 会话 → 项目（ACL 的唯一依据）。
   *
   * `null` = 没有项目映射（会话不存在/项目为空/读失败）—— **ACL 非空时一律拒绝**，
   * 因为"不知道归属"不能证明它在允许范围里（fail-closed）。
   */
  projectIdOfSession(sessionId: string): string | null;
  /** 读某会话的**完整时间线消息**（快照用；含工具调用/结果，按时间线顺序）。 */
  readSessionMessages(sessionId: string): Promise<GatewaySyncSnapshotMessage[]>;
  readMemoryPayload(): Promise<string | null>;
  mergeMemory(payload: string, deviceId: string): Promise<GatewaySyncMemoryOutcome>;
}

/** 日志条目：推送进来的（正文随日志）。 */
interface HostJournalPushEntry {
  kind: "push";
  hostSeq: number;
  eventId: string;
  deviceId: string;
  sessionId: string;
  type: string;
  /** 事件发生时间（发送方给的，LWW/展示用） */
  timestamp: number;
  /** 入账时间（宿主时钟；**保留策略按它算**，不按事件时间 —— 同步老历史不会被立刻清掉） */
  addedAt: number;
  digest: string;
  payload: Record<string, unknown>;
}

/** 日志条目：宿主自己的（正文在 `session_events`）。 */
interface HostJournalNativeEntry {
  kind: "native";
  hostSeq: number;
  eventId: string;
  deviceId: "host";
  sessionId: string;
  type: string;
  timestamp: number;
  addedAt: number;
  storageSeq: number;
}

type HostJournalEntry = HostJournalPushEntry | HostJournalNativeEntry;

export interface HostSyncJournal {
  version: 1;
  nextSeq: number;
  entries: HostJournalEntry[];
  /** 每个设备最近一次出现的时间（有界 {@link HOST_SYNC_DEVICE_MAX} 条）。 */
  devices: Record<string, number>;
  /**
   * 每个已拉取设备的水位：`deviceId → lastPulledSeq`（有界
   * {@link HOST_SYNC_DEVICE_CURSOR_MAX} 条）。
   *
   * 修剪只删 `hostSeq ≤ min(所有游标)` 的前缀 —— 这是「慢设备没拉的事件不被快设备
   * 拉动修剪」的唯一依据。缺省（旧账本）= 没有设备拉过，按时间保留。
   */
  deviceCursors: Record<string, number>;
  /** 已被修剪掉的最大 hostSeq（客户端 `sinceSeq < trimmedThrough` ⇒ resetRequired）。 */
  trimmedThrough: number;
  /** 累计按「所有设备都拉过」正常修剪掉的条数（可观测，不计入 `dropped`）。 */
  pruned: number;
  /** 宿主事件按会话的补扫水位（有界 {@link HOST_SYNC_NATIVE_CURSOR_MAX} 条）。 */
  nativeCursor: Record<string, number>;
  /** 补扫轮转起点（让"会话很多"时也能逐轮覆盖到）。 */
  scanIndex: number;
  /** 累计因超界/超期**策略性丢弃**的条目数（>0 要能看见）。 */
  dropped: number;
  /** 上述丢弃里「当时还有设备没拉过」的条数（这些设备会收到 resetRequired）。 */
  droppedUnpulled: number;
  updatedAt: number;
}

// ========== 纯工具 ==========

/** 估算一段字符串的 UTF-8 字节数（不建 Buffer：渲染层与判据都要能跑）。 */
export function estimateSyncBytes(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      i += 1; // 代理对：两个 UTF-16 单元算一个 4 字节字符
    } else bytes += 3;
  }
  return bytes;
}

/** 稳定序列化（键排序）：内容指纹与"同一条事件"的判定都必须与键序无关。 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`).join(",")}}`;
}

/** 事件内容指纹（FNV-1a 32 位；只用于"同 id 内容是否变了"）。 */
function syncEventDigest(event: {
  type: string;
  timestamp: number;
  payload: Record<string, unknown>;
}): string {
  const text = `${event.type}\u0000${event.timestamp}\u0000${stableStringify(event.payload)}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

/** 空账本。 */
function emptyHostSyncJournal(now = 0): HostSyncJournal {
  return {
    version: 1,
    nextSeq: 1,
    entries: [],
    devices: {},
    deviceCursors: {},
    trimmedThrough: 0,
    pruned: 0,
    nativeCursor: {},
    scanIndex: 0,
    dropped: 0,
    droppedUnpulled: 0,
    updatedAt: now,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readNonEmptyString(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) return "";
  return trimmed;
}

function readTimestamp(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** 从宿主事件 payload 里读同步标记（没有 = 宿主自己产生的事件）。 */
function readSyncMarker(payloadJson: string): { eventId: string; deviceId: string } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson);
  } catch {
    return null;
  }
  const marker = asRecord(asRecord(parsed)?.[SYNC_MARKER_KEY]);
  if (!marker) return null;
  const eventId = typeof marker.eventId === "string" ? marker.eventId : "";
  const deviceId = typeof marker.deviceId === "string" ? marker.deviceId : "";
  if (!eventId || !deviceId) return null;
  return { eventId, deviceId };
}

/**
 * 把任意来源的账本"规整"成可用形态（**不信任磁盘上的形状**）。
 *
 * 坏账本按空账本处理并留一条 advisory：过期/被改坏的账本继续用下去，
 * 后果是游标乱跳（客户端漏事件），比"从当下重新开始"更糟。
 */
export function normalizeHostSyncJournal(raw: unknown, now: number): HostSyncJournal {
  const record = asRecord(raw);
  if (!record) return emptyHostSyncJournal(now);
  const entries: HostJournalEntry[] = [];
  const rawEntries = Array.isArray(record.entries) ? record.entries : [];
  for (const item of rawEntries) {
    const e = asRecord(item);
    if (!e) continue;
    const hostSeq = Number(e.hostSeq);
    const sessionId = typeof e.sessionId === "string" ? e.sessionId : "";
    const type = typeof e.type === "string" ? e.type : "";
    const timestamp = readTimestamp(e.timestamp);
    if (!Number.isFinite(hostSeq) || hostSeq <= 0 || !sessionId || !type) continue;
    if (e.kind === "push") {
      const payload = asRecord(e.payload);
      if (!payload) continue;
      entries.push({
        kind: "push",
        hostSeq: Math.floor(hostSeq),
        eventId: typeof e.eventId === "string" ? e.eventId : "",
        deviceId: typeof e.deviceId === "string" ? e.deviceId : "unknown",
        sessionId,
        type,
        timestamp,
        addedAt: readTimestamp(e.addedAt),
        digest: typeof e.digest === "string" ? e.digest : "",
        payload,
      });
      continue;
    }
    if (e.kind === "native") {
      const storageSeq = Number(e.storageSeq);
      if (!Number.isFinite(storageSeq) || storageSeq <= 0) continue;
      entries.push({
        kind: "native",
        hostSeq: Math.floor(hostSeq),
        eventId: typeof e.eventId === "string" ? e.eventId : "",
        deviceId: "host",
        sessionId,
        type,
        timestamp,
        addedAt: readTimestamp(e.addedAt),
        storageSeq: Math.floor(storageSeq),
      });
    }
  }
  entries.sort((a, b) => a.hostSeq - b.hostSeq);
  const devices: Record<string, number> = {};
  for (const [k, v] of Object.entries(asRecord(record.devices) ?? {})) {
    const at = readTimestamp(v);
    if (at) devices[k] = at;
  }
  const nativeCursor: Record<string, number> = {};
  for (const [k, v] of Object.entries(asRecord(record.nativeCursor) ?? {})) {
    const seq = Number(v);
    if (Number.isFinite(seq) && seq > 0) nativeCursor[k] = Math.floor(seq);
  }
  const deviceCursors: Record<string, number> = {};
  for (const [k, v] of Object.entries(asRecord(record.deviceCursors) ?? {})) {
    const seq = Number(v);
    if (!k || !Number.isFinite(seq) || seq <= 0) continue;
    deviceCursors[k] = Math.floor(seq);
  }
  const nextSeqRaw = Number(record.nextSeq);
  const maxHostSeq = entries.length ? entries[entries.length - 1].hostSeq : 0;
  const nextSeq = Math.max(
    Number.isFinite(nextSeqRaw) && nextSeqRaw > 0 ? Math.floor(nextSeqRaw) : 1,
    maxHostSeq + 1,
  );
  const trimmedRaw = Number(record.trimmedThrough);
  const trimmedThrough = Math.min(
    nextSeq - 1,
    Number.isFinite(trimmedRaw) && trimmedRaw > 0 ? Math.floor(trimmedRaw) : 0,
  );
  return {
    version: 1,
    nextSeq,
    entries,
    devices,
    deviceCursors,
    trimmedThrough,
    pruned: Number.isFinite(Number(record.pruned)) ? Math.max(0, Math.floor(Number(record.pruned))) : 0,
    nativeCursor,
    scanIndex: Number.isFinite(Number(record.scanIndex)) ? Math.max(0, Math.floor(Number(record.scanIndex))) : 0,
    dropped: Number.isFinite(Number(record.dropped)) ? Math.max(0, Math.floor(Number(record.dropped))) : 0,
    droppedUnpulled: Number.isFinite(Number(record.droppedUnpulled))
      ? Math.max(0, Math.floor(Number(record.droppedUnpulled)))
      : 0,
    updatedAt: readTimestamp(record.updatedAt) || now,
  };
}

/** 账本规模读数（设置面板展示"本机作为 Host"的那一行）。 */
export function summarizeHostSyncJournal(journal: HostSyncJournal): {
  entries: number;
  pushEntries: number;
  nativeEntries: number;
  devices: number;
  cursors: number;
  pruned: number;
  dropped: number;
  droppedUnpulled: number;
  bytes: number;
  nextSeq: number;
  trimmedThrough: number;
  updatedAt: number;
} {
  let pushEntries = 0;
  for (const e of journal.entries) if (e.kind === "push") pushEntries += 1;
  return {
    entries: journal.entries.length,
    pushEntries,
    nativeEntries: journal.entries.length - pushEntries,
    devices: Object.keys(journal.devices).length,
    cursors: Object.keys(journal.deviceCursors).length,
    pruned: journal.pruned,
    dropped: journal.dropped,
    droppedUnpulled: journal.droppedUnpulled,
    bytes: estimateSyncBytes(JSON.stringify(journal)),
    nextSeq: journal.nextSeq,
    trimmedThrough: journal.trimmedThrough,
    updatedAt: journal.updatedAt,
  };
}

/** 所有已知设备里最小的拉取游标（没有设备游标 ⇒ 0）。 */
function minDeviceCursor(journal: HostSyncJournal): number {
  const cursors = Object.values(journal.deviceCursors);
  return cursors.length > 0 ? Math.min(...cursors) : 0;
}

/**
 * 账本修剪（**不丢未拉取事件**）。
 *
 * 三步，顺序不能换：
 * 1. **正常修剪**：删掉 `hostSeq ≤ min(所有设备游标)` 的前缀 —— 所有已知读者都已拉过，
 *    删了不影响任何人。没有设备游标时这一步不做；
 * 2. **没有设备游标时的保留策略**：按时间保留 {@link HOST_SYNC_RETENTION_MS}，
 *    并最多保留 {@link HOST_SYNC_JOURNAL_MAX_ENTRIES} 条（还没有任何客户端，数据没有已知读者）；
 * 3. **超界但仍有读者**：条数/字节超过上限、而已无「所有人都拉过」的前缀可删时，
 *    **一条都不丢**，只回报 `overCapacity`（由 pull 回 `resetRequired`，让落后的设备
 *    走快照重建后自然释放）。这是本函数的硬规则：慢设备没拉的事件不许被快设备拉动修剪。
 *
 * @returns `overCapacity`：账本仍在上限之上（调用方要在 pull 结果里如实回 `resetRequired`）
 */
function trimJournal(
  journal: HostSyncJournal,
  now: number,
): { pressureDropped: number; overCapacity: boolean } {
  const hasCursors = Object.keys(journal.deviceCursors).length > 0;
  // 1) 所有已知设备都拉过的前缀：正常修剪（不计入 dropped）
  if (hasCursors) {
    const cursor = minDeviceCursor(journal);
    let drop = 0;
    while (drop < journal.entries.length && journal.entries[drop].hostSeq <= cursor) drop += 1;
    if (drop > 0) {
      const lastDropped = journal.entries[drop - 1].hostSeq;
      journal.entries.splice(0, drop);
      journal.trimmedThrough = Math.max(journal.trimmedThrough, lastDropped);
      journal.pruned += drop;
    }
  } else {
    // 2) 还没有任何设备拉过：按**入账时间**保留 7 天，再按条数上限兜底
    const cutoff = now - HOST_SYNC_RETENTION_MS;
    let expired = 0;
    while (
      expired < journal.entries.length &&
      journal.entries[expired].addedAt > 0 &&
      journal.entries[expired].addedAt < cutoff
    ) {
      expired += 1;
    }
    if (expired > 0) {
      const lastDropped = journal.entries[expired - 1].hostSeq;
      journal.entries.splice(0, expired);
      journal.dropped += expired;
      journal.droppedUnpulled += expired;
      journal.trimmedThrough = Math.max(journal.trimmedThrough, lastDropped);
    }
    if (journal.entries.length > HOST_SYNC_JOURNAL_MAX_ENTRIES) {
      const drop = journal.entries.length - HOST_SYNC_JOURNAL_MAX_ENTRIES;
      const lastDropped = journal.entries[drop - 1].hostSeq;
      journal.entries.splice(0, drop);
      journal.dropped += drop;
      journal.droppedUnpulled += drop;
      journal.trimmedThrough = Math.max(journal.trimmedThrough, lastDropped);
    }
  }
  /*
   * 3) 硬上限保护（**最后手段**）：条数/字节真的压不住了才删最旧的。
   *
   * 走到这里说明「还留在账本里的条目，至少有一台设备没拉过」（第 1 步已经把所有
   * 设备都拉过的前缀删干净了）⇒ 每一条压力丢弃都记进 `droppedUnpulled`，
   * 并抬高 `trimmedThrough`：受影响设备的下一轮 pull 会拿到 `resetRequired`，
   * 用快照重建，**不会静默缺事件**。正常容量（≤5 万条 / ≤8 MB）下这一步不会触发。
   */
  let drop = 0;
  let bytes = estimateSyncBytes(JSON.stringify(journal));
  while (
    (journal.entries.length - drop > HOST_SYNC_JOURNAL_MAX_ENTRIES || bytes > HOST_SYNC_JOURNAL_MAX_BYTES) &&
    drop < journal.entries.length
  ) {
    bytes -= estimateSyncBytes(JSON.stringify(journal.entries[drop]));
    drop += 1;
  }
  if (drop > 0) {
    const lastDropped = journal.entries[drop - 1].hostSeq;
    journal.entries.splice(0, drop);
    journal.dropped += drop;
    journal.droppedUnpulled += drop;
    journal.trimmedThrough = Math.max(journal.trimmedThrough, lastDropped);
  }
  const overCapacity =
    journal.entries.length > HOST_SYNC_JOURNAL_MAX_ENTRIES ||
    estimateSyncBytes(JSON.stringify(journal)) > HOST_SYNC_JOURNAL_MAX_BYTES;
  return { pressureDropped: drop, overCapacity };
}

/**
 * 一台设备能证明「已经拉完」到哪：它的游标不能倒退，也不能超过宿主已分配的 hostSeq。
 *
 * 为什么不直接信客户端上报的 `nextSeq`：游标只增（重复拉取由 eventId 幂等挡住），
 * 倒退会让「已拉过」的前缀被误判成未拉，账本无谓地变大。
 */
function advanceDeviceCursor(journal: HostSyncJournal, deviceId: string, seq: number): void {
  if (!deviceId || !Number.isFinite(seq) || seq <= 0) return;
  const bounded = Math.min(Math.floor(seq), journal.nextSeq - 1);
  if (bounded <= 0) return;
  journal.deviceCursors[deviceId] = Math.max(journal.deviceCursors[deviceId] ?? 0, bounded);
  const entries = Object.entries(journal.deviceCursors);
  if (entries.length <= HOST_SYNC_DEVICE_CURSOR_MAX) return;
  // 超界保留游标最大的那些：被淘汰的设备下次会收到 resetRequired（快照重建），不会静默缺事件
  entries.sort((a, b) => b[1] - a[1]);
  journal.deviceCursors = Object.fromEntries(entries.slice(0, HOST_SYNC_DEVICE_CURSOR_MAX));
}

/** 项目 allowlist 归一化（去空白 / 去重 / 截断；空数组 = 全部）。 */
function normalizeProjectIds(value: unknown): string[] {
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

/**
 * 项目范围闸门（每个请求一个实例：同一会话只查一次）。
 *
 * 空 allowlist = 全部放行，且**不调用** `projectIdOfSession`（没有范围时不需要项目面）。
 * 非空时：没有项目映射（`null`/读失败）⇒ 拒绝（fail-closed）。
 */
function createProjectGate(
  ports: HostSyncPorts,
  projectIds: unknown,
): { allowed(sessionId: string): boolean; acl: string[] } {
  const acl = normalizeProjectIds(projectIds);
  const cache = new Map<string, boolean>();
  const allowed = (sessionId: string): boolean => {
    if (acl.length === 0) return true;
    const cached = cache.get(sessionId);
    if (cached !== undefined) return cached;
    let projectId: string | null = null;
    try {
      projectId = ports.projectIdOfSession(sessionId);
    } catch {
      projectId = null; // 读失败 = 不知道归属 = 拒绝
    }
    const ok = typeof projectId === "string" && projectId.length > 0 && acl.includes(projectId);
    cache.set(sessionId, ok);
    return ok;
  };
  return { allowed, acl };
}

function touchDevice(journal: HostSyncJournal, deviceId: string, now: number): void {
  journal.devices[deviceId] = now;
  const ids = Object.entries(journal.devices).sort((a, b) => b[1] - a[1]);
  if (ids.length > HOST_SYNC_DEVICE_MAX) {
    journal.devices = Object.fromEntries(ids.slice(0, HOST_SYNC_DEVICE_MAX));
  }
}

function touchNativeCursor(journal: HostSyncJournal, sessionId: string, seq: number): void {
  journal.nativeCursor[sessionId] = seq;
  const ids = Object.entries(journal.nativeCursor);
  if (ids.length <= HOST_SYNC_NATIVE_CURSOR_MAX) return;
  // 超界按"水位最旧"丢弃：水位小 = 那台会话落后最多，下一次补扫会从 0 重来（重复入账由 eventId 幂等挡住）
  ids.sort((a, b) => a[1] - b[1]);
  for (const [id] of ids.slice(0, ids.length - HOST_SYNC_NATIVE_CURSOR_MAX)) {
    delete journal.nativeCursor[id];
  }
}

// ========== 宿主侧 API ==========

/**
 * 建一个宿主侧同步 API（数据全部来自注入端口）。
 *
 * 无状态：账本每次从 `ports.loadJournal()` 读、结束时 `saveJournal()` 写回 ——
 * 于是"网关重启/桌面重启"不影响游标，也让判据可以在两条 RPC 之间换实现。
 */
export function createHostSyncApi(ports: HostSyncPorts): GatewaySyncApi {
  const load = (): HostSyncJournal => normalizeHostSyncJournal(ports.loadJournal(), ports.now());

  /**
   * 补扫宿主自己的事件进账本（有界、轮转）。
   *
   * 关键规则：**遇到未落定的占位 seq 就停**。占位会在落库后变成真 seq，而真 seq 一定
   * 落在"上一条已落库事件"之后 —— 所以只要水位不前移到占位之后，就不会漏事件。
   */
  async function scanNative(
    journal: HostSyncJournal,
    requested: string[] | undefined,
    now: number,
  ): Promise<number> {
    const requestedIds = Array.isArray(requested)
      ? requested.filter((id): id is string => typeof id === "string" && id.length > 0).slice(0, HOST_SYNC_SCAN_SESSIONS_PER_PULL)
      : [];
    const all = ports.listSessionIds().filter((id) => typeof id === "string" && id.length > 0);
    const pool = requestedIds.length > 0 ? requestedIds : all;
    if (pool.length === 0) return 0;
    const start = pool.length ? journal.scanIndex % pool.length : 0;
    journal.scanIndex = (start + 1) % pool.length;
    const ordered: string[] = [];
    for (let i = 0; i < pool.length; i += 1) {
      const id = pool[(start + i) % pool.length];
      if (!ordered.includes(id)) ordered.push(id);
      if (ordered.length >= HOST_SYNC_SCAN_SESSIONS_PER_PULL) break;
    }
    let budget = HOST_SYNC_SCAN_EVENTS_PER_PULL;
    let scanned = 0;
    for (const sessionId of ordered) {
      if (budget <= 0) break;
      let rows: HostSyncStoredEvent[];
      try {
        rows = await ports.readEvents(sessionId, (journal.nativeCursor[sessionId] ?? 0) + 1);
      } catch (e) {
        // 单个会话读失败不该让整次 pull 失败：如实上报，下一轮再试。
        reportAdvisory(
          "sync.hostScanFailed",
          `补扫会话事件失败（本次跳过该会话，下一轮重试）：${sessionId}`,
          { sample: String((e as Error)?.message ?? e) },
        );
        continue;
      }
      if (rows.length === 0) continue;
      scanned += 1;
      let perSession = 0;
      let settledSeq = 0;
      for (const row of rows) {
        const seq = Number(row?.seq);
        if (!Number.isFinite(seq) || seq <= 0) break;
        if (seq >= SYNC_PLACEHOLDER_SEQ_FLOOR) break; // 未落定：停在这里，等它落库
        if (seq <= (journal.nativeCursor[sessionId] ?? 0)) continue;
        if (readSyncMarker(String(row.payload ?? ""))) {
          // 同步推上来的事件：入账在 push 时就做过了，补扫只推进水位
          settledSeq = seq;
          continue;
        }
        if (budget <= 0 || perSession >= HOST_SYNC_SCAN_EVENTS_PER_SESSION) break;
        journal.entries.push({
          kind: "native",
          hostSeq: journal.nextSeq++,
          eventId: `host:${sessionId}:${seq}`,
          deviceId: "host",
          sessionId,
          type: String(row.type ?? ""),
          timestamp: readTimestamp(row.timestamp) || now,
          addedAt: now,
          storageSeq: seq,
        });
        budget -= 1;
        perSession += 1;
        settledSeq = seq;
      }
      if (settledSeq > 0) touchNativeCursor(journal, sessionId, settledSeq);
    }
    return scanned;
  }

  /** 给一批 native 条目补正文（按会话批量读，避免一条一次 IPC）。 */
  async function resolveNativeBodies(entries: readonly HostJournalEntry[]): Promise<{
    bodies: Map<number, HostSyncStoredEvent>;
  }> {
    const wanted = new Map<string, Set<number>>();
    for (const entry of entries) {
      if (entry.kind !== "native") continue;
      const set = wanted.get(entry.sessionId) ?? new Set<number>();
      set.add(entry.storageSeq);
      wanted.set(entry.sessionId, set);
    }
    const bodies = new Map<number, HostSyncStoredEvent>();
    for (const [sessionId, seqs] of wanted) {
      const from = Math.min(...seqs);
      let rows: HostSyncStoredEvent[] = [];
      try {
        rows = await ports.readEvents(sessionId, from);
      } catch {
        rows = [];
      }
      for (const row of rows) {
        if (seqs.has(Number(row.seq))) bodies.set(Number(row.seq), row);
      }
    }
    return { bodies };
  }

  return {
    async pull(input: GatewaySyncPullInput): Promise<GatewaySyncPullResult> {
      const now = ports.now();
      const journal = load();
      const limitRaw = Number(input?.limit);
      const limit = Number.isFinite(limitRaw) && limitRaw > 0
        ? Math.min(SYNC_MAX_PULL_EVENTS, Math.floor(limitRaw))
        : SYNC_MAX_PULL_EVENTS;
      const sinceRaw = Number(input?.sinceSeq);
      const sinceSeq = Number.isFinite(sinceRaw) && sinceRaw > 0 ? Math.floor(sinceRaw) : 0;
      const deviceId = readNonEmptyString(input?.deviceId, SYNC_MAX_SESSION_ID_LEN);
      const scannedSessions = await scanNative(journal, input?.sessionIds, now);
      const gate = createProjectGate(ports, input?.projectIds);

      /*
       * 重置判定（进入本次 pull 时的账本状态）：
       * - 游标落在已修剪范围里（`sinceSeq < trimmedThrough`）⇒ 那段事件已经不在账本里了；
       * - 游标超过宿主分配过的最大 hostSeq ⇒ 账本被重建/清空过，继续「从这之后拉」会永远空转。
       * 两种情况都**不能**回一个空增量让客户端以为同步完成。
       */
      const aheadOfHost = sinceSeq >= journal.nextSeq && sinceSeq > 0;
      const behindTrim = journal.trimmedThrough > 0 && sinceSeq < journal.trimmedThrough;
      const resetBefore = aheadOfHost || behindTrim;

      const filtered = new Set<string>();
      const allowedCandidates: HostJournalEntry[] = [];
      for (const entry of journal.entries) {
        if (entry.hostSeq <= sinceSeq) continue;
        if (!gate.allowed(entry.sessionId)) {
          filtered.add(entry.sessionId);
          continue;
        }
        allowedCandidates.push(entry);
      }

      const picked = resetBefore ? [] : allowedCandidates.slice(0, limit);
      const { bodies } = await resolveNativeBodies(picked);
      const events: GatewayPulledEvent[] = [];
      /** 正文已不可读（会话被删/事件被清）的条目：从账本摘掉并计数 */
      const missing = new Set<number>();
      let bytes = 0;
      let nextSeq = sinceSeq;
      for (const entry of picked) {
        let built: GatewayPulledEvent | null = null;
        if (entry.kind === "native") {
          const row = bodies.get(entry.storageSeq);
          if (row) {
            let payload: Record<string, unknown> = {};
            try {
              const parsed = JSON.parse(row.payload);
              payload = asRecord(parsed) ?? { value: parsed };
            } catch {
              payload = { raw: String(row.payload ?? "") };
            }
            const marker = readSyncMarker(String(row.payload ?? ""));
            built = {
              hostSeq: entry.hostSeq,
              eventId: marker?.eventId || entry.eventId,
              // 带标记的是被推上来的（可能由别的设备产生）；否则就是宿主自己
              deviceId: marker?.deviceId || "host",
              sessionId: entry.sessionId,
              type: String(row.type ?? entry.type),
              payload,
              timestamp: readTimestamp(row.timestamp) || entry.timestamp,
            };
          } else {
            // 会话被删/事件被清：正文不可读 ⇒ 这条不再发（计入 missingBodies 让它可观测）
            missing.add(entry.hostSeq);
            nextSeq = entry.hostSeq;
            continue;
          }
        } else {
          built = {
            hostSeq: entry.hostSeq,
            eventId: entry.eventId,
            deviceId: entry.deviceId,
            sessionId: entry.sessionId,
            type: entry.type,
            payload: entry.payload,
            timestamp: entry.timestamp,
          };
        }
        const size = estimateSyncBytes(JSON.stringify(built)) + 64;
        // 字节上限：至少发一条（否则大事件会让游标永远停住），之后到界即止
        if (events.length > 0 && bytes + size > SYNC_MAX_RESPONSE_BYTES) break;
        bytes += size;
        events.push(built);
        nextSeq = entry.hostSeq;
      }
      // 正文缺失的条目从账本里摘掉：留着也只会每轮多一次无效读。
      // 同时抬高 trimmedThrough —— 别的设备如果不在这条之后，也会收到 resetRequired（不许静默缺一条）。
      if (missing.size > 0) {
        const maxMissing = Math.max(...missing);
        journal.entries = journal.entries.filter((e) => !missing.has(e.hostSeq));
        journal.trimmedThrough = Math.max(journal.trimmedThrough, maxMissing);
        journal.droppedUnpulled += missing.size;
      }

      const previousCursor = deviceId ? journal.deviceCursors[deviceId] : undefined;
      if (!resetBefore && deviceId) {
        advanceDeviceCursor(journal, deviceId, nextSeq);
        touchDevice(journal, deviceId, now);
      }
      const { overCapacity } = trimJournal(journal, now);

      /*
       * 修剪之后重新判一次：如果这次按容量的最后手段丢弃发生在**本设备游标之后**，
       * 本设备也不能拿着「只拉到 nextSeq」的回应走 —— 撤回本次事件、游标回到原值，
       * 回 `resetRequired` 让它用快照重建（丢弃本身已经在 droppedUnpulled 里计数）。
       */
      const trimmedPastCaller = journal.trimmedThrough > 0 && nextSeq < journal.trimmedThrough;
      const resetAfter = resetBefore || trimmedPastCaller || overCapacity;
      if (resetAfter && !resetBefore) {
        events.length = 0;
        nextSeq = sinceSeq;
        if (deviceId) {
          if (previousCursor === undefined) delete journal.deviceCursors[deviceId];
          else journal.deviceCursors[deviceId] = previousCursor;
        }
      }
      const hasMore = allowedCandidates.some((e) => e.hostSeq > nextSeq);
      journal.updatedAt = now;
      ports.saveJournal(journal);
      return {
        events,
        nextSeq,
        hasMore,
        devices: Object.keys(journal.devices).length,
        scannedSessions,
        missingBodies: missing.size,
        droppedEntries: journal.dropped,
        droppedUnpulled: journal.droppedUnpulled,
        resetRequired: resetAfter,
        oldestSeq: journal.entries.length ? journal.entries[0].hostSeq : journal.nextSeq,
        filteredSessions: filtered.size,
        overCapacity,
        serverTime: now,
      };
    },

    async push(input): Promise<GatewaySyncPushResult> {
      const now = ports.now();
      const journal = load();
      const deviceId = readNonEmptyString(input?.deviceId, SYNC_MAX_SESSION_ID_LEN);
      const gate = createProjectGate(ports, input?.projectIds);
      const rawEvents = Array.isArray(input?.events) ? input.events.slice(0, SYNC_MAX_PUSH_EVENTS) : [];
      const byEventId = new Map<string, HostJournalEntry>();
      for (const entry of journal.entries) byEventId.set(entry.eventId, entry);
      const filtered = new Set<string>();
      const result: GatewaySyncPushResult = {
        accepted: 0,
        duplicates: 0,
        rejected: [],
        hostSeqMax: 0,
        devices: 0,
        storageFailed: 0,
        filteredSessions: 0,
      };
      for (const raw of rawEvents) {
        const record = asRecord(raw);
        const eventId = readNonEmptyString(record?.eventId, SYNC_MAX_EVENT_ID_LEN);
        if (!record || !deviceId || !eventId) {
          result.rejected.push({ eventId, reason: "invalid" });
          continue;
        }
        const sessionId = readNonEmptyString(record.sessionId, SYNC_MAX_SESSION_ID_LEN);
        const type = readNonEmptyString(record.type, SYNC_MAX_TYPE_LEN);
        const payload = asRecord(record.payload);
        const timestamp = readTimestamp(record.timestamp);
        if (!sessionId || !type || !payload || !timestamp) {
          result.rejected.push({ eventId, reason: "invalid" });
          continue;
        }
        const claimedDevice = readNonEmptyString(record.deviceId, SYNC_MAX_SESSION_ID_LEN);
        if (claimedDevice && claimedDevice !== deviceId) {
          // 一台设备不能替别的设备写事件（否则"来源"这个字段就没有意义了）
          result.rejected.push({ eventId, reason: "foreign-device" });
          continue;
        }
        if (estimateSyncBytes(JSON.stringify(payload)) > SYNC_MAX_PAYLOAD_BYTES) {
          result.rejected.push({ eventId, reason: "invalid" });
          continue;
        }
        /*
         * 项目 ACL（fail-closed）：范围外的会话拒收；**没有项目映射也拒收** ——
         * 不能证明这条事件属于允许的项目，就不能让它进宿主账本（更不能建会话）。
         */
        if (!gate.allowed(sessionId)) {
          filtered.add(sessionId);
          result.rejected.push({ eventId, reason: "project-forbidden" });
          continue;
        }
        const digest = syncEventDigest({ type, timestamp, payload });
        const existing = byEventId.get(eventId);
        if (existing) {
          if (existing.kind === "push" && existing.digest === digest) {
            result.duplicates += 1;
          } else {
            // 同 id 不同内容：拒绝（静默接受会让两台设备的同一事件永久分叉）
            result.rejected.push({ eventId, reason: "conflict" });
            reportAdvisory(
              "sync.pushConflict",
              `拒收一条内容与宿主记录不一致的事件（同一 eventId 被改写了）：${eventId}`,
            );
          }
          continue;
        }
        if (!ports.ensureSession(sessionId, { deviceId, timestamp })) {
          result.rejected.push({ eventId, reason: "session-unknown" });
          continue;
        }
        const entry: HostJournalPushEntry = {
          kind: "push",
          hostSeq: journal.nextSeq++,
          eventId,
          deviceId,
          sessionId,
          type,
          timestamp,
          addedAt: now,
          digest,
          payload,
        };
        journal.entries.push(entry);
        byEventId.set(eventId, entry);
        result.accepted += 1;
        /*
         * 宿主本地可见性：把事件写进桌面自己的 `session_events`（这样桌面的消息/投影
         * 也能看到远端发来的内容）。带 `__sync` 标记 —— 补扫见到标记就不重复入账。
         *
         * 写不进去（端口未就绪 / 未落库 seq=0）**不影响账本**：账本已经收下这条，
         * 对端仍能拉到；但宿主看不到它，所以必须如实上报（否则就是"推成功了但消息没出现"）。
         */
        const storageSeq = ports.appendEvent(sessionId, type, {
          ...payload,
          [SYNC_MARKER_KEY]: { eventId, deviceId },
        });
        if (!storageSeq) {
          result.storageFailed += 1;
          reportPersistFailure(
            "sync.hostAppend",
            new Error("宿主事件日志未接手（seq=0）"),
            "远端推来的事件已记账，但宿主本机事件日志没有写入（本机看不到这条消息）",
          );
        } else if (type === "session_meta") {
          // 会话标题跟着 session_meta 走：否则宿主会话列表里全是"同步会话（来自 …）"
          const title = typeof payload.title === "string" ? payload.title : "";
          if (title) ports.updateSessionTitle?.(sessionId, title);
        }
      }
      result.devices = Object.keys(journal.devices).length;
      result.hostSeqMax = journal.nextSeq - 1;
      result.filteredSessions = filtered.size;
      if (deviceId && (result.accepted > 0 || result.duplicates > 0)) touchDevice(journal, deviceId, now);
      journal.updatedAt = now;
      trimJournal(journal, now);
      ports.saveJournal(journal);
      result.devices = Object.keys(journal.devices).length;
      return result;
    },

    /**
     * 会话消息快照（冷启动/游标落后时的重建来源）。
     *
     * 只读：不改账本、不推进游标（游标由客户端拿 `hostSeq` 自己重置）。
     * 分页是**从新往旧**（`nextBefore` 就是翻更早一页的游标），客户端收齐后按时间线
     * 正序写入本地消息存储（重复 id 幂等）。
     */
    async snapshot(input: GatewaySyncSnapshotInput): Promise<GatewaySyncSnapshotResult> {
      const now = ports.now();
      const journal = load();
      const sessionId = readNonEmptyString(input?.sessionId, SYNC_MAX_SESSION_ID_LEN);
      const hostSeq = journal.nextSeq - 1;
      const empty = (filteredSessions: number, total = 0): GatewaySyncSnapshotResult => ({
        sessionId,
        messages: [],
        nextBefore: null,
        hasMore: false,
        total,
        hostSeq,
        filteredSessions,
        serverTime: now,
      });
      if (!sessionId) return empty(0);
      const gate = createProjectGate(ports, input?.projectIds);
      if (!gate.allowed(sessionId)) return empty(1);
      /*
       * 读失败**不吞**：让异常冒到网关的 catch（答 INTERNAL，客户端下一轮重试）。
       * 回一个空快照会被客户端当成「这个会话没有消息」，那是比失败更糟的假成功。
       * （生产端口的读失败在上报与措辞上见 `gateway-sync-host.ts::sync.hostReadMessages`。）
       */
      const messages = await ports.readSessionMessages(sessionId);
      const sinceRaw = Number(input?.sinceTimestamp);
      const sinceTimestamp = Number.isFinite(sinceRaw) && sinceRaw > 0 ? Math.floor(sinceRaw) : 0;
      const scoped = sinceTimestamp > 0 ? messages.filter((m) => m.timestamp >= sinceTimestamp) : messages;
      const total = scoped.length;
      const limitRaw = Number(input?.limit);
      const limit = Number.isFinite(limitRaw) && limitRaw > 0
        ? Math.min(SYNC_SNAPSHOT_MAX_MESSAGES, Math.floor(limitRaw))
        : SYNC_SNAPSHOT_MAX_MESSAGES;
      const beforeRaw = Number(input?.before);
      const end = Number.isFinite(beforeRaw) && beforeRaw >= 0
        ? Math.min(total, Math.floor(beforeRaw))
        : total;
      const start = Math.max(0, end - limit);
      /*
       * 字节预算：从**最新**一条往前装，装不下就少给几条老的（下次用 `nextBefore` 继续）。
       * 至少给一条 —— 单条消息超过页预算时宁可这一页超一点，也不截断内容（截断等于伪造
       * 「完整可读」）。Rust 出站通道有 4 MB 上限，这是已知的硬边界（见 25 号文）。
       */
      let from = end;
      let bytes = 0;
      for (let i = end - 1; i >= start; i -= 1) {
        const size = estimateSyncBytes(JSON.stringify(scoped[i])) + 32;
        if (from < end && bytes + size > SYNC_SNAPSHOT_MAX_BYTES) break;
        bytes += size;
        from = i;
      }
      const page = scoped.slice(from, end);
      const nextBefore = from > 0 ? from : null;
      return {
        sessionId,
        messages: page,
        nextBefore,
        hasMore: from > 0,
        total,
        hostSeq,
        filteredSessions: 0,
        serverTime: now,
      };
    },

    async mergeMemory(input): Promise<GatewaySyncMemoryOutcome> {
      const deviceId = readNonEmptyString(input?.deviceId, SYNC_MAX_SESSION_ID_LEN);
      const payload = typeof input?.payload === "string" ? input.payload : "";
      if (!deviceId) return { ok: false, reason: "deviceId 必填" };
      if (!payload.trim()) return { ok: false, reason: "payload 必填（记忆整份 JSON）" };
      if (estimateSyncBytes(payload) > SYNC_MAX_MEMORY_BYTES) {
        return { ok: false, reason: `payload 超过上限（${SYNC_MAX_MEMORY_BYTES} 字节）` };
      }
      const outcome = await ports.mergeMemory(payload, deviceId);
      if (outcome.ok) {
        const journal = load();
        touchDevice(journal, deviceId, ports.now());
        journal.updatedAt = ports.now();
        trimJournal(journal, ports.now());
        ports.saveJournal(journal);
      }
      return outcome;
    },
  };
}
