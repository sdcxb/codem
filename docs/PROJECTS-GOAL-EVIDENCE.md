# Codem Projects 目标模式复验（2026-10-23）

## 项目

- 克隆：`.preview-shot/coordinator-lab/site-goal-r1`（基线 `a656450`，7 页 / 15 区 / 2779 功能点 / 19 张截图）
- 协调者：`1792735357369-bf2jpmkzk`
- 3 个真实模型 thread + 独立 worktree：
  - T1 `1792735369438-gi0k2a8gi`
  - T2 `1792735374643-zrp5u2esk`
  - T3 `1792735388172-nmvyexwuw`

## 真实模型并行

- 3 个 thread 同时 active=3 / limit=3，模型各自完成并写 `project_report`；
- T1：291 行需求审计，18 slice / 362 组 / 2779 叶子；
- T2：`site/README.md` 追加「## 终验记录」；
- T3：build/check(24/24)/audit(29/29)/e2e/smoke 全绿，日志落盘；
- 三个 thread 的会话日志中 `wait_for_delegation` / `delegate_to_session` 命中 **0**（thread 工具策略已隐藏）。

## gate / Overview

- `verifyProjectGates` 五项全部 `ok:true`；
- Overview：等你 0 / 运行中 0 / 待评审 0 / 已完成 3，missing evidence 0，unverified gate 0；
- 截图：`.preview-shot/coordinator-lab/logs/goal-final-clean.png`

## 冲突收口

- T1 与 T2 都改 `site/README.md` 后合并，返回：
  `合并冲突，已回滚主工作区；冲突文件: site/README.md`
- `onConflict:"worktree"` 收口成功；手工保留 T2 小节后五个 gate 重新验证仍全通过。

## 协调者上下文

- `buildSystemPromptAsync` 长度 41,674 字符；
- 含 G T1/G T3 报告、GOAL 指令、gate-check。

## 项目级自动化

- 运行中新增 timer 触发器（projectId 指向本项目）后，创建了 `🤖 GOAL 自动2` 会话并收到模型 OK；
- 修复：App 启动时无论当前有没有触发器都装配 handler，否则运行中新增首个触发器只刷新表、不会建会话（提交 `f1d345d6`）；
- 测试后触发器已删除，测试会话已清理。

## 侧栏 UI

- 项目行原来有 折叠/+ /皇冠/总览/… 五个按钮，项目名只剩 46px；
- 现在皇冠/总览收进「…」菜单，行内只保留折叠 + 名称，操作按钮 hover 叠加；
- 项目名 `codem-site-goal` 完整显示；截图 `sidebar2.png` / `goal-final-clean.png`。

## 回归

- `tsc` 0；
- 全量 `--maxWorkers=2`：**730 文件 / 8488 通过 + 17 skipped**。

## 仍未验证 / 未收口

- PR/CI 只读同步：当前项目没有真实 PR，点「同步 PR」只验证了无 PR 时不崩，未做真实 PR 状态同步；
- provider 限流/失败：已有重试与 turn-outcome 判据（测试通过），但没有在本轮强制制造真实 provider 故障；
- 删除运行中会话：本轮之前已真机验证无 FK，最新构建未重跑；
- 审批：本轮用临时 blocked 报告验证 waiting 1 → 选 B → working 1，未走 UI 按钮全链路。

## 第二轮补验（2026-10-23）

- **删除运行中会话（UI 真机）**：项目内新建 `对话 5`，发送 `ping 127.0.0.1 -n 30`，4 秒后右键删除并确认；
  - 无 `FOREIGN KEY`、无“数据保存失败”横幅；
  - thread registry 仍只有 T1/T2/T3，被删会话未留幽灵；
  - ping 子进程在命令自身 30 秒结束后退出，没有常驻孤儿（删除不会立刻杀子进程，是已知边界）。
- **PR/CI 只读同步（真实 GitHub PR）**：临时报告指向 `https://github.com/cli/cli/pull/1`，
  `syncPullRequests` 调用 `gh pr view` 返回 `state=merged`、`checks=none`，无错误；验证后已删除临时报告/thread。
- **审批 UI 全链路**：临时 blocked thread 在 Overview 显示「等你 1」；点击「B 方案」后变为「运行中 1」，
  并显示「已拍板：B 方案」；清理后恢复 `0/0/0/3`。
- **provider 失败/重试判据**：`dsh-d1-llm-failure-not-completed`、`retry-classification-capacity`、
  `retry-budget`、`app-turn-outcome-rendering` 共 30 项通过（400 不可重试不为完成、500 重试后成功、预算耗尽如实报错）。
- **全量回归**：731 文件 / 8491 通过 + 17 skipped，`tsc` 0。
- **Process**：测试结束无遗留 Edge、无 1420 残留、无 Codem 进程；app 已停止。
