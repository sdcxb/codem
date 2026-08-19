# Changelog

All notable changes to Codem will be documented in this file.

## [1.4.1] - 2026-08-19

### Bug 修复（9 项）

#### Bug 1 — 插件管理页面"Cordis Context 尚未初始化"彻底修复
- **根因**：`getCordisContext()` 中 `loadDefaultProviders(ctx)` 同步注册 Provider 插件后立即 `setActiveContext(ctx)`，但 fiber 的激活是异步的（需要微任务）。`ctx.get('pluginRegistry')` 在 strict 模式下要求 fiber 状态为 ACTIVE，否则返回 undefined，导致 PluginManager 重试 50 次后放弃
- **修复**：`App.tsx` 在 `loadDefaultProviders(ctx)` 后加 `await new Promise(resolve => setTimeout(resolve, 0))` 等待 fiber 激活；`PluginManager.tsx` 重试次数从 50 增到 100（10 秒），最终失败时用 `ctx.get('pluginRegistry', false)` non-strict 模式作为 fallback

#### Bug 2 — 技能市场 ClawHub/Skills.sh/SkillHub 加载很慢
- **根因**：三大市场源多页串行分页请求，每页一个 `httpGet`，代理慢时累积延迟很长（ClawHub 20 页、Skills.sh 10 页、SkillHub 20 页）
- **修复**：ClawHub MAX_PAGES 20→3（300 条）、Skills.sh 10→2（1000 条）、SkillHub 20→3（300 条）

#### Bug 3 — 启动后默认模型显示 mimo-v2.5-pro 而非上次保存的 deepseek
- **根因**：`configureEngine` 在 DB 未就绪时 `getSettingJSON("codem-settings", null)` 返回 null，直接 return 不重试，导致初始渲染的 `mimo-v2.5-pro` 默认值一直保持
- **修复**：`configureEngine` 中 `saved` 为 null 时也重试（200ms 间隔），确保 DB 就绪后重新加载已保存的模型配置

#### Bug 4 — CI/CD 面板太靠右被遮挡 + 界面元素太大有关闭按钮
- **根因**：`CicdPanel` 有自己的 header 和关闭按钮，与 `PanelSidebar` 的 tab 系统重复，且 header 元素字体过大
- **修复**：去掉 `CicdPanel` 的 header 和关闭按钮，`onClose` 改为可选 prop，`PanelSidebar` 中 `<CicdPanel onClose={onClose} />` 改为 `<CicdPanel />`

#### Bug 5 — 对话框编辑框圆角太大 + 梦幻皮肤毛玻璃未适配
- **根因**：`.input-card-container` 基础圆角 20px、梦幻皮肤 16px、Hub 皮肤 16px，圆角过大不美观
- **修复**：三套皮肤统一为 12px — 基础样式 20px→12px、梦幻皮肤 16px→12px、Hub 皮肤 16px→12px，`input-wrapper` 圆角同步调整

#### Bug 6 — 首页区域未自适应窗口分辨率（修复后遮挡更严重）
- **根因**：`.empty-state` 和 `.new-chat-page` 都使用 `justify-content: center` + `height: 100%`，内容超出容器时 `justify-content: center` 把内容顶部挤出可视区域且无法滚动
- **修复**：`justify-content: center`→`flex-start`，去掉 `height: 100%`，加 `padding: 40px 20px` 和 `width: 100%`

#### Bug 7 — 首页 Write Code 显示不全 + Tips 消失
- **根因**：`"Help me write a "` / `"帮我编写一个 "` 是半句提示，用户看到后觉得不完整；Tips 消失因 CSS 布局问题（Bug 6 修复已解决）
- **修复**：将 prompt 改为完整提示语 `"Help me write code: "` / `"帮我编写代码："`

#### Bug 8 — 顶部对话/终端/性能区域多了 CI/CD 按钮
- **根因**：底部面板 tab 栏中有 CI/CD 按钮，与右侧边栏的 CI/CD tab 重复
- **修复**：从底部面板 tab 栏移除 CI/CD 按钮和面板渲染（CI/CD 保留在右侧边栏 PanelSidebar 中）

#### Bug 9 — 对话区域不按窗口大小自适应
- **根因**：`.messages-container` 和 `.input-area > .input-card-container` 有 `max-width: clamp(100%, 75vw, 1100px)` 限制，大屏时上限仅 1100px 右侧大片空白；`.chat-body` 缺少 `flex-direction: column` 导致 `margin: 0 auto` 居中不稳定
- **修复**：`.chat-body` 添加 `flex-direction: column`；`.messages-container` 和 `.input-area > .input-card-container` 的 `max-width` 从 `clamp(100%, 75vw, 1100px)` 改为 `clamp(100%, 90vw, 1400px)`，拖拽缩放窗口时动态跟随

## [1.4.0] - 2026-08-19

### Bug 修复（11 项）

#### Bug 1 — 技能市场 skill.sh 插件内容显示乱码
- **根因**：Skills.sh HTML 爬取正则匹配范围过宽，会匹配到 HTML 标签属性（如 `<link rel=...>`）
- **修复**：收紧正则为只匹配字母数字和连字符组成的路径段 + 增加二次清洗过滤残留非法字符

#### Bug 2 — 技能市场外部技能加载很慢
- **根因**：Rust 层 `http_get` 超时时间过长（30s），导致并行请求时等待时间长
- **修复**：`http_get` 超时从 30s 降至 15s，`http_download` 从 120s 降至 60s

#### Bug 3 — 智能体定义管理窗口点击新建后视觉锚点未滚动
- **根因**：点击"新建"后编辑区域出现在窗口下方，但视图未自动滚动
- **修复**：增加 `editorRef`，在 `handleNew`/`handleEdit` 中调用 `scrollIntoView({ behavior: "smooth", block: "start" })` 滚动到编辑区域

#### Bug 4 — 启动后模型选择默认显示 mimo-v2.5-pro
- **根因**：`configureEngine` 在 engine 未就绪时直接 return，不更新已保存的模型配置
- **修复**：增加 200ms 自动重试逻辑，确保 engine 初始化完成后重新加载已保存的模型配置

#### Bug 5 — 右侧栏 CI/CD 管理面板太靠右被遮挡且弹窗改为面板切换
- **根因**：CI/CD 面板使用弹窗模式，与用户期望的面板切换不符
- **修复**：`BottomTab` 类型增加 `"cicd"`，所有 `onCicd` 从弹窗改为 `setBottomTab("cicd")` 面板切换。`CicdPanel` 从 `createPortal` 弹窗模式改为内嵌面板模式

#### Bug 6 — 梦幻皮肤下对话编辑框区域透明度未适配毛玻璃
- **根因**：`.input-card-container` 的 `backdrop-filter` 未加 `!important`，被其他样式覆盖
- **修复**：`backdrop-filter` 加上 `!important` 和 `saturate(1.4)`，增加深色模式背景色覆盖

#### Bug 7 — 梦幻皮肤下主对话框圆角与边栏直角风格不一致
- **根因**：`.sidebar` 和 `.right-sidebar` 没有圆角和 margin，与 `.panel-right` 风格不统一
- **修复**：`.sidebar` 增加 `border-radius: 16px` 和 `margin: 8px`，`.right-sidebar` 增加毛玻璃背景、圆角和 margin

#### Bug 8 — 首页区域未自适应窗口分辨率
- **根因**：`.new-chat-page` 和 `.empty-state` 使用 `height: 100%`，窗口小时内容溢出被截断
- **修复**：添加 `min-height: 100%` 和 `overflow-y: auto` 使其可滚动

#### Bug 9 — 首页点击 write code 等按钮编辑框内容未清理和显示不全
- **根因**：建议卡片通过 `quoteContext` 机制传递，会追加而非替换内容，且 `quoteContext` 显示截断
- **修复**：新增 `suggestionPrompt` + `onSuggestionConsumed` prop 机制，建议卡片点击时直接替换输入框内容

#### Bug 10 — 深色模式下安全策略按钮白色底色突兀
- **根因**：Compact 模式下按钮缺少样式，深色模式下继承了白色背景
- **修复**：给按钮加上 `security-mode-btn` class，深色模式下使用紫色边框透明背景样式

#### Bug 11 — 性能面板应改为面板切换而非弹窗
- **根因**：性能面板使用弹窗模式，与对话/终端面板切换逻辑不一致
- **修复**：`PerformanceDashboard` 从 `createPortal` 弹窗模式改为内嵌面板模式，移除 `showPerfDashboard` 弹窗渲染

### 编译 Warnings 清零（4 项）
- 多余分号 `;;` → `;`（lib.rs）
- 未使用变量 `window` → `_window`（lib.rs）
- 未读取字段 `id` → `_id`（lib.rs PtySession 结构体）
- `Cargo.toml` 添加 `[lints.rust]` 配置 `linker_messages = "allow"` 抑制 linker stdout 消息

## [1.3.0] - 2026-08-19

### Cordis 插件系统对标 DSH 全面整改 + Slot 消费闭环 + inject 依赖对齐
- 死 slot 从 29 个降至 0 个
- 7 个 UI provider 添加 `inject` 声明依赖，移除全部 null 检查
- 创建 ConversationRoot/Session/Composer 对标 DSH conversation slot 层级
- 新增 `slots.inject()` 消费声明方法
- 移除 11 个重复/无消费点 slot 注册
- MessageBubble/InputArea/ChatPanel/Sidebar 全面接入 SlotBridge/SlotListBridge 消费 conversation 子 slot
- 30+ 文件修改，10 个新组件

## [1.2.0] - 2026-08-18

### Cordis 架构全面对齐 DSH + 安全加固 + 全量测试重构
- 移除核心文件 `@ts-nocheck`，`declare module` 类型声明全面生效
- `ctx.get()` 返回强类型（对齐 DSH `ReflectService.get` keyof 推断模式）
- 安全加固（AST 代码验证 + Worker 隔离 + XOR 密钥混淆 + SandboxGuard 覆盖读操作）
- 生命周期管理（复合 Dispose + LRU 淘汰 + 异步 I/O）
- 全量测试重构 109 套件 3690 测试通过

## [1.1.1] - 2026-08-17

### UI 布局优化 + 插件条件渲染 + 宠物窗口 Bug 修复
- 插件管理移至左下角 + CI/CD 移至右侧边栏 + 性能移至主对话框顶端
- 插件启用/禁用与按钮/面板联动显示
- 宠物窗口关闭 Bug 修复
- 全工具 execute 回调 null 检查防御

## [1.1.0] - 2026-08-16

### DSH 对标全面整改 + 测试体系深化 + Bug 修复
- 孤岛模块接入 10 项 + 重复实现统一 4 项 + 缺失功能补齐 5 项
- 5 个 Bug 修复 + 4 个新测试文件 / 118 用例

## [1.0.0] - 2026-08-15

### UI/UX 标准化 + 插件系统架构 + 测试体系全面升级
- P4 Cordis DI + Slot Registry + Plugin Loader + 18 Capability Seams
- P5 全能力族拆分
- P6 UI 插件包化
- 全弹窗 UI/UX 标准化
- 67 文件修改（+1112/-641 行），全量 3552 用例通过
