# 第7章：并行对话

> 什么场景下需要并行对话，行业主流怎么做的，我们怎么做的

---

## 7.1 为什么需要并行对话？

### 场景

1. **多任务并行**：用户同时开发多个功能，每个功能一个会话
2. **委派等待**：主 Agent 派生子任务后，用户想在等待期间做其他事
3. **对比实验**：同时尝试不同方案，对比结果
4. **长时间任务**：一个会话在跑长时间编译/测试，用户想在另一个会话继续工作

### 串行 vs 并行

```
串行：
  会话A: 开发功能1 [████████████████] → 完成
  会话B:                                    [████████████████] → 完成
  总时间: ████████████████████████████████████

并行：
  会话A: [████████████████]         → 完成
  会话B:     [████████████████]     → 完成
  总时间: ████████████████████
```

### 行业主流做法

| 框架 | 并行方式 | 实现 |
|------|---------|------|
| OpenAI Codex | 多会话并行 | 异步任务队列 |
| Cursor | 多 tab | 前端多窗口 |
| ChatGPT | 多对话 | 前端多会话 |
| Claude | 不支持 | 单会话 |

---

## 7.2 我们的实现

### 7.2.1 多会话并行

#### 前端层

```typescript
// src/store.ts

interface AppState {
  activeSessions: Set<string>;  // 当前正在运行的会话 ID 集合
  isStreaming: boolean;          // 当前查看的会话是否在流式输出
}
```

```typescript
// src/components/ChatPanel.tsx

// 每个会话有独立的流式状态
const isSessionStreaming = !currentSessionId 
  ? isStreaming 
  : activeSessions.has(currentSessionId);

// 发送消息时标记会话为 active
useAppStore.getState().setSessionActive(session.id, true);

// 流式结束后取消标记
useAppStore.getState().setSessionActive(session.id, false);
```

#### 后端层

```typescript
// src/App.tsx

// 每个会话有独立的 AbortController
const abortControllersRef = useRef<Map<string, AbortController>>(new Map());

// 并行运行多个会话
const runAgenticLoop = async (message, session, selectedSkills) => {
  const sessionAbort = new AbortController();
  abortControllersRef.current.set(session.id, sessionAbort);
  
  // 会话级别的消息更新（不互相干扰）
  const isViewingSession = () => {
    const viewing = useProjectStore.getState().currentSession?.id;
    return viewing === session.id;
  };
  
  // 只有当前查看的会话才更新 UI
  const safeAddMessage = (msg) => {
    if (isViewingSession()) addMessage(msg);
    // 但总是持久化到 DB
    if (session) saveMessages(session.id);
  };
  
  for await (const event of engine.process(session.id, message, cwd, ...)) {
    if (sessionAbort.signal.aborted) break;
    // 处理事件...
  }
};
```

### 7.2.2 并行子 Agent

```typescript
// 主 Agent 可以同时派生多个子 Agent
// 每个子 Agent 在独立的 fork 上下文中运行
// 互不干扰

spawn_subagent("explore", "分析前端代码")    → task-1
spawn_subagent("explore", "分析后端代码")    → task-2
spawn_subagent("explore", "分析数据库结构")  → task-3

// 然后逐个等待结果
wait_for_subagent("task-1")  → 前端分析结果
wait_for_subagent("task-2")  → 后端分析结果
wait_for_subagent("task-3")  → 数据库分析结果
```

### 7.2.3 跨会话委派并行

```typescript
// 会话 A 委派任务到会话 B 和 C
// A 不阻塞，可以继续工作

delegate_to_session("session-B", "设计 API 接口")  → del-1
delegate_to_session("session-C", "设计数据库")     → del-2

// A 继续做其他事
write("src/config.ts", config)
...

// 稍后收集结果
wait_for_delegation("del-1")  → API 设计
wait_for_delegation("del-2")  → 数据库设计
```

---

## 7.3 并行状态管理

### 会话活跃状态

```
用户有三个会话：
  会话A (当前查看) ← 流式输出中
  会话B             ← 委派任务执行中  
  会话C             ← 子 Agent 执行中

activeSessions = { "session-A", "session-B", "session-C" }
```

### UI 状态隔离

```typescript
// 每个会话有独立的：
// - 消息列表（从 DB 加载）
// - 流式状态（activeSessions.contains(id)）
// - 权限请求队列（per-session Map）
// - 写文件确认队列（per-session Map）
// - 交互表单队列（per-session Map）

setPendingPermissions(prev => {
  const next = new Map(prev);
  next.set(session.id, { request, resolve });  // 按会话 ID 隔离
  return next;
});
```

### 消息持久化

```typescript
// 所有会话的消息都持久化到同一个 SQLite 数据库
// 通过 sessionId 隔离
MessageStorage.listMessages(sessionId)
MessageStorage.createMessage(msg, sessionId)
```

> **[配图位]**：并行会话状态图，展示多会话同时运行、UI 隔离、DB 共享

---

## 7.4 行业对比与我们的取舍

| 维度 | 行业主流 | 我们 | 理由 |
|------|---------|------|------|
| 多会话并行 | 前端多 tab | 后端多会话 + per-session abort | 真并行 |
| 子 Agent 并行 | 同步为主 | 异步 spawn + wait | 不阻塞 |
| 跨会话并行 | 不支持 | delegate + wait | 任务分发 |
| 状态隔离 | 前端路由 | per-session Map | 权限/确认不串 |
| 取消机制 | 全局 abort | per-session AbortController | 精准取消 |

### 我们的优势

1. **真并行**：多个会话同时运行 Agentic Loop，不是前端 tab 切换
2. **精准取消**：每个会话有独立 AbortController，取消一个不影响其他
3. **状态隔离**：权限请求、写确认、交互表单都按 session ID 隔离
4. **子 Agent 并行**：spawn 多个子 Agent 不阻塞主 Agent

### 我们的取舍

1. **UI 单视图**：用户一次只能看一个会话的消息（不像 Cursor 多 tab 同时显示）
2. **无优先级**：所有并行会话平等，没有优先调度
3. **无资源限制**：没有限制最大并行会话数

---

## 7.5 核心代码导航

| 文件 | 职责 |
|------|------|
| `src/App.tsx` | runAgenticLoop、abortControllersRef、per-session 状态管理 |
| `src/store.ts` | activeSessions、setSessionActive |
| `src/components/ChatPanel.tsx` | isSessionStreaming、活跃会话标记 |
| `src/core/llm/tools.ts` | spawn_subagent、wait_for_subagent |
| `src/core/session/orchestrator.ts` | 跨会话委派并行 |
| `src/core/storage/message.ts` | 消息持久化（per-session） |

---

## 小结

> 并行 = 多会话 + 多子 Agent + 跨会话委派
> 状态隔离 = per-session AbortController + per-session 权限/确认队列
> UI 单视图 = 一次只看一个会话，但后台多会话并行运行
> 取消 = 每个 AbortController 独立，精准取消单个会话
