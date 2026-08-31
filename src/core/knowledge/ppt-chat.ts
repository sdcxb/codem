/**
 * PPT 对话式修改 — 对标 oh-my-ppt 的对话修改功能
 *
 * 将当前幻灯片的元素 JSON + 用户指令发送给 LLM
 * LLM 返回修改后的元素 JSON，仅替换当前页元素
 */

import { type V2Slide, type SlideElement } from './ppt-types';
import { extractJSON } from '../llm/output-parser';

export interface ChatModifyResult {
  elements: SlideElement[];
  reply?: string;
}

export async function chatModifySlide(
  slide: V2Slide,
  userInstruction: string,
  onProgress?: (text: string) => void,
): Promise<ChatModifyResult> {
  const isZh = navigator.language?.startsWith('zh');

  // 序列化当前元素
  const elementsBrief = slide.elements.map((el, i) => ({
    idx: i,
    ...el,
  }));

  const systemPrompt = isZh
    ? `你是一个演示文稿编辑助手。用户会对当前幻灯片的元素提出修改要求。
你需要返回修改后的完整元素数组 JSON。
规则:
1. 返回严格 JSON: {"elements": [...], "reply": "简要说明你做了什么修改"}
2. 每个元素必须包含完整的字段 (type, id, x, y, width, height, rotation, zIndex, opacity 以及该类型特有的字段)
3. 不要删除未被要求修改的元素
4. 位置和大小使用百分比 (0-100)
5. 元素类型: text, shape, image, list
6. text 元素: {type:"text", id, x, y, width, height, rotation, zIndex, opacity, content, fontSize, fontWeight, fontStyle, textDecoration, color, textAlign, fontFamily, lineHeight, letterSpacing, backgroundColor, padding, borderRadius}
7. shape 元素: {type:"shape", id, x, y, width, height, rotation, zIndex, opacity, shape, fill, stroke, strokeWidth, borderRadius}
8. list 元素: {type:"list", id, x, y, width, height, rotation, zIndex, opacity, items:[], fontSize, color, bulletColor, fontFamily, lineHeight, bulletStyle}`
    : `You are a presentation editor assistant. The user gives instructions to modify elements on the current slide.
Return the complete modified elements array as JSON.
Rules:
1. Return strict JSON: {"elements": [...], "reply": "Briefly describe what you changed"}
2. Each element must have all required fields (type, id, x, y, width, height, rotation, zIndex, opacity, plus type-specific fields)
3. Do not delete elements that weren't asked to be modified
4. Position and size use percentages (0-100)
5. Element types: text, shape, image, list`;

  const userPrompt = isZh
    ? `当前幻灯片元素 (JSON):
${JSON.stringify(elementsBrief, null, 2)}

用户修改要求: ${userInstruction}

请返回修改后的完整 JSON:`
    : `Current slide elements (JSON):
${JSON.stringify(elementsBrief, null, 2)}

User modification request: ${userInstruction}

Return the complete modified JSON:`;

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

  let content = '';
  const stream = await provider.stream({
    model: actualModel,
    messages: [
      { id: 'ppt-chat-sys', role: 'system', content: systemPrompt },
      { id: 'ppt-chat-user', role: 'user', content: userPrompt },
    ],
  });
  for await (const event of stream) {
    if (event.type === 'text_delta') {
      content += event.text;
      onProgress?.(content);
    }
  }

  const parsed = extractJSON<{ elements: SlideElement[]; reply?: string }>(content);
  if (!parsed || !Array.isArray(parsed.elements)) {
    throw new Error(`Failed to parse AI response. Preview: ${content.substring(0, 200)}`);
  }

  return {
    elements: parsed.elements,
    reply: parsed.reply,
  };
}
