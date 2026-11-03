# 任务委派：实现 Codem 长程目标模式（Long-horizon Goal Mode）

> 把本文件交给下一个对话执行。先读仓库规则与设计文档，再动手。

## 0. 仓库与基线

- 仓库：`C:\mimo-gui`（Windows / PowerShell，Node 24，Rust/Tauri）
- 当前版本：**1.17.0**，已发布 GitHub Release `v1.17.0`（Latest）
- HEAD：`f178133a docs: finalize v1.17.0 release baseline`（`master`）
- 工作区：干净；仅 `.codem/` 运行时文件未跟踪
- 基线：`npx tsc --noEmit` 0 错误；全量 `npx vitest run` = **865 文件 / 9449 用例（9432 通过、17 skipped、0 失败）**
- 不要重新发版；本任务完成前不要 commit/push/改版本号/动 `docs/releases`，除非用户明确要求

## 1. 必读（按顺序）

1. `AGENTS.md`（硬规则；尤其 §5 开发纪律）
2. `docs/project-guide/00-AGENT-HANDBOOK.md`
3. **`docs/architecture/GOAL-MODE-PLAN.md`（本次唯一设计依据）**
4. `docs/architecture/AUTONOMY-PLAN.md`（已被取代；只保留 run-scoped 子集，不要按它的有限预算实现）
5. `docs/architecture/ANALYSIS-CONTINUATION-AND-COMPACTION.md`
6. `docs/architecture/WORK-QUEUE.md`
7. 代码：`src/core/llm/agentic-loop.ts`、`src/core/session/executor.ts`、`src/core/storage/`、`packages/ui/src/`、`packages/protocol/src/index.ts`

## 2. 用户目标（原话含义）

- 用户只给**意图与原则**；系统深度分析后自行得出最佳决策，**尽量不让用户逐步参与**。
- 接受“目标模式”，但**只接受长程里程碑目标**；禁止 DSH 式“每轮临时定短目标、后一轮推翻前一轮、拆出无意义微步”。
- **预算可以不设**：用户预算充足时不因 token/时间/轮数停止；可选手动上限。
- 目标要稳定、可验收、可恢复；用户只在审批/不可逆/真正歧义/目标阻塞时被打断。

## 3. 已确定的设计决策（不要重新发明）

1. **目标契约稳定**：statement / principles / nonGoals / acceptance / constraints；模型不能自行改；用户改意图才可变。
2. **深规划一次，只读**：规划阶段可读代码/文档/跑只读检查，**禁止写文件**；产出 3–12 个里程碑阶段。
3. **按结果拆，不按动作拆**：每个 phase 必须有 `outcome + acceptance + dependsOn + risks`；拒绝“读文件/跑测试”型 phase。
4. **阶段门禁靠证据**：Goal Runner 执行确定性验收；模型自述“完成”不算。
5. **阶段内自由，阶段间稳定**：实现路径可换，phase outcome/acceptance 不随意改。
6. **重规划受控**：只在证据推翻假设/验收不可达/违反不变式/连续失败/用户改目标时；版本化、记录原因、保留已完成阶段（缺陷用 rework 阶段，不删除历史）。
7. **预算默认 unlimited**：不因 token/时间/轮数停止；只按目标完成/审批/歧义/无进展/连续失败/用户停止结束；可选 `capped`。
8. **目标持久化**：一个会话最多一个 active goal；默认打开会话自动恢复；已完成阶段不重跑。
9. **默认行为**：多阶段任务自动进入 Goal 模式；单阶段走 run 自主；纯问答不建目标。
10. **默认阈值**：阶段 3–12；阶段内重试 3 次；重规划上限 5 次；阶段连续无进展 3 次停止/重规划。
11. **用户界面**：没有默认“继续”按钮；显示“目标执行中 · 阶段 2/5”；审批通过后自动继续；可停止/暂停/改目标。
12. **规则变更**：`AGENTS.md` §5.9 从“禁止目标模式/自动续跑”改为“禁止短步/无约束目标模式；允许长程里程碑目标模式（硬契约、阶段验收、受控重规划、可停止）”。先写 ADR（建议 `ADR-0006-LONG-HORIZON-GOAL.md`）与规则，再写代码。

## 4. 实现范围（分阶段，不许跳步）

### G0 规则与骨架

- 新增 ADR-0006，改 `AGENTS.md` §5.9；
- 设置项：`goalMode: auto|off`（默认 auto）、`resumeOnOpen`（默认 true）、`budget: unlimited|capped`（默认 unlimited）；
- 先写判据（红），再实现。

### G1 契约/计划/存储/校验

- 新目录 `src/core/goal/`：
  - `types.ts`：GoalContract / GoalPlan / Phase / Acceptance / Evidence / Decision
  - `plan-validate.ts`：结果导向、验收、覆盖、DAG、粒度、重复检查
  - `planner.ts`：只读深规划（复用现有模型/工具，但禁写）
  - `store.ts`：SQLite schema + 迁移（goals / goal_plans / goal_phases / goal_evidence / goal_decisions）
- 计划校验失败必须重写，不能把动作型 phase 硬塞进去。

### G2 Goal Runner

- `runner.ts`：
  - 创建 goal → planner → 校验 → phase 1；
  - 每阶段复用 **现有 `executeSessionTurn`**（禁止新建第二套 Agent 循环）；
  - 阶段门禁执行 acceptance；失败重试；连续失败触发重规划/blocked；
  - 阶段完成自动下一阶段；用户停止/暂停；
  - `budget=unlimited` 不做 token/time/round 停止。

### G3 重规划/持久化/恢复

- 触发白名单 + 禁止清单；
- 计划版本 diff、reason/evidence、已完成阶段不可删；
- 重启后恢复 active goal，标记 interrupted，已完成阶段不重跑；
- 不恢复正在执行的工具进程。

### G4 UI/事件

- 协议/共享 UI：`goal.status` / `goal.phase` / `goal.evidence` / `goal.replanned` / `goal.blocked`；
- 桌面 + 手机：目标状态条、计划/证据/决策面板、停止/暂停/改目标；
- 删除默认“每轮继续”路径；审批通过自动继续；
- 完成报告：做了什么、证据、未做/风险。

### G5 真机/长任务调参

- 至少一个真实多阶段编码任务跑通：计划 → 阶段 1..N → 验收 → 完成；
- 验证无预算不中断、无进展会停、重规划有证据、重启恢复；
- 调阶段粒度/阈值，记录数据。

### G6（可选/后续）

- Android 本机 Host / 远程网关的 goal 模式移植；桌面先闭环，不要把“只做桌面”说成全平台完成。

## 5. 硬约束

- **不新建第二套 Agent 循环**：Goal Runner 只调度，阶段执行走 `executeSessionTurn`。
- **不自动批准**：审批/不可逆动作仍由用户决定；批准后自动继续。
- **不无证据重规划**；已完成阶段不可删除/改写。
- **不把预算当默认停止条件**（unlimited 默认）。
- **目标上下文不能只靠对话历史**：每轮固定注入契约/计划/当前阶段/验收/证据摘要，压缩不丢。
- **单会话单 active goal**；不建跨会话全局目标。
- **不要用 DSH 的 goal mode/自动续跑执行这个开发任务**；用 `todo_write` 管理本轮工作，禁止 `create_goal`/自动续跑。
- 测试先行 + 变异自证；每个判据要能改坏实现变红。
- 未经用户明确要求：不 commit/push、不改版本号、不动 `docs/releases`。

## 6. 验收判据（至少）

GOAL-1 多阶段自动建目标；单阶段/问答不建；GOAL-2 规划只读且计划通过校验；GOAL-3 拒绝动作型 phase；GOAL-4 阶段门禁以证据为准；GOAL-5 阶段自动推进；GOAL-6 阶段内无 tool call 且验收未达 → 自动继续；GOAL-7 连续 3 次无进展停止/重规划；GOAL-8 重规划仅白名单触发、版本化、保留已完成；GOAL-9 契约变更需用户确认；GOAL-10 重启恢复且不重跑已完成；GOAL-11 unlimited 不因 token/时间/轮数停止，capped 达限暂停；GOAL-12 压缩后 goal context 仍在；GOAL-13 审批暂停/批准自动继续；GOAL-14 用户停止立即暂停；GOAL-15 计划/证据/重规划可审计。

全量门禁：`npx tsc --noEmit`、`npm run typecheck:ui`、`npx tsc -p packages/host/tsconfig.json`、`npx vitest run`、knip/可达性/audit:docs。

## 7. 开始步骤（给下一个对话）

1. 读 §1 文档，确认 HEAD/工作区/测试基线；
2. 先写 ADR-0006 + 改 `AGENTS.md` §5.9（规则先行）；
3. 写 GOAL-1..15 的失败判据；
4. G1 类型/校验/存储 → G2 runner → G3 重规划/恢复 → G4 UI → G5 真机；
5. 每阶段汇报：改了什么、判据结果、剩余风险；遇到真正阻塞（硬件/产品取舍）再问用户。

## 8. 汇报格式

- 当前阶段（G0..G6）
- 已完成/未完成
- 判据与全量门禁结果
- 关键设计偏差（若有）
- 需要用户拍板的事项（仅限真正无法自行决定的）
