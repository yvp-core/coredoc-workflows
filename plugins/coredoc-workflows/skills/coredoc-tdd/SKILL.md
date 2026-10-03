---
name: coredoc-tdd
description: Implement a feature or bug fix test-first with a strict red-green-refactor loop. Use only when the user explicitly asks for TDD or strict test-first work.
---

# Test-driven implementation

Resolve `<plugin-root>` as two directories above this file. Stay inside the
user's authorization boundary.

For a change whose best proof is not a new failing test (a deletion,
behavior-preserving refactor, documentation, configuration, or generated
output), use `coredoc-implement` unless the user explicitly requires TDD.

1. Read the requested behavior and the real runtime path. Use Coredoc graph
   tools read-only for callers, dependents, and impact when available; treat
   their results as a lower bound and verify critical gaps against source.
2. Before any edit, apply
   `<plugin-root>/resources/methodology/branch-start.md` unless the router
   already did so in this run.
3. If a routed specification stage preceded this one, read the repository-local
   specification. Treat its acceptance criteria as the test list and its
   non-goals as the scope boundary.
4. Apply the **Over-scope gate** before editing. Search for an existing
   implementation of each behavior. If a criterion or item has no current
   observer or consumer, protects an unreachable state, duplicates an
   authoritative implementation, or hardens a deprecated path outside its
   support window, stop and request a scope correction.
5. Inspect existing tests and choose the smallest normal test surface that would
   catch the regression.
6. Add one meaningful test and run it before implementation.
7. If it is not RED for the expected missing behavior, correct the test before
   touching production code.
8. Implement the smallest root-cause change that makes the test GREEN.
9. Run the targeted test, then the relevant package or repository suite. When the
   suite comes back red beyond your own test, apply
   `<plugin-root>/resources/methodology/test-failure-triage.md` before deciding
   whether to stop; never weaken an assertion to reach green.
10. Refactor only when the green implementation contains concrete duplication or
   obscures the changed behavior.

**Escalate an under-scoped route.** Routing happens before source inspection. If
the change must alter a shared or cross-package contract, create a component or
subsystem, or cannot be verified on one test surface, stop and name the affected
contract and consumers. Offer to route again at `--scale large` so specification,
design, approval, and review apply.

Before delegating an item, apply
`<plugin-root>/resources/methodology/subagent-dispatch.md`.

Do not commit, publish, or deploy unless the user separately asks.
