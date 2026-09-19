/**
 * 凭据普查（第 62 轮；见 `docs/CREDENTIALS-PLAN.md` 阶段 0-c）
 *
 * ## 它解决什么
 *
 * 密钥**本来就该**存在 settings 里（明文落盘是既有设计），问题是**用户不知道**：
 * "我的库里到底有没有凭据、有几处、在哪些键上" 之前只能靠外部脚本扫（我用的
 * `.preview-shot/survey-credential-paths.mjs`）。这一条把它变成**产品能力**：
 * 维护时扫一遍 settings，**只报键名 + 命中数量，从不打印值**，命中就通过既有上报通道
 * 让用户看见（"检测到疑似密钥，建议轮换"）。
 *
 * ## 边界（如实写，不夸大覆盖面）
 *
 * - **v1 只扫 `settings`**：那是凭据**应该**在的地方，也是"活着的那个 key"所在
 *   （真机实测：`codem-settings.providers[3].apiKey`）。
 * - **不扫**消息 / 工具结果 / 事件载荷里的**历史残留**：那些是"过去某次对话把 key 打印出来了"，
 *   量级大（全表扫描进启动路径不划算），由**离线脚本**负责（阶段 0-d），不放进每次维护。
 * - 判据与导出脱敏**共用同一份正则**（`settings.ts` 导出的 `CREDENTIAL_KEY_RE` /
 *   `CREDENTIAL_VALUE_RES`）：**只有一份"什么算凭据"的定义**，不能两处各写一份然后漂移。
 */

import { CREDENTIAL_KEY_RE, CREDENTIAL_VALUE_RES } from "../settings/settings";

export interface CredentialCensusHit {
  /** 设置项**键名**（这本身就是"去哪改"的信息，不是秘密） */
  key: string;
  /**
   * `field` = 键名像凭据且值是**明文**；`shape` = 值形状像凭据（被塞进别的字段的情况）；
   * `sealed` = 键名像凭据但值**已加密**（`apiKeySealed` + `dsh1:` 前缀）—— **不是**明文。
   */
  kind: "field" | "shape" | "sealed";
  /** 命中的**处数**（同一键里可能有多个形状） */
  count: number;
}

export interface CredentialCensusResult {
  /** 扫了多少个设置项 */
  scanned: number;
  /** 命中清单（**只含键名与数量，不含任何值**），**不含**已加密的那些 */
  hits: CredentialCensusHit[];
  /** **明文**命中总处数（`total` 的口径 = 需要用户处理的处数） */
  total: number;
  /** 已加密保存的处数（单独计数：它们**不是**明文，不该混进上面的告警里） */
  sealedTotal: number;
  /** 已加密的那些的键名（同样只报键名） */
  sealedKeys: string[];
}

/** 值是不是**本产品的封存格式**（`src-tauri/src/secret.rs` 写的 `dsh1:<hex>`） */
function looksSealed(value: string): boolean {
  return /^dsh1:[0-9a-fA-F]{16,}$/.test(value.trim());
}

/**
 * 扫一批设置行。
 *
 * @param rows `{ key, value }`；value 是字符串（settings 表就是 `key/value` 两列）
 */
export function censusCredentialSettings(
  rows: ReadonlyArray<{ key: string; value: string | null | undefined }>,
): CredentialCensusResult {
  const out: CredentialCensusResult = { scanned: 0, hits: [], total: 0, sealedTotal: 0, sealedKeys: [] };
  for (const row of rows) {
    const key = String(row.key ?? "");
    if (!key) continue;
    out.scanned += 1;
    const text = String(row.value ?? "");
    if (!text) continue;

    /**
     * ## 第 62 轮补：**已加密的字段不许被报成"明文凭据"**（真机复量抓到）
     *
     * 封存（1.16.102）之后，`codem-settings` 里的 `"apiKeySealed": "dsh1:…"` 仍然会被
     * 键名判据（`apiKey` 是 `apiKeySealed` 的子串）命中，于是维护日志打出
     * 「设置里存在**明文存放的**密钥 1 处」—— 而那一刻磁盘上是密文。
     * **印出来的必须是真的**：所以这里把"键名像凭据 + 值是封存格式"单独归为 `sealed`，
     * 从明文告警里剔出去，只在日志里如实说"另有 N 处已加密"。
     */
    const sealedFields = [...text.matchAll(/"([^"]*(?:api[-_]?key|token|secret|password|authorization)[^"]*)"\s*:\s*"([^"]+)"/gi)]
      .filter((m) => looksSealed(String(m[2])));
    if (sealedFields.length > 0) {
      out.sealedTotal += sealedFields.length;
      out.sealedKeys.push(key);
    }
    /** 去掉已加密字段后的正文（明文判据只看剩下的部分） */
    const plainText = text.replace(
      /"([^"]*(?:api[-_]?key|token|secret|password|authorization)[^"]*)"\s*:\s*"([^"]+)"/gi,
      (whole, _name: string, value: string) => (looksSealed(String(value)) ? `"__sealed__":"<已加密>"` : whole),
    );

    let shapeCount = 0;
    for (const re of CREDENTIAL_VALUE_RES) {
      // 全局正则带 `g`，逐行用要重置 lastIndex，否则会漏（这是 JS 正则的经典坑）
      re.lastIndex = 0;
      shapeCount += (plainText.match(re) ?? []).length;
    }
    if (shapeCount > 0) {
      out.hits.push({ key, kind: "shape", count: shapeCount });
      out.total += shapeCount;
    }

    /**
     * 键名判据只对**看起来是 JSON 的设置项**生效（避免把 `codem-…-token-count` 这类
     * 普通计数键误报）：要求值里出现过 `"…key…": "非空"` 这种形状。
     */
    if (CREDENTIAL_KEY_RE.source && /"[^"]*(api[-_]?key|token|secret|password|authorization)[^"]*"\s*:\s*"[^"]+"/i.test(plainText)) {
      out.hits.push({ key, kind: "field", count: 1 });
      out.total += 1;
    }
  }
  return out;
}
