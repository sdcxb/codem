# UI/UX 真机走查（第 72 轮，装机版 1.16.124）

> 报告由 `.preview-shot/ui-walk-r72.mjs` 产出（原始数据 `.preview-shot/ui-walk-r72.json`），
> 分诊打印：`.preview-shot/_walk2-summary.mjs`。
> **模型不能读图**：本报告里的每一条都是**程序判据**（DOM 度量 / 控制台增量 / 命中测试），
> 没有一条来自"看图觉得"。

## 0. 一句话结论

走查 **100 个入口**（应用外壳 19 + 设置页签 56 + 任务中心页签 25），
发现**一个真机可见的严重缺陷**（确认框根本没弹、不可逆动作照做），
外加三类"需要看具体样本才能定性"的现象（小命中区 / 无名按钮 / 被遮挡控件）。
缺陷已修并配门禁；三类现象的样本逐条列在下面，**没有一件被含糊带过**。

## 1. 缺陷：确认框根本没弹，动作却照做（已修）

### 现场（走查怎么发现的）

走查点到标题栏「切换执行模式」时，控制台出现：

```
[Unhandled Rejection] Command plugin:dialog|confirm not allowed by ACL
Uncaught (in promise)
```

而**模式已经被切过去了**。用 `.preview-shot/_probe-confirm-acl.mjs` 做只读取证，读到：

| 读数 | 值 |
| --- | --- |
| `String(window.confirm)` | `async function(i){return await n("plugin:dialog|confirm",{message:i.toString()})}` |
| `String(window.alert)` | `function(i){n("plugin:dialog|message",{message:i.toString()})}` |
| `window.__TAURI__.dialog` 的键 | `ask, confirm, message, open, save` |
| 点击后控制台增量 | `error=2, exception=1, firstError=…not allowed by ACL` |

### 根因（两个叠在一起）

1. **Tauri 的 dialog 插件把 `window.confirm` 换成了异步插件调用** —— 返回值是 **Promise**。
   于是所有 `if (!confirm(msg)) return;` 的形状里，`!promise === false` ⇒ **永远继续执行**：
   用户既没看到询问，也没机会拒绝，而动作是不可逆的。
2. **ACL 没放行**：`capabilities/default.json` 里写的是 `dialog:default`，实测它**不含**
   `confirm`/`message`（同一次点击的报错就是证据）⇒ 调用被拒 + unhandled rejection 进控制台。

### 影响面（逐站点清点，共 **13** 处 `confirm`）

删除项目、清除全部恢复数据、删除某会话的恢复数据、删除工作树、回滚快照、
回滚这一轮文件改动、卸载 zvec 运行时、删除智能体、删除 Agent Profile、
恢复 PPT 版本、生成演讲稿覆盖确认、切换执行模式、游戏「投降」。

### 修法

| # | 改了什么 | 判据 |
| --- | --- | --- |
| 1 | 新增 `src/core/ui/native-dialog.ts`：`confirmDialog()` / `alertDialog()`，对**同步布尔**（普通浏览器）与 **thenable**（Tauri shim）两种世界都给对答案；**拿不到答案一律按取消**（fail-closed）并走上报通道 | `native-confirm-dialog.test.ts` NC-3a/3b/3c（含"迟到的 false 也必须等到"） |
| 2 | 13 处 `confirm(` 全部改成 `await confirmDialog(...)` | NC-1（生产源码里**不许**再有裸 `confirm(`）+ NC-2（每处必须带 `await`） |
| 3 | `capabilities/default.json` 显式加 `dialog:allow-confirm` / `allow-message` / `allow-ask` / `allow-open` / `allow-save` | NC-5 |
| 4 | 上报文案走 `options.consequence`（**界面**那句），不是 `extra`（只进控制台）——第一版写错，被 NC-3c 当场抓住 | NC-3c 断言真进界面的 detail |

**突变验证**：6 处（退回裸 confirm / 丢 await / fail-open / 不等 thenable / 摘权限 / alert 静默）**全部被抓**
（`.preview-shot/mutate-native-dialog.mjs`）。

### ⚠️ 诚实标注（本条**没有**用真机点击端到端验证）

修好之后，点那个按钮会**弹出系统模态框**——CDP 点不到它，留着会把用户的窗口卡住。
所以装机版上核到的是：`native-dialog.ts` 已接线、权限已声明（结构判据 + 单测覆盖两种世界）。
"弹框真的弹出来了"这件事要**等下一次真实使用时由用户确认** —— 不假装已经量过。

## 2. 三类现象（逐条列样本，未定性为缺陷）

### 2.1 小命中区（< 24×24 且中心点没命中自己）

| 面板 | 个数 | 样本（真机读数） |
| --- | ---: | --- |
| 对话（多处） | 15 | `chat-title-dropdown-btn 58×21`、`paragraph-action-btn 22×22`（`coveredBy=chat-header`） |
| 收件箱 | 7 | `INPUT 13×13`（复选框）、`BUTTON 16×19` ×2 |
| 模型配置（刷新/添加/保存） | 4 | `INPUT 484×19`、`api-key-toggle 36×19` |
| 语音 / 宠物 / 性能 等 | 1–3 | 每页 1–3 个图标按钮 |

定性意见（**不是结论**）：`paragraph-action-btn` 是悬停工具条里的按钮（整条工具条本身是命中区，
且它 `coveredBy=chat-header` 说明"滚到头部下面"了），`INPUT 13×13` 是原生复选框落在整行可点的
label 里（走查的度量会把这种判成 `padded`，这里没被判成 padded ⇒ **需要单独看一眼那一行到底可点多大**）。
这三类要修也该按"命中区到底多大"逐个量，**不能看一个数字就改 CSS**。

### 2.2 无名按钮（无 aria-label / title / 文本）

| 面板 | 个数 | 样本 |
| --- | ---: | --- |
| 上传头像 | 50 | `button.sp-avatar--sm.sp-avatar`（头像候选） |
| 人设/皮肤选择 | 40 | 同上（每个皮肤页签里 40 个） |
| 其他面板 | 1–10 | 多为纯图标按钮 |

定性意见：头像/皮肤候选按钮是**纯图片**按钮，读屏用户与键盘用户都拿不到名字；
这是可访问性问题（不是功能坏），修法是补 `aria-label`（来源已有：候选名）。
**未修**，理由：它属于"批量 a11y 补名字"，与"面板点开能不能用"不是一件事，硬塞进本轮会让
改动面不可控。已登记在 `docs/GAP-LIST.md`。

### 2.3 被遮挡控件（中心点命中别的元素）

71 个面板有读数，最多的几个：设置·工具 17、人设皮肤 23、任务中心若干。
定性意见：设置面板有 sticky 头部，滚到它下面的控件中心点当然"命中别人" ——
**这是正常形态**，`__measure` 里已经把"被祖先 label 撑开"和"被祖先容器盖住"分开计（`padded` / `occluded`），
但"被别的元素盖住"这一项**没有区分"sticky 头"与"真的被压住"**。
所以这一列只作为线索保留，**不当结论用**（要定性得逐个做 `elementFromPoint` 落点取证）。

## 4. 走查**第二阶段**：把第一轮没走到的面板补上（第 81 轮）

### 为什么还有第二阶段

第一轮按**容器**找入口，而 `.right-rail` / `.panel-sidebar` 在那一刻**根本不存在**
（第一轮报告里那两行就是"容器不在"）—— 也就是说**右侧那些面板一个都没量到**。
它们不是没入口，而是入口在**聊天头部的 `.agent-toggle` 按钮**上（`ChatPanel.tsx:650-691`）。

### 读数（装机版 1.16.125，真实鼠标点击）

| 面板 | 打开 | 面板类 | 文本 | 无名按钮 | 小命中区 | 被遮挡 | 控制台 |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| 智能体与团队 | ✓ | `agent-panel` | 35 | 1 | 0 | 0 | 0 |
| 快照 | ✓ | `snapshot-panel` | 1812 | 1 | 1 | 0 | 0 |
| 上下文监控 | ✓ | `context-monitor` | 147 | 0 | 0 | 0 | 0 |
| 执行轨迹 | ✓ | `trajectory-panel` | 893 | 0 | 1 | 0 | 0 |
| 侧边面板 | ✓ | `panel-sidebar-shell` | 39 | 0 | 2 | 0 | 0 |

侧边面板的五个页签（**限定容器内**点击）：

| 页签 | 文本 | 无名按钮 | 小命中区 | 被遮挡 |
| --- | ---: | ---: | ---: | ---: |
| Git | 74 | 0 | 1 | 0 |
| 文件（文件浏览器） | **1117** | 0 | 1 | 5 |
| 变更 | 45 | 0 | 0 | 0 |
| 工作台 | 60 | 1 | 0 | 0 |
| CI/CD | 39 | 0 | 2 | 0 |

**没有一处控制台报错**（error / exception 全 0）。「上下文监控」这一屏还直接抓出了下面的缺陷。

### 第二阶段抓到的缺陷：上下文面板自相矛盾（已修）

打开「上下文监控」看到的是：

```
📊 上下文状态   23,678 / 115,200 tokens   21%
压力等级  临界     剩余 91,522 tokens
🔴 上下文即将满！请立即压缩或开启新对话
```

**21% 却说"即将满"** —— 同一屏两个结论打架。根因是**同一件事被两套口径各算一遍**：
进度条用"模型这次真的会收到多少"（可见 → 裁剪陈旧工具结果 → 按优先级选进"真实窗口 × 0.9"），
而压力等级走 `getPressureLevelFromMessages(可见消息)`，它**自己另算一遍分母**
（`maxContextWindow − systemPrompt − outputReserve`）、**且不裁剪不选择**。
这与 1.16.123 修的"概览卡 vs 委派页签"是同一个病。修法：阈值收成唯一实现
`pressureLevelForRatio`，面板上那两个数字统一由 `summarizeDisplayPressure(used, available)`
从**同一对数字**导出，`pressure` state 整个删掉。
门禁 `context-monitor-pressure.test.ts` 5 条 + **5 处突变全被抓**
（`.preview-shot/mutate-context-pressure.mjs`）。

### 看板拖拽：**本机测不到**（如实记录，不假装测过）

看板页签确实打开了，但**列里一张卡都没有**：

```
Backlog 0 拖拽 Issue 到此列 / 待办 0 / 进行中 0 / 待审查 0 / 阻塞 0 / 已完成 0 / 已取消 0
```

`draggable` 元素 **0 个**、`card` 元素 **0 个** —— 本机一个 Issue 都没有，
所以"拖进去会不会改状态"这条路径**没有真实数据可拖**。关闭条件见 `docs/GAP-LIST.md`
（有 Issue 之后再拖一次并核对状态列变化）。

### 第二阶段又踩到的四个仪器坑（全部写进代码注释）

1. **`[class*="board"]` 会匹配 SVG 元素**：`element.className` 在 SVG 上是 `SVGAnimatedString`，
   字符串化后是 `[object SVGAnimatedString]` —— 第一版把**图标**当成了"看板容器"。
   现在只认 `HTMLElement`。
2. **同一屏有两个「文件」**：侧边面板的页签叫「文件」，标题栏的应用菜单也叫「文件」——
   不限定容器就会**点到菜单上**（第一版实测 `cls=app-menu-trigger`），
   那一行读数（文本 55）量的其实是还停在 Git 的面板；限定 `.panel-sidebar-shell` 后是 1117。
3. **面板标题要用源码里的真实字符串**：中文标签是「上下文监控」（`lang.ts:284`），
   第一版写「上下文监视器」⇒ `found:false`，报告里看起来像"面板打不开"（假缺陷）。
4. **探针差点拖错东西**：看板拖拽探针第一版用 `[draggable="true"]` 找卡片，抓到的是
   **侧栏的会话行**（`Sidebar.tsx:997`，放开会调 `reorderSessions` 改用户会话顺序）。
   事后核查证明**没有造成改动**（三个会话的 `sort_order` 全是 0，与拖拽前一致；
   工具 `.preview-shot/_session-order.mjs`），但这种"探针乱拖"本身不可接受 ——
   现在**只允许拖"看板容器内部的卡片"**，找不到就如实报"没测到"。

## 3. 走查仪器本身的两个坑（都已写进代码注释）

1. **权限弹窗是独立的 page target**：点到「语音」设置页时 WebView2 弹了麦克风询问，
   它 `type: "page"`、url 是 `edge://permission-request-dialog/` —— 旧的"取第一个非 DevTools 的 page"
   判据放它过关，于是脚本连到权限弹窗上量，量出 `.sidebar = null` 并报"入口找不到"（假缺陷）。
   现在 `connect()` 按 **URL** 认应用（`http://tauri.localhost`），并显式排除 `edge://` / `chrome://` / `devtools://`；
   关闭工具：`.preview-shot/_dismiss-permission-dialog.mjs`。
2. **页签不是 `<button>`**：库里 `clickEntry` 的候选池是 `button, [role=button], a[href]`，
   而设置/任务中心的页签是 `[role="tab"]` / 带 `tabindex` 的 div ⇒ 60 多个页签一律"入口没找到"。
   现在点击池与枚举池**完全一致**（`button, [role=button], [role=tab], a[href], [tabindex]`）。
3. 第三个坑是脚本逻辑：页签列表第一个是「关闭设置」，照单全点会把面板关掉，
   后面全部报"找不到" —— 现在跳过"关闭/取消"并在每次点击后检查面板还在不在。
4. **探针会改用户的状态（本轮实际发生过）**：取证脚本点了标题栏「切换执行模式」，
   于是 mimo-gui 的执行模式从「本地处理」变成了「新工作树」
   （库里 `codem-project-execution-modes = {"C:\\mimo-gui":"git_worktree"}`）。
   还原路径已写成脚本 `.preview-shot/_exec-mode-setting.mjs`：
   **关应用 → 引擎 CLI 直写设置 → 重启后核对标题栏显示「本地处理」**（本轮已按此还原）。
   为什么不点 UI 改回去：修好之后那里会弹**系统模态框**（工作区有未提交修改时），
   CDP 点不到、留着会卡住用户的窗口 —— 这正是本轮那个缺陷修好之后的新常态。
