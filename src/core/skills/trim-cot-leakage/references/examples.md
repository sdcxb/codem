# Few-shot leakage examples

Use them to identify the governing principle, not as text templates.

## Dead citations

### Decision ordinal with a committed owner

**Leaked:** "Slash input resolves against the visible catalog (decision 21)."

**Fixed:** "Slash input resolves against the visible catalog — the plain-text-reference decision, owned by the input-machine note."

The ordinal resolves nowhere at HEAD; the decision's name and owning note path do. Name the owning note's path at least once per file, and later mentions may use the searchable name alone.

### Decision ordinal without an owner

**Leaked:** "The registry rejects duplicate names (decision 7: names are flat, no namespacing)."

**Fixed:** "The registry rejects duplicate names; names are flat, with no namespacing."

No committed artifact owns "decision 7", so the citation is deleted — but its factual clause (flat names) is restated to stand alone.

### Audit item codes

**Leaked:** "Rendering is pure: same snapshot, same string (audit R3)."

**Fixed:** "Rendering is pure: same snapshot, same string."

There is no audit document in the repo; the code is pure session shorthand carrying zero propositions.

### Plan-phase labels

**Leaked:** "`src/client/` is the shell (T4); the migration owns the adapters."

**Fixed:** "`src/client/` is the shell; the adapters live in `src/client/adapters/`."

Phase labels index a plan that never landed. Replace the label with what the phase produced.

## Stack and PR vantage

### "This PR" in a README

**Leaked:** "This PR adds cursor-based pagination to the session list."

**Fixed:** "The session list paginates by cursor."

A README outlives every PR; state the mechanism as current fact.

## Change narration and version stamps

### War story with a PR number

**Leaked:** "Colors used to come from `--widget-*` tokens, which nothing defined, so it always rendered the fallbacks; the alias tokens fixed that (PR #88)."

**Fixed:** "Colors come from the alias tokens; an undefined token renders the fallbacks."

Both live facts survive — the current mechanism and the standing failure behavior — restated in the present.

### Fixed regression → counterfactual present

**Leaked:** "This used to double-encode multibyte labels."

**Fixed:** "Without the byte-length guard, multibyte labels double-encode."

The regression pin survives as a present-tense counterfactual that names the guard; "used to" pins it to repo archaeology instead.

### Indexical version stamps

**Leaked:** "Batch rendering is synchronous this cut; the async path is roadmap work."

**Fixed:** "Batch rendering is synchronous." (The deferral lives in `TODO(widget-batch):` at the call site.)

## Review choreography

### Review verdicts as prose

**Leaked:** "Rejected in review: caching the resolved spec. We keep resolution per-call."

**Fixed:** "**Caching the resolved spec.** Rejected: the spec depends on per-call cwd, so a cache keyed by request would serve stale roots."

The alternatives-considered genre is the sanctioned home; the reviewer and the round are not part of the rationale.

## Reviewer-addressed justification

### Arguing a cast

**Leaked:** "The cast is safe — the SDK constructed the object, it simply doesn't declare the optionals strictly enough."

**Fixed:** "The SDK constructs this object with every optional populated; the declared type is looser than the runtime guarantee."

State the invariant a maintainer must not break. If the invariant is visible in the code, delete the comment instead.

## Restatement and derivation transcripts

### Control-flow narration

**Leaked:** "First we normalize the label, then we truncate it, then we wrap it."

**Fixed:** (deleted.)

The three lines below the comment say the same thing in code.

### Test walkthrough

**Leaked:** "This test creates a session, sends two messages, waits for the second reply, and then asserts the log has four entries."

**Fixed:** "Two round-trips must produce exactly four log entries — the projection dedupes the shared prefix."

Keep only the non-obvious assertion rationale; the walkthrough restates the test body.

## Hedges and planning residue

### Unmarked deferral

**Leaked:** "Probably fine to render eagerly for now."

**Fixed:** (deleted; the deferral already has its `TODO(widget-batch):` marker.)

A hedge without an owner is planning residue. If no marker exists, write one instead of keeping the hedge.

### Vague sizing

**Leaked:** "A 64 KiB buffer should be enough for most cases."

**Fixed:** "64 KiB holds the largest observed frame (48 KiB) with headroom; a larger frame fails loudly in `decode`."

Replace the hedge with the actual bound and the failure behavior when it is exceeded.

## Overcorrection traps

Every trap below was caught in review. Enumerate a passage's propositions before trimming it.

### Flipping an obligation into an endorsement

**Original:** "These direct registrations are exceptions pending migration to slots."

**Overcorrected:** "These direct registrations are sanctioned exceptions."

**Right:** "These direct registrations are exceptions pending migration to slots."

"Pending migration" is an obligation; "sanctioned" blesses the status quo.

### Promoting a hypothetical to a shipped feature

**Original:** "A future IPC-based shell subclasses the executor and overrides `spawn`."

**Overcorrected:** "An IPC-based shell subclasses the executor and overrides `spawn`."

**Right:** "A hypothetical IPC-based shell — no such shell exists — would subclass the executor and override `spawn`."

### Deleting a true fact with the transcript around it

**Original:** "The gate notice narrates the check order; the notice text is also what the typecheck compiles against."

**Overcorrected:** "…" (whole sentence deleted as narration.)

**Right:** "The notice text is what the typecheck compiles against."

Half the sentence was narration; the other half was a load-bearing coupling. Delete clauses, not sentences, when propositions share a line.

### Dropping provenance while keeping the number

**Original:** "The 4 MiB ceiling is measured: the largest generated module is 3.1 MiB."

**Overcorrected:** "The ceiling is 4 MiB; the largest generated module is 3.1 MiB."

**Right:** keep "measured".

Without "measured" the 3.1 MiB reads as a definition rather than an observation.
