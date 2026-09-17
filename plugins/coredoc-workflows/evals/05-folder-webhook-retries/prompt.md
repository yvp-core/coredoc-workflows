---
max_turns: 30
timeout_seconds: 600
allowed_tools: [Skill, Read, Glob, Grep, Write]
runs: 3
---
This repo keeps specs in `docs/specs/`. Write `docs/specs/webhook-retries.md` for this change:

Retry failed outbound webhook deliveries 3 times with exponential backoff (1 s, 4 s, 16 s). After the third failure, mark the delivery `failed`.

Current state (verified): delivery is a single attempt in `src/webhooks/deliver.ts`. The delivery status enum has two values, `pending` and `sent`. The delivery-log page reads that enum to render status badges. There is no queue or scheduler in the codebase today.
