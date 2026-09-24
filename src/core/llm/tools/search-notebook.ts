/**
 * search_notebook 工具 — LLM 在笔记本模式下主动检索知识库内容。
 *
 * 当笔记本模式下自动检索的上下文不够时，LLM 可调用此工具进行更精准的检索。
 *
 * 重要改进: 引用标注改为结构化元数据驱动
 * - 工具返回结果中包含 sources 元数据（sourceId, sourceName, chunkIndex）
 * - 不依赖模型在回复文本中嵌入特定格式的引用标记
 * - 前端根据元数据自动渲染可点击的来源链接
 */

import type { ToolDef, ToolContext, ToolExecuteResult } from "../tools";
import { retrieve } from "../../knowledge/retriever";
import { getNotebook, ChunkIndexUnavailableError } from "../../knowledge/storage";

/** 检索结果中的来源元数据 */
interface CitationSource {
  index: number;       // 1-based 编号
  sourceId: string;
  sourceName: string;
  chunkIndex: number;
  snippet: string;     // 用于前端预览的摘要片段
}

export function createSearchNotebookTool(): ToolDef {
  return {
    id: "search_notebook",
    guidance: "Use search_notebook to search the current knowledge notebook for relevant information using semantic search. Use this when you need to find specific information from the notebook's sources.",
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
      const notebookId = ctx.notebookId;
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

        // 构建结构化来源元数据 — 前端用此渲染可点击引用，不依赖模型文本格式
        const sources: CitationSource[] = results.map((r, i) => ({
          index: i + 1,
          sourceId: r.sourceId,
          sourceName: r.sourceName,
          chunkIndex: r.chunkIndex,
          snippet: r.content.slice(0, 150).replace(/\n/g, ' ').trim(),
        }));

        // 工具输出文本中嵌入编号引用，便于模型参考
        // 格式: [1] sourceName — 内容...
        const formatted = results.map((r, i) => {
          return `[${i + 1}] ${r.sourceName} (score: ${r.score.toFixed(3)})\n${r.content}`;
        });

        const output = `Found ${results.length} relevant segments in notebook "${notebook.name}":\n\n${formatted.join('\n\n')}`;

        return {
          title: `Search: "${query}"`,
          output,
          // 结构化元数据 — 前端用于渲染可点击的来源引用面板
          metadata: {
            sources,
            query,
            notebookId,
            notebookName: notebook.name,
          },
        };
      } catch (error) {
        /**
         * 任务 C-3：**索引未就绪 ≠ 没有相关内容**。
         *
         * 块镜像被拒（全库块数超过 `CHUNK_MIRROR_MAX`）或尚未接手时，读不到块是
         * **本进程的**状态，不是笔记本的事实。原来的措辞（"No relevant results found"）
         * 会让模型据此断言"你的资料里没有这个"，而真相是"这次没读到，稍后重试"。
         * 所以这里给一句**明确的、可行动**的结论，并明说不要下"没有内容"的结论。
         */
        if (error instanceof ChunkIndexUnavailableError) {
          return {
            title: `Search: "${query}"`,
            output:
              `索引未就绪：笔记本 "${notebook.name}" 的文本块索引暂时读不到（${error.message}）。\n` +
              `这不代表笔记本里没有相关内容 —— 请稍后重试一次；如果连续多次如此，请告诉用户"知识库索引未就绪"，` +
              `不要让用户以为资料丢了。`,
          };
        }
        const errMsg = error instanceof Error ? error.message : String(error);
        return {
          title: "Search Notebook",
          output: `Error searching notebook: ${errMsg}`,
        };
      }
    },
  };
}
