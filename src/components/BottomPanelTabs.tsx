/**
 * 底部面板页签栏 —— **宿主自有**组件，三套皮肤（hub / dream / 默认）共用这一份。
 *
 * ## 为什么是宿主自有，而不是插件槽位
 *
 * 页签栏原来在三套皮肤里各写一遍，每套都是 `<div className="panel-tabs" style={{ display: "none" }}>`
 * （hub 那份里还挂着一个 `<SlotListBridge name="bottom-panel.tabs" />`）。两个后果，真机 + git 都能证：
 *
 * 1. `display: none` ⇒ 页签栏**从来没有可见过**，挂在里面的 `bottom-panel.tabs` 槽位
 *    即使有贡献者也渲染不出来 —— 这个扩展点等于不存在（`git log -S bottom-panel.tabs`：
 *    声明了、但没有一个注册方）；
 * 2. `e1bdd01e`（页签栏重构）把「性能」「CI/CD」按钮删掉之后，**没有任何 setter** 能进入
 *    `perf` / `files` / `jobs` / `cicd` 四个成员 ⇒ `BottomTab` 里的类型与门控都还在，
 *    界面永远进不去（`src/test/bottom-tab-entry-ratchet.test.tsx` 的 BOTTOM-TAB-1..8 钉住）。
 *
 * 所以入口由宿主渲染：`onSelect` 直接接到 `App.tsx` 的 `setBottomTab`，与既有状态机一致
 * （门控为 false 时入口不渲染，且 App 的降级 effect 会把 `bottomTab` 拉回 `chat`）。
 * `bottom-panel.tabs` 仍然保留出口（见下面渲染处）—— 插件可以往页签栏里追加入口，
 * 但**不许**用它替代宿主页签：槽位里的组件拿不到 `bottomTab` 状态。
 *
 * ## 刻意无入口
 *
 * `game` **刻意不给入口**（产品决定：它是「开关背后没有 UI 入口」的已知事实，由 `GAME-4` 钉住）。
 * 登记在下面的 `DELIBERATELY_ENTRYLESS_TABS` 里，理由必须写明 —— 棘轮判据强制。
 */
import { Activity, FolderOpen, GitBranch, ListChecks, MessageSquare, Terminal, X } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { SlotListBridge } from "../core/slots/SlotBridge";

/** 底部面板的全部页签成员（与 `App.tsx` 的 `type BottomTab` 是同一个集合；棘轮判据核对两者一致） */
export type BottomPanelTabId = "chat" | "terminal" | "perf" | "files" | "jobs" | "cicd" | "game";

/** 门控开关（由插件禁用列表折算，见 App.tsx 顶层） */
export interface BottomPanelGates {
  perf: boolean;
  files: boolean;
  jobs: boolean;
  cicd: boolean;
}

/** 门控键 → `App.tsx` 里的开关变量名（棘轮用它核对降级 effect 真的存在） */
export const BOTTOM_PANEL_GATE_FLAGS: Readonly<Record<keyof BottomPanelGates, string>> = {
  perf: "perfEnabled",
  files: "workspacePanelEnabled",
  jobs: "jobsPanelEnabled",
  cicd: "cicdEnabled",
};

export interface BottomPanelTabEntry {
  id: BottomPanelTabId;
  /** 中文标签 */
  zh: string;
  /** 英文标签 */
  en: string;
  icon: LucideIcon;
  /** 门控键：不设 = 恒可见；为 false 时入口不渲染 */
  gate?: keyof BottomPanelGates;
}

/**
 * 页签入口登记（唯一来源）。
 *
 * ⚠️ 加一个 `BottomTab` 成员就必须在这里加一条入口，或者写进 `DELIBERATELY_ENTRYLESS_TABS` 并写明理由；
 * 否则 `BOTTOM-TAB-1` 判红。
 */
export const BOTTOM_PANEL_TABS: readonly BottomPanelTabEntry[] = [
  { id: "chat", zh: "对话", en: "Chat", icon: MessageSquare },
  { id: "terminal", zh: "终端", en: "Terminal", icon: Terminal },
  { id: "perf", zh: "性能", en: "Perf", icon: Activity, gate: "perf" },
  { id: "files", zh: "文件", en: "Files", icon: FolderOpen, gate: "files" },
  { id: "jobs", zh: "任务", en: "Jobs", icon: ListChecks, gate: "jobs" },
  { id: "cicd", zh: "CI/CD", en: "CI/CD", icon: GitBranch, gate: "cicd" },
];

/**
 * **刻意没有 UI 入口**的成员登记（理由必填，判据 BOTTOM-TAB-2 核对）。
 *
 * `game`：产品决定 —— 游戏面板保持「开关 + 面板渲染分支」的现状，不恢复入口。
 * 事实由既有判据 `GAME-4`（`src/test/ui-game-switch.test.ts`）钉住：恢复入口必须同时改那一条。
 * 注：`GameView` 的懒加载分支仍在 `App.tsx` 里 —— 那是为了「恢复入口」与「删掉分支」两条路
 * 都能一键落地（GAME-4 的注释写明了这两种处置）。
 */
export const DELIBERATELY_ENTRYLESS_TABS: Readonly<Record<string, string>> = {
  game: "刻意无入口（产品决定）：游戏面板只保留开关与渲染分支，不给 UI 入口 —— 该事实由 GAME-4 钉住；恢复入口须同时改 GAME-4 与本登记。",
};

export interface BottomPanelTabsProps {
  /** 当前选中的页签 */
  tab: BottomPanelTabId;
  /** 门控开关（false 的成员不渲染入口） */
  gates: BottomPanelGates;
  /** 界面语言 */
  lang: "zh" | "en";
  /** 切换页签 —— 必须直接接到 `setBottomTab` */
  onSelect: (id: BottomPanelTabId) => void;
}

/**
 * 底部面板页签栏。
 *
 * 关面板的方式与既有状态机一致：切回「对话」（也就是 `setBottomTab("chat")`）；
 * 非对话页签额外给一个显式关闭按钮（同一个动作，两处入口）。
 */
export function BottomPanelTabs({ tab, gates, lang, onSelect }: BottomPanelTabsProps) {
  const zh = lang === "zh";
  const visible = BOTTOM_PANEL_TABS.filter((entry) => !entry.gate || gates[entry.gate]);

  return (
    <div className="panel-tabs" role="tablist" aria-label={zh ? "底部面板页签" : "Bottom panel tabs"}>
      {visible.map((entry) => {
        const Icon = entry.icon;
        const active = tab === entry.id;
        return (
          <button
            key={entry.id}
            type="button"
            role="tab"
            data-bottom-tab={entry.id}
            aria-selected={active}
            className={`tab${active ? " active" : ""}`}
            onClick={() => onSelect(entry.id)}
            title={zh ? entry.zh : entry.en}
          >
            {/* 图标尺寸走语义类（ICON-1：字面 size 只许降，新代码请走 icon-* 刻度） */}
            <Icon className="icon-sm" /> {zh ? entry.zh : entry.en}
          </button>
        );
      })}
      {/*
        插件扩展点：list 槽位，允许插件往页签栏里追加入口。
        宿主页签不走这里 —— 它们要驱动 App 的 bottomTab 状态，而槽位里的组件拿不到那个状态。
      */}
      <SlotListBridge name="bottom-panel.tabs" />
      {tab !== "chat" && (
        <button
          type="button"
          className="panel-tabs-close"
          data-bottom-tab-close="1"
          onClick={() => onSelect("chat")}
          title={zh ? "关闭面板" : "Close panel"}
          aria-label={zh ? "关闭面板" : "Close panel"}
        >
          {/* 关闭图标必须是图标（ICON-063：不许用文字 ✕/× 当图标） */}
          <X className="icon-sm" />
        </button>
      )}
    </div>
  );
}
