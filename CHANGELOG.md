# Changelog

All notable changes to Codem will be documented in this file.

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
