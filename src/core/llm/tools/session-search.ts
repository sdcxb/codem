/**
 * session_search 工具 — 历史会话全文搜索
 *
 * Design (对标 DeepSeek Harness session_query):
 * - 使用 SQLite FTS5 全文搜索引擎
 * - 支持跨会话搜索历史消息
 * - 返回匹配的消息片段和相关会话信息
 *
 * FTS5 表在 database.ts 中定义:
 *   CREATE VIRTUAL TABLE session_fts USING fts5(
 *     session_id, message_id, content, role, timestamp, tokenize = 'unicode61'
 *   );
 *
 * 消息在 message.ts createMessage() 中自动索引到 FTS5 表。
 */

import type { ToolDef, ToolContext, ToolExecuteResult } from "../tools";

export interface SessionSearchResult {
  sessionId: string;
  messageId: string;
  role: string;
  content: string;
  timestamp: number;
  /** FTS5 snippet with highlighted matches */
  snippet: string;
  /** Session title (looked up from sessions table) */
  sessionTitle?: string;
}

export function createSessionSearchTool(): ToolDef {
  return {
    id: "session_search",
    description: `Search across all conversation history using full-text search.

Use this tool to find previous discussions, solutions, or context from past sessions.
Supports FTS5 query syntax:
- Simple words: "authentication"
- Phrases: "\"session recovery\""
- Boolean: "auth AND token"
- Prefix: "data*"
- Near: "error NEAR/5 handling"

Returns matching messages with snippets showing the matched content.`,
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "FTS5 full-text search query. Use quotes for phrases, * for prefix matching.",
        },
        limit: {
          type: "number",
          description: "Maximum results to return (default: 10, max: 50)",
        },
        session_id: {
          type: "string",
          description: "Optional: restrict search to a specific session",
        },
      },
      required: ["query"],
    },
    async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolExecuteResult> {
      const query = args.query as string;
      const limit = Math.min(args.limit as number || 10, 50);
      const sessionIdFilter = args.session_id as string | undefined;

      if (!query || query.trim().length === 0) {
        return {
          title: "session_search",
          output: "Error: query parameter is required and must not be empty.",
        };
      }

      try {
        const { getDatabase } = await import("../../storage/database");

        // Build FTS5 query
        // Sanitize: escape double quotes, wrap in quotes for safety
        const sanitizedQuery = query.replace(/"/g, '""');

        // Build the FTS5 MATCH query
        let matchExpr = `"${sanitizedQuery}"`;
        if (sessionIdFilter) {
          matchExpr = `content MATCH '${sanitizedQuery}' AND session_id = '${sessionIdFilter.replace(/'/g, "''")}'`;
        }

        // Execute FTS5 search with snippet generation
        const db = getDatabase();
        const sql = sessionIdFilter
          ? `SELECT s.session_id, s.message_id, s.role, s.timestamp,
                    snippet(session_fts, 2, '[', ']', '...', 10) as snippet,
                    m.content as full_content,
                    sess.title as session_title
             FROM session_fts s
             LEFT JOIN messages m ON s.message_id = m.id
             LEFT JOIN sessions sess ON s.session_id = sess.id
             WHERE s.content MATCH ?
             AND s.session_id = ?
             ORDER BY s.timestamp DESC
             LIMIT ?`
          : `SELECT s.session_id, s.message_id, s.role, s.timestamp,
                    snippet(session_fts, 2, '[', ']', '...', 10) as snippet,
                    m.content as full_content,
                    sess.title as session_title
             FROM session_fts s
             LEFT JOIN messages m ON s.message_id = m.id
             LEFT JOIN sessions sess ON s.session_id = sess.id
             WHERE s.content MATCH ?
             ORDER BY s.timestamp DESC
             LIMIT ?`;

        const params = sessionIdFilter
          ? [sanitizedQuery, sessionIdFilter, limit]
          : [sanitizedQuery, limit];

        const result = db.exec(sql, params);

        if (result.length === 0 || result[0].values.length === 0) {
          return {
            title: "session_search",
            output: `No results found for query: "${query}"`,
          };
        }

        // Format results
        const results: SessionSearchResult[] = result[0].values.map((row: any[]) => ({
          sessionId: row[0] as string,
          messageId: row[1] as string,
          role: row[2] as string,
          timestamp: row[3] as number,
          snippet: row[4] as string,
          content: (row[5] as string) || "",
          sessionTitle: row[6] as string | undefined,
        }));

        const formatted = results.map((r, i) => {
          const date = new Date(r.timestamp).toLocaleString();
          const title = r.sessionTitle || r.sessionId.substring(0, 8);
          return `${i + 1}. [${r.role}] ${title} (${date})
   Session: ${r.sessionId}
   ${r.snippet}`;
        }).join("\n\n");

        return {
          title: `session_search: ${query}`,
          output: `Found ${results.length} result(s) for "${query}":\n\n${formatted}`,
        };
      } catch (err: any) {
        // FTS5 table might not exist yet
        if (err.message?.includes("no such table") || err.message?.includes("session_fts")) {
          return {
            title: "session_search",
            output: `Error: Full-text search index not available. This feature requires database initialization with FTS5 support.`,
          };
        }
        return {
          title: "session_search",
          output: `Error: ${err.message}`,
        };
      }
    },
  };
}
