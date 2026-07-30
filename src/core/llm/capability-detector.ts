/**
 * 模型能力检测系统
 *
 * 检测当前配置的模型是否支持特定功能（如工具调用、视觉、TTS 等），
 * 并在功能入口提供降级提示。
 *
 * 核心设计:
 * 1. 基于 ModelProfile 的场景模板（TaskSlot）检测用户是否配置了专用模型
 * 2. 基于 ModelConfig 的能力字段检测模型是否支持特定能力
 * 3. 提供 checkFeatureCapability() 统一接口供功能入口调用
 * 4. 纯前端检测，不发送任何网络请求，符合单客户端安装框架要求
 */

import { getModelProfileManager, type TaskSlot, type ModelSlotConfig } from '../llm/model-profile';
import { getSettingJSON } from '../storage/settings';

// ========== 功能能力定义 ==========

export type FeatureCapability =
  | 'text-generation'     // 文本生成（摘要、FAQ、Studio 内容等）
  | 'tool-calling'        // 工具调用（create_note, search_notebook 等）
  | 'vision'              // 视觉理解（图片识别、OCR 等）
  | 'tts'                 // 文本转语音
  | 'image-generation'    // 图像生成
  | 'embedding'           // 向量嵌入（语义搜索）
  | 'streaming';          // 流式输出

export interface CapabilityCheckResult {
  /** 功能是否可用 */
  available: boolean;
  /** 使用的模型来源: 'slot' (场景模板配置) | 'fallback' (回退到 chat) | 'default' (引擎默认) | 'none' (不可用) */
  source: 'slot' | 'fallback' | 'default' | 'none';
  /** 如果可用，对应的模型配置 */
  modelConfig?: ModelSlotConfig;
  /** 如果不可用，原因说明 */
  reason?: string;
  /** 提示消息（中英文） */
  warning?: { zh: string; en: string };
}

// ========== 能力 → 场景模板映射 ==========

const CAPABILITY_TO_SLOT: Record<FeatureCapability, TaskSlot> = {
  'text-generation': 'chat',
  'tool-calling': 'chat',
  'vision': 'chat',
  'tts': 'tts',
  'image-generation': 'imageGen',
  'embedding': 'embedding',
  'streaming': 'chat',
};

// ========== 已知模型能力数据库 ==========
// 基于模型 ID 前缀匹配，不依赖网络请求

interface KnownModelCapabilities {
  supportsTools: boolean;
  supportsVision: boolean;
  supportsStreaming: boolean;
  supportsTTS?: boolean;
  supportsImageGen?: boolean;
  supportsEmbedding?: boolean;
}

const MODEL_CAPABILITY_DB: Record<string, KnownModelCapabilities> = {
  // OpenAI
  'gpt-4o': { supportsTools: true, supportsVision: true, supportsStreaming: true },
  'gpt-4o-mini': { supportsTools: true, supportsVision: true, supportsStreaming: true },
  'gpt-4-turbo': { supportsTools: true, supportsVision: true, supportsStreaming: true },
  'gpt-4': { supportsTools: true, supportsVision: false, supportsStreaming: true },
  'gpt-3.5-turbo': { supportsTools: true, supportsVision: false, supportsStreaming: true },
  'o1': { supportsTools: true, supportsVision: true, supportsStreaming: false },
  'o1-mini': { supportsTools: false, supportsVision: false, supportsStreaming: false },
  'o1-preview': { supportsTools: false, supportsVision: false, supportsStreaming: false },
  'o3': { supportsTools: true, supportsVision: true, supportsStreaming: true },
  'o3-mini': { supportsTools: true, supportsVision: false, supportsStreaming: true },
  'o4-mini': { supportsTools: true, supportsVision: true, supportsStreaming: true },
  // OpenAI TTS
  'tts-1': { supportsTools: false, supportsVision: false, supportsStreaming: false, supportsTTS: true },
  'tts-1-hd': { supportsTools: false, supportsVision: false, supportsStreaming: false, supportsTTS: true },
  // OpenAI Embedding
  'text-embedding-3-small': { supportsTools: false, supportsVision: false, supportsStreaming: false, supportsEmbedding: true },
  'text-embedding-3-large': { supportsTools: false, supportsVision: false, supportsStreaming: false, supportsEmbedding: true },
  'text-embedding-ada-002': { supportsTools: false, supportsVision: false, supportsStreaming: false, supportsEmbedding: true },
  // OpenAI Image
  'dall-e-3': { supportsTools: false, supportsVision: false, supportsStreaming: false, supportsImageGen: true },
  'dall-e-2': { supportsTools: false, supportsVision: false, supportsStreaming: false, supportsImageGen: true },
  'gpt-image-1': { supportsTools: false, supportsVision: false, supportsStreaming: false, supportsImageGen: true },

  // Anthropic
  'claude-opus-4': { supportsTools: true, supportsVision: true, supportsStreaming: true },
  'claude-sonnet-4': { supportsTools: true, supportsVision: true, supportsStreaming: true },
  'claude-3-5-sonnet': { supportsTools: true, supportsVision: true, supportsStreaming: true },
  'claude-3-5-haiku': { supportsTools: true, supportsVision: true, supportsStreaming: true },
  'claude-3-opus': { supportsTools: true, supportsVision: true, supportsStreaming: true },
  'claude-3-sonnet': { supportsTools: true, supportsVision: true, supportsStreaming: true },
  'claude-3-haiku': { supportsTools: true, supportsVision: true, supportsStreaming: true },

  // Google
  'gemini-2': { supportsTools: true, supportsVision: true, supportsStreaming: true },
  'gemini-1.5-pro': { supportsTools: true, supportsVision: true, supportsStreaming: true },
  'gemini-1.5-flash': { supportsTools: true, supportsVision: true, supportsStreaming: true },
  'gemini-1.0-pro': { supportsTools: true, supportsVision: false, supportsStreaming: true },

  // DeepSeek
  'deepseek-chat': { supportsTools: true, supportsVision: false, supportsStreaming: true },
  'deepseek-coder': { supportsTools: true, supportsVision: false, supportsStreaming: true },
  'deepseek-reasoner': { supportsTools: true, supportsVision: false, supportsStreaming: true },
  'deepseek-v3': { supportsTools: true, supportsVision: false, supportsStreaming: true },

  // MiMo
  'mimo-v2': { supportsTools: true, supportsVision: false, supportsStreaming: true },
  'mimo-v2-flash': { supportsTools: true, supportsVision: false, supportsStreaming: true },
  'mimo-v2-pro': { supportsTools: true, supportsVision: false, supportsStreaming: true },

  // Qwen
  'qwen-max': { supportsTools: true, supportsVision: false, supportsStreaming: true },
  'qwen-plus': { supportsTools: true, supportsVision: false, supportsStreaming: true },
  'qwen-turbo': { supportsTools: true, supportsVision: false, supportsStreaming: true },
  'qwen-vl': { supportsTools: true, supportsVision: true, supportsStreaming: true },

  // GLM
  'glm-4': { supportsTools: true, supportsVision: false, supportsStreaming: true },
  'glm-4v': { supportsTools: true, supportsVision: true, supportsStreaming: true },
  'glm-4-flash': { supportsTools: true, supportsVision: false, supportsStreaming: true },

  // Groq
  'llama-3.3-70b': { supportsTools: true, supportsVision: false, supportsStreaming: true },
  'llama-3.1-70b': { supportsTools: true, supportsVision: false, supportsStreaming: true },
  'llama-3.1-8b': { supportsTools: true, supportsVision: false, supportsStreaming: true },
  'mixtral-8x7b': { supportsTools: true, supportsVision: false, supportsStreaming: true },

  // Ollama (local)
  'llama3': { supportsTools: true, supportsVision: false, supportsStreaming: true },
  'llava': { supportsTools: false, supportsVision: true, supportsStreaming: true },
  'qwen2.5': { supportsTools: true, supportsVision: false, supportsStreaming: true },
};

/**
 * 通过模型 ID 前缀匹配查找已知能力
 */
function lookupModelCapabilities(modelId: string): KnownModelCapabilities | null {
  const lower = modelId.toLowerCase();
  // 先尝试精确匹配
  if (MODEL_CAPABILITY_DB[lower]) return MODEL_CAPABILITY_DB[lower];
  // 再尝试前缀匹配
  for (const key of Object.keys(MODEL_CAPABILITY_DB)) {
    if (lower.startsWith(key)) return MODEL_CAPABILITY_DB[key];
  }
  return null;
}

// ========== 核心检测逻辑 ==========

let profileManager: ReturnType<typeof getModelProfileManager> | null = null;

function getProfileManager() {
  if (!profileManager) {
    profileManager = getModelProfileManager();
  }
  return profileManager;
}

/**
 * 检测特定功能能力是否可用
 *
 * 检测顺序:
 * 1. 查找用户场景模板中是否配置了对应 slot 的专用模型
 * 2. 如果 slot 有配置，检测该模型是否支持所需能力
 * 3. 如果 slot 无配置，回退到 chat slot → 引擎默认
 * 4. 检测模型是否支持所需能力
 */
export function checkFeatureCapability(capability: FeatureCapability): CapabilityCheckResult {
  const pm = getProfileManager();
  const slot = CAPABILITY_TO_SLOT[capability];

  // 1. 尝试从场景模板解析
  const slotConfig = pm.resolveSlot(slot);

  if (slotConfig) {
    // 用户配置了专用模型
    const isDirectSlot = pm.getActiveProfile().slots[slot] != null;
    const modelCaps = lookupModelCapabilities(slotConfig.model);

    if (modelCaps) {
      const capable = checkCapabilityAgainstModel(capability, modelCaps);
      if (capable) {
        return {
          available: true,
          source: isDirectSlot ? 'slot' : 'fallback',
          modelConfig: slotConfig,
        };
      } else {
        return {
          available: false,
          source: isDirectSlot ? 'slot' : 'fallback',
          modelConfig: slotConfig,
          reason: `Model "${slotConfig.model}" does not support ${capability}`,
          warning: {
            zh: `当前${getSlotLabel(slot, true)}配置的模型 "${slotConfig.model}" 不支持${getCapabilityLabel(capability, true)}功能。请在设置中更换支持该能力的模型。`,
            en: `The model "${slotConfig.model}" configured for ${getSlotLabel(slot, false)} does not support ${getCapabilityLabel(capability, false)}. Please switch to a model that supports this capability.`,
          },
        };
      }
    } else {
      // 未知模型 — 乐观假设可用，但给出提示
      return {
        available: true,
        source: isDirectSlot ? 'slot' : 'fallback',
        modelConfig: slotConfig,
        warning: {
          zh: `无法确认模型 "${slotConfig.model}" 是否支持${getCapabilityLabel(capability, true)}。如果功能异常，请在设置中更换已知支持的模型。`,
          en: `Cannot confirm if model "${slotConfig.model}" supports ${getCapabilityLabel(capability, false)}. If the feature malfunctions, please switch to a known compatible model.`,
        },
      };
    }
  }

  // 2. 没有配置场景模板 — 使用引擎默认
  const settings = getSettingJSON<any>('codem-settings', {});
  const defaultModel = settings.model || 'gpt-4o-mini';
  const modelCaps = lookupModelCapabilities(defaultModel);

  if (modelCaps) {
    const capable = checkCapabilityAgainstModel(capability, modelCaps);
    if (capable) {
      return {
        available: true,
        source: 'default',
        modelConfig: { provider: settings.provider || 'mimo', model: defaultModel },
      };
    } else {
      return {
        available: false,
        source: 'default',
        reason: `Default model "${defaultModel}" does not support ${capability}`,
        warning: {
          zh: `当前默认模型 "${defaultModel}" 不支持${getCapabilityLabel(capability, true)}。请在设置 → 模型配置中配置支持该能力的模型，或创建场景模板分配专用模型。`,
          en: `The default model "${defaultModel}" does not support ${getCapabilityLabel(capability, false)}. Please configure a compatible model in Settings → Model Configuration, or create a scene profile with a dedicated model.`,
        },
      };
    }
  }

  // 3. 未知模型 — 乐观假设
  return {
    available: true,
    source: 'default',
    modelConfig: { provider: settings.provider || 'mimo', model: defaultModel },
    warning: {
      zh: `无法确认模型 "${defaultModel}" 的能力。如果${getCapabilityLabel(capability, true)}功能异常，请在设置中配置支持该能力的模型。`,
      en: `Cannot confirm capabilities of model "${defaultModel}". If ${getCapabilityLabel(capability, false)} malfunctions, please configure a compatible model.`,
    },
  };
}

function checkCapabilityAgainstModel(capability: FeatureCapability, caps: KnownModelCapabilities): boolean {
  switch (capability) {
    case 'text-generation':
      return true; // 所有 LLM 都支持文本生成
    case 'tool-calling':
      return caps.supportsTools;
    case 'vision':
      return caps.supportsVision;
    case 'tts':
      return caps.supportsTTS ?? false;
    case 'image-generation':
      return caps.supportsImageGen ?? false;
    case 'embedding':
      return caps.supportsEmbedding ?? false;
    case 'streaming':
      return caps.supportsStreaming;
    default:
      return true;
  }
}

// ========== 辅助函数 ==========

function getSlotLabel(slot: TaskSlot, zh: boolean): string {
  const labels: Record<string, { zh: string; en: string }> = {
    chat: { zh: '主对话', en: 'Chat' },
    subagent: { zh: '子智能体', en: 'Sub-agent' },
    memory: { zh: '记忆提取', en: 'Memory' },
    compaction: { zh: '上下文压缩', en: 'Compaction' },
    tts: { zh: '语音合成', en: 'TTS' },
    imageGen: { zh: '图像生成', en: 'Image Generation' },
    embedding: { zh: '向量嵌入', en: 'Embedding' },
  };
  return labels[slot]?.[zh ? 'zh' : 'en'] || slot;
}

function getCapabilityLabel(cap: FeatureCapability, zh: boolean): string {
  const labels: Record<string, { zh: string; en: string }> = {
    'text-generation': { zh: '文本生成', en: 'text generation' },
    'tool-calling': { zh: '工具调用', en: 'tool calling' },
    'vision': { zh: '视觉理解', en: 'vision' },
    'tts': { zh: '语音合成', en: 'text-to-speech' },
    'image-generation': { zh: '图像生成', en: 'image generation' },
    'embedding': { zh: '向量嵌入', en: 'embedding' },
    'streaming': { zh: '流式输出', en: 'streaming' },
  };
  return labels[cap]?.[zh ? 'zh' : 'en'] || cap;
}

/**
 * 获取功能所需能力的描述（用于 UI 提示）
 */
export function getFeatureRequirements(feature: string): { zh: string; en: string; capabilities: FeatureCapability[] } {
  const requirements: Record<string, { zh: string; en: string; capabilities: FeatureCapability[] }> = {
    'notebook-summary': {
      zh: '笔记本摘要生成需要文本生成能力',
      en: 'Notebook summary requires text generation capability',
      capabilities: ['text-generation'],
    },
    'studio-content': {
      zh: 'Studio 内容生成需要文本生成能力',
      en: 'Studio content generation requires text generation capability',
      capabilities: ['text-generation'],
    },
    'knowledge-graph': {
      zh: '知识图谱提取需要文本生成和工具调用能力',
      en: 'Knowledge graph extraction requires text generation and tool calling',
      capabilities: ['text-generation'],
    },
    'guided-questions': {
      zh: '建议问题生成需要文本生成能力',
      en: 'Suggested questions require text generation',
      capabilities: ['text-generation'],
    },
    'ai-flashcards': {
      zh: 'AI 闪卡生成需要文本生成能力',
      en: 'AI flashcard generation requires text generation',
      capabilities: ['text-generation'],
    },
    'study-path': {
      zh: '学习路径生成需要文本生成能力',
      en: 'Study path generation requires text generation',
      capabilities: ['text-generation'],
    },
    'note-operations': {
      zh: 'AI 笔记操作需要工具调用能力',
      en: 'AI note operations require tool calling',
      capabilities: ['tool-calling'],
    },
    'search-notebook': {
      zh: '笔记本搜索需要工具调用能力',
      en: 'Notebook search requires tool calling',
      capabilities: ['tool-calling'],
    },
    'pdf-annotation': {
      zh: 'PDF 批注需要视觉理解能力',
      en: 'PDF annotation requires vision capability',
      capabilities: ['vision'],
    },
    'audio-overview': {
      zh: '音频摘要需要语音合成能力',
      en: 'Audio overview requires TTS capability',
      capabilities: ['tts', 'text-generation'],
    },
  };
  return requirements[feature] || { zh: '', en: '', capabilities: ['text-generation'] };
}

/**
 * 批量检测功能所需的所有能力是否满足
 */
export function checkFeatureAvailability(feature: string): { available: boolean; warnings: Array<{ zh: string; en: string }> } {
  const req = getFeatureRequirements(feature);
  const warnings: Array<{ zh: string; en: string }> = [];

  for (const cap of req.capabilities) {
    const result = checkFeatureCapability(cap);
    if (!result.available) {
      warnings.push(result.warning || { zh: '', en: '' });
    } else if (result.warning && result.source === 'default') {
      // 未知模型 — 只在 default 源时提示
      // 如果是用户主动配置的 slot，不提示
    }
  }

  return {
    available: warnings.length === 0,
    warnings,
  };
}
