# 存储调用面盘点（P0 自动生成）

> 由 `node tools/audit/storage-inventory.mjs --md` 生成；不要手工编辑。

- 扫描生产文件：**836**
- SQL 调用点：**277**
- 涉及表：**38**
- 需要实现的仓储方法（表 × 操作）：**129**

## 仓储方法清单（按调用点数量排序）

| 仓储方法 | 调用点 | 切换顺序建议 |
|---|---:|---|
| `messages.update` | 13 | 3 数据面 |
| `messages.select` | 11 | 3 数据面 |
| `session_events.select` | 11 | 2 只追加（入队） |
| `accounts.select` | 7 | 5 其余域 |
| `session_events.insert` | 7 | 2 只追加（入队） |
| `accounts.update` | 6 | 5 其余域 |
| `attachments.select` | 6 | 3 数据面 |
| `delegation_tasks.select` | 6 | 5 其余域 |
| `sessions.select` | 6 | 4 会话/项目 |
| `telemetry_events.select` | 6 | 2 只追加（入队） |
| `cost_records.select` | 5 | 5 其余域 |
| `flashcards.select` | 5 | 5 其余域 |
| `graph_nodes.update` | 4 | 5 其余域 |
| `inbox.update` | 4 | 5 其余域 |
| `message_feedback.alter` | 4 | 5 其余域 |
| `message_feedback.delete` | 4 | 5 其余域 |
| `messages.delete` | 4 | 3 数据面 |
| `notebooks.select` | 4 | 5 其余域 |
| `tool_calls.delete` | 4 | 3 数据面 |
| `tool_calls.insert` | 4 | 3 数据面 |
| `graph_edges.delete` | 3 | 5 其余域 |
| `graph_nodes.select` | 3 | 5 其余域 |
| `inbox.delete` | 3 | 5 其余域 |
| `message_feedback.select` | 3 | 5 其余域 |
| `notebook_chunks.select` | 3 | 5 其余域 |
| `notebook_groups.select` | 3 | 5 其余域 |
| `notebook_sources.select` | 3 | 5 其余域 |
| `notebooks.update` | 3 | 5 其余域 |
| `prompt_drafts.select` | 3 | 5 其余域 |
| `session_events.delete` | 3 | 2 只追加（入队） |
| `sessions.update` | 3 | 4 会话/项目 |
| `accounts.delete` | 2 | 5 其余域 |
| `accounts.insert` | 2 | 5 其余域 |
| `agent_profiles.select` | 2 | 5 其余域 |
| `flashcards.delete` | 2 | 5 其余域 |
| `flashcards.update` | 2 | 5 其余域 |
| `goals.select` | 2 | 5 其余域 |
| `graph_edges.select` | 2 | 5 其余域 |
| `graph_nodes.delete` | 2 | 5 其余域 |
| `issues.update` | 2 | 5 其余域 |
| `message_feedback.insert` | 2 | 5 其余域 |
| `note_links.select` | 2 | 5 其余域 |
| `note_versions.select` | 2 | 5 其余域 |
| `notebook_chunks.insert` | 2 | 5 其余域 |
| `notes.delete` | 2 | 5 其余域 |
| `notes.select` | 2 | 5 其余域 |
| `projects.insert` | 2 | 4 会话/项目 |
| `projects.select` | 2 | 4 会话/项目 |
| `session_fts.insert` | 2 | 3 数据面 |
| `sessions.insert` | 2 | 4 会话/项目 |
| `squads.select` | 2 | 5 其余域 |
| `squads.update` | 2 | 5 其余域 |
| `telemetry_events.delete` | 2 | 2 只追加（入队） |
| `todo_lists.select` | 2 | 5 其余域 |
| `turn_file_changes.select` | 2 | 5 其余域 |
| `v2_sessions.select` | 2 | 5 其余域 |
| `agent_profiles.delete` | 1 | 5 其余域 |
| `agent_profiles.insert` | 1 | 5 其余域 |
| `agent_profiles.update` | 1 | 5 其余域 |
| `attachments.insert` | 1 | 3 数据面 |
| `attachments.update` | 1 | 3 数据面 |
| `cost_records.insert` | 1 | 5 其余域 |
| `delegation_tasks.delete` | 1 | 5 其余域 |
| `delegation_tasks.update` | 1 | 5 其余域 |
| `flashcards.insert` | 1 | 5 其余域 |
| `goals.insert` | 1 | 5 其余域 |
| `goals.update` | 1 | 5 其余域 |
| `graph_edges.insert` | 1 | 5 其余域 |
| `graph_nodes.insert` | 1 | 5 其余域 |
| `inbox.insert` | 1 | 5 其余域 |
| `issue_comments.delete` | 1 | 5 其余域 |
| `issue_comments.insert` | 1 | 5 其余域 |
| `issue_comments.select` | 1 | 5 其余域 |
| `issues.delete` | 1 | 5 其余域 |
| `issues.insert` | 1 | 5 其余域 |
| `issues.select` | 1 | 5 其余域 |
| `mcp_servers.delete` | 1 | 5 其余域 |
| `mcp_servers.insert` | 1 | 5 其余域 |
| `mcp_servers.select` | 1 | 5 其余域 |
| `memory.insert` | 1 | 5 其余域 |
| `memory.select` | 1 | 5 其余域 |
| `messages.insert` | 1 | 3 数据面 |
| `note_links.delete` | 1 | 5 其余域 |
| `note_links.insert` | 1 | 5 其余域 |
| `note_versions.delete` | 1 | 5 其余域 |
| `note_versions.insert` | 1 | 5 其余域 |
| `notebook_chunks.delete` | 1 | 5 其余域 |
| `notebook_groups.delete` | 1 | 5 其余域 |
| `notebook_groups.insert` | 1 | 5 其余域 |
| `notebook_groups.update` | 1 | 5 其余域 |
| `notebook_sources.delete` | 1 | 5 其余域 |
| `notebook_sources.insert` | 1 | 5 其余域 |
| `notebook_sources.update` | 1 | 5 其余域 |
| `notebooks.delete` | 1 | 5 其余域 |
| `notebooks.insert` | 1 | 5 其余域 |
| `notes.insert` | 1 | 5 其余域 |
| `notes.update` | 1 | 5 其余域 |
| `projects.delete` | 1 | 4 会话/项目 |
| `projects.update` | 1 | 4 会话/项目 |
| `prompt_drafts.delete` | 1 | 5 其余域 |
| `prompt_drafts.insert` | 1 | 5 其余域 |
| `quick_phrases.delete` | 1 | 1 配置面（同步缓存 + 写穿） |
| `quick_phrases.select` | 1 | 1 配置面（同步缓存 + 写穿） |
| `quick_phrases.update` | 1 | 1 配置面（同步缓存 + 写穿） |
| `recovery_data.delete` | 1 | 5 其余域 |
| `recovery_data.insert` | 1 | 5 其余域 |
| `recovery_data.select` | 1 | 5 其余域 |
| `session_fts.delete` | 1 | 3 数据面 |
| `session_fts.select` | 1 | 3 数据面 |
| `sessions.delete` | 1 | 4 会话/项目 |
| `settings.delete` | 1 | 1 配置面（同步缓存 + 写穿） |
| `settings.insert` | 1 | 1 配置面（同步缓存 + 写穿） |
| `settings.select` | 1 | 1 配置面（同步缓存 + 写穿） |
| `squad_members.delete` | 1 | 5 其余域 |
| `squad_members.insert` | 1 | 5 其余域 |
| `squad_members.select` | 1 | 5 其余域 |
| `squad_members.update` | 1 | 5 其余域 |
| `squads.delete` | 1 | 5 其余域 |
| `squads.insert` | 1 | 5 其余域 |
| `telemetry_events.insert` | 1 | 2 只追加（入队） |
| `todo_lists.insert` | 1 | 5 其余域 |
| `todo_lists.update` | 1 | 5 其余域 |
| `tool_calls.select` | 1 | 3 数据面 |
| `tool_calls.update` | 1 | 3 数据面 |
| `turn_file_changes.delete` | 1 | 5 其余域 |
| `turn_file_changes.update` | 1 | 5 其余域 |
| `v2_sessions.delete` | 1 | 5 其余域 |
| `v2_sessions.insert` | 1 | 5 其余域 |
| `v2_sessions.update` | 1 | 5 其余域 |

## 明细（文件 → 行：方法）

### src/core/knowledge/storage.ts（56）

- :85 → `notebooks.insert`
- :108 → `notebooks.select`
- :115 → `notebooks.select`
- :123 → `notebooks.select`
- :124 → `notebooks.select`
- :149 → `notebooks.update`
- :160 → `notebooks.delete`
- :168 → `notebook_sources.select`
- :174 → `notebook_chunks.select`
- :180 → `notebooks.update`
- :209 → `notebook_sources.insert`
- :245 → `notebook_sources.select`
- :255 → `notebook_sources.select`
- :281 → `notebook_sources.update`
- :292 → `notebook_sources.delete`
- :329 → `notebook_chunks.insert`
- :349 → `notebook_chunks.insert`
- :361 → `notebook_chunks.select`
- :371 → `notebook_chunks.select`
- :381 → `notebook_chunks.delete`
- :411 → `notes.insert`
- :434 → `notes.select`
- :441 → `notes.select`
- :469 → `notes.update`
- :480 → `notes.delete`
- :486 → `notes.delete`
- :523 → `note_links.insert`
- :539 → `note_links.select`
- :549 → `note_links.select`
- :592 → `graph_nodes.insert`
- :617 → `graph_nodes.select`
- :642 → `graph_edges.select`
- :675 → `graph_edges.insert`
- :697 → `graph_edges.delete`
- :698 → `graph_nodes.delete`
- :704 → `graph_nodes.update`
- :719 → `graph_nodes.select`
- :726 → `graph_nodes.update`
- :729 → `graph_nodes.select`
- :737 → `graph_nodes.update`
- :773 → `notebook_groups.insert`
- :792 → `notebook_groups.select`
- :794 → `notebook_groups.select`
- :795 → `notebook_groups.select`
- :815 → `notebook_groups.update`
- :827 → `notebooks.update`
- :829 → `notebook_groups.delete`
- :858 → `note_versions.insert`
- :868 → `note_versions.select`
- :878 → `note_versions.select`
- :908 → `note_versions.delete`
- :949 → `graph_nodes.update`
- :960 → `graph_edges.delete`
- :961 → `graph_nodes.delete`
- :967 → `graph_edges.delete`
- :973 → `graph_edges.select`

### src/core/storage/message.ts（50）

- :91 → `tool_calls.select`
- :101 → `attachments.select`
- :145 → `messages.select`
- :157 → `messages.select`
- :167 → `messages.select`
- :175 → `attachments.select`
- :186 → `messages.delete`
- :362 → `messages.select`
- :423 → `attachments.select`
- :478 → `attachments.update`
- :511 → `messages.select`
- :517 → `session_fts.select`
- :523 → `session_fts.delete`
- :531 → `session_fts.insert`
- :556 → `attachments.select`
- :584 → `messages.select`
- :660 → `messages.select`
- :674 → `messages.insert`
- :694 → `messages.update`
- :704 → `messages.update`
- :713 → `tool_calls.insert`
- :727 → `attachments.insert`
- :793 → `session_fts.insert`
- :870 → `messages.update`
- :881 → `messages.update`
- :891 → `messages.update`
- :899 → `tool_calls.delete`
- :901 → `tool_calls.insert`
- :937 → `messages.update`
- :944 → `tool_calls.insert`
- :968 → `tool_calls.update`
- :982 → `messages.delete`
- :1023 → `messages.select`
- :1032 → `tool_calls.delete`
- :1035 → `messages.delete`
- :1069 → `messages.update`
- :1120 → `messages.select`
- :1142 → `message_feedback.delete`
- :1149 → `message_feedback.insert`
- :1166 → `message_feedback.select`
- :1194 → `messages.select`
- :1203 → `messages.select`
- :1212 → `tool_calls.delete`
- :1213 → `message_feedback.delete`
- :1215 → `messages.delete`
- :1237 → `messages.update`
- :1246 → `messages.update`
- :1253 → `messages.update`
- :1261 → `messages.update`
- :1271 → `messages.update`

### src/core/storage/settings.ts（20）

- :9 → `settings.select`
- :22 → `settings.insert`
- :31 → `settings.delete`
- :83 → `quick_phrases.select`
- :104 → `quick_phrases.delete`
- :112 → `quick_phrases.update`
- :132 → `mcp_servers.select`
- :148 → `mcp_servers.insert`
- :157 → `mcp_servers.delete`
- :166 → `memory.select`
- :179 → `memory.insert`
- :191 → `recovery_data.select`
- :204 → `recovery_data.insert`
- :213 → `recovery_data.delete`
- :233 → `cost_records.insert`
- :243 → `cost_records.select`
- :268 → `cost_records.select`
- :273 → `cost_records.select`
- :276 → `cost_records.select`
- :279 → `cost_records.select`

### src/core/storage/event-log.ts（11）

- :58 → `session_events.insert`
- :107 → `session_events.insert`
- :171 → `session_events.insert`
- :175 → `session_events.delete`
- :190 → `session_events.select`
- :212 → `session_events.select`
- :233 → `session_events.select`
- :255 → `session_events.select`
- :269 → `session_events.select`
- :284 → `session_events.delete`
- :302 → `session_events.insert`

### src/core/knowledge/flashcard-store.ts（10）

- :46 → `flashcards.insert`
- :57 → `flashcards.select`
- :64 → `flashcards.select`
- :75 → `flashcards.select`
- :86 → `flashcards.select`
- :98 → `flashcards.select`
- :124 → `flashcards.update`
- :134 → `flashcards.delete`
- :139 → `flashcards.delete`
- :188 → `flashcards.update`

### src/core/squad/squad-storage.ts（10）

- :40 → `squads.insert`
- :51 → `squads.select`
- :68 → `squads.select`
- :92 → `squads.update`
- :103 → `squads.update`
- :110 → `squads.delete`
- :119 → `squad_members.insert`
- :130 → `squad_members.select`
- :137 → `squad_members.delete`
- :143 → `squad_members.update`

### src/core/llm/feedback.ts（9）

- :116 → `message_feedback.alter`
- :121 → `message_feedback.alter`
- :126 → `message_feedback.alter`
- :131 → `message_feedback.alter`
- :184 → `message_feedback.delete`
- :187 → `message_feedback.insert`
- :223 → `message_feedback.select`
- :265 → `message_feedback.delete`
- :276 → `message_feedback.select`

### src/core/storage/account.ts（9）

- :62 → `accounts.select`
- :69 → `accounts.select`
- :76 → `accounts.select`
- :83 → `accounts.select`
- :96 → `accounts.insert`
- :136 → `accounts.update`
- :147 → `accounts.delete`
- :153 → `accounts.update`
- :154 → `accounts.update`

### src/core/storage/persistence-provider.ts（9）

- :79 → `session_events.insert`
- :99 → `session_events.insert`
- :119 → `session_events.select`
- :135 → `session_events.select`
- :151 → `session_events.select`
- :167 → `session_events.select`
- :177 → `session_events.select`
- :187 → `session_events.delete`
- :201 → `session_events.insert`

### src/core/storage/session.ts（9）

- :64 → `sessions.select`
- :74 → `sessions.select`
- :81 → `sessions.insert`
- :122 → `sessions.update`
- :129 → `sessions.delete`
- :136 → `sessions.select`
- :139 → `sessions.update`
- :191 → `sessions.insert`
- :218 → `sessions.update`

### src/core/auth/storage.ts（8）

- :35 → `accounts.select`
- :44 → `accounts.select`
- :53 → `accounts.select`
- :61 → `accounts.insert`
- :84 → `accounts.update`
- :95 → `accounts.delete`
- :101 → `accounts.update`
- :102 → `accounts.update`

### src/core/inbox/inbox-storage.ts（8）

- :35 → `inbox.insert`
- :47 → `inbox.delete`
- :70 → `inbox.update`
- :77 → `inbox.update`
- :80 → `inbox.update`
- :87 → `inbox.update`
- :93 → `inbox.delete`
- :109 → `inbox.delete`

### src/core/issue/issue-storage.ts（8）

- :47 → `issues.insert`
- :61 → `issues.select`
- :106 → `issues.update`
- :114 → `issues.delete`
- :123 → `issue_comments.insert`
- :130 → `issues.update`
- :138 → `issue_comments.select`
- :145 → `issue_comments.delete`

### src/core/session/delegation-storage.ts（8）

- :96 → `delegation_tasks.update`
- :108 → `delegation_tasks.select`
- :135 → `delegation_tasks.select`
- :151 → `delegation_tasks.select`
- :167 → `delegation_tasks.select`
- :183 → `delegation_tasks.select`
- :202 → `delegation_tasks.select`
- :218 → `delegation_tasks.delete`

### src/core/telemetry/telemetry.ts（7）

- :99 → `telemetry_events.insert`
- :133 → `telemetry_events.select`
- :185 → `telemetry_events.select`
- :188 → `telemetry_events.select`
- :191 → `telemetry_events.select`
- :196 → `telemetry_events.select`
- :260 → `telemetry_events.select`

### src/core/storage/agent-profile-storage.ts（5）

- :41 → `agent_profiles.insert`
- :62 → `agent_profiles.select`
- :74 → `agent_profiles.select`
- :101 → `agent_profiles.update`
- :108 → `agent_profiles.delete`

### src/core/storage/project.ts（5）

- :31 → `projects.select`
- :48 → `projects.select`
- :64 → `projects.insert`
- :88 → `projects.update`
- :99 → `projects.delete`

### src/core/storage/prompt-draft.ts（5）

- :31 → `prompt_drafts.select`
- :39 → `prompt_drafts.insert`
- :53 → `prompt_drafts.select`
- :75 → `prompt_drafts.delete`
- :87 → `prompt_drafts.select`

### src/core/storage/v2-session.ts（5）

- :8 → `v2_sessions.select`
- :34 → `v2_sessions.select`
- :36 → `v2_sessions.update`
- :41 → `v2_sessions.insert`
- :55 → `v2_sessions.delete`

### src/core/goal/goal.ts（4）

- :37 → `goals.insert`
- :50 → `goals.select`
- :62 → `goals.select`
- :91 → `goals.update`

### src/core/llm/tools/show-todo.ts（4）

- :123 → `todo_lists.insert`
- :136 → `todo_lists.select`
- :151 → `todo_lists.select`
- :164 → `todo_lists.update`

### src/core/storage/database.ts（4）

- :1147 → `projects.insert`
- :1187 → `messages.update`
- :1416 → `telemetry_events.delete`
- :1462 → `session_events.select`

### src/core/storage/file-change-storage.ts（4）

- :79 → `turn_file_changes.select`
- :95 → `turn_file_changes.select`
- :116 → `turn_file_changes.update`
- :129 → `turn_file_changes.delete`

### src/core/storage/session-log-bridge.ts（4）

- :30 → `attachments.select`
- :35 → `attachments.select`
- :154 → `tool_calls.delete`
- :156 → `tool_calls.insert`

### src/core/llm/tools/session-search.ts（3）

- :275 → `sessions.select`
- :295 → `sessions.select`
- :304 → `sessions.select`

### src/components/PerformanceDashboard.tsx（1）

- :80 → `telemetry_events.delete`

### src/core/knowledge/note-manager.ts（1）

- :207 → `note_links.delete`
