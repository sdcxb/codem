# mimo-gui 全面功能增强实施方案

> 文档版本：v1.0  
> 分析日期：2025-01-XX  
> 对标基准：wecode-ref (基于 Codex CLI)  
> 目标：实现 38 项核心缺失功能

---

## 📋 目录

1. [架构影响分析](#架构影响分析)
2. [文件修改清单](#文件修改清单)
3. [交互方式变更](#交互方式变更)
4. [存储架构改造](#存储架构改造)
5. [消息通信机制影响](#消息通信机制影响)
6. [分类实施计划](#分类实施计划)
7. [开发规范与注意事项](#开发规范与注意事项)

---

## 🏗️ 架构影响分析

### 当前架构概览

```
┌─────────────────────────────────────────────────────────────┐
│                     App.tsx (编排层)                          │
│  - handleSend / handleRegenerate / handleFork                │
│  - runAgenticLoop (事件流处理器)                              │
│  - LoopEvent 处理 (text_delta, tool_*, guidance_received)   │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│              AgenticLoop (核心执行引擎)                        │
│  - 消息队列处理 (messagesForIteration)                        │
│  - GuidanceQueue (引导注入)                                   │
│  - ToolRegistry + StreamingToolExecutor                       │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│              MessageBubble + ChatPanel (UI)                   │
│  - 消息渲染 (Markdown + ToolCall + Reasoning)                │
│  - 滚动容器 (messagesContainerRef)                            │
│  - fork / regenerate / guidance input                        │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│              Store (Zustand) + Storage (SQLite)              │
│  - AppState (messages, isStreaming, stepProgress)           │
│  - MessageStorage (CRUD, tool_calls, attachments)            │
│  - ProjectStore (sessions, projects)                         │
└─────────────────────────────────────────────────────────────┘
```

### 关键数据流

**正常消息流程：**
```
用户输入 → InputArea.onSend 
  → App.handleSend 
  → runAgenticLoop 
  → AgenticLoop.run (async generator)
  → LoopEvent { type: "text_delta" }
  → addMessage (streaming) 
  → MessageBubble 更新
  → MessageStorage.persistMessage (SQLite)
```

**引导消息流程：**
```
用户输入引导 → ChatPanel.guidanceInput 
  → onSendGuidance 
  → guidanceQueue.enqueue 
  → AgenticLoop 消费引导 
  → LoopEvent { type: "guidance_received" }
  → UI 显示引导气泡
```

### 新功能对架构的影响

| 影响层级 | 影响类型 | 说明 |
|---------|---------|------|
| **存储层** | Schema 扩展 | 需新增 `message_feedback` 表、`draft_messages` 表、`prompt_versions` 表 |
| **状态管理** | Store 扩展 | 需新增 `drafts`、`feedback`、`queue` 状态切片 |
| **事件系统** | LoopEvent 扩展 | 需新增 `clarification`、`correction`、`pipeline` 事件类型 |
| **工具系统** | 工具注册 | 需新增 `ask_clarification`、`fact_check`、`todo_write` 工具 |
| **UI 组件** | 组件树扩展 | 需新增 `InlineEdit`、`ScrollbarMarkers`、`Workbench` 等组件 |

---

## 📁 文件修改清单

### 🔧 核心文件修改 (Required)

#### 1. 存储层 (`src/core/storage/`)

| 文件 | 修改内容 | 优先级 |
|------|---------|-------|
| `database.ts` | 新增表：`message_feedback`、`prompt_drafts`、`quick_phrases`、`todo_lists` | P0 |
| `message.ts` | 新增方法：`deleteMessagesAfter(sessionId, messageId)`、`saveFeedback`、`loadFeedback` | P0 |
| `settings.ts` | 新增方法：`saveQuickPhrase`、`loadQuickPhrases` | P2 |
| `prompt-draft.ts` (新建) | Prompt 草稿版本管理（A/B 对比） | P2 |

#### 2. 核心引擎 (`src/core/llm/`)

| 文件 | 修改内容 | 优先级 |
|------|---------|-------|
| `agentic-loop.ts` | 扩展 LoopEvent、新增 `clarification` 事件处理、支持 Pipeline 模式 | P1 |
| `types.ts` | 新增类型：`ClarificationEvent`、`CorrectionEvent`、`PipelineEvent` | P1 |
| `tools.ts` | 新增工具：`ask_clarification`、`fact_check`、`show_todo` | P1 |
| `tools/ask-clarification.ts` (新建) | 澄清提问工具（返回表单结构） | P1 |
| `tools/fact-check.ts` (新建) | 事实核查工具（调用 Correction 模型） | P1 |
| `tools/todo-display.ts` (新建) | Todo 列表展示工具 | P1 |

#### 3. 状态管理 (`src/store.ts`)

| 文件 | 修改内容 | 优先级 |
|------|---------|-------|
| `store.ts` | 新增状态：`drafts`、`feedback`、`messageQueue`、`searchQuery` | P0 |
| `store.ts` | 新增操作：`saveDraft`、`loadDraft`、`setFeedback`、`deleteAfter` | P0 |
| `store.ts` | 新增状态：`correctionMode`、`deepThinkingMode`、`preserveExecutor` | P1 |
| `store.ts` | 新增状态：`scrollState` (用户是否在底部) | P0 |

#### 4. UI 组件 (`src/components/`)

| 文件 | 修改内容 | 优先级 |
|------|---------|-------|
| `ChatPanel.tsx` | 集成 ScrollbarMarkers、ScrollToBottomIndicator、MessageSearch | P0 |
| `ChatPanel.tsx` | 添加滚动检测逻辑、滚动状态同步到 store | P0 |
| `MessageBubble.tsx` | 集成 InlineEdit、FeedbackButtons、BubbleTools | P0 |
| `MessageBubble.tsx` | 支持"编辑后删除后续消息"的 UI 流程 | P0 |
| `InputArea.tsx` | 集成 QuickPhraseSelector、PromptDraftPicker | P2 |
| `InputArea.tsx` | 添加模式切换：Correction、DeepThinking、PreserveExecutor | P1 |

### 🎨 新增组件 (New Components)

#### P0 核心交互组件

| 组件 | 路径 | 功能 |
|------|------|------|
| `InlineMessageEdit.tsx` | `src/components/` | 行内编辑用户消息 |
| `ScrollbarMarkers.tsx` | `src/components/` | 滚动条消息标记 |
| `ScrollToBottomIndicator.tsx` | `src/components/` | 回到底部按钮 |
| `FeedbackButtons.tsx` | `src/components/` | 👍👎 反馈按钮 |

#### P1 高级功能组件

| 组件 | 路径 | 功能 |
|------|------|------|
| `ClarificationForm.tsx` | `src/components/` | 澄清表单（AI 提问） |
| `CorrectionResultPanel.tsx` | `src/components/` | Correction 结果对比 |
| `PipelineNextStepDialog.tsx` | `src/components/` | Pipeline 下一步对话框 |
| `TodoListDisplay.tsx` | `src/components/` | Todo 列表可视化 |
| `GuidanceBlock.tsx` | `src/components/` | 引导消息展示块 |
| `Workbench.tsx` | `src/components/` | 代码工作台（Git diff + 文件树） |
| `RegenerateModelPopover.tsx` | `src/components/` | 重新生成模型选择器 |

#### P2 体验提升组件

| 组件 | 路径 | 功能 |
|------|------|------|
| `QuickAccessCards.tsx` | `src/components/` | Agent 快速访问卡片 |
| `QuickPhraseSelector.tsx` | `src/components/` | 快捷短语选择器 |
| `PromptDraftPicker.tsx` | `src/components/` | Prompt 草稿版本选择器 |
| `OnboardingTour.tsx` | `src/components/` | 新手引导（driver.js） |
| `StreamingWaitIndicator.tsx` | `src/components/` | 分阶段等待提示 |
| `SourceReferences.tsx` | `src/components/` | RAG 来源引用展示 |

#### P3 多媒体组件

| 组件 | 路径 | 功能 |
|------|------|------|
| `ImageGallery.tsx` | `src/components/` | 图片预览画廊 |
| `VideoPlayer.tsx` | `src/components/` | 视频播放器 |
| `GenerateModeSelector.tsx` | `src/components/` | 生成模式（图像/视频） |
| `ResolutionSelector.tsx` | `src/components/` | 分辨率选择器 |
| `SearchEngineSelector.tsx` | `src/components/` | 搜索引擎选择器 |

#### P4 高级功能组件

| 组件 | 路径 | 功能 |
|------|------|------|
| `ContextBadgeList.tsx` | `src/components/` | 上下文徽章 |
| `MentionAutocomplete.tsx` | `src/components/` | @ 提及自动补全 |
| `SkillAutocomplete.tsx` | `src/components/` | 技能自动补全 |
| `SourceSelector.tsx` | `src/components/` | 知识库来源选择器 |

### 🔌 新增 Hooks

| Hook | 路径 | 功能 | 优先级 |
|------|------|------|-------|
| `useMessageFeedback.ts` | `src/hooks/` | 消息反馈持久化 | P0 |
| `useScrollState.ts` | `src/hooks/` | 滚动状态检测 | P0 |
| `useMessageSendQueue.ts` | `src/hooks/` | 消息发送队列 | P1 |
| `useStreamingJoinWarning.ts` | `src/hooks/` | 流式加入警告 | P2 |
| `useQueuedRuntimeHealthCheck.ts` | `src/hooks/` | 队列健康检查 | P2 |
| `useDraftPersistence.ts` | `src/hooks/` | 草稿持久化 | P2 |

### 🛠️ 新增工具函数

| 文件 | 路径 | 功能 | 优先级 |
|------|------|------|-------|
| `message-utils.ts` | `src/utils/` | 消息工具：截断后续消息、合并消息 | P0 |
| `scroll-utils.ts` | `src/utils/` | 滚动工具：计算消息位置、平滑滚动 | P0 |
| `diff-utils.ts` | `src/utils/` | Diff 工具：文本对比、Markdown diff | P1 |
| `prompt-utils.ts` | `src/utils/` | Prompt 工具：版本比较、A/B 测试 | P2 |

### 📚 新增 i18n 翻译

| 文件 | 修改内容 | 优先级 |
|------|---------|-------|
| `src/core/i18n/lang.ts` | 新增所有新功能的翻译键 | P0 |

---

## 🎭 交互方式变更

### P0 核心交互变更

#### 1. 消息行内编辑与重新发送 (InlineMessageEdit)

**旧流程：**
```
用户输入 → 发送 → AI 回复 → 用户不满意 → 手动复制粘贴 → 重新输入
```

**新流程：**
```
用户输入 → 发送 → AI 回复 → 
  用户点击"编辑" → 进入行内编辑模式（textarea 替换消息内容） → 
  修改内容 → 点击"确认" → 
  删除该消息及后续所有消息 → 
  从该点重新执行对话
```

**交互细节：**
- 编辑按钮：仅在用户消息的 hover 时显示
- 编辑模式：消息气泡替换为 textarea，保留原始内容
- 确认后：调用 `deleteMessagesAfter(messageId)` → 调用 `runAgenticLoop(newContent)`
- 取消：恢复原始消息气泡

**涉及的组件：**
- `MessageBubble.tsx`：添加编辑按钮和编辑模式状态
- `App.tsx`：添加 `handleEditAndResend(messageId, newContent)` 方法
- `message.ts`：添加 `deleteMessagesAfter(sessionId, messageId)` 方法

#### 2. 滚动条标记 (ScrollbarMarkers)

**旧流程：**
```
长对话 → 用户向上滚动 → 滚动到任意位置 → 用户不知道哪里有重要消息
```

**新流程：**
```
长对话 → 滚动条右侧显示小圆点标记（每个用户消息一个标记） → 
  用户点击标记 → 滚动到该消息位置
```

**交互细节：**
- 标记生成：监听 `messages` 变化，为每个用户消息计算滚动位置
- 标记点击：`container.scrollTo({ top: messageOffset, behavior: "smooth" })`
- 标记样式：小圆点，当前可视区域标记高亮

**涉及的组件：**
- `ScrollbarMarkers.tsx`（新建）
- `ChatPanel.tsx`：集成 ScrollbarMarkers

#### 3. 回到底部指示器 (ScrollToBottomIndicator)

**旧流程：**
```
用户向上滚动 → 新消息到达 → 用户不知道 → 需要手动滚动到底部
```

**新流程：**
```
用户向上滚动 → store.scrollState = "scrolled_up" → 
  新消息到达 → 显示"回到底部"按钮 → 
  用户点击 → 滚动到底部 → 按钮消失
```

**交互细节：**
- 按钮显示：`store.scrollState === "scrolled_up" && hasNewMessages`
- 按钮样式：浮动在聊天区域右下角
- 点击行为：`messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })`

**涉及的组件：**
- `ScrollToBottomIndicator.tsx`（新建）
- `ChatPanel.tsx`：集成 ScrollToBottomIndicator
- `store.ts`：新增 `scrollState` 状态

#### 4. 消息反馈（点赞/点踩）

**旧流程：**
```
AI 回复 → 用户无反馈 → 无法收集用户满意度数据
```

**新流程：**
```
AI 回复 → 消息下方显示 👍👎 按钮 → 
  用户点击 → 保存反馈到 localStorage → 
  支持遥测上报（可选）
```

**交互细节：**
- 按钮显示：在消息气泡底部 hover 时显示
- 反馈持久化：`localStorage.setItem('feedback_${messageId}', 'like')`
- 反馈状态：从 localStorage 读取，初始化按钮状态

**涉及的组件：**
- `FeedbackButtons.tsx`（新建）
- `MessageBubble.tsx`：集成 FeedbackButtons
- `useMessageFeedback.ts`（新建 hook）

### P1 高级交互变更

#### 5. Correction 模式

**旧流程：**
```
AI 回复 → 用户怀疑内容不准确 → 手动查询其他来源 → 对比 → 无修正建议
```

**新流程：**
```
AI 回复 → 用户点击"Correction"开关 → 
  系统调用事实核查模型 → 
  对比原回复 vs 修正后回复 → 
  显示 CorrectionResultPanel → 
  用户选择"应用修正"或"保留原回复"
```

**交互细节：**
- 开关位置：ChatPanel 顶部（类似 Reasoning 开关）
- Correction 模型：可配置（如 GPT-4 Turbo）
- 对比面板：左右分屏，显示差异高亮

**涉及的组件：**
- `CorrectionModeToggle.tsx`（新建）
- `CorrectionResultPanel.tsx`（新建）
- `agentic-loop.ts`：支持 `correction` 模式的消息构建

#### 6. 澄清表单 (ClarificationForm)

**旧流程：**
```
AI 缺少信息 → AI 在消息中提问 → 用户回复文字 → AI 解析容易出错
```

**新流程：**
```
AI 缺少信息 → AI 调用 `ask_clarification` 工具 → 
  返回表单结构（单选/多选/文本） → 
  UI 渲染 ClarificationForm → 
  用户填写 → 提交 → 格式化为 Markdown 发回 AI
```

**交互细节：**
- 表单结构：`{ type: "radio", options: [...], question: "..." }`
- 提交格式：`[用户选择: xxx]` 或 `[用户回答: xxx]`

**涉及的组件：**
- `ClarificationForm.tsx`（新建）
- `tools/ask-clarification.ts`（新建）
- `agentic-loop.ts`：处理 `clarification` 事件

#### 7. Pipeline 下一步对话框 (PipelineNextStepDialog)

**旧流程：**
```
AI 完成任务 → 用户想继续相关任务 → 手动输入新提示 → 上下文可能丢失
```

**新流程：**
```
AI 完成任务 → 消息下方显示"继续下一步"按钮 → 
  用户点击 → PipelineNextStepDialog → 
  选择上下文（文本消息/知识库/表格） → 
  添加自定义提示 → 
  创建新对话或追加到当前对话
```

**交互细节：**
- 上下文选择：复选框列表（历史消息 + 知识库条目）
- 提示输入：文本框，支持 @ 提及
- 模式选择：新对话 vs 追加当前对话

**涉及的组件：**
- `PipelineNextStepDialog.tsx`（新建）
- `MessageBubble.tsx`：添加"继续下一步"按钮

#### 8. Workbench 代码工作台

**旧流程：**
```
AI 修改代码 → 用户切换到终端查看 git diff → 不直观
```

**新流程：**
```
AI 修改代码 → Workbench 浮动侧边栏实时显示 → 
  Git diff（文件级 + 行级） → 
  Commit 统计 → 
  文件树 → 
  工具执行状态
```

**交互细节：**
- 浮动侧边栏：可折叠，固定在右侧
- Git diff：使用 DiffViewer 组件
- 实时更新：监听 LoopEvent `tool_complete` 事件

**涉及的组件：**
- `Workbench.tsx`（新建）
- `ChatPanel.tsx`：集成 Workbench

---

## 💾 存储架构改造

### 新增表结构

#### 1. message_feedback 表

```sql
CREATE TABLE IF NOT EXISTS message_feedback (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  feedback TEXT NOT NULL CHECK (feedback IN ('like', 'dislike')),
  timestamp INTEGER NOT NULL,
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_message_feedback_message ON message_feedback(message_id);
```

**用途：** 持久化消息反馈（点赞/点踩）

#### 2. prompt_drafts 表

```sql
CREATE TABLE IF NOT EXISTS prompt_drafts (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  content TEXT NOT NULL,
  tags TEXT, -- JSON array: ["bugfix", "refactor"]
  created_at INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_prompt_drafts_session ON prompt_drafts(session_id);
```

**用途：** Prompt 草稿版本管理（A/B 对比）

#### 3. quick_phrases 表

```sql
CREATE TABLE IF NOT EXISTS quick_phrases (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  category TEXT, -- "coding", "review", "test", "debug"
  usage_count INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_quick_phrases_category ON quick_phrases(category);
```

**用途：** 快捷短语管理（模板化输入）

#### 4. todo_lists 表

```sql
CREATE TABLE IF NOT EXISTS todo_lists (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  message_id TEXT, -- 关联的 AI 消息
  todos TEXT NOT NULL, -- JSON: [{id, content, status, order}]
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_todo_lists_session ON todo_lists(session_id);
```

**用途：** TodoWrite 工具输出的持久化

### 扩展现有表

#### messages 表扩展

```sql
-- 新增字段
ALTER TABLE messages ADD COLUMN parent_message_id TEXT; -- 用于行内编辑后的消息追溯
ALTER TABLE messages ADD COLUMN draft_version INTEGER; -- 关联 prompt_drafts.version
ALTER TABLE messages ADD COLUMN metadata TEXT; -- JSON: {correction_applied: true, pipeline_step: 2}
```

**用途：** 支持行内编辑、Prompt 版本追溯、Pipeline 步骤标记

#### sessions 表扩展

```sql
ALTER TABLE sessions ADD COLUMN correction_mode INTEGER DEFAULT 0; -- Correction 模式开关
ALTER TABLE sessions ADD COLUMN deep_thinking_mode INTEGER DEFAULT 0; -- 深度思考模式开关
ALTER TABLE sessions ADD COLUMN preserve_executor INTEGER DEFAULT 0; -- 保留执行器模式开关
ALTER TABLE sessions ADD COLUMN queue_mode TEXT DEFAULT 'one-per-unblock'; -- 消息投递模式
```

**用途：** 会话级功能开关持久化

### 存储层 API 扩展

#### message.ts 新增方法

```typescript
// 删除指定消息及其后续所有消息
export async function deleteMessagesAfter(sessionId: string, messageId: string): Promise<number>;

// 保存消息反馈
export async function saveFeedback(feedback: { messageId: string; type: "like" | "dislike" }): Promise<void>;

// 加载消息反馈
export async function loadFeedback(messageId: string): Promise<"like" | "dislike" | null>;

// 查询会话的所有消息（用于截断）
export async function getMessagesAfter(sessionId: string, timestamp: number): Promise<Message[]>;
```

#### prompt-draft.ts 新增方法（新建文件）

```typescript
// 保存 Prompt 草稿
export async function savePromptDraft(sessionId: string, content: string, tags?: string[]): Promise<string>;

// 加载会话的所有 Prompt 草稿
export async function loadPromptDrafts(sessionId: string): Promise<PromptDraft[]>;

// 删除 Prompt 草稿
export async function deletePromptDraft(draftId: string): Promise<void>;

// A/B 对比两个 Prompt 草稿
export async function comparePromptDrafts(draftId1: string, draftId2: string): Promise<{ diff: string; better: string }>;
```

#### settings.ts 新增方法

```typescript
// 保存快捷短语
export async function saveQuickPhrase(phrase: QuickPhrase): Promise<void>;

// 加载所有快捷短语
export async function loadQuickPhrases(): Promise<QuickPhrase[]>;

// 删除快捷短语
export async function deleteQuickPhrase(phraseId: string): Promise<void>;
```

---

## 📡 消息通信机制影响

### LoopEvent 类型扩展

#### 当前 LoopEvent 类型

```typescript
export type LoopEvent =
  | { type: "start"; iteration: number }
  | { type: "llm_status"; status: LLMStatus }
  | { type: "step_progress"; ... }
  | { type: "text_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "knowledge_sources"; sources: [...] }
  | { type: "tool_start"; toolCall: StreamingToolCall }
  | { type: "tool_complete"; toolCall: StreamingToolCall; result: any }
  | { type: "tool_error"; toolCall: StreamingToolCall; error: string }
  | { type: "permission_request"; request: PermissionRequest; resolve: (result: PermissionResult) => void }
  | { type: "compaction_start" }
  | { type: "compaction_end"; messagesRemoved: number }
  | { type: "retry"; attempt: number; delay: number; error: string; errorType: string | null }
  | { type: "usage"; usage: TokenUsage }
  | { type: "guidance_received"; message: string; guidanceId: string }
  | { type: "end"; result: LoopResult };
```

#### 新增 LoopEvent 类型

```typescript
// P1: 澄清表单事件
| { type: "clarification"; form: ClarificationForm; resolve: (answers: ClarificationAnswer[]) => void }

// P1: Correction 模式事件
| { type: "correction_complete"; original: string; corrected: string; changes: Diff[] }

// P1: Pipeline 事件
| { type: "pipeline_step_complete"; stepId: string; result: PipelineStepResult }

// P1: Todo 列表事件
| { type: "todo_list_created"; todos: TodoItem[]; todoId: string }

// P1: 知识来源引用事件
| { type: "source_references"; sources: RetrievedSource[] }
```

### AgenticLoop 行为变更

#### 1. 澄清表单处理流程

```typescript
// AgenticLoop.run() 内部
for await (const event of this.runInternal()) {
  yield event;
  
  if (event.type === "clarification") {
    // 暂停执行，等待用户填写表单
    const answers = await event.resolve;
    
    // 将答案格式化为 Markdown 消息
    const answerMessage = formatClarificationAnswers(answers);
    
    // 将答案作为用户消息插入队列
    messagesForIteration.push({
      id: `clarification-${Date.now()}`,
      role: "user",
      content: answerMessage,
    });
    
    // 继续执行
    continue;
  }
}
```

#### 2. Correction 模式处理流程

```typescript
// AgenticLoop.run() 内部
const isCorrectionEnabled = getSessionCorrectionMode(sessionId);

if (isCorrectionEnabled && event.type === "end" && event.result.content) {
  // 调用事实核查模型
  const correctionResult = await this.factCheckTool(event.result.content);
  
  yield { type: "correction_complete", original: event.result.content, corrected: correctionResult.corrected, changes: correctionResult.changes };
  
  // 等待用户选择应用修正或保留原回复
  // (UI 端处理选择结果)
}
```

#### 3. Pipeline 模式处理流程

```typescript
// AgenticLoop.run() 内部
const isPipelineMode = getSessionPipelineMode(sessionId);

if (isPipelineMode && event.type === "tool_complete" && event.toolCall.tool === "pipeline_step") {
  const stepResult = event.result;
  
  yield { type: "pipeline_step_complete", stepId: stepResult.id, result: stepResult };
  
  // UI 端显示 Pipeline 下一步对话框
  // 用户选择后继续执行
}
```

### 工具系统扩展

#### 1. ask_clarification 工具（新建）

```typescript
// src/core/llm/tools/ask-clarification.ts
export const askClarificationTool: ToolDefinition = {
  name: "ask_clarification",
  description: "向用户提问以获取缺失信息。支持单选、多选、文本输入。",
  parameters: {
    type: "object",
    properties: {
      question: { type: "string", description: "问题内容" },
      type: { type: "string", enum: ["radio", "checkbox", "text"], description: "问题类型" },
      options: { 
        type: "array", 
        items: { type: "string" },
        description: "选项列表（单选/多选时必填）" 
      },
      required: { type: "boolean", description: "是否必答" },
    },
    required: ["question", "type"],
  },
};

export async function handleAskClarification(args: any, context: ToolContext): Promise<string> {
  // 触发 clarification 事件，UI 端渲染表单
  // 返回一个占位符，实际答案由用户提供后注入
  return `[等待用户回答: ${args.question}]`;
}
```

#### 2. fact_check 工具（新建）

```typescript
// src/core/llm/tools/fact-check.ts
export const factCheckTool: ToolDefinition = {
  name: "fact_check",
  description: "对 AI 回复进行事实核查，返回修正建议。",
  parameters: {
    type: "object",
    properties: {
      content: { type: "string", description: "需要核查的内容" },
    },
    required: ["content"],
  },
};

export async function handleFactCheck(args: any, context: ToolContext): Promise<string> {
  // 调用 Correction 模型进行事实核查
  const provider = context.engine.providers.get(context.config.correctionProvider || "openai");
  const model = context.config.correctionModel || "gpt-4-turbo";
  
  const response = await provider.stream({
    model,
    messages: [
      { id: "system", role: "system", content: "你是一个事实核查专家。..." },
      { id: "user", role: "user", content: args.content },
    ],
  });
  
  let corrected = "";
  for await (const event of response) {
    if (event.type === "text_delta") {
      corrected += event.text;
    }
  }
  
  return corrected;
}
```

#### 3. show_todo 工具（新建）

```typescript
// src/core/llm/tools/show-todo.ts
export const showTodoTool: ToolDefinition = {
  name: "show_todo",
  description: "展示 Todo 列表，支持完成/进行中/待办状态。",
  parameters: {
    type: "object",
    properties: {
      todos: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            content: { type: "string" },
            status: { type: "string", enum: ["pending", "in_progress", "completed"] },
            order: { type: "number" },
          },
        },
      },
    },
    required: ["todos"],
  },
};

export async function handleShowTodo(args: any, context: ToolContext): Promise<string> {
  // 触发 todo_list_created 事件，UI 端渲染 TodoListDisplay
  return "";
}
```

---

## 📅 分类实施计划

### 🔥 P0 - 核心交互增强（Q1，预计 4 周）

#### Sprint 1: 行内编辑 + 消息反馈（Week 1-2）

**目标：** 实现消息行内编辑和反馈功能

**任务清单：**
1. [ ] 创建 `InlineMessageEdit.tsx` 组件
   - 编辑模式状态管理
   - Textarea 自动高度调整
   - 保存/取消逻辑
2. [ ] 创建 `FeedbackButtons.tsx` 组件
   - 👍👎 按钮
   - localStorage 持久化
   - 状态初始化
3. [ ] 修改 `MessageBubble.tsx`
   - 集成 InlineMessageEdit
   - 集成 FeedbackButtons
   - 添加 hover 效果
4. [ ] 修改 `message.ts`
   - 实现 `deleteMessagesAfter(sessionId, messageId)`
   - 实现 `saveFeedback`
   - 实现 `loadFeedback`
5. [ ] 修改 `App.tsx`
   - 添加 `handleEditAndResend(messageId, newContent)`
   - 处理删除后续消息的逻辑
6. [ ] 修改 `store.ts`
   - 添加 `feedback` 状态切片
7. [ ] 修改 `database.ts`
   - 新增 `message_feedback` 表
8. [ ] 修改 `lang.ts`
   - 添加所有新功能的翻译键
9. [ ] 编写单元测试
   - `deleteMessagesAfter` 测试
   - `saveFeedback` / `loadFeedback` 测试
   - `InlineMessageEdit` 组件测试
10. [ ] 编写 E2E 测试
    - 行内编辑流程测试
    - 反馈按钮流程测试

**验收标准：**
- [ ] 用户消息 hover 时显示"编辑"按钮
- [ ] 点击编辑后进入编辑模式，textarea 自动聚焦
- [ ] 修改后点击确认，后续消息被删除，对话重新执行
- [ ] 点击取消，恢复原始消息
- [ ] 点击 👍/👎，状态保存到 localStorage
- [ ] 刷新页面后反馈状态保持

#### Sprint 2: 滚动条标记 + 回到底部指示器（Week 3-4）

**目标：** 实现滚动条标记和回到底部功能

**任务清单：**
1. [ ] 创建 `ScrollbarMarkers.tsx` 组件
   - 监听 messages 变化
   - 计算每个用户消息的滚动位置
   - 渲染小圆点标记
   - 点击标记跳转逻辑
2. [ ] 创建 `ScrollToBottomIndicator.tsx` 组件
   - 监听 scroll 状态
   - 显示"回到底部"按钮
   - 点击平滑滚动逻辑
3. [ ] 创建 `useScrollState.ts` hook
   - 监听滚动容器滚动事件
   - 更新 store.scrollState
   - 检测是否在底部
4. [ ] 修改 `ChatPanel.tsx`
   - 集成 ScrollbarMarkers
   - 集成 ScrollToBottomIndicator
   - 添加滚动事件监听
5. [ ] 修改 `store.ts`
   - 添加 `scrollState` 状态
6. [ ] 创建 `scroll-utils.ts`
   - `calculateMessagePosition`
   - `scrollToMessage`
7. [ ] 修改 CSS
   - ScrollbarMarkers 样式
   - ScrollToBottomIndicator 样式
8. [ ] 编写单元测试
   - `useScrollState` 测试
   - `calculateMessagePosition` 测试
9. [ ] 编写 E2E 测试
   - 滚动条标记点击测试
    - 回到底部按钮点击测试

**验收标准：**
- [ ] 滚动条右侧显示小圆点标记（每个用户消息一个）
- [ ] 点击标记，平滑滚动到对应消息位置
- [ ] 用户向上滚动后显示"回到底部"按钮
- [ ] 新消息到达时按钮闪烁提醒
- [ ] 点击按钮，平滑滚动到底部

---

### 📱 P1 - 高级对话功能（Q2，预计 6 周）

#### Sprint 3: Correction 模式（Week 5-6）

**目标：** 实现事实核查模式

**任务清单：**
1. [ ] 创建 `CorrectionModeToggle.tsx` 组件
   - 开关按钮
   - 会话级配置持久化
2. [ ] 创建 `CorrectionResultPanel.tsx` 组件
   - 左右分屏对比
   - 差异高亮（使用 DiffViewer）
   - 应用修正/保留原回复按钮
3. [ ] 创建 `fact-check.ts` 工具
   - 调用 Correction 模型
   - 返回修正建议
4. [ ] 修改 `agentic-loop.ts`
   - 支持 `correction` 模式
   - 处理 `correction_complete` 事件
5. [ ] 修改 `sessions` 表
   - 添加 `correction_mode` 字段
6. [ ] 修改 `store.ts`
   - 添加 `correctionMode` 状态
7. [ ] 修改 `settings.ts`
   - 添加 Correction 模型配置
8. [ ] 编写单元测试
   - `fact-check` 工具测试
   - `CorrectionResultPanel` 组件测试
9. [ ] 编写 E2E 测试
   - Correction 模式流程测试

**验收标准：**
- [ ] 开启 Correction 模式后，AI 回复完成时触发事实核查
- [ ] 显示对比面板，标记差异部分
- [ ] 用户选择"应用修正"，更新消息内容
- [ ] 用户选择"保留原回复"，保持原内容
- [ ] 模式开关状态持久化

#### Sprint 4: 澄清表单（Week 7-8）

**目标：** 实现交互式澄清表单

**任务清单：**
1. [ ] 创建 `ask-clarification.ts` 工具
   - 定义工具 schema
   - 返回表单结构
2. [ ] 创建 `ClarificationForm.tsx` 组件
   - 支持单选/多选/文本输入
   - 表单验证
   - 提交逻辑
3. [ ] 修改 `agentic-loop.ts`
   - 处理 `clarification` 事件
   - 等待用户填写表单
   - 格式化答案为 Markdown
4. [ ] 扩展 LoopEvent 类型
   - 添加 `clarification` 事件
5. [ ] 修改 `types.ts`
   - 添加 `ClarificationForm` 类型
   - 添加 `ClarificationAnswer` 类型
6. [ ] 编写单元测试
   - `ask-clarification` 工具测试
   - `ClarificationForm` 组件测试
7. [ ] 编写 E2E 测试
   - 澄清表单流程测试

**验收标准：**
- [ ] AI 调用 `ask_clarification` 工具后，UI 渲染表单
- [ ] 用户填写表单，点击提交
- [ ] 答案格式化为 Markdown 消息发回 AI
- [ ] AI 基于答案继续生成回复
- [ ] 表单支持必答验证

#### Sprint 5: Workbench 代码工作台（Week 9-10）

**目标：** 实现可视化代码工作台

**任务清单：**
1. [ ] 创建 `Workbench.tsx` 组件
   - 浮动侧边栏布局
   - 折叠/展开逻辑
2. [ ] 集成 `DiffViewer` 组件
   - Git diff 显示
   - 文件级 + 行级 diff
3. [ ] 实现文件树视图
   - 读取当前工作区文件
   - 文件图标 + 文件名
   - 展开折叠逻辑
4. [ ] 实现提交统计面板
   - Commit 历史列表
   - 修改文件数统计
   - 增删行数统计
5. [ ] 监听工具执行状态
   - 实时更新工作台
   - 显示当前执行的工具
6. [ ] 修改 `ChatPanel.tsx`
   - 集成 Workbench
7. [ ] 编写单元测试
   - `Workbench` 组件测试
   - 文件树渲染测试
8. [ ] 编写 E2E 测试
   - Workbench 展开/折叠测试
   - Git diff 显示测试

**验收标准：**
- [ ] 浮动侧边栏在 ChatPanel 右侧显示
- [ ] 点击展开按钮，显示 Git diff、文件树、提交统计
- [ ] 工具执行时实时更新状态
- [ ] 点击文件树中的文件，在编辑器中打开
- [ ] 点击折叠按钮，隐藏工作台

#### Sprint 6: TodoList 展示 + 引导展示块（Week 11-12）

**目标：** 实现 Todo 列表可视化和引导消息展示

**任务清单：**
1. [ ] 创建 `TodoListDisplay.tsx` 组件
   - 待办/进行中/已完成 分组显示
   - 勾选完成逻辑
   - 拖拽排序（可选）
2. [ ] 创建 `show-todo.ts` 工具
   - 定义工具 schema
   - 触发 `todo_list_created` 事件
3. [ ] 创建 `GuidanceBlock.tsx` 组件
   - 折叠面板样式
   - 显示已注入的引导消息
4. [ ] 修改 `agentic-loop.ts`
   - 处理 `todo_list_created` 事件
   - 传递 guidanceId 到 UI
5. [ ] 修改 `database.ts`
   - 添加 `todo_lists` 表
6. [ ] 修改 `message.ts`
   - 实现 `saveTodoList`
   - 实现 `loadTodoList`
7. [ ] 修改 `store.ts`
   - 添加 `todoLists` 状态
8. [ ] 编写单元测试
   - `show-todo` 工具测试
   - `TodoListDisplay` 组件测试
9. [ ] 编写 E2E 测试
   - Todo 列表展示测试
   - 引导消息展示测试

**验收标准：**
- [ ] AI 调用 `show_todo` 工具后，UI 渲染 Todo 列表
- [ ] 用户点击勾选，状态更新
- [ ] 引导消息在折叠面板中显示
- [ ] 点击展开/折叠，显示/隐藏引导消息

---

### 🚀 P2 - 用户体验提升（Q3，预计 6 周）

#### Sprint 7: 快速访问卡片（Week 13-14）

**目标：** 实现 Agent 快速切换卡片

**任务清单：**
1. [ ] 创建 `QuickAccessCards.tsx` 组件
   - 卡片网格布局
   - Agent 名称 + 描述
   - 收藏功能
   - 拖拽排序（可选）
   - 搜索过滤
2. [ ] 修改 `AgentManager.tsx`
   - 集成 QuickAccessCards
3. [ ] 修改 `store.ts`
   - 添加 `favoriteAgents` 状态
4. [ ] 修改 `settings.ts`
   - 保存收藏的 Agent 列表
5. [ ] 编写单元测试
   - `QuickAccessCards` 组件测试
6. [ ] 编写 E2E 测试
   - Agent 切换测试
   - 收藏功能测试

**验收标准：**
- [ ] 显示常用 Agent 卡片网格
- [ ] 点击卡片，快速切换 Agent
- [ ] 点击收藏按钮，添加/移除收藏
- [ ] 搜索输入框，过滤卡片
- [ ] 拖拽卡片，调整顺序（可选）

#### Sprint 8: 任务输入快捷短语（Week 15-16）

**目标：** 实现模板化输入

**任务清单：**
1. [ ] 创建 `QuickPhraseSelector.tsx` 组件
   - 快捷短语列表
   - 分类显示
   - 点击插入输入框
2. [ ] 修改 `InputArea.tsx`
   - 集成 QuickPhraseSelector
   - 快捷键触发（如 `Ctrl+P`）
3. [ ] 修改 `database.ts`
   - 添加 `quick_phrases` 表
4. [ ] 修改 `settings.ts`
   - 实现 `saveQuickPhrase`
   - 实现 `loadQuickPhrases`
   - 实现 `deleteQuickPhrase`
5. [ ] 添加默认快捷短语
   - "帮我写一个 RESTful API"
   - "帮我写单元测试"
   - "帮我审查代码"
6. [ ] 编写单元测试
   - `QuickPhraseSelector` 组件测试
   - 快捷短语 CRUD 测试
7. [ ] 编写 E2E 测试
   - 快捷短语选择测试
   - 快捷键触发测试

**验收标准：**
- [ ] 点击快捷短语按钮，显示快捷短语列表
- [ ] 点击短语，插入到输入框
- [ ] 快捷键 `Ctrl+P` 触发快捷短语选择器
- [ ] 支持自定义添加/删除快捷短语
- [ ] 快捷短语按分类显示

#### Sprint 9: Prompt Draft + Optimization（Week 17-18）

**目标：** 实现提示词草稿版本管理和优化建议

**任务清单：**
1. [ ] 创建 `PromptDraftPicker.tsx` 组件
   - 草稿版本列表
   - 版本对比视图
   - 选择版本加载到输入框
2. [ ] 创建 `prompt-draft.ts` 存储模块
   - 实现 `savePromptDraft`
   - 实现 `loadPromptDrafts`
   - 实现 `deletePromptDraft`
   - 实现 `comparePromptDrafts`
3. [ ] 创建 `prompt-optimization.ts` 模块
   - 分析 Prompt 质量
   - 生成优化建议
   - A/B 测试对比
4. [ ] 修改 `database.ts`
   - 添加 `prompt_drafts` 表
5. [ ] 修改 `InputArea.tsx`
   - 集成 PromptDraftPicker
   - 支持保存草稿
6. [ ] 编写单元测试
   - `PromptDraftPicker` 组件测试
   - Prompt 版本对比测试
7. [ ] 编写 E2E 测试
   - 草稿保存/加载测试
   - 版本对比测试

**验收标准：**
- [ ] 输入框下方显示"保存草稿"按钮
- [ ] 点击保存，保存当前输入为草稿
- [ ] 点击"加载草稿"，显示草稿列表
- [ ] 选择草稿，加载到输入框
- [ ] 支持版本对比，显示差异
- [ ] 提供 Prompt 优化建议

---

### 🎨 P3-P4 - 多媒体与高级功能（Q4，预计 6 周）

#### Sprint 10: 多模态图片预览（Week 19-20）

**目标：** 实现图片缩略图预览画廊

**任务清单：**
1. [ ] 创建 `ImageGallery.tsx` 组件
   - 图片缩略图网格
   - 点击放大预览
   - 左右切换
2. [ ] 修改 `MessageBubble.tsx`
   - 检测图片附件
   - 渲染 ImageGallery
3. [ ] 修改 `MessageAttachment` 类型
   - 支持图片类型
4. [ ] 编写单元测试
   - `ImageGallery` 组件测试
5. [ ] 编写 E2E 测试
   - 图片预览测试

**验收标准：**
- [ ] 消息中的图片显示为缩略图
- [ ] 点击缩略图，放大预览
- [ ] 左右切换图片
- [ ] 支持下载图片

#### Sprint 11: 视频配置/预览（Week 21-22）

**目标：** 实现视频生成模式配置和播放器

**任务清单：**
1. [ ] 创建 `VideoPlayer.tsx` 组件
   - 视频播放器
   - 控制按钮
2. [ ] 创建 `VideoConfigBadge.tsx` 组件
   - 显示视频配置（分辨率、时长等）
3. [ ] 创建 `VideoInputControls.tsx` 组件
   - 视频参数输入控件
4. [ ] 修改 `InputArea.tsx`
   - 集成 VideoInputControls
5. [ ] 编写单元测试
   - `VideoPlayer` 组件测试
6. [ ] 编写 E2E 测试
   - 视频播放测试

**验收标准：**
- [ ] 输入框显示视频配置控件
- [ ] 设置分辨率、时长等参数
- [ ] AI 生成视频后，显示 VideoPlayer
- [ ] 播放、暂停、进度条控制

#### Sprint 12: 高级功能集成（Week 23-24）

**目标：** 集成其余高级功能（可选）

**任务清单：**
1. [ ] `ForwardButton.tsx` - 消息前向转发
2. [ ] `ContextBadgeList.tsx` - 上下文徽章
3. [ ] `SourceReferences.tsx` - 知识来源引用
4. [ ] `MentionAutocomplete.tsx` - @ 提及自动补全
5. [ ] `SkillAutocomplete.tsx` - 技能自动补全
6. [ ] `SourceSelector.tsx` - 知识库来源选择器
7. [ ] `OnboardingTour.tsx` - 新手引导
8. [ ] `StreamingWaitIndicator.tsx` - 分阶段等待提示
9. [ ] `useStreamingJoinWarning.ts` - 流式加入警告
10. [ ] `useQueuedRuntimeHealthCheck.ts` - 队列健康检查

**验收标准：**
- [ ] 所有组件按需求文档实现
- [ ] 集成测试通过
- [ ] 用户体验符合预期

---

## 📝 开发规范与注意事项

### 1. 命名规范

**禁止使用 "codex" 字样：**
- ❌ `CodexMessageEdit.tsx`
- ✅ `InlineMessageEdit.tsx`

**函数命名：**
- 组件：`PascalCase`，如 `ScrollbarMarkers`
- Hook：`useCamelCase`，如 `useMessageFeedback`
- 工具函数：`camelCase`，如 `calculateMessagePosition`
- 工具：`kebab-case`，如 `ask_clarification`

### 2. 类型安全

**所有新功能必须定义完整的 TypeScript 类型：**
```typescript
// ✅ 正确
export interface ClarificationForm {
  question: string;
  type: "radio" | "checkbox" | "text";
  options?: string[];
  required: boolean;
}

// ❌ 错误
export type ClarificationForm = any;
```

### 3. 国际化支持

**所有 UI 文本必须支持中英双语：**
```typescript
// src/core/i18n/lang.ts
export const S = {
  bubble: {
    edit: { zh: "编辑", en: "Edit" },
    save: { zh: "保存", en: "Save" },
    cancel: { zh: "取消", en: "Cancel" },
  },
};
```

### 4. 测试覆盖

**每个新功能必须包含：**
- 单元测试（覆盖率 > 80%）
- E2E 测试（关键流程）

**测试文件命名：**
- 单元测试：`xxx.test.ts`
- E2E 测试：`xxx.e2e.test.ts`

### 5. 代码审查

**提交前必须检查：**
- [ ] 命名规范
- [ ] 类型定义完整
- [ ] 国际化支持
- [ ] 测试通过
- [ ] 文档更新

### 6. 性能优化

**注意事项：**
- 使用 `useMemo` 缓存计算结果
- 使用 `useCallback` 缓存事件处理器
- 避免在渲染循环中创建新对象
- 使用 `React.memo` 优化组件重渲染

### 7. 可访问性

**确保：**
- 所有按钮有 `title` 或 `aria-label`
- 键盘导航支持（Tab 键）
- 屏幕阅读器友好

---

## 📊 实施时间表

```
Q1 (4周)  | Q2 (6周)  | Q3 (6周)  | Q4 (6周)
━━━━━━━━━|━━━━━━━━━|━━━━━━━━━|━━━━━━━━
P0        | P1       | P2       | P3-P4
Sprint 1  | Sprint 3 | Sprint 7 | Sprint 10
Sprint 2  | Sprint 4 | Sprint 8 | Sprint 11
          | Sprint 5 | Sprint 9 | Sprint 12
          | Sprint 6 |          |
```

---

## ✅ 总结

本方案详细分析了实现 38 项缺失功能所需的：

1. **文件修改清单**：28 个核心文件修改 + 30+ 个新增组件
2. **交互方式变更**：4 个 P0 核心交互 + 8 个 P1 高级交互
3. **存储架构改造**：4 个新增表 + 2 个扩展表 + 10+ 新增 API
4. **消息通信机制影响**：4 个新 LoopEvent 类型 + 3 个新工具 + AgenticLoop 行为变更

**核心建议：**
- 优先实现 P0 功能（4 周），这些是用户感知最强的体验改进点
- 按照分阶段实施计划逐步迭代，确保每个 Sprint 有明确的验收标准
- 严格遵循开发规范，确保代码质量和可维护性

---

*本文档将随着实施进展实时更新。*