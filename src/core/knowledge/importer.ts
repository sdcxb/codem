/**
 * 笔记本导入器 — 从导出的 Markdown 重建笔记本结构
 *
 * 对标 NotebookLM 的笔记本导入功能
 * 自研实现: 解析 exportNotebookAsMarkdown 导出的 Markdown 格式，
 * 重建笔记本、来源和笔记的完整结构
 */

import {
  createNotebook,
  addSource,
  createNote,
} from './storage';
import { indexSource } from './indexer';
import type { SourceType, NoteContentType } from './types';

/**
 * 导入结果
 */
export interface ImportResult {
  notebookId: string;
  sourcesCreated: number;
  notesCreated: number;
  errors: string[];
}

/**
 * 从 Markdown 文本导入笔记本
 *
 * 解析格式 (与 exporter.ts 的 exportNotebookAsMarkdown 对应):
 * # 笔记本名称
 * > 描述
 * --- 
 * ## 📋 摘要 (可选)
 * ---
 * ## 📎 来源
 * ### 来源名称
 * - **类型**: file/text/url
 * - **状态**: indexed
 * - **分块数**: N
 * - **摘要**: ...
 * - **话题**: `tag1`, `tag2`
 * ---
 * ## 📝 笔记
 * ### 📝/📊 笔记标题
 * *时间戳*
 * 内容...
 */
export async function importNotebookFromMarkdown(markdown: string): Promise<ImportResult> {
  const errors: string[] = [];
  let sourcesCreated = 0;
  let notesCreated = 0;

  // Parse notebook name (first H1)
  const titleMatch = markdown.match(/^#\s+(.+)$/m);
  const notebookName = titleMatch ? titleMatch[1].trim() : 'Imported Notebook';

  // Parse description (blockquote after title)
  const descMatch = markdown.match(/^>\s+(.+)$/m);
  const description = descMatch ? descMatch[1].trim() : undefined;

  // Create notebook
  const notebook = createNotebook({ name: notebookName, description });

  // Split into sections by ## headers
  const sections = splitSections(markdown);

  for (const section of sections) {
    if (section.header.includes('来源') || section.header.includes('📎')) {
      // Parse sources section
      const sourceBlocks = splitByHeading(section.body, 3); // ### level
      for (const srcBlock of sourceBlocks) {
        try {
          const src = parseSourceBlock(srcBlock, notebook.id);
          if (src) {
            await indexSource(src, () => {});
            sourcesCreated++;
          }
        } catch (e) {
          errors.push(`Source import failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    } else if (section.header.includes('笔记') || section.header.includes('📝')) {
      // Parse notes section
      const noteBlocks = splitByHeading(section.body, 3); // ### level
      for (const noteBlock of noteBlocks) {
        try {
          const note = parseNoteBlock(noteBlock, notebook.id);
          if (note) {
            notesCreated++;
          }
        } catch (e) {
          errors.push(`Note import failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
  }

  return {
    notebookId: notebook.id,
    sourcesCreated,
    notesCreated,
    errors,
  };
}

/** Split markdown by ## headers */
function splitSections(md: string): { header: string; body: string }[] {
  const lines = md.split('\n');
  const sections: { header: string; body: string }[] = [];
  let currentHeader = '';
  let currentBody: string[] = [];

  for (const line of lines) {
    if (line.startsWith('## ')) {
      if (currentHeader || currentBody.length > 0) {
        sections.push({ header: currentHeader, body: currentBody.join('\n') });
      }
      currentHeader = line.replace(/^##\s+/, '');
      currentBody = [];
    } else if (line.startsWith('# ') && !currentHeader) {
      // Skip H1 (notebook title)
      continue;
    } else {
      currentBody.push(line);
    }
  }
  if (currentHeader || currentBody.length > 0) {
    sections.push({ header: currentHeader, body: currentBody.join('\n') });
  }

  return sections;
}

/** Split body by heading of given level (e.g., ### = level 3) */
function splitByHeading(body: string, level: number): string[] {
  const prefix = '#'.repeat(level) + ' ';
  const lines = body.split('\n');
  const blocks: string[] = [];
  let current: string[] = [];

  for (const line of lines) {
    if (line.startsWith(prefix)) {
      if (current.length > 0) {
        blocks.push(current.join('\n'));
      }
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) {
    blocks.push(current.join('\n'));
  }

  return blocks.filter(b => b.trim());
}

/** Parse a ### source block */
function parseSourceBlock(block: string, notebookId: string) {
  const lines = block.split('\n');
  const titleLine = lines[0] || '';
  const name = titleLine.replace(/^###\s+/, '').trim();
  if (!name) return null;

  let type: SourceType = 'text';
  let content: string | undefined;
  let summary: string | undefined;

  for (const line of lines.slice(1)) {
    const typeMatch = line.match(/\*\*类型\*\*:\s*(\w+)/);
    if (typeMatch) {
      const t = typeMatch[1].toLowerCase();
      if (t === 'file' || t === 'url' || t === 'text') type = t;
    }
    const summaryMatch = line.match(/\*\*摘要\*\*:\s*(.+)/);
    if (summaryMatch) {
      summary = summaryMatch[1].trim();
    }
  }

  // Use summary as content if available, otherwise use a placeholder
  content = summary || `Imported source: ${name}`;

  return addSource({
    notebookId,
    name,
    type,
    content,
  });
}

/** Parse a ### note block */
function parseNoteBlock(block: string, notebookId: string) {
  const lines = block.split('\n');
  const titleLine = lines[0] || '';

  // Check for emoji prefix (📝 or 📊)
  const isPPT = titleLine.includes('📊');
  const title = titleLine.replace(/^###\s+/, '').replace(/^[📝📊]\s*/, '').trim();
  if (!title) return null;

  // Skip timestamp line (*date*)
  let contentStartIdx = 1;
  if (lines[1] && lines[1].trim().startsWith('*')) {
    contentStartIdx = 2;
  }

  // Skip empty lines
  while (contentStartIdx < lines.length && !lines[contentStartIdx].trim()) {
    contentStartIdx++;
  }

  const content = lines.slice(contentStartIdx).join('\n').trim();
  const contentType: NoteContentType = isPPT ? 'ppt' : 'markdown';

  return createNote({
    notebookId,
    title,
    content: content === '(空)' ? '' : content,
    contentType,
  });
}

/**
 * 从文件读取 Markdown 并导入
 * 通过 Tauri 的 read_file 命令读取文件内容
 */
export async function importNotebookFromFile(filePath: string): Promise<ImportResult> {
  const isTauri = !!(window as any).__TAURI__;
  if (!isTauri) {
    throw new Error('File import requires Tauri runtime');
  }

  const { invoke } = (window as any).__TAURI__.core;
  const content: string = await invoke('read_file', { path: filePath, encoding: 'utf-8' });

  return importNotebookFromMarkdown(content);
}
