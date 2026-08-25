## Finding contract

Confidence answers "is this claim true?"; severity answers "what happens if we
ship it?"; disposition answers "what will we do about it?" They are independent.
Reviewer agreement may corroborate evidence but never raises confidence or
severity by itself. Blocking follows the effective review policy, not reviewer
urgency or ease of remediation.

Use one severity vocabulary everywhere:

- **P0** — an active, reachable exploit, tenant breach, secret leak, or
  irreversible data loss on a supported release path.
- **P1** — a demonstrated failure on a reachable supported runtime path that
  violates an accepted requirement or repository invariant, has release-relevant
  impact, and has no accepted operational workaround.
- **P2** — a real reachable defect with bounded impact or a safe workaround. Does
  not inherit blocking status merely from its label.
- **P3** — maintainability, refactor, or test-strengthening work while current
  behavior remains correct.
- **HYPOTHESIS** — a plausible candidate whose factual evidence, reachability, or
  observable wrong outcome is unverified. It is not a confirmed finding, does
  not enter defect counts or fix offers, and names the check that could resolve it.

Before assigning P0-P2, record all of:

1. **Evidence** — source lines plus a failing test, log/trace, or deterministic
   source proof.
2. **Trigger and reachability** — the concrete input/event sequence and the
   current entrypoint/caller path that reaches it.
3. **Observer and impact** — who sees which wrong result.
4. **Violated contract** — the acceptance criterion, public contract, or repository
   invariant that requires different behavior.
5. **Existing handling** — why current validation, retry, rebuild, refusal, or
   operator procedure does not already contain the impact.
6. **Applicable release facts** — supported backends and paths, current
   users/tenants, realistic load, deployment mode, data-retention requirements,
   deprecations, and accepted rollout or rollback decisions used to set severity
   or the verdict.

If factual evidence, reachability, or the observable wrong outcome is unknown,
classify the candidate as HYPOTHESIS. If the code defect is proven but a missing
release-policy fact could change severity, blocking, or the final verdict, keep it
in the main findings with status `NEEDS_CONTEXT` and ask exactly one concrete
question that resolves the missing fact; do not demote it to HYPOTHESIS.
`NEEDS_CONTEXT` is not part of the severity vocabulary.

A missing test, a suspicious line, a possible future consumer, or a deprecated
path outside its declared support window is not by itself a defect. An explicit
maintainer-approved coordinated migration, export/import, or wipe is valid
release context; do not invent rolling-deploy machinery after that decision.
