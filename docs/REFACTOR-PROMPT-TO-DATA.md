# 整改计划：从提示词约束到数据层约束

> 核心原则：**不"要求"LLM 做什么，而是"让它需要"做正确的事。**
>
> 灵感来源：Wegent（对标项目）通过数据层设计（工具注册策略、运行时环境注入、guard hook）
> 让 LLM 自然做出正确选择，而非依赖系统提示词中的"CRITICAL"、"MUST"、"NEVER"来强制行为。

---

## 一、问题诊断：当前提示词约束清单

对 `src/core/prompt/prompt.ts` 的全面审计，发现以下 **13 个提示词约束点**，按"可否用数据层替代"分类：

### A 类：可以用数据层完全替代（高优先级）

| # | 约束点 | 当前做法 | 问题 |
|---|--------|----------|------|
| 1 | **附件处理** | 提示词说"必须调 read_attachment" | ✅ 已修复（Wegent 模式） |
| 2 | **Windows 编码规则** | 150+ 行提示词教 LLM 如何处理 UTF-8/GBK | LLM 不可靠地遵循编码规则；应在运行时层处理 |
| 3 | **脚本执行规则** | 提示词说"用 workdir 不用 cd"、"先写文件再执行" | 应在 bash 工具层自动处理 |
| 4 | **Plan 模式** | 提示词说"MUST NOT write/edit" | LLM 可能忽略；应在工具注册层强制 |
| 5 | **工具调用频率** | 提示词说"write AT MOST ONCE per response" | 应在 agentic-loop 运行时层限制 |

### B 类：可以用数据层部分替代（中优先级）

| # | 约束点 | 当前做法 | 对标做法 |
|---|--------|----------|----------|
| 6 | **子智能体两步模式** | 提示词说"NEVER spawn+wait 同一 response" | 运行时拦截：如果同一 response 有 spawn+wait，拒绝 wait |
| 7 | **上下文压缩** | 提示词说"不要重做 summary 中已完成的工作" | 运行时 guard hook 自动压缩（对标项目 ContextGuard） |
| 8 | **read_attachment 条件注册** | 每次都注册工具 | 对标项目只在有文档附件时才注册 |
| 9 | **多模态意图检测** | 提示词教 LLM 识别"画图""朗读" | 工具描述应足够清晰，让 LLM 自然识别 |

### C 类：提示词仍然是最佳方案（保留）

| # | 约束点 | 原因 |
|---|--------|------|
| 10 | **语言规则** | LLM API 没有原生语言控制参数；提示词是唯一方式 |
| 11 | **格式规范** | Markdown 渲染偏好，提示词是合理方式 |
| 12 | **安全规则** | 人类价值观约束（不泄露数据等），提示词 + 运行时双重保险 |
| 13 | **完成回执** | UX 需求，提示词是合理方式 |

---

## 二、对标项目架构分析

### 2.1 Wegent 的系统提示词极简

对标项目的 `build_system_prompt()` 只做三件事：
1. 拼接 base_prompt（来自后端 Ghost 服务）
2. 可选追加 clarification 模式提示词
3. deep_thinking 模式（实际为空字符串 — 通过模型 reasoning 设置控制）

**它不在系统提示词里教 LLM 如何编码、如何调工具、如何处理 Windows 编码。** 这些全部在数据层处理。

### 2.2 Wegent 的数据层约束机制

| 机制 | 位置 | 作用 |
|------|------|------|
| **条件工具注册** | `ChatContext._build_extra_tools()` | 只有有文档附件时才注册 `ReadAttachmentTool`；只有 `enable_web_search=True` 才注册搜索工具 |
| **运行时环境注入** | `executor/src/process_environment.rs` | 在 Rust 层注入 PATH、环境变量，LLM 完全不感知 |
| **max_iterations 硬限制** | `LangGraphAgentBuilder` | `recursion_limit = max_iterations * 2 + 1`，达到限制时注入 `TOOL_LIMIT_REACHED_MESSAGE` |
| **ContextGuard pre_model_hook** | `guard/context_guard.py` | 每次 model 调用前自动压缩上下文（source-level → request-level → emergency），LLM 不需要知道 |
| **ToolOutput guard** | `guard/tool_output.py` | 工具输出自动截断为 head+tail 格式，带 `[tool_output name=xxx truncated=true]` 标注 |
| **AttachmentPreview** | `messages/attachment_preview.py` | 附件预览自动按 token 预算截断，water-filling 分配 |
| **Sandbox 模式** | `executor` Codex 集成 | `--sandbox read-only` 参数在进程层强制只读，不依赖提示词 |

---

## 三、整改计划

### P0: Windows 编码规则 → 运行时环境注入

**当前**：150+ 行提示词教 LLM 处理 UTF-8/GBK/chcp

**目标**：bash 工具在执行命令前自动设置编码环境

**改动**：
- `src/core/file-api.ts` 的 `executeCommand()` 函数中，在执行任何命令前自动 prepend：
  ```
  chcp 65001 >nul 2>&1 & set PYTHONUTF8=1 & set PYTHONIOENCODING=utf-8 & 
  ```
- LLM 不再需要知道编码细节
- 从 `prompt.ts` 中删除整个 "Windows Chinese Encoding Rules" 章节（约 50 行）
- 保留一个简短提示："系统已自动设置 UTF-8 编码环境"

**对标**：Wegent `process_environment.rs` 在 Rust 层注入环境变量，LLM 完全不感知

---

### P1: 脚本执行规则 → 工具层自动处理

**当前**：提示词教 LLM "用 workdir 不用 cd"、"先写文件再执行"

**目标**：
- bash 工具的 `workdir` 参数已经存在 — 保留但不需要提示词强调
- 当 LLM 传 `cd path && command` 时，工具自动拆分为 `workdir=path, command=command`
- 删除 "Script Execution Rules" 章节（约 15 行）

**改动**：
- `src/core/file-api.ts` 的 `executeCommand()` 中增加 `cd` 自动拆分逻辑
- 从 `prompt.ts` 删除脚本执行规则

---

### P2: Plan 模式 → 工具注册层强制

**当前**：提示词说 "MUST NOT write/edit"

**目标**：Plan 模式下不注册 write/edit/multi_edit 工具

**改动**：
- `src/core/llm/agentic-loop.ts` 中，根据 `collaborationMode` 决定注册哪些工具
- Plan 模式只注册 read/glob/grep/bash(readonly)
- 如果 LLM 尝试调用未注册的工具，API 会自然返回 "tool not found"
- 从 `prompt.ts` 删除 Plan 模式的强制约束，改为简短说明"当前为只读模式"

**对标**：Wegent Codex 集成使用 `--sandbox read-only` 在进程层强制

---

### P3: 工具调用频率限制 → 运行时层

**当前**：提示词说 "write AT MOST ONCE per response"、"STOP after write"

**目标**：
- agentic-loop 中跟踪每个 response 的 write/edit 调用次数
- 如果同一 response 中第二次调用 write，返回错误 "One write per response — use edit for modifications"
- 达到 max_iterations 时注入系统通知（对标项目的 `TOOL_LIMIT_REACHED_MESSAGE` 模式）

**改动**：
- `src/core/llm/agentic-loop.ts` 增加工具调用计数器
- 从 `prompt.ts` 删除 "Tool Call Rules" 章节中的频率限制（约 10 行）
- 保留 "verify changes by reading files" 等软建议

**对标**：Wegent `LangGraphAgentBuilder` 的 `recursion_limit` + `TOOL_LIMIT_REACHED_MESSAGE`

---

### P4: read_attachment 条件注册

**当前**：每次对话都注册 `read_attachment` 工具

**目标**：只在消息历史中存在文档附件时才注册

**改动**：
- `src/core/llm/agentic-loop.ts` 中检查当前消息的 attachments
- 如果有 `type !== "image"` 的附件，注册 `read_attachment`
- 纯图片/纯文本对话不注册

**对标**：Wegent `ChatContext._build_extra_tools()` 的 `has_attachments` 逻辑

---

### P5: 子智能体两步模式 → 运行时拦截

**当前**：提示词用 60+ 行解释 "NEVER spawn+wait 同一 response"

**目标**：
- agentic-loop 中检测：如果同一 response 同时有 `spawn_subagent` 和 `wait_for_subagent` 调用
- 拒绝执行 `wait_for_subagent`，返回错误："Cannot wait in the same response as spawn. Wait for the spawn result first."
- LLM 自然学会分两步

**改动**：
- `src/core/llm/agentic-loop.ts` 增加同 response 工具调用组合检测
- 从 `prompt.ts` 大幅精简子智能体说明（从 60 行缩减到 15 行 — 只保留用法说明）

**对标**：Wegent 没有子智能体功能，但这个模式与 `TOOL_LIMIT_REACHED_MESSAGE` 一致 — 运行时反馈替代预防性提示词

---

### P6: 上下文压缩 → 运行时自动处理

**当前**：提示词说"不要重做 summary 中已完成的工作"

**目标**：
- 已有上下文压缩逻辑（`src/core/storage/context-builder.ts`）
- 在压缩后自动注入一条系统消息："以下是之前对话的摘要，不需要重新执行已完成的工作"
- 从 `prompt.ts` 删除 "Context Management" 章节

**对标**：Wegent `ContextGuard` 在 `pre_model_hook` 中自动压缩，LLM 只看到压缩后的结果

---

### P7: 工具输出自动截断

**当前**：read 工具手动截断到 100KB，无结构化标注

**目标**：
- 所有工具输出统一走截断逻辑
- 截断时添加标注：`[tool_output name=read truncated=true total=15000chars shown=8000chars]`
- LLM 看到标注后自然知道需要翻页或缩小范围

**改动**：
- 新建 `src/core/llm/tool-output-guard.ts`
- 在 agentic-loop 的工具执行结果处统一包装
- read 工具中删除手动截断逻辑

**对标**：Wegent `guard/tool_output.py` 的 `ToolOutputGuardAdapter`

---

## 四、实施顺序

```
Phase 1（已完成）
  ✅ P-attach: 附件内联预览 + 条件工具注册

Phase 2（高优先级，1-2天）
  P0: 编码规则 → 运行时环境注入
  P1: 脚本执行 → 工具层自动处理
  P2: Plan 模式 → 工具注册层强制

Phase 3（中优先级，2-3天）
  P3: 工具调用频率 → 运行时限制
  P4: read_attachment 条件注册
  P5: 子智能体 → 运行时拦截
  P6: 上下文压缩 → 自动注入

Phase 4（低优先级，可迭代）
  P7: 工具输出截断标注
```

---

## 五、预期效果

### 提示词长度变化

| 阶段 | prompt.ts 行数 | 变化 |
|------|---------------|------|
| 整改前 | ~527 行 | - |
| Phase 2 后 | ~400 行 | -127 行（删除编码/脚本/Plan 强制） |
| Phase 3 后 | ~320 行 | -80 行（删除工具频率/子智能体/上下文管理） |
| Phase 4 后 | ~300 行 | -20 行（精简工具说明） |

### 可靠性提升

| 约束 | 整改前可靠性 | 整改后可靠性 | 原因 |
|------|-------------|-------------|------|
| 编码处理 | ~70%（LLM 可能忘记） | 100%（运行时强制） | 不依赖 LLM 遵从 |
| Plan 模式只读 | ~85%（LLM 可能忽略） | 100%（工具不存在） | API 层强制 |
| 工具频率限制 | ~75%（LLM 可能违反） | 100%（运行时拦截） | 代码层强制 |
| 附件读取 | ~60%（LLM 可能幻觉） | ~95%（内容已内联） | 数据层引导 |
| 子智能体两步 | ~80%（LLM 可能混用） | 100%（运行时拒绝） | 代码层强制 |

---

## 六、不变项（保留在提示词中）

以下内容适合留在提示词中，因为它们是 LLM 层面的行为引导，无法用数据层替代：

1. **语言规则** — LLM API 没有原生语言控制
2. **人格/风格** — "直接、不废话"等风格引导
3. **格式规范** — Markdown 渲染偏好
4. **安全价值观** — "不泄露数据"等人类价值观
5. **完成回执** — UX 需求
6. **Parallel tool calls** — 建议 LLM 并行调用（软引导，非强制）
7. **Memory 引导** — 记忆系统的使用说明
