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
import { getLLMEngine } from "./index";
import type { LLMMessage, ContentBlock } from "../storage/message";

// ========== Vision System Prompt ==========

const VISION_SYSTEM_PROMPT = `你是一个视觉描述助手。请详细描述图片内容，包括：
1. 主体内容（人物、物体、场景）
2. 文字内容（OCR — 完整提取图中所有文字，保持原始格式）
3. 数据和数值（图表/表格的具体数值和标签）
4. 颜色和布局（设计/截图的重要视觉元素）
5. 上下文和用途推断

输出格式：纯文本段落描述，不使用 Markdown 标题。`;

const STT_SYSTEM_PROMPT = `你是一个语音转写助手。请将音频内容完整转写为文字，包括：
1. 完整的对话或讲述内容
2. 说话人识别（如果有多人）
3. 重要停顿、语气词保留

输出格式：纯文本。`;

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
   * 1. 检查是否有 image/audio block
   * 2. 检查当前主模型是否支持 vision/audio
   * 3. 若不支持 → 调用多模态模型获取描述/转写 → 替换为 text block
   * 4. 若支持 → 直接传媒体，不处理
   */
  async processMessages(
    messages: LLMMessage[],
    chatModel: string,
    chatProvider: string,
  ): Promise<VisionProxyResult> {
    // 1. 检查是否有 image/audio block
    const hasMedia = messages.some(
      (m) => Array.isArray(m.content) && m.content.some((b: any) => b.type === "image" || b.type === "audio"),
    );
    if (!hasMedia) return { messages, visionUsed: false };

    // 2. 检查当前主模型是否支持 vision/audio
    const supportsVision = this.modelSupportsVision(chatModel, chatProvider);
    const hasAudio = messages.some(
      (m) => Array.isArray(m.content) && m.content.some((b: any) => b.type === "audio"),
    );
    const supportsAudio = false; // 目前没有模型支持直接处理音频输入到chat/completions
    const needsVisionProxy = messages.some(
      (m) => Array.isArray(m.content) && m.content.some((b: any) => b.type === "image"),
    ) && !supportsVision;
    const needsAudioProxy = hasAudio && !supportsAudio;

    if (!needsVisionProxy && !needsAudioProxy) {
      // 模型原生支持所有媒体类型 — 直接传
      return { messages, visionUsed: false };
    }

    // 3. 解析多模态模型配置
    const visionConfig = needsVisionProxy ? this.resolveVisionConfig() : null;
    const sttConfig = needsAudioProxy ? this.resolveSTTConfig() : null;

    if (needsVisionProxy && !visionConfig) {
      return { messages: this.markUnprocessedMedia(messages, "image"), visionUsed: false };
    }
    if (needsAudioProxy && !sttConfig) {
      return { messages: this.markUnprocessedMedia(messages, "audio"), visionUsed: false };
    }

    // 4. 并发处理所有 media block
    let processedMessages = messages;
    if (needsVisionProxy && visionConfig) {
      processedMessages = await this.replaceMediaWithDescriptions(
        processedMessages, "image", visionConfig,
      );
    }
    if (needsAudioProxy && sttConfig) {
      processedMessages = await this.replaceMediaWithDescriptions(
        processedMessages, "audio", sttConfig,
      );
    }

    return {
      messages: processedMessages,
      visionUsed: true,
      visionModel: visionConfig?.model || sttConfig?.model,
      visionProvider: visionConfig?.providerId || sttConfig?.providerId,
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

    // MiMo — 只有 mimo-v2.5 支持图片理解，mimo-v2.5-pro 不支持
    if (modelLower === "mimo-v2.5") return true;

    return false;
  }

  /**
   * 解析视觉模型配置
   * 统一使用 LLMEngine.getConfiguredProvider('vision') 获取已配置的 provider
   */
  private resolveVisionConfig(): MultimodalProviderConfig | null {
    // 1. 尝试通过 LLMEngine.getConfiguredProvider('vision') 统一获取
    try {
      const engine = getLLMEngine();
      const { provider, model } = engine.getConfiguredProvider('vision' as any);
      // 从 provider 实例中提取 apiKey 和 baseUrl
      const providerConfig = engine.getProviderConfig(provider.id);
      if (providerConfig && providerConfig.apiKey) {
        return {
          providerId: provider.id,
          apiKey: providerConfig.apiKey,
          baseUrl: providerConfig.baseUrl || "",
          model,
          enabled: true,
        };
      }
    } catch (e) {
      console.warn('[vision-proxy.ts] getConfiguredProvider failed:', e);
    }

    // 2. Fallback: 从 MultimodalSettings 获取
    const mmSettings = getMultimodalSettings();
    if (mmSettings.vision?.enabled) {
      return mmSettings.vision;
    }

    return null;
  }

  /**
   * 解析语音转写 (STT) 模型配置
   * 统一使用 LLMEngine.getConfiguredProvider + MultimodalSettings fallback
   */
  private resolveSTTConfig(): MultimodalProviderConfig | null {
    // 1. 尝试通过 LLMEngine 统一获取
    try {
      const engine = getLLMEngine();
      const { provider, model } = engine.getConfiguredProvider('stt' as any);
      const providerConfig = engine.getProviderConfig(provider.id);
      if (providerConfig && providerConfig.apiKey) {
        return {
          providerId: provider.id,
          apiKey: providerConfig.apiKey,
          baseUrl: providerConfig.baseUrl || "",
          model,
          enabled: true,
        };
      }
    } catch (e) {
      // stt slot 可能不存在，静默忽略
    }

    // 2. Fallback: 从 MultimodalSettings 获取
    const mmSettings = getMultimodalSettings();
    if (mmSettings.stt?.enabled) {
      return mmSettings.stt;
    }
    return null;
  }

  /**
   * 并发替换所有指定类型的 media block 为文字描述
   */
  private async replaceMediaWithDescriptions(
    messages: LLMMessage[],
    mediaType: "image" | "audio",
    config: MultimodalProviderConfig,
  ): Promise<LLMMessage[]> {
    return Promise.all(
      messages.map(async (msg) => {
        if (!Array.isArray(msg.content)) return msg;

        const newBlocks = await Promise.all(
          (msg.content as ContentBlock[]).map(async (block) => {
            if (block.type !== mediaType) return block;

            try {
              const description = mediaType === "image"
                ? await this.describeImage(config, block.data, block.mediaType)
                : await this.transcribeAudio(config, block.data, block.mediaType);
              const prefix = mediaType === "image" ? "[图片描述" : "[语音转写";
              return {
                type: "text" as const,
                text: `${prefix}: ${description}]`,
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
   * 调用语音转写 API 获取音频文字
   */
  private async transcribeAudio(
    config: MultimodalProviderConfig,
    base64Data: string,
    mediaType: string,
  ): Promise<string> {
    const baseUrl = config.baseUrl || "https://api.openai.com/v1";
    const headers: Record<string, string> = {};
    if (config.apiKey) {
      headers["Authorization"] = `Bearer ${config.apiKey}`;
    }

    // OpenAI Whisper API: audio/transcriptions endpoint
    // Convert base64 to blob for multipart/form-data
    const byteChars = atob(base64Data);
    const bytes = new Uint8Array(byteChars.length);
    for (let i = 0; i < byteChars.length; i++) bytes[i] = byteChars.charCodeAt(i);
    const blob = new Blob([bytes], { type: mediaType });
    const ext = mediaType.includes("mp3") ? "mp3" : mediaType.includes("wav") ? "wav" : "m4a";

    const formData = new FormData();
    formData.append("file", blob, `audio.${ext}`);
    formData.append("model", config.model || "whisper-1");
    formData.append("response_format", "text");

    const response = await fetch(`${baseUrl}/audio/transcriptions`, {
      method: "POST",
      headers,
      body: formData,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`STT API error ${response.status}: ${error}`);
    }

    const text = await response.text();
    return text || "(无法转写音频内容)";
  }

  /**
   * 没有多模态模型可用时，标注媒体无法处理
   */
  private markUnprocessedMedia(messages: LLMMessage[], mediaType: "image" | "audio"): LLMMessage[] {
    return messages.map((msg) => {
      if (!Array.isArray(msg.content)) return msg;
      const newBlocks = (msg.content as ContentBlock[]).map((block) => {
        if (block.type !== mediaType) return block;
        const label = mediaType === "image" ? "图片" : "语音";
        const setting = mediaType === "image" ? "视觉" : "语音输入(STT)";
        return {
          type: "text" as const,
          text: `[${label}内容未处理 — 当前模型不支持${label}理解，且未配置${setting}代理模型。请在设置→多模态中配置${setting} Provider。]`,
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
