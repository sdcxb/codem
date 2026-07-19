---
name: prompt-optimization
displayName: 提示词管理工具
description: View and modify the system prompt of the AI agent. Use when the user wants to 'optimize the prompt', 'change the system prompt', 'improve the agent behavior', 'make the AI more focused on X', or 'modify how the AI responds'.
version: "1.0.0"
author: "Codem"
tags: ["prompt", "optimization", "system-prompt", "agent-config"]
forcePreload: true
---

# Prompt Optimization Skill

This skill allows you to view and modify the system prompts of the current AI agent.

## Available Tools

- `get_system_prompt()` — Get the current prompt and source mapping
- `submit_prompt_changes(changes)` — Send optimized prompts to the user for review

## Workflow

### Step 1: Get Current Prompts

Call `get_system_prompt()`. It returns:
- `assembled_prompt`: The full assembled prompt
- `sources`: Array of prompt sources, each with:
  - `type`: The source type
  - `name`: Display name
  - `content`: The actual prompt text

### Step 2: Analyze and Rewrite

Based on the user's request, determine which source(s) need modification:
- Only modify the sources that are relevant to the user's request
- Preserve the overall structure and intent of unrelated parts
- Write complete, production-quality prompts
- Match the language of the original prompt

### Step 3: Submit Changes

Call `submit_prompt_changes(changes=[...])` with your changes. Each change must include:

```json
{
  "type": "system",
  "name": "system prompt",
  "original": "original content",
  "suggested": "optimized content"
}
```

This will display interactive cards to the user showing the original vs modified prompt.
The user can then apply or cancel each change independently.

## Important Notes

- Changes are NOT applied automatically — the user reviews and clicks "Apply"
- Only modify the sources that are relevant to the user's request
