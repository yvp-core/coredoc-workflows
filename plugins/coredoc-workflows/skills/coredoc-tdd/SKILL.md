---
name: coredoc-tdd
description: Implement a feature or bug fix with ordinary repository tests using a strict red-green-refactor loop. Use only when the user explicitly asks for TDD or strict test-first work; ordinary routed changes use coredoc-implement.
---

# Test-driven implementation

Apply repository rules and stay inside the user's authorization boundary.

This is the strict test-first method. For deletions, behavior-preserving
refactors, documentation, configuration, generated output, or other changes
whose best proof is not a new failing test, use `coredoc-implement` unless the
user explicitly requires TDD.

1. Read the requested behavior and the real runtime path.
2. If a routed specification stage preceded this one, read the repository-local
   specification. Treat its acceptance criteria as the test list and its
   non-goals as the scope boundary. Track progress against that specification,
   not an ad hoc internal list.
3. Apply the **Over-scope gate** before editing. Search for an existing implementation
   of each behavior. If an item has no current observer or consumer, protects an
   unreachable state, duplicates an authoritative implementation, or hardens a
   deprecated path outside its support window, stop and request a scope correction.
   Do not implement speculative acceptance criteria merely because they are written.
4. Inspect existing tests and choose the smallest normal test surface that would
   catch the regression. Do not create a parallel runner or workflow check.
5. Add one meaningful test and run it before implementation.
6. If it is not RED for the expected missing behavior, correct the test before
   touching production code.
7. Implement the smallest root-cause change that makes the test GREEN.
8. Run the targeted test, then the relevant package or repository suite. When the
   suite comes back red beyond your own test, apply
   `<plugin-root>/resources/methodology/test-failure-triage.md` before deciding
   whether to stop: establish whether each failure is in-branch or pre-existing,
   and never weaken an assertion to reach green.
9. Refactor only when the green implementation contains concrete duplication or
   obscures the changed behavior.

**Escalate an under-scoped route.** The route was classified from the request
text, before anyone had read the code. If implementation reveals that the change
must alter a shared or cross-package contract, create a component or subsystem,
or cannot be verified on one test surface, stop and tell the user the route was
scoped too small, name the contract and its consumers, and offer to route again
at `--scale large` so the specification, design, and review stages apply. Do not
continue to completion on the smaller route. Over-scoping costs the user a wait;
under-scoping lands a shared-contract change with no review stage, and only this
check runs at the point where the facts are finally known.

Before delegating an item, resolve the plugin root as two directories above this
file and apply
`<plugin-root>/resources/methodology/subagent-dispatch.md`. Classify the item,
keep hard work sequential, assign disjoint file ownership to parallel writers,
and let the parent update checkpoints and run full validation.

Batch independent tool calls in parallel when the host supports it, especially
read-only searches and file inspection. Keep result-dependent calls, mutations
of shared state, formatters, and final validation sequential.

Use Coredoc graph tools read-only for callers, dependents, and impact when
available. Treat graph results as a lower bound and verify critical gaps against
source.

Git already retains the RED state. Do not create specimens, frozen source copies,
ledgers, or committed workflow run artifacts. Do not commit, publish, or deploy
unless the user separately asks.
