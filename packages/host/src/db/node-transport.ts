/**
 * `StorageTransport` 的 Node 实现 —— 让**渲染侧那整套存储层**（`rust-port.ts` 3416 行、
 * 消息/会话/事件/镜像/重试全在里面）在 Host 里原样跑起来。
 *
 * ## 这是 Host 抽取里最便宜的一刀，也是最重要的
 *
 * `rust-port.ts` 早就把"传输"抽成了 `StorageTransport`（默认 `tauriTransport`），
 * 所以换宿主**不需要重写存储层**：只要提供一份返回**同样信封**的实现。
 * 信封形状（`{ok,result,error:{code,message,retryable,hint},engine}`）由
 * `codem-db serve` 与 Tauri 命令层共同保证，判据见
 * `src-tauri/codem-db/tests/serve_contract.rs` 与 `src/test/host-wire-parity.test.ts`。
 *
 * ## 为什么这里不做重试/退避
 *
 * 重试已经在 `rust-port.ts` 的 `callWithRetry` / 镜像层里做了（按错误码 + `retryable`）。
 * 传输层再叠一层重试，会让"一次失败"变成 N 次（且两层的退避策略互相不可见 ——
 * 真机上表现为"卡住十几秒才报错"）。传输层只负责**如实失败**。
 */

import type { StorageTransport } from "../../../../src/core/storage/rust-port";
import type { ServeClient } from "./serve-client";

export class NodeTransport implements StorageTransport {
  constructor(
    private readonly client: ServeClient,
    private readonly dbPath: string,
  ) {}

  async invokeCommand<T>(command: string, params?: Record<string, unknown>): Promise<T> {
    return (await this.client.invoke(command, params ?? {})) as unknown as T;
  }

  async invokeBatch<T>(commands: Array<{ command: string; params?: Record<string, unknown> }>): Promise<T> {
    return (await this.client.batch(commands)) as unknown as T;
  }

  async health<T>(): Promise<T> {
    const reply = await this.client.op("health");
    if (!reply.ok) {
      return {
        ok: false,
        error: reply.error,
        engine: "rust",
      } as unknown as T;
    }
    const health = (reply.result ?? {}) as Record<string, unknown>;
    return {
      ok: true,
      engine: "rust",
      result: {
        ...health,
        db_path: this.dbPath,
        // Host 的库路径是**显式配置**决定的（不是 dirs::data_dir 猜的），
        // 所以"标准位置"这一位按 true 报；真实来源在 HostConfig 里可查。
        db_path_standard: true,
      },
    } as unknown as T;
  }

  async integrityCheck<T>(): Promise<T> {
    const reply = await this.client.invoke("integrity_check", {});
    if (!reply.ok) return { ok: false, error: reply.error, engine: "rust" } as unknown as T;
    return { ok: true, engine: "rust", result: reply.result } as unknown as T;
  }

  async checkpoint<T>(): Promise<T> {
    const reply = await this.client.invoke("checkpoint", {});
    if (!reply.ok) return { ok: false, error: reply.error, engine: "rust" } as unknown as T;
    return { ok: true, engine: "rust", result: reply.result ?? { ok: true } } as unknown as T;
  }

  async capabilities<T>(): Promise<T> {
    const reply = await this.client.op("capabilities");
    if (!reply.ok) return { ok: false, error: reply.error, engine: "rust" } as unknown as T;
    return { ok: true, engine: "rust", result: reply.result } as unknown as T;
  }
}
