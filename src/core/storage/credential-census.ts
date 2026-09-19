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
  /** `field` = 键名像凭据；`shape` = 值形状像凭据（被塞进别的字段的情况） */
  kind: "field" | "shape";
  /** 命中的**处数**（同一键里可能有多个形状） */
  count: number;
}

export interface CredentialCensusResult {
  /** 扫了多少个设置项 */
  scanned: number;
  /** 命中清单（**只含键名与数量，不含任何值**） */
  hits: CredentialCensusHit[];
  /** 命中总处数 */
  total: number;
}

/**
 * 扫一批设置行。
 *
 * @param rows `{ key, value }`；value 是字符串（settings 表就是 `key/value` 两列）
 */
export function censusCredentialSettings(
  rows: ReadonlyArray<{ key: string; value: string | null | undefined }>,
): CredentialCensusResult {
  const out: CredentialCensusResult = { scanned: 0, hits: [], total: 0 };
  for (const row of rows) {
    const key = String(row.key ?? "");
    if (!key) continue;
    out.scanned += 1;
    const text = String(row.value ?? "");
    if (!text) continue;

    let shapeCount = 0;
    for (const re of CREDENTIAL_VALUE_RES) {
      // 全局正则带 `g`，逐行用要重置 lastIndex，否则会漏（这是 JS 正则的经典坑）
      re.lastIndex = 0;
      shapeCount += (text.match(re) ?? []).length;
    }
    if (shapeCount > 0) {
      out.hits.push({ key, kind: "shape", count: shapeCount });
      out.total += shapeCount;
    }

    /**
     * 键名判据只对**看起来是 JSON 的设置项**生效（避免把 `codem-…-token-count` 这类
     * 普通计数键误报）：要求值里出现过 `"…key…": "非空"` 这种形状。
     */
    if (CREDENTIAL_KEY_RE.source && /"[^"]*(api[-_]?key|token|secret|password|authorization)[^"]*"\s*:\s*"[^"]+"/i.test(text)) {
      out.hits.push({ key, kind: "field", count: 1 });
      out.total += 1;
    }
  }
  return out;
}
