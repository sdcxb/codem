/**
 * Host 侧的错误模型 —— 与协议里的 `HostErrorKind` 一一对应。
 *
 * 纪律（与 `codem-db` 的 `DbError` 同一条）：**错误是值**，带机器可读的 kind、
 * 是否可重试、以及一句给人看的下一步建议。调用方按 kind 分支，**不解析 message 文本**。
 */

import type { HostErrorData, HostErrorKind, RpcFailure, JsonRpcId } from "../../protocol/src/index";
import { ProtocolValidationError, RPC_ERROR_CODES } from "../../protocol/src/index";

export class HostError extends Error {
  readonly kind: HostErrorKind;
  readonly retryable: boolean;
  readonly hint: string | undefined;
  readonly details: unknown;

  constructor(
    kind: HostErrorKind,
    message: string,
    opts: { retryable?: boolean; hint?: string; details?: unknown; cause?: unknown } = {},
  ) {
    super(message);
    // `Error` 的 `cause` 选项要求 lib ES2022，而根 tsconfig 是 ES2021；
    // 这里手动挂上（等价语义，且不逼整个仓库升 lib）。
    if (opts.cause !== undefined) (this as { cause?: unknown }).cause = opts.cause;
    this.name = "HostError";
    this.kind = kind;
    this.retryable = opts.retryable ?? false;
    this.hint = opts.hint;
    this.details = opts.details;
  }

  static is(e: unknown): e is HostError {
    return e instanceof HostError;
  }

  toData(): HostErrorData {
    return {
      kind: this.kind,
      retryable: this.retryable,
      ...(this.hint ? { hint: this.hint } : {}),
      ...(this.details === undefined ? {} : { details: this.details }),
    };
  }
}

/** 把任意异常收敛成 HostError（不吞掉原始 message：那是唯一能定位问题的线索）。 */
export function toHostError(e: unknown): HostError {
  if (HostError.is(e)) return e;
  /**
   * 参数校验错误必须报 `INVALID_PARAMS`，不能落进 `INTERNAL`。
   *
   * 客户端按 kind 分支（`INVALID_PARAMS` = 我传错了，`INTERNAL` = Host 出错了）；
   * 把"少了 pairing code"报成 INTERNAL 会让手机端显示"Host 内部错误"，
   * 而真实原因只是请求形状不对。
   */
  if (e instanceof ProtocolValidationError) return new HostError("INVALID_PARAMS", e.message);
  if (e instanceof Error) {
    return new HostError("INTERNAL", e.message, { cause: e });
  }
  return new HostError("INTERNAL", String(e));
}

export function toRpcFailure(id: JsonRpcId | null, e: unknown): RpcFailure {
  const err = toHostError(e);
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: RPC_ERROR_CODES[err.kind] ?? RPC_ERROR_CODES.INTERNAL,
      message: err.message,
      data: err.toData(),
    },
  };
}

/**
 * `codem-db` 的错误码 → Host 的 kind。
 *
 * 为什么要在这一层翻译：数据库的 `BUSY/LOCKED` 对客户端意味着"稍后重试"，
 * 而 `UNSUPPORTED` 意味着"这个版本根本没这功能"（不该重试，该灰掉入口）。
 * 让手机 UI 去理解 `BUSY` 这种存储内部词汇，等于把索引细节泄漏到产品语义层。
 */
export function kindFromDbCode(code: string): HostErrorKind {
  switch (code) {
    case "BUSY":
    case "LOCKED":
      return "BUSY";
    case "UNAVAILABLE":
      return "BUSY";
    case "NOT_FOUND":
      return "NOT_FOUND";
    case "CONSTRAINT":
      return "CONFLICT";
    case "UNSUPPORTED":
      return "UNSUPPORTED";
    default:
      return "INTERNAL";
  }
}

export function dbErrorToHostError(reply: {
  error?: { code?: string; message?: string; retryable?: boolean; hint?: string };
}): HostError {
  const code = reply.error?.code ?? "OTHER";
  return new HostError(kindFromDbCode(code), reply.error?.message ?? "存储命令失败", {
    retryable: reply.error?.retryable ?? false,
    hint: reply.error?.hint,
    details: { dbCode: code },
  });
}
