/**
 * 本地 Embedding 引擎 — 基于 ONNX Runtime + 小型 BERT/MiniLM
 *
 * 使用 @huggingface/transformers (纯 WASM ONNX Runtime) 在本地运行 embedding 模型，
 * 无需 API Key、无需网络（首次使用时下载模型并缓存）。
 *
 * === 风险缓解设计 ===
 *
 * 风险1 - 超长切片截断：
 *   Transformer 模型有最大序列长度限制（通常 512 token）。
 *   本模块在 generateLocalEmbeddings 内部增加 sub-chunk 预处理，
 *   将超长文本拆分为 ≤128 token 的片段，分别生成向量后做 mean pooling 合并，
 *   确保不丢失任何内容。
 *
 * 风险2 - 领域冷门术语偏差：
 *   提供多领域模型选择，包括：
 *   - all-MiniLM-L6-v2：通用多语言（默认）
 *   - bge-small-zh-v1.5：中文检索专用，技术语料表现优秀
 *   - bge-small-en-v1.5：英文检索专用
 *   - multilingual-e5-small：微软 E5 系列，50+ 语言，检索优化
 *   - gte-small：通用文本嵌入，GTE 系列检索性能强
 *   BGE/E5/GTE 模型均在检索任务上专门微调，技术领域术语覆盖率更高。
 *
 * 风险3 - Windows 打包轻量化：
 *   - 仅使用 WASM 后端（onnxruntime-web），不打包 Node.js 原生绑定
 *   - 模型文件按需从 HuggingFace Hub 下载并缓存到 IndexedDB
 *   - 动态 import 避免首屏加载
 *   - env 配置确保不引入 PyTorch/TensorFlow 等重量级框架
 *
 * IP 声明：本文件为原创实现，仅调用 @huggingface/transformers 公开 API。
 */

// ========== 类型定义 ==========

export interface LocalEmbeddingConfig {
  /** 模型 ID（HuggingFace Hub 上的标识） */
  modelId: string;
  /** 是否已初始化 */
  initialized: boolean;
}

export interface LocalEmbeddingStatus {
  state: 'not-loaded' | 'loading' | 'ready' | 'error';
  message?: string;
  progress?: number; // 0-100
}

/** 模型领域标签 */
export type ModelDomain = 'general' | 'chinese' | 'english' | 'multilingual' | 'code' | 'technical';

export interface LocalModelInfo {
  id: string;
  name: string;
  size: string;
  dim: number;
  languages: string;
  license: string;
  description: string;
  domain: ModelDomain;
  maxSeqLength: number; // 模型最大序列长度（token）
}

// ========== 常量 ==========

/**
 * 子分块最大 token 数。
 * 设置为 128 而非 512 的原因：
 * 1. 小模型在短文本上表现更稳定（attention 退化少）
 * 2. 降低单次推理内存占用
 * 3. 避免接近 max_seq_length 时的截断边界效应
 */
const SUB_CHUNK_MAX_TOKENS = 128;

// ========== 全局状态 ==========

let pipeline: any = null;
let loadingPromise: Promise<any> | null = null;
let statusCallback: ((status: LocalEmbeddingStatus) => void) | null = null;
let currentModelId: string = '';

// ========== 状态管理 ==========

export function onStatusChange(callback: (status: LocalEmbeddingStatus) => void): void {
  statusCallback = callback;
}

function emitStatus(state: LocalEmbeddingStatus['state'], message?: string, progress?: number): void {
  if (statusCallback) {
    statusCallback({ state, message, progress });
  }
}

export function getStatus(): LocalEmbeddingStatus {
  if (pipeline) return { state: 'ready' };
  if (loadingPromise) return { state: 'loading', message: '正在加载模型...' };
  return { state: 'not-loaded' };
}

// ========== 模型加载 ==========

/**
 * 初始化本地 embedding 模型。
 * 首次调用时会从 HuggingFace Hub 下载模型（~23-120MB），后续从缓存加载。
 *
 * @param modelId HuggingFace 模型 ID，默认 all-MiniLM-L6-v2
 */
export async function initLocalEmbedding(modelId?: string): Promise<void> {
  const targetModelId = modelId || getCurrentModelId();

  // 如果已加载且是同一个模型，直接返回
  if (pipeline && currentModelId === targetModelId) return;

  // 如果正在加载同一个模型，等待
  if (loadingPromise && currentModelId === targetModelId) return loadingPromise;

  // 如果已加载不同模型，先卸载
  if (pipeline && currentModelId !== targetModelId) {
    disposeLocalEmbedding();
  }

  currentModelId = targetModelId;
  saveCurrentModelId(targetModelId);

  loadingPromise = (async () => {
    emitStatus('loading', `正在加载本地嵌入模型 ${targetModelId}...`, 0);

    try {
      // 动态导入，避免影响首屏加载
      // 风险3缓解：仅使用 WASM 后端，不引入重量级框架
      const { pipeline: createPipeline, env } = await import('@huggingface/transformers');

      // === 打包内置策略：WASM + 默认模型随安装包分发 ===
      // WASM 运行时文件（~25MB）放在 public/wasm/，随安装包打包。
      // 默认模型 all-MiniLM-L6-v2（~22MB）放在 public/models/，随安装包打包。
      // 用户安装后完全离线可用，无需任何额外下载，真正实现一键安装。
      // 非默认模型（BGE/E5/GTE 等）仍从 HuggingFace Hub 下载并缓存。
      env.allowLocalModels = true;       // 启用本地模型加载
      env.localModelPath = '/models/';   // 本地模型根路径（对应 public/models/）
      env.useBrowserCache = true;        // 远程模型使用浏览器缓存（IndexedDB）

      // WASM 运行时路径：指向随包打包的本地 WASM 文件
      if (env.backends?.onnx?.wasm) {
        env.backends.onnx.wasm.numThreads = 1; // 单线程，避免多线程 WASM 文件加载问题
        env.backends.onnx.wasm.wasmPaths = '/wasm/'; // 本地 WASM 路径（对应 public/wasm/）
      }

      emitStatus('loading', '正在初始化 ONNX Runtime...', 30);

      // 创建 feature-extraction pipeline
      // quantized=true 使用 INT8 量化模型，体积减小 ~4x
      // 类型断言：@huggingface/transformers v4 的 PretrainedModelOptions 类型未导出 quantized 字段
      pipeline = await createPipeline('feature-extraction', targetModelId, {
        quantized: true,
        progress_callback: (info: any) => {
          if (info.status === 'progress' && info.progress) {
            const pct = Math.round(info.progress);
            emitStatus('loading', `正在加载模型 ${pct}%`, pct);
          } else if (info.status === 'ready') {
            emitStatus('loading', '模型加载完成，正在初始化...', 90);
          }
        },
      } as any);

      emitStatus('ready', '本地嵌入模型已就绪', 100);
    } catch (error) {
      emitStatus('error', `模型加载失败: ${error instanceof Error ? error.message : String(error)}`);
      loadingPromise = null;
      currentModelId = '';
      throw error;
    }
  })();

  return loadingPromise;
}

// ========== 模型 ID 持久化 ==========

const MODEL_ID_KEY = 'codem-local-embedding-model';

function getCurrentModelId(): string {
  try {
    return localStorage.getItem(MODEL_ID_KEY) || 'Xenova/all-MiniLM-L6-v2';
  } catch {
    return 'Xenova/all-MiniLM-L6-v2';
  }
}

function saveCurrentModelId(modelId: string): void {
  try {
    localStorage.setItem(MODEL_ID_KEY, modelId);
  } catch {
    // ignore storage errors
  }
}

// ========== 风险1缓解：子分块预处理 ==========

/**
 * 粗略估算文本的 token 数。
 * CJK 字符约 1.5 token/字，Latin 约 4 字符/token。
 */
function estimateTokenCount(text: string): number {
  if (!text) return 0;
  const cjkChars = (text.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
  const otherChars = text.length - cjkChars;
  return Math.ceil(cjkChars * 1.5 + otherChars / 4);
}

/**
 * 将超长文本拆分为 ≤128 token 的子片段。
 *
 * 策略：
 * 1. 先按句子分割（中英文标点）
 * 2. 逐句累积，达到 SUB_CHUNK_MAX_TOKENS 时切出
 * 3. 单句超过限制的，按字符硬切
 *
 * @returns 子片段数组
 */
function subChunkForEmbedding(text: string): string[] {
  if (!text || !text.trim()) return [];

  const estTokens = estimateTokenCount(text);

  // 如果文本本身就很短，直接返回
  if (estTokens <= SUB_CHUNK_MAX_TOKENS) {
    return [text.trim()];
  }

  const subChunks: string[] = [];

  // 按句子分割
  const sentences = splitBySentences(text);

  let currentSub = '';
  let currentTokens = 0;

  for (const sentence of sentences) {
    const sentTokens = estimateTokenCount(sentence);

    // 单句就超过限制，按字符硬切
    if (sentTokens > SUB_CHUNK_MAX_TOKENS) {
      // 先保存当前累积
      if (currentSub.trim()) {
        subChunks.push(currentSub.trim());
        currentSub = '';
        currentTokens = 0;
      }

      // 按字符硬切（每 ~80 个 CJK 字符或 ~300 个 Latin 字符切一段）
      const charsPerSub = sentence.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/)
        ? Math.floor(SUB_CHUNK_MAX_TOKENS / 1.5)
        : SUB_CHUNK_MAX_TOKENS * 4;

      for (let i = 0; i < sentence.length; i += charsPerSub) {
        const piece = sentence.slice(i, i + charsPerSub).trim();
        if (piece) subChunks.push(piece);
      }
      continue;
    }

    // 累积句子
    if (currentTokens + sentTokens > SUB_CHUNK_MAX_TOKENS && currentSub) {
      subChunks.push(currentSub.trim());
      currentSub = sentence;
      currentTokens = sentTokens;
    } else {
      currentSub = currentSub ? `${currentSub} ${sentence}` : sentence;
      currentTokens += sentTokens;
    }
  }

  if (currentSub.trim()) {
    subChunks.push(currentSub.trim());
  }

  return subChunks;
}

/**
 * 按句子分割（支持中英文标点）。
 */
function splitBySentences(text: string): string[] {
  const sentenceEnders = /([.!?。！？；;]\s+)/g;
  const sentences: string[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = sentenceEnders.exec(text)) !== null) {
    const end = match.index + match[0].length;
    const sentence = text.slice(lastIndex, end).trim();
    if (sentence) sentences.push(sentence);
    lastIndex = end;
  }

  const remaining = text.slice(lastIndex).trim();
  if (remaining) sentences.push(remaining);

  return sentences;
}

/**
 * 对多个子片段的 embedding 做 mean pooling 合并为一个向量。
 */
function meanPoolEmbeddings(embeddings: number[][]): number[] {
  if (embeddings.length === 0) return [];
  if (embeddings.length === 1) return embeddings[0];

  const dim = embeddings[0].length;
  const result = new Array(dim).fill(0);

  for (const emb of embeddings) {
    for (let i = 0; i < dim; i++) {
      result[i] += emb[i];
    }
  }

  // 平均
  for (let i = 0; i < dim; i++) {
    result[i] /= embeddings.length;
  }

  // L2 归一化
  let norm = 0;
  for (let i = 0; i < dim; i++) {
    norm += result[i] * result[i];
  }
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < dim; i++) {
      result[i] /= norm;
    }
  }

  return result;
}

// ========== 向量生成 ==========

/**
 * 对文本数组生成 embedding 向量。
 *
 * 风险1缓解：内部自动对超长文本进行子分块，
 * 分别生成向量后 mean pooling 合并，确保不丢失内容。
 *
 * @param texts 文本数组
 * @param modelId 可选，指定模型 ID
 * @returns embedding 数组（维度取决于模型）
 */
export async function generateLocalEmbeddings(texts: string[]): Promise<number[][]> {
  if (!pipeline) {
    await initLocalEmbedding();
  }

  const results: number[][] = [];

  // 逐条处理，每条内部做子分块
  for (const text of texts) {
    // 风险1缓解：子分块预处理
    const subChunks = subChunkForEmbedding(text);

    if (subChunks.length === 0) {
      // 空文本，返回零向量（维度需要从模型获取）
      const dim = getLocalEmbeddingDim();
      results.push(new Array(dim).fill(0));
      continue;
    }

    if (subChunks.length === 1) {
      // 单片段，直接生成
      const output = await pipeline(subChunks[0], {
        pooling: 'mean',
        normalize: true,
      });
      results.push(Array.from(output.data as Float32Array));
    } else {
      // 多片段：分别生成，然后 mean pooling 合并
      const subEmbeddings: number[][] = [];
      for (const sub of subChunks) {
        const output = await pipeline(sub, {
          pooling: 'mean',
          normalize: true,
        });
        subEmbeddings.push(Array.from(output.data as Float32Array));
      }
      results.push(meanPoolEmbeddings(subEmbeddings));
    }
  }

  return results;
}

/**
 * 检查本地模型是否可用（已加载或正在加载）。
 */
export function isLocalEmbeddingAvailable(): boolean {
  return pipeline !== null;
}

/**
 * 获取本地 embedding 的维度（根据当前模型）。
 */
export function getLocalEmbeddingDim(): number {
  const model = AVAILABLE_LOCAL_MODELS.find((m) => m.id === currentModelId);
  return model?.dim || 384;
}

/**
 * 卸载模型，释放内存。
 */
export function disposeLocalEmbedding(): void {
  pipeline = null;
  loadingPromise = null;
  currentModelId = '';
  emitStatus('not-loaded');
}

// ========== 默认配置 ==========

export const LOCAL_EMBEDDING_DEFAULTS: LocalEmbeddingConfig = {
  modelId: 'Xenova/all-MiniLM-L6-v2',
  initialized: false,
};

/**
 * 可用的本地模型列表 — 风险2缓解：多领域模型选择
 *
 * 模型分类：
 * - general：通用场景，速度优先
 * - chinese：中文检索专用
 * - english：英文检索专用
 * - multilingual：多语言混合
 * - code/technical：技术领域语料覆盖更好
 *
 * 所有模型均为 Apache-2.0 或 MIT 许可，量化后体积 23-120MB。
 */
export const AVAILABLE_LOCAL_MODELS: readonly LocalModelInfo[] = [
  {
    id: 'Xenova/all-MiniLM-L6-v2',
    name: 'all-MiniLM-L6-v2 (推荐·通用)',
    size: '~23MB',
    dim: 384,
    languages: '多语言 (含中文)',
    license: 'Apache-2.0',
    description: '体积最小、速度最快。通用场景推荐首选，50+ 语言。',
    domain: 'general',
    maxSeqLength: 512,
  },
  {
    id: 'Xenova/all-MiniLM-L12-v2',
    name: 'all-MiniLM-L12-v2 (通用·更精确)',
    size: '~33MB',
    dim: 384,
    languages: '多语言 (含中文)',
    license: 'Apache-2.0',
    description: '层数更多，精度更高，速度稍慢。',
    domain: 'general',
    maxSeqLength: 512,
  },
  {
    id: 'Xenova/bge-small-zh-v1.5',
    name: 'bge-small-zh-v1.5 (中文检索专用)',
    size: '~48MB',
    dim: 512,
    languages: '中文',
    license: 'MIT',
    description: 'BAAI BGE 系列，中文检索 SOTA。技术文档、工控术语覆盖优秀，推荐中文知识库使用。',
    domain: 'chinese',
    maxSeqLength: 512,
  },
  {
    id: 'Xenova/bge-small-en-v1.5',
    name: 'bge-small-en-v1.5 (英文检索专用)',
    size: '~67MB',
    dim: 384,
    languages: '英文',
    license: 'MIT',
    description: 'BAAI BGE 英文版，检索任务专门微调，代码文档/技术规范领域表现优秀。',
    domain: 'english',
    maxSeqLength: 512,
  },
  {
    id: 'Xenova/multilingual-e5-small',
    name: 'multilingual-e5-small (多语言检索)',
    size: '~120MB',
    dim: 384,
    languages: '50+ 语言',
    license: 'MIT',
    description: '微软 E5 系列，多语言检索优化。混合中英文技术文档场景推荐。',
    domain: 'multilingual',
    maxSeqLength: 512,
  },
  {
    id: 'Xenova/gte-small',
    name: 'gte-small (通用文本嵌入)',
    size: '~33MB',
    dim: 384,
    languages: '英文',
    license: 'MIT',
    description: 'Alibaba GTE 系列，检索性能强劲，技术领域泛化能力好。',
    domain: 'technical',
    maxSeqLength: 512,
  },
  {
    id: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2',
    name: 'multilingual-MiniLM-L12-v2 (多语言改写)',
    size: '~46MB',
    dim: 384,
    languages: '50+ 语言',
    license: 'Apache-2.0',
    description: '多语言模型，中文效果最好。适合改写/相似度匹配场景。',
    domain: 'multilingual',
    maxSeqLength: 512,
  },
] as const;

/**
 * 根据领域推荐模型。
 */
export function recommendModelByDomain(domain: ModelDomain): string {
  const model = AVAILABLE_LOCAL_MODELS.find((m) => m.domain === domain);
  return model?.id || 'Xenova/all-MiniLM-L6-v2';
}

/**
 * 获取当前已加载的模型 ID。
 */
export function getLoadedModelId(): string {
  return currentModelId;
}
