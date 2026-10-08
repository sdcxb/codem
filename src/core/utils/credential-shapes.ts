/**
 * **凭据「值形状」的唯一来源**（第 188 波 R5 收口）。
 *
 * ## 为什么要有这个文件
 *
 * 这个仓库里「什么算凭据」曾经有**四份**实现，而且它们**互相漂移**：
 *
 * | 出口 | 位置（收口前） | `sk-` 形状 | 后果 |
 * | --- | --- | --- | --- |
 * | 导出脱敏 / 凭据普查 | `core/settings/settings.ts` 的 `CREDENTIAL_VALUE_RES` | 正文**只允许字母数字**（窄口径） | 认不出 `sk-proj-…` / `sk-ant-api03-…` ⇒ **普查假阴性**（明文密钥就在设置里却不报） |
 * | 记忆/日志脱敏 | `core/utils/redact.ts` 的 `SECRET_REDACT_PATTERNS` | 强前缀 `sk-`/`pk-`（正确口径，第 188 波 R3 重建） | —— |
 * | 工具参数安全警告 | `core/llm/streaming-executor.ts` 的 `SENSITIVE_PATTERNS` | 正文只允许字母数字（窄口径） | 模型把 `sk-proj-…` 写进文件时**不警告** |
 * | 工具参数安全审计 | `core/llm/tool-pipeline.ts` 的 `SecurityScanMiddleware` | 同上 | 同上 |
 *
 * 四处各写一份的直接后果是**同一件事在两个方向上同时错**：该报的漏报（窄口径），
 * 不该动的误伤（无前边界、正文允许 `-`/`_` 的老口径）。所以这不是"再收窄/放宽一点"能解决的，
 * 而是**只保留一份定义**。判据 `src/test/credential-shape-single-source.test.ts` 的
 * `CS-ONE-SOURCE` 用 AST 扫描钉住：**生产代码里"定义 sk- 形状"的正则字面量只允许出现在本文件**。
 *
 * ## 两个出口的语义确实不同 —— 但形状必须是同一批
 *
 * - **改写**（脱敏：`redactSecrets` / `redactCredentialShapes`）：命中就把值换成占位符；
 * - **报告**（普查 `censusCredentialSettings`、工具参数扫描）：命中就报/就警告，**不改值**。
 *
 * 差的是**动作**，不是**形状**。所以这里把形状定义一次，两个出口各取所需：
 * `scope === "value"` 的是「值形状」（凭据长什么样，报告与改写都用）；
 * `scope === "context"` 的是「赋值/上下文形状」（`Bearer …`、`password=…`、私钥块）——
 * 它们需要上下文才成立，只用于改写（普查另有**键名**判据管这类字段，见 `credential-census.ts`）。
 *
 * ## 形状口径（第 188 波 R3 定稿，本文件是它的唯一落点）
 *
 * 强前缀（`sk` / `pk`）：判别力足够 ⇒ **一字不改地放行**——大小写不敏感、
 * 正文允许 `-`/`_`（`sk-proj-…`、`sk-ant-api03-…`、`sk-…_extra`），但**必有 ≥20 位字母数字**；
 * 前边界 = 前面既不是字母数字、也不是 `-`/`_`（`task-sk-…` 的 `-` 挡住、`risk-sk-…` 的 `k` 挡住）；
 * 后边界 = 只要求后面不是字母数字（**刻意不**排除 `-`/`_` —— 那正是 `sk-…-x` 被漏掉的原因）。
 *
 * 弱前缀（裸 `key-`）：判别力不足 —— `key-abcdefghij…` 与 `C:\work\key-…\src`、`feat/key-…`
 * **同形**，任何按形状的规则都分不开 ⇒ 裸 `key-` **一律不当令牌**；
 * 只保留**显式形态** `api_key`/`apikey`/`api-key`，且前面紧邻 `/` 或 `\` 时不算（路径段守卫）。
 */

/** 形状 id：各出口按 id 取用（**不许**在别处另写一条正则） */
export type CredentialShapeId =
  | "apiKeyStrong"
  | "apiKeyWeak"
  | "bearer"
  | "passwordAssign"
  | "secretAssign"
  | "privateKeyBlock"
  | "awsAccessKeyId"
  | "githubToken";

export interface CredentialShape {
  id: CredentialShapeId;
  /**
   * 诊断名（只进日志/判据，**不含任何值**）。
   * 为什么必须按形状分别命名：真机误报时日志只印 `shape×9`，无法判断"是哪条正则打中的"。
   */
  label: string;
  /** 命中后用于**改写**的占位符（报告型出口只记 `label`，不用这一项） */
  replacement: string;
  /**
   * `value` = 凭据的**值形状**（报告与改写两个出口都用它）；
   * `context` = **赋值/上下文形状**（只有上下文里才成立，只用于改写）。
   */
  scope: "value" | "context";
  pattern: RegExp;
}

/**
 * 形状表 —— **唯一**的定义处。
 *
 * ⚠️ **顺序有意义**：`redactSecrets` 按本数组顺序逐条改写，顺序变动会改变重叠命中的改写结果。
 * 所以新增形状请**追加**，不要插入。
 */
export const CREDENTIAL_SHAPES: readonly CredentialShape[] = [
  {
    id: "apiKeyStrong",
    label: "sk-/pk-",
    replacement: "[REDACTED_API_KEY]",
    scope: "value",
    // 强前缀：不区分大小写 + 正文允许 -/_ + 前边界排除字母数字与 -/_ + 后边界只要不是字母数字
    pattern: /(?<![A-Za-z0-9_-])(?:sk|pk)[-_](?:[A-Za-z0-9][A-Za-z0-9_-]{19,}|[A-Za-z0-9]{20,})(?![A-Za-z0-9_-])/gi,
  },
  {
    id: "apiKeyWeak",
    label: "api_key",
    replacement: "[REDACTED_API_KEY]",
    scope: "value",
    /*
     * 弱前缀：只认**显式**的 `api_key`/`apikey`/`api-key`（分隔符可省），
     * 且前面**不能是路径分隔符**（`src/api_key-…` 是路径段，不是令牌）。
     *
     * 前边界为什么**不**排除 `_`/`-`：`OPENAI_API_KEY-…`/`Api_Key-…` 里 `api` 前面正好是 `_`
     * —— 排除掉就把这两种真实写法一起漏了（实测）。
     */
    pattern: /(?<![A-Za-z0-9\/\\])api[-_]?key[-_]?(?:[A-Za-z0-9][A-Za-z0-9_-]{19,}|[A-Za-z0-9]{20,})(?![A-Za-z0-9_-])/gi,
  },
  {
    id: "bearer",
    label: "Bearer",
    replacement: "[REDACTED_TOKEN]",
    scope: "context",
    pattern: /Bearer\s+[a-zA-Z0-9._\-]{20,}/gi,
  },
  {
    id: "passwordAssign",
    label: "password",
    replacement: "[REDACTED_PASSWORD]",
    scope: "context",
    pattern: /(?:password|passwd|pwd)\s*[:=]\s*\S+/gi,
  },
  {
    id: "secretAssign",
    label: "secret/token",
    replacement: "[REDACTED_SECRET]",
    scope: "context",
    pattern: /(?:secret|token|access[_-]?key)\s*[:=]\s*\S+/gi,
  },
  {
    id: "privateKeyBlock",
    label: "private-key",
    replacement: "[REDACTED_PRIVATE_KEY]",
    scope: "context",
    pattern: /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----[\s\S]*?-----END\s+(?:RSA\s+)?PRIVATE\s+KEY-----/gi,
  },
  {
    id: "awsAccessKeyId",
    label: "AKIA",
    replacement: "[REDACTED_AWS_KEY]",
    scope: "value",
    /** AWS 的 access key id **恰好**是 `AKIA` + 16 位大写/数字 ⇒ 两侧都要边界 */
    pattern: /(?<![A-Za-z0-9])AKIA[0-9A-Z]{16}(?![A-Za-z0-9])/g,
  },
  {
    id: "githubToken",
    label: "gh[opusr]_",
    replacement: "[REDACTED_GITHUB_TOKEN]",
    scope: "value",
    /**
     * GitHub 令牌：`gho_`（OAuth）/ `ghp_`（PAT）/ `ghs_`（server）/ `ghu_`（user）/ `ghr_`（refresh）。
     * 收口前这里也是**两份**：普查那份是 `gho_`/`ghp_` + `{16,}`，脱敏那份是 `gh[opusr]_` + `{36,}`。
     * 现在合成一条：前缀覆盖全部五种，长度取**更宽**的 `{16,}`（漏一个真令牌的代价不可逆），
     * 并补上两侧边界（`xgho_…` 不是独立令牌）。
     */
    pattern: /(?<![A-Za-z0-9])gh[opusr]_[A-Za-z0-9]{16,}(?![A-Za-z0-9])/g,
  },
];

/** 凭据的**值形状**（报告型出口与改写型出口都用这一批；顺序即 `CREDENTIAL_VALUE_RES` 的顺序） */
export const CREDENTIAL_VALUE_SHAPES: readonly CredentialShape[] = CREDENTIAL_SHAPES.filter(
  (s) => s.scope === "value",
);

/** 按 id 取一条形状（取不到就**抛**：手工改 id 应该立刻炸，而不是静默少检一条） */
export function credentialShape(id: CredentialShapeId): CredentialShape {
  const found = CREDENTIAL_SHAPES.find((s) => s.id === id);
  if (!found) throw new Error(`未知的凭据形状 id：${id}`);
  return found;
}

/**
 * 给**只会 `test()`** 的出口用的正则（去掉 `g`）。
 *
 * 为什么必须去掉 `g`：`RegExp.prototype.test` 在带 `g` 的正则上会读写 `lastIndex`
 * ⇒ 同一个正则对象被逐次调用时会**隔次返回 false**（经典陷阱，本仓在
 * `credential-census` 里也为 `match` 重置过 lastIndex）。扫描型出口（工具参数扫描）
 * 正是这种用法，所以这里给它一个**无状态**的副本。
 */
export function credentialShapeTestPattern(id: CredentialShapeId): RegExp {
  const { pattern } = credentialShape(id);
  return new RegExp(pattern.source, pattern.flags.replace("g", ""));
}
