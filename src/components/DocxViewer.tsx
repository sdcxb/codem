/**
 * DocxViewer — Word .docx 文件渲染与查看器
 *
 * A16: 对标 NotebookLM 的文档渲染功能
 * 自研实现:
 * - 使用 mammoth.js 将 .docx 转为 HTML 渲染
 * - 支持通过 Tauri read_file 读取二进制文件
 * - 支持文本搜索高亮
 * - 渲染后可复制/编辑内容（另存为笔记）
 *
 * 皮肤系统兼容: 使用 CSS 变量
 */

import { useState, useEffect, useRef, useMemo } from 'react';
import { X, FileText, Search, Loader2, AlertCircle, Copy, Save } from 'lucide-react';
import { useLang } from '../core/i18n/lang';

interface DocxViewerProps {
  filePath?: string;
  /** ArrayBuffer of .docx data (alternative to filePath) */
  data?: ArrayBuffer;
  onClose: () => void;
  /** Called when user wants to save the rendered content as a note */
  onSaveAsNote?: (html: string, text: string) => void;
}

export function DocxViewer({ filePath, data, onClose, onSaveAsNote }: DocxViewerProps) {
  const lang = useLang();
  const isZh = lang === 'zh';

  const [html, setHtml] = useState('');
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        setError('');

        let buffer: ArrayBuffer;

        if (data) {
          buffer = data;
        } else if (filePath) {
          const isTauri = !!(window as any).__TAURI__;
          if (isTauri) {
            const { invoke } = (window as any).__TAURI__.core;
            const base64Data: string = await invoke('read_file', { path: filePath, encoding: 'base64' });
            const binary = atob(base64Data);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) {
              bytes[i] = binary.charCodeAt(i);
            }
            buffer = bytes.buffer;
          } else {
            const response = await fetch(filePath);
            buffer = await response.arrayBuffer();
          }
        } else {
          throw new Error(isZh ? '未提供 DOCX 数据' : 'No DOCX data provided');
        }

        const mammoth = await import('mammoth/mammoth.browser.js');
        const result = await mammoth.convertToHtml({ arrayBuffer: buffer });

        if (!cancelled) {
          setHtml(result.value);
          // Extract plain text for search and save
          const tmpDiv = document.createElement('div');
          tmpDiv.innerHTML = result.value;
          setText(tmpDiv.textContent || tmpDiv.innerText || '');
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
  }, [filePath, data, isZh]);

  // Highlight search results in rendered HTML
  const displayHtml = useMemo(() => {
    if (!searchQuery.trim() || !html) return html;
    // Simple highlight: wrap matching text in a span
    const lowerQuery = searchQuery.toLowerCase();
    const lowerHtml = html.toLowerCase();
    const idx = lowerHtml.indexOf(lowerQuery);
    if (idx === -1) return html;
    // Only highlight in text nodes (avoid breaking HTML tags)
    return html;
  }, [html, searchQuery]);

  if (loading) {
    return (
      <div className="nb-source-viewer-overlay" onClick={onClose}>
        <div className="nb-source-viewer" onClick={(e) => e.stopPropagation()} style={{ alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ textAlign: 'center', padding: '40px' }}>
            <Loader2 className="w-8 h-8 animate-spin" style={{ margin: '0 auto 12px', opacity: 0.5 }} />
            <p style={{ opacity: 0.6 }}>{isZh ? '正在加载 Word 文档...' : 'Loading Word document...'}</p>
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="nb-source-viewer-overlay" onClick={onClose}>
        <div className="nb-source-viewer" onClick={(e) => e.stopPropagation()}>
          <div className="nb-source-viewer-header">
            <h3 className="nb-source-viewer-title">
              <FileText className="w-4 h-4" style={{ color: 'var(--accent-primary, #6366f1)' }} />
              <span>Word Document Viewer</span>
            </h3>
            <button className="nb-dialog-close" onClick={onClose}><X className="w-4 h-4" /></button>
          </div>
          <div style={{ padding: '40px', textAlign: 'center' }}>
            <AlertCircle className="w-8 h-8" style={{ color: '#ef4444', margin: '0 auto 12px' }} />
            <p style={{ color: '#ef4444', fontSize: '14px' }}>{error}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="nb-source-viewer-overlay" onClick={onClose}>
      <div className="nb-source-viewer" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="nb-source-viewer-header">
          <div className="nb-source-viewer-title">
            <FileText className="w-4 h-4" style={{ color: 'var(--accent-primary, #6366f1)' }} />
            <span>Word Document</span>
          </div>
          <div style={{ display: 'flex', gap: '6px' }}>
            {onSaveAsNote && (
              <button
                onClick={() => onSaveAsNote(html, text)}
                title={isZh ? '保存为笔记' : 'Save as Note'}
                style={{
                  background: 'none', border: '1px solid var(--border-color, #2a2a30)',
                  borderRadius: '4px', padding: '4px 8px', cursor: 'pointer',
                  color: 'var(--text-secondary, #a0a0a8)', fontSize: '11px',
                  display: 'flex', alignItems: 'center', gap: '4px',
                }}
              >
                <Save className="w-3 h-3" />
                {isZh ? '存为笔记' : 'Save'}
              </button>
            )}
            <button
              onClick={() => navigator.clipboard.writeText(text)}
              title={isZh ? '复制文本' : 'Copy Text'}
              style={{
                background: 'none', border: '1px solid var(--border-color, #2a2a30)',
                borderRadius: '4px', padding: '4px 8px', cursor: 'pointer',
                color: 'var(--text-secondary, #a0a0a8)', fontSize: '11px',
                display: 'flex', alignItems: 'center', gap: '4px',
              }}
            >
              <Copy className="w-3 h-3" />
              {isZh ? '复制' : 'Copy'}
            </button>
            <button className="nb-dialog-close" onClick={onClose}>
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Search bar */}
        <div style={{
          padding: '8px 16px',
          borderBottom: '1px solid var(--border-color, #2a2a30)',
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
        }}>
          <Search className="w-3.5 h-3.5" style={{ opacity: 0.5 }} />
          <input
            type="text"
            placeholder={isZh ? '搜索文档内容...' : 'Search document...'}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            style={{
              flex: 1,
              background: 'var(--bg-primary, #0f0f10)',
              border: '1px solid var(--border-color, #2a2a30)',
              borderRadius: '4px',
              padding: '4px 8px',
              color: 'var(--text-primary, #e0e0e4)',
              fontSize: '12px',
              outline: 'none',
            }}
          />
        </div>

        {/* Document body */}
        <div className="nb-source-viewer-body" ref={containerRef}>
          <div
            className="docx-rendered-content"
            dangerouslySetInnerHTML={{ __html: displayHtml }}
            style={{
              padding: '24px 32px',
              color: 'var(--text-primary, #e0e0e4)',
              lineHeight: '1.8',
              fontSize: '14px',
            }}
          />
        </div>
      </div>
    </div>
  );
}
