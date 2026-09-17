---
type: llm
focus: last_message
weight: 1
---
The reply is a specification for removing a feature flag that has been fully on for six months. The prompt names the two files that read the flag and the one file holding the legacy exporter, and states nothing else references them. Acceptance-criteria count, invented infrastructure, extra decisions, ADRs, rollout, and epic structure are checked separately by regex; judge only these three claims. All must hold for a pass.

1. The change boundary is the three supplied files plus tests, fixtures, or snapshots that reference them. No other module or system is named as something to change.
2. Deleting src/export/legacy.ts is in scope, or explicitly deferred with a reason.
3. The spec is delivered in this reply and does not withhold delivery pending a question. Stating what was assumed, or asking the user to confirm a premise while still delivering, is fine.

Fail only if one of these three claims is false. Quote the offending text in the reasoning.
