/**
 * 主对话区**顶部页签栏**的成员清单与「其它可达入口」登记（第 233 波改造）。
 *
 * ## 这一波改了什么
 *
 * 用户要求：把主对话区顶部那条页签栏（对话 / 终端 / 性能 / 文件 / 任务 / CI-CD）**整体隐藏**，
 * 理由是这些都有其它入口。所以：
 *
 * - **入口栏已隐藏**：`App.tsx` 三套皮肤（hub / dream / 默认）都不再渲染 `<BottomPanelTabs>`
 *   （该组件文件已删除）；`bottom-panel.tabs` 槽位也一并撤销（没有宿主 ⇒ 留着就是假扩展点）。
 * - **面板本体都还在**：`bottomTab === "…"` 的四条渲染分支（perf / files / jobs / cicd）与
 *   `PerformanceDashboard` / `FileExplorer` / `JobsPanel` / `CicdPanel` 都没删 —— 它们是兜底挂载点，
 *   现在只有终端还会经 `bottomTab` 进入（标题栏的终端按钮），其余四项的**用户入口**在下表里。
 *
 * ## 这张表的作用（判据的唯一来源）
 *
 * 每个成员必须至少有一条**真实可达**的入口（`BOTTOM_TAB_ENTRIES`），文件与符号都由判据
 * `BOTTOM-TAB-1..9`（`src/test/bottom-tab-entry-ratchet.test.tsx`）逐条核对：
 * 入口点必须真的在源码里存在、且能点到，不许只写一句「有其它入口」。
 * `game` 仍然**刻意无入口**（产品决定，事实由 `GAME-4` 钉住）。
 */

export type BottomPanelTabId = "chat" | "terminal" | "perf" | "files" | "jobs" | "cicd" | "game";

/** 门控开关（由插件禁用列表折算，见 `App.tsx` 顶层） */
export interface BottomPanelGates {
  perf: boolean;
  files: boolean;
  jobs: boolean;
  cicd: boolean;
}

/** 门控键 → `App.tsx` 里的开关变量名（App 的降级 effect 用这张表现算，不再手写四条 if） */
export const BOTTOM_PANEL_GATE_FLAGS: Readonly<Record<keyof BottomPanelGates, string>> = {
  perf: "perfEnabled",
  files: "workspacePanelEnabled",
  jobs: "jobsPanelEnabled",
  cicd: "cicdEnabled",
};

/** 入口形态（判据按形态核对：不同形态要核对的源码事实不一样，别混着写；只在本模块内使用，不导出） */
type BottomTabEntryKind =
  /** 默认页：什么都不点也在它上面 */
  | "pane-default"
  /** 标题栏按钮 */
  | "titlebar"
  /** 命令面板 / 快捷键 */
  | "shortcut"
  /** 右侧抽屉（`PanelSidebar`）的页签 */
  | "sidebar-tab"
  /** 设置面板里的分区 */
  | "settings-section"
  /** 面板自身的关闭按钮（回到对话） */
  | "pane-close";

export interface BottomTabEntry {
  kind: BottomTabEntryKind;
  /** 宿主文件（相对仓库根） */
  file: string;
  /** 判据要在该文件里找到的字面量（证明入口真的存在，而不是口头声明） */
  symbol: string;
  /** 为什么这个入口算「同一能力」 */
  why: string;
}

/**
 * 每个成员（除刻意无入口的 `game`）的**可达入口**登记。
 *
 * 判据 BOTTOM-TAB-3 会逐条打开 `file` 并核对 `symbol` 真的在里面 —— 删掉入口却留着登记 ⇒ 红。
 */
export const BOTTOM_TAB_ENTRIES: Readonly<Record<string, readonly BottomTabEntry[]>> = {
  chat: [
    {
      kind: "pane-default",
      file: "src/App.tsx",
      symbol: 'useState<BottomTab>("chat")',
      why: "默认页：启动即对话，任何面板关闭后也回到这里",
    },
    {
      kind: "pane-close",
      file: "src/App.tsx",
      symbol: 'onClose={() => setBottomTab("chat")}',
      why: "性能 / CI-CD / 任务面板各自的关闭按钮都回传 chat",
    },
    {
      kind: "sidebar-tab",
      file: "src/components/PanelSidebar.tsx",
      symbol: "panel-sidebar-close",
      why: "右侧抽屉的关闭按钮（从侧栏抽屉回到对话）",
    },
  ],
  terminal: [
    {
      kind: "titlebar",
      file: "src/components/TitleBar.tsx",
      symbol: 'zh ? "切换终端" : "Toggle terminal"',
      why: "标题栏的终端按钮（onToggleTerminal ⇒ setBottomTab，与页签栏同一个状态机）",
    },
    {
      kind: "shortcut",
      file: "src/components/TitleBar.tsx",
      symbol: '"显示/隐藏终端"',
      why: "命令面板命令 + 快捷键（同一个 onToggleTerminal）",
    },
  ],
  perf: [
    {
      kind: "settings-section",
      file: "src/components/SettingsPanel.tsx",
      symbol: 'activeTab === "performance"',
      why: "设置 → 性能分区渲染**同一个** PerformanceDashboard（第 231 波从主区顶部移入设置）",
    },
  ],
  files: [
    {
      kind: "sidebar-tab",
      file: "src/components/PanelSidebar.tsx",
      symbol: 'id: "files"',
      why: "右侧抽屉「文件」页签渲染**同一个** FileExplorer（与原来底部「文件」页签同组件）",
    },
  ],
  jobs: [
    {
      kind: "sidebar-tab",
      file: "src/components/PanelSidebar.tsx",
      symbol: 'id: "jobs"',
      why: "右侧抽屉「任务」页签渲染**同一个** JobsPanel；第 233 波新增 —— 隐藏页签栏后 jobs 原本只剩那条栏",
    },
  ],
  cicd: [
    {
      kind: "sidebar-tab",
      file: "src/components/PanelSidebar.tsx",
      symbol: 'id: "cicd"',
      why: "右侧抽屉「CI/CD」页签渲染**同一个** CicdPanel（第 231 波起就是它的正当入口）",
    },
  ],
};

/**
 * **刻意没有 UI 入口**的成员登记（理由必填，判据 BOTTOM-TAB-1/2 核对）。
 *
 * `game`：产品决定 —— 游戏面板保持「开关 + 渲染分支」的现状，不恢复入口。
 * 事实由既有判据 `GAME-4`（`src/test/ui-game-switch.test.ts`）钉住：恢复入口必须同时改那一条。
 */
export const DELIBERATELY_ENTRYLESS_TABS: Readonly<Record<string, string>> = {
  game: "刻意无入口（产品决定）：游戏面板只保留开关与渲染分支，不给 UI 入口 —— 该事实由 GAME-4 钉住；恢复入口须同时改 GAME-4 与本登记。",
};
