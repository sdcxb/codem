/**
 * MermaidCanvasView — Mermaid 图表视图
 *
 * 在 ContentFrame 内渲染 Mermaid 图表，支持全屏查看。
 * 复用项目已有的 mermaid 依赖。
 */

import { memo, useEffect, useRef, useState } from "react";
import { Network as NetworkIcon } from "lucide-react";
import { ContentFrame } from "./ContentFrame";

interface MermaidCanvasViewProps {
  chart: string;
  id?: string;
}

export const MermaidCanvasView = memo(function MermaidCanvasView({ chart, id }: MermaidCanvasViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [svg, setSvg] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const mermaid = (await import("mermaid")).default;
        mermaid.initialize({
          startOnLoad: false,
          theme: "dark",
          securityLevel: "loose",
          fontFamily: "inherit",
        });
        const renderId = `mermaid-${id || Date.now()}-${Math.random().toString(36).substring(7)}`;
        const { svg: rendered } = await mermaid.render(renderId, chart);
        if (!cancelled) {
          setSvg(rendered);
          setError("");
          setLoading(false);
        }
      } catch (err: any) {
        if (!cancelled) {
          setError(err.message || String(err));
          setLoading(false);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [chart, id]);

  const content = loading ? (
    <div className="mermaid-canvas-loading">渲染图表中...</div>
  ) : error ? (
    <div className="mermaid-canvas-error">
      <pre>{error}</pre>
    </div>
  ) : (
    <div
      ref={containerRef}
      className="mermaid-canvas-body"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );

  if (fullscreen) {
    return (
      <div className="content-fullscreen-backdrop" onClick={() => setFullscreen(false)}>
        <div className="content-fullscreen mermaid-fullscreen" onClick={(e) => e.stopPropagation()}>
          <div className="content-fullscreen-header">
            <span className="content-fullscreen-title">Mermaid 图表</span>
            <button className="content-fullscreen-close" onClick={() => setFullscreen(false)}>✕</button>
          </div>
          <div className="content-fullscreen-body mermaid-fullscreen-body">
            {content}
          </div>
        </div>
      </div>
    );
  }

  return (
    <ContentFrame
      title="Mermaid"
      icon={<NetworkIcon size={14} />}
      fullscreenable
      onFullscreen={() => setFullscreen(true)}
      className="mermaid-canvas-view"
    >
      {content}
    </ContentFrame>
  );
});
