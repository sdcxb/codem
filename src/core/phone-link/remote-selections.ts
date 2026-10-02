/**
 * 远端改「模型」与「权限档」（阶段 4.1 / 4.2）。
 *
 * ## 两者风险完全不同，所以规则也不同
 *
 * **模型是可以随便换的**：换模型只改变"谁来回答"，不改变"什么操作会被放行"。
 * 换错了最多是回答风格不对，用户可以再换回来。
 *
 * **权限档不能随便放宽** —— 这是这一节的核心判断：
 *
 * 我们在阶段 0 建了一整套远端审批，目的就是让"需要批准的工具"必须有人点同意。
 * 如果**远端自己**能把权限档改成 `full`（自动放行一切），那它就能**自己授权自己** ——
 * 整套审批形同虚设。这不是"多一个便利功能"，这是**拿掉了那道闸门**。
 *
 * 而 DSH 那边是允许远端改权限的（`session.updateSelections`）。**我们不照抄这一条**，
 * 理由是威胁模型不同：它把"设备已认证"当作充分条件，我们认为
 * **"已认证"不等于"可以取消对自己的监督"**。
 *
 * 所以规则是**单向**的：
 *
 * | 方向 | 允许？ |
 * |---|---|
 * | 收紧（full → auto → ask） | ✅ 远端直接改（更安全，不需要问谁） |
 * | 放宽（ask → auto → full） | ❌ 远端拒绝，**并明确告诉用户去电脑上改** |
 *
 * 老实说这条比 DSH 保守。但它保守的方向是"不会因为一个远端请求而静默失去闸门"，
 * 我认为这个方向选对了 —— 而且拒绝时**不是含糊地说"不允许"**，
 * 而是说清"为什么"和"怎么办"。
 */

/** 权限档的严格程度：数字越小越严格。 */
export const SECURITY_ORDER: Record<string, number> = {
  ask: 0,
  auto: 1,
  full: 2,
};

/** 这次改动是在**放宽**权限吗？ */
export function isLoosening(current: string, next: string): boolean {
  const a = SECURITY_ORDER[current];
  const b = SECURITY_ORDER[next];
  // 未知档位一律当成"不能判断" ⇒ 按放宽处理（fail-closed：
  // 宁可多拒一次、让用户去电脑上改，也不放行一个我们不认识的档位）
  if (a === undefined || b === undefined) return true;
  return b > a;
}

export type SecurityChangeVerdict =
  | { ok: true; kind: "tighten" | "same" }
  | { ok: false; code: "remote_cannot_loosen"; message: string };

/**
 * 判断远端能否把权限档从 `current` 改到 `next`。
 *
 * 返回值里的 `message` 是**给用户看的**：要说清"被拒了"+"为什么"+"怎么办"。
 */
export function verdictForRemoteSecurityChange(
  current: string,
  next: string,
): SecurityChangeVerdict {
  if (!isLoosening(current, next)) {
    return { ok: true, kind: current === next ? "same" : "tighten" };
  }
  return {
    ok: false,
    code: "remote_cannot_loosen",
    message:
      "远端只能收紧权限档，不能放宽。放宽会让以后所有需要批准的操作自动通过 —— " +
      "这等于让远端自己取消对自己的监督。请到电脑上的「设置 → 权限」修改。",
  };
}
