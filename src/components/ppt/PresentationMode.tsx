/**
 * PresentationMode — 全屏演示模式
 *
 * 功能:
 * - 全屏播放幻灯片
 * - 键盘左右键 / 空格 / 回车 切换
 * - ESC 退出
 * - 点击右半边下一页，左半边上一页
 * - 页面过渡动画 (淡入/滑动/缩放)
 * - 底部控制栏 (悬停显示)
 * - 页码指示器
 * - 演讲者备注显示 (可选)
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { type V2SlideDeck, type V2Slide, type PPTTheme } from '../../core/knowledge/ppt-types';
import { SlideCanvas } from './SlideCanvas';

export type TransitionType = 'fade' | 'slide' | 'zoom' | 'flip' | 'none';

const TRANSITIONS: Record<TransitionType, { label: string; icon: string }> = {
  fade: { label: '淡入', icon: '🌫️' },
  slide: { label: '滑动', icon: '➡️' },
  zoom: { label: '缩放', icon: '🔍' },
  flip: { label: '翻转', icon: '🔄' },
  none: { label: '无', icon: '⏭️' },
};

export interface PresentationModeProps {
  deck: V2SlideDeck;
  startIndex?: number;
  onExit: () => void;
}

export function PresentationMode({ deck, startIndex = 0, onExit }: PresentationModeProps) {
  const [currentIndex, setCurrentIndex] = useState(startIndex);
  const [direction, setDirection] = useState<'next' | 'prev'>('next');
  const [animating, setAnimating] = useState(false);
  const [showNotes, setShowNotes] = useState(false);
  const [transition, setTransition] = useState<TransitionType>('fade');
  const containerRef = useRef<HTMLDivElement>(null);
  // 计算实际可用的画布尺寸（保持宽高比，不超出容器）
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });

  const totalSlides = deck.slides.length;
  const currentSlide = deck.slides[currentIndex];

  const goNext = useCallback(() => {
    if (currentIndex < totalSlides - 1) {
      setDirection('next');
      setAnimating(true);
      setTimeout(() => {
        setCurrentIndex(prev => Math.min(totalSlides - 1, prev + 1));
        setAnimating(false);
      }, 300);
    }
  }, [currentIndex, totalSlides]);

  const goPrev = useCallback(() => {
    if (currentIndex > 0) {
      setDirection('prev');
      setAnimating(true);
      setTimeout(() => {
        setCurrentIndex(prev => Math.max(0, prev - 1));
        setAnimating(false);
      }, 300);
    }
  }, [currentIndex]);

  const goTo = useCallback((index: number) => {
    if (index >= 0 && index < totalSlides && index !== currentIndex) {
      setDirection(index > currentIndex ? 'next' : 'prev');
      setAnimating(true);
      setTimeout(() => {
        setCurrentIndex(index);
        setAnimating(false);
      }, 300);
    }
  }, [currentIndex, totalSlides]);

  // 键盘控制
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowRight':
        case ' ':
        case 'Enter':
          e.preventDefault();
          goNext();
          break;
        case 'ArrowLeft':
        case 'Backspace':
          e.preventDefault();
          goPrev();
          break;
        case 'Escape':
          e.preventDefault();
          onExit();
          break;
        case 'n':
        case 'N':
          setShowNotes(prev => !prev);
          break;
        case 'Home':
          e.preventDefault();
          goTo(0);
          break;
        case 'End':
          e.preventDefault();
          goTo(totalSlides - 1);
          break;
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [goNext, goPrev, goTo, onExit, totalSlides]);

  // 计算实际可用的画布尺寸（保持宽高比，不超出容器）
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const calc = () => {
      const cw = el.clientWidth;
      const ch = el.clientHeight;
      const ratio = deck.canvasWidth / deck.canvasHeight;
      let w = cw;
      let h = cw / ratio;
      if (h > ch) {
        h = ch;
        w = ch * ratio;
      }
      setCanvasSize({ width: Math.round(w), height: Math.round(h) });
    };
    calc();
    const ro = new ResizeObserver(calc);
    ro.observe(el);
    return () => ro.disconnect();
  }, [deck.canvasWidth, deck.canvasHeight]);

  // 计算过渡动画样式
  const getTransitionStyle = (): React.CSSProperties => {
    if (!animating) return {};
    const enter = direction === 'next';
    switch (transition) {
      case 'fade':
        return { animation: `ppt-fade-in 0.3s ease-out` };
      case 'slide':
        return { animation: `ppt-slide-${enter ? 'in-right' : 'in-left'} 0.3s ease-out` };
      case 'zoom':
        return { animation: `ppt-zoom-in 0.3s ease-out` };
      case 'flip':
        return { animation: `ppt-flip-in 0.4s ease-out` };
      default:
        return {};
    }
  };

  return (
    <div
      className="ppt-present-mode"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          if (e.clientX > window.innerWidth / 2) goNext();
          else goPrev();
        }
      }}
      style={{ position: 'fixed', inset: 0, zIndex: 99999, background: '#000' }}
    >
      {/* 幻灯片画布 */}
      <div ref={containerRef} style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative', overflow: 'hidden' }}>
        {canvasSize.width > 0 && (
        <div key={currentIndex} style={{
          width: canvasSize.width,
          height: canvasSize.height,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          ...getTransitionStyle(),
        }}>
          <SlideCanvas
            slide={currentSlide}
            theme={deck.theme}
            canvasWidth={deck.canvasWidth}
            canvasHeight={deck.canvasHeight}
            selectedIds={new Set()}
            editingId={null}
            onSelect={() => {}}
            onEditingChange={() => {}}
            onElementsUpdate={() => {}}
            onElementEdit={() => {}}
            onDeleteSelected={() => {}}
            onDuplicateSelected={() => {}}
            presentationMode
            animationKey={currentIndex}
          />
        </div>
        )}
      </div>

      {/* 演讲者备注 (按 N 切换) */}
      {showNotes && currentSlide.notes && (
        <div style={{
          position: 'fixed', bottom: 60, left: '50%', transform: 'translateX(-50%)',
          maxWidth: 600, padding: '12px 20px', background: 'rgba(0,0,0,0.85)',
          borderRadius: 10, color: '#e0e0e0', fontSize: 14, lineHeight: 1.6,
          border: '1px solid rgba(255,255,255,0.1)',
          backdropFilter: 'blur(8px)',
        }}>
          <div style={{ fontSize: 11, color: '#888', marginBottom: 4 }}>演讲备注</div>
          {currentSlide.notes}
        </div>
      )}

      {/* 页码指示器 */}
      <div style={{
        position: 'fixed', bottom: 16, left: '50%', transform: 'translateX(-50%)',
        display: 'flex', gap: 4, alignItems: 'center',
        background: 'rgba(0,0,0,0.5)', padding: '4px 12px', borderRadius: 12,
      }}>
        <span style={{ color: '#fff', fontSize: 12 }}>
          {currentIndex + 1} / {totalSlides}
        </span>
      </div>

      {/* 底部控制栏 */}
      <div className="ppt-present-controls" style={{
        position: 'fixed', bottom: 40, left: '50%', transform: 'translateX(-50%)',
        display: 'flex', gap: 8, alignItems: 'center',
        background: 'rgba(0,0,0,0.7)', padding: '8px 16px', borderRadius: 24,
        opacity: 0, transition: 'opacity 0.3s',
        backdropFilter: 'blur(12px)',
      }}
      onMouseEnter={e => (e.currentTarget.style.opacity = '1')}
      onMouseLeave={e => (e.currentTarget.style.opacity = '0')}
      >
        <button className="ppt-present-btn" onClick={goPrev} disabled={currentIndex === 0} style={{
          background: 'rgba(255,255,255,0.15)', border: 'none', color: '#fff',
          width: 36, height: 36, borderRadius: '50%', cursor: 'pointer', fontSize: 16,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          opacity: currentIndex === 0 ? 0.3 : 1, transition: 'background 0.15s',
        }}>◀</button>

        {/* 过渡效果选择 */}
        <select value={transition} onChange={e => setTransition(e.target.value as TransitionType)} style={{
          background: 'rgba(255,255,255,0.1)', border: 'none', color: '#fff',
          padding: '4px 8px', borderRadius: 4, fontSize: 12, cursor: 'pointer',
        }}>
          {Object.entries(TRANSITIONS).map(([key, val]) => (
            <option key={key} value={key} style={{ background: '#333' }}>{val.label}</option>
          ))}
        </select>

        {/* 备注 toggle */}
        <button onClick={() => setShowNotes(!showNotes)} style={{
          background: showNotes ? 'var(--accent, rgba(124,108,240,0.5))' : 'rgba(255,255,255,0.15)',
          border: 'none', color: '#fff', padding: '6px 10px', borderRadius: 4, cursor: 'pointer', fontSize: 12,
          transition: 'background 0.15s',
        }}>备注</button>

        {/* 退出 */}
        <button onClick={onExit} style={{
          background: 'rgba(255,255,255,0.15)', border: 'none', color: '#fff',
          padding: '6px 12px', borderRadius: 4, cursor: 'pointer', fontSize: 12,
          transition: 'background 0.15s',
        }}>✕ 退出</button>

        <button className="ppt-present-btn" onClick={goNext} disabled={currentIndex === totalSlides - 1} style={{
          background: 'rgba(255,255,255,0.15)', border: 'none', color: '#fff',
          width: 36, height: 36, borderRadius: '50%', cursor: 'pointer', fontSize: 16,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          opacity: currentIndex === totalSlides - 1 ? 0.3 : 1, transition: 'background 0.15s',
        }}>▶</button>
      </div>

      {/* 进度条 */}
      <div style={{
        position: 'fixed', bottom: 0, left: 0, width: '100%', height: 3,
        background: 'rgba(255,255,255,0.1)',
      }}>
        <div style={{
          width: `${((currentIndex + 1) / totalSlides) * 100}%`, height: '100%',
          background: 'var(--accent, #7c6cf0)',
          transition: 'width 0.3s ease',
        }} />
      </div>

      {/* 过渡动画 keyframes */}
      <style>{`
        @keyframes ppt-fade-in { from { opacity: 0; } to { opacity: 1; } }
        @keyframes ppt-slide-in-right { from { transform: translateX(100%); } to { transform: translateX(0); } }
        @keyframes ppt-slide-in-left { from { transform: translateX(-100%); } to { transform: translateX(0); } }
        @keyframes ppt-zoom-in { from { transform: scale(0.9); opacity: 0; } to { transform: scale(1); opacity: 1; } }
        @keyframes ppt-flip-in { from { transform: rotateY(90deg); opacity: 0; } to { transform: rotateY(0); opacity: 1; } }
      `}</style>
    </div>
  );
}

export default PresentationMode;
