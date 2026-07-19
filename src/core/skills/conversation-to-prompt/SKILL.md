---
name: conversation-to-prompt
displayName: 对话转提示词
description: Convert the current conversation into a reusable system prompt. Use when the user says "save this as a prompt", "turn this into a skill", "create a reusable prompt from this conversation", or wants to extract reusable instructions from the current session.
aliases: ["c2p", "to-prompt"]
tags: ["prompt", "reuse", "conversation"]
version: "1.0.0"
author: "Codem"
---

# Conversation To Prompt

Transform the current conversation into a reusable system prompt draft.

## Output Protocol

Output **only** the final prompt text body. No code fences, no JSON, no explanations before or after.

## Multi-Stage Flow

1. **Analyze conversation**
   - Extract stable collaboration preferences (how the user likes to work)
   - Extract reusable task methods (the approach that worked)
   - Identify one-off context that must be removed (specific file names, temporary decisions)

2. **Generate first draft**
   - Produce one complete prompt body following the required structure below

3. **Evaluate draft**
   - Check: does it start with identity and responsibility?
   - Check: is it reusable, not a conversation summary?
   - Check: are instructions specific and actionable?
   - Reject if any check fails, rewrite

4. **Final protocol check**
   - Ensure output is plain text only, no markdown wrappers

## Required Prompt Structure

```text
你是{助手身份}，负责{核心职责}。

你的工作方式：
- {协作偏好 1}
- {协作偏好 2}

处理任务时请遵循以下原则：
- {任务方法 1}
- {任务方法 2}

输出要求：
- {输出要求 1}
- {输出要求 2}
```

## Evaluation Rules

Reject and rewrite if any condition is true:

1. The prompt does not start with assistant identity and responsibility
2. The output reads like a conversation summary instead of reusable instructions
3. One-off project details or temporary decisions leak into the draft
4. Instructions are vague and not actionable
5. Instructions contain internal conflicts
6. Output contains markdown wrappers or extra text outside the prompt body

## Forbidden Patterns

- Returning JSON objects or fenced code blocks
- Returning bullet-point summaries instead of the required prompt structure
- Including specific file paths, user names, or project-specific details
