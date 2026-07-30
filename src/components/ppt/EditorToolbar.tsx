/**
 * EditorToolbar — PPT 编辑器顶部工具栏
 *
 * 功能:
 * - 插入元素: 文本/形状/列表/图片
 * - 操作: 撤销/重做/复制/删除/上移/下移
 * - 对齐: 左中右/顶中底
 * - 主题切换
 * - 导出: HTML/PPTX
 * - 放映模式
 */

import { type PPTTheme, PPT_THEMES } from '../../core/knowledge/ppt-types';
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
  onPlayPresentation: () => void;
}

export function EditorToolbar({
  selectedCount,
  canUndo,
  canRedo,
  currentTheme,
  onThemeChange,
  onInsertText,
  onInsertShape,
  onInsertList,
  onInsertImage,
  onUndo,
  onRedo,
  onDelete,
  onDuplicate,
  onBringForward,
  onSendBackward,
  onAlign,
  onExportHTML,
  onExportPPTX,
  onPlayPresentation,
}: EditorToolbarProps) {
  return (
    <div className="ppt-editor-toolbar">
      {/* 撤销重做 */}
      <div className="ppt-toolbar-group">
        <button className="ppt-toolbar-btn" onClick={onUndo} disabled={!canUndo} title="撤销 (Ctrl+Z)">
          ↶
        </button>
        <button className="ppt-toolbar-btn" onClick={onRedo} disabled={!canRedo} title="重做 (Ctrl+Y)">
          ↷
        </button>
      </div>

      {/* 插入元素 */}
      <div className="ppt-toolbar-group">
        <button className="ppt-toolbar-btn" onClick={onInsertText} title="插入文本 (T)">
          📝 文本
        </button>
        <button className="ppt-toolbar-btn" onClick={onInsertList} title="插入列表">
          ☰ 列表
        </button>
        <div className="ppt-toolbar-divider" />
        <button className="ppt-toolbar-btn" onClick={() => onInsertShape('rect')} title="插入矩形">
          □ 矩形
        </button>
        <button className="ppt-toolbar-btn" onClick={() => onInsertShape('circle')} title="插入圆形">
          ○ 圆形
        </button>
        <button className="ppt-toolbar-btn" onClick={() => onInsertShape('triangle')} title="插入三角形">
          △ 三角
        </button>
        <button className="ppt-toolbar-btn" onClick={() => onInsertShape('arrow')} title="插入箭头">
          → 箭头
        </button>
        <button className="ppt-toolbar-btn" onClick={() => onInsertShape('line')} title="插入线条">
          ─ 线条
        </button>
        <div className="ppt-toolbar-divider" />
        <button className="ppt-toolbar-btn" onClick={onInsertImage} title="插入图片">
          🖼️ 图片
        </button>
      </div>

      {/* 操作 */}
      <div className="ppt-toolbar-group">
        <button className="ppt-toolbar-btn" onClick={onDuplicate} disabled={selectedCount === 0} title="复制 (Ctrl+D)">
          📋 复制
        </button>
        <button className="ppt-toolbar-btn"
          onClick={onDelete}
          disabled={selectedCount === 0}
          title="删除"
          style={{ color: selectedCount > 0 ? '#ff8080' : undefined }}>
          🗑️ 删除
        </button>
      </div>

      {/* 层级 */}
      <div className="ppt-toolbar-group">
        <button className="ppt-toolbar-btn" onClick={onBringForward} disabled={selectedCount === 0} title="上移一层">
          ⬆️ 上移
        </button>
        <button className="ppt-toolbar-btn" onClick={onSendBackward} disabled={selectedCount === 0} title="下移一层">
          ⬇️ 下移
        </button>
      </div>

      {/* 对齐 */}
      <div className="ppt-toolbar-group">
        <button className="ppt-toolbar-btn" onClick={() => onAlign('left')} disabled={selectedCount < 2} title="左对齐">
          ⬅ 左
        </button>
        <button className="ppt-toolbar-btn" onClick={() => onAlign('center')} disabled={selectedCount < 2} title="水平居中">
          ↔ 中
        </button>
        <button className="ppt-toolbar-btn" onClick={() => onAlign('right')} disabled={selectedCount < 2} title="右对齐">
          右 ➡
        </button>
        <div className="ppt-toolbar-divider" />
        <button className="ppt-toolbar-btn" onClick={() => onAlign('top')} disabled={selectedCount < 2} title="顶对齐">
          ⬆ 顶
        </button>
        <button className="ppt-toolbar-btn" onClick={() => onAlign('middle')} disabled={selectedCount < 2} title="垂直居中">
          ↕ 中
        </button>
        <button className="ppt-toolbar-btn" onClick={() => onAlign('bottom')} disabled={selectedCount < 2} title="底对齐">
          底 ⬇
        </button>
      </div>

      {/* 主题 */}
      <div className="ppt-toolbar-group">
        <span className="ppt-toolbar-label">主题:</span>
        <select
          className="ppt-property-select"
          value={currentTheme.id}
          onChange={e => {
            const theme = PPT_THEMES.find(t => t.id === e.target.value);
            if (theme) onThemeChange(theme);
          }}
        >
          {PPT_THEMES.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      </div>

      {/* 导出与放映 */}
      <div className="ppt-toolbar-group">
        <button className="ppt-toolbar-btn" onClick={onExportHTML} title="导出为 HTML">
          🌐 HTML
        </button>
        <button className="ppt-toolbar-btn" onClick={onExportPPTX} title="导出为 PPTX">
          📊 PPTX
        </button>
        <div className="ppt-toolbar-divider" />
        <button className="ppt-toolbar-btn active" onClick={onPlayPresentation} title="播放演示 (F5)">
          ▶️ 播放
        </button>
      </div>
    </div>
  );
}