/**
 * 图书馆插件的图标映射 —— 全部来自项目统一图标库 **lucide-react**。
 *
 * 为什么单独一个模块：
 * - 数据层（`types.ts` / `data/library-map.ts`）只保存**语义化图标名**（`LoIconName`），
 *   不依赖 React，也不把 emoji 混进数据；
 * - 渲染层统一走 `<LoIcon name=… />`，尺寸/颜色/描边与宿主其它面板一致
 *   （`size` 默认 14，颜色继承 `currentColor`，跟随皮肤令牌）。
 *
 * 新增图标：先在 `types.ts` 的 `LoIconName` 里加名字，再在这里补一行映射。
 */

import {
  Archive,
  BarChart3,
  Bot,
  Brain,
  BookOpen,
  Calculator,
  CircleCheckBig,
  CircleDollarSign,
  CircleX,
  Clock,
  Code2,
  Coffee,
  Cog,
  Columns,
  ConciergeBell,
  Crown,
  Footprints,
  Gauge,
  Image,
  LayoutPanelLeft,
  Library,
  Map,
  Maximize2,
  MessageSquare,
  MessagesSquare,
  Minus,
  Moon,
  Move,
  PackageCheck,
  Pause,
  PenLine,
  Plug,
  Plus,
  Puzzle,
  Radio,
  RefreshCw,
  RotateCcw,
  Ruler,
  Scale,
  ScanSearch,
  ScrollText,
  Search,
  Server,
  Settings,
  Sparkles,
  Stethoscope,
  Timer,
  TriangleAlert,
  TrendingDown,
  TrendingUp,
  User,
  Users,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import type { LoIconName } from "../types";

/** 语义化图标名 → lucide 组件 */
export const LO_ICONS: Record<LoIconName, LucideIcon> = {
  // ── 角色工作状态 ──
  coffee: Coffee,
  footprints: Footprints,
  brain: Brain,
  "book-open": BookOpen,
  "pen-line": PenLine,
  cog: Cog,
  search: Search,
  pause: Pause,
  "check-circle": CircleCheckBig,
  "triangle-alert": TriangleAlert,
  moon: Moon,

  // ── 角色来源 ──
  crown: Crown,
  user: User,
  bot: Bot,
  "message-square": MessageSquare,
  puzzle: Puzzle,

  // ── 图书馆岗位 ──
  "concierge-bell": ConciergeBell,
  library: Library,
  code: Code2,
  archive: Archive,
  server: Server,
  "messages-square": MessagesSquare,
  "package-check": PackageCheck,

  // ── 面板 / 卡片 ──
  "bar-chart-3": BarChart3,
  wrench: Wrench,
  "circle-dollar-sign": CircleDollarSign,
  clock: Clock,
  settings: Settings,
  timer: Timer,
  scale: Scale,
  "layout-panel-left": LayoutPanelLeft,
  image: Image,
  calculator: Calculator,
  "trending-up": TrendingUp,
  "trending-down": TrendingDown,
  "circle-x": CircleX,
  plug: Plug,
  stethoscope: Stethoscope,
  users: Users,
  "scan-search": ScanSearch,
  map: Map,
  radio: Radio,
  "refresh-cw": RefreshCw,
  "scroll-text": ScrollText,
  ruler: Ruler,
  gauge: Gauge,
  columns: Columns,
  sparkles: Sparkles,

  // ── HUD 操作 ──
  plus: Plus,
  minus: Minus,
  "maximize-2": Maximize2,
  move: Move,
  "rotate-ccw": RotateCcw,
};

export interface LoIconProps {
  name: LoIconName;
  /** 像素尺寸（默认 14，与宿主面板一致） */
  size?: number;
  className?: string;
  /** 无障碍标签（省略时视为装饰性图标） */
  label?: string;
  strokeWidth?: number;
}

/** 渲染一个语义化图标 */
export function LoIcon({ name, size = 14, className, label, strokeWidth = 2 }: LoIconProps) {
  const Icon = LO_ICONS[name] ?? Library;
  return (
    <Icon
      size={size}
      strokeWidth={strokeWidth}
      className={className ? `lo-icon ${className}` : "lo-icon"}
      aria-hidden={label ? undefined : true}
      aria-label={label}
      role={label ? "img" : undefined}
      focusable={false}
    />
  );
}

/** 供 `Card` 等组件使用的类型（图标名或直接给一个 React 节点） */
export type LoIconProp = LoIconName;
