/**
 * P3-26: useSpeechSynthesis — Web Speech API TTS hook
 *
 * 使用浏览器原生 speechSynthesis API 进行语音合成（文字转语音）。
 * 支持语音选择、语速、音调控制、自动语言匹配。
 *
 * 优先级策略：
 * 1. 如果用户在多模态设置中配置了云端 TTS provider（如 OpenAI tts-1），
 *    则由调用方直接调用 textToSpeech() API，本 hook 不介入。
 * 2. 本 hook 提供浏览器内置的免费 TTS，作为零配置的默认选项。
 *
 * 注意：
 * - speechSynthesis 在 Chrome/Edge 中使用系统内置语音引擎。
 * - Windows 上有 Microsoft Huihui/Yaoyao/Aya 等中文语音。
 * - 需要等待 voices 加载完成后才能选择语音。
 */

import { useState, useRef, useCallback, useEffect } from "react";
import { getLang } from "../core/i18n/lang";
import { getSettingJSON, setSettingJSON } from "../core/storage/settings";

// ========== Types ==========

export interface VoiceSettings {
  /** 选择的语音名称 */
  voiceName?: string;
  /** 语速 (0.1 - 10.0, 默认 1.0) */
  rate: number;
  /** 音调 (0 - 2, 默认 1.0) */
  pitch: number;
  /** 音量 (0 - 1, 默认 1.0) */
  volume: number;
}

const SETTINGS_KEY = "codem-voice-settings";

const defaultSettings: VoiceSettings = {
  voiceName: undefined,
  rate: 1.0,
  pitch: 1.0,
  volume: 1.0,
};

// ========== Hook ==========

export interface UseSpeechSynthesisReturn {
  /** 是否正在朗读 */
  isSpeaking: boolean;
  /** 是否暂停 */
  isPaused: boolean;
  /** 是否支持语音合成 */
  isSupported: boolean;
  /** 可用语音列表 */
  voices: SpeechSynthesisVoice[];
  /** 开始朗读 */
  speak: (text: string, options?: Partial<VoiceSettings>) => void;
  /** 停止朗读 */
  cancel: () => void;
  /** 暂停 */
  pause: () => void;
  /** 恢复 */
  resume: () => void;
  /** 当前设置 */
  settings: VoiceSettings;
  /** 更新设置 */
  updateSettings: (settings: Partial<VoiceSettings>) => void;
}

export function getVoiceSettings(): VoiceSettings {
  return { ...defaultSettings, ...getSettingJSON<Partial<VoiceSettings>>(SETTINGS_KEY, {}) };
}

export function saveVoiceSettings(settings: Partial<VoiceSettings>): void {
  const current = getVoiceSettings();
  const merged = { ...current, ...settings };
  setSettingJSON(SETTINGS_KEY, merged);
  // Notify listeners
  window.dispatchEvent(new Event("codem-voice-settings-changed"));
}

export function useSpeechSynthesis(): UseSpeechSynthesisReturn {
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [settings, setSettings] = useState<VoiceSettings>(getVoiceSettings());

  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);

  const isSupported = typeof window !== "undefined" && "speechSynthesis" in window;

  // Load settings from storage and listen for changes
  useEffect(() => {
    const handler = () => setSettings(getVoiceSettings());
    window.addEventListener("codem-voice-settings-changed", handler);
    return () => window.removeEventListener("codem-voice-settings-changed", handler);
  }, []);

  // Load voices (async — some browsers load them lazily)
  useEffect(() => {
    if (!isSupported) return;

    const loadVoices = () => {
      const available = window.speechSynthesis.getVoices();
      if (available && available.length > 0) {
        setVoices(available);
      }
    };

    loadVoices();
    // Chrome loads voices asynchronously
    window.speechSynthesis.onvoiceschanged = loadVoices;

    return () => {
      window.speechSynthesis.onvoiceschanged = null;
    };
  }, [isSupported]);

  // Auto-select a voice matching the current language if no voice is configured
  const getBestVoice = useCallback((langCode: string): SpeechSynthesisVoice | null => {
    if (settings.voiceName) {
      const found = voices.find(v => v.name === settings.voiceName);
      if (found) return found;
    }
    // Try exact match first
    let voice = voices.find(v => v.lang === langCode);
    if (voice) return voice;
    // Try prefix match (e.g. "zh" matches "zh-CN", "zh-TW")
    const prefix = langCode.split("-")[0];
    voice = voices.find(v => v.lang.startsWith(prefix));
    if (voice) return voice;
    // Fall back to default
    return voices.find(v => v.default) || voices[0] || null;
  }, [voices, settings.voiceName]);

  const speak = useCallback((text: string, options?: Partial<VoiceSettings>) => {
    if (!isSupported || !text.trim()) return;

    // Cancel any ongoing speech
    window.speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(text);
    const mergedSettings = { ...settings, ...options };
    const langCode = getLang() === "zh" ? "zh-CN" : "en-US";

    utterance.lang = langCode;
    utterance.rate = mergedSettings.rate;
    utterance.pitch = mergedSettings.pitch;
    utterance.volume = mergedSettings.volume;

    const voice = getBestVoice(langCode);
    if (voice) {
      utterance.voice = voice;
    }

    utterance.onstart = () => {
      setIsSpeaking(true);
      setIsPaused(false);
    };

    utterance.onend = () => {
      setIsSpeaking(false);
      setIsPaused(false);
      utteranceRef.current = null;
    };

    utterance.onerror = () => {
      setIsSpeaking(false);
      setIsPaused(false);
      utteranceRef.current = null;
    };

    utterance.onpause = () => setIsPaused(true);
    utterance.onresume = () => setIsPaused(false);

    utteranceRef.current = utterance;
    window.speechSynthesis.speak(utterance);
  }, [isSupported, settings, getBestVoice]);

  const cancel = useCallback(() => {
    if (!isSupported) return;
    window.speechSynthesis.cancel();
    setIsSpeaking(false);
    setIsPaused(false);
    utteranceRef.current = null;
  }, [isSupported]);

  const pause = useCallback(() => {
    if (!isSupported) return;
    window.speechSynthesis.pause();
    setIsPaused(true);
  }, [isSupported]);

  const resume = useCallback(() => {
    if (!isSupported) return;
    window.speechSynthesis.resume();
    setIsPaused(false);
  }, [isSupported]);

  const updateSettings = useCallback((newSettings: Partial<VoiceSettings>) => {
    saveVoiceSettings(newSettings);
    setSettings(prev => ({ ...prev, ...newSettings }));
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (isSupported) {
        window.speechSynthesis.cancel();
      }
    };
  }, [isSupported]);

  return {
    isSpeaking,
    isPaused,
    isSupported,
    voices,
    speak,
    cancel,
    pause,
    resume,
    settings,
    updateSettings,
  };
}
