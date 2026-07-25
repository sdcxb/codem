# 核心功能回归测试用例（枚举式全覆盖）

> **目标**：对对话、思考过程、回答反馈、工具调用、子智能体调用、技能调用等核心功能及其消息链路、存储、回调进行枚举式回归测试，防止新增环境配置、Git Worktree 等特性导致功能不可用。
>
> **测试框架**：Vitest（`src/test/*.test.ts`）
> **测试范围**：10 大模块 × ~260 用例
> **编写日期**：2026-07-25

---

## 目录

| 模块 | 用例编号区间 | 用例数 | 优先级 |
|------|-------------|--------|--------|
| [1. 对话核心链路](#1-对话核心链路) | CHAT-001 ~ CHAT-045 | 45 | P0 |
| [2. 思考过程与回答反馈](#2-思考过程与回答反馈) | REAS-001 ~ REAS-025 | 25 | P0 |
| [3. 工具调用链路](#3-工具调用链路) | TOOL-001 ~ TOOL-050 | 50 | P0 |
| [4. 子智能体调用链路](#4-子智能体调用链路) | SUBA-001 ~ SUBA-030 | 30 | P1 |
| [5. 技能调用链路](#5-技能调用链路) | SKIL-001 ~ SKIL-025 | 25 | P1 |
| [6. Git Worktree 环境](#6-git-worktree-环境) | WTR-001 ~ WTR-035 | 35 | P0 |
| [7. 跨会话委派](#7-跨会话委派) | DELE-001 ~ DELE-025 | 25 | P1 |
| [8. 上下文压缩与记忆系统](#8-上下文压缩与记忆系统) | CTXT-001 ~ CTXT-020 | 20 | P1 |
| [9. 权限/安全模式/沙箱](#9-权限安全模式沙箱) | SECU-001 ~ SECU-025 | 25 | P0 |
| [10. 存储/迁移/持久化](#10-存储迁移持久化) | STOR-001 ~ STOR-020 | 20 | P0 |
| **合计** | | **~320** | |

---

## 1. 对话核心链路

覆盖 `App.tsx → runAgenticLoop → engine.process() → AgenticLoop.run() → MessageStorage` 的完整消息流转链路。

### 1.1 消息发送与流式渲染（CHAT-001 ~ CHAT-015）

| 编号 | 用例名 | 前置条件 | 操作步骤 | 预期结果 | 优先级 |
|------|--------|---------|---------|---------|--------|
| CHAT-001 | 基本文本对话——用户发送纯文本消息 | 已选择项目+会话，Provider 已配置 | 输入 "你好" 并发送 | ① 用户消息立即出现在列表，状态 `done` ② assistant 消息状态经历 `streaming` → `done` ③ `text_delta` 事件逐字累积到 `assistantContent` ④ 最终 `saveMessages(sessionId)` 持久化到 DB | P0 |
| CHAT-002 | 多轮连续对话——上下文传递正确 | CHAT-001 完成 | 在同一会话继续发送 "刚才我说了什么？" | ① AgenticLoop `buildMessages` 包含上一轮 user+assistant 消息 ② LLM 能引用上一轮内容 ③ DB 中 `messages` 表按时间序存储 ≥4 条 | P0 |
| CHAT-003 | 流式缓冲——`streamBufferRef` 100ms 刷新 | 发送长文本回复 | 观察 DOM 更新频率 | ① `text_delta` 累积到 `buf.text` ② 100ms 定时器触发 `flushStreamBuffer` 刷新到 UI ③ 回复结束后 `finally` 块调用 `flushStreamBuffer` 刷新剩余缓冲 | P1 |
| CHAT-004 | 空回复——LLM 返回空文本 | Mock provider 返回空 stream | 发送任意消息 | ① assistant 消息内容为空字符串 ② 状态最终为 `done` ③ DB 中保存 content="" 的消息 ④ 不崩溃 | P1 |
| CHAT-005 | 中断/中止——用户点击停止按钮 | streaming 进行中 | 点击停止 | ① `sessionAbort.abort()` 被调用 ② `for await` 循环 `break` ③ 已有部分文本保存到 DB ④ `setStreaming(false)` + `setSessionActive(false)` ⑤ `streamingSessionIdRef` 清空 | P0 |
| CHAT-006 | 中断后继续——中止后再发送新消息 | CHAT-005 完成 | 输入新消息发送 | ① 新的 `runAgenticLoop` 正常启动 ② 新建 `AbortController` ③ 历史消息不丢失 ④ 不产生残留 timer | P0 |
| CHAT-007 | 多迭代消息——iteration > 1 时创建新消息 | LLM 需要多轮工具调用 | 触发含工具调用的对话 | ① `event.iteration > 1` 时前一条 assistant 消息 `status="done"` ② 新建 `assistant-{timestamp}-{iter}` 消息 ③ `assistantContent` 和 `reasoningContent` 重置 ④ `generatedFilesRef` 清空 | P0 |
| CHAT-008 | `safeAddMessage` 非查看会话——后台会话不更新 UI | 会话 A 正在执行，切换到会话 B | 会话 A 收到 delegation 消息 | ① `isViewingSession()` 返回 false ② `addMessage` 不被调用 ③ `saveMessages(session.id)` 仍然执行 ④ 切回会话 A 时 `loadMessages` 从 DB 恢复 | P1 |
| CHAT-009 | `safeUpdateMessage` 非查看会话——更新不写 UI | 同 CHAT-008 | 会话 A streaming 中 | ① `useAppStore.getState().updateMessage` 不被调用 ② DB 中消息已更新 | P1 |
| CHAT-010 | 系统错误消息——`engine.process` 抛异常 | Mock engine.process reject | 发送消息 | ① catch 块添加 `role="system"` 消息 ② content 以 `[Error]` 开头 ③ status 为 `"error"` ④ `saveMessages` 持久化错误消息 | P0 |
| CHAT-011 | Provider 未配置——`isConfigured()` 返回 false | 清空 API Key | 发送消息 | ① `setStreaming(false)` 立即执行 ② 添加 `[Error] xxx not configured` 消息 ③ 不调用 `engine.process` | P0 |
| CHAT-012 | 重新生成——`handleRegenerate` | 有至少一轮对话 | 点击重新生成 | ① 移除最后一条 assistant 消息 ② `runAgenticLoop(userMessage, session)` 重新执行 ③ 历史消息保持不变 | P1 |
| CHAT-013 | CLI 模式认证——MiMo auth 加载 | `getMode() === "cli"` | 发送消息 | ① `getMiMoAuth().getActiveAccount()` 被调用 ② 无 account 时尝试 `loadFromAuthJson` ③ 仍无 account 时返回错误消息 ④ 有 account 时 `setProviderConfig("mimo", ...)` | P1 |
| CHAT-014 | 步骤进度——`step_progress` 事件 | AgenticLoop 产生步骤 | 发送复杂任务 | ① `useAppStore.setStepProgress` 被调用 ② `current/total/title/steps` 正确映射 ③ 完成后 2s 清空 | P2 |
| CHAT-015 | 溢出处理——`overflow` 结果 | Mock LLM 返回 overflow | 发送消息 | ① `event.result.type === "overflow"` ② 添加 `⚠️` 系统消息 ③ 不显示 pet "完成" 气泡 | P1 |

### 1.2 消息存储与加载（CHAT-016 ~ CHAT-030）

| 编号 | 用例名 | 前置条件 | 操作步骤 | 预期结果 | 优先级 |
|------|--------|---------|---------|---------|--------|
| CHAT-016 | 消息持久化——`createMessage` 写入 SQLite | 发送消息 | 检查 DB | ① `messages` 表有对应 row ② `session_id` 正确 ③ `role`/`content`/`timestamp` 字段完整 ④ `tool_calls` 表关联正确 | P0 |
| CHAT-017 | 消息加载——`getMessages(sessionId)` | DB 有历史消息 | 切换到该会话 | ① `loadMessages(sessionId)` 被调用 ② 消息按 `timestamp` 升序排列 ③ tool_calls 按行序加载 ④ attachments 正确反序列化 | P0 |
| CHAT-018 | 消息更新——`updateMessage` 修改状态 | streaming 中的消息 | streaming 结束 | ① `status` 从 `streaming` 变为 `done` ② `reasoning` 字段保存 ③ `generated_files` JSON 序列化保存 | P0 |
| CHAT-019 | 工具调用存储——`addToolCall` | tool_start 事件 | 检查 DB | ① `tool_calls` 表新增行 ② `message_id` 关联正确 ③ `args` 为 JSON 字符串 ④ `status="running"` | P0 |
| CHAT-020 | 工具调用更新——`updateToolCall` | tool_complete 事件 | 检查 DB | ① `status` 变为 `done` ② `result` 保存为字符串 ③ `saveMessages` 立即执行（下一轮迭代可读） | P0 |
| CHAT-021 | 消息删除——`deleteMessage` | 有历史消息 | 删除消息 | ① DB 中消息行删除 ② 关联的 tool_calls 行删除 ③ 关联的 attachments 行删除 | P1 |
| CHAT-022 | 会话切换——`switchSession` 加载消息 | 会话 A 有 10 条消息，会话 B 有 5 条 | A→B→A | ① 切到 B 时加载 B 的 5 条 ② 切回 A 时加载 A 的 10 条 ③ 不交叉污染 | P0 |
| CHAT-023 | 中文内容存储——消息含中文和 Emoji | 发送含 "你好🌍🎉" 的消息 | 检查 DB | ① DB 中 content 保留原始中文和 Emoji ② 加载后显示正确 ③ JSON 序列化/反序列化无乱码 | P0 |
| CHAT-024 | 大消息存储——超长文本（10KB+） | 发送 10000 字符消息 | 检查 DB | ① 完整存储无截断 ② 加载完整 ③ 不影响其他消息 | P1 |
| CHAT-025 | `generatedFiles` 序列化——write 工具产出文件 | 触发 write 工具 | 检查 DB | ① `generated_files` 字段为 JSON 数组字符串 ② 加载后 `JSON.parse` 正确 ③ 空数组时为 `undefined`/null | P1 |
| CHAT-026 | `saveMessages` 幂等性——重复调用不产生重复 | 多次调用 saveMessages | 检查 DB | ① 同一 sessionId 消息不重复 ② 更新而非插入 | P1 |
| CHAT-027 | `reasoning` 字段持久化——思考过程保存 | 有 reasoning_delta 事件 | 检查 DB | ① `reasoning` 字段非 null ② 内容与 streaming 中累积的一致 ③ 加载后正确还原 | P0 |
| CHAT-028 | 会话标题更新——首条消息后自动命名 | 新建会话发送首条消息 | 观察 title | ① `lastMessageAt` 更新 ② `messageCount` 递增 ③ title 可能自动更新 | P2 |
| CHAT-029 | 跨项目隔离——不同项目消息不混淆 | 项目 A 和 B 各有会话 | 切换项目 | ① 只加载当前项目的会话 ② 会话的 `projectId` 正确 ③ 消息不跨项目泄漏 | P0 |
| CHAT-030 | Fork 会话——消息复制 | 有含工具调用的会话 | 执行 fork | ① 新会话有源会话到指定 index 的消息副本 ② tool_calls 正确复制 ③ args JSON 正确反序列化 ④ 新会话有独立 ID | P1 |

### 1.3 回调与事件链路（CHAT-031 ~ CHAT-045）

| 编号 | 用例名 | 前置条件 | 操作步骤 | 预期结果 | 优先级 |
|------|--------|---------|---------|---------|--------|
| CHAT-031 | `onPermissionRequest` 回调——权限请求触发 | 工具需要权限 | 发送需权限的任务 | ① `pendingPermissions` Map 设置 `session.id` → `{request, resolve}` ② UI 显示 PermissionDialog ③ 用户选择后 `resolve(result)` 被调用 ④ AgenticLoop 收到结果继续 | P0 |
| CHAT-032 | `onWriteConfirm` 回调——文件覆盖确认 | write 工具覆盖已有文件 | 触发写入 | ① `pendingWriteConfirms` Map 设置 ② UI 显示 Diff 审查 ③ 返回 `accept`/`reject`/`custom` ④ reject 时 `writeRejected=true` 停止循环 | P0 |
| CHAT-033 | `onPromptChangeSubmit` 回调——提示词变更 | Phase D prompt optimization | 触发优化 | ① `pendingPromptChangesMap` 设置 ② UI 显示变更审查 ③ 返回 `{applied, message}` | P1 |
| CHAT-034 | `onInteractiveForm` 回调——交互表单 | Phase D interactive skill | 触发表单 | ① `pendingInteractiveForms` 设置 ② UI 显示表单 ③ 返回用户填写值 | P1 |
| CHAT-035 | `onCompactionComplete` 回调——压缩完成 | 触发上下文压缩 | 压缩执行后 | ① 回调被调用 ② 可能触发 memory extraction | P1 |
| CHAT-036 | `onTurnComplete` 回调——轮次完成 | 每轮迭代结束 | 观察 | ① 回调接收 `TokenUsage` ② 可能触发 memory extraction | P1 |
| CHAT-037 | Pet 系统桥接——`usePetStore.onStreamEvent` | streaming 中 | 观察 pet | ① `tool_start`/`tool_complete`/`tool_error`/`end` 事件桥接到 pet ② `onLLMStatus` 被调用 ③ `showBubble` 在完成时触发 | P2 |
| CHAT-038 | `llm_status` 状态机——connecting→streaming→executing_tools | 正常对话流程 | 观察状态变化 | ① 初始 `connecting` ② 收到首个 token 后 `streaming` ③ 工具执行时 `executing_tools` ④ 循环正确 | P1 |
| CHAT-039 | `compaction_start`/`end` 事件——UI 反馈 | 触发压缩 | 观察 | ① `setCompactionStatus({active: true})` ② 压缩后 `{active: false, messagesRemoved: N}` ③ 3 秒后自动清除 ④ `loadMessages` 从 DB 重新加载 | P1 |
| CHAT-040 | `usage` 事件——Token 计数 | 每轮迭代 | 观察 | ① `TokenUsage` 累积到 `totalUsage` ② `prompt_tokens`/`completion_tokens` 正确 | P1 |
| CHAT-041 | `retry` 事件——重试通知 | Mock provider 首次失败 | 发送消息 | ① `retry` 事件包含 `attempt`/`delay`/`error`/`errorType` ② UI 可显示重试状态 ③ 重试成功后继续 | P1 |
| CHAT-042 | `start` 事件——迭代开始 | 每轮迭代 | 观察 | ① `event.iteration` 正确递增 ② 首轮(iteration=1)不创建新消息 ③ 后续轮创建新消息 | P1 |
| CHAT-043 | `end` 事件——循环结束 | 正常/异常/中止 | 观察 | ① `result.type` 为 `stop`/`overflow`/`aborted`/`error` ② Pet 气泡根据是否有工具调用显示不同消息 ③ overflow 不显示气泡 | P1 |
| CHAT-044 | `flushStreamBuffer` 清理——finally 块 | 循环结束/异常 | 检查 | ① 缓冲区文本刷新到 UI ② timer 清除 ③ `streamingSessionIdRef` 清空 ④ `setStreamStartTime(null)` | P1 |
| CHAT-045 | 并发会话执行——多会话同时 streaming | 会话 A 前台、会话 B 后台委派 | 同时运行 | ① A 和 B 各自独立 streaming ② `pendingPermissions` 按 sessionId 隔离 ③ 不互相阻塞 ④ 各自的 AbortController 独立 | P0 |

---

## 2. 思考过程与回答反馈

覆盖 `reasoning_delta` 事件链路、reasoning 存储、UI 渲染、模型 reasoning effort 配置。

### 2.1 思考过程流式传输（REAS-001 ~ REAS-012）

| 编号 | 用例名 | 前置条件 | 操作步骤 | 预期结果 | 优先级 |
|------|--------|---------|---------|---------|--------|
| REAS-001 | reasoning 先于 text——assistant 消息延迟创建 | LLM 先发 reasoning_delta | 发送消息 | ① reasoning 到达时 assistant 消息不存在 → `safeAddMessage` 创建空 content 消息 ② `reasoning` 字段更新 ③ `saveMessages` 持久化 | P0 |
| REAS-002 | reasoning 和 text 交替到达 | LLM 交替发送 | 发送消息 | ① `reasoningContent` 和 `assistantContent` 各自独立累积 ② 不互相覆盖 ③ 消息同时包含两个字段 | P0 |
| REAS-003 | reasoning 为空——模型不支持思考 | Mock provider 不发 reasoning_delta | 发送消息 | ① `reasoningContent` 保持空字符串 ② `reasoning` 字段为 `undefined` ③ DB 中 `reasoning` 为 null ④ UI 不显示思考区域 | P0 |
| REAS-004 | reasoning 累积——大量思考内容 | 产生 5000+ 字符 reasoning | 发送复杂任务 | ① `reasoningContent` 完整累积 ② 不截断 ③ DB 持久化完整 ④ UI 可折叠/展开 | P1 |
| REAS-005 | reasoning 跨迭代重置——iteration > 1 | 多轮工具调用 | 第二轮迭代 | ① `reasoningContent = ""` 重置 ② 前一轮 reasoning 保留在上一条消息 ③ 新消息开始新 reasoning | P0 |
| REAS-006 | reasoning 中断——用户中止 | streaming 中 | 点击停止 | ① 已有部分 reasoning 保存 ② `reasoning` 字段有部分内容 ③ 不崩溃 | P1 |
| REAS-007 | reasoning 包含代码块 | reasoning 含 ```code``` | 发送消息 | ① 代码块正确渲染 ② 不破坏 JSON 序列化 ③ DB 存储完整 | P1 |
| REAS-008 | reasoning 包含中文和 Emoji | reasoning 含 "思考🤔中文" | 发送消息 | ① 内容完整保留 ② 不乱码 ③ UI 正确渲染 | P0 |
| REAS-009 | reasoning effort 配置——low/medium/high | `config.reasoningEffort` | 发送消息 | ① `LLMRequest.reasoningEffort` 正确传递 ② 不同级别影响 LLM 行为 | P2 |
| REAS-010 | reasoning 在 fork 会话中的复制 | 有 reasoning 的会话 | fork | ① fork 后的消息保留 `reasoning` 字段 ② 内容一致 ③ 不丢失 | P1 |
| REAS-011 | reasoning 压缩后保留——compaction | 触发压缩 | 检查 | ① 压缩后的摘要消息可能不含 reasoning ② 历史消息的 reasoning 已被删除 ③ 不崩溃 | P1 |
| REAS-012 | reasoning 在 unified vs segmented 模式 | 不同显示模式 | 切换模式 | ① unified 模式折叠 reasoning 和 tool calls ② segmented 模式展开 ③ 数据一致只是展示不同 | P2 |

### 2.2 回答反馈与 UI 交互（REAS-013 ~ REAS-025）

| 编号 | 用例名 | 前置条件 | 操作步骤 | 预期结果 | 优先级 |
|------|--------|---------|---------|---------|--------|
| REAS-013 | 消息状态流转——streaming→done | 正常对话 | 观察 | ① 消息有 streaming 指示器 ② 完成后消失 ③ `status` 字段正确 | P0 |
| REAS-014 | 错误状态——status="error" | 工具执行失败 | 观察 | ① 错误消息有红色标记 ② content 包含错误信息 ③ 不影响后续消息 | P0 |
| REAS-015 | 工具调用折叠/展开 | 有工具调用的消息 | 点击折叠 | ① 默认折叠/展开行为正确 ② 展开显示参数和结果 ③ 折叠隐藏详情 | P1 |
| REAS-016 | 生成的文件列表——`generatedFiles` | write 工具产出文件 | 观察 | ① 消息底部显示文件列表 ② `generatedFilesRef` 正确追踪 ③ 完成后序列化到 DB | P1 |
| REAS-017 | Markdown 渲染——代码高亮 | LLM 返回 markdown | 观察 | ① 代码块语法高亮 ② 表格/列表渲染 ③ 链接可点击 | P1 |
| REAS-018 | 复制消息内容 | 有 assistant 消息 | 点击复制 | ① 纯文本复制到剪贴板 ② 不包含 HTML 标签 | P2 |
| REAS-018b | 消息时间戳显示 | 有历史消息 | 观察 | ① 时间格式正确 ② 按本地时区显示 | P2 |
| REAS-019 | 执行计时器——`streamStartTime` | streaming 中 | 观察 | ① 显示已用时间 ② 完成后清除 ③ 中止后清除 | P2 |
| REAS-020 | 上下文监控——`contextPressure` | 长对话 | 观察 | ① 压力条显示当前上下文使用率 ② 接近阈值时变色 ③ 触发压缩提示 | P1 |
| REAS-021 | 回答中的 system-reminder 过滤 | 工具结果含 `<system-reminder>` | 观察 | ① `resultStr.replace(/<system-reminder>.../g, "")` 过滤 ② UI 不显示 reminder 标签 | P1 |
| REAS-022 | 工具结果截断——超长结果 | 工具返回 100KB+ | 观察 | ① 结果截断显示 ② 不卡死 UI ③ 可展开查看完整 | P2 |
| REAS-023 | 多模态内容渲染——图片附件 | 消息含图片附件 | 观察 | ① 图片预览正确 ② base64/路径正确 ③ 不破坏文本渲染 | P1 |
| REAS-024 | 消息编辑/重新发送 | 有用户消息 | 编辑后重发 | ① 原消息更新 ② 重新触发 `runAgenticLoop` ③ 历史保持 | P2 |
| REAS-025 | 响应式布局——窄屏适配 | 调整窗口大小 | 观察 | ① 消息气泡自适应 ② 工具调用区域可滚动 ③ 输入框不被遮挡 | P2 |

---

## 3. 工具调用链路

覆盖 `tool_start → StreamingToolExecutor.execute → tool_complete/tool_error` 全链路，含权限、并发、超时、去重、P5 拦截。

### 3.1 工具执行基础（TOOL-001 ~ TOOL-015）

| 编号 | 用例名 | 前置条件 | 操作步骤 | 预期结果 | 优先级 |
|------|--------|---------|---------|---------|--------|
| TOOL-001 | read_file 工具——读取文件 | 工作目录有文件 | LLM 调用 read_file | ① `tool_start` 事件触发 ② `executeCommand`/`readFile` 被调用 ③ `tool_complete` 返回文件内容 ④ DB 中 tool_calls 记录正确 | P0 |
| TOOL-002 | write_file 工具——写入新文件 | 目标路径不存在 | LLM 调用 write_file | ① 文件创建 ② `generatedFilesRef` 添加路径 ③ 结果返回成功 ④ DB 记录 | P0 |
| TOOL-003 | write_file 工具——覆盖已有文件（触发 Diff） | 目标文件已存在 | LLM 调用 write_file | ① `onWriteConfirm` 回调触发 ② 显示 Diff ③ accept→写入，reject→`writeRejected=true` 停止循环 ④ custom→修改后写入 | P0 |
| TOOL-004 | edit_file 工具——精确替换 | 文件存在且含目标文本 | LLM 调用 edit_file | ① `old_string` 精确匹配 ② 替换成功 ③ 结果显示变更 ④ 不匹配时报错 | P0 |
| TOOL-005 | multi_edit_file 工具——批量编辑 | 多处需修改 | LLM 调用 multi_edit | ① 所有编辑按序应用 ② 原子性（任一失败全部回滚）③ 结果汇总 | P1 |
| TOOL-006 | bash/run_terminal_command 工具 | 命令非危险 | LLM 调用 bash | ① `executeCommand` 被调用 ② stdout/stderr 返回 ③ exitCode 正确 ④ 超时保护 | P0 |
| TOOL-007 | glob_file_search 工具 | 有文件 | LLM 调用 glob_search | ① 返回匹配文件列表 ② 按修改时间排序 ③ glob 模式正确解析 | P1 |
| TOOL-008 | grep_search 工具 | 有代码文件 | LLM 调用 grep | ① 返回匹配行 ② 支持正则 ③ `-A`/`-B`/`-C` 上下文行 ④ `output_mode` 正确 | P1 |
| TOOL-009 | web_fetch 工具 | 网络可用 | LLM 调用 web_fetch | ① URL 内容获取 ② HTML→Markdown 转换 ③ HTTPS 升级 ④ 缓存生效 | P1 |
| TOOL-010 | list_directory 工具 | 有目录 | LLM 调用 list_dir | ① 返回目录内容 ② 排除 dot-files ③ 正确处理符号链接 | P1 |
| TOOL-011 | todo_write 工具——任务管理 | 无 | LLM 调用 todo_write | ① 任务列表更新 ② 状态正确（pending/in_progress/completed）③ UI 反映变更 | P1 |
| TOOL-012 | delete_file 工具 | 文件存在 | LLM 调用 delete_file | ① 文件删除 ② 不存在时优雅失败 ③ 结果返回 | P1 |
| TOOL-013 | 工具执行超时——60s | Mock 工具永久挂起 | 触发工具 | ① 60 秒后超时 ② `tool_error` 事件 ③ 不永久阻塞循环 | P1 |
| TOOL-014 | 工具执行异常——execute 抛错 | Mock 工具 throw | 触发工具 | ① `tool_error` 事件 ② error 消息正确 ③ 循环继续（不中止）④ DB 中 status="error" | P0 |
| TOOL-015 | 工具返回敏感数据警告——F2.5 | write/bash 参数含 API key | LLM 调用 | ① `scanParametersForSecrets` 检测到 ② 返回 `[Security Warning]` 前缀 ③ 不阻止执行但警告 LLM | P1 |

### 3.2 工具并发与去重（TOOL-016 ~ TOOL-030）

| 编号 | 用例名 | 前置条件 | 操作步骤 | 预期结果 | 优先级 |
|------|--------|---------|---------|---------|--------|
| TOOL-016 | 并发安全工具——read-only 并行 | 3 个 read_file 同时调用 | LLM 一次返回多 tool_call | ① `concurrencySafeTools` 中的工具并行执行 ② 各自独立完成 ③ 结果按完成顺序返回 | P1 |
| TOOL-017 | 写工具串行——write 不并发 | 2 个 write_file 同时调用 | LLM 一次返回多 tool_call | ① write 工具串行执行 ② 不超过 `maxConcurrent` 限制 ③ 顺序执行 | P1 |
| TOOL-018 | 重复读取去重——同一文件多次 read | 同一 run 中已读 | LLM 再次调用 read_file 同一路径 | ① `readCache` 命中 ② 返回缓存内容 ③ 不重复执行 I/O | P1 |
| TOOL-019 | 重复写入去重——同内容多次 write | 同一 run 中已写同内容 | LLM 再次调用 write_file | ① `writeCache` 命中 ② 跳过写入 ③ 返回 "already written" | P1 |
| TOOL-020 | 读取后写入——缓存失效 | 先读后写同文件 | LLM 先 read 后 write | ① write 后 `readCache` 对该路径失效 ② 后续 read 重新读取 | P1 |
| TOOL-021 | FileContentCache LRU——E4 缓存 | 50 个文件 | 读取 51 个文件 | ① 最旧缓存被驱逐 ② `maxAgeMs`(60s) 过期后重新读取 ③ `invalidate(path)` 正确清除 | P2 |
| TOOL-022 | 跨迭代去重——不同迭代重复 read | 迭代 1 读了文件 A | 迭代 2 再读文件 A | ① 如果内容未变（writeCache 无变更），仍可命中 ② 如果有 write 则重新读 | P1 |
| TOOL-023 | `abortSiblingsOnError` 配置 | 配置为 true | 一个工具失败 | ① 同批次其他工具被 abort ② 如果 false 则其他继续 | P2 |
| TOOL-024 | 工具结果中的 `<system-reminder>` 过滤 | 工具结果含标签 | 处理结果 | ① `resultStr.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")` 执行 ② UI 和 DB 都过滤 | P1 |
| TOOL-025 | 工具参数中文/Emoji | path 含 "中文/🌍" | LLM 调用 | ① JSON 序列化正确 ② DB 存储完整 ③ 工具执行正确 | P0 |
| TOOL-026 | 工具 ID 唯一性 | 多个工具调用 | 检查 ID | ① 每个工具调用有唯一 `id` ② 不重复 ③ DB 中可区分 | P1 |
| TOOL-027 | `metadata` 回调——工具设置元数据 | 工具执行中 | 调用 `ctx.metadata()` | ① 元数据正确传递 ② UI 可显示 ③ 不影响执行 | P2 |
| TOOL-028 | 工具执行在 worktree 目录 | session 有 worktreePath | 工具执行 | ① `ctx.cwd` 为 worktree 路径 ② 文件操作在 worktree 中 ③ 不影响主仓库 | P0 |
| TOOL-029 | 工具执行在非 worktree 目录 | session 无 worktreePath | 工具执行 | ① `ctx.cwd` 为项目路径 ② 正常执行 | P0 |
| TOOL-030 | 工具执行上下文隔离——多会话 | 会话 A 和 B 同时执行工具 | 并行 | ① 各自的 `ToolContext.sessionId` 不同 ② `messages` 数组独立 ③ `abort` 信号独立 | P0 |

### 3.3 P5 拦截与工具特殊逻辑（TOOL-031 ~ TOOL-050）

| 编号 | 用例名 | 前置条件 | 操作步骤 | 预期结果 | 优先级 |
|------|--------|---------|---------|---------|--------|
| TOOL-031 | P5: 同响应 spawn+wait 拦截 | LLM 同一响应含 spawn_subagent + wait_for_subagent | 检查 | ① wait 调用被拒绝 ② console.warn 输出 ③ wait 调用从 currentToolCalls 中移除 ④ spawn 正常执行 | P0 |
| TOOL-032 | P5: 同响应 delegate+wait 拦截 | LLM 同一响应含 delegate_to_session + wait_for_delegation | 检查 | ① wait_for_delegation 调用被拒绝 ② 错误消息提示 "next response" ③ delegate 正常执行 | P0 |
| TOOL-033 | 跨迭代 wait 去重——同 taskId 多次 wait | 已 wait 的 taskId | 再次 wait | ① `waitedSubagents`/`waitedDelegations` 命中 ② 返回缓存结果 ③ 不重复调用 | P0 |
| TOOL-034 | 未 wait 的 subagent 提醒——spawn 后不 wait | 有 spawnedSubagents | 循环结束前 | ① 检测到 `unwaitedIds.length > 0` ② 注入 `[SYSTEM REMINDER]` 消息 ③ 不直接 stop 而是注入提醒 | P0 |
| TOOL-035 | 未 wait 的 delegation 提醒 | 有 delegatedTasks | 循环结束前 | ① 检测到 `unwaitedDelIds.length > 0` ② 注入 delegation 提醒 ③ 不直接 stop | P0 |
| TOOL-036 | spawn_subagent 结果解析——TASK_ID 提取 | spawn 返回含 `TASK_ID: xxx` | 检查 | ① `spawnedSubagents.add(taskId)` ② taskId 正确提取 ③ 后续 wait 可使用 | P1 |
| TOOL-037 | delegate_to_session 结果解析——TASK_ID | delegate 返回含 `TASK_ID: xxx` | 检查 | ① `delegatedTasks.add(taskId)` ② taskId 正确提取 | P1 |
| TOOL-038 | wait_for_subagent 结果缓存 | wait 完成 | 再次 wait 同 taskId | ① `waitedSubagents.set(taskId, output)` ② 返回缓存 ③ 不阻塞 | P1 |
| TOOL-039 | wait_for_delegation 结果缓存 | delegation 完成 | 再次 wait | ① `waitedDelegations.set(taskId, output)` ② 返回缓存 | P1 |
| TOOL-040 | 工具标题映射——tool-renderer | 各种工具名 | 检查 | ① `spawn_subagent → "Spawning sub-agent"` ② `delegate_to_session → "Delegating to session"` ③ `wait_for_delegation → "Waiting for delegation"` ④ 中英文正确 | P1 |
| TOOL-041 | load_skill 工具——首次加载 | 技能存在 | LLM 调用 load_skill | ① `SessionSkillCache.load` 返回 `cached: false` ② 技能 prompt 注入 ③ Provider 工具加载（如有）④ TTL 设为 5 | P0 |
| TOOL-042 | load_skill 工具——重复加载（缓存命中）| 技能已加载 | 再次调用 load_skill | ① 返回 `cached: true` ② TTL 刷新 ③ 不重复注入 prompt | P0 |
| TOOL-043 | load_skill TTL 过期——自动卸载 | 5 轮后 | 第 6 轮 | ① `remainingTurns` 递减到 0 ② 技能从缓存移除 ③ Provider 工具卸载 ④ prompt 移除 | P1 |
| TOOL-044 | load_skill 历史恢复——从消息历史恢复 | 重启后加载会话 | 检查 | ① 从历史消息中检测已加载技能 ② 恢复到 SessionSkillCache ③ TTL 保持 | P1 |
| TOOL-045 | web_search 工具——网络搜索 | 网络可用 | LLM 调用 web_search | ① 搜索结果返回 ② 结果格式正确 ③ 错误处理 | P2 |
| TOOL-046 | read_attachment 工具——读取附件 | 消息有附件 | LLM 调用 read_attachment | ① 附件内容返回 ② 支持 file/image/code/url 类型 ③ 超长截断 | P1 |
| TOOL-047 | search_notebook 工具——知识搜索 | 有 notebook | LLM 调用 search_notebook | ① 语义搜索执行 ② 返回相关 chunks ③ notebookId 正确传递 | P1 |
| TOOL-048 | 沙箱路径检查——S5 | 沙箱启用 | write 到工作区外 | ① `checkSandbox` 返回错误消息 ② 工具不执行 ③ 提示用户 | P0 |
| TOOL-049 | 路径解析——`resolvePath` 相对路径 | cwd 已设置 | 工具使用相对路径 | ① 相对路径正确拼接到 cwd ② 绝对路径保持不变 ③ Windows/Unix 分隔符正确 | P1 |
| TOOL-050 | 工具执行后的 `saveMessages` 即时性 | 工具完成后 | 下一轮迭代前 | ① `saveMessages(session.id)` 在 tool_complete 后立即调用 ② 下一轮 `buildMessages` 能读到最新 tool result ③ 不丢失 | P0 |

---

## 4. 子智能体调用链路

覆盖 `SubagentManager → LLMSubagentSpawner.spawn → executeTask → wait_for_subagent` 全链路。

### 4.1 子智能体生命周期（SUBA-001 ~ SUBA-015）

| 编号 | 用例名 | 前置条件 | 操作步骤 | 预期结果 | 优先级 |
|------|--------|---------|---------|---------|--------|
| SUBA-001 | spawn_subagent 基本流程 | 无活跃子智能体 | LLM 调用 spawn_subagent | ① `SubagentTask` 创建，status="pending" ② 异步 `executeTask` 启动 ③ 返回 task 对象含 id ④ `spawnedSubagents.add(taskId)` | P0 |
| SUBA-002 | 子智能体状态流转——pending→running→completed | spawn 后 | 观察 | ① `startedAt` 设置 ② status 变为 "running" ③ 完成后 status="completed" ④ `completedAt` 设置 ⑤ `result` 填充 | P0 |
| SUBA-003 | 子智能体执行——独立 agent loop | spawn | 观察 | ① 子智能体有自己的 `LLMEngine.process` 调用 ② 独立的 sessionId ③ 不污染主会话消息 ④ 有自己的 activities 列表 | P0 |
| SUBA-004 | 子智能体活动追踪——activities | spawn 后 | 观察 | ① `thinking`/`tool` 类型 activity 添加 ② `startedAt`/`completedAt` 正确 ③ status "running"→"done" | P1 |
| SUBA-005 | 子智能体取消——abort | 运行中 | abort | ① `activeTasks` 中的 AbortController abort ② status 变为 "cancelled" ③ 活动标记为 done | P1 |
| SUBA-006 | 父级 abort 传播——`parentAbortSignal` | 父会话中止 | 中止主会话 | ① 子智能体收到 abort 信号 ② 子智能体也中止 ③ 不残留 | P0 |
| SUBA-007 | 子智能体超时 | 设置 timeout | 超时后 | ① status 变为 "failed" ② error 含 timeout 信息 ③ 资源清理 | P1 |
| SUBA-008 | 子智能体失败——executeTask 抛异常 | Mock engine 失败 | 观察 | ① status="failed" ② error 字段填充 ③ `result.status="failed"` ④ 不影响主循环 | P0 |
| SUBA-009 | 子智能体持久化——persistent=true | spawn 时 persistent | 重启后 | ① DB 中保留子智能体记录 ② 可恢复状态 ③ 非 persistent 的清理 | P2 |
| SUBA-010 | 子智能体名称生成 | spawn | 检查 | ① 从 SUBAGENT_NAMES 随机选取 ② name 字段设置 ③ 人类可读 | P2 |
| SUBA-011 | 子智能体 cwd——工作目录 | spawn 时指定 cwd | 检查 | ① 子智能体在指定 cwd 执行 ② worktree 模式下使用 worktree path ③ 不写主仓库 | P0 |
| SUBA-012 | 子智能体返回——SubagentResult | 完成 | 检查 result | ① `status` 为 success/partial/failed/blocked ② `summary` 非空 ③ `output` 含详细内容 ④ `filesTouched` 列表 ⑤ `findings` 列表 | P1 |
| SUBA-013 | 多子智能体并发 | 同时 spawn 多个 | 检查 | ① 每个有独立 id ② 各自独立执行 ③ `activeTasks` Map 正确管理 ④ 不互相干扰 | P1 |
| SUBA-014 | 子智能体事件——ProcessorEvent | 执行中 | 观察 | ① `thinking` 事件产生 activity ② `tool` 事件产生 activity ③ 事件正确映射 | P2 |
| SUBA-015 | 子智能体 cleanup——会话删除 | 删除有子智能体的会话 | 删除 | ① `engine.cleanupSessionLoop(sessionId)` 调用 ② 子智能体 abort ③ 资源释放 | P1 |

### 4.2 wait_for_subagent 与结果回收（SUBA-016 ~ SUBA-030）

| 编号 | 用例名 | 前置条件 | 操作步骤 | 预期结果 | 优先级 |
|------|--------|---------|---------|---------|--------|
| SUBA-016 | wait_for_subagent 基本流程 | 有 completed 子智能体 | LLM 调用 wait_for_subagent | ① 返回 `SubagentResult.output` ② `waitedSubagents.set(taskId, output)` ③ `spawnedSubagents.delete(taskId)` | P0 |
| SUBA-017 | wait_for_subagent 阻塞——子智能体未完成 | 子智能体 running 中 | wait | ① 阻塞等待完成 ② 完成后返回结果 ③ 不超时（或合理超时）| P0 |
| SUBA-018 | wait_for_subagent 不存在的 taskId | taskId 无效 | wait | ① 返回错误消息 "not found" ② 不崩溃 ③ 循环继续 | P1 |
| SUBA-019 | wait_for_subagent 重复 wait——同 taskId | 已 wait 过 | 再次 wait | ① `waitedSubagents` 命中 ② 返回缓存结果 ③ 不重复阻塞 | P0 |
| SUBA-020 | wait_for_subagent 跨迭代去重 | 迭代 1 已 wait | 迭代 2 再 wait | ① 检测到已 waited ② 返回缓存 ③ 不重复 | P0 |
| SUBA-021 | 多个子智能体——部分 wait | spawn 3 个，wait 2 个 | 观察 | ① 2 个正确返回 ② 1 个未 wait → 触发提醒注入 ③ `unwaitedIds` 包含第 3 个 | P0 |
| SUBA-022 | 子智能体结果中的 filesTouched | 子智能体修改了文件 | 检查 | ① `filesTouched` 列表正确 ② 路径在 worktree 范围内 ③ 不含主仓库文件 | P1 |
| SUBA-023 | 子智能体结果格式——output 传递给主 LLM | wait 完成 | 检查 | ① output 作为 tool result 返回 ② 主 LLM 在下一轮看到 ③ 格式可读 | P0 |
| SUBA-024 | 子智能体中再 spawn——嵌套 | 子智能体内调用 spawn | 观察 | ① 子智能体可以有自己的子智能体 ② 层级正确 ③ 不死循环 | P2 |
| SUBA-025 | 子智能体与 worktree 隔离 | worktree 模式 | spawn | ① 子智能体在 session 的 worktree 中执行 ② 不跨 worktree ③ 文件隔离 | P0 |
| SUBA-026 | 子智能体 abort 后 wait | 子智能体被 cancel | wait | ① 返回 cancelled 状态 ② result.status 为 failed ③ error 含 cancelled | P1 |
| SUBA-027 | 子智能体工具标签——`getToolLabel` | 子智能体内调用工具 | 检查 activity | ① tool name 正确映射为中文/英文标签 ② activity label 正确 | P2 |
| SUBA-028 | 子智能体与主循环并行 | spawn 后主循环继续 | 观察 | ① 主循环不阻塞 ② 子智能体后台执行 ③ wait 时才阻塞 | P0 |
| SUBA-029 | 子智能体数量上限 | 无 | 检查 | ① 有合理的并发上限 ② 超限时报错 ③ 不无限 spawn | P2 |
| SUBA-030 | 子智能体完成通知 | 子智能体完成 | 观察 | ① SubagentManager 通知监听器 ② UI 更新状态 ③ 可 wait | P1 |

---

## 5. 技能调用链路

覆盖 `SkillRegistry → SkillToolRegistry → load_skill → SessionSkillCache → Provider` 全链路。

### 5.1 技能加载与注册（SKIL-001 ~ SKIL-010）

| 编号 | 用例名 | 前置条件 | 操作步骤 | 预期结果 | 优先级 |
|------|--------|---------|---------|---------|--------|
| SKIL-001 | 内置技能加载——builtin | 启动时 | 检查 SkillRegistry | ① 内置技能（prompt-optimization, interactive 等）注册 ② `source="builtin"` ③ `filePath` 正确 ④ prompt 非空 | P0 |
| SKIL-002 | 项目技能加载——project `.claude/skills/` | 项目有技能目录 | 检查 | ① `.claude/skills/*/SKILL.md` 被扫描 ② `source="project"` ③ `parseSkillMarkdown` 正确解析 | P0 |
| SKIL-003 | 用户技能加载——user | 用户目录有技能 | 检查 | ① `source="user"` ② 正确加载 ③ 与内置不冲突 | P1 |
| SKIL-004 | 技能 SKILL.md 解析——parseSkillMarkdown | 有 SKILL.md 文件 | 解析 | ① name/description/prompt 正确 ② aliases/whenToUse 可选字段 ③ `contextMode` 默认 "inline" ④ B1 扩展字段（displayName/version/tags）正确 | P0 |
| SKIL-005 | 技能禁用——disabled skills | 设置 `codem-disabled-skills` | 检查 | ① 禁用的技能不出现在 prompt 中 ② `buildSkillPrompt` 过滤 ③ 可重新启用 | P1 |
| SKIL-006 | 技能 Provider 注册——SkillToolRegistry | 技能有 provider 配置 | 加载 | ① `SkillProviderConfig.module` 动态导入 ② `exportName` 实例化 ③ 工具注册到 ToolRegistry | P1 |
| SKIL-007 | 技能 MCP 服务器——SkillMcpServerDeclaration | 技能声明 MCP | 加载 | ① MCP 服务器连接 ② 工具可用 ③ transport 正确（stdio/http/sse）| P2 |
| SKIL-008 | 技能 allowedTools 限制 | 技能定义 allowedTools | 加载 | ① 只允许列出的工具 ② 空列表=全部允许 ③ 非法工具名忽略 | P1 |
| SKIL-009 | 技能冲突——同名技能 | 多来源同名 | 检查 | ① 优先级：project > user > builtin ② 不重复注册 ③ 日志提示 | P1 |
| SKIL-010 | 技能安装——installer.ts | 从技能市场安装 | 安装 | ① 文件下载到正确目录 ② SKILL.md 解析 ③ 注册到 Registry ④ 可立即使用 | P2 |

### 5.2 技能执行与卸载（SKIL-011 ~ SKIL-025）

| 编号 | 用例名 | 前置条件 | 操作步骤 | 预期结果 | 优先级 |
|------|--------|---------|---------|---------|--------|
| SKIL-011 | load_skill 首次加载——prompt 注入 | 技能存在 | LLM 调用 load_skill | ① `SessionSkillCache.load` 返回 `cached: false` ② 技能 prompt 注入到 system prompt ③ 返回 "loaded successfully" ④ TTL=5 | P0 |
| SKIL-012 | load_skill 缓存命中——重复加载 | 技能已加载 | 再次 load_skill | ① 返回 `cached: true` ② "already loaded" 消息 ③ TTL 刷新 ④ 不重复注入 | P0 |
| SKIL-013 | 技能 TTL 递减——每轮递减 | 技能已加载 | 每轮迭代 | ① `remainingTurns` 从 5 递减 ② 到 0 时自动卸载 ③ prompt 移除 ④ Provider 工具卸载 | P1 |
| SKIL-014 | 技能 TTL 刷新——重新 load | TTL=2 时 | 再次 load_skill | ① TTL 重置为 5 ② 继续保持 ③ 不卸载 | P1 |
| SKIL-015 | 技能卸载——TTL 到 0 | TTL=1 | 下一轮 | ① 技能从 SessionSkillCache 移除 ② prompt 从 system prompt 移除 ③ Provider 工具从 ToolRegistry 移除 | P1 |
| SKIL-016 | 技能历史恢复——从聊天历史 | 重启后加载会话 | 检查 | ① 扫描历史消息中的 load_skill 调用 ② 恢复已加载技能 ③ TTL 保持合理 | P1 |
| SKIL-017 | 用户选择技能——`userSelectedSkills` | UI 选择技能 | 发送消息 | ① 技能 prompt 带 🎯 标记注入 ② `selectedSkills` 传递到 LoopConfig ③ 不受 TTL 影响 | P1 |
| SKIL-018 | 技能 contextMode=fork | 技能定义 fork 模式 | 加载 | ① 技能在独立会话执行 ② 不注入主会话 ③ 结果回传 | P2 |
| SKIL-019 | 技能 contextMode=inline | 技能定义 inline 模式 | 加载 | ① 技能 prompt 注入主会话 ② 工具在主会话可用 ③ 直接执行 | P1 |
| SKIL-020 | 技能模型覆盖——model/temperature | 技能定义 model | 加载 | ① 子智能体使用指定模型 ② temperature 覆盖 ③ maxSteps 覆盖 | P2 |
| SKIL-021 | 技能与 worktree——worktree 模式下加载 | session 有 worktree | load_skill | ① 技能在 worktree 中执行 ② Provider 工具的 cwd 为 worktree ③ 不写主仓库 | P0 |
| SKIL-022 | 技能 prompt 中的 references——引用文件 | 技能有 references | 加载 | ① 引用文件内容注入 ② 路径正确解析 ③ 超长截断 | P2 |
| SKIL-023 | 技能 trigger 机制——whenToUse 自动检测 | 技能有 whenToUse | 发送匹配消息 | ① `buildSkillPrompt` 包含 whenToUse 提示 ② LLM 可自动 load ③ 非强制 | P1 |
| SKIL-024 | 技能 buildSkillPrompt 禁用过滤 | 有禁用技能 | 构建 prompt | ① 禁用技能不出现在 prompt ② 可用技能正确列出 ③ 格式正确 | P1 |
| SKIL-025 | 技能图标映射——icon-map.ts | 各种技能 | 检查 | ① 每个技能有对应图标 ② 内置技能有专用图标 ③ fallback 图标存在 | P2 |

---

## 6. Git Worktree 环境

覆盖 `WorktreeManager → createWorktree → removeWorktree → scanWorktrees → enforceMaxWorktrees` 全链路，以及与对话、工具调用、子智能体的交互影响。

### 6.1 Worktree 创建与生命周期（WTR-001 ~ WTR-012）

| 编号 | 用例名 | 前置条件 | 操作步骤 | 预期结果 | 优先级 |
|------|--------|---------|---------|---------|--------|
| WTR-001 | 创建 worktree——基本流程 | 项目为 git 仓库 | `createWorktree(projectPath, sessionId)` | ① 路径 `{projectPath}/.codem-worktrees/{sessionId}/` 创建 ② `git worktree add --detach` 执行 ③ 返回 worktreePath ④ 是 git 仓库 | P0 |
| WTR-002 | 创建 worktree——指定分支 | 项目有分支 `feature-x` | `createWorktree(path, sid, "feature-x")` | ① `git worktree add --detach 'path' 'feature-x'` ② checkout 到指定分支 ③ 路径正确 | P0 |
| WTR-003 | worktree 已存在——复用 | 路径已存在且是 worktree | 再次 createWorktree | ① `exists()` 返回 true ② `isGitRepo()` 返回 true ③ 有 branch 时 `checkout --force --detach` ④ 返回同一路径 | P1 |
| WTR-004 | worktree 已存在——非 worktree | 路径存在但非 git | createWorktree | ① 抛出 `Target exists and is not a git worktree` ② 不覆盖 | P0 |
| WTR-005 | 移除 worktree——正常 | worktree 存在 | `removeWorktree(sourcePath, worktreePath)` | ① `git worktree remove --force` 执行 ② 失败时 PowerShell `Remove-Item -Recurse -Force` ③ 目录消失 | P0 |
| WTR-006 | 移除 worktree——有未提交更改 | worktree 有修改 | removeWorktree | ① `--force` 强制移除 ② 不报错 ③ 目录清理 | P1 |
| WTR-007 | 扫描 worktree——scanWorktrees | 有多个 worktree | 调用 | ① `Get-ChildItem -Directory` 列出目录 ② 每个 dir 检查 `isGitRepo` ③ 返回 `WorktreeInfo[]` 含 branch/createdAt/hasUncommitted | P1 |
| WTR-008 | worktree 路径计算——getWorktreeRoot | 不同平台 | 调用 | ① Windows: `{path}\.codem-worktrees` ② Unix: `{path}/.codem-worktrees` ③ 路径分隔符正确 | P1 |
| WTR-009 | PowerShell 路径转义——psQuote | 路径含单引号 | `psQuote("it's")` | ① 返回 `it''s` ② PowerShell 单引号正确转义 ③ 不注入 | P0 |
| WTR-010 | 路径规范化——normalizePath | 混合分隔符 | 调用 | ① `\\` → `/` ② 尾部 `/` 去除 ③ 一致性 | P2 |
| WTR-011 | 非 git 仓库——isGitRepo 返回 false | 普通目录 | 调用 | ① `git rev-parse --is-inside-work-tree` 失败 ② 返回 false ③ 不抛异常 | P0 |
| WTR-012 | 获取当前分支——getCurrentBranch | 在 worktree 中 | 调用 | ① `git branch --show-current` 返回分支名 ② detached HEAD 返回 `(short-hash)` ③ 失败返回 "unknown" | P1 |

### 6.2 Worktree 配额与清理（WTR-013 ~ WTR-020）

| 编号 | 用例名 | 前置条件 | 操作步骤 | 预期结果 | 优先级 |
|------|--------|---------|---------|---------|--------|
| WTR-013 | 最大 worktree 限制——enforceMaxWorktrees | 超过 maxWorktrees(15) | 创建新 worktree | ① 清理最旧的 worktree ② `activeSessionIds` 中的跳过 ③ `warnOnDirty` 时跳过有未提交的 ④ 返回清理数量 | P0 |
| WTR-014 | LRU 清理顺序 | 多个 worktree | enforce | ① 按 `createdAt` 升序（最旧先清）② 活跃会话跳过 ③ 脏 worktree 跳过（如配置） | P1 |
| WTR-015 | worktree 设置——getWorktreeSettings | 无设置 | 调用 | ① 返回默认值 `{maxWorktrees: 15, autoCleanOldest: true, warnOnDirty: true}` ② 合并用户设置 | P1 |
| WTR-016 | worktree 设置更新——setWorktreeSettings | 修改设置 | 调用 | ① `setSettingJSON` 保存 ② `window.dispatchEvent` 触发事件 ③ UI 可监听 | P2 |
| WTR-017 | autoCleanOldest=false | 配置关闭 | enforce | ① 不清理 ② 返回 0 ③ 即使超限也不清 | P1 |
| WTR-018 | worktree 计数——getWorktreeCount | 有 N 个 worktree | 调用 | ① 返回正确数量 ② scanWorktrees 后 count | P2 |
| WTR-019 | 未提交检测——hasUncommittedChanges | worktree 有修改 | 调用 | ① `git status --porcelain` ② 有输出返回 true ③ 无输出返回 false | P1 |
| WTR-020 | 列出分支——listBranches | 有多分支 | 调用 | ① `git branch --format=%(refname:short)` ② 返回分支名数组 ③ 过滤空行 | P2 |

### 6.3 Worktree 与执行模式集成（WTR-021 ~ WTR-035）

| 编号 | 用例名 | 前置条件 | 操作步骤 | 预期结果 | 优先级 |
|------|--------|---------|---------|---------|--------|
| WTR-021 | 执行模式存储——getProjectExecutionMode | 无设置 | 调用 | ① 默认返回 `"current_workspace"` ② 按 projectPath 隔离 ③ `codem-project-execution-modes` JSON | P0 |
| WTR-022 | 执行模式设置——setProjectExecutionMode | 设置 `"git_worktree"` | 调用 | ① JSON 更新 ② 按 path 存储不同模式 ③ 不影响其他项目 | P0 |
| WTR-023 | 会话继承执行模式——createSession | 项目设为 worktree | 新建会话 | ① `session.executionMode = getProjectExecutionMode(path)` ② 新会话继承 ③ 持久化到 session | P0 |
| WTR-024 | 会话 worktree 延迟创建——首次发消息时 | session.executionMode="git_worktree" 但无 worktreePath | `runAgenticLoop` | ① `createWorktree` 被调用 ② `worktreePath` 持久化到 session ③ cwd 设为 worktreePath ④ 成功 toast 显示 | P0 |
| WTR-025 | worktree 创建失败——回退到项目目录 | 非 git 仓库 | 发消息 | ① catch 块捕获 ② `console.error` 输出 ③ 添加 `❌ Worktree creation failed` 消息 ④ cwd 回退到 projectPath ⑤ 不崩溃 | P0 |
| WTR-026 | worktree 路径作为 cwd——工具执行 | session 有 worktreePath | 工具调用 | ① `ctx.cwd` = worktreePath ② 文件操作在 worktree 中 ③ `executeCommand` 的 cwd 为 worktree ④ 不写主仓库 | P0 |
| WTR-027 | worktree 中子智能体执行 | worktree 模式 | spawn_subagent | ① 子智能体 cwd = worktreePath ② 在 worktree 中操作 ③ 结果中 filesTouched 在 worktree 范围 | P0 |
| WTR-028 | worktree 中技能执行 | worktree 模式 | load_skill | ① 技能 Provider 工具 cwd = worktree ② 不写主仓库 ③ 正常执行 | P0 |
| WTR-029 | fork 会话创建 worktree | worktree 模式 | forkSession | ① `createWorktreeSync` 调用 ② 新会话有独立 worktreePath ③ 与源会话隔离 ④ 失败时回退到 current_workspace | P1 |
| WTR-030 | 删除会话清理 worktree | session 有 worktreePath | deleteSession | ① `removeWorktreeSync` 调用 ② worktree 目录删除 ③ 不影响其他会话的 worktree | P0 |
| WTR-031 | 切换会话——worktree 隔离 | 会话 A 和 B 各有 worktree | A→B | ① B 的工具在 B 的 worktree 执行 ② A 的 worktree 不受影响 ③ 无交叉污染 | P0 |
| WTR-032 | worktree 中环境脚本执行 | 有环境配置 | worktree 中执行 | ① setup/cleanup 脚本在 worktree cwd 执行 ② 不污染主仓库 ③ 路径正确 | P1 |
| WTR-033 | worktree 分支切换 | session 有 worktreeBranch | 创建 worktree | ① `checkout --force --detach 'branch'` ② 正确切换 ③ 不影响主仓库分支 | P1 |
| WTR-034 | worktree 与 GitConfig 集成 | 有 GitConfig 设置 | worktree 中 | ① system prompt 中 gitConfig 正确注入 ② worktree 中 git 操作遵守配置 ③ 不冲突 | P1 |
| WTR-035 | worktree 与跨会话委派 | 两个 worktree 会话 | delegation | ① 委派消息正确传递 ② 目标会话在自己的 worktree 执行 ③ 结果回传 ④ 不跨 worktree 写文件 | P1 |

---

## 7. 跨会话委派

覆盖 `DelegationOrchestrator → SessionMessageBus → executeSessionTurn → delegation tools` 全链路。

### 7.1 委派编排（DELE-001 ~ DELE-012）

| 编号 | 用例名 | 前置条件 | 操作步骤 | 预期结果 | 优先级 |
|------|--------|---------|---------|---------|--------|
| DELE-001 | 发起委派——基本流程 | 有会话 A 和 B | `orchestrator.delegate({source: A, target: B, task, projectId})` | ① `DelegationTask` 创建，status="pending" ② DB 持久化 ③ `SessionMessageBus.send(B, {type: "delegation", task})` ④ 返回 task 对象 | P0 |
| DELE-002 | 死锁检测——循环委派 A→B→A | A 已委派给 B | B 尝试委派给 A | ① `wouldCreateCycle` 返回 true ② 抛出 `Delegation cycle detected` 错误 ③ 不创建任务 | P0 |
| DELE-003 | 死锁检测——间接循环 A→B→C→A | A→B, B→C | C 尝试委派给 A | ① DFS 遍历依赖图 ② 检测到 C→A 形成环 ③ 拒绝 | P0 |
| DELE-004 | 深度限制——maxDepth=2 | A→B→C (depth=2) | C 尝试委派给 D | ① `getDepth(C)` 返回 2 ② 2 >= maxDepth(2) ③ 拒绝并报错 | P0 |
| DELE-005 | 并发限制——maxConcurrent=5 | 已有 5 个 running | 第 6 个委派 | ① `getRunningTasks().length >= 5` ② 拒绝 ③ 报错 "Maximum concurrent" | P1 |
| DELE-006 | 委派给自己——拒绝 | 无 | A 委派给 A | ① `sourceSessionId === targetSessionId` ② 抛出 "Cannot delegate to the same session" | P0 |
| DELE-007 | 委派状态流转——pending→running→completed | 委派创建后 | 目标会话执行 | ① autoStart=true 时触发执行 ② status="running" ③ 完成后 "completed" ④ `result` 填充 | P0 |
| DELE-008 | 委派失败——target 执行错误 | 目标会话失败 | 观察 | ① status="failed" ② `error` 填充 ③ 通知源会话 ④ 源会话 wait 时得到错误 | P0 |
| DELE-009 | 委派取消——cancel | 运行中 | cancel | ① status="cancelled" ② `SessionMessageBus.send({type: "cancel"})` ③ 目标会话 abort ④ 资源清理 | P1 |
| DELE-010 | 委派任务 DB 持久化 | 创建任务 | 检查 DB | ① `delegation_tasks` 表有行 ② 字段完整（source/target/task/status/projectId）③ 重启后 `restoreFromDB` 恢复 | P0 |
| DELE-011 | 委派监听器——listener 通知 | 注册监听器 | 状态变更 | ① `DelegationListener` 被调用 ② 接收最新 task ③ 可用于 UI 更新 | P1 |
| DELE-012 | 清理已完成——clearCompletedDelegations | 有已完成任务 | 调用 | ① completed/failed/cancelled 的任务从内存清理 ② DB 中可选择保留 ③ 不影响 running | P2 |

### 7.2 委派工具与后台执行（DELE-013 ~ DELE-025）

| 编号 | 用例名 | 前置条件 | 操作步骤 | 预期结果 | 优先级 |
|------|--------|---------|---------|---------|--------|
| DELE-013 | `delegate_to_session` 工具 | 有可用会话 | LLM 调用 | ① 返回 `TASK_ID: xxx` ② `delegatedTasks.add(taskId)` ③ 目标会话后台启动 ④ 消息提示用 wait_for_delegation | P0 |
| DELE-014 | `wait_for_delegation` 工具 | 有 pending/running 委派 | LLM 调用 | ① 阻塞等待完成 ② 返回 result ③ `waitedDelegations.set(taskId, output)` ④ `delegatedTasks.delete(taskId)` | P0 |
| DELE-015 | `wait_for_delegation` 缓存命中 | 已 wait 过 | 再次 wait | ① `waitedDelegations` 命中 ② 返回缓存 ③ 不阻塞 | P0 |
| DELE-016 | `query_session_result` 工具 | 目标会话有输出 | LLM 调用 | ① 返回目标会话最新 assistant 消息 ② 不阻塞 ③ 不创建委派 | P1 |
| DELE-017 | `list_sessions` 工具 | 有多个会话 | LLM 调用 | ① 返回当前项目所有会话列表 ② 含 id/title ③ 不含其他项目 ④ 可用于选择 target | P1 |
| DELE-018 | `executeSessionTurn` 后台执行 | 收到 delegation 消息 | App.tsx useEffect 触发 | ① `engine.process()` 调用 ② 消息写入 DB ③ `SessionMessageBus` 广播状态 ④ 完成后通知 orchestrator | P0 |
| DELE-019 | `executeSessionTurn` 防重复 | 同一 session 已在执行 | 再次触发 | ① `activeExecutions.has(sessionId)` 返回 true ② 返回错误 "already executing" ③ 不重复执行 | P0 |
| DELE-020 | `executeSessionTurn` 权限处理 | 后台执行需权限 | 权限请求 | ① `onPermissionRequest` 回调 ② `bus.send({type: "status", detail: "permission_required"})` ③ UI 显示权限对话框 ④ 可 resolve | P0 |
| DELE-021 | `executeSessionTurn` abort | 外部 abort | abort | ① `abort.abort()` ② `activeExecutions.delete(sessionId)` ③ `setSessionActive(false)` ④ 通知 orchestrator | P1 |
| DELE-022 | `SessionMessageBus` 消息分发 | 有监听器 | send | ① 目标会话监听器收到 ② 全局监听器收到 ③ 消息历史记录（最近 100 条）④ 错误隔离（一个 listener 出错不影响其他）| P1 |
| DELE-023 | `SessionMessageBus` 历史回放 | 新订阅者 | subscribe | ① 可获取历史消息 ② 不超过 100 条 ③ 按时间序 | P2 |
| DELE-024 | 跨项目隔离 | 不同项目的会话 | delegation | ① 只能委派同项目的会话 ② projectId 隔离 ③ `list_sessions` 只返回同项目 | P1 |
| DELE-025 | 委派与 worktree 集成 | 两个 worktree 会话 | delegation | ① 源和目标各自在 worktree 执行 ② `executeSessionTurn` 的 cwd 为各自 worktree ③ 不跨 worktree 写 | P1 |

---

## 8. 上下文压缩与记忆系统

覆盖 `ContextManager → compactMessages → MemoryService → 级联压缩` 全链路。

| 编号 | 用例名 | 前置条件 | 操作步骤 | 预期结果 | 优先级 |
|------|--------|---------|---------|---------|--------|
| CTXT-001 | 主动压缩——contextPressure > 0.8 | 长对话 | 触发压缩 | ① `compaction_start` 事件 ② `compactMessages` 执行 ③ `compaction_end` 事件含 messagesRemoved ④ `loadMessages` 重新加载 | P0 |
| CTXT-002 | 反应式压缩——enableReactiveCompaction | API 返回 context overflow | 观察 | ① 检测到 overflow ② 触发压缩 ③ 重试 ④ 不无限循环（maxConsecutiveCompactions=3）| P0 |
| CTXT-003 | 级联压缩——summary of summaries | 已有压缩标记 | 再次压缩 | ① 检测到旧 compaction marker ② 旧摘要作为上下文 ③ 新摘要包含旧摘要信息 ④ 不丢失前序摘要 | P0 |
| CTXT-004 | LLM 摘要生成——`generateSummary` | 触发压缩 | 调用 | ① 使用 "compaction" slot 的 provider ② temperature=0.3 ③ 生成结构化摘要 ④ 失败时 fallback 到片段截取 | P1 |
| CTXT-005 | fallback 摘要——片段截取 | LLM 摘要失败 | 调用 | ① 用户消息截取前 100 字 ② AI 回复截取前 100 字 ③ 工具调用记录名称 ④ 生成 `[上下文已自动压缩]` 标记 | P1 |
| CTXT-006 | 压缩后消息重建——buildMessages | 压缩后 | 下一轮 | ① 消息数减少 ② `msgCache` 失效（rawCount 变化）③ 完整重建 ④ 包含压缩标记 | P0 |
| CTXT-007 | 增量消息缓存——msgCache | 同一会话连续迭代 | 第二轮 | ① `rawCount`/`rawLastID` 匹配 → 增量更新 ② 不全量重建 ③ 性能提升 | P1 |
| CTXT-008 | msgCache 失效——会话切换 | 切换会话 | 切回 | ① `sessionId` 变化 → 全量重建 ② 不使用旧缓存 ③ 正确加载 | P1 |
| CTXT-009 | msgCache 失效——压缩后 | 压缩发生 | 下一轮 | ① `rawCount` 减少 → 全量重建 ② 不使用旧缓存 ③ 正确反映压缩后状态 | P0 |
| CTXT-010 | 记忆提取——onCompactionComplete | 压缩完成 | 回调 | ① `MemoryService` 可能触发提取 ② 从压缩的消息中提取记忆 ③ `memoryEnabled` 控制是否启用 | P1 |
| CTXT-011 | 记忆提取——onTurnComplete | 每轮完成 | 回调 | ① 接收 `TokenUsage` ② 可能触发记忆提取 ③ 不阻塞主循环 | P1 |
| CTXT-012 | 记忆脱敏——F2.1 | 记忆含 API key | 提取时 | ① `SECRET_REDACT_PATTERNS` 匹配 ② 替换为 `[REDACTED_XXX]` ③ 不存储明文密钥 | P0 |
| CTXT-013 | 记忆注入 system prompt | 有记忆 | 构建 prompt | ① 记忆内容出现在 system prompt ② 按 scope 分区 ③ 不超长 | P1 |
| CTXT-014 | AGENTS.md 分层发现 | 项目有 AGENTS.md | 加载 | ① 项目根 AGENTS.md ② 子目录 AGENTS.md ③ 分层合并 ④ 不重复 | P1 |
| CTXT-015 | 压缩与工具调用结果——保留 | 有工具调用的消息被压缩 | 压缩 | ① 工具调用摘要保留 ② 关键结果不丢失 ③ 压缩标记包含工具信息 | P1 |
| CTXT-016 | 压缩与 reasoning——处理 | 有 reasoning 的消息被压缩 | 压缩 | ① reasoning 可能被丢弃 ② 正文保留 ③ 不崩溃 | P2 |
| CTXT-017 | 上下文监控——ContextMonitor | 长对话 | 观察 UI | ① 压力条显示 ② 接近阈值提示 ③ 可手动触发压缩 | P2 |
| CTXT-018 | 压缩与 worktree——cwd 一致性 | worktree 模式 | 压缩 | ① 压缩不改变 cwd ② worktree 路径保持 ③ 不影响隔离 | P1 |
| CTXT-019 | 压缩后技能 prompt 恢复 | 有已加载技能 | 压缩后 | ① `injectSkillPrompts` 重新注入 ② 技能 prompt 在压缩后恢复 ③ TTL 保持 | P1 |
| CTXT-020 | 成本降级——E8 costTracker | 接近成本上限 | 观察 | ① `costWarningThreshold`(0.8) 时切换到 compaction slot 的 cheaper model ② `costStopThreshold`(1.0) 时停止循环 ③ `costDegraded` 标记 | P2 |

---

## 9. 权限/安全模式/沙箱

覆盖 `SecurityMode → PermissionManager → evaluateWithSecurityMode → checkSandbox → ProtectedPaths` 全链路。

### 9.1 三级安全策略（SECU-001 ~ SECU-010）

| 编号 | 用例名 | 前置条件 | 操作步骤 | 预期结果 | 优先级 |
|------|--------|---------|---------|---------|--------|
| SECU-001 | ask 模式——所有操作需确认 | `securityMode="ask"` | 工具调用 | ① `shouldCheckPermissions` 返回 true ② `onPermissionRequest` 触发 ③ UI 显示权限对话框 ④ 用户必须选择 | P0 |
| SECU-002 | auto 模式——安全操作自动批准 | `securityMode="auto"` | read-only 工具 | ① `isAutoApprovable` 返回 true ② 不弹权限对话框 ③ 自动执行 ④ 危险命令仍需确认 | P0 |
| SECU-003 | auto 模式——危险命令仍确认 | `securityMode="auto"` | `rm -rf` 命令 | ① `isAutoApprovable` 检测危险模式 ② 返回 false ③ 仍弹权限对话框 | P0 |
| SECU-004 | full 模式——不弹任何确认 | `securityMode="full"` | 任何工具 | ① `shouldCheckPermissions` 返回 false ② 不弹对话框 ③ 直接执行 ④ write 工具跳过 Diff | P0 |
| SECU-005 | 优先级——project > global > default | 项目设 auto，全局设 ask | 调用 | ① `getEffectiveSecurityMode` 返回 "auto" ② 项目级覆盖全局 | P0 |
| SECU-006 | 项目级 null——回退全局 | 项目设 null | 调用 | ① 回退到全局模式 ② 不报错 | P1 |
| SECU-007 | 无效值回退——默认 ask | 设置无效值 | 调用 | ① 回退到 "ask" ② 不崩溃 | P1 |
| SECU-008 | `evaluateWithSecurityMode`——组合 | 三模式 × 三基础评估 | 调用 | ① ask × (allow/ask/deny) → ask ② auto × allow → allow ③ auto × ask → ask (if not autoApprovable) ④ full × * → allow | P0 |
| SECU-009 | write 工具 Diff 弹窗——ask 模式 | ask 模式 | write 覆盖 | ① `shouldShowWriteConfirm` 返回 true ② `onWriteConfirm` 触发 ③ 显示 Diff | P0 |
| SECU-010 | write 工具跳过 Diff——full 模式 | full 模式 | write 覆盖 | ① `shouldShowWriteConfirm` 返回 false ② 不弹 Diff ③ 直接写入 | P0 |

### 9.2 权限管理与沙箱（SECU-011 ~ SECU-025）

| 编号 | 用例名 | 前置条件 | 操作步骤 | 预期结果 | 优先级 |
|------|--------|---------|---------|---------|--------|
| SECU-011 | PermissionManager——无超时 | 等待用户决策 | 观察 | ① 无 5 分钟超时 ② 可无限等待 ③ 用户手动 resolve | P0 |
| SECU-012 | 权限 resolve——allow/deny | 权限请求 | 用户选择 | ① allow → 工具执行 ② deny → 工具跳过 ③ 结果正确传递 | P0 |
| SECU-013 | 多会话权限——并行 | 会话 A 和 B 同时请求 | 并行 | ① `pendingPermissions` Map 按 sessionId 隔离 ② 各自独立 resolve ③ 不交叉 | P0 |
| SECU-014 | 沙箱启用——write 到工作区外 | `codem-sandbox-enabled=true` | write 到 `/etc/passwd` | ① `checkSandbox` 返回错误 ② 工具不执行 ③ 提示 "outside the workspace" | P0 |
| SECU-015 | 沙箱禁用——可写任意路径 | `codem-sandbox-enabled=false` | write 到外部 | ① `checkSandbox` 返回 null ② 正常执行 ③ 无限制 | P0 |
| SECU-016 | 沙箱路径解析——相对路径 | 沙箱启用 | write 相对路径 | ① `resolvePath` 拼接到 cwd ② 在 worktree 模式下拼接 worktreePath ③ 正确判断是否在工作区内 | P1 |
| SECU-017 | 沙箱与 worktree——cwd 为 worktree | worktree 模式 | write | ① `ctx.cwd` = worktreePath ② 沙箱以 worktreePath 为边界 ③ 不允许写 worktree 外 | P0 |
| SECU-018 | 自定义权限规则——PermissionRule | 有自定义规则 | 工具调用 | ① 规则匹配工具名/路径 ② 按规则 allow/deny/ask ③ 优先级正确 | P1 |
| SECU-019 | Agent 权限评估——`evaluatePermission` | Agent 定义 permissions | 工具调用 | ① `getAgentRegistry().evaluatePermission()` 被调用 ② 返回 allow/ask/deny ③ 与 SecurityMode 组合 | P1 |
| SECU-020 | 权限拒绝后循环行为 | deny | 工具被拒 | ① 工具跳过 ② LLM 收到 "Permission denied" ③ 循环继续（非致命）④ `writeRejected` 仅对 write Diff reject | P0 |
| SECU-021 | `writeRejected` 停止循环 | write Diff reject | 用户 reject | ① `state.writeRejected = true` ② 循环停止 ③ 防止 LLM 重试 | P0 |
| SECU-022 | 后台执行权限——delegation | 后台委派需权限 | 请求 | ① `bus.send({type: "status", detail: "permission_required"})` ② UI 显示 ③ 可 resolve ④ 不阻塞总线 | P1 |
| SECU-023 | 安全模式切换实时生效 | 循环进行中 | 切换模式 | ① 下一轮迭代使用新模式 ② 不重启循环 ③ 立即生效 | P1 |
| SECU-024 | SQL 注入防护——工具参数 | 参数含 SQL 注入 | 工具调用 | ① 参数化查询 ② 不拼接 SQL ③ DB 操作安全 | P0 |
| SECU-025 | 受保护路径——Protected Paths | 配置保护路径 | write 到保护路径 | ① 即使 full 模式也拒绝 ② 提示路径受保护 ③ 不写入 | P1 |

---

## 10. 存储/迁移/持久化

覆盖 `Database → Migration → MessageStorage → SessionStorage → ProjectStorage → SettingsStorage` 全链路。

| 编号 | 用例名 | 前置条件 | 操作步骤 | 预期结果 | 优先级 |
|------|--------|---------|---------|---------|--------|
| STOR-001 | 数据库初始化——initDatabase | 无 DB | 调用 | ① 所有表创建（messages/tool_calls/sessions/projects/settings/delegation_tasks 等）② 索引创建 ③ 无 SQL 错误 | P0 |
| STOR-002 | 数据库重置——resetDatabase | 有数据 | 调用 | ① 所有表清空 ② 结构保留 ③ 不影响 schema | P0 |
| STOR-003 | 迁移——migration.ts | 旧版本 DB | 升级 | ① 版本检测 ② 增量迁移 ③ 不丢数据 ④ 幂等（可重复执行）| P0 |
| STOR-004 | 迁移边界——空 DB | 无任何数据 | 迁移 | ① 不报错 ② 创建所有表 ③ 版本号正确 | P1 |
| STOR-005 | 迁移边界——已是最新版本 | 最新版本 DB | 迁移 | ① 跳过迁移 ② 不重复执行 ③ 无副作用 | P1 |
| STOR-006 | `persistDatabase`——异步持久化 | 有修改 | 调用 | ① localStorage/IndexedDB 写入 ② 数据完整 ③ 不阻塞 UI | P1 |
| STOR-007 | Settings 存储——getSetting/setSetting | 无 | 调用 | ① 字符串值正确存储/读取 ② removeSetting 清除 ③ 默认值回退 | P0 |
| STOR-008 | Settings JSON——getSettingJSON/setSettingJSON | 无 | 调用 | ① JSON 对象正确序列化 ② 反序列化正确 ③ 默认值 ④ 无效 JSON 回退 | P0 |
| STOR-009 | 项目 CRUD——ProjectStorage | 无 | 创建/读取/更新/删除 | ① createProject 写入 ② getProject 读取 ③ updateProject 修改 ④ deleteProject 删除 ⑤ listProjects 列表 | P0 |
| STOR-010 | 会话 CRUD——SessionStorage | 有项目 | 创建/读取/更新/删除 | ① createSession ② listSessions(projectId) ③ updateSession ④ deleteSession ⑤ 按 projectId 隔离 | P0 |
| STOR-011 | 消息 CRUD——MessageStorage | 有会话 | 创建/读取/更新/删除 | ① createMessage ② getMessages(sessionId) ③ updateMessage ④ deleteMessage ⑤ 按 sessionId 隔离 | P0 |
| STOR-012 | tool_calls 关联——外键完整性 | 有消息和工具调用 | 检查 | ① tool_calls.message_id 关联正确 ② 删除消息时级联删除 tool_calls ③ 查询按 rowid 排序 | P0 |
| STOR-013 | delegation_tasks 表——新增表 | DB 初始化 | 检查 | ① 表存在 ② 字段完整（id/source/target/task/status/projectId/createdAt）③ 索引正确 | P0 |
| STOR-014 | delegation_tasks CRUD | 有表 | 操作 | ① createDelegationTask ② getDelegationTask ③ updateDelegationTaskStatus ④ getActiveDelegations ⑤ clearCompletedDelegations | P0 |
| STOR-015 | 项目删除级联 | 有项目含会话和消息 | deleteProject | ① 项目删除 ② 关联会话删除 ③ 关联消息删除 ④ 关联 tool_calls 删除 ⑤ delegation_tasks 清理 | P0 |
| STOR-016 | 大数据量——1000+ 消息 | 大量消息 | 查询性能 | ① 查询不超时 ② 分页/限制 ③ UI 不卡死 | P1 |
| STOR-017 | 并发写入——多会话同时保存 | 会话 A 和 B 同时 saveMessages | 并行 | ① 不互相覆盖 ② 各自独立 ③ 不死锁 | P1 |
| STOR-018 | 编码——中文路径项目 | 项目路径含中文 | 创建项目 | ① 路径正确存储 ② 不乱码 ③ 查询正确 | P0 |
| STOR-019 | 编码——Emoji 会话标题 | 标题含 Emoji | 创建会话 | ① 标题正确存储 ② 不乱码 ③ 显示正确 | P0 |
| STOR-020 | `delegation_tasks` 索引——按 status 查询 | 有多状态任务 | 查询 | ① `getActiveDelegations` 只返回 pending/running ② 索引有效 ③ 不全表扫描 | P1 |

---

## 附录 A: 测试环境与 Mock 策略

### A.1 必要 Mock

| Mock 目标 | Mock 方式 | 原因 |
|-----------|----------|------|
| `../core/file-api` (`executeCommand`, `readFile`, `writeFile` 等) | `vi.mock()` | 避免真实文件系统操作 |
| `../core/agent/agent` (`getAgentRegistry`) | `vi.mock()` | 返回固定 `evaluatePermission` |
| `LLMProvider` (`stream`/`complete`) | 手动 Mock 对象 | 控制流式输出和工具调用 |
| `window.__TAURI__` | 全局 Mock | Tauri API 桥接 |
| `localStorage` | `beforeEach` 清理 | 隔离测试 |
| `IndexedDB`/`initDatabase` | `resetDatabase()` | 隔离 DB 状态 |

### A.2 测试数据生成

```typescript
// 辅助：创建 Mock Provider
function createMockProvider(overrides: Partial<LLMProvider> = {}): LLMProvider {
  return {
    id: "mock",
    name: "Mock Provider",
    isConfigured: () => true,
    stream: async function* (request: LLMRequest): AsyncIterable<StreamEvent> {
      yield { type: "text_delta", text: "Hello world" };
      yield { type: "usage", usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
    },
    complete: async () => ({ content: "Hello", usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }),
    ...overrides,
  };
}

// 辅助：创建 Mock ToolContext
function createMockCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionId: "test-session",
    messageId: "test-msg",
    cwd: "/tmp/test",
    abort: new AbortController().signal,
    messages: [],
    metadata: () => {},
    securityMode: "ask",
    ...overrides,
  };
}
```

### A.3 执行优先级

| 优先级 | 含义 | 执行策略 |
|--------|------|---------|
| **P0** | 核心功能，必须通过 | 每次 PR 必须运行 |
| **P1** | 重要功能，应该通过 | 每日 CI 运行 |
| **P2** | 辅助功能，尽量通过 | 每周 CI 运行 |

---

## 附录 B: 测试覆盖矩阵——新增特性影响

> 以下矩阵展示新增的环境配置、Git、Git Worktree 对各核心功能模块的潜在影响点。

| 核心功能 \ 新增特性 | 环境配置 (ENV) | Git 配置 (G) | Git Worktree (WTR) | 跨会话委派 (DELE) |
|---------------------|:---:|:---:|:---:|:---:|
| 对话核心链路 | ✅ CHAT-013 | ✅ prompt 注入 | ✅ WTR-024/026 | ✅ CHAT-008/009/045 |
| 思考过程 | — | — | ✅ WTR-026 (cwd) | — |
| 工具调用 | ✅ ENV 脚本 | ✅ Git 命令 | ✅ WTR-026/028/029 | ✅ TOOL-030 |
| 子智能体 | — | — | ✅ WTR-027 | ✅ SUBA-025 |
| 技能调用 | — | — | ✅ WTR-028/021 | — |
| 上下文压缩 | — | — | ✅ CTXT-018 | — |
| 权限/沙箱 | ✅ ENV 脚本权限 | ✅ Git 命令权限 | ✅ SECU-017 | ✅ SECU-022 |
| 存储 | — | — | ✅ session.worktreePath | ✅ STOR-013/014 |

---

**文档版本**：v1.0
**最后更新**：2026-07-25
**维护者**：开发团队
