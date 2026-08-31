/**
 * PPT 可视化编辑器 — 元素数据模型
 *
 * 设计思路:
 * - 每张幻灯片由一组 SlideElement 组成, 每个元素有独立的位置/大小/样式
 * - 位置和大小使用百分比 (0-100), 使编辑器分辨率无关
 * - 元素类型: text / shape / image / list
 * - 支持 z-index 层级管理
 * - 序列化为 JSON 存储, 替代旧的 HTML 字符串方案
 *
 * 对标 oh-my-ppt 的元素模型, 但使用 DOM 绝对定位而非 Canvas 渲染:
 * - 优势: 原生文本编辑、CSS 过渡动画、无需自定义命中检测
 * - 劣势: 极复杂的多层嵌套效果不如 Canvas 灵活
 */

// ========== 基础元素接口 ==========

export interface BaseElement {
  id: string;
  type: ElementType;
  /** 左上角 X 位置 (百分比 0-100) */
  x: number;
  /** 左上角 Y 位置 (百分比 0-100) */
  y: number;
  /** 宽度 (百分比 0-100) */
  width: number;
  /** 高度 (百分比 0-100) */
  height: number;
  /** 旋转角度 (度) */
  rotation: number;
  /** 层级 (数字越大越在上) */
  zIndex: number;
  /** 透明度 (0-1) */
  opacity: number;
  /** 元素动画配置 */
  animation?: ElementAnimation;
}

export type ElementType = 'text' | 'shape' | 'image' | 'list';

// ========== 元素动画 ==========

export type AnimationType = 'none' | 'fade-in' | 'slide-in-left' | 'slide-in-right' | 'slide-in-top' | 'slide-in-bottom' | 'zoom-in' | 'bounce-in' | 'flip-in';
export type AnimationTrigger = 'auto' | 'click';

export interface ElementAnimation {
  type: AnimationType;
  duration: number;  // ms
  delay: number;     // ms
  trigger: AnimationTrigger;
}

// ========== 文本元素 ==========

export interface TextElement extends BaseElement {
  type: 'text';
  content: string;
  fontSize: number;       // px (基于 1280x720 画布)
  fontWeight: 'normal' | 'bold';
  fontStyle: 'normal' | 'italic';
  textDecoration: 'none' | 'underline';
  color: string;
  textAlign: 'left' | 'center' | 'right';
  fontFamily: string;
  lineHeight: number;
  letterSpacing: number;
  backgroundColor: string;  // 'transparent' 或颜色值
  padding: number;
  borderRadius: number;
}

// ========== 形状元素 ==========

export type ShapeKind = 'rect' | 'rounded' | 'circle' | 'triangle' | 'arrow' | 'line';

export interface ShapeElement extends BaseElement {
  type: 'shape';
  shape: ShapeKind;
  fill: string;
  stroke: string;
  strokeWidth: number;
  borderRadius: number;
  /** 线条/箭头专用 */
  lineStyle?: 'solid' | 'dashed' | 'dotted';
}

// ========== 图片元素 ==========

export interface ImageElement extends BaseElement {
  type: 'image';
  /** base64 data URL 或文件路径 */
  src: string;
  objectFit: 'cover' | 'contain' | 'fill';
  borderRadius: number;
  alt?: string;
}

// ========== 列表元素 ==========

export interface ListElement extends BaseElement {
  type: 'list';
  items: string[];
  fontSize: number;
  color: string;
  bulletColor: string;
  fontFamily: string;
  lineHeight: number;
  bulletStyle: 'dot' | 'number' | 'dash' | 'arrow';
}

// ========== 联合类型 ==========

export type SlideElement = TextElement | ShapeElement | ImageElement | ListElement;

// ========== 幻灯片 (新模型) ==========

export interface V2Slide {
  id: string;
  index: number;
  /** 元素列表 — 可视化编辑的核心数据 */
  elements: SlideElement[];
  /** 背景 */
  background: string;
  /** 演讲者备注 */
  notes?: string;
  /** 布局类型 (仅用于 AI 生成时的初始模板) */
  layout?: SlideLayout;
}

export type SlideLayout = 'title' | 'title_content' | 'two_column' | 'image_text' | 'section' | 'conclusion';

// ========== 主题 ==========

export interface PPTTheme {
  id: string;
  name: string;
  primaryColor: string;
  secondaryColor: string;
  accentColor: string;
  backgroundColor: string;
  textColor: string;
  fontFamily: string;
}

// ========== V2 SlideDeck ==========

export interface V2SlideDeck {
  title: string;
  theme: PPTTheme;
  slides: V2Slide[];
  /** 画布尺寸 (逻辑像素) */
  canvasWidth: number;
  canvasHeight: number;
  /** 风格 ID (对应 PPT_STYLES) */
  styleId?: string;
  /** 画布尺寸 ID (对应 CANVAS_SIZES) */
  canvasSizeId?: string;
}

// ========== 默认值工厂 ==========

export function createElementId(): string {
  return `el-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createTextElement(partial: Partial<TextElement> = {}): TextElement {
  return {
    id: createElementId(),
    type: 'text',
    x: 10,
    y: 10,
    width: 60,
    height: 15,
    rotation: 0,
    zIndex: 1,
    opacity: 1,
    content: '点击编辑文本',
    fontSize: 28,
    fontWeight: 'normal',
    fontStyle: 'normal',
    textDecoration: 'none',
    color: '#333333',
    textAlign: 'left',
    fontFamily: "'Segoe UI', 'Microsoft YaHei', sans-serif",
    lineHeight: 1.4,
    letterSpacing: 0,
    backgroundColor: 'transparent',
    padding: 8,
    borderRadius: 0,
    ...partial,
  };
}

export function createShapeElement(partial: Partial<ShapeElement> = {}): ShapeElement {
  return {
    id: createElementId(),
    type: 'shape',
    x: 15,
    y: 15,
    width: 20,
    height: 20,
    rotation: 0,
    zIndex: 0,
    opacity: 1,
    shape: 'rect',
    fill: '#7c6cf0',
    stroke: 'transparent',
    strokeWidth: 0,
    borderRadius: 0,
    ...partial,
  };
}

export function createListElement(partial: Partial<ListElement> = {}): ListElement {
  return {
    id: createElementId(),
    type: 'list',
    x: 10,
    y: 25,
    width: 70,
    height: 40,
    rotation: 0,
    zIndex: 1,
    opacity: 1,
    items: ['第一项', '第二项', '第三项'],
    fontSize: 22,
    color: '#333333',
    bulletColor: '#7c6cf0',
    fontFamily: "'Segoe UI', 'Microsoft YaHei', sans-serif",
    lineHeight: 1.8,
    bulletStyle: 'dot',
    ...partial,
  };
}

export function createImageElement(partial: Partial<ImageElement> = {}): ImageElement {
  return {
    id: createElementId(),
    type: 'image',
    x: 20,
    y: 20,
    width: 40,
    height: 40,
    rotation: 0,
    zIndex: 0,
    opacity: 1,
    src: '',
    objectFit: 'cover',
    borderRadius: 8,
    ...partial,
  };
}

// ========== 预设主题 ==========

export const PPT_THEMES: PPTTheme[] = [
  {
    id: 'default',
    name: '默认蓝',
    primaryColor: '#7c6cf0',
    secondaryColor: '#5b4bd3',
    accentColor: '#a090ff',
    backgroundColor: '#f8f9fc',
    textColor: '#333333',
    fontFamily: "'Microsoft YaHei', 'Segoe UI', sans-serif",
  },
  {
    id: 'business',
    name: '商务黑',
    primaryColor: '#2d3748',
    secondaryColor: '#1a202c',
    accentColor: '#63b3ed',
    backgroundColor: '#ffffff',
    textColor: '#2d3748',
    fontFamily: "'Microsoft YaHei', 'Segoe UI', sans-serif",
  },
  {
    id: 'warm',
    name: '暖阳橙',
    primaryColor: '#ed8936',
    secondaryColor: '#c05621',
    accentColor: '#fbd38d',
    backgroundColor: '#fffaf0',
    textColor: '#744210',
    fontFamily: "'Microsoft YaHei', 'Segoe UI', sans-serif",
  },
  {
    id: 'nature',
    name: '自然绿',
    primaryColor: '#38a169',
    secondaryColor: '#276749',
    accentColor: '#9ae6b4',
    backgroundColor: '#f0fff4',
    textColor: '#22543d',
    fontFamily: "'Microsoft YaHei', 'Segoe UI', sans-serif",
  },
  {
    id: 'dark',
    name: '深色模式',
    primaryColor: '#a0aec0',
    secondaryColor: '#718096',
    accentColor: '#63b3ed',
    backgroundColor: '#1a202c',
    textColor: '#e2e8f0',
    fontFamily: "'Microsoft YaHei', 'Segoe UI', sans-serif",
  },
  {
    id: 'minimal',
    name: '极简灰',
    primaryColor: '#4a5568',
    secondaryColor: '#2d3748',
    accentColor: '#718096',
    backgroundColor: '#ffffff',
    textColor: '#2d3748',
    fontFamily: "'Helvetica Neue', 'Microsoft YaHei', sans-serif",
  },
];

// ========== 序列化 ==========

export function serializeV2Deck(deck: V2SlideDeck): string {
  return JSON.stringify({ ...deck, __version: 2 });
}

export function deserializeV2Deck(content: string): V2SlideDeck | null {
  try {
    const parsed = JSON.parse(content);
    if (parsed.__version === 2) {
      const { __version, ...deck } = parsed;
      return deck as V2SlideDeck;
    }
    return null;
  } catch {
    return null;
  }
}

// ========== 元素渲染为 CSS 样式 ==========

export function elementToStyle(el: SlideElement, canvasWidth: number, canvasHeight: number): React.CSSProperties {
  const base: React.CSSProperties = {
    position: 'absolute',
    left: `${el.x}%`,
    top: `${el.y}%`,
    width: `${el.width}%`,
    height: `${el.height}%`,
    transform: el.rotation ? `rotate(${el.rotation}deg)` : undefined,
    zIndex: el.zIndex,
    opacity: el.opacity,
  };

  switch (el.type) {
    case 'text':
      return {
        ...base,
        display: 'flex',
        alignItems: 'center',
        justifyContent:
          el.textAlign === 'center' ? 'center' :
          el.textAlign === 'right' ? 'flex-end' : 'flex-start',
        fontSize: `${el.fontSize}px`,
        fontWeight: el.fontWeight,
        fontStyle: el.fontStyle,
        textDecoration: el.textDecoration,
        color: el.color,
        textAlign: el.textAlign,
        fontFamily: el.fontFamily,
        lineHeight: el.lineHeight,
        letterSpacing: `${el.letterSpacing}px`,
        background: el.backgroundColor,
        padding: `${el.padding}px`,
        borderRadius: `${el.borderRadius}px`,
        overflow: 'hidden',
        wordBreak: 'break-word',
      };

    case 'shape':
      return {
        ...base,
        background: el.shape === 'line' ? 'transparent' : el.fill,
        border: el.strokeWidth > 0 ? `${el.strokeWidth}px ${el.lineStyle || 'solid'} ${el.stroke}` : 'none',
        borderRadius: el.shape === 'circle' ? '50%' : `${el.borderRadius}px`,
        borderTop: el.shape === 'line' ? `${el.strokeWidth}px ${el.lineStyle || 'solid'} ${el.stroke}` : undefined,
      };

    case 'image':
      return {
        ...base,
        overflow: 'hidden',
        borderRadius: `${el.borderRadius}px`,
      };

    case 'list':
      return {
        ...base,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        fontSize: `${el.fontSize}px`,
        color: el.color,
        fontFamily: el.fontFamily,
        lineHeight: el.lineHeight,
        overflow: 'hidden',
      };

    default:
      return base;
  }
}

// ========== 元素渲染为 HTML 内容 (导出用) ==========

export function elementToInnerHTML(el: SlideElement): string {
  switch (el.type) {
    case 'text':
      return escapeHtml(el.content).replace(/\n/g, '<br>');

    case 'list': {
      const bullet = el.bulletStyle === 'number' ? 'decimal' :
        el.bulletStyle === 'dash' ? '"— "' :
        el.bulletStyle === 'arrow' ? '"▸ "' : 'disc';
      return `<ul style="list-style:${bullet}; padding-left:24px; margin:0;">${el.items
        .map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`;
    }

    case 'image':
      return el.src ? `<img src="${el.src}" style="width:100%;height:100%;object-fit:${el.objectFit};" alt="${el.alt || ''}"/>` : '';

    case 'shape':
      return '';

    default:
      return '';
  }
}

// ========== 导出整张幻灯片为完整 HTML (用于放映/导出) ==========

export function renderV2SlideToHTML(slide: V2Slide, theme: PPTTheme, canvasWidth = 1280, canvasHeight = 720): string {
  const elementsHTML = slide.elements
    .sort((a, b) => a.zIndex - b.zIndex)
    .map(el => {
      const style = elementToStyle(el, canvasWidth, canvasHeight);
      const styleStr = Object.entries(style)
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => `${k.replace(/[A-Z]/g, m => '-' + m.toLowerCase())}: ${v}`)
        .join('; ');
      return `<div style="${styleStr}">${elementToInnerHTML(el)}</div>`;
    })
    .join('\n');

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { width: ${canvasWidth}px; height: ${canvasHeight}px; overflow: hidden; background: ${slide.background}; font-family: ${theme.fontFamily}; }
</style></head><body>
${elementsHTML}
</body></html>`;
}

// ========== 向后兼容: 从旧 HTML 幻灯片提取元素 ==========

export function migrateHTMLSlide(html: string, theme: PPTTheme): V2Slide {
  const elements: SlideElement[] = [];
  let zIndex = 0;

  // 提取 h1/h2 标题
  const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1Match) {
    elements.push(createTextElement({
      content: stripTags(h1Match[1]),
      x: 6, y: 8, width: 88, height: 12,
      fontSize: 42, fontWeight: 'bold',
      color: theme.primaryColor,
      textAlign: 'center',
      zIndex: zIndex++,
    }));
  }

  const h2Match = html.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
  if (h2Match) {
    elements.push(createTextElement({
      content: stripTags(h2Match[1]),
      x: 6, y: 20, width: 88, height: 10,
      fontSize: 36, fontWeight: 'bold',
      color: theme.secondaryColor,
      zIndex: zIndex++,
    }));
  }

  // 提取 ul 列表
  const ulMatch = html.match(/<ul[^>]*>([\s\S]*?)<\/ul>/i);
  if (ulMatch) {
    const items = ulMatch[1].match(/<li[^>]*>([\s\S]*?)<\/li>/gi) || [];
    const itemTexts = items.map(li => stripTags(li.replace(/<\/?li[^>]*>/gi, '')));
    elements.push(createListElement({
      items: itemTexts,
      x: 8, y: 32, width: 84, height: 50,
      fontSize: 24, color: theme.textColor,
      bulletColor: theme.accentColor,
      zIndex: zIndex++,
    }));
  }

  // 如果没有提取到任何元素, 创建一个占位文本
  if (elements.length === 0) {
    elements.push(createTextElement({
      content: '空白幻灯片',
      x: 25, y: 40, width: 50, height: 15,
      fontSize: 28,
      color: theme.textColor,
      textAlign: 'center',
      zIndex: 0,
    }));
  }

  return {
    id: `slide-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    index: 0,
    elements,
    background: theme.backgroundColor,
    notes: '',
  };
}

// ========== 辅助函数 ==========

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, '').trim();
}
