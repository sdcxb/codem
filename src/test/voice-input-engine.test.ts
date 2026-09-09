/**
 * 语音输入引擎决策 + 云端 Whisper 转写服务 — 单元测试
 *
 * 改动影响（语音输入双引擎闭环）：
 *   - multimodal.ts: SpeechEngine 类型 / readVoiceEngine 纯函数 /
 *     get/saveVoiceInputEngine（codem-voice-settings.speechEngine 持久化）/
 *     transcribeAudioFile 公开转写服务（multipart {baseUrl}/audio/transcriptions）
 *   - VoiceSettingsPanel.tsx: 「语音输入引擎」选择 UI
 *   - InputArea.tsx: 麦克风按引擎分流（browser 沿用 Web Speech API；
 *     whisper 走 MediaRecorder 录音 → transcribeAudioFile）
 *
 * 测试范围：
 *   A. readVoiceEngine 纯函数（缺省/未知值回退 browser）(VE-001 ~ VE-008)
 *   B. getVoiceInputEngine / saveVoiceInputEngine 持久化合并写 (VE-009 ~ VE-013)
 *   C. isSTTConfigured / transcribeAudioFile HTTP 链路 (VE-014 ~ VE-020)
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// ========== Mocks ==========

// 内存版 settings 存储（语义镜像真实 getSetting/getSettingJSON）
vi.mock("../core/storage/settings", () => {
  const store: Record<string, string> = {};
  return {
    getSetting: vi.fn((key: string) => (key in store ? store[key] : null)),
    setSetting: vi.fn((key: string, val: string) => { store[key] = val; }),
    removeSetting: vi.fn((key: string) => { delete store[key]; }),
    getSettingJSON: vi.fn(<T>(key: string, def: T): T => {
      if (!(key in store)) return def;
      try { return JSON.parse(store[key]) as T; } catch { return def; }
    }),
    setSettingJSON: vi.fn((key: string, val: unknown) => { store[key] = JSON.stringify(val); }),
  };
});

// ========== Imports ==========
import {
  readVoiceEngine,
  getVoiceInputEngine,
  saveVoiceInputEngine,
  isSTTConfigured,
  transcribeAudioFile,
  STT_NOT_CONFIGURED_ERROR,
  type SpeechEngine,
} from "../core/llm/multimodal";
import {
  getSettingJSON,
  setSettingJSON,
  removeSetting,
} from "../core/storage/settings";

const mockFetch = vi.fn();

const VOICE_KEY = "codem-voice-settings";
const MULTIMODAL_KEY = "codem-multimodal-settings";

function saveSttConfig(
  cfg: { providerId: string; apiKey: string; baseUrl: string; model: string } | null,
  enabled = true,
): void {
  setSettingJSON(MULTIMODAL_KEY, {
    vision: null,
    stt: cfg ? { ...cfg, enabled } : null,
    embedding: null,
    tts: null,
    imageGen: null,
  });
}

beforeEach(() => {
  removeSetting(VOICE_KEY);
  removeSetting(MULTIMODAL_KEY);
  (globalThis as any).fetch = mockFetch;
  mockFetch.mockReset();
});

// ========== A. readVoiceEngine 纯函数 ==========

describe("A. readVoiceEngine 纯函数", () => {
  it("VE-001: settings 为 undefined 时回退 browser", () => {
    expect(readVoiceEngine(undefined)).toBe("browser");
  });

  it("VE-002: settings 为 null 时回退 browser", () => {
    expect(readVoiceEngine(null)).toBe("browser");
  });

  it("VE-003: 空对象（无 speechEngine 键，旧设置兼容）回退 browser", () => {
    expect(readVoiceEngine({})).toBe("browser");
  });

  it("VE-004: speechEngine='whisper' 返回 whisper", () => {
    expect(readVoiceEngine({ speechEngine: "whisper" })).toBe("whisper");
  });

  it("VE-005: speechEngine='browser' 返回 browser", () => {
    expect(readVoiceEngine({ speechEngine: "browser" })).toBe("browser");
  });

  it("VE-006: 未知值（如 'webrtc'）回退 browser", () => {
    expect(readVoiceEngine({ speechEngine: "webrtc" as SpeechEngine })).toBe("browser");
  });

  it("VE-007: 同 JSON 中携带 TTS 字段不影响决策", () => {
    expect(readVoiceEngine({ speechEngine: "whisper", voiceName: "A", rate: 1.5, volume: 0.8 })).toBe("whisper");
    expect(readVoiceEngine({ voiceName: "A", rate: 1.5 })).toBe("browser");
  });
});

// ========== B. getVoiceInputEngine / saveVoiceInputEngine ==========

describe("B. 语音输入引擎持久化（codem-voice-settings.speechEngine）", () => {
  it("VE-008: 未存储任何设置时默认 browser", () => {
    expect(getVoiceInputEngine()).toBe("browser");
  });

  it("VE-009: 存储 whisper 后可读回 whisper", () => {
    saveVoiceInputEngine("whisper");
    expect(getVoiceInputEngine()).toBe("whisper");
  });

  it("VE-010: 切回 browser 后可读回 browser", () => {
    saveVoiceInputEngine("whisper");
    saveVoiceInputEngine("browser");
    expect(getVoiceInputEngine()).toBe("browser");
  });

  it("VE-011: 与 TTS 语音设置共用键时合并写入、不覆盖其它字段", () => {
    setSettingJSON(VOICE_KEY, { voiceName: "Microsoft Xiaoxiao", rate: 1.25, pitch: 1.1, volume: 0.9 });
    saveVoiceInputEngine("whisper");
    const stored = getSettingJSON<Record<string, unknown>>(VOICE_KEY, {});
    expect(stored.speechEngine).toBe("whisper");
    expect(stored.voiceName).toBe("Microsoft Xiaoxiao");
    expect(stored.rate).toBe(1.25);
    expect(stored.pitch).toBe(1.1);
    expect(stored.volume).toBe(0.9);
  });

  it("VE-012: speechEngine 不存在（仅 TTS 字段）时仍默认 browser", () => {
    setSettingJSON(VOICE_KEY, { voiceName: "A", rate: 1.0 });
    expect(getVoiceInputEngine()).toBe("browser");
  });
});

// ========== C. isSTTConfigured / transcribeAudioFile ==========

describe("C. 云端 Whisper 转写服务", () => {
  it("VE-013: 未配置 STT 时 isSTTConfigured 为 false", () => {
    expect(isSTTConfigured()).toBe(false);
  });

  it("VE-014: 已启用且带 apiKey 时 isSTTConfigured 为 true", () => {
    saveSttConfig({ providerId: "openai", apiKey: "sk-whisper", baseUrl: "https://api.openai.com/v1", model: "whisper-1" });
    expect(isSTTConfigured()).toBe(true);
  });

  it("VE-015: enabled=false 时 isSTTConfigured 为 false", () => {
    saveSttConfig({ providerId: "openai", apiKey: "sk-whisper", baseUrl: "https://api.openai.com/v1", model: "whisper-1" }, false);
    expect(isSTTConfigured()).toBe(false);
  });

  it("VE-016: 未配置 OpenAI STT 时抛出可读错误（引导设置→多模态）", async () => {
    const audio = new Blob(["fake-webm"], { type: "audio/webm" });
    const p = transcribeAudioFile(audio);
    await expect(p).rejects.toThrow(/not configured/i);
    await expect(p).rejects.toThrow(/Settings.*Multimodal/i);
    await expect(p).rejects.toThrow(STT_NOT_CONFIGURED_ERROR);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("VE-017: 成功时 multipart POST 到 {baseUrl}/audio/transcriptions 并返回文本", async () => {
    saveSttConfig({ providerId: "openai", apiKey: "sk-whisper-test", baseUrl: "https://api.openai.com/v1", model: "whisper-1" });
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => "你好，世界 hello world" });

    const audio = new Blob(["fake-webm-audio"], { type: "audio/webm;codecs=opus" });
    const text = await transcribeAudioFile(audio);
    expect(text).toBe("你好，世界 hello world");

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)?.Authorization).toBe("Bearer sk-whisper-test");

    const fd = init.body as FormData;
    expect(fd).toBeInstanceOf(FormData);
    expect(fd.get("model")).toBe("whisper-1");
    expect(fd.get("response_format")).toBe("text");
    const file = fd.get("file");
    expect(file).toBeTruthy();
  });

  it("VE-018: stt 配置 model 为空时默认 whisper-1，baseUrl 为空时用 OpenAI 官方地址", async () => {
    saveSttConfig({ providerId: "openai", apiKey: "sk-whisper", baseUrl: "", model: "" });
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => "ok" });

    const audio = new Blob(["a"], { type: "audio/mp4" });
    await transcribeAudioFile(audio);

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/audio/transcriptions");
    const fd = init.body as FormData;
    expect(fd.get("model")).toBe("whisper-1");
  });

  it("VE-019: 响应非 ok 时抛出带状态码的错误", async () => {
    saveSttConfig({ providerId: "openai", apiKey: "sk-whisper", baseUrl: "https://api.openai.com/v1", model: "whisper-1" });
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => "unauthorized sk-abcdef1234567890abcdef1234567890",
    });

    const audio = new Blob(["x"], { type: "audio/webm" });
    await expect(transcribeAudioFile(audio)).rejects.toThrow(/STT API error 401/);
  });

  it("VE-020: 未配置 apiKey（enabled 但 key 为空）视为未配置并报可读错误", async () => {
    saveSttConfig({ providerId: "openai", apiKey: "", baseUrl: "https://api.openai.com/v1", model: "whisper-1" });
    expect(isSTTConfigured()).toBe(false);
    const audio = new Blob(["x"], { type: "audio/webm" });
    await expect(transcribeAudioFile(audio)).rejects.toThrow(/not configured/i);
  });
});
