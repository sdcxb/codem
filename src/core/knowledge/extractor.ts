/**
 * 笔记本式知识管理 — 文本提取器
 *
 * 从不同来源（文件、文本、URL）提取纯文本。
 * 不依赖任何外部库，PDF 支持为可选（后续 F7）。
 */

import type { NotebookSource } from './types';
import { extractPdfText, isPdfFile } from './pdf-extractor';

// ========== 支持的文本文件扩展名 ==========

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.rst',
  '.json', '.yaml', '.yml', '.xml', '.csv', '.tsv',
  '.ts', '.js', '.jsx', '.tsx', '.mjs', '.cjs',
  '.py', '.java', '.go', '.rs', '.c', '.cpp', '.h', '.hpp',
  '.rb', '.php', '.swift', '.kt', '.scala', '.clj',
  '.sh', '.bash', '.zsh', '.fish', '.ps1',
  '.sql', '.graphql', '.proto',
  '.html', '.htm', '.css', '.scss', '.less',
  '.vue', '.svelte',
  '.log', '.env', '.ini', '.conf', '.cfg', '.toml',
  '.dockerfile', '.gitignore', '.editorconfig',
]);

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.svg',
  '.mp3', '.mp4', '.wav', '.avi', '.mov', '.mkv', '.flv',
  '.zip', '.tar', '.gz', '.rar', '.7z',
  '.exe', '.dll', '.so', '.dylib', '.bin',
  '.pdf', // PDF handled separately (optional F7)
  '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', // Office files
]);

// ========== 主提取函数 ==========

export interface ExtractResult {
  text: string;
  error?: string;
}

export async function extractText(source: NotebookSource): Promise<ExtractResult> {
  switch (source.type) {
    case 'text':
      return extractFromText(source);
    case 'file':
      return extractFromFile(source);
    case 'url':
      return extractFromUrl(source);
    default:
      return { text: '', error: `Unsupported source type: ${source.type}` };
  }
}

// ========== 文本来源 ==========

function extractFromText(source: NotebookSource): ExtractResult {
  if (!source.content) {
    return { text: '', error: 'No text content provided' };
  }
  return { text: source.content };
}

// ========== 文件来源 ==========

async function extractFromFile(source: NotebookSource): Promise<ExtractResult> {
  if (!source.filePath) {
    return { text: '', error: 'No file path provided' };
  }

  const ext = getExtension(source.filePath).toLowerCase();

  // Check if PDF — handled by dedicated PDF extractor
  if (isPdfFile(source.filePath)) {
    return await extractFromPdf(source);
  }

  // Check if binary
  if (BINARY_EXTENSIONS.has(ext) && ext !== '.pdf') {
    return { text: '', error: `Binary file type '${ext}' is not supported. Please use text-based files.` };
  }

  // Check if text-based
  if (!TEXT_EXTENSIONS.has(ext) && ext !== '.pdf' && ext !== '') {
    // Try to read anyway for unknown extensions
    console.warn(`[Extractor] Unknown extension '${ext}', attempting text read`);
  }

  // Read via Tauri file API
  try {
    const isTauri = !!(window as any).__TAURI__;
    if (!isTauri) {
      return { text: '', error: 'File reading requires Tauri environment' };
    }

    const { invoke } = (window as any).__TAURI__.core;
    const content: string = await invoke('read_file', {
      path: source.filePath,
      encoding: 'utf-8',
    });

    if (!content || content.trim().length === 0) {
      return { text: '', error: 'File is empty or contains no readable text' };
    }

    return { text: content };
  } catch (e) {
    return { text: '', error: `Failed to read file: ${e instanceof Error ? e.message : String(e)}` };
  }
}

// ========== URL 来源 ==========

export async function extractFromUrl(source: NotebookSource): Promise<ExtractResult> {
  if (!source.url) {
    return { text: '', error: 'No URL provided' };
  }

  try {
    const isTauri = !!(window as any).__TAURI__;
    if (!isTauri) {
      // Fallback: try fetch directly (may fail due to CORS in browser)
      const resp = await fetch(source.url);
      const html = await resp.text();
      const text = stripHtml(html);
      return { text };
    }

    // Use Rust HTTP proxy to bypass CSP
    const { invoke } = (window as any).__TAURI__.core;
    const result: string = await invoke('http_get', { url: source.url });

    // Parse JSON response from Rust proxy
    let html: string;
    try {
      const parsed = JSON.parse(result);
      html = parsed.body || parsed.text || result;
    } catch {
      html = result;
    }

    const text = stripHtml(html);
    if (!text || text.trim().length === 0) {
      return { text: '', error: 'URL content is empty after extraction' };
    }

    return { text };
  } catch (e) {
    return { text: '', error: `Failed to fetch URL: ${e instanceof Error ? e.message : String(e)}` };
  }
}

// ========== HTML → 纯文本 ==========

export function stripHtml(html: string): string {
  // Remove script and style elements
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '');

  // Convert common block elements to newlines
  text = text
    .replace(/<\/?(p|div|section|article|main|aside|figure|blockquote|pre|li|tr|table|h[1-6])[^>]*>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<hr\s*\/?>/gi, '\n---\n');

  // Remove all remaining tags
  text = text.replace(/<[^>]+>/g, '');

  // Decode HTML entities
  text = decodeHtmlEntities(text);

  // Clean up whitespace
  text = text
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .filter((line, _i, arr) => {
      // Remove duplicate consecutive empty lines
      return line.length > 0 || (arr[_i - 1] && arr[_i - 1].length > 0);
    })
    .join('\n')
    .trim();

  return text;
}

function decodeHtmlEntities(text: string): string {
  const entities: Record<string, string> = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'",
    '&apos;': "'",
    '&nbsp;': ' ',
    '&copy;': '©',
    '&reg;': '®',
    '&trade;': '™',
    '&hellip;': '…',
    '&mdash;': '—',
    '&ndash;': '–',
    '&ldquo;': "“",
    '&rdquo;': "”",
    '&lsquo;': "‘",
    '&rsquo;': "’",
    '&laquo;': '«',
    '&raquo;': '»',
    '&deg;': '°',
    '&plusmn;': '±',
    '&times;': '×',
    '&divide;': '÷',
  };

  // Named entities
  let result = text.replace(/&[a-zA-Z]+;/g, (match) => entities[match] || match);

  // Numeric entities (decimal)
  result = result.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)));

  // Numeric entities (hex)
  result = result.replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCharCode(parseInt(code, 16)));

  return result;
}

// ========== PDF 提取 ==========

async function extractFromPdf(source: NotebookSource): Promise<ExtractResult> {
  try {
    const isTauri = !!(window as any).__TAURI__;
    if (!isTauri) {
      return { text: '', error: 'PDF reading requires Tauri environment' };
    }

    const { invoke } = (window as any).__TAURI__.core;
    // Read file as binary (base64)
    const base64: string = await invoke('read_file', {
      path: source.filePath,
      encoding: 'base64',
    });

    if (!base64 || base64.length < 100) {
      return { text: '', error: 'PDF file is empty or unreadable' };
    }

    // Convert base64 to Uint8Array
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }

    const text = await extractPdfText(bytes);
    return { text };
  } catch (e) {
    return { text: '', error: `Failed to extract PDF text: ${e instanceof Error ? e.message : String(e)}` };
  }
}

// ========== Utils ==========

function getExtension(filename: string): string {
  const idx = filename.lastIndexOf('.');
  return idx >= 0 ? filename.slice(idx) : '';
}
