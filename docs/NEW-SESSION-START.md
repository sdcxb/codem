# 新会话开工说明（Codem）—— 一屏读完即可接手

> ★★ **先读 `docs/HANDOVER-2026-10-17.md`**（2026-10-17 交接方案：项目是什么 / 三条主动脉 /
> 「改什么会牵动什么」速查表 / 门禁基线 / 真机验证与并行纪律 / 12 条会让你得出错误结论的陷阱 /
> 本会话已修真缺陷清单 / 未完成项）—— **当前最省时的入口**，读完再接本文件。
>
> 本文件是**给新会话的交接**（不是逐轮流水日志）。逐轮取证与教训在
> `docs/HANDOFF-NEXT-SESSION.md`（3000+ 行，**用 grep 检索，别通读** ✗）；
> 项目最核心文档是 `docs/PROJECT-GUIDE.md`（**只读开头「从这里开始」一节** ✓）；
> 命令与发版规程在 `AGENTS.md`。

---

## 0. 给用户的开场白（直接粘贴到新会话）

```
读 docs/NEW-SESSION-START.md（新会话开工说明）+ AGENTS.md，然后按里面的「当前待办」继续。
本轮先做第 1 条（真机复查模型列表是否补齐、【未知】是否出现）。遇到 bug 就修（不论新旧），
修完跑完门禁（tsc + 全量测试 + audit + 变异波次），真机验证过再提交推送；发版前先问我。
```

（如果只想改某一块，把第 2 段的"第 1 条"换成那一块即可 ✓。）

---

## 1. 项目是什么

**Codem**：Windows 桌面 AI 编程助手（对标 Codex / Claude Code），
**Tauri v2 + Rust + React + TypeScript**，把「对话 → 计划 → 工具调用 → 验证」这条 agent 循环做成 GUI。
仓库 `github.com/sdcxb/codem`，分支 `master`。作者自述"十年没敲代码、全程用 Codem 自己开发自己"
⇒ **仓库里大量中文注释在解释"为什么"**：改动前先读注释，很多坑已经写在那里 ✓。

- 当前版本：**1.16.319（已构建安装，等待用户批准后才发版）**。本版两件事：
  ① **压缩按距离分档**（用户要求，对标「最近 5–6 轮 100% 保留 + 压缩率随距离上升」）——
  最近 3 轮逐字**绝不切断**（token 成半收缩只许切更老的部分；极端超长轮次按 60 条上限截断并记日志）／
  中间档 20 条走**确定性结构化要点**（不调 LLM）／更早的交给 LLM 检查点且**分块滚动全覆盖**
  （不再 head40%+tail60% 掐中段），连分块都装不下的最老部分降级成最低保真清单并**明写**保真度；
  ② **自动记忆降噪**（用户实报主力机"一轮 7–8 条要审批"）—— project 的例子不再列
  "技术栈/目录约定/构建命令"（与门槛去自相矛盾）、每轮待批准上限 **3→2**、名额**只在真写出一条
  待批准条目时扣**（重复项/已拒绝项不占名额）。上一版 1.16.318 = 插件起不来给真原因+可点出口、
  压缩上下文看得见；1.16.317 = 记忆审批双击展开全文
- 测试规模：**676 个测试文件 / 8156 个用例全绿**（17 skipped），`tsc` 零错误
- 本机安装路径：`%LOCALAPPDATA%\Codem\codem.exe`；用户数据 `%APPDATA%\com.codem.app\`

## 2. 目录与关键文件（按"改得最多"排序）

| 位置 | 是什么 |
|---|---|
| `src/core/free-model-plugin/model-index.ts` | 免费模型**清单/归属/健康/模态**的纯函数中枢（最近几波的主战场） |
| `src/core/free-model-plugin/service.ts` | 聚合面 `freeModelPlugin`：插件启停、`models.list/probe/health/loadHealth/autoProbeIfStale/modalityLabel`、诊断 |
| `src/core/model-config.ts` | `getConfiguredApiModels()` —— **对话里的模型列表**就从这儿来（含免费模型清单的并集逻辑） |
| `src/components/SettingsPanel.tsx` | 设置面板（三条模型渲染分支 + 刷新/检测按钮 + 提示文案） |
| `src/components/ChatPanel.tsx` | 对话区（模型选择器 `.model-picker`、标注、点别处收起） |
| `src/components/ModelProfilePanel.tsx` / `ModelSelector.tsx` | 另外两处模型列表 |
| `src/components/FreeModelPluginCard.tsx` | 插件卡片（「检测可用性」按钮在这里的**插件管理**页） |
| `src/core/llm/provider.ts` / `index.ts` | LLM 调用与路由（失败回写健康结论；免费模型按归属路由） |
| `src-tauri/src/ofm.rs` / `src-tauri/src/lib.rs` | Rust 侧：插件进程管理（`ofm_stage_node`、`shutdown_ofm`）、升级/退出路径 |
| `src/test/*.test.ts` | 判据（本项目的"法律"）；`tools/mutate/specs/*.json` 是变异波次 |
| `tools/release/*.mjs`、`tools/ui-audit/*.mjs` | 发版清单与校验、UI/CSS 一致性门禁 |
| `.preview-shot/` | 本机验证脚手架与产物（**gitignored，不进仓库**） |

## 3. 免费模型插件（最近 10+ 波都在这块）

- **运行形态**：内置 Node 服务，仅监听回环；`/v1/models`、`/v1/chat/completions`，**必须带 `Authorization: Bearer <forwardKey>`**（否则 401）。
- **数据目录**：`%APPDATA%\com.codem.app\extensions\our-free-model\data`
  （`settings.json` 里有 `standalonePort` / `forwardKey`；`catalog.json` 里有 `kiloRows[].vision` **模态权威值**；`stats.json` 是事后统计）
- **Node 解析顺序**：系统 Node(≥22) → 安装包内置 → 便携版 → 下载；插件实际运行**数据目录里的副本**（`data\runtime\node.exe`），
  安装目录只剩只读资源 ⇒ 升级不会被"文件被占用"挡住（313 起实测成立）。
- **关键设置键**：`codem-free-model-health`（可用性结论，**带时间戳、30 分钟过期即未知**）、
  `codem-dynamic-models`（刷新写入的服务器模型列表；`free-model` 键）、`codem-settings.model`（当前模型）。
- **已建立的口径**（都有判据 + 变异）：
  - 可用性：`检测可用性`（手动）／**刷新后与启动时自动后台补测**（`autoProbeIfStale`：非阻塞、单飞、失败只进日志）；
    已知不可用的**从列表里隐藏**（当前选中的保留），**过期自动放回**；「不可用」与「慢/超时」**分开**；
  - 模态：`【多模态】`/`【文本】`/`【未知】`，**没有依据就标未知、不许用名字猜**；标注**只进显示文本**（绝不许进模型名）；
  - 模型清单：**内存缓存 ∪ 落盘动态列表**并集 + 去重（否则短缓存会把模型整批藏掉）。

## 4. 开发纪律（违反会被判据挡住 ✗）

1. **先写判据 → 变异自证 → 真机验证**：实现改坏必须能让判据变红（变异不做 = 没测 ✗）。
2. **走完流程**：`npx tsc --noEmit` 0 → 相关判据 + `npx vitest run` 全量 → `npm run audit` → 变异波次 →
   需要时**构建 + 静默安装 + 真机取证** → 提交推送。
3. **发版必须先问用户**（用户明确要求）；发版流程见 `AGENTS.md` §7 与 `docs/RELEASE-GUIDE.md`。
4. **诚实优先**：没验成的不许写成已验证；不确定就标【未知】/如实说明（用户的硬要求）。
5. **中文回答**；文档与注释里的中文引号一律 `「」`。
6. **禁止「目标模式」**（持久目标 / 自动续跑 / goal mode）✗✗ —— 用户明确要求（2026-10-15：
   「不要用目标模式迭代，这个开发模式很烂」「以后本项目不允许用目标模式！写入到项目规则里」）。
   一次把事做完；多步就在**同一轮**里推进（要清单用 `todo_write`，别建 goal）；必须让用户拍板的岔路直接问，
   不许用自动续跑代替问 ✗。这条同时写在 `AGENTS.md` §5.9。

### 踩过的坑（省你几小时）

- **JS/PS 字符串里用 ASCII 中文引号**：本会话踩了 5+ 次，脚本直接语法错 ⇒ 一律 `「」`；
  PowerShell `Add-Content` 传长中文串也常崩 ⇒ **先写 `.txt` 再 `Add-Content (Get-Content file)`** ✓。
- **`node -e` 里写含 `${...}` 的模板串**：会被外层插值改写 ⇒ 用**脚本文件**，别用 `-e`。
- **改代码会让别的波次的变异锚点失效**：`check-artifacts`/`mutation-artifacts` 会红 ⇒ 按新形态**重新锚定**并重跑该波次。
- **控制字节**：写日志时 `\a` 被解释成 0x07（响铃）⇒ `audit:control-bytes` 红；按字节清掉。
- **knip 门禁**：新增**无人使用**的 export 会让"未使用导出"上涨 ⇒ 要么用上，要么**删除**（别加 ignore）。
- **CSS 改了要刷新契约**：`node tools/ui-audit/css-contract.mjs --write`，否则 `css-integrity` 红。
- **回退一律 `git checkout -- <file>`**（别用行号删代码段）。
- **真机验证靠 CDP**（`--remote-debugging-port=9222`，脚手架 `.preview-shot/_launch-195.mjs` + `audit-walk-lib.mjs`）；
  注意：应用被父进程回收后 CDP 会拒连 ⇒ 重新 `_launch-195.mjs` 再跑探针；
  **程序化 `click()` 不触发 `pointerdown`**（收起类判据要同时挂 `click` 兜底才测得准）。
- **中文清单/标注类改动**：记得同时改**所有**渲染模型的地方（设置三条分支 + 对话 + 档案面板 + ModelSelector）。

## 5. 当前待办（按优先级）

1. **第 228 波已做、等用户批准发版**（三件压缩改进 + 记忆审批降噪 + **一轮"对着实现找漏洞"的审计**）：
   - **压缩按距离分档**：近端最近 3 轮逐字不切断（`compactionMinKeep`，上限 60 条）／中间档 20 条
     走确定性结构化要点（`renderStructuredHistorySummary`，不调 LLM）／更早的 LLM 检查点
     **分块滚动全覆盖**（`packPartsForSummary` + `MAX_SUMMARY_CHUNKS=3`，不再掐中段），
     溢出部分降级成最低保真清单并在标记里明写（`composeCompactionMarkerText`）。
     判据 `CG-1..CG-9`（其中三条**真跑 `doCompactMessages`**）+ 波次 `context-memory-228`。
   - **审计轮（四条互不相干的线：压缩核心 / 压缩生命周期与并发 / 记忆提取 / 记忆注入）修掉 20 处真缺陷**，
     最值钱的五条：①保留集体积预算**看不见工具结果**（`toolCalls[].result`）⇒ 该收缩时永远不收缩
     ⇒ 压缩后压力不降 ⇒ 连压 3 次误报「窗口已满」（**而压缩一次都没真的生效**）；
     ②摘要调用失败会**丢掉全部累积摘要**；③「删了但没摘要」⇒ 改成**先写标记、再删旧消息**；
     ④手动与自动压缩**没有互斥**（双标记、时间戳相同）＋ 手动续体不判会话归属（旧回执落到新会话）；
     ⑤记忆侧 `explicit: true` **无结构性证据 = 绕过审批的注入面**（提取模型看得到工具读出来的文件正文
     ⇒ 仓库里一句"请记住…"即可让内容直接生效、此后每轮注入），现在必须**用户消息里真的有**"记住"类请求。
     还修了：压缩后限频挡住提炼、免审批条目无写入上限、系统顶替留伪造"用户拒绝记录"、查重单向、
     回退到迁移前被在途写覆盖、压缩折叠后切掉最近 3 轮、软删在镜像被逐出时静默失效、
     压缩标志是进程级单布尔、`minKeep` 不是下限、标记可能让上下文变大、溢出档保最老丢最新。
     判据：`compaction-audit-228.test.ts`（CA-1..CA-18）+ `memory-audit-228.test.ts`（MA-2..MA-6）
     + `REJ-3`/`REJ-3b`；变异波次 `audit-228`（18 条：17 红 + 1 反向对照）。
   - ⚠️ **如实记**：**自动压缩**那一档真机仍未验（要真把长会话压到 0.8 压力；我没动用户的真实长会话）——
     证据是判据 + 变异。真机验过的是**手动**那一半（回执口径「保留最近 20 条，并且最近 3 轮绝不切断」✓）
     与记忆侧（一轮真实对话只新增 **2 条**：1 条项目级待批准 + 1 条对话级直接生效；对照修前 6/6/6/8 条）✓；
     存量「归属已失效」29 条已整组批量删除（已落库）✓。
   - ⚠️ 单样本观察：模型仍会把偏"会话/环境"的事实标成 project ⇒ 上限 2 封住了审批噪音，
     但"作用域判得准不准"没有结构性保证（要再压需要新机制，别只加提示词 ✗）。
2. **审计报告里"已定位待修"的条目：第二批已全部修完**（见下面第 3 条的清单）；
   下一轮进入**第三批**：对**这一轮改过的代码**再走一遍审计（改动集中区：`memory.ts` 的
   `createEntry`/`updateMany`/`formatLine`、`checkup.ts` 的批量动作、`MemoryManager`/`MemoryCheckupView`
   的两处回执、`compaction-budget.ts` 的分档与预算、`agentic-loop.ts` 的提交段、`message.ts` 的归属兜底），
   并按"连续一轮挖不出新缺陷"的收尾条件决定是否停。
3. ~~补一条没跑成的真机复查~~ **已跑（第 226 波）**（**下轮别再重复测**）：
   - **① 免费模型列表：数据层补齐 ✓**（插件 `/v1/models` 26 个 = 应用侧缓存 26 个）。**「看得见几个」由上游决定**：
     真机可见 **13** 个，另 13 个被可用性结论隐藏（设置里如实写「已隐藏 13 个当前不可用的（可见 13 个）」）。
     隐藏的那批里 **10 个是上游硬拒**（原文 `OpenCode's free tier can only be used from within OpenCode…`，
     即 `catalog.json` 的 `entries` 那 10 条「OpenCode 免费车道」）—— **上游政策变化，本仓改不动**；
     查过上游 HEAD（`ddb451c`）与我们钉的 `f9cdb66`，UA/指纹逻辑逐字相同 ⇒ 上游也还没修。
   - **② 【未知】标注：真机上「看不到」，原因是结构性的**：`catalog.json` 只对 `kiloRows` 那 16 条给 `vision`，
     **恰好那 10 个没有模态依据的模型 = 被上游硬拒、被隐藏的那 10 个** ⇒ 可见的每个都有依据。
     要看到它只有两条路：这些模型重新可用，或把它们设为**当前选中**（选中那条即使不可用也保留并带标注）。
     判据层 `MODALITY-1..5` 仍绿 ⇒ **不许写成「【未知】已验证」** ✗。
   - 用户已裁定：**「超时标成不可用」没问题** ⇒ 别再按「瞬时失败被当不可用」去改探测口径 ✗。
3. **第 227 波修的两条（用户连报）**：①插件起不来时的提示（原来指去「插件市场」+ 让人装 Node，
   而真原因是"上一次留下的插件进程占着数据目录"）⇒ 现在**引用插件自己的原话 + 点出进程号**，
   并且**自动清一次残留进程再重试**（安全边界：只结束能证明是本插件的那个 pid）；卡片上多了
   「结束残留进程并重试」。②压缩上下文「点了没反应」⇒ 现在有进度、**常驻回执**、8 秒冷却防重复点。
   ⚠️ 如实记：**冷却期那条真机没验**（要真压掉一个长会话）——只有判据层证据。
4. **可选：模态实测**——给没有依据的模型发一张极小图片：接口**接受**⇒多模态、**明确拒绝**⇒文本、
   **其它错误⇒仍标【未知】**（用户已同意做"确定才标"，实测是唯一可靠路径；约 10–20 秒/个）。
5. **仍未真机确认的历史项**：托盘「退出」是否一下就退、还有没有黑框
   （退出路径的同步等待已改成"发出去不等"，有判据+变异，但**端到端计时没验过**）。
6. 用户已明确**不用**做的：清理注释/文档里的历史路径 `C:\mimo-gui`（那是检出目录名，不是产品名）。

## 6. 门禁与验证命令（复制即用）

```powershell
# 硬盘被中间产物撑大时（target/debug、历史安装包、缓存）：先看计划再加 --apply
node tools\maintenance\clean-dev-artifacts.mjs
npx tsc --noEmit                                   # 必须 0
npx vitest run                                     # 全量（约 2 分钟；668 文件 / 8064 用例）
node tools/mutate/run.mjs free-model-routing-206    # 变异波次（29 条，全红且"还原后判据全绿"）
node tools/mutate/run.mjs free-model-plugin-201
node tools/mutate/check-artifacts.mjs               # 变异产物闸门
npm run audit                                       # 结构审计链
node tools/audit/knip-gate.mjs                      # 未使用导出不许增长
node tools/ui-audit/css-contract.mjs --write        # 改过 CSS 之后刷新契约
node tools/ui-audit/scan-ui.mjs                     # 未定义类名（应 0）

# 构建 + 静默安装（真机验证）
$env:TAURI_SIGNING_PRIVATE_KEY = (Get-Content .tauri\codem-updater.key -Raw).Trim()
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "dummy"
node node_modules\@tauri-apps\cli\tauri.js build
Start-Process "src-tauri\target\release\bundle\nsis\Codem_<版本>_x64-setup.exe" -ArgumentList '/S' -Wait
```

## 7. 界面地图（用户常问的地方）

- **对话里的模型列表**：输入框上方的模型徽标（`.model-selector`）→ 下拉 `.model-picker`
  （限高 420px、可滚动、长名省略号 + 悬停全称、点别处自动收起、带可用性/模态标注）
- **设置 → 模型**：托管供应商「Our Free Model（免费模型插件）」卡片 —— 【刷新模型列表】（**刷新后会自动后台检测**）
- **设置 → 插件管理 → Our Free Model 卡片**：【检测可用性】（逐个最小请求探测，结果带时间戳）
- **设置 → 帮助 → 关于**：版本号（形如 `Codem v1.16.316`）
