/**
 * HtmlPreviewView — HTML 沙箱预览
 *
 * 在 ContentFrame 内通过 iframe 沙箱渲染 HTML 片段。
 */

import { memo, useMemo } from "react";
import { Globe as GlobeIcon } from "lucide-react";
import { ContentFrame } from "./ContentFrame";

interface HtmlPreviewViewProps {
  html: string;
  title?: string;
}

export const HtmlPreviewView = memo(function HtmlPreviewView({ html, title }: HtmlPreviewViewProps) {
  const srcDoc = useMemo(() => {
    // 确保有基本样式
    if (html.trim().startsWith("<!DOCTYPE") || html.trim().startsWith("<html")) {
      return html;
    }
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{font-family:system-ui,sans-serif;padding:12px;margin:0;color:inherit;background:transparent;}</style></head><body>${html}</body></html>`;
  }, [html]);

  return (
    <ContentFrame
      title={title || "HTML 预览"}
      icon={<GlobeIcon size={14} />}
      className="html-preview-view"
    >
      <iframe
        className="html-preview-iframe"
        srcDoc={srcDoc}
        sandbox="allow-same-origin"
        title={title || "HTML 预览"}
      />
    </ContentFrame>
  );
});
