
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
  -- 内部会话标记（第 189 轮）：子智能体的轨迹会话。它们需要一行 sessions 才能在
  -- messages / session_events / cost_records 上过外键，但**不是用户可见的对话目录**。
  -- 早先靠 id 前缀（sub-）在渲染侧认，与生成规则耦合；这里落成显式列。
  is_internal INTEGER DEFAULT 0,
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

-- 上下文检查点的**运行时索引/审计**（第 262 轮）。
-- 权威仍是 JSONL 里 marker 的 metadata；这张表只做按会话的快速查询与审计，
-- 不参与模型读路径（同步读仍走 messages.metadata 投影，避免异步 IPC）。
--
-- P0-0（D1/E2）：`kind` / `segment_seq` 与 metadata 的 `contextEpoch.kind` /
-- `segmentSeq` 同义。旧行没有这两列时由 DDL 默认值补 `compact` / `1`，
-- 读侧也不依赖它们（`context-view.ts` 自己给默认值）。
CREATE TABLE IF NOT EXISTS context_epochs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0,
  cutoff_message_id TEXT NOT NULL,
  removed_count INTEGER NOT NULL DEFAULT 0,
  kept_count INTEGER NOT NULL DEFAULT 0,
  trigger_kind TEXT,
  kind TEXT NOT NULL DEFAULT 'compact',
  segment_seq INTEGER NOT NULL DEFAULT 1,
  -- P0-0（D1/E2）：switch 的 handoff 摘要（JSON 文本，可空）。
  -- 权威仍是 marker 自身正文/metadata；这里只是派生索引里的可查询副本，
  -- 旧行没有它 ⇒ NULL（读侧不依赖，见 `context-epochs.ts` 的超限截断说明）。
  handoff_json TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_context_epochs_session_seq
  ON context_epochs(session_id, seq);

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

-- ========== P2-C：记忆独立表（结构镜像，**权威仍是 settings 的 `memory` 字段**）==========
--
-- 为什么要有这张表（24 §P2）：`memory` 字段是**整份 JSON 字符串**，一次跨会话/跨项目检索
-- 只能把全部条目读进渲染进程再逐条比 —— 规模一大就没有"有界检索"这回事。
-- 这张表 + `memories_fts`（见 `schema.rs::apply`）只做一件事：给
-- 「显式 opt-in 的跨作用域检索」提供**有界、可过滤**的候选集；
-- 正文、状态、归属的最终判定仍然回到 settings（`MemoryService`），所以这里**允许滞后**。
--
-- 为什么不做外键到 projects/sessions：镜像由渲染侧整批重写，且项目/会话可能已被删
-- （镜像滞后时不该因为外键把整批写入拒掉 —— 那会让"镜像失败"从可容忍变成阻断）。
--
-- 旧库兼容：`apply()` 每次打开都执行本文件，`CREATE TABLE IF NOT EXISTS` 幂等，
-- 所以升级前建的库**不需要**单独的 ALTER/编号迁移（表是新增的，没有列要补）。
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL DEFAULT '',
  project_id TEXT,
  session_id TEXT,
  -- 25:668 团队记忆的归属键（AgentTeam id）；与 `MemoryEntry.teamId` 同名同义。
  -- 为什么必须有这一列：`memories.search` 是唯一一条"可能跨项目"的读路径，
  -- 团队过滤必须写在 SQL 里（与 project/session 同一条 fail-closed 纪律），
  -- 否则 team 条目要么在镜像检索里永远不可见（功能缺失），要么只能靠渲染侧再过滤（多一处泄漏面）。
  team_id TEXT,
  key TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  source TEXT,
  status TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  usage_count INTEGER NOT NULL DEFAULT 0,
  last_used_at INTEGER,
  updated_at INTEGER NOT NULL DEFAULT 0,
  -- 24 号文 P2-C：**持久化的向量**（f32 小端连续字节；NULL = 还没有向量）
  --
  -- 为什么放在这张镜像表而不是另开一张：向量与记忆条目同生命周期（条目删了向量就该消失），
  -- 而这张表的写入方只有一个（`memories.rs` 的镜像命令）。放这里也不会被 `replace_all`
  -- 无条件抹掉 —— 它在同一事务里按「key 与正文都没变」才带回旧向量（见 `replace_all`）。
  --
  -- 为什么还要 `embedding_dim`：两个不同向量空间的余弦是**噪声**，
  -- 检索时必须按维度过滤掉不一致的行（而不是当成 0 分参与排序）。
  embedding BLOB,
  embedding_dim INTEGER
);

-- 跨作用域检索的过滤轴（platform 恒在，project/session/team 任选其一或都给）
CREATE INDEX IF NOT EXISTS idx_memories_owner ON memories(scope, project_id, session_id);
-- 25:668：团队过滤单独一条索引（旧库的 `idx_memories_owner` 已存在、不会被重建，
-- 所以团队轴必须有自己的一条 `IF NOT EXISTS` 索引，否则升级库上的 team 过滤永远走全表扫描）

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

-- 第 44 轮：给三张"有 session_id 但没有外键"的表补上级联语义。
--
-- 为什么不是直接加 FOREIGN KEY：SQLite **不能**给已有表加约束
-- （`ALTER TABLE ... ADD CONSTRAINT` 不存在），唯一办法是"建新表 → 拷数据 → 删旧表 → 改名"。
-- 在一个 100 MB 级的生产库上做整表重建，收益是"和触发器完全相同的语义"，
-- 而风险是"迁移中途失败留下半个表" —— 不值得。
--
-- 为什么不加：这三张表的孤儿行是**真缺陷**，不是理论问题。
-- `needs_you_pending` 的孤儿会让"待你确认"面板在会话已删之后仍然弹出一个无法归属的提问；
-- `agent_messages` 的孤儿让智能体间消息面板显示"来自已删除会话"的消息；
-- `cost_records` 的孤儿则会被成本统计按 session 聚合时算进去，让总额对不上。
-- 而 `sessions` 的删除在真实事故里发生过（一次带走 2131 条事件），
-- 也就是说"会话被删、子表留下"不是假想。
--
-- 触发器与 `ON DELETE CASCADE` 的差别只有一处：**级联深度**（触发器只做一层）。
-- 这三张表都没有下级子表，所以这里是等价的。
CREATE TRIGGER IF NOT EXISTS trg_sessions_cascade_needs_you_pending
AFTER DELETE ON sessions
BEGIN
  DELETE FROM needs_you_pending WHERE session_id = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_sessions_cascade_agent_messages
AFTER DELETE ON sessions
BEGIN
  DELETE FROM agent_messages WHERE session_id = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_sessions_cascade_cost_records
AFTER DELETE ON sessions
BEGIN
  DELETE FROM cost_records WHERE session_id = OLD.id;
END;

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
-- 第 44 轮：`messages.list` 是 `WHERE session_id=? ORDER BY timestamp ASC, id ASC LIMIT ? OFFSET ?`，
-- 而原来只有 `idx_messages_session(session_id)` —— 每次翻页都要把该会话**全部**行取出来重排。
-- 实测（真机基准）：全量分页读 1k→10k→100k 行 = 338 ms → 6.3 s → 159.2 s，
-- 10 倍数据量要 25.2 倍时间（超线性），末页从 34 ms 涨到 217 ms。
-- 复合索引让"按 (session_id, timestamp, id) 有序取一页"变成索引区间扫描，
-- 偏移量再大也只读这一页。第三列 `id` 是为了让排序键**完全**被索引覆盖（同 timestamp 的并列）。
CREATE INDEX IF NOT EXISTS idx_messages_session_ts ON messages(session_id, timestamp, id);
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
--
-- P5 第 1 段（列级契约修正）：note / version / created_at / updated_at 四列
-- 原来是在 llm/feedback.ts 的 ensureNoteColumn() 里用**运行期**
-- ALTER TABLE … ADD COLUMN 加的 —— 这几条 ALTER 对 gen-schema-sql.mjs **不可见**
-- （它只读 SCHEMA），所以 Rust 侧的库根本没有这四列，而 putMessageFeedback()
-- 却按九列写入 → Rust 引擎直接拒收（实测报错：表 message_feedback 没有列 created_at）。
-- 也就是说：宽松版反馈（评分 + 备注 + 乐观并发版本）在 Rust 路径下**写不进去**。
-- 真源必须显式声明这些列；老库由 migrations 里的 ALTER 补齐（幂等）。
--
-- 注意：注释里**不要**出现反引号 —— SCHEMA 是模板字符串，反引号会提前把它结束掉。
CREATE TABLE IF NOT EXISTS message_feedback (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  feedback TEXT NOT NULL CHECK (feedback IN ('like', 'dislike')),
  timestamp INTEGER NOT NULL,
  note TEXT,
  version TEXT,
  created_at INTEGER,
  updated_at INTEGER,
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

-- ========== ADR-0006: Long-horizon Goal Mode（契约 / 计划 / 阶段 / 证据 / 决策）==========
-- 与旧 goals 表**不是**同一套东西：旧表是 title/description 粒度的短步目标记录，
-- 这里是不变契约 + 版本化里程碑计划 + 阶段证据。五张表都由渲染侧 goal/store.ts 读写。
CREATE TABLE IF NOT EXISTS goal_contracts (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  statement TEXT NOT NULL,
  principles TEXT NOT NULL DEFAULT '[]',
  non_goals TEXT NOT NULL DEFAULT '[]',
  acceptance TEXT NOT NULL DEFAULT '[]',
  constraints TEXT NOT NULL DEFAULT '[]',
  budget TEXT NOT NULL DEFAULT '{"mode":"unlimited"}',
  status TEXT NOT NULL DEFAULT 'active',
  max_replans INTEGER NOT NULL DEFAULT 5,
  replan_count INTEGER NOT NULL DEFAULT 0,
  usage TEXT NOT NULL DEFAULT '{}',
  started_at INTEGER,
  blocked_reason TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_goal_contracts_session ON goal_contracts(session_id, status);

CREATE TABLE IF NOT EXISTS goal_plans (
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  contract_version INTEGER NOT NULL DEFAULT 1,
  strategy TEXT NOT NULL,
  invariants TEXT NOT NULL DEFAULT '[]',
  revision TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (goal_id) REFERENCES goal_contracts(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_goal_plans_goal ON goal_plans(goal_id, version);

CREATE TABLE IF NOT EXISTS goal_phases (
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL,
  plan_version INTEGER NOT NULL,
  phase_key TEXT NOT NULL,
  order_index INTEGER NOT NULL,
  title TEXT NOT NULL,
  outcome TEXT NOT NULL,
  acceptance TEXT NOT NULL DEFAULT '[]',
  covers TEXT NOT NULL DEFAULT '[]',
  depends_on TEXT NOT NULL DEFAULT '[]',
  risks TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  rework_of TEXT,
  started_at INTEGER,
  completed_at INTEGER,
  FOREIGN KEY (goal_id) REFERENCES goal_contracts(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_goal_phases_goal ON goal_phases(goal_id, plan_version, order_index);

CREATE TABLE IF NOT EXISTS goal_evidence (
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL,
  plan_version INTEGER NOT NULL,
  phase_key TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0,
  kind TEXT NOT NULL,
  acceptance_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  detail TEXT,
  passed INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (goal_id) REFERENCES goal_contracts(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_goal_evidence_phase ON goal_evidence(goal_id, phase_key, created_at);

CREATE TABLE IF NOT EXISTS goal_decisions (
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  reason TEXT NOT NULL,
  plan_version INTEGER,
  phase_key TEXT,
  payload TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (goal_id) REFERENCES goal_contracts(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_goal_decisions_goal ON goal_decisions(goal_id, created_at);

