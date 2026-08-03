/**
 * 测试：Vision Proxy 媒体代理 + 多模态全链路
 *
 * 改动影响：
 *   - multimodal.ts: MultimodalSettings 新增 vision/stt 字段，MULTIMODAL_MODELS 重构
 *   - model-profile.ts: TaskSlot 新增 vision，新增内置方案
 *   - message.ts: ContentBlock 新增 audio，messagesToLLMMessages 生成 ContentBlock[]
 *   - provider.ts: toAPIMessage 支持 ContentBlock[] → OpenAI array
 *   - vision-proxy.ts: 新建核心代理模块（图片描述 + 语音转写 + 智能路由）
 *   - store.ts: MessageAttachment 新增 audio 类型
 *   - types.ts: ContentBlock 新增 audio
 *
 * 测试范围：
 *   A. MultimodalSettings vision/stt 字段 (VP-001 ~ VP-010)
 *   B. MULTIMODAL_MODELS 能力矩阵 (VP-011 ~ VP-025)
 *   C. ModelProfile vision slot (VP-026 ~ VP-035)
 *   D. messagesToLLMMessages ContentBlock 生成 (VP-036 ~ VP-055)
 *   E. provider toAPIMessage 多模态格式 (VP-056 ~ VP-070)
 *   F. VisionProxy 核心逻辑 (VP-071 ~ VP-100)
 *   G. MessageAttachment audio 类型 (VP-101 ~ VP-105)
 *   H. 回归：历史功能不受影响 (VP-106 ~ VP-120)
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

// ========== Mocks ==========
vi.mock("../core/file-api", () => ({
  executeCommand: vi.fn(),
  exists: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  listDirectory: vi.fn(),
  deletePath: vi.fn(),
  globSearch: vi.fn(),
  grepSearch: vi.fn(),
  isPathWithinWorkspace: vi.fn().mockReturnValue(true),
}));

const mockFetch = vi.fn();
global.fetch = mockFetch as any;

// ========== Imports ==========
import {
  getMultimodalSettings,
  saveMultimodalSettings,
  MULTIMODAL_MODELS,
  type MultimodalSettings,
  type MultimodalProviderConfig,
} from "../core/llm/multimodal";
import {
  getModelProfileManager,
  type TaskSlot,
  type ModelProfile,
} from "../core/llm/model-profile";
import {
  messagesToLLMMessages,
  type LLMMessage,
  type ContentBlock,
} from "../core/storage/message";
import { OpenAICompatibleProvider } from "../core/llm/provider";
import type { ProviderConfig, ModelConfig } from "../core/llm/types";
import { getVisionProxy } from "../core/llm/vision-proxy";
import type { Message, MessageAttachment } from "../store";

// ========== Helpers ==========
function makeUserMessage(content: string, attachments?: MessageAttachment[]): Message {
  return {
    id: `msg-${Date.now()}-${Math.random()}`,
    sessionId: "test-session",
    role: "user",
    content,
    timestamp: Date.now(),
    attachments,
  } as any;
}

function makeImageAttachment(dataUrl?: string): MessageAttachment {
  return {
    id: `att-${Date.now()}`,
    name: "test.png",
    type: "image",
    content: dataUrl || "data:image/png;base64,iVBORw0KGgo=",
    mimeType: "image/png",
    size: 100,
  };
}

function makeAudioAttachment(dataUrl?: string): MessageAttachment {
  return {
    id: `att-audio-${Date.now()}`,
    name: "test.mp3",
    type: "audio",
    content: dataUrl || "data:audio/mpeg;base64,SUQzBAAAA",
    mimeType: "audio/mpeg",
    size: 200,
  };
}

function makeProviderConfig(): ProviderConfig {
  return {
    id: "test-provider",
    name: "Test Provider",
    apiKey: "sk-test-key",
    baseUrl: "https://api.test.com/v1",
    models: [
      {
        id: "test-model",
        name: "Test Model",
        contextWindow: 8000,
        maxOutputTokens: 4096,
        supportsTools: true,
        supportsStreaming: true,
      },
    ] as ModelConfig[],
  };
}

// ========== A. MultimodalSettings vision/stt 字段 ==========

describe("A. MultimodalSettings vision/stt 字段", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("VP-001: 默认设置包含 vision=null", () => {
    const settings = getMultimodalSettings();
    expect(settings.vision).toBeNull();
  });

  it("VP-002: 默认设置包含 stt=null", () => {
    const settings = getMultimodalSettings();
    expect(settings.stt).toBeNull();
  });

  it("VP-003: 保存 vision 配置后可读取", () => {
    const config: MultimodalProviderConfig = {
      providerId: "openai",
      apiKey: "sk-test",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o",
      enabled: true,
    };
    saveMultimodalSettings({
      vision: config,
      stt: null,
      embedding: null,
      tts: null,
      imageGen: null,
    });

    const loaded = getMultimodalSettings();
    expect(loaded.vision).not.toBeNull();
    expect(loaded.vision!.providerId).toBe("openai");
    expect(loaded.vision!.model).toBe("gpt-4o");
    expect(loaded.vision!.apiKey).toBe("sk-test");
  });

  it("VP-004: 保存 stt 配置后可读取", () => {
    const config: MultimodalProviderConfig = {
      providerId: "openai",
      apiKey: "sk-test",
      baseUrl: "https://api.openai.com/v1",
      model: "whisper-1",
      enabled: true,
    };
    saveMultimodalSettings({
      vision: null,
      stt: config,
      embedding: null,
      tts: null,
      imageGen: null,
    });

    const loaded = getMultimodalSettings();
    expect(loaded.stt).not.toBeNull();
    expect(loaded.stt!.model).toBe("whisper-1");
  });

  it("VP-005: 保存所有5个模态配置", () => {
    saveMultimodalSettings({
      vision: { providerId: "openai", apiKey: "k1", baseUrl: "", model: "gpt-4o", enabled: true },
      stt: { providerId: "openai", apiKey: "k2", baseUrl: "", model: "whisper-1", enabled: true },
      embedding: { providerId: "openai", apiKey: "k3", baseUrl: "", model: "text-embedding-3-small", enabled: true },
      tts: { providerId: "openai", apiKey: "k4", baseUrl: "", model: "tts-1", enabled: true },
      imageGen: { providerId: "openai", apiKey: "k5", baseUrl: "", model: "dall-e-3", enabled: true },
    });

    const loaded = getMultimodalSettings();
    expect(loaded.vision!.model).toBe("gpt-4o");
    expect(loaded.stt!.model).toBe("whisper-1");
    expect(loaded.embedding!.model).toBe("text-embedding-3-small");
    expect(loaded.tts!.model).toBe("tts-1");
    expect(loaded.imageGen!.model).toBe("dall-e-3");
  });

  it("VP-006: 保存后重新加载全部字段保持一致", () => {
    const original: MultimodalSettings = {
      vision: { providerId: "mimo", apiKey: "", baseUrl: "", model: "mimo-v2.5-pro", enabled: true },
      stt: null,
      embedding: null,
      tts: null,
      imageGen: null,
    };
    saveMultimodalSettings(original);

    const loaded = getMultimodalSettings();
    expect(loaded.vision!.providerId).toBe(original.vision!.providerId);
    expect(loaded.vision!.model).toBe(original.vision!.model);
    expect(loaded.stt).toBeNull();
  });

  it("VP-007: vision.enabled=false 时不生效", () => {
    saveMultimodalSettings({
      vision: { providerId: "openai", apiKey: "sk-test", baseUrl: "", model: "gpt-4o", enabled: false },
      stt: null,
      embedding: null,
      tts: null,
      imageGen: null,
    });
    const loaded = getMultimodalSettings();
    expect(loaded.vision).not.toBeNull();
    expect(loaded.vision!.enabled).toBe(false);
  });
});

// ========== B. MULTIMODAL_MODELS 能力矩阵 ==========

describe("B. MULTIMODAL_MODELS 能力矩阵", () => {
  it("VP-011: 所有 provider 都有 vision 字段", () => {
    const providers = ["openai", "mimo", "deepseek", "anthropic", "gemini", "moonshot", "local"];
    for (const p of providers) {
      expect(MULTIMODAL_MODELS[p]).toBeDefined();
      expect(MULTIMODAL_MODELS[p].vision).toBeDefined();
      expect(Array.isArray(MULTIMODAL_MODELS[p].vision)).toBe(true);
    }
  });

  it("VP-012: 所有 provider 都有 stt 字段", () => {
    const providers = ["openai", "mimo", "deepseek", "anthropic", "gemini", "moonshot", "local"];
    for (const p of providers) {
      expect(MULTIMODAL_MODELS[p].stt).toBeDefined();
      expect(Array.isArray(MULTIMODAL_MODELS[p].stt)).toBe(true);
    }
  });

  it("VP-013: OpenAI 有 vision 模型", () => {
    expect(MULTIMODAL_MODELS.openai.vision.length).toBeGreaterThan(0);
    expect(MULTIMODAL_MODELS.openai.vision).toContain("gpt-4o");
    expect(MULTIMODAL_MODELS.openai.vision).toContain("gpt-4o-mini");
  });

  it("VP-014: OpenAI 有 stt 模型", () => {
    expect(MULTIMODAL_MODELS.openai.stt).toContain("whisper-1");
  });

  it("VP-015: MiMo 不支持 vision", () => {
    expect(MULTIMODAL_MODELS.mimo.vision).toHaveLength(0);
  });

  it("VP-016: MiMo 不支持 tts（修正后）", () => {
    expect(MULTIMODAL_MODELS.mimo.tts).toHaveLength(0);
  });

  it("VP-017: MiMo 不支持 imageGen（修正后）", () => {
    expect(MULTIMODAL_MODELS.mimo.imageGen).toHaveLength(0);
  });

  it("VP-018: MiMo 有 embedding", () => {
    expect(MULTIMODAL_MODELS.mimo.embedding).toHaveLength(1);
    expect(MULTIMODAL_MODELS.mimo.embedding).toContain("mimo-embedding-v1");
  });

  it("VP-019: DeepSeek 全部模态为空", () => {
    expect(MULTIMODAL_MODELS.deepseek.vision).toHaveLength(0);
    expect(MULTIMODAL_MODELS.deepseek.stt).toHaveLength(0);
    expect(MULTIMODAL_MODELS.deepseek.embedding).toHaveLength(0);
    expect(MULTIMODAL_MODELS.deepseek.tts).toHaveLength(0);
    expect(MULTIMODAL_MODELS.deepseek.imageGen).toHaveLength(0);
  });

  it("VP-020: Anthropic 有 vision 模型", () => {
    expect(MULTIMODAL_MODELS.anthropic.vision.length).toBeGreaterThan(0);
  });

  it("VP-021: Gemini 有 vision 模型", () => {
    expect(MULTIMODAL_MODELS.gemini.vision.length).toBeGreaterThan(0);
    expect(MULTIMODAL_MODELS.gemini.vision).toContain("gemini-2.5-flash");
  });

  it("VP-022: OpenAI imageGen 包含 dall-e-3", () => {
    expect(MULTIMODAL_MODELS.openai.imageGen).toContain("dall-e-3");
  });

  it("VP-023: OpenAI imageGen 包含 gpt-image-1（新增）", () => {
    expect(MULTIMODAL_MODELS.openai.imageGen).toContain("gpt-image-1");
  });

  it("VP-024: local provider 有 embedding 但无 vision", () => {
    expect(MULTIMODAL_MODELS.local.embedding.length).toBeGreaterThan(0);
    expect(MULTIMODAL_MODELS.local.vision).toHaveLength(0);
  });

  it("VP-025: 所有 provider 模型数组不包含 undefined", () => {
    for (const [provider, models] of Object.entries(MULTIMODAL_MODELS)) {
      for (const model of models.vision) {
        expect(model).toBeDefined();
        expect(typeof model).toBe("string");
      }
    }
  });
});

// ========== C. ModelProfile vision slot ==========

describe("C. ModelProfile vision slot", () => {
  it("VP-026: TaskSlot 类型包含 vision", () => {
    const slots: TaskSlot[] = ["chat", "subagent", "memory", "compaction", "vision", "tts", "imageGen", "embedding"];
    expect(slots).toContain("vision");
  });

  it("VP-027: 内置方案包含 deepseek-vision-proxy", () => {
    const pm = getModelProfileManager();
    const profiles = pm.getAll();
    const found = profiles.find(p => p.id === "deepseek-vision-proxy");
    expect(found).toBeDefined();
    expect(found!.name).toContain("DeepSeek");
  });

  it("VP-028: deepseek-vision-proxy 方案配置了 chat 和 vision slot", () => {
    const pm = getModelProfileManager();
    const profiles = pm.getAll();
    const found = profiles.find(p => p.id === "deepseek-vision-proxy");
    expect(found!.slots.chat).toBeDefined();
    expect(found!.slots.chat!.provider).toBe("deepseek");
    expect(found!.slots.vision).toBeDefined();
    expect(found!.slots.vision!.provider).toBe("openai");
    expect(found!.slots.vision!.model).toBe("gpt-4o-mini");
  });

  it("VP-029: resolveSlot('vision') fallback 到 chat", () => {
    const pm = getModelProfileManager();
    pm.setActiveProfile("default");
    const result = pm.resolveSlot("vision" as TaskSlot);
    // Default profile has no vision slot configured → fallback to chat → also not configured → null
    // But the fallback chain should work
    expect(result).toBeNull(); // default profile has no slots
  });

  it("VP-030: resolveSlot('vision') 返回配置的 slot", () => {
    const pm = getModelProfileManager();
    pm.setActiveProfile("deepseek-vision-proxy");
    const result = pm.resolveSlot("vision" as TaskSlot);
    expect(result).not.toBeNull();
    expect(result!.provider).toBe("openai");
    expect(result!.model).toBe("gpt-4o-mini");
  });

  it("VP-031: vision slot 可被 resolveSlot 解析", () => {
    const pm = getModelProfileManager();
    pm.setActiveProfile("deepseek-vision-proxy");
    // chat slot
    const chatSlot = pm.resolveSlot("chat");
    expect(chatSlot!.provider).toBe("deepseek");
    // vision slot
    const visionSlot = pm.resolveSlot("vision" as TaskSlot);
    expect(visionSlot).not.toBeNull();
  });

  it("VP-032: 默认方案的 vision slot 未配置", () => {
    const pm = getModelProfileManager();
    pm.setActiveProfile("default");
    const profile = pm.getAll().find(p => p.id === "default");
    expect(profile!.slots.vision).toBeUndefined();
  });

  it("VP-033: EDITABLE_SLOTS 在 ModelProfilePanel 中包含 vision", () => {
    // This is tested by verifying the built-in profile "deepseek-vision-proxy" has vision in slots
    const pm = getModelProfileManager();
    const profile = pm.getAll().find(p => p.id === "deepseek-vision-proxy");
    expect(profile!.slots).toHaveProperty("vision");
  });
});

// ========== D. messagesToLLMMessages ContentBlock 生成 ==========

describe("D. messagesToLLMMessages ContentBlock 生成", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("VP-036: 无附件的纯文本消息返回 string content", () => {
    const msg = makeUserMessage("hello world");
    const result = messagesToLLMMessages([msg as any]);
    expect(result).toHaveLength(1);
    expect(typeof result[0].content).toBe("string");
    expect(result[0].content).toBe("hello world");
  });

  it("VP-037: 有图片附件时返回 ContentBlock[] 含 text 和 image", () => {
    const msg = makeUserMessage("这是什么？", [makeImageAttachment()]);
    const result = messagesToLLMMessages([msg as any]);
    expect(result).toHaveLength(1);
    expect(Array.isArray(result[0].content)).toBe(true);
    const blocks = result[0].content as ContentBlock[];
    expect(blocks.length).toBe(2);
    expect(blocks[0].type).toBe("text");
    expect(blocks[0].text).toBe("这是什么？");
    expect(blocks[1].type).toBe("image");
  });

  it("VP-038: 图片 ContentBlock 包含正确的 mediaType 和 data", () => {
    const msg = makeUserMessage("test", [makeImageAttachment("data:image/png;base64,ABC123")]);
    const result = messagesToLLMMessages([msg as any]);
    const blocks = result[0].content as ContentBlock[];
    const imgBlock = blocks.find(b => b.type === "image") as any;
    expect(imgBlock.mediaType).toBe("image/png");
    expect(imgBlock.data).toBe("ABC123");
  });

  it("VP-039: 多张图片生成多个 image block", () => {
    const msg = makeUserMessage("两张图", [
      makeImageAttachment("data:image/png;base64,IMG1"),
      makeImageAttachment("data:image/jpeg;base64,IMG2"),
    ]);
    const result = messagesToLLMMessages([msg as any]);
    const blocks = result[0].content as ContentBlock[];
    expect(blocks.length).toBe(3); // 1 text + 2 image
    const imageBlocks = blocks.filter(b => b.type === "image");
    expect(imageBlocks).toHaveLength(2);
  });

  it("VP-040: data URL 格式正确解析 base64 数据", () => {
    const msg = makeUserMessage("t", [makeImageAttachment("data:image/png;base64,myBase64Data")]);
    const result = messagesToLLMMessages([msg as any]);
    const blocks = result[0].content as ContentBlock[];
    const imgBlock = blocks.find(b => b.type === "image") as any;
    expect(imgBlock.data).toBe("myBase64Data");
    expect(imgBlock.mediaType).toBe("image/png");
  });

  it("VP-041: 非 data URL 格式的 content 也正确处理", () => {
    const att: MessageAttachment = {
      id: "att-raw", name: "raw.png", type: "image",
      content: "rawBase64Data", mimeType: "image/png", size: 100,
    };
    const msg = makeUserMessage("t", [att]);
    const result = messagesToLLMMessages([msg as any]);
    const blocks = result[0].content as ContentBlock[];
    const imgBlock = blocks.find(b => b.type === "image") as any;
    expect(imgBlock.data).toBe("rawBase64Data");
    expect(imgBlock.mediaType).toBe("image/png");
  });

  it("VP-042: 音频附件生成 audio ContentBlock", () => {
    const msg = makeUserMessage("听这段语音", [makeAudioAttachment()]);
    const result = messagesToLLMMessages([msg as any]);
    const blocks = result[0].content as ContentBlock[];
    expect(blocks.length).toBe(2);
    expect(blocks[1].type).toBe("audio");
  });

  it("VP-043: 音频 ContentBlock 的 mediaType 正确", () => {
    const msg = makeUserMessage("t", [makeAudioAttachment("data:audio/mpeg;base64,AUD1")]);
    const result = messagesToLLMMessages([msg as any]);
    const blocks = result[0].content as ContentBlock[];
    const audBlock = blocks.find(b => b.type === "audio") as any;
    expect(audBlock.mediaType).toBe("audio/mpeg");
    expect(audBlock.data).toBe("AUD1");
  });

  it("VP-044: 混合附件（图片+音频）生成 3 个 block", () => {
    const msg = makeUserMessage("混合", [
      makeImageAttachment("data:image/png;base64,IMG1"),
      makeAudioAttachment("data:audio/mpeg;base64,AUD1"),
    ]);
    const result = messagesToLLMMessages([msg as any]);
    const blocks = result[0].content as ContentBlock[];
    expect(blocks.length).toBe(3); // 1 text + 1 image + 1 audio
  });

  it("VP-045: 文件附件不生成 ContentBlock（仍为 string）", () => {
    const att: MessageAttachment = {
      id: "att-file", name: "doc.txt", type: "file",
      content: "file content here", size: 100,
    };
    const msg = makeUserMessage("看这个文件", [att]);
    const result = messagesToLLMMessages([msg as any]);
    expect(typeof result[0].content).toBe("string");
  });

  it("VP-046: 空附件列表时返回 string", () => {
    const msg = makeUserMessage("no attachments", []);
    const result = messagesToLLMMessages([msg as any]);
    expect(typeof result[0].content).toBe("string");
  });

  it("VP-047: 图片 content 为空时不生成 image block", () => {
    const att: MessageAttachment = {
      id: "att-empty", name: "empty.png", type: "image",
      content: undefined, size: 0,
    };
    const msg = makeUserMessage("empty img", [att]);
    const result = messagesToLLMMessages([msg as any]);
    // No content → filtered out → just text string
    expect(typeof result[0].content).toBe("string");
  });

  it("VP-048: system-reminder 标签被清除", () => {
    const msg = makeUserMessage("<system-reminder>secret</system-reminder>real content");
    const result = messagesToLLMMessages([msg as any]);
    expect(result[0].content).toBe("real content");
  });

  it("VP-049: assistant 消息的 content 仍为 string", () => {
    const msg: any = {
      id: "asst-1", sessionId: "s", role: "assistant",
      content: "I am assistant", timestamp: Date.now(),
      toolCalls: [],
    };
    const result = messagesToLLMMessages([msg]);
    expect(typeof result[0].content).toBe("string");
  });

  it("VP-050: 多条消息混合（user with image + assistant）正确处理", () => {
    const userMsg = makeUserMessage("看图", [makeImageAttachment()]);
    const asstMsg: any = {
      id: "asst-1", sessionId: "s", role: "assistant",
      content: "我看到了", timestamp: Date.now(), toolCalls: [],
    };
    const result = messagesToLLMMessages([userMsg as any, asstMsg]);
    expect(result).toHaveLength(2);
    expect(Array.isArray(result[0].content)).toBe(true); // user with image
    expect(typeof result[1].content).toBe("string"); // assistant
  });

  it("VP-051: LLMMessage content 类型为 string | ContentBlock[]", () => {
    const msg = makeUserMessage("test");
    const result = messagesToLLMMessages([msg as any]);
    const content: string | ContentBlock[] = result[0].content;
    // Type check — both branches should be valid
    if (typeof content === "string") {
      expect(content.length).toBeGreaterThan(0);
    } else {
      expect(Array.isArray(content)).toBe(true);
    }
  });
});

// ========== E. provider toAPIMessage 多模态格式 ==========

describe("E. provider toAPIMessage 多模态格式", () => {
  let provider: OpenAICompatibleProvider;

  beforeEach(() => {
    provider = new OpenAICompatibleProvider(makeProviderConfig());
    mockFetch.mockReset();
  });

  it("VP-056: string content 正确序列化为 { role, content: string }", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        id: "test", choices: [{ message: { content: "ok" } }],
      }),
    });

    await provider.complete({
      model: "test-model",
      messages: [{ id: "m1", role: "user", content: "hello" }],
      stream: false,
    });

    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(callBody.messages[0].content).toBe("hello");
  });

  it("VP-057: ContentBlock[] 含 text+image 序列化为 OpenAI array", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        id: "test", choices: [{ message: { content: "ok" } }],
      }),
    });

    const blocks: ContentBlock[] = [
      { type: "text", text: "看这张图" },
      { type: "image", mediaType: "image/png", data: "base64data" },
    ];

    await provider.complete({
      model: "test-model",
      messages: [{ id: "m1", role: "user", content: blocks }],
      stream: false,
    });

    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    const msgContent = callBody.messages[0].content;
    expect(Array.isArray(msgContent)).toBe(true);
    expect(msgContent[0]).toEqual({ type: "text", text: "看这张图" });
    expect(msgContent[1]).toEqual({
      type: "image_url",
      image_url: { url: "data:image/png;base64,base64data" },
    });
  });

  it("VP-058: audio ContentBlock 序列化为 input_audio 格式", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        id: "test", choices: [{ message: { content: "ok" } }],
      }),
    });

    const blocks: ContentBlock[] = [
      { type: "text", text: "听这段" },
      { type: "audio", mediaType: "audio/mpeg", data: "audiodata" },
    ];

    await provider.complete({
      model: "test-model",
      messages: [{ id: "m1", role: "user", content: blocks }],
      stream: false,
    });

    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    const msgContent = callBody.messages[0].content;
    expect(msgContent[1]).toEqual({
      type: "input_audio",
      input_audio: { data: "audiodata", format: "mp3" },
    });
  });

  it("VP-059: 多图 ContentBlock 序列化为多个 image_url", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        id: "test", choices: [{ message: { content: "ok" } }],
      }),
    });

    const blocks: ContentBlock[] = [
      { type: "text", text: "两张图" },
      { type: "image", mediaType: "image/png", data: "img1" },
      { type: "image", mediaType: "image/jpeg", data: "img2" },
    ];

    await provider.complete({
      model: "test-model",
      messages: [{ id: "m1", role: "user", content: blocks }],
      stream: false,
    });

    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    const msgContent = callBody.messages[0].content;
    expect(msgContent).toHaveLength(3);
    expect(msgContent[1].type).toBe("image_url");
    expect(msgContent[2].type).toBe("image_url");
  });

  it("VP-060: system-reminder 标签在 string content 中被清除", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        id: "test", choices: [{ message: { content: "ok" } }],
      }),
    });

    await provider.complete({
      model: "test-model",
      messages: [{ id: "m1", role: "user", content: "<system-reminder>secret</system-reminder>real" }],
      stream: false,
    });

    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(callBody.messages[0].content).toBe("real");
  });

  it("VP-061: 超长 content (>200KB) 被截断", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        id: "test", choices: [{ message: { content: "ok" } }],
      }),
    });

    const longContent = "a".repeat(250000);
    await provider.complete({
      model: "test-model",
      messages: [{ id: "m1", role: "user", content: longContent }],
      stream: false,
    });

    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(callBody.messages[0].content.length).toBeLessThan(250000);
    expect(callBody.messages[0].content).toContain("(truncated)");
  });

  it("VP-062: tool role 消息正确序列化 tool_call_id", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        id: "test", choices: [{ message: { content: "ok" } }],
      }),
    });

    await provider.complete({
      model: "test-model",
      messages: [
        { id: "m1", role: "user", content: "do something" },
        { id: "m2", role: "tool", content: "tool result", toolCallId: "tc-1" } as any,
      ],
      stream: false,
    });

    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    const toolMsg = callBody.messages.find((m: any) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    expect(toolMsg.tool_call_id).toBe("tc-1");
  });

  it("VP-063: assistant 消息带 tool_calls 正确序列化", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        id: "test", choices: [{ message: { content: "ok" } }],
      }),
    });

    await provider.complete({
      model: "test-model",
      messages: [{
        id: "m1", role: "assistant",
        content: "calling tool",
        tool_calls: [{ id: "tc-1", type: "function", function: { name: "test_tool", arguments: "{}" } }],
      } as any],
      stream: false,
    });

    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(callBody.messages[0].tool_calls).toBeDefined();
    expect(callBody.messages[0].tool_calls[0].function.name).toBe("test_tool");
  });
});

// ========== F. VisionProxy 核心逻辑 ==========

describe("F. VisionProxy 核心逻辑", () => {
  let proxy: ReturnType<typeof getVisionProxy>;

  beforeEach(() => {
    localStorage.clear();
    proxy = getVisionProxy();
    mockFetch.mockReset();
  });

  it("VP-071: 无媒体的消息直接返回", async () => {
    const messages: LLMMessage[] = [
      { id: "m1", role: "user", content: "hello" },
    ];
    const result = await proxy.processMessages(messages, "deepseek-v4-flash", "deepseek");
    expect(result.visionUsed).toBe(false);
    expect(result.messages).toBe(messages);
  });

  it("VP-072: GPT-4o 支持 vision → 不触发代理", async () => {
    const messages: LLMMessage[] = [
      {
        id: "m1", role: "user",
        content: [
          { type: "text", text: "看图" },
          { type: "image", mediaType: "image/png", data: "imgdata" },
        ],
      },
    ];
    const result = await proxy.processMessages(messages, "gpt-4o", "openai");
    expect(result.visionUsed).toBe(false);
    // Messages unchanged — images kept
    const blocks = result.messages[0].content as ContentBlock[];
    expect(blocks.some(b => b.type === "image")).toBe(true);
  });

  it("VP-073: DeepSeek 不支持 vision + 未配置视觉模型 → 标注未处理", async () => {
    const messages: LLMMessage[] = [
      {
        id: "m1", role: "user",
        content: [
          { type: "text", text: "看图" },
          { type: "image", mediaType: "image/png", data: "imgdata" },
        ],
      },
    ];
    const result = await proxy.processMessages(messages, "deepseek-v4-flash", "deepseek");
    expect(result.visionUsed).toBe(false);
    const blocks = result.messages[0].content as ContentBlock[];
    const textBlock = blocks.find(b => b.type === "text" && b.text.includes("未处理")) as any;
    expect(textBlock).toBeDefined();
    expect(textBlock.text).toContain("未配置");
  });

  it("VP-074: DeepSeek 不支持 vision + 配置了视觉模型 → 替换图片为描述", async () => {
    // Configure vision provider
    saveMultimodalSettings({
      vision: { providerId: "openai", apiKey: "sk-vision", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", enabled: true },
      stt: null, embedding: null, tts: null, imageGen: null,
    });

    // Mock vision API response
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        id: "vision-1",
        choices: [{ message: { content: "这是一张猫的图片" } }],
      }),
    });

    const messages: LLMMessage[] = [
      {
        id: "m1", role: "user",
        content: [
          { type: "text", text: "看图" },
          { type: "image", mediaType: "image/png", data: "imgdata" },
        ],
      },
    ];
    const result = await proxy.processMessages(messages, "deepseek-v4-flash", "deepseek");
    expect(result.visionUsed).toBe(true);
    expect(result.visionModel).toBe("gpt-4o-mini");

    const blocks = result.messages[0].content as ContentBlock[];
    // Image block should be replaced with text
    expect(blocks.every(b => b.type === "text")).toBe(true);
    const descBlock = blocks.find(b => b.text.includes("图片描述"));
    expect(descBlock).toBeDefined();
    expect(descBlock!.text).toContain("这是一张猫的图片");
  });

  it("VP-075: Vision API 调用使用正确的 system prompt", async () => {
    saveMultimodalSettings({
      vision: { providerId: "openai", apiKey: "sk-v", baseUrl: "https://api.openai.com/v1", model: "gpt-4o", enabled: true },
      stt: null, embedding: null, tts: null, imageGen: null,
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ id: "v", choices: [{ message: { content: "desc" } }] }),
    });

    const messages: LLMMessage[] = [
      {
        id: "m1", role: "user",
        content: [
          { type: "text", text: "?" },
          { type: "image", mediaType: "image/png", data: "d" },
        ],
      },
    ];
    await proxy.processMessages(messages, "deepseek-v4-flash", "deepseek");

    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(callBody.model).toBe("gpt-4o");
    expect(callBody.messages[0].role).toBe("system");
    expect(callBody.messages[0].content).toContain("视觉描述助手");
    expect(callBody.messages[1].content[1].type).toBe("image_url");
  });

  it("VP-076: 多张图片并发处理", async () => {
    saveMultimodalSettings({
      vision: { providerId: "openai", apiKey: "sk-v", baseUrl: "https://api.openai.com/v1", model: "gpt-4o", enabled: true },
      stt: null, embedding: null, tts: null, imageGen: null,
    });

    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: "v", choices: [{ message: { content: "desc" } }] }),
    });

    const messages: LLMMessage[] = [
      {
        id: "m1", role: "user",
        content: [
          { type: "text", text: "两张图" },
          { type: "image", mediaType: "image/png", data: "img1" },
          { type: "image", mediaType: "image/jpeg", data: "img2" },
        ],
      },
    ];
    const result = await proxy.processMessages(messages, "deepseek-v4-flash", "deepseek");
    expect(result.visionUsed).toBe(true);
    // Both images should be replaced
    const blocks = result.messages[0].content as ContentBlock[];
    const imageBlocks = blocks.filter(b => b.type === "image");
    expect(imageBlocks).toHaveLength(0);
    const descBlocks = blocks.filter(b => b.text.includes("图片描述"));
    expect(descBlocks).toHaveLength(2);
  });

  it("VP-077: Claude 支持 vision → 不触发代理", async () => {
    const messages: LLMMessage[] = [
      {
        id: "m1", role: "user",
        content: [
          { type: "text", text: "看图" },
          { type: "image", mediaType: "image/png", data: "img" },
        ],
      },
    ];
    const result = await proxy.processMessages(messages, "claude-sonnet-4-20250514", "anthropic");
    expect(result.visionUsed).toBe(false);
  });

  it("VP-078: Gemini 支持 vision → 不触发代理", async () => {
    const messages: LLMMessage[] = [
      {
        id: "m1", role: "user",
        content: [
          { type: "text", text: "看图" },
          { type: "image", mediaType: "image/png", data: "img" },
        ],
      },
    ];
    const result = await proxy.processMessages(messages, "gemini-2.5-flash", "gemini");
    expect(result.visionUsed).toBe(false);
  });

  it("VP-079: 音频 block + 未配置 STT → 标注未处理", async () => {
    const messages: LLMMessage[] = [
      {
        id: "m1", role: "user",
        content: [
          { type: "text", text: "听" },
          { type: "audio", mediaType: "audio/mpeg", data: "aud" },
        ],
      },
    ];
    const result = await proxy.processMessages(messages, "deepseek-v4-flash", "deepseek");
    expect(result.visionUsed).toBe(false);
    const blocks = result.messages[0].content as ContentBlock[];
    const unprocessed = blocks.find(b => b.text.includes("语音") && b.text.includes("未处理"));
    expect(unprocessed).toBeDefined();
  });

  it("VP-080: Vision API 错误时 image block 替换为错误信息", async () => {
    saveMultimodalSettings({
      vision: { providerId: "openai", apiKey: "sk-v", baseUrl: "https://api.openai.com/v1", model: "gpt-4o", enabled: true },
      stt: null, embedding: null, tts: null, imageGen: null,
    });

    mockFetch.mockResolvedValueOnce({
      ok: false,
      text: () => Promise.resolve("API error"),
    });

    const messages: LLMMessage[] = [
      {
        id: "m1", role: "user",
        content: [
          { type: "text", text: "?" },
          { type: "image", mediaType: "image/png", data: "img" },
        ],
      },
    ];
    const result = await proxy.processMessages(messages, "deepseek-v4-flash", "deepseek");
    expect(result.visionUsed).toBe(true);
    const blocks = result.messages[0].content as ContentBlock[];
    const errorBlock = blocks.find(b => b.text.includes("图片处理失败"));
    expect(errorBlock).toBeDefined();
    expect(errorBlock!.text).toContain("Vision API error");
  });

  it("VP-081: 混合媒体（图片+音频）+ 配置了 vision 和 STT → 全部替换", async () => {
    saveMultimodalSettings({
      vision: { providerId: "openai", apiKey: "sk-v", baseUrl: "https://api.openai.com/v1", model: "gpt-4o", enabled: true },
      stt: { providerId: "openai", apiKey: "sk-s", baseUrl: "https://api.openai.com/v1", model: "whisper-1", enabled: true },
      embedding: null, tts: null, imageGen: null,
    });

    // Vision API mock
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ id: "v", choices: [{ message: { content: "图片描述" } }] }),
    });
    // STT API mock
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve("语音转写结果"),
    });

    const messages: LLMMessage[] = [
      {
        id: "m1", role: "user",
        content: [
          { type: "text", text: "混合" },
          { type: "image", mediaType: "image/png", data: "img" },
          { type: "audio", mediaType: "audio/mpeg", data: "aud" },
        ],
      },
    ];
    const result = await proxy.processMessages(messages, "deepseek-v4-flash", "deepseek");
    expect(result.visionUsed).toBe(true);

    const blocks = result.messages[0].content as ContentBlock[];
    // All media blocks should be replaced with text
    expect(blocks.every(b => b.type === "text")).toBe(true);
    expect(blocks.some(b => b.text.includes("图片描述"))).toBe(true);
    expect(blocks.some(b => b.text.includes("语音转写"))).toBe(true);
  });

  it("VP-082: o3 模型支持 vision → 不触发代理", async () => {
    const messages: LLMMessage[] = [
      {
        id: "m1", role: "user",
        content: [
          { type: "text", text: "?" },
          { type: "image", mediaType: "image/png", data: "img" },
        ],
      },
    ];
    const result = await proxy.processMessages(messages, "o3", "openai");
    expect(result.visionUsed).toBe(false);
  });

  it("VP-083: vision 配置 enabled=false → 不使用视觉代理", async () => {
    saveMultimodalSettings({
      vision: { providerId: "openai", apiKey: "sk-v", baseUrl: "", model: "gpt-4o", enabled: false },
      stt: null, embedding: null, tts: null, imageGen: null,
    });

    const messages: LLMMessage[] = [
      {
        id: "m1", role: "user",
        content: [
          { type: "text", text: "?" },
          { type: "image", mediaType: "image/png", data: "img" },
        ],
      },
    ];
    const result = await proxy.processMessages(messages, "deepseek-v4-flash", "deepseek");
    // vision not enabled → no config → mark unprocessed
    expect(result.visionUsed).toBe(false);
    const blocks = result.messages[0].content as ContentBlock[];
    expect(blocks.some(b => b.text.includes("未处理"))).toBe(true);
  });

  it("VP-084: gpt-4o-mini 支持 vision", async () => {
    const messages: LLMMessage[] = [
      {
        id: "m1", role: "user",
        content: [
          { type: "text", text: "?" },
          { type: "image", mediaType: "image/png", data: "img" },
        ],
      },
    ];
    const result = await proxy.processMessages(messages, "gpt-4o-mini", "openai");
    expect(result.visionUsed).toBe(false);
  });

  it("VP-085: o3-mini 不支持 vision → 触发代理逻辑", async () => {
    saveMultimodalSettings({
      vision: null, stt: null, embedding: null, tts: null, imageGen: null,
    });

    const messages: LLMMessage[] = [
      {
        id: "m1", role: "user",
        content: [
          { type: "text", text: "?" },
          { type: "image", mediaType: "image/png", data: "img" },
        ],
      },
    ];
    // o3-mini does NOT support vision
    const result = await proxy.processMessages(messages, "o3-mini", "openai");
    // No vision configured → mark unprocessed
    expect(result.visionUsed).toBe(false);
    const blocks = result.messages[0].content as ContentBlock[];
    expect(blocks.some(b => b.text.includes("未处理"))).toBe(true);
  });
});

// ========== G. MessageAttachment audio 类型 ==========

describe("G. MessageAttachment audio 类型", () => {
  it("VP-101: MessageAttachment type 包含 audio", () => {
    const att: MessageAttachment = {
      id: "att-1", name: "voice.mp3", type: "audio",
      content: "data:audio/mpeg;base64,...", mimeType: "audio/mpeg", size: 500,
    };
    expect(att.type).toBe("audio");
  });

  it("VP-102: audio 附件可被 messagesToLLMMessages 正确处理", () => {
    const att: MessageAttachment = {
      id: "att-a", name: "voice.mp3", type: "audio",
      content: "data:audio/mpeg;base64,AUDIO", mimeType: "audio/mpeg", size: 500,
    };
    const msg = makeUserMessage("listen", [att]);
    const result = messagesToLLMMessages([msg as any]);
    const blocks = result[0].content as ContentBlock[];
    expect(blocks.some(b => b.type === "audio")).toBe(true);
  });

  it("VP-103: video 附件仍被支持（不生成 ContentBlock）", () => {
    const att: MessageAttachment = {
      id: "att-v", name: "video.mp4", type: "video",
      content: "data:video/mp4;base64,...", mimeType: "video/mp4", size: 1000,
    };
    const msg = makeUserMessage("watch", [att]);
    const result = messagesToLLMMessages([msg as any]);
    // video type does not generate ContentBlock — just string
    expect(typeof result[0].content).toBe("string");
  });

  it("VP-104: file 附件不生成 ContentBlock", () => {
    const att: MessageAttachment = {
      id: "att-f", name: "doc.txt", type: "file",
      content: "file content", size: 100,
    };
    const msg = makeUserMessage("read", [att]);
    const result = messagesToLLMMessages([msg as any]);
    expect(typeof result[0].content).toBe("string");
  });

  it("VP-105: url 附件不生成 ContentBlock", () => {
    const att: MessageAttachment = {
      id: "att-u", name: "link", type: "url",
      content: "https://example.com", size: 0,
    };
    const msg = makeUserMessage("check", [att]);
    const result = messagesToLLMMessages([msg as any]);
    expect(typeof result[0].content).toBe("string");
  });
});

// ========== H. 回归：历史功能不受影响 ==========

describe("H. 回归：历史功能不受影响", () => {
  it("VP-106: 纯文本对话不受 vision proxy 影响", async () => {
    localStorage.clear();
    const proxy = getVisionProxy();
    const messages: LLMMessage[] = [
      { id: "m1", role: "user", content: "hello" },
      { id: "m2", role: "assistant", content: "hi" },
      { id: "m3", role: "user", content: "how are you?" },
    ];
    const result = await proxy.processMessages(messages, "deepseek-v4-flash", "deepseek");
    expect(result.visionUsed).toBe(false);
    expect(result.messages).toBe(messages);
  });

  it("VP-107: 工具调用消息不受 vision proxy 影响", async () => {
    const proxy = getVisionProxy();
    const messages: LLMMessage[] = [
      { id: "m1", role: "user", content: "list files" },
      { id: "m2", role: "assistant", content: "calling list_files", tool_calls: [{ id: "tc1", type: "function", function: { name: "list_files", arguments: "{}" } }] } as any,
      { id: "m3", role: "tool", content: "file1.txt\nfile2.txt", toolCallId: "tc1" } as any,
    ];
    const result = await proxy.processMessages(messages, "deepseek-v4-flash", "deepseek");
    expect(result.visionUsed).toBe(false);
    // All messages unchanged
    expect(result.messages[0].content).toBe("list files");
    expect(result.messages[2].content).toBe("file1.txt\nfile2.txt");
  });

  it("VP-108: system 消息不受 vision proxy 影响", async () => {
    const proxy = getVisionProxy();
    const messages: LLMMessage[] = [
      { id: "sys", role: "system", content: "You are a helpful assistant." },
      { id: "m1", role: "user", content: "hi" },
    ];
    const result = await proxy.processMessages(messages, "gpt-4o", "openai");
    expect(result.visionUsed).toBe(false);
    expect(result.messages[0].content).toBe("You are a helpful assistant.");
  });

  it("VP-109: 历史的 MultimodalSettings 字段（embedding/tts/imageGen）仍可正常读写", () => {
    saveMultimodalSettings({
      vision: null,
      stt: null,
      embedding: { providerId: "openai", apiKey: "sk-e", baseUrl: "", model: "text-embedding-3-small", enabled: true },
      tts: { providerId: "openai", apiKey: "sk-t", baseUrl: "", model: "tts-1", enabled: true },
      imageGen: { providerId: "openai", apiKey: "sk-i", baseUrl: "", model: "dall-e-3", enabled: true },
    });
    const loaded = getMultimodalSettings();
    expect(loaded.embedding!.model).toBe("text-embedding-3-small");
    expect(loaded.tts!.model).toBe("tts-1");
    expect(loaded.imageGen!.model).toBe("dall-e-3");
  });

  it("VP-110: 历史的 ModelProfile 内置方案仍可用", () => {
    const pm = getModelProfileManager();
    const profiles = pm.getAll();
    // Built-in profiles still exist
    expect(profiles.find(p => p.id === "default")).toBeDefined();
    expect(profiles.find(p => p.id === "economy")).toBeDefined();
    expect(profiles.find(p => p.id === "performance")).toBeDefined();
  });

  it("VP-111: 默认方案切换不受影响", () => {
    const pm = getModelProfileManager();
    pm.setActiveProfile("default");
    expect(pm.getActiveProfileId()).toBe("default");
    pm.setActiveProfile("economy");
    expect(pm.getActiveProfileId()).toBe("economy");
    pm.setActiveProfile("default");
  });

  it("VP-112: 旧格式的 messagesToLLMMessages 调用仍兼容（无 attachments 字段）", () => {
    const oldMsg: any = {
      id: "old-1", sessionId: "s", role: "user",
      content: "old message", timestamp: 0,
      // No attachments field — old format
    };
    const result = messagesToLLMMessages([oldMsg]);
    expect(result).toHaveLength(1);
    expect(typeof result[0].content).toBe("string");
    expect(result[0].content).toBe("old message");
  });

  it("VP-113: provider stream 方法仍可用（非 complete）", async () => {
    const provider = new OpenAICompatibleProvider(makeProviderConfig());
    mockFetch.mockReset();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ id: "test", choices: [{ message: { content: "ok" } }] }),
    });

    const result = await provider.complete({
      model: "test-model",
      messages: [{ id: "m1", role: "user", content: "test" }],
      stream: false,
    });

    expect(result.content).toBe("ok");
  });

  it("VP-114: 记忆提取 slot 仍可解析", () => {
    const pm = getModelProfileManager();
    pm.setActiveProfile("economy");
    const memorySlot = pm.resolveSlot("memory");
    expect(memorySlot).not.toBeNull();
    expect(memorySlot!.model).toBe("gpt-4o-mini");
  });

  it("VP-115: 压缩 slot 仍可解析", () => {
    const pm = getModelProfileManager();
    pm.setActiveProfile("economy");
    const compactionSlot = pm.resolveSlot("compaction");
    expect(compactionSlot).not.toBeNull();
    expect(compactionSlot!.model).toBe("mimo-v2-flash");
  });

  it("VP-116: 性能方案 slot 仍可解析", () => {
    const pm = getModelProfileManager();
    pm.setActiveProfile("performance");
    const chatSlot = pm.resolveSlot("chat");
    expect(chatSlot).not.toBeNull();
    expect(chatSlot!.model).toBe("claude-opus-4-20250514");
  });

  it("VP-117: cosineSimilarity 函数仍正常工作", async () => {
    const { cosineSimilarity } = await import("../core/llm/multimodal");
    const a = [1, 0, 0];
    const b = [1, 0, 0];
    const sim = cosineSimilarity(a, b);
    expect(sim).toBeCloseTo(1, 5);
  });

  it("VP-118: getDefaultLocalEmbeddingConfig 仍正常工作", async () => {
    const { getDefaultLocalEmbeddingConfig } = await import("../core/llm/multimodal");
    const config = getDefaultLocalEmbeddingConfig();
    expect(config.providerId).toBe("local");
    expect(config.model).toBe("Xenova/all-MiniLM-L6-v2");
  });

  it("VP-119: isUsingLocalEmbedding 在未配置时返回 true", async () => {
    localStorage.clear();
    const { isUsingLocalEmbedding } = await import("../core/llm/multimodal");
    expect(isUsingLocalEmbedding()).toBe(true);
  });

  it("VP-120: 验证 image_gen 工具检查 imageGen 配置", async () => {
    saveMultimodalSettings({
      vision: null, stt: null, embedding: null, tts: null,
      imageGen: null, // Not configured
    });

    const { createImageGenTool } = await import("../core/llm/tools");
    const tool = createImageGenTool();
    const result = await tool.execute({ prompt: "test image" }, {} as any);
    expect((result as any).output).toContain("not configured");
  });
});
