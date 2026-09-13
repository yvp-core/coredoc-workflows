# Jira handoff comment

Use this only as the body of an explicitly authorized Jira comment after the
work reaches a real handoff point. Keep it concise and grounded in observed
repository and provider evidence.

## What changed

Describe the behavior or surface that changed. Do not substitute a file list or
line count for the outcome.

## What to check

Give QA or the next tester a concrete entry point, expected result, and any
important edge case. Include actual validation results without overstating
coverage.

## Links

Link the observed pull request when it exists, or give the observed branch and
commit when no pull request exists. Include an authoritative design link only
when it already exists. Never invent a missing link.

## Divergence and remaining concerns

State any departure from the agreed plan, unresolved risk, blocked validation,
or follow-up. Write `None` only when the evidence supports that claim.
