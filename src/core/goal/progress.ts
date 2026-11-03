/**
 * 进展判定：**防「假忙」**（GOAL-7）。
 *
 * 阶段内允许重试/换实现路径，但「连续 N 次验收证据一模一样」说明它没在推进 ——
 * 那时继续重试只是烧 token。这里给出两个纯函数：
 *
 * - `acceptanceFingerprint`：把一次门禁的全部结果折成短指纹；两次相同 = 没有进展；
 * - `summarizeFailure`：把失败折成**具体**原因（喂回模型 / 给用户看）。
 *
 * 指纹刻意**不包含耗时**（`durationMs`）：否则同一失败每次都会被判成「有进展」，
 * 无进展熔断永远不触发。也不包含模型正文 —— 模型每次措辞不同，但验收结果相同，
 * 那仍然是没有进展。
 */

import type { AcceptanceResult } from "./types";

/** FNV-1a 32 位（同步、无依赖、跨环境一致；只用于相等比较，不做安全用途） */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * 验收结果指纹。
 *
 * 参与：验收 id、是否通过、退出码、结果摘要（含输出尾部）。
 * 不参与：耗时、时间戳。
 */
export function acceptanceFingerprint(results: AcceptanceResult[]): string {
  const parts = results
    .map((r) => `${r.acceptance.id}|${r.passed ? 1 : 0}|${r.exitCode ?? "-"}|${r.summary}`)
    .sort();
  return `${results.length}:${fnv1a(parts.join("\n"))}`;
}

/** 失败原因（有界；给模型/用户看的时候必须能指出「哪条没过、为什么」） */
export function summarizeFailure(results: AcceptanceResult[], maxLen = 1200): string {
  const failed = results.filter((r) => !r.passed);
  if (failed.length === 0) return "";
  const text = failed
    .map((r) => {
      const exit = r.exitCode !== undefined ? `（退出码 ${r.exitCode}）` : "";
      return `- ${r.acceptance.description}${exit}：${r.summary}`;
    })
    .join("\n");
  return text.length > maxLen ? `${text.slice(0, maxLen)}…` : text;
}

/** 阶段是否真的做完了：全部验收通过（空验收=没做完，不是「默认通过」） */
export function allAcceptancePassed(results: AcceptanceResult[]): boolean {
  return results.length > 0 && results.every((r) => r.passed);
}
