---
name: code-review
description: Perform a thorough code review with security, lifecycle, and quality checks. Use when reviewing a PR, code changes, or auditing code quality. Covers bugs, security, performance, lifecycle, concurrency, prose quality, and interface contracts.
aliases: ["review", "cr"]
tags: ["review", "security", "quality", "audit"]
version: "2.0.0"
author: "Codem"
forcePreload: false
---

# Code Review

**This skill is guidance, not a complete checklist.** Prioritize correctness, lifecycle, security, and broken required behavior over style; a short review with one substantiated blocker is better than a list of nits.

## Blocking Requirements

1. **New prose receives semantic review.** Use `prose-standard` to critically review every added or changed Markdown passage, JSDoc, comment, prompt, description, diagnostic, and visible string. Verify required coverage, accuracy, placement, and editorial quality against the owning code or behavior.

2. **Docs match the code.** Config, defaults, errors, wire fields, events, and public behavior update the package README and JSDoc in the same diff. Comments state non-obvious contracts; flag implementation narration, test walkthroughs, review history, and duplicated rationale for deletion or a link to their one home.

3. **Registrations clean up.** Verify each new registry contribution passes the disposal tests.

4. **Required evidence exists.** Verify the author ran the relevant local checks for the diff.

## Manual Checks

### Intent and interface contracts
Trace both sides of every changed interface. Confirm the implementation matches the PR, including errors, cancellation, ownership, and disposal.

### Lifecycle and concurrency
For async setup, callbacks, processes, or teardown, check:
- Races before publication
- Cancellation during awaits
- Independent error reporting
- Callback containment
- Ownership before reentry
- Complete detach cleanup
- Quiescent disposal

### Capability and consumer fit
Trace every current consumer, then flag consumer-specific behavior leaking into the interface. Flag the inverse too: a new public method on a generic service whose only caller is one internal consumer is an unnecessary API expansion.

### Scope, ownership, and necessity
Map each abstraction, state machine, option, defensive copy, and compatibility path to its current contract, production consumer, and owning plugin or service. Challenge unrelated features and speculative generality.

### Configuration and public choices
Ask what current-consumer evidence or prior art supports each default, public operation set, format, or imported external concept.

### Model perspective
Inspect the exact prompts, tool schemas, results, and diagnostics the model receives. Flag concepts outside the model's task, then verify stable text verbatim and dynamic behavior through snapshots or end-to-end coverage.

### Enforcement
Follow every denial path to the operation that executes it; exercise direct and alternate callers that can bypass schemas, prompts, facades, wrappers, or listener ordering.

### Borrowed and derived state
Determine whether each retained value is borrowed or owned under the package contract, then trace notifications and every cache, prompt, UI echo, replay, and query view to the documented success point and authoritative source.

### Bounds cover the final operation
Locate the owner of the complete emitted or retained result, including wrappers and metadata. Probe tiny and exact limits, oversized single chunks, and multibyte text for byte limits.

### Real entry path
Tests exercise the shipped Loader, bin, worker, or subprocess where relevant. A hand-mounted plugin does not catch invalid Loader exports.

### Test strength
Assertions fail on the intended regression and verify external state, logs, events, or disposal rather than restating the implementation or trusting an agent's report.

## Classic Dimensions

1. **Bugs and Logic Errors**: incorrect logic, edge cases, null checks
2. **Security Issues**: SQL injection, XSS, command injection, path traversal
3. **Performance**: unnecessary loops, memory leaks, N+1 queries
4. **Code Style**: naming conventions, DRY principle, SOLID principles
5. **Error Handling**: missing error handling, swallowed exceptions

## Reporting findings

State the defect, location, impact, and evidence. Place a localized defect inline on the tightest relevant diff range; use a PR-level comment for cross-cutting architecture, scope, or review-wide synthesis. Separate blockers from suggestions and omit issues already enforced by a green gate.

Rate severity: Critical, High, Medium, Low, Info.
