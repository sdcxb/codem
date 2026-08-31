/**
 * generate_ppt 工具 — LLM 在笔记本对话中调用 PPT 生成功能
 *
 * 当用户在笔记本对话中说 "帮我生成一个 PPT" / "做个演示文稿" 时，
 * LLM 可调用此工具，从知识库内容自动生成 PPT 并保存为笔记。
 *
 * 对标 NotebookLM 的 Studio 生成功能，但在对话流中触发。
 */

import type { ToolDef, ToolContext, ToolExecuteResult } from '../tools';
import { generatePPTContent, serializeSlideDeck } from '../../knowledge/ppt-generator';
import { createNote, getNotebook, getChunks, listSources } from '../../knowledge/storage';
import { syncNoteLinks } from '../../knowledge/note-manager';

export function createGeneratePPTTool(): ToolDef {
  return {
    id: 'generate_ppt',
    guidance:
      'Use generate_ppt to create a presentation (PPT) from the notebook\'s knowledge base content. ' +
      'Use this when the user asks to "make a presentation", "create slides", "生成PPT", "做个演示文稿", etc. ' +
      'The tool generates structured slides with AI and saves them as a note in the notebook.',
    description:
      'Generate a presentation (PPT) from the notebook knowledge base. ' +
      'Creates AI-generated slides based on indexed sources and saves as a PPT note. ' +
      'Options: slide_count (default 8), style (business-blue/business-dark/business-navy/business-charcoal/business-gold/academic-clean/academic-paper/academic-serif/minimal-white/minimal-gray/minimal-black/minimal-swiss/creative-coral/creative-mint/creative-sunset/creative-purple/creative-bauhaus/dark-cyber/dark-midnight/dark-obsidian/dark-terminal/playful-candy/playful-lego/playful-cartoon/tech-blue/tech-grid/tech-holographic/tech-data/chinese-ink/chinese-red/chinese-bamboo/chinese-porcelain), ' +
      'canvas_size (16:9, 4:3, 9:16, 1:1, etc.), topic (optional focus area), ' +
      'source_names (optional array of source names to use specific sources only). ' +
      'The system prompt contains a source list with names — use those exact names.',
    parameters: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          description: 'Optional topic or theme for the presentation (e.g. "市场分析", "项目总结")',
        },
        slide_count: {
          type: 'number',
          description: 'Number of slides to generate (default: 8, range: 3-20)',
          default: 8,
        },
        style: {
          type: 'string',
          description: 'Visual style ID. Options: business-blue, business-dark, business-navy, business-charcoal, business-gold, academic-clean, minimal-white, minimal-black, creative-coral, creative-purple, dark-cyber, dark-midnight, playful-candy, tech-blue, tech-grid, chinese-ink, chinese-red, etc. Default: business-blue',
          default: 'business-blue',
        },
        canvas_size: {
          type: 'string',
          description: 'Canvas aspect ratio. Options: "16:9" (widescreen), "4:3" (standard), "9:16" (portrait/mobile), "1:1" (square), "2:3" (xiaohongshu). Default: "16:9"',
          default: '16:9',
        },
        title: {
          type: 'string',
          description: 'Custom title for the presentation. If not provided, AI will generate one.',
        },
        source_names: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional: list of source names to use for PPT generation. ' +
            'Use exact names from the source list in the system prompt. ' +
            'If not provided, all indexed sources will be used.',
        },
      },
      required: [],
    },
    async execute(
      args: Record<string, unknown>,
      ctx: ToolContext,
    ): Promise<ToolExecuteResult> {
      const notebookId = ctx.notebookId;
      if (!notebookId) {
        return {
          title: 'Generate PPT',
          output: 'Error: No active notebook. This tool only works in notebook mode.',
        };
      }

      const notebook = getNotebook(notebookId);
      if (!notebook) {
        return {
          title: 'Generate PPT',
          output: `Error: Notebook not found (id: ${notebookId})`,
        };
      }

      // 检查是否有知识库内容
      const chunks = getChunks(notebookId);
      if (chunks.length === 0) {
        return {
          title: 'Generate PPT',
          output: 'Error: No indexed content available. Please add sources to the notebook first.',
        };
      }

      const topic = args.topic as string | undefined;
      const slideCount = Math.max(3, Math.min(20, (args.slide_count as number) || 8));
      const styleId = (args.style as string) || 'business-blue';
      const canvasSizeId = (args.canvas_size as string) || '16:9';
      const customTitle = (args.title as string) || undefined;
      const sourceNames = args.source_names as string[] | undefined;

      // Resolve source_names → sourceIds
      let sourceIds: string[] | undefined;
      if (sourceNames && sourceNames.length > 0) {
        const allSources = listSources(notebookId);
        const matched = allSources.filter(s => sourceNames.includes(s.name));
        if (matched.length === 0) {
          const available = allSources.map(s => s.name).join(', ');
          return {
            title: 'Generate PPT',
            output: `Error: No matching sources found for names: ${sourceNames.join(', ')}.
Available sources: ${available}`,
          };
        }
        sourceIds = matched.map(s => s.id);
      }

      try {
        ctx.metadata({ title: 'Generating PPT...', metadata: { stage: 'loading' } });

        const deck = await generatePPTContent(
          notebookId,
          topic,
          slideCount,
          styleId,
          canvasSizeId,
          false, // enableImages
          sourceIds,
          (stage, detail) => {
            ctx.metadata({ title: `PPT: ${detail || stage}`, metadata: { stage } });
          },
        );

        if (customTitle) deck.title = customTitle;

        // 序列化并保存为笔记
        const content = serializeSlideDeck(deck);
        const note = createNote({
          notebookId,
          title: deck.title,
          content,
          contentType: 'ppt' as any,
        });

        syncNoteLinks(note.id, notebookId, content);

        // 从 PPT_STYLES 查找风格名称
        const { PPT_STYLES } = await import('../../knowledge/ppt-styles');
        const matchedStyle = PPT_STYLES.find(s => s.id === styleId);
        const styleName = matchedStyle?.name || styleId;

        return {
          title: `PPT Generated: ${deck.title}`,
          output:
            `Successfully generated a ${slideCount}-slide presentation "${deck.title}" ` +
            `in ${styleName} style (${canvasSizeId}).` +
            (sourceIds ? `\nSources used: ${sourceIds.length} of ${getChunks(notebookId).length} chunks from selected sources.` : '\nSources used: all indexed sources.') +
            `\n\nThe presentation has been saved as a note in notebook "${notebook.name}" and is visible in the Notes panel.\n` +
            `Note ID: ${note.id}\n\n` +
            `The user can click the note to open the PPT editor for further editing.`,
          metadata: { noteId: note.id, notebookId, slideCount: deck.slides.length, title: deck.title, sourceIds },
        };
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        return {
          title: 'Generate PPT',
          output: `Error generating PPT: ${errMsg}`,
        };
      }
    },
  };
}
