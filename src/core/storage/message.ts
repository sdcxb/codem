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
    `SELECT id, session_id, role, content, timestamp, model, prompt_tokens, completion_tokens, cost, status, reasoning FROM messages WHERE session_id = ? ORDER BY timestamp ASC ${limitClause}`,
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
  const result = db.exec("SELECT id, session_id, role, content, timestamp, model, prompt_tokens, completion_tokens, cost, status, reasoning FROM messages WHERE id = ?", [id]);
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
    db.run(`UPDATE messages SET ${fields.join(", ")} WHERE id = ?`, values);
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

export function getMessageCount(sessionId: string): number {
  const db = getDatabase();
  const result = db.exec("SELECT COUNT(*) FROM messages WHERE session_id = ?", [sessionId]);
  if (result.length === 0) return 0;
  return result[0].values[0][0] as number;
}
