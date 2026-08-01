# Codex Use Cases 对标分析（v2 — 新增 Playwright/Figma/GitHub MCP 后）

> 更新时间：2026-08-01
> 变更：新增 `browser_automate`（Playwright）、`figma_fetch`（Figma API）、`github_tool`（GitHub API）三个内置工具

## 新增工具说明

### 1. `browser_automate` — Playwright 浏览器自动化

| 能力 | 说明 |
|------|------|
| 导航 | navigate 到 URL |
| 截图 | 全页面/视口截图 |
| 交互 | click、fill、hover、select |
| 提取 | get_text、evaluate（JS 执行） |
| 等待 | wait for selector |
| 用途 | QA 测试、UI 视觉对比、浏览器游戏测试、表单验证 |

### 2. `figma_fetch` — Figma 设计稿获取

| 能力 | 说明 |
|------|------|
| 结构 | 获取文件页面/帧树 |
| 节点 | 获取特定节点数据 |
| 导出 | 导出节点为 PNG/JPG/SVG |
| 组件 | 列出所有组件 |
| 样式 | 列出所有样式 |
| 用途 | Figma 设计稿→代码、设计上下文提取 |

### 3. `github_tool` — GitHub API 集成

| 能力 | 说明 |
|------|------|
| PR 审查 | 获取 PR 详情 + diff + 文件 + reviews |
| 代码搜索 | 跨仓库搜索代码 |
| Issue 搜索 | 搜索 issue/PR |
| 仓库信息 | 获取仓库元数据 |
| 提交历史 | 获取最近提交 |
| 漏洞扫描 | 检查依赖漏洞告警 |
| 用途 | PR 自动审查、安全扫描、Bug triage、代码变更追踪 |

---

## 更新后的可复现率统计

### 统计汇总

| 可复现度 | v1 数量 | v1 占比 | v2 数量 | v2 占比 | 变化 |
|---------|---------|--------|---------|--------|------|
| ✅ 可直接复现 | 68 | 67% | **82** | **81%** | +14 |
| ⚠️ 部分可复现 | 16 | 16% | **7** | **7%** | -9 |
| ❌ 无法复现 | 17 | 17% | **12** | **12%** | -5 |
| **合计** | **101** | **100%** | **101** | **100%** | |

### 从 "部分可复现" → "可复现" 的 9 个 use cases

| # | Use Case | 新增能力解锁 |
|---|----------|-------------|
| 1 | Build responsive front-end designs | `browser_automate` Playwright 视觉对比 |
| 2 | Make granular UI changes | `browser_automate` 浏览器验证 |
| 3 | Create browser-based games | `browser_automate` 游戏测试 |
| 4 | Add evals to your AI application | `browser_automate` 可运行 Promptfoo |
| 5 | Turn Figma designs into code | `figma_fetch` 设计稿获取 |
| 6 | Review GitHub pull requests | `github_tool` PR 审查 |
| 7 | Scan code changes for security | `github_tool` diff 安全扫描 |
| 8 | Turn user stories into UI mocks | `figma_fetch` + `browser_automate` |
| 9 | Build React Native apps with Expo | `browser_automate` 可运行 Expo |

### 从 "无法复现" → "部分可复现" 的 5 个 use cases

| # | Use Case | 新增能力改善 |
|---|----------|-------------|
| 1 | Kick off coding tasks from Slack | `github_tool` 可关联 GitHub issues（但缺 Slack 本身） |
| 2 | Analyze product feedback across tools | `github_tool` 可获取 GitHub issues（但缺 Slack） |
| 3 | Deploy an app or website | `browser_automate` 可验证部署（但缺 Vercel API） |
| 4 | Build and deploy internal apps | `browser_automate` 可测试应用（但缺 Sites 托管） |
| 5 | Create a lesson deck | `figma_fetch` 可导出设计资产（但缺 PPT 集成） |

### 仍然无法复现的 12 个 use cases

| # | Use Case | 缺少的核心能力 |
|---|----------|--------------|
| 1 | Get email to inbox zero | Email 集成 + 定时任务 |
| 2 | Use computer with ChatGPT | Computer Use（桌面控制） |
| 3 | Create slide deck | Google Slides/PPT 集成 |
| 4 | Set up work chief of staff | 定时任务 + 多服务集成 |
| 5 | Turn meetings into follow-ups | Zoom 集成 |
| 6 | Prepare meeting briefs | Calendar 集成 |
| 7 | Complete tasks from messages | Messages/iMessage 集成 |
| 8 | Build a dashboard that stays up to date | 定时任务 |
| 9 | Track bills, subscriptions, and spending | 银行/账户集成 |
| 10 | Prioritize Slack action items | Slack 集成 |
| 11 | Bring your app to ChatGPT | ChatGPT Apps 平台 |
| 12 | Build an interactive lesson resource | Sites 托管平台 |

---

## 纯 Chat 模型可实现的 Use Cases（不需特殊工具）

以下 use cases **仅依靠 LLM 对话能力 + 文件读写/bash 即可实现**，不需要 Playwright、Figma、GitHub 或任何第三方集成：

### 业务运营类（29 个）

| # | Use Case | 实现方式 |
|---|----------|---------|
| 1 | Clean and prepare messy data | bash + LLM 处理 CSV |
| 2 | Forecast cash flow | LLM 生成预测模型 |
| 3 | Analyze datasets and ship reports | bash + LLM 分析 + 生成报告 |
| 4 | Model a DCF valuation | LLM 生成估值模型 |
| 5 | Review budget vs. actuals | LLM 分析差异 |
| 6 | Prepare a business review | LLM 生成绩效叙述 |
| 7 | Prepare a leadership reporting pack | LLM 生成报告包 |
| 8 | Analyze KPI root causes | LLM 分析根因 |
| 9 | Plan a dashboard and monitoring workflow | LLM 生成规格文档 |
| 10 | Prepare an initiative health update | LLM 生成简报 |
| 11 | Prioritize accounts | LLM 排序 |
| 12 | Review forecast risk | LLM 审查 |
| 13 | Scope an analytics request | LLM 分析需求 |
| 14 | Turn research into a decision memo | LLM 生成备忘录 |
| 15 | Write an initiative off-track brief | LLM 生成简报 |
| 16 | Diagnose a stalled deal | LLM 诊断 |
| 17 | Measure business impact | LLM 评估 |
| 18 | Model strategic scenarios and tradeoffs | LLM 建模 |
| 19 | Build a variance driver bridge | LLM 生成 |
| 20 | Clean and review a financial model | LLM 检查公式 |
| 21 | Refresh a forecast and plan | LLM 刷新 |
| 22 | Prepare a committee packet | LLM 生成材料包 |
| 23 | Refresh a strategic account plan | LLM 刷新 |
| 24 | Consolidate spreadsheets | bash + LLM 合并 |
| 25 | Run verified operations | LLM + bash 执行 |
| 26 | Run event playbooks | LLM 生成手册 |
| 27 | Audit a workflow | LLM 审计 |
| 28 | Build a launch campaign kit | LLM 生成套件 |
| 29 | Draft PRDs from internal context | LLM 生成 PRD |
| 30 | Set up a project teammate | Agent Profile |
| 31 | Plan a budget and schedule | LLM 规划 |

### 生产力与协作类（3 个）

| # | Use Case | 实现方式 |
|---|----------|---------|
| 32 | Learn a new concept | LLM + 子智能体 |
| 33 | Save workflows as skills | 技能系统 |
| 34 | Iterate on difficult problems | Agent Loop |
| 35 | Coordinate new-hire onboarding | LLM 生成材料 |

### Web 开发类（7 个）

| # | Use Case | 实现方式 |
|---|----------|---------|
| 36 | Understand large codebases | glob + grep + read |
| 37 | Automate bug triage | bash + grep + LLM |
| 38 | Upgrade your API integration | read + write + LLM |
| 39 | Refactor your codebase | read + write + edit + LLM |
| 40 | Run code migrations | read + write + LLM |
| 41 | Update documentation | read + write + LLM |
| 42 | Create a CLI Codex can use | bash 工具 |
| 43 | Build a student website | 代码生成 + 文件操作 |

### 安全类（4 个）

| # | Use Case | 实现方式 |
|---|----------|---------|
| 44 | Run a deep security scan | bash + grep + LLM |
| 45 | Remediate a vulnerability backlog | read + write + LLM |
| 46 | Audit dependency incidents | bash + 文件读取 |
| 47 | Run verified operations workflows | Agent Loop |

### 数据科学类（1 个）

| # | Use Case | 实现方式 |
|---|----------|---------|
| 48 | Discover protein folding models | LLM + 代码生成 |

### 教育类（15 个）

| # | Use Case | 实现方式 |
|---|----------|---------|
| 49 | Audit course section consistency | LLM 对比 |
| 50 | Build a unit plan from source files | LLM 生成 |
| 51 | Build a variance driver bridge | LLM 生成 |
| 52 | Calibrate assessments | LLM 校准 |
| 53 | Create a classroom materials pack | LLM 生成 |
| 54 | Organize a lesson or unit folder | 文件操作 |
| 55 | Organize a semester workspace | 文件操作 |
| 56 | Refresh course materials | LLM 审查 |
| 57 | Revise a lesson package | 文件操作 + LLM |
| 58 | Synthesize research evidence | LLM 综合 |
| 59 | Track course engagement | LLM 分析 |
| 60 | Track job applications | LLM 管理 |
| 61 | Build a student website | 代码生成 |
| 62 | Build an exam study system | LLM 生成 |
| 63 | Run a student club project | LLM 协调 |

### 纯 Chat 模型统计

| 分类 | 数量 |
|------|------|
| 业务运营 | 31 |
| 生产力 | 4 |
| Web 开发 | 8 |
| 安全 | 4 |
| 数据科学 | 1 |
| 教育 | 15 |
| **合计** | **63** |

> **纯 Chat 模型可实现 63/101 = 62.4%** 的 Codex use cases，无需任何特殊工具或第三方集成。

---

## 最终能力矩阵

| 能力层级 | 工具 | 可复现 use cases | 占比 |
|---------|------|-----------------|------|
| **纯 Chat 模型** | LLM + bash + read/write/edit/glob/grep | 63 | 62% |
| **+ Playwright** | + `browser_automate` | 67 | 66% |
| **+ Figma** | + `figma_fetch` | 69 | 68% |
| **+ GitHub** | + `github_tool` | 73 | 72% |
| **全部加起来** | Chat + Playwright + Figma + GitHub | **82** | **81%** |
| 仍无法复现 | — | 12 | 12% |
| 部分可复现 | — | 7 | 7% |

---

## 仍需补齐的能力清单（按优先级）

| 优先级 | 能力 | 影响 use cases | 实现难度 | 说明 |
|--------|------|----------------|---------|------|
| **P1** | 定时任务/Cron | 3 | 中 | Tauri 后台定时执行 |
| **P1** | Goal Mode | 1 | 低 | Agent Loop 中加目标追踪 |
| **P1** | Slack MCP | 3 | 高 | Slack API + webhook |
| **P2** | Vercel/部署集成 | 1 | 中 | Vercel API |
| **P2** | Sites（Web 托管） | 2 | 高 | 内部应用托管 |
| **P2** | Computer Use | 2 | 极高 | 桌面截图+鼠标键盘控制 |
| **P3** | iOS/macOS 工具链 | 8 | 极高 | Xcode + SwiftUI 插件 |
| **P3** | Zoom/Calendar/Email | 4 | 高 | SaaS 集成 |
| **P3** | NGS/Life Science 插件 | 3 | 高 | 生物信息工具 |
| **P3** | 银行/账户集成 | 1 | 高 | 金融 API |
| **P3** | ChatGPT Apps 平台 | 1 | 不可行 | OpenAI 平台 |
| **P3** | PPT/Slides 集成 | 1 | 中 | Google Slides API |

---

## 结论

新增 Playwright + Figma + GitHub 三个工具后：
- **可复现率从 67% 提升到 81%**（+14 个 use cases 解锁）
- **纯 Chat 模型即可实现 62%**（63 个 use cases 不需要任何特殊工具）
- **仍有 12 个无法复现**，主要受限于 SaaS 集成（Slack/Zoom/Email/Calendar）、平台能力（Computer Use/Sites/iOS）和定时任务
