/**
 * 工作区外壳（Batch 1A）。
 *
 * ## 为什么会有这个文件
 *
 * 重构前 `App.tsx` 把**同一段主区**复制了三份（hub 5634–5765 / dream 5766–5888 / 默认 5889–6033）：
 * 压缩横幅 → 笔记本横幅 → `ChatPanel` → 终端抽屉 → 四个可选页签 → 游戏。
 * 三份去掉换行差异后**逐 token 相同**（读代码核对过），所以任何主界面改动都要改三遍，
 * 而且三份会逐渐漂移（右栏入参已经漂了一次，见下）。
 *
 * 现在：
 *   · `WorkspaceMainColumn` 持有那一段**唯一的**实现（DOM 结构与顺序与迁移前逐节点相同）；
 *   · `WorkspaceFrame` 只负责"三套皮肤各自的布局包裹"：hub 走 `HubLayout`、dream 走 `DreamLayout`、
 *     默认皮肤走裸 fragment（含移动端汉堡按钮）；
 *   · `App.tsx` 里三份 → 一次 `WorkspaceMainColumn` + 三个 `WorkspaceFrame` 分支。
 *
 * ## 不做什么（纪律）
 *
 * - 不改任何 props 语义、事件、`data-testid`、`aria-*`、键盘行为；
 * - 不合并入口、不改渲染条件（`bottomTab` 判断、`gameEnabled` 判断原样保留）；
 * - 右侧栏入参**由 App 统一构造**，因此 hub 不再少传 `sessionId` / `workspace` / `agents`
 *   （那是迁移前唯一一处真实漂移；HubLayout 的 `rightRail` 属性就是为此加的）。
 */

import type { ComponentProps, ReactNode } from "react";
import { BookOpen, CheckCircle, FolderOpen, Save, Terminal, X } from "lucide-react";
import { SlotBridge } from "../../core/slots/SlotBridge";
import { ChatPanel } from "../ChatPanel";
import { HubLayout } from "../HubLayout";
import { DreamLayout } from "../DreamLayout";
import type { SkinId } from "../../core/theme/types";

/** 压缩横幅的状态形状（与 App 里 `compactionStatus` 同源，只用到这几个字段） */
interface CompactionBannerStatus {
  sessionId?: string;
  active: boolean;
  skipped?: boolean;
  skipReason?: string | null;
  messagesRemoved?: number;
}

/** `ChatPanel` 的入参（直接复用组件类型，避免手抄 20 个字段时漏一个） */
type ChatPanelProps = ComponentProps<typeof ChatPanel>;

export interface WorkspaceMainColumnProps {
  lang: "zh" | "en";

  /** 压缩横幅：只在"当前会话"上显示（判断条件原样搬过来） */
  compactionStatus: CompactionBannerStatus | null;
  uiSessionId: string | null;

  /** 笔记本模式横幅：原样搬 setters，保证点击行为逐条一致 */
  activeNotebookId: string | null;
  activeNotebookName: string;
  onSaveAIResponseAsNote: () => void;
  setNotebookWorkspaceId: (id: string | null) => void;
  setNotebookWorkspaceName: (name: string) => void;
  setActiveNotebookId: (id: string | null) => void;
  setActiveNotebookName: (name: string) => void;
  setNotebookSourceFilter: (sourceIds: string[] | null) => void;

  /** 会话面板（含全部既有入参） */
  chat: ChatPanelProps;
  /** 底部页签：只影响"渲染哪个面板"，不改页签状态机 */
  bottomTab: string;
  /** 终端抽屉（懒加载组件由 App 构造，frame 只负责摆位置） */
  terminal: ReactNode;
  onCloseTerminal: () => void;
  /** 四个可选页签（perf/files/jobs/cicd）的当前内容 */
  bottomPanels: ReactNode;
  /** 游戏（monopoly 插件，本轮不动其视觉） */
  game: ReactNode;
}

/**
 * 三套皮肤共用的主列。结构（逐节点）与迁移前一致：
 *
 * ```
 * div.main-area > div.panel-right > div.panel-content
 *   ├─ 压缩横幅（条件）
 *   ├─ 笔记本横幅（条件）
 *   ├─ ChatPanel（bottomTab 为 chat/terminal 时）
 *   ├─ 终端抽屉（bottomTab 为 terminal 时）
 *   ├─ 四个可选页签（App 传入）
 *   └─ 游戏（gameEnabled && bottomTab==="game"）
 * ```
 */
export function WorkspaceMainColumn({
  lang,
  compactionStatus,
  uiSessionId,
  activeNotebookId,
  activeNotebookName,
  onSaveAIResponseAsNote,
  setNotebookWorkspaceId,
  setNotebookWorkspaceName,
  setActiveNotebookId,
  setActiveNotebookName,
  setNotebookSourceFilter,
  chat,
  bottomTab,
  terminal,
  onCloseTerminal,
  bottomPanels,
  game,
}: WorkspaceMainColumnProps) {
  return (
    <div className="main-area">
      <div className="panel-right">
        <div className="panel-content">
          {compactionStatus && compactionStatus.sessionId === uiSessionId && (
            <div className={`compaction-banner ${compactionStatus.active ? "compaction-active" : "compaction-done"}`}>
              {compactionStatus.active ? (
                <><span className="compaction-spinner" /> 正在压缩上下文...</>
              ) : (
                compactionStatus.skipped ? (
                  <div className="compaction-skipped-hint">{compactionStatus.skipReason ?? "当前没有可压缩的内容"}</div>
                ) : (
                  <><CheckCircle size={12} className="icon-inline-gap" /> 上下文已压缩{compactionStatus.messagesRemoved ? `（移除 ${compactionStatus.messagesRemoved} 条旧消息）` : ""}</>
                )
              )}
            </div>
          )}
          {activeNotebookId && (
            <div className="notebook-mode-banner">
              <span className="notebook-mode-icon"><BookOpen size={16} /></span>
              <span>{lang === "zh" ? `笔记本模式：${activeNotebookName}` : `Notebook Mode: ${activeNotebookName}`}</span>
              <button className="notebook-mode-save" onClick={onSaveAIResponseAsNote} title={lang === "zh" ? "保存AI回复为笔记" : "Save AI response as note"}><Save size={14} /></button>
              <button
                className="notebook-mode-save"
                onClick={() => { setNotebookWorkspaceId(activeNotebookId); setNotebookWorkspaceName(activeNotebookName); }}
                title={lang === "zh" ? "返回工作区" : "Back to Workspace"}
              ><FolderOpen size={14} /></button>
              <button aria-label="关闭" title="关闭"
                className="notebook-mode-close"
                onClick={() => { setActiveNotebookId(null); setActiveNotebookName(""); setNotebookSourceFilter(null); }}
              >
                <X size={14} />
              </button>
            </div>
          )}
          {(bottomTab === "chat" || bottomTab === "terminal") && (
            <SlotBridge name="app.conversation" fallback={ChatPanel} {...chat} />
          )}
          {bottomTab === "terminal" && (
            <div className="terminal-drawer">
              <div className="terminal-drawer-header">
                <span className="terminal-drawer-title"><Terminal size={14} /> {lang === "zh" ? "终端" : "Terminal"}</span>
                <button
                  className="terminal-drawer-close"
                  onClick={onCloseTerminal}
                  title={lang === "zh" ? "关闭终端" : "Close terminal"}
                  aria-label={lang === "zh" ? "关闭终端" : "Close terminal"}
                >
                  <X size={14} />
                </button>
              </div>
              <div className="terminal-drawer-body">{terminal}</div>
            </div>
          )}

          {bottomPanels}

          {game}
        </div>
      </div>
    </div>
  );
}

export interface WorkspaceFrameProps {
  /** 与 `skin` 同源；三档共享同一套主列，只换布局包裹 */
  variant: SkinId | "default";
  sidebar: ReactNode;
  main: ReactNode;
  rightRail: ReactNode;
  /** 移动端汉堡按钮：三套皮肤**都要有**（窄视口下没有它就没法打开侧栏） */
  mobileSidebarToggle?: ReactNode;
  /** hub 需要的 `HubLayout` 入参（除 sidebar/mainPanel/rightRail 外） */
  hub?: Omit<ComponentProps<typeof HubLayout>, "sidebar" | "mainPanel" | "rightRail">;
}

/**
 * 三套皮肤的布局外壳。
 *
 * 注意：`variant` 不是"新造的三套布局"，而是**保留既有三套包裹**（HubLayout / DreamLayout / 裸 fragment），
 * 只是把"包裹与内容"之间的关系收敛到一处。真正统一皮肤是 Batch 6A 的事。
 *
 * 2026-11-19（Batch 6B）：汉堡按钮原来只挂在默认皮肤的裸 fragment 上，
 * hub / dream 两套在 390px 视口下**根本没有打开侧栏的入口**（真机布局实测：
 * `document.querySelector(".mobile-sidebar-toggle")` 为 null）。三套都挂上。
 */
export function WorkspaceFrame({ variant, sidebar, main, rightRail, mobileSidebarToggle, hub }: WorkspaceFrameProps) {
  if (variant === "hub") {
    return (
      <>
        {mobileSidebarToggle}
        <HubLayout {...hub} sidebar={sidebar} mainPanel={main} rightRail={rightRail} />
      </>
    );
  }
  if (variant === "dream") {
    return (
      <DreamLayout>
        {mobileSidebarToggle}
        {sidebar}
        {main}
        {rightRail}
      </DreamLayout>
    );
  }
  return (
    <>
      {mobileSidebarToggle}
      {sidebar}
      {main}
      {rightRail}
    </>
  );
}
