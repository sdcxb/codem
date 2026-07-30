# 第8章：对话间相互调用

> Agent 如何跨会话委派任务、行业主流怎么做的、难点是什么

---

## 8.1 什么是对话间相互调用？

### 定义

对话间相互调用（Cross-Session Delegation）是指**一个会话的 Agent 向另一个会话的 Agent 发送任务**，让目标会话在自己的上下文中独立执行，完成后回传结果。

与子 Agent 的区别：

| 维度 | 子 Agent（spawn_subagent） | 跨会话委派（delegate_to_session） |
|------|---------------------------|----------------------------------|
| 会话类型 | 临时内部会话（sub-xxx） | 用户可见会话 |
| 上下文 | fork（独立） | 独立（完整会话上下文） |
| 生命周期 | 随主任务结束而销毁 | 持久存在，可继续对话 |
| 可见性 | 后台不可见 | 用户可见，可查看执行过程 |
| 通信 | spawn + wait | delegate + wait |

### 场景

1. **专业分工**：会话 A 专注后端开发，委派前端任务给会话 B
2. **并行探索**：主会话委派多个会话探索不同方向
3. **代码审查**：开发完成后，委派另一个会话做代码审查
4. **测试委派**：开发会话委派测试任务给专门的测试会话

### 行业主流做法

| 框架 | 跨会话调用 | 实现方式 |
|------|-----------|---------|
| OpenAI Codex | 不支持 | - |
| Cursor | 不支持 | - |
| LangGraph | 图节点间调用 | 状态传递 |
| AutoGen | Agent 对话 | 消息传递 |
| CrewAI | 任务委派 | 任务队列 |

**行业几乎没有支持"用户可见会话间相互调用"的实现**——大多是在框架内部的任务调度。

---

## 8.2 我们的实现

### 8.2.1 架构

```
┌──────────────────────────────────────────────────┐
│                  会话 A (源)                      │
│  Agent: build                                     │
│  上下文: 前端开发任务                               │
│                                                   │
│  delegate_to_session(                             │
│    target="session-B",                           │
│    task="帮我设计后端 API"                          │
│  ) → task_id="del-123"                           │
│                                                   │
│  ... 继续做前端开发 ...                             │
│                                                   │
│  wait_for_delegation("del-123")                  │
│  → 获取后端 API 设计结果                           │
└──────────────┬───────────────────────────────────┘
               │ 消息总线 (SessionMessageBus)
               ▼
┌──────────────────────────────────────────────────┐
│                  会话 B (目标)                     │
│  Agent: build                                     │
│  上下文: 后端开发任务                               │
│                                                   │
│  收到委派任务: "帮我设计后端 API"                    │
│  → 在自己的上下文中执行                              │
│  → 结果通过消息总线回传                             │
└──────────────────────────────────────────────────┘
```

### 8.2.2 工具定义

```typescript
// src/core/session/tools.ts

// 工具1: delegate_to_session — 非阻塞委派
{
  id: "delegate_to_session",
  description: "Send a task to another session's agent. 
                Returns immediately with a task ID (non-blocking).",
  parameters: {
    target_session_id: { 
      type: "string", 
      description: "The target session ID (use list_sessions to find)" 
    },
    task: { 
      type: "string", 
      description: "The task description to delegate" 
    },
  },
  // 立即返回 task_id，不阻塞
}

// 工具2: wait_for_delegation — 阻塞等待
{
  id: "wait_for_delegation",
  description: "Wait for a delegated task to complete.",
  parameters: {
    task_id: { 
      type: "string", 
      description: "The delegation task ID from delegate_to_session" 
    },
  },
  // 阻塞直到目标会话完成
}

// 工具3: list_sessions — 列出可用会话
{
  id: "list_sessions",
  description: "Find available target session IDs for delegate_to_session",
  // 返回当前项目的所有会话列表
}
```

### 8.2.3 编排器（Orchestrator）

```typescript
// src/core/session/orchestrator.ts

export class DelegationOrchestrator {
  // 任务缓存（与 DB 同步）
  private tasks: Map<string, DelegationTask> = new Map();
  
  // 依赖图：sessionId → 它正在等待的 targetSessionIds
  private dependencyGraph: Map<string, Set<string>> = new Map();
  
  // 状态变更监听器
  private listeners: Set<DelegationListener> = new Set();

  async delegate(params: DelegateParams): Promise<DelegationTask> {
    // 1. 不允许委派给自己
    if (sourceSessionId === targetSessionId) {
      throw new Error("Cannot delegate to the same session");
    }

    // 2. 死锁检测：检查 target → ... → source 路径是否存在
    if (this.hasCircularDependency(sourceSessionId, targetSessionId)) {
      throw new Error("Circular delegation detected");
    }

    // 3. 深度检查
    const depth = this.getDelegationDepth(sourceSessionId);
    if (depth >= this.config.maxDepth) {
      throw new Error("Max delegation depth exceeded");
    }

    // 4. 并发检查
    const activeCount = this.getActiveDelegations(sourceSessionId).length;
    if (activeCount >= this.config.maxConcurrent) {
      throw new Error("Max concurrent delegations exceeded");
    }

    // 5. 创建任务
    const task = createDelegationTask({ ...params, status: "pending" });
    
    // 6. 更新依赖图
    this.addToDependencyGraph(sourceSessionId, targetSessionId);
    
    // 7. 通过消息总线通知目标会话
    const bus = getSessionMessageBus();
    bus.send(targetSessionId, {
      type: "delegation",
      task,
    });
    
    return task;
  }
}
```

### 8.2.4 消息总线

```typescript
// src/core/session/bus.ts

// 跨会话通信的消息总线
// 基于发布-订阅模式
export class SessionMessageBus {
  private listeners: Map<string, Set<(msg: SessionMessage) => void>> = new Map();
  
  send(sessionId: string, message: SessionMessage) { ... }
  subscribe(sessionId: string, listener: (msg: SessionMessage) => void) { ... }
}
```

### 8.2.5 防并发问题

```typescript
// src/core/llm/agentic-loop.ts

// 不允许同一轮同时 delegate 和 wait
const hasDelegateInResponse = currentToolCalls.some(
  tc => tc.name === "delegate_to_session"
);
const hasWaitInResponse = currentToolCalls.some(
  tc => tc.name === "wait_for_delegation"
);

if (hasDelegateInResponse && hasWaitInResponse) {
  // 拒绝 wait，因为 task_id 还没拿到
  return {
    output: "Cannot wait_for_delegation in the same response as 
             delegate_to_session. Send delegate_to_session calls first, 
             then in your NEXT response use the returned task IDs."
  };
}
```

---

## 8.3 难点

### 8.3.1 死锁问题

```
会话 A → 委派给 → 会话 B
会话 B → 委派给 → 会话 A  ← 死锁！双方互相等待

解决方案：DFS 依赖图检测
在 delegate() 调用时，检查 target 是否（直接或间接）正在等待 source
```

### 8.3.2 上下文丢失

```
会话 A 委派任务给会话 B
会话 B 在自己的上下文中执行
→ B 的上下文包含 B 的对话历史，不包含 A 的上下文
→ B 可能缺乏 A 认为理所当然的背景信息

难点：A 发送 task 时无法自动判断 B 需要哪些上下文
当前方案：A 在 task 描述中尽量自包含
```

### 8.3.3 结果格式

```
会话 B 完成任务后，结果是一段文本
但 A 可能期望的是结构化数据（如 JSON、文件路径）

当前方案：结果是纯文本，A 的 LLM 负责解析
```

### 8.3.4 超时处理

```
会话 A wait_for_delegation("del-123")
会话 B 执行时间很长或卡住
→ A 的 Agentic Loop 被阻塞

当前方案：wait 有超时，超时后返回超时错误
```

### 8.3.5 并发控制

```
会话 A 同时委派 10 个任务给不同会话
→ 资源消耗大

当前方案：maxConcurrent 限制并发委派数
```

### 8.3.6 LLM 行为不可预测

```
LLM 可能：
1. 委派后忘记 wait → 防遗漏守护处理
2. 用错误的 task_id 调用 wait → 返回错误提示
3. 同一轮 delegate + wait → 拒绝并提示
4. 委派给自己 → 前置检查拒绝
```

---

## 8.4 行业对比与我们的取舍

| 维度 | 行业主流 | 我们 | 理由 |
|------|---------|------|------|
| 跨会话调用 | 不支持 | 支持 | 独有功能 |
| 通信模式 | 同步调用 | 异步 delegate + wait | 非阻塞 |
| 死锁检测 | 无 | DFS 依赖图 | 安全 |
| 深度限制 | 无 | maxDepth = 3 | 防无限嵌套 |
| 并发限制 | 无 | maxConcurrent | 资源控制 |
| 消息总线 | 无 | 发布-订阅 | 解耦 |

### 我们的优势

1. **用户可见会话间调用**：行业独有，用户可以看到委派任务的执行过程
2. **完整的生命周期管理**：创建→执行→完成→回传→清理
3. **多层安全**：死锁检测 + 深度限制 + 并发控制 + 自委派拒绝
4. **防 LLM 行为异常**：delegate+wait 同轮拒绝、错误 task_id 提示

### 我们的取舍

1. **结果是无结构文本**：不像 API 调用返回 JSON，需要 LLM 解析
2. **无优先级调度**：所有委派任务平等排队
3. **无回压机制**：目标会话过载时不会拒绝新任务
4. **消息总线是内存级**：应用重启后未完成的委派需要从 DB 恢复

---

## 8.5 核心代码导航

| 文件 | 职责 |
|------|------|
| `src/core/session/orchestrator.ts` | DelegationOrchestrator、死锁检测、深度限制 |
| `src/core/session/tools.ts` | delegate_to_session、wait_for_delegation、list_sessions |
| `src/core/session/types.ts` | DelegationTask、DelegationState、DelegationConfig |
| `src/core/session/delegation-storage.ts` | 委派任务持久化到 SQLite |
| `src/core/session/bus.ts` | SessionMessageBus 跨会话消息总线 |
| `src/core/llm/agentic-loop.ts` | 防并发（delegate+wait 同轮拒绝） |

---

## 小结

> 跨会话调用 = delegate（非阻塞）+ wait（阻塞等待）
> 与子 Agent 区别 = 委派到用户可见会话，持久存在
> 难点 = 死锁检测、上下文丢失、结果格式、超时、并发控制、LLM 行为
> 安全 = DFS 死锁检测 + 深度限制 3 + 并发限制 + 自委派拒绝 + 同轮 delegate+wait 拒绝
> 行业对比 = 我们独有"用户可见会话间调用"能力
