# 仓储迁移覆盖率（P2 门禁，自动生成）

> 由 `node tools/audit/storage-coverage.mjs --md` 生成；不要手工编辑。

- 扫描生产文件：**838**
- 需要实现的仓储方法：**129**（对应 278 个 SQL 调用点）
- 已实现：**22** → 方法覆盖率 **17.05%**，调用点覆盖率 **22.66%**
- Rust 侧已注册命令：**42**

## 已实现（渲染侧方法 → Rust 命令）

| 渲染侧方法 | 调用点 | Rust 命令 |
|---|---:|---|
| `messages.update` | 13 | `messages.update` `messages.update_many` |
| `messages.select` | 11 | `messages.get` `messages.list` |
| `session_events.insert` | 7 | `events.append` |
| `sessions.select` | 6 | `sessions.list` |
| `messages.delete` | 4 | `messages.delete` |
| `projects.insert` | 2 | `projects.upsert` |
| `projects.select` | 2 | `projects.list` |
| `sessions.insert` | 2 | `sessions.upsert` |
| `settings.select` | 2 | `settings.get_all` |
| `telemetry_events.delete` | 2 | `telemetry.prune` |
| `mcp_servers.delete` | 1 | `mcp_servers.remove` |
| `mcp_servers.insert` | 1 | `mcp_servers.save` |
| `mcp_servers.select` | 1 | `mcp_servers.list` |
| `memory.insert` | 1 | `memory.set` |
| `memory.select` | 1 | `memory.get` |
| `messages.insert` | 1 | `messages.create` `messages.create_many` |
| `quick_phrases.delete` | 1 | `quick_phrases.delete` |
| `quick_phrases.select` | 1 | `quick_phrases.list` |
| `quick_phrases.update` | 1 | `quick_phrases.save` `quick_phrases.touch` |
| `settings.delete` | 1 | `settings.remove` |
| `settings.insert` | 1 | `settings.set` |
| `telemetry_events.insert` | 1 | `telemetry.append` |

## 待迁移（107 个方法，按调用点排序）

| 渲染侧方法 | 调用点 | 建议阶段 |
|---|---:|---|
| `session_events.select` | 11 | 2 只追加 |
| `accounts.select` | 7 | 5 其余域 |
| `accounts.update` | 6 | 5 其余域 |
| `attachments.select` | 6 | 3 数据面 |
| `delegation_tasks.select` | 6 | 5 其余域 |
| `telemetry_events.select` | 6 | 2 只追加 |
| `cost_records.select` | 5 | 5 其余域 |
| `flashcards.select` | 5 | 5 其余域 |
| `graph_nodes.update` | 4 | 5 其余域 |
| `inbox.update` | 4 | 5 其余域 |
| `message_feedback.alter` | 4 | 3 数据面 |
| `message_feedback.delete` | 4 | 3 数据面 |
| `notebooks.select` | 4 | 5 其余域 |
| `tool_calls.delete` | 4 | 3 数据面 |
| `tool_calls.insert` | 4 | 3 数据面 |
| `graph_edges.delete` | 3 | 5 其余域 |
| `graph_nodes.select` | 3 | 5 其余域 |
| `inbox.delete` | 3 | 5 其余域 |
| `message_feedback.select` | 3 | 3 数据面 |
| `notebook_chunks.select` | 3 | 5 其余域 |
| `notebook_groups.select` | 3 | 5 其余域 |
| `notebook_sources.select` | 3 | 5 其余域 |
| `notebooks.update` | 3 | 5 其余域 |
| `prompt_drafts.select` | 3 | 5 其余域 |
| `session_events.delete` | 3 | 2 只追加 |
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
| `message_feedback.insert` | 2 | 3 数据面 |
| `note_links.select` | 2 | 5 其余域 |
| `note_versions.select` | 2 | 5 其余域 |
| `notebook_chunks.insert` | 2 | 5 其余域 |
| `notes.delete` | 2 | 5 其余域 |
| `notes.select` | 2 | 5 其余域 |
| `session_fts.insert` | 2 | 3 数据面 |
| `squads.select` | 2 | 5 其余域 |
| `squads.update` | 2 | 5 其余域 |
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
| `recovery_data.delete` | 1 | 5 其余域 |
| `recovery_data.insert` | 1 | 5 其余域 |
| `recovery_data.select` | 1 | 5 其余域 |
| `session_fts.delete` | 1 | 3 数据面 |
| `session_fts.select` | 1 | 3 数据面 |
| `sessions.delete` | 1 | 4 会话/项目 |
| `squad_members.delete` | 1 | 5 其余域 |
| `squad_members.insert` | 1 | 5 其余域 |
| `squad_members.select` | 1 | 5 其余域 |
| `squad_members.update` | 1 | 5 其余域 |
| `squads.delete` | 1 | 5 其余域 |
| `squads.insert` | 1 | 5 其余域 |
| `todo_lists.insert` | 1 | 5 其余域 |
| `todo_lists.update` | 1 | 5 其余域 |
| `tool_calls.select` | 1 | 3 数据面 |
| `tool_calls.update` | 1 | 3 数据面 |
| `turn_file_changes.delete` | 1 | 5 其余域 |
| `turn_file_changes.update` | 1 | 5 其余域 |
| `v2_sessions.delete` | 1 | 5 其余域 |
| `v2_sessions.insert` | 1 | 5 其余域 |
| `v2_sessions.update` | 1 | 5 其余域 |
