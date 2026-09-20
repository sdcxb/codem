# Codem 1.16.109 桌面版逐面板走查（真机 / 打包版）

- **对象**：已安装的打包版 Codem（WebView2，`http://tauri.localhost/`），非 dev。
- **驱动**：CDP `--remote-debugging-port=9222`，脚本全部落在 `C:\mimo-gui\.preview-shot\audit-walk-*.mjs`（该目录被 gitignore）。
- **只读承诺**：全程不改源码、不提交 git、不安装、不杀进程、不改任何设置。面板打开/切页签全部用**真实鼠标事件** `Input.dispatchMouseEvent`，不做 `element.click()` 假绿。
- **视口**：1200×727，dpr=3。走查期间窗口尺寸未变。
- **度量基准**：一律限定在**当时最上层**的遮罩容器内量（`.settings-panel` 或 `.modal-overlay`，按 z-index + DOM 次序取最大者），避免量到被遮罩压住的背景内容。

## 度量口径（读表前必看）

| 指标 | 口径 |
|---|---|
| 按钮数 | 最上层容器内 `button` + `[role=button]`，且有尺寸（`display:none`/`visibility:hidden`/`opacity:0` 排除），且与视口相交 |
| 无名数 | 上述按钮中 `aria-label`、`title`、非空文本**三者皆空**的个数 |
| 命中区过小 | 可交互元素（`button`/`[role=button]`/`a[href]`/`input`/`select`/`textarea`/`[tabindex]`）中 `getBoundingClientRect()` 宽或高 **< 24** 的个数。**已扣除**两类假阳性：① 被祖先 `<label>` 撑开的原生控件（例：13×13 的 radio 落在 548×36 的 label 里）；② 中心点命中更大命中层的元素。保留的是真的小。 |
| console 错误/警告 | 该面板**打开动作期间**新增的 `Runtime.consoleAPICalled`（error/warning）条数；走查开始时页面已有基线（本次为 error=7 / warning=5，多为前几轮踩点累积），不计入 |
| 关闭是否可用 | **按可访问名**（`aria-label`/`title`/文本含「关闭/Close」）能否找到关闭按钮，且该按钮中心点命中测试可达 |
| 备注 covered | 中心点被**无关元素**盖住的可交互元素数（`document.elementFromPoint` 抽查，非尺寸判定） |

---

## 走查大表（32 个面板）

| # | 面板 | 打开方式（点的元素可访问名/文本） | 按钮数 | 无名数 | 命中区过小 | console err/warn | 关闭是否可用（按可访问名） | 备注 |
|---|---|---|---|---|---|---|---|---|
| 1 | 设置·通用 | 设置 → 侧栏 `.settings-sidebar-item`「通用」 | 31 | 0 | 0 | 0 / 0 | 可用「关闭设置」 | covered=8：全部是侧栏项被粘性 `.settings-footer` 盖住 + 4 个 `.identity-option`（AI 助手/数字精灵/代码伙伴/赛博管家）中心点被 footer 盖住 |
| 2 | 设置·外观 | 侧栏「外观」 | 19 | 0 | **2** | 0 / 0 | 可用「关闭设置」 | 2 个 `input[type=range]`：548×16、502×16；后者中心点被 `BUTTON.save-btn.sp-btn-auto` 盖住 → 点中心会命中保存按钮 |
| 3 | 设置·安全 | 侧栏「安全」 | 22 | 0 | **1** | 0 / 0 | 可用「关闭设置」 | `input[type=checkbox].icon-md` 16×16（可见名「以明文保存 API 密钥」） |
| 4 | 设置·Git | 侧栏「Git」 | 19 | 0 | **4** | 0 / 0 | 可用「关闭设置」 | 3× `input[type=checkbox].git-env-checkbox` 18×18（无 label 包裹）；1× `input[type=password].git-env-input` 548×18，中心点被 `.settings-footer` 盖住 |
| 5 | 设置·环境 | 侧栏「环境」 | 21 | 0 | 0 | 0 / 0 | 可用「关闭设置」 | covered=1 |
| 6 | 设置·工作树 | 侧栏「工作树」 | 21 | 0 | **2** | 0 / 0 | 可用「关闭设置」 | 2× `input[type=checkbox].icon-md` 16×16 |
| 7 | 设置·知识 | 侧栏「知识」 | 21 | 0 | 0 | 0 / 0 | 可用「关闭设置」 | — |
| 8 | 设置·自动化 | 侧栏「自动化」 | 22 | 0 | 0 | 0 / 0 | 可用「关闭设置」 | — |
| 9 | 设置·多模态 | 侧栏「多模态」 | 24 | 0 | 0 | 0 / 0 | 可用「关闭设置」 | — |
| 10 | 设置·语音 | 侧栏「语音」 | 25 | **1** | **4** | 0 / 0 | 可用「关闭设置」 | 无名：`<button class="toggle-entry" role="switch" aria-checked="false">` 空内容（40×22）；另 3× `input[type=range]` 160×16，其中 1 个被 `.settings-footer` 盖、1 个中心点被 `.settings-overlay` 祖先接走 |
| 11 | 设置·Ollama | 侧栏「Ollama」 | 27 | 0 | **1** | 0 / 0 | 可用「关闭设置」 | `<a>` 文本「下载 Ollama ↗」仅 82×12（4 个中 1 个被 label 撑开已扣除） |
| 12 | **设置·工具** | 侧栏「工具」 | **43** | **7** | **13** | 0 / 0 | 可用「关闭设置」 | **两项最差**。无名 7 个 = `button.usage-stats-close` 22×22（仅 svg）+ 6× `button` 20×19（内联样式纯图标）。过小 13 个 = 上述 7 个 + 6× `button` 36×20（文本「点击禁用」）。其中仅 7 个中心点命中自身；2 个中心点被粘性 `.settings-footer` 盖住，4 个中心点落在 `.settings-overlay`（已滚出面板可视区） |
| 13 | 设置·人设 | 侧栏「人设」 | 25 | 0 | 0 | 0 / 0 | 可用「关闭设置」 | — |
| 14 | 设置·电脑操作 | 侧栏「电脑操作」 | 23 | 0 | **2** | 0 / 0 | 可用「关闭设置」 | `input[type=checkbox]` 13×13（label 仅 548×20，高 20<24）；1× `input[type=range]` 548×16 被 `.settings-footer` 盖。4 个 13×13 radio 因祖先 label 为 548×36 已扣除 |
| 15 | 设置·微信 ClawBot | 侧栏「微信 ClawBot」 | 24 | 0 | **1** | 0 / 0 | 可用「关闭设置」 | `input[type=checkbox]` 13×13 |
| 16 | 设置·连接手机 | 侧栏「连接手机」 | 24 | 0 | **1** | 0 / 0 | 可用「关闭设置」 | `input[type=checkbox]` 13×13 |
| 17 | 设置·代码图谱 | 侧栏「代码图谱」 | 22 | 0 | **1** | 0 / 0 | 可用「关闭设置」 | `input[type=checkbox].icon-md` 16×16 |
| 18 | 设置·宠物 | 侧栏「宠物」 | 22 | **1** | **1** | 0 / 0 | 可用「关闭设置」 | 无名：`<button class="sp-toggle"><span class="sp-toggle-knob"></span></button>` 无任何可访问名；1× `input[type=range].sp-range-full` 558×16 |
| 19 | 设置·高级 | 侧栏「高级」 | 33 | 0 | 0 | 0 / 0 | 可用「关闭设置」 | 该页含 9 个子页签，本次只走「恢复」 |
| 20 | 设置·帮助 | 侧栏「帮助」 | 22 | 0 | 0 | 0 / 0 | 可用「关闭设置」 | — |
| 21 | 设置·用量统计 | 侧栏「用量统计」 | 25 | **1** | 0 | 0 / 0 | 可用「关闭设置」 | 无名：`button.usage-stats-close`（16×16 svg，与「工具」页同类控件） |
| 22 | 设置·性能 | 侧栏「性能」 | 26 | 0 | **1** | 0 / 0 | 可用「关闭设置」 | `input[type=checkbox]` 13×13 |
| 23 | 恢复面板（设置→高级→恢复） | 设置 → 侧栏「高级」→ 点 `.sp-tab`「恢复」 | 32 | 0 | 0 | **1 / 0** | 可用「关闭设置」 | `.recovery-panel` 已渲染，标题「🔄 会话恢复」；其子树 buttons=3 / unnamed=0 / small=0。**唯一 1 条 error 来自"打开设置面板"本身**：`[MiMoAuth] Failed to load auth.json: Cannot read C:\Users\abee\.local\share\mimocode\auth.json: 系统找不到指定的路径。 (os error 3)` |
| 24 | 技能管理 | 侧栏 `.sidebar-tool-item`「技能」 | 13 | 0 | **1** | 0 / 0 | 可用「关闭面板 / Close panel」`.skill-manager-close` | `.skill-manager`；过小：`input.skill-search-input` 776×15（搜索框高度 15） |
| 25 | 插件管理 | 侧栏 `.sidebar-user-plugin-btn`「插件管理」 | 19 | 0 | **1** | 0 / 0 | 可用「关闭面板」`.skill-manager-close` | 容器 `.skill-manager` + `.plugin-mgr-tabs`；过小：`input.skill-search-input` 884×15 |
| 26 | 智能体管理 | 侧栏「智能体」 | 9 | 0 | 0 | 0 / 0 | 可用「关闭面板」`.skill-manager-close` | 标题「智能体定义管理」；与技能/插件**复用同一 `.skill-manager` 根类名** |
| 27 | MCP 管理 | 侧栏「MCP」 | 5 | 0 | 0 | 0 / 0 | 可用「关闭面板 / Close panel」`.mcp-manager-close` | `.mcp-manager`；文本「MCP 服务器管理 … 暂无 MCP 服务器」 |
| 28 | 任务中心 | 侧栏 `.sidebar-nav-item`「任务管理（1 条未读）」 | 22 | **1** | **3** | 0 / 0 | **不可用** | 关闭按钮是纯图标 `<button>`（line 166，无 aria-label/title/文本）→ 按可访问名**找不到**；实测只能**点遮罩背景**关闭。过小：3× `button.lo-link-btn`（「全部 →」「全部 →」「场景 →」）33×15。covered=5：`.lo-zone-card` 被 `.lo-card__title`/`.lo-link-btn` 盖住 |
| 29 | 记忆管理 | 侧栏「记忆」 | 10 | **2** | 0 | 0 / 0 | **不可用** | 关闭按钮 `button.memory-manager-close`（无 aria-label/title/文本）+ 1 个同类纯图标按钮；按可访问名**找不到**；实测靠**点遮罩背景**关闭 |
| 30 | library-ops 看板 | 任务中心 → 页签「看板」（插件接管） | 15 | **1** | **2** | 0 / 0 | **不可用**（同上，共用任务中心的无名关闭） | `.lo-*` 节点 30 个、`.lo-board-host`，确认 `@codem/ui-library-ops` 已接管。过小：2× `button.lo-icon-btn`（「实时事件」「立即刷新」）40×22 |
| 31 | library-ops 场景 | 任务中心 → 「子智能体」→ `.lo-nav__btn`「场景」 | 28 | **1** | **1** | 0 / 0 | **不可用** | `.lo-*` 节点 155 个。过小：`button.lo-icon-btn`「立即刷新」40×22。**covered=12**：6 个场景分区卡（如「前台 · 调度台」「阅览大厅」）中心点被 `.lo-pixel-actors` 盖住 |
| 32 | library-ops 设置 | 任务中心 → 「子智能体」→ `.lo-nav__btn`「设置」 | 18 | **1** | **7** | 0 / 0 | **不可用** | `.lo-*` 节点 213 个。过小：`button.lo-icon-btn`「立即刷新」40×22、`select.lo-select` 53×19、4× `input.lo-range` 120×16 等 |

### 汇总

| 项 | 数值 |
|---|---|
| 覆盖面板数 | **32** |
| 按钮总数 | **712** |
| 无名控件总数 | **16** |
| 命中区过小总数 | **49** |
| console error 总数 | **1**（打开设置面板时的 MiMoAuth auth.json 缺失） |
| console warning 总数 | **0** |
| 异常（exceptionThrown） | **0** |
| 命中区过小最多的面板 | **设置·工具 = 13** |
| 无名控件最多的面板 | **设置·工具 = 7** |

> **去重提醒（避免把 16/49 当成互异控件数）**：任务中心的关闭按钮同属「任务中心/记忆管理」两行；`button.lo-icon-btn`「立即刷新」在 library-ops 的看板/场景/设置三行重复出现；`button.usage-stats-close` 在「工具」与「用量统计」两行各计一次。按面板求和为 16 / 49，**互异控件数小于该值**。

### 走查过程中量到的具体缺陷（均有读数支撑）

1. **无名控件按面板求和 16 个**（互异约 13–14 个，见上「去重提醒」），出现在 9 个面板行上；种类只有 6 种：
   - `button.usage-stats-close`（仅 svg，22×22）—— 在「工具」与「用量统计」各计 1 次；
   - 6× `button` 20×19 内联样式纯图标按钮 —— 全在「工具」页；
   - `button.toggle-entry[role=switch][aria-checked=false]`（40×22，空内容）—— 「语音」页，**有 aria-checked 却没有可访问名**；
   - `button.sp-toggle`（内仅 `.sp-toggle-knob`）—— 「宠物」页；
   - `button.memory-manager-close` + 1 个同类纯图标按钮 —— 「记忆管理」，**关闭按钮本身无名**；
   - 任务中心的纯图标关闭按钮（空 class、无 aria-label/title/文本）—— 「任务中心」及 library-ops 三个子面板行重复计入。
2. **4 个面板按可访问名找不到关闭按钮**：任务中心、记忆管理、library-ops 看板/场景/设置（后三者共用任务中心的无名关闭）。实测这些面板**只能靠点遮罩背景**关闭 —— 键盘/读屏用户没有可用出口。
3. **13 个 40×22 / 20×19 / 33×15 / 82×12 量级的过小命中区**集中在图标按钮、链接按钮和小尺寸表单控件上。
4. **「工具」页 13 个过小元素里只有 7 个中心点能命中自身**（完整清单见 `audit-walk-tools-detail.log`）：1× `button.usage-stats-close` 22×22 + 6× `button` 36×20「点击禁用」+ 6× `button` 20×19 无名。其中 2 个中心点被粘性 `.settings-footer` 盖住、4 个中心点落在 `.settings-overlay`（已滚出 `.settings-panel` 可视区）→ **这 6 个点中心不落在自己身上**。
5. **遮挡**：library-ops 场景页 28 个可交互元素中 **12 个**中心点被 `.lo-pixel-actors` 覆盖；任务中心 22 个中 5 个被 `.lo-card__title` / `.lo-link-btn` 覆盖；设置各页 1–8 个侧栏项被粘性 `.settings-header`/`.settings-footer` 覆盖（属侧栏滚动被粘性头尾压住，见「方法说明」）。
6. **console 唯一一条 error 与面板无关**：`[MiMoAuth] Failed to load auth.json … os error 3`，在**打开设置面板时固定出现 1 条**，随后连切 6 个页签增量为 0，说明它是设置面板初始化路径上的既有问题，不是本次点开的任一页签引起。

### 方法说明（上一轮踩过的两个坑，本轮的处置）

- **侧栏可滚动**：点击前一律先 `scrollIntoView({block:'center', behavior:'instant'})`，待 250ms 后再量坐标，并在点击前做 `document.elementFromPoint` 命中测试。22 个页签**全部** `reachable=true` 且 `inViewport=true`，点击后 `.settings-sidebar-item.active` 文本与目标页签逐一相符（见 `audit-walk-settings.json` 的 `click`/`activeTab` 字段）。
- **遮罩类名不统一**：`.modal-overlay`（z=1300）、`.settings-overlay`（z=1000）、`.collapse-overlay`（z=5）各自为政，且 `.modal-overlay` 自带 `onClick` 关闭。本轮统一按「z-index 最大、其次 DOM 最后」取最上层容器再度量；面板之间强制**回到基线**（具名关闭 → 遮罩背景点击 → Esc 逐级降级并记录实际生效的那一种），避免下一次点击被上一层遮罩接走。
- **命中区判定**：只按 `getBoundingClientRect` 会把「13×13 radio 落在 548×36 label 里」误判为过小（该面板原始读数 6，扣除 label 撑开后为 2）。本轮对每个小元素做中心点抽查并区分 label 撑开 / 祖先容器盖住 / 真的小。

---

## 未覆盖清单

**任务书点名的面板：全部覆盖（0 项缺失）。** 下表是面板内部**未逐一点开**的子视图，以及本次没有触及的面与条件。

### 1. 面板内部的子页签/子视图未走

| 所属面板 | 未覆盖的子视图 | 原因 |
|---|---|---|
| 设置 → 高级 | 智能体、心跳、重试、提示词、分层设置、纠偏模型、Agent Profile、缓存统计（共 8 个 `.sp-tab`） | 本次只按任务点名走了「恢复」子页签；这 8 个与「恢复」同级，未逐一点开 |
| 任务中心 | 概览、委派、自动化、Issues、团队、收件箱（6 个页签） | 任务只点名"任务中心"整体；为深入 library-ops 而走了「看板」与「子智能体」，其余页签未逐一点开 |
| 技能管理 | 「技能市场」页签 | 只量了默认的「我的技能」视图 |
| 插件管理 | 「插件市场」页签 | 只量了默认的「已安装」视图 |
| MCP 管理 | 「服务器目录」页签、「JSON 导入」弹窗、「添加服务器」流程 | 只量了默认视图（当前 0 个服务器） |
| 记忆管理 | 「项目」「会话」「全局」三个筛选视图 | 只量了默认「全部」视图 |
| 恢复面板 | 列表项展开、清除恢复数据、导出、强制保存等动作及其中的确认弹窗 | 这些是**有副作用的写操作**（会删数据），超出"只走查只记录"的授权，未点击 |
| 插件管理 | 关闭插件的确认弹窗（`.plugin-mgr-dialog`，含 `modal-overlay` 叠加） | 触发它需要真的切换插件开关 = 改设置，未执行 |

### 2. 非设置/非模态的主界面区域未走

聊天主界面与消息区、知识笔记本（NotebookWorkspace）、记忆、文件快照面板、上下文监控、执行轨迹、侧边面板、宠物互动、代码图谱可视化、身份/登录面板、以及各类 toast/横幅 —— 均不在任务点名的面板清单内，本次未逐面板度量（`文件`/`视图`/`帮助` 三个顶部菜单也未展开）。

### 3. 条件未覆盖

| 条件 | 说明 |
|---|---|
| 窗口尺寸 | 全程只测 **1200×727（dpr=3）** 一种尺寸；窗口最大化/最小化、窄屏与响应式断点（侧栏收起 `.mobile-sidebar-toggle` 路径）未测 |
| 空态 vs 有数据 | MCP 为 0 服务器空态；插件 208 个、技能 11 个、记忆 18 条为有数据态；任务中心多为 0 计数空态。**同一面板的空态/满态未成对对比** |
| 语言 | 界面为中文（zh）；英文（en）文案下的可访问名未走查 |
| 主题 | 未切换主题（light/dark）比对命中区与遮挡 |
| 键盘可达性 | 只按"可访问名能否找到"判定关闭可用性，**未做真实 Tab 键序走查**，因此不含"能被读屏念出但无法 Tab 到达"这类结论 |
| 插件禁用态 | `@codem/ui-library-ops` 为启用态；禁用后宿主回退看板（`IssueBoard`）的形态未走查 |

---

## 复现方式

```powershell
# 前置：应用已带远程调试端口运行
Invoke-WebRequest http://127.0.0.1:9222/json/version -UseBasicParsing   # 200 = 可用

cd C:\mimo-gui
node .preview-shot/audit-walk-settings.mjs            # 22 个设置页签 → audit-walk-settings.json
node .preview-shot/audit-walk-dump.mjs                # → audit-walk-settings-detail.txt
node .preview-shot/audit-walk-secondary.mjs           # 技能/插件/智能体/MCP/任务中心/记忆 → audit-walk-secondary.json
node .preview-shot/audit-walk-recovery-library.mjs    # 恢复 + library-ops → audit-walk-recovery-library.json
node .preview-shot/audit-walk-forensics.mjs           # 命中区归属取证 + console 归因 → audit-walk-forensics.json
node .preview-shot/audit-walk-summarize.mjs           # 汇总 → audit-walk-summary.txt
node .preview-shot/audit-walk-verify.mjs              # 点击可达性复核
node .preview-shot/audit-walk-tools-detail.mjs        # 「工具」页小命中区完整清单
```

原始读数：`audit-walk-settings.json`、`audit-walk-secondary.json`、`audit-walk-recovery-library.json`、`audit-walk-forensics.json`、`audit-walk-summary.txt`（均在 `C:\mimo-gui\.preview-shot\`）。

---

## 本次走查对工作区的实际影响（自证）

- **我在本次任务中只写过 `C:\mimo-gui\.preview-shot\` 下的文件**（`audit-walk-*.mjs` / `*.json` / `*.log` / `*.txt` 与 `audit-ui-walk.md`），该目录被 gitignore。**没有对 `src/`、`src-tauri/` 或任何被跟踪文件发起过写操作，也没有执行任何 git 写命令（未 add / 未 commit）。**
- 走查结束时应用状态已复位：`settingsPanelOpen=false`、可见 `.modal-overlay` 数 = 0，无遗留遮罩。
- **需要父级注意**：`git status --porcelain` 在本次走查结束时报告 5 项工作区改动 —— `src-tauri/codem-db/src/engine.rs`、`src-tauri/codem-db/tests/engine_tests.rs`、`src/core/llm/agent-message-queue.ts`、`src/core/storage/event-log.ts`、`src/test/agent-message-queue-bounds.test.ts`。这 5 个文件的 mtime（07:59:55–08:05:55）落在本次走查时间窗内但与我的写入交错，**说明有另一个写入方在同一工作区并发改源码**（或用户本人）。这些改动**不是本次 UI 走查产生的**，请勿归因于本报告。

