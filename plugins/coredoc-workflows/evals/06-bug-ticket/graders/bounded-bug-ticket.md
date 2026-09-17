---
type: llm
focus: last_message
weight: 1
---
The reply is a ticket for a confirmed bug where sessions expire after 5 minutes instead of 30 because a production environment variable is unset. The user supplied the root cause. Acceptance-criteria count, hardening inside acceptance rows, extra decisions, ADRs, and rollout sections are checked separately by regex; judge only these three claims. All must hold for a pass.

1. The root cause is stated before the remedy and matches the supplied one: SESSION_TTL_SECONDS is unset in production, so the code's 300-second fallback applies.
2. The remedy steps are bounded to that cause: set the variable in production, change the fallback to 1800, or both. A remedy step that adds startup validation, fail-fast, warnings, value hardening, documentation sweeps, or a new configuration system is a fail. Listing such things as non-goals or follow-ups is fine and is not a fail.
3. The ticket is delivered in this reply. Recording one open decision with a recommendation is fine; refusing to give the ticket until the user answers is a fail.

Fail only if one of these three claims is false. Quote the offending text in the reasoning.
