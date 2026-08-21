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
    guidance: "Use session_search to find past conversation sessions by keyword. Returns matching session IDs and previews.",
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

/**
 * session_event_search — 搜索单个会话内的事件
 *
 * 对标 DSH session_event_search 工具。
 * 在指定会话的事件日志中搜索匹配的事件。
 */
export function createSessionEventSearchTool(): ToolDef {
  return {
    id: "session_event_search",
    guidance: "Use session_event_search to search within a session's events (tool calls, messages) for specific content.",
    description: `Search events within a specific session's event log.
Returns matching events with their sequence numbers, types, and content snippets.
Use this to find specific actions or messages within a known session.`,
    parameters: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description: "The session to search within.",
        },
        query: {
          type: "string",
          description: "Search query — matches against event payload content (case-insensitive).",
        },
        event_type: {
          type: "string",
          description: "Optional: filter by event type (user_message, assistant_text, tool_result, etc.)",
        },
        limit: {
          type: "number",
          description: "Maximum results to return (default: 20, max: 100)",
        },
      },
      required: ["session_id", "query"],
    },
    async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolExecuteResult> {
      const sessionId = args.session_id as string;
      const query = (args.query as string).toLowerCase();
      const eventType = args.event_type as string | undefined;
      const limit = Math.min(args.limit as number || 20, 100);

      try {
        const { getEventLog } = await import("../../storage/event-log");
        const events = getEventLog().readAll(sessionId);

        const matching = events.filter((evt) => {
          if (eventType && evt.type !== eventType) return false;
          const payloadStr = JSON.stringify(evt.payload).toLowerCase();
          return payloadStr.includes(query);
        }).slice(0, limit);

        if (matching.length === 0) {
          return {
            title: "session_event_search",
            output: `No events found matching "${query}" in session ${sessionId}.`,
          };
        }

        const formatted = matching.map((evt, i) => {
          const time = new Date(evt.timestamp).toLocaleString();
          const preview = JSON.stringify(evt.payload).slice(0, 200);
          return `${i + 1}. [seq=${evt.seq}] ${evt.type} (${time})\n   ${preview}${evt.payload && JSON.stringify(evt.payload).length > 200 ? "…" : ""}`;
        }).join("\n\n");

        return {
          title: `session_event_search: ${query}`,
          output: `Found ${matching.length} event(s) in session ${sessionId}:\n\n${formatted}`,
        };
      } catch (err: any) {
        return {
          title: "session_event_search",
          output: `Error: ${err.message}`,
        };
      }
    },
  };
}

/**
 * session_trace — 读取会话的完整谱系
 *
 * 对标 DSH session_trace 工具。
 * 返回会话的祖先和后代关系（fork 关系链）。
 */
export function createSessionTraceTool(): ToolDef {
  return {
    id: "session_trace",
    guidance: "Use session_trace to get the full execution trace of a session, showing all steps and tool calls.",
    description: `Read the complete lineage of a session, including fork ancestors and descendants.
Use this to understand session relationships and history.`,
    parameters: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description: "The session to trace.",
        },
      },
      required: ["session_id"],
    },
    async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolExecuteResult> {
      const sessionId = args.session_id as string;

      try {
        const { getDatabase } = await import("../../storage/database");
        const db = getDatabase();

        // Get session info including parent
        const sessionResult = db.exec(
          "SELECT id, title, parent_id, created_at FROM sessions WHERE id = ?",
          [sessionId],
        );

        if (sessionResult.length === 0 || sessionResult[0].values.length === 0) {
          return {
            title: "session_trace",
            output: `Session ${sessionId} not found.`,
          };
        }

        const session = sessionResult[0].values[0];
        const parentId = session[2] as string | null;

        // Trace ancestors
        const ancestors: string[] = [];
        let currentParent = parentId;
        while (currentParent) {
          ancestors.push(currentParent);
          const parentResult = db.exec(
            "SELECT parent_id FROM sessions WHERE id = ?",
            [currentParent],
          );
          if (parentResult.length === 0 || parentResult[0].values.length === 0) break;
          currentParent = parentResult[0].values[0][0] as string | null;
        }

        // Trace descendants
        const descendantsResult = db.exec(
          "SELECT id, title FROM sessions WHERE parent_id = ? ORDER BY created_at",
          [sessionId],
        );
        const descendants = descendantsResult.length > 0
          ? descendantsResult[0].values.map((row) => `${row[0]} (${row[1] || "untitled"})`)
          : [];

        const lines: string[] = [];
        lines.push(`Session: ${sessionId}`);
        lines.push(`Title: ${session[1] || "untitled"}`);
        lines.push(`Created: ${new Date(session[3] as number).toLocaleString()}`);
        lines.push(`Parent: ${parentId || "(root)"}`);
        if (ancestors.length > 1) {
          lines.push(`Ancestors: ${ancestors.join(" → ")}`);
        }
        lines.push(`Descendants: ${descendants.length > 0 ? descendants.join(", ") : "(none)"}`);

        return {
          title: `session_trace: ${sessionId.substring(0, 8)}`,
          output: lines.join("\n"),
        };
      } catch (err: any) {
        return {
          title: "session_trace",
          output: `Error: ${err.message}`,
        };
      }
    },
  };
}

/**
 * session_event_read — 读取单个完整事件及其上下文窗口
 *
 * 对标 DSH session_event_read 工具。
 */
export function createSessionEventReadTool(): ToolDef {
  return {
    id: "session_event_read",
    guidance: "Use session_event_read to read the details of a specific event in a session's trace.",
    description: `Read one full event and optional neighboring events from a session's event log.
Use this to inspect a specific event in detail, including its surrounding context.`,
    parameters: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description: "The session to read from.",
        },
        seq: {
          type: "number",
          description: "The event sequence number to read.",
        },
        before: {
          type: "number",
          description: "Number of preceding events to include (default: 0, max: 10)",
        },
        after: {
          type: "number",
          description: "Number of following events to include (default: 0, max: 10)",
        },
      },
      required: ["session_id", "seq"],
    },
    async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolExecuteResult> {
      const sessionId = args.session_id as string;
      const seq = args.seq as number;
      const before = Math.min(args.before as number || 0, 10);
      const after = Math.min(args.after as number || 0, 10);

      try {
        const { getEventLog } = await import("../../storage/event-log");
        const log = getEventLog();
        const events = log.readRange(sessionId, seq - before, seq + after);

        if (events.length === 0) {
          return {
            title: "session_event_read",
            output: `Event seq=${seq} not found in session ${sessionId}.`,
          };
        }

        const formatted = events.map((evt) => {
          const time = new Date(evt.timestamp).toLocaleString();
          const isTarget = evt.seq === seq;
          const marker = isTarget ? "▶" : " ";
          const payloadStr = JSON.stringify(evt.payload, null, 2);
          const truncated = payloadStr.length > 1000
            ? payloadStr.slice(0, 1000) + "\n  …(truncated)"
            : payloadStr;
          return `${marker} [seq=${evt.seq}] ${evt.type} (${time})\n  ${truncated}`;
        }).join("\n\n");

        return {
          title: `session_event_read: seq=${seq}`,
          output: formatted,
        };
      } catch (err: any) {
        return {
          title: "session_event_read",
          output: `Error: ${err.message}`,
        };
      }
    },
  };
}
