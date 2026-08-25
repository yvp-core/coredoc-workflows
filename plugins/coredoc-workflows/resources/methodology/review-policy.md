## Review policy

Before sizing a review, read the repository instructions that apply to each
changed path. A repository declares review calibration under the exact heading
`## Review policy` in an applicable governance document. A root section supplies
repository defaults; a nearer path-scoped section overrides it only for that
subtree. Unspecified dimensions inherit from the root section and then from the
generic fallback below.

Resolve instructions in this order, from strongest to weakest:

1. Non-overridable safety boundaries and the finding evidence contract.
2. Hard repository DoD and guardrails.
3. A recorded, task-scoped maintainer decision.
4. The nearest applicable `## Review policy`, with the root policy as its base.
5. The generic fallback in this document.

A lower layer cannot weaken a higher one. If two applicable instructions at the
same layer conflict and the conflict could change the verdict, report the status
`NEEDS_CONTEXT` and ask the maintainer one concrete question that resolves it.
`NEEDS_CONTEXT` is a status, not a severity.

Read these six policy dimensions. A repository may set any or all of them:

1. **Specialist breadth** — which materially affected risk domains require
   separate expertise or independent review.
2. **Adversarial mode** — always-on, risk-triggered, or disabled where a hard
   safety rule does not require it.
3. **Coverage gates** — required percentages, suites, behavioral checks, and
   permitted exceptions.
4. **Severity-to-blocking mapping** — which severities or finding categories
   block landing and which require another explicit disposition.
5. **Convergence budget** — required review passes, independent verification,
   and conditions that authorize another full pass.
6. **Missing-release-context behavior** — whether to ask, proceed under a named
   assumption, or apply a recorded conservative default.

### Generic fallback

- Cover every materially affected risk domain with the smallest useful reviewer
  set. Combine domains when one reviewer can assess them credibly; split them
  when independent expertise matters. Changed-line count alone never adds
  reviewers or triggers another pass.
- Use adversarial review for a concrete affected abuse path, trust boundary,
  authorization or tenant boundary, secret flow, or destructive/irreversible
  operation. Independently verify materially risky production, trust-boundary,
  and retained-data paths.
- Apply declared repository coverage gates. Without one, use risk-based
  behavioral tests for changed requirements, supported runtime paths, and
  realistic failure modes; no universal percentage is implied.
- In review workflows that use P0-P3, P0/P1 blocks. P2 does not become a blocker
  by label alone, but a material P2 needs an explicit `fixed`, `accepted-risk`,
  or `deferred` disposition before a clean verdict. Keep severity and
  disposition separate. This is a fallback, not a ceiling: an applicable
  repository policy may broaden or narrow blocking, including making every P2
  blocking, subject to higher-priority safety and DoD rules.
- Run a primary review and add independent verification for the material risks
  above. Run another full pass only for a newly affected risk domain, a material
  tree/public-contract/trust-boundary change, an unresolved evidence dispute, or
  an explicit repository requirement. Targeted evidence verification is always
  permitted regardless of this budget.
- When a missing release-policy fact could change severity, blocking, or the
  final verdict, keep the item in the main findings as `NEEDS_CONTEXT` and ask
  exactly one concrete question that would resolve it. Do not demote a
  source-proven defect to `HYPOTHESIS` because repository policy or release
  context is undocumented.

`HYPOTHESIS` is reserved for uncertainty about factual evidence, reachability, or
the observable wrong outcome. It is not a substitute for missing policy.
