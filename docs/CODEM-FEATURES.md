# Codem 全功能目录（网站需求基线）

> 生成自仓库根 `项目功能树-全量.md`（由 18 路代码审计生成，2779 个叶子）。本文按 slice / 域 / 组 / 叶子逐条收录，供网站 IA 与截图清单使用。

## 覆盖统计

| slice | 主题 | 组数 | 叶子数 |
|---|---|---|---|
| `slice12` | 存储/会话/记忆/知识 core | 15 | 92 |
| `slice13` | 协作与自动化 core：subagent/agent-teams/squad/session(跨会话委派 bus/executor)/automation/goal/inbox/issue | 25 | 171 |
| `slice10` | 宠物/启动/引导/杂项：PetWindowApp/PetSprite/宠物 UI、BootSplash/BootstrapWizard/OnboardingTour/AppErrorBoundary/ToastNotification/Drawer/ui 原语库等其余未归他片的组件（遍历补漏） | 13 | 66 |
| `slice11` | 引擎能力层：agentic-loop/streaming/compaction/prompt 构建/context 预算/vision-proxy/multimodal/model-profile/model-resolver/provider 多厂商/capability-detector/run-status/transcript-cache/idle-tracker 等（不含 tools/ 单独片） | 24 | 126 |
| `slice14` | 连接·工程·安全 core：phone-link/wechat-bridge/computer-use/browser(playwright)/environment(worktree 自动提交变更追踪)/cicd/project/config(层级)/permission(安全模式 bash-analyzer)/sandbox(sandbox-acl)/auth | 32 | 211 |
| `slice17` | 大富翁游戏全部玩法（引擎/系统/数据/UI/存档） | 7 | 141 |
| `slice18` | LLM 工具全集（tools.ts + tools/*.ts 每个工具的 id/guidance/description，逐个列叶子） | 31 | 52 |
| `slice15` | 生态·主题·可观测 core：plugin-loader/builtin-registry/plugin-market/mcp/skill/skills(逐个 SKILL.md 顶部描述)/zvec-grep/codegraph/slots/capabilities/theme(3 皮肤)/settings 管理器/i18n/telemetry/cost/event-log/recovery/retry/heartbeat/snapshot/file-api/persona/auth/ui-plugins | 57 | 495 |
| `slice16` | Rust 命令面：lib.rs 的 generate_handler 全清单归类（文件/终端 PTY/MCP/HTTP/认证/窗口/宠物/托盘/微信 ilink/手机 phone/沙箱/下载解压/浏览器等），含 ilink.rs/phone 目录/runtime_log/崩溃标记/毛玻璃 | 19 | 89 |
| `slice03` | 布局导航与工作区：Sidebar/TitleBar/SpaceSwitcher/ProjectManager/HubLayout/TopNavbar/DreamLayout/WorkspaceBackdrop/RightSidebar/PanelSidebar/FileExplorer/Workbench/TerminalPanel/CicdPanel/SearchDialog/SkinSelector 及布局相关其它 | 5 | 116 |
| `slice04` | SettingsPanel 22 大分区 | 1 | 290 |
| `slice01` | 对话主区与消息渲染：ChatPanel.tsx、InputArea.tsx、MessageBubble.tsx、MessageActions/InlineMessageEdit/ReasoningRow/StatsLine/RunStatusBar/TurnStatus/ErrorCard/StreamingWaitIndicator/ToolCallGroup/ToolCallCard/ActivityTimeline/ScrollToBottomIndicator/SelectionTooltip/FileLinkContextMenu/TodoListDisplay/RegenerateModelPopover/ConversationOverview/ConversationRoot/Session/Composer/NewChatPage/GuidanceBlock/FeedbackButtons/JobsBadge/GoalBar/QuickAccessCards/CloseConfirmDialog 及与消息展示/输入相关的其它 .tsx | 9 | 128 |
| `slice02` | 会话增强面板与审批澄清：SideSessionPanel/SnapshotPanel/ContextMonitor/TrajectoryPanel/AgentPanel/AgentDetail/AgentTeamsPanel/NeedsYouPanel/PermissionDialog/ClarificationForm/InteractiveFormDialog/PlanApprovalCard/PlanModeChip/DecisionTray/PipelineNextStepDialog/PromptChangeReviewDialog/CorrectionModeToggle/CorrectionResultPanel/CorrectionModelConfig 及同族其它 | 4 | 120 |
| `slice05` | 独立配置/工具面板：LayeredSettingsPanel/ModelProfilePanel/ModelSelector/MultimodalPanel/OllamaSettingsPanel/VoiceSettingsPanel/ComputerUseSettings/WechatSettings/PhoneLinkSettings/GitEnvSettings/GitHubCloneDialog/GitBranchSelector/GitInfoPanel/PersonaManager/MemoryManager/PerformanceDashboard/UsageStats/UsageVisuals/RecoveryPanel/HeartbeatMonitor/RetryConfigPanel/PromptDebugger/ToolManager/SkillAuditDialog/AgentManager/PermissionPresetSelector 等 | 27 | 184 |
| `slice08` | PPT 全套（PPTAdapter/PPTEditor/SlideCanvas/PropertyPanel/EditorToolbar/PresentationMode 及 ppt-chat/ppt-notes/ppt-image/ppt-math/pptx-importer） | 28 | 130 |
| `slice09` | 文件查看器/富内容/生态市场：FileEditor/DiffViewer/InlineDiffReview/FileChangesList/rich-content 族/pdf/docx/excel/image/video/audio 专项查看器/ShikiCodeBlock；McpManager/McpMarketplace/SkillManager/PluginManager/plugin-market 下全部/zvec/ZvecGrepMarketCard/PetMarketDialog | 27 | 131 |
| `slice06` | 任务中心全部：TaskCenter.tsx 与 task-center/ 下各 Tab（Overview/Delegation/Subagents/Automation/Issues/Board/Team/Squads/Inbox 与 IssueDetail 等） | 19 | 96 |
| `slice07` | 知识笔记本族：NotebookManager/NotebookWorkspace/NoteEditor/NbChatPanel/SourceViewer/SourceReferences/FlashcardViewer/KnowledgeGraphView/DeliverableFiles 等 | 19 | 141 |
| **合计** |  | **362** | **2779** |

## 网站映射（12 个介绍区）

| 网站区 | 覆盖 slice | 主要截图 |
|---|---|---|
| 对话与 Agent 循环 | slice01, slice11, slice02 | chat / trajectory |
| 多模型接入 | slice11, slice05, slice09 | model-selector / providers |
| 技能市场 | slice15, slice09 | skills |
| 插件系统 | slice15, slice09 | plugins |
| MCP 与扩展 | slice09, slice15 | mcp |
| 知识笔记本 | slice07 | notebook / graph |
| 任务与自动化 | slice06, slice13 | task-center / automation |
| 记忆与上下文 | slice12, slice02 | memory / context |
| 智能体与团队 | slice13, slice02 | agents / teams |
| 宠物、皮肤与个性化 | slice10, slice15, slice04 | pet / skins |
| 安全、沙箱与工作树 | slice14 | sandbox / worktree |
| 设置、用量与可观测 | slice04, slice05, slice15 | settings / usage |

> 注：`slice03`（布局导航）、`slice08`（PPT）、`slice16`（Rust 命令面）、`slice17`（大富翁）不单列网站区，分别并入「工作区」「富内容」「安全/设置」「彩蛋」区。

## 逐条目录

### slice12 — 存储/会话/记忆/知识 core

#### 组：本地数据库存储

- 本地一体化 SQLite 数据库
- 数据库损坏自动恢复
- 写盘失败提示与自动重试
- 退出前冲刷落盘
- 重置本地数据

#### 组：设置与杂项数据存储

- 键值设置持久化
- 用量花费明细与统计
- 会话中断恢复数据
- 快速短语模板库
- Prompt 草稿版本管理

#### 组：会话管理

- 会话创建、查询与重命名
- 会话置顶与取消置顶
- 删除会话
- 会话拖拽排序
- 会话运行配置持久化
- 会话分叉（谱系 fork）
- 消息历史完整持久化
- 工具调用与结果记录
- 消息附件持久化与复用
- 消息赞踩反馈
- 编辑消息并重放
- 压缩历史保留可回看
- 历史上下文重建

#### 组：旧版数据迁移

- 旧数据一键迁移

#### 组：会话事件日志（溯源）

- 全程事件流记录
- 事件回放与投影
- 事件日志重放校验
- 旧消息回填事件日志

#### 组：会话检索能力

- 历史消息自动全文索引
- AI 跨会话全文搜索
- 会话内事件搜索
- 会话谱系追踪
- 单事件细读

#### 组：记忆 core

- 记忆 SQLite 持久化
- 三范围记忆管理
- 按范围浏览记忆
- 按标签筛选记忆
- 记忆关键词检索
- 记忆自动注入对话
- 记忆双向链接
- 记忆统计概览
- 记忆清空
- 记忆导出 JSON
- 记忆导出 Markdown
- 记忆导入恢复
- 记忆自动整合
- 记忆整合体检报告

#### 组：知识库——笔记本与来源

- 笔记本管理
- 笔记本分组管理
- 按分组浏览笔记本
- 添加知识来源
- 单来源智能索引
- 笔记本批量增量索引
- 来源重新索引
- 删除来源并清理
- 来源摘要与关键话题
- 笔记本整体摘要生成
- 建议问题生成
- 文本与代码文件提取
- Office 文档提取
- PDF 文本提取
- 网页正文抓取

#### 组：知识库——分块与向量索引

- 智能文本分块
- Token 估算
- 本地离线向量引擎
- 向量模型可选可切换
- 模型加载进度与状态提示

#### 组：知识库——RAG 语义检索

- 语义相似度检索
- 勾选来源限定检索
- 带引用上下文的检索
- 回答引用知识来源可溯源

#### 组：知识库——笔记与双链

- 笔记本内笔记管理
- WikiLinks 双链语法
- 保存时自动同步链接
- 入链/出链与统计
- 链接渲染为可点 Markdown
- 按标题查找笔记
- 笔记版本快照
- 笔记版本回滚

#### 组：知识库——知识图谱

- AI 抽取知识图谱
- 图谱数据浏览
- 图谱手工编辑
- 图谱社区聚类

#### 组：知识库——闪卡复习

- AI 生成闪卡
- 闪卡管理
- 到期复习队列
- SM-2 间隔重复

#### 组：知识库——学习路径与导出导入

- 依赖式学习路径生成
- 笔记本导出 Markdown
- 单笔记导出 Markdown
- 从 Markdown 重建笔记本

#### 组：对话响应缓存

- 响应缓存统计与清空

### slice13 — 协作与自动化 core：subagent/agent-teams/squad/session(跨会话委派 bus/executor)/automation/goal/inbox/issue

#### subagent — 子智能体委派、执行与监控 / 组1：委派与控制工具面（对话内 LLM 工具）

- 后台委派子智能体
- 前台同步委派
- 子智能体类型可选
- 持久档案绑定
- 向后台子智能体续发消息
- 中断后台智能体当前轮
- 列出后台子智能体
- 子智能体向父级汇报
- 完成自动通知
- 汇报/通知注入父消息流
- 输出防注入净化

#### subagent — 子智能体委派、执行与监控 / 组2：执行引擎机制（用户间接感知的行为保障）

- 双生命周期执行
- 空闲自动收尾
- 断线复活续聊
- 实时活动追踪
- 防递归失控上限
- 归属权限校验

#### subagent — 子智能体委派、执行与监控 / 组3：对话内监控 UI（ChatPanel 系）

- 智能体与团队开关按钮
- 悬浮列表与详情切换
- 任务角标直达详情
- 运行统计卡
- 当前团队卡片与跳转
- 团队成员行内展开
- 个体动态活动行
- 子智能体平铺列表
- 列表空态区分提示
- 详情返回与状态徽章
- 实时已用时长
- 活动时间线
- 任务指令原文
- 执行结果四段式
- 失败错误独立高亮
- 基本信息网格
- 后台任务计数角标
- 后台任务下拉列表
- 任务时长实时走动
- 消息内子智能体状态行
- 新旧委派结果兼容识别
- 子智能体操作审批说明

#### subagent — 子智能体委派、执行与监控 / 组4：任务中心「子智能体」Tab（监控）

- 子智能体统计条
- 子智能体任务列表
- 结果摘要行
- 空态引导创建

#### agent-teams — 运行时多智能体团队 / 组1：引擎与服务层（AgentTeamsService + engine）

- 依赖门控领取任务
- 领取签发代次令牌
- 迟到结果拒绝
- 转派与队长接管
- 移除成员自动回收任务
- 邮箱投递租赁
- 空闲成员自动认领
- 团队持久化存储
- 一人一队约束
- 成员即可续聊子智能体
- 消息实时/唤醒/入邮箱三态投递
- 变更订阅驱动 UI

#### agent-teams — 运行时多智能体团队 / 组2：团队工具面（10 个 agent_teams 工具）

- 创建团队并担任队长
- 添加可续聊成员
- 移除团队成员
- 创建依赖任务
- 转派任务
- 认领任务
- 更新任务状态与结果
- 成员间直达消息
- 团队全貌状态
- 删除并归档团队
- 队长专属权限隔离
- 工具 schema 懒加载

#### agent-teams — 运行时多智能体团队 / 组3：团队活动 UI（AgentTeamsPanel / TeamTab 运行时区）

- 无团队引导空态
- 团队信息头
- 成员状态列表
- 任务看板列表
- 未读消息汇总行
- 面板实时自动刷新
- 运行时团队区可折叠
- Teams 使用引导条

#### squad — 团队模板（蓝图）管理 / 组1：模板核心管理

- 团队模板 CRUD
- 模板成员（角色）管理
- 模板导出运行时蓝图
- 自动带队长成员
- 模板按项目持久化

#### squad — 团队模板（蓝图）管理 / 组2：模板工具面（LLM）

- 列出团队模板
- 按模板派发团队任务
- 模板与运行团队状态

#### squad — 团队模板（蓝图）管理 / 组3：模板管理 UI（SquadsTab，嵌入「团队」Tab）

- 新建 Squad
- 列表与展开详情
- 归档 Squad
- 添加成员下拉
- 移除成员
- 模板与运行时同屏对照

#### squad — 团队模板（蓝图）管理 / 组4：Issue×Squad 协同

- Issue 分派给团队
- 分派/完成自动流转

#### session — 跨会话委派（bus / orchestrator / executor） / 组1：委派工具面（LLM）

- 委派任务到另一会话
- 等待委派完成取结果
- 查询他会话最近输出
- 列出可用会话

#### session — 跨会话委派（bus / orchestrator / executor） / 组2：编排与执行保障（App 已全局接线）

- 死锁循环委派拦截
- 委派深度与并发上限
- 禁止自委派
- 重启恢复未完成任务
- 目标会话自动后台执行
- 后台权限请求挂起审批
- 后台执行安全模式跟随
- 无产出异常落库报错
- 会话防重入与取消
- 委派结果事件回传

#### session — 跨会话委派（bus / orchestrator / executor） / 组3：委派监控 UI（任务中心「委派」Tab）

- 委派统计条
- 委派任务列表
- 空态引导委派

#### automation — 自动触发器 / 组1：引擎核心（四类触发器）

- 定时器触发器
- 文件监听触发器
- Cron 定时触发器
- Issue 状态触发器
- 触发冷却防抖
- 触发历史留痕
- 配置持久化与增删改

#### automation — 自动触发器 / 组2：自动化 UI 与运行（任务中心「自动化」Tab，App 启动即接线）

- 添加触发器
- 四类触发器参数配置
- 触发器启停开关
- 编辑既有触发器
- 删除触发器
- 一键停止全部引擎
- 触发历史近览
- cron 语法在线示例
- 命中自动开新会话执行
- 空态引导建触发器

#### goal — 目标跟踪 / 组1：目标工具面与存储（对话内维护）

- 创建执行目标
- 查询/列出目标
- 更新目标状态
- 目标持久化存储

#### issue — 结构化任务追踪 / 组1：核心管理（UI 见任务中心 Issues/看板）

- Issue 生命周期管理
- Issue 评论协作
- 状态统计看板数据

#### issue — 结构化任务追踪 / 组2：Issue 工具面（LLM 对话内操作）

- 创建 Issue
- 更新 Issue
- Issue 评论
- 列出 Issue

#### issue — 结构化任务追踪 / 组3：列表与详情 UI

- 新建 Issue 表单
- 状态筛选条
- Issue 列表与计数
- 点卡片进详情
- 状态与优先级标识
- 卡片元信息行
- 详情返回列表
- Issue 完整信息视图
- 状态一键流转
- 分配给 Squad
- 评论活动时间线
- 发表评论

#### issue — 结构化任务追踪 / 组4：看板视图

- 五列状态看板
- 拖拽改状态

#### inbox — 全局通知聚合 / 组1：通知聚合与操作（核心）

- 通知聚合中心
- 未读计数与过滤
- 已读与归档管理
- 委派完成/失败通知
- Issue 状态变更通知
- 自动化触发通知

#### inbox — 全局通知聚合 / 组2：收件箱 UI（任务中心「收件箱」Tab）

- 未读计数徽章
- 全部标为已读
- 分类筛选
- 通知条目展示
- 点击即已读
- 单条归档

#### 任务中心容器与概览 / 组1：统一任务管理入口

- 任务管理面板（八视图）
- 面板右上角关闭
- 页脚视图与参数提示
- 多渠道一键直达

#### 任务中心容器与概览 / 组2：概览仪表盘（OverviewTab）

- 收件箱未读卡
- Issues 进度卡
- 委派状态卡
- 自动化统计卡
- 最近活动时间线

### slice10 — 宠物/启动/引导/杂项：PetWindowApp/PetSprite/宠物 UI、BootSplash/BootstrapWizard/OnboardingTour/AppErrorBoundary/ToastNotification/Drawer/ui 原语库等其余未归他片的组件（遍历补漏）

#### 桌面宠物系统（独立窗口 / 精灵 / 市场 / 运行时联动 / 设置） / 组1：独立宠物窗口 PetWindowApp（前端窗口组件 + Rust 宠物窗命令）

- 透明悬浮桌宠窗口
- 按住拖拽移动宠物
- 右键切换窗口置顶 / 一键复位位置
- 右键即时切换宠物样式
- 右键查看剩余 Token
- 右键关闭宠物
- 悬停状态文字气泡
- Agent 事件气泡自适应展开
- 大肥鱼式任务状态卡
- 休眠状态视觉变暗

#### 桌面宠物系统（独立窗口 / 精灵 / 市场 / 运行时联动 / 设置） / 组2：精灵渲染 PetSprite

- 状态驱动的帧动画精灵渲染

#### 桌面宠物系统（独立窗口 / 精灵 / 市场 / 运行时联动 / 设置） / 组3：宠物市场 PetMarketDialog

- 浏览在线宠物市场目录
- 市场关键词搜索
- 安装前动态预览动画
- 一键安装并自动启用
- 一键卸载宠物
- 安装状态角标与计数
- 加载失败重试与空态引导

#### 桌面宠物系统（独立窗口 / 精灵 / 市场 / 运行时联动 / 设置） / 组4：宠物运行时 Agent 事件联动（pet-store / 服务层）

- Agent 状态实时映射动画
- 工具执行中文气泡
- 任务出错与工具失败气泡
- 气泡去重、排队与优先级
- 空闲自动休眠
- 气泡自动带上用户称呼
- 任务完成庆祝与文件变更摘要
- 压缩/引导/步骤等进程播报
- 任务状态卡实时更新
- 重启自动恢复桌宠

#### 桌面宠物系统（独立窗口 / 精灵 / 市场 / 运行时联动 / 设置） / 组5：宠物设置（设置面板「宠物」区块，入口为设置侧栏"宠物"项）

- 启用/停用桌宠开关
- 宠物大小滑块（15%~150%）
- 宠物透明度滑块（30%~100%）
- 已装宠物列表管理（激活/卸载/当前标记）
- 设置内直达宠物市场

#### 启动加载与首次引导（BootSplash / BootstrapWizard / OnboardingTour） / 组1：启动加载屏 BootSplash

- 启动加载屏动画
- 实时进度与自动过渡

#### 启动加载与首次引导（BootSplash / BootstrapWizard / OnboardingTour） / 组2：首次身份配置向导 BootstrapWizard

- 首次使用自动弹出身份向导
- 欢迎说明页
- 为 AI 起名字
- 定义 AI 本质
- 选择说话风格
- 选择标志 emoji
- 填写你的信息
- 完成页一键保存并开始
- 步骤点进度与返回导航

#### 启动加载与首次引导（BootSplash / BootstrapWizard / OnboardingTour） / 组3：新手引导 OnboardingTour

- 高亮浮窗新手引导
- 引导导航与进度计数
- 气泡自动贴合与防越界
- 帮助菜单可随时重放引导

#### 全局崩溃恢复 / 通知 / 通用对话框杂项 / 组1：顶层渲染崩溃恢复 AppErrorBoundary

- 渲染崩溃恢复卡片
- 一键重试渲染
- 重新加载应用
- 重置界面设置并重新加载
- 崩溃证据自动留存提示

#### 全局崩溃恢复 / 通知 / 通用对话框杂项 / 组2：全局 Toast 通知 ToastNotification


#### 全局崩溃恢复 / 通知 / 通用对话框杂项 / 组3：通用对话框 / 杂项组件（遍历补漏）

- 危险操作确认对话框
- 关闭窗口二选一（托盘/退出）
- macOS 风动态毛玻璃背景

#### ui 原语库（src/components/ui/*，供全应用 UI 复用） / 组1：对话框类原语

- 标准对话框原语
- 警示对话框原语
- 下拉菜单原语
- 弹出浮层原语
- 工具提示原语
- 玻璃拟态套件别名

#### ui 原语库（src/components/ui/*，供全应用 UI 复用） / 组2：展示与输入类原语

- 开关原语
- 进度条原语
- 徽章原语
- 卡片容器原语

### slice11 — 引擎能力层：agentic-loop/streaming/compaction/prompt 构建/context 预算/vision-proxy/multimodal/model-profile/model-resolver/provider 多厂商/capability-detector/run-status/transcript-cache/idle-tracker 等（不含 tools/ 单独片）

#### Agentic Loop 自主执行引擎（src/core/llm/agentic-loop.ts 等） / 组1：主循环与终止安全

- 多轮自主执行直至任务自然完成
- 无进展自动停机（30 轮防死循环）
- 连续错误熔断（3 次自动停止）
- LLM 流失败自动重试（3 次指数退避）
- 空响应自愈重试
- 上下文爆满兜底提示开新对话
- 文件覆盖被拒即停止
- 关键服务不可用即时报错引导
- 功能缺失降级提示
- 成本自动降级与硬停（E8）
- 多会话并行引擎池与会话级取消
- 会话中途换模型即时同步全部会话

#### Agentic Loop 自主执行引擎（src/core/llm/agentic-loop.ts 等） / 组2：任务计划与步骤进度

- 执行型任务自动生成语义计划
- "第 X/X 步"实时进度与标题
- 计划动态插入（update_plan）

#### Agentic Loop 自主执行引擎（src/core/llm/agentic-loop.ts 等） / 组3：运行中的人机干预

- 运行中发送转向消息（guidance）
- "立即生效"插队干预
- AI 主动暂停提问（needs-you）
- agent 间异步消息回合边界并入

#### Agentic Loop 自主执行引擎（src/core/llm/agentic-loop.ts 等） / 组4：工具流护栏与去重（引擎侧行为）

- 每回合只执行首个写类工具
- 同回合重复读取/等待自动去重
- 重复写同内容自动跳过
- bash 后读缓存自动失效
- 重复工具调用循环提醒
- 工具参数敏感信息扫描告警
- 工具执行 60 秒超时兜底

#### Agentic Loop 自主执行引擎（src/core/llm/agentic-loop.ts 等） / 组5：变更安全与追踪

- 破坏性工具前自动快照
- 每轮文件变更追踪

#### 流式执行器与工具结果预算（src/core/llm/streaming-executor.ts 等） / 组1：并发与顺序

- 只读工具并行执行提速
- 并行结果按模型顺序提交

#### 流式执行器与工具结果预算（src/core/llm/streaming-executor.ts 等） / 组2：结果预算护栏

- 超大工具结果自动落盘（50KB）
- 每回合工具结果总量预算（200KB）
- 长错误信息智能截头尾
- 纯文本输出溢出存储（32KB spill）

#### 上下文预算、压缩与提示缓存（src/core/context/context.ts + agentic-loop 等） / 组1：预算与压力感知

- Token 预算核算（窗口−系统提示−输出预留）
- 上下文压力四级分级（0–3）
- 按模型真实窗口核算（1M 窗口不早压缩）
- CJK 感知估算 + 实际 usage 校准
- 上下文状态面板（用量条/压力/费用）
- 压力高时界面预警

#### 上下文预算、压缩与提示缓存（src/core/context/context.ts + agentic-loop 等） / 组2：压缩执行链

- LLM 结构化摘要压缩（级联）
- API-Round 安全边界压缩
- 微压缩先行（head/tail 剪除）
- 超限报错即时反应式压缩
- 压缩锁与连续压缩上限
- 崩溃遗留工具调用自修复
- 压缩后缓存清理与记忆提取联动
- 手动压缩按钮
- 压缩阈值可调（50–95% 滑块）
- 压缩参数全套可配
- 优先级上下文选择
- 上下文折叠零成本提示
- 陈旧大工具结果预剪（保留最近 2 条完整）

#### 上下文预算、压缩与提示缓存（src/core/context/context.ts + agentic-loop 等） / 组3：提示缓存与转发优化

- 增量消息构建缓存（E3）
- 易变字段后置稳定前缀
- Anthropic 分层缓存断点

#### Prompt 构建（src/core/prompt + llm 提示注入） / 组1：系统提示组装

- 双语系统提示分节组装
- 语言强制规则注入
- 四级分层项目指令（AGENTS.md 家族）
- 项目指令缓存
- 用户画像注入
- Git 偏好规则注入
- 环境脚本规则注入
- 工具使用指南动态收集
- 附件规则提示（内联预览策略）
- 人设卡注入
- 把 token 预算告知模型
- system-reminder 注入串过滤

#### Prompt 构建（src/core/prompt + llm 提示注入） / 组2：每轮运行时注入

- 时间上下文每轮注入
- Surface 可见性通知
- 工具表按场景裁剪
- 延迟工具提示段（tool_search 加载）
- DeepSeek 中文推理强制提示

#### Prompt 构建（src/core/prompt + llm 提示注入） / 组3：子智能体提示与输出解析

- 子智能体最小系统提示（防注入）
- 容错 JSON/列表/Mermaid 解析

#### Provider 多厂商与模型路由（src/core/llm/provider.ts / model-profile.ts / capability-detector.ts） / 组1：多厂商与连接

- 内置六家云端 + Ollama 本地
- MiMo 免 Key 可用
- 自定义 OpenAI 兼容厂商添加
- 模型列表一键刷新（/models）
- 动态模型窗口自动推断补全
- API 协议可切换
- Ollama 本地模型面板
- 无可用厂商时明确指引
- 流式连接 60 秒超时、非流式 120 秒
- API 错误体密钥脱敏

#### Provider 多厂商与模型路由（src/core/llm/provider.ts / model-profile.ts / capability-detector.ts） / 组2：模型档案（Profile）与任务路由

- 场景模板档案（4 内置 + 自建）
- 任务槽位分模型路由
- 槽位回退链
- 切换档案全链路即时生效
- 统一模型解析助手

#### Provider 多厂商与模型路由（src/core/llm/provider.ts / model-profile.ts / capability-detector.ts） / 组3：能力检测与推理强度

- 模型能力库本地检测
- 功能入口能力门禁与中英警告
- 推理强度低/中/高/超高可选

#### 多模态与视觉代理（vision-proxy / multimodal / attachment） / 组1：视觉代理

- 视觉代理自动转译图片
- 图片可直传不走代理
- 语音转文字代理（Whisper）
- 未配置视觉代理不静默丢图
- 强制视觉模型看图能力

#### 多模态与视觉代理（vision-proxy / multimodal / attachment） / 组2：多模态 API 能力

- 多模态设置面板
- Embedding 默认本地免配置
- 嵌入三路由（本地/Gemini/OpenAI 兼容）
- 语义搜索与相似度排序
- 输入区"生成图片"入口
- 输入区"语音合成"入口
- 消息朗读（云端 TTS，失败回落浏览器语音）

#### 多模态与视觉代理（vision-proxy / multimodal / attachment） / 组3：附件上下文通道

- 附件内联预览共享预算
- 附件内容防注入隔离包装
- 文本附件同步工作区供 read/grep
- 图片上传视觉通道提示

#### 运行状态、空闲保活与用量统计诊断 / 组1：运行状态条

- 运行阶段状态条
- 运行时长人性化显示

#### 运行状态、空闲保活与用量统计诊断 / 组2：用量与费用

- 消息级 token 统计行（含诚实缓存命中率）
- 用量统计面板（近 7 天）
- 每次调用成本精算与持久化
- 成本上限与降级联动
- DeepSeek 余额实时查询

#### 运行状态、空闲保活与用量统计诊断 / 组3：流式空闲保活与连接状态

- 自适应空闲保活（120 秒无数据判定）
- SSE 心跳注释续命
- 连接→流式→执行 实时状态上抛
- 断线/超时错误即时文本可见

#### 运行状态、空闲保活与用量统计诊断 / 组4：诊断、缓存与反馈

- 关键错误自动生成复盘报告
- Transcript 缓存统计与清空
- /feedback 命令记录会话反馈

#### LLM 引擎编排层（src/core/llm/index.ts） / 组1：引擎级服务与配置

- 统一引擎单例 + 服务自动装配
- 引擎级模型/厂商默认值配置
- fork 子对话复用父前缀（省钱）

### slice14 — 连接·工程·安全 core：phone-link/wechat-bridge/computer-use/browser(playwright)/environment(worktree 自动提交变更追踪)/cicd/project/config(层级)/permission(安全模式 bash-analyzer)/sandbox(sandbox-acl)/auth

#### 手机连接（Phone Link · LAN 扫码配对） / 组1：桌面设置卡 · 服务与配对

- 服务状态徽标（监听中/未启动）
- 服务地址与已配对设备数信息行
- 「开始配对（启动 LAN 服务）」按钮
- 「停止服务」按钮
- 「刷新配对二维码」按钮
- 配对二维码视图（5 分钟有效）
- 「复制配对链接」按钮
- 等待配对倒计时提示
- 「批准」配对按钮
- 「拒绝」配对按钮
- 配对完成提示视图
- 已配对设备列表
- 设备「解除」按钮
- autoStart 开关

#### 手机连接（Phone Link · LAN 扫码配对） / 组2：手机端配对状态机（pair.html）

- 等待桌面确认视图（轮询）
- 配对成功自动进入视图
- 配对被拒绝视图
- 配对链接过期视图
- 无效配对链接视图
- 网络异常自动重试视图

#### 手机连接（Phone Link · LAN 扫码配对） / 组3：手机端会话浏览与续聊（app.html）

- 会话列表视图
- 会话列表自动刷新
- 顶部「刷新」按钮
- 顶部「← 返回」按钮
- 会话消息线程视图
- 会话页自动轮询新回复
- 输入框 +「发送」按钮（续聊桌面会话）
- 未配对落地页（去配对）

#### 微信 ClawBot（iLink 桥） / 组1：桌面设置卡 · 连接与登录状态机

- 连接状态徽标（六态）
- 已连接信息行
- 最近错误提示行
- 「扫码登录微信」按钮
- 登录二维码视图
- 「刷新二维码」按钮
- 「复制绑定链接」按钮
- 等待扫码状态提示（已扫码待确认/二维码已就绪）
- 配对码输入与「提交」按钮
- 配对码错误提示
- 「断开」按钮
- 「重新扫码（换 24h token）」按钮
- 会话过期态视图
- 启动自动恢复已绑定会话
- 会话 23h 到期自动失效并提示重扫

#### 微信 ClawBot（iLink 桥） / 组2：桌面设置卡 · 配置与主开关

- 「启用微信桥」总开关
- 默认模型输入框
- 默认工作区目录输入框

#### 微信 ClawBot（iLink 桥） / 组3：准入与白名单管理

- Bot 主人自动放行
- 待批准队列视图
- 陌生人「批准」按钮
- 陌生人「拉黑」按钮
- 白名单列表
- 白名单「移除」按钮
- 黑名单列表
- 黑名单「解除」按钮
- 手动添加白名单 peer
- 陌生账号自动引导回复
- 黑名单消息静默忽略

#### 微信 ClawBot（iLink 桥） / 组4：微信端斜杠命令与对话

- /help 命令
- /status 命令
- /clear 命令
- /new <模型> 命令
- /model <名> 命令
- /attach <目录> 命令
- /reconnect 命令
- /allow 命令
- /ignore 命令
- 主人专属命令权限守卫
- 普通文本自由对话

#### 电脑操作（computer-use） / 组1：设置与运行模式（Windows 限定）

- 运行模式·禁用（disabled）
- 运行模式·只读（readonly）
- 运行模式·手动批准（manual，默认）
- 运行模式·自动（auto）
- 「AI 可自行修改运行模式」开关
- 截图输出目录输入框
- 截图默认缩放滑杆

#### 电脑操作（computer-use） / 组2：会话级批准与门禁提示（Windows 限定）

- /computer 会话批准命令
- 未批准键鼠调用的拒绝提示（awaitingApproval）
- 批准/撤销的系统反馈消息

#### 电脑操作（computer-use） / 组3：agent 工具能力（computer_* 读屏与键鼠，Windows 限定）

- computer_screenshot 整屏截屏工具
- computer_see 视觉读屏工具
- computer_click 鼠标点击工具
- computer_type 文本输入工具
- computer_keypress 组合键工具
- computer_scroll 滚轮工具
- computer_drag 拖拽工具
- computer_move_mouse 光标移动工具
- computer_wait 等待工具
- computer_get_cursor_position 光标读取工具
- computer_set_mode 模式切换工具

#### 浏览器自动化（Playwright） / 组1：工具与接线

- browser_automate 工具注册（按需加载）
- 首次调用自动拉起 Playwright MCP
- 多动作序列一次执行
- CSS 与 Playwright 定位器选择器

#### 浏览器自动化（Playwright） / 组2：动作集（browser_automate 支持的动作）

- navigate 打开网页
- screenshot 页面截图
- click 点击元素
- fill 填入文本
- get_text 提取文本
- evaluate 执行 JS
- wait 等待元素
- hover 悬停元素
- select 选择下拉选项

#### 环境与工作树（environment · 自动提交变更追踪） / 组1：环境与 Git 设置卡

- 自动提交开关（🔄 自动 Commit）
- 分支前缀输入
- PR 合并方法选择
- 允许强制推送开关
- 默认草稿 PR 开关
- GitHub Token（密码输入）
- 提交信息风格指令
- PR 标题风格指令
- PR 描述风格指令
- 设置脚本输入（打开项目时自动执行）
- 清理脚本输入（切换/关闭项目时执行）
- 自定义操作管理（添加/编辑图标、名称、命令/删除）
- 一键运行自定义操作并展示结果

#### 环境与工作树（environment · 自动提交变更追踪） / 组2：工作树管理

- 最大工作树数量设置
- 自动清理最旧工作树开关
- 清理前检查未提交修改开关
- 扫描项目已有工作树
- 工作树脏/干净状态展示
- 删除某个工作树（脏数据二次确认）
- 执行模式切换按钮（本地处理 ↔ 新工作树）
- 执行模式按项目记忆
- 会话首条消息自动创建工作树
- 分叉会话自动创建独立工作树
- 删除会话自动清理其工作树
- 会话列表工作树标识
- Git 信息面板跟随会话工作树

#### 环境与工作树（environment · 自动提交变更追踪） / 组3：文件变更追踪

- 回合文件变更清单视图
- 逐文件差异查看
- 回滚单回合变更
- 回合尾交付文件 chips
- 文件浏览器 Git 徽标与变更自动刷新
- 工作台活动时间线记录每轮变更

#### 环境与工作树（environment · 自动提交变更追踪） / 组4：自动提交

- 回合结束自动提交接线
- 提交信息自动生成
- 自动提交后 Git 信息面板即时刷新

#### CICD 流水线（GitHub Actions） / 组1：仓库加载与刷新

- 仓库地址输入与加载
- 未配置 Token/API 错误提示
- 自动刷新开关
- 手动刷新

#### CICD 流水线（GitHub Actions） / 组2：运行监控与操作

- CI/CD 状态概览卡
- 最近运行列表视图
- 展开查看 Job 与步骤
- 跳转 GitHub 查看运行
- 重试失败运行
- 取消进行中运行
- 操作结果即时反馈

#### CICD 流水线（GitHub Actions） / 组3：Workflow 生成器

- 生成 Workflow 展开区
- 项目类型模板切换
- YAML 预览与目标路径提示
- 复制 YAML
- 保存 Workflow 到文件

#### 工程与项目文件（project） / 组1：项目列表与基本操作

- 项目列表视图
- 打开项目
- 删除项目（二次确认）
- 文件夹选择器（选后自动补全项目名）

#### 工程与项目文件（project） / 组2：新建 / 导入 / 克隆

- 新建项目
- 新建项目默认生成工程文件
- 导入已有文件夹
- 从 GitHub 拉取（向导内克隆）
- 快捷克隆 GitHub 项目对话框

#### 工程与项目文件（project） / 组3：新建 Git 项目（建仓+推送向导）

- 新建 Git 项目向导
- 向导内 GitHub Token 输入
- 仓库可见性选择
- 建仓进度与结果反馈

#### 工程与项目文件（project） / 组4：项目指令 / 技能 / 记忆装载

- 项目指令装载
- 项目技能装载
- 项目记忆装载
- 分层项目指令装载（agent 生效）
- /generate-agents 一键生成 AGENTS.md 命令

#### 分层配置（config · 层级） / 组1：分层配置编辑器（全局 .codem-app / 项目 .codem / 子目录 .codem-sub）

- 分层配置管理弹窗入口
- 配置层级切换（全局/项目/子目录）
- 层级结构与文件存在性总览
- 一键初始化配置目录
- 文本型配置页签编辑与保存（AGENTS/SOUL/TOOLS/HEARTBEAT）
- IDENTITY 表单编辑与保存
- USER 表单编辑与保存

#### 分层配置（config · 层级） / 组2：分层设置管理（高级 → 分层设置管理）

- 设置来源优先级链视图
- 单层来源详情视图
- 策略限制面板（绕过权限/屏蔽模型/屏蔽供应商）
- 「导出所有设置」与 JSON 预览
- 「复制到剪贴板」

#### 权限与安全模式（permission · security-mode + bash-analyzer） / 组1：安全模式档位切换与生效

- 安全策略三档选择（请求批准/替我审批/完全访问）
- 项目级安全模式（覆盖全局）
- 输入栏安全策略快捷选择器
- 「请求批准」档行为
- 写入覆盖的内嵌 Diff 审批面板
- 「替我审批」档行为
- 「完全访问」档行为

#### 权限与安全模式（permission · security-mode + bash-analyzer） / 组2：工具权限弹窗与规则

- 工具权限确认弹窗（风险等级+拒绝/允许）
- 「始终允许」本会话记住放行决定
- 自定义权限规则列表与删除
- 新增权限规则（工具名*通配/资源匹配/动作）
- 规则快速添加模板
- 内置保护规则始终生效

#### 权限与安全模式（permission · security-mode + bash-analyzer） / 组3：bash 危险命令深度分析（bash-analyzer）

- 危险 bash 命令深层检测并升级为询问
- PowerShell 命令智能识别放行

#### 沙箱（sandbox · sandbox-acl） / 组1：沙箱模式与 ACL 策略

- 沙箱模式总开关
- 默认沙箱 ACL 策略
- 严格沙箱策略
- 密钥环境变量过滤清单

#### 账号认证（auth · 小米 MiMo） / 组1：登录入口

- 「登录小米账号」按钮（CLI 模式 MiMo 账号区）
- 登录进行中「正在打开浏览器…」禁用态
- 登录失败红字错误提示

#### 账号认证（auth · 小米 MiMo） / 组2：账号状态与退出

- 「已登录」状态徽标
- 「登出」按钮
- CLI 模式未登录发送拦截提示

#### 账号认证（auth · 小米 MiMo） / 组3：凭据与自检

- 本地凭据自动读取并恢复登录
- CLI 对话自动注入账号密钥
- 「运行登录测试」自检按钮与结果面板

### slice17 — 大富翁游戏全部玩法（引擎/系统/数据/UI/存档）

#### 开局与对局配置（开始界面 + 角色选择） / （未分组）

- 地图选择
- 游戏天数选择（15/30/50/100天）
- 初始资金选择（¥1万/1.5万/2万/3万）
- 人类玩家数（热座模式 1-4人）
- AI 数量选择（1-3个）
- 胜利条件选择（对手全破产/仅比天数/2x/3x/5x/10x资金）
- AI 难度选择（简单/普通/困难）
- 选择角色入口按钮
- 开始界面读档入口
- 开始界面游戏规则入口
- AI 随机选用角色并生成命名
- 六名角色选择网格
- 角色差异化初始资金
- SVG 角色立绘头像
- 角色卡显示天赋说明与初始资金
- 确认/返回按钮

#### 棋盘渲染与对战视听（Phaser 场景层） / （未分组）

- 2.5D 等距棋盘与道路渲染
- 地块信息弹窗（点击查看）
- 到达地块高亮 + 无主地块金币浮动提示
- 建筑精灵分层展示与等级徽章
- 所有者色条标识
- 连锁店彩色旗标
- 角色逐格行走动画
- 骑乘图标跟随（机车/汽车）
- 状态表情头像（破产/沉睡/乌龟/停留/财神/穷神）
- 右键拖拽平移 + 滚轮缩放地图（0.4-1.8x）
- 小地图缩略图与点击跳转
- 昼夜色调随回合进度渐变
- 命运/新闻事件弹窗播报
- 卡牌翻牌动画
- 购地/升级确认弹窗
- 路口选方向弹窗（人类玩家）
- 过路费收支飞字
- 升级/破产粒子特效
- 地块状态变色呈现（查封/涨价）
- 骰子居中滚动动画
- 点数大号飞字
- 回合切换玩家名遮罩
- 顶部消息栏与回合/物价角标
- 游戏音效库（9 种）
- 循环 BGM（首次点击后播放）

#### 回合玩法与地产经营（引擎规则） / （未分组）

- 按交通方式掷 1/2/3 颗骰子
- 逐格移动并结算经过型事件
- 经过/到达起点领薪水 2000
- 分岔路口人工/智能选向
- 乌龟状态移动步数减半
- 梦游随机步数随机方向
- 到达空地购买地产
- 到达自有地产升级建筑
- 他人地产按档收过路费
- 连锁店过路费翻倍与同主加成
- 查封/涨价令临时状态
- 主动出售地产变现
- 破产自动清算资产
- 与指定玩家结盟免过路费
- 银行存取贷还（到银行格）
- 商店购物（到商店格）
- 医院收治 3 天
- 入狱服刑 3 天（可免罪豁免）
- 公园休息随机小奖
- 魔法屋随机效果（12 种）
- 酒店强制摇号住宿
- 加油站机动缴费
- 新闻格触发全局新闻 +40% 概率得卡
- 命运格触发命运事件 +60% 概率得卡
- 机场付费传送至任意地块
- 商业地块·建筑公司购买/收费
- 商业地块·保险公司投保
- 观光地标提示
- 机车/汽车交通方式切换
- 交通事故与罚款
- 保险期内免于事故损失
- 加不起油自动改步行
- 小财神/大财神附身增益
- 小穷神/大穷神附身减损
- 状态天数统一计时系统
- 受限状态自动跳过行动
- 回合轮转与天数推进
- 物价指数动态更新并全局联动
- 银行存款利息 5%/贷款利息 10% 自动结算
- 持股票每回合自动分红（10%）
- 银行随机审查禁贷
- 定时炸弹 3 回合爆炸
- 每 3 回合随机全局突发事件
- 多模式胜负判定
- 游戏结束总资产排名结算
- 主动投降（确认后出局）

#### 卡牌·道具·商店 / （未分组）

- 卡牌持有面板（图标+说明+上限4张）
- 增益/财富类卡牌即时生效
- 遥控骰子预言点数
- 对指定玩家使用的干扰卡（选目标）
- 使用结果即时消息反馈
- 道具持有面板（图标+数量×N）
- 交通道具切换出行方式
- 时光机回到上一位置
- 工程车当前格免费建造/免费购地
- 机器工人全场自动升级
- 遥控骰子指定点数
- 免罪符/保险证即时生效
- 研究图纸随机研发道具
- 商店购买页（卡牌+道具，库存/价格展示）
- 商店出售页（卡牌/道具折换点券）
- 商店库存上限与每回合补货
- 商店价格随物价指数浮动

#### 股票系统 / （未分组）

- 股票面板（8 只股票行情）
- 每回合股价自动波动
- 近 20 次价格迷你走势图
- 买10/卖10 快速交易（1% 手续费）
- 持仓股数与均价展示
- 股票自动分红
- 利好利空股价冲击事件

#### 情报与状态视图 / （未分组）

- 玩家信息卡（现金/存款/贷款/总资产）
- 玩家资产明细行
- 回合指示与人类/AI 标识
- 状态徽章（天数额）
- 滚动日志（最新置顶，颜色区分）
- 回合进度头（N/总天数）
- 物价指数与胜利条件常驻显示
- 彩色消息条
- 资产面板总资产概览
- 地产清单明细（等级/买价/过路费/现值）
- 股票持仓盈亏明细
- 卡牌与道具持有汇总
- 游戏规则帮助面板

#### 存档、设置与结算 / （未分组）

- 三个本地存档槽位
- 保存/覆盖（自动命名）
- 读取存档（含详情预览）
- 删除存档
- 完整对局状态恢复
- 开始界面直接读档开局
- 本地存储风险提示
- 音量滑块控件
- 游戏速度倍速选择（1x/2x/4x）
- 游戏结束排名面板
- 返回主菜单按钮
- 场景内终局文字播报
- AI 对手全自动回合执行
- AI 价值评估决策（难度可调）
- AI 路口智能选向
- 游戏显隐控制 Hook
- 插件公共导出

### slice18 — LLM 工具全集（tools.ts + tools/*.ts 每个工具的 id/guidance/description，逐个列叶子）

#### 核心文件与命令工具（src/core/llm/tools.ts 内建） / 组1：文件读写与编辑

- read（读取文件，长文件分页）
- write（新建/整体覆写文件）
- write 覆盖前的人工确认（diff 拦截）
- edit（精确字符串替换）
- multi_edit（一次多处编辑）

#### 核心文件与命令工具（src/core/llm/tools.ts 内建） / 组2：文件与内容检索

- glob（按文件名模式找文件）
- grep（按正则搜文件内容）

#### 核心文件与命令工具（src/core/llm/tools.ts 内建） / 组3：命令执行

- bash（执行 shell 命令）

#### 核心文件与命令工具（src/core/llm/tools.ts 内建） / 组4：代码执行

- run_code（运行 TS/JS 脚本）

#### 代码理解、语义检索与技能加载（defer/MCP 工具） / 组1：精确代码导航（defer 工具）

- lsp（5 种代码导航操作）

#### 代码理解、语义检索与技能加载（defer/MCP 工具） / 组2：按需加载工具目录

- tool_search（加载延迟工具 schema）

#### 代码理解、语义检索与技能加载（defer/MCP 工具） / 组3：代码图谱查询（codegraph MCP，defer）

- codegraph 代码关系图查询

#### 代码理解、语义检索与技能加载（defer/MCP 工具） / 组4：本地语义检索（zvec-grep MCP）

- zvec-grep 语义检索

#### 代码理解、语义检索与技能加载（defer/MCP 工具） / 组5：技能加载

- load_skill（按需激活技能）

#### 对话内任务协作（计划 / 澄清 / 目标 / 子智能体） / 组1：任务清单

- show_todo（展示可勾选任务清单）

#### 对话内任务协作（计划 / 澄清 / 目标 / 子智能体） / 组2：执行计划动态调整

- update_plan（执行中插入步骤）

#### 对话内任务协作（计划 / 澄清 / 目标 / 子智能体） / 组3：澄清提问

- ask_clarification（结构化提问表单）

#### 对话内任务协作（计划 / 澄清 / 目标 / 子智能体） / 组4：长期目标管理（自动续跑）

- create_goal（创建目标）
- get_goal（查看目标进度）
- update_goal（更新目标状态）

#### 对话内任务协作（计划 / 澄清 / 目标 / 子智能体） / 组5：规划审批

- exit_plan_mode（方案提交审批）

#### 对话内任务协作（计划 / 澄清 / 目标 / 子智能体） / 组6：子智能体委派

- subagent（后台委派子智能体）

#### 对话内任务协作（计划 / 澄清 / 目标 / 子智能体） / 组7：子智能体通信与控制

- send_message（给子智能体续派任务）
- interrupt_agent（中断子智能体）
- list_agents（查看后台子智能体）

#### 对话内任务协作（计划 / 澄清 / 目标 / 子智能体） / 组8：子智能体汇报

- report（子智能体回传结论）

#### 联网与外部服务集成（defer 大工具） / 组1：网页搜索

- web_search（联网检索资讯）

#### 联网与外部服务集成（defer 大工具） / 组2：浏览器自动化

- browser_automate（无头浏览器操控）

#### 联网与外部服务集成（defer 大工具） / 组3：Figma 设计稿拉取

- figma_fetch（读取 Figma 设计数据）

#### 联网与外部服务集成（defer 大工具） / 组4：GitHub 集成

- github_tool（PR/代码/Issue/漏洞扫描）

#### 知识库笔记本能力（NotebookLM 对标，笔记本对话模式） / 组1：AI 笔记管理

- create_note（创建笔记）
- edit_note（编辑笔记）
- link_notes（笔记互链）
- delete_note（删除笔记）

#### 知识库笔记本能力（NotebookLM 对标，笔记本对话模式） / 组2：笔记本语义检索

- search_notebook（知识库检索带引用）

#### 知识库笔记本能力（NotebookLM 对标，笔记本对话模式） / 组3：知识库生成 PPT

- generate_ppt（从知识源生成演示文稿）

#### 会话历史追溯与附件读取 / 组1：历史全文搜索

- session_search（跨会话全文检索）

#### 会话历史追溯与附件读取 / 组2：会话事件级回溯

- session_event_search（事件内容检索）
- session_trace（会话完整脉络）
- session_event_read（读单条事件详情）

#### 会话历史追溯与附件读取 / 组3：附件内容读取

- read_attachment（读取上传附件全文）

#### 多模态创作（defer，需设置启用） / 组1：语音合成

- tts（文字转语音播放）

#### 多模态创作（defer，需设置启用） / 组2：图像生成

- image_gen（按描述生成图片）

#### 后台任务与常驻终端（与 UI 终端面板共享同一 PTY 后端） / 组1：后台任务管理

- job_list（列出后台任务）
- job_output（读取后台任务输出）
- job_kill（终止后台任务）

#### 后台任务与常驻终端（与 UI 终端面板共享同一 PTY 后端） / 组2：常驻终端会话（六件套）

- terminal_open（开启常驻终端）
- terminal_send（向终端发送输入）
- terminal_read（翻看终端回滚输出）
- terminal_signal（发送中断信号）
- terminal_close（关闭终端会话）
- terminal_list（列出活跃终端）

### slice15 — 生态·主题·可观测 core：plugin-loader/builtin-registry/plugin-market/mcp/skill/skills(逐个 SKILL.md 顶部描述)/zvec-grep/codegraph/slots/capabilities/theme(3 皮肤)/settings 管理器/i18n/telemetry/cost/event-log/recovery/retry/heartbeat/snapshot/file-api/persona/auth/ui-plugins

#### 插件生态（plugin-loader / builtin-registry / plugin-market） / 组1：插件管理入口（App / Sidebar 接线）

- 侧边栏「插件管理」按钮
- 入口随插件禁用联动隐藏
- 插件管理弹窗经槽位渲染并内建兜底
- 插件开关状态跨窗口即时同步

#### 插件生态（plugin-loader / builtin-registry / plugin-market） / 组2：PluginManager 弹窗·已安装页（列表与开关）

- 插件总数与启用数统计徽章
- 「已安装 / 插件市场」双页签切换
- 服务未就绪时静态清单先渲染并自动重试
- 插件关键词搜索
- 分类过滤按钮（全部/核心/Provider/界面/兼容/工具，带计数）
- 插件卡片网格（图标/名称/版本/描述/状态点）
- 核心插件「核心」锁定徽章并禁用开关
- 类型标签与风险等级徽章
- 依赖摘要行（依赖数/被依赖数/关闭影响警示）
- 展开依赖详情（依赖/被依赖/提供与消费的服务）
- 风险等级说明详情块
- UI 影响声明面板
- 单个插件开关（启用/禁用）
- 启用时自动连带启用缺失依赖
- 热重载（重启）按钮
- 加载中保护与连点拦截
- 启用失败错误展示与一键重试
- 空结果与加载占位提示
- 核心锁定说明提示条
- Toast 结果提示（3 秒自动消失）

#### 插件生态（plugin-loader / builtin-registry / plugin-market） / 组3：PluginManager 弹窗·级联关闭确认对话框

- 级联关闭确认框标题与目标提示
- 风险等级警示区
- 级联关闭名单逐条附原因（含 UI 影响）
- 确认全部关闭 / 取消按钮
- 级联关闭结果数量提示

#### 插件生态（plugin-loader / builtin-registry / plugin-market） / 组4：插件市场 Tab（dsh 目录浏览与安装等价）

- dsh 市场关键词搜索
- 市场分类筛选（能力/工具/界面/基础设施，带计数）
- 兼容性评估说明条
- 市场目录卡片（包名/描述/分类/兼容状态徽章）
- 内置等价插件启用状态标注
- 「安装并启用」一键等效安装
- 「禁用」即卸载等价安装
- 核心内置插件不可卸载的禁用态按钮
- 初始化中/待适配/不可安装状态如实标注
- 在线检索 npm dsh 生态包
- 在线检索结果统一标注需移植
- 空结果与检索失败提示

#### 插件生态（plugin-loader / builtin-registry / plugin-market） / 组5：DSH 市场目录（dsh-market-catalog 数据）

- 目录总量与构成说明
- dsh-llm 条目（LLM 服务定义/调用）
- dsh-fs 条目（文件系统）
- dsh-shell 条目（命令执行）
- dsh-tool-bash 条目（bash 持久会话）
- dsh-session 条目（会话存储/事件溯源）
- dsh-tools / dsh-compaction / dsh-tool-result-pruner 条目
- dsh-agent-instructions / dsh-time-context / dsh-credentials 条目
- dsh-llm-deepseek / dsh-llm-retry / dsh-token-meter 条目
- dsh-lsp / dsh-plan-mode / dsh-sandbox-* 条目
- dsh-schedule / dsh-settings-file / dsh-session-*-sqlite 条目
- dsh-tool-fs-search / dsh-tool-str-replace-editor / dsh-commands 条目
- dsh-user-approval / dsh-persona / dsh-tool-goal / dsh-tool-jobs 条目
- dsh-mcp-client / dsh-repeat-tool-reminder / dsh-tool-call-timeout-policy 条目
- dsh-session-log-export / dsh-session-telemetry-otel 条目
- 9 条「可适配」条目（todo/file-reference/tmux/hooks/agent-presets/lsp/fs 工具形态）
- 4 条「暂不兼容」条目（Python 运行时/E2B/Cordis Host/goal 服务）
- npm 生态在线检索函数

#### 插件生态（plugin-loader / builtin-registry / plugin-market） / 组6：插件开关内核服务（plugin-manager-service）

- 开关状态 localStorage 持久化，重启保留
- 启用失败(error)态一并持久化防假启用
- 首次运行默认禁用游戏插件
- 启动即真卸载被禁插件（非假禁用）
- 启用插件＝真正加载进运行上下文
- 关闭插件＝dispose 运行 fiber（含 YAML 装配插件）
- 状态变更广播驱动界面刷新
- ctx-ready 幂等单例避免重开弹窗假禁用
- 单个插件重启（先卸后载）

#### 插件生态（plugin-loader / builtin-registry / plugin-market） / 组7：插件依赖图内核（dependency-graph / 加载器）

- 级联关闭清单递归推导（含 UI 影响说明）
- 核心/锁定插件拒绝关闭并返回原因文案
- 级联关闭判定是否需要用户确认
- 级联启用推导与缺失依赖上报
- 可安全关闭判定（canSafelyDisable）
- 依赖描述与 UI 影响文本生成
- 风险等级配置（安全/需注意/高风险）
- 插件加载器扫描/拓扑排序/热重载（内核）
- codem.yml 声明式装配与平台过滤（内核）

#### 插件生态（plugin-loader / builtin-registry / plugin-market） / 组8：内置插件注册表与元数据清单

- 内置插件元数据清单（含风险/图标/UI 影响）
- 静态运行时副本兜底（注册表未就绪也可渲染）
- 依赖信息与运行注册表同源同步
- 插件注册表自身为核心不可关插件
- 启动统一注册全部内置插件
- 核心基础设施插件（slots/llm/tools/session/storage/fs-local/shell-local 等）
- UI 插件族（sidebar/conversation/tool/settings/misc/market/theme/skin）

#### 插件生态（plugin-loader / builtin-registry / plugin-market） / 组9：插件相关 UI 槽位挂载（ui-market / ui-slots / SlotBridge）

- 插件管理/插件市场槽位声明
- ui-market 插件包把管理器挂入槽位
- ui-slots 插件以高优先级注册插件管理器
- 槽位组件崩溃自动回退兜底渲染
- 插件关闭后面板降级提示横幅

#### MCP 生态（管理器 / 市场 / 运行时 / CodeGraph） / 组1：MCP 管理器（入口与面板）

- 打开 MCP 管理面板
- 面板标题与关闭
- 打开服务器目录（市场）
- 全部连接
- 添加服务器
- JSON 导入服务器
- JSON 导入错误提示
- 空列表占位
- 服务器列表项与状态
- 查看已发现工具
- 查看连接错误
- 连接单个服务器
- 断开服务器
- 编辑服务器配置
- 删除服务器（带确认）
- 表单：名称
- 表单：传输方式
- 表单：URL
- 表单：启动命令与参数
- 表单：超时毫秒
- 表单提交/取消

#### MCP 生态（管理器 / 市场 / 运行时 / CodeGraph） / 组2：MCP 服务器目录（市场）

- 市场标题与关闭
- 搜索服务器
- 分类筛选
- 搜索结果空态
- 目录条目卡片
- 已安装标记
- 一键安装
- 配置 API Key 后安装
- 安装结果反馈
- 卸载服务器
- 打开官方文档
- 条目详情对话框
- 预设目录内容

#### MCP 生态（管理器 / 市场 / 运行时 / CodeGraph） / 组3：MCP 运行时与工具接入

- 多种传输协议连接
- 连接后自动发现工具
- MCP 工具进入 AI 工具集
- 服务器配置持久化与自动重连
- zvec-grep MCP stdio 自动注册

#### MCP 生态（管理器 / 市场 / 运行时 / CodeGraph） / 组4：CodeGraph 代码图谱集成（设置页 + MCP 接线）

- 设置页入口「代码图谱」
- 启用 CodeGraph 集成开关
- CLI 状态检测与重新检测
- 一键安装 CodeGraph CLI
- 项目索引检测
- 构建代码图谱
- 打开含 .codegraph/ 的项目自动连接 CodeGraph（自动机制）

#### 技能生态（SkillManager / 技能市场 / 技能运行时 / 内置技能包） / 组1：技能管理器·我的技能

- 打开技能管理面板
- 标签页切换
- 本地技能搜索
- 安装 ZIP 技能包
- 拖拽安装技能
- 安装进度与错误提示
- 来源筛选
- 技能列表空态
- 技能条目与选择
- 启用/禁用技能开关
- 技能详情：元信息
- 技能详情：完整提示词
- 删除技能（确认弹窗）
- 同名覆盖安装确认
- 技能安全审计对话框
- 技能权限描述与校验

#### 技能生态（SkillManager / 技能市场 / 技能运行时 / 内置技能包） / 组2：技能市场（浏览与安装）

- 市场技能搜索
- 检查更新
- 市场加载状态
- 市场错误提示
- 市场安装进度
- 市场来源筛选
- 市场空态与在线搜索提示
- 本地无结果自动联网搜索
- 市场技能卡片
- 打开技能仓库
- 安装市场技能
- 市场技能详情对话框
- 市场缓存秒开与后台更新
- 多市场源聚合

#### 技能生态（SkillManager / 技能市场 / 技能运行时 / 内置技能包） / 组3：技能发布到市场

- 发布入口（非内置技能）
- 目标市场选择与就绪检查
- 技能标识 slug 输入
- 显示名称与版本号
- 变更日志
- GitHub 私有仓库选项
- 就绪警告提示
- 发布结果反馈
- 确认发布

#### 技能生态（SkillManager / 技能市场 / 技能运行时 / 内置技能包） / 组4：技能安装器与本地发现

- ZIP 技能校验安装
- 安装安全检查
- 卸载技能
- 启动自动加载已装技能
- 技能目录文件直载兜底

#### 技能生态（SkillManager / 技能市场 / 技能运行时 / 内置技能包） / 组5：技能唤起（输入框 / 斜杠 / 选择器）

- 输入 / 弹出技能菜单
- 菜单选择插入技能名
- /技能名 高亮预览
- 发送时 / 手势注入技能
- 为本次消息选择技能
- 选中技能标记优先执行
- 输入框技能引导文案
- 快捷键帮助说明
- 全局搜索直达技能页

#### 技能生态（SkillManager / 技能市场 / 技能运行时 / 内置技能包） / 组6：技能加载运行时（load_skill）

- load_skill 按名加载技能
- 技能数轮后自动卸载
- 技能携带工具自动注册
- 技能目录轮换注入

#### 技能生态（SkillManager / 技能市场 / 技能运行时 / 内置技能包） / 组7：交互式表单（interactive 技能 Provider）

- interactive 技能与工具
- 表单对话框（单题/多题）
- 选择题与推荐标记
- 自定义答案输入
- 文本题输入
- 提交/取消表单
- 无 UI 环境的文本兜底

#### 技能生态（SkillManager / 技能市场 / 技能运行时 / 内置技能包） / 组8：提示词优化（prompt-optimization 技能 Provider）

- prompt-optimization 技能与工具
- 查看系统提示词来源
- 提交修改触发审核弹窗
- 逐项应用或跳过
- 原词与优化稿 diff
- 批量操作与确认
- 修改须用户确认才生效

#### 技能生态（SkillManager / 技能市场 / 技能运行时 / 内置技能包） / 组9：工具管理（MCP / 技能工具开关）

- 工具管理面板入口
- 工具搜索与分类过滤
- MCP 工具启用/禁用
- 技能工具启用/禁用
- 工具详情展开
- 禁用影响说明

#### 技能生态（SkillManager / 技能市场 / 技能运行时 / 内置技能包） / 组10：内置技能包（skills/*/SKILL.md 逐个）

- archify-架构图生成
- archify-工作流图生成
- archify-时序图生成
- archify-数据流图生成
- archify-生命周期图生成
- archify-Mermaid 输入转换
- archify-校验交付管线
- archify-浏览器视觉体检
- archify-品牌识别与徽标
- archify-查看器运行时能力
- archify-更新感知通知
- archify-仓库取证制图
- code-review-全面代码审查
- conversation-to-prompt-对话转提示词
- find-simplifications-简化机会审计
- interactive-交互式表单提问
- mermaid-diagram-多类型图生成
- pre-push-checks-推送前精选检查
- prompt-optimization-系统提示词管理
- prose-standard-全表面文案标准
- trim-cot-leakage-思维链泄漏清除
- skill-creator-技能新建与本地安装
- skill-creator-远程链接安装技能
- skill-creator-触发描述优化
- skill-creator-Eval 运行与判分
- skill-creator-Benchmark 聚合报告
- skill-creator-盲测 A/B 对比
- skill-creator-基准洞察分析
- skill-creator-Eval 评审页生成
- skill-creator-技能打包分发
- skill-creator-技能目录快速校验

#### 检索与代码图谱（zvec-grep / codegraph / 文件检索工具） / 组1：zvec-grep 运行时编排（服务）

- 运行状态检测与摘要
- 在线一键安装
- 离线 zip 导入
- 为项目建立/重建索引
- 卸载运行时
- 自动 Node 准备
- MCP stdio 自动注册
- 可选 embedding 模型清单

#### 检索与代码图谱（zvec-grep / codegraph / 文件检索工具） / 组2：zvec-grep 检索工具（对话侧）

- 语义检索工具 zvec_grep_search
- rg 精确检索工具 zvec_grep_rg
- 检索调用审批文案
- 双轨路由指导（grep/zvec）
- 代理允许列表预置
- 只读与并发安全集合
- 连接态同步与残留清理

#### 检索与代码图谱（zvec-grep / codegraph / 文件检索工具） / 组3：zvec-grep 市场卡片（插件市场内嵌）

- 运行时安装状态徽章与信息
- 在线一键安装运行时
- 离线 zip 包导入
- 为当前项目建立/重建索引
- Embedding 模型下拉选择
- 卸载运行时（删除运行时与模型）
- 展开安装后管理区
- 市场分区入口

#### 检索与代码图谱（zvec-grep / codegraph / 文件检索工具） / 组4：codegraph 代码图谱工具（对话侧）

- codegraph_* defer 图谱工具
- defer 按需加载节省 token
- tool_search 检索加载工具
- tool_search 模糊命中与候选
- 连接态同步与断连清理

#### 检索与代码图谱（zvec-grep / codegraph / 文件检索工具） / 组5：web 检索与搜索工具

- web_search 网页检索工具
- 检索后端自动路由
- 结构化结果供卡片渲染

#### 检索与代码图谱（zvec-grep / codegraph / 文件检索工具） / 组6：file-api 统一文件能力（Tauri IPC 适配层）

- 文件读取（UTF-8）
- 大文件分页读取
- 写文件（工作区沙箱前置校验）
- 正则内容检索 grepSearch
- glob 文件匹配 globSearch
- 目录列举
- 路径存在检测
- 删除文件/目录
- 执行命令 executeCommand

#### 检索与代码图谱（zvec-grep / codegraph / 文件检索工具） / 组7：fs 能力契约与模型侧文件工具

- fs 能力族统一接口（可插拔 Provider）
- AI 读文件 read（分页+截断续读）
- AI 整文件写入/覆写 write（自动 lint）
- AI 精确字符串编辑 edit
- AI 批量编辑 multi_edit
- AI glob 文件名搜索
- AI grep 内容搜索（正则+行号）
- 保护路径写保护（.git/.env/node_modules 等）
- 大幅改写旧文件的 diff 审批面板

#### UI 扩展体系（slots / ui-plugins / capabilities） / 组1：槽位注册与语义核心（slots/index）

- single 槽位（覆盖语义）
- list 槽位（列表语义）
- keyed 槽位（key 分派）
- chain 槽位（管道语义）
- register 参数校验与错误提示
- register 子槽位声明与级联回收
- register 返回注销函数
- declareSlot 框架级槽位声明
- slots.inject 条件注册
- 订阅与版本号批处理
- 槽位存活快照导出
- 组件崩溃上报与 abdicate
- 类型安全槽位扩展（SlotMap 声明合并）

#### UI 扩展体系（slots / ui-plugins / capabilities） / 组2：槽位渲染组件（SlotBridge / SlotRenderer）

- SlotBridge 单一槽位渲染
- SlotBridge 默认组件回退
- 降级横幅提示
- SlotListBridge 列表渲染
- SlotErrorBoundary 崩溃隔离
- 级联降级错误边界
- 版本订阅缓存渲染
- SlotRenderer 精确渲染
- SlotListRenderer 过滤渲染

#### UI 扩展体系（slots / ui-plugins / capabilities） / 组3：主框架与布局槽位（用户可见区域）

- app.titlebar 顶部栏
- app.boot-splash 启动画面
- app.workspace-backdrop 工作区背景
- app.toast-container 通知容器
- app.skin-layout 皮肤布局外壳
- app.sidebar 左侧边栏
- app.conversation 主会话区
- app.terminal 终端面板
- app.right-sidebar 右侧边栏
- app.overlay 全局叠加层（list）
- sidebar.tabs / sidebar.bottom-tabs / bottom-panel.tabs 扩展位
- conversation.composer.bar / dock 输入条扩展栏

#### UI 扩展体系（slots / ui-plugins / capabilities） / 组4：对话框/管理器槽位（用户可见区域）

- app.settings 设置面板
- app.permission-dialog 权限对话框
- app.mcp-manager / app.skill-manager MCP 与技能管理器
- app.session-recovery 会话恢复
- app.usage-stats 用量统计
- app.monitor 上下文监控面板
- app.performance-dashboard 性能仪表盘
- app.cordis Cordis 运行时面板
- app.message-feedback 消息反馈条
- app.attachment 附件上传位
- 会话子槽位（messages/input/node.tool/details.tool）

#### UI 扩展体系（slots / ui-plugins / capabilities） / 组5：行内组件与徽标槽

- app.goal-bar 目标指示条
- app.jobs-badge 任务徽标
- app.plan-mode-chip 计划模式开关
- app.model-selector 模型选择器
- app.permission-preset-selector 权限预设选择器
- app.deliverable-files 交付物文件列表

#### UI 扩展体系（slots / ui-plugins / capabilities） / 组6：ui-plugin 模块包与加载

- ui-sidebar 侧栏插件
- ui-conversation 会话插件
- ui-settings 设置插件
- ui-theme 主题插件
- ui-misc 杂项插件
- ui-panels 面板对话框插件
- ui-cordis Cordis 管理插件
- ui-market 市场插件
- ui-skin-default 默认皮肤插件
- UI 插件加载器与失败隔离

#### UI 扩展体系（slots / ui-plugins / capabilities） / 组7：capabilities 能力族（接口契约 + 真实工具面）

- fs/shell/sandbox/web/subagent/skill 能力族接口
- Agent 默认工具注册中心（bash/read/write/edit/glob/grep 等）
- 低频大 schema 工具按需延迟暴露

#### 主题·三皮肤（默认 / Hub / 梦幻） / 组1：皮肤预设（SKIN_PRESETS 共 3 套）

- 默认皮肤（经典暗/亮主题）
- Hub 皮肤（科技感三栏）
- 梦幻皮肤（氛围感）

#### 主题·三皮肤（默认 / Hub / 梦幻） / 组2：皮肤切换 UI（设置→外观）

- 三张皮肤卡片点选切换
- 皮肤选择自动保存与恢复
- 切回默认皮肤自动恢复明暗主题
- 默认皮肤深色/浅色主题下拉
- 标题栏明暗切换按钮
- Hub/梦幻专属布局随皮肤切换

#### 主题·三皮肤（默认 / Hub / 梦幻） / 组3：梦幻皮肤设置（选中梦幻时展开）

- 上传图片/GIF/视频背景
- 背景预览与一键清除
- 视频背景音频模式
- 背景音量调节滑杆
- 毛玻璃模糊度调节
- 卡片透明度调节
- 花瓣装饰元素开关
- 提取色板信息展示
- 梦幻设置自动保存恢复

#### 主题·三皮肤（默认 / Hub / 梦幻） / 组4：主题提取与自动取色（背景上传后自动）

- 背景图自动提取主题色
- 背景图自动压缩优化
- GIF/视频背景处理
- 按背景明暗自动切换主题
- 提取色板覆盖全界面配色
- 强调色与文字对比度自动调校
- 背景可读性半透明遮罩

#### 主题·三皮肤（默认 / Hub / 梦幻） / 组5：皮肤联动自适应

- 代码高亮配色随皮肤自适应
- 知识图谱配色随皮肤切换

#### 设置管理器 / i18n / 用量与成本 / 组1：设置管理器（分层来源引擎 + UI）

- 分层设置管理入口
- 设置来源优先级链总览
- 选中来源详情查看
- 策略限制状态一览
- 导出全部设置
- 分层合并取值引擎
- 设置读写落库与变更广播

#### 设置管理器 / i18n / 用量与成本 / 组2：设置面板 UI（全局入口/导航）

- 设置面板弹层
- 设置分组侧边导航
- 设置搜索与自动跳转
- 保存设置
- 页脚会话恢复入口
- 性能面板入口

#### 设置管理器 / i18n / 用量与成本 / 组3：i18n 国际化

- 语言切换下拉
- 支持语言：中文/English
- 语言偏好持久化
- 语言变更即时刷新 UI
- 全局文案双语词典
- 系统托盘菜单语言同步
- AI 系统提示按语言生成
- AI 回复语言规则
- 语音识别/朗读语言跟随
- 子智能体标签双语化
- AI 工具上下文可读界面语言（仅内部）

#### 设置管理器 / i18n / 用量与成本 / 组4：用量统计 UI

- 用量统计面板入口
- 概览/模型/历史/限额页签
- 对话概览统计
- 总调用次数/总会话数/输入输出 Tokens 统计卡
- 平均耗时统计卡
- 缓存命中率统计卡
- Token 活跃度热力图
- 每日用量趋势柱状图
- 调用历史记录列表

#### 设置管理器 / i18n / 用量与成本 / 组5：成本统计与限额

- 总费用/今日费用/平均费用统计卡
- 按模型费用排行条
- 会话费用进度条
- 助手消息成本显示
- 上下文面板今日费用与账户余额
- 每会话/每日/总限额设置
- 限额用量进度条
- 保存限额并持久化
- 调用费用自动记账（自动机制）
- 模型单价库与缓存计价（自动机制）
- 成本超限自动降级/停止（自动机制）

#### 可观测与韧性（telemetry / event-log / recovery / retry / heartbeat / snapshot） / 组1：telemetry / 性能监控

- 性能监控总览统计卡
- 事件趋势图与时间范围
- 事件类型占比分布
- 会话级统计表
- 事件时延统计
- 自动/手动刷新
- 导出 OpenTelemetry JSON
- 清空全部遥测数据
- 遥测事件自动采集落库（自动机制）

#### 可观测与韧性（telemetry / event-log / recovery / retry / heartbeat / snapshot） / 组2：event-log（事件溯源 / 轨迹）

- 会话事件全程留痕（自动机制）
- 执行轨迹实时面板
- 轨迹持久化与历史回放（自动机制）
- 会话分叉继承全部事件（自动机制）
- 压缩事件归档与摘要重建（自动机制）
- Transcript 缓存统计面板
- 缓存过期淘汰与压缩清空（自动机制）

#### 可观测与韧性（telemetry / event-log / recovery / retry / heartbeat / snapshot） / 组3：recovery（会话恢复）

- 会话恢复入口
- 会话恢复统计与列表
- 会话详情与恢复/删除
- 多层恢复管理面板
- 恢复数据自动定时保存（自动机制）
- 上次未正常退出提示（自动机制）
- 界面崩溃自动恢复提示（自动机制）
- 数据保存失败即时提示（自动机制）

#### 可观测与韧性（telemetry / event-log / recovery / retry / heartbeat / snapshot） / 组4：retry（LLM 重试）

- 自动重试策略配置
- 重试实时状态读数
- 错误分类测试器
- LLM 流失败自动重试（自动机制）
- 失败原因可见提示（自动机制）
- 连续失败熔断提示（自动机制）
- 错误分类与指数退避（自动机制）

#### 可观测与韧性（telemetry / event-log / recovery / retry / heartbeat / snapshot） / 组5：heartbeat（心跳）

- 心跳状态监控统计
- 心跳上报参数配置
- 心跳自动上报与失败熔断（自动机制）

#### 可观测与韧性（telemetry / event-log / recovery / retry / heartbeat / snapshot） / 组6：snapshot（文件快照 / 回滚）

- 文件快照面板
- 逐文件 Diff 对比
- 一键回滚到快照
- 破坏性操作前自动快照（自动机制）
- 快照自动清理与目录保护（自动机制）

#### persona 人格 / auth 登录 / 账号 / 组1：persona 管理器

- 人设管理页入口（设置→人设）
- 新建人设卡（名称+markdown 内容）
- 人设卡绑定外部文件（soul.md 风格）
- 文件模式热重载（改文件下次对话生效）
- 兜底文本（文件缺失/不可读时使用）
- 编辑既有人设卡
- 激活/取消激活人设
- 删除人设卡（激活卡联动取消激活）
- 激活人设注入系统提示 # Persona
- 人设卡与激活状态本地持久化（自动机制）
- @codem/persona 插件整体开关

#### persona 人格 / auth 登录 / 账号 / 组2：auth 登录（MiMo / CLI 模式）

- MiMo 账号区块（登录入口与说明）
- 浏览器 OAuth 登录按钮
- 已登录状态显示
- 登出按钮
- 登录失败错误就地提示
- 运行登录测试（诊断入口）
- 自动登录：读 auth.json 复用凭证（自动机制）
- 未登录发送消息的错误提示
- 侧边栏登录/身份状态展示

#### persona 人格 / auth 登录 / 账号 / 组3：账号存储与身份

- 账号记录落库（幂等 upsert，自动机制）
- 保持单一活跃账号（自动机制）
- 活跃账号 token 注入模型调用（自动机制）
- 活跃账号查询服务
- 助手身份设定（称呼/物种/语气/图标）
- 我的资料（头像上传/预设、称呼、时区）

#### 可观测相关辅助工具与服务 / 组1：通知 / 状态面板类（与本体可感知）

- 上下文监视面板（实时刷新）
- 文件监听自动化触发器（自动化→文件监听）
- 文件监听引擎：2 秒轮询+冷却防连发（自动机制）

### slice16 — Rust 命令面：lib.rs 的 generate_handler 全清单归类（文件/终端 PTY/MCP/HTTP/认证/窗口/宠物/托盘/微信 ilink/手机 phone/沙箱/下载解压/浏览器等），含 ilink.rs/phone 目录/runtime_log/崩溃标记/毛玻璃

#### 文件系统与命令执行命令面（src-tauri/src/lib.rs） / 组1：文件读写

- 整文件读取（文本/base64 自动识别）
- 行级分页读取（带行号）
- 二进制文件 base64 读取
- 原子写文件（临时文件+重命名）
- 写文件自动建父目录
- 目录列表（目录优先排序）
- 删除文件
- 重命名/移动文件
- 创建目录（含多级）
- 路径存在性探测
- 删除目录（Windows 进回收站）
- 递归通配符文件搜索（glob）
- 系统临时目录获取

#### 文件系统与命令执行命令面（src-tauri/src/lib.rs） / 组2：数据目录与默认工作区

- 应用数据目录获取（自动创建）
- 默认工作区初始化（全局 CWD）
- 工作区自动生成 AGENTS.md 指南

#### 文件系统与命令执行命令面（src-tauri/src/lib.rs） / 组3：命令执行与进程纪律

- PowerShell 命令执行（UTF-8 加固）
- 命令超时自动杀整棵进程树
- 命令日志脱敏后落盘

#### 文件系统与命令执行命令面（src-tauri/src/lib.rs） / 组4：系统对话框与信息

- 原生文件夹选择对话框
- 用系统默认应用打开
- 资源管理器定位文件
- 系统信息获取
- 安装器语言自动探测

#### 终端 PTY / MCP / HTTP 下载解压 / CodeGraph / 组1：交互式终端 PTY（portable-pty）

- 新建真实终端会话（PTY）
- 键盘输入写入终端
- 终端尺寸同步（resize）
- 关闭终端并杀干净进程树
- 终端输出实时回流（pty-output 事件）
- 终端会话结束通知（pty-exit 事件）

#### 终端 PTY / MCP / HTTP 下载解压 / CodeGraph / 组2：MCP stdio 服务器管理

- 连接 MCP stdio 服务器
- MCP JSON-RPC 请求/响应
- 断开并终止 MCP 进程

#### 终端 PTY / MCP / HTTP 下载解压 / CodeGraph / 组3：HTTP 代理与下载解压（技能市场/运行时产物）

- HTTP GET 代理（绕过 CSP）
- HTTP POST 代理
- 文件下载保存（技能包/宠物包）
- 大文件直连下载（禁代理+长超时）
- zip-slip 安全解压
- zvec-grep 运行时按需自动装配

#### 终端 PTY / MCP / HTTP 下载解压 / CodeGraph / 组4：CodeGraph 代码图谱

- 应用内一键安装 CodeGraph CLI
- 启用后自动连接 CodeGraph MCP

#### 认证（MiMo）与沙箱 / 组1：MiMo（小米）账号认证

- 原生 OAuth 扫码登录
- 读取本地 auth.json 恢复账号
- 登录防重入与超时保护

#### 认证（MiMo）与沙箱 / 组2：沙箱写保护

- 写入工作区白名单强制（沙箱模式）

#### 窗口 / 托盘 / 宠物 / 崩溃标记 / 运行时日志 / 毛玻璃 / 组1：系统托盘与窗口生命周期

- 托盘常驻 + 左键单击开关主窗
- 托盘「显示」菜单项
- 托盘「退出」菜单（先存盘后退出）
- 托盘菜单语言跟随界面切换
- 主窗关闭拦截（不直接退出）
- 退出前全面清理（PTY+崩溃标记）

#### 窗口 / 托盘 / 宠物 / 崩溃标记 / 运行时日志 / 毛玻璃 / 组2：桌面宠物窗口

- 创建透明置顶宠物悬浮窗
- 缩放保持精灵锚点不动
- 宠物右键弹出原生菜单
- 宠物菜单-窗口置顶开关
- 宠物菜单-重置位置
- 宠物菜单-查看剩余 Token
- 宠物菜单-切换宠物样式
- 宠物菜单-关闭宠物
- 关闭宠物窗口命令

#### 窗口 / 托盘 / 宠物 / 崩溃标记 / 运行时日志 / 毛玻璃 / 组3：崩溃检测与诊断

- 异常退出检测标记（active-run.json）
- 崩溃（panic）日志自动落盘
- 运行时日志按日文件+轮转+限容
- 日志单行截断与密钥脱敏

#### 窗口 / 托盘 / 宠物 / 崩溃标记 / 运行时日志 / 毛玻璃 / 组4：毛玻璃窗口材质

- 主窗毛玻璃背景（Mica/Acrylic）
- macOS 主窗 vibrancy 毛玻璃

#### 微信 ClawBot 桥 iLink（src-tauri/src/ilink/） / 组1：登录与状态机（QR 扫码 / 配对码 / 会话）

- 微信连接状态查询（含缓冲取回）
- 扫码登录微信（二维码自动刷新）
- 提交手机上显示的配对码
- 退出登录并清理会话
- 启动自动恢复续连
- 会话 23h 过期自动失效提醒
- 登录 token 历史留存（多端互认）

#### 微信 ClawBot 桥 iLink（src-tauri/src/ilink/） / 组2：收发、配额与入站

- 回复微信文本（长文自动切块）
- 每联系人 24h 配额软记账
- 微信消息实时上抛引擎（ilink-inbound）
- 挂载前入站消息缓冲

#### 手机连接 phone-link（src-tauri/src/phone/） / 组1：LAN 服务与配对流程

- 开启手机连接服务（随机端口）
- 停止手机连接服务
- 服务状态与设备列表查询
- 批准/拒绝手机配对请求
- 解绑已配对设备
- 手机配对静态页（结果提示）
- 配对成功即时通知桌面

#### 手机连接 phone-link（src-tauri/src/phone/） / 组2：鉴权与设备持久化

- Cookie 会话鉴权门卫
- 设备清单持久化（重启保配对）
- 局域网 IP 自动探测

#### 手机连接 phone-link（src-tauri/src/phone/） / 组3：桌面引擎请求代理

- 手机 API 代理到桌面引擎
- 手机端会话页面静态入口

### slice03 — 布局导航与工作区：Sidebar/TitleBar/SpaceSwitcher/ProjectManager/HubLayout/TopNavbar/DreamLayout/WorkspaceBackdrop/RightSidebar/PanelSidebar/FileExplorer/Workbench/TerminalPanel/CicdPanel/SearchDialog/SkinSelector 及布局相关其它

#### 全局窗口框架与外观 / （未分组）

- 窗口拖拽移动
- Windows 窗口控制按钮
- macOS 红绿灯窗口控制
- 品牌标识与标题
- 执行模式一键切换
- 全局搜索按钮（Ctrl+K）
- 设置入口按钮
- 明暗主题切换
- 终端开关按钮
- 皮肤卡片一键切换
- 默认皮肤明暗下拉
- 梦幻背景图/动图/视频上传
- 背景图自动配色适配
- 清除自定义背景
- 视频背景音频模式与音量
- 毛玻璃模糊度滑杆
- 卡片透明度滑杆
- 装饰元素开关
- 提取色板预览
- 工作区动态毛玻璃背景层
- 梦幻皮肤背景与可读性覆盖层
- 梦幻装饰元素渲染
- Hub 三栏工作区骨架
- Hub 顶部导航品牌
- Hub 顶部导航菜单

#### 主导航、项目与会话管理 / （未分组）

- 侧栏宽度拖拽调节
- 新建对话
- 知识笔记本入口
- 任务中心入口与未读角标
- 工具入口组（MCP/技能/记忆/智能体）
- 底部用户区与插件管理
- 全局会话分组列表
- 项目区入口与新建项目
- 项目会话展开/收起
- 项目内一键新建会话
- 项目更多菜单（置顶/浏览器/资源管理器/移除）
- 项目置顶/取消置顶
- 直达项目文件浏览器
- 在系统文件管理器中打开项目
- 移除项目（带二次确认）
- 会话点击切换
- 会话运行中指示
- 会话未读徽标
- Git 工作树模式徽标
- 委派进行中徽标
- 会话悬停置顶
- 会话悬停删除
- 会话右键快捷菜单
- 会话内联重命名
- 置顶会话优先排序
- 快速搜索弹窗
- 跨项目会话检索
- 项目搜索与一键切换
- 快捷动作直达
- 纯键盘操作
- 项目列表与打开
- 新建项目
- 系统文件夹选择器
- 导入已有文件夹
- 新建 Git 项目
- 从 GitHub 拉取项目
- GitHub Token 引导与复用
- 环境脚本配置
- 项目删除
- 完整流程状态反馈

#### 工作区工具面板 / （未分组）

- 右侧栏收起/展开
- 面板宽度拖拽记忆
- 文件/浏览器双 Tab
- 项目文件树浏览
- 侧栏内文件预览
- 内嵌网页浏览器
- 空状态引导
- Git 面板标签
- 文件浏览标签
- 变更清单标签
- 工作台标签
- CI/CD 标签
- 隐藏标签自动回退
- 面板关闭按钮
- 项目目录树浏览
- 目录展开/折叠
- 文件名搜索过滤
- 一键刷新
- 文件变更自动刷新
- Git 状态徽标
- 文件类型图标
- 点击打开文件
- 拖拽引用文件
- 状态/容量/活动三视图切换
- 执行工具状态视图
- 修改文件统计视图
- 变更活动时间线
- 面板折叠开关与说明

#### 终端与 CI/CD / （未分组）

- 项目内嵌终端
- 多标签终端会话
- 新建/关闭终端标签
- 一键停止进程
- 防误中断键位语义
- 右键粘贴/复制
- 终端自适应尺寸
- 会话空闲自动回收
- 终端链接可点击
- 启动横幅
- GitHub 仓库接入
- CI 状态概览卡
- 运行列表展示
- 跳转 GitHub 详情
- run 明细展开（job/step）
- 失败运行重试
- 取消运行
- 手动/自动刷新
- Workflow YAML 模板生成
- 复制/另存 YAML
- 操作结果即时反馈

#### 布局相关其它 / （未分组）

- 收起/展开侧边栏按钮
- 侧边面板开关

### slice04 — SettingsPanel 22 大分区

#### （未分组）

- 搜索设置
- 关闭设置面板
- 保存设置
- 会话恢复
- 用量统计快捷入口
- 运行模式：API 模式
- 运行模式：CLI 模式
- 登录小米账号
- 登出小米账号
- 运行登录测试
- 选择当前对话模型
- 打开模型配置方案
- 我的称呼
- 我是谁（种类/人设）
- 我的风格
- 我的图标（emoji）
- 上传自定义头像
- 清除头像
- 预设头像选择
- 你的名字
- 怎么称呼你
- 你的时区
- 填写服务商 API Key
- 修改服务商 Base URL
- 刷新模型列表
- 保存并重载 Provider 配置
- 添加自定义 Provider
- 自定义 Provider 名称
- 自定义 Provider Base URL
- 自定义 Provider API Key
- 保存自定义 Provider
- 取消添加自定义 Provider
- 重命名自定义 Provider
- 删除自定义 Provider
- 沙箱模式开关
- 关闭（✕）
- 完成（Done）
- 新建方案（+ 新建方案 / 取消）
- 方案名称（输入框）
- 描述（输入框）
- 创建并编辑槽位（Create & Edit Slots）
- 设为当前方案（方案卡片，每个方案）
- 编辑槽位 / 收起（每个非内置方案条目）
- 删除（每个非内置方案条目）
- 复制并编辑（每个内置方案条目）
- 名称（重命名输入框，每个编辑中的方案）
- 描述（编辑输入框，每个编辑中的方案）
- 槽位启用（复选框，每个槽位行）
- 提供商（下拉选择，每个启用的槽位行）
- 模型（下拉选择，每个启用的槽位行）
- 推理强度（下拉选择，每个启用的槽位行）
- 切换皮肤
- 明暗模式
- 上传背景图片/GIF/视频
- 清除背景
- 背景视频音频模式
- 背景视频音量
- 毛玻璃模糊度
- 卡片透明度
- 显示装饰元素
- 显示拍立得
- 手写标题字体
- 界面安全区
- 语言 / Language
- 界面字号
- 字体粗细（wght）
- 对话显示模式
- 安全策略模式
- 关闭主窗口行为
- 全局字体
- 删除自定义权限规则
- 新增权限规则：工具名
- 新增权限规则：资源匹配
- 新增权限规则：动作
- 添加权限规则
- 快速模板：禁止 bash sudo
- 快速模板：允许 read \
- 快速模板：禁止 write \*.lock
- 快速模板：询问 bash npm\
- 分支前缀（文本输入）
- PR 合并方法（下拉选择）
- 允许强制推送 force push（勾选框）
- 默认创建草稿 PR（勾选框）
- 🔄 自动 Commit（勾选框）
- GitHub Token（密码输入框）
- 提交信息风格指令（文本域）
- PR 标题风格指令（文本输入）
- PR 描述风格指令（文本域）
- 保存 Git 配置（按钮）
- 设置脚本（文本输入）
- 清理脚本（文本输入）
- 添加自定义操作（按钮）
- 自定义操作-图标（文本输入，每个条目/行）
- 自定义操作-名称（文本输入，每个条目/行）
- 自定义操作-命令（文本输入，每个条目/行）
- 运行自定义操作（▶ 按钮，每个条目/行）
- 删除自定义操作（✕ 按钮，每个条目/行）
- 保存环境配置（按钮）
- 最大工作树数量
- 自动清理最旧工作树
- 删除前检查未提交修改
- 扫描现有工作树
- 删除指定工作树
- 最大分块大小
- 重叠大小
- 检索结果数量 Top-K
- 相似度阈值
- 展开/收起多模态设置
- Vision 图片理解 — 启用/禁用开关
- STT 语音输入 — 启用/禁用开关
- Embedding 语义搜索 — 启用/禁用开关
- TTS 语音合成 — 启用/禁用开关
- ImageGen 图像生成 — 启用/禁用开关
- Provider 下拉（每个已启用能力卡片，Vision/STT/Embedding/TTS/ImageGen 各一行）
- 模型下拉或文本输入（每个已启用远程能力卡片，各一行）
- 本地模型下拉（仅 Embedding 本地模式）
- API Key 密码输入（每个已启用远程能力卡片，各一行）
- Base URL 文本输入（每个已启用远程能力卡片，各一行）
- 保存（按钮）
- ✕ 关闭（按钮）
- 优先使用云端 TTS（开关）
- 语音（下拉，中文/英文/其他分组，含“自动选择”）
- 语速（滑杆 0.5–2.0）
- 音调（滑杆 0–2.0）
- 音量（滑杆 0–1.0）
- 试听 / 停止朗读（按钮，朗读中切换为停止）
- Ollama 服务地址（文本框）
- 自动检测本地模型（勾选框）
- 保存（按钮）
- 测试连接（按钮）
- 刷新模型列表（按钮）
- 下载 Ollama（外链，新窗口打开官网）
- 启用桌面宠物
- 浏览宠物市场
- 激活宠物
- 卸载宠物
- 宠物大小
- 宠物透明度
- 宠物水平位置
- 宠物垂直位置
- 搜索宠物（搜索输入框）
- 重试加载（按钮，加载失败时）
- 安装宠物（按钮，每个卡片）
- 卸载宠物（按钮，每个卡片）
- 关闭工具管理面板（右上角 ×）
- 搜索工具输入框
- 分类过滤按钮（全部/内置工具/MCP 工具/技能工具/委派工具）
- 工具启用/禁用开关（每个工具行）
- 工具详情展开/收起（每个工具行）
- 新建人设卡（＋）
- 人设卡名称输入
- 人设内容编辑（textarea）
- 外部文件路径输入
- 兜底文本输入
- 保存
- 取消
- 编辑（每个卡片）
- 设为激活/取消激活（每个卡片）
- 删除（每个卡片）
- 运行模式单选（禁用/只读/手动批准/自动）
- AI 可自行修改运行模式
- 截图输出目录
- 截图默认缩放（滑块）
- 扫码登录微信
- 刷新二维码
- 复制绑定链接
- 输入配对码
- 提交（配对码）
- 断开
- 重新扫码（换 24h token）
- 启用微信桥（响应微信消息）
- 默认模型（空 = 引擎默认）
- 默认工作区目录（空 = 应用默认工作区）
- 批准（每个待批准条目）
- 拉黑（每个待批准条目）
- 移除（每个白名单条目）
- 解除（每个黑名单条目）
- 手动添加白名单 peer（xxx@im.wechat）
- 添加
- 开始配对（启动 LAN 服务）
- 停止服务
- 刷新配对二维码
- 复制配对链接
- 批准（配对等待中）
- 拒绝（配对等待中）
- 解除设备（每个已配对设备）
- 启动时自动开启 LAN 服务
- 启用 CodeGraph 集成
- 重新检测 CLI 与索引
- 一键安装 CodeGraph
- 构建代码图谱
- 高级子页切换
- 新建 Profile
- Profile 身份标识
- Profile 领域
- Profile 范围
- Profile 经验摘要
- 保存 Profile
- 取消 Profile 编辑
- 编辑已有 Profile
- 删除 Profile
- 清空缓存
- 刷新统计
- 自动刷新
- 关闭面板（×）
- 新建（按钮）
- 查看/选中智能体（每个条目/卡片）
- 编辑（每个条目/行）
- 删除（每个条目/行，仅非内置）
- 名称（输入框）
- 描述（输入框）
- 模式（下拉框）
- 协作模式（下拉框）
- 模型槽位（下拉框）
- 最大步数（数字输入框）
- 最大 Token（数字输入框）
- 温度（数字输入框）
- 推理强度（下拉框）
- 上下文模式（下拉框）
- 可生成子智能体（复选框）
- Squad Leader 适配（复选框）
- 工具权限复选框（每个工具/行）
- 系统提示词 中文（文本框）
- 系统提示词 英文（文本框，可选）
- 权限规则-工具（输入框，每个规则行）
- 权限规则-资源（输入框，每个规则行）
- 权限规则-动作（下拉框，每个规则行）
- 删除权限规则（按钮，每个规则行）
- + 添加规则（按钮）
- 保存（按钮）
- 取消（按钮）
- 心跳间隔 (毫秒)（数字输入框）
- 超时 (毫秒)（数字输入框）
- 上报端点 URL（文本输入框，可选）
- 最大连续失败次数（数字输入框）
- 自定义请求头 JSON（文本输入框）
- 发送元数据（复选框）
- 保存配置（按钮）
- 停止所有心跳（按钮，仅活跃>0 时显示）
- 最大重试次数
- 基础延迟（毫秒）
- 退避倍数
- 最大延迟（毫秒）
- 总超时（毫秒）
- 遵守 Retry-After 响应头
- 保存配置
- 重置状态
- 测试错误信息输入框
- 测试按钮
- 智能体
- 协作模式
- 工作目录
- Git 分支
- 模型信息
- 项目指令（可选）
- 复制全部
- 段落折叠/展开（每个段落）
- 选择来源层查看详情（每个来源条目/行）
- 导出所有设置
- 复制到剪贴板
- 启用纠偏模式
- 纠偏模型提供商
- 纠偏模型名称
- 选择会话（点击会话条目，每个会话/行）
- 删除会话 ✕（每个会话/行）
- 强制保存
- 导出数据
- 复制（导出数据）
- 清除所有
- 重新播放新手引导
- 检查更新
- 关闭用量统计面板
- 页签·概览
- 页签·模型
- 页签·历史
- 页签·限额
- 每会话限额（数字输入）
- 每日限额（数字输入）
- 总限额（数字输入）
- 保存限额
- 页签·总览
- 页签·会话
- 页签·时延
- 刷新
- 时间范围选择（仅总览页）
- 自动刷新（开关）
- 导出 OTel
- 清空数据（触发确认）
- 清空确认弹窗·取消
- 清空确认弹窗·确认清空

### slice01 — 对话主区与消息渲染：ChatPanel.tsx、InputArea.tsx、MessageBubble.tsx、MessageActions/InlineMessageEdit/ReasoningRow/StatsLine/RunStatusBar/TurnStatus/ErrorCard/StreamingWaitIndicator/ToolCallGroup/ToolCallCard/ActivityTimeline/ScrollToBottomIndicator/SelectionTooltip/FileLinkContextMenu/TodoListDisplay/RegenerateModelPopover/ConversationOverview/ConversationRoot/Session/Composer/NewChatPage/GuidanceBlock/FeedbackButtons/JobsBadge/GoalBar/QuickAccessCards/CloseConfirmDialog 及与消息展示/输入相关的其它 .tsx

#### 会话头部、消息流与输入区主骨架（ChatPanel / ConversationRoot / ConversationSession / ConversationComposer） / 组1：会话头部与工具栏（ChatPanel.tsx）

- 收起/展开侧边栏
- 会话标题下拉切换会话
- 顶部模型选择器
- 推理强度选择（低/中/高/超高）
- 思考过程显示/隐藏开关
- 连接状态指示灯与断线横幅
- 后台任务计数徽标（JobsBadge）
- 智能体与团队面板入口
- 文件快照面板入口
- 上下文监控面板入口
- 临时会话入口（不污染主会话）
- 执行轨迹面板入口
- 右侧工具面板开关
- 会话头部任务下拉列表

#### 会话头部、消息流与输入区主骨架（ChatPanel / ConversationRoot / ConversationSession / ConversationComposer） / 组2：消息流渲染与滚动行为（ChatPanel.tsx）

- 统一模式合并同轮回复
- 新消息入场动画
- 置底自动跟随滚动
- 向上滚动加载更早历史
- 加载历史保持阅读位置
- 任务完成后锚定“任务完成”标记
- 轮尾「任务完成」徽标与操作
- 从该消息分叉新对话
- 重新生成整轮回复
- 顶部运行状态条（RunStatusBar）
- 步骤进度胶囊与执行计划
- 流式等待分阶段提示（StreamingWaitIndicator）
- 流式状态计时条
- 消息流内引导消息栏
- 对话引用横幅置入输入区
- 回到底部浮动按钮与未读提示
- 滚动条消息位置标记
- 空会话引导页（NewChatPage）
- 快速访问 Agent 卡片
- Agent 卡片收藏与搜索过滤
- 空状态快捷短语快捷入口
- 轮尾交付文件列表

#### 会话头部、消息流与输入区主骨架（ChatPanel / ConversationRoot / ConversationSession / ConversationComposer） / 组3：消息气泡外壳与内容区（MessageBubble.tsx / InlineMessageEdit.tsx）

- 用户头像与 AI 消息头
- 附件卡片展示
- 文本附件内容点击展开预览
- 图片灯箱画廊（ImageGallery）
- 视频附件内嵌播放
- 用户消息 Markdown 渲染
- 助手消息统一富内容渲染
- 行内消息编辑（InlineMessageEdit）
- 编辑并重发
- 编辑并回退（新会话重放）
- 恢复到输入框继续追问
- 复制整条消息
- 精选/取消精选到导航条
- 朗读消息（TTS）
- 赞/踩反馈（FeedbackButtons）
- 长内容自动折叠与展开
- 笔记操作即时通知
- 子智能体任务状态行
- 清理过程文件（删除确认）
- 错误卡片（ErrorCard）
- 思考行（ReasoningRow）
- 消息统计行（StatsLine）
- 轮级状态行（TurnStatus）
- 引用来源徽标与角标
- RAG 来源引用列表（SourceReferences）

#### 富内容渲染与工具调用可视化 / 组4：富内容渲染器（rich-content/*）

- 统一富内容 Markdown 渲染
- 段落级复制与引用按钮
- 流式期间轻量渲染防卡顿
- 代码块视图（CodeBlockView）
- 表格滚动视图（TableScrollView）
- Mermaid 图表渲染（MermaidCanvasView）
- 数学公式渲染（KaTeX）
- 图片预览与全屏（ImagePreviewView）
- JSON 格式化视图（JsonFormatView）
- HTML 沙箱预览（HtmlPreviewView）
- 内联代码与文件名智能链接
- 通用全屏查看器（FullscreenViewer）

#### 富内容渲染与工具调用可视化 / 组5：工具调用展示（ToolCallGroup.tsx / ToolCallCard.tsx）

- 工具调用组标题行
- 连续同名工具自动合并
- 连续只读调用自动折叠
- 工具行卡片（ToolCallCard）
- 终端专用卡片
- Diff 专用卡片
- 读文件专用卡片
- 搜索/查找结果专用卡片
- Web 搜索结构化结果卡
- 通用 IN/OUT 参数卡
- 工具返回文件列表直达链接

#### 输入区与消息操作辅助 / 组6：选区引用与文件链接（SelectionTooltip.tsx / FileLinkContextMenu.tsx / utils/file-link.ts）

- 选区「引用提问」浮钮
- 引用横幅展示与清除
- 文件链接左键定位
- 文件链接右键菜单

#### 输入区与消息操作辅助 / 组7：输入区编辑器（InputArea.tsx）

- 输入框自适应增高
- 大输入框展开/收起模式
- 失焦自动折叠成单行胶囊
- Enter 发送 / Shift+Enter 换行 / IME 保护
- ↑/↓ 输入历史召回
- 按会话自动保存草稿
- 轮换情境提示占位
- 粘贴图片自动转附件
- 拖拽上传文件/图片
- 多选文件上传（FileUpload）
- 附件列表管理与视觉提示
- / 技能命令菜单
- 技能 Pill 镜像高亮
- @ 文件提及自动补全
- 引用徽章行（ComposerBadges）
- ＋ 添加菜单
- 技能多选弹层（本次消息）
- 图像/视频生成模式面板
- 知识来源选择器（笔记本模式）
- 安全权限模式快捷切换
- 计划/执行模式切换
- 语音输入（麦克风）
- 发送/停止按钮状态机
- 快捷短语与草稿弹层菜单
- 快捷短语面板（QuickPhraseSelector）
- Prompt 草稿面板（PromptDraftPicker）
- 自定义操作快捷按钮

#### 会话概览与关闭确认 / 组8：对话概览（ConversationOverview.tsx，承载于用量统计面板「对话概览」页）

- 会话消息统计卡
- 会话时长与费用限额进度条
- 对话轮次列表

#### 会话概览与关闭确认 / 组9：关闭窗口确认（CloseConfirmDialog.tsx）

- 关闭时选择托盘驻留或退出
- 记住关闭选择
- MessageActions.tsx
- TodoListDisplay.tsx
- GuidanceBlock.tsx
- ActivityTimeline.tsx
- RegenerateModelPopover.tsx
- GoalBar.tsx
- CorrectionModeToggle.tsx / CorrectionResultPanel.tsx
- ChatPanel 内建对话搜索弹窗

### slice02 — 会话增强面板与审批澄清：SideSessionPanel/SnapshotPanel/ContextMonitor/TrajectoryPanel/AgentPanel/AgentDetail/AgentTeamsPanel/NeedsYouPanel/PermissionDialog/ClarificationForm/InteractiveFormDialog/PlanApprovalCard/PlanModeChip/DecisionTray/PipelineNextStepDialog/PromptChangeReviewDialog/CorrectionModeToggle/CorrectionResultPanel/CorrectionModelConfig 及同族其它

#### 会话增强侧栏面板 / （未分组）

- 临时会话入口按钮（对话顶栏）
- 基于当前会话上下文的独立追问
- 流式回答实时渲染
- 多轮问答气泡列表
- 悬浮窗任意拖拽定位
- 关闭即丢弃本次追问
- Enter 快捷发送
- 文件快照入口按钮（对话顶栏）
- 快照列表浏览
- 展开快照详情
- 单文件 Diff 对比
- 一键回滚到此快照
- 快照刷新与加载反馈
- 上下文监控入口按钮（对话顶栏）
- Token 用量进度条
- 四项状态统计
- 一键手动压缩上下文
- 压缩结果即时反馈
- 压力预警提示条
- 账户余额查询（DeepSeek 限定）
- 压缩参数：上下文窗口大小
- 压缩参数：压缩阈值滑杆
- 压缩参数：压缩后保留消息数
- 压缩参数：输出预留
- 压缩参数：系统提示词预留
- 压缩参数：保留近期工具输出
- 保存压缩配置
- 执行轨迹入口按钮（对话顶栏）
- 步骤类型下拉过滤
- 轮次聚合指标卡
- 步骤时间线逐行展示
- 步骤摘要与详情展开
- 双数据源实时轨迹
- 空态提示

#### 智能体与团队 / （未分组）

- 智能体与团队入口按钮
- 运行统计行
- 当前团队卡片
- 团队成员行与动态预览
- 成员失败/结果摘要与完整详情
- 个体智能体平铺列表
- 空态引导文案
- 返回上一级
- 状态头
- 已处理/总用时实时计时
- 活动明细逐条计时
- 任务指令原文查看
- 执行结果多维呈现
- 错误信息块
- 基本信息元数据
- 团队活动面板（任务中心团队 Tab 内运行时视图）
- 成员列表区
- 任务看板区
- 未读消息计数汇总
- 空态引导与关闭
- 实时刷新订阅
- 智能体管理入口
- 智能体卡片列表
- 新建智能体
- 编辑/删除智能体（内置只读）
- 只读定义详情区
- 基础信息编辑
- 模式/协作/模型槽位选择
- 执行参数配置
- 上下文模式与队长能力开关
- 工具权限复选网格
- 中英文双系统提示词编辑
- 权限规则逐行编辑
- 保存/取消
- 需要你的判断弹窗自动弹出
- 当前工作上下文区
- 已确认的事实区
- 具体问题展示
- 候选项单选按钮
- 自定义回答输入
- 确认回答提交
- 跳过并继续

#### 审批决策与权限 / （未分组）

- 权限请求内嵌托盘（替代弹窗）
- 托盘折叠/展开
- 审批信息标题区
- 参数原文预查看
- 批准/拒绝（可带原因）
- 委派后台权限弹窗触发
- 工具名与风险等级标签
- 人类可读动作描述
- 资源路径展示
- 拒绝/允许/始终允许
- 安全模式按钮（输入栏/设置）
- 三档安全模式下拉
- 全局/项目级一键切换
- 流式输出时锁定切换
- 写入覆盖内嵌审批（替代弹窗）
- 审批头信息
- Unified 行级 diff 视图
- Preview 双栏预览视图
- 批准/拒绝按钮
- 自定义改写指令
- 全部批准（本轮后续自动放行）

#### 澄清表单与计划/提示词审批 / （未分组）

- 交互式表单触发
- 多问题同屏填写
- 单选/多选选择卡
- 推荐选项徽标
- 「+ 其他（自定义输入）」
- 文本输入题
- 必答校验
- 提交/取消
- 计划审批弹窗触发
- 计划全文只读展示
- 批准并执行
- 拒绝并展开理由输入
- 确认拒绝/返回
- 计划模式激活标签
- 点击退出计划模式
- 流式输出时锁定退出
- 提示词修改审核弹窗触发
- 每条变更卡（名称+类型，可折叠）
- 原始 vs 优化后提示词对照
- 逐条 应用/跳过
- 决策汇总计数
- 应用选中 / 全部取消
- 应用结果回执（当前未真实改写系统提示词）

### slice05 — 独立配置/工具面板：LayeredSettingsPanel/ModelProfilePanel/ModelSelector/MultimodalPanel/OllamaSettingsPanel/VoiceSettingsPanel/ComputerUseSettings/WechatSettings/PhoneLinkSettings/GitEnvSettings/GitHubCloneDialog/GitBranchSelector/GitInfoPanel/PersonaManager/MemoryManager/PerformanceDashboard/UsageStats/UsageVisuals/RecoveryPanel/HeartbeatMonitor/RetryConfigPanel/PromptDebugger/ToolManager/SkillAuditDialog/AgentManager/PermissionPresetSelector 等

#### 分层设置与模型配置管理 / 组1：LayeredSettingsPanel 分层设置管理

- 设置来源优先级链视图
- 单层来源详情面板
- 策略限制状态区
- 导出所有设置 JSON
- 复制导出结果到剪贴板

#### 分层设置与模型配置管理 / 组2：ModelProfilePanel 模型配置方案

- 方案卡片列表与当前方案高亮
- 一键切换当前激活方案
- 新建模型方案
- 内置方案「复制并编辑」
- 任务槽位编辑表格
- 方案重命名与描述编辑
- 删除自定义方案
- 槽位回退说明与摘要徽章

#### 分层设置与模型配置管理 / 组3：ModelSelector 模型选择器

- Composer 内嵌模型下拉选择
- 推理强度循环切换
- 流式输出时锁定模型切换

#### 多模态能力与本地模型 / 组1：MultimodalPanel 多模态设置

- Vision 图片理解配置卡
- STT 语音输入配置卡
- Embedding 语义搜索配置卡
- TTS 语音合成配置卡
- ImageGen 图像生成配置卡
- Provider 一键带入已存 API Key
- 本地嵌入模型选择与详情
- 本地模型加载状态实时指示
- 保存多模态配置并反馈

#### 多模态能力与本地模型 / 组2：OllamaSettingsPanel 本地 Ollama 设置

- Ollama 服务地址配置
- 自动检测模型开关
- 保存并重新检测连接
- 连接状态检测
- 模型列表与详情展示
- 离线模式横幅与下载指引

#### 语音朗读设置 / 组1：VoiceSettingsPanel 语音设置面板

- 优先使用云端 TTS 开关
- 朗读语音选择
- 语速滑杆调节
- 音调滑杆调节
- 音量滑杆调节
- 试听/停止朗读按钮
- 可用语音数量提示
- TTS 不支持警告

#### 电脑操作与远程接入设备 / 组1：ComputerUseSettings 电脑操作设置

- 电脑操作运行模式切换
- AI 自行修改运行模式开关
- 截图输出目录配置
- 截图默认缩放滑杆
- 会话批准与合规说明

#### 电脑操作与远程接入设备 / 组2：WechatSettings 微信 ClawBot 设置（桌面应用限定）

- 扫码登录微信
- 刷新二维码与复制绑定链接
- 配对码输入提交
- 断开连接与重新扫码
- 连接状态徽章与余量信息
- 启用微信桥主开关
- 默认模型设置
- 默认工作区目录设置
- 待批准名单审批
- 白名单移除
- 黑名单解除
- 手动添加白名单账号
- 合规与限制提示

#### 电脑操作与远程接入设备 / 组3：PhoneLinkSettings 手机连接（LAN）设置（桌面应用限定）

- 开始配对并启动 LAN 服务
- 停止 LAN 服务
- 刷新配对二维码
- 配对二维码与复制配对链接
- 配对请求批准/拒绝
- 已配对设备管理与解除
- 启动时自动开启 LAN 服务开关
- 使用边界与合规提示

#### Git 与工程环境配置 / 组1：GitEnvSettings — GitConfigSection Git 偏好配置

- 分支前缀设置
- PR 合并方法选择
- 允许强制推送开关
- 默认草稿 PR 开关
- 自动 Commit 开关
- GitHub Token 配置
- 提交信息风格指令
- PR 标题风格指令
- PR 描述风格指令
- 保存 Git 配置

#### Git 与工程环境配置 / 组2：GitEnvSettings — EnvironmentConfigSection 环境脚本配置

- 项目设置脚本
- 项目清理脚本
- 自定义一键操作管理
- 一键运行自定义操作
- 保存环境配置

#### Git 与工程环境配置 / 组3：GitHubCloneDialog 从 GitHub 拉取项目（桌面应用限定）

- 输入仓库地址一键克隆
- 克隆进度视图
- 成功后自动创建项目
- 失败详情与重试

#### Git 与工程环境配置 / 组4：GitBranchSelector Git 分支选择器

- 当前分支与脏状态按钮
- 下拉切换本地分支
- 新建分支
- 操作错误提示

#### Git 与工程环境配置 / 组5：GitInfoPanel Git 状态面板

- 分支区与干净状态徽章
- 变更统计行
- 快速提交
- 一键推送与拉取
- 最近提交列表
- 手动/自动刷新
- 会话工作树路径提示

#### 人设与记忆管理 / 组1：PersonaManager 人设卡管理

- 人设卡列表
- 新建人设卡
- 编辑人设卡字段
- 激活/取消激活人设
- 删除人设卡
- 注入与热重载说明

#### 人设与记忆管理 / 组2：MemoryManager 记忆系统管理器

- 记忆统计概览
- 记忆搜索
- 按范围过滤记忆
- 新增记忆条目
- 记忆详情查看与编辑/删除
- 导出记忆 JSON
- 导出记忆 Markdown
- 导入记忆 JSON
- 一键整合记忆

#### 用量统计与性能监控 / 组1：PerformanceDashboard 性能监控台

- 概览统计卡
- 事件趋势柱状图
- 事件类型分布
- 会话级统计表
- 时延统计表
- 自动刷新开关
- 手动刷新
- 导出 OTel JSON
- 清空全部遥测数据

#### 用量统计与性能监控 / 组2：UsageStats 用量统计面板

- 用量概览统计卡
- 对话概览卡片
- 按模型费用排行
- 历史调用记录
- 费用限额设置
- 用量进度条

#### 用量统计与性能监控 / 组3：UsageVisuals 用量可视化组件（供 UsageStats 嵌入）

- Token 活跃度热力图
- 每日用量柱状图

#### 会话恢复、心跳与重试运维 / 组1：RecoveryPanel 多层会话恢复面板

- 恢复摘要统计
- 已保存会话列表
- 会话详情与最近消息预览
- 强制保存当前状态
- 删除单会话恢复数据
- 导出恢复数据
- 清除全部恢复数据
- 自动刷新状态

#### 会话恢复、心跳与重试运维 / 组2：HeartbeatMonitor 心跳监控

- 全局心跳状态统计
- 会话心跳实时列表
- 心跳间隔配置
- 心跳超时配置
- 上报端点 URL
- 最大连续失败次数
- 自定义请求头 JSON
- 发送元数据开关
- 保存心跳配置
- 停止所有心跳

#### 会话恢复、心跳与重试运维 / 组3：RetryConfigPanel 重试执行器配置

- 重试运行状态
- 最大重试次数配置
- 基础延迟配置
- 退避倍数配置
- 最大延迟上限
- 总超时配置
- 遵守 Retry-After 响应头
- 重试延迟预览
- 保存配置与重置状态
- 错误分类测试器
- 可重试错误类型参考

#### 提示词与工具治理 / 组1：PromptDebugger 系统提示词调试器

- 提示词参数实时预览
- 长度与分词统计
- 复制全部提示词
- 分段折叠浏览

#### 提示词与工具治理 / 组2：ToolManager 工具管理

- 工具搜索
- 分类过滤
- 工具启用/禁用开关
- 工具详情展开
- 影响提示

#### 提示词与工具治理 / 组3：SkillAuditDialog 技能安全审计对话框

- 总体风险评级徽章
- 声明权限清单
- 审计发现问题明细
- 高风险接受确认门槛
- 分级安装与取消

#### 智能体定义与安全策略 / 组1：AgentManager 智能体定义管理

- 智能体卡片列表
- 只读详情视图
- 新建与删除自定义智能体
- 身份与描述编辑
- 类型参数选择
- 运行参数配置
- 子智能体与 Squad Leader 能力开关
- 工具白名单勾选网格
- 权限规则行编辑
- 中英双系统提示词与保存

#### 智能体定义与安全策略 / 组2：PermissionPresetSelector 安全模式预设选择器

- 当前安全模式指示按钮
- 三档安全预设快速切换
- 项目级/全局模式写入
- 锁定态防误切

### slice08 — PPT 全套（PPTAdapter/PPTEditor/SlideCanvas/PropertyPanel/EditorToolbar/PresentationMode 及 ppt-chat/ppt-notes/ppt-image/ppt-math/pptx-importer）

#### PPT 生成与入口（PPTAdapter + ppt-generator + ppt-image） / 组1：入口与装载

- Studio「PPT 演示」入口
- 已有 PPT 笔记续编
- 旧版 HTML 幻灯片自动迁移

#### PPT 生成与入口（PPTAdapter + ppt-generator + ppt-image） / 组2：生成前配置面板

- 风格分类筛选
- 风格网格选卡（75 款风格）
- 画布尺寸选卡（8 种比例）
- 幻灯片页数滑杆（3–20 页）
- 启用 AI 配图开关
- 一键导入 PPTX 转换编辑
- 「✨ 生成 PPT」提交

#### PPT 生成与入口（PPTAdapter + ppt-generator + ppt-image） / 组3：生成过程与引擎

- 六阶段动态进度页
- 生成失败重试引导
- 基于知识库内容的生成
- 多版式自动排版
- 风格技能按需注入
- AI 自动配图流水线
- 大纲自带演讲备注

#### PPT 编辑器主界面（PPTEditor） / 组1：框架导航与状态

- 返回即保存（返回保存条）
- 画布自适应等比显示
- 底部状态栏信息
- 全局快捷键

#### PPT 编辑器主界面（PPTEditor） / 组2：缩略图栏与幻灯片管理

- 缩略图切换当前页
- 缩略图删除幻灯片
- 添加空白幻灯片
- 从模板加页（7 类版式）

#### PPT 编辑器主界面（PPTEditor） / 组3：版本历史

- 保存命名版本快照
- 版本历史面板
- 一键恢复历史版本

#### PPT 编辑器主界面（PPTEditor） / 组4：演讲稿

- AI 批量生成整套演讲稿
- 演讲稿逐页查看面板
- 从演讲稿跳转到对应页
- 演讲稿重新生成

#### PPT 编辑器主界面（PPTEditor） / 组5：对话式 AI 修改（ppt-chat 工作台）

- 对话栏发送修改指令
- AI 修改仅作用于当前页
- 对话消息记录展示

#### 顶部工具栏（EditorToolbar） / 组1：插入元素

- 插入文本框
- 插入列表
- 插入矩形
- 插入圆形
- 插入三角形
- 插入箭头
- 插入线条
- 插入图片

#### 顶部工具栏（EditorToolbar） / 组2：编辑操作

- 撤销
- 重做
- 复制选中元素
- 删除选中元素
- 上移一层 / 下移一层
- 多元素六向对齐

#### 顶部工具栏（EditorToolbar） / 组3：主题风格

- 一键换肤风格下拉

#### 顶部工具栏（EditorToolbar） / 组4：导出（📤 导出菜单）

- 导出 HTML 演示文稿
- 导出 PDF 文档
- 导出 PNG 批量图片（ZIP）
- 导出 PNG 长图
- 导出 PPTX 文件

#### 顶部工具栏（EditorToolbar） / 组5：放映与演示

- ▶️ 播放放映
- 演讲稿/版本/历史按钮常驻

#### 画布编辑交互（SlideCanvas） / 组1：选择与框选

- 点击选中与选区高亮
- Shift 加减选
- 拖拽框选批量选中
- 空白点击取消选择

#### 画布编辑交互（SlideCanvas） / 组2：元素编辑手势

- 拖拽移动元素
- 八方向缩放手柄
- 双击文本就地编辑
- 双击列表就地编辑
- Delete/Backspace 快捷删除
- 方向键微调位置

#### 画布编辑交互（SlideCanvas） / 组3：画布命令能力

- 多选对齐命令
- 层级命令（上移/下移/置顶/置底）
- 元素多样化呈现

#### 元素属性面板（PropertyPanel） / 组1：通用与多选状态

- 空状态操作引导
- 单选类型标识头部
- X/Y 位置数值编辑
- 宽/高数值编辑
- 旋转角度数值编辑
- 透明度调节
- 多选对齐分布区
- 批量删除与计数
- 层级四键（置顶/上移/下移/置底）

#### 元素属性面板（PropertyPanel） / 组2：文本元素属性

- 文本内容多行编辑
- 字体族选择（22 款字体库）
- 字号数值调整
- 行高调节
- 字距调节
- 文本圆角
- 内边距调节
- 字重常规/加粗
- 正体/斜体切换
- 下划线开关
- 水平对齐（左/中/右）
- 文字颜色（色盘+HEX）
- 文本背景色与透明

#### 元素属性面板（PropertyPanel） / 组3：列表元素属性

- 列表项逐行增删改
- 列表字体族选择
- 列表字号与行高
- 项目符号样式（4 种）
- 文字色与符号色分设

#### 元素属性面板（PropertyPanel） / 组4：形状元素属性

- 形状类型切换（6 类）
- 形状圆角
- 填充色编辑
- 边框色与边框宽度
- 线条线型（实线/虚线/点线）

#### 元素属性面板（PropertyPanel） / 组5：图片元素属性

- 本地上传图片
- 图片预览缩略
- 适应方式（cover/contain/fill）
- 图片圆角
- Alt 文本设置

#### 元素属性面板（PropertyPanel） / 组6：入场动画配置

- 入场动画效果选择
- 动画时长与延迟调节
- 动画触发方式（自动/点击）

#### 全屏放映（PresentationMode） / 组1：放映导航

- 从当前页全屏播放
- 键盘翻页
- 首末页快捷跳转
- ESC 退出放映
- 点击左右半区翻页
- 页码指示与进度条
- 悬停控制栏（◀ ▶）

#### 全屏放映（PresentationMode） / 组2：放映效果与演讲辅助

- 页面过渡动画（5 种）
- 演讲备注悬浮查看
- 元素入场动画自动播放

#### 核心数据与能力模块 / 组1：数学公式（ppt-math）

- 幻灯片内 LaTeX 公式渲染

#### 核心数据与能力模块 / 组2：PPTX 导入（pptx-importer）

- PPTX 解析为可编辑幻灯片
- 导入内容覆盖与限制

#### 核心数据与能力模块 / 组3：数据模型与资源（ppt-types / ppt-styles / ppt-templates）

- 元素化数据模型持久化
- 风格/字体/画布资源库
- 预置页面模板库

#### 核心数据与能力模块 / 组4：AI 能力引擎（ppt-chat / ppt-notes / ppt-image / ppt-generator）

- 对话修改引擎
- 演讲稿生成引擎
- AI 配图引擎
- 生成引擎整体管线

### slice09 — 文件查看器/富内容/生态市场：FileEditor/DiffViewer/InlineDiffReview/FileChangesList/rich-content 族/pdf/docx/excel/image/video/audio 专项查看器/ShikiCodeBlock；McpManager/McpMarketplace/SkillManager/PluginManager/plugin-market 下全部/zvec/ZvecGrepMarketCard/PetMarketDialog

#### 文件查看编辑与变更审查 / 组1：FileEditor 文件预览编辑器（src/components/FileEditor.tsx）

- 扩展名自适应内置预览/编辑
- 文本与代码文件编辑
- 保存修改（Ctrl+S）
- Tab 缩进与括号自动补全
- 关闭编辑器（Esc）
- 图片缩放与旋转
- PDF 内嵌阅读
- Excel 表格预览
- Word 富排版预览
- 视频与音频内联播放
- HTML 沙箱预览与源码切换
- 二进制文件用系统应用打开
- 浮窗放大浏览
- 高亮配色随主题自动切换

#### 文件查看编辑与变更审查 / 组2：DiffViewer 弹窗式 Diff（src/components/DiffViewer.tsx）

- 三种视图自由切换
- 文件名与增减统计头部
- 新旧内容上下对照视图
- 超大文件 diff 兜底
- 注记（不计叶子）

#### 文件查看编辑与变更审查 / 组3：InlineDiffReview 内嵌审批卡（src/components/InlineDiffReview.tsx）

- 对话内嵌可折叠 diff 审批卡
- Unified / Preview 视图切换
- 单文件批准 / 拒绝
- 本批全部批准
- 自定义写入指令
- 超长 diff 截断提示

#### 文件查看编辑与变更审查 / 组4：FileChangesList 轮次变更历史（src/components/FileChangesList.tsx）

- 按轮次分组的变更历史
- 展开查看变更摘要与文件清单
- 点击文件弹出 Git Diff
- 一键回滚该轮变更
- 无变更空状态引导
- 变更完成后自动刷新

#### 专项文件查看器与消息代码渲染 / 组1：PdfViewer（src/components/PdfViewer.tsx）

- PDF 原文 Canvas 渲染
- 上下页翻页导航
- 50%–300% 缩放
- 关键词搜索高亮
- 引用文本自动定位高亮

#### 专项文件查看器与消息代码渲染 / 组2：DocxViewer（src/components/DocxViewer.tsx）

- Word 富排版渲染
- 文档内容搜索高亮
- 一键复制纯文本
- 注记（不计叶子）

#### 专项文件查看器与消息代码渲染 / 组3：ExcelViewer（src/components/ExcelViewer.tsx）— 注记


#### 专项文件查看器与消息代码渲染 / 组4：AudioPlayer（src/components/AudioPlayer.tsx）— 注记


#### 专项文件查看器与消息代码渲染 / 组5：ImageGallery 图片画廊（src/components/ImageGallery.tsx）

- 全屏看图左右循环切换
- 图片计数与下载
- Esc/点遮罩关闭

#### 专项文件查看器与消息代码渲染 / 组6：VideoPlayer 视频播放器（src/components/VideoPlayer.tsx）

- 播放/暂停与进度拖拽
- 一键下载视频

#### 专项文件查看器与消息代码渲染 / 组7：ShikiCodeBlock 消息代码高亮（src/components/ShikiCodeBlock.tsx）

- VSCode 风格代码高亮
- 配色随主题/皮肤自动切换
- 加载与失败安全降级
- 注记（不计叶子）

#### rich-content 富内容渲染族（src/components/rich-content/） / 组1：RichContent 统一 Markdown 渲染器（RichContent.tsx）

- GFM 扩展 Markdown 渲染
- KaTeX 数学公式
- 段落悬停复制/引用
- 代码块语言自动分流
- 表格行列数视图
- 消息图片带框预览与全屏
- 流式纯文本降级防卡顿
- 渲染前文本智能修复
- 文件链接与安全路由

#### rich-content 富内容渲染族（src/components/rich-content/） / 组2：ContentFrame 富内容容器（ContentFrame.tsx）

- 统一头部（标题/徽标/图标）
- 一键复制内容
- 折叠/展开内容块
- 内容全屏

#### rich-content 富内容渲染族（src/components/rich-content/） / 组3：CodeBlockView 代码块视图（CodeBlockView.tsx）

- Prism 语法高亮与行号
- 长代码自动折叠
- 复制代码按钮
- 全屏代码查看
- 流式期间纯文本渲染

#### rich-content 富内容渲染族（src/components/rich-content/） / 组4：TableScrollView 表格滚动视图（TableScrollView.tsx）

- 可横向滚动表格带行列徽标

#### rich-content 富内容渲染族（src/components/rich-content/） / 组5：MermaidCanvasView 图表视图（MermaidCanvasView.tsx）

- Mermaid 图表本地渲染
- 渲染状态与错误展示
- 图表全屏查看

#### rich-content 富内容渲染族（src/components/rich-content/） / 组6：ImagePreviewView 图片预览视图（ImagePreviewView.tsx）

- 消息图片带框展示
- 点击全屏看图

#### rich-content 富内容渲染族（src/components/rich-content/） / 组7：未接线富内容组件（JsonFormatView / MathFormulaView / HtmlPreviewView / FullscreenViewer）— 注记


#### MCP 生态（McpManager / McpMarketplace） / 组1：McpManager MCP 服务器管理（src/components/McpManager.tsx）

- 服务器列表与状态总览
- 手动添加服务器
- 编辑与删除服务器
- 连接/断开单个服务器
- 一键全部连接
- JSON 批量导入配置
- 错误态可见与目录入口

#### MCP 生态（McpManager / McpMarketplace） / 组2：McpMarketplace 预设服务器目录（src/components/McpMarketplace.tsx，目录数据 src/core/mcp/mcp-registry-catalog.ts）

- 17 条预设目录浏览
- 目录搜索
- 分类筛选带计数
- 一键安装到注册表
- 需 API Key 条目配置后安装
- 已安装标记与卸载
- 条目详情对话框
- 官方文档外链

#### 技能与技能市场（SkillManager 等） / 组1：我的技能页（src/components/SkillManager.tsx）

- 「我的技能/技能市场」双页签
- 技能列表与启用开关
- 来源筛选（全部/内置/用户/外部）
- 本地技能搜索
- ZIP 安装与拖拽安装
- 同名覆盖安装确认
- 技能详情面板
- 删除技能（确认后删文件）
- 发布技能到市场

#### 技能与技能市场（SkillManager 等） / 组2：技能市场页（src/components/SkillManager.tsx + src/core/skill/skill-market-client.ts）

- 多市场源聚合浏览
- 按市场源筛选
- 本地无结果自动联网搜索
- 检查更新（30 分钟缓存）
- 一键安装市场技能
- 仓库外链与详情对话框
- 部分源失败的可见提示

#### 技能与技能市场（SkillManager 等） / 组3：SkillAutocomplete / SkillAuditDialog — 注记


#### 插件生态（PluginManager / plugin-market / zvec） / 组1：PluginManager 已安装页（src/components/PluginManager.tsx）

- 插件卡片全景
- 启用/停用开关
- 级联关闭确认与风险提示
- 依赖关系摘要与展开详情
- 搜索与动态分类过滤
- 热重载按钮
- 错误态重试启用与 toast 反馈
- 核心插件说明条

#### 插件生态（PluginManager / plugin-market / zvec） / 组2：PluginMarketTab 插件市场页（src/components/plugin-market/PluginMarketTab.tsx，目录 src/core/plugin-market/dsh-market-catalog.ts）

- dsh 官方插件目录浏览
- 兼容性诚实标注与说明
- 本地搜索与分类筛选
- bundled 条目安装/卸载（启用对应内置插件）
- 在线检索 npm 生态包
- 内嵌 zvec-grep 本地语义检索卡片

#### 插件生态（PluginManager / plugin-market / zvec） / 组3：ZvecGrepMarketCard zvec-grep 运行时卡片（src/components/zvec/ZvecGrepMarketCard.tsx，core src/core/zvec-grep/）

- 运行时安装状态展示
- 一键在线安装
- 离线 .zip 导入
- Embedding 模型可选
- 为当前项目建立/重建索引
- 卸载（删除运行时与模型）
- 操作结果/错误反馈

#### 宠物市场（PetMarketDialog，src/components/PetMarketDialog.tsx，入口 src/components/SettingsPanel.tsx 宠物设置） / 组1：宠物市场对话框

- 市场目录浏览与帧动画预览
- 搜索宠物
- 一键安装并自动激活
- 卸载宠物
- 加载失败重试
- 数据来源与已安装数展示

### slice06 — 任务中心全部：TaskCenter.tsx 与 task-center/ 下各 Tab（Overview/Delegation/Subagents/Automation/Issues/Board/Team/Squads/Inbox 与 IssueDetail 等）

#### 任务中心外壳（TaskCenter 面板框架、入口与 Tab 导航） / 组1：面板入口与开关

- 任务中心多入口打开
- 外部事件直达指定页签
- 关闭任务中心
- 界面中英双语随全局语言切换
- 底部状态栏提示委派策略

#### 任务中心外壳（TaskCenter 面板框架、入口与 Tab 导航） / 组2：Tab 导航栏

- 八页签导航自由切换
- 页签默认落在概览

#### 概览页（OverviewTab） / 组1：概览统计卡（实时聚合 + 快捷入口）

- 收件箱未读统计卡
- Issue 状态统计卡
- 委派任务统计卡
- 自动化统计卡
- 概览数据自动实时刷新

#### 概览页（OverviewTab） / 组2：最近活动时间线

- 最近活动时间线
- 活动空态提示

#### 委派页（DelegationTab） / 组1：委派监控

- 委派状态统计条
- 委派任务列表秒级自动刷新
- 任务行状态徽章与会话链路
- 委派指令内容预览
- 委派成功结果摘要
- 委派失败错误展示
- 委派空态引导

#### 子智能体页（SubagentsTab） / 组1：子智能体监控

- 子智能体统计条
- 子智能体任务实时列表
- 任务类型图标区分
- 持久智能体徽章
- 任务状态标签与相对时间
- 任务指令单行预览
- 完成结果工作量摘要
- 点击任务条联动宿主
- 子智能体空态引导

#### 自动化页（AutomationTab） / 组1：触发器管理

- 触发器列表行
- 行内启停开关即时生效
- 行内编辑触发器
- 行内删除触发器
- 添加触发器
- 停止所有引擎

#### 自动化页（AutomationTab） / 组2：触发器编辑器（新建/编辑）

- 触发器名称输入
- 触发器类型选择
- 触发消息多行输入
- 文件监听路径配置
- 定时器间隔配置
- Cron 表达式配置
- Issue 状态过滤配置
- 保存与取消编辑

#### 自动化页（AutomationTab） / 组3：触发历史与空态

- 触发历史面板
- 无触发器空态提示

#### Issues 列表页（IssuesTab + IssueCard） / 组1：Issue 列表与新建

- Issue 列表标题与新建入口
- 新建 Issue 表单
- 创建与取消按钮
- 六段状态筛选
- 点击卡片进入详情
- Issue 空态提示

#### Issues 列表页（IssuesTab + IssueCard） / 组2：Issue 卡片展示

- 卡片状态与优先级视觉
- 卡片元信息展示

#### Issue 详情面板（IssueDetailPanel） / 组1：详情浏览

- 返回列表按钮
- 完整元信息与描述正文
- 活动评论时间线

#### Issue 详情面板（IssueDetailPanel） / 组2：状态与分配操作

- 七态状态选择器一键变更
- 分配给 Squad 按钮
- Squad 选择器下拉分配
- 无可用 Squad 引导

#### Issue 详情面板（IssueDetailPanel） / 组3：评论交互

- 评论输入即发即存

#### 看板页（BoardTab） / 组1：看板视图

- 五列状态看板
- 拖拽即状态变更
- 空列占位提示
- 紧凑卡片适配看板
- 看板实时同步

#### 团队页（TeamTab = 团队模板 SquadsTab + 运行时团队 AgentTeamsPanel） / 组1：TeamTab 框架与引导

- 团队用法说明条
- 运行时团队区折叠/展开

#### 团队页（TeamTab = 团队模板 SquadsTab + 运行时团队 AgentTeamsPanel） / 组2：运行时团队活动（AgentTeamsPanel，只读监控）

- 无活动团队空态引导
- 团队头部信息
- 成员状态实时列表
- 任务看板列表
- 未读邮箱消息计数
- 实时订阅自动刷新

#### 团队页（TeamTab = 团队模板 SquadsTab + 运行时团队 AgentTeamsPanel） / 组3：团队模板管理（SquadsTab，原 Squad）

- Squad 列表与新建入口
- Squad 行摘要
- 展开/收起 Squad 详情
- 行内归档 Squad
- Squad 指令展示
- 成员列表详情
- 移除成员
- 添加成员下拉
- 新建表单-名称输入
- 新建表单-Leader 选择
- 新建表单-指令输入
- 创建与取消按钮
- Squad 空态引导

#### 收件箱页（InboxTab） / 组1：通知聚合与处理

- 收件箱标题与未读徽章
- 一键全部已读
- 七段分类筛选
- 通知条目视觉区分
- 点击通知即标记已读
- 单条归档按钮
- 收件箱空态提示
- 收件箱实时刷新

### slice07 — 知识笔记本族：NotebookManager/NotebookWorkspace/NoteEditor/NbChatPanel/SourceViewer/SourceReferences/FlashcardViewer/KnowledgeGraphView/DeliverableFiles 等

#### 笔记本管理（NotebookManager，对标 NotebookLM） / 组1：笔记本列表与组织

- 侧栏进入知识笔记本管理
- 新建笔记本
- 搜索笔记本
- 分组网格浏览与折叠展开
- 新建分组
- 删除分组
- 移动笔记本到分组
- 删除笔记本（二次确认）
- 导入 Markdown 笔记本文件
- 笔记本卡片一键开始对话
- 卡片摘要与状态一目了然
- 空库/无结果引导新建

#### 笔记本管理（NotebookManager，对标 NotebookLM） / 组2：笔记本详情与来源管理

- 详情视图返回列表
- 详情直达工作区/对话
- 行内编辑笔记本描述
- AI 笔记本摘要展示
- 添加来源（文本/文件/URL）
- 本地文件多选批量入库
- 添加并自动索引
- 来源状态徽章与错误提示
- 删除单个来源并清理
- AI 建议问题引导
- 详情页来源与块数统计

#### 三栏持久工作区（NotebookWorkspace） / 组1：布局与顶部操作

- 返回笔记本列表
- 来源/图谱视图切换
- 左右面板独立折叠
- 整本导出为 Markdown
- 引导式学习路径入口
- 闪卡入口
- Studio 生成内容菜单
- 对话会话自动持久化
- 添加来源后自动提取知识图谱
- 添加来源对话框（文本/文件/URL）

#### 三栏持久工作区（NotebookWorkspace） / 组2：来源面板（左栏）

- 勾选来源限定检索范围
- 来源行点击展开详情
- 来源详情元数据
- AI 摘要与关键话题折叠区
- 索引失败错误信息展示
- 查看来源原文
- 重新索引来源
- 删除来源
- 可折叠的笔记本摘要区
- 索引进度条实时提示

#### 三栏持久工作区（NotebookWorkspace） / 组3：笔记本对话（中栏 NbChatPanel）

- 知识问答欢迎页与建议问题
- 建议问题生成加载态
- 无来源空态引导
- 基于来源的 AI 知识问答
- 生成中一键停止
- 加载更早的历史消息
- 引用/来源点击查看原文
- 新消息自动滚动到底
- 删除回答生成的本地文件

#### 三栏持久工作区（NotebookWorkspace） / 组4：笔记面板（右栏）

- 新建笔记
- 搜索笔记
- 标签筛选栏
- 笔记卡片点击编辑
- 置顶/取消置顶笔记
- 删除笔记
- 从笔记生成闪卡
- 笔记信息与来源徽章

#### 三栏持久工作区（NotebookWorkspace） / 组5：Studio 内容生成与 PPT

- 生成「内容摘要」
- 生成「内容大纲」
- 生成「学习指南」
- 生成「常见问题 FAQ」
- 生成「事件时间线」
- 生成「简要简报」
- 生成「关键洞察」
- 生成「思维导图」
- 生成前模型能力检测
- 生成结果预览-编辑-分屏审查
- 丢弃或保存为笔记
- 从知识库生成 PPT 演示
- PPT 保存/更新为笔记
- 工具建笔记自动刷新列表

#### 三栏持久工作区（NotebookWorkspace） / 组6：学习路径弹窗

- 按依赖排序的学习路径
- 步骤点击直达
- 学习路径空态提示

#### Markdown 笔记编辑器（NoteEditor） / 组1：编辑体验

- 标题行内编辑
- 标签添加与移除
- 编辑/分屏/预览三种模式
- Markdown 快捷工具栏
- WikiLink 双链按钮
- 实时渲染预览
- 快捷保存与 Tab 缩进
- 字符与链接统计
- 导出单篇笔记 Markdown
- 预览内 WikiLink 点击跳转

#### Markdown 笔记编辑器（NoteEditor） / 组2：版本历史与链接网络

- 保存自动生成版本快照
- 版本历史面板
- 一键恢复历史版本
- 删除指定历史版本
- 出链列表点击跳转
- 反向链接列表点击跳转

#### 来源查看与引用（SourceViewer / SourceReferences） / 组1：SourceViewer 原文查看

- 弹窗逐段浏览来源原文
- 引用段落精确定位高亮
- 引用文本全文逐处高亮
- 来源内搜索过滤
- PDF 来源文本/PDF 双视图
- Word 来源文本/Word 双视图

#### 来源查看与引用（SourceViewer / SourceReferences） / 组2：SourceReferences 引用展示

- 回答尾部来源引用 chips
- 点击引用跳转原文段落
- 悬停查看引用片段

#### 闪卡学习（FlashcardViewer，SM-2 间隔重复） / 组1：闪卡管理

- 闪卡列表视图
- 按笔记隔离的闪卡范围
- 手动创建闪卡
- 删除单张闪卡
- 卡片学习状态展示

#### 闪卡学习（FlashcardViewer，SM-2 间隔重复） / 组2：复习与 AI 生成

- 到期数提示与开始复习
- 点击翻卡看答案
- SM-2 四档评分复习
- AI 批量生成闪卡

#### 知识图谱可视化（KnowledgeGraphView） / 组1：图谱载入与画布

- 自动载入或提取图谱
- 空态与提取失败重试
- 刷新重提取图谱
- 实体类型着色与图标
- 自动布局可拖拽画布
- 节点搜索高亮
- 点选节点聚焦关联网络
- 画布缩放平移与适应视图
- 小地图导航
- 图例与操作提示

#### 知识图谱可视化（KnowledgeGraphView） / 组2：节点探索与编辑

- 双击节点跳转来源原文
- 节点详情侧栏
- 关联实体列表点选跳转
- 跨来源出现统计
- 编辑节点标签
- 删除节点
- 右键节点菜单

#### 知识图谱可视化（KnowledgeGraphView） / 组3：图谱导出

- 导出图谱 JSON 数据
- 导出 PNG 快照

#### 对话轮末交付文件列表（DeliverableFiles） / 组1：交付文件摘要

- 回复尾部交付文件摘要行
- 文件状态图标区分
- 点击文件查看 diff 或打开
- 展开更多/收起文件列表
- 一键定位到工作区
- 文件变更自动刷新列表

#### 笔记本问答模式（主对话集成，App 层） / 组1：笔记本模式整合

- 笔记本模式横幅
- 保存 AI 回复为笔记
- 返回工作区快捷入口
- 退出笔记本模式
- 提问自动附加笔记本知识

