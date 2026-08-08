/**
 * MathFormulaView — 数学公式视图
 *
 * 在 ContentFrame 内渲染 KaTeX 数学公式。
 * 复用项目已有的 katex 依赖。
 */

import { memo, useEffect, useRef } from "react";
import { Sigma as SigmaIcon } from "lucide-react";
import { ContentFrame } from "./ContentFrame";

interface MathFormulaViewProps {
  formula: string;
  displayMode?: boolean;
}

export const MathFormulaView = memo(function MathFormulaView({
  formula,
  displayMode = true,
}: MathFormulaViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    let cancelled = false;
    (async () => {
      try {
        const katex = (await import("katex")).default;
        if (cancelled || !containerRef.current) return;
        katex.render(formula, containerRef.current, {
          displayMode,
          throwOnError: false,
          errorColor: "#f85149",
          strict: false,
          trust: true,
        });
      } catch {
        if (!cancelled && containerRef.current) {
          containerRef.current.textContent = formula;
        }
      }
    })();
    return () => { cancelled = true; };
  }, [formula, displayMode]);

  return (
    <ContentFrame
      title="数学公式"
      icon={<SigmaIcon size={14} />}
      className="math-formula-view"
    >
      <div ref={containerRef} className="math-formula-body" />
    </ContentFrame>
  );
});
