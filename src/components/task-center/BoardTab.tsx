/**
 * BoardTab — 看板页签。
 *
 * 基础视图 = Issues 看板（`IssueBoard`，按状态分列 + 拖拽改状态）。
 * 当 `@codem/ui-library-ops` 启用时，该 slot 由插件接管：插件在同一个页签里提供
 * 「看板 / 场景 / 用量 / 工具 / 错误 / 时间线 / 设置」视图切换（把原来独立的
 * 「图书馆」页签并入看板 —— 二者本质都是「工作状态的可视化看板」）。
 * 插件关闭 → 回退到基础看板，宿主 UI 不变。
 */

import { SlotBridge } from "../../core/slots/SlotBridge";
import { IssueBoard } from "./IssueBoard";

export function BoardTab() {
  return <SlotBridge name="task-center.board" fallback={IssueBoard} />;
}
