# 新会话开工说明（Codem）—— 先读这一页，再读交接包

> **基线**：2026-11-04 ｜ 版本 **1.18.5**（GitHub `Latest`）｜ `master` @ `git log -1`
> ｜ 全量测试 **880 文件 / 9551 用例**（9534 通过 / 17 skipped / 0 失败）｜ `tsc` 0。
>
> **本文件只做入口，不承载全部事实。** 真正的交接包是
> **`docs/project-guide/20-HEAVY-TASK-HANDOFF.md`**；
> 硬规则/坑是 **`00-AGENT-HANDBOOK.md`**；
> 当前绿/未验/别碰是 **`09-CURRENT-STATE.md`**；
> 判据/审计/构建/发布是 **`08-ENGINEERING-GATES.md`**。
>
> 旧版本（1.16.x）的待办、免费模型细节、压缩波次等内容已移出本文；不要再按它们开工。

---

## 0. 直接粘贴给新对话

```text
你在 C:\mimo-gui 接手 Codem 的一个重型任务。先不要改代码。

按顺序读：
1. docs/project-guide/20-HEAVY-TASK-HANDOFF.md
2. docs/project-guide/00-AGENT-HANDBOOK.md
3. docs/project-guide/09-CURRENT-STATE.md
4. docs/project-guide/08-ENGINEERING-GATES.md
5. 与任务相关的 03 / 05 / 06 / 07

然后跑：
git status -sb
git log --oneline -5
npx tsc --noEmit
npx vitest run <相关判据>        # 先单跑；全量放最后

硬规则：先写判据再做实现；能做结构修复就不要只加提示词；不要用 goal mode/自动续跑开发本仓库；
不要整树 git 操作；只按 PID 杀自己 spawn 的进程；发版前先问用户；中文引号用「」；新文件 UTF-8 无 BOM。
禁止为了“让测试变绿”而弱化完成门、验证门或删除既有判据。

先向我汇报：你读到了什么、任务边界、你准备先写哪条判据、有哪些不确定；我确认后再动手。
```

---

## 1. 项目一句话

**Codem**：Windows 优先的 Tauri v2 + Rust + React 18/TypeScript 桌面 AI 编程助手，把「对话 → 计划 → 工具调用（读写文件/命令/终端）→ 验证」做成 GUI。仓库 `github.com/sdcxb/codem`，分支 `master`。

- 应用外壳：`src/App.tsx`
- Agent 主循环：`src/core/llm/agentic-loop.ts`
- 工具注册/契约/执行：`src/core/llm/tools.ts` + `tool-pipeline.ts`
- Rust 主入口：`src-tauri/src/lib.rs`
- 存储：`src/core/storage/*` → `rust-port.ts` → `codem-db`
- 桌面继续条/回合 UI：`src/components/ChatPanel.tsx`、`src/components/ContinueBar.tsx`

---

## 2. 当前状态（只列会改变判断的）

| 项 | 值 |
|---|---|
| 版本/发布 | **1.18.5**，GitHub `Latest`（2026-11-04） |
| 工作区 | 发布提交后应干净；只允许 `.codem/` 运行时文件未跟踪 |
| 全量测试 | 880 文件 / 9551 用例：**9534 通过、17 skipped、0 失败**（约 181s） |
| Rust / Flutter | 241 passed / 2 ignored；Flutter 10 passed（本轮未改，改动后重跑） |
| 12 任务对标 | 1.18.0 单轮：Codem **10/12**，DSH **9/12**；`insufficient-repetition`，只能作方向性结论 |
| 长尾单任务 | 修复前 1 轮 104.46M total；候选 2 轮均值 8.30M，均通过；但新闸门并非每轮触发，不能全归因 |
| APK | `Codem-Mobile-1.0.0-arm64.apk` / `x86_64.apk`，**debug 签名预览包** |
| 最近修 | 完成回合隐藏继续；继续条与正文列对齐；子代理配额/去重；glob/grep 观察缓存；红判据停滞指纹 |

完整证据等级和边界见 `20-HEAVY-TASK-HANDOFF.md` §3。

---

## 3. 绝对不要做

1. **不要用 goal mode / 自动续跑开发本仓库**（用户 2026-10-15 明确禁止）；多步用 `todo_write`，一次做完。
2. 不要弱化完成门 / 回归门 / 验证门来让测试变绿；不要删除或跳过既有判据。
3. 不要整树 `git add -A` / `git stash` / `reset --hard`；只加显式路径。
4. 不要 `taskkill /IM codem.exe`；只按 PID 杀自己 spawn 的进程。
5. 不要把 `.preview-shot/`、`dist/`、`art/`、`prototype/` 带进提交。
6. 不要在跑评测批时构建（抢 CPU 会污染墙钟）。
7. 不要把 APK 说成正式签名包；不要用单任务外推整体通过率。
8. 不要用提示词替代结构修复；代码/判据 > 文档 > 模型自述。

---

## 4. 门禁与验证（复制即用）

```powershell
cd C:\mimo-gui
git status -sb
git log --oneline -5
npx tsc --noEmit                         # 必须 0
npx vitest run src/test/<相关>.test.ts   # 先单跑
npx vitest run                           # 全量约 3.2 分钟；880 文件 / 9551 用例
npm run audit:docs                       # 文档/版本门禁
node tools/audit/scan-report-sites.mjs --check
node tools/mutate/check-artifacts.mjs
node tools/ui-audit/css-contract.mjs --write   # 改 CSS 后
npx vitest run src/test/css-integrity.test.ts src/test/ui-consistency.test.ts
```

> 计时敏感用例（如 `concurrency-three-sessions`）在全量并行下偶发超时；**先单跑确认**，别急着改代码。

构建/发版必须读 `docs/RELEASE-GUIDE.md`，并先问用户。发版后必须复核 7 个资产、`Latest` 与 `verify-update-manifest.mjs --remote`。

---

## 5. 文档地图（新会话按这个读）

| 想知道 | 读 |
|---|---|
| **重型任务交接、当前事实、任务候选、开场白** | **`docs/project-guide/20-HEAVY-TASK-HANDOFF.md`** |
| 硬规则 / 基线 / 坑 / 任务路由 | `docs/project-guide/00-AGENT-HANDBOOK.md` |
| 现在哪些绿、哪些没验、哪些别碰 | `docs/project-guide/09-CURRENT-STATE.md` |
| 判据/审计/构建/发布 | `docs/project-guide/08-ENGINEERING-GATES.md` |
| 目录与模块职责 | `docs/project-guide/02-CODE-MAP.md` |
| 一轮对话/工具/压缩/子代理 | `docs/project-guide/03-RUNTIME-FLOWS.md` |
| UI/皮肤/布局 | `docs/project-guide/05-UI-UX.md` |
| 存储/表/数据根 | `docs/project-guide/06-DATA-STORAGE.md` |
| Rust 命令/执行器/安全 | `docs/project-guide/07-BACKEND-IPC.md` |
| 命令与发版规程 | `AGENTS.md` / `docs/RELEASE-GUIDE.md` |
| 逐轮工程日志（grep，不通读） | `docs/HANDOFF-NEXT-SESSION.md` |

---

## 6. 交接前自检

新对话答得出这 6 条，才算读懂：

1. 当前版本、`Latest`、HEAD 是什么？
2. 全量测试基线多少？一条计时 flake 先做什么？
3. “任务完成”和“继续”为什么曾经同时出现？根因是什么？
4. 长尾优化有哪三道闸门？红判据指纹为什么只能停成“未完成”？
5. 12 任务 10/12 为什么不能当统计显著结论？
6. 哪些能力只有判据、没有真机证据？

答不出就回 `20` / `00` / `09`，不要开始改代码。
