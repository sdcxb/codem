# 仓储迁移覆盖率（P2 门禁，自动生成）

> 由 `node tools/audit/storage-coverage.mjs --md` 生成；不要手工编辑。

- 扫描生产文件：**838**
- 需要实现的仓储方法：**129**（对应 270 个 SQL 调用点）
- 已实现：**41** → 方法覆盖率 **31.78%**，调用点覆盖率 **42.59%**
- Rust 侧已注册命令：**66**
- **命令可用性覆盖：129/129（100%）** —— 这一项在第 10 段引入通用命令后已达 100%，但**不等于迁移完成**：渲染侧调用点是否已切到端口，看上面那个保守数字。

## 已实现（渲染侧方法 → Rust 命令）

| 渲染侧方法 | 调用点 | Rust 命令 |
|---|---:|---|
| `messages.update` | 13 | `messages.update` `messages.update_many` `messages.upsert_index` |
| `messages.select` | 11 | `messages.get` `messages.list` |
| `session_events.select` | 11 | `events.list` `events.count` `events.watermark` |
| `session_events.insert` | 7 | `events.append` `events.append_batch` |
| `attachments.select` | 6 | `attachments.list` |
| `sessions.select` | 6 | `sessions.list` |
| `accounts.select` | 4 | `crud.list` |
| `message_feedback.alter` | 4 | `feedback.set` |
| `message_feedback.delete` | 4 | `feedback.delete` |
| `messages.delete` | 4 | `messages.delete` |
| `accounts.update` | 3 | `crud.upsert` |
| `message_feedback.select` | 3 | `feedback.get` |
| `session_events.delete` | 3 | `events.delete_session` |
| `message_feedback.insert` | 2 | `feedback.set` |
| `projects.insert` | 2 | `projects.upsert` |
| `projects.select` | 2 | `projects.list` |
| `session_fts.insert` | 2 | `fts.rebuild` |
| `sessions.insert` | 2 | `sessions.upsert` |
| `settings.select` | 2 | `settings.get_all` |
| `telemetry_events.delete` | 2 | `telemetry.prune` |
| `v2_sessions.select` | 2 | `crud.list` |
| `accounts.delete` | 1 | `crud.delete` |
| `accounts.insert` | 1 | `crud.upsert` |
| `attachments.update` | 1 | `attachments.update` |
| `mcp_servers.delete` | 1 | `mcp_servers.remove` |
| `mcp_servers.insert` | 1 | `mcp_servers.save` |
| `mcp_servers.select` | 1 | `mcp_servers.list` |
| `memory.insert` | 1 | `memory.set` |
| `memory.select` | 1 | `memory.get` |
| `messages.insert` | 1 | `messages.create` `messages.create_many` `messages.upsert_index` |
| `quick_phrases.delete` | 1 | `quick_phrases.delete` |
| `quick_phrases.select` | 1 | `quick_phrases.list` |
| `quick_phrases.update` | 1 | `quick_phrases.save` `quick_phrases.touch` |
| `session_fts.delete` | 1 | `fts.delete_session` `fts.rebuild` |
| `session_fts.select` | 1 | `fts.search` |
| `settings.delete` | 1 | `settings.remove` |
| `settings.insert` | 1 | `settings.set` |
| `telemetry_events.insert` | 1 | `telemetry.append` |
| `v2_sessions.delete` | 1 | `crud.delete` |
| `v2_sessions.insert` | 1 | `crud.upsert` |
| `v2_sessions.update` | 1 | `crud.upsert` |

## 待迁移（88 个方法，按调用点排序）

| 渲染侧方法 | 调用点 | 建议阶段 |
|---|---:|---|
| `delegation_tasks.select` | 6 | 5 其余域 |
| `telemetry_events.select` | 6 | 2 只追加 |
| `cost_records.select` | 5 | 5 其余域 |
| `flashcards.select` | 5 | 5 其余域 |
| `graph_nodes.update` | 4 | 5 其余域 |
| `inbox.update` | 4 | 5 其余域 |
| `notebooks.select` | 4 | 5 其余域 |
| `tool_calls.delete` | 4 | 3 数据面 |
| `tool_calls.insert` | 4 | 3 数据面 |
| `graph_edges.delete` | 3 | 5 其余域 |
| `graph_nodes.select` | 3 | 5 其余域 |
| `inbox.delete` | 3 | 5 其余域 |
| `notebook_chunks.select` | 3 | 5 其余域 |
| `notebook_groups.select` | 3 | 5 其余域 |
| `notebook_sources.select` | 3 | 5 其余域 |
| `notebooks.update` | 3 | 5 其余域 |
| `prompt_drafts.select` | 3 | 5 其余域 |
| `sessions.update` | 3 | 4 会话/项目 |
| `agent_profiles.select` | 2 | 5 其余域 |
| `flashcards.delete` | 2 | 5 其余域 |
| `flashcards.update` | 2 | 5 其余域 |
| `goals.select` | 2 | 5 其余域 |
| `graph_edges.select` | 2 | 5 其余域 |
| `graph_nodes.delete` | 2 | 5 其余域 |
| `issues.update` | 2 | 5 其余域 |
| `note_links.select` | 2 | 5 其余域 |
| `note_versions.select` | 2 | 5 其余域 |
| `notebook_chunks.insert` | 2 | 5 其余域 |
| `notes.delete` | 2 | 5 其余域 |
| `notes.select` | 2 | 5 其余域 |
| `squads.select` | 2 | 5 其余域 |
| `squads.update` | 2 | 5 其余域 |
| `todo_lists.select` | 2 | 5 其余域 |
| `turn_file_changes.select` | 2 | 5 其余域 |
| `agent_profiles.delete` | 1 | 5 其余域 |
| `agent_profiles.insert` | 1 | 5 其余域 |
| `agent_profiles.update` | 1 | 5 其余域 |
| `attachments.insert` | 1 | 3 数据面 |
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
