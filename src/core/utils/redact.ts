/**
 * Secret redaction — shared across memory, recovery, logs and diagnostics.
 *
 * 对标 dsh-desktop `mask-secrets`：把密钥脱敏做成统一出口，而不是各调用点
 * 各自掩码。防止 API key / token / 密码 / 私钥泄漏进记忆、恢复数据、日志
 * 或错误详情。
 */

/** Patterns for sensitive data that should be redacted */
const SECRET_REDACT_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  // API keys: sk-..., pk-..., key-...
  { pattern: /(?:sk|pk|key|api[_-]?key)[-_]?[a-zA-Z0-9]{20,}/gi, replacement: "[REDACTED_API_KEY]" },
  // Bearer tokens
  { pattern: /Bearer\s+[a-zA-Z0-9._\-]{20,}/gi, replacement: "[REDACTED_TOKEN]" },
  // Password assignments: password=xxx, password: xxx
  { pattern: /(?:password|passwd|pwd)\s*[:=]\s*\S+/gi, replacement: "[REDACTED_PASSWORD]" },
  // Secret/token assignments
  { pattern: /(?:secret|token|access[_-]?key)\s*[:=]\s*\S+/gi, replacement: "[REDACTED_SECRET]" },
  // Private keys
  { pattern: /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----[\s\S]*?-----END\s+(?:RSA\s+)?PRIVATE\s+KEY-----/gi, replacement: "[REDACTED_PRIVATE_KEY]" },
  // AWS-style keys (AKIA...)
  { pattern: /AKIA[0-9A-Z]{16}/g, replacement: "[REDACTED_AWS_KEY]" },
  // GitHub tokens (ghp_..., gho_..., ghs_...)
  { pattern: /gh[opusr]_[A-Za-z0-9]{36,}/g, replacement: "[REDACTED_GITHUB_TOKEN]" },
];

/**
 * Redact sensitive data from text.
 * Replaces API keys, passwords, tokens, and private keys with placeholders.
 */
export function redactSecrets(text: string): string {
  if (!text) return text;
  let result = text;
  for (const { pattern, replacement } of SECRET_REDACT_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

/**
 * Redact sensitive values inside a JSON-serializable structure (deep walk).
 * Used before persisting recovery data / postmortem payloads that may embed
 * tool args or error details.
 */
export function redactSecretsDeep(value: unknown): unknown {
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map((v) => redactSecretsDeep(v));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactSecretsDeep(v);
    }
    return out;
  }
  return value;
}
