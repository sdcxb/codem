/**
 * session_search 工具 — 历史会话全文搜索
 *
 * Design (对标 DeepSeek Harness session_query):
 * - 使用 SQLite FTS4 全文搜索引擎
 * - 支持跨会话搜索历史消息
 * - 返回匹配的消息片段和相关会话信息
 *
 * FTS4 表在 database.ts 中定义:
 *   CREATE VIRTUAL TABLE session_fts USING fts4(
 *     session_id, message_id, content, role, timestamp, tokenize=unicode61
 *   );
 *
 * 消息在 message.ts createMessage() 中自动索引到 FTS4 表。
 */

import type { ToolDef, ToolContext, ToolExecuteResult } from "../tools";
import { domainReadMany } from "../../storage/domain-store";

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
        // ===== 迁移期分流（P3 第 9 段）：端口是 rust → 走引擎的 FTS（含 CJK 切分）=====
        //
        // 为什么这条路径必须切：旧实现（下面的 WASM 分支）**中文永远搜不到** ——
        // 它把查询原样加引号交给 FTS4/unicode61，而 unicode61 把整串 CJK 当一个 token；
        // 另外它还算了 `matchExpr` 却从未用于 SQL（死代码），所以"全局搜索"也从没生效过。
        // 引擎侧 `fts.search` 做了 CJK 切分，且不传 session_id 就是真正的跨会话搜索。
        const viaRust = await searchViaRust(query, limit, sessionIdFilter);
        if (viaRust) {
          if (viaRust.length === 0) {
            return { title: "session_search", output: `No results found for query: "${query}"` };
          }
          const formatted = viaRust
            .map((r, i) => {
              const date = new Date(r.timestamp).toLocaleString();
              const title = r.sessionTitle || r.sessionId.substring(0, 8);
              return `${i + 1}. [${r.role}] ${title} (${date})
   Session: ${r.sessionId}
   ${r.snippet}`;
            })
            .join("\n\n");
          return {
            title: `session_search: ${query}`,
            output: `Found ${viaRust.length} result(s) for "${query}":\n\n${formatted}`,
          };
        }

        /**
         * **B 态（端口在 rust）止步于此**（第 17 轮 L4：旧库回退已删）。
         *
         * `searchViaRust` 返回 null 只有一种可能：端口未注册或不是 rust 引擎；
         * 而那时旧库同样不可用（rust 模式下刻意不加载），所以"继续往下走"只会抛异常，
         * 模型拿到的会是一段与查询毫无关系的堆栈。这里如实告诉模型"稍后重试"。
         *
         * 被删掉的是原 WASM 分支：它把查询原样加引号交给 FTS4/unicode61
         * （**中文永远搜不到**），而且算了 `matchExpr` 却从未用于 SQL（死代码）。
         */
        return {
          title: "session_search",
          output: "Error: 全文搜索暂时不可用（索引侧未接手，可稍后重试）—— 本次没有查询旧库",
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
 * 走 Rust 引擎做全文检索。
 *
 * @returns 命中结果数组；`null` = 本次不接手（端口未注册 / 是 wasm 引擎），调用方走原路径
 *
 * 关键点：
 * - 引擎侧做了 **CJK 切分**（旧实现中文永远搜不到）；
 * - **不传 session_id 就是跨会话搜索**（旧实现的"全局搜索"是死代码，从没生效）；
 * - 引擎返回**真实正文**（索引里存的是切分后的文本，不能直接展示），
 *   这里在正文上按查询词生成片段（高亮用方括号，与旧格式一致）。
 */
async function searchViaRust(
  query: string,
  limit: number,
  sessionIdFilter?: string,
): Promise<SessionSearchResult[] | null> {
  const { hasStoragePort, getStoragePort } = await import("../../storage/port");
  if (!hasStoragePort()) return null;
  const port = getStoragePort();
  if (port.kind !== "rust") return null;

  type Row = {
    message_id?: string | null;
    role?: string | null;
    timestamp?: number | null;
    session_id?: string | null;
    content?: string | null;
    session_title?: string | null;
  };
  const params: Record<string, unknown> = { query, limit };
  if (sessionIdFilter) params.session_id = sessionIdFilter;
  const page = await port.data.query<Row>("fts.search", params, { limit });
  return page.items.map((r) => {
    const content = r.content ?? "";
    return {
      sessionId: r.session_id ?? "",
      messageId: r.message_id ?? "",
      role: r.role ?? "",
      timestamp: r.timestamp ?? 0,
      snippet: buildSnippet(content, query),
      content,
      sessionTitle: r.session_title ?? undefined,
    };
  });
}

/**
 * 在真实正文上生成片段（旧实现靠 `snippet()`，但索引里存的是切分后的文本，
 * 直接展示会是 `存 存储 储 …` 这种形式，所以改在正文上做）。
 *
 * 半径取 40 字：这是喂给模型的工具输出，片段必须短 ——
 * 取太大（试过 60）会让短正文"整段"进去，等于没做片段化。
 */
function buildSnippet(content: string, query: string, radius = 40): string {
  if (!content) return "";
  const flat = content.replace(/\s+/g, " ").trim();
  // 依次尝试：完整查询词 → 退化成"CJK 双字片段" → 都不命中则取开头。
  //
  // 为什么要退化：查询"上下文问题"会被引擎切成多个 bigram 参与匹配，
  // 命中的可能是其中任意一段（例如正文只有"上下文压缩"），
  // 所以片段定位必须按同样的粒度去找，否则会出现"引擎说命中了，但片段里看不到关键词"。
  const candidates = [query, ...cjkBigrams(query)];
  for (const cand of candidates) {
    const idx = flat.toLowerCase().indexOf(cand.toLowerCase());
    if (idx < 0) continue;
    const start = Math.max(0, idx - radius);
    const end = Math.min(flat.length, idx + cand.length + radius);
    return `${start > 0 ? "…" : ""}${flat.slice(start, idx)}[${flat.slice(idx, idx + cand.length)}]${flat.slice(idx + cand.length, end)}${end < flat.length ? "…" : ""}`;
  }
  return flat.slice(0, radius * 2) + (flat.length > radius * 2 ? "…" : "");
}

/** 查询词里的 CJK 双字片段（与引擎侧的切分规则对应，用于片段定位） */
function cjkBigrams(text: string): string[] {
  const out: string[] = [];
  const cjk = /[\u3400-\u9fff]/;
  for (let i = 0; i < text.length - 1; i++) {
    if (cjk.test(text[i]) && cjk.test(text[i + 1])) out.push(text.slice(i, i + 2));
  }
  return out;
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
        /**
         * **端口优先**（第 12 轮）：`session_trace` 读的是 `sessions` 表（fork 谱系），
         * 而这张表在 rust 模式下由**域镜像**持有 —— 旧实现只有旧库一条路径，
         * 在 rust 模式下必然抛错（引擎侧刻意不加载旧库），模型拿到的是一段堆栈。
         *
         * 镜像里 `sessions` 是"整表即工作集"量级（几十到几百行），
         * 所以谱系遍历直接在镜像上做，语义与原来的 SQL 一一对应：
         * 祖先 = 沿 `parent_id` 往上走；后代 = `parent_id = 当前` 按 created_at 升序。
         */
        const viaPort = (() => {
          const all = domainReadMany<Record<string, unknown>>("sessions", (r) => r);
          if (!all) return null; // A 态：端口没接手 → 走旧库
          const byId = new Map(all.map((r) => [String(r.id ?? ""), r]));
          const found = byId.get(sessionId);
          if (!found) return { missing: true as const };

          const parentId = (found.parent_id as string | null) ?? null;
          const ancestors: string[] = [];
          let currentParent = parentId;
          // 上限防环（数据异常时 parent 成环会让 while 停不下来）
          for (let i = 0; i < 64 && currentParent; i++) {
            ancestors.push(currentParent);
            const parentRow = byId.get(currentParent);
            if (!parentRow) break;
            currentParent = (parentRow.parent_id as string | null) ?? null;
          }
          const descendants = all
            .filter((r) => (r.parent_id as string | null) === sessionId)
            .sort((a, b) => Number(a.created_at ?? 0) - Number(b.created_at ?? 0))
            .map((r) => `${String(r.id ?? "")} (${String(r.title ?? "") || "untitled"})`);

          return { missing: false as const, found, parentId, ancestors, descendants };
        })();

        if (viaPort) {
          if (viaPort.missing) {
            return { title: "session_trace", output: `Session ${sessionId} not found.` };
          }
          const lines: string[] = [];
          lines.push(`Session: ${sessionId}`);
          lines.push(`Title: ${String(viaPort.found.title ?? "") || "untitled"}`);
          lines.push(`Created: ${new Date(Number(viaPort.found.created_at ?? 0)).toLocaleString()}`);
          lines.push(`Parent: ${viaPort.parentId || "(root)"}`);
          if (viaPort.ancestors.length > 1) {
            lines.push(`Ancestors: ${viaPort.ancestors.join(" → ")}`);
          }
          lines.push(
            `Descendants: ${viaPort.descendants.length > 0 ? viaPort.descendants.join(", ") : "(none)"}`,
          );
          return { title: `session_trace: ${sessionId.substring(0, 8)}`, output: lines.join("\n") };
        }

        /**
         * 第 17 轮（L4）：旧库回退（`sessions` 表三段 SQL 的谱系遍历）已删。
         * `viaPort` 为 null 只剩一种含义 —— `sessions` 域镜像未就绪；如实告诉模型"稍后重试"。
         */
        return {
          title: "session_trace",
          output: "Error: 会话谱系暂时不可读（sessions 域镜像未就绪，可稍后重试）—— 本次没有查询旧库",
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
