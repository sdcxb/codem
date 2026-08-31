/**
 * AudioPlayer — 音频文件播放器
 *
 * 支持 mp3, wav, ogg, m4a 等格式。
 * 使用原生 <audio> 元素，提供波形可视化（简易版）。
 */

import { useState, useRef, useEffect, memo } from "react";
import { Play, Pause, Volume2, Download } from "lucide-react";

interface AudioPlayerProps {
  filePath?: string;
  src?: string;
  fileName?: string;
  onClose?: () => void;
}

export const AudioPlayer = memo(function AudioPlayer({ filePath, src, fileName, onClose }: AudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [volume, setVolume] = useState(1);
  const [audioSrc, setAudioSrc] = useState<string>("");

  useEffect(() => {
    if (src) {
      setAudioSrc(src);
    } else if (filePath) {
      // For Tauri, load file as data URL
      fetch(`file://${filePath}`)
        .then(res => res.blob())
        .then(blob => {
          const reader = new FileReader();
          reader.onload = () => setAudioSrc(reader.result as string);
          reader.readAsDataURL(blob);
        })
        .catch(() => setAudioSrc(`file://${filePath}`));
    }
  }, [filePath, src]);

  const togglePlay = () => {
    if (!audioRef.current) return;
    if (playing) {
      audioRef.current.pause();
    } else {
      audioRef.current.play();
    }
    setPlaying(!playing);
  };

  const formatTime = (s: number) => {
    if (!s || isNaN(s)) return "0:00";
    const mins = Math.floor(s / 60);
    const secs = Math.floor(s % 60);
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  return (
    <div className="audio-player" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <Volume2 size={24} style={{ color: "var(--accent)" }} />
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 600, fontSize: 'var(--fs-base)' }}>{fileName || "Audio"}</div>
          <div style={{ fontSize: 'var(--fs-sm)', color: "var(--text-muted)" }}>{formatTime(duration)}</div>
        </div>
        {onClose && (
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)" }}>
            ✕
          </button>
        )}
      </div>

      <audio
        ref={audioRef}
        src={audioSrc}
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
        onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
        onEnded={() => setPlaying(false)}
        onVolumeChange={(e) => setVolume(e.currentTarget.volume)}
      />

      {/* Progress bar */}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <button
          onClick={togglePlay}
          style={{
            width: 36, height: 36, borderRadius: "50%",
            background: "var(--accent)", color: "#fff",
            border: "none", cursor: "pointer",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}
        >
          {playing ? <Pause size={16} /> : <Play size={16} />}
        </button>
        <span style={{ fontSize: 'var(--fs-sm)', color: "var(--text-muted)", minWidth: 32 }}>{formatTime(currentTime)}</span>
        <input
          type="range"
          min={0}
          max={duration || 100}
          value={currentTime}
          onChange={(e) => {
            if (audioRef.current) {
              audioRef.current.currentTime = parseFloat(e.target.value);
              setCurrentTime(parseFloat(e.target.value));
            }
          }}
          style={{ flex: 1 }}
        />
        <span style={{ fontSize: 'var(--fs-sm)', color: "var(--text-muted)", minWidth: 32 }}>{formatTime(duration)}</span>
      </div>

      {/* Volume control */}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Volume2 size={14} style={{ color: "var(--text-muted)" }} />
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={volume}
          onChange={(e) => {
            if (audioRef.current) audioRef.current.volume = parseFloat(e.target.value);
            setVolume(parseFloat(e.target.value));
          }}
          style={{ width: 100 }}
        />
      </div>
    </div>
  );
});
