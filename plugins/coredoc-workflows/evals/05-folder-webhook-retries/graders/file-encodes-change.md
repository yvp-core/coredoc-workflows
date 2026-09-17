---
type: llm
focus: {source: file, path: docs/specs/webhook-retries.md}
weight: 1
---
This file should be a specification for adding retries to outbound webhook delivery. The retry schedule, the new status value, and the affected consumer are checked separately by regex; judge only the claims below. Each must hold for a pass.

1. It invents no infrastructure: no message queue, job scheduler, new database table, persistence of retry state across restarts, or external service is introduced as a requirement or goal. In-process retry inside the existing delivery path is the expected shape given that no queue exists today. Explicitly deferring durability to a later change is acceptable; making it a goal of this change is a fail.
2. There is no ADR or "Decisions" section. The decisions were supplied and no credible alternatives were evaluated.
3. Every acceptance criterion states an observable outcome (for example, a delivery that fails on every attempt ends in status `failed`; a delivery that succeeds on the second attempt ends in `sent`). No criterion is a test count.
4. Scope names src/webhooks/deliver.ts as the change boundary and does not invent other source files as current state.
5. The document does not ask the user a question that the prompt already answered (retry count, delays, the terminal status).

Fail if any claim is false. Quote the offending text in the reasoning.
