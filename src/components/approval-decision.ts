/**
 * 审批卡出口 → 引擎权限结果（**唯一**映射点）。
 *
 * ## 为什么单独一个文件
 *
 * 共享审批卡（`packages/ui/src/approval-card.tsx`）只发 `DecisionOutcome`，引擎只认
 * `PermissionResult`；两者之间的翻译以前**内联在 `App.tsx` 的 JSX 里**，于是：
 *   - 卡发出的拒绝理由（`{ kind: "deny", reason }`）被静默丢掉 —— 用户写了理由，
 *     模型与日志都看不到（`PermissionResult` 当年也**没有** `reason` 字段）；
 *   - 「始终允许」按钮该不该出现，靠各调用点各写各的 `capabilities`。
 *
 * 现在翻译只有这一处，`App.tsx` 只负责把结果交给引擎；判据（`PRM-7`）直接调这里，
 * 不需要渲染整个 App 才能证明"理由没有在接线层面蒸发"。
 */
import type { DecisionOutcome } from "../../packages/ui/src/approval-card";
import type { PermissionAction, PermissionResult } from "../core/permission/permission";
import type { SecurityMode } from "../core/permission/security-mode";

/**
 * 把共享卡的审批结论翻成引擎的 `PermissionResult`。
 *
 * - `allow` / `always-allow` → `action: "allow"`，后者带 `alwaysAllow: true`；
 * - 其余（`deny` / `cancel`，以及理论上不会出现在审批分支的 plan/clarify）→ `deny`；
 * - **拒绝理由原样带上**（`reason`），由 `agentic-loop` 的 `describeUserDenial()` 单行化/截断。
 *   空字符串不写进结果（避免产生一个"有理由但内容为空"的字段）。
 */
export function toPermissionResult(requestId: string, outcome: DecisionOutcome): PermissionResult {
  const action: PermissionAction =
    outcome.kind === "allow" || outcome.kind === "always-allow" ? "allow" : "deny";
  return {
    requestId,
    action,
    alwaysAllow: outcome.kind === "always-allow",
    ...(outcome.kind === "deny" && outcome.reason ? { reason: outcome.reason } : {}),
  };
}

/**
 * 「始终允许」按钮该不该出现 —— **只有它真的会被兑现时才允许画出来**。
 *
 * 三个前提缺一不可（与 `agentic-loop.ts` 的消费条件逐条对应）：
 * 1. **有 resource**：引擎只按 `(tool, resource)` 记忆，且 `evaluate()` 只在
 *    `resource` 存在时查记忆 —— 没资源就存不进去，按钮必然无效；
 * 2. **有 sessionId**：记忆是会话级的，引擎在没有会话时**不写**记忆（否则就成进程级放行）；
 * 3. **ask 模式**：`auto` 模式会对危险命令**二次裁决**（`isAutoApprovable`：存了也照样问），
 *    `full` 模式根本不询问。画出来就是骗用户。
 *
 * 远端审批（手机/微信）不经过这里：`approval-broker.ts` 刻意只做一次性授权（AB-4）。
 */
export function alwaysAllowOffered(
  securityMode: SecurityMode,
  resource: string | undefined,
  sessionId: string | undefined,
): boolean {
  return securityMode === "ask" && Boolean(resource) && Boolean(sessionId);
}
