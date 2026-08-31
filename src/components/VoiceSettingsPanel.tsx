/**
 * P3-26: VoiceSettingsPanel — 语音设置面板
 *
 * 配置浏览器内置 TTS 的语音选择、语速、音调、音量。
 * 同时提供"优先使用云端 TTS"开关。
 *
 * 嵌入 SettingsPanel 中作为 "语音" 标签页。
 */

import { useState, useEffect, useCallback } from "react";
import { useLang, S } from "../core/i18n/lang";
import { ConfigEntry, ToggleEntry } from "./SettingsParts";
import { useSpeechSynthesis, getVoiceSettings, saveVoiceSettings } from "../hooks/useSpeechSynthesis";
import { getMultimodalSettings } from "../core/llm/multimodal";
import { getSettingJSON, setSettingJSON } from "../core/storage/settings";
import { Volume2, Play, Square } from "lucide-react";

export function VoiceSettingsPanel() {
  const lang = useLang();
  const zh = lang === "zh";

  // Speech synthesis hook for live testing
  const { voices, isSupported, isSpeaking, speak, cancel, settings, updateSettings } = useSpeechSynthesis();

  // Cloud TTS preference
  const [preferCloudTts, setPreferCloudTts] = useState(false);
  const [cloudTtsConfigured, setCloudTtsConfigured] = useState(false);

  useEffect(() => {
    setPreferCloudTts(getSettingJSON<boolean>("codem-prefer-cloud-tts", false));
    const mmSettings = getMultimodalSettings();
    setCloudTtsConfigured(!!(mmSettings.tts && mmSettings.tts.enabled && mmSettings.tts.apiKey));
  }, []);

  const handlePreferCloudTts = (val: boolean) => {
    setSettingJSON("codem-prefer-cloud-tts", val);
    setPreferCloudTts(val);
    window.dispatchEvent(new Event("codem-voice-settings-changed"));
  };

  // Filter voices by language
  const zhVoices = voices.filter(v => v.lang.startsWith("zh"));
  const enVoices = voices.filter(v => v.lang.startsWith("en"));
  const otherVoices = voices.filter(v => !v.lang.startsWith("zh") && !v.lang.startsWith("en"));

  const handleTest = useCallback(() => {
    if (isSpeaking) {
      cancel();
    } else {
      speak(S.voice.testText[lang]);
    }
  }, [isSpeaking, cancel, speak, lang]);

  // Group voices for the dropdown
  const renderVoiceGroup = (label: string, group: SpeechSynthesisVoice[]) => {
    if (group.length === 0) return null;
    return (
      <optgroup label={label}>
        {group.map(v => (
          <option key={v.name} value={v.name}>
            {v.name} ({v.lang})
          </option>
        ))}
      </optgroup>
    );
  };

  return (
    <div className="settings-section voice-settings">
      <div className="settings-section-header" style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
        <Volume2 size={18} style={{ color: "var(--accent)" }} />
        <h3 style={{ fontSize: 'var(--fs-md)', fontWeight: 600 }}>{S.voice.settingsTitle[lang]}</h3>
      </div>

      {!isSupported && (
        <div style={{
          padding: 12,
          background: "var(--danger-bg, rgba(239, 68, 68, 0.1))",
          border: "1px solid var(--danger-border, rgba(239, 68, 68, 0.3))",
          borderRadius: 8,
          fontSize: 'var(--fs-sm)',
          color: "var(--danger, #ef4444)",
          marginBottom: 16,
        }}>
          {S.voice.ttsUnsupported[lang]}
        </div>
      )}

      {/* Cloud TTS preference */}
      <ToggleEntry
        label={S.voice.useCloudTts[lang]}
        description={S.voice.useCloudTtsHint[lang]}
        value={preferCloudTts}
        onChange={handlePreferCloudTts}
      />

      {!cloudTtsConfigured && preferCloudTts && (
        <div style={{
          padding: 8,
          fontSize: 'var(--fs-sm)',
          color: "var(--warning, #f59e0b)",
          marginLeft: 8,
        }}>
          {zh ? "⚠ 云端 TTS 尚未配置，将回退使用浏览器内置 TTS。" : "⚠ Cloud TTS not configured, will fall back to browser TTS."}
        </div>
      )}

      {preferCloudTts && cloudTtsConfigured && (
        <div style={{ padding: 8, fontSize: 'var(--fs-sm)', color: "var(--text-muted)", marginLeft: 8 }}>
          {zh ? "当前使用云端 TTS，以下浏览器 TTS 设置仅在回退时生效。" : "Currently using cloud TTS, browser TTS settings below only apply on fallback."}
        </div>
      )}

      {/* Voice selection */}
      <ConfigEntry
        label={S.voice.voiceSelect[lang]}
        description={S.voice.voiceSelectHint[lang]}
      >
        <select
          value={settings.voiceName || ""}
          onChange={(e) => updateSettings({ voiceName: e.target.value })}
          disabled={!isSupported}
          style={{
            background: "var(--bg-tertiary)",
            border: "1px solid var(--border-primary)",
            borderRadius: 6,
            padding: "4px 8px",
            fontSize: 'var(--fs-sm)',
            color: "var(--text-primary)",
            minWidth: 220,
            cursor: "pointer",
          }}
        >
          <option value="">{zh ? "自动选择" : "Auto-select"}</option>
          {renderVoiceGroup(zh ? "中文" : "Chinese", zhVoices)}
          {renderVoiceGroup(zh ? "英文" : "English", enVoices)}
          {renderVoiceGroup(zh ? "其他" : "Other", otherVoices)}
        </select>
      </ConfigEntry>

      {/* Speech rate */}
      <ConfigEntry
        label={S.voice.rate[lang]}
        description={S.voice.rateHint[lang]}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 200 }}>
          <input
            type="range"
            min={0.5}
            max={2.0}
            step={0.1}
            value={settings.rate}
            onChange={(e) => updateSettings({ rate: parseFloat(e.target.value) })}
            disabled={!isSupported}
            style={{ flex: 1 }}
          />
          <span style={{ fontSize: 'var(--fs-sm)', color: "var(--text-muted)", minWidth: 32, textAlign: "right" }}>
            {settings.rate.toFixed(1)}x
          </span>
        </div>
      </ConfigEntry>

      {/* Pitch */}
      <ConfigEntry
        label={S.voice.pitch[lang]}
        description={S.voice.pitchHint[lang]}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 200 }}>
          <input
            type="range"
            min={0}
            max={2}
            step={0.1}
            value={settings.pitch}
            onChange={(e) => updateSettings({ pitch: parseFloat(e.target.value) })}
            disabled={!isSupported}
            style={{ flex: 1 }}
          />
          <span style={{ fontSize: 'var(--fs-sm)', color: "var(--text-muted)", minWidth: 32, textAlign: "right" }}>
            {settings.pitch.toFixed(1)}
          </span>
        </div>
      </ConfigEntry>

      {/* Volume */}
      <ConfigEntry
        label={S.voice.volume[lang]}
        description={S.voice.volumeHint[lang]}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 200 }}>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={settings.volume}
            onChange={(e) => updateSettings({ volume: parseFloat(e.target.value) })}
            disabled={!isSupported}
            style={{ flex: 1 }}
          />
          <span style={{ fontSize: 'var(--fs-sm)', color: "var(--text-muted)", minWidth: 32, textAlign: "right" }}>
            {Math.round(settings.volume * 100)}%
          </span>
        </div>
      </ConfigEntry>

      {/* Test button */}
      <div style={{ padding: "12px 0", display: "flex", gap: 8, alignItems: "center" }}>
        <button
          onClick={handleTest}
          disabled={!isSupported}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "6px 16px",
            background: isSpeaking ? "var(--danger, #ef4444)" : "var(--accent)",
            color: "#fff",
            border: "none",
            borderRadius: 6,
            fontSize: 'var(--fs-sm)',
            cursor: isSupported ? "pointer" : "not-allowed",
            opacity: isSupported ? 1 : 0.5,
          }}
        >
          {isSpeaking ? <Square size={14} fill="currentColor" /> : <Play size={14} />}
          {isSpeaking ? S.voice.stopReading[lang] : S.voice.testVoice[lang]}
        </button>
        <span style={{ fontSize: 'var(--fs-sm)', color: "var(--text-muted)" }}>
          {voices.length > 0
            ? (zh ? `${voices.length} 个可用语音` : `${voices.length} voices available`)
            : (zh ? "正在加载语音..." : "Loading voices...")
          }
        </span>
      </div>

      {/* Cloud TTS hint */}
      <div style={{
        padding: 12,
        background: "var(--bg-tertiary)",
        borderRadius: 8,
        fontSize: 'var(--fs-sm)',
        color: "var(--text-muted)",
        marginTop: 16,
        lineHeight: 1.6,
      }}>
        <div style={{ fontWeight: 600, marginBottom: 4 }}>{S.voice.cloudTtsHint[lang]}</div>
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
          <span>
            <strong>{S.voice.browserTts[lang]}:</strong> {zh ? "免费、零配置、系统语音" : "Free, zero-config, system voices"}
          </span>
          <span>
            <strong>{S.voice.cloudTts[lang]}:</strong> {zh ? "高质量自然语音、需 API Key" : "High-quality natural voices, requires API key"}
          </span>
        </div>
      </div>
    </div>
  );
}
