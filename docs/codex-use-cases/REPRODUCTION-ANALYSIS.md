# Codex Use Cases 复现路径分析

> 创建时间：2026-08-01
> 基于：Codem v0.91.0 + Playwright/Figma/GitHub MCP 工具
> 分析目标：逐一分析 82 个可复现 use cases 的复现方式、模型要求、工具调用链路；DeepSeek 纯文本模型可复现范围；19 个不可复现项的改造方案

---

## 第一部分：82 个可复现 Use Cases 的复现方式与工具链路

### 分类说明

| 标记 | 含义 |
|------|------|
| 🟢 纯文本 | 仅需 LLM 文本能力 + bash/文件工具，任何模型可用 |
| 🔵 需浏览器 | 需要 `browser_automate` 工具，但仅用文本输出（navigate/get_text/evaluate） |
| 🟣 需视觉 | 需要 `browser_automate` 截图或 `figma_fetch` 导出图片，模型须支持视觉理解 |
| 🟠 需 GitHub | 需要 `github_tool` 工具，纯文本 API 响应 |
| 🔴 需图片生成 | 需要 `ImageGen` 工具，模型须支持图片生成 |

### A. 业务运营类（35 个）

| # | Use Case | 复现标记 | 复现方式 | 工具调用链路 |
|---|----------|---------|---------|-------------|
| 1 | Clean and prepare messy data | 🟢 | 用户拖入 CSV，LLM 分析数据问题，bash 运行清洗脚本 | `read` → LLM 分析 → `bash`(python/awk 清洗) → `write` 输出 |
| 2 | Forecast cash flow | 🟢 | 用户提供现金流数据，LLM 生成预测模型公式 | `read`(财务数据) → LLM 生成公式 → `write`(Excel/CSV 预测模型) |
| 3 | Analyze datasets and ship reports | 🟢 | bash 运行数据分析脚本，LLM 生成报告 | `bash`(python/R 分析) → LLM 解读结果 → `write`(报告) |
| 4 | Model a DCF valuation | 🟢 | LLM 根据财务输入生成 DCF 估值工作簿 | `read`(历史财务) → LLM 建模 → `write`(估值模型) |
| 5 | Review budget vs. actuals | 🟢 | LLM 将实际数据映射到预算，计算差异 | `read`(预算+实际) → LLM 映射+计算 → `write`(差异报告) |
| 6 | Prepare a business review | 🟢 | LLM 将 KPI/关账/预测输入转化为叙述 | `read`(KPI 数据) → LLM 生成叙述 → `write`(评审报告) |
| 7 | Prepare a leadership reporting pack | 🟢 | LLM 汇总进展/财务/负责人更新 | `read`(多源输入) → LLM 汇总 → `write`(报告包) |
| 8 | Analyze KPI root causes | 🟢 | LLM 分离确认驱动因素与假设 | `read`(KPI 看板+定义) → LLM 根因分析 → `write`(根因简报) |
| 9 | Plan a dashboard and monitoring workflow | 🟢 | LLM 生成仪表盘规格文档 | LLM 生成规格 → `write`(监控计划文档) |
| 10 | Prepare an initiative health update | 🟢 | LLM 汇总计划进展/阻塞/风险 | `read`(追踪器+笔记) → LLM 生成简报 → `write` |
| 11 | Prioritize accounts | 🟢 | LLM 按风险/上行/紧迫性排序 | `read`(账户记录) → LLM 排序+理由 → `write`(排序简报) |
| 12 | Review forecast risk | 🟢 | LLM 审查预测快照+交易上下文 | `read`(预测+交易) → LLM 风险审查 → `write` |
| 13 | Scope an analytics request | 🟢 | LLM 将模糊需求转化为分析计划 | LLM 分析需求 → `write`(分析计划) |
| 14 | Turn research into a decision memo | 🟢 | LLM 分离证据与解读，生成决策备忘录 | `read`(研究文档) → LLM 综合 → `write`(决策备忘录) |
| 15 | Write an initiative off-track brief | 🟢 | LLM 解释偏离原因和建议 | `read`(计划文档+KPI) → LLM 分析 → `write`(偏离简报) |
| 16 | Diagnose a stalled deal | 🟢 | LLM 分析阶段历史+通话记录 | `read`(阶段历史+记录) → LLM 诊断 → `write`(诊断+下一步) |
| 17 | Measure business impact | 🟢 | LLM 量化提升、检查护栏 | `read`(实验数据) → LLM 评估 → `write`(影响报告) |
| 18 | Model strategic scenarios and tradeoffs | 🟢 | LLM 对比战略路径 | `read`(模型+看板) → LLM 对比 → `write`(权衡模型) |
| 19 | Build a variance driver bridge | 🟢 | LLM 排名差异驱动因素 | `read`(实际+预算) → LLM 排名 → `write`(桥接表) |
| 20 | Clean and review a financial model | 🟢 | LLM 检查公式/链接/假设 | `read`(财务模型) → LLM 检查 → `write`(QA 备忘录) |
| 21 | Refresh a forecast and plan | 🟢 | LLM 更新假设+对比场景 | `read`(模型+实际) → LLM 刷新 → `write`(更新模型) |
| 22 | Prepare a committee packet | 🟢 | LLM 生成治理材料包 | `read`(治理上下文) → LLM 生成 → `write`(材料包) |
| 23 | Refresh a strategic account plan | 🟢 | LLM 刷新利益相关者图/风险/下一步 | `read`(账户记录) → LLM 刷新 → `write`(账户计划) |
| 24 | Consolidate spreadsheets | 🟢 | bash 合并 CSV，LLM 清理连接 | `read`(多个 CSV) → `bash`(python 合并) → LLM 清理 → `write` |
| 25 | Run verified operations | 🟢 | LLM 规范化输入+运行脚本+验证 | `read`(输入) → `bash`(运行脚本) → LLM 验证 → `write` |
| 26 | Run event playbooks | 🟢 | LLM 生成可重复活动手册 | LLM 生成手册 → `write`(活动手册) |
| 27 | Audit a workflow | 🟢 | LLM 映射工作流+识别卡点 | `read`(追踪器+流程) → LLM 审计 → `write`(审计+自动化计划) |
| 28 | Build a launch campaign kit | 🟢 | LLM 生成活动套件 | `read`(发布上下文) → LLM 生成 → `write`(活动套件) |
| 29 | Draft PRDs from internal context | 🟢 | LLM 从多源创建 PRD | `read`(Linear/Slack 导出) → LLM 生成 PRD → `write` |
| 30 | Set up a project teammate | 🟢 | Agent Profile 持久化+定时检查 | `spawn_subagent` → Agent Profile 持久化 → `wait_for_subagent` |
| 31 | Plan a budget and schedule | 🟢 | LLM 规划预算+日程 | LLM 规划 → `write`(预算+日程表) |
| 32 | Prepare a monthly business review | 🟢 | LLM 生成月度评审叙述 | `read`(KPI+关账) → LLM 生成 → `write`(月度评审) |
| 33 | Prepare a CFO board reporting pack | 🟢 | LLM 生成 CFO 报告包 | `read`(进展+财务) → LLM 生成 → `write`(CFO 报告包) |
| 34 | Weekly work summary | 🟢 | LLM 汇总一周活动 | `read`(日历/文档/消息导出) → LLM 汇总 → `write`(周报) |
| 35 | Coordinate new-hire onboarding | 🟢 | LLM 生成入职材料 | LLM 生成 → `write`(入职追踪+团队摘要+欢迎空间) |

### B. 生产力与协作类（4 个）

| # | Use Case | 复现标记 | 复现方式 | 工具调用链路 |
|---|----------|---------|---------|-------------|
| 36 | Learn a new concept | 🟢 | LLM 拆分阅读+子智能体并行+生成学习报告 | `spawn_subagent`(多个并行) → `wait_for_subagent` → LLM 综合 → `write`(Markdown 报告) |
| 37 | Save workflows as skills | 🟢 | 将工作聊天保存为可复用技能 | `load_skill` → LLM 提取技能模式 → `write`(SKILL.md) |
| 38 | Iterate on difficult problems | 🟢 | Agent Loop 评分循环改进 | LLM 生成 → `bash`(运行评估) → LLM 打分 → 迭代 |
| 39 | Idea to proof of concept | 🔴 | ImageGen 生成视觉方向+代码实现 | `ImageGen`(视觉原型) → LLM 生成代码 → `write` + `bash`(运行) |

### C. Web 开发类（13 个）

| # | Use Case | 复现标记 | 复现方式 | 工具调用链路 |
|---|----------|---------|---------|-------------|
| 40 | Understand large codebases | 🟢 | glob+grep 追踪请求流+映射模块 | `glob`(文件) → `grep`(搜索) → `read`(关键文件) → LLM 解释 |
| 41 | Automate bug triage | 🟢 | bash+grep 检查警报+问题+日志 | `bash`(检查日志) → `grep`(搜索问题) → LLM 排序 → `write`(优先级列表) |
| 42 | Upgrade your API integration | 🟢 | LLM 读取旧代码+升级 API 调用 | `read`(旧代码) → LLM 升级 → `write`(新代码) → `bash`(测试) |
| 43 | Refactor your codebase | 🟢 | LLM 分步删除死代码+现代化模式 | `read`(代码) → LLM 重构 → `edit`(分步修改) → `bash`(验证行为) |
| 44 | Run code migrations | 🟢 | LLM 映射旧栈到新栈+里程碑验证 | `read`(旧代码) → LLM 迁移 → `write`(新代码) → `bash`(验证) |
| 45 | Update documentation | 🟢 | LLM 对比源码变更+文档 | `read`(源码+文档) → LLM 对比 → `write`(更新文档) |
| 46 | Create a CLI Codex can use | 🟢 | LLM 生成可组合 CLI 脚本 | LLM 生成 CLI → `write`(脚本) → `bash`(测试+注册) |
| 47 | Build a student website | 🟢 | LLM 生成网站代码+文件操作 | LLM 生成 HTML/CSS/JS → `write`(多文件) → `bash`(测试) |
| 48 | Review GitHub pull requests | 🟠 | github_tool 获取 PR diff+审查 | `github_tool`(pr_review) → LLM 审查 diff → `write`(审查报告) |
| 49 | Scan code changes for security | 🟠 | github_tool 获取 diff+安全分析 | `github_tool`(pr_review) → LLM 安全扫描 → `write`(安全报告) |
| 50 | Build responsive front-end designs | 🟣 | 截图→代码→Playwright 视觉对比 | `read`(截图+设计简报) → LLM 生成 UI → `write` → `browser_automate`(截图对比) |
| 51 | Make granular UI changes | 🟣 | 代码修改+浏览器验证 | LLM 修改 UI → `edit` → `browser_automate`(navigate+screenshot 验证) |
| 52 | Create browser-based games | 🟣 | 游戏计划→代码→浏览器测试 | LLM 生成游戏代码 → `write` → `browser_automate`(navigate+screenshot 测试) |
| 53 | Add evals to your AI application | 🟢 | bash 运行 Promptfoo eval | `read`(应用代码) → LLM 生成 eval → `write`(eval 配置) → `bash`(运行 promptfoo) |

### D. 安全类（5 个）

| # | Use Case | 复现标记 | 复现方式 | 工具调用链路 |
|---|----------|---------|---------|-------------|
| 54 | Run a deep security scan | 🟢 | bash+grep 深度搜索+LLM 验证 | `grep`(搜索漏洞模式) → `bash`(扫描) → LLM 验证 → `write`(安全报告) |
| 55 | Remediate a vulnerability backlog | 🟢 | LLM 生成最小修复+回归证据 | `read`(漏洞列表) → LLM 生成修复 → `edit` → `bash`(回归测试) |
| 56 | Audit dependency incidents | 🟠 | github_tool 检查漏洞+本地审计 | `github_tool`(vulnerability_scan) → `read`(manifest/lock) → LLM 分析 → `write` |
| 57 | Scan code changes for security | 🟠 | github_tool diff+安全分析 | `github_tool`(pr_review) → LLM 安全扫描 diff → `write` |
| 58 | Run verified operations | 🟢 | LLM 规范化+运行+验证 | `read`(输入) → `bash`(运行) → LLM 验证 → `write` |

### E. 数据科学类（1 个）

| # | Use Case | 复现标记 | 复现方式 | 工具调用链路 |
|---|----------|---------|---------|-------------|
| 59 | Discover protein folding models | 🟢 | LLM 研究+代码生成+实验循环 | `web_search`(文献) → LLM 设计架构 → `write`(代码) → `bash`(运行实验) |

### F. 教育类（18 个）

| # | Use Case | 复现标记 | 复现方式 | 工具调用链路 |
|---|----------|---------|---------|-------------|
| 60 | Audit course section consistency | 🟢 | LLM 对比课程大纲/作业/政策 | `read`(多个课程文件) → LLM 对比 → `write`(一致性审计) |
| 61 | Build a unit plan from source files | 🟢 | LLM 生成教学序列 | `read`(标准+课程) → LLM 生成 → `write`(单元计划) |
| 62 | Build a variance driver bridge | 🟢 | LLM 生成差异桥接表 | `read`(实际+预算) → LLM 生成 → `write`(桥接表) |
| 63 | Calibrate assessments | 🟢 | LLM 审查评分模式 | `read`(提交+评分标准) → LLM 校准 → `write`(校准工作簿) |
| 64 | Create a classroom materials pack | 🟢 | LLM 生成教学+练习+家庭材料 | LLM 生成 → `write`(多份材料文件) |
| 65 | Organize a lesson or unit folder | 🟢 | 文件操作整理 | `glob`(扫描文件) → LLM 规划结构 → `bash`(mv/mkdir 整理) → `write`(变更摘要) |
| 66 | Organize a semester workspace | 🟢 | 文件操作+截止日期追踪 | `glob` → LLM 规划 → `bash`(整理) → `write`(截止日期追踪) |
| 67 | Refresh course materials | 🟢 | LLM 审查课程系统 | `read`(课程文件) → LLM 审查 → `write`(刷新计划) |
| 68 | Revise a lesson package | 🟢 | LLM+文件操作应用反馈 | `read`(课程+反馈) → LLM 修订 → `edit`(更新文件) → `write`(变更日志) |
| 69 | Synthesize research evidence | 🟢 | LLM 综合+证据标注 | `read`(论文+笔记) → LLM 综合 → `write`(证据库) |
| 70 | Track course engagement | 🟢 | LLM 分析参与度 | `read`(LMS 导出) → LLM 分析 → `write`(参与度看板) |
| 71 | Track job applications | 🟢 | LLM 管理求职 | `read`(职位描述+简历) → LLM 匹配 → `write`(求职追踪) |
| 72 | Build a student website | 🟢 | LLM 生成网站 | LLM 生成 → `write`(多文件) → `bash`(测试) |
| 73 | Build an exam study system | 🟢 | LLM 生成学习指南+题库 | `read`(课程材料) → LLM 生成 → `write`(学习指南+题库) |
| 74 | Run a student club project | 🟢 | LLM 协调计划+预算+追踪 | LLM 生成 → `write`(里程碑+预算+追踪) |
| 75 | Create a lesson deck | 🟣 | figma_fetch 导出设计+LLM 生成幻灯片 | `figma_fetch`(export) → LLM 生成内容 → `write`(Markdown 幻灯片) |
| 76 | Turn Figma designs into code | 🟣 | figma_fetch 获取设计+LLM 转代码 | `figma_fetch`(structure+node) → LLM 转换 → `write`(组件代码) |
| 77 | Build React Native apps with Expo | 🟣 | LLM 生成 RN 代码+浏览器验证 | LLM 生成代码 → `write` → `browser_automate`(Expo Web 验证) |

### G. 生产力额外（2 个）

| # | Use Case | 复现标记 | 复现方式 | 工具调用链路 |
|---|----------|---------|---------|-------------|
| 78 | Turn user stories into UI mocks | 🔴 | ImageGen 生成 UI 原型 | `read`(用户故事) → LLM 规范化 → `ImageGen`(UI 原型) |
| 79 | Follow a goal | 🟢 | Goal Mode 跨轮目标追踪 | LLM 解析目标 → Agent Loop 持续执行 → `ask_clarification`(需澄清时) |

### H. 浏览器/工具增强类（3 个）

| # | Use Case | 复现标记 | 复现方式 | 工具调用链路 |
|---|----------|---------|---------|-------------|
| 80 | Use your computer with Codex | 🔵 | browser_automate 执行桌面任务 | `browser_automate`(navigate+click+fill) → LLM 分析结果 |
| 81 | QA your app with Computer Use | 🔵 | browser_automate 点击+提取+记录 | `browser_automate`(navigate+click+get_text) → LLM 分析 → `write`(Bug 报告) |
| 82 | Build a Mac app shell | 🟢 | LLM 生成 SwiftUI 代码（无法编译但可生成） | LLM 生成 SwiftUI → `write`(Swift 文件) |

---

## 第二部分：DeepSeek 纯文本模型可复现的 Use Cases

### DeepSeek 能力边界

| 能力 | DeepSeek 支持 | 说明 |
|------|-------------|------|
| 文本生成 | ✅ | 代码、报告、文档、分析 |
| 函数调用 | ✅ | tool_calls 格式 |
| 长上下文 | ✅ | 64K-128K tokens |
| **视觉理解** | ❌ | 无法解析图片/截图 |
| **图片生成** | ❌ | 无 ImageGen 能力 |
| 代码执行 | ✅ | 通过 bash 工具间接执行 |

### DeepSeek 可用工具链

| 工具 | 可用度 | 限制 |
|------|--------|------|
| bash | ✅ 完全可用 | — |
| read | ✅ 完全可用 | — |
| write | ✅ 完全可用 | — |
| edit / multi_edit | ✅ 完全可用 | — |
| glob | ✅ 完全可用 | — |
| grep | ✅ 完全可用 | — |
| web_search | ✅ 完全可用 | — |
| spawn_subagent | ✅ 完全可用 | — |
| browser_automate | ⚠️ **仅文本操作** | 可 navigate/click/fill/get_text/evaluate，**不可截图视觉对比** |
| figma_fetch | ⚠️ **仅文本数据** | 可获取 structure/components/styles，**不可导出图片用于设计转码** |
| github_tool | ✅ 完全可用 | 所有 API 返回纯文本 |
| ImageGen | ❌ 不可用 | DeepSeek 无图片生成能力 |

### DeepSeek 可完全复现的 Use Cases（68 个）

以下 use cases **仅依靠 DeepSeek 文本能力 + 工具即可完全复现**，不依赖任何视觉理解或图片生成：

#### 🟢 纯文本类（65 个）

| # | Use Case | 复现步骤 | 工具调用链路 |
|---|----------|---------|-------------|
| 1 | Clean and prepare messy data | ① `read` 读取 CSV ② DeepSeek 分析数据问题 ③ `bash` 运行 Python 清洗脚本 ④ `write` 输出干净数据 | `read` → LLM → `bash` → `write` |
| 2 | Forecast cash flow | ① `read` 读取现金流输入 ② DeepSeek 生成预测公式 ③ `write` 输出可编辑工作簿 | `read` → LLM → `write` |
| 3 | Analyze datasets and ship reports | ① `bash` 运行 Python 数据分析 ② DeepSeek 解读结果 ③ `write` 生成报告 | `bash` → LLM → `write` |
| 4 | Model a DCF valuation | ① `read` 读取财务输入 ② DeepSeek 生成 DCF 模型 ③ `write` 输出估值工作簿 | `read` → LLM → `write` |
| 5 | Review budget vs. actuals | ① `read` 读取预算+实际 ② DeepSeek 映射+计算差异 ③ `write` 输出差异报告 | `read` → LLM → `write` |
| 6 | Prepare a business review | ① `read` 读取 KPI/关账数据 ② DeepSeek 生成叙述 ③ `write` 输出评审报告 | `read` → LLM → `write` |
| 7 | Prepare a leadership reporting pack | ① `read` 读取进展+财务 ② DeepSeek 汇总 ③ `write` 输出报告包 | `read` → LLM → `write` |
| 8 | Analyze KPI root causes | ① `read` 读取 KPI 看板 ② DeepSeek 根因分析 ③ `write` 输出根因简报 | `read` → LLM → `write` |
| 9 | Plan a dashboard and monitoring workflow | ① DeepSeek 生成仪表盘规格 ② `write` 输出监控计划 | LLM → `write` |
| 10 | Prepare an initiative health update | ① `read` 读取追踪器 ② DeepSeek 生成简报 ③ `write` | `read` → LLM → `write` |
| 11 | Prioritize accounts | ① `read` 读取账户记录 ② DeepSeek 排序+理由 ③ `write` | `read` → LLM → `write` |
| 12 | Review forecast risk | ① `read` 读取预测+交易 ② DeepSeek 风险审查 ③ `write` | `read` → LLM → `write` |
| 13 | Scope an analytics request | ① DeepSeek 分析需求 ② `write` 输出分析计划 | LLM → `write` |
| 14 | Turn research into a decision memo | ① `read` 读取研究 ② DeepSeek 综合 ③ `write` 输出备忘录 | `read` → LLM → `write` |
| 15 | Write an initiative off-track brief | ① `read` 读取计划+KPI ② DeepSeek 分析偏离 ③ `write` | `read` → LLM → `write` |
| 16 | Diagnose a stalled deal | ① `read` 读取阶段历史 ② DeepSeek 诊断 ③ `write` | `read` → LLM → `write` |
| 17 | Measure business impact | ① `read` 读取实验数据 ② DeepSeek 评估 ③ `write` | `read` → LLM → `write` |
| 18 | Model strategic scenarios | ① `read` 读取模型 ② DeepSeek 对比 ③ `write` | `read` → LLM → `write` |
| 19 | Build a variance driver bridge | ① `read` 读取实际+预算 ② DeepSeek 排名 ③ `write` | `read` → LLM → `write` |
| 20 | Clean and review a financial model | ① `read` 读取模型 ② DeepSeek 检查公式 ③ `write` QA 备忘录 | `read` → LLM → `write` |
| 21 | Refresh a forecast and plan | ① `read` 读取模型+实际 ② DeepSeek 刷新 ③ `write` | `read` → LLM → `write` |
| 22 | Prepare a committee packet | ① `read` 读取治理上下文 ② DeepSeek 生成 ③ `write` | `read` → LLM → `write` |
| 23 | Refresh a strategic account plan | ① `read` 读取账户记录 ② DeepSeek 刷新 ③ `write` | `read` → LLM → `write` |
| 24 | Consolidate spreadsheets | ① `read` 读取多个 CSV ② `bash` 合并 ③ DeepSeek 清理 ④ `write` | `read` → `bash` → LLM → `write` |
| 25 | Run verified operations | ① `read` 读取输入 ② `bash` 运行脚本 ③ DeepSeek 验证 ④ `write` | `read` → `bash` → LLM → `write` |
| 26 | Run event playbooks | ① DeepSeek 生成手册 ② `write` 输出 | LLM → `write` |
| 27 | Audit a workflow | ① `read` 读取追踪器+流程 ② DeepSeek 审计 ③ `write` | `read` → LLM → `write` |
| 28 | Build a launch campaign kit | ① `read` 读取发布上下文 ② DeepSeek 生成 ③ `write` | `read` → LLM → `write` |
| 29 | Draft PRDs from internal context | ① `read` 读取 Linear/Slack 导出 ② DeepSeek 生成 PRD ③ `write` | `read` → LLM → `write` |
| 30 | Set up a project teammate | ① `spawn_subagent` 创建子智能体 ② Agent Profile 持久化 ③ `wait_for_subagent` | `spawn_subagent` → Profile → `wait_for_subagent` |
| 31 | Plan a budget and schedule | ① DeepSeek 规划 ② `write` 输出预算+日程 | LLM → `write` |
| 32 | Prepare a monthly business review | ① `read` 读取 KPI+关账 ② DeepSeek 生成 ③ `write` | `read` → LLM → `write` |
| 33 | Prepare a CFO board reporting pack | ① `read` 读取进展+财务 ② DeepSeek 生成 ③ `write` | `read` → LLM → `write` |
| 34 | Weekly work summary | ① `read` 读取活动导出 ② DeepSeek 汇总 ③ `write` | `read` → LLM → `write` |
| 35 | Coordinate new-hire onboarding | ① DeepSeek 生成材料 ② `write` 输出入职追踪+摘要 | LLM → `write` |
| 36 | Learn a new concept | ① `spawn_subagent` 多个子智能体并行阅读 ② `wait_for_subagent` ③ DeepSeek 综合 ④ `write` Markdown 报告 | `spawn_subagent` × N → `wait_for_subagent` → LLM → `write` |
| 37 | Save workflows as skills | ① DeepSeek 提取工作流模式 ② `write` SKILL.md | LLM → `write` |
| 38 | Iterate on difficult problems | ① DeepSeek 生成方案 ② `bash` 运行评估 ③ DeepSeek 打分 ④ 迭代 | LLM → `bash` → LLM → 循环 |
| 39 | Understand large codebases | ① `glob` 扫描文件 ② `grep` 搜索关键模式 ③ `read` 读取关键文件 ④ DeepSeek 解释 | `glob` → `grep` → `read` → LLM |
| 40 | Automate bug triage | ① `bash` 检查日志 ② `grep` 搜索问题 ③ DeepSeek 排序 ④ `write` | `bash` → `grep` → LLM → `write` |
| 41 | Upgrade your API integration | ① `read` 旧代码 ② DeepSeek 升级 ③ `write` 新代码 ④ `bash` 测试 | `read` → LLM → `write` → `bash` |
| 42 | Refactor your codebase | ① `read` 代码 ② DeepSeek 重构 ③ `edit` 分步修改 ④ `bash` 验证 | `read` → LLM → `edit` → `bash` |
| 43 | Run code migrations | ① `read` 旧代码 ② DeepSeek 迁移 ③ `write` 新代码 ④ `bash` 验证 | `read` → LLM → `write` → `bash` |
| 44 | Update documentation | ① `read` 源码+文档 ② DeepSeek 对比 ③ `write` 更新文档 | `read` → LLM → `write` |
| 45 | Create a CLI Codex can use | ① DeepSeek 生成 CLI 脚本 ② `write` ③ `bash` 测试 | LLM → `write` → `bash` |
| 46 | Build a student website | ① DeepSeek 生成 HTML/CSS/JS ② `write` 多文件 ③ `bash` 测试 | LLM → `write` → `bash` |
| 47 | Run a deep security scan | ① `grep` 搜索漏洞模式 ② `bash` 扫描 ③ DeepSeek 验证 ④ `write` 报告 | `grep` → `bash` → LLM → `write` |
| 48 | Remediate a vulnerability backlog | ① `read` 漏洞列表 ② DeepSeek 生成修复 ③ `edit` ④ `bash` 回归测试 | `read` → LLM → `edit` → `bash` |
| 49 | Run verified operations | ① `read` 输入 ② `bash` 运行 ③ DeepSeek 验证 ④ `write` | `read` → `bash` → LLM → `write` |
| 50 | Discover protein folding models | ① `web_search` 文献 ② DeepSeek 设计架构 ③ `write` 代码 ④ `bash` 运行 | `web_search` → LLM → `write` → `bash` |
| 51-65 | 教育 15 个 | 同第一部分教育类，全部 `read` → LLM → `write` 模式 | 同上 |
| 66 | Follow a goal | ① DeepSeek 解析目标 ② Agent Loop 持续执行 ③ `ask_clarification` 需澄清时 | LLM → Agent Loop → `ask_clarification` |

#### 🟠 GitHub 工具类（3 个，纯文本 API 响应）

| # | Use Case | 复现步骤 | 工具调用链路 |
|---|----------|---------|-------------|
| 67 | Review GitHub pull requests | ① `github_tool`(pr_review) 获取 PR diff+文件+reviews ② DeepSeek 审查代码变更 ③ `write` 审查报告 | `github_tool` → LLM → `write` |
| 68 | Scan code changes for security | ① `github_tool`(pr_review) 获取 diff ② DeepSeek 安全分析 ③ `write` 安全报告 | `github_tool` → LLM → `write` |
| 69 | Audit dependency incidents | ① `github_tool`(vulnerability_scan) 检查漏洞 ② `read` manifest/lock ③ DeepSeek 分析 ④ `write` | `github_tool` → `read` → LLM → `write` |

#### 🟢 bash 驱动类（1 个，文本结果）

| # | Use Case | 复现步骤 | 工具调用链路 |
|---|----------|---------|-------------|
| 70 | Add evals to your AI application | ① `read` 应用代码 ② DeepSeek 识别行为 ③ `write` Promptfoo eval 配置 ④ `bash` 运行 promptfoo ⑤ DeepSeek 解读文本结果 | `read` → LLM → `write` → `bash` → LLM |

#### 🔵 浏览器文本操作类（2 个，不依赖截图）

| # | Use Case | 复现步骤 | 工具调用链路 |
|---|----------|---------|-------------|
| 71 | Use your computer (text-only) | ① `browser_automate`(navigate+click+fill+get_text) ② DeepSeek 分析文本结果 ③ `write` 任务报告 | `browser_automate` → LLM → `write` |
| 72 | QA your app (text-only) | ① `browser_automate`(navigate+click+get_text) 提取文本 ② DeepSeek 分析异常 ③ `write` Bug 报告 | `browser_automate` → LLM → `write` |

### DeepSeek 不可复现的 Use Cases（14 个，需要视觉/图片生成）

| # | Use Case | 原因 | 需要的能力 |
|---|----------|------|-----------|
| 1 | Build responsive front-end designs | 需要截图视觉对比 | 视觉理解（对比实现 vs 参考图） |
| 2 | Make granular UI changes | 需要浏览器截图验证 | 视觉理解（验证 UI 变更效果） |
| 3 | Create browser-based games | 需要浏览器视觉测试 | 视觉理解（验证游戏画面） |
| 4 | Turn Figma designs into code | 需要看 Figma 导出的图片 | 视觉理解（设计稿→代码） |
| 5 | Create a lesson deck | 需要 Figma 导出图片 | 视觉理解（设计资产→幻灯片） |
| 6 | Turn user stories into UI mocks | 需要图片生成 | ImageGen |
| 7 | Idea to proof of concept | 需要图片生成 | ImageGen |
| 8 | Build React Native apps with Expo | 需要浏览器视觉验证 | 视觉理解（验证 Expo 应用界面） |
| 9-14 | （与第一部分 🟣/🔴 标记一致） | 同上 | 同上 |

### DeepSeek 复现统计

| 类别 | 数量 | 占比 |
|------|------|------|
| DeepSeek 可完全复现 | **70** | **69%** |
| DeepSeek 不可复现（需视觉/图生） | 14 | 14% |
| 完全不可复现（缺 SaaS/平台） | 12 | 12% |
| 部分可复现 | 5 | 5% |

---

## 第三部分：不可复现 Use Cases 的改造方案

### A. 完全不可复现的 12 个 Use Cases

#### 1. Get your email to inbox zero

| 维度 | 说明 |
|------|------|
| **缺少能力** | Email 集成（IMAP/SMTP）+ 定时任务 |
| **改造方案** | ① 实现 IMAP/SMTP MCP 工具 ② Tauri 后台定时任务调度器 ③ 邮件解析（mime 解析）+ 草拟回复 |
| **难度** | 🔴 高 — IMAP 协议复杂，邮件解析需处理 MIME/附件/编码 |
| **影响范围** | `src/core/llm/tools/` 新增 email 工具；`src-tauri/` 新增定时调度 |
| **潜在隐患** | ① 凭证安全（邮箱密码/ OAuth token 存储）② 误发风险（自动发送邮件需人工确认）③ 邮件协议兼容性（Exchange vs Gmail vs 自建）④ 隐私合规（邮件内容上传 LLM） |

#### 2. Use your computer with ChatGPT (Computer Use)

| 维度 | 说明 |
|------|------|
| **缺少能力** | Computer Use — 桌面截图 + 鼠标/键盘控制 |
| **改造方案** | ① Tauri 后端截图 API ② 系统级鼠标/键盘模拟（Windows: SendInput, macOS: CGEvent）③ 视觉模型理解截图 ④ 生成操作指令 |
| **难度** | 🔴 极高 — 跨平台桌面控制是 OS 级工程 |
| **影响范围** | `src-tauri/` 大量新增 Rust 代码；前端需视觉模型支持 |
| **潜在隐患** | ① 安全风险（桌面控制可能执行危险操作）② 权限问题（macOS 需辅助功能权限）③ 性能（截图+视觉理解延迟高）④ 可靠性（UI 元素定位不精确）⑤ 用户体验（自动化操作不透明） |

#### 3. Create or revise a slide deck

| 维度 | 说明 |
|------|------|
| **缺少能力** | Google Slides API 或 PPTX 生成 |
| **改造方案** | 方案 A：Google Slides API MCP（需 OAuth）<br>方案 B：PptxGenJS 库直接生成 .pptx 文件 |
| **难度** | 🟡 中 — PptxGenJS 方案较简单 |
| **影响范围** | `src/core/llm/tools/` 新增 slide 生成工具 |
| **潜在隐患** | ① 布局精度（LLM 生成的幻灯片布局可能不美观）② 模板支持（用户自定义模板需预存）③ 图片嵌入（需处理图片资源路径） |

#### 4. Set up a work chief of staff

| 维度 | 说明 |
|------|------|
| **缺少能力** | 定时任务 + 多服务集成（Email/Calendar/Slack/Docs） |
| **改造方案** | ① Tauri 后台定时任务调度 ② 多 MCP 连接管理 ③ 状态持久化（上次检查时间）④ 增量检查逻辑 |
| **难度** | 🔴 高 — 多服务集成的认证+API 差异大 |
| **影响范围** | `src-tauri/` 新增调度器；`src/core/mcp/` 增强连接管理 |
| **潜在隐患** | ① API 速率限制（每小时检查多个服务）② Token 过期处理 ③ 状态一致性（多服务交叉引用）④ 隐私合规（聚合多源数据） |

#### 5. Turn meetings into follow-ups

| 维度 | 说明 |
|------|------|
| **缺少能力** | Zoom API 集成 |
| **改造方案** | ① Zoom OAuth + REST API MCP ② 获取会议转录文本 ③ LLM 提取行动项 |
| **难度** | 🟡 中 — Zoom API 文档完善 |
| **影响范围** | `src/core/llm/tools/` 新增 zoom 工具 |
| **潜在隐患** | ① OAuth 流程（需回调 URL）② 录音权限（需会议主持人授权）③ 转录延迟（Zoom 转录可能不可实时）④ 多语言（非英语会议转录质量） |

#### 6. Prepare meeting briefs

| 维度 | 说明 |
|------|------|
| **缺少能力** | Google Calendar API |
| **改造方案** | ① Google Calendar OAuth + API MCP ② 获取日历上下文 ③ LLM 生成议程 |
| **难度** | 🟡 中 |
| **影响范围** | `src/core/llm/tools/` 新增 calendar 工具 |
| **潜在隐患** | ① Google OAuth 配置 ② 日历隐私 ③ 多日历合并 ④ 时区处理 |

#### 7. Complete tasks from messages

| 维度 | 说明 |
|------|------|
| **缺少能力** | iMessage/消息应用集成 |
| **改造方案** | macOS: AppleScript 读取 Messages；Windows: 不可行（无 Messages API） |
| **难度** | 🔴 高 — 平台限制大 |
| **影响范围** | `src-tauri/` macOS 专用代码 |
| **潜在隐患** | ① 仅 macOS 可用 ② 消息隐私 ③ 回复发送风险 ④ 联系人信息暴露 |

#### 8. Build a dashboard that stays up to date

| 维度 | 说明 |
|------|------|
| **缺少能力** | 定时任务 + Web 仪表盘托管 |
| **改造方案** | ① Tauri 定时任务 ② 生成静态 HTML 仪表盘 ③ 本地文件服务器或内网部署 |
| **难度** | 🟡 中 |
| **影响范围** | `src-tauri/` 定时调度；`src/core/llm/tools/` 生成 HTML |
| **潜在隐患** | ① 数据源安全（凭证存储）② 仪表盘安全（本地文件可能泄露）③ 数据刷新一致性 |

#### 9. Track bills, subscriptions, and spending

| 维度 | 说明 |
|------|------|
| **缺少能力** | 银行/金融 API 集成 |
| **改造方案** | ① Plaid/Mint API MCP ② 账户聚合 ③ LLM 分析消费模式 |
| **难度** | 🔴 高 — 金融 API 需要合规审核 |
| **影响范围** | `src/core/llm/tools/` 新增 finance 工具 |
| **潜在隐患** | ① 金融数据安全（银行凭证）② 合规要求（金融数据存储/传输）③ API 费用（Plaid 按调用收费）④ 误报风险（自动分类可能不准确） |

#### 10. Prioritize Slack action items

| 维度 | 说明 |
|------|------|
| **缺少能力** | Slack API 集成 |
| **改造方案** | ① Slack OAuth + Web API MCP ② 获取频道消息/DM ③ LLM 提取行动项+排序 |
| **难度** | 🟡 中 — Slack API 文档完善 |
| **影响范围** | `src/core/llm/tools/` 新增 slack 工具 |
| **潜在隐患** | ① Slack OAuth 需回调 URL（桌面应用需深链接）② Rate limiting ③ 私有频道权限 ④ 消息隐私（上传 LLM） |

#### 11. Bring your app to ChatGPT

| 维度 | 说明 |
|------|------|
| **缺少能力** | ChatGPT Apps 平台接入 |
| **改造方案** | 不可行 — 需要 OpenAI 平台开发者注册+审核 |
| **难度** | ⚫ 不可行 |
| **影响范围** | — |
| **潜在隐患** | 平台依赖，不可控 |

#### 12. Build an interactive lesson resource

| 维度 | 说明 |
|------|------|
| **缺少能力** | Sites（Web 应用托管平台） |
| **改造方案** | 方案 A：本地静态文件服务器+生成的交互 HTML<br>方案 B：集成第三方托管（Vercel/Netlify） |
| **难度** | 🟡 中（方案 A）/ 🔴 高（方案 B） |
| **影响范围** | `src-tauri/` 本地服务器或第三方 API |
| **潜在隐患** | ① 托管安全 ② 交互内容需要 JS 运行时 ③ 分享链接持久性 ④ 内容更新同步 |

---

### B. 部分可复现的 7 个 Use Cases

#### 1. Kick off coding tasks from Slack

| 维度 | 说明 |
|------|------|
| **已有** | `github_tool` 可关联 GitHub issues |
| **缺少** | Slack API（读取 Slack 线程→创建编码任务） |
| **改造方案** | Slack OAuth + Web API MCP |
| **难度** | 🟡 中 |
| **潜在隐患** | Slack OAuth 回调、消息隐私 |

#### 2. Analyze product feedback across tools

| 维度 | 说明 |
|------|------|
| **已有** | `github_tool` 可获取 GitHub issues；`bash` 可读取 CSV 导出 |
| **缺少** | Slack API（读取 Slack 线程） |
| **改造方案** | Slack MCP + GitHub MCP 组合 |
| **难度** | 🟡 中 |
| **潜在隐患** | 多源数据格式不统一、反馈去重 |

#### 3. Deploy an app or website

| 维度 | 说明 |
|------|------|
| **已有** | `browser_automate` 可验证部署后的应用 |
| **缺少** | Vercel/Netlify API（一键部署+预览 URL） |
| **改造方案** | Vercel API MCP（createDeployment + getDeployment） |
| **难度** | 🟡 中 |
| **潜在隐患** | 部署凭证安全、构建失败处理、预览 URL 持久性 |

#### 4. Build and deploy internal apps

| 维度 | 说明 |
|------|------|
| **已有** | `browser_automate` 可测试应用；代码生成可构建应用 |
| **缺少** | Sites 托管平台 |
| **改造方案** | 本地静态服务器 或 Vercel 集成 |
| **难度** | 🟡 中 |
| **潜在隐患** | 托管安全、分享链接、内容持久性 |

#### 5. Create a lesson deck

| 维度 | 说明 |
|------|------|
| **已有** | `figma_fetch` 可导出设计资产（PNG）；LLM 可生成内容 |
| **缺少** | PPT/Google Slides 集成 |
| **改造方案** | PptxGenJS 生成 .pptx 文件 |
| **难度** | 🟡 中 |
| **潜在隐患** | 布局精度、模板支持 |

#### 6. Weekly work summary

| 维度 | 说明 |
|------|------|
| **已有** | LLM 可汇总文本文件 |
| **缺少** | Calendar/Slack/Docs 自动拉取 |
| **改造方案** | Google Calendar MCP + Slack MCP |
| **难度** | 🟡 中 |
| **潜在隐患** | 多源 OAuth、数据隐私 |

#### 7. Track bills, subscriptions, and spending (partial)

| 维度 | 说明 |
|------|------|
| **已有** | LLM 可分析 CSV 导出的账单数据 |
| **缺少** | 银行 API 自动拉取 |
| **改造方案** | 手动导出 CSV + `bash` 解析 + LLM 分析 |
| **难度** | 🟢 低（手动导出路径） |
| **潜在隐患** | 数据不实时、手动操作繁琐 |

---

### C. 改造优先级矩阵

| 优先级 | 改造项 | 解锁 use cases | 难度 | ROI |
|--------|--------|---------------|------|-----|
| **P0** | 定时任务/Cron | 3 (inbox zero, chief of staff, dashboard) | 中 | ⭐⭐⭐ |
| **P0** | Goal Mode | 1 (follow goals) | 低 | ⭐⭐ |
| **P1** | Slack MCP | 3 (slack tasks, feedback, slack triage) | 中 | ⭐⭐⭐ |
| **P1** | Google Calendar MCP | 2 (meeting briefs, weekly summary) | 中 | ⭐⭐ |
| **P1** | PptxGenJS 幻灯片生成 | 1 (slide deck) + 1 partial | 中 | ⭐⭐ |
| **P2** | Vercel 部署 MCP | 2 (deploy app, internal apps) | 中 | ⭐⭐ |
| **P2** | Zoom MCP | 1 (meeting follow-ups) | 中 | ⭐ |
| **P2** | Email (IMAP/SMTP) MCP | 1 (inbox zero) | 高 | ⭐ |
| **P3** | Computer Use | 2 (computer use, QA) | 极高 | ⭐ |
| **P3** | 银行 API (Plaid) | 1 (track bills) | 极高 | ⭐ |
| **P3** | Sites 托管 | 2 (internal apps, lesson resource) | 高 | ⭐ |
| **P3** | iOS/macOS 工具链 | 8 (native dev) | 极高 | ⭐ |
| **⚫** | ChatGPT Apps 平台 | 1 | 不可行 | — |

---

## 总结

### 三层复现能力

| 层级 | 条件 | 可复现 use cases | 占比 |
|------|------|-----------------|------|
| **L0: 纯文本模型** | DeepSeek + bash/文件工具 | 70 | 69% |
| **L1: 视觉模型** | GPT-4o/Claude + Playwright + Figma | 82 | 81% |
| **L2: 全集成** | + Slack/Calendar/定时任务/部署 | 89+ | 88%+ |
| **不可达** | Computer Use/iOS/银行/ChatGPT Apps | 12 | 12% |

### DeepSeek 用户的核心体验

DeepSeek 纯文本模型用户可以完全复现 **70/101 = 69%** 的 Codex use cases，覆盖：
- ✅ 全部数据分析/财务建模/业务运营（31 个）
- ✅ 全部教育类（15 个）
- ✅ 全部安全类（5 个）
- ✅ 大部分 Web 开发（10 个，不含视觉验证类）
- ✅ GitHub PR 审查/安全扫描（3 个）
- ✅ 浏览器文本操作（2 个）
- ✅ 生产力工具（4 个）

**DeepSeek 用户的唯一限制**：无法做视觉对比和图片生成 — 即前端设计的视觉验证和 UI 原型生成。这些 use cases 需要切换到支持视觉的模型（如 GPT-4o、Claude 3.5 Sonnet）才能完全复现。
