# 14 · P2-6 复用矩阵与全局 spacing 密度计划

> 基线：2026-10-26，`master` @ `569d1d2e`，版本 1.16.330。
> 这篇文档只回答两件事：P2-6 到底缺什么；spacing 密度怎么改才不会把 3454 处引用一起改坏。
> 结论以代码为准；本文不把“已有页面”写成“待建功能”。

---

## 1. 结论先行

**P2-6 不是“Codem 没有 Plugin/Skill/MCP/Agent/Task/Model 页面”。**

这些能力都已经有完整实现，而且是重的管理面：

- 插件：`PluginManager`（市场、分类、搜索、依赖、风险、免费模型卡、详情）
- 技能：`SkillManager`（我的技能 / 市场、安装、卸载、ZIP、发布、禁用、详情）
- MCP：`McpManager`（服务器增删改、连接、JSON 导入、市场）
- 智能体定义：`AgentManager`（列表 + 详情 + 编辑，含 `modelSlot`）
- 运行中的子智能体/委派：`TaskCenter`（overview/delegation/subagents/automation/issues/board/teams/inbox）
- 模型：`ModelProfilePanel`（槽位） + `ModelSelector`（会话级选择） + 设置里的模型分区

**但“已有”不等于“应该再做四张聚合页”。** 这里必须先分清“导航”和“运营”：

- **纯导航**：设置左栏能进配置；主侧栏已经能进插件、技能、MCP、智能体、任务中心。此时再做 Capabilities/Models 页面只是把同一组入口再排一遍，**没有价值**。
- **运营面**：只有跨管理器的“现在哪里坏了 / 有什么待处理 / 继续上次工作”才值得独立页面。单个管理器内部的列表、详情、安装、连接、编辑，绝不能再做一层。

因此修正后的结论：

> **P2-6 默认不建四个页面。先把深链和状态入口补到既有导航；只有当“跨域运营总览”被证明有独立价值时，才做 Home/Capabilities。Agent Hub 和 Models 页面默认取消。**

若未来确实要做，唯一站得住的聚合价值是：

1. Home：最近会话 + 继续任务 + 需要你处理的失败/审批；不是“能力目录”。
2. Capabilities：只读健康度/异常数（插件 error、MCP 连接失败、技能禁用），不是第二个管理器。
3. Agent Hub：只在“定义 vs 运行中”确实让用户迷路时做，且只做摘要 + 跳转。
4. Models：不做独立页；模型槽位编辑继续在 `ModelProfilePanel`，目录/可用性在现有模型菜单和设置里补齐即可。

---

## 2. 现有实现盘点（可复用清单）

| 能力 | 组件 / 入口 | 已经提供什么 | P2-6 怎么复用 |
|---|---|---|---|
| 插件 | `src/components/PluginManager.tsx`（41 KB，`@ts-nocheck`） | 市场/已安装、分类、搜索、依赖图、风险等级、免费模型卡、详情、级联禁用确认 | 只读 `getPluginManager().getPluginStates()` 计数/状态；卡片 `onOpenPlugins` 打开原管理器 |
| 技能 | `src/components/SkillManager.tsx`（59 KB） | `my-skills`/`market` 两 tab、安装/卸载、ZIP、在线搜索、发布、禁用、详情、删除确认 | 只读 `getSkillRegistry().getAll()` 计数；卡片 `onOpenSkills` |
| MCP | `src/components/McpManager.tsx`（18 KB） | 服务器 CRUD、连接/全部连接、JSON 导入、市场 | 只读 `getMCPRegistry().getConfigs()` 计数；卡片 `onOpenMcp` |
| 智能体定义 | `src/components/AgentManager.tsx`（24 KB） | 列表 + 详情 + 编辑、内置保护、工具 allowlist、`modelSlot` | 只读 `getAgentRegistry().getAll()`；卡片 `onOpenAgents` |
| 运行中子智能体 | `TaskCenter` 的 `subagents` tab；`AgentDetail` | 运行任务、活动、耗时、返回/详情 | `onOpenTaskCenter("subagents")` / `onOpenTaskCenter("delegation")` |
| 委派/团队/收件箱 | `TaskCenter` 的 `delegation`/`teams`/`inbox` | 委派监控、团队、未读入口 | 直接深链到既有 tab，不新建列表 |
| 模型槽位 | `src/components/ModelProfilePanel.tsx`（23 KB） | chat/subagent/memory/compaction/vision 槽位、模型/供应商/推理强度 | Models 页只读 `getModelProfileManager().getActiveProfile()`；编辑仍走原面板 |
| 会话级模型 | `ModelSelector` / ChatPanel 模型菜单 | 模型选择、免费模型可用性、角色徽标 | 不复制选择器；从 Models 页可“去聊天里切换” |
| 聊天空态 | `NewChatPage` | 欢迎、建议卡、开始对话 | Home 可复用其建议卡作为“开始”区，不复制聊天逻辑 |
| Hub 皮肤壳 | `HubLayout` | Hub 皮肤的外壳布局 | 只作为皮肤布局，不当作产品 Home |

### 2.1 关键事实

- 这些管理器都是 **独立 modal**，App 用 `showXxx` 状态打开（`App.tsx` 的 `showPluginManager` / `showSkillManager` / `showMcpManager` / `showAgentManager` / `showTaskCenter`）。
- `TaskCenter` 已经是 8 tab 的统一任务面，`delegation/subagents/teams` 都在里面；不需要再造“委派页”。
- `PluginManager` 不是简单注册表：它有依赖图、风险、市场、免费模型独立服务；任何“重新做卡片列表”都会丢这些能力。
- `SkillManager` 与 `McpManager` 各自有市场/安装/连接状态；聚合页不应直接读写它们的存储。
- `ModelProfilePanel` 已经是模型角色的唯一编辑入口；角色徽标在 ChatPanel 里已经读取同一 `ModelProfile.slots`。

---

## 3. P2-6 修正后的施工设计（默认只做深链，不建聚合页）

> **默认方案（推荐）：**
> - 在命令中心/侧栏为插件、技能、MCP、智能体、任务中心、模型档案补“打开原管理器”的深链与状态角标；
> - 不新建 Home/Capabilities/Agent Hub/Models 四个页面；
> - 现有管理器继续是唯一写入口。
>
> **仅当下面两个条件同时成立，才进入 3.2 的页面方案：**
> 1. 用户明确要一个“今天哪里需要我处理”的跨域总览；
> 2. 这个总览能拿到真实状态（插件 error、MCP 连接失败、任务等待审批、模型不可用），而不是只显示入口。
>
> 下面的 3.2 是“条件成立后的最小结构”，不是默认施工单。

### 3.0 默认方案：把“聚合”降级为深链

在现有命令中心（`SearchDialog`）增加命令项，直接调用 App 已有回调：

```text
打开插件管理      -> setShowPluginManager(true)
打开技能管理      -> setShowSkillManager(true)
打开 MCP 管理     -> setShowMcpManager(true)
打开智能体管理    -> setShowAgentManager(true)
打开任务中心      -> setTaskCenterTab("overview"); setShowTaskCenter(true)
打开任务中心/子智能体 -> setTaskCenterTab("subagents"); setShowTaskCenter(true)
打开模型档案      -> 设置 -> 模型（或直接 showModelProfiles）
```

这是真正的“聚合层”：**一个命令入口聚合多个目的地**，不复制任何页面。  
侧栏已有图标入口，命令中心补的是“键盘可发现性”；如果连这一步都不需要，就什么都不加。

### 3.0b 如果要合并：任务中心是正确落点，但不是看板

任务中心已经有：

- **Overview**：只做导航 + 关键计数（委派/自动化/Issue/收件箱），下方是 `task-center.overview` 插件槽位；
- **Inbox**：已经聚合 issue/squad/delegation/automation/**system**/agent 六类事件；
- **Board**：`IssueBoard`，按 Issue 状态分列 + 拖拽改状态，插件可接管为看板/用量/工具/错误/时间线。

因此三种聚合价值的落点是：

| 聚合价值 | 落点 | 不放在看板的原因 |
|---|---|---|
| 跨域“需要你处理”（失败委派、待审批、未读） | TaskCenter **Overview 的“需要你处理”条** + **Inbox** | 这些不是 Issue，没有 Issue 状态；看板列会失去语义 |
| 能力健康（插件 error、MCP 断开、模型不可用） | Overview 的只读健康条；有事件时进 Inbox 的 `system` 类 | 基础设施状态不是工作项；拖拽/分列没有意义 |
| 继续上次工作 | Home 或命令中心；不是任务中心 | 不是任务，也不该占 Board 列 |
| 可发现性/新手入口 | 命令中心/侧栏，不进任务中心 | 任务中心是运营面，不是导航目录 |

**结论：**

- **Board 不动**（继续只放 Issue/工作项）。
- **Overview 可以加一条“需要你处理 / 能力健康”摘要**，但必须只读、可深链、读失败显示错误。
- **Inbox 是跨域事件的自然落点**；`system` 类已经存在，补生产者/深链即可，不新建列表。
- 如果连“跨域待处理”都不需要，任务中心也不改；不要为了聚合而聚合。

### 3.1 路由与外壳（仅页面方案）

复用本轮已有的 hash 路由思路：

```text
#home
#agents
#capabilities
#models
```

- 44px `PageHeader`（返回、标题、右侧动作）。
- 内容列 max 1120；不复制 OMP 的 10 项全局 nav。
- 每个页面只读聚合数据；所有写操作跳回原管理器。
- 深链示例：
  - `openPlugins()` → `setShowPluginManager(true)`
  - `openTaskCenter("subagents")` → `setTaskCenterTab("subagents"); setShowTaskCenter(true)`
  - `openAgents()` → `setShowAgentManager(true)`
  - `openModelProfiles()` → 打开设置并定位到模型档案（需要给 SettingsPanel 增加 `initialSection`/`openModelProfiles` 的外部控制）

### 3.2 四个页面的最小结构

#### Home

```text
PageHeader(44) + [继续当前会话] [新建对话]
最近会话（listSessions，最多 5）
当前项目（currentProject）
能力概览（插件/技能/MCP/智能体 数量，全部可点）
模型概览（当前档案槽位）
```

- 数据：`useProjectStore.currentProject`、`SessionStorage.listSessions("")`、`getPluginManager().getPluginStates()`、`getSkillRegistry().getAll()`、`getMCPRegistry().getConfigs()`、`getAgentRegistry().getAll()`、`getModelProfileManager().getActiveProfile()`。
- 空态：无项目、无会话、读失败三态；读失败走 `StatusBanner`，不伪造 0。
- 不复制 `NewChatPage` 的聊天发送逻辑；建议卡只填入 Composer（复用现有 `suggestionPrompt` 路径）。

#### Agents

```text
左侧：定义列表（AgentManager 的只读摘要）
右侧：运行中（TaskCenter 的 delegation/subagents 摘要）
底部按钮：打开智能体管理 / 打开任务中心
```

- 这是“Hub”，不是第二个 AgentManager：不提供编辑、不写 registry。
- 运行任务数据用现有 `subagentTasks`/`getDelegationOrchestrator()`；无数据时明确空态。
- 点击定义 → 打开 `AgentManager`；点击运行任务 → `TaskCenter("subagents")`。

#### Capabilities

```text
四个卡：插件 / 技能 / MCP / 智能体
每卡：总数、启用数、异常数、最近变化
CTA：打开对应管理器
```

- 数据只读调用上面的 registry；任何计数异常要显示“读取失败”，不能显示 0。
- 不新增安装、连接、启用/禁用 API；全部跳原管理器。
- 可加“搜索能力”只做前端过滤，不做写。

#### Models

```text
当前档案槽位矩阵（chat/subagent/memory/compaction/vision）
模型来源摘要（免费/DeepSeek/...）
免费模型可用性摘要（可用/隐藏/未知）
CTA：打开模型档案 / 去聊天切换
```

- 只读 `ModelProfile.slots` 与 `getConfiguredApiModels()`。
- 不复制模型选择器；不写模型配置。
- 角色必须来自档案槽位；不能按名字猜。

### 3.3 不做什么（防重复造轮）

- 不新建第二套 Plugin/Skill/MCP registry。
- 不复制 PluginManager 的依赖图、风险确认、市场安装。
- 不复制 SkillManager 的安装/ZIP/发布。
- 不复制 McpManager 的连接/JSON 导入。
- 不复制 AgentManager 的编辑表单。
- 不复制 TaskCenter 的委派/团队/收件箱列表。
- 不复制 ModelProfilePanel 的槽位编辑。

### 3.4 施工顺序

1. `PageHeader` + `#home` 壳 + 最近会话/项目卡（只读）。
2. Capabilities 四卡（只读计数 + 深链）。
3. Agents Hub（定义摘要 + 运行摘要 + 深链）。
4. Models 摘要（槽位矩阵 + 深链）。
5. 统一 hash 返回栈；刷新恢复；Esc 返回。
6. 三态/窄屏/键盘截图；最后才考虑把某个管理器内嵌（当前不内嵌）。

### 3.5 验收

- 每个聚合卡的数字与打开后的管理器一致（同一次读取快照）。
- 读失败必须显示错误，不能显示 0。
- 不产生任何写请求；打开/关闭不改变 registry。
- 1600/1280/1024 三档不溢出；320 宽不横向滚动。
- 空项目/无会话/全部能力为空三态。
- 不允许出现第二套“插件列表/技能列表/MCP 列表”。

---

## 4. 全局 spacing 密度：详细改进计划

### 4.1 现状（实测）

- `--space-1..15`：2/4/6/8/10/12/14/16/20/24/28/32/40/48/64px。
- 全仓 `var(--space-N)` 引用 **3454 处**，`styles.css` 单文件 1807 处；`notebook-workspace.css` 253、`codem-ui.css` 238、`library-ops.css` 149。
- 当前 `[data-density="compact"]` **只覆盖控件高度**：
  ```css
  --control-xs: 24px;   /* 26 → 24 */
  --control-dense: 26px; /* 30 → 26 */
  --control-md: 30px;   /* 34 → 30 */
  --control-std: 34px;  /* 38 → 34 */
  --control-form: 40px; /* 44 → 40 */
  ```
- `appearance-modes.test.ts` 明确断言：**compact 不得覆盖 `--space-*`**（第 170 行）。这是现有合同，不是疏漏。
- 侧栏行高/内边距另有 `RHYTHM-1/2` 用户验收基线；不能跟着全局密度一起缩。

### 4.2 目标

1. `comfortable` 保持现状（零视觉变化）。
2. `compact` 同时缩**控件高度 + 组件内间距**，但不缩字号、不缩触控目标到 24px 以下。
3. 不改变信息架构、不改变行高语义、不把侧栏/聊天正文缩坏。
4. 切换密度只触发 CSS，不触发 React 重渲染/数据库写入。

### 4.3 方案对比

| 方案 | 做法 | 优点 | 风险 | 建议 |
|---|---|---|---|---|
| A 全局覆盖 `--space-*` | compact 里把 15 个 token 全部乘 0.9 | 一处改全仓 | 3454 处引用同时变；侧栏/正文/表格一起缩；现有测试直接红；亚像素缝隙 | **不先做** |
| B 语义密度 token | 新增 `--density-gap-*` / `--density-pad-*`，组件逐步迁移 | 可控、可截图、可回滚 | 迁移工作量大 | **推荐主线** |
| C 混合 | 内容面用 B；最终只对“非侧栏内容”全局 alias | 接近 OMP 的全局密度 | 需要 base alias 重构 | Phase 4 再评估 |

### 4.4 推荐架构（B）

保留 `--space-*` 原语不变，新增语义层：

```css
:root {
  --density-space-scale: 1;
  --density-gap-xs: calc(var(--space-1) * var(--density-space-scale));
  --density-gap-sm: calc(var(--space-2) * var(--density-space-scale));
  --density-gap-md: calc(var(--space-3) * var(--density-space-scale));
  --density-pad-sm: calc(var(--space-3) * var(--density-space-scale));
  --density-pad-md: calc(var(--space-4) * var(--density-space-scale));
}
[data-density="compact"] {
  --density-space-scale: .9;
}
```

组件从 `var(--space-3)` 迁移到 `var(--density-gap-md)` 等**语义 alias**；不直接把所有 `--space-*` 换掉。

为什么不用 `calc(var(--space-3) * .9)` 直接散写：3454 处会变成不可审计的乘法；语义层还可以以后按“列表/面板/表单”分档。

### 4.5 分阶段

#### Phase 0：基线与扫描器

- 新增 `tools/ui-audit/scan-density-tokens.mjs`：
  - 统计每个文件/选择器的 `var(--space-N)` 引用；
  - 统计硬编码 `padding/margin/gap`；
  - 输出组件归属（settings/menu/tool/list/composer）。
- 基线入库；不通过就只打印，不改代码。
- 目标：知道 3454 处里哪些属于“内容面”，哪些属于“必须保留”的侧栏/正文。

#### Phase 1：零视觉 alias 层

- 新增 `--density-*` 语义 token，`--density-space-scale: 1`。
- 只迁移 **一个试点组件**（设置面板 `.settings-content` / `.setting-group`）。
- 断言 computed 与改造前逐像素一致；`appearance-modes` 原合同保持绿（因为没覆盖 `--space-*`）。

#### Phase 2：内容面试点

- 迁移：设置面板、菜单/弹层、工具卡、任务中心内容区。
- compact 下目标：间距 -10%，控件高度已有 -4px；字号不变。
- 验收：1600/1280/1024、125%/150%、空/加载/错误三态截图；行不重叠、不横向溢出。

#### Phase 3：列表/Composer/笔记

- 迁移：会话列表、文件树、Composer chips、Notebook。
- **排除**：侧栏导航/项目头（RHYTHM-1/2）、聊天正文（阅读行高）、消息气泡。
- 每条列表行 `min-height ≥24px`；虚拟列表行高若写死，必须同步密度或禁用密度。

#### Phase 4：是否做全局 alias

只有 Phase 2/3 截图与性能都过，才评估：

- 把 `--space-N` 改成 `var(--space-N-base)`；compact 覆盖 alias；
- 必须先改 `appearance-modes` 合同并新增几何判据；
- 保留 `data-density-fixed` 白名单给侧栏/正文/命中区；
- 任何一项回归就回退到 B，不做全局。

### 4.6 判据（必须机器可判）

1. comfortable 与改造前截图像素差 ≤0.1%（只允许抗锯齿）。
2. compact 下关键容器 padding/gap 比 comfortable 小，但不为 0/负。
3. 所有可点击行 ≥24px；侧栏行仍符合 `RHYTHM-1/2`。
4. 320/768/1024/1280/1600 无横向滚动、无文字叠字。
5. `tsc/build/full` 全绿；`css-contract` 只允许预期的 alias 变化。
6. 切换密度不触发 React render：用 Profiler/计数器证明只改 `data-density`。
7. 不新增 `transition: all`；遵守现有 MOTION-1。

### 4.7 风险清单

| 风险 | 具体表现 | 处置 |
|---|---|---|
| 3454 处引用 | 缩一处，表格/侧栏/正文一起变 | B 方案 + 组件白名单 |
| 亚像素 | 2px×0.9=1.8px，边框/图标错位 | 只缩 padding/gap，不缩 border/icon；必要时 clamp 1px |
| 虚拟列表 | 行高写死，间距缩了仍按旧高度 | 先盘点 `IncrementalList`/固定 height，再决定是否随密度 |
| 侧栏用户基线 | 导航/会话被压矮 | 明确排除，保留 RHYTHM-1/2 |
| 聊天可读性 | 正文行高/段距被缩 | 明确排除，只缩外壳控件 |
| 现有合同 | `appearance-modes` 明令禁止覆盖 `--space-*` | Phase 1-3 不覆盖；Phase 4 先改合同+新判据 |
| 性能 | 动态改 CSS 变量触发全页 style recalc | 只在用户切密度时一次；不挂动画、不写 React 状态循环 |

### 4.8 交付物

- Phase 0：扫描器 + 基线报告。
- Phase 1：`--density-*` token 层 + 设置面板试点。
- Phase 2/3：组件迁移 + 三档截图 + 几何判据。
- Phase 4（可选）：全局 alias 决策报告；不做也可以停在 B。

---

## 5. 与 OMP 的对比定位

- OMP 的 density 只缩 spacing，控件高度另有一套；Codem 现在只缩控件，正好互补。
- OMP 的 Home/Agent Hub 是“列表 + 详情/卡片”，但它的底层管理面没有 Codem 这么深（依赖图、安装器、市场、风险、槽位）。
- **不要为了“像 OMP”把 Codem 的深管理面摊平成卡片**。正确做法是：上层做聚合入口，深层保留原管理器；这比 OMP 多一层“概览 → 深管理”的路径，且不丢能力。
- 密度也不要照搬 OMP 的全局 spacing 缩放：Codem 的 3454 处引用和用户验收过的侧栏决定了必须走语义层/分阶段。

---

## 6. 一句话施工结论

**P2-6：做 4 个聚合页 + 深链，复用现有 5 套管理面；不重写任何 registry。**
**Density：先做语义 alias 试点，不先全局覆盖 `--space-*`；侧栏/正文/命中区明确排除。**
