### Plan

Use the plan this conversation or the user names; otherwise search only the
repository's documented issue/spec directories and files the current branch
mentions, never global workflow caches or unrelated repositories. Read the start
of a plan found by search and confirm it belongs to this branch's work. If no
relevant plan is found, or it cannot be read, skip the audit and say why.

### Actionable Item Extraction

Extract every actionable item, up to 50 (note the total when there are more):
checkboxes, numbered implementation steps, imperative statements, named files,
test requirements, and data-model changes. Skip context and background sections,
open questions, review reports, and explicitly deferred or out-of-scope items.
Tag each item CODE, TEST, MIGRATION, CONFIG, or DOCS. With no actionable items,
skip the audit and say so.

### Verification Mode

The diff proves only work in this repository. Classify each item before judging
it:

- **In this repository** — cross-reference the diff (next section).
- **In another repository** — inspect it only when the user placed that
  repository in scope; a concrete path is not permission. Otherwise it is
  UNVERIFIABLE; name the exact manual check.
- **External state** (cloud or DNS config, env vars, OAuth allowlists,
  third-party SaaS) — UNVERIFIABLE; cite the system and the check the user must
  perform.
- **A convention in an in-scope file in another repository** — run that
  repository's validator script if it has one (`validate-*`, `lint-wiki`,
  `check-docs`, or similar): pass → DONE, fail → NOT DONE, citing its output.
  Without one, it is UNVERIFIABLE; cite the path and the convention.

Code that handles a deliverable is not the deliverable. When unsure between DONE
and UNVERIFIABLE, choose UNVERIFIABLE.

### Cross-Reference Against Diff

Read `git diff "$DIFF_BASE"` and `git log "$DIFF_BASE"..HEAD --oneline`, then mark
each item:

- **DONE** — the described functionality is present; cite the changed file or
  verified path. A touched file alone is not enough.
- **PARTIAL** — work exists but an accepted behavior is incomplete.
- **NOT DONE** — verification found negative evidence.
- **CHANGED** — a different approach meets the same goal; note the difference.
- **UNVERIFIABLE** — no reachable check can prove or disprove it; cite the manual
  check the user must perform.

### Output Format

Label the result `PLAN COMPLETION AUDIT` with the plan path, list each item as
`[STATUS] item — evidence` grouped by category, and end with
`COMPLETION: N/M DONE, n PARTIAL, n NOT DONE, n CHANGED, n UNVERIFIABLE`.

### Investigation Depth

For each PARTIAL or NOT DONE item, use the branch log and code to find the likely
reason (scope cut, stopped midway, misunderstood requirement, blocked
dependency, or never attempted) and report:

```
DISCREPANCY: {PARTIAL|NOT_DONE} | {plan item} | {what was actually delivered}
INVESTIGATION: {likely reason with evidence from git log / code}
IMPACT: {what breaks or degrades if this stays undelivered}
```

### Integration with Scope Drift Detection

The plan completion results augment the existing Scope Drift Detection. If a plan file is found:

- **NOT DONE items** become additional evidence for **MISSING REQUIREMENTS** in the scope drift report.
- **Items in the diff that don't match any plan item** become evidence for **SCOPE CREEP** detection.
- **Discrepancies that pass the finding contract and block under the resolved
  review policy** trigger AskUserQuestion:
  - Show the investigation findings
  - Options: A) Stop and implement the missing accepted item, B) Accept the release risk, C) Intentionally drop the requirement

This is nonblocking unless a proven discrepancy belongs to the resolved review
policy's blocking set. Explicitly deferred work never gates landing.

Update the scope drift output to include plan file context:

```
Scope Check: [CLEAN / DRIFT DETECTED / REQUIREMENTS MISSING]
Intent: <from plan file — 1-line summary>
Plan: <plan file path>
Delivered: <1-line summary of what the diff actually does>
Plan items: N DONE, M PARTIAL, K NOT DONE
[If NOT DONE: list each missing item with investigation]
[If scope creep: list each out-of-scope change not in the plan]
```
