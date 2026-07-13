/**
 * 测试：多模态自然语言意图检测 + 工具注册 + 系统提示词
 *
 * 改动影响：
 *   - prompt.ts 系统提示词新增 "Multimodal Tools (Auto-detect user intent)" 章节
 *   - tools.ts 新增 createTTSTool() / createImageGenTool()
 *   - tools.ts createDefaultToolRegistry() 注册 TTS 和 ImageGen 工具
 *   - 工具描述包含中文关键词（朗读、语音、画图等）
 *   - App.tsx 移除了 /tts 和 /image 斜杠命令
 *
 * 测试范围：
 *   1. 系统提示词包含多模态工具说明
 *   2. 系统提示词包含中文关键词触发说明
 *   3. 系统提示词强调"不要使用命令"
 *   4. TTS/ImageGen 工具正确注册
 *   5. 工具描述包含意图检测关键词
 *   6. 工具参数定义正确性
 *   7. TTS 工具执行（mock 多模态模块）
 *   8. ImageGen 工具执行（mock 多模态模块）
 *   9. 未配置时的工具返回
 *   10. 斜杠命令已移除验证
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { buildSystemPrompt } from "../core/prompt/prompt";
import { createDefaultToolRegistry, createTTSTool, createImageGenTool } from "../core/llm/tools";
import type { AgentDefinition } from "../core/agent/agent";

// Mock 多模态模块
vi.mock("../core/llm/multimodal", () => ({
  textToSpeech: vi.fn(),
  playTTSAudio: vi.fn(),
  generateImages: vi.fn(),
  getMultimodalSettings: vi.fn(),
}));

import { textToSpeech, playTTSAudio, generateImages, getMultimodalSettings } from "../core/llm/multimodal";

// Mock settings
vi.mock("../core/storage/settings", () => ({
  getSetting: vi.fn().mockReturnValue(null),
  setSetting: vi.fn(),
  getSettingJSON: vi.fn().mockReturnValue(null),
  setSettingJSON: vi.fn(),
  removeSetting: vi.fn(),
}));

// Mock agent registry
vi.mock("../core/agent/agent", () => ({
  getAgentRegistry: vi.fn().mockReturnValue({
    evaluatePermission: vi.fn().mockReturnValue("ask"),
  }),
}));

const mockAgent: AgentDefinition = {
  id: "build",
  name: "Build",
  description: "Default build agent",
  mode: "primary",
  prompt: "You are a build agent.",
  collaborationMode: "default",
  permissions: [],
};

describe("多模态自然语言意图检测", () => {
  beforeEach(() => {
    vi.mocked(textToSpeech).mockReset();
    vi.mocked(playTTSAudio).mockReset();
    vi.mocked(generateImages).mockReset();
    vi.mocked(getMultimodalSettings).mockReset();
  });

  // ===== 1. 系统提示词包含多模态工具说明 =====
  describe("系统提示词多模态说明", () => {
    const prompt = buildSystemPrompt({
      agent: mockAgent,
      workingDirectory: "D:\\test",
    });

    it("包含 'Multimodal Tools' 章节", () => {
      expect(prompt).toContain("Multimodal Tools");
    });

    it("包含 'Auto-detect user intent' 说明", () => {
      expect(prompt).toContain("Auto-detect");
      expect(prompt).toContain("intent");
    });

    it("包含 tts 工具说明", () => {
      expect(prompt).toContain("tts");
      expect(prompt).toContain("Text-to-Speech");
    });

    it("包含 image_gen 工具说明", () => {
      expect(prompt).toContain("image_gen");
      expect(prompt).toContain("Image Generation");
    });
  });

  // ===== 2. 系统提示词包含中文关键词触发说明 =====
  describe("中文关键词触发说明", () => {
    const prompt = buildSystemPrompt({
      agent: mockAgent,
      workingDirectory: "D:\\test",
    });

    it("TTS 触发词 — 朗读", () => {
      expect(prompt).toContain("朗读");
    });

    it("TTS 触发词 — 语音", () => {
      expect(prompt).toContain("语音");
    });

    it("TTS 触发词 — 声音", () => {
      expect(prompt).toContain("声音");
    });

    it("TTS 触发词 — 配音", () => {
      expect(prompt).toContain("配音");
    });

    it("TTS 触发词 — 音频", () => {
      expect(prompt).toContain("音频");
    });

    it("ImageGen 触发词 — 生成图片", () => {
      expect(prompt).toContain("生成图片");
    });

    it("ImageGen 触发词 — 画一幅图", () => {
      expect(prompt).toContain("画一幅图");
    });

    it("ImageGen 触发词 — 画图", () => {
      expect(prompt).toContain("画图");
    });

    it("ImageGen 触发词 — 帮我画", () => {
      expect(prompt).toContain("帮我画");
    });

    it("ImageGen 触发词 — 海报", () => {
      expect(prompt).toContain("海报");
    });

    it("ImageGen 触发词 — 图标", () => {
      expect(prompt).toContain("图标");
    });

    it("ImageGen 触发词 — 插图", () => {
      expect(prompt).toContain("插图");
    });
  });

  // ===== 3. 系统提示词强调"不要使用命令" =====
  describe("禁止命令提示", () => {
    const prompt = buildSystemPrompt({
      agent: mockAgent,
      workingDirectory: "D:\\test",
    });

    it("强调不要告诉用户使用命令", () => {
      expect(prompt).toContain("Do NOT tell the user to use commands");
    });

    it("强调不要使用 /tts 或 /image", () => {
      expect(prompt).toContain("/tts");
      expect(prompt).toContain("/image");
    });

    it("强调直接检测意图并调用工具", () => {
      expect(prompt).toContain("detect their intent and call the tool directly");
    });
  });

  // ===== 4. TTS/ImageGen 工具正确注册 =====
  describe("工具注册", () => {
    it("createDefaultToolRegistry 包含 tts 工具", () => {
      const registry = createDefaultToolRegistry();
      expect(registry.get("tts")).toBeDefined();
    });

    it("createDefaultToolRegistry 包含 image_gen 工具", () => {
      const registry = createDefaultToolRegistry();
      expect(registry.get("image_gen")).toBeDefined();
    });

    it("createTTSTool 返回正确的工具定义", () => {
      const tool = createTTSTool();
      expect(tool.id).toBe("tts");
      expect(tool.description).toBeTruthy();
      expect(tool.parameters).toBeDefined();
    });

    it("createImageGenTool 返回正确的工具定义", () => {
      const tool = createImageGenTool();
      expect(tool.id).toBe("image_gen");
      expect(tool.description).toBeTruthy();
      expect(tool.parameters).toBeDefined();
    });
  });

  // ===== 5. 工具描述包含意图检测关键词 =====
  describe("工具描述关键词", () => {
    it("TTS 工具描述包含中文关键词", () => {
      const tool = createTTSTool();
      expect(tool.description).toContain("朗读");
      expect(tool.description).toContain("语音");
      expect(tool.description).toContain("声音");
      expect(tool.description).toContain("音频");
      expect(tool.description).toContain("配音");
    });

    it("TTS 工具描述包含英文关键词", () => {
      const tool = createTTSTool();
      expect(tool.description).toContain("speech");
      expect(tool.description).toContain("audio");
      expect(tool.description).toContain("voice");
    });

    it("TTS 工具描述包含 'no commands needed'", () => {
      const tool = createTTSTool();
      expect(tool.description).toContain("no commands needed");
    });

    it("ImageGen 工具描述包含中文关键词", () => {
      const tool = createImageGenTool();
      expect(tool.description).toContain("生成图片");
      expect(tool.description).toContain("画一幅图");
      expect(tool.description).toContain("画图");
      expect(tool.description).toContain("帮我画");
      expect(tool.description).toContain("海报");
      expect(tool.description).toContain("图标");
      expect(tool.description).toContain("插图");
    });

    it("ImageGen 工具描述包含 'no commands needed'", () => {
      const tool = createImageGenTool();
      expect(tool.description).toContain("no commands needed");
    });
  });

  // ===== 6. 工具参数定义正确性 =====
  describe("工具参数定义", () => {
    it("TTS 工具参数包含 text（必需）", () => {
      const tool = createTTSTool();
      const params = tool.parameters as any;
      expect(params.properties.text).toBeDefined();
      expect(params.required).toContain("text");
    });

    it("TTS 工具参数包含 voice（可选）", () => {
      const tool = createTTSTool();
      const params = tool.parameters as any;
      expect(params.properties.voice).toBeDefined();
      expect(params.required).not.toContain("voice");
    });

    it("TTS 工具参数包含 speed（可选）", () => {
      const tool = createTTSTool();
      const params = tool.parameters as any;
      expect(params.properties.speed).toBeDefined();
      expect(params.required).not.toContain("speed");
    });

    it("ImageGen 工具参数包含 prompt（必需）", () => {
      const tool = createImageGenTool();
      const params = tool.parameters as any;
      expect(params.properties.prompt).toBeDefined();
      expect(params.required).toContain("prompt");
    });

    it("ImageGen 工具参数包含 size（可选）", () => {
      const tool = createImageGenTool();
      const params = tool.parameters as any;
      expect(params.properties.size).toBeDefined();
      expect(params.required).not.toContain("size");
    });

    it("ImageGen 工具参数包含 quality（可选）", () => {
      const tool = createImageGenTool();
      const params = tool.parameters as any;
      expect(params.properties.quality).toBeDefined();
    });

    it("ImageGen 工具参数包含 style（可选）", () => {
      const tool = createImageGenTool();
      const params = tool.parameters as any;
      expect(params.properties.style).toBeDefined();
    });
  });

  // ===== 7. TTS 工具执行 =====
  describe("TTS 工具执行", () => {
    it("成功调用 TTS 并播放音频", async () => {
      vi.mocked(getMultimodalSettings).mockReturnValue({
        embedding: null,
        tts: { providerId: "openai", apiKey: "sk-test", baseUrl: "", model: "tts-1", enabled: true },
        imageGen: null,
      });
      vi.mocked(textToSpeech).mockResolvedValue({ audioBase64: "dGVzdA==", format: "mp3" });

      const tool = createTTSTool();
      const result = await tool.execute(
        { text: "你好世界" },
        { sessionId: "s1", messageId: "m1", cwd: "D:\\test", abort: new AbortSignal(), messages: [], metadata: () => {} },
      );

      expect(textToSpeech).toHaveBeenCalledWith({ text: "你好世界", voice: undefined, speed: undefined });
      expect(playTTSAudio).toHaveBeenCalledWith({ audioBase64: "dGVzdA==", format: "mp3" });
      expect(result.title).toContain("语音合成");
      expect(result.output).toContain("✅");
    });

    it("未配置 TTS 时返回错误信息", async () => {
      vi.mocked(getMultimodalSettings).mockReturnValue({
        embedding: null,
        tts: null,
        imageGen: null,
      });

      const tool = createTTSTool();
      const result = await tool.execute(
        { text: "test" },
        { sessionId: "s1", messageId: "m1", cwd: "D:\\test", abort: new AbortSignal(), messages: [], metadata: () => {} },
      );

      expect(result.output).toContain("not configured");
    });

    it("空文本返回错误", async () => {
      const tool = createTTSTool();
      const result = await tool.execute(
        { text: "" },
        { sessionId: "s1", messageId: "m1", cwd: "D:\\test", abort: new AbortSignal(), messages: [], metadata: () => {} },
      );
      expect(result.output).toContain("Error");
    });

    it("TTS API 错误时返回错误信息", async () => {
      vi.mocked(getMultimodalSettings).mockReturnValue({
        embedding: null,
        tts: { providerId: "openai", apiKey: "sk-test", baseUrl: "", model: "tts-1", enabled: true },
        imageGen: null,
      });
      vi.mocked(textToSpeech).mockRejectedValue(new Error("API error 500"));

      const tool = createTTSTool();
      const result = await tool.execute(
        { text: "test" },
        { sessionId: "s1", messageId: "m1", cwd: "D:\\test", abort: new AbortSignal(), messages: [], metadata: () => {} },
      );
      expect(result.output).toContain("API error 500");
    });

    it("自定义 voice 和 speed 传递正确", async () => {
      vi.mocked(getMultimodalSettings).mockReturnValue({
        embedding: null,
        tts: { providerId: "openai", apiKey: "sk-test", baseUrl: "", model: "tts-1", enabled: true },
        imageGen: null,
      });
      vi.mocked(textToSpeech).mockResolvedValue({ audioBase64: "abc", format: "mp3" });

      const tool = createTTSTool();
      await tool.execute(
        { text: "test", voice: "nova", speed: 2.0 },
        { sessionId: "s1", messageId: "m1", cwd: "D:\\test", abort: new AbortSignal(), messages: [], metadata: () => {} },
      );

      expect(textToSpeech).toHaveBeenCalledWith({ text: "test", voice: "nova", speed: 2.0 });
    });
  });

  // ===== 8. ImageGen 工具执行 =====
  describe("ImageGen 工具执行", () => {
    it("成功生成图片并返回 markdown", async () => {
      vi.mocked(getMultimodalSettings).mockReturnValue({
        embedding: null,
        tts: null,
        imageGen: { providerId: "openai", apiKey: "sk-test", baseUrl: "", model: "dall-e-3", enabled: true },
      });
      vi.mocked(generateImages).mockResolvedValue({
        images: [{ base64: "iVBORw0KGgo=", revisedPrompt: "A nice sunset" }],
      });

      const tool = createImageGenTool();
      const result = await tool.execute(
        { prompt: "日落风景" },
        { sessionId: "s1", messageId: "m1", cwd: "D:\\test", abort: new AbortSignal(), messages: [], metadata: () => {} },
      );

      expect(generateImages).toHaveBeenCalledWith({ prompt: "日落风景", size: undefined, quality: undefined, style: undefined });
      expect(result.output).toContain("data:image/png;base64,iVBORw0KGgo=");
      expect(result.output).toContain("A nice sunset");
    });

    it("未配置 ImageGen 时返回错误信息", async () => {
      vi.mocked(getMultimodalSettings).mockReturnValue({
        embedding: null,
        tts: null,
        imageGen: null,
      });

      const tool = createImageGenTool();
      const result = await tool.execute(
        { prompt: "test" },
        { sessionId: "s1", messageId: "m1", cwd: "D:\\test", abort: new AbortSignal(), messages: [], metadata: () => {} },
      );
      expect(result.output).toContain("not configured");
    });

    it("空 prompt 返回错误", async () => {
      const tool = createImageGenTool();
      const result = await tool.execute(
        { prompt: "" },
        { sessionId: "s1", messageId: "m1", cwd: "D:\\test", abort: new AbortSignal(), messages: [], metadata: () => {} },
      );
      expect(result.output).toContain("Error");
    });

    it("ImageGen API 错误时返回错误信息", async () => {
      vi.mocked(getMultimodalSettings).mockReturnValue({
        embedding: null,
        tts: null,
        imageGen: { providerId: "openai", apiKey: "sk-test", baseUrl: "", model: "dall-e-3", enabled: true },
      });
      vi.mocked(generateImages).mockRejectedValue(new Error("API error 429"));

      const tool = createImageGenTool();
      const result = await tool.execute(
        { prompt: "test" },
        { sessionId: "s1", messageId: "m1", cwd: "D:\\test", abort: new AbortSignal(), messages: [], metadata: () => {} },
      );
      expect(result.output).toContain("API error 429");
    });

    it("自定义 size/quality/style 传递正确", async () => {
      vi.mocked(getMultimodalSettings).mockReturnValue({
        embedding: null,
        tts: null,
        imageGen: { providerId: "openai", apiKey: "sk-test", baseUrl: "", model: "dall-e-3", enabled: true },
      });
      vi.mocked(generateImages).mockResolvedValue({ images: [{ base64: "abc" }] });

      const tool = createImageGenTool();
      await tool.execute(
        { prompt: "test", size: "512x512", quality: "hd", style: "natural" },
        { sessionId: "s1", messageId: "m1", cwd: "D:\\test", abort: new AbortSignal(), messages: [], metadata: () => {} },
      );

      expect(generateImages).toHaveBeenCalledWith({ prompt: "test", size: "512x512", quality: "hd", style: "natural" });
    });

    it("URL 格式图片也能正确返回", async () => {
      vi.mocked(getMultimodalSettings).mockReturnValue({
        embedding: null,
        tts: null,
        imageGen: { providerId: "openai", apiKey: "sk-test", baseUrl: "", model: "dall-e-3", enabled: true },
      });
      vi.mocked(generateImages).mockResolvedValue({
        images: [{ url: "https://cdn.example.com/image.png" }],
      });

      const tool = createImageGenTool();
      const result = await tool.execute(
        { prompt: "test" },
        { sessionId: "s1", messageId: "m1", cwd: "D:\\test", abort: new AbortSignal(), messages: [], metadata: () => {} },
      );
      expect(result.output).toContain("https://cdn.example.com/image.png");
    });
  });

  // ===== 9. 斜杠命令已移除验证 =====
  describe("斜杠命令已移除", () => {
    it("系统提示词中不鼓励使用 /tts 命令", () => {
      const prompt = buildSystemPrompt({
        agent: mockAgent,
        workingDirectory: "D:\\test",
      });
      // 提示词中提到 /tts 是为了告诉 AI 不要使用它
      expect(prompt).toContain("Do NOT tell the user to use commands like \"/tts\" or \"/image\"");
    });
  });
});
