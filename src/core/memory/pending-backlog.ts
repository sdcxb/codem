/**
 * 「待批准积压」的**总量闸门与超限处置策略**（第 229 波）。
 *
 * ## 被守的缺陷（用户实报：「修过一次，但一次对话后又是 9 条待批准」）
 *
 * 第 228 波把 `MEMORY_MAX_PER_EXTRACTION` 从 3 降到 2，但那条上限的口径是
 * **「每次提取最多几条进待批准区」** —— 它约束的是**速率**，不是**存量**。
 * 而待批准区是**累积**的（`llm/index.ts` 自己的注释就写着「用户不立刻处理就叠到 7–8 条甚至更多」），
 * 且一次对话可以触发**多次**提取（回合结束 + 压缩完成两条钩子，每次只要新增 ≥4 条消息就重开闸）。
 *
 * 真机取证（`%APPDATA%\com.codem.app\codem-db-rust.bin` 的 `memory` 表）：
 * - 历史批次 `count` = **8 / 6 / 6 / 7**（第 228 波之前，一次提取就写这么多）；
 * - 第 228 波之后单次降到 1~2 条，但 10-14 与 10-16 两条待批准**相隔两天**带着各自批次躺着
 *   ⇒ 累积是真的，只是速率被压低了。**速率治不了存量。**
 *
 * ## 为什么上限取 5
 *
 * 待批准积压的直接成本是**用户的决策次数**（每条要点一次批准/拒绝），所以上限要从"用户一次
 * 坐下愿意处理几条"推，而不是从"代码里哪个常量好看"推：
 * - 下界：一轮对话里同一件事的两条说法（`MEMORY_MAX_PER_EXTRACTION = 2`）+ 压缩完成那次钩子
 *   再来 2 条 = **4 条** ⇒ 上限低于 4 会让"一轮很正常地产出"就被降级；
 * - 上界：`llm/index.ts` 记录的实测痛点起点是 **7~8 条**（"叠到 7–8 条甚至更多"）；
 * - 取 **5**：比"一轮自然产出"多 1 条余量，又明显低于痛点起点；面板上一个屏幕看得完
 *   （每条一行摘要），配合「一键全部批准/拒绝」是 1~2 次点击的事。
 *
 * ## 超限处置：**降级为对话级**（三选一的理由与代价）
 *
 * 任务给了三条候选路径，这里选**降级为对话级（直接生效、仍如实留痕）**，理由：
 *
 * | 路径 | 为什么没选 |
 * | --- | --- |
 * | 合并进同主题已有条目 | 已在**入队前**由 `candidate-merge.ts` 做掉了（同批合并）；对"库里已有条目"再做一次就变成自动**改写用户数据**（改写 keeper 正文是本仓明令禁止的自动行为，见 `llm/index.ts` 的「自动整合已删除」那段：界面上写着"程序不会自动删除或改写任何条目"） |
 * | 替换最旧一条 | 那要**删掉一条用户还没处理的待批准条目** ⇒ 不可逆地丢用户数据，且用户可能正打算批准它；本仓纪律是"容量满时可见地失败，绝不静默驱逐已有条目"（`createEntry` 的注释） |
 * | **降级为对话级** ✓ | **一条不丢**：内容仍在库里、面板里可见可编辑可删，只是作用域从"这个项目以后的每个对话"收窄到"当前这次对话"——而 `memoryScopeFromExtraction` 的兜底方向本来就是 conversation（用户 2026-10-10 选定，理由"爆炸半径最小"），这里是**同一方向**的延伸 |
 *
 * 代价（如实写在报告里，也写在调用点日志里）：**用户少了一次否决机会**，那条事实会在
 * 它出现的那个对话里直接参与上下文。收窄的边界是"不跨对话、不跨项目"——它不会污染别的会话。
 *
 * ## 退化情形：连对话级都要批准时**不降级**
 *
 * 用户可以把「对话」这一档也设成"需批准"（`MAS-6` 钉着这个开关）。此时降级到对话级**仍然是
 * pending**，降级等于什么都没做 ⇒ 本模块返回 `reject-new-pending`，由调用方**如实拒绝并计数**
 * （不写入、不静默丢弃、日志点名条数与上限）。这条路的取舍是"宁可不写，也不绕过用户刚打开的闸"。
 */
import type { MemoryScope } from "./memory";

/**
 * 待批准积压的**全局**上限（跨所有作用域、所有项目、所有会话）。
 *
 * ⚠️ 必须是全局：面板按当前位置过滤（`listPending(ctx)`），但积压的**成本**（用户的决策次数）
 * 是全局的 —— 按项目各算各的 ⇒ 每个项目攒 5 条 = 换个项目又攒 5 条，等于没治。
 */
export const MEMORY_PENDING_BACKLOG_LIMIT = 5;

/** 超限时的处置动作（模块内部用：对外只暴露 `decidePendingBacklog` 与 `PendingBacklogDecision`） */
type PendingBacklogAction =
  /** 照原作用域写入（未超限，或这条本来就不需要批准） */
  | "keep"
  /** 降到对话级：直接生效、不打扰用户，但仍进库、仍留痕 */
  | "demote-conversation"
  /** 连对话级都需批准 ⇒ 不新增待批准条目，如实拒绝并计数 */
  | "reject-new-pending";

export interface PendingBacklogDecision {
  action: PendingBacklogAction;
  /** 最终写入的作用域（`reject-new-pending` 时等于入参 `intendedScope`，仅供日志用） */
  scope: MemoryScope;
  /** 给人读的理由（进日志与判据断言；不是提示词） */
  reason: string;
}

/**
 * 决定这一条候选是否还能新增一个待批准条目。
 *
 * @param intendedScope 模型/兜底规则给出的作用域（只可能是 `conversation` / `project`）
 * @param pendingTotal 库内**当前**待批准总量（全局），由 `MemoryService.countPendingEntries()` 给出
 * @param conversationNeedsApproval 「对话」这一档的审批开关（`getWriteApprovalSetting().conversation`）
 * @param limit 上限；缺省 `MEMORY_PENDING_BACKLOG_LIMIT`
 */
export function decidePendingBacklog(input: {
  intendedScope: MemoryScope;
  pendingTotal: number;
  conversationNeedsApproval: boolean;
  limit?: number;
}): PendingBacklogDecision {
  const limit = input.limit ?? MEMORY_PENDING_BACKLOG_LIMIT;
  /**
   * 只有"本来就会落成待批准"的候选才谈得上超限 —— 对话级（免批准）走另外两条路，
   * 它们的写入量由 `MEMORY_MAX_WRITES_PER_EXTRACTION` 管，不在这里。
   */
  if (input.intendedScope !== "project") {
    return { action: "keep", scope: input.intendedScope, reason: "不是待批准候选（对话级/平台级不走这道闸）" };
  }
  if (input.pendingTotal < limit) {
    return {
      action: "keep",
      scope: input.intendedScope,
      reason: `待批准积压 ${input.pendingTotal} 条 < 上限 ${limit} 条`,
    };
  }
  if (input.conversationNeedsApproval) {
    return {
      action: "reject-new-pending",
      scope: input.intendedScope,
      reason:
        `待批准积压已有 ${input.pendingTotal} 条（上限 ${limit} 条），而「对话级」这一档也被设成需批准` +
        `⇒ 降级到对话级仍是待批准，降级无效；按不新增待批准处理（如实拒绝并计数）`,
    };
  }
  return {
    action: "demote-conversation",
    scope: "conversation",
    reason:
      `待批准积压已有 ${input.pendingTotal} 条（上限 ${limit} 条）⇒ 降级为对话级：` +
      `只对当前这次对话生效（直接生效、不再打扰用户），内容仍进库、面板仍可见可改`,
  };
}
