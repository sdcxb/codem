/**
 * `codem-db serve` 的客户端 —— **一行一条 JSON**（NDJSON），单进程单连接。
 *
 * 为什么不是"每次调用起一个 CLI 进程"：那会把单写者降级成多连接抢锁，
 * 并把每次调用的打开成本压到流式热路径上（见 `codem-db/src/serve.rs` 模块头）。
 *
 * 可靠性要点（每一条都对应一种真实故障）：
 * - **在途请求必须有超时**：引擎卡在 `busy_timeout` 时，不设超时的调用会永久挂起；
 * - **进程死了要立刻失败所有在途请求**：否则调用方永远等一个不会来的应答；
 * - **stderr 只留最后若干行做诊断**：它是 Rust 侧 trace 的出口，不能当协议通道；
 * - **close 先礼后兵**：先发 `shutdown`，超时才 kill，避免把 WAL 写坏的窗口放大。
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

import type { JsonRpcId } from "../../../protocol/src/index";
import { HostError, dbErrorToHostError } from "../errors";
import { withoutLlmEnv } from "../llm-config";

export interface DbReply<T = unknown> {
  id: JsonRpcId;
  ok: boolean;
  result?: T;
  error?: { code: string; message: string; retryable: boolean; hint?: string };
  engine?: string;
}

export interface ServeClientOptions {
  /** `codem-db-cli` 路径 */
  bin: string;
  /** 库文件路径 */
  dbPath: string;
  /** 单次调用超时（默认 30s：含 VACUUM/rebuild 这类慢命令的历史读数） */
  timeoutMs?: number;
  /** 额外环境变量（测试用） */
  env?: NodeJS.ProcessEnv;
  /** 诊断钩子（默认丢弃） */
  onStderr?: (line: string) => void;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const STDERR_KEEP_LINES = 20;

export class ServeClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (v: DbReply) => void; reject: (e: unknown) => void; timer: NodeJS.Timeout }
  >();
  private readonly stderrTail: string[] = [];
  private closed = false;
  private exitError: HostError | null = null;

  constructor(private readonly opts: ServeClientOptions) {}

  get pid(): number | undefined {
    return this.child?.pid;
  }

  /** 最近若干行 stderr（诊断用；不要用它做控制流） */
  diagnostics(): string[] {
    return [...this.stderrTail];
  }

  start(): void {
    if (this.child) return;
    const timeoutMs = this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    void timeoutMs;
    const child = spawn(this.opts.bin, ["--db", this.opts.dbPath, "serve"], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      // 纵深防御：索引进程不需要模型凭据，也不该能把它从 `/proc/<pid>/environ` 里读出来
      env: withoutLlmEnv({ ...process.env, ...(this.opts.env ?? {}) }),
    }) as ChildProcessWithoutNullStreams;
    this.child = child;

    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on("line", (line) => this.onLine(line));
    child.stderr.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split(/\r?\n/)) {
        if (!line.trim()) continue;
        this.stderrTail.push(line);
        if (this.stderrTail.length > STDERR_KEEP_LINES) this.stderrTail.shift();
        this.opts.onStderr?.(line);
      }
    });
    child.on("error", (e) => this.failAll(new HostError("INTERNAL", `codem-db 启动失败：${e.message}`, { cause: e })));
    child.on("exit", (code, signal) => {
      const err = new HostError(
        "BUSY",
        `codem-db serve 已退出（code=${String(code)} signal=${String(signal)}）` +
          (this.stderrTail.length ? `：${this.stderrTail[this.stderrTail.length - 1]}` : ""),
        { retryable: true, hint: "索引进程意外退出：Host 会重建连接；若反复出现请检查磁盘与库文件" },
      );
      this.failAll(err);
    });
  }

  private onLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let reply: DbReply;
    try {
      reply = JSON.parse(trimmed) as DbReply;
    } catch {
      // 非 JSON 的 stdout 只可能是引擎的调试输出（协议要求 stdout 只有 JSON）——
      // 不把它当协议错误，但要留痕（否则"应答丢了"无法定位）。
      this.stderrTail.push(`[non-json stdout] ${trimmed.slice(0, 200)}`);
      return;
    }
    const id = typeof reply.id === "number" ? reply.id : Number.NaN;
    const waiter = Number.isFinite(id) ? this.pending.get(id) : undefined;
    if (!waiter) {
      // 迟到的应答（已超时）不致命：丢弃即可，但不能当成"成功"。
      return;
    }
    this.pending.delete(id);
    clearTimeout(waiter.timer);
    waiter.resolve(reply);
  }

  private failAll(err: HostError): void {
    if (this.exitError === null) this.exitError = err;
    for (const [id, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      waiter.reject(err);
      this.pending.delete(id);
    }
  }

  private send(payload: Record<string, unknown>, timeoutMs: number): Promise<DbReply> {
    if (this.closed) {
      return Promise.reject(new HostError("BUSY", "codem-db 连接已关闭", { retryable: true }));
    }
    if (!this.child) this.start();
    if (this.exitError) return Promise.reject(this.exitError);
    const child = this.child;
    if (!child || !child.stdin.writable) {
      return Promise.reject(new HostError("BUSY", "codem-db stdin 不可写", { retryable: true }));
    }
    const id = this.nextId++;
    const line = `${JSON.stringify({ id, ...payload })}\n`;
    return new Promise<DbReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new HostError("BUSY", `存储命令超时（${timeoutMs}ms）：${String(payload.command ?? payload.op)}`, {
            retryable: true,
            hint: "库可能被其它进程锁住；Host 会重试一次",
          }),
        );
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(line, (e) => {
        if (!e) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new HostError("BUSY", `写入 codem-db 失败：${e.message}`, { retryable: true, cause: e }));
      });
    });
  }

  /** 仓储命令：返回**原始信封**（`{ok,result,error}`），由调用方决定是否解包。 */
  async invoke<T = unknown>(
    command: string,
    params: Record<string, unknown> = {},
    timeoutMs = this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  ): Promise<DbReply<T>> {
    return (await this.send({ command, params }, timeoutMs)) as DbReply<T>;
  }

  /** 批量写：与 Tauri 的 `storage_batch` 同语义（顺序、每步独立事务、失败即停）。 */
  async batch(commands: Array<{ command: string; params?: Record<string, unknown> }>): Promise<DbReply> {
    return this.send({ op: "batch", commands }, Math.max(this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, 60_000));
  }

  async op<T = unknown>(op: "health" | "capabilities" | "ping"): Promise<DbReply<T>> {
    return (await this.send({ op }, this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)) as DbReply<T>;
  }

  /** 解包：失败抛 HostError（kind 由数据库错误码翻译而来）。 */
  async must<T = unknown>(command: string, params: Record<string, unknown> = {}): Promise<T> {
    const reply = await this.invoke<T>(command, params);
    if (!reply.ok) throw dbErrorToHostError(reply);
    return reply.result as T;
  }

  async close(graceMs = 2000): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const child = this.child;
    if (!child) return;
    try {
      await Promise.race([
        this.send({ op: "shutdown" }, graceMs).catch(() => undefined),
        new Promise((r) => setTimeout(r, graceMs)),
      ]);
    } finally {
      if (!child.killed) {
        try {
          child.kill();
        } catch {
          /* 已经退出 */
        }
      }
      this.child = null;
    }
  }
}
