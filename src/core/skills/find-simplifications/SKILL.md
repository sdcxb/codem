---
name: find-simplifications
description: Use when looking for code simplification opportunities — dead code, unnecessary abstractions, redundant state, structural complexity, or speculative generality. Reports candidates with evidence and risk rating, does not edit.
tags: ["simplification", "cleanup", "audit", "dead-code"]
version: "1.0.0"
author: "Codem"
forcePreload: false
---

# Find Simplifications

Audit-only skill that finds code simplification opportunities. Reports candidates with evidence and risk rating. Does not edit — use `refactor` to apply the changes.

## Scope

Require an explicit `scope`. If it is missing, report the required input and stop. Always exclude `vendor/`, `node_modules/`, generated catalogs, and recorded fixtures from discovery.

## Candidate Categories

### Dead code and unreachable paths
- Unused exports, functions, variables, types, and fields
- Unreachable branches (e.g., type-narrowed conditions that always pass)
- Commented-out code blocks
- Empty catch/finally blocks that swallow errors
- Shadowed declarations

### Unnecessary abstractions
- Single-implementation interfaces with no planned second implementation
- Wrapper functions that only forward to a single callee
- Factory methods that always return the same type
- Generic parameters that are never varied
- Adapter layers where the adapted interface is identical to the target
- Compatibility shims for APIs that no longer exist in the codebase

### Redundant state and indirection
- Cached values that are always recomputed before use
- Intermediate variables that add no clarity
- Property getters that mirror private fields with no validation
- Config objects that are always passed with the same values
- Re-exported symbols that are never imported through the re-export

### Structural complexity
- Conditionals that can be replaced with lookup tables or early returns
- Nested callbacks that can be flattened with async/await
- Repeated logic that can be extracted to a shared helper
- Over-engineered state machines that can be simplified
- Switch statements that mirror a type discriminator already available

### Speculative generality
- Plugin/extension points with zero registered implementations
- Configurable strategies where only one strategy exists
- Abstract base classes with a single concrete subclass
- Optional parameters that are always or never provided

## Evidence Requirements

For each candidate, provide:

1. **Location** — file path and line range
2. **Category** — which simplification category it falls into
3. **Evidence** — caller count (from grep), usage frequency, structural observation
4. **Risk** — Low / Medium / High (based on blast radius if removed)
5. **Benefit** — lines saved, clarity gained, or maintenance burden reduced
6. **Recommendation** — Delete / Inline / Merge / Extract / Defer (with reasoning)

## Guardrails

- **Never recommend deleting code without verifying zero callers.** Use grep across the full scope, including test files.
- **Never recommend changing public API without tracing all consumers.**
- **Flag uncertainty honestly.** If you cannot verify safety, mark risk as High and defer.
- **Do not edit.** This skill reports only. Use `refactor` to apply changes.

## Workflow

1. Confirm the scope and exclusions
2. Run discovery searches for each category
3. For each candidate, verify with grep and trace callers
4. Rate risk and benefit
5. Produce a prioritized report (high-benefit, low-risk first)
6. Link to `refactor` for application
