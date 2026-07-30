# 第3章：用户记忆和知识库

> 跨会话记住用户、接入外部知识：用户记忆、RAG、结构化索引、知识图谱

---

## 3.1 记忆原理

### 为什么需要记忆？

LLM 是无状态的——每次对话开始，它不记得你是谁、你喜欢什么、你的项目用什么技术栈。记忆系统解决的就是这个问题：**跨会话持久化关键信息**。

### 记忆的四个层次

| 层次 | 类型 | 持久化 | 检索方式 | 我们的实现 |
|------|------|--------|---------|-----------|
| 1 | 短期记忆 | 会话内 | 完整对话历史 | 消息存储 + 上下文压缩 |
| 2 | 用户记忆 | 跨会话 | 关键词注入 System Prompt | Memory 模块 |
| 3 | 知识库 (RAG) | 跨会话 | 语义检索 Top-K 片段 | Notebook + Embedding |
| 4 | 结构化索引 | 跨会话 | 实体/关系查询 | 知识图谱提取器 |

---

## 3.2 用户记忆（Memory）

### 作用

用户记忆是从对话中自动提取的**长期事实**，在后续会话中注入 System Prompt。

提取的记忆类型：
- 用户偏好（语言、代码风格、工具选择）
- 项目架构决策（技术栈、目录结构、设计模式）
- 环境信息（操作系统、开发工具、运行时版本）
- 常见问题和解决方案
- 重要的项目约定或规则

### 行业主流做法

| 框架 | 记忆机制 | 存储方式 |
|------|---------|---------|
| ChatGPT | Memory 功能 | 服务端 KV 存储 |
| LangChain | ConversationSummaryMemory | 向量数据库 |
| MemGPT | 分层记忆系统 | SQLite + 向量 |
| Cursor | 项目级 .cursorrules | 文件 |

### 我们的实现

#### 记忆提取

```typescript
// src/core/llm/index.ts

async extractMemoriesFromSession(sessionId: string): Promise<void> {
  // 1. 检查是否启用记忆
  if (!this.isMemoryEnabled(sessionId)) return;
  
  // 2. 只在对话够长时提取（≥10 条消息）
  const messages = MessageStorage.listMessages(sessionId);
  if (messages.length < 10) return;
  
  // 3. 用 "memory" 槽位的便宜模型提取
  const resolved = this.resolveSlot("memory");
  const provider = this.providers.get(resolved.providerId);
  
  // 4. 构建对话文本（限制最近 50 条，每条 300 字，总计 ≤8000 字）
  const recentMessages = messages.slice(-50);
  // ... 截断处理 ...
  
  // 5. LLM 提取记忆（JSON 格式输出）
  const systemPrompt = `你是一个记忆提取专家。从以下对话中提取值得长期记住的事实。
    只提取：用户偏好、项目架构决策、环境信息、常见问题、项目约定。
    输出格式：[{"key": "简短标题", "content": "具体内容", "tags": ["标签"]}]`;
  
  const response = await provider.complete({
    model: resolved.modelId,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: conversationText },
    ],
    temperature: 0.3,  // 低温度 = 提取更稳定
  });
  
  // 6. 解析 JSON、存储、合并去重
  const memories = extractJSON(response.content);
  // ... 保存到 SQLite ...
}
```

#### 记忆注入

```typescript
// src/core/prompt/prompt.ts

// System Prompt 中的记忆段
if (config.memoryInstructions) {
  sections.push(`## Memory\n\n${config.memoryInstructions}`);
}
```

#### 记忆合并与去重

```typescript
// src/core/memory/memory.ts

// F3.1: 跨会话记忆合并
// 当多个会话提取了相似记忆时，用 LLM 合并去重
export async function consolidateMemories(projectId: string): Promise<void> {
  // 1. 按项目加载所有记忆
  // 2. 用 LLM 检查相似/重复的记忆
  // 3. 合并相似记忆，删除冗余
}
```

#### 触发时机

- **上下文压缩后**：`onCompactionComplete` 回调触发记忆提取
- **每轮对话完成后**：`onTurnComplete` 回调触发记忆提取

> **[配图位]**：记忆提取与注入流程图，展示 对话 → LLM 提取 → SQLite 存储 → 下次会话注入 System Prompt

---

## 3.3 RAG（检索增强生成）

### 作用

RAG 让 Agent 能访问**项目外部知识**——文档、笔记、网页内容。通过语义检索找到与当前问题相关的知识片段，注入到上下文中。

### 行业主流做法

| 框架 | RAG 方式 | Embedding | 检索 |
|------|---------|-----------|------|
| ChatGPT | 文件上传 + 自动检索 | text-embedding-3 | 余弦相似度 |
| Cursor | 代码库语义索引 | 自研 | 混合检索 |
| LangChain | VectorStore + Retriever | OpenAI | MMR/相似度 |
| perplexity | 实时网页搜索 | 不公开 | 重排 |

### 我们的实现

#### 数据流

```
用户上传文档到 Notebook
  → 文档分块（chunking，每块 ~2000 字符）
  → 每块生成 Embedding 向量
  → 向量 + 文本存储到 SQLite（或本地 ONNX 模型）

用户提问
  → 问题生成 Embedding
  → 余弦相似度检索 Top-K 片段（默认 K=5）
  → 片段拼接为 context 文本
  → 注入 System Prompt 的 knowledgeContext 段
```

#### Embedding 双模式

```typescript
// src/core/llm/multimodal.ts

// 模式1: 远程 API（OpenAI / Gemini）
{
  providerId: "openai",
  apiKey: "...",
  model: "text-embedding-3-small",
}

// 模式2: 本地 ONNX Runtime（默认，无需 API Key）
// 模型: Xenova/all-MiniLM-L6-v2（23MB，多语言）
```

**默认使用本地模型**——零成本、隐私安全、离线可用。

#### 检索实现

```typescript
// src/core/knowledge/retriever.ts

export async function retrieveWithContext(
  query: string,
  notebookId: string,
): Promise<{ context: string; sources: RetrievalResult[] }> {
  // 1. 生成查询向量
  const queryEmbedding = await embed(query, notebookId);
  
  // 2. 检索 Top-K 相似片段
  const results = await retrieve(query, notebookId);
  
  // 3. 拼接为上下文文本（带来源标记）
  const contextParts = results.map((r, i) => 
    `--- 检索片段 ${i + 1} (来源: ${r.sourceName}) ---\n${r.content}`
  );
  
  return { context: contextParts.join('\n\n---\n\n'), sources: results };
}
```

#### 自动检索

每轮对话开始时，**自动用用户消息检索知识**：

```typescript
// src/core/llm/index.ts (process 方法)

if (options?.notebookId) {
  const { retrieveWithContext } = await import("../knowledge/retriever");
  const { context, sources } = await retrieveWithContext(message, options.notebookId);
  // 注入到 System Prompt
  knowledgeContext = {
    notebookName: notebook.name,
    retrievedContext: context,
    retrievedSources: sources.map(s => ({ name: s.sourceName, score: s.score })),
  };
}
```

> **[配图位]**：RAG 检索流程图，展示 文档 → 分块 → Embedding → SQLite → 查询 → Top-K → 注入

---

## 3.4 结构化索引与知识图谱

### 结构化索引

我们的知识库支持结构化存储：
- **源文件管理**：每个上传的文档作为一个 Source，有 ID、名称、类型
- **分块管理**：每个 Source 被分成多个 Chunk，有 chunkIndex
- **向量索引**：每个 Chunk 对应一个 Embedding 向量

```typescript
// src/core/knowledge/types.ts

interface Source {
  id: string;
  name: string;
  type: "file" | "url" | "text";
  notebookId: string;
  chunkCount: number;
}

interface Chunk {
  id: string;
  sourceId: string;
  content: string;
  embedding: number[];
  chunkIndex: number;
}
```

### 知识图谱

我们有一个知识图谱提取器，从文档中提取实体和关系：

```
文档 → LLM 提取实体（人物/概念/项目）和关系
  → 存储为图结构（节点 + 边）
  → 支持图查询（路径查找、关联分析）
  → 可视化展示
```

```typescript
// src/core/knowledge/graph-extractor.ts
// 从知识库内容中提取实体和关系，构建知识图谱
```

### 各组件如何协作

```
用户提问："我们项目用什么测试框架？"
  │
  ├── RAG 检索：在知识库中搜索 "测试框架" → 找到相关文档片段
  │     → 注入到上下文
  │
  ├── 用户记忆：检查是否有 "测试框架偏好" 的记忆
  │     → 注入到 System Prompt
  │
  ├── 知识图谱：查找 "测试框架" 实体的关联关系
  │     → 可能找到 "项目A → 使用 → Jest" 的边
  │
  └── Agent 综合以上信息生成回复
```

---

## 3.5 行业对比与我们的取舍

| 维度 | 行业主流 | 我们 | 理由 |
|------|---------|------|------|
| 记忆存储 | 向量数据库 | SQLite + JSON | 零依赖、本地优先 |
| 记忆提取 | 手动标注 | LLM 自动提取 + 去重 | 用户无感知 |
| Embedding | 远程 API | 本地 ONNX 默认 + 远程可选 | 隐私 + 离线 |
| 检索方式 | 纯向量 | 向量 + 来源过滤 | 精准控制检索范围 |
| 知识图谱 | 图数据库 | LLM 提取 + 本地存储 | 轻量级 |

### 我们的优势

1. **本地优先**：默认使用本地 Embedding 模型，无需 API Key，隐私安全
2. **自动记忆提取**：用户无需手动操作，LLM 在压缩和每轮后自动提取
3. **记忆合并去重**：跨会话的记忆不会无限膨胀
4. **知识图谱可视化**：支持图形化展示知识关联

### 我们的取舍

1. **本地 Embedding 精度不如远程**：23MB 的 MiniLM 比 text-embedding-3-small 精度低
2. **记忆提取有 LLM 成本**：每次提取需要一次便宜的 LLM 调用
3. **知识图谱是静态提取**：不是实时更新的，需要手动触发重新提取

---

## 3.6 核心代码导航

| 文件 | 职责 |
|------|------|
| `src/core/memory/memory.ts` | 记忆 CRUD、跨会话合并、consolidateMemories |
| `src/core/llm/index.ts` | extractMemoriesFromSession()、记忆注入编排 |
| `src/core/knowledge/retriever.ts` | retrieveWithContext()、Top-K 检索 |
| `src/core/knowledge/storage.ts` | 知识库 CRUD、Source/Chunk 管理 |
| `src/core/knowledge/indexer.ts` | 文档分块、Embedding 生成 |
| `src/core/knowledge/graph-extractor.ts` | 知识图谱实体关系提取 |
| `src/core/llm/multimodal.ts` | Embedding 双模式（本地/远程）配置 |

---

## 小结

> 用户记忆 = LLM 自动提取 + 跨会话合并去重 + System Prompt 注入
> RAG = 文档分块 → Embedding → 向量检索 → Top-K 注入
> 默认本地 Embedding = 隐私安全 + 离线可用 + 零成本
> 知识图谱 = LLM 提取实体关系 → 图结构存储 → 可视化
> 协作 = RAG 提供即时知识 + 记忆提供长期偏好 + 图谱提供关联关系
