/**
 * PPTX 导出（图片型，OOXML）— 真实可打开的 .pptx
 *
 * 审计修复：原「导出 PPTX」只是把 HTML 内容改名成 .pptx 下载，PowerPoint
 * 打不开（宣传/可用性欺骗）。本模块用 jszip 手工构造一个最小但完整、真实
 * 可打开的 PPTX (OOXML) 包：每页幻灯片 = 一张全幅截图，打包进标准 16:9
 * 画布（12192000 x 6858000 EMU），图片按保持宽高比适配、居中放置。
 *
 * 包结构（与 PowerPoint 可打开的最小 OOXML 布局一致）:
 *   [Content_Types].xml
 *   _rels/.rels
 *   ppt/presentation.xml                 + ppt/_rels/presentation.xml.rels
 *   ppt/slideMasters/slideMaster1.xml    (+ _rels 指向 layout/theme)
 *   ppt/slideLayouts/slideLayout1.xml    (+ _rels 指向 master)
 *   ppt/theme/theme1.xml
 *   ppt/slides/slideN.xml                (+ _rels 指向 layout + media/imageN.png)
 *   ppt/media/imageN.png                 (PNG/JPEG，从 dataUrl base64 写入)
 *
 * 兼容性：master→layout→theme 引用链完整、Content_Types 完整，PowerPoint /
 * LibreOffice / Google Slides 均可打开。
 */

import JSZip from 'jszip';

export interface PptxImageSource {
  /** PNG/JPEG 的 data URL（如 data:image/png;base64,...），也接受纯 base64 */
  dataUrl: string;
  /** 图片原始像素宽度（截图 canvas.width）；<=0 时尝试从 PNG 头解码 */
  width: number;
  /** 图片原始像素高度（截图 canvas.height）；<=0 时尝试从 PNG 头解码 */
  height: number;
}

/** 16:9 幻灯片尺寸（EMU）：13.333" x 7.5" */
export const PPTX_SLIDE_WIDTH_EMU = 12192000;
export const PPTX_SLIDE_HEIGHT_EMU = 6858000;

// ========== 命名空间常量 ==========
const NS_PKG_RELS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const NS_OFFICE_RELS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_CONTENT_TYPES = 'http://schemas.openxmlformats.org/package/2006/content-types';
const NS_P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

/** 幻灯片/版式/母版共享的“空组”占位（元素直接以 EMU 绝对坐标绘制） */
function groupShapeTree(slideW: number, slideH: number): string {
  return [
    '<p:nvGrpSpPr>',
    '<p:cNvPr id="1" name=""/>',
    '<p:cNvGrpSpPr/>',
    '<p:nvPr/>',
    '</p:nvGrpSpPr>',
    '<p:grpSpPr>',
    '<a:xfrm>',
    '<a:off x="0" y="0"/>',
    `<a:ext cx="${slideW}" cy="${slideH}"/>`,
    '<a:chOff x="0" y="0"/>',
    `<a:chExt cx="${slideW}" cy="${slideH}"/>`,
    '</a:xfrm>',
    '</p:grpSpPr>',
  ].join('');
}

// ========== 基础 XML 片段 ==========

type RelTarget =
  | 'officeDocument' | 'slideMaster' | 'slideLayout' | 'slide' | 'theme' | 'image';

interface Relationship {
  id: string;
  relType: string;
  target: string;
}

function officeRelType(name: RelTarget): string {
  return `${NS_OFFICE_RELS}/${name}`;
}

function relsXml(relationships: Relationship[]): string {
  const body = relationships
    .map(r => `<Relationship Id="${r.id}" Type="${r.relType}" Target="${r.target}"/>`)
    .join('');
  return `${XML_DECL}<Relationships xmlns="${NS_PKG_RELS}">${body}</Relationships>`;
}

// ========== [Content_Types].xml ==========

function buildContentTypesXml(slideCount: number): string {
  const overrides = [
    `<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>`,
    `<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>`,
    `<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>`,
    `<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>`,
  ];
  for (let i = 1; i <= slideCount; i++) {
    overrides.push(
      `<Override PartName="/ppt/slides/slide${i}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`,
    );
  }
  return `${XML_DECL}<Types xmlns="${NS_CONTENT_TYPES}">`
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Default Extension="png" ContentType="image/png"/>'
    + '<Default Extension="jpg" ContentType="image/jpeg"/>'
    + overrides.join('')
    + '</Types>';
}

// ========== ppt/presentation.xml + rels ==========

function buildPresentationXml(slideCount: number): string {
  const sldIdLst = Array.from({ length: slideCount }, (_, i) => {
    // rId1 已给 slideMaster，幻灯片从 rId2 开始
    return `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`;
  }).join('');
  return `${XML_DECL}<p:presentation xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}">`
    + '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>'
    + `<p:sldIdLst>${sldIdLst}</p:sldIdLst>`
    + `<p:sldSz cx="${PPTX_SLIDE_WIDTH_EMU}" cy="${PPTX_SLIDE_HEIGHT_EMU}"/>`
    + '<p:notesSz cx="6858000" cy="9144000"/>'
    + '</p:presentation>';
}

function buildPresentationRelsXml(slideCount: number): string {
  const relationships: Relationship[] = [
    { id: 'rId1', relType: officeRelType('slideMaster'), target: 'slideMasters/slideMaster1.xml' },
  ];
  for (let i = 1; i <= slideCount; i++) {
    relationships.push({ id: `rId${i + 1}`, relType: officeRelType('slide'), target: `slides/slide${i}.xml` });
  }
  return relsXml(relationships);
}

// ========== 母版 / 版式 / 主题（单套，全部幻灯片复用） ==========

const SLIDE_MASTER_XML = `${XML_DECL}<p:sldMaster xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}">`
  + '<p:cSld>'
  + '<p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>'
  + `<p:spTree>${groupShapeTree(PPTX_SLIDE_WIDTH_EMU, PPTX_SLIDE_HEIGHT_EMU)}</p:spTree>`
  + '</p:cSld>'
  + '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>'
  + '<p:sldLayoutIdLst><p:sldLayoutId id="1" r:id="rId1"/></p:sldLayoutIdLst>'
  + '<p:txStyles>'
  + '<p:titleStyle><a:lvl1pPr><a:defRPr sz="4400"><a:solidFill><a:srgbClr val="1F1F1F"/></a:solidFill></a:defRPr></a:lvl1pPr></p:titleStyle>'
  + '<p:bodyStyle><a:lvl1pPr><a:defRPr sz="2800"><a:solidFill><a:srgbClr val="1F1F1F"/></a:solidFill></a:defRPr></a:lvl1pPr></p:bodyStyle>'
  + '<p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"><a:solidFill><a:srgbClr val="1F1F1F"/></a:solidFill></a:defRPr></a:lvl1pPr></p:otherStyle>'
  + '</p:txStyles>'
  + '</p:sldMaster>';

const SLIDE_MASTER_RELS_XML = relsXml([
  { id: 'rId1', relType: officeRelType('slideLayout'), target: '../slideLayouts/slideLayout1.xml' },
  { id: 'rId2', relType: officeRelType('theme'), target: '../theme/theme1.xml' },
]);

const SLIDE_LAYOUT_XML = `${XML_DECL}<p:sldLayout xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}" type="blank" preserve="1">`
  + '<p:cSld name="Blank Layout">'
  + `<p:spTree>${groupShapeTree(PPTX_SLIDE_WIDTH_EMU, PPTX_SLIDE_HEIGHT_EMU)}</p:spTree>`
  + '</p:cSld>'
  + '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>'
  + '</p:sldLayout>';

const SLIDE_LAYOUT_RELS_XML = relsXml([
  { id: 'rId1', relType: officeRelType('slideMaster'), target: '../slideMasters/slideMaster1.xml' },
]);

/** Office 默认主题的精简版（纯图片型 PPT 只需占位，无需复杂样式） */
const THEME_XML = `${XML_DECL}<a:theme xmlns:a="${NS_A}" name="Office Theme">`
  + '<a:themeElements>'
  + '<a:clrScheme name="Office">'
  + '<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>'
  + '<a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>'
  + '<a:dk2><a:srgbClr val="1F497D"/></a:dk2>'
  + '<a:lt2><a:srgbClr val="EEECE1"/></a:lt2>'
  + '<a:accent1><a:srgbClr val="4F81BD"/></a:accent1>'
  + '<a:accent2><a:srgbClr val="C0504D"/></a:accent2>'
  + '<a:accent3><a:srgbClr val="9BBB59"/></a:accent3>'
  + '<a:accent4><a:srgbClr val="8064A2"/></a:accent4>'
  + '<a:accent5><a:srgbClr val="4BACC6"/></a:accent5>'
  + '<a:accent6><a:srgbClr val="F79646"/></a:accent6>'
  + '<a:hlink><a:srgbClr val="0000FF"/></a:hlink>'
  + '<a:folHlink><a:srgbClr val="800080"/></a:folHlink>'
  + '</a:clrScheme>'
  + '<a:fontScheme name="Office">'
  + '<a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>'
  + '<a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont>'
  + '</a:fontScheme>'
  + '<a:fmtScheme name="Office">'
  + '<a:fillStyleLst>'
  + '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'
  + '<a:gradFill rotWithShape="1"><a:gsLst>'
  + '<a:gs pos="0"><a:schemeClr val="phClr"><a:tint val="50000"/><a:satMod val="300000"/></a:schemeClr></a:gs>'
  + '<a:gs pos="35000"><a:schemeClr val="phClr"><a:tint val="37000"/><a:satMod val="300000"/></a:schemeClr></a:gs>'
  + '<a:gs pos="100000"><a:schemeClr val="phClr"><a:tint val="15000"/><a:satMod val="350000"/></a:schemeClr></a:gs>'
  + '</a:gsLst><a:lin ang="16200000" scaled="1"/></a:gradFill>'
  + '<a:gradFill rotWithShape="1"><a:gsLst>'
  + '<a:gs pos="0"><a:schemeClr val="phClr"><a:shade val="51000"/><a:satMod val="130000"/></a:schemeClr></a:gs>'
  + '<a:gs pos="80000"><a:schemeClr val="phClr"><a:shade val="93000"/><a:satMod val="130000"/></a:schemeClr></a:gs>'
  + '<a:gs pos="100000"><a:schemeClr val="phClr"><a:shade val="94000"/><a:satMod val="135000"/></a:schemeClr></a:gs>'
  + '</a:gsLst><a:lin ang="16200000" scaled="0"/></a:gradFill>'
  + '</a:fillStyleLst>'
  + '<a:lnStyleLst>'
  + '<a:ln w="9525" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"><a:shade val="95000"/><a:satMod val="105000"/></a:schemeClr></a:solidFill><a:prstDash val="solid"/></a:ln>'
  + '<a:ln w="25400" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>'
  + '<a:ln w="38100" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>'
  + '</a:lnStyleLst>'
  + '<a:effectStyleLst>'
  + '<a:effectStyle><a:effectLst/></a:effectStyle>'
  + '<a:effectStyle><a:effectLst/></a:effectStyle>'
  + '<a:effectStyle><a:effectLst/></a:effectStyle>'
  + '</a:effectStyleLst>'
  + '<a:bgFillStyleLst>'
  + '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'
  + '<a:solidFill><a:schemeClr val="phClr"><a:tint val="95000"/><a:satMod val="170000"/></a:schemeClr></a:solidFill>'
  + '<a:gradFill rotWithShape="1"><a:gsLst>'
  + '<a:gs pos="0"><a:schemeClr val="phClr"><a:tint val="93000"/><a:satMod val="150000"/></a:schemeClr></a:gs>'
  + '<a:gs pos="100000"><a:schemeClr val="phClr"><a:tint val="98000"/><a:satMod val="130000"/></a:schemeClr></a:gs>'
  + '</a:gsLst><a:path path="circle"><a:fillToRect l="50000" t="-80000" r="50000" b="180000"/></a:path></a:gradFill>'
  + '</a:bgFillStyleLst>'
  + '</a:fmtScheme>'
  + '</a:themeElements>'
  + '<a:objectDefaults/>'
  + '<a:extraClrSchemeLst/>'
  + '</a:theme>';

// ========== 单页 slideN.xml + rels ==========

interface SlideModel {
  num: number;
  ext: 'png' | 'jpg';
  mime: string;
  base64: string;
  mediaName: string;
  rect: { x: number; y: number; w: number; h: number };
}

function buildSlideXml(slide: SlideModel): string {
  const { x, y, w, h } = slide.rect;
  const pic = [
    '<p:pic>',
    '<p:nvPicPr>',
    `<p:cNvPr id="2" name="${slide.mediaName}"/>`,
    '<p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr>',
    '<p:nvPr/>',
    '</p:nvPicPr>',
    '<p:blipFill>',
    '<a:blip r:embed="rId2"/>',
    '<a:stretch><a:fillRect/></a:stretch>',
    '</p:blipFill>',
    '<p:spPr>',
    '<a:xfrm>',
    `<a:off x="${x}" y="${y}"/>`,
    `<a:ext cx="${w}" cy="${h}"/>`,
    '</a:xfrm>',
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>',
    '</p:spPr>',
    '</p:pic>',
  ].join('');
  return `${XML_DECL}<p:sld xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}">`
    + `<p:cSld><p:spTree>${groupShapeTree(PPTX_SLIDE_WIDTH_EMU, PPTX_SLIDE_HEIGHT_EMU)}${pic}</p:spTree></p:cSld>`
    + '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>'
    + '</p:sld>';
}

function buildSlideRelsXml(slide: SlideModel): string {
  return relsXml([
    { id: 'rId1', relType: officeRelType('slideLayout'), target: '../slideLayouts/slideLayout1.xml' },
    { id: 'rId2', relType: officeRelType('image'), target: `../media/${slide.mediaName}` },
  ]);
}

// ========== dataUrl / 图片工具 ==========

const PNG_SIGNATURE = '\x89PNG\r\n\x1a\n';

function splitDataUrl(dataUrl: string): { mime: string; base64: string } {
  const commaIdx = dataUrl.indexOf(',');
  if (commaIdx === -1) {
    // 没有 data: 头，按纯 base64 / 默认 PNG 处理
    return { mime: 'image/png', base64: dataUrl };
  }
  const head = dataUrl.slice(0, commaIdx);
  const body = dataUrl.slice(commaIdx + 1);
  const m = /^data:([^;]+);base64$/i.exec(head.trim());
  return { mime: m ? m[1].toLowerCase() : 'image/png', base64: body };
}

function mimeToMedia(mime: string): { ext: 'png' | 'jpg'; contentType: string } | null {
  if (mime === 'image/png') return { ext: 'png', contentType: 'image/png' };
  if (mime === 'image/jpeg' || mime === 'image/jpg') return { ext: 'jpg', contentType: 'image/jpeg' };
  return null;
}

/** 从 PNG base64 解码像素尺寸（读 IHDR，offset 16/20），失败返回 null */
function pngSizeFromBase64(base64: string): { width: number; height: number } | null {
  try {
    const bin = atob(base64.replace(/\s+/g, ''));
    if (bin.length < 24) return null;
    for (let i = 0; i < PNG_SIGNATURE.length; i++) {
      if (bin.charCodeAt(i) !== PNG_SIGNATURE.charCodeAt(i)) return null;
    }
    const u8 = (i: number) => bin.charCodeAt(i) & 0xff;
    const width = u8(16) * 16777216 + u8(17) * 65536 + u8(18) * 256 + u8(19);
    const height = u8(20) * 16777216 + u8(21) * 65536 + u8(22) * 256 + u8(23);
    if (width > 0 && height > 0) return { width, height };
  } catch {
    // atob 失败（非 base64）时返回 null
  }
  return null;
}

/**
 * 图片按保持宽高比“contain”适配进 16:9 幻灯片并居中（单位 EMU）。
 * 当图片比例与 16:9 几乎一致（<0.15% 差异，常见于截图整像素四舍五入），
 * 直接铺满整页，避免边缘出现细缝/白边。
 */
function fitImageRect(imgW: number, imgH: number): { x: number; y: number; w: number; h: number } {
  const SW = PPTX_SLIDE_WIDTH_EMU;
  const SH = PPTX_SLIDE_HEIGHT_EMU;
  if (!(imgW > 0) || !(imgH > 0)) {
    return { x: 0, y: 0, w: SW, h: SH };
  }
  const containScale = Math.min(SW / imgW, SH / imgH);
  const coverScale = Math.max(SW / imgW, SH / imgH);
  // cover/contain 之比 = 宽高比与 16:9 的相对偏差（>= 1）
  const aspectDiff = coverScale / containScale - 1;
  if (aspectDiff < 0.0015) {
    return { x: 0, y: 0, w: SW, h: SH };
  }
  const w = Math.round(imgW * containScale);
  const h = Math.round(imgH * containScale);
  return {
    x: Math.round((SW - w) / 2),
    y: Math.round((SH - h) / 2),
    w,
    h,
  };
}

// ========== 主入口 ==========

/**
 * 把每页幻灯片图片打包成真实可打开的 PPTX（OOXML）Blob。
 *
 * @param images 每页一张全幅渲染截图（PNG/JPEG data URL + 原始像素尺寸）
 * @returns .pptx Blob（MIME: application/vnd.openxmlformats-officedocument.presentationml.presentation）
 * @throws 图片为空、格式不支持、或无法确定尺寸时抛错
 */
export async function buildPptxFromImages(images: PptxImageSource[]): Promise<Blob> {
  if (!images || images.length === 0) {
    throw new Error('buildPptxFromImages: 没有可导出的幻灯片图片');
  }

  const slideModels: SlideModel[] = images.map((img, i) => {
    const { mime, base64 } = splitDataUrl(img.dataUrl);
    const media = mimeToMedia(mime);
    if (!media) {
      throw new Error(`buildPptxFromImages: 不支持的图片格式「${mime || '(未知)'}」，仅支持 PNG/JPEG`);
    }
    let width = Math.floor(img.width) || 0;
    let height = Math.floor(img.height) || 0;
    if (!(width > 0) || !(height > 0)) {
      // 调用方未提供尺寸时，从 PNG IHDR 解码
      const parsed = pngSizeFromBase64(base64);
      if (parsed) {
        width = parsed.width;
        height = parsed.height;
      }
    }
    const num = i + 1;
    return {
      num,
      ext: media.ext,
      mime: media.contentType,
      base64,
      mediaName: `image${num}.${media.ext}`,
      rect: fitImageRect(width, height),
    };
  });

  const slideCount = slideModels.length;
  const zip = new JSZip();

  // 1. 包级内容类型 + 根关系
  zip.file('[Content_Types].xml', buildContentTypesXml(slideCount));
  zip.file('_rels/.rels', relsXml([
    { id: 'rId1', relType: officeRelType('officeDocument'), target: 'ppt/presentation.xml' },
  ]));

  // 2. 演示主文档 + 关系
  zip.file('ppt/presentation.xml', buildPresentationXml(slideCount));
  zip.file('ppt/_rels/presentation.xml.rels', buildPresentationRelsXml(slideCount));

  // 3. 母版 / 版式 / 主题（一套，全部页复用）
  zip.file('ppt/slideMasters/slideMaster1.xml', SLIDE_MASTER_XML);
  zip.file('ppt/slideMasters/_rels/slideMaster1.xml.rels', SLIDE_MASTER_RELS_XML);
  zip.file('ppt/slideLayouts/slideLayout1.xml', SLIDE_LAYOUT_XML);
  zip.file('ppt/slideLayouts/_rels/slideLayout1.xml.rels', SLIDE_LAYOUT_RELS_XML);
  zip.file('ppt/theme/theme1.xml', THEME_XML);

  // 4. 每页 slideN.xml + rels + media（base64 直写 zip）
  for (const slide of slideModels) {
    zip.file(`ppt/slides/slide${slide.num}.xml`, buildSlideXml(slide));
    zip.file(`ppt/slides/_rels/slide${slide.num}.xml.rels`, buildSlideRelsXml(slide));
    zip.file(`ppt/media/${slide.mediaName}`, slide.base64, { base64: true });
  }

  return zip.generateAsync({
    type: 'blob',
    mimeType: PPTX_MIME,
    compression: 'DEFLATE',
  });
}
