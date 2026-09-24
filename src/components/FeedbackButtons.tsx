import { memo, useEffect } from "react";
import { useAppStore, type Message } from "../store";
import { useLang, S } from "../core/i18n/lang";
import { Tooltip, TooltipTrigger, TooltipContent } from "./ui/tooltip";
import type { FeedbackType } from "../core/storage/message";
import { useDomainReady } from "../hooks/use-domain-ready";

interface FeedbackButtonsProps {
  message: Message;
  /** Session ID for DB persistence */
  sessionId?: string;
  /** Inline mode: render as flat toolbar buttons instead of separate block */
  inline?: boolean;
}

/**
 * Like / Dislike buttons shown under assistant messages.
 * Feedback state is persisted to SQLite via the message_feedback table.
 */
export const FeedbackButtons = memo(function FeedbackButtons({ message, sessionId, inline }: FeedbackButtonsProps) {
  const lang = useLang();
  const feedback = useAppStore((s) => s.feedback[message.id]);
  const setFeedback = useAppStore((s) => s.setFeedback);
  const loadFeedback = useAppStore((s) => s.loadFeedback);

  // Load persisted feedback on mount
  useEffect(() => {
    if (message.id && !feedback) {
      loadFeedback(message.id);
    }
  }, [message.id]); // eslint-disable-line react-hooks/exhaustive-deps

  /*
   * 第 72 轮审计：`loadFeedback` 是**同步**接口、读的是 `message_feedback` 的域镜像，
   * 而上面那次读**每条消息只会发生一次**（依赖只有 message.id）—— 镜像晚就绪时，
   * 你给历史消息点过的赞/踩会显示成"未评价"，而且**没有人会再读一次**。
   * （那一轮的另一半修法是把这张表加进首屏预取清单；这里补读侧的"就绪后重读"，两道都要有。）
   */
  useDomainReady("message_feedback", () => {
    if (message.id) loadFeedback(message.id);
  });

  const handleFeedback = (type: FeedbackType) => {
    // Toggle: if same feedback already set, remove it
    const newFeedback = feedback === type ? null : type;
    setFeedback(message.id, newFeedback, sessionId);
  };

  return (
    <div className={inline ? "feedback-inline" : "feedback-buttons"}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            className={inline ? "toolbar-btn" : `feedback-btn like ${feedback === "like" ? "active" : ""}`}
            onClick={() => handleFeedback("like")}
            aria-label={S.bubble.like[lang]}
            style={inline && feedback === "like" ? { color: "var(--accent)" } : {}}
          >
            👍
          </button>
        </TooltipTrigger>
        <TooltipContent>{S.bubble.like[lang]}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            className={inline ? "toolbar-btn" : `feedback-btn dislike ${feedback === "dislike" ? "active" : ""}`}
            onClick={() => handleFeedback("dislike")}
            aria-label={S.bubble.dislike[lang]}
            style={inline && feedback === "dislike" ? { color: "var(--accent)" } : {}}
          >
            👎
          </button>
        </TooltipTrigger>
        <TooltipContent>{S.bubble.dislike[lang]}</TooltipContent>
      </Tooltip>
    </div>
  );
});
