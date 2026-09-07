# 团队体系深合并（B 方案）实施计划 — docs/TEAM-CONSOLIDATION-PLAN.md

> 目标：把 Codem 两套"团队"（静态 Squad 模板体系 + agent-teams 运行时 DAG 团队）合并为**一套"团队=角色模板+运行时编排"**：Squad 降级为 agent-teams 的团队模板，`squad_*` 工具升级为模板/团队入口（薄桥接，不废弃），TaskCenter 单一「团队」Tab（模板+活动同视图），对话旁按钮收敛为快捷入口。最终删除旧 dispatch 路由与死码，语义完全统一。
> 决策原则：效果最优优先（不考虑工作量）；每阶段独立提交、全量测试保持绿、可回退。
> 相关背景：docs/AGENT-SYSTEMS-MATRIX.md（体系盘点）。

## 现状锚点（勘察结论，含文件:行）

- **squad（静态模板，v0.98）**：`src/core/squad/{squad,squad-storage,squad-tools,index}.ts`——`SquadManager`（getSquadManager：createSquad/listSquads/updateSquad/archiveSquad/deleteSquad/addMember/removeMember/generateSquadRoster/onSquadChange）；DB 表 `squads` + `squad_members`（storage/database.ts:649/660）；工具 `squad_list / squad_dispatch / squad_status`（squad-tools.ts；dispatch 经 `codem-squad-dispatch` CustomEvent → App.tsx:1300-1371 建 Leader 会话 executeSessionTurn 执行）；UI TaskCenter「Squads」Tab（task-center/SquadsTab.tsx）。
- **agent-teams（运行时 DAG 团队，v1.9.9）**：`src/core/agent-teams/{engine,types,tools}.ts`（纯逻辑引擎：createTeam/addMember/createTask/claimTask/updateTask/reassign/邮箱/调度/快照）+ `provider/agent-teams-service.ts`（单例：内存 Map + localStorage `codem-agent-teams:v1`；addMember→SubagentRuntime.startContinuable 可续聊成员；sendMessage 直投/邮箱；调度 kick）；10 工具 `agent_teams_*`；UI ChatPanel 右侧固定浮层 `AgentTeamsPanel`（组件含团队/成员/任务视图）。
- 委派层（`session/executor` executeSessionTurn、orchestrator）与合并**无关**，不动。

## 终局语义（效果最优）

1. **团队模板 TeamTemplate** = 原 Squad 记录（squad 表不动）：`{ name, captainRole(原 leaderAgentId), memberRoles[](原 members: 角色名/描述/provider·model), instructions, projectId }`。
2. **运行时团队** = agent-teams（队长=会话、成员=模板角色 spawn 的可续聊子 agent、任务 DAG、调度、邮箱、归档）。
3. **建队 = 从模板建**：LLM/UI 选模板 → agent-teams create（队长=当前会话）→ 按模板 addMember → createTask 派发 → 调度。
4. **squad_* 工具保留（升级语义，薄桥接）**：
   - `squad_list`：列出团队模板（措辞标注 template，行为同前）。
   - `squad_dispatch`：**按模板创建运行时团队并派发任务**（替代旧"开 Leader 会话自行编排"）——确定性调度，成员按角色执行；不再发 `codem-squad-dispatch` 事件。
   - `squad_status`：模板信息 + 可选运行时团队（team_id）状态；无 team_id 时展示从该模板派生的活动团队摘要。
5. **UI**：TaskCenter 单一「团队」Tab（模板管理 + 运行时团队活动同视图）；顶部「团队活动」按钮 = 快捷入口（打开任务管理团队 Tab）；SquadsTab 组件演进为 TeamTab（模板区 + 活动区）。
6. 清理：App `codem-squad-dispatch` 路由、旧 dispatch 死码、旧测试断言更新；squad 语义文档化。

## Phase 1 — 语义与桥接（引擎不动 agent-teams；squad 升级为模板 + squad_dispatch 接 agent-teams）

1. `core/squad/squad.ts`：类型/注释加"团队模板"语义说明；新增 `toTeamTemplate(squadId)`（返回 {name, captainRole, memberRoles, instructions} 供建队）；`generateSquadRoster` 保留（兼容引用）。
2. `core/squad/squad-tools.ts`：
   - `squad_list`：description/输出措辞加"团队模板(template)"。
   - `squad_dispatch`：execute 改为——校验模板 → `AgentTeamsService.create({name, captainSessionId: ctx.sessionId})` → 按 squad.members 逐个 `svc.addMember(teamId, {id, name: memberName, role: roleDescription, provider/model 若配置})`（失败回滚删队）→ `svc.createTask(teamId, {title: task 截断, description: task, dependencies: []})` → 输出 teamId + "已按模板建队，成员就绪，任务进入共享池（调度器按角色自动领取）"；**删除 CustomEvent 派发**。保留 ctx.sessionId 校验（队长一队一活：create 会抛"captain already leads team"→ 捕获输出引导先 delete/继续旧队）。
   - `squad_status`：参数可选 `team_id`；无 team_id → 模板信息 + 匹配活动团队摘要；有 → svc snapshot 输出（成员状态/任务状态）。
3. 依赖接线：squad-tools import AgentTeamsService（agent-teams-service 单例 getInstance）与 agent-teams/types（无需）；注意 squad 工具注册时机（setupDelegationTools）与 svc 单例可用性（模块级懒初始化即可）。
4. App.tsx `codem-squad-dispatch` 路由：Phase1 保留（无事件再发，变死路由不报错），Phase3 删除。
5. 测试：更新 `squad-integration.test.ts` 中 dispatch 相关断言（改为验证：模板存在/建队返回 teamId/错误分支）；`full-regression-smoke.test.ts` squad 段适配；新增 squad-dispatch-bridge 用例（mock svc 断言 create+addMember+createTask 调用与错误回滚）。全量保持绿。
6. 提交：`团队深合并 Phase1: Squad 升级为团队模板 + squad_dispatch 桥接 agent-teams 运行时`。

## Phase 2 — UI 收敛（TaskCenter 单一「团队」Tab）

1. 读 `AgentTeamsPanel.tsx` 结构：把其内容拆为可复用视图（团队选择 + 成员/任务/邮箱/操作），供（a）浮层（顶部按钮快捷入口用）与（b）TaskCenter 团队 Tab 共用；或 TaskCenter 团队 Tab 直接嵌入 AgentTeamsPanel（带 onClose 隐藏）——择优实现（先看组件耦合）。
2. `task-center/SquadsTab.tsx` → 升级为「团队」Tab：上部模板管理（原功能 + "从模板创建运行时团队"按钮 → svc.create+addMember，成功后切到活动区）；下部运行时团队活动（复用 AgentTeamsPanel 视图或 svc 订阅渲染：团队列表/成员/任务 DAG/发消息）。
3. TaskCenter.tsx：tab id `squads` → 更名 `teams`（label「团队 / Teams」，icon Users）——检查外部引用（initialTab/搜索元数据/跳转），兼容旧 id（保留 `squads` 别名或映射）。
4. ChatPanel 顶部「团队活动」按钮：改为打开 TaskCenter「团队」Tab（如果 Codem 的 TaskCenter 在顶部某处有入口？TaskCenter 入口在哪（顶部按钮?）——勘察后接线：按钮 onClick 打开 TaskCenter 并切 teams tab）；原浮层路径可移除或保留为"快速浮层"。效果最优：任务管理为唯一主视图；浮层保留（会话内随时看）作为快捷方式亦可——按用户"放进任务管理"意图：主入口=TaskCenter，浮层按钮可保留但标注"快速打开"。
5. 全量测试 + UI 冒烟（组件渲染测试若存在跑通）。
6. 提交：`团队深合并 Phase2: TaskCenter 单一「团队」Tab(模板+运行时活动) + 入口收敛`。

## Phase 3 — 清理与收尾

1. 删 App.tsx `codem-squad-dispatch` 监听与 handleSquadDispatch（无事件源）；清理 squad.ts 中仅旧 dispatch 使用的死码（若无引用）。
2. 测试：squad-integration / full-regression 全部对齐新语义；删除指向旧行为的断言；补模板+团队 UI 相关测试。
3. 文档：更新 AGENT-SYSTEMS-MATRIX.md（标注 B 已完成、新架构图）；CHANGELOG 加 `[Unreleased]` 段记录本次深合并；README/PG/TODO 版本历程留待下次发版并入（版本号本轮不动）。
4. 全量审计（自跑多面：注册/桥/工具/引擎侧/UI）→ 修 bug（不论新旧）→ 复跑全量 vitest/tsc/cargo 全绿 → 每项独立提交。

## 验收标准

- 心智唯一：一处「团队」概念（模板 + agent-teams 运行时）；squad_* 工具均可用且指向新语义；无 codem-squad-dispatch 事件/路由残留。
- 全量：vitest（167 文件 / 4231+ 用例）+ tsc 零错误 + cargo test 38+ 全绿；无孤儿导出/死码告警。
- 文档：矩阵 + CHANGELOG [Unreleased] 反映最终架构。

## 风险与回退

- agent-teams create 一人一队：squad_dispatch 在队长已有活动团队时抛错——工具输出引导（可复用现有队或先删）；不回退旧行为（效果最优）。
- 成员 spawn 依赖 SubagentRuntime 就绪（captain 会话可用即可，service 内已处理）；桥接失败（如 runtime 未就绪）→ 输出明确错误并回滚已建团队（svc.delete）。
- 每 Phase 独立提交 + 全量测试门槛，任何一步失败可回退该提交。
