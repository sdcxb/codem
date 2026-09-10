# 任务管理 · 功能结构树与去重决策（TASK-CENTER-MAP）

> 版本：v1.15.0 ｜ 生成方式：只读遍历宿主 8 个页签 + 插件三个接管点 + 各页签实际调用的 core 读 API，
> 每个节点都带 `path:line`。用于回答两个问题：**任务管理里到底有哪些功能**、**哪些功能是重复的**。

## 一、结构总览（页签 → 拥有者）

| 宿主页签 | 拥有者 | 子视图 |
| --- | --- | --- |
| 概览 | 宿主统计卡 + 插件贡献「用量」 | 统计卡（收件箱/Issues/委派/自动化）+ `task-center.overview` slot |
| 委派 | 宿主 | 统计条 + 任务卡列表（只读） |
| 子智能体 | 插件接管（`task-center.subagents`） | 场景 \| 设置（禁用时回退宿主列表） |
| 自动化 | 宿主 | 触发器列表 + 编辑器 + 触发历史（唯一编辑入口） |
| Issues | 宿主 | 新建 + 8 态筛选 + 卡片列表 + 详情（评论/状态/指派） |
| 看板 | 插件接管（`task-center.board`） | 看板（宿主 IssueBoard）\| 工具 \| 错误 \| 时间线 |
| 团队 | 宿主 | 运行时团队（agent-teams）+ 团队模板（Squad） |
| 收件箱 | 宿主 | 未读徽标 + 7 类筛选 + 通知列表（点击穿透） |

> 三个 slot 的注册点都在宿主侧 `src/core/provider/ui-library-ops-provider.ts`；
> `src/plugins/library-ops/index.ts` 只是 re-export barrel，**不含任何 slot 注册**（排查时别找错地方）。

## 二、功能结构树（到最小叶子）

### 1. 外壳（TaskCenter.tsx）
- Portal 渲染 + 遮罩点击关闭 / 面板内 `stopPropagation`（`:110,:114`）
- 宽度双档：`wide = board | subagents | overview` → 1180px，其余 960px（`:107,:116`）
- 页签条 8 项（`:96-103`）；旧 id 归一 `squads→teams`、`library→board`（`:60-64`）
- 外部事件 `codem:open-task-center` → 切页签 + 记录 `focusIssueId`（`:79-91`）；`initialTab` 变化跟随（`:75-77`）
- 底栏：当前页签名 + **真实委派限制**（`getDelegationOrchestrator().getLimits()`，v1.15.0 起不再写死）
- 已知死分支：所有页签 `available: true`，故 `disabled / "soon"` 分支不可达（保留字段，仅渲染分支冗余）

### 2. 概览
- 4 张统计卡（`OverviewTab.tsx:144-183`）：收件箱未读 / Issues 三态 / 委派三态 / 自动化三项；点击各自跳转
- 刷新：挂载即读 + 2s 轮询 + `orchestrator.onStateChange` + `codem-automation-config-changed`
- 宿主回退「最近活动」（`:240-278`）：仅在插件未接管 slot 时渲染（委派 + 自动化 history 合成，取前 5）
- 插件贡献「用量与活动」（`LibraryOpsUsageEmbed.tsx`）：
  - OverviewPanel：状态卡 / 最近会话 / 活动概览（14 天热力图 + 类型环形 + 小时柱状）/ 团队卡 / 任务与工具卡 / 数据源与健康度 / 场景实况卡 / 6 张 KPI 卡
  - CostPanel：总 / 输入 / 输出 token、总成本、今日成本、缓存命中率、用量构成、成本趋势

### 3. 委派
- 统计条 5 项（`DelegationTab.tsx:81-100`），与列表**同源同口径**（`:52-66`）
- 任务卡：状态徽标 / 源→目标会话 / 时间 / 描述截 200 / 结果截 150 / 错误原文
- 刷新：1s 轮询 + `onStateChange`；只读（无取消/重试/删除）

### 4. 子智能体（插件接管）
- 子导航 场景 | 设置；状态条额外显示子智能体数 / 团队成员数（`LibraryOpsSceneView.tsx:56-65`）
- 场景：像素/等距画布 + 馆内花名册 + 角色详情（含**打开父会话**）+ 岗位分布
- 设置：采样间隔 / 场景风格 / 动画速度 / 最大角色数 / 名牌气泡岗位标签事件流开关 /
  场景图片卡（上传 / 内置预设 / 自动对位 / 手动对位编辑器 / 重置）/ 默认看板视图 / autoOpen / 恢复默认 / 关于
- 宿主回退列表（`SubagentsTab.tsx`）：4 项统计 + 列表（点击切父会话）

### 5. 自动化
- 触发器列表（启用 / 编辑 / 删除）+ 空态 + 添加（预填 timer 1h）
- 停止所有 / 恢复运行（模块级暂停状态，v1.14.0 修复）
- 触发历史（前 20）
- 编辑器：名称 / 类型 4 选 / 消息 / 文件路径 / 间隔 / cron 表达式 / **监听状态（7 态，表驱动）** / 保存 / 取消

### 6. Issues
- 新建表单（标题 / 描述 / 创建后强制切「全部」）/ 无项目禁用
- 8 态筛选（表驱动）/ 卡片列表 / 空态 / `onIssueChange` 订阅
- 详情：返回 / 元信息 / 描述 / 7 态状态按钮（同值不写）/ 指派 Squad / 评论列表 + 输入（Enter 发送）
- 点穿透：收件箱 → `focusIssueId` → 强制「全部」并打开详情

### 7. 看板（插件接管）
- 子导航：看板 | 工具 | 错误 | 时间线；看板视图内渲染宿主 `IssueBoard`（7 列拖拽）
- 实时事件流：默认在看板收起（可手动开），时间线视图强制关
- 工具：按事件流聚合次数/失败 + 频次排行 + 流水前 40
- 错误：5 项 KPI + 阻塞/出错角色（定位→切场景）+ 失败任务 + 错误事件 + 数据源健康
- 时间线：8 类筛选 + 全量事件（严重度着色）

### 8. 团队
- 运行时团队：成员（状态/角色）+ 任务（状态/指派/依赖/attempt）+ 未读邮箱
- 团队模板：Squad 列表（展开/归档/成员增删/Leader/指令）+ 新建编辑器

### 9. 收件箱
- 未读徽标（项目口径）/ 全部已读 / 7 类筛选 / 通知行（分类图标、已读态、相对时间、点击穿透、归档）

## 三、重复点与决策

| # | 重复能力 | 位置 | 决策 | 状态 |
| --- | --- | --- | --- | --- |
| 1 | 「用量」既是概览的一部分又是看板的一个视图 | `OverviewPanel`/`CostPanel` ↔ 看板 rail | **删除看板里的「用量」视图**，整块迁进概览（`task-center.overview`） | ✅ v1.15.0 |
| 2 | 场景 + 设置放在「看板」里（语义不符） | 看板 rail ↔ 子智能体页签 | **移到「子智能体」页签**（场景=子智能体可视化，设置=场景显示） | ✅ v1.15.0 |
| 3 | 概览「最近活动」与看板「时间线 / 实时事件流」 | `OverviewTab.RecentActivity` ↔ `TimelinePanel`/`EventList` | 概览不再重复活动明细，只留用量；宿主回退保留 | ✅ v1.15.0 |
| 4 | `selectActor` 在概览/错误面板里是**死按钮**（场景不在这两个页签） | `OverviewPanel:90,119`、`ErrorsPanel:65` | 改为 `selectActor + requestView("scene")` | ✅ v1.15.0 |
| 5 | 插件接管子智能体页签后，父会话下钻链路断裂 | `SubagentsTab.onSelectAgent` ↔ 场景 | 场景角色详情新增「打开父会话」→ `codem:open-session`（App 处理） | ✅ v1.15.0 |
| 6 | 概览里同屏出现 3 次 token/成本 | 状态卡 ↔ KPI 卡 ↔ CostPanel | 删掉状态卡里的 token/成本两行 | ✅ v1.15.0 |
| 7 | 概览手写了一份事件列表（与 `EventList` 同构） | `OverviewPanel:232-243` ↔ `EventList.tsx` | 改为复用 `EventList`（limit 8）+ 补空态 | ✅ v1.15.0 |
| 8 | Issue 状态标签/颜色 5 份各自维护（自动化漏了 backlog/todo） | IssueCard / IssueBoard / IssuesTab / IssueDetailPanel / AutomationTab | **单一元数据表** `issue-status-meta.ts`，各处只取子集 | ✅ v1.15.0 |
| 9 | 采样调度重复（概览嵌入 + 页签外壳各起一条轮询） | `useLibraryOpsSampling` 挂载点 | 改为**引用计数的共享定时器** | ✅ v1.15.0 |
| 10 | `SquadsTab` 不跟项目重查（与 P2-12 约定不一致） | `SquadsTab.tsx:23-28` | 依赖数组加入 `projectId` | ✅ v1.15.0 |
| 11 | 底栏委派限制写死「2 / 5」 | `TaskCenter.tsx:249` | 读 `orchestrator.getLimits()` | ✅ v1.15.0 |
| 12 | 死代码 `DelegationPanel.tsx`（其 `getStats()` 正是被判定为错口径的写法） | `src/components/DelegationPanel.tsx` | 删除 | ✅ v1.15.0 |
| 13 | 插件时间格式化器重复（`ErrorsPanel.clock` ≡ `labels.clockOf`） | `ErrorsPanel.tsx` | 删本地实现，用 `clockOf` | ✅ v1.15.0 |
| 14 | 看板视图清单 3 份（rail / 设置 chip / `BOARD_VIEWS`） | `LibraryOpsBoardView` / `SettingsPanel` / `types.ts` | 从 `BOARD_VIEWS` 派生（标签表仍各自维护，未合并） | ⏳ 待做 |
| 15 | 插件内 `openLibraryView()` 与 `store.requestView()` 两套同义导航 | provider ↔ store | 归一为 `requestView`（保留 `{opened:true}` 返回契约） | ⏳ 待做 |
| 16 | 「等待采样」空态 6 种措辞 | 各面板 | 抽 `<WaitingSample/>` | ⏳ 待做 |
| 17 | 收件箱未读两个口径（侧边栏全局 vs 概览/收件箱按项目） | `Sidebar.tsx:46` ↔ `InboxTab`/`OverviewTab` | **待产品确认**：统一为项目口径还是保留全局 | ⏳ 待确认 |
| 18 | 「工具调用」两套定义（`metrics.toolCalls` vs 事件流聚合，后者上限 120 条） | `OverviewPanel` ↔ `ToolsPanel` | 已把概览侧标注为「按事件流」；彻底统一需改 `ToolsPanel` 口径 | ⏳ 部分完成 |
| 19 | 团队模板角色以前会入馆占位 | 场景 actor 构造 | v1.15.0 已移除（角色只绑定队长/成员/子智能体/在途委派） | ✅ |

### 看起来重复但**确实合理**（不要动）
- `BoardTab` 的 `fallback={IssueBoard}` ↔ 插件内复用 `IssueBoard`：插件禁用回退契约（有测试专测）。
- 概览的 `RecentActivity`：slot 无贡献者时的宿主回退，不是重复实现。
- `AgentTeamsPanel` 与对话内 `AgentPanel` 各自订阅 `AgentTeamsService`：宿主容器不同（页签 vs 浮层）。
- Squad（模板，SQLite）↔ agent-teams（运行时，localStorage）：模板→运行时适配，无共享行。
- 委派 ↔ 子智能体：记录类型 / ID 空间 / 存储全不同，`orchestrator.ts` 明确分层。
- 收件箱不从 Issue 读，自动化不建 Issue：都是单向写推送（`issue.ts` → inbox/automation）。

## 四、已知功能缺口（登记，避免与「已实现」混淆）
- `IssueManager.delete()` 无任何 UI 调用；Issue 的 labels 只读。
- 收件箱的 `squad` / `agent` / `system` 三个筛选分类**无生产写入方**（永远是空的）。
- 委派历史：`getAllDelegations()` 只读内存（活跃 + 最近 200 条），DB 里更早的历史对列表类查询不可见。
- `inbox-provider.ts` / `squad-provider.ts` 调用了若干不存在的方法（被 `@ts-nocheck` 压住），
  且 `ctx.issue`/`ctx.automation`/`ctx.agentTeams` 在 `src/` 内无消费方 —— 属「注册了但坏且无人用」的死适配器。
