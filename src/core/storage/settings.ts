import { getDatabase, persistDatabase } from "./database";

// ========== Settings Storage (replaces localStorage) ==========

export function getSetting(key: string): string | null {
  try {
    const db = getDatabase();
    const result = db.exec("SELECT value FROM settings WHERE key = ?", [key]);
    if (result.length > 0 && result[0].values.length > 0) {
      return result[0].values[0][0] as string;
    }
    return null;
  } catch {
    return null;
  }
}

export function setSetting(key: string, value: string): void {
  const db = getDatabase();
  const now = Date.now();
  db.run(
    "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)",
    [key, value, now]
  );
  persistDatabase();
}

export function removeSetting(key: string): void {
  const db = getDatabase();
  db.run("DELETE FROM settings WHERE key = ?", [key]);
  persistDatabase();
}

export function getSettingJSON<T>(key: string, defaultValue: T): T {
  const raw = getSetting(key);
  if (raw === null) return defaultValue;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return defaultValue;
  }
}

export function setSettingJSON(key: string, value: unknown): void {
  setSetting(key, JSON.stringify(value));
}

// ========== MCP Server Storage ==========

export interface McpServerConfig {
  id: string;
  name: string;
  config: string;
  enabled: boolean;
}

export function loadMcpServers(): McpServerConfig[] {
  try {
    const db = getDatabase();
    const result = db.exec("SELECT id, name, config, enabled FROM mcp_servers ORDER BY name");
    if (result.length === 0) return [];
    return result[0].values.map((row: any[]) => ({
      id: row[0] as string,
      name: row[1] as string,
      config: row[2] as string,
      enabled: (row[3] as number) === 1,
    }));
  } catch {
    return [];
  }
}

export function saveMcpServer(id: string, name: string, config: string, enabled: boolean): void {
  const db = getDatabase();
  const now = Date.now();
  db.run(
    "INSERT OR REPLACE INTO mcp_servers (id, name, config, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    [id, name, config, enabled ? 1 : 0, now, now]
  );
  persistDatabase();
}

export function removeMcpServer(id: string): void {
  const db = getDatabase();
  db.run("DELETE FROM mcp_servers WHERE id = ?", [id]);
  persistDatabase();
}

// ========== Memory Storage ==========

export function loadMemory(): string {
  try {
    const db = getDatabase();
    const result = db.exec("SELECT content FROM memory WHERE id = 'default'");
    if (result.length > 0 && result[0].values.length > 0) {
      return result[0].values[0][0] as string;
    }
    return "";
  } catch {
    return "";
  }
}

export function saveMemory(content: string): void {
  const db = getDatabase();
  const now = Date.now();
  db.run(
    "INSERT OR REPLACE INTO memory (id, content, updated_at) VALUES ('default', ?, ?)",
    [content, now]
  );
  persistDatabase();
}

// ========== Recovery Data Storage ==========

export function loadRecoveryData(sessionId: string): string | null {
  try {
    const db = getDatabase();
    const result = db.exec("SELECT data FROM recovery_data WHERE session_id = ?", [sessionId]);
    if (result.length > 0 && result[0].values.length > 0) {
      return result[0].values[0][0] as string;
    }
    return null;
  } catch {
    return null;
  }
}

export function saveRecoveryData(sessionId: string, data: string): void {
  const db = getDatabase();
  const now = Date.now();
  db.run(
    "INSERT OR REPLACE INTO recovery_data (session_id, data, updated_at) VALUES (?, ?, ?)",
    [sessionId, data, now]
  );
  persistDatabase();
}

export function removeRecoveryData(sessionId: string): void {
  const db = getDatabase();
  db.run("DELETE FROM recovery_data WHERE session_id = ?", [sessionId]);
  persistDatabase();
}

// ========== Cost Records Storage ==========

export interface CostRecord {
  id: string;
  sessionId: string;
  model: string;
  provider: string;
  promptTokens: number;
  completionTokens: number;
  cost: number;
  duration: number;
  timestamp: number;
}

export function addCostRecord(record: CostRecord): void {
  const db = getDatabase();
  db.run(
    "INSERT INTO cost_records (id, session_id, model, provider, prompt_tokens, completion_tokens, cost, duration, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [record.id, record.sessionId, record.model, record.provider, record.promptTokens, record.completionTokens, record.cost, record.duration, record.timestamp]
  );
  persistDatabase();
}

export function getCostRecords(limit: number = 1000): CostRecord[] {
  try {
    const db = getDatabase();
    const result = db.exec(
      "SELECT id, session_id, model, provider, prompt_tokens, completion_tokens, cost, duration, timestamp FROM cost_records ORDER BY timestamp DESC LIMIT ?",
      [limit]
    );
    if (result.length === 0) return [];
    return result[0].values.map((row: any[]) => ({
      id: row[0] as string,
      sessionId: row[1] as string,
      model: row[2] as string,
      provider: row[3] as string,
      promptTokens: row[4] as number,
      completionTokens: row[5] as number,
      cost: row[6] as number,
      duration: row[7] as number,
      timestamp: row[8] as number,
    }));
  } catch {
    return [];
  }
}

export function getCostStats(): { totalCost: number; todayCost: number; totalSessions: number; totalTokens: number } {
  try {
    const db = getDatabase();
    
    const totalResult = db.exec("SELECT COALESCE(SUM(cost), 0) FROM cost_records");
    const totalCost = totalResult.length > 0 ? (totalResult[0].values[0][0] as number) : 0;
    
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayResult = db.exec("SELECT COALESCE(SUM(cost), 0) FROM cost_records WHERE timestamp >= ?", [todayStart.getTime()]);
    const todayCost = todayResult.length > 0 ? (todayResult[0].values[0][0] as number) : 0;
    
    const sessionsResult = db.exec("SELECT COUNT(DISTINCT session_id) FROM cost_records");
    const totalSessions = sessionsResult.length > 0 ? (sessionsResult[0].values[0][0] as number) : 0;
    
    const tokensResult = db.exec("SELECT COALESCE(SUM(prompt_tokens + completion_tokens), 0) FROM cost_records");
    const totalTokens = tokensResult.length > 0 ? (tokensResult[0].values[0][0] as number) : 0;
    
    return { totalCost, todayCost, totalSessions, totalTokens };
  } catch {
    return { totalCost: 0, todayCost: 0, totalSessions: 0, totalTokens: 0 };
  }
}
