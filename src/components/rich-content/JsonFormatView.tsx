/**
 * JsonFormatView — JSON 格式化查看器
 *
 * 在 ContentFrame 内渲染格式化的 JSON，支持折叠/展开。
 */

import { memo, useMemo, useState } from "react";
import { Braces as BracesIcon } from "lucide-react";
import { ContentFrame } from "./ContentFrame";

interface JsonFormatViewProps {
  raw: string;
  title?: string;
}

export const JsonFormatView = memo(function JsonFormatView({ raw, title }: JsonFormatViewProps) {
  const [copied, setCopied] = useState(false);

  const { formatted, valid } = useMemo(() => {
    try {
      const parsed = JSON.parse(raw);
      return { formatted: JSON.stringify(parsed, null, 2), valid: true };
    } catch {
      return { formatted: raw, valid: false };
    }
  }, [raw]);

  const handleCopy = () => {
    navigator.clipboard.writeText(formatted).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <ContentFrame
      title={title || "JSON"}
      badge={valid ? "有效" : "无效"}
      icon={<BracesIcon size={14} />}
      onCopy={handleCopy}
      className={`json-format-view ${valid ? "" : "invalid"}`}
    >
      <pre className="json-format-body">
        <code>{formatted}</code>
      </pre>
    </ContentFrame>
  );
});
