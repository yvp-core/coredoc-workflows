## Step 4.8: Independent verification (conditional)

Read and apply `<plugin-root>/resources/methodology/review-policy.md`. Resolve
activation and verifier type from `adversarial mode`, and review depth from
`convergence budget`. Diff size alone never activates this pass.

When the repository leaves activation unspecified, use the concrete adversarial
signals in `review-policy.md`'s Generic fallback; do not invent additional
triggers from diff size or a generic production-path label. Documentation-only
and test-only diffs may skip it. An explicitly approved cross-model pass counts
toward this fallback or the resolved `convergence budget`, but it does not waive
a locally required verifier.

### Independent adversarial subagent

Read `<plugin-root>/resources/methodology/subagent-dispatch.md` and dispatch the
remaining local verifier assignments required by the resolved policy. Use
`coredoc-workflows:coredoc-reviewer` (or the host equivalent). Give each verifier
the specification, non-goals, release context, repository rules, canonical
finding contract, resolved diff base, and the highest-impact unresolved
candidates relevant to its assigned boundary.

The verifier's first job is to falsify those candidates: check reachability,
existing handling, accepted rollout decisions, and whether the alleged outcome
actually violates a current contract. It may add a new finding only under the
canonical finding contract and may return `NO FINDINGS`; novelty is not success.

Merge verified results by semantic root cause. Independent agreement is supporting
metadata only and never boosts confidence or severity. Name a failed verifier as
a coverage gap; the resolved Review policy decides whether review can complete.

### Verification synthesis

Report which candidates were confirmed, disproved, still need evidence, or need
repository-owner context; whether a new proven root cause was found; and which
required passes were local, cross-model, skipped, or unavailable.
