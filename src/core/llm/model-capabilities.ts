/**
 * 模型能力的**唯一真源**（视觉/工具/流式等）。
 *
 * ## 为什么要有这个文件
 *
 * 真机 bug：设置里选的是 `deepseek-flash`（原生多模态），输入区却提示
 * 「当前模型不支持视觉，图片将以文字标注发送」。根因不是漏了一个 if，而是
 * **同一件事有三份实现**：
 *   1. `components/InputArea.tsx` 的 `modelSupportsVision`（只认 gpt/claude/gemini/o3/o4）；
 *   2. `core/llm/capability-detector.ts` 的 `MODEL_CAPABILITY_DB`（**有** deepseek-flash）；
 *   3. `core/llm/vision-proxy.ts` 的私有 `modelSupportsVision`（又没有 deepseek-flash）。
 * 三份表必然漂移；漂移的后果是「提示说不能发图」+「图片被送去代理描述」两处同时出错。
 *
 * 现在：能力表只在这里；UI 提示、视觉代理路由、场景模板检测都读它。
 *
 * ## 判定口径
 *
 * - **精确匹配优先**，再做前缀匹配（长键优先，避免 `mimo-v2.5-pro` 被 `mimo-v2.5` 吃掉）；
 * - 未知模型返回 `null` → 调用方按业务决定（视觉提示保守说"不确定"，代理路由保守走代理）。
 */

export interface KnownModelCapabilities {
  supportsTools: boolean;
  supportsVision: boolean;
  supportsStreaming: boolean;
  supportsTTS?: boolean;
  supportsImageGen?: boolean;
  supportsEmbedding?: boolean;
}

const MODEL_CAPABILITY_DB: Record<string, KnownModelCapabilities> = {
  // OpenAI
  "gpt-4o": { supportsTools: true, supportsVision: true, supportsStreaming: true },
  "gpt-4o-mini": { supportsTools: true, supportsVision: true, supportsStreaming: true },
  "gpt-4-turbo": { supportsTools: true, supportsVision: true, supportsStreaming: true },
  "gpt-4": { supportsTools: true, supportsVision: false, supportsStreaming: true },
  "gpt-3.5-turbo": { supportsTools: true, supportsVision: false, supportsStreaming: true },
  o1: { supportsTools: true, supportsVision: true, supportsStreaming: false },
  "o1-mini": { supportsTools: false, supportsVision: false, supportsStreaming: false },
  "o1-preview": { supportsTools: false, supportsVision: false, supportsStreaming: false },
  o3: { supportsTools: true, supportsVision: true, supportsStreaming: true },
  "o3-mini": { supportsTools: true, supportsVision: false, supportsStreaming: true },
  "o4-mini": { supportsTools: true, supportsVision: true, supportsStreaming: true },
  // OpenAI TTS
  "tts-1": { supportsTools: false, supportsVision: false, supportsStreaming: false, supportsTTS: true },
  "tts-1-hd": { supportsTools: false, supportsVision: false, supportsStreaming: false, supportsTTS: true },
  // OpenAI Embedding
  "text-embedding-3-small": { supportsTools: false, supportsVision: false, supportsStreaming: false, supportsEmbedding: true },
  "text-embedding-3-large": { supportsTools: false, supportsVision: false, supportsStreaming: false, supportsEmbedding: true },
  "text-embedding-ada-002": { supportsTools: false, supportsVision: false, supportsStreaming: false, supportsEmbedding: true },
  // OpenAI Image
  "dall-e-3": { supportsTools: false, supportsVision: false, supportsStreaming: false, supportsImageGen: true },
  "dall-e-2": { supportsTools: false, supportsVision: false, supportsStreaming: false, supportsImageGen: true },
  "gpt-image-1": { supportsTools: false, supportsVision: false, supportsStreaming: false, supportsImageGen: true },

  // Anthropic
  "claude-opus-4": { supportsTools: true, supportsVision: true, supportsStreaming: true },
  "claude-sonnet-4": { supportsTools: true, supportsVision: true, supportsStreaming: true },
  "claude-3-5-sonnet": { supportsTools: true, supportsVision: true, supportsStreaming: true },
  "claude-3-5-haiku": { supportsTools: true, supportsVision: true, supportsStreaming: true },
  "claude-3-opus": { supportsTools: true, supportsVision: true, supportsStreaming: true },
  "claude-3-sonnet": { supportsTools: true, supportsVision: true, supportsStreaming: true },
  "claude-3-haiku": { supportsTools: true, supportsVision: true, supportsStreaming: true },
  // 命名变体兜底：`claude-4-opus` 这类「代际在前」的 id 在真实目录里出现过；
  // 旧 UI 前缀表也认 `claude-3`/`claude-4`，并入后行为不回退。精确键优先于它们。
  "claude-4": { supportsTools: true, supportsVision: true, supportsStreaming: true },
  "claude-3": { supportsTools: true, supportsVision: true, supportsStreaming: true },

  // Google
  "gemini-2": { supportsTools: true, supportsVision: true, supportsStreaming: true },
  "gemini-1.5-pro": { supportsTools: true, supportsVision: true, supportsStreaming: true },
  "gemini-1.5-flash": { supportsTools: true, supportsVision: true, supportsStreaming: true },
  "gemini-1.0-pro": { supportsTools: true, supportsVision: false, supportsStreaming: true },

  // DeepSeek
  "deepseek-chat": { supportsTools: true, supportsVision: false, supportsStreaming: true },
  "deepseek-coder": { supportsTools: true, supportsVision: false, supportsStreaming: true },
  "deepseek-reasoner": { supportsTools: true, supportsVision: false, supportsStreaming: true },
  "deepseek-v3": { supportsTools: true, supportsVision: false, supportsStreaming: true },
  // V4.1-Flash（当前 id）原生多模态；旧 vision-exp 只是临时路由别名，已 retired
  "deepseek-flash": { supportsTools: true, supportsVision: true, supportsStreaming: true },
  "deepseek-v4-flash": { supportsTools: true, supportsVision: true, supportsStreaming: true },
  "deepseek-v4-flash-vision-exp": { supportsTools: true, supportsVision: true, supportsStreaming: true },

  // MiMo
  "mimo-v2.5-pro": { supportsTools: true, supportsVision: false, supportsStreaming: true },
  "mimo-v2.5": { supportsTools: true, supportsVision: true, supportsStreaming: true },
  "mimo-v2": { supportsTools: true, supportsVision: false, supportsStreaming: true },
  "mimo-v2-flash": { supportsTools: true, supportsVision: false, supportsStreaming: true },
  "mimo-v2-pro": { supportsTools: true, supportsVision: false, supportsStreaming: true },

  // Qwen
  "qwen-max": { supportsTools: true, supportsVision: false, supportsStreaming: true },
  "qwen-plus": { supportsTools: true, supportsVision: false, supportsStreaming: true },
  "qwen-turbo": { supportsTools: true, supportsVision: false, supportsStreaming: true },
  "qwen-vl": { supportsTools: true, supportsVision: true, supportsStreaming: true },

  // GLM
  "glm-4": { supportsTools: true, supportsVision: false, supportsStreaming: true },
  "glm-4v": { supportsTools: true, supportsVision: true, supportsStreaming: true },
  "glm-4-flash": { supportsTools: true, supportsVision: false, supportsStreaming: true },

  // Groq
  "llama-3.3-70b": { supportsTools: true, supportsVision: false, supportsStreaming: true },
  "llama-3.1-70b": { supportsTools: true, supportsVision: false, supportsStreaming: true },
  "llama-3.1-8b": { supportsTools: true, supportsVision: false, supportsStreaming: true },
  "mixtral-8x7b": { supportsTools: true, supportsVision: false, supportsStreaming: true },

  // Ollama (local)
  llama3: { supportsTools: true, supportsVision: false, supportsStreaming: true },
  llava: { supportsTools: false, supportsVision: true, supportsStreaming: true },
  "qwen2.5": { supportsTools: true, supportsVision: false, supportsStreaming: true },
};

/** 前缀键按长度降序（长键优先），避免 `mimo-v2.5-pro` 命中 `mimo-v2.5`。 */
const PREFIX_KEYS = Object.keys(MODEL_CAPABILITY_DB).sort((a, b) => b.length - a.length);

/** 按模型 id 查能力：精确 → 长前缀；未知返回 `null`（不猜）。 */
export function lookupModelCapabilities(modelId: string): KnownModelCapabilities | null {
  const id = (modelId || "").trim().toLowerCase();
  if (!id) return null;
  if (MODEL_CAPABILITY_DB[id]) return MODEL_CAPABILITY_DB[id];
  for (const key of PREFIX_KEYS) {
    if (id.startsWith(key)) return MODEL_CAPABILITY_DB[key];
  }
  return null;
}

/**
 * 模型是否原生支持图片输入。
 *
 * 未知模型返回 `false`（保守）：宁可提示用户配置视觉代理，也不要把图片塞给
 * 一个可能拒绝的接口。**已知多模态模型必须在这里为 true** —— 三份表合一后，
 * UI 提示与代理路由不会再互相矛盾。
 */
export function modelSupportsVision(modelId: string): boolean {
  return lookupModelCapabilities(modelId)?.supportsVision ?? false;
}
