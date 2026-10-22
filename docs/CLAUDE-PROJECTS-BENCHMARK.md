# 对标分析：Claude Code Projects vs Codem（2026-10-22）

> 方法：读官方文档（[Projects](https://code.claude.com/docs/en/claude-projects)、[Agents](https://code.claude.com/docs/en/agents)、[Remote Control](https://code.claude.com/docs/en/remote-control)、[Memory](https://code.claude.com/docs/en/memory)、[Worktrees](https://code.claude.com/docs/en/worktrees)），对照 Codem 代码与 2026-10-22 的协调者/worktree 实验。
> 结论只代表当前版本；Claude Projects 仍是 Pro/Max 公测，功能会变。

## 一、Claude Projects 是什么

**一个 Project = 一个长期存在的协调对话 + 它派生出的并行 thread（云会话）**，共享仓库、instructions 与 memory。

| 部件 | 能力 |
|---|---|
| Project conversation | 唯一入口：丢任务，它决定"回答 / 新建 thread / 交给已有 thread"；可按偏好一次拆多个、限制并发、先提议再开 |
| Threads | 真正干活；各自独立上下文，自动压缩；云 thread 在自己的分支上工作、必要时开 PR，结束向协调对话汇报 |
| Overview | 按状态分组：Ready for review / Waiting on you / Working / Landing / Idle / Resolved；一周无活动自动 Resolved；另有 Library、Pull requests、Scheduled tasks |
| Project instructions | ≤16,000 字符，注入每个新 thread 和协调对话 |
| Project memory | Claude 自己维护的笔记文件：`MEMORY.md` 索引 + 其他文件；每个云 thread 启动读索引、按需打开；可在 Project settings > Memory 编辑/删除 |
| Environment / Library | 仓库、网络白名单、密钥、setup 脚本；上传文件/文件夹（单次最多 100 文件 / 2GB） |
| 执行 | 默认云 sandbox；需要本机能力时用 Remote Control 在用户电脑跑（本地文件夹 + 可选 worktree），电脑休眠则暂停 |
| 审批 | thread 内 auto mode；需要时在 thread 内弹审批，只有回答才继续；协调对话里的消息不能替 thread 解阻塞 |
| PR 生命周期 | 开 PR、修 CI、处理 review 评论、合并 |
| 限制 | 每天最多 200 个新 thread；一个 Project 单人所有；thread 不能迁移到别的 Project；云 thread 不加载仓库 skills / `.mcp.json` / `.claude/settings.json` / hooks；不能把本地会话加进 Project |

## 二、Codem 现状（同一维度）

| 维度 | Codem 现在 | 依据 |
|---|---|---|
| 项目容器 | 一个本地文件夹 + 会话列表；项目只有 id/name/path/description/pinned | `core/storage/project.ts` |
| 项目级协调者 | **没有**：每个会话各自为政；有委派/子代理/团队，但都是会话内动作 | `delegate_to_session`、`handoff_to_new_session`、`squad_dispatch` |
| thread / 工作项 | 会话是平的；没有 thread 状态机、没有项目级 registry | `sessions` 表 |
| 并行执行 | 本地 worktree（2026-10-22 起支持合并回主工作区）、子代理、Squad 运行时 | `worktree-manager.ts`、`GitInfoPanel` |
| 项目上下文 | `.codem/instructions.md` / `CLAUDE.md` 指令层；项目作用域记忆（DB 条目 + 审批） | `prompt/instruction-layers.ts`、`memory/*` |
| 项目记忆索引 | **没有** `MEMORY.md` 式"索引常驻、正文按需"；记忆是审批式条目 | 同上 |
| Overview / 需要你 | TaskCenter（Overview/Delegation/Subagents/Automation/Team/Issues/Board/Inbox）+ `needs_you_pending`，但以会话/任务为中心，不是项目 thread 看板 | `TaskCenter.tsx`、`needs-you-queue.ts` |
| PR 生命周期 | 只有 git 工具；无 thread 级 PR 状态、CI 自动修复、review 评论处理 | —— |
| 云执行 | 无；纯本地 | —— |
| 调度 / 用量 | 自动化插件、会话级模型；无"协调者 vs thread"角色模型、无按 thread 的账本 | —— |

**Codem 的本地优势**：仓库里的 skills / MCP / hooks / 权限规则全部生效；完整本地写文件/终端/沙箱；无订阅计划与 200 thread/天限制；worktree 现在可合并。

## 三、差距（按重要性）

| # | 差距 | 本质 | 现状 |
|---|---|---|---|
| 1 | 没有项目级协调者 | 项目只是文件夹，用户要自己决定开哪个会话、给什么任务 | **未做** |
| 2 | 没有 thread 生命周期 | 会话平铺；没有"待你/运行中/待评审/已完成"与汇报契约 | 实验有报告契约，产品未做 |
| 3 | 没有项目状态层 | brief / 记忆索引 / thread registry 不存在；协调者无法重建 | **未做**（实验验证可行） |
| 4 | 没有 Overview / 需要你聚合 | TaskCenter 是会话/任务视角，不是项目 thread 看板 | 部分（组件有，语义不对） |
| 5 | 项目上下文不够"每 thread 必读" | 有指令层和记忆，但没有项目 brief UI、没有索引注入 | 部分 |
| 6 | PR 生命周期缺失 | 只有 git，没有 PR/CI/review 自动化 | **未做** |
| 7 | 云执行缺失 | 本地优先的取舍，不是缺陷；但"关掉电脑继续跑"做不到 | 不做（定位冲突） |
| 8 | 审批打扰 | 记忆审批、工具审批多；Projects 用 thread 内 auto mode + 审批 | 部分（有 quick toggle） |

## 四、实验结论（2026-10-22）

在 `.preview-shot/coordinator-lab/` 用网站项目跑了协调者/thread 实验：

- **worktree 隔离 + 合并线程**是并发归因的正确形态：各 worktree diff 精确；共享工作区快照在并发下会把同一改动算给多个线程。
- **报告 v3.1 + 事件日志 + 门禁注册表**能约束"报告撒谎"：验收必须绑 gate、证据必须入库、未知字段拒绝、报告 ≤1000 token。
- **协调者重建**：只读 brief + memory + 10 份报告，7/7 问答正确；全量状态约 12.7K token。
- **合并策略**：追加冲突 keep-both；同线冲突 blocked + 人工选边；产品首版已实现 abort/worktree/main 三种选择。
- **产品化已落地**：worktree 创建/隔离/合并/清理、会话切换同步、`.codem-worktrees` 忽略、Vite watcher 忽略、路径持久化重试。

## 五、Codem 该做什么（优先级）

**P0（协调者最小闭环）**
1. `ProjectState`：brief、记忆索引、thread registry（id/状态/分支/PR/最后报告）；
2. 报告 v3.1 + 变更事件日志 + gate 注册表；
3. 协调者作为**会话角色**（新建对话可选、可升可降），不是项目容器；
4. 协调者上下文按"brief + 记忆索引 + thread 报告 + 最近 K 轮"组装，可重建。

**P1（体验）**
5. 项目 Overview：按"待你/运行中/待评审/已完成"聚合；
6. `needs_you_pending` + 审批 + 失败聚合到项目级；
7. 项目 instructions 编辑 UI + 每 thread 注入。

**P2（规模化）**
8. PR 生命周期：分支、PR、CI 状态、修复/合并；
9. 项目级定时任务、按 thread 的模型/用量；
10. 冲突逐文件选择（当前是 abort/worktree/main 三选一）。

## 六、结论

Claude Projects 的创新不在"并行"，而在**把项目变成一个有人负责的入口**：协调者拆活、thread 独立执行、Overview 按"是否等你"聚合、项目记忆跨 thread 持久化。

Codem 的底层积木（worktree、委派、子代理、Squad、Inbox、记忆、指令层）已经齐了，缺的是**项目层的协调者与状态**。实验证明这条架构可行，且 worktree 合并入口已经落地；**但截至今天，Codem 还没有项目级协调者，也没有 thread 状态/Overview** —— 对标分析可以收口，实现还没开始。

## 七、仓库内对照

- 功能基线：`docs/CODEM-FEATURES.md`（18 slice / 362 组 / 2779 条）
- 现有实现：`src/core/store.ts`、`src/core/storage/session.ts`、`src/core/environment/worktree-manager.ts`
- 实验记录：`.preview-shot/coordinator-lab/logs/`

## 八、边界

- 未验证：真实模型写报告的质量、协调者路由歧义率、并发同文件冲突的自动合并；
- 未做：PR 生命周期、云执行、项目级定时任务；
- Claude 侧为公测口径，Pro/Max 专属，Team/Enterprise 不可用；本地会话不能加入 Project。
