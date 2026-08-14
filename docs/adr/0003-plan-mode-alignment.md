# ADR-0003: Plan Mode 提示词对齐 dsh 6 段规范

**Date**: 2026-08-13
**Status**: Accepted
**Decision Maker**: Engineering Team

## Context

对标 dsh 分析后发现：

1. **当前 Plan Mode 提示词**：仅 1 段简短描述
2. **dsh Plan Mode 提示词**：6 段详细行为规范
3. **差距**：
   - LLM 不知道如何正确退出 Plan 模式
   - 缺少 `exit_plan_mode` 工具
   - 没有计划完整性要求
   - 没有工具目录稳定性声明

## Decision

### 1. 新增 `exit_plan_mode` 工具

LLM 完成分析和计划后，调用 `exit_plan_mode(plan_markdown)` 提交计划给用户审批。

- 用户 Approve → 切换到 Default 模式，自动开始执行
- 用户 Reject → 保持 Plan 模式，LLM 修改计划后重新提交

### 2. 提示词对齐 dsh 6 段规范

```
1. Mode Declaration: Stay in plan mode until exit_plan_mode succeeds
2. Explore First: Use non-mutating reads, searches, static analysis
3. Tool Catalog Stability: The tool catalog stays the same across modes
4. Ask User Restrictions: Use ask_user only for user-owned choices
5. Plan Completeness: Goal, Success criteria, Subsystems, Steps, Edge cases, Rollback
6. Exit Plan Mode: Make it the only and final tool call
```

## Consequences

### Positive
- LLM 有明确的退出路径（exit_plan_mode 工具）
- 计划质量提升（decision-complete 要求）
- 工具目录稳定性保证 KV cache 有效性

### Negative
- 提示词变长（增加约 800 tokens）
- exit_plan_mode 需要 UI 集成（审批弹窗）

## Implementation

- `src/core/llm/tools/exit-plan-mode.ts` — 工具定义
- `src/core/llm/tools.ts` — 工具注册
- `src/core/prompt/prompt.ts` — 提示词对齐
