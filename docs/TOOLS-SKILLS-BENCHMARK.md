# 工具与技能对标优化分析

> 基于 `.wecode-ref`（Wegent）开源项目的深度分析，规划 Codem 工具/技能体系的对标优化路线。
>
> 最后更新：2026-07-15

---

## 一、现状对比总览

| 维度 | Codem（当前） | Wegent（参考） | 差距 |
|------|--------------|---------------|------|
| **内置工具数** | 11 个 | 7+ 内置 + 7 沙箱 + 多个 MCP 工具 | 缺少 web_search、attachment、data_table、knowledge 等 |
| **内置技能数** | 6 个（纯 prompt） | 11 个（含 provider 工具） | 技能仅为提示词，无法携带工具 |
| **技能管理 UI** | 只读查看面板 | 完整 CRUD + 技能市场 + Git 导入 + 绑定管理 | 缺少上传/删除/启用/禁用/市场 |
| **技能加载机制** | 全量注入系统提示词 | load_skill 懒加载 + 会话级缓存 + 跨轮次保持 | 上下文浪费严重 |
| **技能工具架构** | 无 | SkillToolProvider 抽象 + 动态加载 | 架构缺失，技能无法携带工具 |
| **MCP 集成** | 基础 stdio MCP | 技能内嵌 mcpServers 声明 + 自动连接 | 技能无法声明 MCP 依赖 |

---

## 二、参考项目工具清单

### 2.1 内置工具（chat_shell/tools/builtin/）

| 工具名 | 显示名 | 功能 | 我们是否有 |
|--------|--------|------|-----------|
| `web_search` | 搜索网页 | 集成搜索引擎 API，返回标题/URL/摘要/内容 | ❌ 缺失 |
| `read_file` | 读取文件 | 分页读取文件，含 offset/limit/has_more | ✅ 有（无分页） |
| `list_files` | 列出文件 | 列出目录文件，含大小/修改时间 | ✅ 有（glob 工具） |
| `load_skill` | 加载技能 | 懒加载技能 prompt，会话级缓存，跨轮次保持 | ❌ 缺失 |
| `read_attachment` | 读取附件 | 分页读取附件提取文本，token 限制分页 | ❌ 缺失 |
| `data_table_query` | 查询数据表 | 查询钉钉多维表/飞书多维表格数据 | ❌ 缺失（平台相关） |
| `submit_evaluation_result` | 提交评估 | 结构化提交 AI 回复评估结果 | ❌ 缺失（平台相关） |
| `kb_ls` / `kb_head` / `knowledge_list_documents` | 知识库列表 | 列出知识库文档 | ❌ 缺失 |
| `knowledge_base` / `scoped_knowledge_base` | 知识库搜索 | RAG 检索知识库 | ❌ 缺失 |

### 2.2 技能提供的工具（via SkillToolProvider）

| 来源技能 | 工具名 | 功能 | 我们是否有 |
|---------|--------|------|-----------|
| sandbox | `exec` | 沙箱内执行命令 | ✅ 有（bash 工具） |
| sandbox | `sub_claude_agent` | 沙箱内运行 Claude 子任务 | ❌ 缺失 |
| sandbox | `list_files` / `read_file` / `write_file` | 沙箱文件操作 | ✅ 有（本地文件操作） |
| sandbox | `upload_attachment` / `download_attachment` | 附件上传/下载 | ❌ 缺失 |
| mermaid-diagram | `render_mermaid` | 验证并渲染 Mermaid 图表 | ❌ 缺失 |
| mermaid-diagram | `read_mermaid_reference` | 读取 Mermaid 语法参考文档 | ❌ 缺失 |
| interactive (MCP) | `interactive_form_question` | 交互式表单提问 | ❌ 缺失 |
| subscription-manager (MCP) | `preview_subscription` / `create_subscription` | 订阅任务管理 | ❌ 缺失 |
| prompt-optimization (MCP) | `get_team_prompt` / `submit_prompt_changes` | 提示词优化 | ❌ 缺失 |
| wegent-knowledge (MCP) | 7 个知识库工具 | 知识库 CRUD + RAG 搜索 | ❌ 缺失 |
| browser | CLI 命令 | 浏览器自动化（导航/截图/交互） | ❌ 缺失 |

---

## 三、参考项目技能清单

| 技能名 | 显示名 | 功能描述 | 携带工具 | MCP 依赖 | 我们是否有 |
|--------|--------|---------|---------|---------|-----------|
| `browser` | 浏览器控制 | 网页导航/交互/截图/提取数据 | ❌ 纯 CLI | ❌ | ❌ 缺失 |
| `sandbox` | 沙箱环境 | Docker 隔离环境内执行代码/命令 | ✅ 7 个工具 | ❌ | ❌ 缺失 |
| `mermaid-diagram` | 绘制图表 | Mermaid 语法验证+渲染+自动纠错 | ✅ 2 个工具 | ❌ | ❌ 缺失 |
| `skill-creator` | 技能创建器 | 创建/改进/评估技能，含 eval 框架 | ❌ 纯脚本 | ❌ | ❌ 缺失 |
| `prompt-optimization` | 提示词管理 | 查看/修改 AI 系统提示词 | ❌ 纯 MCP | ✅ 1 个 MCP | ❌ 缺失 |
| `interactive` | 交互式表单 | 向用户展示选择/输入表单 | ❌ 纯 MCP | ✅ 1 个 MCP | ❌ 缺失 |
| `conversation_to_prompt` | 对话转提示词 | 将对话转为可复用系统提示词 | ❌ 纯 prompt | ❌ | ❌ 缺失 |
| `subscription-manager` | 订阅任务 | 创建定时/周期/一次性任务 | ❌ 纯 MCP | ✅ 1 个 MCP | ❌ 缺失 |
| `ui-links` | UI 链接 | 输出附件/导航协议链接 | ❌ 纯 prompt | ❌ | ❌ 缺失 |
| `wegent-knowledge` | 知识库工具 | 知识库 CRUD + RAG 检索 | ❌ 纯 MCP | ✅ 1 个 MCP | ❌ 缺失 |
| `wiki_submit` | Wiki 提交 | 提交 Wiki 文档章节 | ❌ 纯脚本 | ❌ | ❌ 缺失 |

---

## 四、参考项目技能管理界面分析

### 4.1 技能管理 API（frontend/src/apis/skills.ts）

| 功能 | API | 说明 |
|------|-----|------|
| 技能列表 | `fetchSkillsList` / `fetchUnifiedSkillsList` | 支持分页、命名空间、个人/团队/全部筛选 |
| 技能详情 | `getSkill` / `fetchSkillByName` | 按ID或名称查询，支持精确/模糊匹配 |
| 上传技能 | `uploadSkill` | ZIP 包上传，支持命名空间，带进度回调 |
| 更新技能 | `updateSkill` | ZIP 包更新，带进度回调 |
| 删除技能 | `deleteSkill` | 删除前检查引用关系 |
| 下载技能 | `downloadSkill` | 下载 ZIP 包 |
| 技能调用 | `invokeSkill` | 获取技能 prompt 内容 |
| 技能绑定 | `addSkillToMyDefault` / `removeSkillFromMyDefault` | 用户级启用/禁用 |
| 绑定异常 | `updateMyDefaultSkillBindingExceptions` | 按模式/智能体/项目设置例外 |
| 引用查询 | `fetchSkillReferences` / `removeSkillReferences` | 查询/清除技能被引用关系 |
| 公共技能管理 | `uploadPublicSkill` / `deletePublicSkill` | 管理员管理公共技能 |
| Git 导入 | `scanGitRepoSkills` / `importGitRepoSkills` | 扫描/导入 Git 仓库技能 |
| Git 更新 | `updateSkillFromGit` / `batchUpdateSkillsFromGit` | 从 Git 源更新技能 |

### 4.2 技能市场 API（frontend/src/apis/skillMarket.ts）

| 功能 | API | 说明 |
|------|-----|------|
| 市场可用性 | `checkSkillMarketAvailable` | 检查技能市场是否可用 |
| 搜索技能 | `searchSkills` | 关键词/标签搜索，分页返回 |
| 下载技能 | `downloadSkill` | 从市场下载技能包 |

### 4.3 管理界面核心特性

1. **双来源显示**：个人技能 + 公共技能统一展示
2. **命名空间**：个人 / 团队 / 组织三级命名空间
3. **绑定管理**：技能可按用户/智能体/项目/消息级别绑定
4. **引用追踪**：删除前检查哪些智能体引用了该技能
5. **Git 集成**：从 Git 仓库扫描/导入/批量更新技能
6. **可见性控制**：技能可设为对用户可见/隐藏
7. **强制预加载**：技能可设为 `force_preload`，不等 LLM 自主加载

---

## 五、咱们项目当前工具/技能架构

### 5.1 工具注册（src/core/llm/tools.ts）

```
createDefaultToolRegistry()
  ├── bash         (执行命令)
  ├── read_file    (读取文件)
  ├── write_file   (写入文件)
  ├── edit_file    (编辑文件)
  ├── multi_edit   (批量编辑)
  ├── glob         (文件搜索)
  ├── grep         (内容搜索)
  ├── tts          (文本转语音)
  ├── image_gen    (图片生成)
  ├── spawn_subagent    (子智能体)
  └── wait_for_subagent (等待子智能体)
```

### 5.2 技能注册（src/core/skill/skill.ts）

```
SkillRegistry
  ├── registerBuiltinSkills()
  │   ├── code-review  (代码审查 - 纯prompt)
  │   ├── refactor     (重构 - 纯prompt)
  │   ├── debug        (调试 - 纯prompt)
  │   ├── document     (文档 - 纯prompt)
  │   ├── test         (测试 - 纯prompt)
  │   └── explain      (解释 - 纯prompt)
  └── loadFromDirectory()  (从项目目录加载 SKILL.md)
```

### 5.3 关键差距

1. **技能仅为提示词**：无工具携带能力，无法实现 mermaid 渲染、表单交互等功能
2. **全量注入**：所有技能 prompt 注入系统提示词，浪费上下文窗口
3. **无懒加载**：没有 `load_skill` 工具，LLM 无法按需加载技能
4. **无管理 UI**：只有只读面板，不能上传/删除/启用/禁用
5. **YAML 解析简陋**：不支持 `provider`、`tools`、`mcpServers`、`bindShells` 等字段
6. **无 MCP 声明**：技能无法声明 MCP 服务器依赖

---

## 六、影响链条分析

### 6.1 核心依赖链

```
┌─────────────────────────────────────────────────────────────────┐
│                    影响链条（从底层到上层）                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  P0: 基础架构层                                                   │
│  ┌──────────────────┐    ┌──────────────────┐                  │
│  │ SkillToolProvider │───▶│  load_skill 工具  │                  │
│  │ (技能携带工具)     │    │  (懒加载机制)     │                  │
│  └────────┬─────────┘    └────────┬─────────┘                  │
│           │                       │                             │
│           ▼                       ▼                             │
│  ┌──────────────────────────────────────────┐                   │
│  │  SKILL.md 解析器增强                      │                   │
│  │  (支持 provider/tools/mcpServers/bindShells) │                │
│  └──────────────────────────────────────────┘                   │
│           │                                                     │
│           ▼                                                     │
│  P1: 独立工具层（不依赖 P0，可并行）                                │
│  ┌──────────────────┐  ┌──────────────────┐                    │
│  │  web_search 工具  │  │  read_attachment  │                    │
│  │  (独立工具)       │  │  (独立工具)       │                    │
│  └──────────────────┘  └──────────────────┘                    │
│           │                                                     │
│           ▼                                                     │
│  P2: 技能管理层（依赖 P0）                                        │
│  ┌──────────────────┐  ┌──────────────────┐                    │
│  │  技能上传/安装     │  │  技能启用/禁用     │                    │
│  │  (ZIP 包管理)     │  │  (会话级绑定)     │                    │
│  └──────────────────┘  └──────────────────┘                    │
│           │                                                     │
│           ▼                                                     │
│  P3: 高级技能层（依赖 P0 + P2）                                   │
│  ┌──────────┐ ┌──────────┐ ┌──────────────┐ ┌───────────────┐  │
│  │ mermaid  │ │ skill    │ │ interactive  │ │ prompt        │  │
│  │ diagram  │ │ creator  │ │ forms        │ │ optimization  │  │
│  └──────────┘ └──────────┘ └──────────────┘ └───────────────┘  │
│           │                                                     │
│           ▼                                                     │
│  P4: 平台集成层（依赖 P0 + P2 + 后端服务）                        │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐          │
│  │ 知识库    │ │ 订阅任务  │ │ 浏览器    │ │ 沙箱环境  │          │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘          │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 6.2 详细影响分析

#### P0 — SkillToolProvider 架构（基础）

**影响文件**：
- `src/core/skill/skill.ts` → 重构 SkillDefinition，新增 `provider`、`tools`、`mcpServers` 字段
- `src/core/llm/tools.ts` → 新增 `createLoadSkillTool()`，实现懒加载
- `src/core/llm/agentic-loop.ts` → 修改工具注册逻辑，支持动态加载技能工具
- `src/core/llm/prompt.ts` → 系统提示词中只包含技能名+描述，不含完整 prompt

**影响范围**：核心引擎，改动后需全面回归测试

**如果不做 P0**：
- 无法实现任何携带工具的技能（mermaid、interactive 等）
- 系统提示词会随技能增加而膨胀
- 无法对标参考项目的技能体验

#### P1 — 独立工具（可并行）

**影响文件**：
- `src/core/llm/tools.ts` → 新增 `createWebSearchTool()`、`createReadAttachmentTool()`
- `src/core/llm/types.ts` → 可能需要新增 ToolContext 字段
- `src/styles.css` → 新工具的渲染样式

**影响范围**：工具层，增量添加不影响现有功能

#### P2 — 技能管理 UI（依赖 P0）

**影响文件**：
- `src/components/SkillPanel.tsx` → 重构为完整管理界面
- `src/store.ts` → 新增技能管理状态
- `src/core/storage/` → 新增技能包存储（ZIP 解压到本地目录）
- `src/core/skill/skill.ts` → 新增 `installFromZip()`、`uninstall()`、`toggleEnabled()`

**影响范围**：UI + 存储 + 技能注册，改动较大

#### P3 — 高级技能（依赖 P0 + P2）

**影响文件**（以 mermaid-diagram 为例）：
- `skills/mermaid-diagram/SKILL.md` → 技能定义
- `skills/mermaid-diagram/provider.ts` → 工具提供者
- `skills/mermaid-diagram/render_mermaid.ts` → 渲染工具实现
- `src/components/ChatPanel.tsx` → Mermaid 代码块渲染
- `src/components/MessageBubble.tsx` → Mermaid 渲染集成

**影响范围**：每个技能独立，可按需添加

---

## 七、对标优化优先级

### 优先级矩阵

| 优先级 | 任务 | 依赖 | 影响范围 | 预估工时 | 价值 |
|--------|------|------|---------|---------|------|
| **P0-1** | SkillToolProvider 架构 | 无 | 核心引擎 | 2-3天 | ⭐⭐⭐⭐⭐ |
| **P0-2** | load_skill 懒加载工具 | P0-1 | 核心引擎 | 1-2天 | ⭐⭐⭐⭐⭐ |
| **P0-3** | SKILL.md 解析器增强 | 无 | 技能解析 | 0.5天 | ⭐⭐⭐⭐ |
| **P1-1** | web_search 工具 | 无 | 工具层 | 1天 | ⭐⭐⭐⭐ |
| **P1-2** | mermaid-diagram 技能 | P0-1 | 技能+UI | 2天 | ⭐⭐⭐⭐ |
| **P1-3** | read_attachment 工具 | 无 | 工具层 | 1天 | ⭐⭐⭐ |
| **P2-1** | 技能上传/安装 UI | P0-3 | UI+存储 | 2天 | ⭐⭐⭐⭐ |
| **P2-2** | 技能启用/禁用管理 | P0-3 | UI+状态 | 1天 | ⭐⭐⭐ |
| **P2-3** | 技能删除+引用检查 | P2-1 | UI+存储 | 1天 | ⭐⭐⭐ |
| **P3-1** | interactive 表单技能 | P0-1,P2-1 | 技能+UI | 3天 | ⭐⭐⭐ |
| **P3-2** | skill-creator 技能 | P0-1,P2-1 | 技能+脚本 | 3天 | ⭐⭐⭐ |
| **P3-3** | prompt-optimization | P0-1 | 技能 | 2天 | ⭐⭐ |
| **P3-4** | conversation_to_prompt | P0-3 | 技能 | 0.5天 | ⭐⭐ |
| **P4-1** | 知识库管理技能 | 后端 | 技能+后端 | 5天+ | ⭐⭐ |
| **P4-2** | 订阅任务管理 | 后端 | 技能+后端 | 3天+ | ⭐ |
| **P4-3** | 浏览器自动化 | 扩展 | 技能+扩展 | 5天+ | ⭐⭐ |
| **P4-4** | 沙箱环境 | Docker | 后端+基建 | 5天+ | ⭐ |

### 推荐实施顺序

#### 第一阶段：基础架构（1-2周）

```
P0-3: SKILL.md 解析器增强（0.5天）
  ↓
P0-1: SkillToolProvider 架构（2-3天）
  ↓
P0-2: load_skill 懒加载工具（1-2天）
  ↓
P1-1: web_search 工具（1天，可并行）
```

**目标**：建立技能携带工具的架构基础，让后续技能可以按需添加。

#### 第二阶段：标杆技能 + 管理 UI（2周）

```
P1-2: mermaid-diagram 技能（2天）  ← 展示 SkillToolProvider 价值
  ↓
P2-1: 技能上传/安装 UI（2天）
  ↓
P2-2: 技能启用/禁用（1天）
  ↓
P2-3: 技能删除+引用检查（1天）
```

**目标**：用户可以安装/管理技能，mermaid 技能作为首个工具型技能的示范。

#### 第三阶段：高级技能（2-3周）

```
P3-4: conversation_to_prompt（0.5天）  ← 最简单，快速见效
  ↓
P3-3: prompt-optimization（2天）
  ↓
P3-1: interactive 表单（3天）  ← UI 改动最大
  ↓
P3-2: skill-creator（3天）  ← 最复杂
```

**目标**：补齐高价值技能，达到参考项目的技能丰富度。

#### 第四阶段：平台集成（按需）

```
P4-x: 知识库 / 订阅 / 浏览器 / 沙箱
```

**目标**：根据用户反馈按需实现，桌面应用场景优先级较低。

---

## 八、每个任务的详细改动分析

### P0-1: SkillToolProvider 架构

**新增文件**：
- `src/core/skill/provider.ts` — `SkillToolProvider` 抽象接口
- `src/core/skill/context.ts` — `SkillToolContext` 依赖注入容器
- `src/core/skill/registry.ts` — `SkillToolRegistry` 单例管理 Provider

**修改文件**：
- `src/core/skill/skill.ts` — `SkillDefinition` 新增 `provider?`、`tools?`、`mcpServers?`、`bindShells?` 字段
- `src/core/llm/agentic-loop.ts` — `executeIteration` 中在工具执行前检查 `load_skill` 是否加载了新工具
- `src/core/llm/prompt.ts` — `buildSystemPrompt` 中技能部分改为只输出名称+描述列表

**测试要点**：
- 技能注册/注销 Provider
- 从 ZIP 动态加载 Provider（安全限制：仅信任来源）
- Provider 创建工具实例
- 工具列表动态变化后 LLM 能正确调用

### P0-2: load_skill 懒加载工具

**新增文件**：
- `src/core/llm/tools/load-skill.ts` — `LoadSkillTool` 实现

**修改文件**：
- `src/core/llm/tools.ts` — 注册 `load_skill` 到默认工具集
- `src/core/llm/agentic-loop.ts` — 每轮迭代前检查 `LoadSkillTool` 的 prompt 修改，注入已加载技能的 prompt
- `src/core/llm/prompt.ts` — 新增 `getPromptModification()` 钩子，支持动态注入

**关键设计**：
- 会话级缓存：同一轮内重复加载同一技能只返回确认消息
- 跨轮次保持：技能加载后保持 N 轮（默认 5 轮），超时自动卸载
- 历史恢复：从聊天历史中恢复已加载的技能状态

### P0-3: SKILL.md 解析器增强

**修改文件**：
- `src/core/skill/skill.ts` — `parseSkillMarkdown` 支持以下新增 YAML 字段：
  - `displayName` — 显示名称
  - `version` — 版本号
  - `author` — 作者
  - `tags` — 标签数组
  - `bindShells` — 绑定的 Shell 类型
  - `provider` — Provider 配置（module + class）
  - `tools` — 工具声明列表（name + provider + config）
  - `mcpServers` — MCP 服务器声明
  - `dependencies` — 依赖模块列表
  - `config` — 技能级配置

### P1-1: web_search 工具

**新增文件**：
- `src/core/llm/tools/web-search.ts` — `WebSearchTool` 实现

**修改文件**：
- `src/core/llm/tools.ts` — 注册到默认工具集
- `src/core/storage/settings.ts` — 新增搜索引擎配置存储
- `src/components/SettingsPanel.tsx` — 新增搜索引擎配置 UI

**设计要点**：
- 支持多搜索引擎配置（base_url + query_param + response_path）
- 可配置认证头
- 结果包含标题/URL/摘要/内容

### P1-2: mermaid-diagram 技能

**新增文件**：
- `skills/mermaid-diagram/SKILL.md` — 技能定义
- `skills/mermaid-diagram/provider.ts` — `MermaidToolProvider`
- `skills/mermaid-diagram/render.ts` — Mermaid 渲染工具
- `skills/mermaid-diagram/references/` — 语法参考文档

**修改文件**：
- `src/components/MessageBubble.tsx` — Mermaid 代码块渲染（使用 mermaid.js 库）
- `src/styles.css` — Mermaid 渲染样式

### P2-1: 技能上传/安装 UI

**新增文件**：
- `src/components/SkillManager.tsx` — 完整技能管理面板（替代现有只读面板）
- `src/core/skill/installer.ts` — ZIP 包解压+安装逻辑

**修改文件**：
- `src/components/Sidebar.tsx` — 技能按钮入口改为打开 SkillManager
- `src/store.ts` — 新增 `installedSkills` 状态 + `installSkill` / `uninstallSkill` actions
- `src/core/storage/` — 新增技能包文件存储

**功能要点**：
- 拖拽/选择 ZIP 文件上传
- 解压到 `~/.codem/skills/` 目录
- 自动解析 SKILL.md 并注册
- 安装进度显示
- 技能列表（已安装 / 内置 / 项目级）

---

## 九、风险与注意事项

### 9.1 安全风险

| 风险 | 参考 | 建议措施 |
|------|------|---------|
| 技能 Provider 代码执行 | Wegent 限制仅公共技能可加载代码 | 仅信任内置技能 + 用户明确确认安装的技能可加载 Provider |
| MCP 服务器安全 | Wegent 使用 task_token 认证 | MCP 连接需用户手动确认，技能仅声明不自动连接 |
| 路径遍历 | Wegent 使用 `_resolve_safe_path` | 已有 `isPathWithinWorkspace` 检查，保持现有安全策略 |

### 9.2 兼容性

- **向后兼容**：现有 6 个内置纯 prompt 技能无需改动，继续工作
- **渐进式迁移**：SkillToolProvider 是可选的，不携带工具的技能不受影响
- **配置兼容**：现有 SKILL.md 文件的 YAML frontmatter 向后兼容

### 9.3 性能影响

| 改动 | 性能影响 | 缓解措施 |
|------|---------|---------|
| load_skill 懒加载 | 正面：系统提示词缩小 | — |
| SkillToolProvider 动态加载 | 轻微：首次加载技能时有延迟 | 预加载常用技能 |
| 技能 ZIP 解压 | 一次性：安装时解压 | 异步解压 + 进度提示 |
| MCP 自动连接 | 中等：每个 MCP 连接耗时 2-5 秒 | 懒连接，仅 load_skill 时触发 |

---

## 十、UI/UX 全面对标分析（LOGO / 布局 / 加载 / 启停 / 操作）

> **说明**：聊天中的工具调用展示方式（工具渲染、进度展示、结果折叠等）采用 Codem 自有方案，体验更好，不对标修改。以下对标仅聚焦于**管理界面**：技能管理面板和 MCP 服务器管理面板的 LOGO、布局、加载方式、启停、操作等。

### 10.1 LOGO / 图标系统

#### 参考项目（Wegent）

| 场景 | 图标 | 来源 |
|------|------|------|
| 技能列表项 | `SparklesIcon` (Heroicons) 或 `Sparkles` (lucide-react) | 统一使用 Sparkles 图标 |
| 技能空状态 | `SparklesIcon` 12×12 灰色 | 与列表项图标一致 |
| 公共技能标记 | `Globe` (lucide-react) 3×3 | 地球图标表示全局可用 |
| 个人技能标记 | `User` (lucide-react) 3×3 | 用户图标表示个人 |
| 团队技能标记 | `Users` (lucide-react) 3×3 | 多人图标表示团队 |
| MCP 服务器 | `Server` (lucide-react) 4×4 | 服务器图标 |
| MCP Provider | `Server` 5×5 主色 | 同上但更大 |
| Git 来源技能 | `GitBranch` 3×3 | 分支图标表示 Git 源 |
| 技能启用状态 | `Switch` 组件（开关） | 用 Switch 而非图标 |
| 技能引用检查 | `Link2` (lucide-react) 4×4 | 链接图标 |
| 上传/编辑/删除 | `Upload` / `Pencil` / `Trash` 4×4 | 标准 CRUD 图标集 |
| 下载技能 | `Download` / `ArrowDownTray` 4×4 | 下载图标 |
| Git 更新 | `RefreshCw` 4×4 旋转动画 | 刷新图标带旋转 |
| 添加按钮 | `UnifiedAddButton` 统一组件 | 带 + 号的虚线按钮 |
| MCP 类型标签 | 文字标签 (HTTP/SSE/STDIO) | 不用图标，用文字 Tag |

**特点**：
- 全部使用 **lucide-react** 或 **heroicons** 矢量图标库，无自定义 PNG/SVG
- 图标尺寸统一：列表项 5×5，操作按钮 4×4，标记性小图标 3×3
- 图标颜色随主题自动适配，主色图标用于强调
- 公共/个人/团队用 **不同的语义图标**（Globe/User/Users）区分来源

#### 咱们项目（Codem）

| 场景 | 图标 | 评价 |
|------|------|------|
| 技能管理面板标题 | `📚` Emoji | ❌ 不专业，不随主题适配 |
| MCP 管理面板标题 | `🔌` Emoji | ❌ 同上 |
| 技能来源标记 | 纯文字颜色（无图标） | ❌ 识别度低 |
| MCP 状态指示 | `●` / `○` 文字圆点 | ⚠️ 勉强可用 |
| MCP 传输类型 | 纯文字 | ⚠️ 可接受 |
| 工具渲染（聊天中） | Emoji 字典映射 (💻📖📝✏️) | ✅ 保留，体验好 |

**差距**：
1. 管理界面使用 Emoji 而非矢量图标库，不随主题明暗切换适配
2. 缺少来源语义图标（个人/团队/公共的视觉区分）
3. 缺少 Git 来源标识图标
4. 缺少操作按钮的统一图标集

#### 对标建议

| 优先级 | 改动 | 说明 |
|--------|------|------|
| ⭐⭐⭐ | 引入 `lucide-react` 图标库 | 统一图标系统，替代管理界面的 Emoji |
| ⭐⭐⭐ | 技能/MCP 列表项使用 `Sparkles` / `Server` 图标 | 与参考项目一致的视觉语言 |
| ⭐⭐ | 来源标记使用 `Globe` / `User` / `Users` 图标 | 增强来源识别度 |
| ⭐ | Git 来源技能使用 `GitBranch` 图标 | 技能含 Git 源时显示 |
| — | 聊天中的工具渲染 Emoji 保留 | 我们的方案更好，不对标 |

---

### 10.2 布局结构

#### 参考项目（Wegent）— 技能管理

**整体布局**：双区域垂直布局

```
┌─────────────────────────────────────────────────────┐
│  AutoEnabledSkillsSection（默认启用技能区）           │
│  ┌───────────────────────────────────────────────┐  │
│  │  标题 + 计数 Badge  |  [设置] [添加] 按钮      │  │
│  │  [技能1] [技能2] [技能3] ... [+N]  (Badge 列) │  │
│  └───────────────────────────────────────────────┘  │
│                                                     │
│  ResourceManagementLayout（技能库区）                 │
│  ┌───────────────────────────────────────────────┐  │
│  │  标题 + 描述  |  [市场] [搜索] [Git更新] [上传] │  │
│  │  [来源筛选] [排序]                              │  │
│  ├───────────────────────────────────────────────┤  │
│  │  ┌──────────────────────────────────────┐     │  │
│  │  │ [Sparkles] 名称 [Tag][Tag][Tag]       │     │  │
│  │  │            描述...                     │ [启用开关] │
│  │  │            作者 • 创建时间             │ [Git更新] │
│  │  │                                       │ [下载]    │
│  │  │                                       │ [引用]    │
│  │  │                                       │ [删除]    │
│  │  └──────────────────────────────────────┘     │  │
│  │  ┌──────────────────────────────────────┐     │  │
│  │  │ (下一个技能卡片)                       │     │  │
│  │  └──────────────────────────────────────┘     │  │
│  └───────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
```

**卡片内部结构**（`Card` 组件）：
- 左侧：`ResourceListItem`（图标 + 名称 + 描述 + 标签行）
- 右侧：操作按钮区（启用开关 + 功能按钮组）
- 响应式：`flex-col` (移动端) → `sm:flex-row` (桌面端)

**标签行内容**（从左到右）：
1. 来源标签（个人/团队/公共，带颜色区分）
2. 命名空间（仅团队技能显示）
3. 版本号 `v1.0.0`
4. Git 来源标记
5. 默认启用标记
6. 自定义标签（最多 3 个，超出显示 `+N`）

#### 参考项目（Wegent）— MCP 管理

**整体布局**：嵌入式区域（非弹窗），嵌入在智能体配置表单中

```
┌─────────────────────────────────────────────────────┐
│  MCP 配置  |  [编辑 JSON] | [导入 JSON] | [Provider] │
├─────────────────────────────────────────────────────┤
│  ┌──────────────────────────────────────────────┐  │
│  │  server-name  [HTTP]                         │  │
│  │  http://...                                  │  │
│  │                          [⚙] [✕]  (hover显示) │  │
│  └──────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────┐  │
│  │  (下一个服务器)                               │  │
│  └──────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
```

**特点**：
- MCP 配置是**智能体配置的一部分**，不是独立面板
- 服务器列表用紧凑的行式卡片，操作按钮 hover 时才显示
- 支持 `compact` 模式（更紧凑的展示）
- 支持通过 JSON 编辑、JSON 导入、Provider 浏览三种方式添加

#### 咱们项目（Codem）— 技能管理

**整体布局**：单列只读面板

```
┌─────────────────────────────────────────┐
│  📚 技能管理                      [✕]   │
├─────────────────────────────────────────┤
│  [全部] [内置] [项目] [用户]  (筛选 Tab) │
├─────────────────────────────────────────┤
│  ┌───────────────────────────────────┐  │
│  │  技能名                    [来源]  │  │
│  │  描述...                           │  │
│  │  别名: a, b, c                     │  │
│  └───────────────────────────────────┘  │
│  ┌───────────────────────────────────┐  │
│  │  (下一个技能)                      │  │
│  └───────────────────────────────────┘  │
├─────────────────────────────────────────┤
│  (选中技能后右侧/下方展示详情)           │
│  描述 / 别名 / 允许工具 / 模型 / 提示词  │
└─────────────────────────────────────────┘
```

**特点**：
- 左右分栏：左侧列表 + 右侧详情（选中后展开）
- 只有筛选 Tab，无搜索框
- 卡片信息少：名称 + 来源文字 + 描述 + 别名
- 无操作按钮（纯只读）
- 无标签/版本/作者/Git 源等元信息

#### 咱们项目（Codem）— MCP 管理

**整体布局**：独立弹窗面板

```
┌─────────────────────────────────────────┐
│  🔌 MCP 服务器管理               [✕]   │
├─────────────────────────────────────────┤
│  [🔄 全部连接]  [+ 添加服务器]           │
├─────────────────────────────────────────┤
│  (添加表单，展开时显示)                   │
│  名称 / 传输方式 / URL / 命令 / 参数     │
│  [取消] [添加]                           │
├─────────────────────────────────────────┤
│  ┌───────────────────────────────────┐  │
│  │  server-name  [http]   ● 已连接   │  │
│  │  http://...                        │  │
│  │  工具: [tool1] [tool2]             │  │
│  │  [连接/断开]  [删除]               │  │
│  └───────────────────────────────────┘  │
└─────────────────────────────────────────┘
```

**特点**：
- 独立弹窗，功能完整
- 支持连接/断开/删除
- 显示工具列表和错误信息
- 添加表单是内联展开式

#### 对标建议

| 优先级 | 改动 | 说明 |
|--------|------|------|
| ⭐⭐⭐ | 技能卡片增加标签行 | 展示版本/作者/来源/Git/启用状态 |
| ⭐⭐⭐ | 技能卡片增加操作按钮区 | 上传/下载/删除/启用开关 |
| ⭐⭐ | 技能管理增加搜索框 | 支持名称/描述/标签搜索 |
| ⭐⭐ | 技能卡片改为响应式布局 | 移动端纵向，桌面端横向 |
| ⭐⭐ | MCP 管理增加 Provider 浏览 | 从 MCP Provider 一键添加服务器 |
| ⭐ | MCP 操作按钮改为 hover 显示 | 减少视觉干扰 |
| — | MCP 独立弹窗布局保留 | 我们的方式更清晰，不对标 |
| — | MCP 添加表单内联展开保留 | 我们的方式更直接，不对标 |

---

### 10.3 加载方式

#### 参考项目（Wegent）

**技能加载流程**：

```
1. 页面挂载
   ├─ fetchUnifiedSkillsList({ scope: 'all' })     → 全部技能
   ├─ fetchMyDefaultSkillBindings()                → 已启用绑定
   └─ checkSkillMarketAvailable()                  → 市场可用性

2. 数据处理
   ├─ filterVisibleSkills()                        → 过滤不可见技能
   ├─ sortResourceLibraryItems()                   → 排序（默认/名称/时间）
   └─ buildGroupDisplayNameMap()                   → 构建团队名映射

3. 渲染
   ├─ AutoEnabledSkillsSection                     → 已启用技能摘要（前5个）
   └─ ResourceManagementLayout                     → 技能库列表
```

**加载状态**：
- 全屏 Loading：`Loader2` 旋转图标 + 文字提示
- 空状态：`Sparkles` 大图标 + 提示文字 + 上传按钮
- 错误状态：红色错误文字居中

**技能懒加载（运行时）**：
```
LLM 调用 load_skill(skill_name)
  → 检查会话级缓存
    → 已缓存: 返回确认消息（不重新注入 prompt）
    → 未缓存: 调用 invokeSkill(skill_name) 获取 prompt
      → 注入到当前会话的 system prompt
      → 标记为已加载（会话级 + TTL 轮次）
```

**MCP 加载流程**：

```
1. 解析 mcpConfig JSON 字符串
   ├─ parseMcpConfig()                             → JSON → 对象
   └─ 检测解析错误                                  → 显示错误提示

2. 渲染服务器列表
   └─ Object.keys(config).map(serverName => ...)   → 逐个渲染

3. 添加服务器（三种方式）
   ├─ Provider 浏览: McpProviderBrowser             → 从 Provider 列表选择
   ├─ 手动 JSON: McpConfigAddDialog                → 粘贴 JSON 配置
   └─ JSON 导入: McpConfigImportModal              → 上传 JSON 文件
```

#### 咱们项目（Codem）

**技能加载流程**：

```
1. 页面挂载
   └─ getSkillRegistry().getAll()                  → 同步获取全部技能

2. 渲染
   └─ filter(source) → 列表渲染
```

**加载状态**：
- 无 Loading 状态（同步加载，无需等待）
- 空状态：纯文字"暂无技能"

**MCP 加载流程**：

```
1. 页面挂载
   └─ getMCPRegistry().getConfigs()                → 同步获取配置

2. 连接服务器
   └─ registry.connect(config)                     → 异步连接，返回状态
       → 显示工具列表
       → 显示错误信息
```

#### 差距分析

| 维度 | Wegent | Codem | 差距 |
|------|--------|-------|------|
| 技能加载方式 | 异步 API + 缓存 + 排序 | 同步本地注册 | 本地应用同步足够，但缺少远程加载 |
| 加载状态 | Loading spinner + 空状态引导 | 无 Loading | 本地同步不需要，但远程加载时需要 |
| 技能懒加载 | `load_skill` 工具按需加载 | 全量注入系统提示词 | ❌ 上下文浪费 |
| MCP 加载 | JSON 解析 + Provider API + 文件导入 | 本地配置 + 异步连接 | 缺少 Provider 浏览和 JSON 导入 |
| MCP 连接 | 不在 UI 管理（后端自动） | 前端手动连接/断开 | ✅ 我们的方式更透明 |

#### 对标建议

| 优先级 | 改动 | 说明 |
|--------|------|------|
| ⭐⭐⭐ | 技能懒加载（load_skill） | 仅注入名称+描述，按需加载完整 prompt |
| ⭐⭐ | 技能空状态增加引导 | 空状态时显示图标 + 上传按钮 |
| ⭐⭐ | MCP 增加 JSON 导入功能 | 支持粘贴/上传 JSON 配置 |
| ⭐ | MCP 增加 Provider 浏览 | 从已知 Provider 一键添加（需后端支持） |
| — | MCP 连接/断开保留我们的方式 | 手动连接更透明，不对标 |
| — | 技能同步加载保留 | 桌面应用本地加载足够快，不需异步 |

---

### 10.4 启停（启用/禁用）机制

#### 参考项目（Wegent）

**技能启停**：

```
                    ┌──────────────────┐
                    │  Switch 组件     │
                    │  (Toggle 开关)   │
                    └────────┬─────────┘
                             │
              ┌──────────────┼──────────────┐
              ▼              ▼              ▼
     addSkillToMyDefault  removeSkillFromMyDefault  updateMyDefaultSkillBindingExceptions
     (POST /bindings/me)  (DELETE /bindings/me)     (PATCH /bindings/me)
              │              │              │
              ▼              ▼              ▼
     技能加入默认启用    技能从默认移除    设置例外（按模式/智能体/项目）
```

**三级启停控制**：

| 级别 | 控制方式 | 说明 |
|------|---------|------|
| **全局** | Switch 开关 | 一键启用/禁用技能 |
| **模式级** | Checkbox 矩阵 | 按 chat/code/knowledge/task/video/image 模式控制 |
| **智能体级** | Checkbox 分组 | 按个人/团队/系统分组，逐个智能体控制 |
| **项目级** | 例外列表 | 按项目 ID 设置例外 |
| **强制预加载** | Switch 开关 | `force_preload` 不等 LLM 自主加载 |

**AutoEnabledSkillsSection**（默认启用技能摘要区）：
- 顶部显示已启用技能数量 Badge
- 展示前 5 个技能的名称 Chip（Badge 形式）
- 超出 5 个显示 `+N`
- 点击"设置"进入 `AutoEnabledSkillSettingsView`（表格+弹窗配置）

**AutoEnabledSkillSettingsView**（详细设置视图）：
- 表格布局：技能名 | 强制预加载 | 模式摘要 | 智能体摘要 | 例外数 | [配置]
- 点击"配置"打开 Dialog，包含：
  - 模式例外 Checkbox 网格（2列）
  - 智能体例外 Checkbox 分组（按个人/团队/系统分组）
  - 强制预加载 Switch
  - 清除例外 / 保存按钮

#### 咱们项目（Codem）

**技能启停**：无

- 所有注册的技能**全部启用**，无法单独禁用
- 无启用/禁用 UI 控件
- 无模式/智能体/项目级控制

**MCP 启停**：

```
                    ┌──────────────────┐
                    │  连接/断开按钮    │
                    └────────┬─────────┘
                             │
              ┌──────────────┼──────────────┐
              ▼              ▼              
     registry.connect()  registry.disconnect()
     (异步连接)           (异步断开)
              │              │
              ▼              ▼
     显示工具列表+状态   清除状态
```

**特点**：
- MCP 连接/断开是**手动按钮触发**，状态实时显示
- 支持"全部连接"批量操作
- 连接中显示 "连接中..." 状态
- 连接成功显示工具列表
- 连接失败显示错误信息

#### 差距分析

| 维度 | Wegent | Codem | 差距 |
|------|--------|-------|------|
| 技能启用/禁用 | Switch 开关 + 三级例外 | 无 | ❌ 重大缺失 |
| 技能默认启用摘要 | Chip 列表 + 计数 | 无 | ❌ 缺失 |
| 技能详细设置 | 表格 + 弹窗配置 | 无 | ❌ 缺失 |
| 强制预加载 | Switch 开关 | 无 | ❌ 缺失 |
| MCP 连接/断开 | 后端自动 | ✅ 前端手动 | ✅ 我们更好 |
| MCP 批量操作 | 无 | ✅ 全部连接 | ✅ 我们更好 |
| MCP 状态显示 | 无（后端管理） | ✅ 实时状态 + 工具列表 | ✅ 我们更好 |

#### 对标建议

| 优先级 | 改动 | 说明 |
|--------|------|------|
| ⭐⭐⭐ | 技能启用/禁用 Switch | 卡片右侧添加 Switch 开关 |
| ⭐⭐⭐ | 技能默认启用摘要区 | 顶部显示已启用技能 Chip 列表 |
| ⭐⭐ | 技能按模式/智能体控制 | 弹窗配置例外（简化版） |
| ⭐⭐ | 技能强制预加载开关 | 高级设置中添加 |
| — | MCP 连接/断开保留我们的方式 | 手动控制更透明，不对标 |
| — | MCP 全部连接保留 | 批量操作很实用，不对标 |

---

### 10.5 操作（CRUD + 高级操作）

#### 参考项目（Wegent）— 技能操作清单

| 操作 | UI 入口 | 交互方式 | 权限控制 |
|------|---------|---------|---------|
| **上传技能** | `UnifiedAddButton` / `ResourceCreateButton` | Dialog + 拖拽上传 + 进度条 | 个人/团队可上传 |
| **更新技能** | 卡片操作区 `Pencil` 按钮 | 同上传 Dialog（编辑模式） | 仅所有者/管理员 |
| **删除技能** | 卡片操作区 `Trash` 按钮 | AlertDialog 二次确认 + 引用冲突处理 | 仅所有者/管理员 |
| **下载技能** | 卡片操作区 `Download` 按钮 | 直接触发浏览器下载 | 非公共技能可下载 |
| **查看内容** | 卡片操作区 `Eye` 按钮 | Dialog 展示 SKILL.md 原文 | 管理员可用 |
| **编辑元数据** | 卡片操作区 `Cog` 按钮 | Dialog 表单（描述/版本/作者/标签/可见性） | 管理员可用 |
| **启用/禁用** | 卡片操作区 `Switch` 开关 | 一键切换 + Toast 反馈 | 用户级操作 |
| **查看引用** | 卡片操作区 `Link2` 按钮 | Dialog 展示被引用的智能体列表 | 所有者可用 |
| **Git 更新** | 卡片操作区 `RefreshCw` 按钮 | 单击更新 + 旋转动画 | 仅 Git 源技能 |
| **Git 批量更新** | 顶部 `RefreshCw` 按钮 | 确认 Dialog + 进度 Dialog | 有 Git 技能时显示 |
| **Git 导入** | 上传 Dialog 的 Git Tab | URL 输入 → 扫描 → 勾选 → 导入 | 个人/团队 |
| **技能市场搜索** | `SkillSearchModal` | 关键词/标签搜索 + 分页 | 市场可用时显示 |
| **跳转市场** | 顶部 `ExternalLink` 按钮 | 新窗口打开市场 URL | 市场可用时显示 |
| **筛选** | 来源筛选 + 排序 | Tab/下拉菜单 | 全局可用 |
| **上传覆盖确认** | AlertDialog | 同名技能覆盖确认 | 上传时检测 |

**删除引用冲突处理**（参考项目特色）：

```
用户点击删除
  → API 返回 SKILL_REFERENCED 错误
    → 关闭普通确认 Dialog
    → 打开 SkillReferenceConflictDialog
      → 显示引用该技能的智能体列表
      → 提供：
        1. 清除所有引用并删除
        2. 仅清除所有引用（不删除）
        3. 逐个移除引用
```

#### 参考项目（Wegent）— MCP 操作清单

| 操作 | UI 入口 | 交互方式 |
|------|---------|---------|
| **添加服务器** | `+` 按钮 / 空状态触发 | Dialog（Provider 浏览 / 手动 JSON 两个 Tab） |
| **编辑服务器** | hover 显示 `Settings` 按钮 | `SingleMcpServerEditModal` 弹窗 |
| **删除服务器** | hover 显示 `X` 按钮 | 直接删除（无确认） |
| **编辑 JSON** | 顶部"编辑 JSON"按钮 | `McpConfigEditModal` 全屏 JSON 编辑器 |
| **导入 JSON** | 顶部"导入 JSON"按钮 | `McpConfigImportModal` 文件上传 + 替换/追加 |
| **Provider 浏览** | 顶部"Provider"按钮 | `McpProviderModal` 左右分栏浏览 |
| **Provider API Key** | Provider 设置面板 | 密码输入 + 保存 + 跳转获取链接 |
| **同步 Provider** | Provider 面板"刷新"按钮 | 从 Provider 重新拉取服务器列表 |

#### 咱们项目（Codem）— 技能操作清单

| 操作 | UI 入口 | 交互方式 | 评价 |
|------|---------|---------|------|
| **查看技能** | 点击列表项 | 展开/收起详情面板 | ✅ 基本可用 |
| **筛选来源** | Tab 按钮 | 切换 all/builtin/project/user | ✅ 基本可用 |
| 上传技能 | 无 | 无 | ❌ 缺失 |
| 更新技能 | 无 | 无 | ❌ 缺失 |
| 删除技能 | 无 | 无 | ❌ 缺失 |
| 下载技能 | 无 | 无 | ❌ 缺失 |
| 启用/禁用 | 无 | 无 | ❌ 缺失 |
| 搜索技能 | 无 | 无 | ❌ 缺失 |

#### 咱们项目（Codem）— MCP 操作清单

| 操作 | UI 入口 | 交互方式 | 评价 |
|------|---------|---------|------|
| **添加服务器** | "+ 添加服务器"按钮 | 内联表单展开 | ✅ 直接方便 |
| **删除服务器** | "删除"按钮 | 直接删除 | ⚠️ 无二次确认 |
| **连接服务器** | "连接"按钮 | 异步 + 状态反馈 | ✅ 好用 |
| **断开服务器** | "断开"按钮 | 异步 + 状态更新 | ✅ 好用 |
| **全部连接** | "🔄 全部连接"按钮 | 批量异步连接 | ✅ 好用 |
| 编辑服务器 | 无 | 无 | ❌ 缺失（需删除后重建） |
| 导入 JSON | 无 | 无 | ❌ 缺失 |
| Provider 浏览 | 无 | 无 | ❌ 缺失 |

#### 差距分析

| 维度 | Wegent | Codem | 差距 |
|------|--------|-------|------|
| 技能 CRUD | 完整（上传/更新/删除/下载） | 只读 | ❌ 重大缺失 |
| 技能搜索 | 关键词/标签/分页 | 无 | ❌ 缺失 |
| 技能 Git 集成 | 扫描/导入/更新/批量更新 | 无 | ❌ 缺失 |
| 技能市场 | 搜索/下载/跳转 | 无 | ❌ 缺失 |
| 技能引用追踪 | 引用查询/清除/逐个移除 | 无 | ❌ 缺失 |
| 技能元数据编辑 | Dialog 表单 | 无 | ❌ 缺失 |
| 删除确认 | AlertDialog + 引用冲突处理 | 无 | ❌ 缺失 |
| MCP 添加 | Dialog 双 Tab + Provider | 内联表单 | ⚠️ 我们更直接但功能少 |
| MCP 编辑 | 弹窗编辑 | 无 | ❌ 缺失 |
| MCP 导入 JSON | 文件上传 + 替换/追加 | 无 | ❌ 缺失 |
| MCP 删除确认 | 无 | 无 | 双方都缺少 |
| MCP 连接/断开 | 后端自动 | ✅ 前端手动 | ✅ 我们更好 |

#### 对标建议

| 优先级 | 改动 | 说明 |
|--------|------|------|
| ⭐⭐⭐ | 技能上传（ZIP 安装） | 拖拽上传 + 进度条 + SKILL.md 解析 |
| ⭐⭐⭐ | 技能删除 + 确认 | AlertDialog 二次确认 |
| ⭐⭐⭐ | 技能启用/禁用 Switch | 卡片右侧 Switch 开关 |
| ⭐⭐⭐ | 技能搜索框 | 支持名称/描述搜索 |
| ⭐⭐ | 技能下载 | 下载已安装技能的 ZIP 包 |
| ⭐⭐ | MCP 编辑功能 | 弹窗编辑服务器配置 |
| ⭐⭐ | MCP JSON 导入 | 粘贴/上传 JSON 配置 |
| ⭐⭐ | MCP 删除二次确认 | AlertDialog 确认删除 |
| ⭐ | 技能 Git 导入 | 从 Git 仓库扫描/导入技能 |
| ⭐ | 技能元数据编辑 | Dialog 编辑描述/版本/标签 |
| — | MCP 添加表单保留内联方式 | 我们更直接，不对标 |
| — | MCP 连接/断开保留手动方式 | 我们更透明，不对标 |
| — | 技能市场搜索 | 桌面应用无后端，暂不需要 |

---

### 10.6 组件复用与设计系统

#### 参考项目（Wegent）

**UI 组件库**：基于 shadcn/ui 的完整组件集

| 组件 | 用途 | 我们是否有 |
|------|------|-----------|
| `Card` | 技能/MCP 列表项容器 | ❌ 无（用原生 div） |
| `Switch` | 技能启用/禁用开关 | ❌ 无 |
| `Badge` / `Tag` | 标签/版本/来源标记 | ❌ 无（用 span） |
| `Button` (ghost/outline/primary) | 统一按钮样式 | ❌ 无（用原生 button） |
| `Dialog` / `AlertDialog` | 弹窗 / 确认弹窗 | ❌ 无 |
| `Progress` | 上传进度条 | ❌ 无 |
| `Input` / `Label` / `Textarea` | 表单控件 | ❌ 无（用原生 input） |
| `Tabs` | 上传/Git 导入切换 | ❌ 无 |
| `Checkbox` | Git 导入技能选择 | ❌ 无 |
| `ScrollArea` | 滚动区域 | ❌ 无 |
| `Popover` | 技能选择器弹出 | ❌ 无 |
| `ResourceListItem` | 统一资源列表项 | ❌ 无 |
| `UnifiedAddButton` | 统一添加按钮 | ❌ 无 |
| `ResourceCreateButton` | 资源创建按钮 | ❌ 无 |
| `ResourceManagementLayout` | 资源管理布局 | ❌ 无 |

**设计特点**：
- 完整的设计系统，所有组件遵循统一的颜色/间距/字体规范
- `ResourceListItem` 统一了 Bot/Model/Shell/Skill 的列表项展示
- `ResourceManagementLayout` 统一了资源管理的页面布局
- 暗色/亮色主题完整适配（CSS 变量 + Tailwind）

#### 咱们项目（Codem）

**UI 组件库**：原生 HTML + CSS 变量

| 组件 | 用途 | 评价 |
|------|------|------|
| 原生 `button` | 所有按钮 | ⚠️ 样式不统一 |
| 原生 `input` / `select` | 所有表单 | ⚠️ 样式不统一 |
| CSS 类 | 布局和样式 | ⚠️ 可维护性差 |
| `Tooltip` | 悬停提示 | ✅ 已有 |
| `ConfirmDialog` | 确认弹窗 | ✅ 已有 |
| CSS 变量 | 主题色 | ✅ 已有 |

#### 对标建议

| 优先级 | 改动 | 说明 |
|--------|------|------|
| ⭐⭐⭐ | 引入 `Switch` 组件 | 技能启用/禁用开关 |
| ⭐⭐⭐ | 引入 `Tag` / `Badge` 组件 | 统一标签样式 |
| ⭐⭐ | 引入 `Card` 组件 | 统一卡片样式 |
| ⭐⭐ | 引入 `Dialog` 组件 | 弹窗（上传/删除确认/编辑） |
| ⭐⭐ | 引入 `Progress` 组件 | 上传进度条 |
| ⭐ | 引入 `Tabs` 组件 | 上传/Git 导入切换 |
| ⭐ | 引入 `Checkbox` 组件 | 技能选择 |
| — | `ResourceListItem` 抽象 | 桌面应用资源类型少，暂不需要 |

---

### 10.7 我们已有但参考项目没有的优势

| 优势 | 说明 | 是否保留 |
|------|------|---------|
| **聊天中工具渲染** | Emoji 图标字典 + 参数摘要 + 状态颜色 | ✅ 保留，不对标 |
| **MCP 手动连接/断开** | 前端实时控制连接状态 | ✅ 保留，不对标 |
| **MCP 全部连接** | 批量一键连接所有服务器 | ✅ 保留，不对标 |
| **MCP 工具列表展示** | 连接后显示可用工具列表 | ✅ 保留，不对标 |
| **MCP 错误信息展示** | 连接失败时显示具体错误 | ✅ 保留，不对标 |
| **MCP 内联添加表单** | 不需要弹窗，直接展开表单 | ✅ 保留，不对标 |
| **工具渲染注册表** | `ToolRenderRegistry` 支持自定义渲染器 | ✅ 保留，不对标 |
| **工具分组渲染** | `renderToolGrouped` 批量展示工具调用 | ✅ 保留，不对标 |

---

### 10.8 我们未涉及的调用/加载方式

经过对比分析，以下参考项目的调用方式是我们**完全没有涉及**的：

| 方式 | 参考项目实现 | 是否需要补充 |
|------|------------|------------|
| **load_skill 懒加载** | LLM 调用 `load_skill` 工具按需加载技能 prompt | ⭐⭐⭐ 需要补充 |
| **技能携带工具** | `SkillToolProvider` 让技能动态注册工具 | ⭐⭐⭐ 需要补充 |
| **技能声明 MCP 依赖** | SKILL.md 中声明 `mcpServers`，加载时自动连接 | ⭐⭐ 需要补充 |
| **技能市场搜索** | 从远程技能市场搜索/下载技能 | ⭐ 桌面应用暂不需要 |
| **Git 仓库导入** | 扫描 Git 仓库中的 SKILL.md 并批量导入 | ⭐ 可选实现 |
| **技能绑定例外** | 按模式/智能体/项目级别设置技能启用例外 | ⭐⭐ 简化版可考虑 |
| **强制预加载** | `force_preload` 不等 LLM 自主加载，直接注入 | ⭐⭐ 可考虑 |

---

## 十一、总结

### 核心结论

1. **SkillToolProvider 架构是最大差距也是最高价值改动**：没有它，所有携带工具的技能（mermaid、interactive、sandbox 等）都无法实现
2. **load_skill 懒加载是性能关键**：当前全量注入系统提示词的方式在技能增多后会严重影响性能
3. **技能管理 UI 是用户体验关键**：当前只读面板无法满足用户自定义需求
4. **平台集成类（知识库/订阅/浏览器/沙箱）优先级最低**：桌面应用场景下，这些功能需要后端支持或额外基建
5. **聊天中工具调用展示保留自有方案**：我们的 Emoji 图标 + 参数摘要 + 分组渲染体验更好，不对标修改
6. **MCP 管理保留自有方案**：手动连接/断开/全部连接/工具列表展示更透明，不对标修改

### 建议路线图

```
Week 1-2:  P0 基础架构（SkillToolProvider + load_skill + 解析器增强）
Week 3:    P1 标杆工具（web_search + mermaid-diagram）
Week 4-5:  P2 技能管理 UI（上传/安装/启用/禁用/删除 + 图标系统升级）
Week 6-8:  P3 高级技能（interactive + skill-creator + prompt-optimization）
Week 9+:   P4 平台集成（按需）
```

---

## 十二、图标对照表与知识产权声明

### 12.1 知识产权声明

> **⚠️ 重要声明**
>
> 1. **图标来源**：本项目的管理界面图标使用开源图标库 [lucide-react](https://github.com/lucide-icons/lucide)（ISC 协议），可自由使用、修改、分发。
> 2. **图标选用参考**：图标的选用（哪些场景用哪个图标）参考了对标项目 Wegent 的视觉风格，但**仅参考视觉风格，未复制任何源代码**。
> 3. **代码自主编写**：所有代码、函数名、组件结构、类型定义均为本团队**自主编写**，未复制对标项目的任何源代码、组件代码或配置文件。
> 4. **对标范围**：对标仅限于 UI/UX 设计思路和功能特性，不涉及代码层面的复制。
> 5. **聊天内工具渲染**：聊天消息中的工具调用展示继续使用 Codem 自有的 Emoji 方案，不使用 lucide-react 图标，保留差异化体验。

### 12.2 图标映射文件

图标映射文件位于：`src/core/icons/icon-map.ts`

导出结构：
- `PanelIcons` — 管理面板标题图标
- `ToolIcons` — 工具类别图标（管理界面用）
- `SkillSourceIcons` — 技能来源图标
- `ActionIcons` — 操作按钮图标
- `StatusIcons` — 状态图标
- `McpIcons` — MCP 专用图标
- `CommonIcons` — 通用图标
- `ToolEmojis` — 聊天内工具渲染 Emoji（保持现有方案不变）

辅助函数：
- `getToolIcon(name)` — 获取工具的 LucideIcon 组件
- `getSkillSourceIcon(source)` — 获取技能来源的 LucideIcon 组件
- `getStatusIcon(status)` — 获取状态的 LucideIcon 组件
- `getToolEmoji(name)` — 获取工具的 Emoji 字符串（聊天用）

### 12.3 管理面板标题图标

| 面板 | Lucide 图标 | 用途 | 对标场景 |
|------|------------|------|---------|
| 技能管理 | `Sparkles` | 面板标题、技能列表项前缀图标 | Wegent 技能列表统一使用 Sparkles |
| MCP 管理 | `Server` | 面板标题、服务器列表项前缀图标 | Wegent MCP 统一使用 Server |
| 工具管理 | `Wrench` | 面板标题（未来扩展） | 通用工具图标 |

### 12.4 工具类别图标（管理界面）

| 工具名 | Lucide 图标 | Emoji（聊天用） | 说明 |
|--------|------------|----------------|------|
| `bash` | `Terminal` | 💻 | 命令行执行 |
| `read` | `FileText` | 📖 | 读取文件 |
| `write` | `FilePlus` | 📝 | 写入文件 |
| `edit` | `FileEdit` | ✏️ | 编辑文件 |
| `glob` | `Search` | 🔍 | 文件名搜索 |
| `grep` | `Search` | 🔎 | 内容搜索 |
| `webfetch` | `Globe` | 🌐 | 网页抓取 |
| `websearch` | `Globe` | 🔍 | 网页搜索 |
| `notebook` | `BookOpen` | 📓 | 笔记本 |
| `plan` | `ClipboardList` | 📋 | 计划/任务 |
| `question` | `HelpCircle` | ❓ | 提问 |
| `actor` | `Bot` | 🤖 | 子智能体 |
| `memory` | `Brain` | 🧠 | 记忆 |
| `skill` | `Sparkles` | 🛠️ | 技能调用 |
| `workflow` | `Workflow` | 🔄 | 工作流 |
| `lsp` | `Radio` | 📡 | LSP 通信 |
| `web_search`（待开发） | `Search` | — | 网页搜索工具 |
| `read_attachment`（待开发） | `FileText` | — | 读取附件 |
| `load_skill`（待开发） | `Sparkles` | — | 懒加载技能 |
| `image_gen` | `Image` | — | 图片生成 |
| `video_gen` | `Video` | — | 视频生成 |
| `code_exec` | `Code2` | — | 代码执行 |
| `git_op` | `GitBranch` | — | Git 操作 |
| `data_export` | `Download` | — | 数据导出 |
| `data_import` | `Upload` | — | 数据导入 |
| `email` | `Mail` | — | 邮件 |
| `schedule` | `Calendar` | — | 日程 |
| `table_query` | `Table` | — | 表格查询 |
| `webhook_call` | `Webhook` | — | Webhook 调用 |
| `db_query` | `Database` | — | 数据库查询 |

### 12.5 技能来源图标

| 来源 | Lucide 图标 | 说明 | 对标场景 |
|------|------------|------|---------|
| `builtin` | `Package` | 内置技能 | Wegent 用 Package 标识内置/系统级 |
| `project` | `FolderGit2` | 项目级技能 | Wegent 用 GitBranch 标识 Git 源 |
| `user` | `User` | 用户级技能 | Wegent 用 User 标识个人技能 |
| `external` | `Globe2` | 外部/社区技能 | Wegent 用 Globe 标识公共技能 |

### 12.6 操作按钮图标

| 操作 | Lucide 图标 | 说明 | 对标场景 |
|------|------------|------|---------|
| 新增 | `Plus` | 添加按钮 | Wegent UnifiedAddButton |
| 编辑 | `Pencil` | 编辑技能/服务器 | Wegent 卡片操作区 |
| 删除 | `Trash2` | 删除技能/服务器 | Wegent 卡片操作区 |
| 刷新 | `RefreshCw` | 重载/Git更新 | Wegent Git 更新按钮（旋转动画） |
| 启用/禁用 | `Power` | 开关图标 | Wegent 用 Switch 组件，我们用 Power 图标 |
| 查看详情 | `Eye` | 查看 SKILL.md 原文 | Wegent 卡片操作区 |
| 设置 | `Settings` | 编辑元数据/配置 | Wegent 卡片操作区 Cog |
| 外部链接 | `ExternalLink` | 跳转市场/文档 | Wegent 顶部按钮 |
| 关联/绑定 | `Link2` | 查看引用关系 | Wegent 卡片操作区 |
| 密钥/认证 | `KeyRound` | API Key 配置 | Wegent Provider 设置 |
| 展开 | `ChevronDown` | 折叠面板展开 | Wegent MCP 列表 |
| 收起 | `ChevronUp` | 折叠面板收起 | Wegent MCP 列表 |
| 下载 | `ArrowDownToLine` | 下载技能 ZIP | Wegent Download/ArrowDownTray |
| 上传 | `FolderUp` | 上传技能 ZIP | Wegent Upload |
| 复制 | `Copy` | 复制配置 | 通用 |
| 确认 | `Check` | 确认/已连接 | Wegent 状态确认 |
| 关闭 | `X` | 关闭/取消/断开 | Wegent 关闭按钮 |

### 12.7 状态图标

| 状态 | Lucide 图标 | 说明 | 对标场景 |
|------|------------|------|---------|
| 加载中 | `Loader2` | 旋转动画 | Wegent 全屏 Loading |
| 成功 | `CheckCircle2` | 操作成功 | Wegent Toast |
| 失败 | `XCircle` | 操作失败 | Wegent Toast |
| 警告 | `AlertCircle` | 警告信息 | Wegent 错误提示 |
| 危险 | `AlertTriangle` | 错误/危险 | Wegent 引用冲突 |
| 等待 | `Clock` | 排队等待 | — |
| 暂停 | `PauseCircle` | 已暂停 | — |
| 运行中 | `PlayCircle` | 正在执行 | — |
| 空闲 | `CircleDashed` | 未激活 | — |

### 12.8 MCP 专用图标

| 场景 | Lucide 图标 | 说明 | 对标场景 |
|------|------------|------|---------|
| 连接 | `Plug` | MCP 连接操作 | — |
| 已连接 | `PlugZap` | MCP 连接成功状态 | — |
| 断开 | `Unplug` | MCP 断开状态 | — |
| 网络/传输 | `Network` | 传输类型标识 | — |
| 安全/权限 | `ShieldCheck` | 权限控制 | — |
| 资源列表 | `Boxes` | MCP 工具/资源列表 | Wegent 资源展示 |
| JSON 导入 | `FileJson` | JSON 配置导入 | Wegent McpConfigImportModal |
| Provider 层 | `Layers` | MCP Provider 浏览 | Wegent McpProviderModal |

### 12.9 使用示例

```tsx
import { PanelIcons, ToolIcons, ActionIcons, StatusIcons, getToolIcon } from "@/core/icons";

// 管理面板标题
function SkillManagerHeader() {
  const Icon = PanelIcons.skills; // Sparkles
  return <h2><Icon size={20} /> 技能管理</h2>;
}

// 技能列表项
function SkillItem({ name, toolName }: { name: string; toolName: string }) {
  const ToolIcon = getToolIcon(toolName); // 返回 LucideIcon 组件
  return (
    <div>
      <ToolIcon size={16} />
      <span>{name}</span>
    </div>
  );
}

// 操作按钮
function SkillActions() {
  return (
    <div>
      <button><ActionIcons.edit size={16} /></button>
      <button><ActionIcons.delete size={16} /></button>
      <button><ActionIcons.toggle size={16} /></button>
    </div>
  );
}

// 状态指示
function StatusIndicator({ status }: { status: "loading" | "success" | "error" }) {
  const Icon = StatusIcons[status];
  return <Icon size={16} className={status === "loading" ? "animate-spin" : ""} />;
}
```

### 12.10 图标尺寸规范

对标参考项目的尺寸规范，管理界面图标统一使用以下尺寸：

| 场景 | 尺寸 | Tailwind 类 |
|------|------|------------|
| 面板标题图标 | 20px | `size-5` |
| 列表项前缀图标 | 16px | `size-4` |
| 操作按钮图标 | 16px | `size-4` |
| 来源标记小图标 | 12px | `size-3` |
| 状态指示图标 | 16px | `size-4` |
| 空状态大图标 | 48px | `size-12` |

### 12.11 图标颜色规范

图标颜色跟随 CSS 变量，自动适配明暗主题：

| 场景 | CSS 变量 | 说明 |
|------|---------|------|
| 默认图标 | `var(--text-secondary)` | 次要文字色 |
| 主色图标 | `var(--accent)` | 强调色（标题、激活态） |
| 成功状态 | `var(--success)` | 绿色 |
| 错误状态 | `var(--danger)` | 红色 |
| 警告状态 | `var(--warning)` | 黄色 |
| 禁用状态 | `var(--text-muted)` | 灰色 |
