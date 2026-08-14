# ADR-0001: 采用事件溯源作为会话存储架构

**Date**: 2026-08-13
**Status**: Accepted (Phase 1: Dual-write transition)
**Decision Maker**: Engineering Team

## Context

对标 DeepSeek Harness (dsh) 分析后发现：

1. **当前架构**：使用 SQLite CRUD 表（messages + tool_calls）存储会话消息
2. **dsh 架构**：使用 append-only 事件流，消息是投影结果
3. **差距**：
   - 无法回放历史会话状态
   - 无法 Fork 会话
   - 压缩后丢失原始消息
   - 缺乏审计能力

## Decision

采用渐进式迁移策略，引入事件溯源作为最终存储架构：

### Phase 1 (当前): 双写过渡
- 新建 `session_events` 表（append-only）
- `createMessage()` 同时写入 CRUD 和事件日志
- `compactMessages()` 同时写入 compaction 事件
- `buildMessages()` 仍从 CRUD 读取（保持兼容）

### Phase 2 (下一步): 投影切换
- `buildMessages()` 改为从 `deriveMessagesFromEvents()` 读取
- 压缩恢复从事件流重建
- 旧 CRUD 表变为只读 fallback

### Phase 3 (最终): CRUD 移除
- 删除 messages/tool_calls 表
- 事件日志成为唯一真相源
- 投影函数成为唯一消息构建路径

## Consequences

### Positive
- 支持会话回放和 Fork
- 压缩后仍可恢复完整历史
- 审计能力：每个状态变更都有记录
- 投影函数是纯函数，易于测试

### Negative
- 双写过渡期增加了存储空间
- 需要维护两套读取逻辑
- 迁移现有数据需要一次性 backfill

### Neutral
- 事件日志是 append-only，不需要 UPDATE 操作
- 投影函数可以缓存，性能影响可控

## Implementation

- `src/core/storage/event-types.ts` — 事件类型定义
- `src/core/storage/event-log.ts` — 事件日志写入/读取
- `src/core/storage/event-projection.ts` — 投影函数
- `src/core/storage/database.ts` — `session_events` 表定义
- `src/core/storage/message.ts` — 双写逻辑
- `src/core/llm/agentic-loop.ts` — compaction 事件写入
