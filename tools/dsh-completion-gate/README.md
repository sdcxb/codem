# dsh-completion-gate

Profile-level hard gate for DSH sessions.

## What it does

DSH's `todo_write` stores a `todos` session projection. When a turn ends with
`reason: "completed"` and that projection still has `pending` / `in_progress`
items, this plugin calls `agent.followup(...)` with a `[COMPLETION GATE]`
message. The agent must run another turn; only a turn that ends with all todos
completed is allowed through.

It is not a prompt hint: the next turn is queued from the `session/event`
`turn/end` event.

## Limits

- Applies to every session in the profile that has a `todos` projection.
- Sessions that never used `todo_write` have no contract to enforce.
- `maxRounds` defaults to 3; beyond that it stops injecting to avoid a loop.
- It cannot prevent the transient UI "completed" event that triggers it; a
  core `beforeFinal` hook is required for a zero-flash gate.

## Install into a profile

The plugin is a Cordis package. Put it on the profile's module path, then add
an entry to the profile `cordis.patch.yml`:

```yaml
- id: completion-gate
  name: dsh-completion-gate
  config:
    maxRounds: 3
```

Restart DSH (or let HMR reload) after adding the patch entry.
