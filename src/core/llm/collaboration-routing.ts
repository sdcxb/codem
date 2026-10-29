/**
 * 协作方式路由（场景 → 工具）—— 让「有这些工具」变成「该用的时候会用」。
 *
 * ## 为什么需要它
 *
 * 5 套协作机制（子代理 / 跨会话委派 / 交接 / squad 模板 / agent-teams）都是**常驻工具**，
 * 但模型的默认行为是"自己干"：它不会因为"这件事其实可以并行"就主动想起来还有 `subagent`。
 * 只把工具摆在那里（哪怕描述写得很全），在真实对话里仍然可能一次都不被选中。
 *
 * 这里的做法是**确定性路由**：只在用户的话里出现明确的协作意图时，往**尾部上下文**
 * 追加一小段「这类说法对应哪条路 + 第一步调什么 + 什么时候不该用」。
 * 它不唠叨（没命中就一个字不写）、不改 system 前缀（不破坏缓存）、也不是"再提醒模型一句"
 * 那种泛泛的提示 —— 它把**用户的措辞**映射到**具体的工具与顺序**。
 *
 * ## 边界（诚实说明）
 *
 * - 这是"意图 → 工具"的启发式，不保证模型一定照做；真正的选型准确率要用**带模型的评测**量
 *   （本文件只保证路由本身可测、可复现）。
 * - 只在**当前这条用户消息**上判定，一回合最多命中两条，避免把上下文写成说明书。
 * - 用户没提协作时**不注入**：绝大多数任务本来就该在主循环里做完
 *   （mcode-stack `subagent-split-check` 的第一条：没有上下文理由就别拆）。
 */

/** 四条被路由的路（side-session 是纯 UI 面板，不参与工具路由） */
export type CollaborationRoute = "team" | "team-status" | "delegation" | "subagent";

export interface RouteMatch {
  route: CollaborationRoute;
  /** 命中的用户原词（用于测试与解释，不注入） */
  matched: string;
}

const PATTERNS: Array<{ route: CollaborationRoute; re: RegExp }> = [
  {
    route: "team-status",
    re: /(团队.{0,8}(状态|进度|卡在|谁在|谁做)|team\s+(status|progress)|agent[_ ]teams_status|squad_status)/iu,
  },
  {
    route: "team",
    re: /(开个?团队|组个?队|建个?团队|组建团队|拉个?团队|团队来|小队|squad|team of agents|agent team)/iu,
  },
  {
    route: "delegation",
    re: /(交给.{0,12}(会话|对话)|另一个会话|新开.{0,6}(会话|对话)|让它接着|交给它接着|接手|交接|delegate|another session|hand off|handoff)/iu,
  },
  {
    route: "subagent",
    re: /(并行|分头|同时做|子任务|子代理|派个?子|拆给|subagent|in parallel|parallelize)/iu,
  },
];

/** 一段话里命中了哪些协作意图（去重、保持固定顺序） */
export function detectCollaborationRoutes(text: string): RouteMatch[] {
  const source = String(text ?? "");
  if (!source.trim()) return [];
  const hits: RouteMatch[] = [];
  for (const p of PATTERNS) {
    const m = p.re.exec(source);
    if (!m) continue;
    if (hits.some((h) => h.route === p.route)) continue;
    hits.push({ route: p.route, matched: m[0] });
  }
  return hits;
}

const ROUTE_HINTS: Record<CollaborationRoute, string> = {
  team: [
    "用户说的是**团队/小队**这类协作：",
    "1) 先 `squad_list` 看有没有现成模板；有就 `squad_dispatch`（模板 → 运行时团队 → 派任务）；",
    "2) 没有模板、但任务确实能按角色拆：`agent_teams_create` 建临时团队 → `agent_teams_add_member` →",
    "   `agent_teams_create_task`，用 `agent_teams_status` 看进度；",
    "3) **不该用**：任务只有一件事、或拆了会让交接成本大于收益 —— 那就在主循环里做完。",
  ].join("\n"),
  "team-status": [
    "用户在问**团队状态**：用 `agent_teams_status`（运行时团队）或 `squad_status`（模板/实例）回答，",
    "不要凭记忆猜成员在干什么。",
  ].join("\n"),
  delegation: [
    "用户说的是**交给另一个会话/接手/交接**：",
    "1) 目标是**已存在的会话** → `delegate_to_session`（可见、用户能接手；深度≤2、并发≤5）；",
    "2) 目标要**新开一个会话**并带上当前进展 → `handoff_to_new_session`（正文会过机械校验）；",
    "3) **不该用**：只需要一个结论、用户也不关心过程 → 用 `subagent`（内部会话，更轻）。",
    "这一轮请**先 `list_sessions` 找目标，再调用上面的工具**，不要在当前会话里自己把活干完。",
  ].join("\n"),
  subagent: [
    "用户说的是**并行/拆子任务**：用 `subagent` 开独立上下文的子任务（默认后台跑，完成会通知你）。",
    "边界：子任务要**不依赖主线的中间产物**、且你只需要它的结论；",
    "如果用户需要能打开/接手这段工作 → 改用 `handoff_to_new_session`。",
    "这一轮请**真的用 `subagent` 并行**（每个子任务一个），拿到结论后再汇总，不要串行自己跑。",
  ].join("\n"),
};

/**
 * 构造注入文本；没命中返回空串（**不注入**）。
 *
 * 最多两条：团队类优先，其次委派/子代理 —— 再多就变成说明书了。
 */
export function buildCollaborationRoutingHint(text: string): string {
  const hits = detectCollaborationRoutes(text);
  if (hits.length === 0) return "";
  const order: CollaborationRoute[] = ["team", "team-status", "delegation", "subagent"];
  const picked = order.filter((r) => hits.some((h) => h.route === r)).slice(0, 2);
  const lines = ["## Collaboration routing (matched your wording)"];
  for (const route of picked) {
    lines.push("", ROUTE_HINTS[route]);
  }
  return lines.join("\n");
}
