/**
 * PPTX 导入器 (P2-14)
 *
 * 解析 .pptx 文件 (OOXML 格式) 并转换为 V2SlideDeck。
 * PPTX 本质是 ZIP 包，内部包含 slide XML 文件。
 *
 * 实现策略:
 * 1. 用 JSZip 解压 PPTX
 * 2. 用 DOMParser 解析每页 slide XML
 * 3. 提取文本、形状、图片、位置/尺寸
 * 4. 将 EMU 单位转换为百分比坐标
 * 5. 图片提取为 base64 data URL
 *
 * 对标 oh-my-ppt 的 pptx2json，但我们使用标准 Web API。
 *
 * 限制:
 * - 复杂图表/SmartArt 降级为文本
 * - 渐变/阴影等复杂样式简化处理
 * - 嵌入视频/音频不支持
 */

import JSZip from 'jszip';
import {
  type V2SlideDeck, type V2Slide, type SlideElement,
  type PPTTheme, type TextElement, type ShapeElement, type ImageElement,
  createTextElement, createShapeElement, createImageElement, createListElement, createElementId,
} from './ppt-types';

// EMU (English Metric Units) → 像素转换
// 1 inch = 914400 EMU, 1 inch = 96 px (标准 DPI)
const EMU_PER_PX = 914400 / 96;
// 标准 PPT 尺寸: 13.333 inch × 7.5 inch = 1280 × 720 px
const DEFAULT_SLIDE_WIDTH_EMU = 12192000; // 13.333"
const DEFAULT_SLIDE_HEIGHT_EMU = 6858000;  // 7.5"

/**
 * 主入口 — 从 ArrayBuffer 解析 PPTX
 */
export async function importPPTX(data: ArrayBuffer): Promise<V2SlideDeck> {
  const zip = await JSZip.loadAsync(data);

  // 1. 读取 Presentation.xml 获取幻灯片列表和尺寸
  const presXmlStr = await zip.file('ppt/presentation.xml')?.async('text');
  if (!presXmlStr) throw new Error('Invalid PPTX: missing presentation.xml');

  const parser = new DOMParser();
  const presXml = parser.parseFromString(presXmlStr, 'application/xml');

  // 提取幻灯片尺寸
  const sldSz = presXml.getElementsByTagName('p:sldSz')[0];
  let slideWidthEmu = DEFAULT_SLIDE_WIDTH_EMU;
  let slideHeightEmu = DEFAULT_SLIDE_HEIGHT_EMU;
  if (sldSz) {
    slideWidthEmu = parseInt(sldSz.getAttribute('cx') || '') || DEFAULT_SLIDE_WIDTH_EMU;
    slideHeightEmu = parseInt(sldSz.getAttribute('cy') || '') || DEFAULT_SLIDE_HEIGHT_EMU;
  }

  // 像素尺寸
  const canvasWidth = Math.round(slideWidthEmu / EMU_PER_PX);
  const canvasHeight = Math.round(slideHeightEmu / EMU_PER_PX);

  // 2. 获取幻灯片列表 (按顺序)
  const sldIdLst = presXml.getElementsByTagName('p:sldIdLst')[0];
  if (!sldIdLst) throw new Error('Invalid PPTX: missing slide list');

  const slideIds = Array.from(sldIdLst.getElementsByTagName('p:sldId'));
  const slideRIds = slideIds.map(s => s.getAttribute('r:id') || '').filter(Boolean);

  // 3. 读取 presentation.xml.rels 获取 slide 文件路径
  const relsXmlStr = await zip.file('ppt/_rels/presentation.xml.rels')?.async('text');
  if (!relsXmlStr) throw new Error('Invalid PPTX: missing presentation rels');

  const relsXml = parser.parseFromString(relsXmlStr, 'application/xml');
  const relationships = Array.from(relsXml.getElementsByTagName('Relationship'));

  const slideFiles: { path: string; number: number }[] = [];
  for (let i = 0; i < slideRIds.length; i++) {
    const rid = slideRIds[i];
    const rel = relationships.find(r => r.getAttribute('Id') === rid);
    if (rel) {
      const target = rel.getAttribute('Target') || '';
      const path = target.startsWith('/') ? target.slice(1) : `ppt/${target}`;
      slideFiles.push({ path, number: i + 1 });
    }
  }

  if (slideFiles.length === 0) throw new Error('No slides found in PPTX');

  // 4. 提取主题颜色 (提前提取，供后续使用)
  const theme = await extractTheme(zip, parser);

  // 5. 解析每页幻灯片
  const slides: V2Slide[] = [];
  for (const sf of slideFiles) {
    const slideXmlStr = await zip.file(sf.path)?.async('text');
    if (!slideXmlStr) continue;

    const slideXml = parser.parseFromString(slideXmlStr, 'application/xml');

    // 读取 rels
    const relsPath = sf.path.replace(/([^/]+)$/, '_rels/$1.rels');
    const slideRelsStr = await zip.file(relsPath)?.async('text');
    const slideRels = slideRelsStr ? parser.parseFromString(slideRelsStr, 'application/xml') : null;

    // 提取媒体文件映射
    const mediaMap = new Map<string, string>();
    if (slideRels) {
      const rels = Array.from(slideRels.getElementsByTagName('Relationship'));
      for (const rel of rels) {
        const type = rel.getAttribute('Type') || '';
        if (type.includes('image')) {
          const rid = rel.getAttribute('Id') || '';
          const target = rel.getAttribute('Target') || '';
          const mediaPath = target.startsWith('/') ? target.slice(1) : `ppt/${target.replace('../', '')}`;
          const mediaFile = zip.file(mediaPath);
          if (mediaFile) {
            const ext = mediaPath.split('.').pop()?.toLowerCase() || 'png';
            const base64 = await mediaFile.async('base64');
            mediaMap.set(rid, `data:image/${ext};base64,${base64}`);
          }
        }
      }
    }

    const elements = parseSlideElements(slideXml, slideWidthEmu, slideHeightEmu, mediaMap, theme.accentColor);
    const background = extractBackground(slideXml);

    slides.push({
      id: createElementId(),
      index: sf.number - 1,
      elements,
      background: background || theme.backgroundColor,
      notes: '',
    });
  }

  // 6. 尝试从 docProps/core.xml 提取标题
  let title = 'Imported PPT';
  try {
    const coreXmlStr = await zip.file('docProps/core.xml')?.async('text');
    if (coreXmlStr) {
      const coreXml = parser.parseFromString(coreXmlStr, 'application/xml');
      const titleEl = coreXml.getElementsByTagName('dc:title')[0];
      if (titleEl && titleEl.textContent) title = titleEl.textContent;
    }
  } catch {}

  return {
    title,
    theme,
    slides,
    canvasWidth,
    canvasHeight,
  };
}

/**
 * 解析单页幻灯片的元素
 */
function parseSlideElements(
  slideXml: Document,
  slideWidthEmu: number,
  slideHeightEmu: number,
  mediaMap: Map<string, string>,
  accentColor: string,
): SlideElement[] {
  const elements: SlideElement[] = [];
  let zIndex = 0;

  // 查找所有 sp (shape) 和 pic (picture) 元素
  const shapes = slideXml.getElementsByTagName('p:sp');
  const pics = slideXml.getElementsByTagName('p:pic');

  for (let i = 0; i < shapes.length; i++) {
    const sp = shapes[i];
    const el = parseShape(sp, slideWidthEmu, slideHeightEmu, zIndex++, accentColor);
    if (el) elements.push(el);
  }

  for (let i = 0; i < pics.length; i++) {
    const pic = pics[i];
    const el = parsePicture(pic, slideWidthEmu, slideHeightEmu, mediaMap, zIndex++);
    if (el) elements.push(el);
  }

  return elements;
}

/**
 * 将 EMU 坐标转换为百分比
 */
function emuToPercent(emu: number, totalEmu: number): number {
  return (emu / totalEmu) * 100;
}

/**
 * 解析形状元素
 */
function parseShape(
  sp: Element,
  slideWidthEmu: number,
  slideHeightEmu: number,
  zIndex: number,
  accentColor: string,
): SlideElement | null {
  // 获取位置和尺寸
  const off = sp.getElementsByTagName('a:off')[0];
  const ext = sp.getElementsByTagName('a:ext')[0];

  if (!off || !ext) return null;

  const x = emuToPercent(parseInt(off.getAttribute('x') || '0'), slideWidthEmu);
  const y = emuToPercent(parseInt(off.getAttribute('y') || '0'), slideHeightEmu);
  const width = emuToPercent(parseInt(ext.getAttribute('cx') || '0'), slideWidthEmu);
  const height = emuToPercent(parseInt(ext.getAttribute('cy') || '0'), slideHeightEmu);

  // 提取文本
  const textRuns = sp.getElementsByTagName('a:r');
  const texts: string[] = [];
  for (let i = 0; i < textRuns.length; i++) {
    const t = textRuns[i].getElementsByTagName('a:t')[0];
    if (t && t.textContent) texts.push(t.textContent);
  }

  // 提取填充颜色
  const solidFill = sp.getElementsByTagName('a:solidFill')[0];
  let fill = accentColor;
  if (solidFill) {
    const srgb = solidFill.getElementsByTagName('a:srgbClr')[0];
    if (srgb) {
      const val = srgb.getAttribute('val') || '';
      if (val) fill = `#${val}`;
    }
  }

  // 判断是文本框还是形状
  const txBody = sp.getElementsByTagName('p:txBody')[0];
  const hasText = texts.length > 0;

  // 获取形状类型
  const prstGeom = sp.getElementsByTagName('a:prstGeom')[0];
  const shapeType = prstGeom?.getAttribute('prst') || '';

  // 如果有文本内容，优先创建文本元素
  if (hasText && txBody) {
    const content = texts.join('\n');
    const firstRun = textRuns[0];
    const rPr = firstRun?.getElementsByTagName('a:rPr')[0];

    const fontSize = rPr ? parseInt(rPr.getAttribute('sz') || '2800') / 100 : 28;
    const isBold = rPr?.getAttribute('b') === '1';
    const colorEl = rPr?.getElementsByTagName('a:srgbClr')[0];
    const textColor = colorEl ? `#${colorEl.getAttribute('val')}` : '#333333';

    // 检查对齐
    let align: 'left' | 'center' | 'right' = 'left';
    const alignAttr = sp.getElementsByTagName('a:pPr')[0]?.getAttribute('algn');
    if (alignAttr === 'ctr') align = 'center';
    else if (alignAttr === 'r') align = 'right';

    // 如果是多行文本且像列表，创建 list 元素
    const lines = content.split('\n').filter(l => l.trim());
    if (lines.length > 2 && shapeType === '') {
      return createListElement({
        x, y, width, height,
        items: lines,
        fontSize: Math.max(12, Math.min(48, fontSize)),
        color: textColor,
        bulletColor: accentColor,
        zIndex,
      });
    }

    return createTextElement({
      x, y, width, height,
      content,
      fontSize: Math.max(12, Math.min(72, fontSize)),
      fontWeight: isBold ? 'bold' : 'normal',
      color: textColor,
      textAlign: align,
      zIndex,
      backgroundColor: fill !== accentColor && shapeType !== '' ? fill : 'transparent',
      borderRadius: shapeType === 'roundRect' ? 8 : 0,
    });
  }

  // 纯形状
  let mappedShape: ShapeElement['shape'] = 'rect';
  if (shapeType === 'roundRect') mappedShape = 'rounded';
  else if (shapeType === 'ellipse') mappedShape = 'circle';
  else if (shapeType === 'triangle') mappedShape = 'triangle';
  else if (shapeType === 'line') mappedShape = 'line';

  return createShapeElement({
    x, y, width, height,
    fill,
    shape: mappedShape,
    zIndex,
  });
}

/**
 * 解析图片元素
 */
function parsePicture(
  pic: Element,
  slideWidthEmu: number,
  slideHeightEmu: number,
  mediaMap: Map<string, string>,
  zIndex: number,
): ImageElement | null {
  const off = pic.getElementsByTagName('a:off')[0];
  const ext = pic.getElementsByTagName('a:ext')[0];
  if (!off || !ext) return null;

  const x = emuToPercent(parseInt(off.getAttribute('x') || '0'), slideWidthEmu);
  const y = emuToPercent(parseInt(off.getAttribute('y') || '0'), slideHeightEmu);
  const width = emuToPercent(parseInt(ext.getAttribute('cx') || '0'), slideWidthEmu);
  const height = emuToPercent(parseInt(ext.getAttribute('cy') || '0'), slideHeightEmu);

  // 获取图片引用
  const blipFill = pic.getElementsByTagName('a:blipFill')[0];
  const blip = blipFill?.getElementsByTagName('a:blip')[0];
  if (!blip) return null;

  const embed = blip.getAttribute('r:embed') || '';
  const src = mediaMap.get(embed);
  if (!src) return null;

  return createImageElement({
    x, y, width, height,
    src,
    zIndex,
    objectFit: 'cover',
    borderRadius: 0,
  });
}

/**
 * 提取幻灯片背景色
 */
function extractBackground(slideXml: Document): string | null {
  const bg = slideXml.getElementsByTagName('p:bg')[0];
  if (!bg) return null;

  const solidFill = bg.getElementsByTagName('a:solidFill')[0];
  if (solidFill) {
    const srgb = solidFill.getElementsByTagName('a:srgbClr')[0];
    if (srgb) {
      const val = srgb.getAttribute('val') || '';
      if (val) return `#${val}`;
    }
  }
  return null;
}

/**
 * 从 theme XML 提取颜色方案
 */
async function extractTheme(zip: JSZip, parser: DOMParser): Promise<PPTTheme> {
  // 查找 theme 文件
  const themeFile = Object.keys(zip.files).find(path => path.match(/ppt\/theme\/theme1\.xml$/));
  if (!themeFile) return PPT_DEFAULT_THEME;

  const themeXmlStr = await zip.file(themeFile)?.async('text');
  if (!themeXmlStr) return PPT_DEFAULT_THEME;

  const themeXml = parser.parseFromString(themeXmlStr, 'application/xml');

  // 提取颜色方案
  const clrScheme = themeXml.getElementsByTagName('a:clrScheme')[0];
  const colors: Record<string, string> = {};

  if (clrScheme) {
    for (const child of Array.from(clrScheme.children)) {
      const srgb = child.getElementsByTagName('a:srgbClr')[0];
      const sysClr = child.getElementsByTagName('a:sysClr')[0];
      if (srgb) {
        colors[child.localName] = `#${srgb.getAttribute('val')}`;
      } else if (sysClr) {
        const sysVal = sysClr.getAttribute('val') || '';
        const lastClr = sysClr.getAttribute('lastClr') || '';
        if (lastClr) colors[child.localName] = `#${lastClr}`;
        else if (sysVal === 'window') colors[child.localName] = '#ffffff';
      }
    }
  }

  // 提取字体方案
  const fontScheme = themeXml.getElementsByTagName('a:fontScheme')[0];
  let fontFamily = "'Microsoft YaHei', 'Segoe UI', sans-serif";
  if (fontScheme) {
    const latinFont = fontScheme.getElementsByTagName('a:latin')[0];
    const typeface = latinFont?.getAttribute('typeface') || '';
    if (typeface) fontFamily = `'${typeface}', 'Microsoft YaHei', sans-serif`;
  }

  return {
    id: 'pptx-imported',
    name: 'Imported Theme',
    primaryColor: colors.dk1 || '#333333',
    secondaryColor: colors.dk2 || '#4a4a4a',
    accentColor: colors.accent1 || colors.accent3 || '#7c6cf0',
    backgroundColor: colors.lt1 || '#ffffff',
    textColor: colors.dk1 || '#333333',
    fontFamily,
  };
}

const PPT_DEFAULT_THEME: PPTTheme = {
  id: 'pptx-imported',
  name: 'Imported Theme',
  primaryColor: '#333333',
  secondaryColor: '#4a4a4a',
  accentColor: '#7c6cf0',
  backgroundColor: '#ffffff',
  textColor: '#333333',
  fontFamily: "'Microsoft YaHei', 'Segoe UI', sans-serif",
};
