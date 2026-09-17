---
type: llm
focus: last_message
weight: 1
---
A developer asked for a multi-tenancy spec for a greenfield app with no PRD. NEEDS_CONTEXT, the absence of a written spec or file, and the literal "Questions for the PRD" heading are checked by regex. Judge only these two claims; both must hold for a pass.

1. The questions the reply raises are product questions (what the app is, what a tenant is, who the actors are, what must not change, whether anything crosses tenants) that a product owner would answer for a PRD. Asking additionally for the stack or data store is fine. Asking the developer to pick the isolation model right now, with no product context, is a fail.
2. The reply does not adopt an isolation model, data design, or tenant-resolution mechanism as decided. Naming the choices the PRD or a later spec must settle is fine.

Fail only if one of these is false.
