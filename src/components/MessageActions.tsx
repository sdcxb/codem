/**
 * MessageActions — 消息操作栏
 *
 * 在消息悬停时显示操作按钮：复制、反馈（赞/踩）、分支对话、编辑。
 *
 * @unwired 未接线（第 2 步定性）：0 个生产调用方 —— 第 2 步之前 `MessageBubble`
 * 只 import、从未渲染；气泡工具栏现在由共享 `packages/ui/src/message-bubble.tsx`
 * 唯一实现（复制/编辑/精选/朗读/折叠/反馈都在那里）。
 * 两条路：① 如果还需要"独立操作栏"形态，接到新的宿主上并删掉本条登记；
 * ② 否则连同 `tools/audit/reachability-allowlist.json` 的条目一起删掉。
 * 判据工具：`src/test/reachability-gate.test.ts`（REACH-2/4/5）。
 */

import { useState, useCallback, memo } from "react";
import { Copy, Check, ThumbsUp, ThumbsDown, GitBranch, Pencil } from "lucide-react";

export interface MessageActionsProps {
  messageId: string;
  content: string;
  onCopy?: (content: string) => void;
  onFeedback?: (messageId: string, feedback: "up" | "down") => void;
  onBranch?: (messageId: string) => void;
  onEdit?: (messageId: string) => void;
  /** 当前反馈状态 */
  feedback?: "up" | "down" | null;
}

export const MessageActions = memo(function MessageActions({
  messageId,
  content,
  onCopy,
  onFeedback,
  onBranch,
  onEdit,
  feedback,
}: MessageActionsProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(content).catch(() => {});
    onCopy?.(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [content, onCopy]);

  const handleFeedback = useCallback((type: "up" | "down") => {
    onFeedback?.(messageId, type);
  }, [messageId, onFeedback]);

  return (
    <div className="message-actions-bar">
      <button
        className="message-action-btn"
        onClick={handleCopy}
        aria-label="复制"
        title="复制"
      >
        {copied ? <Check size={14} /> : <Copy size={14} />}
      </button>
      {onFeedback && (
        <>
          <button
            className={`message-action-btn ${feedback === "up" ? "active" : ""}`}
            onClick={() => handleFeedback("up")}
            aria-label="赞"
            title="赞"
          >
            <ThumbsUp size={14} />
          </button>
          <button
            className={`message-action-btn ${feedback === "down" ? "active" : ""}`}
            onClick={() => handleFeedback("down")}
            aria-label="踩"
            title="踩"
          >
            <ThumbsDown size={14} />
          </button>
        </>
      )}
      {onBranch && (
        <button
          className="message-action-btn"
          onClick={() => onBranch(messageId)}
          aria-label="分支对话"
          title="分支对话"
        >
          <GitBranch size={14} />
        </button>
      )}
      {onEdit && (
        <button
          className="message-action-btn"
          onClick={() => onEdit(messageId)}
          aria-label="编辑"
          title="编辑"
        >
          <Pencil size={14} />
        </button>
      )}
    </div>
  );
});
