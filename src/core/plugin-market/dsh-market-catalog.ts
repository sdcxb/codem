/**
 * dsh 插件市场目录（对标 dsh-desktop / deepseek-harness 插件生态）。
 *
 * 数据来自 deepseek-harness 官方仓库实际发布的 @deepseek-ai/dsh-* 包
 * （packages/<group>/<pkg>/package.json）。Codem 无法像 Electron/Node 端那样
 * 从 node_modules 加载任意 npm 包（无包运行时），因此每个条目带**兼容性评估**：
 *
 *   - bundled    ：dsh 该能力 Codem 已内置等价实现（codemAnchor 指向插件管理
 *                  中的 @codem/* 插件），"安装"= 在插件管理中启用对应内置插件；
 *   - adaptable  ：按 dsh 协议（capability seams / slots / guidance）编写的插件
 *                  可经 @codem/dsh-compat 桥接层适配运行（需无第三方 npm 依赖、
 *                  以可加载 JS 形态提供）—— Codem 动态插件运行器可加载；
 *   - unsupported：依赖第三方 npm 包/Node API，桌面浏览器运行时无法直接加载。
 *
 * 评估原则：诚实标注边界 —— "完美兼容"仅适用于 bundled 与部分 adaptable；
 * 其余需移植或不可运行，绝不假装可安装。
 */

export type DshMarketStatus = 'bundled' | 'adaptable' | 'unsupported'
export type DshMarketCategory = 'capability' | 'tool' | 'ui' | 'infra'

export interface DshMarketEntry {
  /** dsh 官方包名 */
  dshName: string
  /** 简短能力说明（源自官方包语义） */
  dshDesc: string
  category: DshMarketCategory
  status: DshMarketStatus
  /** bundled：Codem 插件管理中的等价内置插件名（@codem/*） */
  codemAnchor?: string
  /** 评估说明 */
  note: string
}

/** 内置市场目录（50 条真实官方能力/工具包——包名与 harness packages 全量核对；
 *  bundled 37 / adaptable 9 / unsupported 4；bundled 锚一对一唯一，见 DM-4）。 */
export const DSH_MARKET_CATALOG: DshMarketEntry[] = [
  // ===== bundled：Codem 已内置等价能力 =====
  { dshName: '@deepseek-ai/dsh-llm', dshDesc: 'LLM 服务定义与调用能力（chat/stream/usage）', category: 'capability', status: 'bundled', codemAnchor: '@codem/llm', note: 'Codem 内置 LLM 引擎，安装即启用对应内置服务插件' },
  { dshName: '@deepseek-ai/dsh-fs', dshDesc: '文件系统能力（read/write/list seam）', category: 'capability', status: 'bundled', codemAnchor: '@codem/fs-local', note: '由内置 fs-local 提供（读/写/列目录/Rust 原子写）' },
  { dshName: '@deepseek-ai/dsh-shell', dshDesc: 'Shell 命令执行能力', category: 'capability', status: 'bundled', codemAnchor: '@codem/shell-local', note: '由内置 shell-local 提供（execute_command + 超时杀树）' },
  { dshName: '@deepseek-ai/dsh-tool-bash', dshDesc: 'bash 执行工具（含持久会话）', category: 'tool', status: 'bundled', codemAnchor: '@codem/tool-bash-persistent', note: 'bash 工具为 Codem 核心工具，持久会话对应 terminal PTY 体系' },
  { dshName: '@deepseek-ai/dsh-session', dshDesc: '会话存储/投影/事件溯源', category: 'infra', status: 'bundled', codemAnchor: '@codem/session', note: 'Codem 会话+事件日志（session_events）已内置' },
  { dshName: '@deepseek-ai/dsh-tools', dshDesc: '工具注册服务（schema/guidance/作用域）', category: 'infra', status: 'bundled', codemAnchor: '@codem/tools', note: 'Codem ToolRegistry + guidance 自动注入已对齐' },
  { dshName: '@deepseek-ai/dsh-compaction', dshDesc: '上下文压缩能力（surface 替换）', category: 'infra', status: 'bundled', codemAnchor: '@codem/compaction', note: 'Codem compact/micro-compact/折叠摘要已内置' },
  { dshName: '@deepseek-ai/dsh-compaction-tool-result-pruner', dshDesc: '工具结果 head/tail 裁剪（8192/4096/1024）', category: 'infra', status: 'bundled', codemAnchor: '@codem/compaction-tool-result-pruner', note: 'context-fold 的陈旧结果裁剪同款实现' },
  { dshName: '@deepseek-ai/dsh-agent-instructions', dshDesc: '系统提示词分层（rules/sections 装配）', category: 'capability', status: 'bundled', codemAnchor: '@codem/agent-instructions', note: 'Codem systemPrompt sections（工具 guidance 自动注册）已对齐' },
  { dshName: '@deepseek-ai/dsh-time-context', dshDesc: '时间上下文注入（日期/时区）', category: 'capability', status: 'bundled', codemAnchor: '@codem/time-context', note: '内置时间上下文' },
  { dshName: '@deepseek-ai/dsh-credentials', dshDesc: '凭证能力（env/.env provider）', category: 'infra', status: 'bundled', codemAnchor: '@codem/credentials', note: '内置凭证管理（API key 存储）' },
  { dshName: '@deepseek-ai/dsh-fs-observation-policy', dshDesc: '文件观察策略（tool 结果完整性）', category: 'infra', status: 'bundled', codemAnchor: '@codem/fs-observation-policy', note: '内置同名能力' },

  // —— 第二批官方包（能力/工具/运行时，锚点已核对 runtimePluginList 存在）——
  { dshName: '@deepseek-ai/dsh-llm-deepseek', dshDesc: 'DeepSeek 原生 LLM Provider（chat/stream/reasoning）', category: 'capability', status: 'bundled', codemAnchor: '@codem/llm-deepseek', note: '内置 DeepSeek provider（reasoning_content 回传等已对齐）' },
  { dshName: '@deepseek-ai/dsh-llm-retry', dshDesc: 'LLM 重试/传输恢复（结构化错误分类）', category: 'infra', status: 'bundled', codemAnchor: '@codem/llm-retry', note: '内置 RetryExecutor + 超时分级' },
  { dshName: '@deepseek-ai/dsh-token-meter', dshDesc: 'Token 计量/上下文压力估算', category: 'infra', status: 'bundled', codemAnchor: '@codem/token-meter', note: '内置 TokenTracker（窗口感知压力/预算）' },
  { dshName: '@deepseek-ai/dsh-lsp', dshDesc: 'LSP 语言服务器能力（definition/references）', category: 'capability', status: 'bundled', codemAnchor: '@codem/lsp', note: '内置 LSP 服务（工具内注册 lsp 调用）' },
  { dshName: '@deepseek-ai/dsh-plan-mode', dshDesc: 'Plan Mode（计划审批后执行）', category: 'infra', status: 'bundled', codemAnchor: '@codem/plan-mode', note: '内置 Plan mode（exit_plan_mode 工具）' },
  { dshName: '@deepseek-ai/dsh-sandbox-local', dshDesc: '本地沙箱能力', category: 'infra', status: 'bundled', codemAnchor: '@codem/sandbox-local', note: '内置路径级沙箱' },
  { dshName: '@deepseek-ai/dsh-sandbox-policy', dshDesc: '沙箱策略（工作区放行规则）', category: 'infra', status: 'bundled', codemAnchor: '@codem/sandbox-policy', note: '内置沙箱策略服务' },
  { dshName: '@deepseek-ai/dsh-fs-sandbox', dshDesc: '沙箱虚拟文件系统', category: 'infra', status: 'bundled', codemAnchor: '@codem/fs-sandbox', note: '内置 fs-sandbox' },
  { dshName: '@deepseek-ai/dsh-schedule', dshDesc: '定时提醒/调度能力', category: 'infra', status: 'bundled', codemAnchor: '@codem/schedule', note: '内置 schedule（提醒工具）' },
  { dshName: '@deepseek-ai/dsh-settings-file', dshDesc: '设置文件 provider（持久化用户设置）', category: 'infra', status: 'bundled', codemAnchor: '@codem/settings', note: '内置设置（SQLite settings 表）' },
  { dshName: '@deepseek-ai/dsh-session-persistence-sqlite', dshDesc: '会话 SQLite 持久化', category: 'infra', status: 'bundled', codemAnchor: '@codem/session-persistence-sqlite', note: '内置 sql.js 会话持久化' },
  { dshName: '@deepseek-ai/dsh-session-query-sqlite', dshDesc: '会话全文查询（FTS5）', category: 'infra', status: 'bundled', codemAnchor: '@codem/session-query-sqlite', note: '内置 session_search（FTS5）' },
  { dshName: '@deepseek-ai/dsh-session-title-llm', dshDesc: 'LLM 会话标题生成', category: 'infra', status: 'bundled', codemAnchor: '@codem/session-title-llm', note: '内置标题生成' },
  { dshName: '@deepseek-ai/dsh-tool-fs-search', dshDesc: '文件搜索工具（内容/名称）', category: 'tool', status: 'bundled', codemAnchor: '@codem/tool-fs-search', note: '内置同名工具插件' },
  { dshName: '@deepseek-ai/dsh-tool-str-replace-editor', dshDesc: '字符串替换编辑器工具（精确查找替换）', category: 'tool', status: 'bundled', codemAnchor: '@codem/tool-str-replace-editor', note: '内置同名工具插件' },
  { dshName: '@deepseek-ai/dsh-commands', dshDesc: '命令注册/快捷键能力', category: 'infra', status: 'bundled', codemAnchor: '@codem/commands', note: '内置命令服务' },
  { dshName: '@deepseek-ai/dsh-user-approval', dshDesc: '用户审批流程（关键操作人工确认）', category: 'infra', status: 'bundled', codemAnchor: '@codem/user-approval', note: '内置审批（ask/auto/full 安全模式）' },
  { dshName: '@deepseek-ai/dsh-persona', dshDesc: '人格管理（Agent 行为风格）', category: 'capability', status: 'bundled', codemAnchor: '@codem/persona', note: '内置人格管理' },
  { dshName: '@deepseek-ai/dsh-tool-goal', dshDesc: 'goal 工具组（create/get/update）', category: 'tool', status: 'bundled', codemAnchor: '@codem/goal-round-driver', note: '内置 goal 工具 + 自动续行驱动' },
  { dshName: '@deepseek-ai/dsh-tool-jobs', dshDesc: '后台任务工具（job_list/output/kill）', category: 'tool', status: 'bundled', codemAnchor: '@codem/tool-jobs', note: '内置 JobManager 工具' },
  { dshName: '@deepseek-ai/dsh-mcp-client', dshDesc: 'MCP 客户端（stdio/http）', category: 'infra', status: 'bundled', codemAnchor: '@codem/mcp', note: '内置 MCP 注册表与 stdio/http 连接' },
  { dshName: '@deepseek-ai/dsh-repeat-tool-reminder', dshDesc: '重复工具调用提醒（loop 卫生）', category: 'infra', status: 'bundled', codemAnchor: '@codem/repeat-tool-reminder', note: '内置 guard 插件' },
  { dshName: '@deepseek-ai/dsh-tool-call-timeout-policy', dshDesc: '工具调用超时策略', category: 'infra', status: 'bundled', codemAnchor: '@codem/tool-call-timeout-policy', note: '内置 timeout-guard' },
  { dshName: '@deepseek-ai/dsh-session-log-export', dshDesc: '会话日志导出', category: 'infra', status: 'bundled', codemAnchor: '@codem/session-log-export', note: '内置日志导出服务' },
  { dshName: '@deepseek-ai/dsh-session-telemetry-otel', dshDesc: '会话遥测（OpenTelemetry）', category: 'infra', status: 'bundled', codemAnchor: '@codem/session-telemetry-otel', note: '内置 telemetry 采集' },

  // ===== adaptable：dsh 协议插件可经 dsh-compat 桥接（无第三方依赖时可加载）=====
  { dshName: '@deepseek-ai/dsh-tool-todo', dshDesc: 'todo_write 工具（语义任务列表整表维护）', category: 'tool', status: 'adaptable', note: 'Codem 有等价 show_todo/todo 体系；dsh 工具插件经 dsh-compat 桥接可适配' },
  { dshName: '@deepseek-ai/dsh-file-reference', dshDesc: '文件引用（代码库检索 read_at）', category: 'tool', status: 'adaptable', note: '需适配到 Codem 检索/分页读取语义' },
  { dshName: '@deepseek-ai/dsh-tmux-context', dshDesc: 'tmux 上下文注入（持久终端会话）', category: 'capability', status: 'adaptable', note: '可映射到 Codem PTY 终端体系（适配注入格式）' },
  { dshName: '@deepseek-ai/dsh-cordis-client-runner', dshDesc: 'Cordis 客户端运行器（RPC 子进程）', category: 'infra', status: 'adaptable', note: 'Codem host/sdk 协议已有同类能力，按需适配' },
  { dshName: '@deepseek-ai/dsh-hooks-claude-code', dshDesc: 'Claude Code hook 桥（stop/pre-tool 事件）', category: 'infra', status: 'adaptable', note: '可映射到 Codem hooks 系统（hook-protocol 语义）' },
  { dshName: '@deepseek-ai/dsh-hooks-codex', dshDesc: 'Codex hook 桥（原生 git hook）', category: 'infra', status: 'adaptable', note: '可映射到 Codem hooks 系统' },
  { dshName: '@deepseek-ai/dsh-agent-presets', dshDesc: 'Agent 预设组合（preset 装配）', category: 'infra', status: 'adaptable', note: 'Codem preset 为配置预设，agent 组合语义可映射适配' },
  { dshName: '@deepseek-ai/dsh-tool-lsp', dshDesc: 'LSP 工具（definition/hover/references）', category: 'tool', status: 'adaptable', note: 'Codem lsp 已注册为工具（非独立插件），dsh 工具形态可适配' },
  { dshName: '@deepseek-ai/dsh-tool-fs', dshDesc: '模型侧文件工具（read/write/edit，基于 ctx.fs）', category: 'tool', status: 'adaptable', note: 'read/write/edit 为 Codem 核心工具（默认启用、无独立开关）；dsh 工具插件形态可经 dsh-compat 适配到核心工具集（搜索类见 dsh-tool-fs-search）' },

  // ===== unsupported：依赖 Node/npm 运行时，桌面浏览器形态无法加载 =====
  { dshName: '@deepseek-ai/dsh-code-runtime-python', dshDesc: 'Python 代码运行时', category: 'infra', status: 'unsupported', note: '依赖 Python 进程/绑定，Codem 内通过 bash 调用（不提供包内运行时）' },
  { dshName: '@deepseek-ai/dsh-e2b', dshDesc: 'E2B 云沙箱（远程隔离执行）', category: 'infra', status: 'unsupported', note: '第三方云服务 SDK；Codem 侧未内置等价服务' },
  { dshName: '@deepseek-ai/dsh-cordis-host-runner', dshDesc: 'Cordis Host 运行器（服务端编排）', category: 'infra', status: 'unsupported', note: 'Node 服务端进程能力，桌面浏览器内不可运行' },
  { dshName: '@deepseek-ai/dsh-goal', dshDesc: 'goal 状态与生命周期服务（事件溯源，同会话）', category: 'infra', status: 'unsupported', note: '依赖 zod/@deepseek-ai 内部依赖（桌面运行时无法解析 npm 包）；Codem goalRoundDriver 服务已内置等价——要启用请安装 dsh-tool-goal 条目' },
]

/** 在线检索 npm 上的 dsh 生态插件（name/desc/version/homepage）。 */
export interface NpmPluginHit {
  name: string
  version: string
  description: string
  homepage?: string
  keywords?: string[]
}

/**
 * 通过 npm registry 搜索真实 dsh 生态包（仅元数据，无安装执行）。
 * 超时/失败返回 []，绝不阻断 UI。
 */
export async function searchDshNpmPackages(query = 'dsh cordis plugin', limit = 30): Promise<NpmPluginHit[]> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15_000)
    const url = `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(query)}&size=${limit}`
    const res = await fetch(url, { signal: controller.signal })
    clearTimeout(timer)
    if (!res.ok) return []
    const data: any = await res.json()
    return (data?.objects ?? []).map((o: any) => ({
      name: o.package?.name ?? '',
      version: o.package?.version ?? '',
      description: o.package?.description ?? '',
      homepage: o.package?.links?.homepage ?? o.package?.links?.repository,
      keywords: o.package?.keywords ?? [],
    })).filter((p: NpmPluginHit) => p.name && !p.name.includes('@deepseek-ai/dsh-client-'));
  } catch {
    return []
  }
}
