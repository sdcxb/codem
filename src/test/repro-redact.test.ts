/**
 * 回归测试：API 错误消息密钥脱敏（对标 dsh mask-secrets）
 *
 * 背景：provider 的 API 错误把 response.text()（服务器错误体）直接拼进
 * Error。若错误体回显 Authorization/密钥（某些代理/网关行为），会泄漏到
 * UI / 日志 / LLM 上下文。
 */
import { describe, it, expect } from "vitest";
import { redactSecrets, redactSecretsDeep } from "../core/utils/redact";

describe("provider API 错误脱敏", () => {
  it("RED-001: sk- API key 被脱敏", () => {
    const err = 'API error 401: {"message":"invalid key sk-abc123def456ghi789jklmno123456"}';
    const safe = redactSecrets(err);
    expect(safe).not.toContain("sk-abc123def456ghi789jklmno123456");
    expect(safe).toContain("[REDACTED_API_KEY]");
  });

  it("RED-002: Bearer token 被脱敏", () => {
    const err = 'API error 403: {"error":"bad Bearer abcdefghijklmnopqrstuvwxyz1234567890"}';
    const safe = redactSecrets(err);
    expect(safe).not.toContain("abcdefghijklmnopqrstuvwxyz1234567890");
    expect(safe).toContain("[REDACTED_TOKEN]");
  });

  it("RED-003: 普通错误消息不受影响", () => {
    const err = 'API error 400: {"message":"The reasoning_content must be passed back"}';
    const safe = redactSecrets(err);
    expect(safe).toContain("reasoning_content must be passed back");
  });

  it("RED-004: password= 赋值被脱敏", () => {
    const err = "connect failed: password=superSecretPw123!@#";
    const safe = redactSecrets(err);
    expect(safe).not.toContain("superSecretPw123!@#");
    expect(safe).toContain("[REDACTED_PASSWORD]");
  });

  it("RED-005: redactSecretsDeep 递归处理对象", () => {
    const obj = { headers: { Authorization: "Bearer abcdefghijklmnopqrstuvwxyz123456" }, body: { a: 1 } };
    const safe = redactSecretsDeep(obj);
    expect(JSON.stringify(safe)).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
    expect(JSON.stringify(safe)).toContain("[REDACTED_TOKEN]");
  });
});
