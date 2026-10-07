/**
 * 重试分诊：**容量/过载与瞬态传输错误必须被认出来**（第 181 波，对标 Pi `3874b3e98` / `5b6c792b4`）。
 *
 * ## 缺陷形态（Pi 1.0.4 明确修过的两条同类）
 *
 * 修复前 `classifyError` **只看 HTTP 状态码**（429 / 5xx / 529）与少数 `code` / `name`。
 * 可供应商经常用 200 或 400 带回一句"模型忙"，或者在连接层抛一个纯文案的传输错误：
 *
 * - `Selected model is at capacity` —— Pi 的 issue #10278，当时 turn 直接以 error 收尾；
 * - `The pending stream has been canceled`（Node `ERR_HTTP2_STREAM_CANCEL`）—— Pi 的 #10379。
 *
 * 结果：**一次本可自愈的抖动，被当成确定性失败**，整段对话就此结束（对用户就是"突然报错，
 * 重发一次又好了"）。
 *
 * ## 判据（行为，不看源码文本）
 *
 * | # | 输入 | 判据 |
 * | --- | --- | --- |
 * | RTC-1 | `new Error("Selected model is at capacity")` | 可重试 + 类型是容量类 |
 * | RTC-2 | HTTP/2 在请求发出前连接没了（`ERR_HTTP2_STREAM_CANCEL` / 文案） | 可重试 |
 * | RTC-3 | **反向对照**：确定性错误（模型名不支持 / 上下文超限 / 401） | **不可重试** |
 * | RTC-4 | **反向对照**：不可重试优先 —— 模型名里恰好带 `overloaded` | **不可重试**（不许被文案表误捞） |
 * | RTC-5 | 既有语义不许变：429 / 500 / 529 仍可重试，4xx 仍不可 | 逐条 |
 * | RTC-6 | 既有的网络/超时码仍可重试 | 逐条 |
 */
import { describe, it, expect } from "vitest";
import { classifyError } from "../core/retry/retry";

function err(props: Record<string, unknown>): Error {
  return Object.assign(new Error(String(props.message ?? "")), props);
}

describe("重试分诊（第 181 波）", () => {
  it("RTC-1: 供应商的容量类文案必须可重试（修复前是 fail-fast）", () => {
    for (const message of [
      "Selected model is at capacity",
      "The model is at capacity, please retry",
      "Server is overloaded",
      "We are currently experiencing high demand",
      "Service temporarily unavailable",
    ]) {
      const r = classifyError(new Error(message));
      expect(r.isRetryable, `「${message}」应当可重试`).toBe(true);
      expect(r.type, `「${message}」应当归到容量类`).toBe("capacity");
    }
  });

  it("RTC-2: HTTP/2 请求发出前连接没了 —— 也应当可重试", () => {
    const byMessage = classifyError(new Error("The pending stream has been canceled (caused by: socket closed)"));
    expect(byMessage.isRetryable, "pending stream 文案应当可重试").toBe(true);

    const byCode = classifyError(err({ message: "socket hang up", code: "ERR_HTTP2_STREAM_CANCEL" }));
    expect(byCode.isRetryable, "ERR_HTTP2_STREAM_CANCEL 应当可重试").toBe(true);
  });

  it("RTC-3 反向对照：确定性错误不许被文案表捞成可重试", () => {
    for (const message of [
      "Unsupported model: gpt-9",
      "invalid_api_key",
      "Model not found",
      "Insufficient quota",
      "401 Unauthorized",
      "This model's maximum context length is 1048576 tokens",
      "max_tokens is too large",
    ]) {
      const r = classifyError(new Error(message));
      expect(r.isRetryable, `「${message}」不该被重试`).toBe(false);
    }
  });

  it("RTC-4 反向对照：「不可重试」优先于「可重试」文案（防同名巧合）", () => {
    // 模型名里恰好带了 overloaded 字样 —— 这是配置错误，不是容量问题
    const r = classifyError(new Error("Unsupported model: overloaded-v2-preview"));
    expect(r.isRetryable, "确定性错误优先：不许因为文案里出现过 overloaded 就重试").toBe(false);
  });

  it("RTC-5 既有语义不许变：状态码分诊照旧", () => {
    expect(classifyError(err({ message: "rate limited", status: 429 })).isRetryable).toBe(true);
    expect(classifyError(err({ message: "boom", status: 500 })).isRetryable).toBe(true);
    expect(classifyError(err({ message: "overloaded", status: 529 })).type).toBe("capacity");
    expect(classifyError(err({ message: "bad request", status: 400 })).isRetryable).toBe(false);
    expect(classifyError(err({ message: "not found", status: 404 })).isRetryable).toBe(false);
  });

  it("RTC-6 既有语义不许变：网络与超时仍可重试，未知错误仍不可", () => {
    expect(classifyError(err({ message: "reset", code: "ECONNRESET" })).isRetryable).toBe(true);
    expect(classifyError(err({ message: "nope", code: "ETIMEDOUT" })).isRetryable).toBe(true);
    expect(classifyError(new Error("SSE read timed out")).type).toBe("sse_timeout");
    expect(classifyError(new Error("something totally unexpected")).isRetryable).toBe(false);
    expect(classifyError(null).isRetryable).toBe(false);
  });
});
