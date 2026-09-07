# Codem 子智能体 / 团队体系盘点矩阵（对标 EAC 审计）

> 版本：v1.10.0（2026-09-07）· 用途：厘清"顶部子智能体按钮 / TaskCenter 任务管理 / agent-teams 团队活动 / Squad / 委派"几套体系的关系、能力与重叠，供产品布局决策（是否把团队功能收敛进任务管理）。
> 所有结论来自当前工作树源码与 `.eac-ref/DSH-Desktop-EAC-main` 快照，均为只读核实；标注"待核"处为快照内未见明确证据。

---

## 1. 体系全景（按"个体 → 组织"分层）

| # | 体系 | UI 入口（现状） | 引擎 / 存储 | 生命周期 | 对标 |
|---|------|----------------|-------------|----------|------|
| 1 | **Agent 定义**（角色模板） | 设置 → 高级 → 智能体（`AgentManager.tsx`，advancedSubTab `agents`） | `core/agent/agent` AgentRegistry（agent 定义：build/plan…，含人格/系统提示） | 静态注册，随会话/项目选用 | DSH agent 定义 |
| 2 | **子智能体运行时**（个体执行） | 对话顶部「子智能体」按钮（`AgentPanel`/`AgentDetail`，SubagentTask 列表）+ TaskCenter「子智能体」Tab（`SubagentsTab` 复用 AgentPanel 逻辑） | `core/subagent/` SubagentRuntime（DSH 风格持续后台 agent；fork/spawn providers；事件流） | 任务型：spawn→运行→结果/持续待命；进程内 | DSH `ctx.subagents` |
| 3 | **委派**（跨会话并行） | TaskCenter「委派」Tab + 收件箱（Inbox 通知/未读） | `core/session/` orchestrator + executor（`executeSessionTurn` 后台回合，DB 落库） | 一次性委派任务，目标会话执行，结果回填 | DSH delegation/issue 类 |
| 4 | **Squad**（静态团队模板） | TaskCenter「Squads」Tab（`SquadsTab`：建 squad=名称+leader+成员+指令+归档） | `core/squad/` squad-manager；dispatch 事件路由（App `codem-squad-dispatch` → Leader 会话） | 静态配置为主 + 运行时 dispatch 触发 | 疑似对标 EAC/DSH 某 squad 形态（快照未逐一对上，待核） |
| 5 | **agent-teams**（运行时 DAG 团队） | 对话顶部「团队活动」按钮 → 右侧浮动 `AgentTeamsPanel`（fixed 400px 浮层） | `core/agent-teams/` engine（队长=当前会话、成员=可续聊子 agent、带依赖任务 DAG、邮箱、共享调度、attempt 防覆盖）+ 10 工具 | 会话内动态建队→执行→汇总→删除；状态落 `<workspace>/.agent-teams` | EAC 上游 @nanmicoder/dsh-agent-teams（Harness 会话内团队插件） |

**LLM 工具全集（按体系）**
- 子智能体运行时：`subagent` / `send_message` / `interrupt_agent` / `list_agents`（v1.6.0 新增；注册形态各异，按 changelog 记录）
- 委派：`delegate_to_session` / `wait_for_delegation` / `query_session_result`
- Squad：`squad_dispatch` / `squad_list` / `squad_status`
- agent-teams（10，defer 注册）：`agent_teams_create` / `add_member` / `remove_member` / `create_task` / `update_task` / `claim_task` / `reassign_task` / `send_message` / `status` / `delete`

---

## 2. 能力矩阵（行 = 能力）

| 能力 | ①子智能体运行时 | ③委派 | ④Squad | ⑤agent-teams |
|------|:---:|:---:|:---:|:---:|
| 按角色建队（多角色并存） | ✗（单 agent） | ✗ | ✅（leader+成员） | ✅（队长+成员，角色可续聊） |
| 成员=可续聊子 agent | 部分（持续后台 agent） | ✗（目标会话） | 部分（dispatch 到 agent） | ✅（durable members） |
| 任务带依赖（DAG） | ✗ | ✗ | ✗ | ✅ |
| 自动共享调度（空闲即领取） | ✗ | ✗ | 部分（dispatch） | ✅ |
| 成员间直达消息（邮箱） | ✗ | ✗ | ✗ | ✅ |
| 跨会话执行 | ✗ | ✅ | 部分 | ✅（成员为子 agent） |
| 结果汇总/团队归档 | ✗ | 回填 | ✗ | ✅ |
| LLM 自然语言驱动建队 | ✗ | 部分 | ✗ | ✅（队长协议进 system prompt） |
| 实时活动面板（成员/任务/依赖） | 个体列表 | 委派列表 | 配置列表 | ✅ DAG 活动面板 |
| 持久化 | 会话内 | DB（sessions/messages） | DB（squads 表） | `.agent-teams/` 目录 |

结论：**④ Squad 与 ⑤ agent-teams 功能重叠度最高**（都能"按角色分工执行任务"），但 Squad 是静态配置 + dispatch、无依赖任务/无成员邮箱/无自动调度；agent-teams 是完整运行时编排。①②③ 与 ⑤ 是"个体/并行/组织"的分层关系，非重复实现。

---

## 3. 与 EAC / DSH 上游对照（基于快照，只读）

| Codem | EAC 快照（DSH-Desktop-EAC-main） | 关系 |
|---|---|---|
| SubagentRuntime（顶部「子智能体」） | Harness `ctx.subagents`（会话/后台 agent） | 同构（v1.6.0 已对标实现） |
| agent-teams（对话旁浮动面板） | `plugins/dsh-agent-teams`（@nanmicoder，会话内团队插件，活动面板=对话旁可拖拽浮动层，README_ZH 明示"会话成为队长…实时 Web UI"） | **同源移植**——EAC 的团队功能本来就在"对话旁"，不在任务管理 Tab（README/ui.png/源码 `position:absolute` 浮动 panel 可证） |
| TaskCenter 任务管理（Squads/委派/子智能体 Tab） | DSH 发行版另有 task/issue/squad 类管理面板（本快照未逐一对上号，待核） | Codem v0.98 自研归拢，非直接移植 dsh-agent-teams |

> 用户印象"EAC 团队功能在任务管理里、建不同角色执行任务"更接近 **④ Squad/任务管理形态**（Codem TaskCenter-Squads 或 DSH 发行版其它面板），而 **EAC 仓库里的 dsh-agent-teams 实为对话旁浮动面板**。两者在用户视角都叫"团队/角色分工"，易混。

---

## 4. 真实现状问题（为何需要收敛）

1. **两套"团队"并行且语义重叠**：Squad（TaskCenter）vs agent-teams（对话旁），入口分居、引擎不通。
2. **个体子智能体三入口同源**：顶部按钮、TaskCenter「子智能体」Tab、设置 AgentManager——都是同一运行时的不同视图，命名不一致造成"三套"错觉。
3. **agent-teams 入口在对话旁固定浮层**：无任务管理内视图；团队运行中切走会话即看不到（EAC 上游是浮层可拖拽，Codem 是固定右栏，均属"对话旁"，但无任务管理汇总）。
4. 命名杂：子智能体 / 委派 / Squads / 团队活动 / AgentManager / 智能体，缺乏统一信息架构说明。

---

## 5. 治理方案（待决策，未实施）

**方案 A（推荐，UI 层收敛，引擎不动）**：agent-teams 进入任务管理
- TaskCenter 新增「团队」Tab（或复用 SquadsTab 升级为双视图：静态 Squad 模板 + 动态 agent-teams 活动），复用 `AgentTeamsPanel` 组件与 `core/agent-teams` 服务，展示运行时团队/成员/任务 DAG/历史。
- 对话顶部按钮保留，但语义改为"快速打开团队活动"（仍浮层或跳转任务管理团队 Tab，二选一）。
- TaskCenter「Squads」标注为"旧静态模板（v0.98）"，文案引导动态团队用 agent-teams。
- 影响面：TaskCenter.tsx + 新 TeamTab 组件（复用 AgentTeamsPanel 内部视图）+ ChatPanel 按钮跳转；`core/agent-teams` 引擎/工具/持久化零改动。工作量：中（1~2 人日）。

**方案 B（深合并，单引擎）**：静态 Squad 并入 agent-teams 运行时
- `squad_*` 工具/`squad-manager` 迁移为 agent-teams 的配置入口（Squad 模板 → 预置角色集，建队时引用），任务管理 SquadsTab 改管理 agent-teams 团队模板。
- 影响面：core/squad 废弃或桥接 + 工具迁移 + TaskCenter 改造 + 相关测试改造；风险高（v0.98 Squad 有存量使用者）。工作量：大（分阶段 3~5 人日）。

**方案 C（维持现状）**：仅补文档/入口区分（本矩阵 + 各入口一句话说明），不做代码改动。

---

## 6. 主要证据文件（可复核）

- 顶部按钮/面板：`src/components/ChatPanel.tsx`（539/570 互斥 toggle；1003 AgentPanel 浮层、1051 AgentTeamsPanel 浮层）
- agent-teams：`src/core/agent-teams/engine.ts`、`tools.ts`、`src/components/AgentTeamsPanel.tsx`
- Squad：`src/core/squad/`、`src/components/task-center/SquadsTab.tsx`、TaskCenter.tsx tabs（40-48）
- 委派：`src/core/session/executor.ts`（executeSessionTurn）、`orchestrator.ts`
- 子智能体运行时：`src/core/subagent/`（runtime/index/fork/spawn providers）、`AgentPanel.tsx`
- EAC 上游：`.eac-ref/DSH-Desktop-EAC-main/dsh-desktop/assets/plugins/dsh-agent-teams/README_ZH.md`、`lib/index.js`（会话内 + system prompt 协议）、`lib/client.js`（浮动活动面板样式）
