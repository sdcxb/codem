import initSqlJs, { type Database as SqlJsDatabase } from "sql.js/dist/sql-asm.js";

let db: SqlJsDatabase | null = null;
const DB_STORAGE_KEY = "mimo-sqlite-db";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  description TEXT,
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
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  model TEXT,
  prompt_tokens INTEGER DEFAULT 0,
  completion_tokens INTEGER DEFAULT 0,
  cost REAL DEFAULT 0,
  status TEXT DEFAULT 'done',
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

CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
CREATE INDEX IF NOT EXISTS idx_tool_calls_message ON tool_calls(message_id);
CREATE INDEX IF NOT EXISTS idx_attachments_session ON attachments(session_id);
CREATE INDEX IF NOT EXISTS idx_accounts_active ON accounts(is_active);
`;

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

function saveDatabase(): void {
  if (!db) return;
  try {
    const data = db.export();
    const base64 = uint8ToBase64(data);
    localStorage.setItem(DB_STORAGE_KEY, base64);
    console.log(`[Database] Saved ${data.length} bytes`);
  } catch (e) {
    console.error("[Database] Failed to save:", e);
  }
}

function loadDatabaseFromStorage(): Uint8Array | null {
  try {
    const base64 = localStorage.getItem(DB_STORAGE_KEY);
    if (!base64) return null;
    const bytes = base64ToUint8(base64);
    console.log(`[Database] Loaded ${bytes.length} bytes`);
    return bytes;
  } catch (e) {
    console.error("[Database] Failed to load:", e);
    return null;
  }
}

export async function initDatabase(): Promise<SqlJsDatabase> {
  if (db) return db;

  const SQL = await initSqlJs();

  // Try to load existing database from localStorage
  const existingData = loadDatabaseFromStorage();
  if (existingData) {
    db = new SQL.Database(existingData);
    console.log("[Database] Loaded existing database from localStorage");
  } else {
    db = new SQL.Database();
    console.log("[Database] Created new database");
  }

  // Enable foreign keys
  db.run("PRAGMA foreign_keys = ON");

  // Create tables if not exist
  db.run(SCHEMA);

  // Save after schema creation
  saveDatabase();

  return db;
}

export async function resetDatabase(): Promise<SqlJsDatabase> {
  if (db) {
    db.close();
    db = null;
  }
  localStorage.removeItem(DB_STORAGE_KEY);
  return initDatabase();
}

export function getDatabase(): SqlJsDatabase {
  if (!db) throw new Error("Database not initialized. Call initDatabase() first.");
  return db;
}

export function persistDatabase(): void {
  saveDatabase();
}

export function closeDatabase(): void {
  saveDatabase();
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
  // @ts-ignore - sql.js constructor accepts buffer
  db = new SQL.Database(data);
  saveDatabase();
}
