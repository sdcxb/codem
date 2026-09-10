/**
 * BoardTab — 看板页签。
 *
 * 基础视图 = Issues 看板（`IssueBoard`，按状态分列 + 拖拽改状态）。
 * 当 `@codem/ui-library-ops` 启用时，该 slot 由插件接管：插件在同一个页签里提供
 * 「看板 / 用量 / 工具 / 错误 / 时间线」视图切换。
 * 插件关闭 → 回退到基础看板，宿主 UI 不变。
 *
 * 注：v1.15.0 起「场景 / 设置」已移到宿主「子智能体」页签
 * （见 `TASK_CENTER_SUBAGENTS_SLOT`）—— 场景是团队/子智能体的可视化表达。
 */

import { SlotBridge } from "../../core/slots/SlotBridge";
import { IssueBoard } from "./IssueBoard";

export function BoardTab() {
  return <SlotBridge name="task-center.board" fallback={IssueBoard} />;
}
