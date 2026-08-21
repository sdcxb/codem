---
name: skill-creator
displayName: 技能创建器
description: Create new skills, modify and improve existing skills, and measure skill performance. Use when users want to create a skill from scratch, edit or optimize an existing skill, run evals to test a skill, benchmark skill performance, or optimize a skill's description for better triggering accuracy.
version: "2.0.0"
author: "Codem"
tags: ["skill", "creator", "eval", "optimization"]
---

# Skill Creator

A skill for creating, installing, and iteratively improving skills.

## Core Loop

1. Figure out what the skill is about (capture intent from the user)
2. Draft or edit the SKILL.md
3. Install the skill to the local skills directory
4. Run test prompts with the skill
5. Evaluate outputs (qualitative + quantitative)
6. Improve based on feedback
7. Repeat until satisfied

## Skill Installation Directory

Skills are stored as directories containing a `SKILL.md` file. The local skills directory is:

```
~/.codem/skills/<skill-name>/SKILL.md
```

On Windows, `~` is the user's home directory (e.g. `C:\Users\<username>\.codem\skills\`).
On macOS/Linux, it is `/home/<username>/.codem/skills/` or `~/.codem/skills/`.

To find the exact path at runtime, run:
```bash
echo $HOME/.codem/skills
```

The system scans this directory at startup and when `load_skill` is called. Any `SKILL.md` file placed in a subdirectory of this location will be automatically discovered and become available as a skill.

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

### SKILL.md Format

```markdown
---
name: my-skill
description: "What this skill does and when to trigger it"
version: "1.0.0"
author: "Author Name"
tags: ["category1", "category2"]
---

# Skill Name

## Instructions

Write the skill instructions here. This is the prompt that gets loaded
when the skill is triggered.

## Workflow

1. Step one
2. Step two
3. Step three
```

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

### YAML Frontmatter Fields

| Field         | Required | Description                 | Example                                         |
| ------------- | -------- | --------------------------- | ----------------------------------------------- |
| `name`        | Yes      | Skill identifier (kebab-case) | `my-skill`                                      |
| `description` | Yes      | When to trigger, what it does | `"Debug Python code with breakpoint support"`     |
| `displayName` | No       | Display name shown in UI     | `"Python 调试器"`                                 |
| `version`     | No       | Semantic version number     | `"1.0.0"`                                        |
| `author`      | No       | Author name                 | `"Your Name"`                                    |
| `tags`        | No       | Category tags (array)       | `["python", "debugging"]`                       |
| `aliases`     | No       | Alternative trigger names   | `["debug-py", "py-debug"]`                      |
| `whenToUse`   | No       | Extra routing guidance      | `"When debugging Python code"`                  |

### Progressive Disclosure
Skills use a three-level loading system:
1. **Metadata** (name + description) - Always in context
2. **SKILL.md body** - In context whenever skill triggers
3. **Bundled resources** - As needed

Keep SKILL.md under 500 lines. Reference files clearly with guidance on when to read them.

## Installing a Skill

After writing the SKILL.md content, install it to the local skills directory so it becomes available as a skill.

### Installation Steps

1. **Determine the skills directory path**:
   ```bash
   SKILLS_DIR="$HOME/.codem/skills"
   mkdir -p "$SKILLS_DIR/<skill-name>"
   ```

2. **Write the SKILL.md file** to the skill directory:
   Use the `write` tool with path `$HOME/.codem/skills/<skill-name>/SKILL.md` and the full SKILL.md content.

3. **Write any bundled resources** (scripts, references, assets) to the same directory:
   ```
   $HOME/.codem/skills/<skill-name>/
   ├── SKILL.md
   ├── scripts/
   │   └── helper.py
   └── references/
       └── api-docs.md
   ```

4. **Verify installation** by reading the file back:
   ```
   read(path="$HOME/.codem/skills/<skill-name>/SKILL.md")
   ```

5. **The skill will be available** in the next `load_skill` call. The system scans the skills directory on each `load_skill` invocation, so newly created skills are automatically discovered.

### Installing from a URL or Chat Link

When a user says "install this skill: <URL>" or shares a skill link:

1. **Download the SKILL.md content** from the URL using `bash`:
   ```bash
   curl -sL "<URL>" -o /tmp/skill-download.md
   ```

2. **Read the downloaded content** to verify it's a valid SKILL.md:
   ```
   read(path="/tmp/skill-download.md")
   ```

3. **Extract the skill name** from the YAML frontmatter `name` field.

4. **Create the skill directory** and write the file:
   ```bash
   mkdir -p "$HOME/.codem/skills/<skill-name>"
   ```
   Then use `write` to save the content to `$HOME/.codem/skills/<skill-name>/SKILL.md`.

5. **If the URL points to a ZIP file**, download and extract it:
   ```bash
   curl -sL "<URL>" -o /tmp/skill.zip
   unzip /tmp/skill.zip -d "$HOME/.codem/skills/<skill-name>/"
   ```

6. **If the URL is a GitHub repository**, clone or download specific files:
   ```bash
   git clone --depth 1 "<URL>" /tmp/skill-repo
   # Copy the skill directory
   cp -r /tmp/skill-repo/<skill-dir> "$HOME/.codem/skills/<skill-name>/"
   ```

7. **Verify** by reading the installed SKILL.md and confirming the frontmatter is valid.

8. **Tell the user** the skill has been installed and is available via `load_skill`.

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
