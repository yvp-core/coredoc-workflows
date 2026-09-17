---
type: llm
focus: last_message
weight: 1
---
The reply is a bug PRD. The PM supplied symptoms, the expected behaviour, and a guess about the cause ("the nightly recalculation job not picking up the overnight shift"). Judge only these claims; all must hold for a pass.

1. Current and desired behaviour are both stated, with the conditions (weekly overtime policy, shift crossing midnight on Sunday, Monday after close).
2. The PM's guess is recorded as an unverified claim with an open question for Engineering. The PRD does not assert it as the root cause, and does not add its own theory about jobs, caches, timezones, or code.
3. Acceptance criteria are observable outcomes with their conditions stated (which policy, which shift shape, when the total is read). None rests on "no error" or on an implementation detail.
4. The PRD does not propose a fix, a code change, or an implementation approach.

Fail if any claim is false. Quote the offending text in the reasoning.
