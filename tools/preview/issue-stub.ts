/**
 * 预览构建用的 `IssueManager` 桩。
 *
 * 目的：让 `tools/preview` 能渲染**真实的**宿主 `IssueBoard`（看板子视图），
 * 把「看板内容与实时事件流互相遮挡」这类版面缺陷纳入自动审计。
 * 真 `core/issue/issue` 会一路依赖到 node 内建模块（spill-store / sql.js），
 * 浏览器预览构建不了；版面只取决于组件结构 + 样式，所以这里只替换数据源。
 */

const now = Date.now();

function mk(i: number, status: string, title: string) {
  return {
    id: `issue-preview-${i}`,
    title,
    description: null,
    status,
    priority: "normal",
    assigneeType: null,
    assigneeId: null,
    squadId: null,
    sessionId: null,
    labels: [],
    projectId: "preview-project",
    createdAt: now - i * 60_000,
    updatedAt: now - i * 60_000,
  };
}

const ISSUES = [
  mk(1, "backlog", "梳理权限模型"),
  mk(2, "backlog", "补依赖审计"),
  mk(3, "todo", "实现登录页"),
  mk(4, "todo", "拆分任务管理页签"),
  mk(5, "in_progress", "图书馆并入看板"),
  mk(6, "in_progress", "场景自动对位"),
  mk(7, "in_review", "任务管理审计修复"),
  mk(8, "blocked", "等上游 SDK 版本"),
  mk(9, "done", "统一 lucide 图标"),
  mk(10, "cancelled", "独立图书馆面板"),
];

export function getIssueManager() {
  return {
    list: () => ISSUES,
    get: (id: string) => ISSUES.find((i) => i.id === id) ?? null,
    getStats: () => ({}),
    update: () => undefined,
    onIssueChange: () => () => undefined,
  };
}

export type Issue = (typeof ISSUES)[number];
export type IssueWithComments = Issue;
