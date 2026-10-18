/**
 * SOUND：合成提示音（WebAudio，默认关、失败静默）。
 *
 * 用假的 AudioContext 断言"真的建了振荡器/增益"，而不是只断言函数不抛错。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setSetting, removeSetting } from "../core/storage/settings";
import {
  SOUND_CUES_SETTING_KEY,
  isSoundCuesEnabled,
  playSoundCue,
  __resetSoundContextForTests,
} from "../core/ui/sound-cues";

class FakeParam {
  setValueAtTime = vi.fn();
  linearRampToValueAtTime = vi.fn();
  exponentialRampToValueAtTime = vi.fn();
}

class FakeOsc {
  type = "sine";
  frequency = new FakeParam();
  connect = vi.fn();
  start = vi.fn();
  stop = vi.fn();
}

class FakeGain {
  gain = new FakeParam();
  connect = vi.fn();
}

class FakeAudioContext {
  state = "running";
  currentTime = 0;
  destination = {};
  oscillators: FakeOsc[] = [];
  gains: FakeGain[] = [];
  createOscillator() {
    const osc = new FakeOsc();
    this.oscillators.push(osc);
    return osc;
  }
  createGain() {
    const gain = new FakeGain();
    this.gains.push(gain);
    return gain;
  }
  resume = vi.fn();
}

let lastCtx: FakeAudioContext | null = null;

beforeEach(() => {
  __resetSoundContextForTests();
  lastCtx = null;
  (globalThis as any).window = globalThis as any;
  (globalThis as any).AudioContext = function () {
    lastCtx = new FakeAudioContext();
    return lastCtx;
  };
});

afterEach(() => {
  try {
    removeSetting(SOUND_CUES_SETTING_KEY);
  } catch {
    /* ignore */
  }
  delete (globalThis as any).AudioContext;
});

describe("SOUND 合成提示音", () => {
  it("SOUND-1: 默认关闭 —— 不建 AudioContext、不发声", () => {
    expect(isSoundCuesEnabled()).toBe(false);
    expect(playSoundCue("done")).toBe(false);
    expect(lastCtx).toBeNull();
  });

  it("SOUND-2: 打开后按 spec 合成两个音（正弦 + 增益包络）", () => {
    setSetting(SOUND_CUES_SETTING_KEY, "1");
    expect(isSoundCuesEnabled()).toBe(true);
    expect(playSoundCue("done")).toBe(true);
    expect(lastCtx).not.toBeNull();
    expect(lastCtx!.oscillators).toHaveLength(2);
    expect(lastCtx!.gains).toHaveLength(2);
    for (const osc of lastCtx!.oscillators) {
      expect(osc.type).toBe("sine");
      expect(osc.start).toHaveBeenCalled();
      expect(osc.stop).toHaveBeenCalled();
      expect(osc.connect).toHaveBeenCalled();
    }
  });

  it("SOUND-3: 音频栈抛错时静默失败（不影响主流程）", () => {
    setSetting(SOUND_CUES_SETTING_KEY, "1");
    (globalThis as any).AudioContext = function () {
      throw new Error("no audio device");
    };
    __resetSoundContextForTests();
    expect(playSoundCue("sent")).toBe(false);
  });
});
