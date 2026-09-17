// @ts-nocheck
/**
 * @codem/agent-teams — 服务层（单例）
 *
 * 职责：
 * 1. 团队生命周期管理（create/get/delete）— 内存 Map + localStorage 持久化
 * 2. 成员 spawn：addMember 时经 SubagentRuntime.startContinuable 创建可续聊
 *    子 agent（成员 = 独立子会话，队长可 send_message 唤醒续聊）
 * 3. 邮箱投递：sendMessage → 直投（成员 live/idle）或持久化邮箱（回退）
 * 4. 调度 kick：任务图变更后尝试把就绪任务派给空闲成员（引擎原子领取 +
 *    投递失败精确回滚）
 * 5. 变更订阅（UI 活动面板刷新）
 *
 * 引擎为纯逻辑（engine.ts，全部可测）；本层收敛并发（单进程同步调用）。
 *
 * ========== 为什么这个域**刻意不进 SQLite**（任务 C-10 的结论） ==========
 *
 * 任务书要求：先判断"完全绕过端口（localStorage）"是**有意设计**还是**漏接线**，
 * 无任何说明则视为漏接线。结论是 **有意设计**，证据有四条（都能复核）：
 *
 * 1. **上游没有这张表**：`src-tauri/codem-db/sql/schema.sql` 的 39 张表里
 *    没有任何 `agent_teams*`（`grep -i agent_teams sql/schema.sql` = 0 命中），
 *    `sql/tables.json`（由 TS SCHEMA 生成、`audit:schema-parity` 守着的真源清单）
 *    同样没有。也就是说：**没有任何一层声明过要把团队入库** ——
 *    这与"漏接线"（表建好了、读写还打旧库）的形态明显不同。
 * 2. **生命周期与进程强绑定**：成员是 `SubagentRuntime` 里的**活对象**
 *    （`Activation`：AbortController / poke Promise / executionDone）。
 *    重启后它们**一定**不存在 —— 这正是 `reconcileAfterRestart()` 存在的理由：
 *    它把 `working` 成员改回 `idle`、作废 claim 令牌、取消转派静默期。
 *    把这份"活状态"持久化进库只会制造一种更坏的假象（库里写着 working，进程里什么都没有）。
 * 3. **已显式处理重启语义**：`reconcileAfterRestart()` 的注释写明"团队状态持久化在
 *    localStorage，但进程内没有任何东西在跑"，并逐条定义了对账规则。
 *    这是**有意的设计决策留下的痕迹**，不是遗忘。
 * 4. **持久化失败是可见的**：`load()` 对损坏数据有 `console.warn`（含原始错误），
 *    `persist()` 的 catch 目前是空的 —— 见下面 `persist()` 的说明（那一处已修）。
 *
 * 因此本任务**不做**"接进端口"的大重构（没有表、也没有一致的归属/权限语义，
 * 硬接会引入"库里的团队与进程里的活状态不一致"这类新缺陷）。
 * 若将来要入库，需要的是**先有 schema**（另一个人/另一波），
 * 并且要同时回答"重启后成员怎么办" —— 见报告的"需要他人配合"清单。
 */

import {
  createTeam, addMember as engineAddMember, removeMember as engineRemoveMember,
  createTask, claimTask, updateTask, beginReassign, finishReassign, cancelReassign,
  appendMailbox, claimMailbox, acknowledgeMailbox, releaseMailbox,
  unreadMailbox, snapshot, nextReadyTask, rollbackClaim,
  genId,
} from "../agent-teams/engine";
import type { AgentTeam, TeamSnapshot } from "../agent-teams/types";
import { CAPTAIN, TASK_TERMINAL } from "../agent-teams/types";
import { getSubagentRuntime } from "../subagent/index";
import { reportPersistFailure } from "../storage/persist-failure";

const STORE_KEY = "codem-agent-teams:v1";

export type AgentTeamsChangeListener = () => void;

interface SendResult {
  mode: "live" | "wake" | "mailbox";
}

export class AgentTeamsServiceClass {
  private teams = new Map<string, AgentTeam>();
  private listeners = new Set<AgentTeamsChangeListener>();

  constructor() {
    this.load();
  }

  // ========== 持久化 ==========

  private load(): void {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return;
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) for (const t of arr) if (t && t.id) this.teams.set(t.id, t);
      else console.warn("[agent-teams] 持久化数据不是数组，已忽略（团队列表为空）：", typeof arr);
      this.reconcileAfterRestart();
    } catch (e) {
      // 原来这里静默吞掉：数据损坏时用户看到的是"团队凭空消失"，没有任何线索
      console.warn("[agent-teams] 团队持久化数据损坏，无法恢复（团队列表将为空）：", e);
    }
  }

  /**
   * 重启对账（第 84 波审计修正）。
   *
   * 缺陷：团队状态持久化在 localStorage，但**进程内没有任何东西在跑**。
   * 重启后 `working` 的成员会让 `kick()` 永远跳过它、`reassigning` 的任务
   * 会让 `nextReadyTask`/`claimTask` 永远拒绝它、带 attemptId 的 claimed 任务
   * 指向一个已经不存在的执行 —— 三者合起来就是"任务永远没人做、界面还显示工作中"。
   *
   * 对账规则（只动"当前进程不可能还在进行"的状态，并逐条记录原因）：
   *   · 成员 working → idle（并写明原因）
   *   · 任务 reassigning → 取消静默期，回共享池
   *   · 任务 claimed/in_progress 且带 attemptId → 令牌作废，回共享池重新调度
   */
  private reconcileAfterRestart(): void {
    const now = Date.now();
    let changed = false;
    for (const team of this.teams.values()) {
      if (team.archived) continue;
      const notes: string[] = [];
      for (const m of team.members) {
        if (m.status === "working") {
          m.status = "idle";
          changed = true;
          notes.push(`成员 ${m.name}：工作中 → 空闲（应用已重启，原执行不存在）`);
        }
      }
      for (const t of team.tasks) {
        if (TASK_TERMINAL.has(t.status)) continue;
        if (t.reassigning) {
          cancelReassign(team, t.id, t.assignee);
          changed = true;
          notes.push(`任务 ${t.id}：清除未完成的转派静默期，回到共享池`);
          continue;
        }
        if (t.attemptId && (t.status === "claimed" || t.status === "in_progress")) {
          t.status = "pending";
          t.attemptId = undefined;
          t.updatedAt = now;
          changed = true;
          notes.push(`任务 ${t.id}：领取令牌已随重启失效，回到共享池重新调度`);
        }
      }
      if (notes.length) {
        console.warn(`[agent-teams] 重启对账（${team.name}）：\n- ${notes.join("\n- ")}`);
        this.addAlerts(team.id, notes.map((n) => `重启对账：${n}`));
      }
    }
    if (changed) this.persist();
  }

  private persist(): void {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify([...this.teams.values()]));
    } catch (e) {
      /**
       * 第 44 轮：从**空 catch** 改成走仓库既有的失败通道 `reportPersistFailure`。
       *
       * 这段注释原来写着"刻意保持空 catch"，理由是"补一行 `console.warn` 会被
       * `audit:false-success` 的 P2 规则判为『写类函数的 catch 只有日志』"。
       * 那个判断**只对了一半**：门禁拦的是**只打日志**（catch 体完全由 `console.*` 组成），
       * 而它同时给出了正解 —— 让失败走**可处理的通道**。
       * `reportPersistFailure` 正是本仓库那条通道：它把失败写进失败台账、
       * 派发窗口事件、让"数据没保存"在界面上可见（而 `console.warn` 只进控制台）。
       *
       * 为什么这是等价于"修好"而不是"换个写法"：
       * 这个域的写入**只**落在 localStorage（文件头四条证据说明"不入库"是有意设计），
       * 所以"写失败"没有事务可回滚、也没有第二份副本 —— 它能做到的全部，就是**如实说出来**。
       * 空 catch 反而是这里唯一真正坏的选择：用户重启后发现团队没了，而日志里什么都没有。
       */
      reportPersistFailure(
        "agentTeams.persist",
        e,
        "团队状态未持久化（本进程内仍可用；重启后这些团队与任务看板会消失）",
      );
    }
  }

  // ========== 订阅 ==========

  subscribe(fn: AgentTeamsChangeListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify(): void {
    for (const fn of this.listeners) { try { fn(); } catch { /* noop */ } }
  }

  // ========== 告警（可见性） ==========

  private alerts = new Map<string, string[]>();

  /** 记录一条团队级告警（供 status 输出/UI 展示，不进持久化） */
  private addAlerts(teamId: string, notes: string[]): void {
    if (notes.length === 0) return;
    const cur = this.alerts.get(teamId) ?? [];
    for (const n of notes) if (!cur.includes(n)) cur.push(n);
    this.alerts.set(teamId, cur.slice(-20));
  }

  getAlerts(teamId: string): string[] {
    return [...(this.alerts.get(teamId) ?? [])];
  }

  // ========== 团队 CRUD ==========

  get(id: string): AgentTeam | undefined { return this.teams.get(id); }

  /** 队长当前活动团队（一人一队） */
  activeTeamOf(captainSessionId: string): AgentTeam | undefined {
    return [...this.teams.values()].find((t) => !t.archived && t.captainSessionId === captainSessionId);
  }

  create(input: { name: string; captainSessionId: string }): AgentTeam {
    // 队长同刻只带一个活动团队
    const existing = this.activeTeamOf(input.captainSessionId);
    if (existing) throw new Error(`captain already leads team "${existing.name}" (${existing.id}) — delete it first`);
    const team = createTeam(input);
    this.teams.set(team.id, team);
    this.persist();
    this.notify();
    return team;
  }

  /**
   * "删除"一个团队 —— 实际上只是把 `archived` 置 1（任务 C-10 的第二半）。
   *
   * ## 为什么不改（以及为什么"无恢复入口"在这里是可接受的）
   *
   * `deleteTeam` 的名字与行为不符：它**不删任何东西**，只置 `archived = true`；
   * 而 `listAll()` 又过滤掉已归档的 → 界面上表现为"部署没了"，且没有恢复入口。
   *
   * 在 squad / inbox 那两个域里，同样的形态是**真缺陷**（C-6）：
   * 那里的行是**用户数据**（团队配置、通知），丢了就是丢了，
   * 而"归档"是 UI 上唯一的移除入口 —— 误点等于永久删除。
   *
   * 这里不同：本域的状态**本来就随进程丢弃**（见文件头的四条证据，
   * 尤其 `reconcileAfterRestart()`）。也就是说，即使给"归档的团队"做一个恢复入口，
   * 恢复回来的也只是一个**没有成员在跑的壳**（成员是 `SubagentRuntime` 里的活对象，
   * 重启即不存在）。所以"归档 = 软删除 + 不展示"是本域**有意**的终态，
   * 而不是一个漏了恢复入口的缺陷 —— 这里补注释而不是补功能。
   *
   * （如果将来这个域真的入库了，这条结论必须重新评估：那时团队就是持久用户数据，
   *  恢复入口必须有 —— 与 C-6 同一条判据。）
   */
  deleteTeam(teamId: string): void {
    const team = this.teams.get(teamId);
    if (!team) return;
    team.archived = true;
    this.persist();
    this.notify();
  }

  // ========== 成员 ==========

  /** 添加成员并 spawn 可续聊子 agent */
  async addMember(teamId: string, input: {
    name: string; role?: string; provider?: string; model?: string;
    reasoningEffort?: "low" | "medium" | "high";
    parentSessionId: string;
  }) {
    const team = this.teams.get(teamId);
    if (!team) throw new Error(`team "${teamId}" not found`);

    // 1. 引擎加成员（名唯一校验）
    const { member } = engineAddMember(team, {
      id: `member-pending-${genId("m")}`,
      name: input.name,
      role: input.role,
      provider: input.provider,
      model: input.model,
      reasoningEffort: input.reasoningEffort,
    });

    // 2. 尽量 spawn 可续聊子 agent（成员 = 独立子会话）；失败则成员标记 absent
    const rt = getSubagentRuntime();
    if (!rt) {
      // 无 subagent runtime（测试/未初始化）：成员不可唤醒 → absent（kick 跳过）
      member.status = "absent";
    } else {
      try {
        const started = await rt.startContinuable({
          provider: "spawn",
          label: `team:${input.name}`,
          request: {
            prompt: this.memberWelcomePrompt(team, input),
            parentSessionId: input.parentSessionId,
            cwd: this.cwdOf(input.parentSessionId),
            agentId: "general",
          },
          signal: new AbortController().signal,
        });
        member.id = started.childId; // 成员 = 持久子会话 id
        member.status = "idle";
      } catch (e) {
        console.warn("[agent-teams] member spawn failed (member stays 'absent'):", e);
        member.status = "absent";
      }
    }

    this.persist();
    this.notify();
    return { member };
  }

  /** 移除成员：撤销未完成任务 → 标记 removed（中断子会话由上层 subagent 体系处理） */
  removeMember(teamId: string, name: string) {
    const team = this.teams.get(teamId);
    if (!team) throw new Error(`team "${teamId}" not found`);
    const { removed } = engineRemoveMember(team, name);
    this.persist();
    this.notify();
    return { removed };
  }

  private memberWelcomePrompt(team: AgentTeam, input: { name: string; role?: string }): string {
    const zh = true; // 成员 prompt 跟随当前语言 —— 用中性双语更稳
    return [
      `You are a member "${input.name}" of the team "${team.name}"${input.role ? `, role: ${input.role}` : ""}.`,
      "You collaborate via the agent_teams_* tools: claim tasks with agent_teams_claim_task (carry the returned attempt_id), update with agent_teams_update_task, report to the captain or teammates with agent_teams_send_message, and check the board with agent_teams_status. Never fabricate task states — only update tasks you actually claimed.",
      "When you finish a task, call agent_teams_update_task with status=completed and an output summary.",
    ].join("\n\n");
  }

  private cwdOf(_sessionId: string): string {
    try {
      // ESM: dynamic import（此路径仅供 spawn 成员时取项目 cwd，失败回退 process.cwd）
      const { useProjectStore } = require("../store");
      return useProjectStore.getState().currentProject?.path || "";
    } catch {
      return "";
    }
  }

  // ========== 任务 ==========

  createTask(teamId: string, input: { subject: string; description?: string; dependencies?: string[]; assignee?: string }) {
    const team = this.teams.get(teamId);
    if (!team) throw new Error(`team "${teamId}" not found`);
    const { task } = createTask(team, input);
    this.persist();
    this.notify();
    this.kick(teamId);
    return { task };
  }

  claim(teamId: string, taskId: string, by: string) {
    const team = this.teams.get(teamId);
    if (!team) throw new Error(`team "${teamId}" not found`);
    const r = claimTask(team, taskId, by);
    this.persist();
    this.notify();
    return { teamId, taskId, attemptId: r.attemptId, attempt: r.attempt };
  }

  update(teamId: string, taskId: string, input: { status: any; output?: string; attemptId?: string; by: string }) {
    const team = this.teams.get(teamId);
    if (!team) throw new Error(`team "${teamId}" not found`);
    const { task } = updateTask(team, taskId, input);
    // 任务进入终态 → 释放该成员（否则成员会永久停在 working，调度器再也不派活，
    // 依赖成员状态的监控视图也会一直显示「工作中」）
    this.releaseAssigneeIfIdle(team, task.assignee);
    this.persist();
    this.notify();
    this.kick(teamId);
    return { teamId, taskId, task };
  }

  /**
   * 转派：撤销旧 attempt → 静默期 → 对新 assignee 开新 attempt。
   *
   * 第 84 波（B 类缺陷）：原来**只有** `newAssignee === CAPTAIN` 时才结束静默期。
   * 转派给普通成员时任务会永久停在 `reassigning: true`：
   * `nextReadyTask` 跳过它、`claimTask` 抛 "is being reassigned; try later"，
   * 而 `kick()` 也永远不会派它 —— 任务彻底卡死且界面上看不出原因。
   * 现在两种目标都结束静默期；若开新 attempt 失败（例如依赖未满足），
   * 也必须清掉静默标记（否则同样永久卡死），并把原因报出来。
   */
  reassign(teamId: string, taskId: string, newAssignee: string) {
    const team = this.teams.get(teamId);
    if (!team) throw new Error(`team "${teamId}" not found`);
    const r = beginReassign(team, taskId, newAssignee);
    // 旧负责人不再持有该任务 → 若无其它在办任务则释放为 idle
    this.releaseAssigneeIfIdle(team, r.previousAssignee);

    let claimed = false;
    let note: string | undefined;
    try {
      finishReassign(team, taskId, newAssignee);
      claimed = true;
    } catch (e: any) {
      cancelReassign(team, taskId, newAssignee);
      note = `已清除转派静默期，但未能立即开新领取：${e?.message || e}`;
      this.addAlerts(teamId, [note]);
      console.warn(`[agent-teams] reassign(${taskId} → ${newAssignee}): ${note}`);
    }

    this.persist();
    this.notify();
    this.kick(teamId);
    return { ...r, claimed, note };
  }

  /**
   * 释放成员：当该成员名下已无非终态任务且当前状态为 working 时置回 idle。
   * 队长（"captain"）与非成员标识不处理。
   */
  private releaseAssigneeIfIdle(team: AgentTeam, assignee: string | undefined): void {
    if (!assignee || assignee === CAPTAIN) return;
    const member = team.members.find((m) => m.name === assignee);
    if (!member || member.status !== "working") return;
    const stillBusy = team.tasks.some(
      (t) => t.assignee === assignee && !TASK_TERMINAL.has(t.status),
    );
    if (stillBusy) return;
    member.status = "idle";
  }

  // ========== 邮箱 / 消息 ==========

  /** 成员或队长发消息：先入邮箱，尽力直投（live/wake），失败留在邮箱等调度重投 */
  async sendMessage(teamId: string, to: string, content: string, from: string): Promise<{ mode: "live" | "wake" | "mailbox" }> {
    const team = this.teams.get(teamId);
    if (!team) throw new Error(`team "${teamId}" not found`);
    const msg = appendMailbox(team, { to, from, content });

    const delivered = await this.deliverMailbox(teamId, to);
    this.persist();
    this.notify();
    return { mode: delivered };
  }

  /** 尝试投递某收件人邮箱中未投递消息。直投成功才 ack；失败 release（下次调度重投）。 */
  private async deliverMailbox(teamId: string, to: string): Promise<"live" | "wake" | "mailbox"> {
    const team = this.teams.get(teamId);
    if (!team) return "mailbox";
    const pending = unreadMailbox(team, to);
    if (pending.length === 0) return "live";

    // 队长收件：通过队长会话 inbox 机制通知（简化：ack 即视为已投递，UI 面板可见）
    if (to === CAPTAIN) {
      acknowledgeMailbox(team, pending.map((m) => m.id));
      return "live";
    }

    // 成员收件：若成员 live 且可唤醒 → followup；否则留邮箱
    const member = team.members.find((m) => m.name === to);
    if (!member || member.status === "removed") {
      // 无此成员：退回（不投递，留在邮箱供队长查看）
      return "mailbox";
    }
    claimMailbox(team, pending.map((m) => m.id));
    try {
      const rt = getSubagentRuntime();
      if (rt && member.status !== "absent") {
        const text = pending.map((m) => `[${m.from}] ${m.content}`).join("\n\n");
        /**
         * 第 83 波（审计修正）：**参数位置全错**。
         *
         * `SubagentRuntime.followup` 的签名是 `(parentSessionId, childId, message, options)`，
         * 这里原来只传了 3 个：`(member.id, text, {signal})` —— 于是
         * `parentSessionId = member.id`、`childId = 正文` → `activations.get(正文)` 必然 undefined →
         * **每次都抛 "Subagent … is not live"**，被 catch 吞掉降级成"留邮箱"，
         * 而工具文案却写"消息已投递"。成员收件从此永远走不通。
         *
         * 成员是用 `parentSessionId: captainSessionId` spawn 的（见 addMember），所以父会话就是队长会话。
         */
        await rt.followup(team.captainSessionId, member.id, text, { signal: new AbortController().signal });
        acknowledgeMailbox(team, pending.map((m) => m.id));
        return "wake";
      }
    } catch (e) {
      console.warn("[agent-teams] member wake failed, leaving in mailbox:", e);
    }
    releaseMailbox(team, pending.map((m) => m.id));
    return "mailbox";
  }

  // ========== 调度 ==========

  /**
   * 任务图变更后尝试派活：找空闲成员 + 就绪任务，引擎原子领取 → 唤醒。
   * 简化（单进程同步语义）：对每个非 removed 成员，若有就绪任务则领取并唤醒。
   *
   * 第 84 波（B 类缺陷）：**领取前必须确认成员真的能被唤醒**。
   * 原来先 `claimTask`（任务立刻被"幽灵成员"占住，别人再也看不到它）再投递，
   * 而 `followup` 在应用重启后必然抛 "is not live or has settled" —— 于是任务
   * 在 claim/rollback 之间反复横跳、成员状态在 working/idle 之间抖动，队长看到的
   * 只有"任务一直 pending"。现在先验证子会话存在，不存在就把成员标成离线并给出
   * 可执行的建议（重新添加成员 / 转派给队长）。
   */
  private kick(teamId: string): void {
    const team = this.teams.get(teamId);
    if (!team || team.archived) return;
    const rt = getSubagentRuntime();
    for (const member of team.members) {
      if (member.status === "removed" || member.status === "working") continue;
      const task = nextReadyTask(team, member.name);
      if (!task) continue;

      // 唤醒能力前置校验：子会话不存在 → 不领取（否则任务被占住没人做）
      //
      // 注意：`getTask` 是运行时的新接口，某些注入的运行时实现（测试替身、旧版插件）
      // 可能没有它。拿不到"子会话是否存在"这一事实时**不能**当成"不存在"
      // （那会把能用的成员误标离线），退回原来的"先试投递、失败再回滚"逻辑。
      const canLookUpChild = typeof (rt as any)?.getTask === "function";
      const child = canLookUpChild ? (rt as any).getTask(member.id) : undefined;
      if (!rt || (canLookUpChild && !child)) {
        if (member.status !== "absent") member.status = "absent";
        this.addAlerts(teamId, [
          `成员 ${member.name} 无法唤醒（子会话 ${member.id} 不存在，通常是应用重启后需要重新添加成员）；` +
          `任务 ${task.id} 仍留在共享池，可用 agent_teams_reassign_task 指派给 captain 由队长自己完成。`,
        ]);
        console.warn(
          `[agent-teams] 跳过唤醒：成员 ${member.name}(${member.id}) 的子会话不存在，任务 ${task.id} 未领取`,
        );
        continue;
      }
      if (member.status === "absent") member.status = "idle"; // 子会话又在了 → 离线状态作废

      try {
        const r = claimTask(team, task.id, member.name);
        member.status = "working";
        // 异步唤醒（不阻塞工具返回）
        const assignment = `[任务分配] ${task.id}: ${task.subject}${task.description ? "\n" + task.description : ""}\n` +
          `用 agent_teams_claim_task 领取（会返回同一 attempt_id ${r.attemptId}），完成后 agent_teams_update_task(status=completed, attempt_id=…)。`;
        rt.followup(team.captainSessionId, member.id, assignment, { signal: new AbortController().signal }).catch((e) => {
          // 第 83 波：投递失败必须**可见**（原来是空 catch：任务被回滚、成员回到 idle，
          // 但没有任何日志/状态说明，队长只能看到任务一直 pending 却不知道原因）
          const reason = e?.message || String(e);
          console.warn(
            `[agent-teams] 唤醒成员失败（${member.name}/${member.id}，任务 ${task.id}）：${reason} —— 已回滚领取，成员回到 idle`,
          );
          this.addAlerts(teamId, [`唤醒成员 ${member.name} 失败（任务 ${task.id}）：${reason} —— 已回滚，任务回到共享池`]);
          rollbackClaim(team, task.id, r.attemptId, task.assignee);
          member.status = "idle";
          this.persist();
          this.notify();
        });
      } catch {
        /* claim race — next member */
      }
    }
    this.persist();
    this.notify();
  }

  // ========== 查询 ==========

  status(teamId: string): TeamSnapshot {
    const team = this.teams.get(teamId);
    if (!team) throw new Error(`team "${teamId}" not found`);
    const snap = snapshot(team);
    const alerts = this.getAlerts(teamId);
    return alerts.length ? { ...snap, alerts } : snap;
  }

  listAll(): AgentTeam[] {
    return [...this.teams.values()].filter((t) => !t.archived);
  }
}

let svcInstance: AgentTeamsServiceClass | null = null;

export const AgentTeamsService = {
  getInstance(): AgentTeamsServiceClass {
    if (!svcInstance) svcInstance = new AgentTeamsServiceClass();
    return svcInstance;
  },
  /** 测试用重置 */
  _reset(): void {
    try { localStorage.removeItem(STORE_KEY); } catch { /* noop */ }
    svcInstance = null;
  },
};
