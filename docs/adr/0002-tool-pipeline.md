# ADR-0002: 5 层工具执行管线

**Date**: 2026-08-13
**Status**: Accepted
**Decision Maker**: Engineering Team

## Context

对标 dsh 分析后发现：

1. **当前架构**：权限检查散落在 agentic-loop 和各工具内部，hook 在 pre/post 两点执行
2. **dsh 架构**：5 层瀑布式管线 (pre-execute → guards → execute → post-execute → finalize)
3. **差距**：
   - 权限逻辑分散，难以统一管理
   - 缺少 finalize 层（无法保证事件写入）
   - 中间件顺序不可控
   - 测试困难（需要模拟整个 agentic-loop）

## Decision

引入 5 层瀑布式工具执行管线：

```
1. pre-execute (waterfall): hooks → permission → security-scan
2. monotonic guards (frozen order): plan-mode → sandbox
3. execute (waterfall): tool.execute() + timeout + retry
4. post-execute (waterfall): hooks → result accept/reject/replace/append
5. finalize (freeze): event-log write → return authoritative result
```

### 中间件注册

```typescript
const pipeline = getToolPipeline();
pipeline.registerPreExecute(new PermissionMiddleware(...));
pipeline.registerGuard(new PlanModeGuard(...));
pipeline.registerGuard(new SandboxGuard(...));
pipeline.registerFinalize(new EventLogFinalizeMiddleware());
```

### 短路语义

- 任一层的 deny/reject 立即短路，不执行后续层
- Guard 层是 monotonic（不可重排序）
- Finalize 层只读取结果，不修改

## Consequences

### Positive
- 统一的权限/安全检查入口
- 清晰的中间件分离
- 每层可独立测试
- 管线事件可用于 telemetry 和 replay
- 新增安全策略只需注册新中间件

### Negative
- 增加了一层抽象（性能开销可忽略）
- 现有权限逻辑需要适配为中间件

## Implementation

- `src/core/llm/tool-pipeline.ts` — 管线实现
- `src/core/hooks/hook-types.ts` — 新增 Guard/Finalize 事件类型
- `src/test/tool-pipeline.test.ts` — 15 个测试用例
