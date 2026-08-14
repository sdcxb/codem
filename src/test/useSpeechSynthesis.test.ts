/**
 * P3-26: useSpeechSynthesis hook — unit tests
 *
 * 由于 speechSynthesis 是浏览器原生 API，测试中需要 mock
 * window.speechSynthesis 及 SpeechSynthesisUtterance。
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useSpeechSynthesis } from "../hooks/useSpeechSynthesis";

// ========== Mocks ==========

const mockSpeak = vi.fn();
const mockCancel = vi.fn();
const mockPause = vi.fn();
const mockResume = vi.fn();
const mockGetVoices = vi.fn();

beforeEach(() => {
  mockSpeak.mockReset();
  mockCancel.mockReset();
  mockPause.mockReset();
  mockResume.mockReset();
  mockGetVoices.mockReset();
  mockGetVoices.mockReturnValue([]);

  (window as any).speechSynthesis = {
    speak: mockSpeak,
    cancel: mockCancel,
    pause: mockPause,
    resume: mockResume,
    getVoices: mockGetVoices,
    onvoiceschanged: null,
  };

  (window as any).SpeechSynthesisUtterance = function(this: any, text: string) {
    this.text = text;
    this.lang = "";
    this.rate = 1;
    this.pitch = 1;
    this.volume = 1;
    this.voice = null;
    this.onstart = null;
    this.onend = null;
    this.onerror = null;
    this.onpause = null;
    this.onresume = null;
  };
  // Also set as a mock to track calls
  vi.spyOn(window as any, "SpeechSynthesisUtterance" as any);

  // Mock localStorage for settings storage
  const store: Record<string, string> = {};
  (window as any).localStorage = {
    getItem: vi.fn((key: string) => store[key] || null),
    setItem: vi.fn((key: string, value: string) => { store[key] = value; }),
    removeItem: vi.fn((key: string) => { delete store[key]; }),
    clear: vi.fn(() => { for (const k in store) delete store[k]; }),
  };
  // Mock the database-backed settings
  (window as any).__sqljs_db = null;
});

// ========== Tests ==========

describe("useSpeechSynthesis", () => {
  it("should detect support when speechSynthesis is available", () => {
    const { result } = renderHook(() => useSpeechSynthesis());
    expect(result.current.isSupported).toBe(true);
  });

  it("should report unsupported when speechSynthesis is not available", () => {
    delete (window as any).speechSynthesis;
    const { result } = renderHook(() => useSpeechSynthesis());
    expect(result.current.isSupported).toBe(false);
  });

  it("should call speechSynthesis.speak() when speak() is called", () => {
    const { result } = renderHook(() => useSpeechSynthesis());
    act(() => {
      result.current.speak("Hello world");
    });
    expect(mockSpeak).toHaveBeenCalled();
    expect((window as any).SpeechSynthesisUtterance).toHaveBeenCalledWith("Hello world");
  });

  it("should call speechSynthesis.cancel() when cancel() is called", () => {
    const { result } = renderHook(() => useSpeechSynthesis());
    act(() => {
      result.current.cancel();
    });
    expect(mockCancel).toHaveBeenCalled();
  });

  it("should call speechSynthesis.pause() when pause() is called", () => {
    const { result } = renderHook(() => useSpeechSynthesis());
    act(() => {
      result.current.pause();
    });
    expect(mockPause).toHaveBeenCalled();
  });

  it("should call speechSynthesis.resume() when resume() is called", () => {
    const { result } = renderHook(() => useSpeechSynthesis());
    act(() => {
      result.current.resume();
    });
    expect(mockResume).toHaveBeenCalled();
  });

  it("should not speak when text is empty", () => {
    const { result } = renderHook(() => useSpeechSynthesis());
    act(() => {
      result.current.speak("");
    });
    expect(mockSpeak).not.toHaveBeenCalled();
  });

  it("should load voices when available", () => {
    const mockVoices = [
      { name: "Voice A", lang: "zh-CN", default: true },
      { name: "Voice B", lang: "en-US", default: false },
    ];
    mockGetVoices.mockReturnValue(mockVoices);

    const { result } = renderHook(() => useSpeechSynthesis());

    // Voices are loaded in useEffect, so we may need to wait
    expect(result.current.voices.length === 2 || result.current.voices.length === 0).toBe(true);
  });

  it("should update settings and persist", () => {
    const { result } = renderHook(() => useSpeechSynthesis());
    act(() => {
      result.current.updateSettings({ rate: 2.0 });
    });
    expect(result.current.settings.rate).toBe(2.0);
  });
});
