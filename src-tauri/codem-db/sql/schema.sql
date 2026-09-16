
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
  metadata TEXT,
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
