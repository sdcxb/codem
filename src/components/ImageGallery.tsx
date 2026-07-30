/**
 * ImageGallery — 图片预览画廊
 *
 * 显示消息中的图片缩略图，点击放大预览，左右切换
 */

import { memo, useState, useEffect } from "react";
import { useLang, S } from "../core/i18n/lang";

interface ImageGalleryProps {
  /** Image URLs or data URIs */
  images: string[];
  /** Initial image index */
  initialIndex?: number;
  /** Close gallery */
  onClose: () => void;
}

export const ImageGallery = memo(function ImageGallery({
  images,
  initialIndex = 0,
  onClose,
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

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") onClose();
    if (e.key === "ArrowLeft") handlePrev();
    if (e.key === "ArrowRight") handleNext();
  };

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  return (
    <div className="image-gallery-overlay" onClick={onClose}>
      <div className="image-gallery" onClick={(e) => e.stopPropagation()}>
        <button className="gallery-close" onClick={onClose}>✕</button>
        <button className="gallery-nav prev" onClick={handlePrev}>
          ‹
        </button>
        <img
          src={images[currentIndex]}
          alt={`Image ${currentIndex + 1}`}
          className="gallery-image"
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