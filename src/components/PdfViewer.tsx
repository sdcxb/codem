/**
 * PdfViewer — PDF 原文渲染与批注查看器
 *
 * 对标 NotebookLM 的 PDF 原文渲染 + 引用高亮功能
 * 自研实现:
 * - 使用 pdf.js 在 Canvas 上渲染 PDF 页面
 * - 支持页码导航与缩放
 * - 支持文本搜索高亮
 * - 支持引用段落定位高亮
 *
 * 皮肤系统兼容: 使用 CSS 变量
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { ChevronLeft, ChevronRight, ZoomIn, ZoomOut, Search, FileText } from 'lucide-react';
import { PanelIcons, ActionIcons } from '../core/icons/icon-map';
import { useLang } from '../core/i18n/lang';

interface PdfViewerProps {
  /** PDF file path (Tauri) or base64 data URL */
  filePath?: string;
  /** Base64 encoded PDF data */
  pdfData?: string;
  /** Text to highlight on the rendered pages */
  highlightText?: string;
  onClose: () => void;
}

export function PdfViewer({ filePath, pdfData, highlightText, onClose }: PdfViewerProps) {
  const lang = useLang();
  const isZh = lang === 'zh';
  const CloseIcon = ActionIcons.close;

  const [pdfDoc, setPdfDoc] = useState<any>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [numPages, setNumPages] = useState(0);
  const [scale, setScale] = useState(1.2);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [searchQuery, setSearchQuery] = useState(highlightText || '');
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const renderTaskRef = useRef<any>(null);

  // Load PDF document
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        setError('');

        // Dynamic import of pdfjs-dist
        const pdfjsLib = await import('pdfjs-dist');

        // Set worker path
        const workerUrl = new URL(
          'pdfjs-dist/build/pdf.worker.min.mjs',
          import.meta.url
        ).href;
        pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

        let data: ArrayBuffer | Uint8Array;

        if (pdfData) {
          // Base64 data
          const binary = atob(pdfData);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
          }
          data = bytes;
        } else if (filePath) {
          // Read file via Tauri read_file command (base64 encoding for binary)
          const { invoke } = (window as any).__TAURI__?.core || {};
          if (invoke) {
            const base64Data = await invoke('read_file', { path: filePath, encoding: 'base64' });
            const binary = atob(base64Data);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) {
              bytes[i] = binary.charCodeAt(i);
            }
            data = bytes;
          } else {
            // Fallback: fetch
            const response = await fetch(filePath);
            data = await response.arrayBuffer();
          }
        } else {
          throw new Error(isZh ? '未提供 PDF 数据' : 'No PDF data provided');
        }

        const loadingTask = pdfjsLib.getDocument({ data });
        const doc = await loadingTask.promise;

        if (!cancelled) {
          setPdfDoc(doc);
          setNumPages(doc.numPages);
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
  }, [filePath, pdfData, isZh]);

  // Render current page
  const renderPage = useCallback(async () => {
    if (!pdfDoc || !canvasRef.current) return;

    // Cancel previous render task
    if (renderTaskRef.current) {
      renderTaskRef.current.cancel();
    }

    try {
      const page = await pdfDoc.getPage(currentPage);
      const viewport = page.getViewport({ scale });
      const canvas = canvasRef.current;
      const context = canvas.getContext('2d')!;

      canvas.width = viewport.width;
      canvas.height = viewport.height;

      const renderTask = page.render({
        canvasContext: context,
        viewport,
      });
      renderTaskRef.current = renderTask;
      await renderTask.promise;

      // Render text layer for search highlighting
      if (searchQuery.trim()) {
        const textContent = await page.getTextContent();
        const canvasContainer = canvas.parentElement;
        if (canvasContainer) {
          // Remove existing highlights
          const existingHighlights = canvasContainer.querySelectorAll('.pdf-highlight');
          existingHighlights.forEach(el => el.remove());

          // Find and highlight matching text
          const lowerQuery = searchQuery.toLowerCase();
          let currentText = '';
          let startItem: any = null;
          let startOffset = 0;

          for (let i = 0; i < textContent.items.length; i++) {
            const item = textContent.items[i];
            const itemText = item.str;
            const combinedText = currentText + itemText;
            const matchIdx = combinedText.toLowerCase().indexOf(lowerQuery);

            if (matchIdx !== -1) {
              // Found a match — create highlight overlay
              const highlight = document.createElement('div');
              highlight.className = 'pdf-highlight';
              highlight.style.cssText = `
                position: absolute;
                background: rgba(255, 235, 59, 0.3);
                border: 1px solid rgba(255, 235, 59, 0.5);
                pointer-events: none;
                border-radius: 2px;
              `;

              // Calculate position from the matching text item
              const matchItemIdx = matchIdx >= currentText.length ? i : i - 1;
              const matchItem = textContent.items[Math.max(0, matchItemIdx)];
              if (matchItem && matchItem.transform) {
                const tx = pdfjsLibViewportToPx(matchItem.transform, scale);
                highlight.style.left = `${tx.x}px`;
                highlight.style.top = `${tx.y - 12 * scale}px`;
                highlight.style.width = `${matchItem.width * scale}px`;
                highlight.style.height = `${matchItem.height * scale}px`;
              }

              canvasContainer.style.position = 'relative';
              canvasContainer.appendChild(highlight);
              break;
            }
            currentText = itemText;
          }
        }
      }
    } catch (err: any) {
      if (err.name !== 'RenderingCancelledException') {
        console.error('Page render error:', err);
      }
    }
  }, [pdfDoc, currentPage, scale, searchQuery]);

  useEffect(() => {
    renderPage();
  }, [renderPage]);

  // Navigation
  const goPrev = () => { if (currentPage > 1) setCurrentPage(currentPage - 1); };
  const goNext = () => { if (currentPage < numPages) setCurrentPage(currentPage + 1); };

  // Helper: transform matrix to pixel position
  function pdfjsLibViewportToPx(transform: number[], scaleFactor: number) {
    return {
      x: transform[4] * scaleFactor,
      y: transform[5] * scaleFactor,
    };
  }

  if (loading) {
    return (
      <div className="nb-source-viewer-overlay" onClick={onClose}>
        <div className="nb-source-viewer" onClick={(e) => e.stopPropagation()} style={{ alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ textAlign: 'center', padding: '40px' }}>
            <FileText size={32} className="animate-pulse" style={{ margin: '0 auto 12px', opacity: 0.5 }} />
            <p style={{ opacity: 0.6 }}>{isZh ? '正在加载 PDF...' : 'Loading PDF...'}</p>
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
              <FileText size={16} style={{ color: 'var(--accent)' }} />
              <span>PDF Viewer</span>
            </h3>
            <button className="nb-dialog-close" onClick={onClose}><CloseIcon size={16} /></button>
          </div>
          <div style={{ padding: '40px', textAlign: 'center' }}>
            <p style={{ color: 'var(--error)', fontSize: 'var(--fs-md)' }}>{error}</p>
            <p style={{ opacity: 0.5, fontSize: 'var(--fs-sm)', marginTop: '8px' }}>
              {isZh ? '提示：确保文件路径正确且 Tauri 已配置 PDF 读取权限' : 'Tip: Ensure the file path is correct and Tauri has PDF read permissions'}
            </p>
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
            <FileText size={16} style={{ color: 'var(--accent)' }} />
            <span>PDF Viewer</span>
            <span className="nb-source-type-tag" style={{ marginLeft: '8px' }}>
              {currentPage} / {numPages}
            </span>
          </div>
          <button className="nb-dialog-close" onClick={onClose}>
            <CloseIcon size={16} />
          </button>
        </div>

        {/* Toolbar */}
        <div style={{
          padding: '6px 16px',
          borderBottom: '1px solid var(--border-color, #2a2a30)',
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
        }}>
          <button
            onClick={goPrev}
            disabled={currentPage <= 1}
            style={{
              background: 'none', border: '1px solid var(--border-color, #2a2a30)',
              borderRadius: '4px', padding: '3px 6px', cursor: currentPage <= 1 ? 'default' : 'pointer',
              opacity: currentPage <= 1 ? 0.3 : 1, color: 'var(--text-secondary, #a0a0a8)',
            }}
          >
            <ChevronLeft size={14} />
          </button>
          <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted, #555)', minWidth: '40px', textAlign: 'center' }}>
            {currentPage} / {numPages}
          </span>
          <button
            onClick={goNext}
            disabled={currentPage >= numPages}
            style={{
              background: 'none', border: '1px solid var(--border-color, #2a2a30)',
              borderRadius: '4px', padding: '3px 6px', cursor: currentPage >= numPages ? 'default' : 'pointer',
              opacity: currentPage >= numPages ? 0.3 : 1, color: 'var(--text-secondary, #a0a0a8)',
            }}
          >
            <ChevronRight size={14} />
          </button>
          <div style={{ width: '1px', height: '16px', background: 'var(--border-color, #2a2a30)' }} />
          <button
            onClick={() => setScale(Math.max(0.5, scale - 0.2))}
            style={{ background: 'none', border: '1px solid var(--border-color, #2a2a30)', borderRadius: '4px', padding: '3px 6px', cursor: 'pointer', color: 'var(--text-secondary, #a0a0a8)' }}
          >
            <ZoomOut size={14} />
          </button>
          <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted, #555)', minWidth: '36px', textAlign: 'center' }}>
            {Math.round(scale * 100)}%
          </span>
          <button
            onClick={() => setScale(Math.min(3, scale + 0.2))}
            style={{ background: 'none', border: '1px solid var(--border-color, #2a2a30)', borderRadius: '4px', padding: '3px 6px', cursor: 'pointer', color: 'var(--text-secondary, #a0a0a8)' }}
          >
            <ZoomIn size={14} />
          </button>
          <div style={{ flex: 1 }} />
          <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
            <Search size={12} style={{ opacity: 0.4 }} />
            <input
              type="text"
              placeholder={isZh ? '搜索...' : 'Search...'}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              style={{
                background: 'var(--bg-primary, #0f0f10)',
                border: '1px solid var(--border-color, #2a2a30)',
                borderRadius: '4px',
                padding: '3px 6px',
                color: 'var(--text-primary, #e0e0e4)',
                fontSize: 'var(--fs-xs)',
                outline: 'none',
                width: '120px',
              }}
            />
          </div>
        </div>

        {/* PDF Canvas */}
        <div className="nb-source-viewer-body" style={{ overflow: 'auto', display: 'flex', justifyContent: 'center', padding: '16px' }}>
          <div style={{ position: 'relative' }}>
            <canvas
              ref={canvasRef}
              style={{
                display: 'block',
                boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
                background: '#fff',
              }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
