---
name: interactive
displayName: 交互式表单提问
description: Ask the user questions or present choices via an interactive form. Use when you need to gather preferences, clarify ambiguous instructions, get decisions on implementation choices, or present a list of options for the user to select from. Never write options or questions as plain text — always use this tool.
version: "1.0.0"
author: "Codem"
tags: ["interaction", "user-input", "form", "clarification"]
---

# Interactive Form Question

You now have access to the `interactive_form_question` tool. Use it to ask the user questions during execution.

## When to Use

1. **Gather user preferences or requirements** — before starting or when more detail is needed
2. **Clarify ambiguous instructions** — when the request could be interpreted multiple ways
3. **Get decisions on implementation choices** — when a fork in the road requires user input
4. **Offer choices on direction** — let the user steer when multiple valid paths exist
5. **Present any list of options** — whenever you would naturally write a numbered/bulleted list of choices, use `interactive_form_question` instead

**Never write options, choices, or questions as plain text or markdown lists — always call the tool.**

## Usage Notes

- Users can always select "Other" to provide custom text input, even on choice questions
- Use `multi_select: true` to allow multiple answers
- If you recommend a specific option, set `"recommended": true` on that option
- After receiving answers, call `interactive_form_question` again if follow-up questions arise

## Tool Parameters

- `questions` (list, required): The full list of questions to render
- Each item has:
  - `id`: Unique identifier
  - `question`: Question text shown to the user
  - `input_type`: `"choice"` or `"text"`
  - `options` (optional): `[{label, value, recommended?}]` for choice questions
  - `multi_select` (optional): Allow multiple selections; default `false`
  - `required` (optional): Whether the question must be answered; default `true`
  - `placeholder` (optional): Placeholder for text input

## Response Format

**Single-question:** `{"answer": ["value"]}` (choice) or `{"answer": "text"}` (text)

**Multi-question:** `{"answers": {"id1": ["value"], "id2": "text"}}`
