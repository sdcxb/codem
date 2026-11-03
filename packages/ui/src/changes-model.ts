/**
 * 文件变更列表的**纯展示模型**（无 React、无传输）。
 *
 * 为什么单独一层：桌面与手机必须用**同一套**"哪条是最近一轮 / 缺统计怎么显示 /
 * 空态怎么分"的判据。把这些判断写在 JSX 里，两端各写一遍就一定会漂移
 * （典型症状：桌面显示 `+—`、手机显示 `+0`；或手机把"读失败"画成"没有记录"）。
 *
 * 数据形状直接复用协议（`TurnChangesView` / `ChangedFileView`）——共享层不再定义
 * 第二套"差不多"的类型。
 */
import type { ChangedFileView, TurnChangesView } from "../../protocol/src/index";

/** 列表页可能处在的四种**互不冒充**的状态（顺序就是优先级） */
export type ChangesEmptyKind = "loading" | "error" | "unsupported" | "empty" | "ready";

export interface ChangesStateInput {
  records: TurnChangesView[];
  loading?: boolean;
  error?: string | null;
  supported?: boolean;
}

export function changesEmptyKind(input: ChangesStateInput): ChangesEmptyKind {
  if (input.records.length > 0) return "ready";
  if (input.loading) return "loading";
  if (input.error) return "error";
  if (input.supported === false) return "unsupported";
  return "empty";
}

/**
 * "最近一轮" = `createdAt` 最大的那条。
 *
 * ⚠️ **不许**再用 `turn_index` 最大：`turn_index` 每个 prompt 从 1 重开
 * （`AgenticLoop` 每 prompt 新建），取 max 会把**更早那次对话**的最后一条当成"最近"。
 */
export function latestChange(records: TurnChangesView[]): TurnChangesView | null {
  let latest: TurnChangesView | null = null;
  for (const record of records) {
    if (!latest || record.createdAt > latest.createdAt) latest = record;
  }
  return latest;
}

/** 历史轮次：按 `createdAt` DESC，排除最近那条 */
export function historyChanges(records: TurnChangesView[]): TurnChangesView[] {
  const latest = latestChange(records);
  return [...records]
    .filter((r) => r.changeId !== latest?.changeId)
    .sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * 一个文件的 `+/−` 单元格：**缺统计 ⇒ `—`**（不是 0）。
 *
 * 二进制 / 未跟踪 / 旧记录没有 numstat；把"不知道"画成 `+0 −0` 是在编造数据。
 */
export function formatAddition(file: ChangedFileView): string {
  return typeof file.additions === "number" ? `+${file.additions}` : "+—";
}

export function formatDeletion(file: ChangedFileView): string {
  return typeof file.deletions === "number" ? `−${file.deletions}` : "−—";
}

/** 汇总单元格：整个 `totals` 缺席时显示 `+— −—` */
export function formatTotals(record: TurnChangesView): { add: string; del: string } {
  return record.totals
    ? { add: `+${record.totals.additions}`, del: `−${record.totals.deletions}` }
    : { add: "+—", del: "−—" };
}

/** git 状态码 → 既有 CSS 类名（保持桌面 Inspector 的三种颜色语义） */
export function fileStatusClass(status: string): string {
  const s = (status || "").toLowerCase();
  const kind = s === "m" ? "modified" : s === "a" ? "added" : s === "d" ? "deleted" : "untracked";
  return `change-file-status git-status-${kind}`;
}

/**
 * "第 N 轮"标签：`turnIndex` 会重开，所以只当标签，不参与排序/分组。
 * 附上时间让标签能自证（`第 3 轮 · 14:20`）。
 */
export function turnLabel(record: TurnChangesView): string {
  const time = record.createdAt > 0 ? new Date(record.createdAt) : null;
  if (!time || Number.isNaN(time.getTime())) return `第 ${record.turnIndex} 轮`;
  const hh = String(time.getHours()).padStart(2, "0");
  const mm = String(time.getMinutes()).padStart(2, "0");
  return `第 ${record.turnIndex} 轮 · ${hh}:${mm}`;
}

/** 文件名（给历史轮次的紧凑行） */
export function baseName(path: string): string {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] || path;
}

/** 分页追加：同一 `changeId` 不重复（Host 分页在两次请求之间可能插新行） */
export function appendPage(prev: TurnChangesView[], next: TurnChangesView[]): TurnChangesView[] {
  const seen = new Set(prev.map((r) => r.changeId));
  return [...prev, ...next.filter((r) => !seen.has(r.changeId))];
}
