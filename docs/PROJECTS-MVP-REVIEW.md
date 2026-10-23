# Projects MVP 复盘与决策（2026-10-22）

## 1. 对照 Claude Projects

| 能力 | Claude Projects | Codem 现在 | 结论 |
|---|---|---|---|
| 项目协调者 | 强制协调对话 | 可选协调者会话（侧栏皇冠） | 混合模式，保留普通会话 |
| 并行 thread | 云 thread | 普通会话 + worktree | 本地等价物 |
| 项目状态 | instructions/memory/threads | `.codem/project` brief/state/gates/events/reports | 文件化、可人工检查 |
| 上下文重建 | 云端项目记忆 | 协调者只读状态，9000 字符上限 | 已验证：39,097 字符 prompt 含 3 thread 报告 |
| Overview | 六状态 | 四状态 + 审批按钮 + 展开 thread 详情 | 够用；没有 Landing/Idle |
| 报告/验收 | PR/评审 | v3.1 report + gate + 独立重验 + 证据缺失降级 | 可信验收已落地 |
| 记忆/指令 | 项目记忆文件 | 项目 brief + 现有指令/记忆注入 | brief 已注入；记忆索引未做 |
| PR/CI | 全自动 | `gh` 只读同步 PR/CI + Overview 展示；无自动创建/修复 | 本地优先，写操作暂不做 |
| 云执行 | 云 sandbox | 本地 | 差异点，不跟 |

## 2. 实测指标（真实官网项目）

- 3 个 thread / 3 个 worktree / 3 份 report；
- Overview：waiting 0 / working 0 / review 2 / done 1；
- 新协调者重建：39,097 字符，含 T1/T2/T3 标题、摘要、gate；
- 冲突：`site/README.md` 冲突被捕获并回滚，按 worktree 侧收口；
- 合并后门禁：build 0 / check 24/24 / audit 29/29 / e2e PASS / smoke PASS；
- 发现的真实问题：项目基线缺 docs、e2e 硬编码层级、worktree 证据未回主区、T3 报告“假绿”。

详细记录：`.preview-shot/coordinator-lab/logs/PROJECTS-E2E.md`（lab，未入库）。

## 3. 决策

**继续投入，但只到 P2 的“可信验收”为止；不扩到 PR/云。**

- ADR 从 Proposed 转为 **Accepted（MVP）**；
- 理由是混合模式在真实项目上跑通，且没有破坏普通会话路径；
- 但“报告可信”只做到“证据可追踪/缺失可见”，**gate 自动重验是 P2 的硬前提**：
  没有它，协调者仍可能被 T3 那种“声称全绿”骗过；
- 如果 P2 的 gate 重验 + 一次真实回归仍不能拦住假绿，则收缩为“只做项目总览 + 报告”，不把协调者作为默认入口。

## 4. P2 已做（2026-10-23）

1. **gate 重验**：`verifyProjectGates` 对每 thread 最新报告的 passed gate 重跑 `command`；没有 command = no-command，不算 done；
2. **证据存在性**：缺失证据把 done 降为 review，Overview 显示缺失数；
3. **项目记忆索引**：`.codem/project/MEMORY.md` 注入协调者上下文（≤2000 字符）；
4. **假绿回归**：`OV-4` 用“done + gate passed 但无 command”钉住，删掉重验逻辑必红；
5. 真实官网项目复验：T3 五道门禁命令 exit 0；T1/T2 10 个 gate 无 command 仍为待评审，Overview `review 2 / done 1`；
6. **审批动作**：blocked 选项按钮 → `decisions.jsonl` → thread 回运行中，协调者上下文可见「问题 → 选择」；
7. **thread 生命周期**：新建即 idle、开跑 working、报告更新、删除移除；无报告也进 Overview。

## 5. 风险与边界

- 双入口（普通会话/协调者）需要一段使用说明；当前只有侧栏按钮 + 文档；
- 报告由模型主动调用工具，仍可能漏写；协调者应把“没有报告”视为未完成；
- worktree 合并冲突只做到“选边/回滚”，没有逐文件 UI；
- 真实部署/PR/云执行不在本 MVP。

## 6. 最终能力矩阵（2026-10-23，项目工作台 MVP）

| 能力 | 状态 | 证据 |
|---|---|---|
| 项目状态 / brief / MEMORY 索引 | 可用 | `.codem/project/`；协调者 prompt 注入 |
| 协调者会话 | 可用 | 侧栏皇冠；只读状态；删除清理 |
| 并行 thread / worktree | 可用 | 3 个真实 thread + worktree；自动注册 idle→working |
| thread 生命周期 / Overview | 可用 | 四态 + 未报告 thread + 展开详情 + 打开会话 |
| 审批 | 可用 | blocked 选项 → decisions.jsonl → 回运行中 |
| 可信验收 | 可用 | gate command 重验；证据缺失降级；T3 假绿回归 OV-4 |
| 项目记忆/指令 | 可用 | `.codem/instructions.md` 真机进入 prompt；MEMORY 索引 |
| PR/CI | **只读** | gh pr view 同步状态；不创建/合并/修 CI |
| 项目级自动化 | 可用（初版） | projectId 触发；真机：2 个自动化会话落到目标项目并注册 thread |
| 真实 e2e | 可用 | 原型官网 3 thread / 3 report / 冲突 / 合并 / 五道门禁 |

## 7. 最终决策

**继续投入，但只投「本地优先的项目工作台」；不做 PR 写操作、云执行、多用户。**

- 产品线已经可用：协调者、thread、Overview、审批、可信验收、指令/记忆、PR 只读、项目自动化都能在一个真实项目上跑通。
- 剩余问题主要是可靠性与体感，不是架构缺失：自动化重复触发、PR 需要 gh 登录、默认并行下 CLI-1 有 libuv 抖动。
- 因此下一阶段是 P3 可靠性硬化，不是继续铺新功能；若 P3 仍无法把“假绿/重复触发/错误恢复”压住，再收缩为“项目总览 + 报告”而不保留协调者默认入口。
