# EAC 对标调研笔记（工作文档，非交付物）

> 来源：https://github.com/zouyuxuan122/DSH-Desktop-EAC （DSH-Desktop-EAC，EAC = Embracing All Creation 揽尽万象）
> 参考快照：`C:\mimo-gui\.eac-ref\DSH-Desktop-EAC-main`（main 分支 zip，不入库）
> 定位：dsh（deepseek-ai/deepseek-harness）桌面发行版 —— 内置 Node/dsh CLI、Tauri 壳、47 个内置插件、10 款皮肤。
> 与 Codem 关系：Codem 是独立同构实现（自有 Cordis 内核 + UI），EAC 是 dsh 内核 + 插件生态。Codem 无法直接装 dsh npm 插件（运行时鸿沟，见 v1.9.7 dsh-compat 桥），对标方式 = 功能级复刻。

## EAC 核心卖点（README 对比表提炼）

1. 内置运行时 + 桌面壳（原生窗/托盘/自更新）—— Codem 已有（Tauri v2）
2. 10 款社区皮肤（XP/QQ98/同花顺/蓝幻/龙裔/MC/交易/鲸歌/初音/女仆工坊）—— Codem 有 default/dream/hub 3 套（皮肤令牌体系，详见 SKIN-PLUGIN-CONTRACT）
3. 文件树/行级 diff/一键还原/持久终端/HTML 预览 —— Codem 已有（FileExplorer/FileChangesList/DiffViewer/TerminalPanel PTY）
4. 自动压缩、人设卡管理、soul.md 热重载 —— Codem 有自动压缩（compaction）、SOUL.md 读取注入；**人设卡管理 UI 缺**
5. 可视化管理 MCP + Claude/Codex 配置导入 —— Codem 有 MCP 管理；导入迁移缺
6. 内置插件市场（dsh-unified-market 聚合多源）—— Codem 已有市场（dsh-market-catalog + bundled/adaptable/unsupported）
7. 临时对话（side-session 悬浮窗）、对话节点导航 —— **Codem 缺悬浮临时会话**
8. 微信 ClawBot/OpenClaw 桥 —— 外部依赖大，非核心
9. 插件保护中心（快照/体检/回滚/事故报告）—— Codem 有文件级快照 + RecoveryPanel；配置级撤销缺

## 47 插件分类速览（plugins/ 目录实证）

- **UI 交互类**（重点对标）：dsh-composer-dynamic-island（输入区按钮收纳灵动岛）、dsh-meow-smooth（失焦折叠+窄屏收起侧栏+通知）、dsh-conversation-tweaks（长输出折叠+导航滑轨）、dsh-message-rewind（消息改写 fork 重放）、dsh-navbar（user 消息跳转条）、dsh-settings-scroll-fix、dsh-settings-groups/nav-custom、dsh-viewport-lock、dsh-web-mobile-fix、dsh-better-sidebar（VSCode 右栏）
- **对话/模型**：dsh-balance（余额）、dsh-whale-widget（余额挂件）、dsh-third-party-thinking、dsh-auto-compact/dsh-compact、dsh-soul-md（人设卡）、dsh-prompt-custom、dsh-webui-prompt-optimizer
- **文件/工具**：dsh-file-changes、dsh-client-file-changes、dsh-change-review、dsh-terminal、dsh-file-drop-eac、dsh-image-paste、picturereader、dsh-raw-html
- **会话管理**：dsh-side-session（临时会话）、dsh-float-window、dsh-session-manager、dsh-message-rewind
- **可靠性**：dsh-plugin-shield/guard/healthcheck/wizard、dsh-undo-savepoint（配置回滚）、dsh-plugin-manager
- **趣味/宠物**：dsh-pet（页内宠物 28 动画）、dsh-dafeiyu（桌面原生窗工作状态鱼）、dsh-whale-widget
- **外部集成**：dsh-openclaw-bridge（微信）、dsh-phone（手机）、dsh-agent-teams（多智能体）、computer-user（读屏自动化）

## 关键实现模式（源码实证）

### composer-dynamic-island（says693，v2.1.0）
- 把输入区所有按钮（原生/左右 slot/模型/发送）按 zone 收集，超宽时收纳进「…」触发器
- 弹出 panel 为 position:fixed，CSS 变量 --dshi-panel-* 定位；动画 translateY+scale；backdrop-blur
- 扫描选择器：button/[role=button]/textarea 等；分区 ZONE_ORDER = native/left/team/extension/right/model/action
- slot 名匹配 `conversation.(input|composer).(left|right|model)`

### meow-smooth（Phant0Meow）
- 输入框失焦折叠高度（FoldDock）+ 窄屏选中会话自动收起侧边栏
- 额外带任务完成 Web Notification（ServiceWorker push 风格，localStorage 去重）

### conversation-tweaks（deepseek-ai）
- 隐藏长输出 + 会话右侧导航滑轨（user 消息位置标记可点击跳转）
- Codem 对标：ScrollbarMarkers 已实现（可点击跳转 user 消息）—— **重叠已覆盖**

### message-rewind（Trae 风格）
- hover user 消息 → 编辑并回退 → 会话 **fork 到上一完成轮** 重发；原会话保持不动
- client-only，用 sessions.fork/open + composer dock slot + inputActions(setDraft/addImages/submit)
- 首条消息不可回退（toast 解释）
- Codem 对标：InlineMessageEdit + handleEditAndResend（App.tsx:2951）—— 现为**就地删除后续+重发**（破坏原会话），**无 fork 保留语义** → 差距点

### feature-toggles（EAC 配套）
- 设置页「增强功能」分区卡片（order 7）：默认关闭插件的开关（余额小鲸鱼 / AgentTeams）
- 走 window.dshDesktop.pluginManager 桥写 profile cordis.patch.yml，重启生效
- **这正是"新功能剥离为可启停插件 + 设置页一键开关"的参考形态**（Codem 用 PluginManager 已有 enable/disable 真卸载语义）

### side-session（dsh-external，v0.2.8）
- 基于当前主会话上下文 + 触及文件，在**独立悬浮窗**发起不污染主会话的临时追问
- 悬浮窗 position:fixed 可拖拽、右下角缩放手柄；Ctrl+Shift+S / 💬 / /side-session 唤起
- 上下文三档（标准 120 条/40K / 加长 600 条/200K / 完整 5000 条/2M）
- 三引擎：直连 DeepSeek / 插件自带 key / 跟随主对话模型（默认推荐）
- 主对话变化事件驱动缓存失效 + 2s 轮询；浮窗隐藏暂停轮询
- Codem 对标：**无** —— 候选新增插件

### whale-widget（MeteorNOX）
- 右下角常驻余额挂件：余额/今日已用/峰谷定价/随机台词/每轮消耗统计
- Codem 对标：UsageStats 面板有费用/命中率卡，ContextMonitor 有余额 API 查询；**无常驻挂件** —— 候选增强

### soul-md（Scorp1o117）
- soul.md 人设卡注入 + 管理（保存/应用/删除/热重载）
- Codem：loader.ts 读 SOUL.md 注入 # SOUL 段；**人设卡管理 UI 缺** —— 候选增强

### undo-savepoint（lire1131）
- 配置快照与撤销/回滚
- Codem：snapshot 目录是**文件级**快照（SnapshotPanel 恢复文件）；**配置级撤销缺**

### terminal（deepseek-ai）
- Node 持久 shell：断开保留 15 分钟 + 512KB 快照回放重连；WS 通道（避开 HTTP 6 连接池）
- Codem：TerminalPanel 用 Rust PTY（更强，交互程序支持）；**持久/重连语义待确认**

### 皮肤机制
- 每皮肤 = skin.json + client.js（整包 CSS 注入，maid-atelier 2.6MB CSS）+ light/dark 预览图
- Codem：皮肤令牌（design tokens）+ data-skin/data-theme，4 视觉态 —— 架构不同，Codem 更规范
- **用户决定（2026-09-07）：皮肤不对标，保持 Codem 现有 default/hub/dream 能力（EAC 10 款皮肤不移植）**

### raw-html（VCP 视觉通感，EAC 托管）
- 让 agent 输出 HTML 并在会话内**真正渲染**（Shadow DOM 隔离），配合设计规范提示词
- 渲染/美学双开关；VCPColorEngine 声明式配色；mermaid/katex/7 款 OFL 字体
- 流式锚定渲染；成本纪律（实测省 token）
- Codem 对标：Markdown/Shiki 渲染已有，HTML 卡片渲染缺 —— 偏"玩法/重"，非核心差距

## 与 dsh 参考仓库的差异

.dsh-desktop-ref = anywhere-labs/dsh-desktop（v1.9.7 用量统计对标源），是**官方 dsh-desktop**。
DSH-Desktop-EAC = 社区 fork 增强（自研壳 + 47 插件），更偏 UI 生态聚合。两者都是"dsh 生态"，非 Codem 代码库。

## 待子代理确认的细项

（三路子代理：EAC UI 插件群 1 / EAC UI 插件群 2 / Codem 现有功能盘点 —— 结果并入后形成最终差距矩阵文档 docs/EAC-GAP-ANALYSIS.md）
