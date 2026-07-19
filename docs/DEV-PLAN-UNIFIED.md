# Codem 统一开发计划

> 本文档是 Codem 项目的**唯一开发计划主线**，整合了以下文档的内容：
> - `ROADMAP-codex-alignment.md` — Codex 对标改进路线图（Phase 0-4 已完成）
> - `TOOLS-SKILLS-BENCHMARK.md` — 工具/技能/MCP 对标分析（P0-P4 待开发）
> - `UI-UX-Wegent-Benchmark.md` — UI/UX 对标分析（4 批次已执行）
> - `TODO.md` — 待办事项跟踪
>
> 创建时间：2026-07-15 | 最后更新：2026-07-15

---

## 一、项目定位与架构约束

### 1.1 项目定位

**Codem** 是对标 Codex Windows 客户端的 AI 编程助手桌面应用。

- **核心目标**：与 Codex 一样，**不需要安装任何依赖，一键安装即可运行**
- **目标用户**：Windows 平台开发者
- **分发方式**：NSIS `.exe` 安装包 + WiX `.msi` 安装包

### 1.2 架构约束（不可违反）

```
┌─────────────────────────────────────────────────────────────┐
│                    Codem 安装包结构                           │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Codem.exe (Tauri 原生二进制)                                │
│  ├── Rust 后端 (lib.rs)           — 文件操作/窗口/通知        │
│  ├── 前端静态资源 (dist/)         — React 编译产物            │
│  │   ├── JS/CSS 全部编译打包      — 无运行时依赖              │
│  │   ├── sql.js (WebAssembly)     — SQLite 引擎              │
│  │   └── 所有 npm 依赖已 tree-shake 打包                     │
│  └── Sidecar Server (server.exe)  — pkg 编译的独立可执行文件   │
│      ├── node-pty (原生模块)      — 终端 PTY                 │
│      └── WebSocket + HTTP API     — 文件/终端/MCP 代理        │
│                                                             │
│  用户安装后：                                                │
│  ✅ 不需要 Node.js                                           │
│  ✅ 不需要 Python                                            │
│  ✅ 不需要 Docker                                            │
│  ✅ 不需要任何运行时依赖                                      │
│  ✅ 双击 .exe/.msi 安装，桌面快捷方式启动                     │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 1.3 依赖分类规则

所有新增依赖必须满足以下分类之一：

| 分类 | 说明 | 对架构影响 | 示例 |
|------|------|-----------|------|
| **构建时前端依赖** | npm 包，编译时打包进 `dist/`，运行时不存在 | ✅ 无影响 | `lucide-react`, `mermaid`, `fflate` |
| **纯 TypeScript 代码** | 新增 `.ts/.tsx` 文件，编译时打包 | ✅ 无影响 | `SkillToolProvider`, `load_skill` |
| **Sidecar 原生模块** | 需编译进 `server.exe`，需 `pkg` 支持 | ⚠️ 需验证 | `node-pty`（已有） |
| **Rust 后端扩展** | 修改 `lib.rs`，编译进 Tauri 二进制 | ✅ 无影响 | 路径校验、文件操作 |
| **❌ 运行时外部依赖** | 需要用户安装的软件/服务 | ❌ 禁止 | Docker、Python、Node.js |

---

## 二、架构影响分析：对标优化是否影响一键安装？

### 结论：**不影响。所有对标优化均在架构约束范围内。**

### 逐项分析

| 对标优化项 | 依赖类型 | 运行时需求 | 架构影响 | 结论 |
|-----------|---------|-----------|---------|------|
| `lucide-react` 图标库 | 构建时前端依赖 | 无 | 无 | ✅ 已安装，SVG 编译进 bundle |
| `SkillToolProvider` 架构 | 纯 TypeScript | 无 | 无 | ✅ 代码层面的抽象层 |
| `load_skill` 懒加载工具 | 纯 TypeScript | 无 | 无 | ✅ 新增工具函数 |
| `SKILL.md` 解析器增强 | 纯 TypeScript | 无 | 无 | ✅ 改进现有解析逻辑 |
| `web_search` 工具 | 纯 TypeScript + HTTP API | 无 | 无 | ✅ 同 LLM API 调用方式 |
| `read_attachment` 工具 | 纯 TypeScript | 无 | 无 | ✅ 文件读取已有 |
| `mermaid-diagram` 技能 | 构建时前端依赖 (`mermaid.js`) | 无 | 前端 bundle +~500KB | ✅ 可接受 |
| 技能 ZIP 上传/安装 | 构建时前端依赖 (`fflate` ~8KB) | 无 | 无 | ✅ 或用 Tauri Rust 解压 |
| `Switch`/`Dialog`/`Badge` 组件 | 构建时前端依赖 (`@radix-ui`) | 无 | 无 | ✅ 已有 Radix 基础 |
| MCP 管理改进 | 纯 TypeScript + UI | 无 | 无 | ✅ MCP 集成已有 |
| `interactive` 表单技能 | 纯 TypeScript + React UI | 无 | 无 | ✅ 前端组件 |
| `conversation_to_prompt` | 纯 TypeScript | 无 | 无 | ✅ 纯 prompt 技能 |
| `prompt-optimization` | 纯 TypeScript | 无 | 无 | ✅ 纯 prompt 技能 |
| `skill-creator` | 纯 TypeScript + 脚本 | 无 | 无 | ✅ 纯 prompt + 脚本 |

### 需要排除的对标项（违反架构约束）

| 对标项 | 排除原因 | 替代方案 |
|--------|---------|---------|
| ❌ Docker 沙箱环境 | 需要 Docker 运行时 | 保留现有路径白名单沙箱（S5 已完成） |
| ❌ 知识库 RAG 检索 | 需要后端向量数据库 | 保留现有 Embedding 语义搜索（已完成） |
| ❌ 浏览器自动化 | 需要浏览器扩展 | 暂不做，非核心编程场景 |
| ❌ 订阅任务管理 | 需要后端调度服务 | 纳入远期 Work 模式 |
| ✅ 技能市场（Rust 代理） | Tauri Rust 层 HTTP 代理绕过 CSP | 已实现 http_get/http_download 命令 |

---

## 三、已完成阶段总览

### Phase A：Codex 核心对标（已完成 ✅）

> 对应 `ROADMAP-codex-alignment.md` Phase 0-4，全部完成。

| 阶段 | 内容 | 状态 |
|------|------|------|
| Phase 0 | 类型与接口层（LoopConfig/LLMRequest/AgentDefinition 字段） | ✅ 完成 |
| Phase 1 | 基础设施通电（E1 模型路由 + F1 记忆系统 + S1/S2 安全） | ✅ 完成 |
| Phase 2 | 核心效率 + 安全 + 协作模式（E2-E8 + F2/F3 + S3/S4 + C1） | ✅ 完成 |
| Phase 3 | 混合模型系统（M1 Profile + F3.1/F3.2 记忆整合） | ✅ 完成 |
| Phase 4 | 精细化 + 多模态（F3.3/F3.5 + S5 + TTS/ImageGen/Embedding） | ✅ 完成 |

**已具备的核心能力**：
- ✅ 多模型路由 + 推理力度 + 成本降级
- ✅ 三级记忆系统（project/session/global）+ 自动提取 + 脱敏 + 整合
- ✅ 五层安全防护（覆写保护/受保护路径/apply_patch/Diff审查/路径白名单）
- ✅ Default/Plan 协作模式切换
- ✅ 多模态（TTS 语音合成 / ImageGen 图片生成 / Embedding 语义搜索）
- ✅ 增量消息构建 + 智能上下文选择 + Prompt Caching
- ✅ 文件缓存 + 工具并发扩展 + 参数安全扫描
- ✅ 中英文双语 i18n
- ✅ 显示模式切换（分段/统一）

### UI/UX 对标（已完成 ✅）

> 对应 `UI-UX-Wegent-Benchmark.md`，4 批次已执行。

- ✅ 消息气泡优化
- ✅ 侧边栏改进
- ✅ 设置面板改进
- ✅ 输入区改进

### 图标系统（已完成 ✅）

> 对应 `TOOLS-SKILLS-BENCHMARK.md` 第十二章。

- ✅ 安装 `lucide-react`
- ✅ 创建 `src/core/icons/icon-map.ts` 图标映射
- ✅ 文档化图标对照表 + 知识产权声明

---

## 四、统一开发路线图

### 总览

```
Phase A (DONE)     Phase B (NEXT)       Phase C              Phase D            Phase E (FUTURE)
Codex 核心对标  →   工具/技能基础架构  →  技能管理UI  →        高级技能  →         Work模式
                   P0 + P1              P2                   P3                 ROADMAP Phase 5
                   1-2周                1周                  2-3周              2-3周
```

---

### Phase B：工具/技能基础架构（1-2周）

> 对应 `TOOLS-SKILLS-BENCHMARK.md` P0 + P1
> **目标**：建立技能携带工具的架构基础，让后续技能可以按需添加。

#### B1：SKILL.md 解析器增强（0.5天）

| 项 | 说明 |
|----|------|
| 优先级 | P0-3 |
| 依赖 | 无 |
| 涉及文件 | `src/core/skill/skill.ts` |

**改动内容**：
- `SkillDefinition` 新增字段：`displayName`、`version`、`author`、`tags`、`bindShells`、`provider`、`tools`、`mcpServers`、`dependencies`、`config`
- `parseSkillMarkdown()` 支持解析新增 YAML 字段
- 向后兼容：现有 SKILL.md 文件无需改动

#### B2：SkillToolProvider 架构（2-3天）

| 项 | 说明 |
|----|------|
| 优先级 | P0-1 |
| 依赖 | B1 |
| 涉及文件 | 新增 `src/core/skill/provider.ts`、`src/core/skill/context.ts`、`src/core/skill/registry.ts`；修改 `src/core/skill/skill.ts`、`src/core/llm/agentic-loop.ts`、`src/core/llm/prompt.ts` |

**改动内容**：
- 新增 `SkillToolProvider` 抽象接口：技能可声明自定义工具
- 新增 `SkillToolContext` 依赖注入容器
- 新增 `SkillToolRegistry` 管理 Provider 注册/注销
- `agentic-loop.ts` 工具执行前检查动态加载的工具
- `prompt.ts` 技能部分改为只输出名称+描述（不含完整 prompt）

**关键设计**：
- Provider 是可选的，不携带工具的纯 prompt 技能不受影响
- 安全限制：仅内置技能 + 用户明确确认安装的技能可加载 Provider

#### B3：load_skill 懒加载工具（1-2天）

| 项 | 说明 |
|----|------|
| 优先级 | P0-2 |
| 依赖 | B2 |
| 涉及文件 | 新增 `src/core/llm/tools/load-skill.ts`；修改 `src/core/llm/tools.ts`、`src/core/llm/agentic-loop.ts` |

**改动内容**：
- 新增 `load_skill` 工具：LLM 按需加载技能 prompt
- 会话级缓存：同一轮内重复加载同一技能只返回确认消息
- 跨轮次保持：技能加载后保持 N 轮（默认 5），超时自动卸载
- 历史恢复：从聊天历史中恢复已加载的技能状态

#### B4：web_search 工具（1天）

| 项 | 说明 |
|----|------|
| 优先级 | P1-1 |
| 依赖 | 无（可与 B1-B3 并行） |
| 涉及文件 | 新增 `src/core/llm/tools/web-search.ts`；修改 `src/core/llm/tools.ts`、`src/core/storage/settings.ts`、`src/components/SettingsPanel.tsx` |

> **注**：`ROADMAP-codex-alignment.md` 曾将 Web 搜索列入"不做清单"，理由是"与核心编程助手定位不符"。但在工具/技能对标分析中发现，web_search 对编程场景（搜索文档、错误解决方案、API 用法）非常有价值，且不违反架构约束（仅需 HTTP API 调用，与 LLM API 调用方式一致）。因此纳入计划。

**改动内容**：
- 支持多搜索引擎配置（base_url + query_param + response_path）
- 可配置认证头
- 结果包含标题/URL/摘要/内容

#### B5：read_attachment 工具（1天）

| 项 | 说明 |
|----|------|
| 优先级 | P1-3 |
| 依赖 | 无（可与 B1-B4 并行） |
| 涉及文件 | 新增 `src/core/llm/tools/read-attachment.ts`；修改 `src/core/llm/tools.ts` |

**改动内容**：
- 分页读取附件提取文本
- token 限制分页
- 支持常见文件格式（PDF/Word/Excel 等需评估依赖）

#### B6：mermaid-diagram 技能（2天）

| 项 | 说明 |
|----|------|
| 优先级 | P1-2 |
| 依赖 | B2（SkillToolProvider） |
| 涉及文件 | 新增 `skills/mermaid-diagram/` 目录；修改 `src/components/MessageBubble.tsx`、`src/styles.css` |

**改动内容**：
- `SKILL.md` 技能定义
- `MermaidToolProvider` 工具提供者
- `render_mermaid` 渲染工具 + `read_mermaid_reference` 参考文档工具
- 前端 Mermaid 代码块渲染（使用 `mermaid.js` 库，构建时打包）

**价值**：作为 SkillToolProvider 架构的首个示范技能，展示技能携带工具的能力。

#### Phase B 验收标准

- [ ] SKILL.md 支持新增字段解析
- [ ] 技能可声明 Provider 并动态注册工具
- [ ] LLM 可通过 `load_skill` 按需加载技能
- [ ] `web_search` 工具可用
- [ ] `read_attachment` 工具可用
- [ ] mermaid-diagram 技能可渲染图表
- [ ] 现有纯 prompt 技能不受影响（向后兼容）
- [ ] 安装包大小增幅 < 2MB
- [ ] 一键安装运行不受影响

---

### Phase C：技能管理 UI（1周）

> 对应 `TOOLS-SKILLS-BENCHMARK.md` P2
> **目标**：用户可以安装/管理技能，管理界面使用 lucide-react 图标。

#### C1：UI 组件基础设施（0.5天）

| 项 | 说明 |
|----|------|
| 依赖 | 无 |
| 涉及文件 | 新增 `src/components/ui/Switch.tsx`、`src/components/ui/Dialog.tsx`、`src/components/ui/Badge.tsx`、`src/components/ui/Card.tsx`、`src/components/ui/Progress.tsx` |

**改动内容**：
- 基于 `@radix-ui` 封装 Switch/Dialog 组件
- 原生实现 Badge/Card/Progress 组件
- 所有组件使用 CSS 变量，自动适配明暗主题
- 使用 `src/core/icons/icon-map.ts` 中的图标

#### C2：技能上传/安装（2天）

| 项 | 说明 |
|----|------|
| 依赖 | B1（解析器增强）、C1（UI 组件） |
| 涉及文件 | 重构 `src/components/SkillManager.tsx`；新增 `src/core/skill/installer.ts`；修改 `src/store.ts`、`src/components/Sidebar.tsx` |

**改动内容**：
- 拖拽/选择 ZIP 文件上传
- ZIP 解压到 `~/.codem/skills/` 目录（使用 `fflate` 库，构建时打包 ~8KB）
- 自动解析 SKILL.md 并注册
- 安装进度显示
- 覆盖确认（同名技能）

#### C3：技能启用/禁用（1天）

| 项 | 说明 |
|----|------|
| 依赖 | C1（Switch 组件） |
| 涉及文件 | 修改 `src/components/SkillManager.tsx`、`src/core/skill/skill.ts`、`src/store.ts` |

**改动内容**：
- 技能卡片右侧添加 Switch 开关
- 启用/禁用状态持久化到 SQLite
- 禁用的技能不注入系统提示词、不出现在 `load_skill` 可选列表

#### C4：技能删除 + 搜索（1天）

| 项 | 说明 |
|----|------|
| 依赖 | C2 |
| 涉及文件 | 修改 `src/components/SkillManager.tsx`、`src/core/skill/skill.ts` |

**改动内容**：
- 删除按钮 + AlertDialog 二次确认
- 搜索框（支持名称/描述/标签搜索）
- 来源筛选保留

#### C5：MCP 管理改进（1天）

| 项 | 说明 |
|----|------|
| 依赖 | C1（Dialog 组件） |
| 涉及文件 | 修改 `src/components/McpManager.tsx` |

**改动内容**：
- 新增服务器编辑功能（弹窗编辑配置）
- 新增 JSON 配置导入（粘贴/上传 JSON）
- 删除操作增加二次确认
- 保留现有手动连接/断开/全部连接方式（我们的优势）

#### C6：管理界面图标替换（0.5天）

| 项 | 说明 |
|----|------|
| 依赖 | 无 |
| 涉及文件 | `src/components/SkillManager.tsx`、`src/components/McpManager.tsx` |

**改动内容**：
- Emoji 替换为 `lucide-react` 图标（使用 `src/core/icons/icon-map.ts`）
- 聊天内工具渲染 Emoji 保留（我们的优势，不对标）

#### Phase C 验收标准

- [ ] 用户可上传 ZIP 安装技能
- [ ] 技能可启用/禁用
- [ ] 技能可删除（带确认）
- [ ] 技能可搜索
- [ ] MCP 服务器可编辑配置
- [ ] MCP 支持 JSON 导入
- [ ] 管理界面使用 lucide-react 图标
- [ ] 聊天内工具渲染 Emoji 不变
- [ ] 一键安装运行不受影响

---

### Phase D：高级技能（2-3周）

> 对应 `TOOLS-SKILLS-BENCHMARK.md` P3
> **目标**：补齐高价值技能，达到参考项目的技能丰富度。

#### D1：conversation_to_prompt 技能（0.5天）

| 项 | 说明 |
|----|------|
| 依赖 | B1（解析器增强） |
| 类型 | 纯 prompt 技能 |

将对话转为可复用系统提示词。

#### D2：prompt-optimization 技能（2天）

| 项 | 说明 |
|----|------|
| 依赖 | B2（SkillToolProvider） |
| 类型 | prompt + MCP 技能 |

查看/修改 AI 系统提示词。

#### D3：interactive 表单技能（3天）

| 项 | 说明 |
|----|------|
| 依赖 | B2、C1（Dialog 组件） |
| 类型 | MCP 技能 + UI |

向用户展示选择/输入表单，支持交互式数据收集。

#### D4：skill-creator 技能（3天）

| 项 | 说明 |
|----|------|
| 依赖 | B2、C2（技能上传） |
| 类型 | prompt + 脚本技能 |

创建/改进/评估技能，含 eval 框架。

#### Phase D 验收标准

- [x] 4 个高级技能可用
- [x] 每个技能有对应的 SKILL.md 和（如有）Provider
- [x] 技能可被 `load_skill` 懒加载
- [x] 一键安装运行不受影响

**Phase D 完成摘要（2026-07-16）：**

| 技能 | 类型 | 文件 | 状态 |
|------|------|------|------|
| conversation-to-prompt | 纯 prompt | `skills/conversation-to-prompt/SKILL.md` + `skill.ts` 注册 | ✅ |
| prompt-optimization | prompt + Provider | `PromptOptimizationProvider` + `PromptChangeReviewDialog` + 全链路接线 | ✅ |
| interactive | prompt + Provider | `InteractiveFormProvider` + `InteractiveFormDialog` + 全链路接线 | ✅ |
| skill-creator | prompt + 脚本 | `references/schemas.md` + `agents/*.md` + `scripts/*.ts` eval 框架 | ✅ |

新增类型定义：`PromptChange`、`InteractiveFormQuestion`、`InteractiveFormOption`（`tools.ts`）
新增 ToolContext 回调：`getSystemPrompt`、`onPromptChangeSubmit`、`onInteractiveForm`
编译验证：`tsc --noEmit` 零错误，`npm run build` 成功

---

### Phase F：笔记本式知识管理（NotebookLM 模式，3-4周）

> **目标**：对标 Google NotebookLM 的知识管理模式，用户创建「笔记本」，上传文件进行知识化处理，在笔记本内进行知识问答对话。
> **核心约束**：不破坏一键安装，不新增运行时依赖，全部使用本地 SQLite + 已有 Embedding API。

#### NotebookLM 模式分析

**NotebookLM 的核心设计**：

```
┌───────────────────────────────────────────────────────────────┐
│                    NotebookLM 架构                              │
├───────────────────────────────────────────────────────────────┤
│                                                               │
│  1. 笔记本 (Notebook) = 知识容器                                │
│     └── 用户创建多个笔记本，每个笔记本是独立的知识域             │
│                                                               │
│  2. 来源 (Source) = 上传的文件/链接                             │
│     ├── PDF / Google Docs / Google Slides                     │
│     ├── 粘贴文本                                               │
│     ├── 网页 URL                                               │
│     ├── YouTube 视频 URL                                      │
│     └── 音频文件                                               │
│                                                               │
│  3. 知识化处理 (Processing)                                    │
│     ├── 自动提取文本                                           │
│     ├── 分块 (Chunking)                                       │
│     ├── 生成 Embedding 向量                                    │
│     └── 自动生成摘要                                           │
│                                                               │
│  4. 对话 (Chat) = 在笔记本知识范围内问答                        │
│     ├── 语义检索相关片段                                       │
│     ├── 将片段注入 LLM 上下文                                   │
│     ├── 响应中标注来源引用                                      │
│     └── 建议问题 (Guided Questions)                            │
│                                                               │
│  5. 知识隔离                                                   │
│     └── 每个笔记本的对话仅使用该笔记本内的知识                   │
│                                                               │
└───────────────────────────────────────────────────────────────┘
```

**Codem 实现映射**：

| NotebookLM 概念 | Codem 实现 | 复用已有能力 |
|----------------|-----------|-------------|
| Notebook | SQLite `notebooks` 表 | `database.ts` SCHEMA 扩展 |
| Source | SQLite `notebook_sources` 表 | `attachments` 表概念复用 |
| Chunking | 纯 TypeScript 文本分块 | 无新依赖 |
| Embedding | `multimodal.ts generateEmbeddings()` | ✅ 已有 |
| 向量存储 | SQLite `notebook_chunks` 表 (BLOB) | sql.js 已有 |
| 语义检索 | `cosineSimilarity()` 内存计算 | ✅ 已有 |
| 笔记本对话 | 系统 prompt 注入检索片段 | `prompt.ts` 扩展 |
| 来源引用 | 响应后处理标注 | `MessageBubble.tsx` 渲染 |
| 摘要 | LLM 生成 + 存储 | `agentic-loop` 模式复用 |
| 建议问题 | LLM 根据来源生成 | 纯 prompt |

**为什么可以不破坏一键安装**：

| 需求 | 方案 | 是否新增依赖 |
|------|------|------------|
| 向量数据库 | SQLite BLOB 存储 embedding 数组 | ❌ 无（sql.js 已有） |
| Embedding 生成 | OpenAI-compatible API 远程调用 | ❌ 无（multimodal.ts 已有） |
| 文本分块 | 纯 TypeScript 实现 | ❌ 无 |
| 文本提取 | .txt/.md/.code 直接读；PDF 用 `pdfjs-dist`(构建时打包) | ⚠️ 可选 |
| URL 内容获取 | Rust `http_get` 命令 | ❌ 无（已实现） |
| 文件存储 | Tauri `write_file`/`read_file` | ❌ 无（已实现） |

#### F1：数据模型（SQLite 表结构扩展）（1天）

| 项 | 说明 |
|----|------|
| 优先级 | F-P0 |
| 依赖 | 无 |
| 涉及文件 | `src/core/storage/database.ts` (SCHEMA 扩展)；新增 `src/core/knowledge/storage.ts` |

**新增表结构**：
```sql
-- 笔记本表
CREATE TABLE IF NOT EXISTS notebooks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  summary TEXT,           -- 自动生成的摘要
  summary_status TEXT DEFAULT 'pending',  -- pending/generating/completed/failed
  source_count INTEGER DEFAULT 0,
  chunk_count INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 来源表（上传的文件/文本/URL）
CREATE TABLE IF NOT EXISTS notebook_sources (
  id TEXT PRIMARY KEY,
  notebook_id TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,     -- file/text/url
  content TEXT,            -- 原始内容（文本类）
  file_path TEXT,          -- 文件路径（文件类）
  url TEXT,                -- URL（URL类）
  mime_type TEXT,
  size INTEGER,
  status TEXT DEFAULT 'pending',  -- pending/processing/indexed/failed
  chunk_count INTEGER DEFAULT 0,
  error_message TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (notebook_id) REFERENCES notebooks(id) ON DELETE CASCADE
);

-- 文本块表（分块后的文本 + embedding 向量）
CREATE TABLE IF NOT EXISTS notebook_chunks (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  notebook_id TEXT NOT NULL,
  content TEXT NOT NULL,           -- 分块文本
  chunk_index INTEGER NOT NULL,    -- 在来源中的序号
  embedding BLOB,                  -- Float32Array 序列化
  token_count INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (source_id) REFERENCES notebook_sources(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_notebook_sources_notebook ON notebook_sources(notebook_id);
CREATE INDEX IF NOT EXISTS idx_notebook_chunks_notebook ON notebook_chunks(notebook_id);
CREATE INDEX IF NOT EXISTS idx_notebook_chunks_source ON notebook_chunks(source_id);
```

#### F2：文本提取与分块引擎（2天）

| 项 | 说明 |
|----|------|
| 优先级 | F-P0 |
| 依赖 | F1 |
| 涉及文件 | 新增 `src/core/knowledge/extractor.ts`、`src/core/knowledge/chunker.ts` |

**文本提取器 (`extractor.ts`)**：
- `.txt`/`.md`/`.json`/`.csv`/`.yaml`/`.xml` → 直接 `readFile()`
- `.ts`/`.js`/`.py`/`.java`/`.go`/`.rs`/`.c`/`.cpp` → 直接 `readFile()`
- 粘贴文本 → 直接使用
- URL → 通过 Rust `http_get` 获取 HTML → 提取正文（简易 HTML→Text）
- PDF → `pdfjs-dist`（构建时打包，~300KB gzip ~100KB）**可选**
- 其他二进制 → 不支持，提示用户

**分块器 (`chunker.ts`)**：
```typescript
// 分块策略（纯 TypeScript，无依赖）
interface ChunkConfig {
  maxChunkSize: number;   // 默认 512 tokens (~2000 字符)
  overlapSize: number;    // 默认 50 tokens (~200 字符)
  splitByParagraph: boolean;  // 优先按段落分
}

// 策略：
// 1. 按双换行符分段
// 2. 超过 maxChunkSize 的段落按句子分割
// 3. 每个块添加 overlapSize 的重叠
// 4. 估算 token_count（字符数 / 4 近似）
```

#### F3：Embedding 索引管道（2天）

| 项 | 说明 |
|----|------|
| 优先级 | F-P0 |
| 依赖 | F1、F2 |
| 涉及文件 | 新增 `src/core/knowledge/indexer.ts`；修改 `src/core/llm/multimodal.ts`（支持批量） |

**索引管道**：
```
上传来源 → 文本提取 → 分块 → 批量 Embedding → 存储到 SQLite
```

**关键设计**：
- Embedding 批量调用：复用 `generateEmbeddings()`，每批最多 100 个文本块
- 向量序列化：`Float32Array` → `Uint8Array` → Base64 存储
- 向量反序列化：Base64 → `Uint8Array` → `Float32Array`
- 进度回调：每个来源处理完成后通知 UI
- 错误恢复：单个来源失败不影响其他来源
- 增量索引：新增来源只处理新内容，不重新索引已有来源

#### F4：语义检索引擎（1天）

| 项 | 说明 |
|----|------|
| 优先级 | F-P0 |
| 依赖 | F1、F3 |
| 涉及文件 | 新增 `src/core/knowledge/retriever.ts` |

**检索流程**：
```
用户问题 → generateEmbeddings(query) → 
加载笔记本所有 chunk embedding → 
cosineSimilarity 排序 → 返回 top-K 片段
```

**关键设计**：
- Top-K 默认 5（可配置）
- 相似度阈值过滤（默认 0.3）
- 返回片段内容 + 来源名称 + 来源 ID（用于引用标注）
- 支持 hybrid 检索：语义 + 关键词（可选，后续优化）
- 缓存查询 embedding（同一问题不重复调用 API）

#### F5：笔记本对话集成（2天）

| 项 | 说明 |
|----|------|
| 优先级 | F-P1 |
| 依赖 | F4 |
| 涉及文件 | 修改 `src/core/prompt/prompt.ts`、`src/core/llm/agentic-loop.ts`、`src/core/llm/tools.ts`；新增 `src/core/llm/tools/search-notebook.ts` |

**对话集成方式**：

1. **系统 Prompt 注入**：当用户在笔记本模式下对话时，系统 prompt 中注入笔记本信息：
```
# Knowledge Context
You are chatting within a knowledge notebook named "{notebookName}".
This notebook contains {sourceCount} sources with {chunkCount} indexed text segments.
{autoGeneratedSummary}

When answering questions:
- Use the notebook's knowledge as primary source
- Cite sources using [Source: name] format
- If the question is outside the notebook's scope, clearly state so
- Use the search_notebook tool to find relevant information
```

2. **自动检索**：每轮对话开始前，自动检索 top-K 相关片段并注入上下文
3. **`search_notebook` 工具**：LLM 可主动调用进行更精准的检索
4. **来源引用**：响应中标注 `[Source: filename]`，前端渲染为可点击的引用标记

#### F6：笔记本管理 UI（3天）

| 项 | 说明 |
|----|------|
| 优先级 | F-P1 |
| 依赖 | F1-F5 |
| 涉及文件 | 新增 `src/components/NotebookManager.tsx`、`src/components/NotebookDetail.tsx`、`src/components/NotebookChat.tsx`；修改 `src/App.tsx`、`src/components/Sidebar.tsx`、`src/styles.css` |

**UI 结构**：
```
┌─────────────────────────────────────────────────────┐
│  侧边栏                                             │
│  ├── 📁 项目列表                                     │
│  ├── 💬 会话列表                                     │
│  └── 📓 笔记本列表  ← 新增                           │
│      ├── 我的API文档                                 │
│      ├── React学习笔记                               │
│      └── + 新建笔记本                                │
├─────────────────────────────────────────────────────┤
│  笔记本详情视图                                       │
│  ┌─────────────┬─────────────────────────────────┐  │
│  │ 来源列表     │  对话区域                        │  │
│  │ ├── api.pdf  │  ┌──────────────────────────┐  │  │
│  │ ├── notes.md │  │ User: 这个API怎么用？      │  │  │
│  │ └── + 添加   │  │ AI: 根据[api.pdf]，...     │  │  │
│  │              │  │   [Source: api.pdf p.3]   │  │  │
│  │ 摘要:        │  └──────────────────────────┘  │  │
│  │ 自动生成...   │  ┌──────────────────────────┐  │  │
│  │              │  │ 建议问题:                  │  │  │
│  │ 统计:        │  │ • 这个API支持哪些参数？    │  │  │
│  │ 3 来源       │  │ • 有没有错误处理示例？    │  │  │
│  │ 127 片段     │  └──────────────────────────┘  │  │
│  └─────────────┴─────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
```

**核心交互**：
- **笔记本列表**：侧边栏新增「📓 笔记本」分区，显示所有笔记本
- **创建笔记本**：输入名称 + 描述，创建空笔记本
- **来源管理**：拖拽文件 / 粘贴文本 / 输入 URL，自动开始索引
- **索引状态**：来源卡片显示处理状态（pending → processing → indexed）
- **笔记本摘要**：索引完成后自动生成摘要
- **笔记本对话**：点击笔记本进入对话视图，对话范围限定在该笔记本内
- **来源引用**：AI 响应中显示来源引用，点击可跳转到来源原文
- **建议问题**：空对话时显示基于来源内容生成的建议问题

#### F7：PDF 文本提取（可选，1天）

| 项 | 说明 |
|----|------|
| 优先级 | F-P2 |
| 依赖 | F2 |
| 涉及文件 | 修改 `src/core/knowledge/extractor.ts`；`package.json` 新增 `pdfjs-dist` |

**说明**：
- `pdfjs-dist` 是 Mozilla 的 PDF.js 库，构建时打包，无运行时依赖
- 体积 ~300KB（gzip ~100KB），可接受
- 如果用户不需要 PDF 支持，可跳过此项，仅支持文本类来源
- 使用 Web Worker 解析 PDF，不阻塞 UI

#### F8：笔记本设置与配置（1天）

| 项 | 说明 |
|----|------|
| 优先级 | F-P2 |
| 依赖 | F6 |
| 涉及文件 | 修改 `src/components/SettingsPanel.tsx`；新增 `src/components/NotebookSettings.tsx` |

**配置项**：
- Embedding 模型配置（复用 Multimodal 设置）
- 分块参数配置（chunk size、overlap）
- 检索参数配置（top-K、相似度阈值）
- 笔记本存储路径配置

#### Phase F 验收标准

- [x] 用户可创建/删除/重命名笔记本
- [x] 用户可上传文件/粘贴文本/输入 URL 作为来源
- [x] 来源自动分块并生成 Embedding 索引
- [x] 索引过程中显示进度状态
- [x] 笔记本内对话仅使用该笔记本的知识
- [x] AI 响应标注来源引用
- [x] 空对话时显示建议问题
- [x] 笔记本自动生成摘要
- [x] Embedding 未配置时给出明确提示
- [x] 一键安装运行不受影响
- [x] 安装包大小增幅 < 1MB（PDF 支持使用纯 TypeScript 实现，零额外依赖）

---

### Phase E：Work 模式拆分（远期，2-3周）

> 对应 `ROADMAP-codex-alignment.md` Phase 5
> **前提**：Phase B-D + F 全部完成，架构稳定。

| 编号 | 名称 | 说明 |
|------|------|------|
| E1 | 模式切换器 | UI 顶层 Codex/Notebook/Work 模式切换 |
| E2 | Work 系统提示词 | 调研/文档导向的独立提示词 |
| E3 | Work 工具集 | Web 搜索/文档生成/信息整理（禁用编程工具） |
| E4 | 项目制上下文 | 对话+文件+指令绑定为项目单元 |
| E5 | 计划任务 | 定时/触发/监控变化的任务调度 |
| E6 | 人机协作迭代 | 任务运行中途暂停/审查/调整方向 |
| E7 | 用量池共享 | Codex/Notebook/Work 共享同一用量池 |

---

## 五、明确不做清单

| 项目 | 原因 | 替代方案 |
|------|------|---------|
| Docker 沙箱环境 | 需 Docker 运行时，违反一键安装约束 | 路径白名单沙箱（S5 已完成） |
| ~~知识库 RAG 后端~~ | ~~需后端向量数据库服务~~ | ✅ Phase F 笔记本式知识管理（本地 SQLite + Embedding API） |
| 浏览器自动化 | 需浏览器扩展，非核心编程场景 | 暂不做 |
| 订阅任务管理 | 需后端调度服务 | 纳入 Phase E Work 模式 |
| ~~技能市场（远程）~~ | ~~需后端服务~~ | ✅ 已通过 Rust HTTP 代理实现 |
| OS 级 Sandbox | Windows Sandbox API 投入产出比低 | 路径白名单 + 受保护路径 |
| Codex Cloud 远程执行 | 需云端基础设施 | 本地执行 |
| Code Mode（V8 运行时） | 架构改动过大，ROI 低 | 不做 |
| Git Worktree 隔离 | Tauri 下管理复杂 | 快照系统已提供回滚 |
| 自定义 Agent TOML | ROI 低 | 内置 Agent + Model Profile |
| Hooks 外部命令框架 | GUI 用户不写脚本 | PermissionManager 已覆盖 |
| Chronicle 截屏 | macOS 专属 | 不做 |

---

## 六、版本发布计划

| 版本 | 阶段 | 内容 | 预估时间 |
|------|------|------|---------|
| v0.81 | Phase B | 工具/技能基础架构 | +2周 |
| v0.82 | Phase C | 技能管理 UI | +1周 |
| v0.83 | Phase D (部分) | mermaid + conversation_to_prompt | +1周 |
| v0.84 | Phase D (部分) | interactive + prompt-optimization | +2周 |
| v0.85 | Phase D (完成) | skill-creator | +1周 |
| v0.86 | Phase D (扩展) | 技能市场（Rust HTTP 代理） | +1周 |
| v0.87 | Phase F (核心) | 笔记本式知识管理：数据模型+分块+索引+检索+对话 | +3周 |
| v0.88 | Phase F (完善) | 笔记本 UI 优化 + PDF 支持 + 建议问题 | +1周 |
| v1.0 | Phase E | Work 模式（远期） | +3周 |

### 发布流程

```
1. git commit + git tag vX.XX + git push origin master --tags
2. npm run tauri build  →  构建 NSIS .exe + WiX .msi
3. gh release create vX.XX --title "..." --notes-file release-notes.md
4. gh release upload vX.XX  →  上传 .exe + .msi
```

---

## 七、文件索引（按 Phase 分类）

### Phase B 涉及文件

| 文件 | 操作 | 内容 |
|------|------|------|
| `src/core/skill/skill.ts` | 修改 | SkillDefinition 新增字段 + 解析器增强 |
| `src/core/skill/provider.ts` | **新增** | SkillToolProvider 抽象接口 |
| `src/core/skill/context.ts` | **新增** | SkillToolContext 依赖注入 |
| `src/core/skill/registry.ts` | **新增** | SkillToolRegistry 管理 |
| `src/core/llm/tools/load-skill.ts` | **新增** | load_skill 工具实现 |
| `src/core/llm/tools/web-search.ts` | **新增** | web_search 工具实现 |
| `src/core/llm/tools/read-attachment.ts` | **新增** | read_attachment 工具实现 |
| `src/core/llm/tools.ts` | 修改 | 注册新工具 |
| `src/core/llm/agentic-loop.ts` | 修改 | 动态工具加载 + prompt 注入 |
| `src/core/llm/prompt.ts` | 修改 | 技能部分改为只输出名称+描述 |
| `skills/mermaid-diagram/` | **新增** | mermaid 技能包 |
| `src/components/MessageBubble.tsx` | 修改 | Mermaid 代码块渲染 |

### Phase C 涉及文件

| 文件 | 操作 | 内容 |
|------|------|------|
| `src/components/ui/Switch.tsx` | **新增** | Switch 组件 |
| `src/components/ui/Dialog.tsx` | **新增** | Dialog 组件 |
| `src/components/ui/Badge.tsx` | **新增** | Badge 组件 |
| `src/components/ui/Card.tsx` | **新增** | Card 组件 |
| `src/components/ui/Progress.tsx` | **新增** | Progress 组件 |
| `src/components/SkillManager.tsx` | 重构 | 完整管理面板 |
| `src/components/McpManager.tsx` | 修改 | 编辑/JSON导入/图标替换 |
| `src/core/skill/installer.ts` | **新增** | ZIP 安装逻辑 |
| `src/store.ts` | 修改 | 技能管理状态 |
| `src/components/Sidebar.tsx` | 修改 | 技能入口 |
| `src/styles.css` | 修改 | 新组件样式 |

### Phase D 涉及文件

| 文件 | 操作 | 内容 |
|------|------|------|
| `skills/conversation-to-prompt/` | **新增** | 对话转提示词技能 |
| `skills/prompt-optimization/` | **新增** | 提示词优化技能 |
| `skills/interactive/` | **新增** | 交互式表单技能 |
| `skills/skill-creator/` | **新增** | 技能创建器 |
| `src/components/InteractiveFormDialog.tsx` | **新增** | 表单渲染组件（D3） |
| `src/components/PromptChangeReviewDialog.tsx` | **新增** | 提示词变更审查组件（D2） |

### 技能市场扩展涉及文件

| 文件 | 操作 | 内容 |
|------|------|------|
| `src-tauri/src/lib.rs` | 修改 | 新增 `http_get` + `http_download` Tauri command |
| `src/core/skill/skill-market-client.ts` | **新增** | 市场客户端：搜索/下载/安装逻辑 + 4个默认源 |
| `src/core/skill/index.ts` | 修改 | 导出市场客户端 API |
| `src/core/icons/icon-map.ts` | 修改 | 新增 `Store`、`Star` 图标 + `MarketIcons` |
| `src/components/SkillManager.tsx` | 重构 | 新增「技能市场」Tab + 搜索/安装 UI |
| `src/styles.css` | 修改 | 新增市场 Tab、卡片网格、安装按钮等样式 |

### Phase F 涉及文件

| 文件 | 操作 | 内容 |
|------|------|------|
| `src/core/storage/database.ts` | 修改 | SCHEMA 新增 notebooks/notebook_sources/notebook_chunks 三张表 |
| `src/core/knowledge/storage.ts` | **新增** | 笔记本 CRUD：创建/删除/重命名/列表/详情 |
| `src/core/knowledge/extractor.ts` | **新增** | 文本提取器：文件/文本/URL/PDF → 纯文本 |
| `src/core/knowledge/chunker.ts` | **新增** | 文本分块器：段落+句子分割+重叠窗口 |
| `src/core/knowledge/indexer.ts` | **新增** | 索引管道：提取→分块→Embedding→存储，含进度回调 |
| `src/core/knowledge/retriever.ts` | **新增** | 语义检索：query embedding + cosine 相似度 + top-K |
| `src/core/knowledge/types.ts` | **新增** | 类型定义：Notebook/Source/Chunk/RetrievalResult |
| `src/core/knowledge/index.ts` | **新增** | 模块导出 |
| `src/core/llm/tools/search-notebook.ts` | **新增** | `search_notebook` 工具：LLM 主动检索笔记本知识 |
| `src/core/llm/tools.ts` | 修改 | 注册 `search_notebook` 工具 |
| `src/core/llm/agentic-loop.ts` | 修改 | 笔记本模式下自动注入检索结果到上下文 |
| `src/core/prompt/prompt.ts` | 修改 | 笔记本模式系统提示词：知识范围声明 + 引用格式 |
| `src/components/NotebookManager.tsx` | **新增** | 笔记本列表页：创建/删除/搜索笔记本 |
| `src/components/NotebookDetail.tsx` | **新增** | 笔记本详情页：来源管理 + 对话 + 摘要 + 建议问题 |
| `src/components/NotebookChat.tsx` | **新增** | 笔记本对话组件：复用 ChatPanel 逻辑 + 来源引用渲染 |
| `src/components/Sidebar.tsx` | 修改 | 侧边栏新增「📓 笔记本」分区 |
| `src/App.tsx` | 修改 | 笔记本模式路由 + 状态管理 |
| `src/styles.css` | 修改 | 笔记本管理 UI 样式 |
| `package.json` | 修改 | 可选新增 `pdfjs-dist`（PDF 支持） |

---

## 八、关键设计决策

### 8.1 为什么 web_search 从"不做"改为"做"

`ROADMAP-codex-alignment.md` 曾将 Web 搜索列入不做清单，理由是"与核心编程助手定位不符"。重新评估后：

1. **编程场景需要搜索**：搜索文档、错误解决方案、API 用法是高频需求
2. **零架构影响**：仅需 HTTP API 调用，与 LLM API 调用方式一致
3. **用户可控**：搜索引擎可在设置中配置或关闭
4. **对标项目有**：Wegent 内置 `web_search` 工具

### 8.2 为什么保留聊天内 Emoji 工具渲染

管理界面使用 `lucide-react` 矢量图标（专业、随主题适配），但聊天内的工具调用展示保留 Emoji 方案：

1. **体验更好**：Emoji 在聊天消息中更直观、更生动
2. **差异化**：不与对标项目完全一致
3. **性能更好**：Emoji 是 Unicode 字符，无需渲染 SVG 组件
4. **已有方案成熟**：`ToolEmojis` 映射 + `DefaultToolRenderer` 已完善

### 8.3 为什么 ZIP 解压用 fflate 而非 Tauri Rust

1. **前端可控**：解压逻辑在 JS 层，无需修改 Rust 后端
2. **体积小**：`fflate` 仅 ~8KB，构建时打包
3. **跨平台一致**：不依赖系统 ZIP 工具
4. **备选方案**：如需更高性能可后续迁移到 Rust 后端

### 8.4 为什么 mermaid.js 可接受

1. **构建时打包**：编译进前端 bundle，无运行时依赖
2. **体积可控**：mermaid.js ~500KB，gzip 后 ~150KB，可接受
3. **按需加载**：可配置为动态 import，仅在使用 mermaid 技能时加载
4. **高价值**：图表渲染是编程场景的常见需求

### 8.6 笔记本式知识管理架构方案（NotebookLM 模式）

**核心问题**：如何在不破坏一键安装、不新增运行时依赖的前提下实现 NotebookLM 式的知识管理？

**方案**：本地 SQLite 存储向量 + 远程 Embedding API + 内存余弦相似度检索。

**为什么可行**：
1. **向量存储不需要专门数据库**：embedding 向量本质是 `Float32Array`，序列化为 BLOB 存入 SQLite 即可。一个 1536 维向量 = 6KB，1000 个块 = 6MB，SQLite 轻松处理。
2. **Embedding 生成不需要本地模型**：复用已有的 `generateEmbeddings()` API 调用（与 LLM API 调用方式一致），不增加任何运行时依赖。
3. **语义检索不需要向量索引**：对于笔记本级别的数据量（几百到几千个块），内存中遍历计算 `cosineSimilarity()` 耗时 < 10ms，不需要 ANN 索引。
4. **文本分块不需要 NLP 库**：段落分割 + 句子分割用正则即可，效果接近专业分块器。
5. **文件存储已有**：Tauri 的 `write_file`/`read_file` 命令已实现。

**与 NotebookLM 的对比**：

| 特性 | NotebookLM | Codem 笔记本 |
|------|-----------|-------------|
| 来源类型 | PDF/Docs/URL/YouTube/Audio | 文本/代码/URL/PDF(可选) |
| 向量存储 | 云端 | 本地 SQLite BLOB |
| Embedding | 云端模型 | 用户配置的 API |
| 检索 | 云端 | 内存余弦相似度 |
| 对话隔离 | 是 | 是 |
| 来源引用 | 是 | 是 |
| 摘要 | 是 | 是 |
| 建议问题 | 是 | 是 |
| 音频概览 | 是 | ❌ 暂不做 |
| 离线可用 | 否 | 部分（检索可用，Embedding 需联网） |
| 数据隐私 | 云端 | ✅ 全部本地 |

**数据流**：
```
用户上传文件
  ↓
文本提取 (extractor.ts)
  ├── .txt/.md/.code → 直接读取
  ├── URL → Rust http_get → HTML → 纯文本
  └── .pdf → pdfjs-dist → 纯文本 (可选)
  ↓
文本分块 (chunker.ts)
  ├── 按段落分割
  ├── 超长段落按句子分割
  └── 添加重叠窗口
  ↓
批量 Embedding (multimodal.ts generateEmbeddings)
  ↓
存储到 SQLite (notebook_chunks 表, embedding BLOB)
  ↓
自动生成摘要 (LLM 调用)
  ↓
[索引完成]

用户提问
  ↓
query Embedding (generateEmbeddings)
  ↓
加载笔记本所有 chunk embedding
  ↓
cosineSimilarity 排序 → top-K 片段
  ↓
注入 LLM 上下文 + 来源信息
  ↓
LLM 生成回答 (标注来源引用)
```

### 8.5 技能市场架构方案（B+C：Rust HTTP 代理）

**问题**：前端 CSP 限制了 `connect-src`，无法直接 `fetch` 外部 API（如 GitHub API）。

**方案**：在 Rust 层新增 `http_get` 和 `http_download` 两个 Tauri command，利用已有的 `reqwest` 依赖代理 HTTP 请求。

**为什么选择此方案**：
1. **零新增依赖**：`reqwest` 已在 `Cargo.toml` 中，复用现有依赖
2. **不破坏一键安装**：Rust 命令编译进二进制，无运行时依赖
3. **绕过 CSP**：Rust 层 HTTP 请求不受前端 CSP 限制
4. **安全可控**：所有请求通过 Tauri IPC，可审计、可限制
5. **GitHub API 免认证**：未认证请求 60次/小时，满足浏览需求

**默认市场源（预填）**：
1. **Anthropic Skills** — `anthropics/skills` GitHub 仓库（目录型）
2. **GitHub Agent Skills** — 搜索 `topic:agent-skills` 仓库
3. **GitHub SKILL.md Repos** — 搜索含 SKILL.md 的仓库
4. **Codem 内置技能** — 展示本地已安装的内置技能

---

## 九、Phase G — 本地嵌入模型 (ONNX Runtime + 小型 BERT)

### 9.1 背景与目标

在 Phase F（笔记本式知识管理）的基础上，为知识库检索提供**完全离线**的嵌入向量生成能力。
无需 API Key、无需网络（首次使用后），降低使用门槛，同时保持"一键安装"目标不受影响。

### 9.2 三大风险及缓解措施

#### 风险1：超长切片截断（>512 token）

**问题**：Transformer 模型有最大序列长度限制（通常 512 token），超长文本被截断后丢失尾部内容。

**缓解方案**：
- 在 `local-embedding.ts` 内部实现 `subChunkForEmbedding()` 函数
- 将超长文本拆分为 **≤128 token** 的小片段（设为 128 而非 512 的原因：小模型在短文本上表现更稳定，降低内存占用，避免截断边界效应）
- 拆分策略：句子优先 → 逐句累积达 128 token 切出 → 单句超限按字符硬切
- 多个子片段分别生成向量后通过 **mean pooling + L2 归一化** 合并为一个向量
- `indexer.ts` 在本地模式下使用更小的批次（10 vs 100），控制并发量

**涉及文件**：
| 文件 | 修改内容 |
|------|---------|
| `src/core/knowledge/local-embedding.ts` | 新增 `subChunkForEmbedding()`、`meanPoolEmbeddings()`、`estimateTokenCount()`、`splitBySentences()` |
| `src/core/knowledge/indexer.ts` | 本地模式 `BATCH_SIZE = 10` |

#### 风险2：领域冷门术语偏差

**问题**：通用 MiniLM 模型在技术/工控领域的冷门术语上表现不佳。

**缓解方案**：
提供 7 个多领域模型选择，用户可按知识库领域选择最优模型：

| 模型 | 领域 | 大小 | 维度 | 特点 |
|------|------|------|------|------|
| all-MiniLM-L6-v2 | general | ~23MB | 384 | 通用推荐，速度最快 |
| all-MiniLM-L12-v2 | general | ~33MB | 384 | 层数更多，精度更高 |
| **bge-small-zh-v1.5** | **chinese** | ~48MB | 512 | 中文检索 SOTA，技术术语覆盖优秀 |
| **bge-small-en-v1.5** | **english** | ~67MB | 384 | 英文检索专用，代码文档表现好 |
| **multilingual-e5-small** | **multilingual** | ~120MB | 384 | 微软 E5 系列，混合中英文推荐 |
| **gte-small** | **technical** | ~33MB | 384 | Alibaba GTE，技术领域泛化好 |
| paraphrase-multilingual-MiniLM-L12-v2 | multilingual | ~46MB | 384 | 改写/相似度匹配场景 |

BGE/E5/GTE 模型均在检索任务上专门微调，比通用 MiniLM 在技术领域表现更优。

**涉及文件**：
| 文件 | 修改内容 |
|------|---------|
| `src/core/knowledge/local-embedding.ts` | 扩展 `AVAILABLE_LOCAL_MODELS`，新增 `ModelDomain` 类型、`recommendModelByDomain()` |
| `src/core/llm/multimodal.ts` | `MULTIMODAL_MODELS.local.embedding` 列出全部本地模型 |
| `src/components/MultimodalPanel.tsx` | 本地模型选择器 + 领域/维度/许可标签展示 |

#### 风险3：Windows 打包轻量化

**问题**：ONNX Runtime 可能引入重量级深度学习框架，增大打包体积。

**缓解方案 — 打包内置策略**：

核心原则：**默认 WASM 运行时 + 默认模型随安装包打包，安装后离线可用，真正一键安装。**

1. **WASM 运行时随包打包**：`onnxruntime-web` 的 WASM 文件（~25MB）拷贝到 `public/wasm/`，随安装包分发
2. **默认模型随包打包**：`all-MiniLM-L6-v2` 量化模型（~22MB）下载到 `public/models/`，随安装包分发
3. **仅使用 WASM 后端**：不引入 `onnxruntime-node` 原生绑定
4. **非默认模型按需下载**：BGE/E5/GTE 等模型从 HuggingFace Hub 下载，缓存在 IndexedDB
5. **动态 import**：`@huggingface/transformers` 在使用时才动态导入，不影响首屏加载
6. **量化模型**：使用 INT8 量化版本，体积减小 ~4x
7. **Vite 配置优化**：
   - `optimizeDeps.exclude: ["@huggingface/transformers"]` — 防止预打包导致 WASM 路径错误
   - `assetsInclude: ["**/*.wasm"]` — 确保 WASM 文件正确处理为静态资源
8. **CSP 配置**：保留 `huggingface.co` 用于非默认模型下载，不含 CDN
9. **无原生依赖**：`package.json` 不包含 `onnxruntime-node`、`onnxruntime` 等原生绑定包

**体积影响**：安装包增加约 47MB（WASM 25MB + 模型 22MB），用户安装后完全离线可用。

**涉及文件**：
| 文件 | 修改内容 |
|------|---------|
| `vite.config.ts` | 新增 `optimizeDeps.exclude`、`assetsInclude`、`worker.format` |
| `src-tauri/tauri.conf.json` | CSP 配置（HuggingFace 用于非默认模型） |
| `src/core/knowledge/local-embedding.ts` | `allowLocalModels=true`、`localModelPath='/models/'`、`wasmPaths='/wasm/'` |
| `public/wasm/ort-wasm-simd-threaded.jsep.wasm` | 新增，ONNX Runtime WASM 运行时（~25MB） |
| `public/models/Xenova/all-MiniLM-L6-v2/` | 新增，默认模型文件（~22MB） |

### 9.3 默认回退机制

当用户未配置任何 Embedding API 时，`generateEmbeddings()` 自动回退到本地 ONNX Runtime 模式：

```
generateEmbeddings(params)
  │
  ├── config 为 null 或未启用?
  │     └── YES → 自动使用 getDefaultLocalEmbeddingConfig()
  │               → providerId='local', model='Xenova/all-MiniLM-L6-v2'
  │
  ├── providerId === 'local'?
  │     └── YES → 动态 import local-embedding.ts
  │               → 从 /models/ 加载内置模型（离线可用）
  │               → 从 /wasm/ 加载 ONNX Runtime（离线可用）
  │
  ├── isGeminiProvider?
  │     └── YES → Gemini native API
  │
  └── default → OpenAI-compatible endpoint
```

用户无需任何配置即可使用知识库检索功能。如需更高精度，可在设置中切换到远程 API 或其他本地模型。

### 9.4 本地模式路由架构

```
generateEmbeddings(params)
  │
  ├── providerId === 'local' && enabled?
  │     ├── YES → 动态 import local-embedding.ts
  │     │         ├── initLocalEmbedding(modelId)  ← 按需加载/缓存
  │     │         └── generateLocalEmbeddings(texts)
  │     │              └── subChunkForEmbedding(text)  ← 风险1缓解
  │     │                   └── pipeline(sub) → mean pooling → 合并
  │     └── NO ↓
  │
  ├── isGeminiProvider?
  │     └── YES → Gemini native API
  │
  └── default → OpenAI-compatible endpoint
```

### 9.5 维度不匹配保护

当用户切换嵌入模型后（如从 OpenAI 1536维 切换到本地 BGE 512维），旧 chunk 向量与新 query 向量维度不一致。

`retriever.ts` 新增维度检查：
- 过滤出与 query 维度一致的 chunk
- 全部不匹配时返回空结果 + 控制台警告（提示用户重新索引）
- 部分不匹配时跳过不匹配的 chunk + 控制台警告

### 9.6 UI 交互流程

1. 用户在 `设置 → 多模态 → Embedding` 中选择 Provider 下拉框的"🖥️ 本地模型 (ONNX Runtime)"
2. API Key 和 Base URL 字段自动隐藏
3. 显示本地模型选择器（7 个模型，带领域标签和大小）
4. 显示模型详情（维度、语言、许可、描述）
5. 显示模型加载状态指示器（未加载/加载中/就绪/错误）
6. 首次使用知识库检索时自动触发模型下载和初始化

### 9.7 文件索引

| 文件 | 类型 | 说明 |
|------|------|------|
| `src/core/knowledge/local-embedding.ts` | 新建 | 本地嵌入引擎，含三大风险缓解 |
| `src/core/llm/multimodal.ts` | 修改 | 新增 `isLocalEmbeddingProvider()`、`getDefaultLocalEmbeddingConfig()`、`isUsingLocalEmbedding()`、本地路由、`MULTIMODAL_MODELS.local` |
| `src/core/knowledge/indexer.ts` | 修改 | 本地模式批次大小调整 |
| `src/core/knowledge/retriever.ts` | 修改 | 维度不匹配保护 |
| `src/components/MultimodalPanel.tsx` | 修改 | 本地模型选择 UI + 默认回退提示 |
| `vite.config.ts` | 修改 | WASM 打包优化 |
| `src-tauri/tauri.conf.json` | 修改 | CSP 配置 |
| `public/wasm/` | 新增 | ONNX Runtime WASM 运行时（~25MB） |
| `public/models/Xenova/all-MiniLM-L6-v2/` | 新增 | 默认模型文件（~22MB） |

---

## 十、知识产权声明

> 1. **图标来源**：管理界面图标使用开源库 [lucide-react](https://github.com/lucide-icons/lucide)（ISC 协议），可自由使用。
> 2. **图标选用参考**：图标的选用参考了对标项目的视觉风格，但**仅参考视觉风格，未复制任何源代码**。
> 3. **代码自主编写**：所有代码、函数名、组件结构、类型定义均为本团队**自主编写**，未复制对标项目的任何源代码。
> 4. **对标范围**：对标仅限于 UI/UX 设计思路和功能特性，不涉及代码层面的复制。
> 5. **聊天内工具渲染**：继续使用 Codem 自有的 Emoji 方案，不使用 lucide-react 图标。
