/**
 * PropertyPanel — 元素属性面板
 */

import { type SlideElement, type TextElement, type ShapeElement, type ImageElement, type ListElement, type ShapeKind } from '../../core/knowledge/ppt-types';

export interface PropertyPanelProps {
  selectedElements: SlideElement[];
  onUpdateElement: (id: string, changes: Partial<SlideElement>) => void;
  onAlign: (align: 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom') => void;
  onBringForward: () => void;
  onSendBackward: () => void;
  onBringToFront: () => void;
  onSendToBack: () => void;
  onDelete: () => void;
}

export function PropertyPanel({
  selectedElements,
  onUpdateElement,
  onAlign,
  onBringForward,
  onSendBackward,
  onBringToFront,
  onSendToBack,
  onDelete,
}: PropertyPanelProps) {
  if (selectedElements.length === 0) {
    return (
      <div className="ppt-property-panel">
        <div className="ppt-property-header">属性面板</div>
        <div className="ppt-property-empty">
          点击画布上的元素查看属性<br />
          或从工具栏插入新元素
        </div>
      </div>
    );
  }

  const el = selectedElements[0];
  const isSingle = selectedElements.length === 1;

  return (
    <div className="ppt-property-panel">
      <div className="ppt-property-header">
        {isSingle ? `编辑: ${el.type === 'text' ? '文本' : el.type === 'shape' ? '形状' : el.type === 'image' ? '图片' : '列表'}` : `${selectedElements.length} 个元素已选中`}
      </div>

      {isSingle && (
        <div className="ppt-property-section">
          <div className="ppt-property-section-title">位置与大小</div>
          <div className="ppt-property-row">
            <span className="ppt-property-label">X</span>
            <input type="number" className="ppt-property-input"
              value={Math.round(el.x * 10) / 10}
              onChange={e => onUpdateElement(el.id, { x: parseFloat(e.target.value) || 0 })} />
            <span className="ppt-property-label">Y</span>
            <input type="number" className="ppt-property-input"
              value={Math.round(el.y * 10) / 10}
              onChange={e => onUpdateElement(el.id, { y: parseFloat(e.target.value) || 0 })} />
          </div>
          <div className="ppt-property-row">
            <span className="ppt-property-label">宽</span>
            <input type="number" className="ppt-property-input"
              value={Math.round(el.width * 10) / 10}
              onChange={e => onUpdateElement(el.id, { width: Math.max(1, parseFloat(e.target.value) || 1) })} />
            <span className="ppt-property-label">高</span>
            <input type="number" className="ppt-property-input"
              value={Math.round(el.height * 10) / 10}
              onChange={e => onUpdateElement(el.id, { height: Math.max(1, parseFloat(e.target.value) || 1) })} />
          </div>
          <div className="ppt-property-row">
            <span className="ppt-property-label">旋转</span>
            <input type="number" className="ppt-property-input"
              value={el.rotation}
              onChange={e => onUpdateElement(el.id, { rotation: parseFloat(e.target.value) || 0 })} />
            <span className="ppt-property-label">透明</span>
            <input type="number" className="ppt-property-input"
              min="0" max="1" step="0.1"
              value={el.opacity}
              onChange={e => onUpdateElement(el.id, { opacity: Math.min(1, Math.max(0, parseFloat(e.target.value) || 1)) })} />
          </div>
        </div>
      )}

      {isSingle && el.type === 'text' && (
        <TextProperties el={el as TextElement} onUpdate={onUpdateElement} />
      )}

      {isSingle && el.type === 'list' && (
        <ListProperties el={el as ListElement} onUpdate={onUpdateElement} />
      )}

      {isSingle && el.type === 'shape' && (
        <ShapeProperties el={el as ShapeElement} onUpdate={onUpdateElement} />
      )}

      {isSingle && el.type === 'image' && (
        <ImageProperties el={el as ImageElement} onUpdate={onUpdateElement} />
      )}

      {isSingle && (
        <div className="ppt-property-section">
          <div className="ppt-property-section-title">层级</div>
          <div className="ppt-property-btn-group">
            <button className="ppt-property-btn" onClick={onBringToFront}>置顶</button>
            <button className="ppt-property-btn" onClick={onBringForward}>上移</button>
            <button className="ppt-property-btn" onClick={onSendBackward}>下移</button>
            <button className="ppt-property-btn" onClick={onSendToBack}>置底</button>
          </div>
        </div>
      )}

      {selectedElements.length >= 2 && (
        <div className="ppt-property-section">
          <div className="ppt-property-section-title">对齐分布</div>
          <div className="ppt-property-btn-group">
            <button className="ppt-property-btn" onClick={() => onAlign('left')}>左</button>
            <button className="ppt-property-btn" onClick={() => onAlign('center')}>中</button>
            <button className="ppt-property-btn" onClick={() => onAlign('right')}>右</button>
          </div>
          <div className="ppt-property-btn-group" style={{ marginTop: 4 }}>
            <button className="ppt-property-btn" onClick={() => onAlign('top')}>顶</button>
            <button className="ppt-property-btn" onClick={() => onAlign('middle')}>中</button>
            <button className="ppt-property-btn" onClick={() => onAlign('bottom')}>底</button>
          </div>
        </div>
      )}

      <div className="ppt-property-section">
        <button className="ppt-property-btn"
          style={{ background: '#3a1a1a', borderColor: '#5a2a2a', color: '#ff8080' }}
          onClick={onDelete}>
          删除元素 {selectedElements.length > 1 ? `(${selectedElements.length})` : ''}
        </button>
      </div>
    </div>
  );
}

function TextProperties({ el, onUpdate }: { el: TextElement; onUpdate: (id: string, changes: Partial<SlideElement>) => void }) {
  return (
    <>
      <div className="ppt-property-section">
        <div className="ppt-property-section-title">文本内容</div>
        <textarea
          className="ppt-property-input"
          rows={3}
          value={el.content}
          onChange={e => onUpdate(el.id, { content: e.target.value })}
          style={{ resize: 'vertical', fontFamily: 'inherit' }}
        />
      </div>

      <div className="ppt-property-section">
        <div className="ppt-property-section-title">字体</div>
        <div className="ppt-property-row">
          <span className="ppt-property-label">字号</span>
          <input type="number" className="ppt-property-input" value={el.fontSize}
            onChange={e => onUpdate(el.id, { fontSize: parseInt(e.target.value) || 16 })} />
          <span className="ppt-property-label">行高</span>
          <input type="number" className="ppt-property-input" step="0.1" value={el.lineHeight}
            onChange={e => onUpdate(el.id, { lineHeight: parseFloat(e.target.value) || 1.4 })} />
        </div>
        <div className="ppt-property-row">
          <span className="ppt-property-label">字距</span>
          <input type="number" className="ppt-property-input" step="0.5" value={el.letterSpacing}
            onChange={e => onUpdate(el.id, { letterSpacing: parseFloat(e.target.value) || 0 })} />
          <span className="ppt-property-label">圆角</span>
          <input type="number" className="ppt-property-input" value={el.borderRadius}
            onChange={e => onUpdate(el.id, { borderRadius: parseFloat(e.target.value) || 0 })} />
        </div>
        <div className="ppt-property-row">
          <span className="ppt-property-label">内边距</span>
          <input type="number" className="ppt-property-input" value={el.padding}
            onChange={e => onUpdate(el.id, { padding: parseFloat(e.target.value) || 0 })} />
        </div>
      </div>

      <div className="ppt-property-section">
        <div className="ppt-property-section-title">样式</div>
        <div className="ppt-property-row">
          <span className="ppt-property-label">字重</span>
          <div className="ppt-property-btn-group">
            <button className={`ppt-property-btn ${el.fontWeight === 'normal' ? 'active' : ''}`}
              onClick={() => onUpdate(el.id, { fontWeight: 'normal' })}>常规</button>
            <button className={`ppt-property-btn ${el.fontWeight === 'bold' ? 'active' : ''}`}
              onClick={() => onUpdate(el.id, { fontWeight: 'bold' })}>加粗</button>
          </div>
        </div>
        <div className="ppt-property-row">
          <span className="ppt-property-label">样式</span>
          <div className="ppt-property-btn-group">
            <button className={`ppt-property-btn ${el.fontStyle === 'normal' ? 'active' : ''}`}
              onClick={() => onUpdate(el.id, { fontStyle: 'normal' })}>正体</button>
            <button className={`ppt-property-btn ${el.fontStyle === 'italic' ? 'active' : ''}`}
              onClick={() => onUpdate(el.id, { fontStyle: 'italic' })}>斜体</button>
          </div>
        </div>
        <div className="ppt-property-row">
          <span className="ppt-property-label">下划线</span>
          <div className="ppt-property-btn-group">
            <button className={`ppt-property-btn ${el.textDecoration === 'none' ? 'active' : ''}`}
              onClick={() => onUpdate(el.id, { textDecoration: 'none' })}>无</button>
            <button className={`ppt-property-btn ${el.textDecoration === 'underline' ? 'active' : ''}`}
              onClick={() => onUpdate(el.id, { textDecoration: 'underline' })}>有</button>
          </div>
        </div>
        <div className="ppt-property-row">
          <span className="ppt-property-label">对齐</span>
          <div className="ppt-property-btn-group">
            <button className={`ppt-property-btn ${el.textAlign === 'left' ? 'active' : ''}`}
              onClick={() => onUpdate(el.id, { textAlign: 'left' })}>左</button>
            <button className={`ppt-property-btn ${el.textAlign === 'center' ? 'active' : ''}`}
              onClick={() => onUpdate(el.id, { textAlign: 'center' })}>中</button>
            <button className={`ppt-property-btn ${el.textAlign === 'right' ? 'active' : ''}`}
              onClick={() => onUpdate(el.id, { textAlign: 'right' })}>右</button>
          </div>
        </div>
      </div>

      <div className="ppt-property-section">
        <div className="ppt-property-section-title">颜色</div>
        <div className="ppt-property-row">
          <span className="ppt-property-label">文字色</span>
          <input type="color" className="ppt-property-color" value={el.color}
            onChange={e => onUpdate(el.id, { color: e.target.value })} />
          <input type="text" className="ppt-property-input" value={el.color}
            onChange={e => onUpdate(el.id, { color: e.target.value })} />
        </div>
        <div className="ppt-property-row">
          <span className="ppt-property-label">背景色</span>
          <input type="color" className="ppt-property-color"
            value={el.backgroundColor === 'transparent' ? '#ffffff' : el.backgroundColor}
            onChange={e => onUpdate(el.id, { backgroundColor: e.target.value })} />
          <input type="text" className="ppt-property-input" value={el.backgroundColor}
            onChange={e => onUpdate(el.id, { backgroundColor: e.target.value })} />
          <button className="ppt-property-btn" onClick={() => onUpdate(el.id, { backgroundColor: 'transparent' })}>透明</button>
        </div>
      </div>
    </>
  );
}

function ListProperties({ el, onUpdate }: { el: ListElement; onUpdate: (id: string, changes: Partial<SlideElement>) => void }) {
  return (
    <>
      <div className="ppt-property-section">
        <div className="ppt-property-section-title">列表项</div>
        {el.items.map((item, i) => (
          <div key={i} className="ppt-property-row">
            <span className="ppt-property-label">{i + 1}.</span>
            <input type="text" className="ppt-property-input" value={item}
              onChange={e => {
                const items = [...el.items];
                items[i] = e.target.value;
                onUpdate(el.id, { items });
              }} />
            <button className="ppt-property-btn" style={{ flex: '0 0 auto', padding: '4px 8px' }}
              onClick={() => { const items = el.items.filter((_, idx) => idx !== i); onUpdate(el.id, { items }); }}>✕</button>
          </div>
        ))}
        <button className="ppt-property-btn" style={{ marginTop: 4 }}
          onClick={() => onUpdate(el.id, { items: [...el.items, '新项目'] })}>+ 添加项</button>
      </div>

      <div className="ppt-property-section">
        <div className="ppt-property-section-title">样式</div>
        <div className="ppt-property-row">
          <span className="ppt-property-label">字号</span>
          <input type="number" className="ppt-property-input" value={el.fontSize}
            onChange={e => onUpdate(el.id, { fontSize: parseInt(e.target.value) || 16 })} />
          <span className="ppt-property-label">行高</span>
          <input type="number" className="ppt-property-input" step="0.1" value={el.lineHeight}
            onChange={e => onUpdate(el.id, { lineHeight: parseFloat(e.target.value) || 1.8 })} />
        </div>
        <div className="ppt-property-row">
          <span className="ppt-property-label">项目符号</span>
          <select className="ppt-property-select" value={el.bulletStyle}
            onChange={e => onUpdate(el.id, { bulletStyle: e.target.value as ListElement['bulletStyle'] })}>
            <option value="dot">● 圆点</option>
            <option value="number">1. 数字</option>
            <option value="dash">— 破折号</option>
            <option value="arrow">▸ 箭头</option>
          </select>
        </div>
        <div className="ppt-property-row">
          <span className="ppt-property-label">文字色</span>
          <input type="color" className="ppt-property-color" value={el.color}
            onChange={e => onUpdate(el.id, { color: e.target.value })} />
          <span className="ppt-property-label">符号色</span>
          <input type="color" className="ppt-property-color" value={el.bulletColor}
            onChange={e => onUpdate(el.id, { bulletColor: e.target.value })} />
        </div>
      </div>
    </>
  );
}

function ShapeProperties({ el, onUpdate }: { el: ShapeElement; onUpdate: (id: string, changes: Partial<SlideElement>) => void }) {
  const shapes: { value: ShapeKind; label: string }[] = [
    { value: 'rect', label: '矩形' },
    { value: 'rounded', label: '圆角矩形' },
    { value: 'circle', label: '圆形' },
    { value: 'triangle', label: '三角形' },
    { value: 'arrow', label: '箭头' },
    { value: 'line', label: '线条' },
  ];

  return (
    <>
      <div className="ppt-property-section">
        <div className="ppt-property-section-title">形状</div>
        <div className="ppt-property-row">
          <span className="ppt-property-label">类型</span>
          <select className="ppt-property-select" value={el.shape}
            onChange={e => onUpdate(el.id, { shape: e.target.value as ShapeKind })}>
            {shapes.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        </div>
        {el.shape !== 'line' && (
          <>
            <div className="ppt-property-row">
              <span className="ppt-property-label">圆角</span>
              <input type="number" className="ppt-property-input"
                value={el.borderRadius} onChange={e => onUpdate(el.id, { borderRadius: parseFloat(e.target.value) || 0 })} />
            </div>
          </>
        )}
      </div>

      <div className="ppt-property-section">
        <div className="ppt-property-section-title">填充与边框</div>
        <div className="ppt-property-row">
          <span className="ppt-property-label">填充色</span>
          <input type="color" className="ppt-property-color" value={el.fill}
            onChange={e => onUpdate(el.id, { fill: e.target.value })} />
          <input type="text" className="ppt-property-input" value={el.fill}
            onChange={e => onUpdate(el.id, { fill: e.target.value })} />
        </div>
        <div className="ppt-property-row">
          <span className="ppt-property-label">边框色</span>
          <input type="color" className="ppt-property-color" value={el.stroke}
            onChange={e => onUpdate(el.id, { stroke: e.target.value })} />
          <input type="text" className="ppt-property-input" value={el.stroke}
            onChange={e => onUpdate(el.id, { stroke: e.target.value })} />
        </div>
        <div className="ppt-property-row">
          <span className="ppt-property-label">边框宽</span>
          <input type="number" className="ppt-property-input"
            value={el.strokeWidth} onChange={e => onUpdate(el.id, { strokeWidth: parseFloat(e.target.value) || 0 })} />
        </div>
        {el.shape === 'line' && (
          <div className="ppt-property-row">
            <span className="ppt-property-label">线型</span>
            <select className="ppt-property-select" value={el.lineStyle || 'solid'}
              onChange={e => onUpdate(el.id, { lineStyle: e.target.value as ShapeElement['lineStyle'] })}>
              <option value="solid">实线</option>
              <option value="dashed">虚线</option>
              <option value="dotted">点线</option>
            </select>
          </div>
        )}
      </div>
    </>
  );
}

function ImageProperties({ el, onUpdate }: { el: ImageElement; onUpdate: (id: string, changes: Partial<SlideElement>) => void }) {
  const handleImageUpload = async () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const base64 = reader.result as string;
        onUpdate(el.id, { src: base64 });
      };
      reader.readAsDataURL(file);
    };
    input.click();
  };

  return (
    <>
      <div className="ppt-property-section">
        <div className="ppt-property-section-title">图片</div>
        <div className="ppt-property-row">
          <button className="ppt-property-btn" onClick={handleImageUpload}>📁 上传图片</button>
        </div>
        {el.src && (
          <div className="ppt-property-row">
            <img src={el.src} alt="预览" style={{ width: 80, height: 60, objectFit: 'cover', borderRadius: 4 }} />
          </div>
        )}
      </div>

      <div className="ppt-property-section">
        <div className="ppt-property-section-title">样式</div>
        <div className="ppt-property-row">
          <span className="ppt-property-label">适应方式</span>
          <select className="ppt-property-select" value={el.objectFit}
            onChange={e => onUpdate(el.id, { objectFit: e.target.value as ImageElement['objectFit'] })}>
            <option value="cover">覆盖</option>
            <option value="contain">包含</option>
            <option value="fill">填充</option>
          </select>
        </div>
        <div className="ppt-property-row">
          <span className="ppt-property-label">圆角</span>
          <input type="number" className="ppt-property-input"
            value={el.borderRadius} onChange={e => onUpdate(el.id, { borderRadius: parseFloat(e.target.value) || 0 })} />
        </div>
        <div className="ppt-property-row">
          <span className="ppt-property-label">Alt</span>
          <input type="text" className="ppt-property-input" value={el.alt || ''}
            onChange={e => onUpdate(el.id, { alt: e.target.value })} />
        </div>
      </div>
    </>
  );
}