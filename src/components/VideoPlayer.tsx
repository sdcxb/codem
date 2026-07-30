/**
 * VideoPlayer — 视频播放器
 *
 * 播放 AI 生成的视频，支持播放、暂停、进度条控制
 */

import { memo, useRef, useState } from "react";
import { useLang, S } from "../core/i18n/lang";

interface VideoPlayerProps {
  /** Video URL or data URI */
  src: string;
  /** Video title */
  title?: string;
}

export const VideoPlayer = memo(function VideoPlayer({
  src,
  title,
}: VideoPlayerProps) {
  const lang = useLang();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);

  const togglePlay = () => {
    if (videoRef.current) {
      if (playing) {
        videoRef.current.pause();
      } else {
        videoRef.current.play();
      }
      setPlaying(!playing);
    }
  };

  const handleTimeUpdate = () => {
    if (videoRef.current) {
      const { currentTime, duration } = videoRef.current;
      setProgress(duration > 0 ? (currentTime / duration) * 100 : 0);
    }
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (videoRef.current) {
      const time = (parseFloat(e.target.value) / 100) * videoRef.current.duration;
      videoRef.current.currentTime = time;
    }
  };

  return (
    <div className="video-player">
      {title && <div className="video-title">{title}</div>}
      <video
        ref={videoRef}
        src={src}
        onTimeUpdate={handleTimeUpdate}
        onEnded={() => setPlaying(false)}
      />
      <div className="video-controls">
        <button className="video-btn play" onClick={togglePlay}>
          {playing ? "⏸" : "▶"}
        </button>
        <input
          type="range"
          className="video-progress"
          min="0"
          max="100"
          value={progress}
          onChange={handleSeek}
        />
        <button
          className="video-btn download"
          onClick={() => {
            const a = document.createElement("a");
            a.href = src;
            a.download = title || "video.mp4";
            a.click();
          }}
        >
          {S.video.download[lang]}
        </button>
      </div>
    </div>
  );
});