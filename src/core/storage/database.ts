import initSqlJs, { type Database as SqlJsDatabase } from "sql.js/dist/sql-asm.js";

let db: SqlJsDatabase | null = null;
/** FTS5 可用性标志 — sql.js (asm) 可能不支持 FTS5，创建失败后避免重复报错 */
let ftsAvailable = false;
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
    console.debug(`[Database] Saved ${data.length} bytes to file`);
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
  message_id TEXT,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  path TEXT,
  content TEXT,
  preview TEXT,
  sandbox_path TEXT,
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

CREATE TABLE IF NOT EXISTS turn_file_changes (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  turn_index INTEGER NOT NULL,
  before_tree TEXT,
  after_tree TEXT,
  patch TEXT,
  changed_files TEXT,
  patch_sha256 TEXT,
  current_brief TEXT,
  status TEXT DEFAULT 'completed',
  created_at INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS agent_profiles (
  id TEXT PRIMARY KEY,
  identity TEXT NOT NULL,
  domain TEXT NOT NULL,
  scope TEXT NOT NULL,
  skills TEXT,
  experience_summary TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS needs_you_pending (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  question TEXT NOT NULL,
  context TEXT,
  confirmed_facts TEXT,
  options TEXT,
  resume_path TEXT,
  iteration INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  from_agent TEXT NOT NULL,
  to_agent TEXT NOT NULL,
  message_type TEXT NOT NULL,
  subject TEXT,
  body TEXT,
  status TEXT DEFAULT 'pending',
  sequence INTEGER NOT NULL,
  created_at INTEGER NOT NULL
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

CREATE TABLE IF NOT EXISTS notebooks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  summary TEXT,
  summary_status TEXT DEFAULT 'pending',
  source_count INTEGER DEFAULT 0,
  chunk_count INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS notebook_sources (
  id TEXT PRIMARY KEY,
  notebook_id TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  content TEXT,
  file_path TEXT,
  url TEXT,
  mime_type TEXT,
  size INTEGER,
  status TEXT DEFAULT 'pending',
  chunk_count INTEGER DEFAULT 0,
  error_message TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (notebook_id) REFERENCES notebooks(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS notebook_chunks (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  notebook_id TEXT NOT NULL,
  content TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  embedding BLOB,
  token_count INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (source_id) REFERENCES notebook_sources(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
CREATE INDEX IF NOT EXISTS idx_tool_calls_message ON tool_calls(message_id);
CREATE INDEX IF NOT EXISTS idx_attachments_session ON attachments(session_id);
CREATE INDEX IF NOT EXISTS idx_accounts_active ON accounts(is_active);
CREATE INDEX IF NOT EXISTS idx_cost_records_session ON cost_records(session_id);
CREATE INDEX IF NOT EXISTS idx_cost_records_timestamp ON cost_records(timestamp);
CREATE INDEX IF NOT EXISTS idx_notebook_sources_notebook ON notebook_sources(notebook_id);
CREATE INDEX IF NOT EXISTS idx_notebook_chunks_notebook ON notebook_chunks(notebook_id);
CREATE INDEX IF NOT EXISTS idx_notebook_chunks_source ON notebook_chunks(source_id);

CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  notebook_id TEXT NOT NULL,
  source_id TEXT,
  title TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  content_type TEXT DEFAULT 'markdown',
  tags TEXT,
  pin_order INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (notebook_id) REFERENCES notebooks(id) ON DELETE CASCADE,
  FOREIGN KEY (source_id) REFERENCES notebook_sources(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS note_links (
  id TEXT PRIMARY KEY,
  source_note_id TEXT NOT NULL,
  target_note_id TEXT NOT NULL,
  link_text TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (source_note_id) REFERENCES notes(id) ON DELETE CASCADE,
  FOREIGN KEY (target_note_id) REFERENCES notes(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_notes_notebook ON notes(notebook_id);
CREATE INDEX IF NOT EXISTS idx_note_links_source ON note_links(source_note_id);
CREATE INDEX IF NOT EXISTS idx_note_links_target ON note_links(target_note_id);

-- A8: Flashcards table for spaced repetition
CREATE TABLE IF NOT EXISTS flashcards (
  id TEXT PRIMARY KEY,
  notebook_id TEXT NOT NULL,
  note_id TEXT,
  front TEXT NOT NULL,
  back TEXT NOT NULL,
  tags TEXT,
  ease_factor REAL NOT NULL DEFAULT 2.5,
  interval_days INTEGER NOT NULL DEFAULT 0,
  repetitions INTEGER NOT NULL DEFAULT 0,
  next_review INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (notebook_id) REFERENCES notebooks(id) ON DELETE CASCADE,
  FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_flashcards_notebook ON flashcards(notebook_id);
CREATE INDEX IF NOT EXISTS idx_flashcards_review ON flashcards(next_review);

CREATE TABLE IF NOT EXISTS delegation_tasks (
  id TEXT PRIMARY KEY,
  source_session_id TEXT NOT NULL,
  target_session_id TEXT NOT NULL,
  task TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  result TEXT,
  error TEXT,
  project_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_delegation_source ON delegation_tasks(source_session_id);
CREATE INDEX IF NOT EXISTS idx_delegation_target ON delegation_tasks(target_session_id);
CREATE INDEX IF NOT EXISTS idx_delegation_project ON delegation_tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_delegation_status ON delegation_tasks(status);

-- ========== 知识图谱表 ==========
-- 借鉴思路来源: Understand-Anything (https://github.com/Egonex-AI/Understand-Anything)
-- 该项目使用 React Flow + JSON 文件存储图谱数据;
-- 我们自研实现: 使用 SQLite 存储图谱节点和边, Canvas 渲染力导向图

CREATE TABLE IF NOT EXISTS graph_nodes (
  id TEXT PRIMARY KEY,
  notebook_id TEXT NOT NULL,
  label TEXT NOT NULL,
  entity_type TEXT NOT NULL DEFAULT 'concept',
  description TEXT,
  source_ids TEXT,
  chunk_ids TEXT,
  weight REAL DEFAULT 1.0,
  community_id INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (notebook_id) REFERENCES notebooks(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS graph_edges (
  id TEXT PRIMARY KEY,
  notebook_id TEXT NOT NULL,
  source_node_id TEXT NOT NULL,
  target_node_id TEXT NOT NULL,
  relation_type TEXT NOT NULL DEFAULT 'related',
  weight REAL DEFAULT 1.0,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (notebook_id) REFERENCES notebooks(id) ON DELETE CASCADE,
  FOREIGN KEY (source_node_id) REFERENCES graph_nodes(id) ON DELETE CASCADE,
  FOREIGN KEY (target_node_id) REFERENCES graph_nodes(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_graph_nodes_notebook ON graph_nodes(notebook_id);
CREATE INDEX IF NOT EXISTS idx_graph_edges_notebook ON graph_edges(notebook_id);
CREATE INDEX IF NOT EXISTS idx_graph_edges_source ON graph_edges(source_node_id);
CREATE INDEX IF NOT EXISTS idx_graph_edges_target ON graph_edges(target_node_id);

-- A14: 笔记本分组/文件夹
CREATE TABLE IF NOT EXISTS notebook_groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  parent_id TEXT,
  sort_order INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (parent_id) REFERENCES notebook_groups(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_notebook_groups_parent ON notebook_groups(parent_id);

-- A17: 笔记版本历史 (快照与回滚)
CREATE TABLE IF NOT EXISTS note_versions (
  id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  tags TEXT,
  version_note TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_note_versions_note ON note_versions(note_id);

-- P0: Message feedback (like / dislike)
CREATE TABLE IF NOT EXISTS message_feedback (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  feedback TEXT NOT NULL CHECK (feedback IN ('like', 'dislike')),
  timestamp INTEGER NOT NULL,
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_message_feedback_message ON message_feedback(message_id);

-- P0: Quick phrases for template inputs
CREATE TABLE IF NOT EXISTS quick_phrases (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  category TEXT,
  usage_count INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_quick_phrases_category ON quick_phrases(category);

-- P1: Prompt drafts for version management
CREATE TABLE IF NOT EXISTS prompt_drafts (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  content TEXT NOT NULL,
  tags TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_prompt_drafts_session ON prompt_drafts(session_id);

-- P1: Todo lists from todo_display tool
CREATE TABLE IF NOT EXISTS todo_lists (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  message_id TEXT,
  todos TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_todo_lists_session ON todo_lists(session_id);

CREATE TABLE IF NOT EXISTS squads (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  leader_agent_id TEXT NOT NULL,
  instructions TEXT,
  project_id TEXT,
  archived INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS squad_members (
  id TEXT PRIMARY KEY,
  squad_id TEXT NOT NULL,
  member_type TEXT NOT NULL DEFAULT 'agent',
  member_id TEXT NOT NULL,
  member_name TEXT NOT NULL,
  role_description TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (squad_id) REFERENCES squads(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_squad_members_squad ON squad_members(squad_id);

CREATE TABLE IF NOT EXISTS issues (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'todo',
  priority TEXT DEFAULT 'normal',
  assignee_type TEXT,
  assignee_id TEXT,
  project_id TEXT,
  squad_id TEXT,
  session_id TEXT,
  labels TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS issue_comments (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL,
  author_type TEXT NOT NULL DEFAULT 'user',
  author_id TEXT,
  author_name TEXT,
  content TEXT NOT NULL,
  is_system INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_issues_project ON issues(project_id);
CREATE INDEX IF NOT EXISTS idx_issues_status ON issues(status);
CREATE INDEX IF NOT EXISTS idx_issues_squad ON issues(squad_id);
CREATE INDEX IF NOT EXISTS idx_issue_comments_issue ON issue_comments(issue_id);

CREATE TABLE IF NOT EXISTS inbox (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  source_type TEXT,
  source_id TEXT,
  project_id TEXT,
  squad_id TEXT,
  issue_id TEXT,
  priority TEXT DEFAULT 'normal',
  read INTEGER DEFAULT 0,
  archived INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_inbox_read ON inbox(read);
CREATE INDEX IF NOT EXISTS idx_inbox_project ON inbox(project_id);
CREATE INDEX IF NOT EXISTS idx_inbox_created ON inbox(created_at);

-- ========== P0-1: Event Sourcing — append-only session event log ==========
-- Design (对标 DeepSeek Harness event-sourcing):
-- - Events are the source of truth; messages are derived projections
-- - Append-only: events are never deleted or updated (except on session deletion)
-- - Supports replay, fork, and projection
CREATE TABLE IF NOT EXISTS session_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_session_events_session ON session_events(session_id, seq);

-- ========== P2-12: Goals table for goal-driven auto-continuation ==========
CREATE TABLE IF NOT EXISTS goals (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  priority TEXT DEFAULT 'normal',
  parent_id TEXT,
  success_criteria TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (parent_id) REFERENCES goals(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_goals_session ON goals(session_id);
CREATE INDEX IF NOT EXISTS idx_goals_status ON goals(status);

-- ========== P2-14: Telemetry events table ==========
CREATE TABLE IF NOT EXISTS telemetry_events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  event_name TEXT NOT NULL,
  event_data TEXT,
  timestamp INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_telemetry_session ON telemetry_events(session_id);
CREATE INDEX IF NOT EXISTS idx_telemetry_name ON telemetry_events(event_name);
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

  // FTS full-text search table — created using fts4 for compatibility with sql.js
  // (sql.js does not include FTS5 support). FTS4 supports the same core features:
  // MATCH, snippet(), UNINDEXED columns, and unicode61 tokenizer.
  try {
    db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS session_fts USING fts4(
  session_id UNINDEXED,
  message_id UNINDEXED,
  content,
  role,
  timestamp UNINDEXED,
  tokenize=unicode61
);`);
    ftsAvailable = true;
  } catch (e) {
    console.warn("[Database] FTS not supported, session full-text search will be unavailable:", e);
    ftsAvailable = false;
  }

  // Seed a global project record (id="") so that global chat sessions
  // (projectId="") satisfy the sessions.project_id foreign key constraint.
  // Without this, createSession / createMessage silently fail for global chats.
  try {
    db.run(
      "INSERT OR IGNORE INTO projects (id, name, path, description, pinned, created_at, last_accessed_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["", "全局对话", "", "Global chat (no project context)", 0, Date.now(), Date.now()]
    );
  } catch (e) {
    console.warn("[Database] Failed to seed global project:", e);
  }

  // Migrations
const migrations = [
"ALTER TABLE messages ADD COLUMN reasoning TEXT",
"ALTER TABLE messages ADD COLUMN generated_files TEXT",
"ALTER TABLE messages ADD COLUMN retrieved_sources TEXT",
"ALTER TABLE projects ADD COLUMN pinned INTEGER DEFAULT 0",
"ALTER TABLE sessions ADD COLUMN pinned INTEGER DEFAULT 0",
"ALTER TABLE attachments ADD COLUMN message_id TEXT",
"ALTER TABLE attachments ADD COLUMN preview TEXT",
"ALTER TABLE attachments ADD COLUMN sandbox_path TEXT",
"ALTER TABLE notebook_sources ADD COLUMN summary TEXT",
"ALTER TABLE notebook_sources ADD COLUMN key_topics TEXT",
"ALTER TABLE notebooks ADD COLUMN group_id TEXT",
"ALTER TABLE messages ADD COLUMN parent_message_id TEXT",
"ALTER TABLE messages ADD COLUMN metadata TEXT",
"ALTER TABLE sessions ADD COLUMN correction_mode INTEGER DEFAULT 0",
"ALTER TABLE sessions ADD COLUMN deep_thinking_mode INTEGER DEFAULT 0",
"ALTER TABLE sessions ADD COLUMN preserve_executor INTEGER DEFAULT 0",
"ALTER TABLE sessions ADD COLUMN execution_mode TEXT",
"ALTER TABLE sessions ADD COLUMN worktree_path TEXT",
"ALTER TABLE sessions ADD COLUMN worktree_branch TEXT",
"ALTER TABLE sessions ADD COLUMN parent_id TEXT", // R3-2.2: Fork support
"ALTER TABLE sessions ADD COLUMN sort_order INTEGER DEFAULT 0", // P2 #29: session reordering
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
    try { await invoke("delete_file", { path }); } catch (e) { console.warn('[database.ts]', e) }
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

export function isFts5Available(): boolean {
  return ftsAvailable;
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
