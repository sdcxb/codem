# UI 对标分析报告：mimo-gui vs wecode-ref

> 深度分析每个功能的操作链路、入口层级位置、以及 mimo-gui 当前实现的问题

---

## 一、整体架构对比

### wecode-ref 的三层 UI 架构

```
┌──────────────────────────────────────────────────────┐
│  TaskSidebar（左侧栏）                                  │
│  - 导航按钮：Flow / Code / Wiki / Library / Devices / Inbox  │
│  - 任务列表（TaskListSection + TaskHistorySection）      │
│  - 搜索入口（SearchDialog 快捷键触发）                    │
│  - 历史管理（HistoryManageDialog）                       │
│  - 用户菜单（UserFloatingMenu）                         │
├──────────────────────────────────────────────────────┤
│  ChatArea（主对话区）                                    │
│  ┌────────────────────────────────────────────────┐   │
│  │  MessagesArea（消息列表，占满主区域）              │   │
│  │  - MessageBubble（消息气泡，含 BubbleTools）      │   │
│  │  - ThinkingDisplay（推理过程，含 ToolBlock）      │   │
│  │  - GuidanceBlock（引导消息，在消息流内）          │   │
│  │  - TodoListDisplay（Todo列表，在消息流内）        │   │
│  │  - StreamingWaitIndicator（等待指示器，消息流内） │   │
│  │  - InlineMessageEdit（内联编辑，消息气泡上）      │   │
│  │  - RegenerateModelPopover（重新生成，消息气泡上） │   │
│  │  - ImageGallery / VideoPlayer（多模态，消息流内） │   │
│  │  - ScrollbarMarkers / ScrollToBottomIndicator    │   │
│  └────────────────────────────────────────────────┘   │
│  ┌────────────────────────────────────────────────┐   │
│  │  空状态（无消息时）                                │   │
│  │  - SloganDisplay（标语）                          │   │
│  │  - ChatInputCard（输入卡片，居中显示）             │   │
│  │  - QuickAccessCards（快捷访问卡片，在输入框下方）   │   │
│  │    └─ 包含：Agent选择 + QuickPhrase + QuickPreset │   │
│  └────────────────────────────────────────────────┘   │
│  ┌────────────────────────────────────────────────┐   │
│  │  ChatInputCard（浮动输入区，有消息时固定在底部）    │   │
│  │  - ChatInput（文本输入框）                        │   │
│  │  - ChatInputControls（工具栏，在输入框下方）       │   │
│  │    左侧：AttachmentButton | AgentSkillSelectorMenu│   │
│  │           ChatContextInput | InputMoreActionsMenu │   │
│  │           ProjectSelectorTab | RepositorySelector │   │
│  │    右侧：ModelSelector | ChatToolbarStatus | Send │   │
│  └────────────────────────────────────────────────┘   │
│  - PipelineStageIndicator（阶段指示器，条件渲染）       │
│  - PipelineNextStepDialog（弹窗，条件渲染）             │
│  - AlertDialog × 3（快捷短语覆盖确认 / 表单替换确认 /    │
│    任务替换确认）                                       │
├──────────────────────────────────────────────────────┤
│  全局弹窗层（不在 ChatArea 内部）                       │
│  - SearchDialog（搜索，全局快捷键触发）                 │
│  - Workbench（工作台，独立面板/抽屉）                    │
│  - SettingsPanel（设置，独立页面）                      │
│  - TeamEditDialog（团队编辑，弹窗）                     │
└──────────────────────────────────────────────────────┘
```

### mimo-gui 当前实现（问题所在）

```
┌──────────────────────────────────────────────────────┐
│  Sidebar（左侧栏）                                     │
│  - 项目列表 / 会话列表                                  │
├──────────────────────────────────────────────────────┤
│  ChatPanel（主对话区）                                  │
│  ┌────────────────────────────────────────────────┐   │
│  │  chat-header（顶部工具栏 —— 严重超载！）            │   │
│  │  ☰ | Codem | Model▾ | 💭 | 🤖 | 🌿 | 📸 | 📊 |   │   │
│  │  ⛓ | 🔍 | CorrectionToggle | 🛠 | 📋 | 📝 | ●   │   │
│  │  （12+ 个按钮全堆在这里）                          │   │
│  └────────────────────────────────────────────────┘   │
│  ┌────────────────────────────────────────────────┐   │
│  │  搜索栏（条件渲染，在 header 下方）                 │   │
│  └────────────────────────────────────────────────┘   │
│  ┌────────────────────────────────────────────────┐   │
│  │  chat-body（消息区 + 各种面板混在一起）             │   │
│  │  - MessagesContainer                            │   │
│  │  - EmptyState（含 QuickAccessCards）             │   │
│  │  - AgentPanel / SnapshotPanel / GitPanel /      │   │
│  │    ContextMonitor（4个面板抢同一位置）             │   │
│  │  - Workbench（工作台，也在 chat-body 里）         │   │
│  │  - TodoListDisplay（也在 chat-body 里）           │   │
│  │  - QuickPhraseSelector（下拉，在 chat-body 里）   │   │
│  │  - PromptDraftPicker（下拉，在 chat-body 里）     │   │
│  └────────────────────────────────────────────────┘   │
│  ┌────────────────────────────────────────────────┐   │
│  │  StreamingWaitIndicator / GuidanceBlock          │   │
│  │  StepProgress（进度指示器）                       │   │
│  └────────────────────────────────────────────────┘   │
│  ┌────────────────────────────────────────────────┐   │
│  │  InputArea（输入区）                              │   │
│  │  - FileUpload | SkillPicker(🎯) | ModeToggle(📋/⚡)│  │
│  │  | MultimodalToggle(🎨) + GenerateMode + Resolution│ │
│  │  | SourceSelector(📚) | SecurityMode(🔒)          │   │
│  │  | ContextBadgeList | MentionAutocomplete        │   │
│  │  | Textarea | ExpandButton | SendButton          │   │
│  │  - 底部控制栏：Project | ExecutionMode | Branch   │   │
│  └────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────┘
```

---

## 二、逐功能操作链路对比

### 功能 1：快速访问卡片（QuickAccessCards）

**功能定义**：新会话空状态下，提供 Agent 快捷入口和常用短语

| 维度 | wecode-ref | mimo-gui |
|------|-----------|----------|
| **触发条件** | `!hasMessages && !hideSelectors && !activeProject` | `messages.length === 0 && showQuickAccess && connected` |
| **渲染位置** | ChatArea 空状态区域内，在 ChatInputCard **下方** | ChatPanel 空状态区域，在 logo 和标题 **下方** |
| **包含内容** | Agent选择 + QuickPhrase（快捷短语）+ QuickPreset（预设组合） | 仅 Agent 快捷入口 |
| **操作链路** | ①空状态→②看到卡片→③点击Agent→④自动选中Team→⑤输入框获得焦点→⑥用户输入→⑦发送 | ①空状态→②看到卡片→③点击Agent→④自动发送一条prompt→⑤开始对话 |
| **问题** | ✅ 正确：卡片是空状态的辅助，有消息后消失 | ❌ 问题：①排版乱（位置和样式不对齐）②点击后直接发送而非填充输入框，用户体验突兀 |

**wecode-ref 链路详解**：
```
用户进入新会话
  → ChatArea 检测 hasMessages=false
  → 渲染空状态布局：SloganDisplay + ChatInputCard + QuickAccessCards
  → QuickAccessCards 显示：
    - 可用 Agent 列表（从 teams 配置获取）
    - 快捷短语列表（从服务端 quickAccess API 获取）
    - 预设组合（含 deep_thinking/clarification/skills 等开关）
  → 用户点击 Agent 卡片
    → onTeamSelect(team) → 选中该 Team
    → 输入框获得焦点
    → 用户继续输入消息
  → 或用户点击快捷短语
    → onPhraseSelect(phrase) → 填充到输入框
    → 如果输入框已有内容 → 弹出覆盖确认对话框
  → 有消息后 QuickAccessCards 不再渲染
```

### 功能 2：代码工作台（Workbench）

**功能定义**：展示当前 Agent 正在使用的工具、修改的文件

| 维度 | wecode-ref | mimo-gui |
|------|-----------|----------|
| **入口位置** | 独立面板/抽屉，不在 ChatArea 内 | ChatPanel 的 chat-header 中的 🛠 按钮 |
| **触发条件** | 由页面布局控制（侧边面板） | 点击 header 中的 🛠 按钮 |
| **渲染位置** | 独立于 ChatArea 的面板区域 | chat-body 内，和消息列表抢占空间 |
| **数据来源** | 从 taskState 获取实时工具调用和文件修改 | 空数组（`activeTools={[]}`, `modifiedFiles={[]}`） |
| **操作链路** | ①查看侧边面板→②看到工具执行状态→③点击文件可跳转编辑器 | ①点击header按钮→②面板出现在消息区下方→③空内容，无数据 |
| **问题** | ✅ 正确：独立面板不干扰对话 | ❌ 问题：①放在header作为一级入口但无实际数据②占据消息区空间③点无反应 |

**wecode-ref 链路详解**：
```
Workbench 是 task 级别的面板组件
  → 由 ChatArea 的父组件控制显示
  → 从 taskState.messages 中提取：
    - 当前活跃工具调用（running 状态的 toolCall）
    - 已修改文件列表（从 toolCall result 提取）
  → 面板内可以：
    - 展开/收起
    - 点击文件名跳转到 FileEditor
    - 查看工具调用参数和结果
  → 不在对话主区域，不干扰消息阅读
```

### 功能 3：快捷短语（QuickPhrase）

**功能定义**：预设常用 prompt 短语，快速填入输入框

| 维度 | wecode-ref | mimo-gui |
|------|-----------|----------|
| **入口位置** | ①空状态：QuickAccessCards 内的 QuickPhraseList ②有消息时：不直接暴露，通过 QuickLaunch 面板 | ChatPanel header 的 📋 按钮 |
| **触发条件** | 空状态自动显示 / QuickLaunch 面板触发 | 手动点击 header 按钮 |
| **渲染位置** | QuickAccessCards 内嵌列表 / QuickLaunch 弹出面板 | chat-body 内的 QuickPhraseSelector 下拉 |
| **操作链路** | ①空状态看到短语列表→②点击→③填充输入框→④如有内容弹出确认 | ①点header按钮→②下拉出现在消息区→③点击短语→④填充输入框 |
| **问题** | ✅ 正确：短语是空状态的辅助或弹出面板 | ❌ 问题：①header按钮是一级入口，但短语是二级功能②下拉在chat-body中占位混乱 |

**wecode-ref 链路详解**：
```
方式1（空状态）：
  新会话 → QuickAccessCards 渲染
    → QuickPhraseList 作为子组件
    → 显示常用短语列表
    → 用户点击短语
      → onPhraseSelect(phrase)
      → 如果输入框为空 → 直接填入
      → 如果输入框有内容 → AlertDialog 确认覆盖
        → 确认 → 覆盖输入框内容
        → 取消 → 保持原内容

方式2（有消息时）：
  → 通过 QuickLaunch 面板（URL 参数或侧边入口触发）
  → QuickLaunchPanel 渲染
  → 同样的短语选择逻辑
```

### 功能 4：多模态生成模式（GenerateMode + Resolution）

**功能定义**：切换文本/图片/视频生成模式，选择分辨率

| 维度 | wecode-ref | mimo-gui |
|------|-----------|----------|
| **入口位置** | ChatInputControls 工具栏内，仅 `isGenerationMode` 时显示 | InputArea 左侧工具栏的 🎨 按钮 |
| **触发条件** | `isGenerateMode(taskType)` — 由页面类型决定 | 手动点击 🎨 按钮切换 |
| **渲染位置** | 输入框下方工具栏，与其他选择器平级 | 输入框左侧，展开后挤占输入空间 |
| **选择器组合** | GenerateModeSelector + ImageSizeSelector + VideoSettingsPopover（统一弹窗） | GenerateModeSelector + ResolutionSelector（内联展开） |
| **操作链路** | ①进入图片/视频页面→②自动显示模式切换→③选择模型→④设置参数→⑤输入prompt→⑥发送 | ①点🎨按钮→②内联展开模式选择→③选模式→④再展开分辨率→⑤挤占了输入框空间 |
| **问题** | ✅ 正确：仅在生成模式下显示，参数在 popover 中不挤占空间 | ❌ 问题：①🎨按钮始终显示但大部分场景用不到②内联展开挤占输入空间③与文本对话模式混淆 |

**wecode-ref 链路详解**：
```
进入图片生成页面 (taskType='image')
  → ChatInputControls 检测 isImageMode=true
  → 渲染：
    - GenerateModeSelector（video/image 切换，仅生成页面有）
    - AttachmentButton（参考图上传，仅生成模式有）
    - ModelSelector（image category 模型选择器）
    - ImageSizeSelector（图片尺寸选择器，popover 形式）
  → 非生成模式 (taskType='chat'/'code')
    → 以上组件全部不渲染
    → 只显示：AttachmentButton | AgentSkillSelector | ChatContextInput | InputMoreActionsMenu

进入视频生成页面 (taskType='video')
  → 渲染：
    - GenerateModeSelector
    - AttachmentButton（参考图）
    - ModelSelector（video category）
    - VideoSettingsPopover（统一弹窗：ratio + duration + resolution）
  → 所有参数在 popover 内，不挤占工具栏空间
```

### 功能 5：纠正模式（CorrectionModeToggle）

**功能定义**：开启 AI 自我纠正模式，自动检查并修正输出

| 维度 | wecode-ref | mimo-gui |
|------|-----------|----------|
| **入口位置** | InputMoreActionsMenu 的 Popover 内（...菜单） | ChatPanel header 中直接作为按钮 |
| **触发条件** | `showCorrection && onCorrectionModeToggle`（仅 ChatShell 类型 team） | 始终显示 |
| **渲染位置** | ... 菜单内的 menu-item | header 工具栏 |
| **操作链路** | ①点击...菜单→②看到CorrectionModeToggle→③切换开关→④关闭菜单 | ①在header直接看到按钮→②点击切换 |
| **问题** | ✅ 正确：作为低频功能放在更多操作菜单 | ❌ 问题：纠正模式是低频功能，不应放在header一级入口 |

### 功能 6：模型选择器（ModelSelector）

| 维度 | wecode-ref | mimo-gui |
|------|-----------|----------|
| **入口位置** | ChatInputControls 工具栏右侧 | ChatPanel header 中 |
| **渲染位置** | 输入框下方工具栏，与 SendButton 同一行 | header 工具栏 |
| **操作链路** | ①在输入工具栏看到模型名→②点击→③弹出模型列表→④选择→⑤关闭 | ①在header看到模型名→②点击→③弹出列表→④选择 |
| **问题** | ✅ 正确：模型选择与发送操作在同一行，操作连贯 | ❌ 问题：模型选择在header，与输入区分离，操作不连贯 |

### 功能 7：对话搜索（SearchDialog）

| 维度 | wecode-ref | mimo-gui |
|------|-----------|----------|
| **入口位置** | TaskSidebar 中的搜索入口 + 全局快捷键 | ChatPanel header 的 🔍 按钮 |
| **触发条件** | 点击搜索图标或 Ctrl+K | 点击 🔍 按钮 |
| **渲染位置** | 全局弹窗（SearchDialog），覆盖整个页面 | header 下方展开的内联搜索栏 |
| **搜索范围** | 全局所有任务的对话历史 | 当前会话的消息内容 |
| **操作链路** | ①Ctrl+K或点侧边搜索→②全屏弹窗→③输入关键词→④看到匹配的会话列表→⑤点击跳转 | ①点header🔍→②内联展开搜索栏→③输入→④过滤当前消息→⑤匹配高亮 |
| **问题** | ✅ 正确：全局搜索放在侧边栏+快捷键 | ⚠️ 部分正确：当前会话内搜索可以保留，但应支持全局搜索 |

### 功能 8：提示词草稿（PromptDraftPicker）

| 维度 | wecode-ref | mimo-gui |
|------|-----------|----------|
| **入口位置** | PromptDraftDialog（独立弹窗）/ PetStreamingBridge（宠物触发） | ChatPanel header 的 📝 按钮 |
| **触发条件** | 有草稿时显示入口 | `promptDrafts.length > 0` 时显示按钮 |
| **渲染位置** | 全局弹窗 | chat-body 内的下拉 |
| **操作链路** | ①点击入口→②弹窗显示草稿列表→③选择→④填入输入框 | ①点header📝→②下拉→③选择→④填入 |
| **问题** | ✅ 正确：弹窗形式不干扰主区域 | ❌ 问题：低频功能放在header一级入口 |

### 功能 9：Agent 列表 / 快照 / Git 信息 / 上下文监控

| 维度 | wecode-ref | mimo-gui |
|------|-----------|----------|
| **入口位置** | 各自独立的侧边面板或独立页面 | ChatPanel header 的 🤖 / 📸 / 🌿 / 📊 四个按钮 |
| **渲染位置** | 独立面板区域 | chat-body 内，4个面板抢占同一位置 |
| **操作链路** | ①点击侧边面板入口→②面板在独立区域展开→③不干扰对话 | ①点header按钮→②面板出现在消息区下方→③挤压消息显示空间 |
| **问题** | ✅ 正确：独立区域不干扰对话 | ❌ 问题：4个面板抢占chat-body同一位置，互相排斥且挤压消息区 |

### 功能 10：引导消息（GuidanceBlock）

| 维度 | wecode-ref | mimo-gui |
|------|-----------|----------|
| **入口位置** | ThinkingDisplay 组件内（消息流中） | ChatPanel 在 chat-body 和 InputArea 之间 |
| **渲染位置** | 消息流内，作为助手消息的一部分 | 独立区域，在消息区和输入区之间 |
| **操作链路** | ①Agent运行中→②引导消息出现在消息流→③用户看到→④可交互 | ①Agent运行中→②引导消息出现在独立区域→③同时替换输入框为引导输入框 |
| **问题** | ✅ 正确：引导是消息流的一部分 | ⚠️ 部分正确：独立区域也可以，但引导输入框替换正常输入框的体验不够好 |

### 功能 11：澄清表单（ClarificationForm）

| 维度 | wecode-ref | mimo-gui |
|------|-----------|----------|
| **入口位置** | InteractiveFormDialog（全局弹窗） | ChatPanel 条件渲染 |
| **渲染位置** | 全局弹窗，模态 | 消息区上方条件渲染 |
| **操作链路** | ①Agent发起clarification事件→②弹窗→③用户填写→④提交→⑤继续对话 | ①事件→②消息区上方显示表单→③填写→④提交 |
| **问题** | ✅ 正确：模态弹窗强制用户回应 | ⚠️ 部分正确：非模态可能被忽略 |

---

## 三、核心问题总结

### 问题 1：header 工具栏严重超载

**当前**：12+ 个按钮全堆在 `chat-header` 中

**应该**：header 只保留一级操作
- ☰ 侧边栏切换
- 标题
- 模型选择器（移到输入区工具栏）
- 连接状态

### 问题 2：二级功能占用一级入口

以下功能不应出现在 header：
| 功能 | 当前位置 | 应该位置 |
|------|---------|---------|
| 🛠 Workbench | header 按钮 | 独立侧边面板 |
| 📋 QuickPhrase | header 按钮 | 空状态QuickAccessCards / 输入区更多操作 |
| 📝 PromptDraft | header 按钮 | 弹窗 / 输入区更多操作 |
| CorrectionToggle | header 按钮 | 输入区更多操作(...) |
| 🤖 AgentPanel | header 按钮 | 独立侧边面板 |
| 📸 Snapshot | header 按钮 | 独立侧边面板 |
| 🌿 GitPanel | header 按钮 | 独立侧边面板 |
| 📊 ContextMonitor | header 按钮 | 独立侧边面板 |

### 问题 3：输入区工具栏混乱

**当前**：InputArea 左侧塞了 7+ 个按钮（FileUpload / SkillPicker / ModeToggle / MultimodalToggle+GenerateMode+Resolution / SourceSelector / SecurityMode）

**应该**：参考 wecode-ref 的 ChatInputControls
- 左侧：AttachmentButton | AgentSkillSelectorMenu | ChatContextInput | InputMoreActionsMenu(...)
- 右侧：ModelSelector | ChatToolbarStatus | SendButton
- 多模态相关：仅生成模式下显示，用 popover 而非内联展开

### 问题 4：面板抢占消息区空间

**当前**：AgentPanel / SnapshotPanel / GitPanel / ContextMonitor / Workbench / TodoListDisplay / QuickPhraseSelector / PromptDraftPicker 全部渲染在 `chat-body` 内

**应该**：这些面板应该
- 放在独立侧边面板（RightSidebar）
- 或作为全局弹窗/抽屉
- 不与消息列表抢占空间

---

## 四、改进方案：三层分离架构

### 第一层：Header（极简）

```
[☰] [Codem]                              [● status]
```

仅保留：侧边栏切换 + 标题 + 连接状态

### 第二层：消息区（纯净）

```
┌────────────────────────────────────┐
│  MessagesArea（消息流）              │
│  - MessageBubble + BubbleTools      │
│  - ThinkingDisplay（推理+工具块）    │
│  - GuidanceBlock（引导消息）          │
│  - TodoListDisplay（Todo列表）       │
│  - StreamingWaitIndicator           │
│  - ScrollbarMarkers / Indicator     │
│                                    │
│  空状态：                            │
│  - SloganDisplay                    │
│  - ChatInputCard（居中输入框）        │
│  - QuickAccessCards（Agent+短语）    │
└────────────────────────────────────┘
```

### 第三层：输入区（工具栏化）

```
┌──────────────────────────────────────────────────┐
│  [📎] [🎯Agent▾] [💬Context] [⋯更多] [🔒Security] │  ← 左侧工具栏
│  [Project ▾] [Mode ▾] [Branch ▾]                 │  ← 底部控制栏
├──────────────────────────────────────────────────┤
│  Textarea                                    [→] │  ← 输入框 + 发送
└──────────────────────────────────────────────────┘
                                         [Model ▾] ↑  ← 右侧：模型+状态+发送
```

**"⋯更多"菜单**（InputMoreActionsMenu）包含：
- CorrectionModeToggle（纠正模式）
- ClarificationToggle（澄清开关）
- DeepThinkingToggle（深度思考）
- SkillSelectorPopover（技能选择）
- PromptDraftPicker（草稿选择）
- QuickPhraseSelector（快捷短语）

### 第四层：侧边面板（独立区域）

```
┌──────────────────────────────┐
│  RightSidebar（可切换标签）     │
│  [🤖Agent] [📸Snapshot] [🌿Git] [📊Context] [🛠Workbench] │
│                              │
│  当前选中标签的内容...          │
└──────────────────────────────┘
```

### 第五层：全局弹窗

- SearchDialog（搜索，Ctrl+K 触发）
- PipelineNextStepDialog（流水线下一步）
- ClarificationForm（澄清表单，模态弹窗）
- SettingsPanel（设置）
- Workbench（如果需要全屏查看）

---

## 五、操作链路改进对照表

| 功能 | 当前链路 | 改进后链路 |
|------|---------|-----------|
| 快速访问 | header无入口 → 空状态显示卡片 → 点击直接发送 | 空状态显示卡片+短语 → 点击Agent选中 → 填入输入框 → 用户编辑后发送 |
| 工作台 | header 🛠 → chat-body面板 → 空内容 | 右侧面板标签 → 独立区域 → 实时工具状态 |
| 快捷短语 | header 📋 → chat-body下拉 → 选择 → 填入 | ①空状态: QuickAccessCards内 ②有消息: 输入区"⋯更多"菜单 |
| 多模态 | 输入区 🎨 → 内联展开 → 挤占空间 | 仅生成模式显示 → popover弹窗设置参数 → 不挤占空间 |
| 纠正模式 | header按钮 → 切换 | 输入区"⋯更多"菜单 → 切换 |
| 模型选择 | header → 弹出列表 → 选择 | 输入区右侧 → 弹出列表 → 选择（与Send同行） |
| 搜索 | header 🔍 → 内联搜索栏 | 侧边搜索入口 + Ctrl+K → 全局弹窗 |
| Agent/Git/Snapshot | header 4个按钮 → chat-body面板 | 右侧面板标签页 → 独立区域 |
| 草稿选择 | header 📝 → chat-body下拉 | 输入区"⋯更多"菜单 → 弹窗选择 |
| 引导输入 | 替换InputArea → 引导输入框 | 消息流内 GuidanceBlock + 底部正常输入框 |
| 澄清表单 | 消息区上方条件渲染 | 模态弹窗（InteractiveFormDialog） |
