/**
 * search_notebook 工具 — LLM 在笔记本模式下主动检索知识库内容。
 *
 * 当笔记本模式下自动检索的上下文不够时，LLM 可调用此工具进行更精准的检索。
 */

import type { ToolDef, ToolContext, ToolExecuteResult } from "../tools";
import { retrieve } from "../../knowledge/retriever";
import { getNotebook } from "../../knowledge/storage";

export function createSearchNotebookTool(): ToolDef {
  return {
    id: "search_notebook",
    description:
      "Search the current knowledge notebook for relevant information using semantic search. " +
      "Use this when you need to find specific information from the notebook's sources to answer the user's question. " +
      "Returns the most relevant text segments with source citations.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The search query — what you want to find in the notebook knowledge base",
        },
        top_k: {
          type: "number",
          description: "Maximum number of results to return (default: 5)",
          default: 5,
        },
      },
      required: ["query"],
    },
    async execute(
      args: Record<string, unknown>,
      ctx: ToolContext,
    ): Promise<ToolExecuteResult> {
      const query = args.query as string;
      const topK = (args.top_k as number) || 5;

      if (!query) {
        return {
          title: "Search Notebook",
          output: "Error: No query provided",
        };
      }

      // Get notebook ID from context
      const notebookId = (ctx as any).notebookId as string | undefined;
      if (!notebookId) {
        return {
          title: "Search Notebook",
          output: "Error: No active notebook. This tool only works in notebook mode.",
        };
      }

      const notebook = getNotebook(notebookId);
      if (!notebook) {
        return {
          title: "Search Notebook",
          output: `Error: Notebook not found (id: ${notebookId})`,
        };
      }

      try {
        const results = await retrieve(query, notebookId, { topK });

        if (results.length === 0) {
          return {
            title: `Search: "${query}"`,
            output: `No relevant results found in notebook "${notebook.name}". The query may not match any indexed content.`,
          };
        }

        const formatted = results.map((r, i) => {
          return `--- Result ${i + 1} (score: ${r.score.toFixed(3)}) [Source: ${r.sourceName}] ---\n${r.content}`;
        });

        const output = `Found ${results.length} relevant segments in notebook "${notebook.name}":\n\n${formatted.join('\n\n')}`;

        return {
          title: `Search: "${query}"`,
          output,
        };
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        return {
          title: "Search Notebook",
          output: `Error searching notebook: ${errMsg}`,
        };
      }
    },
  };
}
