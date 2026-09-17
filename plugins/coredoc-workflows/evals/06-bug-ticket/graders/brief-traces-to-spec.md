---
type: llm
focus: last_message
weight: 1
---
The reply should end with a short plain-language reviewer brief that a developer can read without opening the specification, with the parts "What changes", "Expected result", "What could break", and "Decisions you must make". Judge only these claims; all must hold for a pass.

1. The brief is present and short: roughly fifteen lines or fewer, plain sentences, no new tables.
2. Every brief line that makes a claim cites at least one specification ID (such as AC-3, LIM-1, UC-1) that actually appears in the specification given in the same reply or written to the named file. A line whose whole content is "none" or an equivalent (nothing breaks, no decisions) needs no citation. A claim line that cites nothing, or cites an ID that does not exist, is a fail.
3. "What could break" names only failures and consumers that the specification itself covers; a brief that introduces a new risk absent from the spec is a fail.
4. The brief is understandable to a developer who has not read the spec: it names what changes and what the observer sees afterwards without requiring the reader to look up the IDs.

If there is no brief at all, fail. In the reasoning, list the IDs cited by the brief and any spec IDs that no brief line cites.
