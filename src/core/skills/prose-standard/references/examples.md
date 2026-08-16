# Distilled prose examples

Use these examples to identify the governing principle, not as text templates. "Balanced" preserves every load-bearing proposition with the least explanation needed at that location.

## Preserve every factual clause

**Original:** "The coordinator carefully serializes writes per session, flushes buffered events before disposal resolves, and reports backend failures to the caller."

**Over-trimmed:** "The coordinator serializes persistence."

**Balanced:** "The coordinator serializes writes per session, flushes buffered events before disposal resolves, and reports backend failures to the caller."

Remove decoration and repetition, not propositions. Actor, per-session scope, disposal ordering, and failure visibility are separate facts.

## Explicit skill scope is functional

**Over-trimmed:** "Read the sources and use judgment."

**Balanced:** "This skill is guidance, not a complete checklist. Use judgment beyond the named checks; documented requirements still apply."

Keep the explicit limitation because it changes how an agent applies the workflow. Trim repeated persuasion, not the guardrail.

## A cookbook keeps action and verification

**Over-trimmed:** "Add tests for the tool."

**Balanced:** "Test registration and disposal at unit level, exercise the tool through the real loader path, and add a snapshot when its rendered output changes. Verify the assertion observes the external result rather than the model's report."

Keep the test tiers, required action, real entry path, and observable verification. Remove fixture narration.

## Preserve ownership and timing

**Over-trimmed:** "Provider work is cancelled during teardown."

**Balanced:** "The runtime requests provider cancellation before releasing the child scope; the provider remains responsible for joining its workers before disposal resolves."

The actor, ordering, point where ownership changes, and completion guarantee are separate factual clauses.

## Orient complicated code without narrating it

**Over-trimmed:** "Worker realm support."

**Balanced:** "Owns the worker realm and its host bridge. Realm initialization is single-shot; disposal terminates the worker and rejects later calls."

Keep the module's role, dependencies, responsibilities, and non-obvious lifecycle behavior. Link architecture rationale and let the code show local control flow.

## Public JSDoc includes failures

**Over-trimmed:** "Returns the realm global."

**Balanced:** "Returns the initialized realm global. Throws if initialization has not completed or the realm has already been disposed."

Throws and state preconditions are caller-visible contract facts.

## Keep a concise implementation mapping

**Over-trimmed:** "Search provider backed by an external API."

**Balanced:** "Maps each provider result to the shared search-result fields, preserving the title, URL, and text while omitting provider-only ranking metadata."

Keep mapping details that explain where an adapter drops or changes information.

## Limitations are contracts, not debt inventories

**Over-trimmed:** Omitting a process-lifetime cache that makes configuration changes require plugin reload.

**Balanced:** "Provider selection is cached for the plugin lifetime; installing or repairing a provider requires reload."

Retain gaps and non-obvious constraints that affect use or safe maintenance. A package README is not a backlog dump.

## Delete reasoning transcripts entirely

**Over-detailed:** "First the loop checks whether the value is absent. If it is absent, the next branch returns early. Otherwise it continues, which is why the final assertion is safe."

**Balanced:** No comment when the code already expresses those branches. If the early return protects a non-obvious invariant, state only that invariant.

Do not compress a reasoning transcript into shorter narration; remove it.

## Configuration comments explain what the tree cannot

**Over-detailed:** "This entry loads the local filesystem provider, followed by the policy plugin, followed by the read, write, and edit tools," when the adjacent entries already show that order.

**Balanced:** "Load policy before the model-facing tools so their write and edit calls pass through the read-before-mutation gate."

Keep the consequence of order, a surprising scope rule, or a security boundary. Let the configuration show its own inventory.

## Do not trim for word count alone

**Current:** "The adapter converts provider errors into the shared error type so callers can handle authentication, rate-limit, and transient failures uniformly."

**Shorter but worse:** "The adapter normalizes provider errors."

**Balanced decision:** Keep the current sentence unless a link or surrounding contract already lists the failure categories. The shorter version loses the consequence and distinctions without improving structure.

## Generated summaries must stand alone

**Over-trimmed:** "Approval request and policy service." The owner explains policy order and audit logging later, but the catalog exports only its first sentence.

**Balanced:** "Approval service that applies session policy before answerers and logs every ask/outcome pair to the requesting session." Keep non-catalog detail in later sentences.

Know what the generator extracts. That fragment must preserve the contract needed on its generated output.
