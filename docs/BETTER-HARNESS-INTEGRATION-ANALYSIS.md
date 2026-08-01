# Better Harness 对标分析与集成方案

> 创建时间：2026-08-01
> 分析对象：[QoderAI/better-harness](https://github.com/QoderAI/better-harness) v0.4.0
> 目标：评估如何将 Better Harness 的智能体审查工作流集成到 Codem 桌面应用中

---

## 一、Better Harness 是什么

Better Harness 是 Qoder 团队开源的 **AI 编码智能体工作流审查工具**。它不是一个编码智能体本身，而是一个**围绕编码智能体的"安全网"**——在 Agent 工作"之前"和"之后"收集证据，评估工作流健康度，输出带证据支撑的发现报告。

### 核心理念

- **Feedforward（前馈引导）**：`AGENTS.md`、specs、Skills、验收标准 → 在 Agent 执行前引导
- **Feedback（反馈传感）**：lint、测试、Hooks、评估 Agent → 在 Agent 执行后观测结果
- **Agent Work Loop 五维模型**：从任务理解到学习捕获的完整闭环

### 五维评估模型

| 维度 | 回答的问题 | 证据来源 |
|------|----------|---------|
| **Task Understanding** | Agent 是否理解目标和"完成"的定义？ | Rules, AGENTS.md, specs, DESIGN.md |
| **Controlled Execution** | 工作是否在受支持、可复现的路径上？ | Skills, commands, MCP, sandbox |
| **Change Validation** | 变更是否有证据证明它有效？ | Tests, lint, Hooks, diagnostics |
| **Reliable Delivery** | AI 速度是否绕过了质量检查？ | Human review, approvals, CI/CD |
| **Learning Capture** | 下一个任务是否能受益？ | Loop Discovery, Skills, Memory |

### 架构

```
用户执行 /better-harness
    ↓
Step 1: 收集 Evidence Bundle（项目证据 + 会话证据 + Agent 资产）
    ↓
Step 2: 三个独立只读 Agent 并行评估
    ├── Agent 1: Session Evidence（会话证据）
    ├── Agent 2: Project Harness Evidence（项目工程证据）
    └── Agent 3: Agent Customize Evidence（Agent 配置证据）
    ↓
Step 3: Lead Agent 统一裁决 → findings + 评分 + 优先级
    ↓
Step 4: 渲染报告（HTML / Markdown / Canvas）
    ↓
Step 5: 跟进（修复 / 循环发现 / 持续改进）
```

### 技术栈

- **语言**：Node.js (ESM `.mjs`)，零 Python 依赖
- **运行时**：`scripts/better-harness.mjs` CLI 入口
- **分发**：npm 包 `@qoderai/better-harness` + 各 Host 插件目录
- **Host 适配**：Claude Code / Codex / Qoder / Cursor / GitHub Copilot / Qwen Code / Pi
- **依赖**：仅 `@vscode/tree-sitter-wasm` + `esbuild-wasm`

---

## 二、Codem 现有架构对比

### 已有的重叠能力

| Better Harness 能力 | Codem 对应 | 差距 |
|-------------------|-----------|------|
| Evidence Bundle 收集 | `FileChangeTracker` + `FileChangeStorage` + `agentic-loop` 事件链 | ✅ 有文件变更追踪，但缺**会话证据收集**和**Agent 资产盘点** |
| 三独立 Agent 并行评估 | `SubagentManager` + `spawn_subagent` + `AgentProfileStorage` | ✅ 有子智能体 spawn 能力，但未用于**审查场景** |
| 五维评估模型 | 无直接对应 | ❌ 缺评估模型，但 `Workbench.tsx` 三视图（Status/Capacity/Activity）是雏形 |
| 报告渲染 | `DiffViewer` + `Workbench` + `Overview` | ⚠️ 有 UI 面板，但无**标准化报告输出**（HTML/JSON） |
| Finding 修复 | `FileChangeTracker.revert()` + `autoCommit` | ✅ 有回滚能力，但无**Finding 追踪+修复验证闭环** |
| Hooks 生命周期 | 无直接对应 | ❌ 无 pre/post 生命周期 Hook 系统 |
| AGENTS.md 引导 | `system-prompt` + `skill` 注入 | ⚠️ 有 prompt 注入，但无**项目级 AGENTS.md 文件规范** |
| 技能发现 | `SkillRegistry` + `SkillMarket` + `slash-command-menu` | ✅ 有完整技能系统 |
| 记忆/学习 | `TranscriptCache` + `knowledge` (笔记/闪卡/图谱) | ⚠️ 有缓存和知识管理，但无**Loop Discovery**（循环发现） |

### 核心差距总结

Codem 已有**执行层**（Agentic Loop + 工具 + 子智能体），但缺：

1. **审查层**：独立于执行 Agent 的只读评估 Agent + 五维模型
2. **证据层**：标准化 Evidence Bundle（项目+会话+资产三路独立收集）
3. **报告层**：findings.json → HTML/Markdown 标准化渲染管线
4. **Hook 层**：pre-tool/post-tool 生命周期钩子
5. **学习层**：Loop Discovery + 干预账本（interventionLedger）

---

## 三、集成方案

### 方案选择：**深度集成（推荐）** vs 浅层适配

| 维度 | 浅层适配 | 深度集成（推荐） |
|------|---------|----------------|
| 做法 | 作为外部 Skill 插件引入 | 将核心能力内化到 Codem 架构 |
| 优点 | 改动小，快速上线 | 体验一体化，利用现有 Subagent/Storage/Skill 能力 |
| 缺点 | 依赖外部 Node.js 运行时，体验割裂 | 工作量大，需设计评估模型 |
| 适合 | 快速验证 | 长期产品化 |

**推荐深度集成**，因为 Codem 已有 SubagentManager、SQLite 存储、Agentic Loop 事件链等基础设施，可以复用。

### 集成架构设计

```
用户点击"🔍 审查工作流"或 /better-harness
    ↓
Codem Harness Engine (TypeScript)
    ├── Step 1: EvidenceBundleCollector
    │   ├── 项目证据: 扫描 AGENTS.md / specs / Skills / hooks / tests
    │   ├── 会话证据: 从 v2_sessions + turn_file_changes 提取 Task Episode
    │   └── Agent 资产: 从 SkillRegistry + AgentProfileStorage + settings 盘点
    ├── Step 2: 三个子智能体并行评估（复用 SubagentManager.spawn）
    │   ├── Session Evidence Agent → 评估会话中的 Task Understanding + Change Validation
    │   ├── Project Harness Agent → 评估 Controlled Execution + Reliable Delivery
    │   └── Agent Customize Agent → 评估 Learning Capture
    ├── Step 3: Lead Reconciliation
    │   ├── 合并 findings + 评分（五维 × 15 checks）
    │   ├── 证据状态: Present → Wired → Exercised → Outcome-supported
    │   └── 输出 findings.json
    ├── Step 4: 报告渲染
    │   ├── HarnessReportPanel.tsx（内嵌 UI 面板）
    │   ├── 导出 HTML（self-contained）
    │   └── 导出 Markdown
    └── Step 5: 跟进
        ├── Finding 修复 → 复用 FileChangeTracker + DiffViewer
        └── Loop Discovery → 记录到 intervention_ledger 表
```

---

## 四、改动范围与工作量

### Phase H-1: 评估模型与证据收集（核心，3-5 天）

| 任务 | 改动文件 | 说明 |
|------|---------|------|
| **AgentWorkLoop 模型** | 新建 `src/core/harness/agent-work-loop.ts` | 五维 × 15 checks 的 TypeScript 类型定义 + 证据状态机 + 评分逻辑 |
| **EvidenceBundle 收集器** | 新建 `src/core/harness/evidence-bundle.ts` | 扫描项目文件（AGENTS.md/specs/Skills/hooks/tests）+ 从 SQLite 提取会话证据 + Agent 资产盘点 |
| **Task Episode 构造** | 新建 `src/core/harness/task-episode.ts` | 从 v2_sessions + turn_file_changes 构造 Task Episode（用户目标 + 验收边界 + 变更集 + 验证结果） |
| **SQLite 表** | `src/core/storage/database.ts` | 新增 `harness_findings` 表（id, session_id, dimension, check_id, severity, evidence_refs, repair_action, status, created_at）+ `intervention_ledger` 表 |
| **HarnessStorage CRUD** | 新建 `src/core/storage/harness-storage.ts` | findings CRUD + ledger 读写 |

### Phase H-2: 三 Agent 并行评估（复用现有，2-3 天）

| 任务 | 改动文件 | 说明 |
|------|---------|------|
| **审查 Agent Profile** | `src/core/storage/agent-profile-storage.ts` | 新增 3 个内置 Profile: session-evidence-reviewer / project-harness-reviewer / agent-customize-reviewer |
| **SubagentManager 适配** | `src/core/subagent/spawner.ts` | 支持 `fork_turns: "none"` 只读模式 + 并行 spawn 3 个只读 Agent |
| **Lead Reconciliation** | 新建 `src/core/harness/lead-reconciler.ts` | 合并 3 个 Agent 的 findings，去重，分配 severity + score，输出 findings.json |

### Phase H-3: 报告渲染（2-3 天）

| 任务 | 改动文件 | 说明 |
|------|---------|------|
| **HarnessReportPanel** | 新建 `src/components/HarnessReportPanel.tsx` | 五维雷达图 + findings 列表 + 证据链接 + 修复按钮 |
| **HTML 渲染器** | 新建 `src/core/harness/report-renderer.ts` | self-contained HTML 模板（复用 better-harness 的 templates/reporting/） |
| **Markdown 渲染器** | 同上 | 配对 Markdown 输出 |
| **导出功能** | `src/components/HarnessReportPanel.tsx` | 导出 HTML / Markdown / JSON |

### Phase H-4: Hooks 生命周期（可选，2-3 天）

| 任务 | 改动文件 | 说明 |
|------|---------|------|
| **Hook 系统** | 新建 `src/core/harness/hooks.ts` | pre-tool / post-tool / pre-commit / post-finalize 钩子注册 |
| **Hook 配置** | `hooks/hooks.json` → `src/core/harness/hook-config.ts` | 可配置的 Hook 规则（secret-scan / agent-lint / core-change-watch） |
| **ChatPanel 集成** | `src/components/ChatPanel.tsx` | 工具栏新增"🔍 审查"按钮 |

### Phase H-5: Loop Discovery 与学习闭环（可选，2-3 天）

| 任务 | 改动文件 | 说明 |
|------|---------|------|
| **LoopDiscovery** | 新建 `src/core/harness/loop-discovery.ts` | 检测重复工作模式 → 路由到最小持久 Owner（Skill / Memory / Scheduled Inspection） |
| **InterventionLedger** | `src/core/storage/harness-storage.ts` | 干预账本：记录 finding → repair → verified → later-validation 链 |
| **历史趋势** | `src/components/HarnessReportPanel.tsx` | 展示多次报告的五维趋势图 |

### 总工作量

| 阶段 | 内容 | 天数 | 优先级 |
|------|------|------|--------|
| H-1 | 评估模型 + 证据收集 | 3-5 | P0 必须 |
| H-2 | 三 Agent 并行评估 | 2-3 | P0 必须 |
| H-3 | 报告渲染 | 2-3 | P0 必须 |
| H-4 | Hooks 生命周期 | 2-3 | P1 可选 |
| H-5 | Loop Discovery | 2-3 | P2 可选 |
| **合计** | | **11-17 天** | |

---

## 五、调用方式

### 用户侧调用

```
方式 1: 斜杠命令
/better-harness 分析当前项目的 AI 编码工作流并生成证据报告

方式 2: 工具栏按钮
ChatPanel 工具栏 → 🔍 审查 → 弹出 HarnessReportPanel

方式 3: 自动触发
Settings > Advanced > Harness → 配置"每 N 轮自动审查"
```

### 内部调用链

```
1. 用户触发 /better-harness
2. HarnessEngine.run(workspace, sessionId)
3. EvidenceBundleCollector.collect() → EvidenceBundle
4. SubagentManager.spawnFork("session-evidence-reviewer", bundle.sessionData)
   SubagentManager.spawnFork("project-harness-reviewer", bundle.projectData)
   SubagentManager.spawnFork("agent-customize-reviewer", bundle.agentData)
   ↓ 三个并行只读 Agent ↓
5. LeadReconciler.reconcile(candidates) → findings.json
6. ReportRenderer.render(findings) → HTML + Markdown
7. HarnessReportPanel 展示 → 用户查看
8. 用户点击"修复" → FileChangeTracker + DiffViewer
9. 修复后验证 → 更新 intervention_ledger
```

---

## 六、潜在隐患

### 1. 性能影响 — ⚠️ 中风险

**问题**：三 Agent 并行评估需要额外 3 次 LLM 调用，大项目证据收集可能耗时。

**缓解**：
- 证据收集使用 `git diff --stat` 预检查（已实现于 FileChangeTracker）
- 限制 Evidence Bundle 大小（quick 模式 3 assets + 7 days，normal 模式 5 assets + 30 days）
- 三 Agent 使用 compaction slot（低成本模型）

### 2. 子智能体隔离 — ⚠️ 中风险

**问题**：现有 `SubagentManager.spawn` 可能不是 `fork_turns: "none"` 的只读模式。

**缓解**：
- 新增 `spawnReadonly` 方法，传入 `read_only: true` + `fork_turns: "none"`
- 只读 Agent 不执行写工具，仅分析+返回 findings

### 3. SQLite 表膨胀 — 🟡 低风险

**问题**：`harness_findings` + `intervention_ledger` 表会随审查次数增长。

**缓解**：
- 设置 TTL（90 天自动清理）
- 提供手动清理 UI（复用 TranscriptCacheStats 模式）

### 4. Node.js 运行时依赖 — 🟢 已解决

**问题**：Better Harness 原生是 Node.js `.mjs`，Codem 是 Tauri (Rust + React)。

**缓解**：
- **不直接运行** better-harness CLI
- 将其逻辑用 TypeScript 重写到 `src/core/harness/`
- 复用 Codem 现有的 `executeCommand` (Tauri invoke) 执行 git 命令

### 5. AGENTS.md 规范 — 🟡 低风险

**问题**：Codem 当前无 `AGENTS.md` 文件，Better Harness 依赖它做 Task Understanding 评估。

**缓解**：
- Phase H-1 包含 AGENTS.md 生成器
- 从现有 `system-prompt.ts` + `skill` 注册表自动生成
- 用户可在 Settings > Advanced > Harness 中编辑

### 6. 评估模型偏差 — ⚠️ 中风险

**问题**：五维模型是 Qoder 团队的工程实践总结，可能不完全适用于所有项目类型。

**缓解**：
- 评分使用证据状态机（Present → Wired → Exercised → Outcome-supported），不直接打分
- Finding 需要人工确认（不自动修复）
- 支持项目级 overlay（自定义 evidence source 和 gate）

### 7. 与现有 Workbench/Overview 的关系 — 🟢 低风险

**问题**：Workbench.tsx 已有三视图（Status/Capacity/Activity），与 Harness 报告有重叠。

**缓解**：
- Workbench 是**实时可观测性**（当前轮次状态）
- Harness 是**周期性审查**（跨轮次/会话的工作流健康度）
- 两者互补，不冲突

---

## 七、实施建议

### 推荐分期实施

| 阶段 | 时间 | 交付物 | 验证标准 |
|------|------|--------|----------|
| **H-1 评估模型** | 第 1 周 | `agent-work-loop.ts` + `evidence-bundle.ts` + SQLite 表 | 能从当前项目收集证据并构造 Task Episode |
| **H-2 三 Agent** | 第 2 周 | 3 个审查 Profile + Lead Reconciler | 能并行 spawn 3 个只读 Agent 并合并 findings |
| **H-3 报告** | 第 2-3 周 | `HarnessReportPanel.tsx` + HTML/MD 渲染 | 用户能看到五维评分 + findings 列表 |
| **H-4 Hooks** | 第 3 周 | Hook 系统 + 配置 | pre-tool/post-tool 钩子可触发 |
| **H-5 Loop** | 第 4 周 | LoopDiscovery + intervention_ledger | 历史趋势图可展示 |

### 最小可行版本（MVP）

如果需要快速验证，可以先做：
1. **EvidenceBundleCollector** — 从现有 SQLite + git 收集证据
2. **单 Agent 评估** — 不并行 spawn 3 个，而是单 Agent 一次性评估五维
3. **简化报告** — 不渲染 HTML，直接在 ChatPanel 中以消息形式展示 findings

MVP 工作量约 **3-5 天**。

---

## 八、与现有代码的复用映射

| Better Harness 组件 | Codem 复用 | 改造说明 |
|---------------------|-----------|---------|
| `scripts/better-harness.mjs` CLI | `src/core/harness/harness-engine.ts` | TypeScript 重写，Tauri invoke 替代 Node.js exec |
| `scripts/session-analysis/` | `src/core/harness/session-evidence.ts` | 从 v2_sessions + turn_file_changes 提取 |
| `scripts/harness-analysis/` | `src/core/harness/lead-reconciler.ts` | 合并 findings 逻辑 |
| `scripts/core-change-watch/` | `src/core/environment/file-change-tracker.ts` | 已有！只需适配 evidence 输出 |
| `scripts/coding-agent-practices/` | `src/core/harness/agent-assets.ts` | 从 SkillRegistry + AgentProfileStorage 盘点 |
| `scripts/agent-lint/` | 新建 `src/core/harness/agent-lint.ts` | 扫描 AGENTS.md 规范性 |
| `skills/better-harness/SKILL.md` | 新建 `src/core/harness/skill.ts` | 注册为 Codem 技能 |
| `templates/reporting/` | `src/core/harness/report-renderer.ts` | HTML/MD 模板 |
| `hooks/` | 新建 `src/core/harness/hooks.ts` | 生命周期钩子 |
| `models/agent-work-loop.md` | `src/core/harness/agent-work-loop.ts` | TypeScript 类型 + 评分逻辑 |

---

## 九、结论

Better Harness 的核心价值不在其 Node.js 实现，而在于其**评估方法论**（Agent Work Loop 五维模型 + 证据状态机 + Finding 闭环）。Codem 应：

1. **方法论层面**：全面引入五维评估模型 + 证据状态机
2. **实现层面**：用 TypeScript 重写核心逻辑，复用现有 SubagentManager + SQLite + FileChangeTracker
3. **UI 层面**：新增 HarnessReportPanel 作为独立审查面板
4. **分阶段交付**：先 MVP（单 Agent + 简化报告 3-5 天），再完整版（三 Agent + HTML 报告 11-17 天）

总工作量 **11-17 天**（完整版）或 **3-5 天**（MVP），风险可控。
