# 第2章：上下文工程

> 上下文决定能力上限：KV Cache、提示工程、Agent Skills、上下文压缩

---

## 2.1 上下文是什么？

### 定义

上下文（Context）是 LLM 在一次推理中能"看到"的全部信息。它决定了 Agent 的能力上限——**模型再强，看不到的信息也用不了**。

上下文的组成：

```
┌─────────────────────────────────────────┐
│              LLM 上下文窗口               │
├─────────────────────────────────────────┤
│  1. System Prompt（系统提示词）           │
│     - Agent 身份/角色                     │
│     - 用户偏好                            │
│     - 项目指令                            │
│     - 技能指令                            │
│     - MCP 工具描述                        │
│     - 知识库上下文（RAG）                  │
│     - Git/环境信息                        │
│  2. 对话历史（Messages）                  │
│     - 用户消息                            │
│     - AI 回复                             │
│     - 工具调用及结果                       │
│  3. 上下文压缩标记（Compaction Marker）     │
│     - 历史对话的 LLM 摘要                  │
│  4. 记忆指令（Memory Instructions）        │
│     - 跨会话提取的用户记忆                  │
└─────────────────────────────────────────┘
```

### 行业主流做法

| 框架 | 上下文管理策略 |
|------|--------------|
| OpenAI Codex | 自动截断 + 滑动窗口 |
| Claude | 200K 窗口 + prompt caching |
| LangChain | ConversationBufferMemory / ConversationSummaryMemory |
| Cursor | 代码库索引 + 语义检索注入 |

---

## 2.2 KV Cache

### 机制

KV Cache 是 LLM 推理引擎的底层优化。当 LLM 处理一段文本时，每一层的 Attention 机制会计算 Key 和 Value 矩阵。如果前缀不变，这些矩阵可以缓存复用，避免重复计算。

**对我们的影响**：
- System Prompt 在整个会话中不变 → 前缀稳定 → 可被 KV Cache 命中
- 对话历史追加在末尾 → 前缀不变 → 增量推理高效
- 上下文压缩会改变前缀 → **KV Cache 失效** → 需要全量重算

### 我们怎么做的

我们的 System Prompt 构建**保证前缀稳定性**：

```typescript
// src/core/prompt/prompt.ts

export function buildSystemPrompt(config: SystemPromptConfig): string {
  const sections: string[] = [];

  // 1. 核心身份（固定前缀，KV Cache 友好）
  sections.push(`# ${name}\n${identity}...`);
  
  // 2. 用户偏好（固定）
  sections.push(userInstructions);
  
  // 3. 项目指令（固定）
  sections.push(projectInstructions);
  
  // 4. 技能指令（固定，只在选择技能时变化）
  sections.push(skillInstructions);
  
  // 5. 知识库上下文（动态，放在后面，不影响前面前缀）
  sections.push(knowledgeContext);
  
  // 6. 日期/环境信息（动态，放在最后）
  sections.push(date);
  
  return sections.join('\n\n');
}
```

**策略**：固定内容在前，动态内容在后。最大化 KV Cache 命中率。

---

## 2.3 提示工程

### 上下文结构

我们的 System Prompt 包含以下分层（按顺序拼接）：

| 层级 | 内容 | 变化频率 | Token 占用 |
|------|------|---------|-----------|
| 1 | 核心身份 + 角色 | 极低（固定） | ~200 |
| 2 | 语言规则 | 极低 | ~100 |
| 3 | 用户偏好 | 低 | ~100 |
| 4 | 项目指令 (.codem-instructions) | 中 | ~500 |
| 5 | 技能指令 (Skills) | 中（用户选择时） | ~1000-5000 |
| 6 | MCP 工具描述 | 中 | ~500 |
| 7 | 记忆指令 | 中 | ~300 |
| 8 | 知识库 RAG 上下文 | 高（每轮检索） | ~2000-8000 |
| 9 | Git/环境信息 | 高 | ~200 |
| 10 | 日期 | 高 | ~50 |

**总 System Prompt Token**：约 5000-15000（不含对话历史）

### Token 消耗与准确性取舍

**核心矛盾**：上下文越多 → 信息越全 → 准确性越高，但 token 消耗也越大。

我们的取舍策略：

| 上下文组件 | 最大 Token | 截断策略 | 准确性影响 |
|-----------|-----------|---------|-----------|
| 技能指令 | 5000/skill | 完整保留 | 高：截断会丢失关键指令 |
| RAG 检索 | 8000 | Top-K 片段，每片段 2000 字 | 中：片段质量决定准确性 |
| 对话历史 | 不限（动态压缩） | 见 2.5 上下文压缩 | 高：历史是推理基础 |
| 记忆指令 | 300 | 每条 50 字，最多 6 条 | 中：摘要性，不怕截断 |
| 工具描述 | 500/工具 | 完整保留 | 高：截断会导致工具误用 |

> **[配图位]**：上下文窗口 Token 分配饼图，展示各组件占比

---

## 2.4 Agent Skills

### 作用机制

Skills 是**可注入的上下文增强模块**。用户通过 `/skillname` 或菜单选择技能后，技能的 prompt 会被注入到 System Prompt 中。

```typescript
// src/core/skill/skill.ts

export interface SkillDefinition {
  name: string;
  prompt: string;           // 技能的指令文本
  references?: string[];    // 参考文件路径
  contextMode: "inline" | "fork";  // inline=注入主上下文, fork=独立会话
  whenToUse?: string;       // 自动检测条件
  allowedTools?: string[];  // 技能允许使用的工具
}
```

### 加载机制

```
用户输入 /mermaid → 匹配到 "mermaid-diagram" 技能
  → 读取技能 prompt（可能来自内置 SKILL.md 或项目 .codem/skills/）
  → 注入到 System Prompt 的 skillInstructions 段落
  → 后续所有 LLM 调用都包含此技能指令
  → 用户发送消息后，技能指令生效
```

**两种上下文模式**：
- `inline`：技能 prompt 直接注入主对话上下文（低成本，但占 token）
- `fork`：技能创建独立子会话（上下文隔离，但需要 spawn_subagent）

---

## 2.5 上下文压缩（Context Compaction）

### 机制

当上下文压力超过阈值时，自动触发压缩：
1. 保留最近 N 条消息（默认 20 条）
2. 将更早的消息交给 LLM 生成摘要
3. 删除旧消息，插入压缩标记
4. 后续推理基于"摘要 + 最近消息"

### 我们的实现

```typescript
// src/core/llm/agentic-loop.ts

private async compactMessages(sessionId: string): Promise<number> {
  const messages = MessageStorage.listMessages(sessionId);
  
  // 保留最近 20 条
  const keepCount = Math.min(20, messages.length);
  const messagesToKeep = messages.slice(-keepCount);
  const messagesToRemove = messages.slice(0, -keepCount);
  
  // 检查是否已有旧的压缩标记（级联压缩）
  let existingSummary = "";
  const oldMarkerIdx = messagesToRemove.findIndex(
    m => m.role === "user" && m.content.startsWith("[上下文已自动压缩]")
  );
  if (oldMarkerIdx >= 0) {
    existingSummary = messagesToRemove[oldMarkerIdx].content;
    // 旧摘要也会被纳入新摘要
  }
  
  // LLM 生成摘要（含旧摘要的级联）
  summary = await this.generateCompactionSummary(
    conversationText,    // 旧消息文本
    existingSummary      // 之前的摘要（如果有）
  );
  
  // 删除旧消息，插入压缩标记
  MessageStorage.deleteMessagesByIds(removedIds);
  MessageStorage.createMessage({
    content: `[上下文已自动压缩]\n\n${summary}\n\n---\n已移除 ${count} 条旧消息，保留最近 ${keepCount} 条。`,
    role: "user",
  }, sessionId);
}
```

### 触发条件

```typescript
// 主动压缩：上下文压力 > 80%
if (this.state.contextPressure > this.config.compactionThreshold) {
  yield { type: "compaction_start" };
  const compacted = await this.compactMessages(sessionId);
  yield { type: "compaction_end", messagesRemoved: compacted };
}

// 反应式压缩：API 返回 context_length_exceeded 错误
// 立即压缩后重试
```

### 级联压缩

当对话很长时，会多次触发压缩。每次压缩时：
- 新摘要 = LLM 总结(旧消息文本 + 旧摘要)
- 旧摘要被纳入新摘要，形成**级联摘要链**
- 防止无限循环：最多连续 3 次压缩

> **[配图位]**：上下文压缩时序图，展示 消息队列 → 阈值检测 → LLM 摘要 → 标记插入 的流程

---

## 2.6 行业对比与我们的取舍

| 维度 | 行业主流 | 我们 | 理由 |
|------|---------|------|------|
| 上下文窗口管理 | 滑动窗口截断 | LLM 摘要压缩 | 保留语义信息，不只截断 |
| 压缩触发 | 固定 token 数 | 动态 contextPressure 80% | 适应不同模型窗口 |
| 级联压缩 | 递归摘要 | 旧摘要纳入新摘要 | 避免信息完全丢失 |
| KV Cache 优化 | prompt caching API | 前缀稳定性排列 | 无需 API 支持，通用 |
| 技能上下文 | 固定注入 | inline + fork 双模式 | 灵活控制 token 成本 |
| 防无限压缩 | 无 | 最多 3 次连续压缩 | 防止死循环 |

### 我们的优势

1. **LLM 摘要 > 简单截断**：保留语义连续性，Agent 不会"忘记"之前做了什么
2. **级联压缩**：多次压缩不会完全丢失早期信息
3. **反应式压缩**：API 报 context 超限时自动压缩重试，用户无感知

### 我们的取舍

1. **压缩有 LLM 调用成本**：每次压缩需要一次额外的 LLM 调用（用 compaction 槽位的便宜模型）
2. **摘要可能失真**：LLM 摘要可能遗漏细节，不如原始消息精确
3. **保留条数固定 20**：没有根据消息大小动态调整

---

## 2.7 核心代码导航

| 文件 | 职责 |
|------|------|
| `src/core/prompt/prompt.ts` | System Prompt 构建、分层拼接 |
| `src/core/llm/agentic-loop.ts` | 上下文压力检测、压缩触发、级联摘要 |
| `src/core/llm/index.ts` | buildSystemPromptAsync() 异步构建含知识库上下文 |
| `src/core/skill/skill.ts` | 技能定义、加载、注入 |

---

## 小结

> 上下文 = System Prompt + 对话历史 + 压缩标记 + 记忆指令
> KV Cache 友好 = 固定内容在前，动态内容在后
> 上下文压缩 = LLM 摘要（非简单截断）+ 级联摘要 + 反应式重试
> Token 取舍 = 技能/工具完整保留，RAG/记忆可截断
