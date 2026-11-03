/**
 * 远端改「模型」与「权限档」（阶段 4 / 阶段 R5 修正）。
 *
 * ## ⚠️ 阶段 R5 的策略修正：**去掉了"只能收紧"**
 *
 * 阶段 4 我们定过一条规则：**远端只能收紧权限档、不能放宽**，理由是
 * "已认证不等于可以取消对自己的监督"。
 *
 * 但用户的口径是**完全按 DSH 的模式走**（不做并行机制、不为这些机制做决策），
 * 而 DSH 的 `session.selections.update` **允许远端改权限档**。
 * 所以这条限制被去掉了，**与 DSH 一致**。
 *
 * ## 去掉之后会发生什么（必须写清楚，不能埋在代码里）
 *
 * 拿到手机的人可以把权限档改成「自动放行一切」（`full`），
 * 从此**所有需要批准的操作都不再需要批准** ——
 * 阶段 0 建的那整套远端审批因此**在那之后形同虚设**。
 *
 * 这是**有意的取舍**，不是疏漏：
 * - 它是 DSH 的行为（同一条路径、同一套语义）；
 * - 而"两台设备属于同一个人"这个前提在两边是一样的。
 *
 * 仍**保留**的约束（这些不是策略，是正确性）：
 * - 档位必须是**目录里存在**的（不认识的值一律拒绝，不猜）；
 * - 远端送来的 `dsh:permission:` id 必须能**规范解码**
 *   （顺带挡住 `custom`/空白/CRLF —— 那是它在 `selections.ts:38` 的规则）。
 */

/** 权限档的严格程度：数字越小越严格。（现在只用于**展示**，不再用于拦截） */
export const SECURITY_ORDER: Record<string, number> = {
  ask: 0,
  auto: 1,
  full: 2,
};

/**
 * 这次改动是在**放宽**权限吗？
 *
 * ⚠️ 它**不再**用于拦截（阶段 R5 去掉了方向限制）。保留它的唯一用途是
 * 让界面能给出提示（"你现在允许所有操作自动通过"）——
 * **告知**与**拦截**是两件事。
 */
export function isLoosening(current: string, next: string): boolean {
  const a = SECURITY_ORDER[current];
  const b = SECURITY_ORDER[next];
  // 未知档位一律当成"不能判断" ⇒ 按放宽处理（用于提示时宁可多提示一次）
  if (a === undefined || b === undefined) return true;
  return b > a;
}

export type SecurityChangeVerdict =
  | { ok: true; kind: "tighten" | "same" | "loosen" }
  | { ok: false; code: "permission_not_in_catalog"; message: string };

/**
 * 远端能否把权限档改成 `next`。
 *
 * **只校验"这个档位存在吗"—— 不再限制方向**（见文件头）。
 * 已知档位一律放行；不认识的一律拒绝（fail-closed：宁可拒一次，
 * 也不放行一个我们看不懂的档位）。
 */
export function verdictForRemoteSecurityChange(
  current: string,
  next: string,
): SecurityChangeVerdict {
  if (SECURITY_ORDER[next] === undefined) {
    return {
      ok: false,
      code: "permission_not_in_catalog",
      message: `不认识的权限档：${next}。可用的是 ask / auto / full。`,
    };
  }
  if (next === current) return { ok: true, kind: "same" };
  return { ok: true, kind: isLoosening(current, next) ? "loosen" : "tighten" };
}