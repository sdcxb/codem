/**
 * 测试：多模态模块 — Embedding / TTS / ImageGen
 *
 * 改动影响：
 *   - multimodal.ts 新增 generateEmbeddings/semanticSearch/cosineSimilarity
 *   - multimodal.ts 新增 textToSpeech/playTTSAudio
 *   - multimodal.ts 新增 generateImages
 *   - multimodal.ts 新增 getMultimodalSettings/saveMultimodalSettings
 *   - multimodal.ts 新增 MULTIMODAL_MODELS 常量
 *
 * 测试范围：
 *   1. cosineSimilarity 数学正确性
 *   2. 多模态设置读写持久化
 *   3. 未配置时的错误处理
 *   4. generateEmbeddings API 调用（mock fetch）
 *   5. semanticSearch 排序逻辑
 *   6. textToSpeech API 调用（mock fetch）
 *   7. generateImages API 调用（mock fetch）
 *   8. playTTSAudio 音频播放
 *   9. MULTIMODAL_MODELS 模型列表完整性
 *   10. API 错误处理
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  cosineSimilarity,
  getMultimodalSettings,
  saveMultimodalSettings,
  generateEmbeddings,
  semanticSearch,
  textToSpeech,
  generateImages,
  playTTSAudio,
  MULTIMODAL_MODELS,
  type MultimodalSettings,
} from "../core/llm/multimodal";
import { getSettingJSON, setSettingJSON } from "../core/storage/settings";

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Mock Audio constructor — must be a class-like function for `new Audio()`
const mockAudioPlay = vi.fn();
const mockAudioInstances: any[] = [];
class MockAudio {
  src: string;
  play: ReturnType<typeof vi.fn>;
  constructor(url: string) {
    this.src = url;
    this.play = mockAudioPlay;
    mockAudioInstances.push(this);
  }
}
vi.stubGlobal("Audio", MockAudio);

describe("多模态模块", () => {
  beforeEach(() => {
    localStorage.clear();
    mockFetch.mockReset();
    mockAudioPlay.mockReset();
    mockAudioInstances.length = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ===== 1. cosineSimilarity 数学正确性 =====
  describe("cosineSimilarity 余弦相似度", () => {
    it("相同向量相似度为 1", () => {
      const v = [1, 2, 3];
      expect(cosineSimilarity(v, v)).toBeCloseTo(1, 5);
    });

    it("正交向量相似度为 0", () => {
      expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 5);
    });

    it("相反向量相似度为 -1", () => {
      expect(cosineSimilarity([1, 2, 3], [-1, -2, -3])).toBeCloseTo(-1, 5);
    });

    it("不同长度向量返回 0", () => {
      expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
    });

    it("零向量返回 0（避免除以零）", () => {
      expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
    });

    it("两个零向量返回 0", () => {
      expect(cosineSimilarity([0, 0], [0, 0])).toBe(0);
    });

    it("空向量返回 0", () => {
      expect(cosineSimilarity([], [])).toBe(0);
    });

    it("单元素向量", () => {
      expect(cosineSimilarity([5], [5])).toBeCloseTo(1, 5);
      expect(cosineSimilarity([5], [-5])).toBeCloseTo(-1, 5);
    });

    it("高维向量", () => {
      const a = [1, 0, 0, 0, 0, 0, 0, 0];
      const b = [0, 1, 0, 0, 0, 0, 0, 0];
      expect(cosineSimilarity(a, b)).toBeCloseTo(0, 5);
    });

    it("浮点数向量", () => {
      const a = [0.1, 0.2, 0.3];
      const b = [0.3, 0.2, 0.1];
      // 点积 = 0.03+0.04+0.03 = 0.10
      // |a| = sqrt(0.01+0.04+0.09) = sqrt(0.14) ≈ 0.374
      // |b| = sqrt(0.09+0.04+0.01) = sqrt(0.14) ≈ 0.374
      // cos = 0.10 / (0.374*0.374) ≈ 0.714
      expect(cosineSimilarity(a, b)).toBeCloseTo(0.714, 2);
    });
  });

  // ===== 2. 多模态设置读写持久化 =====
  describe("多模态设置读写", () => {
    it("默认设置为全 null", () => {
      const settings = getMultimodalSettings();
      expect(settings.embedding).toBeNull();
      expect(settings.tts).toBeNull();
      expect(settings.imageGen).toBeNull();
    });

    it("保存后读取正确", () => {
      const settings: MultimodalSettings = {
        embedding: {
          providerId: "openai",
          apiKey: "sk-test",
          baseUrl: "https://api.openai.com/v1",
          model: "text-embedding-3-small",
          enabled: true,
        },
        tts: null,
        imageGen: null,
      };
      saveMultimodalSettings(settings);
      const loaded = getMultimodalSettings();
      expect(loaded.embedding).not.toBeNull();
      expect(loaded.embedding!.providerId).toBe("openai");
      expect(loaded.embedding!.apiKey).toBe("sk-test");
      expect(loaded.embedding!.model).toBe("text-embedding-3-small");
      expect(loaded.embedding!.enabled).toBe(true);
      expect(loaded.tts).toBeNull();
      expect(loaded.imageGen).toBeNull();
    });

    it("保存全部三种模态配置", () => {
      const settings: MultimodalSettings = {
        embedding: { providerId: "openai", apiKey: "sk-emb", baseUrl: "https://api.openai.com/v1", model: "text-embedding-3-small", enabled: true },
        tts: { providerId: "openai", apiKey: "sk-tts", baseUrl: "https://api.openai.com/v1", model: "tts-1", enabled: true },
        imageGen: { providerId: "openai", apiKey: "sk-img", baseUrl: "https://api.openai.com/v1", model: "dall-e-3", enabled: true },
      };
      saveMultimodalSettings(settings);
      const loaded = getMultimodalSettings();
      expect(loaded.embedding!.model).toBe("text-embedding-3-small");
      expect(loaded.tts!.model).toBe("tts-1");
      expect(loaded.imageGen!.model).toBe("dall-e-3");
    });

    it("覆盖旧设置", () => {
      saveMultimodalSettings({
        embedding: { providerId: "openai", apiKey: "old", baseUrl: "", model: "v1", enabled: true },
        tts: null,
        imageGen: null,
      });
      saveMultimodalSettings({
        embedding: { providerId: "mimo", apiKey: "new", baseUrl: "", model: "v2", enabled: false },
        tts: null,
        imageGen: null,
      });
      const loaded = getMultimodalSettings();
      expect(loaded.embedding!.providerId).toBe("mimo");
      expect(loaded.embedding!.apiKey).toBe("new");
      expect(loaded.embedding!.enabled).toBe(false);
    });

    it("通过 localStorage 直接修改后 getMultimodalSettings 读取", () => {
      setSettingJSON("codem-multimodal-settings", {
        embedding: { providerId: "gemini", apiKey: "key", baseUrl: "", model: "text-embedding-004", enabled: true },
        tts: null,
        imageGen: null,
      });
      const loaded = getMultimodalSettings();
      expect(loaded.embedding!.providerId).toBe("gemini");
    });
  });

  // ===== 3. 未配置时的错误处理 =====
  describe("未配置时的错误处理", () => {
    it("generateEmbeddings 未配置时抛出错误", async () => {
      await expect(generateEmbeddings({ texts: ["hello"] })).rejects.toThrow("Embedding provider not configured");
    });

    it("generateEmbeddings 配置但未启用时抛出错误", async () => {
      saveMultimodalSettings({
        embedding: { providerId: "openai", apiKey: "sk-test", baseUrl: "", model: "v1", enabled: false },
        tts: null,
        imageGen: null,
      });
      await expect(generateEmbeddings({ texts: ["hello"] })).rejects.toThrow("Embedding provider not configured");
    });

    it("generateEmbeddings 配置但无 API Key 时抛出错误", async () => {
      saveMultimodalSettings({
        embedding: { providerId: "openai", apiKey: "", baseUrl: "", model: "v1", enabled: true },
        tts: null,
        imageGen: null,
      });
      await expect(generateEmbeddings({ texts: ["hello"] })).rejects.toThrow("Embedding provider not configured");
    });

    it("textToSpeech 未配置时抛出错误", async () => {
      await expect(textToSpeech({ text: "hello" })).rejects.toThrow("TTS provider not configured");
    });

    it("generateImages 未配置时抛出错误", async () => {
      await expect(generateImages({ prompt: "a cat" })).rejects.toThrow("Image generation provider not configured");
    });
  });

  // ===== 4. generateEmbeddings API 调用 =====
  describe("generateEmbeddings API 调用", () => {
    beforeEach(() => {
      saveMultimodalSettings({
        embedding: { providerId: "openai", apiKey: "sk-test", baseUrl: "https://api.openai.com/v1", model: "text-embedding-3-small", enabled: true },
        tts: null,
        imageGen: null,
      });
    });

    it("正确调用 API 并返回 embedding", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [
            { embedding: [0.1, 0.2, 0.3] },
            { embedding: [0.4, 0.5, 0.6] },
          ],
        }),
      });

      const result = await generateEmbeddings({ texts: ["hello", "world"] });
      expect(result).toHaveLength(2);
      expect(result[0].text).toBe("hello");
      expect(result[0].embedding).toEqual([0.1, 0.2, 0.3]);
      expect(result[1].text).toBe("world");
      expect(result[1].embedding).toEqual([0.4, 0.5, 0.6]);

      // 验证 fetch 调用参数
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.openai.com/v1/embeddings",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            Authorization: "Bearer sk-test",
          }),
        }),
      );
    });

    it("使用参数中的 model 覆盖配置中的 model", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [{ embedding: [0.1] }] }),
      });

      await generateEmbeddings({ texts: ["test"], model: "custom-model" });

      const callArgs = mockFetch.mock.calls[0][1];
      const body = JSON.parse(callArgs.body);
      expect(body.model).toBe("custom-model");
    });

    it("API 返回错误时抛出异常", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => "Unauthorized",
      });

      await expect(generateEmbeddings({ texts: ["test"] })).rejects.toThrow("Embedding API error 401");
    });

    it("空文本数组正常调用", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [] }),
      });

      const result = await generateEmbeddings({ texts: [] });
      expect(result).toHaveLength(0);
    });
  });

  // ===== 5. semanticSearch 排序逻辑 =====
  describe("semanticSearch 语义搜索排序", () => {
    beforeEach(() => {
      saveMultimodalSettings({
        embedding: { providerId: "openai", apiKey: "sk-test", baseUrl: "", model: "v1", enabled: true },
        tts: null,
        imageGen: null,
      });
    });

    it("空语料库返回空数组", async () => {
      const result = await semanticSearch("query", []);
      expect(result).toEqual([]);
    });

    it("按相似度降序排列", async () => {
      // 模拟 embedding：query 和第一篇最相似
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [
            { embedding: [1, 0] },     // query
            { embedding: [0.9, 0.1] },  // corpus[0] — 高相似度
            { embedding: [0, 1] },      // corpus[1] — 低相似度
            { embedding: [0.5, 0.5] },  // corpus[2] — 中等相似度
          ],
        }),
      });

      const result = await semanticSearch("query", ["doc1", "doc2", "doc3"], 3);
      expect(result).toHaveLength(3);
      // 第一个应该是 doc1（相似度最高）
      expect(result[0].text).toBe("doc1");
      expect(result[0].score).toBeGreaterThan(result[1].score);
      // 最后一个应该是 doc2（相似度最低）
      expect(result[2].text).toBe("doc2");
    });

    it("topK 限制返回数量", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [
            { embedding: [1, 0] },
            { embedding: [0.9, 0.1] },
            { embedding: [0.8, 0.2] },
            { embedding: [0.7, 0.3] },
            { embedding: [0.6, 0.4] },
          ],
        }),
      });

      const result = await semanticSearch("q", ["a", "b", "c", "d"], 2);
      expect(result).toHaveLength(2);
    });

    it("topK 大于语料库大小返回全部", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [
            { embedding: [1, 0] },
            { embedding: [0.5, 0.5] },
          ],
        }),
      });

      const result = await semanticSearch("q", ["a"], 10);
      expect(result).toHaveLength(1);
    });

    it("返回正确的索引", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [
            { embedding: [1, 0] },
            { embedding: [0, 1] }, // index 0
            { embedding: [1, 0] }, // index 1
          ],
        }),
      });

      const result = await semanticSearch("q", ["low", "high"], 2);
      expect(result[0].index).toBe(1); // "high" 更相似
      expect(result[1].index).toBe(0); // "low" 不相似
    });
  });

  // ===== 6. textToSpeech API 调用 =====
  describe("textToSpeech API 调用", () => {
    beforeEach(() => {
      saveMultimodalSettings({
        embedding: null,
        tts: { providerId: "openai", apiKey: "sk-tts", baseUrl: "https://api.openai.com/v1", model: "tts-1", enabled: true },
        imageGen: null,
      });
    });

    it("正确调用 TTS API 并返回 base64 音频", async () => {
      const audioData = new Uint8Array([0xFF, 0xF1, 0x80, 0x00]); // 模拟 MP3 头
      mockFetch.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => audioData.buffer,
      });

      const result = await textToSpeech({ text: "hello world" });
      expect(result.format).toBe("mp3");
      expect(result.audioBase64).toBeTruthy();
      expect(typeof result.audioBase64).toBe("string");

      // 验证请求参数
      const callArgs = mockFetch.mock.calls[0][1];
      const body = JSON.parse(callArgs.body);
      expect(body.input).toBe("hello world");
      expect(body.model).toBe("tts-1");
      expect(body.voice).toBe("alloy");
      expect(body.speed).toBe(1.0);
      expect(body.response_format).toBe("mp3");
    });

    it("自定义 voice 和 speed", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(4),
      });

      await textToSpeech({ text: "test", voice: "nova", speed: 2.0 });

      const callArgs = mockFetch.mock.calls[0][1];
      const body = JSON.parse(callArgs.body);
      expect(body.voice).toBe("nova");
      expect(body.speed).toBe(2.0);
    });

    it("自定义格式", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(4),
      });

      await textToSpeech({ text: "test", format: "wav" });

      const callArgs = mockFetch.mock.calls[0][1];
      const body = JSON.parse(callArgs.body);
      expect(body.response_format).toBe("wav");
    });

    it("API 错误时抛出异常", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
        text: async () => "Rate limit exceeded",
      });

      await expect(textToSpeech({ text: "test" })).rejects.toThrow("TTS API error 429");
    });
  });

  // ===== 7. generateImages API 调用 =====
  describe("generateImages API 调用", () => {
    beforeEach(() => {
      saveMultimodalSettings({
        embedding: null,
        tts: null,
        imageGen: { providerId: "openai", apiKey: "sk-img", baseUrl: "https://api.openai.com/v1", model: "dall-e-3", enabled: true },
      });
    });

    it("正确调用 Image API 并返回 base64 图片", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [
            { b64_json: "iVBORw0KGgoAAAANSUhEUg==", revised_prompt: "A beautiful sunset" },
          ],
        }),
      });

      const result = await generateImages({ prompt: "sunset" });
      expect(result.images).toHaveLength(1);
      expect(result.images[0].base64).toBe("iVBORw0KGgoAAAANSUhEUg==");
      expect(result.images[0].revisedPrompt).toBe("A beautiful sunset");

      const callArgs = mockFetch.mock.calls[0][1];
      const body = JSON.parse(callArgs.body);
      expect(body.prompt).toBe("sunset");
      expect(body.model).toBe("dall-e-3");
      expect(body.size).toBe("1024x1024");
      expect(body.response_format).toBe("b64_json");
    });

    it("自定义尺寸和质量", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [{ b64_json: "abc" }] }),
      });

      await generateImages({ prompt: "test", size: "1792x1024", quality: "hd", style: "natural" });

      const callArgs = mockFetch.mock.calls[0][1];
      const body = JSON.parse(callArgs.body);
      expect(body.size).toBe("1792x1024");
      expect(body.quality).toBe("hd");
      expect(body.style).toBe("natural");
    });

    it("多张图片", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [
            { b64_json: "img1" },
            { b64_json: "img2" },
            { b64_json: "img3" },
          ],
        }),
      });

      const result = await generateImages({ prompt: "cats", n: 3 });
      expect(result.images).toHaveLength(3);
    });

    it("API 返回 URL 而非 base64", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [{ url: "https://cdn.openai.com/image.png" }],
        }),
      });

      const result = await generateImages({ prompt: "test" });
      expect(result.images[0].url).toBe("https://cdn.openai.com/image.png");
      expect(result.images[0].base64).toBeUndefined();
    });

    it("API 错误时抛出异常", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => "Bad request",
      });

      await expect(generateImages({ prompt: "test" })).rejects.toThrow("Image generation API error 400");
    });
  });

  // ===== 8. playTTSAudio 音频播放 =====
  describe("playTTSAudio 音频播放", () => {
    it("mp3 格式创建 Audio 并播放", () => {
      playTTSAudio({ audioBase64: "dGVzdA==", format: "mp3" });
      expect(mockAudioInstances).toHaveLength(1);
      expect(mockAudioInstances[0].src).toBe("data:audio/mpeg;base64,dGVzdA==");
      expect(mockAudioPlay).toHaveBeenCalled();
    });

    it("wav 格式使用正确的 MIME type", () => {
      playTTSAudio({ audioBase64: "dGVzdA==", format: "wav" });
      expect(mockAudioInstances[mockAudioInstances.length - 1].src).toBe("data:audio/wav;base64,dGVzdA==");
    });

    it("opus 格式使用正确的 MIME type", () => {
      playTTSAudio({ audioBase64: "dGVzdA==", format: "opus" });
      expect(mockAudioInstances[mockAudioInstances.length - 1].src).toBe("data:audio/opus;base64,dGVzdA==");
    });

    it("flac 格式使用正确的 MIME type", () => {
      playTTSAudio({ audioBase64: "dGVzdA==", format: "flac" });
      expect(mockAudioInstances[mockAudioInstances.length - 1].src).toBe("data:audio/flac;base64,dGVzdA==");
    });

    it("未知格式默认使用 mp3 MIME type", () => {
      playTTSAudio({ audioBase64: "dGVzdA==", format: "unknown" });
      expect(mockAudioInstances[mockAudioInstances.length - 1].src).toBe("data:audio/mpeg;base64,dGVzdA==");
    });
  });

  // ===== 9. MULTIMODAL_MODELS 模型列表完整性 =====
  describe("MULTIMODAL_MODELS 模型列表", () => {
    it("OpenAI 有 embedding 模型", () => {
      expect(MULTIMODAL_MODELS.openai.embedding.length).toBeGreaterThan(0);
      expect(MULTIMODAL_MODELS.openai.embedding).toContain("text-embedding-3-small");
    });

    it("OpenAI 有 TTS 模型", () => {
      expect(MULTIMODAL_MODELS.openai.tts).toContain("tts-1");
      expect(MULTIMODAL_MODELS.openai.tts).toContain("tts-1-hd");
    });

    it("OpenAI 有 ImageGen 模型", () => {
      expect(MULTIMODAL_MODELS.openai.imageGen).toContain("dall-e-3");
      expect(MULTIMODAL_MODELS.openai.imageGen).toContain("dall-e-2");
    });

    it("MiMo 有全部三种模态", () => {
      expect(MULTIMODAL_MODELS.mimo.embedding).toHaveLength(1);
      expect(MULTIMODAL_MODELS.mimo.tts).toHaveLength(1);
      expect(MULTIMODAL_MODELS.mimo.imageGen).toHaveLength(1);
    });

    it("DeepSeek 不支持多模态", () => {
      expect(MULTIMODAL_MODELS.deepseek.embedding).toHaveLength(0);
      expect(MULTIMODAL_MODELS.deepseek.tts).toHaveLength(0);
      expect(MULTIMODAL_MODELS.deepseek.imageGen).toHaveLength(0);
    });

    it("Anthropic 不支持多模态", () => {
      expect(MULTIMODAL_MODELS.anthropic.embedding).toHaveLength(0);
      expect(MULTIMODAL_MODELS.anthropic.tts).toHaveLength(0);
      expect(MULTIMODAL_MODELS.anthropic.imageGen).toHaveLength(0);
    });

    it("Gemini 支持 embedding 和 imageGen", () => {
      expect(MULTIMODAL_MODELS.gemini.embedding.length).toBeGreaterThan(0);
      expect(MULTIMODAL_MODELS.gemini.imageGen.length).toBeGreaterThan(0);
      expect(MULTIMODAL_MODELS.gemini.tts).toHaveLength(0);
    });

    it("所有 provider 都有定义", () => {
      const expectedProviders = ["openai", "mimo", "deepseek", "anthropic", "gemini", "moonshot"];
      for (const p of expectedProviders) {
        expect(MULTIMODAL_MODELS[p]).toBeDefined();
        expect(MULTIMODAL_MODELS[p].embedding).toBeDefined();
        expect(MULTIMODAL_MODELS[p].tts).toBeDefined();
        expect(MULTIMODAL_MODELS[p].imageGen).toBeDefined();
      }
    });
  });

  // ===== 10. API 错误处理 =====
  describe("API 错误处理", () => {
    it("网络错误时 fetch reject", async () => {
      saveMultimodalSettings({
        embedding: { providerId: "openai", apiKey: "sk-test", baseUrl: "", model: "v1", enabled: true },
        tts: null,
        imageGen: null,
      });
      mockFetch.mockRejectedValueOnce(new Error("Network error"));

      await expect(generateEmbeddings({ texts: ["test"] })).rejects.toThrow("Network error");
    });

    it("自定义 baseUrl 被正确使用", async () => {
      saveMultimodalSettings({
        embedding: { providerId: "mimo", apiKey: "key", baseUrl: "https://api.mimo.ai/v1", model: "emb-v1", enabled: true },
        tts: null,
        imageGen: null,
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [{ embedding: [0.1] }] }),
      });

      await generateEmbeddings({ texts: ["test"] });
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.mimo.ai/v1/embeddings",
        expect.anything(),
      );
    });

    it("baseUrl 为空时使用默认 OpenAI URL", async () => {
      saveMultimodalSettings({
        embedding: { providerId: "openai", apiKey: "key", baseUrl: "", model: "v1", enabled: true },
        tts: null,
        imageGen: null,
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [{ embedding: [0.1] }] }),
      });

      await generateEmbeddings({ texts: ["test"] });
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.openai.com/v1/embeddings",
        expect.anything(),
      );
    });
  });
});
