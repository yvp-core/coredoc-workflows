---
name: coredoc-implement
description: Implement an authorized code, deletion, refactor, configuration, dependency, documentation, or generated-output change with the smallest proof that matches its observable risk. Use for ordinary routed changes.
---

# Adaptive implementation

Resolve `<plugin-root>` as two directories above this file. Repository rules win
where they conflict with this method. The goal is durable evidence that the
requested outcome works and would fail loudly on regression. Choose the smallest
proof appropriate to the change; that proof is not always a new test.

1. Establish the implementation context:

   - **Routed:** start from the reviewed specification, design verdict, and
     repository evidence already available in the current context. Do not repeat
     completed discovery. Re-read an artifact or source only when required detail
     is missing, context was compacted, or the code changed after the earlier
     stage. For a gated large change, only the user's fresh affirmative reply to
     the post-review Accept and implement / Revise decision authorizes
     implementation, so stop when that reply is absent. The original request,
     pre-spec alignment approval, spec existence, an accepted status, or a
     positive review verdict does not count. On an authorized continuation of
     unchanged material, the recorded reply from the original session counts.
   - **Direct:** read the request and repository rules, then inspect only the
     runtime path, existing validation, and nearest consumers needed for this
     change.

   Before any edit, apply
   `<plugin-root>/resources/methodology/branch-start.md` unless the router
   already did so in this run.

   If this session has a Coredoc code-graph capability — `search_symbols`,
   `explain`, `find_dependents`, `analyze_change_impact` — resolve the touched
   symbols' consumers and impact through it before grepping, especially for an
   export or a shared contract, and pass those facts to any scout or implementer
   you dispatch. Its coverage is a lower bound; verify critical consumers against
   source. When no graph capability is present, proceed from repository evidence
   alone and do not mention it in the output.

   Treat the specification's acceptance criteria as outcomes, not as an
   automatic list of new tests. If a criterion has no current observer or
   contradicts repository evidence, stop and raise the mismatch instead of
   silently implementing or skipping it. Use the specification's non-goals as
   the scope boundary.

   If this session has a Coredoc intent capability — the `get_intent_context` MCP
   tool or the `coredoc intent context` CLI — read
   `<plugin-root>/resources/methodology/intent-context.md` before editing and
   follow its implementation and validation stage contracts. Treat the
   limitations and non-goals it returns as scope boundaries, cite the IDs a
   change satisfies in the report, and keep runtime conformance separate from
   anchor status and graph freshness. Otherwise proceed from repository evidence
   alone and do not mention intent context in the output.

2. Before editing, state one concise proof plan and choose the smallest matching
   mode:

   - **Regression or new observable behavior:** use red-green-refactor when a
     stable automated test surface exists. Add the smallest test; it must go RED
     for the missing behavior before the fix.
   - **Behavior-preserving refactor or migration:** run the relevant existing
     tests before and after the change. Add a test only for a current contract
     that is materially at risk and not already covered.
   - **Deletion or deprecation:** find callers and dependents, remove or update
     consumers, then use the existing targeted suite plus typecheck/build/search
     evidence. Update or delete tests for intentionally removed behavior. Add an
     absence test only when absence is itself a durable public, compatibility,
     data-safety, or security invariant.
   - **Configuration, build, dependency, schema, or generated output:** use the
     owning parser, validator, dry run, build, typecheck, lockfile check, or
     generation-drift check. Add a test only when it captures a reusable semantic
     rule rather than the current file shape.
   - **Documentation or content:** use lint, link checking, rendering, examples,
     or another content-specific check. Do not add runtime unit tests unless the
     documentation is executable behavior.
   - **Mechanical rename or cleanup:** search consumers before and after, then
     run the narrow compiler, linter, or existing tests that can expose a missed
     reference.

   If more than one mode applies, combine only their necessary checks.

   For an approved gated change, finish the read-only preflight above and state
   the proof plan before changing any file. If they reveal a mismatch, stop with
   the specification still `status: draft`. If the reviewed frontmatter is
   `status: draft`, change it to `status: accepted` as the implementation stage's
   first repository write, before any code or test edit. If an unchanged artifact
   is already accepted from a prior session, preserve that status. An authorized
   continuation of the unchanged approved specification reuses its original
   approval. Implementation never proposes or accepts intent, with one
   exception: when the change must contradict accepted intent, propose a
   successor candidate (`proposedSuccessorOfId` naming the accepted item), say
   so, and leave it for a person's explicit acceptance. When a resumed run finds
   the approval's verbatim items still candidates, complete them under "Resume
   after an interruption" in `intent-context.md` without asking again: that is
   the approval's own act, not implementation's. Retain the approval and source
   reference in the handoff.

3. Apply the over-scope gate. If an item has no current observer or consumer,
   protects an unreachable state, duplicates an authoritative implementation,
   or hardens a deprecated path outside its support window, stop and request a
   scope correction.
4. Implement the smallest root-cause change. Preserve unrelated user changes and
   avoid speculative refactors, compatibility layers, fixtures, or workflow
   artifacts.
5. Run the cheapest decisive check first, then the relevant package or
   repository-required gates. If failures extend beyond the change, apply
   `<plugin-root>/resources/methodology/test-failure-triage.md`; never weaken an
   assertion to get green.
6. Report the proof mode actually used, changed files, commands and outcomes,
   and any check that could not run. If a cloud Coredoc intent write capability
   is present, save `intent_handoff` per "Implementation handoff and delivery" in
   `intent-context.md` for the items this change implements or relocates, with
   the reviewed `headSha`, before PR creation; read it back and carry its
   ID/version into the review handoff. When hosted writes are unavailable, carry
   the prepared data and state the missing capability.

**Escalate an under-scoped route.** Routing happens before source inspection. If
the change must alter a shared or cross-package contract, create a component or
subsystem, or cannot be verified on one test surface, stop and name the affected
contract and consumers. Offer to route again at `--scale large` so specification,
design, approval, and review apply.

Before delegating an item, apply
`<plugin-root>/resources/methodology/subagent-dispatch.md`.

Do not commit, publish, deploy, change CI, or perform unrelated remote mutations
unless the user separately authorizes them.
