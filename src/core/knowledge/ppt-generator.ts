/**
 * PPT 幻灯片生成器
 *
 * 借鉴思路来源: oh-my-ppt (https://github.com/arcsin1/oh-my-ppt)
 * 该项目使用 Electron + 自研编辑器 + PptxGenJS 生成和导出 PPT;
 * 我们自研实现:
 * - 使用 Tauri (已有) 而非 Electron
 * - AI 生成结构化元素模型 (V2), 支持 DOM 绝对定位渲染
 * - 可视化编辑器: 选区/拖拽/缩放/属性面板
 * - 不依赖 PptxGenJS
 *
 * 核心差异:
 * - oh-my-ppt 是独立 PPT 应用; 我们将 PPT 作为笔记本笔记的一种类型
 * - oh-my-ppt 使用 Drizzle ORM; 我们复用现有 SQLite
 * - oh-my-ppt 有完整编辑器; 我们实现完整的可视化编辑器
 *
 * 向后兼容: 自动迁移旧 HTML 格式 Slide 到新 V2Slide 元素模型
 */

import {
  type V2SlideDeck, type V2Slide, type SlideElement,
  createTextElement, createListElement, createShapeElement,
  migrateHTMLSlide, PPT_THEMES, type PPTTheme,
} from './ppt-types';
import { extractJSON } from '../llm/output-parser';

// 旧类型兼容
type OldSlide = { id: string; index: number; html: string; layout: string; notes?: string };
type OldDeck = { title: string; theme: PPTTheme; slides: OldSlide[] };

/**
 * 调用 LLM 生成 PPT 内容 (元素模型版本)
 *
 * AI 返回结构化的幻灯片大纲, 我们生成元素模型而非 HTML
 */
export async function generatePPTContent(
  notebookId: string,
  topic?: string,
  slideCount: number = 8,
  themeId: string = 'default',
): Promise<V2SlideDeck> {
  const { getChunks } = await import('./storage');
  const chunks = getChunks(notebookId);
  if (chunks.length === 0) throw new Error('No indexed content available');

  // Gather text content
  const allText = chunks
    .slice(0, 60)
    .map((c) => c.content)
    .join('\n\n')
    .slice(0, 12000);

  const { getSettingJSON } = await import('../storage/settings');
  const settings = getSettingJSON<any>('codem-settings', {});
  const model = settings.model || 'gpt-4o-mini';

  const { createDefaultProviders } = await import('../llm/provider');
  const registry = createDefaultProviders();
  const provider = registry.getConfigured()[0];
  if (!provider) throw new Error('No LLM provider available');

  const isZh = navigator.language?.startsWith('zh');
  const theme = PPT_THEMES.find(t => t.id === themeId) || PPT_THEMES[0];

  const systemPrompt = isZh
    ? '你是一个演示文稿内容生成助手。根据知识库内容生成结构化的幻灯片大纲。只返回 JSON 格式。'
    : 'You are a presentation content generator. Generate structured slide outlines based on knowledge base content. Return only JSON format.';

  const userPrompt = isZh
    ? `基于以下知识库内容，生成一份 ${slideCount} 页的演示文稿大纲。

${topic ? `主题: ${topic}\n` : ''}要求：
1. 第一页为标题页，最后一页为总结/结论页
2. 每页包含 title, content (正文要点，用换行分隔), layout, notes (演讲备注)
3. layout 可选值: title, title_content, two_column, section, conclusion
4. 正文简练，每页 3-5 个要点

返回严格 JSON 格式:
{"title":"演示文稿标题","slides":[{"title":"页面标题","content":"要点1\\n要点2\\n要点3","layout":"title_content","notes":"演讲备注"}]}

知识库内容:
${allText}`
    : `Generate a ${slideCount}-slide presentation outline based on the following knowledge base content.

${topic ? `Topic: ${topic}\n` : ''}Requirements:
1. First slide is a title page, last slide is a conclusion page
2. Each slide includes: title, content (bullet points separated by newlines), layout, notes (speaker notes)
3. layout options: title, title_content, two_column, section, conclusion
4. Keep content concise, 3-5 bullet points per slide

Return strict JSON format:
{"title":"Presentation Title","slides":[{"title":"Slide Title","content":"Point 1\\nPoint 2\\nPoint 3","layout":"title_content","notes":"Speaker notes"}]}

Knowledge base content:
${allText}`;

  const response = await provider.complete({
    model,
    messages: [
      { id: 'ppt-sys', role: 'system', content: systemPrompt },
      { id: 'ppt-user', role: 'user', content: userPrompt },
    ],
    stream: false,
  });

  const content = response.content?.trim() || '';

  // 健壮的 JSON 解析 — 使用 extractJSON 处理 markdown 包裹、中文标点、尾部逗号等
  const parsed = extractJSON<{ title: string; slides: Array<{ title: string; content: string; layout: string; notes?: string }> }>(content);

  let outline: { title: string; slides: Array<{ title: string; content: string; layout: string; notes?: string }> };
  if (parsed && parsed.slides && Array.isArray(parsed.slides)) {
    outline = parsed;
  } else {
    // Fallback: create a simple single-slide deck
    outline = {
      title: topic || 'Knowledge Base Presentation',
      slides: [{
        title: topic || 'Overview',
        content: 'Failed to generate detailed slides. Please try again.',
        layout: 'title_content',
        notes: '',
      }],
    };
  }

  // Convert outline to element-based slides
  const slides: V2Slide[] = outline.slides.map((s, index) =>
    generateV2SlideFromOutline(s.title, s.content, s.layout as any, theme, index)
  );

  return {
    title: outline.title,
    theme,
    slides,
    canvasWidth: 1280,
    canvasHeight: 720,
  };
}

/**
 * 根据大纲生成基于元素的幻灯片
 */
function generateV2SlideFromOutline(
  title: string,
  content: string,
  layout: 'title' | 'title_content' | 'two_column' | 'section' | 'conclusion',
  theme: PPTTheme,
  index: number,
): V2Slide {
  const elements: SlideElement[] = [];
  const bulletPoints = content
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0);

  switch (layout) {
    case 'title': {
      // 装饰形状 (左侧色条)
      elements.push(
        createShapeElement({
          x: 0, y: 0, width: 3, height: 100,
          shape: 'rect',
          fill: theme.accentColor,
          stroke: 'transparent',
          zIndex: 0,
        })
      );
      // 标题
      elements.push(
        createTextElement({
          x: 15, y: 35, width: 70, height: 15,
          content: title,
          fontSize: 56,
          fontWeight: 'bold',
          color: theme.primaryColor,
          textAlign: 'center',
          zIndex: 1,
        })
      );
      // 副标题 (第一行内容)
      if (bulletPoints.length > 0) {
        elements.push(
          createTextElement({
            x: 15, y: 55, width: 70, height: 8,
            content: bulletPoints[0],
            fontSize: 28,
            color: theme.primaryColor + 'cc',
            textAlign: 'center',
            zIndex: 1,
          })
        );
      }
      break;
    }

    case 'section': {
      elements.push(
        createShapeElement({
          x: 0, y: 0, width: 5, height: 6,
          shape: 'rect',
          fill: theme.accentColor,
          stroke: 'transparent',
          zIndex: 0,
        })
      );
      elements.push(
        createTextElement({
          x: 10, y: 42, width: 80, height: 12,
          content: title,
          fontSize: 56,
          fontWeight: 'bold',
          color: theme.primaryColor,
          zIndex: 1,
        })
      );
      break;
    }

    case 'conclusion': {
      elements.push(
        createTextElement({
          x: 15, y: 30, width: 70, height: 12,
          content: title,
          fontSize: 48,
          fontWeight: 'bold',
          color: '#ffffff',
          textAlign: 'center',
          zIndex: 1,
        })
      );
      if (bulletPoints.length > 0) {
        elements.push(
          createListElement({
            x: 25, y: 48, width: 50, height: 30,
            items: bulletPoints,
            fontSize: 26,
            color: '#ffffffcc',
            bulletColor: theme.accentColor,
            zIndex: 1,
          })
        );
      }
      break;
    }

    case 'two_column': {
      // 色条
      elements.push(
        createShapeElement({
          x: 0, y: 0, width: 1, height: 100,
          shape: 'rect',
          fill: theme.accentColor,
          stroke: 'transparent',
          zIndex: 0,
        })
      );
      // 标题
      elements.push(
        createTextElement({
          x: 5, y: 5, width: 90, height: 10,
          content: title,
          fontSize: 40,
          fontWeight: 'bold',
          color: theme.primaryColor,
          zIndex: 1,
        })
      );
      // 左列 (要点)
      elements.push(
        createListElement({
          x: 5, y: 18, width: 42, height: 60,
          items: bulletPoints.slice(0, Math.ceil(bulletPoints.length / 2)),
          fontSize: 22,
          color: theme.textColor,
          bulletColor: theme.accentColor,
          zIndex: 1,
        })
      );
      // 右列 (占位)
      elements.push(
        createTextElement({
          x: 52, y: 18, width: 42, height: 60,
          content: bulletPoints.slice(Math.ceil(bulletPoints.length / 2)).join('\n'),
          fontSize: 20,
          color: theme.textColor + '80',
          zIndex: 1,
        })
      );
      break;
    }

    case 'title_content':
    default: {
      // 色条
      elements.push(
        createShapeElement({
          x: 0, y: 0, width: 1, height: 100,
          shape: 'rect',
          fill: theme.accentColor,
          stroke: 'transparent',
          zIndex: 0,
        })
      );
      // 标题
      elements.push(
        createTextElement({
          x: 5, y: 5, width: 90, height: 10,
          content: title,
          fontSize: 40,
          fontWeight: 'bold',
          color: theme.secondaryColor,
          zIndex: 1,
        })
      );
      // 列表
      if (bulletPoints.length > 0) {
        elements.push(
          createListElement({
            x: 8, y: 18, width: 84, height: 65,
            items: bulletPoints,
            fontSize: 24,
            color: theme.textColor,
            bulletColor: theme.accentColor,
            zIndex: 1,
          })
        );
      }
      break;
    }
  }

  return {
    id: `slide-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 8)}`,
    index,
    elements,
    background: layout === 'conclusion' || layout === 'title' ? theme.primaryColor : theme.backgroundColor,
    notes: '',
  };
}

/** HTML 转义 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/** 向后兼容: 将旧 SlideDeck 迁移到新 V2SlideDeck */
export function migrateOldDeck(oldDeck: OldDeck): V2SlideDeck {
  const slides: V2Slide[] = oldDeck.slides.map(s => migrateHTMLSlide(s.html, oldDeck.theme));
  return {
    title: oldDeck.title,
    theme: oldDeck.theme,
    slides,
    canvasWidth: 1280,
    canvasHeight: 720,
  };
}

/** 将 V2SlideDeck 序列化为 JSON 字符串（存储为 note content） */
export function serializeSlideDeck(deck: V2SlideDeck): string {
  return JSON.stringify({ ...deck, __version: 2 });
}

/** 从 JSON 字符串反序列化 SlideDeck (自动检测新旧格式) */
export function deserializeSlideDeck(content: string): V2SlideDeck | null {
  try {
    const parsed = JSON.parse(content);

    // 新版本 (V2)
    if (parsed.__version === 2) {
      const { __version, ...deck } = parsed;
      return deck as V2SlideDeck;
    }

    // 旧版本 (HTML 格式) — 自动迁移
    if (parsed.slides && Array.isArray(parsed.slides) && parsed.slides[0]?.html) {
      return migrateOldDeck(parsed as OldDeck);
    }

    return null;
  } catch {
    return null;
  }
}
