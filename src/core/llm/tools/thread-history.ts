/**
 * Thread History 工具（P0-2 / D1 / D11）：`thread_history_search` / `thread_history_read` /
 * `thread_segment_list`。
 *
 * ## 边界（FAIL 3 修完之后的形态）
 *
 * 整会话同步读**全部在数据层**（`core/storage/thread-history.ts`）。本文件只做三件事：
 * 收参数、调数据层拿**有界结果**、格式化输出。它自己不再 import
 * `listTimelineMessages`，也不存在"起个语义别名绕过 no-sync 门禁"的写法。
 *
 * ## 工具结果与 spill（独立复核的高优先级缺口）
 *
 * 编程场景里最该被找回的历史**不在 `content` 里**：旧命令的报错、diff、构建输出都在
 * `message.toolCalls[].result`（请求侧在 `toolCalls[].args`）。所以：
 *
 * - `search` 的检索面 = 正文 + 工具结果 + 工具请求侧（工具名/参数），命中时标出
 *   `content` / `tool_result` / `tool_args` 与工具名；
 * - `read` 渲染工具调用：名字、参数摘要、结果正文；结果过大走 spill 时用
 *   `readSpillText` 读回**全文**，读不到**如实报错**（不假装"没有内容"）；
 * - `read` 支持 `segment`（按 epoch 的 `segmentSeq` 读整段），且只返回请求的范围
 *   （HIST-4：绝不把整段历史顺手塞进当前视图）。
 *
 * ## 其它契约
 *
 * - 只读；作用域 = `ctx.sessionId`（跨会话检索仍走 `session_search`）；
 * - 正文、参数与片段都**抹密**（`redactSecrets`），与注入侧同一把尺；
 * - 输出有**总量上限**：段读不是"把整段倒出来"的借口，超预算的部分如实标注未展开。
 */
import type { ToolContext, ToolDef, ToolExecuteResult } from "../tools";
import {
  readHistoryFor,
  readSegmentFor,
  searchHistoryFor,
  segmentDiagnostics,
  segmentsFor,
} from "../../storage/thread-history";
import { findSpillLocator, readSpillText } from "../../storage/spill";
import { redactSecrets } from "../../utils/redact";

const SEARCH_DEFAULT_LIMIT = 10;
const SEARCH_MAX_LIMIT = 50;
const READ_DEFAULT_BEFORE = 2;
const READ_DEFAULT_AFTER = 2;
const READ_MAX_NEIGHBORS = 20;
const READ_DEFAULT_MAX_CHARS = 1200;
const READ_MAX_CHARS = 8_000;
/** 段读一次最多返回多少条（25 号文 P0-2 的量级；超出如实标 `truncatedAfter`） */
const READ_SEGMENT_MAX_MESSAGES = 200;
/** 单次回读的**总**输出预算：段读时逐条裁到这条线以内，避免把整段一次性倒进上下文 */
const READ_TOTAL_MAX_CHARS = 24_000;
/** 工具参数摘要（单行）上限 */
const ARGS_SUMMARY_MAX = 300;

/** 结果契约（output-schema 棘轮）：`text` = 模型可见文本，其余字段供下游消费 */
const SEARCH_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    text: { type: "string" },
    query: { type: "string" },
    count: { type: "number" },
    ids: { type: "array", items: { type: "string" } },
    /**
     * 每条命中命中的是哪一段（`content` / `tool_result` / `tool_args`）——
     * 与 `ids` 同序。模型据此判断"要不要去读原作"。
     */
    matchFields: { type: "array", items: { type: "string" } },
  },
  required: ["text", "query", "count", "ids", "matchFields"],
  additionalProperties: false,
} as const;

const READ_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    text: { type: "string" },
    id: { type: "string" },
    segmentSeq: { type: "number" },
    messageIds: { type: "array", items: { type: "string" } },
    /** 本次渲染出的工具结果条数（段读时用它说明"这一段跑过多少工具"） */
    toolResultCount: { type: "number" },
  },
  required: ["text", "id", "segmentSeq", "messageIds", "toolResultCount"],
  additionalProperties: false,
} as const;

const SEGMENTS_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    text: { type: "string" },
    segmentCount: { type: "number" },
    segments: { type: "array", items: { type: "number" } },
    /** 每段的工具结果条数（与 `segments` 同序） */
    toolResults: { type: "array", items: { type: "number" } },
  },
  required: ["text", "segmentCount", "segments", "toolResults"],
  additionalProperties: false,
} as const;

const renderTextValue = (v: unknown): string => String((v as { text?: unknown } | null)?.text ?? "");

function noSession(toolId: string): ToolExecuteResult {
  return {
    title: toolId,
    output:
      `Error: ${toolId} 需要当前会话（ctx.sessionId 为空）。` +
      `这不是「没有历史」—— 调用方没有提供会话上下文。`,
    isError: true,
  };
}

function roleTag(role: unknown): string {
  const r = String(role ?? "");
  return r === "assistant" ? "A" : r === "user" ? "U" : r.slice(0, 1).toUpperCase() || "?";
}

/** 正文的纯文本形态（字符串原样；文本块拼接；其它形状按空串） */
function contentTextOf(message: { content?: unknown }): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        const text = (part as { text?: unknown } | null)?.text;
        return typeof text === "string" ? text : "";
      })
      .join("");
  }
  return "";
}

type ToolCallLike = {
  tool?: unknown;
  name?: unknown;
  function?: { name?: unknown } | null;
  args?: unknown;
  arguments?: unknown;
  result?: unknown;
  status?: unknown;
};

function toolCallsOf(message: { toolCalls?: unknown }): ToolCallLike[] {
  return Array.isArray(message.toolCalls) ? (message.toolCalls as ToolCallLike[]) : [];
}

function toolNameOfCall(call: ToolCallLike): string {
  const name = call?.tool ?? call?.function?.name ?? call?.name;
  return typeof name === "string" && name.trim() ? name.trim() : "(unnamed)";
}

/** 工具参数摘要：单行、有界（正文展开由 `read` 管，这里只让模型认出"是哪次调用"） */
function argsSummaryOfCall(call: ToolCallLike): string {
  const args = call?.arguments ?? call?.args;
  if (args === undefined || args === null) return "(none)";
  let text: string;
  if (typeof args === "string") {
    text = args;
  } else {
    try {
      text = JSON.stringify(args);
    } catch {
      text = String(args);
    }
  }
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return "(none)";
  return flat.length > ARGS_SUMMARY_MAX ? `${flat.slice(0, ARGS_SUMMARY_MAX)}…` : flat;
}

function resultTextOfCall(call: ToolCallLike): string {
  const result = call?.result;
  if (typeof result === "string") return result;
  if (result === undefined || result === null) return "";
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

/** 检索命中的标签（模型据此判断命中在哪一段） */
function hitTag(hit: ReturnType<typeof searchHistoryFor>[number]): string {
  if (hit.matchField === "content") return "content";
  return hit.toolName ? `${hit.matchField}:${hit.toolName}` : hit.matchField;
}

export function createThreadHistorySearchTool(): ToolDef {
  return {
    id: "thread_history_search",
    shouldDefer: true,
    searchHint: "Search earlier turns of THIS conversation, including compacted / previous-segment messages, tool results and tool arguments",
    contract: {
      readOnly: true,
      accessScope: "none",
      sideEffectScope: "none",
      outputSchema: SEARCH_OUTPUT_SCHEMA,
      renderOutput: renderTextValue,
    },
    guidance:
      "Use thread_history_search to find something said or DONE earlier in THIS conversation — message text, " +
      "tool results (command output / errors / diffs) and tool arguments are all searched. Works across " +
      "compacted and previous segments; optional segment narrows to one segment. " +
      "Use session_search for other sessions.",
    description: `Search the full timeline of the current conversation (including compacted/switched-out messages,
tool results and tool arguments). Returns message id, segment number, role, timestamp, which part matched
(content / tool_result / tool_args, with the tool name) and a snippet taken around the match.
Use thread_history_read with an id (or a segment number) to read the original.`,
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Text to look for (case-insensitive substring)." },
        limit: { type: "number", description: `Max hits (default ${SEARCH_DEFAULT_LIMIT}, max ${SEARCH_MAX_LIMIT}).` },
        segment: {
          type: "number",
          description: "Only search this segment (1-based segmentSeq from thread_segment_list). Omit to search all segments.",
        },
      },
      required: ["query"],
    },
    async execute(args, ctx: ToolContext): Promise<ToolExecuteResult> {
      if (!ctx.sessionId) return noSession("thread_history_search");
      const query = String(args.query ?? "").trim();
      if (!query) return { title: "thread_history_search", output: "Error: query 不能为空。", isError: true };

      const rawLimit = Number(args.limit);
      const limit = Number.isFinite(rawLimit)
        ? Math.min(Math.max(Math.floor(rawLimit), 1), SEARCH_MAX_LIMIT)
        : SEARCH_DEFAULT_LIMIT;

      let segmentFilter: number | undefined;
      if (args.segment !== undefined && args.segment !== null && String(args.segment).trim() !== "") {
        const raw = Number(args.segment);
        if (!Number.isFinite(raw) || Math.floor(raw) < 1) {
          return {
            title: "thread_history_search",
            output: `Error: segment 必须是 ≥1 的整数（收到 ${String(args.segment)}）。`,
            isError: true,
          };
        }
        segmentFilter = Math.floor(raw);
      }

      let hits: ReturnType<typeof searchHistoryFor>;
      let diagnostics: ReturnType<typeof segmentDiagnostics>;
      try {
        hits = searchHistoryFor(ctx.sessionId, query, limit, segmentFilter);
        diagnostics = segmentDiagnostics(ctx.sessionId);
      } catch (e) {
        return {
          title: "thread_history_search",
          output: `Error: 读不到当前会话的时间线（${e instanceof Error ? e.message : String(e)}）。这不是「没有历史」。`,
          isError: true,
        };
      }

      const emptyValue = { text: "", query, count: 0, ids: [] as string[], matchFields: [] as string[] };

      if (diagnostics.messages === 0) {
        const text = `No messages in session "${ctx.sessionId}" yet.`;
        return { title: "thread_history_search", output: text, value: { ...emptyValue, text }, isError: false };
      }

      const scope = segmentFilter === undefined ? "all segments" : `segment ${segmentFilter}`;

      if (hits.length === 0) {
        const text =
          `No match for "${query}" in this conversation (searched ${diagnostics.messages} messages, ` +
          `${scope}, including compacted ones, tool results and tool arguments).`;
        return { title: `thread_history_search: ${query}`, output: text, value: { ...emptyValue, text }, isError: false };
      }

      const text = [
        `Found ${hits.length} hit(s) for "${query}" (full timeline, ${diagnostics.messages} messages, ${scope}):`,
        "",
        ...hits.map(
          (h) =>
            `- [${h.id}] segment ${h.segmentSeq} · ${roleTag(h.role)} · ${new Date(h.timestamp || 0).toISOString()}` +
            ` · ${hitTag(h)}: ${redactSecrets(h.snippet)}`,
        ),
        "",
        "Use thread_history_read id=<id> to read the original message with its neighbors and the full tool results,",
        "or thread_history_read segment=<segmentSeq> to read a whole segment.",
      ].join("\n");
      return {
        title: `thread_history_search: ${query}`,
        output: text,
        value: {
          text,
          query,
          count: hits.length,
          ids: hits.map((h) => h.id),
          matchFields: hits.map((h) => h.matchField),
        },
        isError: false,
      };
    },
  };
}

export function createThreadHistoryReadTool(): ToolDef {
  return {
    id: "thread_history_read",
    shouldDefer: true,
    searchHint: "Read one original message (with tool results + neighbors) or one whole segment from THIS conversation",
    contract: {
      readOnly: true,
      accessScope: "none",
      sideEffectScope: "none",
      outputSchema: READ_OUTPUT_SCHEMA,
      renderOutput: renderTextValue,
    },
    guidance:
      "Use thread_history_read to read one original message (by id) plus its neighbors, or a whole segment " +
      "(by segmentSeq), from the full conversation timeline. Tool calls are rendered with their name, an " +
      "argument summary and the result body; truncated results stored in spill files are read back in full. " +
      "It only returns the requested range — nothing else is injected into the current view.",
    description: `Read one message (id) with up to 20 neighbors before/after, or one whole segment (segment) from the
full timeline of the current conversation. Works for messages that are no longer in the model view
(compacted or previous segment). Tool calls are rendered with name + argument summary + result body;
if a result was spilled to a file, the full text is read back from that locator.`,
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Message id (or epoch id) from thread_history_search / a checkpoint marker." },
        segment: {
          type: "number",
          description:
            `Read the whole segment with this 1-based segmentSeq (at most ${READ_SEGMENT_MAX_MESSAGES} messages). ` +
            "Provide either id or segment, not both.",
        },
        before: { type: "number", description: `Neighbors before (default ${READ_DEFAULT_BEFORE}, max ${READ_MAX_NEIGHBORS}).` },
        after: { type: "number", description: `Neighbors after (default ${READ_DEFAULT_AFTER}, max ${READ_MAX_NEIGHBORS}).` },
        max_chars: { type: "number", description: `Per-section character cap (default ${READ_DEFAULT_MAX_CHARS}, max ${READ_MAX_CHARS}).` },
      },
      required: [],
    },
    async execute(args, ctx: ToolContext): Promise<ToolExecuteResult> {
      if (!ctx.sessionId) return noSession("thread_history_read");
      const id = String(args.id ?? "").trim();
      const hasSegment = args.segment !== undefined && args.segment !== null && String(args.segment).trim() !== "";
      if (!id && !hasSegment) {
        return {
          title: "thread_history_read",
          output: "Error: 需要 id（消息/epoch）或 segment（段号）—— 两者至少给一个。",
          isError: true,
        };
      }
      if (id && hasSegment) {
        return {
          title: "thread_history_read",
          output: "Error: id 与 segment 只能给一个（按 id 读一条，或按 segment 读整段）。",
          isError: true,
        };
      }

      const rawSegment = hasSegment ? Number(args.segment) : Number.NaN;
      if (hasSegment && (!Number.isFinite(rawSegment) || Math.floor(rawSegment) < 1)) {
        return {
          title: "thread_history_read",
          output: `Error: segment 必须是 ≥1 的整数（收到 ${String(args.segment)}）。`,
          isError: true,
        };
      }
      const segmentSeq = hasSegment ? Math.floor(rawSegment) : 0;

      const clampNeighbor = (raw: unknown, fallback: number): number => {
        const n = Number(raw);
        if (!Number.isFinite(n)) return fallback;
        return Math.min(Math.max(Math.floor(n), 0), READ_MAX_NEIGHBORS);
      };
      const before = clampNeighbor(args.before, READ_DEFAULT_BEFORE);
      const after = clampNeighbor(args.after, READ_DEFAULT_AFTER);
      const rawMaxChars = Number(args.max_chars);
      const maxChars = Number.isFinite(rawMaxChars)
        ? Math.min(Math.max(Math.floor(rawMaxChars), 200), READ_MAX_CHARS)
        : READ_DEFAULT_MAX_CHARS;

      let window: ReturnType<typeof readHistoryFor>;
      let diagnostics: ReturnType<typeof segmentDiagnostics>;
      try {
        window = id ? readHistoryFor(ctx.sessionId, id, before, after) : readSegmentFor(ctx.sessionId, segmentSeq, READ_SEGMENT_MAX_MESSAGES);
        diagnostics = segmentDiagnostics(ctx.sessionId);
      } catch (e) {
        return {
          title: "thread_history_read",
          output: `Error: 读不到当前会话的时间线（${e instanceof Error ? e.message : String(e)}）。这不是「id 不存在」。`,
          isError: true,
        };
      }

      if (!window) {
        const text = id
          ? `Message "${id}" is not in this conversation's timeline (${diagnostics.messages} messages). ` +
            `It may belong to another session, or the id is wrong.`
          : `Segment ${segmentSeq} does not exist in this conversation ` +
            `(${diagnostics.segments} segment(s), ${diagnostics.messages} messages).`;
        return { title: id ? `thread_history_read: ${id}` : `thread_history_read: segment ${segmentSeq}`, output: text, isError: true };
      }

      /** 把一段原文变成"可读正文 + 诚实备注"：spill 读全文、抹密、按上限裁剪 */
      const renderBody = async (
        raw: string,
        limit: number,
      ): Promise<{ body: string; note: string }> => {
        let body = raw;
        let note = "";
        /**
         * spill：旧工具结果/正文只留下"已落盘 + locator"的提示。回读时必须**读全文**，
         * 否则 thread history 对这类消息等于只有一句提示（HIST-2 的反面）。
         */
        const locator = findSpillLocator(raw);
        if (locator) {
          try {
            body = await readSpillText(locator);
          } catch (e) {
            note = `（spill 读回失败：${e instanceof Error ? e.message : String(e)}；下面只是原提示）`;
          }
        }
        const safe = redactSecrets(body);
        const clipped =
          safe.length > limit ? `${safe.slice(0, limit)}…（共 ${safe.length} 字符，已截断）` : safe;
        return { body: clipped, note };
      };

      let budget = READ_TOTAL_MAX_CHARS;
      let toolResultCount = 0;
      const rendered: string[] = [];

      for (const m of window.messages) {
        const marker = id && m.id === id ? "▶ " : "  ";
        const calls = toolCallsOf(m);
        const raw = contentTextOf(m);
        const head = `${marker}[${m.id}] ${roleTag(m.role)}:`;
        if (budget <= 0) {
          rendered.push(`${head} （正文未展开：本次输出已达 ${READ_TOTAL_MAX_CHARS} 字符上限，可用 id 精确回读）`);
          continue;
        }
        const contentLimit = Math.min(maxChars, budget);
        const { body, note } = await renderBody(raw, contentLimit);
        budget -= body.length + note.length;
        rendered.push(`${head} ${body}${note}`);

        for (const call of calls) {
          const name = toolNameOfCall(call);
          const status = typeof call.status === "string" && call.status ? ` (${call.status})` : "";
          const argsSummary = redactSecrets(argsSummaryOfCall(call));
          if (budget <= 0) {
            rendered.push(`    · ${name}${status} args: ${argsSummary}`);
            rendered.push(`      result: （未展开：本次输出已达 ${READ_TOTAL_MAX_CHARS} 字符上限，可用 id 精确回读）`);
            continue;
          }
          rendered.push(`    · ${name}${status} args: ${argsSummary}`);
          const rawResult = resultTextOfCall(call);
          if (!rawResult.trim()) {
            rendered.push("      result: (no result recorded)");
            continue;
          }
          const resultLimit = Math.min(maxChars, budget);
          const result = await renderBody(rawResult, resultLimit);
          budget -= result.body.length + result.note.length;
          toolResultCount += 1;
          rendered.push(`      result: ${result.body}${result.note}`);
        }
      }

      const header = id
        ? `Message ${window.messages.find((m) => m.id === id)?.id ?? id} (segment ${window.segmentSeq}, index ${window.index}/${diagnostics.messages})`
        : `Segment ${window.segmentSeq} (messages from index ${window.index}, ${window.messages.length} returned/${diagnostics.messages} in timeline)`;
      const notes: string[] = [];
      if (window.truncatedBefore || window.truncatedAfter) notes.push("(邻居已按上限截断)");
      if (!id && window.truncatedAfter) {
        notes.push(`(本段还有消息未返回：上限 ${READ_SEGMENT_MAX_MESSAGES} 条/次；用 id 精确回读其余部分)`);
      }

      const text = [
        header,
        "",
        ...rendered,
        ...(notes.length > 0 ? ["", ...notes] : []),
      ].join("\n");
      return {
        title: id ? `thread_history_read: ${id}` : `thread_history_read: segment ${segmentSeq}`,
        output: text,
        value: {
          text,
          id: id || `segment:${segmentSeq}`,
          segmentSeq: window.segmentSeq,
          messageIds: window.messages.map((m) => m.id),
          toolResultCount,
        },
        isError: false,
      };
    },
  };
}

export function createThreadSegmentListTool(): ToolDef {
  return {
    id: "thread_segment_list",
    shouldDefer: true,
    searchHint: "List how this conversation was split into segments (checkpoints / segment switches) with tool-result counts",
    contract: {
      readOnly: true,
      accessScope: "none",
      sideEffectScope: "none",
      outputSchema: SEGMENTS_OUTPUT_SCHEMA,
      renderOutput: renderTextValue,
    },
    guidance:
      "Use thread_segment_list to see how this conversation was split into segments (compaction checkpoints and " +
      "segment switches), with their boundaries, sizes and how many tool results each segment holds — useful " +
      "before reading very old context.",
    description: `List the context epochs/segments of the current conversation: segment number, epoch kind
(compact / switch), cutoff message id, created time, removed/kept counts, message counts per segment and
how many tool results each segment holds.`,
    parameters: { type: "object", properties: {} },
    async execute(_args, ctx: ToolContext): Promise<ToolExecuteResult> {
      if (!ctx.sessionId) return noSession("thread_segment_list");

      let result: ReturnType<typeof segmentsFor>;
      try {
        result = segmentsFor(ctx.sessionId);
      } catch (e) {
        return {
          title: "thread_segment_list",
          output: `Error: 读不到当前会话的时间线（${e instanceof Error ? e.message : String(e)}）。`,
          isError: true,
        };
      }

      if (result.messageCount === 0) {
        const text = `No messages in session "${ctx.sessionId}" yet.`;
        return {
          title: "thread_segment_list",
          output: text,
          value: { text, segmentCount: 0, segments: [] as number[], toolResults: [] as number[] },
          isError: false,
        };
      }

      const lines: string[] = [
        `Session ${ctx.sessionId}: ${result.segments.length} segment(s), ${result.messageCount} messages in the full timeline.`,
      ];
      for (const seg of result.segments) {
        lines.push(
          "",
          `segment ${seg.segmentSeq}: messages ${seg.startIndex}..${seg.endIndex} (${seg.messageCount} 条, ` +
            `工具结果 ${seg.toolResultCount} 条)`,
        );
        if (seg.epochs.length === 0) {
          lines.push("  (no epoch in this segment)");
          continue;
        }
        for (const epoch of seg.epochs) {
          lines.push(
            `  - ${epoch.kind} [${epoch.epochId}] cutoff=${epoch.cutoffMessageId} ` +
              `removed=${epoch.removedCount} kept=${epoch.keptCount} at ${new Date(epoch.createdAt || 0).toISOString()}`,
          );
        }
      }
      const text = lines.join("\n");
      return {
        title: "thread_segment_list",
        output: text,
        value: {
          text,
          segmentCount: result.segments.length,
          segments: result.segments.map((s) => s.segmentSeq),
          toolResults: result.segments.map((s) => s.toolResultCount),
        },
        isError: false,
      };
    },
  };
}

export function createThreadHistoryTools(): ToolDef[] {
  return [createThreadHistorySearchTool(), createThreadHistoryReadTool(), createThreadSegmentListTool()];
}
