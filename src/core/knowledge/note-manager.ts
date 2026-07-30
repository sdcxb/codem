/**
 * 笔记链接管理器 — WikiLinks 解析与双向链接同步
 *
 * 借鉴思路来源: Lumina Note (https://github.com/blueberrycongee/lumina-note)
 * 该项目使用 CodeMirror 插件解析 [[wiki links]] 并建立双向链接;
 * 我们自研实现: 正则解析 + SQLite note_links 表同步, 不依赖 CodeMirror 插件
 *
 * 核心功能:
 * 1. 从笔记内容中解析 [[笔记标题]] 和 [[笔记标题|显示文本]] 语法
 * 2. 保存笔记时自动同步双向链接关系到 SQLite
 * 3. 提供按标题查找笔记的能力
 */

import {
  listNotes,
  addNoteLink,
  getBacklinks,
  getNoteLinks,
} from './storage';
import type { Note, NoteLink } from './types';

/** WikiLinks 正则: 匹配 [[标题]] 或 [[标题|显示文本]] */
const WIKILINK_REGEX = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

/** WikiLink 提取结果 */
export interface ParsedWikiLink {
  /** 原始匹配文本, 如 [[笔记A]] */
  raw: string;
  /** 链接目标标题 */
  target: string;
  /** 显示文本 (可选, 等于 target 如果未指定) */
  display: string;
  /** 在原文中的起始位置 */
  index: number;
}

/**
 * 从笔记内容中解析所有 WikiLinks
 *
 * 支持两种语法:
 * - [[笔记标题]]        → display = 笔记标题
 * - [[笔记标题|显示文本]] → display = 显示文本
 */
export function parseWikiLinks(content: string): ParsedWikiLink[] {
  const links: ParsedWikiLink[] = [];
  let match: RegExpExecArray | null;

  // 重置 regex 的 lastIndex (因为使用了 g flag)
  WIKILINK_REGEX.lastIndex = 0;

  while ((match = WIKILINK_REGEX.exec(content)) !== null) {
    links.push({
      raw: match[0],
      target: match[1].trim(),
      display: (match[2] || match[1]).trim(),
      index: match.index,
    });
  }

  return links;
}

/**
 * 将笔记内容中的 WikiLinks 替换为标准 Markdown 链接
 * 用于 Markdown 预览渲染 (react-markdown 不支持 [[ ]] 语法)
 *
 * [[笔记A]] → [笔记A](#note:笔记A)
 * [[笔记A|显示]] → [显示](#note:笔记A)
 */
export function wikilinksToMarkdown(content: string): string {
  WIKILINK_REGEX.lastIndex = 0;
  return content.replace(WIKILINK_REGEX, (fullMatch, target, display) => {
    const t = (target || '').trim();
    const d = (display || target || '').trim();
    return `[${d}](#note:${encodeURIComponent(t)})`;
  });
}

/**
 * 查找笔记本内标题匹配的笔记
 *
 * 模糊匹配策略:
 * 1. 精确匹配 (大小写敏感)
 * 2. 大小写不敏感匹配
 * 3. 包含匹配 (标题包含目标文本)
 */
export function findNoteByTitle(
  notebookId: string,
  title: string,
): Note | null {
  const notes = listNotes(notebookId);

  // 1. 精确匹配
  const exact = notes.find((n) => n.title === title);
  if (exact) return exact;

  // 2. 大小写不敏感
  const lowerTitle = title.toLowerCase();
  const caseInsensitive = notes.find(
    (n) => n.title.toLowerCase() === lowerTitle,
  );
  if (caseInsensitive) return caseInsensitive;

  // 3. 包含匹配
  const contains = notes.find(
    (n) => n.title.toLowerCase().includes(lowerTitle),
  );
  if (contains) return contains;

  return null;
}

/**
 * 同步笔记的双向链接关系
 *
 * 当笔记保存时调用:
 * 1. 删除该笔记的所有旧出链 (source_note_id = noteId)
 * 2. 解析新内容中的 WikiLinks
 * 3. 为每个匹配到的目标笔记创建新的 note_links 记录
 *
 * @returns 创建的链接数量
 */
export function syncNoteLinks(noteId: string, notebookId: string, content: string): number {
  // 删除旧的出链
  deleteNoteLinksBySource(noteId);

  // 解析新内容中的 WikiLinks
  const parsed = parseWikiLinks(content);
  if (parsed.length === 0) return 0;

  // 获取当前笔记本所有笔记 (用于批量匹配)
  const notes = listNotes(notebookId);
  const notesByLowerTitle = new Map<string, Note>();
  for (const note of notes) {
    if (note.id === noteId) continue; // 不链接到自己
    notesByLowerTitle.set(note.title.toLowerCase(), note);
  }

  let createdCount = 0;
  const linkedIds = new Set<string>(); // 去重

  for (const link of parsed) {
    const lowerTarget = link.target.toLowerCase();

    // 尝试精确匹配 (大小写不敏感)
    let targetNote = notesByLowerTitle.get(lowerTarget);

    // 尝试包含匹配
    if (!targetNote) {
      for (const [, note] of notesByLowerTitle) {
        if (note.title.toLowerCase().includes(lowerTarget)) {
          targetNote = note;
          break;
        }
      }
    }

    if (targetNote && !linkedIds.has(targetNote.id)) {
      addNoteLink(noteId, targetNote.id, link.display);
      linkedIds.add(targetNote.id);
      createdCount++;
    }
  }

  return createdCount;
}

/**
 * 获取笔记的所有出链 (当前笔记链接到的其他笔记)
 */
export function getOutgoingLinks(noteId: string): NoteLink[] {
  const links = getNoteLinks(noteId);
  // getNoteLinks 返回 source 或 target 的链接, 过滤出 source = noteId 的
  return links.filter((l) => l.sourceNoteId === noteId);
}

/**
 * 获取笔记的所有反向链接 (其他笔记链接到当前笔记)
 * 直接复用 storage 层的 getBacklinks
 */
export function getIncomingLinks(noteId: string): NoteLink[] {
  return getBacklinks(noteId);
}

/**
 * 删除指定笔记的所有出链
 *
 * 注意: SQLite 的 ON DELETE CASCADE 只在删除笔记行时触发,
 * 这里需要在更新笔记内容时手动清理旧链接
 */
function deleteNoteLinksBySource(noteId: string): void {
  // 使用动态导入避免循环依赖
  import('../storage/database').then(({ getDatabase, persistDatabase }) => {
    const db = getDatabase();
    db.run('DELETE FROM note_links WHERE source_note_id = ?', [noteId]);
    persistDatabase();
  });
}

/**
 * 获取笔记的链接统计信息
 */
export function getLinkStats(noteId: string): {
  outgoing: number;
  incoming: number;
} {
  return {
    outgoing: getOutgoingLinks(noteId).length,
    incoming: getIncomingLinks(noteId).length,
  };
}
