/**
 * 工具 / 技能 / MCP 管理界面图标映射表
 *
 * 图标来源：lucide-react（ISC 开源协议，可自由使用）
 * https://github.com/lucide-icons/lucide
 *
 * ⚠️ 知识产权声明：
 *   - 图标本身来自开源库 lucide-react，可自由使用。
 *   - 图标的选用参考了对标项目的视觉风格，但所有代码、函数名、
 *     组件结构均为本团队自主编写，未复制对标项目的任何源代码。
 *   - 后续对标开发工具 / 技能 / MCP 管理界面时，直接引用此映射表即可。
 *
 * 维护说明：
 *   - 新增工具或技能类别时，在对应的 Record 中添加映射。
 *   - 图标命名保持与 lucide-react 一致，方便查找替换。
 */

import {
  // ── 管理面板标题图标 ──
  Sparkles,        // 技能管理标题
  Server,          // MCP 管理标题
  Wrench,          // 工具管理标题

  // ── 工具类别图标（管理界面用） ──
  Terminal,        // bash / shell
  FileText,        // read
  FilePlus,        // write
  FileEdit,        // edit
  Search,          // glob / search
  Globe,           // webfetch / websearch
  BookOpen,        // notebook
  ClipboardList,   // plan / task
  HelpCircle,      // question
  Bot,             // actor / agent
  Brain,           // memory
  Workflow,        // workflow
  Radio,           // lsp
  Database,        // database query
  Image,           // image generation
  Video,           // video generation
  Code2,           // code execution
  GitBranch,       // git operations
  Download,        // download / export
  Upload,          // upload / import
  Mail,            // email / inbox
  Calendar,        // scheduling
  Table,           // table / spreadsheet
  Webhook,         // webhook / API call

  // ── 技能来源图标 ──
  Package,         // builtin 内置
  FolderGit2,      // project 项目级
  User,            // user 用户级
  Globe2,          // external 外部 / 社区

  // ── 操作按钮图标 ──
  Plus,            // 新增
  Pencil,          // 编辑
  Trash2,          // 删除
  RefreshCw,       // 刷新 / 重载
  Power,           // 启用 / 禁用（开关）
  Eye,             // 查看详情
  Settings,        // 设置
  ExternalLink,    // 外部链接 / 文档
  Link2,           // 关联 / 绑定
  KeyRound,        // 密钥 / 认证
  ChevronDown,     // 展开
  ChevronUp,       // 收起
  ArrowDownToLine, // 下载（导出技能包）
  FolderUp,        // 上传（导入技能包）
  Copy,            // 复制
  Check,           // 确认 / 已连接
  X,               // 关闭 / 取消 / 断开

  // ── 状态图标 ──
  Loader2,         // 加载中（旋转动画）
  CheckCircle2,    // 成功
  XCircle,         // 失败
  AlertCircle,     // 警告
  AlertTriangle,   // 错误
  Clock,           // 等待 / 排队
  PauseCircle,     // 暂停
  PlayCircle,      // 运行中
  CircleDashed,    // 未激活 / 空闲

  // ── MCP 专用图标 ──
  Plug,            // MCP 连接
  PlugZap,         // MCP 已连接（带电）
  Unplug,          // MCP 断开
  Network,         // MCP 网络 / 传输
  ShieldCheck,     // MCP 权限 / 安全
  Boxes,           // MCP 资源列表
  FileJson,        // JSON 配置导入
  Layers,          // MCP Provider 层

  // ── 通用 ──
  Filter,          // 筛选
  Tag,             // 标签
  Info,            // 信息

  // ── 技能市场专用 ──
  Store,           // 市场标题
  Star,            // GitHub Star
  type LucideIcon,
} from "lucide-react";

// ============================================================
//  管理面板标题图标
// ============================================================
export const PanelIcons = {
  skills: Sparkles,
  mcp: Server,
  tools: Wrench,
} as const;

// ============================================================
//  工具类别图标（管理界面）
//  键名与 tool name 保持一致，便于查找
// ============================================================
export const ToolIcons: Record<string, LucideIcon> = {
  // ── 核心工具 ──
  bash: Terminal,
  read: FileText,
  write: FilePlus,
  edit: FileEdit,
  glob: Search,
  grep: Search,
  webfetch: Globe,
  websearch: Globe,
  notebook: BookOpen,
  plan: ClipboardList,
  question: HelpCircle,
  actor: Bot,
  task: ClipboardList,
  memory: Brain,
  skill: Sparkles,
  workflow: Workflow,
  lsp: Radio,

  // ── 扩展工具（对标开发时使用） ──
  "web_search": Search,
  "read_attachment": FileText,
  "load_skill": Sparkles,
  "image_gen": Image,
  "video_gen": Video,
  "code_exec": Code2,
  "git_op": GitBranch,
  "data_export": Download,
  "data_import": Upload,
  "email": Mail,
  "schedule": Calendar,
  "table_query": Table,
  "webhook_call": Webhook,
  "db_query": Database,
};

/** 获取工具图标，未注册时返回 Wrench 兜底 */
export function getToolIcon(name: string): LucideIcon {
  return ToolIcons[name] ?? Wrench;
}

// ============================================================
//  技能来源图标
// ============================================================
export const SkillSourceIcons: Record<string, LucideIcon> = {
  builtin: Package,
  project: FolderGit2,
  user: User,
  external: Globe2,
};

export function getSkillSourceIcon(source: string): LucideIcon {
  return SkillSourceIcons[source] ?? Globe2;
}

// ============================================================
//  操作按钮图标
// ============================================================
export const ActionIcons = {
  add: Plus,
  edit: Pencil,
  delete: Trash2,
  refresh: RefreshCw,
  toggle: Power,
  view: Eye,
  settings: Settings,
  externalLink: ExternalLink,
  link: Link2,
  key: KeyRound,
  expand: ChevronDown,
  collapse: ChevronUp,
  download: ArrowDownToLine,
  upload: FolderUp,
  copy: Copy,
  confirm: Check,
  close: X,
} as const;

// ============================================================
//  状态图标
// ============================================================
export const StatusIcons = {
  loading: Loader2,
  success: CheckCircle2,
  error: XCircle,
  warning: AlertCircle,
  danger: AlertTriangle,
  pending: Clock,
  paused: PauseCircle,
  running: PlayCircle,
  idle: CircleDashed,
} as const;

export function getStatusIcon(status: "loading" | "success" | "error" | "warning" | "danger" | "pending" | "paused" | "running" | "idle"): LucideIcon {
  return StatusIcons[status];
}

// ============================================================
//  MCP 专用图标
// ============================================================
export const McpIcons = {
  connect: Plug,
  connected: PlugZap,
  disconnect: Unplug,
  network: Network,
  security: ShieldCheck,
  resources: Boxes,
  jsonImport: FileJson,
  providers: Layers,
} as const;

// ============================================================
//  通用图标
// ============================================================
export const CommonIcons = {
  filter: Filter,
  tag: Tag,
  info: Info,
} as const;

// ============================================================
//  技能市场图标
// ============================================================
export const MarketIcons = {
  store: Store,
  star: Star,
} as const;

// ============================================================
//  聊天内工具渲染 Emoji 映射（保持现有方案不变）
//  管理界面使用 LucideIcon，聊天消息内继续使用 Emoji
// ============================================================
export const ToolEmojis: Record<string, string> = {
  bash: "💻",
  read: "📖",
  write: "📝",
  edit: "✏️",
  glob: "🔍",
  grep: "🔎",
  webfetch: "🌐",
  websearch: "🔍",
  notebook: "📓",
  plan: "📋",
  question: "❓",
  actor: "🤖",
  task: "📋",
  memory: "🧠",
  skill: "🛠️",
  workflow: "🔄",
  lsp: "📡",
};

export function getToolEmoji(name: string): string {
  return ToolEmojis[name] ?? "🔧";
}
