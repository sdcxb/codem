/**
 * SourceReferences — RAG 来源引用展示
 *
 * 显示知识库检索到的来源引用，支持点击查看详情
 */

import { memo } from "react";
import { useLang, S } from "../core/i18n/lang";

interface SourceReference {
  sourceId: string;
  sourceName: string;
  chunkIndex: number;
  snippet: string;
  score: number;
}

interface SourceReferencesProps {
  /** Source references from RAG */
  sources: SourceReference[];
  /** When user clicks a source */
  onSourceClick?: (sourceId: string, chunkIndex?: number) => void;
}

export const SourceReferences = memo(function SourceReferences({
  sources,
  onSourceClick,
}: SourceReferencesProps) {
  const lang = useLang();

  if (sources.length === 0) return null;

  return (
    <div className="source-references">
      <div className="source-header">{S.sources.title[lang]}</div>
      <div className="source-list">
        {sources.map((source, index) => (
          <button
            key={`${source.sourceId}-${source.chunkIndex}`}
            className="source-chip"
            onClick={() => onSourceClick?.(source.sourceId, source.chunkIndex)}
            title={source.snippet}
          >
            <span className="source-index">{index + 1}</span>
            <span className="source-name">{source.sourceName}</span>
            {source.score !== undefined && (
              <span className="source-score">{(source.score * 100).toFixed(0)}%</span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
});