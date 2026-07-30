# mimo-gui 与 wecode-ref 功能对标分析清单

> 分析日期：2025-01-XX  
> 对标版本：wecode-ref (基于 Codex CLI)  
> 项目根目录：`.wecode-ref`

---

## 📊 执行摘要

**已实现功能**（✓）：  
1. ✓ 中途引导消息
2. ✓ Fork 对话
3. ✓ Regenerate 重新生成
4. ✓ 消息展开/折叠
5. ✓ 步骤进度显示
6. ✓ 子智能体列表/详情
7. ✓ 快照恢复
8. ✓ Git 信息面板
9. ✓ 搜索对话框
10. ✓ MCP 配置管理
11. ✓ 技能管理
12. ✓ Memory 记忆管理
13. ✓ 远程工作区
14. ✗ 消息重排序（仅在本地存储支持，不是在对话中）

**核心缺失功能**（❌）：  
1. ❌ 消息行内编辑与重新发送（InlineMessageEdit）
2. ❌ 消息队列（MessageSendQueue - 流式传输阻塞时排队发送）
3. ❌ 滚动条标记（ScrollbarMarkers - Google Gemini 风格的消息位置标记）
4. ❌ 滚动到底指示器（ScrollToBottomIndicator）
5. ❌ 消息反馈（点赞/点踩）
6. ❌ Correction 模式（事实核查模式）
7. ❌ 澄清表单（ClarificationForm - AI 向用户提问的交互式表单）
8. ❌ Pipeline 下一步对话框（PipelineNextStepDialog - 上下文传递/工作流）
9. ❌ TodoList 展示（TodoListDisplay - TodoWrite 工具输出的 Todo 可视化）
10. ❌ 引导消息展示块（GuidanceBlock - 在思考区域展示已注入的引导）
11. ❌ Workbench（代码工作台 - Git diff / commit stats / 文件树）
12. ❌ 快速访问卡片（QuickAccessCards - Agent 切换快捷卡片 + QuickLaunch）
13. ❌ 任务输入快捷短语（QuickPhrase - 模板化输入）
14. ❌ Prompt Draft（提示词草稿版本比较）
15. ❌ Prompt Optimization（提示词优化建议）
16. ❌ Prompt Fine-tune（提示词微调 - 用户自定义模型调参）
17. ❌ 消息前向转发（ForwardButton - 将 AI 消息转发到 Work Queue）
18. ❌ 深度思考模式切换（DeepThinkingToggle - 推理模式开关）
19. ❌ 保留执行器模式（PreserveExecutorToggle - 代码任务保留执行器不清理）
20. ❌ 消息搜索
21. ❌ 动画待机提示（StreamingWaitIndicator - 阶段式等待提示动画）
22. ❌ 上下文徽章（ContextBadge - 知识库/RAG 来源徽章）
23. ❌ 知识来源引用（SourceReferences - RAG 来源列表展示）
24. ❌ 模型选择器弹窗（RegenerateModelPopover - 重新生成时选择模型）
25. ❌ Re-edit 模式（将历史消息恢复到输入框）
26. ❌ Quick Launch（快速启动面板 - 基于意图的快捷操作）
27. ❌ Onboarding Tour（新手引导步骤）
28. ❌ 消息流式分阶段加载（MessageLoadingStage - 逐步加载动画）
29. ❌ 成功指示器（Success Indicator - 任务完成通知）
30. ❌ 多模态图片预览（ImageGallery）
31. ❌ 视频配置/预览（VideoPlayer / VideoConfigBadge / VideoInputControls）
32. ❌ 生成模式选择器（GenerateModeSelector - 图像/视频生成模式）
33. ❌ 分辨率/尺寸选择器（ResolutionSelector / RatioSelector / ImageSizeSelector）
34. ❌ 搜索引擎选择器（SearchEngineSelector）
35. ❌ 消息投递模式（dispatchMode: drain vs one-per-unblock）
36. ❌ 队列健康检查（useQueuedRuntimeHealthCheck）
37. ❌ 流式加入警告（useStreamingJoinWarning）
38. ❌ 消息贴纸/标签（Not implemented in mimo-gui）

---

## 🎯 分类清单（按优先级）

### 🔥 P0 - 核心交互增强

| 功能 | wecode-ref 实现位置 | mimo-gui 状态 | 说明 |
|-----|---------------------|--------------|------|
| **消息行内编辑与重新发送** | `InlineMessageEdit.tsx` + `BubbleTools.tsx` | ❌ 未实现 | 点击用户消息 → 编辑 → 确认 → 删除该消息及后续所有消息，从该点重新执行对话 |
| **滚动条标记** | `ScrollbarMarkers.tsx` | ❌ 未实现 | 在滚动条右侧显示小圆点标记每个用户消息位置，点击快速跳转（Google Gemini 风格） |
| **滚动到底部指示器** | `ScrollToBottomIndicator.tsx` | ❌ 未实现 | 用户向上滚动后显示"回到底部"按钮 |
| **消息反馈（点赞/点踩）** | `useMessageFeedback.ts` + `BubbleTools.tsx` | ❌ 未实现 | 消息下方显示 👍👎 按钮，状态持久化到 localStorage |

---

### 📱 P1 - 高级对话功能

| 功能 | wecode-ref 实现位置 | mimo-gui 状态 | 说明 |
|-----|---------------------|--------------|------|
| **Correction 模式** | `CorrectionModeToggle.tsx` + `CorrectionResultPanel.tsx` | ❌ 未实现 | 事实核查模式：对 AI 回复进行二次验证，显示对比面板（原回复 vs 修正后回复） |
| **澄清表单** | `ClarificationForm.tsx` + `ClarificationQuestion.tsx` | ❌ 未实现 | AI 向用户提问的交互式表单，支持单选/多选/文本输入，提交后格式化为 Markdown 发回 |
| **Pipeline 下一步对话框** | `PipelineNextStepDialog.tsx` | ❌ 未实现 | 工作流下钻：选择要传递的上下文（文本消息/知识库/表格），携带自定义提示继续任务 |
| **TodoList 展示** | `TodoListDisplay.tsx` | ❌ 未实现 | 将 TodoWrite 工具输出的 Todo 列表可视化（完成/进行中/待办） |
| **引导消息展示块** | `GuidanceBlock.tsx` | ❌ 未实现 | 在思考区域展示已注入的引导消息（用户可在折叠面板中查看） |
| **Workbench 代码工作台** | `Workbench.tsx` | ❌ 未实现 | 浮动侧边栏：显示 Git diff、commit 统计、文件树、工具执行状态 |
| **消息队列** | `useMessageSendQueue.ts` | ❌ 未实现 | 流式传输阻塞时自动排队发送消息，支持重试/取消 |
| **DeepThinking 模式** | `DeepThinkingToggle.tsx` | ❌ 未实现 | 推理模式开关（影响是否调用推理模型） |
| **Re-edit 模式** | `BubbleTools.tsx` + 历史消息恢复到输入框 | ❌ 未实现 | 点击历史按钮将用户消息恢复到输入框重新编辑发送 |
| **Guidance Block 展示** | `thinking/components/GuidanceBlock.tsx` | ❌ 未实现 | 显示已生效的引导消息在思考区域 |
| **RegenerateModelPopover** | `RegenerateModelPopover.tsx` | ❌ 未实现 | 重新生成时可选择不同模型（支持 ModelCascade） |

---

### 🚀 P2 - 用户体验提升

| 功能 | wecode-ref 实现位置 | mimo-gui 状态 | 说明 |
|-----|---------------------|--------------|------|
| **快速访问卡片** | `QuickAccessCards.tsx` | ❌ 未实现 | 常用 Agent 切换快捷卡片，支持拖拽排序、收藏、搜索 |
| **任务输入快捷短语** | `QuickLaunchPanel.tsx` | ❌ 未实现 | 预设模板化输入（如"帮我写一个 RESTful API"），一键快速启动任务 |
| **Prompt Draft** | `prompt-draft/` | ❌ 未实现 | 提示词草稿版本比较，支持 A/B 对比选择最佳版本 |
| **Prompt Optimization** | `prompt-optimization/` | ❌ 未实现 | 基于反馈自动优化提示词 |
| **Prompt Fine-tune** | `prompt-tune/PromptFineTuneDialog.tsx` | ❌ 未实现 | 用户自定义模型微调参数设置 |
| **Onboarding Tour** | `onboarding/OnboardingTour.tsx` + `tourSteps.ts` | ❌ 未实现 | 新手引导步骤，使用 driver.js 实现高亮引导 |
| **消息搜索** | `ChatArea.tsx` 内置搜索功能 | ❌ 未实现 | 对话历史全文搜索 |
| **成功指示器** | 成功气泡通知（pet bubble） | ✅ 部分实现 | 宠物气泡已实现任务完成通知 |
| **等待阶段提示** | `StreamingWaitIndicator.tsx` | ❌ 未实现 | 分阶段等待提示（Thinking... → Analyzing... → Generating...），带动画 |
| **消息加载阶段动画** | `MessageLoadingStage.tsx` | ❌ 未实现 | 消息逐步加载动画效果 |
| **流式加入警告** | `useStreamingJoinWarning.ts` | ❌ 未实现 | 流式传输中途加入对话的警告提示 |
| **队列健康检查** | `useQueuedRuntimeHealthCheck.ts` | ❌ 未实现 | 队列超时健康检查 |

---

### 🎨 P3 - 多媒体与高级配置

| 功能 | wecode-ref 实现位置 | mimo-gui 状态 | 说明 |
|-----|---------------------|--------------|------|
| **消息前向转发** | `ForwardButton.tsx` → Work Queue | ❌ 未实现 | 将 AI 回复转发到工作队列（团队协作） |
| **多模态图片预览** | `ImageGallery.tsx` | ❌ 未实现 | 图片缩略图预览画廊 |
| **视频配置/预览** | `VideoPlayer.tsx` / `VideoConfigBadge.tsx` / `VideoInputControls.tsx` | ❌ 未实现 | 视频生成模式配置、播放器 |
| **生成模式选择器** | `GenerateModeSelector.tsx` | ❌ 未实现 | 切换图像/视频生成模式 |
| **分辨率/尺寸选择器** | `ResolutionSelector.tsx` / `RatioSelector.tsx` / `ImageSizeSelector.tsx` | ❌ 未实现 | 多媒体生成参数选择 |
| **搜索引擎选择器** | `SearchEngineSelector.tsx` | ❌ 未实现 | 切换 Web 搜索引擎 |

---

### 🔧 P4 - 高级功能

| 功能 | wecode-ref 实现位置 | mimo-gui 状态 | 说明 |
|-----|---------------------|--------------|------|
| **PreserveExecutor** | `PreserveExecutorToggle.tsx` | ❌ 未实现 | 代码任务保留执行器不清理，减少启动开销 |
| **上下文徽章** | `ContextBadgeList.tsx` | ❌ 未实现 | RAG 来源徽章展示（知识库/表格/文档） |
| **知识来源引用** | `SourceReferences.tsx` | ❌ 未实现 | 显示 RAG 检索到的来源列表（标题、索引号） |
| **消息投递模式** | `useMessageSendQueue` 支持 `drain` / `one-per-unblock` | ❌ 未实现 | 排空模式 vs 每次解阻塞发送一条 |
| **Mention @ 提及** | `MentionAutocomplete.tsx` | ❌ 未实现 | 在消息中 @ 提及团队成员/知识库 |
| **Skill Autocomplete** | `SkillAutocomplete.tsx` | ❌ 未实现 | 输入时自动补全技能名称 |
| **源选择器** | `SourceSelector.tsx` / `KnowledgeSourcePicker.tsx` | ❌ 未实现 | 知识库来源选择器 |
| **分组聊天** | `group-chat/` | ❌ 未实现 | 多人协作聊天、添加成员、绑定知识库 |
| **Inbox 消息队列** | `inbox/` | ❌ 未实现 | 消息队列、转发、定时任务 |
| **Feed 订阅** | `feed/` | ❌ 未实现 | 订阅通知、定时任务、Cron 表达式编辑器 |
| **Git 集成** | `GitHubIntegration.tsx` | ❌ 未实现 | GitHub token 管理、仓庘认阅 |
| **远程工作区** | `remote-workspace/` | ✅ 部分实现 | 远程工作区对话框 |

---

## 🔄 相似但有差异的功能

| 功能 | wecode-ref | mimo-gui | 差异说明 |
|-----|-----------|---------|---------|
| **Guidance（中途引导）** | useGuidanceQueue（Socket 驱动，支持远程） | GuidanceQueue（本地内存） | wecode-ref 支持跨进程 WebSocket，mimo-gui 仅本地 |
| **Fork 对话** | 支持 Fork+Transfer | 仅 Fork，未实现 Transfer | wecode-ref 支持任务迁移/导入导出 |
| **Agent 管理** | QuickAccessCards + Drag & Reorder + Favorites | AgentManager 列表 | mimogui 无快捷卡片、拖拽排序、收藏 |
| **消息持久化** | 后端数据库 | SQLite 本地数据库 | mimogui 无云端同步 |

---

## 🏗️ 架构差异

| 层级 | wecode-ref | mimo-gui |
|-----|-----------|---------|
| **前端** | Next.js + React + TypeScript | Electron + React + TypeScript |
| **后端** | Python FastAPI + PostgreSQL | Tauri + Rust Executor + SQLite |
| **存储** | 云端数据库 + Redis | 本地 SQLite |
| **通信** | WebSocket（实时双向） | 内存回调 + SQLite |
| **执行器** | Rust（独立进程，IPC 通信） | Rust（子进程，stdin/stdout） |
| **知识库** | 后端 RAG + 向量数据库 | Notebook（本地知识库） |
| **技能管理** | 云端 + 本地下载 | 仅本地 |

---

## 📋 实施建议

### 立即行动（Q1）

1. **InlineMessageEdit + 行内编辑重发** - 用户体验核心功能
   - 参考 `InlineMessageEdit.tsx` + `BubbleTools.tsx`
   - 点击用户消息 → 替换为可编辑 textarea → 保存确认 → 截断后续消息 → 重新执行

2. **ScrollbarMarkers 滚动条标记** - 长对话必备
   - 参考 `ScrollbarMarkers.tsx`
   - 在 ChatPanel 滚动容器右侧显示小圆点

3. **ScrollToBottomIndicator 回到底部按钮** - 基础交互
   - 参考 `ScrollToBottomIndicator.tsx`
   - 检测滚动位置，用户上滚后显示浮动按钮

4. **消息反馈（点赞/点踩）** - 收集用户反馈
   - 参考 `useMessageFeedback.ts`
   - 持久化到 localStorage，支持遥测

### 近期规划（Q2）

5. **Correction 模式** - 事实核查，提升可信度
   - 参考 `CorrectionModeToggle.tsx` + `CorrectionResultPanel.tsx`
   - 切换开关 → 选择修正模型 → 对比展示 → 应用修正

6. **Clarification Form 澄清表单** - 交互式提问
   - 参考 `ClarificationForm.tsx`
   - 解析 `clarification` 事件 → 渲染表单 → 提交格式化答案

7. **Workbench 代码工作台** - Git 可视化
   - 参考 `Workbench.tsx`
   - 浮动侧边栏：Git diff、commit 统计、文件树、工具执行状态

8. **QuickAccessCards 快速访问** - Agent 切换效率
   - 参考 `QuickAccessCards.tsx`
   - Agent 卡片展示、拖拽排序、收藏、搜索

### 中期规划（Q3-Q4）

9. **Prompt Draft + Optimization** - 提示词工程
   - 参考 `prompt-draft/` + `prompt-optimization/`
   - 版本比较、A/B 测试、自动优化建议

10. **Onboarding Tour** - 新手引导
    - 参考 `onboarding/` + `tourSteps.ts`
    - 使用 driver.js 实现步骤引导

11. **消息搜索** - 长对话历史检索
    - 在 ChatPanel 添加搜索输入框、高亮匹配结果

12. **深度思考模式** - 推理模型支持
    - 参考 `DeepThinkingToggle.tsx`
    - 切换开关影响提示词（是否启用 reasoning_content）

### 长期规划（2026+）

13. **分组聊天** - 多人协作
14. **Inbox 消息队列** - 定时任务
15. **Feed 订阅** - 通知订阅
16. **云端同步** - 多设备同步

---

## 📚 参考文件索引

### wecode-ref 关键文件

| 功能 | 文件路径 |
|-----|---------|
| 行内编辑 | `frontend/src/features/tasks/components/message/InlineMessageEdit.tsx` |
| 气泡工具栏 | `frontend/src/features/tasks/components/message/BubbleTools.tsx` |
| 消息反馈 | `frontend/src/hooks/useMessageFeedback.ts` |
| 滚动标记 | `frontend/src/features/tasks/components/chat/ScrollbarMarkers.tsx` |
| 回到底部 | `frontend/src/features/tasks/components/chat/ScrollToBottomIndicator.tsx` |
| Correction 模式 | `frontend/src/features/tasks/components/CorrectionModeToggle.tsx` |
| 澄清表单 | `frontend/src/features/tasks/components/clarification/ClarificationForm.tsx` |
| Pipeline 对话框 | `frontend/src/features/tasks/components/chat/PipelineNextStepDialog.tsx` |
| TodoList 展示 | `frontend/src/features/tasks/components/message/thinking/components/TodoListDisplay.tsx` |
| 引导展示块 | `frontend/src/features/tasks/components/message/thinking/components/GuidanceBlock.tsx` |
| Workbench | `frontend/src/features/tasks/components/workbench/Workbench.tsx` |
| 快速访问 | `frontend/src/features/tasks/components/chat/QuickAccessCards.tsx` |
| Prompt Draft | `frontend/src/features/prompt-draft/` |
| Onboarding | `frontend/src/features/onboarding/OnboardingTour.tsx` |
| 消息队列 | `frontend/src/features/tasks/components/chat/useMessageSendQueue.ts` |
| 引导队列 | `frontend/src/features/tasks/components/chat/useGuidanceQueue.ts` |
| 等待指示器 | `frontend/src/features/tasks/components/message/StreamingWaitIndicator.tsx` |
| 知识来源引用 | `frontend/src/features/tasks/components/chat/SourceReferences.tsx` |
| Regenerate 弹窗 | `frontend/src/features/tasks/components/message/RegenerateModelPopover.tsx` |
| 消息搜索 | `frontend/src/features/tasks/components/input/ChatInput.tsx` |
| 深度思考 | `frontend/src/features/tasks/components/input/DeepThinkingToggle.tsx` |
| 保留执行器 | `frontend/src/features/tasks/components/PreserveExecutorToggle.tsx` |

---

## ✅ 已完成功能

1. ✓ **中途引导消息**（Guidance）- `src/core/llm/guidance-queue.ts`
2. ✓ **Fork 对话** - 已实现（复制对话到新会话）
3. ✓ **Regenerate 重新生成** - 已实现（重新执行用户消息）
4. ✓ **消息展开/折叠** - 已实现
5. ✓ **步骤进度显示** - 已实现（`stepProgress` + 进度环 + Tooltip）
6. ✓ **子智能体列表/详情** - 已实现（`AgentPanel` + `AgentDetail`）
7. ✓ **快照恢复** - 已实现（`SessionRecovery`）
8. ✓ **Git 信息面板** - 已实现（`GitInfoPanel`）
9. ✓ **搜索对话框** - 已实现（`SearchDialog`）
10. ✓ **MCP 配置管理** - 已实现（`McpManager`）
11. ✓ **技能管理** - 已实现（`SkillManager`）
12. ✓ **Memory 记忆管理** - 已实现（`MemoryManager`）
13. ✓ **远程工作区** - 已实现（部分功能）
14. ✓ **执行器模式切换**（Git Worktree） - 已实现

---

## 🔍 实施检查清单

- [ ] P0-1: 实现 InlineMessageEdit 组件
- [ ] P0-1: 在 MessageBubble 中添加 Edit/Re-edit 工具按钮
- [ ] P0-1: 实现"编辑后删除后续消息"逻辑
- [ ] P0-2: 实现 ScrollbarMarkers 组件
- [ ] P0-2: 在 ChatPanel 滚动容器中挂载 ScrollbarMarkers
- [ ] P0-3: 实现 ScrollToBottomIndicator 组件
- [ ] P0-3: 在 ChatPanel 添加滚动检测逻辑
- [ ] P0-4: 实现 useMessageFeedback hook
- [ ] P0-4: 在 MessageBubble 添加点赞/点踩按钮

---

## 📝 技术债务

1. **命名约定** - 所有自定义函数/方法名已避免使用 "codex" 字样
2. **类型安全** - 使用 TypeScript 严格模式，确保类型定义完整
3. **测试覆盖** - 新增功能需编写单元测试和 E2E 测试
4. **国际化** - 所有新功能需支持中英双语

---

## 🎯 总结

wecode-ref 是一个成熟的企业级 Codex CLI 二次开发项目，具有丰富的用户交互功能和完整的后端架构。mimo-gui 作为本地化桌面应用，已实现核心的编码能力，但在**用户交互细节**、**协作功能**、**工作流增强**方面仍有较大差距。

**核心建议**：优先实现 P0 和 P1 类功能，这些是用户感知最强的体验改进点。P2-P4 类功能可根据实际需求逐步迭代。

---

*本文档将持续更新，随着功能落地实时标记状态。*