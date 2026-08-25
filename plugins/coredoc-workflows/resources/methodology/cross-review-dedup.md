### Review-history preflight and cross-review convergence

Run this preflight before the scope audit, full-diff review, specialist dispatch,
or cross-model pass.

For an explicitly requested independent review or re-review, look for the PR
description or named review report that records the reviewed base/head,
clean/dirty state, dispositions, completed review passes, and maintainer acceptance
state. A dirty-tree handoff also records a deterministic fingerprint of the
reviewed tracked patch and reviewed untracked files, excluding the handoff itself.
If no handoff exists, record review history as unknown and proceed under the
effective review policy; stop only when a strict repository policy explicitly
requires a handoff. Never create a hidden ledger. An initial review does not need
a prior handoff.

A reviewer may write or update a handoff, but cannot accept its own handoff.
Dispositions become sticky, and completed passes count as closed convergence
slots, only after a maintainer explicitly accepts that handoff. Before acceptance,
use it as review evidence and history, not as authority to suppress a finding or
declare convergence. Acceptance applies to the recorded handoff state; a material
update returns it to acceptance pending.

Compare that material-tree identity with the current tree before deciding the
review scope. Matching base/head is insufficient when either tree is dirty:

- on the same material tree, follow the effective policy's convergence budget;
- when an accepted handoff records that budget as exhausted, verify unresolved
  blockers, accepted fixes, and their direct dependents rather than starting
  another full pass;
- after fixes, review the changed paths and direct dependents, not untouched code;
- allow another full pass only for a newly affected risk domain, a material scope,
  public-contract or trust-boundary change, unresolved evidence, or an explicit
  repository requirement.

Targeted evidence verification is always permitted for a factual claim in the handoff,
regardless of the convergence budget or recorded disposition. If that verification
disproves recorded evidence, automatically reopen the affected disposition. This
escape valve authorizes verification of the disputed claim and its direct
dependents, not an unrelated full review.

For a pass that is still authorized, generate candidates without anchoring on the
prior conclusions. At the findings step, reconcile them against the handoff and
deduplicate by semantic root cause, not `path:line:category`:

- merge affected locations and record confirming reviewers without boosting
  confidence or severity;
- do not re-emit an unchanged finding with an accepted disposition `fixed`,
  `accepted-risk`, `deferred`, or `rejected` as a new candidate, but retain it in
  the handoff and final-verdict accounting; carry it as open when its severity or
  category still blocks under the effective policy. `accepted-risk` unblocks
  only when the maintainer is authorized to override that policy, and `deferred`
  alone never unblocks a blocking finding; keep severity in its separate field;
- reopen an accepted disposition when changed code, a new trigger/evidence/impact,
  or targeted verification disproves a factual premise;
- record which pass occurred and leave its acceptance to the maintainer.

Converge according to the effective repository policy and the generic fallback.
Use explicit caller-provided history; never persist a hidden workflow ledger.
