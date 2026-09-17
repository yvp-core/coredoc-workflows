---
type: llm
focus: last_message
weight: 1
---
The user asked a short engineering trade-off question. Judge only these claims; both must hold for a pass.

1. The reply answers it directly in a few sentences with a trade-off (for example partial failure handling, atomicity, request count, or user feedback), without asking the user a question back.
2. The reply does not produce a PRD, an interview, a goals list, or a decisions table.

Fail if either claim is false.
