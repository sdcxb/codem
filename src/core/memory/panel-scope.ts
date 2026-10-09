/**
 * 记忆面板 / 外壳角标的**作用域**（S4 / O-45）—— 全仓唯一一处。
 *
 * ## 为什么值得单独一个模块
 *
 * 「当前位置有哪些记忆」这件事由一对键决定：
 * - `projectId`：**不是** `Project.id`，而是由项目工作目录归一化出来的值（`projectIdFromCwd`）；
 * - `sessionId`：当前对话 id。
 *
 * 记忆面板（`MemoryManager`）与侧栏角标读的是**同一个数**（`getStats(ctx).pendingEntries`），
 * 而 `ctx` 一旦分叉就出现最坏的一类缺陷：角标说「有 3 条待批准」，点进面板却是 0 条
 * （或反过来 —— 面板里明明有，角标不亮）。这正是 GAP-LIST 给 O-45 写的
 * 「与记忆面板同一个数，不许另算」。
 *
 * 所以「怎么从当前位置推出这一对键」只在这里实现一次，两个消费方都调它。
 * 判据 `MEM-BADGE-1` 会在**真渲染**下比对两侧的数字（不是比对两个 props）。
 */
import { projectIdFromCwd } from "./memory";

export interface MemoryPanelScope {
  /** 项目级记忆的归属键（由工作目录推出）；没有当前项目时为 `undefined` */
  projectId: string | undefined;
  /** 对话级记忆的归属键；没有当前对话时为 `undefined` */
  sessionId: string | undefined;
}

/**
 * 由「当前项目的工作目录 + 当前对话 id」推出记忆面板的作用域。
 *
 * 两个入参都允许缺省：缺省时 `getStats` 的守卫会 fail-closed
 * （项目级/对话级条目一律不显示、不计入），而不是跨项目展示别人的内容。
 */
export function memoryPanelScope(
  projectPath: string | null | undefined,
  sessionId: string | null | undefined,
): MemoryPanelScope {
  return {
    projectId: projectIdFromCwd(projectPath ?? undefined),
    sessionId: sessionId ?? undefined,
  };
}
