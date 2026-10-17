# 主对话区顶部页签栏隐藏 —— 真机复核（2026-10-17，第 233 波）

> 用户要求：**把主对话区域顶部那条页签栏（对话 / 终端 / 性能 / 文件 / 任务 / CI-CD）整体隐藏**，
> 理由是「这些都有其它入口」。产品方已确认「我确定都有其他入口，直接隐藏吧」。
> 本目录记录：隐藏实现 + 逐项可达性真机核查 + 补掉的入口缺口 + 判据演进。

## 1. 隐藏实现

| 改动 | 位置 | 说明 |
|---|---|---|
| 三套皮肤都不再渲染入口栏 | `src/App.tsx`（hub / dream / 默认三处 `<BottomPanelTabs>` 全部删除） | 面板本体（`bottomTab === "…"` 的四条分支）**没删**，仍是兜底挂载点 |
| 入口栏组件删除 | `src/components/BottomPanelTabs.tsx` → 已删 | 只保留「成员 / 门控 / 入口登记」数据，迁到 `src/core/ui/bottom-tab-entries.ts` |
| `bottom-panel.tabs` 槽位撤销 | `src/core/slots/declare-slots.ts` | 它从声明起就没有贡献者，唯一宿主是这条栏；没有宿主还留着声明 = **假扩展点**，故连同声明删除（原地注释写明恢复顺序：先恢复宿主再声明） |
| 降级 effect 改为按登记表现算 | `src/App.tsx:790` 附近 | 四条手写 `if` 收成遍历 `BOTTOM_PANEL_GATE_FLAGS`，成员与门控只留一份来源 |

## 2. 六个成员的可达入口（真机逐项点过）

| 成员 | 入口（文件:行） | 真机证据 |
|---|---|---|
| **对话** | 默认页 `App.tsx:786 useState<BottomTab>("chat")`；面板关闭 `App.tsx:4989/5016/5032 onClose ⇒ setBottomTab("chat")`；抽屉关闭 `PanelSidebar.tsx:184 .panel-sidebar-close` | `tabbar-01-hidden.jpg`：主区直接进对话；三次关闭都回到 composer（终端/设置/抽屉各一次） |
| **终端** | 标题栏按钮 `TitleBar.tsx:460 aria-label="切换终端"`；命令面板命令 `TitleBar.tsx:304 显示/隐藏终端`（+快捷键）；App 接线 `App.tsx:5061 onToggleTerminal` | `tabbar-02-terminal.jpg`：点标题栏终端图标 ⇒ `.terminal-drawer` 出现真实 `cmd` 提示符（`C:\mimo-gui>`），再点自己的 `×` 关闭 |
| **性能** | 设置 → 性能 `SettingsPanel.tsx:1146-1147`，渲染**同一个** `PerformanceDashboard` | `tabbar-03-perf-settings.jpg`：真实数据「事件总数 91 / 会话总数 3 / 事件速率 0」，含总览/会话/时延三个页签 |
| **文件** | 右侧抽屉「文件」页签 `PanelSidebar.tsx:71`（同一个 `FileExplorer`） | `tabbar-04-drawer-files.jpg`：抽屉打开，文件树列出 `.codem` / `com.codem.app` / `config` / `coverage` / `dist` 等真实条目 |
| **任务（本轮补的缺口）** | 右侧抽屉「任务」页签 `PanelSidebar.tsx:85` + `:228 <JobsPanel />`（同一个 `JobsPanel`） | `tabbar-05-drawer-jobs.jpg`：「后台任务 / 刷新 / 当前没有后台任务。Agent 用 `terminal_send(run_in_background)` 起的命令会出现在这里。」 |
| **CI/CD** | 右侧抽屉「CI/CD」页签 `PanelSidebar.tsx:88`（同一个 `CicdPanel`） | `tabbar-06-drawer-cicd.jpg`：「加载 / 自动刷新 / 生成 Workflow」 |
| **game** | **刻意无入口**（`GAME-4`） | 未动；入口表里没有它，判据 BOTTOM-TAB-2 钉住 |

### 缺口与补法（唯一一项：`jobs`）

- **缺口事实**：隐藏页签栏后，`jobs` 只剩这条栏一条路。会话头的 `JobsBadge` **从来没被渲染过**
  （全仓只有定义，没有任何 `<JobsBadge` 调用）；任务中心（`TaskCenter`）是另一套全局面板，不是同一能力。
- **补在哪**：右侧抽屉 `PanelSidebar` 新增「任务」页签，渲染**同一个** `JobsPanel`。
- **为什么选这里**：该抽屉早就是「文件」「CI/CD」两处**同一组件第二挂载点**（`FileExplorer` / `CicdPanel`），
  「任务」按同一形状补进去与既有设计一致；插件门控也沿用同一条 `@codem/ui-jobs`（关掉插件时该页签不出现）。
  没有新造第三种面板形态，也没有复活 `JobsBadge`（那会再造一个"看起来像真的、其实是死代码"的控件）。

## 3. 判据演进（`src/test/bottom-tab-entry-ratchet.test.tsx`，9 条全绿）

口径从「每个成员必须有可见**页签**」改成「每个成员必须有**可达入口**，且入口点登记在表里」：
成员清单仍**从类型定义现算**（`bottom-tab-entries.ts` 的 `BottomPanelTabId`；`App.tsx` 的
`type BottomTab` 必须只是它的别名），`game` 仍登记为刻意无入口。

| # | 守什么 |
|---|---|
| 1 | 每个成员要么有登记入口、要么被登记为刻意无入口（理由非空）；登记不许漂移；成员类型只许一份 |
| 2 | `game` 登记为刻意无入口、理由引用 `GAME-4`、App 里没有 `setBottomTab("game")` |
| 3 | **每条登记入口都真实存在**（文件存在且包含登记符号）—— 防止「口头声明有入口」 |
| 4 | 页签栏确实已隐藏：App 不渲染、不 import、不再出现 `panel-tabs`，组件文件已删 |
| 5 | 门控仍生效：降级回退由 `BOTTOM_PANEL_GATE_FLAGS` 现算，四个面板分支都带门控 |
| 6 | 面板本体没删；0 贡献者的槽位不许挂 `showDegraded`（假横幅） |
| 7 | 反向对照：审计函数能抓到「漏入口 / 空理由 / 登记漂移」 |
| 8 | 入口宿主面正确：files / jobs / cicd 在抽屉、perf 在设置、terminal 在标题栏；抽屉 jobs 页签真的渲染 `JobsPanel` |
| 9 | 隐藏后不留假扩展点：`bottom-panel.tabs` 既没声明、也没有 render 出口 |

**变异自证（真跑，先红后绿）**

| 变异 | 结果 |
|---|---|
| 删掉 `BOTTOM_TAB_ENTRIES.jobs` 的全部入口 | **BOTTOM-TAB-1/3/8 红**（`这些成员既没有登记入口…：jobs`、`jobs 至少要有 1 条登记入口`） |
| 把 `game` 从 `DELIBERATELY_ENTRYLESS_TABS` 删掉 | **BOTTOM-TAB-1/2/3 红**（`…：game`、`game 必须在刻意无入口登记里`） |
| 把 jobs 入口的 `symbol` 改成不存在的 `id: "jobs-gone"` | **BOTTOM-TAB-3 红**（`jobs → src/components/PanelSidebar.tsx 里找不到 id: "jobs-gone"`） |
| 还原 | 9/9 绿 |

## 4. 真机复核（exe `9ab9cf56…`，PID 37168，端口 9444；只按 PID kill 自己 spawn 的，持锁 `.preview-shot/_realmachine.lock`）

- **栏确实不出现**（DOM 现算）：`.panel-tabs` = **0**、`[role=tablist]` = **0**；主区从会话头直接开始（`tabbar-01-hidden.jpg`）。
  顶部动作区仍在：`切换执行模式 / 搜索 / 设置 / 切换主题 / 切换终端`（终端入口就是这里）。
- **六项逐条点到**：见第 2 节表格与 6 张截图；每次点击都由 `_walk-click` 走**真实鼠标**（`scrollIntoView` + CDP mouse），
  返回的 `top=` 命中控件自身（如 `titlebar-action-btn` / `panel-sidebar-tab-label`），不是被遮挡的其它节点。
- **回对话路径**：终端抽屉 `×`（`terminal-drawer-close`）、设置 `×`（`settings-close`）、抽屉 `×`（`panel-sidebar-close`）
  三条都点到并复核（`.terminal-drawer` 消失 / `[role=dialog]` 消失 / `.panel-sidebar-tabs` 消失，composer 回来）。
- **环境**：构建时若 `target/release/codem.exe` 被别的实例占用，处置方式是**重命名被占用的 exe**（不 kill 别人的进程）；
  本次构建未遇到占用（`EXIT=0`，`Finished release profile in 3m25s`）。运行用独立 `WEBVIEW2_USER_DATA_FOLDER`，
  数据根仍是真实数据根（会话/项目/设置都是用户真实数据）。

## 5. 门禁（本轮实测）

| 门禁 | 结果 |
|---|---|
| `npx tsc --noEmit` | 0 错误 |
| `npx vitest run`（全量） | **699 文件 / 8336 通过 + 17 skipped，3 条红且均不在本改动面**（见下） |
| `npm run audit` | **exit 0**（末段 `✅ 没有 ASCII 控制字节`；内部上报点闸门 267=267、变异 48 波全部有效） |
| `npm run audit:knip` | **✅ 没有增长**（exports 49/49、types 21/21、duplicates 10/10、entry 20=20） |
| `node tools/audit/scan-report-sites.mjs --check` | `扫描命中 267 处 = 登记表 267 条（triaged 267 / pending 0）`，漂移/过期/缓存漂移 0 |
| `node tools/mutate/check-artifacts.mjs` | `分诊闸门通过：登记波次 48 个，全部有可用且未过期的变异证据` |
| `node tools/ui-audit/css-contract.mjs --write` | 快照写入后复核 **`✅ 无变化`**（删掉 `.panel-tabs-close` 两条死规则 ⇒ 必须同步） |
| `node tools/audit/scan-style-literals.mjs --check` | `✅ 棘轮通过：11 个族全部不超过基线` |
| `npx vitest run src/test/ui-consistency.test.ts` | **3/3 绿**（本轮删掉无宿主的 `.panel-tabs-close` 后 `css-class-unused` 从 2 回到 0） |
| `npx vitest run src/test/bottom-tab-entry-ratchet.test.tsx` | **9/9 绿** |

**那 3 条红与本改动无关（单跑确认过）：**

1. `audit184-render-layer-fixes` 的 `F1e`（接线检查）—— 把 `src/App.tsx` 换回 **HEAD 版本**（不含本轮改动）再跑，**同样红**；
   根因是它自己用 `src.indexOf("// Flush all buffers on unmount")` 当切片终点，而那句是注释、前面又被
   `stripComments` 剥掉了 ⇒ `indexOf` 返回 `-1`，切片变成"到文件末尾"，于是把 1861 行附近历史上的
   `useProjectStore.getState()` 也圈进来。属既存判据缺陷，不在本次改动面。
2. `output-schema-ratchet` ×2 —— 报「基线工具数与真实 registry 不一致（基线过期，要刷）」，是另一路新增工具后
   没刷 `tools/evidence/output-schema-baseline.json`。本轮没有增删工具。

## 6. 未做 / 未验（如实）

- **`game` 面板**：维持刻意无入口（`GAME-4`），本轮没有给它任何入口，也没有点它。
- **`bottomTab` 四条兜底分支的"用户路径"**：perf / files / jobs / cicd 的**底部**挂载点现在没有 UI 会进入
  （入口都在设置/抽屉里，是同一组件的第二挂载点）。它们作为兜底保留是产品要求（「不要删掉面板自身」），
  但**不再有用户路径**这一点已写进 `bottom-tab-entries.ts` 的注释，避免下次误以为它们可达。
- **三套皮肤的截图**：真机只跑了默认皮肤（`skin` 默认）；hub / dream 的隐藏由源码判据 BOTTOM-TAB-4 守
  （App.tsx 里三处渲染全部删除、组件文件已删），**没有**逐皮肤截图。
- 没有改版本号、没有动 CHANGELOG / PROJECT-GUIDE / AGENTS、没有发版。
