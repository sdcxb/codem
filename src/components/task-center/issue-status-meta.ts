/**
 * issue-status-meta —— Issue 状态元数据的**唯一真相源**。
 *
 * 背景：同一批状态（`IssueStatus` 联合类型）原先在 5 处各写一份标签/颜色：
 * `IssueCard`（含 lucide 图标）、`IssueBoard` 的列、`IssuesTab` 的筛选器、
 * `IssueDetailPanel` 的状态选择、`AutomationTab` 的「监听状态」下拉。
 * 结果是新增状态必然漏改一处（AutomationTab 就漏了 `backlog`/`todo`）。
 *
 * 这里统一成一张表 + 派生视图，各处只做「取子集」。
 */

import { Circle, CircleDot, CircleSlash, CheckCircle2, AlertTriangle, Ban } from "lucide-react";
import type { IssueStatus } from "../../core/issue/issue-storage";

export interface IssueStatusMeta {
  status: IssueStatus;
  /** 看板列 / 筛选 / 详情里的图标 */
  Icon: typeof Circle;
  /** 语义令牌（禁止硬编码色值） */
  color: string;
  labelZh: string;
  labelEn: string;
}

/** 展示顺序即看板列顺序、筛选顺序（与 `IssueStatus` 全集严格一致） */
export const ISSUE_STATUS_META: IssueStatusMeta[] = [
  { status: "backlog", Icon: Circle, color: "var(--text-muted)", labelZh: "Backlog", labelEn: "Backlog" },
  { status: "todo", Icon: Circle, color: "var(--accent)", labelZh: "待办", labelEn: "Todo" },
  { status: "in_progress", Icon: CircleDot, color: "var(--accent)", labelZh: "进行中", labelEn: "In Progress" },
  { status: "in_review", Icon: AlertTriangle, color: "var(--warning)", labelZh: "待审查", labelEn: "In Review" },
  { status: "blocked", Icon: CircleSlash, color: "var(--error)", labelZh: "阻塞", labelEn: "Blocked" },
  { status: "done", Icon: CheckCircle2, color: "var(--success)", labelZh: "已完成", labelEn: "Done" },
  { status: "cancelled", Icon: Ban, color: "var(--text-muted)", labelZh: "已取消", labelEn: "Cancelled" },
];

/** 按状态查元数据（未知状态回退 `todo`，避免 `undefined.Icon` 崩掉渲染） */
export const ISSUE_STATUS_BY_KEY: Record<IssueStatus, IssueStatusMeta> = ISSUE_STATUS_META.reduce(
  (acc, meta) => {
    acc[meta.status] = meta;
    return acc;
  },
  {} as Record<IssueStatus, IssueStatusMeta>,
);

export function issueStatusMeta(status: string): IssueStatusMeta {
  return ISSUE_STATUS_BY_KEY[status as IssueStatus] ?? ISSUE_STATUS_BY_KEY.todo;
}

/** 全部状态（详情面板的状态按钮、筛选器的取值来源） */
export const ISSUE_STATUSES: IssueStatus[] = ISSUE_STATUS_META.map((m) => m.status);

/** 筛选器（首项「全部」） */
export const ISSUE_STATUS_FILTERS: Array<{ value: IssueStatus | "all"; labelZh: string; labelEn: string }> = [
  { value: "all", labelZh: "全部", labelEn: "All" },
  ...ISSUE_STATUS_META.map((m) => ({ value: m.status, labelZh: m.labelZh, labelEn: m.labelEn })),
];
