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

### 3. 协调者会话

- 侧栏项目行的皇冠按钮「新建协调者对话（项目级）」→ `createCoordinatorSession()`；
- 会话标题为「协调者」，强制 `current_workspace`（worktree 里没有项目状态）；
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
4. thread 报告可以写入 `.codem/project/reports/<id>.json` 后由协调者读取（P0 还没有“报告工具/UI”）。

## 判据与验证

- `src/test/coordinator-project-state.test.ts`：9 条（RPT-1..4、PST-1..5）；
- `tsc` 0；全量测试通过（见提交时输出）；
- 真机（dev + CDP）：
  - 点皇冠 → 生成 `state.json`（coordinatorSessionId 正确）与 `brief.md`；
  - 写入 brief「目标代号是蓝鲸」后，直接调用 `buildSystemPromptAsync`，返回 46,166 字符，包含 `蓝鲸` 与 `项目协调者上下文`。
  - 没有依赖模型回答（模型那次卡在递归搜索，已取消），注入事实由 prompt 本体证明。

## P0 没做的（下一刀）

- thread 侧写报告的 **LLM 工具/UI**（现在只能手工写 JSON 或脚本）；
- 项目 Overview（待你/运行中/待评审）与 thread 状态看板；
- 删除协调者会话时清理 `coordinatorSessionId`；
- 多协调者冲突策略（当前后建覆盖先建）；
- 报告坏文件的显式计数（现在被跳过，context 只显示有效报告）。
