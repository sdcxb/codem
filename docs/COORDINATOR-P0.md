# 协调者 P0：项目状态 + 报告契约 + 协调者会话

> 2026-10-22 开工。目标不是把 Claude Projects 照抄进来，而是先落地「协调者不靠聊天记录活」的最小闭环。

## 已实现

### 1. 项目状态落盘

目录：`<project>/.codem/project/`（已加入 `.gitignore`，属于本机运行态）

| 文件 | 内容 |
|---|---|
| `state.json` | `coordinatorSessionId` + thread registry（sessionId/标题/状态/worktree/最后报告） |
| `brief.md` | 项目目标/约束/验收；协调者每次重建都读 |
| `gates.json` | 验收门禁（id/标题/passed/verified_by/evidence_ref） |
| `events.jsonl` | 追加事件（coordinator 分配、report 写入） |
| `reports/<id>.json` | thread 报告（v3.1） |

实现：`src/core/project/coordinator/storage.ts`。所有读写带 `workspace: projectPath`，走既有沙箱判定；文件可人工打开/修改。

### 2. 报告契约 v3.1

`report-contract.ts`：

- 顶层白名单（未知字段拒绝）；
- `summary` ≤300 字符；
- `done` 必须带 `evidence: [{kind:"log", ref}]`；
- `passed: true` 的 gate 必须 `verified_by: "command"` 且带 `evidence_ref`；
- `blocked` 必须给 `question/options(≥2)/default`；
- 校验失败**不写任何东西**。

### 3. project_report 工具

- thread 通过 `project_report` 写 v3.1 报告，工具把 `thread_id` 固定为当前会话；
- 报告里的 log/file 证据如果只在 worktree，工具会复制到主工作区 `.codem/evidence/<threadId>/` 并改写 ref；
- 主工作区用 `git --git-common-dir` 解析，worktree 里也不会写错地方。

### 4. gate 重验与项目记忆索引（P2）

- 报告 gate 新增可选 `command`；`verifyProjectGates` 对每 thread 最新报告的 `passed=true` gate 独立重跑；
- 没有 `command` 的 gate 记为 `no-command`，**不能算 done**；Overview 显示「N 个 gate 未重验」；
- 重验是**用户显式动作**（总览弹窗「重验 gate」，会确认），不在读上下文时偷偷跑命令；
- 证据缺失从“提示”升级为 gate 失败：done 报告缺证据 → 待评审；
- 项目记忆索引 `.codem/project/MEMORY.md`：协调者上下文注入索引（≤2000 字符），正文按需读。

### 5. thread 生命周期

- 项目有协调者后，新建会话会以 `idle` 注册为 thread（协调者自身会被移除）；
- 开跑时 `working`，报告写入时按 done/blocked/failed 更新，删除会话时从 registry 移除；
- Overview 在 thread 写第一份报告前就能看到“运行中/空闲”；
- blocked 报告的 question/options/default 直接显示在「等你」分组。

### 6. PR/CI 收口（本地记录）

- 报告新增可选 `pull_request`（number/url/title/state/checks）；
- Overview 显示 PR 状态与 CI 结果；
- 这是**状态收口**，不是 GitHub 自动操作：不创建 PR、不修 CI、不自动合并。

### 7. 项目指令修复

- 发现 `.codem/instructions.md` 的加载函数全仓**零调用**，项目指令实际不进提示词；
- 已在 `buildSystemPromptAsync` 中把 project 层并入 `projectInstructions`（AGENTS.md 保留）；
- 真机：写入「项目代号：灯塔」后，协调者 prompt 36,145 字符包含该句。

### 8. 项目 Overview

- `buildProjectOverview` 四态：等你 / 运行中 / 待评审 / 已完成；
- 侧栏项目行「项目总览」打开弹窗，显示计数、thread、gate、坏报告与缺失证据；
- 坏报告不再静默：`scanReports` 返回 `{valid, invalid}`，协调者上下文与 Overview 都会显示数量。

### 5. 协调者会话

- 侧栏项目行的皇冠按钮「新建协调者对话（项目级）」→ `createCoordinatorSession()`；
- 会话标题为「协调者」，强制 `current_workspace`（worktree 里没有项目状态）；删除协调者会话会清空指针；
- 项目状态里记录 `coordinatorSessionId`；
- `buildSystemPromptAsync` 每轮读取项目状态，只有当前会话是协调者时才追加：
  - brief + thread registry + 最近 12 份报告 + gates + 协调规则；
  - 硬上限 9000 字符，超出截断并标明；
  - 明确告诉模型：不要声称读过 thread 聊天记录。

实现：`context.ts`、`src/core/llm/index.ts`、`src/core/store.ts`、`src/components/Sidebar.tsx`。

## 使用

1. 打开项目，点项目行皇冠按钮；
2. 编辑 `.codem/project/brief.md` 填目标/约束/验收；
3. 在协调者会话里提问；它会带项目状态回答；
4. thread 直接调用 `project_report` 工具写报告；协调者下一轮会读到。

## 判据与验证

- `src/test/coordinator-project-state.test.ts`：9 条（RPT-1..4、PST-1..5）；
- `tsc` 0；全量测试通过（见提交时输出）；
- 真机（dev + CDP）：
  - 点皇冠 → 生成 `state.json`（coordinatorSessionId 正确）与 `brief.md`；
  - 写入 brief「目标代号是蓝鲸」后，直接调用 `buildSystemPromptAsync`，返回 46,166 字符，包含 `蓝鲸` 与 `项目协调者上下文`。
  - 没有依赖模型回答（模型那次卡在递归搜索，已取消），注入事实由 prompt 本体证明。

## 真实多 thread 验证（2026-10-22）

- 项目：`.preview-shot/coordinator-lab/site-project`（Codem 官网，7 页 / 15 区 / 2779 功能点）；
- 3 个真实 thread + 3 个 worktree，3 份 `project_report`；
- Overview 实测 `waiting 0 / working 0 / review 2 / done 1`；
- 新协调者重建 prompt 39,097 字符，包含 thread 标题/摘要/gate；
- 同文件冲突：合并返回 `conflictFiles:["site/README.md"]`，按 worktree 侧收口；
- 合并后门禁：build 0 / check 24/24 / audit 29/29 / e2e PASS / smoke PASS。
- 详细记录：`.preview-shot/coordinator-lab/logs/PROJECTS-E2E.md`。

## P0 没做的（下一刀）

- thread 侧写报告的 **LLM 工具/UI**（现在只能手工写 JSON 或脚本）；
- 项目 Overview（待你/运行中/待评审）与 thread 状态看板；
- 删除协调者会话时清理 `coordinatorSessionId`；
- 多协调者冲突策略（当前后建覆盖先建）；
- 报告坏文件的显式计数（现在被跳过，context 只显示有效报告）。
