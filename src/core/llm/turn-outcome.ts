/**
 * 一轮（turn）结束后的**呈现决策** —— 从 `App.tsx` 的 `case "end"` 里抽出来的纯函数。
 *
 * ## 修的是什么（渲染层三处同源缺陷）
 *
 * 原判据是 `result.type === "stop" && (reason === "error" || reason === "too_many_errors")`：
 *
 * 1. **`{ type: "stop"; reason: "error" }` 从来没有被任何代码构造过** —— 死判据；
 * 2. 循环真正会返回的 `{ type: "error"; error }`（LLM 调用最终失败）与
 *    `{ type: "aborted" }`（用户中途停止）**一个都没处理**，
 *    于是一个失败的回合会掉进"任务完成"那条路（用户看到成功，实际这一轮挂了）；
 * 3. 整段 stop 处理还被嵌在 `type === "overflow"` 分支**里面** ——
 *    连 `reason: "completed"` 的正常完成都到不了，"任务完成"卡从来没显示过。
 *
 * 判据因此改成**结果对象的实际形状**（`type`），不再猜 `reason` 字符串。
 * 抽成纯函数是为了能用行为断言钉住：渲染层没有便宜的整机夹具，
 * 而源码文本断言会在这种"判据恒假"的缺陷上假绿（本仓库的既有教训）。
 */

/** 呈现类别。`none` = 形状不认识/没有结果，保持现状不额外表态。 */
export type TurnOutcomeKind = "none" | "completed" | "overflow" | "error" | "aborted" | "stopped";

export interface TurnOutcome {
  kind: TurnOutcomeKind;
  /** 需要落一条 system 消息给用户看时的正文（含前缀符号）；不需要时为 undefined */
  notice?: string;
  /** 大肥鱼状态卡的 phase（按语言本地化）；不需要动卡时 undefined */
  petPhase?: string;
  /** 状态卡上的说明 */
  petMessage?: string;
  /** 是否显示"任务完成"卡（并在约 2.5s 后归位） */
  completionCard: boolean;
  /** 是否抑制"任务完成！修改了 N 个文件"这类报喜气泡（失败/中断时绝不许报喜） */
  suppressTaskBubble: boolean;
  /** 写进助手消息 `metadata.turnStatus` 的 turn 级状态（供 `TurnStatus` 组件消费） */
  turnStatus?: { kind: "error" | "max-tokens"; message?: string; code?: string };
  /** 助手消息定稿时的 status */
  messageStatus: "done" | "error";
}

const zhOr = (zh: boolean, zhText: string, enText: string) => (zh ? zhText : enText);

export function describeTurnOutcome(
  result: unknown,
  opts: { lang?: string } = {},
): TurnOutcome {
  const zh = (opts.lang ?? "zh") === "zh";
  const errorPhase = zhOr(zh, "遇到问题", "error");
  const donePhase = zhOr(zh, "任务完成", "done");
  const stoppedPhase = zhOr(zh, "已停止", "stopped");

  const none: TurnOutcome = {
    kind: "none",
    completionCard: false,
    suppressTaskBubble: false,
    messageStatus: "done",
  };
  if (!result || typeof result !== "object") return none;

  const r = result as Record<string, unknown>;

  switch (r.type) {
    /**
     * 上下文彻底用尽（压缩也放不下）。既不是完成、也不该只说"上下文满了"就完事 ——
     * 给用户一句明确的下一步，并把 turn 标成 max-tokens（`TurnStatus` 的既有形状）。
     */
    case "overflow": {
      const msg =
        (typeof r.message === "string" && r.message) ||
        zhOr(zh, "上下文窗口已满，请开启新对话。", "The context window is full. Start a new conversation.");
      return {
        kind: "overflow",
        notice: `⚠️ ${msg}`,
        petPhase: errorPhase,
        petMessage: msg,
        completionCard: false,
        suppressTaskBubble: true,
        turnStatus: { kind: "max-tokens" },
        messageStatus: "error",
      };
    }

    /**
     * `{ type: "error"; error }` —— LLM 调用最终失败（重试耗尽 / 不可重试的 4xx）。
     * **必须**按失败呈现：错误正文要透出去，绝不能出现成功卡。
     */
    case "error": {
      const detail = typeof r.error === "string" ? r.error.trim() : "";
      const msg = detail
        ? zhOr(zh, `任务执行出错，已停止：${detail}`, `The turn failed: ${detail}`)
        : zhOr(
            zh,
            "任务执行出错，已停止。请检查控制台日志或重试。",
            "The turn failed. Check the logs or retry.",
          );
      return {
        kind: "error",
        notice: `⚠️ ${msg}`,
        petPhase: errorPhase,
        petMessage: msg,
        completionCard: false,
        suppressTaskBubble: true,
        turnStatus: { kind: "error", message: detail || "LLM call failed", code: "llm_call_failed" },
        messageStatus: "error",
      };
    }

    /**
     * `{ type: "aborted" }` —— 用户点了停止（或指引插入故意打断）。
     * 这是**用户主动**的中断，不是失败：不许报"任务完成"，但也不该标成 error。
     */
    case "aborted": {
      const msg = zhOr(zh, "已停止（本轮被中断）", "Stopped (the turn was interrupted)");
      return {
        kind: "aborted",
        notice: `⏹ ${msg}`,
        petPhase: stoppedPhase,
        petMessage: msg,
        completionCard: false,
        suppressTaskBubble: true,
        messageStatus: "done",
      };
    }

    case "stop": {
      const reason = typeof r.reason === "string" ? r.reason : "";

      // 唯一的"真完成"：显示完成卡、照旧报喜气泡。
      if (reason === "completed") {
        return {
          kind: "completed",
          petPhase: donePhase,
          completionCard: true,
          suppressTaskBubble: false,
          messageStatus: "done",
        };
      }

      // 连续错误到上限：与循环里那条可见文案同义（这一条原来被死判据挡着，从未显示过）。
      if (reason === "too_many_errors") {
        const msg = zhOr(
          zh,
          "LLM 调用连续失败多次，任务已停止。可能是 LLM 服务端无响应或上下文过长。请检查服务状态后重试。",
          "The LLM call failed repeatedly — the turn stopped. Check the service or retry.",
        );
        return {
          kind: "stopped",
          notice: `⚠️ ${msg}`,
          petPhase: errorPhase,
          petMessage: msg,
          completionCard: false,
          suppressTaskBubble: true,
          turnStatus: { kind: "error", message: "Consecutive errors exceeded limit", code: reason },
          messageStatus: "error",
        };
      }

      // 迭代上限 / 停滞：循环自己已经吐了可见文本，这里只补 turn 级状态 + 不报完成。
      if (reason === "max_iterations" || reason === "no_progress") {
        return {
          kind: "stopped",
          petPhase: errorPhase,
          completionCard: false,
          suppressTaskBubble: true,
          turnStatus: {
            kind: "error",
            message:
              reason === "max_iterations"
                ? "Iteration limit reached"
                : "No progress detected — loop stopped",
            code: reason,
          },
          messageStatus: "error",
        };
      }

      /**
       * 其它非正常停止：`output_truncated` / `context_overflow` / `safety_valve` /
       * `plan_stale` / `repeat_guard` / `write_rejected_by_user` /
       * `critical_service_unavailable` / 成本上限（reason 是一整句）…
       * 这些原因循环**自己**已经吐了可见文本说明，这里只守住一条：
       * **绝不显示"任务完成"**。
       */
      return {
        kind: "stopped",
        completionCard: false,
        suppressTaskBubble: true,
        messageStatus: "done",
      };
    }

    default:
      return none;
  }
}
