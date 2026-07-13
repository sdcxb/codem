# Codex 对标改进路线图（统一版）

> 基于 Codex 官方手册（Chronicle / AGENTS.md / Memory / Hooks / Subagents / Model Selection / Collaboration Modes / Code Mode / Sandbox）与本项目代码的逐项对比分析。
> 创建时间：2026-07-09 | 最后更新：2026-07-10

---

## 一、对标总结（参考）

### 1. AGENTS.md 机制

| 特性 | Codex | 咱们现状 | 差距 |
|------|-------|---------|------|
| 分层发现 | 全局 → 项目根 → 子目录逐层 | ✅ `loadHierarchicalProjectInstructions` 三层 | 一致 |
| override 机制 | `AGENTS.override.md` 优先 | ✅ 每层先查 override | 一致 |
| 合并顺序 | 根到 cwd，近者优先 | ✅ 一致 | 一致 |
| 字节上限 | `project_doc_max_bytes = 32768`，可配 | ⚠️ 32KB 硬编码 | 需可配 |
| fallback 文件名 | `project_doc_fallback_filenames` | ❌ 只支持 `AGENTS.md` | 需补充 |
| project root 检测 | 向上查找 `.git` 等 marker | ❌ 依赖用户手动指定 | 需补充 |

### 2. 记忆系统

| 特性 | Codex | 咱们现状 | 差距 |
|------|-------|---------|------|
| 自动提取 | 会话空闲后后台提取 | ✅ `extractMemoriesFromSession` 存在 | ⚠️ 从不自动触发 |
| 脱敏 | 自动 redact secrets | ❌ 无 | 需补充 |
| 跨会话整合 | `consolidation_model` | ❌ 无 | 需补充 |
| 编辑能力 | 文件直接编辑 | ❌ 只读面板 | 需加编辑/新增 |
| 导出/导入 | 文件天然可移植 | ❌ 无 | 需补充 |

**核心问题**：`extractMemoriesFromSession` 方法已实现但**从不自动调用**，记忆系统代码完整但实际不工作。

### 3. 执行效率

| Codex 机制 | 说明 | 咱们现状 |
|------------|------|---------|
| **多模型路由** | 主线程 `gpt-5.5`，探索子智能体自动用 `mini` | ❌ `AgentDefinition.model` 定义了但 `getAgenticLoop()` 从不读取 |
| **推理力度** | `model_reasoning_effort: low\|medium\|high` | ❌ 只有 temperature，每次"满力" |
| **上下文隔离** | 子智能体独立上下文，只返回摘要 | ✅ 已有子智能体 fork 机制 |
| **并行子智能体** | `max_threads = 6` | ✅ 已有，`maxConcurrent = 5` |
| **工具并发** | 只读工具默认并行 | ⚠️ 并发范围过窄（仅 `read/glob/grep`） |
| **Prompt Caching** | API 层面缓存系统提示词 | ❌ 无 |
| **成本感知** | 接近预算自动降级 | ❌ `CostTracker.checkLimits()` 只 warn |

### 4. Chronicle / Hooks / 自定义 Agent

- **Chronicle**：macOS 专属截屏功能，不适用 Windows，暂不实施。
- **Hooks**：不做外部命令框架（GUI 用户不写脚本），提取有价值的内置功能分配到改进项中。
- **自定义 Agent TOML**：ROI 低，内置 6 个 Agent 覆盖 95% 场景。

### 5. ChatGPT Work 模式 vs Codex 模式 ⭐ 新增（2026-07-10 更新）

> **来源**：OpenAI 官方帮助文章 [ChatGPT Work and Codex](https://help.openai.com/articles/20001275)（2026-07-10 更新）
>
> 2026年7月10日，OpenAI 将 Codex 与 ChatGPT 整合到一个 App 中。ChatGPT 现在包含三种体验：**Chat**、**Work**、**Codex**，用户可以在桌面端通过左上角的模式切换器切换。

#### 5.1 三种体验对比

| 维度 | Chat | ChatGPT Work | Codex |
|------|------|-------------|-------|
| **定位** | 快速问答、搜索、头脑风暴 | 长时间调研、创建交付物 | 软件开发和技术工作的专用 Agent |
| **典型任务** | 问问题、搜索、闲聊 | 调研主题、分析信息、创建文档/表格/演示文稿/报告/Site | 写代码、代码审查、重构、迁移 |
| **可用平台** | Web、Mobile、Desktop | Web、Mobile（云端运行）；Desktop（可访问本地文件） | **仅 Desktop**（可操作本地文件夹、仓库、终端、开发工具） |
| **上下文机制** | 对话级上下文 | **项目制**：项目将相关对话、文件和指令组织在一起 | **仓库制**：基于本地文件夹/仓库的上下文 |
| **迭代机制** | 单轮对话 | **计划任务**：可一次性运行、按计划重复、或监控变化触发；用户可审查进度、回答问题、调整方向、批准重要操作 | **Agentic Loop**：自主工具调用循环，多轮迭代执行 |
| **文件访问** | 无本地文件 | Desktop 可访问本地文件（需授权）；Web/Mobile 不可 | 直接操作本地文件夹和仓库 |
| **运行位置** | 云端 | Web/Mobile 云端运行；Desktop 本地运行 | 本地运行 |
| **用量池** | 独立 | 与 Codex 共享同一 agentic usage 池 | 与 Work 共享同一 agentic usage 池 |
| **数据同步** | Web ↔ Desktop 同步 | Web/Mobile 对话留在云端；Desktop 线程和本地文件保留在本机 | Desktop 任务不出现在 Web；可通过 Mobile App 的 Remote 标签页远程访问 |

#### 5.2 关键差异分析

**① 上下文隔离不同**
- **Work**：以「项目」为组织单元，项目将相关对话、文件和指令绑定在一起。Web/Mobile 的 Work 对话在云端，Desktop 的 Work 线程在本地，两者目前不互通。
- **Codex**：以「本地文件夹/仓库」为上下文单元。直接打开本地项目目录，访问仓库文件、终端、开发工具。

**② 迭代机制不同**
- **Work**：支持「计划任务」（Scheduled Tasks），可以一次性运行、定时重复、或基于触发器运行。用户可以在任务运行过程中审查进度、回答问题、改变方向、批准重要操作——是一种**人机协作的迭代**。
- **Codex**：使用 **Agentic Loop**——AI 自主进行多轮工具调用（读文件→分析→写代码→运行测试→修复），独立完成端到端任务。Codex 的开源代码中还有 `CollaborationMode`（Default/Plan/Execute/PairProgramming）控制行为风格，但这是 Codex 内部的子模式，不是 Work vs Codex 的区别。

**③ 执行环境不同**
- **Work**：Web/Mobile 端在云端运行；Desktop 端可访问本地文件和桌面应用（需用户授权）。
- **Codex**：仅在 Desktop 运行，直接操作本地文件夹、仓库、终端和开发工具。

**④ Codex 内部的 CollaborationMode（开源代码层面）**

除了产品层面的 Work vs Codex 区分，Codex 开源代码中还有 `CollaborationMode` 系统（`ModeKind`），控制 Codex 内部的行为风格：

| 模式 | TUI 可见 | 核心行为 |
|------|:---------:|---------|
| **Default** | ✅ | 自主执行：做合理假设，不问问题，直接干活 |
| **Plan** | ✅ | 只读规划：3 阶段流程（探索→意图→实现），禁止写操作 |
| Pair Programming | ❌ | 结对编程：逐步协作，频繁确认 |
| Execute | ❌ | 全自主执行：假设优先，长距离独立执行 |

这是 Codex **内部**的模式切换（相当于我们的 C1），与产品层面的 Work/Codex 是不同层次的概念。

#### 5.3 对标建议

| Codex/Work 特性 | 咱们对标方案 | 优先级 | 放入改进项 |
|----------------|------------|--------|-----------|
| **Work 模式（调研/文档）** | 远期目标：完整 Work/Codex 双模式拆分（W 系列），排在 Phase 0-4 全部完成后 | 远期 | W 系列（Phase 5） |
| **Codex 模式（编程 Agent）** | 这就是我们的核心定位，当前已具备 | ✅ 已有 | — |
| **Codex 内部 CollaborationMode（Default/Plan）** | 实现 Plan/Default 模式切换，Plan 模式禁止 write/edit/bash | 高 | C1 |
| **模式携带 model + effort** | 与 M1 Profile 系统集成，模式可以覆盖模型配置 | 中 | C1 + M1 |
| **计划任务（Scheduled Tasks）** | 纳入 W 系列远期目标，与 Work 模式一同实现 | 远期 | W 系列（Phase 5） |
| **云端运行（Work Web/Mobile）** | 暂不对标（我们是本地桌面应用） | 低 | 不做 |
| **Code Mode（V8 编排）** | 暂不对标（需引入 V8 引擎，架构改动过大） | 低 | 不做 |
| **Sandbox 沙箱** | 实现路径白名单 + 受保护路径（轻量沙箱） | 高 | S2 |

---

## 二、改进项清单

### A. 功能改进（F 系列）

| 编号 | 名称 | 目标 | 涉及文件 |
|------|------|------|---------|
| F1.1 | 记忆面板编辑/新增 | `MemoryManager.tsx` 从只读改为可编辑 | `MemoryManager.tsx`, `memory.ts` |
| F1.2 | 压缩后自动提取记忆 | `compactMessages()` 完成后触发 `extractMemoriesFromSession` | `agentic-loop.ts`, `App.tsx` |
| F1.3 | 回合结束自动提取记忆 | `run()` 正常结束时触发提取 | `agentic-loop.ts`, `App.tsx` |
| F1.4 | AGENTS.md 可配字节上限 | 32KB 硬编码改为设置读取 | `files.ts`, `settings.ts`, `SettingsPanel.tsx` |
| F2.1 | 记忆脱敏 | 提取记忆时自动检测并 redact API Key/密码 | `index.ts` |
| F2.2 | Project root 自动检测 | 向上查找 `.git` 等标记确定项目根 | `files.ts`, `App.tsx` |
| F2.3 | AGENTS.md fallback 文件名 | 支持 `TEAM_GUIDE.md` 等备选 | `files.ts`, `settings.ts` |
| F2.4 | 记忆导出/导入 | JSON/Markdown 导出导入 | `memory.ts`, `MemoryManager.tsx` |
| F2.5 | 参数安全扫描 | 工具执行前检测参数中的敏感信息 | `streaming-executor.ts` |
| F3.1 | 跨会话记忆整合 | 定期合并、去重、清理过时记忆 | `index.ts`, `memory.ts` |
| F3.2 | 会话级记忆控制 | `/memory off` / `/memory on` 命令 | `index.ts`, `agentic-loop.ts` |
| F3.3 | AGENTS.md 自动生成 | 扫描项目结构生成初始模板 | `files.ts` |
| F3.4 | 编辑后自动 lint | write/edit 完成后运行 lint | `agentic-loop.ts`, `settings.ts` |
| F3.5 | 自定义权限规则 UI | 设置面板编辑权限规则 | `permission.ts`, `SettingsPanel.tsx` |
| F3.6 | Retrospective 模式 | AI 犯错时建议更新 AGENTS.md | `agentic-loop.ts`, `prompt.ts` |

### B. 安全防护改进（S 系列）⭐ 新增

> **背景**：用户反馈「让 AI 把 3+3=6 写进文件，结果 AI 直接全量覆盖了原文件内容」。经分析，Codex 有多层文件安全机制（Sandbox 沙箱、受保护路径、apply_patch 编辑、Diff 审查），而我们几乎为零。S 系列补齐这些安全短板。

| 编号 | 名称 | 目标 | 涉及文件 | 说明 |
|------|------|------|---------|------|
| S1 | Write 工具覆写保护 | `write` 对已存在文件先做 diff 检查，内容变化过大时提示确认或建议改用 `edit` | `tools.ts`, `agentic-loop.ts` | 防止全量覆写已有文件 |
| S2 | 受保护路径机制 | 禁止写入 `.git`、`.mimo-snapshots`、`.env` 等关键路径 | `file-api.ts`, `lib.rs`, `permission.ts` | 对标 Codex 的 protected paths |
| S3 | apply_patch 编辑工具 | 新增基于 patch 的编辑工具，减少全量覆写场景 | `tools.ts` | 对标 Codex 的 `apply_patch` |
| S4 | Diff 审查 UI | 文件变更前后对比展示，支持接受/拒绝 | `ChatPanel.tsx`, 新增组件 | 对标 Codex App 的 diff pane |
| S5 | 沙箱路径白名单 | 限制写入范围到工作目录及其子目录 | `file-api.ts`, `lib.rs` | 轻量沙箱，对标 Codex 的 workspace-write |

### C. 协作模式改进（C 系列）⭐ 新增

> **背景**：对标 Codex 内部的 `CollaborationMode` 系统（Default/Plan 模式切换）。注意：这不是 ChatGPT 产品层面的 Work vs Codex 区分（那个是产品定位差异），而是 Codex **内部**的行为风格切换——Plan 模式只读规划，Default 模式自主执行。

| 编号 | 名称 | 目标 | 涉及文件 | 说明 |
|------|------|------|---------|------|
| C1 | 协作模式切换 | 实现 Default / Plan 两种模式，Plan 模式禁止 write/edit/bash | `agent.ts`, `agentic-loop.ts`, `prompt.ts`, `App.tsx`, `InputArea.tsx` | 对标 Codex 的 CollaborationMode |

### W. Work 模式拆分（W 系列）⭐ 远期目标

> **背景**：对标 ChatGPT 的 Work / Codex 双模式拆分。在 Phase 0-4 全部完成后，作为产品演进的长期目标。将 Codem 从单一编程助手扩展为支持编程 + 调研双模式的桌面 AI 工作站。
>
> **前提条件**：Phase 0-4 全部完成（特别是 C1 协作模式、M1 模型 Profile、S 系列安全防护），架构稳定后再开始。

| 编号 | 名称 | 目标 | 说明 |
|------|------|------|------|
| W1 | 模式切换器 | 在 UI 顶层实现 Codex/Work 模式切换，类似 ChatGPT Desktop 左上角切换器 | 不同模式使用不同的系统提示词、工具集、Agent 配置 |
| W2 | Work 系统提示词 | 为 Work 模式编写独立的系统提示词，聚焦调研、文档创建、信息分析 | 不包含编程工具调用指令，增加文档结构化输出能力 |
| W3 | Work 工具集 | 为 Work 模式注册独立的工具集：Web 搜索、文档生成、信息整理 | 禁用 write/edit/bash 等编程工具，新增文档类工具 |
| W4 | 项目制上下文 | 实现「项目」概念：将对话、文件、指令绑定为一个项目单元 | 对标 ChatGPT Work 的 Project 机制 |
| W5 | 计划任务 | 支持定时运行、触发器运行、监控变化运行的任务调度 | 对标 ChatGPT Work 的 Scheduled Tasks |
| W6 | 人机协作迭代 | Work 模式下支持任务运行中途暂停、审查进度、回答问题、调整方向 | 区别于 Codex 模式的自主 Agentic Loop |
| W7 | 用量池共享 | Work 和 Codex 模式共享同一用量池 | 对标 ChatGPT 的统一 agentic usage |

**工作量预估**：2-3 周（需要新建工具集、项目制上下文、任务调度器、模式切换 UI）

### D. 效率改进（E 系列）

| 编号 | 名称 | 目标 | 涉及文件 | 预期收益 |
|------|------|------|---------|---------|
| E1 | 子智能体模型路由 | 让 `AgentDefinition.model` 生效 | `index.ts`, `agent.ts`, `spawner.ts` | 探索任务成本降 60-80% |
| E2 | 推理力度配置 | 支持 `reasoning_effort: low\|medium\|high` | `types.ts`, `provider.ts`, `agentic-loop.ts` | 简单任务延迟降 40-60% |
| E3 | 增量消息构建 | 不再每轮全量重建消息列表 | `agentic-loop.ts` | 每轮构建 O(n)→O(1) |
| E4 | 文件内容缓存 | 会话级 LRU 缓存，避免重复读取 | `tools.ts` | 重复读取减少 50%+ |
| E5 | 扩展工具并发范围 | 更多只读工具加入并行列表 | `streaming-executor.ts` | 多搜索请求等待时间降 40-60% |
| E6 | 智能上下文选择 | 按优先级保留消息而非"最后 N 条" | `agentic-loop.ts` | 关键决策不被挤出上下文 |
| E7 | Prompt Caching | API 层面缓存系统提示词 | `provider.ts` | 系统提示词 token 成本降 50% |
| E8 | 成本感知自动降级 | 预算接近时自动切换更便宜模型 | `agentic-loop.ts`, `cost-tracker.ts` | 防止意外高额账单 |

### E. 混合模型调用系统（M 系列）

#### M1：模型配置方案（Model Profile）

**目标**：实现不同任务场景调用不同模型的配置机制。用户可以创建多条配置组合（Profile），按需启停切换。

**背景**：当前所有任务（对话、探索、记忆提取、压缩摘要）使用同一个模型。未来还要支持 TTS 语音、绘图等非 Chat 模型。需要一个统一的配置层，按"任务槽位"（Task Slot）路由到不同模型。

**核心概念**：

```
任务槽位（Task Slot）：
┌─────────────────────────────────────────────────────────┐
│  chat       │ 主对话循环（agentic loop）                  │
│  subagent   │ 子智能体任务（探索、搜索等轻量任务）           │
│  memory     │ 记忆提取（简单摘要，可用便宜模型）             │
│  compaction │ 上下文压缩摘要                               │
│  tts        │ 语音合成（未来）                             │
│  imageGen   │ 图像生成（未来）                             │
│  embedding  │ 向量嵌入/语义搜索（未来）                     │
└─────────────────────────────────────────────────────────┘

模型配置方案（Model Profile）：
┌─────────────────────────────────────────────────────────┐
│  方案名称: "经济模式"                                     │
│  启用状态: ✅ 启用                                        │
│  ┌─────────────┬───────────────┬──────────┬───────────┐ │
│  │ 槽位        │ Provider      │ Model    │ Effort    │ │
│  ├─────────────┼───────────────┼──────────┼───────────┤ │
│  │ chat        │ mimo          │ v2.5     │ medium    │ │
│  │ subagent    │ openai        │ 4o-mini  │ low       │ │
│  │ memory      │ openai        │ 4o-mini  │ low       │ │
│  │ compaction  │ mimo          │ v2-flash │ low       │ │
│  │ tts         │ (未配置)       │          │           │ │
│  │ imageGen    │ (未配置)       │          │           │ │
│  └─────────────┴───────────────┴──────────┴───────────┘ │
└─────────────────────────────────────────────────────────┘

用户可创建多个方案，同时只激活一个。
未配置的槽位向上回退：tts→chat, memory→subagent→chat
```

**技术实现**：

```typescript
// ===== 新增文件：src/core/llm/model-profile.ts =====

/** 任务槽位类型 */
export type TaskSlot =
  | "chat"        // 主对话循环
  | "subagent"    // 子智能体
  | "memory"      // 记忆提取
  | "compaction"  // 上下文压缩
  | "tts"         // 语音合成（未来）
  | "imageGen"    // 图像生成（未来）
  | "embedding";  // 向量嵌入（未来）

/** 单个槽位的模型配置 */
export interface ModelSlotConfig {
  provider: string;        // provider id: "openai", "mimo", "deepseek"
  model: string;           // model id: "gpt-4o-mini", "mimo-v2-flash"
  reasoningEffort?: "low" | "medium" | "high";
  temperature?: number;
  maxTokens?: number;
}

/** 模型配置方案 */
export interface ModelProfile {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  isBuiltIn: boolean;
  /** 槽位配置，未配置的槽位向上回退 */
  slots: Partial<Record<TaskSlot, ModelSlotConfig>>;
}

/** 内置方案 */
const BUILTIN_PROFILES: ModelProfile[] = [
  {
    id: "default",
    name: "默认（统一模型）",
    description: "所有任务使用同一个模型，与当前行为一致",
    enabled: true,
    isBuiltIn: true,
    slots: {
      // 不配置任何槽位 → 全部回退到 LLMEngine.defaultModel
    },
  },
  {
    id: "economy",
    name: "经济模式",
    description: "主对话用标准模型，子任务用 mini/flash 降本",
    enabled: false,
    isBuiltIn: true,
    slots: {
      subagent:  { provider: "openai", model: "gpt-4o-mini", reasoningEffort: "low" },
      memory:    { provider: "openai", model: "gpt-4o-mini", reasoningEffort: "low" },
      compaction:{ provider: "mimo",   model: "mimo-v2-flash", reasoningEffort: "low" },
    },
  },
  {
    id: "performance",
    name: "高性能模式",
    description: "所有任务使用最强模型，不考虑成本",
    enabled: false,
    isBuiltIn: true,
    slots: {
      chat:      { provider: "anthropic", model: "claude-opus-4-20250514", reasoningEffort: "high" },
      subagent:  { provider: "openai",    model: "gpt-4o", reasoningEffort: "medium" },
      memory:    { provider: "openai",    model: "gpt-4o", reasoningEffort: "medium" },
    },
  },
];

/** Profile 管理器 */
export class ModelProfileManager {
  private profiles: ModelProfile[] = [];
  private activeProfileId: string = "default";

  /** 获取当前激活的方案 */
  getActiveProfile(): ModelProfile { ... }

  /** 解析某个槽位的实际模型配置（含回退逻辑） */
  resolveSlot(slot: TaskSlot): ModelSlotConfig {
    const profile = this.getActiveProfile();
    // 1. 精确匹配槽位
    if (profile.slots[slot]) return profile.slots[slot]!;
    // 2. 回退链：tts/imageGen/embedding → chat, memory/compaction → subagent → chat
    const fallback: Record<TaskSlot, TaskSlot | null> = {
      tts: "chat", imageGen: "chat", embedding: "chat",
      memory: "subagent", compaction: "subagent",
      subagent: "chat", chat: null,
    };
    let current = fallback[slot];
    while (current) {
      if (profile.slots[current]) return profile.slots[current]!;
      current = fallback[current];
    }
    // 3. 全部未配置 → 返回引擎默认
    return null; // 由调用方使用 LLMEngine.defaultModel
  }

  /** 切换激活方案 */
  setActiveProfile(id: string): void { ... }

  /** 创建自定义方案 */
  createProfile(profile: Omit<ModelProfile, "id" | "isBuiltIn">): ModelProfile { ... }

  /** 启用/禁用方案 */
  toggleProfile(id: string, enabled: boolean): void { ... }
}
```

```typescript
// ===== 修改：src/core/agent/agent.ts =====
// AgentDefinition 增加槽位字段

export interface AgentDefinition {
  // ... existing fields ...
  model?: string;           // 保留，向后兼容（直接指定模型名）
  /** 该 Agent 使用的任务槽位，默认按 mode 推断：primary→chat, subagent→subagent */
  modelSlot?: TaskSlot;
  reasoningEffort?: "low" | "medium" | "high";  // 新增
}
```

```typescript
// ===== 修改：src/core/llm/index.ts =====
// getAgenticLoop() 读取 Profile

getAgenticLoop(agentId?: string): AgenticLoop {
  const agent = agentId ? this.agents.get(agentId) : undefined;

  // 解析模型配置：优先 Profile 槽位 → Agent.model → 引擎默认
  const slot = agent?.modelSlot
    || (agent?.mode === "subagent" ? "subagent" : "chat");
  const slotConfig = this.profileManager.resolveSlot(slot);

  const provider = slotConfig
    ? this.providers.get(slotConfig.provider)
    : this.providers.get(this.config.defaultProvider || "openai");
  if (!provider) throw new Error("No provider configured");

  const model = slotConfig?.model
    || agent?.model
    || this.config.defaultModel;
  const temperature = slotConfig?.temperature
    ?? agent?.temperature
    ?? this.config.temperature;
  const maxTokens = slotConfig?.maxTokens
    || agent?.maxTokens
    || this.config.maxTokens
    || 4096;
  const maxIterations = agent?.maxSteps
    || this.config.maxToolCalls
    || 20;

  this.agenticLoop = new AgenticLoop(provider, this.tools, {
    maxIterations,
    temperature,
    maxOutputTokens: maxTokens,
    model,
    reasoningEffort: slotConfig?.reasoningEffort || agent?.reasoningEffort,
  });
  return this.agenticLoop;
}
```

```typescript
// ===== 修改：src/core/llm/index.ts =====
// extractMemoriesFromSession() 使用 memory 槽位

async extractMemoriesFromSession(sessionId: string): Promise<void> {
  // 解析 memory 槽位（回退到 subagent → chat）
  const slotConfig = this.profileManager.resolveSlot("memory");
  const provider = slotConfig
    ? this.providers.get(slotConfig.provider)
    : this.providers.get(this.config.defaultProvider || "openai");
  const model = slotConfig?.model || this.config.defaultModel;
  // ... 后续逻辑使用 provider 和 model
}
```

```typescript
// ===== 修改：src/core/llm/agentic-loop.ts =====
// compactMessages() 使用 compaction 槽位

private async generateCompactionSummary(...): Promise<string> {
  // 通过回调或注入获取 compaction 槽位的模型配置
  const slotConfig = this.config.resolveSlot?.("compaction");
  const model = slotConfig?.model || this.config.model;
  // ... 后续逻辑使用 model
}
```

```typescript
// ===== 新增：src/components/ModelProfilePanel.tsx =====
// UI 面板：方案列表 + 槽位配置表格 + 启停开关

// 面板功能：
// 1. 左侧：方案列表（内置 + 自定义），每个方案有启用开关
// 2. 右侧：选中方案的槽位配置表格
//    - 每行一个槽位（chat/subagent/memory/compaction/tts/imageGen/embedding）
//    - 每列：Provider 下拉、Model 下拉、Effort 下拉、Temperature 输入
//    - 未配置的槽位显示"回退到 xxx"灰色提示
// 3. 底部：「新建方案」按钮 → 弹出空方案编辑器
// 4. 内置方案只读，自定义方案可编辑/删除
```

**改动路径**：
- 新增 `src/core/llm/model-profile.ts` — Profile 类型定义 + 管理器
- 修改 `src/core/llm/index.ts` — `getAgenticLoop()` 和 `extractMemoriesFromSession()` 读取 Profile
- 修改 `src/core/llm/agentic-loop.ts` — `compactMessages()` 读取 Profile（通过回调注入）
- 修改 `src/core/agent/agent.ts` — `AgentDefinition` 增加 `modelSlot` 和 `reasoningEffort` 字段
- 修改 `src/core/llm/types.ts` — `LLMRequest` 增加 `reasoningEffort` 字段
- 修改 `src/core/llm/provider.ts` — 请求体增加 `reasoning_effort` 字段
- 新增 `src/components/ModelProfilePanel.tsx` — 方案管理 UI
- 修改 `src/components/SettingsPanel.tsx` — 增加「模型配置方案」入口
- 修改 `src/core/storage/settings.ts` — 持久化 Profile 数据

---

## 三、改进项关联分析

### 1. 协同关系（1+1 > 2）

| 协同组 | 说明 | 收益 |
|--------|------|------|
| **E1 + M1** | E1 让 `getAgenticLoop()` 读取 agent 模型配置；M1 在此基础上增加 Profile/Slot 抽象层。E1 是 M1 的基础设施。 | M1 依赖 E1 先落地，否则 M1 无处接入 |
| **F1.2/F1.3 + M1** | 记忆自动提取会频繁调用 LLM。有了 M1 的 `memory` 槽位，提取记忆用便宜模型（mini/flash），成本仅为 chat 模型的 1/10。 | 记忆提取几乎零成本，不再因为"怕花钱"而不敢自动触发 |
| **F1.2 + M1 (compaction)** | 同理，上下文压缩摘要可用 `compaction` 槽位的便宜模型。 | 压缩成本降低 80%+ |
| **E2 + M1** | 推理力度是 Slot 配置的一部分。不同槽位配不同 effort：chat=high, subagent=medium, memory=low。 | E2 为 M1 提供字段支撑，M1 为 E2 提供配置载体 |
| **E8 + M1** | 成本感知降级 = 接近预算时自动切换到更便宜的 Profile（如从"高性能"切到"经济"）。M1 提供了降级目标。 | 降级有明确的"切换到哪"答案，而非临时换模型名 |
| **E6 + F1.2** | 智能上下文选择时，压缩摘要标记应作为最高优先级保留。F1.2 生成的摘要被 E6 识别为关键消息。 | 长对话中历史决策不丢失 |
| **F3.4 + E4** | 编辑后自动 lint 和文件缓存失效可以合并：write/edit 工具完成后，同时清缓存 + 触发 lint。 | 一次工具回调完成两件事 |
| **S1 + S3** | S1 在 write 工具中加覆写保护检测，S3 新增 apply_patch 工具作为更安全的替代。两者互补：S1 防御旧工具的风险，S3 提供新工具。 | 逐步用 apply_patch 替代 write 做编辑 |
| **S2 + S5** | S2 受保护路径是 S5 沙箱的子集。S5 限制写入范围到工作目录，S2 在此基础上额外保护工作目录内的关键路径。 | S2 先做（即时保护），S5 后做（完整沙箱） |
| **C1 + M1** | C1 协作模式可以携带 model + reasoningEffort 覆盖，与 M1 的 Profile 系统集成。Plan 模式可以用更便宜的模型（只读探索不需要最强模型）。 | 模式切换时自动调整模型配置 |
| **C1 + S1** | C1 的 Plan 模式禁止 write/edit/bash，从源头消除大部分安全风险。S1 保护 Default 模式下的写操作。 | 两种模式形成安全分层 |

### 2. 热点文件冲突分析

> 核心原则：**同一个文件的同一个函数，应在一个 Phase 内改完，避免跨 Phase 二次修改。**
> 每次跨 Phase 重新打开同一函数，开发者需要重新理解上下文，且容易遗漏前序改动。

#### 热点文件 ①：`agentic-loop.ts`（10 项改动 — 全项目最高风险）

该文件有 **5 个独立代码区域**，不同改进项触及不同区域：

| 代码区域 | 行号范围 | 涉及改进项 | 冲突风险 |
|---------|---------|-----------|---------|
| **A. `LoopConfig` 类型** | 32-56 | F1.2, F1.3, E2, E8, M1, F3.2 | 低 — 各加各的字段，不互相覆盖 |
| **B. `run()` 主循环** | 256-398 | F1.2, F1.3 | 低 — 两项都在加回调，位置不同 |
| **C. `executeIteration()` 迭代执行** | 423-702 | E2, E8, F3.4, F3.6 | **中高** — E2 改请求构建(437行)，E8 在开头加检查(436行)，F3.4 在工具回调加 lint(680行)，F3.6 改循环检测(553行) |
| **D. `buildMessages()` 消息构建** | 704-753 | E3, E6 | **高** — E3 重写整个函数为增量模式，E6 再在增量基础上改选择策略。**必须 E3 先于 E6，且同一 Phase 完成** |
| **E. `compactMessages()` 压缩** | 779-930 | F1.2, M1 | 低 — F1.2 在末尾加回调触发(830行)，M1 改 `generateCompactionSummary` 中的模型选择(867行) |

**关键冲突**：
- **E3 → E6 是最危险的链**：E3 把 `buildMessages()` 从"每次全量读取"改为"增量缓存"，E6 要在增量缓存基础上修改消息选择优先级。如果 E3 和 E6 分在不同 Phase，E6 的开发者必须先理解 E3 的缓存逻辑才能安全修改。**必须在同一 Phase 内连续完成。**
- **E2 + E8 同在 `executeIteration()`**：E2 在第 437 行修改 `LLMRequest` 增加 `reasoningEffort`，E8 在第 436 行加成本检查。位置相邻但不冲突。**建议同一 Phase 完成。**
- **F3.4 + F3.6 同在 `executeIteration()` 的后半段**：F3.4 在工具回调(680行)加 lint，F3.6 在循环检测(553行)加 retrospective。位置不冲突。**建议同一 Phase 完成。**

#### 热点文件 ②：`index.ts`（7 项改动）

| 代码区域 | 涉及改进项 | 冲突风险 |
|---------|-----------|---------|
| `getAgenticLoop()` (115-131行) | E1, M1 | **中** — E1 读取 `agent.model`，M1 替换为 Profile 解析。**E1 是 M1 的过渡态，代码会被 M1 覆写。** |
| `extractMemoriesFromSession()` (498-587行) | F2.1, M1 | **低** — F2.1 在写入前加脱敏，M1 改模型选择。不同位置。 |
| `buildSystemPromptAsync()` (177-220行) | F3.2 | 低 — 只加一个开关 |
| 新增 `consolidateMemories()` | F3.1 | 无 — 新方法 |

**关键冲突**：
- **E1 → M1 是计划内的覆写**：E1 先让 `getAgenticLoop()` 读 `agent.model`（3 行改动），M1 后续替换为 Profile 解析。E1 的代码是过渡性的，**这是有意为之的演进路径，不算浪费** — E1 立即带来 60% 成本降低，M1 后续增加灵活性。

#### 热点文件 ③：`files.ts`（4 项改动）

| 代码区域 | 涉及改进项 | 冲突风险 |
|---------|-----------|---------|
| `loadHierarchicalProjectInstructions()` | F1.4, F2.3 | **中** — F1.4 改 `maxBytes` 默认值，F2.3 加 fallback 文件名逻辑。**同一函数，必须同一 Phase。** |
| 新增 `detectProjectRoot()` | F2.2 | 无 — 新函数 |
| 新增 `generateAgentsMd()` | F3.3 | 无 — 新函数 |

#### 热点文件 ④：`streaming-executor.ts`（2 项改动）

| 代码区域 | 涉及改进项 | 冲突风险 |
|---------|-----------|---------|
| `DEFAULT_CONFIG.concurrencySafeTools` (22行) | E5 | 无 |
| `execute()` / `executeSingle()` 工具执行 | F2.5 | 低 — 加安全扫描，不冲突 |

**关键顺序**：E5 先扩展并发列表 → F2.5 再加安全扫描（扫描需要在并行前执行）。

#### 热点文件 ⑤：`App.tsx`（3 项改动）

| 代码区域 | 涉及改进项 | 冲突风险 |
|---------|-----------|---------|
| Loop 创建 / 回调注入 | F1.2, F1.3 | **低** — 两项都在加回调字段 |
| 命令解析 | F3.2 | 无 — 不同代码区域 |

### 3. 效率优化的时机选择

> **核心问题：效率优化应该先做还是后做？**
> 答案不是"全部先做"或"全部后做"，而是按 **是否改变代码结构** 分三类处理。

| 类型 | 改进项 | 时机 | 理由 |
|------|--------|------|------|
| **配置型（不改结构）** | E1, E2, E5, E7 | **尽早做** | 只加字段/配置，不改代码结构。后续功能改进不会破坏它们。E1 是 M1 前置，E2 是 M1 前置，E5 是 F2.5 前置。 |
| **结构型（改变内部实现）** | E3, E6 | **在依赖它们的功能之前做，在可能被它们破坏的功能之后做** | E3 改变 `buildMessages()` 内部实现 → 必须在 F1.2（压缩）之后做（处理缓存失效），在 E6（智能选择）之前做（E6 依赖 E3 的缓存基础）。**E3 和 E6 必须同一 Phase。** |
| **隔离型（独立模块）** | E4, E8 | **随时可做** | E4 只改 `tools.ts`，E8 只改 `cost-tracker.ts` + `agentic-loop.ts` 的开头检查。与其他改动不冲突。 |

**关键洞察**：E3（增量消息构建）是唯一"可能被功能改进破坏"的效率优化。F1.2 的压缩会删除 DB 消息，导致 E3 的缓存失效。因此 **E3 必须在 F1.2 之后做**，这样 E3 的开发者在实现时就能看到压缩代码并处理缓存失效。如果反过来（E3 先做，F1.2 后做），F1.2 的开发者可能不知道要通知 E3 的缓存失效，导致 bug。

### 4. 冲突与解决方案

| 冲突 | 说明 | 解决方案 |
|------|------|---------|
| **E3 ← F1.2** | E3 缓存了消息列表。F1.2 的压缩会删除 DB 中的消息，导致缓存失效。 | E3 在 `buildMessages()` 中检测 `messages.length < this.lastMessageCount` → 强制全量重建。**E3 必须在 F1.2 之后实现。** |
| **E4 ← write/edit** | E4 文件缓存在 write/edit 后过期。 | 在 `agentic-loop.ts` 工具回调中清除缓存。通过 `ToolContext` 暴露 `invalidateCache(path)`。**E4 和 F3.4（也在工具回调中加逻辑）应同一 Phase 做。** |
| **E6 ← E3** | E6 修改 `buildMessages()` 的选择策略，E3 修改 `buildMessages()` 的缓存机制。 | **E3 先于 E6，且同一 Phase。** E3 建立缓存基础设施，E6 在其上修改选择逻辑。 |
| **E1 ← M1** | E1 读 `agent.model`，M1 替换为 Profile 解析。 | 计划内覆写。E1 实现为"模型解析器"函数 `resolveModel(agent)`，M1 替换其内部实现，调用方不变。 |
| **F1.4 ← F2.3** | 都修改 `loadHierarchicalProjectInstructions()`。 | **同一 Phase 完成。** F1.4 改 `maxBytes` 默认值，F2.3 加 fallback 文件名，合在一起改一次。 |
| **E5 ← F2.5** | E5 扩展并发列表，F2.5 在并发前加安全扫描。 | **E5 先于 F2.5，且同一 Phase。** |

### 5. 依赖顺序（必须先做 X 才能做 Y）

```
E1 (模型路由) ──→ M1 (Profile 系统) ──→ E8 (成本降级)
                                        ──→ 多模态扩展
E2 (推理力度) ──→ M1 (推理力度是 Slot 配置的一部分)

F1.2 (压缩回调) ──→ E3 (增量缓存，需处理压缩失效) ──→ E6 (智能选择，在同一缓存上改策略)
F1.2 (自动提取) ──→ F3.1 (记忆整合，需有数据来源)

E5 (扩展并发) ──→ F2.5 (安全扫描，需在并发前执行)

F1.1 (记忆编辑) ──→ F2.4 (导出导入)
F2.2 (root 检测) ──→ F3.3 (AGENTS.md 生成)
E4 (文件缓存) ──→ F3.4 (缓存失效 + 自动 lint，同一回调)
```

### 6. 关联矩阵（文件 × 改进项 × Phase）

| 文件 | 涉及改进项 | 跨 Phase 次数 | 冲突风险 |
|------|-----------|:---:|------|
| `agentic-loop.ts` | F1.2, F1.3, E2, E3, E6, E8, F3.4, F3.6, M1, C1, S1 | 4 | **高** — 核心文件，需严格控制改动顺序 |
| `index.ts` | E1, M1, F2.1, F3.1, F3.2 | 3 | 中 — E1→M1 是计划内覆写 |
| `provider.ts` | E2, E7 | 1-2 | 低 |
| `types.ts` | E2, M1 | 1-2 | 低 |
| `streaming-executor.ts` | E5, F2.5 | 1 | 低 — 同一 Phase |
| `tools.ts` | E4 | 1 | 无 |
| `agent.ts` | E1, E2, M1 | 2 | 低 — 加字段 |
| `spawner.ts` | E1, M1 | 2 | 低 |
| `files.ts` | F1.4, F2.2, F2.3, F3.3 | 2 | 中 — F1.4+F2.3 同函数 |
| `settings.ts` | F1.4, F2.3, F3.4, F3.5, M1 | 3 | 低 — 各加各的 key |
| `SettingsPanel.tsx` | F1.4, F3.4, F3.5, M1 | 3 | 低 — 各加各的 UI 段 |
| `App.tsx` | F1.2, F1.3, F3.2, C1 | 3 | 低 |
| `tools.ts` | E4, S1, S3 | 2 | 低 — S1 改 write，S3 加新工具 |
| `file-api.ts` | S2, S5 | 1 | 低 — 加路径检查 |
| `lib.rs` (Tauri 后端) | S2, S5 | 1 | 低 — 加路径校验 |
| `InputArea.tsx` | C1 | 1 | 无 — 加模式切换 UI |
| `memory.ts` | F1.1, F2.4, F3.1 | 2 | 低 — 新方法 |
| `MemoryManager.tsx` | F1.1, F2.4 | 1 | 无 |
| `prompt.ts` | F3.6 | 1 | 无 |
| `permission.ts` | F3.5 | 1 | 无 |
| `cost-tracker.ts` | E8 | 1 | 无 |

---

## 四、统一执行计划

### Phase 0：类型与接口层（0.5 天）⚡ 无行为变更

> **目标**：先把所有类型定义和接口字段加好，后续各 Phase 只管填逻辑，不再改接口。
> **零冲突风险** — 只加字段/类型，不改任何运行时逻辑。

| 改进项 | 改动内容 | 涉及文件 |
|--------|---------|---------|
| E2 (部分) | `LLMRequest` 增加 `reasoningEffort` 字段 | `types.ts` |
| E2 (部分) | `LoopConfig` 增加 `reasoningEffort` 字段 | `agentic-loop.ts` (Zone A) |
| M1 (部分) | `AgentDefinition` 增加 `modelSlot` + `reasoningEffort` 字段 | `agent.ts` |
| F1.2 (部分) | `LoopConfig` 增加 `onCompactionComplete` 回调类型 | `agentic-loop.ts` (Zone A) |
| F1.3 (部分) | `LoopConfig` 增加 `onTurnComplete` 回调类型 | `agentic-loop.ts` (Zone A) |
| F3.2 (部分) | `LoopConfig` 增加 `memoryEnabled` 字段 | `agentic-loop.ts` (Zone A) |
| E8 (部分) | `LoopConfig` 增加 `costTracker` 引用 + `resolveSlot` 回调类型 | `agentic-loop.ts` (Zone A) |
| C1 (部分) | `AgentDefinition` 增加 `collaborationMode` 字段；`LoopConfig` 增加 `collaborationMode` 字段 | `agent.ts`, `agentic-loop.ts` (Zone A) |
| S1 (部分) | `LoopConfig` 增加 `onWriteConfirm` 回调类型 | `agentic-loop.ts` (Zone A) |

**为什么单独抽出一层**：`agentic-loop.ts` 的 Zone A（`LoopConfig` 类型定义）会被 6 个改进项修改。如果分散在各 Phase 改，每次都要重新打开同一个类型定义。一次性加完所有字段，后续 Phase 只管在逻辑代码中使用这些字段，不再碰类型定义。

### Phase 1：基础设施通电（1-1.5 天）⚡ 最高 ROI

> **目标**：让模型路由和记忆系统同时"通电"。E1 是 M1 的地基，F1.2/F1.3 是记忆系统的开关。
> **文件冲突**：`agentic-loop.ts` 只碰 Zone B（`run()` 加回调）+ Zone E（压缩后触发），不碰 Zone C/D。`App.tsx` 注入回调。互不干扰。

| 改进项 | 改动量 | 涉及文件/区域 | 依赖 |
|--------|--------|-------------|------|
| **E1** 子智能体模型路由 | 极小 | `index.ts` `getAgenticLoop()` | 无 |
| **F1.2** 压缩后自动提取记忆 | 小 | `agentic-loop.ts` Zone B+E, `App.tsx` | Phase 0 |
| **F1.3** 回合结束自动提取记忆 | 小 | `agentic-loop.ts` Zone B, `App.tsx` | F1.2 |
| **F1.1** 记忆面板编辑/新增 | 中 | `MemoryManager.tsx`, `memory.ts` | 无 |
| **F1.4** AGENTS.md 可配字节上限 | 小 | `files.ts` | 无 |
| **S2** 受保护路径机制 | 小 | `file-api.ts`, `lib.rs`, `permission.ts` | 无 |
| **S1** Write 工具覆写保护 | 小 | `tools.ts`, `agentic-loop.ts` Zone C(工具回调) | Phase 0 |

**同一文件并行规则**：
- `agentic-loop.ts`：F1.2 和 F1.3 都在 Zone B（`run()` 方法），位置不同（一个在压缩后，一个在 finally），可安全并行。
- `App.tsx`：F1.2 和 F1.3 都在 loop 创建处注入回调，可合并为一次改动。
- `files.ts`：只 F1.4 一项，无冲突。

**同一文件并行规则**（补充）：
- `agentic-loop.ts`：S1 在 Zone C（工具回调，680行附近）加覆写检测，与 F1.2/F1.3（Zone B）不冲突。
- `file-api.ts` + `lib.rs`：S2 只加路径检查函数，不冲突。
- `tools.ts`：S1 改 `createWriteFileTool()` 的 `execute` 方法，加 diff 检测逻辑。

**关键判断**：E1 改 3 行代码让 `AgentDefinition.model` 生效 = 成本立降 60%+。F1.2 + F1.3 让记忆系统真正工作。S2 + S1 补齐最紧急的文件安全短板。七项改动分布在 7 个不同文件区域，互不冲突。

### Phase 2：核心效率 + 安全性（3-4 天）

> **目标**：一次性改完 `agentic-loop.ts` 的 Zone C + Zone D，避免后续 Phase 再碰。
> **核心策略**：E3 和 E6 **必须在本 Phase 内连续完成**（都改 `buildMessages()`）。E2 和 E8 **也在本 Phase**（都改 `executeIteration()`）。加上 F3.4 和 F3.6（也在 `executeIteration()`），本 Phase 一次性改完 Zone C 和 Zone D。

| 改进项 | 改动量 | 涉及文件/区域 | 依赖 | Phase 内顺序 |
|--------|--------|-------------|------|------------|
| **E2** 推理力度配置 | 中 | `provider.ts`, `agentic-loop.ts` Zone C | Phase 0 | 1️⃣ 先做，改 `executeIteration()` 请求构建 |
| **E3** 增量消息构建 | 中 | `agentic-loop.ts` Zone D | F1.2 | 2️⃣ 紧接 E2，改 `buildMessages()`，处理 F1.2 压缩失效 |
| **E6** 智能上下文选择 | 中 | `agentic-loop.ts` Zone D | E3 | 3️⃣ 紧接 E3，在增量缓存上改选择策略 |
| **E8** 成本感知检查 | 中 | `agentic-loop.ts` Zone C, `cost-tracker.ts` | Phase 0 | 4️⃣ 在 `executeIteration()` 开头加成本检查 |
| **F3.4** 编辑后自动 lint | 小 | `agentic-loop.ts` Zone C(工具回调), `settings.ts` | E4 | 5️⃣ 在工具回调中加 lint |
| **F3.6** Retrospective 模式 | 中 | `agentic-loop.ts` Zone C(循环检测), `prompt.ts` | 无 | 6️⃣ 在循环检测中加建议 |
| **E4** 文件内容缓存 | 小 | `tools.ts` | 无 | 可并行 |
| **E5** 扩展工具并发范围 | 极小 | `streaming-executor.ts` | 无 | 7️⃣ 先于 F2.5 |
| **F2.5** 参数安全扫描 | 小 | `streaming-executor.ts` | E5 | 8️⃣ 在 E5 之后 |
| **F2.1** 记忆脱敏 | 小 | `index.ts` `extractMemoriesFromSession()` | F1.2 | 可并行 |
| **F2.2** Project root 自动检测 | 小 | `files.ts` (新函数) | 无 | 可并行 |
| **F2.3** AGENTS.md fallback 文件名 | 小 | `files.ts` `loadHierarchicalProjectInstructions()` | F1.4 | 9️⃣ 与 F1.4 同函数，接续改 |
| **F2.4** 记忆导出/导入 | 小 | `memory.ts`, `MemoryManager.tsx` | F1.1 | 可并行 |
| **E7** Prompt Caching | 小 | `provider.ts` | 无 | 可并行 |
| **S3** apply_patch 编辑工具 | 中 | `tools.ts` (新工具) | 无 | 可并行 |
| **S4** Diff 审查 UI | 中 | `ChatPanel.tsx`, 新增 `DiffViewer.tsx` | S1 | 可并行 |
| **C1** 协作模式切换 | 中 | `agent.ts`, `prompt.ts`, `App.tsx`, `InputArea.tsx` | Phase 0 | 可并行 |

> **注意**：E7 从原 Phase 3 前移到 Phase 2 — 它只改 `provider.ts`，无依赖，不冲突，提前做掉减少 Phase 3 负担。
> **注意**：E6 从原 Phase 3 前移到 Phase 2 — 它和 E3 都改 `buildMessages()`，必须同 Phase。
> **注意**：F3.4 从原 Phase 3 前移到 Phase 2 — 它和 E4 都涉及工具回调，同 Phase 做掉。
> **注意**：F3.6 从原 Phase 3 前移到 Phase 2 — 它改 `executeIteration()` 循环检测，与 E2/E8 同区域。
> **注意**：E8 从原 Phase 3 前移到 Phase 2 — 它改 `executeIteration()` 开头，与 E2 同函数。但它依赖 M1 提供降级目标 → 本 Phase 先实现成本检查框架（检查 + warn），Phase 3 M1 完成后接入降级切换。

**`agentic-loop.ts` 改动地图（本 Phase 一次性改完 Zone C + D）**：
```
executeIteration() (Zone C):
  开头:  E8  成本检查
  437行: E2  增加 reasoningEffort 到 LLMRequest
  553行: F3.6 循环检测中加 retrospective 建议
  680行: F3.4 工具回调中加 lint + 缓存失效

buildMessages() (Zone D):
  全函数: E3  重写为增量缓存模式
  选择段: E6  在增量基础上改优先级选择策略
```

**关键判断**：本 Phase 是改动量最大的阶段，但核心策略是"一次性改完 `agentic-loop.ts` 的 Zone C 和 Zone D"。Phase 3 只需碰 Zone E（压缩模型选择），不再碰 Zone C/D，大幅降低跨 Phase 冲突风险。

### Phase 3：混合模型系统（4-5 天）

> **目标**：M1 混合模型调用系统上线。`agentic-loop.ts` 只碰 Zone E（压缩槽位），`index.ts` 碰 `getAgenticLoop()`（E1→M1 覆写）+ `extractMemoriesFromSession()`（M1 加 memory 槽位）。

| 改进项 | 改动量 | 涉及文件/区域 | 依赖 | Phase 内顺序 |
|--------|--------|-------------|------|------------|
| **M1** 模型配置方案 | 大 | 新增 `model-profile.ts`, 改 `index.ts` + `agent.ts` + `spawner.ts` + `agentic-loop.ts` Zone E + `SettingsPanel.tsx` + 新增 `ModelProfilePanel.tsx` + `settings.ts` | E1, E2 | 1️⃣ 核心任务 |
| **E8 接入** 成本降级接入 | 小 | `agentic-loop.ts` Zone C(已改好) | M1 | 2️⃣ M1 完成后，把 Phase 2 的成本检查框架接入 Profile 降级 |
| **F3.1** 跨会话记忆整合 | 中 | `index.ts`, `memory.ts` | F1.2 | 可并行 |
| **F3.2** 会话级记忆控制 | 小 | `index.ts`, `App.tsx` | F1.2 | 可并行 |

**同一文件并行规则**：
- `index.ts`：M1 覆写 `getAgenticLoop()`（替换 E1 的过渡实现），同时改 `extractMemoriesFromSession()` 加 memory 槽位。F3.1 加新方法 `consolidateMemories()`。F3.2 改 `buildSystemPromptAsync()`。四个不同函数，低冲突。
- `agentic-loop.ts`：M1 只碰 Zone E（`compactMessages` → `generateCompactionSummary` 改模型选择）。Zone C/D 已在 Phase 2 改完，不碰。

**关键判断**：M1 是本阶段核心。有了 E1（模型路由）和 E2（推理力度），M1 只需要增加 Profile 管理层和 UI 面板。E8 在 Phase 2 已建好框架，本 Phase 只需接入 M1 的 Profile 降级。

### Phase 4：精细化 + 多模态扩展（按需推进）

> **目标**：非核心功能和多模态能力扩展。

| 改进项 | 改动量 | 依赖 | 说明 |
|--------|--------|------|------|
| **F3.3** AGENTS.md 自动生成 | 中 | F2.2 | 扫描项目结构生成模板 |
| **F3.5** 自定义权限规则 UI | 中 | 无 | 设置面板编辑权限规则 |
| **多模态-TTS** 语音合成 | 大 | M1 | 接入 TTS provider，使用 `tts` 槽位 |
| **多模态-ImageGen** 图像生成 | 大 | M1 | 接入绘图 provider，使用 `imageGen` 槽位 |
| **多模态-Embedding** 语义搜索 | 大 | M1 | 接入 embedding provider，使用 `embedding` 槽位 |

**关键判断**：多模态扩展全部依赖 M1 的槽位机制。M1 在 Phase 3 已预留 `tts`/`imageGen`/`embedding` 槽位，Phase 4 只需实现具体的 provider 接入和工具注册。

### 执行计划总览

```
Phase 0（0.5天）→ 类型与接口层（零冲突）
  └── 所有 LoopConfig/LLMRequest/AgentDefinition 字段一次性加完

Phase 1（1-1.5天）→ 基础设施通电 ⚡
  ├── E1  子智能体模型路由（改 3 行，成本立降 60%+）
  ├── F1.1 记忆面板编辑/新增
  ├── F1.2 压缩后自动提取记忆
  ├── F1.3 回合结束自动提取记忆
  └── F1.4 AGENTS.md 可配字节上限

Phase 2（3-4天）→ 一次性改完 agentic-loop.ts 核心区域
  ├── [Zone C] E2  推理力度 → E8 成本检查 → F3.6 retrospective → F3.4 自动lint
  ├── [Zone D] E3  增量消息 → E6 智能选择（必须连续）
  ├── [独立]   E4  文件缓存 | E5 并发扩展 → F2.5 安全扫描
  ├── [独立]   E7  Prompt Caching
  ├── [独立]   F2.1 记忆脱敏 | F2.2 root检测 | F2.4 导出导入
  ├── [安全]   S3  apply_patch工具 | S4  Diff审查UI
  ├── [模式]   C1  协作模式切换（Default/Plan）
  └── [files]  F2.3 fallback文件名（接续 F1.4）

Phase 3（4-5天）→ 混合模型系统
  ├── M1  模型配置方案（核心，依赖 E1+E2）
  ├── E8  成本降级接入（接入 M1 Profile）
  ├── F3.1 跨会话记忆整合
  └── F3.2 会话级记忆控制

Phase 4（按需）→ 精细化 + 多模态扩展
  ├── F3.3 AGENTS.md 自动生成
  ├── F3.5 自定义权限规则 UI
  ├── S5  沙箱路径白名单（完整沙箱）
  ├── 多模态-TTS（依赖 M1 tts 槽位）
  ├── 多模态-ImageGen（依赖 M1 imageGen 槽位）
  └── 多模态-Embedding（依赖 M1 embedding 槽位）

Phase 5（远期）→ Work 模式拆分 ⭐
  ├── W1  模式切换器（UI 顶层 Codex/Work 切换）
  ├── W2  Work 系统提示词（调研/文档导向）
  ├── W3  Work 工具集（Web 搜索/文档生成/信息整理）
  ├── W4  项目制上下文（对话+文件+指令绑定）
  ├── W5  计划任务（定时/触发/监控）
  ├── W6  人机协作迭代（中途暂停/审查/调整）
  └── W7  用量池共享
  前提：Phase 0-4 全部完成，架构稳定
```

### 关键判断

1. **Phase 0 是冲突消解器**：`agentic-loop.ts` 的 `LoopConfig` 类型被 6 个改进项修改。Phase 0 一次性加完所有字段，后续 Phase 只管在逻辑中使用，不再碰类型定义。成本仅 0.5 天，但消除了至少 3 次跨 Phase 的类型定义冲突。

2. **Phase 1 最高 ROI**：E1 改 3 行代码 = 成本立降 60%+。F1.2/F1.3 让记忆系统真正工作。五项改动分布在 5 个不同文件，互不冲突。

3. **Phase 2 是最重但最关键的一步**：核心策略是"一次性改完 `agentic-loop.ts` 的 Zone C + Zone D"。E3→E6 必须连续（都改 `buildMessages()`），E2→E8→F3.4→F3.6 同在 `executeIteration()` 内不同位置。本 Phase 完成后，`agentic-loop.ts` 的核心区域不再需要跨 Phase 修改。E7/F3.4/F3.6 从原 Phase 3 前移到本 Phase，减少 Phase 3 对 `agentic-loop.ts` 的二次打开。

4. **Phase 3 只碰安全区域**：M1 只改 `agentic-loop.ts` 的 Zone E（压缩模型选择），不碰 Zone C/D（已在 Phase 2 改完）。E8 在 Phase 2 已建好框架，本 Phase 只需接入 M1 的 Profile 降级。`index.ts` 中 M1 覆写 `getAgenticLoop()` 是计划内的 E1→M1 演进。

5. **"效率先做还是后做"的答案**：配置型效率优化（E1/E2/E5/E7）尽早做；结构型效率优化（E3/E6）在依赖它们的功能之前做、在可能破坏它们的功能之后做（E3 在 F1.2 之后、E6 之前）；隔离型效率优化（E4/E8）随时可做。**不存在"全部效率最后做"的策略** — 那样会导致功能代码写完后被效率优化推翻。

6. **S 系列安全改进的分层策略**：S2（受保护路径）和 S1（覆写保护）在 Phase 1 做，立即解决用户反馈的文件覆盖问题。S3（apply_patch 工具）和 S4（Diff 审查 UI）在 Phase 2 做，提供更好的编辑体验和审查能力。S5（完整沙箱）推迟到 Phase 4，因为它需要 Tauri 后端较大改动，而前四项已经覆盖了 80% 的安全场景。

7. **C1 协作模式的定位**：C1 对标的是 Codex **内部**的 `CollaborationMode`（Default/Plan 模式切换），而非产品层面的 ChatGPT Work vs Codex。Codex 产品层面的 Work（调研/文档）与 Codex（编程）是两种不同产品体验，我们作为编程助手对标的是 Codex 模式。Codex 内部的 Plan 模式从源头消除写操作风险，与 S 系列形成纵深防御。

---

## 五、不做清单

| 项目 | 原因 |
|------|------|
| Hooks 外部命令框架 | GUI 用户不写脚本；PermissionManager 已覆盖 PreToolUse；Tauri 下外部脚本有安全/编码问题 |
| 自定义 Agent TOML 文件 | ROI 低；内置 6 个 Agent 覆盖 95% 场景；M1 的 Profile 机制已提供模型配置灵活性 |
| Chronicle 屏幕截屏 | macOS 专属功能；Windows 无对应 API；隐私风险大 |
| 记忆存储改 Markdown | 架构不统一；Windows 编码问题多；SQLite + 编辑面板更适合 GUI 应用 |
| Code Mode（V8 运行时） | 需引入 V8 引擎嵌入到 Tauri，架构改动过大；ROI 低（我们的工具调用延迟不是瓶颈）；维护成本高 |
| Git Worktree 隔离 | Tauri 下 Git worktree 管理复杂；用户通常在单项目工作；快照系统已提供回滚能力 |
| Codex Cloud 远程执行 | 需要 OpenAI 云端基础设施；与本地桌面应用定位不符 |
| OS 级 Sandbox（Seatbelt/bubblewrap） | macOS/Linux 专属；Windows 下实现方式完全不同（Windows Sandbox API），投入产出比低 |
| 自动审批审查（auto_review） | 需要额外的 LLM 调用评估风险；增加延迟和成本；PermissionManager + S 系列已足够 |
| Web 搜索（cached/live） | 与核心编程助手定位不符；需要额外索引基础设施 |
| Codex Security（漏洞扫描） | 需要独立的安全分析管线和容器化验证；与编程助手核心功能正交，适合作为独立插件 |

---

## 六、关键文件索引

| 文件 | 职责 | 涉及改进项 | 涉及 Phase |
|------|------|-----------|-----------|
| `src/core/llm/agentic-loop.ts` | Agent 循环 + 压缩 + 工具执行 | F1.2, F1.3, E2, E3, E6, E8, F3.4, F3.6, M1 | 0(ZoneA), 1(ZoneB+E), 2(ZoneC+D), 3(ZoneE) |
| `src/core/llm/index.ts` | LLM 引擎 + 记忆提取 + 系统提示词构建 | E1, M1, F2.1, F3.1, F3.2 | 1, 2, 3 |
| `src/core/llm/provider.ts` | OpenAI 兼容 Provider（stream/complete） | E2, E7 | 0, 2 |
| `src/core/llm/types.ts` | LLM 类型定义（LLMRequest 等） | E2 | 0 |
| `src/core/llm/streaming-executor.ts` | 工具执行器（并发/串行/超时） | E5, F2.5 | 2 |
| `src/core/llm/tools.ts` | 内置工具注册（read/write/bash/grep 等） | E4 | 2 |
| `src/core/llm/cost-tracker.ts` | 成本追踪（记录/统计/限额） | E8 | 2 |
| `src/core/llm/model-profile.ts` | **新增** 模型配置方案类型 + 管理器 | M1 | 3 |
| `src/core/agent/agent.ts` | Agent 注册表（内置 6 个 Agent） | E1, E2, M1 | 0, 1, 3 |
| `src/core/subagent/spawner.ts` | 子智能体执行器 | E1, M1 | 1, 3 |
| `src/core/memory/memory.ts` | 记忆服务（增删改查 + 搜索） | F1.1, F2.4, F3.1 | 1, 2, 3 |
| `src/components/MemoryManager.tsx` | 记忆管理 UI 面板 | F1.1, F2.4 | 1, 2 |
| `src/components/ModelProfilePanel.tsx` | **新增** 模型配置方案管理 UI | M1 | 3 |
| `src/components/SettingsPanel.tsx` | 设置面板 | F1.4, F3.4, F3.5, M1 | 1, 2, 3, 4 |
| `src/core/project/files.ts` | AGENTS.md 分层加载 + 项目文件操作 | F1.4, F2.2, F2.3, F3.3 | 1, 2, 4 |
| `src/core/storage/settings.ts` | SQLite 统一存储 API | F1.4, F2.3, F3.4, F3.5, M1 | 1, 2, 3, 4 |
| `src/core/permission/permission.ts` | 工具权限管理 | F3.5 | 4 |
| `src/core/prompt/prompt.ts` | 系统提示词构建 | F3.6 | 2 |
| `src/App.tsx` | 主应用（事件处理 + loop 创建） | F1.2, F1.3, F3.2 | 1, 3 |
| `src/core/snapshot/snapshot.ts` | 文件快照服务 | S1 (配合覆写检测) | 1 |
| `src/core/recovery/recovery.ts` | 会话恢复服务 | 不改 | - |
| `src/core/file-api.ts` | 文件 API 适配层 | S2, S5 | 1, 4 |
| `src-tauri/src/lib.rs` | Tauri Rust 后端 | S2, S5 | 1, 4 |
| `src/components/InputArea.tsx` | 输入区 | C1 | 2 |
| `src/components/ChatPanel.tsx` | 聊天主面板 | S4 | 2 |
| `src/components/DiffViewer.tsx` | **新增** Diff 审查组件 | S4 | 2 |
