# Changelog

All notable changes to Codem will be documented in this file.

## [Unreleased]

### 技能市场联网搜索卡死修复（"正在联网搜索…"无限 loading）

- **用户报告**：搜索无本地结果的关键词（如 diagram-design）后，一直显示"正在联网搜索"数分钟，无结果也无失败提示
- **根因（UI effect 竞态，`SkillManager.tsx`）**：搜索 effect 的 cleanup 只清防抖 timer + 设 `cancelled`，而搜索完成回调只在 `!cancelled` 时复位 loading；一旦 effect 因输入变化/结果渐进合并被 cleanup 取消，旧搜索被取消后**不再复位**，而新 effect 若走"空查询/本地已有结果"提前返回分支也**不复位** → `onlineSearching` 残留 true 永久显示
- **修复**：①**搜索代次机制**（searchSeqRef）——只有最新一次搜索能合并结果/报错/复位 loading，旧搜索后台完成不碰 UI；②effect cleanup 与提前返回分支直接复位 loading；③**30s watchdog 兜底**——即便再漏网，超时强制结束并提示"联网搜索超时，请检查网络或换关键词"（用户永远拿到明确反馈）；④搜索异常（catch）向用户显示失败原因（原仅 console.warn）
- **源层核验**：联网搜索（searchMarketSkillsOnline）与检查更新（listMarketSkills）两路径的每个源都有 12s `Promise.race` 超时兜底（有界，非源层挂起）；核验无其它同类残留 loading 模式（loadMarketSkills finally 无条件复位）
- 全量 152 文件 / 4140 用例通过 + tsc 零错误

### GitHub URL 标签重复生成修复（输入每字符加一个标签）

- **用户报告**：在对话编辑框手打 GitHub 开源项目 URL 时，每输入一个字符就生成一个仓库标签，不停堆积
- **根因**（`InputArea.tsx`）：onChange 逐字符调用 `detectGithubUrls`，把"未输完的 URL 前缀"（https://github.com/c → /ca → /cat …）都当作完整 URL 添加 badge——每个前缀是不同的 badge id，原有按 url 去重失效 → 标签堆积
- **修复**：改为**防抖 + 同步式 reconcile**——①输入停顿 500ms 后才检测当前文本（粘贴/快速手打都只出 1 个标签）；②每次检测同步差集：旧"过渡前缀"标签被更长 URL 取代时自动移除（始终 ≤ 实际 URL 数）；③用户手动删除过的 GitHub URL 本会话内不再自动加回（removedGithubUrlsRef）；④组件卸载清理防抖定时器
- 全量 152 文件 / 4140 用例通过 + tsc 零错误

### 输入框光标视觉错位修复（长 URL 粘贴时 caret 偏 1 格）

- **用户报告**：粘贴/输入长 URL（如 https://github.com/cathrynlavery/diagram-design）后，光标视觉位置比实际插入点靠前 1 个字符（实际在末尾、显示在倒数两字符之间）；已确认**纯视觉错位**（文本与实际插入点正确）
- **根因**：输入框采用"透明 textarea + backdrop 镜像层"架构（textarea 文字透明只显示 caret，可见文字由 backdrop 层渲染）——两套排版一旦有细微字体/断行差异，caret（textarea 原生）与可见文字（backdrop）就会视觉错位
- **修复（根治）**：改为**条件镜像**——仅在文本含 `/xxx` 技能模式（需要 pill 高亮）时才启用透明+backdrop；普通文本（含 URL）时 textarea **直接显示文字**，caret 与文字同源渲染，物理上不可能错位；同时 backdrop/textarea 强制同一显式字体栈（var(--font-family)）+ 关闭字体连字（font-variant-ligatures: none），消除排版差来源
- 全量测试通过 + tsc 零错误

### CodeGraph 工具真正接入 LLM（defer 按需加载，修复"指导有、工具不可调"）

- **问题**：codegraph_explore 此前只在 systemPrompt 手写指导（"优先使用 codegraph_explore"）+ MCP 工具文本清单里出现，但 LLM 的 function-calling schema（ToolDef 表）里**没有该工具**——模型照指导调用会报工具不存在，指导落空且浪费 token
- **整改**（`llm/tools/codegraph-tool.ts` 新增）：
  - 已连接的 codegraph MCP 工具包装为**可调用 defer ToolDef**（`shouldDefer: true`）：完整 schema 默认不进请求，model 需要时经 `tool_search` 拉取（该轮才计 schema 成本）——schema token 按需出现
  - `searchHint` 写明触发场景（调用链/谁调用/改动影响范围；普通读写仍走 read/grep/glob）——场景由模型按任务判断，不做强制门控
  - `syncCodeGraphTools`（engine 每次构建系统提示、autoDetect 后调用）：连接→注册；断开/禁用→移除残留——**提示与可调用集合严格一致**
  - 删除 prompt.ts 手写 CodeGraph 指导段与 `codeGraphEnabled` 配置字段；CodeGraph 提示改由 agentic-loop 的 "Deferred Tools" 段自动呈现（工具注册才出现）
  - execute 转发 `getMCPRegistry().callTool` 并展平 MCP content 文本
  - 测试：codegraph-integration.test.ts 重构为新契约（无手写段 / 注册即 defer schema 可经 tool_search 拉取 / 断连移除 / e2e 注册-可调闭环）

### CodeGraph 应用内一键安装（方案 B：用户零命令行）

- **背景**：CodeGraph 是外部 CLI（vendored Node 自包含 zip ~52MB），原需用户自行下载安装（不符合"一个安装包"目标）
- **Rust `codegraph_install` 命令**（`lib.rs`，新增 zip 依赖）：GitHub API 解析最新 tag → 下载 codegraph-win32-x64.zip → 解压到 `%LOCALAPPDATA%\codegraph\current`（路径穿越防护）→ 返回启动器绝对路径（`bin/codegraph.cmd`）
- **设置页「⬇️ 一键安装 CodeGraph」按钮**：点击即在应用内完成下载/解压并把启动器路径存入设置（`codem-codegraph-launcher`）——不再要求用户敲命令/改 PATH
- **MCP spawn 支持 .cmd**（`mcp_stdio_connect`）：Windows 下 command 以 .cmd/.bat 结尾时用 `cmd.exe /c` 包装（codegraph 官方发布入口是 bin/codegraph.cmd，CreateProcess 无法直接执行——修复后连接才真正可 spawn）
- **连接与检测联动**：`autoDetectCodeGraph` 连接命令优先用已存 launcher 绝对路径（fallback PATH 'codegraph'）；设置页 CLI 检测优先检查 launcher 存在
- **检测逻辑修复**：exitCode/stdout 三重兜底 +「🔄 重新检测」按钮（此前只看 stderr 两种英文文案，其余一律误判"已安装"）
- 测试：launcher 路径连接/回退（codegraph-integration 48 用例）+ 全量 152 文件 / 4140 用例通过 + tsc/cargo 零错误

## [1.9.7] - 2026-09-04

### dsh 插件市场与插件架构全面改造（对标 deepseek-harness）

> 分析 harness 插件生态机制（npm 包 + cordis.patch.yml 分层装配 + Loader 激活 + plugin-inventory UI）后评估：Codem 装配/管理框架已同构，但**无法加载任意 npm 插件**（运行时鸿沟），dsh-compat 桥此前 deprecated 未接入。本轮落地：

- **插件市场目录**（`plugin-market/dsh-market-catalog.ts`，50 条真实官方 @deepseek-ai/dsh-* 包，与 harness packages 全量核对存在性）：三类兼容性评估——bundled 37（Codem 内置等价，codemAnchor 指向真实插件且**一对一唯一**，DM-2/DM-4 校验）/ adaptable 9（dsh 协议、无第三方依赖，可经 dsh-compat 桥接）/ unsupported 4（依赖 Node/npm 运行时或 zod 等 npm 依赖，诚实标注）；附 npm registry 在线检索（15s 超时）
- **插件管理弹窗新增「插件市场」Tab**（`components/plugin-market/PluginMarketTab.tsx` + PluginManager Tab 切换）：浏览/搜索/分类（能力/工具/界面/基础设施）、兼容徽标、bundled 条目一键"安装并启用"对应内置插件（**三态按钮**：未启用→安装 / 可安全卸载→禁用 / 核心恒启（llm/fs-local/session/shell-local/tools/credentials 等 6 锚）→只读"已启用（核心）"，杜绝把核心插件当卸载目标）、在线检索**跟随搜索框输入**、小窗自适应（maxHeight 滚动、manager 未就绪禁用安装）
- **dsh-compat 接入运行**：`dsh-compat/index.ts` 由"注册时同步取服务（时序竞态→别名缺失）"重写为**懒解析代理别名**（dshLlm/dshShell/dshFs/dshTools/dshSessions/dshEvents/dshCredentials 恒注册、方法调用时现取真实服务并做接口转换）；`builtin-registry` 注册 @codem/dsh-compat + `codem.base.yml` 装配行——"可适配"类插件有了真实承载
- **服务名对齐矩阵审计**（对 harness packages 全量插件 inject 服务名 78 项 vs Codem provides 203 项逐项比对）：核心 seam（fs/shell/tools/llm/session/credentials/sandboxPolicy/slots/commands/compaction/systemPrompt/userQuestions/subagent 等）**同名直通**；复数/命名差异（sessions/sessionProjections/sessionQuery/sessionTitle/goals/bash 等）由 dsh-compat 别名承接；约 30 项 harness 宿主装配名（remote.*/ui*/typert/webServer 等）属宿主层、超出纯协议插件范围——结论固化于 dsh-compat 头注释（后续审计基准）
- 测试：`dsh-plugin-market.test.ts`（DM-1~5：三类覆盖 + bundled 必有 anchor + anchor 全部存在于 runtimePluginList + fetch 失败返回 [] + bundled 锚**一对一唯一** + **真实依赖图下全部 bundled 锚安装级联可达、无缺失依赖**——市场"安装并启用"路径的自动化验收证据）+ `dsh-compat-lazy.test.ts`（DC-1~4 懒解析/转换）+ `dsh-plugin-market-wiring.test.ts`（PM-1~3 YAML↔builtin 装配一致性，防 terminal-bash 式断链）+ `plugin-market-tab.test.tsx`（MT-1~5：渲染/安装/禁用/**核心条目只读**）
- **插件皮肤兼容契约（Skin Token Contract）**：插件（UI/UX 类）与三套皮肤（default 亮/暗、dream、hub 恒暗）兼容机制化——`core/theme/skin-tokens.ts` 登记令牌表 + `auditPluginStyle` 源码级硬编码色审计；新测试 `skin-compat-plugin.test.ts`（SC-1~5：审计函数行为 / 市场 Tab+插件管理零硬编码色 / 令牌在 styles.css 均有定义 / 目录分类受支持 / **共享 Badge 语义变体规则体无裸露色**）；修复市场 Tab 安装按钮文字色 `#fff`→`var(--text-on-accent)`；**共享组件层修复**：styles.css 两组 `.badge-success/warning/danger/info` 从硬编码暗色系（rgba(34,197,94)/#4ade80 等）与未定义变量（--info-bg/--warning-bg）改为语义令牌 + color-mix 半透明（亮/暗/梦幻/Hub 自动适配）；市场分类改为**动态派生**（harness 无 UI 类核心插件，"界面"空分类不再渲染）；完整契约见 `docs/SKIN-PLUGIN-CONTRACT.md`
- **全面审计第二轮（Bug/可应用性/稳定性/UI-UX 交互）修复**：
  - **稳定性 P1**：`enable()` 级联启用**部分失败仍返回 success:true**（UI 假"已启用"）→ 任一失败即 `success:false` + 失败明细（`Failed to enable: <name>: <error>`）
  - **稳定性 P2**：**error 状态未持久化**（重启后 initialize 误判 enabled、无 fiber 假启用）→ `saveDisabledList` 将 error 计入未启用列表，重启后保持 disabled 可重试
  - **稳定性 P3**：**loading 态连点并发竞态**（同插件二次 ctx.plugin 加载）→ `enable/disable` 对 loading 状态拒绝（"being enabled/loaded, please wait"）
  - **架构 V1（重要）**：插件管理弹窗**每次打开都重建 PluginManagerService 并覆盖全局单例** → 旧实例加载进 ctx 的插件 fiber 追踪丢失，新实例 disable 找不到 fiber → **假禁用（插件实际仍在 ctx 运行）** + 每次 initialize 重复 doDisable/notify 副作用。修复：`initPluginManager` **ctx-ready 单例幂等**（已建直接返回，不再重建/不重复 initialize）；ctx 未就绪仅返回临时渲染实例（不缓存）；组件 ctx-null fallback 首次建临时实例后不再重复创建（retryCount===0 门控）
  - **UX P4**：插件管理 `handleToggle` 对 error/loading 静默无操作 → error 点击 = **重试启用**（toast 反馈）；loading 点击提示；级联确认 disable 失败补 error toast
  - **UI U1**：市场 Tab 安装进行中无视觉反馈、可连点 → 按钮 loading 态只读"启用中…"（+handleInstallBundled 防御）
  - **UI U6**：市场 Tab 布局链断（根容器无 flex:1 → 固定 maxHeight 网格在 80vh 弹窗内**裁掉底部在线检索结果区**）→ 根 div flex:1 + 网格 flex 滚动
  - **契约核对 P5（通过，无改动）**：dsh-compat 7 别名逐一对照真实服务源码——llm.complete/`stream`（async function*）/listModels、shell.execute(command,cwd,timeoutMs)、fs readFile/writeFile/listDirectory/deleteFile/exists、session create/get/list/delete、ctx emit/on/waterfall/serial/bail/parallel 全部匹配（buildFs.stat 以 exists 近似标注局限）
  - 新测试：`plugin-manager-robustness.test.ts`（R-1~R-5：级联全成功/部分失败必报错/error 持久化/error 重试恢复/幂等拒绝）+ `plugin-market-tab.test.tsx` MT-6（loading 只读态）
  - **真实 Cordis 装配集成测试**（`dsh-compat-live-cordis.test.ts`，LC-1~6）：用真实 Cordis Context + 真实 provider 插件（llmProvider/shellProvider/sessionProvider 经 `await ctx.plugin` 激活）+ dshCompatPlugin 验证——7 个 dsh 别名经 active fiber 注册可被 `ctx.get` 解析；dshLlm 懒解析全链路（→真实 llmProvider→llmEngine）可用；dshSessions 驱动真实 sessionProvider；dshEvents 走真实事件系统；服务未就绪**同步抛可诊断错误**（`[dsh-compat] service "session" not ready`）；fiber.dispose 后别名从 ctx 移除（市场"禁用 @codem/dsh-compat"真实卸载语义）。目标②（dsh 插件可应用性）由静态服务名核对 + 动态真实装配双向实证
  - **元数据漂移 V2（全量诊断 199 处差异收敛）**：runtimePluginList（静态清单）与 builtin-registry（激活同源）的 provides/inject 曾大幅 drift——dsh-compat 在清单里写成**大写 dshLLM/dshFS 且仅 4 个别名**（实际注册小写驼峰 7 个）→ 依赖 dshSessions 的插件被依赖图误判缺依赖、UI"提供的服务"徽章错误；另有 ~15 插件清单缺 llmEngine 等 inject（llm/tools/mcp/skill/subagent/settings/retry…）、sandbox-local 反向多 shell、host-client 缺 hostClient。修复：①清单 dsh-compat 条目改小写 7 别名 + builtin 注册补 category 'compat'；②**pluginRegistryProvider.apply 时以 builtinPlugins 覆盖 pluginMeta 的拓扑字段**（provides/inject/priority/core）——插件管理依赖图与 Cordis 激活**运行时同源**，静态清单 drift 免疫（UI 展示字段保留静态描述）；③PM-4 重写为真实装配驱动（registerBuiltinPlugins + ctx.plugin(pluginRegistryProvider)）后全量对比 100+ 插件拓扑一致 + dsh-compat 特判（防大写变体回归）
  - **UI/UX 细节（U3/无障碍）**：①installed Tab 分类改**动态过滤**（只显示实际存在插件的分类 + 全部——原硬编码 'tool' 分类恒 0 空按钮，与市场侧 'ui' 空分类同类问题）②PluginCard 开关补 aria-label（读屏语义）③市场卡片 note 截断加 title 全文 tooltip（adaptable/unsupported 适配说明不被截断丢失）④installed 展开的依赖/被依赖列表加滚动上限（120px），高扇出插件（tools 等 20+ 依赖）不再撑爆卡片
  - **卸载语义 P6（对标 dsh 的核心改造）**：审计发现生产代码**从不注册 loader**（仅测试）→ manager 的 enable/disable 只改状态、**从不真正加载/卸载 Cordis ctx 里的插件**——codem.base.yml 装配 203/202 全量插件，用户"禁用"tool-fs-search/mcp/schedule 等**实际无效**（工具/服务仍在 ctx 运行 = 假禁用），"启用"ui-game 也永不真加载。修复：①**装配 fiber 登记**：yaml-loader（loadFromYaml/loadFromEntries）每 `ctx.plugin` 即把 name→fiber 登记（`registerActiveFiber/getActiveFiber/unregisterActiveFiber`）②**自动 loader 填充**：PluginManagerService.initialize 从 builtinPlugins 为全量内置插件登记 loader（enable = `ctx.plugin` 真加载）③**doDisable 真卸载**：同时 dispose 动态 fiber（this.fibers）与 YAML 装配 fiber（activeFibers）并注销——禁用 = 插件/服务/工具真正从 ctx 移除；重启后 initialize 对持久化禁用列表执行真卸载。测试 R-9（真实 ctx 装配 @codem/session → disable 后 `ctx.get('session')` 消失 + activeFibers 清空 → enable 后服务重新注册）
  - **入口死锁 P7**：插件管理按钮 `pluginMgrEnabled` 依赖 @codem/plugin-registry 与 @codem/ui-slots——两者原可禁用（registry 仅有 category: core 分组无 core:true 保护）→ 禁用后插件管理入口消失且无恢复路径。修复：两插件在 runtimePluginList 与 builtin-registry 均标记 `core: true`（disable 被 lock 拒绝，PluginCard 开关禁用）；PM-5 断言保护（防未来移除）

### 功能修复与体验（v1.9.6 后工作区）

- **执行轨迹完整修复与持久化**：数据源修复（sessionId 显式传入 + fallback 适配真实消息结构——assistant.toolCalls 驼峰 {tool,args,result,status} → tool_call/tool_result/error，兼容 tool_calls/role=tool）+ llm_call 行内 usage（⇣/⇡ tokens）+ **事件日志批量持久化**（TrajectoryService 2s 周期 flush 到 session_events type 'trajectory_step'，dispose/退出前 flush——重启后历史轨迹全量回放）+ 小窗自适应（执行轨迹/浮层宽 `min(380px, calc(100vw - 24px))`）
- **首页无会话直接可用**：无会话时输入框不再禁用——输入回车自动创建全局对话（projectId=""），占位提示"输入消息，回车将自动新建全局对话"
- **托盘退出数据安全**：quit-requested（托盘"退出"）→ 前端 flush 数据库后退出（兜底 Rust 2.5s）
- 全量测试终态：152 文件 / 4141 用例通过 + tsc 零错误

## [1.9.6] - 2026-09-02

### 打包版运行问题修复（CSP / 插件加载 / 解析降噪 / subagent 激活）

> 用户报告知识笔记本导入 docx 报错与启动控制台告警，逐项定位修复：

- **CSP 允许 blob:（修复导入 docx 嵌入后端不可用）** — 打包版在 tauri.localhost 下，transformers.js/onnxruntime 用 `URL.createObjectURL` 动态 import WASM 被 CSP `script-src` 拦截（`no available backend found`，索引全部失败）；`script-src` / `worker-src` 增加 `blob:`
- **CSP 允许 tauri IPC 协议** — `connect-src` 增加 `ipc: http://ipc.localhost`（Tauri v2 自定义 IPC 不再回退 postMessage，消除 `Refused to connect … violates CSP` 告警）
- **移除 YAML 中已删除插件引用** — `config/codem.base.yml` 删除 `@codem/terminal-bash`（v1.9.3 已移除该 provider 但 YAML 残留 → 每次启动 `YamlLoader failed 1`）
- **extractJSON 失败降噪** — 6 步容错修复尝试间静默，全部失败后仅单次 warn（附输入预览）；此前每次失败逐条打印 SyntaxError（导入多个来源时控制台刷屏）
- **知识摘要解析失败降级为文本摘要** — `generateSourceSummary` 在模型未返回严格 JSON 时把输出清理后取前 200 字作摘要存入（此前仅 warn 留空，笔记本卡片无内容）
- **SubagentRuntime 同步初始化（修复 subagent 服务激活竞态）** — runtime 创建由动态 import 异步改为静态 import 同步（import 链无值依赖循环），`subagentProvider` 不再拿到空 runtime → 9 个 `inject: ['subagent']` 的插件不再 PENDING（消除 `assertActivated FAILED`）

## [1.9.5] - 2026-09-02

### 对话步骤语义化 + update_plan 动态插入（对标 dsh 客户端 todo 语义列表）

> 用户反馈：对话中【第X/X步】是"回答问题/执行命令"式无意义通用步骤，而 dsh 客户端是"分析卡死原因→诊断链路→修复→测试"式的语义步骤，且执行中发现新问题时可在当前位置插入步骤（编号顺延）。根因：LLM 语义计划只在启发式估步 ≥3 时调用（"修复卡死的问题"被判纯问答 → 显示"回答问题"），且无任何插入通道（计划耗尽后只按执行工具类别追加泛化标题）。

- **任务语义计划（引擎层）**：执行型任务（新增中英文任务意图检测 `looksLikeExecutableTask`：修复/排查/分析/为什么/卡死…）**总是**让 LLM 生成面向具体任务的语义步骤（分析原因→定位诊断→修复→验证），30s 超时回退启发式（任务句兜底首步含任务摘要，不再"回答问题"）；`planSteps` 提示词强化（含"分析卡死原因/诊断链路/修复卡死/测试"好例与"回答问题/执行命令"坏例 + 空白标题清洗回退）
- **update_plan 工具（动态插入）**：新增 LLM 工具支持 `insert_before / insert_after / append` 三种插入——执行到第 N 步发现必须先处理的新问题时把步骤插到当前进行中步骤之前，**编号顺延、total 自动更新**、UI"第X/X步"即时刷新；只允许插入"当前或更后"位置（不可改写已完成步骤）、空标题/重复/12 步上限校验；成功回执携带插入后完整计划（模型感知新编号）；属计划元操作不推进 X/X
- **计划上下文注入**：每次 LLM 请求的 systemPrompt 附带"当前执行计划（第 X/Y 步）+ [完成/进行中/待办] 状态列表 + update_plan 使用指引"，模型每轮可见剩余步骤（对标 dsh todo 每轮可见）
- **语义计划不再混入泛化步骤**：`fromLlm` 标志——LLM 语义计划耗尽后引擎**不再**自动追加"执行命令"式泛化标题步骤（启发式计划保留旧兜底）
- 新增测试：`step-plan-semantic.test.ts`（STEP-P1~P8，11 用例：意图边界/插入语义/已完成区拒绝/工具契约/计划渲染）+ `step-plan-dynamic-insert-loop.test.ts`（STEP-L1~L9，6 用例：驱动真实 loop 复现"第 3 步前插入修复调用链路 → 3/5 刷新 → 继续推进进入顺延步骤"）

### token 消耗审计与修复（对标 dsh-desktop / deepseek-harness）

> 用户报告：相同模型下用 Codem 修 bug 比 dsh 第三方客户端消耗大数倍。逐项对照 harness 源码参数审计并修复 6 项结构性差异：

- **read 单次结果上限 100k→50k 字符**（对齐 dsh `READ_MAX_BYTES≈50KB`；此前中文内容 ≈300KB 字节 = dsh 6 倍）
- **上下文折叠（新增 `context-fold.ts`）**：`selectMessagesByPriority` 截断丢弃早期消息时插入零成本紧凑摘要（`[上下文精简] 较早 N 条消息（read×2…）请重新调用工具`，不调 LLM），打断"失忆→重复读取/执行"的 token 恶性循环；防每轮重复累积
- **陈旧大工具结果 head+tail 裁剪**：对齐 dsh `compaction-tool-result-pruner`（8192/4096/1024）——保留最近 2 条工具结果完整，更早 >8KB 结果裁为 head+marker+tail（含错误尾部），历史 read/bash 大结果单条从 12-25k token 降到 ~1.3k
- **7 个低频大 schema 工具延迟加载**：`generate_ppt / browser_automate / figma_fetch / github_tool / workflow / image_gen / tts` 设 `shouldDefer`（每轮全 schema 10.6k→~7.5k token，模型可经 tool_search 按需加载）
- **systemPrompt 工具信息三重复裁剪**：`tools:catalog`（Available Tools 全列表）文本置空、工具 guidance 仅注入核心工具、collectToolGuidance fallback 去重列表（核心工具 description 已在请求 tools 数组；defer 工具已有 Deferred Tools hints）
- **上下文选择预算对齐真实窗口**：select 预算从固定 100000 伪 token（=400k 字符，中文可超真实窗口致服务端截断/400）改为 `tracker.getContextWindow()×90%` + 共享 CJK 感知 `estimateTokens` 估算；`token-tracker` 新增 `getContextWindow()`
- 新增测试：`context-fold.test.ts`（TOK-F1~F7：折叠统计/文案/裁剪 head+tail/保留最近 N 条）；更新 v1.5.2 H4（read 上限 50k）

### 全面功能审计修复（断点/错误/不稳定）

- **PTY 关闭/退出杀进程树**：`close_pty` 与 `quit_app` 从单 kill 改 `kill_process_tree`（`taskkill /T /F`）——cmd.exe 的孙进程（长命令 node/npm/test）此前残留为孤儿进程占用资源/端口
- **TerminalPanel spawn 失败残留**：失败路径补 `term.dispose()` + 移除临时 DOM（此前空终端 div 永久残留且无法关闭）
- **4 处裸 fetch 补超时**：`web-provider` 兜底抓取 20s、`knowledge/extractor` 浏览器抓取 15s、`remote-client-provider` 能力发现 10s、`search-deepseek` 搜索/抓取 15s/20s（此前网络黑洞永久挂起，相关工具卡到 15 分钟看门狗）
- **托盘"退出"菜单先 flush 再退出**：不再直接 `app.exit`（绕过前端 DB flush 丢最近防抖窗口写入）——emit `quit-requested` → 前端 `await flushDatabase()` → `quit_app`，Rust 2.5s 兜底强退（先检查主窗口仍在，防二次 exit）

## [1.9.4] - 2026-09-02

### dsh-desktop 全面对标 — 稳健性审计修复（15 轮迭代，bug 级清零收敛）

对标 [dsh-desktop](https://github.com/anywhere-labs/dsh-desktop)（crash-evidence / renderer-health / log-files / shutdown 等机制）审计 Codem 共有的功能，逐项修复并回归，共 42+ 项。

#### 崩溃检测与恢复链路（对标 dsh crash-evidence）

- **active-run.json 崩溃标记** — Rust 启动时写入（pid + 启动时间），正常退出（quit_app / 托盘退出 / ExitRequested）三重清理；上次进程异常终止（崩溃/强杀/断电）下次启动检测到标记 → `previous-run-unclean` 事件 → 界面提示"上次未正常退出，可前往设置 → 会话恢复查看快照"
- **panic 信息落盘** — panic hook 追加写 `codem-crash.log`（打包版 stderr 不可见，panic 信息此前完全丢失）
- **渲染崩溃恢复边界（对标 dsh renderer-health / startup-recovery）** — 新增 `AppErrorBoundary` 顶层错误边界：React 渲染崩溃不再白屏，显示恢复卡片（重试渲染 / 重新加载应用 / 重置界面设置并重新加载，后者仅清 `codem-*` 本地界面设置、不动 SQLite 会话数据）；崩溃证据（错误消息 + 组件栈，经 redactSecrets 脱敏）写入 localStorage，下次启动提示已自动恢复。测试 REC-R1~R6

#### 运行时文件日志（对标 dsh log-files.ts，新增）

- 新增 `src-tauri/src/runtime_log.rs` — 按日文件 `codem-runtime-YYYY-MM-DD.log`（位于 `%APPDATA%\com.codem.app\`）+ 段轮转（单文件 4MB，最多 3 段）+ 目录上限（24MB，删最旧）+ 启动清理超 14 天 + 单行截断 8KB（UTF-8 边界安全）+ **统一脱敏**（sk-/pk- 前缀需 token≥10 防误伤、ghp_/AKIA/Bearer/Authorization/password= 等贪婪型、重叠区间合并）
- 落盘事件：启动（含 pid / 上次是否异常退出）/ 崩溃检测 / 命令执行开始/结束/超时杀树 / PTY 创建与清理 / 退出 / 托盘构建失败，全部 best-effort 不影响主流程
- 13 个 Rust 单测（脱敏形态/误伤防护/轮转/保留判定/目录上限）

#### 持久化失败可见性（DB 写盘失败不再静默）

- `saveDatabase` 写盘失败（磁盘满/文件被占用）此前仅在 console 记录、调用方与退出前 `flushDatabase` 完全无感知 → 静默丢数据；现在首次失败 dispatch `codem:db-save-failed` 事件 → 界面 guidance 提示，连续失败限流不刷屏，3s 后自动重试一次（临时故障自愈），任何一次成功复位失败状态并 dispatch 恢复事件。测试 DBSAVE-F1~F4

#### 命令执行与 PowerShell 安全

- **execute_command 超时杀进程树** — spawn + 轮询 + timeout_ms（默认 600s，clamp 1s~1h）；超时 `taskkill /PID /T /F` 杀整树（Unix 杀负 PGID），修复此前 `cmd.output()` 同步阻塞、前端 Promise.race 超时后 PowerShell/子进程仍在后台运行堆积僵尸进程
- **PowerShell 安全转义** — 新增 `ps-command.ts`（psQuote / maybePsQuote / buildGitCommand）：git `HEAD^{tree}` 等含 `{}` 的命令此前触发 PowerShell `ScriptBlock should only be specified as a value of the Command parameter` 崩溃；统一单引号包裹修复
- 命令开始/结束（exit code + 耗时）/ 超时杀树记录进运行时日志（脱敏）

#### 网络与 API 稳健性

- **统一超时工具 `fetchWithTimeout`**（默认 20s，AbortController）覆盖：github-tool / figma-fetch / run-code（SDK fetch 15s + bash/exec timeout）/ web-search / job-manager / workflow-engine / pipeline / sync-engine（4 处）/ skill-market（install 120s、git 60s、gh 120s）
- **错误体统一脱敏** — 新增 `redact.ts`（redactSecrets / redactSecretsDeep）：LLM provider / vision-proxy / ollama / multimodal / bash 工具等 API 错误信息中的 sk-、Bearer、password 等密钥不再泄漏到界面/日志
- 远程 Provider WebSocket 连接 onopen/onerror 时 clearTimeout（修复定时器泄漏）
- multimodal / vision-proxy / skill-market-client 等模块错误路径脱敏 + 超时

#### 前端渲染与交互稳健性

- 全局 error / unhandledrejection 从 `alert()` 弹窗改为记录（此前任何未捕获错误弹原生对话框阻塞打断，多次弹窗体验极差）；过滤 ResizeObserver 良性警告
- **6 处 JSX 运算符优先级 Bug 修复**（FileChangesList / NeedsYouPanel / Workbench 等：`&&` 与三元混用导致条件渲染异常）
- TerminalPanel：className 括号错误修复 + `closeSession` 函数式 setActiveId + 监听 `pty-exit`（会话进程退出通知，`_closing` 标记防竞争，修复僵尸会话挂到 TTL 才回收）
- Mermaid `securityLevel` loose → strict（3 处：MessageBubble / NoteEditor / MermaidCanvasView，收敛 XSS 面）
- 新增 `useWindowState` — 窗口大小/位置/maximize 状态持久化（防抖 500ms，恢复时校验宽 ≥400/高 ≥300），重启保持布局
- tools.ts bash 工具外部取消（ctx.abort 监听 + finally 清理 timeoutAbortFn/externalAbortFn）；agentic-loop buildMessages 逐条 dump 日志改 `DEBUG_BUILD_MESSAGES=1` 门控
- telemetry flush：`isCompactionInProgress` 保护 + 失败保留 events 下次重试
- 配置文件 mkdir 改 Rust `make_directory` 命令（修复 fs 权限差异）；git-commit-service / file-change-tracker 走 buildGitCommand + timeout_ms

#### 会话 / 数据

- messagesToLLMMessages 保留 `msg.reasoning` + provider 双分支输出 `reasoning_content`（thinking mode 回传）
- buildMessages 按 toolCallId 精确配对（声明/存活结果 M<N 时只保留被满足的 M 个）
- 全局崩溃提示 guidance 事件监听（App.tsx）

#### 测试

- 新增 repro 测试：repro-ps-command（PowerShell 转义）/ repro-exec-timeout（超时杀树）/ repro-bash-abort（外部取消）/ repro-jsx-classname / repro-redact（脱敏）/ app-error-boundary（REC-R1~R6）/ db-save-failure-alert（DBSAVE-F1~F4）；适配 git-env-config / s0-seam-integration / regression-coding-p0 / regression-knowledge-full（KM-074 动态导入 flaky 30s 超时）
- 全量 141 文件 / 4079 用例通过 + `tsc --noEmit` 零错误 + cargo check 零警告 + cargo test 13/13

## [1.9.3] - 2026-09-02

### 终端功能全面对标 dsh-desktop（审计修复）

- **UI 入口打通** — TitleBar 状态栏终端按钮此前未接线（terminalOpen/onToggleTerminal 未传 props，按钮不渲染；bottomTab 永不为 "terminal"，终端抽屉不可达）。现在按钮点击切换终端抽屉，三个皮肤布局全部可达
- **LLM 终端工具 → 真实 PTY 链路打通** — 重写 terminal-tools.ts：terminal_open→spawn_pty、terminal_send→write_pty、terminal_close→close_pty，会话 ID 即真实 pty-uuid，与 UI 面板共享 Rust portable-pty 后端；删除原内存模拟 + codem-terminal-input 幽灵事件
- **补齐 dsh 六工具语义** — 新增 terminal_read（scrollback 分页，10000 行上限）、terminal_list；terminal_send 支持 submit 参数 + 静默窗口就绪等待（inferred_idle/timeout/session_exit）+ run_in_background（返回 pty-job-*，job_output/job_kill/job_list 集成管理）；terminal_signal 支持 SIGINT/SIGTSTP/Ctrl+D
- **清理死代码** — 删除 terminal-bash-provider.ts（spawn /bin/bash，Windows 不可用，无任何消费方）及 builtin-registry/provider/plugin-registry 3 处注册
- **UI 卡片渲染补强** — ToolCallCard 的 6 个 terminal_* 工具映射到 bash 变体（此前专用卡片不渲染），tryTerminalModel 读 metadata 渲染 viewport/sessionStatus，TerminalBlock 补复制按钮 + 16 行折叠（对标 dsh headTailCap）
- **键位逻辑提取为纯函数** — 新增 terminal-key-handler.ts（保持 P0 约定：Ctrl+C 仅复制、Ctrl+Shift+C 才发 \x03）
- **假测试重写为行为测试** — regression-coding-p0.test.ts P0-1 从源码字符串匹配改为 16 个行为测试（PTY 调用链 + 键位语义 + run_in_background + job 集成），全量 135 文件 / 4051 用例通过


### 顶部状态栏 UI 调整（对标 dsh-desktop 收敛侧栏入口）

- **终端按钮移至主题切换右侧** — TitleBar 顶部状态栏的终端（Terminal）按钮从导航区最左移到暗色/亮色切换按钮右边，贴近 dsh-desktop 的状态栏入口布局
- **隐藏左右侧栏切换按钮** — 隐藏 TitleBar 最左侧（LOGO 旁）的侧边栏收起/展开按钮 + 导航区搜索旁的右侧栏收起/展开按钮；侧边栏仍可通过主对话区 ChatPanel 顶栏按钮切换
- **ChatPanel 顶栏侧边栏按钮图标联动修复** — 收起/展开图标此前硬编码 PanelLeftClose，收起侧边栏后图标不切换；现在新增 sidebarOpen prop 条件渲染（展开=PanelLeftClose / 收起=PanelLeftOpen），三处皮肤布局统一传入状态

### 安全模式（完全访问）修复 — dbReady 时序导致重启后失效

- **修复：选择"完全访问"后重启仍弹审批** — `App.tsx` 的 `securityMode` state 初始化时 DB 尚未就绪（`getDatabase()` 抛错 → 回退默认 `ask`），而 `dbReady` 同步 effect 只同步了 model/mode/provider，漏掉 securityMode。现在 DB 就绪后重新同步，且依赖数组加入 `currentProject?.path`（切换项目按新项目重新解析，项目级 > 全局）
- **委派/后台任务遵循用户安全模式** — `executor.ts` 不再硬编码 `securityMode: "auto"`，改为 `getEffectiveSecurityMode(cwd)`：用户选"完全访问"后跨会话委派任务同样放行；非 full 模式后台自动拒绝需权限操作
- **修复 write 拒绝误判** — `agentic-loop.ts` 的 write 拒绝检测限定为 `name === "write"`：此前任何工具输出含 "User rejected the overwrite" 字面量（如读取本项目源码 tools.ts）都会被误判为用户拒绝写入，导致循环提前停止并输出"写入已被拒绝"（ask/auto/full 全部失效、无审批弹窗）
- 新增回归测试：`repro-security-mode-full`（REPRO-001/002/003）+ `repro-security-mode-engine-link`（ENGINE-001~004）+ `repro-security-mode-project-link` + `repro-security-mode-ui-sync` + `repro-security-mode-db-reset` + `repro-security-mode-ctx`（CTX2-001/002 完整 Cordis ctx 委托路径）+ `repro-write-rejected-false-positive`

### 工具调用配对修复 — API 400 "insufficient tool messages"

- **修复 DeepSeek/OpenAI 严格配对要求** — `buildMessages` 在上下文选择截断部分工具结果时，此前只检查"是否有任何工具结果跟随"，部分截断的配对会溜过 → API 400。现在按 `tool_call_id` 精确配对：声明 N 个 tool_calls 但只有 M<N 个结果存活时，只保留被满足的 M 个（孤儿 tool 结果丢弃）
- 新增回归测试：`repro-tool-pairing-400`

### 输入框历史浏览修复 — wrap 折行误触发

- **修复：多行输入时光标在第二行按 ↑ 直接填充历史** — `.message-input` 是 `pre-wrap` 软换行，旧 guard 只检查 `indexOf("\n")`，wrap 折行（无换行符但视觉两行）时 guard 失效。改为镜像测量（复制 textarea 字体/宽度/行高）判断视觉行：↑ 仅在视觉第一行触发历史，↓ 仅在视觉最后一行触发
- 新增回归测试：`repro-input-history-wrap-guard`（5 用例）

### 记忆检索正则元字符转义

- **修复记忆内容含 `+`/`*`/`(` 等元字符时 `SyntaxError: Invalid regular expression`** — `memory.ts` 内容匹配对用户查询词做 `RegExp` 转义
- 新增回归测试：`repro-memory-regex`

### 引导栏按钮 UI 对标 wecode 优化

- **引导栏从单气泡 + 单按钮改为卡片式三操作**（对标 `.wecode-ref` ChatInputCard）：每条引导显示"待接收/已接收"状态胶囊 + **立刻引导**（主色描边，中断当前回复立即注入）+ **编辑**（取消引导并回填输入框复用 suggestionPrompt 机制）+ **取消**（X 圆形幽灵按钮）
- **样式改为圆角浮卡**：12px 圆角 + 边框 + 阴影 + 居中 max-width 820px + 2 行截断，清理旧 `.guidance-bubble*` 样式

### 思考过程紫色样式恢复（对标 v0.96.0）

- **思考/推理过程改回紫色样式** — `ReasoningRow` 折叠行文字 + Brain 图标改回紫色 `#9333ea`，展开体从灰底灰边框改为淡紫底 + 紫色左边框（与 v0.96.0 视觉一致）

### 其他

- 新增回归测试共 10 个 repro 文件（34 用例），全量测试通过，`tsc --noEmit` 零错误

## [1.9.2] - 2026-09-01

### LLM 请求级超时加固（对标 DSH request_timeout_seconds）

- **complete()（非流式）总超时 120s** — planSteps / compaction 等非流式调用不再可能永久挂起
- **stream()（流式）连接阶段超时 60s** — fetch 到 response headers 阶段有独立超时预算；首字节之后的流式阶段沿用现有 120s idle timeout（SSE 心跳重置）
- **修复关键漏洞：fetch 本身无超时** — 此前服务端接受连接但不返回数据时 fetch 永久挂起，主循环卡死、App 的 finally 不执行、activeSessions 残留 → 会话永久无响应
- **`withRequestTimeout` 合并外部 abort signal 与超时预算** — 任一触发即 abort（对标 DSH request deadline）；`cleanup()` 解除连接阶段超时定时器，避免误杀已开始的正常流
- **`rethrowIfRequestTimeout` 将超时 AbortError 转为带诊断的请求超时错误**（对标 DSH TimeoutError）
- 新增 `llm-timeout-hardening.test.ts`（200 行）

### 安全模式按钮选中态颜色反馈

- **当前生效模式一眼可见** — 编辑框底部安全模式按钮按 ask/auto/full 显示蓝/紫/绿（修复选中后无变色）：`PermissionPresetSelector` 按钮按当前模式附加 `security-ask`/`security-auto`/`security-full` class，`codem-ui.css` 添加对应颜色 + 暗色主题适配

### 引导消息注入体验改造（对标 wecode markGuidanceApplied / Codex steering 消失）

- **注入成功后消息从状态栏移除** — store 新增 `removeGuidanceMessage`：引导消息注入 loop 后立即从 guidance 状态栏移除（不再残留 consumed 标记），状态栏自动消失；`App.tsx` 两处调用点（立即中断注入 + guidance_received 事件）统一改为移除
- **移除 ChatPanel 独立引导输入框** — 删除 GuidanceBlock 渲染 + guidance-input-container，改为 InputArea 复用主输入框：流式期间 `onSendGuidance` 将输入框消息作为引导消息注入（placeholder 提示"回车发送将作为引导消息注入当前任务"），发送按钮变为"停止 + 引导发送"双按钮
- 新增测试 GUIDE-061/062（removeGuidanceMessage 行为）

### LLM 失败可见性（对标 DSH 结构化失败上报，绝不静默结束 turn）

- **移除任务完整性猜测机制** — 删除 `checkTaskCompleteness`/`taskReminderSent`/`toolsCalledInRun`：不再通过正则猜测用户意图注入"任务未完成提醒"伪造 user 消息 + 双写。回归背景：用户引用 "write / App.tsx" 报错文本被误判为"要求保存文件"，注入伪造消息导致莫名其妙的问题。循环防护只由 repeat-tool-reminder 承担（检测真实重复调用链）
- **EMPTY_RESPONSE 空响应检测** — 模型以 stop 结束但无文本/无推理/无工具调用是退化完成，抛错走既有重试路径，重试耗尽后结构化失败上报，绝不猜测用户意图或伪造 user 消息
- **失败必须对用户可见** — ① agentic-loop 失败路径 yield `text_delta`（用户看到 LLM 调用失败 + 自动重试提示，而非"发消息不回复"）② App.tsx `end` 事件对 `too_many_errors`/`error` 显示明确错误消息（不只 overflow）③ App.tsx `tool_error` 对空 toolCall（executeIteration 级错误）上报错误消息
- 新增测试 LOOP-051/052/053（防回归：任务完整性语义 + 失败可见性）

### 其他

- `App.tsx` 移除 BOM 头（文件开头多余 BOM 清理）
- 新增回归测试：`llm-timeout-hardening.test.ts`（200 行）+ `core-guidance-pause-resume` GUIDE-061/062 + `trigger-call-execute-loop` LOOP-051~053
- 全量 119 文件 / 3985 用例通过，`tsc --noEmit` 零错误，`cargo check` 通过

## [1.9.1] - 2026-09-01

### 对话任务步数计算对标改造（Codex 风格宏观计划步）

- **总量固定为计划步数，不再随执行膨胀** — 此前 `第X/X步` 的 total 会随 iteration 无限增长（读文件 → 搜索 → 改文件每一步都算新步骤），现在 total 固定为任务计划步数（分析/读取/修改/验证/总结），中间侦查类小步骤不再改变总量
- **侦查类工具不推进步骤** — `read`/`glob`/`grep`/`tool_search`/`web_search`/`list_directory`/`lsp` 等只读侦查工具归类为 `RECON_TOOL_NAMES`，执行任务时这些小步骤不会让用户看到步数跳动；只有 `write`/`edit`/`bash`/`run_test` 等执行类工具**首次出现**才推进到下一宏步骤
- **步骤标题语义化（中文）** — `getToolTitle` 全量中文化（读取文件/写入文件/修改文件/执行命令/运行测试/委派子智能体等），每个步骤名让用户一眼知道正在解决什么问题
- **追加步骤仅在新执行阶段出现时发生** — 计划步骤全部完成后，若模型仍在执行新操作（发现严重问题/新增任务方向），追加一步并给出语义化标题，而非每 iteration +1

### 文件树显示隐藏文件夹

- **Rust `list_directory` 新增 `show_hidden` 参数** — 默认 false 保持原有隐藏过滤（LLM 工具调用不受影响），传 true 时显示 `.wecode-ref`、`.git`、`.deepseek-harness-ref` 等点开头目录
- **FileExplorer 组件传递 `showHidden: true`** — 右侧边栏文件树、左侧 PanelSidebar 文件树、主面板文件 Tab 统一生效（全部复用 FileExplorer 组件）
- `node_modules` 仍始终过滤（性能考虑）

### 其他修复

- **输入框高度收缩修复** — textarea 是 absolute+inset:0，删除多行内容后高度卡在旧值不恢复；测量前先重置 wrapper/textarea 到 minH，让 scrollHeight 反映真实内容高度
- **安全模式切换按钮修复** — 编辑框底部「请求批准/替我审批/完全访问」点击不生效：compact 模式下拉菜单经 createPortal 渲染到 document.body，外部点击关闭逻辑误判 portal 内容为外部点击，先卸载菜单吞掉后续 click；新增 dropdownRef 排除判定

### 数据库持久化加固（损坏恢复 + 原子写入 + 退出前 flush）

- **损坏数据库自动备份重建** — `initDatabase` 加载后执行 `PRAGMA quick_check` 完整性校验，非 ok 时先把损坏文件备份为 `.corrupt-<timestamp>` 再删除重建，避免带着 "database disk image is malformed" 运行
- **Rust `write_file` 原子写入** — 先写同目录临时文件 + `sync_all`，再 `rename` 覆盖目标；崩溃/并发中途写入不再留下截断的数据库文件
- **DB 保存链串行化** — `enqueueSave` 把写入串在 Promise 链后，并发保存不再重叠写同一文件
- **退出前 flush 等待** — `flushDatabase` 改为返回 Promise；`close-requested` 且行为为「退出」时先 `await flushDatabase()` 再 `quit_app`，避免 fire-and-forget 写一半被杀掉

### PowerShell 命令修复

- **grepSearch 去掉外层 `powershell -Command "..."` 包裹** — 外层双引号让 PowerShell 把整段命令当字符串字面量解析，管道中 `$_` 无管道上下文展开为 $null，grep 静默返回空输出；改传裸命令（Rust 端统一执行）
- **autoLint 路径改单引号包裹** — PowerShell 双引号内 `$` 会做变量展开，含 `#` 的路径（如 `C:\my$dir\file.ts`）被展开为空；单引号内 `$`/反引号不做展开，内部单引号转义为双单引号
- **Rust `execute_command` 防御性剥外层双引号** — 若剩余命令体被一对双引号包裹则剥离，杜绝上述字符串字面量陷阱

### 新增回归测试

- `step-progress-macro.test.ts` — 宏步骤推进 6 例（侦查/执行分类、RECON 集合、中文标题、总量固定语义）
- `file-tree-hidden.test.ts` — 文件树显示隐藏文件夹 4 例（前端传参、Rust 签名、入口复用）
- 全量 118 文件 / 3970 用例通过，`tsc --noEmit` 零错误，`cargo check` 通过

## [1.9.0] - 2026-08-31

### 上下文压缩过早触发治根修复（模型感知窗口 + 压力驱动）

- **TokenTracker.estimateMessagesTokens 永不回落修复** — baseline 仅为下限，不再忽略消息实际增长，压缩后 prompt 从 ~103k 稳定回落到 39k/47k
- **模型真实 contextWindow 同步** — AgenticLoop.run() 从 provider.listModels() 解析模型真实窗口并同步到 tracker，1M 窗口模型（DeepSeek/Gemini/MiMo）此前按 128k 估算导致压力放大 ~8 倍、3 轮即触发压缩
- **micro-compact 压力驱动** — 由纯条数触发改为「条数 > 12 且压力 >= 0.5」，避免长会话过早压缩
- **inferContextWindow 启发式窗口推断** — provider.ts 新增按模型 id 推断窗口（deepseek/gemini/mimo→1M、claude→200k、qwen→32k 等），Server /models 未返回 context_window 时不再一律回退 128k
- **getAgenticLoop 构造时同步 contextWindow** — loop 创建时从 provider 静态/动态模型列表解析窗口，避免构造期回退 128k 直到 run() 才修正

### 通用协议 API 配置（OpenAI 兼容）

- 设置页支持手动输入 Base URL + API key，自动拉取模型列表并持久化
- **刷新模型列表不再丢弃 contextWindow 字段** — SettingsPanel 动态模型 state 类型补全窗口字段，刷新时通过 inferContextWindow 写入，运行时窗口解析不再回退 128k
- 新增 `getFirstConfiguredModel()` 初始模型 fallback：自定义 provider 优先返回其第一个动态模型
- 新增 `resolveProviderForModel()`：支持自定义 provider 的模型 id 路由（不匹配内置前缀时扫描动态模型列表）

### 工具执行正确性修复

- **read 单响应去重键含 offset/limit** — 去重键由裸 path 改为 `path|offset|limit`，模型先读全文再读特定片段时不再被误判为重复调用跳过（此前 readCache 已区分范围但去重层未区分，语义不一致）
- **DecisionTray 审批内容空白修复** — App.tsx 读 `req.args` 改为 `req.input`（PermissionRequest 字段实为 input），bash 显示命令本身、其他工具显示完整参数 JSON，复用 getToolDescription 生成可读描述
- **长命令审批 UI** — 审批参数代码块 max-height + overflow-y 滚动，长命令不再把按钮挤出屏幕

### 其他修复

- Guidance 注入增强：sendGuidance 返回 GuidanceItem、新增 interruptForGuidance 立即中断当前流消费已排队 guidance
- 多行输入历史导航边界处理：上箭头仅首行拦截、下箭头仅末行拦截（doskey 终端行为移植）
- 新增回归测试：context-window-regression.test.ts（8 例）+ custom-provider-config.test.ts + s0-regression-full read 去重范围键用例

## [1.8.0] - 2026-08-31

### 知识图谱 React Flow 重构

- 引入 @xyflow/react (React Flow) 库，替代自研 Canvas 力导向图实现
- 自定义节点组件：按实体类型着色 + 图标 + 径向渐变 + 选中高亮
- 自定义贝塞尔曲线边 + 关系标签
- 内置 MiniMap / Controls / Background
- 保留所有编辑功能：节点编辑/删除、边删除、右键菜单、PNG/JSON 导出

### DSH 框架穿透性修复

- vision-proxy.ts 的 resolveVisionConfig/resolveSTTConfig 统一使用 engine.getConfiguredProvider()

### UI 设计规范化（对标 apple-design）

- 50+ 组件批量 fontSize 数字→CSS 变量替换
- 硬编码颜色→CSS 语义化变量

### 笔记本功能审计（对标 lumina-note）

- 功能完整无断点：Markdown编辑器/WikiLinks/闪卡/知识图谱/标签/版本历史/导出/学习路径

### 依赖更新

- 新增 @xyflow/react ^12.11.5

## [1.7.0] - 2026-08-31

### PPT 生成质量大幅提升 — oh-my-ppt 风格技能集成 + Cordis SkillRegistry 渐进式加载 + 生成链路断点修复

- 集成 oh-my-ppt 项目 74 种风格 SKILL.md + 9 种产品技能（布局/图表/动画等），通过 Vite `import.meta.glob` 构建时收集，运行时注册到 Cordis SkillRegistry
- 修复 PPT 生成两条通路（Studio 一键生成 + 对话中 generate_ppt 工具调用）均经过单次 LLM 调用、AI 无法使用 load_skill 的问题：调用 LLM 前主动从 SkillRegistry 加载当前选中风格的 SKILL.md 注入 systemPrompt，只加载当前 1 个风格 + 产品技能，避免 token 爆炸
- 新增 `ppt-skill-registry.ts` + `skills/` 资源目录，删除旧 `ppt-skill-loader.ts`

## [1.6.2] - 2026-08-29

### 大富翁嵌入式游戏全量交付（Phase 1-10） + 三轮审计 Bug 修复

#### 1. 大富翁桌面游戏 — 完整版（Phase 1-10）

在 Codem 中嵌入完整的大富翁4风格桌面游戏，作为用户等待 LLM 执行任务时的休闲娱乐。游戏作为完全独立的大插件运行，零侵入主项目代码。

**Phase 1-6（基础设施 + 核心玩法）：**
- **棋盘渲染**：Phaser 3 2D 俯视棋盘，36 节点环形布局 + 中心区域信息展示
- **动态骰子**：3D 骰子动画，交通方式决定骰子数（步行1/机车2/汽车3）
- **地产系统**：等级 0-3，地价/建造费/各等级过路费，连锁店标记
- **角色系统**：8 个可选角色，各自不同初始资金/移动/投资能力
- **命运/新闻事件**：40+ 种事件卡，包括移动/金钱/状态/股票效果
- **股票系统**：6 支股票，价格波动 + 买卖 + 分红
- **卡片系统**：10 种卡片，停留/免停留/送人/抢夺/升级/降级/查地图
- **道具系统**：6 种道具，遥控骰子/飞弹/路障/机车/汽车/航母
- **AI 策略**：地产购买评估 + 升级评估 + 股票投资 + 卡牌使用 + 道具使用
- **存档/读档**：完整序列化/反序列化，支持中途保存和恢复

**Phase 7-9（视觉交互 + 核心机制对齐）：**
- **地块图标映射**：每个地块类型对应独特图标
- **角色精灵动画**：移动 Tween 动画 + 跳跃效果
- **消息条系统**：游戏事件实时消息提示
- **物价指数**：全局经济波动机制
- **住院/监狱/酒店/沉睡状态**：完整状态机
- **连锁奖励/税收**：连锁地产过路费翻倍

**Phase 10（G20-G36 开局设置 + 机制补全 + 体验补全）：**

| 编号 | 功能 | 说明 |
|------|------|------|
| G20 | 游戏天数选择 | 开始界面可选 15/30/50/100 天 |
| G21 | 玩家数量选择 | 热座模式 1-4 人 + AI 1-3 个 |
| G22 | 初始资金选择 | 可选 10000/15000/20000/30000 |
| G23 | 胜利条件实现 | 可选 2x/3x/5x/10x 倍率或仅比天数 |
| G24 | 机场/传送点 | 付费传送至任意位置 |
| G25 | 商业地块 | 保险购买 + 建筑公司购买/交费 |
| G26 | 地产主动出售 | 卖地面板列出所有地产，半价出售 |
| G27 | 股票分红 | 每回合自动发放 10% 分红 |
| G28 | 银行拒绝机制 | 5% 概率审查高负债玩家 3 天禁贷 |
| G29 | 多人热座 | 多人类玩家轮流操作 |
| G30 | 帮助/规则 | 完整规则面板含地块/操作/经济说明 |
| G31 | 财富面板 | 资产面板显示地产/股票/卡牌/道具 |
| G32 | 资产清单 | 含在财富面板中 |
| G33 | 日志增强 | 日志颜色 + 物价指数 + 胜利条件显示 |
| G34 | 投降功能 | 确认后没收地产退出 |
| G35 | 音量控制 | 滑块控制 0-100% |
| G36 | 速度调节 | 1x/2x/4x 速度选择 |

#### 2. 三轮审计 Bug 修复

1. **破产清算逻辑** — 修复 `BankruptcySystem.ts` 中现金重复计算 Bug，变卖所得（地产/股票）先累加到 `raised`，然后统一加到玩家 `cash` 中，最后再扣除债务
2. **玩家状态检查** — `GameEngine.ts` 的 `rollDice()` 添加住院/监狱/酒店/沉睡/停留状态检查，无法行动时直接跳过回合
3. **全部破产保护** — 防止 `endTurn()` 中 `do...while` 循环在所有玩家破产时死循环
4. **命运事件前后移动** — 修复 `FortuneSystem.ts` 中 fortune_move 事件（ID 20/21）未实际移动玩家的问题，改为直接移动并发出 `player_teleported` 事件
5. **初始资金应用** — 修复 `setInitCash()` 不追溯应用已有玩家的问题，在 `initGame` 后遍历所有玩家根据角色属性重新计算现金
6. **AI 循环优化** — 游戏结束时停止 AI 轮询，添加 `phase === "ended"` 检查
7. **掷骰跳过检查** — 添加 `phase` 非 `moving` 时跳过自动移动间隔

#### 3. 构建验证
- TypeScript 编译 0 错误
- Vite 构建成功

## [1.6.1] - 2026-08-28

### 桌面宠物独立窗口改造 + 文件输出标识增强 + 设置版本号动态化

#### 1. 桌面宠物单一独立窗口改造（Cordis 插件化架构）
- **移除主窗口内 PetOverlay**：`@codem/ui-pet` 插件改为空壳（`PetOverlayDisabled`），不再在主窗口内渲染宠物覆盖层
- **独立窗口宠物**：宠物窗口作为独立的 Tauri 窗口运行（`PetWindowApp.tsx`），与主窗口共享 WebView2 进程组（实际内存增量仅 ~108MB，全部来自 1 个 renderer 进程）
- **Cordis Provider 封装**：新增 `ui-pet-provider.ts`，通过 `ctx.provide('pet', service)` 注册宠物服务，统一 `App.tsx` 中 `getPet()` 获取入口（优先 Cordis ctx，回退 `usePetStore`）
- **右键菜单合并**：Rust `show_pet_menu` 接收宠物列表参数，构建切换宠物样式子菜单（`SubmenuBuilder`），支持 `pet-switch:{slug}` 事件
- **窗口状态同步**：`emitToPetWindow` 传递 `installedPets` 和 `activeSlug`，`setActivePet(null)` 正确发送完整状态

#### 2. 文件输出标识增强（DSH 风格文件提及）
- **FileMentions 解析器**：新增 `src/utils/file-mentions.ts`，从 `message.toolCalls` 提取 LLM 产出文件路径，构建 `FileMentions` resolver
- **RichContent 集成**：`RichContent` 组件新增 `fileMentions` 属性，inline code 渲染器优先使用 `fileMentions.resolve()` 解析文件路径为可点击按钮，兜底正则扩展名匹配
- **MessageBubble 集成**：从 `message.toolCalls` 构建 `FileMentions` resolver 并传递给 `RichContent`
- **工具提示词强化**：`write`/`edit`/`multi_edit` 工具 `guidance` 字段要求 LLM 在提及文件时使用 Markdown 链接格式
- **i18n-templates 强化**：系统提示词模板强化文件路径引用要求使用 Markdown 链接格式

#### 3. 设置版本号动态化
- `SettingsPanel.tsx` 关于页面版本号从 `package.json` 动态导入（`import { version } from "../../package.json"`），不再需要手动同步

#### 4. 其他
- `pet-store.ts` 新增 `pet-switch-request` 事件监听
- `src/core/pet/index.ts` 注释更新
- 测试文件 `icon-standardization.test.ts` 中 `PetOverlay.tsx` 引用替换为 `PetWindowApp.tsx`
- `src/core/ui-plugins/index.ts` 移除 `@codem/ui-pet` 插件加载，添加 `uiPetProvider`
- `ui-pet-provider.ts` 导入路径修复（`../pet/pet-store`）

## [1.6.0] - 2026-08-27

### SubagentRuntime 架构重构（对标 DSH） + 技能市场 Trees API 改造 + GitHub Token 修复

#### 1. SubagentRuntime 全面重构（对标 DSH `SubagentRuntime` + `spawn` 模式）
- **旧架构删除**：移除 `SubagentManager`（+642 行删除）和 `LLMSubagentSpawner`（-338 行），删除 `spawn_subagent` / `wait_for_subagent` 旧工具
- **新架构**：新增 `SubagentRuntime`（对标 DSH）— 持续后台子智能体运行时
  - `InProcessSpawnProvider` 替代旧 `LLMSubagentSpawner`，支持后台运行 + 自动通知 + 消息延续
  - 4 个新 DSH 风格工具：`subagent`（启动后台子智能体）、`send_message`（向运行中子智能体发消息）、`interrupt_agent`（请求中断）、`list_agents`（列出后台子智能体）
  - `ToolRegistry.createScope()` 隔离工具作用域（对标 Cordis `ctx.isolate('tools')`），子智能体可安全注册专属工具（如 `report`）而不泄漏到主智能体
  - `setGlobalSubagentRuntime` / `getSubagentRuntime` 全局访问（对标 DSH `ctx.provide('subagents', runtime)`）
- **系统提示词改造**：sub-agent collaboration 部分对标 DSH 重写 — 后台默认运行 + 自动通知模式，无需显式 `wait_for`
- **文件**：`src/core/subagent/`（删 spawner.ts -338 行、重构 subagent.ts -309 行、新增 index.ts 全局 runtime）、`src/core/llm/index.ts`、`src/core/llm/tools.ts`、`src/core/prompt/prompt.ts`

#### 2. 技能市场 GitHub Trees API 改造（移植 vercel-labs/skills 官方 CLI 逻辑）
- **核心改造**：将 Contents API 逐层遍历（O(N×M) 次调用）替换为 Trees API 一次性获取全量文件树（1 次调用），在内存中搜索 SKILL.md
- **30+ 前缀支持**：移植官方 `PRIORITY_PREFIXES`，覆盖 Claude / Cline / Goose / Codex / Continue 等 30+ 种 Agent 目录约定（之前仅 4 个硬编码前缀）
- **三大函数改造**：
  - `fetchGitHubRepoSkills`：Trees API 全量搜索 + 优先级排序 + Legacy fallback
  - `fetchGitHubSearchSkills`：每个仓库用 Trees API 搜索任意位置的 SKILL.md（之前仅尝试根目录）
  - `installSkillFromGitHubDir`：Trees API 获取全量树 → 内存筛选目录文件 → 精确下载（不再逐层遍历 + 前缀探测）
- **修复问题**：`dreambigou/eli5`（SKILL.md 在 `skills/eli5/` 子目录）、`cloudflare/cloudflare-docs`（15296 个文件的大仓库）等之前安装失败的技能现在可正常安装
- **文件**：`src/core/skill/skill-market-client.ts`（+551 行重构）

#### 3. GitHub Token 配置链路修复
- **根因**：github-tool / cicd / clone 命令均未从 `codem-git-config` 读取 Token，导致认证缺失
- **修复**：统一 Token 读取链路，所有 GitHub 操作共享 `githubApiHeaders()`
- **文件**：`src/App.tsx`、`src/core/skill/skill-market-client.ts`

#### 4. 其他改动
- i18n-templates 新增子智能体协作提示词模板（+138 行）
- workflow-engine 增强子智能体运行时集成
- 测试文件适配新架构：core-subagent-lifecycle / cordis-functional-loop / full-regression-smoke / regression-coding-p1 等全量适配
- `tsc --noEmit` 零错误

## [1.5.5] - 2026-08-26

### Compaction 并发写入治根修复 + Bash 缓存失效修复

#### 1. compactMessages 数据库并发写入治根修复（对标 DSH `compactSurfaceRegion`）
- **根因**：`compactMessages` 中 DB 操作被 `await`（LLM summarization）拆成两段，`await` 间隙 UI auto-save（`setTimeout` → `saveMessages` → `createMessage` → `db.run`）插入执行，导致 sql.js 单实例被并发操作污染，产生 `bad parameter or other API misuse` 错误
- **DSH 参考**：`compactSurfaceRegion` 将所有异步工作（LLM summarization）前置完成，然后在 `commitCompactionBody` 中同步一次性提交所有 DB 变更（`compaction/summary` + `user/message(replace)` + `compaction/end`），中间无 `await`
- **治根修复**：
  - 将所有 DB 写入集中到 `await` 之后的同步段——先 `await import` 预加载模块，然后同步执行 `deleteMessagesByIds` → `createMessage` → `EventLog.append`，中间无 `await` 间隙
  - 新增 `setCompactionInProgress` / `isCompactionInProgress` 互斥标志（defense-in-depth），`saveMessages` 在 compaction 期间跳过
  - 移除 `compaction_end` 事件中的 `saveMessages` 调用——compaction 后 DB 是唯一真相源，不应把过时的 UI store 状态写回 DB
- **文件**：`src/core/llm/agentic-loop.ts`、`src/store.ts`、`src/core/storage/database.ts`、`src/App.tsx`

#### 2. Bash 工具执行后 readCache 失效修复
- **根因**：`readCache` 在 `read` 工具执行后缓存内容，`write`/`edit` 工具写入时清除对应路径缓存，但 `bash` 工具执行脚本修改文件后不清除 `readCache`——导致 LLM 脚本写入文件后 `read` 仍命中旧缓存（45 行旧内容覆盖 227 行新内容）
- **修复**：bash/execute_command/shell/run_command 工具执行成功后，清除整个 `readCache`（无法知道 bash 命令修改了哪些文件，保守清除是唯一安全做法）
- **文件**：`src/core/llm/agentic-loop.ts`

### v1.5.3-v1.5.4 累积修复

#### 3. 引导消息立即注入（对标 DSH `inject()`）
- `GuidanceQueue` 新增 `unshift` 操作实现高优先级注入
- 通过 `AbortController` 中断当前 LLM 流，配合 `guidanceInterrupt` 标志位引导循环进入下一轮迭代
- 引导消息在下一轮迭代边界注入，不持久化到消息数据库

#### 4. Markdown 文件路径超链接
- `react-markdown` 的 `code` 渲染器中通过正则白名单识别文件路径（`.md|.ts|.json` 等已知扩展名）并转换为可点击的 `<a>` 链接
- 修复正则误匹配问题（改用已知文件扩展名白名单，避免匹配 `obj.prop`）

#### 5. 任务完成标签稳定显示 + 滚动锚定
- 修复 `isTurnEnd` 逻辑，增加滚动重试次数（10次/150ms）确保锚定到任务完成标签
- 禁止自动弹窗干扰

#### 6. 技能市场优化
- 修复搜索时数据源清零及无结果提示问题（保留旧数据的增量更新）
- 新增 `installSkillFromGitHubDir`，利用 GitHub Contents API 递归下载特定目录，规避 1.4GB 仓库整包下载
- 动态获取仓库 `default_branch`，解决 `production` vs `main` 的 404 问题
- SkillHub 市场源加载优化（串行请求改并行 + 12s 超时保护）
- 技能市场搜索超时保护（20s per-source）

#### 7. 其他修复
- micro-compact CACHE HIT wrapper skip
- block-code 单词渲染修复
- file-link cwd 路径解析修复
- 发送按钮图标居中
- sidebar tooltip + context menu
- step plan 动态命名 + click-lock tooltip
- notebook-workspace CSS 语法错误修复
- 知识笔记本面板被标题栏遮挡修复
- dialog 权限修复文件选择器
- 滚动加载历史消息 scroll 监听绑定错误容器修复

## [1.5.2] - 2026-08-24

### 大文件性能修复 + Agent Loop 无上限改造 + 模型系统动态化 + Skills 增量搜索

#### 1. 大文件流式分页读取（对标 DSH TextRetainer）
- Rust 新增 `read_file_lines` 命令：使用 `BufReader` 逐行扫描，内存占用 O(limit) 而非 O(file_size)
- 前端 `read` 工具优先调用分页 API：有 offset/limit 参数时走 `readFileLines`，避免大字符串跨进程传输
- `read_attachment` 工具改用 `readFileLines`：磁盘读取不再全量加载 content
- `listAllAttachments` 查询排除 `content` 大字段，仅在读取时按 ID 获取（懒加载）
- 全量读取 50MB 上限保护：超过则返回错误引导使用分页路径
- **彻底解决**数百 MB 文件分析时前后台卡死问题

#### 2. Agentic Loop 无上限改造（对标 DSH）
- 移除硬编码 `maxIterations` 上限（原 20 轮），改为 `while(true)` 无限循环
- 新增三重安全阀：
  - **连续无进展检测**（MAX_CONSECUTIVE_NO_PROGRESS = 10）：连续 10 次迭代有工具调用但无文本输出且无新工具结果时停止
  - **Token 消耗安全阀**（MAX_TOTAL_TOKENS_PER_RUN = 2,000,000）：总 Token 消耗超过 2M 时停止
  - **子智能体有限迭代**：子智能体仍保留有限 maxIterations 防止递归失控
- 根据触发原因（迭代上限/Token 限制/无进展）输出不同停止提示

#### 3. 记忆提取 API 400 修复
- **根因**：`spawnForked` 深拷贝消息时丢失 `tool_calls`（assistant 消息）和 `toolCallId`（tool 消息）字段
- **修复**：深拷贝逻辑保留 `tool_calls`（JSON.parse/stringify）、`toolCallId`、`name` 字段
- 截断消息列表后清理孤儿 `tool` 消息：检查 `toolCallId` 是否在已知 `tool_calls` ID 集合中

#### 4. 模型系统动态化
- `getConfiguredApiModels` 改为优先读取 `codem-dynamic-models` 存储（设置页面 API 刷新时写入）
- 回退到静态 `API_MODELS` 列表（兼容旧配置）
- `ModelProfilePanel` 移除写死的 `AVAILABLE_PROVIDERS`，改为动态获取
- 更新内置方案：
  - "经济模式"重命名为"常规模式"，主对话用 DeepSeek Pro，子任务用 Flash
  - 新增"经济模式"（全部使用 Flash 模型）
  - "默认模式"和"常规模式"添加视觉理解 slot（DeepSeek-V4-Flash-Vision-Exp）
  - 删除旧的"DeepSeek +视觉代理"和"DeepSeek +视觉代理(MIMO)"模式

#### 5. Skills 市场增量搜索
- 搜索优先查本地缓存（`codem-market-skills-cache`，TTL 30 分钟）
- 本地无结果时自动触发增量联网搜索（600ms 防抖）
- 新增 `searchMarketSkillsOnline` 函数：SkillHub 使用服务端搜索 API（`GET /api/skills?q=`），其他源全量拉取后本地过滤
- 搜索结果合并到本地缓存（去重），下次搜索同一关键词直接命中本地
- `tags` 字段全面规范化防御（`Array.isArray()` 检查）
- 渐进式更新回调中添加 `Array.isArray(sourceSkills)` 检查

#### 6. 终端切换崩溃修复
- **根因**：`TerminalPanel.tsx` 中 `listen` 函数从 `__TAURI__.core` 获取（错误）
- **修复**：改为从 `__TAURI__.event` 获取

#### 7. 权限弹窗位置修复
- `DecisionTray` 从普通块级元素改为 `position: fixed` 定位（bottom: 80px, 居中）
- 不再挤压主对话布局，新增 `slideUp` 动画
- `z-index: 9000` 确保覆盖在对话区域上方

#### 8. 技能市场搜索崩溃修复
- **根因**：`s.tags?.some()` 调用失败，因为 `s.tags` 可能不是数组
- **修复**：`SkillManager.tsx` 过滤逻辑中添加 `Array.isArray(s.tags)` 检查
- `skill-market-client.ts` 中所有 `tags` 字段规范化为 `Array.isArray() ? tags : []`

#### 测试
- 修复 `attachment-system.test.ts`：mock 添加 `readFileLines` 导出
- 修复 `vision-proxy-media.test.ts`：更新内置 profile 模型名称断言
- 新增 `v1.5.2-full-regression.test.ts`：100 个测试用例，覆盖 19 个测试维度
- 全量 113 套件 3947 测试全部通过

## [1.5.1] - 2026-08-23

### DSH 架构对标深度整改 + 严重 Bug 修复 + YAML 声明式插件加载

#### 1. YAML 声明式插件加载器（对标 DSH cordis.patch.yml）
- 新增 `yaml-loader.ts`：解析 YAML 声明（id, name, inject, disabled, when, config, core），按条件过滤平台、通过 id 查找 Plugin 对象、拓扑排序后加载到 Cordis Context
- 新增 `config/codem.base.yml`：所有运行模式共享的核心插件清单（80+ 插件声明，对标 DSH base bundle）
- 新增 `config/codem.desktop.yml`：桌面应用（Tauri）覆盖层（UI 插件 + 桌面专用配置）
- `App.tsx` 启动流程重构：对标 DSH `boot()` → `loadFromEntries(ctx, mergedEntries)` → `assertActivated(ctx, 'codem')` 流程
- `provider/index.ts` 改造：从 `export` 改为 `import + re-export`，确保所有 Provider 在 YAML 加载前完成静态导入

#### 2. 严重 Bug — LLM 回答重复问题（根因修复）
- **根因**：`saveMessages` 函数全量遍历所有消息并无去重地追加到事件日志，导致事件日志中存在大量重复的 `user_message` 和 `assistant_text` 事件。`buildMessages` 优先使用 `deriveMessagesFromEvents`（事件投影），导致重复消息被传给 LLM
- **修复**：
  - 移除 `saveMessages` 中对事件日志的全量重复追加逻辑，现在只负责 DB CRUD
  - `buildMessages` 移除事件投影路径，强制只从 DB 读取消息（DB 为单一读取源）
  - `applyUserMessage` 和 `applyToolResult` 添加去重检查，防止重复事件在投影时产生重复消息
  - 流式助手消息保存逻辑优化：仅在 `text_delta` 或 `tool_start` 时才调用 `saveMessages`

#### 3. 严重 Bug — llmEngine 未注册为 Cordis 服务
- **根因**：`getCtxService('llmEngine')` 永远返回 null，因为 `llmEngine` 从未通过 `ctx.provide()` 注册
- **修复**：在 `getLLMEngine(ctx)` 后调用 `ctx.provide('llmEngine', engine)` 注册为 Cordis 服务，在 YAML 加载之前完成注册

#### 4. 严重 Bug — mimoAuth 服务未注册 + PluginLoader.load() 未调用
- **根因**：`mimoAuth` 从未通过 `ctx.provide()` 注册；`PluginLoader.scan()` 后未调用 `loader.load()`
- **修复**：新增 `mimo-auth-provider.ts` 并通过 YAML 声明注册；所有插件改由 YAML 加载器加载，PluginLoader 只做元数据发现

#### 5. SlotBridge / SlotRenderer 对标 DSH 重构
- `SlotBridge` 对标 DSH `scoped-slots.tsx` 的 `SlotOutlet` + `renderOutletContent` 模式重写
- `SlotRenderer` 对标 DSH：`useSyncExternalStore` 仅用于版本通知，`entries` 在渲染体中读取，`WeakMap` 缓存 subscribe/getVersion 闭包
- 新增 `SlotErrorBoundary` 错误边界：插件组件渲染崩溃时自动回退到 fallback
- fiber `await()` 添加超时保护（5s/10s），避免单个 fiber 永不 resolve 导致启动卡死
- `useCtxReady` hook 优化：Cordis Context 就绪后立即触发重渲染

#### 6. Provider 架构全面整改
- 30+ 个 Provider 文件统一改造：从 `export const xxxProvider` 改为 `import` 后在 `provider/index.ts` 中集中 re-export
- `squadProvider` 拆分为 `squadProvider` + `squadManagerProvider`（消除别名混乱）
- `llm/index.ts` 中 `_getOrThrow` 改为 `_getOrFallback`：ctx.get() 返回 undefined 时回退到模块级单例（容错）
- 所有 Provider 的 `inject` 声明对齐 DSH 模式

#### 7. LLMEngine Provider 增强
- `provider.ts` 新增 `toAPIMessage` 的完整 ContentBlock 处理（tool_use/tool_result）
- `agentic-loop.ts` 精简：移除事件投影路径，消息构建只依赖 DB
- `ollama-provider.ts` 新增本地 LLM 支持
- `replay-adapter.ts` 增强：回放测试支持

#### 8. 其他改进
- `vite.config.ts` 优化构建配置
- `node-crypto-stub.ts` 增强浏览器环境兼容性
- `buffer-polyfill.ts` 新增 Buffer polyfill
- `vite-env.d.ts` 新增类型声明
- 新增 `cordis-architecture-guard.test.ts` / `cordis-extended-methods.test.ts` / `cordis-functional-loop.test.ts` 测试文件

## [1.5.0] - 2026-08-21

### 架构升级 — Cordis "一切插件化" 工具发现机制

对标 DSH (DeepSeek Harness) 的 `ctx.systemPrompt.section()` + `ctx.tools.schemas()` 模式，彻底解决 LLM 工具发现断档问题。工具注册时自带使用引导（guidance），自动注册到 systemPrompt 服务，系统提示词动态收集这些引导来生成工具列表 — 不再硬编码。

#### 1. ToolDef 增加 guidance 字段
- 在 `ToolDef` 接口中新增 `guidance?: string` 字段
- 每个工具自带使用引导，告诉 LLM **何时**和**如何**使用该工具
- 遵循 DSH `defineTool` 的设计理念：工具自描述，而非系统提示词硬编码

#### 2. toolsProvider 改造 — 自动注册工具引导到 systemPrompt
- 对标 DSH `ToolsService` 构造函数中的 `ctx.systemPrompt.tools(provider)` 调用
- **工具注册时**：自动将 `guidance` 注册为 `systemPrompt` 的 prompt section（name: `tool:<id>`, order: 110）
- **工具卸载时**：自动移除对应 prompt section，遵循 Cordis fiber 生命周期
- **动态工具目录**：注册 `tools:catalog` section（order: 100），实时收集所有注册工具的名称和描述
- **延迟注册**：`systemPrompt` 服务尚未可用时，通过 `ctx.effect` 延迟重试

#### 3. buildSystemPrompt 改造 — 工具列表动态生成
- 删除 `prompt.ts` 中硬编码的 "Available Tools" 段（仅列 8 个工具 + 多模态工具说明）
- 新增 `toolGuidance` 配置字段，由 `LLMEngine.collectToolGuidance()` 动态注入
- 回退路径：当 `toolGuidance` 为空时使用最小化 fallback
- 文件附件规则保留为独立段（非工具特定引导）

#### 4. LLMEngine 新增工具引导收集方法
- `collectToolGuidance()`（异步）：优先从 `systemPrompt.assemble()` 收集所有 `tool:*` 和 `tools:*` 段
- `collectToolGuidanceSync()`（同步）：从 `ToolRegistry.getAll()` 直接收集 `guidance` 字段
- 两条路径都有完整的工具列表 + 使用引导输出

#### 5. 全部 31 个工具补充 guidance 文案
- **核心工具**（11 个）：bash, read, write, edit, multi_edit, glob, grep, tts, image_gen, spawn_subagent, wait_for_subagent
- **能力工具**（8 个）：load_skill, web_search, read_attachment, search_notebook, ask_clarification, fact_check, show_todo, exit_plan_mode
- **高级工具**（6 个）：lsp, run_code, tool_search, browser_automate, figma_fetch, github_tool
- **笔记工具**（4 个）：create_note, edit_note, link_notes, delete_note
- **会话工具**（4 个）：session_search, session_event_search, session_trace, session_event_read
- **目标工具**（3 个）：create_goal, get_goal, update_goal
- **终端工具**（4 个）：terminal_open, terminal_send, terminal_signal, terminal_close
- **任务工具**（2 个）：job_list, job_output
- **协同工具**（4 个）：delegate_to_session, wait_for_delegation, query_session_result, list_sessions
- **小队工具**（3 个）：squad_list, squad_dispatch, squad_status
- **Issue 工具**（4 个）：issue_create, issue_update, issue_comment, issue_list
- **工作流工具**（1 个）：workflow
- **动态插件工具**（5 个）：cordis_define, cordis_inspect, cordis_run, cordis_stop, cordis_undefine

#### 6. skill-creator 技能增强
- 更新 `SKILL.md`，增加详细的技能安装指令
- 指导 LLM 使用 `write`/`bash` 工具从 URL 或 ZIP 安装技能到 `~/.codem/skills/`
- 在 `load_skill` 工具中增加文件系统回退机制，自动扫描 `~/.codem/skills/` 发现新创建的技能

## [1.4.2] - 2026-08-20

### Bug 修复 + 架构增强（14 项）

#### Bug 1 — 默认模型显示错误（彻底修复）
- **根因**：`App.tsx` 中 `_initialModel` 计算和 `configureEngine` 逻辑在 DB 未就绪时无法正确读取已保存的模型配置，导致启动时始终显示 CLI 默认模型 `mimo-v2.5-pro` 而非上次保存的 API 模型
- **修复**：`dbReady` 时同步读取 settings 更新 model/mode/provider；`engineRef` 的 `useEffect` 在 DB 就绪后重新调用 `configureEngine`；`model-badge` 显示友好名称；`getConfiguredApiModels` 中 `name` 属性从 `m.id` 改为 `m.name`

#### Bug 2 — 右侧边栏 CI/CD 面板被外窗口遮挡（彻底修复）
- **根因**：`PanelSidebar` 使用常规 DOM 渲染，被主对话框的滚动条和层级遮挡；且 `right` 和 `maxWidth` 计算不准确
- **修复**：`PanelSidebar` 使用 `createPortal` 渲染到 `document.body`，提升 `z-index`；调整 `right` 和 `maxWidth` 确保 CI/CD 面板完整可见

#### Bug 3 — 默认皮肤底部栏 UI 不一致 + 多余模型选择器
- **根因**：`InputArea` 底部栏有独立的 `ModelSelector`，与顶部模型选择器重复且样式不一致
- **修复**：删除 `InputArea` 底部栏的 `ModelSelector` 渲染逻辑；调整 `.input-control-bar` 样式

#### Bug 4 — 输入框聚焦时出现紫色边框
- **根因**：`.composer-inner:focus-within` 的 `border-color` 使用了紫色主题色
- **修复**：`.composer-inner:focus-within` 的 `border-color` 改为 `transparent`

#### Bug 5 — 技能市场加载慢（缓存机制）
- **根因**：每次进入技能市场都从三大源（ClawHub/Skills.sh/SkillHub）实时请求，无缓存
- **修复**：实现技能市场缓存机制 — 首次加载后缓存列表信息，再次进入时先加载缓存快速显示；刷新按钮改名为"检查更新"，点击时更新列表并覆盖缓存

#### Bug 6 — Git 分支按钮未居中 + 一直刷新
- **根因**：`.titlebar-center` 缺少居中样式；`GitBranchSelector` 的 `refreshInterval` 逻辑有 bug，且未检查是否为 git 仓库
- **修复**：为 `.titlebar-center` 添加居中样式；修复 `GitBranchSelector` 的 `refreshInterval` 逻辑，添加是否为 git 仓库的检查；`!workDir` 时返回占位按钮而非 `null`

#### Bug 7 — 右侧边栏边缘白色背景 + 拖拽影响左侧边栏
- **根因**：`.app-content` 有 `padding-right` 导致右侧露出白色背景；`.sidebar` 缺少 `position: relative` 导致拖拽事件冒泡影响左侧边栏宽度
- **修复**：移除 `.app-content` 的 `padding-right`；给 `.sidebar` 添加 `position: relative`

#### Bug 8 — 顶部栏左侧和左侧边栏之间空白区域
- **根因**：`.sidebar-header` 占据空间但在新版布局中已不需要
- **修复**：删除 `.sidebar-header`，将收起按钮移入 `.sidebar-nav`；恢复 `.titlebar-icon` 和 `.titlebar-title` 的显示

#### Bug 9 — CicdPanel 白色背景
- **根因**：`CicdPanel` 有硬编码的白色背景
- **修复**：`CicdPanel` 背景改为 `transparent`

#### Bug 10 — 顶部栏右侧按钮被居中（Bug 6 修复副作用）
- **根因**：修复 Git 分支按钮居中时，`.titlebar-left` 和 `.titlebar-nav-actions` 缺少 `flex-shrink: 0`，导致右侧按钮也被居中
- **修复**：为 `.titlebar-left` 和 `.titlebar-nav-actions` 添加 `flex-shrink: 0`；修改 `.titlebar` flex 布局使 Git 分支按钮居中、右侧按钮靠右

#### 增强 1 — Cordis 插件系统时序改进（三步方案）
- **第一步**：`getCordisContext()` 中将 `setTimeout(0)` 替换为显式等待所有 fiber 就绪 (`fibers.map(f => f.await())`)，并添加 fiber 状态日志
- **第二步**：`consumer/index.ts` 中为关键服务获取函数（`callLLM`、`callTool`）添加重试等待机制 (`getServiceAsync`)，`_ctxReady` 状态追踪
- **第三步**：`loadDefaultProviders()` 中添加 `internal/status` 事件监听器，记录 fiber 状态变更日志，便于诊断时序问题

#### 增强 2 — SlotBridge 降级机制健壮性增强
- 新增 `SlotErrorBoundary` 包裹插件组件，崩溃时自动回退到 fallback
- `renderFallback` 函数统一处理 fallback 逻辑，`fallback={null}` 时输出诊断日志而非静默失败
- 为关键 slot（`app.sidebar`、`app.conversation`、`app.titlebar`、`app.boot-splash`、Hub 皮肤 `app.skin-layout`）添加 `showDegraded` prop，异常时显示降级提示
- `SlotListBridge` 在 slots 服务不可用时输出警告日志

#### 增强 3 — 头像系统升级
- 从 Multiavatar 切换回 DiceBear API（URL 生成方式，无需 npm 依赖）
- 预设头像从 12 个扩展到 50 个，混合多种 DiceBear 风格（adventurer/avataaars/big-ears/big-smile/bottts/croodles/fun-emoji/lorelei/micah/miniavs/open-peeps/personas/pixel-art）

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
