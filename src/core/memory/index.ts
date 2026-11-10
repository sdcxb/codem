export {
  MemoryService,
  getMemoryService,
  projectIdFromCwd,
  getWriteApprovalSetting,
  setWriteApprovalSetting,
  approvalRequiredForScope,
  MEMORY_WRITE_APPROVAL_KEY,
  MEMORY_MIGRATED_KEY,
  type MemoryEntry,
  type MemoryScope,
  type LegacyMemoryScope,
  type MemorySource,
  type MemoryStatus,
  type MemorySearchResult,
  type MemoryConfig,
  type MemoryBatch,
  type MemoryAddResult,
  type MemoryScopeContext,
  type MemoryMigrationReport,
  type ApprovalScopeSetting,
  type MemorySearchBackend,
  type MemoryLexicalBackend,
} from "./memory";

/*
 * 可选 embedding 的**注入缝**（24 §P2「可选向量/混合检索」；任务 A）。
 *
 * 默认不注入 ⇒ 检索保持纯词法、零网络。宿主 / 手机桥 / 测试通过 `setMemoryEmbedder()` 提供实现；
 * 这里从 barrel 导出是它**唯一的公开入口**（`embedding.ts` 本身不是面板可直接依赖的模块面）。
 */
export { getMemoryEmbedder, setMemoryEmbedder, type MemoryEmbedder } from "./embedding";
