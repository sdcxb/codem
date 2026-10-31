/**
 * 可视区虚拟窗口计算（完整历史）。
 *
 * 输入每条消息的已知高度（未测量时用估算），输出应挂载的区间与上下留白。
 * 纯函数，便于对边界做判据；实际测量由组件用 ref 回填高度。
 */
export interface VirtualWindow {
  start: number;
  end: number;
  top: number;
  bottom: number;
  totalHeight: number;
}

export function computeVirtualWindow(
  heights: number[],
  scrollTop: number,
  viewportHeight: number,
  overscan = 4,
): VirtualWindow {
  const total = heights.length;
  if (total === 0) return { start: 0, end: 0, top: 0, bottom: 0, totalHeight: 0 };

  const safeHeights = heights.map((h) => (Number.isFinite(h) && h > 0 ? h : 1));
  // 视口未知（jsdom/隐藏面板）⇒ fail-open 全量渲染，不能把历史藏掉。
  if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) {
    const totalHeight = safeHeights.reduce((a, b) => a + b, 0);
    return { start: 0, end: total, top: 0, bottom: 0, totalHeight };
  }

  const offsets: number[] = new Array(total + 1);
  offsets[0] = 0;
  for (let i = 0; i < total; i++) offsets[i + 1] = offsets[i] + safeHeights[i];
  const totalHeight = offsets[total];
  const top = Math.max(0, Math.min(Number(scrollTop) || 0, Math.max(0, totalHeight - viewportHeight)));
  const viewEnd = top + viewportHeight;

  // 第一个“底边 > 视口顶部”的项
  let start = 0;
  while (start < total && offsets[start + 1] <= top) start++;
  // 最后一个“顶边 < 视口底部”的项
  let end = start;
  while (end < total && offsets[end] < viewEnd) end++;

  start = Math.max(0, start - Math.max(0, Math.floor(overscan)));
  end = Math.min(total, end + Math.max(0, Math.floor(overscan)));

  return {
    start,
    end,
    top: offsets[start],
    bottom: totalHeight - offsets[end],
    totalHeight,
  };
}
