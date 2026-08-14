/**
 * P3-26: useSpeechRecognition hook — unit tests
 *
 * 由于 Web Speech API 是浏览器原生 API，测试中需要 mock
 * SpeechRecognition 构造函数及其事件触发。
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useSpeechRecognition } from "../hooks/useSpeechRecognition";

// ========== Mocks ==========

let mockRecognitionInstance: any;

const mockSpeechRecognition = vi.fn(function(this: any) {
  const instance = {
    lang: "",
    continuous: false,
    interimResults: false,
    maxAlternatives: 1,
    start: vi.fn(),
    stop: vi.fn(),
    abort: vi.fn(),
    onresult: null,
    onerror: null,
    onend: null,
    onstart: null,
  };
  Object.assign(this, instance);
  mockRecognitionInstance = this;
  return this;
});

// Install mock on window
beforeEach(() => {
  (window as any).SpeechRecognition = mockSpeechRecognition;
  (window as any).webkitSpeechRecognition = undefined;
  mockRecognitionInstance = null;
  // Mock localStorage for getLang()
  (window as any).localStorage = {
    getItem: vi.fn(() => null),
    setItem: vi.fn(),
    removeItem: vi.fn(),
    clear: vi.fn(),
  };
  // Mock the database-backed settings
  (window as any).__sqljs_db = null;
});

// ========== Tests ==========

describe("useSpeechRecognition", () => {
  it("should detect support when SpeechRecognition is available", () => {
    const { result } = renderHook(() => useSpeechRecognition({}));
    expect(result.current.isSupported).toBe(true);
  });

  it("should report unsupported when SpeechRecognition is not available", () => {
    delete (window as any).SpeechRecognition;
    delete (window as any).webkitSpeechRecognition;
    const { result } = renderHook(() => useSpeechRecognition({}));
    expect(result.current.isSupported).toBe(false);
  });

  it("should start listening and call recognition.start()", () => {
    const { result } = renderHook(() => useSpeechRecognition({}));
    act(() => {
      result.current.start();
    });
    expect(mockRecognitionInstance).toBeTruthy();
    expect(mockRecognitionInstance.start).toHaveBeenCalled();
    // Simulate onstart event
    act(() => {
      if (mockRecognitionInstance.onstart) mockRecognitionInstance.onstart();
    });
    expect(result.current.isListening).toBe(true);
  });

  it("should stop listening and call recognition.stop()", () => {
    const { result } = renderHook(() => useSpeechRecognition({}));
    act(() => {
      result.current.start();
      if (mockRecognitionInstance.onstart) mockRecognitionInstance.onstart();
    });
    act(() => {
      result.current.stop();
    });
    expect(mockRecognitionInstance.stop).toHaveBeenCalled();
  });

  it("should handle final results via onFinalResult callback", () => {
    const onFinalResult = vi.fn();
    const { result } = renderHook(() => useSpeechRecognition({ onFinalResult }));
    act(() => {
      result.current.start();
      if (mockRecognitionInstance.onstart) mockRecognitionInstance.onstart();
    });

    // Simulate a final result event
    const mockEvent = {
      resultIndex: 0,
      results: {
        length: 1,
        0: { isFinal: true, 0: { transcript: "hello world", confidence: 0.9 }, length: 1 },
        item: function (i: number) { return this[i]; },
      },
    };
    act(() => {
      if (mockRecognitionInstance.onresult) mockRecognitionInstance.onresult(mockEvent);
    });

    expect(onFinalResult).toHaveBeenCalledWith("hello world");
    expect(result.current.finalTranscript).toContain("hello world");
  });

  it("should handle interim results", () => {
    const onInterimResult = vi.fn();
    const { result } = renderHook(() => useSpeechRecognition({ onInterimResult }));
    act(() => {
      result.current.start();
      if (mockRecognitionInstance.onstart) mockRecognitionInstance.onstart();
    });

    const mockEvent = {
      resultIndex: 0,
      results: {
        length: 1,
        0: { isFinal: false, 0: { transcript: "hello", confidence: 0.5 }, length: 1 },
        item: function (i: number) { return this[i]; },
      },
    };
    act(() => {
      if (mockRecognitionInstance.onresult) mockRecognitionInstance.onresult(mockEvent);
    });

    expect(onInterimResult).toHaveBeenCalledWith("hello");
    expect(result.current.interimTranscript).toBe("hello");
  });

  it("should handle errors", () => {
    const onError = vi.fn();
    const { result } = renderHook(() => useSpeechRecognition({ onError }));
    act(() => {
      result.current.start();
      if (mockRecognitionInstance.onstart) mockRecognitionInstance.onstart();
    });

    act(() => {
      if (mockRecognitionInstance.onerror)
        mockRecognitionInstance.onerror({ error: "not-allowed", message: "Permission denied" });
    });

    expect(onError).toHaveBeenCalledWith("Microphone permission denied");
    expect(result.current.error).toContain("Microphone permission denied");
  });

  it("should reset transcripts", () => {
    const { result } = renderHook(() => useSpeechRecognition({}));
    act(() => {
      result.current.start();
      if (mockRecognitionInstance.onstart) mockRecognitionInstance.onstart();

      // Add some text
      const mockEvent = {
        resultIndex: 0,
        results: {
          length: 1,
          0: { isFinal: true, 0: { transcript: "test", confidence: 0.9 }, length: 1 },
          item: function (i: number) { return this[i]; },
        },
      };
      if (mockRecognitionInstance.onresult) mockRecognitionInstance.onresult(mockEvent);
    });

    expect(result.current.finalTranscript).toBe("test");

    act(() => {
      result.current.reset();
    });

    expect(result.current.finalTranscript).toBe("");
    expect(result.current.interimTranscript).toBe("");
  });
});
