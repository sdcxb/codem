/**
 * P3-26: useSpeechRecognition — Web Speech API STT hook
 *
 * 使用浏览器原生 SpeechRecognition API 进行语音识别（语音转文字）。
 * 支持实时识别（interim results）、连续模式、语言自动跟随 i18n 设置。
 *
 * 注意：
 * - Web Speech API 仅在 Chrome/Edge 等基于 Blink 的浏览器中可用。
 * - 在 Tauri WebView2 (Windows) 中也可用。
 * - 识别结果通过 onResult 回调返回，分 interim（实时）和 final（最终）两种。
 */

import { useState, useRef, useCallback, useEffect } from "react";
import { getLang } from "../core/i18n/lang";

// ========== Type Declarations ==========

/** SpeechRecognition 的类型声明（浏览器原生 API，TypeScript 未内置） */
interface SpeechRecognitionAlternative {
  transcript: string;
  confidence: number;
}

interface SpeechRecognitionResult {
  isFinal: boolean;
  length: number;
  item(index: number): SpeechRecognitionAlternative;
  [index: number]: SpeechRecognitionAlternative;
}

interface SpeechRecognitionResultList {
  length: number;
  item(index: number): SpeechRecognitionResult;
  [index: number]: SpeechRecognitionResult;
}

interface SpeechRecognitionEvent extends Event {
  resultIndex: number;
  results: SpeechRecognitionResultList;
}

interface SpeechRecognitionErrorEvent extends Event {
  error: string;
  message: string;
}

interface ISpeechRecognition extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((ev: SpeechRecognitionEvent) => void) | null;
  onerror: ((ev: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
}

declare global {
  interface Window {
    SpeechRecognition?: { new (): ISpeechRecognition };
    webkitSpeechRecognition?: { new (): ISpeechRecognition };
  }
}

// ========== Hook ==========

export interface UseSpeechRecognitionOptions {
  /** 识别语言，默认跟随 getLang() */
  lang?: string;
  /** 是否连续识别（false = 识别到一段话后自动停止） */
  continuous?: boolean;
  /** 是否返回中间结果 */
  interimResults?: boolean;
  /** 最终结果回调 */
  onFinalResult?: (transcript: string) => void;
  /** 中间结果回调 */
  onInterimResult?: (transcript: string) => void;
  /** 错误回调 */
  onError?: (error: string) => void;
}

export interface UseSpeechRecognitionReturn {
  /** 是否正在监听 */
  isListening: boolean;
  /** 中间识别结果（实时更新） */
  interimTranscript: string;
  /** 最终识别结果（累积） */
  finalTranscript: string;
  /** 是否支持语音识别 */
  isSupported: boolean;
  /** 开始监听 */
  start: () => void;
  /** 停止监听 */
  stop: () => void;
  /** 清空已识别的文本 */
  reset: () => void;
  /** 错误信息 */
  error: string | null;
}

export function useSpeechRecognition(options: UseSpeechRecognitionOptions = {}): UseSpeechRecognitionReturn {
  const {
    lang: langOption,
    continuous = true,
    interimResults = true,
    onFinalResult,
    onInterimResult,
    onError,
  } = options;

  const [isListening, setIsListening] = useState(false);
  const [interimTranscript, setInterimTranscript] = useState("");
  const [finalTranscript, setFinalTranscript] = useState("");
  const [error, setError] = useState<string | null>(null);

  const recognitionRef = useRef<ISpeechRecognition | null>(null);
  const callbacksRef = useRef({ onFinalResult, onInterimResult, onError });
  // Track whether user manually stopped (to prevent auto-restart on end)
  const manualStopRef = useRef(false);
  // Track desired continuous mode for auto-restart
  const shouldRestartRef = useRef(false);

  // Update callbacks ref when they change
  useEffect(() => {
    callbacksRef.current = { onFinalResult, onInterimResult, onError };
  }, [onFinalResult, onInterimResult, onError]);

  // Determine language
  const recognitionLang = langOption || (getLang() === "zh" ? "zh-CN" : "en-US");

  // Check support
  const isSupported = typeof window !== "undefined" &&
    (typeof window.SpeechRecognition !== "undefined" ||
     typeof window.webkitSpeechRecognition !== "undefined");

  // Create recognition instance
  const createRecognition = useCallback(() => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return null;

    const recognition = new SR();
    recognition.lang = recognitionLang;
    recognition.continuous = continuous;
    recognition.interimResults = interimResults;
    recognition.maxAlternatives = 1;

    recognition.onstart = () => {
      setIsListening(true);
      setError(null);
    };

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let interim = "";
      let final = "";

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const transcript = result[0].transcript;
        if (result.isFinal) {
          final += transcript;
        } else {
          interim += transcript;
        }
      }

      if (interim) {
        setInterimTranscript(interim);
        callbacksRef.current.onInterimResult?.(interim);
      }

      if (final) {
        setFinalTranscript(prev => prev + final);
        setInterimTranscript("");
        callbacksRef.current.onFinalResult?.(final);
      }
    };

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      const errMap: Record<string, string> = {
        "no-speech": "No speech detected",
        "audio-capture": "Audio capture failed",
        "not-allowed": "Microphone permission denied",
        "service-not-allowed": "Speech service not allowed",
        "network": "Network error",
        "aborted": "Recognition aborted",
      };
      const msg = errMap[event.error] || event.error;
      setError(msg);
      callbacksRef.current.onError?.(msg);
      // Don't restart on these errors
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        shouldRestartRef.current = false;
        setIsListening(false);
      }
    };

    recognition.onend = () => {
      // Auto-restart if we were in continuous mode and didn't manually stop
      if (shouldRestartRef.current && !manualStopRef.current) {
        try {
          recognition.start();
        } catch {
          setIsListening(false);
        }
      } else {
        setIsListening(false);
      }
    };

    return recognition;
  }, [recognitionLang, continuous, interimResults]);

  // Update recognition language when it changes
  useEffect(() => {
    if (recognitionRef.current) {
      recognitionRef.current.lang = recognitionLang;
    }
  }, [recognitionLang]);

  const start = useCallback(() => {
    if (!isSupported) {
      setError("Speech recognition not supported in this browser");
      callbacksRef.current.onError?.("Speech recognition not supported in this browser");
      return;
    }

    // Clean up previous instance
    if (recognitionRef.current) {
      try { recognitionRef.current.abort(); } catch {}
      recognitionRef.current = null;
    }

    manualStopRef.current = false;
    shouldRestartRef.current = continuous;

    const recognition = createRecognition();
    if (!recognition) {
      setError("Failed to create speech recognition instance");
      return;
    }

    recognitionRef.current = recognition;

    try {
      recognition.start();
    } catch (err) {
      // Sometimes start() throws if called too quickly after a previous stop
      setError(String(err));
    }
  }, [isSupported, continuous, createRecognition]);

  const stop = useCallback(() => {
    manualStopRef.current = true;
    shouldRestartRef.current = false;
    if (recognitionRef.current) {
      try { recognitionRef.current.stop(); } catch {}
    }
    setIsListening(false);
  }, []);

  const reset = useCallback(() => {
    setInterimTranscript("");
    setFinalTranscript("");
    setError(null);
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      manualStopRef.current = true;
      shouldRestartRef.current = false;
      if (recognitionRef.current) {
        try { recognitionRef.current.abort(); } catch {}
      }
    };
  }, []);

  return {
    isListening,
    interimTranscript,
    finalTranscript,
    isSupported,
    start,
    stop,
    reset,
    error,
  };
}
