# 第4章：工具

> 工具是 Agent 的双手：MCP 协议、感知/执行/协作三类工具、事件驱动异步 Agent、主动工具发现

---

## 4.1 工具是什么？

### 定义

工具（Tool）是 Agent 与外部世界交互的接口。LLM 本身只能生成文本，工具让它能读写文件、执行命令、搜索代码、调用 API。

一个工具包含：
- **名称**：LLM 通过名称调用工具
- **描述**：告诉 LLM 这个工具做什么、何时用
- **参数 schema**：JSON Schema 定义工具的参数
- **执行函数**：实际执行的逻辑

### 行业主流做法

| 框架 | 工具系统 | 工具发现 |
|------|---------|---------|
| OpenAI Codex | 内置 + MCP | 静态注册 |
| Claude | tool_use + MCP | 静态注册 |
| LangChain | Tool/Toolkit 类 | 动态加载 |
| AutoGPT | command registry | 配置文件 |

---

## 4.2 工具分类：感知/执行/协作

我们将工具分为三大类：

### 感知工具（Perception）

让 Agent "看"到世界：

| 工具 | 作用 | 实现文件 |
|------|------|---------|
| `read` | 读取文件内容 | `tools/read.ts` |
| `glob` | 文件名模式匹配搜索 | `tools/glob.ts` |
| `grep` | 文件内容正则搜索 | `tools/grep.ts` |
| `read_attachment` | 读取上传的附件 | `tools/read-attachment.ts` |
| `list_sessions` | 列出可用会话 | `session/tools.ts` |
| `search_notebook` | 搜索知识库 | `tools/search-notebook.ts` |
| `fact_check` | 事实核查（纠偏） | `tools/fact-check.ts` |

### 执行工具（Action）

让 Agent "做"事情：

| 工具 | 作用 | 实现文件 |
|------|------|---------|
| `write` | 写入/创建文件 | `tools/write.ts` |
| `edit` | 编辑已有文件（精确替换） | `tools/edit.ts` |
| `bash` | 执行 shell 命令 | `tools/bash.ts` |
| `note_operations` | 笔记操作 | `tools/note-operations.ts` |
| `ask_clarification` | 向用户提问 | `tools/ask-clarification.ts` |

### 协作工具（Collaboration）

让 Agent "协作"：

| 工具 | 作用 | 实现文件 |
|------|------|---------|
| `spawn_subagent` | 派生子 Agent | `tools.ts` |
| `wait_for_subagent` | 等待子 Agent 结果 | `tools.ts` |
| `delegate_to_session` | 跨会话委派任务 | `session/tools.ts` |
| `wait_for_delegation` | 等待跨会话委派结果 | `session/tools.ts` |
| `show_todo` | 展示待办列表 | `tools/show-todo.ts` |

> **[配图位]**：工具分类架构图，展示 感知/执行/协作 三类工具的关系

---

## 4.3 工具注册与执行

### ToolRegistry

```typescript
// src/core/llm/tools.ts

export class ToolRegistry {
  private tools: Map<string, ToolDefinition> = new Map();

  register(tool: ToolDef) {
    this.tools.set(tool.id, tool);
  }

  getToolDefinitions(): ToolDefinition[] {
    // 返回给 LLM 的工具描述（JSON Schema 格式）
    return Array.from(this.tools.values()).map(t => ({
      type: "function",
      function: {
        name: t.id,
        description: t.description,
        parameters: t.parameters,
      },
    }));
  }

  async execute(name: string, args: Record<string, unknown>, ctx: ToolContext): 
    Promise<ToolExecuteResult> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Unknown tool: ${name}`);
    
    // 权限检查（安全模式）
    const decision = evaluateWithSecurityMode(ctx.securityMode, name, args);
    if (decision === "ask") {
      const result = await ctx.onPermissionRequest?.({ tool: name, args });
      if (result?.decision === "deny") {
        return { title: "Denied", output: "用户拒绝了此操作" };
      }
    }
    
    // 执行工具
    return tool.execute(args, ctx);
  }
}
```

### 工具定义结构

```typescript
export interface ToolDef {
  id: string;                    // 工具唯一标识
  description: string;           // 工具描述（LLM 看到的）
  parameters: {                  // JSON Schema 参数定义
    type: "object";
    properties: Record<string, any>;
    required: string[];
  };
  execute(args: Record<string, unknown>, ctx: ToolContext): 
    Promise<ToolExecuteResult>;
}
```

---

## 4.4 MCP 协议

### 什么是 MCP？

MCP（Model Context Protocol）是 Anthropic 提出的开放协议，标准化了 LLM 与外部工具/数据源的连接方式。支持两种传输：
- **stdio**：本地进程通信（最常用）
- **HTTP/SSE**：远程服务通信

### 我们的实现

```typescript
// src/core/mcp/mcp.ts

export class MCPClient {
  private connections: Map<string, MCPConnection> = new Map();

  async connect(config: MCPServerConfig): Promise<MCPConnection> {
    if (config.transport === "stdio") {
      await this.connectStdio(config, connection);    // 通过 Tauri 启动子进程
    } else if (config.transport === "http" || config.transport === "sse") {
      await this.connectHTTP(config, connection);     // HTTP/SSE 连接
    }
    
    // 连接后自动获取工具列表
    connection.tools = await this.listTools(config.name);
    return connection;
  }

  async callTool(serverName: string, toolName: string, args: any) {
    // 通过 MCP 协议调用远程工具
  }
}

export class MCPRegistry {
  // 管理所有 MCP 服务器连接
  // 将 MCP 工具注册到 ToolRegistry
  // 在 System Prompt 中注入 MCP 工具描述
}
```

### MCP 工具注入流程

```
用户在设置中配置 MCP 服务器
  → MCPClient.connect() 启动连接
  → listTools() 获取服务器提供的工具列表
  → 将每个 MCP 工具注册到 ToolRegistry
  → 工具描述注入 System Prompt
  → LLM 可以像调用内置工具一样调用 MCP 工具
```

---

## 4.5 事件驱动异步 Agent

### spawn_subagent + wait_for_subagent 模式

我们的工具系统支持**异步事件驱动**模式：

```typescript
// 主 Agent 调用 spawn_subagent
→ 立即返回 task_id（非阻塞）
→ 主 Agent 可以继续其他工作
→ 稍后调用 wait_for_subagent(task_id)
→ 阻塞等待子 Agent 完成
→ 获取结果，继续推理
```

### 跨会话委派

```typescript
// src/core/session/tools.ts

// delegate_to_session: 委派任务到另一个会话
{
  id: "delegate_to_session",
  description: "Send a task to another session's agent. 
                Returns immediately with a task ID (non-blocking).",
  parameters: {
    target_session_id: { type: "string" },
    task: { type: "string" },
  },
}

// wait_for_delegation: 等待跨会话委派结果
{
  id: "wait_for_delegation",
  description: "Wait for a delegated task to complete.",
  parameters: {
    task_id: { type: "string" },
  },
}
```

### 防并发问题

```typescript
// 不允许同一轮同时 delegate 和 wait
// 因为 delegate 返回的 task_id 在当前轮还没拿到
if (hasDelegateInResponse && hasWaitInResponse) {
  // 拒绝 wait，提示下轮再调用
  "Cannot wait_for_delegation in the same response as delegate_to_session"
}
```

---

## 4.6 权限系统

### 三层安全模式

```typescript
// src/core/permission/security-mode.ts

type SecurityMode = "ask" | "auto" | "full";

// ask:  每次执行工具都询问用户
// auto: 自动批准安全操作（如 read/glob/grep），危险操作仍询问
// full: 全部自动批准（不询问）
```

### Agent 级权限

```typescript
// src/core/agent/agent.ts

interface AgentPermission {
  tool: string;           // 工具名模式（支持通配符 "file.*"）
  action: "allow" | "deny" | "ask";
  resource?: string;      // 资源模式（如 "*.env", "/etc/*"）
}

// 最后匹配胜出（last-match-wins）
evaluatePermission(agentId, toolName, resource) {
  let result = "ask";
  for (const rule of agent.permissions) {
    if (this.matchPattern(toolName, rule.tool)) {
      if (!rule.resource || this.matchPattern(resource, rule.resource)) {
        result = rule.action;  // 后面的规则覆盖前面的
      }
    }
  }
  return result;
}
```

### 写文件确认（S4）

```typescript
// 覆写已有文件前，弹出 diff 对比让用户确认
onWriteConfirm: (params: {
  filePath: string;
  existingContent: string;
  newContent: string;
}) => Promise<WriteConfirmResult>;
// WriteConfirmResult = "accept" | "reject" | "custom_instruction"
```

---

## 4.7 主动工具发现

### 技能即工具

我们的 Skill 系统支持"携带工具"的技能（B1）：

```typescript
// src/core/skill/skill.ts

interface SkillDefinition {
  // ... prompt 等字段 ...
  
  // B1: 技能可以注册自己的工具
  tools?: SkillToolDef[];  // 技能提供的工具定义
  bindShells?: string[];   // 绑定的 shell 类型
}

// 当技能被激活时：
// 1. 技能 prompt 注入上下文
// 2. 技能携带的工具注册到 ToolRegistry
// 3. 技能移除时，工具反注册
```

### MCP 动态发现

MCP 服务器连接后自动发现工具：

```
MCPClient.connect(serverConfig)
  → JSON-RPC: tools/list
  → 返回工具定义数组
  → 自动注册到 ToolRegistry
  → System Prompt 更新
```

---

## 4.8 行业对比与我们的取舍

| 维度 | 行业主流 | 我们 | 理由 |
|------|---------|------|------|
| 工具描述格式 | JSON Schema | 同 | 兼容 OpenAI function calling |
| MCP 支持 | 部分（Codex/Claude） | 完整 | 开放生态 |
| 权限模型 | 二元 allow/deny | 三层 ask/auto/full + Agent 级规则 | 更灵活 |
| 异步工具 | 同步为主 | spawn + wait 异步模式 | 并行能力 |
| 工具发现 | 静态注册 | 静态 + Skill 动态 + MCP 自动 | 可扩展 |
| 安全确认 | 无 | 写文件 diff 确认 | 防止误操作 |

### 我们的优势

1. **完整 MCP 支持**：stdio + HTTP/SSE 双传输，自动发现工具
2. **异步工具**：spawn + wait 模式让 Agent 可以并行工作
3. **细粒度权限**：Agent 级权限规则 + 资源通配符 + 安全模式
4. **技能携带工具**：技能不只是 prompt，还能注册自己的工具

### 我们的取舍

1. **无沙箱执行**：bash 工具直接在用户系统执行（依赖 Tauri 权限）
2. **工具结果无缓存**：相同参数的 read 调用会重复执行
3. **MCP stdio 需要子进程**：在 Tauri 环境需要平台特定实现

---

## 4.9 核心代码导航

| 文件 | 职责 |
|------|------|
| `src/core/llm/tools.ts` | ToolRegistry、内置工具注册、spawn/wait |
| `src/core/llm/tools/*.ts` | 各工具实现（read/write/bash/grep 等） |
| `src/core/mcp/mcp.ts` | MCPClient、MCPRegistry |
| `src/core/permission/permission.ts` | 权限管理器 |
| `src/core/permission/security-mode.ts` | 三层安全模式评估 |
| `src/core/session/tools.ts` | delegate_to_session、wait_for_delegation |
| `src/core/skill/registry.ts` | 技能工具注册/反注册 |

---

## 小结

> 工具 = 感知（read/glob/grep）+ 执行（write/bash/edit）+ 协作（spawn/delegate）
> MCP = 开放协议连接外部工具，自动发现
> 权限 = 三层安全模式 + Agent 级规则 + 写文件 diff 确认
> 异步 = spawn + wait 模式，支持并行子任务
> 发现 = 静态注册 + 技能动态注册 + MCP 自动发现
