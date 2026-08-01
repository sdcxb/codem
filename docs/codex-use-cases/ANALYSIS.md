# Codex Use Cases 对标分析

> 来源：https://learn.chatgpt.com/use-cases
> 抓取时间：2026-08-01
> 共 101 个 use cases + 13 个 collections

## Codem 现有能力概览

| 能力 | 状态 | 说明 |
|------|------|------|
| **Agentic Loop** | ✅ 已有 | 多轮工具调用、自主决策、流式执行 |
| **6 个内置工具** | ✅ 已有 | bash / read / write / edit / glob / grep |
| **MCP 集成** | ✅ 已有 | Model Context Protocol 工具 |
| **子智能体** | ✅ 已有 | SubagentManager、spawn_subagent |
| **技能系统** | ✅ 已有 | SkillRegistry、SkillMarket、slash-command-menu |
| **项目系统** | ✅ 已有 | 新建/导入、AGENTS.md、记忆 |
| **会话管理** | ✅ 已有 | 持久化、重命名、删除、分叉 |
| **文件浏览器** | ✅ 已有 | 懒加载、缓存、Git 状态 |
| **文件编辑器** | ✅ 已有 | 弹窗编辑、Ctrl+S |
| **图片粘贴** | ✅ 已有 | Ctrl+V 截图 |
| **PTY 终端** | ✅ 已有 | 交互式 PTY、多 Tab |
| **文件变更追踪** | ✅ 已有 | FileChangeTracker + Artifact |
| **自动 Git Commit** | ✅ 已有 | LLM 生成 commit message |
| **NeedsYou 精确提问** | ✅ 已有 | Agent→Human 反向队列 |
| **Agent 间通信** | ✅ 已有 | 异步消息队列 |
| **Agent Profile** | ✅ 已有 | 持久化 identity/domain/scope |
| **浏览器预览** | ✅ 已有 | create_browser_window |
| **三套皮肤** | ✅ 已有 | Default / Hub / Dream |
| **推理强度分档** | ✅ 已有 | 低/中/高/超高 |
| **上下文压缩** | ✅ 已有 | 自动压缩 + TranscriptCache |
| **知识管理** | ✅ 已有 | 笔记/闪卡/图谱 |
| **多模态设置** | ✅ 已有 | 图片生成/语音合成 |
| **Computer Use** | ❌ 缺失 | 无法控制桌面应用 |
| **Slack/Zoom 集成** | ❌ 缺失 | 无第三方 IM 集成 |
| **Figma 集成** | ❌ 缺失 | 无设计工具集成 |
| **iOS/macOS 原生开发** | ❌ 缺失 | 无 Xcode/SwiftUI 工具链 |
| **Playwright/UI 测试** | ❌ 缺失 | 无浏览器自动化测试 |
| **Vercel/部署集成** | ❌ 缺失 | 无一键部署 |
| **Google Drive/Calendar** | ❌ 缺失 | 无云服务集成 |
| **Sites (Web 应用)** | ❌ 缺失 | 无内部应用托管 |
| **Goal Mode** | ❌ 缺失 | 无 /goal 跨轮目标追踪 |
| **定时任务/Cron** | ❌ 缺失 | 无周期性执行 |
| **ImageGen** | ⚠️ 部分 | 有图片生成能力但非 Codex ImageGen |

---

## Use Cases 总览表（101 个，按 Collection 分类）

### Collection: Productivity & Collaboration（生产力与协作）

| # | Use Case | Codex 描述 | Codem 可复现 | 缺少什么 |
|---|----------|-----------|-------------|---------|
| 1 | Get your email to inbox zero | 清空收件箱、草拟回复、定时检查 | ❌ | Email 集成、定时任务 |
| 2 | Use your computer with ChatGPT | Computer Use 控制桌面应用 | ❌ | Computer Use 能力 |
| 3 | Follow a goal | /goal 跨轮目标追踪 | ⚠️ 部分 | Goal Mode 命令 |
| 4 | Create or revise a slide deck | 从笔记/数据生成幻灯片 | ❌ | Google Slides/PPT 集成 |
| 5 | Set up a work chief of staff | 定时检查消息/邮件/日历 | ❌ | 定时任务、多服务集成 |
| 6 | Turn meetings into follow-ups | Zoom 会议转行动项 | ❌ | Zoom 集成 |
| 7 | Learn a new concept | 论文/课程→学习报告 | ✅ | 无（LLM + 子智能体已有） |
| 8 | Idea to proof of concept | ImageGen + 原型构建 | ⚠️ 部分 | ImageGen（但有多模态生成） |
| 9 | Save workflows as skills | 保存工作流为技能 | ✅ | 无（技能系统已有） |
| 10 | Iterate on difficult problems | 评分循环改进 | ✅ | 无（Agent Loop + 子智能体已有） |
| 11 | Prepare meeting briefs | 日历上下文→议程 | ❌ | Calendar 集成 |
| 12 | Complete tasks from messages | iMessage→完成任务 | ❌ | Messages 集成 |
| 13 | Build a dashboard that stays up to date | 数据→仪表盘+定时更新 | ❌ | Sites、定时任务 |
| 14 | Weekly work summary | 一周活动→摘要 | ⚠️ 部分 | Calendar/Docs/Slack 集成 |

### Collection: Business Operations（业务运营）

| # | Use Case | Codex 描述 | Codem 可复现 | 缺少什么 |
|---|----------|-----------|-------------|---------|
| 15 | Analyze product feedback | Slack/问卷/Issue→主题 | ❌ | Slack 集成 |
| 16 | Clean and prepare messy data | CSV/Excel 清洗 | ✅ | 无（bash 工具+LLM 可实现） |
| 17 | Forecast cash flow | 现金流预测模型 | ✅ | 无（LLM + 文件操作可实现） |
| 18 | Analyze datasets and ship reports | 数据→分析+可视化 | ✅ | 无（bash + LLM 可实现） |
| 19 | Model a DCF valuation | DCF 估值模型 | ✅ | 无（LLM + 文件操作可实现） |
| 20 | Review budget vs. actuals | 预算 vs 实际差异 | ✅ | 无（LLM + 文件操作可实现） |
| 21 | Prepare a business review | KPI→绩效叙述 | ✅ | 无（LLM 可实现） |
| 22 | Prepare a leadership reporting pack | 公司进展→报告包 | ✅ | 无（LLM 可实现） |
| 23 | Build a dashboard and monitoring workflow | 仪表盘规格+监控计划 | ✅ | 无（LLM 可实现规格文档） |
| 24 | Analyze KPI root causes | KPI 异动根因分析 | ✅ | 无（LLM 分析可实现） |
| 25 | Prepare an initiative health update | 计划进展→简报 | ✅ | 无（LLM 可实现） |
| 26 | Scope an analytics request | 模糊需求→分析计划 | ✅ | 无（LLM 可实现） |
| 27 | Turn research into a decision memo | 研究→决策备忘录 | ✅ | 无（LLM 可实现） |
| 28 | Write an initiative off-track brief | 计划偏离简报 | ✅ | 无（LLM 可实现） |
| 29 | Prioritize accounts | 账户排序 | ✅ | 无（LLM 可实现） |
| 30 | Review forecast risk | 预测风险审查 | ✅ | 无（LLM 可实现） |
| 31 | Diagnose a stalled deal | 交易停滞诊断 | ✅ | 无（LLM 可实现） |
| 32 | Measure business impact | 实验/发布→影响评估 | ✅ | 无（LLM 可实现） |
| 33 | Model strategic scenarios and tradeoffs | 战略场景对比 | ✅ | 无（LLM 可实现） |
| 34 | Build a variance driver bridge | 差异驱动桥接 | ✅ | 无（LLM 可实现） |
| 35 | Clean and review a financial model | 财务模型清理 | ✅ | 无（LLM 可实现） |
| 36 | Refresh a forecast and plan | 刷新预测 | ✅ | 无（LLM 可实现） |
| 37 | Prepare a committee packet | 委员会材料包 | ✅ | 无（LLM 可实现） |
| 38 | Refresh a strategic account plan | 刷新账户计划 | ✅ | 无（LLM 可实现） |
| 39 | Consolidate spreadsheets | 合并表格 | ✅ | 无（bash + LLM 可实现） |
| 40 | Run verified operations | 验证操作工作流 | ✅ | 无（Agent Loop 可实现） |
| 41 | Run event playbooks | 活动手册 | ✅ | 无（LLM 可实现） |
| 42 | Audit a workflow | 审计工作流 | ✅ | 无（LLM 可实现） |
| 43 | Build a launch campaign kit | 发布活动套件 | ✅ | 无（LLM 可实现） |
| 44 | Track bills, subscriptions, and spending | 账单追踪 | ❌ | 银行/账户集成 |
| 45 | Prioritize Slack action items | Slack 行动项排序 | ❌ | Slack 集成 |
| 46 | Turn user stories into UI mocks | 用户故事→UI 原型 | ⚠️ 部分 | Figma 集成（但可手搓 UI） |
| 47 | Draft PRDs from internal context | PRD 起草 | ✅ | 无（LLM 可实现） |
| 48 | Set up a project teammate | 项目专属助手 | ✅ | 无（Agent Profile 已有） |
| 49 | Write a weekly work summary | 周工作总结 | ⚠️ 部分 | Calendar/Slack 集成 |
| 50 | Plan a budget and schedule | 预算+日程规划 | ✅ | 无（LLM 可实现） |
| 51 | Prepare a monthly business review narrative | 月度业务评审 | ✅ | 无（LLM 可实现） |
| 52 | Prepare a CFO board reporting pack | CFO 董事会报告 | ✅ | 无（LLM 可实现） |

### Collection: Web Development（Web 开发）

| # | Use Case | Codex 描述 | Codem 可复现 | 缺少什么 |
|---|----------|-----------|-------------|---------|
| 53 | Review GitHub pull requests | GitHub PR 自动审查 | ⚠️ 部分 | GitHub 深度集成（但可审查本地 diff） |
| 54 | Build responsive front-end designs | 截图→响应式 UI | ⚠️ 部分 | Playwright 视觉对比 |
| 55 | Understand large codebases | 代码库映射+理解 | ✅ | 无（glob+grep+read 已有） |
| 56 | Automate bug triage | Bug 报告→排序+扫描 | ✅ | 无（bash+grep+LLM 可实现） |
| 57 | Make granular UI changes | 微调 UI + 浏览器验证 | ⚠️ 部分 | Playwright 浏览器验证 |
| 58 | Kick off coding tasks from Slack | Slack→编码任务 | ❌ | Slack 集成 |
| 59 | Deploy an app or website | 构建+部署+预览 URL | ❌ | Vercel/部署集成 |
| 60 | QA your app with Computer Use | Computer Use QA 测试 | ❌ | Computer Use |
| 61 | Upgrade your API integration | API 升级迁移 | ✅ | 无（代码读写+LLM 可实现） |
| 62 | Turn Figma designs into code | Figma→代码 | ❌ | Figma 集成 |
| 63 | Create browser-based games | 游戏构建+测试 | ⚠️ 部分 | Playwright 浏览器测试 |
| 64 | Refactor your codebase | 死代码清理+现代化 | ✅ | 无（代码读写+LLM 可实现） |
| 65 | Run code migrations | 代码迁移 | ✅ | 无（代码读写+LLM 可实现） |
| 66 | Update documentation | 源码→文档更新 | ✅ | 无（代码读写+LLM 可实现） |
| 67 | Build and deploy internal apps | 内部应用构建+部署 | ❌ | Sites 托管 |
| 68 | Add evals to your AI application | Promptfoo eval 套件 | ⚠️ 部分 | Promptfoo 集成（但可 bash 运行） |
| 69 | Build React Native apps with Expo | Expo 脚手架+测试 | ⚠️ 部分 | Expo 插件（但可 bash 实现） |
| 70 | Create a CLI Codex can use | 创建可组合 CLI | ✅ | 无（bash 工具已有） |
| 71 | Build a student website | 学生网站构建 | ✅ | 无（代码生成+文件操作已有） |
| 72 | Build a launch campaign kit (web) | 发布活动套件 | ✅ | 无（LLM 可实现） |

### Collection: Native Development（原生开发）

| # | Use Case | Codex 描述 | Codem 可复现 | 缺少什么 |
|---|----------|-----------|-------------|---------|
| 73 | Build a Mac app shell | macOS SwiftUI 应用 | ❌ | Xcode/SwiftUI 工具链 |
| 74 | Build for iOS | iOS SwiftUI 脚手架 | ❌ | Xcode/SwiftUI 工具链 |
| 75 | Build for macOS | macOS 原生应用 | ❌ | Xcode/SwiftUI 工具链 |
| 76 | Debug in iOS simulator | iOS 模拟器调试 | ❌ | XcodeBuildMCP |
| 77 | Add iOS app intents | iOS App Intents | ❌ | Xcode/SwiftUI 工具链 |
| 78 | Add Mac telemetry | Logger 遥测 | ❌ | Xcode/SwiftUI 工具链 |
| 79 | Adopt liquid glass | iOS Liquid Glass 迁移 | ❌ | Xcode 26/iOS 26 API |
| 80 | Refactor SwiftUI screens | SwiftUI 视图拆分 | ❌ | Xcode/SwiftUI 工具链 |
| 81 | Build React Native apps | RN + Expo 应用 | ⚠️ 部分 | Expo 插件（但可 bash 实现） |

### Collection: Production Systems（生产系统）

| # | Use Case | Codex 描述 | Codem 可复现 | 缺少什么 |
|---|----------|-----------|-------------|---------|
| 82 | Run a deep security scan | 深度安全审计 | ✅ | 无（bash+grep+LLM 可实现） |
| 83 | Remediate a vulnerability backlog | 漏洞修复+回归证据 | ✅ | 无（代码读写+LLM 可实现） |
| 84 | Scan code changes for security | PR 安全扫描 | ⚠️ 部分 | GitHub 集成（但可扫本地 diff） |
| 85 | Audit dependency incidents | 依赖安全审计 | ✅ | 无（bash+文件读取可实现） |
| 86 | Bring your app to ChatGPT | ChatGPT 应用 | ❌ | ChatGPT Apps 平台 |
| 87 | Run verified operations workflows | 验证操作工作流 | ✅ | 无（Agent Loop 可实现） |

### Collection: Security（安全）

> 与 Production Systems 重叠，见 #82-85

### Collection: Data Science（数据科学）

| # | Use Case | Codex 描述 | Codem 可复现 | 缺少什么 |
|---|----------|-----------|-------------|---------|
| 88 | Discover protein folding architectures | AlphaFold2 研究 | ✅ | 无（LLM+代码可实现研究） |
| 89 | Clean and prepare messy data | CSV 清洗 | ✅ | 无（bash+LLM 可实现） |
| 90 | Analyze datasets and ship reports | 数据分析+报告 | ✅ | 无（bash+LLM 可实现） |
| 91 | Build a dashboard and monitoring workflow | 仪表盘规格 | ✅ | 无（LLM 可实现规格文档） |

### Collection: Life Sciences（生命科学）

| # | Use Case | Codex 描述 | Codem 可复现 | 缺少什么 |
|---|----------|-----------|-------------|---------|
| 92 | Prioritize drug targets | 药物靶点排序 | ❌ | Life Science Research 插件 |
| 93 | Annotate scRNA-seq data | 单细胞 RNA 标注 | ❌ | NGS Analysis 插件 |
| 94 | Validate bulk RNA-seq inputs | RNA-seq 验证 | ❌ | NGS Analysis 插件 |
| 95 | Discover protein folding models | 蛋白质折叠 | ✅ | 无（LLM+代码可实现） |

### Collection: Finance（金融）

| # | Use Case | Codex 描述 | Codem 可复现 | 缺少什么 |
|---|----------|-----------|-------------|---------|
| 96 | Forecast cash flow | 现金流预测 | ✅ | 无（LLM 可实现） |
| 97 | Model a DCF valuation | DCF 估值 | ✅ | 无（LLM 可实现） |
| 98 | Review budget vs. actuals | 预算审查 | ✅ | 无（LLM 可实现） |
| 99 | Clean and review a financial model | 财务模型清理 | ✅ | 无（LLM 可实现） |

### Collection: Sales（销售）

| # | Use Case | Codex 描述 | Codem 可复现 | 缺少什么 |
|---|----------|-----------|-------------|---------|
| 100 | Prioritize accounts | 账户排序 | ✅ | 无（LLM 可实现） |
| 101 | Diagnose a stalled deal | 交易诊断 | ✅ | 无（LLM 可实现） |
| 102 | Refresh a strategic account plan | 刷新账户计划 | ✅ | 无（LLM 可实现） |
| 103 | Review forecast risk | 预测风险审查 | ✅ | 无（LLM 可实现） |

### Collection: Education（教育）

| # | Use Case | Codex 描述 | Codem 可复现 | 缺少什么 |
|---|----------|-----------|-------------|---------|
| 104 | Audit course section consistency | 课程一致性审计 | ✅ | 无（LLM 可实现） |
| 105 | Build a unit plan from source files | 单元计划 | ✅ | 无（LLM 可实现） |
| 106 | Build a variance driver bridge | 差异驱动桥接 | ✅ | 无（LLM 可实现） |
| 107 | Build an interactive lesson resource | 互动课程 | ❌ | Sites 托管 |
| 108 | Calibrate assessments | 评估校准 | ✅ | 无（LLM 可实现） |
| 109 | Create a classroom materials pack | 课堂材料包 | ✅ | 无（LLM 可实现） |
| 110 | Create a lesson deck | 课程幻灯片 | ⚠️ 部分 | PPT 集成（但可生成 Markdown） |
| 111 | Organize a lesson or unit folder | 课程文件夹整理 | ✅ | 无（文件操作已有） |
| 112 | Organize a semester workspace | 学期工作区整理 | ✅ | 无（文件操作已有） |
| 113 | Refresh course materials | 课程材料刷新 | ✅ | 无（LLM 可实现） |
| 114 | Revise a lesson package | 课程包修订 | ✅ | 无（文件操作+LLM 可实现） |
| 115 | Synthesize research evidence | 研究综合 | ✅ | 无（LLM 可实现） |
| 116 | Track course engagement | 课程参与度追踪 | ✅ | 无（LLM 可实现） |
| 117 | Build a student website | 学生网站 | ✅ | 无（代码生成已有） |
| 118 | Build an exam study system | 考试学习系统 | ✅ | 无（LLM 可实现） |
| 119 | Run a student club project | 学生社团项目 | ✅ | 无（LLM 可实现） |
| 120 | Track job applications | 求职追踪 | ✅ | 无（LLM 可实现） |

---

## 统计汇总

| 可复现度 | 数量 | 占比 |
|---------|------|------|
| ✅ 可直接复现 | 68 | 67% |
| ⚠️ 部分可复现 | 16 | 16% |
| ❌ 无法复现 | 17 | 17% |
| **合计** | **101** | **100%** |

### 无法复现的 17 个 use cases 及缺少能力清单

| # | Use Case | 缺少的核心能力 |
|---|----------|--------------|
| 1 | Get email to inbox zero | Email 集成 + 定时任务 |
| 2 | Use computer with ChatGPT | Computer Use（桌面控制） |
| 4 | Create slide deck | Google Slides/PPT 集成 |
| 5 | Set up work chief of staff | 定时任务 + 多服务集成 |
| 6 | Turn meetings into follow-ups | Zoom 集成 |
| 11 | Prepare meeting briefs | Calendar 集成 |
| 12 | Complete tasks from messages | Messages/iMessage 集成 |
| 44 | Track bills, subscriptions | 银行/账户集成 |
| 45 | Prioritize Slack action items | Slack 集成 |
| 58 | Kick off coding tasks from Slack | Slack 集成 |
| 59 | Deploy app or website | Vercel/部署集成 |
| 60 | QA app with Computer Use | Computer Use |
| 62 | Figma designs to code | Figma 集成 |
| 67 | Build and deploy internal apps | Sites 托管平台 |
| 73-80 | iOS/macOS 原生开发（8个） | Xcode/SwiftUI 工具链 |
| 86 | Bring your app to ChatGPT | ChatGPT Apps 平台 |
| 92-94 | 生命科学（3个） | NGS/Life Science 插件 |
| 107 | Build interactive lesson resource | Sites 托管 |

### 需要补齐的能力清单（按优先级排序）

| 优先级 | 能力 | 影响 use cases 数 | 实现难度 | 说明 |
|--------|------|------------------|---------|------|
| P0 | Playwright 浏览器自动化 | 4 | 中 | 影响 #54,57,63,68 — 可通过 MCP 或 npm 包实现 |
| P0 | Figma 集成（MCP） | 1 | 中 | 影响 #62 — Figma 有 MCP API |
| P0 | GitHub 深度集成 | 2 | 中 | 影响 #53,84 — 可通过 GitHub API + MCP |
| P1 | Slack 集成 | 3 | 高 | 影响 #15,45,58 — Slack API + webhook |
| P1 | 定时任务/Cron | 3 | 中 | 影响 #1,5,13 — Tauri 后台定时执行 |
| P1 | Goal Mode | 1 | 低 | 影响 #3 — 在 Agent Loop 中加目标追踪 |
| P2 | Computer Use | 2 | 极高 | 影响 #2,60 — 需要桌面截图+鼠标键盘控制 |
| P2 | Vercel/部署集成 | 1 | 中 | 影响 #59 — Vercel API |
| P2 | Sites（内部应用托管） | 2 | 高 | 影响 #67,107 — 需要完整 Web 托管 |
| P2 | iOS/macOS 工具链 | 8 | 极高 | 影响 #73-80 — 需要 Xcode + SwiftUI 插件 |
| P3 | Zoom 集成 | 1 | 高 | 影响 #6 — Zoom API |
| P3 | Calendar 集成 | 2 | 中 | 影响 #11,49 — Google Calendar API |
| P3 | Email 集成 | 1 | 高 | 影响 #1 — IMAP/SMTP |
| P3 | NGS/Life Science 插件 | 3 | 高 | 影响 #92-94 — 专业生物信息工具 |
| P3 | ChatGPT Apps 平台 | 1 | 不可行 | 影响 #86 — 需要 OpenAI 平台接入 |
| P3 | 银行/账户集成 | 1 | 高 | 影响 #44 — 金融 API |
| P3 | PPT/Slides 集成 | 1 | 中 | 影响 #4 — Google Slides API |

---

## 结论

Codem 作为**桌面 GUI 编程助手**，在代码生成、文件操作、Agent Loop 等核心能力上可以复现 **67% 的 Codex use cases**，特别是：

- **数据分析与报告类**（100% 可复现）— LLM + bash 工具足以覆盖
- **业务运营类**（90%+ 可复现）— LLM 分析 + 文档生成
- **教育类**（90%+ 可复现）— LLM + 文件操作
- **Web 开发类**（60% 可复现）— 代码读写 + LLM，但缺 Playwright/Figma
- **金融类**（100% 可复现）— LLM + 文件操作

**不可复现的 17 个 use cases** 主要受限于：
1. **第三方 SaaS 集成**（Slack/Zoom/Figma/Calendar/Email）— 需要 MCP 适配器
2. **平台能力**（Computer Use/Sites/iOS 工具链）— 需要深度平台集成
3. **定时任务**— 需要 Tauri 后台调度

**最高 ROI 的补齐路径**：先做 Playwright MCP + Figma MCP + GitHub MCP，即可将可复现率从 67% 提升到 80%+。
