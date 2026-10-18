/**
 * ImageGallery — 图片预览画廊
 *
 * 显示消息中的图片缩略图，点击放大预览，左右切换
 */

import { memo, useState, useEffect } from "react";
import { flushSync } from "react-dom";
import { runViewTransition } from "../core/ui/view-transition";
import { useDismissableLayer } from "../hooks/useDismissableLayer";
import { useLang, S } from "../core/i18n/lang";
import { ActionIcons } from "../core/icons/icon-map";

interface ImageGalleryProps {
  /** Image URLs or data URIs */
  images: string[];
  /** Initial image index */
  initialIndex?: number;
  /** Close gallery */
  onClose: () => void;
  /**
   * 共享元素转场名（与缩略图上的 `view-transition-name` 成对，见 MessageBubble）。
   * 未提供时退化为普通淡入。
   */
  transitionName?: string;
}

export const ImageGallery = memo(function ImageGallery({
  images,
  initialIndex = 0,
  onClose,
  transitionName,
}: ImageGalleryProps) {
  const lang = useLang();
  const [currentIndex, setCurrentIndex] = useState(initialIndex);

  useEffect(() => {
    setCurrentIndex(initialIndex);
  }, [initialIndex]);

  const handlePrev = () => {
    setCurrentIndex((prev) => (prev > 0 ? prev - 1 : images.length - 1));
  };

  const handleNext = () => {
    setCurrentIndex((prev) => (prev < images.length - 1 ? prev + 1 : 0));
  };

  /* 第 173 轮 P2-6：Escape 走共享 hook（方向键仍是这个 handler 的职责 —— 它属于"元素自己的
     按键语义"，不该搬到 document 级去做浮层关闭）。 */
  const closeWithTransition = () => {
    runViewTransition(() => {
      flushSync(() => onClose());
    });
  };

  useDismissableLayer({ onDismiss: closeWithTransition });

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "ArrowLeft") handlePrev();
    if (e.key === "ArrowRight") handleNext();
  };

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  return (
    <div className="image-gallery-overlay" onClick={closeWithTransition}>
      <div className="image-gallery" onClick={(e) => e.stopPropagation()}>
        <button className="gallery-close" onClick={closeWithTransition} aria-label="关闭"><ActionIcons.close size={16} /></button>
        <button className="gallery-nav prev" onClick={handlePrev}>
          ‹
        </button>
        <img
          src={images[currentIndex]}
          alt={`Image ${currentIndex + 1}`}
          className="gallery-image"
          style={transitionName ? { viewTransitionName: transitionName } : undefined}
        />
        <button className="gallery-nav next" onClick={handleNext}>
          ›
        </button>
        <div className="gallery-counter">
          {currentIndex + 1} / {images.length}
        </div>
        <a
          href={images[currentIndex]}
          download={`image-${currentIndex + 1}`}
          className="gallery-download"
          onClick={(e) => e.stopPropagation()}
        >
          {S.gallery.download[lang]}
        </a>
      </div>
    </div>
  );
});