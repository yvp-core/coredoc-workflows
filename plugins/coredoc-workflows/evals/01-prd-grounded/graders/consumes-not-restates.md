---
type: llm
focus: last_message
weight: 1
---
The reply is an engineering specification written from a supplied, approved PRD. Citations of PRD rows, per-claim verdicts on the two Engineering open questions, acceptance criteria tracing to PRD rows, new product ids, and the reviewer brief are all checked by regex. Judge only these two claims; both must hold for a pass.

1. OQ-3 (selection size, addressed to the PM) is not decided on the PM's behalf: the spec may state a technical constraint or a recommendation for the PM, but it does not fix a number as the product rule. Naming a candidate for the PRD is fine.
2. The spec is delivered in this reply, not withheld pending questions; the empty repository is handled by "not verifiable here" verdicts, not by refusing to write.

Fail only if one of these is false. Quote the offending text in the reasoning.
