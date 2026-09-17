/**
 * 子智能体会话行补齐（任务 C-2 / 第 91 波）
 *
 * ## 缺陷：子会话从来没有 `sessions` 行
 *
 * 子智能体的会话 id 由 `InProcessSpawnProvider.start()` / `SubagentRuntime.startContinuable()`
 * 现造（`sub-<ts>-<rand>`），然后**直接当成 sessionId 用**：
 * `LLMEngine.processSubagent` 用它调 `MessageStorage.createMessage`，
 * `agentic-loop` / `cost-tracker` 用它记遥测与成本。
 *
 * 而全仓**没有任何一处**为这些 id 建 `sessions` 行（`grep createSession src/core/subagent` = 0 命中）。
 * 于是所有带外键的写都被引擎拒绝 —— 真 CLI 实测：
 *
 * ```
 * messages.upsert_index({session_id:"sub-123-abc"}) → {"code":"CONSTRAINT","message":"FOREIGN KEY constraint failed"}
 * events.append({session_id:"sub-123-abc"})        → 同上
 * ```
 *
 * 用户可见症状：子智能体的消息索引、事件、成本记录**全部写不进库**，
 * 重启后子智能体轨迹整批消失（而 UI 当时是显示过的 —— 那是内存态）。
 *
 * ## 修法：spawn 时补一条**最小** `sessions` 行
 *
 * 用既有的 `src/core/storage/session.ts`（`getSession` / `createSession`），
 * 不新造 SQL、不改那个文件。三条硬要求：
 *
 * 1. **归属项目必须与父会话一致**，不许凭空造 `project_id`：
 *    父会话行读不到时**不补**（宁可这条轨迹写不进去，也不给数据编一个错误的项目归属）。
 *    读父会话走**镜像优先**：`sessions` 是域镜像表，父会话通常就在镜像里；
 *    镜像没接手时如实返回 undefined → 不补。
 * 2. **失败如实上报，但绝不让子智能体启动失败**：补不上只是"这条轨迹入不了库"，
 *    子智能体本身照常跑（降级但可见）。
 * 3. **退出/清理时保留子会话行**（不删）。理由写在 `ensureSubagentSession` 的结尾。
 */

import { getSession, createSession } from "../storage/session";
import { reportPersistFailure } from "../storage/persist-failure";

/** 子会话标题（UI 的会话列表里能一眼看出这是子智能体建的） */
function childTitle(childId: string): string {
  return `子智能体 ${childId}`;
}

/**
 * 保证 `childId` 在 `sessions` 表里有一行；已存在则什么都不做（幂等）。
 *
 * @param childId 子智能体的会话 id（就是 `SubagentRun.id` / `Activation.childId`）
 * @param parentSessionId 父会话 id（用来取 `project_id`）
 * @param options.allowCreate 是否允许真的建行。默认 true。
 *        传 false 用于"只要确认它存在、不想在这里产生写"的场景。
 * @returns 子会话行当下是否可用（true = 后续消息/事件/遥测可以写进去）
 */
export function ensureSubagentSession(
  childId: string,
  parentSessionId: string,
  options: { allowCreate?: boolean } = {},
): boolean {
  try {
    // 幂等：已经有一行就什么都不做（重复 spawn 同一 id 不会覆盖标题/归属）
    if (getSession(childId) !== null) return true;

    const parent = getSession(parentSessionId);
    if (!parent) {
      /*
       * 父会话读不到 → **不补**。
       *
       * 两种情形都会落到这里，且都不该硬造归属：
       * - `sessions` 镜像尚未接手（`domainReadOne` 返回 undefined → `getSession` 给 null）；
       * - 父会话行确实不在库里（例如纯 CLI/无项目的会话）。
       *
       * 「不确定」与「不存在」在这里的处置相同（都不补），但**上报文案要能区分**，
       * 否则排查者会把"镜像还没就绪"误读成"父会话丢了"。
       */
      reportPersistFailure(
        "subagent.ensureSession",
        new Error("父会话读不到（子会话行未创建）"),
        `子智能体 ${childId} 的消息/事件/遥测本次写不进库（等 sessions 镜像就绪后重试 spawn 即可恢复）`,
      );
      return false;
    }

    if (parent.projectId === "") {
      /*
       * 父会话的 `project_id` 是空串 —— 那是 Rust 侧"全局项目"的约定值
       * （`sessions_upsert` 缺省就是 `""`，schema 阶段种下了这一行，满足外键）。
       * 这不是"没有归属"，所以**可以**照抄；但不能把它当成"随便挑一个项目"的先例。
       */
    }

    if (options.allowCreate === false) return false;

    const now = Date.now();
    createSession({
      id: childId,
      projectId: parent.projectId,
      title: childTitle(childId),
      createdAt: now,
      lastMessageAt: now,
      messageCount: 0,
      pinned: false,
    });

    /*
     * 校验写得成不成。
     *
     * `createSession` 的契约是 void（失败走 `reportPersistFailure`），所以这里**回读一次**：
     * 建行失败时 `getSession` 仍然是 null —— 把它如实报出来，但**不抛**：
     * 子智能体必须照常启动（降级但要可见，不许因为一条辅助索引行而让功能整体不可用）。
     */
    if (getSession(childId) === null) {
      reportPersistFailure(
        "subagent.ensureSession",
        new Error("子会话行未写成（createSession 未落地）"),
        `子智能体 ${childId} 的消息/事件/遥测本次写不进库`,
      );
      return false;
    }
    return true;
  } catch (e) {
    // 兜底：这个函数**绝不能**往外抛 —— 调用方（spawn 路径）会因此让子智能体启动失败
    reportPersistFailure("subagent.ensureSession", e, "子会话行未创建（子智能体继续运行）");
    return false;
  }
}

/*
 * ## 退出 / 清理时子会话行为什么**保留**（不随子智能体结束删除）
 *
 * 1. **删了就等于删轨迹**：`messages` / `session_events` / `telemetry_events` /
 *    `cost_records` 都是 `ON DELETE CASCADE`。删子会话行会**连带删掉**它的
 *    全部消息索引与事件 —— 那正是 C-2 想救回来的东西，删它等于把修好的缺陷又做一遍。
 * 2. **成本与遥测要能回溯**：`cost_records` 按 `session_id` 聚合，
 *    删了子会话行，用户看到的账单会**凭空变小**（而不是"没有这一段"）。
 * 3. **可续聊**：`SubagentRuntime.followup()` 明确保留已 dispose 的 activation
 *    （"不从 activations 中删除 — 保留 disposed activation 以供 followup re-activate"），
 *    子会话行留着才与它一致。
 *
 * 代价：`sessions` 表会积累子会话行（每个子智能体一行）。这可以接受 ——
 * 它只有 id/项目/标题/时间戳几个短字段，且与"消息索引本来就有外键指向它"是同一份数据。
 * 真要清理，应当走与用户会话一致的显式删除路径（带 `confirm_bulk`），而不是在
 * 子智能体退出时顺手级联删掉一堆语料。
 */
