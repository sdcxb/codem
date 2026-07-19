import { getDatabase, persistDatabase } from "./database";
import type { Message, ToolCall, MessageAttachment } from "../../store";

export interface MessageRow {
  id: string;
  session_id: string;
  role: string;
  content: string;
  reasoning: string | null;
  timestamp: number;
  model: string | null;
  prompt_tokens: number;
  completion_tokens: number;
  cost: number;
  status: string;
  generated_files: string | null;
}

export interface ToolCallRow {
  id: string;
  message_id: string;
  tool: string;
  args: string;
  result: string | null;
  status: string;
}

function rowToMessage(row: MessageRow, toolCalls: ToolCall[], attachments?: MessageAttachment[]): Message {
  return {
    id: row.id,
    role: row.role as "user" | "assistant" | "system",
    content: row.content,
    reasoning: row.reasoning ?? undefined,
    timestamp: row.timestamp,
    model: row.model ?? undefined,
    status: row.status as Message["status"],
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    attachments: attachments && attachments.length > 0 ? attachments : undefined,
    generatedFiles: row.generated_files ? JSON.parse(row.generated_files) : undefined,
  };
}

function rowToToolCall(row: ToolCallRow): ToolCall {
  return {
    id: row.id,
    tool: row.tool,
    args: JSON.parse(row.args),
    result: row.result ?? undefined,
    status: row.status as ToolCall["status"],
  };
}

function rowToToolCallFromAny(tr: any[]): ToolCall {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(tr[3] as string);
  } catch {
    args = {};
  }
  return {
    id: tr[0] as string,
    tool: tr[2] as string,
    args,
    result: (tr[4] as string | null) ?? undefined,
    status: (tr[5] as string) as ToolCall["status"],
  };
}

function loadToolCallsForMessage(db: any, messageId: string): ToolCall[] {
  const toolResult = db.exec(
    "SELECT * FROM tool_calls WHERE message_id = ? ORDER BY rowid ASC",
    [messageId]
  );
  return toolResult.length > 0 ? toolResult[0].values.map(rowToToolCallFromAny) : [];
}

/** Load attachments associated with a specific message (by message_id) */
function loadAttachmentsForMessage(db: any, messageId: string): MessageAttachment[] {
  try {
    const result = db.exec(
      "SELECT id, name, type, path, content, preview, sandbox_path, mime_type, size FROM attachments WHERE message_id = ? ORDER BY added_at ASC",
      [messageId]
    );
    if (result.length === 0) return [];
    return result[0].values.map((row: any[]) => ({
      id: row[0] as string,
      name: row[1] as string,
      type: row[2] as "file" | "image" | "code" | "url",
      path: row[3] as string | undefined,
      content: row[4] as string | undefined,
      preview: row[5] as string | undefined,
      sandboxPath: row[6] as string | undefined,
      mimeType: row[7] as string | undefined,
      size: row[8] as number | undefined,
    }));
  } catch (e) {
    console.warn("[loadAttachmentsForMessage] Failed:", e);
    return [];
  }
}

export function listMessages(sessionId: string, limit?: number): Message[] {
  const db = getDatabase();
  const limitClause = limit ? `LIMIT ${limit}` : "";
  const result = db.exec(
    `SELECT id, session_id, role, content, timestamp, model, prompt_tokens, completion_tokens, cost, status, reasoning, generated_files FROM messages WHERE session_id = ? ORDER BY timestamp ASC ${limitClause}`,
    [sessionId]
  );
  if (result.length === 0) return [];

  return result[0].values.map((row: any[]) => {
    try {
      const messageRow: MessageRow = {
        id: row[0] as string,
        session_id: row[1] as string,
        role: row[2] as string,
        content: row[3] as string,
        timestamp: row[4] as number,
        model: row[5] as string | null,
        prompt_tokens: row[6] as number,
        completion_tokens: row[7] as number,
        cost: row[8] as number,
        status: row[9] as string,
        reasoning: row[10] as string | null,
        generated_files: row[11] as string | null,
      };
      const toolCalls = loadToolCallsForMessage(db, messageRow.id);
      const attachments = loadAttachmentsForMessage(db, messageRow.id);
      return rowToMessage(messageRow, toolCalls, attachments);
    } catch (e) {
      console.warn("[listMessages] Failed to convert row:", e);
      return null;
    }
  }).filter((m): m is Message => m !== null);
}

/**
 * List all attachments across all sessions (for cross-session reuse).
 * Returns attachments with their owning session_id and message_id.
 */
export function listAllAttachments(limit?: number): Array<MessageAttachment & { sessionId: string; messageId: string }> {
  const db = getDatabase();
  const limitClause = limit ? `LIMIT ${limit}` : "";
  try {
    const result = db.exec(
      `SELECT id, session_id, message_id, name, type, path, content, preview, sandbox_path, mime_type, size FROM attachments ORDER BY added_at DESC ${limitClause}`
    );
    if (result.length === 0) return [];
    return result[0].values.map((row: any[]) => ({
      id: row[0] as string,
      sessionId: row[1] as string,
      messageId: row[2] as string,
      name: row[3] as string,
      type: row[4] as "file" | "image" | "code" | "url",
      path: row[5] as string | undefined,
      content: row[6] as string | undefined,
      preview: row[7] as string | undefined,
      sandboxPath: row[8] as string | undefined,
      mimeType: row[9] as string | undefined,
      size: row[10] as number | undefined,
    }));
  } catch (e) {
    console.warn("[listAllAttachments] Failed:", e);
    return [];
  }
}

export function getMessage(id: string): Message | null {
  const db = getDatabase();
  const result = db.exec("SELECT id, session_id, role, content, timestamp, model, prompt_tokens, completion_tokens, cost, status, reasoning, generated_files FROM messages WHERE id = ?", [id]);
  if (result.length === 0 || result[0].values.length === 0) return null;

  const row = result[0].values[0];
  const messageRow: MessageRow = {
    id: row[0] as string,
    session_id: row[1] as string,
    role: row[2] as string,
    content: row[3] as string,
    timestamp: row[4] as number,
    model: row[5] as string | null,
    prompt_tokens: row[6] as number,
    completion_tokens: row[7] as number,
    cost: row[8] as number,
    status: row[9] as string,
    reasoning: row[10] as string | null,
    generated_files: row[11] as string | null,
  };

  const toolCalls = loadToolCallsForMessage(db, id);
  const attachments = loadAttachmentsForMessage(db, id);
  return rowToMessage(messageRow, toolCalls, attachments);
}

export function createMessage(message: Message, sessionId: string): void {
  const db = getDatabase();
  // Check if message already exists
  const existing = db.exec("SELECT id FROM messages WHERE id = ?", [message.id]);
  if (existing.length > 0 && existing[0].values.length > 0) {
    // Update existing message
    updateMessage(message.id, {
      content: message.content,
      reasoning: message.reasoning,
      model: message.model,
      status: message.status,
      toolCalls: message.toolCalls,
      generatedFiles: message.generatedFiles,
    });
    return;
  }

  db.run(
    "INSERT INTO messages (id, session_id, role, content, reasoning, timestamp, model, prompt_tokens, completion_tokens, cost, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      message.id,
      sessionId,
      message.role,
      message.content,
      message.reasoning ?? null,
      message.timestamp,
      message.model ?? null,
      0,
      0,
      0,
      message.status ?? "done",
    ]
  );

  // Update generated_files separately to avoid INSERT failure if column missing
  if (message.generatedFiles && message.generatedFiles.length > 0) {
    try {
      db.run("UPDATE messages SET generated_files = ? WHERE id = ?", [JSON.stringify(message.generatedFiles), message.id]);
    } catch (e) {
      console.warn("[createMessage] generated_files column may not exist:", e);
    }
  }

  if (message.toolCalls) {
    for (const tc of message.toolCalls) {
      db.run(
        "INSERT INTO tool_calls (id, message_id, tool, args, result, status) VALUES (?, ?, ?, ?, ?, ?)",
        [tc.id, message.id, tc.tool, JSON.stringify(tc.args), tc.result ?? null, tc.status]
      );
    }
  }

  // Persist attachments associated with this message
  if (message.attachments && message.attachments.length > 0) {
    for (const att of message.attachments) {
      try {
        db.run(
          "INSERT OR REPLACE INTO attachments (id, session_id, message_id, name, type, path, content, preview, sandbox_path, mime_type, size, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [
            att.id,
            sessionId,
            message.id,
            att.name,
            att.type,
            (att as any).path ?? null,
            att.content ?? null,
            att.preview ?? null,
            att.sandboxPath ?? null,
            att.mimeType ?? null,
            att.size ?? null,
            Date.now(),
          ]
        );
      } catch (e) {
        console.warn("[createMessage] Failed to save attachment:", e);
      }
    }
  }
  persistDatabase();
}

export function updateMessage(id: string, update: Partial<Message>): void {
  const db = getDatabase();
  const fields: string[] = [];
  const values: (string | number | null)[] = [];

  if (update.content !== undefined) { fields.push("content = ?"); values.push(update.content); }
  if (update.reasoning !== undefined) { fields.push("reasoning = ?"); values.push(update.reasoning); }
  if (update.model !== undefined) { fields.push("model = ?"); values.push(update.model ?? null); }
  if (update.status !== undefined) { fields.push("status = ?"); values.push(update.status ?? "done"); }

  if (fields.length > 0) {
    values.push(id);
    try {
      db.run(`UPDATE messages SET ${fields.join(", ")} WHERE id = ?`, values);
    } catch (e) {
      console.error("[updateMessage] Failed to update:", e);
    }
  }

  // Handle generated_files separately to avoid failure if column missing
  if (update.generatedFiles !== undefined) {
    try {
      db.run("UPDATE messages SET generated_files = ? WHERE id = ?", [update.generatedFiles ? JSON.stringify(update.generatedFiles) : null, id]);
    } catch (e) {
      console.warn("[updateMessage] generated_files column may not exist:", e);
    }
  }

  if (update.toolCalls !== undefined) {
    db.run("DELETE FROM tool_calls WHERE message_id = ?", [id]);
    for (const tc of update.toolCalls) {
      db.run(
        "INSERT INTO tool_calls (id, message_id, tool, args, result, status) VALUES (?, ?, ?, ?, ?, ?)",
        [tc.id, id, tc.tool, JSON.stringify(tc.args), tc.result ?? null, tc.status]
      );
    }
  }
  persistDatabase();
}

export function appendToMessage(id: string, content: string): void {
  const db = getDatabase();
  db.run("UPDATE messages SET content = content || ? WHERE id = ?", [content, id]);
  persistDatabase();
}

export function addToolCall(messageId: string, toolCall: ToolCall): void {
  const db = getDatabase();
  db.run(
    "INSERT OR REPLACE INTO tool_calls (id, message_id, tool, args, result, status) VALUES (?, ?, ?, ?, ?, ?)",
    [toolCall.id, messageId, toolCall.tool, JSON.stringify(toolCall.args), toolCall.result ?? null, toolCall.status]
  );
  persistDatabase();
}

export function updateToolCall(messageId: string, toolId: string, update: Partial<ToolCall>): void {
  const db = getDatabase();
  const fields: string[] = [];
  const values: (string | number | null)[] = [];

  if (update.args !== undefined) { fields.push("args = ?"); values.push(JSON.stringify(update.args)); }
  if (update.result !== undefined) { fields.push("result = ?"); values.push(update.result ?? null); }
  if (update.status !== undefined) { fields.push("status = ?"); values.push(update.status); }

  if (fields.length > 0) {
    values.push(toolId);
    db.run(`UPDATE tool_calls SET ${fields.join(", ")} WHERE id = ? AND message_id = ?`, [...values, messageId]);
  }
  persistDatabase();
}

export function deleteMessage(id: string): void {
  const db = getDatabase();
  db.run("DELETE FROM messages WHERE id = ?", [id]);
  persistDatabase();
}

/** Delete all messages before a given timestamp (exclusive) in a session */
export function deleteMessagesBefore(sessionId: string, timestamp: number): number {
  const db = getDatabase();
  // First get the IDs of messages to delete (so we can clean up tool_calls)
  const result = db.exec(
    "SELECT id FROM messages WHERE session_id = ? AND timestamp < ?",
    [sessionId, timestamp]
  );
  if (result.length === 0) return 0;
  const ids = result[0].values.map((row: any[]) => row[0] as string);

  // Delete tool_calls for those messages
  for (const id of ids) {
    db.run("DELETE FROM tool_calls WHERE message_id = ?", [id]);
  }
  // Delete the messages
  db.run(
    "DELETE FROM messages WHERE session_id = ? AND timestamp < ?",
    [sessionId, timestamp]
  );
  persistDatabase();
  return ids.length;
}

/** Delete messages by their IDs (and associated tool_calls) */
export function deleteMessagesByIds(ids: string[]): number {
  if (ids.length === 0) return 0;
  const db = getDatabase();
  for (const id of ids) {
    db.run("DELETE FROM tool_calls WHERE message_id = ?", [id]);
    db.run("DELETE FROM messages WHERE id = ?", [id]);
  }
  persistDatabase();
  return ids.length;
}

export function getMessageCount(sessionId: string): number {
  const db = getDatabase();
  const result = db.exec("SELECT COUNT(*) FROM messages WHERE session_id = ?", [sessionId]);
  if (result.length === 0) return 0;
  return result[0].values[0][0] as number;
}

// ========== Agentic Loop Helper Functions ==========

export function appendMessageContent(id: string, text: string): void {
  const db = getDatabase();
  db.run("UPDATE messages SET content = content || ? WHERE id = ?", [text, id]);
  persistDatabase();
}

export function setMessageContent(id: string, content: string): void {
  const db = getDatabase();
  db.run("UPDATE messages SET content = ? WHERE id = ?", [content, id]);
  persistDatabase();
}

export function setMessageReasoning(id: string, reasoning: string): void {
  const db = getDatabase();
  try {
    db.run("UPDATE messages SET reasoning = ? WHERE id = ?", [reasoning, id]);
  } catch (e) {
    console.warn("[setMessageReasoning] Failed:", e);
  }
  persistDatabase();
}

export function setMessageStatus(id: string, status: string): void {
  const db = getDatabase();
  db.run("UPDATE messages SET status = ? WHERE id = ?", [status, id]);
  persistDatabase();
}

// ========== Convert Message to LLM API format ==========

function stripSystemReminders(content: string): string {
  // Remove <system-reminder>...</system-reminder> tags injected by MiMoCode CLI
  return content.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
}

export interface LLMMessage {
  id: string;
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  name?: string;
  tool_calls?: Array<{
    id: string;
    type: string;
    function: { name: string; arguments: string };
  }>;
}

export function messagesToLLMMessages(messages: Message[]): LLMMessage[] {
  const result: LLMMessage[] = [];

  for (const msg of messages) {
    if (msg.role === "user") {
      const cleanContent = stripSystemReminders(msg.content || "(empty)");
      if (!cleanContent) continue; // Skip empty messages after stripping
      result.push({
        id: msg.id,
        role: "user",
        content: cleanContent,
      });
    } else if (msg.role === "assistant") {
      const toolCalls = msg.toolCalls || [];
      const completedTools = toolCalls.filter((t) => t.status === "done" || t.status === "error");

      // Build content: text only (reasoning_content is a separate field for DeepSeek)
      let content = stripSystemReminders(msg.content || "");

      // Include the assistant message if it has text content OR any completed tool calls.
      // Previously this was all-or-nothing: if ANY tool call was still "running",
      // ALL tool calls and results were excluded. This caused the LLM to lose
      // visibility of previous tool results (e.g., wait_for_subagent results),
      // leading to infinite loops where the LLM repeatedly called the same tool.
      //
      // Now: only include COMPLETED tool calls and their results. Running/pending
      // tool calls are simply omitted — they'll be included in the next iteration
      // once they complete.
      if (content || completedTools.length > 0) {
        const assistantMsg: LLMMessage = {
          id: msg.id,
          role: "assistant",
          content,
        };
        // NOTE: Do NOT attach reasoning_content to historical assistant messages.
        // reasoning_content is an OUTPUT-only field (DeepSeek thinking mode).
        // Sending old reasoning back to the API causes the LLM to treat previous
        // thinking patterns as implicit instructions for new requests.
        // Reasoning is still stored in the DB for UI display (thinking process),
        // but it is NOT sent back to the LLM API as input.
        if (completedTools.length > 0) {
          assistantMsg.tool_calls = completedTools.map((tc) => ({
            id: tc.id,
            type: "function",
            function: {
              name: tc.tool,
              arguments: JSON.stringify(tc.args || {}),
            },
          }));
        }
        result.push(assistantMsg);
      }

      // Add tool results for completed tools only
      for (const tc of completedTools) {
        const cleanResult = stripSystemReminders(tc.result || "(no output)");
        result.push({
          id: `${msg.id}-tool-${tc.id}`,
          role: "tool",
          content: cleanResult,
          toolCallId: tc.id,
        });
      }
    }
    // Skip system messages (they're handled separately)
  }

  // Remove orphan tool messages
  const cleaned: LLMMessage[] = [];
  let lastAssistantWithToolCalls = false;
  for (const msg of result) {
    if (msg.role === "assistant") {
      lastAssistantWithToolCalls = !!(msg as any).tool_calls;
      cleaned.push(msg);
    } else if (msg.role === "tool") {
      if (lastAssistantWithToolCalls) {
        cleaned.push(msg);
      }
    } else {
      lastAssistantWithToolCalls = false;
      cleaned.push(msg);
    }
  }

  return cleaned;
}
