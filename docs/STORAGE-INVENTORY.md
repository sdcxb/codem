# 存储调用面盘点（P0 自动生成）

> 由 `node tools/audit/storage-inventory.mjs --md` 生成；不要手工编辑。

- 扫描生产文件：**831**
- SQL 调用点：**159**
- 涉及表：**38**
- 需要实现的仓储方法（表 × 操作）：**82**

## 仓储方法清单（按调用点数量排序）

| 仓储方法 | 调用点 | 切换顺序建议 |
|---|---:|---|
| `messages.update` | 13 | 3 数据面 |
| `accounts.select` | 7 | 5 其余域 |
| `accounts.update` | 6 | 5 其余域 |
| `messages.select` | 6 | 3 数据面 |
| `cost_records.select` | 4 | 5 其余域 |
| `graph_nodes.update` | 4 | 5 其余域 |
| `inbox.update` | 4 | 5 其余域 |
| `message_feedback.alter` | 4 | 5 其余域 |
| `message_feedback.delete` | 4 | 5 其余域 |
| `notebooks.select` | 4 | 5 其余域 |
| `telemetry_events.select` | 4 | 2 只追加（入队） |
| `tool_calls.delete` | 4 | 3 数据面 |
| `graph_edges.delete` | 3 | 5 其余域 |
| `inbox.delete` | 3 | 5 其余域 |
| `notebook_groups.select` | 3 | 5 其余域 |
| `session_events.delete` | 3 | 2 只追加（入队） |
| `sessions.update` | 3 | 4 会话/项目 |
| `accounts.delete` | 2 | 5 其余域 |
| `agent_profiles.select` | 2 | 5 其余域 |
| `attachments.select` | 2 | 3 数据面 |
| `flashcards.delete` | 2 | 5 其余域 |
| `graph_nodes.delete` | 2 | 5 其余域 |
| `issues.update` | 2 | 5 其余域 |
| `messages.delete` | 2 | 3 数据面 |
| `notebooks.update` | 2 | 5 其余域 |
| `notes.delete` | 2 | 5 其余域 |
| `projects.select` | 2 | 4 会话/项目 |
| `sessions.select` | 2 | 4 会话/项目 |
| `squads.update` | 2 | 5 其余域 |
| `telemetry_events.delete` | 2 | 2 只追加（入队） |
| `todo_lists.select` | 2 | 5 其余域 |
| `v2_sessions.select` | 2 | 5 其余域 |
| `agent_profiles.delete` | 1 | 5 其余域 |
| `agent_profiles.update` | 1 | 5 其余域 |
| `attachments.update` | 1 | 3 数据面 |
| `delegation_tasks.delete` | 1 | 5 其余域 |
| `delegation_tasks.select` | 1 | 5 其余域 |
| `delegation_tasks.update` | 1 | 5 其余域 |
| `flashcards.select` | 1 | 5 其余域 |
| `flashcards.update` | 1 | 5 其余域 |
| `goals.update` | 1 | 5 其余域 |
| `graph_nodes.select` | 1 | 5 其余域 |
| `issue_comments.delete` | 1 | 5 其余域 |
| `issue_comments.select` | 1 | 5 其余域 |
| `issues.delete` | 1 | 5 其余域 |
| `issues.select` | 1 | 5 其余域 |
| `mcp_servers.delete` | 1 | 5 其余域 |
| `mcp_servers.select` | 1 | 5 其余域 |
| `memory.select` | 1 | 5 其余域 |
| `message_feedback.select` | 1 | 5 其余域 |
| `note_links.delete` | 1 | 5 其余域 |
| `note_versions.delete` | 1 | 5 其余域 |
| `notebook_chunks.delete` | 1 | 5 其余域 |
| `notebook_groups.delete` | 1 | 5 其余域 |
| `notebook_groups.update` | 1 | 5 其余域 |
| `notebook_sources.delete` | 1 | 5 其余域 |
| `notebook_sources.update` | 1 | 5 其余域 |
| `notebooks.delete` | 1 | 5 其余域 |
| `notes.select` | 1 | 5 其余域 |
| `notes.update` | 1 | 5 其余域 |
| `projects.delete` | 1 | 4 会话/项目 |
| `projects.update` | 1 | 4 会话/项目 |
| `prompt_drafts.delete` | 1 | 5 其余域 |
| `quick_phrases.delete` | 1 | 1 配置面（同步缓存 + 写穿） |
| `recovery_data.delete` | 1 | 5 其余域 |
| `recovery_data.select` | 1 | 5 其余域 |
| `session_fts.delete` | 1 | 3 数据面 |
| `session_fts.insert` | 1 | 3 数据面 |
| `session_fts.select` | 1 | 3 数据面 |
| `sessions.delete` | 1 | 4 会话/项目 |
| `settings.delete` | 1 | 1 配置面（同步缓存 + 写穿） |
| `settings.select` | 1 | 1 配置面（同步缓存 + 写穿） |
| `squad_members.delete` | 1 | 5 其余域 |
| `squad_members.select` | 1 | 5 其余域 |
| `squad_members.update` | 1 | 5 其余域 |
| `squads.delete` | 1 | 5 其余域 |
| `squads.select` | 1 | 5 其余域 |
| `tool_calls.update` | 1 | 3 数据面 |
| `turn_file_changes.delete` | 1 | 5 其余域 |
| `turn_file_changes.select` | 1 | 5 其余域 |
| `turn_file_changes.update` | 1 | 5 其余域 |
| `v2_sessions.delete` | 1 | 5 其余域 |

## 明细（文件 → 行：方法）

### src/core/storage/message.ts（31）

- :145 → `messages.select`
- :157 → `messages.select`
- :186 → `messages.delete`
- :478 → `attachments.update`
- :511 → `messages.select`
- :517 → `session_fts.select`
- :523 → `session_fts.delete`
- :531 → `session_fts.insert`
- :584 → `messages.select`
- :660 → `messages.select`
- :694 → `messages.update`
- :704 → `messages.update`
- :870 → `messages.update`
- :881 → `messages.update`
- :891 → `messages.update`
- :899 → `tool_calls.delete`
- :937 → `messages.update`
- :968 → `tool_calls.update`
- :982 → `messages.delete`
- :1032 → `tool_calls.delete`
- :1069 → `messages.update`
- :1120 → `messages.select`
- :1142 → `message_feedback.delete`
- :1166 → `message_feedback.select`
- :1212 → `tool_calls.delete`
- :1213 → `message_feedback.delete`
- :1237 → `messages.update`
- :1246 → `messages.update`
- :1253 → `messages.update`
- :1261 → `messages.update`
- :1271 → `messages.update`

### src/core/knowledge/storage.ts（30）

- :108 → `notebooks.select`
- :115 → `notebooks.select`
- :123 → `notebooks.select`
- :124 → `notebooks.select`
- :149 → `notebooks.update`
- :160 → `notebooks.delete`
- :281 → `notebook_sources.update`
- :292 → `notebook_sources.delete`
- :381 → `notebook_chunks.delete`
- :434 → `notes.select`
- :469 → `notes.update`
- :480 → `notes.delete`
- :486 → `notes.delete`
- :697 → `graph_edges.delete`
- :698 → `graph_nodes.delete`
- :704 → `graph_nodes.update`
- :726 → `graph_nodes.update`
- :729 → `graph_nodes.select`
- :737 → `graph_nodes.update`
- :792 → `notebook_groups.select`
- :794 → `notebook_groups.select`
- :795 → `notebook_groups.select`
- :815 → `notebook_groups.update`
- :827 → `notebooks.update`
- :829 → `notebook_groups.delete`
- :908 → `note_versions.delete`
- :949 → `graph_nodes.update`
- :960 → `graph_edges.delete`
- :961 → `graph_nodes.delete`
- :967 → `graph_edges.delete`

### src/core/storage/settings.ts（12）

- :9 → `settings.select`
- :31 → `settings.delete`
- :104 → `quick_phrases.delete`
- :132 → `mcp_servers.select`
- :157 → `mcp_servers.delete`
- :166 → `memory.select`
- :191 → `recovery_data.select`
- :213 → `recovery_data.delete`
- :268 → `cost_records.select`
- :273 → `cost_records.select`
- :276 → `cost_records.select`
- :279 → `cost_records.select`

### src/core/storage/account.ts（8）

- :62 → `accounts.select`
- :69 → `accounts.select`
- :76 → `accounts.select`
- :83 → `accounts.select`
- :136 → `accounts.update`
- :147 → `accounts.delete`
- :153 → `accounts.update`
- :154 → `accounts.update`

### src/core/auth/storage.ts（7）

- :35 → `accounts.select`
- :44 → `accounts.select`
- :53 → `accounts.select`
- :84 → `accounts.update`
- :95 → `accounts.delete`
- :101 → `accounts.update`
- :102 → `accounts.update`

### src/core/inbox/inbox-storage.ts（7）

- :47 → `inbox.delete`
- :70 → `inbox.update`
- :77 → `inbox.update`
- :80 → `inbox.update`
- :87 → `inbox.update`
- :93 → `inbox.delete`
- :109 → `inbox.delete`

### src/core/squad/squad-storage.ts（7）

- :51 → `squads.select`
- :92 → `squads.update`
- :103 → `squads.update`
- :110 → `squads.delete`
- :130 → `squad_members.select`
- :137 → `squad_members.delete`
- :143 → `squad_members.update`

### src/core/issue/issue-storage.ts（6）

- :61 → `issues.select`
- :106 → `issues.update`
- :114 → `issues.delete`
- :130 → `issues.update`
- :138 → `issue_comments.select`
- :145 → `issue_comments.delete`

### src/core/llm/feedback.ts（6）

- :116 → `message_feedback.alter`
- :121 → `message_feedback.alter`
- :126 → `message_feedback.alter`
- :131 → `message_feedback.alter`
- :184 → `message_feedback.delete`
- :265 → `message_feedback.delete`

### src/core/storage/session.ts（6）

- :74 → `sessions.select`
- :122 → `sessions.update`
- :129 → `sessions.delete`
- :136 → `sessions.select`
- :139 → `sessions.update`
- :218 → `sessions.update`

### src/core/knowledge/flashcard-store.ts（4）

- :57 → `flashcards.select`
- :124 → `flashcards.update`
- :134 → `flashcards.delete`
- :139 → `flashcards.delete`

### src/core/storage/agent-profile-storage.ts（4）

- :62 → `agent_profiles.select`
- :74 → `agent_profiles.select`
- :101 → `agent_profiles.update`
- :108 → `agent_profiles.delete`

### src/core/storage/project.ts（4）

- :31 → `projects.select`
- :48 → `projects.select`
- :88 → `projects.update`
- :99 → `projects.delete`

### src/core/telemetry/telemetry.ts（4）

- :185 → `telemetry_events.select`
- :188 → `telemetry_events.select`
- :191 → `telemetry_events.select`
- :196 → `telemetry_events.select`

### src/core/session/delegation-storage.ts（3）

- :96 → `delegation_tasks.update`
- :108 → `delegation_tasks.select`
- :218 → `delegation_tasks.delete`

### src/core/storage/file-change-storage.ts（3）

- :95 → `turn_file_changes.select`
- :116 → `turn_file_changes.update`
- :129 → `turn_file_changes.delete`

### src/core/storage/session-log-bridge.ts（3）

- :30 → `attachments.select`
- :35 → `attachments.select`
- :154 → `tool_calls.delete`

### src/core/storage/v2-session.ts（3）

- :8 → `v2_sessions.select`
- :34 → `v2_sessions.select`
- :55 → `v2_sessions.delete`

### src/core/llm/tools/show-todo.ts（2）

- :136 → `todo_lists.select`
- :151 → `todo_lists.select`

### src/core/storage/database.ts（2）

- :1187 → `messages.update`
- :1416 → `telemetry_events.delete`

### src/core/storage/event-log.ts（2）

- :175 → `session_events.delete`
- :284 → `session_events.delete`

### src/components/PerformanceDashboard.tsx（1）

- :80 → `telemetry_events.delete`

### src/core/goal/goal.ts（1）

- :91 → `goals.update`

### src/core/knowledge/note-manager.ts（1）

- :207 → `note_links.delete`

### src/core/storage/persistence-provider.ts（1）

- :187 → `session_events.delete`

### src/core/storage/prompt-draft.ts（1）

- :75 → `prompt_drafts.delete`
