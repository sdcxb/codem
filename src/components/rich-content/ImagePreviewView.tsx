/**
 * ImagePreviewView — 图片预览视图
 *
 * 在 ContentFrame 内渲染图片预览，支持点击全屏查看。
 */

import { memo, useState } from "react";
import { PanelIcons, ActionIcons } from "../../core/icons/icon-map";
import { ContentFrame } from "./ContentFrame";

interface ImagePreviewViewProps {
  src: string;
  alt?: string;
  title?: string;
}

export const ImagePreviewView = memo(function ImagePreviewView({
  src,
  alt = "",
  title,
}: ImagePreviewViewProps) {
  const [fullscreen, setFullscreen] = useState(false);
  const ImageIcon = PanelIcons.image;
  const CloseIcon = ActionIcons.close;

  if (fullscreen) {
    return (
      <div className="content-fullscreen-backdrop" onClick={() => setFullscreen(false)}>
        <div className="content-fullscreen image-fullscreen" onClick={(e) => e.stopPropagation()}>
          <div className="content-fullscreen-header">
            <span className="content-fullscreen-title">{title || alt || "图片"}</span>
            <button className="content-fullscreen-close" onClick={() => setFullscreen(false)}><CloseIcon size={18} /></button>
          </div>
          <div className="content-fullscreen-body image-fullscreen-body">
            <img src={src} alt={alt} className="image-fullscreen-img" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <ContentFrame
      title={title || "图片"}
      icon={<ImageIcon size={14} />}
      fullscreenable
      onFullscreen={() => setFullscreen(true)}
      className="image-preview-view"
    >
      <img src={src} alt={alt} className="image-preview-img" loading="lazy" />
    </ContentFrame>
  );
});
