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
  type PPTTheme,
  createTextElement, createListElement, createShapeElement,
  migrateHTMLSlide, PPT_THEMES,
} from './ppt-types';
import {
  type PPTStyle, type CanvasSize,
  PPT_STYLES, CANVAS_SIZES,
  getStyleById, getCanvasSizeById, getFontById,
  styleToTheme, getStyleBackground,
} from './ppt-styles';
import { extractJSON } from '../llm/output-parser';
import { registerOhMyPptSkills } from './ppt-skill-registry';

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
  styleId: string = 'business-blue',
  canvasSizeId: string = '16:9',
  enableImages: boolean = false,
  sourceIds?: string[],
  onProgress?: (stage: string, detail?: string) => void,
): Promise<V2SlideDeck> {
  // 注册 oh-my-ppt 项目的风格技能到 Cordis SkillRegistry（幂等，首次调用注册，后续跳过）
  try {
    const { getSkillRegistry } = await import('../skill/skill');
    registerOhMyPptSkills(getSkillRegistry());
  } catch (err) {
    console.warn('[ppt-generator] Failed to register oh-my-ppt skills:', err);
  }

  const { getChunks } = await import('./storage');
  onProgress?.('loading', '正在加载知识库内容...');
  let chunks = getChunks(notebookId);

  // 按选中来源过滤 (对标 NotebookLM 的来源选择器)
  if (sourceIds && sourceIds.length > 0) {
    chunks = chunks.filter(c => sourceIds.includes(c.sourceId));
  }

  if (chunks.length === 0) throw new Error('No indexed content available');

  // Gather text content
  const allText = chunks
    .slice(0, 60)
    .map((c) => c.content)
    .join('\n\n')
    .slice(0, 12000);
  onProgress?.('preparing', `已加载 ${chunks.length} 个知识片段，正在准备生成请求...`);

  const isZh = navigator.language?.startsWith('zh');
  const style = getStyleById(styleId) || PPT_STYLES[0];
  const canvasSize = getCanvasSizeById(canvasSizeId) || CANVAS_SIZES[0];

  const titleFont = getFontById(style.titleFontId);
  const bodyFont = getFontById(style.bodyFontId);
  const titleFontFamily = titleFont?.family || 'sans-serif';
  const bodyFontFamily = bodyFont?.family || 'sans-serif';

  const isPortrait = canvasSize.height > canvasSize.width;

  // 集成 oh-my-ppt 项目技能 — generatePPTContent 是单次 LLM 调用（非 agentic loop），
  // AI 无法使用 load_skill 工具，因此必须在调用前主动加载当前风格的 SKILL.md 内容注入 systemPrompt。
  // 只加载当前选中的 1 个风格 + 产品技能（layout/chart/anim），不会 token 爆炸。
  const styleSkillName = `ppt-style-${style.id}`;
  const { getSkillRegistry } = await import('../skill/skill');
  const skillRegistry = getSkillRegistry();

  // 主动加载当前风格的完整 SKILL.md 指令
  const styleSkill = skillRegistry.get(styleSkillName);
  const styleSkillPrompt = styleSkill?.prompt || '';

  // 按需加载产品技能（布局、图表、动画）
  const layoutSkill = skillRegistry.get('ppt-oh-my-ppt-layout');
  const chartSkill = skillRegistry.get('ppt-oh-my-ppt-chart');
  const animSkill = skillRegistry.get('ppt-oh-my-ppt-data-anim');

  const productSkillsSection = [
    layoutSkill?.prompt ? `### 布局规则\n${layoutSkill.prompt}` : '',
    chartSkill?.prompt ? `### 图表规则\n${chartSkill.prompt}` : '',
    animSkill?.prompt ? `### 动画规则\n${animSkill.prompt}` : '',
  ].filter(Boolean).join('\n\n');

  const systemPrompt = isZh
    ? `你是一个演示文稿内容生成助手。根据知识库内容生成结构化的幻灯片大纲。只返回 JSON 格式。

你正在使用「${style.name}」风格。以下是该风格的完整视觉指令（来自 oh-my-ppt 项目集成），生成内容时必须遵循：

${styleSkillPrompt}

${productSkillsSection ? `\n---\n${productSkillsSection}` : ''}

风格简述: ${style.description}。`
    : `You are a presentation content generator. Generate structured slide outlines based on knowledge base content. Return only JSON format.

You are using the "${style.name}" style. The following is the complete style skill prompt (integrated from the oh-my-ppt project). You MUST follow it when generating content:

${styleSkillPrompt}

${productSkillsSection ? `\n---\n${productSkillsSection}` : ''}

Style brief: ${style.description}.`;

  const userPrompt = isZh
    ? `基于以下知识库内容，生成一份 ${slideCount} 页的演示文稿大纲。

${topic ? `主题: ${topic}\n` : ''}要求：
1. 第一页为标题页，最后一页为总结/结论页
2. 每页包含 title, content (正文要点，用换行分隔), layout, notes (演讲备注)
3. layout 可选值: title, title_content, two_column, section, conclusion
4. 正文简练，每页 ${isPortrait ? '2-3' : '3-5'} 个要点${isPortrait ? '（竖屏画布，内容不宜过多）' : ''}
5. 风格: ${style.name} — ${style.description}
6. 严格遵循上方系统提示词中的风格技能指令

返回严格 JSON 格式:
{"title":"演示文稿标题","slides":[{"title":"页面标题","content":"要点1\\n要点2\\n要点3","layout":"title_content","notes":"演讲备注"}]}

知识库内容:
${allText}`
    : `Generate a ${slideCount}-slide presentation outline based on the following knowledge base content.

${topic ? `Topic: ${topic}\n` : ''}Requirements:
1. First slide is a title page, last slide is a conclusion page
2. Each slide includes: title, content (bullet points separated by newlines), layout, notes (speaker notes)
3. layout options: title, title_content, two_column, section, conclusion
4. Keep content concise, ${isPortrait ? '2-3' : '3-5'} bullet points per slide${isPortrait ? ' (portrait canvas, less content)' : ''}
5. Style: ${style.name} — ${style.description}
6. Follow the style skill instructions in the system prompt above

Return strict JSON format:
{"title":"Presentation Title","slides":[{"title":"Slide Title","content":"Point 1\\nPoint 2\\nPoint 3","layout":"title_content","notes":"Speaker notes"}]}

Knowledge base content:
${allText}`;

  // 使用主应用已初始化的 LLMEngine 单例 — 统一走 getConfiguredProvider
  // 避免绕过框架直接从 DB 读取 settings 的架构断点
  const { getLLMEngine } = await import('../llm/index');
  const engine = getLLMEngine();
  const { provider, model: actualModel } = engine.getConfiguredProvider('chat');
  console.log(`[ppt-generator] Using provider: ${provider.id}, model: ${actualModel}`);

  // 使用 streaming 模式 — 避免 max_tokens 截断，同时能实时反馈进度
  onProgress?.('generating', `AI 正在生成幻灯片大纲 (风格: ${style.name})...`);
  let content = '';
  let receivedChars = 0;
  try {
    const stream = await provider.stream({
      model: actualModel,
      messages: [
        { id: 'ppt-sys', role: 'system', content: systemPrompt },
        { id: 'ppt-user', role: 'user', content: userPrompt },
      ],
    });
    for await (const event of stream) {
      if (event.type === 'text_delta') {
        content += event.text;
        receivedChars += event.text.length;
        if (receivedChars % 500 < event.text.length) {
          onProgress?.('generating', `正在生成幻灯片内容... (${receivedChars} 字符)`);
        }
      }
    }
  } catch (err: any) {
    if (err?.message?.includes('Failed to fetch') || err?.message?.includes('NetworkError') || err?.message?.includes('network')) {
      throw new Error(
        `Network error when calling LLM API. Provider: ${provider.id}, Model: ${actualModel}. ` +
        `Please check your internet connection and API configuration. ` +
        `Original error: ${err.message}`
      );
    }
    throw err;
  }

  content = content.trim();
  onProgress?.('parsing', `AI 已生成 ${content.length} 字符，正在解析幻灯片结构...`);
  console.log('[ppt-generator] LLM response length:', content.length, 'preview:', content.substring(0, 200));

  if (!content) {
    throw new Error('LLM returned empty response. Please check your API key and model configuration.');
  }

  const parsed = extractJSON<{ title: string; slides: Array<{ title: string; content: string; layout: string; notes?: string }> }>(content);

  if (!parsed || !parsed.slides || !Array.isArray(parsed.slides)) {
    console.error('[ppt-generator] Failed to parse LLM response as JSON. Response:', content.substring(0, 500));
    throw new Error(
      `Failed to parse PPT outline from LLM response. ` +
      `Model: ${actualModel}, Response preview: "${content.substring(0, 200)}". ` +
      `Please try again or check if the selected model supports JSON output.`
    );
  }

  const outline = parsed;
  onProgress?.('building', `正在生成 ${outline.slides.length} 页幻灯片 (${style.name})...`);

  // Convert outline to element-based slides using style
  const theme = styleToTheme(style);
  let slides: V2Slide[] = outline.slides.map((sld, index) =>
    generateV2SlideFromOutline(sld.title, sld.content, sld.layout as any, style, theme, index, canvasSize, sld.notes)
  );

  // AI 自动配图 (如果启用且生图服务可用)
  if (enableImages) {
    const { isImageGenAvailable, autoGenerateImages } = await import('./ppt-image');
    if (isImageGenAvailable()) {
      onProgress?.('imaging', '正在为幻灯片生成 AI 配图...');
      try {
        slides = await autoGenerateImages(slides, style.name, (current, total, title) => {
          onProgress?.('imaging', `正在生成配图 (${current}/${total}) — ${title}`);
        });
      } catch (err) {
        console.warn('[ppt-generator] Auto image generation failed:', err);
      }
    }
  }

  return {
    title: outline.title,
    theme,
    slides,
    canvasWidth: canvasSize.width,
    canvasHeight: canvasSize.height,
    styleId: style.id,
    canvasSizeId: canvasSize.id,
  };
}

/**
 * 根据大纲和风格生成基于元素的幻灯片
 * 风格影响: 装饰元素、字体、字号、间距、对齐、背景
 */
function generateV2SlideFromOutline(
  title: string,
  content: string,
  layout: 'title' | 'title_content' | 'two_column' | 'section' | 'conclusion',
  style: PPTStyle,
  theme: PPTTheme,
  index: number,
  canvasSize: CanvasSize,
  notes?: string,
): V2Slide {
  // 清理 title 中的 markdown 标记
  const cleanTitle = title.replace(/\*\*(.+?)\*\*/g, '$1').replace(/\*(.+?)\*/g, '$1').trim();
  const elements: SlideElement[] = [];
  const bulletPoints = content
    .split('\n')
    .map(line => line.trim()
      .replace(/^[-•*\u2022]\s*/, '')  // 移除前导 bullet 符号
      .replace(/^\d+\.\s*/, '')       // 移除前导数字序号
      .replace(/\*\*(.+?)\*\*/g, '$1') // 移除 ** 加粗
      .replace(/\*(.+?)\*/g, '$1')     // 移除 * 斜体
      .replace(/__(.+?)__/g, '$1')     // 移除 __ 加粗
    )
    .filter(line => line.length > 0);

  const p = style.pagePadding;
  const sp = style.elementSpacing;
  const titleFont = getFontById(style.titleFontId);
  const bodyFont = getFontById(style.bodyFontId);
  const titleFamily = titleFont?.family || 'sans-serif';
  const bodyFamily = bodyFont?.family || 'sans-serif';
  const titleSize = Math.round(40 * style.titleSizeMultiplier);
  const bodySize = Math.round(24 * style.bodySizeMultiplier);
  const isPortrait = canvasSize.height > canvasSize.width;

  // 装饰元素生成 — 为每种 DecorationType 生成对应的视觉装饰
  const addDecoration = (deco: PPTStyle['decoration']) => {
    switch (deco) {
      // ─── 基础条/带类 ───
      case 'left-bar':
        elements.push(createShapeElement({
          x: 0, y: 0, width: 1.5, height: 100,
          shape: 'rect', fill: style.colors.accent, stroke: 'transparent', zIndex: 0,
        }));
        break;
      case 'top-bar':
        elements.push(createShapeElement({
          x: 0, y: 0, width: 100, height: 2,
          shape: 'rect', fill: style.colors.accent, stroke: 'transparent', zIndex: 0,
        }));
        break;
      case 'bottom-bar':
        elements.push(createShapeElement({
          x: 0, y: 98, width: 100, height: 2,
          shape: 'rect', fill: style.colors.accent, stroke: 'transparent', zIndex: 0,
        }));
        break;
      case 'top-bottom-bar':
        elements.push(createShapeElement({
          x: 0, y: 0, width: 100, height: 2,
          shape: 'rect', fill: style.colors.accent, stroke: 'transparent', zIndex: 0,
        }));
        elements.push(createShapeElement({
          x: 0, y: 98, width: 100, height: 2,
          shape: 'rect', fill: style.colors.accent, stroke: 'transparent', zIndex: 0,
        }));
        break;

      // ─── 角/三角类 ───
      case 'corner-triangle':
        elements.push(createShapeElement({
          x: 0, y: 0, width: 15, height: 15,
          shape: 'triangle', fill: style.colors.accent, stroke: 'transparent', zIndex: 0,
        }));
        break;

      // ─── 圆/点类 ───
      case 'circle-accent':
        elements.push(createShapeElement({
          x: 75, y: -5, width: 30, height: 30,
          shape: 'circle', fill: style.colors.accent + '22', stroke: 'transparent', zIndex: 0,
        }));
        elements.push(createShapeElement({
          x: -5, y: 75, width: 20, height: 20,
          shape: 'circle', fill: style.colors.primary + '15', stroke: 'transparent', zIndex: 0,
        }));
        break;
      case 'dots':
        // 点阵装饰 (右侧)
        for (let r = 0; r < 5; r++) {
          for (let c = 0; c < 8; c++) {
            elements.push(createShapeElement({
              x: 88 + c * 1.5, y: 5 + r * 4, width: 0.8, height: 0.8,
              shape: 'circle', fill: style.colors.accent + '22', stroke: 'transparent', zIndex: 0,
            }));
          }
        }
        break;

      // ─── 渐变/光效类 ───
      case 'gradient-band':
        elements.push(createShapeElement({
          x: 0, y: 0, width: 100, height: 100,
          shape: 'rect', fill: style.colors.accent + '08', stroke: 'transparent', zIndex: 0,
        }));
        elements.push(createShapeElement({
          x: p, y: 3, width: 100 - p * 2, height: 1.5,
          shape: 'rect', fill: style.colors.accent, stroke: 'transparent', zIndex: 0,
        }));
        break;
      case 'gradient-glow':
        // 大面积柔和光晕 + 顶部渐变带
        elements.push(createShapeElement({
          x: -20, y: -20, width: 70, height: 70,
          shape: 'circle', fill: style.colors.accent + '0c', stroke: 'transparent', zIndex: 0,
        }));
        elements.push(createShapeElement({
          x: 50, y: 50, width: 60, height: 60,
          shape: 'circle', fill: style.colors.secondary + '0a', stroke: 'transparent', zIndex: 0,
        }));
        elements.push(createShapeElement({
          x: 0, y: 0, width: 100, height: 3,
          shape: 'rect', fill: style.colors.accent + '55', stroke: 'transparent', zIndex: 0,
        }));
        elements.push(createShapeElement({
          x: 0, y: 97, width: 100, height: 3,
          shape: 'rect', fill: style.colors.accent + '33', stroke: 'transparent', zIndex: 0,
        }));
        break;

      // ─── 几何类 ───
      case 'geometric':
        elements.push(createShapeElement({
          x: 85, y: -10, width: 30, height: 30,
          shape: 'circle', fill: style.colors.accent + '11', stroke: 'transparent', zIndex: 0,
        }));
        elements.push(createShapeElement({
          x: -8, y: 80, width: 25, height: 25,
          shape: 'triangle', fill: style.colors.secondary + '0a', stroke: 'transparent', zIndex: 0,
        }));
        break;
      case 'split-color':
        elements.push(createShapeElement({
          x: 0, y: 0, width: 100, height: 35,
          shape: 'rect', fill: style.colors.primary, stroke: 'transparent', zIndex: 0,
        }));
        break;

      // ─── 网格/线条类 ───
      case 'grid':
        // 用多条线条模拟网格
        for (let i = 1; i < 6; i++) {
          elements.push(createShapeElement({
            x: 0, y: i * (100 / 6), width: 100, height: 0.1,
            shape: 'line', fill: 'transparent', stroke: style.colors.accent + '15', strokeWidth: 1, lineStyle: 'solid', zIndex: 0,
          }));
        }
        for (let i = 1; i < 8; i++) {
          elements.push(createShapeElement({
            x: i * (100 / 8), y: 0, width: 0.1, height: 100,
            shape: 'line', fill: 'transparent', stroke: style.colors.accent + '15', strokeWidth: 1, lineStyle: 'solid', zIndex: 0,
          }));
        }
        break;
      case 'swiss-line':
        // 瑞士国际主义风格：粗黑线条 + 严格网格
        elements.push(createShapeElement({
          x: 0, y: 0, width: 100, height: 3,
          shape: 'rect', fill: style.colors.primary, stroke: 'transparent', zIndex: 0,
        }));
        elements.push(createShapeElement({
          x: 0, y: 3, width: 8, height: 97,
          shape: 'rect', fill: style.colors.accent, stroke: 'transparent', zIndex: 0,
        }));
        elements.push(createShapeElement({
          x: 92, y: 0, width: 8, height: 100,
          shape: 'rect', fill: style.colors.accent, stroke: 'transparent', zIndex: 0,
        }));
        elements.push(createShapeElement({
          x: 0, y: 95, width: 100, height: 5,
          shape: 'rect', fill: style.colors.primary, stroke: 'transparent', zIndex: 0,
        }));
        break;

      // ─── 科技/赛博类 ───
      case 'neon-line':
        // 霓虹灯线条 (上下发光线)
        elements.push(createShapeElement({
          x: 0, y: 0, width: 100, height: 1.5,
          shape: 'rect', fill: style.colors.accent, stroke: 'transparent', zIndex: 0,
          opacity: 0.8,
        }));
        elements.push(createShapeElement({
          x: 0, y: 98.5, width: 100, height: 1.5,
          shape: 'rect', fill: style.colors.accent, stroke: 'transparent', zIndex: 0,
          opacity: 0.6,
        }));
        // 右侧竖线
        elements.push(createShapeElement({
          x: 98, y: 5, width: 0.5, height: 90,
          shape: 'line', fill: 'transparent', stroke: style.colors.accent + '66', strokeWidth: 2, lineStyle: 'solid', zIndex: 0,
        }));
        // 角落霓虹方块
        elements.push(createShapeElement({
          x: 93, y: 3, width: 5, height: 5,
          shape: 'rect', fill: style.colors.accent + '33', stroke: style.colors.accent, strokeWidth: 1, borderRadius: 2, zIndex: 0,
        }));
        break;
      case 'neon-haze':
        // 霓虹光雾 — 多层模糊圆形
        elements.push(createShapeElement({
          x: -15, y: -15, width: 50, height: 50,
          shape: 'circle', fill: style.colors.accent + '1a', stroke: 'transparent', zIndex: 0,
        }));
        elements.push(createShapeElement({
          x: 60, y: 50, width: 55, height: 55,
          shape: 'circle', fill: style.colors.secondary + '15', stroke: 'transparent', zIndex: 0,
        }));
        elements.push(createShapeElement({
          x: 10, y: 70, width: 35, height: 35,
          shape: 'circle', fill: style.colors.accent + '12', stroke: 'transparent', zIndex: 0,
        }));
        // 细线点缀
        elements.push(createShapeElement({
          x: 0, y: 0, width: 100, height: 0.3,
          shape: 'line', fill: 'transparent', stroke: style.colors.accent + '44', strokeWidth: 1, lineStyle: 'solid', zIndex: 0,
        }));
        break;
      case 'glitch':
        // 故障艺术 — 偏移色块
        elements.push(createShapeElement({
          x: 0, y: 0, width: 100, height: 1,
          shape: 'rect', fill: style.colors.accent + '88', stroke: 'transparent', zIndex: 0,
        }));
        elements.push(createShapeElement({
          x: 5, y: 8, width: 30, height: 0.5,
          shape: 'rect', fill: style.colors.secondary, stroke: 'transparent', zIndex: 0, opacity: 0.6,
        }));
        elements.push(createShapeElement({
          x: 60, y: 15, width: 25, height: 0.5,
          shape: 'rect', fill: style.colors.accent, stroke: 'transparent', zIndex: 0, opacity: 0.5,
        }));
        elements.push(createShapeElement({
          x: 10, y: 88, width: 40, height: 0.5,
          shape: 'rect', fill: style.colors.primary + 'aa', stroke: 'transparent', zIndex: 0,
        }));
        elements.push(createShapeElement({
          x: 50, y: 92, width: 35, height: 0.5,
          shape: 'rect', fill: style.colors.accent + '66', stroke: 'transparent', zIndex: 0,
        }));
        break;
      case 'glassmorphism':
        // 毛玻璃效果 — 半透明模糊圆角矩形
        elements.push(createShapeElement({
          x: 70, y: -10, width: 35, height: 35,
          shape: 'circle', fill: style.colors.accent + '15', stroke: 'transparent', zIndex: 0,
        }));
        elements.push(createShapeElement({
          x: -10, y: 60, width: 30, height: 30,
          shape: 'circle', fill: style.colors.secondary + '12', stroke: 'transparent', zIndex: 0,
        }));
        elements.push(createShapeElement({
          x: 80, y: 75, width: 25, height: 25,
          shape: 'rounded', fill: style.colors.accent + '0a', stroke: style.colors.accent + '22', strokeWidth: 1, borderRadius: 12, zIndex: 0, opacity: 0.7,
        }));
        break;

      // ─── 终端/代码类 ───
      case 'terminal':
        // 终端窗口装饰 — 顶部色条 + 窗口圆点
        elements.push(createShapeElement({
          x: 0, y: 0, width: 100, height: 4,
          shape: 'rect', fill: style.colors.primary, stroke: 'transparent', zIndex: 0,
        }));
        // 终端圆点 (红/黄/绿)
        elements.push(createShapeElement({
          x: 2, y: 1, width: 1.5, height: 1.5,
          shape: 'circle', fill: '#ff5f56', stroke: 'transparent', zIndex: 1,
        }));
        elements.push(createShapeElement({
          x: 5, y: 1, width: 1.5, height: 1.5,
          shape: 'circle', fill: '#ffbd2e', stroke: 'transparent', zIndex: 1,
        }));
        elements.push(createShapeElement({
          x: 8, y: 1, width: 1.5, height: 1.5,
          shape: 'circle', fill: '#27c93f', stroke: 'transparent', zIndex: 1,
        }));
        // 命令行提示符
        elements.push(createTextElement({
          x: p, y: 6, width: 15, height: 3,
          content: '> _',
          fontSize: 14,
          color: style.colors.accent,
          textAlign: 'left',
          fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
          zIndex: 0,
        }));
        break;
      case 'ascii-art':
        // ASCII 艺术装饰 — 用等宽字符拼出边框
        elements.push(createTextElement({
          x: 85, y: 80, width: 13, height: 12,
          content: '+--+\n|  |\n+--+',
          fontSize: 10,
          color: style.colors.accent + '44',
          textAlign: 'left',
          fontFamily: "'JetBrains Mono', 'Source Code Pro', monospace",
          zIndex: 0,
        }));
        elements.push(createTextElement({
          x: 2, y: 82, width: 15, height: 8,
          content: '####\n####\n####',
          fontSize: 10,
          color: style.colors.secondary + '33',
          textAlign: 'left',
          fontFamily: "'JetBrains Mono', 'Source Code Pro', monospace",
          zIndex: 0,
        }));
        break;

      // ─── 色块类 ───
      case 'color-blocks':
        // 几何色块 — 包豪斯/蒙德里安风格
        elements.push(createShapeElement({
          x: 0, y: 0, width: 35, height: 8,
          shape: 'rect', fill: style.colors.primary, stroke: 'transparent', zIndex: 0,
        }));
        elements.push(createShapeElement({
          x: 0, y: 92, width: 25, height: 8,
          shape: 'rect', fill: style.colors.accent, stroke: 'transparent', zIndex: 0,
        }));
        elements.push(createShapeElement({
          x: 80, y: 0, width: 20, height: 20,
          shape: 'rect', fill: style.colors.accent + '33', stroke: 'transparent', zIndex: 0,
        }));
        elements.push(createShapeElement({
          x: 75, y: 85, width: 25, height: 15,
          shape: 'rect', fill: style.colors.secondary + '22', stroke: 'transparent', zIndex: 0,
        }));
        break;

      // ─── 杂志/编辑类 ───
      case 'magazine':
        // 杂志风 — 大号页码 + 粗线分隔
        elements.push(createTextElement({
          x: 88, y: 2, width: 10, height: 6,
          content: `0${index + 1}`,
          fontSize: 40,
          fontWeight: 'bold',
          color: style.colors.accent + '22',
          textAlign: 'right',
          fontFamily: "'Playfair Display', 'Merriweather', serif",
          zIndex: 0,
        }));
        elements.push(createShapeElement({
          x: p, y: 2, width: 30, height: 0.8,
          shape: 'rect', fill: style.colors.primary, stroke: 'transparent', zIndex: 0,
        }));
        elements.push(createShapeElement({
          x: 0, y: 96, width: 100, height: 0.5,
          shape: 'rect', fill: style.colors.accent + '55', stroke: 'transparent', zIndex: 0,
        }));
        break;
      case 'editorial-serif':
        // 编辑风衬线 — 顶部细线 + 左侧装饰竖线
        elements.push(createShapeElement({
          x: p, y: 0, width: 100 - p * 2, height: 0.3,
          shape: 'line', fill: 'transparent', stroke: style.colors.primary, strokeWidth: 1, lineStyle: 'solid', zIndex: 0,
        }));
        elements.push(createShapeElement({
          x: p, y: 3, width: 0.5, height: 12,
          shape: 'line', fill: 'transparent', stroke: style.colors.accent, strokeWidth: 2, lineStyle: 'solid', zIndex: 0,
        }));
        elements.push(createShapeElement({
          x: p, y: 95, width: 100 - p * 2, height: 0.3,
          shape: 'line', fill: 'transparent', stroke: style.colors.primary + '66', strokeWidth: 1, lineStyle: 'solid', zIndex: 0,
        }));
        break;

      // ─── 包豪斯类 ───
      case 'bauhaus':
        // 包豪斯几何 — 原色方块 + 圆 + 三角
        elements.push(createShapeElement({
          x: 82, y: -5, width: 25, height: 25,
          shape: 'circle', fill: style.colors.accent + '22', stroke: 'transparent', zIndex: 0,
        }));
        elements.push(createShapeElement({
          x: -5, y: 78, width: 22, height: 22,
          shape: 'triangle', fill: style.colors.primary + '18', stroke: 'transparent', zIndex: 0,
        }));
        elements.push(createShapeElement({
          x: 88, y: 80, width: 12, height: 12,
          shape: 'rect', fill: style.colors.accent + '33', stroke: 'transparent', zIndex: 0, rotation: 45,
        }));
        break;

      // ─── 孟菲斯类 ───
      case 'memphis':
        // 孟菲斯风 — 多彩碎片 + 之字线
        elements.push(createShapeElement({
          x: 85, y: 5, width: 8, height: 8,
          shape: 'circle', fill: style.colors.accent + '33', stroke: 'transparent', zIndex: 0,
        }));
        elements.push(createShapeElement({
          x: 5, y: 82, width: 10, height: 10,
          shape: 'triangle', fill: style.colors.secondary + '22', stroke: 'transparent', zIndex: 0,
        }));
        elements.push(createShapeElement({
          x: 90, y: 85, width: 6, height: 6,
          shape: 'rect', fill: style.colors.accent + '44', stroke: 'transparent', zIndex: 0, rotation: 30,
        }));
        // 之字形装饰线
        for (let i = 0; i < 4; i++) {
          elements.push(createShapeElement({
            x: 80 + i * 3, y: 70, width: 3, height: 0.4,
            shape: 'rect', fill: style.colors.accent + '55', stroke: 'transparent', zIndex: 0, rotation: i % 2 === 0 ? 20 : -20,
          }));
        }
        break;

      // ─── 水墨/水彩类 ───
      case 'ink-wash':
        // 水墨晕染 — 大面积淡墨圆 + 飞白
        elements.push(createShapeElement({
          x: -10, y: -10, width: 40, height: 40,
          shape: 'circle', fill: style.colors.primary + '08', stroke: 'transparent', zIndex: 0,
        }));
        elements.push(createShapeElement({
          x: 65, y: 55, width: 45, height: 45,
          shape: 'circle', fill: style.colors.accent + '06', stroke: 'transparent', zIndex: 0,
        }));
        // 墨点
        for (let i = 0; i < 6; i++) {
          const dx = 10 + i * 12;
          const dy = 88 + (i % 2) * 2;
          elements.push(createShapeElement({
            x: dx, y: dy, width: 1 + Math.random() * 1.5, height: 1 + Math.random() * 1.5,
            shape: 'circle', fill: style.colors.primary + Math.floor(20 + Math.random() * 30).toString(16).padStart(2, '0'), stroke: 'transparent', zIndex: 0,
          }));
        }
        break;
      case 'watercolor':
        // 水彩 — 多层透明色斑
        elements.push(createShapeElement({
          x: -10, y: -5, width: 35, height: 30,
          shape: 'circle', fill: style.colors.accent + '12', stroke: 'transparent', zIndex: 0, borderRadius: 50,
        }));
        elements.push(createShapeElement({
          x: 70, y: 60, width: 40, height: 40,
          shape: 'circle', fill: style.colors.secondary + '10', stroke: 'transparent', zIndex: 0, borderRadius: 50,
        }));
        elements.push(createShapeElement({
          x: 10, y: 75, width: 25, height: 25,
          shape: 'circle', fill: style.colors.accent + '0e', stroke: 'transparent', zIndex: 0, borderRadius: 50,
        }));
        break;

      // ─── 无装饰 ───
      case 'none':
      default:
        break;
    }
  };

  // 背景颜色
  const bg = getStyleBackground(style);

  // 通用辅助：添加页脚装饰（页码 + 分隔线）
  const addFooter = () => {
    // 底部分隔线
    elements.push(createShapeElement({
      x: p, y: 94, width: 100 - p * 2, height: 0.3,
      shape: 'rect', fill: style.colors.accent + '33', stroke: 'transparent', zIndex: 0,
    }));
    // 页码文本
    elements.push(createTextElement({
      x: 92, y: 93, width: 6, height: 4,
      content: `${index + 1}`,
      fontSize: 12,
      color: style.colors.textMuted,
      textAlign: 'right',
      fontFamily: bodyFamily,
      zIndex: 1,
    }));
  };

  // 通用辅助：添加标题区域装饰色块（标题左侧的竖线/色块）
  const addTitleAccent = (titleY: number, titleH: number) => {
    elements.push(createShapeElement({
      x: p - 1, y: titleY + 1, width: 0.8, height: titleH - 2,
      shape: 'rounded', fill: style.colors.accent, stroke: 'transparent', borderRadius: 4, zIndex: 1,
    }));
  };

  // 通用辅助：添加内容卡片背景（半透明背景色块）
  const addContentCard = (cardX: number, cardY: number, cardW: number, cardH: number) => {
    elements.push(createShapeElement({
      x: cardX, y: cardY, width: cardW, height: cardH,
      shape: 'rounded', fill: style.colors.accent + '0a', stroke: style.colors.accent + '22', strokeWidth: 1, borderRadius: 8, zIndex: 0,
    }));
  };

  switch (layout) {
    case 'title': {
      addDecoration(style.decoration);
      // 标题区域背景卡片
      elements.push(createShapeElement({
        x: isPortrait ? 8 : 12, y: isPortrait ? 25 : 30, width: isPortrait ? 84 : 76, height: isPortrait ? 45 : 40,
        shape: 'rounded', fill: style.colors.accent + '0a', stroke: style.colors.accent + '1a', strokeWidth: 1, borderRadius: 12, zIndex: 0,
      }));
      // 标题左侧装饰竖条
      elements.push(createShapeElement({
        x: isPortrait ? 10 : 14, y: isPortrait ? 30 : 33, width: 1, height: isPortrait ? 35 : 34,
        shape: 'rounded', fill: style.colors.accent, stroke: 'transparent', borderRadius: 4, zIndex: 1,
      }));
      // 主标题
      elements.push(createTextElement({
        x: isPortrait ? 14 : 18, y: isPortrait ? 30 : 35, width: isPortrait ? 76 : 66, height: 15,
        content: cleanTitle,
        fontSize: Math.round(56 * style.titleSizeMultiplier),
        fontWeight: 'bold',
        color: style.colors.primary,
        textAlign: style.titleAlign,
        fontFamily: titleFamily,
        zIndex: 2,
      }));
      // 副标题
      if (bulletPoints.length > 0) {
        elements.push(createTextElement({
          x: isPortrait ? 14 : 18, y: isPortrait ? 42 : 52, width: isPortrait ? 76 : 66, height: 8,
          content: bulletPoints[0],
          fontSize: Math.round(28 * style.bodySizeMultiplier),
          color: style.colors.textMuted,
          textAlign: style.titleAlign,
          fontFamily: bodyFamily,
          zIndex: 2,
        }));
      }
      // 底部装饰横线
      elements.push(createShapeElement({
        x: isPortrait ? 14 : 18, y: 82, width: 20, height: 0.5,
        shape: 'rect', fill: style.colors.accent, stroke: 'transparent', zIndex: 1,
      }));
      break;
    }

    case 'section': {
      // 章节过渡页：半屏色块背景
      elements.push(createShapeElement({
        x: 0, y: 0, width: 100, height: 100,
        shape: 'rect', fill: style.colors.primary + '08', stroke: 'transparent', zIndex: 0,
      }));
      addDecoration(style.decoration);
      // 章节编号装饰
      elements.push(createTextElement({
        x: p, y: 25, width: 20, height: 8,
        content: `0${index + 1}`,
        fontSize: 64,
        fontWeight: 'bold',
        color: style.colors.accent + '22',
        textAlign: 'left',
        fontFamily: titleFamily,
        zIndex: 0,
      }));
      // 章节标题
      elements.push(createTextElement({
        x: isPortrait ? 10 : p + 8, y: isPortrait ? 35 : 42, width: isPortrait ? 80 : 82, height: 12,
        content: cleanTitle,
        fontSize: Math.round(56 * style.titleSizeMultiplier),
        fontWeight: 'bold',
        color: style.colors.primary,
        textAlign: style.titleAlign,
        fontFamily: titleFamily,
        zIndex: 2,
      }));
      // 标题下方装饰横线
      elements.push(createShapeElement({
        x: p + 8, y: 58, width: 15, height: 0.6,
        shape: 'rect', fill: style.colors.accent, stroke: 'transparent', zIndex: 1,
      }));
      break;
    }

    case 'conclusion': {
      // 结论页使用主色背景
      elements.push(createShapeElement({
        x: 0, y: 0, width: 100, height: 100,
        shape: 'rect', fill: style.colors.primary, stroke: 'transparent', zIndex: 0,
      }));
      // 装饰圆形
      elements.push(createShapeElement({
        x: 70, y: -10, width: 40, height: 40,
        shape: 'circle', fill: style.colors.accent + '22', stroke: 'transparent', zIndex: 0,
      }));
      elements.push(createShapeElement({
        x: -10, y: 70, width: 30, height: 30,
        shape: 'circle', fill: style.colors.secondary + '22', stroke: 'transparent', zIndex: 0,
      }));
      // 标题
      elements.push(createTextElement({
        x: 15, y: 28, width: 70, height: 12,
        content: cleanTitle,
        fontSize: Math.round(48 * style.titleSizeMultiplier),
        fontWeight: 'bold',
        color: '#ffffff',
        textAlign: 'center',
        fontFamily: titleFamily,
        zIndex: 2,
      }));
      // 标题下方装饰线
      elements.push(createShapeElement({
        x: 42, y: 44, width: 16, height: 0.6,
        shape: 'rect', fill: style.colors.accent, stroke: 'transparent', zIndex: 1,
      }));
      if (bulletPoints.length > 0) {
        elements.push(createListElement({
          x: 25, y: 50, width: 50, height: 30,
          items: bulletPoints,
          fontSize: Math.round(26 * style.bodySizeMultiplier),
          color: '#ffffffcc',
          bulletColor: style.colors.accent,
          fontFamily: bodyFamily,
          zIndex: 2,
        }));
      }
      break;
    }

    case 'two_column': {
      addDecoration(style.decoration);
      const half = Math.ceil(bulletPoints.length / 2);
      const colW = isPortrait ? 88 : 42;
      const col1X = isPortrait ? 6 : p;
      const col2X = isPortrait ? 6 : p + colW + sp * 2;

      // 标题区域
      addTitleAccent(5, 10);
      elements.push(createTextElement({
        x: p + 2, y: 5, width: 100 - p * 2 - 2, height: 10,
        content: cleanTitle,
        fontSize: titleSize,
        fontWeight: 'bold',
        color: style.colors.secondary,
        textAlign: style.titleAlign,
        fontFamily: titleFamily,
        zIndex: 2,
      }));
      // 标题下分隔线
      elements.push(createShapeElement({
        x: p, y: 16, width: 100 - p * 2, height: 0.3,
        shape: 'rect', fill: style.colors.accent + '44', stroke: 'transparent', zIndex: 0,
      }));
      // 左栏卡片背景
      addContentCard(col1X - 2, 18, colW + 4, 65);
      // 右栏卡片背景
      addContentCard(col2X - 2, 18, colW + 4, 65);
      // 左栏列表
      elements.push(createListElement({
        x: col1X, y: 22, width: colW, height: 58,
        items: bulletPoints.slice(0, half),
        fontSize: bodySize,
        color: style.colors.text,
        bulletColor: style.colors.accent,
        fontFamily: bodyFamily,
        zIndex: 2,
      }));
      // 右栏文本
      elements.push(createTextElement({
        x: col2X, y: 22, width: colW, height: 58,
        content: bulletPoints.slice(half).join('\n'),
        fontSize: Math.round(bodySize * 0.85),
        color: style.colors.textMuted,
        fontFamily: bodyFamily,
        zIndex: 2,
      }));
      addFooter();
      break;
    }

    case 'title_content':
    default: {
      addDecoration(style.decoration);
      // 标题左侧装饰竖条
      addTitleAccent(5, 10);
      // 标题
      elements.push(createTextElement({
        x: p + 2, y: 5, width: 100 - p * 2 - 2, height: 10,
        content: cleanTitle,
        fontSize: titleSize,
        fontWeight: 'bold',
        color: style.colors.secondary,
        textAlign: style.titleAlign,
        fontFamily: titleFamily,
        zIndex: 2,
      }));
      // 标题下分隔线
      elements.push(createShapeElement({
        x: p, y: 16, width: 100 - p * 2, height: 0.3,
        shape: 'rect', fill: style.colors.accent + '44', stroke: 'transparent', zIndex: 0,
      }));
      // 内容卡片背景
      if (bulletPoints.length > 0) {
        addContentCard(p, 18 + sp, 100 - p * 2, 68);
        elements.push(createListElement({
          x: p + 3, y: 22 + sp, width: 100 - (p + 3) * 2, height: 60,
          items: bulletPoints,
          fontSize: bodySize,
          color: style.colors.text,
          bulletColor: style.colors.accent,
          fontFamily: bodyFamily,
          zIndex: 2,
        }));
      }
      addFooter();
      break;
    }
  }

  return {
    id: `slide-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 8)}`,
    index,
    elements,
    background: layout === 'conclusion' ? style.colors.primary : bg,
    notes: notes || '',
  };
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
