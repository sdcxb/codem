import initSqlJs, { type Database as SqlJsDatabase } from "sql.js/dist/sql-asm.js";

let db: SqlJsDatabase | null = null;
// DB_STORAGE_KEY was used in old localStorage-based persistence; now using Tauri file system
// const DB_STORAGE_KEY = "codem-sqlite-db";
const DB_FILE_NAME = "codem-db.bin";

const isTauri = () => !!(window as any).__TAURI__;

async function getDbPath(): Promise<string> {
  if (isTauri()) {
    const { invoke } = (window as any).__TAURI__.core;
    const appDir: string = await invoke("get_app_data_dir");
    return `${appDir}${DB_FILE_NAME}`;
  }
  return DB_FILE_NAME;
}

function uint8ToBase64(data: Uint8Array): string {
  let binary = "";
  const chunkSize = 8192;
  for (let i = 0; i < data.length; i += chunkSize) {
    const chunk = data.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function base64ToUint8(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function saveDatabase(): Promise<void> {
  if (!db) return;
  try {
    if (!isTauri()) {
      console.warn("[Database] Browser mode, cannot save");
      return;
    }
    const data = db.export();
    const { invoke } = (window as any).__TAURI__.core;
    const path = await getDbPath();
    const base64 = uint8ToBase64(data);
    await invoke("write_file", { path, content: base64, encoding: "base64" });
    console.log(`[Database] Saved ${data.length} bytes to file`);
  } catch (e) {
    console.error("[Database] Failed to save:", e);
  }
}

let saveDebounceTimer: ReturnType<typeof setTimeout> | null = null;

function saveDatabaseAsync(): void {
  // Debounce: if multiple writes happen in quick succession (e.g. createSession + updateProject),
  // only persist once after the last write
  if (saveDebounceTimer) clearTimeout(saveDebounceTimer);
  saveDebounceTimer = setTimeout(() => {
    saveDatabase().catch(e => console.error("[Database] Async save failed:", e));
    saveDebounceTimer = null;
  }, 500);
}

async function loadDatabaseFromStorage(): Promise<Uint8Array | null> {
  try {
    if (!isTauri()) {
      console.warn("[Database] Browser mode detected, database not available");
      return null;
    }
    
    const { invoke } = (window as any).__TAURI__.core;
    const path = await getDbPath();
    try {
      const base64: string = await invoke("read_file", { path, encoding: "base64" });
      if (base64 && base64.length > 100) {
        const data = base64ToUint8(base64);
        // Validate: SQLite files start with "SQLite format 3"
        const header = String.fromCharCode(...data.slice(0, 16));
        if (header.startsWith("SQLite format")) {
          console.log(`[Database] Loaded ${data.length} bytes from file`);
          return data;
        } else {
          console.warn("[Database] File exists but is not valid SQLite, will create new database");
        }
      }
    } catch {
      // File doesn't exist, will create new database
    }
    return null;
  } catch (e) {
    console.error("[Database] Failed to load:", e);
    return null;
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  description TEXT,
  pinned INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_accessed_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  title TEXT NOT NULL,
  model TEXT,
  created_at INTEGER NOT NULL,
  last_message_at INTEGER NOT NULL,
  message_count INTEGER DEFAULT 0,
  pinned INTEGER DEFAULT 0,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  reasoning TEXT,
  timestamp INTEGER NOT NULL,
  model TEXT,
  prompt_tokens INTEGER DEFAULT 0,
  completion_tokens INTEGER DEFAULT 0,
  cost REAL DEFAULT 0,
  status TEXT DEFAULT 'done',
  generated_files TEXT,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS tool_calls (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  args TEXT NOT NULL,
  result TEXT,
  status TEXT DEFAULT 'pending',
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  path TEXT,
  content TEXT,
  mime_type TEXT,
  size INTEGER,
  added_at INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  url TEXT NOT NULL,
  access_token TEXT NOT NULL,
  refresh_token TEXT,
  token_expiry INTEGER,
  org_id TEXT,
  is_active INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS v2_sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  title TEXT NOT NULL,
  model TEXT,
  messages TEXT NOT NULL DEFAULT '[]',
  total_usage TEXT NOT NULL DEFAULT '{"promptTokens":0,"completionTokens":0,"cost":0}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS mcp_servers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  config TEXT NOT NULL,
  enabled INTEGER DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS memory (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS recovery_data (
  session_id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS cost_records (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  model TEXT NOT NULL,
  provider TEXT NOT NULL,
  prompt_tokens INTEGER DEFAULT 0,
  completion_tokens INTEGER DEFAULT 0,
  cost REAL DEFAULT 0,
  duration INTEGER DEFAULT 0,
  timestamp INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
CREATE INDEX IF NOT EXISTS idx_tool_calls_message ON tool_calls(message_id);
CREATE INDEX IF NOT EXISTS idx_attachments_session ON attachments(session_id);
CREATE INDEX IF NOT EXISTS idx_accounts_active ON accounts(is_active);
CREATE INDEX IF NOT EXISTS idx_cost_records_session ON cost_records(session_id);
CREATE INDEX IF NOT EXISTS idx_cost_records_timestamp ON cost_records(timestamp);
`;

export async function initDatabase(): Promise<SqlJsDatabase> {
  if (db) return db;

  const SQL = await initSqlJs();

  const existingData = await loadDatabaseFromStorage();
  if (existingData) {
    db = new SQL.Database(existingData);
    console.log("[Database] Loaded existing database");
  } else {
    db = new SQL.Database();
    console.log("[Database] Created new database");
  }

  db.run("PRAGMA foreign_keys = ON");
  db.run(SCHEMA);

  // Migrations
const migrations = [
"ALTER TABLE messages ADD COLUMN reasoning TEXT",
"ALTER TABLE messages ADD COLUMN generated_files TEXT",
"ALTER TABLE projects ADD COLUMN pinned INTEGER DEFAULT 0",
"ALTER TABLE sessions ADD COLUMN pinned INTEGER DEFAULT 0",
];
  for (const sql of migrations) {
    try { db.run(sql); } catch (e) { /* column already exists */ }
  }

  // Fix corrupted reasoning values
  try {
    db.run("UPDATE messages SET reasoning = NULL WHERE reasoning IS NOT NULL AND reasoning GLOB '[0-9]*' AND LENGTH(reasoning) >= 10");
  } catch (e) {
    console.warn("[Database] Failed to fix corrupted reasoning:", e);
  }

  await saveDatabase();
  return db;
}

export async function resetDatabase(): Promise<SqlJsDatabase> {
  if (db) {
    db.close();
    db = null;
  }
  if (isTauri()) {
    const { invoke } = (window as any).__TAURI__.core;
    const path = await getDbPath();
    try { await invoke("delete_file", { path }); } catch {}
  }
  return initDatabase();
}

export function getDatabase(): SqlJsDatabase {
  if (!db) throw new Error("Database not initialized. Call initDatabase() first.");
  return db;
}

export function persistDatabase(): void {
saveDatabaseAsync();
}

/** Flush any pending debounced save immediately */
export function flushDatabase(): void {
  if (saveDebounceTimer) {
    clearTimeout(saveDebounceTimer);
    saveDebounceTimer = null;
    saveDatabase().catch(e => console.error("[Database] Flush save failed:", e));
  }
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}

export function exportDatabase(): Uint8Array | null {
  if (!db) return null;
  return db.export();
}

export function importDatabase(data: Uint8Array): void {
  if (db) {
    db.close();
  }
  const SQL = initSqlJs();
  db = new (SQL as any).Database(data);
  persistDatabase();
}
