/**
 * PPT 演讲稿生成
 *
 * 基于 LLM 为每页幻灯片生成演讲稿/演讲备注。
 * 对标 oh-my-ppt 的 AI 演讲稿功能。
 */

import type { V2SlideDeck, V2Slide, TextElement, ListElement } from './ppt-types';
import type { LLMRequest } from '../llm/types';

/**
 * 获取已配置的 LLM provider 和 model (与 ppt-generator 相同逻辑)
 */
async function getLLM() {
  const { getLLMEngine } = await import('../llm/index');
  const { getSettingJSON } = await import('../storage/settings');
  const engine = getLLMEngine();

  const savedSettings = getSettingJSON<any>("codem-settings", null);
  if (savedSettings?.providers) {
    for (const p of savedSettings.providers) {
      if (p.apiKey) {
        engine.setProviderConfig(p.id, { apiKey: p.apiKey, baseUrl: p.baseUrl });
      }
    }
  }

  const defaultProviderId = engine.getDefaultProvider();
  const defaultModel = engine.getDefaultModel();
  let provider = engine.providers.get(defaultProviderId);
  let actualModel = defaultModel;

  const hasApiKey = (provider as any)?.config?.apiKey;
  if (!provider || !hasApiKey) {
    const allProviders = engine.providers.getAll();
    const configured = allProviders.filter(p => {
      if (p.id === 'ollama') return false;
      return (p as any).config?.apiKey;
    });
    if (configured.length === 0) {
      throw new Error('No LLM provider available — please configure an API key in Settings');
    }
    provider = configured[0];
    try {
      const fallbackModels = await provider.listModels();
      if (fallbackModels.length > 0) {
        const jsonModel = fallbackModels.find(m => !m.id.includes('reasoning') && !m.id.includes('think')) || fallbackModels[0];
        actualModel = jsonModel.id;
      }
    } catch {}
  }

  return { provider, actualModel };
}

/**
 * 为单页幻灯片生成演讲稿
 */
export async function generateSpeakerNotes(
  slide: V2Slide,
  slideIndex: number,
  totalSlides: number,
  deckTitle: string,
): Promise<string> {
  const { provider, actualModel } = await getLLM();

  // 提取幻灯片内容
  const titleEl = slide.elements.find(el => el.type === 'text') as TextElement | undefined;
  const listEl = slide.elements.find(el => el.type === 'list') as ListElement | undefined;

  const title = titleEl?.content || '(无标题)';
  const items = listEl?.items || [];

  const isZh = navigator.language?.startsWith('zh');
  const systemPrompt = isZh
    ? `你是一位专业的演讲稿撰写专家。根据 PPT 页面内容，为演讲者生成自然流畅的演讲稿。要求：1) 口语化，适合现场演讲 2) 涵盖所有要点 3) 时长约 1-2 分钟 4) 直接输出演讲稿文本，不要包含标题或多余标记。`
    : `You are a professional speech writer. Based on the PPT slide content, generate a natural speech script for the presenter. Requirements: 1) Conversational, suitable for live presentation 2) Cover all key points 3) About 1-2 minutes 4) Output the script text directly without titles or extra markers.`;

  const userPrompt = isZh
    ? `PPT 主题: ${deckTitle}\n当前页: 第 ${slideIndex + 1}/${totalSlides} 页\n页面标题: ${title}\n要点:\n${items.map((it, i) => `${i + 1}. ${it}`).join('\n')}\n\n请为这一页生成演讲稿。`
    : `PPT topic: ${deckTitle}\nCurrent slide: ${slideIndex + 1}/${totalSlides}\nSlide title: ${title}\nKey points:\n${items.map((it, i) => `${i + 1}. ${it}`).join('\n')}\n\nPlease generate the speaker notes for this slide.`;

  const request: LLMRequest = {
    model: actualModel,
    messages: [
      { id: `sys-${Date.now()}`, role: 'system', content: systemPrompt },
      { id: `user-${Date.now()}`, role: 'user', content: userPrompt },
    ],
    temperature: 0.7,
    maxTokens: 800,
  };

  const response = await provider.complete(request);
  return response.content.trim();
}

/**
 * 为整套 PPT 批量生成演讲稿
 */
export async function generateAllSpeakerNotes(
  deck: V2SlideDeck,
  onProgress?: (current: number, total: number, slideTitle: string) => void,
): Promise<V2SlideDeck> {
  const slides = [...deck.slides];

  for (let i = 0; i < slides.length; i++) {
    const titleEl = slides[i].elements.find(el => el.type === 'text') as TextElement | undefined;
    const title = titleEl?.content || `Slide ${i + 1}`;
    onProgress?.(i + 1, slides.length, title);

    try {
      const notes = await generateSpeakerNotes(slides[i], i, slides.length, deck.title);
      slides[i] = { ...slides[i], notes };
    } catch (err) {
      console.warn(`[ppt-notes] Failed to generate notes for slide ${i + 1}:`, err);
    }
  }

  return { ...deck, slides };
}
