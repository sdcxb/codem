# 最终审计报告 v3 — 全部隐患追踪

> 审计时间：2026-07-23
> 方法：逐行追踪运行时链路，不只看数据结构

## 一、自动任务（Automation）在双模式下是否真正工作？

### ✅ 核心链路已通

```
定时器/文件监听触发
  → startAutomationEngines callback
  → useProjectStore.getState().createSession()  ✅ 创建新 Session，继承 executionMode
  → handleSendRef.current(trigger.message)       ✅ 用 ref 引用，避免 stale closure
  → handleSend() 读取 useProjectStore.getState().currentSession  ✅ 是新创建的 session
  → runAgenticLoop() 检查 session.executionMode  ✅ 已继承
  → 如果 git_worktree：调用 createWorktree()     ✅ 创建工作树
  → engine.process(session.id, message, cwd)     ✅ 用 worktree 路径
```

### ⚠️ 剩余隐患：handleSendRef 首次为空

```typescript
// App.tsx line 254
const handleSendRef = useRef<...>(() => {});
```

初始化为空函数。如果自动化引擎在 App 组件首次渲染之前触发（极端情况），`handleSendRef.current` 会调用空函数。但实际 `startAutomationEngines` 在 `useEffect` 内部、数据库初始化之后调用，此时 `handleSend` 已定义。**风险极低**。

### 结论：✅ 自动任务在双模式下可工作

---

## 二、并行对话是否真正可工作？

### ✅ 已修复的部分

| 项 | 状态 |
|----|------|
| `activeSessions: Map<string, boolean>` | ✅ 已实现 |
| `setSessionActive(session.id, true/false)` | ✅ 正确调用 |
| InputArea `disabled` per-session | ✅ 用 `activeSessions.has(currentSession.id)` |
| `abortControllersRef: Map<sessionId, Controller>` | ✅ per-session abort |
| 侧栏运行状态指示器 | ✅ 绿色脉冲圆点 |
| 活跃任务面板 | ✅ RightSidebar 可点击切换 |

### 🔴 剩余的 3 个硬阻断（导致并行不可用）

#### 阻断 1：`messages` 数组是全局单例

```typescript
// store.ts
messages: Message[];  // ← 全局唯一，不是 per-session Map
```

**场景**：会话 A 正在流式输出，用户切换到会话 B：
1. `loadMessages(B)` 替换全局 `messages` 为 B 的历史消息 ✅
2. 会话 A 的流式事件继续到达 → `addMessage()` / `appendToMessage()` 修改全局 `messages`
3. 但现在 `messages` 显示的是 B 的消息 → A 的流式内容**混入 B 的视图**
4. 用户切回 A → `loadMessages(A)` 从数据库重新加载 → A 的部分流式内容已保存，但切换期间产生的中间内容可能丢失

**这是最核心的问题**：需要把 `messages` 改为 `Map<sessionId, Message[]>` 或在切换时先 save 再 load。

#### 阻断 2：`engineRef` 是单实例，内部 `this.agenticLoop` 被覆盖

```typescript
// llm/index.ts line 195
getAgenticLoop(agentId?: string): AgenticLoop {
  this.agenticLoop = new AgenticLoop(...);  // ← 每次 getAgenticLoop 都覆盖！
  return this.agenticLoop;
}
```

**场景**：会话 A 的 `for await (engine.process(A, ...))` 正在运行。会话 B 也调用 `engine.process(B, ...)`：
1. `process()` 内部调用 `this.getAgenticLoop()` → 创建新的 AgenticLoop → **覆盖了 A 正在用的 loop**
2. A 的 `for await` 循环现在用的是一个被替换/失效的 loop 引用
3. B 的新 loop 会覆盖 A 的配置（collaborationMode、securityMode 等）

**结果**：两个会话无法真正并行运行。第二个 `process()` 调用会破坏第一个。

#### 阻断 3：`streamingMsgId` / `stepProgress` / `agentActivities` 全局单例

```typescript
// store.ts
streamingMsgId: string | null;    // 只能追踪一个流式消息
stepProgress: StepProgress | null; // 只能显示一个步骤进度
agentActivities: AgentActivity[];   // 只能有一个 agent 活动列表
```

**场景**：两个会话并行流式时，`streamingMsgId` 被后启动的会话覆盖，`stepProgress` 也被覆盖。UI 无法区分哪个进度属于哪个会话。

### 结论：⚠️ 并行对话数据结构到位，但运行时仍有 3 个全局单例阻断

---

## 三、Git Worktree 功能完整性

### ✅ 已实现且链路通

| 功能 | 状态 | 说明 |
|------|------|------|
| createWorktree | ✅ | `runAgenticLoop` 中正确调用，cwd 切换到 worktree 路径 |
| removeWorktree | ✅ | `deleteSession` 自动调用 + 设置页手动删除 |
| scanWorktrees | ✅ | 设置页扫描 + 右侧栏不显示（只设了表格） |
| enforceMaxWorktrees | ✅ | 在 createWorktree 内部调用 LRU 清理 |
| 分支选择 checkout | ✅ | InputArea 执行 `git checkout`（PowerShell 单引号） |
| forkSession 创建 worktree | ✅ | forkSession 调用 createWorktreeSync |
| 模式切换 dirty 检查 | ✅ | handleExecutionModeChange 检查 uncommitted |
| Worktree 设置页 | ✅ | max=15、autoClean、warnOnDirty、扫描/删除 |
| Worktree 数量 vs 上限 | ✅ | 设置页显示 `当前: N/15` |
| 路径 OS 原生分隔符 | ✅ | Windows 用 `\`，Linux 用 `/` |
| Windows PowerShell 兼容 | ✅ | 全部用单引号 + psQuote + Get-ChildItem |
| Session 继承 executionMode | ✅ | createSession 读取 project 偏好 |
| 侧栏 worktree 标识 | ✅ | 🌲 图标 + tooltip 路径 |
| path_exists Rust 命令 | ✅ | 新增 Tauri 命令，零编码风险 |

### 结论：✅ Git Worktree 功能完整，链路贯通

---

## 四、有功能但缺少交互界面的情况

| 功能 | 有库 | 有入口 | 补充 |
|------|------|--------|------|
| `refreshAutomationEngines()` | ✅ | ✅ | 设置页保存后自动调用 |
| `stopAutomationEngines()` | ✅ | ⚠️ | 无显式停止按钮，只在引擎刷新时间接调用 |
| `getWorktreeCount()` | ✅ | ✅ | 设置页显示 N/15 |
| Worktree 路径显示 | ✅ | ✅ | 侧栏 🌲 tooltip + 设置页列表 |
| 并行活跃会话列表 | ✅ | ✅ | RightSidebar 活跃任务面板 |
| 自动化触发历史 | ✅ | ⚠️ | 有 `addTriggerHistory()` 但设置页不显示历史 |
| Worktree 创建进度 | ⚠️ | ❌ | fire-and-forget，无进度/成功/失败 toast |

### 剩余缺失

1. **自动化触发历史不显示** — `addTriggerHistory()` 已实现写入，但设置页 AutomationSettingsSection 没有读取和显示 `config.history`
2. **无"停止所有自动化"按钮** — `stopAutomationEngines()` 存在但无 UI 调用
3. **Worktree 创建无进度提示** — 异步创建，用户不知道是否成功

---

## 五、修改后引发的新隐患

### 🟡 中等

| # | 隐患 | 影响 |
|---|------|------|
| 1 | **全局 messages 数组** | 并行会话切换时消息混乱（见上文） |
| 2 | **engine.agenticLoop 单实例覆盖** | 并行 process() 调用互相破坏（见上文） |
| 3 | **streamingMsgId/stepProgress 全局** | 两个流式会话 UI 状态混淆 |
| 4 | **handleSendRef 自引用** | `handleSendRef.current = handleSend` 在函数体内部赋值，可能导致循环引用 |
| 5 | **自动化创建的 Session 无 projectPath** | `createSession` 如果 `currentProject` 为 null，executionMode 不会被设置 |

### 🟢 轻微

| # | 隐患 | 影响 |
|---|------|------|
| 6 | Worktree 路径 Windows 拼接 | `getWorktreeRoot` 用 `\` 但 JS 内部比较用 `/`，可能有路径不匹配 |
| 7 | 自动化触发历史不显示 | 功能已有但 UI 缺失 |

---

## 修复优先级

### 必须修复才能实现真正并行（P0）

1. **messages 改为 per-session** — 切换会话时 save→load，流式事件用 sessionId 过滤
2. **engine.getAgenticLoop 改为 per-session** — `Map<sessionId, AgenticLoop>` 而非 `this.agenticLoop` 单实例
3. **streamingMsgId/stepProgress/agentActivities per-session** — 或在切换时 save→load

### 应该修复（P1）

4. **自动化触发历史在设置页显示**
5. **自动化设置页加"停止所有"按钮**
6. **Worktree 创建成功/失败 toast 提示**

### 建议优化（P2）

7. **handleSendRef 改为在 useEffect 中赋值**
8. **getWorktreeRoot 返回值统一为 normalizePath 后的格式**
