# 第1章：Agent、子Agent = LLM + 上下文 + 工具

> 面向 IT 工程师的 Codem (mimo-gui) 架构培训

---

## 1.1 什么是 Agent？

### 定义

Agent = **LLM（大语言模型）** + **上下文（Context）** + **工具（Tools）**

这三个要素缺一不可：
- **LLM**：推理引擎，负责理解意图、制定计划、生成回复
- **上下文**：LLM 的"工作记忆"，包含系统提示词、对话历史、记忆、知识
- **工具**：LLM 的"双手"，让 Agent 能执行实际操作（读写文件、运行命令、搜索等）

### 行业主流做法

| 框架 | Agent 结构 | 存储方式 |
|------|-----------|---------|
| OpenAI Codex | Agent = system prompt + tool list + model config | JSON 配置文件 |
| Claude (Anthropic) | Agent = system prompt + tool definitions | API 参数 |
| LangChain | Agent = AgentExecutor(LLM + tools + memory) | Python 对象 |
| AutoGPT | Agent = prompt template + command registry | YAML/JSON |

行业共识：**Agent 是一个配置对象**，不是一个运行中的进程。它定义了"用什么模型、有什么工具、遵循什么指令"，运行时由一个 **Agent Loop（智能体循环）** 驱动。

---

## 1.2 我们怎么做的

### Agent 的程序结构

在我们的系统中，Agent 是一个 **TypeScript 接口（interface）**，本质是一个配置元数据对象：

```typescript
// src/core/agent/agent.ts

export interface AgentDefinition {
  id: string;              // 唯一标识，如 "build"、"plan"、"explore"
  name: string;            // 显示名称
  description: string;     // 用途描述
  mode: AgentMode;         // "primary" | "subagent" | "all"

  // —— LLM 配置 ——
  prompt: string;          // 系统提示词（中文）
  promptEn?: string;       // 系统提示词（英文）
  model?: string;          // 模型覆盖（不填用默认）
  temperature?: number;    // 温度覆盖
  reasoningEffort?: "low" | "medium" | "high";  // 推理强度
  maxTokens?: number;      // 最大输出 token
  maxSteps?: number;       // 最大工具调用轮次

  // —— 工具配置 ——
  toolAllowlist?: string[];           // 允许使用的工具（空=全部）
  permissions: AgentPermission[];     // 权限规则（允许/拒绝/询问）

  // —— 上下文配置 ——
  contextMode?: "inline" | "fork";    // inline=共享上下文, fork=隔离上下文
  collaborationMode?: "default" | "plan";  // 执行模式/计划模式

  // —— 子Agent 能力 ——
  canSpawnSubagents?: boolean;        // 是否可以派生子Agent

  // —— 模型槽位 ——
  modelSlot?: TaskSlot;               // 使用哪个 Profile 槽位
}
```

**关键设计决策**：Agent 不是类，不是数据库表，是一个**纯数据接口**。这意味着：
- Agent 定义可以序列化为 JSON 存储
- 运行时通过 `AgentRegistry` 单例管理
- 不同 Agent 之间共享同一套 Agentic Loop 执行引擎

### Agent 注册表

```typescript
// src/core/agent/agent.ts

export class AgentRegistry {
  private agents: Map<string, AgentDefinition> = new Map();

  constructor() {
    this.registerBuiltinAgents();  // 注册内置 Agent
    this.loadCustomAgents();         // 从 settings 加载自定义 Agent
  }

  register(agent: AgentDefinition) { ... }
  get(id: string): AgentDefinition | undefined { ... }
  getPrimary(): AgentDefinition[] { ... }  // 获取所有主 Agent
  getSubagents(): AgentDefinition[] { ... } // 获取所有子 Agent
}
```

### 内置 Agent 列表

| Agent ID | 名称 | 模式 | 用途 |
|----------|------|------|------|
| `build` | 执行 Agent | primary | 自主编码、写文件、运行命令 |
| `plan` | 计划 Agent | primary | 只读分析、制定方案、不修改文件 |
| `explore` | 探索 Agent | primary | 代码探索、架构理解 |
| `general` | 通用 Agent | primary | 通用问答 |
| `title` | 标题 Agent | subagent | 为会话生成标题 |
| `summary` | 摘要 Agent | subagent | 上下文压缩摘要 |

> **[配图位]**：Agent 注册表架构图，展示 AgentRegistry → AgentDefinition → AgenticLoop 的关系

---

## 1.3 子 Agent（Subagent）

### 什么是子 Agent？

子 Agent 是**由主 Agent 在运行过程中动态派生的临时 Agent**。它拥有：
- 独立的会话上下文（fork 模式）
- 可以使用不同的模型（通过 modelSlot）
- 可以使用不同的工具集
- 完成后结果回传给父 Agent

### 行业主流做法

| 框架 | 子 Agent 机制 | 通信方式 |
|------|--------------|---------|
| OpenAI Codex | 内部子任务 | 异步任务队列 |
| Claude | tool_use 嵌套 | 同步等待 |
| LangChain | Agent 嵌套 | 函数调用 |
| CrewAI | Crew + Task | 任务分配 |

### 我们的实现

#### 派生工具

```typescript
// src/core/llm/tools.ts

// 工具1: spawn_subagent — 异步派生子Agent
{
  id: "spawn_subagent",
  description: "Spawn a sub-agent to work on a task in the background. 
                Returns immediately with task ID.",
  parameters: {
    agent_id: { type: "string", description: "Agent ID to spawn" },
    task: { type: "string", description: "Task description" },
  },
}

// 工具2: wait_for_subagent — 等待子Agent完成
{
  id: "wait_for_subagent",
  description: "Wait for a sub-agent to complete and get its result.",
  parameters: {
    task_id: { type: "string", description: "The sub-agent task ID" },
  },
}
```

#### 生命周期管理

```typescript
// src/core/llm/agentic-loop.ts

// 跟踪已派生但未等待的子Agent（防止遗漏）
private spawnedTaskIds: Set<string> = new Set();
private waitedTaskIds: Set<string> = new Set();

// 在每轮迭代结束时检查：
// 如果有未等待的子Agent，注入提醒而非直接停止
if (unwaitedIds.length > 0) {
  const reminder = `[SYSTEM REMINDER] You have ${unwaitedIds.length} 
    sub-agent(s) that were spawned but NOT waited on...`;
  // 注入到下一轮上下文
}
```

#### 关键设计：防遗漏机制

我们的 Agentic Loop 有一套**子 Agent 生命周期守护**：
1. **spawn 追踪**：每次 `spawn_subagent` 被调用，task_id 加入 `spawnedTaskIds`
2. **wait 追踪**：每次 `wait_for_subagent` 被调用，task_id 加入 `waitedTaskIds`
3. **遗漏检测**：循环结束前，检查 `spawnedTaskIds - waitedTaskIds` 的差集
4. **强制提醒**：如果有遗漏，不停止循环，而是注入系统提醒要求 LLM 等待这些子 Agent

> **[配图位]**：子 Agent 生命周期流程图，展示 spawn → run → wait → result 回传

---

## 1.4 为什么这么做？

### 设计决策与理由

| 决策 | 选择 | 理由 |
|------|------|------|
| Agent 存储形式 | 纯数据接口（非类） | 可序列化、可热更新、无状态副作用 |
| Agent 管理 | 单例注册表 | 统一管理，避免多实例不一致 |
| 子 Agent 通信 | 异步 spawn + wait | LLM 可以并行派生多个子任务 |
| 子 Agent 上下文 | fork 模式（独立） | 避免子任务污染主上下文 |
| 防遗漏机制 | 强制注入提醒 | LLM 经常忘记等待子任务结果 |

### 与行业对比

**我们的优势**：
1. **异步子 Agent**：`spawn_subagent` 立即返回，LLM 可以继续工作，稍后用 `wait_for_subagent` 收集结果。这比同步等待更灵活。
2. **防遗漏守护**：行业内大多数框架不处理"LLM 忘了 wait"的问题，我们通过循环级追踪解决。
3. **Agent 定义即数据**：用户可以通过设置界面创建自定义 Agent，无需改代码。

**我们的取舍**：
1. **没有 Agent 继承**：不像 CrewAI 那样支持 Agent 之间的角色继承关系。简单但不够灵活。
2. **子 Agent 数量无硬限制**：依赖 LLM 自控力，没有强制限制并发子 Agent 数量（仅提醒）。

---

## 1.5 核心代码导航

| 文件 | 职责 |
|------|------|
| `src/core/agent/agent.ts` | AgentDefinition 接口、AgentRegistry 注册表 |
| `src/core/llm/agentic-loop.ts` | AgenticLoop 循环引擎、子 Agent 生命周期守护 |
| `src/core/llm/tools.ts` | spawn_subagent / wait_for_subagent 工具定义 |
| `src/core/llm/index.ts` | LLMEngine.process() 编排入口、getAgenticLoop() |

---

## 小结

> Agent = 配置元数据（非运行实例）
> AgentRegistry = 单例注册表管理所有 Agent 定义
> AgenticLoop = 执行引擎，驱动 LLM + 工具 + 上下文的循环
> 子 Agent = 异步 spawn + wait 模式，带防遗漏守护
