/**
 * ErrorCard — 错误消息卡片
 *
 * 在消息流中展示错误信息，替代普通文本气泡。
 * 支持重试按钮、错误详情展开。
 */

import { useState, memo } from "react";
import { AlertTriangle, ChevronDown, ChevronRight, RotateCcw, Copy } from "lucide-react";

interface ErrorCardProps {
  /** 错误标题 */
  title?: string;
  /** 错误消息 */
  message: string;
  /** 错误详情（堆栈等） */
  details?: string;
  /** 错误代码 */
  code?: string;
  /** 是否可重试 */
  retryable?: boolean;
  /** 重试回调 */
  onRetry?: () => void;
}

export const ErrorCard = memo(function ErrorCard({
  title = "Error",
  message,
  details,
  code,
  retryable = false,
  onRetry,
}: ErrorCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(`${title}: ${message}\n${details || ""}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="error-card">
      <div className="error-card-header">
        <AlertTriangle size={16} className="error-card-icon" />
        <span className="error-card-title">{title}</span>
        {code && <span className="error-card-code">{code}</span>}
        <div className="error-card-actions">
          <button className="error-card-action-btn" onClick={handleCopy} title="Copy">
            <Copy size={12} />
          </button>
          {retryable && onRetry && (
            <button className="error-card-action-btn retry" onClick={onRetry} title="Retry">
              <RotateCcw size={12} />
            </button>
          )}
          {details && (
            <button
              className="error-card-action-btn"
              onClick={() => setExpanded(!expanded)}
              title="Details"
            >
              {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            </button>
          )}
        </div>
      </div>
      <div className="error-card-message">{message}</div>
      {expanded && details && (
        <pre className="error-card-details">{details}</pre>
      )}
      {copied && <div className="error-card-copied">Copied!</div>}
    </div>
  );
});
