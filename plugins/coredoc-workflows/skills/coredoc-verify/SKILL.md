---
name: coredoc-verify
description: Verify existing behavior with repository tests, typecheck, build, CLI or API checks and report results without editing code. Use for verification-only work that does not require browser QA.
---

# Verification

Identify the exact behavior and revision to verify. Read repository instructions,
runtime pins and the nearest existing test command before selecting checks.
Use available source and applicable Coredoc evidence to identify the actual
consumer; a graph match or unchanged anchor is not runtime proof.

Run the smallest existing checks that observe the requested outcome. Prefer
repository commands and fixtures; do not install a new stack or rewrite tests
merely to obtain green output. Respect the user's external-action boundaries for
runtime APIs. A missing credential or fixture is an unverified check, not a pass.

For a failure, retain the command, exit status and relevant output. Compare the
same scenario on base or a concrete CI baseline before calling it pre-existing.
Do not fix code as part of verification-only work. Report the reachable failure
and a proposed next step; route a subsequent authorized fix as a change.

Report passed, failed and unverified outcomes against the requested behavior,
with revision and evidence. Do not equate static validation with a browser,
production, or live-agent replay. Use coredoc-runtime-qa-report when the requested
surface is actually a browser or Electron app.
