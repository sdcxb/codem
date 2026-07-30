/**
 * 笔记操作工具 — AI 在笔记本模式下创建、编辑、链接、删除笔记
 *
 * 对标 NotebookLM 的 AI 笔记操作能力
 * 自研实现: 提供四个工具供 LLM 调用
 * 1. create_note — 创建新笔记
 * 2. edit_note — 编辑现有笔记内容
 * 3. link_notes — 在两个笔记之间创建链接
 * 4. delete_note — 删除笔记
 *
 * 借鉴思路: NotebookLM 的 "Save to note" 和笔记管理功能
 */

import type { ToolDef, ToolContext, ToolExecuteResult } from '../tools';
import {
  createNote, updateNote, getNote, listNotes, addNoteLink, deleteNote,
} from '../../knowledge/storage';
import { syncNoteLinks } from '../../knowledge/note-manager';
import { getNotebook } from '../../knowledge/storage';

/** 创建笔记工具 */
export function createCreateNoteTool(): ToolDef {
  return {
    id: 'create_note',
    description:
      'Create a new note in the current notebook. Use this when the user asks to save information as a note, ' +
      'or when you want to persist important findings, summaries, or insights as a note. ' +
      'The note content should be in Markdown format.',
    parameters: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'The title of the note',
        },
        content: {
          type: 'string',
          description: 'The note content in Markdown format',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional tags for the note',
        },
      },
      required: ['title', 'content'],
    },
    async execute(
      args: Record<string, unknown>,
      ctx: ToolContext,
    ): Promise<ToolExecuteResult> {
      const title = args.title as string;
      const content = args.content as string;
      const tags = args.tags as string[] | undefined;

      if (!title || !content) {
        return {
          title: 'Create Note',
          output: 'Error: Both title and content are required',
        };
      }

      const notebookId = (ctx as any).notebookId as string | undefined;
      if (!notebookId) {
        return {
          title: 'Create Note',
          output: 'Error: No active notebook',
        };
      }

      const notebook = getNotebook(notebookId);
      if (!notebook) {
        return {
          title: 'Create Note',
          output: `Error: Notebook not found (id: ${notebookId})`,
        };
      }

      try {
        const note = createNote({
          notebookId,
          title,
          content,
          contentType: 'markdown',
          tags: tags ?? undefined,
        });

        // Sync WikiLinks
        syncNoteLinks(note.id, notebookId, content);

        return {
          title: `Note Created: ${title}`,
          output: `Successfully created note "${title}" (id: ${note.id}) in notebook "${notebook.name}".\n\nThe note has been saved and is visible in the Notes panel.`,
          metadata: { noteId: note.id, notebookId },
        };
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        return {
          title: 'Create Note',
          output: `Error creating note: ${errMsg}`,
        };
      }
    },
  };
}

/** 编辑笔记工具 */
export function createEditNoteTool(): ToolDef {
  return {
    id: 'edit_note',
    description:
      'Edit an existing note in the current notebook. You can update the title, content, or tags. ' +
      'Use this when the user asks to modify a note, or when you want to update a note with new information.',
    parameters: {
      type: 'object',
      properties: {
        note_id: {
          type: 'string',
          description: 'The ID of the note to edit',
        },
        title: {
          type: 'string',
          description: 'New title for the note (optional, keep existing if not provided)',
        },
        content: {
          type: 'string',
          description: 'New content for the note in Markdown format (optional, keep existing if not provided)',
        },
        append: {
          type: 'boolean',
          description: 'If true, append the content to the existing note instead of replacing it (default: false)',
          default: false,
        },
      },
      required: ['note_id'],
    },
    async execute(
      args: Record<string, unknown>,
      ctx: ToolContext,
    ): Promise<ToolExecuteResult> {
      const noteId = args.note_id as string;
      const newTitle = args.title as string | undefined;
      let newContent = args.content as string | undefined;
      const append = (args.append as boolean) || false;

      if (!noteId) {
        return {
          title: 'Edit Note',
          output: 'Error: note_id is required',
        };
      }

      const notebookId = (ctx as any).notebookId as string | undefined;
      if (!notebookId) {
        return {
          title: 'Edit Note',
          output: 'Error: No active notebook',
        };
      }

      const existingNote = getNote(noteId);
      if (!existingNote) {
        return {
          title: 'Edit Note',
          output: `Error: Note not found (id: ${noteId})`,
        };
      }

      try {
        const update: { title?: string; content?: string } = {};
        if (newTitle) update.title = newTitle;

        if (newContent) {
          if (append) {
            update.content = existingNote.content + '\n\n' + newContent;
          } else {
            update.content = newContent;
          }
        }

        updateNote(noteId, update);

        // Re-sync WikiLinks if content changed
        if (update.content) {
          syncNoteLinks(noteId, notebookId, update.content);
        }

        return {
          title: `Note Updated: ${update.title || existingNote.title}`,
          output: `Successfully updated note "${existingNote.title}" (id: ${noteId}).\nChanges: ${[
            update.title ? 'title' : null,
            update.content ? (append ? 'content (appended)' : 'content (replaced)') : null,
          ].filter(Boolean).join(', ') || 'no changes'}`,
          metadata: { noteId, notebookId },
        };
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        return {
          title: 'Edit Note',
          output: `Error editing note: ${errMsg}`,
        };
      }
    },
  };
}

/** 链接笔记工具 */
export function createLinkNotesTool(): ToolDef {
  return {
    id: 'link_notes',
    description:
      'Create a link between two notes in the current notebook. ' +
      'Use this to establish bidirectional relationships between related notes. ' +
      'The link will appear in both notes\' backlinks panels.',
    parameters: {
      type: 'object',
      properties: {
        source_note_id: {
          type: 'string',
          description: 'The ID of the source note (the note that links to the target)',
        },
        target_note_id: {
          type: 'string',
          description: 'The ID of the target note (the note being linked to)',
        },
        link_text: {
          type: 'string',
          description: 'Optional display text for the link',
        },
      },
      required: ['source_note_id', 'target_note_id'],
    },
    async execute(
      args: Record<string, unknown>,
      ctx: ToolContext,
    ): Promise<ToolExecuteResult> {
      const sourceNoteId = args.source_note_id as string;
      const targetNoteId = args.target_note_id as string;
      const linkText = args.link_text as string | undefined;

      if (!sourceNoteId || !targetNoteId) {
        return {
          title: 'Link Notes',
          output: 'Error: Both source_note_id and target_note_id are required',
        };
      }

      if (sourceNoteId === targetNoteId) {
        return {
          title: 'Link Notes',
          output: 'Error: Cannot link a note to itself',
        };
      }

      const sourceNote = getNote(sourceNoteId);
      const targetNote = getNote(targetNoteId);

      if (!sourceNote) {
        return {
          title: 'Link Notes',
          output: `Error: Source note not found (id: ${sourceNoteId})`,
        };
      }

      if (!targetNote) {
        return {
          title: 'Link Notes',
          output: `Error: Target note not found (id: ${targetNoteId})`,
        };
      }

      try {
        addNoteLink(sourceNoteId, targetNoteId, linkText);

        return {
          title: `Notes Linked: ${sourceNote.title} → ${targetNote.title}`,
          output: `Successfully created link:\n  Source: "${sourceNote.title}" (id: ${sourceNoteId})\n  Target: "${targetNote.title}" (id: ${targetNoteId})\n  Display text: ${linkText || targetNote.title}\n\nThe link is now visible in both notes' backlinks panels.`,
          metadata: { sourceNoteId, targetNoteId },
        };
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        return {
          title: 'Link Notes',
          output: `Error linking notes: ${errMsg}`,
        };
      }
    },
  };
}

/** 删除笔记工具 */
export function createDeleteNoteTool(): ToolDef {
  return {
    id: 'delete_note',
    description:
      'Delete an existing note in the current notebook. Use this when the user asks to remove a note, ' +
      'or when a note is outdated, incorrect, or no longer needed. This action cannot be undone.',
    parameters: {
      type: 'object',
      properties: {
        note_id: {
          type: 'string',
          description: 'The ID of the note to delete',
        },
      },
      required: ['note_id'],
    },
    async execute(
      args: Record<string, unknown>,
      ctx: ToolContext,
    ): Promise<ToolExecuteResult> {
      const noteId = args.note_id as string;

      if (!noteId) {
        return {
          title: 'Delete Note',
          output: 'Error: note_id is required',
        };
      }

      // Get notebook ID from context
      const notebookId = (ctx as any).notebookId as string | undefined;
      if (!notebookId) {
        return {
          title: 'Delete Note',
          output: 'Error: No active notebook. This tool only works in notebook mode.',
        };
      }

      const note = getNote(noteId);

      if (!note) {
        return {
          title: 'Delete Note',
          output: `Error: Note not found (id: ${noteId})`,
        };
      }

      try {
        // Clean up links before deleting — syncNoteLinks with empty content removes all outgoing links
        syncNoteLinks(noteId, notebookId, '');
        deleteNote(noteId);

        return {
          title: `Note Deleted: ${note.title}`,
          output: `Successfully deleted note "${note.title}" (id: ${noteId}).\n\nThe note and all its backlinks have been removed.`,
          metadata: { deletedNoteId: noteId, notebookId },
        };
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        return {
          title: 'Delete Note',
          output: `Error deleting note: ${errMsg}`,
        };
      }
    },
  };
}

/** 注册所有笔记操作工具 */
export function createNoteOperationTools(): ToolDef[] {
  return [
    createCreateNoteTool(),
    createEditNoteTool(),
    createLinkNotesTool(),
    createDeleteNoteTool(),
  ];
}
