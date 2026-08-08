/**
 * StreamAnimator — 流式文本逐字素揭示动画
 *
 * 使用 Intl.Segmenter 做字素分段，在文本尾部包裹动画 span。
 * 支持 CJK 文本，排除代码块/表格/SVG 等不需要动画的区域。
 *
 * 自主实现，未引用任何第三方流式动画库。
 */

/** 动画时间参数（毫秒） */
export const STREAM_ANIMATION_MS = 300;
export const STREAM_MIN_COMMIT_MS = 120;
export const STREAM_MAX_LAG_MS = 800;

/** 不需要流式动画的标签 */
const EXCLUDED_TAGS = new Set([
  "code", "pre", "table", "thead", "tbody", "tfoot", "tr", "td", "th",
  "svg", "math", "video", "audio", "iframe", "canvas",
]);

/** 检查环境是否支持 Intl.Segmenter */
let segmenter: Intl.Segmenter | null = null;
try {
  if (typeof Intl !== "undefined" && (Intl as any).Segmenter) {
    segmenter = new (Intl as any).Segmenter("zh", { granularity: "grapheme" });
  }
} catch {
  // 静默降级
}

/**
 * 将文本按字素（grapheme）分段
 * 优先使用 Intl.Segmenter，降级为 Array.from（按码点分）
 */
export function splitGraphemes(text: string): string[] {
  if (!text) return [];
  if (segmenter) {
    const result: string[] = [];
    for (const seg of segmenter.segment(text)) {
      result.push(seg.segment as string);
    }
    return result;
  }
  // 降级：使用 Array.from 按码点分
  return Array.from(text);
}

/**
 * 检测 Markdown 代码围栏是否未闭合
 */
export function hasUnclosedFence(content: string): boolean {
  let fence = "";
  for (const line of String(content || "").split(/\r?\n/)) {
    const match = line.match(/^\s*(`{3,}|~{3,})/);
    if (!match) continue;
    if (!fence) {
      fence = match[1];
      continue;
    }
    if (match[1][0] === fence[0] && match[1].length >= fence.length) {
      fence = "";
    }
  }
  return Boolean(fence);
}

/**
 * 将流式 Markdown 内容分块
 * 按代码围栏和空行分块，避免渲染不完整的代码块
 */
export function chunkStreamingMarkdown(content: string, streaming = false): string[] {
  if (!streaming) return [content];
  const lines = content.match(/.*(?:\n|$)/g)?.filter(Boolean) || [content];
  const chunks: string[] = [];
  let current = "";
  let fence = "";

  for (const line of lines) {
    current += line;
    const marker = line.match(/^\s*(`{3,}|~{3,})/)?.[1] || "";
    if (marker) {
      if (!fence) {
        fence = marker;
      } else if (marker[0] === fence[0] && marker.length >= fence.length) {
        fence = "";
        chunks.push(current);
        current = "";
      }
      continue;
    }
    // 非围栏内的空行作为分块点
    if (!fence && /^\s*$/.test(line) && current.trim()) {
      chunks.push(current);
      current = "";
    }
  }
  if (current) chunks.push(current);
  return chunks.length ? chunks : [""];
}

/**
 * 流式揭示状态追踪
 */
export interface StreamRevealState {
  /** 上次提交的文本长度 */
  lastCommittedLength: number;
  /** 待揭示的字素数 */
  pendingGraphemes: number;
  /** 上次提交时间戳 */
  lastCommitAt: number;
  /** 修订号（每次更新递增） */
  revision: number;
}

/** 创建初始状态 */
export function createStreamRevealState(): StreamRevealState {
  return {
    lastCommittedLength: 0,
    pendingGraphemes: 0,
    lastCommitAt: 0,
    revision: 0,
  };
}

/**
 * 计算流式揭示的过渡参数
 * @param fullText 完整文本
 * @param state 状态对象（会被就地修改）
 * @returns 需要揭示的字素数，以及是否应该立即提交
 */
export function streamRevealTransition(
  fullText: string,
  state: StreamRevealState,
  now: number = Date.now()
): { revealCount: number; shouldCommit: boolean } {
  const textLength = fullText.length;
  const newChars = textLength - state.lastCommittedLength;

  // 无新增内容
  if (newChars <= 0) {
    return { revealCount: 0, shouldCommit: false };
  }

  // 计算待揭示字素数
  const tail = fullText.slice(state.lastCommittedLength);
  const graphemes = splitGraphemes(tail);
  state.pendingGraphemes += graphemes.length;

  // 判断是否应该提交
  const elapsed = now - state.lastCommitAt;
  const shouldCommit = elapsed >= STREAM_MIN_COMMIT_MS;

  if (shouldCommit) {
    // 提交：揭示所有待处理字素
    const revealCount = Math.min(state.pendingGraphemes, graphemes.length);
    state.pendingGraphemes = 0;
    state.lastCommittedLength = textLength;
    state.lastCommitAt = now;
    state.revision += 1;
    return { revealCount, shouldCommit: true };
  }

  // 不提交，但可以渐进揭示部分字素
  const lagMs = now - state.lastCommitAt;
  if (lagMs > STREAM_MAX_LAG_MS) {
    // 超过最大延迟，强制提交
    const revealCount = state.pendingGraphemes;
    state.pendingGraphemes = 0;
    state.lastCommittedLength = textLength;
    state.lastCommitAt = now;
    state.revision += 1;
    return { revealCount, shouldCommit: true };
  }

  return { revealCount: 0, shouldCommit: false };
}

/**
 * 修复 CJK 粗体标记
 * CommonMark 在 `**粗体**` 后紧跟 CJK 字符时不渲染粗体，
 * 此函数在文本层面预处理，将 CJK 前的 `**` 替换为带空格的版本。
 */
export function fixCjkBoldMarkdown(text: string): string {
  // 匹配 **text** 或 __text__ 后紧跟 CJK 字符的情况
  const cjkAfter = /[\u{3400}-\u{9FFF}\u{F900}-\u{FAFF}\u{3040}-\u{30FF}\u{AC00}-\u{D7AF}]/u;
  return text.replace(/(\*\*|__)(.+?)\1/g, (match, marker, content) => {
    // 检查匹配后的下一个字符是否是 CJK
    const afterIndex = text.indexOf(match) + match.length;
    const nextChar = text[afterIndex] || "";
    if (nextChar && cjkAfter.test(nextChar)) {
      // 在闭合标记后添加零宽空格
      return `${marker}${content}${marker}\u200B`;
    }
    return match;
  });
}
