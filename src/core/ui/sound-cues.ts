/**
 * 合成提示音（WebAudio，**零素材**）。
 *
 * ## 为什么用振荡器而不是音频文件
 *
 * 对标 open-claude-ui 的 `ClaudeAudioPlayer`：0.35s 的双音提示用两个 oscillator + 增益包络
 * 现场合成 —— 不引入任何第三方音频资产（许可干净、体积为零），也不会因为资源路径失效而静音。
 *
 * ## 默认关闭
 *
 * 提示音是**打扰性**能力：默认必须关（`codem-sound-cues` = "0"），只有用户在
 * 设置 → 外观里显式打开才发声。判据 `SOUND-1..3`。
 *
 * ## 失败必须静默
 *
 * 音频栈在无设备/被浏览器策略拦截时很常见（尤其没有用户手势时 `AudioContext` 会 suspended）。
 * 这里所有路径都 try/catch 返回 false —— **不抛错、不影响主流程**。
 */

import { getSetting } from "../storage/settings";

export const SOUND_CUES_SETTING_KEY = "codem-sound-cues";

export type SoundCue = "sent" | "done" | "error";

/** 每种提示音的两个音高（Hz）与时长（ms） */
const CUE_SPEC: Record<SoundCue, { notes: [number, number]; noteMs: number; peak: number }> = {
  sent: { notes: [660, 880], noteMs: 90, peak: 0.06 },
  done: { notes: [740, 988], noteMs: 130, peak: 0.08 },
  error: { notes: [392, 294], noteMs: 140, peak: 0.07 },
};

let ctx: AudioContext | null = null;

function getContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  if (!ctx) {
    try {
      ctx = new Ctor();
    } catch {
      return null;
    }
  }
  return ctx;
}

/** 只读设置（同步）；默认关闭 */
export function isSoundCuesEnabled(): boolean {
  try {
    return getSetting(SOUND_CUES_SETTING_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * 播放一个提示音；返回是否真的发声（便于判据与调试）。
 * 关闭 / 无音频栈 / 播放抛错 都返回 false，**绝不抛错**。
 */
export function playSoundCue(kind: SoundCue): boolean {
  if (!isSoundCuesEnabled()) return false;
  const audio = getContext();
  const spec = CUE_SPEC[kind];
  if (!audio || !spec) return false;
  try {
    if (audio.state === "suspended") void audio.resume();
    const now = audio.currentTime;
    spec.notes.forEach((freq, i) => {
      const start = now + i * (spec.noteMs / 1000);
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(freq, start);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.linearRampToValueAtTime(spec.peak, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + spec.noteMs / 1000);
      osc.connect(gain);
      gain.connect(audio.destination);
      osc.start(start);
      osc.stop(start + spec.noteMs / 1000);
    });
    return true;
  } catch {
    return false;
  }
}

/** 测试用：丢掉缓存的 AudioContext（生产代码不调用） */
export function __resetSoundContextForTests(): void {
  ctx = null;
}
