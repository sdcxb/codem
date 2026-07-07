import { getDatabase, persistDatabase } from "./database";
import type { Message, ToolCall } from "../../store";

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

function rowToMessage(row: MessageRow, toolCalls: ToolCall[]): Message {
  return {
    id: row.id,
    role: row.role as "user" | "assistant" | "system",
    content: row.content,
    reasoning: row.reasoning ?? undefined,
    timestamp: row.timestamp,
    model: row.model ?? undefined,
    status: row.status as Message["status"],
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
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
      return rowToMessage(messageRow, toolCalls);
    } catch (e) {
      console.warn("[listMessages] Failed to convert row:", e);
      return null;
    }
  }).filter((m): m is Message => m !== null);
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
  return rowToMessage(messageRow, toolCalls);
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
      const hasCompleteTools = toolCalls.length > 0 && completedTools.length === toolCalls.length;

      // Build content: text only (reasoning_content is a separate field for DeepSeek)
      let content = stripSystemReminders(msg.content || "");

      if (content || toolCalls.length > 0) {
        const assistantMsg: LLMMessage = {
          id: msg.id,
          role: "assistant",
          content,
        };
        // Include reasoning_content separately for DeepSeek thinking mode
        if (msg.reasoning) {
          (assistantMsg as any).reasoning = msg.reasoning;
        }
        if (hasCompleteTools) {
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

      // Add tool results
      if (hasCompleteTools) {
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
