# AGENTS.md —— 快速操作规程（**当前文档集：`docs/project-guide/README.md`**）

> ★★ **2026-10-26 起，先读 `docs/project-guide/00-AGENT-HANDBOOK.md`** ✓ —— 这是给任何 AI / Agent 平台的接手手册（开工清单 / 硬规则 / 基线 / 坑 / 任务路由）。
> 旧总览 `docs/PROJECT-GUIDE.md` 保留为历史（823 KB，正文状态停在 1.16.305）；当前版本 **1.16.333**。
>
> ★★ 旧入口（仍可参考）：**先读 `docs/PROJECT-GUIDE.md` 开头的「从这里开始」一节** ✓ —— 那是本项目的**历史核心文档**，

> ★ 新会话请先读 **`docs/NEW-SESSION-START.md`**（一屏读完的开工说明：项目结构 / 当前待办 / 纪律 / 踩过的坑）✓
> 一屏读完即可开工（项目定位 / 当前状态与对标结论 / 已落地机制 / 未做项 / 开发纪律 / 文档导航）✓。
> **本文件是它的配套摘要 + 命令与发版操作规程** ✓（内容更偏"怎么敲命令、哪些坑别踩"✓）。

## 0. 一分钟了解这是什么

**Codem** 是一个 Windows 桌面 AI 编程助手（对标 Codex / Claude Code / MiMo Code CLI）：
基于 **Tauri v2 + Rust + React + TypeScript**，把"对话 → 计划 → 工具调用（读写文件、跑命令、终端）→ 验证"
这一整条 agent 循环做成图形界面。作者自述是"十年没敲代码、全程用 Codem/MiMoCode 自己开发自己" ✓
（所以仓库里**大量中文注释在解释"为什么"** ✓ —— 改动前先读注释，很多坑已经写在那里了 ✓）。

- 仓库：`github.com/sdcxb/codem`（主分支 `master`）
- 当前版本：**1.16.333**（已发布；外部 DSH 插件检查更新/一键升级；统一插件详情页；删除运行中会话立即杀命令进程树；免费模型面板收进详情页。上一版 1.16.329：折叠旧工具参数，长会话上下文从 247% 降到 58%）
- 1.16.333 包含：前台 `subagent` 在 refusal/aborted/error 时返回 `isError=true`。
- 测试规模：**796 个测试文件 / 8842 个用例**（8825 通过 / 17 skipped / 0 失败，见 `docs/project-guide/09-CURRENT-STATE.md`），`tsc` 零错误
  （个别计时敏感用例在全量并行满载下偶发抖动，单独跑必过 ⇒ 先单跑确认，别急着改代码 ✗）

## 1. 先读哪几个文件（按这个顺序）

| 文档 | 体量 | 什么时候读 |
|---|---|---|
| **`docs/project-guide/00-AGENT-HANDBOOK.md`（当前第一份）** | 230 行 | **任何 AI / 新会话先读它**：开工清单 / 硬规则 / 基线 / 坑 / 任务路由；索引见 `docs/project-guide/README.md` |
| **`docs/PROJECT-GUIDE.md`（历史总览）** | 823 KB | 只读开头「从这里开始」与需要的章节；正文状态停在 1.16.305，当前状态以 `docs/project-guide/09-CURRENT-STATE.md` 为准 |
| **本文件 `AGENTS.md`** | 短 | 需要"具体敲什么命令、哪些坑别踩"时（命令 / 构建签名 / 发版规程） |
| `docs/RELEASE-GUIDE.md` | 216 行 | **要发版时必读**（构建/签名/说明模板/只发稳定版/删除 release 的安全规程） |
| `docs/project-guide/09-CURRENT-STATE.md` | 230 行 | 想知道"现在哪些没做完/哪些没验/下一步"时；`docs/GAP-LIST.md` 已过期（停在 1.16.305） |
| `docs/HANDOFF-NEXT-SESSION.md` | 3000+ 行 | **按需检索**：逐轮工程日志，含每条改动的取证、失败尝试与教训。用 grep 找关键词，别通读 ✗ |
| `CHANGELOG.md` | 1.2 MB | **只在查某版本改了什么时**用 `Select-String` 定位，别通读 ✗ |
| `docs/releases/<tag>.md` | 每份几十行 | 1.0 之前 26 个版本的标准发布说明（历史留档） |

## 2. 技术栈与关键目录

```
src-tauri/            Rust 侧：窗口、文件/命令执行、加密、日志（lib.rs 是主入口）
src/core/llm/         agent 循环与工具系统（agentic-loop.ts 是核心，很大，按函数名检索）
src/core/storage/     存储：会话日志（JSONL 权威副本）、SQLite 索引、维护任务
src/core/skill/       技能（Skill）安装/发现/加载
src/core/settings/    设置与凭据（含导出脱敏）
src/core/environment/ 工作区变更追踪（file-change-tracker.ts）
src/core/prompt/      系统提示词与外置模板
src/core/knowledge/   知识与动画类小工具（字体/嵌入/PPT 生成等）
src/components/       React 界面组件（含技能管理、设置面板、任务中心等）
src/test/             796 个测试文件（判据都写在这里）
tools/eval/           评测口径（配对报告、去重）
tools/audit/          结构审计（上报点分诊、可达性门禁等）
.preview-shot/        评测脚手架与运行产物（**已被 .gitignore 忽略**，不进仓库）
docs/releases/        1.0 前 26 版发布说明（留档）
```

## 3. 常用命令（Windows PowerShell）

```powershell
# 开发 / 检查 / 测试
npx tsc --noEmit                        # 类型检查（必须 0 错误）
npx vitest run                          # 全量测试（约 2.6 分钟；796 文件 / 8842 用例）
npx vitest run src/test/<某个>.test.ts  # 单跑一个判据文件

# 结构审计（动过上报点/新增未接线文件后要跑）
node tools/audit/scan-report-sites.mjs --check     # 上报点分诊闸门（应打印"分诊闸门通过"）
#   打印形如「扫描命中 247 处 = 登记表 247 条（triaged 247 / pending 0）」——**三个数字必须相等**：
#   扫描命中（现算）/ 登记表条目 / `_counts` 缓存。缓存漂移也判红（第 188 波吃过亏：扫描 247 而缓存 245）。
# 可达性门禁由 src/test/reachability-gate.test.ts 守：新增但未接线的文件必须登记进
#   tools/audit/reachability-allowlist.json 并在文件头写 `* @unwired` 理由

# 打包前先拉「免费模型插件」的内置副本（第 201 波：运行树不进 git，按固定 commit 现拉 + 校验 sha256）
node tools/vendor/fetch-ofm.mjs            # 需要联网（浅拉上游那一个 commit）；--check 只校验现有副本

# 构建 + 签名（⚠️ 必须带签名环境变量，否则 CLI 会卡在交互输密码）
$env:TAURI_SIGNING_PRIVATE_KEY = (Get-Content .tauri\codem-updater.key -Raw).Trim()
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "dummy"
node node_modules\@tauri-apps\cli\tauri.js build     # 退出码 1 是**预期的**（stderr 有 warning）；以产物为准
# 产物：src-tauri\target\release\bundle\nsis\Codem_<版本>_x64-setup.exe（+ .sig）

# 清理开发中间产物（target/debug、历史安装包、缓存与日志；默认只打印计划，--apply 才删）
node tools\maintenance\clean-dev-artifacts.mjs            # 看计划
node tools\maintenance\clean-dev-artifacts.mjs --apply    # 执行（2026-10-15 实测一次释放 105 GB）

# 生成更新器清单 + 校验（发布前必做）
node .preview-shot\_audit\make-latest-json.mjs <版本> "<一句话说明>"
node tools\release\verify-update-manifest.mjs            # 本地四项
node tools\release\verify-update-manifest.mjs --remote   # 再比对 GitHub 上的 sha256

# 静默安装（真机验证）
Start-Process "<setup.exe 路径>" -ArgumentList '/S' -Wait
```

## 4. 当前开发状态（2026-10-07）

**能力水平（对标 DSH，同一套任务、同一模型、同一推理强度）**

- **真实仓库修复任务：本版通过 10 个，DSH 通过 9 个**（共 12 个任务）✓
- **效率优于 DSH**：完成同样任务所需工具调用约为 DSH 的一半；输出 token 用量明显更少 ✓
- **仍弱于 DSH 的一项**：单次响应时延（约慢 1.5 倍）。**已定性** ✓：实测 310 次调用里
  **99% 的时间在等模型服务端**、客户端处理只占 **1.1%**，且服务端速率在批内极差仅 7%（不是负载波动）
  ⇒ 差异来自**账号/路由**（DSH 走平台账号，我们用公开 API key）⇒ **产品内改不动** ✗，不再投入 ✗。
- **已知且被接受的方差** ✗：个别评测任务（如 repo-06/repo-09）同一构建在不同轮次会通过或不通过 ⇒
  属模型侧采样方差 ⇒ **不是可修的结构缺陷** ✓（曾尝试用"零改动收尾闸"兜住，被两条既有行为判据证否 ⇒ 已撤销 ✗）。

**最近落地且仍然生效的结构性改动（每条都有判据 + 变异自证）**

1. **回归完成门**：本轮把原先正常的检查改红时，界面**不显示"任务完成"**，并递事实推动修复 ✓
2. **无改动不发 git**：没有"会改工作区"的工具跑过的迭代，追踪器一次 git 都不发（git 调用 ~180 → ~14 次/任务）✓
3. **库维护让路**：数据库维护不与正在进行的回合争用资源（首回合静默 6–11 秒归零）✓
4. **技能安装引导**：系统提示始终给出**本机真实技能目录**、目录布局与"从仓库安装的 5 步"，
   且 `load_skill` 未命中会重扫 ⇒ 装完无需重启即可用 ✓
5. **凭据普查不再误报**：`task-…`/路径里的 `sk-` 片段不再被当成 API Key；同一规则也用于导出脱敏
   ⇒ 顺带消除"把路径片段改写成 `sk-***`"的内容破坏 ✓
6. **用户无法介入的自检发现只进日志**：重复事件清理/索引自愈/结构巡检/双写缺口对账不再弹横幅；
   只有"用户能采取动作"的提示（凭据轮换）才展示 ✓
7. **流式时间归属日志** `[provider] stream timing net=… self=…`：用于判定时延出在哪一侧（就是它把 ② 定了性）✓

**未做 / 已知未修（别重复劳动 ✗，理由都记在交接里）**

- **E1+E2（把变更追踪搬到回合边界）**：B 切片已吃掉大头收益，剩余约 0.6% ⇒ 不做 ✓
- **持久 pwsh 会话（对标 DSH 的常驻 shell）**：只影响每次命令的 ~256ms 地板，落在客户端那 1.1% 的邻域
  ⇒ 对 ② 无实质作用 ⇒ 不做 ✓
- **应用内自扫的搜索性能**（约 1.9% 墙钟）：需要 Rust 原生搜索 ⇒ 要新增依赖，风险大于收益 ⇒ 暂不做 ✓
- **297 波遗留四项**：Job Object `KILL_ON_JOB_CLOSE`、WebView2 去节流、回退/假绿守卫、npx 税 ✓

## 5. 开发纪律（这个仓库最看重的东西，违反会被判据挡住 ✗）

1. **先写判据 → 变异自证 → 真机验证**：任何改动都要有能变红的判据；把实现改坏能让判据变红，
   才算判据有效 ✓（变异不做，等于没测 ✗）。
2. **报告必须出自官方口径**：评测结论只在 `node .preview-shot/_collect.mjs --apply`（内部先跑
   `tools/eval/dedupe-runs.mjs --apply`）之后才作数 ✓；不许拿中间态数字下结论 ✗。
3. **不用提示词治本**：能靠结构（代码决定的机制）解决的就不要靠"再提醒模型一句" ✓ ——
   真机上验证过：提醒类手段在通过与失败的轮次里都会出现，不是分水岭 ✓。
4. **跑评测批期间不要构建** ✗：构建抢 CPU 会抬高我们自己那一侧的时延 = 自我美化 ✓。
5. **别把长跑进程接进会提前结束的管道** ✗（`| Select-Object -First N` 会把它杀掉 ⇒ 用后台作业 + `job_output`）。
6. **写脚本时中文引号一律用「」** ✗：把中文引号写进 JS 双引号串会让脚本直接崩 ✓（这个坑踩过 18 次 ✗）；
   长文本先写文件再让脚本读（`git commit -F`、`gh release edit --notes-file`、`.txt` 中转）✓。
6b. **写进文件的脚本，先 `node --check` 再跑** ✓（与 6 是同一类坑的另一半：
   6 说的是「用 shell 传字符串」时的引号地狱，6b 说的是「往文件里写代码」时的内容错误 ✓）。
   实测踩过三种（都会被 node 当场判死，且**与用哪个 shell 无关**）：
   ① JS **模板串里嵌反引号**（写 .mjs 时踩了 3 次 ✗）—— 要写反引号就改用「」或字符串拼接 ✓；
   ② **块注释里嵌星号斜杠** ✗（注释会提前结束）；
   ③ 中文串里混**半角引号** ✗。
   纪律：写完脚本**立刻** `node --check <file>` ✓（`.preview-shot/*.mjs` 另有判据 `PS-1` 守 ✓，
   但那是全量跑时才报，自己先 check 能省一整轮 ✗）。
   ⚠️ 容易误判的边界 ✓：装了 dsh-ops 之后 shell 是 bash ✓，**bash 只保证「我传进去的字符串原样到达」** ✓，
   它**不能**修正我写进文件里的代码本身 ✗ —— 别把「内容错误」误当成「shell 又坑我」 ✗。
7. **回退一律 `git checkout -- <file>`** ✓：用"行号 + 花括号计数"删代码段不可靠（字符串里的花括号会打断计数）✗。
8. **日志的真相**：`%APPDATA%\com.codem.app\codem-runtime-*.log` **只收 Rust 侧**（`exec start/end` 等）✓；
   渲染侧 `console.*` 只能靠 **CDP** 抓（评测驱动已抓，落在 `.preview-shot/<case>.r<N>.console.jsonl`）✓。
9. **本项目禁止「目标模式」**（持久目标 / 自动续跑 / goal mode）✗✗ —— 用户明确要求（2026-10-15 原话：
   「不要用目标模式迭代，这个开发模式很烂」「以后本项目不允许用目标模式！写入到项目规则里」）。
   为什么禁：它把一次交付拆成多轮自动续跑，每轮都要重新拼上下文、还容易在"看起来还在推进"的状态里
   把半成品留在工作区；产出质量与可核对性都更差 ✗。
   要怎么做 ✓：**一次把事做完**；多步就在**同一轮**里推进（需要清单用 `todo_write`，不要建 goal）。
   遇到必须让用户拍板的岔路（发版、产品取舍）就**直接问**，不许用"自动续跑"代替问 ✗。

## 6. 评测与验证脚手架（都在 `.preview-shot/`，不进 git）

```powershell
# 跑一批评测（3 格 × 2 轮示例；EVAL_ONLY 传用例 id，写错会大声报错）
$env:EVAL_VERSION="1.16.298"; $env:EVAL_RECORDS_OUT=".preview-shot/eval-records-codem-repo-vXX.jsonl"
$env:EVAL_ONLY="repo-02-write-false-success,repo-06-llm-failure-not-completed"
node .preview-shot\_chain-ab-296.mjs      # 会先静默安装对应版本，再逐格跑（长时间，用后台作业）
node .preview-shot\_collect.mjs --apply --treatment .preview-shot/eval-records-codem-repo-vXX.jsonl
node .preview-shot\_exec-baseline.mjs --ws codem-eval-ws --hours 0.2   # 工具耗时基线
node .preview-shot\_gate-evidence.mjs                                  # 收尾门真机取证
```

**12 个评测任务**是真实仓库修复任务（`repo-01..12`），判定由任务自带的判据脚本给出 ✓；
对照臂是 DSH 的命令行 agent，记录在 `.preview-shot/eval-records-repo-control*.jsonl` ✓。

## 7. 发版（摘要，细节以 `docs/RELEASE-GUIDE.md` 为准）

1. 三处版本号：`package.json` / `src-tauri/tauri.conf.json` / `src-tauri/Cargo.toml` ✓
2. **文档基线**（版本号改完后）：`npm run docs:sync` → 按输出清单更新 `docs/project-guide/{README,00,01,09}` 与 CHANGELOG/PROJECT-GUIDE → `npm run audit:docs` ✓（`verify` / `audit` 已含这道门禁；`.github/` 当前被忽略，CI 可选）
3. `CHANGELOG.md` 顶部加 `## [x.y.z]` 段 ✓（**面向用户**的说明，不写内部编号 ✗）
4. 构建 + 签名（见 §3）✓ → 生成并校验 `latest.json` ✓
5. `gh release create vX.Y.Z --title "Codem vX.Y.Z" --notes-file <说明文件>` + 上传 5 个资产 ✓
6. **发布说明用标准样式** ✓：`发布日期/类型/下载 → 本版要点 → 对标结果（通过多少真实任务、
   哪些方面优于/齐平/仍弱于 DSH）→ 健壮性 → 变更 → 升级说明 → 已知问题 → 校验` ✓
   **不许**出现：测试轮数/对数/通过率、"采样波动"、服务端占比、波次号、内部任务编号 ✗
7. ⚠️ **只发稳定版** ✓：**1.0 之前的全部** + `v1.16.43` + `v1.16.210` + 最新稳定版 ✓；
   重建旧 release 会**抢走 `Latest`** ✗ ⇒ 建完必须 `gh release edit <最新稳定版> --latest` 抢回来，
   并复核 `verify-update-manifest.mjs --remote` ✓。

## 8. 交接约定

- **逐轮工程日志**：`docs/HANDOFF-NEXT-SESSION.md`（3000+ 行 ✓）。新发现、失败尝试、教训都追加在那里 ✓；
  用 grep 检索关键词即可 ✓，不要通读 ✗。
- **历史版本说明**：`docs/releases/<tag>.md`（1.0 前 26 版 ✓，与 GitHub Releases 同步 ✓）。
- **改完就走完流程**：`tsc` 0 ✓ → 相关判据 + 全量测试 ✓ → 需要时真机验证（构建 + 静默安装 + 取日志）✓ → 提交推送 ✓。




