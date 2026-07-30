/**
 * 笔记本导出器 — 导出笔记本内容为 Markdown
 *
 * 对标 NotebookLM 的笔记本导出功能
 * 自研实现: 将笔记本的来源、笔记、生成内容合并为 Markdown 文件
 */

import { getNotebook, listSources, listNotes, getChunks } from './storage';
import type { Notebook, NotebookSource, Note } from './types';

/**
 * 导出整个笔记本为 Markdown 字符串
 *
 * 包含:
 * 1. 笔记本标题和摘要
 * 2. 所有来源列表 (名称 + 摘要)
 * 3. 所有笔记 (标题 + 内容)
 */
export function exportNotebookAsMarkdown(notebookId: string): string {
  const notebook = getNotebook(notebookId);
  if (!notebook) return '';

  const sources = listSources(notebookId);
  const notes = listNotes(notebookId);

  const lines: string[] = [];

  // Header
  lines.push(`# ${notebook.name}`);
  lines.push('');
  if (notebook.description) {
    lines.push(`> ${notebook.description}`);
    lines.push('');
  }

  // Metadata
  lines.push(`**${getSourceLabel(true)}**: ${sources.length} | **${getNotesLabel(true)}**: ${notes.length} | **${getChunksLabel(true)}**: ${notebook.chunkCount}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  // Summary
  if (notebook.summary) {
    lines.push('## 📋 摘要');
    lines.push('');
    lines.push(notebook.summary);
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  // Sources
  if (sources.length > 0) {
    lines.push('## 📎 来源');
    lines.push('');
    for (const source of sources) {
      lines.push(`### ${source.name}`);
      lines.push(`- **类型**: ${source.type}`);
      lines.push(`- **状态**: ${source.status}`);
      if (source.chunkCount > 0) lines.push(`- **分块数**: ${source.chunkCount}`);
      if (source.summary) {
        lines.push(`- **摘要**: ${source.summary}`);
      }
      if (source.keyTopics && source.keyTopics.length > 0) {
        lines.push(`- **话题**: ${source.keyTopics.map(t => `\`${t}\``).join(', ')}`);
      }
      lines.push('');
    }
    lines.push('---');
    lines.push('');
  }

  // Notes
  if (notes.length > 0) {
    lines.push('## 📝 笔记');
    lines.push('');
    for (const note of notes) {
      const isPPT = note.contentType === 'ppt';
      lines.push(`### ${isPPT ? '📊' : '📝'} ${note.title}`);
      lines.push(`*${new Date(note.updatedAt).toLocaleString()}*`);
      lines.push('');
      if (isPPT) {
        lines.push('> PPT 演示文稿内容 (请在应用内查看)');
      } else {
        lines.push(note.content || '(空)');
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

/**
 * 导出单个笔记为 Markdown
 */
export function exportNoteAsMarkdown(note: Note): string {
  const lines: string[] = [];
  lines.push(`# ${note.title}`);
  lines.push('');
  lines.push(`*${new Date(note.updatedAt).toLocaleString()}*`);
  lines.push('');
  lines.push(note.content || '(空)');
  return lines.join('\n');
}

/**
 * 触发浏览器下载 Markdown 文件
 */
export function downloadMarkdown(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.endsWith('.md') ? filename : `${filename}.md`;
  a.click();
  URL.revokeObjectURL(url);
}

function getSourceLabel(isZh: boolean): string {
  return isZh ? '来源' : 'Sources';
}
function getNotesLabel(isZh: boolean): string {
  return isZh ? '笔记' : 'Notes';
}
function getChunksLabel(isZh: boolean): string {
  return isZh ? '分块' : 'Chunks';
}
