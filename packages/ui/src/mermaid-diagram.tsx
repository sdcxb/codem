/**
 * 共享 Mermaid 图表渲染（从桌面 `MessageBubble` 抽出的纯展示组件）。
 *
 * 依赖全部在浏览器侧：mermaid 走动态 import，未出现图表时不会把它的体积带进首屏。
 * 组件本身不读桌面 store / 设置 / Tauri，桌面与手机可以注入同一个渲染器。
 */
import { memo, useEffect, useRef, useState } from "react";

// B6: Mermaid diagram renderer component
export const MermaidDiagram = memo(function MermaidDiagram({ chart }: { chart: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [svg, setSvg] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const mermaid = (await import("mermaid")).default;
        mermaid.initialize({
          startOnLoad: false,
          theme: "dark",
          securityLevel: "strict",
          fontFamily: "inherit",
        });
        const id = `mermaid-${Date.now()}-${Math.random().toString(36).substring(7)}`;
        const { svg: renderedSvg } = await mermaid.render(id, chart);
        if (!cancelled) {
          setSvg(renderedSvg);
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
  }, [chart]);

  if (loading) {
    return <div className="mermaid-loading">Rendering diagram...</div>;
  }
  if (error) {
    return (
      <div className="mermaid-error">
        <div className="mermaid-error-title">Diagram render error:</div>
        <pre className="mermaid-error-detail">{error}</pre>
        <details>
          <summary>Source code</summary>
          <pre className="mermaid-source">{chart}</pre>
        </details>
      </div>
    );
  }
  return (
    <div
      ref={containerRef}
      className="mermaid-container"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
});
