/**
 * PPTEditor — PPT 可视化编辑器主组件
 *
 * 功能:
 * - 画布编辑: 元素渲染/选区/拖拽/缩放/内联编辑
 * - 缩略图栏: 幻灯片预览/添加/删除/切换/拖拽排序
 * - 属性面板: 编辑选中元素属性
 * - 工具栏: 插入/操作/对齐/主题/导出/放映
 * - 撤销重做: 命令栈管理
 * - 主题切换: 实时应用 PPT_THEMES
 * - 导出: HTML / PDF / PNG / PNG 长图
 * - 放映模式: 全屏幻灯片播放 (PresentationMode)
 */

import { useState, useCallback, useRef, useEffect, useLayoutEffect } from 'react';
import {
  type V2Slide, type V2SlideDeck, type SlideElement, type PPTTheme, PPT_THEMES,
  createTextElement, createShapeElement, createListElement, createImageElement,
  createElementId,
} from '../../core/knowledge/ppt-types';
import {
  PPT_STYLES, PPT_FONTS, CANVAS_SIZES, STYLE_CATEGORY_LABELS,
  getStyleById, getFontById, loadGoogleFonts, getStyleBackground, styleToTheme,
  type PPTStyle, type CanvasSize,
} from '../../core/knowledge/ppt-styles';
import { chatModifySlide } from '../../core/knowledge/ppt-chat';
import { SlideCanvas, type CanvasCommands } from './SlideCanvas';
import { PropertyPanel } from './PropertyPanel';
import { EditorToolbar } from './EditorToolbar';
import { PresentationMode } from './PresentationMode';
import './ppt-editor.css';

// ========== 命令接口 (Undo/Redo) ==========

interface Command {
  execute: () => void;
  undo: () => void;
  description: string;
}

// ========== Props ==========

export interface PPTEditorProps {
  initialDeck: V2SlideDeck;
  onDeckChange: (deck: V2SlideDeck) => void;
  onExportHTML?: (html: string) => void;
  onExportPPTX?: (blob: Blob) => void;
  onBack?: () => void;
}

// ========== 组件 ==========

export function PPTEditor({ initialDeck, onDeckChange, onExportHTML, onExportPPTX, onBack }: PPTEditorProps) {
  const [deck, setDeck] = useState<V2SlideDeck>(initialDeck);
  const [currentSlideIndex, setCurrentSlideIndex] = useState(0);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [isPresenting, setIsPresenting] = useState(false);

  // 对话式修改状态
  const [chatInput, setChatInput] = useState('');
  const [chatMessages, setChatMessages] = useState<{role: 'user'|'assistant', text: string}[]>([]);
  const [chatLoading, setChatLoading] = useState(false);

  // 演讲稿查看面板
  const [showNotesPanel, setShowNotesPanel] = useState(false);

  // 撤销重做栈
  const undoStack = useRef<Command[]>([]);
  const redoStack = useRef<Command[]>([]);
  const [undoCount, setUndoCount] = useState(0);
  const [redoCount, setRedoCount] = useState(0);

  // 版本历史 (P2-4)
  const [versions, setVersions] = useState<{ id: string; name: string; deck: V2SlideDeck; timestamp: number }[]>([]);
  const [showVersionPanel, setShowVersionPanel] = useState(false);

  const currentSlide = deck.slides[currentSlideIndex];
  const selectedElements = currentSlide.elements.filter(el => selectedIds.has(el.id));

  // 加载 Google 字体
  useEffect(() => {
    loadGoogleFonts();
  }, []);

  // ====== 执行命令 (自动加入 undo 栈) ======
  const executeCommand = useCallback((cmd: Command) => {
    cmd.execute();
    undoStack.current.push(cmd);
    redoStack.current = [];
    setUndoCount(undoStack.current.length);
    setRedoCount(redoStack.current.length);
  }, []);

  // ====== 更新幻灯片元素 ======
  const updateElements = useCallback((updates: { id: string; changes: Partial<SlideElement> }[]) => {
    if (updates.length === 0) return;

    const prevElements = currentSlide.elements.map(el => ({ ...el }));

    setDeck(prev => {
      const newSlides = [...prev.slides];
      newSlides[currentSlideIndex] = {
        ...newSlides[currentSlideIndex],
        elements: currentSlide.elements.map(el => {
          const update = updates.find(u => u.id === el.id);
          return update ? { ...el, ...update.changes } as SlideElement : el;
        }),
      };
      return { ...prev, slides: newSlides };
    });

    executeCommand({
      description: `更新 ${updates.length} 个元素`,
      execute: () => {},
      undo: () => {
        setDeck(prev => {
          const newSlides = [...prev.slides];
          newSlides[currentSlideIndex] = {
            ...newSlides[currentSlideIndex],
            elements: prevElements,
          };
          return { ...prev, slides: newSlides };
        });
      },
    });
  }, [currentSlide, currentSlideIndex, executeCommand]);

  // ====== 同步外部 ======
  useEffect(() => {
    onDeckChange(deck);
  }, [deck, onDeckChange]);

  // ====== Canvas 命令注册 ======
  const canvasCommandsRef = useRef<CanvasCommands | null>(null);
  const registerCanvasCommands = useCallback((cmds: CanvasCommands) => {
    canvasCommandsRef.current = cmds;
  }, []);

  // ====== 画布尺寸自适应（编辑模式） ======
  const canvasWrapperRef = useRef<HTMLDivElement>(null);
  const [canvasDisplaySize, setCanvasDisplaySize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = canvasWrapperRef.current;
    if (!el) return;
    const calc = () => {
      const cw = el.clientWidth - 32; // padding 16*2
      const ch = el.clientHeight - 32;
      if (cw <= 0 || ch <= 0) {
        // 容器还没布局完成，下一帧重试
        requestAnimationFrame(calc);
        return;
      }
      const ratio = deck.canvasWidth / deck.canvasHeight;
      let w = cw;
      let h = cw / ratio;
      if (h > ch) {
        h = ch;
        w = ch * ratio;
      }
      setCanvasDisplaySize({ width: Math.round(w), height: Math.round(h) });
    };
    // 同步计算一次
    calc();
    // 如果同步计算失败（cw=0），requestAnimationFrame 会重试
    const ro = new ResizeObserver(calc);
    ro.observe(el);
    return () => ro.disconnect();
  }, [deck.canvasWidth, deck.canvasHeight, isPresenting]);

  // ====== 全局快捷键 (定义在 handleUndo/handleRedo/handleDuplicateSelected 之后) ======

  // ====== 工具栏操作 ======

  const handleUndo = useCallback(() => {
    const cmd = undoStack.current.pop();
    if (!cmd) return;
    cmd.undo();
    redoStack.current.push(cmd);
    setUndoCount(undoStack.current.length);
    setRedoCount(redoStack.current.length);
  }, []);

  const handleRedo = useCallback(() => {
    const cmd = redoStack.current.pop();
    if (!cmd) return;
    cmd.execute();
    undoStack.current.push(cmd);
    setUndoCount(undoStack.current.length);
    setRedoCount(redoStack.current.length);
  }, []);

  const handleInsertText = useCallback(() => {
    const el = createTextElement({ x: 25, y: 35, width: 50, height: 15, zIndex: 100 });
    setDeck(prev => {
      const newSlides = [...prev.slides];
      newSlides[currentSlideIndex] = {
        ...newSlides[currentSlideIndex],
        elements: [...newSlides[currentSlideIndex].elements, el],
      };
      return { ...prev, slides: newSlides };
    });
    setSelectedIds(new Set([el.id]));
  }, [currentSlideIndex]);

  const handleInsertShape = useCallback((shape: 'rect' | 'rounded' | 'circle' | 'triangle' | 'arrow' | 'line') => {
    const el = createShapeElement({
      x: 30, y: 30, width: 40, height: 30,
      shape, zIndex: 100,
      fill: deck.theme.primaryColor,
    });
    setDeck(prev => {
      const newSlides = [...prev.slides];
      newSlides[currentSlideIndex] = {
        ...newSlides[currentSlideIndex],
        elements: [...newSlides[currentSlideIndex].elements, el],
      };
      return { ...prev, slides: newSlides };
    });
    setSelectedIds(new Set([el.id]));
  }, [currentSlideIndex, deck.theme]);

  const handleInsertList = useCallback(() => {
    const el = createListElement({ zIndex: 100, bulletColor: deck.theme.accentColor });
    setDeck(prev => {
      const newSlides = [...prev.slides];
      newSlides[currentSlideIndex] = {
        ...newSlides[currentSlideIndex],
        elements: [...newSlides[currentSlideIndex].elements, el],
      };
      return { ...prev, slides: newSlides };
    });
    setSelectedIds(new Set([el.id]));
  }, [currentSlideIndex, deck.theme]);

  const handleInsertImage = useCallback(() => {
    const el = createImageElement({ zIndex: 100 });
    setDeck(prev => {
      const newSlides = [...prev.slides];
      newSlides[currentSlideIndex] = {
        ...newSlides[currentSlideIndex],
        elements: [...newSlides[currentSlideIndex].elements, el],
      };
      return { ...prev, slides: newSlides };
    });
    setSelectedIds(new Set([el.id]));
  }, [currentSlideIndex]);

  const handleDeleteSelected = useCallback(() => {
    if (selectedIds.size === 0) return;
    const deleted = currentSlide.elements.filter(el => selectedIds.has(el.id));
    setDeck(prev => {
      const newSlides = [...prev.slides];
      newSlides[currentSlideIndex] = {
        ...newSlides[currentSlideIndex],
        elements: currentSlide.elements.filter(el => !selectedIds.has(el.id)),
      };
      return { ...prev, slides: newSlides };
    });
    setSelectedIds(new Set());
    executeCommand({
      description: `删除 ${deleted.length} 个元素`,
      execute: () => {},
      undo: () => {
        setDeck(prev => {
          const newSlides = [...prev.slides];
          newSlides[currentSlideIndex] = {
            ...newSlides[currentSlideIndex],
            elements: [...currentSlide.elements],
          };
          return { ...prev, slides: newSlides };
        });
        setSelectedIds(new Set(deleted.map(el => el.id)));
      },
    });
  }, [selectedIds, currentSlide, currentSlideIndex, executeCommand]);

  const handleDuplicateSelected = useCallback(() => {
    const dup = selectedElements.map(el => ({
      ...el, id: createElementId(),
      x: el.x + 1, y: el.y + 1,
      zIndex: Math.max(...currentSlide.elements.map(e => e.zIndex), 0) + 1,
    }));
    if (dup.length === 0) return;
    setDeck(prev => {
      const newSlides = [...prev.slides];
      newSlides[currentSlideIndex] = {
        ...newSlides[currentSlideIndex],
        elements: [...currentSlide.elements, ...dup],
      };
      return { ...prev, slides: newSlides };
    });
    setSelectedIds(new Set(dup.map(el => el.id)));
    executeCommand({
      description: `复制 ${dup.length} 个元素`,
      execute: () => {},
      undo: () => {
        setDeck(prev => {
          const newSlides = [...prev.slides];
          newSlides[currentSlideIndex] = {
            ...newSlides[currentSlideIndex],
            elements: currentSlide.elements,
          };
          return { ...prev, slides: newSlides };
        });
        setSelectedIds(new Set(selectedElements.map(el => el.id)));
      },
    });
  }, [selectedElements, currentSlide, currentSlideIndex, executeCommand]);

  // ====== 全局快捷键 ======
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Ctrl+Z 撤销
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        handleUndo();
        return;
      }
      // Ctrl+Y / Ctrl+Shift+Z 重做
      if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
        e.preventDefault();
        handleRedo();
        return;
      }
      // Ctrl+D 复制
      if ((e.ctrlKey || e.metaKey) && e.key === 'd') {
        e.preventDefault();
        handleDuplicateSelected();
        return;
      }
      // Ctrl+S 保存
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        if (onBack) onBack();
        return;
      }
      // F5 播放
      if (e.key === 'F5') {
        e.preventDefault();
        setIsPresenting(true);
        return;
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [handleUndo, handleRedo, handleDuplicateSelected, onBack]);

  const handleBringForward = useCallback(() => {
    const updates = selectedElements.map(el => ({ id: el.id, changes: { zIndex: el.zIndex + 1 } as Partial<SlideElement> }));
    updateElements(updates);
  }, [selectedElements, updateElements]);

  const handleSendBackward = useCallback(() => {
    const updates = selectedElements.map(el => ({ id: el.id, changes: { zIndex: Math.max(0, el.zIndex - 1) } as Partial<SlideElement> }));
    updateElements(updates);
  }, [selectedElements, updateElements]);

  const handleAlign = useCallback((align: 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom') => {
    canvasCommandsRef.current?.alignSelected(align);
  }, []);

const handleThemeChange = useCallback((theme: PPTTheme) => {
  const prevTheme = deck.theme;
  const prevStyleId = deck.styleId;
  // 找到对应的 PPTStyle 以获取完整颜色信息（包括渐变背景）
  const style = getStyleById(theme.id);
  // 更新 deck.theme、styleId 以及所有 slides 的背景和元素颜色
  setDeck(prev => ({
    ...prev,
    theme,
    styleId: theme.id,
    slides: prev.slides.map(slide => {
      // 重新计算 slide 背景
      let newBg = theme.backgroundColor;
      if (style) {
        // conclusion 类型的 slide 用 primaryColor 做背景，保持不变
        const isConclusion = slide.elements.some(el =>
          el.type === 'shape' && el.width >= 99 && el.height >= 99 &&
          (el as any).fill === prevTheme.primaryColor
        );
        newBg = isConclusion ? theme.primaryColor : getStyleBackground(style);
      }
      // 更新元素颜色
      const newElements = slide.elements.map(el => {
        const updated = { ...el };
        if (prevTheme) {
          // 文本元素：替换颜色映射
          if (el.type === 'text') {
            const te = updated as any;
            if (te.color === prevTheme.primaryColor) te.color = theme.primaryColor;
            else if (te.color === prevTheme.secondaryColor) te.color = theme.secondaryColor;
            else if (te.color === prevTheme.textColor) te.color = theme.textColor;
            // 旧主题的文字颜色如果不是主题色之一，保持不变（用户自定义色）
          }
          // 列表元素
          if (el.type === 'list') {
            const le = updated as any;
            if (le.color === prevTheme.textColor || le.color === prevTheme.primaryColor) {
              le.color = le.color === prevTheme.textColor ? theme.textColor : theme.primaryColor;
            }
            if (le.bulletColor === prevTheme.accentColor) le.bulletColor = theme.accentColor;
          }
          // 形状元素：替换填充色
          if (el.type === 'shape') {
            const se = updated as any;
            if (se.fill === prevTheme.primaryColor) se.fill = theme.primaryColor;
            else if (se.fill === prevTheme.secondaryColor) se.fill = theme.secondaryColor;
            else if (se.fill === prevTheme.accentColor) se.fill = theme.accentColor;
            else if (se.fill === prevTheme.backgroundColor) se.fill = theme.backgroundColor;
            // 透明度后缀的颜色（如 #7c6cf022）保持原样，不替换
          }
        }
        return updated;
      });
      return { ...slide, background: newBg, elements: newElements };
    }),
  }));
  executeCommand({
    description: `切换主题为 ${theme.name}`,
    execute: () => {},
    undo: () => setDeck(prev => ({ ...prev, theme: prevTheme, styleId: prevStyleId })),
  });
}, [deck.theme, deck.styleId, executeCommand]);

  // ====== 幻灯片操作 ======

  const handleAddSlide = useCallback(() => {
    const newSlide: V2Slide = {
      id: `slide-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      index: deck.slides.length,
      elements: [],
      background: deck.theme.backgroundColor,
      notes: '',
    };
    setDeck(prev => ({ ...prev, slides: [...prev.slides, newSlide] }));
    setCurrentSlideIndex(deck.slides.length);
  }, [deck.slides, deck.theme]);

  // 模板插入 (P2-5)
  const [showTemplates, setShowTemplates] = useState(false);
  const handleAddFromTemplate = useCallback(async (templateId: string) => {
    const { getTemplates, createSlideFromTemplate } = await import('../../core/knowledge/ppt-templates');
    const { getStyleById, PPT_STYLES } = await import('../../core/knowledge/ppt-styles');
    const styleId = (deck as any).styleId || 'business-blue';
    const style = getStyleById(styleId) || PPT_STYLES[0];
    const newSlide = createSlideFromTemplate(templateId, style as any, deck.theme, deck.slides.length);
    if (newSlide) {
      setDeck(prev => ({ ...prev, slides: [...prev.slides, newSlide] }));
      setCurrentSlideIndex(deck.slides.length);
    }
    setShowTemplates(false);
  }, [deck]);

  const handleDeleteSlide = useCallback((index: number) => {
    if (deck.slides.length <= 1) return;
    const removed = deck.slides[index];
    setDeck(prev => ({
      ...prev,
      slides: prev.slides.filter((_, i) => i !== index).map((s, i) => ({ ...s, index: i })),
    }));
    executeCommand({
      description: `删除幻灯片 ${index + 1}`,
      execute: () => {},
      undo: () => {
        setDeck(prev => ({
          ...prev,
          slides: [...prev.slides.slice(0, index), removed, ...prev.slides.slice(index)]
            .map((s, i) => ({ ...s, index: i })),
        }));
        if (currentSlideIndex >= index) setCurrentSlideIndex(index);
      },
    });
  }, [deck.slides, currentSlideIndex, executeCommand]);

  const handleSlideSelect = useCallback((index: number) => {
    setCurrentSlideIndex(index);
    setSelectedIds(new Set());
    setEditingId(null);
  }, []);

  // ====== 导出 ======

  const generateExportHTML = useCallback((): string => {
    const slidesHTML = deck.slides.map((slide, i) => {
      const elHTML = slide.elements
        .sort((a, b) => a.zIndex - b.zIndex)
        .map(el => {
          const style = Object.entries({
            position: 'absolute',
            left: `${el.x}%`, top: `${el.y}%`, width: `${el.width}%`, height: `${el.height}%`,
            zIndex: el.zIndex, opacity: el.opacity,
            transform: el.rotation ? `rotate(${el.rotation}deg)` : undefined,
          })
            .filter(([, v]) => v !== undefined)
            .map(([k, v]) => `${k.replace(/[A-Z]/g, m => '-' + m.toLowerCase())}: ${v}`)
            .join('; ');
          let content = '';
          if (el.type === 'text') content = (el as any).content.replace(/\n/g, '<br>');
          else if (el.type === 'list') content = `<ul>${(el as any).items.map((item: string) => `<li>${item}</li>`).join('')}</ul>`;
          return `<div style="${style}">${content}</div>`;
        }).join('\n');
      return `<div class="slide" data-index="${i}" style="position:absolute;inset:0;background:${slide.background};display:none;">${elHTML}</div>`;
    }).join('\n');

    return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box}body{overflow:hidden;font-family:${deck.theme.fontFamily}}.slide{width:100vw;height:100vh}.slide.active{display:flex;align-items:center;justify-content:center}button{position:fixed;bottom:20px;padding:8px 16px;border-radius:4px;cursor:pointer;background:rgba(0,0,0,0.7);color:#fff}#prev{left:20px}#next{right:20px}</style></head><body>${slidesHTML}<script>let idx=0,slides=document.querySelectorAll('.slide');function show(){slides.forEach((s,i)=>s.classList.toggle('active',i===idx))}show();document.getElementById('prev').onclick=()=>{idx>0&&idx--&&show()};document.getElementById('next').onclick=()=>{idx<slides.length-1&&idx++&&show()};document.onkeydown=e=>{e.key==='ArrowLeft'&&idx>0&&idx--&&show();e.key==='ArrowRight'&&idx<slides.length-1&&idx++&&show();e.key==='Escape'&&window.close()};</script><button id="prev">上一页</button><button id="next">下一页</button></body></html>`;
  }, [deck]);

  const handleExportHTML = useCallback(() => {
    const html = generateExportHTML();
    if (onExportHTML) onExportHTML(html);
  }, [generateExportHTML, onExportHTML]);

  const handleExportPPTX = useCallback(async () => {
    const title = deck.title || 'presentation';
    const htmlContent = generateExportHTML();
    const blob = new Blob([htmlContent], { type: 'text/html' });
    if (onExportPPTX) onExportPPTX(blob);
  }, [deck, generateExportHTML, onExportPPTX]);

  // ====== PDF 导出 ======
  const handleExportPDF = useCallback(() => {
    // 使用浏览器打印功能实现 PDF 导出
    const html = generateExportHTML();
    const printWindow = window.open('', '_blank');
    if (printWindow) {
      printWindow.document.write(html);
      printWindow.document.close();
      printWindow.onload = () => {
        setTimeout(() => {
          printWindow.print();
        }, 500);
      };
    }
  }, [generateExportHTML]);

  // ====== PNG 批量导出 ======
  const handleExportPNG = useCallback(async () => {
    // 使用 html2canvas 截取每张幻灯片
    // 动态加载 html2canvas
    const { default: html2canvas } = await import('html2canvas');
    const JSZip = (await import('jszip')).default;

    const zip = new JSZip();
    const canvasArea = document.querySelector('.ppt-editor-canvas-area') as HTMLElement;
    if (!canvasArea) return;

    for (let i = 0; i < deck.slides.length; i++) {
      setCurrentSlideIndex(i);
      // 等待渲染
      await new Promise(r => setTimeout(r, 300));
      const canvasEl = document.querySelector('.ppt-slide-canvas') as HTMLElement;
      if (canvasEl) {
        const canvas = await html2canvas(canvasEl, { scale: 2, backgroundColor: deck.slides[i].background });
        const dataUrl = canvas.toDataURL('image/png');
        const base64 = dataUrl.split(',')[1];
        zip.file(`slide-${String(i + 1).padStart(2, '0')}.png`, base64, { base64: true });
      }
    }

    const blob = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${deck.title || 'presentation'}-images.zip`;
    a.click();
    URL.revokeObjectURL(url);
    setCurrentSlideIndex(0);
  }, [deck]);

  // ====== PNG 长图导出 ======
  const handleExportPNGLong = useCallback(async () => {
    const { default: html2canvas } = await import('html2canvas');

    const canvases: HTMLCanvasElement[] = [];
    const canvasArea = document.querySelector('.ppt-editor-canvas-area') as HTMLElement;
    if (!canvasArea) return;

    for (let i = 0; i < deck.slides.length; i++) {
      setCurrentSlideIndex(i);
      await new Promise(r => setTimeout(r, 300));
      const canvasEl = document.querySelector('.ppt-slide-canvas') as HTMLElement;
      if (canvasEl) {
        const canvas = await html2canvas(canvasEl, { scale: 2, backgroundColor: deck.slides[i].background });
        canvases.push(canvas);
      }
    }

    // 拼接长图
    const totalHeight = canvases.reduce((sum, c) => sum + c.height, 0);
    const maxWidth = Math.max(...canvases.map(c => c.width));
    const longCanvas = document.createElement('canvas');
    longCanvas.width = maxWidth;
    longCanvas.height = totalHeight;
    const ctx = longCanvas.getContext('2d')!;
    let y = 0;
    for (const c of canvases) {
      ctx.drawImage(c, 0, y);
      y += c.height;
    }

    longCanvas.toBlob(blob => {
      if (blob) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${deck.title || 'presentation'}-long.png`;
        a.click();
        URL.revokeObjectURL(url);
      }
    }, 'image/png');
    setCurrentSlideIndex(0);
  }, [deck]);

  // ====== 放映模式 ======
  const handlePlayPresentation = useCallback(() => {
    setIsPresenting(true);
  }, []);

  // ====== 演讲稿生成 ======
  const [generatingNotes, setGeneratingNotes] = useState(false);
  const handleGenerateNotes = useCallback(async () => {
    if (generatingNotes) return;

    // 检查是否已有演讲稿
    const hasNotes = deck.slides.some(s => s.notes && s.notes.trim());
    if (hasNotes) {
      const choice = window.confirm(
        '当前幻灯片已包含演讲稿。\n\n点击「确定」重新生成（将覆盖现有演讲稿），\n点击「取消」查看现有演讲稿。'
      );
      if (!choice) {
        setShowNotesPanel(true);
        return;
      }
    }

    setGeneratingNotes(true);
    try {
      const { generateAllSpeakerNotes } = await import('../../core/knowledge/ppt-notes');
      const updated = await generateAllSpeakerNotes(deck, (current, total, title) => {
        setChatMessages(prev => [...prev.slice(-1), { role: 'assistant', text: `正在生成演讲稿 (${current}/${total}) — ${title}...` }]);
      });
      setDeck(updated);
      setChatMessages(prev => [...prev, { role: 'assistant', text: `✅ 已为 ${updated.slides.length} 页幻灯片生成演讲稿` }]);
      // 生成完成后自动打开查看面板
      setShowNotesPanel(true);
    } catch (err) {
      setChatMessages(prev => [...prev, { role: 'assistant', text: `❌ 演讲稿生成失败: ${err instanceof Error ? err.message : String(err)}` }]);
    }
    setGeneratingNotes(false);
  }, [deck, generatingNotes]);

  // ====== 版本历史 (P2-4) ======
  const handleSaveVersion = useCallback(() => {
    const name = window.prompt('版本名称', `v${versions.length + 1}`);
    if (!name) return;
    const version = {
      id: `v-${Date.now()}`,
      name,
      deck: JSON.parse(JSON.stringify(deck)),
      timestamp: Date.now(),
    };
    setVersions(prev => [...prev, version]);
  }, [deck, versions.length]);

  const handleRestoreVersion = useCallback((versionId: string) => {
    const version = versions.find(v => v.id === versionId);
    if (!version) return;
    if (!window.confirm(`恢复到版本 "${version.name}"？当前未保存的更改将丢失。`)) return;
    setDeck(JSON.parse(JSON.stringify(version.deck)));
    setShowVersionPanel(false);
  }, [versions]);

  // ====== 对话式修改 ======
  const handleChatSubmit = useCallback(async () => {
    if (!chatInput.trim() || chatLoading) return;
    const instruction = chatInput.trim();
    setChatInput('');
    setChatMessages(prev => [...prev, { role: 'user', text: instruction }]);
    setChatLoading(true);
    try {
      const result = await chatModifySlide(currentSlide, instruction);
      // 替换当前页元素
      const prevElements = currentSlide.elements.map(el => ({ ...el }));
      setDeck(prev => {
        const newSlides = [...prev.slides];
        newSlides[currentSlideIndex] = {
          ...newSlides[currentSlideIndex],
          elements: result.elements,
        };
        return { ...prev, slides: newSlides };
      });
      executeCommand({
        description: `AI 修改: ${instruction}`,
        execute: () => {},
        undo: () => {
          setDeck(prev => {
            const newSlides = [...prev.slides];
            newSlides[currentSlideIndex] = {
              ...newSlides[currentSlideIndex],
              elements: prevElements,
            };
            return { ...prev, slides: newSlides };
          });
        },
      });
      setChatMessages(prev => [...prev, { role: 'assistant', text: result.reply || '已修改' }]);
    } catch (err) {
      setChatMessages(prev => [...prev, { role: 'assistant', text: `修改失败: ${err instanceof Error ? err.message : String(err)}` }]);
    } finally {
      setChatLoading(false);
    }
  }, [chatInput, chatLoading, currentSlide, currentSlideIndex, executeCommand]);

  // ====== 缩略图渲染 ======
  const renderThumbnail = (slide: V2Slide, index: number) => {
    const firstText = slide.elements.find(el => el.type === 'text');
    const aspectRatio = `${deck.canvasWidth} / ${deck.canvasHeight}`;
    return (
      <div
        key={slide.id}
        className={`ppt-thumbnail-item ${index === currentSlideIndex ? 'active' : ''}`}
        onClick={() => handleSlideSelect(index)}
        style={{ background: slide.background, aspectRatio, display: 'flex', alignItems: 'flex-start', justifyContent: 'flex-start', padding: 8 }}
      >
        <span className="ppt-thumbnail-number">{index + 1}</span>
        <button className="ppt-thumbnail-delete" onClick={(e) => { e.stopPropagation(); handleDeleteSlide(index); }}>✕</button>
        {firstText && (
          <div style={{ fontSize: 8, color: deck.theme.textColor, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '90%' }}>
            {(firstText as any).content}
          </div>
        )}
      </div>
    );
  };

  // ====== 放映模式渲染 ======
  if (isPresenting) {
    return <PresentationMode deck={deck} startIndex={currentSlideIndex} onExit={() => setIsPresenting(false)} />;
  }

  // ====== 主编辑器渲染 ======
  return (
    <div className="ppt-editor-root">
      {/* 返回按钮 */}
      {onBack && (
        <div className="ppt-editor-backbar">
          <button onClick={onBack}>← 返回保存</button>
          <span>{deck.title}</span>
        </div>
      )}

      {/* 顶部工具栏 */}
      <EditorToolbar
        selectedCount={selectedIds.size}
        canUndo={undoCount > 0}
        canRedo={redoCount > 0}
        currentTheme={deck.theme}
        onThemeChange={handleThemeChange}
        onInsertText={handleInsertText}
        onInsertShape={handleInsertShape}
        onInsertList={handleInsertList}
        onInsertImage={handleInsertImage}
        onUndo={handleUndo}
        onRedo={handleRedo}
        onDelete={handleDeleteSelected}
        onDuplicate={handleDuplicateSelected}
        onBringForward={handleBringForward}
        onSendBackward={handleSendBackward}
        onAlign={handleAlign}
        onExportHTML={handleExportHTML}
        onExportPPTX={handleExportPPTX}
        onExportPDF={handleExportPDF}
        onExportPNG={handleExportPNG}
        onExportPNGLong={handleExportPNGLong}
        onPlayPresentation={handlePlayPresentation}
        onGenerateNotes={handleGenerateNotes}
        generatingNotes={generatingNotes}
        onSaveVersion={handleSaveVersion}
        onShowVersions={() => setShowVersionPanel(!showVersionPanel)}
        versionCount={versions.length}
      />

      {/* 主体 */}
      <div className="ppt-editor-body">
        {/* 左侧缩略图栏 */}
        <div className="ppt-thumbnail-bar">
          {deck.slides.map((slide, i) => renderThumbnail(slide, i))}
          <button className="ppt-thumbnail-add" onClick={handleAddSlide}>+ 添加幻灯片</button>
          <button className="ppt-thumbnail-add" onClick={() => setShowTemplates(!showTemplates)}>📋 从模板</button>
          {showTemplates && (
            <div style={{ padding: 8, display: 'grid', gridTemplateColumns: '1fr', gap: 6 }}>
              {[
                { id: 'tpl-cover', name: '封面页', icon: '🎯' },
                { id: 'tpl-content', name: '标题+内容', icon: '📝' },
                { id: 'tpl-two-col', name: '双栏对比', icon: '⚖️' },
                { id: 'tpl-section', name: '章节过渡', icon: '🔖' },
                { id: 'tpl-quote', name: '引用金句', icon: '💬' },
                { id: 'tpl-data', name: '数据卡片', icon: '📊' },
                { id: 'tpl-conclusion', name: '结论页', icon: '🏁' },
              ].map(tpl => (
                <button key={tpl.id} onClick={() => handleAddFromTemplate(tpl.id)} className="ppt-toolbar-btn" style={{ width: '100%', textAlign: 'left' }}>
                  {tpl.icon} {tpl.name}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* 中间画布区域 + 底部对话栏 */}
        <div className="ppt-editor-canvas-area">
          <div className="ppt-editor-canvas-wrapper" ref={canvasWrapperRef}>
            <div style={{
              width: canvasDisplaySize.width || '100%',
              height: canvasDisplaySize.height || '100%',
              minHeight: 200,
            }}>
            <SlideCanvas
              slide={currentSlide}
              theme={deck.theme}
              canvasWidth={deck.canvasWidth}
              canvasHeight={deck.canvasHeight}
              selectedIds={selectedIds}
              editingId={editingId}
              onSelect={(ids) => setSelectedIds(ids)}
              onEditingChange={setEditingId}
              onElementsUpdate={updateElements}
              onElementEdit={(id, newContent) => {
                const el = currentSlide.elements.find(e => e.id === id);
                if (el?.type === 'text') {
                  updateElements([{ id, changes: { content: newContent } }]);
                } else if (el?.type === 'list') {
                  try {
                    const items = JSON.parse(newContent);
                    updateElements([{ id, changes: { items } }]);
                  } catch {}
                }
              }}
              onDeleteSelected={handleDeleteSelected}
              onDuplicateSelected={handleDuplicateSelected}
              registerCommands={registerCanvasCommands}
            />
            </div>
          </div>

          {/* 对话式修改栏 */}
          <div className="ppt-chat-bar">
            {/* 消息历史 (最近3条) */}
            {chatMessages.length > 0 && (
              <div className="ppt-chat-messages">
                {chatMessages.slice(-3).map((msg, i) => (
                  <div key={i} className={`ppt-chat-msg ${msg.role}`}>
                    {msg.text}
                  </div>
                ))}
              </div>
            )}
            {/* 输入框 */}
            <div style={{ display: 'flex', gap: 6, alignItems: 'flex-end' }}>
              <textarea
                className="ppt-chat-input"
                value={chatInput}
                onChange={e => setChatInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleChatSubmit(); } }}
                placeholder={chatLoading ? 'AI 正在修改...' : '对当前页说点什么，如「标题换成蓝色」「加个数据图表」'}
                disabled={chatLoading}
                rows={2}
                style={{ resize: 'vertical', minHeight: 44, maxHeight: 120, lineHeight: 1.4 }}
              />
              <button
                className="ppt-chat-send"
                onClick={handleChatSubmit}
                disabled={chatLoading || !chatInput.trim()}
              >
                {chatLoading ? '...' : '✨ AI 修改'}
              </button>
            </div>
          </div>
        </div>

        {/* 右侧属性面板 */}
        <PropertyPanel
          selectedElements={selectedElements}
          onUpdateElement={(id, changes) => updateElements([{ id, changes }])}
          onAlign={handleAlign}
          onBringForward={handleBringForward}
          onSendBackward={handleSendBackward}
          onBringToFront={() => {
            const maxZ = Math.max(...currentSlide.elements.map(e => e.zIndex), 0);
            const updates = selectedElements.map((el, i) => ({ id: el.id, changes: { zIndex: maxZ + 1 + i } as Partial<SlideElement> }));
            updateElements(updates);
          }}
          onSendToBack={() => {
            const minZ = Math.min(...currentSlide.elements.map(e => e.zIndex), 0);
            const updates = selectedElements.map((el, i) => ({ id: el.id, changes: { zIndex: minZ - 1 - i } as Partial<SlideElement> }));
            updateElements(updates);
          }}
          onDelete={handleDeleteSelected}
        />
      </div>

      {/* 版本历史面板 (P2-4) */}
      {showVersionPanel && (
        <div className="ppt-version-panel">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <span style={{ color: 'var(--text-primary)', fontSize: 'var(--fs-md)', fontWeight: 600 }}>📚 版本历史</span>
            <button onClick={() => setShowVersionPanel(false)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 'var(--fs-lg)' }}>✕</button>
          </div>
          {versions.length === 0 ? (
            <div style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-sm)', textAlign: 'center', padding: 20 }}>暂无保存的版本</div>
          ) : (
            versions.slice().reverse().map(v => (
              <div key={v.id} className="ppt-version-item" onClick={() => handleRestoreVersion(v.id)}>
                <div style={{ color: 'var(--text-primary)', fontSize: 'var(--fs-base)', fontWeight: 600 }}>{v.name}</div>
                <div style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-sm)', marginTop: 2 }}>
                  {new Date(v.timestamp).toLocaleString()} · {v.deck.slides.length} 页
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {/* 演讲稿查看面板 */}
      {showNotesPanel && (
        <div className="ppt-version-panel">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <span style={{ color: 'var(--text-primary)', fontSize: 'var(--fs-md)', fontWeight: 600 }}>📝 演讲稿</span>
            <div style={{ display: 'flex', gap: 6 }}>
              <button
                onClick={() => handleGenerateNotes()}
                disabled={generatingNotes}
                className="ppt-chat-send"
                style={{ fontSize: 'var(--fs-sm)', padding: '4px 10px' }}
              >
                {generatingNotes ? '生成中...' : '重新生成'}
              </button>
              <button onClick={() => setShowNotesPanel(false)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 'var(--fs-lg)' }}>✕</button>
            </div>
          </div>
          <div>
            {deck.slides.map((slide, i) => {
              const hasNotes = slide.notes && slide.notes.trim();
              return (
                <div key={i} className="ppt-version-item" style={{ cursor: 'default', opacity: hasNotes ? 1 : 0.5 }}>
                  <div
                    style={{ color: 'var(--accent)', fontSize: 'var(--fs-sm)', fontWeight: 600, marginBottom: 4, cursor: 'pointer' }}
                    onClick={() => { setCurrentSlideIndex(i); setShowNotesPanel(false); }}
                  >
                    第 {i + 1} 页 {hasNotes ? '' : '（无演讲稿）'}
                  </div>
                  {hasNotes && (
                    <div style={{ color: 'var(--text-secondary)', fontSize: 'var(--fs-sm)', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
                      {slide.notes}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 底部状态栏 */}
      <div className="ppt-editor-statusbar">
        <div className="ppt-status-info">
          <span>幻灯片 <b>{currentSlideIndex + 1}</b> / {deck.slides.length}</span>
          <span>主题: <b>{deck.theme.name}</b></span>
          <span>画布: <b>{deck.canvasWidth}×{deck.canvasHeight}</b></span>
          <span>元素: <b>{currentSlide.elements.length}</b></span>
        </div>
        <div>Esc 取消选择 | Ctrl+Z 撤销 | Ctrl+D 复制 | F5 播放</div>
      </div>
    </div>
  );
}

export default PPTEditor;
