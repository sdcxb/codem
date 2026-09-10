/**
 * LibraryOpsBoardView —— 「看板」页签的接管视图（渲染在 `task-center.board` slot 里）。
 *
 * 为什么并进看板：图书馆场景的初衷就是「谁在做什么、在哪做」的可视化看板，
 * 与宿主「看板」页签（Issues 按状态分列）是同一类信息的不同表达。
 *
 * v1.15.0 起本页签只保留**看板语义**的视图：
 * `看板（宿主 Issues）| 用量 | 工具 | 错误 | 时间线`；
 * 「场景 / 设置」已移到宿主「子智能体」页签（见 `LibraryOpsSceneView`），
 * 因为场景是团队/子智能体的可视化表达，设置调的也全是场景显示。
 */

import { useEffect, useState } from "react";
import type { BoardView, MonitorTab } from "../types";
import { BOARD_VIEWS } from "../types";
import { useLibraryOps } from "../store";
import { useLang } from "../../../core/i18n/lang";
import { IssueBoard } from "../../../components/task-center/IssueBoard";
import { LibraryOpsViewShell, type ShellView } from "./LibraryOpsViewShell";
import { ToolsPanel } from "./monitor/ToolsPanel";
import { ErrorsPanel } from "./monitor/ErrorsPanel";
import { TimelinePanel } from "./monitor/TimelinePanel";
import { LoIcon } from "./icons";

/** 视图导航（看板 = 宿主 Issues 看板；用量已迁进宿主「概览」页签，不再是本页签的视图） */
const VIEWS: ShellView[] = [
  { id: "board", zh: "看板", en: "Board", icon: "columns" },
  { id: "tools", zh: "工具", en: "Tools", icon: "wrench" },
  { id: "errors", zh: "错误", en: "Errors", icon: "triangle-alert" },
  { id: "timeline", zh: "时间线", en: "Timeline", icon: "clock" },
];

export function LibraryOpsBoardView() {
  const zh = useLang() === "zh";
  const tab = useLibraryOps((s) => s.tab);
  const setTab = useLibraryOps((s) => s.setTab);
  const settings = useLibraryOps((s) => s.settings);
  const snapshot = useLibraryOps((s) => s.snapshot);
  /**
   * 看板子视图默认不渲染实时事件流：看板 7 列本来就需要横向空间，
   * 事件流再占 200–280px 会把右侧列挤出可视区。
   */
  const [feedOnBoard, setFeedOnBoard] = useState(false);
  const feedVisible = settings.showEventFeed && tab !== "timeline" && (tab !== "board" || feedOnBoard);

  // 宿主/插件派发的深链（如「概览 → 查看完整时间线」）：命中本页签的视图就切过去
  useEffect(() => {
    const handler = (e: Event) => {
      const view = (e as CustomEvent).detail?.view;
      if (typeof view === "string" && (BOARD_VIEWS as string[]).includes(view)) {
        setTab(view as BoardView);
      }
    };
    window.addEventListener("codem:open-task-center", handler as EventListener);
    return () => window.removeEventListener("codem:open-task-center", handler as EventListener);
  }, [setTab]);

  const board = (
    // 包一层 flex 宿主：让宿主 IssueBoard（inline height:100% + overflow:auto）
    // 始终正好填满内容区，横向滚动条不会被挤出可视区
    <div className="lo-board-host">
      <IssueBoard />
    </div>
  );
  // 持久化里若残留场景组旧值（scene/settings），回退到看板
  const active: BoardView = (BOARD_VIEWS as string[]).includes(tab) ? tab : "board";

  return (
    <LibraryOpsViewShell
      dataView="task-center-board"
      views={VIEWS}
      active={active}
      onSelect={(v: MonitorTab) => setTab(v as BoardView)}
      showFeed={feedVisible}
      actions={
        settings.showEventFeed && active === "board" ? (
          <button
            className={`lo-icon-btn${feedOnBoard ? " is-active" : ""}`}
            onClick={() => setFeedOnBoard((v) => !v)}
            title={
              feedOnBoard
                ? zh
                  ? "收起实时事件（看板占满宽度）"
                  : "Hide live feed (full-width board)"
                : zh
                  ? "显示实时事件（会占用右侧宽度）"
                  : "Show live feed (takes right-side width)"
            }
            aria-label={zh ? "实时事件" : "Live feed"}
            aria-pressed={feedOnBoard}
          >
            <LoIcon name="layout-panel-left" size={14} />
          </button>
        ) : null
      }
    >
      {active === "board" && board}
      {active === "tools" && <ToolsPanel snapshot={snapshot} zh={zh} />}
      {active === "errors" && <ErrorsPanel snapshot={snapshot} zh={zh} />}
      {active === "timeline" && <TimelinePanel snapshot={snapshot} zh={zh} />}
    </LibraryOpsViewShell>
  );
}

export default LibraryOpsBoardView;
