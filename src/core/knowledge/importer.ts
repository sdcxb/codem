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
      //
      // 只在"这一节里确实有带记号的笔记块"时才按记号切块 —— 否则退回任何 `### ` 都算新笔记
      // （兼容手写文件）。细节与已知边界见 `NOTE_BLOCK_START` 的注释。
      const hasMarkedBlocks = section.body.split('\n').some(l => NOTE_BLOCK_START.test(l));
      const noteBlocks = splitByHeading(section.body, 3, hasMarkedBlocks ? NOTE_BLOCK_START : undefined); // ### level
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

/**
 * 小节标题的**白名单**判定。
 *
 * 第 98 轮修的一个数据丢失缺陷：原来"任何以 `## ` 开头的行"都算新小节，而笔记本的**笔记正文
 * 完全可以自带 `## 标题`**（用户手写的笔记经常有）。于是「导出 → 导入」时，正文里第一个 `## `
 * 之后的内容全部落进一个 header 不认识的小节，被静默丢掉（笔记只剩标题和时间戳）。
 *
 * 现在只有**认得出的小节**（摘要 / 来源 / 笔记，带 emoji 与否都认）才切小节；
 * 其它 `## ` 行留在当前小节正文里，按正文处理。
 */
function sectionHeaderOf(line: string): string | null {
  if (!line.startsWith('## ')) return null;
  const header = line.replace(/^##\s+/, '');
  const known =
    header.includes('来源') || header.includes('📎') ||
    header.includes('笔记') || header.includes('📝') ||
    header.includes('摘要') || header.includes('📋');
  return known ? header : null;
}

/** Split markdown by ## headers（只认白名单里的小节标题，见 `sectionHeaderOf`） */
function splitSections(md: string): { header: string; body: string }[] {
  const lines = md.split('\n');
  const sections: { header: string; body: string }[] = [];
  let currentHeader = '';
  let currentBody: string[] = [];

  for (const line of lines) {
    const header = sectionHeaderOf(line);
    if (header !== null) {
      if (currentHeader || currentBody.length > 0) {
        sections.push({ header: currentHeader, body: currentBody.join('\n') });
      }
      currentHeader = header;
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

/**
 * 笔记块的起头 —— 导出器**一定**写成 `### 📝 标题` / `### 📊 标题`。
 *
 * 第 98 轮修的第二个数据丢失缺陷：原来按"任何 `### `"切块，于是笔记正文里自带的
 * `### 小标题` 会把一条笔记切成两条（后半段还会被当成一条新笔记）。
 * 现在：小节里只要出现过带记号的笔记块，就**只认记号**切块（手写文件里没有记号时，
 * 退回"任何 `### ` 都算新笔记"的老行为，保持兼容）。
 *
 * 已知边界（如实写在代码里）：笔记正文里若出现一整行 `### 📝 xxx`，仍会被当成新笔记的开头 ——
 * 这一个歧义在纯 Markdown 语法下无法消除。
 */
const NOTE_BLOCK_START = /^###\s*(?:📝|📊)\s*/u;

/** Split body by heading of given level (e.g., ### = level 3) */
function splitByHeading(body: string, level: number, startRe?: RegExp): string[] {
  const prefix = '#'.repeat(level) + ' ';
  const lines = body.split('\n');
  const matches = startRe ? (line: string) => startRe.test(line) : (line: string) => line.startsWith(prefix);
  const blocks: string[] = [];
  let current: string[] = [];

  for (const line of lines) {
    if (matches(line)) {
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
  /*
   * ⚠️ 第 98 轮修的真缺陷：这里原来用一个**没有 `u` 标志**的字符类（把 📝 与 📊 写进 `[...]`）去剥前缀。
   * 无 `u` 的字符类按 UTF-16 **码元**匹配，而 📝/📊 都是代理对 ⇒ 它只吃掉高位代理、留下一个孤立
   * 低位代理，标题变成 `"\uDCDD 要点"`，界面/库里就是「一个替换字符（U+FFFD）+ 空格 + 要点」
   * （这里刻意**不写出那个替换字符本身**：源码里出现 U+FFFD 会被 UI 一致性门禁
   * 的 `encoding-replacement-char` 规则判成编码损坏 —— 那条规则本轮就是这么抓到我的）。
   *
   * 更坏的是它**只在导入路径上出现**：导出器印 `### 📝 标题`，导出后重新导入的每条笔记标题
   * 都带一个替换字符 —— 而"导出成功""导入成功"两个局部各自都看不出来。
   * 现在用 `(?:📝|📊)` 分组 + `u` 标志，整对匹配。
   */
  const title = titleLine.replace(/^###\s+/, '').replace(/^(?:📝|📊)\s*/u, '').trim();
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
