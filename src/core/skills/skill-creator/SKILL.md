---
name: skill-creator
displayName: 技能创建器
description: Create new skills, modify and improve existing skills, and measure skill performance. Use when users want to create a skill from scratch, edit or optimize an existing skill, run evals to test a skill, benchmark skill performance, or optimize a skill's description for better triggering accuracy.
version: "1.0.0"
author: "Codem"
tags: ["skill", "creator", "eval", "optimization"]
---

# Skill Creator

A skill for creating new skills and iteratively improving them.

## Core Loop

1. Figure out what the skill is about (capture intent from the user)
2. Draft or edit the SKILL.md
3. Run test prompts with the skill
4. Evaluate outputs (qualitative + quantitative)
5. Improve based on feedback
6. Repeat until satisfied

## Creating a Skill

### Capture Intent
1. What should this skill enable the AI to do?
2. When should this skill trigger? (what user phrases/contexts)
3. What's the expected output format?
4. Should we set up test cases?

### Write the SKILL.md
Fill in these components:
- **name**: Skill identifier (kebab-case)
- **description**: When to trigger, what it does. Include both what the skill does AND specific contexts for when to use it.
- **prompt**: The actual instructions for the AI when this skill is loaded.

### Skill Structure
```
skill-name/
├── SKILL.md (required)
│   ├── YAML frontmatter (name, description required)
│   └── Markdown instructions
└── Bundled Resources (optional)
    ├── scripts/    - Executable code for deterministic tasks
    ├── references/ - Docs loaded into context as needed
    └── assets/     - Files used in output (templates, icons)
```

### Progressive Disclosure
Skills use a three-level loading system:
1. **Metadata** (name + description) - Always in context
2. **SKILL.md body** - In context whenever skill triggers
3. **Bundled resources** - As needed

Keep SKILL.md under 500 lines. Reference files clearly with guidance on when to read them.

## Test Cases

After writing the skill draft, create 2-3 realistic test prompts. Save to `evals/evals.json`:

```json
{
  "skill_name": "example-skill",
  "evals": [
    {
      "id": 1,
      "prompt": "User's task prompt",
      "expected_output": "Description of expected result"
    }
  ]
}
```

## Evaluation

### Qualitative
- Run test prompts and review outputs
- Check: does the skill produce the expected behavior?
- Check: is the output quality good?

### Quantitative
- Define assertions for each test case
- Grade: pass/fail for each assertion
- Track: pass rate, token usage, execution time

### Iteration
1. Apply improvements to the skill
2. Rerun test cases
3. Compare with previous iteration
4. Repeat until satisfied

## Writing Tips

- Prefer imperative form in instructions
- Explain WHY things are important, not just WHAT to do
- Make skills general, not narrow to specific examples
- Start with a draft, then review with fresh eyes and improve
- Look for repeated work across test cases — bundle into scripts

## Description Optimization

The description field determines whether the AI invokes a skill. After creating or improving a skill:

1. Generate 10-20 trigger eval queries (mix of should-trigger and should-not-trigger)
2. Review with user
3. Test current description against eval queries
4. Iterate on description for better triggering accuracy
5. Apply best description to SKILL.md

## Packaging

When the skill is complete, package it as a .zip file:
- Include SKILL.md and all bundled resources
- Validate the structure
- Present to user for installation
