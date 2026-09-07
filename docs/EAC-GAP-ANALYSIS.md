# EAC 差距分析（DSH-Desktop-EAC vs Codem）

> 分析基准：github.com/zouyuxuan122/DSH-Desktop-EAC（main 分支快照 `C:\mimo-gui\.eac-ref`，47 内置插件 + 10 皮肤）
> 方法：EAC 插件源码逐读（10 个 UI 交互插件深度报告 + side-session 专报 + 功能类自读）+ Codem 全仓 25 项功能盘点（组件/核心/provider 实证）
> 日期：2026-09-07 ｜ 判定：✅ 完整覆盖 ｜ ◐ 部分/形态不同 ｜ ✖ 缺失 ｜ ⛔ 用户决定不对标

## 结论速览

1. **Codem 覆盖面已非常广**（202 插件 + 25 项功能盘点绝大多数完整）：长输出折叠、文件变更追踪还原、PTY 终端、图片粘贴/拖放、视觉代理、自动压缩、三类市场、皮肤令牌体系、用量统计/余额 API 等均无差距。
2. **真实差距集中在 5 处**（其中 4 处 UI 交互，正是用户关注点）。
3. **皮肤不对标**（用户 2026-09-07 决定）：保持 default/hub/dream。
4. **⚠️ 团队 agent 功能（agent-teams）此前被低估为"已近似"——复核为显著差距**（用户指出；详见 E 节新增）。

---

## E2. 团队 Agent 功能（agent-teams vs Codem squad/subagent/delegation）——显著差距 ⚠️

> 复核（2026-09-07，用户指出后补做）：EAC `dsh-agent-teams`（@nanmicoder）是**成熟的多智能体团队编排**，Codem 的 squad/subagent/delegation 只覆盖其基础子集。

| 能力维度 | EAC agent-teams | Codem 现状（src/core/squad + subagent + session） | 差距 |
|---|---|---|---|
| **建队** | 当前会话 = 队长，自然语言一句话拉起团队 | SquadManager：leader 配置创建，需先注册 agent + 手工加成员 | ◐ Codem 有 squad 但无"一句话建队"协议 |
| **任务模型** | 目标拆成**带负责人 + 显式依赖**的任务；状态机（ready/blocked/running…）；**依赖未完成不能领取** | DelegationTask 是**单任务链**（pending→running→done/fail）；SubagentTask 单任务无依赖 | ✖ **无依赖任务 DAG** |
| **调度** | 共享调度器按真实 idle/ready **原子领取**就绪任务；空闲成员**自动续领** | leader 通过 squad_dispatch 手工派发 + @mention；无自动领取 | ✖ **无自动共享调度** |
| **attempt 防覆盖** | 转派撤销旧 attempt；冷重启恢复遗留；**迟到结果无法覆盖** | SubagentTask 无 attempt 概念；无防迟到覆盖 | ✖ **无 attempt 生命周期** |
| **成员通信** | 成员经**持久化邮箱**直达队友/队长，不靠队长中转 | delegation 结果经 bus 回传 source；无成员↔成员邮箱 | ✖ **无成员直达消息** |
| **模型路由** | 成员默认快照队长 provider/model/思考强度；支持异构分工 | subagent 继承默认模型；无路由快照/异构机制 | ◐ |
| **实时 UI** | Web 活动面板：分段进度 + 可折叠成员树 + **可交互 DAG** + 团队卡；结束后保留完整历史 | AgentRoster（状态列表）+ DelegationPanel（任务列表）+ SquadsTab（配置）；**无 DAG 视图** | ✖ **无 DAG 活动面板** |
| **归档/快照** | 团队结束归档完整记录（.agent-teams/ 文件持久化） | squad archive（SQLite）+ 消息持久化 | ◐ |
| **协作工具面** | 10 个协作工具（add_member/add_task/claim/report/send_message…）+ 确定性激活 | squad_list/squad_dispatch/squad_status 3 工具 | ◐ 工具面窄 |

**结论**：Codem 有 squad（leader-member 关系）+ subagent（单任务执行）+ delegation（跨会话委派）的**骨架**，但缺 EAC agent-teams 的**任务 DAG、自动调度、attempt 防覆盖、成员邮箱、DAG 活动面板**这些"让团队真正协作"的机制。要做成 Codem 插件（@codem/agent-teams）需新增：team-task 模型（依赖图）、scheduler、member mailbox、activity DAG 面板——**工作量中-大**，价值高（用户明确认可其任务与团队设计）。详细架构报告由子代理产出（.eac-analysis/agent-teams-report.md）。

---

## A. 重叠部分改进（UI 交互，按价值排序）

### A1 ✖ 消息编辑的 fork 保留语义（对标 message-rewind）
- **EAC**：hover user 消息 → 「编辑并回退」→ 编辑文本 → `sessions.fork` 到**上一完成轮** → 新会话从那里重放，**原会话保留不动**（client-only：dock 槽快照 {users,turnEnds} + MutationObserver 插按钮 + fork/open + setDraft/addImages/submit）。
- **Codem 现状**：`handleEditAndResend`（App.tsx）就地改文本 + `deleteMessagesAfter` 删除后续消息 + 原地重跑 —— **破坏原会话**；另有独立 onFork（GitFork 按钮）但**与编辑不合体**。
- **改进**：编辑弹窗加「分支并回退」选项——编辑 user 消息时可选 *保存原会话为新分支*，在新会话重放；或 hover 按钮组加"编辑并回退"。属消息操作 UI 增强。

### A2 ◐ 对话节点导航条升级（对标 navbar）
- **EAC**：右缘纵向节点串（每 user 消息一节点）：active 胶囊跟随阅读位置、悬停预览卡（244px/6 行）、滚轮切换、>11 节点滑动窗口、<2 条自动隐藏、📌 消息精选 pin（金色盘、按会话持久化）。
- **Codem**：ScrollbarMarkers 已有（可点击圆点 + in-viewport/active），但**只标 user、几何绑定非滚动容器（.messages-container 而非 .chat-body，滚动同步存疑）、无预览/滚轮/精选**。
- **改进**：①修复滚动容器绑定 bug；②hover 预览卡；③滚轮切换；④消息精选 pin（金色标 + 点击跳转）。

### A3 ✖ 输入框失焦折叠（对标 meow-smooth 子项）
- **EAC**：textarea 失焦自动折叠成一行（150ms 过渡、scrollTop 恢复），点卡片任意处瞬时展开。
- **Codem**：无失焦折叠（仅手动 Maximize/Minimize 按钮，280↔480px）。
- **改进**：失焦（焦点离开整个 composer）且内容高于一行时折叠为单行胶囊，聚焦/点击展开并恢复滚动位置。纯 UI、低风险。

### A4 ◐ 输入区按钮灵动岛收纳（对标 composer-dynamic-island）
- **EAC**：输入行右侧「…」触发，悬停/点击向上展开玻璃面板（backdrop-blur 18px、translateY+scale 动画、贪心换行网格、最多 520px 宽），收纳的控件不移动 DOM（position:fixed + CSS 变量坐标瞬移），设置页逐控件勾选。
- **Codem**：InputArea 已有 showMoreActions「…」下拉菜单收纳（quick phrase/draft picker 等），无灵动岛形态、无可配置收纳项。
- **改进**（可选）：把下拉升级为向上展开的毛玻璃面板形态 + 动画（与 A3 同属 composer 体验）。价值中——Codem 按钮已少，收纳收益低于 EAC。

### A5 ◐ 完成/待办通知（对标 meow-smooth 通知子系统）
- **EAC**：审批/提问/失败/长任务完成三级通知（页内卡片 + Notification + Web Push + webhook），focus 抑制 + 去重。
- **Codem**：任务完成有 toast/横幅（App.tsx compaction 横幅等），无跨会话"有会话在等待你"聚合通知。
- 价值中，可做轻量版（页内 + 系统通知聚合）。

## B. 新功能剥离为可启用插件（Codem 没有的）

### B1 ✖ 临时会话 side-session（推荐首做）
- **功能**：基于**当前主会话上下文 + agent 触及文件**，在独立页内悬浮窗发起**不污染主会话**的临时追问（Codex side session 语义）。
- **EAC 细节**：悬浮窗可拖拽/缩放手柄；Ctrl+Shift+S / footer 💬 / `/side-session` 唤起；上下文三档（120 条/40K ｜ 600 条/200K ｜ 5000 条/2M）；三引擎（直连/自带 key/跟随主对话模型）；主对话变化事件缓存失效 + 2s 轮询；隐藏暂停轮询。
- **Codem 差距**：只有 fork（新会话复制）、delegate_to_session（后台执行）、subagent（委派）——**无"轻量临时侧聊"概念**。
- **做成插件**：@codem/side-session（注册 side-session 悬浮窗 + /side-session 命令 + footer/sidebar 入口 + 设置节：上下文档位/引擎/动画时长）。复用现有 llm engine + 会话存储，**悬浮窗为页内 position:fixed**（无需 OS 窗口，避免 Tauri IPC 复杂度）。

### B2 ✖ 人设卡管理 soul-md（推荐）
- **功能**：把一份 markdown 人设文件渲染为系统提示词段落（全局 prompt 层，所有 agent 可见）；多张人设卡保存/应用/删除；文件变更热重载；支持 {{model}}/{{cwd}} 变量。
- **Codem 差距**：SOUL.md 合并实现是**孤儿代码**（config/loader merged prompt 全仓无调用方，主 prompt 未注入 SOUL）；persona-provider 是占位无消费者。即"人设"能力**声明有、实际没接入主提示词**。
- **做成插件**：@codem/persona（修复：把 persona 段落真正接入 buildSystemPromptAsync 主链路）+ 设置页人设卡管理 UI（保存/应用/删除/热重载，多张卡 + 文件路径模式）。

### B3 ◐ 常驻余额挂件 whale-widget（可选）
- **功能**：右下角常驻小鲸鱼：余额/今日已用/每轮消耗，60s 自动刷新、点击刷新、拖拽吸附。
- **Codem 差距**：余额 API 已有（ContextMonitor fetchDeepSeekBalance）但藏在手动打开的浮层；UsageStats 面板有费用卡。**无常驻挂件**。
- **做成插件**：@codem/balance-widget（右下角悬浮小部件，克制版：余额 + 今日费用，点击展开详情）。默认关闭，经 PluginManager 启用。

### B4 ◐ 配置级快照/回滚 undo-savepoint（可选）
- **Codem**：snapshot 是**文件级**（write/edit/bash 前自动快照），配置分层设置（LayeredSettingsPanel）无撤销。
- **做成插件**：@codem/config-undo（设置修改前自动快照 settings JSON + 一键回滚到上一版）。价值中——配置是 SQLite 而非 EAC 的 yaml 文件，需适配。

### B5 ◐ 峰谷价格提醒 offpeak（可选）
- DeepSeek 工作日高峰 9-12/14-18 提醒 + 谷价提示；依赖官方峰谷价表。轻量（现有 cost-tracker 数据）。默认关闭。

## C. 判定为"不对标/无差距"的项（存档）

| EAC 功能 | 结论 |
|---|---|
| 10 款皮肤 | ⛔ 用户决定不对标（保持 default/hub/dream） |
| conversation-tweaks 长输出折叠 | ✅ Codem MessageBubble 已有（>1500 字符/400px 自动折叠） |
| 文件变更追踪与还原 | ✅ FileChangesList + DiffViewer + git apply --reverse |
| 会话内终端 | ✅ Codem Rust PTY（比 EAC 管道 shell 更强） |
| 拖放/粘贴图片 | ✅ InputArea onDrop/handlePaste + vision 管线 |
| 自动压缩 | ✅ compaction 全套（0.8 阈值/手动/折叠摘要） |
| better-sidebar（VSCode 右栏） | ⛔ Codem RightSidebar 有意精简为 Files+Browser，不复制 |
| float-window（会话 OS 弹窗） | ◐ 工作量大且依赖 preload 桥；页内悬浮窗（B1）已覆盖主要价值 |
| web-mobile-fix / viewport-lock | ◐ 桌面 WebView 布局不同，需实证 Codem 是否真有双滚动条问题 |
| raw-html（VCP HTML 卡片渲染） | ◐ 玩法向，暂不实施 |
| agent-teams（多智能体） | ✖ **显著差距，见 E2**（Codem 有 squad/subagent/delegation 骨架；缺任务 DAG/自动调度/attempt/成员邮箱/DAG 面板） |
| 桌宠 pet/dafeiyu | ◐ Codem PetSprite/PetWindowApp/市场已有 |
| openclaw（微信桥）/ phone / computer-user | ⛔ 外部依赖大，不实施 |

## D. 顺带可修的 Codem 自身缺陷（盘点中发现）

1. ScrollbarMarkers 几何绑定 `.messages-container`（不滚）而非 `.chat-body`（滚）→ 修复
2. fontSize 滑杆"只存不生效"（SettingsPanel L947-984 写入 codem-settings，无消费方）→ 接入 CSS 变量
3. 设置面板搜索框占位不工作（settingsSearch 无过滤逻辑）→ 实现或移除
4. `/compact` 斜杠命令注册了但 App 未消费（不生效）→ 接入
5. DeliverableFiles chip 事件名 `codem-open-file`（连字符）与 App 监听 `codem:open-file`（冒号）不匹配 → 修复
6. 死代码清单（MessageActions/ModelSelector/SkillAutocomplete/RegenerateModelPopover/ActivityTimeline/ConversationSession 等定义无渲染点）→ 清理或接活

---

## 建议实施批次

- **批次 1（✅ 已实施 2026-09-07，commit 2ac440d）**：A1 fork 语义编辑回退（MessageBubble「编辑并回退」+ App handleEditAndRewind + 数据层 4 测试）｜ A2 节点导航升级（ScrollbarMarkers v2：滚动容器修复 + portal 定位 + hover 预览 + 滚轮切换 + 📌 精选 pin per-session）+ nav-pins 模块 4 测试 ｜ A3 输入框失焦折叠（InputArea blurFolded，meow-smooth 式）｜ D1 字号滑杆真正生效（--ui-font-scale 缩放全字号刻度 + 启动/设置恢复）｜ D2 设置搜索可用（跳转分组 + 匹配提示）
- **批次 2a（✅ 已实施，commit 5b3318d）**：B2 persona 人设卡插件 —— 持久化卡 CRUD + 设置「人设」tab 管理 UI（PersonaManager）+ # Persona 段注入主 prompt（buildPersonaPromptAsync）+ 文件模式热重载（soul.md 风格）+ provider 持久化化改造（修复孤儿代码缺陷）；7 测试
- **批次 2b（✅ 已实施，commit d897b27）**：B1 side-session 临时会话插件 —— core/side-session（上下文窗口收集 + LLM 消息组装，纯逻辑 5 测试）+ SideSessionPanel（页内 fixed 悬浮窗：可拖拽、基于当前会话最近消息 + cwd、provider.stream 流式问答、不写主会话 store/DB）+ ChatPanel header 入口按钮。**留待增强**：Ctrl+Shift+S 快捷键 / 斜杠命令 / 上下文三档 / 设置节（MVP 已覆盖核心价值）
- **批次 3（✅ 已实施）**：@codem/agent-teams 团队编排插件 —— 引擎 `src/core/agent-teams/{types,engine}.ts`（任务 DAG 状态机 pending→claimed→in_progress→terminal + 依赖满足判定 + attempt 令牌防覆盖 + 转派撤销/静默/新代 + 邮箱租赁，16 测试）｜ 服务层 `src/core/provider/agent-teams-service.ts`（单例 + localStorage 持久化 + 成员 spawn 桥接 SubagentRuntime 可续聊子 agent + 派活/回滚 + 订阅，6 测试）｜ 10 个 agent_teams_* 工具（`src/core/agent-teams/tools.ts`，队长/成员授权经 sessionId 判定）｜ 活动面板 `src/components/AgentTeamsPanel.tsx`（ChatPanel header 入口：成员/任务/依赖/未读）｜ 注册：runtimePluginList + builtin-registry + codem.base.yml（可启停）。用法：对助手说"建一个团队，分别做 X/Y/Z，最后汇总"即可触发。**范围说明**：成员=可续聊子 agent（Codem 已有），调度为创建/更新任务时 kick（事件驱动），attempt 语义与邮箱完整；冷恢复跨进程与 EAC 相同受 park 表限制（Codem 单进程内一致）。

> 工作文档：`docs/EAC-BENCHMARK-NOTES.md`（EAC 机制笔记）、`.eac-analysis/*`（子代理深度报告，不入库）
