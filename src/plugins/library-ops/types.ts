/**
 * @codem/ui-library-ops — 图书馆运营监控（Library Ops）
 *
 * 领域类型定义。此文件是整个插件的「发布面」：纯类型 + 常量，无运行时依赖，
 * 可被测试、监控面板、场景渲染器共同消费。
 *
 * 设计参考：
 * - ClawLibrary：等距（isometric）图书馆场景 + 角色在馆内不同岗位工作
 * - lobster-pet：桌面宠物 + 运营监控看板（KPI 卡 / 面板网格 / 实时事件流）
 *
 * 与 Codem 的关系：本插件**只读**宿主数据（团队 / 子智能体 / 会话 / 工具 /
 * 遥测 / 成本），从不写入任何宿主状态；关闭插件后宿主行为完全不变。
 */

// ========== 图标（统一走 lucide-react，见 components/icons.tsx） ==========

/**
 * 语义化图标名 —— 数据层只存名字，渲染层 `components/icons.tsx` 映射到 lucide 组件。
 * （历史上这里存的是 emoji，v1.14.1 起统一为项目图标库。）
 */
export type LoIconName =
  // 角色工作状态
  | "coffee"
  | "footprints"
  | "brain"
  | "book-open"
  | "pen-line"
  | "cog"
  | "search"
  | "pause"
  | "check-circle"
  | "triangle-alert"
  | "moon"
  // 角色来源
  | "crown"
  | "user"
  | "bot"
  | "message-square"
  | "puzzle"
  // 图书馆岗位
  | "concierge-bell"
  | "library"
  | "code"
  | "archive"
  | "server"
  | "messages-square"
  | "package-check"
  // 面板 / 卡片
  | "bar-chart-3"
  | "wrench"
  | "circle-dollar-sign"
  | "clock"
  | "settings"
  | "timer"
  | "scale"
  | "layout-panel-left"
  | "image"
  | "calculator"
  | "trending-up"
  | "trending-down"
  | "circle-x"
  | "plug"
  | "stethoscope"
  | "users"
  | "scan-search"
  | "map"
  | "radio"
  | "refresh-cw"
  | "scroll-text"
  | "ruler"
  | "gauge"
  | "columns"
  | "sparkles"
  // HUD 操作
  | "plus"
  | "minus"
  | "maximize-2"
  | "move"
  | "rotate-ccw";

// ========== 角色（演员） ==========

/** 演员来源类别 —— 决定头顶徽章与默认岗位亲和度 */
export type ActorKind =
  | "captain" // 队长 / 主会话
  | "member" // 团队运行时成员（可续聊子会话）
  | "subagent" // 一次性子智能体 / 后台任务
  | "session" // 独立并行会话
  | "system"; // 系统（自动化 / 定时器 / 看板自身）

/** 演员在图书馆内的动画状态（驱动 CSS 关键帧 + 头顶气泡） */
export type ActorActivity =
  | "idle" // 待命（静思角）
  | "walking" // 走向工位
  | "thinking" // 思考中（推理 / 规划）
  | "reading" // 阅读（read / grep / 检索）
  | "writing" // 写作（write / edit / 生成）
  | "working" // 执行中（bash / 工具链 / 构建）
  | "searching" // 检索中（web / 语义检索）
  | "blocked" // 等待授权 / 等待用户
  | "done" // 刚完成（短暂高亮）
  | "error" // 出错
  | "sleeping"; // 离线 / 归档

/** 状态严重度（用于统一配色与排序） */
export type ActivitySeverity = "active" | "wait" | "ok" | "bad" | "off";

export interface ActivityMeta {
  zh: string;
  en: string;
  severity: ActivitySeverity;
  /** 语义令牌名（禁止硬编码色值，见 skin-tokens 契约） */
  token: string;
  /** 语义化图标名（lucide，见 components/icons.tsx） */
  icon: LoIconName;
}

/** 角色外观 —— 由角色 id/名称确定性生成（同一角色每次打开都长一样） */
export interface CharacterLook {
  /** 调色板索引（映射到语义令牌组合） */
  paletteId: number;
  /** 身体轮廓变体 0..3 */
  body: number;
  /** 发型变体 0..4 */
  hair: number;
  /** 帽子 / 头饰变体 0..5（0 = 无） */
  hat: number;
  /** 手持道具变体 0..5（0 = 无） */
  prop: number;
  /** 表情 0..3 */
  face: number;
  /** 整体缩放 0.88..1.12 */
  scale: number;
  /** 色相微调（度，-24..24）——仅用 filter: hue-rotate 表达，不写死色值 */
  hueShift: number;
}

/** 图书馆内一名工作角色的完整运行态 */
export interface LibraryActor {
  /** 稳定 id（团队成员 id / 子智能体 id / 会话 id） */
  id: string;
  /** 展示名 */
  name: string;
  /** 角色标签（如「代码工坊 · 前端」） */
  roleLabel: string;
  kind: ActorKind;
  /** 团队信息（属于运行时团队时存在） */
  teamId?: string;
  teamName?: string;
  /** 父会话 id（队长 / 主会话） */
  parentId?: string;
  /** 模型名（面板展示） */
  model?: string;
  /** 外观（确定性生成） */
  look: CharacterLook;
  /** 当前动画状态 */
  activity: ActorActivity;
  /** 状态文字（气泡 / 列表展示） */
  statusLabel: string;
  /** 当前正在做的事（最近一次工具 / 任务标题） */
  focus?: string;
  /** 最近事件时间戳 */
  lastEventAt: number;
  /** 累计指标 */
  metrics: ActorMetrics;
  /** 岗位亲和度（由角色标签推导的岗位 id） */
  preferredZoneId: string;
}

export interface ActorMetrics {
  /** 已领取/已派发任务数 */
  tasks: number;
  /** 已完成任务数 */
  done: number;
  /** 失败/取消任务数 */
  failed: number;
  /** 工具调用次数 */
  tools: number;
  /** 输入 + 输出 token */
  tokens: number;
  /** 估算成本（USD） */
  cost: number;
  /** 错误数 */
  errors: number;
}

// ========== 图书馆地图 ==========

/** 等距瓦片坐标 */
export interface TileCoord {
  col: number;
  row: number;
}

/** 图书馆区域（岗位） */
export interface LibraryZone {
  id: string;
  /** 中文名 */
  name: string;
  /** 英文名 */
  nameEn: string;
  /** 岗位职责一句话说明 */
  duty: string;
  /** 语义化图标名（lucide，见 components/icons.tsx） */
  icon: LoIconName;
  /** 占地矩形（瓦片空间） */
  rect: { col: number; row: number; w: number; h: number };
  /** 工位中心瓦片 */
  station: TileCoord;
  /** 该岗位最多同时容纳的角色数 */
  capacity: number;
  /** 语义令牌名（区域主色，皮肤契约） */
  token: string;
  /** 岗位标签关键词（角色标签命中即亲和） */
  keywords: string[];
  /** 主活动（角色在此岗位的默认动作） */
  activity: ActorActivity;
}

/** 图书馆整体地图 */
export interface LibraryMap {
  /** 瓦片尺寸（像素） */
  tileWidth: number;
  tileHeight: number;
  /** 网格规模 */
  cols: number;
  rows: number;
  /** 入口瓦片（新角色入场点） */
  entrance: TileCoord;
  /** 全部区域 */
  zones: LibraryZone[];
  /** 过道 / 装饰（纯视觉） */
  decor: LibraryDecor[];
}

export type DecorKind =
  | "bookshelf"
  | "table"
  | "plant"
  | "lamp"
  | "counter"
  | "terminal"
  | "carpet"
  | "stairs";

export interface LibraryDecor {
  kind: DecorKind;
  tile: TileCoord;
  /** 占几个瓦片（宽） */
  span?: number;
  token?: string;
}

/** 屏幕坐标（等距投影结果） */
export interface ScreenPoint {
  x: number;
  y: number;
}

// ========== 场景运行时 ==========

export interface SceneActor {
  id: string;
  /** 插值后的连续瓦片位置（用于平滑行走） */
  col: number;
  row: number;
  /** 当前寻路剩余路径（不含已到达点） */
  path: TileCoord[];
  /** 目标工位瓦片 */
  station: TileCoord;
  /** 所在区域 id */
  zoneId: string;
  /** 朝向：1 右下 / -1 左下 */
  facing: 1 | -1;
  /** 当前动画 */
  anim: ActorActivity;
  /** 动画开始时间（ms） */
  animSince: number;
  /** 是否正在行走 */
  walking: boolean;
  /** 头顶气泡文字（限时） */
  bubble?: string;
  bubbleUntil?: number;
  /** 入场淡入进度 0..1 */
  appear: number;
  /** 退场标记（不在快照中但仍在画布上） */
  leaving?: boolean;
  /** 开始退场的时间戳（用于计算淡出进度，与入场进度解耦） */
  leaveAt?: number;
}

export interface SceneState {
  /** 已推进的 tick 数 */
  tick: number;
  /** 上次推进时间戳 */
  at: number;
  /** 演员运行态 */
  actors: Record<string, SceneActor>;
  /** 演员 → 区域分配（跨 tick 稳定，避免抖动） */
  assignments: Record<string, string>;
  /** 演员 → 工位槽位序号 */
  slots: Record<string, number>;
}

// ========== 快照（适配层输出） ==========

export interface LibrarySnapshot {
  /** 采样时间 */
  at: number;
  /** 全部角色 */
  actors: LibraryActor[];
  /** 团队摘要 */
  teams: TeamSummary[];
  /** 汇总指标 */
  metrics: LibraryMetrics;
  /** 最近事件（倒序，最新在前） */
  events: LibraryEvent[];
  /** 活动分布（热力图 / 环形图 / 小时柱状图） */
  activity: LibraryActivity;
  /** 数据来源统计（面板「数据源」卡） */
  sources: SnapshotSources;
  /** 采样耗时（ms） */
  sampleMs: number;
}

/** 活动分布（对标 lobster-pet ActivityViz 的三张图） */
export interface LibraryActivity {
  /** 近 14 天，日期 YYYY-MM-DD → 活跃条数 */
  perDay: Record<string, number>;
  /** 近 24 小时，索引 0..23 → 活跃条数 */
  perHour: number[];
  /** 会话类型分布 */
  kinds: Record<string, number>;
}

export interface SnapshotSources {
  sessions: number;
  activeSessions: number;
  teams: number;
  teamMembers: number;
  subagents: number;
  teamTemplates: number;
  agentProfiles: number;
  telemetryEvents: number;
  /** 采集失败的来源名（可见性：不静默） */
  failed: string[];
}

export interface TeamSummary {
  id: string;
  name: string;
  /** 队长会话 id */
  captainSessionId: string;
  captainName: string;
  memberCount: number;
  members: TeamMemberSummary[];
  tasks: TeamTaskSummary[];
  taskCounts: Record<TeamTaskStatus, number>;
  /** 未读消息总数 */
  unread: number;
  createdAt: number;
  updatedAt: number;
  archived: boolean;
  /** 完成率 0..1（无任务时 0） */
  completion: number;
}

export interface TeamMemberSummary {
  id: string;
  name: string;
  role?: string;
  status: string;
  model?: string;
  /** 该成员名下任务数 / 已完成数 */
  tasks: number;
  done: number;
  /** 当前在做的任务标题 */
  currentTask?: string;
}

export type TeamTaskStatus = "pending" | "claimed" | "in_progress" | "completed" | "failed" | "cancelled";

export interface TeamTaskSummary {
  id: string;
  subject: string;
  status: TeamTaskStatus;
  assignee?: string;
  dependencies: string[];
  attempt: number;
}

export interface LibraryMetrics {
  /** 会话 */
  sessions: number;
  activeSessions: number;
  /** 团队 */
  teams: number;
  tasksTotal: number;
  tasksDone: number;
  tasksFailed: number;
  tasksRunning: number;
  tasksPending: number;
  /** 角色 */
  actors: number;
  actorsWorking: number;
  actorsIdle: number;
  actorsBlocked: number;
  actorsError: number;
  /** 用量 */
  tokensIn: number;
  tokensOut: number;
  tokensCached: number;
  costTotal: number;
  costToday: number;
  /** 工具 */
  toolCalls: number;
  toolErrors: number;
  /** 生产 */
  filesTouched: number;
  messages: number;
  /** 健康度 0..1（完成率 × 无错率 × 活跃度 的加权） */
  health: number;
}

export type LibraryEventKind =
  | "session"
  | "team"
  | "task"
  | "tool"
  | "agent"
  | "error"
  | "cost"
  | "system";

export interface LibraryEvent {
  id: string;
  at: number;
  kind: LibraryEventKind;
  /** 严重度（决定颜色令牌） */
  severity: ActivitySeverity;
  /** 事件文本（已本地化） */
  text: string;
  /** 关联角色 id（点击可定位） */
  actorId?: string;
  /** 关联团队 id */
  teamId?: string;
  /** 附加数值（面板展示） */
  value?: number;
}

/** 时间序列点（迷你折线图） */
export interface SeriesPoint {
  at: number;
  value: number;
}

/**
 * 插件在宿主页签里提供的子视图。
 *
 * v1.15.x 起按「宿主页签」分组（不再全塞在「看板」里）：
 * - 看板组（`BOARD_VIEWS`，宿主 `task-center.board`）：看板 / 工具 / 错误 / 时间线
 * - 场景组（`SCENE_VIEWS`，宿主 `task-center.subagents`）：场景 / 设置
 * - `usage`（用量）：已**迁进宿主「概览」页签**（slot `task-center.overview`），
 *   不再是插件自己的页签视图 —— 保留在联合类型里只为兼容旧的持久化值与深链。
 *
 * 分组理由：场景是「团队 / 子智能体」的可视化表达，放在「子智能体」页签下语义正确；
 * 「设置」调的全是场景显示（场景图 / 名牌 / 气泡 / 动画速度 / 采样），跟着场景走；
 * 「用量」本就是概览的一部分（KPI / 健康度 / 活动分布 / 成本）。
 */
export type MonitorTab = "board" | "scene" | "usage" | "tools" | "errors" | "timeline" | "settings";

/** 看板页签里的视图（宿主 `task-center.board`：插件在此接管） */
export type BoardView = Extract<MonitorTab, "board" | "tools" | "errors" | "timeline">;

/** 子智能体页签里的视图（宿主 `task-center.subagents`：插件在此接管） */
export type SceneView = Extract<MonitorTab, "scene" | "settings">;

/** 全部合法子视图（持久化校验 / 设置页签选择用） */
export const MONITOR_TABS: MonitorTab[] = [
  "board",
  "scene",
  "usage",
  "tools",
  "errors",
  "timeline",
  "settings",
];

export const BOARD_VIEWS: BoardView[] = ["board", "tools", "errors", "timeline"];
export const SCENE_VIEWS: SceneView[] = ["scene", "settings"];

/** 视图 → 宿主页签（跨页签跳转用） */
export function hostTabOfView(view: MonitorTab): "board" | "subagents" | "overview" {
  if ((SCENE_VIEWS as string[]).includes(view)) return "subagents";
  // 用量已迁进概览页签
  if (view === "usage") return "overview";
  return "board";
}

/** 场景风格：pixel = 第三方像素美术场景（默认，仅限非商业）；iso = 本项目自绘等距矢量场景 */
export type SceneStyle = "pixel" | "iso";

/**
 * 场景图片来源：
 * - `claw` / `ai-library-01` 等内置预设（见 data/pixel-art.ts 的 SCENE_PRESETS）
 * - `custom` = 用户自己上传的图片（存 IndexedDB，见 core/scene-image-db.ts）
 */
export type SceneImageId = "claw" | "ai-library-01" | "custom";

/** 内置预设 id（`custom` 之外的全部） */
export const BUILTIN_SCENE_IMAGE_IDS: SceneImageId[] = ["claw", "ai-library-01"];

/** 全部合法取值（含用户上传） */
export const SCENE_IMAGE_IDS: SceneImageId[] = [...BUILTIN_SCENE_IMAGE_IDS, "custom"];

export const SCENE_IMAGE_ID_FALLBACK: SceneImageId = "ai-library-01";

/** 用户上传的场景图片（运行时状态，二进制存在 IndexedDB） */
export interface CustomSceneImage {
  /** objectURL（每次加载/上传后重建） */
  url: string;
  /** 原始文件名 */
  name: string;
  width: number;
  height: number;
  size: number;
  /** 上传时间 */
  addedAt: number;
}

/** 画面微调（只影响图片图层，不影响角色与岗位坐标） */
export interface SceneImageAdjust {
  /** 缩放 0.5..2 */
  scale: number;
  /** 水平位移（显示画布像素，-600..600） */
  x: number;
  /** 垂直位移（显示画布像素，-600..600） */
  y: number;
}

export const DEFAULT_SCENE_ADJUST: SceneImageAdjust = { scale: 1, x: 0, y: 0 };

/** 插件设置（持久化到 localStorage） */
export interface LibraryOpsSettings {
  /** 采样间隔（ms） */
  refreshMs: number;
  /** 场景风格 */
  sceneStyle: SceneStyle;
  /** 场景图片（内置预设或用户上传） */
  sceneImageId: SceneImageId;
  /** 图片图层微调 */
  sceneImageAdjust: SceneImageAdjust;
  /** 是否显示对位参考线（房间框 + 行走图） */
  showAlignGuides: boolean;
  /** 场景动画速度倍率 */
  speed: number;
  /** 是否显示角色头顶名牌 */
  showNameplates: boolean;
  /** 是否显示角色气泡 */
  showBubbles: boolean;
  /** 是否显示区域标签 */
  showZoneLabels: boolean;
  /** 场景最大角色数（超出折叠为「其他」） */
  maxActors: number;
  /** 是否显示图书馆页签右侧的实时事件流 */
  showEventFeed: boolean;
  /** 打开「看板」页签时的默认子视图（场景组有自己的默认：场景） */
  defaultTab: MonitorTab;
  /** 是否在启动时自动打开「任务管理 → 看板」页签 */
  autoOpen: boolean;
}

export const DEFAULT_SETTINGS: LibraryOpsSettings = {
  refreshMs: 1500,
  sceneStyle: "pixel",
  sceneImageId: "ai-library-01",
  sceneImageAdjust: { ...DEFAULT_SCENE_ADJUST },
  showAlignGuides: false,
  speed: 1,
  showNameplates: true,
  showBubbles: true,
  showZoneLabels: true,
  maxActors: 24,
  showEventFeed: true,
  defaultTab: "board",
  autoOpen: false,
};

/** 设置持久化键（与宿主其它 localStorage 键前缀一致） */
export const STORAGE_KEY = "codem-library-ops";

// ========== 活动元数据表 ==========

export const ACTIVITY_META: Record<ActorActivity, ActivityMeta> = {
  idle: { zh: "待命", en: "Idle", severity: "off", token: "--text-muted", icon: "coffee" },
  walking: { zh: "前往工位", en: "Walking", severity: "active", token: "--info", icon: "footprints" },
  thinking: { zh: "思考中", en: "Thinking", severity: "active", token: "--accent", icon: "brain" },
  reading: { zh: "查阅资料", en: "Reading", severity: "active", token: "--info", icon: "book-open" },
  writing: { zh: "撰写中", en: "Writing", severity: "active", token: "--warning", icon: "pen-line" },
  working: { zh: "执行中", en: "Working", severity: "active", token: "--accent", icon: "cog" },
  searching: { zh: "检索中", en: "Searching", severity: "active", token: "--success", icon: "search" },
  blocked: { zh: "等待授权", en: "Blocked", severity: "wait", token: "--security-ask", icon: "pause" },
  done: { zh: "已完成", en: "Done", severity: "ok", token: "--success", icon: "check-circle" },
  error: { zh: "出错", en: "Error", severity: "bad", token: "--error", icon: "triangle-alert" },
  sleeping: { zh: "休眠", en: "Sleeping", severity: "off", token: "--text-muted", icon: "moon" },
};

/** 角色来源徽章 */
export const KIND_META: Record<ActorKind, { zh: string; en: string; icon: LoIconName }> = {
  captain: { zh: "队长", en: "Captain", icon: "crown" },
  member: { zh: "成员", en: "Member", icon: "user" },
  subagent: { zh: "子智能体", en: "Subagent", icon: "bot" },
  session: { zh: "会话", en: "Session", icon: "message-square" },
  system: { zh: "系统", en: "System", icon: "puzzle" },
};

/** 任务状态元数据 */
export const TASK_STATUS_META: Record<TeamTaskStatus, { zh: string; en: string; token: string }> = {
  pending: { zh: "待领取", en: "Pending", token: "--text-muted" },
  claimed: { zh: "已领取", en: "Claimed", token: "--info" },
  in_progress: { zh: "执行中", en: "In progress", token: "--warning" },
  completed: { zh: "已完成", en: "Completed", token: "--success" },
  failed: { zh: "失败", en: "Failed", token: "--error" },
  cancelled: { zh: "已取消", en: "Cancelled", token: "--text-muted" },
};
