/**
 * 笔记本式知识管理 — 文本分块器
 *
 * 纯 TypeScript 实现，无外部依赖。
 * 策略：段落优先 → 句子分割 → 重叠窗口
 */

import type { NotebookConfig } from './types';
import { DEFAULT_CONFIG } from './types';

export interface TextChunk {
  content: string;
  chunkIndex: number;
  tokenCount: number;
}

// ========== 主分块函数 ==========

export function chunkText(text: string, config?: Partial<NotebookConfig>): TextChunk[] {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  if (!text || text.trim().length === 0) return [];

  // Step 1: Split by paragraphs (double newline)
  const paragraphs = splitByParagraphs(text);

  // Step 2: Merge short paragraphs / split long ones
  const segments: string[] = [];
  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (!trimmed) continue;

    if (trimmed.length <= cfg.maxChunkSize) {
      segments.push(trimmed);
    } else {
      // Split long paragraph by sentences
      const sentences = splitBySentences(trimmed);
      let currentChunk = '';

      for (const sentence of sentences) {
        const candidate = currentChunk ? `${currentChunk} ${sentence}` : sentence;

        if (candidate.length > cfg.maxChunkSize && currentChunk) {
          segments.push(currentChunk.trim());
          // Start new chunk with overlap from the end of previous
          currentChunk = applyOverlap(currentChunk, sentence, cfg.overlapSize);
          currentChunk = currentChunk ? `${currentChunk} ${sentence}` : sentence;
        } else {
          currentChunk = candidate;
        }
      }

      if (currentChunk.trim()) {
        segments.push(currentChunk.trim());
      }
    }
  }

  // Step 3: Final pass — merge very short segments and add token counts
  const merged = mergeShortSegments(segments, cfg.maxChunkSize);

  // Step 4: Build final chunks with index and token estimate
  return merged.map((content, index) => ({
    content,
    chunkIndex: index,
    tokenCount: estimateTokens(content),
  }));
}

// ========== 段落分割 ==========

function splitByParagraphs(text: string): string[] {
  // Split on double (or more) newlines
  return text.split(/\n\s*\n/);
}

// ========== 句子分割 ==========

function splitBySentences(text: string): string[] {
  // Match sentence-ending punctuation followed by whitespace/uppercase
  // Supports Chinese and English punctuation
  const sentenceEnders = /([.!?。！？；;]\s+)/g;

  const sentences: string[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = sentenceEnders.exec(text)) !== null) {
    const end = match.index + match[0].length;
    const sentence = text.slice(lastIndex, end).trim();
    if (sentence) sentences.push(sentence);
    lastIndex = end;
  }

  // Remaining text
  const remaining = text.slice(lastIndex).trim();
  if (remaining) sentences.push(remaining);

  return sentences;
}

// ========== 重叠窗口 ==========

function applyOverlap(previousChunk: string, _nextSentence: string, overlapSize: number): string {
  if (overlapSize <= 0 || !previousChunk) return '';

  // Take the last `overlapSize` characters of the previous chunk
  if (previousChunk.length <= overlapSize) return previousChunk;

  // Try to start at a word boundary
  const tail = previousChunk.slice(-overlapSize);
  const spaceIdx = tail.indexOf(' ');
  return spaceIdx >= 0 ? tail.slice(spaceIdx + 1) : tail;
}

// ========== 合并短段 ==========

function mergeShortSegments(segments: string[], maxSize: number): string[] {
  if (segments.length <= 1) return segments;

  const merged: string[] = [];
  let current = '';

  for (const seg of segments) {
    if (!seg) continue;

    const candidate = current ? `${current}\n\n${seg}` : seg;

    if (candidate.length > maxSize && current) {
      merged.push(current);
      current = seg;
    } else {
      current = candidate;
    }
  }

  if (current) merged.push(current);

  return merged;
}

// ========== Token 估算 ==========

export function estimateTokens(text: string): number {
  if (!text) return 0;

  // Rough estimation: ~4 characters per token for English, ~2 for CJK
  // Use a weighted approach: count CJK chars separately
  const cjkChars = (text.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
  const otherChars = text.length - cjkChars;

  // CJK: ~1 token per char; Latin: ~4 chars per token
  return Math.ceil(cjkChars * 1.5 + otherChars / 4);
}
