/**
 * SourceViewer — 来源原文查看器
 *
 * 对标 NotebookLM 的引用精确定位 + 跳转原文功能
 * 自研实现: 弹窗展示来源原文, 高亮引用的具体段落
 *
 * 功能:
 * 1. 显示来源的完整文本内容
 * 2. 高亮被引用的具体段落 (chunk)
 * 3. 支持滚动浏览
 * 4. 皮肤系统兼容 (CSS 变量)
 */

import { useState, useEffect, useMemo } from 'react';
import { FileText, Search, FileWarning } from 'lucide-react';
import { ActionIcons } from '../core/icons/icon-map';
import { getSource, getChunks } from '../core/knowledge';
import type { NotebookSource, NotebookChunk } from '../core/knowledge';
import { PdfViewer } from './PdfViewer';
import { DocxViewer } from './DocxViewer';
import { ExcelViewer } from './ExcelViewer';
import { AudioPlayer } from './AudioPlayer';

interface SourceViewerProps {
  sourceId: string;
  notebookId: string;
  highlightChunkIndex?: number;
  highlightText?: string;
  onClose: () => void;
}

export function SourceViewer({
  sourceId,
  notebookId,
  highlightChunkIndex,
  highlightText,
  onClose,
}: SourceViewerProps) {
  const CloseIcon = ActionIcons.close;
  const [source, setSource] = useState<NotebookSource | null>(null);
  const [chunks, setChunks] = useState<NotebookChunk[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [viewMode, setViewMode] = useState<'text' | 'pdf' | 'docx' | 'excel' | 'audio'>('text');

  useEffect(() => {
    const src = getSource(sourceId);
    if (src) setSource(src);

    const allChunks = getChunks(notebookId).filter(c => c.sourceId === sourceId);
    setChunks(allChunks);

    // 不再强制 text 模式 — 让 PDF/DOCX 用各自的渲染模式，高亮由组件内部处理
    if (src?.type === 'file' && src.filePath?.toLowerCase().endsWith('.pdf')) {
      setViewMode('pdf');
    } else if (src?.type === 'file' && src.filePath?.toLowerCase().endsWith('.docx')) {
      setViewMode('docx');
    }
  }, [sourceId, notebookId]);

  // Filter chunks by search query
  const filteredChunks = useMemo(() => {
    if (!searchQuery.trim()) return chunks;
    const lower = searchQuery.toLowerCase();
    return chunks.filter(c => c.content.toLowerCase().includes(lower));
  }, [chunks, searchQuery]);

  // Full text content (from source.content or concatenated chunks)
  const fullText = useMemo(() => {
    if (source?.content) return source.content;
    return chunks.map(c => c.content).join('\n\n');
  }, [source, chunks]);

  // Highlighted text rendering — 在文本中高亮所有匹配项
  const renderContent = (text: string, isHighlighted: boolean, highlightSnippet?: string) => {
    if (!highlightSnippet) return text;

    // 大小写不敏感匹配，高亮所有出现的位置
    const lowerText = text.toLowerCase();
    const lowerSnippet = highlightSnippet.toLowerCase();
    const parts: React.ReactNode[] = [];
    let lastIndex = 0;
    let idx = lowerText.indexOf(lowerSnippet, lastIndex);
    
    if (idx === -1) return text;
    
    while (idx !== -1) {
      if (idx > lastIndex) {
        parts.push(text.substring(lastIndex, idx));
      }
      parts.push(
        <span key={idx} className="nb-source-highlight">
          {text.substring(idx, idx + highlightSnippet.length)}
        </span>
      );
      lastIndex = idx + highlightSnippet.length;
      idx = lowerText.indexOf(lowerSnippet, lastIndex);
    }
    if (lastIndex < text.length) {
      parts.push(text.substring(lastIndex));
    }
    return <>{parts}</>;
  };

  return (
    <div className="nb-source-viewer-overlay" onClick={onClose}>
      <div className="nb-source-viewer" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="nb-source-viewer-header">
          <div className="nb-source-viewer-title">
            <FileText size={16} style={{ color: 'var(--accent)' }} />
            <span>{source?.name || 'Loading...'}</span>
            {source?.type && (
              <span className="nb-source-type-tag" style={{ marginLeft: '8px' }}>
                {source.type}
              </span>
            )}
            {/* A1: PDF/text view toggle */}
            {source?.type === 'file' && source.filePath?.toLowerCase().endsWith('.pdf') && (
              <div style={{ display: 'flex', gap: '2px', marginLeft: '8px' }}>
                <button
                  onClick={() => setViewMode('text')}
                  style={{
                    padding: '2px 8px', fontSize: 'var(--fs-xs)', borderRadius: '3px', cursor: 'pointer',
                    background: viewMode === 'text' ? 'var(--accent)' : 'transparent',
                    color: viewMode === 'text' ? 'var(--text-on-accent)' : 'var(--text-muted)',
                    border: '1px solid var(--border-primary)',
                  }}
                >
                  Text
                </button>
                <button
                  onClick={() => setViewMode('pdf')}
                  style={{
                    padding: '2px 8px', fontSize: 'var(--fs-xs)', borderRadius: '3px', cursor: 'pointer',
                    background: viewMode === 'pdf' ? 'var(--accent)' : 'transparent',
                    color: viewMode === 'pdf' ? 'var(--text-on-accent)' : 'var(--text-muted)',
                    border: '1px solid var(--border-primary)',
                  }}
                >
                  PDF
                </button>
              </div>
            )}
            {/* A16: DOCX view toggle */}
            {source?.type === 'file' && source.filePath?.toLowerCase().endsWith('.docx') && (
              <div style={{ display: 'flex', gap: '2px', marginLeft: '8px' }}>
                <button
                  onClick={() => setViewMode('text')}
                  style={{
                    padding: '2px 8px', fontSize: 'var(--fs-xs)', borderRadius: '3px', cursor: 'pointer',
                    background: viewMode === 'text' ? 'var(--accent)' : 'transparent',
                    color: viewMode === 'text' ? 'var(--text-on-accent)' : 'var(--text-muted)',
                    border: '1px solid var(--border-primary)',
                  }}
                >
                  Text
                </button>
                <button
                  onClick={() => setViewMode('docx')}
                  style={{
                    padding: '2px 8px', fontSize: 'var(--fs-xs)', borderRadius: '3px', cursor: 'pointer',
                    background: viewMode === 'docx' ? 'var(--accent)' : 'transparent',
                    color: viewMode === 'docx' ? 'var(--text-on-accent)' : 'var(--text-muted)',
                    border: '1px solid var(--border-primary)',
                  }}
                >
                  Word
                </button>
              </div>
            )}
          </div>
          <button className="nb-dialog-close" onClick={onClose}>
            <CloseIcon size={16} />
          </button>
        </div>

        {/* Search bar */}
        <div style={{
          padding: '8px 16px',
          borderBottom: '1px solid var(--border-primary)',
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
        }}>
          <Search size={14} style={{ opacity: 0.5 }} />
          <input
            type="text"
            placeholder="搜索来源内容..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            style={{
              flex: 1,
              background: 'var(--bg-primary)',
              border: '1px solid var(--border-primary)',
              borderRadius: '4px',
              padding: '4px 8px',
              color: 'var(--text-primary)',
              fontSize: 'var(--fs-sm)',
              outline: 'none',
            }}
          />
          <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted, #555)' }}>
            {filteredChunks.length} / {chunks.length} 段
          </span>
        </div>

        {/* Body */}
        {viewMode === 'pdf' && source?.filePath ? (
          <div className="nb-source-viewer-body">
            <PdfViewer
              filePath={source.filePath}
              highlightText={highlightText || searchQuery}
              onClose={onClose}
            />
          </div>
        ) : viewMode === 'docx' && source?.filePath ? (
          <div className="nb-source-viewer-body">
            <DocxViewer
              filePath={source.filePath}
              highlightText={highlightText || searchQuery}
              onClose={onClose}
            />
          </div>
        ) : viewMode === 'excel' && source?.filePath ? (
          <div className="nb-source-viewer-body">
            <ExcelViewer filePath={source.filePath} onClose={onClose} />
          </div>
        ) : viewMode === 'audio' && source?.filePath ? (
          <div className="nb-source-viewer-body">
            <AudioPlayer filePath={source.filePath} fileName={source.name} onClose={onClose} />
          </div>
        ) : (
        <div className="nb-source-viewer-body">
          {chunks.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {filteredChunks.map((chunk, idx) => {
    const isHighlighted = highlightChunkIndex !== undefined
      ? chunk.chunkIndex === highlightChunkIndex
      : Boolean(highlightText && chunk.content.toLowerCase().includes(highlightText.toLowerCase()));

                return (
                  <div
                    key={chunk.id}
                    style={{
                      padding: '12px 16px',
                      background: isHighlighted
                        ? 'rgba(255, 235, 59, 0.06)'
                        : 'var(--bg-tertiary)',
                      border: isHighlighted
                        ? '1px solid rgba(255, 235, 59, 0.3)'
                        : '1px solid var(--border-primary)',
                      borderRadius: '8px',
                    }}
                  >
                    <div style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      marginBottom: '6px',
                    }}>
                      <span style={{
                        fontSize: 'var(--fs-xs)',
                        fontWeight: 600,
                        color: 'var(--text-muted)',
                        textTransform: 'uppercase',
                      }}>
                      ¶ {chunk.chunkIndex + 1}
                    </span>
                    {isHighlighted && (
                      <span style={{
                        fontSize: 'var(--fs-xs)',
                        color: 'rgba(255, 235, 59, 0.8)',
                        fontWeight: 500,
                      }}>
                        ⚡ 引用段落
                      </span>
                    )}
                    </div>
                    <div
                      className="nb-source-viewer-content"
                      style={isHighlighted ? { color: 'var(--text-primary, #e0e0e4)' } : undefined}
                    >
                      {renderContent(chunk.content, isHighlighted, highlightText)}
                    </div>
                  </div>
                );
              })}
            </div>
) : (
            <div className="nb-source-viewer-content">
              {highlightText ? renderContent(fullText, true, highlightText) : (fullText || '(无内容)')}
            </div>
          )}
        </div>
        )}
      </div>
    </div>
  );
}
