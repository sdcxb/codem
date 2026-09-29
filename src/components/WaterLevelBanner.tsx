/**
 * 上下文水位的**常驻提示条**（第 122 轮）。
 *
 * ## 为什么必须有一个"不用打开面板就能看到"的水位提示
 *
 * 第 122 轮之前的现状（用户实际遇到的问题）：
 *
 * - 水位计算与告警文案**都已经有了** —— `core/context/context.ts` 有
 *   `PRESSURE_THRESHOLDS = [0.5, 0.7, 0.9]`，`ContextMonitor.tsx` 里有
 *   「⚠️ 上下文压力较高，建议压缩或开启新对话」与「🔴 上下文即将满！请立即压缩或开启新对话」；
 * - 但它们只渲染在 `ContextMonitor` 里，而 `ChatPanel` 把这个面板放在
 *   `showContextMonitor`（**默认 false**）后面 —— 也就是说：
 *   **用户不主动点开那个按钮，就永远看不到这条告警。**
 *
 * 后果正是用户描述的那种体验："聊到后面效果突然就变差了，没有任何提示"。真实机制是
 * `agentic-loop.ts::buildMessages` 在超预算时**静默**丢掉最早的消息、丢掉没有对应结果的
 * `tool_calls`，只写一行 `console.warn` —— 模型那边少了东西，用户这边一片安静。
 *
 * 所以这个组件做三件事（对应本轮 A/B/C 三项）：
 *
 * | | 做什么 | 为什么 |
 * |---|---|---|
 * | A | 占用 ≥ 70% 时**自动出现**，不必打开任何面板 | 风险要可见，不能靠用户自己去找 |
 * | B | 文案里写明"会发生什么"（旧消息与工具结果会被丢弃、回答质量会下降） | 「效果变差」的机制必须说出来，否则用户只会觉得"这模型不行" |
 * | C | 两个出口**代价不同**且写得一样清楚 | 「压缩」保留摘要、同一会话继续；「新对话」窗口干净但上下文归零 |
 *
 * ## 「开启新对话」不是从零开始，而是**会话交接**
 *
 * 平台本来就有会话交接能力（第 62/63/65 波：`handover.ts` 协议校验 +
 * `orchestrator.delegate` + `executor.executeSessionTurn`），此前只有**模型**能发起
 * （通过 `delegate_to_session` 工具）。这里把它接到 UI 上：点一下就
 * 建新会话 + 把当前工作交接过去，用户不必自己复述"我们刚才在干什么"。
 *
 * 交接正文由 `core/session/ui-handoff.ts` **机械生成**（不交给模型自由写 —— 第 62 波
 * 事故的根因就是模型写出了几千字的"意图复述"、没有任何状态与指针）。
 *
 * ## 关闭与重新出现（用户选定的规则）
 *
 * 可手动关闭；关掉之后水位**再涨 5 个百分点**会重新出现。为什么不是"关了就永远不出现"：
 * 那是把风险静音 —— 用户关它的时候往往是"我看见了，先干完这一句"，而不是"以后都别提醒我"。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowRight, Layers, X } from "lucide-react";
import type { Message } from "../store";
import { useProjectStore } from "../core/store";import { useLang } from "../core/i18n/lang";
import { listVisibleMessages } from "../core/storage/message";
import { reportActionFailure, reportAdvisory } from "../core/storage/persist-failure";
import { getDelegationOrchestrator } from "../core/session/orchestrator";
import { buildHandover } from "../core/session/ui-handoff";
import { WATER_LEVEL, useContextWaterLevel } from "../core/context/water-level";
import { readContextDrop, subscribeContextDrop, contextDropVersion } from "../core/llm/context-visibility";

/** 被关掉之后，水位再涨这么多（5 个百分点）就重新出现 */
const RE_ALERT_DELTA = 0.05;

export interface WaterLevelBannerProps {
  /** 水位取哪个会话（空串 = 没有会话，不显示） */
  sessionId: string;
  /** 「查看上下文详情」→ 打开既有的 ContextMonitor 面板 */
  onOpenDetail: () => void;
}

export function WaterLevelBanner({ sessionId, onOpenDetail }: WaterLevelBannerProps) {
  const lang = useLang();
  const zh = lang === "zh";
  /**
   * 水位来自**共享模块**（`core/context/water-level.ts`），与 `ContextMonitor` 面板
   * 同一个函数、同一对分子分母 —— 第 72 轮那次"进度条 21% + 压力等级 临界"的自相矛盾
   * 就是这么来的，提示条不能变成第三个口径。
   *
   * 刷新由 hook 内部的 3 秒轮询驱动（与面板同频），理由见 `useContextWaterLevel` 的注释：
   * 长会话里没有便宜的"消息版本号"可用（`useAppStore().messages` 只有最后 10 条）。
   */
  const level = useContextWaterLevel(sessionId);
  /** 用户关掉时的水位比值；null = 当前没被关掉 */
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const [busy, setBusy] = useState<"compact" | "handoff" | null>(null);
  /** 交接结果：成功与失败都必须说出来（不能只在控制台里） */
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const createSession = useProjectStore((s) => s.createSession);

  /**
   * 本轮真的丢了什么（B 项后半）。
   *
   * 数据由 `buildMessages` 经 `recordContextDrop` 投过来（那是**已经算出来、
   * 此前只喂给模型与 `console.warn`** 的同一份事实）。这里用订阅而不是轮询：
   * 丢弃发生在某一轮里，等 3 秒轮询会把它和后续状态混在一起。
   */
  const [dropTick, setDropTick] = useState(() => contextDropVersion());
  useEffect(() => subscribeContextDrop(() => setDropTick(contextDropVersion())), []);
  const drop = useMemo(() => {
    void dropTick; // 订阅版本号变化时重读（它本身就是唯一的依赖）
    return readContextDrop(sessionId);
  }, [sessionId, dropTick]);
  const dropToolPart = useMemo(() => {
    if (!drop) return "";
    return Object.entries(drop.toolCounts)
      .map(([name, count]) => `${name}×${count}`)
      .join("、");
  }, [drop]);

  useEffect(() => {
    // 换会话时旧会话的"已关闭"状态与提示不该跟过来
    setDismissedAt(null);
    setNote(null);
  }, [sessionId]);

  /**
   * 是否显示。
   *
   * 两条独立的显示理由（**任一条成立就要显示**）：
   *
   * 1. **风险**：到达告警水位（等级 ≥ 2，即 ≥ 70%）且没被"当前这一档水位"关掉；
   *    等级 ≤ 1（< 70%）时不打扰 —— 提示条是风险信号，不是常驻仪表（仪表在面板里）。
   * 2. **事实**：本轮**已经真的丢过**上下文 —— 这时哪怕水位已经掉回 70% 以下
   *    （压缩、裁剪都会让它掉下来），也必须说：模型这一轮的确少看到了东西。
   *    只说"将来会丢"而把"已经丢了"藏起来，正是用户抱怨的那种"没有任何提示"。
   */
  const visible = useMemo(() => {
    if (!sessionId) return false;
    if (drop && (drop.droppedMessages > 0 || drop.strippedToolCalls > 0)) return true;
    if (level.level < WATER_LEVEL.HIGH) return false;
    if (dismissedAt !== null && level.ratio < dismissedAt + RE_ALERT_DELTA) return false;
    return true;
  }, [sessionId, level.level, level.ratio, dismissedAt, drop]);

  const dismiss = useCallback(() => setDismissedAt(level.ratio), [level.ratio]);

  /**
   * 「开启新对话（交接当前工作）」。
   *
   * 步骤与失败处理：
   * 1. 事实取自**当前会话的可见消息**（与水位同一入口）；
   * 2. `buildHandover` 机械生成交接正文，并顺便跑一遍 `checkHandover`；
   * 3. 建新会话 → `orchestrator.delegate(源 → 新)` → 目标会话由 App 的委派监听取走执行
   *    （这条链是既有的，第 62 波起就在跑）；
   * 4. 任何一步失败都**如实说出**，不留"看起来点成功了但什么都没发生"。
   */
  const handleHandoff = useCallback(async () => {
    if (busy) return;
    const sourceSessionId = sessionId;
    if (!sourceSessionId) return;
    setBusy("handoff");
    setNote(null);
    try {
      const messages = listVisibleMessages(sourceSessionId) as unknown as Message[];
      const cwd = useProjectStore.getState().currentProject?.path || "";
      /**
       * 目标段优先取"最近一次用户请求"。
       *
       * 这里用 `filter().pop()` 而不是 `findLast`：`tsconfig.json` 的 lib 是 ES2021，
       * `Array.prototype.findLast` 要 ES2023 —— 用它会让 `tsc` 报错（而不是静默降级）。
       */
      const userTurns = messages.filter((m) => m.role === "user" && String(m.content ?? "").trim());
      const lastUserRequest = userTurns.length > 0 ? String(userTurns[userTurns.length - 1].content).trim() : "";
      const handover = buildHandover(messages as never[], { cwd, goal: lastUserRequest.slice(0, 200) });

      if (!handover.check.ok) {
        /**
         * 机械生成的交接**理论上**一定合规（正文里的路径都经磁盘核实，完成判据固定可判定）。
         * 真出现不合规，说明本模块的模板与 `handover.ts` 的校验规则脱钩了 ——
         * 这是**代码缺陷**，不能悄悄降级成"发一份不合规的交接"（那正是第 62 波事故）。
         */
        reportAdvisory("waterLevel.handover.invalid", zh
          ? `生成的交接正文未通过协议校验（${handover.check.error?.slice(0, 120) ?? "未知原因"}），已取消本次交接。`
          : `Generated handover failed protocol check; handoff cancelled.`);
        setNote({ ok: false, text: zh ? "交接正文未通过协议校验，已取消（详见提示条上方告警）" : "Handover failed protocol check; cancelled." });
        return;
      }

      const target = createSession(zh ? "交接会话" : "Handover session");
      if (!target?.id) throw new Error(zh ? "新建会话失败（没有拿到会话 id）" : "New session was not created");

      const projectId = useProjectStore.getState().currentProject?.id || "";
      const task = await getDelegationOrchestrator().delegate({
        sourceSessionId,
        targetSessionId: target.id,
        task: handover.body,
        projectId,
      });

      setNote({
        ok: true,
        text: zh
          ? `已把当前工作交接给新对话（委派 ${task.id}）：新对话拿到的是「状态 + 指针」，不是从零开始。`
          : `Work handed to a new conversation (delegation ${task.id}).`,
      });
      setDismissedAt(null);
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      reportActionFailure("waterLevel.handoff", e, zh
        ? `会话交接未完成：${detail}（新对话可能已建立，但工作没有被交过去）`
        : `Handoff failed: ${detail}`);
      setNote({ ok: false, text: zh ? `交接失败：${detail}` : `Handoff failed: ${detail}` });
    } finally {
      setBusy(null);
    }
  }, [busy, sessionId, createSession, zh]);

  if (!visible && !note) return null;

  const critical = level.level >= WATER_LEVEL.CRITICAL;
  const remain = Math.max(0, level.available - level.used);

  return (
    <div
      className={`water-level-banner ${critical ? "is-critical" : "is-high"}`}
      role="status"
      aria-live="polite"
      data-testid="water-level-banner"
      data-level={level.level}
      data-percent={level.percent}
    >
      <span className="water-level-icon" aria-hidden="true">
        {/*
          图标尺寸走**语义刻度**（`.icon-md` / `.icon-sm`），不写字面 `size={N}` ——
          这是 `ICON-1` 棘轮的要求（全仓字面尺寸只许降，第 897 处就是历史账）。
          新写的图标一律用类名，于是这条棘轮不会再被我这轮推高。
        */}
        <AlertTriangle className="icon-md" />
      </span>
      <div className="water-level-body">
        <span className="water-level-title">
          {critical
            ? zh
              ? `上下文即将满（已用 ${level.percent}%）`
              : `Context nearly full (${level.percent}% used)`
            : zh
              ? `上下文压力偏高（已用 ${level.percent}%）`
              : `Context pressure high (${level.percent}% used)`}
        </span>
        {/*
          B 项：把"会发生什么"说清楚。压缩/丢弃是**静默**发生在 `buildMessages` 里的，
          用户只感觉到"回答变差了"。这里写明机制，用户的判断才有依据。
        */}
        <span className="water-level-detail">
          {zh
            ? `剩余约 ${remain.toLocaleString()} tokens。继续下去，最早的消息与工具结果会被逐步丢弃（这一步是静默的），回答质量会跟着下降 —— 不是模型变差了。`
            : `About ${remain.toLocaleString()} tokens left. Beyond this point the oldest messages and tool results are dropped silently and answer quality degrades — the model is not getting worse.`}
        </span>
        {/*
          C 项：两个出口的代价不一样，分开写清楚，并给出建议。
        */}
        <span className="water-level-choice">
          {zh
            ? "「压缩」保留一份摘要 + 最近若干条，在**本对话**继续（老对话细节变成摘要）；「开启新对话（交接当前工作）」窗口干净、速度最快，但**本对话的全部上下文离开**，所以平台会把当前工作（改过哪些文件、定过什么结论、卡在哪）整理成一份交接交给新对话。"
            : `Compact keeps a summary plus recent turns in this conversation. Handing off to a new conversation gives a clean, fast window and carries the current work over as a written handover (files touched, decisions, blockers).`}
        </span>
        {note && (
          <span className={`water-level-note ${note.ok ? "is-ok" : "is-error"}`} data-testid="water-level-note">
            {note.text}
          </span>
        )}
        {/*
          ## B 项的后半：把「再这样下去会丢」改成「这一轮**已经**丢了」
          
          上面的机制说明是**将来时**。真正发生丢弃时（`buildMessages` 超预算丢最早的消息、
          剥离没有结果的 `tool_calls`），提示条给出**现在时**的事实：丢了几条、
          哪些工具的结果没了。这三个数字此前只存在于 `console.warn` 里。
        */}
        {drop && (
          <span className="water-level-drop" data-testid="water-level-drop">
            {zh
              ? `本轮已经发生：模型这一次收到的上下文里，较早的 ${drop.droppedMessages} 条消息被精简` +
                (dropToolPart ? `（${dropToolPart}）` : "") +
                (drop.strippedToolCalls > 0
                  ? `，另有 ${drop.strippedToolCalls} 个工具调用的结果没能保留（模型看不到它们，可能重复执行同样的操作）`
                  : "") +
                "。"
              : `Already happened this turn: ${drop.droppedMessages} earlier messages were trimmed from what the model received` +
                (dropToolPart ? ` (${dropToolPart})` : "") +
                (drop.strippedToolCalls > 0
                  ? `, and ${drop.strippedToolCalls} tool results were not kept (the model cannot see them and may repeat the same work)`
                  : "") +
                "."}
          </span>
        )}
      </div>
      <div className="water-level-actions">
        <button
          type="button"
          className="water-level-btn is-primary"
          onClick={handleHandoff}
          disabled={busy !== null}
          data-testid="water-level-handoff"
          title={zh ? "新建会话并把当前工作交接过去" : "Create a new conversation and hand the current work over"}
        >
          <ArrowRight className="icon-sm" />
          {busy === "handoff" ? (zh ? "交接中…" : "Handing over…") : zh ? "开启新对话（交接当前工作）" : "New conversation (hand off work)"}
        </button>
        <button
          type="button"
          className="water-level-btn"
          onClick={onOpenDetail}
          data-testid="water-level-detail"
          title={zh ? "在上下文面板里压缩" : "Compact in the context panel"}
        >
          <Layers className="icon-sm" />
          {zh ? "压缩 / 查看详情" : "Compact / details"}
        </button>
        <button
          type="button"
          className="water-level-close"
          onClick={dismiss}
          aria-label={zh ? "关闭提示（水位再涨会再次提醒）" : "Dismiss (re-alerts if it rises further)"}
          title={zh ? "关闭提示（水位再涨 5% 会再次提醒）" : "Dismiss (re-alerts after +5%)"}
          data-testid="water-level-dismiss"
        >
          <X className="icon-sm" />
        </button>
      </div>
    </div>
  );
}
