# 零缺口审计结论（可复核）

> 维护者：每轮收尾时更新本文件。**每一项都必须附"证据 / 复现命令 / 实测数字"**，
> 否则不许写成"已闭合" —— 这是本仓库反复吃过的亏（"印出来的必须是真的"）。
> 更新时间：2026-09-19（第 64 轮，v1.16.93）

## 0. 怎么复核这份结论

```powershell
# ① 全量渲染侧用例（当前基线：329 文件 / 5784 通过 / 16 跳过 / 0 失败）
npx vitest run

# ② 类型 + 10 道 audit 门禁（当前基线：tsc 0；门禁 exit 0）
npx tsc --noEmit --incremental false
npm run audit

# ③ 引擎侧用例
cd src-tauri; cargo test

# ④ 发布链路（键 / 清单 / 签名 / 产物字节一致）
node tools\release\verify-update-manifest.mjs --remote     # 7/7 通过

# ⑤ 真机（打包版）：启动 + 维护数字 + 数据健康
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9222"
Start-Process "$env:LOCALAPPDATA\Codem\codem.exe"
node .preview-shot/cdp-boot.mjs 15000        # 抓启动维护汇总行
node .preview-shot/cdp.mjs "@.preview-shot/probe-health-11689.js"
```

## 1. 审计点名的四处已知缺口（用户最初指出的）

| 缺口 | 状态 | 证据 |
| --- | --- | --- |
| 损坏库备份**无等价物**（设置） | **已闭合**（v1.16.88） | 引擎 `salvage_projects_from_corrupt` 抢救 `settings` 到旁路文件；渲染侧 `restoreRecoveredSettings` 三条硬规则（只补缺键 / 黑名单不许继承 / 三类分别计数）；引擎用例 `salvage_sidecar_carries_settings_and_ownership`、`salvage_returns_zero_and_writes_nothing_for_unreadable_file`；渲染 `SET-RESTORE-1..4`。⚠️ 窗口很窄，已在 CHANGELOG 如实交代 |
| `tool_calls` 大 payload 在**真 CLI 契约**中的量级用例 | **已闭合**（v1.16.87） | `engine_tests.rs::tool_calls_payload_scale_is_byte_exact`：500 个调用 / 单条 args 2.11 MB + result 1.98 MB，**逐字节**比对（穿过 `args` 是 JSON 字符串那层编码）；实测写入 78 ms / 读回 13 ms |
| AR-1/AR-2/AR-3 覆盖移交**未逐条对齐** | **已闭合**（v1.16.85） | 逐条核对 12/12，并修掉两处指向不存在编号的注释（`MR-0`→`MR-6`、`AR-1~4`→`AR-1b/2b/3b/4/6`） |
| `PortKind` 里已不可达的 `"wasm"` 形状 | **已闭合** | 类型已收紧为字面量 `"rust"`；`event-log.ts` 里两处 `if (port.kind !== "rust")` 已删（恒不成立） |

## 2. 我自己在审计中"再次点名"并已闭合的（选择性列出，全部有真机数字）

| 项 | 版本 | 实测证据 |
| --- | --- | --- |
| 不变量审计把"读侧镜像没加载完"当成"没有缺口"（同一份数据两次维护报 **934** 与 **749**，934 恰好等于会话消息行总数） | v1.16.89 | 修复后打包版每次维护都报 **749**；`invariant-audit-load-window.test.ts` |
| 同一根因的其余四个消费方（对模型说"没有匹配"、对落盘报告说"会话没正常启动"、对面板说"没有轨迹"） | v1.16.90 | `event-read-readiness.test.ts`（13 条，成对断言）；真机口径是"无回归"（诚实交代） |
| 数据落点**两个来源**（`CODEM_DB_PATH` 只搬库、日志/附件/溢出/标记留在原地；隔离钻取会读写用户真日志）+ 权威日志回填静默 no-op + Windows `os error 3` 被误判成读失败 | v1.16.91 | 真机钻取：隔离目录出现 `sessions/` 与两个 `.jsonl`（504,338 + 316,635 字节）、`回填 777 条历史`；**用户真实目录逐文件未变**（6 个文件大小与 mtime 全等） |
| UI：三个（后补两个）按钮没有可访问名、一个计数显示两遍、几处点击目标 < 24×24 | v1.16.92 / v1.16.93 | 真机逐项复量：工具条**无名按钮 0 个**；「任务管理」可访问名 = `任务管理（1 条未读）`；「＋」命中 **24×24**；「置顶」命中 **18×24** |
| 更新清单用 v1 平台键 ⇒ 「检查更新」从未成功过 | v1.16.85 | `VERSION-5` 机器约束；真机：装的 1.11.0 → 发现 1.16.89/1.16.90/1.16.91 |

## 3. 还没闭合的（**不许**说成零缺口）

| 项 | 现状 | 下一步 |
| --- | --- | --- |
| 深层面板（插件 / 技能 / 任务中心 / MCP）的**逐面板走查** | 遮罩类名不统一（`.modal-overlay` 与内部面板各自为政），走查脚本认不出来，那几步读数会"继承"上一个面板 | 按面板各写一个驱动步骤（下一轮） |
| 便携模式的**产品决策**：功能目录（宠物/技能缓存/zvec/克隆目标）与旧库 `codem-db.bin` 是否跟着库走 | 刻意保留在 `appDataDir`，已写进 CHANGELOG 与 PROJECT-GUIDE | 等你拍板范围 |
| **设置面板的关闭按钮（`settings-close`）没有可访问名** —— 第 71 轮真机普查新增发现 | 真机 1.16.93：设置面板内 **127** 个可见按钮中有 **1 个无名**，就是右上角那个 ✕。它还解释了走查脚本第 63 轮为什么"按名字找不到关闭按钮、只能按位置兜底"（根因是它压根没名字，不是仪器将就）。⚠️ 本轮只做了普查与记录，**修复尚未做** | 补一行 `aria-label`（与其它按钮同一套 i18n 文案）→ 出包 → 真机复量"面板内无名按钮 0 个" |
| `session_meta` 事件的消费者 | 复核后**没有任何生产读取者**（写它的 `recordSessionFeedback` 有调用者，三个候选读全部落空；`project/files.ts` 那段死读已删） | 若要恢复"会话级指令覆盖"，需先有写入侧产品设计 |
| 用户库里的历史遗留 | 一条形状不合契约的 compaction 行已按你的选择规范化（告警归零）；凭据形状字符串的位置已给出（活 key 在 `codem-settings.providers.[3].apiKey`） | 你决定是否轮换 |

## 4. 复现用的一次性脚本（`.preview-shot/`，gitignore）

| 脚本 | 用途 |
| --- | --- |
| `measure-invariant-gaps.js` | 直读 DB 重算"历史缺口"真值（与维护报的数字对照） |
| `drill-data-root-r62.mjs` | 隔离钻取：数据根目录 / 真实目录是否被改动 |
| `ui-walk-r63.mjs`、`ui-walk-r63-verify.js` | 真机逐面板走查 / 修复后逐项复量 |
| `cmp-dbs.mjs`、`verify-round47.js` | 旧库与新库逐 id 比对、水位复核 |
