# 长程目标模式 + 远程新建/隧道（G0–G5、B1–B4）验收记录

> 实现依据：`ADR-0006-LONG-HORIZON-GOAL.md`、`GOAL-MODE-PLAN.md`、`TASK-GOAL-MODE-ADDENDUM.md`。
> 本文只记录**跑过什么、得到什么读数、哪些没跑**（不把"代码写了"当成"验证过了"）。

## G0–G4：目标模式（桌面）

| 判据 | 结果 | 位置 |
|---|---|---|
| GOAL-1 多阶段自动建目标 / 单阶段与问答不建 / 同一会话单 active | 通过 | `src/test/goal-runtime.test.ts` |
| GOAL-2 深规划只读（工作区外拒绝、读轮数上限） | 通过 | `src/test/goal-plan.test.ts` |
| GOAL-3 动作型 outcome 拒绝（5 例 + 正例） | 通过 | 同上 |
| GOAL-4 模型自称成功但验收失败 ⇒ 不算完成 | 通过 | `src/test/goal-runner.test.ts` |
| GOAL-5 三阶段自动推进 | 通过 | 同上 |
| GOAL-6 / 16 无 tool call + 验收未达 ⇒ 自动继续（留 `auto_continue`） | 通过 + **真机注入** | 单测 + `src/test/goal-ui.test.tsx`；真机：模型连续只回复不调工具 ⇒ 6 次 `auto_continue`、无进展后重规划、最终 blocked（`.preview-shot/a1-report.json`） |
| GOAL-7 连续同一失败 ⇒ 有证据的重规划；白名单外不触发 | 通过 | `goal-runner` + 真机 A1 注入 |
| GOAL-8 重规划保留已完成阶段（q 前缀） | 通过 | 同上（真机 A1 看到 `p1 → q1` 重排） |
| GOAL-9 契约只能由用户改（版本 +1、暂停、下次重规划） | 通过 | `goal-ui.test.tsx` |
| GOAL-10 持久化往返 + 重启恢复（SQLite） | 通过 | `goal-runtime.test.ts`（含新实例继续未完成阶段） |
| GOAL-11 unlimited 不因预算停；capped 暂停 | 通过 | `goal-runner` |
| GOAL-12 每轮注入（真实请求体断言：尾消息有、system 前缀没有） | 通过 | `src/test/goal-context.test.ts` |
| GOAL-13 审批待决/拒绝/允许 | 通过 | `goal-runner` |
| GOAL-14 中止 ⇒ paused、不再发下一轮 | 通过 | 同上 |
| GOAL-15 审计（决策/证据/计划版本/UI） | 通过 | `goal-runtime` + `goal-ui` |
| GOAL-17 压缩检查点 / 恢复（不重规划、不丢验收） | 通过 + **接线级 + 真机** | `goal-context`；`goal-compaction-integration` 走**真实** `AgenticLoop.compactMessages`（变异自证）；真机注入 400 条历史触发自动压缩：`phase_checkpoint → phase_resumed` 后同一阶段继续并完成（`.preview-shot/a2-report.json`） |
| GOAL-18 配对被切开 ⇒ blocked(context_conflict)；预算达限暂停原因可见 | 通过 | `goal-context` + `goal-ui` |
| 变异自证（5 组：预算/动作型/自动继续/注入/保留阶段） | 全部先红后绿 | 见交接 |

## G5：真机长任务（真实模型）

见文末"G5 读数"（安装后的桌面应用 + 真实 provider + 真实工具执行 + 真实 SQLite）。

## B1：手机远程新建会话/项目

| 判据 | 结果 | 位置 |
|---|---|---|
| 网关白名单含 `session.create` / `project.list` / `project.create`；缺注入则报 unsupported | 通过 | `src/test/gateway-create.test.ts` |
| 建会话写桌面**同一份** `sessions` 表，桌面 `flattenSessions()` 立刻可见；未知项目 NOT_FOUND 不写库；同名加序号 | 通过 | `src/test/desktop-remote-session.test.ts` |
| 手机面板：项目选择、建项目、失败原因可见、缺能力不画按钮 | 通过 | `src/test/create-session-sheet.test.tsx` |
| Rust 网关白名单两侧一致（`session.create` 等到达渲染层） | 通过 | `cargo test phone::gateway`（45 项） |
| 经**真实隧道**建会话 | 通过 | B4 的 `session.create`（见下） |

## B2：开箱无感（自启 / 持久化 / 单设备撤销 / 稳定端口）

| 判据 | 结果 | 位置 |
|---|---|---|
| 网关默认随桌面启动（设置 `codem-gateway-autostart` 可关） | 通过 | 安装后 `:41873/health` 立即可用；`RemoteGatewaySection` 开关 + 用例 |
| 配对设备持久化（只存 sha256），重启桌面后旧 cookie 仍有效 | 通过 | **真机**：`_b2-restart-test.mjs` 7/7（重启后 `project.list` 200、设备列表仍在） |
| 单设备撤销（其它设备不受影响，撤销后 401） | 通过 | 同一脚本 + `remote-gateway-card.test.tsx` |
| 稳定/优先端口 41873（占用才回退随机端口） | 通过 | Rust `PREFERRED_PORT`；重启后仍是 41873（B2 读数） |
| 停止网关 = 撤销全部设备（磁盘同步清空） | 通过 | Rust `stop()` + `pairing` 用例 |

## B3：Android（x86_64 模拟器 + arm64 尝试）

- **x86_64 全量设备用例 26/26 PASS**（APK 由本分支构建、真实安装）：
  DC-1 冷启动 Host、DC-2 共享 UI、DC-3 新建会话、DC-4 真跑一轮（含工具）、DC-5a/b/c 审批、
  DC-6a/b「继续」、DC-7 深链、DC-8 重启后会话仍在、DC-14 附件、DC-11 文件预览、
  DC-12/13/15/16a–d 宽窄屏与折叠、DC-17a–c 差异页签、DC-18 只读变更、DC-10 HOME 后存活、DC-9 无崩溃。
- **Doze**：`dumpsys deviceidle force-idle` → `get deep = IDLE`，应用进程仍在（前台服务），`unforce` 后回 `ACTIVE`。
- **arm64**：已下载 `system-images;android-35;google_apis;arm64-v8a` 并创建 `codem-arm64` AVD，
  但模拟器直接 FATAL：
  `Avd's CPU Architecture 'arm64' is not supported by the QEMU2 emulator on x86_64 host. System image must match the host architecture.`
  ⇒ **本机（x86_64 Windows）无法运行 arm64 系统镜像**；PRoot/Node/DB 的 arm64 路径未在本机执行。
- **未覆盖**：相机/通知/分享/剪贴板等原生桥（本轮只验证了文件/附件/审批/深链）；OEM 后台杀进程、特定 ROM 的 WebView 行为需要物理设备。

## B4：跨网（真实 Cloudflare 隧道）

`node .preview-shot/_b4-tunnel-test.mjs`（真实 `cloudflared` quick tunnel → 公网 HTTPS URL）：

| 步骤 | 结果 |
|---|---|
| 隧道 `/health` 可达 | PASS（等待边缘生效，HTTP/2 协议） |
| 经隧道用一次性码配对 | PASS（设备 `dev-…`） |
| `Set-Cookie` 含 `Secure; HttpOnly; SameSite=Strict` | PASS |
| 带 cookie `project.list` | PASS（5 个项目） |
| 带 cookie `session.create`（写桌面同一份库） | PASS（同名自动 ` · 2`） |
| 错误 `Origin` | PASS（403） |
| 桌面撤销该设备 | PASS |
| 撤销后同一 cookie | PASS（401） |

- 依赖/成本：`cloudflared` 可执行文件；固定隧道需要 Cloudflare 账号与域名（quick tunnel 的 URL 每次变化）。
- Tailscale 未安装/未登录，因此**没有** Tailscale 读数；代码侧已接受 `*.ts.net` 与 `https` 判定。
- 详见 `REMOTE-ACCESS-TUNNELS.md`（三种入口、Host 白名单、Secure cookie、不能裸奔回环）。

## G5 读数（2026-11-03，安装后的真机）

- 环境：Windows 桌面、静默安装 1.17.0 工作区构建（含本轮改动）、真实 provider、真实工具执行、真实 SQLite；
  工作区是临时 Node 小仓库（`%LOCALAPPDATA%\Temp\codem-goal-g5`），任务由一条多阶段自然语言消息触发：
  「分三步：1) 修 sum 边界并补测试；2) 新增 stats.mean（空数组 null）让测试全绿；3) 加 CLI，最后 npm test 全绿」。
- 结果：**completed**，用时 **340s**，用量 **≈2039 tokens / 3 回合**；
  阶段 `p1/p2/p3` 全部 **done（各 1 次尝试）**；证据 **11 条**、决策 **8 条**
  （`plan_created → phase_started → phase_passed ×3 → goal_completed`）；
  契约级验收 A1–A4 全部通过（`npm test`、sum 边界命令、mean 命令、`node bin/cli.js sum 1 2 3`）。
- 过程中发现并已修复的两个真机缺陷：
  1. 目标五张表未预取 ⇒ 建目标时 `domainWrite` 落在"加载中"，读回验证为空 ⇒ 被误判"计划未能保存"
     （修复：`HOT_DOMAIN_TABLES` 加入五张表 + 建目标前 `ensureGoalTablesReady`，判据 `goal-runtime`）；
  2. `artifact` 验收的相对路径按应用进程目录解析 ⇒ "系统找不到指定的路径"
     （修复：相对路径接到阶段 `cwd`，判据 `GOAL-19`，含绝对路径反向对照）。
  3. 模型阶段 3 里跑了一次 `npx eslint`，工作区没有 eslint、`npx` 等 stdin 确认 ⇒ **工具调用挂住约 7 分钟**。
     这是工具/环境交互缺陷，不是目标模式调度错误；**已结构修复**：`execute_command` 的子进程
     `stdin` 改为 `null`（立即 EOF ⇒ 交互式命令立刻失败返回，而不是等超时），
     并有两条判据：行为 `exec_stdin_closed_so_interactive_prompts_fail_fast`、
     结构 `exec_spawn_config_must_null_stdin`（删掉 `.stdin(Stdio::null())` 会变红，已做变异自证）。


## A1 / A2 真机注入（G5 的 happy path 没有触发这两条，单独补测）

> 为什么必须单独测：G5 三阶段都一次通过、也没有到压缩水位，所以"一轮就停"和"压缩打断"
> 在 G5 里**根本没发生**。下面两条是强制让它们发生，再读应用自己写的 `goal_decisions`。

### A1（一轮就停）：模型只回复、不调用工具

- 注入 3 阶段目标，验收命令故意失败，阶段提示词明确"只回复一句，禁止调用工具"；
  打开会话由 `resumeGoalOnOpen` 恢复。
- 结果（`.preview-shot/a1-report.json`）：**6 次 `auto_continue`**，没有停在原地等用户点继续；
  第 3 次后 `plan_replanned`（`p1 → q1`），再 3 次无进展后 `goal_blocked`：
  `重规划次数已达上限 1 次：阶段 q1 连续 3 次无进展`。
- 结论：**模型自然语言收尾不会再让阶段"一轮就停"**；同时自动继续受 `maxAttempts` 与
  无进展熔断约束，不会变成无限续跑。

### A2（压缩打断）：真实自动压缩发生在阶段中途

- 注入 400 条历史消息（约 1.6MB，越过 70% 水位）+ active 目标；打开会话恢复。
- 结果（`.preview-shot/a2-report.json`）：决策链
  `goal_resumed → phase_started → phase_checkpoint → phase_resumed → phase_passed → … → goal_completed`；
  压缩前后是**同一阶段 p1**，没有重规划、没有重跑已完成阶段，目标正常完成。
- 接线级判据：`src/test/goal-compaction-integration.test.ts` 直接走生产
  `AgenticLoop.compactMessages`（不是只调检查点函数），断言检查点/恢复写入、压缩后请求尾部仍有
  `# Goal Mode` 且 system 前缀没有；把检查点调用去掉会变红（已做变异自证）。
- 结论：**压缩不会再打断目标**；即使压缩把工具配对切开，也会走 `blocked(context_conflict)` 而不是静默继续
  （`reportGoalContextConflict` + `goal-context` 判据）。
