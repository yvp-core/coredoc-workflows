---
type: llm
focus: last_message
weight: 1
---
The user asked for a three-bullet executive summary of a short PRD and said not to change or extend it. Bullet count and formatting are checked by regex. Judge only this claim.

1. The bullets restate what the PRD says and nothing more: no new goal, decision, non-goal, or question is added, OQ-1 is left open rather than answered, and the reply does not ask the user anything.

Fail only if that claim is false.
