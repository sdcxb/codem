/**
 * 一次性配对 + 设备令牌（D-7）—— **纯 Host 侧**，不依赖 HTTP / React。
 *
 * ## 凭据模型（只有一套）
 *
 * - **配对码**：6 位数字，只在内存，5 分钟 TTL，单活动码，单次使用；
 * - **设备 token**：32 字节随机数的 64 位 hex，`claim()` 时生成一次并交给 Host；
 *   Host 只把它写进 `Set-Cookie`（HttpOnly），**不放进 JSON 响应**；服务端只存
 *   `sha256(token)`，落盘文件里没有明文。
 *
 * 不落盘配对码：TTL 只有 5 分钟、单次使用、Host 重启即失效，落盘只会扩大泄露面并
 * 引入"重启后旧码还能用"这种没人想要的语义。
 *
 * ## 为什么不用 SQLite / settings 表
 *
 * 凭据 hash 一旦进用户数据库，就会跟着导出/备份/库 salvage 一起跑（codem-db 的
 * `settings` 会被抄进旁路文件）。设备最多 8 条，原子 JSON 足够，而且和
 * `host/tool-names.json` 是同一个目录、同一套纪律。
 *
 * ## 硬纪律
 *
 * - **先持久化成功，再返回 token / 再回复撤销成功**：写失败时不能假成功，否则重启后
 *   token 消失（用户配对白做）或已撤销的 token 复活（安全缺陷）。
 * - **比较必须常数时间**：配对码与 token 都用 sha256 + `timingSafeEqual`；
 *   `authenticate()` 遍历全部设备、不提前退出。
 * - **损坏 fail-closed**：凭据文件损坏时隔离它并清空设备（非秘密 warning），
 *   但绝不因此放开匿名访问 —— 是否免鉴权由 `authMode` 决定，与文件状态无关。
 * - **多进程 fail-closed**：`pairing.json.lock` 保证同一数据目录只有一个 Host 在写设备表，
 *   否则两个进程会各自缓存设备列表、互相覆盖撤销结果。
 */

import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { mkdir, open as openFile, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { PairDevicePlatform, PairDeviceView } from "../../protocol/src/index";

/** 配对码有效期：5 分钟（与手机端倒计时一致） */
export const PAIR_CODE_TTL_MS = 5 * 60 * 1000;
/** 设备上限：达到后拒绝新配对，**不静默淘汰最旧设备**（撤销必须显式） */
export const MAX_PAIRED_DEVICES = 8;
/** 单个配对码允许的错误尝试次数 */
export const MAX_ATTEMPTS_PER_CODE = 10;
/** 限速窗口与窗口内允许的错误次数（跨码，防"猜完一个再换一个"） */
export const RATE_WINDOW_MS = 60 * 1000;
export const MAX_ATTEMPTS_PER_WINDOW = 5;

export type PairingFailureReason =
  | "invalid"
  | "expired"
  | "used"
  | "locked"
  | "rate_limited"
  | "device_limit";

export class PairingError extends Error {
  readonly reason: PairingFailureReason;
  /** 只对 rate_limited 有值（毫秒） */
  readonly retryAfterMs: number | undefined;

  constructor(reason: PairingFailureReason, retryAfterMs?: number) {
    super(`配对失败：${reason}`);
    this.name = "PairingError";
    this.reason = reason;
    this.retryAfterMs = retryAfterMs;
  }
}

/** 另一个 Host 正在使用同一数据目录（不是"文件损坏"，不要自动清掉别人的锁）。 */
export class PairingBusyError extends Error {
  readonly code = "BUSY";
  constructor(message = "另一个 Host 正在使用这个数据目录") {
    super(message);
    this.name = "PairingBusyError";
  }
}

interface DeviceRecord {
  id: string;
  name: string;
  platform: PairDevicePlatform;
  /** sha256(token) 的 64 位 hex —— 明文 token 不落盘 */
  tokenHash: string;
  createdAt: number;
  lastSeenAt: number;
}

interface PairingFile {
  version: 1;
  devices: DeviceRecord[];
}

interface PendingCode {
  /** sha256(code) 的 32 字节，不存明文 */
  hash: Buffer;
  expiresAt: number;
  attempts: number;
}

export interface PairingServiceOptions {
  /** 设备表文件（`hostStateDir(dataHome)/pairing.json`） */
  filePath: string;
  /** 多进程锁；缺省 `<filePath>.lock` */
  lockPath?: string;
  /** 注入时钟（判据用；缺省 Date.now） */
  now?: () => number;
  ttlMs?: number;
  maxDevices?: number;
  maxAttemptsPerCode?: number;
  rateWindowMs?: number;
  maxAttemptsPerWindow?: number;
}

export interface PairStartResult {
  code: string;
  expiresAt: number;
  ttlMs: number;
}

export interface PairClaimResult {
  device: PairDeviceView;
  /** 唯一一次出现明文 token 的地方；调用方**不得**记日志，只允许写进 Set-Cookie */
  token: string;
}

const PLATFORMS: readonly PairDevicePlatform[] = ["android", "ios", "web", "desktop", "unknown"];
const DEFAULT_DEVICE_NAME = "我的手机";
const MAX_DEVICE_NAME = 64;
const TOKEN_BYTES = 32;

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/** 归一化配对码：去掉空格/连字符；只接受 6 位 ASCII 数字。 */
export function normalizePairCode(raw: string): string | null {
  const compact = raw.replace(/[\s-]/g, "");
  return /^[0-9]{6}$/.test(compact) ? compact : null;
}

/** 设备名清洗：去控制字符、折叠空白、最长 64；空则默认值。 */
export function sanitizeDeviceName(raw: string | undefined): string {
  const cleaned = (raw ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_DEVICE_NAME)
    .trim();
  return cleaned || DEFAULT_DEVICE_NAME;
}

function isPlatform(value: unknown): value is PairDevicePlatform {
  return typeof value === "string" && (PLATFORMS as readonly string[]).includes(value);
}

function toView(device: DeviceRecord): PairDeviceView {
  return {
    id: device.id,
    name: device.name,
    platform: device.platform,
    createdAt: device.createdAt,
    lastSeenAt: device.lastSeenAt,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validStoredDevice(value: unknown): value is DeviceRecord {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    /^dev-[0-9a-f]{8}$/.test(value.id) &&
    typeof value.name === "string" &&
    value.name.length > 0 &&
    value.name.length <= MAX_DEVICE_NAME &&
    isPlatform(value.platform) &&
    typeof value.tokenHash === "string" &&
    /^[0-9a-f]{64}$/.test(value.tokenHash) &&
    typeof value.createdAt === "number" &&
    Number.isFinite(value.createdAt) &&
    typeof value.lastSeenAt === "number" &&
    Number.isFinite(value.lastSeenAt)
  );
}

export class PairingService {
  private readonly filePath: string;
  private readonly lockPath: string;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxDevices: number;
  private readonly maxAttemptsPerCode: number;
  private readonly rateWindowMs: number;
  private readonly maxAttemptsPerWindow: number;

  private devices: DeviceRecord[] = [];
  private code: PendingCode | null = null;
  /** 窗口内的错误尝试时间戳（跨码） */
  private failures: number[] = [];
  private warning: string | undefined;
  private dirty = false;
  private closed = false;
  private lockOwned = false;
  /** 所有 mutation 串行化（与 runtime.eventChain 同一纪律） */
  private chain: Promise<unknown> = Promise.resolve();

  private constructor(opts: PairingServiceOptions) {
    this.filePath = opts.filePath;
    this.lockPath = opts.lockPath ?? `${opts.filePath}.lock`;
    this.now = opts.now ?? (() => Date.now());
    this.ttlMs = opts.ttlMs ?? PAIR_CODE_TTL_MS;
    this.maxDevices = opts.maxDevices ?? MAX_PAIRED_DEVICES;
    this.maxAttemptsPerCode = opts.maxAttemptsPerCode ?? MAX_ATTEMPTS_PER_CODE;
    this.rateWindowMs = opts.rateWindowMs ?? RATE_WINDOW_MS;
    this.maxAttemptsPerWindow = opts.maxAttemptsPerWindow ?? MAX_ATTEMPTS_PER_WINDOW;
  }

  static async open(opts: PairingServiceOptions): Promise<PairingService> {
    const service = new PairingService(opts);
    await mkdir(dirname(service.filePath), { recursive: true });
    await service.acquireLock();
    try {
      await service.load();
    } catch (e) {
      // 打开失败不能把锁留在盘上（否则下一次启动会误报 BUSY）
      await service.releaseLock();
      throw e;
    }
    return service;
  }

  // ========== 配对码 ==========

  /** 生成新码：旧码立即失效；重置该码的尝试计数与限速窗口。 */
  newCode(): Promise<PairStartResult> {
    return this.serial(async () => {
      const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
      const expiresAt = this.now() + this.ttlMs;
      this.code = { hash: sha256(code), expiresAt, attempts: 0 };
      this.failures = [];
      return { code, expiresAt, ttlMs: this.ttlMs };
    });
  }

  /**
   * 兑换配对码。
   *
   * 顺序是安全相关的：**限速 → 码匹配 → 过期/锁定 → 设备上限 → 持久化 → 消费码**。
   * 正确码在限速/锁定期间也返回 `rate_limited` / `locked`，不泄露"这次猜对了"。
   */
  claim(rawCode: string, deviceName?: string, platform?: string): Promise<PairClaimResult> {
    return this.serial(async () => {
      const now = this.now();
      this.pruneFailures(now);

      if (this.failures.length >= this.maxAttemptsPerWindow) {
        throw this.rateLimited(now);
      }

      const normalized = normalizePairCode(rawCode);
      const pending = this.code;
      if (!normalized || !pending) {
        this.recordFailure(now);
        throw new PairingError("invalid");
      }
      if (now >= pending.expiresAt) {
        this.code = null;
        this.recordFailure(now);
        throw new PairingError("expired");
      }
      if (pending.attempts >= this.maxAttemptsPerCode) {
        this.recordFailure(now);
        throw new PairingError("locked");
      }
      if (!timingSafeEqual(sha256(normalized), pending.hash)) {
        pending.attempts += 1;
        this.recordFailure(now);
        throw new PairingError(pending.attempts >= this.maxAttemptsPerCode ? "locked" : "invalid");
      }

      if (this.devices.length >= this.maxDevices) {
        throw new PairingError("device_limit");
      }

      const token = randomBytes(TOKEN_BYTES).toString("hex");
      const device: DeviceRecord = {
        id: `dev-${randomBytes(4).toString("hex")}`,
        name: sanitizeDeviceName(deviceName),
        platform: isPlatform(platform) ? platform : "unknown",
        tokenHash: sha256(token).toString("hex"),
        createdAt: now,
        lastSeenAt: now,
      };
      const next = [...this.devices, device];
      // 先落盘：写失败时不能返回 token（否则重启后设备不存在）
      await this.persist(next);
      this.devices = next;
      this.code = null;
      this.failures = [];
      this.dirty = false;
      return { device: toView(device), token };
    });
  }

  // ========== 设备 ==========

  /** 认证设备 token；命中返回设备视图（不含 hash）。遍历全部设备、不提前退出。 */
  authenticate(token: string): PairDeviceView | null {
    if (!token || token.length > 256) return null;
    const presented = sha256(token);
    let matched: DeviceRecord | null = null;
    for (const device of this.devices) {
      let same = false;
      try {
        same = timingSafeEqual(presented, Buffer.from(device.tokenHash, "hex"));
      } catch {
        same = false;
      }
      // 不 break：比较次数必须与设备表长度无关（不泄露"命中了第几条"）
      if (same) matched = device;
    }
    if (!matched) return null;
    matched.lastSeenAt = this.now();
    this.dirty = true;
    return toView(matched);
  }

  list(): { devices: PairDeviceView[]; warning?: string } {
    return {
      devices: this.devices.map(toView),
      ...(this.warning ? { warning: this.warning } : {}),
    };
  }

  /** 撤销设备；先持久化成功再更新内存（失败时不能回复成功）。 */
  revoke(deviceId: string): Promise<boolean> {
    return this.serial(async () => {
      const next = this.devices.filter((d) => d.id !== deviceId);
      if (next.length === this.devices.length) return false;
      await this.persist(next);
      this.devices = next;
      this.dirty = false;
      return true;
    });
  }

  /** 关闭：把 lastSeenAt 的变化刷盘，并释放锁。 */
  close(): Promise<void> {
    return this.serial(async () => {
      if (this.closed) return;
      this.closed = true;
      try {
        if (this.dirty) {
          await this.persist(this.devices);
          this.dirty = false;
        }
      } finally {
        await this.releaseLock();
      }
    });
  }

  // ========== 内部 ==========

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private rateLimited(now: number): PairingError {
    const oldest = this.failures[0] ?? now;
    const retryAfterMs = Math.max(0, oldest + this.rateWindowMs - now);
    return new PairingError("rate_limited", retryAfterMs);
  }

  private pruneFailures(now: number): void {
    this.failures = this.failures.filter((at) => now - at < this.rateWindowMs);
  }

  private recordFailure(now: number): void {
    this.failures.push(now);
    this.pruneFailures(now);
  }

  private async load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === "ENOENT") {
        this.devices = [];
        return;
      }
      throw e;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.devices)) {
        throw new Error("凭据文件结构不认识");
      }
      const devices = parsed.devices.filter(validStoredDevice);
      this.devices = devices;
      if (devices.length !== parsed.devices.length) {
        this.warning = "凭据文件中有无法识别的设备记录，已忽略；相关设备需要重新配对";
      }
    } catch (e) {
      // 隔离而不是覆盖：用户/我们事后仍能看到坏文件长什么样
      const quarantine = `${this.filePath}.corrupt-${this.now()}`;
      try {
        await rename(this.filePath, quarantine);
        this.warning = `凭据文件损坏（${e instanceof Error ? e.message : String(e)}），已隔离为 ${quarantine}；所有设备需要重新配对`;
      } catch {
        this.warning = `凭据文件损坏且无法隔离（${e instanceof Error ? e.message : String(e)}）；所有设备需要重新配对`;
      }
      this.devices = [];
    }
  }

  private async persist(devices: DeviceRecord[]): Promise<void> {
    const payload: PairingFile = { version: 1, devices };
    const tmp = `${this.filePath}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
    try {
      // 同目录临时文件 + rename：不允许截断原文件（崩在中间会得到半份设备表）
      await writeFile(tmp, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
      await rename(tmp, this.filePath);
    } catch (e) {
      try {
        await unlink(tmp);
      } catch {
        /* 临时文件可能根本没建出来；原始写错误才是要报的那个 */
      }
      throw e;
    }
  }

  private async acquireLock(): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const handle = await openFile(this.lockPath, "wx");
        try {
          await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: this.now() }));
        } finally {
          await handle.close();
        }
        this.lockOwned = true;
        return;
      } catch (e) {
        if ((e as NodeJS.ErrnoException)?.code !== "EEXIST") throw e;
      }
      const holder = await this.readLockPid();
      if (holder !== null && hostAlive(holder)) {
        throw new PairingBusyError(`另一个 Host（pid ${holder}）正在使用这个数据目录`);
      }
      // 死 pid / 坏锁：回收后重试一次
      try {
        await unlink(this.lockPath);
      } catch {
        /* 另一个进程可能刚好也在回收；重试时以 EEXIST 分支再判断一次 */
      }
    }
    throw new PairingBusyError("配对锁被占用且无法回收");
  }

  private async readLockPid(): Promise<number | null> {
    let raw: string;
    try {
      raw = await readFile(this.lockPath, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return null;
      // 读不到不等于"没人持有"：宁可报忙，也不要删掉别人的锁
      throw new PairingBusyError(`无法读取配对锁：${e instanceof Error ? e.message : String(e)}`);
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isRecord(parsed) && typeof parsed.pid === "number" && Number.isInteger(parsed.pid) && parsed.pid > 0) {
        return parsed.pid;
      }
      return null;
    } catch {
      // 内容不是 JSON = 坏锁（写出到一半崩溃），按可回收处理
      return null;
    }
  }

  private async releaseLock(): Promise<void> {
    if (!this.lockOwned) return;
    this.lockOwned = false;
    let holder: number | null = null;
    try {
      holder = await this.readLockPid();
    } catch {
      // 读不到锁内容时我们仍然持有"创建者"身份：继续尝试删除，删不掉也不影响数据。
      holder = null;
    }
    if (holder !== null && holder !== process.pid) return;
    try {
      await unlink(this.lockPath);
    } catch {
      /* 已不存在 = 目标状态 */
    }
  }
}

function hostAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM = 进程存在但没有权限发信号（不是"死了"）
    return (e as NodeJS.ErrnoException)?.code === "EPERM";
  }
}
