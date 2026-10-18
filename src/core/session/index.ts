/**
 * 跨会话 Agent 协作模块 — 统一导出
 *
 * 模块结构（参考 subagent/index.ts 模式）：
 * - types.ts: 类型定义
 * - bus.ts: SessionMessageBus（跨会话事件总线）
 * - delegation-storage.ts: DB 持久化层
 * - orchestrator.ts: DelegationOrchestrator（编排器 + 死锁检测）
 * - executor.ts: executeSessionTurn（程序化触发会话执行，阶段2 新增）
 */

// ========== 类型 ==========
export {
  type DelegationState,
  type SessionMessageType,
  type SessionMessage,
  type DelegationTask,
  type DelegationConfig,
  DEFAULT_DELEGATION_CONFIG,
} from "./types";

// ========== 事件总线 ==========
export { SessionMessageBus, getSessionMessageBus, resetSessionMessageBus } from "./bus";

// ========== 编排器 ==========
export {
  DelegationOrchestrator,
  getDelegationOrchestrator,
  resetDelegationOrchestrator,
  type DelegateParams,
  type DelegationListener,
} from "./orchestrator";

// ========== DB 存储 ==========
export {
  createDelegationTask,
  updateDelegationTaskStatus,
  getDelegationTask,
  getDelegationsBySource,
  getDelegationsByTarget,
  getDelegationsByProject,
  getActiveDelegations,
  deleteDelegationTask,
  clearCompletedDelegations,
} from "./delegation-storage";

// ========== 执行器 ==========
export {
  executeSessionTurn,
  isSessionExecuting,
  startSessionExecution,
  endSessionExecution,
  cancelSessionExecution,
  processPendingDelegations,
  type ExecuteSessionTurnParams,
  type ExecuteSessionTurnResult,
} from "./executor";

// ========== 委派工具 ==========
export {
  createDelegateToSessionTool,
  /* 2026-10-18：移交到**新建**会话（用户直报"移交给新对话却投给了老对话"） */
  createHandoffToNewSessionTool,
  createWaitForDelegationTool,
  createQuerySessionResultTool,
  createListSessionsTool,
  createCancelDelegationTool,
  /* 第 190 轮：把会话标记为内部（不进对话目录）—— 由 agent 显式声明，可逆 */
  createSetSessionInternalTool,
} from "./tools";

// ========== 交接会话（标题唯一化 + 创建/委派流程） ==========
export {
  HANDOVER_TITLE_EN,
  HANDOVER_TITLE_ZH,
  handoverStamp,
  nextHandoverTitle,
  openHandoverSession,
  type OpenHandoverSessionOptions,
  type OpenHandoverSessionResult,
} from "./handoff-session";
