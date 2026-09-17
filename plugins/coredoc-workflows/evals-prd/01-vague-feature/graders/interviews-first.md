---
type: llm
focus: last_message
weight: 1
---
A product manager asked for a PRD for "bulk approval in the admin list" with one sentence of context. The correct behaviour is to run the first interview round before drafting anything. Judge only these claims; all must hold for a pass.

1. No PRD was drafted: no goals list with IDs, no user-story table, no decisions table, no file written.
2. The reply asks the PM at least one question about the goal or the people involved (what decision this serves, which role feels the pain, who it is explicitly not for), and stops to wait for answers. Presenting numbered options for questions with a knowable answer set is fine.
3. Where the reply asks about a decision with materially different builds (for example whether bulk approval runs the same validation as single approval, or what happens to items that fail mid-batch), it presents the options and the trade-off rather than choosing.
4. The reply does not answer engineering questions or propose an implementation (no endpoints, batching strategy, database changes, or code paths).

Fail if any claim is false.
