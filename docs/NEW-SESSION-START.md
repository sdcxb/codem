# 新会话开工说明（Codem）—— 一屏读完即可接手

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

- 当前版本：**1.16.318**（**已构建 + 已安装 + 真机验收；按用户要求尚未发版**。它包含：插件起不来时给出
  **真实原因 + 可点的出口**（自动结束残留插件进程并重试，只结束属于本插件的那个进程）；压缩上下文
  **看得见**（进度、常驻回执、8 秒冷却防重复点）。上一已发布版 1.16.317 = 记忆审批双击展开全文）
- 测试规模：**671 个测试文件 / 8106 个用例**（17 skipped），`tsc` 零错误
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

1. ~~补一条没跑成的真机复查~~ **已跑（第 226 波，1.16.317 上）**，读数如下（**下轮别再重复测**）：
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
2. **第 227 波已修的两条（用户连报）**：①插件起不来时的提示（原来指去「插件市场」+ 让人装 Node，
   而真原因是"上一次留下的插件进程占着数据目录"）⇒ 现在**引用插件自己的原话 + 点出进程号**，
   并且**自动清一次残留进程再重试**（安全边界：只结束能证明是本插件的那个 pid）；卡片上多了
   「结束残留进程并重试」。②压缩上下文「点了没反应」⇒ 现在有进度、**常驻回执**、8 秒冷却防重复点。
   ⚠️ 如实记：**冷却期那条真机没验**（要真压掉一个长会话；我没动用户的真实长会话）——只有判据层证据。
3. **可选：模态实测**——给没有依据的模型发一张极小图片：接口**接受**⇒多模态、**明确拒绝**⇒文本、
   **其它错误⇒仍标【未知】**（用户已同意做"确定才标"，实测是唯一可靠路径；约 10–20 秒/个）。
4. **仍未真机确认的历史项**：托盘「退出」是否一下就退、还有没有黑框
   （退出路径的同步等待已改成"发出去不等"，有判据+变异，但**端到端计时没验过**）。
5. 用户已明确**不用**做的：清理注释/文档里的历史路径 `C:\mimo-gui`（那是检出目录名，不是产品名）。

## 6. 门禁与验证命令（复制即用）

```powershell
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
