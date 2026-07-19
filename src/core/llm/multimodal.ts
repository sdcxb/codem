/**
 * 多模态扩展模块 (Phase 4)
 *
 * 统一管理 Embedding（语义搜索）、TTS（语音合成）、ImageGen（图像生成）三种多模态能力。
 * 通过 OpenAI-compatible API 接口调用，支持多 provider 路由。
 */

import { getSettingJSON, setSettingJSON } from "../storage/settings";

// ========== Types ==========

export interface MultimodalProviderConfig {
  /** Provider ID (e.g. "openai", "mimo") */
  providerId: string;
  /** API Key */
  apiKey: string;
  /** Base URL */
  baseUrl: string;
  /** Model name for this modality */
  model: string;
  /** Whether this provider is enabled */
  enabled: boolean;
}

export interface MultimodalSettings {
  embedding: MultimodalProviderConfig | null;
  tts: MultimodalProviderConfig | null;
  imageGen: MultimodalProviderConfig | null;
}

// ========== Settings Management ==========

const SETTINGS_KEY = "codem-multimodal-settings";

const defaultSettings: MultimodalSettings = {
  embedding: null,
  tts: null,
  imageGen: null,
};

export function getMultimodalSettings(): MultimodalSettings {
  return getSettingJSON<MultimodalSettings>(SETTINGS_KEY, defaultSettings) || defaultSettings;
}

export function saveMultimodalSettings(settings: MultimodalSettings): void {
  setSettingJSON(SETTINGS_KEY, settings);
}

/**
 * 获取默认本地嵌入配置。
 * 当用户未配置任何 Embedding API 时，自动使用本地 ONNX Runtime 模式。
 * 默认模型：Xenova/all-MiniLM-L6-v2（23MB，多语言，速度最快）。
 */
export function getDefaultLocalEmbeddingConfig(): MultimodalProviderConfig {
  return {
    providerId: 'local',
    apiKey: '',
    baseUrl: '',
    model: 'Xenova/all-MiniLM-L6-v2',
    enabled: true,
  };
}

/**
 * 检查当前是否使用本地嵌入模式（包括自动回退情况）。
 * 当 embedding 配置为 null 或未启用时，也视为本地模式（自动回退）。
 */
export function isUsingLocalEmbedding(): boolean {
  const settings = getMultimodalSettings();
  const config = settings.embedding;
  // 配置为 null → 自动回退到本地
  if (!config || !config.enabled) return true;
  // 显式选择本地模式
  return isLocalEmbeddingProvider(config);
}

// ========== Embedding (Semantic Search) ==========

export interface EmbeddingResult {
  text: string;
  embedding: number[];
}

export interface EmbeddingSearchParams {
  texts: string[];
  providerId?: string;
  model?: string;
  /**
   * Task type for providers that support it (e.g. Gemini).
   * - RETRIEVAL_DOCUMENT: for indexing documents
   * - RETRIEVAL_QUERY: for search queries
   * Ignored by OpenAI-compatible providers.
   */
  taskType?: 'RETRIEVAL_QUERY' | 'RETRIEVAL_DOCUMENT' | 'SEMANTIC_SIMILARITY' | 'CLASSIFICATION' | 'CLUSTERING';
}

/**
 * Detect whether the configured embedding provider is Gemini.
 * Gemini uses a different native API format for embeddings.
 */
function isGeminiProvider(config: MultimodalProviderConfig): boolean {
  const id = config.providerId.toLowerCase();
  const url = (config.baseUrl || '').toLowerCase();
  return id === 'gemini' || url.includes('generativelanguage.googleapis.com');
}

/**
 * Detect whether the configured embedding provider is local (ONNX Runtime).
 * Local mode requires no API key and no network (after first model download).
 */
export function isLocalEmbeddingProvider(config: MultimodalProviderConfig | null): boolean {
  if (!config) return false;
  return config.providerId.toLowerCase() === 'local';
}

/**
 * Generate embeddings using Gemini's native API.
 * Uses batchEmbedContents for multiple texts, embedContent for single text.
 *
 * Native API format:
 *   POST /v1beta/models/{model}:batchEmbedContents?key={apiKey}
 *   Body: { requests: [{ model, content: { parts: [{ text }] }, taskType }] }
 *   Response: { embeddings: [{ values: [...] }] }
 */
async function generateGeminiEmbeddings(
  config: MultimodalProviderConfig,
  params: EmbeddingSearchParams,
): Promise<EmbeddingResult[]> {
  const apiKey = config.apiKey;
  const model = params.model || config.model || 'text-embedding-004';
  // Normalize model name: "text-embedding-004" → "models/text-embedding-004"
  const modelPath = model.startsWith('models/') ? model : `models/${model}`;
  const taskType = params.taskType || 'RETRIEVAL_DOCUMENT';

  // Gemini batchEmbedContents supports up to 100 texts per request
  const GEMINI_BATCH_SIZE = 100;
  const results: EmbeddingResult[] = [];

  for (let i = 0; i < params.texts.length; i += GEMINI_BATCH_SIZE) {
    const batch = params.texts.slice(i, i + GEMINI_BATCH_SIZE);

    // Use batchEmbedContents for multiple texts, embedContent for single
    if (batch.length === 1) {
      const url = `https://generativelanguage.googleapis.com/v1beta/${modelPath}:embedContent?key=${apiKey}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: { parts: [{ text: batch[0] }] },
          taskType,
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Gemini Embedding API error ${response.status}: ${error}`);
      }

      const data = await response.json();
      results.push({
        text: batch[0],
        embedding: data.embedding?.values || [],
      });
    } else {
      const url = `https://generativelanguage.googleapis.com/v1beta/${modelPath}:batchEmbedContents?key=${apiKey}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requests: batch.map((text) => ({
            model: modelPath,
            content: { parts: [{ text }] },
            taskType,
          })),
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Gemini Embedding API error ${response.status}: ${error}`);
      }

      const data = await response.json();
      const embeddings = data.embeddings || [];
      for (let j = 0; j < batch.length; j++) {
        results.push({
          text: batch[j],
          embedding: embeddings[j]?.values || [],
        });
      }
    }
  }

  return results;
}

/**
 * Generate embeddings for an array of texts.
 * Automatically routes to:
 * 1. Local ONNX Runtime (providerId === 'local') — no API key needed
 * 2. Gemini native API (providerId === 'gemini')
 * 3. OpenAI-compatible endpoint (default)
 *
 * 默认行为：当未配置任何 Embedding API 时，自动回退到本地 ONNX Runtime 模式，
 * 使用 all-MiniLM-L6-v2 模型。用户无需任何配置即可使用知识库检索功能。
 *
 * 风险1缓解：本地模式下，local-embedding.ts 内部自动进行子分块，
 * 将超长文本拆分为 ≤128 token 片段，避免 Transformer 截断丢内容。
 */
export async function generateEmbeddings(
  params: EmbeddingSearchParams,
): Promise<EmbeddingResult[]> {
  const settings = getMultimodalSettings();
  let config = settings.embedding;

  // === 默认回退：未配置 Embedding API 时，自动使用本地 ONNX Runtime ===
  // 这样用户无需任何配置即可使用知识库检索功能。
  if (!config || !config.enabled) {
    config = getDefaultLocalEmbeddingConfig();
  }

  // Route to local ONNX Runtime if provider is local
  if (config && isLocalEmbeddingProvider(config)) {
    const { generateLocalEmbeddings, initLocalEmbedding } = await import('../knowledge/local-embedding');
    // 确保模型已加载（model 字段存储模型 ID）
    const modelId = config.model || undefined;
    await initLocalEmbedding(modelId);
    const embeddings = await generateLocalEmbeddings(params.texts);
    return embeddings.map((emb, i) => ({
      text: params.texts[i],
      embedding: emb,
    }));
  }

  // 以下为远程 API 模式，需要 API Key
  if (!config.apiKey) {
    throw new Error("Embedding provider not configured. Set it in Settings → Multimodal.");
  }

  // Route to Gemini native API if provider is Gemini
  if (isGeminiProvider(config)) {
    return generateGeminiEmbeddings(config, params);
  }

  // OpenAI-compatible endpoint
  const baseUrl = config.baseUrl || "https://api.openai.com/v1";
  const model = params.model || config.model || "text-embedding-3-small";

  const response = await fetch(`${baseUrl}/embeddings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model,
      input: params.texts,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Embedding API error ${response.status}: ${error}`);
  }

  const data = await response.json();
  return data.data.map((item: any, i: number) => ({
    text: params.texts[i],
    embedding: item.embedding as number[],
  }));
}

/**
 * Compute cosine similarity between two embedding vectors.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dotProduct / denominator;
}

/**
 * Semantic search: find the most similar texts to a query.
 */
export async function semanticSearch(
  query: string,
  corpus: string[],
  topK: number = 5,
): Promise<{ text: string; score: number; index: number }[]> {
  if (corpus.length === 0) return [];

  // Embed query and corpus together
  const allTexts = [query, ...corpus];
  const results = await generateEmbeddings({ texts: allTexts });

  const queryEmbedding = results[0].embedding;
  const corpusEmbeddings = results.slice(1);

  const scored = corpusEmbeddings.map((item, i) => ({
    text: item.text,
    score: cosineSimilarity(queryEmbedding, item.embedding),
    index: i,
  }));

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

// ========== TTS (Text-to-Speech) ==========

export interface TTSParams {
  text: string;
  voice?: string;
  speed?: number;
  format?: "mp3" | "wav" | "opus" | "flac";
}

export interface TTSResult {
  audioBase64: string;
  format: string;
}

/**
 * Convert text to speech using OpenAI-compatible TTS API.
 */
export async function textToSpeech(params: TTSParams): Promise<TTSResult> {
  const settings = getMultimodalSettings();
  const config = settings.tts;
  if (!config || !config.enabled || !config.apiKey) {
    throw new Error("TTS provider not configured. Set it in Settings → Multimodal.");
  }

  const baseUrl = config.baseUrl || "https://api.openai.com/v1";
  const model = config.model || "tts-1";
  const voice = params.voice || "alloy";
  const format = params.format || "mp3";

  const response = await fetch(`${baseUrl}/audio/speech`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model,
      input: params.text,
      voice,
      speed: params.speed ?? 1.0,
      response_format: format,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`TTS API error ${response.status}: ${error}`);
  }

  // Response is binary audio data
  const arrayBuffer = await response.arrayBuffer();
  const audioBase64 = btoa(
    String.fromCharCode(...new Uint8Array(arrayBuffer)),
  );

  return { audioBase64, format };
}

/**
 * Play TTS audio in the browser.
 */
export function playTTSAudio(result: TTSResult): HTMLAudioElement {
  const mimeType = result.format === "mp3" ? "audio/mpeg"
    : result.format === "wav" ? "audio/wav"
    : result.format === "opus" ? "audio/opus"
    : result.format === "flac" ? "audio/flac"
    : "audio/mpeg";

  const dataUrl = `data:${mimeType};base64,${result.audioBase64}`;
  const audio = new Audio(dataUrl);
  audio.play();
  return audio;
}

// ========== Image Generation ==========

export interface ImageGenParams {
  prompt: string;
  size?: "256x256" | "512x512" | "1024x1024" | "1792x1024" | "1024x1792";
  quality?: "standard" | "hd";
  style?: "vivid" | "natural";
  n?: number;
}

export interface ImageGenResult {
  images: { url?: string; base64?: string; revisedPrompt?: string }[];
}

/**
 * Generate images using OpenAI-compatible Image Generation API.
 */
export async function generateImages(params: ImageGenParams): Promise<ImageGenResult> {
  const settings = getMultimodalSettings();
  const config = settings.imageGen;
  if (!config || !config.enabled || !config.apiKey) {
    throw new Error("Image generation provider not configured. Set it in Settings → Multimodal.");
  }

  const baseUrl = config.baseUrl || "https://api.openai.com/v1";
  const model = config.model || "dall-e-3";

  const response = await fetch(`${baseUrl}/images/generations`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model,
      prompt: params.prompt,
      n: params.n ?? 1,
      size: params.size ?? "1024x1024",
      quality: params.quality ?? "standard",
      style: params.style ?? "vivid",
      response_format: "b64_json",
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Image generation API error ${response.status}: ${error}`);
  }

  const data = await response.json();
  return {
    images: data.data.map((item: any) => ({
      base64: item.b64_json,
      url: item.url,
      revisedPrompt: item.revised_prompt,
    })),
  };
}

// ========== Available Models per Provider ==========

export const MULTIMODAL_MODELS: Record<string, {
  embedding: string[];
  tts: string[];
  imageGen: string[];
}> = {
  openai: {
    embedding: ["text-embedding-3-small", "text-embedding-3-large", "text-embedding-ada-002"],
    tts: ["tts-1", "tts-1-hd"],
    imageGen: ["dall-e-3", "dall-e-2"],
  },
  mimo: {
    embedding: ["mimo-embedding-v1"],
    tts: ["mimo-tts-v1"],
    imageGen: ["mimo-imagegen-v1"],
  },
  deepseek: {
    embedding: [],
    tts: [],
    imageGen: [],
  },
  anthropic: {
    embedding: [],
    tts: [],
    imageGen: [],
  },
  gemini: {
    embedding: ["text-embedding-004", "gemini-embedding-001"],
    tts: [],
    imageGen: ["imagen-3.0"],
  },
  moonshot: {
    embedding: [],
    tts: [],
    imageGen: [],
  },
  local: {
    embedding: [
      'Xenova/all-MiniLM-L6-v2',
      'Xenova/all-MiniLM-L12-v2',
      'Xenova/bge-small-zh-v1.5',
      'Xenova/bge-small-en-v1.5',
      'Xenova/multilingual-e5-small',
      'Xenova/gte-small',
      'Xenova/paraphrase-multilingual-MiniLM-L12-v2',
    ],
    tts: [],
    imageGen: [],
  },
};
