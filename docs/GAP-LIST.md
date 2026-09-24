# 当前缺口清单（唯一一份）

> **本文是 mimo-gui / codem 当前状态的唯一清单。** 第 72 轮（2026-09）起维护。
>
> `docs/` 下还有上百份历史文档，其中 40 份文件名看起来就像"当前待办/当前缺口"
> （`TODO.md`、`AUDIT-ZERO-GAP.md`、`IMPLEMENTATION-PLAN-FULL.md`、`WECODE-REF-GAP-ANALYSIS.md` …）。
> 它们**都已经加了「历史文档（不再维护）」横幅**，并且有一条门禁用机器保证这件事：
> `src/test/docs-current-gap-list.test.ts`。理由很具体：实测对 `TODO.md` 读出来的"还没做"里，
> 有相当一部分早就做完了（它列的 `InlineMessageEdit` / `ScrollbarMarkers` /
> `ScrollToBottomIndicator` 都已在代码里存在），于是"缺口清单"自己变成了谣言来源。
>
> **要判断"还有没有缺口"，只看本文。** 本文里每一条都要写清：**判据是什么、怎么量、量到多少**。

---

## 一、机器状态（每次发布后更新）

| 项 | 值 | 怎么核对的 |
| --- | --- | --- |
| 装机版（用户手里那份） | **1.16.134** | 真机启动后读 `version`。**127→128、128→129、129→130、130→131、131→132、132→133、133→134 七次都是更新器自己升的**（按钮 `检查更新 → 检查中… → 发现新版本 x，下载中…` 然后应用重启、版本变化）；1.16.126 那次因网络掐断用构建产物直装 |
| GitHub Latest | v1.16.134 | `node tools/release/verify-update-manifest.mjs --remote` **7/7** |
| 仓库 `latest.json` | 1.16.134 | 同上 |
| 本轮版本 | 1.16.134 | — |
| **确认框真的会弹**（第 84 轮修的根因，装机版实测） | 在 1.16.131 点需要确认的入口（标题栏「切换执行模式」）：控制台 **error 0**（改前必现 `Command plugin:dialog|confirm not allowed by ACL`）；枚举顶层窗口看到 **Win32 对话框窗口**（类名 `#32770`、标题 Codem）出现，且**主窗口被 disable**（模态的典型形态）；向该窗口 PostMessage 一个回车后它消失、主窗口恢复 enabled | `.preview-shot/verify-confirm-dialog-real.mjs`（点击 + 控制台增量）、`.preview-shot/_list-windows.mjs`（窗口枚举）、`.preview-shot/_dismiss-native-dialog.mjs`（P/Invoke 关框） |
| **皮肤/头像可访问性**（第 83 轮修的，装机版复核） | 皮肤卡片 **3/3 是 `<button type=button>`、3/3 可聚焦、3/3 带 `aria-pressed`、恰好 1 个选中、名字互不相同**（皮肤：默认/Hub/梦幻）、网格 `role=group`；头像预设 **50/50 各有互不相同的 `aria-label`（预设头像 1…50）、50/50 带 `aria-pressed`**、装饰图 `alt` 为空；用修好后的度量重数：**interactives 50 / unnamed 0** | `.preview-shot/verify-a11y-skin-avatar.mjs` |
| **更新下载重试**（第 82 轮修的缺陷） | 装机版点「检查更新」→ `检查中…` → `未发现更新（当前 v1.16.127）—— 更新清单已读到，里面没有更高的版本；若刚发布，CDN 可能还没同步`；控制台 error **0**（1 条 warning 是"未安装更新：none"的正常留痕）。**重试路径的真机端到端**要等下一次有可升级版本（见 O-13） | `.preview-shot/_observe-update-flow.mjs`（逐次记录按钮文案变化 + 控制台增量） |
| **修复确实进了装机包** | `dist/assets/main-*.js` 含 `下载中断，正在重试` 与 `update-retry`，且**安装包构建时间（14:37:38）晚于 dist（14:34:48）** ⇒ 打进包的是含修复的前端产物 | 时间戳判据 + `Select-String dist\assets\main-*.js` |
| **沙箱开关 fail-open 修复确实在装机版里**（第 87 轮修的缺陷） | 装机版 **1.16.134**（版本号来自 `%LOCALAPPDATA%\Codem\codem.exe` 的 ProductVersion，由更新器自己从 1.16.133 升上来）。在这份**正在运行**的应用里取回它实际加载的 `assets/main-*.js`，四项标志物全在：`读取沙箱设置失败，已沿用上次成功读到的值`、`界面上的开关不代表本次实际生效状态`、`sandbox.readSetting`、`codem-sandbox-enabled`；启动后控制台 **error 0 / warning 0 / exception 0**。⚠️ 标志物只能证明**这段代码打进去了**；「读失败时沿用上次值」这个**行为**由门禁 `sandbox-fail-open.test.ts`（SBX-1…4）+ 扫描器变异自证守着（真机上无法制造一次「设置读取失败」） | `.preview-shot/verify-sandbox-fix-shipped.mjs`（用字符串字面量当标志物 —— 生产构建会重命名标识符，用局部变量名会永远找不到） |
| **门禁全绿（第 87 轮实测）** | `npm run verify` 退出码 **0**（覆盖率棘轮 + 基线对账 + knip 棘轮 + jscpd），**376 文件 / 6087 通过 / 16 跳过 / 0 失败**；`npm run audit` **11 道 exit 0**（第 87 轮新增 `audit:fail-open`） | 直接跑这两条命令看退出码 |
| **上下文面板口径自洽**（第 81 轮修的缺陷，装机版复核） | 同一会话同一组数字：改前 `21% ⇒ 压力等级 临界 + 🔴 即将满`；改后 **`21% ⇒ 压力等级 正常`、无告警条** | `node .preview-shot/verify-context-pair.mjs`（读的是**界面上真实渲染的文字**，并按 0.5/0.7/0.9 反推应有等级） |
| 迁移演练（在**副本**上跑） | 16 表 / 3990 行导入，逐表摘要全对；`--verify` 全部一致（新库 3991 行）；旧库 sha256 未变 | `node tools/migrate/storage-migrate.mjs --apply --src <副本> --dst <副本>` 然后 `--verify` |
| 冷启动读数（装机版 1.16.125） | JS 堆 **42MB** / DOM **617** 节点 / 25 秒内控制台 error 0、exception 0（1 条 `[Engine] CLI mode: no account found` 属预期） | `.preview-shot/_verify-1125.mjs` |
| **长跑门禁**（第 81 轮新增，已跑通） | 8 分钟 / 19 次采样 / **114 次面板切换**：堆 41→42MB、DOM 844 恒定、句柄 362→364、进程树 1266→1282MB（24 个 msedgewebview2）—— **无越界、无单调增长、且确有负载** | `node .preview-shot/stability-longrun.mjs --minutes 8 --interval 20`（判据与样本都在脚本里） |

## 二、当前**未关闭**的项

| # | 项 | 现状（事实 + 数字） | 关闭它的条件 |
| --- | --- | --- | --- |
| O-1 | **渲染进程崩溃的根因** | 用户报过一次"白屏"（窗口在、页面崩）。事后**零痕迹**：`codem-crash.log` 不存在、运行时日志无异常、Windows 事件日志无 `codem.exe` 记录、Crashpad 无 dump（被 OOM 杀掉不产生 dump）。第 71 轮交付的是**证据链 + 有界自愈**：`ProcessFailed` → 运行时日志（类型/原因/退出码/模块 + 进程树内存）、前端 20s 心跳、一次性崩溃标记 + 用户可见提示、10 分钟内最多自动重载 3 次。已用 CDP `Page.crash` 主动打死渲染进程验证过：留下 `kind=RENDER_PROCESS_EXITED(1) reason=CRASHED(3) exit_code=-2147483645`、`自动重载页面（第 1/3 次）`、下一条心跳 `uptime=0s`。**如实标注：原始那次崩溃没有复现** | 下一次真机出现时，运行时日志里出现 `ProcessFailed` 那一行（带退出码与出错模块）或崩溃前最后一跳心跳的内存水位 |
| O-2 | **附件读路径无法用真机数据验证** | 代码侧已修（`attachments` 进首屏预取清单 + `useDomainReady("attachments", refreshMessageAttachments)` 就绪后补读），并有 5 条门禁（读不到时保持原样、不抛、已补过的不重复替换）。**但本机 `attachments` 表 0 行** —— 没有真实附件数据，所以"界面上看得见"这件事**量不到**，只能证明"该补的时候会补" | 真机产生至少 1 条附件（发一张图/一个文件），然后核对消息上出现附件且与库一致 |
| O-3 | ~~确认框修复的"最后一公里"没端到端量过~~ **已关闭（第 84 轮）** | 见下面"已关闭"里的 C-16：真机根因找到并修好，且**在装机版上量到"框真的弹出来了"** | — |
| O-4 | **走查发现的三类现象未定性/未修** | ① **无名按钮**：第 83/84 轮已处理三批 —— 头像预设（纠正误报：名字来自 `<img alt>`，但 50 个名字全一样 ⇒ 已给可区分的 `aria-label`）、**皮肤卡片**（真缺陷：`<div onClick>` 键盘完全用不了 ⇒ 改成 `<button aria-pressed>`）、**31 个图标关闭按钮 + 8 个折叠侧栏图标条**（已补 `aria-label`；侧栏名字取自紧邻的 `<TooltipContent>` 表达式）。**修正了两个"工具说没问题"的假绿**：走查度量原来看不到 `img[alt]`（已修）；静态扫描原用 `onClick={() => …}` 会被非贪婪正则截断 ⇒ 报 55 处而真实是 **195 处**（已修，规则收进 `tools/ui-audit/icon-button-scan.mjs`）。**仍待处理**：其余 **51 处**无名图标按钮（清单：`node .preview-shot/audit-icon-buttons.mjs`；⚠️ 上一版写的 156 含 95 处误报 —— 扫描器把 `{isZh ? '选择文件' : 'Choose File'}` 这类**会渲染文字**的表达式当成了「没有文字」，第 85 轮已修正）—— 每个组件的图标含义不同，机械补名字就是造假，需要一个组件一个组件看；② **小命中区**：26 个面板有读数，典型 `收件箱 INPUT 13×13`；③ **被遮挡控件**：123 个面板有读数，**多数是 sticky 头导致的正常形态**（度量还没区分"sticky 头"与"真的被压住"）。样本与读数：`docs/ui-walk-round72.md` | ① 按清单逐个补可访问名，并把棘轮基线（156）一路收紧到 0；② 逐个量"有效命中区到底多大"再决定改不改 CSS；③ 在度量里排除 sticky 头后重跑，剩下的才算真被压住 |
| O-12 | **三个面板仍没走查到**（本机条件不足） | 第 81 轮补走右侧面板后，剩下三处**没有真机读数**：① **PPT / 文档查看器** —— 需要真实文件才能打开（本机没有可打开的 .pptx/.docx，走查不去造一份假文件）；② **项目管理器对话框**（`ProjectManager`：新增/克隆/删除分支）—— 删除是破坏性动作、克隆要写盘，走查**只点到入口**没进对话框；③ **知识图谱的交互**（拖拽/缩放/点节点）—— 图谱数据在（33 节点 / 49 边），但"交互后界面与库是否一致"没量 | ① 用一份真实 PPTX/DOCX 打开一次并量"渲染出来没有"；② 项目管理器只用**只读**动作（打开列表、取消）走一遍；③ 图谱做一次"点节点 → 详情面板内容 vs 库里那条边"的对照 |
| O-13 | **更新重试的"真机端到端"没跑到**（本机当前无可升级版本） | 第 82 轮的修复（有界重试 + 可读错误）已配门禁 7 条 + 6 处突变，且**确认进了装机包**。第 83 轮又拿到两次真机升级（127→128、128→129，都是更新器自己完成、应用重启后版本变化），但**两次下载都没有被掐断** ⇒ 重试分支仍未触发。**如实标注：不给"真机验证过重试"这句话** | 下一次有可升级版本、且下载真的被掐断时，观察按钮出现「下载中断，正在重试（第 n/3 次…）」+ 控制台 `[updater] 下载第 n/3 次失败（可重试）`；若一直掐断则应看到**可读的失败文案**。工具：`.preview-shot/_observe-update-flow.mjs`（**警告边跑边打**，避免应用重启导致结尾汇总丢失） |
| O-14 | ~~探针抽屉里那 4 个语法已坏的历史脚本，改动是否真的生效~~ **已关闭（第 87 轮）** | 见下面「已关闭」里的 C-19：逐项核对**效果**（不是核对当年的代码原文） | — |
| O-5 | ~~19 处 `alert()` 没走统一入口~~ **已关闭（第 83 轮）** | 见下面"已关闭"里的 C-12：生产代码 **15 处**裸 `alert` 已全部迁到 `alertDialog`，并新增 NC-6/NC-7 两条门禁 + 2 处突变 | — |
| O-6 | **覆盖率只有"聚合 + 目录级"地板，没有按文件** | 棘轮已上线（全局 lines 52 / functions 46 / branches 42 / statements 50，另按目录：存储 81 / LLM 60 / 会话 74 / 诊断 96；数字与实测见 `tools/audit/coverage-baseline.md`）。**已知局限（不假装已解决）**：聚合阈值挡不住"某个文件掉到 0、总量被别处补回来" | 按文件设地板（需要一次专门的测量：逐个 `src/core/**` 文件的实测值 → 取八成做地板） |
| O-7 | ~~性能/稳定性只有"当前基线"，没有回归闸门~~ **已关闭（第 81 轮）** | 见下面"已关闭"里的 C-9：长跑门禁已落地并跑通 | — |
| O-8 | **knip 的 348 未用导出 / 222 未用类型没有逐条分诊** | 已把它变成**棘轮**（`tools/audit/knip-gate.mjs` + `knip-baseline.json`：只许降不许升，在 `npm run verify` 里跑）。"未使用文件"那一类是逐条分诊过的，期望值为 **0**（再出现一个就是真发现）。**如实标注：这一项不是"已清零"，只是"涨了会红"** | 逐条分诊 348+222 条（方法见 `docs/DEAD-CODE-TRIAGE.md` 第 1 节），确属误报的写进 `knip.json`、其余删掉，然后 `node tools/audit/knip-gate.mjs --update` 收紧基线 |
| O-9 | ~~更新器下载失败时没有任何重试与可诊断信息~~ **已关闭（第 82 轮）** | 见下面"已关闭"里的 C-11：有界重试 + 可读错误已落地并配门禁/突变 | — |
| O-10 | **走查/探针会改用户状态** | 本轮探针点「切换执行模式」把 mimo-gui 的执行模式从"本地处理"改成了"新工作树"（`codem-project-execution-modes = {"C:\\mimo-gui":"git_worktree"}`）。已还原：关应用 → 用引擎 CLI 直写设置为 `current_workspace` → 重启后标题栏显示「本地处理」（工具 `.preview-shot/_exec-mode-setting.mjs`，含只读回读核对）。**教训**：探针要"点会改状态的东西"时，先记下原值 | 给走查脚本加"改动前记录原值"的小工具（本轮已把还原路径写成脚本） |
| O-16 | **启动时「密钥解不开」只有控制台 warn，没有用户可见面**（第 87 轮核对 C-19 时发现） | 启动流程里 `hydrated.failed > 0`（换了 Windows 账户/机器 ⇒ DPAPI 解不开）只 `console.warn`（`src/App.tsx` 凭据段）。**用户能看到的只有**：主动打开「设置 → 安全」时那一行「其中 N 个**本账户解不开**（密文已保留）」（`SecretStorageSetting.tsx` 读 `status.unreadable`）。**如实标注**：本机没有「解不开」的真实数据（本机密钥是本账户封的、都解得开），所以「用户到底会不会被卡住、请求报错文案指不指向这个原因」**没有量到** —— 这一条是**待确认**，不是已确认的用户缺陷 | ✅ **已做（第 88 轮）**：用副本库 + `CODEM_DB_PATH` 启动装机版把这一幕真的跑出来了 —— 启动横幅里**没有**任何「密钥解不开」的提示（横幅那条是凭据普查的安全提醒），用户能看到的只有：主动打开「设置 → 安全」时那行「其中 1 个**本账户解不开**（密文已保留）——请重新填写这些 API Key」，以及控制台两条 `[secrets] … 密钥解不开`。②若确实只落在控制台（**是**），就把这条失败走上报通道（横幅 + 「设置 → 安全」跳转），并配门禁；② 若确实只落在控制台，就把这条失败走上报通道（横幅 + 「设置 → 安全」跳转），并配门禁：`hydrated.failed > 0` 必须产生一次用户可见上报 |
| O-17 | **还有「发现类」消息没走 advisory？**（第 88 轮只搬了维护侧的四个站点） | 已搬的四个见 C-21；**尚未逐处分诊**的是维护之外的自检/普查类上报（例如 `reconciliation.*`、`plugin.*diverged`、事件结构自检在**其它调用点**的形态）。本轮只做了「维护文件内 13 个上报点」的分诊（工具 `node .preview-shot/_triage-report-sites.mjs [文件...]`，输出 area + 是否已给 title），维护外的站点还没过一遍 | 用同一个分诊脚本把 `src/core/**` 里所有 `reportPersistFailure` / `reportActionFailure` 调用点列出来，逐处判「发现 / 失败」，把发现类搬去 `reportAdvisory`；然后加一条结构判据（新出现的失败上报必须给 `title`，判据已在 ADV-7 里对维护文件生效，可推广到全仓） |

## 三、本轮**已关闭**的项（附判据）

| # | 项 | 判据（可复核） |
| --- | --- | --- |
| C-1 | 反馈有**两条写路径**：遗留 `MessageStorage.saveFeedback`（引擎 `feedback.set`，**5 列**、不写域镜像）+ 域写（**9 列**）；两者并存时 5 列那条会把 `note`/`version`/`created_at`/`updated_at` 抹成 NULL，且写进去读不到 | 渲染侧与**引擎侧**都删掉了：`src/core/storage/message.ts` 的 `saveFeedback` / `feedbackCache` / `invalidateFeedbackCache`，`src-tauri/codem-db` 的 `feedback.set/get/delete`（命令清单 + 派发分支 + `config.rs` 实现三处）。门禁 `src/test/feedback-single-write-path.test.ts` 6 条（FB-1…FB-6，含**全生产源码树扫描**与**引擎命令清单**两处结构判据）+ 引擎用例 `message_feedback_goes_through_generic_crud`（9 列写、覆盖不产生第二行、取消 = 删行、`CHECK` 与外键仍然生效）。**7 处突变全部被抓**（`.preview-shot/mutate-feedback-single-write.mjs`） |
| C-2 | 覆盖率阈值**从来没有生效过**（provider 未安装 ⇒ `npm run test:coverage` 直接 `MISSING DEPENDENCY`） | 装 `@vitest/coverage-v8` + 先量后定棘轮（见 O-4）+ 对账工具 `tools/audit/coverage-baseline.mjs`（`--check` 在 `npm run verify` 里跑）+ 基线文档 `tools/audit/coverage-baseline.md`。顺带修掉一条**带覆盖率跑就会超时**的用例（`EVENT-TYPE-WRITES-3` 要重扫 821 个文件，默认 5s 不够 —— 给到 60s 并写明这是度量开销不是放宽断言） |
| C-3 | 三处注释与实现对不上（`CHAT-022b/023b` 说"读旧库"、`C4-5` 说"顺序碰巧才对"、`store.ts` 说"这里同时发两条写"） | 注释按当前实现重写，并把**已经不存在的东西**写成"已删除 + 为什么"；`C4-5` 的断言从"顺序碰巧"改成"列集合就是 9 列"（唯一的写者给的） |
| C-4 | 首屏会读的小表**没进预取清单**（`message_feedback` / `delegation_tasks` / `attachments`） | 三张表都进了 `HOT_DOMAIN_TABLES`，每条都带**真机可见的症状**注释；清单里同时写明哪些表**故意不预取**（`notebook_chunks` 每行带 embedding） |
| C-5 | 侧栏未读徽标 / 聊天待办面板是**死代码**（读的字段全仓无写入点） | 新增已读水位（`core/session/session-read-state.ts`，存 settings）+ `latestTodoListForSession` 三态读；门禁 `session-unread-badge.test.ts` 8 条、`audit-followups-todo-and-list.test.ts` 6 条；装机版实测：子会话显示"5 条新消息"（水位 0 / 库里 5 条）、正在看的会话无徽标 |
| C-6 | **确认框根本没弹、不可逆动作照做**（真机走查抓到） | dialog 插件把 `window.confirm` 换成异步调用（返回 Promise 恒为真）+ ACL 没放行 confirm ⇒ `if (!confirm(x)) return;` 永远继续。修法与判据全在 O-3 那一行（含 13 处站点清单与 6 处突变） |
| C-7 | 走查覆盖：**100 个入口**（此前只走过其中一部分面板） | `docs/ui-walk-round72.md` + `.preview-shot/ui-walk-r72.json`；19 个外壳入口 + 56 个设置页签 + 25 个任务中心页签逐个"点开 → 量面板 → 记控制台 → 复位" |
| C-8 | **上下文面板自相矛盾**：同一屏写着 `23,678 / 115,200 tokens 21%` 与「压力等级：临界」+「🔴 上下文即将满」 | 根因是同一件事两套口径：进度条用模型侧口径（可见 → 裁剪陈旧工具结果 → 按优先级选进"真实窗口 × 0.9"），压力等级却另调 `getPressureLevelFromMessages`（另一套分母、且不裁剪不选择）。修法：阈值收成唯一实现 `pressureLevelForRatio` + `summarizeDisplayPressure`，`ContextMonitor` 的 `pressure` state 整个删掉、等级由**进度条那两个数**现场导出。门禁 `context-monitor-pressure.test.ts` 5 条 + **5 处突变全被抓**（`.preview-shot/mutate-context-pressure.mjs`） |
| C-9 | **长跑稳定性只有一次性读数、没有门禁**（目标里的"内存与句柄不涨"） | 新增 `.preview-shot/stability-longrun.mjs`：连续采样（堆 / DOM / codem 工作集 / **句柄数** / 进程树），比较**前 1/3 与后 1/3 的中位数**并设绝对上界；**没有负载就直接判失败**（防"量的是空闲进程"）。实测 8 分钟 / 19 次采样 / 114 次面板切换：堆 41→42MB、DOM 844 恒定、句柄 362→364、进程树 1266→1282MB ⇒ **通过**。（`O-7` 因此关闭；"跑一夜不漏"仍不是这条能证明的，脚本注释里写明了边界） |
| C-10 | **两份关键文档没进仓库**（`.gitignore` 的 `docs/*.md` 把它们吞了） | 第 81 轮 `git ls-files docs` 实查：`docs/GAP-LIST.md` 与 `docs/ui-walk-round72.md` **未跟踪** —— 本机磁盘上有、仓库里没有。后果有两条：① CHANGELOG / GAP-LIST 里"报告见 `docs/ui-walk-round72.md`"指向不存在的文件；② 别人 clone 下来 `docs-current-gap-list.test.ts` 的 DOCS-1 会**直接失败**（清单不存在）。修法：`.gitignore` 加 `!docs/GAP-LIST.md` / `!docs/ui-walk-round72.md` 白名单 + 新增 **DOCS-6** 判据（`git check-ignore -q <path>` 的**退出码**：0=被忽略、1=没被忽略；⚠️ 不能用 `-v` 的 stdout 判断 —— 它会把 `!` 取反规则也打出来，第一版因此把"已放行"误判成"被忽略"）；反向对照用刻意忽略的 `.preview-shot/`。另附"模拟 clone"检查（`.preview-shot/_gate-fresh-clone.mjs`）：clone 后 27 份顶层 docs、其中 7 份名字像"计划/缺口"且**全部带横幅并链回 GAP-LIST.md** ⇒ 门禁在 clone 条件下同样通过 |
| C-11 | **更新下载一次失败就放弃、错误不可读**（第 72 与 81 轮各复现一次） | 新增 `src/core/update/update-retry.ts`：**有界重试**（只对可恢复的传输类错误，最多 3 次，退避 800→1600ms，上界硬性夹到 5）+ **可读错误**（`describeUpdateError`：原因 + 下一步 + **保留原文**）+ 界面显示「下载中断，正在重试（第 n/3 次…）」。**签名/校验类错误一次就抛**（重试没有意义，还会把严重问题稀释成"网络不好"）；不认识的错误默认不重试。门禁 `update-download-retry.test.ts` 7 条 + **6 处突变全被抓**；⚠️ 其中两条判据是突变验证逼出来的（纯签名串测不出优先级 ⇒ 补混合串；组件接线只判"文本出现过" ⇒ 改成锚行首 `await`） |
| C-12 | **提示框（`alert`）没走统一入口**：失败时"点了没反应"，且无上报 | 生产代码 **15 处**裸 `alert(...)`（9 个文件）全部迁到 `void alertDialog(...)`（失败进上报通道、横幅可见）。**刻意不迁**技能自带脚本 `src/core/skills/skill-creator/scripts/*.ts`（运行环境不保证有 WebView，套 dialog 反而是错的），这条边界写在门禁注释里。新增 **NC-6**（生产源码不许再出现裸 `alert(`；只扫调用，`alert:` 键与 `AlertDialog` 标识符不算）+ **NC-7**（`alertDialog` 在弹不出来时必须上报且带原文）；现有突变脚本扩到 **8 处全被抓**（新增"裸 alert 复活"与"alertDialog 失败不上报"）。迁移工具 `.preview-shot/migrate-alert-dialogs.mjs`（先干跑列清单、再 `--apply`） |
| C-13 | **皮肤卡片键盘完全用不了**（UI/UX 走查的可访问性那一类） | `SkinSelector` 原来是 `<div className="skin-card" onClick=…>`：无 `role`、无 `tabIndex`、无键盘处理 ⇒ Tab 跳过、Enter/Space 无反应、读屏不念成控件（皮肤是用户可感知功能，键盘用户却选不了）。改成 `<button type="button">` + `aria-pressed` + 网格 `role=group`。门禁 `ui-a11y-skin-avatar.test.ts` A11Y-1/2（带反向对照）；**装机版复核**：3/3 是 BUTTON、3/3 可聚焦、3/3 带 aria-pressed、恰好 1 个选中、名字互不相同 |
| C-14 | **走查度量把"名字来自后代图片 alt"的控件误报成无名** | 走查报「头像预设 50 个无名按钮」，实为度量只看 `textContent`（`<img alt>` 不算）⇒ 误报。度量侧修正：`audit-walk-lib.mjs::__name` 按 aria-label → aria-labelledby → title → 后代 `img[alt]` → textContent 取名；门禁 A11Y-4 守着这个顺序。**顺带修的**：这轮在模板字符串里写反引号把整个 `audit-walk-lib.mjs` 弄成语法错误，而**测试套件全绿**（没有用例 import 它）⇒ 新增 `preview-shot-syntax.test.ts`（PS-1 用 esbuild 逐文件解析，**711ms** 而不是 `node --check` 子进程的 **76s**；PS-2 真的 import 共享库并断言导出）；查出并隔离 4 个语法已坏的旧脚本（见 O-14） |
| C-15 | **纯图标按钮没有可访问名**（关闭按钮 + 折叠侧栏图标条，共 39 处） | 走查（度量修好之后）152 个入口、控制台报错 0；"无名按钮"降到 8 个面板，看 HTML 只有三处关闭按钮。补静态规则全仓扫后**又发现扫描器自己在漏报**（`onClick={() => …}` 的 `>` 把非贪婪正则截断 ⇒ 报 55、真实 195），修正后修掉 **31 个图标关闭按钮**（`aria-label="关闭" title="关闭"`，只动"只有图标"的）+ **8 个折叠侧栏图标条**（名字取自紧邻 `<TooltipContent>`；Tooltip 不能替代可访问名）。门禁 `icon-button-a11y.test.ts` 4 条（关闭类严格 0 / 折叠侧栏严格 0 / **其余棘轮基线 156** / **给扫描器的反向对照**）；规则与审计脚本共用唯一实现 `tools/ui-audit/icon-button-scan.mjs` |

| C-16 | **确认框在真机上一直弹不出来**（真正的根因：注入的 `window.confirm` 指向不存在的命令） | 读依赖源码逐字核对：`tauri-plugin-dialog` 2.7.2 的 `src/init-iife.js` 把 `window.confirm` 指向 `plugin:dialog|confirm`，而同一 crate 的 `src/lib.rs` 只注册 `open`/`save`/`message` ⇒ **那个命令不存在**（`permissions/confirm.toml` 自己写着 `allow-confirm` 是 DEPRECATED、「now an alias to allow-message」）。1.16.125 的改动只把"不问就做"变成"安全地拒绝"，**弹框从未弹出来过**。修法：真机走插件 JS API（`@tauri-apps/plugin-dialog` 的 `confirm()`，打的是已注册的 `plugin:dialog|message`），优先级 = ①插件 JS API ②`window.confirm` 同步布尔 ③都失败则 fail-closed + 上报；①失败会回退到②。门禁 9→**11 条**（NC-8/NC-9）。**装机版实测**：控制台 error 0 + `#32770` 对话框窗口出现 + 主窗口被 disable；PostMessage 回车后恢复 |

| C-18 | **沙箱开关的 fail-open**（同一形态系统扫描出来的唯一安全项） | `isSandboxAclEnabled` 原来 `catch { console.warn; return false }`：用户打开的沙箱在一次读失败后**静默失效**，设置面板开关**仍显示已开启**。修法：记住上次成功读到的值 + 失败沿用 + 走上报通道（`sandbox.readSetting`）+ 无历史值时按默认关闭并如实说明。**扫描工具**：`node tools/audit/scan-fail-open-guards.mjs`（15 处线索 → 12 能力探测 / 2 读取型 / **1 安全项**）；**闸门**：该 14 处已定性入白名单，`npm run audit` 新增 `audit:fail-open`（新增未定性 ⇒ 红、白名单过期 ⇒ 红），门禁 `fail-open-guard-gate.test.ts` 5 条 + 变异自证 6/6 |

| C-19 | **4 个语法已坏的历史脚本：改动是否真的生效**（O-14） | 判据写的是**效果**、不是当年的代码原文（这点第一次跑就踩了坑：拿脚本里的原字符串当针，报出 4 处「没落地」，全是假警报 —— 那段接线后来重构成了更好的形态，效果还在、只是名字变了）。核到 7 项全落地：`src/App.tsx` 里 `ensureSecretsHydrated`（启动解封，现形态是单飞入口）+ `migrateProviderKeysToSealed` + `reclaimSealedPlaintextResidue`；`SecretStorageSetting.tsx` 里 `secretStorageStatus` + `status.unreadable`（「本账户解不开」显示在设置→安全）；`secret-store.ts` 里 `isSealedKeyUnreadable` 真被汇总使用（不是只记不读）；CHANGELOG 有 1.16.101 条目 + 「凭据普查」+「未跑成」那条纪律；`docs/CREDENTIALS-PLAN.md` 有阶段 0；设计体系文档有第 27/28 波行与 `zindex-raw`/`css-class-duplicate`/`spacing-raw` 三条规则。工具：`node .preview-shot/verify-quarantined-effects.mjs`（7 项检查、exit 0）。**顺带发现**：O-16（启动时「解不开」缺用户可见面，待确认） |
| C-20 | **设计体系文档里 7 处陈旧的「（本轮）」标记**（历史清单自相矛盾） | 现场：`docs/UI-DESIGN-SYSTEM.md` 的「已完成的波次」清单里，第 28 / 34 / 39 / 40 / 41 / 42 / 46 波**同时**写着「（本轮）」—— 每波写时都对，但降级靠「下一波脚本顺手改」，漏一次就永久留下假「本轮」，读者看不出当前波次。同一节还有第二处：§7 标题写「第 45 波后」而它自己的表已引到第 52 波（**自相矛盾的波次声明**）。修法：清掉 7 处标记 + 在清单开头写死约定（历史记录一律不标本轮）+ §7 标题不再挂波次号（不猜数字）。门禁 `docs-wave-freshness.test.ts` **3 条**：DOCW-1a（无「本轮」残留）/ DOCW-1b（约定必须在）/ DOCW-2（§7 标题声明的波次号不得小于全文最大波次号）；DOCW-3 用三个坏样本（加回一个「本轮」、把标题挂回小波次号、删掉约定）证明判据会红，并用真文档证明它不是恒红。工具：`.preview-shot/fix-stale-current-wave.mjs`（幂等，`--apply` 才写盘） |
| C-21 | **「发现」被套进「失败」模板**（隔离钻取在装机版上量到原文） | 现场（装机版 1.16.134，副本库+`CODEM_DB_PATH`）：横幅「安全提示：设置里存在明文凭据：设置里存在疑似凭据 1 处。**该功能本次不可用，请重试或检查日志**。」；控制台「[PersistFailure] maintenance.invariantAudit.new **写盘失败**（第 1 次）：不变量审计：本次新产生 39 条缺口 —— 本次改动只存在于内存，重启后可能丢失。」。四句假话：「不可用」（普查刚跑成功）、「请重试」（再跑一次还是同样发现）、「写盘失败」（没有写盘失败）、「改动只在内存」（没有改动）。修法：新增第三条通道 **advisory**（横幅 `提醒（area）`+建议、控制台 `[Advisory]`+warn、第三种颜色、后缀改「同类提示 N 次」），四个「发现」站点整条搬过去（凭据普查 / 自检新缺口 / 结构异常 / 索引落后已自动补回）；真失败一个没动。**失败侧的开头也修真**：9 处维护类失败补 `title`+`consequence`（裁剪/完整性检查/空间回收/自检没跑成原来印「写盘失败」「数据保存失败」），并让控制台标签优先用 title。**顺带**：`looksSealed` 放宽到 hex 或 base64 载荷 —— 密文不再被说成「明文凭据」。判据：`persist-advisory-channel.test.ts` 7 条 + CENSUS-6 + EVENT-TYPE-WRITES-8 加严；`mutate-advisory-channel.mjs` **11/11**（含过度归类那种反向变异）。**钻取纪律**：只读真库、只写副本，前后主库 sha256 一致，结束后用正常环境重启恢复现场 |

> 编号说明：本表**没有 C-17**（早期跳号的历史遗留）。不重排编号，以免与已发布的 CHANGELOG / 文档里对 C-x 的引用错位。

## 四、**判定为"不是缺口"**的（附理由，避免反复被重新提起）

| 项 | 结论与理由 |
| --- | --- |
| 引擎 77 条命令里有 **35 条没有生产调用方** | **不是缺口**，是**引擎/CLI 的自省与迁移面**：`health` / `integrity_check` / `checkpoint` / `counts` / `audit.*` / `import.*` / `migration.*` / `digest.*` / `legacy.read_table` / `fts.delete_session` 等，使用者是 `codem-db-cli` 与 `tools/migrate/**`，不是渲染进程。工具：`node tools/audit/check-command-parity.mjs --list`（信息项，不判失败）。**判据是"有没有第二个写路径、列集合是否更窄"**，不是"有没有人调"—— `feedback.*` 三条正是因为**同时写同一张表且列集合更窄**才被删的，两者不要混为一谈 |
| `docs/` 下的历史分析文档与数字 | **不是缺口**：它们是各轮的取证记录（当时的数字、现场形态、判断依据），删掉等于把"当时为什么这么做"一起删掉。处置是加横幅 + 指回本文，而不是更新它们（更新历史记录=伪造记录） |
| `assets` 里的美术资源没有随源码版本走 | 见 `docs/ASSET-LICENSES.md`：许可与商用替代方案是刻意选择，不是遗漏 |

## 五、怎么维护本文

1. **只在有数字的时候**往"已关闭"里写。数字必须来自真实一次测量（测试套件、真机探针、审计工具输出），并写清"怎么核对的"。
2. 拿不准的写进"未关闭"，并写**关闭它的条件**（不是"以后再看"）。
3. 判定"不是缺口"的条目也要写理由 —— 不写理由的话，下一轮一定会有人重新提一遍。
4. 历史文档的横幅由 `.preview-shot/banner-historical-docs.mjs` 加（幂等），
   规则与守门用例 `src/test/docs-current-gap-list.test.ts` 一致：
   文件名匹配 `GAP|PLAN|ROADMAP|TODO|STATUS|TRIAGE|UNIMPLEMENTED|REMEDIATION|DEFERRED` 的
   `docs/*.md` **必须**带横幅，白名单只有本文。
