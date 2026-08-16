---
name: pre-push-checks
description: Use before pushing changes. Selects and runs the narrow relevant test suite, verifies type-check, lint, prose quality (via prose-standard), and lifecycle/disposal tests. Reports what was run, what passed, and what blocked the push.
tags: ["test", "push", "checks", "lint", "typecheck"]
version: "1.0.0"
author: "Codem"
forcePreload: false
---

# Pre-Push Checks

Run the narrow relevant checks before pushing. This skill selects the right tests, not the full suite — running everything wastes time and hides failures.

## Blocking Gates

1. **Type-check** — run \`tsc --noEmit\` first. Interface breaks caught here are faster than running the full suite.
2. **Lint** — run the project's linter on changed files only.
3. **Narrow test suite** — map the diff to test files and run only those plus disposal/lifecycle tests.
4. **Prose quality** — use \`prose-standard\` to review every added or changed Markdown, JSDoc, comment, prompt, description, diagnostic, and visible string.
5. **Disposal tests** — every new registry contribution, plugin, or service needs a disposal test that verifies cleanup.

## Test Selection Strategy

### Map the diff to test files
Use import graphs or grep to find every test that exercises the changed code path:

\`\`\`sh
# Find tests that import the changed module
rg -l "from.*changed-module" --glob "*.test.*" --glob "*.spec.*"
\`\`\`

### Include lifecycle and disposal tests
Every new registry contribution, plugin, or service needs a disposal test. Run the existing disposal tests for any service the diff touches.

### Include cross-cutting tests
When the change affects a shared interface, include every consumer's test:

\`\`\`sh
# Find all importers of a changed interface
rg -l "import.*ChangedInterface" --glob "*.ts"
\`\`\`

### Exclude unrelated suites
Running the full suite wastes time and hides failures. Run only what the diff touches plus a type-check. If the project has a test selection tool (e.g. jest --findRelatedTests), use it.

## Gate-Specific Verification

### Type-check gate
\`\`\`sh
npx tsc --noEmit
\`\`\`

### Lint gate
\`\`\`sh
# Run linter on changed files only
npx eslint $(git diff --name-only --cached --diff-filter=ACMR | grep -E '\\.(ts|tsx|js|jsx)$')
\`\`\`

### Test gate
\`\`\`sh
# Run only the mapped test files
npx jest --findRelatedTests $(git diff --name-only --cached --diff-filter=ACMR | grep -E '\\.(ts|tsx)$' | sed 's/\\.ts$/.test.ts/')
\`\`\`

### Prose gate
Use \`prose-standard\` to review:
- Every added or changed Markdown passage
- Every added or changed JSDoc
- Every added or changed comment
- Every added or changed prompt or description
- Every added or changed diagnostic or visible string

### Disposal gate
Verify each new registry contribution passes disposal tests. If no disposal test exists, flag it as a blocker.

## Reporting

Report in this format:

\`\`\`
## Pre-Push Report

### Passed
- [x] tsc --noEmit
- [x] eslint (12 files)
- [x] jest (8 tests in 5 files)

### Blocked
- [ ] Disposal test missing for SkillRegistry.registerProvider()
- [ ] prose-standard: 2 JSDoc comments missing throws clause

### Not run (with reason)
- [ ] Full test suite — not needed, diff is isolated to src/core/skill/
\`\`\`

## Guardrails

- **Never skip the type-check.** It is the fastest gate and catches interface breaks.
- **Never skip disposal tests.** Lifecycle bugs are the hardest to debug in production.
- **Never skip prose review.** Wording is behavior — model-visible strings and prompts are part of the contract.
- **Report honestly.** If a gate was not run, say so with the reason. Do not mark un-run gates as passed.
