# 09 · 当前状态、未完成项与风险（2026-10-30 快照）

> 基线：`master` @ 代码提交见 `git log -1`（1.16.333 发布提交）｜ **1.16.333**（2026-10-30 发布）
>
> 1.16.333 包含通用修复：subagent refusal/aborted/error → `isError`。
> 本文是“现在到底能不能用、哪些没验、哪些别碰”的唯一当前口径。它**会过期**；每个版本更新一次。

---

## 1. 版本与发布

| 项 | 值 | 核对方式 |
|---|---|---|
| 版本 | **1.16.333** | `package.json` / `src-tauri/tauri.conf.json` / `src-tauri/Cargo.toml` |
| 发布 | GitHub `Codem v1.16.333` = **Latest**（2026-10-30 发布） | `gh release list --limit 1` |
| 更新清单 | `latest.json` version 1.16.333 | 根目录文件 |
| HEAD | 以 `git log -1` 为准（1.16.333 发布后修复提交） | `git rev-parse --short HEAD` |
| 分支 | `master`，与 `origin/master` 同步 | `git status -sb` |
| 本地 tag | 最新为 **v1.16.333** | `git tag --sort=-creatordate \| Select-Object -First 5` |

> **不要用本地 tag 判断发布状态**：v1.16.322–330 的 GitHub Release 存在，但本地 tag 列表没跟上（可能未拉取/未创建本地 tag）。以 `gh release list` 与 `latest.json` 为准。

---

## 2. 工作区状态（不是干净树）

```text
## master...origin/master
 M .gitignore
 M .jscpd.json
?? .edge-ref-profile/
?? .edge-ref-profile2/
?? .edge-ref-profile3/
?? .edge-shot/
?? art/
?? docs/ref-analysis/
?? prototype/
```

- `.gitignore` / `.jscpd.json` 的修改是为 `rich4-renew-app` 研究克隆加忽略项（GPL-3.0 参考，不入库）。
- `art/`（1727 文件）、`prototype/`（2330 文件）、`docs/ref-analysis/`（游戏原版地图研究）都是**未跟踪**的大块内容。
- `docs/` 总计约 **309 MB**；根级 **173 份 `.md`** + 本套文档；跟踪数用 `git ls-files docs` 查；混有大量游戏美术 PNG/JPG 与历史稿。
- **不要 `git add -A`**；只 `git add` 你真正要提交的显式路径。

---

## 3. 验证基线（2026-10-30 实测）

| 检查 | 结果 |
|---|---|
| `npx tsc --noEmit` | **0 错误** |
| `npx vitest run` | **796 文件 / 8842 用例：8825 通过、17 跳过、0 失败**（约 160s） |
| 已知失败 | **0** |

### 3.1 2026-10-26 那两条失败已经消失

- 当时的形态：① `no-bom.test.ts` 报 18 个**未跟踪**游戏文档带 BOM；② `docs-current-gap-list.test.ts` 报两份 `MONOPOLY-*PLAN*.md` 缺历史横幅。
- 2026-10-29 实测两条都绿：未跟踪内容本身变了（BOM 已去除、部分文件已删），**不是产品代码修复**。
- 纪律不变：新文档 UTF-8 **无 BOM**；新增 `*PLAN*` / `*GAP*` / `*TODO*` 文件要么加「历史文档（不再维护）」横幅，要么改名。
- 本轮的判据增量见 `16-MCODE-STACK-AUDIT.md` §5（4 个新判据文件 + 25 条用例）。

### 3.2 测试规模为什么与文档不一致

- `AGENTS.md` 正文写 **699 文件 / 8344 用例**（1.16.323 时代）；
- `docs/HANDOVER-2026-10-17.md` 写 **722 / 8446**（1.16.329 时代）；
- 当前实测 **796 / 8842**（2026-10-30；`AGENTS.md` 与正文已对齐）。
- 这些数字会随测试增删变化；以 `npx vitest run` 为准，不要从旧文档抄。

---

## 4. 当前可用的能力（已验证/可用）

| 能力 | 证据级别 | 备注 |
|---|---|---|
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

### 5.0 上下文检查点（2026-10-30 代码完成 + 隔离真机冒烟）

- 已完成：压缩只写 marker + `metadata.contextEpoch`，不再 hidden/墓碑；主对话默认完整时间线，可切模型视图；
  完整历史面板、打开会话自动 best-effort 回填 + 手动重试、回滚维护入口（带确认）、spill 默认永久保留、
  水位优先使用最近一次真实请求的 `promptTokens`（可见 id 集合一致时），不一致才退回
  system/tools/消息估算；时间线分块渲染（主对话 120、面板 80，可「载入更早」）；
  `context_epochs` 派生索引表（从 marker metadata 投影，供审计/查询，不参与同步读）；
  spill 全文查看（缺文件如实报「已丢失或读不到」）。
- 自动化：`tsc` 0；全量 796 文件 / 8842 用例 / 8825 通过 / 17 skipped / 0 失败；`npm run build` 成功；
  knip/可达性/上报点/变异/CSS/UI 门禁全绿。
- **隔离真机冒烟（2026-10-30，release exe + 用户库副本 + `CODEM_DB_PATH`）**：
  ① 含 217 条旧 hidden 的会话显示「完整历史 278 / 模型 61」，滚到顶部能看到旧 hidden 原文；
  ② 切「模型视图」后旧 hidden 消失（6 个 bubble），切回完整历史恢复；
  ③ 「回填旧历史」追加 117 条、已有 100 条、失败 0，JSONL 从 288 行增至 405 行；
  ④ 页面 reload 后仍是 278 / 61，旧 hidden 原文仍在完整历史；
  ⑤ **静默安装 1.16.333 后**在同一副本上复跑 ①③：完整历史 278 / 模型 61、回填 117+100/0；
  ⑥ 写 `codem-index-rebuild-needed.json` 并重启，维护从权威日志重建：索引 278 行、hidden 217 保留、
     模型视图仍 61、旧 hidden 原文仍在，标记被清除；
  ⑦ 合成检查点会话「6 历史 / 4 模型」，点「回滚到旧版」：cutoff 前 2 条写回 hidden、0 失败，正文长度不变；
  ⑧ spill 目录经安装后 app 的 Tauri `delete_directory_permanent` 真机删除成功；会话删除 wiring 由 `SPILL-8` 守；
  ⑨ **不点按钮**打开含旧 hidden 的会话：自动回填触发，日志 278 → 405 行后由日志压缩收敛为 278 个唯一 id，
     其中 117 条为 `hidden=1`；完整历史 278 / 模型 61 不变；
  ⑩ 反例真机：删掉 `context_epochs` 表 + 塞一条坏 JSON marker + 一条合法 marker 后启动安装版——
     表被 schema 自动重建，面板「检查点索引 1」，坏 marker 被忽略，历史 280 / 模型 2，不崩；
  ⑪ **真实 UI 删除会话**：新建 `ADV DEL E2E` + 该会话 spill 文件，点删除并确认后，DB 会话行消失、
     `spill/adv-del-session` 目录消失；
  ⑫ **缺失 spill 查看**：合成带工具调用的会话（JSONL + 索引），展开工具组/工具卡点「查看溢出全文」，
     弹层如实显示「全文文件已丢失或读不到：系统找不到指定的路径 (os error 3)」；
  ⑬ **完整历史虚拟列表（2000 条）**：安装版打开面板，`data-virtual-total=2000`，底部只挂 8 个消息节点
      （start=1992/end=2000）；滚到顶部只挂 15 个（start=0/end=15），上下留白撑起 126,182px 滚动高度。
  ⑭ **主对话虚拟列表（2000 条）**：安装版打开会话底部只挂 10 个 `.message-bubble`，滚动高度 266,530px；滚到顶部仍只挂 10 个，顶部可见「主对话虚拟消息 0」，底部消息 1999 不再挂载。
- 已无“未验主链路”；完整历史与主对话都已改为**可视区虚拟列表**（主对话 >160 条启用，小会话 fail-open 全量）。
- 设计取舍：`context_epochs` 是**派生索引**（`messages.metadata` 仍是权威，同步读不依赖表）；
  完整历史按测量高度计算窗口 + 上下留白；主对话按块估算窗口 + 上下留白（>160 条启用），未知视口 fail-open；回滚必须二次确认。

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
| 4 | `needs_you_pending` / `agent_messages` 有表无实现 | 队列不持久化；重启丢失 | `needs-you-queue.ts:8`、`agent-message-queue.ts:8` |
| 5 | `message_count` 多口径 | 计数可能偏差，靠维护对账自愈 | `repo.rs:1052/1964`、`session.ts:686` |
| 6 | 软删三态易分叉 | `hidden=0,trimmed=1` 矛盾态；压缩消息可能复活 | `repo.rs:1255`、`session-jsonl.ts:184` |
| 7 | 中文 FTS 依赖一次性重建 | 老 FTS4 库不重建则中文搜索 0 条 | `bootstrap.ts:584-638` |
| 8 | 镜像预算可把“读不到”伪装成“没内容” | 面板空列表；用户以为数据丢了 | `rust-port.ts:2928-2955` |
| 9 | 数据根两来源 | `CODEM_DATA_HOME` 与 `legacyDbPath` / 设置文件不一致 | `bootstrap.ts:863-870` |
| 10 | 设置分区 23 vs 文档 22 | 文档/走查口径不一致 | `SettingsPanel.tsx:646` |
| 11 | `ChatPanel.showWorkbench` 不可达 | 分屏工作台永不出现 | `ChatPanel.tsx:350,948,1347` |
| 12 | `SpaceSwitcher` 孤儿 | 无“工作空间切换”UI | `Sidebar.tsx:14,601` |
| 13 | dream 皮肤缺 6 个语义令牌 | 状态色/浮层底不随梦幻皮肤 | `skin-dream.css` 0 处 |
| 14 | 巨型单文件 | 改 CSS/App/Settings 风险高、review 难 | `styles.css` 19k 行、`App.tsx` 6.2k |
| 15 | 视觉回归资产在 `.preview-shot/` | 干净 clone 无法复跑像素/CDP 取证 | `.gitignore:143` |

---

## 7. 文档债（这次重编要解决的）

| 文档 | 最后口径 | 问题 |
|---|---|---|
| `docs/PROJECT-GUIDE.md` | 823 KB；头部写“最后更新 2026-10-23（v1.16.333）”，但正文“当前状态”仍是 1.16.305 | 版本/测试数/目录树/文档导航都过时；太大，没人通读 |
| `AGENTS.md` | 1.16.323（本次已改顶部版本/测试数） | 正文的状态/评测叙述仍偏旧；以本套为准 |
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

### P0：把“当前事实”固定下来

1. 评审并采纳这套 `docs/project-guide/`；
2. 决定两条测试失败的处理（去 BOM / 加历史横幅 / 保持现状并在 CI 里排除未跟踪文件）；
3. 把 `.gitignore` / `.jscpd.json` 的未提交修改与 `art/`、`prototype/`、`docs/ref-analysis/` 的去留拍板（提交、忽略、还是移出仓库）。

### P1：补最关键的“未验证”

4. ~~自动压缩真机完整验证~~（2026-10-29 已完成，见 §5.1；剩"真实 80 万 token 会话"与"成本面板标签"两点）；
5. 项目工作台真实模型 3 并发稳定性；
6. 托盘退出端到端计时；
7. 免费模型模态实测（可选）。

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
- **目标模式 / 自动续跑**：用户明确禁止（2026-10-15）。
- **按标题相似度挑会话交接**：已修；必须用 `handoff_to_new_session`。
- **免费模型“超时=不可用”**：用户已裁定没问题；不要改探测口径。

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
