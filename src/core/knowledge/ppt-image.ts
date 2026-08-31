/**
 * PPT AI 生图与智能配图
 *
 * 对标 oh-my-ppt 的 AI 生图功能:
 * 1. 生成整套 PPT 时自动配图 (根据页面内容和风格自动生成配图)
 * 2. 编辑页生图工作台 (输入描述 → 生成 → 插入/设为背景)
 *
 * 使用主应用已配置的 ImageGen provider (multimodal.ts)
 */

import { type V2Slide, type SlideElement } from './ppt-types';
import { createImageElement } from './ppt-types';
import { generateImages, type ImageGenParams } from '../llm/multimodal';
import { getMultimodalSettings } from '../llm/multimodal';

/** 检查是否已配置生图服务 */
export function isImageGenAvailable(): boolean {
  const settings = getMultimodalSettings();
  return !!(settings.imageGen?.enabled && settings.imageGen?.apiKey);
}

/** 获取生图 provider 信息 */
export function getImageGenInfo(): { provider: string; model: string } | null {
  const settings = getMultimodalSettings();
  if (!settings.imageGen?.enabled || !settings.imageGen?.apiKey) return null;
  return {
    provider: settings.imageGen.providerId,
    model: settings.imageGen.model || 'dall-e-3',
  };
}

/**
 * 单张图片生成
 */
export async function generateImage(
  prompt: string,
  size?: ImageGenParams['size'],
): Promise<string> {
  const result = await generateImages({
    prompt,
    size: size || '1024x1024',
    n: 1,
    quality: 'standard',
    style: 'vivid',
  });

  const img = result.images[0];
  if (!img) throw new Error('Image generation returned no results');

  if (img.base64) {
    return `data:image/png;base64,${img.base64}`;
  }
  if (img.url) {
    return img.url;
  }
  throw new Error('Image generation returned no usable data');
}

/**
 * 根据幻灯片内容生成配图提示词
 */
export function generateImagePrompt(slide: V2Slide, styleName?: string): string {
  const titleEl = slide.elements.find(el => el.type === 'text');
  const title = titleEl ? (titleEl as any).content : '';
  const listEl = slide.elements.find(el => el.type === 'list');
  const items = listEl ? (listEl as any).items : [];

  const isZh = navigator.language?.startsWith('zh');
  const prompt = isZh
    ? `为 PPT 页面 "${title}" 生成配图。页面要点: ${items.join(', ')}。风格: ${styleName || '现代简约'}。生成一张适合演示文稿的插画，构图简洁，留白充足，不要包含文字。`
    : `Generate an illustration for a presentation slide titled "${title}". Key points: ${items.join(', ')}. Style: ${styleName || 'modern minimalist'}. Create an illustration suitable for a presentation with clean composition, ample whitespace, and no text.`;

  return prompt;
}

/**
 * 为幻灯片自动配图
 * 在生成 PPT 后，对适合配图的页面自动生成图片元素
 */
export async function autoGenerateImages(
  slides: V2Slide[],
  styleName?: string,
  onProgress?: (current: number, total: number, slideTitle: string) => void,
): Promise<V2Slide[]> {
  if (!isImageGenAvailable()) {
    return slides;
  }

  const result: V2Slide[] = [];

  for (let i = 0; i < slides.length; i++) {
    const slide = slides[i];
    onProgress?.(i + 1, slides.length, slide.elements.find(el => el.type === 'text') ? (slide.elements.find(el => el.type === 'text') as any).content : `Slide ${i + 1}`);

    // 跳过标题页和结论页 (通常不需要配图)
    const hasList = slide.elements.some(el => el.type === 'list');
    const hasImage = slide.elements.some(el => el.type === 'image');
    if (!hasList || hasImage) {
      result.push(slide);
      continue;
    }

    try {
      const prompt = generateImagePrompt(slide, styleName);
      const imgUrl = await generateImage(prompt, '1024x1024');

      // 在幻灯片右侧添加图片元素
      const imgElement = createImageElement({
        x: 60, y: 18, width: 35, height: 50,
        src: imgUrl,
        objectFit: 'cover',
        borderRadius: 12,
        zIndex: 1,
      });

      result.push({
        ...slide,
        elements: [...slide.elements, imgElement],
      });
    } catch (err) {
      console.warn(`[ppt-image] Failed to generate image for slide ${i + 1}:`, err);
      result.push(slide);
    }
  }

  return result;
}
