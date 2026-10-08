/**
 * Secret redaction — shared across memory, recovery, logs and diagnostics.
 *
 * 对标 dsh-desktop `mask-secrets`：把密钥脱敏做成统一出口，而不是各调用点
 * 各自掩码。防止 API key / token / 密码 / 私钥泄漏进记忆、恢复数据、日志
 * 或错误详情。
 *
 * ## 形状定义在哪里（第 188 波 R5 收口）
 *
 * **不在本文件**。凭据"长什么样"只有一份定义：`core/utils/credential-shapes.ts`。
 * 本文件只负责脱敏这一侧的**动作**（按顺序把命中的值改写成占位符）。
 *
 * 收口前本文件自己写了一份 API key 形状，而凭据普查（`core/settings/settings.ts`
 * 的 `CREDENTIAL_VALUE_RES`）另写了一份更窄的、`streaming-executor.ts` 与
 * `tool-pipeline.ts` 又各写了一份 —— **四份实现互相漂移**：
 * 第 49 波只修了普查那份，第 188 波 R3 只修了本文件这份。
 * 判据 `src/test/credential-shape-single-source.test.ts` 的 `CS-ONE-SOURCE`
 * 用 AST 扫描钉住"生产代码里定义 `sk-` 形状的正则字面量只允许出现在共享来源里"。
 */
import { CREDENTIAL_SHAPES } from "./credential-shapes";

/**
 * 敏感数据的**改写**顺序表 —— 逐条来自 `credential-shapes.ts`（形状的唯一来源）。
 *
 * ## 为什么这里取的是**全部**形状（含 `scope: "context"`）
 *
 * 脱敏是"宁可多改一处占位符、不可漏一个真值"的方向 ⇒ 赋值/上下文形状（`Bearer …`、
 * `password=…`、私钥块）也要改写；而普查（报告型出口）只取 `scope === "value"` 的值形状
 * —— 它另有**键名**判据管这类字段（见 `credential-census.ts`）。
 *
 * ⚠️ **顺序有意义**（`String.replace` 逐条改写，重叠命中的结果与顺序有关）：顺序就是
 * `CREDENTIAL_SHAPES` 的声明顺序，新增形状请在那张表**末尾追加**。
 */
const SECRET_REDACT_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = CREDENTIAL_SHAPES.map(
  ({ pattern, replacement }) => ({ pattern, replacement }),
);

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
