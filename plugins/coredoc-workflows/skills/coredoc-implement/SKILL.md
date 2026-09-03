---
name: coredoc-implement
description: Implement an authorized code, deletion, refactor, configuration, dependency, documentation, or generated-output change with the smallest proof that matches its observable risk. Use for ordinary routed changes; use coredoc-tdd only when strict test-first work is explicitly requested.
---

# Adaptive implementation

Apply repository rules and stay inside the user's authorization boundary. The
goal is durable evidence that the requested outcome works and would fail loudly
on regression. Choose the smallest proof appropriate to the change; that proof
is not always a new test.

1. Establish the implementation context:

   - **Routed:** start from the reviewed specification, design verdict, and
     repository evidence already available in the current context. Do not repeat
     completed discovery. Re-read an artifact or source only when required detail
     is missing, context was compacted, or the code changed after the earlier
     stage. For a gated large change, verify that the user gave a fresh approval
     after seeing the reviewed direction and material deltas through the
     explicit Accept and implement / Revise decision. The same affirmative reply
     authorizes implementation. The original change request, pre-spec alignment
     approval, spec existence, an already accepted status, or positive review
     verdict is not implementation authorization; stop when that post-review
     approval is absent.
   - **Direct:** read the request and repository rules, then inspect only the
     runtime path, existing validation, and nearest consumers needed for this
     change.

   Treat the specification's acceptance criteria as outcomes, not as an
   automatic list of new tests. If a criterion has no current observer or
   contradicts repository evidence, stop and raise the mismatch instead of
   silently implementing or skipping it. Use the specification's non-goals as
   the scope boundary.

   If this session has a Coredoc intent capability — the `get_intent_context` MCP
   tool or the `coredoc intent context` CLI — resolve the plugin root as two
   directories above this file and read
   `<plugin-root>/resources/methodology/intent-context.md` before editing. Reuse
   the intent IDs the routed specification or plan already names and fetch only
   their missing payload; treat the limitations and non-goals it returns as scope
   boundaries, and cite the IDs a change satisfies in the report. Follow the
   implementation and validation stage contracts: carry the exact working set and
   observed revision forward unchanged, report executed evidence per acceptance
   criterion, and keep runtime conformance separate from anchor status and graph
   freshness. When no intent capability is present, proceed from repository
   evidence alone and do not mention intent context in the output.

2. Before editing, state one concise proof plan and choose the smallest matching
   mode:

   - **Regression or new observable behavior:** use red-green-refactor when a
     stable automated test surface exists. Add the smallest test that would fail
     for the missing behavior, run it RED, implement, then run it GREEN.
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

   If more than one mode applies, combine only their necessary checks. Do not ask
   the user to choose when repository evidence makes the choice clear.

   For an approved gated change, finish the read-only preflight above and state
   the proof plan before changing any file. If they reveal a mismatch, stop with
   the specification still `status: draft`. If the reviewed frontmatter is
   `status: draft`, change it to `status: accepted` as the implementation stage's
   first repository write, before any code or test edit. If an unchanged artifact
   is already accepted from a prior session, preserve that status; fresh
   post-review approval is still required.

3. Apply the over-scope gate. If an item has no current observer or consumer,
   protects an unreachable state, duplicates an authoritative implementation,
   or hardens a deprecated path outside its support window, stop and request a
   scope correction.
4. Implement the smallest root-cause change. Preserve unrelated user changes and
   avoid speculative refactors, compatibility layers, fixtures, or workflow
   artifacts.
5. Run the cheapest decisive check first, then the relevant package or
   repository-required gates. If failures extend beyond the change, resolve the
   plugin root as two directories above this file and apply
   `<plugin-root>/resources/methodology/test-failure-triage.md`; distinguish
   in-branch failures from pre-existing ones and never weaken an assertion merely
   to get green.
6. Report the proof mode, changed files, commands and outcomes, and any check
   that could not run. Do not claim test-first work when the chosen evidence was
   validation, compilation, search, or an existing suite.

Never add a test merely to assert that deleted private code stays deleted, that
an implementation detail has a particular shape, or that an unreachable stale
branch remains unreachable. Test externally meaningful contracts and realistic
failure paths, not the diff itself.

**Escalate an under-scoped route.** Routing happens before source inspection. If
the change must alter a shared or cross-package contract, create a component or
subsystem, or cannot be verified on one test surface, stop and name the affected
contract and consumers. Offer to route again at `--scale large` so specification,
design, approval, and review apply.

Before delegating an item, resolve the plugin root and apply
`<plugin-root>/resources/methodology/subagent-dispatch.md`. Keep hard work
sequential, assign disjoint file ownership to parallel writers, and let the
parent run final validation. Use Coredoc graph tools read-only for impact when
available, treat their coverage as a lower bound, and verify critical consumers
against source.

Do not commit, publish, deploy, change CI, or perform unrelated remote mutations
unless the user separately authorizes them.
