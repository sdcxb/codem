# 09 · 当前状态、未完成项与风险（2026-11-03 快照）

> 基线：`master` @ 代码提交见 `git log -1`（v1.18.0 已发布）｜ **1.18.0**（2026-11-03 发布，GitHub `Latest`；上一稳定版 1.17.0）
>
> 1.18.0 包含：长任务目标模式（阶段契约 + 证据验收 + 重启/压缩恢复）+ Flutter 原生 Android 客户端预览 +
> Tailscale Serve 零配对码 + 远程新建项目/会话 + 交互式命令 stdin 修复；Funnel/公网仍保留配对码。
> 本文是“现在到底能不能用、哪些没验、哪些别碰”的唯一当前口径。它**会过期**；每个版本更新一次。

---

## 1. 版本与发布

| 项 | 值 | 核对方式 |
|---|---|---|
| 版本 | **1.18.0**（2026-11-03 发布） | `package.json` / `src-tauri/tauri.conf.json` / `src-tauri/Cargo.toml` |
| 发布 | GitHub `Codem v1.18.0` = **Latest**（2026-11-03） | `gh release list --limit 1` |
| 更新清单 | `latest.json` = 1.18.0（发布时上传并远端校验） | 根目录文件 |
| HEAD | 以 `git log -1` 为准（v1.18.0 已发布） | `git rev-parse --short HEAD` |
| 分支 | `master`；v1.18.0 已提交并推送 | `git status -sb` |
| 本地 tag | 最新为 **v1.18.0** | `git tag --sort=-creatordate \| Select-Object -First 5` |

> **不要用本地 tag 判断发布状态**：以 `gh release list` 与 `latest.json` 为准。

---

## 2. 工作区状态（v1.18.0 已提交）

```text
## master...origin/master
# v1.18.0 已提交并推送；仅 .codem/ 运行时文件未跟踪
```

- v1.18.0 的目标模式 / Flutter 客户端 / 零码网关改动已提交并推送。
- `art/`、`prototype/`、`docs/ref-analysis/` 等未跟踪内容不属于本次发布，未提交。
- `docs/` 总计约 309 MB，根级 173 份 `.md` + 本套文档；混有大量历史稿与游戏美术。

---

## 3. 验证基线（2026-11-03 实测）

| 检查 | 结果 |
|---|---|
| `npx tsc --noEmit` | **0 错误** |
| `npx vitest run` | **874 文件 / 9527 用例：9510 通过、17 跳过、0 失败**（约 186s；2026-11-03 工作区实测，含目标模式/远程/零码新增判据） |
| `cargo test --lib` | **241 passed / 2 ignored / 0 failed**；其中网关 46 项 |
| `cargo check` | exit 0（**0 error**） |
| `flutter analyze` / `flutter test` | 0 issue / **10 passed** |
| `npm run audit:docs` | 通过（version=1.18.0；`docs:sync` 基线 874 文件 / 45 表 / 118 命令注解） |
| 已知失败 | **0** |

### 3.1 本轮没有已知失败

- 全量 874 文件 / 9527 用例：9510 通过、17 跳过、0 失败；`tsc` 0；
  Rust 241 通过 / 2 ignored；Flutter 10 通过。
- 历史：2026-10-26 曾有两条**未跟踪文档**导致的失败（BOM / 缺历史横幅），随未跟踪内容清理而消失，不是产品代码修复。
- 纪律不变：新文档 UTF-8 **无 BOM**；新增 `*PLAN*` / `*GAP*` / `*TODO*` 文件要么加「历史文档（不再维护）」横幅，要么改名。

### 3.2 测试规模为什么与文档不一致

- `AGENTS.md` 正文写 **699 文件 / 8344 用例**（1.16.323 时代）；
- `docs/HANDOVER-2026-10-17.md` 写 **722 / 8446**（1.16.329 时代）；
- 1.16.334 时是 **839 / 9147**；1.17.0 发布时 **865 / 9449**；1.18.0 发布时 **874 / 9527**（目标模式/远程/零码新增判据）。
- 这些数字会随测试增删变化；以 `npx vitest run` 为准，不要从旧文档抄。

---

## 4. 当前可用的能力（已验证/可用）

| 能力 | 证据级别 | 备注 |
|---|---|---|
| 桌面远程网关（PC 远程唯一入口） | 判据 + Android 15 x86_64 模拟器设备用例 | 手动启动；loopback + adb reverse / 外部通道；发消息 / 流式 / 审批 / 取消 / 文件树 / 预览 / diff / 变更 / 新建项目与会话；附件按 Host 能力位开关，远程网关当前未开放 `attachment.put` |
| 长任务目标模式 | 判据 + 真机注入 | 多阶段契约、阶段验收、自动续跑、重启/压缩恢复、证据化重规划；不自动批准 |
| Flutter 原生 Android 客户端 | 判据 + x86_64 模拟器 | 会话/流式/工具/审批/项目/文件/改动/主题/主机切换；**arm64 未上真机** |
| Android 本机模式 | 判据 + Android 15 x86_64 模拟器 | 独立 Host / 数据 / 项目；本机模型 Keystore；随机端口 + 本地鉴权；**arm64 真机未验** |
| 共享 UI（手机 / 平板） | 判据 | 只读 / 可写由能力表决定；平板双列 / 三列；diff 渲染统一；手机端显示当前连的是 PC 还是本机 |
| 主对话 / 流式 / 工具调用 | 判据 + 真机 | 日常主路径 |
| 压缩（手动） | 判据 + 真机 | 回执“保留最近 20 条、最近 3 轮不切断” |
| 压缩（自动） | 判据 | **真机完整验证未完成**（见 §5.1） |
| 记忆（提取/审批/注入） | 判据 + 真机 | 一轮真实对话新增 2 条；审批降噪已验 |
| 项目工作台机制 | 判据 + 真实项目 | 3 thread / 3 worktree / 3 报告 / gate / 冲突 / 审批 |
| 项目工作台“真实模型 3 并发” | **未证明** | R3 机制通过，但真实模型 3 并发未产出报告 |
| 免费模型插件 | 判据 + 真机 | 上游硬拒 10 个；可见 13 个 |
| DeepSeek 搜索/抓取 | 判据 + 真机 200 | `web_search` 347/352/290ms；`web_fetch` 6,402 字 |
| Windows 真 bash（shell-ops） | 判据 + 真机 | 找不到 bash 会大声失败，不退回 PowerShell 5.1 |
| 三皮肤 / 23 设置分区 | 判据 + 真机走查 | UI 工艺 P2 已验 |
| 删除运行中会话 | 判据 + 真机 | 立即杀命令树 + 墓碑短路；无 FK/无残留 ping |
| 启动维护延迟 30s | 判据 + 真机 | 避开首屏与首条输入 |

---

## 5. 未完成 / 未验证（不要写成“已完成”）

### 5.0 1.17.0 远程与 Android 本机（已交付 / 仍有缺口）

- 已完成：桌面远程网关 M1–M3（只读 → 写 / 审批 / 取消 / 事件流 → 文件树 / 预览 / diff / 变更）；共享 UI 与能力表；
  一次性 6 位配对码 + HttpOnly cookie + 设备上限 8；敏感文件读审批；旧 LAN/TLS/二维码配对与桌面 Host sidecar 删除。
- 已完成：Android 本机模式（自包含 APK、设备内 Host、本机回合、本机模型 Keystore + 保存后热重启 Host、随机端口 + 本地鉴权）。
- 自动化：`tsc` 0；网关/主机判据见 `src/test/host-*.test.ts`、`src/test/gateway-*.test.ts`、`src/test/remote-*.test.ts`、
  `src/test/ui-*.test.tsx`；Android 设备用例脚本在 `android-shell/`。
- **真机覆盖**：Android 15 x86_64 模拟器通过（`docs/architecture/ANDROID-VERIFICATION.md`）；
  arm64 的 PRoot / WebView / 厂商保活 **未验证**。
- **M2 剩余诚实缺口**（ADR-0005 §7）：`run.guidance`、`session.create`、`attachment.put`、
  `session.get` 的工具行形状与 `hasMore` ⇒ 手机暂不能新建会话、上传附件、运行中追加引导。
- **网关只绑 `127.0.0.1`**：手机需 adb reverse 或外部通道；跨网 / NAT / 公网场景未验证。
- **撤销粒度**：停止网关 = 撤销全部已配对设备；没有单设备撤销 UI（设备上限 8）。
- 旧上下文检查点（1.16.334）的证据仍有效，见 `18-CONTEXT-CHECKPOINT-DESIGN.md` / `19-CONTEXT-CHECKPOINT-CRITERIA.md` 与 `CHANGELOG.md`，本条不再重复。

### 5.1 自动压缩（2026-10-29 已真机验证）

- 已验两次（打包 exe + 隔离副本）：① 真实 256 条会话、副本窗口 200k —— 横幅、visible 23 / hidden 239、
  标记 1、刷新后仍在；② 默认 1M 窗口 + 600 条合成会话 —— visible 23 / hidden 581、标记 1、刷新后仍在。
- 仍然没验的一点：**真实用户的 80 万 token 长会话**（机制相同，只是没等到这种会话）。
- 成本面板：已补 `kind="compaction"` + 历史页标签「上下文压缩」（判据 `USAGE-LABEL` / `D6-D`）；
  老记录没有 `kind`，按普通对话显示，不编造。
- 历史说明：1.16.319 只验了手动压缩；1.16.328/329 改阈值与折叠后，旧真机证据不覆盖新形态 —— 上述两次是改后重验。

### 5.2 项目工作台的真实模型 3 并发

- `docs/PROJECTS-MVP-REVIEW.md` §9 明确：R3 用真实会话/worktree/代码任务/gate 跑通，但“真实模型 3 并发跑任务时连续失败/委派等待循环，没有产出报告”；上面的任务是用确定性命令完成并写报告的。
- 结论：**机制可收口；“真实模型多 thread 稳定性”仍未证明**。
- 在它通过前，不应把“项目工作台”标成完全可用。

### 5.3 免费模型的上游限制

- 上游 `/v1/models` 给 26 个；真机可见 13 个；另 13 个被可用性结论隐藏——其中 10 个是上游硬拒（`OpenCode's free tier can only be used from within OpenCode…`），3 个是其它失败/超时。
- `catalog.json` 只对 `kiloRows` 16 条给 `vision`；**没有模态依据的 10 个恰好就是被硬拒/隐藏的那 10 个** ⇒ 真机看不到 `【未知】`。
- 用户已裁定“超时标成不可用没问题”；不要按“瞬时失败被当不可用”去改探测口径。
- 可选：给没有依据的模型发极小图片实测模态（接受=多模态、明确拒绝=文本、其它=未知）。

### 5.4 托盘退出 / 黑框

- 托盘“退出”是否一下就退、还有没有黑框：端到端计时**未验**；退出路径已改成“发出去不等”（有判据+变异）。

### 5.5 297 波遗留四项

- Job Object `KILL_ON_JOB_CLOSE`；
- WebView2 去节流；
- 回退/假绿守卫；
- npx 税。
- 这些是已知未做项；不要重复“发现”，先看是否有新的用户授权。

### 5.6 其他已知限制

- **worktree 合并冲突**：已有「冲突文件列表 + 逐个打开 + 选一边合并/回滚」，**逐文件选 ours/theirs/both 未做**；
- **PR/CI**：只读同步；不创建/合并/修 CI；
- **真实模型并发**：自动化重复触发已加并发上限，但“3 并发稳定产出报告”未证明；
- **`needs_you_pending` / `agent_messages`**：**已补（2026-10-29）**——走通用 `crud.upsert/list/delete` 写穿与重启回填（表早就有，之前只写内存）；判据 `PENDING-PERSIST` PP-1..4；
- **`session_events`**：**已补（2026-10-29）**——`events.archive_before` 按 `keep_types` 保留语义事件
  （`session_meta` / `compaction` / `tool_call` / `tool_result`），其余 >90 天事件先写
  `archives/events/<date>/<session>.jsonl` 再删；维护每天最多一次、每次最多 100 会话；
  可回退：设置 `codem-event-retention { enabled:false }`；
- **`execute_command` 的工作区校验：已决定不做**（不是缺口）。只读越界是必要能力（用户明确裁定）；
  历史上 5–6 次用 `cwd`/字符串判定收紧，都因误伤正常命令（git/npm/跨目录只读）而回退。
  要做只能是 OS 级沙箱（Job Object / 受限令牌），属独立产品决策；**不要再按“加一个工作区校验”重试**。
- **`read_file` base64 分支**：绕过 50 MB 上限；
- **宠物窗 capability**：与主窗共用，自定义命令理论上可调全部（推断，未运行验证）。

---

## 6. 结构债与风险（按影响排序）

| # | 风险 | 影响 | 证据 |
|---:|---|---|---|
| 1 | `session_events` 增长 | **已缓解（2026-10-29）**：90 天前的高频事件先归档 JSONL 再删，语义事件永久保留；见 `event-archive.ts` / `events.archive_before` | `maintenance.ts`、`event-archive.ts` |
| 2 | `execute_command` 不做工作区校验（**设计取舍，非缺口**） | 只读越界是必要能力；写文件的沙箱仍独立生效；历史上多次收紧均误伤正常命令后回退（见 §9） | `lib.rs:2243-2491` |
| 3 | 无 Job Object，只 `taskkill /T /F` | 退出/超时可能留孤儿进程 | 全仓 0 命中 `JobObject` |
| 4 | 桌面网关只绑 `127.0.0.1` | 手机开箱不能跨网访问；需要 adb reverse / 外部通道，跨网未验证 | `phone/gateway/mod.rs` `BIND_ADDR` |
| 5 | `message_count` 多口径 | 计数可能偏差，靠维护对账自愈 | `repo.rs:1052/1964`、`session.ts:686` |
| 6 | 软删三态易分叉 | `hidden=0,trimmed=1` 矛盾态；压缩消息可能复活 | `repo.rs:1255`、`session-jsonl.ts:184` |
| 7 | 中文 FTS 依赖一次性重建 | 老 FTS4 库不重建则中文搜索 0 条 | `bootstrap.ts:584-638` |
| 8 | 镜像预算可把“读不到”伪装成“没内容” | 面板空列表；用户以为数据丢了 | `rust-port.ts:2928-2955` |
| 9 | 数据根两来源 | `CODEM_DATA_HOME` 与 `legacyDbPath` / 设置文件不一致 | `bootstrap.ts:863-870` |
| 10 | 设置分区 23 vs 文档 22 | 文档/走查口径不一致 | `SettingsPanel.tsx` |
| 11 | 网关设备撤销只有“停止 = 全部撤销” | 单台设备丢失只能全部重配 | `phone/gateway/pairing.rs` |
| 12 | Android arm64 未验证 | PRoot / WebView / 厂商保活可能失败 | `docs/architecture/ANDROID-VERIFICATION.md` |
| 13 | dream 皮肤缺 6 个语义令牌 | 状态色/浮层底不随梦幻皮肤 | `skin-dream.css` 0 处 |
| 14 | 巨型单文件 | 改 CSS/App/Settings 风险高、review 难 | `styles.css` 21.5k 行、`App.tsx` 6.4k |
| 15 | 视觉回归资产在 `.preview-shot/` | 干净 clone 无法复跑像素/CDP 取证 | `.gitignore:143` |

---

## 7. 文档债（这次重编要解决的）

| 文档 | 最后口径 | 问题 |
|---|---|---|
| `docs/PROJECT-GUIDE.md` | 823 KB；头部已更新为 2026-11-03（v1.17.0 待发布），但正文“当前状态”仍是 1.16.305 | 版本/测试数/目录树/文档导航都过时；太大，没人通读 |
| `AGENTS.md` | 顶部 1.16.334，正文 1.16.323 | 正文的状态/评测叙述仍偏旧；以本套为准 |
| `docs/NEW-SESSION-START.md` | 1.16.319 | 待办/版本/测试数过时 |
| `docs/HANDOVER-2026-10-17.md` | 1.16.329 | 三条主动脉仍有效；命令面“全在 lib.rs”等细节过时 |
| `docs/GAP-LIST.md` | 最高记录 1.16.305 | 声称“唯一当前缺口清单”，但 1.16.306–330 未回填；机器状态停在 1.16.181 |
| `docs/TODO.md` | 旧 | 与 GAP-LIST 重复；多数已做完 |
| `docs/CODEM-FEATURES.md` / `项目功能树-全量.md` | 2026-09-09/10-22 | 2779 条叶子仍有用，但不含 10 月项目工作台/OFM 等新增 |
| `docs/UI-DESIGN-SYSTEM.md` | 877 行 | 至少 3 处计数过时（1.4 万行、22 分区） |
| `docs/` 根目录 | 根级 173 md + 本套文档 / 309 MB | 大量历史稿、游戏美术、截图；文件名像“当前待办”的很多已过期 |

**本次处理**：新增 `docs/project-guide/` 一套并列文档，不改旧文档内容；`README.md` 写明新旧关系。是否给旧文档顶部加指针/归档，等团队确认。

---

## 8. 建议的下一步（按优先级，供接手者参考）

### P0：1.18.0 发布收尾

1. 三处版本号已改 1.18.0、`package-lock` / `Cargo.lock` 已同步；`npm run docs:sync` + `audit:docs` 已过；
2. 构建 + 签名 → 生成并校验 `latest.json` → `gh release create v1.18.0`（只发稳定版，建完抢回 `Latest`）；
3. 1.18.0 工作区改动按显式路径提交（**不要 `git add -A`**，不要把 `art/`、`prototype/` 带进去）；
4. 发布后复核 5 个资产、`Latest` 与 `verify-update-manifest.mjs --remote`。

### P1：远程与 Android 的关键“未验证”

4. arm64 Android 真机：PRoot / WebView / 厂商保活；
5. M2 诚实缺口：`run.guidance`、`session.create`、`attachment.put`、`session.get` 形状与 `hasMore`；
6. 单设备撤销 UI；跨网 / NAT 通道真机；
7. 自动压缩的“真实 80 万 token 会话”；项目工作台真实模型 3 并发；托盘退出计时；免费模型模态实测（可选项）。

### P2：结构债（需要产品/风险取舍）

8. ~~`execute_command` 的工作区/沙箱边界~~（**已决定不做**：只读越界必要，历史多次收紧回退；见 §5.6/§9）；
9. Job Object `KILL_ON_JOB_CLOSE`；
10. ~~`needs_you_pending` / `agent_messages` 落库~~（**已补**；见 §5.6，判据 `PENDING-PERSIST`）；
11. ~~`session_events` 的保留/归档策略~~（**已补**；90 天 + 语义事件保留 + JSONL 归档，见 §5.6）；
12. worktree 合并冲突逐文件选边 UI（列表/打开/整体选边已有，逐文件未做）；
13. dream 皮肤令牌：定义/注入/回退已有（`skin-dream.css` + `--dream-*`）；只剩「值优先编号 → 语义命名」可选；
14. ~~`ChatPanel.showWorkbench` / `SpaceSwitcher`~~（**已删除**；Sidebar 只剩一行注释，2026-10-29 核实）。

> 这些是建议，不是承诺。涉及产品取舍/发版的，先问用户。

---

## 9. 不要重复劳动（已被证否/已决定不做）

- **E1+E2（把变更追踪搬到回合边界）**：B 切片已吃掉大头收益，剩余约 0.6% ⇒ 不做。
- **持久 pwsh 会话**（对标 DSH 常驻 shell）：只影响每次命令 ~256ms 地板，落在客户端 1.1% 邻域 ⇒ 不做。
- **应用内自扫搜索性能**（约 1.9% 墙钟）：需 Rust 原生搜索/新增依赖，风险大于收益 ⇒ 暂不做。
- **297 波遗留四项**：见 §5.5；没有新授权不要动。
- **给 `execute_command` 加工作区校验**：已决定不做（§5.6）。只读越界必要；历史上 5–6 次收紧都因
  误伤 git/npm/跨目录只读而回退。要真做只能上 OS 级沙箱，别再写 cwd/字符串判定。
- **用提示词治本**：真机验证过提醒不是分水岭；不要用“再加一段提示词”代替结构修复。
- **短步目标模式 / 每轮改目标 / 用 DSH goal mode 开发本仓库**：仍然禁止（2026-10-15）。**长程里程碑目标模式**是产品能力，允许（ADR-0006）。
- **按标题相似度挑会话交接**：已修；必须用 `handoff_to_new_session`。
- **免费模型“超时=不可用”**：用户已裁定没问题；不要改探测口径。
- **恢复桌面 Host sidecar / 旧 LAN·TLS·二维码配对 / 自建中继当 PC 远程入口**：已删除；PC 远程只走桌面网关，Host 只服务 Android 本机。
- **让 Host 接管桌面数据 / 桌面与手机共用数据库**：ADR-0004 Phase 3 已取消（ADR-0005），不要再做迁移。
- **给手机再写一套聊天 UI**：共享 UI 是唯一实现，行为漂移无法测。

---

## 9.5 长程目标模式 + 远程新建/隧道（v1.18.0 已交付）

> 详细读数：`docs/architecture/GOAL-MODE-VERIFICATION.md`；设计：`ADR-0006`、`REMOTE-ACCESS-TUNNELS.md`。

- **长程目标模式**（不再禁止；仍禁止「短步目标 / 每轮改目标 / 用 DSH goal mode 开发本仓库」）：
  多阶段消息自动进入 → 只读深规划（3–12 阶段 DAG）→ 阶段执行复用 `executeSessionTurn` →
  确定性验收（命令/测试/工件）→ 证据触发重规划（保留已完成阶段）→ 预算默认无限。
  设置项：`codem-goal-mode` / `codem-goal-resume` / `codem-goal-budget`；状态条在输入区上方。
- **真机 G5 已通过**：3 阶段全部 done、契约验收 A1–A4 全过、340s / 2039 tokens / 11 条证据 / 8 条决策。
- **手机远程新建会话/项目**：`session.create` / `project.list` / `project.create` 写桌面同一份库；
  手机面板有项目选择、新建项目、失败原因可见。
- **网关 B2**：默认随桌面自启（`codem-gateway-autostart`）；设备表落盘（只存 token sha256）；
  优先 `127.0.0.1:41873`；设置页可看设备并单台撤销；**重启桌面后旧 cookie 仍有效**（真机 7/7）。
- **B4 跨网**：真实 Cloudflare quick tunnel、真实 Tailscale tailnet、TLS 反代两条 Host 分支全部通过；
  Tailscale 控制台已开启 HTTPS + **Serve + Funnel**，`tailscale serve/funnel --bg 41873` 后
  `https://win-6rsgb5ac85l.taile10bc6.ts.net/` 实测配对/建会话/撤销全过（`tailscale-live-report.json`）。
  Funnel 是公网入口；不需要时 `tailscale funnel --https=443 off`。
- **B3 Android**：x86_64 模拟器 **26/26** 设备用例通过（新建会话/真跑一轮/审批/继续/深链/附件/文件/响应式/无崩溃）；
  Doze `force-idle` 后 Host 进程仍存活；**arm64 无法在本机验证**（QEMU2 在 x86_64 主机拒绝 arm64 镜像）。
- **工具挂起已修**：`execute_command` 子进程 stdin = null（交互式 `npx` 不再等输入），
  判据 `exec_stdin_closed_so_interactive_prompts_fail_fast` + `exec_spawn_config_must_null_stdin`。
- **仍未验证/未做**：原生客户端第二台 Tailscale 手机闭环、相机/音频/富媒体、电池优化白名单引导、OEM 后台策略、arm64 真机。

---

## 9.6 Flutter 原生 Android 客户端（v1.18.0 预览）

> 设计：`docs/design/MOBILE-DESIGN.md`；ADR：`docs/architecture/ADR-0007-NATIVE-ANDROID-CLIENT.md`。

- 新增 `mobile/` Flutter 工程（包名 `io.codem.codem_mobile`），原生 UI 取代 WebView 作为主手机端；
  `android-shell` 保留为历史/调试壳。
- 已落地：设计 tokens/主题/组件、会话列表、聊天流式、工具卡、审批、停止、主机列表/切换、
  项目、改动 Sheet + diff、文件树/文件预览、系统通知、前台服务、系统分享、
  深/浅主题、演示数据；图片选择/上传在本地 Host/演示可用，远程网关未开放
  `attachment.put` 时入口会按能力位禁用（不画一个点了必失败的按钮）。
- 零配对码：Tailscale Serve 注入 `Tailscale-User-Login` 时，网关在
  loopback + `*.ts.net` + 非 Funnel 三项都满足时自动登记设备并下发 cookie；
  同一登录 + 同一设备名只保留一台，撤销后进 deny-list，需配对码重新认领。
  Funnel/公网/自定义反代仍走 6 位配对码。
- 协议复用：`host.hello`、`session.list/get/watch/changes/change.diff`、`project.list`、
  `prompt.send`、`run.cancel`、`approval.respond`、`workspace.list/read`；附件方法
  仅在 Host 能力位支持时使用。
- 验证：`flutter analyze` 0 issue；`flutter test` 10/10；x86_64 release APK 安装到模拟器并截图；
  Release 另附 `Codem-Mobile-1.0.0-arm64.apk`（arm64-v8a，debug 签名预览）；
  `CodemForegroundService` 实测 `isForeground=true`（通知渠道 `codem.connection`）。
- 已知限制：本机 Host 启动/发现未接；cookie 暂存 SharedPreferences
  （正式发布前换 Keystore）；arm64 预览包已提供但发布环境未做完整真机回归。

---

## 10. 30 秒核对命令

```powershell
git status -sb
git log --oneline -3
npx tsc --noEmit
npx vitest run
gh release list --limit 3
node tools/audit/scan-report-sites.mjs --check
```

如果这些与本文不一致：**以实测为准**，并更新本文。
