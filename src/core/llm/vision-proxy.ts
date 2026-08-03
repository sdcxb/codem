/**
 * Vision Proxy — 视觉代理模块
 *
 * 当主对话模型不支持图片理解（如 DeepSeek）时，
 * 自动调用视觉模型（如 GPT-4o / MiMo）获取图片文字描述，
 * 将 image block 替换为 text block，再转发给主模型。
 *
 * 如果主模型本身支持 vision（如 GPT-4o），则直接传图，不经过代理。
 */

import { getMultimodalSettings, type MultimodalProviderConfig } from "./multimodal";
import { getModelProfileManager } from "./model-profile";
import { getSettingJSON } from "../storage/settings";
import type { LLMMessage, ContentBlock } from "../storage/message";

// ========== Vision System Prompt ==========

const VISION_SYSTEM_PROMPT = `你是一个视觉描述助手。请详细描述图片内容，包括：
1. 主体内容（人物、物体、场景）
2. 文字内容（OCR — 完整提取图中所有文字，保持原始格式）
3. 数据和数值（图表/表格的具体数值和标签）
4. 颜色和布局（设计/截图的重要视觉元素）
5. 上下文和用途推断

输出格式：纯文本段落描述，不使用 Markdown 标题。`;

// ========== Types ==========

export interface VisionProxyResult {
  messages: LLMMessage[];
  visionUsed: boolean;
  visionModel?: string;
  visionProvider?: string;
}

// ========== Vision Proxy ==========

export class VisionProxy {
  /**
   * 处理消息列表：
   * 1. 检查是否有 image block
   * 2. 检查当前主模型是否支持 vision
   * 3. 若不支持 → 调用视觉模型获取描述 → 替换 image block 为 text block
   * 4. 若支持 → 直接传图，不处理
   */
  async processMessages(
    messages: LLMMessage[],
    chatModel: string,
    chatProvider: string,
  ): Promise<VisionProxyResult> {
    // 1. 检查是否有 image block
    const hasImages = messages.some(
      (m) => Array.isArray(m.content) && m.content.some((b: any) => b.type === "image"),
    );
    if (!hasImages) return { messages, visionUsed: false };

    // 2. 检查当前主模型是否支持 vision
    if (this.modelSupportsVision(chatModel, chatProvider)) {
      // 模型原生支持 vision — 直接传图
      return { messages, visionUsed: false };
    }

    // 3. 解析视觉模型配置
    const visionConfig = this.resolveVisionConfig();
    if (!visionConfig) {
      // 没有可用的视觉模型 — 标注图片未处理
      return {
        messages: this.markUnprocessedImages(messages),
        visionUsed: false,
      };
    }

    // 4. 并发处理所有 image block
    const processedMessages = await this.replaceImagesWithDescriptions(
      messages,
      visionConfig,
    );

    return {
      messages: processedMessages,
      visionUsed: true,
      visionModel: visionConfig.model,
      visionProvider: visionConfig.providerId,
    };
  }

  /**
   * 检查模型是否支持 vision（基于 capability-detector 的能力数据库）
   */
  private modelSupportsVision(model: string, provider: string): boolean {
    // 使用与 capability-detector.ts 相同的前缀匹配逻辑
    const modelLower = model.toLowerCase();

    // OpenAI vision models
    if (modelLower.startsWith("gpt-4o") && !modelLower.includes("mini")) return true;
    if (modelLower.startsWith("gpt-4o-mini")) return true;
    if (modelLower.startsWith("o3") && !modelLower.includes("mini")) return true;
    if (modelLower.startsWith("o4-mini")) return true;

    // Anthropic
    if (modelLower.startsWith("claude-3") || modelLower.startsWith("claude-4") ||
        modelLower.startsWith("claude-opus-4") || modelLower.startsWith("claude-sonnet-4")) return true;

    // Gemini
    if (modelLower.startsWith("gemini-1.5") || modelLower.startsWith("gemini-2")) return true;

    return false;
  }

  /**
   * 解析视觉模型配置
   * 优先级：ModelProfile vision slot > MultimodalSettings vision > null
   */
  private resolveVisionConfig(): MultimodalProviderConfig | null {
    // 1. 尝试从 ModelProfile 的 vision slot 获取
    const pm = getModelProfileManager();
    const slotConfig = pm.resolveSlot("vision" as any);
    if (slotConfig) {
      // 从 codem-settings 中查找对应的 provider API key
      const settings = getSettingJSON<any>("codem-settings", {});
      const providers = settings.providers || [];
      const matched = providers.find(
        (p: any) => p.id === slotConfig.provider || p.name === slotConfig.provider,
      );
      if (matched) {
        return {
          providerId: slotConfig.provider,
          apiKey: matched.apiKey || "",
          baseUrl: matched.baseUrl || "",
          model: slotConfig.model,
          enabled: true,
        };
      }
    }

    // 2. 从 MultimodalSettings 获取
    const mmSettings = getMultimodalSettings();
    if (mmSettings.vision?.enabled) {
      return mmSettings.vision;
    }

    return null;
  }

  /**
   * 并发替换所有 image block 为文字描述
   */
  private async replaceImagesWithDescriptions(
    messages: LLMMessage[],
    config: MultimodalProviderConfig,
  ): Promise<LLMMessage[]> {
    return Promise.all(
      messages.map(async (msg) => {
        if (!Array.isArray(msg.content)) return msg;

        const newBlocks = await Promise.all(
          (msg.content as ContentBlock[]).map(async (block) => {
            if (block.type !== "image") return block;

            try {
              const description = await this.describeImage(
                config,
                block.data,
                block.mediaType,
              );
              return {
                type: "text" as const,
                text: `[图片描述: ${description}]`,
              };
            } catch (err) {
              return {
                type: "text" as const,
                text: `[图片处理失败: ${err instanceof Error ? err.message : String(err)}]`,
              };
            }
          }),
        );

        return { ...msg, content: newBlocks };
      }),
    );
  }

  /**
   * 调用视觉模型获取图片描述
   */
  private async describeImage(
    config: MultimodalProviderConfig,
    base64Data: string,
    mediaType: string,
  ): Promise<string> {
    const baseUrl = config.baseUrl || "https://api.openai.com/v1";
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (config.apiKey) {
      headers["Authorization"] = `Bearer ${config.apiKey}`;
    }

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: "system", content: VISION_SYSTEM_PROMPT },
          {
            role: "user",
            content: [
              { type: "text", text: "请详细描述这张图片的内容。" },
              {
                type: "image_url",
                image_url: {
                  url: `data:${mediaType};base64,${base64Data}`,
                },
              },
            ],
          },
        ],
        max_tokens: 1000,
        stream: false,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Vision API error ${response.status}: ${error}`);
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content || "(无法识别图片内容)";
  }

  /**
   * 没有视觉模型可用时，标注图片无法处理
   */
  private markUnprocessedImages(messages: LLMMessage[]): LLMMessage[] {
    return messages.map((msg) => {
      if (!Array.isArray(msg.content)) return msg;
      const newBlocks = (msg.content as ContentBlock[]).map((block) => {
        if (block.type !== "image") return block;
        return {
          type: "text" as const,
          text: "[图片内容未处理 — 当前模型不支持视觉理解，且未配置视觉代理模型。请在设置→多模态中配置视觉理解 Provider。]",
        };
      });
      return { ...msg, content: newBlocks };
    });
  }
}

// ========== Singleton ==========

let visionProxyInstance: VisionProxy | null = null;

export function getVisionProxy(): VisionProxy {
  if (!visionProxyInstance) {
    visionProxyInstance = new VisionProxy();
  }
  return visionProxyInstance;
}
