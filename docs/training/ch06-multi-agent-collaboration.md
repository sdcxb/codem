# 第6章：多 Agent 协作

> 群体智能高于个体：协作框架、上下文共享/隔离、涌现的「Agent 社会」

---

## 6.1 为什么需要多 Agent 协作？

### 场景

一个复杂任务往往需要多种能力：
- **分析**：理解需求，制定计划（plan Agent）
- **执行**：写代码，运行命令（build Agent）
- **探索**：搜索代码库，理解架构（explore Agent）
- **摘要**：压缩上下文（summary Agent）
- **记忆**：提取关键信息（memory slot）

单个 Agent 同时做所有事会导致：
- 上下文臃肿（工具太多，描述太长）
- 角色混乱（既分析又执行，容易跑偏）
- 无法并行（串行处理效率低）

### 行业主流做法

| 框架 | 协作模式 | 上下文 | 通信 |
|------|---------|--------|------|
| CrewAI | 角色分配 + 任务队列 | 共享 | 消息传递 |
| AutoGen | 多 Agent 对话 | 共享 | 对话 |
| LangGraph | 图状态机 | 状态传递 | 图边 |
| OpenAI Codex | subagent 派生 | 隔离 | spawn/wait |

---

## 6.2 我们的协作框架

### 两层协作架构

```
┌──────────────────────────────────────────┐
│           主 Agent（Primary）             │
│  build / plan / explore / general        │
│                                          │
│    ┌──────────┐  ┌──────────┐           │
│    │ 子 Agent  │  │ 子 Agent  │          │
│    │ (subagent)│  │ (subagent)│          │
│    │ fork 上下文│  │ fork 上下文│         │
│    └──────────┘  └──────────┘          │
│                                          │
│    ┌──────────────────────────┐         │
│    │ 跨会话委派                │         │
│    │ delegate_to_session      │         │
│    │ → 另一个用户可见会话       │         │
│    └──────────────────────────┘         │
└──────────────────────────────────────────┘
```

### 6.2.1 子 Agent 协作（会话内）

#### 派生模式

```typescript
// 主 Agent 调用 spawn_subagent
spawn_subagent(agent_id: "explore", task: "找到所有 API 路由定义")
  → 创建临时会话（sub-xxx）
  → 在 fork 上下文中运行 explore Agent
  → 立即返回 task_id

// 主 Agent 可以继续做其他事
write("src/new-feature.ts", code)
  ...

// 稍后收集结果
wait_for_subagent(task_id: "sub-xxx")
  → 阻塞等待，直到子 Agent 完成
  → 返回子 Agent 的输出
```

#### 上下文隔离

子 Agent 默认使用 `fork` 上下文模式：
- 子 Agent 有**独立的对话历史**
- 子 Agent **看不到**主 Agent 的完整上下文
- 只看到 task 描述（由主 Agent 提供）
- 完成后只返回**结果文本**，不返回中间过程

**为什么隔离？**
1. 防止上下文污染：子任务的大量工具调用不会膨胀主上下文
2. 成本控制：子 Agent 可以用更便宜的模型
3. 并行安全：多个子 Agent 不会互相干扰

#### 上下文共享

如果需要共享上下文，使用 `inline` 模式：
- 子 Agent 继承主 Agent 的完整对话历史
- 子 Agent 的工具调用结果也会出现在主上下文中
- 代价：上下文膨胀更快

### 6.2.2 跨会话委派（会话间）

```typescript
// src/core/session/orchestrator.ts

// delegate_to_session: 委派任务到另一个用户可见会话
delegate_to_session(
  target_session_id: "session-abc",
  task: "帮我分析一下这个 API 的安全性"
)
  → 目标会话的 Agent 收到任务
  → 独立执行
  → 结果通过消息总线回传

// wait_for_delegation: 等待委派结果
wait_for_delegation(task_id: "del-xxx")
  → 阻塞等待目标会话完成
```

#### 死锁检测

```typescript
// 防止 A→B→A 循环委派（DFS 遍历依赖图）
private hasCircularDependency(
  source: string, 
  target: string
): boolean {
  // 从 target 开始 DFS，如果能到达 source，说明有环
  const visited = new Set<string>();
  const stack = [target];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node === source) return true;  // 发现环
    if (visited.has(node)) continue;
    visited.add(node);
    // 获取 node 正在等待的所有 target
    const deps = this.dependencyGraph.get(node);
    if (deps) stack.push(...deps);
  }
  return false;
}
```

#### 深度限制

```typescript
// 委派链最大深度（防止无限嵌套）
maxDepth: 3
// A → B → C → D ✅
// A → B → C → D → E ❌ (超过深度限制)
```

---

## 6.3 Agent 社会：涌现行为

### 角色分工涌现

当多个 Agent 协作时，会自然涌现角色分工：

```
用户："实现一个完整的用户注册功能"

主 Agent (build):
  1. spawn_subagent("explore", "找到现有的用户模型和认证逻辑")
  2. 同时: 开始设计注册 API 接口
  3. wait_for_subagent → 获取探索结果
  4. 根据探索结果调整设计
  5. spawn_subagent("explore", "找到测试文件的模式")
  6. 编写注册逻辑代码
  7. wait_for_subagent → 获取测试模式
  8. 编写测试代码
  9. bash: 运行测试
  10. 如果失败，修复并重试
```

### 协作 vs 串行

| 模式 | 示例 | 效率 |
|------|------|------|
| 串行 | 探索→设计→编码→测试 | 慢，每步等上一步 |
| 并行 | spawn探索 + 同时设计 → 收集 → 编码 → spawn测试模式 + 同时编码 | 快，重叠等待时间 |

---

## 6.4 行业对比与我们的取舍

| 维度 | 行业主流 | 我们 | 理由 |
|------|---------|------|------|
| 协作粒度 | 角色+任务 | Agent ID + task | 更灵活 |
| 上下文模式 | 共享为主 | fork 默认 | 隔离优先 |
| 通信 | 消息传递 | spawn + wait | 异步非阻塞 |
| 死锁检测 | 无 | DFS 依赖图 | 安全 |
| 深度限制 | 无 | 最大 3 层 | 防无限嵌套 |
| 并发控制 | 无 | 最多 N 个并发子 Agent | 资源控制 |

### 我们的优势

1. **异步协作**：spawn + wait 模式让主 Agent 不必阻塞等待
2. **死锁检测**：跨会话委派有循环检测，防止 A→B→A
3. **上下文隔离**：fork 模式防止子任务膨胀主上下文
4. **防遗漏守护**：循环结束前检查未 wait 的子 Agent

### 我们的取舍

1. **无 Agent 对话**：不像 AutoGen 那样支持 Agent 之间直接对话
2. **无角色继承**：不像 CrewAI 那样支持角色层次
3. **单向通信**：子 Agent 不能主动向父 Agent 发消息（只能等 wait）

---

## 6.5 核心代码导航

| 文件 | 职责 |
|------|------|
| `src/core/agent/agent.ts` | AgentDefinition、AgentRegistry、内置 Agent |
| `src/core/llm/tools.ts` | spawn_subagent、wait_for_subagent |
| `src/core/llm/index.ts` | processSubagent()、getAgenticLoop() |
| `src/core/session/orchestrator.ts` | 跨会话委派、死锁检测、深度限制 |
| `src/core/session/tools.ts` | delegate_to_session、wait_for_delegation |
| `src/core/session/bus.ts` | 跨会话消息总线 |

---

## 小结

> 协作 = 子 Agent（会话内）+ 跨会话委派（会话间）
> 上下文隔离 = fork 模式（默认），共享 = inline 模式
> 异步 = spawn + wait，非阻塞派生
> 安全 = 死锁检测 + 深度限制 + 防遗漏守护
> 涌现 = 角色分工自然产生，无需预定义
