/**
 * NoteEditor — Markdown 笔记编辑器（实时预览 + WikiLinks + 反向链接）
 *
 * 借鉴思路来源: Lumina Note (https://github.com/blueberrycongee/lumina-note)
 * 该项目使用 CodeMirror 构建 Markdown 编辑器, 支持 WikiLinks 和 Backlinks;
 * 我们自研实现:
 * - 使用已有 react-markdown + remark-gfm 实现实时预览 (无需引入 CodeMirror)
 * - 自研 WikiLinks 渲染: 将 [[标题]] 转为可点击链接
 * - 自研 Backlinks 面板: 使用 storage 层的 getBacklinks 函数
 *
 * 皮肤系统兼容:
 * - 使用 CSS 变量适配 default / hub / dream 三套皮肤
 * - 编辑器配色跟随皮肤背景色、文字色、边框色
 *
 * 功能对标:
 * - NotebookLM: 笔记编辑 + 保存 AI 回答为笔记
 * - Lumina Note: Markdown 实时预览 + WikiLinks + Backlinks
 */

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  Edit3, Eye, Columns, Save, X, Bold, Italic, Heading, List, Link as LinkIcon,
  Link2, ArrowLeft, FileText, ArrowRight, Download, Tag, History, RotateCcw, Trash2,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { useSkin } from '../core/theme';
import { useLang } from '../core/i18n/lang';
// KaTeX CSS for LaTeX formula rendering
import 'katex/dist/katex.min.css';
import {
  wikilinksToMarkdown, syncNoteLinks, getIncomingLinks, getOutgoingLinks,
  listNotes, getNote, exportNoteAsMarkdown, downloadMarkdown,
  saveNoteVersion, listNoteVersions, restoreNoteVersion, deleteNoteVersion,
} from '../core/knowledge';
import type { Note, NoteLink, NoteVersion } from '../core/knowledge';

// Mermaid 代码块渲染组件 (复用 MessageBubble 中的渲染逻辑)
const MermaidBlock = ({ chart }: { chart: string }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [svg, setSvg] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const mermaid = (await import('mermaid')).default;
        mermaid.initialize({
          startOnLoad: false,
          theme: 'dark',
          securityLevel: 'loose',
          fontFamily: 'inherit',
        });
        const id = `note-mermaid-${Date.now()}-${Math.random().toString(36).substring(7)}`;
        const { svg: renderedSvg } = await mermaid.render(id, chart);
        if (!cancelled) {
          setSvg(renderedSvg);
          setError('');
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

  if (loading) return <div style={{ padding: '12px', opacity: 0.5, fontSize: '12px' }}>Rendering diagram...</div>;
  if (error) return (
    <div style={{ padding: '8px', border: '1px solid var(--border-color)', borderRadius: '4px', fontSize: '11px', color: 'var(--text-muted)' }}>
      <pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{chart}</pre>
    </div>
  );
  return <div ref={containerRef} className="mermaid-container" dangerouslySetInnerHTML={{ __html: svg }} />;
};

export type EditorViewMode = 'edit' | 'split' | 'preview';

interface NoteEditorProps {
  note: Note;
  notebookId: string;
  onSave: (title: string, content: string, tags?: string[]) => void;
  onCancel: () => void;
  onNavigateToNote?: (noteId: string) => void;
}

export function NoteEditor({
  note,
  notebookId,
  onSave,
  onCancel,
  onNavigateToNote,
}: NoteEditorProps) {
  const lang = useLang();
  const isZh = lang === 'zh';
  const { skin } = useSkin();

  const [title, setTitle] = useState(note.title);
  const [content, setContent] = useState(note.content);
  const [tags, setTags] = useState<string[]>(note.tags || []);
  const [tagInput, setTagInput] = useState('');
  const [viewMode, setViewMode] = useState<EditorViewMode>('split');
  const [backlinks, setBacklinks] = useState<NoteLink[]>([]);
  const [outgoingLinks, setOutgoingLinks] = useState<NoteLink[]>([]);
  const [showVersions, setShowVersions] = useState(false);
  const [versions, setVersions] = useState<NoteVersion[]>([]);

  // 加载链接数据
  const refreshLinks = useCallback(() => {
    setBacklinks(getIncomingLinks(note.id));
    setOutgoingLinks(getOutgoingLinks(note.id));
  }, [note.id]);

  useEffect(() => {
    refreshLinks();
  }, [refreshLinks]);

  // 保存笔记
  const handleSave = useCallback(() => {
    // A17: Save a version snapshot before saving
    saveNoteVersion(note.id);
    onSave(title, content, tags);
    // 同步 WikiLinks
    syncNoteLinks(note.id, notebookId, content);
    refreshLinks();
  }, [title, content, tags, note.id, notebookId, onSave, refreshLinks]);

  // A17: Show version history
  const handleShowVersions = useCallback(() => {
    setVersions(listNoteVersions(note.id));
    setShowVersions(true);
  }, [note.id]);

  // A17: Restore a version
  const handleRestoreVersion = useCallback((versionId: string) => {
    restoreNoteVersion(versionId);
    const updated = getNote(note.id);
    if (updated) {
      setTitle(updated.title);
      setContent(updated.content);
      setTags(updated.tags || []);
    }
    setVersions(listNoteVersions(note.id));
  }, [note.id]);

  // A17: Delete a version
  const handleDeleteVersion = useCallback((versionId: string) => {
    deleteNoteVersion(versionId);
    setVersions(listNoteVersions(note.id));
  }, []);

  // 导出当前笔记为 Markdown
  const handleExportNote = useCallback(() => {
    const md = exportNoteAsMarkdown({ ...note, title, content, tags });
    downloadMarkdown(title || 'note', md);
  }, [note, title, content, tags]);

  // 添加标签
  const handleAddTag = useCallback(() => {
    const trimmed = tagInput.trim();
    if (trimmed && !tags.includes(trimmed)) {
      setTags([...tags, trimmed]);
    }
    setTagInput('');
  }, [tagInput, tags]);

  // 移除标签
  const handleRemoveTag = useCallback((tag: string) => {
    setTags(tags.filter(t => t !== tag));
  }, [tags]);

  // 工具栏: 插入 Markdown 语法
  const insertSyntax = useCallback((before: string, after: string = '', placeholder: string = '') => {
    const textarea = document.getElementById('nb-md-textarea') as HTMLTextAreaElement;
    if (!textarea) return;

    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const selectedText = content.substring(start, end) || placeholder;
    const newContent = content.substring(0, start) + before + selectedText + after + content.substring(end);

    setContent(newContent);

    // 恢复焦点和选区
    requestAnimationFrame(() => {
      textarea.focus();
      const newCursorPos = start + before.length + selectedText.length + after.length;
      textarea.setSelectionRange(start + before.length, newCursorPos - after.length);
    });
  }, [content]);

  // 处理预览中的 WikiLink 点击
  const handlePreviewLinkClick = useCallback((href: string) => {
    if (href.startsWith('#note:')) {
      const targetTitle = decodeURIComponent(href.substring(6));
      // 查找匹配的笔记
      const notes = listNotes(notebookId);
      const target = notes.find(
        (n) => n.title.toLowerCase() === targetTitle.toLowerCase() ||
               n.title.toLowerCase().includes(targetTitle.toLowerCase())
      );
      if (target && onNavigateToNote) {
        onNavigateToNote(target.id);
      }
    }
  }, [notebookId, onNavigateToNote]);

  // 将 WikiLinks 转为标准 Markdown 用于预览
  const previewContent = useMemo(() => {
    return wikilinksToMarkdown(content);
  }, [content]);

  // 获取链接笔记的标题
  const getNoteTitle = useCallback((noteId: string): string => {
    const n = getNote(noteId);
    return n?.title || (isZh ? '未知笔记' : 'Unknown note');
  }, [isZh]);

  // 渲染 Markdown 链接的自定义组件
  const markdownComponents = {
    a: ({ href, children }: any) => (
      <a
        href={href}
        onClick={(e) => {
          if (href?.startsWith('#note:')) {
            e.preventDefault();
            handlePreviewLinkClick(href);
          }
        }}
        style={{
          color: href?.startsWith('#note:') ? 'var(--accent-primary, #6366f1)' : 'var(--accent-hover, #5558e3)',
          cursor: 'pointer',
          textDecoration: 'underline',
          textDecorationStyle: href?.startsWith('#note:') ? 'dashed' : 'solid',
        }}
      >
        {children}
      </a>
    ),
    code: ({ className, children, ...props }: any) => {
      const match = /language-(\w+)/.exec(className || '');
      const codeStr = String(children).replace(/\n$/, '');
      if (match && match[1] === 'mermaid') {
        return <MermaidBlock chart={codeStr} />;
      }
      if (match) {
        return (
          <div className="code-block" style={{ margin: '8px 0' }}>
            <div className="code-header" style={{ fontSize: '10px', opacity: 0.6, padding: '2px 8px' }}>
              {match[1]}
            </div>
            <pre style={{
              padding: '8px 12px',
              background: 'var(--bg-tertiary, #1a1a20)',
              borderRadius: '4px',
              overflow: 'auto',
              fontSize: '12px',
              fontFamily: 'var(--font-mono, monospace)',
            }}>
              <code className={className} {...props}>{children}</code>
            </pre>
          </div>
        );
      }
      return <code className={className} {...props}>{children}</code>;
    },
  };

  return (
    <div className="nb-editor-overlay" onClick={onCancel}>
      <div className="nb-editor-dialog" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="nb-editor-header">
          <div className="nb-editor-title-row">
            <Edit3 className="w-4 h-4" style={{ color: 'var(--accent-primary, #6366f1)' }} />
            <input
              className="nb-editor-title-input"
              placeholder={isZh ? '笔记标题' : 'Note title'}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
            <div className="nb-editor-actions">
            {/* 导出当前笔记 */}
            <button
              className="nb-mode-btn"
              onClick={handleExportNote}
              title={isZh ? '导出为 Markdown' : 'Export as Markdown'}
            >
              <Download className="w-3.5 h-3.5" />
            </button>
            {/* A17: 版本历史 */}
            <button
              className="nb-mode-btn"
              onClick={handleShowVersions}
              title={isZh ? '版本历史' : 'Version History'}
            >
              <History className="w-3.5 h-3.5" />
            </button>
            {/* View mode toggle */}
            <div className="nb-editor-mode-toggle">
              <button
                className={`nb-mode-btn ${viewMode === 'edit' ? 'active' : ''}`}
                onClick={() => setViewMode('edit')}
                title={isZh ? '编辑模式' : 'Edit mode'}
              >
                <Edit3 className="w-3.5 h-3.5" />
              </button>
              <button
                className={`nb-mode-btn ${viewMode === 'split' ? 'active' : ''}`}
                onClick={() => setViewMode('split')}
                title={isZh ? '分屏模式' : 'Split mode'}
              >
                <Columns className="w-3.5 h-3.5" />
              </button>
              <button
                className={`nb-mode-btn ${viewMode === 'preview' ? 'active' : ''}`}
                onClick={() => setViewMode('preview')}
                title={isZh ? '预览模式' : 'Preview mode'}
              >
                <Eye className="w-3.5 h-3.5" />
              </button>
            </div>
            <button className="nb-editor-close" onClick={onCancel}>
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Tags input (always visible) */}
        <div style={{
          padding: '6px 16px',
          borderBottom: '1px solid var(--border-color, #2a2a30)',
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          flexWrap: 'wrap',
        }}>
          <Tag className="w-3 h-3" style={{ opacity: 0.5 }} />
          {tags.map(tag => (
            <span
              key={tag}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '3px',
                padding: '2px 6px',
                background: 'var(--bg-tertiary, #25252b)',
                border: '1px solid var(--border-color, #2a2a30)',
                borderRadius: '10px',
                fontSize: '10px',
                color: 'var(--text-secondary, #a0a0a8)',
              }}
            >
              {tag}
              <button
                onClick={() => handleRemoveTag(tag)}
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'var(--text-muted, #555)',
                  cursor: 'pointer',
                  padding: '0',
                  fontSize: '11px',
                  lineHeight: '1',
                }}
              >
                ×
              </button>
            </span>
          ))}
          <input
            type="text"
            placeholder={isZh ? '添加标签...' : 'Add tag...'}
            value={tagInput}
            onChange={(e) => setTagInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                handleAddTag();
              }
            }}
            onBlur={handleAddTag}
            style={{
              flex: '1',
              minWidth: '80px',
              background: 'transparent',
              border: 'none',
              color: 'var(--text-primary, #e0e0e4)',
              fontSize: '11px',
              outline: 'none',
            }}
          />
        </div>

        {/* Toolbar (only in edit/split mode) */}
        {viewMode !== 'preview' && (
          <div className="nb-editor-toolbar">
            <button className="nb-tool-btn" onClick={() => insertSyntax('**', '**', isZh ? '粗体' : 'bold')} title="Bold">
              <Bold className="w-3.5 h-3.5" />
            </button>
            <button className="nb-tool-btn" onClick={() => insertSyntax('*', '*', isZh ? '斜体' : 'italic')} title="Italic">
              <Italic className="w-3.5 h-3.5" />
            </button>
            <button className="nb-tool-btn" onClick={() => insertSyntax('## ', '', isZh ? '标题' : 'heading')} title="Heading">
              <Heading className="w-3.5 h-3.5" />
            </button>
            <button className="nb-tool-btn" onClick={() => insertSyntax('- ', '', isZh ? '列表项' : 'list item')} title="List">
              <List className="w-3.5 h-3.5" />
            </button>
            <button className="nb-tool-btn" onClick={() => insertSyntax('[', '](url)', isZh ? '链接文本' : 'link text')} title="Link">
              <LinkIcon className="w-3.5 h-3.5" />
            </button>
            <button
              className="nb-tool-btn nb-tool-wikilink"
              onClick={() => insertSyntax('[[', ']]', isZh ? '笔记标题' : 'note title')}
              title={isZh ? 'WikiLink — 链接到其他笔记' : 'WikiLink — link to another note'}
            >
              <Link2 className="w-3.5 h-3.5" />
            </button>
            <div className="nb-tool-divider" />
            <span className="nb-tool-hint">
              {isZh ? '使用 [[笔记标题]] 创建双向链接' : 'Use [[note title]] for bidirectional links'}
            </span>
          </div>
        )}

        {/* Body: Editor + Preview + Backlinks */}
        <div className="nb-editor-body">
          {/* Editor pane */}
          {viewMode !== 'preview' && (
            <div className={`nb-editor-pane ${viewMode === 'split' ? 'half' : 'full'}`}>
              <textarea
                id="nb-md-textarea"
                className="nb-md-textarea"
                placeholder={isZh ? '使用 Markdown 编写笔记内容... 使用 [[笔记标题]] 创建双向链接' : 'Write note content in Markdown... Use [[note title]] for bidirectional links'}
                value={content}
                onChange={(e) => setContent(e.target.value)}
                onKeyDown={(e) => {
                  // Ctrl/Cmd + S 保存
                  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
                    e.preventDefault();
                    handleSave();
                  }
                  // Tab 缩进
                  if (e.key === 'Tab') {
                    e.preventDefault();
                    const textarea = e.currentTarget;
                    const start = textarea.selectionStart;
                    const end = textarea.selectionEnd;
                    const newContent = content.substring(0, start) + '  ' + content.substring(end);
                    setContent(newContent);
                    requestAnimationFrame(() => {
                      textarea.selectionStart = textarea.selectionEnd = start + 2;
                    });
                  }
                }}
              />
            </div>
          )}

          {/* Preview pane */}
          {viewMode !== 'edit' && (
            <div className={`nb-editor-pane nb-preview-pane ${viewMode === 'split' ? 'half' : 'full'}`}>
              <div className="nb-md-preview">
                {content.trim() ? (
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm, remarkMath]}
                    rehypePlugins={[rehypeKatex]}
                    components={markdownComponents}
                  >
                    {previewContent}
                  </ReactMarkdown>
                ) : (
                  <p className="nb-preview-empty">
                    {isZh ? '预览区域为空 — 开始输入内容' : 'Preview is empty — start typing'}
                  </p>
                )}
              </div>
            </div>
          )}

          {/* Backlinks sidebar — 借鉴 Lumina Note 的反向链接面板 */}
          <div className="nb-backlinks-sidebar">
            <div className="nb-backlinks-header">
              <Link2 className="w-3.5 h-3.5" style={{ color: 'var(--accent-primary, #6366f1)' }} />
              <span className="nb-backlinks-title">
                {isZh ? '链接关系' : 'Links'}
              </span>
            </div>

            {/* Outgoing links */}
            <div className="nb-backlinks-section">
              <h4 className="nb-backlinks-section-title">
                {isZh ? '出链' : 'Outgoing'}
                <span className="nb-backlinks-count">{outgoingLinks.length}</span>
              </h4>
              {outgoingLinks.length === 0 ? (
                <p className="nb-backlinks-empty">
                  {isZh ? '无出链。使用 [[笔记标题]] 创建链接' : 'No outgoing links. Use [[note title]] to link'}
                </p>
              ) : (
                <div className="nb-backlinks-list">
                  {outgoingLinks.map((link) => (
                    <button
                      key={link.id}
                      className="nb-backlink-item"
                      onClick={() => onNavigateToNote?.(link.targetNoteId)}
                    >
                      <ArrowRight className="w-3 h-3" style={{ opacity: 0.5 }} />
                      <span className="nb-backlink-text">{getNoteTitle(link.targetNoteId)}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Incoming links (Backlinks) */}
            <div className="nb-backlinks-section">
              <h4 className="nb-backlinks-section-title">
                {isZh ? '反向链接' : 'Backlinks'}
                <span className="nb-backlinks-count">{backlinks.length}</span>
              </h4>
              {backlinks.length === 0 ? (
                <p className="nb-backlinks-empty">
                  {isZh ? '暂无反向链接' : 'No backlinks yet'}
                </p>
              ) : (
                <div className="nb-backlinks-list">
                  {backlinks.map((link) => (
                    <button
                      key={link.id}
                      className="nb-backlink-item"
                      onClick={() => onNavigateToNote?.(link.sourceNoteId)}
                    >
                      <ArrowLeft className="w-3 h-3" style={{ opacity: 0.5 }} />
                      <span className="nb-backlink-text">{getNoteTitle(link.sourceNoteId)}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="nb-editor-footer">
          <div className="nb-editor-stats">
            <FileText className="w-3 h-3" style={{ opacity: 0.5 }} />
            <span>{content.length} {isZh ? '字符' : 'chars'}</span>
            <span style={{ opacity: 0.3 }}>·</span>
            <Link2 className="w-3 h-3" style={{ opacity: 0.5 }} />
            <span>{outgoingLinks.length + backlinks.length} {isZh ? '链接' : 'links'}</span>
          </div>
          <div className="nb-editor-footer-actions">
            <button className="nb-btn-cancel" onClick={onCancel}>
              {isZh ? '取消' : 'Cancel'}
            </button>
            <button className="nb-btn-confirm" onClick={handleSave}>
              <Save className="w-3.5 h-3.5" />
              {isZh ? '保存' : 'Save'}
              <span className="nb-shortcut-hint">⌘S</span>
            </button>
          </div>
        </div>
      </div>

      {/* A17: Version History Dialog */}
      {showVersions && (
        <div className="nb-dialog-overlay" onClick={() => setShowVersions(false)}>
          <div className="nb-dialog" style={{ width: '600px', maxHeight: '70vh' }} onClick={(e) => e.stopPropagation()}>
            <div className="nb-dialog-header">
              <h3 className="nb-dialog-title">
                <History className="w-4 h-4" />
                {isZh ? '版本历史' : 'Version History'}
                <span className="nb-count-badge">{versions.length}</span>
              </h3>
              <button className="nb-dialog-close" onClick={() => setShowVersions(false)}>
                <X className="w-4 h-4" />
              </button>
            </div>
            <div style={{ overflow: 'auto', maxHeight: '50vh', padding: '12px 20px' }}>
              {versions.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted, #555)' }}>
                  <History className="w-8 h-8" style={{ margin: '0 auto 8px', opacity: 0.5 }} />
                  <p>{isZh ? '暂无历史版本，保存笔记时会自动创建快照' : 'No versions yet. Snapshots are created automatically when saving.'}</p>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {versions.map((ver) => (
                    <div
                      key={ver.id}
                      style={{
                        padding: '12px',
                        background: 'var(--bg-tertiary, #25252b)',
                        border: '1px solid var(--border-color, #2a2a30)',
                        borderRadius: '8px',
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '8px' }}>
                        <div style={{ flex: 1 }}>
                          <p style={{ fontSize: '13px', fontWeight: 500, margin: '0 0 4px' }}>{ver.title}</p>
                          {ver.versionNote && (
                            <span style={{ fontSize: '10px', color: 'var(--accent-primary, #6366f1)' }}>{ver.versionNote}</span>
                          )}
                          <p style={{ fontSize: '11px', opacity: 0.5, margin: '4px 0 0' }}>
                            {new Date(ver.createdAt).toLocaleString(isZh ? 'zh-CN' : 'en-US')}
                          </p>
                          <p style={{ fontSize: '11px', opacity: 0.4, margin: '4px 0 0', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {ver.content.slice(0, 100)}...
                          </p>
                        </div>
                        <div style={{ display: 'flex', gap: '4px', flexShrink: 0 }}>
                          <button
                            onClick={() => handleRestoreVersion(ver.id)}
                            title={isZh ? '恢复此版本' : 'Restore this version'}
                            style={{
                              background: 'none', border: '1px solid var(--border-color, #2a2a30)',
                              borderRadius: '4px', padding: '4px 6px', cursor: 'pointer',
                              color: 'var(--accent-primary, #6366f1)',
                            }}
                          >
                            <RotateCcw className="w-3 h-3" />
                          </button>
                          <button
                            onClick={() => handleDeleteVersion(ver.id)}
                            title={isZh ? '删除此版本' : 'Delete this version'}
                            style={{
                              background: 'none', border: '1px solid var(--border-color, #2a2a30)',
                              borderRadius: '4px', padding: '4px 6px', cursor: 'pointer',
                              color: 'var(--text-muted, #555)',
                            }}
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
