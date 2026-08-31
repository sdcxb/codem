/**
 * EditorToolbar — PPT 编辑器顶部工具栏
 *
 * 功能:
 * - 插入元素: 文本/形状/列表/图片
 * - 操作: 撤销/重做/复制/删除/上移/下移
 * - 对齐: 左中右/顶中底
 * - 主题切换 (下拉选择 PPT_STYLES 风格)
 * - 导出: HTML/PDF/PNG/PNG长图
 * - 放映模式
 */

import { useState, useRef, useEffect } from 'react';
import { type PPTTheme } from '../../core/knowledge/ppt-types';
import { PPT_STYLES, PPT_FONTS, STYLE_CATEGORY_LABELS, getStyleById, getFontById, type PPTStyle, type StyleCategory } from '../../core/knowledge/ppt-styles';
import './ppt-editor.css';

export interface EditorToolbarProps {
  selectedCount: number;
  canUndo: boolean;
  canRedo: boolean;
  currentTheme: PPTTheme;
  onThemeChange: (theme: PPTTheme) => void;
  onInsertText: () => void;
  onInsertShape: (shape: 'rect' | 'rounded' | 'circle' | 'triangle' | 'arrow' | 'line') => void;
  onInsertList: () => void;
  onInsertImage: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onBringForward: () => void;
  onSendBackward: () => void;
  onAlign: (align: 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom') => void;
  onExportHTML: () => void;
  onExportPPTX: () => void;
  onExportPDF: () => void;
  onExportPNG: () => void;
  onExportPNGLong: () => void;
  onPlayPresentation: () => void;
  onGenerateNotes: () => void;
  generatingNotes: boolean;
  onSaveVersion: () => void;
  onShowVersions: () => void;
  versionCount: number;
}

export function EditorToolbar({
  selectedCount, canUndo, canRedo, currentTheme,
  onThemeChange, onInsertText, onInsertShape, onInsertList, onInsertImage,
  onUndo, onRedo, onDelete, onDuplicate, onBringForward, onSendBackward, onAlign,
  onExportHTML, onExportPPTX, onExportPDF, onExportPNG, onExportPNGLong,
  onPlayPresentation, onGenerateNotes, generatingNotes,
  onSaveVersion, onShowVersions, versionCount,
}: EditorToolbarProps) {
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [showStyleMenu, setShowStyleMenu] = useState(false);
  const [styleFilter, setStyleFilter] = useState<StyleCategory | 'all'>('all');
  const exportRef = useRef<HTMLDivElement>(null);
  const styleRef = useRef<HTMLDivElement>(null);

  // 点击外部关闭菜单
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (exportRef.current && !exportRef.current.contains(e.target as Node)) setShowExportMenu(false);
      if (styleRef.current && !styleRef.current.contains(e.target as Node)) setShowStyleMenu(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const filteredStyles = styleFilter === 'all' ? PPT_STYLES : PPT_STYLES.filter(s => s.category === styleFilter);
  const categories: (StyleCategory | 'all')[] = ['all', 'light-pro', 'light-soft', 'light-minimal', 'dark-tech', 'dark-luxury', 'dark-sober', 'bold', 'vibrant', 'effect', 'magazine', 'warm', 'illustration', 'chinese', 'nature'];

  return (
    <div className="ppt-editor-toolbar">
      {/* 撤销重做 */}
      <div className="ppt-toolbar-group">
        <button className="ppt-toolbar-btn" onClick={onUndo} disabled={!canUndo} title="撤销 (Ctrl+Z)">↶</button>
        <button className="ppt-toolbar-btn" onClick={onRedo} disabled={!canRedo} title="重做 (Ctrl+Y)">↷</button>
      </div>

      {/* 插入元素 */}
      <div className="ppt-toolbar-group">
        <button className="ppt-toolbar-btn" onClick={onInsertText} title="插入文本 (T)">📝 文本</button>
        <button className="ppt-toolbar-btn" onClick={onInsertList} title="插入列表">☰ 列表</button>
        <div className="ppt-toolbar-divider" />
        <button className="ppt-toolbar-btn" onClick={() => onInsertShape('rect')} title="插入矩形">□ 矩形</button>
        <button className="ppt-toolbar-btn" onClick={() => onInsertShape('circle')} title="插入圆形">○ 圆形</button>
        <button className="ppt-toolbar-btn" onClick={() => onInsertShape('triangle')} title="插入三角形">△ 三角</button>
        <button className="ppt-toolbar-btn" onClick={() => onInsertShape('arrow')} title="插入箭头">→ 箭头</button>
        <button className="ppt-toolbar-btn" onClick={() => onInsertShape('line')} title="插入线条">─ 线条</button>
        <div className="ppt-toolbar-divider" />
        <button className="ppt-toolbar-btn" onClick={onInsertImage} title="插入图片">🖼️ 图片</button>
      </div>

      {/* 操作 */}
      <div className="ppt-toolbar-group">
        <button className="ppt-toolbar-btn" onClick={onDuplicate} disabled={selectedCount === 0} title="复制 (Ctrl+D)">📋 复制</button>
        <button className="ppt-toolbar-btn" onClick={onDelete} disabled={selectedCount === 0} title="删除" style={{ color: selectedCount > 0 ? '#ff8080' : undefined }}>🗑️ 删除</button>
      </div>

      {/* 层级 */}
      <div className="ppt-toolbar-group">
        <button className="ppt-toolbar-btn" onClick={onBringForward} disabled={selectedCount === 0} title="上移一层">⬆️ 上移</button>
        <button className="ppt-toolbar-btn" onClick={onSendBackward} disabled={selectedCount === 0} title="下移一层">⬇️ 下移</button>
      </div>

      {/* 对齐 */}
      <div className="ppt-toolbar-group">
        <button className="ppt-toolbar-btn" onClick={() => onAlign('left')} disabled={selectedCount < 2} title="左对齐">⬅ 左</button>
        <button className="ppt-toolbar-btn" onClick={() => onAlign('center')} disabled={selectedCount < 2} title="水平居中">↔ 中</button>
        <button className="ppt-toolbar-btn" onClick={() => onAlign('right')} disabled={selectedCount < 2} title="右对齐">右 ➡</button>
        <div className="ppt-toolbar-divider" />
        <button className="ppt-toolbar-btn" onClick={() => onAlign('top')} disabled={selectedCount < 2} title="顶对齐">⬆ 顶</button>
        <button className="ppt-toolbar-btn" onClick={() => onAlign('middle')} disabled={selectedCount < 2} title="垂直居中">↕ 中</button>
        <button className="ppt-toolbar-btn" onClick={() => onAlign('bottom')} disabled={selectedCount < 2} title="底对齐">底 ⬇</button>
      </div>

      {/* 风格切换 — 下拉弹出风格选择网格 */}
      <div className="ppt-toolbar-group" ref={styleRef} style={{ position: 'relative' }}>
        <button className="ppt-toolbar-btn" onClick={() => setShowStyleMenu(!showStyleMenu)} title="选择风格">
          🎨 风格: {currentTheme.name}
        </button>
        {showStyleMenu && (
          <div style={{
            position: 'absolute', top: '100%', left: 0, marginTop: 4,
            width: 420, maxHeight: 400, overflowY: 'auto',
            background: 'var(--bg-secondary, #252535)', border: '1px solid var(--border-primary, #3a3a4c)', borderRadius: 8,
            zIndex: 100000, padding: 12,
            boxShadow: 'var(--shadow-popover, 0 8px 32px rgba(0,0,0,0.3))',
          }}>
            {/* 分类筛选 */}
            <div style={{ display: 'flex', gap: 4, marginBottom: 10, flexWrap: 'wrap' }}>
              {categories.map(cat => (
                <button key={cat} onClick={() => setStyleFilter(cat)} style={{
                  padding: '3px 10px', borderRadius: 12, border: '1px solid', cursor: 'pointer', fontSize: 11,
                  background: styleFilter === cat ? 'var(--accent, #7c6cf0)' : 'transparent',
                  borderColor: styleFilter === cat ? 'var(--accent, #7c6cf0)' : 'var(--border-primary, #3a3a4c)',
                  color: styleFilter === cat ? 'var(--text-on-accent, #fff)' : 'var(--text-secondary, #a0a0b0)',
                }}>
                  {cat === 'all' ? '全部' : STYLE_CATEGORY_LABELS[cat]}
                </button>
              ))}
            </div>
            {/* 风格网格 */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
              {filteredStyles.map(style => (
                <div key={style.id} onClick={() => {
                  // 将 PPTStyle 转为 PPTTheme
                  onThemeChange({
                    id: style.id, name: style.name,
                    primaryColor: style.colors.primary, secondaryColor: style.colors.secondary,
                    accentColor: style.colors.accent, backgroundColor: style.colors.background,
                    textColor: style.colors.text,
                    fontFamily: getFontById(style.titleFontId)?.family || 'sans-serif',
                  });
                  setShowStyleMenu(false);
                }} style={{
                  cursor: 'pointer', borderRadius: 6, overflow: 'hidden', transition: 'all 0.15s',
                  border: currentTheme.id === style.id ? '2px solid var(--accent, #7c6cf0)' : '2px solid transparent',
                }}>
                  <div style={{ height: 50, background: style.backgroundGradient || style.colors.background, position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <div style={{ width: 24, height: 24, borderRadius: '50%', background: `linear-gradient(135deg, ${style.colors.primary}, ${style.colors.accent})`, opacity: 0.7 }} />
                  </div>
                  <div style={{ padding: '4px 6px', fontSize: 10, color: 'var(--text-primary, #e0e0e0)', fontWeight: 600, background: 'var(--input-bg, #1e1e2e)' }}>{style.name}</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* 导出 — 下拉菜单 */}
      <div className="ppt-toolbar-group" ref={exportRef} style={{ position: 'relative' }}>
        <button className="ppt-toolbar-btn" onClick={() => setShowExportMenu(!showExportMenu)} title="导出">
          📤 导出
        </button>
        {showExportMenu && (
          <div style={{
            position: 'absolute', top: '100%', right: 0, marginTop: 4,
            width: 180, background: 'var(--bg-secondary, #252535)', border: '1px solid var(--border-primary, #3a3a4c)', borderRadius: 8,
            zIndex: 100000, padding: 4,
            boxShadow: 'var(--shadow-popover, 0 8px 32px rgba(0,0,0,0.3))',
          }}>
            <button className="ppt-export-menu-item" onClick={() => { onExportHTML(); setShowExportMenu(false); }}>
              🌐 HTML 演示文稿
            </button>
            <button className="ppt-export-menu-item" onClick={() => { onExportPDF(); setShowExportMenu(false); }}>
              📄 PDF 文档
            </button>
            <button className="ppt-export-menu-item" onClick={() => { onExportPNG(); setShowExportMenu(false); }}>
              🖼️ PNG 批量图片 (ZIP)
            </button>
            <button className="ppt-export-menu-item" onClick={() => { onExportPNGLong(); setShowExportMenu(false); }}>
              📜 PNG 长图
            </button>
            <button className="ppt-export-menu-item" onClick={() => { onExportPPTX(); setShowExportMenu(false); }}>
              📊 PPTX 文件
            </button>
          </div>
        )}
      </div>

      {/* 放映 */}
      <div className="ppt-toolbar-group">
        <button className="ppt-toolbar-btn active" onClick={onPlayPresentation} title="播放演示 (F5)">▶️ 播放</button>
<button className="ppt-toolbar-btn" onClick={onGenerateNotes} disabled={generatingNotes} title="AI 生成演讲稿" style={{ opacity: generatingNotes ? 0.6 : 1 }}>
  {generatingNotes ? '⏳ 生成中...' : '📝 演讲稿'}
</button>
<button className="ppt-toolbar-btn" onClick={onSaveVersion} title="保存版本">💾 版本</button>
<button className="ppt-toolbar-btn" onClick={onShowVersions} title="历史版本">
  📚 历史{versionCount > 0 ? ` (${versionCount})` : ''}
</button>
      </div>

      {/* 导出菜单项样式 */}
      <style>{`
        .ppt-export-menu-item {
          display: block; width: 100%; text-align: left;
          padding: 8px 12px; background: transparent; border: none;
          color: var(--text-secondary, #b0b0c0); font-size: 13px; cursor: pointer; border-radius: 4px;
          transition: all 0.15s;
        }
        .ppt-export-menu-item:hover {
          background: var(--bg-hover, #3a3a4c); color: var(--text-primary, #fff);
        }
      `}</style>
    </div>
  );
}
