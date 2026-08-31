/**
 * SlideCanvas — PPT 可视化编辑器核心画布组件
 *
 * 功能:
 * 1. 绝对定位渲染所有 SlideElement
 * 2. 单击选中 / Shift+单击多选 / 拖拽框选
 * 3. 拖拽移动元素
 * 4. 8 方向缩放手柄
 * 5. 双击文本元素进入内联编辑
 * 6. 键盘快捷键: Delete 删除, Ctrl+D 复制, 方向键微调
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  type SlideElement,
  type TextElement,
  type ShapeElement,
  type ListElement,
  type ImageElement,
  type V2Slide,
  type PPTTheme,
  elementToStyle,
} from '../../core/knowledge/ppt-types';
import './ppt-editor.css';
import { renderMath, hasMath } from '../../core/knowledge/ppt-math';

// ========== 缩放手柄 ==========

export type ResizeHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

interface HandleDef {
  id: ResizeHandle;
  cursor: string;
  style: React.CSSProperties;
}

const HANDLES: HandleDef[] = [
  { id: 'nw', cursor: 'nwse-resize', style: { left: '-5px', top: '-5px', cursor: 'nwse-resize' } },
  { id: 'n',  cursor: 'ns-resize',  style: { left: '50%', top: '-5px', transform: 'translateX(-50%)', cursor: 'ns-resize' } },
  { id: 'ne', cursor: 'nesw-resize', style: { right: '-5px', top: '-5px', cursor: 'nesw-resize' } },
  { id: 'e',  cursor: 'ew-resize',  style: { right: '-5px', top: '50%', transform: 'translateY(-50%)', cursor: 'ew-resize' } },
  { id: 'se', cursor: 'nwse-resize', style: { right: '-5px', bottom: '-5px', cursor: 'nwse-resize' } },
  { id: 's',  cursor: 'ns-resize',  style: { left: '50%', bottom: '-5px', transform: 'translateX(-50%)', cursor: 'ns-resize' } },
  { id: 'sw', cursor: 'nesw-resize', style: { left: '-5px', bottom: '-5px', cursor: 'nesw-resize' } },
  { id: 'w',  cursor: 'ew-resize',  style: { left: '-5px', top: '50%', transform: 'translateY(-50%)', cursor: 'ew-resize' } },
];

// ========== 拖拽状态 ==========

interface DragState {
  type: 'move' | 'resize';
  handle?: ResizeHandle;
  startX: number;      // 鼠标起始位置 (画布坐标, px)
  startY: number;
  /** 拖拽开始时每个选中元素的快照 */
  snapshots: { id: string; x: number; y: number; width: number; height: number }[];
}

interface MarqueeState {
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
}

// ========== Props ==========

export interface SlideCanvasProps {
  slide: V2Slide;
  theme: PPTTheme;
  canvasWidth?: number;
  canvasHeight?: number;
  selectedIds: Set<string>;
  editingId: string | null;
  onSelect: (ids: Set<string>, additive: boolean) => void;
  onEditingChange: (id: string | null) => void;
  onElementsUpdate: (updates: { id: string; changes: Partial<SlideElement> }[]) => void;
  onElementEdit: (id: string, newContent: string) => void;
  onDeleteSelected: () => void;
  onDuplicateSelected: () => void;
  /** 注册外部命令 (用于工具栏触发) */
  registerCommands?: (cmds: CanvasCommands) => void;
  /** 演示模式 — 自动播放元素入场动画 */
  presentationMode?: boolean;
  /** 演示模式动画 key (变化时重新触发动画) */
  animationKey?: number;
}

export interface CanvasCommands {
  alignSelected: (align: 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom') => void;
  bringForward: () => void;
  sendBackward: () => void;
  bringToFront: () => void;
  sendToBack: () => void;
}

// ========== 组件 ==========

export function SlideCanvas({
  slide,
  theme,
  canvasWidth = 1280,
  canvasHeight = 720,
  selectedIds,
  editingId,
  onSelect,
  onEditingChange,
  onElementsUpdate,
  onElementEdit,
  onDeleteSelected,
  onDuplicateSelected,
  registerCommands,
  presentationMode = false,
  animationKey = 0,
}: SlideCanvasProps) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const [dragState, setDragState] = useState<DragState | null>(null);
  const [marquee, setMarquee] = useState<MarqueeState | null>(null);
  const [liveElements, setLiveElements] = useState<Map<string, { x: number; y: number; width: number; height: number }>>(new Map());
  // 实际渲染尺寸（用于 CSS transform scale 整体缩放）
  const [renderWidth, setRenderWidth] = useState(canvasWidth);
  const scale = renderWidth / canvasWidth;

  // 监听画布外层容器实际尺寸，计算 transform scale
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const updateWidth = () => setRenderWidth(el.offsetWidth);
    updateWidth();
    const ro = new ResizeObserver(() => updateWidth());
    ro.observe(el);
    if (el.parentElement) ro.observe(el.parentElement);
    return () => ro.disconnect();
  }, []);

  // 更新 live positions 当 dragState 开始时
  useEffect(() => {
    if (dragState) {
      const map = new Map<string, { x: number; y: number; width: number; height: number }>();
      dragState.snapshots.forEach(s => map.set(s.id, { x: s.x, y: s.y, width: s.width, height: s.height }));
      setLiveElements(map);
    } else {
      setLiveElements(new Map());
    }
  }, [dragState]);

  // 获取画布矩形
  const getCanvasRect = useCallback((): DOMRect | null => {
    return canvasRef.current?.getBoundingClientRect() ?? null;
  }, []);

  // 将鼠标坐标转换为画布百分比坐标
  const toPercent = useCallback((clientX: number, clientY: number) => {
    const rect = getCanvasRect();
    if (!rect) return { px: 0, py: 0 };
    const px = ((clientX - rect.left) / rect.width) * 100;
    const py = ((clientY - rect.top) / rect.height) * 100;
    return { px, py };
  }, [getCanvasRect]);

  // ====== 元素点击 ======
  const handleElementMouseDown = useCallback((e: React.MouseEvent, elementId: string) => {
    // 如果正在编辑此元素, 不阻止
    if (editingId === elementId) return;

    e.stopPropagation();
    const additive = e.shiftKey;

    let newSelected: Set<string>;
    if (additive) {
      newSelected = new Set(selectedIds);
      if (newSelected.has(elementId)) {
        newSelected.delete(elementId);
      } else {
        newSelected.add(elementId);
      }
    } else if (selectedIds.has(elementId) && selectedIds.size > 0) {
      // 已选中且非追加 — 保持选中, 准备拖拽
      newSelected = selectedIds;
    } else {
      newSelected = new Set([elementId]);
    }
    onSelect(newSelected, additive);

    // 准备拖拽
    const { px, py } = toPercent(e.clientX, e.clientY);
    const snapshots = slide.elements
      .filter(el => newSelected.has(el.id))
      .map(el => ({ id: el.id, x: el.x, y: el.y, width: el.width, height: el.height }));

    setDragState({
      type: 'move',
      startX: px,
      startY: py,
      snapshots,
    });
  }, [editingId, selectedIds, onSelect, slide.elements, toPercent]);

  // ====== 缩放手柄 ======
  const handleResizeMouseDown = useCallback((e: React.MouseEvent, handle: ResizeHandle) => {
    e.stopPropagation();
    e.preventDefault();

    const { px, py } = toPercent(e.clientX, e.clientY);
    const snapshots = slide.elements
      .filter(el => selectedIds.has(el.id))
      .map(el => ({ id: el.id, x: el.x, y: el.y, width: el.width, height: el.height }));

    setDragState({
      type: 'resize',
      handle,
      startX: px,
      startY: py,
      snapshots,
    });
  }, [selectedIds, slide.elements, toPercent]);

  // ====== 画布空白点击 ======
  const handleCanvasMouseDown = useCallback((e: React.MouseEvent) => {
    if (editingId) {
      onEditingChange(null);
      return;
    }
    // 开始框选
    const { px, py } = toPercent(e.clientX, e.clientY);
    onSelect(new Set(), false);
    setMarquee({ startX: px, startY: py, currentX: px, currentY: py });
  }, [editingId, onEditingChange, onSelect, toPercent]);

  // ====== 全局鼠标移动 ======
  useEffect(() => {
    if (!dragState && !marquee) return;

    const handleMove = (e: MouseEvent) => {
      const { px, py } = toPercent(e.clientX, e.clientY);

      if (dragState) {
        const dx = px - dragState.startX;
        const dy = py - dragState.startY;
        const newLive = new Map<string, { x: number; y: number; width: number; height: number }>();

        dragState.snapshots.forEach(snap => {
          if (dragState.type === 'move') {
            newLive.set(snap.id, {
              x: snap.x + dx,
              y: snap.y + dy,
              width: snap.width,
              height: snap.height,
            });
          } else if (dragState.type === 'resize') {
            const h = dragState.handle!;
            let { x, y, width, height } = snap;

            // 根据手柄方向调整
            if (h.includes('e')) width = Math.max(2, snap.width + dx);
            if (h.includes('s')) height = Math.max(2, snap.height + dy);
            if (h.includes('w')) {
              const newWidth = Math.max(2, snap.width - dx);
              x = snap.x + (snap.width - newWidth);
              width = newWidth;
            }
            if (h.includes('n')) {
              const newHeight = Math.max(2, snap.height - dy);
              y = snap.y + (snap.height - newHeight);
              height = newHeight;
            }

            newLive.set(snap.id, { x, y, width, height });
          }
        });

        setLiveElements(newLive);
      }

      if (marquee) {
        setMarquee({ ...marquee, currentX: px, currentY: py });
      }
    };

    const handleUp = () => {
      if (dragState) {
        // 提交更新
        const updates: { id: string; changes: Partial<SlideElement> }[] = [];
        dragState.snapshots.forEach(snap => {
          const live = liveElementsRef.current.get(snap.id);
          if (live && (live.x !== snap.x || live.y !== snap.y || live.width !== snap.width || live.height !== snap.height)) {
            updates.push({
              id: snap.id,
              changes: { x: live.x, y: live.y, width: live.width, height: live.height },
            });
          }
        });
        if (updates.length > 0) {
          onElementsUpdate(updates);
        }
        setDragState(null);
      }

      if (marquee) {
        // 计算框选范围内的元素
        const minX = Math.min(marquee.startX, marquee.currentX);
        const maxX = Math.max(marquee.startX, marquee.currentX);
        const minY = Math.min(marquee.startY, marquee.currentY);
        const maxY = Math.max(marquee.startY, marquee.currentY);

        if (Math.abs(maxX - minX) > 1 && Math.abs(maxY - minY) > 1) {
          const hitIds = slide.elements
            .filter(el => {
              const cx = el.x + el.width / 2;
              const cy = el.y + el.height / 2;
              return cx >= minX && cx <= maxX && cy >= minY && cy <= maxY;
            })
            .map(el => el.id);
          if (hitIds.length > 0) {
            onSelect(new Set(hitIds), false);
          }
        }
        setMarquee(null);
      }
    };

    document.addEventListener('mousemove', handleMove);
    document.addEventListener('mouseup', handleUp);
    return () => {
      document.removeEventListener('mousemove', handleMove);
      document.removeEventListener('mouseup', handleUp);
    };
  }, [dragState, marquee, toPercent, onElementsUpdate, onSelect, slide.elements]);

  // 保持 liveElements 的 ref (用于 mouseup 回调)
  const liveElementsRef = useRef(liveElements);
  liveElementsRef.current = liveElements;

  // ====== 键盘快捷键 ======
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (editingId) return; // 编辑中不处理快捷键
      if (selectedIds.size === 0 && !['Escape'].includes(e.key)) return;

      switch (e.key) {
        case 'Delete':
        case 'Backspace':
          e.preventDefault();
          onDeleteSelected();
          break;
        case 'd':
        case 'D':
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            onDuplicateSelected();
          }
          break;
        case 'Escape':
          onSelect(new Set(), false);
          onEditingChange(null);
          break;
        case 'ArrowLeft':
        case 'ArrowRight':
        case 'ArrowUp':
        case 'ArrowDown': {
          e.preventDefault();
          const step = e.shiftKey ? 5 : 1;
          const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
          const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
          const updates = slide.elements
            .filter(el => selectedIds.has(el.id))
            .map(el => ({ id: el.id, changes: { x: el.x + dx, y: el.y + dy } as Partial<SlideElement> }));
          if (updates.length > 0) onElementsUpdate(updates);
          break;
        }
      }
    };

    const canvas = canvasRef.current;
    if (canvas) {
      canvas.addEventListener('keydown', handleKeyDown);
      return () => canvas.removeEventListener('keydown', handleKeyDown);
    }
  }, [editingId, selectedIds, slide.elements, onDeleteSelected, onDuplicateSelected, onSelect, onEditingChange, onElementsUpdate]);

  // ====== 对齐命令 ======
  const alignSelected = useCallback((align: 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom') => {
    if (selectedIds.size < 2) return;
    const selected = slide.elements.filter(el => selectedIds.has(el.id));
    const updates: { id: string; changes: Partial<SlideElement> }[] = [];

    switch (align) {
      case 'left':
        const minX = Math.min(...selected.map(el => el.x));
        selected.forEach(el => updates.push({ id: el.id, changes: { x: minX } }));
        break;
      case 'right':
        const maxX = Math.max(...selected.map(el => el.x + el.width));
        selected.forEach(el => updates.push({ id: el.id, changes: { x: maxX - el.width } }));
        break;
      case 'center':
        selected.forEach(el => {
          const centerX = selected.reduce((sum, e) => sum + e.x + e.width / 2, 0) / selected.length;
          updates.push({ id: el.id, changes: { x: centerX - el.width / 2 } });
        });
        break;
      case 'top':
        const minY = Math.min(...selected.map(el => el.y));
        selected.forEach(el => updates.push({ id: el.id, changes: { y: minY } }));
        break;
      case 'bottom':
        const maxY = Math.max(...selected.map(el => el.y + el.height));
        selected.forEach(el => updates.push({ id: el.id, changes: { y: maxY - el.height } }));
        break;
      case 'middle':
        selected.forEach(el => {
          const centerY = selected.reduce((sum, e) => sum + e.y + e.height / 2, 0) / selected.length;
          updates.push({ id: el.id, changes: { y: centerY - el.height / 2 } });
        });
        break;
    }
    if (updates.length > 0) onElementsUpdate(updates);
  }, [selectedIds, slide.elements, onElementsUpdate]);

  // 计算元素入场动画样式 (演示模式)
  const getElementAnimStyle = (el: SlideElement): React.CSSProperties => {
    if (!presentationMode || !el.animation || el.animation.type === 'none') return {};
    const animName = `ppt-anim-${el.animation.type}`;
    return {
      animation: `${animName} ${el.animation.duration}ms ease-out ${el.animation.delay}ms both`,
    };
  };

  // 计算元素位置/尺寸样式
  const getElementStyle = (el: SlideElement): React.CSSProperties => {
    const live = liveElements.get(el.id);
    const renderEl: SlideElement = live ? { ...el, x: live.x, y: live.y, width: live.width, height: live.height } : el;
    const style = elementToStyle(renderEl, canvasWidth, canvasHeight);
    return style;
  };

  // ====== 层级命令 ======
  const bringForward = useCallback(() => {
    const updates = slide.elements
      .filter(el => selectedIds.has(el.id))
      .map(el => ({ id: el.id, changes: { zIndex: el.zIndex + 1 } as Partial<SlideElement> }));
    if (updates.length > 0) onElementsUpdate(updates);
  }, [slide.elements, selectedIds, onElementsUpdate]);

  const sendBackward = useCallback(() => {
    const updates = slide.elements
      .filter(el => selectedIds.has(el.id))
      .map(el => ({ id: el.id, changes: { zIndex: Math.max(0, el.zIndex - 1) } as Partial<SlideElement> }));
    if (updates.length > 0) onElementsUpdate(updates);
  }, [slide.elements, selectedIds, onElementsUpdate]);

  const bringToFront = useCallback(() => {
    const maxZ = Math.max(...slide.elements.map(el => el.zIndex), 0);
    const updates = slide.elements
      .filter(el => selectedIds.has(el.id))
      .map((el, i) => ({ id: el.id, changes: { zIndex: maxZ + 1 + i } as Partial<SlideElement> }));
    if (updates.length > 0) onElementsUpdate(updates);
  }, [slide.elements, selectedIds, onElementsUpdate]);

  const sendToBack = useCallback(() => {
    const minZ = Math.min(...slide.elements.map(el => el.zIndex), 0);
    const updates = slide.elements
      .filter(el => selectedIds.has(el.id))
      .map((el, i) => ({ id: el.id, changes: { zIndex: minZ - 1 - i } as Partial<SlideElement> }));
    if (updates.length > 0) onElementsUpdate(updates);
  }, [slide.elements, selectedIds, onElementsUpdate]);

  // 注册外部命令
  useEffect(() => {
    if (registerCommands) {
      registerCommands({ alignSelected, bringForward, sendBackward, bringToFront, sendToBack });
    }
  }, [registerCommands, alignSelected, bringForward, sendBackward, bringToFront, sendToBack]);

  // ====== 双击进入编辑 ======
  const handleDoubleClick = useCallback((e: React.MouseEvent, elementId: string) => {
    e.stopPropagation();
    const el = slide.elements.find(e => e.id === elementId);
    if (el && (el.type === 'text' || el.type === 'list')) {
      onSelect(new Set([elementId]), false);
      onEditingChange(elementId);
    }
  }, [slide.elements, onSelect, onEditingChange]);

  // renderElement 已移除 — 编辑模式逻辑已内联到下方渲染路径中

  const renderElementContent = (el: SlideElement) => {
    switch (el.type) {
      case 'shape': {
        const s = el as ShapeElement;
        if (s.shape === 'triangle') {
          return (
            <svg width="100%" height="100%" viewBox="0 0 100 100" preserveAspectRatio="none">
              <polygon points="50,0 100,100 0,100" fill={s.fill} stroke={s.stroke} strokeWidth={s.strokeWidth} />
            </svg>
          );
        }
        if (s.shape === 'arrow') {
          return (
            <svg width="100%" height="100%" viewBox="0 0 100 100" preserveAspectRatio="none">
              <defs>
                <marker id={`arrow-${el.id}`} markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto">
                  <polygon points="0 0, 10 5, 0 10" fill={s.stroke !== 'transparent' ? s.stroke : s.fill} />
                </marker>
              </defs>
              <line x1="5" y1="50" x2="85" y2="50" stroke={s.stroke !== 'transparent' ? s.stroke : s.fill} strokeWidth={Math.max(2, s.strokeWidth)} markerEnd={`url(#arrow-${el.id})`} />
            </svg>
          );
        }
        if (s.shape === 'line') {
          return (
            <svg width="100%" height="100%" preserveAspectRatio="none">
              <line x1="0" y1="50%" x2="100%" y2="50%" stroke={s.stroke !== 'transparent' ? s.stroke : s.fill} strokeWidth={Math.max(1, s.strokeWidth)} strokeDasharray={s.lineStyle === 'dashed' ? '8,4' : s.lineStyle === 'dotted' ? '2,2' : undefined} />
            </svg>
          );
        }
        return null; // rect, rounded, circle 由 CSS border-radius 处理
      }
      case 'image': {
        const img = el as ImageElement;
        if (!img.src) {
          return (
            <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f0f0f0', color: '#999', fontSize: 'var(--fs-md)' }}>
              点击属性面板上传图片
            </div>
          );
        }
        return <img src={img.src} alt={img.alt || ''} style={{ width: '100%', height: '100%', objectFit: img.objectFit, borderRadius: img.borderRadius }} />;
      }
      case 'list': {
        const list = el as ListElement;
        const bullet = list.bulletStyle === 'number' ? 'decimal' :
          list.bulletStyle === 'dash' ? '"— "' :
          list.bulletStyle === 'arrow' ? '"▸ "' : 'disc';
        return (
          <ul style={{ listStyle: bullet, padding: '0 0 0 24px', margin: 0, width: '100%' }}>
            {list.items.map((item, i) => (
              <li key={i} style={{ color: list.color, marginBottom: 4 }}>
                {item}
              </li>
            ))}
          </ul>
        );
      }
      case 'text':
      default:
        return null; // text 内容由 dangerouslySetInnerHTML 在渲染时处理
    }
  };

  // 文本元素需要特殊处理内容
  const renderTextContent = (el: TextElement) => {
    let html = el.content.replace(/\n/g, '<br>');
    // 如果包含数学公式，渲染 KaTeX
    if (hasMath(el.content)) {
      html = renderMath(html);
    }
    return html;
  };

  // ====== 选区框选 ======
  const renderMarquee = () => {
    if (!marquee) return null;
    const minX = Math.min(marquee.startX, marquee.currentX);
    const minY = Math.min(marquee.startY, marquee.currentY);
    const w = Math.abs(marquee.currentX - marquee.startX);
    const h = Math.abs(marquee.currentY - marquee.startY);
    return (
      <div
        style={{
          position: 'absolute',
          left: `${minX}%`,
          top: `${minY}%`,
          width: `${w}%`,
          height: `${h}%`,
          border: '1px solid #7c6cf0',
          background: 'rgba(124, 108, 240, 0.1)',
          pointerEvents: 'none',
          zIndex: 9999,
        }}
      />
    );
  };

  // ====== 选中元素的缩放手柄 ======
  const renderSelectionHandles = () => {
    if (selectedIds.size === 0 || dragState?.type === 'move') return null;

    return slide.elements
      .filter(el => selectedIds.has(el.id))
      .map(el => {
        const live = liveElements.get(el.id);
        const x = live?.x ?? el.x;
        const y = live?.y ?? el.y;
        const w = live?.width ?? el.width;
        const h = live?.height ?? el.height;

        return (
          <div
            key={`sel-${el.id}`}
            style={{
              position: 'absolute',
              left: `${x}%`,
              top: `${y}%`,
              width: `${w}%`,
              height: `${h}%`,
              border: '2px solid #7c6cf0',
              pointerEvents: 'none',
              zIndex: 10000,
            }}
          >
            {HANDLES.map(h => (
              <div
                key={h.id}
                style={{
                  position: 'absolute',
                  width: 10,
                  height: 10,
                  background: '#fff',
                  border: '2px solid #7c6cf0',
                  borderRadius: 2,
                  pointerEvents: 'auto',
                  cursor: h.cursor,
                  ...h.style,
                }}
                onMouseDown={(e) => handleResizeMouseDown(e, h.id)}
              />
            ))}
          </div>
        );
      });
  };

  return (
    <div
      ref={canvasRef}
      className="ppt-slide-canvas"
      style={{
        width: '100%',
        height: '100%',
        position: 'relative',
        background: slide.background,
        overflow: 'hidden',
        borderRadius: presentationMode ? 0 : 8,
        boxShadow: presentationMode ? 'none' : '0 4px 24px rgba(0,0,0,0.15)',
        outline: 'none',
      }}
      tabIndex={0}
      onMouseDown={handleCanvasMouseDown}
    >
      {/* transform 层：按设计尺寸渲染，整体 scale 到实际尺寸 */}
      <div style={{
        width: canvasWidth,
        height: canvasHeight,
        position: 'relative',
        transform: `scale(${scale})`,
        transformOrigin: 'top left',
        flexShrink: 0,
      }}>
      {/* 渲染所有元素 */}
      {slide.elements
        .slice()
        .sort((a, b) => a.zIndex - b.zIndex)
        .map(el => {
          const isSelected = selectedIds.has(el.id);
          const isEditing = editingId === el.id;
          const style = getElementStyle(el);
          const animStyle = getElementAnimStyle(el);

          // 编辑模式: text → contentEditable
          if (isEditing && el.type === 'text') {
            return (
              <div
                key={`${el.id}-${animationKey}`}
                style={{
                  ...style,
                  outline: '2px solid #7c6cf0',
                  cursor: 'text',
                  userSelect: 'text',
                }}
                contentEditable
                suppressContentEditableWarning
                dangerouslySetInnerHTML={{ __html: escapeHtml((el as TextElement).content).replace(/\n/g, '<br>') }}
                onBlur={(e) => {
                  const text = e.currentTarget.innerText;
                  onElementEdit(el.id, text);
                  onEditingChange(null);
                }}
                onMouseDown={(e) => e.stopPropagation()}
                autoFocus
              />
            );
          }

          // 编辑模式: list → contentEditable
          if (isEditing && el.type === 'list') {
            const listEl = el as ListElement;
            return (
              <div
                key={`${el.id}-${animationKey}`}
                style={{
                  ...style,
                  outline: '2px solid #7c6cf0',
                  cursor: 'text',
                  userSelect: 'text',
                }}
                contentEditable
                suppressContentEditableWarning
                dangerouslySetInnerHTML={{
                  __html: listEl.items.map(item => `<div>${escapeHtml(item)}</div>`).join(''),
                }}
                onBlur={(e) => {
                  const lines = e.currentTarget.innerText.split('\n').filter((l: string) => l.trim());
                  onElementEdit(el.id, JSON.stringify(lines));
                  onEditingChange(null);
                }}
                onMouseDown={(e) => e.stopPropagation()}
                autoFocus
              />
            );
          }

          // 文本元素非编辑模式: 用 dangerouslySetInnerHTML 渲染内容
          if (el.type === 'text') {
            return (
              <div
                key={`${el.id}-${animationKey}`}
                style={{
                  ...style,
                  ...animStyle,
                  cursor: 'move',
                  outline: isSelected ? '2px solid #7c6cf0' : 'none',
                }}
                onMouseDown={(e) => handleElementMouseDown(e, el.id)}
                onDoubleClick={(e) => handleDoubleClick(e, el.id)}
                dangerouslySetInnerHTML={{ __html: renderTextContent(el as TextElement) }}
              />
            );
          }

          // 其他元素类型 (shape, image, list 非编辑模式)
          return (
            <div
              key={`${el.id}-${animationKey}`}
              style={{
                ...style,
                ...animStyle,
                cursor: 'move',
                outline: isSelected ? '2px solid #7c6cf0' : 'none',
                outlineOffset: isSelected ? '0px' : undefined,
              }}
              onMouseDown={(e) => handleElementMouseDown(e, el.id)}
              onDoubleClick={(e) => handleDoubleClick(e, el.id)}
            >
              {renderElementContent(el)}
            </div>
          );
        })}

      {/* 框选 */}
      {renderMarquee()}

      {/* 选中手柄 */}
      {renderSelectionHandles()}
      </div>
    </div>
  );
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
