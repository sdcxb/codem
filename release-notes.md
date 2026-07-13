# Codem v0.79.0 发布说明

## v0.77 → v0.79 更新记录

### 🔒 三级安全策略系统
- 新增 `ask` / `auto` / `full` 三级安全模式，支持全局和项目级独立配置
- `ask` 模式：写入/删除操作前弹出确认对话框（默认）
- `auto` 模式：自动审批常规操作，受保护路径（.git/.env）仍需确认
- `full` 模式：完全自动访问，适合信任项目
- 安全模式按钮集成到输入区，单击切换，颜色区分状态
- 包含 153 个单元测试和集成测试

### 🔄 智能体协作修复
- **修复 `wait_for_subagent` 死循环根因**：消息序列化逻辑将"全有或全无"改为按工具状态独立处理，修复 LLM 看不到已完成子智能体结果的问题
- **修复无限 spawn 问题**：每次迭代创建独立的 assistant 消息，确保 LLM 能看到上一次 spawn 返回的 task_id
- **更新子智能体 Prompt**：明确两步式 spawn/wait 模式（先 spawn 获取 task_id，下一轮再 wait），避免 LLM 在同一响应中生成无效的 wait 调用
- **添加子智能体守卫**：LLM 试图结束对话时检查是否有未 wait 的子智能体，注入提醒
- **跨迭代去重**：已 wait 的子智能体结果缓存，重复调用返回缓存结果

### 🔗 LLM 连接稳定性
- **移除时间超时机制**：彻底移除空闲超时判断（不可靠的方案）
- **改为状态驱动**：Connecting → Streaming → Executing 三状态驱动 UI 显示
- **AbortController 全链路**：取消信号从 UI 传递到 fetch 和 ReadableStreamDefaultReader
- 用户可随时点击 ■ 按钮取消正在进行的操作

### ✅ 任务完整性检查
- 防止 LLM 在未完成用户所有指令时提前停止
- 用户要求"保存/写入"但未调用 write 工具 → 注入提醒继续循环
- 用户要求"用子智能体"但未调用 spawn_subagent → 注入提醒继续循环
- 只触发一次，防止无限提醒

### 📝 改进路线图全部完成（Phase 0-4）
- **Phase 0**：类型与接口层 — 所有配置字段一次性加完
- **Phase 1**：基础设施通电 — 子智能体模型路由、记忆系统激活、受保护路径、写入覆写保护
- **Phase 2**：核心效率 — Bash 超时、推理力度、成本检查、自动 Lint、apply_patch 编辑工具、协作模式、增量消息构建、智能上下文选择、文件缓存、并发扩展、安全扫描、Prompt Caching
- **Phase 3**：混合模型系统 — Model Profile 多模型多场景调用、成本降级、跨会话记忆整合
- **Phase 4**：精细化 — AGENTS.md 自动生成、自定义权限规则 UI、沙箱路径白名单、多模态（Embedding/TTS/ImageGen）

### 🌐 多语言支持
- 系统提示词双语（中英文按 getLang() 切换）
- 子智能体提示词双语
- 工具返回文本双语
- UI 语言选择器
- 安装时自动检测安装器类型设置默认语言

### 📊 诊断日志增强
- Agentic Loop 全链路日志（迭代开始/结束/工具执行/LLM 流错误）
- 消息构建诊断日志（raw/llm/selected 消息数量、工具结果预览）
- 子智能体 spawn/wait 追踪日志

### 📋 Wegent UI/UX 对标分析
- 完成 Wegent 开源项目 UI/UX 全面分析
- 识别 10 项优化方向，分三个优先级
- 分析文档：`docs/UI-UX-Wegent-Benchmark.md`

---

## 下载

| 文件 | 说明 |
|------|------|
| `Codem_0.79.0_x64-setup.exe` | NSIS 安装包（推荐，支持中英文） |
| `Codem_0.79.0_x64_en-US.msi` | MSI 安装包 |

## 系统要求

- Windows 10/11 (x64)
- WebView2 Runtime（Win11 已内置）
