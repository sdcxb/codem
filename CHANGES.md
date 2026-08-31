# Codem 更新日志

## v1.8.0 (2026-08-31)

### 知识图谱 React Flow 重构 + DSH 框架穿透性整改 + UI 设计规范化

本次更新是对标遗留整改工作的延续，聚焦于知识图谱可视化质量提升、LLM 配置统一化、以及 UI 设计变量规范化。

#### 知识图谱 React Flow 重构
- **引入 @xyflow/react (React Flow) 库**：替代自研 Canvas 力导向图实现，获得专业级的交互体验
- **自定义节点组件**：按实体类型着色 + 图标 + 径向渐变 + 选中高亮 + 搜索 dimmed 效果
- **自定义贝塞尔曲线边**：选中时显示关系标签，高亮/普通状态视觉区分
- **内置 MiniMap / Controls / Background**：小地图导航、缩放/平移控制、点阵背景
- **fitView 自动适配**：加载后自动聚焦到所有节点
- **保留所有编辑功能**：节点标签编辑、节点删除、边删除、右键菜单、PNG/JSON 导出

#### DSH 框架穿透性修复
- **`vision-proxy.ts` 统一改造**：`resolveVisionConfig()` 和 `resolveSTTConfig()` 从手动拼凑 `codem-settings` + `getProviderConfig` 改为统一使用 `engine.getConfiguredProvider('vision'/'stt')`，消除了多模态代理中的配置断点
- **移除未使用的导入**：`getModelProfileManager`、`getSettingJSON` 不再被 vision-proxy 直接引用

#### UI 设计规范化（对标 apple-design / emilkowalski/skills）
- **批量字体变量替换**：将 50+ 组件中的硬编码 `fontSize: 数字` 替换为 CSS 变量（`var(--fs-xs)` 到 `var(--fs-3xl)`），确保全局字体大小一致性
- **颜色语义化**：修复 SettingsPanel、PluginManager、ChatPanel 中的硬编码颜色（`#e67e22`、`#10b981`、`#fff`），替换为 CSS 变量（`var(--warning)`、`var(--success)`、`var(--text-on-accent)`）
- **保留 PPT 编辑器和 xterm 终端的数值 fontSize**：这些是 API 配置项，不是 CSS 样式

#### 笔记本功能审计（对标 lumina-note）
- 审计结论：功能完整，无断点。所有核心功能已对标 lumina-note 实现：
  - ✅ Markdown 编辑器（实时预览/分栏）
  - ✅ WikiLinks 双向链接
  - ✅ 反向链接面板（Backlinks）
  - ✅ 闪卡 SM-2 间隔重复
  - ✅ 知识图谱（已用 React Flow 重构）
  - ✅ 标签系统 + 笔记搜索
  - ✅ 版本历史
  - ✅ 导出 Markdown
  - ✅ 学习路径
  - ✅ LLM 调用统一走 `getConfiguredProvider`

#### 依赖更新
- 新增 `@xyflow/react` ^12.11.5

---

## v1.7.0 (2026-08-31)

### PPT 生成质量大幅提升 — oh-my-ppt 风格技能集成

本次更新将 [oh-my-ppt](https://github.com/arcsin1/oh-my-ppt) 项目的完整风格技能体系集成到 Codem 中，大幅提升 PPT 生成质量和视觉丰富度。

#### 新功能
- **74 种 PPT 风格技能集成**：通过 Vite `import.meta.glob` 在构建时收集所有 SKILL.md 文件，运行时注册到 Cordis SkillRegistry
- **9 种产品技能**：布局规则（oh-my-ppt-layout）、图表规则（oh-my-ppt-chart）、动画规则（oh-my-ppt-data-anim）等
- **新增 `ppt-skill-registry.ts`**：负责将 oh-my-ppt 的 SKILL.md 资源注册为 Cordis skills
- **新增 `src/core/knowledge/skills/` 目录**：存放从 oh-my-ppt 项目同步的 SKILL.md 资源文件

#### Bug 修复
- **修复 PPT 生成链路断点**（严重）：
  - **断点分析**：PPT 生成有两条通路——Studio 一键生成（PPTAdapter → `generatePPTContent`）和对话中生成（`generate_ppt` tool → `generatePPTContent`）。两条通路都经过 `generatePPTContent`，该函数内部是单次 LLM 调用（`provider.stream()`），不是 agentic loop，因此 AI 无法使用 `load_skill` 工具按需加载风格指令。
  - **修复方案**：在调用 LLM 之前，主动从 SkillRegistry 中加载当前选中风格的完整 SKILL.md 内容，注入到 systemPrompt 中。只加载当前选中的 1 个风格 + 产品技能（layout/chart/anim），不注入全部 74 个风格，避免 token 爆炸。

#### 架构改进
- **Cordis SkillRegistry 渐进式加载**：skills 注册到 SkillRegistry 后，在 agentic loop 对话中通过 `load_skill` 按需加载（progressive disclosure），systemPrompt 中只有 name + description
- **PPT 生成场景的特殊处理**：由于 `generatePPTContent` 是单次 LLM 调用（非 agentic loop），无法使用工具调用，因此采用"主动加载 + 注入"模式

#### 删除
- 删除旧的 `ppt-skill-loader.ts`（直接注入全部 76 个风格到 systemPrompt 的方案，会导致 token 爆炸）

---

## v1.6.2 (2026-08-29)

### 大富翁嵌入式游戏全量交付

在 Codem 中嵌入完整的大富翁4风格桌面游戏，作为用户等待 LLM 执行任务时的休闲娱乐。游戏作为完全独立的大插件运行，零侵入主项目代码。

- Phase 1-6：基础设施和核心玩法（棋盘渲染/动态骰子/地产系统/角色系统/命运新闻事件/股票系统/卡片系统/道具系统/AI 策略/存档读档）
- Phase 7-9：视觉交互和核心机制对齐（地块图标映射/角色精灵动画/消息条系统/物价指数/住院监狱酒店沉睡状态/连锁奖励税收）
- Phase 10：开局设置 + 机制补全 + 体验补全（多人热座/帮助规则/财富面板/投降功能/音量控制/速度调节）
- 三轮审计修复 7 个关键 Bug
