/**
 * `useMemoryPendingCount` —— 外壳层读「有几条自动记忆正等着批准」的**唯一**实现（S4 / O-45）。
 *
 * ## 它治的病
 *
 * 默认审批开启时，自动提取的记忆先进待批准区、**不进上下文**（设计如此）。
 * 而在 O-45 之前，「有一批待批准正等着」只在用户主动打开记忆面板（模态框）时才看得见 ⇒
 * 用户会以为自动记忆不好使 —— 这正是 S4 当初要治的病，只是当初只治了面板内部那一半。
 *
 * 所以提示必须落在**离开面板的常态路径**上（侧栏「记忆」入口的角标）。
 *
 * ## 三条口径（判据 `MEM-BADGE-1/2/3` 逐条钉住）
 *
 * 1. **数字取自 `getStats(scope).pendingEntries`** —— 与记忆面板顶部「待批准」那格
 *    **同一个数**，不是另算一份（`scope` 由 `memoryPanelScope()` 统一推出，见该模块）；
 * 2. **变化靠事件，不靠轮询** —— `MemoryService` 在读盘/写入之后发一次
 *    `codem-memory-changed`（见 `core/memory/memory-changed.ts`）。
 *    轮询会把"按作用域遍历全部条目"挂在每一次界面刷新上，而记忆写入是低频的；
 * 3. **没有当前作用域时 fail-closed** —— `scope` 两个键都缺省时 `getStats` 的守卫
 *    会把项目级/对话级条目一律排除 ⇒ 角标不亮，而不是把别项目的待批准数算进来。
 *
 * ## 为什么不是 `useDomainReady("memory", …)`
 *
 * `useDomainReady` 等的是**库表**镜像（`port.domains`，如 `todo_lists` / `inbox`），
 * 而 `memory` 是**配置面扩展域**（`RustConfigDomainCache`，与 `quick_phrases`/`mcp_servers` 同族），
 * 根本不在 `port.domains` 里 —— 挂上去只会得到"永远不就绪"的空退订。
 * 配置面这一侧的就绪信号由 `bootstrap` 自己发：端口注册成功后它会 `reload()` 一次记忆域，
 * 而 `reload()` 会走 `load()` ⇒ 发一次 `codem-memory-changed`（R2 的既有机制，见 `bootstrap.ts:122-151`）。
 */
import { useEffect, useMemo, useState } from "react";
import { getMemoryService } from "../core/memory/memory";
import { memoryPanelScope } from "../core/memory/panel-scope";
import { subscribeMemoryChanged } from "../core/memory/memory-changed";

export function useMemoryPendingCount(
  projectPath: string | null | undefined,
  sessionId: string | null | undefined,
): number {
  const [count, setCount] = useState(0);
  // 作用域与记忆面板**同一个实现**（同一个 `projectIdFromCwd` 口径）
  const scope = useMemo(() => memoryPanelScope(projectPath, sessionId), [projectPath, sessionId]);

  useEffect(() => {
    const refresh = () => setCount(getMemoryService().getStats(scope).pendingEntries);
    // 先自己读一次（挂载时记忆域通常已经读过盘，这一次就拿到真值）
    refresh();
    /*
     * 依赖用**键的两个原始值**而不是 `scope` 对象：`useMemo` 已经保证对象只在这两个值
     * 变化时重建，但用原始值当依赖可以让"订阅不该因对象身份而重挂"这件事不依赖 useMemo 的实现细节。
     */
    return subscribeMemoryChanged(refresh);
  }, [scope.projectId, scope.sessionId]);

  return count;
}
