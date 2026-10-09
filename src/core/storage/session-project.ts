/**
 * 「会话 → 项目根路径」的**唯一实现**（第 191 波：全仓搜同类的收口）。
 *
 * ## 为什么需要它
 *
 * 修 O-46 时发现同一个事实在三条路径上各有一份等价反查：
 * - `core/llm/index.ts` 的 `resolveMemoryProjectId`（记忆归属的项目身份）；
 * - `core/session/executor.ts` 的安全模式解析（`getEffectiveSecurityMode(cwd)`）；
 * - `core/phone-link/phone-link.ts` 的 `cwdForSession`（**注意**：那条刻意**先取
 *   `worktreePath`**，回答的是"这个会话该在哪个目录跑"，与本模块回答的"这个会话属于哪个项目"
 *   是**两个不同的问题**，所以它不并入这里 —— 见下面的边界说明）。
 *
 * 前两条是**同一个问题**（会话属于哪个项目），而它们各自写了一遍
 * `getSession(id).projectId` → `getProject(pid).path`。本仓对"同一事实多份实现"的判断一贯是
 * P1（本轮已经收口了字节格式、亮度阈值、本地日窗口、消息计数四处），所以这里收成一份。
 *
 * ## 为什么安全模式那一侧是**缺陷**（不只是风格问题）
 *
 * `executor.executeSessionTurn` 是委派 / 微信桥 / 手机续聊的公共入口，它的 `cwd` 在 worktree
 * 会话上是**worktree 目录**。而项目级安全模式覆盖是按**项目根路径**存的键
 * （`permission/security-mode.ts` 的 `PROJECT_KEY_PREFIX + projectPath`）⇒ 拿 worktree 目录去查
 * **永远查不到**，于是静默退回全局模式。方向可能是**放松**（项目里设了 `ask`、全局是 `full`
 * ⇒ 后台/委派任务变成"永不询问"）—— 这是安全语义上的静默降级，必须修。
 *
 * ## 边界（如实写下）
 *
 * - 本函数只回答"**登记表里**这个会话属于哪个项目"；**不**回答"该在哪个目录执行"
 *   （那是 `cwd` / `worktreePath` 的问题），也**不**回答"当前界面在哪个项目"
 *   （那是 `currentProject` 的问题）；
 * - 查不到就返回 `undefined`（**不猜**）：调用方要么退回自己的最后一跳并**如实上报**，
 *   要么按"没有项目"处理。本模块不打印、不吞错 —— 只把 `catch` 收成 `undefined`
 *   并留一条 `console.warn`（读失败与"没登记"对调用方是同一个观测态）。
 */
import * as SessionStorage from "./session";
import * as ProjectStorage from "./project";

/**
 * 会话所属项目的**根路径**（登记表：`sessions.project_id` → `projects.path`）。
 *
 * @param sessionId 会话 id（缺省 / 查不到 ⇒ `undefined`，**不猜**）
 */
export function sessionProjectPath(sessionId?: string): string | undefined {
  if (!sessionId) return undefined;
  try {
    const row = SessionStorage.getSession(sessionId);
    const projectId = row?.projectId;
    if (!projectId) return undefined;
    const path = ProjectStorage.getProject(projectId)?.path;
    return typeof path === "string" && path.length > 0 ? path : undefined;
  } catch (e) {
    // 存储未就绪 / 读失败：与"没有登记"同一处置（调用方走自己的最后一跳，且那一跳要如实上报）
    console.warn(`[session-project] 读会话 ${sessionId} 的项目登记失败（按「查不到」处理）：`, e);
    return undefined;
  }
}
