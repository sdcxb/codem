# 设计对标审计（2026-11）

> 对象：`ADR-0001`（Host 抽取）/ `ADR-0002`（Android 运行时）/ `ADR-0003`（共享 UI 与矩阵）、
> `OPEN-DECISIONS` 的 D-1..D-9、`GAP-ANALYSIS`。
> 方法：逐条对照**代码 + 判据 + 设备取证**，不按文档自述判断。

## 1. 结论

**核心链路与安全纪律按设计落地；共享 UI 的功能矩阵、配对鉴权、arm64 真机是主要缺口。**
不是“完全实现”，但也没有出现“两份循环/两份行为”这种设计明令禁止的形态。

- 正向偏差（做得比设计多/更稳）：持久事件序号跨重启、观察者不抢租约、前台服务常驻、
  libtinfo 真机缺陷修复、真机操作用例 DC-1..10、arm64 服务栈 QEMU 验证、capability 诚实性修正。
- 负向偏差（设计有、实现没有）：diff 查看、文件树/只读预览 UI、附件上传 UI、会话搜索、
  steer（运行中引导）、设置只读、插件列表只读、响应式双/三列、配对 token。
- 明确阶段项（不算偏差）：`terminal.*`（阶段 5）、多主机切换（阶段 5）。

## 2. ADR-0001（Host 抽取）对照

| 设计项 | 状态 | 证据 |
|---|---|---|
| Agent 循环只在 Host 一份，不重写 | ✅ | `packages/host/src/runtime.ts` 直接 import `AgenticLoop` |
| 工具 id/schema 与渲染侧一致 | 🟡 六个工具已迁（read/glob/grep/write/edit/bash），**其余工具未迁**（todo/skill/web_fetch/subagent…） | `tools.ts`；桌面侧工具更多 |
| TurnWriter 回合落库契约 | ✅ | runtime + `TurnWriter`；DC-4 真机一轮成功 |
| JSONL 权威日志写入 | ✅ **实测**（设计担忧未实现） | Host 跑一轮后 `sessions/<id>.jsonl` 466B |
| 事件序号 = `session_events.seq`，跨重启续传 | ✅ | `spike-seq` SEQ-1..5；重启 21 条回放、seq 13→20 |
| 桌面 Tauri sidecar 拉起 Host | ✅ | 安装包实测：自动起 Host、`host.hello`、`host_stop` |
| FileTransport 显式化 | ✅ | `tauri-compat.ts` 提供 file-api 垫片 |
| 安全边界（工作区/审批/超时/进程树） | ✅ | BASH-1..5、FOP-1..4；真机 DC-5 `exit 0` |

**偏差**：工具集只迁了六个。设计原文是“逐个搬”，并未声称一次搬完；
影响是**远程能力小于桌面**（todo/计划、技能、联网、子智能体在手机上不可用）。属负向偏差，已列入补齐计划。

## 3. ADR-0002（Android 运行时）对照

| 设计项 | 状态 | 证据 |
|---|---|---|
| Kotlin 壳 + WebView 加载共享 UI | ✅ | SC-1..5 |
| PRoot + Ubuntu rootfs + Node + codem-db | ✅（x86_64） | LT-1..5、DC-1..10 |
| 进程模型：前台服务 + 唤醒锁，关 UI 不停 Host | ✅ **本轮补齐** | `KeepAliveService`；DC-10 按 HOME 后 `host.hello` 仍通 |
| 电池优化白名单引导 | ❌ 未做 | 未请求 `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`；厂商后台策略未覆盖 |
| arm64（设计目标 ABI） | 🟡 仅 ABI/服务栈验证 | QEMU：arm64 Node/Host/DB 通过；PRoot/WebView 需真机 |
| targetSdk=28（exec/ptrace） | ✅ | APK `targetSdk=28`；不能上架 Play（设计已接受） |
| 原生桥（文件/拍照/通知/分享/剪贴板） | ❌ 未做 | 设计“已定”，实现为零 |
| 安装/升级/回滚/重置 | 🟡 首启解压 + 版本目录未做 | 升级策略仅“覆盖安装 + 复制缺失库” |

## 4. ADR-0003（共享 UI 功能矩阵）对照

| 功能 | 设计 | 现状 | 偏差 |
|---|---|---|---|
| 会话列表 / 打开 | ✅ | ✅ 列表 + 打开 | — |
| 会话搜索 | ✅ | ✅ 搜索框 + 标题过滤 + 空态 | — |
| 发 prompt / cancel | ✅ | ✅（DC-4/5） | — |
| steer（运行中引导） | ✅ | ✅ `run.guidance` + 运行中「引导」按钮（STEER-1..3） | — |
| 流式正文 | ✅ | ✅ | — |
| 工具卡 / 截断预览 | ✅ | ✅ 长结果默认截断 + 展开/收起（TOOLCARD-1..2） | — |
| 审批 allow/deny | ✅（核心） | ✅ 卡片 + 真机 `exit 0` | — |
| diff 查看（只读） | ✅ | ✅ `workspace.diff`（git diff；非 git 返回 supported=false，入口仍显示但明确提示） | — |
| 文件树 / 只读预览 | ✅ | ✅ `workspace.list` + 共享 UI 文件浏览器（目录/预览/截断提示） | — |
| 附件上传 | ✅ | 🟡 Host `attachment.put` + Composer 入口 + 工作区引用已实现；多模态内联未做 | 部分 |
| 终端 | 阶段 5 | ❌ unsupported（显式） | 阶段项 |
| 设置（只读/受限） | ⚠️ | ❌ 无 | 负向 |
| 插件市场（只读） | ⚠️ | ❌ 无 | 负向 |
| 多主机切换 | 阶段 5 | ❌ | 阶段项 |
| 响应式（单列/双列/三列） | ✅ | ✅ 单列 + 双列（≥640）+ 三列（≥1024 文件常驻）；DC-12/13 实测 | — |
| 单写者租约 + 接管二次确认 | ✅ | ✅ `LeaseManager` + LSE-1..4；共享 UI 带 clientId | — |
| 配对（一次性码 + 桌面确认 + 撤销） | ✅ | ✅ Host `PairingService`（6 位码/5 分钟/单次/sha256/上限 8）+ `host_pair_new/devices/revoke` + 共享 UI 配对门；旧 `phone-link` LAN 配对已删除 | 完成 |
| “默认开启 + 一次提示 + 一键关闭” | ✅ | ✅ 自启 + 首启 toast + 设置开关 | — |

**capability 诚实性**：审计发现 `attachment.put` 被列为 supported、实际返回 `UNSUPPORTED`。
本轮已改为 unsupported（新增判据防止再漂移）。

## 5. 本轮补齐的内容

1. **租约真的生效**：共享 UI 生成稳定 clientId，`hello` 带 `deviceName`、`prompt.send` 带 `clientId`；
2. **观察者不抢租约**：`hello.claim` 门 —— 诊断/测试的 hello 不再把 UI 的写权限抢走（本轮真机曾因此报 `LEASE_HELD`）；
3. **首启提示变成全局**：桌面自启成功后 toast 一次（原先只在设置页里）；
4. **Android 常驻**：`KeepAliveService`（前台服务 + PARTIAL_WAKE_LOCK），DC-10 验证；
5. **capability 修正**：`attachment.put` → unsupported；
6. 上一轮的 libtinfo 修复与 DC-1..10 用例保留。

## 6. 剩余差距与优先级

| 优先级 | 缺口 | 计划 |
|---|---|---|
| P0 | 配对/token（远程安全） | ✅ 已由 Host `PairingService` 完成（一次性码/设备列表/撤销）；旧 phone-link 配对已删除 |
| P1 | 共享 UI：搜索/文件树/预览/diff/steer/工具卡展开 **全部完成** | — |
| P1 | diff | ✅ 已完成（git diff；非 git 明确提示） |
| P2 | 附件上传 | 实现 `attachment.put`（base64 → spill 文件）+ Composer 附件入口 |
| P2 | 桌面工具迁移（todo/技能/联网/子智能体） | 按 ADR-0001“逐个搬”，每个带与桌面同 schema 的判据 |
| P2 | 响应式：单/双/三列 **全部完成** | — |
| P3 | 电池白名单引导、原生桥 | Android 平台适配 |
| P3 | arm64 真机 | 有设备即跑 DC/SC/LT/RST |

## 7. 一句话

**设计的主干（单一 Host、协议、审批、租约、持久化、常驻）是照做的，且部分指标超出设计；
但 ADR-0003 的功能矩阵只完成了“聊天 + 审批 + 继续”这一竖条，diff/文件/附件/搜索/配对仍是空白。
这些是负向偏差，不是“正向简化”——按上表 P0→P2 补齐。**

## 8. 2026-11-03 追加（长程目标模式 + 远程 B1–B4；与上文冲突时以本节为准）

- **长程目标模式已实现并真机通过**（`ADR-0006`）：不是"每轮短步目标"，而是"稳定契约 + 一次只读深规划 +
  阶段证据验收 + 受控版本化重规划"。G5 真机：3 阶段全部 `done`、契约验收 A1–A4 全过、340s
  （读数见 `docs/architecture/GOAL-MODE-VERIFICATION.md`；桌面全量判据见 `src/test/goal-runner.test.ts`）。
- **手机可新建会话/项目**（G-1 已补齐）：`session.create` / `project.list` / `project.create` 写桌面同一份库，
  手机面板含项目选择与新建项目；经**真实 Cloudflare 隧道**端到端验证（配对 → 建会话 → 撤销后 401）。
- **B4 跨网**：隧道 + `Secure` cookie + Host/Origin 白名单 + 单设备撤销实测通过
  （`.preview-shot/b4-tunnel-report.json`；说明见 `docs/architecture/REMOTE-ACCESS-TUNNELS.md`）。
- 因此 §7 的「diff/文件/附件/搜索/配对仍是空白」**已过期**：这些在 1.17.0 已落地（见 §4/§5）。
  仍然空白的是：**原生桥（相机/通知/分享/剪贴板）、电池优化白名单引导、arm64 真机/OEM 后台策略**。
- arm64 说明更新：本机 x86_64 Windows 上 QEMU2 **拒绝** arm64 系统镜像
  （`Avd's CPU Architecture 'arm64' is not supported by the QEMU2 emulator on x86_64 host`），
  所以「arm64 真机」仍是缺口；**不能**把 x86_64 设备用例通过当成 arm64 通过。
- 跨网补充：真实 Cloudflare 隧道、本地 TLS 反代两条 Host 分支（`*.ts.net` /
  `CODEM_GATEWAY_ALLOWED_HOSTS` 自有域名）、**真实 Tailscale tailnet** 路径，以及
  **Tailscale 官方 Serve + Funnel** 均通过（控制台已开启；`tailscale serve/funnel --bg 41873`，
  `https://win-6rsgb5ac85l.taile10bc6.ts.net/` 实测配对/建会话/撤销）。
  工具侧另修：`execute_command` 子进程 stdin=null，交互式 `npx` 不再挂住
  （判据 `exec_stdin_closed_so_interactive_prompts_fail_fast` /
  `exec_spawn_config_must_null_stdin`，含变异自证）。
